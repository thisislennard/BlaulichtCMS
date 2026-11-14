# LifeLink Bridge – Schnittstelle (API-Version 1)

Die LifeLink Bridge ist ein WordPress-Plugin. Sie **ruft LifeLink auf** (HTTPS, ausgehend) – WordPress braucht keinen
offenen Eingang. Quellcode: `wordpress-plugin/lifelink-bridge/`, Server: `server/src/routes/bridge.ts`.

## Kopplung

1. In LifeLink legt eine Person mit dem Recht „Kanäle verwalten“ eine Website an. LifeLink erzeugt einen
   **Kopplungscode** (8 Zeichen, angezeigt als `XXXX-XXXX`, 30 Minuten gültig, einmalig). Gespeichert wird nur die Prüfsumme.
2. Die Bridge sendet den Code:

```http
POST /api/v1/bridge/pair
Content-Type: application/json

{ "code": "ABCD-EF23", "site_url": "https://www.example.org/", "site_name": "Beispiel", "wp_version": "6.9", "plugin_version": "0.1.0" }
```

Antwort (der Schlüssel erscheint **nur hier**):

```json
{ "key": "llb_xxxxxxxxxxxx_…", "site_id": "…", "site_name": "Testwebsite", "api_version": 1, "poll_interval": 60, "lifelink_url": "https://lifelink.example.org" }
```

| Fehler | Bedeutung |
|---|---|
| 401 `pairing_invalid` | Code unbekannt oder schon verbraucht |
| 410 `pairing_expired` | Code abgelaufen |
| 409 `pairing_used` | gleichzeitig verwendeter Code |

Der Schlüssel gilt für **genau eine Website**. LifeLink speichert nur seine SHA-256-Prüfsumme. „Widerrufen“ in LifeLink
sperrt ihn sofort (401 bei der nächsten Anfrage) und bricht noch nicht abgeholte Aufträge ab.

## Authentisierung

```http
Authorization: Bearer llb_<12 Zeichen Präfix>_<Geheimnis>
X-LifeLink-Bridge-Version: 0.1.0
```

## Aufträge abholen

```http
GET /api/v1/bridge/jobs
```

```json
{
  "poll_interval": 60,
  "jobs": [
    {
      "id": "3f0c…",                    // Auftrags-ID (= Veröffentlichung)
      "type": "post.upsert",
      "lifelink_post_id": "9a1b…",     // stabile Inhalts-ID → Idempotenz in WordPress
      "revision": 4,
      "content_hash": "e3b0…",
      "post": { "title": "…", "body": "Absätze …", "excerpt": "", "status": "publish", "cover_media_id": "…" },
      "media": [ { "id": "…", "kind": "image", "mime": "image/jpeg", "filename": "….jpg", "path": "/api/v1/bridge/media/…", "url": "https://lifelink.example.org/api/v1/bridge/media/…", "width": 2560, "height": 1920 } ]
    }
  ]
}
```

- Ausgeliefert werden Aufträge im Status `queued` und `unknown`, sowie `sent`, wenn die letzte Abholung länger als
  120 Sekunden zurückliegt. Ein zweiter Abruf innerhalb dieser Frist liefert den Auftrag nicht doppelt aus.
- Bleibt ein abgeholter Auftrag 15 Minuten ohne Ergebnis, setzt LifeLink ihn auf **„Ergebnis unbekannt“**. Beim nächsten
  Abruf erhält ihn die Bridge erneut und gleicht über `lifelink_post_id` ab.

## Medien laden

```http
GET /api/v1/bridge/media/{id}
```

Die Bridge setzt `path` an die LifeLink-Adresse, mit der sie gekoppelt ist (`url` dient nur zur Information).
Nur Medien, die zu einem Auftrag **dieser** Website gehören. Ausgeliefert wird die **öffentliche Fassung** ohne
Standort- und Kameradaten.

## Ergebnis melden

```http
POST /api/v1/bridge/jobs/{id}/result
Content-Type: application/json

{ "status": "published", "remote_id": 42, "url": "https://www.example.org/2026/11/beitrag/", "remote_status": "publish" }
```

oder

```json
{ "status": "failed", "error": "Upload von Mediendateien ist nicht erlaubt." }
```

Eine wiederholte Erfolgsmeldung ändert nichts (`"duplicate": true`). Ein in LifeLink abgebrochener Auftrag liefert 409.

## Idempotenz in WordPress

- Beitrag: Meta `_lifelink_post_id`. Existiert ein Beitrag mit dieser ID, wird er aktualisiert statt neu angelegt.
- Medien: Meta `_lifelink_media_id` an Anhängen – jede Datei wird nur einmal in die Mediathek übernommen.
- Ein Transient-Lock verhindert parallele Abrufe (WP-Cron und Host-Cron gleichzeitig).

Damit gilt: Doppeltes Abholen, doppelte Bestätigung, verlorene Rückmeldung oder „Ergebnis unbekannt“ führen zu genau
**einem** WordPress-Beitrag.

## Abruf

- WP-Cron: Ereignis `lifelink_bridge_poll`, jede Minute.
- Host-Cron (empfohlen): `* * * * * wp --path=/var/www/html lifelink-bridge poll`
- WP-CLI: `wp lifelink-bridge pair <url> <code>`, `wp lifelink-bridge status`
