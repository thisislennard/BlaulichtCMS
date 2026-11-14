# Architektur und Entscheidungen

Fachliche Grundlage ist das Umsetzungskonzept „LifeLink V2“ (nicht im Repository, enthält organisationsspezifische
Angaben). Verbindlich sind die Entscheidungen in [ROADMAP.md](../ROADMAP.md). Hier stehen die technischen Entscheidungen,
die bei der Umsetzung getroffen wurden.

## Überblick

```
┌──────────────────────── LifeLink-Container ────────────────────────┐
│  Supervisor (server/src/main.ts, PID 1 hinter tini)                │
│   ├─ PostgreSQL 18  (Unix-Socket /tmp/lifelink-pg, kein TCP)       │
│   ├─ API + Oberfläche + PWA  (Fastify, Port 7310)                  │
│   └─ Worker  (Medienprüfung, Wartung, Sicherung)                   │
│                                                                    │
│  /data  postgres/ · media/ · secrets/ · backups/ · setup-token.txt │
└────────────────────────────────────────────────────────────────────┘
        ▲ HTTPS über Reverse Proxy                 ▲ HTTPS (ausgehend von WordPress)
   Redaktion, Handy (Upload-Link)            LifeLink Bridge (WordPress-Plugin)
```

## Entscheidungen

### E1 – Technische Grundlage: bisheriges LifeLink 2.0.1

Übernommen aus dem eigenen Repository `LifeLink` (gleicher Eigentümer, Lizenzfrage geklärt): Stack (Node.js, TypeScript,
Fastify, PostgreSQL, React, Vite, Tailwind), Anmeldung (Argon2id, TOTP, Sitzungen, CSRF, Login-Sperre), Rechte-Registry,
Audit, Maskierung, AES-256-GCM-Geheimnisse, SSRF-Schutz, PostgreSQL-Warteschlange mit Lease und Idempotenz,
verschlüsselte Datenbanksicherung, Notfall-CLI, UI-Bausteine, Hilfe-Center, CI.
**Entfernt:** Workflow-Engine und Editor, IMAP, MQTT, Teams, allgemeine Webhooks, In-App-Code-Updates.
Der Import-Commit (`0cdafa5`) enthält den unveränderten Stand, damit jede Änderung nachvollziehbar bleibt.

### E2 – Ein Container mit internem PostgreSQL

Der Supervisor startet PostgreSQL selbst (`initdb` beim ersten Start in `/data/postgres`), wartet auf Bereitschaft,
legt die Datenbank an und startet dann API und Worker. PostgreSQL hört nur auf einem Unix-Socket in einem
`0700`-Verzeichnis des LifeLink-Benutzers (`listen_addresses = ''`, `local all all trust`). Ein Absturz von PostgreSQL
hält API und Worker an und startet alles in Reihenfolge neu. Beim Stopp: Worker → API → PostgreSQL (`SIGINT`, Fast Shutdown).

### E3 – Image ohne Paketquellen

Laufzeitbasis ist `postgres:18-trixie` (offiziell), Node.js wird aus `node:26-trixie-slim` kopiert, ffmpeg/ffprobe aus
`mwader/static-ffmpeg:7.1.1` (statisch gebaut). Der Build braucht damit nur Docker Hub und die npm-Registry.
Grund: einfache, reproduzierbare Builds auch in Netzen ohne Zugriff auf Debian-/PGDG-Spiegel. Alle Basis-Images sind
per Build-Argument austauschbar.

### E4 – Master-Schlüssel

Wird `LIFELINK_MASTER_KEY` nicht gesetzt, erzeugt der Supervisor beim ersten Start `/data/secrets/master.key` (0600).
So hat jede Installation eigene Geheimnisse, ohne Pflicht zur manuellen Erzeugung. Wer den Schlüssel getrennt vom
Volume halten will, setzt die Umgebungsvariable. Der Schlüssel gehört zur Sicherung (separat aufbewahren).

### E5 – Fassungen und Freigabe

Jede inhaltliche Änderung erzeugt eine neue, unveränderliche Zeile in `post_revisions` mit SHA-256 über
`[Titel, Text, Kurzfassung, Medien-IDs in Reihenfolge, Titelbild, Zielkanal]`. Eine Freigabe speichert diese Prüfsumme;
gültig ist sie nur, solange Fassung und Prüfsumme die aktuellen sind. Veröffentlichen verlangt Fassungsnummer und
Prüfsumme im Request (Schutz gegen veraltete Oberflächen). Optimistische Sperre über `baseRevision` beim Speichern.

### E6 – Veröffentlichung als Auftrag mit Abholprinzip

Eine Veröffentlichung ist eine Zeile in `publications` (Fassung × Website), eindeutig über einen partiellen Unique-Index.
Die Bridge holt ab (`queued → sent`), meldet `published` oder `failed`. Ohne Rückmeldung nach 15 Minuten → `unknown`,
erneute Auslieferung, Abgleich über `lifelink_post_id` in WordPress. Damit genau ein Beitrag. Der WordPress-seitige
Push mit HMAC aus dem alten LifeLink entfällt; die alte Banner-Logik dient als Vorlage für M2 (#21).

### E7 – Medienablage und Prüfung

Uploads werden gestreamt (Größenlimit hart im Stream), in `media/tmp` geschrieben, per Transaktion in die Quarantäne
verschoben und als Auftrag `media.process` eingeplant. Prüfung anhand der Magic Bytes (`file-type`), Dekodierung mit
`sharp` (max. 40 Megapixel) bzw. `ffprobe`. Öffentliche Fassung: Bild als JPEG ohne Metadaten, Video umverpackt mit
`-map_metadata -1`. HEIC wird angenommen, aber ohne Vorschau/öffentliche Fassung (kein lizenzfreier Decoder).
Wiederholte Uploads mit gleichem Client-Schlüssel werden erkannt (Unique-Index `collection_id, client_key`).

### E8 – Upload-Links

Token 18 Byte zufällig, gespeichert als SHA-256 **und** verschlüsselt (AES-GCM, zweckgebunden), damit Link und QR-Code
später erneut angezeigt werden können. Ablauf, Widerruf, Dateigrenze, Dateianzahl je Link, Umfang je Sammlung und
Mindest-Speicher werden serverseitig geprüft. Antworten unterscheiden „ungültig“ (404) und „abgelaufen/widerrufen“ (410),
damit Hochladende eine verständliche Meldung erhalten.

### E9 – Updates nur über den Docker-Host

Der In-App-Code-Austausch des alten LifeLink (signierte Release-Pakete unter `/data/releases`) entfällt. Updates sind
Image-Wechsel am Host; die Oberfläche übernimmt später (M4, #37) Prüfungen vor dem Update nach dem Vorbild von LiFeOS.

### E10 – Rollen

`platform_admin` (Anzeige „Administration“), `media_manager`, `editor`, `approver`, `publisher`, `warning_author`,
`warning_approver`, `warning_sender`, `viewer`. Rechte sind einzeln registriert, Rollen kombinierbar.
Vier-Augen-Prinzip optional (Einstellung `editorial.four_eyes`).

### E11 – Öffentliche Adresse aus dem Erstsetup

Maßgeblich ist die Einstellung `general.public_url` (Erstsetup). `PUBLIC_URL` dient nur als Vorschlag/Fallback.

## Offene Architekturpunkte

- LiFeOS-Quellcode liegt nicht vor: Abgleich von Sicherheitslogik und Update-Bedienung (#1) sowie das Importformat (#35) sind offen.
- Lizenz für die öffentliche Bereitstellung ist noch festzulegen (#39).
