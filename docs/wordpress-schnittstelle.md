# WordPress-Schnittstelle (LifeLink ⇄ Plugin)

Verbindlicher Vertrag zwischen LifeLink (Server, `server/src/connectors/wordpress.ts`) und dem
WordPress-Plugin (`wordpress-plugin/lifelink/`). Version 1.

## Kopplung

1. Im WordPress-Backend unter **Einstellungen → LifeLink** auf „Schlüssel erzeugen“ klicken.
2. Das Plugin erzeugt eine **Schlüssel-ID** (`ll_` + 16 Hex-Zeichen) und ein **Geheimnis**
   (32 Zufallsbytes, Base64url ohne Padding). Das Geheimnis wird genau **einmal** angezeigt.
   Gespeichert wird es im Plugin, weil es zum Prüfen der HMAC-Signatur gebraucht wird
   (Option `lifelink_keys`, nicht autoload).
3. Schlüssel-ID, Geheimnis und Website-URL werden in LifeLink im Einrichtungsassistenten
   („WordPress verbinden“) eingetragen.
4. Rotation: „Neuen Schlüssel erzeugen“ legt einen zweiten Schlüssel an. Der alte bleibt bis
   „Widerrufen“ gültig. Höchstens 2 Schlüssel sind gleichzeitig gültig. Widerrufen wirkt sofort.

## Signatur jeder Anfrage

Alle Routen unter `/wp-json/lifelink/v1/` außer `public/*` verlangen diese Header:

| Header | Inhalt |
|---|---|
| `X-LifeLink-Key` | Schlüssel-ID |
| `X-LifeLink-Timestamp` | Unix-Zeit in Sekunden |
| `X-LifeLink-Nonce` | zufälliger String, 16–64 Zeichen `[A-Za-z0-9_-]` |
| `X-LifeLink-Signature` | `v1=` + hex(HMAC-SHA256(geheimnis, kanonischer_string)) |

```
kanonischer_string = METHOD + "\n" + ROUTE + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(body))
```

- `METHOD` in Großbuchstaben (`GET`, `PUT`, `POST`, `DELETE`).
- `ROUTE` ist die REST-Route **ohne** `/wp-json`, ohne Query-String, z. B.
  `/lifelink/v1/banners/9b2f…`. (Im Plugin: `$request->get_route()`.)
- `body` ist der rohe Request-Body (leerer String bei GET/DELETE).
- Der HMAC-Schlüssel ist der rohe String des Geheimnisses (UTF-8-Bytes des Base64url-Textes).
- Toleranz ±300 s. Jede Nonce wird 600 s gespeichert (Transient). Eine wiederholte Nonce ergibt `409`.
- Vergleich mit `hash_equals`.

Fehlerantworten sind immer JSON:

```json
{ "code": "lifelink_bad_signature", "message": "Signatur ungültig.", "data": { "status": 401, "retryable": false } }
```

| HTTP | code | Bedeutung |
|---|---|---|
| 401 | `lifelink_missing_auth` / `lifelink_bad_signature` / `lifelink_unknown_key` / `lifelink_expired` | Authentisierung |
| 403 | `lifelink_revoked` / `lifelink_forbidden` | Schlüssel widerrufen / Recht fehlt |
| 409 | `lifelink_replay` | Nonce bereits benutzt |
| 422 | `lifelink_invalid` | ungültige Nutzlast (`data.fields` listet die Felder) |
| 429 | `lifelink_rate_limited` | mehr als 120 Anfragen/Minute je Schlüssel, Header `Retry-After` |

## Routen

### `GET /lifelink/v1/status`

```json
{
  "plugin_version": "1.0.0", "api_version": 1,
  "site_name": "Feuerwehr Musterstadt", "site_url": "https://…", "timezone": "Europe/Berlin",
  "wp_version": "6.9", "php_version": "8.4.2", "multisite": false,
  "banners_active": 2, "key_id": "ll_…", "time": "2026-10-29T17:08:00Z"
}
```

### `GET /lifelink/v1/pages`

Mögliche Zielseiten für Banner:

```json
{ "pages": [
  { "id": "all", "label": "Alle Seiten" },
  { "id": "front", "label": "Startseite" },
  { "id": "page:12", "label": "Einsätze" },
  { "id": "page:15", "label": "Aktuelles" }
] }
```

`all` und `front` gibt es immer, dazu alle veröffentlichten Seiten (`page:<ID>`), höchstens 200.

### `GET /lifelink/v1/banners`

Alle Banner, die das Plugin kennt (auch abgelaufene der letzten 30 Tage):
`{ "banners": [ Banner, … ] }`.

### `PUT /lifelink/v1/banners/{external_id}`

Idempotentes Upsert. `external_id` ist eine UUID von LifeLink.

```json
{
  "revision": 3,
  "title": "Einsatz: B3 – Wohnungsbrand",
  "text": "Bitte Einsatzstelle Hauptstraße weiträumig umfahren.",
  "color": "rot",
  "label": "Einsatz",
  "priority": "hoch",
  "starts_at": "2026-10-29T16:08:00Z",
  "ends_at": "2026-10-29T17:08:00Z",
  "pages": ["front", "page:12"],
  "link_url": null,
  "link_text": null
}
```

- `color` ∈ `rot`, `orange`, `gelb`, `blau`, `gruen`, `neutral`.
- `priority` ∈ `niedrig`, `normal`, `hoch`. Hoch wird als `role="alert"` angezeigt, sonst `role="status"`.
- `label`: kurzes Klartextlabel (max. 30 Zeichen), wird immer sichtbar vor dem Titel angezeigt
  (Farbe allein vermittelt keine Dringlichkeit). Leer → je nach Farbe ein Standardlabel
  (`rot` „Wichtig“, `orange` „Achtung“, `gelb` „Hinweis“, `blau` „Information“, `gruen` „Info“, `neutral` „Hinweis“).
- `title` max. 120 Zeichen, `text` max. 600 Zeichen, reiner Text (kein HTML).
- `starts_at` / `ends_at`: ISO 8601 UTC, `ends_at` darf `null` sein (ohne Ende). `ends_at` > `starts_at`.
- `pages`: mindestens ein Eintrag aus `GET /pages`.
- `link_url` optional, nur `https://` oder `http://`.
- `revision`: ganze Zahl ≥ 1. Ist die gespeicherte Revision **größer oder gleich**, wird nichts geändert
  und der gespeicherte Stand mit `"unchanged": true` zurückgegeben (HTTP 200). Sonst wird gespeichert.

Antwort `200`:

```json
{ "banner": Banner, "unchanged": false }
```

Banner-Objekt (Antworten):

```json
{
  "external_id": "…", "revision": 3, "title": "…", "text": "…", "color": "rot", "label": "Einsatz",
  "priority": "hoch", "starts_at": "…Z", "ends_at": "…Z", "pages": ["front"], "link_url": null,
  "link_text": null, "state": "aktiv", "updated_at": "…Z"
}
```

`state` ∈ `geplant` (Start in der Zukunft), `aktiv`, `abgelaufen`, `deaktiviert`.

### `DELETE /lifelink/v1/banners/{external_id}`

Deaktiviert das Banner sofort (`state = deaktiviert`) und leert die Caches.
Unbekannte ID → `200` mit `{ "deactivated": false }` (idempotent), sonst `{ "deactivated": true }`.

### `POST /lifelink/v1/posts`

Beitrag anlegen oder aktualisieren (Upsert über `external_id`, gespeichert als Post-Meta
`_lifelink_external_id`, Revision als `_lifelink_revision`, gleiche Revisionsregel wie bei Bannern).

```json
{
  "external_id": "…", "revision": 1,
  "title": "Einsatz in der Hauptstraße",
  "content": "<p>…</p>",
  "excerpt": "…",
  "category": "Einsätze",
  "tags": ["Brand", "B3"],
  "status": "draft",
  "publish_at": null
}
```

- `status` ∈ `draft`, `pending` (zur Freigabe in WordPress), `future` (geplant, `publish_at` Pflicht).
  `publish` ist bewusst **nicht** erlaubt: Veröffentlichung bleibt eine WordPress-Entscheidung,
  außer der Admin schaltet im Plugin „Geplante Veröffentlichung durch LifeLink erlauben“ ein
  (sonst wird `future` zu `pending`).
- `content` wird mit `wp_kses_post` bereinigt.
- Kategorie wird über den Namen gesucht und, falls im Plugin erlaubt, angelegt; sonst ignoriert.
- Autor ist der im Plugin eingestellte Benutzer (Pflicht, braucht `edit_posts`).

Antwort: `{ "post_id": 123, "status": "draft", "edit_url": "https://…/wp-admin/post.php?post=123&action=edit", "unchanged": false }`

### `GET /lifelink/v1/public/banners?page=<id>` (ohne Signatur)

Für das Nachladen im Browser: gibt nur die **aktuell aktiven** Banner für die Seite zurück
(Felder wie oben ohne `revision`/`updated_at`). Header `Cache-Control: public, max-age=60`.

## Anzeige

- Shortcode `[lifelink_banners]`, Block `lifelink/banners`, klassisches Widget. Optional automatische
  Ausgabe am Seitenanfang (`wp_body_open`), im Plugin abschaltbar.
- Sortierung: Priorität (hoch → niedrig), dann `starts_at` absteigend.
- Container `<div class="lifelink-banners" role="region" aria-label="Hinweise">`, jedes Banner hat
  `data-lifelink-ends="<ISO>"`. Ein kleines Skript entfernt abgelaufene Banner auch aus gecachtem HTML
  und kündigt Änderungen über `aria-live` an.
- Schrift und Abstände kommen vom Theme. Aus LifeLink kommen nur Farbe und Inhalt (CSS-Variablen
  `--lifelink-banner-bg`, `--lifelink-banner-fg`, isolierte Klassen mit Präfix `lifelink-`).
  Kontrast ≥ 4,5 : 1. `prefers-reduced-motion` wird respektiert.

## Caching und Ablauf

- Bei jedem Upsert/Deaktivieren und zum Start-/Endzeitpunkt (WP-Cron Einzelereignis plus
  5-Minuten-Abgleich) werden Caches geleert: `clean_post_cache`/`wp_cache_flush_group` sofern
  vorhanden, sowie die Hooks von LiteSpeed Cache, WP Rocket, W3 Total Cache, WP Super Cache und
  WP Fastest Cache, falls aktiv. Eigener Hook: `do_action( 'lifelink_banners_changed' )`.
- Abgelaufene/deaktivierte Banner werden nach 30 Tagen gelöscht.
