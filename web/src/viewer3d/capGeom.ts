// Shared cap-geometry utilities.
//
// Both the section-cap controller (sectionCaps.ts) and the client-side niche
// positive-volume reconstruction (viewer.ts) need the same two primitives:
//   1. weld a soup of unordered 3D segments into ordered loops, and
//   2. triangulate one or more coplanar loops (with hole nesting) into a flat
//      cap that is then either rendered directly or lifted to 3D.
//
// Robustified loop/fill algorithm
// --------------------------------
// * Welding uses an epsilon RELATIVE to the model scale, so big models (mm in a
//   metre file, or models authored far from the origin) still weld correctly.
// * We do NOT require a perfectly closed loop set. We greedily walk chains of
//   segments; any chain with >= 3 distinct points whose endpoints are within a
//   (slightly larger) "close" epsilon is treated as a closed loop and
//   triangulated. Truly-open short fragments are dropped. This means a single
//   not-quite-welded wall cross-section still fills instead of degrading to a
//   bare contour.
// * Nesting: loops are projected into the plane's 2D (u,v) basis; a loop fully
//   contained inside another loop with OPPOSITE winding is treated as a HOLE of
//   it (e.g. a niche carved into a wall section). Disjoint loops become
//   separate filled regions. triangulateLoops() returns one face set per
//   top-level region with its direct holes.

import * as THREE from "three";

export type Seg3 = { a: THREE.Vector3; b: THREE.Vector3 };

/** A region ready to triangulate: an outer 2D contour + its direct holes,
 *  plus the matching 3D points (parallel arrays) so callers can lift faces. */
export type CapRegion = {
  /** outer + hole loops in 2D, contour first. */
  loops2D: THREE.Vector2[][];
  /** the same loops in 3D (parallel to loops2D). */
  loops3D: THREE.Vector3[][];
  /** index (into loops2D/loops3D) of the outer contour. Always 0 here. */
};

/** Result of triangulating one region: flat triangle positions in 3D. */
export type CapTriangles = number[];

/**
 * Weld unordered segments into ordered loops in 3D.
 * `weldEps` is the merge tolerance; `closeEps` is how close a chain's endpoints
 * must be to be accepted as a closed loop (defaults to 4x weldEps). Only chains
 * with >= 3 distinct points are returned. Open fragments are dropped.
 */
export function assembleLoops3D(
  segs: Seg3[],
  weldEps: number,
  closeEps = weldEps * 4,
): THREE.Vector3[][] {
  if (segs.length === 0) return [];
  // Point pool with welding.
  const pool: THREE.Vector3[] = [];
  const keyOf = (p: THREE.Vector3): number => {
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].distanceTo(p) <= weldEps) return i;
    }
    pool.push(p.clone());
    return pool.length - 1;
  };
  const adj = new Map<number, number[]>();
  const addAdj = (u: number, v: number) => {
    const arr = adj.get(u);
    if (arr) arr.push(v);
    else adj.set(u, [v]);
  };
  for (const s of segs) {
    const u = keyOf(s.a);
    const v = keyOf(s.b);
    if (u === v) continue;
    addAdj(u, v);
    addAdj(v, u);
  }

  const usedEdge = new Set<string>();
  const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  const out: THREE.Vector3[][] = [];
  const visitedStart = new Set<number>();
  const guardMax = segs.length * 2 + 8;

  for (const start of adj.keys()) {
    if (visitedStart.has(start)) continue;
    const chain: number[] = [start];
    let cur = start;
    let prev = -1;
    let closed = false;
    for (let step = 0; step < guardMax; step++) {
      const neighbours = adj.get(cur) || [];
      let next = -1;
      for (const n of neighbours) {
        if (n === prev) continue;
        if (usedEdge.has(edgeKey(cur, n))) continue;
        next = n;
        break;
      }
      if (next === -1) {
        // No unused outgoing edge. Try to close back to start.
        if (cur !== start && (adj.get(cur) || []).includes(start) && !usedEdge.has(edgeKey(cur, start))) {
          usedEdge.add(edgeKey(cur, start));
          closed = true;
        }
        break;
      }
      usedEdge.add(edgeKey(cur, next));
      if (next === start) { closed = true; break; }
      chain.push(next);
      prev = cur;
      cur = next;
    }
    for (const c of chain) visitedStart.add(c);
    if (chain.length < 3) continue; // open fragment, drop
    const pts = chain.map((i) => pool[i].clone());
    // Accept as a loop if topologically closed OR endpoints geometrically near.
    if (closed || pts[0].distanceTo(pts[pts.length - 1]) <= closeEps) {
      out.push(pts);
    }
  }
  return out;
}

/** Signed area of a 2D polygon (CCW positive). */
function signedArea2D(pts: THREE.Vector2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Point-in-polygon (ray cast) for a 2D loop. */
function pointInPoly(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      (yi > p.y) !== (yj > p.y) &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Build an orthonormal (u,v) basis on a plane normal.
 */
export function planeBasis(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const u = new THREE.Vector3();
  if (Math.abs(n.x) < 0.9) u.set(1, 0, 0);
  else u.set(0, 1, 0);
  u.crossVectors(u, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v, n };
}

/**
 * Group coplanar 3D loops into top-level regions (outer + directly contained
 * holes) by point-in-polygon containment, then triangulate each region.
 * Returns flat 3D triangle positions for every region combined. Never throws;
 * returns an empty array on total failure.
 *
 * `origin`,`u`,`v` define the plane's 2D mapping. If omitted they are derived
 * from the first loop and the supplied normal.
 */
export function triangulateLoops(
  loops3D: THREE.Vector3[][],
  normal: THREE.Vector3,
): CapTriangles {
  const out: number[] = [];
  if (loops3D.length === 0) return out;
  const { u, v } = planeBasis(normal);
  const origin = loops3D[0][0].clone();
  const to2D = (p: THREE.Vector3): THREE.Vector2 => {
    const d = p.clone().sub(origin);
    return new THREE.Vector2(d.dot(u), d.dot(v));
  };
  const lift = (p2: THREE.Vector2): THREE.Vector3 =>
    origin.clone().addScaledVector(u, p2.x).addScaledVector(v, p2.y);

  type LoopInfo = { i: number; pts2: THREE.Vector2[]; area: number; absArea: number };
  const infos: LoopInfo[] = [];
  for (let i = 0; i < loops3D.length; i++) {
    const pts2 = loops3D[i].map(to2D);
    const area = signedArea2D(pts2);
    const absArea = Math.abs(area);
    if (absArea < 1e-12) continue; // degenerate
    infos.push({ i, pts2, area, absArea });
  }
  if (infos.length === 0) return out;
  // Sort largest-first so we test containment of smaller loops in larger ones.
  infos.sort((a, b) => b.absArea - a.absArea);

  // For each loop, find its smallest strict container (the parent). A loop with
  // no parent is a top-level outer contour; a loop whose nearest container is a
  // top-level outer contour is a hole of it. Deeper nesting (island in a hole)
  // becomes its own outer contour again.
  const parentOf = new Map<number, number>(); // info-index -> info-index
  for (let a = 0; a < infos.length; a++) {
    let bestParent = -1;
    let bestArea = Infinity;
    const sample = infos[a].pts2[0];
    for (let b = 0; b < infos.length; b++) {
      if (a === b) continue;
      if (infos[b].absArea <= infos[a].absArea) continue;
      if (pointInPoly(sample, infos[b].pts2) && infos[b].absArea < bestArea) {
        bestParent = b;
        bestArea = infos[b].absArea;
      }
    }
    if (bestParent !== -1) parentOf.set(a, bestParent);
  }
  // Nesting depth parity: depth 0 = outer, depth 1 = hole, depth 2 = outer, …
  const depthOf = (a: number): number => {
    let d = 0;
    let cur = a;
    const guard = infos.length + 1;
    while (parentOf.has(cur) && d <= guard) { cur = parentOf.get(cur)!; d++; }
    return d;
  };

  // Build region groups: each even-depth loop is an outer contour; its holes
  // are the odd-depth loops whose direct parent is this loop.
  for (let a = 0; a < infos.length; a++) {
    if (depthOf(a) % 2 !== 0) continue; // only outer contours start a region
    const outer = infos[a];
    const holes: LoopInfo[] = [];
    for (let b = 0; b < infos.length; b++) {
      if (b === a) continue;
      if (parentOf.get(b) === a && depthOf(b) % 2 === 1) holes.push(infos[b]);
    }
    // triangulateShape wants the contour CCW and holes CW (or vice versa); it
    // is winding-tolerant in practice, but we normalise to keep results stable.
    const contour = outer.area < 0 ? [...outer.pts2].reverse() : outer.pts2;
    const holes2D = holes.map((h) => (h.area > 0 ? [...h.pts2].reverse() : h.pts2));
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holes2D);
    } catch {
      continue; // skip this region, keep others
    }
    if (!faces || faces.length === 0) continue;
    const flat2D: THREE.Vector2[] = contour.slice();
    for (const h of holes2D) for (const p of h) flat2D.push(p);
    for (const tri of faces) {
      let ok = true;
      const buf: number[] = [];
      for (const vi of tri) {
        const p2 = flat2D[vi];
        if (!p2) { ok = false; break; }
        const p3 = lift(p2);
        buf.push(p3.x, p3.y, p3.z);
      }
      if (ok) out.push(...buf);
    }
  }
  return out;
}
