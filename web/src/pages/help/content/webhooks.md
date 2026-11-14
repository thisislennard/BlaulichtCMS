Ein **Webhook** ist eine Adresse, an die ein anderes System per HTTP-POST Daten schickt. LifeLink prüft die Absicherung, speichert das Ereignis, startet den Workflow im Hintergrund und antwortet sofort – unabhängig davon, wie lange der Workflow läuft.

Webhooks brauchen keine eigene Verbindung: Jeder Workflow mit dem Trigger **Webhook** (oder **Alamos-Einsatz**) bekommt seine eigene Adresse.

## Adresse und Geheimnis

Die Adresse sieht so aus:

```text
https://lifelink.feuerwehr-musterstadt.de/hooks/Xy7kP2…
```

- Ihr erzeugt sie im Editor im Trigger-Baustein über **Adresse jetzt anlegen** – oder sie entsteht beim ersten Veröffentlichen. In beiden Fällen zeigt LifeLink das **Geheimnis genau einmal** an (beginnt mit `whsec_`).
- Die Adresse bleibt stabil, auch wenn ihr neue Versionen veröffentlicht.
- Alle Adressen stehen unter [Webhooks](/webhooks) – mit Workflow, Empfangszähler und letztem Empfang.
- Der vordere Teil der Adresse kommt aus der Server-Einstellung `PUBLIC_URL` (siehe [Installation & Betrieb](/hilfe/betrieb#umgebungsvariablen)).

> **Achtung:** Wer Adresse und Geheimnis kennt, kann den Workflow auslösen. Gebt beides nur an das System weiter, das senden soll – nicht per E-Mail an große Verteiler.

## Absicherung wählen

Im Trigger **Webhook** wählt ihr unter **Absicherung**:

| Modus | Wie es funktioniert | Wann |
|---|---|---|
| **HMAC-Signatur** (empfohlen) | Der Absender signiert jede Anfrage mit dem Geheimnis und einem Zeitstempel. Das Geheimnis selbst wird nie übertragen. | Wenn der Absender etwas programmieren oder ein Skript ausführen kann |
| **Geheimer Schlüssel im Header** | Der Absender schickt das Geheimnis im Header `X-LifeLink-Token` oder als `Authorization: Bearer …` mit. | Für Systeme, die nur feste Header können (z. B. das FE2-HTTP-Plugin) |

Der Trigger **Alamos-Einsatz** verwendet immer den geheimen Schlüssel im Header.

## HMAC-Signatur genau erklärt

Jede Anfrage braucht zwei Header:

| Header | Inhalt |
|---|---|
| `X-LifeLink-Timestamp` | aktuelle Unix-Zeit in **Sekunden**, z. B. `1793286480` |
| `X-LifeLink-Signature` | `v1=` + HMAC-SHA256 als Hex (Kleinbuchstaben) |

Die Signatur wird so berechnet:

```text
signatur = "v1=" + hex( HMAC_SHA256( geheimnis, zeitstempel + "." + body ) )
```

- `geheimnis` ist der komplette Text inklusive `whsec_`.
- `body` ist der **unveränderte** Inhalt der Anfrage, genau die Bytes, die gesendet werden.
- Zwischen Zeitstempel und Body steht ein Punkt.

**Prüfbeispiel** – damit könnt ihr eure eigene Umsetzung testen:

| Wert | |
|---|---|
| Geheimnis | `whsec_beispiel` |
| Zeitstempel | `1793286480` |
| Body | `{"titel":"Probealarm","prioritaet":"hoch"}` |
| Ergebnis | `v1=ac3ccc546274d5c785a82bb538238916842679644dcc09326f035bebc88fd5b3` |

### Beispiel: curl in der Bash

```bash
URL="https://lifelink.feuerwehr-musterstadt.de/hooks/Xy7kP2..."
SECRET="whsec_..."
BODY='{"titel":"Probealarm","text":"Bitte ignorieren","prioritaet":"hoch"}'

TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-LifeLink-Timestamp: $TS" \
  -H "X-LifeLink-Signature: v1=$SIG" \
  -H "Idempotency-Key: meldung-4711" \
  --data-binary "$BODY"
```

Wichtig ist `--data-binary`: Damit sendet curl den Body exakt so, wie er signiert wurde.

### Beispiel: PowerShell (Windows)

```powershell
$Url    = "https://lifelink.feuerwehr-musterstadt.de/hooks/Xy7kP2..."
$Secret = "whsec_..."
$Body   = '{"titel":"Probealarm","text":"Bitte ignorieren","prioritaet":"hoch"}'

$Ts   = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$Hmac = New-Object System.Security.Cryptography.HMACSHA256
$Hmac.Key = [Text.Encoding]::UTF8.GetBytes($Secret)
$Hash = $Hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$Ts.$Body"))
$Sig  = 'v1=' + (($Hash | ForEach-Object { $_.ToString('x2') }) -join '')

Invoke-RestMethod -Method Post -Uri $Url `
  -ContentType 'application/json; charset=utf-8' `
  -Headers @{ 'X-LifeLink-Timestamp' = "$Ts"; 'X-LifeLink-Signature' = $Sig } `
  -Body ([Text.Encoding]::UTF8.GetBytes($Body))
```

Der Body wird als Bytes übergeben, damit Umlaute genau so ankommen, wie sie signiert wurden.

### Beispiel: Node.js

```js
import crypto from 'node:crypto';

const url = 'https://lifelink.feuerwehr-musterstadt.de/hooks/Xy7kP2...';
const secret = process.env.LIFELINK_WEBHOOK_SECRET; // whsec_...
const body = JSON.stringify({ titel: 'Probealarm', text: 'Bitte ignorieren', prioritaet: 'hoch' });

const ts = Math.floor(Date.now() / 1000);
const signature = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lifelink-timestamp': String(ts),
    'x-lifelink-signature': signature,
    'idempotency-key': 'meldung-4711',
  },
  body,
});
console.log(res.status, await res.json());
```

### Beispiel: geheimer Schlüssel im Header

```bash
curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-LifeLink-Token: whsec_..." \
  --data-binary '{"titel":"Probealarm"}'
```

## Zeitfenster ±5 Minuten

Der Zeitstempel darf höchstens **5 Minuten** von der Uhr des LifeLink-Servers abweichen. Ältere oder „zukünftige“ Anfragen werden mit `401` abgelehnt.

Läuft die Uhr eines Absenders falsch, schlägt deshalb jede Anfrage fehl. Abhilfe: Zeitsynchronisation (NTP) auf dem sendenden Rechner einschalten.

## Replay-Schutz

Jede gültige Signatur wird nur **einmal** angenommen. Schickt jemand eine abgefangene Anfrage noch einmal, antwortet LifeLink mit `401` „Diese Anfrage wurde bereits verarbeitet“. Zusammen mit dem Zeitfenster sind mitgeschnittene Anfragen damit wertlos.

Für eigene Wiederholungen (z. B. nach einem Netzwerkfehler) berechnet der Absender einfach eine neue Signatur mit neuem Zeitstempel. Damit dabei kein doppelter Lauf entsteht, gibt es die Duplikaterkennung.

## Duplikaterkennung

Kommt dasselbe Ereignis zweimal, startet nur **ein** Lauf. Erkannt wird ein Ereignis an:

1. dem Feld aus **Feld für Duplikaterkennung** (erweiterte Optionen), z. B. `body.id` – also dem Feld `id` in den gesendeten Daten,
2. sonst dem Header `Idempotency-Key`,
3. sonst dem Header `X-Event-Id`.

Ein Duplikat innerhalb von **24 Stunden** wird angenommen und protokolliert, startet aber keinen Lauf. Die Antwort enthält `"duplicate": true`.

> **Tipp:** Gebt jeder Meldung eine eindeutige Nummer mit (z. B. die Meldungs- oder Einsatznummer). Dann können Absender bei Netzproblemen bedenkenlos erneut senden.

## Was im Workflow ankommt

| Variable | Inhalt |
|---|---|
| `{{ webhook.body.… }}` | Die gesendeten Daten. JSON und Formulardaten werden in Felder zerlegt, sonstiger Text steht in `body.text`. |
| `{{ webhook.query.… }}` | Parameter aus der Adresse (`?quelle=leitstelle`) |
| `{{ webhook.headers.… }}` | Ausgewählte Header: `content-type`, `user-agent`, `x-event-id`, `idempotency-key`, `x-request-id` – nie Zugangsdaten |
| `{{ webhook.received_at }}` | Empfangszeit (UTC) |

`webhook` ist dabei der Variablenname des Triggers; `{{ trigger.body.… }}` funktioniert immer.

Ein mitgesendeter Header `X-Correlation-Id` wird als Korrelations-ID des Laufs übernommen. So findet ihr den Vorgang später im Ausführungsverlauf über die Suche.

## Antwortcodes

| Code | Bedeutung | Was tun? |
|---|---|---|
| `202` | Angenommen. Die Antwort enthält `event_id`, `run_id` und `correlation_id`. Auch Duplikate (`"duplicate": true`), Testereignisse (`"test": true`) und vom Stichwort-Filter aussortierte Einsätze (`"ignored": true`) bekommen 202. | – |
| `400` | Der Body ist kein gültiges JSON. | JSON prüfen. |
| `401` | Absicherung fehlgeschlagen: Signatur-Header fehlen, Signatur falsch, Zeitstempel außerhalb ±5 min, Anfrage schon verarbeitet oder Schlüssel falsch. Die Meldung nennt den genauen Grund. | Geheimnis, Uhrzeit und Body prüfen (siehe unten). |
| `404` | Unbekannte oder widerrufene Adresse. | Adresse prüfen; unter [Webhooks](/webhooks) nachsehen, ob sie widerrufen ist. |
| `409` | Workflow ist nicht aktiv. | Workflow aktivieren. |
| `413` | Anfrage zu groß (Standard höchstens 256 KB, im Trigger unter „Erweiterte Optionen → Maximale Größe“ einstellbar). | Weniger Daten senden, z. B. keine Anhänge. |
| `429` | Zu viele Anfragen (mehr als 120 pro Minute). | Kurz warten und erneut senden. |
| `503` | Vorübergehend nicht verfügbar (z. B. Datenbank kurz weg). | Später erneut senden – mit derselben Ereignis-Nummer. |

### Häufigste Ursachen für 401

- **Body nach dem Signieren verändert**: Manche Werkzeuge formatieren JSON um oder hängen einen Zeilenumbruch an. Signiert genau die Bytes, die ihr sendet.
- **Uhr des Absenders falsch**: mehr als 5 Minuten Abweichung.
- **Zeitstempel in Millisekunden** statt Sekunden.
- **Geheimnis unvollständig**: `whsec_` gehört dazu.
- **Altes Geheimnis** nach einer Rotation, deren Übergangsfrist abgelaufen ist.

Abgewiesene Anfragen stehen im [Systemprotokoll](/protokolle) mit Grund und IP-Adresse.

## Geheimnis rotieren

Unter [Webhooks](/webhooks) könnt ihr mit **Geheimnis rotieren** ein neues Geheimnis erzeugen (Recht „Zugangsdaten verwalten“):

1. LifeLink zeigt das neue Geheimnis einmal an.
2. Das **alte bleibt für eine Übergangsfrist gültig** – standardmäßig 24 Stunden, wählbar von 0 bis 168 Stunden. In dieser Zeit werden beide akzeptiert.
3. Tragt das neue Geheimnis beim Absender ein.
4. Nach Ablauf der Frist gilt nur noch das neue.

Mit einer Frist von 0 Stunden ist das alte Geheimnis sofort ungültig – richtig, wenn es in falsche Hände geraten ist.

## Widerrufen

**Widerrufen** sperrt die Adresse sofort: Jede Anfrage bekommt `404`. Der Workflow bleibt erhalten. Ihr könnt die Adresse später wieder aktivieren; eine eventuell noch laufende Übergangsfrist eines alten Geheimnisses ist dann beendet.
