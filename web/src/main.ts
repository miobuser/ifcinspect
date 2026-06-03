// App entry point. Mounts the UI shell, lazily bootstraps the
// Pyodide worker on first IFC upload, and wires the round-trip.
// IFC bytes NEVER leave the browser -- verify in DevTools Network:
// zero bytes of user data uploaded, no external requests during
// detection (after the initial Pyodide + wheel downloads).

import { mountShell } from "./shell";
import { mountWizard } from "./wizard";
import type { WorkerRequest, WorkerResponse, DetectionResult } from "./types";
import { dlog } from "./debug";
import { BUILTIN_RULESETS, DEMO_CURVED_RULESET, yamlToBytes, type Ruleset } from "./rulesets";
import { initTheme, toggleTheme, onThemeChange, getTheme, type Theme } from "./theme";
import { initLang, getLang, onLangChange, t } from "./i18n";
import "./style.css";

// Resolve + apply the active theme BEFORE the UI mounts so the first paint is
// already correct (no dark→light flash). Stored override wins; else OS pref.
initTheme();
// Resolve the active language BEFORE mount (like initTheme) so the first paint
// of the templates' applyStaticTranslations() uses the right language.
initLang();

// Active ruleset for the next detect() call. Default = bundled ASTRA FHB.
// "Eigenes Regelset" replaces this with the user-edited YAML; "Default"
// resets it back. Cached alongside lastResult so mode-switch doesn't reset.
let activeRuleset: Ruleset = BUILTIN_RULESETS.astra_default;
function setActiveRuleset(rs: Ruleset) {
  activeRuleset = rs;
}
function getActiveRuleset(): Ruleset {
  return activeRuleset;
}

const appHost = document.getElementById("app")!;
// Add the wizard host next to #app -- toggled via body[data-mode].
const wizHost = document.createElement("div");
wizHost.id = "wizard";
appHost.parentElement!.appendChild(wizHost);

const shell = mountShell(appHost);
// Find the actual <canvas> wrapper (the renderer's domElement was appended
// into #viewer at init time). For step 3 we move ONLY the canvas, not the
// whole #viewer (which would also yank the status bar). Identify by tag.
const viewerCanvas = shell.viewerHost.querySelector("canvas") as HTMLElement;
const wizard = mountWizard(wizHost, shell.viewer, viewerCanvas);

// ---- Theme: recolour the 3D viewer + sync both header toggle glyphs ------
function applyThemeToViewer(t: Theme): void {
  shell.viewer.setViewerBackground(t === "light" ? 0xeef0f3 : 0x1a1a1a);
}
function syncToggleGlyphs(t: Theme): void {
  // Dark mode shows ☼ (click → go light); light mode shows ☾ (click → go dark).
  const glyph = t === "light" ? "☾" : "☼";
  for (const id of ["theme_toggle", "wiz_theme_toggle"]) {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = glyph;
  }
}
// Both toggle buttons exist now (mountShell + mountWizard ran). Wire clicks.
for (const id of ["theme_toggle", "wiz_theme_toggle"]) {
  document.getElementById(id)?.addEventListener("click", () => { toggleTheme(); });
}
// React to every theme change (toggle click OR live OS change with no override).
onThemeChange((th) => {
  applyThemeToViewer(th);
  syncToggleGlyphs(th);
});

// ---- Language: wire + keep both header selects in sync -------------------
// shell renders #lang_select, wizard renders #wiz_lang_select. Each select
// wires its own change → setLang and its own onLangChange → re-sync inside the
// owning module; here we additionally cross-sync so switching in one header
// reflects in the other immediately.
function syncLangSelects(l: ReturnType<typeof getLang>): void {
  for (const id of ["lang_select", "wiz_lang_select"]) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel && sel.value !== l) sel.value = l;
  }
}
onLangChange((l) => syncLangSelects(l));
syncLangSelects(getLang());
// First paint with the already-resolved theme.
applyThemeToViewer(getTheme());
syncToggleGlyphs(getTheme());

// Cross-mode result cache. Declared BEFORE setMode/setActiveRuleset because
// those functions reference these — module-top-level let is in TDZ until the
// declaration line is reached, and setMode is called immediately on load.
let lastResult: DetectionResult | null = null;
let lastFilename: string = "modell.ifc";
let lastIfcBytes: ArrayBuffer | null = null;

type Mode = "guided" | "free";
const STORAGE_KEY = "nd:mode";
function setMode(m: Mode) {
  document.body.dataset.mode = m;
  try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
  document.querySelectorAll<HTMLButtonElement>("[data-mode-btn]").forEach((b) => {
    b.classList.toggle("on", b.dataset.modeBtn === m);
  });
  // Defensive: when toggling modes after a result exists, make sure the
  // viewer canvas is sitting in the right host and the now-visible shell
  // is fully populated.
  if (m === "free") {
    wizard.detachViewer();
    // Guided mode may have dimmed the terrain for a finding view — restore it
    // so free mode shows the context layer at full opacity.
    shell.viewer.setContextDimmed(false);
    if (lastResult) shell.showResult(lastResult, lastFilename);
  } else {
    if (lastResult) {
      wizard.showResult(lastResult, lastFilename);
    }
    // wizard.showResult auto-jumps to step 3 in guided mode, which calls
    // attachViewer + setControlsEnabled(false) internally.
  }
}
const stored = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Migration: normalise legacy values "wizard"/"expert" to "guided"/"free".
    if (raw === "wizard") return "guided";
    if (raw === "expert") return "free";
    return raw as Mode | null;
  } catch { return null; }
})();
setMode(stored === "free" ? "free" : "guided");

shell.onModeChange((m) => setMode(m));
// Expose setMode so the rail / wiz-footer in-context buttons can switch
// without re-wiring through the shell's onModeChange.
(window as Window & { ndSetMode?: (m: Mode) => void }).ndSetMode = setMode;
// Expose the ruleset hooks so the shell-rendered "Regelset" section can
// drive them without circular imports.
(window as Window & {
  ndGetRuleset?: () => Ruleset;
  ndSetRuleset?: (rs: Ruleset) => void;
  ndRerunRuleset?: () => Promise<void>;
}).ndGetRuleset = getActiveRuleset;
(window as Window & {
  ndGetRuleset?: () => Ruleset;
  ndSetRuleset?: (rs: Ruleset) => void;
  ndRerunRuleset?: () => Promise<void>;
}).ndSetRuleset = setActiveRuleset;
(window as Window & {
  ndGetRuleset?: () => Ruleset;
  ndSetRuleset?: (rs: Ruleset) => void;
  ndRerunRuleset?: () => Promise<void>;
}).ndRerunRuleset = rerunWithRuleset;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (r: DetectionResult) => void;
    reject: (err: Error) => void;
  }
>();
// Separate pending map for the on-demand IFC export (resolves to a b64 string,
// not a DetectionResult) so the detect pending map stays strictly typed.
const pendingExport = new Map<
  number,
  {
    resolve: (b64: string) => void;
    reject: (err: Error) => void;
  }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "niche-pyodide",
  });
  worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
    const r = ev.data;
    if (r.kind === "progress") {
      shell.showProgress(r.progress);
      return;
    }
    if (r.kind === "ready") {
      shell.setStatusKey("status.pyodideReady", undefined, { pct: 1.0 });
      return;
    }
    if (r.kind === "distances") {
      // Background L7 pass finished — patch the live result + re-render so the
      // distance table and any distance-rule verdicts appear without blocking
      // the initial result. Ignored if the user already loaded another model.
      applyDeferredDistances(r.id, r.scene_distances, r.wall_metrics);
      return;
    }
    if (r.kind === "export-ifc") {
      const pe = pendingExport.get(r.id);
      pe?.resolve(r.b64);
      pendingExport.delete(r.id);
      return;
    }
    const p = pending.get(r.id);
    if (r.kind === "ok") {
      p?.resolve(r.result);
      pending.delete(r.id);
    } else if (r.kind === "error") {
      // The id may belong to a detect OR an export request — reject whichever
      // is registered.
      p?.reject(new Error(r.error));
      pending.delete(r.id);
      const pe = pendingExport.get(r.id);
      pe?.reject(new Error(r.error));
      pendingExport.delete(r.id);
    }
  });
  worker.addEventListener("error", (ev) => {
    shell.showError(t("status.workerError", { msg: ev.message }));
  });
  return worker;
}

function send(req: WorkerRequest, transfer: Transferable[] = []) {
  const w = ensureWorker();
  w.postMessage(req, transfer);
}

async function detect(file: File): Promise<DetectionResult> {
  // Reset both shells so the previous model doesn't bleed into the new run.
  lastResult = null;
  lastFilename = file.name;
  lastIfcBytes = null;
  shell.clearResult();
  wizard.clearResult();
  shell.setStatusKey("status.loadingFile", { name: file.name }, { loading: true, pct: 0 });
  const buf = await file.arrayBuffer();
  lastIfcBytes = buf.slice(0);   // keep a copy for ruleset-only re-runs
  return runDetectWithBytes(buf, file.name);
}

function runDetectWithBytes(
  buf: ArrayBuffer,
  filename: string,
): Promise<DetectionResult> {
  const rulesYaml = getActiveRuleset().yaml;
  return new Promise<DetectionResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req: WorkerRequest = {
      id,
      kind: "detect",
      ifc_bytes: buf,
      ifc_filename: filename,
      rules_bytes: yamlToBytes(rulesYaml),
      // Defer the expensive L7 distance pass so the classification result shows
      // ~6 s sooner; main.ts requests the distances in the background after the
      // result is on screen (requestDeferredDistances).
      defer_distances: true,
    };
    // Transfer the ArrayBuffer to the worker (zero-copy hand-off).
    send(req, [buf]);
  });
}

// Token of the detection whose deferred distances we are waiting for. Bumped on
// every new detection so a late background reply for an old model is dropped.
let deferToken = 0;

/** Ask the worker to compute the L7 distance table for the just-finished
 *  detection (no IFC re-parse). The reply lands in the message handler as
 *  {kind:"distances"} and is applied via applyDeferredDistances. */
function requestDeferredDistances(): void {
  const id = nextId++;
  deferToken = id;
  send({ id, kind: "distances" });
}

/** Patch the live result with the background-computed distance table + the
 *  re-evaluated wall metrics, then re-render both shells. */
function applyDeferredDistances(
  id: number,
  sceneDistances: import("./types").DistanceRecord[],
  wallMetrics: import("./types").WallMetrics[],
): void {
  if (id !== deferToken || !lastResult) return;   // stale reply / no model
  lastResult.scene = { ...(lastResult.scene || {}), distances: sceneDistances };
  if (Array.isArray(wallMetrics) && wallMetrics.length) {
    lastResult.wall_metrics = wallMetrics;
  }
  // Re-render both shells from the patched result (cheap; no recompute).
  shell.showResult(lastResult, lastFilename);
  wizard.showResult(lastResult, lastFilename);
}

/** Ask the worker to re-emit the IFC of the last detection with the chosen
 *  content (Pset / classified submeshes / Pruefung) and resolve to the b64
 *  string. Mirrors the detect/distances senders: allocate an id, register a
 *  pending entry, send the request. No IFC re-parse happens worker-side. */
export function requestExportIfc(options: {
  pset: boolean;
  submeshes: boolean;
  pruefung: boolean;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = nextId++;
    pendingExport.set(id, { resolve, reject });
    send({ id, kind: "export-ifc", options });
  });
}
// Expose to the shell-/wizard-rendered export sections without a circular
// import (main.ts already imports both modules), mirroring ndRerunRuleset.
(window as Window & {
  ndExportIfc?: (o: {
    pset: boolean;
    submeshes: boolean;
    pruefung: boolean;
  }) => Promise<string>;
}).ndExportIfc = requestExportIfc;

/** Re-run detection on the previously-loaded IFC bytes using the currently
 *  active ruleset. Used by the "Regelset · Anwenden" button so the user
 *  can swap rules without re-uploading the IFC. */
export async function rerunWithRuleset(): Promise<void> {
  if (!lastIfcBytes) {
    shell.showError(t("status.noModel"));
    return;
  }
  // We need a fresh ArrayBuffer because the previous one may have been
  // transferred to the worker; keep `lastIfcBytes` and slice every time.
  const buf = lastIfcBytes.slice(0);
  shell.setStatusKey("status.rerunRuleset", undefined, { loading: true, pct: 0.1 });
  try {
    const result = await runDetectWithBytes(buf, lastFilename);
    pushResult(result, lastFilename);
  } catch (err) {
    shell.showError(err instanceof Error ? err.message : String(err));
  }
}

// (Cross-mode result cache moved to the top of the file — needed by
//  setMode/setActiveRuleset which fire on module load.)

// Warm the worker on idle so the first detection doesn't pay the full
// cold-init cost. Non-blocking; the user can still drop a file before
// init finishes -- detect() awaits the same init promise.
(window as Window & { requestIdleCallback?: (cb: () => void) => void })
  .requestIdleCallback?.(() => {
    // Fire-and-forget warm-up: nothing awaits this, so we do NOT register a
    // pending entry (the worker replies {kind:"ready"}, handled as a global
    // status event; an init failure surfaces via the {kind:"error"} reply).
    send({ id: nextId++, kind: "init" });
  });

function pushResult(result: DetectionResult, filename: string) {
  lastResult = result;
  lastFilename = filename;
  // Debug-Handle: erlaubt die Inspektion der rohen wall_metrics in der Konsole,
  // z.B. window.ndResult.wall_metrics.map(w => w.dimensions?.height_local).
  (window as Window & { ndResult?: DetectionResult }).ndResult = result;
  // Always populate BOTH shells so a later mode-switch finds the data cached.
  shell.showResult(result, filename);
  wizard.showResult(result, filename);
  // If the worker deferred the L7 distance pass (scene.distances === null),
  // kick off the background computation now that the result is on screen. The
  // table + any distance-rule verdicts patch in when it returns.
  if (result.scene && result.scene.distances === null) {
    requestDeferredDistances();
  }
}

// Misst die ECHTE Gesamtzeit von Datei-Auswahl bis Modell-Anzeige und meldet
// sie als Statuszeile + Konsole. Umschliesst detect()+pushResult() einmal, damit
// shell- und wizard-Pfad dieselbe Messung teilen.
async function detectAndShow(file: File): Promise<void> {
  const t0 = performance.now();
  const result = await detect(file);
  pushResult(result, file.name);
  const secs = (performance.now() - t0) / 1000;
  dlog(`[timing] Gesamt (Datei → Anzeige): ${secs.toFixed(2)} s`);
  // Finale Statuszeile MIT Gesamtzeit (überschreibt die Fertig-Meldung aus
  // showResult, die kein {secs} kennt). Alle drei Parameter setzen, sonst
  // bliebe ein "{count}"-Platzhalter im Text stehen.
  shell.setStatusKey(
    "status.done",
    { secs: secs.toFixed(1), count: result.cavity_count, wall: result.wall_name },
    { pct: 1.0 },
  );
}

shell.onFile(async (file) => {
  try {
    await detectAndShow(file);
  } catch (err) {
    shell.showError(err instanceof Error ? err.message : String(err));
    wizard.showError(err instanceof Error ? err.message : String(err));
  }
});

wizard.onFile(async (file) => {
  wizard.setStep(2);
  try {
    await detectAndShow(file);
  } catch (err) {
    shell.showError(err instanceof Error ? err.message : String(err));
    wizard.showError(err instanceof Error ? err.message : String(err));
  }
});

// Route progress updates into both shells (wizard cares about step 2).
const origShowProgress = shell.showProgress;
shell.showProgress = (p) => {
  origShowProgress(p);
  // Translate keyed worker progress (German fallback in p.message).
  wizard.setProgress(p.i18nKey ? t(p.i18nKey, p.i18nParams) : p.message, p.pct);
};

// ---- Demo-Modell via URL-Parameter (?demo=...) ---------------------------
// Lets anyone open a shareable link that auto-loads a bundled example IFC, so
// the tool is usable on a PC WITHOUT an own IFC file. The file is fetched from
// our own origin (public/demo/) and handed to the SAME in-browser detect()
// pipeline as a manual upload — it is never uploaded anywhere, the privacy
// promise holds (only this static asset is fetched, exactly like the wheel).
const _DEMO_BOGEN = "demo/beispiel_bogenwand.ifc";
const _DEMO_BOGEN_NAME = "beispiel_bogenwand.ifc";
type DemoEntry = { path: string; filename: string; ruleset?: Ruleset };
const DEMO_MODELS: Record<string, DemoEntry> = {
  // aliases → bundled example IFC under public/demo/. Default showcase = the
  // curved inner wall (30 detected Schaleinlagen, full K0–K6 classification,
  // 4 ASTRA verdicts: 3×PASS + 1×WARN). Its `ruleset` is an ephemeral demo
  // ruleset activated ONLY via this link (not in the ruleset selector); see
  // loadDemoModel. The other examples use the active/default ruleset.
  bogenwand: { path: _DEMO_BOGEN, filename: _DEMO_BOGEN_NAME, ruleset: DEMO_CURVED_RULESET },
  curved: { path: _DEMO_BOGEN, filename: _DEMO_BOGEN_NAME, ruleset: DEMO_CURVED_RULESET },
  bogen: { path: _DEMO_BOGEN, filename: _DEMO_BOGEN_NAME, ruleset: DEMO_CURVED_RULESET },
  "1": { path: _DEMO_BOGEN, filename: _DEMO_BOGEN_NAME, ruleset: DEMO_CURVED_RULESET },
  nische: { path: "demo/beispiel_nische.ifc", filename: "beispiel_nische.ifc" },
  terrain: { path: "demo/beispiel_terrain_erdseite.ifc", filename: "beispiel_terrain_erdseite.ifc" },
  mehrere: { path: "demo/beispiel_mehrere_elemente.ifc", filename: "beispiel_mehrere_elemente.ifc" },
};

async function loadDemoModel(key: string): Promise<void> {
  const entry = DEMO_MODELS[key.toLowerCase()];
  if (!entry) {
    shell.showError(t("status.demoUnknown", { name: key }));
    return;
  }
  // Resolve relative to the deployed base so it works at any sub-path.
  const url = new URL(entry.path, document.baseURI).href;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], entry.filename, {
      type: "application/x-step",
    });
    // Demo-spezifisches Regelset: NUR über den Demo-Link aktivieren (es steht
    // nicht im Auswahldialog). Wird vor detect() gesetzt, damit der Demo-Lauf es
    // verwendet; der Header spiegelt den Namen ("demo=curved").
    if (entry.ruleset) {
      setActiveRuleset(entry.ruleset);
      document.querySelectorAll("#hdr_ruleset_name").forEach((el) => {
        (el as HTMLElement).textContent = entry.ruleset!.label;
      });
    }
    // Mirror wizard.onFile: in guided mode jump to the analysis step so the
    // user sees progress; detect() then drives the same round-trip as upload.
    if ((document.body.dataset.mode ?? "guided") === "guided") {
      wizard.setStep(2);
    }
    await detectAndShow(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    shell.showError(t("status.demoFailed", { name: entry.filename, msg }));
    wizard.showError(t("status.demoFailed", { name: entry.filename, msg }));
  }
}

(() => {
  try {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo) void loadDemoModel(demo);
  } catch { /* malformed URL — ignore, normal upload flow stays available */ }
})();
