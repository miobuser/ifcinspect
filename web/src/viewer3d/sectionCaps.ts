// Section caps controller for the FREE-mode clipping toolset.
//
// When any world-space clip plane passes through a clippable mesh, we render:
//   1. a FILLED grey cap over the cross-section polygon(s), and
//   2. a BOLD contour line in the CLASS COLOUR of the mesh.
//
// Algorithm (deterministic geometric cross-section, no shader tricks):
//   For each clippable mesh M and each clip plane P:
//     - quick reject: if M's world bbox does not straddle P, skip.
//     - walk M's triangles in WORLD space (apply matrixWorld). For each
//       triangle, compute the signed distance of its 3 verts to P. A triangle
//       whose verts have mixed signs crosses P and yields exactly ONE segment
//       (two intersection points on the two crossing edges, linearly
//       interpolated). Collect all segments for (M,P).
//     - CONTOUR: render the raw segments as a thick LineSegments2 in M's
//       capColor (mutually clipped by the OTHER planes).
//     - FILL: weld segment endpoints into closed loops, project to the plane's
//       2D (u,v) basis, triangulate with THREE.ShapeUtils.triangulateShape,
//       lift back to 3D, build a grey BufferGeometry (mutually clipped). On any
//       failure (open contour, degenerate loop) we fall back to contour-only.
//
// Caps + edges live in a dedicated Group added to the SCENE ROOT (world space),
// never to sceneContent (which is rotated -PI/2 X). Geometries/materials are
// disposed on every rebuild. rebuildCaps() is called by viewer.ts after any
// clip-plane change; Ctrl+wheel drags set a dirty flag and coalesce the rebuild
// to once per animation frame for smoothness.

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { assembleLoops3D, triangulateLoops, type Seg3 } from "./capGeom";

export type ClippableMesh = THREE.Mesh & {
  userData: { capColor?: number; classKey?: string; element_guid?: string };
};

export type SectionCapsController = {
  /** Recompute all caps + contours from the current planes/meshes. */
  rebuildCaps: () => void;
  /** Beschraenke Caps/Kontouren auf diese element_guids (null = alle Meshes). */
  setCapFilter: (guids: string[] | null) => void;
  /** Update LineMaterial.resolution after a canvas resize. */
  setResolution: (w: number, h: number) => void;
  /** Free all GPU resources and remove the group from the scene. */
  dispose: () => void;
};

type Segment = {
  a: THREE.Vector3;
  b: THREE.Vector3;
};

const CAP_GREY = 0x8a8a8a;
const WELD_EPS = 1e-4;

export function createSectionCaps(
  scene: THREE.Scene,
  getPlanes: () => THREE.Plane[],
  getClippableMeshes: () => ClippableMesh[],
  initialResolution: { w: number; h: number },
): SectionCapsController {
  const group = new THREE.Group();
  group.name = "section-caps";
  scene.add(group);

  const resolution = new THREE.Vector2(
    Math.max(1, initialResolution.w),
    Math.max(1, initialResolution.h),
  );

  // Track LineMaterials so a resize can refresh their resolution uniform.
  const lineMaterials: LineMaterial[] = [];

  function clearGroup(): void {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const obj = group.children[i];
      const anyObj = obj as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      anyObj.geometry?.dispose?.();
      const m = anyObj.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose?.();
      group.remove(obj);
    }
    lineMaterials.length = 0;
  }

  // Compute the segment where a single triangle (world coords a,b,c) crosses
  // plane P. Returns null if the triangle does not straddle P with two distinct
  // crossing edges.
  function triangleSegment(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    plane: THREE.Plane,
  ): Segment | null {
    const da = plane.distanceToPoint(a);
    const db = plane.distanceToPoint(b);
    const dc = plane.distanceToPoint(c);
    // Vollstaendig koplanares Dreieck (da=db=dc=0): die ganze Flaeche liegt in
    // der Ebene — keine saubere Schnittkante (ihre Flaeche uebernimmt der FILL/
    // Triangulier-Pass). Eine Dreieckskante hier wuerde ein Geistersegment in
    // Contour + Fill-Segmente einschleusen. Ueberspringen.
    if (da === 0 && db === 0 && dc === 0) return null;
    const pts: THREE.Vector3[] = [];
    const edges: [THREE.Vector3, number, THREE.Vector3, number][] = [
      [a, da, b, db],
      [b, db, c, dc],
      [c, dc, a, da],
    ];
    for (const [p0, d0, p1, d1] of edges) {
      // Sign change across the edge → one crossing point.
      if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
        const t = d0 / (d0 - d1);
        pts.push(new THREE.Vector3().lerpVectors(p0, p1, t));
      } else if (d0 === 0) {
        // Vertex exactly on the plane — count it once.
        pts.push(p0.clone());
      }
    }
    if (pts.length < 2) return null;
    // Use first two distinct points.
    const a0 = pts[0];
    let b0: THREE.Vector3 | null = null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].distanceTo(a0) > WELD_EPS) { b0 = pts[i]; break; }
    }
    if (!b0) return null;
    return { a: a0, b: b0 };
  }

  // Collect all cross-section segments of mesh M against plane P (world space).
  function collectSegments(mesh: ClippableMesh, plane: THREE.Plane): Segment[] {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return [];
    const idx = geom.getIndex();
    const mat = mesh.matrixWorld;
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const segs: Segment[] = [];
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let f = 0; f < triCount; f++) {
      const ia = idx ? idx.getX(f * 3) : f * 3;
      const ib = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const ic = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      va.fromBufferAttribute(pos, ia).applyMatrix4(mat);
      vb.fromBufferAttribute(pos, ib).applyMatrix4(mat);
      vc.fromBufferAttribute(pos, ic).applyMatrix4(mat);
      const s = triangleSegment(va.clone(), vb.clone(), vc.clone(), plane);
      if (s) segs.push(s);
    }
    return segs;
  }

  // Quick bbox-vs-plane reject: true if the mesh's world bbox straddles P.
  const _bbox = new THREE.Box3();
  const _corner = new THREE.Vector3();
  function bboxStraddles(mesh: ClippableMesh, plane: THREE.Plane): boolean {
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return false;
    _bbox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
    let pos = false;
    let neg = false;
    for (let i = 0; i < 8; i++) {
      _corner.set(
        i & 1 ? _bbox.max.x : _bbox.min.x,
        i & 2 ? _bbox.max.y : _bbox.min.y,
        i & 4 ? _bbox.max.z : _bbox.min.z,
      );
      const d = plane.distanceToPoint(_corner);
      if (d > 0) pos = true;
      else if (d < 0) neg = true;
      if (pos && neg) return true;
    }
    return false;
  }

  // Build a filled cap mesh for a set of loops lying on `plane`. Returns null
  // if triangulation produced nothing. Robust nesting (holes vs separate
  // regions) + per-region triangulation are delegated to capGeom.triangulateLoops,
  // which is also used by the niche positive-volume reconstruction in viewer.ts.
  function buildCapMesh(loops: THREE.Vector3[][], plane: THREE.Plane, otherPlanes: THREE.Plane[]): THREE.Mesh | null {
    if (loops.length === 0) return null;
    const positions = triangulateLoops(loops, plane.normal);
    if (positions.length === 0) return null;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    // Standard materials honour `clippingPlanes` automatically (the `clipping`
    // boolean is an internal ShaderMaterial flag, not a public Material prop).
    const mat = new THREE.MeshBasicMaterial({
      color: CAP_GREY,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      clippingPlanes: otherPlanes.length ? otherPlanes : null,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 150;
    return mesh;
  }

  function buildContour(segs: Segment[], color: number, otherPlanes: THREE.Plane[]): LineSegments2 {
    const posArr: number[] = [];
    for (const s of segs) {
      posArr.push(s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z);
    }
    const lg = new LineSegmentsGeometry();
    lg.setPositions(posArr);
    const lm = new LineMaterial({
      color,
      linewidth: 2.5,
      worldUnits: false,
      clippingPlanes: otherPlanes.length ? otherPlanes : null,
      clipping: true,
    });
    lm.resolution.copy(resolution);
    lineMaterials.push(lm);
    const ls = new LineSegments2(lg, lm);
    ls.renderOrder = 160;
    (ls as unknown as { raycast: () => void }).raycast = () => {};
    return ls;
  }

  // Model-scale weld epsilon: max(1e-4, modelDiag * 1e-4). Computed once per
  // rebuild from the union of clippable-mesh world bboxes so welding is robust
  // on large/offset models where a fixed 1e-4 would never merge endpoints.
  function modelWeldEps(meshes: ClippableMesh[]): number {
    const box = new THREE.Box3();
    let any = false;
    for (const mesh of meshes) {
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (!geom.boundingBox) continue;
      box.union(geom.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      any = true;
    }
    if (!any) return WELD_EPS;
    const size = new THREE.Vector3();
    box.getSize(size);
    const diag = size.length() || 1;
    return Math.max(WELD_EPS, diag * 1e-4);
  }

  function isVisible(obj: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = obj;
    while (p) { if (!p.visible) return false; p = p.parent; }
    return true;
  }

  // Optionaler Filter: nur fuer diese element_guids Caps/Kontouren bauen (gefuehrte
  // Finding-Isolation -> nur das betroffene Bauteil zeigt eine Schnittflaeche + Kanten;
  // die grau-transparenten Nachbar-Elemente werden zwar geklippt, aber ohne Caps/Kanten).
  let capFilter: Set<string> | null = null;
  function setCapFilter(guids: string[] | null): void {
    capFilter = guids && guids.length ? new Set(guids) : null;
  }

  function rebuildCaps(): void {
    clearGroup();
    const planes = getPlanes();
    if (planes.length === 0) return;
    const meshes = getClippableMeshes();
    const weldEps = modelWeldEps(meshes);

    for (let pi = 0; pi < planes.length; pi++) {
      const plane = planes[pi];
      const otherPlanes = planes.filter((_, i) => i !== pi);

      // FILL: a single grey solid cross-section per plane. Each classified
      // wall face-patch (K0..K6) is an OPEN surface, so slicing one patch alone
      // never closes into a loop. Only the UNION of the shell patches forms the
      // closed wall outline — so we POOL the segments of all classKey meshes and
      // assemble loops once. triangulateLoops nests by containment, so a niche
      // recess loop sitting inside the wall outline becomes a HOLE (the niche
      // reads as OPEN, the wall body is filled). Terrain/context (no classKey)
      // is excluded from the fill; it only contributes its contour line.
      const fillSegs: Seg3[] = [];
      for (const mesh of meshes) {
        if (!isVisible(mesh)) continue;
        if (capFilter && !capFilter.has(mesh.userData.element_guid ?? "")) continue;
        if (!bboxStraddles(mesh, plane)) continue;
        const segs = collectSegments(mesh, plane);
        if (segs.length === 0) continue;
        const color = mesh.userData.capColor ?? CAP_GREY;
        // Per-class coloured contour edge (always, for every cut mesh).
        group.add(buildContour(segs, color, otherPlanes));
        if (mesh.userData.classKey) fillSegs.push(...(segs as Seg3[]));
      }
      // One pooled grey fill: wall solid filled, niche recesses = holes.
      if (fillSegs.length >= 3) {
        try {
          const loops = assembleLoops3D(fillSegs, weldEps);
          if (loops.length > 0) {
            const cap = buildCapMesh(loops, plane, otherPlanes);
            if (cap) group.add(cap);
          }
        } catch {
          // contour-only fallback — edges already added.
        }
      }
    }
  }

  function setResolution(w: number, h: number): void {
    resolution.set(Math.max(1, w), Math.max(1, h));
    for (const lm of lineMaterials) lm.resolution.copy(resolution);
  }

  function dispose(): void {
    clearGroup();
    scene.remove(group);
  }

  return { rebuildCaps, setCapFilter, setResolution, dispose };
}
