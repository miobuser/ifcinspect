"""
rules.py - YAML-Prueftregeln fuer den astra-wall-validator (IfcInspect).

Loesst die frueheren hardgecodeten DEMO-Schwellwerte in `report.py:default_ruleset()`
ab. Eine Regel-Sammlung (Ruleset) wird aus einer YAML-Datei geladen und gegen
einen `wall_metrics()`-Dict ausgewertet.

Schema (YAML):

    version: 1
    profile: "ASTRA FHB T/G - Stuetzmauer (Demo)"
    applies_to: ["IfcWall"] # OPTIONAL File-Level-Default fuer alle Regeln ohne
                            # eigenes `applies_to` (s.u.). Fehlt es -> ["*"].
    rules:
      - id: <kurzname>         # interne ID
        label: <Anzeigetext>   # Anzeige im Bericht
        target: <metric-key>   # Dot-Path in wall_metrics ODER composite-handler
        op: >= | <= | > | < | == | !=
        threshold: <zahl>
        unit: <einheit>
        source: <quellenangabe>
        applies_to: ["IfcWall", "IfcRetainingWall"]  # OPTIONAL. Liste von IFC-
                               # Typ-Mustern (case-insensitiver Substring-Match,
                               # "Wall" matcht IfcWallStandardCase/IfcRetaining-
                               # Wall). "*" = jeder Typ. Fehlt das Feld, erbt die
                               # Regel das File-Level-`applies_to`; fehlt auch
                               # das -> ["*"]. Durchgesetzt in `evaluate()` nur
                               # wenn `metrics["element_type"]` gesetzt ist.
        severity: fail | warn  # PASS bleibt PASS; bei verletzter Regel ist das
                               # Resultat FAIL (severity=fail) oder WARN
                               # (severity=warn).
        min_confidence: <0..1> # OPTIONAL. Mindest-Confidence des geprueften
                               # Werts. Liegt die Confidence darunter, wird das
                               # Ergebnis auf WARN herabgestuft (severity-
                               # unabhaengig); ist sie gar nicht ermittelbar ->
                               # SKIP. Ohne dieses Feld: unveraendertes Verhalten.
        confidence_target: <dot-path>  # OPTIONAL. Pfad zum passenden Confidence-
                               # Score, z.B. "confidence.crown_width.score". Wenn
                               # weggelassen, heuristisch aus `target` abgeleitet:
                               #   crown_width* -> confidence.crown_width.score
                               #   thickness.*  -> confidence.thickness.score
                               #   *slope*/*longitudinal*/*anzug*/*batter*
                               #                -> confidence.slope.score
                               #   volume*/*surface_area* -> confidence.volume.score
                               #   niche*       -> confidence.niches.score
                               #   sonst        -> confidence.overall.score

Confidence-Gating (Beispiel):

    - id: crown_min_width_confident
      label: "Mauerkrone Mindestbreite (nur bei verlaesslicher Geometrie)"
      target: "crown_width_min_m"
      op: ">="
      threshold: 0.30
      unit: "m"
      severity: "fail"
      min_confidence: 0.6        # < 0.6 Confidence -> WARN statt FAIL/PASS
      # confidence_target weggelassen -> heuristisch confidence.crown_width.score

Composite-Targets (kein Dot-Path im Metrics-Dict, werden hier berechnet):

  - "anzug_ratio"        -> tan(radians(batter.front_deg))
  - "niches_per_meter"   -> niches.count / dimensions.length

Listen-Aggregation (Targets der Form "a.b[...].c[:agg]"):

  Aggregiert eine Liste von Dicts (z.B. die L7-Paardistanzen unter
  "scene.distances"). Das `[...]` waehlt die Paare aus, der Dot-Path
  hinter `]` greift das Feld jedes Paares, `:agg` aggregiert.

    - "[*]"  -> KEIN Filter, aggregiert ueber ALLE Paare (abwaertskompatibel).
    - Filter-Syntax: kommagetrennte Bedingungen (UND-Verknuepfung) ueber die
      Keys `from_type,to_type,from_name,to_name`:
        * `key=value`   -> exakter Match (case-insensitive)
        * `key~=value`  -> Substring-Match (case-insensitive), robust gegen
                           IfcWall/IfcWallStandardCase/IfcRetainingWall bzw.
                           IfcRoad/IfcCourse/IfcPavement/IfcKerb.
      Der Filter matcht SYMMETRISCH: ein Paar erfuellt
      `from_type~=Wall,to_type~=Road` auch wenn Wall im `to`- und Road im
      `from`-Feld steht (Paare sind ungeordnet, i<j).
    - `:agg` aus {min,max,avg,count}; Default `min` (Clearance-Regeln nutzen
      meist ">= threshold").
    - Bleibt nach Filter KEIN Paar uebrig -> SKIP mit klarem Grund (nicht fail),
      damit "kein Strassen-Element im Modell" sauber SKIP ergibt.

  Beispiel (Mindestabstand Stuetzmauer<->Strasse):
    "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min"

Mess-MODI der L7-Distanz (additive Felder je Paar in scene.distances; eine Regel
waehlt den Modus, indem sie das Feld waehlt — die Listen-Aggregation greift jedes
Feld automatisch ueber den Dot-Path hinter `]`):

  - min_distance_m            -> kuerzeste 3D-Oberflaechendistanz (Default).
      "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min"
  - horizontal_distance_m     -> Abstand in der XY-Ebene (Z ignoriert, Grundriss).
      "scene.distances[from_type~=Wall, to_type~=Road].horizontal_distance_m:min"
  - vertical_distance_m       -> reiner Z-Spalt zwischen den Z-Intervallen.
      "scene.distances[from_type~=Wall, to_type~=Pipe].vertical_distance_m:min"
  - perpendicular_distance_m  -> Best-Effort entlang der Wand-Normalen (braucht
      eine wand-artige Referenz im Paar; sonst None -> SKIP). NAEHERUNG.
      "scene.distances[from_type~=Wall, to_type~=Road].perpendicular_distance_m:min"

Kronenbreite-Aggregation (Top-Level-Skalare im wall_metrics; eine Regel waehlt
die gewuenschte Aggregation aus denselben Stations-Samples):

  - crown_width_m       (= p10-Default), crown_width_min_m, crown_width_p10_m,
    crown_width_avg_m, crown_width_median_m
      Beispiel (strengste Variante): target "crown_width_min_m", op ">=".

Wandstaerke-Messrichtung (transparent benannt, immer senkrecht front->back):

  - thickness.min / thickness.avg / thickness.median  (Feld thickness.direction
    == "perpendicular_front_back" dokumentiert die Messrichtung).
      Beispiel: target "thickness.min", op ">=".

Andere `target`-Strings werden als Dot-Path interpretiert
(z.B. "thickness_at_niche.min_global" -> wm["thickness_at_niche"]["min_global"]).

Kontext-Teilchecks (generisch, ADDITIV, Registry `_CONTEXT_CHECKS`):

  Eine Regel kann -- zusaetzlich zum numerischen Hauptwert -- einen optionalen,
  KONTEXTABHAENGIGEN Teilpruefschritt deklarieren (Registry ruleId -> fn(wm) ->
  ("ok"|"fail"|"unavailable", reason)). Der Teilcheck laeuft NUR, wenn der
  Hauptwert bereits PASS ist:
    - Teilcheck "ok"          -> Status bleibt "pass" (reason in `note`).
    - Teilcheck "unavailable" -> Status "info" (Hauptwert erfuellt, Teilcheck
                                 mangels Daten nicht moeglich).
    - Teilcheck "fail"        -> severity-konform "warn" (severity=warn) bzw.
                                 "fail" (severity=fail).
  Regeln ohne Registry-Eintrag bleiben bit-identisch. Beispiel:
  `crown_slope_against_hill` (Hauptwert = Betrag des Kronen-Quergefaelles;
  Teilcheck = Richtung "gegen den Hang" aus context.external).

Status-Konvention im Output:

  - "pass"  : Regel anwendbar und erfuellt (inkl. ggf. bestandener Teilcheck)
  - "fail"  : Regel anwendbar und VERLETZT (severity wird durchgereicht)
  - "warn"  : Regel-Hauptwert verletzt bei severity=warn, ODER niedrige
              Confidence (min_confidence-Gating), ODER Kontext-Teilcheck
              verletzt bei severity=warn.
  - "info"  : Hauptwert erfuellt, aber ein deklarierter Kontext-Teilcheck ist
              mangels Daten NICHT pruefbar (Hinweis statt blindes PASS).
  - "skip"  : Metric fehlt / nicht berechenbar - Regel uebersprungen, Grund nach
              stderr geschrieben. Crasht NIE.

Reine Standard-Library + PyYAML.
"""
from __future__ import annotations

import math
import os
import sys
from typing import Any


# --------------------------------------------------------------------------- #
#  Defaults
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(os.path.abspath(__file__))
# Default-Set ist seit 2026-05-28 das strikt FHB-T/G-treue Ruleset
# (`rules_astra_fhb_stuetzmauer.yaml`). Plausibilitaets-Erweiterungen sind in
# `rules_plausibilitaet_optional.yaml` ausgelagert und werden nur via
# expliziten `--rules`-Pfad geladen. `rules_astra_demo.yaml` bleibt als
# Backward-Compat-Alias verfuegbar, ist aber inhaltlich identisch zum
# FHB-strikten Set.
DEFAULT_RULES_PATH = os.path.join(_HERE, "rules_astra_fhb_stuetzmauer.yaml")

_VALID_OPS = {">=", "<=", ">", "<", "==", "!="}
_VALID_SEV = {"fail", "warn"}
_REQUIRED_FIELDS = ("id", "label", "target", "op", "threshold", "severity")


# --------------------------------------------------------------------------- #
#  Schema-Validierung
# --------------------------------------------------------------------------- #
def _norm_applies_to(val: Any, ctx: str) -> list[str] | None:
    """Normalisiere ein `applies_to`-Feld auf `list[str]` (getrimmt).

    `None` (Feld fehlt) -> None (Aufrufer entscheidet ueber Vererbung/Default).
    Sonst: muss eine nicht-leere Liste nicht-leerer Strings sein, sonst
    ValueError mit `ctx` als Quelle. `"*"` ist als Wildcard erlaubt.
    """
    if val is None:
        return None
    if not isinstance(val, list) or not val:
        raise ValueError(f"{ctx} muss eine nicht-leere Liste von Strings sein, "
                         f"ist {val!r}")
    out: list[str] = []
    for x in val:
        if not isinstance(x, str) or not x.strip():
            raise ValueError(f"{ctx}: jeder Eintrag muss ein nicht-leerer "
                             f"String sein, ist {x!r}")
        out.append(x.strip())
    return out


# Brücke geometrisches Tool-Label <-> IFC-Typ-Vokabular.
# `metrics.py` klassifiziert das gepickte Element rein GEOMETRISCH und legt
# `element_type` ∈ {"Wand", "Platte/Fundament"} ab (groesseres Schalflaechen-
# Paar gewinnt; KEIN IFC-Typ — das Tool arbeitet bewusst semantikfrei). Die
# `applies_to`-Muster sind aber im IFC-Vokabular geschrieben (IfcWall, …).
# Diese Tabelle bildet jedes geometrische Label auf die zugehoerige IFC-Typ-
# Familie ab, sodass ein typgebundenes Muster wie ["IfcWall"] auf einer
# geometrisch als "Wand" erkannten Stuetzmauer greift. Bidirektional genutzt:
# ein Muster matcht, wenn es Substring des Labels ODER eines seiner Aliasse ist.
_GEOM_TYPE_ALIASES: dict[str, tuple[str, ...]] = {
    "wand": ("ifcwall", "wall", "retainingwall"),
    "platte/fundament": ("ifcslab", "slab", "ifcfooting", "footing", "platte",
                         "fundament"),
}


def _type_applies(elem_type: str | None, patterns: list[str] | None) -> bool:
    """True, wenn `elem_type` auf eines der `patterns` passt.

    - `"*"` in patterns (oder patterns leer/None) -> immer True (Wildcard).
    - Sonst case-insensitiver Substring-Match (analog zur L7-`~=`-Logik in
      `_cond_holds`): `"Wall"` matcht `IfcWall`, `IfcWallStandardCase`,
      `IfcRetainingWall`; `"IfcWall"` matcht `IfcWallStandardCase`.
    - Zusaetzlich greift die geometrische Label-Bruecke (`_GEOM_TYPE_ALIASES`):
      das tool-interne Label "Wand" erfuellt wall-Muster, "Platte/Fundament"
      erfuellt slab/footing-Muster. Damit funktionieren typgebundene Regeln
      (L5-L7-Kontext) auch ohne IFC-Semantik im Modell.
    - `elem_type is None` (Typ unbekannt) -> False, AUSSER Wildcard. Es gibt
      keinen blinden Treffer auf unbekanntem Typ. (Die Durchsetzung in
      `evaluate()` ueberspringt unbekannte Typen ohnehin, damit Aufrufer ohne
      `element_type` im Metrics-Dict unveraendert weiterlaufen.)
    """
    if not patterns or "*" in patterns:
        return True
    if elem_type is None:
        return False
    et = str(elem_type).lower()
    # Haystack = das Label selbst + seine IFC-Aliasse (geometrische Bruecke).
    hay = [et]
    for label, aliases in _GEOM_TYPE_ALIASES.items():
        if label in et:
            hay.extend(aliases)
    return any(any(p.lower() in h for h in hay) for p in patterns)


def _validate(rs: dict, src: str) -> dict:
    """Stelle sicher dass das geladene YAML dem Ruleset-Schema entspricht.

    Wirft ValueError mit Quelle (`src`) bei Verletzung.
    """
    if not isinstance(rs, dict):
        raise ValueError(f"{src}: Ruleset-Root muss ein Mapping sein, ist "
                         f"{type(rs).__name__}")
    rules = rs.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ValueError(f"{src}: 'rules' muss eine nicht-leere Liste sein")

    # File-Level-`applies_to` (optional) = Default-Vererbung fuer Regeln ohne
    # eigenes `applies_to`. Fehlt es auch hier -> Wildcard `["*"]`.
    file_applies = _norm_applies_to(rs.get("applies_to"), f"{src}: applies_to")

    seen_ids: set = set()
    for i, r in enumerate(rules):
        if not isinstance(r, dict):
            raise ValueError(f"{src}: rules[{i}] ist kein Mapping")
        for f in _REQUIRED_FIELDS:
            if f not in r:
                raise ValueError(f"{src}: rules[{i}] fehlt Pflichtfeld '{f}'")
        rid = r["id"]
        if rid in seen_ids:
            raise ValueError(f"{src}: doppelte Rule-id '{rid}'")
        seen_ids.add(rid)
        if r["op"] not in _VALID_OPS:
            raise ValueError(f"{src}: rules[{i}] ungueltiger op '{r['op']}', "
                             f"erlaubt: {sorted(_VALID_OPS)}")
        sev = str(r["severity"]).lower()
        if sev not in _VALID_SEV:
            raise ValueError(f"{src}: rules[{i}] ungueltige severity "
                             f"'{r['severity']}', erlaubt: {sorted(_VALID_SEV)}")
        r["severity"] = sev
        try:
            r["threshold"] = float(r["threshold"])
        except (TypeError, ValueError):
            raise ValueError(f"{src}: rules[{i}] threshold ist keine Zahl: "
                             f"{r['threshold']!r}")
        # OPTIONAL: min_confidence (float 0..1)
        if "min_confidence" in r and r["min_confidence"] is not None:
            try:
                mc = float(r["min_confidence"])
            except (TypeError, ValueError):
                raise ValueError(f"{src}: rules[{i}] min_confidence ist keine "
                                 f"Zahl: {r['min_confidence']!r}")
            if not (0.0 <= mc <= 1.0):
                raise ValueError(f"{src}: rules[{i}] min_confidence ausserhalb "
                                 f"[0,1]: {mc}")
            r["min_confidence"] = mc
        # OPTIONAL: confidence_target (dot-path string)
        if "confidence_target" in r and r["confidence_target"] is not None:
            if not isinstance(r["confidence_target"], str):
                raise ValueError(f"{src}: rules[{i}] confidence_target muss ein "
                                 f"String (Dot-Path) sein")
        # OPTIONAL: tolerance (float >= 0) — nur fuer op "==" wirksam, definiert
        # ein symmetrisches Band [threshold +/- tolerance] (Sollwert-Pruefung).
        if "tolerance" in r and r["tolerance"] is not None:
            try:
                tol = float(r["tolerance"])
            except (TypeError, ValueError):
                raise ValueError(f"{src}: rules[{i}] tolerance ist keine Zahl: "
                                 f"{r['tolerance']!r}")
            if tol < 0.0:
                raise ValueError(f"{src}: rules[{i}] tolerance < 0: {tol}")
            r["tolerance"] = tol
        # OPTIONAL: per-Regel `applies_to` (Liste von IFC-Typ-Mustern). Fehlt es,
        # erbt die Regel das File-Level-`applies_to`; fehlt auch das -> `["*"]`
        # (Wildcard = jeder Typ). So laufen Geometrie-Regeln (L1-L3) generisch
        # auf jedem IfcProduct, waehrend Kontext-/Distanz-Regeln (L5-L7) per
        # `applies_to: ["IfcWall", ...]` typgebunden werden koennen. Das
        # normalisierte Ergebnis wird auf der Regel als `applies_to` abgelegt und
        # in `evaluate()` durchgesetzt.
        rule_applies = _norm_applies_to(
            r.get("applies_to"), f"{src}: rules[{i}] applies_to")
        r["applies_to"] = rule_applies if rule_applies is not None else (
            file_applies if file_applies is not None else ["*"])
    return rs


# --------------------------------------------------------------------------- #
#  Loader
# --------------------------------------------------------------------------- #
def load_ruleset(path: str | None = None) -> dict:
    """Lade ein YAML-Ruleset.

    `path=None` -> bundle-default `rules_astra_fhb_stuetzmauer.yaml` neben
    dieser Datei (siehe `DEFAULT_RULES_PATH`).
    Validiert das Schema; wirft `ValueError` bei strukturellen Fehlern.
    """
    p = path or DEFAULT_RULES_PATH
    try:
        import yaml
    except ImportError as e:
        raise ImportError(
            "PyYAML wird fuer rules.load_ruleset() benoetigt "
            "(pip install pyyaml)") from e

    try:
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except FileNotFoundError:
        raise ValueError(f"Ruleset nicht gefunden: {p}")
    except yaml.YAMLError as e:
        raise ValueError(f"YAML-Parse-Fehler in {p}: {e}")

    return _validate(data, src=p)


# --------------------------------------------------------------------------- #
#  Target-Resolver
# --------------------------------------------------------------------------- #
def _resolve_dot(d: dict, key: str) -> Any:
    """Dot-Path-Lookup `a.b.c` in geschachteltem dict; None bei jeglicher Luecke."""
    cur: Any = d
    for k in key.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
        if cur is None:
            return None
    return cur


def _composite_anzug_ratio(wm: dict) -> tuple[float | None, str | None]:
    """Anzug-Ratio = tan(grösserer Anzug aus VORDER- UND RÜCKSEITE).

    Prüft BEIDE Wandseiten (front_deg/back_deg) und nimmt den STEILEREN Anzug.
    So spielt es keine Rolle, welche Fläche als K4/K5 (front/back) klassifiziert
    wurde — die effektiv geneigte (angezogene) Wandfläche wird immer erfasst.
    `batter.*_ratio` ist im wall_metrics ein String "1:n", daher aus dem Winkel
    rekonstruiert.
    """
    fd = _resolve_dot(wm, "batter.front_deg")
    bd = _resolve_dot(wm, "batter.back_deg")
    degs = []
    for d in (fd, bd):
        try:
            if d is not None:
                degs.append(abs(float(d)))
        except (TypeError, ValueError):
            pass
    if not degs:
        return None, "batter.front_deg/back_deg fehlt"
    return math.tan(math.radians(max(degs))), None


def _composite_niches_per_meter(wm: dict) -> tuple[float | None, str | None]:
    """Nischen-Dichte = niches.count / dimensions.length [1/m]."""
    n = _resolve_dot(wm, "niches.count")
    L = _resolve_dot(wm, "dimensions.length")
    if n is None or L is None:
        return None, "niches.count oder dimensions.length fehlt"
    try:
        L = float(L)
    except (TypeError, ValueError):
        return None, "dimensions.length nicht numerisch"
    if L <= 0:
        return None, "dimensions.length <= 0"
    return float(n) / L, None


def _composite_min_foundation_overhang(wm: dict) -> tuple[float | None, str | None]:
    """L5: min of (overhang_left, overhang_right). Used by foundation_min_overhang."""
    left = _resolve_dot(wm, "context.internal.foundation_overhang_left_m")
    right = _resolve_dot(wm, "context.internal.foundation_overhang_right_m")
    if left is None and right is None:
        return None, "context.internal.foundation_overhang_* fehlt"
    vals = [v for v in (left, right) if v is not None]
    try:
        return float(min(float(v) for v in vals)), None
    except (TypeError, ValueError):
        return None, "context.internal.foundation_overhang_* nicht numerisch"


def _composite_crown_slope_abs_percent(wm: dict) -> tuple[float | None, str | None]:
    """Betrag des Kronen-QUERgefaelles in Prozent (richtungsfrei).

    Hauptwert der Regel `crown_slope_against_hill`: prueft NUR, ob die Krone
    ueberhaupt das geforderte Quergefaelle (FHB 3 %) hat. Die Richtung ("gegen
    den Hang") wird separat vom Kontext-Teilcheck `_ctxcheck_crown_slope_*`
    bewertet (s. `_CONTEXT_CHECKS`), nicht hier.

    Quelle ist das vorzeichenbehaftete `slope.crown_drain_toward_front_percent`
    (+ = faellt nach +Vt[2]=K_FRONT=K4); hier wird der Betrag genommen, damit
    der Vergleich `== 3 % +/- tol` richtungsunabhaengig ist.
    """
    signed = _resolve_dot(wm, "slope.crown_drain_toward_front_percent")
    if signed is None:
        return None, "slope.crown_drain_toward_front_percent fehlt"
    try:
        return abs(float(signed)), None
    except (TypeError, ValueError):
        return None, "slope.crown_drain_toward_front_percent nicht numerisch"


_COMPOSITES = {
    "anzug_ratio": _composite_anzug_ratio,
    "niches_per_meter": _composite_niches_per_meter,
    "min_foundation_overhang": _composite_min_foundation_overhang,
    "crown_slope_abs_percent": _composite_crown_slope_abs_percent,
}


# --------------------------------------------------------------------------- #
#  List-aggregation handlers (mit Typ/Name-Filter)
# --------------------------------------------------------------------------- #
# When a target uses bracket notation (e.g. "scene.distances[*].min_distance_m"
# or "scene.distances[from_type~=Wall,to_type~=Road].min_distance_m:min"), the
# resolver selects the matching list items, walks them and applies an
# aggregation. The aggregation defaults to `min` (since most clearance/safety
# rules use ">= threshold"); can be overridden by suffix ":min"/":max"/":avg"/
# ":count".
#
# Filter-Keys (mindestens): from_type, to_type, from_name, to_name.
#   key=value  -> exakter (case-insensitive) Match
#   key~=value -> Substring-Match (case-insensitive)
# Mehrere Bedingungen kommagetrennt = UND. Der Filter matcht SYMMETRISCH:
# ein "from_*"/"to_*"-Bedingungspaar matcht auch bei vertauschten Rollen.
_PAIR_OPPOSITE = {
    "from_type": "to_type", "to_type": "from_type",
    "from_name": "to_name", "to_name": "from_name",
}
_FILTERABLE_KEYS = set(_PAIR_OPPOSITE)


def _parse_bracket(spec: str) -> tuple[list[tuple[str, str, str]] | None, str | None]:
    """Parse the content of '[...]' into a list of (key, op, value) conditions.

    Returns (conditions, error). `[*]` -> ([], None) = no filter.
    `op` is '=' (exact) or '~' (substring). On malformed input returns
    (None, error_message). Whitespace around keys/values is stripped.
    """
    spec = spec.strip()
    if spec == "*" or spec == "":
        return [], None
    conds: list[tuple[str, str, str]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "~=" in part:
            k, v = part.split("~=", 1)
            op = "~"
        elif "=" in part:
            k, v = part.split("=", 1)
            op = "="
        else:
            return None, f"filter condition '{part}' missing '=' or '~='"
        k = k.strip().lower()
        v = v.strip()
        if k not in _FILTERABLE_KEYS:
            return None, (f"filter key '{k}' not allowed "
                          f"(erlaubt: {sorted(_FILTERABLE_KEYS)})")
        conds.append((k, op, v))
    return conds, None


def _cond_holds(item: dict, key: str, op: str, value: str) -> bool:
    """True if `item[key]` matches `value` under `op` (case-insensitive)."""
    raw = item.get(key)
    if raw is None:
        return False
    hay = str(raw).lower()
    needle = value.lower()
    if op == "=":
        return hay == needle
    return needle in hay  # op == "~"


def _item_matches(item: dict, conds: list[tuple[str, str, str]]) -> bool:
    """Symmetric UND-match of all conditions against an (unordered) pair dict.

    A from_*/to_* condition also matches with swapped roles: the condition
    `from_type~=Wall` is satisfied if EITHER from_type OR to_type matches.
    Each condition is evaluated independently in symmetric mode so that a pair
    {from=Road, to=Wall} satisfies the conjunction (from_type~=Wall,
    to_type~=Road).
    """
    for key, op, value in conds:
        opp = _PAIR_OPPOSITE.get(key)
        ok = _cond_holds(item, key, op, value)
        if not ok and opp is not None:
            ok = _cond_holds(item, opp, op, value)
        if not ok:
            return False
    return True


def _resolve_list_aggregate(d: dict, key: str) -> tuple[Any, str | None]:
    """Handle targets of the form 'a.b[<filter>].c[:agg]'.

    `<filter>` is `*` (no filter) or comma-separated key(=|~=)value conditions
    over from_type/to_type/from_name/to_name (symmetric, case-insensitive).
    `:agg` in {min,max,avg,count}, default min.

    Returns (value, skip_reason). If the filter removes all pairs the result is
    a SKIP (value=None, reason set) — never a crash.
    """
    if "[" not in key or "]" not in key:
        return None, "no '[...]' selector in target"

    head, rest = key.split("[", 1)
    spec, tail = rest.split("]", 1)
    head = head.rstrip(".")
    tail = tail.lstrip(".")

    # aggregation suffix lives in the part AFTER the closing ']'
    agg = "min"
    if ":" in tail:
        tail, agg = tail.rsplit(":", 1)
        tail = tail.rstrip(".")

    conds, ferr = _parse_bracket(spec)
    if conds is None:
        return None, f"invalid filter '[{spec}]': {ferr}"

    lst = _resolve_dot(d, head) if head else d
    if not isinstance(lst, list):
        return None, f"target prefix '{head}' is not a list"
    if not lst:
        return None, f"target list '{head}' is empty"

    # 1) filter
    if conds:
        sel = [it for it in lst if isinstance(it, dict) and _item_matches(it, conds)]
        if not sel:
            return None, (f"no pair matches filter '[{spec}]' "
                          f"(z.B. kein passendes Strassen-/Wand-Element im Modell)")
    else:
        sel = [it for it in lst if isinstance(it, dict)]

    # 2) extract numeric field per selected item
    vals = []
    for item in sel:
        v = _resolve_dot(item, tail) if tail else item
        if v is None:
            continue
        try:
            vals.append(float(v))
        except (TypeError, ValueError):
            continue
    if not vals:
        return None, f"no numeric values for '{tail or '<item>'}' in '{head}'"

    # 3) aggregate
    if agg == "min":
        return min(vals), None
    if agg == "max":
        return max(vals), None
    if agg == "avg":
        return sum(vals) / len(vals), None
    if agg == "count":
        return float(len(vals)), None
    return None, f"unknown aggregation '{agg}'"


def _resolve_target(wm: dict, target: str) -> tuple[Any, str | None]:
    """Loese ein `target` zu einem numerischen Wert auf.

    Returns (value, skip_reason). Bei Erfolg ist skip_reason=None.
    Targets supported:
      - composite handler name (e.g. "anzug_ratio")
      - dot-path "a.b.c"
      - list aggregation "a.b[<filter>].c[:min|max|avg|count]" where <filter>
        is "*" or comma-separated key(=|~=)value conditions over
        from_type/to_type/from_name/to_name.
    """
    if target in _COMPOSITES:
        return _COMPOSITES[target](wm)
    if "[" in target and "]" in target:
        return _resolve_list_aggregate(wm, target)
    val = _resolve_dot(wm, target)
    if val is None:
        return None, f"metric '{target}' nicht im wall_metrics dict"
    return val, None


# --------------------------------------------------------------------------- #
#  Vergleich
# --------------------------------------------------------------------------- #
def _compare(value: float, op: str, threshold: float,
             tolerance: float | None = None) -> bool:
    # Optionales Toleranzband: op "==" mit `tolerance` t prueft das Intervall
    # [threshold - t, threshold + t]. Damit ist ein Sollwert (z.B. FHB-Kronen-
    # neigung 3 %) mit Messtoleranz pruefbar, ohne einen exakten Float-Vergleich.
    if tolerance is not None and op == "==":
        return abs(value - threshold) <= tolerance
    # Float-Rausch-Toleranz für Ungleichungen: ein Wert, der nur durch Float-/
    # Tessellierungs-Rauschen knapp über/unter der Schwelle liegt (z.B. eine
    # exakt mit 10:1 modellierte Wand: tan(atan(0.1)) = 0.10000008 > 0.10 → sonst
    # fälschlich WARN), soll an der Grenze noch greifen. Relativ zur Schwelle,
    # viel kleiner als jede echte Abweichung.
    eps = 1e-9 + 1e-4 * abs(threshold)
    if op == ">=":
        return value >= threshold - eps
    if op == "<=":
        return value <= threshold + eps
    if op == ">":
        return value > threshold - eps
    if op == "<":
        return value < threshold + eps
    if op == "==":
        return value == threshold
    if op == "!=":
        return value != threshold
    raise ValueError(f"unbekannter Operator: {op}")


# --------------------------------------------------------------------------- #
#  Confidence-Gating
# --------------------------------------------------------------------------- #
def _infer_confidence_target(target: str) -> str:
    """Leite heuristisch den passenden confidence.*-Score-Pfad aus `target` ab.

    Regeln (erste passende gewinnt):
      crown_width* -> confidence.crown_width.score
      thickness.*  -> confidence.thickness.score
      *slope* / slope.* / *longitudinal* -> confidence.slope.score
      volume*      -> confidence.volume.score
      niche*       -> confidence.niches.score
      sonst        -> confidence.overall.score
    """
    t = (target or "").lower()
    if "crown_width" in t:
        return "confidence.crown_width.score"
    if t.startswith("thickness.") or t == "thickness" or "thickness_at_niche" in t:
        return "confidence.thickness.score"
    if "slope" in t or "longitudinal" in t or "anzug" in t or "batter" in t:
        return "confidence.slope.score"
    if t.startswith("volume") or "volume_m3" in t or "surface_area" in t:
        return "confidence.volume.score"
    if "niche" in t:
        return "confidence.niches.score"
    return "confidence.overall.score"


def _lookup_confidence(wm: dict, target: str,
                       explicit: str | None) -> tuple[float | None, str]:
    """(score, score_path). Score ist None, wenn nicht ermittelbar.

    `explicit` ist ein optionaler confidence_target-Dot-Path; sonst heuristisch.
    Defensiv: jeder fehlende Knoten -> (None, path).
    """
    path = explicit or _infer_confidence_target(target)
    val = _resolve_dot(wm, path)
    if val is None:
        return None, path
    try:
        return float(val), path
    except (TypeError, ValueError):
        return None, path


# --------------------------------------------------------------------------- #
#  Kontext-Teilchecks (generischer Mechanismus, ADDITIV)
# --------------------------------------------------------------------------- #
# Eine Regel kann -- zusaetzlich zum numerischen Hauptwert -- einen optionalen,
# KONTEXTABHAENGIGEN Teilpruefschritt haben (z.B. "Gefaelle in die richtige
# Richtung"). Dieser laeuft NUR, wenn der Hauptwert bereits PASS ist:
#
#   Hauptwert FAIL                       -> Teilcheck irrelevant, Status bleibt
#                                           severity-konform (warn|fail).
#   Hauptwert PASS, KEIN Teilcheck       -> 'pass' (unveraendert).
#   Hauptwert PASS, Teilcheck 'ok'       -> 'pass' (mit reason).
#   Hauptwert PASS, Teilcheck 'fail'     -> severity-konform 'warn' (severity=
#                                           warn) bzw. 'fail' (severity=fail).
#   Hauptwert PASS, Teilcheck 'unavail.' -> 'info' (Hauptwert erfuellt, aber der
#                                           Teilcheck mangels Daten nicht
#                                           pruefbar -> Hinweis statt blindes
#                                           PASS).
#
# Eine Kontext-Check-Funktion bekommt das volle wall_metrics-Dict und liefert
# (verdict, reason) mit verdict in {"ok","fail","unavailable"}. Sie wirft NIE;
# der Aufrufer kapselt sie zusaetzlich defensiv (jede Exception -> 'unavailable').
# Registriert wird pro Regel-ID (analog _COMPOSITES). Nur Regeln mit Eintrag in
# _CONTEXT_CHECKS bekommen einen Teilcheck -- alle anderen Regeln bleiben
# bit-identisch im Verhalten.

# Face-Klassen-Konvention (aus metrics.py): K4 = +Vt[2] (K_FRONT),
# K5 = -Vt[2] (K_BACK). Das vorzeichenbehaftete Kronen-Quergefaelle
# `slope.crown_drain_toward_front_percent` ist positiv, wenn die Krone nach
# +Vt[2] (=K4) faellt, negativ wenn nach -Vt[2] (=K5).
_AIR_SIDE_EXPECTED_SIGN = {"K4": +1.0, "K5": -1.0}


def _ctxcheck_crown_slope_against_hill(wm: dict) -> tuple[str, str]:
    """Richtungs-Teilcheck der Kronenneigung: faellt das Gefaelle zur LUFTSEITE
    (weg vom Hang)?

    Pruefbar nur, wenn aus `context.external` eine eindeutige Luftseite
    vorliegt: terrain_present UND side_clear UND air_side_face_class in
    {'K4','K5'}. Dann muss das VORZEICHEN von
    `slope.crown_drain_toward_front_percent` zur Luftseite zeigen:
      air=K4 (=+Vt[2]) -> Gefaelle muss positiv sein,
      air=K5 (=-Vt[2]) -> Gefaelle muss negativ sein.

    Returns (verdict, reason):
      'ok'          : Richtung stimmt (faellt zur Luftseite).
      'fail'        : Richtung falsch (faellt zum Hang statt zur Luftseite).
      'unavailable' : Richtung nicht pruefbar (kein Terrain / nicht side_clear /
                      Luftseite unbestimmt / Gefaelle-Vorzeichen ~0 oder fehlt).
    NIE raise (der Aufrufer kapselt zusaetzlich).
    """
    ext = _resolve_dot(wm, "context.external")
    if not isinstance(ext, dict):
        return "unavailable", "Richtung gegen Hang nicht pruefbar: kein L6-Kontext"
    terrain = bool(ext.get("terrain_present"))
    side_clear = bool(ext.get("side_clear"))
    air = ext.get("air_side_face_class")
    if not terrain:
        return ("unavailable",
                "Richtung gegen Hang nicht pruefbar: kein Terrain")
    if not side_clear:
        return ("unavailable",
                "Richtung gegen Hang nicht pruefbar: Erdseite nicht eindeutig "
                "(side_clear=False)")
    expected_sign = _AIR_SIDE_EXPECTED_SIGN.get(str(air) if air is not None else "")
    if expected_sign is None:
        return ("unavailable",
                f"Richtung gegen Hang nicht pruefbar: Luftseite unbestimmt "
                f"(air_side_face_class={air!r})")
    signed = _resolve_dot(wm, "slope.crown_drain_toward_front_percent")
    if signed is None:
        return ("unavailable",
                "Richtung gegen Hang nicht pruefbar: Kronen-Gefaelle-Vorzeichen "
                "fehlt")
    try:
        s = float(signed)
    except (TypeError, ValueError):
        return ("unavailable",
                "Richtung gegen Hang nicht pruefbar: Kronen-Gefaelle nicht "
                "numerisch")
    if abs(s) < 1e-6:
        return ("unavailable",
                "Richtung gegen Hang nicht pruefbar: Kronen-Gefaelle ~0 "
                "(keine Richtung)")
    if s * expected_sign > 0:
        return ("ok",
                f"Gefaelle faellt zur Luftseite ({air}) = weg vom Hang")
    return ("fail",
            f"Gefaelle faellt zum Hang statt zur Luftseite ({air})")


_CONTEXT_CHECKS = {
    "crown_slope_against_hill": _ctxcheck_crown_slope_against_hill,
}


def _run_context_check(rid: str, metrics: dict) -> tuple[str, str] | None:
    """Fuehre den fuer `rid` registrierten Kontext-Teilcheck aus.

    Returns (verdict, reason) mit verdict in {"ok","fail","unavailable"} ODER
    None, wenn fuer diese Regel kein Teilcheck registriert ist. Jede Exception
    der Check-Funktion -> ('unavailable', <grund>), nie eine Weitergabe.
    """
    fn = _CONTEXT_CHECKS.get(rid)
    if fn is None:
        return None
    try:
        verdict, reason = fn(metrics)
        if verdict not in ("ok", "fail", "unavailable"):
            return ("unavailable",
                    f"Kontext-Check lieferte unbekanntes Verdikt {verdict!r}")
        return verdict, reason
    except Exception as e:  # pragma: no cover - defensiv, darf NIE crashen
        sys.stderr.write(
            f"[rules] context-check '{rid}' raised "
            f"{type(e).__name__}: {e} -> unavailable\n")
        return ("unavailable",
                f"Richtung nicht pruefbar (Kontext-Check-Fehler "
                f"{type(e).__name__})")


# --------------------------------------------------------------------------- #
#  Evaluation
# --------------------------------------------------------------------------- #
def evaluate(ruleset: dict, metrics: dict) -> list[dict]:
    """Evaluiere alle Regeln eines Ruleset gegen ein wall_metrics-Dict.

    Returns: Liste je Regel von dict
        {id, label, target, target_value, threshold, op, unit, severity,
         status: "pass"|"fail"|"warn"|"info"|"skip", source}

    Status-Erweiterung (ADDITIV): "info" entsteht auf zwei Wegen, beide
    thesis-konform (Kap. 4: INFO = "ein erfuelltes, wegen zu geringer Konfidenz
    aber nicht gesichertes Kriterium"):
      (a) min_confidence-Gating: Hauptwert PASS, aber confidence_score liegt
          unter min_confidence -> "info" (erfuellt, aber nicht gesichert).
          Eine bereits verletzte Pruefung (fail) bleibt fail -- niedrige
          Konfidenz beschoenigt keine Verletzung. Ist die Confidence gar nicht
          ermittelbar -> "skip" (Kennwert/Konfidenz nicht verfuegbar).
      (b) generischer Kontext-Teilcheck (_CONTEXT_CHECKS): Hauptwert PASS, aber
          ein deklarierter kontextabhaengiger Teilpruefschritt ist mangels Daten
          NICHT moeglich -> "info" (context_check="unavailable", context_reason
          traegt den Grund). Bei verfuegbarem Kontext: ok -> bleibt PASS;
          verletzt -> severity-konform warn/fail.
    """
    results: list[dict] = []
    for r in ruleset.get("rules", []):
        rid = r["id"]
        target = r["target"]
        op = r["op"]
        thr = float(r["threshold"])

        out = {
            "id": rid,
            "label": r["label"],
            "target": target,
            "target_value": None,
            "threshold": thr,
            "op": op,
            "unit": r.get("unit", ""),
            "severity": r["severity"],
            "status": "skip",
            "source": r.get("source", ""),
        }

        # ---- Typ-Gate (`applies_to`) -------------------------------------- #
        # Greift nur, wenn der Element-Typ im Metrics-Dict bekannt ist. Fehlt
        # `element_type` (z.B. synthetische Unit-Test-Metrics), bleibt das
        # bisherige Verhalten unveraendert -> kein Typ-Skip. In Produktion ist
        # der Typ stets gesetzt (ifcinspect.py), dort filtert das Gate voll.
        patterns = r.get("applies_to")  # vom Loader normalisiert (immer Liste)
        elem_type = metrics.get("element_type") if isinstance(metrics, dict) \
            else None
        if elem_type is not None and not _type_applies(elem_type, patterns):
            out["note"] = (f"Typ '{elem_type}' nicht in applies_to "
                           f"{patterns} -> uebersprungen")
            sys.stderr.write(
                f"[rules] skip '{rid}': Typ '{elem_type}' nicht in "
                f"applies_to {patterns}\n")
            results.append(out)
            continue

        # metrics fehlerhaft (z.B. {"error": ...}) ODER Wand wurde wegen
        # nicht-watertight Mesh übersprungen (prep_failed) -> alles skip
        if not isinstance(metrics, dict) or "error" in metrics:
            sys.stderr.write(
                f"[rules] skip '{rid}': wall_metrics enthaelt Fehler "
                f"({metrics.get('error') if isinstance(metrics, dict) else type(metrics).__name__})\n")
            results.append(out)
            continue
        if metrics.get("prep_failed"):
            sys.stderr.write(
                f"[rules] skip '{rid}': Wand wegen prep_failed übersprungen "
                f"({metrics.get('prep_failure_reason', '?')})\n")
            results.append(out)
            continue

        val, reason = _resolve_target(metrics, target)
        if val is None:
            sys.stderr.write(f"[rules] skip '{rid}': {reason}\n")
            results.append(out)
            continue

        try:
            num = float(val)
        except (TypeError, ValueError):
            sys.stderr.write(
                f"[rules] skip '{rid}': target '{target}' = {val!r} "
                f"nicht numerisch\n")
            results.append(out)
            continue

        out["target_value"] = num
        tol = r.get("tolerance")
        passed = _compare(num, op, thr, tol)
        out["status"] = "pass" if passed else "fail"
        if tol is not None:
            out["tolerance"] = float(tol)

        # ---- Confidence-Gating (abwaertskompatibel) ----
        min_conf = r.get("min_confidence")
        if min_conf is not None:
            conf_score, conf_path = _lookup_confidence(
                metrics, target, r.get("confidence_target"))
            out["min_confidence"] = float(min_conf)
            out["confidence_target"] = conf_path
            out["confidence_score"] = conf_score
            if conf_score is None:
                # Confidence gar nicht ermittelbar -> SKIP (kein blinder PASS/FAIL)
                out["confidence_level"] = "unbekannt"
                out["status"] = "skip"
                out["note"] = (f"Confidence nicht ermittelbar ({conf_path}) "
                               f"-> uebersprungen")
                sys.stderr.write(
                    f"[rules] skip '{rid}': Confidence nicht ermittelbar "
                    f"({conf_path}), min_confidence={min_conf}\n")
            else:
                # Confidence-Level bestimmen (Ampel, lokal um Import-Zyklus zu
                # vermeiden)
                if conf_score >= 0.80:
                    lvl = "hoch"
                elif conf_score >= 0.50:
                    lvl = "mittel"
                else:
                    lvl = "niedrig"
                out["confidence_level"] = lvl
                if conf_score < float(min_conf):
                    # Thesis-Definition (Kap. 4, severity/Status): INFO = "ein
                    # erfuelltes, wegen zu geringer Konfidenz aber nicht
                    # gesichertes Kriterium". Ein technisch erfuelltes PASS, das
                    # auf einem unzuverlaessigen Kennwert beruht, wird daher auf
                    # INFO herabgestuft -- NICHT auf WARN (WARN ist laut Thesis
                    # die Verletzung eines nicht zwingenden Kriteriums).
                    # Eine bereits verletzte Pruefung (FAIL/WARN) bleibt
                    # unveraendert: niedrige Konfidenz darf eine Verletzung nicht
                    # zu einem milderen INFO beschoenigen ("nicht gesichert"
                    # setzt ein erfuelltes Kriterium voraus).
                    prev = out["status"]
                    if prev == "pass":
                        out["status"] = "info"
                        out["note"] = (f"erfuellt, aber niedrige Confidence "
                                       f"({conf_score:.2f} < {float(min_conf):.2f}) "
                                       f"-> nicht gesichert (INFO)")
                        sys.stderr.write(
                            f"[rules] info '{rid}': erfuellt, aber niedrige "
                            f"Confidence ({conf_score:.2f} < {min_conf})\n")
                    else:
                        # prev war 'fail' -> Verletzung steht; nur Notiz ergaenzen.
                        out["note"] = (f"{out.get('note', '')}"
                                       f" (zudem niedrige Confidence "
                                       f"{conf_score:.2f} < {float(min_conf):.2f})").strip()
                        sys.stderr.write(
                            f"[rules] keep '{rid}' status={prev}: Verletzung "
                            f"steht trotz niedriger Confidence "
                            f"({conf_score:.2f} < {min_conf})\n")

        # ---- Kontext-Teilcheck (generisch, ADDITIV) ----
        # Greift NUR, wenn der Hauptwert (nach evtl. Confidence-Gating) noch
        # 'pass' ist UND fuer diese Regel-ID ein Teilcheck registriert ist.
        # Regeln ohne Eintrag in _CONTEXT_CHECKS bleiben unveraendert.
        if out["status"] == "pass":
            ctx_res = _run_context_check(rid, metrics)
            if ctx_res is not None:
                verdict, ctx_reason = ctx_res
                out["context_check"] = verdict
                out["context_reason"] = ctx_reason
                if verdict == "ok":
                    # Hauptwert UND Richtung ok -> bleibt PASS.
                    out["note"] = ctx_reason
                elif verdict == "unavailable":
                    # Hauptwert erfuellt, Teilcheck mangels Daten nicht moeglich
                    # -> INFO (Hinweis statt blindes PASS), kein FAIL/WARN.
                    out["status"] = "info"
                    out["note"] = ctx_reason
                    sys.stderr.write(
                        f"[rules] info '{rid}': {ctx_reason}\n")
                else:  # verdict == "fail"
                    # Hauptwert erfuellt, aber Richtung verletzt -> severity-
                    # konform abstufen (warn bei severity=warn, fail bei
                    # severity=fail). Kein blindes PASS.
                    out["status"] = "warn" if out["severity"] == "warn" \
                        else "fail"
                    out["note"] = ctx_reason
                    sys.stderr.write(
                        f"[rules] {out['status']} '{rid}': {ctx_reason}\n")

        results.append(out)

    return results


__all__ = ["DEFAULT_RULES_PATH", "load_ruleset", "evaluate"]
