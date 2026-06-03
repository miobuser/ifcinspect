"""
adjacency.py - L5 general neighbourhood graph over ALL scene elements.

ADDITIVE feature (Abgabe 2026-06-02): a purely geometric adjacency graph that
complements the per-wall L5 stem<->foundation analysis (`context.py`) and the
L7 pairwise distances (`distances.py`). For every pair of scene products it
decides whether — and HOW — the two solids touch, hierarchically:

    FACE  > EDGE > POINT

i.e. shared coplanar surface beats a shared edge beats a shared vertex. The
metric is *shared geometry*, frame-independent (all products are already in
WORLD coordinates), so NO `offset` is needed.

Why this and not just L7 distances? L7 reports the *clearance* between two
products (min distance, 0 on contact). It does NOT say whether the contact is a
full face (wall sitting on its footing), a line (two walls meeting at a corner)
or a single point (two solids kissing at a vertex). The adjacency graph adds
that contact *topology* plus a CONTAINMENT measure — for a wall standing on a
footing, `containment` of the wall's underside tells how much of the wall's
contact plane is actually supported by the partner (≈1.0 = fully borne).

Design constraints (Thesis tool, browser/Pyodide target):
  * pure numpy + scipy.spatial.cKDTree only. NO shapely at runtime (shapely is
    only in the test/model generators, NOT in the Wheel / Pyodide). The convex
    polygon intersection is a pure-numpy Sutherland-Hodgman clip (triangle ∩
    triangle, both convex).
  * NEVER raise: any per-pair failure is swallowed and the pair skipped. The
    public `scene_adjacency` returns a (possibly empty) list of edge dicts.
  * performance mirrors distances.py: cKDTree over vertices for shared-point
    counting, AABB prefilter, and per-pair candidate-face restriction by
    triangle-bbox overlap so a huge terrain mesh stays cheap.

All numeric units: lengths m, areas m^2.

Edge dict schema (one per adjacent pair):
    {
      "a_guid", "a_name", "a_type",
      "b_guid", "b_name", "b_type",
      "level":                 "face" | "edge" | "point",
      "shared_area_m2":        float (0.0 unless level=="face"),
      "shared_edge_length_m":  float (0.0 unless level=="edge"),
      "shared_point_count":    int,
      "containment_a":         float|None (shared_area / contact-plane area of a),
      "containment_b":         float|None (analogous for b),
    }
"""
from __future__ import annotations

import sys

import numpy as np
from scipy.spatial import cKDTree

# `_median_edge_length` is the resolution-based tolerance basis used across the
# pipeline (context.py). Reuse it so the adjacency tolerance shares the same
# geometric derivation rather than introducing a new tuned constant.
from context import _median_edge_length


# --------------------------------------------------------------------------- #
#  Per-element geometry bundle
# --------------------------------------------------------------------------- #
class _Elem:
    """Precomputed geometry for one scene product (built once per element)."""

    __slots__ = ("guid", "name", "ifc_type", "vertices", "faces",
                 "face_normals", "area_faces", "triangles", "bmin", "bmax",
                 "mel", "vtree")

    def __init__(self, product):
        m = product.mesh
        self.guid = getattr(product, "guid", "") or ""
        self.name = getattr(product, "name", "") or getattr(product, "ifc_type", "")
        self.ifc_type = getattr(product, "ifc_type", "") or ""
        V = np.asarray(m.vertices, dtype=float)
        F = np.asarray(m.faces, dtype=np.int64)
        self.vertices = V
        self.faces = F
        self.face_normals = np.asarray(m.face_normals, dtype=float)
        self.area_faces = np.asarray(m.area_faces, dtype=float)
        self.triangles = V[F] if len(F) else np.empty((0, 3, 3))
        if len(V):
            self.bmin = V.min(axis=0)
            self.bmax = V.max(axis=0)
        else:
            self.bmin = np.zeros(3)
            self.bmax = np.zeros(3)
        mel = _median_edge_length(m, np.arange(len(F))) if len(F) else None
        self.mel = float(mel) if (mel is not None and mel > 0) else None
        self.vtree = cKDTree(V) if len(V) else None


def _build_elem(product):
    """Build an `_Elem`, returning None on any failure (NEVER raise)."""
    try:
        m = getattr(product, "mesh", None)
        if m is None or len(getattr(m, "faces", [])) == 0:
            return None
        return _Elem(product)
    except Exception as e:
        sys.stderr.write(f"[adjacency] element build failed for "
                         f"{getattr(product, 'guid', '?')}: "
                         f"{type(e).__name__}: {e}\n")
        return None


# --------------------------------------------------------------------------- #
#  AABB helpers
# --------------------------------------------------------------------------- #
def _boxes_overlap(amin, amax, bmin, bmax, tol):
    """True if the two AABBs overlap when each is inflated by `tol`."""
    return bool(np.all(amax + tol >= bmin) and np.all(bmax + tol >= amin))


def _tri_bbox_mask(triangles, lo, hi, tol):
    """Boolean mask of triangles whose own bbox intersects [lo, hi]+tol.

    Keeps the coplanar-overlap search cheap on large meshes (only the handful
    of triangles near the partner's bbox survive)."""
    if len(triangles) == 0:
        return np.zeros(0, dtype=bool)
    tmin = triangles.min(axis=1)        # (F, 3)
    tmax = triangles.max(axis=1)        # (F, 3)
    return np.all(tmax + tol >= lo, axis=1) & np.all(tmin - tol <= hi, axis=1)


# --------------------------------------------------------------------------- #
#  Sutherland-Hodgman convex polygon clipping (pure numpy, no shapely)
# --------------------------------------------------------------------------- #
def _polygon_area_2d(poly):
    """Absolute area of a 2D polygon (shoelace). poly: (n, 2)."""
    n = len(poly)
    if n < 3:
        return 0.0
    x = poly[:, 0]
    y = poly[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _orient_ccw(tri2d):
    """Return the triangle's 2D vertices in CCW order (clip polygon must be CCW
    for the inside-test sign convention below)."""
    a, b, c = tri2d
    cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if cross < 0:
        return tri2d[::-1]
    return tri2d


def _clip_convex(subject, clip_ccw):
    """Sutherland-Hodgman: clip convex `subject` polygon by convex CCW `clip_ccw`.

    subject: (n, 2) array of polygon vertices (convex).
    clip_ccw: (m, 2) CCW convex clipping polygon.
    Returns the (possibly empty) clipped polygon as an (k, 2) array.

    Both inputs are convex (triangles here), so the classic half-plane clip is
    exact. Edges of the CCW clip polygon have the interior on their LEFT, so a
    point is 'inside' an edge (p0->p1) iff cross(p1-p0, x-p0) >= 0."""
    out = subject
    m = len(clip_ccw)
    for i in range(m):
        if len(out) == 0:
            break
        p0 = clip_ccw[i]
        p1 = clip_ccw[(i + 1) % m]
        ex = p1[0] - p0[0]
        ey = p1[1] - p0[1]

        def _inside(pt):
            return (ex * (pt[1] - p0[1]) - ey * (pt[0] - p0[0])) >= -1e-12

        new_out = []
        n = len(out)
        for j in range(n):
            cur = out[j]
            prev = out[j - 1]
            cur_in = _inside(cur)
            prev_in = _inside(prev)
            if cur_in:
                if not prev_in:
                    new_out.append(_line_intersect(prev, cur, p0, p1))
                new_out.append(cur)
            elif prev_in:
                new_out.append(_line_intersect(prev, cur, p0, p1))
        out = np.asarray(new_out, dtype=float) if new_out else np.empty((0, 2))
    return out


def _line_intersect(a, b, c, d):
    """Intersection point of infinite lines (a->b) and (c->d). a,b,c,d: (2,)."""
    r = b - a
    s = d - c
    denom = r[0] * s[1] - r[1] * s[0]
    if abs(denom) < 1e-15:
        return b  # near-parallel: degenerate, return endpoint (clip robustly drops it)
    t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denom
    return a + t * r


def _tri_tri_overlap_area_2d(tri_a, tri_b):
    """Area of intersection of two 2D triangles (both convex) via S-H clip."""
    clip = _orient_ccw(np.asarray(tri_b, dtype=float))
    poly = _clip_convex(np.asarray(tri_a, dtype=float), clip)
    return _polygon_area_2d(poly)


# --------------------------------------------------------------------------- #
#  Coplanarity test (continuous, frame-independent)
# --------------------------------------------------------------------------- #
# Two solids in contact present ANTIPARALLEL faces at the interface (solid A's
# normal points toward B, B's toward A). Coplanarity is therefore tested on the
# UN-ORIENTED normal (|n_a . n_b|), so the antiparallel sign is irrelevant.
#
# IMPORTANT — why no plane *grid* bucketing any more:
# The previous implementation hashed each face into a hard plane grid
# (rounded canonical normal + rounded offset dq = round(d / tol)). That snaps a
# CONTINUOUS quantity onto cell boundaries and silently drops every contact
# whose interface plane is not axis-aligned: a battered / sloped wall flush on a
# matching sloped footing has its offset `d` quantised from a single vertex, so
# the two flush planes can land 2-3 cells apart (e.g. dq = -23 vs -20) and the
# rounded-normal grid splits ~1 deg normal pairs into different buckets. Result:
# scene_adjacency == [] for exactly the battered ASTRA walls / sloped terrain
# that are the thesis core. The fix below replaces the grid by a continuous
# proximity test (centroid cKDTree + bbox prefilter keep it cheap), so there are
# NO cell boundaries to fall across.

# angular coplanarity threshold ~ 5 degrees on the un-oriented normal:
# cos(5deg) ~ 0.99619. Two faces count as parallel iff |n_a . n_b| >= ANG_TOL.
# Derived from the spec's "~5 grad" coplanarity requirement, not a tuned
# classifier threshold.
ANG_TOL = 0.9962


def _circumradius(tri3d):
    """Approximate face "size" of a triangle: the max distance from its centroid
    to its three vertices (an upper bound on the half-extent / circumradius).

    Used to size the centroid-cKDTree query radius so that two faces whose
    surfaces overlap (but whose centroids may be offset by up to roughly the
    larger face's reach) are always returned as a candidate pair."""
    t = np.asarray(tri3d, dtype=float)
    c = t.mean(axis=0)
    return float(np.max(np.linalg.norm(t - c, axis=1)))


def _plane_basis(normal):
    """An orthonormal 2D basis (u, v) spanning the plane with the given normal."""
    n = np.asarray(normal, dtype=float)
    n = n / max(np.linalg.norm(n), 1e-12)
    # pick the world axis least aligned with n as the seed for u
    seed = np.eye(3)[int(np.argmin(np.abs(n)))]
    u = seed - np.dot(seed, n) * n
    u = u / max(np.linalg.norm(u), 1e-12)
    v = np.cross(n, u)
    return u, v


# --------------------------------------------------------------------------- #
#  Shared FACE (coplanar overlap)
# --------------------------------------------------------------------------- #
def _shared_face(ea, eb, cand_a, cand_b, tol):
    """Coplanar overlap area between candidate faces of two elements.

    PROXIMITY-based coplanarity pairing with a CONTINUOUS tolerance (no plane
    grid, no hashing, no cell boundaries — see the module note above on why the
    old hard-grid bucketing dropped every non-axis-aligned contact):

      1. candidate faces are already bbox-pruned by the caller.
      2. build a cKDTree over the CENTROIDS of a's candidate faces.
      3. for each b candidate face fb, query_ball_point(centroid_fb, R) with
         R = (max a-face reach) + tol, returning every a-face that could
         possibly overlap fb on a shared plane.
      4. for each returned pair (fa, fb): test coplanarity CONTINUOUSLY:
           * un-oriented parallel:  |n_a . n_b| >= ANG_TOL,
           * plane coincidence:     max over fb's 3 vertices of
                                    |n_a . (v - c_a)| <= tol
             (all of fb lies in fa's plane within tol).
         If coplanar, project both triangles into fa's 2D plane basis and add
         the Sutherland-Hodgman intersection area to `shared`.

    Returns (shared_area_m2, contact_area_a, contact_area_b):
      * shared_area_m2  : summed triangle∩triangle area on shared planes.
      * contact_area_a  : total area of ALL a-faces coplanar with the contact
                          plane (resolution-independent containment denominator,
                          FIX 2 — NOT just faces with positive overlap).
      * contact_area_b  : analogous for b.
    """
    a_idx = np.asarray(cand_a, dtype=np.int64)
    b_idx = np.asarray(cand_b, dtype=np.int64)
    if len(a_idx) == 0 or len(b_idx) == 0:
        return 0.0, 0.0, 0.0

    tri_a = ea.triangles            # (Fa, 3, 3)
    tri_b = eb.triangles            # (Fb, 3, 3)
    na_all = ea.face_normals
    nb_all = eb.face_normals

    # centroids + reach of a's candidate faces
    ca = tri_a[a_idx].mean(axis=1)                       # (Na, 3)
    reach_a = np.max(
        np.linalg.norm(tri_a[a_idx] - ca[:, None, :], axis=2), axis=1)  # (Na,)
    # Query radius must cover BOTH faces' reach: a coarse (large) b-face has its
    # centroid far from the fine a-subtriangles that actually overlap it. Using
    # only reach_a under-counts shared_area when the two meshes differ in
    # tessellation resolution (terrain-vs-wall) and made the result depend on the
    # arbitrary a/b iteration order. Add b's max face reach too.
    cb_all = tri_b[b_idx].mean(axis=1)
    reach_b = np.max(
        np.linalg.norm(tri_b[b_idx] - cb_all[:, None, :], axis=2), axis=1)  # (Nb,)
    R = float(reach_a.max()) + float(reach_b.max()) + tol
    catree = cKDTree(ca)

    shared = 0.0
    # The proximity-paired faces ESTABLISH the contact plane(s). A pair (fa, fb)
    # is "in contact" when their normals are parallel AND fb lies in fa's plane.
    # Each contributing fa supplies a reference contact plane (normal n_a, a
    # point c_a on it); these are deduped below into `contact_planes`.
    contact_planes: list = []        # list of (normal(3,), point(3,))

    for bi in b_idx:
        nb = nb_all[bi]
        if not np.any(nb):
            continue
        tb = tri_b[bi]                                   # (3, 3)
        cb = tb.mean(axis=0)
        # a-candidate faces whose centroid is within reach of fb's centroid
        near = catree.query_ball_point(cb, R)
        if not near:
            continue
        for local in near:
            ai = int(a_idx[local])
            na = na_all[ai]
            if not np.any(na):
                continue
            # un-oriented parallel test
            if abs(float(np.dot(na, nb))) < ANG_TOL:
                continue
            ta = tri_a[ai]                               # (3, 3)
            c_a = ta[0]
            # plane coincidence: all of fb's vertices lie in fa's plane (tol)
            d = np.abs((tb - c_a) @ na)                  # (3,)
            if float(d.max()) > tol:
                continue
            # coplanar contact -> register fa's plane as a contact plane
            _register_plane(contact_planes, na, c_a, tol)
            # exact overlap area in fa's 2D plane basis
            u, v = _plane_basis(na)
            ta2d = _proj_tri(ta, u, v)
            tb2d = _proj_tri(tb, u, v)
            amn = ta2d.min(axis=0)
            amx = ta2d.max(axis=0)
            bmn = tb2d.min(axis=0)
            bmx = tb2d.max(axis=0)
            if (amx[0] < bmn[0] or bmx[0] < amn[0]
                    or amx[1] < bmn[1] or bmx[1] < amn[1]):
                continue
            ov = _tri_tri_overlap_area_2d(ta2d, tb2d)
            if ov > 0:
                shared += ov

    # FIX 2 — resolution-independent containment denominators:
    # the contact-plane area of each element is the summed area of ALL its faces
    # that are coplanar with ANY established contact plane (same continuous
    # parallel + coincidence test), INDEPENDENT of bbox proximity. This iterates
    # over the element's FULL face set (NOT the bbox-pruned candidate subset): a
    # bbox prefilter would clip away the footing-top sub-triangles that fall
    # outside the wall footprint, which is exactly what made containment_b
    # mesh-resolution-dependent (coarse footing 0.296 vs subdivided 0.40). The
    # parallel/coincidence test is fully vectorised so the full sweep stays cheap.
    area_a = _coplanar_face_area(ea, contact_planes, tol)
    area_b = _coplanar_face_area(eb, contact_planes, tol)
    return float(shared), area_a, area_b


def _register_plane(planes, normal, point, tol):
    """Add (normal, point) to `planes` unless an equivalent plane is present.

    Two planes are equivalent when their un-oriented normals are parallel
    (|n0.n1| >= ANG_TOL) and `point` lies within `tol` of the stored plane."""
    n = np.asarray(normal, dtype=float)
    p = np.asarray(point, dtype=float)
    for n0, p0 in planes:
        if abs(float(np.dot(n0, n))) >= ANG_TOL and abs(float(np.dot(n0, p - p0))) <= tol:
            return
    planes.append((n, p))


def _coplanar_face_area(elem, planes, tol):
    """Summed area of ALL of `elem`'s faces coplanar with ANY contact plane.

    A face is coplanar with a contact plane (n0, p0) iff its normal is parallel
    (|n0.n_face| >= ANG_TOL) AND its centroid lies in that plane (|n0.(c-p0)|
    <= tol). Each face is counted at most once. Sweeps the element's FULL face
    set (not a bbox-pruned subset) so the result is mesh-resolution-independent.
    Vectorised over faces; loops only over the (typically 1) contact plane(s).
    Returns 0.0 if there are no established contact planes."""
    normals = elem.face_normals                 # (F, 3)
    areas = elem.area_faces                      # (F,)
    if not planes or len(normals) == 0:
        return 0.0
    centroids = elem.triangles.mean(axis=1)      # (F, 3)
    selected = np.zeros(len(normals), dtype=bool)
    for n0, p0 in planes:
        n0 = np.asarray(n0, dtype=float)
        parallel = np.abs(normals @ n0) >= ANG_TOL
        coincident = np.abs((centroids - p0) @ n0) <= tol
        selected |= (parallel & coincident)
    return float(areas[selected].sum())


def _proj_tri(tri3d, u, v):
    """Project a 3D triangle (3,3) into the 2D plane basis (u, v) -> (3, 2)."""
    t = np.asarray(tri3d, dtype=float)
    return np.column_stack([t @ u, t @ v])


# --------------------------------------------------------------------------- #
#  Shared EDGE (collinear overlapping segments)
# --------------------------------------------------------------------------- #
def _unique_edges_near(elem, lo, hi, tol):
    """Unique undirected edges of `elem` whose midpoint lies within [lo,hi]+tol.

    Returns an (E, 2, 3) array of edge endpoint pairs."""
    F = elem.faces
    if len(F) == 0:
        return np.empty((0, 2, 3))
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], axis=0)
    e = np.sort(e, axis=1)
    e = np.unique(e, axis=0)
    p0 = elem.vertices[e[:, 0]]
    p1 = elem.vertices[e[:, 1]]
    mid = 0.5 * (p0 + p1)
    keep = np.all(mid + tol >= lo, axis=1) & np.all(mid - tol <= hi, axis=1)
    seg = np.stack([p0[keep], p1[keep]], axis=1)        # (E, 2, 3)
    return seg


def _shared_edge_length(ea, eb, tol):
    """Approximate, OVER-COUNTED magnitude of shared 1D edge contact.

    NOTE (FIX 3 — interpretation): this is NOT the true length of the physical
    contact line. Every collinear/coincident/1D-overlapping edge PAIR is summed
    independently (an edge shared by two triangles on each side contributes
    multiple times, and overlapping sub-segments are not merged). The value is
    therefore an over-counted magnitude that serves ONLY as the rung discriminator
    in the face > edge > point hierarchy (it must merely exceed `tol` to mean
    "there is a line contact" once a face contact has been ruled out). Do not
    report it as a calibrated contact-line length.

    Two edges contribute when: their directions are parallel (|cross| < tol),
    they lie on the same line (perpendicular distance < tol), and their 1D
    projections overlap. Overlap lengths are summed (no double-count guard
    needed for the coarse adjacency signal)."""
    lo = np.maximum(ea.bmin, eb.bmin) - tol
    hi = np.minimum(ea.bmax, eb.bmax) + tol
    seg_a = _unique_edges_near(ea, lo, hi, tol)
    seg_b = _unique_edges_near(eb, lo, hi, tol)
    if len(seg_a) == 0 or len(seg_b) == 0:
        return 0.0
    total = 0.0
    for a0, a1 in seg_a:
        da = a1 - a0
        la = np.linalg.norm(da)
        if la < 1e-9:
            continue
        ua = da / la
        for b0, b1 in seg_b:
            db = b1 - b0
            lb = np.linalg.norm(db)
            if lb < 1e-9:
                continue
            ub = db / lb
            if np.linalg.norm(np.cross(ua, ub)) > tol:
                continue                                   # not parallel
            # same line? perpendicular distance from b0 to line a
            w = b0 - a0
            perp = w - np.dot(w, ua) * ua
            if np.linalg.norm(perp) > tol:
                continue
            # 1D overlap along ua
            ta0 = 0.0
            ta1 = la
            tb0 = np.dot(b0 - a0, ua)
            tb1 = np.dot(b1 - a0, ua)
            lo1 = max(min(ta0, ta1), min(tb0, tb1))
            hi1 = min(max(ta0, ta1), max(tb0, tb1))
            if hi1 - lo1 > tol:
                total += (hi1 - lo1)
    return float(total)


# --------------------------------------------------------------------------- #
#  Shared POINTS
# --------------------------------------------------------------------------- #
def _shared_point_count(ea, eb, tol):
    """Number of b-vertices that lie within `tol` of any a-vertex."""
    if ea.vtree is None or len(eb.vertices) == 0:
        return 0
    hits = ea.vtree.query_ball_point(eb.vertices, tol)
    return int(sum(1 for h in hits if h))


# --------------------------------------------------------------------------- #
#  Per-pair classification
# --------------------------------------------------------------------------- #
def _pair_edge(ea, eb, k_tol):
    """Classify one pair; return an edge dict or None (not adjacent / skip)."""
    try:
        mel_i = ea.mel
        mel_j = eb.mel
        if mel_i is None and mel_j is None:
            base = 0.01
        elif mel_i is None:
            base = mel_j
        elif mel_j is None:
            base = mel_i
        else:
            base = min(mel_i, mel_j)
        tol = float(np.clip(k_tol * base, 1e-5, 0.1))

        # 2. BBOX prefilter (inflated by tol)
        if not _boxes_overlap(ea.bmin, ea.bmax, eb.bmin, eb.bmax, tol):
            return None

        # 3. shared points
        spc = _shared_point_count(ea, eb, tol)

        # 4. shared face (coplanar overlap) — candidate faces only
        lo = np.maximum(ea.bmin, eb.bmin)
        hi = np.minimum(ea.bmax, eb.bmax)
        cand_a = np.where(_tri_bbox_mask(ea.triangles, lo, hi, tol))[0]
        cand_b = np.where(_tri_bbox_mask(eb.triangles, lo, hi, tol))[0]
        shared_area = 0.0
        contact_a = contact_b = 0.0
        if len(cand_a) and len(cand_b):
            shared_area, contact_a, contact_b = _shared_face(
                ea, eb, cand_a, cand_b, tol)

        # 5. shared edge (only meaningful when there is ~no shared face)
        shared_edge = 0.0
        if shared_area <= tol * tol:
            shared_edge = _shared_edge_length(ea, eb, tol)

        # 6. hierarchical classification
        if shared_area > tol * tol:
            level = "face"
        elif shared_edge > tol:
            level = "edge"
        elif spc > 0:
            level = "point"
        else:
            return None                                    # not adjacent

        # 7. containment (face only) — how much of each element's contact plane
        #    is covered by the shared area. For a wall on a footing, containment
        #    of the wall (smaller contact plane) -> ~1.0 = fully borne.
        #    FIX 2: the denominator (contact_a / contact_b) is the area of ALL of
        #    that element's faces COPLANAR with the contact plane (within tol),
        #    not just the faces with positive overlap — so containment is
        #    mesh-resolution-independent (subdividing the footing no longer
        #    changes containment_b).
        cont_a = cont_b = None
        if level == "face":
            eps = 1e-9
            cont_a = float(shared_area / max(contact_a, eps)) if contact_a > eps else None
            cont_b = float(shared_area / max(contact_b, eps)) if contact_b > eps else None
            # numerical guard: clip to [0, 1] (tessellation/clip rounding)
            if cont_a is not None:
                cont_a = float(min(max(cont_a, 0.0), 1.0))
            if cont_b is not None:
                cont_b = float(min(max(cont_b, 0.0), 1.0))

        return {
            "a_guid": ea.guid, "a_name": ea.name, "a_type": ea.ifc_type,
            "b_guid": eb.guid, "b_name": eb.name, "b_type": eb.ifc_type,
            "level": level,
            "shared_area_m2": float(shared_area) if level == "face" else 0.0,
            "shared_edge_length_m": float(shared_edge) if level == "edge" else 0.0,
            "shared_point_count": int(spc),
            "containment_a": cont_a,
            "containment_b": cont_b,
        }
    except Exception as e:
        sys.stderr.write(f"[adjacency] pair {ea.guid}<->{eb.guid} failed: "
                         f"{type(e).__name__}: {e}\n")
        return None


# --------------------------------------------------------------------------- #
#  Public entry point
# --------------------------------------------------------------------------- #
def scene_adjacency(products, *, k_tol=0.5):
    """Geometric neighbourhood graph over all scene products.

    `products`: list[LoadedProduct] (.guid, .name, .ifc_type, .mesh in WORLD
    coordinates, triangle mesh). No `offset` needed (frame-independent).

    Returns: list[dict] (edge dicts, schema in the module docstring). Pairs that
    do not touch (no shared face/edge/point) are omitted. NEVER raises: any
    per-element or per-pair failure is logged to stderr and that
    element/pair is skipped.
    """
    out: list = []
    if not products or len(products) < 2:
        return out
    elems = []
    for p in products:
        e = _build_elem(p)
        if e is not None:
            elems.append(e)
    n = len(elems)
    if n < 2:
        return out
    # centroid cKDTree prune (mirror distances.py performance pattern): only
    # consider pairs whose element centroids are within a generous radius. The
    # radius is the sum of the two bbox half-diagonals + a margin, so any pair
    # that could possibly share geometry survives (a coarse, safe upper bound).
    centroids = np.array([0.5 * (e.bmin + e.bmax) for e in elems])
    half_diag = np.array([0.5 * float(np.linalg.norm(e.bmax - e.bmin))
                          for e in elems])
    ctree = cKDTree(centroids)
    max_hd = float(half_diag.max()) if n else 0.0
    bmin = np.array([e.bmin for e in elems], dtype=float)
    bmax = np.array([e.bmax for e in elems], dtype=float)
    for i in range(n):
        # neighbours whose centroid is within (this half-diag + global max
        # half-diag + small margin): guarantees no real contact pair is missed.
        radius = float(half_diag[i] + max_hd + 0.1)
        nbrs = ctree.query_ball_point(centroids[i], radius)
        for j in nbrs:
            if j <= i:
                continue
            # PERF: the centroid radius uses the GLOBAL max half-diagonal, so a
            # single large product (terrain/long wall) makes nearly every pair a
            # candidate → O(n²) expensive _pair_edge calls (the load-time
            # hang on dense models). Cheap AABB-gap prefilter: two products can
            # only share geometry if their bounding boxes are within k_tol on
            # every axis. This is O(1) and prunes the candidate set to truly
            # adjacent pairs before the costly shared-face/edge/point test.
            gap = float(np.max(np.maximum(bmin[i] - bmax[j], bmin[j] - bmax[i])))
            if gap > k_tol:
                continue
            edge = _pair_edge(elems[i], elems[j], k_tol)
            if edge is not None:
                out.append(edge)
    return out


__all__ = ["scene_adjacency"]
