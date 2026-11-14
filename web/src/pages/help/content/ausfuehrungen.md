Jeder Start eines Workflows ist ein **Lauf** mit eigener Nummer (z. B. #1042). Im [Ausführungsverlauf](/ausfuehrungen) seht ihr jeden Lauf mit allen Schritten – und könnt ihn bei Bedarf sicher wiederholen.

## Die Liste

Links stehen die Läufe, neueste zuerst. Ihr könnt filtern nach **Alle**, **Fehler**, **Läuft** und **Erfolgreich** und suchen nach:

- Workflow-Name,
- Laufnummer (`1042` oder `#1042`),
- Auslöser (z. B. „Einsatz B3“),
- Zusammenfassung oder Korrelations-ID.

## Status eines Laufs

| Status | Bedeutung |
|---|---|
| **In Warteschlange** | Angenommen, wartet auf einen freien Worker. |
| **Läuft** | Wird gerade ausgeführt. |
| **Wartet** | Pausiert – durch den Baustein „Warten“ oder bis zum nächsten automatischen Versuch. |
| **Erfolgreich** | Alles erledigt. Auch Läufe, die ein Filter bewusst beendet hat. |
| **Fehlgeschlagen** | Ein Schritt ist mit Fehler abgebrochen. |
| **Prüfen** | Unklar, ob die letzte Aktion ausgeführt wurde. Siehe [unten](#status-pruefen). |
| **Abgebrochen** | Von Hand abgebrochen. |
| **Abgebrochen (Fehler)** | Die Ausführung selbst ist mehrfach abgestürzt (siehe [Dead Letter](#dead-letter)). |

## Die Detailansicht

Rechts seht ihr zum gewählten Lauf:

- **Kopf**: Nummer, Status, Workflow, Version, Auslöser, Start, Ende, Dauer.
- **Durchlaufene Bausteine** als **Zeitachse**: Für jeden Baustein ein Balken, wie lange er gedauert hat. So seht ihr sofort, wo es gehakt hat.
- Je Schritt den **Status**: Erfolgreich, Fehler, Simuliert, Wartet oder Nicht ausgeführt (z. B. der „Falsch“-Zweig einer Bedingung).
- **Datenbereich** mit den Reitern **Eingabe**, **Ausgabe** und **Fehler**.

### Die Daten-Reiter

- **Eingabe** – was beim Baustein ankam bzw. was der Trigger empfangen hat.
- **Ausgabe** – was der Baustein geliefert hat. Das ist genau das, was spätere Bausteine über Variablen nutzen.
- **Fehler** – die Fehlermeldung in Klartext, die Fehlerklasse, ein Hinweis zur Lösung, die Liste der Wiederholungsversuche und technische Details (hinter „Details kopieren“).

### Maskierung

Geheimnisse erscheinen **nie** im Klartext. LifeLink ersetzt sie durch `•••••••• maskiert`:

- Felder, deren Name nach Geheimnis klingt (Passwort, Token, Secret, Authorization, Cookie, API-Key, Signatur, Session …),
- jeder bekannte Wert aus den Zugangsdaten der verwendeten Verbindung – auch wenn er mitten in einem Text steht,
- `Bearer …`- und `Basic …`-Angaben in Texten.

Außerdem werden die gespeicherten Daten gekürzt: Texte nach 2.000 Zeichen, Listen nach 50 Einträgen, die ganze Vorschau ab etwa 64 KB. Das hält die Datenbank schlank und schützt vor versehentlich gespeicherten Datenmengen.

## Fehlerklassen und was zu tun ist

| Fehlerklasse | Typische Ursache | Automatisch wiederholt? | Was tun? |
|---|---|---|---|
| **Vorübergehender Netzwerk- oder Serverfehler** | Zielsystem kurz nicht erreichbar, Fehler 5xx | ja | Meist nichts – LifeLink versucht es erneut. Bleibt es, Zielsystem prüfen. |
| **Zu viele Anfragen (Rate-Limit)** | Ziel meldet 429 | ja, mit der Wartezeit, die das Ziel vorgibt | Weniger häufig senden, Zeitplan strecken. |
| **Anmeldung beim Zielsystem fehlgeschlagen** | Passwort/Token falsch oder abgelaufen (401) | nein | Zugangsdaten der Verbindung ersetzen, Verbindung testen. |
| **Berechtigung im Zielsystem fehlt** | Konto darf das nicht (403) | nein | Rechte im Zielsystem prüfen. |
| **Ungültige Daten** | Ziel lehnt die Anfrage ab (4xx), JSON ungültig, Antwort zu groß | nein | Inhalt im Reiter Eingabe prüfen, Vorlage anpassen. |
| **Konflikt im Zielsystem** | 409/412 | nein | Im Zielsystem nachsehen, ob der Datensatz schon existiert. |
| **Zeitüberschreitung – Ergebnis unklar** | Anfrage gesendet, aber keine Antwort | nur bei wiederholungssicheren Aktionen | Im Zielsystem prüfen, ob die Aktion angekommen ist. |
| **Konfigurationsfehler** | Verbindung fehlt oder ist deaktiviert, Host nicht freigegeben, internes Ziel gesperrt, TLS-Zertifikat ungültig | nein | Hinweis in der Fehlermeldung befolgen, Workflow oder Verbindung korrigieren. |
| **Interner Fehler** | Unerwarteter Fehler in LifeLink | nein | Details kopieren, im [Systemprotokoll](/protokolle) nachsehen. |

## Automatische Wiederholungen

Bei **vorübergehenden Fehlern** und **Rate-Limits** wiederholt LifeLink einen Baustein automatisch:

- standardmäßig bis zu **3-mal** (je Baustein einstellbar, 0–10),
- mit wachsender Pause (**Backoff**): etwa 5 s, 10 s, 20 s, 40 s … höchstens 15 Minuten; die Pausen schwanken leicht, damit nicht alle Wiederholungen gleichzeitig kommen,
- gibt das Ziel eine Wartezeit vor („Retry-After“), wird sie eingehalten.

Im Fehler-Reiter seht ihr jeden Versuch mit dem Zusatz „neuer Versuch folgt“.

**Schutzschaltung:** Scheitert eine Verbindung fünfmal hintereinander vorübergehend, pausiert LifeLink Anfragen an dieses Ziel für 60 Sekunden. So legt ein ausgefallener Server nicht alle Abläufe lahm.

Ein Lauf darf insgesamt höchstens **15 Minuten** rechnen (einstellbar). Pausen durch den Baustein „Warten“ zählen nicht mit.

## Idempotenz und Doppelwirkung

Manche Aktionen darf man gefahrlos wiederholen, andere nicht:

- **Wiederholungssicher** (idempotent): WordPress-Banner und -Beiträge (über den Banner-/Beitrags-Schlüssel), MQTT, HTTP-Anfragen mit GET/PUT/DELETE oder mit **Idempotency-Key**. Eine Wiederholung ändert nichts doppelt.
- **Nicht wiederholungssicher**: E-Mail senden (SMTP und Microsoft 365) und Teams-Nachricht. Eine Wiederholung kann eine **zweite E-Mail** bzw. **zweite Nachricht** erzeugen.

LifeLink merkt sich bei nicht wiederholungssicheren Aktionen, ob sie schon gelaufen sind. Wird ein Lauf fortgesetzt, wird eine bereits erledigte Aktion nicht noch einmal gesendet („Bereits ausgeführt – Ergebnis übernommen“). Welche Bausteine wiederholungssicher sind, steht auch in der [Bausteine-Referenz](/hilfe/bausteine).

## Status „Prüfen“

Ein Lauf bekommt den Status **Prüfen**, wenn eine nicht wiederholungssichere Aktion gestartet wurde, LifeLink aber **nicht weiß, ob sie angekommen ist**. Beispiel: Die E-Mail wurde an den Mailserver übergeben, dann brach die Verbindung ab.

So geht ihr vor:

1. Im Zielsystem nachsehen: Ist die E-Mail angekommen? Steht die Nachricht im Teams-Kanal?
2. **Wenn ja:** nichts tun. Der Lauf bleibt als „Prüfen“ dokumentiert.
3. **Wenn nein:** „Ab fehlerhaftem Node wiederholen“ wählen und die Warnung bestätigen.

Ihr bekommt für solche Läufe eine eigene Benachrichtigung „Lauf #… muss geprüft werden“.

## Wiederholen: zwei Wege

| | Ab fehlerhaftem Node wiederholen | Erneut ausführen |
|---|---|---|
| Was passiert? | Ergebnisse der erfolgreichen Schritte werden übernommen. Nur der fehlerhafte Baustein und alles danach laufen neu. | Der ganze Workflow läuft noch einmal von vorn – mit denselben Trigger-Daten. |
| Wann sinnvoll? | Nach behobenem Fehler, z. B. Passwort der Verbindung ersetzt. Bereits verschickte E-Mails gehen **nicht** erneut raus. | Wenn ein Lauf mit korrigiertem Workflow komplett neu verarbeitet werden soll. **Alle** Aktionen laufen erneut. |
| Möglich bei | fehlgeschlagenen Läufen und „Prüfen“, solange die Laufdaten noch gespeichert sind (Standard 7 Tage) | allen beendeten Läufen |
| Neuer Lauf heißt | „Fortsetzung von #1042“ | „Wiederholung von #1042“ |

Beide Wege brauchen das Recht **Erneut ausführen** und erzeugen einen **neuen** Lauf, der mit dem alten verknüpft ist. Der alte Lauf bleibt unverändert. Es läuft dieselbe Workflow-Version wie beim ursprünglichen Lauf.

> **Achtung:** Ist der fehlerhafte Baustein nicht wiederholungssicher oder steht der Lauf auf „Prüfen“, zeigt LifeLink vor dem Wiederholen eine Warnung, die ihr ausdrücklich bestätigen müsst. Prüft vorher im Zielsystem – sonst bekommt die Wehrführung die Meldung doppelt.

Ist ein Wiederholen nicht möglich, ist der Knopf deaktiviert und nennt den Grund, z. B. „Die Laufdaten sind nicht mehr gespeichert (Aufbewahrungsfrist abgelaufen)“.

**Abbrechen:** Läufe, die in der Warteschlange stehen, laufen oder warten, könnt ihr abbrechen (ebenfalls Recht „Erneut ausführen“).

## Dead Letter

Läufe werden von einem Hintergrundprozess (Worker) abgearbeitet. Stürzt dieser Prozess während eines Laufs ab, übernimmt automatisch ein anderer bzw. der neu gestartete Worker. Scheitert die Ausführung so **dreimal**, wird der Lauf als **„Abgebrochen (Fehler)“** abgelegt („Dead Letter“) und ihr bekommt eine Benachrichtigung. Ein solcher Lauf kann wie andere fehlgeschlagene Läufe wiederholt werden.

Die Anzahl solcher endgültig abgebrochenen Aufträge seht ihr im [Systemstatus](/system) bei der Warteschlange.

## Benachrichtigungen bei Fehlern

Schlägt ein echter (nicht Test-)Lauf fehl, bekommen alle mit dem Recht „Ausführungen ansehen“ eine Benachrichtigung in LifeLink. Zusätzlich kann ein Admin in den [Einstellungen](/einstellungen) E-Mail-Benachrichtigungen an einen festen Verteiler einschalten.

## Aufbewahrung

| Was | Wie lange (Standard) |
|---|---|
| Daten zum Wiederholen eines Laufs | 7 Tage |
| Daten-Vorschau (Eingabe/Ausgabe) der Schritte | 30 Tage |
| Läufe selbst (Status, Zeiten, Fehlermeldung) | 90 Tage |

Die Fristen stellt ein Admin unter [Einstellungen](/einstellungen) ein. Siehe auch [Sicherheit & Datenschutz](/hilfe/sicherheit#aufbewahrungsfristen).
