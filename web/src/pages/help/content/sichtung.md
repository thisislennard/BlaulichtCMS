In der Sichtung entscheidet die Redaktion, welche Dateien verwendet werden. **Auswahl und Veröffentlichung sind getrennte Schritte:** Ausgewählte Dateien sind noch nicht öffentlich.

## Datei für Datei sichten

1. Sammlung öffnen und auf **„… sichten“** klicken. Gibt es schon gesichtete Dateien, fragt BlaulichtCMS, womit es losgehen soll: **Offene fortsetzen**, **Alle erneut durchsehen**, **Nur ausgewählte** oder – falls vorhanden – **Zurückgestellte**.
2. Große Vorschau, darunter Name, Größe, Eingang und Hinweis. Unter **Infos bearbeiten** lassen sich Anzeigename und Beschreibung direkt ergänzen.
3. **Auswählen** oder **Überspringen** – beide Buttons sind gleichwertig. **Zurückstellen** merkt eine Datei für später vor.

| Gerät | Auswählen | Überspringen |
|---|---|---|
| Tastatur | Pfeil rechts → | Pfeil links ← |
| Handy | nach rechts wischen | nach links wischen |
| Maus | Button „Auswählen“ | Button „Überspringen“ |

Zurückstellen: Pfeil nach unten ↓ oder der Button „Zurückstellen“.

Sichten mehrere Personen gleichzeitig, gewinnt nicht einfach die letzte Entscheidung: Hat jemand eine Datei inzwischen anders gesichtet, meldet BlaulichtCMS „Bereits anders gesichtet“ (mit Namen) und lässt die frühere Entscheidung stehen.

## Übersicht

Die Reiter zeigen **Zu sichten**, **Ausgewählt**, **Zurückgestellt** (sobald es solche Dateien gibt), **Alle** und **In Prüfung / abgewiesen**. Bei abgewiesenen Dateien steht der Grund dabei (z. B. „Dateiformat nicht erlaubt“).

- **Kacheln oder Liste:** Umschalter rechts über den Dateien; dazu 48, 96 oder 192 Dateien je Seite. Beides merkt sich das Gerät.
- **Großansicht:** Klick auf eine Vorschau öffnet sie groß – mit Pfeilen, Wischen oder Tastatur (← →) blättern, Videos laufen im Player.
- **Details:** Menü der Datei → **Details** zeigt Anzeigename, Beschreibung und interne Notiz (bearbeitbar mit „Medien verwalten“), Originalname, Typ, Prüfsumme (SHA-256), Eingang samt Upload-Link und Vorgangsnummer, wer wann gesichtet hat und in welchen Beiträgen die Datei steckt. Anzeigename und Beschreibung sind nur intern; die öffentliche Fassung behält ihren neutralen Dateinamen.
- **Duplikate:** Hat eine Datei denselben Inhalt wie eine ältere (gleiche Prüfsumme, auch in einer anderen Sammlung), trägt sie den Hinweis **Duplikat**; die Details verweisen auf die ältere Datei. Gelöscht wird nichts automatisch.
- **Mehrfachauswahl:** Mit den Kästchen auf den Kacheln (oder „Alle auf dieser Seite markieren“) mehrere Dateien markieren. Die Leiste darüber bietet **Auswählen**, **Überspringen**, **Zurückstellen**, **Zurücksetzen**, **ZIP** und **Löschen** für alle markierten auf einmal. Steckt eine markierte Datei in einem laufenden Beitrag, lehnt BlaulichtCMS das Löschen für die ganze Auswahl ab und nennt den Beitrag.

## Personen und sensible Inhalte

Einsatzfotos zeigen oft Verletzte, Betroffene, Unbeteiligte oder Kennzeichen. Gesundheitsangaben gehören zu den besonders geschützten Daten (Art. 9 DSGVO); für erkennbare Personen gilt das Recht am eigenen Bild (Kunsturhebergesetz).

- **Markieren:** In der Sichtung unter „Hinweise zur Datei“ **Personen erkennbar**, **Verletzte / Gesundheit**, **Kennzeichen / Adressen** oder **Sonstiger sensibler Inhalt** antippen. Markierte Dateien tragen ein Kennzeichen in der Übersicht und im Beitrag; ihre Freigabe verlangt eine bestätigte Datenschutz-Prüfung (siehe Freigabe).
- **Unkenntlich machen (Bilder):** Menü der Datei → **Datenschutz und Unkenntlichmachen**. Rechteck über Gesichter, Kennzeichen oder Schilder ziehen; je Bereich **Verpixeln**, **Weichzeichnen** oder **Schwarz abdecken**. **Zuschneiden** wählt den Ausschnitt, der veröffentlicht wird. Nach dem Speichern entsteht eine neue öffentliche Fassung (Website, soziale Kanäle, ZIP); das **Original bleibt unverändert** und intern.
- **Videos:** **Ohne Ton veröffentlichen** entfernt die Tonspur aus der öffentlichen Fassung (Stimmen, Funkverkehr). Bereiche in Videos lassen sich in BlaulichtCMS nicht unkenntlich machen – solche Videos nicht verwenden oder vorher mit einem Schnittprogramm bearbeiten.
- Für HEIC-Dateien gibt es keine öffentliche Fassung; nur Markierungen sind möglich.
- Gehört eine Datei zu einer freigegebenen Fassung, lässt sich ihre öffentliche Fassung nicht mehr ändern – zuerst die Freigabe zurückziehen.
- War ein Beitrag schon veröffentlicht: Nach dem Unkenntlichmachen und erneuter Freigabe lädt die Website die neue Fassung und entfernt die alte aus ihrer Mediathek. Auf Facebook oder Instagram bereits veröffentlichte Bilder ändern sich nicht – dort löschen bzw. den Beitrag zurückziehen.

Im Zweifel: nicht veröffentlichen oder unkenntlich machen. Lieber ein Bild mit Einsatzfahrzeugen als eines mit erkennbaren Betroffenen.

## Herunterladen

Über das Menü einer Datei: **Original herunterladen** (volle Qualität, nur intern) oder **Öffentliche Fassung herunterladen** (ohne Standortdaten, mit neutralem Dateinamen aus der Medien-ID – der Originalname des Uploads kann Namen oder Orte enthalten und bleibt nur beim Original erhalten). Downloads von Originalen werden protokolliert.

**Sammeldownload (ZIP):** Über **Herunterladen** in der Sammlung entsteht im Hintergrund ein ZIP, das 24 Stunden bereitliegt. Die öffentliche Fassung darf jede Person mit Zugriff auf Medien anfordern. **Originale** gibt es – wie beim Einzeldownload – nur mit dem Recht „Medien verwalten“; das wird beim Anlegen und beim Herunterladen geprüft. Ein ZIP laden kann nur, wer es angelegt hat, oder eine Person mit „Medien verwalten“.

## Standortdaten im Original

Mit der Einstellung **Standortdaten auch aus Originalen entfernen** (Verwaltung → Einstellungen → Medien, Standard: an) bereinigt BlaulichtCMS nach der Prüfung auch das Original – erst nachdem Vorschau und öffentliche Fassung erzeugt sind:

- **Entfernt:** GPS-Angaben, Seriennummern von Kamera und Objektiv, Name der Besitzerin bzw. des Besitzers, Autorfelder, eindeutige Bild-ID, Kommentare, herstellerspezifische Zusatzdaten (MakerNotes), XMP- und IPTC-Angaben (können Orte und Namen enthalten). Bei Videos alle Metadaten, Kapitel sowie Daten- und Untertitelspuren (z. B. GPS-Aufzeichnung von Action-Kameras).
- **Bleibt erhalten:** die Bild- bzw. Video- und Tondaten selbst (verlustfrei, nicht neu kodiert), Kamerahersteller und -modell, Aufnahmezeit, Belichtungsdaten, Ausrichtung, Copyright-Vermerk und das kleine EXIF-Vorschaubild.
- Bei **HEIC** wird an Ort und Stelle bereinigt (ohne Umrechnung); erkannte Standortdaten erscheinen danach als „beim Upload enthalten“.
- Ältere Originale bereinigt der Hintergrunddienst nach und nach, sobald die Einstellung an ist. Entfernte Angaben lassen sich **nicht wiederherstellen**. Ist die Einstellung aus, bleiben Originale unverändert.

Größe und Prüfsumme in der Übersicht beziehen sich auf die hochgeladene Datei.

## In den Beitrag übernehmen

Im Beitrag unter „Medien“ → **Medien übernehmen**. Standardmäßig werden nur ausgewählte Dateien angeboten. Reihenfolge und Titelbild lassen sich im Beitrag festlegen.
