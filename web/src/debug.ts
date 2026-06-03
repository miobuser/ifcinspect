// Zentrales Debug-Gating. Interne Diagnose-Logs ([webifc]/[worker]/Pyodide-
// stdout/stderr inkl. der harmlosen ifcopenshell-„lark"-Warnung) erscheinen NUR
// in der Entwicklung (vite dev). In der Produktion ist die Konsole sauber.
// console.error wird NICHT gegated (echte Fehler bleiben sichtbar/diagnostizierbar).
const _env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
export const DEBUG: boolean = !!(_env && _env.DEV);

export function dlog(...args: unknown[]): void {
  if (DEBUG) console.info(...args);
}
