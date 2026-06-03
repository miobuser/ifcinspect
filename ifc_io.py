"""
ifc_io.py — minimal, dependency-light IFC4 mesh I/O.

Two jobs only:
  * load_product_meshes(path) -> read every IfcProduct that owns geometry and
    return its triangulated world-space mesh as a trimesh.Trimesh.
  * write_ifc_meshes(path, items) -> write a set of triangulated meshes as IFC
    elements (per-item ifc_class, default IfcBuildingElementProxy), grouped into
    one IfcElementAssembly per source wall, each with a per-object RGBA surface
    style and IFC-native classification.

The writer builds the STEP model entity-by-entity (no ifcopenshell.api) so the
output is independent of api-signature drift across ifcopenshell releases.
Geometry is emitted as IfcTriangulatedFaceSet (the compact IFC4 tessellation),
which every modern viewer (Solibri, BIMvision, usBIM, web-ifc) renders directly.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.guid


# --------------------------------------------------------------------------- #
#  Reading
# --------------------------------------------------------------------------- #
@dataclass
class LoadedProduct:
    guid: str
    name: str
    ifc_type: str
    mesh: "object"            # trimesh.Trimesh (typed loosely to avoid hard import here)


def _make_geom_settings():
    """ifcopenshell 0.8 geometry settings — world coordinates + welded vertices.

    World coords fold each product's IfcLocalPlacement into the vertices, so the
    returned mesh already lives in the shared model frame.  Welding removes the
    per-triangle vertex duplication of the raw tessellator, which is what makes a
    later convex hull / boolean robust.
    """
    s = ifcopenshell.geom.settings()
    for key, val in (("use-world-coords", True), ("weld-vertices", True)):
        try:
            s.set(key, val)
        except Exception:
            # Fall back to the legacy enum attribute names (ifcopenshell 0.7).
            attr = key.upper().replace("-", "_")
            if hasattr(s, attr):
                s.set(getattr(s, attr), val)
    return s


def _shape_to_trimesh(verts_flat, faces_flat):
    import trimesh
    verts = np.asarray(verts_flat, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(faces_flat, dtype=np.int64).reshape(-1, 3)
    # process=True merges coincident vertices and drops degenerate triangles.
    return trimesh.Trimesh(vertices=verts, faces=faces, process=True)


# Spatial containers carry no solid geometry we care about — skip them.
_SKIP_TYPES = {
    "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace",
    "IfcSpatialZone", "IfcOpeningElement", "IfcGrid",
}


def load_product_meshes(path: str) -> list[LoadedProduct]:
    """Return one LoadedProduct per IfcProduct that yields a non-empty mesh.

    Uses the multi-threaded C++ geometry iterator (fast path); on any failure it
    falls back to a per-product create_shape loop so a single odd entity cannot
    abort the whole load.

    NOTE (2026-06-01): a direct tessellation reader (fastgeom) was tried as a
    speed optimisation but REVERTED — its quad fan-triangulation chose different
    diagonals than OpenCASCADE on some models, which shifted the dihedral angles
    that drive the K6 niche detection (e.g. a tessellated arc model lost 18
    K6 faces to K0–K5). The OCC iterator is the single source of truth for the
    classification mesh; geometry-load speed must never trade away face-class
    accuracy.
    """
    model = ifcopenshell.open(path)
    settings = _make_geom_settings()
    out: list[LoadedProduct] = []

    def _emit(guid):
        try:
            prod = model.by_guid(guid)
        except Exception:
            prod = None
        name = (getattr(prod, "Name", None) or "") if prod else ""
        itype = prod.is_a() if prod else "IfcProduct"
        return name, itype

    used_iterator = False
    try:
        import multiprocessing
        n = max(1, multiprocessing.cpu_count())
        it = ifcopenshell.geom.iterator(settings, model, n)
        if it.initialize():
            used_iterator = True
            while True:
                shape = it.get()
                geo = shape.geometry
                if geo and len(geo.verts) and len(geo.faces):
                    name, itype = _emit(shape.guid)
                    if itype not in _SKIP_TYPES:
                        out.append(LoadedProduct(
                            shape.guid, name, itype,
                            _shape_to_trimesh(geo.verts, geo.faces)))
                if not it.next():
                    break
    except Exception:
        used_iterator = False

    if not used_iterator:
        for prod in model.by_type("IfcProduct"):
            if prod.is_a() in _SKIP_TYPES or not getattr(prod, "Representation", None):
                continue
            try:
                shape = ifcopenshell.geom.create_shape(settings, prod)
            except Exception:
                continue
            geo = shape.geometry
            if not (len(geo.verts) and len(geo.faces)):
                continue
            out.append(LoadedProduct(
                prod.GlobalId, getattr(prod, "Name", "") or "", prod.is_a(),
                _shape_to_trimesh(geo.verts, geo.faces)))
    return out


# --------------------------------------------------------------------------- #
#  Writing
# --------------------------------------------------------------------------- #
@dataclass
class IfcMeshItem:
    name: str
    vertices: np.ndarray            # (N, 3) float
    faces: np.ndarray               # (M, 3) int, 0-based
    color: tuple = (1.0, 1.0, 0.0)  # RGB in 0..1  (default: yellow)
    transparency: float = 0.0       # 0 = opaque, 1 = fully transparent
    ifc_class: str = "IfcBuildingElementProxy"
    # ---- optional semantic enrichment (see write_ifc_meshes) ----
    kind: "str | None" = None            # "K0".."K6" — class identification
    class_label: "str | None" = None     # German class label (Stirn +, Krone, …)
    assembly_key: "str | None" = None    # source-wall GUID → groups parts into
                                         # one IfcElementAssembly
    assembly_name: "str | None" = None   # name of the wall assembly
    psets: "dict | None" = None          # {pset_name: {prop_name: value}} attached
                                         # to this item's assembly (set on one
                                         # representative item per assembly)


# Classification metadata: Identification → German label. Used to build the
# IfcClassificationReference set. K6 = the only physical "Schaleinlage"; K0–K5
# are wall FACE classes (Flächenklassen).
_CLASS_LABELS = {
    "K0": "Stirn +",
    "K1": "Stirn −",
    "K2": "Krone",
    "K3": "Fundament",
    "K4": "Front (Luft)",
    "K5": "Back (Erd)",
    "K6": "Schaleinlagen",
}


def _guid():
    return ifcopenshell.guid.new()


def _valid_ifc_guid(s) -> bool:
    """True if `s` is a well-formed 22-char IfcGloballyUniqueId (base64 form).

    The original IFC GlobalId carried through from the source model is already
    in this compressed form, so it round-trips through expand/compress.  We
    reuse it as the assembly GlobalId for traceability; anything else gets a
    fresh GUID.
    """
    if not isinstance(s, str) or len(s) != 22:
        return False
    try:
        return ifcopenshell.guid.compress(ifcopenshell.guid.expand(s)) == s
    except Exception:
        return False


def _ifc_prop(f, name, value):
    """One IfcPropertySingleValue, type chosen from the Python value.

    bool → IfcBoolean, int → IfcInteger, float → IfcReal, everything else →
    IfcText.  None is filtered out by the caller (skip rather than emit empty).
    """
    if isinstance(value, bool):
        nv = f.create_entity("IfcBoolean", bool(value))
    elif isinstance(value, int):
        nv = f.create_entity("IfcInteger", int(value))
    elif isinstance(value, float):
        nv = f.create_entity("IfcReal", float(value))
    else:
        nv = f.create_entity("IfcText", str(value))
    return f.create_entity("IfcPropertySingleValue", Name=str(name), NominalValue=nv)


def write_ifc_meshes(path: str, items: list[IfcMeshItem],
                     project_name: str = "Niche Detection") -> None:
    """Write `items` to an IFC4 STEP file with a valid spatial hierarchy
    (Project -> Site -> Building -> Storey) and a colored Body representation
    per item.

    Semantic enrichment (active when items carry `assembly_key` / `kind`):
      * parts of the same `assembly_key` are aggregated under one
        IfcElementAssembly (IfcRelAggregates); the assembly is the element
        contained in the storey, the parts hang under it (a part is NEVER both
        contained AND aggregated);
      * a single IfcClassification + one IfcClassificationReference per used
        K-class link each part to its class via IfcRelAssociatesClassification;
      * `psets` on a representative item become IfcPropertySet(s) attached to
        that item's assembly via IfcRelDefinesByProperties.
    Items without `assembly_key` keep the legacy flat behaviour (contained in
    the storey directly), so existing callers are unaffected."""
    f = ifcopenshell.file(schema="IFC4")

    # -- owner history (optional in IFC4, added so strict viewers stay happy) --
    person = f.create_entity("IfcPerson", FamilyName="IfcInspect")
    org = f.create_entity("IfcOrganization", Name="IfcInspect")
    p_o = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app = f.create_entity("IfcApplication", ApplicationDeveloper=org, Version="1.0",
                          ApplicationFullName="IfcInspect", ApplicationIdentifier="IfcInspect")
    owner = f.create_entity("IfcOwnerHistory", OwningUser=p_o, OwningApplication=app,
                            ChangeAction="ADDED", CreationDate=int(time.time()))

    # -- geometric context (world frame) --
    def pt(xyz):
        return f.create_entity("IfcCartesianPoint", Coordinates=tuple(float(c) for c in xyz))

    def a2p3d(origin=(0., 0., 0.)):
        return f.create_entity("IfcAxis2Placement3D", Location=pt(origin))

    ctx = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model", CoordinateSpaceDimension=3,
        Precision=1e-5, WorldCoordinateSystem=a2p3d())
    body_ctx = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body", ContextType="Model",
        ParentContext=ctx, TargetView="MODEL_VIEW")

    # -- units (metre) --
    units = f.create_entity("IfcUnitAssignment", Units=[
        f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
        f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
        f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
        f.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN"),
    ])

    project = f.create_entity("IfcProject", GlobalId=_guid(), OwnerHistory=owner,
                              Name=project_name, RepresentationContexts=[ctx],
                              UnitsInContext=units)

    # -- spatial hierarchy --
    def placement(rel_to=None):
        return f.create_entity("IfcLocalPlacement", PlacementRelTo=rel_to,
                               RelativePlacement=a2p3d())

    site = f.create_entity("IfcSite", GlobalId=_guid(), OwnerHistory=owner,
                           Name="Site", ObjectPlacement=placement(),
                           CompositionType="ELEMENT")
    building = f.create_entity("IfcBuilding", GlobalId=_guid(), OwnerHistory=owner,
                               Name="Building", ObjectPlacement=placement(site.ObjectPlacement),
                               CompositionType="ELEMENT")
    storey = f.create_entity("IfcBuildingStorey", GlobalId=_guid(), OwnerHistory=owner,
                             Name="Storey", ObjectPlacement=placement(building.ObjectPlacement),
                             CompositionType="ELEMENT")
    f.create_entity("IfcRelAggregates", GlobalId=_guid(), OwnerHistory=owner,
                    RelatingObject=project, RelatedObjects=[site])
    f.create_entity("IfcRelAggregates", GlobalId=_guid(), OwnerHistory=owner,
                    RelatingObject=site, RelatedObjects=[building])
    f.create_entity("IfcRelAggregates", GlobalId=_guid(), OwnerHistory=owner,
                    RelatingObject=building, RelatedObjects=[storey])

    def _write_psets(host, psets):
        """Attach {pset_name: {prop: val}} as IfcPropertySet(s) to `host`
        (an assembly OR a standalone element) via IfcRelDefinesByProperties."""
        for pset_name, props in (psets or {}).items():
            single_vals = [_ifc_prop(f, n, v) for n, v in props.items()
                           if v is not None]
            if not single_vals:
                continue
            pset = f.create_entity("IfcPropertySet", GlobalId=_guid(),
                                   OwnerHistory=owner, Name=pset_name,
                                   HasProperties=single_vals)
            f.create_entity("IfcRelDefinesByProperties", GlobalId=_guid(),
                            OwnerHistory=owner, RelatedObjects=[host],
                            RelatingPropertyDefinition=pset)

    # -- one element per mesh item --
    products = []                       # parallel to `items`
    parts_by_class: dict = {}           # kind -> [element, ...]
    parts_by_assembly: dict = {}        # assembly_key -> [element, ...]
    assembly_order: list = []           # preserve first-seen assembly order
    assembly_name: dict = {}            # assembly_key -> name
    assembly_psets: dict = {}           # assembly_key -> psets dict
    for it in items:
        verts = np.asarray(it.vertices, dtype=np.float64).reshape(-1, 3)
        faces = np.asarray(it.faces, dtype=np.int64).reshape(-1, 3)

        coord_list = f.create_entity(
            "IfcCartesianPointList3D",
            CoordList=[tuple(map(float, v)) for v in verts])
        # IfcTriangulatedFaceSet indices are 1-based into the point list.
        tfs = f.create_entity(
            "IfcTriangulatedFaceSet", Coordinates=coord_list, Closed=True,
            CoordIndex=[tuple(int(i) + 1 for i in tri) for tri in faces])

        # surface style: solid RGB + transparency
        rgb = f.create_entity("IfcColourRgb", Red=float(it.color[0]),
                              Green=float(it.color[1]), Blue=float(it.color[2]))
        shading = f.create_entity("IfcSurfaceStyleShading", SurfaceColour=rgb,
                                  Transparency=float(it.transparency))
        surf_style = f.create_entity("IfcSurfaceStyle", Side="BOTH", Styles=[shading])
        f.create_entity("IfcStyledItem", Item=tfs, Styles=[surf_style])

        shape_rep = f.create_entity(
            "IfcShapeRepresentation", ContextOfItems=body_ctx,
            RepresentationIdentifier="Body", RepresentationType="Tessellation",
            Items=[tfs])
        prod_def = f.create_entity("IfcProductDefinitionShape", Representations=[shape_rep])

        elem = f.create_entity(
            it.ifc_class, GlobalId=_guid(), OwnerHistory=owner, Name=it.name,
            ObjectPlacement=placement(storey.ObjectPlacement), Representation=prod_def)
        products.append(elem)

        if it.kind:
            parts_by_class.setdefault(it.kind, []).append(elem)
        if it.assembly_key:
            if it.assembly_key not in parts_by_assembly:
                parts_by_assembly[it.assembly_key] = []
                assembly_order.append(it.assembly_key)
                assembly_name[it.assembly_key] = it.assembly_name or "Wall"
            parts_by_assembly[it.assembly_key].append(elem)
            if it.psets:
                # merge (first representative item per assembly carries them)
                assembly_psets.setdefault(it.assembly_key, {}).update(it.psets)
        elif it.psets:
            # Standalone element (no assembly): attach its psets directly. Used
            # by the "Pset only" per-wall-solid export (each solid carries its
            # Kenngrössen [+ Prüfung] without being wrapped in an assembly).
            _write_psets(elem, it.psets)

    # -- C: assemblies per wall (parts aggregated under an IfcElementAssembly) --
    assemblies = []                     # the storey-contained elements
    aggregated = set()                  # ids() of parts hanging under an assembly
    for key in assembly_order:
        parts = parts_by_assembly[key]
        gid = key if _valid_ifc_guid(key) else _guid()
        asm = f.create_entity(
            "IfcElementAssembly", GlobalId=gid, OwnerHistory=owner,
            Name=assembly_name.get(key, "Wall"),
            ObjectPlacement=placement(storey.ObjectPlacement),
            PredefinedType="USERDEFINED")
        f.create_entity("IfcRelAggregates", GlobalId=_guid(), OwnerHistory=owner,
                        RelatingObject=asm, RelatedObjects=parts)
        assemblies.append(asm)
        for p in parts:
            aggregated.add(id(p))

        # -- D: property sets on the assembly --
        _write_psets(asm, assembly_psets.get(key))

    # -- spatial containment: assemblies + any non-aggregated (legacy) parts.
    #    A part is EITHER contained OR aggregated, never both. --
    contained = list(assemblies) + [p for p in products if id(p) not in aggregated]
    if contained:
        f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=_guid(),
                        OwnerHistory=owner, RelatingStructure=storey,
                        RelatedElements=contained)

    # -- B: IFC-native classification (one source + one ref per used K-class) --
    if parts_by_class:
        classification = f.create_entity(
            "IfcClassification",
            Source="IfcInspect", Edition="1.0",
            Name="IfcInspect Flächenklassifikation (ASTRA)")
        for kind in sorted(parts_by_class.keys()):
            ref = f.create_entity(
                "IfcClassificationReference",
                Identification=kind,
                Name=_CLASS_LABELS.get(kind, kind),
                ReferencedSource=classification)
            f.create_entity(
                "IfcRelAssociatesClassification", GlobalId=_guid(),
                OwnerHistory=owner, Name=kind,
                RelatedObjects=parts_by_class[kind],
                RelatingClassification=ref)

    f.write(path)


def enrich_existing_ifc(out_path, ifc_bytes, items, element_psets=None,
                        include_submeshes=True, include_pset=True) -> None:
    """Round-trip export: keep the ORIGINAL imported IFC and only APPEND to it.

    In contrast to :func:`write_ifc_meshes` (which builds a brand-new file), this
    re-opens the *source* IFC bytes and preserves them EXACTLY — every original
    entity, its geometry, units and georeferencing — adding, per flag:

      * ``include_pset``: ``IfcPropertySet``(s) attached to the EXISTING source
        element identified by its ``GlobalId``.  ``element_psets`` maps
        ``{guid: {pset_name: {prop: value}}}``.
      * ``include_submeshes``: one ``IfcElementAssembly`` per source wall, NAMED
        after the element it belongs to, aggregating the classification faces
        (``items`` — one ``IfcBuildingElementProxy`` each, coloured by K-class
        and linked via ``IfcClassificationReference``).

    Geometry coordinates in ``items`` are world-space METRES (they already carry
    the scene offset).  They are converted into the source file's own length unit
    (via its unit scale) and written with an identity world placement, so the new
    faces line up exactly with the original geometry — also for mm-unit or
    georeferenced (LV95) source models.  The assembly is contained in an existing
    spatial element (storey → building → site).
    """
    if isinstance(ifc_bytes, (bytes, bytearray)):
        # IFC STEP is ISO-10303-21; latin-1 round-trips every byte losslessly.
        text = bytes(ifc_bytes).decode("latin-1")
    else:
        text = str(ifc_bytes)
    f = ifcopenshell.file.from_string(text)

    # metres-per-file-unit → write our metre coords in the file's stored unit.
    try:
        import ifcopenshell.util.unit as _u
        unit_scale = float(_u.calculate_unit_scale(f)) or 1.0
    except Exception:
        unit_scale = 1.0
    inv_scale = 1.0 / unit_scale if unit_scale else 1.0

    owner = (f.by_type("IfcOwnerHistory") or [None])[0]

    def pt(xyz):
        return f.create_entity("IfcCartesianPoint",
                               Coordinates=tuple(float(c) for c in xyz))

    def a2p3d(origin=(0., 0., 0.)):
        return f.create_entity("IfcAxis2Placement3D", Location=pt(origin))

    def world_placement():
        # Identity placement in the world frame: our coords are already absolute.
        return f.create_entity("IfcLocalPlacement", PlacementRelTo=None,
                               RelativePlacement=a2p3d())

    def _attach_psets(host, psets):
        for pset_name, props in (psets or {}).items():
            vals = [_ifc_prop(f, n, v) for n, v in props.items() if v is not None]
            if not vals:
                continue
            pset = f.create_entity("IfcPropertySet", GlobalId=_guid(),
                                   OwnerHistory=owner, Name=pset_name,
                                   HasProperties=vals)
            f.create_entity("IfcRelDefinesByProperties", GlobalId=_guid(),
                            OwnerHistory=owner, RelatedObjects=[host],
                            RelatingPropertyDefinition=pset)

    # ---- (1) Property sets onto the EXISTING source elements (by GlobalId) ---- #
    if include_pset and element_psets:
        for guid, psets in element_psets.items():
            if not guid or not psets:
                continue
            try:
                elem = f.by_guid(guid)
            except Exception:
                elem = None
            if elem is not None:
                _attach_psets(elem, psets)

    # ---- (2) Classification faces as IfcElementAssembly per source wall ------- #
    if include_submeshes and items:
        # Reuse the source model's geometric context; find/create a Body subctx.
        model_ctx = None
        for c in f.by_type("IfcGeometricRepresentationContext"):
            if c.is_a("IfcGeometricRepresentationSubContext"):
                continue
            if getattr(c, "ContextType", None) in ("Model", None):
                model_ctx = c
                break
        if model_ctx is None:
            model_ctx = f.create_entity(
                "IfcGeometricRepresentationContext", ContextType="Model",
                CoordinateSpaceDimension=3, Precision=1e-5,
                WorldCoordinateSystem=a2p3d())
        body_ctx = None
        for c in f.by_type("IfcGeometricRepresentationSubContext"):
            if getattr(c, "ContextIdentifier", None) == "Body":
                body_ctx = c
                break
        if body_ctx is None:
            body_ctx = f.create_entity(
                "IfcGeometricRepresentationSubContext", ContextIdentifier="Body",
                ContextType="Model", ParentContext=model_ctx,
                TargetView="MODEL_VIEW")

        # An existing spatial element to contain the new assemblies.
        spatial = (f.by_type("IfcBuildingStorey") or f.by_type("IfcBuilding")
                   or f.by_type("IfcSite") or f.by_type("IfcSpatialZone")
                   or [None])[0]

        # Group submeshes by their source-wall GUID; name the assembly after it.
        order, groups, names = [], {}, {}
        for it in items:
            key = it.assembly_key or "_all"
            if key not in groups:
                groups[key] = []
                order.append(key)
                names[key] = it.assembly_name or "Stützwand"
            groups[key].append(it)

        new_assemblies = []
        parts_by_class: dict = {}
        for key in order:
            parts = []
            for it in groups[key]:
                verts = np.asarray(it.vertices, dtype=np.float64).reshape(-1, 3) * inv_scale
                faces = np.asarray(it.faces, dtype=np.int64).reshape(-1, 3)
                coord_list = f.create_entity(
                    "IfcCartesianPointList3D",
                    CoordList=[tuple(map(float, v)) for v in verts])
                tfs = f.create_entity(
                    "IfcTriangulatedFaceSet", Coordinates=coord_list, Closed=False,
                    CoordIndex=[tuple(int(i) + 1 for i in tri) for tri in faces])
                rgb = f.create_entity("IfcColourRgb", Red=float(it.color[0]),
                                      Green=float(it.color[1]), Blue=float(it.color[2]))
                shading = f.create_entity("IfcSurfaceStyleShading", SurfaceColour=rgb,
                                          Transparency=float(it.transparency))
                surf_style = f.create_entity("IfcSurfaceStyle", Side="BOTH", Styles=[shading])
                f.create_entity("IfcStyledItem", Item=tfs, Styles=[surf_style])
                shape_rep = f.create_entity(
                    "IfcShapeRepresentation", ContextOfItems=body_ctx,
                    RepresentationIdentifier="Body", RepresentationType="Tessellation",
                    Items=[tfs])
                prod_def = f.create_entity("IfcProductDefinitionShape", Representations=[shape_rep])
                part = f.create_entity(
                    it.ifc_class, GlobalId=_guid(), OwnerHistory=owner, Name=it.name,
                    ObjectPlacement=world_placement(), Representation=prod_def)
                parts.append(part)
                if it.kind:
                    parts_by_class.setdefault(it.kind, []).append(part)

            asm = f.create_entity(
                "IfcElementAssembly", GlobalId=_guid(), OwnerHistory=owner,
                Name=f"{names[key]} – Klassifikationsflächen",
                ObjectPlacement=world_placement(), PredefinedType="USERDEFINED")
            f.create_entity("IfcRelAggregates", GlobalId=_guid(), OwnerHistory=owner,
                            RelatingObject=asm, RelatedObjects=parts)
            new_assemblies.append(asm)

        if spatial is not None and new_assemblies:
            f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=_guid(),
                            OwnerHistory=owner, RelatingStructure=spatial,
                            RelatedElements=new_assemblies)

        # IFC-native classification (one source + one ref per used K-class).
        if parts_by_class:
            classification = f.create_entity(
                "IfcClassification", Source="IfcInspect", Edition="1.0",
                Name="IfcInspect Flächenklassifikation (ASTRA)")
            for kind in sorted(parts_by_class):
                ref = f.create_entity(
                    "IfcClassificationReference", Identification=kind,
                    Name=_CLASS_LABELS.get(kind, kind), ReferencedSource=classification)
                f.create_entity(
                    "IfcRelAssociatesClassification", GlobalId=_guid(),
                    OwnerHistory=owner, Name=kind,
                    RelatedObjects=parts_by_class[kind], RelatingClassification=ref)

    f.write(out_path)
