# IfcInspect

> Deterministische, rein geometrische Prüfung von ASTRA-Stützmauern aus semantikfreien IFC-Modellen.

**Live-Demo:** https://ifcinspect.vercel.app (Alias: https://ifc-tool-mio.vercel.app)

IfcInspect liest eine IFC-Stützmauer als reine Geometrie ein (ein geschlossenes
Volumen, **ohne** Verlass auf semantische Bauteil-Attribute), klassifiziert ihre
Oberflächen und prüft sie gegen den ASTRA-FHB-Regelsatz. Das Tool ist der
Implementierungskern einer BSc-Thesis an der Berner Fachhochschule (BFH), 2026.

---

## Was es macht

- **Liest semantikfreie IFC-Modelle** — die Prüfung beruht auf der Geometrie,
  nicht auf vorhandenen Bauteil- oder Pset-Attributen.
- **Flächenklassifikation K0–K6** — jede Wandfläche wird einer von sieben Klassen
  zugeordnet (sechs Schalungs-Hauptflächen plus **K6 = Nischen/Schaleinlagen**).
- **Nischen-/Schaleinlagen-Erkennung** als zusammenhängende K6-Regionen.
- **Regelprüfung gegen den ASTRA-FHB-Regelsatz** (Merkblatt 24001-15101):
  Kronenbreite, Wandstärke, Quergefälle, Anzug, Restwandstärke.
- **Kennwerte** je Wand: Stärke, Anzug, Krone-/Fundamentmaße, Flächen je Klasse,
  Nischenanzahl und -volumen.
- **Export** in mehreren Formaten: BCF 2.1, PDF-Prüfprotokoll und ein um
  Psets angereichertes IFC.
- **Läuft vollständig im Browser** — kein Upload, keine Server-Verarbeitung.

---

## Screenshot

<!-- Screenshot folgt — Datei noch zu ergänzen. -->
![IfcInspect — 3D-Ansicht mit Flächenklassifikation und Befunden](docs/screenshot.png)

---

## Prüfebenen L1–L7

| Ebene | Inhalt |
|---|---|
| **L1** | Geometrie-Aufbereitung / Watertight-Prüfung des Wand-Volumens |
| **L2** | Flächenklassifikation (K0–K6) |
| **L3** | Nischen-/Schaleinlagen-Erkennung (K6-Regionen) |
| **L4** | Regelprüfung (Kronenbreite, Wandstärke, Quergefälle, Anzug, Restwandstärke) |
| **L5** | Element-Kontext / Fundament-Verknüpfung |
| **L6** | Terrain / Erdseite (Luft- vs. Erdseite, Einbindetiefe) |
| **L7** | Paarweise Abstände zwischen Elementen |

> **L7 läuft im Browser asynchron NACH der Anzeige** (bewusst *deferred*), um die
> erste Darstellung nicht zu blockieren. Bis zum Abschluss ist
> `scene.distances = null`.

---

## Architektur

Das Frontend ist eine Vite-/TypeScript-Anwendung mit einem three.js-Viewer.
Die IFC-Geometrie liest **web-ifc** (C++/WASM). Die eigentliche Prüf-Pipeline
ist ein Python-Wheel (`ifcinspect`), das über **Pyodide** im Browser
ausgeführt wird. Es gibt keinen Backend-Server für die Verarbeitung.

```
  IFC-Datei
     │
     ▼
  web-ifc (C++/WASM)        Geometrie-Loader → Meshes
     │
     ▼
  Pyodide / ifcinspect  (Python-Wheel im Browser)
     │   L1 Aufbereitung/Watertight
     │   L2 Flächenklassifikation (K0–K6)
     │   L3 Nischen/Schaleinlagen (K6)
     │   L4 Regelprüfung (ASTRA-FHB)
     │   L5 Element-Kontext/Fundament
     │   L6 Terrain/Erdseite
     │   L7 paarweise Abstände (deferred)
     ▼
  Klassifikation + Kennwerte + Befunde
     │
     ▼
  Export ──► BCF 2.1
        ──► PDF-Prüfprotokoll (pdfmake)
        ──► angereichertes IFC
            (Pset_IfcInspect_Kenngroessen / _Pruefung)
```

Das Python-Wheel ist eine flache Modul-Sammlung:
`ifcinspect`, `niche_brep`, `ifc_io`, `webifc_mesh`, `context`, `distances`,
`adjacency`, `metrics`, `rules`, `report`, `confidence`.

---

## Lokale Entwicklung

**Frontend (Vite + TypeScript + three.js):**

```bash
cd web
npm install
npm run dev
```

**Python-Wheel / Tests:**

```bash
pip install -e .
pytest
```

---

## Beispielmodelle

Unter `web/public/demo/` liegen vier neutralisierte IFC-Beispielmodelle, mit
denen sich die Prüfebenen ausprobieren lassen. Sie sind zugleich die In-App-Demos:
in der [Live-Demo](https://ifcinspect.vercel.app) lassen sie sich per Drag & Drop
laden oder direkt über einen `?demo=`-Link öffnen.

| Datei | `?demo=` | Zeigt |
|---|---|---|
| `web/public/demo/beispiel_nische.ifc` | `nische` | Wand mit Nische/Schaleinlage (K6, L3) |
| `web/public/demo/beispiel_terrain_erdseite.ifc` | `terrain` | Terrain + Erdseiten-Erkennung (L6) |
| `web/public/demo/beispiel_mehrere_elemente.ifc` | `mehrere` | mehrere Elemente, paarweise Abstände (L7) |
| `web/public/demo/beispiel_bogenwand.ifc` | `bogenwand` | gekrümmte Wand, 30 Schaleinlagen, ASTRA-Demo-Regelset |

---

## Bekannte Limitationen

Eine vollständige Liste steht in [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).
Die drei wichtigsten Punkte:

- **Nur wasserdichte (geschlossene) Wand-Volumen werden geprüft.** Liefert web-ifc
  keine vernähte Geometrie, wird die Wand transparent übersprungen (`prep_failed`)
  statt falsch klassifiziert.
- **Dreikantleisten und Fasen** an Nischen-/Kronenrändern werden nicht als eigene
  Schalflächen-Klasse aufgelöst (kleine 45°-Übergänge fallen der Hauptklasse zu).
- **Über-Detektion an stark gekrümmten Wänden möglich** (Cap-Plane-Swing); gerade
  und mäßig gekrümmte Wände sind regressionsgetestet korrekt.

---

## Thesis-Kontext

IfcInspect ist der Implementierungskern einer Bachelor-Thesis (BSc) an der
**Berner Fachhochschule (BFH), 2026**. Thema ist die geometrische IFC-Validierung
von ASTRA-Stützmauern mit Schwerpunkt auf der Flächenklassifikation.

Das Thesis-Dokument ist nicht Teil dieses Repositories.
Link: _folgt / Platzhalter._

---

## Lizenz

MIT — siehe [LICENSE](LICENSE). © 2026 Mio Buser.
