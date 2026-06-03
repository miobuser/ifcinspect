// Element-zentriertes Prüfprotokoll als echtes PDF (pdfmake).
//
// Gruppiert pro Stützmauer × Regel (deriveGroupedIssues), ein isolierter
// Screenshot je Befund (das am stärksten verletzende Element, light-Hintergrund,
// nur das betroffene Bauteil solid + Wireframe), mit Bauteil-Name/GUID, Ist/Soll
// und der Liste aller betroffenen Elemente. Ersetzt den bisherigen HTML-Export.

// @ts-ignore -- pdfmake liefert keine Typen für die /build/-Pfade
import pdfMake from "pdfmake/build/pdfmake";
// @ts-ignore
import pdfFonts from "pdfmake/build/vfs_fonts";
import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";
import { deriveGroupedIssues, refineIssueAnnotation, type Issue } from "./issues";
import { buildDimensionAnnotation } from "./annotation";
import { statusLabel } from "./i18n";
import { showBusy, hideBusy } from "./progress";
import type { DetectionResult } from "./types";

// vfs (eingebettete Roboto-Fonts) versionsrobust setzen. In pdfmake 0.2.23 IST
// der vfs_fonts-Default-Export direkt das Dict { "Roboto-Regular.ttf": "<b64>", … };
// aeltere Versionen verschachteln unter .pdfMake.vfs / .vfs. Beide Formen abdecken,
// sonst wirft createPdf im Browser "Roboto-Regular.ttf not found in vfs".
const _ff = pdfFonts as any;
const _vfs =
  _ff?.pdfMake?.vfs ?? _ff?.vfs ?? _ff?.default?.pdfMake?.vfs ?? _ff?.default ?? _ff;
if (_vfs && typeof _vfs === "object") (pdfMake as any).vfs = _vfs;

// Vollständige Glyphen-Abdeckung: das pdfmake-Standard-Roboto kann technische/
// typografische Zeichen NICHT (⌀ ≤ ≥ → ≈ ✓ ✗ ∅ …) → sie würden im PDF fehlen.
// Wir registrieren zusätzlich eine subset-DejaVu-Sans-Familie (lazy, eigener
// Chunk) und nutzen sie als Standard-Font des Protokolls. Fällt der Lazy-Load
// aus, bleibt Roboto die sichere Rückfallebene.
let _dejavuReady: boolean | null = null;
async function ensureDejaVu(): Promise<boolean> {
  if (_dejavuReady !== null) return _dejavuReady;
  try {
    const { DEJAVU_VFS } = await import("./fonts-pdf");
    const vfs = ((pdfMake as any).vfs ||= {});
    Object.assign(vfs, DEJAVU_VFS);
    (pdfMake as any).fonts = {
      Roboto: {
        normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf",
        italics: "Roboto-Italic.ttf", bolditalics: "Roboto-MediumItalic.ttf",
      },
      DejaVu: {
        normal: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf",
        italics: "DejaVuSans-Oblique.ttf", bolditalics: "DejaVuSans-BoldOblique.ttf",
      },
    };
    _dejavuReady = true;
  } catch {
    _dejavuReady = false;   // Roboto-Fallback (defaultStyle.font bleibt ungesetzt)
  }
  return _dejavuReady;
}

// captureIssueSnapshot-kompatible Signatur (liefert PNG-dataURL oder null).
export type SnapshotCapture = (o: {
  view: Issue["view"];
  section?: Issue["section"];
  light?: boolean;
  keepGuids?: string[] | null;
  highlightClass?: string | null;
  classKey?: string | null;
  annotation?: object | null;
  width?: number;
  height?: number;
  toolLook?: boolean;
}) => string | null;

// THREE-Group (Maßlinien-Annotation) entsorgen, ohne THREE zu importieren.
function disposeObj(o: any): void {
  o?.traverse?.((c: any) => {
    c.geometry?.dispose?.();
    const m = c.material;
    if (Array.isArray(m)) m.forEach((x: any) => { x?.map?.dispose?.(); x?.dispose?.(); });
    else if (m) { m.map?.dispose?.(); m.dispose?.(); }
  });
}

const STATUS_COLOR: Record<string, string> = {
  PASS: "#2e7d32", FAIL: "#c62828", WARN: "#f57f17", INFO: "#1f7fb8", SKIP: "#777777",
};
// Reihenfolge: Nicht bestanden > Warnung > Info > Übersprungen > Bestanden.
const STATUS_ORDER: Record<string, number> = { FAIL: 0, WARN: 1, INFO: 2, SKIP: 3, PASS: 4 };

type Wm = {
  element_guid?: string;
  element_name?: string;
  dimensions?: {
    length?: number;
    height?: number;
    nominal_thickness?: number;
    height_local?: { min?: number | null; max?: number | null; avg?: number | null; median?: number | null; n?: number };
    developed_length?: { front_top?: number | null; front_bottom?: number | null; back_top?: number | null; back_bottom?: number | null; min?: number | null; max?: number | null; avg?: number | null; method?: string };
  };
};

// "–" für Nicht-Zahlen, sonst auf n Dezimalen + Einheit (mirror of shell.num).
function pdfNum(v: unknown, n = 3): string {
  if (typeof v !== "number" || !isFinite(v)) return "–";
  return v.toFixed(n) + " m";
}

function findingBlock(iss: Issue, shot: string | null, wms: Wm[], includeKennwerte: boolean): Content {
  const wm = wms[iss.wallIndex] || {};
  const repGuid = wm.element_guid || "—";
  const repName = wm.element_name || iss.groupName || "Bauteil";
  const col = STATUS_COLOR[iss.status] || "#333333";

  const details: Content[] = [
    { text: statusLabel(iss.status), bold: true, color: col, fontSize: 12, margin: [0, 0, 0, 3] },
    { text: [{ text: "Stützmauer: ", bold: true }, iss.groupName || repName] },
    { text: [{ text: "Repräsentatives Bauteil: ", bold: true }, repName] },
    { text: [{ text: "GUID: ", bold: true }, repGuid], fontSize: 8, color: "#555555" },
    { text: [{ text: "Ist: ", bold: true }, iss.istValue, "    ", { text: "Soll: ", bold: true }, iss.sollValue], margin: [0, 3, 0, 0] },
  ];
  if (iss.count && iss.count > 1) {
    details.push({ text: `Betrifft ${iss.count} Element(e) dieser Stützmauer`, italics: true, color: "#444444", margin: [0, 3, 0, 0] });
  }

  const head: Content = {
    unbreakable: true,
    margin: [0, 0, 0, 4],
    stack: [
      { text: `${iss.groupName || repName} — ${iss.label}`, fontSize: 11, bold: true, color: "#1a1a1a", margin: [0, 0, 0, 4] },
      {
        columns: [
          shot
            ? { image: shot, fit: [235, 168], width: 245 }
            : { text: "(kein Screenshot verfügbar)", width: 245, italics: true, color: "#999999" },
          { width: "*", stack: details },
        ],
        columnGap: 12,
      },
    ],
  };

  const parts: Content[] = [head];

  // VOLLSTÄNDIGE Kennwerte-Tabelle des repräsentativen Bauteils, wenn die
  // Kennwerte-Checkbox aktiv ist (alle Werte, nicht nur die Dimensionen).
  if (includeKennwerte) {
    const W = wm as unknown as Record<string, unknown>;
    const dims = (W.dimensions || {}) as Record<string, unknown>;
    const thk = (W.thickness || {}) as Record<string, unknown>;
    const bat = (W.batter || {}) as Record<string, unknown>;
    const slp = (W.slope || {}) as Record<string, unknown>;
    const nic = (W.niches || {}) as Record<string, unknown>;
    const apc = (W.area_per_class || {}) as Record<string, unknown>;
    const thn = (W.thickness_at_niche || {}) as Record<string, unknown>;
    const hl = dims.height_local as Record<string, unknown> | undefined;
    const dl = dims.developed_length as Record<string, unknown> | undefined;
    const u2 = (v: unknown, unit = "", d = 2): string =>
      (typeof v === "number" && isFinite(v)) ? `${v.toFixed(d)}${unit ? " " + unit : ""}` : "–";
    const pctDeg = (v: unknown): string => {
      const dd = Number(v);
      return isFinite(dd) ? `${(Math.tan(Math.abs(dd) * Math.PI / 180) * 100).toFixed(1)} %` : "–";
    };
    const ratioDeg = (v: unknown): string => {
      const dd = Number(v);
      if (!isFinite(dd)) return "–";
      const tn = Math.tan(Math.abs(dd) * Math.PI / 180);
      if (tn < 1e-9) return "∞:1";
      const n = 1 / tn;
      return (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1)) + ":1";
    };
    const R = (label: string, value: string): Content[] =>
      [{ text: label, bold: true, fillColor: "#f0f0f0" }, value];
    const rows: Content[][] = [
      R("Volumen / Oberfläche", `${u2(W.volume_m3, "m³", 3)} / ${u2(W.surface_area_m2, "m²")}`),
      R("Länge / Höhe", `${pdfNum(dims.length)} / ${pdfNum(dims.height)}`),
      R("Nennstärke", pdfNum(dims.nominal_thickness)),
      R("Wandstärke (min / ⌀ / max)", `${pdfNum(thk.min)} / ${pdfNum(thk.avg)} / ${pdfNum(thk.max)}`),
      R("Höhe lokal (min / ⌀ / max)", `${pdfNum(hl?.min)} / ${pdfNum(hl?.avg)} / ${pdfNum(hl?.max)}`),
      R("Abgew. Länge (min / ⌀ / max)", `${pdfNum(dl?.min)} / ${pdfNum(dl?.avg)} / ${pdfNum(dl?.max)}`),
      R("Vorderkante (oben / unten)", `${pdfNum(dl?.front_top)} / ${pdfNum(dl?.front_bottom)}`),
      R("Hinterkante (oben / unten)", `${pdfNum(dl?.back_top)} / ${pdfNum(dl?.back_bottom)}`),
      R("Restwandstärke Nische", pdfNum(thn.min_global)),
      R("Anzug vorne / hinten", `${ratioDeg(bat.front_deg)} / ${ratioDeg(bat.back_deg)}`),
      R("Quergefälle Krone / Fundament", `${pctDeg(slp.crown_deg)} / ${pctDeg(slp.foundation_deg)}`),
      R("Längsgefälle Krone / Fundament",
        `${u2(slp.crown_longitudinal_percent, "%", 1)} / ${u2(slp.foundation_longitudinal_percent, "%", 1)}`),
      R("Nischen (Anzahl / Volumen)", `${(nic.count as number) ?? 0} / ${u2(nic.total_volume_m3, "m³", 3)}`),
    ];
    const areaCells = (["K0", "K1", "K2", "K3", "K4", "K5", "K6"] as const)
      .filter((k) => typeof apc[k] === "number")
      .map((k) => `${k}: ${u2(apc[k], "m²")}`);
    if (areaCells.length) rows.push(R("Fläche je Klasse", areaCells.join("   ")));
    parts.push({
      margin: [0, 2, 0, 0],
      fontSize: 7.5,
      table: { headerRows: 0, widths: ["auto", "*"], body: rows },
      layout: "lightHorizontalLines",
    });
  }

  if (iss.members && iss.members.length > 1) {
    parts.push({
      margin: [0, 4, 0, 0],
      fontSize: 7.5,
      table: {
        headerRows: 1,
        widths: ["*", "auto", "auto"],
        body: [
          [
            { text: "Betroffenes Element", bold: true, fillColor: "#f0f0f0" },
            { text: "GUID", bold: true, fillColor: "#f0f0f0" },
            { text: "Ist", bold: true, fillColor: "#f0f0f0" },
          ],
          ...iss.members.map((m) => [
            m.name || "?",
            { text: m.guid, fontSize: 6.5, color: "#666666" },
            m.value,
          ]),
        ],
      },
      layout: "lightHorizontalLines",
    });
  }

  return { stack: parts, margin: [0, 0, 0, 16] };
}

/**
 * Erzeugt das Prüfprotokoll-PDF und löst den Download aus.
 * @param capture optionaler Snapshot-Capturer (viewer.captureIssueSnapshot) für die Bilder.
 */
export async function exportPdfReport(
  result: DetectionResult,
  base: string,
  capture?: SnapshotCapture,
  modelName?: string,
  includeKennwerte = true,
): Promise<void> {
  showBusy("PDF-Prüfprotokoll wird erzeugt …");
  try {
  const useDejaVu = await ensureDejaVu();   // volle Glyphen-Abdeckung sicherstellen
  const issues = deriveGroupedIssues(result).slice();
  issues.sort((a, b) =>
    (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) ||
    a.ruleId.localeCompare(b.ruleId));

  // BCF-Ansichten verwenden: dieselbe Viewpoint-Verfeinerung wie der BCF-Export
  // (refineIssueAnnotation überschreibt iss.view/iss.section auf die enge, frontale
  // Maß-Ansicht der vier Dimensionsregeln und rastet die Maßlinie auf die
  // Schnittebene). So zeigt das PDF exakt die BCF-Viewpoints statt der lockeren
  // Standard-Ansicht. Idempotent (markiert via __refined).
  for (const iss of issues) {
    try { refineIssueAnnotation(iss, result); } catch { /* Ansicht unverändert lassen */ }
  }

  const wms = (result.wall_metrics || []) as Wm[];

  // Pro Befund einen isolierten Screenshot (schlimmstes Element).
  const shots: (string | null)[] = [];
  for (const iss of issues) {
    let url: string | null = null;
    if (capture) {
      const repGuid = wms[iss.wallIndex]?.element_guid;
      const hlAny = iss.highlight as { kind?: string; classKey?: string } | undefined;
      const hl = hlAny?.kind === "class" ? (hlAny.classKey ?? null) : null;
      const anno = buildDimensionAnnotation(iss);
      try {
        url = capture({
          view: iss.view,
          section: iss.section ?? null,
          // toolLook = 1:1 wie die BCF-Ansicht im Tool (dunkler Hintergrund,
          // gedimmter Kontext, finding-isoliertes Bauteil) statt des weissen
          // Druck-Renders. Kein light-Override → Theme-Hintergrund bleibt.
          toolLook: true,
          keepGuids: repGuid ? [repGuid] : (iss.memberGuids ?? null),
          highlightClass: hl,
          // Nur crown_min_width auf K2 isolieren (captureIssueSnapshot liest classKey);
          // übrige Regeln zeigen weiterhin alle Klassen des Bauteils.
          classKey: iss.ruleId === "crown_min_width" ? hl : null,
          annotation: anno,
          width: 900, height: 600,
        });
      } catch { url = null; }
      if (anno) disposeObj(anno);
    }
    shots.push(url);
    // dem UI zwischen den Aufnahmen kurz Luft geben (Viewer rendert je Frame).
    await new Promise((r) => setTimeout(r, 0));
  }

  const cnt = { FAIL: 0, WARN: 0, INFO: 0, PASS: 0, SKIP: 0 } as Record<string, number>;
  for (const i of issues) cnt[i.status] = (cnt[i.status] || 0) + 1;

  const title = modelName || result.wall_name || base || "Modell";
  const stamp = new Date().toLocaleString("de-CH");

  const content: Content[] = [
    { text: "IfcInspect — Prüfprotokoll", fontSize: 18, bold: true, color: "#1a1a1a" },
    { text: `Modell: ${title}`, fontSize: 11, color: "#333333", margin: [0, 2, 0, 0] },
    { text: `Erstellt: ${stamp}`, fontSize: 8, color: "#888888", margin: [0, 1, 0, 8] },
    {
      table: {
        // Info-Spalte nur einblenden, wenn es informative Befunde gibt.
        widths: (cnt.INFO ? ["*", "*", "*", "*", "*"] : ["*", "*", "*", "*"]) as string[],
        body: [[
          { text: `${cnt.FAIL} Nicht bestanden`, color: STATUS_COLOR.FAIL, bold: true, alignment: "center" },
          { text: `${cnt.WARN} Warnung`, color: STATUS_COLOR.WARN, bold: true, alignment: "center" },
          ...(cnt.INFO ? [{ text: `${cnt.INFO} Info`, color: STATUS_COLOR.INFO, bold: true, alignment: "center" }] : []),
          { text: `${cnt.PASS} Bestanden`, color: STATUS_COLOR.PASS, bold: true, alignment: "center" },
          { text: `${issues.length} Befunde gesamt`, bold: true, alignment: "center" },
        ] as Content[]],
      },
      layout: "noBorders",
      margin: [0, 0, 0, 6],
    },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 1, lineColor: "#f5a623" }], margin: [0, 0, 0, 12] },
  ];

  if (!issues.length) {
    content.push({ text: "Keine Befunde — keine Regelprüfungen vorhanden.", italics: true, color: "#777777" });
  } else {
    issues.forEach((iss, i) => content.push(findingBlock(iss, shots[i], wms, includeKennwerte)));
  }

  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [36, 40, 36, 36],
    info: { title: `Prüfprotokoll ${title}`, creator: "IfcInspect" },
    content,
    footer: (current: number, total: number): Content => ({
      text: `IfcInspect · Prüfprotokoll · Seite ${current} / ${total}`,
      alignment: "center", fontSize: 7, color: "#999999", margin: [0, 8, 0, 0],
    }),
    defaultStyle: { fontSize: 9, lineHeight: 1.15, ...(useDejaVu ? { font: "DejaVu" } : {}) },
  };

  pdfMake.createPdf(doc).download(`${base}_pruefprotokoll.pdf`);
  } finally {
    hideBusy();
  }
}
