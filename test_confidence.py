"""test_confidence.py — Tests fuer confidence.py + Laengsgefaelle + min_confidence.

Deckt ab:
  1. Confidence deterministisch (gleiche Eingabe -> gleicher Score).
  2. Monotonie in den Signalen:
       * grobes Mesh (wenige Faces)        -> niedrigere Confidence
       * nicht-watertight                  -> harter Daempfer (<= 0.6)
       * dichtes watertight Mesh           -> hohe Confidence
  3. Laengsgefaelle: Vorzeichen + Plausibilitaet auf synthetisch geneigter Krone.
  4. Regel mit min_confidence: WARN bei niedriger Confidence, normal sonst;
     SKIP wenn Confidence nicht ermittelbar; ohne min_confidence unveraendert.

Aufruf:  python test_confidence.py   (Exit 0 = alle gruen)
Beruehrt NICHT regression_test.py.
"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
import trimesh

import confidence as conf
import metrics
import rules


# Welt-ausgerichtete Achsen: Vt[0]=x (Laengs), Vt[1]=z (Hoehe), Vt[2]=y (Dicke).
AXES = np.array([[1.0, 0.0, 0.0],
                 [0.0, 0.0, 1.0],
                 [0.0, 1.0, 0.0]])

_FAILS = []


def check(name, cond, extra=""):
    status = "OK  " if cond else "FAIL"
    if not cond:
        _FAILS.append(name)
    print(f"[{status}] {name}{('  -- ' + extra) if extra else ''}")


def _box(length=6.0, height=2.0, thick=0.5, subdiv=0):
    """Watertight Box-Mesh (Wand). subdiv>0 -> feiner tesselliert (mehr Faces)."""
    m = trimesh.creation.box(extents=(length, height, thick))
    for _ in range(subdiv):
        m = m.subdivide()
    m.merge_vertices()
    m.fix_normals()
    return m


def _classify(mesh):
    """Klassifikation via niche_brep (wie in der Pipeline)."""
    import niche_brep as nb
    niche_components, meta = nb.detect_niches_face_classification(
        mesh, return_meta=True, axes=AXES)
    return meta["main_face_mask"], meta["cluster_id"], niche_components


# --------------------------------------------------------------------------- #
#  1) Determinismus
# --------------------------------------------------------------------------- #
def test_deterministic():
    print("\n=== 1) Determinismus ===")
    mesh = _box(subdiv=2)
    mfm, cid, nc = _classify(mesh)
    a = conf.compute_confidence(mesh, AXES, mfm, cid, nc,
                                crown_n_samples=20, thickness_n_samples=20,
                                slope_n_stations=12)
    b = conf.compute_confidence(mesh, AXES, mfm, cid, nc,
                                crown_n_samples=20, thickness_n_samples=20,
                                slope_n_stations=12)
    check("Determinismus overall identisch",
          a["overall"]["score"] == b["overall"]["score"],
          f"{a['overall']['score']}")


# --------------------------------------------------------------------------- #
#  2) Monotonie in den Signalen
# --------------------------------------------------------------------------- #
def test_monotonic_density():
    print("\n=== 2a) Monotonie: dicht > grob ===")
    coarse = _box(subdiv=0)            # 12 Faces
    fine = _box(subdiv=3)             # viele Faces
    mfm_c, cid_c, nc_c = _classify(coarse)
    mfm_f, cid_f, nc_f = _classify(fine)
    sc_coarse = conf.compute_confidence(
        coarse, AXES, mfm_c, cid_c, nc_c,
        crown_n_samples=4, thickness_n_samples=4, slope_n_stations=4
    )["classification"]["score"]
    sc_fine = conf.compute_confidence(
        fine, AXES, mfm_f, cid_f, nc_f,
        crown_n_samples=40, thickness_n_samples=40, slope_n_stations=40
    )["classification"]["score"]
    check("classification: fein >= grob", sc_fine >= sc_coarse,
          f"fein={sc_fine}  grob={sc_coarse}")
    check("feines dichtes watertight Mesh -> hoch (>=0.8)", sc_fine >= 0.8,
          f"{sc_fine}")


def test_watertight_damper():
    print("\n=== 2b) watertight-Daempfer ===")
    fine = _box(subdiv=3)
    mfm, cid, nc = _classify(fine)
    full = conf.compute_confidence(
        fine, AXES, mfm, cid, nc,
        crown_n_samples=40, thickness_n_samples=40, slope_n_stations=40)
    # gleiche Eingabe, aber als repariert markiert -> harter Deckel <= 0.6
    damped = conf.compute_confidence(
        fine, AXES, mfm, cid, nc,
        crown_n_samples=40, thickness_n_samples=40, slope_n_stations=40,
        repaired=True)
    check("repaired deckelt overall auf <= 0.6",
          damped["overall"]["score"] <= 0.6 + 1e-9,
          f"{damped['overall']['score']}")
    check("repaired < unrepariert", damped["overall"]["score"] <
          full["overall"]["score"],
          f"{damped['overall']['score']} < {full['overall']['score']}")

    # echtes nicht-watertight Mesh (offene Box: eine Face entfernt)
    open_mesh = fine.copy()
    open_mesh.update_faces(np.arange(len(open_mesh.faces)) > 0)  # erste Face weg
    open_mesh.remove_unreferenced_vertices()
    d, is_wt = conf.watertight_damper(open_mesh)
    check("offenes Mesh -> nicht watertight erkannt", not is_wt,
          f"is_wt={is_wt}")
    check("offenes Mesh -> Daempfer 0.6", abs(d - 0.6) < 1e-9, f"{d}")


def test_samples_signal_monotonic():
    print("\n=== 2c) Sample-Signal monoton ===")
    fine = _box(subdiv=3)
    mfm, cid, nc = _classify(fine)
    few = conf.compute_confidence(
        fine, AXES, mfm, cid, nc,
        crown_n_samples=3, thickness_n_samples=3, slope_n_stations=3
    )["crown_width"]["score"]
    many = conf.compute_confidence(
        fine, AXES, mfm, cid, nc,
        crown_n_samples=40, thickness_n_samples=40, slope_n_stations=40
    )["crown_width"]["score"]
    check("crown_width: viele Samples >= wenige", many >= few,
          f"many={many}  few={few}")


# --------------------------------------------------------------------------- #
#  3) Laengsgefaelle Vorzeichen + Plausibilitaet
# --------------------------------------------------------------------------- #
def _tilted_crown_mesh(slope_percent=5.0, length=10.0):
    """Box, deren Krone (Top) linear entlang +x ansteigt -> bekanntes Laengsgefaelle.

    Wir scheren die Box: jeder Vertex bekommt z += (slope) * x. So steigt sowohl
    Krone als auch Fundament gleichmaessig nach +x an (positives Laengsgefaelle).
    """
    m = _box(length=length, height=2.0, thick=0.6, subdiv=2)
    slope = slope_percent / 100.0
    V = m.vertices.copy()
    x = V[:, 0]
    V[:, 2] = V[:, 2] + slope * x
    m2 = trimesh.Trimesh(vertices=V, faces=m.faces.copy(), process=False)
    m2.merge_vertices()
    m2.fix_normals()
    return m2


def test_longitudinal_slope():
    print("\n=== 3) Laengsgefaelle ===")
    SLOPE = 5.0   # %
    mesh = _tilted_crown_mesh(slope_percent=SLOPE)
    mfm, cid, nc = _classify(mesh)
    bs = metrics.batter_and_slope(mesh, AXES, mfm, cid)
    sl = bs["slope"]
    cl = sl.get("crown_longitudinal_percent")
    cdeg = sl.get("crown_longitudinal_deg")
    print(f"   crown_long: {cdeg}°  /  {cl} %   "
          f"(reason={sl.get('crown_longitudinal_reason')})")
    check("Krone-Laengsgefaelle vorhanden", cl is not None, f"{cl}")
    if cl is not None:
        check("Krone-Laengsgefaelle positiv (ansteigend nach +x)", cl > 0,
              f"{cl} %")
        check("Krone-Laengsgefaelle ~ 5 % (+-1)", abs(cl - SLOPE) < 1.0,
              f"{cl} % vs {SLOPE} %")
        check("Grad/Prozent konsistent",
              abs(np.degrees(np.arctan(cl / 100.0)) - cdeg) < 0.1,
              f"{cdeg}°")

    # negative Steigung -> Vorzeichen kippt
    mesh_neg = _tilted_crown_mesh(slope_percent=-4.0)
    mfm2, cid2, nc2 = _classify(mesh_neg)
    sl2 = metrics.batter_and_slope(mesh_neg, AXES, mfm2, cid2)["slope"]
    cl2 = sl2.get("crown_longitudinal_percent")
    print(f"   crown_long (negativ): {cl2} %")
    check("negatives Laengsgefaelle -> Vorzeichen negativ",
          cl2 is not None and cl2 < 0, f"{cl2} %")

    # flache Krone -> ~0
    flat = _box(length=8.0, subdiv=2)
    mfm3, cid3, nc3 = _classify(flat)
    sl3 = metrics.batter_and_slope(flat, AXES, mfm3, cid3)["slope"]
    cl3 = sl3.get("crown_longitudinal_percent")
    print(f"   crown_long (flach): {cl3} %")
    check("flache Krone -> Laengsgefaelle ~ 0", cl3 is not None and
          abs(cl3) < 0.5, f"{cl3} %")

    # bestehende Quergefaelle-Keys nicht gebrochen
    check("slope.crown_deg weiterhin vorhanden", "crown_deg" in sl3)
    check("slope.foundation_deg weiterhin vorhanden", "foundation_deg" in sl3)


# --------------------------------------------------------------------------- #
#  4) min_confidence in rules.py
# --------------------------------------------------------------------------- #
def _ruleset(extra):
    base = {"version": 1, "profile": "test", "applies_to": ["IfcWall"],
            "rules": [extra]}
    return rules._validate(base, "test")


def test_min_confidence_warn():
    print("\n=== 4) min_confidence-Gating ===")
    # Metrics-Dict mit kontrollierter Confidence.
    wm_low = {
        "crown_width_min_m": 0.40,           # erfuellt >= 0.30 -> waere PASS
        "confidence": {"crown_width": {"score": 0.30, "level": "niedrig"},
                       "overall": {"score": 0.30, "level": "niedrig"}},
    }
    wm_high = {
        "crown_width_min_m": 0.40,
        "confidence": {"crown_width": {"score": 0.90, "level": "hoch"},
                       "overall": {"score": 0.90, "level": "hoch"}},
    }
    rule = {"id": "cw", "label": "Krone", "target": "crown_width_min_m",
            "op": ">=", "threshold": 0.30, "severity": "fail",
            "min_confidence": 0.6}

    rs = _ruleset(dict(rule))
    ev_low = rules.evaluate(rs, wm_low)[0]
    ev_high = rules.evaluate(rs, wm_high)[0]
    # Thesis Kap. 4: INFO = erfuelltes, wegen zu geringer Konfidenz aber nicht
    # gesichertes Kriterium. Ein PASS mit Confidence < min_confidence -> INFO
    # (frueher WARN; an die Thesis-Definition angeglichen 2026-06-02).
    check("niedrige Confidence -> INFO (statt PASS)",
          ev_low["status"] == "info", f"{ev_low['status']}")
    check("INFO-Eintrag traegt confidence_score",
          ev_low.get("confidence_score") == 0.30,
          f"{ev_low.get('confidence_score')}")
    check("INFO-Eintrag traegt Notiz", bool(ev_low.get("note")),
          f"{ev_low.get('note')}")
    check("hohe Confidence -> normal PASS",
          ev_high["status"] == "pass", f"{ev_high['status']}")
    check("heuristisches confidence_target = crown_width",
          ev_low.get("confidence_target") == "confidence.crown_width.score",
          f"{ev_low.get('confidence_target')}")


def test_min_confidence_skip():
    print("\n=== 4b) min_confidence SKIP wenn Confidence fehlt ===")
    wm = {"crown_width_min_m": 0.40, "confidence": {}}   # kein Score
    rule = {"id": "cw", "label": "Krone", "target": "crown_width_min_m",
            "op": ">=", "threshold": 0.30, "severity": "fail",
            "min_confidence": 0.6}
    rs = _ruleset(dict(rule))
    ev = rules.evaluate(rs, wm)[0]
    check("Confidence nicht ermittelbar -> SKIP",
          ev["status"] == "skip", f"{ev['status']}")


def test_without_min_confidence_unchanged():
    print("\n=== 4c) ohne min_confidence unveraendert ===")
    wm = {"crown_width_min_m": 0.20,         # verletzt >= 0.30 -> FAIL
          "confidence": {"crown_width": {"score": 0.10, "level": "niedrig"}}}
    rule = {"id": "cw", "label": "Krone", "target": "crown_width_min_m",
            "op": ">=", "threshold": 0.30, "severity": "fail"}
    rs = _ruleset(dict(rule))
    ev = rules.evaluate(rs, wm)[0]
    check("ohne min_confidence: trotz niedriger Confidence FAIL",
          ev["status"] == "fail", f"{ev['status']}")
    check("ohne min_confidence: keine confidence-Felder",
          "confidence_score" not in ev)


def test_validate_range():
    print("\n=== 4d) min_confidence Validierung ===")
    bad = {"id": "x", "label": "x", "target": "crown_width_m", "op": ">=",
           "threshold": 0.3, "severity": "fail", "min_confidence": 1.5}
    try:
        _ruleset(dict(bad))
        check("min_confidence > 1 wird abgelehnt", False)
    except ValueError:
        check("min_confidence > 1 wird abgelehnt", True)


# --------------------------------------------------------------------------- #
#  Runner
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    test_deterministic()
    test_monotonic_density()
    test_watertight_damper()
    test_samples_signal_monotonic()
    test_longitudinal_slope()
    test_min_confidence_warn()
    test_min_confidence_skip()
    test_without_min_confidence_unchanged()
    test_validate_range()

    print("\n" + "=" * 60)
    if _FAILS:
        print(f"FEHLGESCHLAGEN ({len(_FAILS)}): " + ", ".join(_FAILS))
        sys.exit(1)
    print("ALLE TESTS GRÜN")
    sys.exit(0)
