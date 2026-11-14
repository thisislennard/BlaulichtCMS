# Testprotokoll

Damit die Arbeit nach einer Unterbrechung direkt weitergehen kann: Befehle, letzte Ergebnisse und offene Prüfungen.

## Befehle

```bash
npm ci
npm run typecheck                                                                   # Server + Oberfläche
TEST_DATABASE_URL=postgresql://lifelink:lifelink@127.0.0.1:5442/lifelink_test npm test   # Unit + Integration
npm run build
docker compose build                                                                # Image lifelink:local
node test/e2e/m1-flow.mjs                                                           # Abnahme M1 (setzt Volumes zurück!)
```

## Letzte Ergebnisse (14.11.2026)

| Prüfung | Ergebnis |
|---|---|
| Typprüfung Server und Oberfläche | ✅ ohne Fehler |
| Server-Tests (Vitest gegen PostgreSQL 16) | ✅ 30/30 |
| Oberfläche bauen (Vite) | ✅ |
| PHP-Syntax der LifeLink Bridge (`php -l`, PHP 8.3) | ✅ |
| Image bauen | ✅ (Basis `postgres:18-trixie`, Node 26, ffmpeg 7.1.1) |
| Frischer Container auf leerem Volume bis `/healthz` 200 | ✅ ca. 4 s |
| **Abnahmetest M1** (`test/e2e/m1-flow.mjs`) | ✅ **34/34** |

### Abnahmetest M1 im Detail

Umgebung: LifeLink-Container (Docker), WordPress 6.9.4 mit MariaDB 11 als separates
Zielsystem, Chromium (Playwright) als Desktop (1360×900), Pixel 7 (Bediener) und iPhone 14 (Upload ohne Konto).

| # | Schritt | | Ergebnis |
|---|---|---|---|
| 1 | Frischer Container auf leerem Volume | ✅ | healthz ok, 2/2 Migrationen |
| 2 | WordPress-Testsystem bereitstellen | ✅ | 6.9.4 |
| 3 | Erstsetup: Admin, Organisation, Basisadresse, Zeitzone | ✅ | Dashboard erreicht |
| 4 | Zweites Setup wird abgewiesen | ✅ | HTTP 403 |
| 5 | Bediener einladen (Redaktion + Medienverwaltung + Veröffentlichung) | ✅ | http://localhost:7310/einladung/… |
| 6 | Bediener nimmt Einladung am Handy an | ✅ | angemeldet |
| 7 | Einladungslink ist danach verbraucht | ✅ | HTTP 404 |
| 8 | Bediener legt Beitrag an und erzeugt „Fotos und Videos sammeln“ | ✅ | http://localhost:7310/u/… |
| 9 | Aushang-Druckansicht enthält QR-Code, Zweck und lesbare Adresse | ✅ | PDF test/e2e/out/aushang.pdf |
| 10 | Foto-Link am Handy ohne Konto öffnen und Foto hochladen | ✅ | Upload bestätigt |
| 11 | Upload liegt zuerst in Quarantäne und wird geprüft (Standortdaten entfernt) | ✅ | geprüft, GPS im Original erkannt, öffentliche Fassung ohne EXIF |
| 12 | Bild sichten und auswählen (Handy) | ✅ | ausgewählt |
| 13 | Beitrag schreiben, Bild übernehmen, zur Freigabe einreichen | ✅ | eingereicht |
| 14 | Bediener darf nicht selbst freigeben (Recht fehlt, auch per API) | ✅ | HTTP 403, kein Button |
| 15 | Admin gibt frei (intern, ohne WordPress) | ✅ | intern freigegeben |
| 16 | LifeLink Bridge als ZIP aus LifeLink herunterladen und in WordPress installieren | ✅ | 0.1.0 |
| 17 | Website per einmaligem Code koppeln (WordPress-Oberfläche) | ✅ | Code CA…, gekoppelt |
| 18 | Kopplungscode ist danach verbraucht | ✅ | HTTP 401 |
| 19 | Zielkanal wählen erzeugt neue Fassung – alte Freigabe gilt nicht mehr | ✅ | neue Fassung, Status Entwurf → eingereicht |
| 20 | Admin gibt die neue Fassung frei, Bediener veröffentlicht | ✅ | Auftrag erstellt |
| 21 | Bridge holt per Host-Cron ab und meldet zurück | ✅ | Success: 1 Auftrag/Aufträge verarbeitet. |
| 22 | LifeLink zeigt die bestätigte URL | ✅ | http://localhost:8080/2026/11/ubung-am-wochenende/ |
| 23 | Auf der Testwebsite erscheint genau ein Beitrag (mit Bild, ohne Standortdaten) | ✅ | WordPress-ID 5 |
| 24 | Erneutes Abholen und doppelte Rückmeldung erzeugen keinen zweiten Beitrag | ✅ | weiterhin genau 1 Beitrag und 1 Anhang |
| 25 | Direkte Zugriffe ohne Anmeldung werden abgewiesen | ✅ | 401,401,401,401,401,401 |
| 26 | Bediener ohne Admin-Recht: Benutzerverwaltung und Website-Kopplung gesperrt | ✅ | 403, 403 |
| 27 | Abgelaufener Upload-Link wird abgewiesen | ✅ | Seite „Link nicht mehr gültig“, HTTP 410 |
| 28 | Widerrufener Upload-Link wird abgewiesen (UI-Widerruf) | ✅ | HTTP 410 link_revoked |
| 29 | Widerrufene Website-Kopplung wird abgewiesen | ✅ | HTTP 401 |
| 30 | Zweiter Beitrag: interne Freigabe ganz ohne Zielkanal | ✅ | freigegeben, keine Veröffentlichung |
| 31 | Audit enthält Rollen, Freigaben und Veröffentlichungen mit Person und Zeit | ✅ | 7 relevante Einträge |
| 32 | Teststand außerhalb des aktiven Volumes sichern | ✅ | lifelink-2026-11-14-134733.tar.gz (7082 KB) – Sicherung geschrieben: /home/user/LifeLink2/test/e2e/out/backup/lifelink-2026-11-14-134733.tar |
| 33 | Frische Instanz aus der Sicherung wiederherstellen | ✅ | Volume neu angelegt und wiederhergestellt |
| 34 | Nach Wiederherstellung: Anmeldung, Beitrag, URL, Medien, Freigaben vorhanden | ✅ | Login ok, Beitrag veröffentlicht, Vorschau 200, 3 Freigaben, Bridge-Abruf ok |

## Abnahmekriterien Meilenstein 1

| Kriterium | Status | Nachweis |
|---|---|---|
| Kompletter Ablauf auf leerem Volume | ✅ | Schritte 1–23 |
| Ohne WordPress lässt sich ein Beitrag intern freigeben | ✅ | Schritte 15 und 30, Integrationstest |
| Direkte Zugriffe ohne Rechte werden abgewiesen | ✅ | Schritte 14, 25, 26, Integrationstest „weist direkte Zugriffe ohne Recht ab“ |
| Abgelaufene und widerrufene Links werden abgewiesen | ✅ | Schritte 7, 18, 27–29, Integrationstests |
| Genau ein Beitrag auf der Testwebsite, LifeLink zeigt die bestätigte URL | ✅ | Schritte 22–24 |
| Teststand außerhalb des Volumes gesichert und in frischer Instanz wiederhergestellt | ✅ | Schritte 32–34 |

## Offene Prüfungen

| Thema | Was fehlt | Wo |
|---|---|---|
| WordPress produktionsnah | Bridge auf der echten Testwebsite über HTTPS mit der produktiven LifeLink-Adresse; WP-Cron ohne Host-Cron; Seitencache | #13, #21, `docs/integrationen.md` |
| Echte Geräte | Upload-Link und gedruckter QR-Code mit echtem Android- und iOS-Gerät (bisher emuliert bzw. PDF geprüft) | #18 |
| Reverse Proxy | Betrieb hinter HTTPS-Proxy mit `TRUST_PROXY=true` und großen Uploads | #8 |
| Große Videos | Upload und Verarbeitung großer Videos, Verbindungsabbruch (fortsetzbarer Upload folgt in M2) | #16 |
| PostgreSQL-Hauptversion | dokumentierter Weg (`pg_dumpall`/Import) noch nicht mit echtem Versionswechsel getestet | #37 |
| Fehlgeschlagene Migration | Wiederherstellung nach absichtlich fehlerhafter Migration | #37 |
| LiFeOS | Quellcode liegt nicht vor; Abgleich Sicherheit/Updates und Import offen | #1, #35 |

## Testumgebung dieser Sitzung

- Docker 29 ohne direkten Internetzugang im Build: Image mit `--network host`, Proxy-Build-Argument und
  `--secret id=build_ca` gebaut (siehe `docs/entwicklung.md`). Debian-/PGDG-Paketquellen waren gesperrt, daher das
  Image-Konzept ohne `apt` (Architekturentscheidung E3).
- Server-Tests lokal gegen PostgreSQL 16; im Container läuft PostgreSQL 18.
