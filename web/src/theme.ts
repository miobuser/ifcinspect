// Light/Dark theme system. The actual colours live as CSS custom properties
// in style.css under :root[data-theme="light"] / [data-theme="dark"]; this
// module only decides which theme is active and reflects it on
// document.documentElement.dataset.theme.
//
// Resolution order on init:
//   1. a previously stored user override (localStorage), else
//   2. the OS preference via matchMedia("(prefers-color-scheme: light)").
// When there is NO stored override we keep following the OS live.

export type Theme = "light" | "dark";

const STORAGE_KEY = "ifcinspect_theme";

const subscribers: Array<(t: Theme) => void> = [];

function readStored(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

function osPrefersLight(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function resolveInitial(): Theme {
  const stored = readStored();
  if (stored) return stored;
  return osPrefersLight() ? "light" : "dark";
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function notify(theme: Theme): void {
  for (const cb of subscribers) cb(theme);
}

export function getTheme(): Theme {
  const d = document.documentElement.dataset.theme;
  return d === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* persistence is best-effort */
  }
  apply(theme);
  notify(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}

export function onThemeChange(cb: (t: Theme) => void): void {
  subscribers.push(cb);
}

/** Set the initial dataset.theme and wire the OS-follow listener. Returns the
 *  resolved theme so the caller can do its first paint (e.g. viewer bg). */
export function initTheme(): Theme {
  const theme = resolveInitial();
  apply(theme);
  // Follow the OS ONLY while the user has no explicit override stored.
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (ev: MediaQueryListEvent) => {
      if (readStored()) return; // explicit override wins — ignore OS changes
      const next: Theme = ev.matches ? "light" : "dark";
      apply(next);
      notify(next);
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
    } else if (typeof mq.addListener === "function") {
      // Safari < 14 fallback.
      mq.addListener(onChange);
    }
  }
  return theme;
}
