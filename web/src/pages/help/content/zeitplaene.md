Mit dem Trigger **Zeitplan** startet ein Workflow regelmäßig von selbst – zum Beispiel die Erreichbarkeitsprüfung der Website alle 15 Minuten oder die Wochenübersicht jeden Montag um 7 Uhr.

## Rhythmus wählen

| Rhythmus | Einstellung | Beispiel |
|---|---|---|
| **Alle X Minuten** | 1 bis 1440 Minuten | alle 15 Minuten |
| **Täglich zu einer Uhrzeit** | Uhrzeit im Format HH:MM | täglich 06:30 |
| **Wöchentlich** | Uhrzeit und ein oder mehrere Wochentage | Mo und Do um 19:00 |
| **Cron-Ausdruck (Experten)** | Cron-Ausdruck mit fünf Feldern | `0 7 * * 1` = montags 7:00 |

Bei **Alle X Minuten** laufen die Termine im festen Raster: Bei 15 Minuten also um :00, :15, :30 und :45 – nicht 15 Minuten nach dem Veröffentlichen.

### Cron-Ausdrücke

Ein Cron-Ausdruck hat fünf Felder: Minute, Stunde, Tag im Monat, Monat, Wochentag (0 oder 7 = Sonntag).

| Ausdruck | Bedeutung |
|---|---|
| `0 7 * * 1` | montags um 7:00 |
| `30 18 * * 1-5` | werktags um 18:30 |
| `0 */2 * * *` | alle zwei Stunden zur vollen Stunde |
| `0 8 1 * *` | am 1. jedes Monats um 8:00 |
| `0 19 * * 2,4` | dienstags und donnerstags um 19:00 (Übungsabende) |

Ergibt der Ausdruck keinen gültigen Termin, lehnt LifeLink das Veröffentlichen mit einem Hinweis ab. In der Vorschau beim Veröffentlichen seht ihr immer den **nächsten Termin**.

## Zeitzone und Sommerzeit

Uhrzeiten gelten in der **Zeitzone der Instanz** (Standard Europe/Berlin, einstellbar in den [Einstellungen](/einstellungen)). In den erweiterten Optionen des Triggers könnt ihr für einen einzelnen Zeitplan eine andere Zeitzone wählen.

Sommer- und Winterzeit werden berücksichtigt: „täglich 07:00“ läuft immer um 7 Uhr Ortszeit, auch nach der Umstellung.

> **Tipp:** Legt Termine nicht in die Umstellungsnacht zwischen 2 und 3 Uhr. Diese Stunde gibt es im Frühjahr gar nicht und im Herbst zweimal.

Intervalle in Minuten laufen unabhängig von der Uhrzeit einfach weiter.

## Verpasste Termine

War LifeLink zum geplanten Zeitpunkt nicht in Betrieb – etwa wegen eines Server-Neustarts oder Updates –, entscheidet die Einstellung **Verpasste Termine** (erweiterte Optionen):

| Einstellung | Verhalten |
|---|---|
| **Einmal nachholen** (Standard) | Sobald LifeLink wieder läuft, startet **ein** Lauf – auch wenn mehrere Termine ausgefallen sind. Er heißt „Zeitplan (nachgeholt)“. |
| **Überspringen** | Der verpasste Termin entfällt. Es wird nur ein Eintrag ins Systemprotokoll geschrieben. Weiter geht es mit dem nächsten regulären Termin. |

Als verpasst gilt ein Termin, wenn er mehr als 2 Minuten zu spät gestartet würde.

Für einen Zustandsbericht ist „Einmal nachholen“ richtig. Für Erinnerungen, die nur zu einer bestimmten Uhrzeit Sinn ergeben („Übung beginnt in einer Stunde“), wählt „Überspringen“.

## Daten des Zeitplan-Triggers

| Variable | Inhalt |
|---|---|
| `{{ trigger.scheduled_at }}` | geplanter Zeitpunkt |
| `{{ trigger.fired_at }}` | tatsächlicher Start |
| `{{ trigger.catch_up }}` | `true`, wenn es ein nachgeholter Termin ist |

Mit einer Bedingung „`{{ trigger.catch_up }}` ist wahr“ könnt ihr nachgeholte Läufe z. B. anders beschriften.

## Wenn ein Zeitplan nicht läuft

- Ist der Workflow **aktiv**? Inaktive Workflows haben keinen Zeitplan.
- Läuft der **Worker**? Unter [Systemstatus](/system) muss „Worker“ grün sein – er startet die Zeitpläne.
- Unter „Trigger & Zeitpläne“ im Systemstatus stehen Trigger mit Fehlern.

Siehe auch [Fehlerbehebung](/hilfe/fehlerbehebung#workflow-startet-nicht).
