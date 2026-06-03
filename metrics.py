"""
metrics.py — geometrische Kenngrössen einer klassifizierten IFC-Stützwand.

Berechnet aus dem reparierten Wand-Mesh und der Face-Klassifikation
(`main_face_mask`, `cluster_id`, `niche_components` aus
`niche_brep.detect_niches_face_classification(..., return_meta=True)`)
einen kompakten Kennwert-Satz für die L1/L3-Prüfung nach
ASTRA-Fachhandbuch-Logik.

Achsen-Konvention (welt-ausgerichtet, `t["_global_axes"]`):
    Vt[0] = längste horizontale Wandachse  → K0/K1 = ±Vt[0] (Stirnflächen)
    Vt[1] = +Z (Welt-vertikal)             → K2/K3 = ±Vt[1] (Mauerkrone/Fundament)
    Vt[2] = senkrecht horizontal           → K4/K5 = ±Vt[2] (Front/Back der Wand)

cluster_id pro Face nach `dirs = [+Vt0,-Vt0,+Vt1,-Vt1,+Vt2,-Vt2]`:
    K0=+Vt0, K1=-Vt0, K2=+Vt1, K3=-Vt1, K4=+Vt2, K5=-Vt2, K6=Niche.

Reine numpy + trimesh. Alle Längen in Metern, Winkel in Grad, Flächen in m²,
Volumina in m³. Defensiv: leere/fehlende Regionen → None bzw. 0.0, kein Crash.
"""
from __future__ import annotations

import math
import sys

import numpy as np
import trimesh
import trimesh.proximity


# Klassen-Indizes (siehe Modul-Docstring)
K_FRONT = 4   # +Vt[2]
K_BACK = 5    # -Vt[2]
K_CROWN = 2   # +Vt[1]  (Mauerkrone)
K_FOUND = 3   # -Vt[1]  (Fundament)


# Akzeptanzkegel-Schwelle der Flaechenklassifikation: eine Face zaehlt zu einer
# Hauptrichtung, wenn ihre Normale innerhalb von 45 Grad zur Richtung liegt
# (cos 45 deg = 0.70710678...). KEINE getunte Magie-Zahl, sondern die geometrisch
# definierte Halb-Oeffnung des Klassifikations-Kegels. Wird sowohl fuer die
# Richtungs-Klassifikation als auch fuer die Auswahl der Niche-Rueckwand-Faces
# (thickness_at_niches) verwendet -- dieselbe 45-Grad-Schwelle, keine zweite Konstante.
COS_45 = math.cos(math.radians(45.0))


def _area_weighted_median(vals, weights):
    """Flächengewichteter Median einer Werte-Reihe (Wert, bei dem die kumulierte
    Fläche 50 % erreicht). Robuster als das Mittel gegen einzelne fehl-
    klassifizierte/steile Ausreisser-Faces in einer Klassen-Region, und
    azimut-invariant (anders als die Neigung der gemittelten Vektor-Normale).
    Auf homogenen Flächen identisch zum Mittel."""
    v = np.asarray(vals, dtype=float)
    w = np.asarray(weights, dtype=float)
    if v.size == 0 or float(w.sum()) <= 1e-12:
        return None
    order = np.argsort(v)
    v = v[order]
    cw = np.cumsum(w[order])
    return float(v[int(np.searchsorted(cw, 0.5 * cw[-1]))])


# --------------------------------------------------------------------------- #
#  Hilfsfunktionen
# --------------------------------------------------------------------------- #
def _region_faces(main_face_mask, cluster_id, ci, main_only=True):
    """Face-Indizes einer Klasse `ci`.

    main_only=True → nur Schalflächen-Faces (main_face_mask True), damit
    Niche-Wände / -Rückwände aus der Region herausfallen. Das ist der Kern
    der Front→Back-Wandstärkenmessung: weil die Back-Region NUR aus
    K5-Hauptflächen besteht, treffen die Rays niemals eine Niche-Rückwand.
    """
    cl = np.asarray(cluster_id)
    sel = (cl == ci)
    if main_only:
        sel &= np.asarray(main_face_mask, dtype=bool)
    return np.where(sel)[0]


def _weighted_normal(mesh, faces):
    """Flächengewichtete Durchschnittsnormale einer Face-Gruppe (Einheitsvektor).

    Mathematik: n = Σ A_i·n_i / |Σ A_i·n_i|. Die Flächengewichtung verhindert,
    dass viele kleine tessellierte Dreiecke eine grosse, planare Schalfläche
    überstimmen — der gemittelte Normalenvektor entspricht der Normale der
    dominanten Ebene."""
    if len(faces) == 0:
        return None
    N = mesh.face_normals[faces]
    A = mesh.area_faces[faces]
    n = (N * A[:, None]).sum(0)
    nn = np.linalg.norm(n)
    if nn < 1e-12:
        return None
    return n / nn


def _stats(arr):
    """min/max/avg/median eines 1-D-Arrays, defensiv (leer → None-Defaults)."""
    a = np.asarray(arr, dtype=float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return {"min": None, "max": None, "avg": None, "median": None,
                "n_samples": 0}
    return {
        "min": float(a.min()),
        "max": float(a.max()),
        "avg": float(a.mean()),
        "median": float(np.median(a)),
        "n_samples": int(a.size),
    }


def _ratio_string(angle_to_vertical_deg):
    """Anzug-Verhältnis 1:n aus dem Winkel der Fläche zur Vertikalen.

    Anzug (batter) = horizontale Auslenkung pro Höheneinheit = tan(θ), wobei θ
    der Winkel zwischen der Wandfläche und der Lotrechten ist. Eine senkrechte
    Wand hat θ=0 → Verhältnis 1:∞; ein Anzug von 1:10 bedeutet 0,1 m Rücksprung
    pro 1 m Höhe (θ ≈ 5,71°). Rückgabe als lesbarer String "1:n"."""
    if angle_to_vertical_deg is None:
        return None
    t = np.tan(np.radians(angle_to_vertical_deg))
    if t < 1e-6:
        return "1:∞"          # praktisch senkrecht
    return f"1:{1.0 / t:.1f}"


# --------------------------------------------------------------------------- #
#  1) Wandstärke Front → Back
# --------------------------------------------------------------------------- #
def thickness_front_back(mesh, front_faces, back_faces):
    """Lokale Wandstärke Vorderkante → Hinterkante (NIE bis Niche-Rückwand).

    Verfahren:
      1. Mittlere Front-Normale n_f (flächengewichtet). Messrichtung d = -n_f
         (von der Aussen-Front in Richtung Wand-Rückseite, ins Material).
      2. Back-Submesh NUR aus K5-Hauptflächen-Faces bilden. Damit kann ein Ray
         keine Niche-Rückwand treffen — der gemessene Treffer ist garantiert
         die echte Wand-Hinterkante.
      3. Von jedem Front-Face-Centroid einen Ray entlang d casten und mit dem
         Back-Submesh schneiden (`back_submesh.ray.intersects_location`). Die
         Distanz zum nächstgelegenen Treffer = lokale Wandstärke an diesem Punkt.
      4. Rays ohne Treffer werden verworfen (z.B. Centroide am Rand, deren Lot
         neben dem Back-Patch durchgeht).

    Robustheit: < 3 valide Treffer → Fallback auf
    `trimesh.proximity.closest_point(back_submesh, front_centroids)` (kürzeste
    euklidische Distanz Punkt→Back-Fläche). Das ist nahezu identisch zur
    Ray-Distanz, solange die Wand annähernd parallelflächig ist, und liefert
    immer einen Wert.

    Mathematische Begründung: Bei zwei (lokal) parallelen Schalflächen ist die
    Distanz entlang der Flächennormalen die exakte Materialdicke. Über alle
    Front-Centroide ergibt sich die Dickenverteilung; min/max zeigen Verjüngung
    bzw. Aufdickung, median ist robust gegen einzelne Randausreisser.

    Returns: dict aus `_stats` + "unit".
    """
    res = {"min": None, "max": None, "avg": None, "median": None,
           "n_samples": 0, "unit": "m",
           # Mess-RICHTUNG transparent benannt: die Dicke wird SENKRECHT
           # (front→back, entlang der Bezugsflächen-Normale) gemessen. Das ist
           # die korrekte Materialdicke bei (lokal) parallelen Schalflächen —
           # eine "kürzeste lokale Dicke" wäre bei angezogener Luftseite kürzer
           # als die wahre Wandstärke und damit irreführend. Siehe Vault-Note.
           "direction": "perpendicular_front_back"}
    if len(front_faces) == 0 or len(back_faces) == 0:
        return res

    n_front = _weighted_normal(mesh, front_faces)
    n_back = _weighted_normal(mesh, back_faces)
    if n_front is None or n_back is None:
        return res

    # BEZUGSFLÄCHE = die WENIGER geneigte (lotrechtere) der beiden Hauptflächen.
    # Im Stützmauerbau ist die Dicke auf die stabilere, lotrechtere Seite
    # (meist Erdseite) bezogen; die Luftseite ist angezogen. Die Flächen-
    # Neigung steckt im Vertikal-Anteil der Normale: |n·Z| ist gross für eine
    # geneigte Fläche (Normale kippt nach oben) und ~0 für eine lotrechte
    # (Normale horizontal). Kleinere |n·Z| = lotrechter = Bezugsfläche.
    if abs(float(n_front[2])) <= abs(float(n_back[2])):
        ref_faces, opp_faces, n_ref = front_faces, back_faces, n_front
    else:
        ref_faces, opp_faces, n_ref = back_faces, front_faces, n_back
    d = -n_ref                                   # rechtwinklig zur Bezugsfläche, ins Material

    # MESSPUNKTE = die ECKPUNKTE (Vertices) der Bezugsfläche, nicht die
    # Dreiecks-Schwerpunkte. So werden Extrema an Kanten erfasst — z.B. die
    # Mindestdicke an der schmaler werdenden Krone, die ein Centroid (Mitte
    # des Dreiecks) verfehlt.
    ref_vertex_ids = np.unique(mesh.faces[ref_faces])
    front_centroids = mesh.vertices[ref_vertex_ids]   # (Variablenname beibehalten)

    back_submesh = mesh.submesh([opp_faces], append=True)

    dists = []
    try:
        origins = front_centroids
        directions = np.tile(d, (len(origins), 1))
        # eps-Offset entlang d, damit der Strahl nicht im eigenen Startface hängt
        eps = 1e-6 * float(np.linalg.norm(mesh.extents))
        locs, idx_ray, _ = back_submesh.ray.intersects_location(
            origins + eps * directions, directions, multiple_hits=True)
        if len(idx_ray):
            # pro Ray nächsten Treffer in Vorwärtsrichtung nehmen
            per_ray = {}
            for loc, ir in zip(locs, idx_ray):
                t = float(np.dot(loc - origins[ir], d))
                if t <= eps:
                    continue
                if ir not in per_ray or t < per_ray[ir]:
                    per_ray[ir] = t
            dists = list(per_ray.values())
    except Exception:
        dists = []

    if len(dists) >= 3:
        out = _stats(dists)
        out["unit"] = "m"
        out["direction"] = "perpendicular_front_back"
        # Mess-Segmente für Viewer-Visualisierung: Front-Centroid → Treffer
        segs = []
        for ir, tt in per_ray.items():
            o = origins[ir]
            segs.append([[float(o[0]), float(o[1]), float(o[2])],
                         [float(o[0] + tt * d[0]), float(o[1] + tt * d[1]),
                          float(o[2] + tt * d[2])]])
        out["segments"] = segs
        return out

    # Fallback: closest_point (immer ein Wert, solange beide Regionen existieren)
    try:
        cp_pts, cp_dists, _ = trimesh.proximity.closest_point(
            back_submesh, front_centroids)
        out = _stats(cp_dists)
        out["unit"] = "m"
        out["direction"] = "perpendicular_front_back"
        out["segments"] = [
            [[float(a[0]), float(a[1]), float(a[2])],
             [float(b[0]), float(b[1]), float(b[2])]]
            for a, b in zip(front_centroids, cp_pts)]
        return out
    except Exception:
        return res


# --------------------------------------------------------------------------- #
#  2) Min. Restwandstärke bei Niche
# --------------------------------------------------------------------------- #
def thickness_at_niches(mesh, axes, main_face_mask, cluster_id, niche_components):
    """Restwandstärke (Niche-Rückwand → Wand-Back) pro Niche.

    Hintergrund: Eine Niche/Aussparung von der Wand-FRONT reduziert die
    tragende Restdicke an dieser Stelle. Der strukturell kritischste Punkt der
    Wand ist die kleinste Restwandstärke über alle Niches.

    Verfahren je Niche-Component:
      1. Front-Richtung n_f = mittlere K4-Hauptflächen-Normale (Aussen-Front).
         Falls keine K4-Hauptfläche existiert → Vt[2] als Ersatz-Front.
      2. Niche-RÜCKWAND-Faces = jene Niche-Faces, deren Normale ~parallel zur
         Front-Normale zeigt (cos(n_face, n_f) > COS_45, d.h. innerhalb des
         selben 45°-Akzeptanzkegels wie die Flächenklassifikation). Das sind
         die Böden der frontseitigen Aussparung; ihre Normale zeigt wie die
         Front nach aussen.
      3. Von jedem Rückwand-Centroid einen Ray Richtung d = -n_f (in Richtung
         Wand-Back) casten, geschnitten mit dem K5-Back-Submesh. Distanz =
         verbleibende Materialdicke hinter der Niche.
      4. Pro Niche: min Restwandstärke; global: kleinster dieser Werte.

    Defensiv: keine Rückwand-Faces / kein Back-Submesh / keine Treffer →
    `min` der Niche = None (überspringt die Niche in der globalen min-Bildung).

    Returns: {"min_global": float|None, "per_niche": [{...}, ...], "unit": "m"}.
    """
    Vt = np.asarray(axes, dtype=float)
    out = {"min_global": None, "per_niche": [], "unit": "m"}

    back_faces = _region_faces(main_face_mask, cluster_id, K_BACK, main_only=True)
    if len(back_faces) == 0:
        # ohne Back-Region keine Restdicke messbar
        out["per_niche"] = [{"niche": i, "min": None, "n_samples": 0,
                             "n_backwall_faces": 0}
                            for i in range(len(niche_components))]
        return out
    back_submesh = mesh.submesh([back_faces], append=True)

    front_faces = _region_faces(main_face_mask, cluster_id, K_FRONT, main_only=True)
    n_f = _weighted_normal(mesh, front_faces)
    if n_f is None:
        n_f = Vt[2] / (np.linalg.norm(Vt[2]) + 1e-12)   # Ersatz: +Vt[2] = Front
    # Mess-RICHTUNG = rechtwinklig zur weniger geneigten (Bezugs-)Hauptfläche,
    # konsistent mit thickness_front_back. n_f bleibt für die Rückwand-Auswahl
    # (Faces der frontseitigen Aussparung), aber gemessen wird entlang d_ref.
    n_back = _weighted_normal(mesh, back_faces)
    if n_back is not None and abs(float(n_back[2])) < abs(float(n_f[2])):
        n_ref = n_back            # Back ist lotrechter → Bezugsfläche
    else:
        n_ref = n_f
    d = -n_ref if float(np.dot(n_ref, n_f)) > 0 else n_ref  # ins Material (Richtung Back)
    eps = 1e-6 * float(np.linalg.norm(mesh.extents))

    FN = mesh.face_normals
    V = mesh.vertices
    per_niche_mins = []
    for ni, comp in enumerate(niche_components):
        comp = np.asarray(comp, dtype=int)
        # Rückwand-Faces: Normale ~parallel zur Front-Normale. Schwelle =
        # COS_45 (selbe 45°-Akzeptanzkegel-Schwelle wie die Flächen-
        # klassifikation, keine eigene Konstante).
        cosv = FN[comp] @ n_f
        backwall = comp[cosv > COS_45]
        entry = {"niche": ni, "min": None, "n_samples": 0,
                 "n_backwall_faces": int(len(backwall))}
        # MESSPUNKTE: bevorzugt die ECKPUNKTE der Rückwand-Boden-Faces (Normale
        # ~Front, der Boden der frontseitigen Aussparung). FEHLEN diese (schräge /
        # Drainage- / oblique Nischen ohne klar front-parallelen Boden — bisher
        # "Restwandstärke nicht ermittelt"), nehmen wir ALLE Niche-Eckpunkte: die
        # TIEFSTE Stelle (kleinste Distanz zur Back-Fläche entlang d) IST die
        # Restwandstärke. So liefert jede Nische einen Wert statt null.
        measure_faces = backwall if len(backwall) > 0 else comp
        if len(measure_faces) == 0:
            out["per_niche"].append(entry)
            continue
        if len(backwall) == 0:
            entry["backwall_fallback"] = True
        origins = V[np.unique(mesh.faces[measure_faces])]
        directions = np.tile(d, (len(origins), 1))
        dists = []
        try:
            locs, idx_ray, _ = back_submesh.ray.intersects_location(
                origins + eps * directions, directions, multiple_hits=True)
            if len(idx_ray):
                per_ray = {}
                for loc, ir in zip(locs, idx_ray):
                    t = float(np.dot(loc - origins[ir], d))
                    if t <= eps:
                        continue
                    if ir not in per_ray or t < per_ray[ir]:
                        per_ray[ir] = t
                dists = list(per_ray.values())
        except Exception:
            dists = []

        if len(dists) == 0:
            # Fallback: kürzeste Distanz Rückwand-Centroide → Back-Fläche
            try:
                _, cp, _ = trimesh.proximity.closest_point(back_submesh, origins)
                dists = [float(x) for x in cp if np.isfinite(x)]
            except Exception:
                dists = []

        if dists:
            entry["min"] = float(np.min(dists))
            entry["n_samples"] = int(len(dists))
            per_niche_mins.append(entry["min"])
        out["per_niche"].append(entry)

    if per_niche_mins:
        out["min_global"] = float(np.min(per_niche_mins))
    elif len(niche_components) > 0:
        # MEDIUM (Audit 2026-05-28): keine Niche hatte eine Backwall-Face mit
        # cos > COS_45 (45°-Kegel) zur Front-Normalen (drainage notches,
        # schraege Nischen).
        # Wir crashen NICHT, halten min_global=None, geben aber EINEN
        # stderr-Hinweis pro betroffene Wand fuer den Reviewer.
        wname = ""
        try:
            wname = getattr(mesh, "metadata", {}).get("name", "") or \
                    getattr(mesh, "metadata", {}).get("wall_name", "")
        except Exception:
            wname = ""
        sys.stderr.write(
            f"[metrics] thickness_at_niche: keine geeignete Backwall-Face "
            f"(cos < COS_45 / 45°-Kegel) fuer Wand "
            f"{wname or '<unbenannt>'} ({len(niche_components)} Niche(s)) "
            f"-- Wert bleibt null\n")
    return out


# --------------------------------------------------------------------------- #
#  3) Anzug + Neigung pro Schalfläche
# --------------------------------------------------------------------------- #
def _angles_to_axes(mesh, axes, main_face_mask, cluster_id):
    """Pro Klasse K0-K5: gewichtete Normale → Winkel zu Vertikal (Z) und Horizontal.

    Mathematik: Für die Normale n und die Vertikale z=Vt[1] gilt
        α_vert = arccos(|n·z|)   (Winkel der Normale zur Vertikalachse)
    Daraus:
      • Anzug einer (annähernd lotrechten) Wandfläche = Winkel der FLÄCHE zur
        Lotrechten = 90° − α_vert (denn die Flächennormale steht senkrecht auf
        der Fläche). Eine senkrechte Wand hat n⊥z → α_vert=90° → Anzug=0°.
      • Neigung einer (annähernd horizontalen) Fläche zur Horizontalen
        = α_vert (Krone/Fundament: n∥z → α_vert=0° → flach=0° Neigung).

    Returns: dict ci -> {"normal_to_vertical_deg", "face_to_vertical_deg",
    "face_to_horizontal_deg"} oder None bei leerer Klasse.
    """
    Vt = np.asarray(axes, dtype=float)
    z = Vt[1] / (np.linalg.norm(Vt[1]) + 1e-12)
    res = {}
    for ci in range(6):
        faces = _region_faces(main_face_mask, cluster_id, ci, main_only=True)
        if len(faces) == 0:
            res[ci] = None
            continue
        fn = np.asarray(mesh.face_normals[faces], dtype=float)
        fa = np.asarray(mesh.area_faces[faces], dtype=float)
        if float(fa.sum()) <= 1e-12 or len(fn) == 0:
            res[ci] = None
            continue
        # AZIMUT-INVARIANT: flächengewichtetes Mittel der PRO-DREIECK-Neigung
        # arccos(|nᵢ·z|), NICHT der Winkel der gemittelten Vektor-Normale. Auf
        # GEKRÜMMTEN Wänden heben sich sonst die radialen Horizontal-Anteile der
        # Normalen auf → Krone/Fundament/Anzug werden zu flach gemessen (3 %→2.87 %).
        # Auf geraden Wänden identisch (alle Normalen gleicher Azimut). Siehe Vault
        # Kronenneigung_gekruemmte_Wand_2026-06-03.
        cos_i = np.clip(np.abs(fn @ z), 0.0, 1.0)
        normal_to_vertical = _area_weighted_median(np.degrees(np.arccos(cos_i)), fa)
        if normal_to_vertical is None:
            res[ci] = None
            continue
        # Group-B Safe-Fix (Level-Audit 2026-05-30, JSON-SLOPE): arccos(|n·z|)
        # bei n≈z bzw. n⊥z erzeugt einen systematischen Tessellierungs-Rausch-
        # Default von ~8.1e-05° statt sauberer 0. Beträge < 1e-3° auf 0 snappen,
        # damit Krone/Fundament am Ursprung 0.0° liefern. Verändert KEINE echten
        # Neigungen (reale Anzüge/Slopes liegen weit über 1e-3°).
        SNAP_DEG = 1e-3
        nv = 0.0 if normal_to_vertical < SNAP_DEG else float(normal_to_vertical)
        ftv = 90.0 - normal_to_vertical
        ftv = 0.0 if ftv < SNAP_DEG else float(ftv)
        fth = 0.0 if normal_to_vertical < SNAP_DEG else float(normal_to_vertical)
        res[ci] = {
            "normal_to_vertical_deg": nv,
            # Winkel der FLÄCHE selbst (90° komplementär zur Normalen)
            "face_to_vertical_deg": ftv,
            "face_to_horizontal_deg": fth,
        }
    return res


def _horiz_unit(v):
    """Horizontale Projektion (z=0) als Einheitsvektor; None bei ~0."""
    v = np.asarray(v, dtype=float).copy()
    v[2] = 0.0
    n = np.linalg.norm(v)
    return (v / n) if n > 1e-9 else None


def _plan_centerline_tangents(cen, a, b, s):
    """Pro Flaeche die LOKALE Tangente der in den Grundriss projizierten Wand-
    Mittellinie, als 2D-Richtung in der (a,b)-Ebene (a=Laengs-, b=Querachse).

    Krone/Fundament bilden einen Streifen; je Laengs-Station ist das laterale
    Median (Projektion auf b) die Mittellinie. Ihre zentrale Differenz ergibt die
    Tangente. Gerade Wand -> (1,0) (= a). Gebogene Wand -> Tangente dreht mit dem
    Bogen, sodass "rechtwinklig dazu" an jedem Punkt korrekt ist.

    Returns (tang_a, tang_b) je Flaeche (Einheits-2D in der (a,b)-Ebene).
    """
    F = len(s)
    tang_a = np.ones(F)
    tang_b = np.zeros(F)
    span = float(np.ptp(s)) if F else 0.0
    if span <= 1e-6 or F < 6:
        return tang_a, tang_b
    lat = cen @ b
    nb = int(np.clip(round(span / 0.5), 4, 64))
    edges = np.linspace(s.min(), s.max(), nb + 1)
    bidx = np.clip(np.digitize(s, edges) - 1, 0, nb - 1)
    Sb, Lb = [], []
    for bb in range(nb):
        sel = bidx == bb
        if np.any(sel):
            Sb.append(float(np.median(s[sel])))
            Lb.append(float(np.median(lat[sel])))
    if len(Sb) < 3:
        return tang_a, tang_b
    Sb = np.asarray(Sb, dtype=float)
    Lb = np.asarray(Lb, dtype=float)
    order = np.argsort(Sb)
    Sb, Lb = Sb[order], Lb[order]
    dS = np.gradient(Sb)
    dL = np.gradient(Lb)
    tn = np.hypot(dS, dL)
    tn[tn < 1e-9] = 1.0
    tS, tL = dS / tn, dL / tn
    j = np.clip(np.searchsorted(Sb, s), 0, len(Sb) - 1)
    return tS[j], tL[j]


def _crown_slope_components(mesh, axes, main_face_mask, cluster_id, ci):
    """Quer- und Laengsgefaelle einer ~horizontalen Flaeche, zerlegt entlang der
    LOKALEN Tangente der in den Grundriss projizierten Wand-Mittellinie.

    Definition (ASTRA/Nutzer): LAENGSgefaelle = Steigung ENTLANG der Laengsachse
    (Mittellinie), QUERgefaelle = Steigung RECHTWINKLIG dazu. Auf gebogenen
    Waenden ist die Rechtwinklige an jedem Punkt anders -> die Zerlegung nutzt die
    lokale Tangente je Flaeche statt einer einzigen globalen Achse. Fuer gerade
    Waende reduziert sich das exakt auf die Zerlegung entlang Vt[0]/Vt[2].

    Pro Flaeche: Plan-Gradient g = -(n_horizontal)/(n.z) (Steigungsvektor im
    Grundriss); laengs = g.t_lokal, quer = g.m_lokal (m _|_ t). Flaechengewichtete
    Mediane ergeben die robusten Werte.

    Returns dict {quer_deg, quer_pct, signed_quer_pct (+=Drainage nach +Vt[2]),
    laengs_deg, laengs_pct (vorzeichenbehaftet, += nach +Vt[0]), n_faces} | None.
    """
    Vt = np.asarray(axes, dtype=float)
    z = np.array([0.0, 0.0, 1.0])
    a = _horiz_unit(Vt[0])
    if a is None:
        return None
    b = np.array([-a[1], a[0], 0.0])          # horizontale Querachse, strikt _|_ a
    bref = _horiz_unit(Vt[2])                  # nur als Drainage-Vorzeichen-Referenz
    faces = _region_faces(main_face_mask, cluster_id, ci, main_only=True)
    if len(faces) == 0:
        return None
    fn = np.asarray(mesh.face_normals[faces], dtype=float)
    fa = np.asarray(mesh.area_faces[faces], dtype=float)
    if float(fa.sum()) <= 1e-12 or len(fn) == 0:
        return None
    cen = np.asarray(mesh.triangles[faces], dtype=float).mean(axis=1)  # (F,3)
    s = cen @ a
    tang_a, tang_b = _plan_centerline_tangents(cen, a, b, s)
    # Plan-Gradient (Steigungsvektor) je Flaeche: g = -(n_horizontal)/(n.z)
    nz = fn @ z
    nz = np.where(np.abs(nz) < 1e-9, 1e-9, nz)
    g = -(fn - np.outer(nz, z)) / nz[:, None]
    ga = g @ a
    gb = g @ b
    laengs = ga * tang_a + gb * tang_b        # g . t_lokal  (entlang Mittellinie)
    quer = -ga * tang_b + gb * tang_a         # g . m_lokal  (rechtwinklig dazu)
    quer_abs = _area_weighted_median(np.abs(quer), fa)
    laengs_signed = _area_weighted_median(laengs, fa)
    if quer_abs is None or laengs_signed is None:
        return None
    # Drainagerichtung: Vorzeichen relativ zur globalen Querachse Vt[2] (front/
    # back), damit der Kontext-Pass die FHB-Richtung (gegen Hang) bestimmen kann.
    sref = bref if bref is not None else b
    drain = _area_weighted_median(g @ sref, fa)
    drain_sign = 1.0 if (drain is None or drain >= 0) else -1.0

    def _snap(x):
        return 0.0 if abs(x) < 1e-3 else float(x)

    return {
        "quer_deg": _snap(math.degrees(math.atan(abs(float(quer_abs))))),
        "quer_pct": _snap(float(quer_abs) * 100.0),
        "signed_quer_pct": _snap(drain_sign * float(quer_abs) * 100.0),
        "laengs_deg": _snap(math.degrees(math.atan(float(laengs_signed)))),
        "laengs_pct": _snap(float(laengs_signed) * 100.0),
        "n_faces": int(len(faces)),
    }


def batter_and_slope(mesh, axes, main_face_mask, cluster_id):
    """Anzug (Front/Back) und Neigung (Krone/Fundament) der Schalflächen.

    Anzug (batter) der Wandflächen K4/K5: Winkel der Fläche zur Lotrechten in
    Grad plus Anzug-Verhältnis 1:n (= horizontale Auslenkung je Höheneinheit,
    siehe `_ratio_string`). Eine perfekt senkrechte Wand: 0° / 1:∞.

    Neigung der Mauerkrone K2 und des Fundaments K3: QUERgefaelle = Steigung
    RECHTWINKLIG zur (lokalen) Laengsachse, LAENGSgefaelle = Steigung ENTLANG
    davon (`crown_longitudinal_deg/_percent`, `foundation_longitudinal_deg/_percent`).
    Bei gebogenen Waenden ist die Rechtwinklige je Punkt anders → Zerlegung
    entlang der lokalen Tangente der Grundriss-Mittellinie (siehe
    `_crown_slope_components`).

    Returns: {"batter": {...}, "slope": {...}}.
    """
    ang = _angles_to_axes(mesh, axes, main_face_mask, cluster_id)

    def face_to_vert(ci):
        return ang[ci]["face_to_vertical_deg"] if ang.get(ci) else None

    front_deg = face_to_vert(K_FRONT)
    back_deg = face_to_vert(K_BACK)
    batter = {
        "front_deg": front_deg,
        "front_ratio": _ratio_string(front_deg),
        "back_deg": back_deg,
        "back_ratio": _ratio_string(back_deg),
    }
    # QUER- und LAENGSgefaelle von Krone (K2) und Fundament (K3), zerlegt entlang
    # der LOKALEN Tangente der Grundriss-Mittellinie: Laengsgefaelle ENTLANG der
    # Laengsachse, Quergefaelle RECHTWINKLIG dazu (bei gebogenen Waenden je Punkt
    # anders). Siehe _crown_slope_components.
    crown_sl = _crown_slope_components(mesh, axes, main_face_mask, cluster_id,
                                       K_CROWN)
    found_sl = _crown_slope_components(mesh, axes, main_face_mask, cluster_id,
                                       K_FOUND)

    def _sg(d, k):
        return d.get(k) if isinstance(d, dict) else None

    slope = {
        # QUERgefaelle = Steigung RECHTWINKLIG zur (lokalen) Laengsachse
        "crown_deg": _sg(crown_sl, "quer_deg"),
        "foundation_deg": _sg(found_sl, "quer_deg"),
        # Vorzeichenbehaftetes Quergefaelle der Krone (+ = nach +Vt[2]/K_FRONT)
        "crown_drain_toward_front_percent": _sg(crown_sl, "signed_quer_pct"),
        # LAENGSgefaelle = Steigung ENTLANG der (lokalen) Laengsachse
        "crown_longitudinal_deg": _sg(crown_sl, "laengs_deg"),
        "crown_longitudinal_percent": _sg(crown_sl, "laengs_pct"),
        "crown_longitudinal_n_stations": _sg(crown_sl, "n_faces"),
        "foundation_longitudinal_deg": _sg(found_sl, "laengs_deg"),
        "foundation_longitudinal_percent": _sg(found_sl, "laengs_pct"),
        "foundation_longitudinal_n_stations": _sg(found_sl, "n_faces"),
    }
    return {"batter": batter, "slope": slope, "_angles_per_class": ang}


# --------------------------------------------------------------------------- #
#  4) Fläche pro Schalfläche
# --------------------------------------------------------------------------- #
def area_per_class(mesh, main_face_mask, cluster_id, niche_components):
    """Summe der Face-Flächen je Klasse K0..K6 (m²).

    K0-K5: Hauptflächen (main_face_mask) der jeweiligen PCA-Richtung.
    K6: alle Niche-Component-Faces zusammen. Summe der Dreiecksflächen ist die
    exakte Manteloberfläche dieser Klasse (kein Approximationsfehler)."""
    out = {}
    for ci in range(6):
        faces = _region_faces(main_face_mask, cluster_id, ci, main_only=True)
        out[f"K{ci}"] = float(mesh.area_faces[faces].sum()) if len(faces) else 0.0
    niche_faces = np.unique(np.concatenate(
        [np.asarray(c, dtype=int) for c in niche_components])) \
        if niche_components else np.array([], dtype=int)
    out["K6"] = float(mesh.area_faces[niche_faces].sum()) if len(niche_faces) else 0.0
    return out


# --------------------------------------------------------------------------- #
#  4b) Lokale Höhe (Krone → Fundament) per Ray-Cast
# --------------------------------------------------------------------------- #
def height_local(mesh, axes, main_face_mask, cluster_id):
    """Lokale Wandhöhe Krone(K2) → Fundament(K3): vertikaler Abstand Oberseite↔
    Unterseite an jedem Kronenpunkt.

    Verfahren (RAY-FREI, daher auch im Pyodide-Browser robust — der trimesh-Ray
    lieferte dort für die vertikale Richtung n=0): je Kronen-Vertex die horizontal
    NÄCHSTE Fundament-Stelle suchen (2D-cKDTree in der Horizontalebene
    Vt[0]×Vt[2]) und die Differenz entlang der Höhenachse Vt[1] (auf Welt-Z
    gezwungen) bilden. Liefert die ECHTE Streuung (min/max/avg/median), nicht nur
    einen Einzelwert.

    Defensiv: fehlende K2/K3-Region → {min:None,...,n:0}. NIE raise.

    Returns: {"min","max","avg","median","n"} (n = Anzahl ausgewerteter Kronenpunkte).
    """
    out = {"min": None, "max": None, "avg": None, "median": None, "n": 0}

    crown_faces = _region_faces(main_face_mask, cluster_id, K_CROWN,
                                main_only=True)
    found_faces = _region_faces(main_face_mask, cluster_id, K_FOUND,
                                main_only=True)
    if len(crown_faces) == 0 or len(found_faces) == 0:
        return out

    Vt = np.asarray(axes, dtype=float)
    up = Vt[1] / (np.linalg.norm(Vt[1]) + 1e-12)     # Höhenachse (Welt-Z)
    h0 = Vt[0] / (np.linalg.norm(Vt[0]) + 1e-12)     # horizontale Längsachse
    h2 = Vt[2] / (np.linalg.norm(Vt[2]) + 1e-12)     # horizontale Querachse

    try:
        cv = mesh.vertices[np.unique(mesh.faces[crown_faces].ravel())]
        fv = mesh.vertices[np.unique(mesh.faces[found_faces].ravel())]
        if len(cv) and len(fv):
            from scipy.spatial import cKDTree
            c2 = np.column_stack([cv @ h0, cv @ h2])  # Kronen-Punkte in der Horizontalebene
            f2 = np.column_stack([fv @ h0, fv @ h2])  # Fundament-Punkte horizontal
            cz = cv @ up
            fz = fv @ up
            _, idx = cKDTree(f2).query(c2)            # je Kronenpunkt nächste Fundamentstelle
            hgt = cz - fz[idx]                         # vertikaler Abstand Oberseite→Unterseite
            hgt = hgt[np.isfinite(hgt) & (hgt > 1e-6)]
            if hgt.size:
                return {
                    "min": float(hgt.min()),
                    "max": float(hgt.max()),
                    "avg": float(hgt.mean()),
                    "median": float(np.median(hgt)),
                    "n": int(hgt.size),
                }
    except Exception:
        pass

    # Letzter Fallback: mittlere vertikale Trennung (Einzelwert, min=max).
    try:
        cv = mesh.vertices[np.unique(mesh.faces[crown_faces].ravel())]
        fv = mesh.vertices[np.unique(mesh.faces[found_faces].ravel())]
        h = abs(float(np.mean(cv @ up)) - float(np.mean(fv @ up)))
        if h > 1e-6:
            return {"min": h, "max": h, "avg": h, "median": h, "n": 0}
    except Exception:
        pass
    return out


# --------------------------------------------------------------------------- #
#  4c) Abgewickelte (horizontale) Länge der 4 Längskanten
# --------------------------------------------------------------------------- #
def developed_lengths(mesh, axes, main_face_mask, cluster_id):
    """Abgewickelte horizontale Bogen-Länge der 4 Längskanten.

    Für jede Kante in {front_top, front_bottom, back_top, back_bottom}:
      * Face-Submesh = K_FRONT (front_*) bzw. K_BACK (back_*) Hauptflächen.
      * Vertices projizieren: s = V@Vt[0] (Längsstation), z = V@Vt[1] (Höhe),
        t = V@Vt[2] (Dicke).
      * s-Bereich in N Stationen schneiden, N = clip(round(span/0.25), 8, 200).
      * Pro NICHT-leerer Station: Vertex mit MAX z (für *_top) bzw. MIN z
        (für *_bottom) wählen.
      * Gewählte Punkte nach s ordnen; jeden auf die HORIZONTALEBENE projizieren
        (Koordinaten [s, t], z weglassen); abgewickelte Länge = Summe der
        aufeinanderfolgenden horizontalen Abstände.
      * Kante = None wenn Face fehlt oder < 2 Stationen.

    Bewusst KEINE Mittellinie: bei angezogener Wand wäre sie mehrdeutig.

    Defensiv: alles None wenn keine Kante verfügbar. NIE raise.

    Returns: {"front_top","front_bottom","back_top","back_bottom",
              "min","max","avg","method"} — min/max/avg über die VERFÜGBAREN
              (nicht-None) Kanten.
    """
    method = ("per-station vertical extremum (max z = top / min z = bottom) "
              "along Vt[0]; N=clip(round(span/0.25),8,200) stations; developed "
              "length = sum of consecutive horizontal [s,t] distances (z dropped)")
    out = {"front_top": None, "front_bottom": None,
           "back_top": None, "back_bottom": None,
           "min": None, "max": None, "avg": None, "method": method}

    Vt = np.asarray(axes, dtype=float)

    def _edge_length(face_ci, want_top):
        faces = _region_faces(main_face_mask, cluster_id, face_ci,
                              main_only=True)
        if len(faces) == 0:
            return None
        try:
            verts = mesh.vertices[np.unique(mesh.faces[faces])]
            s = verts @ Vt[0]          # Längsstation
            z = verts @ Vt[1]          # Höhe
            t = verts @ Vt[2]          # Dicke
        except Exception:
            return None
        if s.size < 2:
            return None
        span = float(np.ptp(s))
        if span < 1e-9:
            return None
        N = int(np.clip(round(span / 0.25), 8, 200))
        edges = np.linspace(float(s.min()), float(s.max()), N + 1)
        idx = np.clip(np.digitize(s, edges) - 1, 0, N - 1)
        chosen_s = []
        chosen_t = []
        for b in range(N):
            sel = np.where(idx == b)[0]
            if sel.size == 0:
                continue
            zb = z[sel]
            pick = sel[int(np.argmax(zb))] if want_top \
                else sel[int(np.argmin(zb))]
            chosen_s.append(float(s[pick]))
            chosen_t.append(float(t[pick]))
        if len(chosen_s) < 2:
            return None
        cs = np.asarray(chosen_s, dtype=float)
        ct = np.asarray(chosen_t, dtype=float)
        order = np.argsort(cs)            # nach Längsstation ordnen
        pts = np.column_stack([cs[order], ct[order]])   # Horizontalebene [s, t]
        seg = np.diff(pts, axis=0)
        total = float(np.sqrt((seg * seg).sum(axis=1)).sum())
        return total

    out["front_top"] = _edge_length(K_FRONT, want_top=True)
    out["front_bottom"] = _edge_length(K_FRONT, want_top=False)
    out["back_top"] = _edge_length(K_BACK, want_top=True)
    out["back_bottom"] = _edge_length(K_BACK, want_top=False)

    avail = [v for v in (out["front_top"], out["front_bottom"],
                         out["back_top"], out["back_bottom"]) if v is not None]
    if avail:
        a = np.asarray(avail, dtype=float)
        out["min"] = float(a.min())
        out["max"] = float(a.max())
        out["avg"] = float(a.mean())
    return out


# --------------------------------------------------------------------------- #
#  5) Weitere Kenngrössen
# --------------------------------------------------------------------------- #
def bbox_dimensions(mesh, axes):
    """Spannweiten entlang der PCA-Achsen: Länge/Höhe/Nominaldicke (m).

    Projektion der zentrierten Vertices auf jede Achse, Peak-to-Peak (ptp) =
    Ausdehnung. length = Vt[0] (längste Horizontale), height = Vt[1] (= Z),
    nominal_thickness = Vt[2] (senkrecht horizontal). Achsenausgerichtete
    Spannweite ist invariant gegen die globale Lage der Wand im Raum."""
    Vt = np.asarray(axes, dtype=float)
    V = mesh.vertices - mesh.vertices.mean(0)
    return {
        "length": float(np.ptp(V @ Vt[0])),
        "height": float(np.ptp(V @ Vt[1])),
        "nominal_thickness": float(np.ptp(V @ Vt[2])),
    }


def _crown_width_samples(mesh, axes, main_face_mask, cluster_id):
    """Per-station crown-width samples [m] (quer zur Wandachse Vt[0]).

    Verfahren: K2-Hauptflaechen (Mauerkrone, +Vt[1]); deren Vertices entlang der
    Wandachse Vt[0] in schmale Baender (Stationen) gebinnt; je Band der Vt[2]-
    Peak-to-Peak = lokale Kronenbreite quer zur Wand. So entsteht eine Breiten-
    VERTEILUNG statt nur eines globalen Peak-to-Peak, womit min/p10/avg/median
    sinnvoll werden (ein einzelner globaler ptp haette nur einen Wert).

    Returns: np.ndarray der Sample-Breiten (kann leer sein) ODER None bei Fehler.
    """
    Vt = np.asarray(axes, dtype=float)
    k2_faces = _region_faces(main_face_mask, cluster_id, K_CROWN, main_only=True)
    if len(k2_faces) == 0:
        return None
    try:
        verts = mesh.vertices[np.unique(mesh.faces[k2_faces])]
        V = verts - mesh.vertices.mean(0)
        u = V @ Vt[0]          # entlang Wandachse (Station)
        w = V @ Vt[2]          # quer zur Wand (Breite)
        if len(u) < 2:
            return None
        span = float(np.ptp(u))
        if span < 1e-6:
            # entartet (alle in einer Station) -> einziger globaler ptp
            ptp = float(np.ptp(w))
            return np.array([ptp]) if ptp > 1e-9 else None
        # Stationen ~0.5 m breit, gedeckelt auf [4, 64] Baender
        nbins = int(np.clip(round(span / 0.5), 4, 64))
        edges = np.linspace(u.min(), u.max(), nbins + 1)
        idx = np.clip(np.digitize(u, edges) - 1, 0, nbins - 1)
        widths = []
        for b in range(nbins):
            wb = w[idx == b]
            if len(wb) >= 2:
                pb = float(np.ptp(wb))
                if pb > 1e-9:
                    widths.append(pb)
        if not widths:
            ptp = float(np.ptp(w))
            return np.array([ptp]) if ptp > 1e-9 else None
        return np.asarray(widths, dtype=float)
    except Exception:
        return None


def _p10(arr):
    """Tukey-lower-hinge-artiges 10. Perzentil (Sliver-Schutz, robust gegen
    einzelne entartete Mini-Baender). Defensiv: leer -> None."""
    a = np.asarray(arr, dtype=float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return None
    return float(np.percentile(a, 10))


def crown_width(mesh, axes, main_face_mask, cluster_id, dims, areas):
    """Mauerkronen-Breite [m] (Mass quer zur Wandachse Vt[0]) inkl. Aggregations-
    Varianten.

    Verfahren:
      1. K2-Hauptflaechen (Mauerkrone, +Vt[1]) extrahieren, je Station entlang
         Vt[0] eine lokale Breite (Vt[2]-ptp) sampeln (`_crown_width_samples`).
      2. Default-Wert = p10 der Sample-Breiten (Sliver-Schutz). Zusaetzlich
         min/p10/avg/median exponiert, damit eine Regel die Aggregation waehlen
         kann (`crown_width_min_m`, `crown_width_p10_m`, `crown_width_avg_m`,
         `crown_width_median_m`).
      3. Fallback wenn keine K2-Flaeche / keine Samples: Krone-Flaeche /
         Wandlaenge (`areas['K2'] / dims['length']`) - approximiert die mittlere
         Breite; alle Aggregate gleich diesem Einzelwert. Bei beidem fehlend ->
         None.

    Returns: dict {"value": float|None, "method": str, "unit": "m",
    "min": .., "p10": .., "avg": .., "median": .., "n_samples": int}.
    `value` bleibt der p10-Default (abwaertskompatibel zu `crown_width_m`).
    """
    out = {"value": None, "method": "none", "unit": "m",
           "min": None, "p10": None, "avg": None, "median": None,
           "n_samples": 0}

    samples = _crown_width_samples(mesh, axes, main_face_mask, cluster_id)
    if samples is not None and len(samples) > 0:
        s = np.asarray(samples, dtype=float)
        s = s[np.isfinite(s)]
        if s.size > 0:
            out["min"] = float(s.min())
            out["p10"] = _p10(s)
            out["avg"] = float(s.mean())
            out["median"] = float(np.median(s))
            out["n_samples"] = int(s.size)
            out["value"] = out["p10"]
            out["method"] = "k2_station_ptp_p10"
            return out

    # Fallback: K2-Flaeche / Wandlaenge ~= mittlere Krone-Breite
    try:
        a = float(areas.get("K2", 0.0))
        L = float(dims.get("length") or 0.0)
        if a > 0 and L > 1e-6:
            v = a / L
            out["value"] = v
            out["min"] = out["p10"] = out["avg"] = out["median"] = v
            out["n_samples"] = 1
            out["method"] = "fallback_area_over_length"
    except Exception:
        pass
    return out


def foundation_thickness(mesh, axes, main_face_mask, cluster_id, dims, areas):
    """Fundament-Staerke [m] (Z-Extent der K3-Bodenflaeche, BBox-basiert).

    Hintergrund: K3 (-Vt[1]) ist die Fundament-Unterseite. Bei einem T-/L-
    foermigen Stuetzmauer-Fundament hat das Fundament eine eigene Z-Ausdehnung;
    die Z-Spannweite aller K3-Vertices (axis-aligned BBox) approximiert die
    Fundament-Dicke.

    Verfahren:
      1. K3-Hauptflaechen extrahieren -> Vertices.
      2. axis-aligned Z-Extent (max(z) - min(z)) dieser Vertices.
      3. Fallback wenn K3 fehlt: K3-Flaeche / Wandlaenge.

    Achtung: Annahme "Welt-Z = vertikal" - bei stark gekippten Bauteilen
    ungenau (siehe README "world-Z hardcoded").

    Returns: dict {"value": float|None, "method": str, "unit": "m"}.
    """
    out = {"value": None, "method": "none", "unit": "m"}

    k3_faces = _region_faces(main_face_mask, cluster_id, K_FOUND, main_only=True)
    if len(k3_faces) > 0:
        verts = mesh.vertices[np.unique(mesh.faces[k3_faces])]
        try:
            z = verts[:, 2]
            ext = float(z.max() - z.min())
            if ext > 1e-6:
                out["value"] = ext
                out["method"] = "k3_bbox_z_extent"
                return out
        except Exception:
            pass

    # Fallback: K3-Flaeche / Wandlaenge
    try:
        a = float(areas.get("K3", 0.0))
        L = float(dims.get("length") or 0.0)
        if a > 0 and L > 1e-6:
            out["value"] = a / L
            out["method"] = "fallback_area_over_length"
    except Exception:
        pass
    return out


def niche_volume(mesh, niche_components):
    """Anzahl Niches + Gesamt-Niche-Volumen über konvexe Hüllen (m³).

    Pro Niche-Component wird die konvexe Hülle ihrer Vertices gebildet und
    deren Volumen summiert. Begründung: Eine Niche-Component ist nur ein
    OFFENER Flächenpatch (die Mantelflächen der Aussparung), kein
    geschlossenes Volumen — `submesh.volume` wäre undefiniert. Die konvexe
    Hülle der Patch-Vertices ist eine robuste, stets positive obere Schranke
    des ausgesparten Raumvolumens (exakt für konvexe Aussparungen wie Quader-
    oder Zylinder-Durchbrüche, leicht überschätzend bei konkaven Formen)."""
    n = len(niche_components)
    total = 0.0
    for comp in niche_components:
        comp = np.asarray(comp, dtype=int)
        if len(comp) == 0:
            continue
        verts = mesh.vertices[np.unique(mesh.faces[comp].ravel())]
        if len(verts) < 4:
            continue
        try:
            ch = trimesh.Trimesh(vertices=verts).convex_hull
            total += abs(float(ch.volume))
        except Exception:
            pass
    return {"count": int(n), "total_volume_m3": float(total)}


# --------------------------------------------------------------------------- #
#  Hauptfunktion
# --------------------------------------------------------------------------- #
def wall_metrics(mesh, axes, main_face_mask, cluster_id, niche_components):
    """Vollständiger Kennwert-Satz einer klassifizierten Stützwand.

    Args:
        mesh: watertight trimesh.Trimesh der Wand (aus `_prep_wall`).
        axes: 3×3 Achsenmatrix Vt (welt-ausgerichtet, `t["_global_axes"]`).
        main_face_mask: bool-Array pro Face (True = Schalfläche K0-5).
        cluster_id: int-Array pro Face (0-5, PCA-Richtungs-Cluster).
        niche_components: Liste von Face-Index-Arrays (K6-Niches).

    Returns: verschachteltes dict (siehe Modul-Docstring / Auftrag).
    """
    axes = np.asarray(axes, dtype=float)
    main_face_mask = np.asarray(main_face_mask, dtype=bool)
    cluster_id = np.asarray(cluster_id)

    # ---- Bauteil-Typ + Dicke-Achse bestimmen ----
    # Die DICKE eines plattenartigen Bauteils ist senkrecht zum BREITESTEN
    # Hauptflächen-Paar. Bei einer Wand sind Front/Back (K4/K5, vertikal) die
    # grössten Flächen → Dicke = Front→Back. Bei einem flach liegenden
    # Fundament/einer Platte sind Top/Bottom (K2/K3, horizontal) die grössten
    # → Dicke = Oben→Unten (= Plattendicke), NICHT die sinnlose Footprint-
    # Breite quer durch die Schmalseiten.
    def _main_area(ci):
        f = _region_faces(main_face_mask, cluster_id, ci, main_only=True)
        return float(mesh.area_faces[f].sum()) if len(f) else 0.0
    _pairs = {
        "Wand":             (_main_area(K_FRONT) + _main_area(K_BACK), K_FRONT, K_BACK, "Front↔Back"),
        "Platte/Fundament": (_main_area(K_CROWN) + _main_area(K_FOUND), K_CROWN, K_FOUND, "Oben↔Unten"),
        "Stirn-dominiert":  (_main_area(0) + _main_area(1), 0, 1, "Stirn↔Stirn"),
    }
    element_type, (_pa, ci_a, ci_b, thickness_axis) = max(
        _pairs.items(), key=lambda kv: kv[1][0])

    front_faces = _region_faces(main_face_mask, cluster_id, ci_a, main_only=True)
    back_faces = _region_faces(main_face_mask, cluster_id, ci_b, main_only=True)

    thickness = thickness_front_back(mesh, front_faces, back_faces)
    th_niche = thickness_at_niches(mesh, axes, main_face_mask, cluster_id,
                                   niche_components)
    bs = batter_and_slope(mesh, axes, main_face_mask, cluster_id)
    areas = area_per_class(mesh, main_face_mask, cluster_id, niche_components)
    dims = bbox_dimensions(mesh, axes)
    # ADDITIV: lokale Höhe (Krone→Fundament per Ray-Cast) + abgewickelte
    # Längskanten-Längen. Beide rein additiv unter `dimensions`, ändern
    # length/height/nominal_thickness NICHT.
    dims["height_local"] = height_local(mesh, axes, main_face_mask, cluster_id)
    dims["developed_length"] = developed_lengths(mesh, axes, main_face_mask,
                                                 cluster_id)
    niches = niche_volume(mesh, niche_components)

    # ASTRA-Demo-Kennwerte: Krone-Breite + Fundament-Staerke (Top-Level-Keys
    # `crown_width_m` und `foundation_thickness_m`) - werden vom YAML-Ruleset
    # (`rules_astra_demo.yaml`) als Targets erwartet. Beide nutzen einen
    # Fallback (Flaeche / Wandlaenge) wenn die exakte Extent-Messung fehlschlaegt.
    _crown = crown_width(mesh, axes, main_face_mask, cluster_id, dims, areas)
    _found = foundation_thickness(mesh, axes, main_face_mask, cluster_id,
                                  dims, areas)

    try:
        vol = abs(float(mesh.volume))
    except Exception:
        vol = None
    try:
        surf = float(mesh.area)
    except Exception:
        surf = None
    try:
        cen = mesh.centroid
        centroid = [float(cen[0]), float(cen[1]), float(cen[2])]
    except Exception:
        centroid = None

    # PCA wall-frame axes (world-aligned Vt) — exposed so the SPA viewer can
    # place annotations along the true wall axes instead of guessing from
    # the AABB extents (which breaks on rotated / curved walls).
    wall_axes = {
        "long":      [float(axes[0, 0]), float(axes[0, 1]), float(axes[0, 2])],
        "height":    [float(axes[1, 0]), float(axes[1, 1]), float(axes[1, 2])],
        "thickness": [float(axes[2, 0]), float(axes[2, 1]), float(axes[2, 2])],
    }

    # ---- Confidence (immer mitberechnen, Anzeige/Regeln filtern spaeter) ----
    # ARCHITEKTUR-PRINZIP: alle Werte werden berechnet; ob sie angezeigt/
    # geprueft werden, entscheidet die Anzeige-/Regel-Schicht. Confidence ist
    # ein deterministischer Eigen-Unsicherheits-Score pro Kennwert-Gruppe.
    try:
        import confidence as _conf
        _crown_n = int(_crown.get("n_samples", 0) or 0)
        _thk_n = int(thickness.get("n_samples", 0) or 0)
        _slope_n = int(bs["slope"].get("crown_longitudinal_n_stations", 0) or 0)
        # `repaired`-Heuristik: wurde das Mesh durch fill_holes/Reparatur
        # veraendert? Wir leiten konservativ ab: ein Mesh, das NICHT watertight
        # ist, gilt als repariert/unsicher; explizite Flags koennen via
        # mesh.metadata['repaired'] gesetzt werden.
        _repaired = False
        try:
            _repaired = bool(getattr(mesh, "metadata", {}).get("repaired",
                                                               False))
        except Exception:
            _repaired = False
        confidence = _conf.compute_confidence(
            mesh, axes, main_face_mask, cluster_id, niche_components,
            crown_n_samples=_crown_n, thickness_n_samples=_thk_n,
            slope_n_stations=_slope_n, repaired=_repaired)
    except Exception as e:
        confidence = {"overall": {"score": None, "level": "unbekannt",
                                  "basis": f"Confidence-Fehler: "
                                           f"{type(e).__name__}: {e}"}}

    return {
        "element_type": element_type,
        "thickness_axis": thickness_axis,
        "wall_axes": wall_axes,
        "thickness": thickness,
        "thickness_at_niche": th_niche,
        "batter": bs["batter"],
        "slope": bs["slope"],
        "area_per_class": areas,
        "volume_m3": vol,
        "surface_area_m2": surf,
        "dimensions": dims,
        "niches": niches,
        "centroid": centroid,
        # Confidence-Sektion (immer mitberechnet): pro Kennwert-Gruppe
        # {score, level, basis} + overall + _signals. Siehe confidence.py.
        "confidence": confidence,
        # Top-Level-Skalare fuer YAML-Ruleset (ASTRA-Demo) - Werte sind
        # numerisch und enthalten zusaetzlich ein `_meta`-Feld mit der
        # verwendeten Methode (k2_extent_ptp / k3_bbox_z_extent /
        # fallback_area_over_length / none).
        "crown_width_m": _crown["value"],
        # Aggregations-Varianten der Kronenbreite (aus denselben Stations-
        # Samples wie der p10-Default). Eine Regel kann gezielt
        # `crown_width_min_m`/`crown_width_p10_m`/`crown_width_avg_m`/
        # `crown_width_median_m` als Target waehlen. Es gilt i.d.R.
        # min <= p10 <= median/avg.
        "crown_width_min_m": _crown.get("min"),
        "crown_width_p10_m": _crown.get("p10"),
        "crown_width_avg_m": _crown.get("avg"),
        "crown_width_median_m": _crown.get("median"),
        "foundation_thickness_m": _found["value"],
        "_metric_meta": {
            "crown_width_m": _crown["method"],
            "crown_width_n_samples": _crown.get("n_samples", 0),
            "foundation_thickness_m": _found["method"],
        },
    }


# --------------------------------------------------------------------------- #
#  Selbsttest
# --------------------------------------------------------------------------- #
def _print_metrics(m):
    import json

    def _fmt(o):
        if isinstance(o, float):
            return round(o, 4)
        return o
    print(json.dumps(m, indent=2, ensure_ascii=False, default=_fmt))


if __name__ == "__main__":
    import sys
    import numpy as np
    import ifcinspect as nd
    import niche_brep as nb
    from ifc_io import load_product_meshes

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    IFC = sys.argv[1] if len(sys.argv) > 1 else "web/public/demo/beispiel_bogenwand.ifc"
    print(f"[metrics selbsttest] Lade {IFC}")
    products = load_product_meshes(IFC)
    chosen = nd.candidate_solids(products)[0]
    print(f"  gewählt: '{chosen.name or chosen.ifc_type}' "
          f"({chosen.ifc_type}, {len(chosen.mesh.faces)}F)")

    offset = chosen.mesh.bounds.mean(axis=0).copy()
    wall, approx = nd._prep_wall(chosen.mesh, offset)
    if wall is None:
        raise SystemExit("Wand nicht verwertbar.")
    print(f"  prepped: {len(wall.faces)}F  watertight={wall.is_watertight}  "
          f"approx={approx}")

    # welt-ausgerichtete Achsen (identisch zur Single-Pick-Logik in detect())
    xy = wall.vertices[:, :2] - wall.vertices[:, :2].mean(0)
    _, _, hVt = np.linalg.svd(xy, full_matrices=False)
    v0 = np.array([hVt[0, 0], hVt[0, 1], 0.0])
    if v0[0] < -1e-9 or (abs(v0[0]) < 1e-9 and v0[1] < 0):
        v0 = -v0
    axes = np.vstack([v0, np.array([0.0, 0.0, 1.0]),
                      np.cross(v0, [0.0, 0.0, 1.0])])

    niche_components, meta = nb.detect_niches_face_classification(
        wall, return_meta=True, axes=axes)
    main_face_mask = meta["main_face_mask"]
    cluster_id = meta["cluster_id"]
    print(f"  Niches: {len(niche_components)}  "
          f"Schalflächen-Faces: {int(main_face_mask.sum())}/{len(wall.faces)}")

    m = wall_metrics(wall, axes, main_face_mask, cluster_id, niche_components)
    print("\n===== wall_metrics =====")
    _print_metrics(m)
