<div align="center">

# LifeLink

**Quelloffenes Redaktionssystem für Öffentlichkeitsarbeit und Krisenkommunikation**

Fotos per Link vom Handy sammeln · sichten · Beiträge schreiben · Fassung freigeben · auf der Website veröffentlichen – nachvollziehbar und selbst gehostet

![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ein_Container-2496ED?logo=docker&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-LifeLink_Bridge-21759B?logo=wordpress&logoColor=white)

</div>

![Dashboard von LifeLink](docs/bilder/dashboard.webp)

> [!NOTE]
> Status: **Meilenstein 1 abgeschlossen** (Foto-Link bis WordPress-Veröffentlichung). Weitere Meilensteine siehe [ROADMAP.md](ROADMAP.md).
> Alle Screenshots stammen aus einer Testinstanz mit fiktiven Daten.

---

## Inhalt

- [Was LifeLink macht](#was-lifelink-macht)
- [Einblicke](#einblicke)
- [Schnellstart](#schnellstart)
- [Demo-Ablauf mit fiktiven Daten](#demo-ablauf-mit-fiktiven-daten)
- [WordPress verbinden](#wordpress-verbinden)
- [Betrieb](#betrieb)
- [Leistung](#leistung)
- [Sicherheit](#sicherheit)
- [Entwicklung und Tests](#entwicklung-und-tests)
- [Dokumentation](#dokumentation)
- [Projektstruktur](#projektstruktur)

---

## Was LifeLink macht

```mermaid
flowchart LR
    H["📱 Handy<br/>Upload-Link / QR-Code"] -->|ohne Konto| Q["Quarantäne<br/>Typ- und Inhaltsprüfung"]
    Q --> S["Sichtung<br/>auswählen / überspringen"]
    S --> B["Beitrag<br/>Fassung n"]
    B -->|einreichen| F{"Freigabe<br/>genau dieser Fassung"}
    F -->|freigegeben| V["Veröffentlichung<br/>beauftragen"]
    V -->|Bridge holt ab| W["🌐 WordPress"]
    W -->|ID + URL| L["✅ bestätigte URL<br/>in LifeLink"]
```

- **Foto-Link:** Eine Sammlung samt befristetem, widerrufbarem Upload-Link entsteht mit einem Klick im Beitrag. Link kopieren, QR-Code anzeigen oder als A4-Aushang drucken.
- **Sicher eingesammelt:** Uploads landen privat in der Quarantäne. LifeLink prüft Dateityp und Inhalt, erzeugt Vorschauen und eine öffentliche Fassung **ohne Standortdaten**.
- **Sichten am Handy:** Datei für Datei auswählen oder überspringen – per Button, Wischgeste oder Tastatur.
- **Fassungen und Freigaben:** Jede Änderung an Text, Medien oder Zielkanal erzeugt eine neue Fassung. Eine Freigabe gilt genau für eine Fassung (Prüfsumme).
- **Veröffentlichen ohne offenen Eingang:** Die **LifeLink Bridge** (WordPress-Plugin, als ZIP direkt aus LifeLink) holt Aufträge per HTTPS ab und meldet WordPress-ID und URL zurück. Doppelte Abholung erzeugt nie einen zweiten Beitrag.
- **Warnentwurf per Handy (MoWaS-Übergabe):** Sechs-Schritte-Assistent für Erstmeldung, Aktualisierung und Entwarnung. Der **Warnstufen-Assistent** schlägt anhand lokal gepflegter, versionierter und fachlich freigegebener Regeln eine Stufe vor – oder sagt ehrlich „Keine eindeutige Empfehlung – fachlich prüfen“. Die Stufe bestätigt immer eine berechtigte Person; die Freigabe fixiert die PDF mit Prüfsumme, der Versand per SMTP läuft ab Werk im **Testmodus**. Die amtliche Auslösung bleibt bei der zuständigen Stelle.
- **Auch ganz ohne Website:** Der interne Redaktionsablauf funktioniert vollständig ohne externe Dienste.
- **Ein Container:** Webanwendung, Bediener-PWA, Worker und PostgreSQL in einem Image, Daten in einem Volume.
- **Schnell und schlank:** rund 180 KB beim ersten Aufruf (vorkomprimiert mit Brotli), danach fast alles aus dem Browser-Cache; Sichtung ohne Wartezeit, zwei parallele Uploads, Bilder werden nur einmal dekodiert.

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
    <td colspan="2"><b>Auf der WordPress-Testseite</b><br/>veröffentlicht von der LifeLink Bridge<br/><br/><img src="docs/bilder/wordpress-beitrag.webp" alt="Beitrag auf WordPress"/></td>
    <td><b>Hilfe-Center</b><br/>23 Kapitel mit Volltextsuche<br/><br/><img src="docs/bilder/hilfe.webp" alt="Hilfe-Center"/></td>
  </tr>
  <tr>
    <td><b>Warnentwurf am Handy</b><br/>Stichwort, Lagefragen, Vorschlag<br/><br/><img src="docs/bilder/warnentwurf-handy.webp" alt="Warnentwurf-Assistent am Handy"/></td>
    <td><b>Freigegebene PDF</b><br/>mit bestätigter Warnstufe und Prüfsumme<br/><br/><img src="docs/bilder/warnentwurf-pdf.webp" alt="PDF eines Warnentwurfs"/></td>
    <td><b>Regeln pflegen</b><br/>versioniert, fachlich freigegeben<br/><br/><img src="docs/bilder/warnstufen-regeln.webp" alt="Pflege der Warnstufen-Regeln"/></td>
  </tr>
</table>

---

## Schnellstart

**Voraussetzungen:** Linux-Host mit Docker und Docker Compose, ein freier Port (Standard `7310`).
Für den Echtbetrieb zusätzlich ein HTTPS-Reverse-Proxy ([Anleitung](docs/reverse-proxy.md)).

```bash
git clone <repository-url> lifelink && cd lifelink
cp .env.example .env          # optional; für einen lokalen Test ohne HTTPS: COOKIE_SECURE=false
docker compose up -d --build
docker compose logs lifelink | grep Einrichtungsschlüssel
```

`http://<host>:7310/einrichtung` öffnen und in zwei Schritten einrichten:

1. Einrichtungsschlüssel, **Organisation**, **öffentliche Adresse** (z. B. `https://lifelink.example.org`), **Zeitzone**
2. Erstes Konto (Administration) – die Zwei-Faktor-Anmeldung wird direkt eingerichtet

Beim ersten Start legt LifeLink die Datenbank und einen eigenen Master-Schlüssel im Volume an.
Bereit ist LifeLink, sobald `GET /healthz` mit 200 antwortet.

```bash
curl -s http://localhost:7310/healthz
# {"ok":true,"checks":{"database":…,"schema":…,"worker":…,"storage":…}}
```

---

## Demo-Ablauf mit fiktiven Daten

Ein Durchlauf in etwa zehn Minuten – alle Namen sind erfunden:

1. **Einladen:** *Benutzer und Rollen → Benutzer einladen* – `redaktion@example.org`, Rollen „Redaktion“ und „Veröffentlichung“. Link an das Handy schicken, dort Passwort setzen.
2. **Beitrag:** *Beiträge → Neuer Beitrag* – „Übung am Wochenende“.
3. **Sammeln:** Im Beitrag *Fotos und Videos sammeln* → QR-Code anzeigen → mit einem zweiten Handy scannen und ein Foto hochladen.
4. **Sichten:** *Medien → Übung am Wochenende → 1 sichten* → **Auswählen**.
5. **Schreiben:** Im Beitrag Text eingeben, *Medien übernehmen*, **Neue Fassung speichern**, **Zur Freigabe einreichen**.
6. **Freigeben:** Als Admin **Freigeben** – ohne Zielkanal ist der Beitrag jetzt *intern freigegeben*.
7. **Optional veröffentlichen:** Website koppeln (siehe unten), Zielkanal wählen, erneut freigeben, **Veröffentlichen**. Nach dem nächsten Abruf der Bridge steht die URL im Beitrag und im Dashboard.

Derselbe Ablauf läuft automatisiert als Abnahmetest: [`test/e2e/m1-flow.mjs`](test/e2e/m1-flow.mjs).

---

## WordPress verbinden

1. In LifeLink *Websites → Bridge herunterladen* (ZIP).
2. In WordPress *Plugins → Installieren → Plugin hochladen*, aktivieren.
3. In LifeLink *Website koppeln* → einmaligen **Kopplungscode** notieren (30 Minuten gültig).
4. In WordPress *Einstellungen → LifeLink Bridge* LifeLink-Adresse und Code eintragen → **Koppeln**.

Die Bridge holt jede Minute ab (WP-Cron). Empfohlen ist zusätzlich ein Host-Cron:

```cron
* * * * * wp --path=/var/www/html lifelink-bridge poll
```

Details: [docs/bridge-api.md](docs/bridge-api.md).

---

## Betrieb

| Thema | Kurzfassung | Ausführlich |
|---|---|---|
| Aufbau | ein Container, Port 7310, Volume `/data` (Datenbank, Medien, Schlüssel) | [docs/betrieb.md](docs/betrieb.md) |
| HTTPS | Reverse Proxy davor (Caddy, nginx, Traefik, HAProxy) | [docs/reverse-proxy.md](docs/reverse-proxy.md) |
| Sicherung | `scripts/backup-volume.sh /pfad/außerhalb` (konsistent, mit Prüfsumme) | [docs/betrieb.md#sicherung](docs/betrieb.md#sicherung) |
| Wiederherstellung | `scripts/restore-volume.sh <archiv>` in ein leeres Volume | [docs/betrieb.md#wiederherstellung](docs/betrieb.md#wiederherstellung) |
| Updates | `git pull && docker compose up -d --build` – Migrationen laufen beim Start | [docs/betrieb.md#updates](docs/betrieb.md#updates) |
| Notfall | `docker compose exec lifelink node server/dist/cli.js password-link <email>` | [docs/betrieb.md#notfall-befehle](docs/betrieb.md#notfall-befehle) |

---

## Leistung

| Ebene | Maßnahme |
|---|---|
| Laden am Handy | Seiten werden einzeln nachgeladen; Bibliotheken in stabilen Chunks (`react`, `query`, `icons`, `markdown`); Build vorkomprimiert mit Brotli und Gzip (879 KB → 243 KB); erster Aufruf ca. 180 KB |
| Caching | Assets mit Hash ein Jahr `immutable`; Vorschaubilder und öffentliche Fassungen je Medien-ID dauerhaft privat cachebar; `index.html` und Service Worker immer frisch |
| Bedienung | Sichtung reagiert sofort und lädt das nächste Bild vor; Freigaben und Veröffentlichungen bestätigt weiterhin der Server |
| Uploads | gestreamt mit hartem Größenlimit, zwei Dateien parallel, Wiederholen ohne Doppelanlage |
| Server | Beitragsliste und Dashboard in je einer Abfrage statt N+1; passende Indizes; API-Antworten ab 1 KB komprimiert |
| Medien | Bild einmal dekodieren, Vorschau und öffentliche Fassung parallel erzeugen; Threads je Bild begrenzt |
| Datenbank | PostgreSQL mit SSD-Einstellungen (`random_page_cost`, `effective_io_concurrency`, `work_mem`), JIT aus |

Messwert Testinstanz: `/healthz` antwortet in ca. 3 ms; frischer Container ist nach ca. 4 s bereit.

---

## Sicherheit

| Bereich | Umsetzung |
|---|---|
| Rechte | serverseitig bei jeder API, jeder Datei und jeder Aktion; Standard „verweigert“; Rollen kombinierbar |
| Anmeldung | Argon2id, Zwei-Faktor (TOTP) mit Wiederherstellungscodes, Sperre nach Fehlversuchen, CSRF-Schutz |
| Einladungen | einmalig, befristet, widerrufbar; getrennt vom PWA-Installationslink |
| Uploads | nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen; Quarantäne; Prüfung des Inhalts |
| Medien | privat außerhalb des Webservers; öffentliche Fassung ohne Standort- und Kameradaten |
| Websites | Schlüssel je Website (nur Prüfsumme gespeichert), sofort widerrufbar; die Bridge ruft nur aus |
| Datenbank | nur über Unix-Socket im Container erreichbar |
| Audit | Rollen, Freigaben, Veröffentlichungen mit Person und Zeitpunkt – ohne Tokens |
| Container | unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities |

Sicherheitslücken bitte nicht öffentlich als Issue melden, sondern direkt an die Betreiber.

---

## Entwicklung und Tests

```bash
npm install
# PostgreSQL 16+ lokal, Test-Datenbank lifelink_test (wird bei jedem Lauf geleert!)
TEST_DATABASE_URL=postgresql://lifelink:lifelink@127.0.0.1:5442/lifelink_test npm test   # 30 Server-Tests
npm run typecheck && npm run build
node test/e2e/m1-flow.mjs   # Abnahmetest M1: Container + WordPress + Browser (34 Schritte)
```

Lokaler Start mit Hot Reload, Testumgebung und Hinweise: [docs/entwicklung.md](docs/entwicklung.md).

---

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Meilensteine, Abnahmekriterien, verknüpfte Issues |
| [docs/architektur.md](docs/architektur.md) | Aufbau und getroffene Architekturentscheidungen |
| [docs/betrieb.md](docs/betrieb.md) | Start, Gesundheit, Sicherung, Wiederherstellung, Updates |
| [docs/reverse-proxy.md](docs/reverse-proxy.md) | HTTPS mit Caddy, nginx, Traefik, HAProxy |
| [docs/bridge-api.md](docs/bridge-api.md) | Schnittstelle zwischen LifeLink und der LifeLink Bridge |
| [docs/integrationen.md](docs/integrationen.md) | Stand je optionaler Verbindung: lokal geprüft / offen |
| [docs/testprotokoll.md](docs/testprotokoll.md) | Testbefehle, Ergebnisse, offene Prüfungen |
| [docs/offene-punkte.md](docs/offene-punkte.md) | Merkliste: was noch fehlt und wer zuarbeiten muss |
| [docs/entwicklung.md](docs/entwicklung.md) | Entwicklungsumgebung |
| Hilfe-Center in der App (`/hilfe`) | Anleitungen für Redaktion und Administration |

---

## Projektstruktur

| Ordner / Datei | Inhalt |
|---|---|
| `server/` | TypeScript, Fastify: API, Worker, Supervisor (mit internem PostgreSQL), Medienprüfung |
| `server/migrations/` | SQL-Migrationen (laufen beim Start) |
| `server/test/` | Unit- und Integrationstests gegen echtes PostgreSQL |
| `web/` | Oberfläche und PWA: React 19, Vite, Tailwind 4, TanStack Query |
| `web/src/pages/help/content/` | Kapitel des Hilfe-Centers (Markdown) |
| `wordpress-plugin/lifelink-bridge/` | WordPress-Plugin LifeLink Bridge (PHP) |
| `scripts/` | Sicherung und Wiederherstellung des Volumes |
| `test/wordpress/` | separates WordPress-Zielsystem für Integrationstests |
| `test/e2e/` | Abnahmetests über Container, Browser und WordPress |
| `Dockerfile`, `compose.yaml` | Image und Dienst (ein Container) |

Lizenz: noch festzulegen (siehe Issue #39).
