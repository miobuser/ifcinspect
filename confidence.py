"""
confidence.py — deterministischer, erklaerbarer Confidence-Score je Kennwert.

MOTIVATION (Defense-Argument)
-----------------------------
Ein geometrisches Pruef-Tool, das jeden Wert ohne Selbst-Einschaetzung als
"wahr" ausgibt, ist fuer den Ingenieur schwer zu auditieren: er sieht 0.29 m
Kronenbreite, weiss aber nicht, ob dieser Wert aus 80 sauberen Stationen eines
watertight Meshes oder aus 2 Samples eines reparierten Klotzes stammt. Dieser
Modul quantifiziert die EIGEN-Unsicherheit des Tools pro Kennwert aus
benannten GEOMETRISCHEN Signalen (keine Black-Box, kein RNG, kein ML). Jeder
Score ist eine reine Funktion der Mesh-/Klassifikations-Signale und damit
reproduzierbar und im Bericht begruendbar.

SIGNALE (alle direkt aus Mesh + Klassifikation ableitbar)
---------------------------------------------------------
  S_watertight ∈ {1.0, 0.6}   mesh.is_watertight? harter Daempfer wenn nicht
                              (oder repariert) — ein nicht-geschlossenes Volumen
                              macht JEDE abgeleitete Distanz/Flaeche unsicher.
  S_density(n)               Tessellierungsdichte einer Flaeche: Faces (bzw.
                              Vertices) pro Region. Zu grob (wenige Faces) -> die
                              gemittelte Normale / der Extent sind verrauscht.
                              S_density = clamp((n - n_lo)/(n_hi - n_lo), 0, 1)
                              mit n_lo=8, n_hi=120 (weiche Rampe).
  S_margin                   Klassifikations-Margin: pro Face cos-Differenz
                              argmax(FN·dirs) zum zweitbesten. Faces nahe der
                              45°-Klassengrenze (margin < m_lo) sind mehrdeutig.
                              S_margin = 1 - Anteil_mehrdeutiger_Faces
                              (m_lo = cos(40°)-cos(50°)-aequivalent, s.u.).
  S_samples(k)               Stuetzpunkt-Anzahl je abgeleitetem Wert
                              (Kronenbreite: Stationen; Wandstaerke: Messpunkte;
                              Laengsgefaelle: Stationen). Wenige Samples -> der
                              Aggregat-Wert (min/p10/avg) ist statistisch wackelig.
                              S_samples = clamp((k - k_lo)/(k_hi - k_lo), 0, 1)
                              mit k_lo=3, k_hi=30.

AGGREGATION (je Kennwert-Gruppe)
--------------------------------
Pro Gruppe wird ein gewichtetes GEOMETRISCHES Mittel der relevanten Signale
gebildet und mit dem harten watertight-Daempfer MULTIPLIZIERT:

    score_group = S_watertight * prod_i( S_i ** w_i )            (Σ w_i = 1)

Begruendung der Form:
  * Das geometrische Mittel (Produkt^Gewicht) ist STRENGER als das arithmetische
    Mittel: ein einzelnes schwaches Signal (z.B. 2 Samples) zieht den Score
    deutlich nach unten, kann aber von starken Signalen teil-kompensiert werden.
    Ein arithmetisches Mittel wuerde ein katastrophales Signal zu leicht
    "wegmitteln".
  * Der watertight-Daempfer ist MULTIPLIKATIV und NICHT teil-kompensierbar:
    ein nicht-geschlossenes Mesh deckelt JEDEN Score auf <= 0.6, egal wie dicht
    oder eindeutig die Klassifikation ist — das entspricht der Tatsache, dass
    ein undichtes Volumen ein systematisches, nicht durch Sampling heilbares
    Problem ist.

  confidence.overall = gewichtetes Minimum-aehnliches Produkt der Gruppen-Scores:
    overall = S_watertight * (Π_g score_g_ohne_wt ** v_g)
  d.h. die globale Confidence ist hoechstens so gut wie der watertight-Daempfer
  und wird vom schwaechsten Bereich gezogen (kleines v-Produkt).

AMPEL
-----
  hoch    : score >= 0.80
  mittel  : 0.50 <= score < 0.80
  niedrig : score < 0.50

Alle Funktionen defensiv: fehlende Signale -> neutrale/None-Behandlung, nie
Crash. Reine numpy. Siehe Vault-Note
`Projects/University/Thesis/Confidence_und_Laengsgefaelle.md`.
"""
from __future__ import annotations

import numpy as np


# --------------------------------------------------------------------------- #
#  Konstanten der Signal-Rampen (alle benannt, dokumentiert, kein Tuning-Magie)
# --------------------------------------------------------------------------- #
WT_DAMPER_OK = 1.0          # watertight -> kein Daempfer
WT_DAMPER_BAD = 0.6         # nicht watertight / repariert -> harter Deckel

DENSITY_LO = 8.0            # < 8 Faces je Region -> Dichte-Signal = 0
DENSITY_HI = 120.0          # >= 120 Faces -> Dichte-Signal = 1

SAMPLES_LO = 3.0           # < 3 Stuetzpunkte -> Sample-Signal = 0
SAMPLES_HI = 30.0          # >= 30 Stuetzpunkte -> Sample-Signal = 1

# Margin-Grenze: ein Face gilt als "mehrdeutig", wenn die cos-Differenz zwischen
# bestem und zweitbestem Richtungs-Cluster < MARGIN_MIN ist. Bei den 6 Achsen-
# Richtungen ±Vt liegt die Klassengrenze bei 45°; cos(45°)=0.707. Eine Face,
# deren Normale exakt 45° zwischen zwei Achsen liegt, hat margin 0. Wir werten
# eine Differenz < 0.15 (≈ Normale innerhalb ~±5–6° der 45°-Grenze) als
# mehrdeutig — solche Faces koennen je nach Tessellierungs-Rauschen kippen.
MARGIN_MIN = 0.15

# Ampel-Schwellen
LEVEL_HIGH = 0.80
LEVEL_MID = 0.50


# --------------------------------------------------------------------------- #
#  Elementar-Signale
# --------------------------------------------------------------------------- #
def _clamp01(x: float) -> float:
    if x != x:           # NaN
        return 0.0
    return float(min(1.0, max(0.0, x)))


def _ramp(value, lo, hi) -> float:
    """Lineare weiche Rampe: <=lo -> 0, >=hi -> 1, dazwischen linear."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if hi <= lo:
        return 1.0 if v >= hi else 0.0
    return _clamp01((v - lo) / (hi - lo))


def density_signal(n_faces) -> float:
    """Tessellierungsdichte -> [0,1]. Mehr Faces je Oberflaeche = robuster."""
    return _ramp(n_faces, DENSITY_LO, DENSITY_HI)


def samples_signal(k) -> float:
    """Stuetzpunkt-Anzahl -> [0,1]. Mehr Stationen/Messpunkte = robuster."""
    return _ramp(k, SAMPLES_LO, SAMPLES_HI)


def watertight_damper(mesh, repaired: bool = False) -> tuple[float, bool]:
    """(Daempfer, is_watertight). Nicht-watertight ODER repariert -> harter Deckel.

    Defensiv: jeder Fehler beim Lesen von is_watertight -> als nicht-watertight
    behandeln (konservativ niedrige Confidence)."""
    try:
        wt = bool(mesh.is_watertight)
    except Exception:
        wt = False
    ok = wt and not repaired
    return (WT_DAMPER_OK if ok else WT_DAMPER_BAD), wt


def classification_margin(mesh, axes) -> dict:
    """Klassifikations-Margin ueber ALLE Faces.

    Pro Face: Projektion der Face-Normale auf die 6 Achsen-Richtungen
    dirs=[±Vt0,±Vt1,±Vt2]; margin = cos_best - cos_second. Kleiner Margin =
    Normale nahe der 45°-Klassengrenze = mehrdeutige Zuordnung.

    Returns dict:
      {"ambiguous_frac": Anteil Faces mit margin < MARGIN_MIN,
       "median_margin": float, "n_faces": int, "signal": 1 - ambiguous_frac}
    Defensiv: leeres/fehlerhaftes Mesh -> Signal 0.0.
    """
    out = {"ambiguous_frac": 1.0, "median_margin": 0.0, "n_faces": 0,
           "signal": 0.0}
    try:
        Vt = np.asarray(axes, dtype=float)
        dirs = np.vstack([Vt[0], -Vt[0], Vt[1], -Vt[1], Vt[2], -Vt[2]])
        FN = np.asarray(mesh.face_normals, dtype=float)
        if FN.ndim != 2 or FN.shape[0] == 0:
            return out
        proj = FN @ dirs.T                      # (nF, 6)
        srt = np.sort(proj, axis=1)             # aufsteigend
        best = srt[:, -1]
        second = srt[:, -2]
        margin = best - second                  # >= 0
        amb = float(np.mean(margin < MARGIN_MIN))
        out["ambiguous_frac"] = amb
        out["median_margin"] = float(np.median(margin))
        out["n_faces"] = int(FN.shape[0])
        out["signal"] = _clamp01(1.0 - amb)
    except Exception:
        pass
    return out


# --------------------------------------------------------------------------- #
#  Aggregation
# --------------------------------------------------------------------------- #
def _geom_weighted(signals_weights: list[tuple[float, float]]) -> float:
    """Gewichtetes geometrisches Mittel Π s_i**w_i (Gewichte werden normiert).

    Ein Signal von exakt 0 wird auf einen kleinen Floor 1e-3 gehoben, damit ein
    einzelnes Null-Signal den Score nicht hart auf 0 nagelt (es soll stark
    daempfen, aber andere Signale bleiben sichtbar). Leere Liste -> 0.0.
    """
    pairs = [(max(float(s), 1e-3), float(w)) for s, w in signals_weights
             if w and w > 0]
    if not pairs:
        return 0.0
    wsum = sum(w for _, w in pairs)
    if wsum <= 0:
        return 0.0
    acc = 0.0
    for s, w in pairs:
        acc += (w / wsum) * np.log(s)
    return _clamp01(float(np.exp(acc)))


def level_for(score) -> str:
    """Ampel-Stufe fuer einen Score."""
    if score is None:
        return "unbekannt"
    try:
        s = float(score)
    except (TypeError, ValueError):
        return "unbekannt"
    if s >= LEVEL_HIGH:
        return "hoch"
    if s >= LEVEL_MID:
        return "mittel"
    return "niedrig"


def _entry(score, basis: str) -> dict:
    """Ein Confidence-Eintrag {score, level, basis}."""
    sc = None if score is None else round(float(score), 3)
    return {"score": sc, "level": level_for(sc), "basis": basis}


# --------------------------------------------------------------------------- #
#  Pro-Region Face-Count Helper (Dichte-Signal je Klasse)
# --------------------------------------------------------------------------- #
def _class_face_count(main_face_mask, cluster_id, ci) -> int:
    try:
        cl = np.asarray(cluster_id)
        sel = (cl == ci) & np.asarray(main_face_mask, dtype=bool)
        return int(np.count_nonzero(sel))
    except Exception:
        return 0


# Klassen-Indizes (gespiegelt aus metrics.py, um Import-Zyklus zu vermeiden)
_K_CROWN = 2
_K_FOUND = 3
_K_FRONT = 4
_K_BACK = 5


# --------------------------------------------------------------------------- #
#  Hauptfunktion
# --------------------------------------------------------------------------- #
def compute_confidence(mesh, axes, main_face_mask, cluster_id, niche_components,
                       *, crown_n_samples=0, thickness_n_samples=0,
                       slope_n_stations=0, repaired=False) -> dict:
    """Vollstaendige Confidence-Sektion fuer ein wall_metrics-Dict.

    Args:
        mesh, axes, main_face_mask, cluster_id, niche_components: wie in
            metrics.wall_metrics().
        crown_n_samples: Anzahl Stations-Samples der Kronenbreite.
        thickness_n_samples: Anzahl Messpunkte der Wandstaerke.
        slope_n_stations: Anzahl Stationen des Laengsgefaelles (Krone).
        repaired: True falls das Mesh durch pymeshfix/fill_holes veraendert wurde.

    Returns dict mit Eintraegen je Gruppe (classification, crown_width,
    thickness, slope, volume, niches) + overall, jeweils {score, level, basis}.
    Zusaetzlich `_signals` mit den Roh-Signalwerten fuer Audit/Tests.
    Deterministisch, defensiv (nie Crash).
    """
    # --- harter watertight-Daempfer ---
    wt_damp, is_wt = watertight_damper(mesh, repaired=repaired)
    wt_txt = ("watertight" if is_wt and not repaired
              else ("repariert" if is_wt else "NICHT watertight"))

    # --- Klassifikations-Margin (global) ---
    marg = classification_margin(mesh, axes)
    s_margin = marg["signal"]

    # --- globale Tessellierungsdichte (mittlere Faces je Hauptflaechen-Klasse) ---
    try:
        n_total = int(len(mesh.faces))
    except Exception:
        n_total = 0
    main_counts = [_class_face_count(main_face_mask, cluster_id, ci)
                   for ci in range(6)]
    nonzero = [c for c in main_counts if c > 0]
    mean_class_faces = float(np.mean(nonzero)) if nonzero else 0.0
    s_density_global = density_signal(mean_class_faces)

    # ----------------------------------------------------------------- #
    #  Gruppe: classification (Flaechenklassifikation selbst)
    #  Signale: margin (0.6) + globale Dichte (0.4), x watertight
    # ----------------------------------------------------------------- #
    score_cls = wt_damp * _geom_weighted([(s_margin, 0.6),
                                          (s_density_global, 0.4)])
    cls_basis = (f"{wt_txt}; Margin-Signal {s_margin:.2f} "
                 f"(mehrdeutige Faces {marg['ambiguous_frac']*100:.0f} %); "
                 f"Dichte {mean_class_faces:.0f} F/Flaeche")

    # ----------------------------------------------------------------- #
    #  Gruppe: crown_width
    #  Signale: K2-Dichte (0.3) + crown-Samples (0.4) + margin (0.3), x wt
    # ----------------------------------------------------------------- #
    n_k2 = _class_face_count(main_face_mask, cluster_id, _K_CROWN)
    s_k2 = density_signal(n_k2)
    s_crown_samp = samples_signal(crown_n_samples)
    score_crown = wt_damp * _geom_weighted([(s_k2, 0.3),
                                            (s_crown_samp, 0.4),
                                            (s_margin, 0.3)])
    crown_basis = (f"{wt_txt}; Krone {n_k2} F; "
                   f"{int(crown_n_samples)} Stationen; "
                   f"Klassen-Margin {s_margin:.2f}")

    # ----------------------------------------------------------------- #
    #  Gruppe: thickness (Front->Back)
    #  Signale: (K4+K5)-Dichte (0.35) + Messpunkte (0.45) + margin (0.2), x wt
    # ----------------------------------------------------------------- #
    n_fb = (_class_face_count(main_face_mask, cluster_id, _K_FRONT)
            + _class_face_count(main_face_mask, cluster_id, _K_BACK))
    s_fb = density_signal(n_fb)
    s_thk_samp = samples_signal(thickness_n_samples)
    score_thk = wt_damp * _geom_weighted([(s_fb, 0.35),
                                          (s_thk_samp, 0.45),
                                          (s_margin, 0.2)])
    thk_basis = (f"{wt_txt}; Front+Back {n_fb} F; "
                 f"{int(thickness_n_samples)} Messpunkte; "
                 f"Margin {s_margin:.2f}")

    # ----------------------------------------------------------------- #
    #  Gruppe: slope (Quer- + Laengsgefaelle Krone/Fundament)
    #  Signale: (K2+K3)-Dichte (0.4) + slope-Stationen (0.4) + margin (0.2), x wt
    # ----------------------------------------------------------------- #
    n_cf = (_class_face_count(main_face_mask, cluster_id, _K_CROWN)
            + _class_face_count(main_face_mask, cluster_id, _K_FOUND))
    s_cf = density_signal(n_cf)
    s_slope_samp = samples_signal(slope_n_stations)
    score_slope = wt_damp * _geom_weighted([(s_cf, 0.4),
                                            (s_slope_samp, 0.4),
                                            (s_margin, 0.2)])
    slope_basis = (f"{wt_txt}; Krone+Fundament {n_cf} F; "
                   f"{int(slope_n_stations)} Stationen; "
                   f"Margin {s_margin:.2f}")

    # ----------------------------------------------------------------- #
    #  Gruppe: volume
    #  Signale: watertight (dominant) + globale Dichte (0.5) + n_total-Rampe (0.5)
    #  Hinweis: Volumen ist NUR bei watertight Mesh exakt -> wt-Daempfer dominiert.
    # ----------------------------------------------------------------- #
    # Volumen ist bei einem watertighten Mesh EXAKT, unabhaengig von der Face-Zahl
    # (ein Quader hat mit 12 Dreiecken das exakte Volumen). Daher KEINE Tessellier-
    # ungs-Heuristik: die Volumen-Confidence ist rein deterministisch der watertight-
    # Status (1.0 = geschlossen -> exakt, 0.6 = offen/repariert -> approximiert).
    score_vol = wt_damp
    vol_basis = (f"{wt_txt}; Volumen bei watertight Mesh exakt; {n_total} Faces"
                 + ("" if is_wt and not repaired else " (offen/repariert -> approximiert)"))

    # ----------------------------------------------------------------- #
    #  Gruppe: niches
    #  Signale: pro Niche-Component Face-Anzahl (Median-Dichte) + margin, x wt
    # ----------------------------------------------------------------- #
    try:
        nc_counts = [int(len(np.asarray(c, dtype=int)))
                     for c in (niche_components or [])]
    except Exception:
        nc_counts = []
    if nc_counts:
        med_nc = float(np.median(nc_counts))
        s_nc = density_signal(med_nc)
        score_niche = wt_damp * _geom_weighted([(s_nc, 0.6),
                                                (s_margin, 0.4)])
        niche_basis = (f"{wt_txt}; {len(nc_counts)} Niche(s), "
                       f"Median {med_nc:.0f} F; Margin {s_margin:.2f}")
    else:
        # keine Niche detektiert -> Confidence der (Nicht-)Erkennung haengt an
        # Mesh-Dichte+watertight; bei dichtem, watertight Mesh ist "0 Niches"
        # ein verlaesslicher Befund.
        score_niche = wt_damp * _geom_weighted([(s_density_global, 0.6),
                                                (s_margin, 0.4)])
        niche_basis = (f"{wt_txt}; keine Niche detektiert; "
                       f"Dichte {mean_class_faces:.0f} F/Flaeche")

    # ----------------------------------------------------------------- #
    #  overall: watertight-Daempfer x geometr. Mittel der Gruppen-Kerne
    #  (Gruppen-Scores OHNE doppelten wt-Faktor -> wt nur EINMAL angewandt)
    # ----------------------------------------------------------------- #
    def _core(score):
        # Gruppen-Score wieder durch wt teilen, damit wt nicht mehrfach eingeht
        return _clamp01(score / wt_damp) if wt_damp > 0 else 0.0

    overall = wt_damp * _geom_weighted([
        (_core(score_cls), 0.30),
        (_core(score_crown), 0.15),
        (_core(score_thk), 0.20),
        (_core(score_slope), 0.15),
        (_core(score_vol), 0.10),
        (_core(score_niche), 0.10),
    ])
    overall_basis = (f"{wt_txt}; gewichtetes geom. Mittel der Gruppen "
                     f"(Klassifikation dominiert)")

    return {
        "classification": _entry(score_cls, cls_basis),
        "crown_width": _entry(score_crown, crown_basis),
        "thickness": _entry(score_thk, thk_basis),
        "slope": _entry(score_slope, slope_basis),
        "volume": _entry(score_vol, vol_basis),
        "niches": _entry(score_niche, niche_basis),
        "overall": _entry(overall, overall_basis),
        "_signals": {
            "watertight": bool(is_wt),
            "repaired": bool(repaired),
            "watertight_damper": round(float(wt_damp), 3),
            "margin_signal": round(float(s_margin), 3),
            "ambiguous_face_frac": round(float(marg["ambiguous_frac"]), 4),
            "median_margin": round(float(marg["median_margin"]), 4),
            "n_faces_total": int(n_total),
            "mean_class_faces": round(float(mean_class_faces), 1),
            "density_signal_global": round(float(s_density_global), 3),
            "crown_n_samples": int(crown_n_samples),
            "thickness_n_samples": int(thickness_n_samples),
            "slope_n_stations": int(slope_n_stations),
            "k2_faces": int(n_k2),
            "front_back_faces": int(n_fb),
            "crown_foundation_faces": int(n_cf),
        },
    }


__all__ = [
    "compute_confidence", "classification_margin", "density_signal",
    "samples_signal", "watertight_damper", "level_for",
    "LEVEL_HIGH", "LEVEL_MID",
]
