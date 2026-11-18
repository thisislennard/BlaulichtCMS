Das Dashboard zeigt, was gerade wichtig ist. Oben steht eine Reihe **Kennzahlen** (zum Beispiel Verbindungsfehler, Dienste, Termine heute), darunter die **Kacheln** in Spalten – etwa Redaktionsfluss, Meine Entwürfe, Freigaben, Nächste Termine, Meine Presseanfragen, Warnungen, Einsatzliste, Workflows mit Fehlern, der **bestätigte** Stand der Veröffentlichungen und Websites. Jede Kachel nennt unter dem Titel, wie viele Vorgänge sie enthält. Ein Klick auf eine Kennzahl oder einen Eintrag führt zur passenden Seite.

Angezeigt wird nur, wofür das eigene Konto die Berechtigung hat. Die Kennzahl „Verbindungsfehler“ sieht zum Beispiel nur, wer Verbindungen verwalten darf. Auch die Zeile unter der Begrüßung zählt nur, was du selbst erledigen darfst: Freigaben nur mit Freigaberecht, ungesichtete Dateien nur mit Sichtungsrecht, überschrittene Fristen nur bei deinen eigenen Presseanfragen.

## Standardansicht je Rolle

Wer das Dashboard nicht selbst angepasst hat, sieht die mitgelieferte Ansicht seiner Rolle. Bei mehreren Rollen gilt die erste passende; eigene Rollen bekommen die Ansicht, die zu ihren Rechten passt (zum Beispiel nur Presse-Rechte → Presse).

| Rolle | Kennzahlen | Kacheln |
|---|---|---|
| Administration | Verbindungsfehler, Dienste | BlaulichtCMS startklar, Freigaben, Workflows mit Fehlern, Websites |
| Redaktion | – | Redaktionsfluss, Meine Entwürfe, Nächste Termine, Meine Presseanfragen |
| Medienverwaltung | Ungesichtete Dateien | Neue Uploads, Nächste Termine |
| Freigabe | – | Freigaben, Bereit zur Veröffentlichung, Veröffentlichungen |
| Veröffentlichung | Aktive Banner | Bereit zur Veröffentlichung, Veröffentlichungen, Websites, Einsatzliste |
| Warnentwurf, Warnfreigabe, Warnversand | – | Warnungen (vorn steht, was die Rolle tun kann: Entwürfe, zur Freigabe, zu versenden) |
| Lesezugriff | – | Veröffentlichungen, Nächste Termine |
| Presse (eigene Rolle mit Presse-Rechten) | – | Meine Presseanfragen, Nächste Termine, Veröffentlichungen |

Jeder Sachverhalt steht in der Standardansicht nur einmal: Der Redaktionsfluss enthält schon Eingang, Sichtung, Freigabe, Bereit und Veröffentlicht – dazu kommen keine Einzelkacheln oder Kennzahlen zum selben Thema. Kacheln für Bereiche, die noch nicht genutzt werden (keine Website gekoppelt, keine Quelle, kein Termin, keine Presseanfrage, kein Workflow, keine Verbindung), fehlen in der Standardansicht und erscheinen von selbst, sobald es dort etwas gibt. Unter **Anpassen → Widgets hinzufügen** stehen sie trotzdem zur Wahl.

### Die Kacheln

- **Meine Entwürfe:** eigene Beiträge, die noch nicht eingereicht oder zurückgewiesen sind.
- **Nächste Termine:** Termine der nächsten 7 Tage, dazu Fristen von Presseanfragen und geplante Beiträge (je nach Berechtigung). Überschrittene Fristen bleiben stehen.
- **Meine Presseanfragen:** dir zugewiesene offene Anfragen, überfällige zuerst, dazu die Zahl der Anfragen ohne Zuständigkeit.
- **Warnungen:** offene Warnentwürfe (noch nicht versandt) und gültige amtliche Warnungen.
- **Einsatzliste:** Einträge mit Übertragungsfehler, zur Freigabe und freigegeben, aber noch nicht veröffentlicht.
- **Workflows mit Fehlern:** Workflows mit fehlgeschlagenen Läufen der letzten 7 Tage (Testläufe zählen nicht). Wartende Freigaben in Workflows stehen bei den Freigaben.
- **BlaulichtCMS startklar:** die Checkliste für die Administration, siehe unten.

## BlaulichtCMS startklar

Die Administration sieht nach der Installation oben die Kachel **BlaulichtCMS startklar**. Sie zeigt, was vor dem Echtbetrieb eingerichtet sein sollte, und erkennt den Stand selbst – ohne Abhaken:

| Punkt | Gilt als erledigt, wenn … |
|---|---|
| Organisation und Zeitzone (Pflicht) | der Name der Organisation eingetragen ist |
| Öffentliche Adresse (HTTPS) und Reverse Proxy (Pflicht) | die öffentliche Adresse mit HTTPS eingetragen ist und der Reverse Proxy in `TRUSTED_PROXIES` steht |
| Verantwortliche Stelle, Datenschutzerklärung und Impressum (Pflicht) | alle drei Angaben für die öffentlichen Upload-Seiten vorhanden sind |
| E-Mail-Versand einrichten und Testmail senden (Pflicht) | mit genau den gespeicherten Angaben (SMTP oder Microsoft 365) eine Testmail geklappt hat |
| Bundesland für das Stichwortverzeichnis (Pflicht) | ein Bundesland oder „Eigene Liste“ gewählt ist |
| Sicherung außer Haus und erste Probe-Wiederherstellung (Pflicht) | Sicherungen außer Haus übertragen werden und eine Probe-Wiederherstellung bestanden ist |
| Kolleginnen und Kollegen einladen (empfohlen) | es mindestens zwei Konten gibt |
| Update-Helfer am Host einrichten (empfohlen) | der Update-Helfer am Host eingerichtet ist |
| Zwei-Faktor-Anmeldung für alle (empfohlen) | Zwei-Faktor für alle vorgeschrieben ist oder alle aktiven Konten sie nutzen |
| Website koppeln (optional) | eine Website gekoppelt ist und sich meldet |
| Testbeitrag durchspielen (optional) | mindestens ein Beitrag freigegeben wurde |

Jeder offene Punkt führt mit einem Link direkt an die richtige Stelle. Was dort gespeichert wird, erkennt die Kachel beim nächsten Abruf – spätestens, wenn du zum Dashboard zurückkehrst. Offene Punkte lassen sich einzeln mit **×** ausblenden; sind alle Pflichtpunkte erledigt, auch der Rest auf einmal. Ausgeblendet wird für alle in der Administration. Sind alle Punkte erledigt oder ausgeblendet, verschwindet die Kachel – wird ein erledigter Punkt später wieder offen (zum Beispiel nach einem Wechsel des Mailservers ohne neue Testmail), erscheint sie von selbst wieder. Ausgeblendete Punkte zeigt [Einstellungen → Organisation](/einstellungen/organisation#startklar) unter **Checkliste „BlaulichtCMS startklar“** wieder an.

Jeder Punkt erscheint nur, wenn du ihn mit deinen Rechten auch erledigen kannst.

## Begrüßung neuer Konten

Neu angelegte Konten sehen nach der ersten Anmeldung einmal eine Karte mit drei ersten Schritten ihrer Rolle (zum Beispiel Redaktion: Fotos sammeln → sichten → Beitrag einreichen; Freigabe: Freigaben prüfen; Presse: Anfragen bearbeiten), einen Link ins passende Hilfe-Kapitel sowie **App installieren** und **Push einschalten**. **Verstanden** blendet die Karte dauerhaft aus. Konten, die es vor der Einführung der Karte schon gab, sehen sie nicht.

## Anpassen

1. **Anpassen** oben rechts. Ab jetzt wird nichts gespeichert, bis du **Für mich speichern** wählst.
2. **Verschieben:** am Griff (sechs Punkte) ziehen – mit der Maus oder mit dem Finger. Kacheln lassen sich innerhalb einer Spalte und in eine andere Spalte ziehen, Kennzahlen innerhalb ihrer Reihe, ganze Spalten nach links und rechts. Links und Schaltflächen in den Kacheln bleiben dabei bedienbar.
3. **Spalten:** je Spalte die Breite **Schmal**, **Normal** oder **Breit** wählen. **Spalte hinzufügen** legt eine weitere an (höchstens vier). Eine leere Spalte lässt sich mit dem Papierkorb löschen.
4. **Ein- und ausblenden:** das durchgestrichene Auge an einer Kachel oder Kennzahl blendet sie aus. Unter **Widgets hinzufügen** stehen alle ausgeblendeten zum Wiedereinblenden.
5. **Für mich speichern** übernimmt alles auf einmal. **Abbrechen** stellt genau den Stand von vorher wieder her.
6. **Standard wiederherstellen** hebt die eigene Anpassung auf: Dann gilt wieder die Dashboard-Vorlage der Administration bzw. die Standardansicht der Rolle.

### Mit der Tastatur

Mit der Tabulatortaste zum Griff, dann **Leertaste** oder **Eingabetaste** drücken, mit den **Pfeiltasten** verschieben und mit **Leertaste** oder **Eingabetaste** ablegen. **Escape** bricht das Verschieben ab.

### Auf dem Handy

Auf schmalen Bildschirmen stehen die Kennzahlen oben und die Kacheln untereinander. Welche Kacheln dort erscheinen und in welcher Reihenfolge, legst du beim Anpassen unter **Reihenfolge auf dem Handy** fest – unabhängig von den Spalten am großen Bildschirm.

## Vorlagen

Die Administration kann ein Dashboard als **Dashboard-Vorlage für alle oder für eine Rolle** speichern (beim Anpassen unter **Dashboard-Vorlage**) und dort auch wieder entfernen. Eine Dashboard-Vorlage gilt für alle, die ihr Dashboard nicht selbst angepasst haben, und hat Vorrang vor der mitgelieferten Standardansicht der Rolle; jede Person sieht daraus nur die Widgets, für die sie die Berechtigung hat. Eine persönliche Anpassung hat Vorrang – **Standard wiederherstellen** hebt sie auf.

Dashboards, die vor Version 0.2.4 angepasst wurden, werden automatisch in die Spalten übernommen: breite Kacheln stehen links in einer breiten Spalte, die übrigen daneben.

## Live-Status

Oben rechts zeigt **Live**, dass Änderungen sofort ankommen. Bei **Unterbrochen** zeigt BlaulichtCMS den zuletzt bestätigten Stand und lädt nach der Wiederverbindung automatisch neu. Status wie „Veröffentlicht“ erscheinen erst, wenn die Website sie bestätigt hat.
