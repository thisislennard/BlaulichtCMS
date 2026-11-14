# Offene Punkte (Merkliste)

Was noch fehlt, sortiert nach Grund. Erledigte Punkte werden gestrichen und mit Datum markiert.
Stand: 14.11.2026, nach Meilenstein 4 (Umsetzung abgeschlossen, lokal abgenommen).

## Braucht Zuarbeit oder Abstimmung

| Punkt | Wer | Issue |
|---|---|---|
| **LiFeOS-Import:** Exportformat (z. B. als ZIP) bereitstellen – Importrahmen ist fertig (`docs/import.md`), es fehlt nur der Umsetzer; Lizenz für übernommenen Code klären | Projektverantwortung | #1, #35, #39 |
| **Warnentwurf:** Feldsatz, PDF-Aufbau, Empfänger und Rückmeldeweg mit der zuständigen Stelle abstimmen | Projektverantwortung + zuständige Stelle | #30 |
| **Warnentwurf:** Testversand über den echten Mailserver der Organisation an ein abgestimmtes Testpostfach (TLS/Anmeldung, SPF/DKIM, Spam-Einstufung) | Betrieb | #30 |
| **Warnstufen-Regeln:** echte Stichwörter, Lagefragen und Regeln fachlich erarbeiten und in LifeLink freigeben (ausgeliefert wird ohne Regeln) | Fachverantwortung | #41 |
| **Lizenz** des Projekts festlegen (Bridge ist als WordPress-Plugin GPL-2.0-or-later) | Projektverantwortung | #39 |
| **Vor der Freigabe festlegen:** Speicher- und Aufbewahrungsgrenzen, Backup-Ziel, Wiederanlaufzeit, Meta-App und Berechtigungen | Betrieb + Projektverantwortung | #40 |

## Externe Live-Tests (lokal bereits bestanden)

| Punkt | Issue |
|---|---|
| WordPress produktionsnah: Bridge auf der echten Testwebsite, HTTPS-Kopplung, WP-Cron und Host-Cron, Theme und Seitencache | #13, #21 |
| QR-Aushang mit echten Android- und iOS-Geräten scannen | #18 |
| Reverse Proxy mit echtem Zertifikat | – |
| ~~PostgreSQL-Hauptversions-Upgrade und Wiederanlauf nach fehlgeschlagener Migration~~ – lokal getestet (16 → 18, Rückweg), auf Zielhost wiederholen | #37 |
| Facebook/Instagram mit Testkonto des Anbieters | #32 |
| FE2: anonymisierte Testmeldung aus der echten FE2-Instanz | #33 |
| Amtliche Warnfeeds: Bezugsweg und Gebietsfilter mit echten Feeds | #34 |

## Noch umzusetzen

| Punkt | Issue |
|---|---|
| LiFeOS-Umsetzer (sobald das Exportformat vorliegt) | #35 |
| Abschlussbericht | #6 |

## Erledigt in M4 (14.11.2026)

~~Verbindungsrahmen (#31)~~ · ~~Facebook/Instagram (#32)~~ · ~~FE2-Eingang (#33)~~ · ~~Amtliche Warnfeeds (#34)~~ ·
~~Importrahmen (#35, ohne LiFeOS-Umsetzer)~~ · ~~Sicherheitsprüfung (#36)~~ · ~~Update-Vorabprüfung, Migrationsfehler,
PG-Upgrade-Pfad (#37)~~ · ~~Bridge-Updates (#38)~~ · ~~Doku und Auslieferung (#39, ohne Lizenz)~~ · ~~Abnahme M4 (#40, lokal)~~
