"""
report.py — Prüfprotokoll-Export für IfcInspect (JSON / HTML / CSV).

Erzeugt aus dem `ifcinspect.detect()`-`Result` ein strukturiertes
Prüfprotokoll-Dict (`build_report`) und exportiert es in drei Formate:

  • `to_json`  — vollständige Struktur (json.dumps, indent=2, UTF-8).
  • `to_csv`   — eine Zeile je Wand, alle flachen Kennwerte + Prüf-Status,
                 Semikolon-getrennt für DE-Excel.
  • `to_html`  — druckbare, in sich geschlossene HTML-Seite (eingebettetes
                 CSS, PASS=grün / WARN=orange / FAIL=rot, kein externes Asset).

PRÜFREGELN (L4): `default_ruleset()` lädt das gebundelte, strikt FHB-getreue
Ruleset `rules_astra_fhb_stuetzmauer.yaml` (echte ASTRA-Fachhandbuch-Werte).
Ein abweichendes Regelset kann der Nutzer per YAML/Dict überschreiben und an
`build_report(..., ruleset=...)` übergeben.

DESIGN-CONSTRAINTS:
  • Reine Standard-Library (json, csv via io.StringIO, datetime,
    html.escape, importlib.metadata). KEINE neuen Dependencies, KEIN
    trimesh/numpy — arbeitet ausschliesslich auf den fertigen dicts.
  • RAM-only: alle Exporte geben str zurück, schreiben NIE auf Disk
    (Pyodide-Kompatibilität).
  • Defensiv: fehlende/None-Felder oder wall_metrics mit "error"-Key →
    "n/a" statt Crash.
  • Deutsche Beschriftungen (Thesis ist auf Deutsch).
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from html import escape


# --------------------------------------------------------------------------- #
#  Version
# --------------------------------------------------------------------------- #
def _version() -> str:
    """Tool-Version best-effort aus importlib.metadata, sonst Fallback."""
    try:
        from importlib.metadata import version, PackageNotFoundError
        try:
            return version("ifcinspect")
        except PackageNotFoundError:
            return "0.1.0-dev"
    except Exception:
        return "0.1.0-dev"


# --------------------------------------------------------------------------- #
#  Defensive Helfer
# --------------------------------------------------------------------------- #
NA = "n/a"


def _g(d, *keys, default=None):
    """Verschachtelter dict-Zugriff, der bei None/fehlendem Key `default` liefert."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur if cur is not None else default


def _num(v, ndigits=3):
    """Zahl gerundet, None/nicht-numerisch → "n/a"."""
    if v is None:
        return NA
    try:
        f = float(v)
    except (TypeError, ValueError):
        return NA
    if f != f:                       # NaN
        return NA
    return round(f, ndigits)


def _fmt(v, ndigits=3):
    """Wie `_num`, aber gibt immer einen String für Tabellen/CSV zurück."""
    n = _num(v, ndigits)
    if n == NA:
        return NA
    return f"{n:.{ndigits}f}".rstrip("0").rstrip(".") if isinstance(n, float) else str(n)


# --------------------------------------------------------------------------- #
#  Pruefregeln (L4) - YAML-Ruleset via rules.py
# --------------------------------------------------------------------------- #
# Frueher hier hardcodete DEMO-Dict; jetzt durch `rules.load_ruleset()` und
# `rules.evaluate()` ersetzt. Schema-Migration: das interne Check-Dict
# {id,label,value,soll,status,einheit} wird beibehalten, damit HTML/CSV/JSON-
# Renderer unveraendert weiter funktionieren - lediglich die Werte stammen
# jetzt aus echten Regel-Evaluationen statt aus DEMO-Konstanten.
import rules as _rules_module


def default_ruleset() -> dict:
    """Lade das gebundelte, strikt FHB-getreue ASTRA-Ruleset.

    Frueher ein DEMO-Dict mit Konstanten; jetzt ein vollstaendiges, validiertes
    Ruleset aus `rules_astra_fhb_stuetzmauer.yaml` (DEFAULT_RULES_PATH; die alte
    `rules_astra_demo.yaml` ist nur noch ein veralteter Alias).
    """
    return _rules_module.load_ruleset()


def _soll_str(op: str, threshold: float, unit: str) -> str:
    """Menschliche Soll-Beschreibung: '>= 0.30 m', '<= 0.10' etc."""
    u = f" {unit}" if unit and unit != "ratio" else ""
    return f"{op} {threshold:g}{u}".rstrip()


def _check_from_eval(ev: dict) -> dict:
    """Mappe ein evaluate()-Ergebnis-dict auf das interne Check-Schema.

    {id,label,target,target_value,threshold,op,unit,severity,status,source}
        -> {id,label,value,soll,status,einheit}

    Status-Mapping: "pass"->"PASS", "fail"->"FAIL" (severity=fail) bzw. "WARN"
    (severity=warn), "warn"->"WARN", "info"->"INFO", "skip"->"SKIP" (nicht
    pruefbar). INFO (Wert erfuellt, aber nicht gesichert -- niedrige Confidence
    ODER offener Kontext-Teilcheck) und SKIP bleiben GETRENNT.
    """
    status_word = "INFO"   # Default = 'info': Wert erfuellt, Teilcheck offen
    if ev["status"] == "pass":
        status_word = "PASS"
    elif ev["status"] == "fail":
        status_word = "FAIL" if ev["severity"] == "fail" else "WARN"
    elif ev["status"] == "warn":
        # Confidence-Herabstufung (severity-unabhaengig) -> immer WARN.
        status_word = "WARN"
    elif ev["status"] == "skip":
        # Nicht pruef-/auswertbar -> SKIP ('Übersprungen'), NICHT als INFO.
        status_word = "SKIP"

    v = ev["target_value"]
    val_out = _num(v) if v is not None else NA
    out = {
        "id": ev["id"],
        "label": ev["label"],
        "value": val_out,
        "soll": _soll_str(ev["op"], ev["threshold"], ev.get("unit", "")),
        "status": status_word,
        "einheit": ev.get("unit", ""),
        # Zusatz-Felder fuer Audit/Quelle - werden vom HTML/CSV nicht zwingend
        # gerendert, aber sind im JSON-Export sichtbar.
        "target": ev["target"],
        "source": ev.get("source", ""),
        "severity": ev["severity"],
    }
    # Confidence-Felder (nur wenn die Regel min_confidence nutzte)
    if "confidence_score" in ev:
        out["confidence_score"] = ev.get("confidence_score")
        out["confidence_level"] = ev.get("confidence_level")
        out["min_confidence"] = ev.get("min_confidence")
        out["confidence_target"] = ev.get("confidence_target")
    if ev.get("note"):
        out["note"] = ev["note"]
    return out


def apply_rules(wm: dict, ruleset: dict | None = None,
                scene: dict | None = None) -> list:
    """Wende ein Ruleset auf ein wall_metrics-Dict an.

    Robust gegen fehlende Felder / `{"error": ...}`-wall_metrics
    (rules.evaluate() behandelt das intern als skip).
    Wenn `scene` mitgegeben wird, wird ein flaches Merge gemacht
    (`scene`-Key zusaetzlich erreichbar via "scene.distances[*]..." Dot-Path),
    damit L7-Regeln funktionieren ohne Pipeline-Refactor.
    Returns: list[Check-Dict] mit {id,label,value,soll,status,einheit,...}.
    """
    rs = ruleset or default_ruleset()
    checks = []

    if isinstance(wm, dict) and wm.get("prep_failed"):
        reason = wm.get("prep_failure_reason", "unbekannt")
        checks.append({
            "id": "prep_failed",
            "label": "Mesh-Reparatur",
            "value": str(reason),
            "soll": "watertight",
            "status": "INFO",
            "einheit": "",
        })
        for r in rs.get("rules", []):
            checks.append({
                "id": r["id"], "label": r["label"], "value": NA,
                "soll": _soll_str(r["op"], float(r["threshold"]),
                                  r.get("unit", "")),
                "status": "INFO", "einheit": r.get("unit", ""),
                "target": r["target"], "source": r.get("source", ""),
                "severity": r["severity"],
            })
        return checks

    if not isinstance(wm, dict) or "error" in wm:
        err = wm.get("error", "unbekannt") if isinstance(wm, dict) else "kein Dict"
        checks.append({
            "id": "metrics_error",
            "label": "Kenngroessen-Berechnung",
            "value": str(err),
            "soll": "fehlerfrei",
            "status": "INFO",
            "einheit": "",
        })
        # Pro Regel ein skip-Eintrag, damit das Protokoll vollstaendig bleibt.
        for r in rs.get("rules", []):
            checks.append({
                "id": r["id"], "label": r["label"], "value": NA,
                "soll": _soll_str(r["op"], float(r["threshold"]),
                                  r.get("unit", "")),
                "status": "INFO", "einheit": r.get("unit", ""),
                "target": r["target"], "source": r.get("source", ""),
                "severity": r["severity"],
            })
        return checks

    eval_input = wm
    if scene is not None:
        eval_input = dict(wm)
        eval_input["scene"] = scene
    evals = _rules_module.evaluate(rs, eval_input)
    return [_check_from_eval(e) for e in evals]


# --------------------------------------------------------------------------- #
#  Report-Aufbau
# --------------------------------------------------------------------------- #
def _wall_block(wm: dict, ruleset: dict, scene: dict | None = None) -> dict:
    """Ein Wand-Block des Protokolls aus einem wall_metrics-Dict.

    `scene` (optional): dict mit `distances`-Liste fuer L7-Regeln und
    Inspector-Anzeige. Wird in `pruefung` mit ausgewertet.
    """
    is_err = (not isinstance(wm, dict)) or ("error" in wm)
    is_skipped = bool(isinstance(wm, dict) and wm.get("prep_failed"))
    name = _g(wm, "element_name", default=NA) if isinstance(wm, dict) else NA
    guid = _g(wm, "element_guid", default=NA) if isinstance(wm, dict) else NA

    dims = _g(wm, "dimensions", default={}) or {}
    apc = _g(wm, "area_per_class", default={}) or {}
    batter = _g(wm, "batter", default={}) or {}
    slope = _g(wm, "slope", default={}) or {}
    thk = _g(wm, "thickness", default={}) or {}
    thn = _g(wm, "thickness_at_niche", default={}) or {}

    block = {
        "name": name,
        "guid": guid,
        "kenngroessen": {
            "volume_m3": _g(wm, "volume_m3"),
            "surface_area_m2": _g(wm, "surface_area_m2"),
            "dimensions": {
                "length": dims.get("length"),
                "height": dims.get("height"),
                "nominal_thickness": dims.get("nominal_thickness"),
            },
        },
        "klassifikation": {
            "area_per_class": {f"K{i}": apc.get(f"K{i}") for i in range(7)},
            "niche_count": _g(wm, "niches", "count", default=0),
            "niche_volume_m3": _g(wm, "niches", "total_volume_m3"),
        },
        "flaechenspezifisch": {
            "batter_front_deg": batter.get("front_deg"),
            "batter_front_ratio": batter.get("front_ratio"),
            "batter_back_deg": batter.get("back_deg"),
            "batter_back_ratio": batter.get("back_ratio"),
            "crown_slope_deg": slope.get("crown_deg"),
            "foundation_slope_deg": slope.get("foundation_deg"),
            # LAENGSgefaelle entlang Wandachse Vt[0] (additiv, n/a-fest)
            "crown_long_slope_deg": slope.get("crown_longitudinal_deg"),
            "crown_long_slope_percent": slope.get("crown_longitudinal_percent"),
            "foundation_long_slope_deg":
                slope.get("foundation_longitudinal_deg"),
            "foundation_long_slope_percent":
                slope.get("foundation_longitudinal_percent"),
        },
        # Kronenbreite-Aggregate (min/p10/avg) als eigener Block
        "crown_width": {
            "value": _g(wm, "crown_width_m"),
            "min": _g(wm, "crown_width_min_m"),
            "p10": _g(wm, "crown_width_p10_m"),
            "avg": _g(wm, "crown_width_avg_m"),
            "median": _g(wm, "crown_width_median_m"),
        },
        # Confidence-Sektion (immer mitgefuehrt; Anzeige filtert)
        "confidence": _g(wm, "confidence", default={}) or {},
        "wandstaerke": {
            "min": thk.get("min"),
            "max": thk.get("max"),
            "avg": thk.get("avg"),
            "median": thk.get("median"),
            "n_samples": thk.get("n_samples", 0),
        },
        "restwandstaerke_niche": {
            "min_global": thn.get("min_global"),
            "per_niche": thn.get("per_niche", []) or [],
        },
        "context": _g(wm, "context", default={}) or {},
        "pruefung": apply_rules(wm, ruleset, scene=scene),
    }
    if is_err:
        block["error"] = wm.get("error") if isinstance(wm, dict) else "kein Dict"
    if is_skipped:
        block["prep_failed"] = True
        block["prep_failure_reason"] = wm.get("prep_failure_reason",
                                              "unbekannt")
    return block


def build_report(result, model_name: str = "", ruleset: dict | None = None) -> dict:
    """Strukturiertes Prüfprotokoll-Dict aus einem detect()-Result.

    Args:
        result: `ifcinspect.Result` (oder ein dict mit denselben Feldern).
        model_name: anzuzeigender Modellname (z.B. Dateiname).
        ruleset: optionale Prüfregeln (überschreibt `default_ruleset()`).

    Returns: dict gemäss Auftrags-Schema (tool/version/.../walls/summary).
    """
    rs = ruleset or default_ruleset()

    # Result kann dataclass oder dict sein → tolerant lesen.
    def rget(name, default=None):
        if isinstance(result, dict):
            return result.get(name, default)
        return getattr(result, name, default)

    wall_metrics = rget("wall_metrics", []) or []
    scene = rget("scene", {}) or {}
    walls = [_wall_block(wm, rs, scene=scene) for wm in wall_metrics]

    # --- Summary ---
    n_walls = len(walls)
    n_niches_total = 0
    min_thk_vals = []
    min_res_vals = []
    n_fail = 0
    n_warn = 0
    for w in walls:
        n_niches_total += int(w["klassifikation"].get("niche_count") or 0)
        t = w["wandstaerke"].get("min")
        if t is not None:
            try:
                min_thk_vals.append(float(t))
            except (TypeError, ValueError):
                pass
        r = w["restwandstaerke_niche"].get("min_global")
        if r is not None:
            try:
                min_res_vals.append(float(r))
            except (TypeError, ValueError):
                pass
        for chk in w["pruefung"]:
            if chk["status"] == "FAIL":
                n_fail += 1
            elif chk["status"] == "WARN":
                n_warn += 1

    summary = {
        "n_walls": n_walls,
        "n_niches_total": n_niches_total,
        "min_thickness_global": (min(min_thk_vals) if min_thk_vals else None),
        "min_residual_niche_global": (min(min_res_vals) if min_res_vals else None),
        "n_fail": n_fail,
        "n_warn": n_warn,
    }

    return {
        "tool": "IfcInspect",
        "version": _version(),
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": model_name or rget("wall_name", "") or "",
        "method": rget("method", "classify") or "classify",
        "skipped_walls": list(rget("skipped_walls", []) or []),
        "ruleset": rs,
        "walls": walls,
        "scene": scene,
        "summary": summary,
    }


# --------------------------------------------------------------------------- #
#  Export: JSON
# --------------------------------------------------------------------------- #
def to_json(report_dict: dict) -> str:
    """Report als JSON-String (indent=2, UTF-8, kein Disk-Write)."""
    return json.dumps(report_dict, indent=2, ensure_ascii=False, default=str)


# --------------------------------------------------------------------------- #
#  Export: CSV
# --------------------------------------------------------------------------- #
def _csv_check_columns(report_dict: dict) -> list:
    """Stabile, vereinigte Liste aller Prüf-IDs über alle Wände (Spalten-Header)."""
    ids = []
    seen = set()
    for w in report_dict.get("walls", []):
        for chk in w.get("pruefung", []):
            cid = chk.get("id")
            if cid and cid not in seen:
                seen.add(cid)
                ids.append(cid)
    return ids


def to_csv(report_dict: dict) -> str:
    """Report als CSV-String — eine Zeile je Wand, Semikolon-getrennt (DE-Excel).

    Flache Kennwerte + je Prüf-ID eine Status-Spalte (Format
    "STATUS (value einheit)"). Kein Disk-Write.
    """
    check_ids = _csv_check_columns(report_dict)

    base_cols = [
        "name", "guid",
        "volume_m3", "surface_area_m2",
        "length", "height", "nominal_thickness",
        "niche_count", "niche_volume_m3",
        "K0", "K1", "K2", "K3", "K4", "K5", "K6",
        "batter_front_deg", "batter_front_ratio",
        "batter_back_deg", "batter_back_ratio",
        "crown_slope_deg", "foundation_slope_deg",
        "wandstaerke_min", "wandstaerke_max",
        "wandstaerke_avg", "wandstaerke_median", "wandstaerke_n",
        "restwandstaerke_niche_min",
    ]
    header = base_cols + [f"pruefung_{cid}" for cid in check_ids]

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\n")
    writer.writerow(header)

    for w in report_dict.get("walls", []):
        kg = w.get("kenngroessen", {})
        dims = kg.get("dimensions", {})
        kl = w.get("klassifikation", {})
        apc = kl.get("area_per_class", {})
        fs = w.get("flaechenspezifisch", {})
        ws = w.get("wandstaerke", {})
        rw = w.get("restwandstaerke_niche", {})

        row = [
            w.get("name", NA), w.get("guid", NA),
            _fmt(kg.get("volume_m3")), _fmt(kg.get("surface_area_m2")),
            _fmt(dims.get("length")), _fmt(dims.get("height")),
            _fmt(dims.get("nominal_thickness")),
            kl.get("niche_count", 0), _fmt(kl.get("niche_volume_m3")),
            _fmt(apc.get("K0")), _fmt(apc.get("K1")), _fmt(apc.get("K2")),
            _fmt(apc.get("K3")), _fmt(apc.get("K4")), _fmt(apc.get("K5")),
            _fmt(apc.get("K6")),
            _fmt(fs.get("batter_front_deg"), 2),
            fs.get("batter_front_ratio") or NA,
            _fmt(fs.get("batter_back_deg"), 2),
            fs.get("batter_back_ratio") or NA,
            _fmt(fs.get("crown_slope_deg"), 2),
            _fmt(fs.get("foundation_slope_deg"), 2),
            _fmt(ws.get("min")), _fmt(ws.get("max")),
            _fmt(ws.get("avg")), _fmt(ws.get("median")),
            ws.get("n_samples", 0),
            _fmt(rw.get("min_global")),
        ]

        chk_by_id = {c.get("id"): c for c in w.get("pruefung", [])}
        for cid in check_ids:
            c = chk_by_id.get(cid)
            if c is None:
                row.append("")
            else:
                val = c.get("value")
                unit = c.get("einheit", "")
                vstr = f" ({val} {unit})".rstrip().rstrip(")") + ")" \
                    if val not in (None, "") else ""
                row.append(f"{c.get('status', '')}{vstr}".strip())

        writer.writerow(row)

    return buf.getvalue()


# --------------------------------------------------------------------------- #
#  Export: HTML
# --------------------------------------------------------------------------- #
_HTML_CSS = """
:root { --pass:#1a7f37; --warn:#b86e00; --fail:#c1121f; --info:#555; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", Arial, sans-serif; color:#1d2127;
       margin: 0; padding: 24px; background:#f5f6f8; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.2rem; margin: 28px 0 6px; border-bottom:2px solid #d0d4da;
     padding-bottom:4px; }
h3 { font-size: .95rem; margin: 16px 0 4px; color:#3a4150; text-transform:uppercase;
     letter-spacing:.03em; }
.meta, .summary { background:#fff; border:1px solid #d8dce2; border-radius:8px;
                  padding:12px 16px; margin-bottom:16px; }
.meta div, .summary div { margin: 2px 0; font-size:.9rem; }
.summary .num { font-weight:700; }
.wall { background:#fff; border:1px solid #d8dce2; border-radius:8px;
        padding:16px 18px; margin-bottom:20px; }
table { border-collapse: collapse; width:100%; margin: 4px 0 10px; font-size:.88rem; }
th, td { text-align:left; padding:5px 9px; border-bottom:1px solid #e6e8ec; }
th { background:#eef0f3; font-weight:600; }
td.val { text-align:right; font-variant-numeric: tabular-nums; }
.badge { display:inline-block; padding:1px 9px; border-radius:11px; color:#fff;
         font-size:.78rem; font-weight:700; }
.badge.PASS { background:var(--pass); }
.badge.WARN { background:var(--warn); }
.badge.FAIL { background:var(--fail); }
.badge.INFO { background:var(--info); }
.cbadge { display:inline-block; padding:0 7px; border-radius:9px; color:#fff;
          font-size:.72rem; font-weight:700; margin-left:6px; }
.cbadge.hoch    { background:var(--pass); }
.cbadge.mittel  { background:var(--warn); }
.cbadge.niedrig { background:var(--fail); }
.cbadge.unbekannt { background:var(--info); }
.flag-fail { color:var(--fail); font-weight:700; }
.flag-warn { color:var(--warn); font-weight:700; }
.flag-ok   { color:var(--pass); font-weight:700; }
.note { font-size:.8rem; color:#777; font-style:italic; margin-top:6px; }
footer { font-size:.78rem; color:#888; margin-top:24px; }
@media print {
  body { background:#fff; padding:0; }
  .wall, .meta, .summary { border:1px solid #bbb; box-shadow:none;
                           break-inside: avoid; page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
}
"""


def _h(v):
    """HTML-escape, None/leer → "n/a"."""
    if v is None or v == "":
        return NA
    return escape(str(v))


def _row(label, value, einheit=""):
    val = value if value not in (None, "") else NA
    u = f" {escape(einheit)}" if einheit and val != NA else ""
    return f'<tr><th>{escape(label)}</th><td class="val">{_h(val)}{u}</td></tr>'


def _conf_badge(conf: dict | None) -> str:
    """Confidence-Ampel-Badge aus einem {score,level,basis}-Dict. n/a-fest."""
    if not isinstance(conf, dict):
        return ""
    lvl = conf.get("level") or "unbekannt"
    score = conf.get("score")
    sc = "" if score is None else f" {float(score):.2f}"
    title = escape(str(conf.get("basis") or ""))
    cls = escape(str(lvl))
    return (f'<span class="cbadge {cls}" title="{title}">'
            f'{escape(str(lvl))}{escape(sc)}</span>')


def _row_conf(label, value, einheit="", conf: dict | None = None):
    """Wie `_row`, haengt aber eine Confidence-Ampel an die Wert-Zelle."""
    val = value if value not in (None, "") else NA
    u = f" {escape(einheit)}" if einheit and val != NA else ""
    badge = _conf_badge(conf)
    return (f'<tr><th>{escape(label)}</th>'
            f'<td class="val">{_h(val)}{u}{badge}</td></tr>')


def _wall_html(w: dict) -> str:
    parts = [f'<div class="wall"><h2>{_h(w.get("name"))}</h2>',
             f'<div class="note">GUID: {_h(w.get("guid"))}</div>']

    if "error" in w:
        parts.append(f'<p class="flag-fail">Kenngrössen-Fehler: '
                     f'{_h(w.get("error"))}</p>')

    kg = w.get("kenngroessen", {})
    dims = kg.get("dimensions", {})
    parts.append("<h3>Kenngrössen</h3><table>")
    parts.append(_row("Volumen", _fmt(kg.get("volume_m3")), "m³"))
    parts.append(_row("Oberfläche", _fmt(kg.get("surface_area_m2")), "m²"))
    parts.append(_row("Länge", _fmt(dims.get("length")), "m"))
    parts.append(_row("Höhe", _fmt(dims.get("height")), "m"))
    parts.append(_row("Nominaldicke", _fmt(dims.get("nominal_thickness")), "m"))
    parts.append("</table>")

    kl = w.get("klassifikation", {})
    apc = kl.get("area_per_class", {})
    parts.append("<h3>Klassifikation</h3><table>")
    klass_labels = {
        "K0": "K0 Stirn +", "K1": "K1 Stirn −", "K2": "K2 Krone",
        "K3": "K3 Fundament", "K4": "K4 Front", "K5": "K5 Back",
        "K6": "K6 Schaleinlage",
    }
    for ki in range(7):
        key = f"K{ki}"
        parts.append(_row(f"Fläche {klass_labels[key]}", _fmt(apc.get(key)), "m²"))
    parts.append(_row("Anzahl Niches", kl.get("niche_count", 0)))
    parts.append(_row("Niche-Volumen", _fmt(kl.get("niche_volume_m3")), "m³"))
    parts.append("</table>")

    conf = w.get("confidence", {}) or {}
    c_slope = conf.get("slope")
    c_crown = conf.get("crown_width")
    c_thk = conf.get("thickness")

    fs = w.get("flaechenspezifisch", {})
    parts.append("<h3>Flächenspezifisch</h3><table>")
    parts.append(_row("Anzug Front", _fmt(fs.get("batter_front_deg"), 2), "°"))
    parts.append(_row("Anzug-Verhältnis Front", fs.get("batter_front_ratio")))
    parts.append(_row("Anzug Back", _fmt(fs.get("batter_back_deg"), 2), "°"))
    parts.append(_row("Anzug-Verhältnis Back", fs.get("batter_back_ratio")))
    parts.append(_row_conf("Querneigung Krone (gegen Hang)",
                           _fmt(fs.get("crown_slope_deg"), 2), "°", c_slope))
    parts.append(_row("Querneigung Fundament",
                      _fmt(fs.get("foundation_slope_deg"), 2), "°"))
    # LAENGSgefaelle (entlang Wandachse) — additiv, mit Confidence-Ampel
    parts.append(_row_conf(
        "Längsgefälle Krone (entlang Wand)",
        f'{_fmt(fs.get("crown_long_slope_deg"), 2)}° / '
        f'{_fmt(fs.get("crown_long_slope_percent"), 2)} %', "", c_slope))
    parts.append(_row(
        "Längsgefälle Fundament (entlang Wand)",
        f'{_fmt(fs.get("foundation_long_slope_deg"), 2)}° / '
        f'{_fmt(fs.get("foundation_long_slope_percent"), 2)} %'))
    parts.append("</table>")

    # ---- Mauerkronen-Breite (Aggregate min/p10/avg) ----
    cw = w.get("crown_width", {}) or {}
    if any(cw.get(k) is not None for k in ("value", "min", "p10", "avg")):
        parts.append("<h3>Mauerkronen-Breite</h3><table>")
        parts.append(_row_conf("Default (p10)", _fmt(cw.get("value")), "m",
                               c_crown))
        parts.append(_row("Min", _fmt(cw.get("min")), "m"))
        parts.append(_row("p10", _fmt(cw.get("p10")), "m"))
        parts.append(_row("Mittel", _fmt(cw.get("avg")), "m"))
        parts.append(_row("Median", _fmt(cw.get("median")), "m"))
        parts.append("</table>")

    ws = w.get("wandstaerke", {})
    parts.append("<h3>Wandstärke (Front → Back)</h3><table>")
    parts.append(_row_conf("Min", _fmt(ws.get("min")), "m", c_thk))
    parts.append(_row("Max", _fmt(ws.get("max")), "m"))
    parts.append(_row("Mittel", _fmt(ws.get("avg")), "m"))
    parts.append(_row("Median", _fmt(ws.get("median")), "m"))
    parts.append(_row("Messpunkte", ws.get("n_samples", 0)))
    parts.append("</table>")

    rw = w.get("restwandstaerke_niche", {})
    parts.append("<h3>Restwandstärke bei Niche</h3><table>")
    parts.append(_row("Min global", _fmt(rw.get("min_global")), "m"))
    parts.append("</table>")

    # ---- L5: internal context (stem <-> foundation) ----
    ctx = w.get("context", {}) or {}
    cint = ctx.get("internal", {}) or {}
    if cint:
        parts.append("<h3>L5 Kontext intern (Stem / Fundament)</h3><table>")
        parts.append(_row("Fundament vorhanden", cint.get("foundation_present")))
        parts.append(_row("Quelle", cint.get("source")))
        parts.append(_row("Confidence", cint.get("confidence_level")))
        if cint.get("overhang_tolerance_m") is not None:
            parts.append(_row("Ueberstand-Toleranz (Auflösung)",
                              _fmt(cint.get("overhang_tolerance_m")), "m"))
        parts.append(_row("Ueberstand links",
                          _fmt(cint.get("foundation_overhang_left_m")), "m"))
        parts.append(_row("Ueberstand rechts",
                          _fmt(cint.get("foundation_overhang_right_m")), "m"))
        parts.append(_row("Stem zentriert",
                          cint.get("stem_centered_on_foundation")))
        parts.append(_row("Gemeinsame Flaeche (Schnitt)",
                          _fmt(cint.get("shared_interface_area_m2")), "m²"))
        parts.append(_row("Fundament/Stem Volumen-Verhaeltnis",
                          _fmt(cint.get("foundation_to_stem_volume_ratio"))))
        parts.append("</table>")

    # ---- L6: external context (air/earth side) ----
    cext = ctx.get("external", {}) or {}
    if cext:
        parts.append("<h3>L6 Kontext extern (Luft-/Erdseite)</h3><table>")
        parts.append(_row("Luftseite", cext.get("air_side_face_class")))
        parts.append(_row("Erdseite", cext.get("earth_side_face_class")))
        parts.append(_row("Terrain vorhanden", cext.get("terrain_present")))
        parts.append(_row("Median Distanz Luftseite -> Terrain",
                          _fmt(cext.get("terrain_median_distance_air_m")), "m"))
        parts.append(_row("Median Distanz Erdseite -> Terrain",
                          _fmt(cext.get("terrain_median_distance_earth_m")), "m"))
        parts.append(_row("Quelle", cext.get("classification_source")))
        parts.append(_row("Confidence", cext.get("confidence_level")))
        parts.append("</table>")
    per = rw.get("per_niche", []) or []
    if per:
        parts.append('<table><tr><th>Niche</th><th class="val">Min [m]</th>'
                     '<th class="val">Messpunkte</th></tr>')
        for pn in per:
            parts.append(
                f'<tr><td>{_h(pn.get("niche"))}</td>'
                f'<td class="val">{_h(_fmt(pn.get("min")))}</td>'
                f'<td class="val">{_h(pn.get("n_samples", 0))}</td></tr>')
        parts.append("</table>")

    # ---- Confidence-Uebersicht (Eigen-Unsicherheit je Kennwert-Gruppe) ----
    if conf:
        parts.append("<h3>Confidence (Selbst-Einschätzung)</h3><table>")
        parts.append('<tr><th>Kennwert-Gruppe</th><th>Ampel</th>'
                     '<th>Basis</th></tr>')
        _grp_labels = {
            "classification": "Flächenklassifikation",
            "crown_width": "Mauerkronen-Breite",
            "thickness": "Wandstärke",
            "slope": "Neigung / Längsgefälle",
            "volume": "Volumen",
            "niches": "Schaleinlagen",
            "overall": "Gesamt",
        }
        for key in ("classification", "crown_width", "thickness", "slope",
                    "volume", "niches", "overall"):
            c = conf.get(key)
            if not isinstance(c, dict):
                continue
            parts.append(
                f'<tr><td>{escape(_grp_labels[key])}</td>'
                f'<td>{_conf_badge(c)}</td>'
                f'<td class="note" style="font-style:normal">'
                f'{_h(c.get("basis"))}</td></tr>')
        parts.append("</table>")

    # --- Prüfung ---
    parts.append("<h3>Prüfung</h3><table>")
    parts.append('<tr><th>Prüfpunkt</th><th>Wert</th><th>Soll</th>'
                 '<th>Status</th><th>Confidence</th></tr>')
    for chk in w.get("pruefung", []):
        st = chk.get("status", "INFO")
        val = chk.get("value")
        unit = chk.get("einheit", "")
        vstr = NA if val in (None, "") else f"{escape(str(val))} {escape(unit)}".strip()
        # Confidence-Spalte: nur wenn die Regel min_confidence nutzte.
        conf_cell = ""
        if "confidence_score" in chk:
            cscore = chk.get("confidence_score")
            clevel = chk.get("confidence_level") or "unbekannt"
            cs = "" if cscore is None else f" {float(cscore):.2f}"
            note = chk.get("note") or ""
            conf_cell = (f'<span class="cbadge {escape(str(clevel))}" '
                         f'title="{escape(str(note))}">'
                         f'{escape(str(clevel))}{escape(cs)}</span>')
        note_html = ""
        if chk.get("note") and st == "WARN":
            note_html = f'<div class="note">{_h(chk.get("note"))}</div>'
        parts.append(
            f'<tr><td>{_h(chk.get("label"))}{note_html}</td>'
            f'<td class="val">{vstr}</td>'
            f'<td class="val">{_h(chk.get("soll"))}</td>'
            f'<td><span class="badge {escape(st)}">{escape(st)}</span></td>'
            f'<td>{conf_cell}</td></tr>')
    parts.append("</table>")

    parts.append("</div>")
    return "".join(parts)


def to_html(report_dict: dict) -> str:
    """Report als vollständige, in sich geschlossene HTML-Seite (str, kein Disk-Write)."""
    s = report_dict.get("summary", {})
    n_fail = s.get("n_fail", 0)
    n_warn = s.get("n_warn", 0)
    overall_cls = "flag-fail" if n_fail else ("flag-warn" if n_warn else "flag-ok")
    overall_txt = "FAIL" if n_fail else ("WARN" if n_warn else "OK")

    rs = report_dict.get("ruleset", {}) or {}
    # Profil-Bezeichnung im Footer (vorher: "_note" aus DEMO-Dict).
    rs_note = rs.get("_note") or rs.get("profile") or ""

    parts = [
        "<!DOCTYPE html><html lang='de'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        f"<title>IfcInspect Prüfprotokoll — {_h(report_dict.get('model'))}</title>",
        f"<style>{_HTML_CSS}</style></head><body>",
        "<h1>IfcInspect — Prüfprotokoll</h1>",
        '<div class="meta">',
        f"<div><b>Tool:</b> {_h(report_dict.get('tool'))} "
        f"v{_h(report_dict.get('version'))}</div>",
        f"<div><b>Modell:</b> {_h(report_dict.get('model'))}</div>",
        f"<div><b>Methode:</b> {_h(report_dict.get('method'))}"
        + ((f"  <span class='flag-warn'>"
            f"({len(report_dict.get('skipped_walls') or [])} Wand(e) übersprungen — "
            f"Mesh-Reparatur fehlgeschlagen)</span>")
           if report_dict.get("skipped_walls") else "") + "</div>",
        f"<div><b>Erstellt:</b> {_h(report_dict.get('generated'))}</div>",
        "</div>",
    ]

    parts.append('<div class="summary"><h3>Zusammenfassung</h3>')
    parts.append(f'<div><b>Gesamtbewertung:</b> '
                 f'<span class="{overall_cls}">{overall_txt}</span></div>')
    parts.append(f'<div>Wände: <span class="num">{_h(s.get("n_walls"))}</span></div>')
    parts.append(f'<div>Niches gesamt: '
                 f'<span class="num">{_h(s.get("n_niches_total"))}</span></div>')
    parts.append(f'<div>Min. Wandstärke (global): '
                 f'<span class="num">{_h(_fmt(s.get("min_thickness_global")))}</span> m</div>')
    parts.append(f'<div>Min. Restwandstärke Niche (global): '
                 f'<span class="num">{_h(_fmt(s.get("min_residual_niche_global")))}</span> m</div>')
    parts.append(f'<div>FAIL: <span class="num flag-fail">{_h(n_fail)}</span> · '
                 f'WARN: <span class="num flag-warn">{_h(n_warn)}</span></div>')
    parts.append("</div>")

    # ---- L7: scene-wide distance table ----
    scene = report_dict.get("scene", {}) or {}
    dists = scene.get("distances", []) or []
    if dists:
        parts.append('<div class="wall"><h2>L7 Distanzen (Scene)</h2>')
        parts.append(f'<div class="note">{len(dists)} Paar(e) im AABB-Vorfilter '
                     f'(max 10 m).</div>')
        parts.append("<table>")
        parts.append('<tr><th>Von</th><th>Von-Typ</th>'
                     '<th>Nach</th><th>Nach-Typ</th>'
                     '<th class="val">Min-Distanz [m]</th>'
                     '<th class="val">Overlap-Volumen [m³]</th></tr>')
        for d in dists:
            ft = d.get("from_type") or NA
            tt = d.get("to_type") or NA
            parts.append(
                "<tr>"
                f"<td>{_h(d.get('from_name'))}</td>"
                f"<td>{_h(ft)}</td>"
                f"<td>{_h(d.get('to_name'))}</td>"
                f"<td>{_h(tt)}</td>"
                f'<td class="val">{_h(_fmt(d.get("min_distance_m")))}</td>'
                f'<td class="val">{_h(_fmt(d.get("overlap_volume_m3")))}</td>'
                "</tr>")
        parts.append("</table></div>")

    for w in report_dict.get("walls", []):
        parts.append(_wall_html(w))

    if rs_note:
        parts.append(f'<footer>{_h(rs_note)}</footer>')

    parts.append("</body></html>")
    return "".join(parts)


# --------------------------------------------------------------------------- #
#  Selbsttest
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    import os
    import sys

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    import ifcinspect as nd

    IFC = sys.argv[1] if len(sys.argv) > 1 else "web/public/demo/beispiel_nische.ifc"
    here = os.path.dirname(os.path.abspath(__file__))
    out_ifc = os.path.join(here, "_report_test_schaleinlagen.ifc")

    print(f"[report selbsttest] detect() auf {IFC}")
    res = nd.detect(IFC, out_ifc)

    rep = build_report(res, model_name=os.path.basename(IFC))

    js = to_json(rep)
    csv_s = to_csv(rep)
    html_s = to_html(rep)

    with open(os.path.join(here, "_report_test.json"), "w", encoding="utf-8") as f:
        f.write(js)
    with open(os.path.join(here, "_report_test.csv"), "w", encoding="utf-8") as f:
        f.write(csv_s)
    with open(os.path.join(here, "_report_test.html"), "w", encoding="utf-8") as f:
        f.write(html_s)

    print("\n===== JSON summary =====")
    print(json.dumps(rep["summary"], indent=2, ensure_ascii=False, default=str))
    print(f"\nWände im Protokoll: {len(rep['walls'])}")
    print(f"JSON  : {len(js)} chars")
    print(f"CSV   : {len(csv_s)} chars  (nicht-leer: {bool(csv_s.strip())})")
    print(f"HTML  : {len(html_s)} chars (nicht-leer: {bool(html_s.strip())})")
    print(f"\nGeschrieben: _report_test.json / .csv / .html in {here}")
