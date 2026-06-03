# NicheDetector — Browser SPA (Pyodide)

Static SPA port of NicheDetector. Runs entirely in the user's browser
via Pyodide. **IFC files never leave the client** — verify by watching
DevTools Network during a detection.

## Architecture

```
[ Browser tab ]
  index.html
    └─ main.ts ──► shell.ts (UI) + viewer3d/viewer.ts (Three.js)
                    │
                    └─ Web Worker
                        ├─ Pyodide runtime (CDN, cached after first load)
                        ├─ ifcopenshell WASM wheel (CDN, ~14 MB)
                        ├─ ifcinspect wheel (same origin, public/wheels/)
                        └─ driver.py (in-memory)
                            └─ ifcinspect.detect(/tmp/...)
                                   ↑ Pyodide MEMFS (in-WASM-memory only)
```

The wheel is built from `C:\dev\NicheDetector\pyproject.toml` by
`scripts/build-wheel.mjs` (runs as the `prebuild` step of `npm run build`).

## Local development

```bash
cd C:\dev\NicheDetector\web
npm install
npm run build:wheel       # one-time: builds ifcinspect wheel into public/wheels/
npm run dev               # vite dev server on http://localhost:5173
```

Required tooling: Python 3.10+, `pip install build`, Node 20+.

## Deploy to Vercel

```bash
cd C:\dev\NicheDetector\web
npx vercel --prod
```

The `vercel.json` sets the cross-origin isolation headers
(`COOP: same-origin`, `COEP: credentialless`) required for
SharedArrayBuffer and numpy in Pyodide. The `prebuild` hook rebuilds
the wheel before `vite build`.

## Pyodide compatibility — known blockers (2026-05-28)

NicheDetector's classify pipeline transitively imports several
native-only Python libraries that do NOT have WASM wheels for Pyodide
0.27/0.29:

| Module        | Used by                                              | Pyodide status | Mitigation                                                                       |
| ------------- | ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `pymeshfix`   | `ifcinspect.ensure_volume` (mesh repair)         | ❌ no wheel    | `driver.py` stubs it; the existing `try/except` in the helper falls back cleanly |
| `manifold3d`  | `trimesh.boolean.union(engine="manifold")`           | ❌ no wheel    | `_union_overlapping_elements` already has the keep-separate fallback             |
| `scipy`       | `voxutil` (`scipy.ndimage`)                          | ⚠ partial wheel | `driver.py` stubs it; voxel-remesh fallback raises but is rarely needed          |
| `scikit-image`| `voxutil.component_mesh` (marching cubes)            | ❌ no wheel    | same as above                                                                    |
| `pyvista`     | `view_pyvista`, `_to_pv`                             | ❌ no wheel    | UI-only; not invoked from `detect()` -> safe                                     |
| `matplotlib`  | `save_preview_matplotlib`                            | ⚠ partial      | UI-only; not invoked from `detect()` -> safe                                     |

**Practical impact**: for IFCs whose walls land in the
`_prep_wall` watertight path (the common case), the pipeline runs
end-to-end. For walls that need the voxel-remesh fallback (
non-watertight tessellations with extreme gaps), `driver.py` returns
`{"ok": false, "error": "ImportError: skimage..."}` and the user is
told to use the native localhost (`web_viewer.py`) instead.

A future port could replace the voxel-remesh step with a pure-Python
marching-cubes implementation (e.g. `pyMCubes` if WASM-buildable, or
a hand-rolled lookup-table version) — out of scope for the initial SPA.

## File map

```
web/
├── package.json                 (vite + three + typescript)
├── tsconfig.json
├── vite.config.ts              (COOP/COEP headers in dev + preview)
├── vercel.json                 (COOP/COEP headers in production)
├── index.html
├── scripts/
│   └── build-wheel.mjs         (python -m build → public/wheels/)
├── public/
│   └── wheels/                 (ifcinspect-X.Y.Z-py3-none-any.whl)
└── src/
    ├── main.ts                 (entry point; worker bus)
    ├── shell.ts                (Layout-B accordion UI -- Phase 1)
    ├── viewer3d/viewer.ts      (Three.js renderer)
    ├── worker.ts               (Pyodide host)
    ├── python/driver.py        (bytes-only IFC API)
    ├── style.css
    ├── types.ts
    └── python-raw.d.ts
```

## Phase 2 / TODO

- Port the full Layout-B inspector accordion sections from
  `web_viewer.py` (`#_HTML` lines 437–663) — currently only the core
  5 sections are mapped (Ergebnis, Wand-Liste, Kenngrössen,
  Klassifikation, Export).
- Wire the rail toggles to the actual layer-visibility groups
  (Niche-Volumen, Klassen K0–K5, Nischen-Rand, Feature-Kanten,
  Normalen-Pfeile, Wandstärke-Messstrecken).
- Click-pick on faces → right-panel detail view (the `#detail`
  region in `web_viewer.py`).
- Service Worker for caching the Pyodide runtime (~30 MB) across
  reloads (see `ifc-geo-validator/web/public/sw.js` for the pattern).
- Replace `scikit-image` marching-cubes with a pure-Python
  implementation OR ship a self-hosted Pyodide build with the
  unofficial skimage WASM wheel.
- Reduce the wheel size by dropping `report.py`, `rules.py`,
  `context.py`, `distances.py`, `metrics.py` if they are not needed
  for the classify-only browser flow.
