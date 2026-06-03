// Bundled rulesets for the Free-Mode "Regelset"-Inspector. These are the
// same YAML files that ship with the ifcinspect wheel (see
// `rules_astra_fhb_stuetzmauer.yaml` + `rules_plausibilitaet_optional.yaml`
// in the repo root); inlined here so the SPA can hand them to the worker
// without a second network roundtrip.
//
// Custom YAML validation strategy: js-yaml adds ~13 KB gzipped (> 10 KB
// budget); we therefore PUNT parsing to the Pyodide worker via the
// existing `rules_bytes` parameter. The worker's _try_evaluate_rules()
// returns a clear error in the rule-row on parse failure. Round-trip is
// acceptable for an interactive YAML edit.

export const ASTRA_FHB_YAML = `version: 1
profile: "ASTRA FHB T/G - Stuetzmauer 24001-15101 V3.02"
applies_to: ["IfcWall"]
# Strictly ASTRA-FHB-derived rules. Each rule cites a verbatim source in
# Merkblatt 24001-15101 "Stuetzbauwerke Allgemeines" V3.02 (01.01.2025) §3
# "Generell" S. 2. Plausibilitaets-Erweiterungen (SIA, Bautoleranz) sind in
# rules_plausibilitaet_optional.yaml ausgelagert.
# Hinweis: per-Regel applies_to wird vom Backend (rules.evaluate) durchgesetzt,
# sobald der Element-Typ bekannt ist. Diese Inline-Kopie spiegelt 1:1 die
# gebuendelte rules_astra_fhb_stuetzmauer.yaml.
rules:
  - id: crown_min_width
    label: "Mauerkrone Mindestbreite (FHB: >= 300 mm)"
    target: "crown_width_m"
    op: ">="
    threshold: 0.30
    unit: "m"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2 (Kap. 3 Generell): 'mindestens 300 mm breit'"
    severity: "fail"
    applies_to: ["*"]

  - id: wall_min_nominal_thickness
    label: "Wand-Mindestbauteilstaerke (FHB: >= 300 mm)"
    target: "thickness.min"
    op: ">="
    threshold: 0.30
    unit: "m"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2 (Kap. 3 Generell): 'Mindestbauteilstaerke (Wandstaerke) von 300 mm ist stets einzuhalten'"
    severity: "fail"
    applies_to: ["*"]

  - id: crown_slope_against_hill
    label: "Kronenneigung 3% zur Erdseite / weg von der Strasse (FHB: gegen Hang)"
    target: "crown_slope_abs_percent"
    op: "=="
    threshold: 3.0
    tolerance: 0.5
    unit: "percent"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2 (Kap. 3 Generell): 'Die Mauerkrone ist 3 %, in der Regel gegen den Hang, geneigt'"
    severity: "warn"
    applies_to: ["*"]

  - id: anzug_max
    label: "Anzug max 1:10 (FHB: 'Neigung der Stuetzmauer von 10:1 wird empfohlen')"
    target: "anzug_ratio"
    op: "<="
    threshold: 0.10
    unit: "ratio"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2 (Kap. 3 Generell): 'Eine Neigung der Stuetzmauer von 10:1 wird empfohlen'"
    severity: "warn"
    applies_to: ["*"]
`;

export const ASTRA_PLAUSI_YAML = `version: 1
profile: "Plausibilitaets-Erweiterung (kein direkter FHB-Verweis)"
applies_to: ["IfcWall"]
# Diese Regeln sind NICHT direkt aus ASTRA FHB T/G abgeleitet. Sie ergaenzen
# das ASTRA-Set um geometrische Plausibilitaetspruefungen aus SIA-Normen,
# Bautoleranzen und strukturellen Erwartungen. Sie werden NICHT als Default
# geladen, sondern nur ueber --rules rules_plausibilitaet_optional.yaml
# explizit aktiviert. Severity bewusst auf 'warn'.
# 4 ASTRA-Basisregeln + 6 Plausibilitaetsregeln; spiegelt die gebuendelten
# rules_astra_fhb_stuetzmauer.yaml + rules_plausibilitaet_optional.yaml.
rules:
  - id: crown_min_width
    label: "Mauerkrone Mindestbreite (FHB: >= 300 mm)"
    target: "crown_width_m"
    op: ">="
    threshold: 0.30
    unit: "m"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2"
    severity: "fail"
    applies_to: ["*"]

  - id: wall_min_nominal_thickness
    label: "Wand-Mindestbauteilstaerke (FHB: >= 300 mm)"
    target: "thickness.min"
    op: ">="
    threshold: 0.30
    unit: "m"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2"
    severity: "fail"
    applies_to: ["*"]

  - id: crown_slope_against_hill
    label: "Kronenneigung 3% zur Erdseite / weg von der Strasse (FHB: gegen Hang)"
    target: "crown_slope_abs_percent"
    op: "=="
    threshold: 3.0
    tolerance: 0.5
    unit: "percent"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2"
    severity: "warn"
    applies_to: ["*"]

  - id: anzug_max
    label: "Anzug max 1:10"
    target: "anzug_ratio"
    op: "<="
    threshold: 0.10
    unit: "ratio"
    source: "ASTRA FHB T/G, Merkblatt 24001-15101 V3.02, S. 2"
    severity: "warn"
    applies_to: ["*"]

  - id: foundation_min_thickness
    label: "Fundament Mindeststaerke (Plausibilitaet, SIA-262-naehe)"
    target: "foundation_thickness_m"
    op: ">="
    threshold: 0.40
    unit: "m"
    source: "non-ASTRA - SIA 262 Plausibilitaet"
    severity: "warn"

  - id: wall_min_residual_thickness_at_niche
    label: "Restwandstaerke am Nischenboden (Plausibilitaet)"
    target: "thickness_at_niche.min_global"
    op: ">="
    threshold: 0.20
    unit: "m"
    source: "non-ASTRA - Plausibilitaet"
    severity: "warn"

  - id: niche_max_density
    label: "Maximale Nischendichte (Plausibilitaet)"
    target: "niches_per_meter"
    op: "<="
    threshold: 0.5
    unit: "1/m"
    source: "non-ASTRA - Plausibilitaet"
    severity: "warn"

  - id: foundation_min_overhang
    label: "Fundament-Ueberstand min (Plausibilitaet)"
    target: "min_foundation_overhang"
    op: ">="
    threshold: 0.10
    unit: "m"
    source: "non-ASTRA - Plausibilitaet"
    severity: "warn"
    applies_to: ["IfcWall", "IfcRetainingWall"]

  - id: stem_centered_on_foundation
    label: "Wandachse mittig auf Fundament (Plausibilitaet)"
    target: "context.internal.eccentricity_m"
    op: "<="
    threshold: 0.10
    unit: "m"
    source: "non-ASTRA - Plausibilitaet"
    severity: "warn"
    applies_to: ["IfcWall", "IfcRetainingWall"]

  - id: min_clearance_to_neighbor
    label: "Mindestabstand zu Nachbar-Bauteil (Plausibilitaet)"
    target: "scene.distances[*].min_distance_m:min"
    op: ">="
    threshold: 0.30
    unit: "m"
    source: "non-ASTRA - Plausibilitaet"
    severity: "warn"
    applies_to: ["IfcWall", "IfcRetainingWall"]
`;

// Demo-Regelset für den Showcase-Link ?demo=curved (Bogenwand-Demo). Wird
// NICHT in BUILTIN_RULESETS aufgenommen → erscheint nicht im Regelset-Auswahl-
// Dialog; aktiviert wird es ausschliesslich beim Laden des Demo-Links (main.ts).
export const BOGENWAND_DEMO_YAML = `version: 1
profile: "demo=curved"
applies_to: ["IfcWall"]
rules:
  - id: wall_min_nominal_thickness
    label: "Wand-Mindestbauteilstaerke (>= 0.30 m)"
    target: "thickness.min"
    op: ">="
    threshold: 0.30
    unit: "m"
    severity: "fail"
    applies_to: ["*"]
  - id: anzug_max
    label: "Anzug-Neigung (Maximalgrenze 1:10)"
    target: "anzug_ratio"
    op: "<="
    threshold: 0.10
    unit: "ratio"
    severity: "fail"
    applies_to: ["*"]
  - id: crown_slope_against_hill
    label: "Kronenneigung gegen den Hang (Sollband ~2 %)"
    target: "crown_slope_abs_percent"
    op: "=="
    threshold: 2.0
    tolerance: 0.7
    unit: "percent"
    severity: "warn"
    applies_to: ["*"]
  - id: niche_max_density
    label: "Nischen-Dichte je Laufmeter (<= 1.3 1/m)"
    target: "niches_per_meter"
    op: "<="
    threshold: 1.3
    unit: "1/m"
    severity: "warn"
    applies_to: ["*"]
  - id: min_clearance_wall_road
    label: "Mindestabstand Stuetzmauer-Strasse (>= 0.50 m)"
    target: "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min"
    op: ">="
    threshold: 0.50
    unit: "m"
    severity: "warn"
    applies_to: ["*"]
`;

// --------------------------------------------------------------------------- //
//  Kenngrössen-Katalog für den Formular-Regel-Builder
//
//  Jeder Eintrag bildet einen Backend-`target`-Pfad (Dot-Path in wall_metrics,
//  Composite-Name oder Listen-Aggregation mit Filter — siehe rules.py) auf ein
//  lesbares deutsches Label, eine Einheit und einen sinnvollen Default-Operator
//  ab. `level` markiert, ob das Target auf Wand-, Kontext- oder Szenen-Ebene
//  liegt (Szene/Kontext brauchen Nachbar-Bauteile bzw. Terrain im Modell).
//  Die Pfade sind exakt aus metrics.py / report.py / context.py / rules.py
//  abgeleitet und 1:1 evaluierbar.
// --------------------------------------------------------------------------- //
export type RuleOp = ">=" | "<=" | ">" | "<" | "==" | "!=";
export type RuleSeverity = "fail" | "warn";
export type TargetLevel = "wall" | "context" | "scene";

export type TargetCatalogEntry = {
  target: string;
  label: string;
  unit: string; // Anzeige-Einheit; "" oder "–" = dimensionslos
  defaultOp: RuleOp;
  level: TargetLevel;
};

export const TARGET_LEVEL_LABEL: Record<TargetLevel, string> = {
  wall: "Wand-Geometrie",
  context: "Kontext (Terrain/Fundament)",
  scene: "Szene (Nachbar-Bauteile)",
};

export const TARGET_CATALOG: TargetCatalogEntry[] = [
  // ---- Wand-Geometrie (Dot-Path in wall_metrics) ----
  { target: "crown_width_m", label: "Kronenbreite (p10, Default)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "crown_width_min_m", label: "Kronenbreite (Min)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "crown_width_p10_m", label: "Kronenbreite (p10)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "crown_width_avg_m", label: "Kronenbreite (Mittel)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "crown_width_median_m", label: "Kronenbreite (Median)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "thickness.min", label: "Wandstärke (Minimum)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "thickness.avg", label: "Wandstärke (Mittel)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "thickness.max", label: "Wandstärke (Maximum)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "slope.crown_deg", label: "Kronenneigung (quer)", unit: "°", defaultOp: ">=", level: "wall" },
  { target: "slope.foundation_deg", label: "Fundamentneigung (quer)", unit: "°", defaultOp: "<=", level: "wall" },
  { target: "slope.crown_longitudinal_deg", label: "Kronen-Längsgefälle", unit: "°", defaultOp: "<=", level: "wall" },
  { target: "slope.crown_longitudinal_percent", label: "Kronen-Längsgefälle", unit: "%", defaultOp: "<=", level: "wall" },
  { target: "slope.foundation_longitudinal_deg", label: "Fundament-Längsgefälle", unit: "°", defaultOp: "<=", level: "wall" },
  { target: "slope.foundation_longitudinal_percent", label: "Fundament-Längsgefälle", unit: "%", defaultOp: "<=", level: "wall" },
  // FHB-Kronenneigung (Betrag): Soll == 3 % ± Toleranz. Die Richtung ("gegen
  // den Hang" / zur Luftseite) bewertet ein generischer Kontext-Teilcheck in
  // rules.py (crown_slope_against_hill): Terrain + eindeutige Erdseite → Richtung
  // geprüft (pass/warn); kein Terrain/Erdseite unbestimmt → Status INFO (Betrag
  // ok, Richtung nicht prüfbar). Das ist das Default-Target der FHB-Regel.
  { target: "crown_slope_abs_percent", label: "Kronenneigung Betrag (FHB 3 %, Richtung kontext-geprüft)", unit: "%", defaultOp: "==", level: "wall" },
  // Legacy/optional (signiert): vorzeichenbehaftetes Kronen-Entwässerungsgefälle.
  // Nicht mehr Default-Target, aber weiter als wall_metric verfügbar (z.B. für
  // eigene Regeln). None → Regel SKIP.
  { target: "slope.crown_drainage_percent", label: "Kronen-Entwässerungsgefälle signiert (Legacy)", unit: "%", defaultOp: "==", level: "wall" },
  { target: "batter.front_deg", label: "Anzug Seitenfläche + (Winkel)", unit: "°", defaultOp: "<=", level: "wall" },
  { target: "batter.back_deg", label: "Anzug Seitenfläche − (Winkel)", unit: "°", defaultOp: "<=", level: "wall" },
  { target: "anzug_ratio", label: "Anzug-Verhältnis Seitenfläche +", unit: "–", defaultOp: "<=", level: "wall" },
  { target: "dimensions.volume_m3", label: "Volumen", unit: "m³", defaultOp: ">=", level: "wall" },
  { target: "volume_m3", label: "Volumen (Top-Level)", unit: "m³", defaultOp: ">=", level: "wall" },
  { target: "surface_area_m2", label: "Oberfläche", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "dimensions.length", label: "Länge", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "dimensions.height", label: "Höhe", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "dimensions.nominal_thickness", label: "Nominalstärke", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "niches.count", label: "Anzahl Schaleinlagen/Nischen", unit: "Stk", defaultOp: "<=", level: "wall" },
  { target: "niches.total_volume_m3", label: "Nischen-Gesamtvolumen", unit: "m³", defaultOp: "<=", level: "wall" },
  { target: "niches_per_meter", label: "Nischendichte", unit: "1/m", defaultOp: "<=", level: "wall" },
  { target: "thickness_at_niche.min_global", label: "Restwandstärke an Nische (min)", unit: "m", defaultOp: ">=", level: "wall" },
  { target: "foundation_thickness_m", label: "Fundamentstärke", unit: "m", defaultOp: ">=", level: "wall" },
  // ---- K0–K6 Flächen (area_per_class) ----
  { target: "area_per_class.K0", label: "Fläche Stirn + (K0)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K1", label: "Fläche Stirn − (K1)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K2", label: "Fläche Krone (K2)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K3", label: "Fläche Fundament (K3)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K4", label: "Fläche Front/Luft (K4)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K5", label: "Fläche Back/Erd (K5)", unit: "m²", defaultOp: ">=", level: "wall" },
  { target: "area_per_class.K6", label: "Fläche Schaleinlagen (K6)", unit: "m²", defaultOp: ">=", level: "wall" },
  // ---- Kontext (L5/L6 — Fundament-Überstand & Terrain) ----
  { target: "min_foundation_overhang", label: "Fundament-Überstand (min)", unit: "m", defaultOp: ">=", level: "context" },
  { target: "context.internal.foundation_overhang_left_m", label: "Fundament-Überstand links", unit: "m", defaultOp: ">=", level: "context" },
  { target: "context.internal.foundation_overhang_right_m", label: "Fundament-Überstand rechts", unit: "m", defaultOp: ">=", level: "context" },
  { target: "context.external.terrain_median_distance_air_m", label: "Abstand Luftseite → Terrain", unit: "m", defaultOp: ">=", level: "context" },
  { target: "context.external.terrain_median_distance_earth_m", label: "Abstand Erdseite → Terrain", unit: "m", defaultOp: ">=", level: "context" },
  // ---- Szene (L7 — Bauteil-Distanzen, Mess-Modi + typgefiltert) ----
  // 3D-Minimaldistanz
  { target: "scene.distances[*].min_distance_m:min", label: "Mindestabstand 3D (alle Bauteile)", unit: "m", defaultOp: ">=", level: "scene" },
  { target: "scene.distances[from_type~=Wall, to_type~=Road].min_distance_m:min", label: "Mindestabstand 3D Stützmauer ↔ Strasse", unit: "m", defaultOp: ">=", level: "scene" },
  // Horizontaler Abstand (XY-Grundriss)
  { target: "scene.distances[*].horizontal_distance_m:min", label: "Abstand horizontal (XY)", unit: "m", defaultOp: ">=", level: "scene" },
  { target: "scene.distances[from_type~=Wall, to_type~=Road].horizontal_distance_m:min", label: "Abstand horizontal (XY) Stützmauer ↔ Strasse", unit: "m", defaultOp: ">=", level: "scene" },
  // Vertikaler Abstand (Z-Spalt)
  { target: "scene.distances[*].vertical_distance_m:min", label: "Abstand vertikal (Z)", unit: "m", defaultOp: ">=", level: "scene" },
  { target: "scene.distances[from_type~=Wall, to_type~=Road].vertical_distance_m:min", label: "Abstand vertikal (Z) Stützmauer ↔ Strasse", unit: "m", defaultOp: ">=", level: "scene" },
  // Senkrecht zur Wand (entlang Wand-Normale)
  { target: "scene.distances[*].perpendicular_distance_m:min", label: "Abstand senkrecht zur Wand", unit: "m", defaultOp: ">=", level: "scene" },
  { target: "scene.distances[from_type~=Wall, to_type~=Road].perpendicular_distance_m:min", label: "Abstand senkrecht zur Wand Stützmauer ↔ Strasse", unit: "m", defaultOp: ">=", level: "scene" },
];

/** Catalog lookup by exact target string. */
export function catalogEntryFor(target: string): TargetCatalogEntry | undefined {
  return TARGET_CATALOG.find((e) => e.target === target);
}

export const OP_LABEL: Record<RuleOp, string> = {
  ">=": "≥",
  "<=": "≤",
  ">": ">",
  "<": "<",
  "==": "=",
  "!=": "≠",
};

export type BuilderRule = {
  id: string;
  label: string;
  target: string;
  op: RuleOp;
  threshold: number;
  unit: string;
  severity: RuleSeverity;
  source?: string;
  // OPTIONAL Mindest-Confidence (0..1). Set -> backend rules.py downgrades the
  // check to WARN/SKIP when the measured value's confidence is below this.
  minConfidence?: number | null;
  // OPTIONAL Toleranzband (≥ 0). Nur bei op "==" sinnvoll: definiert ein
  // symmetrisches Soll-Band [threshold ± tolerance] (rules.py). Genutzt z.B. von
  // der FHB-Kronenneigungs-Regel (slope.crown_drainage_percent == 3.0 ± 0.5).
  tolerance?: number | null;
};

/** Slugify a label into a safe YAML id (a-z0-9_), with a fallback. */
function slugifyId(label: string, target: string): string {
  const base = (label || target || "regel")
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue" }[c] as string))
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "regel";
}

/** Ensure a YAML id is unique within an existing YAML source (append _2, _3 …). */
function uniqueId(base: string, yaml: string): string {
  const existing = new Set(
    (yaml.match(/^\s*-\s*id\s*:\s*["']?([A-Za-z0-9_]+)/gm) || []).map((m) =>
      m.replace(/^\s*-\s*id\s*:\s*["']?/, ""),
    ),
  );
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}_${i}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base}_${Date.now()}`;
}

/** Build a default human label from catalog + op + threshold. */
export function defaultLabelFor(target: string, op: RuleOp, threshold: number): string {
  const entry = catalogEntryFor(target);
  const name = entry?.label ?? target;
  const unit = entry && entry.unit && entry.unit !== "–" ? " " + entry.unit : "";
  return `${name} ${OP_LABEL[op]} ${threshold}${unit}`.trim();
}

/** Quote a YAML scalar value (always double-quote strings to be safe). */
function yq(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Format a single rule as a YAML block (2-space list indent, matching the
 *  built-in rulesets). The numeric threshold is emitted unquoted. */
export function buildRuleYamlBlock(rule: BuilderRule, existingYaml: string): string {
  const id = uniqueId(rule.id || slugifyId(rule.label, rule.target), existingYaml);
  const lines = [
    `  - id: ${id}`,
    `    label: ${yq(rule.label)}`,
    `    target: ${yq(rule.target)}`,
    `    op: ${yq(rule.op)}`,
    `    threshold: ${rule.threshold}`,
  ];
  if (typeof rule.tolerance === "number" && isFinite(rule.tolerance)) {
    lines.push(`    tolerance: ${rule.tolerance}`);
  }
  if (rule.unit && rule.unit !== "–") lines.push(`    unit: ${yq(rule.unit)}`);
  lines.push(`    severity: ${yq(rule.severity)}`);
  if (
    typeof rule.minConfidence === "number" &&
    isFinite(rule.minConfidence)
  ) {
    lines.push(`    min_confidence: ${rule.minConfidence}`);
  }
  lines.push(`    source: ${yq(rule.source || "Eigene Regel (Builder)")}`);
  return lines.join("\n");
}

/** Append a rule block to a YAML ruleset. If the YAML has no `rules:` key yet
 *  a minimal scaffold is created. Returns the new YAML text. */
export function appendRuleToYaml(yaml: string, block: string): string {
  let src = yaml.replace(/\s*$/, "");
  if (!/^rules\s*:/m.test(src)) {
    // Scaffold a fresh custom ruleset.
    const scaffold = `version: 1\nprofile: "Eigenes Regelset (Builder)"\napplies_to: ["IfcWall"]\nrules:`;
    src = src ? src + "\n" + scaffold : scaffold;
  }
  return src + "\n" + block + "\n";
}

export type RulesetKey = "astra_default" | "astra_plausi" | "custom";

export type Ruleset = {
  key: RulesetKey;
  label: string;
  yaml: string;
};

export const BUILTIN_RULESETS: Record<Exclude<RulesetKey, "custom">, Ruleset> = {
  astra_default: {
    key: "astra_default",
    label: "ASTRA FHB T/G — Stützmauer (Default)",
    yaml: ASTRA_FHB_YAML,
  },
  astra_plausi: {
    key: "astra_plausi",
    label: "ASTRA + Plausibilität (Optional)",
    yaml: ASTRA_PLAUSI_YAML,
  },
};

// Ephemeres Demo-Regelset (NICHT in BUILTIN_RULESETS → nicht im Auswahldialog).
// Nur main.ts/loadDemoModel aktiviert es beim Öffnen von ?demo=curved.
export const DEMO_CURVED_RULESET: Ruleset = {
  key: "custom",
  label: "demo=curved",
  yaml: BOGENWAND_DEMO_YAML,
};

/** Encode a YAML source string as the byte payload for the worker. */
export function yamlToBytes(yaml: string): ArrayBuffer {
  return new TextEncoder().encode(yaml).buffer as ArrayBuffer;
}

/** Minimal client-side schema sanity check (no full YAML parse).
 *  Returns null on success, otherwise an error message. */
export function quickValidateYaml(yaml: string): string | null {
  const trimmed = yaml.trim();
  if (!trimmed) return "YAML ist leer.";
  if (!/^rules\s*:/m.test(yaml) && !/^rules:/m.test(yaml)) {
    return "Schlüssel 'rules:' fehlt — YAML muss eine 'rules:'-Liste enthalten.";
  }
  // Each rule block needs: id, target, op, threshold, severity. We just
  // count occurrences; the Pyodide worker does the real parse and reports
  // line-level errors in the rule-row if structure is broken.
  const needHere = ["id", "target", "op", "threshold"];
  for (const key of needHere) {
    if (!new RegExp(`^\\s*-?\\s*${key}\\s*:`, "m").test(yaml)) {
      return `Pflichtfeld '${key}' fehlt in mindestens einer Regel.`;
    }
  }
  return null;
}

/** Extract a preview list (id/label/target/op/threshold/unit/severity) WITHOUT
 *  a real YAML parser — uses a state machine over indentation. Each entry also
 *  carries the inclusive [startLine, endLine] span of its block in the source
 *  (0-based, comment/blank lines trimmed from the end) so the UI can delete or
 *  re-load an individual rule. Falls back to "?" on weird input.
 *
 *  `target`/`threshold`/`severity` keep their string shape for backward compat;
 *  `label`/`op`/`unit` are added for the builder's edit round-trip. */
export type RulePreview = {
  id: string;
  label: string;
  target: string;
  op: string;
  threshold: string;
  unit: string;
  severity: string;
  min_confidence: string;
  tolerance: string;
  startLine: number;
  endLine: number;
};

const _PREVIEW_KEYS = ["label", "target", "op", "threshold", "unit", "severity", "min_confidence", "tolerance"] as const;

function _stripScalar(v: string): string {
  return v.trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
}

export function previewRules(yaml: string): RulePreview[] {
  const out: RulePreview[] = [];
  const lines = yaml.split(/\r?\n/);
  let cur: (Partial<RulePreview> & { startLine: number; endLine: number }) | null = null;
  const flush = () => {
    if (cur && cur.id) {
      out.push({
        id: cur.id || "?",
        label: cur.label || "",
        target: cur.target || "?",
        op: cur.op || "",
        threshold: cur.threshold || "?",
        unit: cur.unit || "",
        severity: cur.severity || "?",
        min_confidence: cur.min_confidence || "",
        tolerance: cur.tolerance || "",
        startLine: cur.startLine,
        endLine: cur.endLine,
      });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const noComment = raw.replace(/^\s*#.*/, ""); // full-line comment only
    const line = noComment.trimEnd();
    // New rule starts with "  - id:" or "- id:"
    const startMatch = line.match(/^\s*-\s*id\s*:\s*(.+)$/);
    if (startMatch) {
      flush();
      cur = {
        id: _stripScalar(startMatch[1]),
        startLine: i,
        endLine: i,
      };
      continue;
    }
    if (!cur) continue;
    if (line.trim()) cur.endLine = i; // extend block to last non-blank line
    const m = line.match(/^\s+([a-z_]+)\s*:\s*(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      if ((_PREVIEW_KEYS as readonly string[]).includes(key)) {
        (cur as unknown as Record<string, string>)[key] = _stripScalar(m[2]);
      }
    }
  }
  flush();
  return out;
}

/** Remove the rule block whose 0-based index matches `idx` from the YAML
 *  source (uses previewRules' line spans). Returns the new YAML text. If the
 *  index is out of range the input is returned unchanged. */
export function removeRuleByIndex(yaml: string, idx: number): string {
  const rules = previewRules(yaml);
  const r = rules[idx];
  if (!r) return yaml;
  const lines = yaml.split(/\r?\n/);
  // Drop [startLine .. endLine]; also swallow one trailing blank separator.
  let end = r.endLine;
  if (end + 1 < lines.length && !lines[end + 1].trim()) end += 1;
  lines.splice(r.startLine, end - r.startLine + 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// --------------------------------------------------------------------------- //
//  Named-ruleset store (client-side localStorage persistence)
//
//  Built-ins (ASTRA FHB, ASTRA + Plausibilität) are read-only templates and
//  live in BUILTIN_RULESETS. User-created/edited rulesets are NAMED and
//  persisted to localStorage — they survive a reload but never leave the
//  browser (consistent with the SPA's RAM-only / privacy promise). Editing a
//  built-in is not allowed; the UI duplicates it into a new named ruleset.
// --------------------------------------------------------------------------- //
export type SavedRuleset = {
  id: string;        // stable uuid-ish id
  name: string;      // user-facing name
  yaml: string;
  builtinSource?: Exclude<RulesetKey, "custom">; // set if duplicated from a built-in
  createdAt: number;
  updatedAt: number;
};

const STORE_KEY = "nd_rulesets_v1";
const ACTIVE_KEY = "nd_active_ruleset_v1";

function _genId(): string {
  return "rs_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/** Load all saved (user) rulesets from localStorage. Never throws. */
export function loadSavedRulesets(): SavedRuleset[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is SavedRuleset =>
        r && typeof r.id === "string" && typeof r.name === "string" && typeof r.yaml === "string",
    );
  } catch {
    return [];
  }
}

function _persist(list: SavedRuleset[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode — silently ignore, stays in-memory for the session */
  }
}

/** Create + persist a new named ruleset. Returns the created record. */
export function createSavedRuleset(
  name: string,
  yaml: string,
  builtinSource?: Exclude<RulesetKey, "custom">,
): SavedRuleset {
  const now = Date.now();
  const rec: SavedRuleset = {
    id: _genId(),
    name: name.trim() || "Unbenanntes Regelset",
    yaml,
    builtinSource,
    createdAt: now,
    updatedAt: now,
  };
  const list = loadSavedRulesets();
  list.push(rec);
  _persist(list);
  return rec;
}

/** Update the YAML (and optionally name) of an existing saved ruleset. */
export function updateSavedRuleset(id: string, patch: { yaml?: string; name?: string }): SavedRuleset | null {
  const list = loadSavedRulesets();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  if (typeof patch.yaml === "string") list[i].yaml = patch.yaml;
  if (typeof patch.name === "string" && patch.name.trim()) list[i].name = patch.name.trim();
  list[i].updatedAt = Date.now();
  _persist(list);
  return list[i];
}

/** Delete a saved ruleset by id. Returns true if something was removed. */
export function deleteSavedRuleset(id: string): boolean {
  const list = loadSavedRulesets();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  _persist(next);
  if (getActiveRulesetId() === id) setActiveRulesetId(null);
  return true;
}

export function getSavedRuleset(id: string): SavedRuleset | null {
  return loadSavedRulesets().find((r) => r.id === id) ?? null;
}

/** Remember which ruleset is active across reloads. The token is either a
 *  built-in key ("astra_default"/"astra_plausi") or a saved-ruleset id. */
export function getActiveRulesetId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}
export function setActiveRulesetId(token: string | null): void {
  try {
    if (token) localStorage.setItem(ACTIVE_KEY, token);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}
