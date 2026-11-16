# BlaulichtCMS Bridge – Schnittstelle (API-Version 1)

Die BlaulichtCMS Bridge ist ein WordPress-Plugin. Sie **ruft BlaulichtCMS auf** (HTTPS, ausgehend) – WordPress braucht keinen
offenen Eingang. Quellcode: `wordpress-plugin/blaulichtcms-bridge/`, Server: `server/src/routes/bridge.ts`.

## Kopplung

1. In BlaulichtCMS legt eine Person mit dem Recht „Websites koppeln und widerrufen“ eine Website an. BlaulichtCMS erzeugt einen
   **Kopplungscode** (8 Zeichen, angezeigt als `XXXX-XXXX`, 30 Minuten gültig, einmalig). Gespeichert wird nur die Prüfsumme.
2. Die Bridge sendet den Code:

```http
POST /api/v1/bridge/pair
Content-Type: application/json

{ "code": "ABCD-EF23", "site_url": "https://www.example.org/", "site_name": "Beispiel", "wp_version": "6.9", "plugin_version": "0.1.0" }
```

Antwort (der Schlüssel erscheint **nur hier**):

```json
{ "key": "bcb_xxxxxxxxxxxx_…", "site_id": "…", "site_name": "Testwebsite", "api_version": 1, "poll_interval": 60, "blaulichtcms_url": "https://blaulichtcms.example.org" }
```

| Fehler | Bedeutung |
|---|---|
| 401 `pairing_invalid` | Code unbekannt oder schon verbraucht |
| 410 `pairing_expired` | Code abgelaufen |
| 409 `pairing_used` | gleichzeitig verwendeter Code |

Der Schlüssel gilt für **genau eine Website**. BlaulichtCMS speichert nur seine SHA-256-Prüfsumme. „Widerrufen“ in BlaulichtCMS
sperrt ihn sofort (401 bei der nächsten Anfrage) und bricht noch nicht abgeholte Aufträge (Beiträge und Banner) ab.
Bereits abgeholte Beitragsaufträge (`sent`/`unknown`) kann die Website nicht mehr melden: Sie stehen danach auf
**„Ergebnis unbekannt“** mit dem Hinweis „Kopplung widerrufen – … von Hand abschließen“. Im Beitrag hält die Redaktion
nach einem Blick auf die Website das Ergebnis fest (`POST /api/v1/publications/{id}/resolve` mit
`outcome: done | not_done` und Prüfhinweis, nur für Websites, die nicht mehr gekoppelt sind; mit Audit
`publication.resolved`). Solche Aufträge blockieren den Widerruf einer Freigabe nicht. Abgeholte Banner-Aufträge werden
beim Widerruf „fehlgeschlagen“ (die Bridge entfernt ihre lokalen Banner ohnehin).
Dasselbe geschieht, wenn die Bridge die Kopplung selbst löst (`POST /api/v1/bridge/unpair` beim Entkoppeln oder
Deinstallieren in WordPress). Antwortet BlaulichtCMS mit
401 `bridge_unauthorized` oder 403 `bridge_revoked`, entfernt die Bridge alle lokal gespeicherten Banner (ab 0.6.0);
ebenso beim Entkoppeln in WordPress.

## Authentisierung

```http
Authorization: Bearer bcb_<12 Zeichen Präfix>_<Geheimnis>
X-BlaulichtCMS-Bridge-Version: 0.1.0
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
      "blaulichtcms_post_id": "9a1b…",     // stabile Inhalts-ID → Idempotenz in WordPress
      "revision": 4,
      "content_hash": "e3b0…",
      "post": { "title": "…", "body": "Absätze …", "excerpt": "", "status": "publish", "cover_media_id": "…", "categories": [12, 7] },
      "author": { "key": "3be1…", "name": "Vorname Nachname" },   // nur, wenn „Autorenname übertragen“ an ist
      "media": [ { "id": "…", "kind": "image", "mime": "image/jpeg", "filename": "….jpg", "path": "/api/v1/bridge/media/…", "url": "https://blaulichtcms.example.org/api/v1/bridge/media/…", "width": 2560, "height": 1920 } ]
    },
    { "id": "…", "type": "banner.upsert", "banner": { "id": "…", "revision": 2, "title": "…", "text": "…", "tone": "danger", "priority": 3, "starts_at": "…", "ends_at": "…", "link_url": null, "link_text": null, "display": "auto" } }
  ],
  "banner_ids": ["…"]
}
```

- `post.categories` (ab 0.4, Bridge ab 0.8.0): WordPress-Kategorie-IDs aus der freigegebenen Fassung. Die Bridge
  übernimmt nur Kategorien, die es in WordPress gibt; fehlt das Feld, gilt ihre Standardkategorie.
- `author` (ab 0.4): nur, wenn für die Website „Autorenname übertragen“ eingeschaltet ist und der Beitrag eine
  verfassende Person hat. `key` ist ein je Website verschiedener HMAC der Konto-ID (nicht umkehrbar), `name` der
  Anzeigename. Die Bridge legt damit im Modus „Person aus BlaulichtCMS“ je Person einen Autor ohne Rechte und ohne
  Anmeldung an; sonst ignoriert sie das Feld.
- `banner.display` (ab 0.4): `auto` (nach Schweregrad, wie in der Bridge eingestellt), `banner`, `popup` oder `both`.
  Ältere Bridges ignorieren das Feld und zeigen ein Banner.

- Ausgeliefert werden Aufträge im Status `queued` und `unknown`, sowie `sent`, wenn die letzte Abholung länger als
  120 Sekunden zurückliegt. Ein zweiter Abruf innerhalb dieser Frist liefert den Auftrag nicht doppelt aus.
- Bleibt ein abgeholter Auftrag 15 Minuten ohne Ergebnis, setzt BlaulichtCMS ihn auf **„Ergebnis unbekannt“**. Beim nächsten
  Abruf erhält ihn die Bridge erneut und gleicht über `blaulichtcms_post_id` ab.

## Zurückziehen

```json
{ "id": "…", "type": "post.unpublish", "blaulichtcms_post_id": "9a1b…", "revision": 4, "media_ids": ["…"] }
```

`POST /posts/{id}/unpublish` legt für **jede aktive Website**, auf der der Beitrag zuletzt veröffentlicht wurde, einen
solchen Auftrag an. Die Bridge setzt den Beitrag auf „Entwurf“, markiert ihn als zurückgezogen (`_blaulichtcms_withdrawn`) und
löscht die Anhänge der Medien (`wp_delete_attachment(…, true)`, also auch alle Bildgrößen), sofern sie nicht
anderweitig verwendet werden: andere nicht zurückgezogene Beiträge mit dem Medium (`_blaulichtcms_uses_media`), Beitragsbild,
Elternbeitrag oder eingebettet in einen beliebigen Beitrag oder eine Seite (außer Papierkorb). Dasselbe gilt für Medien,
die in einer neuen Fassung nicht mehr vorkommen. Ab Bridge 0.6.0.

Steht der Beitrag auf einer Website, deren Kopplung widerrufen wurde, geht der Rückzug an eine **aktive Neu-Kopplung mit
derselben Adresse** (`site_url`, ohne Groß-/Kleinschreibung und abschließenden Schrägstrich). Vorgänge der alten und der
neuen Kopplung zählen dabei gemeinsam; die Bridge findet den Beitrag über `blaulichtcms_post_id`. Ohne aktive Neu-Kopplung
ist der Beitrag von BlaulichtCMS aus nicht erreichbar.

## Einsatzliste (ab Bridge 0.9.0)

```json
{ "id": "…", "type": "incident.upsert",
  "incident": { "id": "…", "revision": 2, "alarm_at": "2026-11-14T13:30:00.000Z", "number": 81, "keyword": "F 2",
                "keyword_label": "Brand", "category": "Brand", "title": "Kaminbrand", "location": "Nord", "report": "…",
                "vehicles": "HLF, DLK", "units": "Polizei", "link_url": null, "featured": false, "false_alarm": false,
                "cover_media_id": "…" },
  "media": [ { "id": "…", "kind": "image", "alt": "Kaminbrand – Bild 1", "mime": "image/jpeg", "filename": "…", "path": "/api/v1/bridge/media/…" } ] }
{ "id": "…", "type": "incident.delete", "incident": { "id": "…" }, "media_ids": ["…"] }
```

Freigegebene Einträge der Einsatzliste (#213). BlaulichtCMS liefert sie nur an Bridges aus, die mit der Kopfzeile
`X-BlaulichtCMS-Bridge-Version` mindestens 0.9.0 melden – bei älteren Bridges warten die Aufträge. Ein noch nicht
abgeholter Auftrag, dessen Fassung nicht mehr freigegeben ist, wird abgebrochen. Die Bridge legt je Eintrag einen Inhalt vom
Typ `blaulichtcms_einsatz` an (gefunden über `_bcl_id`), übernimmt Bilder wie bei Beiträgen und meldet das Ergebnis über
`POST /bridge/jobs/{id}/result` (`url` = Detailseite, leer bei abgeschalteten Detailseiten). `incident.delete` löscht den
Inhalt endgültig samt nicht anderweitig verwendeter Bilder; ein nicht vorhandener Eintrag gilt als erledigt. Der Ort ist
in BlaulichtCMS bereits auf Ortsteil-Ebene gebracht; Adressen und Namen werden nicht übertragen.

`alt` je Bild: Alternativtext für `_wp_attachment_image_alt` (Beiträge und Einsatzliste). Ab Bridge 0.9.0 zieht die
Bridge einen geänderten Text auch bei bereits übernommenen Bildern nach, solange er in WordPress nicht von Hand geändert
wurde (Meta `_blaulichtcms_alt` merkt sich den zuletzt übertragenen Text).

## Medien laden

```http
GET /api/v1/bridge/media/{id}
```

Die Bridge setzt `path` an die BlaulichtCMS-Adresse, mit der sie gekoppelt ist (`url` dient nur zur Information).
Nur Medien, die zu einem Auftrag **dieser** Website gehören (Beitrag oder Eintrag der Einsatzliste). Ausgeliefert wird die **öffentliche Fassung** ohne
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

Eine wiederholte Erfolgsmeldung ändert nichts (`"duplicate": true`). Ein in BlaulichtCMS abgebrochener Auftrag liefert 409.

## Idempotenz in WordPress

- Beitrag: Meta `_blaulichtcms_post_id`. Existiert ein Beitrag mit dieser ID, wird er aktualisiert statt neu angelegt.
- Medien: Meta `_blaulichtcms_media_id` an Anhängen – jede Datei wird nur einmal in die Mediathek übernommen.
- Eine Sperre mit Besitzer-Token verhindert parallele Abrufe (WP-Cron und Host-Cron gleichzeitig). Sie wird vor jedem
  Auftrag und vor und nach jeder Mediendatei erneuert und gilt erst nach 10 Minuten ohne Erneuerung als verwaist
  (Einzel-Download höchstens 5 Minuten). Dauert ein Auftrag länger als 4 Minuten, beginnt die Bridge keine weitere
  Mediendatei, meldet kein Ergebnis und setzt beim nächsten Abruf fort; bereits übernommene Medien werden wiederverwendet.

Damit gilt: Doppeltes Abholen, doppelte Bestätigung, verlorene Rückmeldung oder „Ergebnis unbekannt“ führen zu genau
**einem** WordPress-Beitrag.

## Updates und Code-Signatur

`GET /api/v1/bridge/update` liefert das Angebot (Version, `sha256`, `signed`, kurzlebige `package_path`). Die Bridge lädt
das Paket beim Klick auf „Aktualisieren“ über ein frisch abgerufenes Angebot und prüft die Prüfsumme; ist in ihr ein
Signaturschlüssel hinterlegt, zusätzlich die Ed25519-Signatur in `signature.json`. Verfahren, Einrichtung und
Restrisiko: `docs/bridge-signatur.md`.

Automatische Updates (Bridge ab 0.8.0): Die Bridge trägt sich immer in das Update-Verzeichnis von WordPress ein
(`response` mit neuer Version, sonst `no_update`). Damit funktioniert der Schalter „Automatische Updates aktivieren“ in
der Plugin-Liste; WordPress installiert über denselben geprüften Download (`upgrader_pre_download`). Ist WP-Cron
abgeschaltet, ruft die Selbstauslösung höchstens alle 12 Stunden `WP_Automatic_Updater::update()` nur für die Bridge
auf (gleiche Prüfungen wie WordPress: Schalter, Filter `auto_update_plugin`, Dateirechte). Die Kopfzeile
`Update URI: https://blaulichtcms.invalid/bridge` verhindert, dass WordPress ein gleichnamiges Plugin von wordpress.org
anbietet.

## Meldung der Bridge

```http
POST /api/v1/bridge/report
```

```json
{
  "categories": [ { "id": 12, "name": "Einsätze", "parent": 0 } ],
  "cron": { "mode": "self", "wp_cron_disabled": true, "healthy": true, "hint": "" },
  "auto_update": true,
  "author_mode": "bridge",
  "display": { "info": "banner", "warning": "banner", "danger": "both" },
  "banner_auto": true
}
```

Antwort: `{ "ok": true, "send_author": false }`. Die Bridge (ab 0.8.0) sendet nach einem erfolgreichen Abruf, wenn sich
etwas geändert hat, sonst höchstens alle 6 Stunden. BlaulichtCMS speichert die Meldung je Website
(`wp_sites.bridge_report`) und zeigt sie auf der Website-Karte; die Kategorien erscheinen als Auswahl im Beitrag und im
Ausgang „Beitrag“. `cron.mode`: `wp-cron`, `host` (WP-CLI oder wp-cron.php per Host-Cron), `self` (Selbstauslösung),
`manual` oder `unknown`.

## Abruf

- WP-Cron: Ereignis `blaulichtcms_bridge_poll`, jede Minute.
- Selbstauslösung (ab 0.8.0), wenn WP-Cron abgeschaltet ist (`DISABLE_WP_CRON`): Am Ende eines Seitenaufrufs sendet
  die Bridge höchstens einmal je Abrufintervall eine nicht blockierende Anfrage an
  `admin-ajax.php?action=blaulichtcms_bridge_tick` der eigenen Website (Prüfwert aus den Schlüsseln der wp-config.php).
  Mit aktivem WP-Cron nur als Rückfall, wenn 10 Minuten kein Abruf lief.
- Host-Cron (optional): `* * * * * wp --path=/var/www/html blaulichtcms-bridge poll`
- WP-CLI: `wp blaulichtcms-bridge pair <url> <code>`, `wp blaulichtcms-bridge status`
