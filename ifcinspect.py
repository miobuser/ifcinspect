"""
ifcinspect.py — deterministic geometric face-classification of formwork
inserts ("Schaleinlagen") in a semantics-free IFC retaining wall.

Reduzierte Codebase (Cleanup 2026-05-26, Voxel-Path-Removal 2026-05-29):
nur noch der `classify`-Modus — 6-Schalflächen-Face-Klassifikation +
Niche-Komponenten via `niche_brep.detect_niches_face_classification`.
Native-only Fallbacks (`pymeshfix`, `manifold3d`, `scikit-image`,
`scipy.ndimage`) sind aus dem Live-Pfad entfernt; nicht-watertight Eingangs-
Meshes werden mit `prep_failed=True` gekennzeichnet und übersprungen statt
durch blackbox-Reparatur zu rekonstruieren. Pyodide-Browser-Build ist damit
nicht mehr von native-only Wheels abhängig (transparente Skip-Logik).

Pipeline (single closed wall mesh in, colored IFC + Submeshes out):

  S1  Parse     : ifcopenshell.geom → world-space triangle meshes.
  S2  Prep      : `_prep_wall` → repair_watertight (trimesh-only).
                  Bleibt nicht-watertight → wall_metrics[prep_failed]=True,
                  Wand wird in S4 übersprungen.
  S3  Union     : near-coincident CAD copies werden vereinigt
                  (`_union_overlapping_elements`).
  S4  Classify  : `_detect_classify` → 7 Klassen
                  (6 Schalflächen-Cluster + 1 Schaleinlagen-Klasse) und
                  pro Klasse face-adjacency-Submeshes.
  S5  Export    : jedes Submesh → IfcBuildingElementProxy.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field

import numpy as np
import trimesh

from ifc_io import (load_product_meshes, write_ifc_meshes, IfcMeshItem,
                    enrich_existing_ifc)
from context import _FOOTING_TYPES as _CONTEXT_FOOTING_TYPES  # P2: single source of truth

# Opt-in timing diagnostics for the detect loop (off by default). The JS worker
# additionally suppresses Python stdout unless its own DEBUG flag is set.
_DEBUG = bool(os.environ.get("IFCINSPECT_DEBUG"))

YELLOW = (1.0, 1.0, 0.0)
GREY = (0.62, 0.64, 0.67)


def _hex_rgb(h: str) -> tuple:
    """'#rrggbb' → (r, g, b) in 0..1."""
    h = h.lstrip("#")
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0,
            int(h[4:6], 16) / 255.0)


# Per-class colors — must match the web viewer's COLORS.classes palette so the
# IFC export and the SPA show identical class colours.
CLASS_COLORS = {
    "K0": _hex_rgb("#e53935"),   # Stirn +
    "K1": _hex_rgb("#fb8c00"),   # Stirn −
    "K2": _hex_rgb("#2196f3"),   # Krone
    "K3": _hex_rgb("#8e24aa"),   # Fundament
    "K4": _hex_rgb("#66bb6a"),   # Front (Luft)
    "K5": _hex_rgb("#00897b"),   # Back (Erd)
    "K6": _hex_rgb("#ffd400"),   # Schaleinlagen
}
CLASS_LABELS = {
    "K0": "Stirn +", "K1": "Stirn −", "K2": "Krone", "K3": "Fundament",
    "K4": "Front (Luft)", "K5": "Back (Erd)", "K6": "Schaleinlagen",
}


def _kind_to_K(kind) -> "str | None":
    """Map an internal cavity kind ('Klasse0'..'Klasse6') to 'K0'..'K6'."""
    if not isinstance(kind, str):
        return None
    if kind.startswith("Klasse") and kind[6:].isdigit():
        return f"K{kind[6:]}"
    if kind.startswith("K") and kind[1:].isdigit():
        return kind
    return None


def _flatten_wall_metrics(wm: dict) -> dict:
    """Flatten a per-wall metrics dict into readable scalar properties for a
    Pset (skip None / non-scalar containers; nested groups get readable
    prefixes). Booleans/ints/floats/strings pass through; everything else is
    dropped so the Pset stays clean."""
    if not isinstance(wm, dict):
        return {}
    out: dict = {}

    def put(name, val):
        if val is None:
            return
        if isinstance(val, (bool, int, float, str)):
            out[name] = val

    put("ElementType", wm.get("element_type"))
    put("ThicknessAxis", wm.get("thickness_axis"))
    put("Volume_m3", wm.get("volume_m3"))
    put("SurfaceArea_m2", wm.get("surface_area_m2"))
    put("CrownWidth_p10_m", wm.get("crown_width_p10_m"))
    put("CrownWidth_min_m", wm.get("crown_width_min_m"))
    put("CrownWidth_avg_m", wm.get("crown_width_avg_m"))
    put("CrownWidth_m", wm.get("crown_width_m"))
    put("FoundationThickness_m", wm.get("foundation_thickness_m"))

    th = wm.get("thickness")
    if isinstance(th, dict):
        put("WallThickness_min_m", th.get("min"))
        put("WallThickness_avg_m", th.get("avg"))
        put("WallThickness_median_m", th.get("median"))
    thn = wm.get("thickness_at_niche")
    if isinstance(thn, dict):
        put("ResidualThickness_min_m", thn.get("min_global"))

    bat = wm.get("batter")
    if isinstance(bat, dict):
        put("Batter_front_deg", bat.get("front_deg"))
        put("Batter_front_ratio", bat.get("front_ratio"))
        put("Batter_back_deg", bat.get("back_deg"))
        put("Batter_back_ratio", bat.get("back_ratio"))
    sl = wm.get("slope")
    if isinstance(sl, dict):
        put("Slope_crown_deg", sl.get("crown_deg"))
        put("Slope_foundation_deg", sl.get("foundation_deg"))
        put("Slope_crown_longitudinal_percent", sl.get("crown_longitudinal_percent"))
        put("Slope_crown_drainage_percent", sl.get("crown_drainage_percent"))
        put("Slope_crown_drainage_reference", sl.get("crown_drainage_reference"))

    dims = wm.get("dimensions")
    if isinstance(dims, dict):
        put("Length_m", dims.get("length"))
        put("Height_m", dims.get("height"))
        put("NominalThickness_m", dims.get("nominal_thickness"))

    niches = wm.get("niches")
    if isinstance(niches, dict):
        put("NicheCount", niches.get("count"))
        put("NicheVolume_m3", niches.get("total_volume_m3"))

    areas = wm.get("area_per_class")
    if isinstance(areas, dict):
        for k in ("K0", "K1", "K2", "K3", "K4", "K5", "K6"):
            put(f"Area_{k}_m2", areas.get(k))

    ctx = wm.get("context")
    if isinstance(ctx, dict):
        int_ctx = ctx.get("internal")
        if isinstance(int_ctx, dict):
            put("L5_foundation_present", int_ctx.get("foundation_present"))
            oh = int_ctx.get("overhang")
            if isinstance(oh, (list, tuple)) and len(oh) == 2:
                put("L5_overhang_a_m", float(oh[0]))
                put("L5_overhang_b_m", float(oh[1]))
            elif isinstance(oh, (int, float)):
                put("L5_overhang_m", oh)
        ext_ctx = ctx.get("external")
        if isinstance(ext_ctx, dict):
            put("L6_air_side", ext_ctx.get("air_side"))
            put("L6_earth_side", ext_ctx.get("earth_side"))
            put("L6_source", ext_ctx.get("source"))
    return out


def _flatten_pruefung(wm: dict) -> dict:
    """Flatten a wall's rule evaluation (``wm["pruefung"]``) into readable
    scalar properties for ``Pset_IfcInspect_Pruefung``.

    Each check is a dict {id, label, value, soll, status, einheit, ...} as
    produced by report.apply_rules. For every check three keys are written:
    ``"<label> — Ist"``, ``"<label> — Soll"``, ``"<label> — Status"`` so the
    IFC carries the same per-rule Ist/Soll/Status the SPA shows. Missing keys
    are guarded; non-list ``pruefung`` yields an empty dict."""
    if not isinstance(wm, dict):
        return {}
    checks = wm.get("pruefung")
    if not isinstance(checks, (list, tuple)):
        return {}
    out: dict = {}
    for ch in checks:
        if not isinstance(ch, dict):
            continue
        label = ch.get("label") or ch.get("id") or "Prüfung"
        value = ch.get("value")
        einheit = ch.get("einheit") or ""
        soll = ch.get("soll")
        status = ch.get("status")
        ist = f"{value} {einheit}".strip() if value is not None else str(einheit).strip()
        out[f"{label} — Ist"] = ist
        out[f"{label} — Soll"] = str(soll) if soll is not None else ""
        out[f"{label} — Status"] = str(status) if status is not None else ""
    return out


# --------------------------------------------------------------------------- #
#  Small geometry helpers
# --------------------------------------------------------------------------- #
def obb_diagonal(mesh) -> float:
    """Diagonal of the minimum-volume oriented bounding box.

    Oriented (not axis-aligned) so the measure is invariant to how the wall is
    placed/inclined in space — a tilted wall must not look "bigger".
    """
    if mesh is None or len(getattr(mesh, "vertices", [])) == 0:
        return 0.0
    try:
        return float(np.linalg.norm(mesh.bounding_box_oriented.extents))
    except Exception:
        b = getattr(mesh, "bounds", None)
        return 0.0 if b is None else float(np.linalg.norm(b[1] - b[0]))


def repair_watertight(mesh):
    """Best-effort cleanup so downstream face analysis gets a manifold solid.

    IFC tessellations routinely arrive with duplicated / degenerate triangles
    and tiny gaps; the classify pipeline depends on a clean face_adjacency graph.
    """
    m = mesh.copy()
    m.merge_vertices()
    for fn in ("nondegenerate_faces", "unique_faces"):
        try:
            m.update_faces(getattr(m, fn)())
        except Exception:
            pass
    try:
        m.fill_holes()
    except Exception:
        pass
    # fix_normals() braucht networkx (trimesh.repair.fix_winding). In Pyodide ist
    # networkx optional installiert; fehlt es, NICHT crashen — die Tessellierung
    # ist i.d.R. bereits konsistent gewickelt (IFC CCW), der Klassifikator nutzt
    # ohnehin |cos| gegen die PCA-Achsen (vorzeichenrobust).
    try:
        m.fix_normals()
    except Exception:
        pass
    return m


def ensure_volume(wall):
    """Guarantee a watertight volume — trimesh-only, no native-lib fallbacks.

    Proper BREP solids pass through untouched (exact). Real tessellated meshes
    that are NOT watertight cannot be reliably repaired with pure-Python
    Trimesh operations (`fill_holes` handles only simple boundary loops);
    those walls are returned as ``None`` so the caller can skip them with a
    ``prep_failed`` marker rather than running a blackbox reconstruction.

    Returns
    -------
    (mesh|None, prep_failed_reason: str | None)
        ``(mesh, None)`` for usable volumes; ``(None, reason)`` when the
        wall must be skipped.
    """
    if wall.is_volume:
        return wall, None
    # Cheap Trimesh-only retry: a defensive second pass of the same
    # repair_watertight steps in case the first pass left the mesh non-volume.
    # (The intervening apply_translation is a rigid transform and does not
    # affect watertightness — it is not the reason for retrying.)
    try:
        wall.fill_holes()
        wall.fix_normals()
        if wall.is_volume:
            return wall, None
    except Exception:
        pass
    if len(wall.faces) < 4:
        return None, "Mesh hat <4 Faces (Fläche/2D oder degeneriert)"
    # NICHT wasserdicht trotz Reparatur → ÜBERSPRINGEN (transparenter prep_failed),
    # NICHT mit falschen Ergebnissen weiterrechnen. Auf einem ungültigen Volumen
    # (offene Schale / non-manifold) liefert die Nischenerkennung falsche Werte
    # (0 statt der echten Anzahl) — ein FALSCHES Ergebnis ist schlechter als ein
    # klar markierter Skip. (Solche Schalen vernäht OpenCASCADE über seinen Kernel;
    # web-ifc kann das nicht — ggf. späterer OCC-Fallback, siehe Vault.)
    return None, "Mesh nicht watertight — pure-Python-Repair unzureichend (übersprungen statt falsch klassifiziert)"


# --------------------------------------------------------------------------- #
#  Orchestration
# --------------------------------------------------------------------------- #
@dataclass
class Result:
    wall: object
    cavities: list           # list[(mesh, kind)]
    timings: dict
    wall_name: str
    method: str = "classify"
    chosen_guid: str = ""
    candidates: list = field(default_factory=list)   # [(guid, label), ...]
    skipped_walls: list = field(default_factory=list)  # [{name, guid, reason}] pro
                                                       # Wand die nicht aufbereitbar
                                                       # war (prep_failed). Wird im
                                                       # Bericht klar markiert.
    metadata: list = field(default_factory=list)     # parallel zu cavities; pro
                                                     # Submesh ein dict (Debug-Info)
    wall_metrics: list = field(default_factory=list) # pro Wand-Element ein dict
                                                     # mit L1/L3-Kenngrössen
    scene: dict = field(default_factory=dict)        # L7-Distanzen + Scene-Info
    context_meshes: list = field(default_factory=list)  # [(mesh, ifc_type, name), ...]
                                                        # für Viewer-Darstellung von
                                                        # Terrain/Strassen/Proxy-Elementen
    products: list = field(default_factory=list)     # geladene LoadedProducts —
                                                     # für den deferred L7-Nachlauf
                                                     # (scene_pair_distances) ohne
                                                     # erneutes Geometrie-Laden


_WALL_TYPES = ("IfcWall", "IfcWallStandardCase")
ALL_WALLS = "__ALL__"

WALL_LIKE_ELONGATION = 2.0  # length must exceed thickness by this factor (excl. columns/shafts)


def _is_wall_like_geom(mesh) -> bool:
    """True if a mesh's bbox looks like a wall: upright (height > horizontal
    thickness) AND elongated horizontally (length >= 2x thickness). Excludes
    slabs (flattest dim is vertical), columns/shafts (not elongated) and blocks.
    Used to decide whether an IfcBuildingElementProxy should be treated as a
    wall (IfcWall-rules)."""
    try:
        lo, hi = mesh.bounds
        dx = float(hi[0] - lo[0]); dy = float(hi[1] - lo[1]); dz = float(hi[2] - lo[2])
    except Exception:
        return False
    thickness = min(dx, dy)
    length = max(dx, dy)
    if thickness <= 1e-6:
        return False
    return dz > thickness and length >= WALL_LIKE_ELONGATION * thickness


def _qualifies_as_wall(p) -> bool:
    """A product is treated with IfcWall-rules if it is a real wall class OR a
    wall-like IfcBuildingElementProxy (upright, thin, elongated geometry)."""
    return (p.ifc_type in _WALL_TYPES
            or (p.ifc_type == "IfcBuildingElementProxy"
                and _is_wall_like_geom(p.mesh)))


def candidate_solids(products):
    """Rank the products that are plausible target solids.

    Real IFCs are full of degenerate 2-face surfaces (coatings, formwork sheets)
    whose 'volume' is meaningless, so we keep only proper closed volumes (≥4
    faces, is_volume), prefer wall-class elements, then sort by bounding-box size
    (robust — unlike mesh volume it is not fooled by open meshes)."""
    solids = [p for p in products if p.mesh.is_volume and len(p.mesh.faces) >= 4]
    pool = solids or [p for p in products if len(p.mesh.faces) >= 4] or list(products)

    def key(p):
        # Prefer real walls AND wall-like proxies equally in the single-pick fallback.
        is_wall = 0 if _qualifies_as_wall(p) else 1
        return (is_wall, -float(np.prod(p.mesh.bounding_box.extents)))

    return sorted(pool, key=key)


def pick_wall(products, target):
    if target:
        for p in products:
            if target == p.guid or (p.name and target.lower() in p.name.lower()):
                return p
    return candidate_solids(products)[0]


def _export(out_ifc, wall, cavities, offset=None, metadata=None,
            wall_metrics=None, include_pset=True, include_submeshes=True,
            include_pruefung=False, ifc_bytes=None):
    """Write the classification result as an enriched IFC4 file.

    The exported content is user-selectable via three flags (the web tool's
    export dialog drives them; detect()'s own call passes none → both on,
    pruefung off → byte-identical to the historic output):

    * ``include_submeshes=True`` (default): every classified submesh is its own
      element, coloured by its K-class, classified via IfcClassificationReference
      and aggregated under one IfcElementAssembly per source wall (assembly_key =
      source-wall GUID), plus the grey reference wall. Psets (below) ride on each
      assembly only when ``include_pset``.
    * ``include_submeshes=False and include_pset=True``: NO per-class geometry —
      instead ONE solid element per Stützmauer (its full surface, concatenated
      from all its submeshes) carrying that wall's Pset(s). Used for a clean
      "Pset only" export with per-wall solids.
    * ``include_submeshes=False and include_pset=False``: minimal fallback —
      only the combined grey reference wall.

    Psets attached when ``include_pset``:
      * ``Pset_IfcInspect_Kenngroessen`` (always, from _flatten_wall_metrics);
      * ``Pset_IfcInspect_Pruefung`` additionally when ``include_pruefung``
        (per-rule Ist/Soll/Status, from _flatten_pruefung).

    metadata: list parallel to `cavities`; each dict carries `element_guid`,
        `element_name`, `element_guids` (the source wall a part belongs to).
    wall_metrics: list of per-wall metrics dicts (carry `element_guid`); the
        matching wall's metrics become its Pset(s)."""
    off = np.zeros(3) if offset is None else np.asarray(offset, dtype=np.float64)
    metadata = metadata or []
    wall_metrics = wall_metrics or []

    # metrics lookup by source-wall guid → per-wall metrics dict.
    metrics_by_guid: dict = {}
    for wm in wall_metrics:
        if isinstance(wm, dict) and wm.get("element_guid"):
            metrics_by_guid[wm["element_guid"]] = wm

    def _build_psets(asm_key):
        """Assemble the {pset_name: flat dict} for a wall, honouring the flags.
        Returns None when nothing is to be attached."""
        if not include_pset:
            return None
        wm = metrics_by_guid.get(asm_key)
        out_psets: dict = {}
        flat = _flatten_wall_metrics(wm) if wm else {}
        if flat:
            out_psets["Pset_IfcInspect_Kenngroessen"] = flat
        if include_pruefung and wm:
            pruef = _flatten_pruefung(wm)
            if pruef:
                out_psets["Pset_IfcInspect_Pruefung"] = pruef
        return out_psets or None

    # ---- mode R: ROUND-TRIP — keep the original IFC, only append ------------- #
    # When the original imported IFC bytes are available, we DO NOT rebuild the
    # file. Instead the source IFC is preserved exactly and only enriched:
    #   * include_pset      → Pset(s) appended to the EXISTING source element
    #                         (matched by GlobalId);
    #   * include_submeshes → an IfcElementAssembly per wall, NAMED after the
    #                         element, holding the classification faces.
    # This is the web tool's default export path (driver passes ifc_bytes).
    if ifc_bytes is not None:
        # (a) classification-face items (no reference wall — original kept as-is).
        items = []
        if include_submeshes:
            for i, (mesh, kind) in enumerate(cavities, 1):
                md = metadata[i - 1] if i - 1 < len(metadata) else {}
                kK = _kind_to_K(kind) or "K6"
                label = CLASS_LABELS.get(kK, kK)
                color = CLASS_COLORS.get(kK, YELLOW)
                items.append(IfcMeshItem(
                    f"{label} {i} ({kK})", mesh.vertices + off, mesh.faces,
                    color=color, transparency=0.0, kind=kK, class_label=label,
                    assembly_key=md.get("element_guid") or None,
                    assembly_name=md.get("element_name") or "Stützwand"))
        # (b) psets per source-wall GlobalId.
        element_psets = {}
        if include_pset:
            for guid in metrics_by_guid:
                ps = _build_psets(guid)
                if ps:
                    element_psets[guid] = ps
        enrich_existing_ifc(
            out_ifc, ifc_bytes, items, element_psets=element_psets,
            include_submeshes=include_submeshes, include_pset=include_pset)
        return

    # ---- mode A: per-wall SOLIDS (Pset only, no submeshes) ------------------ #
    if not include_submeshes and include_pset:
        # Group cavity submeshes by their source-wall guid, then concatenate each
        # group into one solid = that wall's full classified surface, carrying
        # the wall's Pset(s). No reference wall, no per-class split.
        order: list = []
        groups: dict = {}      # asm_key -> {"meshes": [...], "name": str}
        for i, (mesh, _kind) in enumerate(cavities, 1):
            md = metadata[i - 1] if i - 1 < len(metadata) else {}
            asm_key = md.get("element_guid") or "_all"
            asm_name = md.get("element_name") or "Stützwand"
            if asm_key not in groups:
                groups[asm_key] = {"meshes": [], "name": asm_name}
                order.append(asm_key)
            groups[asm_key]["meshes"].append(mesh)
        items = []
        for asm_key in order:
            g = groups[asm_key]
            try:
                solid = trimesh.util.concatenate(g["meshes"])
            except Exception:
                solid = g["meshes"][0] if g["meshes"] else None
            if solid is None:
                continue
            psets = _build_psets(asm_key)
            items.append(IfcMeshItem(
                g["name"], solid.vertices + off, solid.faces,
                color=GREY, transparency=0.0, psets=psets))
        if not items:
            # No cavities at all → fall back to the grey reference wall so the
            # export is never empty.
            items = [IfcMeshItem("Stützwand (Referenz)", wall.vertices + off,
                                 wall.faces, color=GREY, transparency=0.7)]
        write_ifc_meshes(out_ifc, items)
        return

    # ---- mode C: minimal fallback (neither submeshes nor pset) ------------- #
    if not include_submeshes and not include_pset:
        write_ifc_meshes(out_ifc, [IfcMeshItem(
            "Stützwand (Referenz)", wall.vertices + off, wall.faces,
            color=GREY, transparency=0.7)])
        return

    # ---- mode B: classified submeshes (default behaviour) ------------------ #
    # The reference wall is a concatenation of all source walls → keep it as a
    # standalone grey element (no assembly_key → contained in the storey).
    items = [IfcMeshItem("Stützwand (Referenz)", wall.vertices + off, wall.faces,
                         color=GREY, transparency=0.7)]

    # Track which assembly already received its Pset (attach once per wall).
    pset_attached: set = set()
    for i, (mesh, kind) in enumerate(cavities, 1):
        md = metadata[i - 1] if i - 1 < len(metadata) else {}
        kK = _kind_to_K(kind) or "K6"
        label = CLASS_LABELS.get(kK, kK)
        color = CLASS_COLORS.get(kK, YELLOW)
        asm_key = md.get("element_guid") or None
        asm_name = md.get("element_name") or "Stützwand"
        name = f"{label} {i} ({kK})"

        psets = None
        if asm_key and asm_key not in pset_attached:
            psets = _build_psets(asm_key)
            if psets:
                pset_attached.add(asm_key)

        items.append(IfcMeshItem(
            name, mesh.vertices + off, mesh.faces,
            color=color, transparency=0.0,
            kind=kK, class_label=label,
            assembly_key=asm_key, assembly_name=asm_name, psets=psets))
    write_ifc_meshes(out_ifc, items)


def _union_overlapping_elements(meshes, iou_thresh=0.5, return_groups=False):
    """Union near-coincident element copies into one clean solid.

    CAD source models store a wall segment as several overlapping solid copies; if
    each is carved separately the user sees a 10× stack the insert can never match.
    We cluster by bounding-box IoU (only truly coincident copies exceed it —
    distinct/adjacent segments stay separate, e.g. IFC4X3's 17 walls have 0 such
    pairs) and boolean-union each cluster, so the displayed wall == the carved
    wall.  Inputs must be watertight (they are, after `_prep_wall`).

    return_groups=True: zusätzlich Liste pro Output-Mesh mit den Indizes der
    Input-Meshes, damit Element-Tracking (Name/GUID) erhalten bleibt."""
    n = len(meshes)
    if n < 2:
        if return_groups:
            return meshes, [[i] for i in range(n)]
        return meshes
    box = [m.bounds for m in meshes]

    def iou(a, b):
        lo = np.maximum(a[0], b[0]); hi = np.minimum(a[1], b[1])
        if np.any(hi <= lo):
            return 0.0
        inter = float(np.prod(hi - lo))
        va = float(np.prod(a[1] - a[0])); vb = float(np.prod(b[1] - b[0]))
        return inter / (va + vb - inter) if (va + vb - inter) > 0 else 0.0

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    for i in range(n):
        for j in range(i + 1, n):
            if iou(box[i], box[j]) > iou_thresh:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    out_groups = []
    for idxs in groups.values():
        if len(idxs) == 1:
            out.append(meshes[idxs[0]]); out_groups.append(idxs); continue
        members = [meshes[k] for k in idxs]
        # BACKEND-FREE merge of coincident COPIES. We previously used
        # trimesh.boolean.union(members), but its boolean backend (manifold3d) is
        # native-only — in Pyodide (the web tool) that call HANGS on these
        # clusters (it was THE browser load hang; native returns fast, hiding it).
        # High-bbox-IoU clusters are CAD-duplicate copies of the SAME segment, so
        # the largest clean copy IS the wall. We only collapse them when they are
        # genuinely near-coincident (similar volume AND coincident centroids);
        # otherwise (distinct tiled segments sharing a bbox) keep them separate so
        # their niches are not lost.
        vols = [abs(float(m.volume)) for m in members]
        vmax = max(vols); vmin = min(vols)
        cens = [np.asarray(m.centroid, dtype=float) for m in members]
        cen_spread = max(float(np.linalg.norm(c - cens[0])) for c in cens)
        diag = float(np.linalg.norm(members[0].bounds[1] - members[0].bounds[0])) or 1.0
        if vmin > 0 and vmax <= 1.5 * vmin and cen_spread <= 0.05 * diag:
            rep = max(members, key=lambda m: abs(float(m.volume)))  # largest copy = the wall
            out.append(rep); out_groups.append(idxs); continue
        out += members                                     # distinct → keep separate
        out_groups += [[k] for k in idxs]
    if return_groups:
        return out, out_groups
    return out


# --------------------------------------------------------------------------- #
#  Detection (classify-only)
# --------------------------------------------------------------------------- #
def _detect_classify(wall, t):
    """7-KLASSEN-FACE-KLASSIFIKATION (heuristik-frei, per-Face):
    Jede Face genau einer von 7 Klassen:
      • Klasse 0–5: 6 Schalflächen-Cluster (±Vt[0], ±Vt[1], ±Vt[2]) per
        argmax(FN·dirs) — keine Region-Aggregation, keine sharp-angle-
        Schwelle, robust auch für einfach tessellierte Boxen.
      • Klasse 6:   Schaleinlage — Faces in den durch
        detect_niches_face_classification ermittelten Niche-Komponenten.

    Pro Klasse werden anschliessend die zusammenhängenden Komponenten via
    face_adjacency als einzelne Sub-Meshes ausgegeben (eine Bohrung pro
    Submesh, ein Wand-Strip pro Submesh etc.) — gibt dem Viewer einzeln
    anklickbare Flächen."""
    from collections import deque
    import niche_brep as nb
    c0 = time.perf_counter
    t0 = c0()
    # PER-ELEMENT lokale Achsen (rein lokal): jede Wand bekommt ihre EIGENE
    # horizontale Laufrichtung via PCA ihres Grundrisses. Das fixt gedrehte/
    # gekrümmte Wände — die globale Achse vertauschte dort Stirn↔Front. v1 = +Z
    # (welt-vertikal), v2 = v0 × Z. Das Vorzeichen von v0 wird an die GLOBALE
    # Laufachse angeglichen (v0·g0 ≥ 0), damit "Front" (+v2) über berührende
    # Segmente dieselbe physische Seite bleibt. Eine SVD pro Element (billig).
    g = t.get("_global_axes")
    g0 = np.asarray(g[0], dtype=float) if g is not None else None
    v0 = None
    try:
        xy = wall.vertices[:, :2]
        xy = xy - xy.mean(0)
        _, _, hVt = np.linalg.svd(xy, full_matrices=False)
        cand = np.array([hVt[0, 0], hVt[0, 1], 0.0])
        n0 = float(np.linalg.norm(cand))
        if n0 > 1e-9:
            v0 = cand / n0
    except Exception:
        v0 = None
    if v0 is None:
        v0 = g0.copy() if g0 is not None else np.array([1.0, 0.0, 0.0])
    if g0 is not None and float(np.dot(v0, g0)) < 0.0:
        v0 = -v0
    v1 = np.array([0.0, 0.0, 1.0])
    v2 = np.cross(v0, v1)
    Vt = np.vstack([v0, v1, v2])
    dirs = np.vstack([Vt[0], -Vt[0], Vt[1], -Vt[1], Vt[2], -Vt[2]])
    FN = wall.face_normals
    nf = len(wall.faces)

    # SCHRITT 1: NISCHEN identifizieren (gleicher Algo wie brep nutzt — die
    # Funktion enthält bereits den Mauerfuss/Stirn-Filter via depth-gap +
    # Konkavitäts-Escape, siehe niche_brep.py Schritt 6).
    niche_components, brep_meta = nb.detect_niches_face_classification(
        wall, return_meta=True)
    is_niche_face = np.zeros(nf, dtype=bool)
    for comp in niche_components:
        is_niche_face[comp] = True

    # SCHRITT 2: per-Face-Klassen-Zuweisung — KEIN Region-Voting, KEIN
    # surface_regions. Niche-Face → 6, sonst PCA-Cluster argmax.
    cluster_id_face = np.argmax(FN @ dirs.T, axis=1)
    face_class = np.where(is_niche_face, 6, cluster_id_face).astype(int)

    # SCHRITT 3: pro Klasse die zusammenhängenden Komponenten via
    # face_adjacency als einzelne Sub-Meshes — Viewer-Granularität.
    nbra = [[] for _ in range(nf)]
    for a, b in wall.face_adjacency:
        nbra[a].append(b); nbra[b].append(a)

    # Lookup: Niche-Komponenten-Index per Face (für Reason-Zuordnung K6)
    niche_face_to_idx = -np.ones(nf, dtype=int)
    for i, comp in enumerate(niche_components):
        niche_face_to_idx[comp] = i
    niche_meta = brep_meta.get("niche_meta", [])
    # components_by_cluster stammt aus niche_brep (Faces ueber sharp-edge
    # surface_regions UND brep-eigene SVD-Achsen geclustert). Die K0-5-Komponenten
    # unten nutzen dagegen die welt-ausgerichteten Achsen (cluster_id_face) +
    # face_adjacency-Connected-Components. Beide Face-Mengen stimmen daher nur
    # selten exakt ueberein -> der frozenset-Lookup verfehlt oft und der
    # generische Fallback-Reason (s.u.) greift bewusst. KEIN Bug: nicht "fixen".
    components_by_cluster = brep_meta.get("components_by_cluster", [])
    # Map: frozenset(faces) -> reason für K0-5
    main_reason_lookup = {}
    for ci in range(6):
        for cinfo in components_by_cluster[ci]:
            key = frozenset(int(x) for x in cinfo["faces"].tolist())
            main_reason_lookup[key] = cinfo

    t["S_classify"] = c0() - t0
    cavities = []
    metadata = []
    for ci in range(7):
        idx = np.where(face_class == ci)[0]
        if len(idx) == 0:
            continue
        c_set = set(int(x) for x in idx.tolist())
        seen = set()
        for s in idx:
            s = int(s)
            if s in seen:
                continue
            comp = [s]; seen.add(s); dq = deque([s])
            while dq:
                x = dq.popleft()
                for y in nbra[x]:
                    if y in c_set and y not in seen:
                        seen.add(y); comp.append(y); dq.append(y)
            arr = np.array(comp, dtype=int)
            sub = wall.submesh([arr], append=True).copy()
            cavities.append((sub, f"Klasse{ci}"))
            # ---- Metadata für dieses Submesh ----
            fw = wall.area_faces[arr]
            area = float(fw.sum())
            cen = (wall.triangles_center[arr] * fw[:, None]).sum(0) / max(area, 1e-12)
            md = {
                "kind": f"Klasse{ci}",
                "cluster_id": int(ci) if ci < 6 else -1,
                "n_faces": int(len(arr)),
                "area_m2": area,
                "centroid_xyz": [float(cen[0]), float(cen[1]), float(cen[2])],
                "depth_to_hull_m": None,
                "pp": None,
                "concave_frac": None,
                "reason": "",
            }
            if ci < 6:
                key = frozenset(int(x) for x in arr.tolist())
                info = main_reason_lookup.get(key)
                if info is not None:
                    md["reason"] = info["reason"]
                else:
                    md["reason"] = (f"Komponente in Cluster K{ci} "
                                    f"(area {area:.2f}m²)")
            else:
                # K6 — finde zugehörige Niche-Komponente (Faces übereinander)
                ni = int(niche_face_to_idx[arr[0]])
                if 0 <= ni < len(niche_meta):
                    nm = niche_meta[ni]
                    md["depth_to_hull_m"] = float(nm["depth"])
                    md["pp"] = float(nm["pp"]) if np.isfinite(nm["pp"]) else None
                    md["concave_frac"] = float(nm["concave_frac"])
                    md["reason"] = nm["reason"]
                else:
                    md["reason"] = "K6 ohne Niche-Meta (Filter inkonsistent?)"
            metadata.append(md)

    # ---- Geometrische Kenngrössen (L1/L3) pro Wand berechnen ----
    try:
        import metrics as _metrics
        main_face_mask = brep_meta.get("main_face_mask",
                                       ~is_niche_face)  # fallback
        wm = _metrics.wall_metrics(wall, Vt, main_face_mask,
                                   cluster_id_face, niche_components)
    except Exception as e:
        wm = {"error": f"{type(e).__name__}: {e}"}
    # Per-wall cache for L5/L6 (computed in a scene-level pass in detect()).
    # We stash the prepped wall + classification meta on `t` so the pipeline
    # can call context.internal_context / external_context AFTER all walls
    # are classified, without re-running the classifier.
    t.setdefault("_metrics_list", []).append(wm)
    t.setdefault("_context_inputs", []).append({
        "mesh": wall,
        "axes": Vt,
        "main_face_mask": main_face_mask if not isinstance(wm, dict) or "error" not in wm else None,
        "cluster_id": cluster_id_face,
        "niche_components": niche_components,
    })
    return cavities, metadata


def _prep_wall(mesh, offset):
    """Recenter by a shared offset (georef precision + multi-segment alignment),
    then guarantee a watertight volume.

    Returns ``(mesh|None, prep_failed_reason: str|None)``. ``None``-mesh signals
    that the caller MUST skip this wall (no native-lib reconstruction is
    attempted; see ``ensure_volume`` docstring)."""
    w = repair_watertight(mesh)
    w.apply_translation(-offset)
    w, reason = ensure_volume(w)
    if w is None:
        return None, reason
    w = repair_inverted_faces(w)
    return w, None


def repair_inverted_faces(mesh):
    """Detektiere und repariere einzelne Faces deren Normal nach INNEN zeigt.

    `trimesh.fix_normals` / `is_winding_consistent` prüfen nur GLOBALE
    Winding-Konsistenz und Volumen-Vorzeichen; ein einzelnes invertiert
    authored Face (z.B. Fundament-Oberkante im IFC-Export, die im CAD
    versehentlich mit umgekehrter Topologie modelliert wurde) bleibt
    unentdeckt, weil das umgebende Mesh konsistent ist.

    Verfahren (nur für watertight Volumen, sonst Identität):
      1. Pro Face einen Testpunkt knapp ENTLANG des Normals nach aussen
         setzen (eps = 1e-4 · OBB-Diagonale).
      2. Liegt der Punkt INSIDE der Wand (mesh.contains == True), dann
         zeigt der Normal nicht nach aussen, sondern nach innen → Face-
         Winding umdrehen (Vertices [v0,v1,v2] → [v0,v2,v1]) und neuer
         Trimesh konstruieren, sodass trimesh die Normalen frisch
         berechnet.

    Korrektheits-Bedingung: Mesh muss watertight und damit `mesh.contains`
    verlässlich sein. Auf nicht-volumigen Meshes wird Identität geliefert.

    PERFORMANCE: der `contains`-Ray-Cast pro Face ist teuer (O(F) Rays, pure-
    Python-Engine ohne pyembree ~5s pro 6000F-Mesh). Bei winding-konsistenten
    Meshes hat trimesh.fix_normals die Normalen bereits global korrekt
    orientiert → kein einzelnes Face kann invertiert sein. Daher: skip wenn
    winding-konsistent (= der Normalfall für saubere BRep-Solids)."""
    if not mesh.is_volume:
        return mesh
    if mesh.is_winding_consistent:
        return mesh          # Normalen bereits konsistent → kein Flip möglich
    eps = 1e-4 * obb_diagonal(mesh)
    if eps <= 0:
        return mesh
    test_pts = mesh.triangles_center + eps * mesh.face_normals
    try:
        inside = mesh.contains(test_pts)
    except Exception:
        return mesh
    n_flip = int(np.count_nonzero(inside))
    if n_flip == 0:
        return mesh
    new_faces = mesh.faces.copy()
    new_faces[inside] = new_faces[inside][:, [0, 2, 1]]   # reverse winding
    repaired = trimesh.Trimesh(vertices=mesh.vertices.copy(),
                               faces=new_faces, process=False)
    repaired.merge_vertices()
    return repaired


def _run_context_pass(t, products, offset=None, compute_distances=True):
    """L5 + L6 + L7 — scene-level pass after per-wall classification.

    Injects `context.internal` and `context.external` into each per-wall
    metrics dict; computes the L7 pairwise distance table over `products`.
    `offset` is the per-scene centring offset applied to wall meshes by
    `_prep_wall` (so the L5 paired-footing search can re-shift the wall
    bounds back into world coordinates where the footing products live).
    `compute_distances=False` skips the expensive L7 pass (scene["distances"]
    is set to None = "deferred"); L5/L6 always run (the default ruleset uses
    them). Returns the scene dict.
    """
    scene = {"distances": [], "n_products": len(products) if products else 0,
             # ADDITIV: scene-weite Erdseiten-Klasse (Legende); default None,
             # wird nach der Wand-Schleife bei Eindeutigkeit gesetzt.
             "earth_side_class": None}

    # L5 general neighbourhood graph (shared FACE > EDGE > POINT) over ALL scene
    # products. ADDITIVE: complements the per-wall stem<->foundation L5 and the
    # L7 distances with contact TOPOLOGY + containment. Frame-independent (all
    # products in world coords -> no offset). NEVER break detection.
    # L5 scene-wide adjacency graph (shared FACE>EDGE>POINT over ALL products) is
    # O(near-pairs × shared-geometry test): FAST on small scenes (demo: 5
    # products → 0.08 s) but MINUTES on dense models (68 products → it was the
    # load hang). So run it INLINE only for SMALL scenes; on large ones skip it
    # (the scene-wide neighbour GRAPH is then absent — graceful empty list; the
    # per-wall internal/external L5/L6 below does NOT depend on it and still runs:
    # stem↔foundation, terrain side, etc.). compute_distances=True (CLI/full)
    # always computes it.
    scene_adjacency_edges: list = []
    _n_prod = len(products or [])
    _n_faces = sum(len(p.mesh.faces) for p in (products or [])
                   if getattr(p, "mesh", None) is not None
                   and getattr(p.mesh, "faces", None) is not None)
    _adj_ok = compute_distances or (_n_prod <= 40 and _n_faces <= 80000)
    if _adj_ok:
        try:
            import adjacency as _adj
            scene_adjacency_edges = _adj.scene_adjacency(products or [])
        except Exception as e:
            sys.stderr.write(f"[context] L5 adjacency failed: "
                             f"{type(e).__name__}: {e}\n")
    else:
        sys.stderr.write(f"[context] L5 adjacency skipped (large scene: "
                         f"{_n_prod} products / {_n_faces} faces)\n")
    scene["adjacency"] = scene_adjacency_edges

    # L5/L6 per wall.
    try:
        import context as _ctx
        ctx_inputs = t.get("_context_inputs", [])
        metrics_list = t.get("_metrics_list", [])
        for wm, ci in zip(metrics_list, ctx_inputs):
            if not isinstance(wm, dict) or "error" in wm:
                continue
            try:
                guid = wm.get("element_guid")
                internal = _ctx.internal_context(
                    ci["mesh"], ci["axes"], ci["main_face_mask"],
                    ci["cluster_id"], scene_products=products, wall_guid=guid,
                    offset=offset)
                external = _ctx.external_context(
                    ci["mesh"], ci["axes"], ci["main_face_mask"],
                    ci["cluster_id"], scene_products=products, offset=offset)
                wm["context"] = {"internal": internal, "external": external}
                # L5 Nachbarschaft dieser Wand: aus dem scene-weiten Adjazenz-
                # Graphen die Kanten herausfiltern, die diese Wand (element_guid)
                # beruehren, und pro Kante den Partner + Kontakt-Topologie +
                # eigene Containment auflisten. ADDITIV (neben internal/external),
                # bricht nie die Detection.
                try:
                    if guid and scene_adjacency_edges:
                        nbrs = []
                        for ed in scene_adjacency_edges:
                            if ed.get("a_guid") == guid:
                                nbrs.append({
                                    "other_guid": ed.get("b_guid"),
                                    "other_name": ed.get("b_name"),
                                    "other_type": ed.get("b_type"),
                                    "level": ed.get("level"),
                                    "shared_area_m2": ed.get("shared_area_m2"),
                                    "containment_self": ed.get("containment_a"),
                                })
                            elif ed.get("b_guid") == guid:
                                nbrs.append({
                                    "other_guid": ed.get("a_guid"),
                                    "other_name": ed.get("a_name"),
                                    "other_type": ed.get("a_type"),
                                    "level": ed.get("level"),
                                    "shared_area_m2": ed.get("shared_area_m2"),
                                    "containment_self": ed.get("containment_b"),
                                })
                        wm["context"]["neighbors"] = nbrs
                except Exception as e:
                    sys.stderr.write(
                        f"[context] neighbors '{wm.get('element_name')}' "
                        f"failed: {type(e).__name__}: {e}\n")
                # Kronen-Entwaesserungsrichtung (Strasse > Hang > unbestimmt)
                # ins slope-Sub-Dict spiegeln, damit die Regel-Engine sie als
                # Target 'slope.crown_drainage_percent' lesen kann. + = Krone
                # faellt zur FHB-konformen Seite; None -> Regel SKIP.
                try:
                    drain = _ctx.crown_drainage(
                        ci["mesh"], ci["axes"], ci["main_face_mask"],
                        ci["cluster_id"], external, scene_products=products)
                    sl = wm.get("slope")
                    if isinstance(sl, dict):
                        toward_front = sl.get("crown_drain_toward_front_percent")
                        tci = drain.get("drain_target_ci")
                        if toward_front is not None and tci is not None:
                            # tci==4 (K_FRONT/+Vt[2]) -> Zielrichtung deckt sich
                            # mit toward_front; tci==5 (K_BACK) -> Vorzeichen drehen.
                            sl["crown_drainage_percent"] = float(
                                toward_front if tci == 4 else -toward_front)
                        elif toward_front is not None:
                            # Richtung unbestimmt (kein Strassen-/Terrain-Beleg),
                            # aber das Quer-Gefaelle der Krone ist messbar: nur den
                            # vorzeichenlosen BETRAG ausweisen. Die Regel prueft so
                            # weiterhin, ob die Krone ueberhaupt das geforderte
                            # Gefaelle hat -- die SEITE bleibt unverifiziert (siehe
                            # niedrige Confidence unten -> WARN/Hinweis).
                            sl["crown_drainage_percent"] = abs(float(toward_front))
                        else:
                            sl["crown_drainage_percent"] = None
                        ref = drain.get("reference")
                        sl["crown_drainage_reference"] = ref
                        sl["crown_drainage_target_face_class"] = \
                            drain.get("drain_target_face_class")
                        # Evidenz-Confidence: Strasse = volle Richtungsevidenz
                        # (1.0); Hang-/Terrain-Fallback = teilweise (0.5) -> die
                        # Regel-Engine stuft die crown_slope-Regel via
                        # min_confidence auf WARN/"niedrig" herab = Hinweis
                        # "Richtung nicht vollstaendig geprueft". Strasse loest
                        # berg/tal eindeutig, der Hang-Fallback nur den FHB-
                        # Regelfall.
                        sl["crown_drainage_confidence"] = (
                            1.0 if ref == "road"
                            else 0.5 if ref == "hang"
                            # Richtung unbestimmt, aber Betrag gemessen -> niedrige
                            # Confidence (0.3 < min_confidence 0.6) stuft die Regel
                            # auf WARN herab ("nur Betrag geprueft, Richtung mangels
                            # Terrain/Strasse nicht verifiziert"), statt sie wie bei
                            # confidence=None ganz zu ueberspringen (SKIP).
                            else 0.3 if toward_front is not None
                            else None)
                except Exception as e:
                    sys.stderr.write(
                        f"[context] crown_drainage '{wm.get('element_name')}' "
                        f"failed: {type(e).__name__}: {e}\n")
            except Exception as e:
                sys.stderr.write(f"[context] wall '{wm.get('element_name')}' "
                                 f"failed: {type(e).__name__}: {e}\n")
        # ----- Scene-weite Erdseiten-Klasse fuer die Legende (ADDITIV) -----
        # Nur EINDEUTIG benennen: wenn ALLE terrain-beruehrenden Waende
        # (external.side_clear == True) DIESELBE earth_side_face_class melden,
        # ist die Erdseite scene-weit eindeutig (K4 oder K5) -> Legende kann
        # umbenennen. Sonst (gemischt / keine eindeutige Wand) -> None
        # (Legende bleibt neutral K4/K5). NIE raise.
        try:
            clear_sides = set()
            for wm in metrics_list:
                if not isinstance(wm, dict) or "error" in wm:
                    continue
                ext = (wm.get("context") or {}).get("external") or {}
                if ext.get("side_clear") is True:
                    esc = ext.get("earth_side_face_class")
                    if esc in ("K4", "K5"):
                        clear_sides.add(esc)
            scene["earth_side_class"] = (clear_sides.pop()
                                         if len(clear_sides) == 1 else None)
        except Exception as e:
            sys.stderr.write(f"[context] earth_side_class aggregation failed: "
                             f"{type(e).__name__}: {e}\n")
            scene["earth_side_class"] = None
    except Exception as e:
        sys.stderr.write(f"[context] L5/L6 import failed: "
                         f"{type(e).__name__}: {e}\n")

    # L7: scene-wide pair distances. EXPENSIVE on tessellated models (~6 s) and
    # the default ASTRA ruleset has no scene.distances rule, so the caller can
    # defer it (compute_distances=False) and recompute it in the background via
    # `scene_pair_distances` once the main result is on screen. `distances=None`
    # signals "not yet computed" (vs `[]` = computed, empty) so the UI can show a
    # "wird berechnet …" hint instead of "keine Distanzen".
    if compute_distances:
        try:
            import distances as _dst
            scene["distances"] = _dst.scene_distances(products or [],
                                                      max_pair_distance_m=10.0)
        except Exception as e:
            sys.stderr.write(f"[context] L7 distances failed: "
                             f"{type(e).__name__}: {e}\n")
            scene["distances"] = []
    else:
        scene["distances"] = None

    return scene


def scene_pair_distances(products, max_pair_distance_m=10.0):
    """Standalone L7 distance table over already-loaded products (the background
    pass). Mirrors the L7 block in `_run_context_pass` so the deferred recompute
    is identical to the inline one."""
    try:
        import distances as _dst
        return _dst.scene_distances(products or [],
                                    max_pair_distance_m=max_pair_distance_m)
    except Exception as e:
        sys.stderr.write(f"[context] L7 distances (deferred) failed: "
                         f"{type(e).__name__}: {e}\n")
        return []


# Types that should be visualised as scene-context (terrain, road, footing,
# decorative proxies) — NOT part of the carved-wall mesh but useful for the
# user to orient themselves in 3D ("wo steht die Wand im Gelände?").
_CONTEXT_TERRAIN_TYPES = {"IfcSite", "IfcGeographicElement", "IfcVirtualElement"}
_CONTEXT_ROAD_TYPES = {"IfcRoad", "IfcPavement", "IfcCourse"}
# _CONTEXT_FOOTING_TYPES is imported from context (P2: single source of truth).


def _collect_context_meshes(products, used_guids, offset):
    """Pick up products that were NOT consumed as walls (terrain, road,
    footing, proxy) so the viewer can show them as scene context. `offset`
    is the same per-scene centring offset applied to walls/cavities so they
    line up in the GLB.

    Returns list[(mesh_copy_centred, ifc_type, name)].
    """
    out = []
    off = np.zeros(3) if offset is None else np.asarray(offset, dtype=np.float64)
    for p in products:
        if p.guid in used_guids:
            continue                                 # already in wall mesh
        if not getattr(p, "mesh", None) or len(p.mesh.faces) < 1:
            continue
        t = p.ifc_type
        if (t in _CONTEXT_TERRAIN_TYPES
                or t in _CONTEXT_ROAD_TYPES
                or t in _CONTEXT_FOOTING_TYPES
                or t == "IfcBuildingElementProxy"):
            m = p.mesh.copy()
            m.vertices = m.vertices - off            # match wall/cav centring
            out.append((m, t, p.name or t))
    return out


def detect(ifc_path, out_ifc, target=None, compute_distances=True,
           products=None, **_ignored) -> Result:
    """Classify-only detection: 7-Klassen-Face-Klassifikation auf jeder Wand,
    Submeshes pro Klassen-Komponente. `target=ALL_WALLS` (default für
    Multi-Wall-Modelle) verarbeitet jedes Wand-Segment. Zusätzliche kwargs
    werden ignoriert (Backward-Compat zu früheren method/tau-Argumenten).

    `compute_distances=False` überspringt den teuren L7-Distanz-Pass (~6 s auf
    tessellierten Modellen); `result.scene["distances"]` ist dann `None`
    (= aufgeschoben). Der Aufrufer kann ihn danach via `scene_pair_distances`
    im Hintergrund nachrechnen. `result.products` trägt die geladenen Produkte
    für genau diesen Nachlauf.

    `products` (optional): vorgeladene Liste[LoadedProduct]. Wird sie übergeben,
    überspringt detect das OpenCASCADE-Laden komplett — so kann eine schnellere
    Engine (web-ifc) die Geometrie liefern (siehe webifc_mesh.py). `ifc_path`
    wird dann nur noch als Diagnose-Label benutzt (nicht geöffnet)."""
    t = {}
    c = time.perf_counter
    t0 = c()
    if products is None:
        products = load_product_meshes(ifc_path)
    t["S1_parse"] = c() - t0
    if not products:
        raise SystemExit(f"No renderable geometry found in {ifc_path}")

    solids = candidate_solids(products)
    # Select walls by CLASS from all products. Non-watertight meshes flow through
    # _prep_wall as well; those that cannot be repaired purely with trimesh are
    # skipped with a `prep_failed` marker rather than reconstructed via a
    # native-only voxel-remesh path (Defense: transparenter Skip statt Blackbox).
    # Real IfcWall/IfcWallStandardCase AND wall-like IfcBuildingElementProxy
    # (upright, thin, elongated) are processed with the IfcWall-rules. Non-wall-like
    # proxies (slabs, shafts, columns, terrain) stay out of the wall group.
    real_walls = [p for p in products if p.ifc_type in _WALL_TYPES and len(p.mesh.faces) >= 4]
    walls = [p for p in products if _qualifies_as_wall(p) and len(p.mesh.faces) >= 4]
    # Many CAD exports type everything as IfcBuildingElementProxy ("Smart Solid"),
    # so fall back to ALL solids when there are no IfcWall — otherwise the
    # "process everything" option would never appear.
    #
    # P1: a footing is L5-CONTEXT for a wall, NOT itself a wall. When we fall
    # back to `solids` (a scene with <2 IfcWall, e.g. one IfcWall + one
    # IfcFooting), the footing must NOT be classified as its own "wall
    # segment" — otherwise it appears in the report as a bogus wall with
    # foundation_present=False and emits a misleading
    # `[rules] skip 'l5_fundament_ueberstand'`. The footing stays in `products`
    # (so `_find_paired_footing` and the viewer context-mesh picker still see
    # it), it is just removed from the segment-processing group.
    solids_no_footing = [p for p in solids
                         if p.ifc_type not in _CONTEXT_FOOTING_TYPES]
    # Wall-like-Proxy-Filter NUR anwenden, wenn es echte IfcWall gibt (gemischte
    # Modelle: footing-/shaft-Proxies aus der Wand-Gruppe halten). Bei REINEN
    # Proxy-Modellen ("Smart Solid": alles IfcBuildingElementProxy, z.B. das
    # Thesis-Modell) wuerde der strenge wandaehnlich-Test gebogene/kurze Wand-
    # segmente faelschlich verwerfen -> stattdessen wie frueher ALLE (nicht-
    # footing) Solids klassifizieren (sonst "weniger Elemente klassifiziert").
    if real_walls:
        group = walls if len(walls) >= 2 else solids_no_footing
    else:
        group = solids_no_footing if len(solids_no_footing) >= 2 else walls
    cands = []
    if len(group) >= 2:
        label = (f"★ Alle Wände ({len(group)})" if (real_walls and len(walls) >= 2)
                 else f"★ Alle Bauteile ({len(group)})")
        cands.append((ALL_WALLS, label))
    cands += [(p.guid, f"{(p.name or p.ifc_type)} · {p.ifc_type} · {len(p.mesh.faces)}F")
              for p in solids[:40]]
    if target is None and len(group) >= 2:      # default: the whole structure
        target = ALL_WALLS

    # ---- multi-element: process every segment with a shared offset ----
    if target == ALL_WALLS:
        selected = group
        mn = np.min([p.mesh.bounds[0] for p in selected], axis=0)
        mx = np.max([p.mesh.bounds[1] for p in selected], axis=0)
        offset = ((mn + mx) / 2.0)
        all_cav, all_meta, wall_meshes = [], [], []
        skipped_walls: list[dict] = []
        t0 = c()
        prepped = []
        prepped_src = []   # parallel zu prepped: Liste der Quell-Products (kann nach Union mehrere sein)
        for p in selected:
            w, reason = _prep_wall(p.mesh, offset)
            if w is None:
                _name = p.name or p.ifc_type
                _why = reason or "unbekannt"
                sys.stderr.write(
                    f"[prep_failed] Wand '{_name}' (guid={p.guid}) übersprungen: "
                    f"{_why}\n")
                skipped_walls.append({
                    "element_name": _name,
                    "element_guid": p.guid,
                    "ifc_type": p.ifc_type,
                    "prep_failed": True,
                    "prep_failure_reason": _why,
                })
                continue
            prepped.append(w); prepped_src.append([p])
        # Union near-coincident element copies first → displayed wall == carved wall.
        # Group-Mapping erhalten damit jeder Cavity ein Quell-Element zugewiesen werden kann.
        _u0 = c()
        if _DEBUG: print(f"[driver.detect] union START ({len(prepped)} prepped walls)", flush=True)
        prepped, groups = _union_overlapping_elements(prepped, return_groups=True)
        if _DEBUG: print(f"[driver.detect] union DONE in {c()-_u0:.2f}s -> {len(prepped)} groups", flush=True)
        prepped_src = [sum((prepped_src[k] for k in g), []) for g in groups]
        # ZWEI-PASS Achsen-Strategie:
        #   1. detect_niches_face_classification nutzt LOKALE PCA pro Element
        #      → korrekte Niche-Erkennung (Drainage, Versatzflächen etc.)
        #   2. _detect_classify nutzt GLOBALE welt-ausgerichtete Achsen für
        #      cluster_id_face → konsistente Klassen-Labels über alle Elemente
        #      (Front = immer K4/K5, Top/Bottom = K2/K3, Stirn = K0/K1)
        #   face_class = np.where(is_niche_face, 6, cluster_id_face) kombiniert
        #   beides: K6 aus lokaler Niche-Detection, K0-5 aus globaler Klassifikation.
        if prepped:
            all_v = np.vstack([w.vertices for w in prepped])
            xy = all_v[:, :2] - all_v[:, :2].mean(0)
            _, _, hVt = np.linalg.svd(xy, full_matrices=False)
            v0 = np.array([hVt[0, 0], hVt[0, 1], 0.0])
            if v0[0] < -1e-9 or (abs(v0[0]) < 1e-9 and v0[1] < 0):
                v0 = -v0
            v1 = np.array([0.0, 0.0, 1.0])
            v2 = np.cross(v0, v1)
            t["_global_axes"] = np.vstack([v0, v1, v2])
        _clf0 = c()
        for _wi, (w, srcs) in enumerate(zip(prepped, prepped_src)):
            wall_meshes.append(w)
            _nmetrics_before = len(t.get("_metrics_list", []))
            cav, meta = _detect_classify(w, t)
            if _DEBUG and ((_wi + 1) % 10 == 0 or (_wi + 1) == len(prepped)):
                print(f"[driver.detect] classified {_wi+1}/{len(prepped)} walls "
                      f"({c()-_clf0:.1f}s)", flush=True)
            # Element-Info pro Cavity anhängen: erstes Quell-Element als
            # Repräsentant (bei Union mehrerer überlappender Kopien); zusätzlich
            # alle GUIDs damit der Viewer den ganzen Cluster isolieren kann.
            elem_name = (srcs[0].name or srcs[0].ifc_type) if srcs else "?"
            elem_guid = srcs[0].guid if srcs else ""
            elem_all_guids = [s.guid for s in srcs]
            if len(srcs) > 1:
                elem_name = f"{elem_name} (+{len(srcs)-1} weitere Kopien)"
            for m in meta:
                m["element_name"] = elem_name
                m["element_guid"] = elem_guid
                m["element_guids"] = elem_all_guids
            # Wand-Element-Identität an die NEU angehängten wall_metrics-Dicts
            # binden, damit der Viewer sie pro Element zuordnen kann.
            for wm_i in t.get("_metrics_list", [])[_nmetrics_before:]:
                if isinstance(wm_i, dict):
                    wm_i["element_name"] = elem_name
                    wm_i["element_guid"] = elem_guid
                    wm_i["element_guids"] = elem_all_guids
            all_cav += cav
            all_meta += meta
        # STABLE order: die Multi-Wall-Pipeline produziert Submeshes in einer
        # nicht-deterministischen Segment-Reihenfolge — Sortierung nach Centroid
        # macht die Viewer-Nummerierung (#N) reproduzierbar. Metadata mit-sortieren.
        _order = sorted(range(len(all_cav)),
                        key=lambda i: tuple(np.round(all_cav[i][0].centroid, 3)))
        all_cav = [all_cav[i] for i in _order]
        all_meta = [all_meta[i] for i in _order]
        t["S_detect"] = c() - t0
        wall_meshes = [w for w in wall_meshes if w is not None]
        if not wall_meshes:
            raise SystemExit("Keine verwertbare Wand im Modell gefunden.")
        wall_all = trimesh.util.concatenate(wall_meshes)
        # ---- Scene-Level L5/L6/L7 (after all per-wall classification done) ----
        scene_info = _run_context_pass(t, products, offset=offset,
                                       compute_distances=compute_distances)
        # Modell-Bbox-Zentrum (LV95) mitgeben: Geometrie wird damit fuer
        # Pipeline/Renderer zentriert; der BCF-Export rechnet es zurueck in die
        # echten Weltkoordinaten (sonst landen Kamera/Schnitt ~Mio. m daneben).
        if isinstance(scene_info, dict):
            scene_info["offset"] = [float(offset[0]), float(offset[1]),
                                    float(offset[2])]
        # Export NACH dem Context-Pass, damit die Wand-Metrics bereits context.*
        # tragen (L5 Fundament-Überstand, L6 Terrain-Seite) → kommt ins Pset.
        # Nur exportieren wenn ein Zielpfad gegeben ist: das Web-Driver ruft mit
        # out_ifc=None auf (IFC wird on-demand via export_ifc() erzeugt), CLI/Tests
        # geben einen echten Pfad → exportieren wie gehabt.
        t0 = c()
        if out_ifc:
            _export(out_ifc, wall_all, all_cav, offset=offset,
                    metadata=all_meta,
                    wall_metrics=t.get("_metrics_list", []))
        t["export"] = c() - t0
        gname = (f"Alle Wände ({len(wall_meshes)})" if len(walls) >= 2
                 else f"Alle Bauteile ({len(wall_meshes)})")
        # ---- Context-Meshes für Viewer (Terrain / Strassen / Proxy ohne Wand-Rolle) ----
        selected_guids = {p.guid for p in selected}
        ctx_meshes = _collect_context_meshes(products, selected_guids, offset)
        # wall_metrics um die übersprungenen Wände ergänzen, damit der Bericht
        # transparent zeigt welche Wand wegen prep_failed nicht klassifiziert
        # werden konnte (statt sie stillschweigend zu verschlucken).
        _wm_full = list(t.get("_metrics_list", []))
        for sw in skipped_walls:
            _wm_full.append(dict(sw))
        return Result(wall_all, all_cav, t, gname,
                      chosen_guid=ALL_WALLS, candidates=cands,
                      skipped_walls=skipped_walls,
                      metadata=all_meta, wall_metrics=_wm_full,
                      scene=scene_info, context_meshes=ctx_meshes,
                      products=products)

    # ---- single element ----
    chosen = pick_wall(products, target)
    offset = chosen.mesh.bounds.mean(axis=0).copy()
    wall, prep_reason = _prep_wall(chosen.mesh, offset)
    if wall is None:
        raise SystemExit(
            f"'{chosen.name or chosen.ifc_type}' ist kein verwertbares "
            f"Volumen (prep_failed: {prep_reason or 'unbekannt'}). "
            "Bitte ein anderes Element wählen oder Quellmesh wasserdicht "
            "machen.")
    # Welt-ausgerichtete Achsen auch im Single-Pick: Vt[1] = +Z (Welt-vertikal,
    # Schwerachse) → Top/Bottom IMMER K2/K3, nie K4/K5. Ohne das nimmt die
    # lokale PCA eines flachen Fundament-Slabs die kleinste Achse (= vertikal)
    # als Vt[2] → Top würde fälschlich als "Wand-Front" (K4) gelabelt.
    xy = wall.vertices[:, :2] - wall.vertices[:, :2].mean(0)
    _, _, hVt = np.linalg.svd(xy, full_matrices=False)
    v0 = np.array([hVt[0, 0], hVt[0, 1], 0.0])
    if v0[0] < -1e-9 or (abs(v0[0]) < 1e-9 and v0[1] < 0):
        v0 = -v0
    t["_global_axes"] = np.vstack([v0, np.array([0.0, 0.0, 1.0]), np.cross(v0, [0.0, 0.0, 1.0])])
    _nmetrics_before = len(t.get("_metrics_list", []))
    cav, meta = _detect_classify(wall, t)
    elem_name = chosen.name or chosen.ifc_type
    for m in meta:
        m["element_name"] = elem_name
        m["element_guid"] = chosen.guid
        m["element_guids"] = [chosen.guid]
    for wm_i in t.get("_metrics_list", [])[_nmetrics_before:]:
        if isinstance(wm_i, dict):
            wm_i["element_name"] = elem_name
            wm_i["element_guid"] = chosen.guid
            wm_i["element_guids"] = [chosen.guid]
    _order = sorted(range(len(cav)),
                    key=lambda i: tuple(np.round(cav[i][0].centroid, 3)))
    cav = [cav[i] for i in _order]
    meta = [meta[i] for i in _order]
    # ---- Scene-Level L5/L6/L7 (single-wall: still useful for L5+L6) ----
    scene_info = _run_context_pass(t, products, offset=offset,
                                   compute_distances=compute_distances)
    # Modell-Bbox-Zentrum (LV95) mitgeben (siehe Multi-Element-Pfad): der
    # BCF-Export addiert es zurueck auf Kamera/Schnitt/Redline-Koordinaten.
    if isinstance(scene_info, dict):
        scene_info["offset"] = [float(offset[0]), float(offset[1]),
                                float(offset[2])]
    # Export nach dem Context-Pass → context.* (L5/L6) ist im Pset.
    # Nur exportieren wenn ein Zielpfad gegeben ist (siehe Multi-Element-Pfad):
    # Web-Driver ruft mit out_ifc=None auf (on-demand export_ifc()), CLI/Tests
    # geben einen echten Pfad.
    t0 = c()
    if out_ifc:
        _export(out_ifc, wall, cav, offset=offset, metadata=meta,
                wall_metrics=t.get("_metrics_list", []))
    t["export"] = c() - t0
    # ---- Context-Meshes für Viewer (Terrain / Strassen / Proxy ohne Wand-Rolle) ----
    ctx_meshes = _collect_context_meshes(products, {chosen.guid}, offset)
    return Result(wall, cav, t, chosen.name or chosen.ifc_type,
                  chosen_guid=chosen.guid, candidates=cands,
                  metadata=meta,
                  wall_metrics=t.get("_metrics_list", []),
                  scene=scene_info, context_meshes=ctx_meshes,
                  products=products)


# --------------------------------------------------------------------------- #
#  Reporting & visualization
# --------------------------------------------------------------------------- #
def print_report(res: Result, out_ifc):
    times = {k: v for k, v in res.timings.items() if not k.startswith("_")}
    n_skipped = len(getattr(res, "skipped_walls", []) or [])
    print(f"\nWall: '{res.wall_name}'  | {len(res.wall.faces)} faces  "
          f"| watertight={res.wall.is_watertight}  | method={res.method}"
          + (f"  | ⚠ {n_skipped} Wand(e) übersprungen (prep_failed)"
             if n_skipped else ""))
    print(f"Schaleinlagen-Submeshes: {len(res.cavities)}")
    print("Timings: " + "  ".join(f"{k}={v*1000:.0f}ms" for k, v in times.items())
          + f"  | TOTAL={sum(times.values())*1000:.0f}ms")
    print(f"Written: {out_ifc}")


def _to_pv(mesh):
    import pyvista as pv
    faces = np.hstack([np.full((len(mesh.faces), 1), 3, dtype=np.int64),
                       mesh.faces.astype(np.int64)]).ravel()
    return pv.PolyData(mesh.vertices, faces)


def view_pyvista(res: Result, screenshot=None, interactive=True):
    """Interactive verification window (wall transparent, classified submeshes solid)."""
    import pyvista as pv
    pl = pv.Plotter(off_screen=bool(screenshot) and not interactive)
    pl.add_mesh(_to_pv(res.wall), color="lightgray", opacity=0.3,
                show_edges=False, name="wall")
    palette = ["yellow", "gold", "orange", "#ffe600", "#ffcc00"]
    for i, (mesh, kind) in enumerate(res.cavities):
        pl.add_mesh(_to_pv(mesh), color=palette[i % len(palette)], opacity=1.0,
                    show_edges=True, edge_color="black", line_width=1,
                    label=f"Submesh {i+1} ({kind})")
    if res.cavities:
        pl.add_legend()
    pl.add_axes()
    pl.enable_depth_peeling()
    if screenshot:
        pl.screenshot(screenshot)
    if interactive:
        pl.show()
    pl.close()


def save_preview_matplotlib(res: Result, path):
    """Headless fallback render (Agg) so the result is verifiable without a GPU."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    fig = plt.figure(figsize=(11, 7))
    ax = fig.add_subplot(111, projection="3d")
    w = res.wall
    ax.add_collection3d(Poly3DCollection(w.vertices[w.faces], alpha=0.10,
                                         facecolor="gray", edgecolor="none"))
    for i, (mesh, kind) in enumerate(res.cavities):
        ax.add_collection3d(Poly3DCollection(
            mesh.vertices[mesh.faces], alpha=1.0,
            facecolor="#ffd400", edgecolor="k", linewidths=0.15))
    lo, hi = w.bounds
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(lo[2], hi[2])
    try:
        ax.set_box_aspect(hi - lo)
    except Exception:
        pass
    ax.set_title(f"{res.wall_name}: {len(res.cavities)} Submesh(es) "
                 f"(wall transparent)")
    ax.view_init(elev=22, azim=-60)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# --------------------------------------------------------------------------- #
#  CLI
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ifc", help="input IFC file (semantics-free wall mesh)")
    ap.add_argument("-o", "--out", default=None,
                    help="output IFC (default: <in>_schaleinlagen.ifc)")
    ap.add_argument("--target", default=None,
                    help="GlobalId or Name substring of the wall")
    ap.add_argument("--preview", default=None,
                    help="write a headless PNG preview to this path")
    ap.add_argument("--serve", action="store_true",
                    help="open a localhost web (Three.js) viewer")
    ap.add_argument("--port", type=int, default=8000,
                    help="port for --serve (default 8000)")
    ap.add_argument("--no-view", action="store_true",
                    help="skip the interactive pyvista window")
    ap.add_argument("--rules", default=None,
                    help="path to YAML ruleset for L4 Pruefung "
                         "(default: bundled rules_astra_demo.yaml)")
    args = ap.parse_args()

    try:                                  # Windows consoles default to cp1252
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    out = args.out or (args.ifc.rsplit(".", 1)[0] + "_schaleinlagen.ifc")
    res = detect(args.ifc, out, target=args.target)
    print_report(res, out)

    # ----- L4 Prueftprotokoll (HTML + JSON) neben dem IFC-Output schreiben -----
    # Verwendet das YAML-Ruleset aus `--rules` oder das gebundelte ASTRA-Demo
    # (rules_astra_demo.yaml). Schreibt `<out>_pruefprotokoll.html` und `.json`.
    try:
        import os as _os
        import report as _report
        import rules as _rules
        _rs = _rules.load_ruleset(args.rules) if args.rules else _rules.load_ruleset()
        _rep = _report.build_report(res, model_name=_os.path.basename(args.ifc),
                                    ruleset=_rs)
        _html_path = out.rsplit(".", 1)[0] + "_pruefprotokoll.html"
        _json_path = out.rsplit(".", 1)[0] + "_pruefprotokoll.json"
        with open(_html_path, "w", encoding="utf-8") as f:
            f.write(_report.to_html(_rep))
        with open(_json_path, "w", encoding="utf-8") as f:
            f.write(_report.to_json(_rep))
        print(f"Prueftprotokoll: {_html_path}")
        print(f"Prueftprotokoll: {_json_path}")
    except Exception as _e:
        print(f"[Warn] Pruefprotokoll konnte nicht erstellt werden: "
              f"{type(_e).__name__}: {_e}")

    if args.preview:
        try:
            view_pyvista(res, screenshot=args.preview, interactive=False)
            print(f"Preview (pyvista): {args.preview}")
        except Exception as e:
            print(f"pyvista off-screen failed ({e}); using matplotlib fallback.")
            save_preview_matplotlib(res, args.preview)
            print(f"Preview (matplotlib): {args.preview}")

    if args.serve:
        import os
        import web_viewer
        glb = out.rsplit(".", 1)[0] + ".glb"
        web_viewer.export_glb(res.wall, res.cavities, glb,
                              context_meshes=getattr(res, "context_meshes", None))
        # Seed the JSON endpoints (/wallmetrics, /metadata, /report) so the
        # CLI-preloaded model already shows L1..L7 in the Inspector before
        # the user uploads anything new. Alle Writes unter _LAST_LOCK (HIGH 9).
        _ifc_bytes = None
        _glb_bytes_seed = None
        try:                                   # seed the /result.* download endpoints
            with open(out, "rb") as f:
                _ifc_bytes = f.read()
            with open(glb, "rb") as f:
                _glb_bytes_seed = f.read()
        except Exception as _e:
            import sys as _sys
            _sys.stderr.write(f"[serve] CLI seed read failed: "
                              f"{type(_e).__name__}: {_e}\n")
        with web_viewer._LAST_LOCK:
            if _ifc_bytes is not None:
                web_viewer._LAST["ifc"] = _ifc_bytes
            if _glb_bytes_seed is not None:
                web_viewer._LAST["glb"] = _glb_bytes_seed
            web_viewer._LAST["wallmetrics"] = list(res.wall_metrics) if res.wall_metrics else []
            web_viewer._LAST["metadata"] = list(res.metadata) if res.metadata else []
            web_viewer._LAST["result"] = res
            web_viewer._LAST["model_name"] = os.path.basename(args.ifc)
            # CLI-Ruleset an den Server weiterreichen (sonst default bundle).
            if args.rules:
                web_viewer._LAST["rules_path"] = args.rules
        d = os.path.dirname(os.path.abspath(glb))
        web_viewer.run_server(d, port=args.port, initial_glb=os.path.basename(glb),
                              title=f"{res.wall_name} — {len(res.cavities)} Submesh(es)")
        return

    if not args.no_view:
        view_pyvista(res, interactive=True)


if __name__ == "__main__":
    main()
