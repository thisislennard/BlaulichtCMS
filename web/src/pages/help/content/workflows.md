## Überblick

Unter [Workflows](/workflows) seht ihr alle Abläufe mit Status, letzter Ausführung und Erfolgsquote der letzten 30 Tage. Neue Workflows legt ihr **leer**, **aus einer Vorlage** ([Workflow-Vorlagen](/vorlagen)) oder per **Import** an.

Ein Workflow hat immer:

- genau **einen Trigger** (den Auslöser),
- mindestens **einen weiteren Baustein**,
- Linien, die alle Bausteine mit dem Trigger verbinden.

Schleifen sind nicht erlaubt, und pro Workflow sind höchstens 200 Bausteine möglich.

## Der Editor

Der Editor hat drei Bereiche:

| Bereich | Was ihr dort macht |
|---|---|
| **Palette** (links) | Alle Bausteine nach Kategorien: Trigger, Bedingungen, Datenverarbeitung, Aktionen, Steuerung. Mit `kbd:/` springt ihr in die Suche. |
| **Arbeitsfläche** (Mitte) | Bausteine anordnen und verbinden. Zoomen mit Mausrad, verschieben durch Ziehen der freien Fläche. Unten links: Rückgängig, Wiederholen, Zoom, Einpassen, automatisch anordnen. |
| **Einstellungen** (rechts) | Erscheint, wenn ihr einen Baustein anklickt. Reiter **Parameter**, **Einstellungen** und **Ausgabe**. |

### Bausteine hinzufügen und verbinden

1. Zieht einen Baustein aus der Palette auf die Arbeitsfläche.
2. Zieht vom **Ausgang** (Punkt rechts) eines Bausteins eine Linie zum **Eingang** (Punkt links) des nächsten.
3. Bedingungen haben mehrere Ausgänge, z. B. „Wahr“ und „Falsch“. Verbindet jeden Ausgang mit dem Baustein, der in diesem Fall folgen soll. Ein Ausgang ohne Linie bedeutet: Hier endet der Lauf.

Mehrere Bausteine wählt ihr mit `kbd:Umschalt` + Klick aus. Kopieren, Einfügen und Löschen funktionieren mit den üblichen Tastenkürzeln – siehe [Tastenkürzel](/hilfe/tastatur).

### Parameter

Hier legt ihr fest, was der Baustein tun soll: Empfänger, Texte, Bedingungen und die **Verbindung** (z. B. welcher Mailserver). Felder mit Variablen haben einen Knopf `{ }`, der den Variablen-Picker öffnet. Selten gebrauchte Felder stehen unter **Erweiterte Optionen**.

Jeder Baustein hat einen **Variablennamen** (z. B. `alamos`, `mail`, `pruefung`). Darüber greifen spätere Bausteine auf seine Ergebnisse zu: `{{ pruefung.status }}`. Erlaubt sind Kleinbuchstaben, Ziffern und `_`; die Namen `trigger`, `run`, `now` und `env` sind reserviert. Siehe [Variablen & Ausdrücke](/hilfe/variablen).

### Einstellungen eines Bausteins

| Einstellung | Bedeutung | Standard |
|---|---|---|
| **Wiederholungen** | Wie oft LifeLink es bei vorübergehenden Fehlern erneut versucht (0–10). | 3 |
| **Wartezeit** | Grundwartezeit vor dem ersten neuen Versuch; sie verdoppelt sich bei jedem weiteren Versuch. | 5 Sekunden |
| **Zeitlimit** | Wie lange ein einzelner Versuch dauern darf (1–300 Sekunden). | 30 Sekunden |
| **Bei Fehler** | **Anhalten**: Der Lauf endet als Fehler. **Fortsetzen**: Der Baustein bekommt einen zusätzlichen Ausgang **Fehler**, über den es weitergeht. | Anhalten |

Mit **Fortsetzen** baut ihr Ausweichwege, z. B. „Wenn die Website nicht antwortet, eine Teams-Nachricht schicken“. Im Fehlerfall steht im Baustein dann `{{ name.fehler.meldung }}` und `{{ name.fehler.klasse }}` bereit.

Einen Baustein könnt ihr außerdem **deaktivieren**. Er wird dann übersprungen – praktisch, um etwas vorübergehend abzuschalten, ohne es zu löschen.

### Automatisches Speichern

Jede Änderung wird nach kurzer Zeit automatisch als **Entwurf** gespeichert. Oben steht „Gespeichert · vN“. Der Entwurf wirkt nicht auf laufende Einsätze – erst das Veröffentlichen macht ihn zur aktiven Version.

Arbeiten zwei Personen gleichzeitig am selben Workflow, verhindert LifeLink, dass sie sich gegenseitig überschreiben. Die zweite Person sieht dann „Der Entwurf wurde inzwischen von … geändert. Bitte neu laden.“

## Veröffentlichen

1. Klickt auf **Veröffentlichen**.
2. LifeLink prüft den Workflow. Fehlt etwas (z. B. ein Pflichtfeld oder eine Verbindung), werden die Bausteine markiert und die Probleme aufgelistet.
3. Die **Vorschau** zeigt:
   - den Trigger,
   - alle verwendeten Datenfelder,
   - alle Aktionen mit ihren Zielen (Empfänger, Zielseiten, Adressen) und ob sie automatisch wiederholt werden,
   - die genutzten Verbindungen,
   - die Änderungen gegenüber der aktiven Version,
   - bei Zeitplänen den nächsten Termin.
4. Schreibt eine kurze **Änderungsnotiz** („Stichwort-Filter um TH ergänzt“). Mit **Nach Veröffentlichung aktivieren** reagiert der Trigger sofort auf neue Ereignisse. Dann bestätigen.

Es entsteht eine neue, unveränderliche **Version** (v1, v2, …). Sie wird sofort aktiv, wenn ihr das Recht „Aktivieren & veröffentlichen“ habt und keine Vier-Augen-Freigabe eingeschaltet ist. Sonst heißt der Knopf **Freigabe anfordern**. Ist nichts geändert, lehnt LifeLink das Veröffentlichen ab.

## Vier-Augen-Freigabe

Ist in den [Einstellungen](/einstellungen) die Vier-Augen-Freigabe eingeschaltet – oder fehlt euch das Recht zum Veröffentlichen –, wird die neue Version **„wartet auf Freigabe“** gestellt:

1. Alle Personen mit dem Recht **Freigeben** bekommen eine Benachrichtigung.
2. Sie sehen sich die Änderungen an und **geben frei** oder **lehnen ab** (mit Kommentar).
3. Die eigene Änderung kann man nicht selbst freigeben.
4. Ihr bekommt eine Benachrichtigung mit dem Ergebnis.

Wird eine weitere Version eingereicht, solange eine ältere noch wartet, wird die ältere automatisch verworfen. Es wartet also immer nur die neueste.

## Aktivieren und Deaktivieren

- **Aktiv**: Der Trigger nimmt Ereignisse an, Zeitpläne laufen.
- **Inaktiv**: Nichts startet. Webhooks antworten mit `409 Workflow ist nicht aktiv`.
- **Archiviert**: Wie inaktiv, zusätzlich aus der Liste ausgeblendet und nicht mehr veröffentlichbar.

Aktivieren geht erst, wenn es eine veröffentlichte Version gibt. Dafür braucht ihr das Recht „Aktivieren & veröffentlichen“.

## Versionen und Rollback

Unter **Versionen** seht ihr alle Stände mit Nummer, Notiz, wer sie eingereicht und wer sie freigegeben hat. Ihr könnt jede Version ansehen und mit der aktiven Version oder dem Entwurf vergleichen.

**Zurückrollen**: Wählt eine frühere Version und klickt auf **Diese Version wiederherstellen**. Sie wird sofort wieder aktiv, und der Entwurf wird auf diesen Stand gesetzt. Das ist der schnellste Weg, wenn nach einer Änderung etwas nicht mehr funktioniert – zum Beispiel mitten in einer Einsatznacht.

## Manuell ausführen

Workflows mit dem Trigger **Manuell starten** startet ihr unter [Workflows](/workflows): Workflow auswählen und im Detailbereich **Jetzt starten** klicken. Optional gebt ihr dort Daten als JSON mit; ohne Daten werden die Beispieldaten des Triggers verwendet. Das geht nur bei aktiven Workflows und mit dem Recht „Aktivieren & veröffentlichen“ – und es ist ein echter Lauf, Aktionen werden wirklich ausgeführt. Aus Skripten (z. B. auf dem Wachen-PC) geht dasselbe über die [LifeLink-API](/hilfe/api#beispiel-workflow-starten). Im Editor probiert ihr solche Workflows gefahrlos mit **Testen** aus. Alle anderen Workflows starten ausschließlich über ihren Trigger.

## Duplizieren, Exportieren, Importieren

- **Duplizieren** legt eine Kopie des Entwurfs an („Name (Kopie)“), z. B. als Ausgangspunkt für eine Nachbarwehr.
- **Exportieren** lädt den Entwurf als JSON-Datei herunter. Die Datei enthält **keine Geheimnisse**: Verbindungen stehen darin nur als Verweis.
- **Importieren** legt aus so einer Datei einen neuen Workflow an. Verweise auf Verbindungen bleiben nur erhalten, wenn es genau diese Verbindung in eurer LifeLink-Instanz gibt. Sonst wählt ihr die Verbindung im Editor neu aus.

## Löschen

Löschen ist endgültig: Workflow, Versionen und Webhook-Adressen sind danach weg. Zur Bestätigung tippt ihr den Namen des Workflows ein. Wollt ihr nur aufräumen, ist **Archivieren** meist die bessere Wahl.
