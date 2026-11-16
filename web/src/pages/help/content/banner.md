Banner sind kurze, zeitgesteuerte Hinweise oben auf der Website – zum Beispiel zu einer Straßensperrung oder einer Unwetterlage.

## Ein Banner anlegen

1. [Banner](/banner) → **Neues Banner**.
2. Website, Titel, kurzer Text, **Schweregrad** (**Hinweis**, **Warnung**, **Gefahr**), Priorität, **Darstellung**, Start und **Ablauf** festlegen, optional einen Link.
3. Die Vorschau zeigt das Banner in den Standardfarben der Bridge. Die tatsächlichen Farben stellt die Website ein (siehe unten).
4. **Zur Freigabe einreichen** → eine berechtigte Person **gibt frei** → **Auf Website veröffentlichen**.

Wie bei Beiträgen gilt die Freigabe für genau eine Fassung. Freigeben lässt sich nur ein eingereichtes Banner; jede Änderung setzt es auf Entwurf zurück und braucht eine neue Einreichung und Freigabe.

## Schweregrad, Farbe und Darstellung

Der **Schweregrad** (Hinweis, Warnung, Gefahr) bestimmt, wie ein Hinweis auf der Website aussieht und erscheint. Eingestellt wird das **auf der Website** in WordPress unter **Einstellungen → BlaulichtCMS Bridge → Darstellung der Hinweise** – je Schweregrad:

| Einstellung | Möglichkeiten |
|---|---|
| Farbe | frei wählbar (Farbwähler, mit Vorschau). Die Schrift auf der Farbe wird automatisch hell oder dunkel, damit sie lesbar bleibt. |
| Darstellung | **Banner** – am Seitenanfang bzw. über Shortcode oder Block, solange der Hinweis gilt. **Popup** – Dialog beim Aufruf der Seite. **Banner und Popup** – beides. |

Vorgabe: Hinweis und Warnung als Banner, Gefahr als Banner und Popup. „Gefahr“ erscheint als Banner vollflächig in der gewählten Farbe.

Das **Popup** ist ein Dialog, der den Rest der Seite abdunkelt. Er lässt sich mit **Verstanden**, dem Schließen-Knopf oder der Esc-Taste schließen; die Tastatur bleibt im Dialog, solange er offen ist. Wer ein Popup geschlossen hat, sieht diesen Hinweis im selben Browser nicht erneut – erst wieder, wenn eine neue Fassung veröffentlicht wird.

Für einen einzelnen Hinweis lässt sich die Darstellung in BlaulichtCMS fest wählen (**Nur Banner**, **Nur Popup**, **Banner und Popup**). Die Vorgabe **Nach Schweregrad** folgt der Einstellung der Website. Welche Darstellung eine Website je Schweregrad eingestellt hat, zeigt der Dialog unter „Darstellung“ und die Website-Karte unter [Websites](/kanaele) (ab Bridge 0.8.0).

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
| Popup | am Seitenende als Dialog, sobald ein Schweregrad oder der Hinweis auf „Popup“ steht |
| Shortcode | `[blaulichtcms_banner]` |
| Block | „BlaulichtCMS: Hinweise“ |
| Einsatzübersicht | `[blaulichtcms_einsaetze anzahl="10"]` oder Block „BlaulichtCMS: Einsatzübersicht“ |
