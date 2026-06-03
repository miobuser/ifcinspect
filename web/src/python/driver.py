"""Pyodide-side driver: bytes-only IFC entry point for IfcInspect.

Loaded once at startup by the Web Worker (see worker.ts). The IFC bytes
arrive as a Python ``bytes`` buffer via Pyodide's JS->Py bridge -- they
never touch disk and never leave the browser.

Pyodide-Kompatibilität (2026-05-29 Voxel-Path-Removal):
    Die Live-Pipeline kommt vollständig ohne native-only Wheels aus —
    ``pymeshfix``, ``manifold3d``, ``scikit-image`` und ``scipy.ndimage``
    sind aus dem Live-Pfad entfernt. Walls die nicht watertight sind
    werden mit ``prep_failed`` markiert und übersprungen (transparenter
    Skip statt Blackbox-Reparatur). Damit braucht der Pyodide-Worker
    keine Stub-Module mehr für diese Pakete.
"""

from __future__ import annotations

import json
import math
import os
import traceback


def _json_sanitize(obj):
    """Walk a nested dict/list/tuple and replace non-finite floats
    with ``None`` so ``json.dumps`` never emits the non-standard
    ``Infinity`` / ``NaN`` tokens (browser JSON.parse would reject)."""
    if hasattr(obj, "item") and not isinstance(obj, (bytes, bytearray, str)):
        try:
            if getattr(obj, "ndim", 0) == 0:
                obj = obj.item()
        except (TypeError, ValueError):
            pass
    if hasattr(obj, "tolist") and not isinstance(
        obj, (bytes, bytearray, str, dict, list, tuple)
    ):
        try:
            obj = obj.tolist()
        except (TypeError, ValueError):
            pass
    if isinstance(obj, float):
        if math.isinf(obj) or math.isnan(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Import the IfcInspect pipeline. Imports are deferred into a
# function so the worker can report a clear error if the wheel isn't
# installed yet.
# ---------------------------------------------------------------------------

_detect_imports_ready = False
_nd = None  # ifcinspect module
_ifc_io = None
_report = None


def _ensure_detect_imports():
    """Bind IfcInspect modules into globals (idempotent)."""
    global _detect_imports_ready, _nd, _ifc_io, _report
    if _detect_imports_ready:
        return
    try:
        import ifcinspect as _nd_  # noqa: N813
        import ifc_io as _ifc_io_  # noqa: N813
        try:
            import report as _report_  # noqa: N813
        except ImportError:
            _report_ = None
    except ImportError as exc:
        raise RuntimeError(
            "IfcInspect wheel not installed in this Pyodide runtime. "
            f"Original import error: {exc}"
        ) from exc
    _nd = _nd_
    _ifc_io = _ifc_io_
    _report = _report_
    _detect_imports_ready = True


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def _try_evaluate_rules(wm_list, scene_dict, rules_bytes: bytes | None):
    """Evaluate ASTRA-L4 rules per wall_metrics entry, return list aligned
    with ``wm_list``. Each entry is a list of check-dicts
    ({id,label,value,soll,status,einheit,...}) -- see report.apply_rules.
    Defensive: any import failure or evaluation crash falls back to [].
    """
    try:
        import report as _report_mod
    except Exception:
        return [[] for _ in (wm_list or [])]
    try:
        if rules_bytes:
            import yaml
            rs = yaml.safe_load(rules_bytes.decode("utf-8", "replace")) or {}
            if not rs.get("rules"):
                rs = _report_mod.default_ruleset()
        else:
            rs = _report_mod.default_ruleset()
    except Exception:
        try:
            rs = _report_mod.default_ruleset()
        except Exception:
            return [[] for _ in (wm_list or [])]
    out = []
    for wm in (wm_list or []):
        try:
            out.append(_report_mod.apply_rules(wm, rs, scene=scene_dict))
        except Exception as exc:  # noqa: BLE001
            out.append([{
                "id": "rules_error", "label": "Regelauswertung",
                "value": str(exc), "soll": "fehlerfrei",
                "status": "INFO", "einheit": "",
            }])
    return out


def _b64_or_none(path: str) -> str | None:
    """Read file at ``path`` from Pyodide MEMFS and return base64 str.
    Returns None if file missing or empty."""
    try:
        import base64
        with open(path, "rb") as fh:
            data = fh.read()
        if not data:
            return None
        return base64.b64encode(data).decode("ascii")
    except Exception:
        return None


def _glb_b64_from_result(result) -> str | None:
    """Build a GLB scene (wall + cavities + context) using trimesh and
    return as base64. trimesh GLB export is pure-Python -- no native deps
    -- so this runs fine inside Pyodide.
    """
    try:
        import base64
        import trimesh
        scene = trimesh.Scene()
        if getattr(result, "wall", None) is not None:
            try:
                scene.add_geometry(result.wall.copy(), geom_name="wall",
                                   node_name="wall")
            except Exception:
                pass
        for i, entry in enumerate(getattr(result, "cavities", None) or []):
            try:
                mesh, kind = entry
                nm = f"cav{i}_{kind}"
                scene.add_geometry(mesh.copy(), geom_name=nm, node_name=nm)
            except Exception:
                continue
        for i, entry in enumerate(getattr(result, "context_meshes", None) or []):
            try:
                m, ifc_type, name = entry
                safe = "".join(
                    c if c.isalnum() else "_" for c in (name or ifc_type)
                )[:40]
                nm = f"ctx{i}_{ifc_type}_{safe}"
                scene.add_geometry(m.copy(), geom_name=nm, node_name=nm)
            except Exception:
                continue
        data = scene.export(file_type="glb")
        if isinstance(data, str):
            data = data.encode("latin-1", "replace")
        if not data:
            return None
        return base64.b64encode(bytes(data)).decode("ascii")
    except Exception:
        return None


# Worker-resident handle on the last detection so the deferred L7 distance pass
# (compute_deferred_distances) can reuse the already-loaded products + ruleset
# without re-parsing the IFC. The Pyodide worker keeps module state between
# calls, so this survives from run_detect_from_bytes to the follow-up call.
_LAST = {"result": None, "rules_bytes": None, "wm_payload": None, "offset": None,
         "ifc_bytes": None}


def run_detect_from_bytes(
    ifc_bytes: bytes,
    ifc_filename: str = "uploaded.ifc",
    target: str | None = None,
    rules_bytes: bytes | None = None,
    compute_distances: bool = True,
    webifc_products=None,
) -> str:
    """Run the classify pipeline on uploaded IFC bytes.

    `webifc_products` (optional): vorgeladene Geometrie von web-ifc — eine Liste
    von dicts {guid, ifc_type, vertices (flat xyz), faces (flat idx)}. Wird sie
    übergeben, überspringt die Pipeline das OpenCASCADE-Laden komplett (web-ifc
    hat die Geometrie bereits tesselliert, auch FacetedBrep/CSG). Die Vertices
    werden via webifc_mesh.weld_mesh verschweisst (matcht OCCs Topologie für die
    K6-Nischenerkennung). `ifc_bytes` wird dann nur noch für das ASTRA-IFC-Export
    + L7-Distanzen gebraucht.

    Inputs
    ------
    ifc_bytes:
        The complete IFC4 STEP-text payload as Python ``bytes`` (as it
        arrives via Pyodide's JS->Py bridge from the worker).
    ifc_filename:
        Original filename (for diagnostics + display). The file is NOT
        written to disk; only its contents.
    target:
        Optional element-GUID or ``"__ALL__"`` to override the default
        wall selection. ``None`` = auto-pick (all walls when >=2).
    rules_bytes:
        Optional custom YAML ruleset. ``None`` = use bundled default.

    Returns
    -------
    str (JSON):
        On success::

            {
              "ok": true,
              "wall_name": "...",
              "skipped_walls": [...],
              "candidates": [["guid", "label"], ...],
              "timings": {...},
              "cavity_count": 7,
              "scene": {...},
              "wall_metrics": [...],
              "cavities": [{"kind": "...", "vertices": [...], "faces": [...]}, ...],
              "wall_mesh": {"vertices": [...], "faces": [...]},
              "context_meshes": [...]
            }

        On failure::

            {"ok": false, "error": "...", "traceback": "..."}

    Note
    ----
    Because IfcInspect's ``detect()`` is path-based (it calls
    ``ifcopenshell.geom.iterator`` which expects a real file path), we
    write the bytes to Pyodide's in-memory filesystem under ``/tmp/``
    before invoking it. This is NOT a real disk write -- Pyodide's
    MEMFS lives entirely in WASM memory and is wiped when the worker
    terminates. The promise of "IFC never leaves the browser" is
    preserved.
    """
    try:
        _ensure_detect_imports()
        import numpy as _np
        import time as _time
        _perf = {}
        _tk = _time.perf_counter()
        def _mark(_name):
            nonlocal _tk
            _perf[_name] = round((_time.perf_counter() - _tk) * 1000)
            _tk = _time.perf_counter()
            # LIVE phase log (flushed) so a hang shows the LAST completed phase
            # in the browser console even though the pipeline hasn't returned.
            try:
                print(f"[driver.phase] {_name}: {_perf[_name]} ms", flush=True)
            except Exception:
                pass

        # Pyodide MEMFS path -- not a real disk file. ifcopenshell needs
        # a path string because its geom iterator is backed by a C++
        # filebuf-based parser. Writing to /tmp/ keeps the bytes inside
        # the WASM sandbox.
        tmp_ifc = f"/tmp/{os.path.basename(ifc_filename) or 'uploaded.ifc'}"
        with open(tmp_ifc, "wb") as fh:
            fh.write(ifc_bytes)

        # PERF: the initial IFC export at detect() is redundant now that the web
        # UI exports on-demand via export_ifc() (window.ndExportIfc). We pass
        # out_ifc=None so detect() skips generating + b64-encoding the IFC on
        # every load; classification/metrics/cavities are computed regardless.

        # Run the classify pipeline -- ALL_WALLS is the default for
        # multi-wall models (the whole structure).
        from ifcinspect import detect, ALL_WALLS
        # Pyodide hands a JS ``null`` through the JS->Py bridge as a ``JsNull``
        # sentinel object (type ``JsNull``, repr ``jsnull``) -- NOT Python
        # ``None``. A plain ``is None`` check misses it, so the pipeline would
        # silently fall through to the single-wall auto-pick path and analyse
        # only one segment of a multi-segment retaining wall. Normalise
        # anything that is not a non-empty string (None, JsNull, "") to the
        # ALL_WALLS default. A real element GUID or the literal "__ALL__" is a
        # non-empty ``str`` and is preserved.
        if not isinstance(target, str) or not target.strip():
            target = ALL_WALLS

        # web-ifc ist die EINZIGE Geometrie-Engine — KEIN OpenCASCADE-Fallback.
        # web-ifc tesselliert jede Geometrie (auch FacetedBrep/CSG) im Worker;
        # hier werden die Vertices verschweisst (matcht OCCs Topologie für die
        # K6-Nischenerkennung) und direkt in die Pipeline gegeben. Fehlt die
        # Geometrie oder schlägt das Welding fehl, ist das ein echter Fehler
        # (nicht still auf den langsamen Iterator zurückfallen).
        import webifc_mesh
        import ifc_io as _ifcio
        items = webifc_products.to_py() if hasattr(webifc_products, "to_py") \
            else webifc_products
        if not items:
            raise RuntimeError(
                "Keine web-ifc-Geometrie erhalten (webifc_products leer).")
        norm = []
        for it in items:
            d = dict(it) if not isinstance(it, dict) else it
            norm.append({
                "guid": d.get("guid", ""),
                "name": d.get("name", "") or "",
                "ifc_type": d.get("ifc_type", "") or "IfcProduct",
                "vertices": d.get("vertices", []),
                "faces": d.get("faces", []),
            })
        _mark("setup_norm")
        _prods = webifc_mesh.loaded_products_from_webifc(norm, _ifcio._SKIP_TYPES)
        if not _prods:
            raise RuntimeError(
                "web-ifc-Geometrie ergab keine verwertbaren Meshes nach Welding.")
        _mark("weld")

        result = detect(tmp_ifc, None, target=target,
                        compute_distances=compute_distances,
                        products=_prods)
        _mark("detect")
        # Stash for the deferred L7 pass (compute_deferred_distances).
        _LAST["result"] = result
        _LAST["rules_bytes"] = rules_bytes
        # Stash the ORIGINAL IFC bytes so export_ifc() can round-trip-enrich the
        # source file (append psets + classification-face assemblies) instead of
        # rebuilding a fresh IFC. Normalised to plain `bytes` (Pyodide may hand
        # over a memoryview/Uint8Array proxy).
        try:
            _LAST["ifc_bytes"] = bytes(ifc_bytes)
        except Exception:
            _LAST["ifc_bytes"] = ifc_bytes

        # Serialise the Result dataclass into a JSON-safe dict. We can't
        # round-trip trimesh.Trimesh objects through JSON, so emit
        # vertices/faces arrays the JS viewer can consume directly.
        def _mesh_to_dict(m):
            if m is None:
                return None
            try:
                V = _np.asarray(m.vertices, dtype=_np.float64).reshape(-1)
                F = _np.asarray(m.faces, dtype=_np.int64).reshape(-1)
                # .tolist() is a C-level bulk conversion; the old
                # [float(x) for x in V] boxed every element in a Python loop,
                # which on 520 cavities + the wall (millions of floats) is very
                # slow in Pyodide. Same JSON output, far faster.
                return {"vertices": V.tolist(), "faces": F.tolist()}
            except Exception:
                return None

        cavities = []
        for (mesh, kind), meta in zip(
            result.cavities, result.metadata or [None] * len(result.cavities)
        ):
            d = _mesh_to_dict(mesh) or {}
            # Normalise the kind string for the viewer (`Klasse0`..`Klasse6` ->
            # `K0`..`K6`). The viewer's class-colour table + per-class layer
            # toggles use the short keys.
            kind_str = str(kind)
            if kind_str.startswith("Klasse"):
                kind_str = "K" + kind_str[len("Klasse"):]
            d["kind"] = kind_str
            if meta is not None and isinstance(meta, dict):
                d["element_name"] = meta.get("element_name", "")
                d["element_guid"] = meta.get("element_guid", "")
            cavities.append(d)

        _mark("ser_cavities")
        ctx_meshes = []
        for entry in (result.context_meshes or []):
            try:
                m, ifc_type, name = entry
                d = _mesh_to_dict(m) or {}
                d["ifc_type"] = str(ifc_type)
                d["name"] = str(name or ifc_type)
                ctx_meshes.append(d)
            except Exception:  # noqa: BLE001 -- never let context-mesh break the response
                continue

        _mark("ser_context")
        wm_list = result.wall_metrics or []
        scene_dict = result.scene or {}
        pruefungen = _try_evaluate_rules(wm_list, scene_dict, rules_bytes)
        _mark("rules")
        # Inject the per-wall rule evaluation into each wall_metrics dict
        # under the key "pruefung" so the SPA can render PASS/FAIL/SKIP
        # without doing its own evaluation. Mutates a shallow copy to keep
        # the original dict untouched.
        wm_payload = []
        for wm, pr in zip(wm_list, pruefungen):
            if isinstance(wm, dict):
                w2 = dict(wm)
                w2["pruefung"] = pr
                wm_payload.append(w2)
            else:
                wm_payload.append({"pruefung": pr})

        # Stash the rule-injected wall_metrics + the LV95 centring offset so the
        # on-demand export_ifc() can re-emit the IFC with user-chosen content
        # (Pset / submeshes / Pruefung) WITHOUT re-running detect().
        _LAST["wm_payload"] = wm_payload
        _LAST["offset"] = (scene_dict or {}).get("offset")

        # PERF: detect() no longer writes the initial IFC (out_ifc=None). The IFC
        # is produced on demand by export_ifc() from _LAST, so nothing is written
        # here and the redundant b64 payload is dropped.
        ifc_b64 = None
        # GLB best-effort — trimesh GLB export is pure-Python and SLOW in Pyodide
        # on big models. It is only used for the optional GLB download button, so
        # skip it for large meshes (the button then shows "nicht verfügbar"); the
        # IFC/JSON/CSV exports are unaffected. Threshold ~40k faces.
        try:
            _nfaces = sum(len(c.faces) for c, _k in (result.cavities or [])
                          if c is not None)
            if result.wall is not None:
                _nfaces += len(result.wall.faces)
        except Exception:
            _nfaces = 0
        glb_b64 = _glb_b64_from_result(result) if _nfaces <= 40000 else None
        _mark("glb")
        _wall_d = _mesh_to_dict(result.wall)
        _mark("ser_wall")

        payload = {
            "ok": True,
            "wall_name": str(result.wall_name),
            "skipped_walls": _json_sanitize(
                getattr(result, "skipped_walls", []) or []),
            "candidates": [
                [str(g), str(l)] for (g, l) in (result.candidates or [])
            ],
            "chosen_guid": str(result.chosen_guid or ""),
            "method": str(result.method),
            "timings": {
                k: float(v) for k, v in (result.timings or {}).items()
                if not k.startswith("_") and isinstance(v, (int, float))
            },
            "cavity_count": int(len(result.cavities)),
            "scene": _json_sanitize(scene_dict),
            "wall_metrics": _json_sanitize(wm_payload),
            "wall_mesh": _wall_d,
            "cavities": cavities,
            "context_meshes": ctx_meshes,
            "ifc_bytes_b64": ifc_b64,
            "glb_bytes_b64": glb_b64,
            "_perf": _perf,
        }
        _out = json.dumps(_json_sanitize(payload))
        _mark("json_dumps")
        # _perf is already embedded; append json time as a trailing note in stderr.
        try:
            print(f"[driver._perf] {_perf}")
        except Exception:
            pass
        return _out
    except Exception as exc:  # noqa: BLE001 -- driver-level fence
        return json.dumps({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        })


def compute_deferred_distances() -> str:
    """Background L7 pass: compute the pairwise distance table over the products
    of the LAST detection (stashed in ``_LAST``) and re-evaluate the rules with
    the now-complete scene, so any scene.distances rule gets its real verdict.

    Returns JSON::

        {"ok": true,
         "scene_distances": [...],          # the L7 table the UI patches in
         "wall_metrics": [...]}             # re-evaluated pruefung (only if a
                                            # distance rule existed; else same)

    or ``{"ok": false, ...}``. Designed to be called once, right after the main
    result is on screen. The IFC is NOT re-parsed — only the distance math runs.
    """
    try:
        import ifcinspect as _ndmod
        result = _LAST.get("result")
        if result is None:
            return json.dumps({"ok": False, "error": "no prior detection"})
        rules_bytes = _LAST.get("rules_bytes")

        dists = _ndmod.scene_pair_distances(
            getattr(result, "products", None) or [], max_pair_distance_m=10.0)

        # Patch the scene + re-run rules so distance rules resolve for real.
        scene_dict = dict(result.scene or {})
        scene_dict["distances"] = dists
        result.scene = scene_dict

        wm_list = result.wall_metrics or []
        pruefungen = _try_evaluate_rules(wm_list, scene_dict, rules_bytes)
        wm_payload = []
        for wm, pr in zip(wm_list, pruefungen):
            if isinstance(wm, dict):
                w2 = dict(wm)
                w2["pruefung"] = pr
                wm_payload.append(w2)
            else:
                wm_payload.append({"pruefung": pr})

        return json.dumps(_json_sanitize({
            "ok": True,
            "scene_distances": dists,
            "wall_metrics": wm_payload,
        }))
    except Exception as exc:  # noqa: BLE001
        return json.dumps({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        })


def export_ifc(options_json: str) -> str:
    """On-demand IFC4 export of the LAST detection with user-chosen content.

    Mirrors compute_deferred_distances' on-demand pattern: reuses _LAST (the
    worker-resident handle on the last detection) so NO re-parse / re-detect
    happens — only ifcinspect._export is re-run against the cached Result
    with the chosen flags, and the freshly written MEMFS file is returned b64.

    options_json: JSON string {"pset": bool, "submeshes": bool, "pruefung": bool}
        (defaults all True). Returns base64 of the written .ifc, or "" on any
        failure (never throws across the Pyodide bridge).
    """
    try:
        opts = json.loads(options_json or "{}")
        inc_pset = bool(opts.get("pset", True))
        inc_sub = bool(opts.get("submeshes", True))
        inc_pruef = bool(opts.get("pruefung", True))

        res = _LAST.get("result")
        if res is None:
            return ""

        _ensure_detect_imports()
        import ifcinspect as _ndmod

        tmp = "/tmp/export_result.ifc"
        _ndmod._export(
            tmp, res.wall, res.cavities,
            _LAST.get("offset"),
            getattr(res, "metadata", None),
            _LAST.get("wm_payload") or res.wall_metrics,
            include_pset=inc_pset,
            include_submeshes=inc_sub,
            include_pruefung=inc_pruef,
            ifc_bytes=_LAST.get("ifc_bytes"),
        )
        return _b64_or_none(tmp) or ""
    except Exception:  # noqa: BLE001 -- never let export break the bridge
        return ""


def get_version() -> str:
    """Return the installed ifcinspect wheel version (or ``"?"``)."""
    try:
        from importlib.metadata import version
        return str(version("ifcinspect"))
    except Exception:
        return "?"
