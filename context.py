"""
context.py - L5 / L6 geometric context metrics for the astra-wall-validator.

Two stage-level passes that complement the per-wall L1/L3 in `metrics.py`:

  L5  internal context (within the same construction element):
        wall stem <-> foundation. Two cases handled by `internal_context`:
          a) single-solid wall whose K3 (-Vt[1]) face IS the foundation: the
             stem-vs-foundation footprint comes from the K3 region geometry.
          b) separate IfcFooting (or IfcWall labelled "Fundament") product:
             paired with this wall by XY-bbox overlap + Z-adjacency, the same
             metrics are computed from the pair's two meshes.

  L6  external context (no direct relation, terrain mediated):
        decide which K-face of the wall is "Luftseite" (air, open) vs
        "Erdseite" (earth, backfilled). If an IfcSite / IfcGeographicElement
        mesh is in the scene -> measure perpendicular distance from each face
        to the terrain (smaller distance = earth side). WITHOUT terrain the
        air/earth assignment is geometrically NOT determinable -> we declare
        both classes "unbestimmt" and `confidence_level="niedrig"` instead of
        guessing a convention. (The earlier K4=air/K5=earth fallback was a
        domain guess and has been removed -- honest indeterminacy over a
        plausible-but-unfounded label.)

Public entry points (`internal_context`, `external_context`) return plain
dicts; never raise. They wrap their numeric core in `try/except Exception`
with a stderr warning, matching the existing pipeline style.

All numeric units: lengths m, areas m^2, volumes m^3.
"""
from __future__ import annotations

import sys

import numpy as np
import trimesh
import distances


# Class indices (mirror metrics.py)
K_PLUS_X = 0    # +Vt[0]
K_MINUS_X = 1   # -Vt[0]
K_CROWN = 2     # +Vt[1]
K_FOUND = 3     # -Vt[1]
K_FRONT = 4     # +Vt[2]
K_BACK = 5      # -Vt[2]


_TERRAIN_TYPES = {"IfcSite", "IfcGeographicElement", "IfcVirtualElement"}
# Footing-typed IFC products that may pair with a wall stem as its foundation.
# IfcSlab is included because real CAD exports frequently model a strip/spread
# foundation as an IfcSlab (PredefinedType BASESLAB) rather than IfcFooting.
# SINGLE source of truth — ifcinspect.py imports this so the
# wall-segment loop, the viewer context-mesh picker and `_find_paired_footing`
# all agree on what counts as a footing (P2).
_FOOTING_TYPES = {"IfcFooting", "IfcSlab"}

# Strassen-Erkennung fuer die Kronen-Entwaesserungsrichtung: primaer ueber die
# IFC-Klasse, sekundaer ueber Namens-Heuristik (Lieferungen modellieren die
# Strasse oft nur als benannten IfcBuildingElementProxy).
_ROAD_TYPES = {"IfcRoad", "IfcRoadPart", "IfcPavement", "IfcCourse",
               "IfcAlignment"}
_ROAD_NAME_HINTS = ("strasse", "straße", "strass", "road", "fahrbahn",
                    "carriageway", "pavement", "route", "chaussee", "belag",
                    "fahrstreifen", "achse")


# --------------------------------------------------------------------------- #
#  L5 - internal context (stem <-> foundation)
# --------------------------------------------------------------------------- #
def _region_faces(main_face_mask, cluster_id, ci):
    cl = np.asarray(cluster_id)
    sel = (cl == ci) & np.asarray(main_face_mask, dtype=bool)
    return np.where(sel)[0]


def _foundation_footprint_xy(mesh, faces, axes):
    """Footprint (XY in PCA frame Vt[0] x Vt[2]) of a face group.

    Returns (extent_along_axis_m, extent_across_axis_m, polygon_area_m2,
    center_x, center_z) where x is along Vt[0] (wall length) and z is along
    Vt[2] (wall thickness). area approximated by axis-aligned bounding box."""
    if len(faces) == 0:
        return None
    Vt = np.asarray(axes, dtype=float)
    v_ids = np.unique(mesh.faces[faces])
    V = mesh.vertices[v_ids] - mesh.vertices.mean(0)
    x = V @ Vt[0]
    z = V @ Vt[2]
    if len(x) < 2:
        return None
    return {
        "length": float(np.ptp(x)),
        "width": float(np.ptp(z)),
        "area": float(np.ptp(x) * np.ptp(z)),
        "cx": float((x.min() + x.max()) * 0.5),
        "cz": float((z.min() + z.max()) * 0.5),
    }


def _median_edge_length(mesh, faces):
    """Median Kantenlaenge der gegebenen Faces (Mess-/Tessellierungs-Skala).

    Dient als auflösungsbasierte Toleranz: ein Effekt (z.B. seitlicher
    Fundament-Überstand) ist nur dann "real", wenn er grösser ist als die
    Längenskala, auf der das Mesh überhaupt aufgelöst ist. Aus der Geometrie
    hergeleitet, KEIN getunter Schwellwert. Defensiv: leere/entartete Region
    -> None."""
    faces = np.asarray(faces, dtype=int)
    if faces.size == 0:
        return None
    try:
        tris = mesh.vertices[mesh.faces[faces]]          # (F,3,3)
        e0 = np.linalg.norm(tris[:, 1] - tris[:, 0], axis=1)
        e1 = np.linalg.norm(tris[:, 2] - tris[:, 1], axis=1)
        e2 = np.linalg.norm(tris[:, 0] - tris[:, 2], axis=1)
        edges = np.concatenate([e0, e1, e2])
        edges = edges[edges > 1e-12]
        if edges.size == 0:
            return None
        return float(np.median(edges))
    except Exception:
        return None


def _stem_footprint_xy(mesh, axes, cluster_id, main_face_mask):
    """Stem footprint = projection of K4+K5 (front+back) faces of the STEM.

    Misst die Stamm-Breite (Vt[2]-Ausdehnung) im OBEREN Teil der Wand, klar
    OBERHALB eines möglichen Fundament-Sockels. Begründung: ein Fundament ist
    ein flacher Sockel im unteren Höhenband; misst man die Stamm-Breite über
    die volle Höhe (oder im UNTEREN Band), zählt man die breiten Front/Back-
    Faces der Fundamentplatte mit und der seitliche Überstand verschwindet
    fälschlich. Im oberen Höhenband ist garantiert nur der Stamm.

    DEKLARIERTE Mess-Toleranz (kein Ja/Nein-Rate-Wert): der `0.50`-Faktor
    nimmt die obere Hälfte der Stamm-Vertices als „reiner-Stamm"-Fenster.
    Konsequenzen sind monoton & korrekt in beiden Grenzfällen:
      * plain wall (Stamm == Wand): obere Hälfte hat dieselbe Breite wie die
        K3-Boden-Face → Überstand 0 → korrekt „kein Fundament".
      * L-/T-Profil: obere Hälfte = schmaler Stamm, K3 = breite Sohle →
        klarer Überstand → korrekt „Fundament".
    Es ist ein Mess-Fenster (welcher Teil des Stamms gemessen wird), keine
    Klassifikations-Entscheidung — die fällt einzig über den Überstand-vs-
    Auflösungs-Vergleich im Aufrufer.

    Rückgabe: footprint-dict oder None bei fehlenden Stamm-Faces."""
    Vt = np.asarray(axes, dtype=float)
    stem_faces = np.concatenate([
        _region_faces(main_face_mask, cluster_id, K_FRONT),
        _region_faces(main_face_mask, cluster_id, K_BACK),
    ])
    if len(stem_faces) == 0:
        return None
    v_ids = np.unique(mesh.faces[stem_faces])
    Vraw = mesh.vertices[v_ids]
    Vc = Vraw - mesh.vertices.mean(0)
    z_world = Vraw[:, 2]
    if z_world.size < 2:
        return None
    # obere Hälfte (reiner Stamm, oberhalb eines möglichen Fundament-Sockels)
    z_lo, z_hi = z_world.min(), z_world.max()
    z_cut = z_lo + 0.50 * (z_hi - z_lo)
    sel = z_world >= z_cut
    if sel.sum() < 2:
        sel = np.ones_like(z_world, dtype=bool)
    x = (Vc[sel]) @ Vt[0]
    z_axis = (Vc[sel]) @ Vt[2]
    return {
        "length": float(np.ptp(x)),
        "width": float(np.ptp(z_axis)),
        "area": float(np.ptp(x) * np.ptp(z_axis)),
        "cx": float((x.min() + x.max()) * 0.5),
        "cz": float((z_axis.min() + z_axis.max()) * 0.5),
    }


def _internal_single_solid(mesh, axes, main_face_mask, cluster_id):
    """Stem<->foundation analysis when wall + footing are one solid.

    The K3 (-Vt[1]) face region is the foundation bottom (it IS the
    klassifizierte Bodenfläche -> das "am Fuss"-Kriterium ist implizit, kein
    getuntes Z-Band nötig). The stem footprint is the XY-projection of the
    lower stem (K4+K5). Returns the standard internal context dict.

    DEFINITION (Reset 2026-05-30, Rate-Heuristik-Rückbau): Ein Fundament
    unterscheidet sich von der blossen Boden-Face einer plain wall einzig
    durch den SEITLICHEN ÜBERSTAND entlang Vt[2] -- das L-/T-Profil ragt über
    den Stamm hinaus. Wir prüfen daher nur noch zwei PARAMETERFREIE bzw.
    AUFLÖSUNGSBASIERTE Prädikate, keine getunten Fraktions-Konstanten mehr:

      (b) shallow = z_extent_K3 < xy_extent_K3   (parameterfrei: eine Platte
          ist flacher als breit -- reine Geometrie, keine Konstante);
      (d) overhang_sum > tol, mit
          tol = K_OVERHANG_RES * median_edge_length(K3-Region).

    `tol` ist die Mess-/Tessellierungs-Unschärfe der K3-Region: ein Überstand
    zählt nur, wenn er GRÖSSER als die Längenskala ist, auf der das Mesh
    überhaupt aufgelöst ist. Damit ist die Schwelle aus Geometrie/Auflösung
    hergeleitet -- KEIN getunter Wert (frühere Schwellen: 20%-Z-Band,
    10%-K3-Area-Fraktion, 0.05*Wandlänge bzw. 0.02 m -- ALLE entfernt).

    `foundation_present = shallow AND (overhang_sum > tol)`. Wenn keines
    zutrifft -> `foundation_present=False`, `source` nennt das verfehlte
    Prädikat.
    """
    # Auflösungsbasierter Überstand-Faktor: ein Überstand muss mindestens
    # K_OVERHANG_RES Mess-Kantenlängen betragen, um nicht als
    # Tessellierungs-Rauschen zu gelten. k=2 => Überstand grösser als das
    # Doppelte der lokalen Auflösung (1 Kante reicht nicht, weil eine einzelne
    # Kante schon die Unschärfe-Skala IST). Geometrisch begründet, nicht getunt.
    K_OVERHANG_RES = 2.0

    k3 = _region_faces(main_face_mask, cluster_id, K_FOUND)
    k3_has_any = len(k3) > 0

    # Footprints werden in jedem Fall berechnet (fuer overhang-Test und die
    # spaeter ausgegebenen Metriken). Der Stamm-Footprint misst die obere
    # Wandhälfte (reiner Stamm oberhalb eines möglichen Fundament-Sockels).
    f_fp = _foundation_footprint_xy(mesh, k3, axes) if k3_has_any else None
    s_fp = _stem_footprint_xy(mesh, axes, cluster_id, main_face_mask)

    # Definierendes Kriterium: SEITLICHER ÜBERSTAND > auflösungsbasierte Toleranz.
    # K3 alleine reicht NICHT (plain wall hat trivial eine bottom-face); das
    # L-/T-Profil-Fundament ragt entlang Vt[2] über den Stamm hinaus.
    foundation_present = False
    gate_reason = "no_k3_faces" if not k3_has_any else "no_footing_detected"
    confidence_level = "niedrig"
    confidence_score = None
    overhang_sum = 0.0
    tol = None
    if k3_has_any:
        try:
            v_ids_k3 = np.unique(mesh.faces[k3])
            Vk3 = mesh.vertices[v_ids_k3]
            z_extent_k3 = float(Vk3[:, 2].max() - Vk3[:, 2].min())
            xy_extent = float(max(
                Vk3[:, 0].max() - Vk3[:, 0].min(),
                Vk3[:, 1].max() - Vk3[:, 1].min(),
            ))
            # (b) parameterfrei: Platte flacher als breit
            shallow = z_extent_k3 < xy_extent
            # (d) seitlicher Überstand entlang Vt[2] vs. auflösungsbasierte Tol.
            overhang_ok = False
            if f_fp is not None and s_fp is not None:
                f_half = f_fp["width"] * 0.5
                s_half = s_fp["width"] * 0.5
                overhang_neg = (s_fp["cz"] - s_half) - (f_fp["cz"] - f_half)
                overhang_pos = (f_fp["cz"] + f_half) - (s_fp["cz"] + s_half)
                overhang_sum = max(overhang_neg, 0.0) + max(overhang_pos, 0.0)
                mel = _median_edge_length(mesh, k3)
                if mel is None or mel <= 0:
                    # entartete Region -> keine belastbare Toleranz, nicht raten
                    tol = None
                    overhang_ok = False
                else:
                    # (P3) Die Mess-Unschärfe (K_OVERHANG_RES * median_edge) ist
                    # bei GROBER Tessellierung (z.B. 2 Dreiecke auf der Sohle)
                    # grösser als das ganze Bauteil -> ein realer Überstand wird
                    # fälschlich als Rauschen verworfen (false negative).
                    # Physikalische Schranke: die Mess-Unschärfe einer Kante kann
                    # nicht GRÖSSER sein als das kleinste reale Querschnitts-Mass,
                    # das wir überhaupt auflösen — die Stammbreite. Eine Toleranz
                    # jenseits der Stammbreite würde bedeuten "wir können einen
                    # Überstand von der Grösse des Stamms selbst nicht von Null
                    # unterscheiden", was geometrisch unsinnig ist. Wir deckeln
                    # die Toleranz daher bei der Stammbreite. Beides bleibt aus
                    # der Geometrie hergeleitet (Auflösung bzw. Stammbreite),
                    # KEIN getunter Absolut-Schwellwert.
                    res_tol = K_OVERHANG_RES * mel
                    stem_w = s_fp["width"] if s_fp is not None else None
                    if stem_w is not None and stem_w > 0:
                        tol = min(res_tol, stem_w)
                    else:
                        tol = res_tol
                    overhang_ok = overhang_sum > tol
            if shallow and overhang_ok:
                foundation_present = True
                gate_reason = None
                # Confidence aus dem Überstand-zu-Toleranz-Verhältnis:
                #   overhang_sum > 2*tol  (= > 4 median edges, unzweideutig
                #   über der Auflösung) -> "hoch";
                #   sonst knapp über tol  -> "niedrig".
                # Die Faktor-2-Stufe ist resolutions-relativ (Vielfaches von tol),
                # kein absoluter Tuning-Wert.
                if tol and tol > 0:
                    if overhang_sum > 2.0 * tol:
                        confidence_level = "hoch"
                        confidence_score = 0.9
                    else:
                        confidence_level = "niedrig"
                        confidence_score = 0.4
            else:
                fails = []
                if not shallow:
                    fails.append("z_extent_>=_xy_extent")
                if not overhang_ok:
                    fails.append("overhang_<=_resolution_tol")
                gate_reason = "no_footing_detected:" + ",".join(fails)
        except Exception as e:
            sys.stderr.write(f"[context.L5] foundation-gate failed: "
                             f"{type(e).__name__}: {e}\n")
            foundation_present = False
            gate_reason = f"gate_error:{type(e).__name__}"

    out = {
        "foundation_present": bool(foundation_present),
        "source": ("single_solid_k3" if foundation_present
                   else (gate_reason or "no_footing_detected")),
        "confidence_level": confidence_level,
        "confidence_score": confidence_score,
        "overhang_tolerance_m": (float(tol) if tol is not None else None),
        "foundation_overhang_left_m": None,
        "foundation_overhang_right_m": None,
        "stem_centered_on_foundation": None,
        "shared_interface_area_m2": None,
        "foundation_to_stem_volume_ratio": None,
        # Footprint-Skalare nur ausgeben wenn das Gate die K3-Region als
        # Fundament akzeptiert hat (sonst irrefuehrend bei plain walls).
        "foundation_footprint_m2": (f_fp["area"]
                                    if (foundation_present and f_fp) else None),
        "stem_footprint_m2": (s_fp["area"] if s_fp else None),
        "stem_over_foundation_ratio": None,
    }

    # Wenn kein Fundament erkannt, restliche L5-Metriken bleiben None.
    if not foundation_present or f_fp is None or s_fp is None:
        return out

    # Overhangs: how far does the foundation reach beyond the stem on each
    # side along Vt[2] (the thickness axis)?
    f_half = f_fp["width"] * 0.5
    s_half = s_fp["width"] * 0.5
    f_center = f_fp["cz"]
    s_center = s_fp["cz"]
    # foundation extends from (f_center - f_half) to (f_center + f_half)
    # stem extends from (s_center - s_half) to (s_center + s_half)
    overhang_neg = (s_center - s_half) - (f_center - f_half)  # foundation past stem on -Vt[2]
    overhang_pos = (f_center + f_half) - (s_center + s_half)  # foundation past stem on +Vt[2]
    out["foundation_overhang_left_m"] = float(max(overhang_neg, 0.0))
    out["foundation_overhang_right_m"] = float(max(overhang_pos, 0.0))

    # stem centered on foundation: difference of stem and foundation z-center
    # within 10% of foundation width.
    # DEKLARIERTE Mess-Toleranz (kein Rate-Wert): die `0.10`-Schwelle ist das
    # Toleranzband, ab dem ein Versatz als "nicht mehr zentriert" gilt -- ein
    # Anzeige-Attribut, KEINE Ja/Nein-Fundament-Entscheidung (die fällt einzig
    # über den Überstand). Bewusst grosszügig, weil Stamm-/Fundament-Mittelpunkt
    # tessellierungs-verrauscht sind.
    center_offset = abs(s_center - f_center)
    out["stem_centered_on_foundation"] = bool(
        f_fp["width"] > 1e-6 and center_offset <= 0.10 * f_fp["width"]
    )

    # shared interface area: approximate by min(foundation_footprint,
    # stem_footprint) - simple, defensible.
    try:
        out["shared_interface_area_m2"] = float(
            min(f_fp["area"], s_fp["area"]) if f_fp["area"] > 0 else 0.0
        )
    except Exception:
        pass

    if s_fp["area"] > 1e-9:
        out["stem_over_foundation_ratio"] = float(s_fp["area"] / max(f_fp["area"], 1e-9))

    return out


def _internal_pair(wall_mesh, axes, footing_mesh):
    """Same metrics but from a pair of meshes (separate IfcFooting product)."""
    try:
        Vt = np.asarray(axes, dtype=float)
        Vw = wall_mesh.vertices - wall_mesh.vertices.mean(0)
        Vf = footing_mesh.vertices - wall_mesh.vertices.mean(0)
        fx = Vf @ Vt[0]
        fz = Vf @ Vt[2]
        sx = Vw @ Vt[0]
        sz_axis = Vw @ Vt[2]
        # Restrict stem to its lower 30 %. (Anders als _stem_footprint_xy, das
        # die OBERE Hälfte misst, weil dort das Fundament am Stamm angeschmolzen
        # ist; hier ist wall_mesh bereits der reine Stamm — der Überstand zählt
        # an der UNTEREN Stamm/Fundament-Schnittstelle.)
        sz_world = wall_mesh.vertices[:, 2]
        lo, hi = sz_world.min(), sz_world.max()
        cut = lo + 0.30 * (hi - lo)
        msk = sz_world <= cut
        if msk.any():
            sx = sx[msk]; sz_axis = sz_axis[msk]
        f_w = float(np.ptp(fz)); s_w = float(np.ptp(sz_axis))
        f_a = float(np.ptp(fx) * np.ptp(fz))
        s_a = float(np.ptp(sx) * np.ptp(sz_axis))
        f_center = float((fz.min() + fz.max()) * 0.5)
        s_center = float((sz_axis.min() + sz_axis.max()) * 0.5)
        f_half = f_w * 0.5
        s_half = s_w * 0.5
        oh_neg = (s_center - s_half) - (f_center - f_half)
        oh_pos = (f_center + f_half) - (s_center + s_half)
        return {
            "foundation_present": True,
            "source": "paired_footing_product",
            # Separates IfcFooting-Produkt = unzweideutiger Fundament-Beleg
            # (eigene IFC-Entität), daher hohe Confidence.
            "confidence_level": "hoch",
            "confidence_score": 1.0,
            "foundation_overhang_left_m": float(max(oh_neg, 0.0)),
            "foundation_overhang_right_m": float(max(oh_pos, 0.0)),
            "stem_centered_on_foundation": bool(
                f_w > 1e-6 and abs(s_center - f_center) <= 0.10 * f_w),
            "shared_interface_area_m2": float(min(f_a, s_a)),
            "foundation_to_stem_volume_ratio": (
                float(abs(footing_mesh.volume) / max(abs(wall_mesh.volume), 1e-9))
                if footing_mesh.is_volume and wall_mesh.is_volume else None),
            "foundation_footprint_m2": f_a,
            "stem_footprint_m2": s_a,
            "stem_over_foundation_ratio": float(s_a / max(f_a, 1e-9)),
        }
    except Exception as e:
        sys.stderr.write(f"[context.L5] paired-footing-fallback: "
                         f"{type(e).__name__}: {e}\n")
        return {
            "foundation_present": True,
            "source": "paired_footing_product",
            "confidence_level": "hoch",
            "confidence_score": 1.0,
            "foundation_overhang_left_m": None,
            "foundation_overhang_right_m": None,
            "stem_centered_on_foundation": None,
            "shared_interface_area_m2": None,
            "foundation_to_stem_volume_ratio": None,
        }


def _find_paired_footing(wall_mesh, products, offset=None):
    """Find an IfcFooting whose XY-bbox overlaps the wall and sits below it.

    `wall_mesh` is the per-scene-centred mesh (translated by ``-offset`` in
    `ifcinspect._prep_wall`). `products` carry their *world-coord* meshes.
    To compare in a consistent frame we shift the wall bounds back into world
    coordinates by ``+offset`` before testing XY-overlap / Z-adjacency.
    """
    if not products:
        return None
    off = np.zeros(3) if offset is None else np.asarray(offset, dtype=np.float64)
    wb = wall_mesh.bounds + off                                  # -> world frame
    best = None
    for p in products:
        if not (p.ifc_type in _FOOTING_TYPES
                or (p.name and "fundament" in (p.name or "").lower())):
            continue
        try:
            pb = p.mesh.bounds
        except Exception:
            continue
        # XY overlap (world)
        if (pb[1, 0] <= wb[0, 0] or pb[0, 0] >= wb[1, 0]
                or pb[1, 1] <= wb[0, 1] or pb[0, 1] >= wb[1, 1]):
            continue
        # Z-adjacency: the footing top must sit near the wall bottom.
        # (P4) Die frühere FIXE +-0.5 m-Schranke verwarf reale Paare, sobald
        # eine Sauberkeitsschicht / ein Modellier-Versatz > 0.5 m zwischen
        # Fundament-Oberkante und Wand-Unterkante lag. Die vertikale Toleranz
        # wird stattdessen aus der GEOMETRIE abgeleitet: die natürliche
        # vertikale Längenskala der Fundamentzone ist die FUNDAMENT-HÖHE
        # (Z-Ausdehnung des Footings). Ein bauüblicher Versatz (Magerbeton,
        # Sauberkeitsschicht) skaliert mit der Bauteil-Grösse, nicht mit einer
        # absoluten Konstante. Damit toleriert ein 0.5 m-Footing ~0.5 m Spalt,
        # ein 1.5 m-Footing entsprechend mehr — proportional, KEIN getunter
        # Absolut-Schwellwert. Ein flacher Slab erhält eine entsprechend enge
        # Toleranz (er liegt per Definition direkt unter der Wand, also nahezu
        # ohne Z-Spalt) — das ist geometrisch korrekt, kein Sonderfall.
        foot_h = float(pb[1, 2] - pb[0, 2])
        z_tol = foot_h
        wall_bottom = wb[0, 2]
        # footing top too far BELOW wall bottom (gap exceeds a footing height)?
        if pb[1, 2] < wall_bottom - z_tol:
            continue
        # footing bottom floats ABOVE wall bottom (footing not under the wall)?
        if pb[0, 2] > wall_bottom + z_tol:
            continue
        best = p
        break
    return best


def internal_context(wall_mesh, axes, main_face_mask, cluster_id,
                     scene_products=None, wall_guid=None, offset=None):
    """L5: stem <-> foundation analysis.

    `scene_products`: list[LoadedProduct] (full scene, optional). When given
    and an IfcFooting is found that pairs with this wall, the paired-mesh path
    is used. Otherwise single-solid heuristic.

    `offset`: per-scene centring offset (numpy[3] world->centred translation).
    The pipeline pre-translates each wall by ``-offset`` (see
    `ifcinspect._prep_wall`). The footing products kept their world
    coordinates, so we mirror that offset when locating the paired footing
    AND when feeding its mesh into `_internal_pair`, which assumes both
    inputs live in the same frame as `wall_mesh`.

    Returns dict with the spec'd keys; values None if not determinable."""
    try:
        # Try paired footing first when scene info available
        if scene_products:
            footing = _find_paired_footing(
                wall_mesh,
                [p for p in scene_products
                 if not wall_guid or getattr(p, "guid", None) != wall_guid],
                offset=offset)
            if footing is not None:
                # Bring footing into the same centred frame as wall_mesh.
                off = (np.zeros(3) if offset is None
                       else np.asarray(offset, dtype=np.float64))
                f_mesh = footing.mesh.copy()
                if np.any(off):
                    f_mesh.apply_translation(-off)
                return _internal_pair(wall_mesh, axes, f_mesh)
        return _internal_single_solid(wall_mesh, axes, main_face_mask, cluster_id)
    except Exception as e:
        sys.stderr.write(f"[context.L5] failed: {type(e).__name__}: {e}\n")
        return {
            "foundation_present": False,
            "source": "error",
            "confidence_level": "niedrig",
            "confidence_score": None,
            "foundation_overhang_left_m": None,
            "foundation_overhang_right_m": None,
            "stem_centered_on_foundation": None,
            "shared_interface_area_m2": None,
            "foundation_to_stem_volume_ratio": None,
        }


# --------------------------------------------------------------------------- #
#  L6 - external context (air vs earth side)
# --------------------------------------------------------------------------- #
def _terrain_mesh(scene_products):
    """Return a single trimesh built from concatenated terrain products,
    or None if no terrain product present."""
    if not scene_products:
        return None
    meshes = [p.mesh for p in scene_products
              if p.ifc_type in _TERRAIN_TYPES and len(getattr(p.mesh, "faces", [])) > 0]
    if not meshes:
        return None
    try:
        return trimesh.util.concatenate(meshes)
    except Exception as e:
        sys.stderr.write(f"[context.L6] terrain concat failed: "
                         f"{type(e).__name__}: {e}\n")
        return None


def _face_class_label(ci):
    return {0: "K0", 1: "K1", 2: "K2", 3: "K3", 4: "K4", 5: "K5"}.get(int(ci), "?")


def _face_centroids_for_class(mesh, main_face_mask, cluster_id, ci, max_samples=200):
    """Return sampled face centroids for class `ci` (subsample for speed)."""
    faces = _region_faces(main_face_mask, cluster_id, ci)
    if len(faces) == 0:
        return None
    if len(faces) > max_samples:
        idx = np.linspace(0, len(faces) - 1, max_samples).astype(int)
        faces = faces[idx]
    return mesh.triangles_center[faces]


_UNDETERMINED = "unbestimmt"


def _cap_mesh_faces(mesh, max_faces):
    """Reduce a mesh to <= max_faces via a strided face subsample (remapped to
    only the referenced vertices), so the downstream cKDTree build stays
    memory-bounded on huge DTMs (a multi-million-face terrain otherwise OOMs the
    WASM heap already at index-build time). Returns the mesh unchanged when it is
    already small (-> exact) or on any failure. Keeps the surface as a real,
    sparser mesh, so point-to-surface distance stays accurate enough for the
    relative air/earth comparison."""
    try:
        F = np.asarray(mesh.faces)
        V = np.asarray(mesh.vertices, dtype=float)
        if F.ndim != 2 or len(F) <= max_faces:
            return mesh
        step = int(np.ceil(len(F) / max_faces))
        Fs = F[::step]
        used = np.unique(Fs)
        remap = np.full(len(V), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        return trimesh.Trimesh(vertices=V[used], faces=remap[Fs], process=False)
    except Exception:
        return mesh


def _main_face_vertices(mesh, main_face_mask, cluster_id, ci):
    """Welt-/Frame-rohe Vertices ALLER Hauptflaechen-Faces der Klasse `ci`.

    Im Gegensatz zu `_face_centroids_for_class` (subgesampelte Dreiecks-
    Schwerpunkte) liefert dies die ECKPUNKTE der Faces — fuer den Beruehrungs-
    Test (Min-Distanz, ~0 bei Kontakt) sind die Vertices die schaerferen
    Stuetzstellen als die Centroide. Defensiv: keine Faces -> None."""
    faces = _region_faces(main_face_mask, cluster_id, ci)
    if len(faces) == 0:
        return None
    try:
        v_ids = np.unique(mesh.faces[faces])
        return mesh.vertices[v_ids]
    except Exception:
        return None


def _terrain_touch_side(wall_mesh, main_face_mask, cluster_id, terrain,
                        median_edge, offset=None):
    """Beruehrungs-/Naehe-basierte Erd-/Luftseiten-Bestimmung (RAY-FREI).

    Verfahren (cKDTree der Terrain-Vertices, wie das height_local-Muster in
    metrics.py — je Wand-Hauptflaechen-Vertex die naechste Terrain-Vertex-
    Distanz): die Seite K4/K5 mit der KLEINEREN Min-Distanz zum Terrain ist die
    ERDSEITE (Beruehrung => ~0), die Gegenseite die LUFTSEITE.

    FRAME-GOTCHA: `wall_mesh` ist im Pipeline-Pass um `-offset` zentriert (siehe
    ifcinspect._prep_wall), die Terrain-Produkte tragen WELT-Koordinaten.
    Wir verschieben die Terrain-Vertices daher um `-offset` in denselben
    zentrierten Frame wie die Wand, bevor der cKDTree gebaut wird (sonst landet
    die Distanz bei georeferenzierten LV95-Modellen Mio. m daneben).

    `median_edge` (Mess-/Tessellierungs-Skala der Wand) liefert die
    auflösungsbasierte Toleranz: Erd-Seite gilt als „eindeutig berührt", wenn
    ihre Min-Distanz < tol = K_TOUCH_RES * median_edge UND die Luftseite
    deutlich weiter entfernt ist (Differenz > tol bzw. Verhaeltnis-Schwelle).

    Returns dict {earth_ci, air_ci, earth_min_m, air_min_m, side_clear,
    side_source} oder None, wenn keine der Seiten Faces hat.
    """
    # Auflösungsbasierte Beruehrungs-Toleranz: ein Vertex „beruehrt" das Terrain,
    # wenn seine Min-Distanz unter der HALBEN lokalen Mess-Kantenlaenge liegt —
    # also innerhalb der Tessellierungs-Unschaerfe von echtem Kontakt (eine Kante
    # IST die Aufloesungs-Skala; eine halbe Kante ist klar „auf der Oberflaeche").
    # Aus der Geometrie hergeleitet, KEIN getunter Absolut-Schwellwert.
    K_TOUCH_RES = 0.5
    # Trennungs-Faktor der Luftseite: sie gilt als „deutlich weiter" weg, wenn sie
    # mindestens das DOPPELTE der Erd-Seiten-Distanz (bzw. eines Aufloesungs-
    # Bodens) misst. Resolutions-relatives Vielfaches, kein Absolut-Wert.
    K_AIR_RATIO = 2.0
    try:
        if terrain is None or len(getattr(terrain, "vertices", [])) == 0:
            return None
        tv = np.asarray(terrain.vertices, dtype=float)
        if offset is not None:
            off = np.asarray(offset, dtype=np.float64)
            if np.any(off):
                tv = tv - off            # Terrain in den zentrierten Wand-Frame
        from scipy.spatial import cKDTree
        ttree = cKDTree(tv)

        mins = {}
        for ci in (K_FRONT, K_BACK):
            V = _main_face_vertices(wall_mesh, main_face_mask, cluster_id, ci)
            if V is None or len(V) == 0:
                mins[ci] = None
                continue
            d, _ = ttree.query(V)
            mins[ci] = float(np.min(d)) if len(d) else None

        d_front = mins.get(K_FRONT)
        d_back = mins.get(K_BACK)
        if d_front is None and d_back is None:
            return None
        # genau eine Seite hat Faces -> diese ist (mangels Alternative) Erd-,
        # aber NICHT eindeutig (keine Gegenseite zum Vergleich).
        if d_front is None:
            return {"earth_ci": K_BACK, "air_ci": K_FRONT,
                    "earth_min_m": d_back, "air_min_m": None,
                    "side_clear": False, "side_source": "terrain_touch"}
        if d_back is None:
            return {"earth_ci": K_FRONT, "air_ci": K_BACK,
                    "earth_min_m": d_front, "air_min_m": None,
                    "side_clear": False, "side_source": "terrain_touch"}

        # BEIDSEITIG Terrain: liegt auf BEIDEN Wandseiten Gelände (Halbraum-Split an
        # der Wand-Mittelebene → jede Seite hat eigenes Terrain in der Nähe), ist die
        # reine Min-Distanz mehrdeutig und wählt teils die FALSCHE Erdseite. Dann
        # entscheidet der VERTIKALE Abstand Terrain↔Wand-UK: die Seite mit dem
        # GRÖSSEREN durchschnittlichen Vertikalabstand (Terrain reicht höher an der
        # Wand hoch → mehr zurückgehaltener Boden) ist die ERDSEITE. Greift auch,
        # wenn das Terrain die Wand NICHT berührt (grob trianguliert/versetzt) —
        # NICHT mehr an die Berührungs-Toleranz gebunden.
        wv = np.asarray(wall_mesh.vertices, dtype=float)
        uk_z = float(np.min(wv[:, 2]))                   # Wand-Unterkante (vertikal = Z)
        wall_h = float(np.ptp(wv[:, 2])) or 1.0
        Vf = _main_face_vertices(wall_mesh, main_face_mask, cluster_id, K_FRONT)
        Vb = _main_face_vertices(wall_mesh, main_face_mask, cluster_id, K_BACK)
        vf = vb = None
        nft = nbt = 0
        if Vf is not None and Vb is not None and len(Vf) and len(Vb):
            # Terrain je Seite TRENNEN an der Wand-Mittelebene (Normale = Dicken-
            # Achse Front→Back). So sieht jede Seite nur ihr EIGENES Terrain; sonst
            # greift bei tiefen Face-Vertices das nähere Gegenseiten-Terrain.
            cf = Vf.mean(axis=0); cb = Vb.mean(axis=0)
            axis = cf - cb
            nrm = float(np.linalg.norm(axis))
            if nrm > 1e-9:
                axis = axis / nrm
                side = (tv - 0.5 * (cf + cb)) @ axis
                front_t = tv[side > 0.0]
                back_t = tv[side < 0.0]
                nft = int(len(front_t)); nbt = int(len(back_t))
                n_tot = max(1, len(tv))
                # „Seite hat Terrain": genug eigene Vertices UND das nächste davon
                # nahe genug an der Wandfläche (verwirft Streu-Vertices einer rein
                # einseitigen Geländeschürze, die knapp über die Mittelebene ragt).
                near_cap = max(3.0, 3.0 * wall_h)
                min_pts = max(4, int(0.02 * n_tot))

                def _side_terrain(Vq, Tq):
                    if Vq is None or len(Vq) == 0 or len(Tq) < min_pts:
                        return None
                    d, qi = cKDTree(Tq).query(Vq)
                    if float(np.min(d)) > near_cap:
                        return None
                    return float(np.mean(Tq[qi, 2])) - uk_z   # Ø Terrainhöhe über UK

                vf = _side_terrain(Vf, front_t)
                vb = _side_terrain(Vb, back_t)
        has_f = vf is not None
        has_b = vb is not None
        if has_f and has_b:
            # BEIDSEITIG Terrain. Erdseite-Pick = HÖHERES Terrain (User-Heuristik:
            # grösserer Vertikalabstand Terrain↔UK). Bei ~gleicher Höhe (z. B. am
            # Fuss berührendes, wegsteigendes Terrain) entscheidet die Terrain-MASSE
            # (Seite mit mehr Gelände = Erdseite). Eindeutig, wenn Höhe ODER Masse
            # die Seiten klar trennt.
            if abs(vf - vb) > 1e-3:
                front_is_earth = vf > vb
            else:
                front_is_earth = nft >= nbt
            if front_is_earth:
                earth_ci, air_ci, earth_v, air_v, n_e, n_a = K_FRONT, K_BACK, vf, vb, nft, nbt
            else:
                earth_ci, air_ci, earth_v, air_v, n_e, n_a = K_BACK, K_FRONT, vb, vf, nbt, nft
            h_clear = (earth_v - air_v) > max(0.2, 0.1 * wall_h)
            mass_clear = n_e >= 2 * max(1, n_a)
            side_clear = bool(h_clear or mass_clear)
            return {"earth_ci": earth_ci, "air_ci": air_ci,
                    "earth_min_m": mins[earth_ci], "air_min_m": mins[air_ci],
                    "earth_terrain_rise_m": earth_v, "air_terrain_rise_m": air_v,
                    "side_clear": side_clear, "side_source": "terrain_vertical"}
        if has_f or has_b:
            # EINSEITIG Terrain → die Seite, auf der das Gelände PHYSISCH LIEGT
            # (Halbraum-Split), ist die Erdseite. Robuster als die Min-Distanz, die
            # bei GEKRÜMMTEN Wänden die falsche Seite wählen kann (innere/äussere
            # Faces liegen je nach Krümmung näher/ferner als die Geländeseite).
            if has_f:
                earth_ci, air_ci = K_FRONT, K_BACK
            else:
                earth_ci, air_ci = K_BACK, K_FRONT
            return {"earth_ci": earth_ci, "air_ci": air_ci,
                    "earth_min_m": mins[earth_ci], "air_min_m": mins[air_ci],
                    "side_clear": True, "side_source": "terrain_side"}
        # KEINE Seite mit klarem Terrain → Rückfall auf Min-Distanz.

        if d_front <= d_back:
            earth_ci, air_ci = K_FRONT, K_BACK
            earth_min, air_min = d_front, d_back
        else:
            earth_ci, air_ci = K_BACK, K_FRONT
            earth_min, air_min = d_back, d_front

        # Eindeutigkeit: Erd-Seite muss das Terrain BERUEHREN (Min-Distanz unter
        # der Tessellierungs-Unschaerfe-Schwelle tol = K_TOUCH_RES*median_edge)
        # UND die Luftseite muss DEUTLICH weiter weg sein (mindestens das
        # K_AIR_RATIO-fache der Erd-Distanz bzw. eines Aufloesungs-Bodens, damit
        # die Schwelle bei perfektem Kontakt earth_min~0 nicht durch 0 dividiert).
        # Beide Schwellen aus median_edge (Aufloesung) hergeleitet, keine Absoluten.
        side_clear = False
        if median_edge is not None and median_edge > 0:
            tol = K_TOUCH_RES * float(median_edge)
            floor = max(earth_min, 0.1 * float(median_edge))
            side_clear = bool(earth_min < tol and air_min > K_AIR_RATIO * floor)
        return {"earth_ci": earth_ci, "air_ci": air_ci,
                "earth_min_m": earth_min, "air_min_m": air_min,
                "side_clear": side_clear, "side_source": "terrain_touch"}
    except Exception as e:
        sys.stderr.write(f"[context.L6] terrain-touch side failed: "
                         f"{type(e).__name__}: {e}\n")
        return None


def _uk_below_terrain(wall_mesh, axes, main_face_mask, cluster_id, terrain,
                      offset=None):
    """L7-Einbindetiefe „UK unter Terrain" (RAY-FREI, height_local-Muster).

    Je Wand-Unterkante-Punkt (K3-Hauptflaechen-Vertices) wird die horizontal
    NAECHSTE Terrain-Stelle gesucht (2D-cKDTree in der Horizontalebene
    Vt[0]xVt[2]) und die vertikale Differenz Terrain_Z - UK_Z entlang der
    Hoehenachse Vt[1] gebildet. POSITIV = die Wand-Unterkante liegt UNTER dem
    Terrain (eingebunden). Nur Punkte, ueber denen ueberhaupt Terrain liegt
    (Differenz > 0), gehen in min/max ein.

    FRAME: wie `_terrain_touch_side` — Terrain um `-offset` in den zentrierten
    Wand-Frame schieben, sonst sind Distanz/Hoehe bei LV95 unbrauchbar.

    Returns (min_m, max_m) ueber die K3-Punkte oder (None, None), wenn kein
    Terrain / kein K3 / keine Punkte mit Terrain darueber.
    """
    try:
        if terrain is None or len(getattr(terrain, "vertices", [])) == 0:
            return None, None
        V_uk = _main_face_vertices(wall_mesh, main_face_mask, cluster_id, K_FOUND)
        if V_uk is None or len(V_uk) == 0:
            return None, None
        tv = np.asarray(terrain.vertices, dtype=float)
        if offset is not None:
            off = np.asarray(offset, dtype=np.float64)
            if np.any(off):
                tv = tv - off
        Vt = np.asarray(axes, dtype=float)
        up = Vt[1] / (np.linalg.norm(Vt[1]) + 1e-12)     # Hoehenachse (Welt-Z)
        h0 = Vt[0] / (np.linalg.norm(Vt[0]) + 1e-12)     # horizontale Laengsachse
        h2 = Vt[2] / (np.linalg.norm(Vt[2]) + 1e-12)     # horizontale Querachse

        uk2 = np.column_stack([V_uk @ h0, V_uk @ h2])    # UK-Punkte horizontal
        t2 = np.column_stack([tv @ h0, tv @ h2])         # Terrain-Punkte horizontal
        uk_z = V_uk @ up
        t_z = tv @ up
        from scipy.spatial import cKDTree
        _, idx = cKDTree(t2).query(uk2)                  # je UK-Punkt naechste Terrain-Stelle
        below = t_z[idx] - uk_z                           # Terrain_Z - UK_Z; + = UK unter Terrain
        below = below[np.isfinite(below) & (below > 1e-6)]
        if below.size == 0:
            return None, None
        return float(below.min()), float(below.max())
    except Exception as e:
        sys.stderr.write(f"[context.L7] uk-below-terrain failed: "
                         f"{type(e).__name__}: {e}\n")
        return None, None


def external_context(wall_mesh, axes, main_face_mask, cluster_id,
                     scene_products=None, offset=None):
    """L6: decide which wall face is air-side vs earth-side.

    With terrain: median perpendicular distance from sample centroids to the
    terrain mesh, per class K4 / K5. Smaller distance -> earth side. This is
    the ONLY geometrically grounded path -> `confidence_level="hoch"`.

    Without terrain (no IfcSite/IfcGeographicElement in scene) OR if both
    face<->terrain distances are not computable: the air/earth assignment is
    geometrically NOT determinable. We DO NOT guess a convention anymore.
    Instead both classes become "unbestimmt", `classification_source` is
    "kein_terrain" resp. "terrain_distanz_unbestimmbar", and
    `confidence_level="niedrig"`. Distance fields stay None.

    Returns dict per spec (with additional `confidence_level`,
    `confidence_score`). The legacy `inferred` flag is kept for backward
    compatibility: True iff the side could NOT be measured from terrain.

    ADDITIV (2026-06-02): zusaetzlich zur (median-distanz-basierten) Legacy-
    Bestimmung von air_/earth_side_face_class wird die Seite RAY-FREI ueber
    BERUEHRUNG/NAEHE zum Terrain bestimmt (cKDTree der Terrain-Vertices, die
    Seite mit der kleineren Min-Distanz = Erd). Ergebnis in den NEUEN Feldern
    `earth_side_face_class`/`air_side_face_class` werden NUR ueberschrieben,
    wenn die Beruehrungs-Bestimmung greift (sonst bleiben die Legacy-Werte);
    `side_source`/`side_clear` dokumentieren die Quelle/Eindeutigkeit.
    Zusaetzlich `uk_below_terrain_min_m/_max_m` (L7-Einbindetiefe). `offset`
    (per-scene-Zentrierungs-Offset) wird gebraucht, um die WELT-Terrain-Vertices
    in den zentrierten Wand-Frame zu schieben; ohne ihn bleiben die neuen
    Touch-/Einbinde-Felder None (Frame-Mismatch -> kein Rate-Wert).
    """
    out = {
        "air_side_face_class": None,
        "earth_side_face_class": None,
        "terrain_present": False,
        "terrain_median_distance_air_m": None,
        "terrain_median_distance_earth_m": None,
        "classification_source": "kein_terrain",
        "inferred": True,
        "confidence_level": "niedrig",
        "confidence_score": None,
        # ADDITIV (Touch-/Naehe-basierte Seitenbestimmung + L7-Einbindetiefe).
        # `side_source`: 'terrain_touch' wenn ueber Beruehrung bestimmt, sonst
        # 'unbestimmt' (kein Terrain / nicht eindeutig / kein offset).
        "side_source": "unbestimmt",
        "side_clear": False,
        "uk_below_terrain_min_m": None,
        "uk_below_terrain_max_m": None,
    }
    try:
        terrain = _terrain_mesh(scene_products)
        if terrain is None or len(getattr(terrain, "faces", [])) == 0:
            # KEIN Terrain -> Luft-/Erdseite ohne Bezugsflaeche nicht bestimmbar.
            # Ehrliche Deklaration statt Konventions-Rate (frueher K4=Luft/
            # K5=Erde, inferred=true). Das ist die korrekte geometrische Aussage.
            out["air_side_face_class"] = _UNDETERMINED
            out["earth_side_face_class"] = _UNDETERMINED
            out["classification_source"] = "kein_terrain"
            out["confidence_level"] = "niedrig"
            return out

        out["terrain_present"] = True
        # Grosses DGM auf handhabbare Face-Zahl reduzieren, BEVOR der cKDTree
        # gebaut wird (Tree-Build selbst ist O(Faces)). Kleine Terrains bleiben
        # unveraendert -> exakt.
        terrain = _cap_mesh_faces(terrain, 250000)

        # ----- ADDITIV: Beruehrungs-/Naehe-basierte Seitenbestimmung + L7-
        # Einbindetiefe. Komplett gekapselt; ein Fehler hier veraendert KEINEN
        # der bestehenden median-distanz-Felder. Die Touch-Bestimmung der Seite
        # hat Vorrang vor der Median-Bestimmung (Beruehrung ~0 ist das
        # eindeutigere Kriterium); sie greift nur, wenn `offset` vorliegt (sonst
        # Frame-Mismatch -> kein Rate-Wert).
        touch = None
        try:
            mel = _median_edge_length(wall_mesh, np.arange(len(wall_mesh.faces)))
            touch = _terrain_touch_side(wall_mesh, main_face_mask, cluster_id,
                                        terrain, mel, offset=offset)
            if touch is not None:
                out["side_source"] = touch.get("side_source", "terrain_touch")
                out["side_clear"] = bool(touch.get("side_clear", False))
            uk_min, uk_max = _uk_below_terrain(
                wall_mesh, axes, main_face_mask, cluster_id, terrain,
                offset=offset)
            out["uk_below_terrain_min_m"] = uk_min
            out["uk_below_terrain_max_m"] = uk_max
        except Exception as e:
            sys.stderr.write(f"[context.L6] additive touch/uk failed: "
                             f"{type(e).__name__}: {e}\n")

        # EXAKTE Punkt->Fläche-Distanz, aber memory-safe: distances.surface_
        # distances nutzt einen cKDTree-Centroid-Prune (nur Kandidaten-Dreiecke
        # pro Punkt) statt trimesh.proximity.closest_point auf dem vollen DTM.
        # Letzteres allokiert O(Faces) und sprengt bei grossen DGM den WASM-Heap
        # (MemoryError -> Modell laedt nicht durch). Ergebnis = identischer Median
        # der Flaechendistanzen wie zuvor, nur ohne die O(Faces)-Allokation.
        per_class = {}
        for ci in (K_FRONT, K_BACK):
            cs = _face_centroids_for_class(wall_mesh, main_face_mask, cluster_id, ci)
            if cs is None or len(cs) == 0:
                per_class[ci] = None
                continue
            try:
                dists = distances.surface_distances(terrain, cs)
                per_class[ci] = (float(np.median(np.abs(dists)))
                                 if dists is not None and len(dists) else None)
            except Exception as e:
                sys.stderr.write(f"[context.L6] surface distance failed for K{ci}: "
                                 f"{type(e).__name__}: {e}\n")
                per_class[ci] = None

        d_front = per_class.get(K_FRONT)
        d_back = per_class.get(K_BACK)
        if d_front is None and d_back is None:
            # Terrain da, aber Distanzen nicht ermittelbar (keine K4/K5-Flaechen
            # oder closest_point gescheitert) -> ebenfalls unbestimmt, NICHT raten.
            out["air_side_face_class"] = _UNDETERMINED
            out["earth_side_face_class"] = _UNDETERMINED
            out["classification_source"] = "terrain_distanz_unbestimmbar"
            out["confidence_level"] = "niedrig"
            return out

        # terrain-gemessen: smaller distance to terrain = earth side
        out["classification_source"] = "terrain"
        out["inferred"] = False
        out["confidence_level"] = "hoch"
        out["confidence_score"] = 1.0
        if d_front is not None and (d_back is None or d_front <= d_back):
            earth_ci = K_FRONT; air_ci = K_BACK
        else:
            earth_ci = K_BACK; air_ci = K_FRONT
        # Touch-Bestimmung (Beruehrung ~0) hat Vorrang vor der Median-Distanz,
        # wenn sie greift (offset vorhanden, beide Seiten vergleichbar). Sie ist
        # das schaerfere Kriterium fuer „welche Seite liegt am Terrain an".
        if touch is not None and touch.get("earth_ci") is not None:
            earth_ci = touch["earth_ci"]; air_ci = touch["air_ci"]
        out["earth_side_face_class"] = _face_class_label(earth_ci)
        out["air_side_face_class"] = _face_class_label(air_ci)
        out["terrain_median_distance_earth_m"] = per_class.get(earth_ci)
        out["terrain_median_distance_air_m"] = per_class.get(air_ci)
        return out
    except Exception as e:
        sys.stderr.write(f"[context.L6] failed: {type(e).__name__}: {e}\n")
        return out


def _road_products(scene_products):
    """Strassen-Elemente per IFC-Klasse ODER Namens-Heuristik (mit Geometrie)."""
    if not scene_products:
        return []
    out = []
    for p in scene_products:
        t = getattr(p, "ifc_type", "") or ""
        nm = (getattr(p, "name", "") or "").lower()
        if t in _ROAD_TYPES or any(h in nm for h in _ROAD_NAME_HINTS):
            m = getattr(p, "mesh", None)
            if m is not None and len(getattr(m, "faces", [])) > 0:
                out.append(p)
    return out


def crown_drainage(wall_mesh, axes, main_face_mask, cluster_id,
                   external, scene_products=None):
    """FHB-konforme Entwaesserungs-Zielseite der Mauerkrone (gestuft nach
    verfuegbarer Evidenz, sonst ehrlich unbestimmt).

    Prioritaet:
      1. Strasse als Element (IFC-Klasse/Name) -> Gefaelle WEG von der Strasse.
         Loest berg-/talseitig korrekt auf: bergseitig liegt die Strasse auf der
         Luftseite, talseitig auf der Erd-/Dammseite -> "weg von der Strasse"
         trifft beide Faelle.
      2. sonst Terrain/Erdseite (external/L6) -> Gefaelle ZUR Erdseite
         (FHB-Regelfall "gegen den Hang"). Die talseitige Ausnahme ist ohne
         Strasse nicht aufloesbar und als Limitation dokumentiert.
      3. sonst -> unbestimmt (die Richtungs-Regel wird dann uebersprungen).

    Returns dict {reference, drain_target_face_class, drain_target_ci,
    road_present, road_side_face_class}.
    """
    out = {
        "reference": "unbestimmt",
        "drain_target_face_class": None,
        "drain_target_ci": None,
        "road_present": False,
        "road_side_face_class": None,
    }
    try:
        Vt = np.asarray(axes, dtype=float)
        wall_c = np.asarray(wall_mesh.vertices, dtype=float).mean(0)
        roads = _road_products(scene_products)
        if roads:
            cents = [np.asarray(p.mesh.vertices, dtype=float).mean(0)
                     for p in roads
                     if len(getattr(p.mesh, "vertices", [])) > 0]
            if cents:
                road_c = np.mean(cents, axis=0)
                side = float((road_c - wall_c) @ Vt[2])
                road_ci = K_FRONT if side > 0 else K_BACK
                target_ci = K_BACK if road_ci == K_FRONT else K_FRONT
                out.update({
                    "reference": "road",
                    "road_present": True,
                    "road_side_face_class": _face_class_label(road_ci),
                    "drain_target_face_class": _face_class_label(target_ci),
                    "drain_target_ci": target_ci,
                })
                return out
        # Fallback: Erdseite/Hang aus L6 (FHB-Regelfall "gegen den Hang").
        earth = (external or {}).get("earth_side_face_class")
        if earth in ("K4", "K5"):
            target_ci = K_FRONT if earth == "K4" else K_BACK
            out.update({
                "reference": "hang",
                "drain_target_face_class": earth,
                "drain_target_ci": target_ci,
            })
    except Exception as e:
        sys.stderr.write(f"[context.crown_drainage] failed: "
                         f"{type(e).__name__}: {e}\n")
    return out


__all__ = ["internal_context", "external_context", "crown_drainage"]
