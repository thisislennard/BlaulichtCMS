# Abschlussbericht

Stand: 14.11.2026 · Branch `ccr-45746015-8mdxdp` · alle Meilensteine M1–M4 umgesetzt und **lokal** abgenommen.

## 1. Lauffähiger Stand und Start

```bash
cp .env.example .env          # optional anpassen (Port, Image)
docker compose up -d --build  # ein Container, ein Port (7310), ein Volume (/data)
docker compose logs lifelink | grep Einrichtungsschlüssel
# → http://<server>:7310/einrichtung   (für den Echtbetrieb HTTPS-Reverse-Proxy davor, docs/reverse-proxy.md)
```

Im Container: Supervisor → PostgreSQL 18 (nur Unix-Socket) → Schema-Migration mit Startprüfung → API → Worker.
Updates: `scripts/update.sh <image> <sicherungsordner> --rollback` (docs/betrieb.md).

## 2. Getestete Abläufe (über den normalen Einstiegspunkt)

| Prüfung | Ergebnis |
|---|---|
| Server-Tests (Vitest gegen PostgreSQL) | 72/72 |
| Abnahme M1 – Foto-Link bis WordPress-Testseite (Browser, Container, WordPress) | 34/34 |
| Abnahme M2 – fortsetzbarer Upload, QR-Aushang, Banner, RSS, Live-Dashboard | 13/13 |
| Abnahme M3 – Warnentwurf am Handy, Warnstufen-Assistent, PDF, Versand an Test-Postfach | 9/9 |
| Abnahme M4 – Medienbestand, FE2, Bridge-Update, fehlgeschlagenes Update mit Rückweg, Restore, PG 16 → 18 | 7/7 |

Erfüllte Abnahmekriterien je Meilenstein mit Nachweisen: [testprotokoll.md](testprotokoll.md).
Keine echten Veröffentlichungen, keine Warnmails an operative Empfänger; alle Testdaten fiktiv.

## 3. Offene externe Prüfungen je Integration

Vollständige Matrix (lokal / mit Anbieter / produktionsnah): [integrationen.md](integrationen.md). Kurzfassung:

| Integration | Offen |
|---|---|
| WordPress | echte Testwebsite mit HTTPS-Kopplung, WP-Cron und Host-Cron, Theme, Seitencache |
| Facebook / Instagram | Meta-App mit App-Prüfung der Rechte, Testseite und professionelles Testkonto |
| FE2 | anonymisierte Testmeldung der echten Instanz, Feldzuordnung bestätigen |
| SMTP (Warnentwurf) | Mailserver der Organisation → abgestimmtes Testpostfach der zuständigen Stelle |
| Amtliche Warnfeeds | Abruf für den eigenen Regionalschlüssel, Nutzungsbedingungen |
| RSS | echte Feeds der Organisation |
| LiFeOS-Import | **Exportformat fehlt**; Importrahmen fertig, Umsetzer offen |
| QR-Aushang | Scan mit echten Android-/iOS-Geräten |

## 4. Architekturentscheidungen

Dokumentiert in [architektur.md](architektur.md) (E1–E16), u. a.: ein Container mit eingebettetem PostgreSQL,
fassungsgebundene Freigaben über Prüfsummen, Abholprinzip der Bridge, Quarantäne und Fassungen ohne Standortdaten,
Warnentwurf als Übergabe (keine Auslösung), Warnstufen-Vorschlag nur aus freigegebenen Regeln, Verbindungsrahmen mit
echtem Funktionstest, Migration als eigener Startschritt mit Rückweg über die Sicherung.

## 5. Verbleibende Lücken – hier setzt die nächste Änderung an

| Lücke | Letzte geprüfte Stelle | Nächster Schritt |
|---|---|---|
| LiFeOS-Umsetzer | `server/src/ops/import.ts`, Austauschformat in `docs/import.md`, Test „Einmaliger Medienimport“ | Exportformat erhalten → Umsetzer nach `lifelink-import/1` schreiben → `import-inventory` gegen eine Kopie |
| Lizenz | Bridge: GPL-2.0-or-later | Projektlizenz festlegen, `LICENSE` ergänzen |
| Warnentwurf fachlich | Beispielvorlage „nicht abgestimmt“, keine Regeln ab Werk | Vorlage, Empfänger, Rückmeldeweg mit der zuständigen Stelle abstimmen; Regeln fachlich freigeben |
| Live-Tests mit Anbietern | Ersatzdienste in `server/test/integration.test.ts` (M4) | Testkonten einrichten, je Verbindung „Testen“ in der Oberfläche ausführen, Ergebnis in `integrationen.md` eintragen |
| Betrieb festlegen | Vorabprüfung, `scripts/update.sh` | Speicher-/Aufbewahrungsgrenzen, Backup-Ziel, Wiederanlaufzeit festlegen; Restore auf dem Zielhost wiederholen |
| Sicherheit | [sicherheitspruefung.md](sicherheitspruefung.md) | externer Penetrationstest, Lasttest auf Zielhardware |

Merkliste mit Zuständigkeiten: [offene-punkte.md](offene-punkte.md).
