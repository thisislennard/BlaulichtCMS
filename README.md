<div align="center">

# BlaulichtCMS

**Selbst gehostetes Redaktionssystem für Öffentlichkeitsarbeit und Krisenkommunikation**

Fotos per Link vom Handy sammeln · sichten · Beiträge schreiben · Fassung freigeben · auf der Website veröffentlichen – nachvollziehbar und auf dem eigenen Server

[![CI](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/ci.yml/badge.svg)](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/ci.yml)
[![Sicherheitsprüfung](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/security.yml/badge.svg)](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/security.yml)
[![Lizenz: GPL-3.0](https://img.shields.io/badge/Lizenz-GPL--3.0--or--later-blue)](LICENSE)
![Version](https://img.shields.io/badge/Version-0.2.0-D21F3C)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ein_Container-2496ED?logo=docker&logoColor=white)
![WordPress](https://img.shields.io/badge/BlaulichtCMS_Bridge-0.7.0-21759B?logo=wordpress&logoColor=white)

</div>

![Dashboard von BlaulichtCMS](docs/bilder/dashboard.webp)

> [!NOTE]
> **Version 0.2.0 – noch vor dem ersten Produktivbetrieb.** Der Funktionsumfang ist vollständig und automatisiert
> getestet; was mit echten Fremdsystemen geprüft ist und was noch nicht, steht unter
> [Teststand und Grenzen](#teststand-und-grenzen). Alle Screenshots stammen aus einer Testinstanz mit fiktiven Daten.

---

## Inhalt

- [Was BlaulichtCMS macht](#was-blaulichtcms-macht)
- [Einblicke](#einblicke)
- [Installation](#installation)
- [Update, Sicherung, Wiederherstellung](#update-sicherung-wiederherstellung)
- [Erste Schritte](#erste-schritte)
- [WordPress verbinden](#wordpress-verbinden)
- [Verbindungen](#verbindungen)
- [Sicherheit](#sicherheit)
- [Leistung](#leistung)
- [Teststand und Grenzen](#teststand-und-grenzen)
- [Entwicklung und Tests](#entwicklung-und-tests)
- [Dokumentation](#dokumentation)
- [Projektstruktur](#projektstruktur)
- [Mitmachen und Lizenz](#mitmachen-und-lizenz)

---

## Was BlaulichtCMS macht

```mermaid
flowchart LR
    H["📱 Handy<br/>Upload-Link / QR-Code"] -->|ohne Konto| Q["Quarantäne<br/>Typ- und Inhaltsprüfung"]
    Q --> S["Sichtung<br/>auswählen / überspringen"]
    S --> B["Beitrag<br/>Fassung n"]
    B -->|einreichen| F{"Freigabe<br/>genau dieser Fassung"}
    F -->|freigegeben| V["Veröffentlichung<br/>beauftragen"]
    V -->|Bridge holt ab| W["🌐 WordPress"]
    W -->|ID + URL| L["✅ bestätigte URL<br/>in BlaulichtCMS"]
```

- **Foto-Link:** Mit einem Klick im Beitrag entsteht eine Sammlung mit befristetem, widerrufbarem Upload-Link. Den Link kann man kopieren, als QR-Code zeigen oder als A4-Aushang drucken. Wer hochlädt, braucht kein Konto.
- **Sicher eingesammelt:** Uploads landen privat in der Quarantäne. BlaulichtCMS prüft Dateityp und Inhalt, erzeugt Vorschauen und eine öffentliche Fassung **ohne Standortdaten**.
- **Sichten am Handy:** Datei für Datei auswählen oder überspringen, per Button, Wischgeste oder Tastatur.
- **Fassungen und Freigaben:** Jede Änderung an Text, Medien oder Zielkanal erzeugt eine neue Fassung. Eine Freigabe gilt genau für eine Fassung (Prüfsumme), auf Wunsch nach dem Vier-Augen-Prinzip.
- **Veröffentlichen ohne offenen Eingang:** Die **BlaulichtCMS Bridge** ist ein WordPress-Plugin, das als ZIP direkt aus BlaulichtCMS kommt. Sie holt Aufträge per HTTPS ab und meldet WordPress-ID und URL zurück. Auch eine doppelte Abholung erzeugt nie einen zweiten Beitrag. Dazu kommen Banner auf der Website und eine Einsatzübersicht.
- **Warnentwurf (MoWaS-Übergabe):** Ein Assistent in sechs Schritten für Erstmeldung, Aktualisierung und Entwarnung. Er schlägt anhand lokal gepflegter, fachlich freigegebener Regeln eine Warnstufe vor oder sagt ehrlich „Keine eindeutige Empfehlung“. Die Stufe bestätigt immer ein Mensch. Die Freigabe fixiert die PDF, der Versand per E-Mail läuft ab Werk im Testmodus. Die amtliche Auslösung bleibt bei der zuständigen Stelle.
- **Optionale Verbindungen:** Facebook, Instagram, FE2 und amtliche Warnungen durchlaufen alle denselben Ablauf: **Verbinden → Testen → Vorschau → Aktivieren**.
- **Datenschutz eingebaut:** Datenschutzinformation auf der Upload-Seite, Markierungen für erkennbare Personen und sensible Inhalte, Unkenntlichmachen und Zuschneiden der öffentlichen Fassung, Löschfristen mit Vorschau, Auskunft und Löschung je Person, Vorlagen für Verarbeitungsverzeichnis und DSFA.
- **Ein Container:** Webanwendung, App für das Handy, Worker und PostgreSQL stecken in einem Image, die Daten in einem Volume. Das Installationsskript führt durch die Einrichtung.
- **Updates aus der App:** Neue Versionen erscheinen unter *Einstellungen → Updates* und lassen sich per Klick einspielen – nur mit gültiger Signatur, mit Sicherung vorab und automatischem Rückweg, falls etwas schiefgeht.
- **Design „Leitstand“:** Ruhig und schnell lesbar, auch draußen am Handy und nachts im Dunkelmodus. Signalrot ist der einzige Akzent ([Design-Regeln](docs/design-leitstand.md)).

---

## Einblicke

<table>
  <tr>
    <td width="33%"><b>Upload am Handy</b><br/>ohne Konto, Fortschritt je Datei<br/><br/><img src="docs/bilder/upload-handy.webp" alt="Upload-Seite am Handy"/></td>
    <td width="33%"><b>Sichtung</b><br/>Auswählen oder Überspringen<br/><br/><img src="docs/bilder/sichtung-handy.webp" alt="Sichtung am Handy"/></td>
    <td width="33%"><b>Beitrag am Handy</b><br/>Status, Freigabe, bestätigte URL<br/><br/><img src="docs/bilder/beitrag-handy.webp" alt="Beitrag am Handy"/></td>
  </tr>
  <tr>
    <td colspan="2"><b>Beitrag mit Freigabe</b><br/>Fassungen, Prüfsumme, Veröffentlichungen<br/><br/><img src="docs/bilder/beitrag.webp" alt="Beitrag mit Freigabe"/></td>
    <td><b>Sammlung</b><br/>Upload-Links mit QR-Code und Aushang<br/><br/><img src="docs/bilder/sammlung.webp" alt="Sammlung"/></td>
  </tr>
  <tr>
    <td colspan="2"><b>Auf der Website</b><br/>veröffentlicht von der BlaulichtCMS Bridge<br/><br/><img src="docs/bilder/wordpress-beitrag.webp" alt="Beitrag auf WordPress"/></td>
    <td><b>Hilfe-Center</b><br/>24 Kapitel mit Volltextsuche<br/><br/><img src="docs/bilder/hilfe.webp" alt="Hilfe-Center"/></td>
  </tr>
  <tr>
    <td><b>Warnentwurf am Handy</b><br/>Stichwort, Lagefragen, Vorschlag<br/><br/><img src="docs/bilder/warnentwurf-handy.webp" alt="Warnentwurf-Assistent am Handy"/></td>
    <td><b>Freigegebene PDF</b><br/>mit bestätigter Warnstufe und Prüfsumme<br/><br/><img src="docs/bilder/warnentwurf-pdf.webp" alt="PDF eines Warnentwurfs"/></td>
    <td><b>Regeln pflegen</b><br/>versioniert, fachlich freigegeben<br/><br/><img src="docs/bilder/warnstufen-regeln.webp" alt="Pflege der Warnstufen-Regeln"/></td>
  </tr>
</table>

---

## Installation

BlaulichtCMS läuft auf einem Linux-Server mit Docker: ein Ordner unter `/opt/apps`, ein gemeinsames Docker-Netz
`proxy-net` und davor ein HTTPS-Reverse-Proxy (z. B. Nginx Proxy Manager).

```mermaid
flowchart LR
    B["🌐 Browser / Handy"] -->|HTTPS| P["Reverse Proxy<br/>Nginx Proxy Manager"]
    P -->|"Netz proxy-net<br/>http://blaulichtcms:7310"| L["Container blaulichtcms<br/>API · Worker · PostgreSQL"]
    L --- V[("Volume<br/>blaulichtcms_data")]
    WP["WordPress + Bridge"] -->|"HTTPS, holt Aufträge ab"| P
```

### Voraussetzungen

| | |
|---|---|
| Server | Linux (z. B. Ubuntu 22.04/24.04 oder Debian 12/13), 2 CPU-Kerne und 4 GB RAM oder mehr |
| Software | Docker mit Compose-Plugin (`docker compose`), `git`, `curl` – fehlt etwas, bietet `install.sh` die Installation an |
| Speicher | mindestens 200 GB für `/var/lib/docker` (Fotos und Videos), Sicherungsziel möglichst auf einem anderen Datenträger |
| Netz | Reverse Proxy mit HTTPS-Zertifikat und einem DNS-Namen für BlaulichtCMS, z. B. `blaulichtcms.example.org` |

### Schritt 1: Installationsskript auf den Server holen

```bash
curl -fsSL https://raw.githubusercontent.com/thisislennard/BlaulichtCMS/main/install.sh -o install.sh
less install.sh   # vor dem Ausführen ansehen
```

Für einen privaten Fork: `BLAULICHTCMS_REPO=https://github.com/<konto>/<fork>.git` setzen; das Skript fragt dann nach
einem GitHub-Token mit Leserecht (*Contents: Read-only*) und speichert es nirgends.

### Schritt 2: Installieren

```bash
sudo bash install.sh
```

Das Skript führt durch alles Weitere und fragt nur zwei Dinge:

1. die **öffentliche Adresse**, z. B. `https://blaulichtcms.example.org`
2. **wo der Reverse Proxy läuft**: als Docker-Container auf diesem Server (z. B. Nginx Proxy Manager), direkt auf
   diesem Server (nginx, Caddy, Apache) oder auf einem anderen Server (z. B. IIS)

| Schritt | Was passiert |
|---|---|
| Voraussetzungen | bietet an, fehlendes Docker, git und curl zu installieren |
| Code | holt den neuesten freigegebenen Stand nach `/opt/apps/blaulichtcms` |
| Konfiguration | legt `.env` an; Port-Bindung und vertrauenswürdige Proxy-Adressen (`TRUSTED_PROXIES`) ergeben sich aus der Art des Proxys; ist Port 7310 belegt, schlägt es einen anderen vor |
| Netz | legt `proxy-net` an, erkennt einen Proxy-Container und verbindet ihn auf Wunsch |
| Image | baut `blaulichtcms:<version>-<commit>` (beim ersten Mal einige Minuten) |
| Start | startet den Container `blaulichtcms` und wartet, bis er gesund meldet |
| Sicherung | richtet auf Wunsch die tägliche, verschlüsselte Sicherung ein |
| Reverse Proxy | zeigt die passenden Werte zum Abtippen, wartet und **prüft die öffentliche Adresse** – bei einem Fehler mit Ursache (DNS, Zertifikat, Ziel nicht erreichbar …) |
| Sicherungsschlüssel | zeigt ihn an und lässt bestätigen, dass er getrennt abgelegt ist |
| Abschluss | zeigt Adresse und **Einrichtungsschlüssel** für die Ersteinrichtung im Browser |

Das Skript lässt sich jederzeit erneut starten – bei einer bestehenden Installation ist das ein Update.

### Schritt 3: Ersteinrichtung im Browser

Die angezeigte Adresse `…/einrichtung` öffnen, Einrichtungsschlüssel, Organisation und Zeitzone eingeben und das erste
Konto mit Zwei-Faktor-Anmeldung anlegen. Danach unter *Einstellungen → Datenschutz* Verantwortlichen und
Datenschutzerklärung eintragen und unter *Verwaltung → Benutzer und Rollen* die Redaktion einladen.

Werte für den Reverse Proxy zum Nachschlagen (Nginx Proxy Manager: Ziel `http` / `blaulichtcms` / `7310`, Advanced-Block)
und Beispiele für nginx, Caddy, Traefik, HAProxy und IIS: [docs/reverse-proxy.md](docs/reverse-proxy.md).

### Optionen des Installationsskripts

| Variable / Schalter | Bedeutung | Standard |
|---|---|---|
| `--yes` | ohne Rückfragen (dann `BLAULICHTCMS_PUBLIC_URL` vorgeben) | – |
| `--rebuild` | Image ohne Codeänderung mit aktuellen Basis-Images neu bauen | – |
| `--no-cron` | keine tägliche Sicherung einrichten | – |
| `BLAULICHTCMS_DIR` | Installationsordner | `/opt/apps/blaulichtcms` |
| `BLAULICHTCMS_BACKUP_DIR` | Ziel der täglichen Sicherung (z. B. eingebundenes NAS) | `/opt/apps/blaulichtcms-sicherungen` |
| `BLAULICHTCMS_PUBLIC_URL` | öffentliche Adresse | Rückfrage |
| `BLAULICHTCMS_PROXY_MODE` | Art des Reverse Proxys: `1` Container auf diesem Server, `2` direkt auf diesem Server, `3` anderer Server | Rückfrage (`1`) |
| `BLAULICHTCMS_PROXY_IP` | IP des Reverse Proxys bei Art `3` | Rückfrage |
| `BLAULICHTCMS_BIND` / `BLAULICHTCMS_PORT` | Schnittstelle und Port am Host | `127.0.0.1` / `7310` |
| `BLAULICHTCMS_PROXY_NETWORK` | Docker-Netz des Reverse Proxys | `proxy-net` |
| `BLAULICHTCMS_REPO` | Quelle des Codes (eigener Fork) | dieses Repository |
| `BLAULICHTCMS_UPDATE_CHANNEL` | `release` (neuester Tag `v*`) oder `main` | `release`, solange es Tags gibt |
| `GITHUB_TOKEN` | nur für private Forks: Leserecht auf das Repository | Rückfrage bei Bedarf |
| `HTTPS_PROXY`, `NO_PROXY` | ausgehender Proxy für den Image-Build | – |
| `BLAULICHTCMS_BUILD_CA` | PEM-Datei einer Proxy-CA, falls der Proxy TLS aufbricht | – |

Beispiel ohne Rückfragen:
`sudo BLAULICHTCMS_PUBLIC_URL=https://blaulichtcms.example.org bash install.sh --yes`

### Was wo liegt

| | |
|---|---|
| Programm und `.env` | `/opt/apps/blaulichtcms` |
| Container | `blaulichtcms` (in `docker compose`-Befehlen heißt der Dienst `blaulichtcms`) |
| Daten (Datenbank, Medien, Hauptschlüssel) | Volume `blaulichtcms_data` |
| Sicherungen | `/opt/apps/blaulichtcms-sicherungen` (`taeglich/`, `woechentlich/`, `vor-update/`) |
| Protokolle | `docker compose logs -f blaulichtcms`, Sicherung: `/var/log/blaulichtcms-backup.log` |

> [!IMPORTANT]
> Die Sicherungen sind mit einem eigenen Sicherungsschlüssel verschlüsselt (`/etc/blaulichtcms/backup.key`, legt
> `install.sh` an). **Eine Kopie dieses Schlüssels getrennt verwahren** (Passwortmanager/Tresor) – ohne ihn ist keine
> Wiederherstellung möglich. Mindestens einmal im Monat eine Kopie der Sicherungen außer Haus bringen. `docker compose down -v` löscht das Volume
> und damit **alle Daten**. Für Neustarts und Updates nie `-v` verwenden.

---

## Update, Sicherung, Wiederherstellung

| Aufgabe | Befehl | Hinweis |
|---|---|---|
| **Update in der Oberfläche** | *Einstellungen → Updates* | normale Releases aus GitHub (Standard: dieses Repository, öffentlich – ohne Anmeldung, Token nur für private Repositories). Nur mit gültiger Signatur, mit Wartungsmodus, Datenbanksicherung und automatischem Rückweg; siehe [docs/betrieb.md](docs/betrieb.md#in-app-update-einstellungen--updates) |
| **Update am Host** | `sudo bash /opt/apps/blaulichtcms/install.sh` | holt den neuen Stand, baut das Image, sichert, wechselt, prüft. Bei einem Fehler wird automatisch der vorherige Stand mit den vorherigen Daten wiederhergestellt |
| Freigabe | Release-Tag `v<version>` (signiert) | Updates folgen dem neuesten Tag; Signaturprüfung mit `/etc/blaulichtcms/allowed_signers`, siehe [docs/betrieb.md](docs/betrieb.md#freigabe-von-updates-release-tags-und-signatur) |
| Basis-Images erneuern | `sudo bash /opt/apps/blaulichtcms/install.sh --rebuild` | monatlich: baut das Image ohne Codeänderung mit aktuellen Basis-Images (Sicherheitsupdates von Debian, Node.js, PostgreSQL) neu und wechselt mit Sicherung und Rückweg |
| Sicherung jetzt | `cd /opt/apps/blaulichtcms && scripts/backup-volume.sh /pfad/zum/ziel` | vollständig (Datenbank, Medien, Schlüssel), verschlüsselt, mit Prüfsumme; der Container hält dafür wenige Sekunden an |
| Tägliche Sicherung | `/etc/cron.d/blaulichtcms` → `scripts/backup-cron.sh` | richtet `install.sh` ein; Aufbewahrung über `BLAULICHTCMS_KEEP_DAILY` und `BLAULICHTCMS_KEEP_WEEKLY`; Sicherungen vor Updates: letzte 3, höchstens 90 Tage (`BLAULICHTCMS_KEEP_PRE_UPDATE`, `BLAULICHTCMS_PRE_UPDATE_MAX_DAYS`) |
| Sicherung prüfen | `scripts/verify-backup.sh <archiv> [--voll]` | läuft nach jeder täglichen Sicherung automatisch; `--voll` (sonntags automatisch) stellt in eine Wegwerf-Instanz ohne Netzwerk wieder her |
| Wiederherstellung | `scripts/restore-volume.sh <archiv>` | in ein leeres Volume, siehe [docs/betrieb.md](docs/betrieb.md#wiederherstellung) |
| Status | `docker compose ps` und `curl -s http://127.0.0.1:7310/healthz` | in BlaulichtCMS unter *Verwaltung → Systemstatus* |
| Notfall | `docker compose exec blaulichtcms node server/dist/cli.js password-link <email>` | weitere Befehle in [docs/betrieb.md](docs/betrieb.md#notfall-befehle) |

Für die Betriebswerte (Speicher, Aufbewahrung, Wiederanlaufzeit) gibt es einen Vorschlag in
[docs/betrieb.md](docs/betrieb.md#betriebsfestlegungen-vorschlag-bitte-bestätigen).

---

## Erste Schritte

Ein Durchlauf in etwa zehn Minuten:

1. **Einladen:** *Benutzer und Rollen → Benutzer einladen*, Rollen z. B. „Redaktion“ und „Medienverwaltung“. Den Link aufs Handy schicken, dort das Passwort setzen.
2. **Beitrag:** *Beiträge → Neuer Beitrag*.
3. **Sammeln:** Im Beitrag *Fotos und Videos sammeln*, QR-Code anzeigen, mit einem zweiten Handy scannen und ein Foto hochladen.
4. **Sichten:** *Medien → Sammlung → sichten*, dann **Auswählen**.
5. **Schreiben:** Text eingeben, *Medien übernehmen*, **Neue Fassung speichern**, **Zur Freigabe einreichen**.
6. **Freigeben:** Eine berechtigte Person gibt frei. Ohne Zielkanal ist der Beitrag jetzt *intern freigegeben*.
7. **Veröffentlichen:** Website koppeln (siehe unten), Zielkanal wählen, erneut freigeben, **Veröffentlichen**. Nach dem nächsten Abruf der Bridge steht die URL im Beitrag und im Dashboard.

Ausführlich im Hilfe-Center der App (`/hilfe`). Derselbe Ablauf läuft automatisiert als Abnahmetest:
[`test/e2e/m1-flow.mjs`](test/e2e/m1-flow.mjs).

---

## WordPress verbinden

1. In BlaulichtCMS *Kanäle → Websites → Bridge herunterladen* (ZIP, aktuell Version 0.7.0).
2. In WordPress *Plugins → Installieren → Plugin hochladen*, dann aktivieren.
3. In BlaulichtCMS *Website koppeln*, den einmaligen **Kopplungscode** notieren (30 Minuten gültig).
4. In WordPress *Einstellungen → BlaulichtCMS Bridge* die BlaulichtCMS-Adresse (`https://…`) und den Code eintragen, dann **Koppeln**.

Die Bridge holt jede Minute über WP-Cron ab. Zuverlässiger ist zusätzlich ein Host-Cron:

```cron
* * * * * wp --path=/var/www/html blaulichtcms-bridge poll
```

Banner erscheinen automatisch am Seitenanfang (abschaltbar), alternativ per Block „BlaulichtCMS: Hinweise“ oder
`[blaulichtcms_banner]`. Die Einsatzübersicht kommt per `[blaulichtcms_einsaetze]`. Abgelaufene Banner verschwinden auch aus
zwischengespeicherten Seiten. Getestet ist die Bridge mit WordPress 7.1 und PHP 8.5, HTTPS mit Zertifikatsprüfung,
WP-Cron, Host-Cron und WP Super Cache ([Ergebnis](docs/integrationen.md)). Schnittstelle: [docs/bridge-api.md](docs/bridge-api.md).

---

## Verbindungen

Alle Verbindungen sind optional und laufen unter *Kanäle → Verbindungen* nach dem Muster
**Verbinden → Testen → Vorschau → Aktivieren**.

| Verbindung | Wofür | Geprüft |
|---|---|---|
| WordPress (Bridge) | Beiträge, Banner, Einsatzübersicht; Updates mit Ed25519-Signatur | echtes WordPress mit HTTPS |
| FE2 | interner Entwurf je Einsatz; Feldzuordnung je Instanz | mit nachgebildeten Meldungen |
| Amtliche Warnungen | Warn-App-Schnittstelle des Bundes (Kreis-ARS) oder CAP, Banner mit Quellenvermerk | echte Schnittstelle |
| Facebook / Instagram | Veröffentlichung und Zurückziehen je Kanal mit eigenem Status (Graph API v26.0) | gegen nachgebildete Graph API |
| E-Mail (Warnentwurf) | PDF-Versand an die zuständige Stelle, STARTTLS/TLS | Mailserver mit TLS |
| Medienimport | einmalige Übernahme von Medien und gültigen Upload-Links aus einem Altsystem (Austauschformat; Exportskript für LiFeOS) | mit fiktiven Daten |

Details und Einrichtung: [docs/integrationen.md](docs/integrationen.md), Hilfe → *Verbindungen*.

---

## Sicherheit

| Bereich | Umsetzung |
|---|---|
| Rechte | serverseitig bei jeder API, jeder Datei und jeder Aktion; Standard „verweigert“; Rollen kombinierbar; Vier-Augen-Prinzip für Beiträge, Banner und Warnentwürfe |
| Anmeldung | Argon2id, Zwei-Faktor (TOTP) mit Wiederherstellungscodes, erneute Bestätigung für kritische Aktionen, Sperre nach Fehlversuchen ohne Aussperren bekannter Geräte, CSRF-Schutz |
| Uploads | nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen; Quarantäne; Inhaltsprüfung; optional Virenscan (ClamAV); Drosselung je IP |
| Medien | privat außerhalb des Webservers; Standort- und Kameradaten werden entfernt; Unkenntlichmachen für die öffentliche Fassung |
| Websites | Schlüssel je Website (nur Prüfsumme gespeichert), sofort widerrufbar; die Bridge ruft nur aus, nur per HTTPS |
| Datenbank | nur über Unix-Socket im Container; die Anwendung arbeitet mit einer Rolle ohne Superuser- und DDL-Rechte |
| Audit | Hash-Kette gegen nachträgliche Änderungen, optional an Syslog weitergeleitet; Alarmierung bei Sicherheitsereignissen |
| Sicherungen | verschlüsselt (AES-256-GCM) mit eigenem Schlüssel, regelmäßige Probe-Wiederherstellung |
| Updates | Releases mit Ed25519 signiert (privater Schlüssel nie auf dem Server), geprüft gegen den Schlüssel der laufenden Version; Sicherung vorab und automatischer Rückweg; Bridge-Updates ebenso signiert |
| Container | unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities, Grenzen für Speicher, CPU und Prozesse, Port standardmäßig nur lokal |

Ergebnis der Sicherheitsprüfung (BSI IT-Grundschutz): [docs/sicherheitspruefung.md](docs/sicherheitspruefung.md),
Datenschutz: [docs/datenschutz.md](docs/datenschutz.md). **Sicherheitslücken bitte nicht als öffentliches Issue
melden** – Vorgehen in [SECURITY.md](SECURITY.md).

---

## Leistung

- Seiten werden einzeln nachgeladen, der Build ist mit Brotli vorkomprimiert. Der erste Aufruf am Handy lädt rund 180 KB, danach kommt fast alles aus dem Browser-Cache.
- Die Sichtung reagiert sofort und lädt das nächste Bild vor. Uploads laufen in Teilen, zwei parallel, und lassen sich ohne Doppelanlage wiederholen.
- Beitragsliste und Dashboard brauchen je eine Datenbankabfrage. PostgreSQL ist für SSD eingestellt.
- Lasttest (Produktions-Build, 50 gleichzeitige Verbindungen): Dashboard rund 1 000 Anfragen/s bei p99 52 ms, Startseite rund 3 750 Anfragen/s, ohne Fehler ([docs/betrieb.md](docs/betrieb.md)).

---

## Teststand und Grenzen

**Automatisiert (bei jedem Push in der CI):** Typprüfung, rund 200 Server-Tests gegen echtes PostgreSQL (inklusive
Video-Verarbeitung mit ffmpeg), Build, PHP-Lint des Plugins, Probelauf mit Docker Compose (Rollen, Schlüsselwechsel,
Audit-Kette), Abhängigkeits-, Image- und Secret-Scan. Dazu kommen Abnahmetests über Browser, Container und ein
Test-WordPress (`test/e2e/`, Foto-Link bis Website, fortsetzbarer Upload, Warnentwurf, fehlgeschlagenes Update mit
Rückweg, Wiederherstellung, PostgreSQL-Upgrade). Das Update aus der App ist mit dem echten Supervisor durchgespielt
(Aktivierung, Rückweg bei fehlerhafter Migration und bei Absturz der neuen Version).

**Mit echten Systemen geprüft:** WordPress 7.1 / PHP 8.5 mit HTTPS, WP-Cron, Host-Cron und Seitencache; die
Warn-App-Schnittstelle des Bundes; Mailversand mit STARTTLS/TLS; QR-Aushänge unter erschwerten Bedingungen.
Ergebnisse je Verbindung: [docs/integrationen.md](docs/integrationen.md).

**Noch nicht geprüft bzw. vor dem Echtbetrieb zu klären:**

- Betrieb auf einem Zielhost mit echten Datenmengen (Wiederherstellung, PostgreSQL-Upgrade, Last), externer Penetrationstest
- Meta-App mit App-Prüfung (Facebook/Instagram), FE2-Meldungen einer echten Instanz
- Warnentwurf: Die mitgelieferte Vorlage ist ein **nicht abgestimmtes Beispiel**, Warnstufen-Regeln gibt es ab Werk
  keine. Vorlage, Empfänger und Rückmeldeweg mit der zuständigen Stelle abstimmen, Regeln fachlich freigeben. Die
  Weiterverwendung amtlicher Warninhalte (MoWaS) vor dem Einschalten automatischer Banner mit dem BBK klären.
- Datenschutz: Angaben unter *Einstellungen → Datenschutz* ausfüllen, Verarbeitungsverzeichnis und DSFA mit den
  Vorlagen in [docs/datenschutz.md](docs/datenschutz.md) erstellen.

---

## Entwicklung und Tests

```bash
npm ci
npm run typecheck && npm run build
# Server-Tests gegen eine Wegwerf-Datenbank (wird bei jedem Lauf geleert!), Datenbank mit UTF8 anlegen
TEST_DATABASE_URL=postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5442/blaulichtcms_test npm test
npm run dev:server & npm run dev:worker & npm run dev:web                     # http://localhost:5173
```

**Release erstellen:** `VERSION` sowie `server/package.json` und `web/package.json` erhöhen (bei Änderungen am Image
auch `MIN_IMAGE_VERSION`), Versionshinweise in `release-notes/v<version>.md` schreiben, committen, CI abwarten und den
Tag `v<version>` pushen. Der Workflow *Release* baut das Paket, signiert es in einem getrennten Job (Secret
`BLAULICHTCMS_UPDATE_SIGNING_KEY`) und legt das GitHub-Release an; Installationen sehen es unter *Einstellungen → Updates*.

Die Abnahmetests (`test/e2e/`) brauchen Docker, Playwright und ein Test-WordPress. Lokale Umgebung, auch ohne Docker
unter Windows: [docs/entwicklung.md](docs/entwicklung.md). Beiträge sind willkommen: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/betrieb.md](docs/betrieb.md) | Start, Betriebswerte, Lasttest, Sicherung, Wiederherstellung, Updates, Datenbankrollen, Schlüsselwechsel, Protokollierung und Sicherheitsvorfälle, Notfall |
| [docs/reverse-proxy.md](docs/reverse-proxy.md) | HTTPS mit Nginx Proxy Manager, nginx, Caddy, Traefik, HAProxy, IIS |
| [docs/integrationen.md](docs/integrationen.md) | Stand und Einrichtung je Verbindung, Ergebnisse der Live-Tests |
| [docs/import.md](docs/import.md) | einmaliger Medienimport (Austauschformat, alte Links, Exportskript für LiFeOS) |
| [docs/bridge-api.md](docs/bridge-api.md) | Schnittstelle zwischen BlaulichtCMS und der BlaulichtCMS Bridge |
| [docs/bridge-signatur.md](docs/bridge-signatur.md) | Code-Signatur der Bridge-Updates (Ed25519) |
| [docs/design-leitstand.md](docs/design-leitstand.md) | Design „Leitstand“: Farben, Schrift, Komponenten, Ausnahmen |
| [docs/architektur.md](docs/architektur.md) | Aufbau und Architekturentscheidungen |
| [docs/sicherheitspruefung.md](docs/sicherheitspruefung.md) | Ergebnis der Sicherheitsprüfung mit Nachweisen |
| [docs/datenschutz.md](docs/datenschutz.md) | Datenschutz: Datenkategorien, Empfänger, Löschfristen, TOMs, Vorlagen für Verarbeitungsverzeichnis und DSFA |
| [docs/entwicklung.md](docs/entwicklung.md) | Entwicklungsumgebung |
| Hilfe-Center in der App (`/hilfe`) | 24 Kapitel für Redaktion und Administration |

---

## Projektstruktur

| Ordner / Datei | Inhalt |
|---|---|
| `install.sh` | Installation und Update am Docker-Host |
| `compose.yaml`, `Dockerfile`, `.env.example` | Dienst `blaulichtcms` (ein Container), Netz `proxy-net`, Konfiguration |
| `server/` | TypeScript, Fastify: API, Worker, Supervisor mit internem PostgreSQL, Medienprüfung, Updates aus GitHub-Releases (`src/updates/`), CLI |
| `server/migrations/` | SQL-Migrationen (laufen beim Start, mit Startprüfung) |
| `server/test/` | Unit- und Integrationstests gegen echtes PostgreSQL |
| `web/` | Oberfläche und App: React 19, Vite, Tailwind 4, TanStack Query |
| `web/src/pages/help/content/` | Kapitel des Hilfe-Centers (Markdown) |
| `wordpress-plugin/blaulichtcms-bridge/` | WordPress-Plugin BlaulichtCMS Bridge (PHP) |
| `scripts/` | Sicherung (`backup-volume.sh`, `backup-cron.sh`, Verschlüsselung `volume-crypt.mjs`, Prüfung `verify-backup.sh`), Wiederherstellung, Update am Host, Release-Paket (`build-release.mjs`), Signaturen (`update-signing.mjs`, `bridge-signing.mjs`), LiFeOS-Export |
| `release-notes/`, `VERSION`, `MIN_IMAGE_VERSION` | Versionshinweise je Release, aktuelle Version, Mindestversion des Images für Updates aus der App |
| `.github/workflows/` | CI (Tests, Build, Docker-Probelauf), Sicherheitsprüfung (Abhängigkeiten, Image, Secrets), Release (bauen, signieren, veröffentlichen) |
| `test/e2e/`, `test/wordpress/` | Abnahmetests über Container, Browser und ein Test-WordPress |

---

## Mitmachen und Lizenz

Fehlerberichte und Verbesserungsvorschläge gern als [Issue](https://github.com/thisislennard/BlaulichtCMS/issues),
Pull Requests sind willkommen – Regeln und Entwicklungsumgebung in [CONTRIBUTING.md](CONTRIBUTING.md).
**Sicherheitslücken bitte nicht öffentlich**, sondern über *Security → Report a vulnerability* melden
([SECURITY.md](SECURITY.md)).

Lizenz: [GPL-3.0-or-later](LICENSE). Das WordPress-Plugin BlaulichtCMS Bridge steht unter GPL-2.0-or-later.
