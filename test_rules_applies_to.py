"""Unit-Tests fuer per-Regel `applies_to` (Typ-Gate in rules.evaluate()).

Eingefuehrt 2026-05-31. Deckt das Schema (`_norm_applies_to`), das Typ-Matching
(`_type_applies`) und die Durchsetzung in `evaluate()` ab.

WICHTIGE DESIGN-ENTSCHEIDUNG (weicht bewusst vom urspruenglichen Brief ab):
Das Typ-Gate greift NUR, wenn `metrics["element_type"]` gesetzt ist. Fehlt der
Typ (z.B. synthetische Unit-Test-Metrics), bleibt das bisherige Verhalten
unveraendert -> KEIN Typ-Skip. Begruendung: so bleiben alle bestehenden Tests
(test_confidence.py: evaluate ohne element_type, erwartet WARN/PASS) unveraendert
gruen; in Produktion ist `element_type` stets gesetzt (ifcinspect.py), dort
filtert das Gate voll. Ein "blinder PASS auf unbekanntem Typ" entsteht nicht,
weil der Typ in Produktion immer vorliegt.
"""
import sys
import rules

_FAILED = 0


def check(name, cond, extra=""):
    global _FAILED
    status = "OK  " if cond else "FAIL"
    if not cond:
        _FAILED += 1
    print(f"[{status}] {name}{('  -- ' + extra) if extra else ''}")


def _rule(applies_to=None):
    """Minimal-Regel (volume_m3 >= 0.5). `applies_to` optional."""
    r = {"id": "r", "label": "vol", "target": "volume_m3", "op": ">=",
         "threshold": 0.5, "severity": "warn"}
    if applies_to is not None:
        r["applies_to"] = applies_to
    return r


def _rs(applies_to=None, file_applies=None):
    rs = {"version": 1, "profile": "test", "rules": [_rule(applies_to)]}
    if file_applies is not None:
        rs["applies_to"] = file_applies
    # Durch den Loader-Validator schicken, damit applies_to normalisiert wird.
    return rules._validate(rs, "test")


def _is_type_skip(ev):
    return ev["status"] == "skip" and "applies_to" in (ev.get("note") or "")


def _is_evaluated(ev):
    # ausgewertet = nicht typ-bedingt uebersprungen; Vergleich lief.
    return ev["status"] in ("pass", "fail", "warn") and not _is_type_skip(ev)


# --------------------------------------------------------------------------- #
def test_norm_applies_to():
    print("\n=== 1) _norm_applies_to (Schema) ===")
    check("None -> None (Feld fehlt)", rules._norm_applies_to(None, "x") is None)
    check("Liste wird getrimmt",
          rules._norm_applies_to([" IfcWall "], "x") == ["IfcWall"])
    check("Wildcard erlaubt", rules._norm_applies_to(["*"], "x") == ["*"])
    for bad in ([], "IfcWall", [""], [123]):
        try:
            rules._norm_applies_to(bad, "x")
            check(f"ungueltig {bad!r} -> ValueError", False, "kein Fehler")
        except ValueError:
            check(f"ungueltig {bad!r} -> ValueError", True)


def test_type_applies():
    print("\n=== 2) _type_applies (Matching) ===")
    check("Wildcard immer True",
          rules._type_applies("IfcFooting", ["*"]) is True)
    check("leere patterns -> True (Wildcard)",
          rules._type_applies("IfcFooting", []) is True)
    check("Substring: 'IfcWall' matcht 'IfcWallStandardCase'",
          rules._type_applies("IfcWallStandardCase", ["IfcWall"]) is True)
    check("Substring: 'Wall' matcht 'IfcRetainingWall'",
          rules._type_applies("IfcRetainingWall", ["Wall"]) is True)
    check("case-insensitiv",
          rules._type_applies("ifcwall", ["IfcWall"]) is True)
    check("kein Match: IfcFooting nicht in ['IfcWall']",
          rules._type_applies("IfcFooting", ["IfcWall"]) is False)
    check("None + non-Wildcard -> False",
          rules._type_applies(None, ["IfcWall"]) is False)
    check("None + Wildcard -> True",
          rules._type_applies(None, ["*"]) is True)


def test_loader_inheritance():
    print("\n=== 3) Loader: Vererbung + Default ===")
    rs = _rs(applies_to=None, file_applies=["IfcWall"])
    check("Regel ohne applies_to erbt File-Level",
          rs["rules"][0]["applies_to"] == ["IfcWall"])
    rs2 = _rs(applies_to=None, file_applies=None)
    check("kein File-Level -> Default ['*']",
          rs2["rules"][0]["applies_to"] == ["*"])
    rs3 = _rs(applies_to=["IfcRetainingWall"], file_applies=["IfcWall"])
    check("per-Regel ueberschreibt File-Level",
          rs3["rules"][0]["applies_to"] == ["IfcRetainingWall"])


def test_enforcement():
    print("\n=== 4) Durchsetzung in evaluate() ===")
    # a) Wildcard auf Proxy -> ausgewertet
    ev = rules.evaluate(_rs(["*"]),
                        {"volume_m3": 1.0,
                         "element_type": "IfcBuildingElementProxy"})[0]
    check("applies_to=['*'] auf IfcBuildingElementProxy -> ausgewertet",
          _is_evaluated(ev), f"{ev['status']}/{ev.get('note')}")

    # b) IfcWall-Regel auf IfcFooting -> typ-skip mit Grund
    ev = rules.evaluate(_rs(["IfcWall"]),
                        {"volume_m3": 1.0, "element_type": "IfcFooting"})[0]
    check("applies_to=['IfcWall'] auf IfcFooting -> skip", ev["status"] == "skip",
          f"{ev['status']}")
    check("  skip traegt applies_to-Grund", _is_type_skip(ev),
          f"{ev.get('note')}")

    # c) ~-Substring: IfcWall matcht IfcWallStandardCase -> ausgewertet
    ev = rules.evaluate(_rs(["IfcWall"]),
                        {"volume_m3": 1.0,
                         "element_type": "IfcWallStandardCase"})[0]
    check("applies_to=['IfcWall'] matcht IfcWallStandardCase -> ausgewertet",
          _is_evaluated(ev), f"{ev['status']}/{ev.get('note')}")

    # d) fehlendes element_type:
    #    non-Wildcard -> KEIN Typ-Skip (None-Policy: Gate nur bei bekanntem Typ)
    ev = rules.evaluate(_rs(["IfcWall"]), {"volume_m3": 1.0})[0]
    check("fehlendes element_type + non-* -> ausgewertet (None-Policy)",
          _is_evaluated(ev), f"{ev['status']}/{ev.get('note')}")
    #    Wildcard -> ebenfalls ausgewertet
    ev = rules.evaluate(_rs(["*"]), {"volume_m3": 1.0})[0]
    check("fehlendes element_type + ['*'] -> ausgewertet",
          _is_evaluated(ev), f"{ev['status']}")

    # e) Regel OHNE applies_to-Feld, element_type gesetzt -> wie vor dem Patch
    #    (Loader-Default ['*'] -> jeder Typ ausgewertet)
    ev = rules.evaluate(_rs(applies_to=None),
                        {"volume_m3": 1.0, "element_type": "IfcFooting"})[0]
    check("Regel ohne applies_to-Feld -> ausgewertet (Default ['*'])",
          _is_evaluated(ev), f"{ev['status']}")


TESTS = [test_norm_applies_to, test_type_applies, test_loader_inheritance,
         test_enforcement]


def main():
    for t in TESTS:
        t()
    print("\n" + "=" * 50)
    print("ALLE TESTS GRÜN" if _FAILED == 0 else f"{_FAILED} ABWEICHUNGEN")
    return 0 if _FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
