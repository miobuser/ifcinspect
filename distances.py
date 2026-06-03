"""
distances.py - L7 pairwise distance computations for the astra-wall-validator.

Computes signed/min distances between every pair of IfcProducts whose AABBs
are within `max_pair_distance_m` (default 10 m). For each candidate pair:

  - min_distance_m :  minimum surface-point distance (0 if AABBs intersect AND
                      the meshes actually touch).
  - overlap_volume_m3 :  axis-aligned bbox-overlap volume (0 if disjoint).

Measurement modes (additive per-pair fields, so a rule can pick HOW it measures
by choosing the target field):

  - min_distance_m :          shortest 3D surface distance (default, see above).
  - horizontal_distance_m :   shortest distance in the XY plane (Z ignored).
                              Same subsample method, but with z set to 0 on both
                              sides before closest_point. APPROXIMATION: it is
                              the horizontal component of the surface clearance,
                              i.e. the grundriss/plan distance.
  - vertical_distance_m :     pure Z gap between the two Z-intervals of the
                              meshes (0 if they overlap in Z, else |gap|).
                              Exact and robust (AABB-Z based).
  - perpendicular_distance_m: best-effort distance along the wall's dominant
                              HORIZONTAL normal (PCA over the wall-like product's
                              vertices). Needs at least one wall-like product in
                              the pair; otherwise None + a reason. This is an
                              APPROXIMATION and falls back cleanly to None (never
                              a wrong value, never a crash) when no wall
                              reference is derivable or the projection is fragile.

Speed:
  - AABB prefilter so cost is roughly O(pairs_kept), not O(n^2 surface dist).
  - Uses trimesh.proximity.closest_point on vertex subsamples (subsamples to
    100 vertices per side) instead of signed_distance, which is much faster
    for tessellated meshes and accurate enough for clearance reporting.

Defensive: never raises; per-pair failures emit a stderr warning and the pair
is omitted from the output list.
"""
from __future__ import annotations

import sys

import numpy as np
import trimesh
import trimesh.proximity
import trimesh.triangles as _tritools
from scipy.spatial import cKDTree


# --------------------------------------------------------------------------- #
#  Fast EXACT point-to-surface distance (cKDTree centroid prune)
# --------------------------------------------------------------------------- #
# trimesh.proximity.closest_point needs a spatial index (rtree) to skip far
# triangles. In Pyodide (browser) rtree has no WASM wheel and is stubbed to
# return ALL triangles, so every query degrades to O(faces) -- the dominant cost
# of the whole pipeline on tessellated models (~500 s on the Thesis example).
#
# We reproduce trimesh's result (which, with the all-faces stub, is exactly
# closest_point_naive == brute force over every triangle) but evaluate only a
# provably-sufficient candidate set:
#
#   For query point p let D = distance to the closest triangle T*. Every point
#   of T* (incl. its centroid c*) is within max_edge of T*'s nearest point to p,
#   so |p - c*| <= D + max_edge. A vertex lies on the surface, hence D <= the
#   nearest-vertex distance, and the global min over points is an upper bound
#   `best`. Querying triangle centroids within `best + max_edge` of p is
#   therefore guaranteed to contain T*. Distances are reduced with nanmin so the
#   zero-area triangles produced by XY-flattening (which yield NaN, exactly as
#   trimesh discards them) cannot corrupt the minimum. Result == brute force to
#   float precision; only the candidate set shrinks.
#
# Caches are keyed by id(mesh) and CLEARED at the top of scene_distances (the
# meshes are alive for that whole call, so an id can never alias a stale tree).

_MESH_IDX: dict = {}     # id(mesh) -> (vtree, ctree, tris(m,3,3), max_edge)
_FLAT_MESH: dict = {}    # id(mesh) -> flattened-XY trimesh (cached)


def _reset_distance_caches():
    _MESH_IDX.clear()
    _FLAT_MESH.clear()


def _mesh_index(mesh):
    """Build (and cache) cKDTrees over the mesh vertices and triangle centroids
    plus the triangle array and the longest edge length."""
    key = id(mesh)
    c = _MESH_IDX.get(key)
    if c is not None:
        return c
    V = np.asarray(mesh.vertices, dtype=float)
    F = np.asarray(mesh.faces, dtype=np.int64)
    if len(F) == 0 or len(V) == 0:
        c = (None, None, np.empty((0, 3, 3)), 0.0)
        _MESH_IDX[key] = c
        return c
    tris = V[F]                                          # (m, 3, 3)
    edges = np.concatenate([
        np.linalg.norm(tris[:, 0] - tris[:, 1], axis=1),
        np.linalg.norm(tris[:, 1] - tris[:, 2], axis=1),
        np.linalg.norm(tris[:, 2] - tris[:, 0], axis=1)])
    max_edge = float(edges.max())
    centroids = tris.mean(axis=1)
    c = (cKDTree(V), cKDTree(centroids), tris, max_edge)
    _MESH_IDX[key] = c
    return c


def _min_surface_distance(mesh, query_pts):
    """Global min over query_pts of the exact distance(point, mesh surface).

    Equals the brute-force min over ALL triangles (== what the rtree-less browser
    computes via trimesh) to float precision. Returns None for empty input.

    The per-point early-break loop processes points closest-centroid-first and
    stops once the centroid lower bound (dcent - max_edge) exceeds the running
    best, so far pairs touch only a handful of points. Each point tests just the
    triangles whose centroid lies within best+max_edge -- a set guaranteed to
    contain its closest triangle (a vertex lies on the surface so D <= best, and
    the closest triangle's centroid is within D+max_edge). Per-point candidate
    triangles are tested with trimesh's own exact projection + nanmin, so XY
    flatten's zero-area triangles drop out exactly as trimesh does."""
    vtree, ctree, tris, max_edge = _mesh_index(mesh)
    P = np.asarray(query_pts, dtype=float)
    if vtree is None or len(P) == 0:
        return None
    dvert, _ = vtree.query(P)                # D_p <= nearest-vertex distance
    dcent, _ = ctree.query(P)                # nearest centroid per point
    best = float(np.min(dvert))              # valid global upper bound on D
    lb = dcent - max_edge                    # per-point lower bound on D_p
    order = np.argsort(dcent)                # closest-first so `best` drops fast
    # Collect the per-point triangle neighbourhoods that survive the early break,
    # then evaluate them all in ONE concatenated closest_point call. trimesh's
    # per-call wrapper overhead (is_shape/is_sequence/zeros_like/ones, ~3 us each)
    # was the dominant cost at ~200k calls; batching collapses it to one call.
    radius = best + max_edge
    pos = ctree.query_ball_point(P, radius)  # vectorised: list per point
    tri_blocks = []
    pt_blocks = []
    for i in order:
        if lb[i] >= best:
            break                            # lb monotone in dcent -> rest pruned
        fids = pos[i]
        if not fids:
            continue
        tri_blocks.append(tris[fids])
        pt_blocks.append(np.broadcast_to(P[i], (len(fids), 3)))
    if not tri_blocks:
        return best
    all_tris = np.concatenate(tri_blocks, axis=0)
    all_pts = np.concatenate(pt_blocks, axis=0)
    cp = _tritools.closest_point(all_tris, all_pts)
    dd = np.linalg.norm(cp - all_pts, axis=1)
    m = float(np.nanmin(dd)) if dd.size else np.inf
    return min(best, m)


def surface_distances(mesh, query_pts):
    """Per-point EXACT distance(point, mesh surface), memory-safe.

    Same candidate-prune guarantee as _min_surface_distance (a point's closest
    triangle has its centroid within nearest-vertex-distance + max_edge), but
    returns the distance for EVERY query point (1-D array aligned with
    query_pts) instead of the global minimum. L6 (context.external_context)
    needs the per-class median of K4/K5 -> terrain distances; this avoids the
    O(faces) allocation of trimesh.proximity.closest_point that OOMs the WASM
    heap on large DTMs. Returns None for empty input."""
    vtree, ctree, tris, max_edge = _mesh_index(mesh)
    P = np.asarray(query_pts, dtype=float)
    if vtree is None or len(P) == 0:
        return None
    dvert, _ = vtree.query(P)            # per-point upper bound on the distance
    out = np.empty(len(P), dtype=float)
    for i in range(len(P)):
        fids = ctree.query_ball_point(P[i], float(dvert[i]) + max_edge)
        if not fids:
            out[i] = float(dvert[i])
            continue
        ct = tris[fids]
        cp = _tritools.closest_point(ct, np.broadcast_to(P[i], (len(fids), 3)))
        dd = np.linalg.norm(cp - P[i], axis=1)
        m = float(np.nanmin(dd)) if dd.size else float(dvert[i])
        out[i] = min(float(dvert[i]), m)
    return out


# --------------------------------------------------------------------------- #
#  AABB prefilter
# --------------------------------------------------------------------------- #
def _aabb_distance(a, b):
    """Manhattan-zero L2 distance between two axis-aligned bounding boxes.

    a, b: (2, 3) arrays [[xmin,ymin,zmin],[xmax,ymax,zmax]]. Returns 0.0 if
    the boxes intersect."""
    d = np.zeros(3, dtype=float)
    for k in range(3):
        if a[1, k] < b[0, k]:
            d[k] = b[0, k] - a[1, k]
        elif b[1, k] < a[0, k]:
            d[k] = a[0, k] - b[1, k]
    return float(np.linalg.norm(d))


def _aabb_overlap_volume(a, b):
    lo = np.maximum(a[0], b[0])
    hi = np.minimum(a[1], b[1])
    d = hi - lo
    if np.any(d <= 0):
        return 0.0
    return float(np.prod(d))


def aabb_pair_candidates(products, max_pair_distance_m=10.0):
    """Return list of (i, j) pairs whose AABBs are within `max_pair_distance_m`.

    i < j; products of zero faces are skipped."""
    boxes = []
    valid = []
    for k, p in enumerate(products):
        try:
            b = p.mesh.bounds
            if b is None or len(getattr(p.mesh, "faces", [])) == 0:
                continue
            boxes.append(np.asarray(b, dtype=float))
            valid.append(k)
        except Exception:
            continue
    pairs = []
    n = len(valid)
    for ia in range(n):
        for ib in range(ia + 1, n):
            if _aabb_distance(boxes[ia], boxes[ib]) <= max_pair_distance_m:
                pairs.append((valid[ia], valid[ib],
                             boxes[ia], boxes[ib]))
    return pairs


# --------------------------------------------------------------------------- #
#  Per-pair distance
# --------------------------------------------------------------------------- #
def _subsample_vertices(mesh, max_n=100):
    V = np.asarray(mesh.vertices)
    if len(V) <= max_n:
        return V
    idx = np.linspace(0, len(V) - 1, max_n).astype(int)
    return V[idx]


def pair_distance(mesh_a, mesh_b):
    """Min surface distance between two meshes (m). Uses sampled vertices on
    each side queried against the other mesh via trimesh.proximity.closest_point;
    takes the min of both directions. Returns 0.0 on overlap (AABBs intersect
    and closest distance ~= 0)."""
    try:
        va = _subsample_vertices(mesh_a, 100)
        vb = _subsample_vertices(mesh_b, 100)
        da = _min_surface_distance(mesh_b, va)
        db = _min_surface_distance(mesh_a, vb)
        cands = [x for x in (da, db) if x is not None]
        if not cands:
            return None
        return max(float(min(cands)), 0.0)
    except Exception as e:
        sys.stderr.write(f"[distances] pair_distance failed: "
                         f"{type(e).__name__}: {e}\n")
        return None


# --------------------------------------------------------------------------- #
#  Measurement-mode helpers (additive distance fields)
# --------------------------------------------------------------------------- #
def _flatten_xy(mesh):
    """Return a trimesh whose vertices are projected onto the XY plane (z=0).

    Faces are kept; the result is a degenerate (zero-thickness) mesh that is
    only ever used as a point/face cloud for closest_point in the XY plane.
    Cached by id(mesh) so the flattened mesh + its cKDTrees are built once per
    scene. Never raises."""
    key = id(mesh)
    fm = _FLAT_MESH.get(key)
    if fm is not None:
        return fm
    V = np.asarray(mesh.vertices, dtype=float).copy()
    V[:, 2] = 0.0
    fm = trimesh.Trimesh(vertices=V, faces=np.asarray(mesh.faces),
                         process=False)
    _FLAT_MESH[key] = fm
    return fm


def pair_distance_horizontal(mesh_a, mesh_b):
    """Shortest distance between the two meshes in the XY plane (Z ignored).

    Method (consistent with `pair_distance`): both meshes' vertices are
    projected to z=0; the subsampled vertices of each flattened side are queried
    against the other flattened mesh via closest_point, and the min over both
    directions is taken. This is the horizontal component of the surface
    clearance (grundriss distance). APPROXIMATION: same subsample limitation as
    the 3D path. Returns >= 0.0, or None on failure."""
    try:
        fa = _flatten_xy(mesh_a)
        fb = _flatten_xy(mesh_b)
        va = _subsample_vertices(fa, 100)
        vb = _subsample_vertices(fb, 100)
        da = _min_surface_distance(fb, va)
        db = _min_surface_distance(fa, vb)
        cands = [x for x in (da, db) if x is not None]
        if not cands:
            return None
        return max(float(min(cands)), 0.0)
    except Exception as e:
        sys.stderr.write(f"[distances] horizontal distance failed: "
                         f"{type(e).__name__}: {e}\n")
        return None


def pair_distance_vertical(box_a, box_b):
    """Pure Z gap between the Z-intervals of the two meshes (AABB-based).

    box_a, box_b: (2,3) bounds arrays. Returns 0.0 if the Z-intervals overlap,
    otherwise the absolute size of the vertical gap. Exact and robust."""
    try:
        a_lo, a_hi = float(box_a[0, 2]), float(box_a[1, 2])
        b_lo, b_hi = float(box_b[0, 2]), float(box_b[1, 2])
        if a_hi < b_lo:
            return float(b_lo - a_hi)
        if b_hi < a_lo:
            return float(a_lo - b_hi)
        return 0.0
    except Exception:
        return None


def _is_wall_like(product):
    """Heuristic: True if the product looks like a wall (by IFC type or name)."""
    t = str(getattr(product, "ifc_type", "") or "").lower()
    n = str(getattr(product, "name", "") or "").lower()
    for key in ("wall", "wand", "mauer", "retaining"):
        if key in t or key in n:
            return True
    return False


def _dominant_horizontal_normal(mesh):
    """Dominant horizontal wall normal via PCA over the vertices.

    A wall is a thin vertical slab: in the horizontal (XY) plane its vertices
    spread far along the wall run and barely along the thickness. The SMALLEST
    horizontal principal axis therefore points across the wall = the wall's
    horizontal normal. Returns a unit (2,)->(3,) vector with z=0, or None when
    the wall is too square in plan to disambiguate (fragile -> None)."""
    try:
        V = np.asarray(mesh.vertices, dtype=float)[:, :2]
        if len(V) < 3:
            return None
        Vc = V - V.mean(0)
        _, S, Vt = np.linalg.svd(Vc, full_matrices=False)
        # S[0] >= S[1]; the smallest-spread axis Vt[1] is the wall normal.
        if S[0] < 1e-9:
            return None
        # need a clear anisotropy, else "normal" is meaningless (square footprint)
        if S[1] / S[0] > 0.9:
            return None
        n = np.array([Vt[1, 0], Vt[1, 1], 0.0], dtype=float)
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            return None
        return n / nn
    except Exception:
        return None


def pair_distance_perpendicular(mesh_a, mesh_b, prod_a, prod_b):
    """Best-effort distance along the wall normal. Returns (value, reason).

    If at least one product is wall-like, its dominant horizontal normal is
    computed (PCA, smallest horizontal axis). The shortest connecting segment
    (centroid-to-centroid as a robust proxy) is projected onto that normal:
    |(c_b - c_a) . n|. This is an APPROXIMATION of the across-the-wall clearance
    and explicitly needs a wall reference. On any failure or when no wall
    reference / no clear normal is derivable, returns (None, reason) -- never a
    crash, never a wrong value."""
    try:
        wall_mesh = None
        if _is_wall_like(prod_a):
            wall_mesh = mesh_a
        elif _is_wall_like(prod_b):
            wall_mesh = mesh_b
        if wall_mesh is None:
            return None, "no wall-like product in pair (perpendicular needs a wall reference)"
        n = _dominant_horizontal_normal(wall_mesh)
        if n is None:
            return None, "no clear horizontal wall normal (square footprint / degenerate PCA)"
        ca = np.asarray(mesh_a.centroid, dtype=float)
        cb = np.asarray(mesh_b.centroid, dtype=float)
        proj = abs(float(np.dot(cb - ca, n)))
        return proj, None
    except Exception as e:
        return None, f"perpendicular failed: {type(e).__name__}: {e}"


# --------------------------------------------------------------------------- #
#  Public entry point
# --------------------------------------------------------------------------- #
def scene_distances(products, max_pair_distance_m=10.0):
    """Compute the L7 distance table.

    `products`: list[LoadedProduct] (or any object with .guid, .name,
    .ifc_type, .mesh).

    Returns: list[dict] with keys:
        from_guid, from_name, from_type,
        to_guid, to_name, to_type,
        min_distance_m, overlap_volume_m3, aabb_distance_m,
        horizontal_distance_m, vertical_distance_m,
        perpendicular_distance_m, perpendicular_reason.
    The last four are the additive measurement-mode fields (see module docstring);
    perpendicular_distance_m is None with a reason in perpendicular_reason when no
    wall reference is derivable.
    Sorted by min_distance_m ascending (touching/overlapping first).
    """
    out = []
    if not products or len(products) < 2:
        return out
    # Fresh per-scene caches (cKDTrees + flattened meshes). Bounds id(mesh)
    # cache lifetime to this call so a recycled id can never alias a stale tree.
    _reset_distance_caches()
    cands = aabb_pair_candidates(products, max_pair_distance_m)
    for ia, ib, ba, bb in cands:
        pa = products[ia]; pb = products[ib]
        try:
            ovl = _aabb_overlap_volume(ba, bb)
            d = pair_distance(pa.mesh, pb.mesh)
            if d is None:
                continue
            d_h = pair_distance_horizontal(pa.mesh, pb.mesh)
            d_v = pair_distance_vertical(ba, bb)
            d_perp, perp_reason = pair_distance_perpendicular(
                pa.mesh, pb.mesh, pa, pb)
            out.append({
                "from_guid": getattr(pa, "guid", ""),
                "from_name": getattr(pa, "name", "") or getattr(pa, "ifc_type", ""),
                "from_type": getattr(pa, "ifc_type", ""),
                "to_guid": getattr(pb, "guid", ""),
                "to_name": getattr(pb, "name", "") or getattr(pb, "ifc_type", ""),
                "to_type": getattr(pb, "ifc_type", ""),
                "min_distance_m": float(d),
                "overlap_volume_m3": float(ovl),
                "aabb_distance_m": _aabb_distance(ba, bb),
                "horizontal_distance_m": (float(d_h) if d_h is not None else None),
                "vertical_distance_m": (float(d_v) if d_v is not None else None),
                "perpendicular_distance_m": (float(d_perp) if d_perp is not None
                                             else None),
                "perpendicular_reason": perp_reason,
            })
        except Exception as e:
            sys.stderr.write(f"[distances] pair {ia}-{ib} failed: "
                             f"{type(e).__name__}: {e}\n")
            continue
    out.sort(key=lambda r: r["min_distance_m"])
    return out


__all__ = ["scene_distances", "aabb_pair_candidates", "pair_distance",
           "pair_distance_horizontal", "pair_distance_vertical",
           "pair_distance_perpendicular"]
