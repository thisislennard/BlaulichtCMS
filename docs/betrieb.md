# Betrieb

BlaulichtCMS läuft als **ein Container** mit **einem Webport** und **einem persistenten Volume** unter `/data`.

| Bestandteil | Im Container | Daten |
|---|---|---|
| Supervisor | startet und stoppt alle Prozesse in fester Reihenfolge | – |
| PostgreSQL 18 | nur Unix-Socket, kein TCP-Port | `/data/postgres` |
| Webdienst (API, Oberfläche, PWA) | Port 7310 | – |
| Worker (Medienprüfung, Wartung, Sicherung) | Hintergrundprozess | – |
| Medien | private Ablage | `/data/media` (`quarantine`, `originals`, `previews`, `public`) |
| Schlüsselmaterial | Master-Schlüssel | `/data/secrets/master.key` |
| Datenbanksicherungen | verschlüsselt | `/data/backups` |
| Sicherungsschlüssel (Volume-Sicherungen) | nur am Host, nicht im Volume | `/etc/blaulichtcms/backup.key` |

## Starten

Empfohlen: `sudo bash install.sh` (Installation unter `/opt/apps/blaulichtcms`, Update beim erneuten Aufruf). Von Hand:

```bash
git clone <repository-url> /opt/apps/blaulichtcms && cd /opt/apps/blaulichtcms
cp .env.example .env            # Werte anpassen
docker network create proxy-net # einmalig, gemeinsames Netz mit dem Reverse Proxy
docker compose up -d --build
docker compose logs blaulichtcms | grep Einrichtungsschlüssel
```

Danach die öffentliche HTTPS-Adresse mit `/einrichtung` öffnen.

| Name | Wert |
|---|---|
| Compose-Projekt / Container | `blaulichtcms` (Dienstname in `docker compose …`: `blaulichtcms`) |
| Datenvolume | `blaulichtcms_data` |
| Image | `blaulichtcms:<version>-<commit>` (von `install.sh`), sonst `blaulichtcms:local` |
| Netz zum Reverse Proxy | `proxy-net` (extern), Ziel `http://blaulichtcms:7310` |
| Port am Host | `127.0.0.1:7310` (`BLAULICHTCMS_BIND`, `BLAULICHTCMS_PORT`) |
| Tägliche Sicherung | `/etc/cron.d/blaulichtcms` → `scripts/backup-cron.sh` (14 tägliche + 8 wöchentliche Stände) |

Reihenfolge beim Start: PostgreSQL (bei leerem Volume `initdb`) → API (führt Migrationen aus) → Worker.
Reihenfolge beim Stopp (`docker compose stop`): Worker (laufende Aufträge max. 20 s) → API → PostgreSQL (Fast Shutdown).
`stop_grace_period` ist auf 90 s gesetzt (Worker 25 s + API 10 s + PostgreSQL bis 30 s).

## Gesundheit

`GET /healthz` (ohne Anmeldung) liefert **200** nur, wenn BlaulichtCMS Aufträge annehmen kann:

| Prüfung | bereit, wenn |
|---|---|
| `database` | PostgreSQL antwortet |
| `schema` | alle Migrationen angewendet |
| `worker` | ein Worker hat sich in den letzten 45 s gemeldet |
| `storage` | mehr freier Speicher als „Mindestens frei halten“ (Einstellungen → Medien & Upload) |

Sonst **503** mit den Einzelergebnissen. Der Docker-Healthcheck nutzt diesen Endpunkt.

Von außen (über den Reverse Proxy oder die Portfreigabe) enthält die Antwort nur `ok` je Prüfung – keine
Programmversion, keinen Migrationsstand, keinen Speicherplatz und keine Fehlermeldungen der Datenbank. Die
Einzelheiten bekommen nur Aufrufe aus dem Container selbst (Docker-Healthcheck, `install.sh`, `scripts/update.sh`)
sowie angemeldete Personen unter *Verwaltung → Systemstatus*; eine Fehlermeldung der Datenbank steht zusätzlich im
Systemprotokoll. Auch `/api/v1/auth/state` (Anmeldeseite) nennt keine Version mehr.

```bash
docker compose exec blaulichtcms node -e "fetch('http://127.0.0.1:7310/healthz').then(r=>r.text()).then(console.log)"
docker compose exec blaulichtcms node server/dist/cli.js self-check
```

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `BLAULICHTCMS_PORT` | `7310` | Port auf dem Docker-Host |
| `BLAULICHTCMS_BIND` | `0.0.0.0` | Schnittstelle; hinter einem Proxy auf demselben Host `127.0.0.1` |
| `TRUSTED_PROXIES` | leer | IPs/Netze des Reverse Proxys oder `private`; nur diesen glaubt BlaulichtCMS `X-Forwarded-For` (echte Client-IP für Sperren, Rate-Limits und Audit, siehe `docs/reverse-proxy.md`) |
| `TRUST_PROXY` | – | veraltet; `true` wirkt wie `TRUSTED_PROXIES=private` (Warnung beim Start) |
| `COOKIE_SECURE` | `true` in Produktion | Cookies nur über HTTPS; für einen lokalen Test ohne HTTPS `false` |
| `HSTS_MAX_AGE` | `31536000` | Gültigkeit von `Strict-Transport-Security` in Sekunden (nur mit `COOKIE_SECURE=true`) |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | HSTS auch für alle Subdomains – nur setzen, wenn wirklich alle Subdomains HTTPS sprechen |
| `HSTS_PRELOAD` | `false` | `preload` anhängen (Voraussetzung für die Preload-Liste der Browser: zusätzlich `HSTS_INCLUDE_SUBDOMAINS=true` und mindestens ein Jahr) |
| `PUBLIC_URL` | – | Vorschlag für den Assistenten; maßgeblich ist die im Erstsetup gesetzte Adresse |
| `BLAULICHTCMS_MASTER_KEY` | – | Master-Schlüssel extern vorgeben; sonst wird `/data/secrets/master.key` erzeugt |
| `BLAULICHTCMS_MEM_LIMIT` / `BLAULICHTCMS_PIDS_LIMIT` / `BLAULICHTCMS_CPUS` | `4g` / `512` / `2` | Grenzen des Containers (Speicher, Prozesse, CPU-Kerne); `BLAULICHTCMS_CPUS` höchstens so groß wie die Zahl der Kerne des Hosts (`install.sh` setzt ihn auf Hosts mit einem Kern auf 1) |
| `CLAMAV_HOST` | leer (aus) | clamd für die Schadsoftwareprüfung der Uploads (z. B. `clamav` mit dem Compose-Profil), siehe „Schadsoftwareprüfung“ |
| `CLAMAV_PORT` | `3310` | TCP-Port von clamd |
| `CLAMAV_TIMEOUT_MS` | `120000` | Höchstdauer einer Prüfung; danach gilt die Prüfung als nicht möglich |

## Schadsoftwareprüfung (optional, ClamAV)

Uploads – vor allem über öffentliche Upload-Links ohne Konto – werden vor jeder weiteren Verarbeitung auf
Schadsoftware geprüft, wenn `CLAMAV_HOST` gesetzt ist. BlaulichtCMS sendet die Datei aus der Quarantäne per
clamd-Befehl `INSTREAM` über TCP, **bevor** Bild- und Videodecoder (sharp, ffmpeg) sie öffnen.

| Ergebnis | Verhalten |
|---|---|
| sauber | normale Prüfung (Dateityp, Dekodierung, Vorschau, öffentliche Fassung) |
| Treffer | Datei wird sofort gelöscht, das Medium mit „Schadsoftware erkannt (Signatur)“ abgewiesen (nie freigebbar), Audit-Eintrag `media.malware_found`, Sicherheitsereignis und Sicherheitsmeldung an die Administration |
| Inhaltsprüfung | Bilder vollständig dekodiert (`media.max_image_mp`, Standard 40 Megapixel; animierte Bilder nur mit `media.allow_animated`); Videos: Codecs (H.264, HEVC, MPEG-4, AV1, VP8/9, ProRes, H.263; AAC, MP3, Opus, Vorbis, FLAC, AC-3, PCM, AMR), Länge `media.max_video_minutes`, längere Kante `media.max_video_edge` (7680), Dekodierprüfung mit `ffprobe -count_frames` (`media.video_full_decode`, bis `media.full_decode_seconds` = 60 s Bild für Bild, danach Schlüsselbilder), Zeitlimit `media.check_timeout_s` (1800 s) |
| anderer Prüfbefund (Typ, Aufbau, Grenzen, Dekodierung) | Datei wird **gesperrt**: bleibt in der Quarantäne, „Erneut prüfen“, bei Videos mit reinem Dekodierbefund „Trotzdem freigeben“ (Begründung, Audit, Sicherheitsmeldung), Löschung nach `media.blocked_days` (30 Tage) |
| clamd nicht erreichbar, Zeitüberschreitung, Fehler (z. B. Größengrenze) | Datei bleibt in der Quarantäne (nicht sichtbar), erneuter Versuch alle 10 Minuten; wartet eine Datei länger als 30 Minuten, gibt es eine Sicherheitsmeldung (höchstens alle 6 Stunden) |

Einrichtung mit dem mitgelieferten Compose-Profil:

```bash
# .env
COMPOSE_PROFILES=clamav
CLAMAV_HOST=clamav
docker compose up -d        # startet zusätzlich blaulichtcms-clamav (erster Start: Signaturen laden, 1–2 Minuten, ca. 1,5–3 GB RAM)
```

clamd begrenzt die Länge eines Datenstroms (`StreamMaxLength`, Standard 25 MB). Damit auch Videos geprüft werden,
den Wert mindestens auf die maximale Dateigröße (Einstellung „Maximale Dateigröße“, Standard 2048 MB) anheben:

```bash
docker compose cp clamav:/etc/clamav/clamd.conf ./clamd.conf
# in clamd.conf setzen: StreamMaxLength 2100M, MaxFileSize 2100M, MaxScanSize 4000M
# in compose.yaml beim Dienst clamav die Zeile „- ./clamd.conf:/etc/clamav/clamd.conf:ro“ einkommentieren
docker compose up -d clamav
```

Sonst bleiben größere Dateien in der Quarantäne und die Meldung nennt „size limit exceeded“.

**Ohne ClamAV (Standard):** Es gibt keine Schadsoftwareprüfung; Uploads werden nie deswegen blockiert. Es bleiben
die Prüfungen nach Dateiinhalt (Magic Bytes), Dekodierung mit Pixel- und Längengrenzen sowie die Trennung von
Original und öffentlicher Fassung. **Restrisiko:** präparierte Mediendateien, die Schwachstellen in Bildbetrachtern
oder Codecs ausnutzen, werden nicht erkannt. Originale aus öffentlichen Uploads deshalb nur auf aktuellen Geräten
öffnen und bevorzugt mit der öffentlichen Fassung arbeiten (neu kodiert bzw. ohne Metadaten umverpackt). Auch mit
ClamAV bleibt ein Restrisiko (signaturbasierte Erkennung, keine Erkennung unbekannter Exploits).

## Datenbankrollen

Die Anwendung arbeitet nicht als PostgreSQL-Superuser (BSI APP.4.3). Im Cluster gibt es drei Rollen:

| Rolle | Rechte | Wofür |
|---|---|---|
| `blaulichtcms` | Superuser (von `initdb` angelegt, lässt sich nicht herabstufen) | nur Supervisor (Cluster, Datenbank anlegen), Migrationsschritt vor dem Start und Wartung von Hand (`psql`, `pg_dump`/`pg_restore`, PostgreSQL-Wechsel) |
| `blaulichtcms_owner` | keine Anmeldung, kein Superuser, darf keine Rollen/Datenbanken anlegen | Eigentümerin aller Tabellen, Folgen und Funktionen; Migrationen laufen mit `SET ROLE blaulichtcms_owner` |
| `blaulichtcms_app` | Anmeldung, kein Superuser; nur `SELECT`, `INSERT`, `UPDATE`, `DELETE` (kein `TRUNCATE`), `schema_migrations` nur lesen | API, Worker und alle Befehle von `cli.js` außer `migrate` |

Weil `blaulichtcms_app` nicht Eigentümerin der Tabellen ist, kann sie weder die Audit-Trigger abschalten noch Tabellen
ändern oder löschen; `COPY … TO PROGRAM`, das Lesen und Schreiben von Dateien des Servers und
`session_replication_role` sind ihr verwehrt. Eine SQL-Injection hätte damit nur noch die Rechte der Anwendung.

**Einrichtung und Umstellung bestehender Installationen.** Der Migrationsschritt vor jedem Start
(`cli.js migrate`, als `blaulichtcms`) legt die Rollen an, erzwingt ihre Attribute, überträgt alle Objekte im Schema
`public`, die noch `blaulichtcms` gehören, an `blaulichtcms_owner` und vergibt die Rechte von `blaulichtcms_app` neu (auch als
Standardrechte für künftige Migrationen). Beim ersten Start einer Version mit getrennten Rollen geschieht die Umstellung
damit von selbst, in Sekunden, ohne Datenänderung. Dasselbe heilt nach einer Wiederherstellung (eingespielte Objekte
gehören `blaulichtcms` und haben keine Rechte): einfach den Container neu starten.

**Grenze.** Alle Prozesse im Container laufen unter derselben Benutzerkennung, und PostgreSQL vertraut Verbindungen über
den Unix-Socket (`local all all trust`). Wer Code im Container ausführen kann, kann sich deshalb auch als `blaulichtcms`
verbinden – die Rollentrennung schützt gegen Fehler und Injection in SQL, nicht gegen eine Übernahme des Containers
(siehe `docs/architektur.md`, E2).

**Externe Datenbank** (ohne `BLAULICHTCMS_EMBEDDED_DB`, z. B. Entwicklung): Standardmäßig wird nichts eingerichtet und
`DATABASE_URL` für alles verwendet. Mit `BLAULICHTCMS_DB_ROLES=true` und `DATABASE_ADMIN_URL` (Superuser, nur für
`cli.js migrate`) richtet der Migrationsschritt die Rollen genauso ein; `DATABASE_URL` zeigt dann auf `blaulichtcms_app`
(Passwort selbst setzen: `ALTER ROLE blaulichtcms_app PASSWORD '…'`).

Prüfen: `cli.js preflight` meldet „Datenbankrolle ohne Superuser-Rechte: blaulichtcms_app“.

## Betriebsfestlegungen (Vorschlag, bitte bestätigen)

Werte für den Echtbetrieb. Die Spalte „Einstellung“ zeigt, wo BlaulichtCMS den Wert führt; Grundlage sind die
Standardwerte und der Lasttest unten. Abweichungen hier eintragen, damit Betrieb und Doku übereinstimmen.

| Thema | Vorschlag | Einstellung / Ort | Begründung |
|---|---|---|---|
| Speicher für `/data` | mind. **200 GB** SSD, Warnung bei < 20 % frei | Host | ca. 2 000 Fotos à 8 MB plus Vorschauen ≈ 25 GB/Jahr; Videos deutlich mehr |
| Mindestens frei halten | **10 GB** (Standard 2 GB) | *Einstellungen → Medien & Upload* `media.min_free_gb` | Uploads stoppen rechtzeitig vor vollem Datenträger, Datenbank bleibt schreibfähig |
| Größe je Datei / Sammlung | 2 GB / 10 GB (Standard) | `media.max_file_mb`, `media.collection_max_gb` | Video-Einsätze; größere Sammlungen bewusst freigeben |
| Speicherwarnung | Benachrichtigung an „Medien administrieren“ unter **10 GB** frei | `media.storage_warn_gb` (0 = aus) | Übersicht unter *Verwaltung → Medienverwaltung → Speicher* (je Sammlung, Ordner, Art, Papierkorb, Quarantäne, ZIP) |
| ZIP-Downloads | **24 Stunden** verfügbar, höchstens **20 GB** | `media.export_hours`, `media.export_max_gb` | große Auswahl in mehreren ZIPs anfordern |
| Aufbewahrung Medien | abgeschlossene Sammlungen (archiviert oder ohne aktiven Link) **365 Tage** nach der letzten Aktivität löschen, samt Originalen, Fassungen, Sammeldownloads und Links; Dateien in laufenden Beiträgen bleiben; fehlen einem später wieder aufgenommenen Beitrag dadurch Dateien, ist seine Freigabe nicht mehr auslieferbar (Hinweis „Dateien fehlen“, neue Fassung nötig) | `privacy.collection_retention_days` (Einstellungen → Löschfristen, 0 = nie) | Datenschutz: Zweckbindung der Uploads (Art. 5 Abs. 1 lit. e DSGVO); Probelauf „Was würde gelöscht?“ |
| Papierkorb und abgewiesene Dateien | Dateien, Ordner und Sammlungen im Papierkorb samt Datensatz **30 Tage** nach dem Löschen endgültig entfernen; Datensätze abgewiesener Dateien ebenso | `privacy.deleted_media_days` | Papierkorb wie in LiFeOS: bis dahin wiederherstellbar; „Medien administrieren“ kann früher endgültig löschen; abgewiesene Dateien sind sofort weg |
| Gesperrte Dateien | Dateien mit Prüfbefund samt Datensatz **30 Tage** nach der Prüfung löschen | `media.blocked_days` (0 = nie) | bis dahin erneut prüfbar |
| Sicherheitsereignisse der Upload-Seiten | **365 Tage** | `media.security_log_days` (0 = unbegrenzt) | Ereignis, Link, Zeit, gekürzter IP-Hash (keine Klar-IP) |
| Angaben der Hochladenden | Name, E-Mail-Adresse, Aufnahmeort und -datum (je Upload-Link abfragbar, Standard: nicht abgefragt) **12 Monate** nach dem Upload entfernen; die Dateien bleiben | `privacy.uploader_months` (0 = nie) | wie LiFeOS; zusätzlich je Link „Angaben der Hochladenden löschen“ |
| Warnvorgänge | **365 Tage** nach dem letzten Bearbeitungsschritt des Vorgangs (samt Aktualisierungen und Entwarnung): Fassungen mit Rückrufkontakt, Freigaben samt PDF, Versandnachweise mit Empfängern | `privacy.warning_days` | Nachweis der Warnung für Rückfragen und Nachbereitung |
| FE2-Einsatzmeldungen | **90 Tage** nach Eingang bzw. letzter Aktualisierung | `privacy.fe2_event_days` | Einsatzort und -zeit; Beiträge und Warnvorgänge daraus bleiben |
| Amtliche Warnungen | **90 Tage** nach Ablauf und nachdem die Quelle sie nicht mehr liefert (sonst würde eine noch gelieferte Warnung erneut gemeldet) | `privacy.official_warning_days` | keine personenbezogenen Daten, Bestand klein halten |
| Empfangsprotokoll der Verbindungen | **7 Tage** (1–30), zusätzlich höchstens 500 Einträge je Verbindung; Rohdaten je Meldung höchstens 128 KB (länger: gekürzt), gleiche Rohdaten nur einmal gespeichert | `privacy.receipt_days` | Abrufe und eingehende Meldungen von Warnfeeds, FE2 und Feuersoftware mit Entscheidung und Grund; Einsatzdaten nur geschwärzt (siehe [datenschutz.md](datenschutz.md#datenkategorien-je-bereich)) |
| Upload-Links | **90 Tage** nach Ablauf bzw. Widerruf, ebenso Weiterleitungen aus dem Import | `privacy.upload_link_days` | Token (verschlüsselt) und Bezeichnung haben danach keinen Zweck mehr |
| Sonstiges (fest) | Sammeldownloads 24 Stunden (Datensatz 30 Tage), Upload-Sitzungen bis Ablauf, Sitzungen und gemerkte Geräte 7 Tage nach Ende, Einladungen 30 Tage nach Ablauf, Benachrichtigungen 60 Tage, Importberichte wie das Audit | Worker | Beiträge (redaktionelles Archiv, veröffentlichte Inhalte) und Konten werden nicht automatisch gelöscht; Personendaten in Beiträgen von Hand bearbeiten bzw. Beitrag zurückziehen |
| Angemeldet bleiben | an, **30 Tage** ohne Nutzung (1–180) | `security.remember_enabled`, `security.remember_days` (*Einstellungen → Sicherheit*) | Installierte App auf Dienstgeräten ohne tägliche Neuanmeldung; gebunden an das Geräte-Cookie, kritische Aktionen weiter mit Passwort und Code. Bei Geräten, die mehrere Personen nutzen, abschalten oder kürzer stellen |
| Zwei-Faktor auf einem Gerät merken | an, **30 Tage** (1–90) | `security.mfa_remember_enabled`, `security.mfa_remember_days` | Code nur auf neuen Geräten bzw. einmal im Monat; nur nach einem Code aus der App, serverseitig widerrufbar |
| Systemprotokoll / Audit | **30 Tage / 365 Tage** (Standard) | `retention.log_days`, `retention.audit_days` | Fehlersuche bzw. Nachvollziehbarkeit von Freigaben |
| IP-Adressen ohne Benutzerkonto im Audit | **30 Tage** (1–365) | `privacy.upload_ip_retention_days` (Einstellungen → Redaktion) | Missbrauchsabwehr bei öffentlichen Uploads, Anmeldeversuchen mit unbekanntem Konto und Bridge-/FE2-Fehlversuchen; danach ersetzt der Worker die Adresse durch „entfernt“, der Eintrag selbst bleibt. Kein „0 = nie“: die Adresse wird immer gekürzt |
| Datenbanksicherung im Volume | täglich 03:00, **14** behalten (Standard); ab der eingestellten Stunde einmal je Kalendertag – fällt die Stunde aus (Umstellung auf Sommerzeit, Worker gestoppt), läuft sie beim nächsten Takt desselben Tages | *Einstellungen → Sicherung* | schneller Rückweg nach Bedienfehlern |
| **Backup-Ziel außerhalb** | täglich `scripts/backup-volume.sh` (verschlüsselt) auf NAS/zweiten Host, **14 tägliche + 8 wöchentliche** Stände, vor Updates die letzten 3 (max. 90 Tage); einmal im Monat Kopie außer Haus, höchstens 3 Monate aufbewahrt; Sicherungsschlüssel getrennt im Tresor | Host-Cron | Schutz bei Ausfall des Datenträgers oder Hosts; gelöschte Daten nach spätestens ≈ 4 Monaten aus allen Sicherungen |
| Wiederanlauf (RTO) | **4 Stunden** bis BlaulichtCMS wieder bereit ist | Betrieb | Restore aus Volume-Sicherung dauert Minuten; Rest ist Hardware/Netz |
| Datenverlust (RPO) | **24 Stunden** (eine Nacht) | Backup-Takt | Uploads des Tages lassen sich notfalls neu einsammeln |
| Updates | monatlich bzw. bei Sicherheitsupdates, immer mit vollständiger Sicherung davor; ohne neuen Code monatlich `install.sh --rebuild` | `install.sh` → `scripts/update.sh` | Rückweg über versioniertes Image; Basis-Images bekommen nur so ihre Sicherheitsupdates |
| Erreichbarkeit | nur über HTTPS-Reverse-Proxy, `BLAULICHTCMS_BIND=127.0.0.1`, `TRUSTED_PROXIES=<Netz/IP des Proxys>` | `.env` | echte, nicht fälschbare Client-IP für Sperren und Audit |

### Lasttest (Basislinie, 14.11.2026)

Produktions-Build (`node server/dist/api.js`), ein Prozess, PostgreSQL 18 lokal, 50 gleichzeitige Verbindungen je
8 Sekunden (autocannon), Entwicklungsrechner mit 24 Kernen – **nicht** die Zielhardware.

| Anfrage | Anfragen/s | p50 | p99 | Fehler |
|---|---|---|---|---|
| Startseite (`index.html`, Brotli) | 3 750 | 13 ms | 20 ms | 0 |
| `/healthz` (mit Datenbank- und Speicherprüfung) | 2 120 | 23 ms | 29 ms | 0 |
| Dashboard (angemeldet) | 1 060 | 46 ms | 52 ms | 0 |
| Beitragsliste (angemeldet) | 1 900 | 25 ms | 35 ms | 0 |
| Beitrag mit Fassungen (angemeldet) | 890 | 56 ms | 63 ms | 0 |
| Öffentliche Upload-Seite | – | – | – | nach 60 Anfragen/IP gedrosselt (429) – Schutz greift |

Erwartete Last einer Organisation liegt um Größenordnungen darunter (einige Personen in der Redaktion, Uploads in
Wellen nach Einsätzen). Auf der Zielhardware wiederholen, außerhalb der Dienstzeit:

```bash
npx autocannon -c 50 -d 10 https://<blaulichtcms>/healthz
npx autocannon -c 50 -d 10 -H "cookie: <Sitzungs-Cookie einer Testperson>" https://<blaulichtcms>/api/v1/dashboard
```

## Audit-Protokoll: Integrität und zentrale Weiterleitung

**Hash-Kette.** Der Worker versiegelt neue Audit-Einträge etwa jede Minute: Jeder Eintrag erhält eine laufende
Kettennummer, den Hash des Vorgängers und einen HMAC-SHA-256 über Vorgänger-Hash und eigenen Inhalt. Der Schlüssel
ist zufällig und mit dem Master-Schlüssel verschlüsselt gespeichert; wer nur die Datenbank in der Hand hat, kann
geänderte Einträge nicht neu versiegeln. Die IP-Adresse gehört nicht zum versiegelten Inhalt, weil sie nach Frist
entfernt wird (`privacy.upload_ip_retention_days`).

**Nur anhängen.** Datenbank-Trigger verbieten das Ändern und Löschen von Audit-Einträgen. Erlaubt sind nur das
einmalige Versiegeln, das Entfernen der IP nach Frist und das Löschen nach Ablauf der Aufbewahrung (Einträge älter als
30 Tage; die Aufbewahrung selbst steht unter `retention.audit_days`, ihre Änderung ist mit altem und neuem Wert
auditiert).

**Prüfen.** *Verwaltung → Systemstatus → Audit-Integrität → Jetzt prüfen* oder

```bash
docker compose exec blaulichtcms node server/dist/cli.js audit-verify   # Exit-Code 1 bei Auffälligkeiten
```

Gemeldet werden nachträglich geänderte Einträge, falsche Verweise und Lücken zwischen jüngeren Einträgen (mittendrin
gelöscht). Der Worker prüft einmal am Tag und benachrichtigt bei Auffälligkeiten alle mit „Sicherheitseinstellungen ändern“.

**Grenzen.** Ein Angreifer mit Root-Zugriff auf den Container (Master-Schlüssel und Datenbank-Superuser) kann Trigger
abschalten und neu versiegeln; auch das Abschneiden der jüngsten Einträge erkennt die Kette allein nicht. Dagegen hilft
nur eine Kopie außerhalb des Hosts:

| Variable | Standard | Bedeutung |
|---|---|---|
| `AUDIT_FORWARD` | leer (aus) | `stdout`: jeder Audit-Eintrag zusätzlich als JSON-Zeile (`"source":"audit"`) im Container-Protokoll – ein Docker-Logging-Treiber (`journald`, `syslog`, `gelf`, `fluentd`) oder ein Log-Sammler übernimmt sie. `syslog`: direkt per Syslog (RFC 5424, Facility authpriv) |
| `AUDIT_SYSLOG_HOST` | `127.0.0.1` | Syslog-Server (nur mit `AUDIT_FORWARD=syslog`) |
| `AUDIT_SYSLOG_PORT` | `514` | Port des Syslog-Servers |
| `AUDIT_SYSLOG_PROTOCOL` | `udp` | `udp` oder `tcp` (TCP mit Längenpräfix nach RFC 6587, Puffer bis 1 000 Zeilen beim Neuverbinden) |

Weitergeleitet werden alle Einträge (mit IP-Adresse – Aufbewahrung und Zugriff regelt dann die zentrale
Protokollierung) und nach jedem Versiegeln ein Kontrollpunkt `audit_seal` mit Kettennummer und Hash. Stimmt der letzte
Kontrollpunkt im zentralen Protokoll nicht mehr mit *Letztes Siegel* im Systemstatus überein, wurde das Audit
verändert. Hinweis: Die Docker-Logs selbst sind auf 5 × 10 MB begrenzt und kein Ersatz für eine zentrale Ablage.

## Protokollierung und Sicherheitsvorfälle

Vorschlag als Grundlage für die Protokollierungsrichtlinie (BSI OPS.1.1.5, DER.1); Rollen und Intervalle bitte im
Betrieb bestätigen und hier eintragen.

### Was wird wo protokolliert

| Protokoll | Inhalt | Ort, Aufbewahrung | Zugriff |
|---|---|---|---|
| Audit-Protokoll | Wer hat wann was getan: Anmeldungen und Fehlversuche, Bestätigungen, Rechte- und Kontenänderungen, Freigaben, Veröffentlichungen, Downloads von Originalen, Exporte, Einstellungen (mit altem und neuem Wert), verweigerte Zugriffe, falsche Website-/FE2-/API-Schlüssel. Keine Passwörter, Tokens oder Einsatzinhalte | Datenbank, `retention.audit_days` (Standard 365 Tage), versiegelt; optional zusätzlich zentral (`AUDIT_FORWARD`) | Recht „Audit lesen“ (Verwaltung → Protokolle) |
| IP-Adressen ohne Benutzerkonto | Öffentliche Uploads, Anmeldeversuche unbekannter Konten, Bridge-/FE2-Fehlversuche | im Audit, `privacy.upload_ip_retention_days` (Standard 30 Tage), danach „entfernt“ | wie Audit |
| Systemprotokoll | Technische Meldungen der Dienste, Fehler, Sicherheitsmeldungen (Quelle `security`) | Datenbank, `retention.log_days` (Standard 30 Tage), zusätzlich Container-Protokoll (5 × 10 MB) | Recht „System lesen“; Container-Protokoll nur mit Zugang zum Docker-Host |
| Benachrichtigungen | Sicherheitsmeldungen an die Administration, Kontomeldungen an Betroffene | Datenbank, 60 Tage | jeweilige Empfänger |
| Zugriffsprotokoll des Reverse Proxys | Adressen und Client-IPs aller Anfragen, ohne Maßnahme auch Tokens von Upload-, Einladungs- und Medienlinks | am Proxy; abschalten oder Tokens maskieren und IP kürzen, höchstens 7 Tage ([reverse-proxy.md](reverse-proxy.md#zugriffsprotokolle-des-proxys-datenschutz)) | Betrieb des Proxys |

Datenschutz: Audit und Systemprotokoll enthalten personenbezogene Daten (Namen, E-Mail-Adressen, IP-Adressen). Zweck
ist die Nachvollziehbarkeit von Freigaben und die Erkennung von Missbrauch; eine Leistungs- oder Verhaltenskontrolle
ist nicht vorgesehen. Den Zugriff auf „Audit lesen“ auf wenige Personen beschränken.

### Auswertung

| Was | Wer | Wie oft |
|---|---|---|
| Sicherheitsmeldungen (Glocke, ggf. E-Mail) | Administration (je Meldung die Rechte „Sicherheitseinstellungen ändern“, „Konten sperren und entsperren“, „Rollen zuweisen“ oder „Rollen verwalten“) | sofort bei Eingang |
| Audit-Protokoll, Filter „Fehlgeschlagen“ und „Verweigert“ | Administration | wöchentlich |
| Audit-Integrität (Systemstatus → Audit-Integrität) | Administration | monatlich; der Worker prüft täglich und meldet Auffälligkeiten |
| Systemprotokoll, Stufe „Fehler“ | Betrieb | wöchentlich und nach Updates |
| Benutzerliste: Rollen, inaktive Konten, Zwei-Faktor-Status | Administration mit Informationssicherheitsbeauftragter/m (ISB) | vierteljährlich |

### Erkennung

BlaulichtCMS meldet von sich aus (Einstellungen → Sicherheit → Sicherheitsmeldungen): Kontosperren, benutzte
Wiederherstellungscodes, vergebene oder entzogene Admin-Rechte, zurückgesetzte oder abgeschaltete
Zwei-Faktor-Anmeldung, geänderte Sicherheits- und Aufbewahrungseinstellungen, gehäufte Fehlversuche über alle Konten
(Standard ab 20 in 15 Minuten), Anmeldeversuche mit falschem Website-, FE2- oder API-Schlüssel, neue Website-Kopplungen,
ungewöhnlich viele Original-Downloads oder Exportdateien einer Person (Standard ab 200 pro Stunde) und Auffälligkeiten
in der Audit-Kette. Die betroffene Person erfährt von Passwort- und Zwei-Faktor-Änderungen an ihrem Konto. E-Mails
setzen den eingerichteten E-Mail-Versand voraus.

### Meldeweg

1. Wer eine Auffälligkeit bemerkt (Meldung, Hinweis einer Person, verlorenes Gerät, verlorene Sicherung), informiert
   sofort die Administration.
2. Die Administration bewertet, sichert Belege (Audit-Export, Systemprotokoll, `cli.js audit-verify`) und informiert
   die/den ISB.
3. Sind personenbezogene Daten betroffen (z. B. Originale mit Standort, Uploads von Bürgerinnen und Bürgern,
   Empfängerlisten), informiert die/der ISB die/den Datenschutzbeauftragte/n. Meldepflichtige Verletzungen sind
   **innerhalb von 72 Stunden** der Aufsichtsbehörde zu melden (Art. 33 DSGVO), ggf. Benachrichtigung der Betroffenen
   (Art. 34 DSGVO).
4. Nach Abschluss: Ursache, Maßnahmen und Lehren dokumentieren.

### Sofortmaßnahmen

| Lage | Maßnahme in BlaulichtCMS |
|---|---|
| Konto übernommen oder Gerät verloren | Benutzer → *Auf allen Geräten abmelden* (beendet alle Sitzungen, auch „Angemeldet bleiben“, und entfernt gemerkte Geräte der Zwei-Faktor-Anmeldung) oder Konto deaktivieren (zusätzlich offene Links), Zwei-Faktor zurücksetzen, Passwort-Link neu erzeugen; die Person kann sich unter *Profil → Auf allen Geräten abmelden* auch selbst überall abmelden |
| Admin-Konto betroffen | wie oben, zusätzlich Rollen und Einstellungen im Audit (Details: vorher/nachher) prüfen und ggf. zurücksetzen; im Notfall `cli.js password-link` / `cli.js reset-mfa` |
| Bridge-Schlüssel einer Website abgeflossen | Einrichtung → Websites → Kopplung widerrufen (sofort wirksam, offene Aufträge werden abgebrochen), danach neu koppeln |
| FE2-Zugangsschlüssel abgeflossen | Verbindungen → FE2 → „Neuen Zugangsschlüssel erzeugen“ und in FE2 eintragen |
| Zugangsdaten sozialer Netzwerke oder SMTP | Verbindung widerrufen bzw. Zugangsdaten neu setzen; das Passwort bzw. Token beim Anbieter ändern |
| API-Schlüssel abgeflossen | API-Schlüssel widerrufen und neu erzeugen |
| Upload-Link in falschen Händen | Sammlung → Link → „Neu erzeugen“ (alter Link und QR-Code sofort ungültig, Einstellungen bleiben) oder widerrufen; eingegangene Dateien in der Sichtung prüfen |
| Master-Schlüssel oder Volume-Sicherung abgeflossen | Master-Schlüssel wechseln (`cli.js rotate-master-key --ja`, Abschnitt „Master-Schlüssel wechseln“), alle Zugangsdaten bei den Gegenstellen erneuern (soziale Netzwerke, SMTP, Bridge neu koppeln, FE2-Schlüssel erneuern), Upload-Links widerrufen und neu ausgeben; Sicherungen getrennt vom Master-Schlüssel aufbewahren |
| Audit-Kette meldet Auffälligkeiten | Belege sichern (Datenbanksicherung, zentrales Protokoll), Zugänge zum Docker-Host prüfen, ISB informieren |

### Angemeldet bleiben und gemerkte Geräte

- **Angemeldet bleiben** (Ankreuzfeld auf der Anmeldeseite, in der installierten App vorbelegt): keine Abmeldung bei
  Leerlauf, Ablauf `security.remember_days` nach der letzten Nutzung (gleitend, höchstens einmal pro Stunde erneuert;
  Cookie-Laufzeit gleich). Die Sitzung ist an das signierte Geräte-Cookie gebunden; wird das Sitzungs-Cookie ohne das
  passende Geräte-Cookie vorgelegt, wird die Sitzung abgewiesen und beendet. Gilt für alle Rollen.
- **Zwei-Faktor auf diesem Gerät merken** (Ankreuzfeld bei der Code-Abfrage): Eintrag in `trusted_devices` (nur Hash der
  Gerätekennung, Browser-Kennung, Zeiten), danach fragt die Anmeldung auf diesem Gerät `security.mfa_remember_days`
  lang nur das Passwort. Entsteht nur nach einem Code aus der App, nie nach einem Wiederherstellungscode.
- **Unverändert:** Step-up für kritische Aktionen (Passwort und Code, höchstens 10 Minuten alt), Kontosperre je Gerät.
- **Widerruf:** Passwortänderung, Zwei-Faktor einrichten/abschalten/zurücksetzen, *Auf allen Geräten abmelden* (selbst
  oder durch die Benutzerverwaltung), Konto deaktivieren, Passwort-Link für ein aktives Konto, Master-Schlüsselwechsel.
  Abschalten einer der beiden Einstellungen beendet bestehende gemerkte Sitzungen bzw. entfernt alle gemerkten Geräte
  sofort (die eigene Sitzung der ändernden Person bleibt als normale Sitzung bestehen). Eine verkürzte Frist greift
  beim nächsten Aufruf bzw. bei der nächsten Anmeldung.
- **Audit/Meldungen:** `auth.trusted_device_added`, `auth.trusted_device_removed`, `auth.session_revoked` (mit
  „gemerkt“), `user.sessions_ended`, `settings.remember_revoked`; Anmeldungen ohne Code stehen mit
  `mfa: vertrauenswürdiges Gerät` im Audit. Die betroffene Person bekommt eine Meldung, wenn ein Gerät gemerkt oder sie
  durch die Verwaltung überall abgemeldet wurde.

## Master-Schlüssel wechseln

Der Master-Schlüssel (`/data/secrets/master.key` bzw. `BLAULICHTCMS_MASTER_KEY`) verschlüsselt alle gespeicherten
Zugangsdaten (Verbindungen, SMTP, Schlüssel der Audit-Kette), die Zwei-Faktor-Geheimnisse, die Token der Upload-Links
und die Datenbanksicherungen im Volume. **Anlass für einen Wechsel:** Verdacht auf Offenlegung (verlorene oder
unverschlüsselte Volume-Sicherung, Kopie des Schlüssels in falschen Händen, ausgeschiedene Person mit Zugriff auf den
Host) – sonst nach eigenem Sicherheitskonzept, z. B. alle zwei Jahre.

```bash
docker compose exec blaulichtcms node server/dist/cli.js maintenance on "Schlüsselwechsel"
docker compose exec blaulichtcms node server/dist/cli.js rotate-master-key --ja
# prüfen: Anmeldung mit Zwei-Faktor, Verbindungen testen, Systemstatus → Audit-Integrität
docker compose exec blaulichtcms node server/dist/cli.js maintenance off
```

Ablauf des Befehls: Er hält API und Worker über den Supervisor an (PostgreSQL läuft weiter), sichert den alten
Schlüssel als `/data/secrets/master.key.alt-<zeitpunkt>` (`0600`), verschlüsselt alle Felder in **einer** Transaktion
neu, prüft sie mit dem neuen Schlüssel, ersetzt dann `master.key` und startet API und Worker neu (Unterbrechung meist
unter einer Minute). Schlägt vorher etwas fehl (z. B. ein nicht lesbarer Eintrag), bleibt alles beim alten Schlüssel.
Danach verschlüsselt er die Datenbanksicherungen unter `/data/backups` neu. Der Wechsel steht im Audit
(`system.master_key_rotated`) und erzeugt eine Sicherheitsmeldung. Die Audit-Trigger bleiben dabei aktiv; die Hash-Kette
bleibt gültig, weil ihr Schlüssel ein eigenes, nur neu verschlüsseltes Geheimnis ist.

| Was | Folge des Wechsels |
|---|---|
| Wiederherstellungscodes, die seit der Umstellung auf gesalzene Codes erzeugt wurden | **ungültig** (sie sind mit einem aus dem Master-Schlüssel abgeleiteten Schlüssel gebildet und lassen sich nicht umschlüsseln). Sie werden entfernt, die Personen bekommen eine Meldung, und die Profilseite fordert zu neuen Codes auf. Ältere Codes bleiben gültig |
| Geräte-Merkmal der Kontosperre, Download-Links für das Plugin | werden ungültig (Geräte gelten bis zur nächsten vollständigen Anmeldung als unbekannt; Links neu erzeugen) |
| „Angemeldet bleiben“ und gemerkte Geräte der Zwei-Faktor-Anmeldung | werden beendet bzw. entfernt (sie hängen am Geräte-Merkmal); alle melden sich einmal neu mit Code an |
| Volume-Sicherungen | nicht betroffen (eigener Sicherungsschlüssel am Host). Ältere Volume-Sicherungen enthalten den alten Master-Schlüssel und bleiben damit vollständig wiederherstellbar |
| Datenbanksicherungen aus der Zeit vor dem Wechsel außerhalb des Volumes (heruntergeladen) | brauchen den alten Schlüssel: `BLAULICHTCMS_MASTER_KEY=$(cat master.key.alt-…) node server/dist/cli.js backup-decrypt …` |
| Eine Datenbanksicherung von vor dem Wechsel einspielen | Zugangsdaten und Zwei-Faktor sind darin mit dem alten Schlüssel verschlüsselt – mit dem alten Schlüssel starten oder den Wechsel danach wiederholen |

Nach erfolgreicher Prüfung die Datei `master.key.alt-…` in den Tresor übernehmen und aus dem Volume löschen. Kommt der
Schlüssel aus `BLAULICHTCMS_MASTER_KEY`, gibt der Befehl den neuen Wert aus und lässt API und Worker angehalten, bis er in
`.env` eingetragen und der Container neu erstellt ist (`docker compose up -d`). Bei Verdacht auf Offenlegung zusätzlich
alle Zugangsdaten bei den Gegenstellen erneuern (Abschnitt „Sofortmaßnahmen“): Der neue Schlüssel schützt die Kopie
in der Datenbank, nicht ein bereits abgeflossenes Passwort.

## Sicherung

Ein konsistenter Stand umfasst **Datenbank, Medien und Schlüsselmaterial**. Alles liegt im Volume.
Für den Ernstfall gehört eine Kopie **außerhalb** des aktiven Volumes (anderer Datenträger oder Host).

### Vollständige Sicherung (verschlüsselt)

```bash
cd /opt/apps/blaulichtcms && scripts/backup-volume.sh /opt/apps/blaulichtcms-sicherungen/von-hand
```

Das Skript hält den Container wenige Sekunden an (Datenbank und Medien passen garantiert zusammen), packt das ganze
Volume und **verschlüsselt** das Archiv (`blaulichtcms-<zeitpunkt>.tar.gz.enc`, AES-256-GCM in Blöcken, jeder Block
authentisiert – Veränderung, Austausch oder Abschneiden fällt beim Entschlüsseln auf). Daneben liegt eine
`.sha256`-Prüfsumme. Archiv und Prüfsumme sind nur für root lesbar (`0600`), Sicherungsordner `0700`; ältere,
zu offene Archive und Ordner korrigieren `install.sh` und `backup-cron.sh` beim nächsten Lauf.

### Sicherungsschlüssel

| | |
|---|---|
| Ort | `/etc/blaulichtcms/backup.key` (`BLAULICHTCMS_BACKUP_KEY_FILE`), Ordner `0700`, Datei `0600`, nur root |
| Anlage | `install.sh` erzeugt ihn beim ersten Lauf (32 Zufallsbyte, Base64) |
| Inhalt anzeigen | `sudo cat /etc/blaulichtcms/backup.key` |
| Von Hand anlegen | `head -c 32 /dev/urandom \| base64 \| sudo tee /etc/blaulichtcms/backup.key` (nur, wenn noch keine Sicherungen damit existieren) |

Verbindliche Regeln:

- Der Sicherungsschlüssel liegt **nicht** im Volume und **nicht** im Sicherungsziel. Der Master-Schlüssel
  (`/data/secrets/master.key`) steckt zwar im Archiv, aber nur verschlüsselt – wer eine Kopie vom NAS oder außer Haus
  bekommt, kann ohne Sicherungsschlüssel weder Daten noch Zugangsdaten lesen.
- **Eine Kopie des Sicherungsschlüssels getrennt verwahren** (Passwortmanager/Tresor der Organisation, mindestens zwei
  berechtigte Personen). Ohne ihn lässt sich keine Sicherung wiederherstellen – auch nicht nach Verlust des Hosts.
- Den Schlüssel nicht wechseln, solange ältere Sicherungen noch gebraucht werden; nach einem Wechsel den alten
  Schlüssel bis zum Ablauf der Aufbewahrung mit verwahren.
- Unverschlüsselte Sicherungen nur ausdrücklich: `BLAULICHTCMS_BACKUP_UNENCRYPTED=1` (nicht empfohlen).
- Ältere, unverschlüsselte Archive (`*.tar.gz` von früheren Versionen) enthalten den Master-Schlüssel im Klartext:
  nach der ersten verschlüsselten Sicherung löschen und Kopien außer Haus ersetzen. `install.sh` weist darauf hin.

Entschlüsseln ohne BlaulichtCMS (Notfall, auf jedem Rechner mit Node.js ab 18):

```bash
node scripts/volume-crypt.mjs decrypt backup.key < blaulichtcms-<zeitpunkt>.tar.gz.enc | tar -tzf -   # Inhalt ansehen
```

### Prüfung der Sicherungen (Wiederherstellungstest)

Jede Sicherung wird nach dem Schreiben automatisch geprüft:

| Sicherung | Prüfung | Wann |
|---|---|---|
| Volume-Sicherung (`backup-cron.sh`) | Prüfsumme, vollständiges Entschlüsseln (Echtheit, Vollständigkeit), tar-Inhaltsverzeichnis; Datenbank und Schlüsselmaterial enthalten | nach jeder täglichen Sicherung |
| Volume-Sicherung, Wiederherstellungstest | echte Wiederherstellung in ein Wegwerf-Volume und Start einer Wegwerf-Instanz **ohne Netzwerk** (keine Mails, keine Veröffentlichungen); bestanden bei `/healthz` bereit und Selbsttest in Ordnung; danach wird alles entfernt | sonntags (`BLAULICHTCMS_RESTORE_TEST=woechentlich`, Standard), `taeglich` oder `aus` |
| Datenbanksicherung im Volume | entschlüsseln (Auth-Tag) und `pg_restore --list`; die SHA-256 entsteht schon beim Schreiben (gestreamt, auch bei mehreren GB) | nach jeder Sicherung; besteht sie die Prüfung nicht, gilt sie als fehlgeschlagen und wird entfernt. Scheitert das Schreiben (z. B. Datenträger voll), wird `pg_dump` sofort beendet – kein hängender Prozess mit offener Transaktion |

Fehlschläge erscheinen in BlaulichtCMS als Benachrichtigung für alle mit „Sicherungen erstellen“ und im Systemprotokoll
(Quelle `backup`); `backup-cron.sh` endet zusätzlich mit Fehlercode (Protokoll `/var/log/blaulichtcms-backup.log`, für eine
Mail `MAILTO=` in `/etc/cron.d/blaulichtcms` eintragen und die Ausgabeumleitung entfernen). Von Hand:

```bash
scripts/verify-backup.sh /opt/apps/blaulichtcms-sicherungen/taeglich/blaulichtcms-<zeitpunkt>.tar.gz.enc          # schnell
scripts/verify-backup.sh /opt/apps/blaulichtcms-sicherungen/taeglich/blaulichtcms-<zeitpunkt>.tar.gz.enc --voll   # mit Wegwerf-Instanz
```

Der Wegwerf-Test braucht vorübergehend Platz für ein zweites Volume und so viel Arbeitsspeicher wie die Instanz
(`BLAULICHTCMS_MEM_LIMIT`). **Vierteljährlich** zusätzlich die Wiederherstellung auf einem anderen Host (oder in einer
VM) mit der Kopie außer Haus und dem getrennt verwahrten Sicherungsschlüssel üben und die Prüfliste unten abhaken –
das prüft auch, ob Schlüssel und Ablauf im Ernstfall greifbar sind.

### Sicherung außer Haus (WebDAV)

*Einstellungen → Sicherung → Sicherung außer Haus* (Recht „Sicherungen erstellen“; Ziel ändern mit Passwortbestätigung) legt jede
Datenbanksicherung zusätzlich auf einem WebDAV-Ziel ab (z. B. Synology „WebDAV Server“, HTTPS-Port 5006). Umsetzung:
`server/src/ops/offsite.ts`, Auftrag `backup.offsite` im Worker (4 Versuche mit Wartezeit, Meldung beim letzten).

| | |
|---|---|
| Ablauf | PUT `<name>.part` → GET und SHA-256 mit der lokalen Prüfsumme vergleichen → MOVE auf den endgültigen Namen → Aufbewahrung |
| Aufbewahrung auf dem Ziel | je Tag/ISO-Woche/Monat die neueste Sicherung für die letzten N Tage/Wochen/Monate (Standard **7/4/3**, höchstens 90/52/24; bis 0.6.x Standard 7/4/6 – unveränderte Standardwerte stellt Migration 200 auf 7/4/3, höhere Werte auf die neuen Grenzen); die Oberfläche zeigt die resultierende Frist („gelöschte Daten bleiben bis zu rund N Monate“), mehr als rund 4 Monate nur mit Bestätigung (Audit); die neueste und die eben übertragene bleiben immer; gelöscht werden nur Dateien mit dem Namensmuster `blaulichtcms-…bcbk` bzw. im Unterordner `volume/` `blaulichtcms-…tar.gz.enc` |
| Ausschalten, Zielwechsel | Vorher wählen: Sicherungen auf dem bisherigen Ziel **löschen** (mit Passwortbestätigung, nur Dateien nach Namensmuster samt `.part`, auch `volume/`; scheitert das, wird nichts gespeichert) oder **behalten** – dann erinnert der Systemstatus („Frühere Sicherungsziele“, gelb), bis sie über *Sicherungen auf dem Ziel löschen* entfernt sind oder der Hinweis entfernt wird (am Gerät von Hand aufgeräumt). Nach einem Zielwechsel gilt der Stand „zuletzt übertragen“ nur für das neue Ziel |
| Übertragung | Gesamtfrist 10 Minuten plus Zuschlag nach Größe (rund 1 Mbit/s); beim Zurücklesen und Holen kommt höchstens die erwartete Größe (Ordnerliste bzw. lokale Datei), sonst Abbruch – ein fehlerhaftes Ziel füllt den Datenträger nicht |
| Verschlüsselung | Dateien bleiben BCBK1 (AES-256-GCM, Schlüssel aus dem Master-Schlüssel) bzw. Volume-Archive mit `/etc/blaulichtcms/backup.key` – das Ziel sieht nur Chiffrat |
| Zugangsdaten | Passwort verschlüsselt in `secrets` (Besitzer `setting`), nie in der API; das gespeicherte Passwort wird nur für denselben Host und Benutzer weiterverwendet |
| Netz | nur `https`; SSRF-Schutz bleibt aktiv, freigegeben ist genau der eingetragene Host (auch im internen Netz), keine Weiterleitungen; selbst signierte Zertifikate nur per fest hinterlegtem SHA-256-Fingerabdruck (geprüft vor dem Senden) |
| Volume-Sicherung | `backup-cron.sh` reicht jede neue verschlüsselte Volume-Sicherung per Standardeingabe an `cli.js offsite-volume` weiter (Unterordner `volume/`, Prüfung gegen die `.sha256`-Datei); Exit 3 = kein Ziel eingeschaltet |
| Status | Systemstatus „Sicherung außer Haus“ (rot nach Fehlschlag, gelb nach mehr als 50 Stunden ohne Erfolg), Benachrichtigung „Sicherung fehlgeschlagen“ |

**Warum nicht SMB:** SMB2/3 bräuchte im Container `smbclient` (oder eine eigene Umsetzung von SMB samt NTLMv2) und
damit ein neues Image (`MIN_IMAGE_VERSION`). WebDAV über HTTPS braucht nur Node und deckt NAS-Ziele ab. Wer unbedingt
SMB will, kann das NAS am **Docker-Host** per CIFS einbinden und `BLAULICHTCMS_BACKUP_DIR` dorthin legen – das betrifft
nur `backup-cron.sh`, nicht das Image.

### Probe-Wiederherstellung (Datenbanksicherung)

`server/src/ops/drill.ts`, Auftrag `backup.drill`: Sicherung (lokal oder vom Ziel außer Haus geladen und gegen die
lokale Prüfsumme geprüft) entschlüsseln, Wegwerf-Datenbank `blaulichtcms_probe_<zufall>` in derselben
PostgreSQL-Instanz anlegen (Verbindung `DATABASE_ADMIN_URL` bzw. eingebetteter Superuser), `pg_restore --exit-on-error`,
dann prüfen: Tabellen ≥ 10, `schema_migrations` vorhanden, Benutzerkonten vorhanden, Hash-Kette des Audits mit dem
Schlüssel aus der Sicherung, Ende der Kette gleich dem laufenden Protokoll. Danach wird sie gelöscht – erst wenn die eigenen
Verbindungen wirklich getrennt sind, `WITH (FORCE)` nur als letzter Schritt und nur für genau diese Probedatenbank; die
laufende Datenbank und andere Verbindungen bleiben immer unberührt. Reste abgebrochener Proben (z. B. Neustart während
einer Probe) entfernt die stündliche Wartung des Workers – auch gleich nach dem Start und auch, wenn Proben nach
Zeitplan ausgeschaltet sind – sowie jede neue Probe, sofern niemand mehr mit ihnen verbunden ist und gerade keine Probe
läuft. Ergebnis in `restore_drills` (Oberfläche, Systemstatus),
Fehlschlag als Benachrichtigung. Zeitplan: wöchentlich (Standard) oder monatlich eine Stunde nach der Sicherungszeit (fehlt diese Stunde, z. B. bei der Umstellung auf Sommerzeit, bis zu drei Stunden später; höchstens ein Versuch je Tag),
bevorzugt mit der neuesten Kopie außer Haus. Platzbedarf: etwa die Datenbankgröße; zu wenig freier Speicher bricht
mit klarer Meldung ab. Eine Sicherung von vor einem Wechsel des Master-Schlüssels lässt die Audit-Kette nicht prüfen
(Hinweis im Protokoll, kein Fehler).

### Löschung und Sicherungen

Gelöschte Daten (Medien, Konten, abgelaufene Inhalte) leben in Sicherungen weiter, bis diese rotiert werden. Fristen:

| Sicherung | Aufbewahrung | Einstellung |
|---|---|---|
| tägliche Volume-Sicherung | 14 Stände (≈ 2 Wochen) | `BLAULICHTCMS_KEEP_DAILY` |
| wöchentliche Volume-Sicherung | 8 Stände (≈ 2 Monate) | `BLAULICHTCMS_KEEP_WEEKLY` |
| Sicherung vor Updates (`vor-update/`) | letzte **3**, höchstens **90 Tage** alt | `BLAULICHTCMS_KEEP_PRE_UPDATE`, `BLAULICHTCMS_PRE_UPDATE_MAX_DAYS` (in `/etc/cron.d/blaulichtcms` bzw. beim Aufruf von `install.sh`) |
| Datenbanksicherung im Volume | 14 Stände | *Einstellungen → Sicherung* |
| Kopie außer Haus (Vorschlag) | monatlich, höchstens **3 Monate** aufbewahren, dann vernichten bzw. überschreiben | Betrieb |
| Sicherung außer Haus (WebDAV) | je Tag/Woche/Monat die neueste, Standard 7 Tage, 4 Wochen, **3 Monate** (höchstens 90 Tage, 52 Wochen, 24 Monate; mehr als rund 4 Monate nur mit Bestätigung); nach Ausschalten oder Zielwechsel alte Dateien löschen (Abschnitt oben) | *Einstellungen → Sicherung → Sicherung außer Haus* |

Damit sind gelöschte Daten mit den Standardwerten spätestens nach rund **4 Monaten** aus allen Sicherungen verschwunden
(2 Monate wöchentliche Stände, 3 Monate außer Haus bzw. 3 Monate Kopie außer Haus plus ein Monat Kopierabstand). Wer
außer Haus länger aufbewahrt, trägt die längere Frist ein (die Oberfläche nennt sie). Diese Frist gehört ins Verzeichnis der
Verarbeitungstätigkeiten bzw. in die Auskunft nach Art. 15/17 DSGVO (Vorlage: [datenschutz.md](datenschutz.md)).
Das gilt auch für Löschungen nach den Löschfristen (*Einstellungen → Löschfristen*), für „Sammlung löschen“ und für
Löschungen über *Verwaltung → Datenschutzanfragen*.

**Nach einer Wiederherstellung** sind Löschungen seit dem Sicherungszeitpunkt wieder rückgängig gemacht:

1. Automatische Löschfristen (Einstellungen → Löschfristen, `lib/retention.ts`) greifen beim nächsten Lauf des
   Workers von selbst wieder (stündlich; „Was würde gelöscht?“ zeigt vorab, was fällig ist).
2. Von Hand gelöschte Inhalte im **Audit** ab dem Sicherungszeitpunkt suchen (z. B. `media.deleted`, `collection.deleted`, `user.deleted`)
   und die Löschung erneut ausführen; Löschungen aufgrund von Betroffenenanfragen (Art. 17) gezielt nachholen.
3. Das Nachholen im Audit bzw. in der Dokumentation der Wiederherstellung vermerken.

### Laufende Datenbanksicherung

Zusätzlich erstellt BlaulichtCMS täglich (Einstellungen → Sicherung) eine mit dem Master-Schlüssel verschlüsselte
Datenbanksicherung unter `/data/backups` und prüft sie sofort (entschlüsseln, `pg_restore --list`). Ein Wechsel des
Master-Schlüssels verschlüsselt diese Sicherungen mit neu. Sie ist praktisch zum Herunterladen, ersetzt aber nicht die
Kopie außerhalb des Volumes, weil Medien nicht enthalten sind.

## Wiederherstellung

In einer frischen Instanz (neuer Host oder leeres Volume), mit dem Sicherungsschlüssel unter
`/etc/blaulichtcms/backup.key` (bzw. `BLAULICHTCMS_BACKUP_KEY_FILE`) – als root im Installationsordner (Archive und
Schlüssel gehören root und sind nur für root lesbar):

```bash
sudo -i
cd /opt/apps/blaulichtcms
docker compose down
scripts/restore-volume.sh /opt/apps/blaulichtcms-sicherungen/taeglich/blaulichtcms-2026-11-14-023000.tar.gz.enc
docker compose up -d
```

Das Skript prüft zuerst die Prüfsumme und entschlüsselt das ganze Archiv einmal zur Probe; erst wenn beides stimmt,
packt es in das leere Volume aus. Fehlt die `.sha256`-Datei, bricht es ab (bewusst übergehen: `--ohne-pruefsumme`).
Ältere, unverschlüsselte `.tar.gz` lassen sich weiterhin einspielen. Prüfung und Auspacken laufen im Container als
root – bis 0.7.0 lief die Probe-Entschlüsselung als Benutzer des Images und scheiterte an den root-eigenen Dateien
(„Permission denied“, #275); dasselbe galt für die Prüfung in `scripts/verify-backup.sh`.

Ein **bestehendes** Volume ersetzen (z. B. nach einem fehlgeschlagenen Update): erst die Sicherung prüfen, dann das
Volume entfernen – genau in dieser Reihenfolge, siehe [Rückweg nach fehlgeschlagenem Update](#rückweg-nach-fehlgeschlagenem-update).

**Nur die Datenbank zurückspielen** (Datenbanksicherung `.bcbk`, z. B. vom Ziel außer Haus geholt unter
*Einstellungen → Sicherung → Sicherung außer Haus → Sicherungen auf dem Ziel*, oder von Hand nach `/data/backups` kopiert; in einer
neuen Instanz vorher den Master-Schlüssel aus dem Tresor als `/data/secrets/master.key` hinterlegen):

```bash
docker compose exec blaulichtcms node server/dist/cli.js maintenance on "Wiederherstellung"
docker compose exec blaulichtcms node server/dist/cli.js restore-db blaulichtcms-<zeitpunkt>.bcbk --ja
docker compose restart blaulichtcms     # setzt Eigentum und Rechte der Datenbankrollen neu
```

`restore-db` benennt das Schema `public` um, spielt die Sicherung in ein leeres Schema ein und verwirft erst bei Erfolg
den alten Stand; scheitert das Einspielen, bleibt der bisherige Stand unverändert. Medien sind in der
Datenbanksicherung nicht enthalten.

**Prüfliste nach der Wiederherstellung**

- [ ] `/healthz` meldet 200
- [ ] Anmeldung mit bestehendem Konto funktioniert (inkl. Zwei-Faktor)
- [ ] Benutzer und Rollen vollständig
- [ ] Beiträge mit Fassungen, Freigaben und Veröffentlichungen vorhanden
- [ ] Medien: Vorschauen sichtbar, Original-Download funktioniert
- [ ] offene Veröffentlichungsaufträge werden von der Bridge abgeholt
- [ ] Upload-Links: aktive funktionieren, widerrufene bleiben gesperrt

## Updates

Ablauf: **Sichern → Wechseln → Prüfen → Wiederherstellen** (nur im Fehlerfall). Es gibt zwei Wege:

| Weg | Wofür | Wer |
|---|---|---|
| **In-App-Update** (Einstellungen → Updates) | normale Releases: Programmcode, Oberfläche, Migrationen, WordPress-Plugin | Administration in der Oberfläche |
| **Installationsskript am Docker-Host** (`install.sh`) | alles, was im Image steckt: Basis-Images (Debian, Node.js, PostgreSQL, ffmpeg), Laufzeit-Abhängigkeiten (npm), Supervisor, `compose.yaml`, Skripte; Erstinstallation | Betrieb am Host |

Ein In-App-Update lehnt sich selbst ab, wenn es ein neueres Image braucht, und nennt dann den Befehl am Host.

### Mit dem Installationsskript (empfohlen)

```bash
sudo bash /opt/apps/blaulichtcms/install.sh
```

Es holt den neuen Stand aus dem Repository, baut `blaulichtcms:<version>-<commit>` und ruft damit `scripts/update.sh …
--rollback` auf (Sicherung nach `/opt/apps/blaulichtcms-sicherungen/vor-update`).

Gebaut wird immer mit `docker build --pull`: Die Basis-Images (Node.js, PostgreSQL/Debian, ffmpeg) werden neu
geladen, Sicherheitsupdates landen so beim nächsten Build im Image. Gibt es keinen neuen Code, baut
`sudo bash install.sh --rebuild` das Image trotzdem neu (Tag `blaulichtcms:<version>-<commit>-r<datum>`) und wechselt
mit Sicherung und Rückweg – **monatlich** und nach bekannt gewordenen Lücken in Debian, Node.js oder PostgreSQL.
`install.sh` weist darauf hin, wenn das laufende Image älter als 30 Tage ist. Ist
[Trivy](https://trivy.dev) auf dem Host installiert, prüft `install.sh` das neue Image vor dem Wechsel auf behebbare
hohe/kritische Schwachstellen (Hinweis, kein Abbruch; Bericht in `trivy.log`). Ein Image aus einer Registry lässt sich
auch direkt einspielen:

```bash
scripts/update.sh <neues-image> /opt/apps/blaulichtcms-sicherungen/vor-update --rollback
```

### Freigabe von Updates (Release-Tags und Signatur)

`install.sh` übernimmt nicht blind den neuesten Commit, sondern einen **freigegebenen Stand**:

| `BLAULICHTCMS_UPDATE_CHANNEL` | Stand | Hinweis |
|---|---|---|
| nicht gesetzt (Standard) | neuester Tag `v<version>` auf `main`; gibt es noch keinen Tag, vorerst der neueste Commit auf `main` (mit Warnung) | sobald der erste Tag existiert, folgen Updates automatisch nur noch den Tags |
| `release` | nur Tags `v<version>`; ohne Tag Abbruch | empfohlen für den Echtbetrieb |
| `main` | neuester Commit auf `main` | ohne Freigabeschritt, nur für Test-Instanzen |

Der Kanal wird beim Aufruf mit `BLAULICHTCMS_UPDATE_CHANNEL=…` in `.env` gemerkt. Weitere Schutzmaßnahmen:

- **Kein Rückschritt:** Ist der installierte Stand neuer als der neueste Tag (z. B. nach einem Wechsel von `main`
  auf `release`), bleibt er, bis ein neuerer Tag erscheint.
- **Verschobene Tags** werden nicht übernommen (Abruf ohne `--force`); das Update bricht mit Hinweis ab.
- **Signatur:** Liegt `/etc/blaulichtcms/allowed_signers` vor (oder `BLAULICHTCMS_ALLOWED_SIGNERS=<datei>`), muss der Tag mit
  einem der dort eingetragenen SSH-Schlüssel signiert sein (`git verify-tag`), sonst wird das Update abgelehnt. Für
  GPG-signierte Tags die öffentlichen Schlüssel in den Schlüsselbund von root importieren und
  `BLAULICHTCMS_REQUIRE_SIGNED=1` setzen. Im Kanal `main` wird dann der Commit geprüft (`git verify-commit`).
- **CI-Ergebnis (optional):** Mit `BLAULICHTCMS_REQUIRE_CI=1` übernimmt `install.sh` nur Stände, deren Check-Läufe auf
  GitHub alle erfolgreich waren (bei privatem Repo mit `GITHUB_TOKEN`).

**Freigabe eines Releases (Entwicklung):**

```bash
# einmalig: Signieren mit dem SSH-Schlüssel (auch bei GitHub als „Signing Key“ hinterlegen)
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
# je Release: VERSION erhöhen, committen, CI abwarten, dann signierten Tag setzen und pushen
git tag -s v0.2.0 -m "BlaulichtCMS 0.2.0"
git push origin v0.2.0
```

**Einmalig am Docker-Host:**

```bash
sudo install -d -m 700 /etc/blaulichtcms
echo "release@example.org ssh-ed25519 AAAA…  # öffentlicher Signierschlüssel" | sudo tee /etc/blaulichtcms/allowed_signers
sudo BLAULICHTCMS_UPDATE_CHANNEL=release bash /opt/apps/blaulichtcms/install.sh
```

Das erste Update nach Einführung dieser Prüfung läuft noch mit dem bisherigen `install.sh` (Stand `main`); ab dem
nächsten Aufruf gilt der Kanal.

`scripts/update.sh`

- prüft zuerst das **neue Image** (`scripts/image-selftest.sh`, #275): ohne Netz, ohne Datenvolume, als Benutzer des
  Images – alle Dateien unter `/app` lesbar, Programm samt Paketkonfiguration und nativen Modulen ladbar
  (`cli.js self-check --release`). Besteht es nicht, bricht das Skript ab, bevor irgendetwas geändert wird (Exit 3);
0. prüft **vor** dem Wartungsmodus, ob im Sicherungsziel genug Platz ist;
1. schaltet den **Wartungsmodus** ein: keine neuen schreibenden Vorgänge, keine neuen Hintergrundaufträge, die Bridge
   erhält keine neuen Aufträge (bestehende Banner auf der Website bleiben unverändert);
2. wartet, bis die **Vorabprüfung** bereit meldet (keine laufenden Aufträge, kein Versand und keine Veröffentlichung in
   der Schwebe, genug Speicher);
3. legt eine **vollständige Sicherung außerhalb des Volumes** an (`scripts/backup-volume.sh`, mit Prüfsumme);
4. setzt `BLAULICHTCMS_IMAGE` in `.env` und startet den Container mit dem neuen Image;
5. wartet auf den Healthcheck und den Selbsttest und beendet den Wartungsmodus.

Bricht das Skript **vor** dem Imagewechsel ab (Selbsttest nicht bestanden, Vorabprüfung nicht bereit, zu wenig Platz,
Sicherung fehlgeschlagen), beendet es den Wartungsmodus wieder; der bisherige Stand läuft weiter. Scheitert der Start
des neuen Images (auch `docker compose up` selbst), greift der Rückweg:

1. Das Protokoll des neuen Containers (letzte 150 Zeilen, ohne Zugangsdaten) kommt in die Ausgabe – beim Update-Helfer
   damit in dessen Protokoll und als Auszug in die App –, bevor der Container entfernt wird.
2. Die Sicherung von vor dem Update wird **geprüft** (`scripts/verify-backup.sh`: Prüfsumme, vollständiges
   Entschlüsseln, Archiv lesbar, Datenbank und Schlüssel enthalten). Besteht sie nicht, bleibt das Datenvolume
   unverändert, der neue Container wird angehalten und die Ausgabe nennt den Weg von Hand (Exit 5).
3. Erst dann: Container entfernen, Volume entfernen, Sicherung in ein frisches Volume einspielen, bisheriges Image
   starten, Wartungsmodus aus (Exit 4).

Exit-Codes: `0` erfolgreich, `3` vor dem Wechsel abgebrochen (bisheriger Stand läuft), `4` Wechsel gescheitert und
automatisch zurückgenommen, `5` Handeln nötig (Anleitung in der Ausgabe). `install.sh` formuliert seine
Abschlussmeldung danach. Wartezeit auf einen gesunden Start: `BLAULICHTCMS_HEALTH_TIMEOUT` Sekunden (Standard 180).

Ist der Container **gestoppt** (z. B. nach einem Absturz), nimmt `install.sh` trotzdem den Update-Weg, sobald das
Datenvolume existiert und ein anderes Image eingetragen ist: Sicherung mit dem bisherigen Image, Wechsel, Prüfung und
Rückweg wie oben – nur Wartungsmodus und Vorabprüfung entfallen (ohne laufenden Container gibt es keine laufenden
Vorgänge).

Die Vorabprüfung gibt es auch in der Oberfläche (Einstellungen → Updates & Wartung → „Update vorbereiten“; den Wartungsmodus schaltet man unter Verwaltung → Systemstatus) und auf der
Kommandozeile: `docker compose exec blaulichtcms node server/dist/cli.js preflight`.

### In-App-Update (Einstellungen → Updates & Wartung)

Für normale Releases muss niemand an den Host. Unter **Einstellungen → Updates & Wartung** stehen:

- **Quelle:** GitHub-Repository `besitzer/name` (Standard `thisislennard/BlaulichtCMS`), API-Adresse (Standard
  `https://api.github.com`, nur HTTPS), **Token optional** – ein öffentliches Repository braucht keine Anmeldung. Ein
  Token (nur Leserecht auf Releases, z. B. fein granuliert „Contents: read“) wird verschlüsselt gespeichert und nie
  angezeigt; ändert sich der Host der API-Adresse, wird er verworfen und muss neu eingegeben werden.
- **Prüfung:** automatisch im eingestellten Abstand (1–168 Stunden, Standard 6) und über **„Jetzt prüfen“**. Abgefragt
  wird `GET /repos/<besitzer>/<name>/releases/latest`; ohne Release meldet GitHub 404 („noch kein Release“). Bei einer
  neuen Version erhält „Updates einstellen und installieren“ einmal je Version eine Benachrichtigung; der Systemstatus zeigt
  „Update verfügbar: Version X“. Installiert wird **nie automatisch**. Die Prüfung sendet außer der Versionsangabe im
  User-Agent keine Daten; wer keinen Abruf nach außen möchte, schaltet „Automatisch prüfen“ aus.
- **Neues Image nötig?** Die Versionshinweise jedes Releases enden mit „Neue Image-Basis nötig ab Mindestversion X“
  (`scripts/build-release.mjs`). Ist X neuer als das laufende Image, zeigen Einstellungen → Updates & Wartung, Systemstatus und
  Benachrichtigung das schon bei der Prüfung an: Karte **„Neues Docker-Image nötig“** mit den Schritten am Host statt
  der Schaltfläche „Installieren“ (siehe [Neues Image für eine bestehende Installation](#neues-image-für-eine-bestehende-installation)).
  Maßgeblich bleibt die Prüfung des signierten Pakets (Schritte 3 und 4).
- **Installation** (Recht „Updates einstellen und installieren“, Passwortbestätigung, auditiert, Sicherheitsmeldung):
  1. ZIP, `.sha256` und `.sig` über die Asset-API laden (Größen- und Zeitgrenzen, SSRF-Schutz). Die Weiterleitung zum
     Dateispeicher von GitHub wird ohne `Authorization` und nur über HTTPS verfolgt.
  2. Prüfsumme und **Ed25519-Signatur** gegen den öffentlichen Schlüssel der **laufenden** Version
     (`server/update-signing-key.pub`, Kontext `BlaulichtCMS-Update-Signatur v1`). Ohne angehefteten Schlüssel, bei
     falscher Signatur, bei gleicher oder älterer Version: Abbruch.
  3. Paket prüfen: keine absoluten Pfade, kein `..`, keine symbolischen Links, keine `.env`/Schlüssel/`node_modules`,
     nur erlaubte Orte, Größen- und Dateigrenzen, Pflichtdateien. `manifest.json` nennt die Mindestversion des Images
     und dessen Anforderungen (Node.js, PostgreSQL-Hauptversion, ffmpeg). Ist das Image älter: Abbruch mit dem Hinweis,
     am Host `sudo bash /opt/apps/blaulichtcms/install.sh` auszuführen.
  4. **Laufzeit-Abhängigkeiten:** Das Image enthält kein npm (und keinen Compiler für native Module wie sharp und
     argon2). Die neuen Programmdateien laufen deshalb mit einer Kopie der `node_modules` des laufenden Codes – nur
     wenn die Laufzeit-Abhängigkeiten des Servers laut `package-lock.json` gleich sind. Sonst: „Image-Update nötig“.
  5. Wartungsmodus an, **Update-Vorabprüfung** muss bestehen (bis 3 Minuten Wartezeit auf laufende Aufträge),
     **Datenbanksicherung** (wird vermerkt), Entpacken nach `/data/releases/.staging-…`, Rauchtest
     `cli.js self-check --release` (lädt alle Module inkl. sharp/argon2), dann `/data/releases/<version>`.
  6. Der Supervisor stoppt API und Worker, führt die Migrationen der neuen Version als Eigentümerrolle aus, startet
     API und Worker aus dem Release-Ordner und wartet auf Bereitschaft und `/healthz` (Datenbank, Schema, Worker).
  7. **Rückweg bei jedem Fehler** (Migration, Start, Healthcheck): API und Worker stoppen; wurden Migrationen
     angewendet, spielt die Kommandozeile der vorigen Version die Sicherung zurück (Schema wird beiseitegelegt und erst
     nach erfolgreichem Einspielen gelöscht); Zeiger zurück, vorige Version starten. Eine fehlgeschlagene Migration
     wird nie übersprungen.
  8. Das Ergebnis (aktiviert oder zurückgerollt mit Grund) übernimmt die API ins **Update-Protokoll** (Einstellungen →
     Updates) und ins Audit; der Wartungsmodus endet. Die Oberfläche zeigt währenddessen eine Fortschritts- und
     Neustartanzeige.

**Ablage im Volume:** `/data/releases/<version>/` (Programmdateien mit Kopie der `node_modules`, ca. 300 MB je Release;
die drei neuesten und das aktive bleiben), `current.json` (Zeiger auf das aktive Release), `pending.json`
(Umschaltauftrag), `activation.json` (Ergebnis). Das Volume darf **nicht mit `noexec`** eingehängt sein: native Module
(`.node`) werden aus dem Release-Ordner geladen. Docker-Volumes sind standardmäßig ausführbar; das Wurzeldateisystem
bleibt schreibgeschützt (`read_only: true`). Alles gehört dem Benutzer `blaulichtcms`.

**Welcher Code läuft?** Der Supervisor kommt immer aus dem Image. API, Worker und Migrationen laufen aus dem aktiven
Release, wenn sein Ordner gültig ist und seine Version **neuer** als die des Images ist – sonst aus dem Image, und ein
veralteter Zeiger wird entfernt (z. B. nach `install.sh` mit einem Image derselben oder einer neueren Version). Master-
Schlüssel, Datenbankrollen, Audit-Trigger und Daten liegen unabhängig davon im Volume bzw. in der Datenbank. Die
Kommandozeile (`docker compose exec blaulichtcms node server/dist/cli.js …`) reicht automatisch an das aktive Release
weiter.

**Zusammenspiel mit `install.sh`:** Beide Wege vertragen sich. `install.sh` baut das Image aus einem Release-Tag; ist
dessen Version mindestens so neu wie das installierte In-App-Update, läuft wieder der Image-Code. Die Volume-Sicherung
von `update.sh` enthält `/data/releases` mit.

### Neues Image für eine bestehende Installation

Setzt ein Release `MIN_IMAGE_VERSION` auf seine eigene Version (geänderte Laufzeit-Abhängigkeiten des Servers,
`Dockerfile`, Supervisor, Compose oder Skripte), kommt es nur über `install.sh` am Docker-Host an – auch wenn die
Installation bisher über die Oberfläche aktualisiert wurde:

1. **Oberfläche:** Einstellungen → Updates & Wartung zeigt beim verfügbaren Release die Karte „Neues Docker-Image nötig“
   (mindestens nötige und laufende Image-Version, Befehl zum Kopieren) statt „Installieren“; Systemstatus und
   Benachrichtigung sagen dasselbe. Ein über die API trotzdem gestarteter Versuch bricht nach Download und
   Signaturprüfung ohne jede Änderung ab („Dieses Update braucht ein neueres Docker-Image …“ bzw. „Image-Update
   nötig …“, Eintrag „abgebrochen“ im Update-Protokoll).
2. **Am Docker-Host:** `sudo bash /opt/apps/blaulichtcms/install.sh` (anderer Installationsordner: dessen `install.sh`).
   `--rebuild` ist dafür nicht nötig – die neue Version bekommt ohnehin einen neuen Image-Namen.
3. **Was das Skript tut:** `git fetch --tags`, neuesten Release-Tag auf `main` wählen (Kanal `release`, Standard;
   Signatur- und CI-Prüfung optional), auschecken, Image `blaulichtcms:<version>-<commit>` mit `--pull` bauen (einige
   Minuten, Protokoll `build.log`), Selbsttest des Images (`selftest.log`; ein schon vorhandenes Image mit diesem
   Namen, das ihn nicht besteht, wird ohne Cache neu gebaut), dann `scripts/update.sh … --rollback`: Vorabprüfung und
   Wartungsmodus, Warten auf
   laufende Aufträge, verschlüsselte Volume-Sicherung nach `/opt/apps/blaulichtcms-sicherungen/vor-update`, Wechsel von
   `BLAULICHTCMS_IMAGE` in `.env`, Neustart mit Migrationen, Healthcheck und Selbsttest, Wartungsmodus aus. Bei einem
   Fehler automatisch zurück zum alten Image mit dem Datenstand von vor dem Update.
4. **Was bleibt:** `.env`, Datenvolume, Master- und Sicherungsschlüssel. Ein früher per In-App-Update installiertes
   Release wird nicht mehr verwendet – das neue Image ist mindestens so neu, der Supervisor entfernt den Zeiger und
   startet den Code des Images. Die Release-Ordner in `/data/releases` begrenzt das nächste In-App-Update wieder auf
   die drei neuesten.
5. **Danach:** Einstellungen → Updates & Wartung zeigt „Laufende Version X (aus dem Image)“. Folgende Releases ohne neues Image
   lassen sich wieder in der Oberfläche installieren.

### Image-Updates aus der App (Update-Helfer)

Mit dem **Update-Helfer** lassen sich auch Releases, die ein neues Image brauchen, unter *Einstellungen → Updates & Wartung*
anstoßen – ohne dem Container Zugriff auf Docker (`docker.sock`) oder andere Rechte am Host zu geben (#226).

**Einrichten:** `install.sh` fragt nach dem Update (Standard: einrichten); ohne Rückfrage mit `--with-helper` bzw.
`--no-helper` (die Wahl steht als `BLAULICHTCMS_UPDATE_HELPER` in `.env`). Abschalten und entfernen:
`sudo bash /opt/apps/blaulichtcms/install.sh --remove-helper`. Voraussetzungen: systemd, `setpriv`, `flock` (util-linux).
Eingerichtet werden:

| Datei | Zweck |
|---|---|
| `/etc/systemd/system/blaulichtcms-update.path` | wartet auf `<Datenvolume>/host-update/request.json` (Pfad aus `docker volume inspect blaulichtcms_data`) |
| `/etc/systemd/system/blaulichtcms-update.service` | führt `scripts/host-update-helper.sh run` aus (root, gehärtet: `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem`, `ProtectKernel*` …) |
| `/etc/blaulichtcms/update-helper.env` | Installationsordner, Sicherungsziel, Schlüsseldatei und die beim Einrichten gesetzten Variablen (Proxy für den Build, `BLAULICHTCMS_ALLOWED_SIGNERS` …), nur für root lesbar |
| `/var/log/blaulichtcms-update.log` | Protokoll aller Läufe; Zustand des letzten Laufs in `/var/lib/blaulichtcms-update/` |

**Ablauf:**

1. Die App (Recht „Updates einstellen und installieren“, Passwortbestätigung, Audit, Sicherheitsmeldung) schreibt
   `host-update/request.json` ins Datenvolume: eine Zeile mit Version, Zeitpunkt, Kennung der Anfrage und des Kontos –
   **keine Befehle**. Möglich nur, wenn das zuletzt geprüfte Release neuer ist, ein neueres Image braucht und nichts
   läuft; höchstens eine Anfrage je 10 Minuten.
2. Der Helfer liest die Anfrage mit der Benutzerkennung des Volumes (nie als root), entfernt sie und prüft: höchstens
   1 KB, genau das feste Schema, nicht älter als 15 Minuten, höchstens ein Lauf je 10 Minuten, kein gleichzeitiges
   `install.sh`. Dann holt er die Tags (`git fetch --tags` ohne `--force`), bestimmt **selbst** den neuesten
   Release-Tag und bricht ab, wenn der nicht genau der angefragten Version entspricht oder nicht neuer als das
   laufende Image ist (nie Downgrade). Den Kanal `main` bedient er nicht.
3. **Echtheit:** Das Release-Paket des Tags (`blaulichtcms-update-v<version>.zip` und `.sig` von GitHub) muss eine
   gültige Ed25519-Signatur gegen den angehefteten Schlüssel des installierten Stands (`server/update-signing-key.pub`)
   tragen, und das signierte `manifest.json` muss genau diese Version und den Commit des Tags nennen. Geprüft wird
   ohne Netz und ohne Rechte im bisherigen Image (`scripts/host-update-verify.mjs`). Ist
   `/etc/blaulichtcms/allowed_signers` hinterlegt, muss zusätzlich die Tag-Signatur stimmen. Ohne Release-Paket (z. B.
   privates Repository) und ohne `allowed_signers` lehnt der Helfer ab.
4. Danach läuft `install.sh --unattended` mit genau diesem Tag (`BLAULICHTCMS_EXPECT_TAG`) und `umask 022`: keine
   Rückfragen, nichts wird nachinstalliert oder neu eingerichtet (keine Proxy-Verbindung, kein Cron), sonst der bekannte
   Weg – bauen, Selbsttest, Wartungsmodus, Sicherung, Wechsel, Prüfung, bei Fehler automatischer Rückweg. Endet der Lauf
   nicht erfolgreich, übernimmt der Helfer die Ausgabe von `install.sh` (ohne Zugangsdaten) in
   `/var/log/blaulichtcms-update.log`.
5. Fortschritt (Phase, Schritt, alle 30 Sekunden ein Lebenszeichen) und Ergebnis schreibt der Helfer – wieder mit der
   Kennung des Volumes – nach `host-update/status.json`: `success`, `rolled_back` (Rückweg erfolgreich), `aborted` (vor
   dem Wechsel abgebrochen, bisherige Version läuft), `failed` (Handeln nötig) oder `rejected`, dazu ein
   Protokollauszug ohne Zugangsdaten. Die App zeigt Schritte und Auszug, übernimmt das Ergebnis ins Update-Protokoll
   und benachrichtigt die Verwaltung (Rückweg und Fehler als Sicherheitsmeldung).

Liegt eine Anfrage länger als 2 Minuten unbearbeitet, zeigt die App „Der Update-Helfer hat die Anfrage nicht
angenommen“ und bietet an, sie zurückzuziehen; meldet sich ein laufender Helfer über 10 Minuten nicht, einen Hinweis.
Prüfen am Host: `systemctl status blaulichtcms-update.path blaulichtcms-update`, `tail -100 /var/log/blaulichtcms-update.log`.

**Grenzen:** Ein privates Repository braucht für `install.sh` ein `GITHUB_TOKEN`, das der Helfer nicht hat – dort Updates
weiter von Hand. Der Helfer verwendet die Umgebung vom Einrichten (z. B. `HTTPS_PROXY`); ändert sie sich, `install.sh`
erneut mit den neuen Werten aufrufen. Die Unit-Dateien bringt jeder Lauf von `install.sh` auf den neuen Stand.

**Dateirechte (#275):** Der Dienst läuft mit `UMask=0077` (Protokolle und Zustand nur für root). Bis 0.7.0 erbte
`install.sh` diese umask; `git checkout` schrieb geänderte Dateien dann mit 0600, das Image übernahm die Rechte und der
Container startete nicht („Cannot read package config … permission denied“). Seit 0.7.1 setzt `install.sh` selbst
`umask 022` und vereinheitlicht die Rechte der versionierten Dateien (0644/0755), der Helfer startet es mit `umask 022`,
und das Dockerfile setzt die Rechte in der Build-Stufe unabhängig vom Host. Ein Update von 0.7.0 aus beginnt noch mit
Helfer und `install.sh` 0.7.0: Das holt den neuen Stand (noch mit `umask 077`) und startet dann das neue `install.sh`,
das die Rechte vor dem Build richtet.

**Neue Fassung von `install.sh`:** Holt `install.sh` einen Stand mit geänderter `install.sh`, startet es sich ab dieser
Version selbst neu und läuft mit der neuen Fassung weiter. Bis 0.5.0 lief der Rest eines Updates noch mit der alten
Fassung – wer von 0.5.0 kommt, bekommt die Frage nach dem Helfer deshalb beim **nächsten** Aufruf von `install.sh`.

### In-App-Update: Rückweg von Hand

Scheitert auch der automatische Rückweg (die vorige Version startet nach dem Zurückspielen nicht), zeigt der Webport
eine Sperrseite. Dann:

```bash
cd /opt/apps/blaulichtcms
docker compose logs blaulichtcms | tail -100                   # Grund ansehen
docker compose exec blaulichtcms ls -l /data/backups            # Sicherung von vor dem Update (blaulichtcms-<zeit>.bcbk)
docker compose exec blaulichtcms rm -f /data/releases/current.json   # Zeiger entfernen: Image-Code läuft
docker compose restart blaulichtcms
```

Meldet der Start danach „Datenstand neuer als dieses Programm“, die Sicherung von vor dem Update einspielen
(Abschnitt „Wiederherstellung“, `backup-decrypt` und `pg_restore`) oder die vollständige Volume-Sicherung von
`backup-cron.sh` zurückspielen.

### Release erstellen (Entwicklung)

1. `VERSION`, `server/package.json` und `web/package.json` erhöhen. Ändert sich etwas, das nur mit dem Image ankommt
   (`Dockerfile`, `compose.yaml`, `install.sh`, `scripts/update.sh`, `server/src/main.ts`,
   `server/src/updates/releases.ts`, Laufzeit-Abhängigkeiten), `MIN_IMAGE_VERSION` auf die neue Version setzen –
   `scripts/build-release.mjs` prüft das für die genannten Dateien und die Laufzeit-Abhängigkeiten des Servers
   (`package-lock.json`) seit dem letzten Tag. In den Versionshinweisen dann die Schritte für bestehende Installationen
   nennen (siehe [Neues Image für eine bestehende Installation](#neues-image-für-eine-bestehende-installation)).
2. Committen, CI abwarten, Tag `v<version>` setzen (signiert, siehe oben) und pushen.
3. `.github/workflows/release.yml` baut das Paket (`node scripts/build-release.mjs --tag v<version>`), signiert es in
   einem getrennten Job mit dem Secret `BLAULICHTCMS_UPDATE_SIGNING_KEY` und legt das GitHub-Release mit
   `blaulichtcms-update-v<version>.zip`, `.zip.sha256` und `.zip.sig` an.

**Signaturschlüssel:** Erzeugt mit `node scripts/update-signing.mjs keygen <pfad-außerhalb-des-repos.pem>
--write-public`. Der private Schlüssel liegt nur im Repository-Secret `BLAULICHTCMS_UPDATE_SIGNING_KEY` (PEM-Inhalt) und
in einer sicheren Ablage (Tresor), nie im Repository und nie auf einem Server. Prüfen eines Pakets:
`node scripts/update-signing.mjs verify blaulichtcms-update-v<version>.zip`.

**Schlüsselwechsel:** neuen öffentlichen Schlüssel in `server/update-signing-key.pub` eintragen und dieses Release
noch mit dem **alten** Schlüssel signieren; ab dem nächsten Release gilt der neue. Bei Verdacht auf einen
kompromittierten Schlüssel: Secret löschen, neues Schlüsselpaar, Release mit dem neuen öffentlichen Schlüssel über
`install.sh` (Image) verteilen – In-App-Updates prüfen gegen den Schlüssel der laufenden Version.

### Schema-Migration mit Startprüfung

Der Supervisor führt fehlende Migrationen **vor** dem Start der API als eigenen Schritt aus (jede Migration in einer
eigenen Transaktion, unter Sperre). Zuvor prüft er, ob der Datenstand **neuer als das Programm** ist (die Datenbank
kennt Migrationen, die das Image nicht enthält – typisch nach einer Rückkehr zu einem älteren Image ohne passende
Sicherung).

Schlägt einer der beiden Schritte fehl, **startet BlaulichtCMS nicht**: PostgreSQL läuft weiter (für Sicherung und
Wiederherstellung), der Webport zeigt eine Sperrseite mit dem Grund und `/healthz` antwortet mit 503. Eine
fehlgeschlagene Migration wird vollständig zurückgerollt; die Daten bleiben unverändert.

### Rückweg nach fehlgeschlagenem Update

`scripts/update.sh` gibt diese Befehle mit den echten Werten (bisheriges Image, Archiv, Schlüsseldatei) aus, wenn es
nicht automatisch zurückgehen konnte. Als root im Installationsordner, der Reihe nach:

```bash
sudo -i
cd /opt/apps/blaulichtcms
# Ein verketteter Befehl: erst prüfen – nur wenn die Prüfung besteht, Container und Volume entfernen, einspielen, starten
BLAULICHTCMS_IMAGE=<altes-image> scripts/verify-backup.sh /opt/apps/blaulichtcms-sicherungen/vor-update/blaulichtcms-<zeitpunkt>.tar.gz.enc \
  && docker compose down && docker volume rm -f blaulichtcms_data \
  && BLAULICHTCMS_IMAGE=<altes-image> scripts/restore-volume.sh /opt/apps/blaulichtcms-sicherungen/vor-update/blaulichtcms-<zeitpunkt>.tar.gz.enc \
  && sed -i 's|^BLAULICHTCMS_IMAGE=.*|BLAULICHTCMS_IMAGE=<altes-image>|' .env \
  && docker compose up -d --no-build
# Die Sicherung entstand im Wartungsmodus: beenden, sobald der Container bereit ist
for i in $(seq 1 60); do docker compose exec -T blaulichtcms node server/dist/cli.js maintenance off && break; sleep 5; done
```

Liegt der Sicherungsschlüssel nicht unter `/etc/blaulichtcms/backup.key`, `BLAULICHTCMS_BACKUP_KEY_FILE=<pfad>` vor beide
Skripte setzen. `BLAULICHTCMS_IMAGE` nur je Befehl angeben, nicht exportieren – sonst ginge es auch späteren
`docker compose`-Aufrufen vor `.env`. Das Protokoll des gescheiterten Containers vorher sichern, solange es ihn noch
gibt: `docker compose logs --tail 300 blaulichtcms > /root/blaulichtcms-update-fehler.log`. Die CI führt genau die
ausgegebenen Befehle nach einem Rückweg mit gescheiterter Prüfung aus.

Image **und** passender Datenstand gehören zusammen: Nach einer erfolgreichen Migration lässt sich das alte Image
nicht einfach wieder starten (Startprüfung). Der Rückweg führt immer über die Sicherung von vor dem Update.
Beide Wege – fehlgeschlagene Migration mit automatischem Rückweg und verweigerte Rückkehr zum alten Image – sind in
der Abnahme M4 getestet (`test/e2e/m4-flow.mjs`).

### Versionierte Images

`compose.yaml` verwendet `image: ${BLAULICHTCMS_IMAGE:-blaulichtcms:local}`. Für den Betrieb feste Versionen verwenden
(`…/blaulichtcms:0.5.0`), nie `latest`, damit der Rückweg eindeutig ist.

`install.sh` setzt `blaulichtcms:local` erst **nach** einem erfolgreichen Update auf den neuen Stand. Zeigt der Name aus
`.env` beim Update trotzdem nicht mehr auf das Image des bestehenden Containers (z. B. Handinstallation mit
`blaulichtcms:local`, danach neu gebaut), sichert `scripts/update.sh` das bisherige Image vorher als
`blaulichtcms:rollback-<zeitpunkt>` und nutzt diesen Namen für den Rückweg. Nicht mehr benötigte Rückweg-Images
entfernen: `docker image rm blaulichtcms:rollback-…`.

### Schwachstellenprüfung (festes Intervall)

| Prüfung | Wann | Wo |
|---|---|---|
| `npm audit` (Laufzeit-Abhängigkeiten ab „hoch“, Entwicklungswerkzeuge ab „kritisch“) | jeder Push und **wöchentlich montags** | GitHub-Workflow „Sicherheitsprüfung“ |
| Trivy-Imagescan (Bericht hoch/kritisch; kritische, behebbare Lücken lassen den Lauf scheitern) | jeder Push und wöchentlich | GitHub-Workflow „Sicherheitsprüfung“ |
| Trivy-Secret-Scan des Repositorys | jeder Push | GitHub-Workflow „Sicherheitsprüfung“ |
| Versionsprüfung (npm, Node.js, Basis-Images samt Digest, PostgreSQL, Actions, Playwright) | **wöchentlich montags** | ein Issue „Neue Versionen verfügbar“ (GitHub-Workflow „Versionsprüfung“) |
| Dependabot-Warnungen zu bekannten Schwachstellen (ohne Pull Requests) | laufend | Reiter *Security* auf GitHub |
| Image mit aktuellen Basis-Images neu bauen | **monatlich** und nach bekannt gewordenen Lücken | `sudo bash install.sh --rebuild` |
| optional Trivy am Host vor dem Wechsel | bei jedem Build durch `install.sh`, wenn `trivy` installiert ist | `trivy.log` im Installationsordner |

Ein fehlgeschlagener Lauf meldet GitHub per Mail an die Beobachter des Repositorys. Zuständig für die Bewertung ist
die Entwicklung; eine kritische Lücke im Laufzeitpfad führt zu einem Release und einem Update am Host innerhalb von
**7 Tagen** (Vorschlag).

### Herkunft der Basis-Images

| Image | Quelle | Fixierung |
|---|---|---|
| `node:26-trixie-slim` | offizielles Docker-Hub-Image (Docker Official Images) | Digest im `Dockerfile` |
| `postgres:18-trixie` | offizielles Docker-Hub-Image (Laufzeitbasis, Debian trixie) | Digest im `Dockerfile` |
| `mwader/static-ffmpeg` | Community-Image, statisch gebaut aus den offiziellen ffmpeg-Quellen; Build-Skript und Prüfsummen der Quellen öffentlich auf GitHub (`wader/static-ffmpeg`) | Digest im `Dockerfile`; nur `ffmpeg`/`ffprobe` werden übernommen, die CI kopiert dieselben Dateien |
| `clamav/clamav` (optional) | offizielles Image von Cisco Talos (Docker Hub), nur mit Compose-Profil `clamav` | Digest in `compose.yaml`; Signaturen lädt der Dienst selbst nach (Volume `clamav-db`) |

Gesichtsvorschläge (#214): `onnxruntime-node` (Microsoft, MIT) kommt aus der npm-Registry (Version und Prüfsumme im
`package-lock.json`); im Image bleibt nur die Linux-CPU-Bibliothek der eigenen Architektur, das YuNet-Modell (MIT)
liegt mit Prüfsumme im Repository (`server/assets/models`). Der Build lädt das npm-Paket (rund 115 MB) dank
Build-Cache nur einmal; es werden keine GPU-Bibliotheken nachgeladen (`ONNXRUNTIME_NODE_INSTALL=skip`).

Alle Images sind mit `@sha256:<digest>` fixiert: ein nachträglich neu belegter Tag ändert den Build nicht.
Neue Versionen und Digests meldet die wöchentliche Versionsprüfung (`scripts/check-versions.mjs`, Workflow
„Versionsprüfung“) in genau einem Issue; übernommen werden sie von Hand, die CI baut und prüft sie dann (inkl.
Schwachstellenscan).

Restrisiko ffmpeg: Das ffmpeg-Image stammt von einem Einzelentwickler. Es verarbeitet anonym hochgeladene Videos im
selben Container wie Datenbank und Master-Schlüssel. Ausgleich: fixierter Digest, jede Änderung wird geprüft und
über die CI gebaut, ffmpeg läuft als unprivilegierter Benutzer mit Zeitgrenzen im schreibgeschützten Container (Speicher-, Prozess- und CPU-Grenzen; Abweichung vom Grundsatz „ein Dienst je Container“ und Restrisiko: `docs/architektur.md`, E2) ohne
Capabilities, Uploads sind vorher auf Dateityp geprüft. Eine Alternative wäre das ffmpeg-Paket aus Debian; es würde
den Build aber von Debian-Paketquellen abhängig machen (bisher genügen Docker Hub und npm) und das Image deutlich
vergrößern – bewusst nicht gewählt.

### PostgreSQL-Hauptversion

Der Supervisor vergleicht `/data/postgres/PG_VERSION` mit der PostgreSQL-Version im Image und **startet nicht**,
wenn sie abweichen. Ein Hauptversionswechsel läuft geplant über Export und Import:

```bash
# 1. Mit dem ALTEN Image: Wartungsmodus, logische Sicherung, vollständige Volume-Sicherung
docker compose exec blaulichtcms node server/dist/cli.js maintenance on "PostgreSQL-Wechsel"
docker compose exec -T blaulichtcms sh -c 'pg_dump -h /tmp/blaulichtcms-pg -U blaulichtcms --no-owner --no-privileges blaulichtcms' > blaulichtcms.sql
scripts/backup-volume.sh /srv/blaulichtcms-sicherungen
# 2. Alten Cluster beiseitelegen, NEUES Image starten (legt einen leeren Cluster an)
docker compose stop blaulichtcms
docker run --rm -u 0 -v blaulichtcms_data:/data --entrypoint sh <neues-image> -c 'mv /data/postgres /data/postgres-alt'
docker compose up -d --no-build
# 3. Leere Datenbank ersetzen und den Export einspielen
docker compose exec -T blaulichtcms sh -c "psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d postgres -c 'DROP DATABASE blaulichtcms WITH (FORCE)' -c 'CREATE DATABASE blaulichtcms OWNER blaulichtcms'"
docker compose exec -T blaulichtcms sh -c 'psql -q -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms' < blaulichtcms.sql
docker compose restart blaulichtcms   # Migrationsschritt setzt Eigentum und Rechte der Datenbankrollen
docker compose exec blaulichtcms node server/dist/cli.js maintenance off
# 4. Nach erfolgreicher Prüfung: /data/postgres-alt entfernen
```

Export und Import laufen als Superuser `blaulichtcms`; die eingespielten Objekte gehören zunächst ihm. Der Neustart in
Schritt 3 überträgt sie an `blaulichtcms_owner` und vergibt die Rechte der Laufzeitrolle (Abschnitt „Datenbankrollen“).

In der Abnahme M4 getestet mit einem Datenbestand aus **PostgreSQL 16**, eingespielt in das Image mit
**PostgreSQL 18**: alle Benutzer, Medien, Freigaben und geplanten Aufträge vollständig, Anwendung gesund.

## Notfall-Befehle

```bash
docker compose exec blaulichtcms node server/dist/cli.js password-link admin@example.org   # Passwort-Link (24 h)
docker compose exec blaulichtcms node server/dist/cli.js reset-mfa admin@example.org       # Zwei-Faktor zurücksetzen
docker compose exec blaulichtcms node server/dist/cli.js self-check                        # Bereitschaft prüfen
docker compose exec blaulichtcms node server/dist/cli.js preflight                         # Update-Vorabprüfung
docker compose exec blaulichtcms node server/dist/cli.js maintenance on|off                # Wartungsmodus
docker compose exec blaulichtcms node server/dist/cli.js backup-decrypt <datei> <ziel>     # Datenbanksicherung entschlüsseln
scripts/verify-backup.sh <archiv> [--voll]                                             # Volume-Sicherung prüfen
docker compose exec blaulichtcms node server/dist/cli.js audit-verify                      # Audit-Kette prüfen
docker compose exec blaulichtcms node server/dist/cli.js rotate-master-key --ja           # Master-Schlüssel wechseln (im Wartungsmodus)
```
