/// <reference lib="webworker" />
// Pyodide Web Worker hosting the IfcInspect wheel.
//
// IFC bytes arrive via structured-clone as ArrayBuffer -> handed to
// Python as `bytes`. They stay in worker memory for the duration of
// detection, then drop when the worker terminates on page reload.
// Nothing is posted to the network; nothing is written to disk
// (Pyodide MEMFS lives in WASM memory).

import driverSource from "./python/driver.py?raw";
import type { WorkerRequest, WorkerResponse, WorkerProgress } from "./types";
import { loadWebIfcMeshes } from "./webifc-loader";
import { DEBUG, dlog } from "./debug";

// Pyodide CDN — official, versioned, immutable. The COEP=credentialless
// header (set by vite.config / vercel.json) allows fetching these
// cross-origin scripts without requiring upstream CORP.
const PYODIDE_VERSION = "0.28.0";
const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// ifcopenshell WASM wheel — official IfcOpenShell wheel repository
// for Pyodide. Pinned to a known-working release; bump in lockstep
// with PYODIDE_VERSION (pyodide 0.28 = pyodide_2025_0 ABI, Python 3.13).
const IFCOPENSHELL_WHEEL =
  "https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl";

// Our IfcInspect wheel lives in public/wheels/ -- same origin.
// Version bumps change the URL so a rebuilt wheel is fetched fresh.
const OUR_WHEEL_PATH = "/wheels/ifcinspect-0.4.41-py3-none-any.whl";

type PyodideAPI = {
  loadPackage: (names: string[]) => Promise<void>;
  runPython: (src: string) => unknown;
  runPythonAsync: (src: string) => Promise<unknown>;
  registerJsModule: (name: string, obj: unknown) => void;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    mkdir: (path: string) => void;
  };
  globals: {
    set: (k: string, v: unknown) => void;
    get: (k: string) => unknown;
  };
  toPy: (v: unknown) => { destroy: () => void };
};

let pyodide: PyodideAPI | null = null;
let ready = false;
let initError: Error | null = null;
let initPromise: Promise<void> | null = null;

// Pyodide is single-threaded: two overlapping runPythonAsync calls corrupt the
// shared interpreter state (e.g. the __detect_args global gets cleared by one
// call mid-flight in another, surfacing as "'JsNull' object is not
// subscriptable"). The deferred L7 pass runs ~6 s in the background, so it can
// easily overlap the next detect. We serialise EVERY job through one promise
// chain so only one Python run executes at a time.
let jobQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(job: () => Promise<T>): Promise<T> {
  const result = jobQueue.then(job, job);
  // Keep the chain alive even if a job rejects (swallow here; the job itself
  // already posts its own error to the client).
  jobQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

function progress(id: number, p: WorkerProgress) {
  post({ id, kind: "progress", progress: p });
}

async function loadPyodideScript(): Promise<PyodideAPI> {
  const mod = (await import(
    /* @vite-ignore */ `${PYODIDE_INDEX}pyodide.mjs`
  )) as {
    loadPyodide: (opts: {
      indexURL: string;
      stdout?: (s: string) => void;
      stderr?: (s: string) => void;
    }) => Promise<PyodideAPI>;
  };
  // Pyodide routet Python-stdout/stderr per Default in die Konsole — dort taucht
  // u.a. die harmlose ifcopenshell-„No module named 'lark'"-Warnung auf. In Prod
  // stummschalten (nur in Dev sichtbar); echte Pipeline-Fehler kommen ohnehin als
  // JSON über den Worker-Kanal zurück, nicht über stderr.
  return mod.loadPyodide({
    indexURL: PYODIDE_INDEX,
    // Phase logs are DEBUG-gated (clean console for production; enable DEBUG for
    // diagnosis). Python [driver.phase]/[ctxperf] prints flow through here.
    stdout: (s: string) => { if (DEBUG) console.log(s); },
    stderr: (s: string) => { if (DEBUG) console.warn(s); },
  });
}

async function ensureReady(id: number): Promise<void> {
  if (ready) return;
  if (initError) throw initError;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const stage = (label: string) => dlog("[worker]", label);

    progress(id, { stage: "loading_pyodide", message: "Pyodide laden…", i18nKey: "progress.loadPyodide", pct: 0.05 });
    stage("loading Pyodide runtime");
    pyodide = await loadPyodideScript();

    progress(id, {
      stage: "installing_packages",
      message: "Basis-Pakete (numpy, micropip, pyyaml)…",
      i18nKey: "progress.basePkgs",
      pct: 0.25,
    });
    stage("loadPackage(numpy, micropip, pyyaml)");
    await pyodide.loadPackage(["numpy", "scipy", "micropip", "pyyaml", "typing-extensions"]);

    progress(id, {
      stage: "installing_packages",
      message: "Pure-Python Pakete (shapely, trimesh)…",
      i18nKey: "progress.purePkgs",
      pct: 0.45,
    });
    stage("micropip.install shapely + trimesh");
    await pyodide.runPythonAsync(`
import micropip
# networkx: trimesh.repair.fix_winding/fix_normals braucht es (Mesh-Reparatur
# nicht-wasserdichter IFC-Tessellierungen) — sonst "No module named 'networkx'".
await micropip.install(["shapely", "trimesh", "networkx"])
`);

    progress(id, {
      stage: "installing_packages",
      message: "IfcOpenShell (~14 MB)…",
      i18nKey: "progress.ifcopenshell",
      pct: 0.65,
    });
    stage("micropip.install ifcopenshell (WASM wheel)");
    await pyodide.runPythonAsync(`
import micropip
await micropip.install("${IFCOPENSHELL_WHEEL}", deps=False)
`);

    progress(id, {
      stage: "installing_packages",
      message: "IfcInspect-Engine laden…",
      i18nKey: "progress.engine",
      pct: 0.85,
    });
    stage("fetching + installing ifcinspect wheel");
    if (DEBUG) console.log(`[perf] loading wheel: ${OUR_WHEEL_PATH}`);
    const resp = await fetch(OUR_WHEEL_PATH);
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch ifcinspect wheel (${OUR_WHEEL_PATH}): HTTP ${resp.status}`,
      );
    }
    const wheelBytes = new Uint8Array(await resp.arrayBuffer());
    pyodide.FS.writeFile("/tmp/ifcinspect.whl", wheelBytes);
    // Unzip into site-packages directly (avoids micropip URL-parsing
    // quirks with local file:/ paths; still preferred under pyodide 0.28).
    await pyodide.runPythonAsync(`
import zipfile, site, os, importlib, sys, types
_target = site.getsitepackages()[0]
os.makedirs(_target, exist_ok=True)
with zipfile.ZipFile("/tmp/ifcinspect.whl", "r") as _z:
    _z.extractall(_target)
importlib.invalidate_caches()
# Voxel-Path-Removal (2026-05-29): keine Stub-Module mehr für scipy.ndimage /
# scikit-image / pymeshfix / manifold3d — der Pipeline-Code benutzt sie nicht.
# rtree dagegen wird von trimesh.proximity.closest_point intern angefragt und
# hat KEINEN WASM-Wheel. Pseudo-Index gibt einfach alle Triangles zurück:
# trimesh fällt damit auf seinen Brute-Force-Pfad — langsamer, aber korrekt.
class _PseudoIndex:
    def __init__(self, *args, **kwargs):
        self._items = []
        # Accept (stream, properties=...) constructor where stream yields (id, bbox, obj)
        if args and hasattr(args[0], "__iter__"):
            try:
                self._items = [it[0] for it in args[0]]
            except Exception:
                self._items = []
    def insert(self, _id, *_args, **_kw):
        self._items.append(_id)
    def intersection(self, *_args, **_kw):
        return iter(self._items)
    def nearest(self, *_args, **_kw):
        return iter(self._items)
    def delete(self, *_args, **_kw):
        pass
_rtree_mod = types.ModuleType("rtree")
_rtree_idx = types.ModuleType("rtree.index")
_rtree_idx.Index = _PseudoIndex
_rtree_idx.Property = lambda *a, **kw: None
_rtree_mod.index = _rtree_idx
_rtree_mod.Rtree = _PseudoIndex
import importlib.machinery
_rtree_mod.__spec__ = importlib.machinery.ModuleSpec("rtree", loader=None)
_rtree_idx.__spec__ = importlib.machinery.ModuleSpec("rtree.index", loader=None)
sys.modules["rtree"] = _rtree_mod
sys.modules["rtree.index"] = _rtree_idx
# Sanity import (surface real ImportError if ifcinspect itself is broken).
import ifcinspect  # noqa: F401
`);

    // Driver module: hand the source string in as a global and exec it
    // into an in-memory module. Avoids touching Pyodide's filesystem
    // for the driver code.
    stage("building driver module in-memory");
    pyodide.globals.set("__driver_src", driverSource);
    await pyodide.runPythonAsync(`
import sys, types, traceback
__driver_mod = types.ModuleType("driver")
__driver_mod.__file__ = "<driver.py (in-memory)>"
try:
    exec(compile(__driver_src, __driver_mod.__file__, "exec"),
         __driver_mod.__dict__)
except Exception as _e:
    raise RuntimeError(
        "driver module failed to load:\\n" + traceback.format_exc()
    ) from _e
sys.modules["driver"] = __driver_mod
assert hasattr(__driver_mod, "run_detect_from_bytes"), \\
    "driver loaded but run_detect_from_bytes() not found"
`);
    pyodide.globals.set("__driver_src", null);

    progress(id, { stage: "ready", message: "Bereit", i18nKey: "progress.ready", pct: 1.0 });
    ready = true;
    post({ id, kind: "ready" });
  })().catch((err) => {
    initError = err instanceof Error ? err : new Error(String(err));
    throw initError;
  });
  return initPromise;
}

async function runDetect(
  req: Extract<WorkerRequest, { kind: "detect" }>,
): Promise<void> {
  await ensureReady(req.id);
  if (!pyodide) throw new Error("Pyodide failed to initialise");
  const py = pyodide;

  progress(req.id, {
    stage: "parsing_ifc",
    message: "IFC parsen + Pipeline starten…",
    i18nKey: "progress.parsing",
    pct: 0.05,
  });

  const ifcU8 = new Uint8Array(req.ifc_bytes);

  // web-ifc ist die EINZIGE Geometrie-Engine: tesselliert JEDE IFC-Geometrie
  // (tessellated, FacetedBrep, CSG/Extrusion) im Worker (C++/WASM), ohne
  // OpenCASCADE. KEIN Fallback — schlägt web-ifc fehl, wird der Fehler als
  // echter Fehler gemeldet (statt still auf eine langsame Engine zurückzufallen,
  // was Bugs verschleiern würde).
  progress(req.id, {
    stage: "parsing_ifc",
    message: "Geometrie (web-ifc) …",
    i18nKey: "progress.webifc",
    pct: 0.15,
  });
  dlog("[worker] web-ifc: loading meshes from", ifcU8.length, "bytes");
  const _t0 = Date.now();
  const webifcProducts = await loadWebIfcMeshes(ifcU8);
  const _tWeb = Date.now() - _t0;
  if (DEBUG) console.log(`[perf] web-ifc: ${webifcProducts.length} products, ${_tWeb} ms (${ifcU8.length} bytes)`);
  if (!webifcProducts.length) {
    throw new Error(
      "web-ifc lieferte keine Geometrie (Modell ohne lesbare Körper?)",
    );
  }

  const _tArgs0 = Date.now();
  const args: Record<string, unknown> = {
    ifc_bytes: ifcU8,
    ifc_filename: req.ifc_filename,
    defer_distances: req.defer_distances === true,
    // Als plain Arrays übergeben (Pyodide kopiert sie als Python-Listen).
    webifc_products: webifcProducts.map((p) => ({
      guid: p.guid,
      ifc_type: p.ifc_type,
      vertices: Array.from(p.vertices),
      faces: Array.from(p.faces),
    })),
  };
  let _triCount = 0, _vtxCount = 0;
  for (const p of webifcProducts) { _vtxCount += p.vertices.length / 3; _triCount += p.faces.length / 3; }
  if (DEBUG) console.log(`[perf] handoff arrays built: ${Math.round(_vtxCount)} verts / ${Math.round(_triCount)} tris, ${Date.now() - _tArgs0} ms`);
  // Only forward an EXPLICIT target. A JS `null`/`undefined` would cross the
  // JS->Py bridge as a Pyodide `JsNull` sentinel (not Python None), defeating
  // the driver's `is None` ALL_WALLS default — so omit the key entirely when
  // there is no target. `_a.get("target")` then yields a real Python None.
  if (typeof req.target === "string" && req.target) {
    args.target = req.target;
  }
  if (req.rules_bytes) {
    args.rules_bytes = new Uint8Array(req.rules_bytes);
  }
  dlog("[worker] handing", webifcProducts.length,
    "products to Python pipeline …");
  const _tPy0 = Date.now();
  const argsProxy = py.toPy(args);
  py.globals.set("__detect_args", argsProxy);

  try {
    const resultJson = (await py.runPythonAsync(`
import driver, traceback, json as _json
_a = globals().get("__detect_args")
try:
    if _a is None or not hasattr(_a, "get"):
        raise RuntimeError("detect args missing (worker state race)")
    _ifc = bytes(_a["ifc_bytes"])
    _rb = _a.get("rules_bytes")
    _rb_bytes = bytes(_rb) if _rb is not None else None
    _wip = _a.get("webifc_products")
    _wip = _wip.to_py() if hasattr(_wip, "to_py") else _wip
    _res = driver.run_detect_from_bytes(
        _ifc,
        _a.get("ifc_filename") or "uploaded.ifc",
        _a.get("target"),
        _rb_bytes,
        # compute_distances = NOT defer. defer_distances=True (UI default) means
        # SKIP the expensive scene-level passes (L7 distances + scene_adjacency)
        # on the initial load — they are computed in the background pass. The flag
        # was passed straight through (inverted), so compute_distances was always
        # True → scene_adjacency/L7 ran inline → the load hang on dense models.
        (not bool(_a.get("defer_distances"))),
        _wip,
    )
except Exception as _e:
    _res = _json.dumps({
        "ok": False,
        "error": str(_e),
        "traceback": traceback.format_exc(),
    })
_res
`)) as string;
    if (DEBUG) console.log(`[perf] python detect (toPy + pipeline): ${Date.now() - _tPy0} ms, ${resultJson.length} chars`);
    dlog("[worker] Python pipeline returned", resultJson.length, "chars");

    const _tParse0 = Date.now();
    const parsed = JSON.parse(resultJson) as unknown;
    if (DEBUG) {
      console.log(`[perf] JSON.parse: ${Date.now() - _tParse0} ms`);
      const _pp = (parsed as { _perf?: Record<string, number> })?._perf;
      if (_pp) console.log("[perf] python phases (ms):", JSON.stringify(_pp));
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { ok?: boolean }).ok === false
    ) {
      const p = parsed as { error: string; traceback?: string };
      console.error("[worker] pipeline error:", p.error);
      post({
        id: req.id,
        kind: "error",
        error: p.traceback ? `${p.error}\n\n${p.traceback}` : p.error,
      });
      return;
    }
    dlog("[worker] detection OK, posting result");
    post({
      id: req.id,
      kind: "ok",
      result: parsed as import("./types").DetectionResult,
    });
  } finally {
    try {
      argsProxy.destroy();
    } catch {
      /* already destroyed */
    }
    py.globals.set("__detect_args", null);
  }
}

async function runDistances(
  req: Extract<WorkerRequest, { kind: "distances" }>,
): Promise<void> {
  await ensureReady(req.id);
  if (!pyodide) throw new Error("Pyodide failed to initialise");
  const py = pyodide;
  // Background L7 pass over the last detection's products (no IFC re-parse).
  const resultJson = (await py.runPythonAsync(`
import driver, traceback, json as _json
try:
    _res = driver.compute_deferred_distances()
except Exception as _e:
    _res = _json.dumps({
        "ok": False,
        "error": str(_e),
        "traceback": traceback.format_exc(),
    })
_res
`)) as string;
  const parsed = JSON.parse(resultJson) as {
    ok?: boolean;
    error?: string;
    traceback?: string;
    scene_distances?: import("./types").DistanceRecord[];
    wall_metrics?: import("./types").WallMetrics[];
  };
  if (!parsed || parsed.ok === false) {
    post({
      id: req.id,
      kind: "error",
      error: parsed?.traceback
        ? `${parsed.error}\n\n${parsed.traceback}`
        : parsed?.error || "deferred distances failed",
    });
    return;
  }
  post({
    id: req.id,
    kind: "distances",
    scene_distances: parsed.scene_distances || [],
    wall_metrics: parsed.wall_metrics || [],
  });
}

async function runExportIfc(
  req: Extract<WorkerRequest, { kind: "export-ifc" }>,
): Promise<void> {
  await ensureReady(req.id);
  if (!pyodide) throw new Error("Pyodide failed to initialise");
  const py = pyodide;
  // On-demand IFC re-emit over the last detection (no IFC re-parse). The
  // options are handed in as a JSON STRING via a Python global so there is no
  // string interpolation into the executed source (injection-safe).
  py.globals.set("__export_opts_json", JSON.stringify(req.options));
  try {
    const b64 = (await py.runPythonAsync(`
import driver
_opts = globals().get("__export_opts_json") or "{}"
driver.export_ifc(_opts)
`)) as string;
    post({ id: req.id, kind: "export-ifc", b64: b64 || "" });
  } catch (err) {
    post({
      id: req.id,
      kind: "error",
      error: err instanceof Error ? err.stack || err.message : String(err),
    });
  } finally {
    py.globals.set("__export_opts_json", null);
  }
}

self.addEventListener("message", async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  // Serialise all jobs so two Python runs never overlap (see runExclusive).
  await runExclusive(async () => {
    try {
      if (req.kind === "init") {
        await ensureReady(req.id);
      } else if (req.kind === "detect") {
        await runDetect(req);
      } else if (req.kind === "distances") {
        await runDistances(req);
      } else if (req.kind === "export-ifc") {
        await runExportIfc(req);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      post({ id: req.id, kind: "error", error: msg });
    }
  });
});
