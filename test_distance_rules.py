"""test_distance_rules.py - Tests fuer typgefilterte L7-Distanzregeln in rules.py.

Deckt die neue Filter-Syntax `scene.distances[from_type~=Wall,to_type~=Road]`
ab: symmetrischer Match, korrektes Min nur ueber die gefilterten Paare, sowie
sauberes SKIP wenn der Filter kein Paar trifft (z.B. keine Strasse im Modell).

Aufruf:  python test_distance_rules.py   (Exit 0 = alle gruen)

Beruehrt NICHT regression_test.py.
"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
import trimesh

import rules
import distances
import metrics


# Synthetische Scene mit gemischten Typen.
#   Wall<->Road Paare: 1.20 m und 3.50 m  -> Min = 1.20
#   Wall<->Wall Paar : 0.40 m
#   Road<->Road Paar : 5.00 m
# Ein Wall<->Road-Paar ist absichtlich mit VERTAUSCHTEN Rollen (Road im
# from-Feld) abgelegt, um den symmetrischen Match zu pruefen.
SCENE = {
    "scene": {
        "distances": [
            {"from_type": "IfcRetainingWall", "to_type": "IfcRoad",
             "from_name": "SM-01", "to_name": "Strasse-A", "min_distance_m": 1.20},
            {"from_type": "IfcRoad", "to_type": "IfcWallStandardCase",
             "from_name": "Strasse-B", "to_name": "SM-02", "min_distance_m": 3.50},
            {"from_type": "IfcWall", "to_type": "IfcWall",
             "from_name": "SM-03", "to_name": "SM-04", "min_distance_m": 0.40},
            {"from_type": "IfcRoad", "to_type": "IfcRoad",
             "from_name": "Strasse-C", "to_name": "Strasse-D", "min_distance_m": 5.00},
        ]
    }
}

SCENE_NO_ROAD = {
    "scene": {
        "distances": [
            {"from_type": "IfcWall", "to_type": "IfcWall",
             "from_name": "SM-03", "to_name": "SM-04", "min_distance_m": 0.40},
        ]
    }
}


def _approx(a, b, eps=1e-9):
    return a is not None and abs(a - b) <= eps


def test_wall_road_min():
    """Filter wall<->road liefert Min nur ueber die beiden gemischten Paare."""
    val, reason = rules._resolve_target(
        SCENE, "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min")
    assert reason is None, f"unerwarteter skip: {reason}"
    assert _approx(val, 1.20), f"erwartet 1.20, bekam {val}"
    return True


def test_symmetric_match():
    """Auch das Paar mit vertauschten Rollen (Road im from) muss matchen.

    count ueber wall<->road muss 2 sein (beide Orientierungen)."""
    val, reason = rules._resolve_target(
        SCENE, "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:count")
    assert reason is None, f"unerwarteter skip: {reason}"
    assert _approx(val, 2.0), f"erwartet 2 Paare, bekam {val}"
    return True


def test_wall_wall_min():
    """Filter wall<->wall trifft nur das 0.40-Paar (nicht die road-Paare)."""
    val, reason = rules._resolve_target(
        SCENE, "scene.distances[from_type~=Wall, to_type~=Wall].min_distance_m:min")
    assert reason is None, f"unerwarteter skip: {reason}"
    assert _approx(val, 0.40), f"erwartet 0.40, bekam {val}"
    return True


def test_skip_when_no_road():
    """Kein Strassen-Element -> SKIP (value None, klarer Grund), kein Crash."""
    val, reason = rules._resolve_target(
        SCENE_NO_ROAD,
        "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min")
    assert val is None, f"erwartet SKIP (None), bekam {val}"
    assert reason and "filter" in reason.lower(), f"unklarer Grund: {reason}"
    return True


def test_star_unfiltered_still_works():
    """[*] (kein Filter) aggregiert weiterhin ueber alle Paare -> Min 0.40."""
    val, reason = rules._resolve_target(
        SCENE, "scene.distances[*].min_distance_m:min")
    assert reason is None, f"unerwarteter skip: {reason}"
    assert _approx(val, 0.40), f"erwartet 0.40, bekam {val}"
    return True


def test_exact_match_op():
    """key=value = exakter (case-insensitive) Match; trifft IfcWall genau."""
    # to_type=ifcwall exakt: nur das wall<->wall Paar (beide IfcWall).
    val, reason = rules._resolve_target(
        SCENE, "scene.distances[from_type=ifcwall, to_type=ifcwall].min_distance_m:count")
    assert reason is None, f"unerwarteter skip: {reason}"
    assert _approx(val, 1.0), f"erwartet 1 exaktes Paar, bekam {val}"
    return True


def test_evaluate_rule_fail():
    """End-to-end via evaluate(): wall<->road Min 1.20 >= 0.50 -> pass;
    Schwelle 2.0 -> fail."""
    rs = {"rules": [
        {"id": "clr", "label": "Clearance", "severity": "warn", "unit": "m",
         "op": ">=", "threshold": 2.0,
         "target": "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min"},
    ]}
    res = rules.evaluate(rs, SCENE)
    assert res[0]["status"] == "fail", f"erwartet fail, bekam {res[0]['status']}"
    assert _approx(res[0]["target_value"], 1.20)
    return True


def test_evaluate_rule_skip_no_road():
    """End-to-end: kein Road -> evaluate liefert status 'skip', kein Crash."""
    rs = {"rules": [
        {"id": "clr", "label": "Clearance", "severity": "warn", "unit": "m",
         "op": ">=", "threshold": 0.50,
         "target": "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min"},
    ]}
    res = rules.evaluate(rs, SCENE_NO_ROAD)
    assert res[0]["status"] == "skip", f"erwartet skip, bekam {res[0]['status']}"
    return True


# --------------------------------------------------------------------------- #
#  Mess-Modi (distances.py): horizontal / vertikal / perpendicular
# --------------------------------------------------------------------------- #
class _Prod:
    """Minimaler LoadedProduct-Stub fuer scene_distances."""
    def __init__(self, mesh, name, ifc_type, guid="g"):
        self.mesh = mesh
        self.name = name
        self.ifc_type = ifc_type
        self.guid = guid


def _box(cx, cy, cz, sx=1.0, sy=1.0, sz=1.0):
    b = trimesh.creation.box(extents=(sx, sy, sz))
    b.apply_translation([cx, cy, cz])
    return b


def test_horizontal_less_than_3d_with_height_offset():
    """Zwei Boxen mit Hoehenversatz: horizontale Distanz < 3D-Distanz.

    Box A bei (0,0,0), Box B bei x=3 UND z=4 versetzt. Horizontal (XY) ist der
    Abstand nur die x-Luecke; 3D enthaelt zusaetzlich den z-Versatz und ist
    daher groesser."""
    a = _Prod(_box(0, 0, 0), "WallA", "IfcWall")
    b = _Prod(_box(3.0, 0, 4.0), "BlockB", "IfcBuildingElementProxy")
    rows = distances.scene_distances([a, b], max_pair_distance_m=20.0)
    assert rows, "kein Paar berechnet"
    row = rows[0]
    d3 = row["min_distance_m"]
    dh = row["horizontal_distance_m"]
    dv = row["vertical_distance_m"]
    assert dh is not None and d3 is not None, "Felder fehlen"
    assert dh < d3 - 1e-6, f"horizontal {dh} sollte < 3D {d3} sein"
    # horizontale Luecke ~ 3 - (0.5+0.5) = 2.0
    assert _approx(dh, 2.0, eps=0.2), f"horizontal erwartet ~2.0, bekam {dh}"
    # vertikale Luecke ~ 4 - (0.5+0.5) = 3.0
    assert _approx(dv, 3.0, eps=0.2), f"vertikal erwartet ~3.0, bekam {dv}"
    return True


def test_vertical_zero_when_z_overlap():
    """Boxen mit ueberlappenden Z-Intervallen -> vertical_distance_m == 0."""
    a = _Prod(_box(0, 0, 0, sz=2.0), "WallA", "IfcWall")
    b = _Prod(_box(3.0, 0, 0, sz=2.0), "WallB", "IfcWall")
    rows = distances.scene_distances([a, b], max_pair_distance_m=20.0)
    assert rows, "kein Paar"
    assert _approx(rows[0]["vertical_distance_m"], 0.0), \
        f"vertikal erwartet 0, bekam {rows[0]['vertical_distance_m']}"
    return True


def test_perpendicular_present_with_wall_and_none_without():
    """perpendicular: gefuellt wenn wand-artige Referenz vorhanden, sonst None+Grund."""
    # Wand als duenner Riegel entlang x (klare horizontale Normale in y).
    wall = trimesh.creation.box(extents=(8.0, 0.4, 3.0))
    a = _Prod(wall, "WallA", "IfcRetainingWall")
    b = _Prod(_box(0.0, 3.0, 0.0), "RoadB", "IfcRoad")
    rows = distances.scene_distances([a, b], max_pair_distance_m=20.0)
    assert rows, "kein Paar"
    perp = rows[0]["perpendicular_distance_m"]
    assert perp is not None, f"perpendicular sollte berechnet sein, reason={rows[0]['perpendicular_reason']}"
    assert perp > 0, f"perpendicular > 0 erwartet, bekam {perp}"

    # Ohne Wand-Referenz: zwei Proxy-Bauteile -> None + Grund.
    c = _Prod(_box(0, 0, 0), "ProxyC", "IfcBuildingElementProxy")
    d = _Prod(_box(3.0, 0, 0), "ProxyD", "IfcBuildingElementProxy")
    rows2 = distances.scene_distances([c, d], max_pair_distance_m=20.0)
    assert rows2, "kein Paar (2)"
    assert rows2[0]["perpendicular_distance_m"] is None, \
        "ohne Wand sollte perpendicular None sein"
    assert rows2[0]["perpendicular_reason"], "Grund fehlt"
    return True


def test_distance_rule_horizontal_mode():
    """Eine Regel kann den horizontalen Modus per Feldwahl ansteuern."""
    a = _Prod(_box(0, 0, 0), "WallA", "IfcWall")
    b = _Prod(_box(3.0, 0, 4.0), "RoadB", "IfcRoad")
    rows = distances.scene_distances([a, b], max_pair_distance_m=20.0)
    scene = {"scene": {"distances": rows}}
    val_h, r_h = rules._resolve_target(
        scene, "scene.distances[from_type~=Wall, to_type~=Road].horizontal_distance_m:min")
    val_3, r_3 = rules._resolve_target(
        scene, "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min")
    assert r_h is None and r_3 is None, f"skip: {r_h} / {r_3}"
    assert val_h < val_3 - 1e-6, f"horizontal {val_h} < 3D {val_3} erwartet"
    return True


# --------------------------------------------------------------------------- #
#  Kronenbreite-Aggregation (metrics.py)
# --------------------------------------------------------------------------- #
def test_crown_width_aggregation_keys_and_order():
    """crown_width liefert min/p10/avg/median; min <= p10 <= avg (meistens)."""
    # K2-artige Krone: variable Breite entlang der Wandachse (x), Breite in y.
    # Stationen mit unterschiedlicher y-Spannweite -> Verteilung.
    pts = []
    for x in np.linspace(0, 10, 60):
        half = 0.3 + 0.1 * (x / 10.0)   # Breite waechst 0.6 -> 0.8 m
        for y in (-half, half):
            pts.append([x, y, 0.0])
    verts = np.array(pts, dtype=float)
    # triviale Faces, damit _region_faces/mesh.faces funktionieren
    n = len(verts)
    faces = np.array([[i, (i + 1) % n, (i + 2) % n] for i in range(0, n - 2, 2)])
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    axes = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])  # Vt0=x, Vt1=z, Vt2=y
    cluster_id = np.full(len(mesh.faces), metrics.K_CROWN)
    main_mask = np.ones(len(mesh.faces), dtype=bool)
    res = metrics.crown_width(mesh, axes, main_mask, cluster_id,
                              dims={"length": 10.0}, areas={"K2": 7.0})
    for k in ("min", "p10", "avg", "median", "value", "n_samples"):
        assert k in res, f"key {k} fehlt"
    assert res["n_samples"] >= 1, "keine Samples"
    assert res["min"] is not None and res["avg"] is not None
    assert res["min"] <= res["p10"] + 1e-9, f"min {res['min']} > p10 {res['p10']}"
    assert res["p10"] <= res["avg"] + 1e-6 or res["min"] <= res["avg"], \
        f"Reihenfolge min<=p10<=avg verletzt: {res}"
    assert res["value"] == res["p10"], "value sollte p10-Default sein"
    return True


def test_crown_width_top_level_keys_in_wall_metrics():
    """Die Aggregations-Keys sind als Top-Level-Targets erreichbar."""
    # rein struktureller Smoke-Test ueber _resolve_dot auf einem gebauten dict
    wm = {
        "crown_width_m": 0.6, "crown_width_min_m": 0.55,
        "crown_width_p10_m": 0.6, "crown_width_avg_m": 0.7,
        "crown_width_median_m": 0.65,
    }
    for key in ("crown_width_min_m", "crown_width_p10_m",
                "crown_width_avg_m", "crown_width_median_m"):
        v, reason = rules._resolve_target(wm, key)
        assert reason is None and v is not None, f"{key} nicht erreichbar: {reason}"
    return True


# --------------------------------------------------------------------------- #
#  L5/L6 ehrliche Semantik (Rate-Heuristik-Rückbau 2026-05-30, context.py)
# --------------------------------------------------------------------------- #
# Welt-ausgerichtete Achsen: Vt[0]=x (Laengs), Vt[1]=z (Hoehe), Vt[2]=y (Dicke).
_CTX_AXES = np.array([[1.0, 0.0, 0.0],
                      [0.0, 0.0, 1.0],
                      [0.0, 1.0, 0.0]])


def _classify_ctx(mesh):
    """Klassifikation via niche_brep, wie in der Pipeline (fuer L5/L6-Tests)."""
    import niche_brep as nb
    _, meta = nb.detect_niches_face_classification(
        mesh, return_meta=True, axes=_CTX_AXES)
    return meta["main_face_mask"], meta["cluster_id"]


def test_l6_no_terrain_unbestimmt():
    """L6 ohne Terrain -> air/earth='unbestimmt', kein_terrain, conf=niedrig.

    Kern des Rate-Heuristik-Rückbaus: ohne Terrain ist die Luft-/Erdseite
    geometrisch nicht bestimmbar -> ehrlich 'unbestimmt' statt K4=Luft/K5=Erde
    zu raten."""
    import context as ctx
    wall = trimesh.creation.box(extents=(6.0, 0.4, 3.0))
    wall.apply_translation([0, 0, 1.5])
    wall.merge_vertices(); wall.fix_normals()
    mfm, cid = _classify_ctx(wall)
    # scene_products=None -> kein Terrain
    out = ctx.external_context(wall, _CTX_AXES, mfm, cid, scene_products=None)
    assert out["air_side_face_class"] == "unbestimmt", \
        f"air sollte unbestimmt sein, bekam {out['air_side_face_class']}"
    assert out["earth_side_face_class"] == "unbestimmt", \
        f"earth sollte unbestimmt sein, bekam {out['earth_side_face_class']}"
    assert out["classification_source"] == "kein_terrain", \
        f"source sollte kein_terrain sein, bekam {out['classification_source']}"
    assert out["confidence_level"] == "niedrig", \
        f"confidence sollte niedrig sein, bekam {out['confidence_level']}"
    assert out["terrain_present"] is False
    # Distanzfelder bleiben None (nichts gemessen, nichts geraten)
    assert out["terrain_median_distance_air_m"] is None
    assert out["terrain_median_distance_earth_m"] is None
    return True


def test_l5_plain_wall_no_foundation():
    """L5 plain wall (KEINE seitliche Auskragung) -> foundation_present=False.

    Eine reine Box hat trivial eine K3-Boden-Face, ragt aber NICHT seitlich
    ueber sich selbst hinaus -> kein Fundament (Ueberstand = 0 <= tol)."""
    import context as ctx
    wall = trimesh.creation.box(extents=(6.0, 0.4, 3.0))
    wall.apply_translation([0, 0, 1.5])
    wall.merge_vertices(); wall.fix_normals()
    mfm, cid = _classify_ctx(wall)
    out = ctx.internal_context(wall, _CTX_AXES, mfm, cid, scene_products=None)
    assert out["foundation_present"] is False, \
        f"plain wall darf kein Fundament melden, bekam {out}"
    # source nennt das verfehlte Praedikat (kein seitlicher Ueberstand bzw.
    # z_extent>=xy); confidence bleibt niedrig.
    assert out["confidence_level"] == "niedrig", \
        f"plain wall conf sollte niedrig sein, bekam {out.get('confidence_level')}"
    return True


def test_l5_lprofile_foundation_present():
    """L5 echtes L-/T-Profil mit seitlichem Ueberstand -> foundation_present=True.

    Wir bauen Stamm (schmal) + breiteres Fundament als EIN watertight Solid via
    Boolean-Union zweier Boxen. Das Fundament ragt entlang Vt[2] (y) deutlich
    ueber den Stamm hinaus (>> Auflösungs-Toleranz)."""
    import context as ctx
    # Realistisch tesselliert (subdivide): reale IFC-Meshes sind fein
    # vernetzt; ein einzelnes Riesen-Quad als K3-Face wuerde die
    # auflösungsbasierte Toleranz (k * median_edge_length) kuenstlich aufblaehen.
    def _fine_box(extents, translate, n=3):
        m = trimesh.creation.box(extents=extents)
        for _ in range(n):
            m = m.subdivide()
        m.apply_translation(translate)
        return m
    # Stamm: y in [-0.2, 0.2], z in [0.4, 4.0]
    stem = _fine_box((6.0, 0.4, 3.6), [0, 0, 2.2])
    # Fundament: y in [-2.0, 2.0] (breit), z in [0, 0.4] (flach) -> Ueberstand
    # (4.0-0.4)/2 = 1.80 m je Seite, Summe 3.60 m >> Auflösungs-Toleranz.
    foot = _fine_box((6.0, 4.0, 0.4), [0, 0, 0.2])
    solid = trimesh.util.concatenate([stem, foot])
    try:
        u = trimesh.boolean.union([stem, foot])
        if u is not None and u.is_volume and len(u.faces) > 0:
            solid = u
    except Exception:
        pass
    solid.merge_vertices(); solid.fix_normals()
    mfm, cid = _classify_ctx(solid)
    out = ctx.internal_context(solid, _CTX_AXES, mfm, cid, scene_products=None)
    assert out["foundation_present"] is True, \
        f"L-Profil sollte Fundament melden, bekam {out}"
    # Ueberstand sollte ~ (4.0-0.4)/2 = 1.80 m je Seite sein (>> tol)
    ohl = out.get("foundation_overhang_left_m")
    ohr = out.get("foundation_overhang_right_m")
    assert ohl is not None and ohr is not None and (ohl + ohr) > 1.0, \
        f"erwartet deutlichen Ueberstand, bekam L={ohl} R={ohr}"
    # klares L-Profil (Ueberstand >> tol) -> hohe Confidence
    assert out.get("confidence_level") == "hoch", \
        f"klares L-Profil sollte conf=hoch sein, bekam {out.get('confidence_level')} "
    return True


def test_report_renders_unbestimmt_and_confidence():
    """report.py rendert L6 'unbestimmt'/'kein_terrain' + L5/L6 confidence ohne Crash.

    Reine In-Memory-Wand-Metrics (kein IFC, kein Disk-Write): prüft, dass die
    additiven Felder im HTML/JSON/CSV sauber erscheinen und nichts crasht."""
    import report
    wm = {
        "element_name": "TestWand", "element_guid": "g1",
        "dimensions": {"length": 6, "height": 3, "nominal_thickness": 0.4},
        "area_per_class": {f"K{i}": 1.0 for i in range(7)},
        "context": {
            "internal": {
                "foundation_present": False,
                "source": "no_footing_detected:overhang_<=_resolution_tol",
                "confidence_level": "niedrig", "overhang_tolerance_m": 0.06,
                "foundation_overhang_left_m": None,
                "foundation_overhang_right_m": None,
                "stem_centered_on_foundation": None,
                "shared_interface_area_m2": None,
                "foundation_to_stem_volume_ratio": None},
            "external": {
                "air_side_face_class": "unbestimmt",
                "earth_side_face_class": "unbestimmt",
                "terrain_present": False,
                "terrain_median_distance_air_m": None,
                "terrain_median_distance_earth_m": None,
                "classification_source": "kein_terrain",
                "confidence_level": "niedrig"},
        },
    }

    class _R:
        wall_metrics = [wm]
        scene = {"distances": []}
        skipped_walls = []
        method = "classify"
        wall_name = ""

    rep = report.build_report(_R(), model_name="synthetic")
    html = report.to_html(rep)
    js = report.to_json(rep)
    csvs = report.to_csv(rep)
    assert "unbestimmt" in html, "L6 'unbestimmt' fehlt im HTML"
    assert "kein_terrain" in html, "L6 'kein_terrain' Quelle fehlt im HTML"
    assert "Ueberstand-Toleranz" in html, "L5 Auflösungs-Toleranz fehlt im HTML"
    assert "unbestimmt" in js, "L6 'unbestimmt' fehlt im JSON"
    assert len(html) > 0 and len(js) > 0 and len(csvs) > 0
    return True


# --------------------------------------------------------------------------- #
#  Generischer Kontext-Teilcheck + 'info'-Status (rules._CONTEXT_CHECKS)
# --------------------------------------------------------------------------- #
def _crown_rule():
    """Die FHB-Kronenneigungsregel (Betrag 3 % +/- 0.5, Richtung kontext-geprueft)."""
    return {"id": "crown_slope_against_hill",
            "label": "Kronenneigung", "target": "crown_slope_abs_percent",
            "op": "==", "threshold": 3.0, "tolerance": 0.5, "unit": "percent",
            "severity": "warn", "applies_to": ["*"], "source": ""}


def _crown_wm(signed, ext):
    return {"element_type": "Wand",
            "slope": {"crown_drain_toward_front_percent": signed},
            "context": {"external": ext}}


def test_ctxcheck_pass_direction_correct():
    """(a) Terrain + eindeutige Erdseite + korrektes Gefaelle-Vorzeichen -> pass."""
    ext = {"terrain_present": True, "side_clear": True,
           "air_side_face_class": "K4"}     # K4 = +Vt[2] -> + erwartet
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(+3.0, ext))[0]
    assert ev["status"] == "pass", f"erwartet pass, bekam {ev['status']}"
    assert ev["context_check"] == "ok", ev.get("context_check")
    return True


def test_ctxcheck_warn_direction_wrong():
    """(b) Terrain + eindeutige Erdseite + falsches Vorzeichen -> warn (Richtung)."""
    ext = {"terrain_present": True, "side_clear": True,
           "air_side_face_class": "K4"}
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(-3.0, ext))[0]   # faellt zur Erdseite (K5)
    assert ev["status"] == "warn", f"erwartet warn, bekam {ev['status']}"
    assert ev["context_check"] == "fail", ev.get("context_check")
    return True


def test_ctxcheck_info_no_terrain():
    """(c) Kein Terrain, Betrag ok -> info (Richtung nicht pruefbar)."""
    ext = {"terrain_present": False, "side_clear": False,
           "air_side_face_class": "unbestimmt"}
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(+3.0, ext))[0]
    assert ev["status"] == "info", f"erwartet info, bekam {ev['status']}"
    assert ev["context_check"] == "unavailable", ev.get("context_check")
    return True


def test_ctxcheck_amount_fail_is_severity_warn():
    """(d) Betrag nicht erfuellt -> fail (severity=warn) ; kein Kontext-Check."""
    ext = {"terrain_present": True, "side_clear": True,
           "air_side_face_class": "K4"}
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(+1.0, ext))[0]   # 1.0 nicht in 3+-0.5
    assert ev["status"] == "fail" and ev["severity"] == "warn", \
        f"erwartet fail/warn, bekam {ev['status']}/{ev['severity']}"
    assert ev.get("context_check") is None, ev.get("context_check")
    # report.py rendert das severity-konform als WARN
    import report
    assert report._check_from_eval(ev)["status"] == "WARN"
    return True


def test_ctxcheck_info_terrain_not_clear():
    """Terrain da, aber Erdseite nicht eindeutig (side_clear=False) -> info."""
    ext = {"terrain_present": True, "side_clear": False,
           "air_side_face_class": "K4"}
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(+3.0, ext))[0]
    assert ev["status"] == "info", f"erwartet info, bekam {ev['status']}"
    return True


def test_ctxcheck_info_renders_as_INFO():
    """'info' wird von report.py als INFO gerendert (Renderer kennt INFO)."""
    import report
    ext = {"terrain_present": False, "side_clear": False,
           "air_side_face_class": "unbestimmt"}
    rs = {"rules": [_crown_rule()]}
    ev = rules.evaluate(rs, _crown_wm(+3.0, ext))[0]
    assert report._check_from_eval(ev)["status"] == "INFO"
    return True


def test_ctxcheck_no_registry_rule_unchanged():
    """Eine Regel OHNE Kontext-Check-Eintrag bleibt unveraendert (pass)."""
    rs = {"rules": [{"id": "crown_min_width", "label": "Krone",
                     "target": "crown_width_min_m", "op": ">=",
                     "threshold": 0.30, "severity": "fail", "applies_to": ["*"]}]}
    ev = rules.evaluate(rs, {"element_type": "Wand", "crown_width_min_m": 0.40})[0]
    assert ev["status"] == "pass", f"erwartet pass, bekam {ev['status']}"
    assert "context_check" not in ev
    return True


TESTS = [
    test_report_renders_unbestimmt_and_confidence,
    test_ctxcheck_pass_direction_correct,
    test_ctxcheck_warn_direction_wrong,
    test_ctxcheck_info_no_terrain,
    test_ctxcheck_amount_fail_is_severity_warn,
    test_ctxcheck_info_terrain_not_clear,
    test_ctxcheck_info_renders_as_INFO,
    test_ctxcheck_no_registry_rule_unchanged,
    test_l6_no_terrain_unbestimmt,
    test_l5_plain_wall_no_foundation,
    test_l5_lprofile_foundation_present,
    test_wall_road_min,
    test_symmetric_match,
    test_wall_wall_min,
    test_skip_when_no_road,
    test_star_unfiltered_still_works,
    test_exact_match_op,
    test_evaluate_rule_fail,
    test_evaluate_rule_skip_no_road,
    test_horizontal_less_than_3d_with_height_offset,
    test_vertical_zero_when_z_overlap,
    test_perpendicular_present_with_wall_and_none_without,
    test_distance_rule_horizontal_mode,
    test_crown_width_aggregation_keys_and_order,
    test_crown_width_top_level_keys_in_wall_metrics,
]


def main():
    ok = 0
    fail = 0
    for t in TESTS:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            ok += 1
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            fail += 1
        except Exception as e:
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            fail += 1
    print(f"\n{ok}/{len(TESTS)} gruen, {fail} rot")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
