// BCF-style issue derivation for Guided Step 3.
//
// Walks result.wall_metrics[*].pruefung and emits one Issue per RuleCheck,
// each with a precomputed camera viewpoint that frames the relevant region
// (e.g. K2 crown band for crown_min_width, side-perpendicular for batter
// rules, K6 cavity for niche residuals). The viewer consumes these via
// Viewer3D.setIssueView().

import type { DetectionResult, RuleCheck } from "./types";
import { t } from "./i18n";

export type IssueView = {
  cameraPos: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg?: number;
};

export type IssueHighlight =
  | { kind: "class"; classKey: "K0" | "K1" | "K2" | "K3" | "K4" | "K5" | "K6" }
  | { kind: "cavityIndex"; index: number }
  | null;

// Annotation payload — all coords in IFC space (Z-up). The viewer attaches
// the annotation group to sceneContent (rotated -PI/2 around X) so coords
// stay anchored to the wall mesh's local frame.
//   kind="dimension" — straight Maßlinie with Hilfslinien + Pfeile.
//   kind="arrow" — gerader Pfeil entlang der Fläche (Anzug/Krone-Gefälle).
//                  start=tail, end=head; label is camera-facing sprite at mid.
//   kind="bullets" — fall-back when geometry-anchored placement infeasible.
export type IssueAnnotation = {
  kind: "dimension" | "arrow" | "bullets";
  start: [number, number, number];
  end: [number, number, number];
  offset?: [number, number, number];
  runDir?: [number, number, number];
  text: string;
  statusColor: "fail" | "warn" | "pass" | "skip";
};

// BCF 2.1-aligned viewpoint payload. Serialised into the JSON export so a
// future BCF .bcf exporter can build viewpoint.bcfv files without redoing
// the geometry math. Coords are in IFC space (Z-up).
export type BcfViewpoint = {
  perspectiveCamera: {
    cameraViewPoint: [number, number, number];
    cameraDirection: [number, number, number];
    cameraUpVector: [number, number, number];
    fieldOfView: number;
  };
  clippingPlanes?: { location: [number, number, number]; direction: [number, number, number] }[];
  // BCF 2.1 redline lines (Viewpoint <Lines>) — coords in IFC space (Z-up).
  // We serialise the dimension annotation here so the measured span shows up as
  // a redline in any BCF viewer (BimCollab/Solibri), not just in our 3D view.
  lines?: { start: [number, number, number]; end: [number, number, number] }[];
  components?: {
    visibility: { defaultVisibility: boolean; exceptions: string[] };
    selection: string[];
  };
};

// Section plane in IFC space (Z-up). normal points to the kept side.
// Used by viewer.setSectionPlane to install a THREE.Plane clipping plane.
export type SectionPlane = {
  normal: [number, number, number];
  point:  [number, number, number];
};

export type Issue = {
  id: string;
  wallIndex: number;
  ruleId: string;
  label: string;
  status: "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP";
  istValue: string;
  sollValue: string;
  shortDescription: string;
  view: IssueView;
  highlight: IssueHighlight;
  annotation?: IssueAnnotation;
  // Section plane to install when this issue is active. null = no section.
  // Default-on for thickness/anzug/slope rules so the engineer immediately
  // sees the wall cross-section; default-off for crown_width (top-down works).
  section?: SectionPlane | null;
  // BCF 2.1 viewpoint payload — serialised into JSON export for a future
  // .bcf exporter (no actual BCF generation here, just data).
  bcfViewpoint?: BcfViewpoint;
  // Gruppierter geführter Befund (berührende Elemente derselben Stützmauer,
  // eine Regel + Status). count = Anzahl betroffener Elemente; members = je
  // Element Name/GUID/Wert (zuordenbar); memberGuids = zum Ghosten/Isolieren.
  count?: number;
  members?: { name: string; guid: string; value: string }[];
  memberGuids?: string[];
  groupName?: string;
};

// Reihenfolge: Nicht bestanden > Warnung > Info > Übersprungen > Bestanden.
// INFO ist KEIN Befund, wird aber vor Übersprungen/Bestanden einsortiert.
const SEV_RANK: Record<Issue["status"], number> = {
  FAIL: 0, WARN: 1, INFO: 2, SKIP: 3, PASS: 4,
};

// Minimum bbox extent so degenerate sub-meshes don't yield zero-radius frames.
const MIN_RADIUS = 0.4;

// AABB in IFC world coords (Z-up). NOTE: viewer.ts rotates sceneContent by
// -PI/2 around X, mapping IFC (x, y, z) -> Three world (x, z, -y). We always
// compute in IFC space, then convert to viewer-world for the camera output.
type AABB = { min: [number, number, number]; max: [number, number, number] };

function ifcToWorld(p: [number, number, number]): [number, number, number] {
  // Three.js: rotation.x = -PI/2 means y_world = z_ifc, z_world = -y_ifc.
  return [p[0], p[2], -p[1]];
}

function aabbCenter(b: AABB): [number, number, number] {
  return [
    (b.min[0] + b.max[0]) * 0.5,
    (b.min[1] + b.max[1]) * 0.5,
    (b.min[2] + b.max[2]) * 0.5,
  ];
}

function aabbSize(b: AABB): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function aabbRadius(b: AABB): number {
  const s = aabbSize(b);
  return Math.max(MIN_RADIUS, Math.hypot(s[0], s[1], s[2]) * 0.5);
}

function mergeAabb(a: AABB | null, b: AABB): AABB {
  if (!a) return { min: [...b.min], max: [...b.max] };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function meshAabb(verts: number[]): AABB | null {
  if (!verts || verts.length < 3) return null;
  const mn: [number, number, number] = [Infinity, Infinity, Infinity];
  const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i] < mn[0]) mn[0] = verts[i];
    if (verts[i + 1] < mn[1]) mn[1] = verts[i + 1];
    if (verts[i + 2] < mn[2]) mn[2] = verts[i + 2];
    if (verts[i] > mx[0]) mx[0] = verts[i];
    if (verts[i + 1] > mx[1]) mx[1] = verts[i + 1];
    if (verts[i + 2] > mx[2]) mx[2] = verts[i + 2];
  }
  if (!isFinite(mn[0])) return null;
  return { min: mn, max: mx };
}

function classAabb(result: DetectionResult, classKey: string): AABB | null {
  let acc: AABB | null = null;
  for (const c of result.cavities || []) {
    if (c.kind !== classKey) continue;
    const b = meshAabb(c.vertices);
    if (b) acc = mergeAabb(acc, b);
  }
  return acc;
}

function wallAabb(result: DetectionResult): AABB | null {
  return result.wall_mesh ? meshAabb(result.wall_mesh.vertices) : null;
}

// Pad an AABB by a factor on all axes (used to avoid annotation labels
// getting clipped by the camera frame).
function padAabb(b: AABB, pct: number): AABB {
  const s = aabbSize(b);
  const dx = s[0] * pct, dy = s[1] * pct, dz = s[2] * pct;
  return {
    min: [b.min[0] - dx, b.min[1] - dy, b.min[2] - dz],
    max: [b.max[0] + dx, b.max[1] + dy, b.max[2] + dz],
  };
}

// Frame: place camera so the bbox fills the view with a comfortable margin.
function framedView(
  bboxIfc: AABB,
  dirIfc: [number, number, number],
  upIfc: [number, number, number] = [0, 0, 1],
  fovDeg = 45,
  margin = 1.45,
): IssueView {
  // 15% bbox padding so annotation labels above/below the line don't get
  // clipped at the framed edge.
  const padded = padAabb(bboxIfc, 0.15);
  const c = aabbCenter(padded);
  const r = aabbRadius(padded);
  const fov = (fovDeg * Math.PI) / 180;
  const dist = (r / Math.sin(fov / 2)) * margin;
  // Normalise dir
  const dl = Math.hypot(dirIfc[0], dirIfc[1], dirIfc[2]) || 1;
  const dn: [number, number, number] = [dirIfc[0] / dl, dirIfc[1] / dl, dirIfc[2] / dl];
  const camIfc: [number, number, number] = [
    c[0] + dn[0] * dist, c[1] + dn[1] * dist, c[2] + dn[2] * dist,
  ];
  return {
    cameraPos: ifcToWorld(camIfc),
    target: ifcToWorld(c),
    up: ifcToWorld(upIfc),
    fovDeg,
  };
}

// ----- Cross-section view helpers (P1 camera side + P2 slab framing) -------
// The three cross-section rules (thickness / anzug / crown slope) cut the wall
// with a vertical plane perpendicular to the run; buildSection() keeps the
// +longAxis half, so the freshly exposed cut face points toward -longAxis. To
// look frontally AT that cut face the camera must sit on the -longAxis side and
// look +longAxis (the old code put it on +longAxis → it stared at the massive
// far end with the cut turned away). A slight height + thickness tilt keeps the
// section readable in 3D instead of a flat orthographic slab.
function crossSectionDir(frame: WallFrame): [number, number, number] {
  return normalize3([
    -frame.longAxis[0] * 0.9 + frame.heightAxis[0] * 0.28 + frame.thicknessAxis[0] * 0.18,
    -frame.longAxis[1] * 0.9 + frame.heightAxis[1] * 0.28 + frame.thicknessAxis[1] * 0.18,
    -frame.longAxis[2] * 0.9 + frame.heightAxis[2] * 0.28 + frame.thicknessAxis[2] * 0.18,
  ]);
}

// Framing box for an end-on cross-section: a cube centred at the wall centre
// whose space diagonal equals hypot(height, thickness) — i.e. it excludes the
// wall length so framedView() sizes the camera distance from the cross-section
// (height × thickness), not the long run. Orientation-robust: framedView only
// uses center + diagonal magnitude, both invariant to how the (possibly PCA-
// rotated) wall frame is oriented.
function crossSectionBox(frame: WallFrame): AABB {
  const c = frame.center;
  const diag = Math.hypot(frame.height, frame.thickness);
  const s = diag / Math.sqrt(3) / 2; // half-side: hypot(s,s,s)=diag
  return { min: [c[0] - s, c[1] - s, c[2] - s], max: [c[0] + s, c[1] + s, c[2] + s] };
}

// ----- Wall frame ---------------------------------------------------------
// True orthonormal wall basis (IFC Z-up): longAxis along the length, height
// vertical, thickness perpendicular horizontal. Source of truth =
// `wall_metrics[i].wall_axes` (PCA Vt from metrics.py). When absent (older
// pipeline), we fall back to AABB extents sorted descending: longest =
// longAxis, smallest horizontal = thicknessAxis, vertical = heightAxis.
// This is what fixes the "all 4 dimensions point at the wrong axis" bug —
// previously we just toggled between two AABB sides via wallLongAxis() and
// the math broke whenever the AABB was off-axis or the longest extent was
// not actually the wall length (e.g. tall narrow wall).
type WallFrame = {
  longAxis: [number, number, number];
  heightAxis: [number, number, number];
  thicknessAxis: [number, number, number];
  center: [number, number, number];
  length: number;
  height: number;
  thickness: number;
};
function normalize3(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function projectExtent(bbox: AABB, axis: [number, number, number]): number {
  // |dot(axis, size)| -> magnitude of extent projected onto axis.
  const s = aabbSize(bbox);
  return Math.abs(axis[0]) * s[0] + Math.abs(axis[1]) * s[1] + Math.abs(axis[2]) * s[2];
}
function wallFrame(
  bbox: AABB,
  wm?: { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number] },
): WallFrame {
  let longAxis: [number, number, number];
  let heightAxis: [number, number, number];
  let thicknessAxis: [number, number, number];
  if (wm?.wall_axes) {
    longAxis = normalize3(wm.wall_axes.long);
    heightAxis = normalize3(wm.wall_axes.height);
    thicknessAxis = normalize3(wm.wall_axes.thickness);
  } else {
    // Fallback: AABB extents sorted. Smallest horizontal = thickness,
    // vertical (Z, idx=2) = height, remaining horizontal = length.
    const s = aabbSize(bbox);
    heightAxis = [0, 0, 1];
    // Compare horizontal x vs y; smaller is thickness.
    if (s[0] <= s[1]) {
      thicknessAxis = [1, 0, 0];
      longAxis = [0, 1, 0];
    } else {
      thicknessAxis = [0, 1, 0];
      longAxis = [1, 0, 0];
    }
    // Re-orthonormalise.
    const tmp = cross3(longAxis, heightAxis);
    thicknessAxis = normalize3(tmp);
  }
  const center: [number, number, number] = wm?.centroid ?? aabbCenter(bbox);
  return {
    longAxis,
    heightAxis,
    thicknessAxis,
    center,
    length:    projectExtent(bbox, longAxis),
    height:    projectExtent(bbox, heightAxis),
    thickness: projectExtent(bbox, thicknessAxis),
  };
}
function add3(a: [number, number, number], b: [number, number, number], s = 1): [number, number, number] {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

// RuleCheck-Status -> Issue-Status. INFO bleibt jetzt erhalten (eigener,
// informativer Status) und wird NICHT mehr nach SKIP zusammengefasst, damit
// „Info" überall (BCF-Karten, PDF, BCF-Export) korrekt dargestellt wird.
function germanStatus(s: RuleCheck["status"]): Issue["status"] {
  return s;
}

function pickView(
  ruleId: string,
  result: DetectionResult,
  wm?: { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number] },
): { view: IssueView; highlight: IssueHighlight } {
  const wall = wallAabb(result);
  // K2 = Krone, K3 = Fundament, K4 = Front, K5 = Back, K6 = Schaleinlage
  const k2 = classAabb(result, "K2");
  const k4 = classAabb(result, "K4");
  const k6 = classAabb(result, "K6");
  const frame = wall ? wallFrame(wall, wm) : null;

  if (ruleId === "crown_min_width" && k2 && frame) {
    // Look down along heightAxis with a slight tilt along longAxis so the
    // K2 crown band reads as a 3D strip, not a flat 2D line.
    const dir = normalize3([
      frame.longAxis[0] * 0.25 + frame.heightAxis[0] * 0.95,
      frame.longAxis[1] * 0.25 + frame.heightAxis[1] * 0.95,
      frame.longAxis[2] * 0.25 + frame.heightAxis[2] * 0.95,
    ]);
    return {
      view: framedView(k2, dir, frame.heightAxis, 40, 1.45),
      highlight: { kind: "class", classKey: "K2" },
    };
  }
  if (ruleId === "crown_slope_against_hill" && k2 && frame) {
    // Krone von OBEN betrachten (nicht im Schnitt): leicht entlang thicknessAxis
    // gekippter Blick nach unten, damit das Quergefälle der Krone als 3D-Band liest.
    const dir = normalize3([
      frame.thicknessAxis[0] * 0.30 + frame.heightAxis[0] * 0.95,
      frame.thicknessAxis[1] * 0.30 + frame.heightAxis[1] * 0.95,
      frame.thicknessAxis[2] * 0.30 + frame.heightAxis[2] * 0.95,
    ]);
    return {
      view: framedView(k2, dir, frame.longAxis, 40, 1.45),
      highlight: { kind: "class", classKey: "K2" },
    };
  }
  if (ruleId === "anzug_max" && frame && (k4 || wall)) {
    // Anzug as a CROSS-SECTION (consistent with its section cut): look
    // +longAxis at the cut face so the batter trapezoid profile is head-on,
    // not the oblique front-face view the old thicknessAxis dir gave.
    return {
      view: framedView(crossSectionBox(frame), crossSectionDir(frame), frame.heightAxis, 38, 1.5),
      highlight: { kind: "class", classKey: "K4" },
    };
  }
  if (ruleId === "wall_min_nominal_thickness" && wall && frame) {
    // Cross-section: camera on the -longAxis side looking +longAxis straight at
    // the cut face (was +longAxis*0.85 → camera on the +long side staring at the
    // far end with the cut turned away). Frame the slab so the thickness profile
    // fills the view instead of the whole length.
    return {
      view: framedView(crossSectionBox(frame), crossSectionDir(frame), frame.heightAxis, 38, 1.45),
      highlight: null,
    };
  }
  // Niche / residual / volume rules — zoom on K6 (Schaleinlagen).
  if (/(niche|residual|cavity|schaleinlage|nische|volume|opening)/i.test(ruleId) && k6) {
    return {
      view: framedView(k6, [1, -1, 0.6], [0, 0, 1], 42, 1.5),
      highlight: { kind: "class", classKey: "K6" },
    };
  }
  // All-PASS / unknown rule — iso of the wall.
  const bbox = wall ?? k2 ?? k6;
  if (bbox) {
    return {
      view: framedView(bbox, [1, -1, 0.7], [0, 0, 1], 45, 1.4),
      highlight: null,
    };
  }
  // No geometry at all — neutral fallback.
  return {
    view: {
      cameraPos: [20, 18, 22], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 45,
    },
    highlight: null,
  };
}

function statusColor(s: Issue["status"]): IssueAnnotation["statusColor"] {
  if (s === "FAIL") return "fail";
  if (s === "WARN") return "warn";
  if (s === "PASS") return "pass";
  return "skip";
}

function fmtMeas(v: unknown, unit: string, digits = 3): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return "—";
  const u = prettyUnit(unit);
  return u ? `${n.toFixed(digits)} ${u}` : n.toFixed(digits);
}

// Human-readable unit + operator formatting for the on-screen Maßtext.
function prettyUnit(unit: string): string {
  const u = (unit || "").trim();
  if (u === "percent") return "%";
  if (u === "ratio") return "";
  return u;
}
// "== 3 percent" -> "= 3 %", ">= 0.3 m" -> "≥ 0.3 m", "<= 0.1" -> "≤ 0.1".
function prettySoll(soll: string): string {
  let s = (soll || "").trim();
  s = s
    .replace(/^==\s*/, "= ")
    .replace(/^>=\s*/, "≥ ")
    .replace(/^<=\s*/, "≤ ")
    .replace(/^!=\s*/, "≠ ");
  s = s.replace(/\bpercent\b/g, "%").replace(/\bratio\b/g, "").replace(/\s{2,}/g, " ").trim();
  return s;
}

// ----- Anzug als Verhältnis V:H (z.B. 10:1) statt H/V-Dezimalwert -----------
// fmtRatio: ganzzahlig wenn möglich (10:1, 5:1; sonst 4.3:1).
function fmtRatio(vh: number): string {
  if (!isFinite(vh)) return "∞";
  return String(Number(vh.toFixed(2)));
}
// gemessenes anzug_ratio (H/V) -> "V:H" (gestürzt), z.B. 0.2 -> "5:1".
function anzugRatioText(hv: number): string {
  if (!isFinite(hv)) return "—";
  if (Math.abs(hv) < 1e-9) return "∞:1";       // perfekt vertikal
  return `${fmtRatio(1 / Math.abs(hv))}:1`;
}
// Soll-Ausdruck (H/V) als Verhältnis V:H mit gestürztem Operator,
// z.B. "<= 0.1" -> "≥ 10:1" (Wand muss mind. 10:1 steil sein).
function anzugRatioSoll(soll: string): string {
  const m = (soll || "").match(/(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return prettySoll(soll);
  const op = m[1] || "<="; const t = parseFloat(m[2]);
  if (!isFinite(t) || t <= 0) return prettySoll(soll);
  const flip: Record<string, string> = { "<=": "≥", ">=": "≤", "<": ">", ">": "<", "==": "=", "!=": "≠" };
  return `${flip[op] || "≥"} ${fmtRatio(1 / t)}:1`;
}
// Anzeige-Formatter für Regel-Ist/Soll: Anzug als Verhältnis, sonst Rohwert.
export function fmtRuleValue(ruleId: string, value: number | string, einheit?: string): string {
  if (ruleId === "anzug_max") {
    const v = Number(value);
    if (isFinite(v)) return anzugRatioText(v);
  }
  // Numerische Werte auf 2 Nachkommastellen runden (z.B. 3.001423… → 3.00),
  // statt den rohen Float zu zeigen.
  const n = Number(value);
  const vs = (String(value).trim() !== "" && isFinite(n)) ? n.toFixed(2) : String(value);
  return `${vs}${einheit ? " " + einheit : ""}`;
}
export function fmtRuleSoll(ruleId: string, soll: string): string {
  return ruleId === "anzug_max" ? anzugRatioSoll(soll) : soll;
}
function statusIcon(s: Issue["status"]): string {
  return s === "PASS" ? "✓" : s === "FAIL" ? "✗" : s === "WARN" ? "!" : "•";
}

// Annotation Maßtext: "<icon> <Ist-Label> <ist> · <Soll-Label> <soll>".
// The Ist/Soll labels are UI strings (translated); the soll expression is
// rule DATA and rendered verbatim (only operator/unit prettified).
function annoText(status: Issue["status"], ist: string, soll: string): string {
  return `${statusIcon(status)} ${t("issues.annoIst")} ${ist} · ${t("issues.annoSoll")} ${prettySoll(soll)}`;
}

// DIN ISO 129 / SIA 406 annotation builder per rule. Coords stay in IFC
// space (Z-up); the viewer attaches the group to sceneContent so the wall's
// -PI/2 X rotation transports them into Three world space.
//
// Wall-frame aware: longAxis = wall length, heightAxis = vertical, thicknessAxis
// = perpendicular. Sourced from wm.wall_axes (PCA) when present, else from
// AABB-extent fallback. This is the fix for "all 4 dimensions point at the
// wrong axis" — every offset/measurement is now expressed in the wall basis
// rather than assumed to align with world X/Y/Z.
function buildAnnotation(
  ruleId: string,
  ch: RuleCheck,
  result: DetectionResult,
  wm?: { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number] },
): IssueAnnotation | undefined {
  const wall = wallAabb(result);
  const k2 = classAabb(result, "K2");
  const k4 = classAabb(result, "K4");
  const status = germanStatus(ch.status);
  const col = statusColor(status);
  const numVal = typeof ch.value === "number" ? ch.value : Number(ch.value);
  const frame = wall ? wallFrame(wall, wm) : null;

  // crown_min_width: dimension line ACROSS the crown along thicknessAxis,
  // offset along heightAxis UP. (Bug was: offset was world +Z and span was
  // narrow-AABB-side — broken on rotated walls.)
  if (ruleId === "crown_min_width" && k2 && frame) {
    const k2c = aabbCenter(k2);
    // Maßlinie length = the stated value (crown width), NOT the full crown-AABB
    // thickness — so the line never reads longer than the number it labels.
    const halfV = (isFinite(numVal) ? numVal : frame.thickness) * 0.5;
    const top = add3(k2c, frame.heightAxis, projectExtent(k2, frame.heightAxis) * 0.5 - 0.001);
    const start = add3(top, frame.thicknessAxis, -halfV);
    const end   = add3(top, frame.thicknessAxis,  halfV);
    // Tiny lift (1.5 cm) so the Maßlinie sits ON the crown surface, not floating
    // in the air above it (user: "schwebt im Raum"). depthTest:false keeps it
    // visible even flush to the mesh.
    const off = 0.015;
    return {
      kind: "dimension",
      start, end,
      offset: [frame.heightAxis[0] * off, frame.heightAxis[1] * off, frame.heightAxis[2] * off],
      text: annoText(status, fmtMeas(numVal, ch.einheit || "m"), ch.soll),
      statusColor: col,
    };
  }

  // wall_min_nominal_thickness: dimension line along thicknessAxis at mid-height,
  // offset along longAxis so the Maßlinie sits next to the cross-section.
  // (Bug was: line placed along longAxis with offset perpendicular — backwards.)
  if (ruleId === "wall_min_nominal_thickness" && wall && frame) {
    const c = frame.center;
    // Maßlinie length = the stated min-thickness value, centred on the wall
    // mid-section — never longer than the labelled number.
    const halfV = (isFinite(numVal) ? numVal : frame.thickness) * 0.5;
    const start = add3(c, frame.thicknessAxis, -halfV);
    const end   = add3(c, frame.thicknessAxis,  halfV);
    // Tiny lift (1.5 cm) along the wall run so the Maßlinie sits ON the cut
    // face instead of floating beside the wall (user: "schwebt im Raum").
    const off = 0.015;
    return {
      kind: "dimension",
      start, end,
      offset: [frame.longAxis[0] * off, frame.longAxis[1] * off, frame.longAxis[2] * off],
      text: annoText(status, fmtMeas(numVal, ch.einheit || "m"), ch.soll),
      statusColor: col,
    };
  }

  // crown_slope_against_hill: Pfeil LIEGT in der Kronenfläche (K2) und zeigt
  // entlang der ECHTEN Gefällerichtung (steilster Abstieg der gemessenen K2-
  // Ebene) — parallel zur Fläche und im richtigen Sinn, statt flach/horizontal
  // mit willkürlicher Richtung.
  if (ruleId === "crown_slope_against_hill" && k2 && frame) {
    let percent = 0;
    if (isFinite(numVal)) {
      const unit = (ch.einheit || "").trim();
      percent = unit === "°" ? Math.tan(numVal * Math.PI / 180) * 100 : numVal;
    }
    // Kronenneigung NUR in % (kein Verhältnis 1:x, keine Grad).
    const txt = annoText(status, fmtMeas(Math.abs(percent), "%", 1), ch.soll);

    // Echte K2-Krone DIESES Elements (Mesh-Normale + Schwerpunkt, IFC-Frame).
    const wmg = wm as unknown as { element_guid?: string; element_guids?: string[] } | undefined;
    const guids = new Set<string>();
    if (wmg?.element_guid) guids.add(wmg.element_guid);
    for (const g of (wmg?.element_guids || [])) guids.add(g);
    const k2s = guids.size ? faceStats(result, guids, "K2") : null;

    if (k2s) {
      // Normale nach oben orientieren (Krone schaut nach +Z).
      let n = k2s.n;
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
      // In-Ebene steilster ABSTIEG = −ẑ in die Ebene projiziert:
      // v = (n_z·n_x, n_z·n_y, n_z²−1), normiert. Liegt in der Fläche (v·n=0),
      // z-Komponente < 0 (bergab); Neigung von v == echte Flächenneigung.
      const v = normalize3([n[2] * n[0], n[2] * n[1], n[2] * n[2] - 1]);
      const lift = 0.02;   // minimal entlang n abheben → sitzt AUF der Krone
      const center: [number, number, number] = [
        k2s.c[0] + n[0] * lift, k2s.c[1] + n[1] * lift, k2s.c[2] + n[2] * lift,
      ];
      const armLen = Math.max(0.3, frame.thickness * 0.8);
      const tail = add3(center, v, -armLen * 0.5);   // oben (bergauf)
      const head = add3(center, v,  armLen * 0.5);   // unten (Gefälle) = Pfeilspitze
      return { kind: "arrow", start: tail, end: head, runDir: v, text: txt, statusColor: col };
    }

    // Fallback ohne K2-Mesh-Daten: flacher Pfeil entlang thicknessAxis.
    const k2c = aabbCenter(k2);
    const sign = percent < 0 ? -1 : 1;
    const armLen = Math.max(0.3, frame.thickness * 0.6);
    const zTop = k2.max[2] + 0.02;
    const tail = add3([k2c[0], k2c[1], zTop], frame.thicknessAxis, -sign * armLen * 0.5);
    const head = add3([k2c[0], k2c[1], zTop], frame.thicknessAxis,  sign * armLen * 0.5);
    return { kind: "arrow", start: tail, end: head, runDir: frame.thicknessAxis, text: txt, statusColor: col };
  }

  // anzug_max: gerader Pfeil ENTLANG der Front-Face, parallel zur (geneigten)
  // Wandoberfläche. Geht in Gefällerichtung von oben nach unten. Länge =
  // ~70% Wandhöhe, leicht vor der Fläche (~10 cm), Label am Pfeilmitte.
  if (ruleId === "anzug_max" && frame && (k4 || wall)) {
    const bbox = k4 ?? wall!;
    let ratioHV = 0;
    if (isFinite(numVal)) {
      const unit = (ch.einheit || "").trim();
      ratioHV = unit === "°" ? Math.tan(numVal * Math.PI / 180) : numVal;
    }
    // Direction along the inclined front face: heightAxis tilted by -ratioHV
    // along thicknessAxis (the slope is "back" as you go up).
    const surfDir = normalize3([
      frame.heightAxis[0] - ratioHV * frame.thicknessAxis[0],
      frame.heightAxis[1] - ratioHV * frame.thicknessAxis[1],
      frame.heightAxis[2] - ratioHV * frame.thicknessAxis[2],
    ]);
    const wallH = projectExtent(bbox, frame.heightAxis);
    const armLen = wallH * 0.70;
    // Anchor at front-face centre. front face = bbox center pushed in
    // -thicknessAxis direction by half-thickness, then nur 3 cm davor (vorher
    // 10 cm → wirkte in der engen BCF-Ansicht „sehr weit weg").
    const bC = aabbCenter(bbox);
    const halfTh = projectExtent(bbox, frame.thicknessAxis) * 0.5;
    const frontC = add3(bC, frame.thicknessAxis, -halfTh - 0.03);
    // Top of arrow = high on the face; bottom = low. Sign: arrow head points
    // downward (Gefällerichtung).
    const top = add3(frontC, surfDir,  armLen * 0.5);
    const bot = add3(frontC, surfDir, -armLen * 0.5);
    return {
      kind: "arrow",
      start: top,            // tail
      end:   bot,            // head (Pfeilspitze)
      runDir: surfDir,
      text: annoText(status, anzugRatioText(ratioHV), anzugRatioSoll(ch.soll)),
      statusColor: col,
    };
  }

  // Fallback for unknown rules: bullets badge at wall bbox top corner so we
  // don't paint a sprite "irgendwo in der Welt".
  if (wall) {
    return {
      kind: "bullets",
      start: [wall.max[0], wall.max[1], wall.max[2] + 0.3],
      end: [wall.max[0], wall.max[1], wall.max[2] + 0.3],
      text: `${statusIcon(status)} ${ch.label}: ${fmtMeas(numVal, ch.einheit || "")}`,
      statusColor: col,
    };
  }
  return undefined;
}

// Section plane per rule (Task B). Cuts through the wall at the issue
// location so the engineer sees a cross-section. Default-on for thickness/
// anzug/slope rules (cross-section is the engineering-natural view) and
// crown_width (the refined cut shows the crown profile head-on).
function buildSection(
  ruleId: string,
  result: DetectionResult,
  wm?: { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number] },
): SectionPlane | null {
  const wall = wallAabb(result);
  if (!wall) return null;
  const frame = wallFrame(wall, wm);
  if (ruleId === "wall_min_nominal_thickness" || ruleId === "anzug_max"
      || ruleId === "crown_min_width") {
    // Vertical cut perpendicular to longAxis at mid-length — shows the wall-
    // thickness / crown-width profile (engineer-classic Schnitt). Normal =
    // +longAxis (keep the half going in +longAxis direction visible).
    // crown_min_width nutzt denselben Schnitt wie die Wandstärke; im Bild wird
    // nur die K2-Krone gezeigt (Klassen-Isolation im Viewer).
    return { normal: frame.longAxis, point: frame.center };
  }
  // crown_slope_against_hill: KEIN Schnitt — die Krone wird schräg von oben
  // betrachtet (siehe pickView); ein Schnitt verdeckt die Querneigung nur.
  return null;
}

// Default-on map for the section toggle (Task B). The wizard footer Schnitt
// button reads this to set the initial state per rule.
const SECTION_DEFAULT_ON: Record<string, boolean> = {
  wall_min_nominal_thickness: true,
  anzug_max: true,
  crown_slope_against_hill: false,
  crown_min_width: true,
};
export function isSectionDefaultOn(ruleId: string): boolean {
  return SECTION_DEFAULT_ON[ruleId] === true;
}

// BCF 2.1 viewpoint serialised onto each issue (Task C). Lets a future
// .bcf exporter build viewpoint.bcfv files without redoing the math.
// Modell-Bbox-Zentrum (LV95), um das die Pipeline/der Renderer die Geometrie
// zentriert (Float32-Praezision bei georeferenzierten Modellen). Liegt im
// result.scene und wird beim BCF-Export wieder aufaddiert.
function sceneOffsetOf(result: DetectionResult): readonly number[] | null {
  const o = (result.scene as { offset?: number[] } | undefined)?.offset;
  return Array.isArray(o) && o.length === 3 ? o : null;
}

function buildBcfViewpoint(
  view: IssueView,
  fovDeg: number,
  section: SectionPlane | null,
  guid: string | undefined,
  annotation?: IssueAnnotation,
  sceneOffset?: readonly number[] | null,
): BcfViewpoint {
  // Camera direction = target - cameraPos. Three world -> IFC: x=x, y=-z, z=y.
  const camIfc: [number, number, number] = [view.cameraPos[0], -view.cameraPos[2], view.cameraPos[1]];
  const tgtIfc: [number, number, number] = [view.target[0], -view.target[2], view.target[1]];
  const upIfc: [number, number, number] = [view.up[0], -view.up[2], view.up[1]];
  const dir = normalize3([tgtIfc[0] - camIfc[0], tgtIfc[1] - camIfc[1], tgtIfc[2] - camIfc[2]]);
  // Geometrie ist um das Modell-Bbox-Zentrum zentriert; BimCollab platziert das
  // Original aber bei den ECHTEN Weltkoordinaten (z.B. LV95 ~2.6 Mio). Offset
  // zurueckaddieren, sonst landen Kamera + Schnittebene Millionen Meter daneben
  // ("Kamera springt ins Leere", kein sichtbarer Schnitt). Richtungs-/Up-Vektoren
  // bleiben unveraendert (Translation betrifft nur Punkte).
  const off = sceneOffset && sceneOffset.length === 3 ? sceneOffset : [0, 0, 0];
  const W = (p: readonly number[]): [number, number, number] =>
    [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  const vp: BcfViewpoint = {
    perspectiveCamera: {
      cameraViewPoint: W(camIfc),
      cameraDirection: dir,
      cameraUpVector: normalize3(upIfc),
      fieldOfView: fovDeg,
    },
  };
  // Dimension/arrow annotations carry their endpoints in IFC space already, so
  // they map straight onto a BCF redline <Line> (the measured span). Skip the
  // 2D-fallback "bullets" badge (no meaningful geometry there).
  if (annotation && annotation.kind !== "bullets"
      && annotation.start && annotation.end) {
    // Die im 3D dargestellte Maßlinie als BCF-Redlines nachbauen, damit BimCollab
    // sie im 3D-View zeigt: Hauptlinie + Pfeilkoepfe (bei "dimension" an beiden
    // Enden, bei "arrow" nur am Kopf). Der Messwert-TEXT kann in BCF-Lines nicht
    // mitgegeben werden -> steht in Topic-Titel/-Beschreibung/-Comment.
    const A = annotation.start as number[];
    const B = annotation.end as number[];
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const d: [number, number, number] = [dx / len, dy / len, dz / len];
    // Perpendikular in der Bild-/Vertikalebene: cross(d, Z); falls d ~|| Z -> cross(d, X).
    let pp: [number, number, number] = [d[1], -d[0], 0];
    if (Math.hypot(pp[0], pp[1], pp[2]) < 1e-6) pp = [0, d[2], -d[1]];
    const pl = Math.hypot(pp[0], pp[1], pp[2]) || 1;
    pp = [pp[0] / pl, pp[1] / pl, pp[2] / pl];
    const h = Math.max(0.04, Math.min(0.25, len * 0.08));
    const segs: { start: number[]; end: number[] }[] = [{ start: A, end: B }];
    const head = (tip: number[], dir: [number, number, number]) => {
      segs.push({ start: tip, end: [tip[0] - dir[0] * h + pp[0] * h * 0.6, tip[1] - dir[1] * h + pp[1] * h * 0.6, tip[2] - dir[2] * h + pp[2] * h * 0.6] });
      segs.push({ start: tip, end: [tip[0] - dir[0] * h - pp[0] * h * 0.6, tip[1] - dir[1] * h - pp[1] * h * 0.6, tip[2] - dir[2] * h - pp[2] * h * 0.6] });
    };
    head(B, d);
    if (annotation.kind === "dimension") head(A, [-d[0], -d[1], -d[2]]);
    vp.lines = segs.map((s) => ({ start: W(s.start), end: W(s.end) }));
  }
  if (section) {
    // BCF/BimCollab-Konvention (buildingSMART BCF-XML #193, in BCF 3.0 kodifiziert):
    // die ClippingPlane-Direction zeigt in die WEGGESCHNITTENE (unsichtbare) Haelfte.
    // section.normal zeigt aber auf die BEHALTENE Seite (three.js behaelt +normal) ->
    // fuer BCF negieren, sonst schneidet BimCollab genau die Haelfte weg, die man
    // sehen will (Symptom: "Schnitt tut nichts"/falsche Haelfte weg). Richtung wird
    // NICHT mit dem sceneOffset verschoben (Translation betrifft nur Punkte).
    const n = normalize3(section.normal);
    vp.clippingPlanes = [{ location: W(section.point), direction: [-n[0], -n[1], -n[2]] }];
  }
  if (guid) {
    vp.components = {
      visibility: { defaultVisibility: true, exceptions: [] },
      selection: [guid],
    };
  }
  return vp;
}

function shortDescription(ch: RuleCheck): string {
  const verb = ch.status === "PASS"
    ? t("issues.verbPass")
    : ch.status === "FAIL"
      ? t("issues.verbFail")
      : ch.status === "WARN"
        ? t("issues.verbWarn")
        : t("issues.verbSkip");
  const ist = `${ch.value}${ch.einheit ? " " + ch.einheit : ""}`;
  // soll expression is rule DATA → verbatim.
  return t("issues.shortDesc", { verb, ist, soll: ch.soll });
}

export function deriveIssues(result: DetectionResult): Issue[] {
  const out: Issue[] = [];
  const wms = result.wall_metrics || [];
  const sceneOffset = sceneOffsetOf(result);
  wms.forEach((wm, wi) => {
    const checks = wm.pruefung || [];
    const wmTyped = wm as { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number]; element_guid?: string };
    checks.forEach((ch, ci) => {
      const status = germanStatus(ch.status);
      const { view, highlight } = pickView(ch.id, result, wmTyped);
      const annotation = buildAnnotation(ch.id, ch, result, wmTyped);
      const section = buildSection(ch.id, result, wmTyped);
      const bcfViewpoint = buildBcfViewpoint(view, view.fovDeg ?? 45, section, wmTyped.element_guid, annotation, sceneOffset);
      out.push({
        id: `w${wi}_r${ci}_${ch.id}`,
        wallIndex: wi,
        ruleId: ch.id,
        label: ch.label,
        status,
        istValue: `${ch.value}${ch.einheit ? " " + ch.einheit : ""}`,
        sollValue: ch.soll,
        shortDescription: shortDescription(ch),
        view,
        highlight,
        annotation,
        section,
        bcfViewpoint,
      });
    });
    if (checks.length === 0) {
      // No rules — emit a summary card for the wall using iso view.
      const wall = wallAabb(result);
      const view = wall
        ? framedView(wall, [1, -1, 0.7], [0, 0, 1], 45, 1.4)
        : { cameraPos: [20, 18, 22] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], fovDeg: 45 };
      out.push({
        id: `w${wi}_summary`,
        wallIndex: wi,
        ruleId: "wall_summary",
        label: wm.element_name || t("kpi.wallFallback"),
        status: "SKIP",
        istValue: "—",
        sollValue: "—",
        shortDescription: t("wiz.noAstraRules"),
        view,
        highlight: null,
      });
    }
  });
  out.sort((a, b) => {
    const d = SEV_RANK[a.status] - SEV_RANK[b.status];
    if (d !== 0) return d;
    return a.wallIndex - b.wallIndex;
  });
  // Re-id after sort so indices in counter „1 / N" track display order.
  return out;
}

// ----- Exakte Maß-Platzierung auf der Schnittebene (lazy) ------------------
// Schneidet das Wand-Mesh mit der Issue-Schnittebene und verankert die Maß-/
// Pfeil-Endpunkte an den ECHTEN Schnittpunkten der Ebene mit den zu
// vermassenden Kanten (statt am Frame-Center). Wird LAZY aufgerufen: beim
// Öffnen eines Issues (wizard/shell) und beim BCF-Export. Mutiert issue in-place
// (Annotation + bcfViewpoint.lines) und merkt sich __refined.
function _planePts(
  V: number[], F: number[],
  n: [number, number, number],
  p: [number, number, number],
): [number, number, number][] {
  if (!V || !F || V.length < 9) return [];
  const sd = (i: number) =>
    (V[i * 3] - p[0]) * n[0] + (V[i * 3 + 1] - p[1]) * n[1] + (V[i * 3 + 2] - p[2]) * n[2];
  const out: [number, number, number][] = [];
  const edge = (i0: number, i1: number, d0: number, d1: number) => {
    if ((d0 > 0) === (d1 > 0)) return;
    const t = d0 / (d0 - d1);
    out.push([
      V[i0 * 3] + (V[i1 * 3] - V[i0 * 3]) * t,
      V[i0 * 3 + 1] + (V[i1 * 3 + 1] - V[i0 * 3 + 1]) * t,
      V[i0 * 3 + 2] + (V[i1 * 3 + 2] - V[i0 * 3 + 2]) * t,
    ]);
  };
  for (let f = 0; f + 2 < F.length; f += 3) {
    const a = F[f], b = F[f + 1], c = F[f + 2];
    const da = sd(a), db = sd(b), dc = sd(c);
    edge(a, b, da, db); edge(b, c, db, dc); edge(c, a, dc, da);
  }
  return out;
}
function _proj(pt: [number, number, number], o: [number, number, number], ax: [number, number, number]): number {
  return (pt[0] - o[0]) * ax[0] + (pt[1] - o[1]) * ax[1] + (pt[2] - o[2]) * ax[2];
}
function _extremesAlong(
  pts: [number, number, number][], o: [number, number, number], ax: [number, number, number],
): { lo: [number, number, number]; hi: [number, number, number] } {
  let lo = pts[0], hi = pts[0], loV = Infinity, hiV = -Infinity;
  for (const pt of pts) {
    const v = _proj(pt, o, ax);
    if (v < loV) { loV = v; lo = pt; }
    if (v > hiV) { hiV = v; hi = pt; }
  }
  return { lo, hi };
}

// Flächen-Mittelnormale + flächengewichteter Schwerpunkt über die Cavities
// EINES Elements einer Klasse — robuste Achsen-Quelle aus der Mesh-Geometrie
// (die per-Element-PCA wall_axes sind bei gedrehten Wänden unzuverlässig).
function faceStats(result: DetectionResult, guids: Set<string>, kind: string):
  { n: [number, number, number]; c: [number, number, number]; a: number } | null {
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, aSum = 0;
  for (const cav of (result.cavities || [])) {
    if (!cav.element_guid || !guids.has(cav.element_guid) || cav.kind !== kind) continue;
    const V = cav.vertices, Fc = cav.faces;
    for (let f = 0; f + 2 < Fc.length; f += 3) {
      const i0 = Fc[f] * 3, i1 = Fc[f + 1] * 3, i2 = Fc[f + 2] * 3;
      const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
      const bx = V[i1], by = V[i1 + 1], bz = V[i1 + 2];
      const dx = V[i2], dy = V[i2 + 1], dz = V[i2 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
      const crx = e1y * e2z - e1z * e2y, cry = e1z * e2x - e1x * e2z, crz = e1x * e2y - e1y * e2x;
      nx += crx; ny += cry; nz += crz;
      const ar = Math.hypot(crx, cry, crz) * 0.5;
      cx += (ax + bx + dx) / 3 * ar; cy += (ay + by + dy) / 3 * ar; cz += (az + bz + dz) / 3 * ar;
      aSum += ar;
    }
  }
  if (aSum <= 1e-9) return null;
  const nl = Math.hypot(nx, ny, nz) || 1;
  return { n: [nx / nl, ny / nl, nz / nl], c: [cx / aSum, cy / aSum, cz / aSum], a: aSum };
}

export function refineIssueAnnotation(issue: Issue, result: DetectionResult): void {
  const anyI = issue as unknown as { __refined?: boolean };
  if (anyI.__refined) return;
  const a = issue.annotation;
  if (!a) { anyI.__refined = true; return; }
  const id = issue.ruleId;
  if (id !== "wall_min_nominal_thickness" && id !== "anzug_max"
      && id !== "crown_slope_against_hill" && id !== "crown_min_width") {
    anyI.__refined = true;
    return; // andere Regeln: Platzierung/Kamera unverändert lassen
  }
  try {
    const wm = (result.wall_metrics || [])[issue.wallIndex] as
      { wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] }; centroid?: [number, number, number]; element_guid?: string; element_guids?: string[] } | undefined;
    // NUR die Geometrie DIESES Elements (seine Cavities) — nicht das ganze
    // 53-Wand-Modell. Sonst spannt der Schnitt über alles und die Kamera steht
    // viel zu weit (→ Text zu groß, Maßlinie viel zu lang).
    const guids = new Set<string>();
    if (wm?.element_guid) guids.add(wm.element_guid);
    for (const g of (wm?.element_guids || [])) guids.add(g);
    const V: number[] = []; const F: number[] = [];
    for (const c of (result.cavities || [])) {
      if (!c.element_guid || !guids.has(c.element_guid)) continue;
      const base = V.length / 3;
      for (const x of c.vertices) V.push(x);
      for (const ix of c.faces) F.push(ix + base);
    }
    const elemAABB = V.length >= 9 ? meshAabb(V) : wallAabb(result);
    if (!elemAABB) { anyI.__refined = true; return; }
    const frame = wallFrame(elemAABB, wm);
    const upAxis: [number, number, number] = [0, 0, 1]; // Welt-vertikal (zuverlässig)
    // Front/Back-Flächenstatistik (Mesh-Geometrie) → robuste Achsen; wall_axes
    // (long/thickness) sind bei gedrehten Wänden unzuverlässig (Diagnose: 66 m).
    const F4s = faceStats(result, guids, "K4");
    const F5s = faceStats(result, guids, "K5");
    // Lauf-/Schnittnormale = nf × Z (horizontal entlang der Wand).
    let normal: [number, number, number];
    if (F4s) {
      const nf = F4s.n; const rx = nf[1], ry = -nf[0];
      const rl = Math.hypot(rx, ry, 0);
      normal = rl > 1e-6 ? [rx / rl, ry / rl, 0] : [frame.longAxis[0], frame.longAxis[1], frame.longAxis[2]];
    } else {
      normal = [frame.longAxis[0], frame.longAxis[1], frame.longAxis[2]];
    }
    const point: [number, number, number] = [frame.center[0], frame.center[1], frame.center[2]];
    issue.section = { normal, point };
    // Echte Maße für ein enges, head-on (Blick entlang -normal) gerahmtes Bild.
    const realTh = (F4s && F5s) ? Math.max(0.05, Math.abs(_proj(F5s.c, F4s.c, F4s.n))) : Math.max(0.05, frame.thickness);
    const realH = Math.max(0.1, elemAABB.max[2] - elemAABB.min[2]);
    const diag = Math.hypot(realH, realTh);
    const hs = diag / Math.sqrt(3) / 2;
    const cc = frame.center;
    const camBox = {
      min: [cc[0] - hs, cc[1] - hs, cc[2] - hs] as [number, number, number],
      max: [cc[0] + hs, cc[1] + hs, cc[2] + hs] as [number, number, number],
    };
    issue.view = framedView(camBox, [-normal[0], -normal[1], -normal[2]], upAxis, 36, 1.15);

    if (id === "wall_min_nominal_thickness" || id === "crown_min_width") {
      const atTop = id === "crown_min_width";
      // Fallback-Querrichtung aus den Flächen-Schwerpunkten (Front→Back).
      let dir: [number, number, number];
      if (F4s && F5s) {
        const dx = F5s.c[0] - F4s.c[0], dy = F5s.c[1] - F4s.c[1], dz = F5s.c[2] - F4s.c[2];
        const dl = Math.hypot(dx, dy, dz) || 1; dir = [dx / dl, dy / dl, dz / dl];
      } else {
        dir = [frame.thicknessAxis[0], frame.thicknessAxis[1], frame.thicknessAxis[2]];
      }
      // ECHTE Schnittpunkte der Klassenfläche mit der Schnittebene.
      const classCut = (kind: string): [number, number, number][] => {
        const vv: number[] = []; const ff: number[] = [];
        for (const c of (result.cavities || [])) {
          if (!c.element_guid || !guids.has(c.element_guid) || c.kind !== kind) continue;
          const b2 = vv.length / 3;
          for (const x of c.vertices) vv.push(x);
          for (const ix of c.faces) ff.push(ix + b2);
        }
        return _planePts(vv, ff, normal, point);
      };
      const midZ = (elemAABB.min[2] + elemAABB.max[2]) / 2;
      const pickAt = (ps: [number, number, number][], top: boolean): [number, number, number] | null => {
        if (!ps.length) return null;
        let best = ps[0];
        for (const p of ps) {
          if (top ? (p[2] > best[2]) : (Math.abs(p[2] - midZ) < Math.abs(best[2] - midZ))) best = p;
        }
        return best;
      };
      const val = parseFloat(String(issue.istValue));
      const w = (isFinite(val) && val > 0) ? val : realTh; // korrekte Breite = Wert
      if (atTop) {
        // Kronenbreite = beide OBEREN Schnitt-Eckpunkte (echte OK-Punkte).
        const Pf = pickAt(classCut("K4"), true);
        const Pb = pickAt(classCut("K5"), true);
        if (Pf && Pb) { a.start = Pf; a.end = Pb; }
        else {
          const tz = elemAABB.max[2] - Math.max(0.05, realH * 0.06);
          const ce: [number, number, number] = (F4s && F5s)
            ? [(F4s.c[0] + F5s.c[0]) / 2, (F4s.c[1] + F5s.c[1]) / 2, tz]
            : [frame.center[0], frame.center[1], tz];
          a.start = [ce[0] - dir[0] * w / 2, ce[1] - dir[1] * w / 2, ce[2] - dir[2] * w / 2];
          a.end = [ce[0] + dir[0] * w / 2, ce[1] + dir[1] * w / 2, ce[2] + dir[2] * w / 2];
        }
      } else {
        // Wandstärke = MIN-Mass DORT wo es gemessen wird: das ENGSTE Front(K4)/
        // Back(K5)-Paar im Schnitt (kleinster horizontaler Abstand auf gleicher
        // Höhe). Maßlinie genau dort, auf gemeinsame Höhe gelegt → horizontal.
        const fp = classCut("K4"); const bp = classCut("K5");
        let bestF: [number, number, number] | null = null;
        let bestB: [number, number, number] | null = null;
        let bestD = Infinity;
        const hTol = Math.max(0.05, realH * 0.15);
        for (const pb of bp) {
          for (const pf of fp) {
            if (Math.abs(pf[2] - pb[2]) > hTol) continue; // nur ~gleiche Höhe
            const dx = pf[0] - pb[0], dy = pf[1] - pb[1];
            const d = Math.hypot(dx, dy);
            if (d < bestD) { bestD = d; bestF = pf; bestB = pb; }
          }
        }
        // Maßlinie auf Höhe der Mauer-OBERKANTE legen (zTop), aber die
        // Front/Back-x,y der dünnsten Stelle behalten → die LÄNGE bleibt die
        // Mindest-Wandstärke, die Begrenzungslinien liegen aber ÜBER der Wand
        // (in der Luft, mit Lücke), statt an den Stirnflächen hochzulaufen.
        const zTop = elemAABB.max[2];
        if (bestF && bestB) {
          a.start = [bestF[0], bestF[1], zTop];
          a.end = [bestB[0], bestB[1], zTop];
        } else {
          // Fallback: Wert-Länge mittig, horizontal, an der Oberkante.
          let dh: [number, number, number];
          if (F4s && F5s) {
            const dx = F5s.c[0] - F4s.c[0], dy = F5s.c[1] - F4s.c[1];
            const dl = Math.hypot(dx, dy) || 1; dh = [dx / dl, dy / dl, 0];
          } else {
            const dl = Math.hypot(frame.thicknessAxis[0], frame.thicknessAxis[1]) || 1;
            dh = [frame.thicknessAxis[0] / dl, frame.thicknessAxis[1] / dl, 0];
          }
          const ce: [number, number, number] = (F4s && F5s)
            ? [(F4s.c[0] + F5s.c[0]) / 2, (F4s.c[1] + F5s.c[1]) / 2, zTop]
            : [frame.center[0], frame.center[1], zTop];
          a.start = [ce[0] - dh[0] * w / 2, ce[1] - dh[1] * w / 2, zTop];
          a.end = [ce[0] + dh[0] * w / 2, ce[1] + dh[1] * w / 2, zTop];
        }
      }
      a.kind = "dimension";
      // Krone: knapp über die OK. Wandstärke: feste ~30 cm über die Mauer-
      // Oberkante (unabhängig davon, auf welcher Höhe die dünnste Stelle liegt).
      // Maßlinie ÜBER die Mauer-Oberkante heben (nach oben), unabhängig davon,
      // auf welcher Höhe die dünnste Stelle gemessen wurde — Hilfslinien laufen
      // von der Messstelle hoch. Krone: kleiner Gap über der OK.
      const lift = atTop
        ? Math.max(0.08, realH * 0.04)
        // Wandstärke: Maßlinie näher an die Mauer-Oberkante (tiefer als zuvor),
        // die Begrenzungslinien reichen mit kleiner Lücke fast bis zur Kante.
        : Math.max(0.08, (elemAABB.max[2] + 0.07) - a.start[2]);
      a.offset = [upAxis[0] * lift, upAxis[1] * lift, upAxis[2] * lift];
    } else {
      const mV = V.length >= 9 ? V : (result.wall_mesh?.vertices || []);
      const mF = V.length >= 9 ? F : (result.wall_mesh?.faces || []);
      const pts = _planePts(mV, mF, normal, point);
      // Robuste horizontale Querrichtung (Front→Back) aus den K4/K5-Flächen —
      // die PCA-thicknessAxis ist bei gedrehten Wänden unzuverlässig (Diagnose
      // 66 m), genau wie bei Wandstärke/Krone. Fallback: PCA-thicknessAxis.
      let dirH: [number, number, number];
      if (F4s && F5s) {
        const dx = F5s.c[0] - F4s.c[0], dy = F5s.c[1] - F4s.c[1];
        const dl = Math.hypot(dx, dy) || 1; dirH = [dx / dl, dy / dl, 0];
      } else {
        const dl = Math.hypot(frame.thicknessAxis[0], frame.thicknessAxis[1]) || 1;
        dirH = [frame.thicknessAxis[0] / dl, frame.thicknessAxis[1] / dl, 0];
      }
      if (pts.length >= 2) {
        if (id === "anzug_max") {
          // Pfeil MITTIG auf die K4-Fläche, entlang des steilsten Abstiegs
          // (Gefälle = senkrecht nach unten, in die geneigte Flächenebene projiziert).
          // Nur minimal zur Kamera (−normal) gehoben, damit er nicht im Schnitt-
          // Cap verschwindet. Spitze unten = bergab = Anzugsrichtung.
          const camLift = Math.max(0.01, realTh * 0.05);   // gegen Z-Fighting (zur Kamera)
          const offMag = Math.max(0.18, realTh * 0.6);      // Parallel-Versatz wie die Maßlinien
          const half = Math.max(0.15, realH * 0.30);
          if (F4s) {
            // steilster Abstieg auf der Fläche: down − (down·n)·n, down=[0,0,−1]
            const n4 = F4s.n;
            const slope = normalize3([n4[2] * n4[0], n4[2] * n4[1], n4[2] * n4[2] - 1]);
            // Pfeil SENKRECHT von der Fläche weg versetzen (entlang Flächennormale
            // n4 zur Luftseite, um offMag) — gleicher Parallelabstand wie die
            // Maßlinien neben dem Element — plus minimaler Kamera-Versatz.
            const ox = n4[0] * offMag - normal[0] * camLift;
            const oy = n4[1] * offMag - normal[1] * camLift;
            const oz = n4[2] * offMag - normal[2] * camLift;
            const c = F4s.c;
            const dd = (c[0] - point[0]) * normal[0] + (c[1] - point[1]) * normal[1] + (c[2] - point[2]) * normal[2];
            const cx = c[0] - dd * normal[0] + ox, cy = c[1] - dd * normal[1] + oy, cz = c[2] - dd * normal[2] + oz;
            a.start = [cx - slope[0] * half, cy - slope[1] * half, cz - slope[2] * half]; // tail (oben)
            a.end = [cx + slope[0] * half, cy + slope[1] * half, cz + slope[2] * half];   // head (unten)
          } else {
            // Fallback ohne K4-Statistik: zentriertes Segment der geneigten Kante,
            // um offMag entlang −dirH (zur Luftseite) parallel versetzt.
            const lx = -dirH[0] * offMag - normal[0] * camLift, ly = -dirH[1] * offMag - normal[1] * camLift, lz = -dirH[2] * offMag - normal[2] * camLift;
            const tproj = pts.map((pt) => _proj(pt, frame.center, dirH));
            const tmin = Math.min(...tproj), tmax = Math.max(...tproj);
            const thr = tmin + (tmax - tmin) * 0.25;
            const front = pts.filter((pt) => _proj(pt, frame.center, dirH) <= thr);
            const fp = front.length >= 2 ? front : pts;
            const { lo, hi } = _extremesAlong(fp, frame.center, frame.heightAxis);
            a.start = [hi[0] + (lo[0] - hi[0]) * 0.2 + lx, hi[1] + (lo[1] - hi[1]) * 0.2 + ly, hi[2] + (lo[2] - hi[2]) * 0.2 + lz];
            a.end = [hi[0] + (lo[0] - hi[0]) * 0.8 + lx, hi[1] + (lo[1] - hi[1]) * 0.8 + ly, hi[2] + (lo[2] - hi[2]) * 0.8 + lz];
          }
          a.kind = "arrow";
        } else { // crown_slope_against_hill
          // Pfeil LIEGT in der ECHTEN Kronenfläche (K2-Mesh-Normale) und zeigt
          // entlang des steilsten Abstiegs der gemessenen K2-Ebene → parallel zur
          // Fläche, in korrekter Gefällerichtung (bergab). Ersetzt die frühere
          // Kanten-Extrema-Logik, die nicht flächenparallel war.
          const k2s = faceStats(result, guids, "K2");
          let nrmH = 0;
          if (k2s) {
            let n2 = k2s.n;
            if (n2[2] < 0) n2 = [-n2[0], -n2[1], -n2[2]];   // Normale nach oben
            nrmH = Math.hypot(n2[0], n2[1]);                 // horizontale Komponente = Gefälle
          }
          if (k2s && nrmH > 1e-4) {
            let n2 = k2s.n; if (n2[2] < 0) n2 = [-n2[0], -n2[1], -n2[2]];
            // In-Ebene steilster Abstieg: v = −ẑ in die Ebene projiziert,
            // v = (n_z·n_x, n_z·n_y, n_z²−1); liegt in der Fläche (v·n=0), bergab.
            const v = normalize3([n2[2] * n2[0], n2[2] * n2[1], n2[2] * n2[2] - 1]);
            const half = Math.max(0.12, frame.thickness * 0.22);   // kürzer (war zu gross)
            const lift = 0.03;   // minimal entlang der Normale → sitzt AUF der Krone
            const c: [number, number, number] = [
              k2s.c[0] + n2[0] * lift, k2s.c[1] + n2[1] * lift, k2s.c[2] + n2[2] * lift,
            ];
            a.start = [c[0] - v[0] * half, c[1] - v[1] * half, c[2] - v[2] * half]; // tail (bergauf)
            a.end = [c[0] + v[0] * half, c[1] + v[1] * half, c[2] + v[2] * half];   // head (bergab) = Spitze
          } else {
            // Fallback (keine K2-Statistik / flache Krone): bisherige Kanten-Extrema.
            const zs = pts.map((p) => p[2]);
            const zMax = Math.max(...zs), zMin = Math.min(...zs);
            const zThr = zMax - (zMax - zMin) * 0.15;
            const top = pts.filter((p) => p[2] >= zThr);
            const tp = top.length >= 2 ? top : pts;
            const ext = _extremesAlong(tp, frame.center, dirH);
            const hiP = ext.lo[2] >= ext.hi[2] ? ext.lo : ext.hi;
            const loP = ext.lo[2] >= ext.hi[2] ? ext.hi : ext.lo;
            const f = 0.10;
            const tx = hiP[0] + (loP[0] - hiP[0]) * f, ty = hiP[1] + (loP[1] - hiP[1]) * f, tz = hiP[2] + (loP[2] - hiP[2]) * f;
            const hx = loP[0] + (hiP[0] - loP[0]) * f, hy = loP[1] + (hiP[1] - loP[1]) * f, hz = loP[2] + (hiP[2] - loP[2]) * f;
            const ul = Math.max(0.04, (zMax - zMin) * 0.05);
            a.start = [tx, ty, tz + ul];
            a.end = [hx, hy, hz + ul];
          }
          a.kind = "arrow";
        }
      }
    }
    // crown_min_width nutzt jetzt denselben Querschnitt-Blick + Schnitt wie
    // wall_min_nominal_thickness (oben gesetzt: issue.section/issue.view); im Bild
    // wird nur die K2-Krone gezeigt (Klassen-Isolation im Viewer via highlight=K2).
    // NUR crown_slope bleibt Sonderfall (Schrägblick von oben, kein Schnitt).
    if (id === "crown_min_width") {
      // Wie Wandstärke (Querschnitt + Schnitt), aber Kamera ~10° VON OBEN gekippt
      // statt head-on direkt im Schnitt — die Krone wird leicht von oben sichtbar.
      // camBox/section bleiben wie oben gesetzt.
      const tilt = 0.176;   // tan(10°)
      const ddir = normalize3([-normal[0] + upAxis[0] * tilt, -normal[1] + upAxis[1] * tilt, -normal[2] + upAxis[2] * tilt]);
      issue.view = framedView(camBox, ddir, upAxis, 36, 1.15);
    }
    if (id === "crown_slope_against_hill") {
      issue.section = null;
      // 3/4-Schrägblick die Mauer entlang, nur ~25° über der Horizontalen — KEINE
      // Draufsicht (sonst ist die Querneigung foreshortened zu null), kein Schnitt.
      const ddir = normalize3([
        frame.longAxis[0] * 0.65 + frame.thicknessAxis[0] * 0.45 + upAxis[0] * 0.45,
        frame.longAxis[1] * 0.65 + frame.thicknessAxis[1] * 0.45 + upAxis[1] * 0.45,
        frame.longAxis[2] * 0.65 + frame.thicknessAxis[2] * 0.45 + upAxis[2] * 0.45,
      ]);
      issue.view = framedView(elemAABB, ddir, upAxis, 40, 1.3);
    }
    // bcfViewpoint mit neuer Element-Kamera + Redline auffrischen (für Export).
    issue.bcfViewpoint = buildBcfViewpoint(issue.view, issue.view.fovDeg ?? 40, issue.section, wm?.element_guid, a, sceneOffsetOf(result));
  } catch {
    // Geometrie-Fehler: alles beim Alten lassen.
  }
  anyI.__refined = true;
}

// Used by stub fallbacks (e.g. to construct a baseline view) — exported so
// the wizard can hand the viewer a sane reset when leaving guided mode.
export function isoViewOfResult(result: DetectionResult): IssueView {
  const bbox = wallAabb(result);
  if (bbox) return framedView(bbox, [1, -1, 0.7], [0, 0, 1], 45, 1.4);
  return { cameraPos: [20, 18, 22], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 45 };
}

// ===== Stützmauer-Gruppierung über deckungsgleiche K0/K1-Stirnflächen ========
// Zwei Wandsegmente gehören zur selben Stützmauer, wenn je eine ihrer
// Stirnflächen (K0/K1) geometrisch deckungsgleich ist: Schwerpunkte nahe,
// Flächennormalen ~antiparallel (zeigen ineinander) und Flächen ähnlich gross.
type _EF = { c: [number, number, number]; n: [number, number, number]; a: number };
function _coincident(p: _EF, q: _EF): boolean {
  const d = Math.hypot(p.c[0] - q.c[0], p.c[1] - q.c[1], p.c[2] - q.c[2]);
  const tol = Math.max(0.12, 0.25 * Math.sqrt(Math.min(p.a, q.a)));
  if (d > tol) return false;
  const dot = p.n[0] * q.n[0] + p.n[1] * q.n[1] + p.n[2] * q.n[2];
  if (dot > -0.5) return false;            // Normalen müssen ~antiparallel sein
  return Math.min(p.a, q.a) / Math.max(p.a, q.a) >= 0.35;  // Flächen ähnlich gross
}
function endFaceGroups(result: DetectionResult): string[][] {
  const guids: string[] = [];
  for (const w of (result.wall_metrics || [])) {
    const g = (w as { element_guid?: string }).element_guid;
    if (g && !w.prep_failed && !w.error) guids.push(g);
  }
  const ef = new Map<string, _EF[]>();
  for (const g of guids) {
    const faces: _EF[] = [];
    for (const k of ["K0", "K1"]) {
      const s = faceStats(result, new Set([g]), k);
      if (s && s.a > 1e-6) faces.push({ c: s.c, n: s.n, a: s.a });
    }
    ef.set(g, faces);
  }
  const parent = new Map<string, string>();
  guids.forEach((g) => parent.set(g, g));
  const find = (x: string): string => {
    let r = x; while (parent.get(r) !== r) r = parent.get(r)!;
    while (x !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; } return r;
  };
  for (let i = 0; i < guids.length; i++) {
    for (let j = i + 1; j < guids.length; j++) {
      if (find(guids[i]) === find(guids[j])) continue;
      const fa = ef.get(guids[i])!, fb = ef.get(guids[j])!;
      let hit = false;
      for (const p of fa) { for (const q of fb) { if (_coincident(p, q)) { hit = true; break; } } if (hit) break; }
      if (hit) parent.set(find(guids[i]), find(guids[j]));
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const g of guids) {
    const r = find(g);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(g);
  }
  return Array.from(byRoot.values());
}

// Wie stark ein Wert die Soll-Schwelle verletzt (für die Repräsentanten-Wahl).
function _violation(num: number, soll: string): number {
  if (!isFinite(num)) return 0;
  const m = (soll || "").match(/(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const op = m[1] || ">="; const thr = parseFloat(m[2]);
  if (!isFinite(thr)) return 0;
  if (op.indexOf(">") >= 0) return Math.max(0, thr - num);  // unter Mindestwert
  if (op.indexOf("<") >= 0) return Math.max(0, num - thr);  // über Maximalwert
  return Math.abs(num - thr);
}

type _WmTyped = {
  wall_axes?: { long: [number, number, number]; height: [number, number, number]; thickness: [number, number, number] };
  centroid?: [number, number, number];
  element_guid?: string;
};

// Gruppierte Befunde für den geführten Modus: ein Eintrag pro
// (Stützmauer × Regel × Status), mit Anzahl betroffener Elemente, Mitglieder-
// Liste (Name/GUID/Wert) und repräsentativem (am stärksten verletzendem)
// Element für Kamera/Schnitt/Maßlinie.
export function deriveGroupedIssues(result: DetectionResult): Issue[] {
  const wms = result.wall_metrics || [];
  const sceneOffset = sceneOffsetOf(result);
  const idxOf = new Map<string, number>();
  wms.forEach((w, i) => { const g = (w as { element_guid?: string }).element_guid; if (g) idxOf.set(g, i); });
  const out: Issue[] = [];
  endFaceGroups(result).forEach((groupGuids, gi) => {
    type Mem = { wi: number; name: string; guid: string; num: number; valStr: string };
    type Bucket = { ruleId: string; label: string; status: Issue["status"]; soll: string; members: Mem[] };
    const buckets = new Map<string, Bucket>();
    for (const g of groupGuids) {
      const wi = idxOf.get(g); if (wi === undefined) continue;
      const wm = wms[wi];
      for (const ch of (wm.pruefung || [])) {
        const st = germanStatus(ch.status);
        const key = `${ch.id}__${st}`;
        let b = buckets.get(key);
        if (!b) { b = { ruleId: ch.id, label: ch.label, status: st, soll: ch.soll, members: [] }; buckets.set(key, b); }
        b.members.push({ wi, name: wm.element_name || "?", guid: g, num: Number(ch.value), valStr: fmtRuleValue(ch.id, ch.value, ch.einheit) });
      }
    }
    const firstIdx = idxOf.get(groupGuids[0]);
    const groupName = (firstIdx !== undefined ? wms[firstIdx].element_name : "") || t("issues.wallGroup", { n: gi + 1 });
    buckets.forEach((b) => {
      let rep = b.members[0]; let worst = -Infinity;
      for (const m of b.members) { const v = _violation(m.num, b.soll); if (v > worst) { worst = v; rep = m; } }
      const repWm = wms[rep.wi] as _WmTyped;
      const repCh = (wms[rep.wi].pruefung || []).find((c) => c.id === b.ruleId && germanStatus(c.status) === b.status);
      const { view, highlight } = pickView(b.ruleId, result, repWm);
      const annotation = repCh ? buildAnnotation(b.ruleId, repCh, result, repWm) : undefined;
      const section = buildSection(b.ruleId, result, repWm);
      const bcfViewpoint = buildBcfViewpoint(view, view.fovDeg ?? 45, section, repWm.element_guid, annotation, sceneOffset);
      out.push({
        id: `g${gi}_r${b.ruleId}_${b.status}`,
        wallIndex: rep.wi,
        ruleId: b.ruleId,
        label: b.label,
        status: b.status,
        istValue: rep.valStr,
        sollValue: fmtRuleSoll(b.ruleId, b.soll),
        shortDescription: b.members.length > 1
          ? t("issues.groupCount", { n: b.members.length })
          : (repCh ? shortDescription(repCh) : ""),
        view, highlight, annotation, section, bcfViewpoint,
        count: b.members.length,
        members: b.members.map((m) => ({ name: m.name, guid: m.guid, value: m.valStr })),
        memberGuids: b.members.map((m) => m.guid),
        groupName,
      });
    });
  });
  out.sort((a, b) => {
    const d = SEV_RANK[a.status] - SEV_RANK[b.status];
    if (d !== 0) return d;
    return (a.groupName || "").localeCompare(b.groupName || "") || a.ruleId.localeCompare(b.ruleId);
  });
  return out;
}
