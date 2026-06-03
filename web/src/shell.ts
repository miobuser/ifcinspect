// UI shell -- ported from web_viewer.py `_HTML` literal (the
// Layout-B accordion shell). Mounts into #app and wires the
// file-input, the inspector accordions, and the rail toggles.
//
// PORTING SCOPE (Phase 1): the initial round-trip UI -- header
// upload, viewport host, inspector with Ergebnis + Kenngrössen
// + Klassifikation sections, status bar. Full Layout-B (5
// inspector sections, view-mode tabs, advanced sliders, shortcut
// help modal) can be folded in once the Pyodide round-trip is
// verified.

import { initViewer3d, type Viewer3D } from "./viewer3d/viewer";
import type {
  DetectionResult, WorkerProgress, WallMetrics, RuleCheck,
  ConfidenceEntry, DistanceRecord,
} from "./types";
import {
  BUILTIN_RULESETS, quickValidateYaml, previewRules, type Ruleset,
  TARGET_CATALOG, TARGET_LEVEL_LABEL, catalogEntryFor, OP_LABEL,
  defaultLabelFor, buildRuleYamlBlock, appendRuleToYaml, removeRuleByIndex,
  type RuleOp, type RuleSeverity, type BuilderRule, type RulePreview,
  loadSavedRulesets, createSavedRuleset, updateSavedRuleset, deleteSavedRuleset,
  getSavedRuleset, getActiveRulesetId, setActiveRulesetId,
} from "./rulesets";
import { buildBcfZip, makeViewerSnapshotProvider } from "./bcf";
import { exportPdfReport } from "./report-pdf";
import { showBusy, hideBusy, nextFrame } from "./progress";
import { deriveIssues, refineIssueAnnotation, fmtRuleValue, fmtRuleSoll, type Issue } from "./issues";
import { buildDimensionAnnotation } from "./annotation";
import { t, applyStaticTranslations, onLangChange, SUPPORTED, getLang, setLang, statusLabel } from "./i18n";

export type ShellHandle = {
  viewer: Viewer3D;
  viewerHost: HTMLElement;
  setStatus: (
    msg: string,
    opts?: { error?: boolean; loading?: boolean; pct?: number },
  ) => void;
  // i18n-aware status: remembers the key+params so the line re-translates
  // live on a language switch. Use this from main.ts instead of setStatus.
  setStatusKey: (
    key: string,
    params?: Record<string, string | number>,
    opts?: { error?: boolean; loading?: boolean; pct?: number },
  ) => void;
  showResult: (result: DetectionResult, filename?: string) => void;
  showProgress: (p: WorkerProgress) => void;
  showError: (msg: string) => void;
  onFile: (cb: (file: File) => void) => void;
  onModeChange: (cb: (mode: "guided" | "free") => void) => void;
  clearResult: () => void;
};

// Controller for the right-click appearance popover, shared between the rail
// toggles (wired at mount) and the per-class swatch toggles (wired per render).
type LayerStylePopover = {
  open: (key: string, x: number, y: number) => void;
  applyStored: () => void;
};
let shellLayerStyle: LayerStylePopover | null = null;

const HTML = `
  <div id="hdr">
    <div class="hdr-brand">
      <h1>IfcInspect</h1>
      <span class="sub" data-i18n="hdr.subtitle">IFC-Geometrie-Validierung</span>
    </div>
    <div class="spacer"></div>
    <span class="badge privacy has-tip" tabindex="0" data-i18n="hdr.privacy" data-i18n-title="hdr.privacyTip" data-tip="Läuft vollständig in Ihrem Browser via WebAssembly (Pyodide + IfcOpenShell). Ihre IFC-Datei wird nicht hochgeladen, nicht auf einem Server verarbeitet und verlässt Ihr Gerät nie — kein Upload, keine Cloud, kein Tracking." title="Läuft vollständig in Ihrem Browser via WebAssembly (Pyodide + IfcOpenShell). Ihre IFC-Datei wird nicht hochgeladen, nicht auf einem Server verarbeitet und verlässt Ihr Gerät nie — kein Upload, keine Cloud, kein Tracking.">
      Client-Side · 100 % im Browser
    </span>
    <div class="spacer"></div>
    <select class="lang-select" id="lang_select" title="Sprache wählen" aria-label="Sprache wählen"></select>
    <button class="theme-toggle" id="theme_toggle" type="button" data-i18n-title="hdr.themeTip" title="Hell/Dunkel umschalten" aria-label="Hell/Dunkel umschalten">☼</button>
    <button class="btn-secondary" id="open_rulesets" data-i18n-title="hdr.rulesetTip" title="Regelsets verwalten und bearbeiten">
      <span data-i18n="hdr.rulesetBtn">⚙ Regelset: </span><span id="hdr_ruleset_name" class="hdr-rs-name">…</span>
    </button>
    <label class="btn-primary" for="file" data-i18n="hdr.loadIfc" data-i18n-title="hdr.loadIfcTip" title="IFC-Datei laden">
      IFC laden
    </label>
    <input id="file" type="file" accept=".ifc,.IFC" hidden />
  </div>

  <div id="rail">
    <button type="button" class="m-close" id="m_close_rail" data-i18n-title="mobile.close" title="Schließen" aria-label="Schließen">✕</button>
    <!-- „Modell" (Wand-Volumen) standardmässig AN — deckungsgleich mit
         layers.wall.visible = true im Viewer (FrontSide-Transparenz). -->
    <button class="tool on" id="bwall" data-i18n="rail.model">Modell</button>
    <button class="tool on" id="bvol" data-i18n="rail.classFaces">Klassifikationsflächen</button>
    <button class="tool on" id="bterrain" data-i18n="rail.terrain">Terrain</button>
    <button class="tool" id="bfit" data-i18n="rail.fit" data-i18n-title="rail.fitTip" title="Ansicht einpassen (F)">Fit (F)</button>
    <div class="rail-sep"></div>
    <button class="tool" id="sp_section" data-i18n="rail.section" data-i18n-title="rail.sectionTip" title="Schnittebene setzen">Schnitt</button>
    <div class="rail-spacer"></div>
    <button class="tool mode-switch" data-mode-btn="guided" data-i18n="rail.toGuided" data-i18n-title="rail.toGuidedTip" title="Zum geführten Modus wechseln">← Zum geführten Modus</button>
  </div>

  <div id="viewer">
    <div id="status">
      <span id="spin"></span>
      <span id="msg" data-i18n="status.ready">Bereit — IFC laden, um zu starten.</span>
      <div id="progress"><div class="bar"></div></div>
    </div>
  </div>

  <div id="inspector">
    <button type="button" class="m-close" id="m_close_inspector" data-i18n-title="mobile.close" title="Schließen" aria-label="Schließen">✕</button>
    <details class="sec" id="sec_result" open>
      <summary><span data-i18n="inspector.result">Ergebnis</span><span class="count" id="result_count"></span></summary>
      <div class="secbody">
        <div id="result_body">
          <div class="empty" data-i18n-html="inspector.resultEmpty">Noch kein Ergebnis.<br />IFC laden, um zu starten.</div>
        </div>
      </div>
    </details>

    <details class="sec" id="sec_walls">
      <summary><span data-i18n="inspector.walls">Wand-Liste</span><span class="count" id="walls_count"></span></summary>
      <div class="secbody">
        <div id="walllist"><div class="empty" data-i18n="inspector.wallsEmpty">Keine Wände.</div></div>
      </div>
    </details>

    <details class="sec" id="sec_inspect" open>
      <summary><span data-i18n="inspector.inspect">Element-Inspektor</span><span class="count" id="inspect_count"></span></summary>
      <div class="secbody">
        <div id="inspect_panel"><div class="empty" data-i18n="inspector.inspectEmpty">Kein Modell geladen.</div></div>
      </div>
    </details>


    <details class="sec" id="sec_cls" open>
      <summary><span data-i18n="inspector.cls">Klassifikation</span><span class="count" id="cls_count"></span></summary>
      <div class="secbody">
        <div id="cls">
          <div class="empty" data-i18n="inspector.clsEmpty">Noch keine Klassifikation.</div>
        </div>
      </div>
    </details>

    <!-- Regelset-Editor: eigenes Modal-Fenster, geöffnet über den Header-Button
         „⚙ Regelset". Liegt bewusst position:fixed über allem; die inneren IDs
         sind unverändert, damit wireRulesetSection() weiter greift. -->
    <div id="ruleset_modal" class="modal-overlay" data-rules-editor hidden>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ruleset_modal_title">
        <div class="modal-head">
          <h2 id="ruleset_modal_title"><span data-i18n="rules.modalTitle">Regelsets</span><span class="count" id="ruleset_count"></span></h2>
          <button type="button" class="modal-close" id="close_rulesets" data-i18n-title="rules.close" title="Schliessen (Esc)" aria-label="Schliessen">✕</button>
        </div>
        <div class="modal-body">
        <div id="ruleset_body">

          <!-- (1) Ruleset-Verwaltung: aktives Set wählen + verwalten -->
          <div class="rb-manage">
            <label class="rb-field">
              <span data-i18n="rules.activeRuleset">Aktives Regelset</span>
              <select id="ruleset_select"></select>
            </label>
            <div class="rb-manage-actions">
              <button class="export-btn" id="rs_new" data-i18n="rules.new" data-i18n-title="rules.newTip" title="Leeres Regelset erstellen">+ Neu</button>
              <button class="export-btn" id="rs_dup" data-i18n="rules.dup" data-i18n-title="rules.dupTip" title="Aktives Regelset als neues, bearbeitbares Regelset duplizieren">Duplizieren</button>
              <button class="export-btn" id="rs_rename" data-i18n="rules.rename" data-i18n-title="rules.renameTip" title="Aktives (eigenes) Regelset umbenennen">Umbenennen</button>
              <button class="export-btn" id="rs_delete" data-i18n="rules.delete" data-i18n-title="rules.deleteTip" title="Aktives (eigenes) Regelset löschen">Löschen</button>
              <label class="export-btn" for="ruleset_file" data-i18n="rules.import" data-i18n-title="rules.importTip" title="YAML-Datei importieren" style="cursor:pointer">⇪ Import</label>
              <button class="export-btn" id="rs_export" data-i18n="rules.export" data-i18n-title="rules.exportTip" title="Aktives Regelset als YAML herunterladen">⇩ Export</button>
              <input id="ruleset_file" type="file" accept=".yaml,.yml" hidden />
            </div>
            <div id="rs_status" class="rb-status"></div>
          </div>

          <!-- (2) Formular-Builder: neue Regel ohne YAML -->
          <details class="rb-builder" id="rb_builder_wrap" open>
            <summary data-i18n="rules.addRule">Regel hinzufügen</summary>
            <div class="rb-form" id="rb_form">
              <label class="rb-field">
                <span data-i18n="rules.fieldTarget">Kenngrösse</span>
                <select id="rb_target"></select>
              </label>
              <div class="rb-field-row">
                <label class="rb-field rb-op">
                  <span data-i18n="rules.fieldOp">Operator</span>
                  <select id="rb_op"></select>
                </label>
                <label class="rb-field rb-thr">
                  <span data-i18n="rules.fieldThreshold">Schwellwert</span>
                  <span class="rb-thr-wrap">
                    <input id="rb_threshold" type="number" step="any" inputmode="decimal" />
                    <span class="rb-unit" id="rb_unit"></span>
                  </span>
                </label>
              </div>
              <label class="rb-field">
                <span data-i18n="rules.fieldTolerance">Toleranz ± (optional, nur bei „=")</span>
                <input id="rb_tolerance" type="number" step="any" min="0" inputmode="decimal" data-i18n-ph="rules.tolerancePh" placeholder="leer = exakt" />
                <small class="rb-hint" data-i18n="rules.toleranceHint">Nur bei Operator „=": symmetrisches Soll-Band [Schwellwert ± Toleranz], z. B. Kronengefälle 3 % ± 0.5.</small>
              </label>
              <label class="rb-field">
                <span data-i18n="rules.fieldSeverity">Severity</span>
                <select id="rb_severity">
                  <option value="fail" data-i18n="rules.sevFail">fail — Verletzung = FAIL</option>
                  <option value="warn" data-i18n="rules.sevWarn">warn — Verletzung = WARN</option>
                </select>
              </label>
              <label class="rb-field">
                <span data-i18n="rules.fieldMinConf">Mindest-Confidence (optional)</span>
                <input id="rb_minconf" type="number" step="0.05" min="0" max="1" inputmode="decimal" data-i18n-ph="rules.minConfPh" placeholder="leer = aus" />
                <small class="rb-hint" data-i18n="rules.minConfHint">0–1. Liegt die Confidence des geprüften Werts darunter, stuft das Backend das Ergebnis auf WARN herab (statt FAIL/PASS). Leer = keine Confidence-Prüfung.</small>
              </label>
              <label class="rb-field">
                <span data-i18n="rules.fieldLabel">Bezeichnung</span>
                <input id="rb_label" type="text" data-i18n-ph="rules.labelPh" placeholder="automatisch aus Kenngrösse…" />
              </label>
              <div class="rb-form-actions">
                <button class="rb-btn-primary" id="rb_apply" data-i18n="rules.applyRule">Regel übernehmen</button>
                <button class="export-btn" id="rb_cancel" data-i18n="rules.cancel" hidden>Abbrechen</button>
                <span id="rb_err" class="rb-err"></span>
              </div>
            </div>
          </details>

          <!-- (3) Regel-Liste mit Bearbeiten / Löschen -->
          <div id="ruleset_preview" class="rb-preview"></div>

          <!-- (4) YAML-Editor (Quelle der Wahrheit, manuell editierbar) -->
          <details id="ruleset_editor_wrap" class="rb-yaml">
            <summary data-i18n="rules.yamlEditor">YAML-Editor (anzeigen/bearbeiten)</summary>
            <textarea id="ruleset_yaml" spellcheck="false"></textarea>
            <div class="rb-form-actions">
              <button class="export-btn" id="ruleset_apply" data-i18n="rules.yamlApply">YAML anwenden</button>
              <button class="export-btn" id="ruleset_reset" data-i18n="rules.resetDefault" data-i18n-title="rules.resetTip" title="Auf das ASTRA-Standard-Regelset zurücksetzen">Auf Standard</button>
              <span id="ruleset_err" class="rb-err"></span>
            </div>
          </details>

        </div>
        </div>
      </div>
    </div>

    <details class="sec" id="sec_export">
      <summary data-i18n="inspector.export">Export</summary>
      <div class="secbody">
        <div id="dl"><div class="empty" data-i18n="inspector.exportEmpty">Noch keine Exporte.</div></div>
      </div>
    </details>
  </div>

  <footer id="footer">
    <div class="ft-left" id="ft_model" data-i18n="footer.noModel">Kein Modell geladen</div>
    <div class="ft-center" id="ft_summary" data-i18n="footer.ready">IfcInspect — bereit</div>
    <div class="ft-right" id="ft_build" data-i18n="footer.credit">BSc-Arbeit von Mio Buser · Berner Fachhochschule (BFH) · 2026</div>
  </footer>

  <!-- Mobile: Backdrop hinter den eingeblendeten Drawern (Tap schließt). -->
  <div id="m_backdrop" class="m-backdrop" hidden></div>
  <!-- Mobile: schwebende Toggle-Pill (unten rechts; Top-rechts=ViewCube,
       Unten-links=Achsenkreuz bleiben frei). Auf Desktop via CSS ausgeblendet. -->
  <div id="m_panel_ctl" class="m-panel-ctl">
    <button type="button" id="m_toggle_rail" class="m-pbtn">
      <span aria-hidden="true">☰</span> <span data-i18n="mobile.tools">Werkzeuge</span>
    </button>
    <button type="button" id="m_toggle_inspector" class="m-pbtn">
      <span aria-hidden="true">▤</span> <span data-i18n="mobile.findings">Befunde</span>
    </button>
  </div>
`;

export function mountShell(root: HTMLElement): ShellHandle {
  root.innerHTML = HTML;
  // Fill all static [data-i18n*] nodes for the current language.
  applyStaticTranslations(root);
  // Populate + wire the header language selector.
  const langSelect = root.querySelector("#lang_select") as HTMLSelectElement | null;
  if (langSelect) {
    langSelect.innerHTML = SUPPORTED
      .map((s) => `<option value="${s.code}">${escape(s.label)}</option>`)
      .join("");
    langSelect.value = getLang();
    langSelect.addEventListener("change", () => setLang(langSelect.value as never));
  }

  const viewerHost = root.querySelector("#viewer") as HTMLElement;
  const status = root.querySelector("#status") as HTMLElement;
  const msg = root.querySelector("#msg") as HTMLElement;
  const progressBar = root.querySelector("#progress .bar") as HTMLElement;
  const fileInput = root.querySelector("#file") as HTMLInputElement;

  const viewer = initViewer3d(viewerHost);

  // ---- Mobile: Rail + Inspector als einklappbare Overlay-Drawer ----------
  // Auf schmalen Viewports (<=820px, siehe @media in style.css) liegen Rail und
  // Inspector position:fixed über dem Viewer und sind per Pill/Backdrop ein- und
  // ausklappbar, damit das 3D-Modell sichtbar bleibt.
  const railEl = root.querySelector("#rail") as HTMLElement | null;
  const inspectorEl = root.querySelector("#inspector") as HTMLElement | null;
  const backdropEl = root.querySelector("#m_backdrop") as HTMLElement | null;
  const closeMobilePanels = () => {
    railEl?.classList.remove("m-open");
    inspectorEl?.classList.remove("m-open");
    if (backdropEl) backdropEl.hidden = true;
  };
  const openMobilePanel = (which: "rail" | "inspector") => {
    const opening = which === "rail" ? railEl : inspectorEl;
    const other = which === "rail" ? inspectorEl : railEl;
    other?.classList.remove("m-open");
    const nowOpen = opening?.classList.toggle("m-open") ?? false;
    if (backdropEl) backdropEl.hidden = !nowOpen;
  };
  root.querySelector("#m_toggle_rail")?.addEventListener("click", () => openMobilePanel("rail"));
  root.querySelector("#m_toggle_inspector")?.addEventListener("click", () => openMobilePanel("inspector"));
  backdropEl?.addEventListener("click", closeMobilePanels);
  root.querySelector("#m_close_rail")?.addEventListener("click", closeMobilePanels);
  root.querySelector("#m_close_inspector")?.addEventListener("click", closeMobilePanels);
  // Beim Wechsel zurück auf Desktop-Breite den Drawer-Zustand zurücksetzen.
  const mqMobile = window.matchMedia("(max-width: 820px)");
  const onMqMobile = () => { if (!mqMobile.matches) closeMobilePanels(); };
  if (mqMobile.addEventListener) mqMobile.addEventListener("change", onMqMobile);

  // Last rendered result so a live language switch can re-render the inspector
  // (which contains many dynamically-generated, keyed strings).
  let lastResult: DetectionResult | null = null;
  let lastFilename: string | undefined;
  // Element-Inspektor-Zustand: Index in der Element-Liste + ob isoliert.
  let inspectIndex = 0;
  let inspectActive = false;
  // BCF-Issues (pro RuleCheck, mit Kamera/Highlight/Bemaßung/Schnitt) — wie im
  // geführten Modus, hier für den Klick auf eine Regel im Element-Inspektor.
  let freeIssues: Issue[] = [];
  let activeRuleKey: string | null = null;

  // Remembered status so a live language switch can re-render the line. When
  // set via setStatusKey we keep the key+params; setStatus (raw text) clears it.
  let currentStatusKey: string | null = null;
  let currentStatusParams: Record<string, string | number> | undefined;

  const applyStatusOpts = (opts: { error?: boolean; loading?: boolean; pct?: number }) => {
    status.classList.toggle("err", !!opts.error);
    status.classList.toggle("loading", !!opts.loading);
    if (typeof opts.pct === "number") {
      progressBar.style.width = `${Math.round(opts.pct * 100)}%`;
    }
  };

  const setStatus: ShellHandle["setStatus"] = (text, opts = {}) => {
    currentStatusKey = null;
    currentStatusParams = undefined;
    msg.textContent = text;
    applyStatusOpts(opts);
  };

  const setStatusKey: ShellHandle["setStatusKey"] = (key, params, opts = {}) => {
    currentStatusKey = key;
    currentStatusParams = params;
    msg.textContent = t(key, params);
    applyStatusOpts(opts);
  };

  const showProgress = (p: WorkerProgress) => {
    // Worker progress messages carry an optional i18nKey (German fallback in
    // p.message). Translate when keyed; otherwise show the message verbatim.
    // This clears any remembered status key (it's transient init progress).
    const text = p.i18nKey ? t(p.i18nKey, p.i18nParams) : p.message;
    setStatus(text, { loading: true, pct: p.pct });
  };

  const showError = (text: string) => {
    setStatus(text, { error: true });
  };

  // ---- Element-Inspektor: pro Wand-Element durchschalten + alle Werte sehen --
  const inspectElems = (): WallMetrics[] =>
    (lastResult?.wall_metrics || []).filter((w) => !!w.element_guid);

  const applyInspectIsolation = () => {
    const elems = inspectElems();
    const wm = elems[inspectIndex];
    if (inspectActive && wm?.element_guid) {
      viewer.isolateElement(wm.element_guid);
      viewer.fitToElement(wm.element_guid);
    } else {
      // Isolation aus → zurück auf die Totale (alles zeigen + draufzoomen).
      viewer.isolateElement(null);
      viewer.fit();
    }
  };

  const renderInspector = () => {
    const panel = root.querySelector("#inspect_panel") as HTMLElement | null;
    const countEl = root.querySelector("#inspect_count") as HTMLElement | null;
    if (!panel) return;
    const elems = inspectElems();
    if (countEl) countEl.textContent = String(elems.length);
    if (elems.length === 0) {
      panel.innerHTML = `<div class="empty">${escape(t("inspector.inspectEmpty"))}</div>`;
      return;
    }
    if (inspectIndex >= elems.length) inspectIndex = 0;
    if (inspectIndex < 0) inspectIndex = elems.length - 1;
    const wm = elems[inspectIndex];
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" id="insp_iso" ${inspectActive ? "checked" : ""}/>
          <span>${escape(t("inspector.isolate"))}</span>
        </label>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
        <button id="insp_prev" class="export-btn" title="${escape(t("inspector.prev"))}">◀</button>
        <span style="font-family:var(--font-mono);font-size:12px">${inspectIndex + 1} / ${elems.length}</span>
        <button id="insp_next" class="export-btn" title="${escape(t("inspector.next"))}">▶</button>
      </div>
      <div>${renderWallBlock(wm)}</div>`;
    const go = (delta: number) => {
      const n = inspectElems().length || 1;
      inspectIndex = (inspectIndex + delta + n) % n;
      renderInspector();
      if (inspectActive) applyInspectIsolation();
    };
    (root.querySelector("#insp_iso") as HTMLInputElement | null)
      ?.addEventListener("change", (ev) => {
        inspectActive = (ev.target as HTMLInputElement).checked;
        applyInspectIsolation();
      });
    (root.querySelector("#insp_prev") as HTMLElement | null)
      ?.addEventListener("click", () => go(-1));
    (root.querySelector("#insp_next") as HTMLElement | null)
      ?.addEventListener("click", () => go(+1));
    // Regel-Karten klickbar → volle BCF-Ansicht (Kamera/Highlight/Bemaßung/Schnitt).
    panel.querySelectorAll<HTMLElement>("[data-rule-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const rid = el.dataset.ruleId || "";
        const g = el.dataset.elGuid || "";
        if (rid && g) jumpToFreeIssue(g, rid);
      });
      if (activeRuleKey && `${el.dataset.elGuid}__${el.dataset.ruleId}` === activeRuleKey) {
        styleRuleCard(el, true);
      }
    });
    // L5-Fundament-Link → das zugehörige Fundament auswählen + isolieren (wie
    // ein Element-Pick). Default-Anchor-Navigation unterdrücken.
    panel.querySelectorAll<HTMLElement>("[data-fund-guid]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const g = el.dataset.fundGuid || "";
        // focusProduct (nicht selectElementByGuid): das Fundament ist L5-Kontext
        // und KEIN wall_metrics-Eintrag → über die Produkt-Geometrie fokussieren.
        if (g) viewer.focusProduct(g);
        closeMobilePanels(); // Mobile: Inspector schließen → 3D sichtbar
      });
    });
  };

  // Aus dem 3D-Doppelklick: das GANZE Element auswählen → Inspektor dorthin,
  // isolieren + zoomen. Matcht auch union'te Kopien via element_guids.
  const selectElementByGuid = (guid: string) => {
    const elems = inspectElems();
    const idx = elems.findIndex(
      (w) => w.element_guid === guid || (w.element_guids || []).includes(guid),
    );
    if (idx < 0) return;
    // Toggle: Doppelklick auf das BEREITS isolierte Element → zurück auf Totale.
    if (inspectActive && idx === inspectIndex) {
      inspectActive = false;
      renderInspector();
      applyInspectIsolation(); // isolateElement(null) + fit() → Gesamtansicht
      return;
    }
    inspectIndex = idx;
    inspectActive = true;
    const sec = root.querySelector("#sec_inspect") as HTMLDetailsElement | null;
    if (sec) sec.open = true;
    renderInspector();
    applyInspectIsolation();
  };
  viewer.onElementPick((guid) => {
    if (guid && lastResult) selectElementByGuid(guid);
  });

  // Klick auf eine Regel im Inspektor → volle BCF-Ansicht wie im geführten
  // Modus (Kamera + Klassen-Highlight + Bemaßung + Schnittebene). Matcht das
  // Issue über (element_guid, ruleId).
  const jumpToFreeIssue = (guid: string, ruleId: string) => {
    if (!lastResult) return;
    const wms = lastResult.wall_metrics || [];
    const it = freeIssues.find(
      (i) => i.ruleId === ruleId && wms[i.wallIndex]?.element_guid === guid,
    );
    if (!it) return;
    activeRuleKey = `${guid}__${ruleId}`;
    // Maß-Endpunkte exakt auf die Schnittebene legen (lazy, beim Öffnen).
    refineIssueAnnotation(it, lastResult);
    // BCF-Ansicht — IDENTISCH zum geführten Modus: eng aufs betroffene Element
    // einpassen, Rest dezent ausgrauen (klassenfarbige Kanten am Bauteil), Bemaßung
    // + Schnitt. Vorher nur Kamera-Schwenk ohne Isolation/Fit → jetzt angeglichen.
    inspectActive = false;
    viewer.isolateElement(null);
    viewer.setLayerVisible("wall", true);
    renderInspector();
    // Bemasste Regeln (dimension/arrow): exakt auf die Schnitt-/Profilfläche
    // einpassen (issue.view, identisch zum BCF-Export) → geschnittene Fläche füllt
    // das Bild, Bemassung konstant relativ zum Element. Sonst: eng aufs Element.
    if (it.annotation?.kind === "dimension" || it.annotation?.kind === "arrow") {
      viewer.setIssueView(it.view, { animate: true });
    } else {
      viewer.fitToElements([guid], it.view, { animate: true });
    }
    viewer.highlightIssueRegion(null);
    viewer.setIssueAnnotations(buildDimensionAnnotation(it));
    viewer.setContextDimmed(true);
    viewer.setFindingIsolation([guid]);
    // crown_min_width: NUR die K2-Krone zeigen (Wandstärke-Schnitt, übrige Klassen
    // ausblenden); andere Regeln behalten alle Klassen des Bauteils.
    if (it.ruleId === "crown_min_width" && it.highlight?.kind === "class") {
      viewer.highlightIssueRegion(it.highlight.classKey);
    }
    // Immer schneiden, wenn für die Regel eine Schnittebene verfügbar ist.
    viewer.setSectionPlane(it.section ? it.section : null);
    root.querySelectorAll<HTMLElement>("#inspect_panel [data-rule-id]").forEach((el) => {
      styleRuleCard(el, el.dataset.elGuid === guid && el.dataset.ruleId === ruleId);
    });
    closeMobilePanels(); // Mobile: Inspector schließen → BCF-Ansicht im 3D sichtbar
  };
  const styleRuleCard = (el: HTMLElement, on: boolean) => {
    el.style.borderColor = on ? "var(--accent)" : "var(--border,#2a2f3a)";
    el.style.background = on ? "rgba(90,160,255,0.10)" : "transparent";
  };

  // ESC / Rechtsklick ins Leere → Viewer resettet auf Totale; Shell räumt den
  // Inspektor-/Regel-Zustand mit.
  viewer.onReset(() => {
    inspectActive = false;
    activeRuleKey = null;
    renderInspector();
  });

  const showResult = (result: DetectionResult, filename?: string) => {
    // Gleiche Result-Instanz (z.B. Deferred-L7-Re-Render) → Inspektor-Zustand
    // (Index + Isolation) NICHT zuruecksetzen, sonst springt er zurueck.
    const sameResult = result === lastResult;
    lastResult = result;
    lastFilename = filename;
    if (!sameResult) {
      inspectIndex = 0;
      inspectActive = false;
    }
    // BCF-Issues für die klickbaren Inspektor-Regeln (wie geführter Modus).
    freeIssues = deriveIssues(result);
    activeRuleKey = null;
    setStatusKey(
      "status.done",
      { count: result.cavity_count, wall: result.wall_name, secs: "…" },
      { pct: 1.0 },
    );

    // Ergebnis section
    const cnt = root.querySelector("#result_count")!;
    cnt.textContent = t("inspector.countPieces", { n: result.cavity_count });
    const body = root.querySelector("#result_body")!;
    body.innerHTML = `
      <div class="kpi-row"><span>${t("result.wall")}</span><span>${escape(result.wall_name)}</span></div>
      <div class="kpi-row"><span>${t("result.cavities")}</span><span>${result.cavity_count}</span></div>
      <div class="kpi-row"><span>${t("result.method")}</span><span>${escape(result.method)}</span></div>
      <div class="kpi-row"><span>${t("result.approximated")}</span><span>${result.approximated ? t("common.yes") : t("common.no")}</span></div>
    `;

    // Walls
    const walls = root.querySelector("#walls_count")!;
    walls.textContent = String((result.candidates || []).length);
    const wl = root.querySelector("#walllist")!;
    if ((result.candidates || []).length > 0) {
      wl.innerHTML = result.candidates
        .map(
          ([guid, label]) =>
            `<div class="kpi-row"><span>${escape(label)}</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--text-mute)">${escape((guid || "").slice(0, 10))}</span></div>`,
        )
        .join("");
    }

    // (Kenngrössen-Sektion entfernt — die Kennwerte stehen im Bauteil-Inspektor.)
    // Footer summary: 1 Wand · 0 FAIL · 0 WARN · 4 PASS
    const tally = tallyPruefung(result);
    const ftSummary = root.querySelector("#ft_summary") as HTMLElement;
    if (ftSummary) {
      ftSummary.textContent = t("footer.summary", {
        walls: (result.wall_metrics || []).length,
        fail: tally.fail, warn: tally.warn, pass: tally.pass,
      });
    }

    // Klassifikation -- K0..K6 swatch toggles + counts.
    // Erd-Seiten-Legende (result.scene.earth_side_class) global setzen, damit
    // clsLabel() K4/K5 hier UND im Element-Inspektor/Layer-Popover konsistent
    // in „Seitenfläche (Erd)/(Luft)" umbenennt (nur wenn eindeutig).
    const esc = result.scene?.earth_side_class;
    currentEarthSideClass = esc === "K4" || esc === "K5" ? esc : null;
    const cls = root.querySelector("#cls")!;
    const kindCounts: Record<string, number> = {};
    for (const c of result.cavities || []) {
      kindCounts[c.kind] = (kindCounts[c.kind] || 0) + 1;
    }
    // Legenden-Swatches aus der EFFEKTIVEN Farbe ableiten (User-Override aus
    // loadLayerStyles, sonst LAYER_STYLE_DEFAULT_COLOR = dieselbe Quelle wie der
    // Viewer). Vorher war hier eine zweite, hartcodierte Liste, die nach Farb-
    // änderungen (z. B. K6 → Magenta) veraltete ("Legende nicht aktuell").
    const _legendStyles = loadLayerStyles();
    const _legendHex = (k: string): string => {
      const ov = _legendStyles[k]?.color;
      const n = typeof ov === "number" ? ov : (LAYER_STYLE_DEFAULT_COLOR[k] ?? 0x9aa0a8);
      return "#" + (n >>> 0).toString(16).padStart(6, "0");
    };
    const classColors: Array<[string, string]> =
      (["K0", "K1", "K2", "K3", "K4", "K5", "K6"] as const).map((k) => [k, _legendHex(k)]);
    const togglesHTML = classColors
      .map(([k, col]) => {
        const label = clsLabel(k);
        return `<button class="cls-toggle on" data-class-toggle="${k}" title="${escape(label)} (Shift+${k.slice(1)})" style="--sw:${col}">
             <span class="sw"></span><b>${k}</b><span class="lbl">${escape(label)}</span><span class="cnt">${kindCounts[k] || 0}</span>
           </button>`;
      })
      .join("");
    cls.innerHTML = `<div class="cls-toggles">${togglesHTML}</div>`;
    const clsCount = root.querySelector("#cls_count");
    if (clsCount) clsCount.textContent = t("inspector.countFaces", { n: (result.cavities || []).length });

    // Wire class toggles -> viewer.setLayerVisible(Kn, …)
    // #bvol (Rail) spiegelt "irgendeine Klassenfläche sichtbar" — nach jedem
    // Einzel-Swatch-Toggle resynchen, sonst zeigt der Rail-Button einen
    // veralteten Zustand und der nächste #bvol-Klick wirkt wie ein No-op.
    const syncBvol = () => {
      const bvol = root.querySelector("#bvol") as HTMLButtonElement | null;
      if (bvol) bvol.classList.toggle("on", !!cls.querySelector(".cls-toggle.on"));
    };
    cls.querySelectorAll<HTMLButtonElement>(".cls-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.classToggle!;
        const on = btn.classList.toggle("on");
        viewer.setLayerVisible(key, on);
        syncBvol();
      });
      // Right-click → per-class appearance popover (key "K0".."K6").
      btn.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const key = btn.dataset.classToggle!;
        shellLayerStyle?.open(key, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
      });
    });

    // Footer (left part — keep summary set above)
    (root.querySelector("#ft_model") as HTMLElement).textContent = result.wall_name;

    // Export buttons — JSON guaranteed, CSV + HTML best-effort
    renderExports(root, result, filename || `${result.wall_name || "modell"}.ifc`, viewer);

    // Drive the viewer — ONLY rebuild the 3D scene for a genuinely NEW result.
    // The deferred-L7 pass calls showResult again with the SAME result instance
    // (sameResult); rebuilding would reset layer visibility/styles + the user's
    // rail toggles AND snap the camera — which looked like "zooming resets the
    // display settings". For sameResult we only refresh the DOM (findings/rules
    // now carry the L7 distances); the existing scene, toggles and view stay put.
    if (!sameResult) {
      viewer.renderResult(result);
      // Re-apply persisted appearance settings so they survive a new model load.
      shellLayerStyle?.applyStored();
    }
    // Element-Inspektor-Panel (pro Wand-Element durchschalten + Werte).
    renderInspector();
    // Isolation/Fit nur nach echtem Neu-Aufbau (beim Deferred-Update bleibt die
    // bestehende Isolation ohnehin erhalten, da die Szene nicht neu gebaut wird).
    if (!sameResult && inspectActive) applyInspectIsolation();
  };

  const fileCallbacks: Array<(file: File) => void> = [];
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) fileCallbacks.forEach((cb) => cb(f));
    fileInput.value = "";
  });

  // Rail toggles -- layer visibility into the viewer
  const wire = (id: string, layer: string) => {
    const btn = root.querySelector(`#${id}`) as HTMLButtonElement;
    btn?.addEventListener("click", () => {
      btn.classList.toggle("on");
      viewer.setLayerVisible(layer, btn.classList.contains("on"));
    });
  };
  wire("bwall", "wall");
  wire("bterrain", "context");
  // "Klassifikationsflächen" (#bvol) toggles ALL classification faces K0–K6
  // together (K6/Schaleinlagen are classification faces too).
  const wireClasses = (id: string, keys: string[]) => {
    const btn = root.querySelector(`#${id}`) as HTMLButtonElement | null;
    btn?.addEventListener("click", () => {
      btn.classList.toggle("on");
      const on = btn.classList.contains("on");
      for (const k of keys) viewer.setLayerVisible(k, on);
    });
  };
  wireClasses("bvol", ["K0", "K1", "K2", "K3", "K4", "K5", "K6"]);
  (root.querySelector("#bfit") as HTMLButtonElement)?.addEventListener(
    "click",
    () => viewer.fit(),
  );

  // ---- Schnitt-Werkzeuge (FREE-Modus): Pick-Face + draggable planes in rail --
  wireSectionTools(root, viewer);

  // ---- Custom tooltip for .has-tip elements (privacy badge etc.) ----------
  initCustomTooltip();

  // ---- Right-click appearance settings popover ---------------------------- //
  // Opened by contextmenu on the rail layer toggles and the per-class swatch
  // toggles. Applies live, persists per key in localStorage, and is re-applied
  // after every render via applyStoredLayerStyles().
  const layerStylePop = createLayerStylePopover(viewer);
  // Rail toggles → their layer keys. #bvol represents all K0–K6 cavities → use
  // the shared "cavities" style group (Pass 1 maps it to all classification faces).
  const railStyleTargets: Array<[string, string]> = [
    ["bwall", "wall"],
    ["bvol", "cavities"],
    ["bterrain", "context"],
  ];
  for (const [id, key] of railStyleTargets) {
    const btn = root.querySelector(`#${id}`) as HTMLButtonElement | null;
    btn?.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      layerStylePop.open(key, ev.clientX, ev.clientY);
    });
  }
  // Expose the per-class swatch wiring + re-apply so showResult() can call them.
  shellLayerStyle = layerStylePop;

  // Drag-drop on the viewport
  viewerHost.addEventListener("dragover", (ev) => {
    ev.preventDefault();
  });
  viewerHost.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files?.[0];
    if (f) fileCallbacks.forEach((cb) => cb(f));
  });

  // Mode-switch wiring (Geführt / Frei). Persists to localStorage via the
  // main-thread setMode handler that subscribes through onModeChange.
  const modeCallbacks: Array<(m: "guided" | "free") => void> = [];
  root.querySelectorAll<HTMLButtonElement>("[data-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.modeBtn as "guided" | "free";
      modeCallbacks.forEach((cb) => cb(target));
    });
  });

  // Wire the Regelset section (works regardless of whether a model is loaded).
  wireRulesetSection(root);

  // Regelset-Modal: open via header button, close via ✕ / Esc / backdrop click.
  const rulesetModal = root.querySelector("#ruleset_modal") as HTMLElement | null;
  const openRulesetsBtn = root.querySelector("#open_rulesets") as HTMLButtonElement | null;
  const closeRulesetsBtn = root.querySelector("#close_rulesets") as HTMLButtonElement | null;
  const openRulesetModal = () => {
    if (!rulesetModal) return;
    rulesetModal.hidden = false;
    // Focus the close button for keyboard accessibility.
    closeRulesetsBtn?.focus();
  };
  const closeRulesetModal = () => {
    if (rulesetModal) rulesetModal.hidden = true;
    openRulesetsBtn?.focus();
  };
  openRulesetsBtn?.addEventListener("click", openRulesetModal);
  closeRulesetsBtn?.addEventListener("click", closeRulesetModal);
  // Backdrop click (on the overlay itself, not the dialog) closes the modal.
  rulesetModal?.addEventListener("click", (ev) => {
    if (ev.target === rulesetModal) closeRulesetModal();
  });
  // Esc closes the modal when it is open.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && rulesetModal && !rulesetModal.hidden) {
      closeRulesetModal();
    }
  });

  // ---- Live language switch ---------------------------------------------- //
  // Static nodes are handled by applyStaticTranslations(document) inside
  // setLang(); here we re-render the DYNAMIC inspector content + status line +
  // keep the header selector in sync.
  onLangChange(() => {
    if (langSelect) langSelect.value = getLang();
    // Re-translate the remembered status line (key-based) so it follows lang.
    if (currentStatusKey) {
      msg.textContent = t(currentStatusKey, currentStatusParams);
    }
    // Re-render the inspector + exports + footer from the cached result.
    if (lastResult) {
      showResult(lastResult, lastFilename);
    }
    // The ruleset preview/count + builder option labels are rebuilt by
    // wireRulesetSection's own lang subscriber (registered there).
  });

  const clearResult = () => {
    lastResult = null;
    lastFilename = undefined;
    setStatusKey("status.ready");
    const cnt = root.querySelector("#result_count");
    if (cnt) cnt.textContent = "";
    const body = root.querySelector("#result_body");
    if (body) body.innerHTML = `<div class="empty">${t("inspector.resultEmpty")}</div>`;
    const walls = root.querySelector("#walls_count");
    if (walls) walls.textContent = "";
    const wl = root.querySelector("#walllist");
    if (wl) wl.innerHTML = `<div class="empty">${escape(t("inspector.wallsEmpty"))}</div>`;
    const kp = root.querySelector("#kpi");
    if (kp) kp.innerHTML = `<div class="empty">${escape(t("inspector.kpiEmpty"))}</div>`;
    const cls = root.querySelector("#cls");
    if (cls) cls.innerHTML = `<div class="empty">${escape(t("inspector.clsEmpty"))}</div>`;
    const clsCount = root.querySelector("#cls_count");
    if (clsCount) clsCount.textContent = "";
    const dl = root.querySelector("#dl");
    if (dl) dl.innerHTML = `<div class="empty">${escape(t("inspector.exportEmpty"))}</div>`;
    const ftSummary = root.querySelector("#ft_summary") as HTMLElement | null;
    if (ftSummary) ftSummary.textContent = t("footer.ready");
    const ftModel = root.querySelector("#ft_model") as HTMLElement | null;
    if (ftModel) ftModel.textContent = t("footer.noModel");
  };

  return {
    viewer,
    viewerHost,
    setStatus,
    setStatusKey,
    showProgress,
    showResult,
    showError,
    onFile: (cb) => fileCallbacks.push(cb),
    onModeChange: (cb) => modeCallbacks.push(cb),
    clearResult,
  };
}

// ---- Custom tooltip (replaces the unreliable native title hint) ---------- //
// One shared, JS-positioned bubble for any element with class "has-tip" and a
// data-tip attribute. Shows on hover + keyboard focus; clamps to the viewport
// so the centred header/hero badges never clip at the screen edge. The native
// title attribute is kept on those elements as a no-JS fallback.
function initCustomTooltip(): void {
  if (document.getElementById("nd-tooltip")) return;
  const tip = document.createElement("div");
  tip.id = "nd-tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;

  const place = (target: HTMLElement) => {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    current = target;
    tip.textContent = text;
    tip.hidden = false;
    // Measure after content set, then clamp into the viewport.
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const margin = 8;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.bottom + 6;
    // Flip above the target if it would overflow the bottom edge.
    if (top + th + margin > window.innerHeight) top = r.top - th - 6;
    left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - th - margin));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    // Trigger the fade-in on the next frame.
    requestAnimationFrame(() => tip.classList.add("show"));
  };
  const hide = (target?: EventTarget | null) => {
    if (target && target !== current) return;
    current = null;
    tip.classList.remove("show");
    tip.hidden = true;
  };
  const tipTarget = (ev: Event): HTMLElement | null => {
    const el = ev.target as HTMLElement | null;
    return el?.closest<HTMLElement>(".has-tip") || null;
  };

  // Delegated on document so badges in BOTH shells (mounted at any time) work.
  document.addEventListener("pointerover", (ev) => {
    const t = tipTarget(ev);
    if (t) place(t);
  });
  document.addEventListener("pointerout", (ev) => {
    const t = tipTarget(ev);
    if (t) hide(t);
  });
  document.addEventListener("focusin", (ev) => {
    const t = tipTarget(ev);
    if (t) place(t);
  });
  document.addEventListener("focusout", (ev) => {
    const t = tipTarget(ev);
    if (t) hide(t);
  });
  // Defensive: hide on scroll / Escape so it never lingers.
  document.addEventListener("scroll", () => hide(current), true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hide(current); });
}

// ---- Right-click appearance settings popover ----------------------------- //
// Per-key (layer / class) colour, opacity, edge line-width and edge visibility.
// Applies live, persists to localStorage, re-applies after each render.
const LAYER_STYLE_LS_KEY = "ifcinspect_layerstyle";
// Default colours per key — mirror viewer COLORS so the colour input starts at
// the layer's real tint (the viewer is the source of truth; these are the SPA
// copies used only to seed the <input type="color">).
const LAYER_STYLE_DEFAULT_COLOR: Record<string, number> = {
  wall: 0x9aa0a8, cavities: 0xffd400, context: 0x8b7355,
  K0: 0xe53935, K1: 0xfb8c00, K2: 0x2196f3, K3: 0x8e24aa,
  K4: 0x66bb6a, K5: 0x00897b, K6: 0xd81b9a,
};
// Tatsächliche Default-Deckkraft je Layer im Viewer (buildMesh): Wand 0.45,
// Kontext/Terrain 0.55, Klassifikationsflächen opak. Der Opacity-Slider startet
// sonst fälschlich bei 100 % und stimmt nicht mit dem Modell überein.
const LAYER_STYLE_DEFAULT_OPACITY: Record<string, number> = {
  wall: 0.45, cavities: 1.0, context: 0.55,
  K0: 1.0, K1: 1.0, K2: 1.0, K3: 1.0, K4: 1.0, K5: 1.0, K6: 1.0,
};
// i18n-aware label for a layer-style key. Layer keys (wall/cavities/context)
// map to settings.* keys; class keys "K0".."K6" show "Kn · <display name>".
function layerStyleLabel(key: string): string {
  if (key === "wall") return t("settings.layerModel");
  if (key === "cavities") return t("settings.layerClassFaces");
  if (key === "context") return t("settings.layerTerrain");
  if (/^K[0-6]$/.test(key)) return `${key} · ${clsLabel(key)}`;
  return key;
}

type StoredStyle = { color?: number; opacity?: number; lineWidth?: number; edges?: boolean };

function loadLayerStyles(): Record<string, StoredStyle> {
  try {
    const raw = localStorage.getItem(LAYER_STYLE_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, StoredStyle> : {};
  } catch { return {}; }
}
function saveLayerStyles(all: Record<string, StoredStyle>): void {
  try { localStorage.setItem(LAYER_STYLE_LS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

function createLayerStylePopover(viewer: Viewer3D): LayerStylePopover {
  const all = loadLayerStyles();

  const pop = document.createElement("div");
  pop.id = "layer-style-pop";
  pop.hidden = true;
  document.body.appendChild(pop);

  let activeKey: string | null = null;

  const hexStr = (n: number) => "#" + n.toString(16).padStart(6, "0");

  // Apply one stored style entry to the viewer (used live + on re-apply).
  const applyOne = (key: string, s: StoredStyle) => {
    if (typeof s.color === "number") viewer.setLayerColor(key, s.color);
    if (typeof s.opacity === "number") viewer.setLayerOpacity(key, s.opacity);
    if (typeof s.lineWidth === "number") viewer.setLayerLineWidth(key, s.lineWidth);
    if (typeof s.edges === "boolean") viewer.setLayerEdgesVisible(key, s.edges);
  };

  const applyStored = () => {
    // "cavities" persists per the rail toggle, but colour/opacity must hit each
    // K0..K6 group too (cavities is the shared parent). Apply cavities + classes.
    for (const [key, s] of Object.entries(all)) applyOne(key, s);
  };

  const hide = () => { pop.hidden = true; activeKey = null; };

  const open = (key: string, x: number, y: number) => {
    activeKey = key;
    const cur = all[key] || {};
    const color = typeof cur.color === "number" ? cur.color : (LAYER_STYLE_DEFAULT_COLOR[key] ?? 0x9aa0a8);
    const opacityPct = Math.round((typeof cur.opacity === "number"
      ? cur.opacity
      : (LAYER_STYLE_DEFAULT_OPACITY[key] ?? 1)) * 100);
    const lineWidth = typeof cur.lineWidth === "number" ? cur.lineWidth : 1;
    const edges = typeof cur.edges === "boolean" ? cur.edges : true;
    pop.innerHTML = `
      <div class="lsp-title">${escape(layerStyleLabel(key))}</div>
      <label class="lsp-row"><span>${escape(t("lsp.color"))}</span>
        <input type="color" id="lsp_color" value="${hexStr(color)}" /></label>
      <label class="lsp-row"><span>${escape(t("lsp.opacity"))}</span>
        <input type="range" id="lsp_opacity" min="0" max="100" step="1" value="${opacityPct}" />
        <span class="lsp-val" id="lsp_opacity_val">${opacityPct}%</span></label>
      <label class="lsp-row"><span>${escape(t("lsp.lineWidth"))}</span>
        <input type="range" id="lsp_lw" min="0" max="4" step="0.5" value="${lineWidth}" />
        <span class="lsp-val" id="lsp_lw_val">${lineWidth}</span></label>
      <label class="lsp-row"><span>${escape(t("lsp.showEdges"))}</span>
        <input type="checkbox" id="lsp_edges" ${edges ? "checked" : ""} /></label>
    `;
    pop.hidden = false;
    // Position at cursor, clamped to the viewport.
    const margin = 8;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(margin, Math.min(x, window.innerWidth - pw - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - ph - margin));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    const store = (patch: StoredStyle) => {
      all[key] = { ...(all[key] || {}), ...patch };
      saveLayerStyles(all);
    };

    const colorIn = pop.querySelector("#lsp_color") as HTMLInputElement;
    const opacityIn = pop.querySelector("#lsp_opacity") as HTMLInputElement;
    const opacityVal = pop.querySelector("#lsp_opacity_val") as HTMLElement;
    const lwIn = pop.querySelector("#lsp_lw") as HTMLInputElement;
    const lwVal = pop.querySelector("#lsp_lw_val") as HTMLElement;
    const edgesIn = pop.querySelector("#lsp_edges") as HTMLInputElement;

    colorIn.addEventListener("input", () => {
      const hex = parseInt(colorIn.value.slice(1), 16);
      viewer.setLayerColor(key, hex);
      store({ color: hex });
    });
    opacityIn.addEventListener("input", () => {
      const pct = parseInt(opacityIn.value, 10);
      opacityVal.textContent = `${pct}%`;
      viewer.setLayerOpacity(key, pct / 100);
      store({ opacity: pct / 100 });
    });
    lwIn.addEventListener("input", () => {
      const w = parseFloat(lwIn.value);
      lwVal.textContent = String(w);
      viewer.setLayerLineWidth(key, w);
      store({ lineWidth: w });
    });
    edgesIn.addEventListener("change", () => {
      viewer.setLayerEdgesVisible(key, edgesIn.checked);
      store({ edges: edgesIn.checked });
    });
  };

  // Close on outside-click / Escape / scroll, matching the other menus.
  document.addEventListener("pointerdown", (ev) => {
    if (!pop.hidden && !pop.contains(ev.target as Node)) hide();
  }, true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && activeKey) hide(); });
  document.addEventListener("scroll", () => { if (activeKey) hide(); }, true);

  return { open, applyStored };
}

// Wire the section-plane rail button (BimCollab-style popover + context menu).
function wireSectionTools(root: HTMLElement, viewer: Viewer3D): void {
  const sectionBtn = root.querySelector("#sp_section") as HTMLButtonElement | null;
  if (!sectionBtn) return;

  // ---- Build placement popover -------------------------------------------
  const popover = document.createElement("div");
  popover.id = "sp_popover";
  popover.hidden = true;
  popover.innerHTML = `
    <button class="sp-pop-row" id="sp_pop_face" data-i18n="section.onFace">⊞ Auf Fläche</button>
    <button class="sp-pop-row" id="sp_pop_path" data-i18n="section.path2pts">Grundriss · 2 Punkte</button>
    <div class="sp-pop-sep"></div>
    <button class="sp-pop-row sp-pop-cancel" id="sp_pop_cancel" data-i18n="section.cancel">Abbrechen</button>
  `;
  document.body.appendChild(popover);
  applyStaticTranslations(popover);

  // ---- Build context menu ------------------------------------------------
  const ctxMenu = document.createElement("div");
  ctxMenu.id = "plane-ctx";
  ctxMenu.hidden = true;
  ctxMenu.innerHTML = `
    <button class="ctx-row" id="ctx_flip" data-i18n="section.flip">⇅ Umkehren</button>
    <button class="ctx-row" id="ctx_hide" data-i18n="section.hide">Anzeige ausblenden</button>
    <button class="ctx-row" id="ctx_delete" data-i18n="section.delete">Löschen</button>
    <div class="ctx-sep"></div>
    <button class="ctx-row ctx-danger" id="ctx_clear" data-i18n="section.clearAll">Alle Schnitte löschen</button>
  `;
  document.body.appendChild(ctxMenu);
  applyStaticTranslations(ctxMenu);

  // Empty-space context menu: hide/show ALL plane indicators (cut + caps stay).
  const ctxAll = document.createElement("div");
  ctxAll.id = "plane-ctx-all";
  ctxAll.hidden = true;
  ctxAll.innerHTML = `
    <button class="ctx-row" id="ctx_all_reset" data-i18n="section.resetView">Auf Totale zurücksetzen</button>
    <button class="ctx-row" id="ctx_all_hide" data-i18n="section.allHide">Alle Schnittflächen ausblenden</button>
    <button class="ctx-row" id="ctx_all_show" data-i18n="section.allShow">Alle einblenden</button>
  `;
  document.body.appendChild(ctxAll);
  applyStaticTranslations(ctxAll);

  let ctxPlaneIndex = -1;

  const hideCtx = () => { ctxMenu.hidden = true; };
  const hideCtxAll = () => { ctxAll.hidden = true; };
  const hidePop = () => { popover.hidden = true; };

  // Position popover below the Schnitt button
  const showPop = () => {
    const rect = sectionBtn.getBoundingClientRect();
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.hidden = false;
  };

  sectionBtn.addEventListener("click", () => {
    if (!popover.hidden) { hidePop(); return; }
    showPop();
  });

  // Popover choices
  root.ownerDocument.getElementById("sp_pop_face")?.addEventListener("click", () => {
    hidePop();
    viewer.startSectionPlacement("face");
  });
  root.ownerDocument.getElementById("sp_pop_path")?.addEventListener("click", () => {
    hidePop();
    viewer.startSectionPlacement("path");
  });
  root.ownerDocument.getElementById("sp_pop_cancel")?.addEventListener("click", () => {
    hidePop();
    viewer.cancelSectionPlacement();
  });

  // Close popover on outside click
  document.addEventListener("pointerdown", (ev) => {
    if (!popover.hidden && !popover.contains(ev.target as Node) && ev.target !== sectionBtn) {
      hidePop();
    }
    if (!ctxMenu.hidden && !ctxMenu.contains(ev.target as Node)) {
      hideCtx();
    }
    if (!ctxAll.hidden && !ctxAll.contains(ev.target as Node)) {
      hideCtxAll();
    }
  }, true);

  // Close popover/ctxMenu on Escape
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { hidePop(); hideCtx(); hideCtxAll(); }
  });
  // Close menus on scroll
  document.addEventListener("scroll", () => { hideCtx(); hideCtxAll(); }, true);

  // Sync .on class on Schnitt button during placement
  viewer.onPlacementChange((mode) => {
    sectionBtn.classList.toggle("on", mode !== "none");
  });

  // Context menu wiring
  viewer.onPlaneContextMenu((index, x, y) => {
    hideCtxAll();
    ctxPlaneIndex = index;
    ctxMenu.style.left = `${x}px`;
    ctxMenu.style.top = `${y}px`;
    ctxMenu.hidden = false;
  });

  // Empty-space right-click → "all hide/show" menu.
  viewer.onEmptyContextMenu((x, y) => {
    hideCtx();
    ctxAll.style.left = `${x}px`;
    ctxAll.style.top = `${y}px`;
    ctxAll.hidden = false;
  });

  root.ownerDocument.getElementById("ctx_flip")?.addEventListener("click", () => {
    viewer.flipClipPlane(ctxPlaneIndex);
    hideCtx();
  });
  root.ownerDocument.getElementById("ctx_hide")?.addEventListener("click", () => {
    // Hide ONLY the indicator quad+outline; the cut + cap stay.
    viewer.setPlaneVisible(ctxPlaneIndex, false);
    hideCtx();
  });
  root.ownerDocument.getElementById("ctx_delete")?.addEventListener("click", () => {
    viewer.deleteClipPlane(ctxPlaneIndex);
    hideCtx();
  });
  root.ownerDocument.getElementById("ctx_clear")?.addEventListener("click", () => {
    viewer.clearClipPlanes();
    hideCtx();
  });
  root.ownerDocument.getElementById("ctx_all_hide")?.addEventListener("click", () => {
    viewer.setAllPlanesVisible(false);
    hideCtxAll();
  });
  root.ownerDocument.getElementById("ctx_all_show")?.addEventListener("click", () => {
    viewer.setAllPlanesVisible(true);
    hideCtxAll();
  });
  root.ownerDocument.getElementById("ctx_all_reset")?.addEventListener("click", () => {
    viewer.resetView();
    hideCtxAll();
  });
}

function downloadBlob(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCsv(result: DetectionResult): string {
  // German Excel-CSV: ; separator, comma decimal.
  const rows: string[] = ["wall_guid;wall_name;cavity_kind;element_name;element_guid"];
  for (const c of result.cavities || []) {
    rows.push(
      [
        result.chosen_guid || "",
        result.wall_name || "",
        c.kind || "",
        c.element_name || "",
        c.element_guid || "",
      ]
        .map((v) => String(v).replace(/;/g, ","))
        .join(";"),
    );
  }
  return rows.join("\r\n");
}

function renderExports(root: HTMLElement, result: DetectionResult, filename: string, viewer?: Viewer3D): void {
  const dl = root.querySelector("#dl");
  if (!dl) return;
  const base = filename.replace(/\.ifc$/i, "") || "modell";
  // IFC is generated ON DEMAND via window.ndExportIfc (detect() no longer ships
  // ifc_bytes_b64), so the IFC button is ALWAYS enabled. GLB still depends on
  // the result payload.
  const hasIfc = true;
  const hasGlb = !!result.glb_bytes_b64;
  // Einheitliches Export-Layout (Freier Modus): pro Eintrag eine Beschriftung,
  // darunter EIN gleich breiter (voll-breiter) oranger Button; Optionen als
  // links-ausgerichtete Checkboxen IMMER direkt UNTER dem zugehörigen Button.
  const dlBtn = (fmt: string, label: string, enabled = true) =>
    `<button class="export-btn exp-dl" data-fmt="${fmt}" title="${escape(label)}"${enabled ? "" : " disabled"}>${escape(label)}</button>`;
  const opt = (attr: string, label: string, checked = false) =>
    `<label class="exp-opt"><input type="checkbox" ${attr}${checked ? " checked" : ""} /> ${escape(label)}</label>`;
  dl.innerHTML = `
    <div class="exp">
      <div class="exp-item"><div class="exp-cap">${t("export.jsonReport")}</div>
        ${dlBtn("json", base + "_pruefprotokoll.json")}</div>
      <div class="exp-item"><div class="exp-cap">${t("export.htmlReport")}</div>
        ${dlBtn("pdf", base + "_pruefprotokoll.pdf")}
        ${opt("data-pdf-kennwerte", t("export.optKennwerte"), true)}</div>
      <div class="exp-item"><div class="exp-cap">${t("export.csvTable")}</div>
        ${dlBtn("csv", base + "_pruefprotokoll.csv")}</div>
      <div class="exp-item"><div class="exp-cap">${t("export.bcf")}</div>
        ${dlBtn("bcf", t("export.bcfFile"))}
        ${opt("data-bcf-pass", t("export.includePass"))}</div>
      <div class="exp-item"><div class="exp-cap">${t("export.ifc")}</div>
        ${dlBtn("ifc", hasIfc ? base + "_export.ifc" : t("common.notAvailable"), hasIfc)}
        ${opt("data-ifc-pset", t("export.optPset"), true)}
        ${opt("data-ifc-sub", t("export.optSubmeshes"), true)}</div>
      <div class="exp-item"><div class="exp-cap">${t("export.glb")}</div>
        ${dlBtn("glb", hasGlb ? base + "_schaleinlagen.glb" : t("common.notAvailable"), hasGlb)}</div>
    </div>
  `;
  const passCb = dl.querySelector("[data-bcf-pass]") as HTMLInputElement | null;
  const psetCb = dl.querySelector("[data-ifc-pset]") as HTMLInputElement | null;
  const subCb = dl.querySelector("[data-ifc-sub]") as HTMLInputElement | null;
  const kennCb = dl.querySelector("[data-pdf-kennwerte]") as HTMLInputElement | null;
  dl.querySelectorAll<HTMLButtonElement>(".export-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const fmt = btn.dataset.fmt;
      if (fmt === "json") {
        downloadBlob(`${base}_pruefprotokoll.json`, JSON.stringify(result, null, 2), "application/json");
      } else if (fmt === "pdf") {
        const includeKenn = kennCb ? kennCb.checked : true;
        void exportPdfReport(result, base, viewer ? (o) => viewer.captureIssueSnapshot(o) : undefined, filename, includeKenn);
      } else if (fmt === "csv") {
        downloadBlob(`${base}_pruefprotokoll.csv`, "﻿" + buildCsv(result), "text/csv");
      } else if (fmt === "bcf") {
        showBusy("BCF wird erzeugt …");
        await nextFrame();
        try {
          const snapshot = viewer
            ? makeViewerSnapshotProvider((o) => viewer.captureIssueSnapshot(o), { width: 1280, height: 720 }, (iss) => buildDimensionAnnotation(iss))
            : undefined;
          const zip = buildBcfZip(result, `${base}.ifc`, { includePass: !!passCb?.checked, snapshot });
          if (!zip || zip.length === 0) throw new Error("BCF-Export leer (0 Bytes)");
          downloadBlob(`${base}_befunde.bcf`, zip as unknown as BlobPart, "application/octet-stream");
        } catch (e) {
          // Fehler SICHTBAR machen (statt still in der Konsole), damit klar ist,
          // warum der BCF-Export nicht funktioniert.
          console.error("[bcf] Export fehlgeschlagen:", e);
          alert(`BCF-Export fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          hideBusy();
        }
      } else if (fmt === "ifc") {
        const pset = psetCb ? psetCb.checked : true;
        const submeshes = subCb ? subCb.checked : true;
        const opts = { pset, submeshes, pruefung: pset };
        const exportIfc = (window as Window & {
          ndExportIfc?: (o: { pset: boolean; submeshes: boolean; pruefung: boolean }) => Promise<string>;
        }).ndExportIfc;
        showBusy("IFC wird erzeugt …");
        await nextFrame();
        try {
          const b64 = exportIfc ? await exportIfc(opts) : (result.ifc_bytes_b64 || "");
          if (b64) {
            downloadBlob(`${base}_export.ifc`, b64ToUint8(b64) as unknown as BlobPart, "application/x-step");
          }
        } finally {
          hideBusy();
        }
      } else if (fmt === "glb" && result.glb_bytes_b64) {
        downloadBlob(`${base}_schaleinlagen.glb`, b64ToUint8(result.glb_bytes_b64) as unknown as BlobPart, "model/gltf-binary");
      }
    });
  });
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function num(v: unknown, n = 3): string {
  if (typeof v !== "number" || !isFinite(v)) return "–";
  return v.toFixed(n);
}

// Szenenweite Erd-Seiten-Klasse (result.scene.earth_side_class). showResult()
// setzt sie pro Render; alle cls-Label-Pfade (Legende, Layer-Style-Popover,
// Element-Inspektor) lesen sie über clsLabel(), damit K4/K5 konsistent in
// „Seitenfläche (Erd)/(Luft)" umbenannt werden — aber NUR wenn eindeutig.
let currentEarthSideClass: "K4" | "K5" | null = null;

// i18n-aware Anzeigename einer Klasse. Für K4/K5 wird – sofern die Szene eine
// eindeutige Erdseite meldet – die als Erd markierte Klasse zu „… (Erd)", die
// Gegenseite zu „… (Luft)" umbenannt; sonst bleibt das neutrale „+/−"-Label.
function clsLabel(key: string): string {
  if (currentEarthSideClass && (key === "K4" || key === "K5")) {
    return key === currentEarthSideClass ? t("cls.sideEarth") : t("cls.sideAir");
  }
  return t(`cls.${key}`);
}

// Footer-Tally: zählt GRUPPIERTE Befunde (berührende Elemente + gleiche
// Regel+Status = EIN Befund), nicht die rohen Pro-Wand-Checks. So zeigt der
// Footer dieselbe reduzierte Zahl wie die gruppierte Regel-Anzeige.
function tallyPruefung(result: DetectionResult): { pass: number; fail: number; warn: number; info: number } {
  let pass = 0, fail = 0, warn = 0, info = 0;
  for (const c of groupedComponents(result)) {
    for (const f of c.findings) {
      if (f.status === "PASS") pass++;
      else if (f.status === "FAIL") fail++;
      else if (f.status === "WARN") warn++;
      else info++;
    }
  }
  return { pass, fail, warn, info };
}

// Status-Chip für eine Regelkarte/Befund. Farbe + Glyph je Status; der TEXT
// kommt übersetzt aus statusLabel(). INFO bekommt eine eigene (blaue/neutrale)
// Farbe — NICHT rot/gelb wie FAIL/WARN. Ein optionaler `reason` (z.B.
// context_reason/note) wird als Tooltip an den Chip gehängt.
function statusChip(s: RuleCheck["status"], reason?: string): string {
  const map: Record<string, [string, string]> = {
    PASS: ["✓", "var(--success)"],
    FAIL: ["✗", "var(--error)"],
    WARN: ["!", "var(--warning)"],
    INFO: ["ⓘ", "var(--info)"],
    SKIP: ["–", "var(--text-mute)"],
  };
  const [glyph, col] = map[s] || map.INFO;
  const lbl = statusLabel(s);
  const title = reason ? ` title="${escape(reason)}"` : "";
  return `<span class="status-chip s-${String(s).toLowerCase()}"${title} style="color:${col};font-weight:600;font-family:var(--font-mono);font-size:10.5px">${glyph} ${escape(lbl)}</span>`;
}

// ---- Confidence-Ampel ----------------------------------------------------- //
// Map an Ampel level to a colour token + glyph. confidence.py emits
// "hoch"/"mittel"/"niedrig"/"unbekannt".
function confColor(level: string | undefined): string {
  switch (level) {
    case "hoch": return "var(--success)";
    case "mittel": return "var(--warning)";
    case "niedrig": return "var(--error)";
    default: return "var(--text-mute)";
  }
}

// A compact inline confidence badge for a single key value. Shows a coloured
// dot + score; the title/tooltip carries the full `basis` explanation.
function confBadge(entry: ConfidenceEntry | undefined): string {
  if (!entry) return "";
  const col = confColor(entry.level);
  const score = typeof entry.score === "number" && isFinite(entry.score)
    ? entry.score.toFixed(2) : "–";
  const lvl = entry.level || "unbekannt";
  const basis = entry.basis || "";
  return `<span class="conf-badge" title="${escape(basis)}" style="--cf:${col}">`
    + `<span class="conf-dot"></span><span class="conf-lvl">${escape(lvl)}</span>`
    + `<span class="conf-score">${score}</span></span>`;
}

// A KPI row that carries an inline confidence badge after the value.
function rConf(lbl: string, v: string, u: string, entry: ConfidenceEntry | undefined): string {
  const unit = u ? " " + escape(u) : "";
  return `<div class="kpi-row"><span>${escape(lbl)}</span>`
    + `<span>${escape(v)}${unit} ${confBadge(entry)}</span></div>`;
}

// Compact confidence overview: one badge per group.
function renderConfidenceOverview(conf: WallMetrics["confidence"]): string {
  if (!conf) return "";
  const order: Array<[keyof NonNullable<WallMetrics["confidence"]>, string]> = [
    ["overall", t("conf.overall")],
    ["classification", t("conf.classification")],
    ["crown_width", t("conf.crownWidth")],
    ["thickness", t("conf.thickness")],
    ["slope", t("conf.slope")],
    ["volume", t("conf.volume")],
    ["niches", t("conf.niches")],
  ];
  const rows = order
    .filter(([k]) => !!conf[k])
    .map(([k, lbl]) =>
      `<div class="kpi-row"><span>${escape(lbl)}</span><span>${confBadge(conf[k] as ConfidenceEntry)}</span></div>`)
    .join("");
  // Watertight-Hinweis: ist das Mesh nicht wasserdicht/repariert, deckelt der
  // Dämpfer JEDE Confidence auf ≤ 0.6 — das hier sichtbar machen, damit ein
  // tiefer Score erklärbar ist (statt „grundlos").
  const sig = (conf._signals || {}) as Record<string, unknown>;
  const wt = Number(sig.watertight_damper);
  const wtWarn = isFinite(wt) && wt < 1.0
    ? `<div class="kpi-row"><span style="color:var(--warning)">⚠ ${escape(t("conf.watertightCapped"))}</span><span></span></div>`
    : "";
  if (!rows && !wtWarn) return "";
  return `<details class="conf-overview" style="margin-top:8px">
    <summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("conf.overview"))} ${confBadge(conf.overall)}</summary>
    ${wtWarn}
    ${rows}
  </details>`;
}

// Fundament-artige IFC-Typen, die ein tragendes Fundament der Wand sein können.
const FOUNDATION_TYPE_RE = /(IfcFooting|IfcSlab|IfcBeam|Foundation|Fundament)/i;

// Ein einzelner L5-Nachbar (Element der context.neighbors-Liste).
type Neighbor = NonNullable<NonNullable<WallMetrics["context"]>["neighbors"]>[number];

// Aus den L5-Nachbarn den tragenden Fundament-Nachbarn wählen: geteilte FLÄCHE
// + fundament-artiger Typ + HÖCHSTE containment_self (Wand-Unterseite getragen).
// Liefert null, wenn kein passender Nachbar existiert.
function pickFoundationNeighbor(wm: WallMetrics): Neighbor | null {
  const ns = wm.context?.neighbors || [];
  let best: Neighbor | null = null;
  for (const n of ns) {
    if (n.level !== "face") continue;
    if (!FOUNDATION_TYPE_RE.test(n.other_type || "")) continue;
    if (!n.other_guid) continue;
    const cs = typeof n.containment_self === "number" ? n.containment_self : -1;
    const bestCs = best && typeof best.containment_self === "number" ? best.containment_self : -1;
    if (!best || cs > bestCs) best = n;
  }
  return best;
}

// ---- L5 internal context -------------------------------------------------- //
function renderL5(wm: WallMetrics): string {
  const ci = wm.context?.internal;
  // Fundament-Link auch ohne internal-Kontext zeigen, falls ein Nachbar passt.
  const fund = pickFoundationNeighbor(wm);
  const fundRow = fund
    ? `<div class="kpi-row"><span>${escape(t("l5.foundationLink"))}</span>`
      + `<a href="#" class="fund-link" data-fund-guid="${escape(fund.other_guid || "")}" `
      + `style="color:var(--accent);cursor:pointer;text-decoration:none">`
      + `${escape(fund.other_name || fund.other_type || fund.other_guid || t("common.dash"))} ↗</a></div>`
    : "";
  if (!ci) {
    // Kein interner Kontext, aber ein Fundament-Nachbar → nur den Link zeigen.
    if (!fundRow) return "";
    return `<details class="lvl-block" style="margin-top:8px" open><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l5.title"))}</summary>${fundRow}</details>`;
  }
  const yn = (v: boolean | null | undefined) =>
    v === true ? t("common.yes") : v === false ? t("common.no") : t("common.dash");
  const rows = [
    fundRow,
    `<div class="kpi-row"><span>${t("l5.foundationPresent")}</span><span>${yn(ci.foundation_present)}</span></div>`,
    `<div class="kpi-row"><span>${t("l5.source")}</span><span>${escape(ci.source || t("common.dash"))}</span></div>`,
    `<div class="kpi-row"><span>${t("l5.overhangLeft")}</span><span>${num(ci.foundation_overhang_left_m ?? undefined)} m</span></div>`,
    `<div class="kpi-row"><span>${t("l5.overhangRight")}</span><span>${num(ci.foundation_overhang_right_m ?? undefined)} m</span></div>`,
    `<div class="kpi-row"><span>${t("l5.stemCentered")}</span><span>${yn(ci.stem_centered_on_foundation)}</span></div>`,
    `<div class="kpi-row"><span>${t("l5.volumeRatio")}</span><span>${num(ci.foundation_to_stem_volume_ratio ?? undefined, 2)}</span></div>`,
  ].join("");
  return `<details class="lvl-block" style="margin-top:8px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l5.title"))}</summary>${rows}</details>`;
}

// ---- L5 geometrische Nachbarn (geteilte Fläche/Kante/Punkt) --------------- //
function renderNeighbors(wm: WallMetrics): string {
  const ns = wm.context?.neighbors;
  if (!ns || !ns.length) return "";
  const lvl = (v?: string) =>
    v === "face" ? t("adj.levelFace")
      : v === "edge" ? t("adj.levelEdge")
        : v === "point" ? t("adj.levelPoint") : t("common.dash");
  const rows = ns.map((n) => {
    const nm = escape(n.other_name || n.other_type || n.other_guid || t("common.dash"));
    const det = n.level === "face"
      ? ` · ${num(n.shared_area_m2 ?? undefined, 2)} m² · ${t("adj.containment")} ${
        typeof n.containment_self === "number" ? Math.round(n.containment_self * 100) + "%" : t("common.dash")}`
      : "";
    return `<div class="kpi-row"><span>${nm}</span><span>${lvl(n.level)}${det}</span></div>`;
  }).join("");
  return `<details class="lvl-block" style="margin-top:8px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("adj.title", { n: ns.length }))}</summary>${rows}</details>`;
}

// ---- L6 external context -------------------------------------------------- //
function renderL6(wm: WallMetrics): string {
  const ce = wm.context?.external;
  if (!ce) return "";
  // Luft-/Erdseite mit Klasse + (Erd/Luft)-Anzeigename, damit der Bezug auf die
  // Legende klar ist. Quelle (side_source) + Eindeutigkeit (side_clear) klein dazu.
  const sideVal = (cl: string | null | undefined) =>
    cl ? `${escape(cl)} · ${escape(clsLabel(cl))}` : t("common.dash");
  const sideClearMark = ce.side_clear === true ? ` · ${escape(t("l6.sideClear"))}` : "";
  const rows = [
    `<div class="kpi-row"><span>${t("l6.airSideClass")}</span><span>${sideVal(ce.air_side_face_class)}</span></div>`,
    `<div class="kpi-row"><span>${t("l6.earthSideClass")}</span><span>${sideVal(ce.earth_side_face_class)}${sideClearMark}</span></div>`,
    `<div class="kpi-row"><span>${t("l6.sideSource")}</span><span style="color:var(--text-mute);font-size:10.5px">${escape(ce.side_source || t("common.dash"))}</span></div>`,
    `<div class="kpi-row"><span>${t("l6.terrainPresent")}</span><span>${ce.terrain_present === true ? t("common.yes") : ce.terrain_present === false ? t("common.no") : t("common.dash")}</span></div>`,
    `<div class="kpi-row"><span>${t("l6.source")}</span><span>${escape(ce.classification_source || t("common.dash"))}</span></div>`,
    `<div class="kpi-row"><span>${t("l6.medianAir")}</span><span>${num(ce.terrain_median_distance_air_m ?? undefined)} m</span></div>`,
    `<div class="kpi-row"><span>${t("l6.medianEarth")}</span><span>${num(ce.terrain_median_distance_earth_m ?? undefined)} m</span></div>`,
  ].join("");
  return `<details class="lvl-block" style="margin-top:8px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l6.title"))}</summary>${rows}</details>`;
}

// ---- L7 per-wall embed depth (UK unter Terrain) --------------------------- //
// Einbindetiefe der Wand-Unterkante unter Terrain aus external.uk_below_terrain_*.
// Per-Wand (gehört in den Element-Block, nicht in die szenenweite L7-Tabelle).
function renderEmbedDepth(wm: WallMetrics): string {
  const ce = wm.context?.external;
  if (!ce) return "";
  const lo = ce.uk_below_terrain_min_m;
  const hi = ce.uk_below_terrain_max_m;
  // Nur zeigen, wenn mindestens ein Wert bestimmt wurde.
  if (typeof lo !== "number" && typeof hi !== "number") return "";
  const a = num(lo ?? undefined, 2), b = num(hi ?? undefined, 2);
  const rng = a === b ? `${a} m` : `${a}–${b} m`;
  return `<div class="kpi-row"><span>${escape(t("l7.embedDepth"))}</span><span>${rng}</span></div>`;
}

// ---- L7 scene distances --------------------------------------------------- //
function renderL7Distances(result: DetectionResult): string {
  const raw = result.scene ? result.scene.distances : undefined;
  // `null` = the worker deferred the L7 pass and it is still running in the
  // background; `[]`/empty = computed, no neighbouring elements.
  if (raw === null) {
    return `<details class="lvl-block" style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l7.title", { n: 0 }))}</summary><div class="empty" style="font-size:11px">${escape(t("l7.computing"))}</div></details>`;
  }
  const dists: DistanceRecord[] = raw || [];
  if (!dists.length) {
    return `<details class="lvl-block" style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l7.title", { n: 0 }))}</summary><div class="empty" style="font-size:11px">${escape(t("l7.empty"))}</div></details>`;
  }
  const cell = (v: number | null | undefined) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(3) : "n/a";
  const rows = dists.map((d) => `
    <tr>
      <td>${escape(d.from_name || "–")}<br><span style="color:var(--text-mute);font-size:9.5px">${escape(d.from_type || "")}</span></td>
      <td>${escape(d.to_name || "–")}<br><span style="color:var(--text-mute);font-size:9.5px">${escape(d.to_type || "")}</span></td>
      <td class="val">${cell(d.min_distance_m)}</td>
      <td class="val">${cell(d.horizontal_distance_m)}</td>
      <td class="val">${cell(d.vertical_distance_m)}</td>
    </tr>`).join("");
  return `<details class="lvl-block" style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-secondary);font-size:11px">${escape(t("l7.title", { n: dists.length }))}</summary>
    <table class="rule-table dist-table"><thead><tr><th>${t("l7.colFrom")}</th><th>${t("l7.colTo")}</th><th>${t("l7.colMin")}</th><th>${t("l7.colHoriz")}</th><th>${t("l7.colVert")}</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}

function renderKenngroessen(result: DetectionResult): string {
  const wms = result.wall_metrics || [];
  if (wms.length === 0) {
    return `<div class="empty">${escape(t("kpi.noMetrics"))}</div>`;
  }
  // Kenngrössen = AGGREGAT-Ansicht: nur die gruppierte Regelvalidierung + L7-
  // Distanzen + Timings. Die Pro-Element-Werte (Volumen, Wandstärke, …) stehen
  // ausschliesslich im Element-Inspektor (keine Doppelung mehr).
  return finishKenngroessen(result, renderGroupedRules(result));
}

// Status-Reihenfolge: Nicht bestanden (FAIL) > Warnung (WARN) > Info (INFO) >
// Übersprungen (SKIP) > Bestanden (PASS). INFO ist KEIN Befund, wird aber vor
// den unauffälligen Status (SKIP/PASS) einsortiert, damit Hinweise sichtbar
// bleiben.
function statusRank(s: string): number {
  return { FAIL: 0, WARN: 1, INFO: 2, SKIP: 3, PASS: 4 }[s as "FAIL"] ?? 5;
}

// Berührende Volumenelemente (L7-Distanz ≈ 0) zu Komponenten verbinden und pro
// Komponente identische Befunde (gleiche Regel + gleicher Status) bündeln.
// Genutzt von der gruppierten Regel-Anzeige UND vom Footer-Tally → beide zeigen
// dieselbe reduzierte Befund-Zahl.
const TOUCH_TOL_M = 0.005;
type GroupedFinding = { label: string; status: RuleCheck["status"]; soll: string; members: { name: string; guid: string; value: string }[] };
type GroupedComp = { members: WallMetrics[]; findings: GroupedFinding[] };

function groupedComponents(result: DetectionResult): GroupedComp[] {
  const wms = (result.wall_metrics || []).filter(
    (w) => !w.prep_failed && !w.error && !!w.element_guid,
  );
  if (wms.length === 0) return [];
  // Union-Find über element_guid via L7-Berührung (min_distance < TOUCH_TOL_M).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (x !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  for (const w of wms) parent.set(w.element_guid!, w.element_guid!);
  const dists = result.scene?.distances ?? null;
  if (dists) {
    for (const d of dists) {
      const a = d.from_guid, b = d.to_guid;
      if (a && b && parent.has(a) && parent.has(b)
          && typeof d.min_distance_m === "number" && d.min_distance_m < TOUCH_TOL_M) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const comps = new Map<string, WallMetrics[]>();
  for (const w of wms) {
    const root = find(w.element_guid!);
    (comps.get(root) ?? comps.set(root, []).get(root)!).push(w);
  }
  const out: GroupedComp[] = [];
  comps.forEach((members) => {
    const groups = new Map<string, GroupedFinding>();
    for (const w of members) {
      for (const ch of (w.pruefung || [])) {
        const key = `${ch.id || ch.label}__${ch.status}`;
        let f = groups.get(key);
        if (!f) { f = { label: ch.label, status: ch.status, soll: fmtRuleSoll(ch.id, ch.soll), members: [] }; groups.set(key, f); }
        f.members.push({ name: w.element_name || "?", guid: w.element_guid || "", value: fmtRuleValue(ch.id, ch.value, ch.einheit) });
      }
    }
    if (groups.size > 0) out.push({ members, findings: Array.from(groups.values()) });
  });
  return out;
}

function renderGroupedRules(result: DetectionResult): string {
  const hdr = (sub: string) =>
    `<h5 style="margin:12px 0 4px;font-size:11px;color:var(--text-secondary)">${escape(t("kpi.astraRulesGrouped"))}${sub}</h5>`;
  const totalChecks = (result.wall_metrics || [])
    .filter((w) => !w.prep_failed && !w.error && !!w.element_guid)
    .reduce((n, w) => n + (w.pruefung?.length || 0), 0);
  if (totalChecks === 0) return hdr("") + `<div class="empty">${escape(t("kpi.noRules"))}</div>`;
  const comps = groupedComponents(result);
  let groupedCount = 0;
  const compHtml = comps.map((c) => {
    groupedCount += c.findings.length;
    const rows = c.findings.slice()
      .sort((a, b) => statusRank(a.status) - statusRank(b.status))
      .map((f) => {
        const memList = f.members
          .map((m) => `<div class="kpi-row"><span>${escape(m.name)}${m.guid ? `<br><code style="font-size:9px;color:var(--text-mute)">${escape(m.guid)}</code>` : ""}</span><span>${escape(m.value)}</span></div>`)
          .join("");
        return `<details style="margin:2px 0"><summary style="cursor:pointer;font-size:12px;padding:2px 0">${statusChip(f.status)} <b>${escape(f.label)}</b> · ${f.members.length}× · <span style="color:var(--text-mute)">${escape(f.soll)}</span></summary><div style="padding-left:10px">${memList}</div></details>`;
      }).join("");
    const repName = c.members[0].element_name || "?";
    const title = c.members.length > 1
      ? `${escape(repName)} <span style="color:var(--text-mute)">· ${t("kpi.groupTouching", { n: c.members.length })}</span>`
      : escape(repName);
    return { size: c.members.length, html: `<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--accent);margin:6px 0 2px">${title}</div>${rows}</div>` };
  });
  compHtml.sort((a, b) => b.size - a.size);
  const note = (result.scene?.distances ?? null) ? "" : `<div class="empty">${escape(t("kpi.groupComputing"))}</div>`;
  const sub = ` <span style="color:var(--text-mute);font-weight:400">(${groupedCount} / ${totalChecks})</span>`;
  return hdr(sub) + note + compHtml.map((c) => c.html).join("");
}

// Per-Wand-Kennwert-Block (alle Werte: Volumen, Wandstärke, Anzug/Gefälle,
// Nischen, Flächen je Klasse K0–K6, Confidence, Kontext L5/L6, ASTRA-Regeln).
// Aus renderKenngroessen extrahiert, damit der Element-Inspektor exakt dieselbe
// vollständige Darstellung für EIN Element nutzen kann.
export function renderWallBlock(wm: WallMetrics, includeRules = true): string {
    if (wm.error || wm.prep_failed) {
      const reason = wm.prep_failure_reason || wm.error || t("kpi.reasonUnknown");
      return `<div class="kpi-block"><h4>${escape(wm.element_name || t("kpi.wallFallback"))}</h4>
        <div class="kpi-row"><span>${t("kpi.meshPrep")}</span><span style="color:var(--warning)">${escape(t("kpi.skipped", { reason: String(reason) }))}</span></div></div>`;
    }
    const dims = wm.dimensions || {};
    const thk = wm.thickness || {};
    const batter = wm.batter || {};
    const slope = wm.slope || {};
    const niches = wm.niches || {};
    const apc = wm.area_per_class || {};
    const conf = wm.confidence;
    const thNiche = wm.thickness_at_niche || {};
    const rows: string[] = [];
    const r = (lbl: string, v: string, u = "") =>
      `<div class="kpi-row"><span>${escape(lbl)}</span><span>${escape(v)}${u ? " " + escape(u) : ""}</span></div>`;
    // Core values carry a confidence-Ampel badge (volume/crown_width/thickness/slope).
    rows.push(r(t("kpi.volume"), num(wm.volume_m3), "m³"));
    rows.push(r(t("kpi.surface"), num(wm.surface_area_m2), "m²"));
    rows.push(r(t("kpi.length"), num(dims.length), "m"));
    rows.push(r(t("kpi.height"), num(dims.height), "m"));
    rows.push(r(t("kpi.nominalThickness"), num(dims.nominal_thickness), "m"));
    // Masse mit Streuung als kompakte, AUSKLAPPBARE „von–bis"-Gruppen: die
    // Zusammenfassung zeigt min–max, beim Aufklappen min/⌀/max (+ Median/Kanten).
    // Hält den Block übersichtlich und das ⌀-Symbol durchgängig einheitlich.
    const stat = (lbl: string, v: unknown) => r(lbl, num(v as number), "m");
    // Wert nach REGEL-Status einfärben (grün/rot/orange), wenn eine Regel genau
    // diesen Wert prüft; sonst neutral. Ersetzt die per-Wert-Confidence-Ampel —
    // der Confidence-Score steht weiterhin gesammelt unten in der Übersicht.
    const ruleColor = (ruleId: string): string => {
      const ch = (wm.pruefung || []).find((c) => c.id === ruleId);
      if (!ch) return "";
      return ch.status === "PASS" ? "var(--success)"
        : ch.status === "FAIL" ? "var(--error)"
          : ch.status === "WARN" ? "var(--warning)" : "";   // INFO/SKIP → neutral
    };
    const rRule = (lbl: string, v: string, u: string, ruleId: string): string => {
      const col = ruleColor(ruleId);
      const unit = u ? " " + escape(u) : "";
      const vs = col ? `<span style="color:${col};font-weight:600">${escape(v)}${unit}</span>` : `${escape(v)}${unit}`;
      return `<div class="kpi-row"><span>${escape(lbl)}</span><span>${vs}</span></div>`;
    };
    const rangeGroup = (label: string, lo: unknown, hi: unknown, detail: string, badge = "", valColor = ""): string => {
      const a = num(lo as number), b = num(hi as number);
      const rng = (a === "–" && b === "–") ? "–" : `${a}–${b} m`;
      const rngSpan = valColor ? `<span style="color:${valColor};font-weight:600">${rng}</span>` : rng;
      return `<details class="kpi-group"><summary class="kpi-row" style="cursor:pointer">`
        + `<span>${escape(label)}</span><span>${rngSpan}${badge ? " " + badge : ""}</span></summary>`
        + `<div>${detail}</div></details>`;
    };
    rows.push(rangeGroup(t("kpi.thickness"), thk.min, thk.max,
      stat("min", thk.min) + stat("⌀", thk.avg) + stat("max", thk.max),
      "", ruleColor("wall_min_nominal_thickness")));
    const hl = (dims.height_local || {}) as Record<string, unknown>;
    rows.push(rangeGroup(t("kpi.heightLocal"), hl.min, hl.max,
      stat("min", hl.min) + stat("⌀", hl.avg) + stat("max", hl.max) + stat("Median", hl.median)));
    const dl = (dims.developed_length || {}) as Record<string, unknown>;
    rows.push(rangeGroup(t("kpi.devLength"), dl.min, dl.max,
      stat("min", dl.min) + stat("⌀", dl.avg) + stat("max", dl.max)
      + r(t("kpi.edgeFrontTop"), num(dl.front_top as number), "m")
      + r(t("kpi.edgeFrontBottom"), num(dl.front_bottom as number), "m")
      + r(t("kpi.edgeBackTop"), num(dl.back_top as number), "m")
      + r(t("kpi.edgeBackBottom"), num(dl.back_bottom as number), "m")));
    // Restwandstärke an Nische — SPA runtime key is thickness_at_niche.min_global.
    rows.push(r(t("kpi.residualThickness"), num((thNiche as Record<string, number>).min_global), "m"));
    // Anzug-Verhältnis aus DEMSELBEN front_deg ableiten, das daneben in Grad
    // steht (1:n = 1/tan(Winkel)) — so sind Winkel und Verhältnis garantiert
    // konsistent (kein unabhängiges Runden zweier Quellen). Winkel mit 2 Dezimalen.
    // Anzug-Verhältnis als n:1 (Vertikal:Horizontal), ganzzahlig wenn möglich
    // (z.B. 5:1), sonst 1 Dezimale — kein Dezimalwert, kein 1:n.
    const ratioFromDeg = (v: unknown) => {
      const d = Number(v);
      if (!isFinite(d)) return "–";
      const tnd = Math.tan(Math.abs(d) * Math.PI / 180);
      if (tnd < 1e-9) return "∞:1";
      const n = 1 / tnd;
      const ns = Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
      return ns + ":1";
    };
    // Quergefälle (Krone/Fundament) in PROZENT — wie die Regel crown_slope_against_hill
    // (Soll in %) und konsistent mit dem Längsgefälle. Umrechnung Grad → % via tan.
    const pctFromDeg = (v: unknown) => {
      const d = Number(v);
      if (!isFinite(d)) return "–";
      return String(Number((Math.tan(Math.abs(d) * Math.PI / 180) * 100).toFixed(1)));
    };
    const bt = batter as Record<string, unknown>;
    rows.push(rRule(t("kpi.batterFrontRatio"), ratioFromDeg(bt.front_deg), "", "anzug_max"));
    rows.push(rRule(t("kpi.batterFront"), num(bt.front_deg as number, 2), "°", "anzug_max"));
    rows.push(r(t("kpi.batterBackRatio"), ratioFromDeg(bt.back_deg)));
    rows.push(r(t("kpi.batterBack"), num(bt.back_deg as number, 2), "°"));
    rows.push(rRule(t("kpi.slopeCrown"), pctFromDeg((slope as Record<string, number>).crown_deg), "%", "crown_slope_against_hill"));
    rows.push(r(t("kpi.slopeFoundation"), pctFromDeg((slope as Record<string, number>).foundation_deg), "%"));
    // Längsgefälle (Krone/Fundament) — neben dem Quergefälle.
    rows.push(r(t("kpi.longSlopeCrown"), num((slope as Record<string, number>).crown_longitudinal_deg, 2), "°"));
    rows.push(r(t("kpi.longSlopeCrown"), num((slope as Record<string, number>).crown_longitudinal_percent, 1), "%"));
    rows.push(r(t("kpi.longSlopeFoundation"), num((slope as Record<string, number>).foundation_longitudinal_deg, 2), "°"));
    rows.push(r(t("kpi.longSlopeFoundation"), num((slope as Record<string, number>).foundation_longitudinal_percent, 1), "%"));
    rows.push(r(t("kpi.nicheCount"), String((niches as Record<string, number>).count ?? 0), ""));
    rows.push(r(t("kpi.nicheVolume"), num((niches as Record<string, number>).total_volume_m3), "m³"));
    // Per-class area (only show K0..K6 keys that have values)
    const classRows = (["K0","K1","K2","K3","K4","K5","K6"] as const)
      .filter((k) => typeof apc[k] === "number")
      .map((k) => r(t("kpi.area") + " " + k, num(apc[k] as number, 2), "m²")).join("");

    // L4 ASTRA-Regeln als klar getrennte, KLICKBARE Karten (wie geführter
    // Modus). Klick lädt die volle BCF-Ansicht. KEINE Quelle mehr im Viewer.
    const checks = wm.pruefung || [];
    const guidAttr = escape(wm.element_guid || "");
    const ruleCards = checks.map((ch) => `
      <div class="rule-card" data-rule-id="${escape(ch.id)}" data-el-guid="${guidAttr}"
           title="${escape(t("kpi.loadBcf"))}"
           style="border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:6px 8px;margin:4px 0;cursor:pointer;transition:border-color .12s">
        <div style="display:flex;align-items:center;gap:8px">
          ${statusChip(ch.status, ch.context_reason || ch.note)}<b style="font-size:12px">${escape(ch.label)}</b>
          <span style="margin-left:auto;color:var(--text-mute);font-size:10.5px">↪ BCF</span>
        </div>
        <div style="font-size:11px;color:var(--text-mute);margin-top:2px">
          ${escape(t("kpi.colIst"))}: ${escape(fmtRuleValue(ch.id, ch.value, ch.einheit))} · ${escape(t("kpi.colSoll"))}: ${escape(fmtRuleSoll(ch.id, ch.soll))}
        </div>
      </div>`).join("");

    const head = `<h4 style="margin:6px 0 4px;font-size:12px;color:var(--accent)">${escape(wm.element_name || t("kpi.wallFallback"))} ${confBadge(conf?.overall)}</h4>`;
    return `<div class="kpi-block">
      ${head}
      ${rows.join("")}
      ${classRows}
      ${renderConfidenceOverview(conf)}
      ${renderL5(wm)}
      ${renderNeighbors(wm)}
      ${renderL6(wm)}
      ${renderEmbedDepth(wm)}
      ${includeRules
        ? `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">`
          + `<h5 style="margin:0 0 4px;font-size:11px;color:var(--text-secondary)">${escape(t("kpi.astraRules"))}</h5>`
          + (ruleCards || `<div class="empty">${escape(t("kpi.noRules"))}</div>`)
          + `</div>`
        : ""}
    </div>`;
}

// L7-Distanzen (szenenweit, einmal) + Timings ans Ende der Kenngrössen.
function finishKenngroessen(result: DetectionResult, blocks: string): string {
  const l7 = renderL7Distances(result);
  const timingRows = Object.entries(result.timings || {})
    .map(([k, v]) =>
      `<div class="kpi-row"><span>${escape(k)}</span><span>${(v as number).toFixed(3)} s</span></div>`)
    .join("");
  const timings = timingRows
    ? `<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-mute);font-size:11px">${escape(t("kpi.timings"))}</summary>${timingRows}</details>`
    : "";
  return blocks + l7 + timings;
}

// Slim shared API so other UIs (the guided-mode inline ruleset selector in
// wizard.ts) can read/switch/import the active ruleset WITHOUT duplicating the
// activation+persist+rerun logic. All four routes drive the same state.
export type RulesetApi = {
  list: () => { value: string; label: string }[];
  current: () => string;
  activate: (value: string, rerun: boolean) => void;
  importText: (text: string, filename: string) => void;
  onChange: (cb: () => void) => void;
};
type RulesetGlobals = Window & {
  ndGetRuleset?: () => Ruleset;
  ndSetRuleset?: (rs: Ruleset) => void;
  ndRerunRuleset?: () => Promise<void>;
  ndRuleset?: RulesetApi;
};

// Active-ruleset context the inspector tracks locally. A built-in is read-only
// (origin: "builtin"); a saved ruleset is editable (origin: "saved"); a
// transient unsaved working copy (e.g. an imported file before naming, or an
// edit to a built-in) is origin: "scratch".
type ActiveCtx =
  | { origin: "builtin"; builtinKey: "astra_default" | "astra_plausi"; name: string; yaml: string }
  | { origin: "saved"; savedId: string; name: string; yaml: string }
  | { origin: "scratch"; name: string; yaml: string };

function wireRulesetSection(root: HTMLElement): void {
  const sel = root.querySelector("#ruleset_select") as HTMLSelectElement | null;
  const fileIn = root.querySelector("#ruleset_file") as HTMLInputElement | null;
  const ta = root.querySelector("#ruleset_yaml") as HTMLTextAreaElement | null;
  const apply = root.querySelector("#ruleset_apply") as HTMLButtonElement | null;
  const reset = root.querySelector("#ruleset_reset") as HTMLButtonElement | null;
  const err = root.querySelector("#ruleset_err") as HTMLElement | null;
  const prev = root.querySelector("#ruleset_preview") as HTMLElement | null;
  const cnt = root.querySelector("#ruleset_count") as HTMLElement | null;
  if (!sel || !fileIn || !ta || !apply || !reset || !err || !prev) return;

  // Builder form elements
  const fTarget = root.querySelector("#rb_target") as HTMLSelectElement;
  const fOp = root.querySelector("#rb_op") as HTMLSelectElement;
  const fThr = root.querySelector("#rb_threshold") as HTMLInputElement;
  const fTol = root.querySelector("#rb_tolerance") as HTMLInputElement;
  const fUnit = root.querySelector("#rb_unit") as HTMLElement;
  const fSev = root.querySelector("#rb_severity") as HTMLSelectElement;
  const fMinConf = root.querySelector("#rb_minconf") as HTMLInputElement;
  const fLabel = root.querySelector("#rb_label") as HTMLInputElement;
  const fApply = root.querySelector("#rb_apply") as HTMLButtonElement;
  const fCancel = root.querySelector("#rb_cancel") as HTMLButtonElement;
  const fErr = root.querySelector("#rb_err") as HTMLElement;
  // Management buttons
  const btnNew = root.querySelector("#rs_new") as HTMLButtonElement;
  const btnDup = root.querySelector("#rs_dup") as HTMLButtonElement;
  const btnRename = root.querySelector("#rs_rename") as HTMLButtonElement;
  const btnDelete = root.querySelector("#rs_delete") as HTMLButtonElement;
  const btnExport = root.querySelector("#rs_export") as HTMLButtonElement;
  const rsStatus = root.querySelector("#rs_status") as HTMLElement;

  const w = window as RulesetGlobals;
  const setErr = (m: string) => { err.textContent = m; };
  const setFErr = (m: string) => { fErr.textContent = m; };
  const setStatus = (m: string) => { if (rsStatus) rsStatus.textContent = m; };

  // ---- active-ruleset context -------------------------------------------- //
  let active: ActiveCtx = { origin: "builtin", builtinKey: "astra_default", name: BUILTIN_RULESETS.astra_default.label, yaml: BUILTIN_RULESETS.astra_default.yaml };
  let editingIdx: number | null = null; // builder edit mode: index in preview list
  // External UIs (guided-mode dropdown) register here to re-sync whenever the
  // active ruleset changes through any route.
  const externalSyncCbs: Array<() => void> = [];

  const isReadonly = () => active.origin === "builtin";

  // Populate the catalog <select> grouped by level (once).
  const buildTargetOptions = () => {
    const groups: Record<string, typeof TARGET_CATALOG> = { wall: [], context: [], scene: [] };
    for (const e of TARGET_CATALOG) groups[e.level].push(e);
    let html = "";
    for (const lvl of ["wall", "context", "scene"] as const) {
      const items = groups[lvl];
      if (!items.length) continue;
      const tag = lvl === "wall" ? "" : lvl === "context" ? " ⬡" : " ◆";
      html += `<optgroup label="${escape(TARGET_LEVEL_LABEL[lvl] + tag)}">`;
      for (const e of items) {
        const u = e.unit && e.unit !== "–" ? ` [${e.unit}]` : "";
        html += `<option value="${escape(e.target)}">${escape(e.label + u)}</option>`;
      }
      html += `</optgroup>`;
    }
    fTarget.innerHTML = html;
  };
  buildTargetOptions();

  // Operator <select>
  fOp.innerHTML = (Object.keys(OP_LABEL) as RuleOp[])
    .map((op) => `<option value="${op}">${OP_LABEL[op]}  (${op})</option>`)
    .join("");

  // Keep unit display + default label in sync with the chosen target.
  const refreshFormDefaults = () => {
    const entry = catalogEntryFor(fTarget.value);
    fUnit.textContent = entry && entry.unit !== "–" ? entry.unit : "";
    if (editingIdx === null) {
      // not editing: keep op at the catalog default and refresh the label hint
      if (entry) fOp.value = entry.defaultOp;
      const thr = parseFloat(fThr.value);
      fLabel.placeholder = defaultLabelFor(
        fTarget.value, fOp.value as RuleOp, isFinite(thr) ? thr : 0,
      );
    }
  };
  fTarget.addEventListener("change", refreshFormDefaults);
  fOp.addEventListener("change", () => { if (editingIdx === null) refreshFormDefaults(); });
  fThr.addEventListener("input", () => { if (editingIdx === null) refreshFormDefaults(); });
  refreshFormDefaults();

  // ---- preview / rule list (with Bearbeiten + Löschen) -------------------- //
  const renderPreview = (yaml: string) => {
    const list: RulePreview[] = previewRules(yaml);
    if (cnt) cnt.textContent = list.length === 1
      ? t("rules.countRule1", { n: list.length })
      : t("rules.countRules", { n: list.length });
    // Header-Button spiegelt das aktive Regelset (die Sektion ist nicht mehr
    // im rechten Panel — der Header ist die einzige Status-Anzeige dafür).
    const hdrName = root.querySelector("#hdr_ruleset_name");
    if (hdrName) hdrName.textContent = active.name;
    const ro = isReadonly();
    if (!list.length) {
      prev.innerHTML = `<div class="empty" style="font-size:11px">${escape(t("rules.emptyList"))}</div>`;
      return;
    }
    prev.innerHTML = list
      .map((r, i) => {
        const entry = catalogEntryFor(r.target);
        const human = entry ? entry.label : r.target;
        const opSym = (OP_LABEL as Record<string, string>)[r.op] || r.op;
        const sevCls = r.severity === "fail" ? "fail" : "warn";
        return `<div class="rb-rule">
          <div class="rb-rule-main">
            <span class="rb-rule-name">${escape(r.label || human)}</span>
            <span class="rb-rule-meta">${escape(human)} ${escape(opSym)} ${escape(r.threshold)}${entry && entry.unit !== "–" ? " " + escape(entry.unit) : ""}
              <i class="rb-sev rb-sev-${sevCls}">${escape(r.severity)}</i></span>
          </div>
          <div class="rb-rule-actions">
            <button class="rb-icon" data-rb-edit="${i}" title="${escape(ro ? t("rules.editTipRo") : t("rules.editTip"))}" ${ro ? "disabled" : ""}>✎</button>
            <button class="rb-icon rb-del" data-rb-del="${i}" title="${escape(ro ? t("rules.delTipRo") : t("rules.delTip"))}" ${ro ? "disabled" : ""}>✕</button>
          </div>
        </div>`;
      })
      .join("");

    prev.querySelectorAll<HTMLButtonElement>("[data-rb-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.rbDel!, 10);
        const next = removeRuleByIndex(active.yaml, idx);
        commitYaml(next, { rerun: true });
        if (editingIdx !== null) cancelEdit();
      });
    });
    prev.querySelectorAll<HTMLButtonElement>("[data-rb-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.rbEdit!, 10);
        loadRuleIntoForm(list[idx], idx);
      });
    });
  };

  // ---- ruleset <select> population --------------------------------------- //
  const rebuildRulesetSelect = () => {
    const saved = loadSavedRulesets();
    let html = `<optgroup label="${escape(t("rules.grpTemplates"))}">`;
    html += `<option value="b:astra_default">${escape(BUILTIN_RULESETS.astra_default.label)}</option>`;
    html += `<option value="b:astra_plausi">${escape(BUILTIN_RULESETS.astra_plausi.label)}</option>`;
    html += `</optgroup>`;
    if (saved.length) {
      html += `<optgroup label="${escape(t("rules.grpOwn"))}">`;
      for (const s of saved) html += `<option value="s:${s.id}">${escape(s.name)}</option>`;
      html += `</optgroup>`;
    }
    if (active.origin === "scratch") {
      html += `<optgroup label="${escape(t("rules.grpUnsaved"))}"><option value="scratch">${escape(active.name)} •</option></optgroup>`;
    }
    sel.innerHTML = html;
    // reflect current active selection
    if (active.origin === "builtin") sel.value = `b:${active.builtinKey}`;
    else if (active.origin === "saved") sel.value = `s:${active.savedId}`;
    else sel.value = "scratch";
    // Let external UIs (guided-mode dropdown) re-sync to the new active set.
    externalSyncCbs.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
  };

  // ---- push active ruleset into the worker pipeline ----------------------- //
  const pushActive = (rerun: boolean) => {
    const rs: Ruleset = { key: "custom", label: active.name, yaml: active.yaml };
    // Built-ins keep their real key so the rest of the app can detect them.
    if (active.origin === "builtin") {
      w.ndSetRuleset?.(BUILTIN_RULESETS[active.builtinKey]);
    } else {
      w.ndSetRuleset?.(rs);
    }
    if (rerun) w.ndRerunRuleset?.().catch((e) => setErr(String(e?.message || e)));
  };

  // Update active.yaml, persist if it's a saved ruleset, refresh UI + worker.
  const commitYaml = (yaml: string, opts: { rerun?: boolean } = {}) => {
    active.yaml = yaml;
    ta.value = yaml;
    if (active.origin === "saved") {
      updateSavedRuleset(active.savedId, { yaml });
      setStatus(t("rules.statSavedAuto", { name: active.name }));
    } else if (active.origin === "builtin") {
      setStatus(t("rules.statReadonly", { name: active.name }));
    } else {
      setStatus(t("rules.statUnsaved"));
    }
    renderPreview(yaml);
    pushActive(!!opts.rerun);
  };

  // ---- switch the active ruleset ----------------------------------------- //
  const activateBuiltin = (key: "astra_default" | "astra_plausi", rerun: boolean) => {
    const b = BUILTIN_RULESETS[key];
    active = { origin: "builtin", builtinKey: key, name: b.label, yaml: b.yaml };
    setActiveRulesetId(key);
    ta.value = b.yaml;
    setErr(""); setFErr("");
    cancelEdit();
    rebuildRulesetSelect();
    renderPreview(b.yaml);
    setStatus(t("rules.statTemplateActive"));
    pushActive(rerun);
  };
  const activateSaved = (id: string, rerun: boolean) => {
    const s = getSavedRuleset(id);
    if (!s) { activateBuiltin("astra_default", rerun); return; }
    active = { origin: "saved", savedId: s.id, name: s.name, yaml: s.yaml };
    setActiveRulesetId(s.id);
    ta.value = s.yaml;
    setErr(""); setFErr("");
    cancelEdit();
    rebuildRulesetSelect();
    renderPreview(s.yaml);
    setStatus(t("rules.statSavedActive", { name: s.name }));
    pushActive(rerun);
  };

  // ---- builder: add / edit a rule ---------------------------------------- //
  const cancelEdit = () => {
    editingIdx = null;
    fApply.textContent = t("rules.applyRule");
    fCancel.hidden = true;
    fLabel.value = "";
    fMinConf.value = "";
    fTol.value = "";
    setFErr("");
    refreshFormDefaults();
  };
  fCancel.addEventListener("click", cancelEdit);

  const loadRuleIntoForm = (r: RulePreview, idx: number) => {
    editingIdx = idx;
    // ensure the target exists as an option (custom targets from imported YAML)
    if (!catalogEntryFor(r.target) && r.target) {
      const opt = document.createElement("option");
      opt.value = r.target;
      opt.textContent = r.target + " (frei)";
      fTarget.appendChild(opt);
    }
    fTarget.value = r.target;
    fOp.value = (Object.keys(OP_LABEL) as string[]).includes(r.op) ? r.op : ">=";
    fThr.value = r.threshold;
    fTol.value = r.tolerance || "";
    fSev.value = r.severity === "fail" ? "fail" : "warn";
    fMinConf.value = r.min_confidence || "";
    fLabel.value = r.label || "";
    const entry = catalogEntryFor(r.target);
    fUnit.textContent = entry && entry.unit !== "–" ? entry.unit : (r.unit || "");
    fApply.textContent = t("rules.applyChange");
    fCancel.hidden = false;
    setFErr("");
    (root.querySelector("#rb_builder_wrap") as HTMLDetailsElement).open = true;
  };

  const onApplyRule = () => {
    setFErr("");
    if (isReadonly()) {
      setFErr(t("rules.errReadonly"));
      return;
    }
    const target = fTarget.value;
    if (!target) { setFErr(t("rules.errChooseTarget")); return; }
    const thrRaw = fThr.value.trim().replace(",", ".");
    const threshold = parseFloat(thrRaw);
    if (thrRaw === "" || !isFinite(threshold)) {
      setFErr(t("rules.errThresholdNum")); fThr.focus(); return;
    }
    const op = fOp.value as RuleOp;
    const severity = fSev.value as RuleSeverity;
    const entry = catalogEntryFor(target);
    const unit = entry ? entry.unit : "";
    // Optional Mindest-Confidence (0..1). Leeres Feld = aus.
    let minConfidence: number | null = null;
    const mcRaw = fMinConf.value.trim().replace(",", ".");
    if (mcRaw !== "") {
      const mc = parseFloat(mcRaw);
      if (!isFinite(mc) || mc < 0 || mc > 1) {
        setFErr(t("rules.errMinConfRange")); fMinConf.focus(); return;
      }
      minConfidence = mc;
    }
    // Optional Toleranzband (≥ 0). Nur bei op "==" sinnvoll; leer = exakt.
    let tolerance: number | null = null;
    const tolRaw = fTol.value.trim().replace(",", ".");
    if (tolRaw !== "") {
      const tv = parseFloat(tolRaw);
      if (!isFinite(tv) || tv < 0) {
        setFErr(t("rules.errToleranceRange")); fTol.focus(); return;
      }
      tolerance = tv;
    }
    let label = fLabel.value.trim();
    if (!label) label = defaultLabelFor(target, op, threshold);
    if (!label) { setFErr(t("rules.errLabelEmpty")); return; }

    const rule: BuilderRule = { id: "", label, target, op, threshold, unit, severity, minConfidence, tolerance };

    let next: string;
    if (editingIdx !== null) {
      // edit = remove the old block, append the rebuilt one
      const removed = removeRuleByIndex(active.yaml, editingIdx);
      const block = buildRuleYamlBlock(rule, removed);
      next = appendRuleToYaml(removed, block);
    } else {
      const block = buildRuleYamlBlock(rule, active.yaml);
      next = appendRuleToYaml(active.yaml, block);
    }
    const vmsg = quickValidateYaml(next);
    if (vmsg) { setFErr(vmsg); return; }
    commitYaml(next, { rerun: true });
    cancelEdit();
  };
  fApply.addEventListener("click", onApplyRule);

  // ---- management buttons ------------------------------------------------- //
  const promptName = (suggest: string): string | null => {
    const name = window.prompt(t("rules.promptName"), suggest);
    if (name === null) return null;
    return name.trim() || suggest;
  };

  btnNew.addEventListener("click", () => {
    const name = promptName(t("rules.suggestNew"));
    if (name === null) return;
    const yaml = `version: 1\nprofile: ${JSON.stringify(name)}\napplies_to: ["IfcWall"]\nrules:\n`;
    const rec = createSavedRuleset(name, yaml);
    activateSaved(rec.id, false);
    setStatus(t("rules.statNewCreated", { name }));
  });

  btnDup.addEventListener("click", () => {
    const base = active.name.replace(/\s*\(Kopie.*\)$/, "");
    const name = promptName(t("rules.suggestCopy", { base }));
    if (name === null) return;
    const src = active.origin === "builtin" ? active.builtinKey : undefined;
    const rec = createSavedRuleset(name, active.yaml, src);
    activateSaved(rec.id, false);
    setStatus(t("rules.statDuplicated", { name: active.name }));
  });

  btnRename.addEventListener("click", () => {
    if (active.origin !== "saved") {
      setStatus(t("rules.statOnlyOwnRename"));
      return;
    }
    const name = promptName(active.name);
    if (name === null) return;
    updateSavedRuleset(active.savedId, { name });
    active.name = name;
    rebuildRulesetSelect();
    pushActive(false);
    setStatus(t("rules.statRenamed", { name }));
  });

  btnDelete.addEventListener("click", () => {
    if (active.origin !== "saved") {
      setStatus(t("rules.statTemplatesNoDelete"));
      return;
    }
    if (!window.confirm(t("rules.confirmDelete", { name: active.name }))) return;
    deleteSavedRuleset(active.savedId);
    activateBuiltin("astra_default", false);
    setStatus(t("rules.statDeleted"));
  });

  btnExport.addEventListener("click", () => {
    const safe = active.name.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "regelset";
    downloadBlob(`${safe}.yaml`, active.yaml, "text/yaml");
  });

  // ---- active <select> change -------------------------------------------- //
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v.startsWith("b:")) activateBuiltin(v.slice(2) as "astra_default" | "astra_plausi", true);
    else if (v.startsWith("s:")) activateSaved(v.slice(2), true);
    // "scratch" stays as-is
  });

  // ---- import YAML file --------------------------------------------------- //
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    fileIn.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      const msg = quickValidateYaml(text);
      if (msg) { setStatus(t("rules.statImportRejected", { msg })); return; }
      const base = f.name.replace(/\.(ya?ml)$/i, "") || "Importiert";
      const rec = createSavedRuleset(base, text);
      activateSaved(rec.id, true);
      setStatus(t("rules.statImported", { file: f.name, base }));
    } catch (e) {
      setStatus(t("rules.statYamlUnreadable", { msg: (e as Error).message }));
    }
  });

  // ---- YAML editor: manual two-way edit ----------------------------------- //
  apply.addEventListener("click", () => {
    const text = ta.value;
    const msg = quickValidateYaml(text);
    if (msg) { setErr(msg); return; }
    setErr("");
    if (isReadonly()) {
      // editing a built-in: fork into a scratch ruleset so we never mutate it
      active = { origin: "scratch", name: t("rules.suffixEdited", { name: active.name }), yaml: text };
      setActiveRulesetId(null);
      rebuildRulesetSelect();
      setStatus(t("rules.statForked"));
      renderPreview(text);
      pushActive(true);
      return;
    }
    commitYaml(text, { rerun: true });
  });

  reset.addEventListener("click", () => activateBuiltin("astra_default", true));

  // ---- shared API for the guided-mode inline selector (wizard.ts) --------- //
  // Drives the SAME activate/import logic so guided + free modes stay in sync.
  const rulesetApi: RulesetApi = {
    list: () => {
      const out = [
        { value: "b:astra_default", label: BUILTIN_RULESETS.astra_default.label },
        { value: "b:astra_plausi", label: BUILTIN_RULESETS.astra_plausi.label },
      ];
      for (const s of loadSavedRulesets()) out.push({ value: `s:${s.id}`, label: s.name });
      if (active.origin === "scratch") out.push({ value: "scratch", label: `${active.name} •` });
      return out;
    },
    current: () =>
      active.origin === "builtin" ? `b:${active.builtinKey}`
        : active.origin === "saved" ? `s:${active.savedId}`
          : "scratch",
    activate: (value, rerun) => {
      if (value.startsWith("b:")) activateBuiltin(value.slice(2) as "astra_default" | "astra_plausi", rerun);
      else if (value.startsWith("s:")) activateSaved(value.slice(2), rerun);
    },
    importText: (text, filename) => {
      const msg = quickValidateYaml(text);
      if (msg) { setStatus(t("rules.statImportRejected", { msg })); return; }
      const base = filename.replace(/\.(ya?ml)$/i, "") || "Importiert";
      const rec = createSavedRuleset(base, text);
      activateSaved(rec.id, true);
      setStatus(t("rules.statImportedShort", { file: filename, base }));
    },
    onChange: (cb) => { externalSyncCbs.push(cb); },
  };
  (window as RulesetGlobals).ndRuleset = rulesetApi;

  // Live language switch: re-render the rule preview (count/labels/tooltips)
  // and the builder Apply button caption. Field labels + option text are
  // static [data-i18n] nodes handled by applyStaticTranslations(document).
  onLangChange(() => {
    fApply.textContent = editingIdx === null ? t("rules.applyRule") : t("rules.applyChange");
    rebuildRulesetSelect();
    renderPreview(active.yaml);
  });

  // ---- initial activation (restore last active from localStorage) --------- //
  const restore = getActiveRulesetId();
  if (restore === "astra_default" || restore === "astra_plausi") {
    activateBuiltin(restore, false);
  } else if (restore && getSavedRuleset(restore)) {
    activateSaved(restore, false);
  } else {
    activateBuiltin("astra_default", false);
  }
}

function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c] as string),
  );
}
