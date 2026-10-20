# Lager Scanner

Lager-App fürs Handy-Browser: Barcodes mit der Kamera scannen, einbuchen, für Aufträge entnehmen, Bedarfslisten gegen den Bestand prüfen – und alles in einer formatierten Excel-Datei.

## Funktionen

- **Scannen:** Die Kamera liest Barcodes. Ein Teil zählt erneut, sobald sein Barcode einmal aus dem Bild war – ein ruhig gehaltener Karton zählt einmal, 24 nacheinander gezeigte Lampen zählen 24-mal. Handscanner (USB/Bluetooth), Foto oder getippte EAN gehen auch. Prüfziffern werden kontrolliert.
- **Korb:** Scans sammeln sich im Korb, Mengen lassen sich ändern, dann alles zusammen einbuchen oder für einen Auftrag entnehmen. Beim Entnehmen zeigt die App, was übrig bleibt, und warnt, bevor der Bestand unter null fällt.
- **Neue Produkte:** Beim ersten Scan wird das Etikett auf dem Gerät gelesen (Tesseract). Claude Haiku recherchiert die Produkte dann per Websuche (Hersteller, Serie, Kategorie, Variante, Artikelnummer) – einzeln sofort oder in Paketen von 5/10/20, und sofort, wenn ein Etikett unlesbar ist. Gleiche Produkte unter zwei Barcodes werden gemeldet und auf Wunsch zusammengeführt.
- **Ohne Barcode:** Foto machen, Anzahl eingeben. Claude liest Typnummern vom Gerät, erkennt bekannte Produkte wieder oder legt ein neues mit eigenem Code an (z.B. `T-FINDER-40-52-9-024`). Für den Code gibt es ein QR-Etikett zum Ausdrucken.
- **Bedarf:** Bedarfsliste anlegen („20 Steckdosen“, „10 Doppelrahmen“, „3 Dimmer“). Die App ordnet Positionen dem Bestand zu (oder Claude macht das), zeigt pro Position was da ist und was fehlt, und erstellt die Bestellliste. „Vorhandenes entnehmen“ legt alles Vorhandene in den Korb.
- **Verlauf:** Jede Buchung bleibt erhalten; Stornieren fügt eine Gegenbuchung hinzu.
- **Excel:** Übersicht, Bestand (nach Kategorien), Bedarf, Bestellliste, Buchungen, Aufträge – formatiert, gefiltert, mit Formeln. Am PC (Chrome/Edge) hält die App eine verknüpfte Datei nach jeder Änderung automatisch aktuell; am Handy speichern oder teilen (OneDrive, Drive). Die Datei lässt sich wieder laden, auch nach Änderungen in Excel.

Die Daten liegen im Browser auf dem Gerät (IndexedDB). Die Excel-Datei ist Lagerbuch und Sicherung zugleich.

Claude-Funktionen brauchen einen eigenen Anthropic-API-Schlüssel (Einstellungen). Er bleibt auf dem Gerät und geht nur an Anthropic.

## Entwicklung

```bash
npm install
npm run dev          # lokaler Server
npm test             # Unit-Tests
npx playwright install chromium
npm run test:e2e     # Browser-Tests (Fake-Kamera, simulierte Claude-API, echtes OCR)
```

Ein Push auf `main` lässt alle Tests laufen und veröffentlicht den Build auf dem Branch `gh-pages` (GitHub Pages).
