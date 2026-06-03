"""
niche_brep.py — Per-Region Tiefenklassifikation für Schaleinlagen-Detektion.

Ansatz: surface_regions (crease-aware Segmentierung an scharfen Mesh-Kanten)
zerlegt das Mesh in glatte Patches.  Dann wird jede Region einem der 6
PCA-Cluster zugewiesen (Region-Normal → Richtung).  Pro Cluster ist die
GRÖSSTE Region die Schalfläche.  Nicht-Haupt-Regionen = Niche-Kandidaten;
nur flache Regionen ON der konvexen Hülle mit konvexer Boundary werden als
Schalfläche gerettet (Stirnflächen, Mauerfuss-Top).
"""
from __future__ import annotations
import numpy as np
import trimesh
import trimesh.proximity
from collections import deque


def auto_sharp_angle(ang):
    """Datengetriebene Trennschwelle Tessellierung vs. echte Kante.

    Die Dieder-Winkel sind bimodal: kleine Winkel = Facetten innerhalb
    glatter Flächen (Vernetzung), grosse Winkel = echte Design-Kanten.  Die
    Schwelle ist die MITTE der grössten leeren Lücke zwischen besetzten
    1°-Bins (das Tal der Verteilung).

    Liefert (schwelle_rad, lückenbreite_grad); die Lückenbreite ist das
    Vertrauensmass: breit = sauber getrennt, schmal = grobes Mesh."""
    a = np.degrees(np.asarray(ang))
    if len(a) < 2:
        return np.radians(30.0), 0.0
    h, e = np.histogram(a, bins=np.arange(0, 181, 1))
    occ = np.where(h > 0)[0]
    if len(occ) < 2:
        return np.radians(30.0), 0.0
    d = np.diff(occ)
    k = int(np.argmax(d))
    lo, hi = e[occ[k] + 1], e[occ[k + 1]]
    return np.radians((lo + hi) / 2.0), float(hi - lo)


def surface_regions(mesh, sharp_deg=None):
    """Zerlege das Mesh in glatte REGIONEN über die KANTEN.

    Gruppiere Dreiecke, die über GLATTE Kanten (Dieder < Schwelle) verbunden
    sind.  Nur SCHARFE Kanten (echte Modellkanten) trennen Regionen.

    sharp_deg=None → Schwelle datengetrieben aus dem Tal der
    Dieder-Verteilung (auto_sharp_angle).

    Returns:
        regions: list[dict] mit keys:
            - 'faces': np.ndarray[int] — Face-Indizes dieser Region
            - 'area': float — Gesamtfläche der Region
        reg: np.ndarray[int] — pro Face die Regions-ID
    """
    adj = mesh.face_adjacency
    ang = mesh.face_adjacency_angles
    if sharp_deg is None:
        thr, _gap = auto_sharp_angle(ang)
    else:
        thr = np.radians(sharp_deg)
    nbr = [[] for _ in range(len(mesh.faces))]
    for (a, b), an in zip(adj, ang):
        if an < thr:
            nbr[a].append(b); nbr[b].append(a)
    reg = -np.ones(len(mesh.faces), int)
    regions = []
    for s0 in range(len(mesh.faces)):
        if reg[s0] >= 0:
            continue
        rid = len(regions); comp = [s0]; reg[s0] = rid; dq = deque([s0])
        while dq:
            x = dq.popleft()
            for y in nbr[x]:
                if reg[y] < 0:
                    reg[y] = rid; comp.append(y); dq.append(y)
        comp = np.array(comp)
        regions.append({
            "faces": comp,
            "area": float(mesh.area_faces[comp].sum()),
        })
    return regions, reg


def _region_normal(mesh, comp):
    """Flächengewichtete Durchschnittsnormale einer Region."""
    N = mesh.face_normals[comp]
    A = mesh.area_faces[comp]
    n = (N * A[:, None]).sum(0)
    return n / (np.linalg.norm(n) + 1e-12)


def _concave_frac_region(mesh, faces_arr):
    """Anteil konkaver Boundary-Kanten einer Face-Gruppe.

    Gibt den winkelgewichteten Anteil konkaver (nicht-konvexer) Kanten an
    der Boundary der Gruppe zurück (0..1).  Hoher Wert = Tal/Nische-
    Mündung, niedriger = Plateau/Stirn."""
    nf = len(mesh.faces)
    in_comp = np.zeros(nf, dtype=bool)
    in_comp[faces_arr] = True
    fa_pairs = mesh.face_adjacency
    fa_conv = mesh.face_adjacency_convex
    fa_ang = mesh.face_adjacency_angles
    bnd = in_comp[fa_pairs[:, 0]] ^ in_comp[fa_pairs[:, 1]]
    if not bnd.any():
        return 0.0
    ang = fa_ang[bnd]
    conc = ~fa_conv[bnd]
    s = float(ang.sum())
    return float((ang * conc).sum() / s) if s > 1e-12 else 0.0


def _onhull_cf_cutoff(cf_values):
    """Daten-getriebene Schwelle für 'Rand konvex genug, um auf der konvexen
    Hülle zu liegen' (On-Hull-Rescue, Schritt 4 & 7).

    cf (winkelgewichteter konkaver Rand-Anteil) ist bei den Rescue-Kandidaten
    BIMODAL: echte Plateaus / Stirn / Fundament-OK liegen bei cf≈0 (Rand voll
    konvex = sie SIND Teil der konvexen Hülle), Nischenböden/-decken bei
    cf≈0.5 (halber Rand konkav = Nischen-Mündung). Statt eines festen
    0.5-Werts trennt diese Funktion die beiden Moden am DOMINANTEN Spalt der
    cf-Verteilung der Kandidaten.

    Geometrischer Anker = 0.25: eine hüll-koinzidente Fläche hat einen
    ÜBERWIEGEND konvexen Rand (>75 %). Empirisch (Thesis-Modell, alle Wände)
    ist die Trennung eindeutig: echte Plateaus / Stirn / Fundament-OK haben
    cf≈0, JEDE Nischenfläche cf≥0.48 — dazwischen liegt nichts. Wichtig: die
    Bimodalität existiert nur GLOBAL über alle Wände, nicht pro Wand (eine
    reine Nischen-Wand hat gar keine cf≈0-Mode, nur cf 0.48…0.75). Eine
    per-Wand-„widest-gap"-Trennung würde dort fälschlich zwischen Nischenboden
    (~0.5) und Nischenwand (~0.75) schneiden und die Böden retten.

    Deshalb: der Anker 0.25 ist die Schwelle; eine daten-getriebene Trennung
    darf nur dann eingreifen, wenn sie ENGER (unterhalb des Ankers) schneidet —
    d.h. wenn es einen dominanten Spalt im konvexen Bereich (<0.25) gibt, z.B.
    zwei Plateau-Moden nahe 0. So bleibt eine reine Nischen-Wand (kein Spalt
    <0.25) beim Anker → nichts gerettet → korrekt K6.
    """
    anchor = 0.25
    cf = np.sort(np.asarray(cf_values, dtype=float))
    if len(cf) >= 3:
        gaps = np.diff(cf)
        gi = int(np.argmax(gaps))
        spread = float(cf[-1] - cf[0])
        split = 0.5 * (float(cf[gi]) + float(cf[gi + 1]))
        # nur ein dominanter Spalt der UNTERHALB des Ankers liegt schneidet
        # daten-getrieben enger; alles andere bleibt beim geometrischen Anker.
        if (spread > 1e-9 and gaps[gi] >= 0.5 * spread
                and gaps[gi] >= 0.1 and split < anchor):
            return split
    return anchor


def _occluded_fraction(mesh, face_idxs, direction):
    """Anteil der Face-Schwerpunkte einer Gruppe, von denen ein Strahl in
    `direction` die Wand ERNEUT trifft (= etwas liegt in dieser Richtung
    davor/darüber).

    Mit direction=+Z ist das exakt die DRAUFSICHT-Verdeckung: trifft der
    Strahl nach oben wieder Wand, steht etwas über der Fläche (Nischenboden);
    trifft er nichts, ist die Fläche himmelsoffen (Krone / Fundament-OK).

    Implementierung: EIGENE vektorisierte Möller–Trumbore-Ray-Triangle-
    Schnittprüfung in REINEM numpy — KEIN trimesh.ray (dessen Backend im
    Pyodide-Browser nicht verfügbar/zuverlässig ist; genau daran scheiterte
    der erste Versuch live). So ist Desktop == Browser ohne native Abhängigkeit.

    Defensiv: bei jeder Ausnahme -> 1.0 (konservativ 'verdeckt' => KEIN
    Okklusions-Rescue, Fallback auf die cf-Logik)."""
    try:
        fc = mesh.triangles_center[face_idxs]
        if len(fc) > 16:                   # Stichprobe genügt, spart Rechenzeit
            sel = np.linspace(0, len(fc) - 1, 16).astype(int)
            fc = fc[sel]
        extent = float(np.linalg.norm(np.ptp(mesh.vertices, axis=0)))
        eps = max(1e-5, 1e-4 * extent)
        d = np.asarray(direction, dtype=float)

        # Dreiecks-Kanten EINMAL pro Wand cachen (über alle Kandidaten/Strahlen).
        cache = getattr(mesh, "_mt_cache", None)
        if cache is None:
            tris = np.asarray(mesh.triangles, dtype=float)   # (F,3,3)
            v0 = tris[:, 0, :]
            e1 = tris[:, 1, :] - v0
            e2 = tris[:, 2, :] - v0
            cache = (v0, e1, e2)
            try:
                mesh._mt_cache = cache
            except Exception:
                pass
        v0, e1, e2 = cache

        # Möller–Trumbore, pro Strahl über ALLE Dreiecke vektorisiert.
        pvec = np.cross(d, e2)                          # (F,3)
        det = np.einsum("ij,ij->i", e1, pvec)           # (F,)
        ok = np.abs(det) > 1e-12
        inv = np.zeros_like(det)
        inv[ok] = 1.0 / det[ok]
        hits = 0
        n = len(fc)
        for k in range(n):
            o = fc[k] + d * eps                          # leicht von der Fläche weg
            tvec = o - v0                                # (F,3)
            u = np.einsum("ij,ij->i", tvec, pvec) * inv
            qvec = np.cross(tvec, e1)                    # (F,3)
            v = np.einsum("j,ij->i", d, qvec) * inv
            t = np.einsum("ij,ij->i", e2, qvec) * inv
            hit = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1.0 + 1e-6) & (t > eps)
            if bool(hit.any()):
                hits += 1
        return float(hits) / max(n, 1)
    except Exception:
        return 1.0


def _lateral_enclosure(mesh, face_idxs, close_dist, ndir=12):
    """Grundriss-Einschliessung: Anteil HORIZONTALER Strahlen (ndir Azimute aus
    bis zu 4 Schwerpunkten), die innerhalb `close_dist` eine Wand treffen.

    Ein Nischenboden ist im Grundriss von den Seitenwänden umschlossen → viele
    nahe Treffer (empirisch ~0.3–0.5). Eine Krone / ein Fundament-Vorsprung ist
    offen → fast keine nahen Treffer (~0–0.08; nächste Wand Meter entfernt).
    Reines numpy (Möller–Trumbore), Pyodide-tauglich; bei Ausnahme -> 1.0
    (konservativ 'umschlossen' => Fläche gilt als Nische, kein Okklusions-
    Rescue)."""
    try:
        cache = getattr(mesh, "_mt_cache", None)
        if cache is None:
            tris = np.asarray(mesh.triangles, dtype=float)
            v0 = tris[:, 0, :]; e1 = tris[:, 1, :] - v0; e2 = tris[:, 2, :] - v0
            cache = (v0, e1, e2)
            try: mesh._mt_cache = cache
            except Exception: pass
        v0, e1, e2 = cache
        fc = mesh.triangles_center[face_idxs]
        if len(fc) > 4:
            fc = fc[np.linspace(0, len(fc) - 1, 4).astype(int)]
        ang = np.linspace(0.0, 2.0 * np.pi, ndir, endpoint=False)
        dirs = [np.array([np.cos(a), np.sin(a), 0.0]) for a in ang]
        eps = max(1e-5, 1e-4 * close_dist)
        close = 0
        total = 0
        for d in dirs:
            pvec = np.cross(d, e2)
            det = np.einsum("ij,ij->i", e1, pvec)
            ok = np.abs(det) > 1e-12
            inv = np.zeros_like(det); inv[ok] = 1.0 / det[ok]
            for o0 in fc:
                o = o0 + d * eps
                tvec = o - v0
                u = np.einsum("ij,ij->i", tvec, pvec) * inv
                qvec = np.cross(tvec, e1)
                v = np.einsum("j,ij->i", d, qvec) * inv
                t = np.einsum("ij,ij->i", e2, qvec) * inv
                hit = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1.0 + 1e-6) & (t > eps)
                total += 1
                if np.any(hit & (t < close_dist)):
                    close += 1
        return float(close) / max(total, 1)
    except Exception:
        return 1.0


def _open_horizontal(mesh, face_idxs, normal_z):
    """User-Regel ('aus der Draufsicht nichts darüber → Krone'), erweitert um
    die Grundriss-Einschliessung: eine ~HORIZONTALE Fläche (|n_z|>0.7) ist
    Schalfläche (Krone bzw. Fundament-OK), wenn sie

      (a) aus ihrer Normalenrichtung (oben für +Z, unten für -Z) NICHT verdeckt
          ist (himmelsoffen), UND
      (b) im Grundriss NICHT von Seitenwänden umschlossen ist.

    (a) allein trennt den Fundament-Vorsprung (occ↑≈0) vom mittigen Nischenboden
    (occ↑≈1). ABER manche Nischenböden sind auch von oben offen (occ↑≈0) —
    diese fängt (b): sie sind im Grundriss von den Nischen-Seitenflächen
    umschlossen (nahe Wände ringsum), der Fundament-Vorsprung/die Krone nicht.
    Beides nötig; depth/cf können beide Fälle nicht trennen. Vertikale
    Nischen-Seitenflächen fallen über den |n_z|>0.7-Gate raus."""
    if abs(normal_z) < 0.7:
        return False
    direction = (0.0, 0.0, 1.0) if normal_z > 0 else (0.0, 0.0, -1.0)
    if _occluded_fraction(mesh, face_idxs, direction) >= 0.5:
        return False                       # von oben verdeckt -> Nische
    extent = float(np.linalg.norm(np.ptp(mesh.vertices, axis=0)))
    close_dist = max(0.6, 0.015 * extent)  # Tasche klein/absolut; Struktur weit
    if _lateral_enclosure(mesh, face_idxs, close_dist) >= 0.2:
        return False                       # im Grundriss umschlossen -> Nische
    return True


def detect_niches_face_classification(mesh, return_meta=False, axes=None):
    """PER-REGION TIEFENKLASSIFIKATION mit surface_regions-Segmentierung.

    ALGORITHMUS:
      1. surface_regions(mesh) → Regionen (getrennt an scharfen Kanten)
      2. Pro Region: flächengewichtete Normale → PCA-Cluster-Zuweisung
      3. Pro Cluster: GRÖSSTE Region = Schalfläche
      4. Nicht-Haupt-Regionen = Niche-Kandidaten
      5. Rescue: Nicht-Haupt-Regionen die FLACH (on hull) UND konvexe
         Boundary haben → Schalfläche (Stirn, Top, Mauerfuss-Fragment)
      6. Rest = Niche → connected components via face_adjacency
    """
    nf = len(mesh.faces)
    fa_area = mesh.area_faces
    fc_all = mesh.triangles_center
    FN = mesh.face_normals
    V = mesh.vertices
    c_mesh = V.mean(0)
    # Welt-Z-Niveaus fuer den Krone/Fundament-Z-Guard (Waende sind Z-up; detect
    # erzwingt Vt[1]=+Z). Die Krone liegt am TOP, das Fundament am FUSS. Eine
    # on-hull +Z/-Z-Flaeche auf halber Hoehe (Nischenboden/-decke an der Muendung)
    # ist KEINE Schalflaeche und darf nicht zur Krone/Fundament gerettet werden
    # (sonst Kronen-Versatz an Nischenwaenden).
    z_top = float(V[:, 2].max())
    z_bot = float(V[:, 2].min())
    z_height = max(z_top - z_bot, 1e-9)
    crown_level_frac = 0.25

    # ----- Schritt 1: surface_regions → glatte Patches -----
    regions, reg = surface_regions(mesh)
    nr = len(regions)

    # ----- PCA-Achsen -----
    if axes is not None:
        Vt = np.asarray(axes, dtype=float)
    else:
        _, _, Vt = np.linalg.svd(V - c_mesh, full_matrices=False)
    dirs = np.vstack([Vt[0], -Vt[0], Vt[1], -Vt[1], Vt[2], -Vt[2]])
    thickness = float(np.ptp((V - c_mesh) @ Vt[2]))

    # ----- Schritt 2: Region-Cluster-Zuweisung -----
    region_normals = np.zeros((nr, 3))
    region_centroids = np.zeros((nr, 3))
    for ri, r in enumerate(regions):
        region_normals[ri] = _region_normal(mesh, r["faces"])
        fw = fa_area[r["faces"]]
        region_centroids[ri] = (fc_all[r["faces"]] * fw[:, None]).sum(0) / max(float(fw.sum()), 1e-12)
    region_cluster = np.argmax(region_normals @ dirs.T, axis=1) if nr > 0 else np.array([], int)
    region_areas = np.array([r["area"] for r in regions])

    # ----- Schritt 3: Pro Cluster GRÖSSTE Region = Schalfläche -----
    # Kein Flächen-Gate mehr: die grösste Region pro PCA-Cluster ist die
    # Schalfläche dieser Richtung. Selbst winzige Stirnflächen sind legitime
    # Schalflächen; der co-planar/cf-Rescue (Schritt 7) entscheidet über
    # mehrdeutige Sekundär-Regionen modell-unabhängig.
    main_region_mask = np.zeros(nr, dtype=bool)
    components_by_cluster = [[] for _ in range(6)]
    # Z-Niveau der HAUPT-Krone (groesste +Z-Region) bzw. des Haupt-Fundaments
    # (groesste -Z-Region) als Referenz fuer den Rescue-Z-Guard. Eine on-hull
    # +Z/-Z-Flaeche, die deutlich UNTER der Hauptkrone (bzw. ueber dem Haupt-
    # fundament) liegt, ist ein Nischenboden/-decke, keine Schalflaeche. Bezug auf
    # die Hauptkrone (nicht die Mesh-Spitze!), damit Fundament-Oberseiten und
    # mehrstufige Kronen, die auf/ueber ihrem Hauptniveau liegen, erhalten bleiben.
    z_crown_main = z_top
    z_found_main = z_bot
    for ci in range(6):
        ri_in_cluster = np.where(region_cluster == ci)[0]
        if len(ri_in_cluster) == 0:
            continue
        ri_sorted = ri_in_cluster[np.argsort(-region_areas[ri_in_cluster])]
        biggest_ri = ri_sorted[0]
        biggest_area = float(region_areas[biggest_ri])
        main_region_mask[biggest_ri] = True
        if ci == 2:
            z_crown_main = float(region_centroids[biggest_ri][2])
        elif ci == 3:
            z_found_main = float(region_centroids[biggest_ri][2])
        if return_meta:
            components_by_cluster[ci].append({
                "faces": regions[biggest_ri]["faces"],
                "area": biggest_area, "is_main": True,
                "reason": f"Grösste Region in Cluster K{ci} (area {biggest_area:.2f}m²)",
            })

    # ----- Schritt 4: Rescue on-hull + konvexer Rand -----
    hull = mesh.convex_hull
    _, all_depths_arr, _ = trimesh.proximity.closest_point(hull, region_centroids)
    region_depths = np.asarray(all_depths_arr, dtype=float)
    depth_tol = max(1e-4, 0.02 * thickness)
    # Rescue-Kandidaten = nicht-Haupt-Regionen die FLACH (on hull) liegen.
    # Ob ihr Rand konvex genug ist (echte Schalfläche statt Nischen-Mündung),
    # entscheidet eine DATEN-GETRIEBENE Schwelle auf der bimodalen cf-Verteilung
    # dieser Kandidaten (_onhull_cf_cutoff) — KEIN fester 0.5-Wert mehr. Eine
    # nach oben zeigende flache Schaleinlage (cf≈0.5) rutschte vorher knapp
    # unter 0.5 und wurde fälschlich als Krone gerettet; der bimodale Split
    # trennt sie sauber von echten Plateaus (cf≈0).
    cand_ri = [ri for ri in range(nr)
               if not main_region_mask[ri] and depth_tol > 0
               and float(region_depths[ri]) <= depth_tol]
    cand_cf = {ri: _concave_frac_region(mesh, regions[ri]["faces"])
               for ri in cand_ri}
    cf_cut = _onhull_cf_cutoff(list(cand_cf.values()))
    for ri in cand_ri:
        cf = cand_cf[ri]
        nz = float(region_normals[ri][2])
        horizontal = abs(nz) > 0.7
        if horizontal:
            # HORIZONTALE on-hull-Flächen: strenge daten-getriebene Schwelle
            # (cf_cut≈0.25) ODER himmelsoffen (Draufsicht-Regel). Hält die
            # nach-oben-Nischenböden (cf≈0.5) in K6, rettet Krone/Fundament-OK.
            # Z-NIVEAU-GUARD: nach OBEN zeigend → nur nahe Wand-TOP = Krone; nach
            # UNTEN → nur nahe FUSS = Fundament. Mittig liegende +Z/-Z-on-hull-
            # Flächen (Nischenboden an der Mündung) NICHT retten → bleiben K6.
            cz = float(region_centroids[ri][2])
            at_level = (cz >= z_crown_main - crown_level_frac * z_height) if nz > 0.0 \
                else (cz <= z_found_main + crown_level_frac * z_height)
            open_h = _open_horizontal(mesh, regions[ri]["faces"], nz)
            ok = at_level and (cf < cf_cut or open_h)
            why = (("offen-von-oben" if open_h and cf >= cf_cut else f"cf={cf:.2f}<{cf_cut:.2f}")
                   if at_level else "nicht auf Krone/Fuss-Niveau")
        else:
            # VERTIKALE on-hull-Flächen: lockere Mehrheits-Schwelle cf<0.5.
            # Das Nischenboden-Problem (cf≈0.5 knapp unter Schwelle) tritt nur
            # HORIZONTAL auf; vertikale on-hull-Stufen mit gleicher Normale wie
            # eine Schalfläche (z.B. der Kicker-Versatz an der Rückseite,
            # cf≈0.4) gehören zur Schalfläche, nicht zur Nische. Tiefe Nischen-
            # Seitenwände sind NICHT on-hull → hier kein Kandidat → unberührt.
            open_h = False
            ok = cf < 0.5
            why = f"vertikal cf={cf:.2f}<0.5"
        if ok:
            main_region_mask[ri] = True
            if return_meta:
                ci = int(region_cluster[ri])
                components_by_cluster[ci].append({
                    "faces": regions[ri]["faces"], "area": regions[ri]["area"],
                    "is_main": True,
                    "reason": (f"Rescue: on-hull (depth={float(region_depths[ri]):.4f}m, "
                               f"{why})"),
                })

    # ----- main_face_mask aufbauen -----
    main_face_mask = np.zeros(nf, dtype=bool)
    for ri in range(nr):
        if main_region_mask[ri]:
            main_face_mask[regions[ri]["faces"]] = True

    # ----- Schritt 6: Niche-Faces in Komponenten gruppieren -----
    nbra = [[] for _ in range(nf)]
    for a, b in mesh.face_adjacency:
        nbra[a].append(b); nbra[b].append(a)

    seen_arr = main_face_mask.copy()
    niche_components = []
    for s0 in range(nf):
        if seen_arr[s0]:
            continue
        comp = [s0]; seen_arr[s0] = True; dq = deque([s0])
        while dq:
            x = dq.popleft()
            for y in nbra[x]:
                if not seen_arr[y]:
                    seen_arr[y] = True; comp.append(y); dq.append(y)
        niche_components.append(np.array(comp))

    # ----- Schritt 7: Component-Level co-planar Rescue (≥50F) -----
    # Ganze Niche-Components deren Tiefe co-planar mit der Main-Region
    # ihres Mehrheits-Clusters ist UND die flache Boundary haben →
    # zurück zu Schalfläche. ALL-OR-NOTHING pro Component = kein
    # Fragmentieren.
    if niche_components:
        # Tiefen ALLER Main-Regionen (über alle Cluster) als Referenz-Set.
        # Eine Niche-Component die auf der GLEICHEN Tiefe wie IRGENDEINE
        # Schalfläche liegt, ist Teil der Wand-Hülle (nur andere Richtung) —
        # z.B. ein Kicker-Versatz-Riser der co-planar mit der Wand-Rückseite
        # ist aber in einer anderen PCA-Richtung zeigt.
        main_depths = np.array([float(region_depths[ri]) for ri in range(nr)
                                if main_region_mask[ri]])
        coplanar_tol = max(1e-4, 0.03 * thickness)
        # Kandidaten: Components die co-planar mit IRGENDEINER Schalfläche
        # liegen (d_diff ≤ coplanar_tol). Ob ihre konkavste Region eine echte
        # Nischen-Mündung ist, entscheidet wieder die DATEN-GETRIEBENE bimodale
        # cf-Schwelle (_onhull_cf_cutoff) statt eines festen 0.5-Werts.
        # max_region_cf = MAX cf über die Nicht-Haupt-Regionen der Component:
        # eine Drainage-Rinne hat eine konkav-dominierte Rückwand-Region, ein
        # Fundament-Versatz nur glatt/konvexe Transitionen.
        # KICKER-BAND-Erkennung (curvature-robust): ein vertikaler Wand-Versatz-
        # Riser (Kicker/Konsole) ist ein langes, DUENNES Band → hohe Polsby-Popper-
        # Zahl (pp = U²/4πA). Eine echte Nische/Tasche ist KOMPAKT (pp ~ 1-4). PP
        # ist FORMINVARIANT (skalierungs-/rotationsfrei) und damit auf gebogenen
        # Waenden zuverlaessig, anders als die konvexe-Huellen-Tiefe (die entlang
        # des Bogens variiert → Kicker wird sonst nie gerettet). Der not_encl-Guard
        # im Rescue verhindert, dass eine umschlossene Tasche als Band durchrutscht.
        _fa_pairs7 = mesh.face_adjacency
        _fa_edges7 = mesh.face_adjacency_edges

        def _component_pp(arr, area):
            inc = np.zeros(nf, dtype=bool)
            inc[arr] = True
            bnd = inc[_fa_pairs7[:, 0]] ^ inc[_fa_pairs7[:, 1]]
            if not bnd.any() or area <= 1e-12:
                return float("inf")
            be = _fa_edges7[bnd]
            perim = float(np.linalg.norm(V[be[:, 0]] - V[be[:, 1]], axis=1).sum())
            return (perim * perim) / (4.0 * np.pi * area)

        PP_BAND = 6.0   # kompakte Nische < ~4, langer Kicker-Riser >> (z.B. 31)

        cand7 = []  # (ci_nc, arr, max_region_cf, open_h, coplanar, comp_nz, cz, band)
        for ci_nc, comp in enumerate(niche_components):
            arr = np.asarray(comp, dtype=int)
            if len(main_depths) == 0:
                continue
            # Component-Tiefe (flächengewichtet)
            fw = fa_area[arr]
            cen = (fc_all[arr] * fw[:, None]).sum(0) / max(float(fw.sum()), 1e-12)
            _, dd, _ = trimesh.proximity.closest_point(hull, cen[None, :])
            comp_depth = float(dd[0])
            # Abstand zur NÄCHSTEN Main-Tiefe (egal welcher Cluster)
            d_diff = float(np.min(np.abs(main_depths - comp_depth)))
            # flächengewichtete Component-Normale (für den Draufsicht-Test)
            nmean = (mesh.face_normals[arr] * fw[:, None]).sum(0)
            comp_nz = float((nmean / (np.linalg.norm(nmean) + 1e-12))[2])
            # himmelsoffene horizontale Components (Fundament-OK-Vorsprung,
            # Krone-Versatz) werden IMMER gerettet — auch wenn nicht co-planar.
            open_h = _open_horizontal(mesh, arr, comp_nz)
            # KICKER-BAND: vertikale, langgestreckte (hohe PP) Component = Wand-
            # Versatz-Riser, KEINE kompakte Nische. Macht sie zum Kandidaten, auch
            # wenn die Huellen-Tiefe (d_diff) auf gebogenen Waenden zu gross ist.
            band = bool(abs(comp_nz) <= 0.7 and _component_pp(arr, float(fw.sum())) > PP_BAND)
            if d_diff > coplanar_tol and not open_h and not band:
                continue
            comp_regions = set(int(reg[f]) for f in arr)
            max_region_cf = max(
                (_concave_frac_region(mesh, regions[ri_]["faces"])
                 for ri_ in comp_regions if not main_region_mask[ri_]),
                default=0.0)
            cand7.append((ci_nc, arr, max_region_cf, open_h,
                          d_diff <= coplanar_tol, comp_nz, float(cen[2]), band))
        # cf-Schwelle nur aus den CO-PLANAREN, ~HORIZONTALEN Kandidaten
        # (saubere bimodale Verteilung; vertikale haben ein eigenes Kriterium).
        cf_cut7 = _onhull_cf_cutoff(
            [c[2] for c in cand7 if c[4] and abs(c[5]) > 0.7])
        rescued_indices = set()
        for ci_nc, arr, mcf, open_h, coplanar, comp_nz, cz_comp, band in cand7:
            horizontal = abs(comp_nz) > 0.7
            if horizontal:
                # himmelsoffen (Krone/Fundament-OK) ODER co-planar & strenge
                # daten-getriebene Schwelle (hält Nischenböden cf≈0.5 in K6).
                # Z-Niveau-Guard wie Schritt 5: nur nahe Top (nach oben) bzw. nahe
                # Fuss (nach unten) als Schalfläche retten; mittig = Nischenboden/
                # -decke → bleibt K6 (kein Kronen-Versatz).
                at_level = (cz_comp >= z_crown_main - crown_level_frac * z_height) if comp_nz > 0.0 \
                    else (cz_comp <= z_found_main + crown_level_frac * z_height)
                ok = at_level and (open_h or (coplanar and mcf < cf_cut7))
            else:
                # VERTIKALE co-planare Components: lockere Mehrheits-Schwelle
                # cf<0.5 UND im Grundriss NICHT umschlossen. Eine vertikale
                # Stufe co-planar mit einer Schalfläche, konvexem Rand und als
                # durchlaufendes BAND (nicht umschlossen) ist Schalfläche (z.B.
                # der Kicker-Versatz an der Rückseite, cf≈0.4, lateral≈0). Eine
                # vertikale Nischen-Seitenwand ist als TASCHE umschlossen
                # (lateral hoch) → bleibt K6 (sonst Thesis-Regression).
                _ext = float(np.linalg.norm(np.ptp(mesh.vertices, axis=0)))
                _cd = max(0.6, 0.015 * _ext)
                not_encl = _lateral_enclosure(mesh, arr, _cd) < 0.2
                # `band` (oben, PP-basiert) rettet den langen, duennen Kicker-
                # Versatz-Riser AUCH auf gebogenen Waenden, wo `coplanar` aus der
                # konvexen Huelle versagt. Der not_encl-Guard stellt sicher, dass es
                # ein durchlaufendes BAND ist (keine umschlossene Tasche/Nische).
                ok = (coplanar or band) and mcf < 0.5 and not_encl
            if ok:
                main_face_mask[arr] = True
                rescued_indices.add(ci_nc)
        if rescued_indices:
            niche_components = [c for i, c in enumerate(niche_components)
                                if i not in rescued_indices]

    # ----- return_meta Support -----
    if not return_meta:
        return niche_components

    # Per-Face cluster_id (Kompatibilität mit _detect_classify)
    cluster_id = np.argmax(FN @ dirs.T, axis=1)

    # Niche-component meta
    niche_meta = []
    for comp in niche_components:
        arr = np.asarray(comp, dtype=int)
        fw = fa_area[arr]
        area = float(fw.sum())
        cen = (fc_all[arr] * fw[:, None]).sum(0) / max(area, 1e-12)
        _, dd, _ = trimesh.proximity.closest_point(hull, cen[None, :])
        depth = float(dd[0])
        cf = _concave_frac_region(mesh, arr)

        # Polsby-Popper
        in_comp = np.zeros(nf, dtype=bool)
        in_comp[arr] = True
        fa_pairs = mesh.face_adjacency
        fa_edges = mesh.face_adjacency_edges
        bnd = in_comp[fa_pairs[:, 0]] ^ in_comp[fa_pairs[:, 1]]
        pp = float("inf")
        if bnd.any() and area > 1e-12:
            be = fa_edges[bnd]
            perim = float(np.linalg.norm(
                V[be[:, 0]] - V[be[:, 1]], axis=1).sum())
            pp = (perim * perim) / (4.0 * np.pi * area)

        niche_meta.append({
            "depth": depth,
            "pp": pp,
            "concave_frac": cf,
            "area": area,
            "n_faces": int(len(arr)),
            "thickness": thickness,
            "reason": f"Niche-Component: depth={depth:.4f}m, cf={cf:.2f}",
        })

    meta = {
        "cluster_id": cluster_id,
        "main_face_mask": main_face_mask,
        "components_by_cluster": components_by_cluster,
        "niche_meta": niche_meta,
        "thickness": thickness,
        "n_regions": nr,
    }
    return niche_components, meta
