// Guided-mode shell. Renders a four-step linear flow into #wizard while
// #app (Frei-Modus) stays hidden via body[data-mode]. Shares the SAME
// Viewer3D instance with the free-mode shell: when step 3 is shown, we
// reparent the viewer canvas into #wiz-viewport, and put it back into
// #viewer when switching back to Frei. Net effect: no scene rebuild,
// no double-Pyodide cost.

import type { Viewer3D } from "./viewer3d/viewer";
import type { RulesetApi } from "./shell";
import type { DetectionResult } from "./types";
import { deriveGroupedIssues, refineIssueAnnotation, type Issue } from "./issues";
import { buildDimensionAnnotation } from "./annotation";
import { buildBcfZip, makeViewerSnapshotProvider } from "./bcf";
import { exportPdfReport } from "./report-pdf";
import { showBusy, hideBusy, nextFrame } from "./progress";
import { t, applyStaticTranslations, onLangChange, SUPPORTED, getLang, setLang, statusLabel } from "./i18n";

export type WizardHandle = {
  setStep: (step: 1 | 2 | 3 | 4) => void;
  setProgress: (msg: string, pct: number) => void;
  showResult: (result: DetectionResult, filename: string) => void;
  showError: (msg: string) => void;
  onFile: (cb: (file: File) => void) => void;
  attachViewer: () => void;   // pull viewer canvas into guided step 3
  detachViewer: () => void;   // hand viewer canvas back to free-mode shell
  clearResult: () => void;    // wipe BCF list + cached result
};

const WIZ_HTML = `
  <div class="wiz-hdr">
    <div class="wiz-brand">
      <h1>IfcInspect</h1>
      <span class="wiz-brand-sub" data-i18n="hdr.subtitle">IFC-Geometrie-Validierung</span>
    </div>
    <div class="wiz-steps">
      <span class="wiz-step" data-step="1" data-i18n="wiz.step1">1 · IFC laden</span>
      <span class="wiz-step" data-step="2" data-i18n="wiz.step2">2 · Analyse</span>
      <span class="wiz-step" data-step="3" data-i18n="wiz.step3">3 · Ergebnis</span>
      <span class="wiz-step" data-step="4" data-i18n="wiz.step4">4 · Export</span>
    </div>
    <select class="lang-select" id="wiz_lang_select" data-i18n-title="hdr.langTip" title="Sprache wählen" aria-label="Sprache wählen"></select>
    <button class="theme-toggle" id="wiz_theme_toggle" type="button" data-i18n-title="hdr.themeTip" title="Hell/Dunkel umschalten" aria-label="Hell/Dunkel umschalten">☼</button>
    <button class="wiz-btn-mode" data-mode-btn="free" data-i18n="wiz.toFree" data-i18n-title="wiz.toFreeTip" title="Zum freien Modus wechseln">Zum freien Modus →</button>
  </div>

  <div class="wiz-body">
    <section class="wiz-page" data-page="1">
      <div class="wiz-hero">
        <h2 data-i18n="wiz.heroTitle">Laden Sie Ihre IFC-Datei</h2>
        <p data-i18n="wiz.heroText">Das Tool prüft Stützmauer-Geometrie nach ASTRA-Regeln direkt in Ihrem Browser.</p>
        <span class="badge privacy wiz-privacy has-tip" tabindex="0" data-i18n="hdr.privacy" data-i18n-title="hdr.privacyTip" data-tip="Läuft vollständig in Ihrem Browser via WebAssembly (Pyodide + IfcOpenShell). Ihre IFC-Datei wird nicht hochgeladen, nicht auf einem Server verarbeitet und verlässt Ihr Gerät nie — kein Upload, keine Cloud, kein Tracking." title="Läuft vollständig in Ihrem Browser via WebAssembly (Pyodide + IfcOpenShell). Ihre IFC-Datei wird nicht hochgeladen, nicht auf einem Server verarbeitet und verlässt Ihr Gerät nie — kein Upload, keine Cloud, kein Tracking.">Client-Side · 100 % im Browser</span>
        <label class="wiz-drop" for="wiz-file">
          <strong data-i18n="wiz.dropStrong">IFC hier ablegen</strong>
          <span data-i18n="wiz.dropHint">oder klicken zum Auswählen</span>
        </label>
        <input id="wiz-file" type="file" accept=".ifc,.IFC" hidden />
        <p class="wiz-note"><span data-i18n="wiz.exampleFiles">Beispiel-Dateien: </span><code>beispiel_nische.ifc</code>, <code>beispiel_bogenwand.ifc</code></p>
        <div class="wiz-ruleset">
          <span class="wiz-rs-label" data-i18n="wiz.rsLabel">Regelset</span>
          <select id="wiz-ruleset-select" data-i18n-title="wiz.rsSelectTip" title="Aktives Regelset wählen"></select>
          <label class="wiz-rs-import" for="wiz-ruleset-file" data-i18n="wiz.rsImport" data-i18n-title="wiz.rsImportTip" title="Regelset-YAML importieren">⇪ Import</label>
          <input id="wiz-ruleset-file" type="file" accept=".yaml,.yml" hidden />
        </div>
      </div>
    </section>

    <section class="wiz-page" data-page="2">
      <div class="wiz-progress-host">
        <h2 data-i18n="wiz.analyzing">Analyse läuft …</h2>
        <div class="wiz-progress-bar"><div class="wiz-progress-fill"></div></div>
        <p class="wiz-progress-msg" data-i18n="wiz.progressInit">Pyodide initialisieren …</p>
      </div>
    </section>

    <section class="wiz-page" data-page="3">
      <div class="wiz-bcf">
        <aside class="bcf-issues">
          <header>
            <h3 class="bcf-h3-toggle"><span class="bcf-tw" aria-hidden="true">▾</span><span data-i18n="wiz.findings">Befunde</span> <span class="bcf-counter">0</span></h3>
            <div class="bcf-filter">
              <button data-filter="all" class="on" data-i18n="wiz.filterAll">Alle</button>
              <button data-filter="FAIL" data-i18n="wiz.filterFail">FAIL</button>
              <button data-filter="WARN" data-i18n="wiz.filterWarn">WARN</button>
              <button data-filter="PASS" data-i18n="wiz.filterPass">PASS</button>
              <button data-filter="INFO" data-i18n="wiz.filterInfo">Info</button>
              <button data-filter="SKIP" data-i18n="wiz.filterSkip">Übersprungen</button>
            </div>
          </header>
          <ol class="bcf-list"></ol>
        </aside>
        <section class="bcf-view">
          <div class="bcf-view-host" id="wiz-viewport"></div>
          <div class="bcf-legend" id="wiz-legend" hidden></div>
          <div class="bcf-view-nav">
            <button class="bcf-prev" data-i18n="wiz.prev">← Voriger</button>
            <span class="bcf-pos">0 / 0</span>
            <button class="bcf-next" data-i18n="wiz.next">Nächster →</button>
          </div>
          <div class="bcf-detail"></div>
        </section>
      </div>
    </section>

    <section class="wiz-page" data-page="4">
      <div class="wiz-export">
        <h2 data-i18n="wiz.exportTitle">Exportieren</h2>
        <p data-i18n="wiz.exportText">Wählen Sie das gewünschte Format. Alle Exporte werden direkt im Browser erzeugt.</p>
        <div class="wiz-export-buttons"></div>
      </div>
    </section>
  </div>

  <div class="wiz-footer">
    <!-- "← Zurück" sitzt ganz links unten (User-Praeferenz); Credit mittig,
         Schnitt/Weiter rechts. -->
    <button class="wiz-btn-prev" data-action="prev" data-i18n="wiz.navPrev">← Zurück</button>
    <span class="wiz-credit" data-i18n="footer.credit">BSc-Arbeit von Mio Buser · Berner Fachhochschule (BFH) · 2026</span>
    <div class="wiz-nav">
      <!-- Schnitt nur sichtbar wenn der 3D-Viewer sichtbar ist (Schritt 3) — per
           setStep() ein-/ausgeblendet. Startet versteckt. -->
      <button class="wiz-btn-section" data-section-btn data-i18n="wiz.sectionBtn" data-i18n-title="wiz.sectionTip" title="Schnitt durch die Wand am Befund-Ort an/aus" hidden>Schnitt</button>
      <button class="wiz-btn-next" data-action="next" data-i18n="wiz.navNext">Weiter →</button>
    </div>
  </div>
`;

export function mountWizard(
  root: HTMLElement,
  viewer: Viewer3D,
  viewerCanvasHost: HTMLElement,
): WizardHandle {
  root.innerHTML = WIZ_HTML;
  // Fill all static [data-i18n*] nodes for the current language.
  applyStaticTranslations(root);
  // Populate + wire the header language selector (synced with the shell's
  // via main.ts cross-sync + each select's own onLangChange below).
  const wizLangSelect = root.querySelector("#wiz_lang_select") as HTMLSelectElement | null;
  if (wizLangSelect) {
    wizLangSelect.innerHTML = SUPPORTED
      .map((s) => `<option value="${escape(s.code)}">${escape(s.label)}</option>`)
      .join("");
    wizLangSelect.value = getLang();
    wizLangSelect.addEventListener("change", () => setLang(wizLangSelect.value as never));
  }

  let currentStep: 1 | 2 | 3 | 4 = 1;
  let currentResult: DetectionResult | null = null;
  let currentFilename = "modell.ifc";
  const fileCallbacks: Array<(file: File) => void> = [];

  const fileInput = root.querySelector("#wiz-file") as HTMLInputElement;
  const drop = root.querySelector(".wiz-drop") as HTMLLabelElement;
  const progressFill = root.querySelector(".wiz-progress-fill") as HTMLElement;
  const progressMsg = root.querySelector(".wiz-progress-msg") as HTMLElement;
  const viewportHost = root.querySelector("#wiz-viewport") as HTMLElement;
  const exportButtons = root.querySelector(".wiz-export-buttons") as HTMLElement;
  const btnPrev = root.querySelector(".wiz-btn-prev") as HTMLButtonElement;
  const btnNext = root.querySelector(".wiz-btn-next") as HTMLButtonElement;
  const bcfList = root.querySelector(".bcf-list") as HTMLOListElement;
  const bcfCounter = root.querySelector(".bcf-counter") as HTMLElement;
  const bcfPos = root.querySelector(".bcf-pos") as HTMLElement;
  const bcfPrev = root.querySelector(".bcf-prev") as HTMLButtonElement;
  const bcfNext = root.querySelector(".bcf-next") as HTMLButtonElement;
  const bcfDetail = root.querySelector(".bcf-detail") as HTMLElement;
  const bcfLegend = root.querySelector("#wiz-legend") as HTMLElement;
  // Befundliste ein-/ausklappbar (v.a. mobil → mehr Höhe fürs 3D).
  const bcfIssues = root.querySelector(".bcf-issues") as HTMLElement | null;
  root.querySelector(".bcf-h3-toggle")?.addEventListener("click", () => {
    bcfIssues?.classList.toggle("collapsed");
    // Der 3D-Viewport (flex) ändert die Höhe → Renderer neu einpassen.
    window.dispatchEvent(new Event("resize"));
  });
  const bcfFilters = root.querySelectorAll<HTMLButtonElement>(".bcf-filter button");

  let issues: Issue[] = [];
  let filteredIssues: Issue[] = [];
  let activeIssueIdx = 0;
  let currentFilter: "all" | "FAIL" | "WARN" | "PASS" | "INFO" | "SKIP" = "all";
  // Section toggle (Task B): user override of per-rule default. null = follow
  // the rule's default-on map; true/false = sticky override across navigation.
  let sectionUserOverride: boolean | null = null;
  const btnSection = root.querySelector(".wiz-btn-section") as HTMLButtonElement | null;

  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) {
      currentFilename = f.name;
      fileCallbacks.forEach((cb) => cb(f));
    }
    fileInput.value = "";
  });
  drop.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("drag");
    const f = ev.dataTransfer?.files?.[0];
    if (f) {
      currentFilename = f.name;
      fileCallbacks.forEach((cb) => cb(f));
    }
  });

  // ---- Regelset-Inline-Selektor (geführter Modus) ------------------------- //
  // Wählen + Importieren (kein Bearbeiten — das volle Fenster gibt es nur im
  // Free-Modus). Treibt die geteilte window.ndRuleset-API aus shell.ts, damit
  // beide Modi synchron bleiben; ein Wechsel löst sofort eine Neu-Prüfung aus.
  const rsSelect = root.querySelector("#wiz-ruleset-select") as HTMLSelectElement | null;
  const rsFile = root.querySelector("#wiz-ruleset-file") as HTMLInputElement | null;
  const rsApi = (): RulesetApi | undefined =>
    (window as Window & { ndRuleset?: RulesetApi }).ndRuleset;
  const escRs = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const syncRulesetSelect = () => {
    const api = rsApi();
    if (!rsSelect || !api) return;
    rsSelect.innerHTML = api.list()
      .map((o) => `<option value="${escRs(o.value)}">${escRs(o.label)}</option>`)
      .join("");
    rsSelect.value = api.current();
  };
  rsSelect?.addEventListener("change", () => { rsApi()?.activate(rsSelect.value, true); });
  rsFile?.addEventListener("change", async () => {
    const f = rsFile.files?.[0];
    rsFile.value = "";
    if (!f) return;
    try { rsApi()?.importText(await f.text(), f.name); }
    catch { /* ignore unreadable file */ }
  });
  // ndRuleset is registered by mountShell, which runs before mountWizard
  // (see main.ts). Subscribe for changes made elsewhere (free-mode modal),
  // then do the initial populate.
  rsApi()?.onChange(syncRulesetSelect);
  syncRulesetSelect();

  function setStep(step: 1 | 2 | 3 | 4) {
    currentStep = step;
    // CSS hook: #wizard[data-step="3"] clamps the body to viewport height so the
    // findings list (left) scrolls instead of growing the page off-screen.
    root.dataset.step = String(step);
    root.querySelectorAll<HTMLElement>(".wiz-page").forEach((p) => {
      p.classList.toggle("active", p.dataset.page === String(step));
    });
    root.querySelectorAll<HTMLElement>(".wiz-step").forEach((s) => {
      const n = Number(s.dataset.step);
      s.classList.toggle("done", n < step);
      s.classList.toggle("current", n === step);
    });
    btnPrev.disabled = step === 1;
    btnNext.disabled = step === 4 || (step === 1 && !currentResult);
    btnNext.textContent = step === 3 ? t("wiz.navExport") : t("wiz.navNext");
    // Schnitt-Button nur zeigen, wenn der 3D-Viewer sichtbar ist (Schritt 3).
    if (btnSection) btnSection.hidden = step !== 3;
    if (step === 3) {
      // Free orbit stays ON in guided step 3 — user jumps to the issue
      // viewpoint but can rotate/pan/zoom from there to inspect freely.
      attachViewer();
      if (activeIssueIdx >= 0 && filteredIssues.length > 0) {
        jumpToIssue(activeIssueIdx, false);
      } else {
        // Keine Regel angewählt → Gesamtmodell ohne BCF-Overlays zeigen.
        viewer.setIssueAnnotations(null);
        viewer.highlightIssueRegion(null);
        viewer.setSectionPlane(null);
        viewer.setContextDimmed(false);
        viewer.setFindingIsolation(null);
        viewer.fit();
        bcfDetail.innerHTML = "";
      }
    } else {
      // Leaving step 3 — clear annotation overlay + class highlight + section.
      viewer.setIssueAnnotations(null);
      viewer.highlightIssueRegion(null);
      viewer.setSectionPlane(null);
      viewer.setContextDimmed(false);
      viewer.setFindingIsolation(null);
      detachViewer();
    }
  }

  function attachViewer() {
    if (viewportHost.contains(viewerCanvasHost)) return;
    viewportHost.appendChild(viewerCanvasHost);
    window.dispatchEvent(new Event("resize"));
  }
  function detachViewer() {
    const original = document.getElementById("viewer");
    if (original && !original.contains(viewerCanvasHost)) {
      original.appendChild(viewerCanvasHost);
      window.dispatchEvent(new Event("resize"));
    }
  }

  function setProgress(msg: string, pct: number) {
    progressMsg.textContent = msg;
    progressFill.style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
  }

  function showError(msg: string) {
    progressMsg.textContent = t("wiz.error", { msg });
    progressFill.style.background = "var(--error)";
  }

  function statusBadge(s: Issue["status"]): string {
    // Farbe + Glyph je Status; INFO bekommt eine eigene blaue/neutrale Farbe
    // (NICHT rot/gelb), SKIP grau. Der Text kommt übersetzt aus statusLabel().
    const map: Record<string, [string, string]> = {
      PASS: ["✓", "var(--success)"],
      FAIL: ["✗", "var(--error)"],
      WARN: ["!", "var(--warning)"],
      INFO: ["ⓘ", "var(--info)"],
      SKIP: ["–", "var(--text-mute)"],
    };
    const [icon, col] = map[s] || map.INFO;
    const lbl = statusLabel(s);
    return `<span class="wiz-badge s-${String(s).toLowerCase()}" style="color:${col};border-color:${col}">${icon} ${escape(lbl)}</span>`;
  }

  function applyFilter() {
    filteredIssues = currentFilter === "all"
      ? issues.slice()
      : issues.filter((i) => i.status === currentFilter);
    if (activeIssueIdx >= filteredIssues.length) activeIssueIdx = 0;
    renderBcfList();
    updateBcfNav();
    if (currentStep === 3 && activeIssueIdx >= 0 && filteredIssues.length > 0) {
      jumpToIssue(activeIssueIdx, false);
    } else {
      bcfDetail.innerHTML = "";
    }
  }

  function renderBcfList() {
    bcfCounter.textContent = String(issues.length);
    if (filteredIssues.length === 0) {
      bcfList.innerHTML = `<li class="bcf-empty">${escape(t("wiz.noFindings"))}</li>`;
      return;
    }
    bcfList.innerHTML = filteredIssues.map((it, idx) => `
      <li class="bcf-card s-${it.status.toLowerCase()} ${idx === activeIssueIdx ? "active" : ""}" data-idx="${idx}">
        <div class="bcf-card-hd">
          <span class="bcf-badge s-${it.status.toLowerCase()}">${escape(statusLabel(it.status))}</span>
          <span class="bcf-card-label">${escape(it.label)}</span>
          ${it.count && it.count > 1 ? `<span class="bcf-card-count">${it.count}×</span>` : ""}
        </div>
        ${it.groupName ? `<div class="bcf-card-grp">${escape(it.groupName)}</div>` : ""}
        <p class="bcf-card-desc">${escape(it.shortDescription)}</p>
      </li>`).join("");
    bcfList.querySelectorAll<HTMLLIElement>(".bcf-card").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.idx);
        if (!Number.isNaN(idx)) jumpToIssue(idx, true);
      });
    });
  }

  function updateBcfNav() {
    const n = filteredIssues.length;
    // activeIssueIdx < 0 → noch nichts angewählt: "– / n" anzeigen.
    bcfPos.textContent = n === 0
      ? t("wiz.posEmpty")
      : activeIssueIdx < 0
        ? t("wiz.pos", { i: "–", n })
        : t("wiz.pos", { i: activeIssueIdx + 1, n });
    bcfPrev.disabled = n === 0 || activeIssueIdx <= 0;
    bcfNext.disabled = n === 0 || activeIssueIdx >= n - 1;
  }

  function renderBcfDetail(it: Issue) {
    const members = it.members || [];
    const memberList = members.map((m) =>
      `<div class="bcf-mem"><span class="bcf-mem-name">${escape(m.name)}</span><code class="bcf-mem-guid">${escape(m.guid)}</code><b>${escape(m.value)}</b></div>`,
    ).join("");
    // Der Beschreibungsblock ist EINKLAPPBAR (<details open>): auf dem Handy frisst
    // er sonst die Höhe, sodass man die Beschriftung im 3D nie lesen kann. Die
    // Zusammenfassung (Status + Label) bleibt sichtbar, der Rest klappt weg →
    // das 3D (1fr-Zeile) wächst.
    bcfDetail.innerHTML = `
      <details class="bcf-detail-d" open>
        <summary class="bcf-detail-title">${statusBadge(it.status)} ${escape(it.label)}</summary>
        <div class="bcf-detail-rows">
          ${it.groupName ? `<div><span>${escape(t("wiz.detailElement"))}</span><b>${escape(it.groupName)}</b></div>` : ""}
          <div><span>${escape(t("wiz.detailIst"))}</span><b>${escape(it.istValue)}</b></div>
          <div><span>${escape(t("wiz.detailSoll"))}</span><b>${escape(it.sollValue)}</b></div>
          <div><span>${escape(t("wiz.detailRuleId"))}</span><code>${escape(it.ruleId)}</code></div>
        </div>
        ${memberList ? `<details class="bcf-members"><summary>${escape(t("wiz.detailMembers"))} (${members.length})</summary>${memberList}</details>` : ""}
      </details>
    `;
  }

  // Flächenfarben-Legende (geführter Modus, mobil + PC). Farben MÜSSEN zu
  // viewer COLORS.classes passen; nur die im Ergebnis vorhandenen K-Klassen.
  const LEGEND_COLORS: Record<string, string> = {
    K0: "#e53935", K1: "#fb8c00", K2: "#2196f3", K3: "#8e24aa",
    K4: "#66bb6a", K5: "#00897b", K6: "#d81b9a",
  };
  const LEGEND_ORDER = ["K0", "K1", "K2", "K3", "K4", "K5", "K6"];
  function renderLegend(result: DetectionResult | null) {
    if (!bcfLegend) return;
    const kinds = new Set<string>();
    for (const c of (result?.cavities || [])) {
      const k = (c as { kind?: string }).kind;
      if (k && LEGEND_COLORS[k]) kinds.add(k);
    }
    const present = LEGEND_ORDER.filter((k) => kinds.has(k));
    if (!present.length) { bcfLegend.hidden = true; bcfLegend.innerHTML = ""; return; }
    bcfLegend.hidden = false;
    bcfLegend.innerHTML = present.map((k) =>
      `<span class="lg-item"><i class="lg-sw" style="background:${LEGEND_COLORS[k]}"></i>${escape(t("cls." + k))}</span>`,
    ).join("");
  }

  function jumpToIssue(idx: number, animate: boolean) {
    if (idx < 0 || idx >= filteredIssues.length) return;
    activeIssueIdx = idx;
    const it = filteredIssues[idx];
    // Element-Geometrie + Kamera + Maß exakt setzen (lazy) — VOR setIssueView,
    // da refine jetzt auch issue.view/section auf das Element umrechnet.
    if (currentResult) refineIssueAnnotation(it, currentResult);
    // Update active highlight on the cards
    bcfList.querySelectorAll<HTMLLIElement>(".bcf-card").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.idx) === idx);
    });
    const active = bcfList.querySelector<HTMLLIElement>(`.bcf-card[data-idx="${idx}"]`);
    active?.scrollIntoView({ block: "nearest", behavior: animate ? "smooth" : "auto" });
    // Eng auf das GESCHNITTENE (repraesentative) Element einpassen — nicht die ganze
    // Stuetzmauer-Gruppe (die kann fast das ganze Modell umfassen). Rep = wallIndex.
    const _repWm = currentResult?.wall_metrics?.[it.wallIndex] as { element_guid?: string } | undefined;
    const _repGuid = _repWm?.element_guid;
    // Bemasste Regeln (dimension/arrow): exakt auf die Schnitt-/Profilfläche
    // einpassen — issue.view rahmt das Querschnitt-Profil head-on, sodass die
    // geschnittene Fläche das Bild füllt UND die Bemassung konstant relativ zum
    // Element bleibt (frameUnit basiert auf issue.view; identisch zum BCF-Export).
    // Andere Regeln: eng aufs repräsentative Element.
    if (it.annotation?.kind === "dimension" || it.annotation?.kind === "arrow") {
      viewer.setIssueView(it.view, { animate });
    } else {
      viewer.fitToElements(
        _repGuid ? [_repGuid] : (it.memberGuids && it.memberGuids.length ? it.memberGuids : null),
        it.view, { animate });
    }
    // Ganzes betroffenes Element zeigen (keine Klassen ausblenden) — die
    // Isolation unten hebt es hervor (klassenfarbige Kanten) und graut den Rest.
    viewer.highlightIssueRegion(null);
    // Build + show the dimension annotation for this issue (clears previous).
    const annoGroup = buildDimensionAnnotation(it);
    viewer.setIssueAnnotations(annoGroup);
    // Dim the terrain so the wall + annotation dominate the finding view.
    viewer.setContextDimmed(true);
    // Nur die betroffenen Elemente voll farbig + klassenfarbige Kanten; alles
    // andere (andere Elemente + Wand-Körper) grau und sehr transparent.
    viewer.setFindingIsolation(it.memberGuids && it.memberGuids.length ? it.memberGuids : null);
    // crown_min_width: NUR die K2-Krone zeigen (Wandstärke-Schnitt, übrige Klassen
    // ausblenden); andere Regeln behalten alle Klassen des Bauteils.
    if (it.ruleId === "crown_min_width" && it.highlight?.kind === "class") {
      viewer.highlightIssueRegion(it.highlight.classKey);
    }
    // Section plane (Task B): apply if (a) issue carries one AND
    // (b) user hasn't disabled OR rule defaults to on.
    // Standard: immer schneiden, wenn eine Schnittebene verfügbar ist; der
    // Nutzer kann den Schnitt pro Befund über den Schnitt-Button übersteuern.
    const wantSection = sectionUserOverride !== null
      ? sectionUserOverride
      : !!it.section;
    viewer.setSectionPlane(wantSection && it.section ? it.section : null);
    if (btnSection) btnSection.classList.toggle("on", wantSection && !!it.section);
    renderBcfDetail(it);
    updateBcfNav();
  }

  // Section toggle button — flips the per-issue cut on/off, sticky until
  // the user navigates away from guided step 3 or hits a new file.
  btnSection?.addEventListener("click", () => {
    if (filteredIssues.length === 0) return;
    const it = filteredIssues[activeIssueIdx];
    const currentOn = btnSection.classList.contains("on");
    sectionUserOverride = !currentOn;
    viewer.setSectionPlane(sectionUserOverride && it.section ? it.section : null);
    btnSection.classList.toggle("on", sectionUserOverride && !!it.section);
  });

  // BCF nav wiring
  bcfPrev.addEventListener("click", () => jumpToIssue(activeIssueIdx - 1, true));
  bcfNext.addEventListener("click", () => jumpToIssue(activeIssueIdx + 1, true));
  bcfFilters.forEach((b) => {
    b.addEventListener("click", () => {
      bcfFilters.forEach((x) => x.classList.toggle("on", x === b));
      currentFilter = (b.dataset.filter as typeof currentFilter) || "all";
      activeIssueIdx = 0;
      applyFilter();
    });
  });
  // Keyboard ←/→ when guided step 3 is the active page
  window.addEventListener("keydown", (ev) => {
    if (currentStep !== 3) return;
    const tgt = ev.target as HTMLElement | null;
    if (tgt && ["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
    if (document.body.dataset.mode !== "guided") return;
    if (ev.key === "ArrowLeft") {
      if (activeIssueIdx > 0) { jumpToIssue(activeIssueIdx - 1, true); ev.preventDefault(); }
    } else if (ev.key === "ArrowRight") {
      if (activeIssueIdx < filteredIssues.length - 1) { jumpToIssue(activeIssueIdx + 1, true); ev.preventDefault(); }
    }
  });

  function renderExports(result: DetectionResult) {
    const base = currentFilename.replace(/\.ifc$/i, "") || "modell";
    // IFC is generated ON DEMAND via window.ndExportIfc (detect() no longer ships
    // ifc_bytes_b64), so the IFC button is ALWAYS enabled. GLB still depends on
    // the result payload.
    const hasIfc = true;
    const hasGlb = !!result.glb_bytes_b64;
    exportButtons.innerHTML = `
      <button class="wiz-export-btn" data-fmt="pdf">${escape(t("wiz.expHtml"))}</button>
      <button class="wiz-export-btn" data-fmt="json">${escape(t("wiz.expJson"))}</button>
      <button class="wiz-export-btn" data-fmt="csv">${escape(t("wiz.expCsv"))}</button>
      <button class="wiz-export-btn" data-fmt="bcf">${escape(t("wiz.expBcf"))}</button>
      <button class="wiz-export-btn ${hasIfc ? "" : "disabled"}" data-fmt="ifc" ${hasIfc ? "" : "disabled"}>${escape(hasIfc ? t("wiz.expIfc") : t("wiz.expIfcNa"))}</button>
      <button class="wiz-export-btn ${hasGlb ? "" : "disabled"}" data-fmt="glb" ${hasGlb ? "" : "disabled"}>${escape(hasGlb ? t("wiz.expGlb") : t("wiz.expGlbNa"))}</button>
      <label class="wiz-export-passopt"><input type="checkbox" data-bcf-pass /> ${escape(t("wiz.expIncludePass"))}</label>
      <label class="wiz-export-passopt"><input type="checkbox" data-pdf-kennwerte checked /> ${escape(t("export.optKennwerte"))}</label>
      <label class="wiz-export-passopt"><input type="checkbox" data-ifc-pset checked /> ${escape(t("export.optPset"))}</label>
      <label class="wiz-export-passopt"><input type="checkbox" data-ifc-sub checked /> ${escape(t("export.optSubmeshes"))}</label>
    `;
    const passCb = exportButtons.querySelector("[data-bcf-pass]") as HTMLInputElement | null;
    const psetCb = exportButtons.querySelector("[data-ifc-pset]") as HTMLInputElement | null;
    const subCb = exportButtons.querySelector("[data-ifc-sub]") as HTMLInputElement | null;
    const kennCb = exportButtons.querySelector("[data-pdf-kennwerte]") as HTMLInputElement | null;
    exportButtons.querySelectorAll<HTMLButtonElement>(".wiz-export-btn").forEach((b) => {
      b.addEventListener("click", async () => {
        const fmt = b.dataset.fmt!;
        if (fmt === "bcf") {
          showBusy("BCF wird erzeugt …");
          await nextFrame();
          try {
            handleExport(fmt, base, result, {
              includePass: !!passCb?.checked,
              snapshot: makeViewerSnapshotProvider(
                (o) => viewer.captureIssueSnapshot(o),
                { width: 1280, height: 720 },
                (iss) => buildDimensionAnnotation(iss),
              ),
            });
          } finally {
            hideBusy();
          }
        } else if (fmt === "pdf") {
          handleExport(fmt, base, result, {
            includePass: false,
            includeKennwerte: kennCb ? kennCb.checked : true,
            capture: (o) => viewer.captureIssueSnapshot(o),
          });
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
              downloadBlob(`${base}_export.ifc`,
                b64ToUint8(b64) as unknown as BlobPart, "application/x-step");
            }
          } finally {
            hideBusy();
          }
        } else {
          handleExport(fmt, base, result);
        }
      });
    });
  }

  function showResult(result: DetectionResult, filename: string) {
    currentResult = result;
    currentFilename = filename;
    issues = deriveGroupedIssues(result);
    // Standardmässig ist nach dem Laden KEINE Regel/Befund angewählt (-1) → der
    // Viewer zeigt das Gesamtmodell, bis der Nutzer selbst einen Befund wählt.
    activeIssueIdx = -1;
    currentFilter = "all";
    bcfFilters.forEach((x) => x.classList.toggle("on", x.dataset.filter === "all"));
    applyFilter();
    renderLegend(result);
    renderExports(result);
    // Only switch step automatically when in guided mode; otherwise the free
    // shell stays put and the user can switch over later.
    if (document.body.dataset.mode === "guided") setStep(3);
    btnNext.disabled = false;
  }

  function clearResult() {
    currentResult = null;
    issues = [];
    filteredIssues = [];
    activeIssueIdx = 0;
    currentFilter = "all";
    bcfFilters.forEach((x) => x.classList.toggle("on", x.dataset.filter === "all"));
    bcfList.innerHTML = "";
    bcfCounter.textContent = "0";
    bcfPos.textContent = "0 / 0";
    bcfPrev.disabled = true;
    bcfNext.disabled = true;
    bcfDetail.innerHTML = "";
    exportButtons.innerHTML = "";
    viewer.highlightIssueRegion(null);
    viewer.setIssueAnnotations(null);
    viewer.setSectionPlane(null);
    viewer.ghostExcept(null);
    sectionUserOverride = null;
  }

  btnPrev.addEventListener("click", () => {
    // Schritt 2 (Analyse) wird beim Laden automatisch übersprungen (showResult →
    // Schritt 3). „Zurück" aus dem Ergebnis soll daher direkt zu „IFC laden"
    // (Schritt 1) führen, statt auf der leeren Analyse-Seite zu landen.
    if (currentStep === 3) setStep(1);
    else if (currentStep > 1) setStep((currentStep - 1) as 1 | 2 | 3);
  });
  btnNext.addEventListener("click", () => {
    if (currentStep < 4) setStep((currentStep + 1) as 2 | 3 | 4);
  });
  // Mode-switch button in the wiz-footer -> free mode via global setter.
  const btnMode = root.querySelector(".wiz-btn-mode") as HTMLButtonElement | null;
  btnMode?.addEventListener("click", () => {
    (window as Window & { ndSetMode?: (m: "guided" | "free") => void })
      .ndSetMode?.("free");
  });

  // ---- Live language switch ---------------------------------------------- //
  // Static [data-i18n*] nodes (steps, hero, filters, nav, footer) are handled
  // by applyStaticTranslations(document) inside setLang(). Here we re-render
  // the DYNAMIC content: the Weiter/Export caption, and — if a result is
  // loaded — re-derive the issues (so the generated shortDescription + the 3D
  // annotation Maßtext follow the language), then re-render the list, the
  // active detail, the counter/nav and the export buttons.
  onLangChange(() => {
    if (wizLangSelect) wizLangSelect.value = getLang();
    // Weiter/Export caption is dynamic (depends on current step).
    btnNext.textContent = currentStep === 3 ? t("wiz.navExport") : t("wiz.navNext");
    if (!currentResult) return;
    // Re-derive issues so language-dependent generated text (shortDescription,
    // annotation labels) refreshes. Rule labels stay verbatim DATA.
    issues = deriveGroupedIssues(currentResult);
    applyFilter();          // re-renders list + nav + (if step 3) re-jumps,
                            // which rebuilds the annotation + detail in-lang.
    renderLegend(currentResult);  // Flächenfarben-Legende übersetzen.
    renderExports(currentResult);
  });

  // Initial state: show step 1 (otherwise CSS `.wiz-page { display:none }`
  // hides every page and the user sees an empty body with only prev/next).
  setStep(1);

  return {
    setStep,
    setProgress,
    showResult,
    showError,
    onFile: (cb) => fileCallbacks.push(cb),
    attachViewer,
    detachViewer,
    clearResult,
  };
}

// ---- Export helpers (reused for both Guided and Free IFC/GLB) -----

export function handleExport(
  fmt: string,
  base: string,
  result: DetectionResult,
  bcf?: {
    includePass: boolean;
    includeKennwerte?: boolean;
    snapshot?: (issue: Issue) => Uint8Array | null;
    capture?: (o: { view: Issue["view"]; section?: Issue["section"]; light?: boolean; keepGuids?: string[] | null; width?: number; height?: number }) => string | null;
  },
): void {
  if (fmt === "bcf") {
    downloadBlob(
      `${base}_befunde.bcf`,
      buildBcfZip(result, `${base}.ifc`, {
        includePass: bcf?.includePass === true,
        snapshot: bcf?.snapshot,
      }) as unknown as BlobPart,
      "application/octet-stream",
    );
  } else if (fmt === "json") {
    downloadBlob(`${base}_pruefprotokoll.json`,
      JSON.stringify(result, null, 2), "application/json");
  } else if (fmt === "pdf") {
    void exportPdfReport(result, base, bcf?.capture, `${base}.ifc`, bcf?.includeKennwerte !== false);
  } else if (fmt === "csv") {
    downloadBlob(`${base}_pruefprotokoll.csv`,
      "﻿" + buildCsv(result), "text/csv");
  } else if (fmt === "ifc" && result.ifc_bytes_b64) {
    downloadBlob(`${base}_schaleinlagen.ifc`,
      b64ToUint8(result.ifc_bytes_b64) as unknown as BlobPart, "application/x-step");
  } else if (fmt === "glb" && result.glb_bytes_b64) {
    downloadBlob(`${base}_schaleinlagen.glb`,
      b64ToUint8(result.glb_bytes_b64) as unknown as BlobPart, "model/gltf-binary");
  }
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

// Soll ohne Einheit fuer die CSV — die Einheit steht in der separaten Spalte.
// ">= 0.3 m" -> ">= 0.3", "<= 0.10 ratio" -> "<= 0.10".
function sollNoUnit(soll: string): string {
  const m = String(soll || "").match(/^\s*(>=|<=|==|!=|>|<)?\s*(-?\d+(?:[.,]\d+)?)/);
  return m ? (m[1] ? `${m[1]} ${m[2]}` : m[2]) : String(soll || "").trim();
}

function buildCsv(result: DetectionResult): string {
  const rows: string[] = [
    "wall_guid;wall_name;rule_id;rule_label;ist;soll;status;einheit",
  ];
  for (const wm of result.wall_metrics || []) {
    const name = wm.element_name || result.wall_name || "";
    const guid = wm.element_guid || result.chosen_guid || "";
    for (const ch of wm.pruefung || []) {
      rows.push(
        [guid, name, ch.id, ch.label, String(ch.value),
         sollNoUnit(ch.soll), ch.status, ch.einheit || ""]
          .map((v) => String(v).replace(/;/g, ",")).join(";"),
      );
    }
  }
  return rows.join("\r\n");
}

function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
