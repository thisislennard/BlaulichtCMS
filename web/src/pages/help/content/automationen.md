Automationen nehmen Routinearbeit ab: Bei einem **Ereignis** (FE2-Alarm, amtliche Warnung, neuer RSS-Eintrag, neue Uploads, Zeitplan oder Knopfdruck) prüft BlaulichtCMS Bedingungen und legt **Entwürfe** an, fordert **Freigaben** an oder **benachrichtigt** Personen. Veröffentlicht wird – wie sonst auch – erst nach menschlicher Freigabe. Direkt veröffentlichen darf eine Automation nur, wenn die Administration das ausdrücklich erlaubt (siehe [Direktversand](#direktversand-je-automation)).

Eine Automation besteht aus drei Bausteinen:

1. **Eingänge** – *wann* etwas passiert. Eingerichtet unter [Automation → Eingänge](/automationen/eingaenge).
2. **Verarbeitung** – *ob* und *wie*: Bedingungen, Verzweigungen, Textvorlagen, Warten, Entprellen, Freigabe.
3. **Ausgänge** – *was* passiert, samt Gestaltung (Banner-Stil, Beitragsvorlage, E-Mail …). Eingerichtet unter [Automation → Ausgänge](/automationen/ausgaenge).

Im [Editor](/automationen) werden die Bausteine verbunden. Rechte: **Automationen ansehen** (Administration, Redaktion, Freigabe), **Automationen verwalten** und **Automationen direkt veröffentlichen lassen** (beide nur Administration).

## Eingänge

Ein Eingang hört auf eine vorhandene Quelle. Zugangsdaten, Tests und Gebietsfilter bleiben bei der [Verbindung](/hilfe/verbindungen).

| Eingang | Startet bei | Wichtige Felder |
|---|---|---|
| FE2-Alarm / Feuersoftware-Einsatz | neuem Einsatz, Aktualisierung oder Ende (wählbar) | `stichwort`, `stichwort_text`, `einsatzart`, `ort`, `ortsteil`, `alarmzeit`, `einheiten`, `entwurf_link` |
| Amtliche Warnung | neuer Warnung, Aktualisierung oder Entwarnung, wahlweise nur im eigenen Gebiet | `ereignis`, `ueberschrift`, `stufe` (1 gering … 4 extrem), `gebiete`, `gueltig_bis`, `quelle`, `link` |
| RSS-Eintrag | neuem Eintrag beim regelmäßigen Abruf (eine Quelle oder alle) | `titel`, `link`, `zusammenfassung`, `quelle` |
| Neue Uploads | geprüften Dateien über einen Upload-Link, gebündelt je Zeitfenster | `sammlung`, `sammlung_link`, `anzahl` |
| Zeitplan | täglich zu einer Uhrzeit (optional nur an Wochentagen) oder alle N Minuten (mind. 15) | `zeitpunkt`, `offene_beitraege`, `offene_beitraege_liste`, `offene_banner`, `offene_warnentwuerfe` |
| Manueller Start | Knopf „Jetzt starten“ in der Automation | eigene Felder, `gestartet_von` |

Immer verfügbar: `automation`, `lauf`, `jetzt`. Bei FE2 und Feuersoftware gibt es nur die Felder der Allowlist – Straße, Meldende, Patientendaten kommen nie in eine Automation. Bei Uploads werden keine Angaben der Hochladenden übergeben. Verpasste Zeitplan-Termine (Ausfall länger als 10 Minuten) werden nicht nachgeholt; das erste Einlesen einer neuen RSS-Quelle startet keine Läufe.

## Ausgänge

| Ausgang | Wirkung | Direktversand möglich |
|---|---|---|
| Banner | Banner-Entwurf je gewählter Website, wahlweise zur Freigabe eingereicht. Stil fest oder **nach Warnstufe** (1 Hinweis, 2 Warnung, ab 3 Gefahr), Priorität, Dauer oder Ablauf aus `gueltig_bis`, Link nur https | ja |
| Beitrag | Beitragsentwurf (Art, Titel, Text, Kurzfassung, Texte je Kanal, optional Zielkanal), wahlweise eingereicht | ja (braucht Zielkanal) |
| E-Mail | über den eingerichteten Mailserver an **Rollen** (Konten) und/oder **Zuständigkeiten** (externe Adressen) | ja (für Zuständigkeiten) |
| App-Benachrichtigung | an Rollen oder einzelne Personen, optional mit Link in BlaulichtCMS | – (immer sofort) |
| Warnentwurf vorbereiten | Warnentwurf mit vorausgefüllten Feldern; Warnstufe, Freigabe und Versand bleiben bei Menschen | nein |

**E-Mails:** An Konten geht die E-Mail sofort (wie eine Benachrichtigung). An Zuständigkeiten nur nach einer Freigabe auf der Seite [Freigaben](/freigaben) oder mit Direktversand. Ist der **Testmodus** des Mailversands an (Warnentwurf → Pflege), geht alles für Zuständigkeiten nur an das Testpostfach. Freie Adressen gibt es nicht. Alle Empfänger stehen in Blindkopie.

**Webhooks** (Aufrufe fremder Adressen) gibt es bewusst nicht: Sie würden Daten an beliebige Ziele schicken können. Verbindungen nach außen laufen weiter nur über die geprüften [Verbindungen](/hilfe/verbindungen).

Texte der Ausgänge enthalten `{{feld}}`-Platzhalter, z. B. `Einsatz {{stichwort}} in {{ort}}`. Beim Lauf wird nur Text eingesetzt – keine Formeln, kein Code. Fehlende Felder bleiben leer und stehen im Laufprotokoll. Ein geänderter Ausgang wirkt in aktiven Automationen erst nach neuem Test und neuer Aktivierung.

## Verarbeitung

| Baustein | Was er tut |
|---|---|
| Bedingung | Regeln „Feld – Vergleich – Wert“: ist gleich, enthält, beginnt mit, ist eines von (Liste), ist mindestens/höchstens (Zahl), ist ausgefüllt/leer. Mit UND/ODER und einer Ebene Untergruppen. Ausgänge **trifft zu** und **trifft nicht zu** |
| Verzweigung | wählt den Weg nach dem Wert eines Feldes (je Fall ein Ausgang, dazu **sonst**) |
| Felder setzen | legt neue Felder aus Textvorlagen an, z. B. `titel` = `{{stichwort_text}} in {{ort}}` |
| Warten | hält den Lauf an (1 Minute bis 24 Stunden) |
| Einmal je Vorgang | lässt je Schlüssel (z. B. Ort + Stichwort) nur den ersten Lauf im Zeitfenster durch |
| Freigabe anfordern | hält den Lauf an, bis eine Person mit „Fassungen freigeben“ entscheidet; ohne Entscheidung gilt die Anfrage nach der Frist (höchstens 72 h) als abgelehnt. Ausgänge **freigegeben** und **abgelehnt** |
| Zusammenführen | führt Wege wieder zusammen |

Vergleiche ignorieren Groß- und Kleinschreibung. Nach einem Zusammenführen stehen nur Felder zur Verfügung, die auf allen eingehenden Wegen vorhanden sind.

## Editor

- **Fläche:** Bausteine aus der Palette links auf die Fläche ziehen (oder „+“). Den Punkt rechts eines Knotens (Ausgang, z. B. „trifft zu“) mit dem Punkt links des nächsten verbinden. Einen Knoten anklicken öffnet rechts seine Einstellungen.
- **Werkzeugleiste:** Ansicht zurücksetzen, Einpassen, Automatisch anordnen, Auswahl fokussieren, Rückgängig, Wiederholen, Auswahl löschen. Unten links Zoom, unten rechts die Übersichtskarte.
- **Tastatur:** Tab wählt Knoten und Verbindungen, Enter öffnet, Pfeiltasten verschieben, Entf löscht, Strg+Z/Strg+Y macht rückgängig/wiederholt, Strg+S speichert.
- **Liste (Tastatur, Handy):** alle Knoten untereinander mit „verbinden mit …“ je Ausgang – ohne Maus und am Handy vollständig bedienbar.
- **Prüfung:** Fehler stehen am Knoten (roter Rahmen, Anzahl) und in der Karte „Prüfung“ mit „Zum Knoten“: fehlende Anschlüsse, Kreise, Felder, die an dieser Stelle nicht vorhanden sind, Grenzen (höchstens 60 Knoten, 150 Verbindungen).

## Testen, aktivieren, abschalten

1. **Speichern** – der Entwurf ist gespeichert, auch mit Fehlern.
2. **Testlauf** – führt den Entwurf mit Beispieldaten aus (änderbar). Ausgänge beschreiben nur, was sie tun würden: **nichts wird angelegt, veröffentlicht oder gesendet**. Das Ergebnis steht Schritt für Schritt im Protokoll und an den Knoten.
3. **Aktivieren** – nur der zuletzt erfolgreich getestete Stand. Jede Änderung am Ablauf **oder** an einem verwendeten Ein- oder Ausgang verlangt einen neuen Test. Die Aktivierung speichert eine **Version** (Ablauf samt Ein- und Ausgängen); die aktive Version läuft weiter, während der Entwurf bearbeitet wird.
4. **Deaktivieren** – Notbremse: neue Ereignisse starten nichts mehr, wartende Läufe und offene Freigaben werden abgebrochen. Für alle Automationen gibt es den Schalter **Automationen ausführen** unter [Einstellungen → Redaktion](/einstellungen#redaktion).

**Grenzen gegen Fluten:** Je Automation höchstens 20 Läufe pro Minute (einstellbar); darüber werden Ereignisse verworfen und die Verwaltung benachrichtigt. Jedes Ereignis startet je Automation genau einen Lauf; ein Lauf legt nie denselben Entwurf zweimal an – auch nicht nach einem Neustart. Vorübergehende Fehler (z. B. Mailserver nicht erreichbar) werden wiederholt; bei einem abgebrochenen Mailversand mit unklarem Ergebnis wird nie automatisch erneut gesendet.

## Läufe und Protokoll

Unter **Läufe** steht jeder Live- und Testlauf mit Auslöser, Status und Dauer. **Protokoll** zeigt je Schritt Ergebnis, gewählten Weg, Hinweise (z. B. leere Felder) und die Daten. E-Mail-Adressen erscheinen gekürzt (`m…@example.org`). Protokolle werden nach der Frist unter [Einstellungen → Datenschutz](/einstellungen#datenschutz) gelöscht (Standard 30 Tage). Fehlgeschlagene Läufe melden sich als Benachrichtigung bei der Verwaltung.

## Direktversand je Automation

Standardmäßig legen Ausgänge nur Entwürfe an – das Vier-Augen-Prinzip bleibt. Eine Automation kann **„Darf direkt veröffentlichen/versenden“** bekommen. Dann veröffentlichen **nur die im Editor markierten Ausgänge** Banner und Beiträge auf der Website bzw. senden E-Mails an Zuständigkeiten ohne menschliche Freigabe.

Voraussetzungen und Schutz:

- Recht **Automationen direkt veröffentlichen lassen** (nur Administration) für das Markieren, Erlauben und das Aktivieren einer Version mit markierten Ausgängen.
- **Passwortbestätigung** (höchstens 10 Minuten alt) und ein **erfolgreicher Testlauf** des aktuellen Stands.
- Wirksam erst mit einer neu aktivierten Version; die Kennzeichnung **Direktversand** steht in der Liste und im Editor, markierte Knoten tragen **Direkt**.
- Audit-Einträge und eine **Sicherheitsmeldung** an die Administration bei jeder Änderung.
- **Entziehen** (auch ohne das Sonderrecht) oder Deaktivieren wirkt sofort – auch für Läufe, die gerade warten.
- Warnentwürfe werden nie automatisch versendet; soziale Netzwerke bedient keine Automation.

Die automatischen Banner amtlicher Warnungen unter [Verbindungen](/hilfe/verbindungen#automatische-banner-und-pruefliste) funktionieren unabhängig davon wie bisher.

## Export und Import

Abläufe lassen sich als JSON-Datei sichern oder auf eine andere BlaulichtCMS-Instanz übertragen.

- **Exportieren** (Liste der Automationen, Recht *Automationen ansehen*): eine, mehrere oder alle Automationen auswählen (höchstens 50 je Datei). Die Datei enthält Name, Beschreibung und Ablauf. Ein- und Ausgänge stehen darin nur mit **Art und Name** – ohne ihre Einstellungen, ohne Kennungen und ohne Zugangsdaten. Die Markierung **Direkt** wird nie exportiert.
- **Importieren** (Recht *Automationen bearbeiten*): Datei wählen (höchstens 1 MB). BlaulichtCMS prüft Format, Version und jeden Schritt und nennt Fehler verständlich, z. B. „keine Exportdatei“ oder „aus einer neueren BlaulichtCMS-Version“. Die **Vorschau** zeigt, was angelegt wird. Je Ein- und Ausgang aus der Datei einen vorhandenen derselben Art wählen – gleichnamige sind vorgeschlagen – oder **Nicht zuordnen** und später im Editor wählen.
- Importierte Automationen sind immer **Entwürfe**: nicht aktiv, nicht getestet, ohne Direktversand. Ist der Name schon vergeben, wird „(Import)“ angehängt. Vor dem Aktivieren im Editor prüfen und testen.

## Beispiele

### Bei FE2-Alarm mit Stichwort B* einen internen Beitragsentwurf anlegen

1. Eingang **FE2-Alarm** (Verbindung wählen, Vorgang „Neuer Einsatz“).
2. Ausgang **Beitrag**: Art „Einsatz“, Titel `{{stichwort_text}} in {{ort}}`, Text `Alarm um {{alarmzeit}} – {{einheiten}}`, ohne Zielkanal, „Zur Freigabe einreichen“ aus.
3. Im Editor: Eingang → **Bedingung** `stichwort` *beginnt mit* `B` → (trifft zu) → Ausgang. Optional davor **Einmal je Vorgang** mit `ort` + `stichwort`, 60 Minuten.
4. Speichern, Testlauf (Beispiel „B2“), Aktivieren.

### Bei DWD-Unwetterwarnung ab Stufe 3 einen Banner-Entwurf im Stil „Unwetter“ anlegen und die Redaktion benachrichtigen

1. Eingang **Amtliche Warnung** (Warnfeed-Verbindung, „Neue Warnung“, nur eigenes Gebiet).
2. Ausgang **Banner** „Unwetter“: Website wählen, Titel `{{ueberschrift}}`, Text `{{gebiete}} – Details bei der Originalquelle. Quelle: {{quelle}}`, Stil **nach Warnstufe**, Priorität hoch, Ablauf aus `gueltig_bis`, Link `{{link}}`, zur Freigabe einreichen.
3. Ausgang **App-Benachrichtigung**: Rolle Redaktion, Titel `Unwetter: {{ereignis}} – Banner-Entwurf liegt vor`, Link `{{banner_link}}`.
4. Im Editor: Eingang → **Bedingung** `stufe` *ist mindestens* `3` → (trifft zu) → Banner → (danach) → Benachrichtigung.

Für Meldungen nur vom DWD zusätzlich `quelle` *ist gleich* `Deutscher Wetterdienst`.

### Täglich 7 Uhr eine Übersicht der offenen Freigaben per Mail

1. Eingang **Zeitplan**: täglich, 07:00, Montag bis Freitag.
2. Ausgang **E-Mail**: an Rolle „Freigabe“, Betreff `Offene Freigaben: {{offene_beitraege}}`, Text `Beiträge zur Freigabe:\n{{offene_beitraege_liste}}\n\nBanner: {{offene_banner}} · Warnentwürfe: {{offene_warnentwuerfe}}`.
3. Optional dazwischen **Bedingung** `offene_beitraege` *ist mindestens* `1`, damit an ruhigen Tagen keine Mail kommt.
4. Testen, aktivieren. An Konten geht die Mail ohne Freigabe – sie verlässt BlaulichtCMS nur an hinterlegte Adressen.
