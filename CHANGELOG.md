# Changelog

Alle nennenswerten Änderungen an IfcInspect. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionierung nach
[SemVer](https://semver.org/lang/de/).

Die folgenden Einträge fassen die Entwicklung gröber zusammen, als einzelne
Commits es täten; exakte Tagesdaten der Zwischenschritte sind nicht durchgängig
gepflegt und daher bewusst weggelassen.

## [0.4.41] — aktuell

### Hinzugefügt
- Export-Features: BCF-2.1-Export der Befunde, PDF-Prüfprotokoll (pdfmake),
  angereichertes IFC mit Psets `Pset_IfcInspect_Kenngroessen` und
  `Pset_IfcInspect_Pruefung`; wählbare IFC-Export-Inhalte.
- Schnitt-/Bemaßungswerkzeuge im Viewer (BimCollab-naher Schnitt: Box,
  Pick-Face, kombinierbare Ebenen; Maßlinien für Wandstärke und Kronenbreite).
- Erweiterter Element-Kontext: Fundament-Verknüpfung (L5), Luft-/Erdseite und
  Einbindetiefe über Terrain-Berührung (L6).
- Mobile-Layout (Hochkant-Wizard, Drawer) und Light-/Dark-Theme (folgt dem OS).

### Geändert
- Einheitliches Befund-Statusmodell: Bestanden / Nicht bestanden / Warnung /
  Info / Übersprungen; generischer Kontext-Teilcheck für richtungsabhängige
  Regeln (z. B. Kronen-Quergefälle).
- L4-Regelsatz auf das ASTRA-FHB-Strict-Profil fokussiert; Plausibilitätsregeln
  als Opt-in ausgelagert.
- Paket, Modul (`ifcinspect.py`) und Wheel (`ifcinspect-*.whl`) einheitlich zu
  `ifcinspect` umbenannt (vormals `niche_detector`) — keine Marken-Altlasten im Code.

### Behoben
- Quergefälle und Längsgefälle der Krone korrekt getrennt: Längsgefälle ENTLANG
  der Längsachse, Quergefälle RECHTWINKLIG dazu — bei gebogenen Wänden je Punkt
  über die lokale Tangente der Grundriss-Mittellinie zerlegt (statt einer
  globalen Achse). Ein Strassen-Längsgefälle erscheint nicht mehr im Quergefälle.
- Unsichtbare Schnittebenen sind nicht mehr selektier- oder verschiebbar.
- Klassifikationsflächen behalten ihre kräftige Farbe, auch wenn das
  Referenzmodell eingeblendet ist (geometrische Tiefen-Trennung, robust unter
  dem logarithmischen Tiefenpuffer).
- Einfachklick wählt das angeklickte Element statt des ganzen Modells.
- Anzeige-Status (Transparenz, Farbe, Linien-Toggle) bleibt beim An-/Abwählen
  stabil; diverse Picking- und Shading-Korrekturen.

## [0.3.x] — Branding, Browser-Pipeline, Performance

### Hinzugefügt
- UI-Umbenennung zu **IfcInspect** (Live-Tool / Anzeige); der vollständige
  Paket-/Modul-/Wheel-Rename folgte in 0.4.39.
- Browser-Pipeline: IFC-Geometrie über **web-ifc** (C++/WASM), Prüf-Pipeline als
  Python-Wheel über **Pyodide** im Browser ausgeführt — keine Server-Verarbeitung.
- IFC-Export-Rebuild: Round-trip, der das Original-IFC erhält und nur Psets +
  Flächen-Assembly anhängt; Klassen-Farben und Kenngrößen-Pset.
- FHB-konforme Kronen-Quergefälle-Richtung (Straße/Hang) mit Toleranzband.

### Geändert
- Mesh-Serialisierung beschleunigt; GLB-Skip auf großen Modellen.

### Behoben
- Browser-Lade-Hang behoben: `trimesh.boolean.union` (in Pyodide ohne Backend)
  und O(n²)-Nachbarschaftsberechnung aus dem Detect-Pfad entfernt bzw. aufgeschoben.
- Invertiertes `defer`-Flag der L7-Distanzberechnung korrigiert.
- Sicherheitsnetz: Performance-Baseline als Tag festgehalten
  (`perf-baseline-0.3.6`).

## [0.x] — Klassifikations-Pipeline (Initial)

### Hinzugefügt
- Erste Veröffentlichung des geometrischen IFC-Prüftools für ASTRA-Stützmauern.
- Single-Pipeline `niche_brep.detect_niches_face_classification`: ersetzt alle
  früheren Detektionsmethoden (Hull / Closing / B-Rep / …) durch die einheitliche
  Flächenklassifikation K0–K6.
- De-Heuristisierung des Code-Kerns; YAML-Regelsätze (ASTRA-FHB) mit
  zusammengesetzten Zielwerten und „Skip bei fehlendem Kennwert".
- Validierungs-Harness: Confusion-Matrix K0–K6 gegen analytische Ground Truth,
  Tessellierungs-Invarianz, Batch-Runner.
- Weitere Kennwerte: typgefilterte/mehrmodale Distanzregeln, Confidence-Score,
  Längsgefälle, Kronenbreiten-Aggregation, Regel-Builder mit benannten Regelsätzen.

[0.4.39]: https://ifcinspect.vercel.app
