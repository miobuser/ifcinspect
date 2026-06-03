"""
webifc_mesh.py — Brücke von web-ifc-Geometrie in die IfcInspect-Pipeline.

web-ifc (C++/WASM, läuft im JS-Worker) tesselliert JEDE IFC-Geometrie —
tesselliert, IfcFacetedBrep, CSG/Extrusion — ohne OpenCASCADE und ~10-50x
schneller als der ifcopenshell-Iterator im Pyodide-Browser. Es liefert aber
UNVERSCHWEISSTE Meshes (jedes Dreieck eigene Ecken). OpenCASCADE dagegen
verschweisst Vertices nach interner B-Rep-Topologie (~0.05–0.1 mm), und die
K6-Nischenerkennung hängt über `auto_sharp_angle` empfindlich von den dadurch
entstehenden Dieder-Winkeln ab.

`weld_mesh` reproduziert diese Verschweissung mit einem cKDTree-Cluster (feste
Toleranz), sodass die Winkelverteilung wieder sauber zweigipflig wird und
`auto_sharp_angle` von selbst richtig greift (keine feste Schwelle nötig). In
Tests stimmt K6 damit exakt mit OpenCASCADE überein; bei den Stirn-/Krone-/
Fundament-Klassen verbleibt eine kleine Differenz (PCA-Achsen-Ambiguität +
Tessellierungs-Varianz), die separat adressiert wird.
"""
from __future__ import annotations

import numpy as np


# Default-Welding-Toleranz (m). OpenCASCADE verschweisst fast-koinzidente
# Tessellierungs-Vertices bei ~0.05–0.1 mm; 1e-5 (0.01 mm) war ~10× ZU ENG und
# liess auf realen Modellen (z.B. georeferenzierte IFC4X3-Schalungsmodelle)
# viele Wände UNVERSCHWEISST → nicht-wasserdicht → übersprungen, Nischen falsch.
# 1e-4 (0.1 mm) reproduziert OCCs Verschweissung; feiner als jedes echte
# Bauteil-Detail, also kein Über-Verschweissen.
WELD_TOL = 1e-4


def weld_mesh(verts, faces, tol: float = WELD_TOL):
    """Verschweisse Vertices näher als `tol` zu einem (cKDTree-Cluster via
    Union-Find), entferne entartete + doppelte Faces. Gibt eine trimesh.Trimesh
    zurück. Robust gegen leere Eingaben."""
    import trimesh
    V = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    F = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(V) == 0 or len(F) == 0:
        return trimesh.Trimesh(vertices=V, faces=F, process=False)

    from scipy.spatial import cKDTree
    tree = cKDTree(V)
    pairs = tree.query_pairs(tol)
    parent = list(range(len(V)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        parent[find(a)] = find(b)

    rep = {}
    newidx = np.zeros(len(V), dtype=np.int64)
    Vn = []
    for i in range(len(V)):
        r = find(i)
        if r not in rep:
            rep[r] = len(Vn)
            Vn.append(V[r])
        newidx[i] = rep[r]
    Vn = np.asarray(Vn, dtype=np.float64)
    Fn = newidx[F]

    # entartete (wiederholter Index) Faces droppen
    if len(Fn):
        good = np.array([len(set(map(int, f))) == 3 for f in Fn])
        Fn = Fn[good]
    # doppelte Faces (gleiches Index-Set) droppen
    if len(Fn):
        seen = set()
        keep = []
        for i, f in enumerate(Fn):
            key = tuple(sorted(map(int, f)))
            if key not in seen:
                seen.add(key)
                keep.append(i)
        Fn = Fn[keep]
    return trimesh.Trimesh(vertices=Vn, faces=Fn, process=False)


def loaded_products_from_webifc(items, skip_types, tol: float = WELD_TOL):
    """Baue die LoadedProduct-Liste aus web-ifc-Items.

    `items`: iterable von dicts/objects mit Keys:
        guid (str), name (str), ifc_type (str),
        vertices (flat float list/array, xyz), faces (flat int list/array).
    `skip_types`: set wie ifc_io._SKIP_TYPES (Spatial-Container überspringen).

    Gibt list[LoadedProduct] — Reihenfolge wie geliefert. Leere/skip-Meshes
    werden ausgelassen.
    """
    from ifc_io import LoadedProduct
    out = []
    for it in items:
        if isinstance(it, dict):
            guid = it.get("guid", "")
            name = it.get("name", "") or ""
            itype = it.get("ifc_type", "") or "IfcProduct"
            verts = it.get("vertices", [])
            faces = it.get("faces", [])
        else:
            guid = getattr(it, "guid", "")
            name = getattr(it, "name", "") or ""
            itype = getattr(it, "ifc_type", "") or "IfcProduct"
            verts = getattr(it, "vertices", [])
            faces = getattr(it, "faces", [])
        if itype in skip_types:
            continue
        mesh = weld_mesh(verts, faces, tol)
        if len(mesh.faces) == 0:
            continue
        out.append(LoadedProduct(guid, name, itype, mesh))
    return out
