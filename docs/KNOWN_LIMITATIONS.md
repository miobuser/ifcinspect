# Bekannte Limitationen

Dieses Dokument listet die bekannten Einschränkungen von IfcInspect. Sie sind
bewusst transparent dokumentiert; betroffene Wände werden nachvollziehbar
gekennzeichnet statt stillschweigend falsch geprüft.

- **Nur wasserdichte (geschlossene) Wand-Volumen werden geprüft.** web-ifc liefert für manche IFC-Wände keine vernähte, wasserdichte Geometrie; rein Python-basierte Reparatur (trimesh) reicht dann nicht. Solche Wände werden TRANSPARENT übersprungen (`prep_failed`, im Prüfprotokoll als „⚠ N Wand(e) übersprungen" ausgewiesen) statt falsch klassifiziert. Ein nativer OCC-basierter Vernäh-Fallback ist konzipiert, aber bewusst aufgeschoben.

- **Dreikantleisten und Fasen an Nischen-/Kronenrändern** werden nicht als eigene Schalflächen-Klasse aufgelöst; kleine 45°/abgeschrägte Übergangsflächen können der angrenzenden Hauptklasse zugeschlagen werden. Die K6-Nischenabgrenzung bleibt korrekt.

- **Über-Detektion an stark gekrümmten Wänden möglich** (Cap-Plane-Swing): eine K6-Region kann sich entlang der gebogenen Front leicht überdehnen. Gerade und mässig gekrümmte Wände sind regressionsgetestet korrekt.

- **Vertikale Achse ist auf Welt-Z festgelegt.** Stark geneigte Wände/Fundamente, deren Lokal-Vertikale nicht Welt-Z entspricht, liefern nur näherungsweise Kennwerte.

- **Kronen-/Fundament-Kennwerte mit Flächen-Fallback:** degeneriert die direkte Extent-Messung, wird die Grösse aus Fläche/Länge approximiert (die verwendete Methode steht je Kennwert im JSON-Report).

- **L7-Distanzprüfung läuft asynchron nachgelagert (deferred)** aus Performance-Gründen; bis zum Abschluss ist `scene.distances = null`.

- **Mehrdeutige Erdseite ⇒ Kronen-Quergefälle-Richtung nicht prüfbar:** ohne Terrain/bei unbestimmter Hangseite wird nur der Betrag des Quergefälles geprüft, die Richtung erhält Status `info`.

- **L4-Regelsatz = ASTRA-FHB-Strict-Profil:** zusätzliche Plausibilitätsregeln sind opt-in und standardmässig nicht geladen.
