// Dependency-free BCF 2.1 (.bcf) exporter for IfcInspect validation
// findings. Mode-independent: consumes deriveIssues(result) (the SAME issue
// list the guided BCF panel and the free-mode inspector both reflect), so the
// export is identical whether the user triggers it from the wizard or the
// shell.
//
// Two public entry points:
//   storeZip(files)         — minimal STORE-only ZIP writer (method=0, no
//                             compression) with correct CRC32 + Central
//                             Directory + End-of-Central-Directory so standard
//                             tools (unzip, python zipfile, BCF readers) open
//                             it without complaint.
//   buildBcfZip(result, …)  — assembles a BCF 2.1 tree (bcf.version + one GUID
//                             folder per finding with markup.bcf / viewpoint.bcfv
//                             / snapshot.png) and packs it via storeZip().
//
// No external ZIP / XML / UUID dependencies — only the platform `crypto` and a
// hand-rolled CRC32. package.json stays at `three` only.

import { deriveIssues, refineIssueAnnotation, type Issue, type BcfViewpoint } from "./issues";
import type { DetectionResult } from "./types";

// --------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected) — own table, no zlib.
// --------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --------------------------------------------------------------------------
// Minimal STORE-only ZIP writer.
//
// Layout per entry:
//   [Local File Header][filename][file data]
// Then the Central Directory (one record per entry) and the EOCD record.
// All numbers little-endian. method=0 (STORE), version 2.0, no data
// descriptors, no Zip64. UTF-8 filenames (general-purpose flag bit 11).
// --------------------------------------------------------------------------
export type ZipEntry = { name: string; bytes: Uint8Array };

const enc = new TextEncoder();

function pushU16(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

export function storeZip(files: ZipEntry[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  type Meta = { nameBytes: Uint8Array; crc: number; size: number; offset: number };
  const metas: Meta[] = [];

  // Fixed DOS time/date (1980-01-01 00:00:00) — deterministic output.
  const dosTime = 0;
  const dosDate = 0x0021; // (1980-1980)<<9 | 1<<5 | 1

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const offset = local.length;

    // ---- Local file header (signature 0x04034b50) ----
    pushU32(local, 0x04034b50);
    pushU16(local, 20);          // version needed to extract (2.0)
    pushU16(local, 0x0800);      // general purpose bit flag: bit 11 = UTF-8
    pushU16(local, 0);           // compression method = 0 (STORE)
    pushU16(local, dosTime);
    pushU16(local, dosDate);
    pushU32(local, crc);
    pushU32(local, data.length); // compressed size == uncompressed (STORE)
    pushU32(local, data.length); // uncompressed size
    pushU16(local, nameBytes.length);
    pushU16(local, 0);           // extra field length
    for (let i = 0; i < nameBytes.length; i++) local.push(nameBytes[i]);
    for (let i = 0; i < data.length; i++) local.push(data[i]);

    metas.push({ nameBytes, crc, size: data.length, offset });
  }

  // ---- Central directory (signature 0x02014b50 per record) ----
  for (const m of metas) {
    pushU32(central, 0x02014b50);
    pushU16(central, 20);        // version made by
    pushU16(central, 20);        // version needed
    pushU16(central, 0x0800);    // UTF-8 flag
    pushU16(central, 0);         // method = STORE
    pushU16(central, dosTime);
    pushU16(central, dosDate);
    pushU32(central, m.crc);
    pushU32(central, m.size);    // compressed
    pushU32(central, m.size);    // uncompressed
    pushU16(central, m.nameBytes.length);
    pushU16(central, 0);         // extra length
    pushU16(central, 0);         // comment length
    pushU16(central, 0);         // disk number start
    pushU16(central, 0);         // internal attrs
    pushU32(central, 0);         // external attrs
    pushU32(central, m.offset);  // relative offset of local header
    for (let i = 0; i < m.nameBytes.length; i++) central.push(m.nameBytes[i]);
  }

  const centralOffset = local.length;
  const centralSize = central.length;

  // ---- End of central directory (signature 0x06054b50) ----
  const eocd: number[] = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0);                 // number of this disk
  pushU16(eocd, 0);                 // disk with central dir start
  pushU16(eocd, metas.length);      // entries on this disk
  pushU16(eocd, metas.length);      // total entries
  pushU32(eocd, centralSize);
  pushU32(eocd, centralOffset);
  pushU16(eocd, 0);                 // comment length

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

// --------------------------------------------------------------------------
// XML helpers
// --------------------------------------------------------------------------
function xmlEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string),
  );
}

// BCF/IfcGuid-ish shape check: 22-char base64 GUID OR a standard UUID. The
// IfcInspect Issue.id is `w0_r1_<rule>` (not GUID-shaped) so this normally
// returns false and we mint a fresh UUID instead.
function isGuidShaped(s: string | undefined): boolean {
  if (!s) return false;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) return true;
  if (/^[0-9A-Za-z_$]{22}$/.test(s)) return true;
  return false;
}

function newGuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback RFC4122 v4 from getRandomValues (or Math.random as last resort).
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function guidForIssue(issue: Issue): string {
  return isGuidShaped(issue.id) ? issue.id : newGuid();
}

// BCF TopicStatus mapping. FAIL/WARN → "Open" (open defect); PASS/INFO →
// "Closed" (documented as checked & passed / informative, not an open defect);
// INFO and SKIP topics are excluded from the export entirely (see filter below).
function mapStatus(status: Issue["status"]): string {
  switch (status) {
    case "PASS":
    case "INFO": return "Closed";
    case "FAIL":
    case "WARN":
    default: return "Open";
  }
}

// --------------------------------------------------------------------------
// XML builders
// --------------------------------------------------------------------------
function v3(v: [number, number, number]): string {
  return `<X>${v[0]}</X><Y>${v[1]}</Y><Z>${v[2]}</Z>`;
}

function buildMarkup(
  guid: string,
  issue: Issue,
  hasViewpoint: boolean,
  hasSnapshot: boolean,
  nowIso: string,
  viewpointGuid: string,
): string {
  // "Bemaßung" tags the Ist-value explicitly: it is the measured dimension
  // drawn as a BCF redline <Line> in the viewpoint, mirrored here in plain text.
  const istSoll = `Bemaßung (Ist): ${issue.istValue} / Soll: ${issue.sollValue}`;
  const commentGuid = newGuid();

  // Titel/Beschreibung anreichern, damit Bauteil + Masse direkt im BimCollab-Panel
  // sichtbar sind (nicht nur im Comment): Titel "Stuetzmauer — Regel", Beschreibung
  // mit Ist/Soll, Anzahl betroffener Elemente und der Bauteil-GUID.
  const repGuid = issue.bcfViewpoint?.components?.selection?.[0]
    || (issue.memberGuids && issue.memberGuids[0]) || "";
  const title = (issue.groupName ? issue.groupName + " — " : "") + issue.label;
  // Beschreibung schlank: KEINE Bemaßung (steht als Text im 3D-Snapshot) und
  // KEINE Bauteil-GUID (auf Wunsch entfernt). Nur Kurzbeschreibung + Anzahl.
  const descLines = [issue.shortDescription];
  if (issue.count && issue.count > 1) descLines.push(`Betrifft ${issue.count} Element(e) dieser Stützmauer`);
  const description = descLines.join("\n");

  // BCF 2.1: a markup references a viewpoint via a <Viewpoints Guid="..."> element
  // (schema type ViewPoint) whose DIRECT children are <Viewpoint> (the .bcfv
  // filename) and <Snapshot> (the .png). It is NOT a <Viewpoints> wrapper around a
  // nested <ViewPoint> node — strict readers (BimCollab) silently ignore the latter,
  // so camera + snapshot disappear. The Guid must match the VisualizationInfo Guid.
  const viewpointsXml = hasViewpoint
    ? `
  <Viewpoints Guid="${xmlEscape(viewpointGuid)}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>${hasSnapshot ? `
    <Snapshot>snapshot.png</Snapshot>` : ""}
  </Viewpoints>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${xmlEscape(guid)}" TopicType="Inspection" TopicStatus="${mapStatus(issue.status)}">
    <Title>${xmlEscape(title)}</Title>
    <CreationDate>${xmlEscape(nowIso)}</CreationDate>
    <CreationAuthor>IfcInspect</CreationAuthor>
    <Description>${xmlEscape(description)}</Description>
    <Labels>${xmlEscape(issue.ruleId)}</Labels>
  </Topic>
  <Comment Guid="${xmlEscape(commentGuid)}">
    <Date>${xmlEscape(nowIso)}</Date>
    <Author>IfcInspect</Author>
    <Comment>${xmlEscape(istSoll)}</Comment>${hasViewpoint ? `
    <Viewpoint Guid="${xmlEscape(viewpointGuid)}" />` : ""}
  </Comment>${viewpointsXml}
</Markup>
`;
}

function buildViewpoint(vp: BcfViewpoint, guid: string): string {
  const cam = vp.perspectiveCamera;
  const clip = (vp.clippingPlanes || [])
    .map((p) => `      <ClippingPlane>
        <Location>${v3(p.location)}</Location>
        <Direction>${v3(p.direction)}</Direction>
      </ClippingPlane>`)
    .join("\n");
  const clippingXml = (vp.clippingPlanes && vp.clippingPlanes.length)
    ? `
  <ClippingPlanes>
${clip}
  </ClippingPlanes>`
    : "";

  // BCF 2.1 redline <Lines> — the measured dimension span (Bemaßung), so the
  // Ist-value shows as a redline in any BCF viewer (BimCollab/Solibri), not
  // only in our 3D Befund view. Coords are IFC-space (Z-up), same frame as the
  // camera/clipping above.
  const linesInner = (vp.lines || [])
    .map((l) => `    <Line>
      <StartPoint>${v3(l.start)}</StartPoint>
      <EndPoint>${v3(l.end)}</EndPoint>
    </Line>`)
    .join("\n");
  const linesXml = linesInner
    ? `
  <Lines>
${linesInner}
  </Lines>`
    : "";

  let componentsXml = "";
  if (vp.components) {
    const sel = (vp.components.selection || [])
      .map((g) => `      <Component IfcGuid="${xmlEscape(g)}" />`)
      .join("\n");
    const exc = (vp.components.visibility.exceptions || [])
      .map((g) => `        <Component IfcGuid="${xmlEscape(g)}" />`)
      .join("\n");
    componentsXml = `
  <Components>
    <Selection>${sel ? "\n" + sel + "\n    " : ""}</Selection>
    <Visibility DefaultVisibility="${vp.components.visibility.defaultVisibility ? "true" : "false"}">
      <Exceptions>${exc ? "\n" + exc + "\n      " : ""}</Exceptions>
    </Visibility>
  </Components>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${xmlEscape(guid)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${componentsXml}
  <PerspectiveCamera>
    <CameraViewPoint>${v3(cam.cameraViewPoint)}</CameraViewPoint>
    <CameraDirection>${v3(cam.cameraDirection)}</CameraDirection>
    <CameraUpVector>${v3(cam.cameraUpVector)}</CameraUpVector>
    <FieldOfView>${cam.fieldOfView}</FieldOfView>
  </PerspectiveCamera>${linesXml}${clippingXml}
</VisualizationInfo>
`;
}

function buildVersion(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <DetailedVersion>2.1</DetailedVersion>
</Version>
`;
}

function buildProject(projectGuid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ProjectExtension xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Project ProjectId="${xmlEscape(projectGuid)}">
    <Name>${xmlEscape(name)}</Name>
  </Project>
  <ExtensionSchema></ExtensionSchema>
</ProjectExtension>
`;
}

// --------------------------------------------------------------------------
// buildBcfZip — main assembly
// --------------------------------------------------------------------------
export type BcfOptions = {
  // Include PASS topics (TopicStatus="Closed") so "checked & passed" rules are
  // documented. Default OFF — only FAIL/WARN findings are exported.
  includePass?: boolean;
  // Optional snapshot provider. Return a PNG Uint8Array for the issue, or null
  // to omit snapshot.png for that topic.
  snapshot?: (issue: Issue) => Uint8Array | null;
};

// Decode a `data:image/png;base64,…` URL to raw PNG bytes. Returns null for a
// non-PNG / malformed dataURL.
export function dataUrlToPngBytes(dataUrl: string | null): Uint8Array | null {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Build an `opts.snapshot` provider backed by a Viewer3D-like capturer. The
// capturer applies the issue's viewpoint (camera + class highlight + section)
// synchronously and returns a PNG dataURL. Returns null per-issue when capture
// is unavailable (no viewpoint, tainted canvas, context loss) so the topic is
// emitted without a snapshot rather than failing the whole export.
export type SnapshotCapturer = (opts: {
  view: Issue["view"];
  classKey?: string | null;
  section?: Issue["section"];
  width?: number;
  height?: number;
  light?: boolean;
  keepGuids?: string[] | null;
  highlightClass?: string | null;
  annotation?: object | null;
  toolLook?: boolean;
}) => string | null;

// THREE-Annotationsgruppe entsorgen, ohne THREE zu importieren (dep-frei).
function disposeAnno(o: unknown): void {
  const g = o as { traverse?: (cb: (c: unknown) => void) => void } | null;
  g?.traverse?.((c: unknown) => {
    const m = c as { geometry?: { dispose?: () => void }; material?: unknown };
    m.geometry?.dispose?.();
    const mat = m.material as { dispose?: () => void; map?: { dispose?: () => void } }
      | Array<{ dispose?: () => void; map?: { dispose?: () => void } }> | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => { x?.map?.dispose?.(); x?.dispose?.(); });
    else if (mat) { mat.map?.dispose?.(); mat.dispose?.(); }
  });
}

export function makeViewerSnapshotProvider(
  capture: SnapshotCapturer,
  size: { width?: number; height?: number } = {},
  annoBuilder?: (issue: Issue) => object | null,
): (issue: Issue) => Uint8Array | null {
  return (issue: Issue) => {
    if (!issue.bcfViewpoint) return null;
    // Exakt die geführte HELL-Ansicht (toolLook = heller Hintergrund, Kontext
    // gedimmt, betroffenes Bauteil finding-isoliert). Selektion = [repGuid];
    // Fallback memberGuids. Bemaßung als TEXT in den Snapshot einbacken (steht
    // dann im Bild, nicht in der Description).
    const sel = issue.bcfViewpoint.components?.selection ?? [];
    const keepGuids = sel.length ? sel : (issue.memberGuids ?? []);
    const hlAny = issue.highlight as { kind?: string; classKey?: string } | undefined;
    const hl = hlAny?.kind === "class" ? (hlAny.classKey ?? null) : null;
    const anno = annoBuilder ? annoBuilder(issue) : null;
    const dataUrl = capture({
      view: issue.view,
      section: issue.section ?? null,
      toolLook: true,
      keepGuids,
      highlightClass: hl,
      // Nur crown_min_width auf K2 isolieren (captureIssueSnapshot liest classKey);
      // übrige Regeln zeigen weiterhin alle Klassen des Bauteils.
      classKey: issue.ruleId === "crown_min_width" ? hl : null,
      annotation: anno,
      width: size.width,
      height: size.height,
    });
    disposeAnno(anno);
    return dataUrlToPngBytes(dataUrl);
  };
}

export function buildBcfZip(
  result: DetectionResult,
  filename: string,
  opts: BcfOptions = {},
): Uint8Array {
  const issues = deriveIssues(result);
  // Maß-Endpunkte exakt auf die Schnittebene legen (Redline im BCF-Viewpoint).
  for (const it of issues) refineIssueAnnotation(it, result);
  const selected = issues.filter((it) => {
    if (it.status === "FAIL" || it.status === "WARN") return true;
    if (it.status === "PASS") return opts.includePass === true;
    return false; // INFO / SKIP never exported (informative / not evaluated)
  });

  const nowIso = new Date().toISOString();
  const files: ZipEntry[] = [];

  files.push({ name: "bcf.version", bytes: enc.encode(buildVersion()) });

  const projectGuid = newGuid();
  const projectName = (filename || "Modell").replace(/\.ifc$/i, "") || "Modell";
  files.push({ name: "project.bcfp", bytes: enc.encode(buildProject(projectGuid, projectName)) });

  for (const issue of selected) {
    // EINEN fehlerhaften Befund überspringen statt den GANZEN Export zu sprengen:
    // markup/viewpoint/snapshot pro Topic kapseln, damit ein einzelnes kaputtes
    // Issue nicht die komplette .bcf-Datei unbrauchbar macht.
    try {
      const guid = guidForIssue(issue);
      const folder = `${guid}/`;
      const vp = issue.bcfViewpoint;
      const hasViewpoint = !!vp;
      const viewpointGuid = newGuid();   // shared by markup ref + VisualizationInfo

      // Snapshot only when both a viewpoint AND a PNG are available.
      let png: Uint8Array | null = null;
      if (hasViewpoint && opts.snapshot) {
        try { png = opts.snapshot(issue); } catch { png = null; }
      }
      const hasSnapshot = !!png;

      files.push({
        name: `${folder}markup.bcf`,
        bytes: enc.encode(buildMarkup(guid, issue, hasViewpoint, hasSnapshot, nowIso, viewpointGuid)),
      });
      if (vp) {
        files.push({
          name: `${folder}viewpoint.bcfv`,
          bytes: enc.encode(buildViewpoint(vp, viewpointGuid)),
        });
      }
      if (png) {
        files.push({ name: `${folder}snapshot.png`, bytes: png });
      }
    } catch (e) {
      if (typeof console !== "undefined") {
        console.warn(`[bcf] Befund übersprungen (${issue.ruleId}):`, e);
      }
    }
  }

  return storeZip(files);
}
