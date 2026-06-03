// Polished Three.js viewer for IfcInspect — IFC-Editor feel.
// Patterns adopted from C:\dev\IFC-Editor\src\viewer\IFCViewer.ts:
//   - OrbitControls (damping, zoomToCursor, zoomSpeed, minDistance)
//   - 3-point lighting (key + fill + below-fill) + ambient
//   - pixel-ratio cap min(devicePixelRatio, 2)
//   - dynamic near plane based on distance to target
//   - on-demand rendering with damping cooldown
//   - bounding-sphere-based fit-to-view with aspect-aware FOV
//   - Grid + Axes helpers
//   - Hover/click highlight, FPS HUD, view-cube
//
// Public API is unchanged so shell.ts keeps working.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { DetectionResult, DetectionMesh } from "../types";
import { createSectionCaps, type SectionCapsController, type ClippableMesh } from "./sectionCaps";

// Gemeinsame Feature-Kanten-Schwelle (Grad). Wird sowohl für die Schattierung
// (toCreasedNormals — Normalen verschmelzen nur unter dieser Schwelle) ALS AUCH
// für das sichtbare Kanten-Overlay (EdgesGeometry) verwendet, damit Shading-Bruch
// und Kantenlinie IMMER zusammenfallen. 30° = Untergrenze der datengetriebenen
// Flächenklassifikations-Schwelle (niche_brep.auto_sharp_angle), also genau die
// Grenze „echte Design-Kante vs. Vernetzungs-Facette": Kantenlinien markieren so
// dieselben Übergänge wie die Klassifikation.
const FEATURE_EDGE_DEG = 30;

export type IssueView = {
  cameraPos: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg?: number;
};

export type Viewer3D = {
  renderResult: (result: DetectionResult) => void;
  setViewerBackground: (hex: number) => void;
  setLayerVisible: (layer: string, visible: boolean) => void;
  // Styling setters for the upcoming settings UI (Pass 2). Accept layer keys
  // "wall"|"cavities"|"context" and class keys "K0".."K6". No-op on
  // unknown key; never throw.
  setLayerColor: (layerOrClassKey: string, hex: number) => void;
  setLayerOpacity: (layerOrClassKey: string, opacity: number) => void;
  setLayerLineWidth: (layerOrClassKey: string, width: number) => void;
  setLayerEdgesVisible: (layerOrClassKey: string, visible: boolean) => void;
  setContextDimmed: (dim: boolean) => void;
  fit: () => void;
  // Element-Inspektor: nur EIN IFC-Element (per GUID) sichtbar lassen + drauf
  // zoomen. isolateElement(null) hebt die Isolation wieder auf.
  isolateElement: (guid: string | null) => void;
  focusProduct: (guid: string) => void;
  fitToElement: (guid: string) => void;
  // Doppelklick auf ein Element im 3D → guid an die Shell (Element-Inspektor).
  onElementPick: (cb: (guid: string) => void) => void;
  // Stark transparent (Ghost) alle Cavity-Elemente, deren GUID NICHT in der
  // Liste ist; null stellt die Basis-Opazität wieder her.
  ghostExcept: (guids: string[] | null) => void;
  setFindingIsolation: (guids: string[] | null) => void;
  fitToElements: (guids: string[] | null, view: IssueView, opts?: { animate?: boolean }) => void;
  // Komplett-Reset auf die Totale (ESC / Rechtsklick ins Leere). onReset meldet
  // den Reset an die Shell (Inspektor-/Regel-Zustand zurücksetzen).
  resetView: () => void;
  onReset: (cb: () => void) => void;
  clearFacePick: () => void;
  setIssueView: (view: IssueView, opts?: { animate?: boolean; durationMs?: number }) => void;
  setControlsEnabled: (enabled: boolean) => void;
  highlightIssueRegion: (classKey: string | null) => void;
  setIssueAnnotations: (group: THREE.Group | null) => void;
  setSectionPlane: (plane: { normal: [number, number, number]; point: [number, number, number] } | null) => void;
  // ---- FREE-mode clipping toolset (BimCollab-style) ----------------------
  startSectionPlacement: (method: "face" | "path") => void;
  cancelSectionPlacement: () => void;
  getPlacementMode: () => "none" | "face" | "path";
  clipPlaneCount: () => number;
  flipClipPlane: (index: number) => void;
  deleteClipPlane: (index: number) => void;
  clearClipPlanes: () => void;
  getSelectedPlaneIndex: () => number | null;
  setPlaneVisible: (index: number, visible: boolean) => void;
  setAllPlanesVisible: (visible: boolean) => void;
  onPlaneContextMenu: (cb: (index: number, clientX: number, clientY: number) => void) => void;
  onEmptyContextMenu: (cb: (clientX: number, clientY: number) => void) => void;
  onPlacementChange: (cb: (mode: "none" | "face" | "path") => void) => void;
  clearSection: () => void;
  // Synchronously apply an issue view (+ optional class highlight / section),
  // render one frame, and return a PNG dataURL of the canvas. Used by the BCF
  // export to embed a snapshot.png per finding. Restores the prior camera +
  // highlight + section afterwards.
  captureIssueSnapshot: (opts: {
    view: IssueView;
    classKey?: string | null;
    section?: { normal: [number, number, number]; point: [number, number, number] } | null;
    width?: number;
    height?: number;
    light?: boolean;
    keepGuids?: string[] | null;
    highlightClass?: string | null;
    annotation?: object | null;
    toolLook?: boolean;
  }) => string | null;
};

const COLORS = {
  wall: 0x9aa0a8,
  wallEdge: 0x5a5e66,
  cavity: 0xb8860b,
  cavityEdge: 0xb8970a,
  context_terrain: 0x8b7355,
  context_road: 0x6a6a6a,
  context_other: 0x5a5a6a,
  hover: 0xff9f00,
  pick: 0x5bc8ff,
  grid1: 0x333333,
  grid2: 0x282828,
  // Face-classification palette (driver.py result.cavities[*].kind = K0..K6)
  // K0=Stirn+ (rechte Stirnseite), K1=Stirn- (linke Stirnseite),
  // K2=Krone (Oberseite), K3=Fundament (Unterseite),
  // K4=Front (Luftseite), K5=Back (Erdseite), K6=Schaleinlagen (Nischen).
  classes: {
    // 7 maximal unterscheidbare Farbtöne (vorher waren K2/K3 beide blau und
    // K4/K5 beide grün → schwer trennbar). Jetzt: rot / orange / blau / violett
    // / grün / teal / gelb — jede Klasse ein eigener Farbton.
    K0: 0xe53935, // Stirn +    rot
    K1: 0xfb8c00, // Stirn −    orange
    K2: 0x2196f3, // Krone      blau
    K3: 0x8e24aa, // Fundament  violett
    K4: 0x66bb6a, // Front/Luft grün
    K5: 0x00897b, // Back/Erd   teal
    K6: 0xd81b9a, // Schaleinlagen/Nischen — Magenta (~38° von K0-Rot, distinkt vom orangen K1)
  } as Record<string, number>,
} as const;

export const CLASS_KEYS = ["K0", "K1", "K2", "K3", "K4", "K5", "K6"] as const;
export type ClassKey = (typeof CLASS_KEYS)[number];

type MeshKind = "wall" | "cavity" | "context";
type Pickable = THREE.Mesh & {
  userData: {
    kind: MeshKind;
    label: string;
    baseColor: number;
    baseOpacity: number;
    baseTransparent: boolean;
    // Section-cap tagging (read by sectionCaps.ts).
    capColor?: number;
    classKey?: string;
    // IFC-Element-Identität (für den Element-Inspektor: isolateElement/fitToElement).
    element_guid?: string;
  };
};

export function initViewer3d(host: HTMLElement): Viewer3D {
  // ---- Renderer ---------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    logarithmicDepthBuffer: true,
    // preserveDrawingBuffer keeps the colour buffer readable after a render so
    // the BCF exporter (captureIssueSnapshot) can pull a PNG via toDataURL on
    // demand instead of racing the requestAnimationFrame clear. Minor perf cost,
    // acceptable for this app's single-model viewport.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Local clipping enabled: per-material clippingPlanes are honoured. Used
  // by setSectionPlane() to cut through the wall mesh + cavity submeshes
  // without affecting annotations (their materials don't get the plane).
  renderer.localClippingEnabled = true;
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.appendChild(renderer.domElement);

  // ---- Scene + background gradient (CSS, behind canvas) -----------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  // Layered gradient via host element (canvas keeps transparent alpha).
  host.style.background =
    "linear-gradient(180deg, #1f2125 0%, #1a1a1a 55%, #161616 100%)";

  // ---- Camera ----------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(
    45,
    host.clientWidth / host.clientHeight,
    0.01,
    100000,
  );
  camera.position.set(20, 18, 22);
  camera.lookAt(0, 0, 0);

  // ---- Controls (IFC-Editor feel) --------------------------------------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 1.4;
  controls.rotateSpeed = 1.0;
  controls.panSpeed = 1.0;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = 0.01;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.addEventListener("change", () => {
    needsRender = true;
  });

  // ---- Lights (3-point + below-fill, ported from IFC-Editor) ----------
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(50, 100, 50);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-50, 50, -50);
  scene.add(fill);
  const below = new THREE.DirectionalLight(0xffffff, 0.25);
  below.position.set(0, -100, 0);
  scene.add(below);

  // ---- Corner axis gizmo (bottom-left, co-rotating with the camera) ----
  // The world-origin AxesHelper used to sit at the scene centre; per user
  // feedback it now lives as a small overlay in the BOTTOM-LEFT corner that
  // mirrors the main camera orientation. It is drawn in a scissored viewport
  // inside the render loop (see below), so it overlays the model in the corner.
  const gizmoScene = new THREE.Scene();
  const gizmoCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 100);
  gizmoScene.add(new THREE.AxesHelper(1));
  const _gizmoLabel = (txt: string, hex: string, at: THREE.Vector3): void => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const cx = c.getContext("2d")!;
    cx.fillStyle = hex;
    cx.font = "bold 46px Arial";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(txt, 32, 34);
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }),
    );
    sp.position.copy(at);
    sp.scale.set(0.62, 0.62, 0.62);
    gizmoScene.add(sp);
  };
  // Match AxesHelper default colours: X red, Y green, Z blue.
  _gizmoLabel("X", "#ff5b52", new THREE.Vector3(1.32, 0, 0));
  _gizmoLabel("Y", "#5fd35f", new THREE.Vector3(0, 1.32, 0));
  _gizmoLabel("Z", "#4aa3ff", new THREE.Vector3(0, 0, 1.32));
  const GIZMO_PX = 86;        // overlay box size (CSS px) — desktop
  const GIZMO_X = 12;         // left margin (CSS px)
  // Bottom margin is computed per-frame (adaptive) in the render loop: lower on
  // desktop than before and much lower on short (mobile) canvases, where 96 px
  // sat a third of the way up. See `gizmoY` below.
  const _gizmoDir = new THREE.Vector3();
  const _rendSize = new THREE.Vector2();

  // ---- Layer groups ----------------------------------------------------
  // Bug 1 fix: IFC is Z-up, Three.js is Y-up. Wrap all scene content in
  // a parent group rotated -90deg around X so loaded meshes stand upright
  // (wall vertical, terrain horizontal, view-cube "top" looks down on plan).
  // Helpers (grid/axes/view-cube/HUD) stay world-aligned for UI consistency.
  const sceneContent = new THREE.Group();
  sceneContent.rotation.x = -Math.PI / 2;
  scene.add(sceneContent);

  const layers: Record<string, THREE.Group> = {
    wall: new THREE.Group(),
    cavities: new THREE.Group(),
    context: new THREE.Group(),
  };
  for (const g of Object.values(layers)) sceneContent.add(g);
  // Wall mesh ON by default (user request: "Modell standardmässig an"). The wall
  // renders as a FrontSide translucent shell (see buildMesh), so it no longer
  // washes out the coincident K-class submeshes the way the old DoubleSide wall
  // did. The rail "Modell" toggle reflects this default (button starts "on").
  layers.wall.visible = true;

  // Edges container so it follows layer visibility.
  const edgeGroups: Record<string, THREE.Group> = {
    wall: new THREE.Group(),
    cavities: new THREE.Group(),
    context: new THREE.Group(),
  };
  for (const k of Object.keys(edgeGroups)) layers[k].add(edgeGroups[k]);
  // User intent for edge visibility per layer (default visible). Used so the
  // edge on/off toggle ALSO suppresses the per-submesh finding edges drawn
  // during isolation (guided mode) — not just the merged edge overlay.
  const edgesUserVisible: Record<string, boolean> = { wall: true, cavities: true, context: true };

  // Bug 3 prep: per-class sub-groups inside layers.cavities so we can
  // toggle K0..K6 individually via setLayerVisible("K3", false).
  const classGroups: Record<string, THREE.Group> = {};
  for (const k of CLASS_KEYS) {
    const g = new THREE.Group();
    classGroups[k] = g;
    layers.cavities.add(g);
  }

  // ---- State -----------------------------------------------------------
  let needsRender = true;

  // Recolour the 3D scene background + host element (theme switch). The host
  // gradient is replaced with a flat colour matching the requested hex so the
  // canvas edges blend with the new theme surface.
  function setViewerBackground(hex: number): void {
    scene.background = new THREE.Color(hex);
    host.style.background = "#" + hex.toString(16).padStart(6, "0");
    // Keep the 3D ViewCube legible after a theme switch (rebuilds face
    // textures + edge colour for the new light/dark palette). Hoisted decl,
    // so referencing it here (before its definition) is safe at call time.
    refreshViewCubeTheme();
    needsRender = true;
  }
  // Coalesce section-cap rebuilds (esp. Ctrl+wheel drag) to once per frame.
  let capsDirty = false;
  let wireframe = false;
  let extraTransparent = false;
  let hovered: Pickable | null = null;
  let picked: Pickable | null = null;
  const pickables: Pickable[] = [];

  // ---- HUD: view-cube, status, footer (DOM elements) -------------------
  // (Die obere Shortcut-/Maus-Legende wurde entfernt — unnötiger Text über dem
  //  Viewport; die Bedienung erschliesst sich aus den Werkzeugen.)

  // Bottom-left HUD (FPS + count + zoom)
  const hud = document.createElement("div");
  hud.id = "view-hud";
  // Colours/typography live in style.css (#view-hud) so the overlay follows the
  // active light/dark theme; only positioning stays inline. Sitzt UNTER dem
  // Achsenkreuz-Gizmo (bottom 38–124px); FPS daher ganz unten links.
  // Unten RECHTS, knapp über der Status-/Fussleiste: links unten sitzt das
  // Achsenkreuz-Gizmo, oben rechts der ViewCube — die rechte untere Ecke ist frei.
  hud.style.cssText =
    "position:absolute;right:12px;bottom:36px;z-index:10;pointer-events:none;text-align:right;";
  hud.textContent = "fps — · 0 obj · zoom —";
  host.appendChild(hud);

  // ---- 3D ViewCube (top-right, co-rotating with the main camera) -------
  // Replaces the former 2D 3x3 grid of view buttons. The cube is a real
  // labelled THREE box rendered into a scissored viewport in the TOP-RIGHT
  // corner of the MAIN renderer (same technique as the bottom-left axis
  // gizmo, no second WebGL context). Its camera mirrors the main camera each
  // frame, so the cube turns exactly like the model. Clicking a face snaps
  // the camera to that view via setView(); a small ISO button sits beneath.
  //
  // Coordinate mapping (verified against the X/Y/Z axis gizmo, which shows
  // the Three.js WORLD axes because gizmoCam mirrors the main camera the same
  // way): the cube lives in the same world frame, so its face normals are in
  // Three.js world space and map 1:1 to setView()'s `dirs`:
  //   +Y OBEN→top  -Y UNTEN→bottom  +Z VORN→front  -Z HINTEN→back
  //   +X RECHTS→right  -X LINKS→left
  const VC_PX = 96;          // overlay box size (CSS px)
  const VC_MARGIN = 12;      // margin from the top/right edges (CSS px)
  // Transparent DOM region over the cube so we can capture pointer events for
  // hover/click without blocking orbit elsewhere. Positioned to match the
  // scissored viewport rect exactly (top-right).
  const cube = document.createElement("div");
  cube.id = "view-cube";
  cube.style.cssText =
    `position:absolute;right:${VC_MARGIN}px;top:${VC_MARGIN}px;` +
    `width:${VC_PX}px;height:${VC_PX}px;z-index:10;cursor:pointer;`;
  cube.title = "Ansichtswürfel — Fläche klicken für Ansicht";
  host.appendChild(cube);
  // Tiny ISO affordance beneath the cube (the old grid had an Iso cell).
  const isoBtn = document.createElement("button");
  isoBtn.id = "view-cube-iso";
  isoBtn.textContent = "Isometrie";
  isoBtn.title = "Isometrie (1)";
  isoBtn.style.cssText =
    `position:absolute;right:${VC_MARGIN}px;top:${VC_MARGIN + VC_PX + 4}px;` +
    `z-index:10;`;
  // Einzelklick → Isometrie; Doppelklick → Iso um 90° um die (wahrgenommene)
  // vertikale Achse drehen (jeder Doppelklick +90°). Debounce, damit der
  // Einzelklick nicht vor dem Doppelklick als Reset feuert.
  let _isoClickTimer: ReturnType<typeof setTimeout> | null = null;
  isoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_isoClickTimer) return;
    _isoClickTimer = setTimeout(() => { _isoClickTimer = null; setView("iso"); }, 220);
  });
  isoBtn.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (_isoClickTimer) { clearTimeout(_isoClickTimer); _isoClickTimer = null; }
    const _t = controls.target.clone();
    const _off = camera.position.clone().sub(_t);
    _off.applyAxisAngle(camera.up.clone().normalize(), Math.PI / 2);
    camera.position.copy(_t).add(_off);
    controls.update();
    needsRender = true;
  });
  host.appendChild(isoBtn);

  // -- ViewCube scene: a labelled box + edge lines, mirrored to main camera --
  const vcScene = new THREE.Scene();
  const vcCam = new THREE.OrthographicCamera(-1.45, 1.45, 1.45, -1.45, 0.1, 100);
  // Soft lighting so the box reads as a solid (not flat) cube.
  vcScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const vcKey = new THREE.DirectionalLight(0xffffff, 0.5);
  vcKey.position.set(2, 3, 4);
  vcScene.add(vcKey);

  // Face order of BoxGeometry materials: +X, -X, +Y, -Y, +Z, -Z.
  type VCFace = { label: string; view: ViewName };
  const VC_FACES: VCFace[] = [
    { label: "RECHTS", view: "right" },  // +X
    { label: "LINKS", view: "left" },    // -X
    { label: "OBEN", view: "top" },      // +Y
    { label: "UNTEN", view: "bottom" },  // -Y
    { label: "VORN", view: "front" },    // +Z
    { label: "HINTEN", view: "back" },   // -Z
  ];
  // Build one CanvasTexture per face with the German label drawn on it. Colours
  // are theme-aware (light face + dark text in light mode, and vice versa) so
  // the cube stays legible; rebuilt on theme change via refreshViewCubeTheme().
  function vcFaceTexture(label: string, faceHex: string, textHex: string): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const cx = c.getContext("2d")!;
    cx.fillStyle = faceHex;
    cx.fillRect(0, 0, 128, 128);
    // subtle inset border so individual faces read apart from each other
    cx.strokeStyle = textHex;
    cx.globalAlpha = 0.35;
    cx.lineWidth = 4;
    cx.strokeRect(4, 4, 120, 120);
    cx.globalAlpha = 1;
    cx.fillStyle = textHex;
    // shrink font for the longer labels so they fit the 128px face
    cx.font = `bold ${label.length > 4 ? 20 : 24}px Arial`;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(label, 64, 66);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }
  const vcMaterials: THREE.MeshLambertMaterial[] = VC_FACES.map(
    () => new THREE.MeshLambertMaterial({ color: 0xffffff }),
  );
  const vcBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), vcMaterials);
  vcScene.add(vcBox);
  // Edge lines so the silhouette reads crisply as a cube.
  const vcEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(vcBox.geometry),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  vcBox.add(vcEdges);
  // Base emissive per face material; hover brightens this for affordance.
  function refreshViewCubeTheme(): void {
    const light = document.documentElement.dataset.theme !== "dark";
    const faceHex = light ? "#f3f5f8" : "#33373d";
    const textHex = light ? "#1d2430" : "#e7ebf1";
    const edgeHex = light ? 0x6b7686 : 0x9aa4b2;
    for (let i = 0; i < vcMaterials.length; i++) {
      const m = vcMaterials[i];
      m.map?.dispose();
      m.map = vcFaceTexture(VC_FACES[i].label, faceHex, textHex);
      m.emissive.setHex(0x000000);
      m.needsUpdate = true;
    }
    (vcEdges.material as THREE.LineBasicMaterial).color.setHex(edgeHex);
    needsRender = true;
  }
  refreshViewCubeTheme();

  // Hover/click: raycast the cube using its own camera + pointer NDC computed
  // WITHIN the cube's screen rect (top-right square). The viewport is square so
  // NDC is a straightforward remap of the pointer offset inside `cube`.
  const vcRaycaster = new THREE.Raycaster();
  const vcNdc = new THREE.Vector2();
  let vcHover = -1; // index into vcMaterials of the currently highlighted face
  function vcSetHover(idx: number): void {
    if (idx === vcHover) return;
    if (vcHover >= 0) vcMaterials[vcHover].emissive.setHex(0x000000);
    vcHover = idx;
    if (vcHover >= 0) {
      const light = document.documentElement.dataset.theme !== "dark";
      vcMaterials[vcHover].emissive.setHex(light ? 0x2a6df0 : 0x3a7bff);
    }
    needsRender = true;
  }
  function vcPick(ev: PointerEvent): VCFace | null {
    const r = cube.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    vcNdc.x = (x / r.width) * 2 - 1;
    vcNdc.y = -(y / r.height) * 2 + 1;
    vcRaycaster.setFromCamera(vcNdc, vcCam);
    const hits = vcRaycaster.intersectObject(vcBox, false);
    if (!hits.length) return null;
    // materialIndex of the hit triangle → face index → VC_FACES entry.
    const mi = hits[0].face?.materialIndex ?? -1;
    if (mi < 0 || mi >= VC_FACES.length) return null;
    return VC_FACES[mi];
  }
  cube.addEventListener("pointermove", (ev) => {
    const r = cube.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    vcNdc.x = (x / r.width) * 2 - 1;
    vcNdc.y = -(y / r.height) * 2 + 1;
    vcRaycaster.setFromCamera(vcNdc, vcCam);
    const hits = vcRaycaster.intersectObject(vcBox, false);
    const mi = hits.length ? (hits[0].face?.materialIndex ?? -1) : -1;
    vcSetHover(mi);
  });
  cube.addEventListener("pointerleave", () => vcSetHover(-1));
  cube.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    const face = vcPick(ev);
    if (face) setView(face.view);
  });

  // Crosshair cursor when panning (RMB held)
  let panning = false;
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (ev.button === 2) {
      panning = true;
      renderer.domElement.style.cursor = "crosshair";
    }
  });
  window.addEventListener("pointerup", () => {
    if (panning) {
      panning = false;
      renderer.domElement.style.cursor = "grab";
    }
  });
  renderer.domElement.style.cursor = "grab";

  // ---- Mesh building --------------------------------------------------
  // Perf: per-layer accumulators for merged edge geometry. Instead of
  // building one EdgesGeometry+LineSegments per cavity (50+ draw calls on
  // dense models), we accumulate raw edge-position floats per layer key
  // and emit ONE merged LineSegments per layer at the end of renderResult.
  type EdgeAccum = { positions: number[]; color: number };
  const edgeAccum: Record<string, EdgeAccum> = {};

  function _accumulateEdges(
    geom: THREE.BufferGeometry,
    layerKey: string,
    color: number,
    matrix: THREE.Matrix4 | null = null,
  ): void {
    // Only render edges across real geometric breaks. Same threshold as the
    // crease-angle normals (FEATURE_EDGE_DEG) so each visible edge line sits
    // exactly on a shading break — and on a face-classification boundary.
    const eg = new THREE.EdgesGeometry(geom, FEATURE_EDGE_DEG);
    const pos = eg.getAttribute("position") as THREE.BufferAttribute;
    const buf = edgeAccum[layerKey] || (edgeAccum[layerKey] = { positions: [], color });
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (matrix) v.applyMatrix4(matrix);
      buf.positions.push(v.x, v.y, v.z);
    }
    eg.dispose();
  }

  function _flushEdges(): void {
    for (const layerKey of Object.keys(edgeAccum)) {
      const buf = edgeAccum[layerKey];
      if (!buf.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions, 3));
      const m = new THREE.LineBasicMaterial({
        // Netzkanten dezenter: deutlich reduzierte Deckkraft (vorher 0.35), sodass
        // die Triangulierung/Geometrie nur noch leicht angedeutet ist.
        color: buf.color, transparent: true, opacity: 0.18,
      });
      const ls = new THREE.LineSegments(g, m);
      const target = edgeGroups[layerKey];
      if (target) target.add(ls);
    }
    for (const k of Object.keys(edgeAccum)) delete edgeAccum[k];
  }

  function buildMesh(
    src: DetectionMesh,
    color: number,
    kind: MeshKind,
    label: string,
    opts: {
      transparent?: boolean;
      opacity?: number;
      edgeColor?: number;
      edgeLayer?: string;
    } = {},
  ): { mesh: Pickable } | null {
    if (!src || !src.vertices || !src.faces) return null;
    if (src.vertices.length < 9 || src.faces.length < 3) return null;
    let geom: THREE.BufferGeometry = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(src.vertices, 3),
    );
    geom.setIndex(src.faces);
    // Weld coincident vertices first. The niche/class submeshes arrive from the
    // detector as UNWELDED triangle soups (each triangle its own 3 vertices);
    // welding gives the edge overlay (EdgesGeometry) clean shared topology so it
    // draws only REAL geometric breaks (niche edges, corners), not every triangle.
    geom = mergeVertices(geom);
    // CREASE-ANGLE normals instead of plain computeVertexNormals(). web-ifc emits
    // FLAT per-face normals; the IFC-Editor uses them verbatim → every planar face
    // is uniform. We previously ran computeVertexNormals(), which averages a
    // vertex's normal over ALL adjacent faces — including the ~90° K-class corners
    // of the whole-wall mesh. That tilts the flat-face boundary normals toward the
    // perpendicular neighbour, producing a shading gradient that breaks along the
    // triangulation diagonals (visible as ugly "Schattierung" on the transparent /
    // light wall, but not on the per-class opaque submeshes which are near-coplanar).
    // FAST smooth normals. toCreasedNormals (crease-aware, no corner-bleed) was
    // too slow on large models — it string-hashes every vertex on the main
    // thread + un-indexes the geometry, which blew up the load time even when
    // restricted to the wall. computeVertexNormals is native + fast. Any residual
    // corner-bleed on the transparent wall is largely hidden because the opaque
    // class faces win the depth test (polygonOffset) and render clean on top.
    geom.computeVertexNormals();
    const transparent = !!opts.transparent;
    const opacity = opts.opacity ?? 1.0;
    // Smooth shading for ALL meshes (flatShading:false) consumes the crease-angle
    // vertex normals above.
    // Transparent WALL → FrontSide (single near layer) + polygonOffset "back".
    // The transparent wall is coincident with the OPAQUE K-class faces. Without
    // help, the blended wall tints/darkens those faces AND its own front/back +
    // curved self-overlap accumulate (the darkening that shifts on rotation).
    // Fix that stays in the normal blend pipeline (no dithering → no grain):
    //   • FrontSide → no front/back double-blend;
    //   • polygonOffset pushes the wall's tested depth slightly BACK (works even
    //     with depthWrite off) so the coincident opaque faces — written in the
    //     opaque pass — WIN the depth test and render perfectly clean (no tint,
    //     no "Verdunklung"). The wall only blends where there is no face (gaps /
    //     silhouette / classification off).
    // Open surfaces (terrain/context) keep DoubleSide blending.
    const isWall = kind === "wall";
    const wallTransparent = isWall && transparent;
    const mat = new THREE.MeshLambertMaterial({
      color,
      transparent,
      opacity,
      side: (transparent && !isWall) ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: !transparent,
      flatShading: false,
    });
    // Keep the colored class faces ON the volume (full colour, not dimmed by the
    // overlying transparent wall). The wall and the K-class submeshes are
    // coincident, so we separate them in the depth test from BOTH sides:
    //   • the transparent WALL is pushed BACK (positive polygonOffset),
    //   • the opaque CAVITY faces are pulled FORWARD (negative polygonOffset).
    // A generous bias covers any sub-mm mismatch between the wall mesh and the
    // submeshes, so the faces reliably win the depth test → the wall never blends
    // over them. The wall still shows in gaps / silhouette / classification-off.
    // Bug fix "Klassifikationsflächen bleiben kräftig farbig": the wall mesh
    // renders translucent (opacity 0.45) and COINCIDENT with the opaque K-class
    // faces. With logarithmicDepthBuffer enabled (see WebGLRenderer config),
    // polygonOffset alone is not always enough to keep the wall behind the class
    // faces — at some view angles the grey wall wins the depth test and BLENDS
    // over them, washing the colour out as soon as the model is switched on.
    // We therefore separate them with a LARGER bias from both sides AND a hard
    // renderOrder so the opaque colour faces are guaranteed to be visible in
    // FRONT of the translucent reference wall (full, undimmed colour).
    if (wallTransparent) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 8;
      mat.polygonOffsetUnits = 16;
    } else if (kind === "cavity") {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -8;
      mat.polygonOffsetUnits = -16;
    }
    if (wallTransparent) {
      // Geometric depth separation — robust under logarithmicDepthBuffer, where
      // polygonOffset alone is NOT reliable: nudge the translucent reference wall
      // a hair INWARD along its own normals so the coincident OPAQUE K-class
      // faces always win the depth test and keep their full, vivid colour. The
      // wall still shows in gaps / at the silhouette / when classification is off.
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      const _bb = geom.boundingBox;
      const _diag = _bb ? _bb.min.distanceTo(_bb.max) : 1;
      const _eps = Math.min(0.02, Math.max(0.0015, _diag * 3e-4));
      const _p = geom.attributes.position as THREE.BufferAttribute;
      const _n = geom.attributes.normal as THREE.BufferAttribute;
      for (let _i = 0; _i < _p.count; _i++) {
        _p.setXYZ(
          _i,
          _p.getX(_i) - _n.getX(_i) * _eps,
          _p.getY(_i) - _n.getY(_i) * _eps,
          _p.getZ(_i) - _n.getZ(_i) * _eps,
        );
      }
      _p.needsUpdate = true;
      geom.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geom, mat) as unknown as Pickable;
    // Draw the translucent reference wall BEFORE the coloured class faces so the
    // opaque K-class faces paint last and cannot be tinted/washed out by the
    // wall's blend. (Opaque vs. transparent pass ordering already separates them,
    // but the explicit renderOrder keeps it deterministic across angles.)
    if (wallTransparent) mesh.renderOrder = 0;
    else if (kind === "cavity") mesh.renderOrder = 1;
    mesh.userData = {
      kind,
      label,
      baseColor: color,
      baseOpacity: opacity,
      baseTransparent: transparent,
    };

    if (opts.edgeColor !== undefined && opts.edgeLayer) {
      _accumulateEdges(geom, opts.edgeLayer, opts.edgeColor);
    }
    return { mesh };
  }

  function pickContextColor(ifc_type: string): number {
    const t = ifc_type.toLowerCase();
    if (t.includes("site") || t.includes("geographic"))
      return COLORS.context_terrain;
    if (t.includes("road") || t.includes("pavement") || t.includes("course"))
      return COLORS.context_road;
    return COLORS.context_other;
  }

  function clearAll() {
    pickables.length = 0;
    for (const layerKey of Object.keys(layers)) {
      const g = layers[layerKey];
      g.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh || (obj as THREE.LineSegments).isLine) {
          (obj as THREE.Mesh).geometry?.dispose?.();
          const m = (obj as THREE.Mesh).material as
            | THREE.Material
            | THREE.Material[];
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m?.dispose?.();
        }
      });
      // Clear all children, then re-attach the persistent edge sub-group
      // and (for cavities) the K0..K6 class sub-groups.
      const persistentEdges = edgeGroups[layerKey];
      g.clear();
      if (persistentEdges) {
        persistentEdges.clear();
        g.add(persistentEdges);
      }
      if (layerKey === "cavities") {
        for (const k of CLASS_KEYS) {
          classGroups[k].clear();
          g.add(classGroups[k]);
        }
      }
    }
    hovered = null;
    picked = null;
  }

  // ---- Fit-to-view with smooth tween (400ms) --------------------------
  let tweenRAF = 0;
  function fitCameraToBox(box: THREE.Box3, animate = true) {
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = size.length() / 2;
    if (!isFinite(radius) || radius <= 0) return;
    const fov = camera.fov * (Math.PI / 180);
    const aspect = camera.aspect;
    const horizFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const effFov = Math.min(fov, horizFov);
    const dist = (radius / Math.sin(effFov / 2)) * 1.25;

    let dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.length() < 1e-4) dir.set(1, 0.6, 1);
    dir.normalize();

    const targetPos = center.clone().addScaledVector(dir, dist);
    const targetTgt = center.clone();
    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    camera.far = Math.max(1000, maxDim * 50);
    camera.updateProjectionMatrix();

    if (!animate) {
      camera.position.copy(targetPos);
      controls.target.copy(targetTgt);
      controls.update();
      needsRender = true;
      return;
    }

    const startPos = camera.position.clone();
    const startTgt = controls.target.clone();
    const t0 = performance.now();
    const dur = 400;
    cancelAnimationFrame(tweenRAF);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      camera.position.lerpVectors(startPos, targetPos, e);
      controls.target.lerpVectors(startTgt, targetTgt, e);
      controls.update();
      needsRender = true;
      if (t < 1) tweenRAF = requestAnimationFrame(step);
    };
    tweenRAF = requestAnimationFrame(step);
  }

  function fit() {
    const box = new THREE.Box3();
    let any = false;
    for (const g of Object.values(layers)) {
      g.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox;
          if (b) {
            box.union(b.clone().applyMatrix4(obj.matrixWorld));
            any = true;
          }
        }
      });
    }
    if (!any) return;
    fitCameraToBox(box, true);
  }

  // ---- Element-Inspektor: nur EIN IFC-Element (per GUID) zeigen + zoomen ----
  // Speichert die Layer-Sichtbarkeit beim ersten Isolieren, damit clear() sie
  // exakt wiederherstellt. Cavity-Meshes werden per mesh.visible gefiltert
  // (unabhängig von der Klassen-Gruppen-Sichtbarkeit); Wand + Kontext werden
  // ausgeblendet, solange isoliert ist.
  let _isoSaved: { wall: boolean; context: boolean } | null = null;
  function isolateElement(guid: string | null) {
    if (guid === null) {
      for (const p of pickables) {
        if (p.userData.kind === "cavity") p.visible = true;
      }
      if (_isoSaved) {
        layers.wall.visible = _isoSaved.wall;
        layers.context.visible = _isoSaved.context;
        _isoSaved = null;
      }
      needsRender = true;
      return;
    }
    if (!_isoSaved) {
      _isoSaved = { wall: layers.wall.visible, context: layers.context.visible };
    }
    layers.wall.visible = false;
    layers.context.visible = false;
    for (const p of pickables) {
      if (p.userData.kind === "cavity") {
        p.visible = p.userData.element_guid === guid;
      }
    }
    needsRender = true;
  }
  // Frame the camera TIGHT onto the affected element(s) only, keeping the rule
  // view's direction/up/fov. Guided walkthrough uses this so the view really fits
  // the element (not a wide rule-feature box). Falls back to the plain view when
  // no guids / no matching geometry.
  function fitToElements(guids: string[] | null, view: IssueView, opts: { animate?: boolean } = {}): void {
    const set = guids && guids.length ? new Set(guids) : null;
    if (!set) { setIssueView(view, opts); return; }
    const box = new THREE.Box3();
    for (const p of pickables) {
      if (p.userData.kind !== "cavity") continue;
      if (!set.has(p.userData.element_guid as string)) continue;
      box.expandByObject(p);
    }
    if (box.isEmpty()) { setIssueView(view, opts); return; }
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(view.cameraPos[0], view.cameraPos[1], view.cameraPos[2])
      .sub(new THREE.Vector3(view.target[0], view.target[1], view.target[2]));
    if (dir.lengthSq() < 1e-9) dir.set(1, -1, 1);
    dir.normalize();
    const fov = ((view.fovDeg ?? 45) * Math.PI) / 180;
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.2;
    const cam = center.clone().addScaledVector(dir, dist);
    setIssueView({
      cameraPos: [cam.x, cam.y, cam.z],
      target: [center.x, center.y, center.z],
      up: view.up,
      fovDeg: view.fovDeg,
    }, opts);
  }
  function fitToElement(guid: string) {
    const box = new THREE.Box3();
    let any = false;
    for (const p of pickables) {
      if (p.userData.kind !== "cavity" || p.userData.element_guid !== guid) continue;
      const geom = p.geometry as THREE.BufferGeometry;
      geom.computeBoundingBox();
      const b = geom.boundingBox;
      if (b) {
        box.union(b.clone().applyMatrix4(p.matrixWorld));
        any = true;
      }
    }
    if (any) fitCameraToBox(box, true);
  }

  // Beliebiges Produkt per GUID fokussieren — auch KONTEXT-Bauteile (Fundamente),
  // die NICHT in wall_metrics stehen und für die selectElementByGuid nichts tut.
  // Kontext einblenden, Bbox über alle Meshes mit dieser element_guid (Cavities +
  // Kontext) bilden und die Kamera darauf einpassen. Für den L5-Fundament-Link.
  function focusProduct(guid: string): void {
    if (!guid) return;
    isolateElement(null);            // evtl. Isolation aufheben → Kontext/Wand sichtbar
    layers.context.visible = true;
    const box = new THREE.Box3();
    let any = false;
    const add = (m: THREE.Mesh) => {
      if (!m.isMesh || m.userData?.element_guid !== guid) return;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      if (b) { box.union(b.clone().applyMatrix4(m.matrixWorld)); any = true; }
    };
    layers.context.traverse((o) => add(o as THREE.Mesh));
    for (const p of pickables) add(p as unknown as THREE.Mesh);
    if (any && !box.isEmpty()) fitCameraToBox(box, true);
    needsRender = true;
  }

  // ---- Predefined views (1-7) ----------------------------------------
  type ViewName = "iso" | "back" | "top" | "bottom" | "left" | "right" | "front";
  function setView(view: ViewName) {
    const box = new THREE.Box3();
    let any = false;
    for (const g of Object.values(layers)) {
      g.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox;
          if (b) {
            box.union(b.clone().applyMatrix4(obj.matrixWorld));
            any = true;
          }
        }
      });
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    if (any) {
      box.getCenter(center);
      box.getSize(size);
    } else {
      size.set(20, 20, 20);
    }
    const radius = Math.max(size.length() / 2, 1);
    const fov = camera.fov * (Math.PI / 180);
    const dist = (radius / Math.sin(fov / 2)) * 1.3;
    const dirs: Record<ViewName, THREE.Vector3> = {
      iso: new THREE.Vector3(1, 0.7, 1).normalize(),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      top: new THREE.Vector3(0, 1, 0.001).normalize(),
      bottom: new THREE.Vector3(0, -1, 0.001).normalize(),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
    };
    const targetPos = center.clone().addScaledVector(dirs[view], dist);
    const targetTgt = center.clone();
    const startPos = camera.position.clone();
    const startTgt = controls.target.clone();
    const t0 = performance.now();
    const dur = 350;
    cancelAnimationFrame(tweenRAF);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(startPos, targetPos, e);
      controls.target.lerpVectors(startTgt, targetTgt, e);
      controls.update();
      needsRender = true;
      if (t < 1) tweenRAF = requestAnimationFrame(step);
    };
    tweenRAF = requestAnimationFrame(step);
  }

  // ---- Picking / hover (raycaster) -----------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // three.js' Raycaster IGNORES object visibility — it intersects every object
  // handed to it regardless of `.visible` on the object or any ancestor group.
  // The wall mesh lives in `layers.wall`, which is HIDDEN by default
  // (layers.wall.visible = false), yet it stays in `pickables`. Without this
  // filter a click silently hits the invisible wall (one whole element) and
  // selects nearly the entire model; it also makes the hit order flip between
  // wall and cavity, which broke the deselect-toggle (we toggle by mesh
  // identity). We therefore raycast ONLY against currently-visible pickables —
  // walking the parent chain so a hidden layer or class subgroup
  // (SHIFT-1..7 toggles classGroups[*].visible) is excluded too.
  function effectivelyVisible(obj: THREE.Object3D | null): boolean {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }
  function visiblePickables(): Pickable[] {
    return pickables.filter((p) => effectivelyVisible(p));
  }

  // Ein Trefferpunkt ist weggeschnitten, wenn er auf der entfernten Seite einer
  // aktiven Schnitt-/Clip-Ebene liegt (three.js behält die +Normalen-Halbseite).
  // Der Raycaster ignoriert Clipping-Planes von sich aus → ohne diesen Filter
  // liesse sich die unsichtbare (weggeschnittene) Geometrie weiter anwählen.
  function pointClipped(p: THREE.Vector3): boolean {
    for (const pl of sectionPlanes) if (pl.distanceToPoint(p) < -1e-4) return true;
    for (const cp of clipPlanes) if (cp.plane.distanceToPoint(p) < -1e-4) return true;
    return false;
  }

  function pickAt(clientX: number, clientY: number): Pickable | null {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(visiblePickables(), false);
    for (const h of hits) if (!pointClipped(h.point)) return h.object as Pickable;
    return null;
  }

  // Face-level pick: raycast returns intersection.faceIndex (triangle id);
  // we extract that single triangle's 3 vertex positions and render a tiny
  // overlay BufferGeometry on top of the scene in cyan.
  let pickOverlay: THREE.Mesh | null = null;
  function clearFacePick() {
    if (pickOverlay) {
      // WICHTIG: showFacePick hängt das Overlay an `scene` (Welt-Koordinaten,
      // NICHT an das um -90° X gedrehte `sceneContent`). Es muss daher auch von
      // `scene` entfernt werden. Vorher stand hier sceneContent.remove(...) —
      // ein No-op gegen den falschen Parent: das Mesh blieb im Szenengraph,
      // und nach geometry.dispose() lädt three.js die noch vorhandenen
      // JS-Attribute beim nächsten Frame neu hoch → das cyan Overlay blieb
      // sichtbar (das „Deselektieren" wirkte wirkungslos).
      scene.remove(pickOverlay);
      pickOverlay.geometry.dispose();
      (pickOverlay.material as THREE.Material).dispose();
      pickOverlay = null;
      needsRender = true;
    }
  }
  function rayIntersect(clientX: number, clientY: number): THREE.Intersection | null {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(visiblePickables(), false);
    // Prefer the nearest ELEMENT hit (a cavity/class face carrying element_guid)
    // over the coincident whole-model reference WALL — otherwise a single click
    // lands on the wall and "selects the whole model". Fall back to any non-
    // clipped hit (e.g. classification toggled off → only the wall is present).
    let fallback: THREE.Intersection | null = null;
    for (const h of hits) {
      if (pointClipped(h.point)) continue;
      if ((h.object as Pickable).userData?.element_guid) return h;
      if (!fallback) fallback = h;
    }
    return fallback;
  }
  function trianglePositions(mesh: THREE.Mesh, faceIdxs: number[]): Float32Array {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const idx = geom.getIndex();
    const out = new Float32Array(faceIdxs.length * 9);
    const v = new THREE.Vector3();
    for (let i = 0; i < faceIdxs.length; i++) {
      const f = faceIdxs[i];
      const a = idx ? idx.getX(f * 3) : f * 3;
      const b = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const c = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      v.fromBufferAttribute(pos, a).applyMatrix4(mesh.matrixWorld); out.set([v.x, v.y, v.z], i * 9);
      v.fromBufferAttribute(pos, b).applyMatrix4(mesh.matrixWorld); out.set([v.x, v.y, v.z], i * 9 + 3);
      v.fromBufferAttribute(pos, c).applyMatrix4(mesh.matrixWorld); out.set([v.x, v.y, v.z], i * 9 + 6);
    }
    return out;
  }
  function triArea(p: Float32Array, off: number): number {
    const ax = p[off + 3] - p[off], ay = p[off + 4] - p[off + 1], az = p[off + 5] - p[off + 2];
    const bx = p[off + 6] - p[off], by = p[off + 7] - p[off + 1], bz = p[off + 8] - p[off + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  function faceNormal(mesh: THREE.Mesh, f: number, out: THREE.Vector3): void {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const idx = geom.getIndex();
    const a = idx ? idx.getX(f * 3) : f * 3;
    const b = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
    const c = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
    const va = new THREE.Vector3().fromBufferAttribute(pos, a);
    const vb = new THREE.Vector3().fromBufferAttribute(pos, b);
    const vc = new THREE.Vector3().fromBufferAttribute(pos, c);
    out.copy(vb).sub(va).cross(new THREE.Vector3().copy(vc).sub(va)).normalize();
  }
  const ADJ_TRI_CAP = 50000;
  function buildAdjacency(mesh: THREE.Mesh): Record<number, number[]> | null {
    const cached = (mesh.userData as { adjacency?: Record<number, number[]> | null }).adjacency;
    if (cached !== undefined) return cached;  // lazy: built only on first SHIFT-click
    const geom = mesh.geometry as THREE.BufferGeometry;
    const idx = geom.getIndex();
    const triCount = idx ? idx.count / 3 : (geom.getAttribute("position") as THREE.BufferAttribute).count / 3;
    // Cap: building adjacency for >50k triangles freezes the UI. Cache
    // null so we don't retry on every SHIFT-click.
    if (triCount > ADJ_TRI_CAP) {
      (mesh.userData as { adjacency?: Record<number, number[]> | null }).adjacency = null;
      return null;
    }
    const edgeMap = new Map<string, number[]>();
    for (let f = 0; f < triCount; f++) {
      const a = idx ? idx.getX(f * 3) : f * 3;
      const b = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const c = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const k = u < v ? `${u}_${v}` : `${v}_${u}`;
        const arr = edgeMap.get(k);
        if (arr) arr.push(f); else edgeMap.set(k, [f]);
      }
    }
    const adj: Record<number, number[]> = {};
    for (const tris of edgeMap.values()) {
      if (tris.length < 2) continue;
      for (const t of tris) {
        for (const o of tris) {
          if (o !== t) (adj[t] ||= []).push(o);
        }
      }
    }
    (mesh.userData as { adjacency?: Record<number, number[]> }).adjacency = adj;
    return adj;
  }
  function expandCoplanar(mesh: THREE.Mesh, seed: number, cosTol = Math.cos((2 * Math.PI) / 180)): number[] {
    const adj = buildAdjacency(mesh);
    if (!adj) return [seed]; // mesh too large -- fall back to single-face pick
    const seedN = new THREE.Vector3();
    faceNormal(mesh, seed, seedN);
    const tmpN = new THREE.Vector3();
    const visited = new Set<number>([seed]);
    const queue = [seed];
    while (queue.length) {
      const f = queue.shift()!;
      for (const n of adj[f] || []) {
        if (visited.has(n)) continue;
        faceNormal(mesh, n, tmpN);
        if (tmpN.dot(seedN) > cosTol) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    return Array.from(visited);
  }
  function showFacePick(positions: Float32Array, mesh: Pickable, faceCount: number, totalArea: number, faceIdx: number) {
    clearFacePick();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e0ff, side: THREE.DoubleSide,
      // depthTest AN → das Highlight wird von davorliegender Geometrie verdeckt
      // (nicht mehr "durch die Wand" sichtbar). polygonOffset zieht das koplanare
      // Overlay minimal Richtung Kamera, damit es nicht mit der Trefferfläche
      // z-fightet.
      depthTest: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      transparent: true, opacity: 0.85,
    });
    pickOverlay = new THREE.Mesh(g, mat);
    pickOverlay.renderOrder = 200;
    // Overlay positions are world-space; add to scene root (not sceneContent
    // which is rotated -90deg X). Build a wrapping group at scene root.
    scene.add(pickOverlay);
    const msg = document.getElementById("msg");
    if (msg) {
      const cls = mesh.userData.kind === "cavity" ? (faceClassOf(mesh) || "–") : "–";
      msg.textContent = `Face #${faceIdx}${faceCount > 1 ? ` (+${faceCount - 1} coplanar)` : ""} · Class ${cls} · Area ${totalArea.toFixed(4)} m² · Element ${mesh.userData.label}`;
    }
    needsRender = true;
  }
  function faceClassOf(mesh: Pickable): string | null {
    // Walk up parents to find a classGroup name
    let p: THREE.Object3D | null = mesh.parent;
    while (p) {
      for (const k of CLASS_KEYS) if (classGroups[k] === p) return k;
      p = p.parent;
    }
    return null;
  }

  function applyHighlight(m: Pickable | null, kind: "hover" | "pick" | "none") {
    if (!m) return;
    const mat = m.material as THREE.MeshLambertMaterial;
    if (kind === "none") {
      mat.color.setHex(m.userData.baseColor);
      mat.opacity = m.userData.baseOpacity;
      mat.transparent = m.userData.baseTransparent;
      mat.emissive?.setHex(0x000000);
    } else if (kind === "hover") {
      mat.emissive?.setHex(COLORS.hover);
      (mat as THREE.MeshLambertMaterial & { emissiveIntensity: number }).emissiveIntensity = 0.25;
    } else {
      mat.emissive?.setHex(COLORS.pick);
      (mat as THREE.MeshLambertMaterial & { emissiveIntensity: number }).emissiveIntensity = 0.45;
    }
    mat.needsUpdate = true;
    needsRender = true;
  }

  function setHover(m: Pickable | null) {
    if (hovered === m) return;
    if (hovered && hovered !== picked) applyHighlight(hovered, "none");
    hovered = m;
    if (hovered && hovered !== picked) applyHighlight(hovered, "hover");
    renderer.domElement.style.cursor = m ? "pointer" : panning ? "crosshair" : "grab";
  }

  function setPick(m: Pickable | null) {
    if (picked === m) return;
    if (picked) applyHighlight(picked, "none");
    picked = m;
    if (picked) applyHighlight(picked, "pick");
    // Status text — best-effort, doesn't break if absent
    const msg = document.getElementById("msg");
    if (msg && picked) {
      msg.textContent = `${picked.userData.kind} · ${picked.userData.label}`;
    }
  }

  // Hover: debounced 80ms after the last pointermove instead of running a
  // raycaster on every animation frame. Drops idle CPU/GPU dramatically.
  let lastMove: PointerEvent | null = null;
  let lastMoveT = 0;
  const HOVER_DEBOUNCE_MS = 80;
  renderer.domElement.addEventListener("pointermove", (ev) => {
    lastMove = ev;
    lastMoveT = performance.now();
    // Clear hover instantly while moving so the highlight doesn't linger
    // on the previous element until the debounce fires.
    if (hovered) setHover(null);
  });
  function processHover() {
    if (!lastMove) return;
    if (performance.now() - lastMoveT < HOVER_DEBOUNCE_MS) return;
    const ev = lastMove;
    lastMove = null;
    if (ev.buttons === 0) {
      const hit = pickAt(ev.clientX, ev.clientY);
      setHover(hit);
    }
  }

  // Click pick (only on non-drag click)
  let downX = 0, downY = 0;
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    downX = ev.clientX;
    downY = ev.clientY;
  });
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (ev.button !== 0) return;
    const dx = ev.clientX - downX, dy = ev.clientY - downY;
    if (dx * dx + dy * dy > 9) return; // drag, ignore

    // ---- Placement mode: face ----
    if (placementMode === "face") {
      const hit = rayIntersect(ev.clientX, ev.clientY);
      const fIdx = hit?.faceIndex;
      if (hit && fIdx !== undefined && fIdx !== null) {
        const mesh = hit.object as THREE.Mesh;
        const nLocal = new THREE.Vector3();
        faceNormal(mesh, fIdx, nLocal);
        const nWorld = nLocal.clone().transformDirection(mesh.matrixWorld).normalize();
        const hitPoint = hit.point.clone();
        addClipPlaneFromFace(hitPoint, nWorld);
        const m = document.getElementById("msg");
        if (m) m.textContent = `Schnittebene gesetzt (${clipPlanes.length} Ebene${clipPlanes.length === 1 ? "" : "n"}).`;
        placementMode = "none";
        renderer.domElement.style.cursor = "grab";
        firePlacementChange("none");
      }
      return;
    }

    // ---- Placement mode: path (two clicks) ----
    if (placementMode === "path") {
      // Try to get a world-space point: first raycast model, then fall back to
      // horizontal plane at the model box centre height.
      let pt: THREE.Vector3 | null = null;
      const hit = rayIntersect(ev.clientX, ev.clientY);
      if (hit) {
        pt = hit.point.clone();
      } else {
        const box = worldModelBox();
        const boxCenterY = box ? (box.min.y + box.max.y) / 2 : 0;
        clientToNdc(ev.clientX, ev.clientY);
        raycaster.setFromCamera(ndc, camera);
        const hPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -boxCenterY);
        const tmp = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(hPlane, tmp)) pt = tmp.clone();
      }
      if (!pt) return; // can't resolve point, stay in mode
      pathPoints.push(pt);
      const msgEl = document.getElementById("msg");
      if (pathPoints.length === 1) {
        if (msgEl) msgEl.textContent = "Klick 2/2 — zweiten Punkt setzen.";
        return;
      }
      // Two points collected — build vertical plane
      const p1 = pathPoints[0];
      const p2 = pathPoints[1];
      const up = new THREE.Vector3(0, 1, 0);
      const lineDir = new THREE.Vector3().subVectors(p2, p1);
      // Remove vertical component
      const lineDirH = lineDir.clone().addScaledVector(up, -lineDir.dot(up));
      if (lineDirH.length() < 1e-4) {
        // Points too close horizontally — stay in mode
        pathPoints = [p1]; // keep first point
        if (msgEl) msgEl.textContent = "Punkte zu nah beieinander. Klick 2/2 erneut versuchen.";
        return;
      }
      // n = up × dirH; first click = left, second = right.
      const n = new THREE.Vector3().crossVectors(up, lineDirH).normalize();
      // Flip toward the SAVED pre-top-view camera position so the plane keeps
      // the front/viewer side (three.js keeps the +normal half-space).
      const preCamDir = prePlacementCamPos.clone().sub(p1);
      if (n.dot(preCamDir) < 0) n.negate();
      const plane = new THREE.Plane();
      plane.setFromNormalAndCoplanarPoint(n, p1);
      const planeSize = planeQuadSize();
      // Model-centred quad (not the segment midpoint) so quads align.
      const center = modelCenteredOnPlane(plane);
      const { mesh, edges } = createPlaneVisual(n, center, planeSize);
      const idx = clipPlanes.length;
      clipPlanes.push({ plane, mesh, edges, center });
      scene.add(mesh);
      scene.add(edges);
      rebuildClippableMatList();
      applySectionToMats();
      setSelectedPlane(idx);
      onClipPlanesChanged();
      if (msgEl) msgEl.textContent = `Schnittebene gesetzt (${clipPlanes.length} Ebene${clipPlanes.length === 1 ? "" : "n"}).`;
      pathPoints = [];
      placementMode = "none";
      renderer.domElement.style.cursor = "grab";
      firePlacementChange("none");
      return;
    }

    // ---- Normal click: try to select a clip-plane quad first ----
    const planeIdx = hitClipPlaneMesh(ev.clientX, ev.clientY);
    if (planeIdx !== null) {
      setSelectedPlane(planeIdx);
      return;
    }
    // Deselect plane if click misses all quads
    setSelectedPlane(null);

    // Regular face-pick
    const hit = rayIntersect(ev.clientX, ev.clientY);
    const fIdx = hit?.faceIndex;
    if (!hit || fIdx === undefined || fIdx === null) {
      clearFacePick();
      setPick(null);
      return;
    }
    const mesh = hit.object as Pickable;

    // Toggle: erneuter Klick auf das bereits gewählte Element hebt die Auswahl
    // auf (deselektieren).
    if (picked === mesh) {
      setPick(null);
      clearFacePick();
      return;
    }

    setPick(mesh);

    // Standard-Klick markiert das GANZE Element deutlich (cyan Overlay über ALLE
    // Dreiecke des Meshes) — bei einer Klassen-Fläche (Cavity) sind das alle
    // zusammenhängenden Dreiecke derselben Klassifikation, weil jede Cavity
    // genau eine zusammenhängende Klassen-Komponente IST.
    // SHIFT+Klick: Detail-Modus — nur die koplanare Teilfläche (einzelne
    // Versatzfläche innerhalb einer grossen Wand).
    const geom = mesh.geometry as THREE.BufferGeometry;
    const triTotal = geom.getIndex()
      ? geom.getIndex()!.count / 3
      : (geom.getAttribute("position") as THREE.BufferAttribute).count / 3;
    const faces = ev.shiftKey
      ? expandCoplanar(mesh, fIdx)
      : Array.from({ length: triTotal }, (_, i) => i); // alle Dreiecke
    const positions = trianglePositions(mesh, faces);
    let area = 0;
    for (let i = 0; i < faces.length; i++) area += triArea(positions, i * 9);
    showFacePick(positions, mesh, faces.length, area, fIdx);
  });

  // ---- Doppelklick: ganzes IFC-Element auswählen (Element-Inspektor) --------
  // Einzelklick bleibt Flächen-Pick (cyan Overlay); Doppelklick liest die
  // element_guid des getroffenen Cavity-Meshes und meldet sie an registrierte
  // Callbacks (Shell → Inspektor: isolieren + zoomen).
  const elementPickCbs: Array<(guid: string) => void> = [];
  function onElementPick(cb: (guid: string) => void) { elementPickCbs.push(cb); }
  renderer.domElement.addEventListener("dblclick", (ev) => {
    // The reference WALL is now visible by default and is coincident with the
    // class submeshes — a plain nearest-hit would land on the wall (which has no
    // element_guid) and select nothing. Walk the hits front-to-back and take the
    // FIRST one that actually carries an element_guid.
    clientToNdc(ev.clientX, ev.clientY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(visiblePickables(), false);
    for (const h of hits) {
      const guid = (h.object as Pickable).userData?.element_guid;
      if (guid) { for (const cb of elementPickCbs) cb(guid); return; }
    }
  });

  // ---- Wireframe / transparency toggles ------------------------------
  function applyMaterialOverrides() {
    for (const p of pickables) {
      const mat = p.material as THREE.MeshLambertMaterial;
      mat.wireframe = wireframe;
      if (extraTransparent) {
        mat.transparent = true;
        mat.opacity = Math.min(p.userData.baseOpacity, 0.35);
        mat.depthWrite = false;
      } else {
        mat.transparent = p.userData.baseTransparent;
        mat.opacity = p.userData.baseOpacity;
        mat.depthWrite = !p.userData.baseTransparent;
      }
      mat.needsUpdate = true;
    }
    needsRender = true;
  }

  // ---- Keyboard shortcuts ---------------------------------------------
  window.addEventListener("keydown", (ev) => {
    // Skip when typing in inputs
    const tgt = ev.target as HTMLElement | null;
    if (tgt && ["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
    // SHIFT-1..7 -> toggle class K0..K6 visibility. Layout-agnostic via ev.code.
    if (ev.shiftKey && /^Digit[1-7]$/.test(ev.code)) {
      const idx = Number(ev.code.slice(5)) - 1;
      const key = CLASS_KEYS[idx];
      const g = classGroups[key];
      if (g) {
        g.visible = !g.visible;
        needsRender = true;
        // Sync the matching toggle button in the shell (if present).
        document
          .querySelector(`[data-class-toggle="${key}"]`)
          ?.classList.toggle("on", g.visible);
        ev.preventDefault();
        return;
      }
    }
    switch (ev.key.toLowerCase()) {
      case "f": fit(); break;
      case "1": setView("iso"); break;
      case "2": setView("back"); break;
      case "3": setView("top"); break;
      case "4": setView("bottom"); break;
      case "5": setView("left"); break;
      case "6": setView("right"); break;
      case "7": setView("front"); break;
      case "w":
        wireframe = !wireframe;
        applyMaterialOverrides();
        break;
      case "t":
        extraTransparent = !extraTransparent;
        applyMaterialOverrides();
        break;
      case "r":
        camera.position.set(20, 18, 22);
        controls.target.set(0, 0, 0);
        controls.update();
        fit();
        break;
      case "escape":
        if (placementMode !== "none") { cancelSectionPlacement(); break; }
        resetView();
        break;
      case "delete":
      case "backspace":
        if (selectedClipIndex !== null) {
          deleteClipPlane(selectedClipIndex);
          ev.preventDefault();
        }
        break;
    }
  });

  // ---- renderResult ---------------------------------------------------
  function renderResult(result: DetectionResult) {
    clearFacePick();
    clearAll();
    if (result.wall_mesh) {
      const built = buildMesh(
        result.wall_mesh,
        COLORS.wall,
        "wall",
        result.wall_name || "wall",
        {
          transparent: true, opacity: 0.45,
          edgeColor: COLORS.wallEdge, edgeLayer: "wall",
        },
      );
      if (built) {
        built.mesh.userData.capColor = COLORS.wall;
        layers.wall.add(built.mesh);
        pickables.push(built.mesh);
      }
    }
    for (const c of result.cavities || []) {
      const classColor: number =
        (c.kind ? COLORS.classes[c.kind] : undefined) ?? COLORS.cavity;
      const built = buildMesh(
        c,
        classColor,
        "cavity",
        c.element_name || c.kind || "cavity",
        { edgeColor: COLORS.cavityEdge, edgeLayer: "cavities" },
      );
      if (built) {
        built.mesh.userData.capColor = classColor;
        if (c.kind) built.mesh.userData.classKey = c.kind;
        // Element-Identität für den Inspektor (isolateElement/fitToElement).
        if (c.element_guid) built.mesh.userData.element_guid = c.element_guid;
        const target = (c.kind && classGroups[c.kind]) || layers.cavities;
        target.add(built.mesh);
        pickables.push(built.mesh);
      }
    }
    // Fundament/Stützmauerfuss gehört zur STRUKTUR, nicht zum Gelände: solche
    // Kontext-Meshes kommen in die Wand-/Modell-Gruppe (Modell-Button steuert
    // sie), der Gelände-Button steuert dann nur noch Terrain/Strasse. Erkennung
    // per IFC-Typ ODER Name (CAD-Exporte typisieren den Fuss oft als Proxy).
    const STRUCT_TYPE_RE = /IfcFooting|IfcSlab|IfcPile|IfcPileCap|Foundation|Fundament|Footing/i;
    const STRUCT_NAME_RE = /fundament|footing|fuss|sohle|sockel|fundation/i;
    for (const ctx of result.context_meshes || []) {
      const ctxColor = pickContextColor(ctx.ifc_type);
      const isStructure = STRUCT_TYPE_RE.test(ctx.ifc_type || "")
        || STRUCT_NAME_RE.test(ctx.name || "");
      const built = buildMesh(
        ctx,
        ctxColor,
        "context",
        ctx.name || ctx.ifc_type || "context",
        { transparent: true, opacity: 0.55 },
      );
      if (built) {
        built.mesh.userData.capColor = ctxColor;
        // Struktur → layers.wall (Modell-Button); sonst layers.context (Gelände).
        (isStructure ? layers.wall : layers.context).add(built.mesh);
        pickables.push(built.mesh);
      }
    }
    // Perf: emit ONE merged LineSegments per layer (was 1 per submesh).
    _flushEdges();
    applyMaterialOverrides();
    // Re-attach section plane to freshly built materials (Task B).
    rebuildClippableMatList();
    applySectionToMats();
    // Rebuild caps against the freshly built meshes (no-op if no clip planes).
    sectionCaps.rebuildCaps();
    fit();
  }

  function setLayerVisible(layer: string, visible: boolean) {
    // Accepts top-level layer keys ("wall","cavities","context") and
    // class keys K0..K6 (individual face-classification sub-groups inside
    // layers.cavities). For "wall" this also hides its edge wireframe: the
    // merged wall LineSegments live in edgeGroups.wall which IS a child of
    // layers.wall, so toggling the group's .visible hides mesh + edges together.
    const g = layers[layer] || classGroups[layer];
    if (g) {
      g.visible = visible;
      needsRender = true;
    }
  }

  // ---- Layer/class styling setters (for the upcoming settings UI, Pass 2) --
  // Resolve a layer-or-class key to the group whose MESH materials should be
  // styled. Accepts "wall","cavities","context" and "K0".."K6".
  // Returns null on unknown key (callers no-op defensively).
  function resolveStyleGroup(key: string): THREE.Group | null {
    if (classGroups[key]) return classGroups[key];
    if (layers[key]) return layers[key];
    return null;
  }
  // Iterate the FILLED-mesh materials under a group (skips LineSegments).
  function forEachMeshMaterial(g: THREE.Group, fn: (m: THREE.Material) => void): void {
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach(fn);
      else if (mat) fn(mat);
    });
  }
  // Iterate the edge LineSegments under a group. For "wall"/"cavities"/… the
  // merged edge LineSegments live in edgeGroups[key]; class keys K0..K6 share
  // the single "cavities" edge buffer (per-class edges are not split out).
  function forEachEdgeLine(key: string, fn: (ls: THREE.LineSegments) => void): void {
    const eg = edgeGroups[key] || (classGroups[key] ? edgeGroups.cavities : undefined);
    if (!eg) return;
    eg.traverse((obj) => {
      const ls = obj as THREE.LineSegments;
      if (ls.isLineSegments) fn(ls);
    });
  }

  // Recolour a layer's / class subgroup's mesh material(s).
  function setLayerColor(layerOrClassKey: string, hex: number): void {
    const g = resolveStyleGroup(layerOrClassKey);
    if (!g) return;
    forEachMeshMaterial(g, (m) => {
      const cm = m as THREE.Material & { color?: THREE.Color };
      if (cm.color) {
        cm.color.setHex(hex);
        m.needsUpdate = true;
      }
    });
    // Persist as each mesh's BASE colour so hover/pick/finding/dim restore
    // honours the user's choice instead of snapping back to the build default.
    g.traverse((obj) => {
      const mesh = obj as Pickable;
      if ((mesh as unknown as THREE.Mesh).isMesh) mesh.userData.baseColor = hex;
    });
    needsRender = true;
  }
  // Set opacity (0..1) + transparent flag on a layer's mesh material(s).
  function setLayerOpacity(layerOrClassKey: string, opacity: number): void {
    const g = resolveStyleGroup(layerOrClassKey);
    if (!g) return;
    const o = Math.max(0, Math.min(1, opacity));
    forEachMeshMaterial(g, (m) => {
      m.transparent = o < 1;
      (m as THREE.Material & { opacity: number }).opacity = o;
      (m as THREE.Material & { depthWrite: boolean }).depthWrite = o >= 1;
      m.needsUpdate = true;
    });
    // Persist as each mesh's BASE opacity/transparency so hover/pick/finding/dim
    // restore (applyHighlight, setFindingIsolation, setContextDimmed, ghostExcept,
    // applyMaterialOverrides) keeps the user's setting instead of resetting it.
    g.traverse((obj) => {
      const mesh = obj as Pickable;
      if (!(mesh as unknown as THREE.Mesh).isMesh) return;
      mesh.userData.baseOpacity = o;
      mesh.userData.baseTransparent = o < 1;
    });
    needsRender = true;
  }
  // Best-effort edge line width. WebGL ignores LineBasicMaterial.linewidth > 1
  // (always renders 1px); we still set the property so any LineMaterial-based
  // lines honour it and the value is queryable. Never throws.
  function setLayerLineWidth(layerOrClassKey: string, width: number): void {
    const w = Math.max(0.1, width);
    forEachEdgeLine(layerOrClassKey, (ls) => {
      const m = ls.material as THREE.Material & { linewidth?: number };
      if (typeof m.linewidth === "number" || "linewidth" in m) {
        (m as { linewidth: number }).linewidth = w;
        m.needsUpdate = true;
      }
    });
    needsRender = true;
  }
  // Toggle a layer's edge LineSegments visibility.
  function setLayerEdgesVisible(layerOrClassKey: string, visible: boolean): void {
    // Normalise class keys (K0..K6) to the shared "cavities" edge buffer.
    const eKey = edgeGroups[layerOrClassKey]
      ? layerOrClassKey
      : (classGroups[layerOrClassKey] ? "cavities" : layerOrClassKey);
    edgesUserVisible[eKey] = visible;
    forEachEdgeLine(layerOrClassKey, (ls) => { ls.visible = visible; });
    // Also reflect on any per-submesh finding edges currently drawn (isolation).
    for (const e of findingEdges) e.visible = (edgesUserVisible.cavities !== false);
    needsRender = true;
  }

  // Dim the terrain/context layer during a guided finding so the wall +
  // annotation dominate. Stores each material's base opacity once in userData
  // so restore is exact. `dim=false` puts the original opacity back.
  function setContextDimmed(dim: boolean) {
    layers.context.traverse((obj) => {
      const m = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      const mats = m.material
        ? (Array.isArray(m.material) ? m.material : [m.material])
        : [];
      for (const mat of mats) {
        const mm = mat as THREE.Material & { opacity: number; transparent: boolean; userData: { _baseOpacity?: number } };
        if (mm.userData._baseOpacity === undefined) mm.userData._baseOpacity = mm.opacity;
        mm.transparent = true;
        mm.opacity = dim ? Math.min(mm.userData._baseOpacity, 0.12) : mm.userData._baseOpacity;
        mm.needsUpdate = true;
      }
    });
    needsRender = true;
  }

  // Ghost: alle Cavity-Elemente, deren GUID nicht in `keep` ist, stark
  // transparent setzen (betroffene Elemente bleiben voll sichtbar). keep=null
  // stellt die Basis-Opazität wieder her. Modelliert nach setContextDimmed.
  function ghostExcept(keep: string[] | null) {
    const set = keep && keep.length ? new Set(keep) : null;
    for (const p of pickables) {
      if (p.userData.kind !== "cavity") continue;
      const mat = p.material as THREE.MeshLambertMaterial;
      const base = (p.userData.baseOpacity as number) ?? 1;
      const baseT = (p.userData.baseTransparent as boolean) ?? false;
      const ghost = set !== null && !set.has(p.userData.element_guid as string);
      mat.transparent = ghost ? true : baseT;
      mat.opacity = ghost ? Math.min(base, 0.07) : base;
      mat.depthWrite = ghost ? false : !baseT;
      mat.needsUpdate = true;
    }
    needsRender = true;
  }

  // Geführter-Modus Finding-Isolation: NUR die betroffenen Bauteile (keep) bleiben
  // voll farbig + bekommen ein klassenfarbiges Kanten-Overlay; alles andere (andere
  // Cavities + der kombinierte Wand-Körper) wird einheitlich grau und sehr transparent
  // (~6 %) als dezenter Kontext. keep=null stellt den Basiszustand wieder her.
  // (Terrain/Context wird separat über setContextDimmed gedimmt.)
  let findingEdges: THREE.LineSegments[] = [];
  const FIND_GREY = 0x8a8f96;
  function setFindingIsolation(keep: string[] | null): void {
    for (const e of findingEdges) {
      e.parent?.remove(e);
      e.geometry.dispose();
      (e.material as THREE.Material).dispose();
    }
    findingEdges = [];
    const set = keep && keep.length ? new Set(keep) : null;
    const isolating = set !== null;
    // Schnittflaechen/Kontouren nur fuer das betroffene Bauteil bauen — sonst zeigen
    // die grauen Nachbar-Elemente weiterhin feste (farbige) Schnitt-Kanten.
    sectionCaps.setCapFilter(set ? Array.from(set) : null);
    if (isolating) for (const k of CLASS_KEYS) classGroups[k].visible = true;
    // Globale gemergte Kanten aus, solange isoliert wird (wir zeichnen pro betroffenem
    // Submesh klassenfarbige Kanten); sonst wieder an.
    if (edgeGroups.cavities) edgeGroups.cavities.visible = !isolating;
    if (edgeGroups.wall) edgeGroups.wall.visible = !isolating;
    for (const p of pickables) {
      if (p.userData.kind !== "cavity") continue;
      const mat = p.material as THREE.MeshLambertMaterial;
      const baseColor = (p.userData.baseColor as number) ?? 0xffffff;
      const baseOp = (p.userData.baseOpacity as number) ?? 1;
      const baseT = (p.userData.baseTransparent as boolean) ?? false;
      const drop = set !== null && !set.has(p.userData.element_guid as string);
      if (drop) {
        mat.color.setHex(FIND_GREY);
        mat.opacity = 0.06;
        mat.transparent = true;
        mat.depthWrite = false;
      } else {
        mat.color.setHex(baseColor);
        mat.opacity = baseOp;
        mat.transparent = baseT;
        mat.depthWrite = !baseT;
        if (isolating && edgesUserVisible.cavities !== false) {
          try {
            // FEATURE_EDGE_DEG (NICHT der Default 1°!) — sonst würde auf dem
            // isolierten Submesh die GESAMTE Triangulierung als Kanten gezeichnet
            // (besonders seit toCreasedNormals die Geometrie un-indiziert macht),
            // also viel mehr Netzkanten als im Normalbild. Gleiche Schwelle wie
            // das gemergte Overlay → konsistente Kantenmenge beim Regelklick.
            const eg = new THREE.LineSegments(
              new THREE.EdgesGeometry(p.geometry as THREE.BufferGeometry, FEATURE_EDGE_DEG),
              new THREE.LineBasicMaterial({ color: baseColor }));
            eg.renderOrder = 6;
            eg.userData = { skipPick: true };
            p.add(eg);
            findingEdges.push(eg);
          } catch { /* degenerate geometry -> skip edges */ }
        }
      }
      mat.needsUpdate = true;
    }
    // Kombinierter Wand-Körper (grau, ohne element_guid) ebenfalls grau + faint.
    layers.wall.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!(m as THREE.Mesh).isMesh) return;
      const mat = m.material as THREE.MeshLambertMaterial;
      if (!mat || !mat.color) return;
      const baseColor = m.userData?.baseColor as number | undefined;
      const baseOp = (m.userData?.baseOpacity as number) ?? 0.45;
      const baseT = (m.userData?.baseTransparent as boolean) ?? true;
      if (isolating) {
        mat.color.setHex(FIND_GREY);
        mat.opacity = 0.05;
        mat.transparent = true;
        mat.depthWrite = false;
      } else {
        if (typeof baseColor === "number") mat.color.setHex(baseColor);
        mat.opacity = baseOp;
        mat.transparent = baseT;
        mat.depthWrite = !baseT;
      }
      mat.needsUpdate = true;
    });
    needsRender = true;
  }

  // ---- BCF guided-mode API ------------------------------------------------
  // setIssueView: animated camera jump to a precomputed viewpoint (used by
  //   the BCF issue list in guided step 3).
  // setControlsEnabled: disable OrbitControls + pointer interaction so the
  //   guided walkthrough is "frame-by-frame" instead of free orbit.
  // highlightIssueRegion: emphasise a K-class by hiding the others (best-
  //   effort highlight without rebuilding meshes); pass null to restore.
  let savedClassVisibility: Record<string, boolean> | null = null;
  function setIssueView(view: IssueView, opts: { animate?: boolean; durationMs?: number } = {}) {
    const animate = opts.animate !== false;
    const dur = opts.durationMs ?? 400;
    const targetPos = new THREE.Vector3(...view.cameraPos);
    const targetTgt = new THREE.Vector3(...view.target);
    if (view.fovDeg && Math.abs(camera.fov - view.fovDeg) > 0.5) {
      camera.fov = view.fovDeg;
    }
    if (view.up) camera.up.set(view.up[0], view.up[1], view.up[2]);
    // Push far plane so the framed bbox is never clipped.
    const dist = targetPos.distanceTo(targetTgt);
    camera.far = Math.max(camera.far, dist * 50, 1000);
    camera.updateProjectionMatrix();

    if (!animate) {
      camera.position.copy(targetPos);
      controls.target.copy(targetTgt);
      controls.update();
      needsRender = true;
      return;
    }
    const startPos = camera.position.clone();
    const startTgt = controls.target.clone();
    const t0 = performance.now();
    cancelAnimationFrame(tweenRAF);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(startPos, targetPos, e);
      controls.target.lerpVectors(startTgt, targetTgt, e);
      controls.update();
      needsRender = true;
      if (t < 1) tweenRAF = requestAnimationFrame(step);
    };
    tweenRAF = requestAnimationFrame(step);
  }

  function setControlsEnabled(enabled: boolean) {
    controls.enabled = enabled;
    renderer.domElement.style.pointerEvents = enabled ? "auto" : "none";
    renderer.domElement.style.cursor = enabled ? "grab" : "default";
  }

  // Active annotation group. Attached to sceneContent (not scene root) so
  // IFC-space coords from issues.ts inherit the same -PI/2 X rotation as the
  // wall mesh. This anchors annotations to the geometry instead of leaving
  // them floating "irgendwo in der Welt".
  // Skaliert nicht-fixe Annotation-Sprites auf ~konstante Bildschirmgrösse für die
  // aktuelle Kamera. Ausgelagert, damit der Offscreen-Snapshot-Render (eigener
  // renderer.render, umgeht den Animate-Loop) dieselbe Beschriftungsgrösse erhält.
  function scaleAnnotationSprites(group: THREE.Group | null): void {
    if (!group) return;
    const spriteWorld = new THREE.Vector3();
    group.traverse((obj) => {
      const s = obj as THREE.Sprite;
      if (!(s as THREE.Sprite).isSprite) return;
      if (s.userData?.annoFixed) return;
      s.getWorldPosition(spriteWorld);
      const d = camera.position.distanceTo(spriteWorld);
      const fovRad = (camera.fov * Math.PI) / 180;
      const p = 0.016;
      const hWorld = Math.max(0.015, Math.min(0.4, p * 2 * d * Math.tan(fovRad / 2)));
      const aspect = (s.userData?.aspect as number) || 6;
      s.scale.set(aspect * hWorld, hWorld, 1);
    });
  }

  let annotationGroup: THREE.Group | null = null;
  function setIssueAnnotations(group: THREE.Group | null) {
    if (annotationGroup) {
      sceneContent.remove(annotationGroup);
      annotationGroup.traverse((obj) => {
        const m = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
        m.geometry?.dispose?.();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) {
          const sm = mat as THREE.SpriteMaterial;
          if (sm.map) sm.map.dispose();
          mat.dispose();
        }
      });
      annotationGroup = null;
    }
    if (group) {
      annotationGroup = group;
      sceneContent.add(group);
    }
    needsRender = true;
  }

  // Section clipping (Task B). Plane normal/point are given in IFC space
  // (Z-up); we transform to world space (sceneContent rotated -PI/2 X)
  // before installing on all wall + cavity materials. Annotations are NOT
  // clipped (their materials keep clippingPlanes empty) so dimension lines
  // and labels remain readable through the cut.
  const sectionPlanes: THREE.Plane[] = [];
  const clippableMats: THREE.Material[] = [];
  // FREE-mode clipping state (defined here so refreshCombinedPlanes can read
  // them; the section module below mutates these arrays).
  type ClipPlane = {
    plane: THREE.Plane;
    mesh: THREE.Mesh;
    edges: THREE.LineSegments;
    center: THREE.Vector3;
  };
  const clipPlanes: ClipPlane[] = []; // pick-face / extra planes (world)
  function rebuildClippableMatList() {
    clippableMats.length = 0;
    // Wall/cavity/context meshes AND their edge LineSegments — both need
    // clipping so the section also cuts the wireframe overlay, not just the
    // filled faces (user feedback: "Drahtmodell sehe ich noch ganz").
    for (const layerKey of ["wall", "cavities", "context"]) {
      const g = layers[layerKey];
      g.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const line = obj as THREE.LineSegments;
        const mat = (mesh.isMesh || line.isLineSegments)
          ? (obj as THREE.Mesh).material
          : null;
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach((mm) => clippableMats.push(mm));
        else clippableMats.push(mat);
      });
    }
  }

  // ---- Section-cap controller ---------------------------------------------
  // Collect the FILLED meshes (not edges) that caps should cross-section. Same
  // layer set as rebuildClippableMatList, but meshes only (caps slice solids).
  function getClippableMeshes(): ClippableMesh[] {
    const out: ClippableMesh[] = [];
    for (const layerKey of ["wall", "cavities", "context"]) {
      const g = layers[layerKey];
      g.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) out.push(mesh as ClippableMesh);
      });
    }
    return out;
  }
  const sectionCaps: SectionCapsController = createSectionCaps(
    scene,
    // Caps für BEIDE Ebenen-Quellen: die geführte/Issue-Schnittebene
    // (sectionPlanes) UND manuell platzierte Clip-Planes — sonst wird der
    // Issue-Schnitt nur geklippt, aber nicht gecappt (offene Schnittfläche).
    () => [...sectionPlanes, ...clipPlanes.map((cp) => cp.plane)],
    getClippableMeshes,
    { w: host.clientWidth || 1, h: host.clientHeight || 1 },
  );

  // Project the model-box centre onto a plane → the model-centred quad anchor.
  function modelCenteredOnPlane(plane: THREE.Plane): THREE.Vector3 {
    const box = worldModelBox();
    const c = new THREE.Vector3();
    if (box) box.getCenter(c);
    // center - n * (n·center + constant)
    const dist = plane.normal.dot(c) + plane.constant;
    return c.addScaledVector(plane.normal, -dist);
  }
  // Equal indicator-quad size = model bbox diagonal (fallback 10).
  function planeQuadSize(): number {
    const box = worldModelBox();
    if (!box) return 10;
    const size = new THREE.Vector3();
    box.getSize(size);
    return size.length() || 10;
  }
  // Mutual clipping of indicator quads: each quad's mesh+outline gets every
  // clip plane EXCEPT its own, so crossing cuts trim each other's quads.
  function refreshPlaneVisualsClipping() {
    for (let i = 0; i < clipPlanes.length; i++) {
      const cp = clipPlanes[i];
      const others = clipPlanes.filter((_, j) => j !== i).map((o) => o.plane);
      const arr = others.length ? others : null;
      const mMat = cp.mesh.material as THREE.MeshBasicMaterial;
      const eMat = cp.edges.material as THREE.LineBasicMaterial;
      // Standard materials honour clippingPlanes automatically.
      mMat.clippingPlanes = arr;
      mMat.needsUpdate = true;
      eMat.clippingPlanes = arr;
      eMat.needsUpdate = true;
    }
  }

  function markCapsDirty() {
    capsDirty = true;
    needsRender = true;
  }
  // Called at every discrete clip-plane change: refresh quad mutual-clipping,
  // recompute caps, and re-render. (Wheel drag uses markCapsDirty() instead so
  // the rebuild coalesces to one per frame.)
  function onClipPlanesChanged() {
    refreshPlaneVisualsClipping();
    sectionCaps.rebuildCaps();
    needsRender = true;
  }

  // Combined clipping-plane array (guided single-plane + section-box 6 planes
  // + free-mode pick-face/extra planes). All sources are WORLD-space planes.
  // Three.js evaluates `material.clippingPlanes` each frame, so we may keep the
  // SAME array reference across drag frames (only re-assign + needsUpdate when
  // the *set* of planes changes — see applySectionToMats / refreshClipPlanes).
  const combinedPlanes: THREE.Plane[] = [];
  let lastPlaneCount = -1;
  function refreshCombinedPlanes() {
    combinedPlanes.length = 0;
    for (const p of sectionPlanes) combinedPlanes.push(p);
    for (const cp of clipPlanes) combinedPlanes.push(cp.plane);
  }
  function applySectionToMats() {
    refreshCombinedPlanes();
    const planes = combinedPlanes.length ? combinedPlanes : null;
    const countChanged = combinedPlanes.length !== lastPlaneCount;
    for (const mat of clippableMats) {
      (mat as THREE.Material).clippingPlanes = planes;
      mat.clipShadows = false;
      // Only re-compile the shader when the plane *count* changes (assignment
      // change). During a handle drag only constants change → Three.js reads
      // them live, no needsUpdate needed (avoids per-frame shader recompiles).
      if (countChanged) mat.needsUpdate = true;
    }
    lastPlaneCount = combinedPlanes.length;
    needsRender = true;
  }
  function setSectionPlane(plane: { normal: [number, number, number]; point: [number, number, number] } | null) {
    sectionPlanes.length = 0;
    if (plane) {
      // IFC (x,y,z) -> world (x, z, -y) via sceneContent rotation.x = -PI/2.
      const nW = new THREE.Vector3(plane.normal[0], plane.normal[2], -plane.normal[1]).normalize();
      const pW = new THREE.Vector3(plane.point[0], plane.point[2], -plane.point[1]);
      // Plane equation: n . x + c = 0  =>  c = -n . p
      const c = -nW.dot(pW);
      sectionPlanes.push(new THREE.Plane(nW, c));
    }
    rebuildClippableMatList();
    applySectionToMats();
    sectionCaps.rebuildCaps(); // Issue-Schnittfläche cappen (nicht nur klippen)
    needsRender = true;
  }

  // ====================================================================
  // FREE-mode clipping toolset — Section-Box + Pick-Face + extra planes.
  // Ported from C:\dev\IFC-Editor\src\viewer\IFCViewer.ts (section system).
  // Everything works in WORLD space: the world-space bbox of the visible
  // model drives the box, handles + box-viz meshes are added to `scene`
  // (NOT sceneContent, which is rotated -PI/2 X), and the clip planes feed
  // material.clippingPlanes (which are world-space). Guided setSectionPlane
  // is left untouched — its plane is additive in applySectionToMats.
  // ====================================================================

  // ---- World-space bbox of all visible model meshes (same union as fit()) --
  function worldModelBox(): THREE.Box3 | null {
    scene.updateMatrixWorld(true); // ensure matrixWorld is current
    const box = new THREE.Box3();
    let any = false;
    for (const g of Object.values(layers)) {
      g.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh && m.visible) {
          // Skip hidden layers: a hidden group makes children !visible too,
          // but traverse still walks them, so guard with the parent chain.
          let p: THREE.Object3D | null = m;
          let vis = true;
          while (p && p !== scene) { if (!p.visible) { vis = false; break; } p = p.parent; }
          if (!vis) return;
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox;
          if (b) { box.union(b.clone().applyMatrix4(m.matrixWorld)); any = true; }
        }
      });
    }
    return any ? box : null;
  }

  function clientToNdc(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  // ---- Placement mode state ------------------------------------------------
  type PlacementMode = "none" | "face" | "path";
  let placementMode: PlacementMode = "none";
  let pathPoints: THREE.Vector3[] = []; // collects up to 2 clicks for path mode
  // Orbit camera position captured BEFORE setTopView() in path mode, used to
  // orient the path plane toward the viewer's pre-top-view ("front") side.
  let prePlacementCamPos = new THREE.Vector3();
  const placementChangeCbs: Array<(mode: PlacementMode) => void> = [];
  const planeContextMenuCbs: Array<(index: number, clientX: number, clientY: number) => void> = [];
  const emptyContextMenuCbs: Array<(clientX: number, clientY: number) => void> = [];

  function firePlacementChange(mode: PlacementMode) {
    for (const cb of placementChangeCbs) cb(mode);
  }

  // ---- Selection state -----------------------------------------------------
  let selectedClipIndex: number | null = null;

  function setSelectedPlane(i: number | null) {
    // Restore previous
    if (selectedClipIndex !== null && selectedClipIndex < clipPlanes.length) {
      const prev = clipPlanes[selectedClipIndex];
      const eMat = prev.edges.material as THREE.LineBasicMaterial;
      const mMat = prev.mesh.material as THREE.MeshBasicMaterial;
      eMat.color.setHex(0x4a90d9);
      eMat.opacity = 0.35;
      mMat.opacity = 0.05;
      eMat.needsUpdate = true;
      mMat.needsUpdate = true;
    }
    selectedClipIndex = i;
    if (i !== null && i < clipPlanes.length) {
      const cp = clipPlanes[i];
      const eMat = cp.edges.material as THREE.LineBasicMaterial;
      const mMat = cp.mesh.material as THREE.MeshBasicMaterial;
      eMat.color.setHex(0xffd400);
      eMat.opacity = 0.85;
      mMat.opacity = 0.12;
      eMat.needsUpdate = true;
      mMat.needsUpdate = true;
    }
    needsRender = true;
  }

  // ---- Plane visual factory ------------------------------------------------
  function createPlaneVisual(normal: THREE.Vector3, point: THREE.Vector3, size: number): { mesh: THREE.Mesh; edges: THREE.LineSegments } {
    const planeGeometry = new THREE.PlaneGeometry(size, size);
    const planeMaterial = new THREE.MeshBasicMaterial({
      color: 0x4a90d9, transparent: true, opacity: 0.05,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(planeGeometry, planeMaterial);
    mesh.renderOrder = 140;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.quaternion.copy(q);
    mesh.position.copy(point);
    const edgeGeometry = new THREE.EdgesGeometry(planeGeometry);
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.35 }));
    edges.quaternion.copy(q);
    edges.position.copy(point);
    edges.raycast = () => {};
    return { mesh, edges };
  }

  // ---- addClipPlaneFromFace (internal) -------------------------------------
  function addClipPlaneFromFace(hitPoint: THREE.Vector3, faceNormalWorld: THREE.Vector3) {
    const plane = new THREE.Plane();
    // Cut away the clicked OUTER shell and KEEP the body BEHIND the clicked
    // face: three.js keeps the +normal half-space, so we use the INTO-MODEL
    // direction (−outward normal). The plane passes through the hit point; the
    // outer shell (on the +outward side) is clipped away.
    const n = faceNormalWorld.clone().negate().normalize();
    plane.setFromNormalAndCoplanarPoint(n, hitPoint);
    const planeSize = planeQuadSize();
    // Quad centred on the model (projection of model centre onto the plane),
    // so all indicator quads share one centre instead of staggering per click.
    const center = modelCenteredOnPlane(plane);
    const { mesh, edges } = createPlaneVisual(n, center, planeSize);
    const idx = clipPlanes.length;
    clipPlanes.push({ plane, mesh, edges, center });
    scene.add(mesh);
    scene.add(edges);
    rebuildClippableMatList();
    applySectionToMats();
    setSelectedPlane(idx);
    onClipPlanesChanged();
  }

  // ---- setTopView (for path placement) -------------------------------------
  function setTopView() {
    const box = worldModelBox();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3(20, 20, 20);
    if (box) { box.getCenter(center); box.getSize(size); }
    const radius = Math.max(size.x, size.z) / 2;
    const fov = camera.fov * (Math.PI / 180);
    const dist = (radius / Math.sin(fov / 2)) * 1.4;
    camera.position.set(center.x, center.y + dist, center.z);
    camera.up.set(0, 0, -1);
    controls.target.copy(center);
    controls.update();
    needsRender = true;
  }

  // ---- Placement mode API --------------------------------------------------
  function startSectionPlacement(method: "face" | "path") {
    placementMode = method;
    pathPoints = [];
    renderer.domElement.style.cursor = "crosshair";
    const msgEl = document.getElementById("msg");
    if (method === "face") {
      if (msgEl) msgEl.textContent = "Fläche anklicken, um Schnittebene zu setzen.";
    } else {
      if (msgEl) msgEl.textContent = "Klick 1/2 — ersten Punkt setzen.";
      // Capture the orbit camera BEFORE switching to top view so the path
      // plane can be oriented toward the user's prior viewpoint ("front").
      prePlacementCamPos = camera.position.clone();
      setTopView();
    }
    firePlacementChange(method);
  }

  function cancelSectionPlacement() {
    placementMode = "none";
    pathPoints = [];
    renderer.domElement.style.cursor = "grab";
    firePlacementChange("none");
  }

  function getPlacementMode(): PlacementMode { return placementMode; }

  // ---- Clip plane operations -----------------------------------------------
  function flipClipPlane(index: number) {
    const cp = clipPlanes[index];
    if (!cp) return;
    const n = cp.plane.normal.clone().negate();
    const coplanar = cp.center.clone();
    cp.plane.setFromNormalAndCoplanarPoint(n, coplanar);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    cp.mesh.quaternion.copy(q);
    cp.edges.quaternion.copy(q);
    // Re-centre on the model (the plane constant changed sign-wise via flip).
    const c = modelCenteredOnPlane(cp.plane);
    cp.center.copy(c);
    cp.mesh.position.copy(c);
    cp.edges.position.copy(c);
    applySectionToMats();
    onClipPlanesChanged();
  }

  function _disposeClipPlane(cp: ClipPlane) {
    scene.remove(cp.mesh);
    scene.remove(cp.edges);
    cp.mesh.geometry.dispose();
    (cp.mesh.material as THREE.Material).dispose();
    cp.edges.geometry.dispose();
    (cp.edges.material as THREE.Material).dispose();
  }

  function deleteClipPlane(index: number) {
    if (index < 0 || index >= clipPlanes.length) return;
    _disposeClipPlane(clipPlanes[index]);
    clipPlanes.splice(index, 1);
    // Adjust selection
    if (selectedClipIndex === index) {
      selectedClipIndex = null;
    } else if (selectedClipIndex !== null && selectedClipIndex > index) {
      selectedClipIndex--;
    }
    rebuildClippableMatList();
    applySectionToMats();
    onClipPlanesChanged();
  }

  function clearClipPlanes() {
    for (const cp of clipPlanes) _disposeClipPlane(cp);
    clipPlanes.length = 0;
    selectedClipIndex = null;
    rebuildClippableMatList();
    applySectionToMats();
    onClipPlanesChanged();
  }

  function clipPlaneCount() { return clipPlanes.length; }

  function getSelectedPlaneIndex(): number | null { return selectedClipIndex; }

  function onPlaneContextMenu(cb: (index: number, clientX: number, clientY: number) => void) {
    planeContextMenuCbs.push(cb);
  }

  function onEmptyContextMenu(cb: (clientX: number, clientY: number) => void) {
    emptyContextMenuCbs.push(cb);
  }

  // Toggle ONLY the indicator quad+outline visibility. The clip effect
  // (material.clippingPlanes) and the section caps stay regardless.
  function setPlaneVisible(index: number, visible: boolean) {
    const cp = clipPlanes[index];
    if (!cp) return;
    cp.mesh.visible = visible;
    cp.edges.visible = visible;
    // Bug 1: a hidden plane must not stay "selected" — otherwise Ctrl+wheel,
    // Delete and the hover cursor would still target an invisible element.
    if (!visible && selectedClipIndex === index) setSelectedPlane(null);
    needsRender = true;
  }
  function setAllPlanesVisible(visible: boolean) {
    for (const cp of clipPlanes) {
      cp.mesh.visible = visible;
      cp.edges.visible = visible;
    }
    if (!visible) setSelectedPlane(null);
    needsRender = true;
  }

  function onPlacementChange(cb: (mode: PlacementMode) => void) {
    placementChangeCbs.push(cb);
  }

  // ---- Raycast clip-plane quad meshes ------------------------------------
  // Only HIDDEN-quad-aware hits count: a plane whose indicator quad is hidden
  // ("Schnitt ausblenden" / setPlaneVisible(_,false)) must not be selectable or
  // draggable — three.js' Raycaster ignores `.visible`, so we filter it out
  // explicitly. An invisible section element is therefore not moveable (Bug 1).
  function hitClipPlaneMesh(clientX: number, clientY: number): number | null {
    if (clipPlanes.length === 0) return null;
    clientToNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const meshes = clipPlanes.filter((cp) => cp.mesh.visible).map((cp) => cp.mesh);
    if (meshes.length === 0) return null;
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    // Map back to the ORIGINAL clipPlanes index (we filtered the list above).
    const hitMesh = hits[0].object as THREE.Mesh;
    return clipPlanes.findIndex((cp) => cp.mesh === hitMesh);
  }

  // ---- Ctrl+wheel: move selected plane along its normal --------------------
  renderer.domElement.addEventListener("wheel", (ev: WheelEvent) => {
    if (ev.ctrlKey && selectedClipIndex !== null) {
      const cp = clipPlanes[selectedClipIndex];
      // Bug 1: an invisible section element must not be moveable. If the
      // selected plane's indicator quad is hidden ("Schnitt ausblenden"),
      // ignore the Ctrl+wheel move and let the event fall through normally.
      if (!cp || !cp.mesh.visible) return;
      ev.preventDefault();
      ev.stopPropagation();
      const box = worldModelBox();
      const size = new THREE.Vector3(10, 10, 10);
      if (box) box.getSize(size);
      const modelDiag = size.length() || 10;
      const step = Math.sign(ev.deltaY) * modelDiag * 0.01;
      // Move the plane along its normal by `step`.
      const moved = cp.center.clone().addScaledVector(cp.plane.normal, step);
      cp.plane.constant = -cp.plane.normal.dot(moved);
      // Re-derive the model-centred quad anchor for the new constant so the
      // quad stays centred on the model (never staggered) while moving.
      const c = modelCenteredOnPlane(cp.plane);
      cp.mesh.position.copy(c);
      cp.edges.position.copy(c);
      cp.center.copy(c);
      applySectionToMats();
      // Coalesce cap rebuild to once per frame for smooth dragging.
      markCapsDirty();
    }
  }, { capture: true, passive: false });

  // ---- Drag the SELECTED plane along its normal (left-mouse) ---------------
  // Project the mouse ray onto the line through `axisOrigin` along `axisDir`
  // (closest point between the two skew lines), returning the scalar parameter
  // along axisDir of that closest point. Reused line-line math from the old box
  // handles. Returns null if the ray is (near-)parallel to the axis.
  function projectRayToAxis(clientX: number, clientY: number, axisOrigin: THREE.Vector3, axisDir: THREE.Vector3): number | null {
    clientToNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const ro = raycaster.ray.origin;
    const rd = raycaster.ray.direction;
    const d = axisDir.clone().normalize();
    const w0 = new THREE.Vector3().subVectors(axisOrigin, ro);
    const a = d.dot(d);        // = 1
    const b = d.dot(rd);
    const c = rd.dot(rd);      // = 1
    const dd = d.dot(w0);
    const e = rd.dot(w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-6) return null; // parallel
    // s = parameter along the AXIS line at the closest point.
    const s = (b * e - c * dd) / denom;
    return s;
  }

  // Plane-move drag state.
  let planeDrag: {
    index: number;
    axisOrigin: THREE.Vector3; // plane centre at drag start
    axisDir: THREE.Vector3;    // plane normal (unit)
    startS: number;            // axis parameter at pointerdown
    startConstant: number;     // plane.constant at pointerdown
    moved: boolean;
  } | null = null;

  // Move a clip plane along its normal by `deltaAlongNormal` from its start
  // constant, updating mesh/edges/center and flagging caps dirty (coalesced).
  function movePlaneAlongNormal(index: number, startConstant: number, deltaAlongNormal: number) {
    const cp = clipPlanes[index];
    if (!cp) return;
    // plane.constant = c0 - delta  (moving +delta along +normal shifts the
    // plane forward: a point p on the new plane satisfies n·p + (c0 - delta)=0).
    cp.plane.constant = startConstant - deltaAlongNormal;
    const c = modelCenteredOnPlane(cp.plane);
    cp.mesh.position.copy(c);
    cp.edges.position.copy(c);
    cp.center.copy(c);
    applySectionToMats();
    markCapsDirty();
  }

  // Capture-phase pointerdown: if a clip-plane quad is hit, select it and begin
  // a plane-move drag (disabling OrbitControls). Capture phase so we intercept
  // before OrbitControls' own listener starts an orbit. Only left button, only
  // in free-orbit (not during face/path placement, so placement clicks still
  // work). A pure click (<3px) ends up just selecting (handled on pointerup).
  renderer.domElement.addEventListener("pointerdown", (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    if (placementMode !== "none") return; // don't hijack placement clicks
    const idx = hitClipPlaneMesh(ev.clientX, ev.clientY);
    if (idx === null) return;
    // Hit a plane quad → select it and arm a drag.
    setSelectedPlane(idx);
    const cp = clipPlanes[idx];
    const axisDir = cp.plane.normal.clone().normalize();
    const axisOrigin = cp.center.clone();
    const s = projectRayToAxis(ev.clientX, ev.clientY, axisOrigin, axisDir);
    planeDrag = {
      index: idx,
      axisOrigin,
      axisDir,
      startS: s ?? 0,
      startConstant: cp.plane.constant,
      moved: false,
    };
    controls.enabled = false;
    // Capture so we keep receiving moves even if the pointer leaves the canvas.
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    ev.preventDefault();
    ev.stopPropagation();
  }, { capture: true });

  renderer.domElement.addEventListener("pointermove", (ev: PointerEvent) => {
    if (!planeDrag) {
      // Hover cursor over the selected plane's quad.
      if (selectedClipIndex !== null && ev.buttons === 0) {
        const idx = hitClipPlaneMesh(ev.clientX, ev.clientY);
        if (idx === selectedClipIndex) renderer.domElement.style.cursor = "ns-resize";
      }
      return;
    }
    const s = projectRayToAxis(ev.clientX, ev.clientY, planeDrag.axisOrigin, planeDrag.axisDir);
    if (s === null) return;
    const delta = s - planeDrag.startS;
    if (Math.abs(delta) > 0) planeDrag.moved = true;
    movePlaneAlongNormal(planeDrag.index, planeDrag.startConstant, delta);
    renderer.domElement.style.cursor = "ns-resize";
  }, { capture: true });

  function endPlaneDrag(ev: PointerEvent) {
    if (!planeDrag) return;
    try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    planeDrag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = "grab";
    // Final discrete rebuild for crisp caps after the drag settles.
    onClipPlanesChanged();
  }
  renderer.domElement.addEventListener("pointerup", (ev: PointerEvent) => {
    if (ev.button === 0 && planeDrag) { endPlaneDrag(ev); ev.stopPropagation(); }
  }, { capture: true });
  renderer.domElement.addEventListener("pointercancel", (ev: PointerEvent) => {
    if (planeDrag) endPlaneDrag(ev);
  }, { capture: true });

  // ---- Context-menu on canvas ------------------------------------------
  renderer.domElement.addEventListener("contextmenu", (ev) => {
    const idx = hitClipPlaneMesh(ev.clientX, ev.clientY);
    if (idx !== null) {
      ev.preventDefault();
      setSelectedPlane(idx);
      for (const cb of planeContextMenuCbs) cb(idx, ev.clientX, ev.clientY);
      return;
    }
    // Rechtsklick ins Leere → Kontextmenü (enthält u.a. "Auf Totale
    // zurücksetzen"; ESC bleibt der direkte Reset-Shortcut).
    ev.preventDefault();
    for (const cb of emptyContextMenuCbs) cb(ev.clientX, ev.clientY);
  });

  function clearSection() {
    cancelSectionPlacement();
    clearClipPlanes();
    renderer.domElement.style.cursor = "grab";
  }

  function highlightIssueRegion(classKey: string | null) {
    if (classKey === null) {
      // Restore previous visibility.
      if (savedClassVisibility) {
        for (const k of Object.keys(savedClassVisibility)) {
          if (classGroups[k]) classGroups[k].visible = savedClassVisibility[k];
        }
        savedClassVisibility = null;
        needsRender = true;
      }
      return;
    }
    // Save current state once; subsequent calls overwrite the dim set
    // relative to the original baseline.
    if (!savedClassVisibility) {
      savedClassVisibility = {};
      for (const k of CLASS_KEYS) savedClassVisibility[k] = classGroups[k].visible;
    }
    for (const k of CLASS_KEYS) {
      classGroups[k].visible = (k === classKey) ? true : false;
    }
    // Ensure the highlighted class is on even if it was hidden originally.
    if (classGroups[classKey]) classGroups[classKey].visible = true;
    needsRender = true;
  }

  // ---- Komplett-Reset auf die Totale (ESC / Rechtsklick ins Leere) ---------
  // Hebt Flächen-Pick, Element-Isolation, Klassen-Highlight, Bemaßung,
  // Kontext-Dimm und Issue-Schnittebene auf und zoomt auf die Gesamtansicht.
  // Feuert onReset, damit die Shell ihren Inspektor-/Regel-Zustand miträumt.
  const resetCbs: Array<() => void> = [];
  function onReset(cb: () => void) { resetCbs.push(cb); }
  function resetView() {
    clearFacePick();
    setPick(null);
    isolateElement(null);
    setFindingIsolation(null);
    highlightIssueRegion(null);
    setIssueAnnotations(null);
    setContextDimmed(false);
    setSectionPlane(null);
    fit();
    for (const cb of resetCbs) cb();
  }

  // ---- BCF snapshot capture ----------------------------------------------
  // Apply an issue view (+ optional class highlight + section), render ONE
  // frame synchronously, read the canvas to a PNG dataURL, then restore the
  // previous camera / highlight / section. Synchronous render + immediate
  // toDataURL (backed by preserveDrawingBuffer) makes this reliable regardless
  // of the rAF render loop.
  function captureIssueSnapshot(opts: {
    view: IssueView;
    classKey?: string | null;
    section?: { normal: [number, number, number]; point: [number, number, number] } | null;
    width?: number;
    height?: number;
    light?: boolean;
    keepGuids?: string[] | null;
    highlightClass?: string | null;
    annotation?: object | null;
    toolLook?: boolean;
  }): string | null {
    try {
      // --- Save current state ---
      const savedPos = camera.position.clone();
      const savedTgt = controls.target.clone();
      const savedFov = camera.fov;
      const savedUp = camera.up.clone();
      const savedNear = camera.near;
      const savedFar = camera.far;
      // Save class group visibility so a highlight doesn't leak past capture.
      const savedVis: Record<string, boolean> = {};
      for (const k of CLASS_KEYS) savedVis[k] = classGroups[k].visible;
      const hadSavedHighlight = savedClassVisibility;
      // Save existing guided section planes so we can restore.
      const savedSection = sectionPlanes.map((p) => p.clone());
      const savedBg = scene.background;

      // --- Apply the requested view (no animation) ---
      const { view } = opts;
      const targetPos = new THREE.Vector3(...view.cameraPos);
      const targetTgt = new THREE.Vector3(...view.target);
      if (view.fovDeg) camera.fov = view.fovDeg;
      if (view.up) camera.up.set(view.up[0], view.up[1], view.up[2]);
      camera.position.copy(targetPos);
      controls.target.copy(targetTgt);
      const dist = targetPos.distanceTo(targetTgt);
      camera.near = Math.max(0.0001, dist * 0.0005);
      camera.far = Math.max(savedFar, dist * 50, 1000);
      camera.updateProjectionMatrix();
      controls.update();

      // --- Class highlight (show only the relevant class) ---
      // Im toolLook-Pfad übernimmt highlightIssueRegion() (unten) diese Isolation,
      // konsistent mit der interaktiven BCF-Ansicht — hier daher nur im Druck-Pfad.
      if (opts.classKey && !opts.toolLook) {
        for (const k of CLASS_KEYS) classGroups[k].visible = k === opts.classKey;
        classGroups[opts.classKey] && (classGroups[opts.classKey].visible = true);
      }

      // --- Section plane ---
      const restoreSection = () => {
        sectionPlanes.length = 0;
        for (const p of savedSection) sectionPlanes.push(p);
        rebuildClippableMatList();
        applySectionToMats();
      };
      if (opts.section !== undefined) {
        // Replace guided section with the requested one (or clear if null).
        sectionPlanes.length = 0;
        if (opts.section) {
          const nW = new THREE.Vector3(opts.section.normal[0], opts.section.normal[2], -opts.section.normal[1]).normalize();
          const pW = new THREE.Vector3(opts.section.point[0], opts.section.point[2], -opts.section.point[1]);
          sectionPlanes.push(new THREE.Plane(nW, -nW.dot(pW)));
        }
        rebuildClippableMatList();
        applySectionToMats();
      }

      // --- Light background: für BCF/Druck UND toolLook (geführte Hell-Ansicht). ---
      if (opts.light || opts.toolLook) scene.background = new THREE.Color(0xf5f5f5);

      // --- Isolate the affected element: ghost the rest (~6 %) and overlay its
      //     edges (solid + wireframe look) so only the affected element reads ---
      const _keep = opts.keepGuids && opts.keepGuids.length ? opts.keepGuids : null;
      const _edgeMat = new THREE.LineBasicMaterial({ color: 0x222222 });
      const _edgeObjs: THREE.LineSegments[] = [];
      // Gespeicherte Wand-Materialien für den dunkelgrau-Kontext (Kronen-Snapshot).
      const _wallSaved: Array<{ mat: THREE.MeshLambertMaterial; color: number; op: number; tr: boolean }> = [];
      const _savedVis = {
        wall: layers.wall.visible,
        ctx: layers.context.visible,
        cavEdges: edgeGroups.cavities ? edgeGroups.cavities.visible : true,
      };
      let _isolated = false;
      let _toolIso = false;
      if (opts.toolLook) {
        // 1:1 wie die interaktive BCF-Ansicht im Tool: Kontext dimmen, betroffenes
        // Bauteil finding-isolieren (volle Farbe + klassenfarbige Kanten, Rest grau/
        // faint), Krone (classKey) zusätzlich auf die K-Klasse hervorheben. Dunkler
        // Theme-Hintergrund bleibt (kein light-Override). KEIN eigenes Edge-Overlay.
        setContextDimmed(true);
        setFindingIsolation(_keep);
        if (opts.classKey) highlightIssueRegion(opts.classKey);
        _toolIso = true;
        // Ohne explizite Bemaßung (Nicht-Dimensions-Regeln) eng aufs Bauteil zoomen
        // (wie fitToElements im Tool); mit Bemaßung die verfeinerte issue.view behalten.
        if (!opts.annotation && _keep) {
          const keepSet = new Set(_keep);
          const _box = new THREE.Box3();
          for (const p of pickables) {
            if (p.userData.kind === "cavity" && keepSet.has(p.userData.element_guid as string)) {
              _box.expandByObject(p);
            }
          }
          if (!_box.isEmpty()) {
            const ctr = _box.getCenter(new THREE.Vector3());
            const sph = _box.getBoundingSphere(new THREE.Sphere());
            const vdir = camera.position.clone().sub(controls.target).normalize();
            const fovR = (camera.fov * Math.PI) / 180;
            const d2 = (sph.radius / Math.sin(fovR / 2)) * 1.18;
            camera.position.copy(ctr).addScaledVector(vdir, d2);
            controls.target.copy(ctr);
            camera.near = Math.max(0.0001, d2 * 0.0005);
            camera.far = Math.max(camera.far, d2 * 50, 1000);
            camera.lookAt(ctr);
            camera.updateProjectionMatrix();
            controls.update();
          }
        }
      } else if (_keep) {
        const keepSet = new Set(_keep);
        const hasAffected = pickables.some(
          (p) => p.userData.kind === "cavity" && keepSet.has(p.userData.element_guid as string));
        if (hasAffected) {
          ghostExcept(_keep);
          // Das betroffene Bauteil ist vollstaendig durch seine K0..K6-Cavity-
          // Submeshes repraesentiert. ghostExcept dimmt nur die ANDEREN Cavities;
          // der gemeinsame Wand-Koerper (result.wall = alle Waende als EIN Mesh
          // ohne element_guid, opacity 0.45), die Context-Meshes und die globalen
          // Cavity-Kanten blieben sonst voll sichtbar -> Bauteil nicht isoliert.
          // Fuer die Aufnahme komplett ausblenden; das Kanten-Overlay unten
          // zeichnet die Wireframe NUR des betroffenen Elements.
          // Krone (classKey gesetzt): Wandkörper als DUNKELGRAUEN Kontext sichtbar
          // lassen (statt ausblenden) → das Element liest sich als Volumen, die
          // hervorgehobene K2-Krone sitzt darauf. Sonst: ausblenden (wie bisher).
          if (opts.classKey) {
            layers.wall.visible = true;
            layers.wall.traverse((o) => {
              const m = o as THREE.Mesh;
              if (!m.isMesh) return;
              const mat = m.material as THREE.MeshLambertMaterial;
              if (!mat || !mat.color) return;
              _wallSaved.push({ mat, color: mat.color.getHex(), op: mat.opacity, tr: mat.transparent });
              mat.color.setHex(0x4a4d52);   // dunkelgrau
              mat.opacity = 0.9;
              mat.transparent = true;
              mat.needsUpdate = true;
            });
          } else {
            layers.wall.visible = false;
          }
          layers.context.visible = false;
          if (edgeGroups.cavities) edgeGroups.cavities.visible = false;
          _isolated = true;
          const _hl = opts.highlightClass || null;
          const _box = new THREE.Box3();
          for (const p of pickables) {
            if (p.userData.kind !== "cavity" || !keepSet.has(p.userData.element_guid as string)) continue;
            _box.expandByObject(p);
            // Wireframe-Kanten des betroffenen Bauteils.
            try {
              const eg = new THREE.LineSegments(
                new THREE.EdgesGeometry(p.geometry as THREE.BufferGeometry), _edgeMat);
              eg.renderOrder = 6;
              eg.userData = { skipPick: true };
              p.add(eg);
              _edgeObjs.push(eg);
            } catch { /* degenerate geometry -> skip edges for this mesh */ }
            // Geprüfte Fläche/Klasse hervorheben: übrige Klassen des Bauteils dezent
            // abdunkeln (ghostExcept(null) im Restore setzt alles zurück).
            if (_hl && p.userData.classKey && p.userData.classKey !== _hl) {
              const m = p.material as THREE.MeshLambertMaterial;
              m.transparent = true;
              m.opacity = Math.min((p.userData.baseOpacity as number) ?? 1, 0.32);
              m.depthWrite = false;
              m.needsUpdate = true;
            }
          }
          // Eng auf das betroffene Bauteil zoomen, Blickrichtung der Regel-Ansicht
          // beibehalten -> Element gross + klar im Screenshot.
          if (!_box.isEmpty()) {
            const ctr = _box.getCenter(new THREE.Vector3());
            const sph = _box.getBoundingSphere(new THREE.Sphere());
            const vdir = camera.position.clone().sub(controls.target).normalize();
            const fovR = (camera.fov * Math.PI) / 180;
            const d2 = (sph.radius / Math.sin(fovR / 2)) * 1.18;
            camera.position.copy(ctr).addScaledVector(vdir, d2);
            controls.target.copy(ctr);
            camera.near = Math.max(0.0001, d2 * 0.0005);
            camera.far = Math.max(camera.far, d2 * 50, 1000);
            camera.lookAt(ctr);
            camera.updateProjectionMatrix();
            controls.update();
          }
        }
      }

      // --- Maßlinie/Bemaßung für den Snapshot einblenden (Caller-eigenes Objekt;
      //     nur temporär einhängen, im Restore wieder aushängen, nicht disposen) ---
      const _annoObj = (opts.annotation as THREE.Object3D | null | undefined) || null;
      if (_annoObj) sceneContent.add(_annoObj);

      // --- Optional offscreen size for a crisper snapshot ---
      const prevSize = new THREE.Vector2();
      renderer.getSize(prevSize);
      const w = opts.width || prevSize.x || 1280;
      const h = opts.height || prevSize.y || 720;
      const resized = w !== prevSize.x || h !== prevSize.y;
      if (resized) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        sectionCaps.setResolution(w, h);
      }

      // --- Section JETZT auch auf das frisch isolierte WIREFRAME anwenden: die
      //     finding-Edges (LineSegments) wurden NACH der Section erzeugt, also die
      //     Clip-Liste neu bauen (jetzt inkl. dieser Edges) + Section + Caps neu.
      //     Sonst zeigt der Snapshot das VOLLE Wireframe un-geschnitten über dem
      //     korrekt geklippten Volumen (user: "Wireframe nicht abgeschnitten"). ---
      if (opts.section) {
        rebuildClippableMatList();
        applySectionToMats();
        try { sectionCaps.rebuildCaps(); } catch { /* keine Caps */ }
      }

      // --- Render one frame + grab PNG ---
      scaleAnnotationSprites(_annoObj as THREE.Group | null);
      renderer.render(scene, camera);
      let dataUrl: string | null = null;
      try {
        dataUrl = renderer.domElement.toDataURL("image/png");
      } catch {
        dataUrl = null; // tainted canvas / context loss — caller omits snapshot
      }

      // --- Restore ---
      if (opts.light || opts.toolLook) scene.background = savedBg;
      if (_annoObj) sceneContent.remove(_annoObj);
      for (const eg of _edgeObjs) { eg.parent?.remove(eg); eg.geometry.dispose(); }
      _edgeMat.dispose();
      if (_toolIso) {
        // interaktive BCF-Behandlung zurücknehmen (Basiszustand wiederherstellen).
        if (opts.classKey) highlightIssueRegion(null);
        setFindingIsolation(null);
        setContextDimmed(false);
      } else if (_isolated) {
        ghostExcept(null);
        for (const s of _wallSaved) { s.mat.color.setHex(s.color); s.mat.opacity = s.op; s.mat.transparent = s.tr; s.mat.needsUpdate = true; }
        layers.wall.visible = _savedVis.wall;
        layers.context.visible = _savedVis.ctx;
        if (edgeGroups.cavities) edgeGroups.cavities.visible = _savedVis.cavEdges;
      }
      if (resized) {
        renderer.setSize(prevSize.x, prevSize.y, false);
        camera.aspect = prevSize.x / prevSize.y;
        sectionCaps.setResolution(prevSize.x, prevSize.y);
      }
      camera.position.copy(savedPos);
      controls.target.copy(savedTgt);
      camera.fov = savedFov;
      camera.up.copy(savedUp);
      camera.near = savedNear;
      camera.far = savedFar;
      camera.updateProjectionMatrix();
      controls.update();
      if (opts.classKey && !opts.toolLook) {
        for (const k of CLASS_KEYS) classGroups[k].visible = savedVis[k];
        savedClassVisibility = hadSavedHighlight;
      }
      if (opts.section !== undefined) restoreSection();
      // Live-Caps wiederherstellen (der Snapshot hat sie auf das isolierte Element
      // gefiltert/neu gebaut).
      try { sectionCaps.rebuildCaps(); } catch { /* keine Caps */ }
      needsRender = true;
      return dataUrl;
    } catch {
      return null;
    }
  }

  // ---- Resize ----------------------------------------------------------
  // Read size from whichever element currently parents the canvas. This
  // lets the wizard reparent the canvas into #wiz-viewport without us
  // rendering at the wrong resolution.
  function currentHost(): HTMLElement {
    return (renderer.domElement.parentElement as HTMLElement) || host;
  }
  function resize() {
    const h0 = currentHost();
    const w = h0.clientWidth;
    const h = h0.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Keep the cap contour LineMaterial resolution in sync (screen-space px).
    sectionCaps.setResolution(w, h);
    needsRender = true;
  }
  window.addEventListener("resize", resize);
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  // Also observe the wizard viewport if it gets created later.
  setTimeout(() => {
    const wv = document.getElementById("wiz-viewport");
    if (wv) ro.observe(wv);
  }, 100);

  // ---- Visibility-aware render loop with damping cooldown + FPS HUD ---
  let lastFpsTime = performance.now();
  let frames = 0;
  let dampingActive = false;
  let dampingCooldown = 0;

  function loop() {
    requestAnimationFrame(loop);
    if (document.visibilityState === "hidden") return;

    processHover();

    // Coalesced section-cap rebuild (Ctrl+wheel drag flips this flag).
    if (capsDirty) {
      capsDirty = false;
      refreshPlaneVisualsClipping();
      sectionCaps.rebuildCaps();
      needsRender = true;
    }

    const ctrlNeed = controls.update();
    if (ctrlNeed) {
      dampingActive = true;
      needsRender = true;
    } else if (dampingActive) {
      dampingActive = false;
      dampingCooldown = 3;
    }
    if (dampingCooldown > 0) {
      dampingCooldown--;
      needsRender = true;
    }

    if (needsRender) {
      // Dynamic near plane based on target distance (IFC-Editor trick)
      const dist = camera.position.distanceTo(controls.target);
      camera.near = Math.max(0.0001, dist * 0.0005);
      camera.updateProjectionMatrix();

      // Scale annotation sprite labels so they stay ~constant pixel-size
      // regardless of orbit zoom. Annotation group lives under sceneContent
      // (rotated -PI/2 X) so sprite.position is in IFC-local; we must use
      // world-space distance to the camera for the scale factor.
      scaleAnnotationSprites(annotationGroup);

      renderer.render(scene, camera);

      // Corner axis gizmo: mirror the main camera orientation and render into a
      // small scissored viewport in the bottom-left so it overlays the model.
      // autoClear is disabled around this pass so the gizmo render doesn't wipe
      // the main frame; only the depth buffer is cleared (within the scissor).
      _gizmoDir.subVectors(camera.position, controls.target).normalize();
      gizmoCam.position.copy(_gizmoDir).multiplyScalar(5);
      gizmoCam.up.copy(camera.up);
      gizmoCam.lookAt(0, 0, 0);
      renderer.getSize(_rendSize);
      // Adaptive corner placement: sit low in the canvas (user: gizmo was "zu
      // hoch"). On short/mobile canvases drop the margin AND shrink the box so it
      // doesn't dominate the small viewport.
      const _gizSmall = _rendSize.y < 520;
      const gizmoPx = _gizSmall ? 60 : GIZMO_PX;
      const gizmoY = _gizSmall ? 14 : 44;
      renderer.autoClear = false;
      renderer.setScissorTest(true);
      renderer.setScissor(GIZMO_X, gizmoY, gizmoPx, gizmoPx);
      renderer.setViewport(GIZMO_X, gizmoY, gizmoPx, gizmoPx);
      renderer.clearDepth();
      renderer.render(gizmoScene, gizmoCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, _rendSize.x, _rendSize.y);
      renderer.autoClear = true;

      // 3D ViewCube (top-right): same scissor technique, same camera mirroring
      // as the axis gizmo above, so the cube co-rotates with the model. The
      // viewport is a square placed VC_MARGIN from the top/right edges; its rect
      // must match the DOM #view-cube overlay (which captures pointer events).
      // WebGL viewport Y is measured from the BOTTOM, hence the height subtract.
      vcCam.position.copy(_gizmoDir).multiplyScalar(5);
      vcCam.up.copy(camera.up);
      vcCam.lookAt(0, 0, 0);
      const vcVx = _rendSize.x - VC_PX - VC_MARGIN;
      const vcVy = _rendSize.y - VC_PX - VC_MARGIN;
      renderer.autoClear = false;
      renderer.setScissorTest(true);
      renderer.setScissor(vcVx, vcVy, VC_PX, VC_PX);
      renderer.setViewport(vcVx, vcVy, VC_PX, VC_PX);
      renderer.clearDepth();
      renderer.render(vcScene, vcCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, _rendSize.x, _rendSize.y);
      renderer.autoClear = true;

      needsRender = false;
      frames++;
    }

    const now = performance.now();
    if (now - lastFpsTime >= 500) {
      const fps = Math.round((frames * 1000) / (now - lastFpsTime));
      const zoom = camera.position.distanceTo(controls.target).toFixed(1);
      hud.textContent = `fps ${String(fps).padStart(2, " ")} · ${pickables.length} obj · zoom ${zoom}`;
      frames = 0;
      lastFpsTime = now;
    }
  }
  loop();

  return {
    renderResult,
    setViewerBackground,
    setLayerVisible,
    setLayerColor,
    setLayerOpacity,
    setLayerLineWidth,
    setLayerEdgesVisible,
    fit,
    isolateElement,
    fitToElement,
    focusProduct,
    onElementPick,
    ghostExcept,
    setFindingIsolation,
    fitToElements,
    resetView,
    onReset,
    clearFacePick,
    setIssueView,
    setControlsEnabled,
    highlightIssueRegion,
    setIssueAnnotations,
    setSectionPlane,
    startSectionPlacement,
    cancelSectionPlacement,
    getPlacementMode,
    clipPlaneCount,
    flipClipPlane,
    deleteClipPlane,
    clearClipPlanes,
    getSelectedPlaneIndex,
    setContextDimmed,
    setPlaneVisible,
    setAllPlanesVisible,
    onPlaneContextMenu,
    onEmptyContextMenu,
    onPlacementChange,
    clearSection,
    captureIssueSnapshot,
  };
}
