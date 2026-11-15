Banner sind kurze, zeitgesteuerte Hinweise oben auf der Website – zum Beispiel zu einer Straßensperrung oder einer Unwetterlage.

## Ein Banner anlegen

1. [Banner](/banner) → **Neues Banner**.
2. Website, Titel, kurzer Text, Art (**Hinweis**, **Warnung**, **Gefahr**), Priorität, Start und **Ablauf** festlegen, optional einen Link.
3. Die Vorschau zeigt das Banner in den Farben der Website.
4. **Zur Freigabe einreichen** → eine berechtigte Person **gibt frei** → **Auf Website veröffentlichen**.

Wie bei Beiträgen gilt die Freigabe für genau eine Fassung. Freigeben lässt sich nur ein eingereichtes Banner; jede Änderung setzt es auf Entwurf zurück und braucht eine neue Einreichung und Freigabe.

## Mehrere Banner

Mehrere Banner können gleichzeitig aktiv sein. Oben steht die höchste Priorität, bei gleicher Priorität das neueste.

## Ablauf – auch ohne Verbindung

Die Website blendet ein Banner zum Ablaufzeitpunkt **selbst** aus, auch wenn BlaulichtCMS gerade nicht erreichbar ist. Bei einem Seitencache sorgt ein kleines Skript dafür, dass ein bereits zwischengespeichertes Banner im Browser verschwindet; zusätzlich leert die Bridge gängige Caches zu Start und Ende.

**Jetzt beenden** nimmt ein Banner sofort von der Website – dafür ist keine Freigabe nötig.

Wird die Kopplung gelöst (in WordPress „Kopplung lösen“) oder der Schlüssel in BlaulichtCMS widerrufen, entfernt die Bridge alle Banner von der Website. Ohne Kopplung kämen Beenden oder Entwarnung dort nicht mehr an.

## Platzierung in WordPress

| Weg | Wie |
|---|---|
| Automatisch | am Seitenanfang (in den Bridge-Einstellungen abschaltbar) |
| Shortcode | `[blaulichtcms_banner]` |
| Block | „BlaulichtCMS: Hinweise“ |
| Einsatzübersicht | `[blaulichtcms_einsaetze anzahl="10"]` oder Block „BlaulichtCMS: Einsatzübersicht“ |
