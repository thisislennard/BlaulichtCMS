LifeLink läuft auf einem eigenen Server (z. B. einem kleinen Linux-Server oder einer VM im Gerätehaus bzw. bei eurem Dienstleister) mit **Docker Compose**. Dieses Kapitel richtet sich an die Person, die den Server betreut.

## Bestandteile

| Container | Aufgabe |
|---|---|
| `lifelink` | Startet die **API** (Oberfläche und Webhooks, Port 7310) und den **Worker** (Läufe ausführen, Zeitpläne, MQTT, Postfach- und Kalenderabfragen, Wartung, Sicherungen, Update-Prüfung). Abgestürzte Prozesse werden automatisch neu gestartet. |
| `lifelink-db` | PostgreSQL 18 mit Konfiguration, Workflows, Läufen, Warteschlange und Audit. |

Daten liegen in zwei Docker-Volumes:

- `lifelink-data` (`/data`): installierte Updates, Sicherungen, Einrichtungsschlüssel,
- `lifelink-pg`: die Datenbank.

Der Container läuft als normaler Benutzer mit schreibgeschütztem Dateisystem (außer `/data` und `/tmp`), ohne Sonderrechte.

## Installation

Voraussetzungen: ein Linux-Server mit Docker und Docker Compose, Git, und – für den Echtbetrieb – ein DNS-Name mit TLS-Zertifikat.

**1. Repository holen und Konfiguration anlegen**

```bash
git clone https://github.com/thisislennard/LifeLink.git /opt/lifelink
cd /opt/lifelink
cp .env.example .env
```

**2. `.env` bearbeiten** – mindestens `POSTGRES_PASSWORD` (lang und zufällig) und `PUBLIC_URL` setzen. Alle Variablen stehen [unten](#umgebungsvariablen).

**3. Image bauen und Master-Schlüssel erzeugen**

```bash
docker compose build
docker compose run --rm --no-deps lifelink node server/dist/cli.js gen-master-key
```

Die Ausgabe als `LIFELINK_MASTER_KEY=…` in die `.env` eintragen – und **sofort getrennt sichern**, z. B. im Passwort-Manager. Ohne ihn sind Zugangsdaten und Sicherungen verloren. Siehe [Sicherheit](/hilfe/sicherheit#der-master-schluessel).

**4. Starten**

```bash
docker compose up -d
```

**5. Einrichtungsschlüssel abholen**

```bash
docker compose logs lifelink | grep Einrichtungsschlüssel
```

**6. Erstes Konto anlegen**: `http://<server>:7310` (bzw. eure HTTPS-Adresse) öffnen. LifeLink fragt nach dem Einrichtungsschlüssel, Name, E-Mail und Passwort. Dieses erste Konto wird **Plattform-Admin**; die Zwei-Faktor-Anmeldung wird direkt eingerichtet. Danach ist der Einrichtungsschlüssel ungültig.

## Umgebungsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `POSTGRES_PASSWORD` | Passwort der Datenbank (Pflicht) | – |
| `LIFELINK_MASTER_KEY` | 32 Byte Base64; verschlüsselt Zugangsdaten, 2FA-Geheimnisse und Sicherungen (Pflicht). **Getrennt aufbewahren, nie ändern.** | – |
| `PUBLIC_URL` | Öffentliche Adresse, z. B. `https://lifelink.feuerwehr-musterstadt.de` – für Webhook-Adressen und Einladungslinks | – |
| `LIFELINK_PORT` | Port auf dem Server | `7310` |
| `LIFELINK_BIND` | Netzwerkschnittstelle: `0.0.0.0` = alle, `127.0.0.1` = nur lokal (hinter einem Proxy) | `0.0.0.0` |
| `TRUST_PROXY` | `true`, wenn ein Reverse-Proxy davor läuft (echte Client-IP für Sperren und Audit) | `true` |
| `COOKIE_SECURE` | Sitzungs-Cookies nur über HTTPS. Nur in einem geschützten internen Netz ohne TLS auf `false` setzen. | `true` |
| `WORKER_CONCURRENCY` | Gleichzeitige Ausführungen pro Worker | `4` |
| `UPDATE_REPOSITORY` | Anderes GitHub-Repository für Updates (optional) | `thisislennard/LifeLink` |

Nach einer Änderung an der `.env`: `docker compose up -d` – der Container wird mit den neuen Werten neu gestartet.

> **Achtung:** Die `.env` enthält Datenbankpasswort und Master-Schlüssel. Sie gehört nie in Git, in E-Mails oder auf Netzlaufwerke.

## Reverse-Proxy und TLS

LifeLink selbst spricht nur HTTP. Für den Betrieb im Netz gehört ein **TLS-Proxy** davor – z. B. Caddy, Nginx, Traefik oder Nginx Proxy Manager.

1. In der `.env`: `LIFELINK_BIND=127.0.0.1` (oder nur das Netz des Proxys) und `TRUST_PROXY=true`.
2. Proxy auf `127.0.0.1:7310` zeigen lassen. Beispiel Caddy (holt das Zertifikat automatisch):

```text
lifelink.feuerwehr-musterstadt.de {
  reverse_proxy 127.0.0.1:7310
}
```

3. `PUBLIC_URL` auf die HTTPS-Adresse setzen.

Webhooks (`/hooks/…`) müssen von den Absendern erreichbar sein (z. B. vom FE2-Server). Die Oberfläche (`/` und `/api/…`) könnt ihr am Proxy zusätzlich auf interne Netze oder VPN beschränken.

## Systemstatus lesen

Unter [Systemstatus](/system) (Recht „Systemstatus ansehen“) seht ihr auf einen Blick:

| Dienst | Grün bedeutet | Wenn nicht |
|---|---|---|
| **API** | Oberfläche läuft, seit wie vielen Minuten | – |
| **Datenbank** | PostgreSQL erreichbar, Antwortzeit | Container `lifelink-db` prüfen: `docker compose ps` |
| **Worker** | Mindestens ein Worker meldet sich regelmäßig | „kein Worker aktiv – Läufe werden nicht ausgeführt“: Container-Protokoll prüfen, `docker compose restart lifelink` |
| **Warteschlange** | Aufträge werden zügig abgearbeitet | Gelb ab 1 Minute, rot ab 5 Minuten Wartezeit des ältesten Auftrags: Worker überlastet oder blockiert |
| **Trigger & Zeitpläne** | Alle Trigger ohne Fehler | Liste der Trigger mit Fehlermeldung, z. B. Postfach nicht erreichbar, MQTT-Topic nicht freigegeben |

Dazu: Status aller Verbindungen, die letzte Sicherung, freier Speicherplatz und Datenbankgröße.

### Warteschlange

Läufe, Banner-Abgleiche und Benachrichtigungen werden als **Aufträge** in einer Warteschlange in der Datenbank abgelegt. „Bereit“ sind Aufträge, die sofort laufen können; „geplant“ sind solche mit späterem Termin (z. B. Pausen durch „Warten“ oder automatische Wiederholungen). Aufträge überstehen einen Neustart: Nichts geht verloren, wenn der Server neu startet.

Wie viele Läufe gleichzeitig ausgeführt werden, stellt ihr in den [Einstellungen](/einstellungen) ein (Standard 4).

## Protokolle

- **Systemprotokoll** in der App unter [Protokolle](/protokolle): Meldungen von LifeLink, filterbar nach Stufe (Info, Warnung, Fehler) und Quelle – z. B. abgewiesene Webhooks, fehlgeschlagene Trigger, Sicherungen.
- **Container-Protokoll** auf dem Server – für Start- und Update-Probleme:

```bash
docker compose logs --tail 200 lifelink
docker compose logs -f lifelink      # live mitlesen, Strg+C beendet
```

## Überwachung von außen

`GET /healthz` antwortet ohne Anmeldung mit einem Lebenszeichen und der Version. Docker nutzt diese Adresse selbst als Healthcheck; ihr könnt sie auch in ein bestehendes Monitoring einbinden.

## Wartungsbefehle

```bash
cd /opt/lifelink
docker compose exec lifelink node server/dist/cli.js password-link admin@feuerwehr-musterstadt.de   # Passwort-Link (24 h)
docker compose exec lifelink node server/dist/cli.js reset-mfa admin@feuerwehr-musterstadt.de       # 2FA zurücksetzen
docker compose exec lifelink node server/dist/cli.js migrate                                        # Datenbankschema prüfen/aktualisieren
```

Neustart und Image-Aktualisierung:

```bash
docker compose restart lifelink              # nur neu starten
git pull && docker compose up -d --build     # neues Image (siehe Kapitel Updates)
```

Siehe auch [Updates](/hilfe/updates) und [Sicherung & Wiederherstellung](/hilfe/sicherung).
