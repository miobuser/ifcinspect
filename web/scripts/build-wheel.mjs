#!/usr/bin/env node
// Rebuild the ifcinspect wheel from the repo root and place it in
// web/public/wheels/. Runs as an npm `prebuild` hook so `npm run build`
// (and Vercel deployments) always ship the wheel built from current
// Python sources. Cross-platform: avoids shell-specific `cd` chains by
// using Node's child_process with an explicit cwd.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at web/scripts/ -> repoRoot is web/.. = NicheDetector/
const repoRoot = resolve(here, "..", "..");
const outdir = "web/public/wheels";

// Resolve a Python interpreter. Order:
//   1) $env:PYTHON / $PYTHON  (explicit override)
//   2) `py -3` launcher (Windows)
//   3) `python` on PATH
function pickPython() {
  const explicit = process.env.PYTHON;
  if (explicit) return { cmd: explicit, args: [] };

  if (process.platform === "win32") {
    try {
      execFileSync("py", ["-3", "--version"], { stdio: "ignore" });
      return { cmd: "py", args: ["-3"] };
    } catch {
      /* fall through */
    }
  }
  return { cmd: "python", args: [] };
}

const py = pickPython();

console.log(
  `[build-wheel] running ${py.cmd} ${py.args.join(" ")} -m build --wheel --outdir ${outdir}`,
);
console.log(`[build-wheel] cwd = ${repoRoot}`);

try {
  execFileSync(
    py.cmd,
    [...py.args, "-m", "build", "--wheel", "--outdir", outdir],
    { cwd: repoRoot, stdio: "inherit" },
  );
} catch (err) {
  console.error("[build-wheel] python -m build failed.");
  console.error(
    "[build-wheel] Hint: install build with `pip install build`, or set the PYTHON env var to a venv interpreter.",
  );
  process.exit(err.status ?? 1);
}

const wheelDir = resolve(repoRoot, outdir);
if (!existsSync(wheelDir)) {
  console.error(`[build-wheel] expected output dir does not exist: ${wheelDir}`);
  process.exit(1);
}
const wheels = readdirSync(wheelDir).filter((f) => f.endsWith(".whl"));
console.log(`[build-wheel] done -> ${wheelDir}`);
console.log(`[build-wheel] wheels: ${wheels.join(", ") || "(none)"}`);

// ---------------------------------------------------------------------------
// Self-heal: ensure every flat module the live Pyodide pipeline imports is
// actually packed into the wheel. The NicheDetector package is a FLAT module
// collection driven by pyproject's hatch `include` list. If a freshly added
// module (e.g. confidence.py, imported at runtime by metrics.py) is NOT in that
// list, the wheel ships incomplete and the SPA silently loses the feature
// (metrics.py's `import confidence` falls into its defensive except branch and
// emits score=None / level="unbekannt"). Rather than depend on the root
// pyproject being in sync, we verify + patch the wheel here, in code this
// script owns. Pure Node (no external deps) via Python's zipfile through the
// same interpreter we already resolved.
const REQUIRED_FLAT_MODULES = [
  "ifcinspect.py",
  "niche_brep.py",
  "ifc_io.py",
  "webifc_mesh.py",
  "context.py",
  "distances.py",
  "metrics.py",
  "rules.py",
  "report.py",
  "confidence.py",
];

for (const whl of wheels) {
  const whlPath = resolve(wheelDir, whl);
  // Build a tiny Python snippet that (a) lists the wheel, (b) injects any
  // missing required module from repoRoot, (c) re-reports + asserts confidence.
  const pyPatch = [
    "import sys, os, zipfile",
    `whl = r'''${whlPath}'''`,
    `root = r'''${repoRoot}'''`,
    `required = ${JSON.stringify(REQUIRED_FLAT_MODULES)}`,
    "with zipfile.ZipFile(whl, 'r') as z:",
    "    have = set(z.namelist())",
    "missing = [m for m in required if m not in have and os.path.exists(os.path.join(root, m))]",
    "if missing:",
    "    with zipfile.ZipFile(whl, 'a', zipfile.ZIP_DEFLATED) as z:",
    "        for m in missing:",
    "            z.write(os.path.join(root, m), m)",
    "    print('[build-wheel] patched missing modules into wheel: ' + ', '.join(missing))",
    "with zipfile.ZipFile(whl, 'r') as z:",
    "    final = set(z.namelist())",
    "print('[build-wheel] wheel modules: ' + ', '.join(sorted(n for n in final if n.endswith('.py'))))",
    "assert 'confidence.py' in final, 'confidence.py STILL missing from wheel after patch'",
    "print('[build-wheel] OK: confidence.py present in ' + os.path.basename(whl))",
  ].join("\n");

  try {
    execFileSync(py.cmd, [...py.args, "-c", pyPatch], { stdio: "inherit" });
  } catch (err) {
    console.error(`[build-wheel] wheel verification/patch failed for ${whl}.`);
    process.exit(err.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Guard the load-bearing version coupling: worker.ts fetches a HARDCODED wheel
// filename (OUR_WHEEL_PATH). If pyproject's [project].version is bumped without
// editing worker.ts (or vice versa), the SPA 404s at load. Fail the build here
// on any mismatch so the coupling can never drift silently.
const workerSrc = readFileSync(resolve(repoRoot, "web/src/worker.ts"), "utf8");
const wantMatch = workerSrc.match(/ifcinspect-[\d.]+-py3-none-any\.whl/);
if (!wantMatch) {
  console.error("[build-wheel] could not find the OUR_WHEEL_PATH wheel name in web/src/worker.ts");
  process.exit(1);
}
const wantWheel = wantMatch[0];
if (!wheels.includes(wantWheel)) {
  console.error(`[build-wheel] MISMATCH: worker.ts expects ${wantWheel}, but built wheels are: ${wheels.join(", ") || "(none)"}`);
  console.error("[build-wheel] Bump web/src/worker.ts OUR_WHEEL_PATH to match pyproject [project].version (or vice versa).");
  process.exit(1);
}
console.log(`[build-wheel] OK: worker.ts wheel path (${wantWheel}) matches the built wheel.`);
