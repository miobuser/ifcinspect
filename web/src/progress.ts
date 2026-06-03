// Einfaches Busy-Overlay (Spinner) für Aktionen, die kurz brauchen, bis der
// Download bereit ist (PDF/BCF rendern pro Befund Screenshots). Selbst-injizierte
// Styles, keine Abhängigkeit von style.css. Die CSS-Animation läuft auf dem
// Compositor und dreht daher auch während kurzer synchroner Arbeit weiter.

let _el: HTMLDivElement | null = null;
let _stylesInjected = false;

function injectStyles(): void {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
#busy-overlay{position:fixed;inset:0;z-index:99999;display:none;align-items:center;
  justify-content:center;background:rgba(20,20,22,0.45);backdrop-filter:blur(2px)}
#busy-overlay .busy-card{display:flex;flex-direction:column;align-items:center;gap:14px;
  padding:26px 34px;border-radius:12px;background:#1f2125;color:#f0f0f0;
  box-shadow:0 8px 30px rgba(0,0,0,0.4);font:14px/1.4 Segoe UI,Tahoma,sans-serif}
#busy-overlay .busy-spinner{width:34px;height:34px;border-radius:50%;
  border:3px solid rgba(255,255,255,0.18);border-top-color:#f5a623;
  animation:busy-spin 0.8s linear infinite}
#busy-overlay .busy-label{max-width:280px;text-align:center}
@keyframes busy-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(style);
}

export function showBusy(label: string): void {
  injectStyles();
  if (!_el) {
    _el = document.createElement("div");
    _el.id = "busy-overlay";
    _el.innerHTML = `<div class="busy-card"><div class="busy-spinner"></div><div class="busy-label"></div></div>`;
    document.body.appendChild(_el);
  }
  const lbl = _el.querySelector(".busy-label") as HTMLElement | null;
  if (lbl) lbl.textContent = label;
  _el.style.display = "flex";
}

export function setBusyLabel(label: string): void {
  const lbl = _el?.querySelector(".busy-label") as HTMLElement | null;
  if (lbl) lbl.textContent = label;
}

export function hideBusy(): void {
  if (_el) _el.style.display = "none";
}

/** rAF-Yield, damit das Overlay sicher gemalt ist, bevor synchrone Arbeit (BCF-Zip) läuft. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
