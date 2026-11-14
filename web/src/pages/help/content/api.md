LifeLink hat eine eigene REST-API. Damit können andere Programme Workflows abfragen, Läufe starten oder den Ausführungsverlauf lesen – zum Beispiel ein Skript auf dem Wachen-PC oder ein Monitoring-System. Die Oberfläche von LifeLink nutzt dieselbe API.

## API-Schlüssel anlegen

API-Schlüssel sind die „Dienstkonten“ von LifeLink: Sie gehören keiner Person, sondern einem System.

1. Öffnet [API-Verwaltung](/api-schluessel) (Recht „System verwalten“).
2. **Neuer Schlüssel**: Namen vergeben (z. B. „Monitoring Wache“), **Rollen** wählen und die **Gültigkeit** festlegen (Standard 365 Tage, höchstens 730 Tage, oder unbegrenzt).
3. LifeLink zeigt den Schlüssel **genau einmal**. Er sieht so aus: `ll_AbCdEfGh_…`. Speichert ihn sicher im aufrufenden System.

Regeln:

- Gebt einem Schlüssel nur die Rollen, die er wirklich braucht. Für reines Lesen genügt **Betriebsleser**.
- Die Rolle **Plattform-Admin** ist für Schlüssel nicht erlaubt. Updates und andere Plattform-Admin-Aufgaben gehen nur mit einem Benutzerkonto.
- Ein Schlüssel kann jederzeit **widerrufen** werden; das wirkt sofort.
- In der Liste seht ihr, wann ein Schlüssel zuletzt benutzt wurde. Alles, was ein Schlüssel ändert, steht im Audit-Protokoll als „API-Schlüssel „Name““.

## Anfragen stellen

- Basis-Adresse: `https://<eure-lifelink-adresse>/api/v1`
- Anmeldung: Header `Authorization: Bearer ll_…`
- Daten: JSON (`Content-Type: application/json`)

Die Rechte eines Schlüssels ergeben sich aus seinen Rollen – genau wie bei Benutzern (siehe [Benutzer & Rollen](/hilfe/benutzer-rollen)). Fehlt ein Recht, antwortet LifeLink mit `403`; ein ungültiger, abgelaufener oder widerrufener Schlüssel ergibt `401`.

## Beispiel: Workflows abfragen

Braucht das Recht „Workflows ansehen“ (z. B. Rolle Betriebsleser).

```bash
curl -sS https://lifelink.feuerwehr-musterstadt.de/api/v1/workflows \
  -H "Authorization: Bearer ll_AbCdEfGh_..."
```

Antwort (gekürzt):

```json
[
  {
    "id": "6f1c2a0e-…",
    "name": "Einsatz → Website-Banner",
    "status": "active",
    "active_version": 3,
    "last_run_at": "2026-10-29T16:08:02.114Z",
    "last_status": "success",
    "success_rate": 98.5,
    "trigger": "Alamos-Einsatz"
  }
]
```

## Beispiel: Workflow starten

Startet einen aktiven Workflow mit dem Trigger **Manuell starten**. Braucht das Recht „Aktivieren & veröffentlichen“ (z. B. Rolle **Freigebender**).

```bash
curl -sS -X POST https://lifelink.feuerwehr-musterstadt.de/api/v1/workflows/6f1c2a0e-.../run \
  -H "Authorization: Bearer ll_AbCdEfGh_..." \
  -H "Content-Type: application/json" \
  -d '{"data": {"nachricht": "Fahrzeughalle 2 Tor offen"}}'
```

Antwort:

```json
{ "runId": 1042 }
```

Im Workflow stehen die übergebenen Daten unter `{{ trigger.data.nachricht }}`; `{{ trigger.started_by }}` enthält den Namen des API-Schlüssels. Ohne `data` werden die Beispieldaten des Triggers verwendet.

Workflows mit anderen Triggern (Webhook, Zeitplan …) lassen sich nicht über `/run` starten. Für Daten von außen ist ein [Webhook](/hilfe/webhooks) meist der bessere Weg.

## Beispiel: Ergebnis eines Laufs abfragen

Braucht das Recht „Ausführungen ansehen“.

```bash
curl -sS https://lifelink.feuerwehr-musterstadt.de/api/v1/runs/1042 \
  -H "Authorization: Bearer ll_AbCdEfGh_..."
```

Die Antwort enthält u. a. `status` (z. B. `success`, `error`, `needs_review`), `summary`, `error_message` und die einzelnen Schritte unter `steps` – mit maskierten Daten wie in der Oberfläche.

Fehlgeschlagene Läufe der letzten Zeit findet ihr mit:

```bash
curl -sS "https://lifelink.feuerwehr-musterstadt.de/api/v1/runs?status=error&limit=20" \
  -H "Authorization: Bearer ll_AbCdEfGh_..."
```

## Beispiel: PowerShell

```powershell
$Headers = @{ Authorization = "Bearer ll_AbCdEfGh_..." }
$Base = "https://lifelink.feuerwehr-musterstadt.de/api/v1"

Invoke-RestMethod -Uri "$Base/workflows" -Headers $Headers |
  Select-Object name, status, last_status

$Body = @{ data = @{ nachricht = "Test aus PowerShell" } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$Base/workflows/6f1c2a0e-.../run" -Headers $Headers `
  -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($Body))
```

## Ohne Anmeldung erreichbar

Nur zwei Adressen brauchen keinen Schlüssel:

- `GET /healthz` – Lebenszeichen mit Versionsnummer, z. B. für ein Monitoring,
- `POST /hooks/<token>` – Webhook-Eingänge, abgesichert mit Signatur bzw. Schlüssel.

## Sicherheitstipps

- Schlüssel nie in Skripte schreiben, die in Git oder auf Netzlaufwerken liegen. Nutzt Umgebungsvariablen oder einen Passwort-Tresor.
- Pro System einen eigenen Schlüssel – dann könnt ihr gezielt widerrufen.
- Setzt ein Ablaufdatum und erneuert Schlüssel rechtzeitig.
