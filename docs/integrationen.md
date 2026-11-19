# Integrationen – Prüfstand

Stand: 14.11.2026 (Meilenstein 4 plus produktionsnaher Bridge-Test in echtem WordPress). Einstufung je Verbindung: **lokal** (Testdienst/fiktive Daten),
**Anbieter** (echtes Testkonto beim Anbieter), **produktionsnah** (reale Zielumgebung, ohne echte Veröffentlichung
an die Öffentlichkeit). Alle Verbindungen sind optional und durchlaufen **Verbinden → Testen → Vorschau → Aktivieren**.

| Verbindung | Umgesetzt | Lokaler Test | Test mit Anbieter | Produktionsnah | Konkret fehlender Live-Test |
|---|---|---|---|---|---|
| **WordPress (BlaulichtCMS Bridge)** | ✅ Beiträge mit Medien, Banner, Einsatzübersicht, Zurückziehen, Updates über WordPress | ✅ WordPress 6.9 (Docker), PHP 8.3, Host-Cron, Idempotenz, Update über den WordPress-Updateweg mit Prüfsumme und erhaltener Kopplung | – (kein Anbieter) | ✅ teilweise: WordPress 7.1.4 / PHP 8.5, Bridge 0.5.1, HTTPS mit geprüftem Zertifikat, WP-Cron **und** Host-Cron, Twenty Twenty-Five, WP Super Cache (siehe unten) | nur noch: Bridge auf der **eigenen** Testwebsite mit deren Theme und Cache, produktive Adresse mit echtem Zertifikat |
| **Facebook-Seite** | ✅ Graph API v27.0, OAuth, Seitenwahl, Text/Fotos/Video, Status je Netzwerk, gezieltes Wiederholen, Prüfung bei unbekanntem Ergebnis, manueller Export | ✅ Graph-API-Ersatz: unveröffentlichter Testbeitrag + Löschen, Ablehnung (400), Serverfehler nach Anlage (500 → „unbekannt“ → gefunden, kein Duplikat), OAuth-Rückweg ohne Cookie | ❌ | ❌ | Meta-App mit Facebook Login, App-Prüfung der Rechte `pages_manage_posts` u. a., Testseite; Veröffentlichung eines nicht öffentlichen Testbeitrags |
| **Instagram-Konto** | ✅ Instagram Login, Container, Statusprüfung, Karussell, Reels, Kontingent | ✅ Graph-API-Ersatz: Container ohne Veröffentlichung im Test, Veröffentlichung mit Permalink, keine Doppelveröffentlichung | ❌ | ❌ | professionelles Testkonto, App-Prüfung für `instagram_business_content_publish`, öffentlich erreichbare HTTPS-Adresse für den Medienabruf |
| **Storys (Facebook/Instagram)** | ✅ Instagram-Container `media_type=STORIES`, Facebook `photo_stories` (Foto unveröffentlicht hochgeladen) und `video_stories` (start → gehostete Datei → finish), Bilder automatisch 1080 × 1920 ohne Beschnitt, Wiedererkennung über Container bzw. Foto-ID | ✅ Graph-API-Ersatz: Foto-Story, Instagram-Story ohne Bildunterschrift neben Beitrag, Story-Fassung 1080 × 1920 | ❌ | ❌ | Story auf einer Testseite bzw. einem Testkonto; Video-Story (Upload über rupload.facebook.com) bisher nur nach Doku umgesetzt |
| **Threads** | ✅ Threads-API v1.0 (graph.threads.com), OAuth mit `threads_basic` und `threads_content_publish`, langlebiger Token mit automatischer Verlängerung, Text/Bild/Karussell/Video/Link, Kontingent, Wiedererkennung | ✅ Threads-API-Ersatz: OAuth-Rückweg, Test-Container ohne Veröffentlichung, Bildbeitrag, Token-Verlängerung | ❌ | ❌ | Meta-App mit Threads-Anwendungsfall, Threads-Tester, Testprofil |
| **X** | ✅ Teilen von Hand (280 Zeichen nach X-Zählregeln, Beitragsfenster `x.com/intent/post`) oder X-API v2 mit OAuth 1.0a (node:crypto, Testvektor der X-Doku): `GET /2/users/me`, Prüfung der Zugriffsstufe, `POST /2/media/upload` (Bilder), `POST /2/tweets`, `DELETE /2/tweets/:id` | ✅ X-API-Ersatz prüft jede Signatur, nur-lesender Token wird abgelehnt, Bild + Beitrag, Löschen | ❌ | ❌ | eigene X-App mit Guthaben (kostenpflichtig); Kopfzeile `x-access-level` am echten Dienst prüfen |
| **Mastodon** | ✅ Mastodon-API der gewählten Instanz: App-Registrierung `POST /api/v1/apps`, OAuth (Autorisierungscode) oder Zugangstoken, `GET /api/v2/instance` (Grenzen), `POST /api/v2/media` mit Alternativtext (202 → Abfrage), `POST /api/v1/statuses` mit Sichtbarkeit, Inhaltswarnung, Sprache und Idempotency-Key, Löschen, Wiedererkennung | ✅ Instanz-Ersatz: App-Registrierung, OAuth-Rückweg, Test mit geplantem Beitrag (sofort gelöscht) und Testbild, Bildbeitrag, unklarer Ausgang ohne Duplikat, Löschen | ❌ | ❌ | Konto auf einer echten Instanz (z. B. social.bund.de), App-Registrierung und Beitrag mit Bild |
| **Bluesky** | ✅ AT Protocol mit App-Passwort: `createSession`, `uploadBlob` (Bilder bis 2 MB, verkleinert), `createRecord` (`app.bsky.feed.post`, 300 Grapheme, Facetten für Links und Hashtags, Bilder mit `alt`, Link-Vorschaukarte), `deleteRecord`, `listRecords` (Wiedererkennung) | ✅ PDS-Ersatz: falsches App-Passwort, Test mit Testbild ohne Beitrag, Bildbeitrag, unklarer Ausgang ohne Duplikat, Löschen | ❌ | ❌ | Testkonto auf bsky.social mit App-Passwort, Beitrag mit Bild und Vorschaukarte |
| **Reichweite (#218)** | ✅ Facebook (Felder `shares`, `comments`/`reactions` mit `summary`, Insights `post_media_view`, `post_total_media_view_unique`, `post_clicks`), Instagram (`like_count`, `comments_count`, Insights `views`, `reach`, `shares`, `saved`), Threads (Insights `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`), X (`public_metrics`, nur ausdrücklich eingeschaltet), Mastodon (`GET /api/v1/statuses/:id`), Bluesky (`app.bsky.feed.getPosts` der öffentlichen AppView); Abruf nach 1 h, 24 h, 7 Tagen | ✅ Mastodon- und Bluesky-Ersatz: Stufen, verspäteter Abruf, ausgeschalteter Abruf, Fehler je Beitrag, Rechte | ❌ | ❌ | Statistik-Rechte `read_insights`, `instagram_business_manage_insights`, `threads_manage_insights` in der App-Prüfung von Meta; Werte am echten Dienst vergleichen |
| **WhatsApp-Kanal** | ✅ nur Teilen von Hand (keine Schnittstelle des Netzwerks bei WhatsApp): Text mit WhatsApp-Formatierung, Link, Dateien, „als geteilt markieren“ | ✅ zum Teilen bereit, Benachrichtigung, als geteilt markieren (auditiert) | – (keine Schnittstelle) | – | – |
| **FE2** | ✅ Eingang mit Zugangsschlüssel, Allowlist, ein Entwurf je Einsatz, Folgeereignisse | ✅ HTTP-Testmeldungen: Vorschau vor Aktivierung, Wiederholung erkannt, Alarmtext verworfen, keine Inhalte in Protokollen; zusätzlich Formular, `text/plain`, Einheiten als Objekte, deutsche Alarmzeit | ❌ | ❌ | anonymisierte Testmeldung aus der echten FE2-Instanz (HTTP-Ausgang, tatsächliches Format) – Anleitung unten |
| **Feuersoftware Connect** | ✅ Abruf `GET /operation?onlyLatest=true` mit API-Key, Abstand 60/120/180/300 s, Retry-After, höchstens ein Abruf gleichzeitig, Filter RIC/Stichwort, nur Einsätze der letzten 24 Stunden, ein Entwurf je Einsatz (gemeinsamer Weg mit FE2), Störungsmeldung nach drei Fehlschlägen | ✅ nachgebildete Connect-Schnittstelle: Test mit Filter und Vorschau ohne Adresse, 401/403/404/429/5xx/kein JSON, Pause nach 429, keine Duplikate, gelöschte Einsätze nicht erneut, Abruf nur aktiver Verbindungen, Löschfrist | ❌ | ❌ | API-Key der Öffentlichen Connect Schnittstelle eines Standorts, Probealarm in Connect, Abgleich der tatsächlich gelieferten Felder (RIC, Adresse, Start) |
| **SMTP (Warnentwurf)** | ✅ PDF-Anhang, Testmodus, Status angenommen/fehlgeschlagen/unbekannt | ✅ lokaler Test-Mailserver: Annahme, 550-Ablehnung, Abbruch nach DATA; **STARTTLS und TLS (465) mit Anmeldung und Zertifikatsprüfung** (unbekanntes Zertifikat und falsches Passwort klar abgewiesen, ohne TLS keine Anmeldung) | ❌ | ❌ | Versand über den Mailserver der Organisation an ein abgestimmtes Testpostfach der zuständigen Stelle (TLS, SPF/DKIM) |
| **RSS / Atom** | ✅ Vorschau, Deduplizierung, ETag, Themenideen | ✅ WordPress-Feed als Quelle | – | ❌ | echte Feeds der Organisation |
| **Amtliche Warnfeeds** | ✅ Warn-App-Schnittstelle (Regionalschlüssel) und CAP-Adressen, Gebietsfilter, Aktualisierung, Entwarnung, automatische Banner nur nach dokumentierter Prüfung | ✅ CAP-Testquelle: privates Ziel erst nach Freigabe, Gebietsfilter, Update ersetzt, Cancel beendet Banner | ✅ echte Warn-App-Schnittstelle (warnung.bund.de) mit einem Regionalschlüssel im Main-Taunus-Kreis, siehe unten | ❌ | schriftliche Bestätigung des BBK zur Weiterverwendung der MoWaS-Inhalte auf der eigenen Website |
| **LiFeOS-Import** | ✅ Importrahmen (Austauschformat, Probelauf, Prüfsummen, Mengenabgleich, Altlink-Weiterleitung) | ✅ fiktive Testdaten | – | ❌ | **Umsetzer `scripts/lifeos-export.py` fertig (LiFeOS-3.56.2-Schema, fiktive Daten); Lauf gegen echte Kopie offen** – Umsetzer erstellen, Import gegen eine Kopie (#35) |

## WordPress – was lokal geprüft wurde

- Installation der Bridge aus der ZIP, die BlaulichtCMS unter *Websites* ausliefert (`wp plugin install`).
- Kopplung über die Einstellungsseite in WordPress mit einmaligem Code; Code danach verbraucht (401).
- Abholung per Host-Cron (`wp blaulichtcms-bridge poll`), Veröffentlichung mit Titelbild, Rückmeldung von ID und Permalink.
- BlaulichtCMS zeigt die bestätigte URL im Beitrag und im Dashboard.
- Erneute Auslieferung (Status „Ergebnis unbekannt“) und doppelte Rückmeldung: weiterhin genau **ein** Beitrag und **ein** Anhang.
- Öffentliche Medienfassung ohne EXIF; Medien nur für Aufträge der eigenen Website abrufbar.
- Widerrufene Kopplung: 401 bei der nächsten Anfrage.
- Wiederhergestellte BlaulichtCMS-Instanz: Bridge arbeitet mit ihrem bisherigen Schlüssel weiter.

Nicht geprüft: Multisite, große Videodateien über die Bridge. Für Multisite hält die Bridge ab 0.6.0 das Update-Angebot
je Website; im Netzwerk-Admin übernimmt eine gekoppelte Website des Netzes Angebot und Prüfsummenkontrolle (#161).

## WordPress – produktionsnaher Test am 14.11.2026

Echtes WordPress 7.1.4 (PHP 8.5, SQLite, Theme Twenty Twenty-Five), Bridge aus der ZIP der laufenden BlaulichtCMS-Instanz,
BlaulichtCMS hinter einem TLS-Proxy mit eigener Test-CA.

| Prüfung | Ergebnis |
|---|---|
| Installation 0.5.0 → 0.5.1 per `wp plugin install` | ✅ aktiv, keine PHP-Meldungen der Bridge im `debug.log` |
| Kopplung per **HTTPS**, Zertifikat von WordPress geprüft | ✅ ohne vertraute CA abgewiesen (cURL 60), mit CA gekoppelt |
| `http://` ohne `BLAULICHTCMS_BRIDGE_ALLOW_HTTP` | ✅ Kopplung abgewiesen; **neu in 0.5.1:** auch eine früher per `http://` gekoppelte Website ruft dann nicht mehr ab |
| Abruf über **Host-Cron** (`wp blaulichtcms-bridge poll`) | ✅ |
| Abruf über **WP-Cron** (nur Seitenaufrufe, kein CLI) | ✅ |
| Beitrag mit Titelbild und Bildern, Kurzfassung, Absätze | ✅ Rückmeldung von ID und Permalink, URL in BlaulichtCMS |
| Bilder in der Mediathek | ✅ **neu in 0.5.1:** Titel und Alternativtext aus dem Beitragstitel statt Datei-Kennung; seit #217 schickt BlaulichtCMS im Feld `alt` je Bild den Alternativtext der Fassung bzw. der Medienverwaltung (ohne ihn wie bisher den Titel) |
| Banner (Gefahr + Hinweis) automatisch am Seitenanfang | ✅ **neu in 0.5.1:** bei gleicher Priorität Gefahr vor Hinweis |
| Bannerende mit **Seitencache** (WP Super Cache) | ✅ veraltete Seite aus dem Cache: Banner im Browser ausgeblendet; Termin zum Bannerende leert den Cache, danach frische Seite ohne Banner |
| Einsatzübersicht (Shortcode `[blaulichtcms_einsaetze]` und Block) | ✅ zeigt den veröffentlichten Einsatzbericht |

Offen bleibt nur, was eine fremde Umgebung braucht: die eigene Testwebsite (Theme, dort eingesetztes Cache-Plugin,
Hosting-Cron) und die produktive BlaulichtCMS-Adresse mit echtem Zertifikat. Ablauf dafür: *Einrichtung → Verbindungen → Websites → Website
koppeln*, Bridge-ZIP auf der Testwebsite installieren, Code eingeben, einen internen Testbeitrag veröffentlichen,
Banner mit kurzer Laufzeit anlegen und nach Ablauf die Startseite (auch ausgeloggt) prüfen.

## FE2 – Anbindung der echten Instanz

BlaulichtCMS liest das Format des FE2-HTTP-Ausgangs über eine Zuordnung je Feld (Pfad im JSON mit Punkten). Ohne
eigene Zuordnung gelten die Standardpfade; andere Feldnamen oder Hüllen werden nur über eine eingetragene Zuordnung
gelesen:

| Feld | Standardpfad | Hinweis |
|---|---|---|
| Einsatz-ID | `einsatz.id` | ohne Einsatz-ID wird die Meldung verworfen |
| Stichwort | `einsatz.stichwort` | |
| Stichwort (Klartext) | `einsatz.stichwort_text` | fehlt er, ergänzt BlaulichtCMS ihn aus dem Stichwortverzeichnis (Bundesland in den Einstellungen) |
| Ort / Ortsteil | `einsatz.ort` / `einsatz.ortsteil` | |
| Alarmzeit | `einsatz.alarmzeit` | Unix-Zeit, ISO oder `14.11.2026 18:35` (deutsche Ortszeit) |
| Einheiten | `einsatz.einheiten` | Liste von Namen, Objekten (`name`) oder Text |
| Status | `einsatz.status` | „beendet“, „abgeschlossen“, „closed“ schließen den Einsatz |

Straße, Hausnummer, Meldungstext, Meldende und Koordinaten werden nie übernommen (Allowlist). Angenommen werden JSON,
Formulardaten und JSON als `text/plain`.

**Einrichtung in FE2:** Im FE2-Alarmablauf einen HTTP-Ausgang an
`https://<blaulichtcms>/api/v1/inbound/fe2/<verbindungs-id>` anlegen und den Schlüssel (`bcfe2_…`) als
`Authorization: Bearer …` oder `X-BlaulichtCMS-Token` eintragen. Kann der FE2-Ausgang keine eigene Kopfzeile setzen,
in der Verbindung **Schlüssel in der Adresse** einschalten und die zweite Adresse
`https://<blaulichtcms>/api/v1/inbound/fe2/<verbindungs-id>/<schlüssel>` verwenden (Schlüssel dann in Adressen und
Proxy-Protokollen – siehe [reverse-proxy.md](reverse-proxy.md#zugriffsprotokolle-des-proxys-datenschutz)). Erste Meldung mit Kopfzeile `X-BlaulichtCMS-Test: 1` senden
(nur Vorschau) und unter *Verbindungen → FE2* prüfen, welche Felder übernommen wurden; bei Bedarf die Zuordnung anpassen.

## Meta Graph API – Versionswechsel auf v27.0 (15.11.2026)

Geprüft wurden der [Graph-API-Changelog](https://developers.facebook.com/docs/graph-api/changelog) mit den Hinweisen zu
[v27.0](https://developers.facebook.com/documentation/development/graph-api/changelog/version27.0) (veröffentlicht am
04.11.2026) und [v26.0](https://developers.facebook.com/documentation/development/graph-api/changelog/version26.0) sowie
der [Instagram-Platform-Changelog](https://developers.facebook.com/docs/instagram-platform/changelog):

| Genutzt | Ergebnis |
|---|---|
| Seitenbeiträge (`/{page}/feed`), Fotos, Videos, Löschen, `permalink_url`, `/{page}?fields=id,name,link` | unverändert (v27.0 ergänzt nur optional `is_ai_generated` beim Bearbeiten) |
| `/me/accounts`, `/me/permissions`, OAuth-Dialog, `/oauth/access_token` (Code und Langzeit-Token) | keine Einträge; der Changelog von Facebook Login hat keine Einträge seit 2018 |
| Rechte `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_business_basic`, `instagram_business_content_publish` | unverändert |
| Instagram: Container (`image_url`, `video_url`, `REELS`, `CAROUSEL`), `status_code`, `media_publish`, `content_publishing_limit`, `permalink` | unverändert; `is_ai_generated` nur ergänzt. `media_url` kann seit 30.07.2026 fehlen – nutzt BlaulichtCMS nicht |
| Für alle Versionen entfernt: `date_format`, `GET /?ids=`, `pretty`/`debug`, `If-None-Match` | nutzt BlaulichtCMS nicht |

Code-Änderung: nur die Versionsnummer. Der Live-Test mit einer echten Meta-App steht weiterhin aus (siehe Tabelle oben).

## Feuersoftware Connect – Anbindung

BlaulichtCMS fragt die Öffentliche Connect Schnittstelle ab (`https://connectapi.feuersoftware.com/interfaces/public`,
Beschreibung in der [Feuersoftware-Dokumentation](https://docsv2.feuersoftware.com/connect/schnittstellen/public_api)).
Der API-Key entsteht im [Connect Portal](https://connect.feuersoftware.com) unter Standort → Schnittstellen →
„Öffentliche Connect Schnittstelle“. Abgerufen wird nur `GET /operation?onlyLatest=true` (Kopfzeile
`Authorization: bearer <Key>`); Lagemeldungen (`/operation/{id}/message`) ruft BlaulichtCMS bewusst nicht ab.

| Feld in Connect | Im Entwurf |
|---|---|
| `Id` | Einsatz-ID (Erkennung von Wiederholungen, nur als Prüfsumme im Protokoll) |
| `Keyword` / `Category` | Stichwort / Einsatzart |
| `Address.CityWithDistrict` bzw. `Address.City` | Ort (ohne Straße und Hausnummer) |
| `Start` | Alarmzeit (Zeitzone der Instanz); nur Einsätze der letzten 24 Stunden |
| `End` | schließt den Einsatz |
| `Ric` | nur für den Filter |

Sachverhalt (`Facts`), Einsatznummer, Koordinaten, meldende Person und Telefonnummern werden nie gespeichert.
Feldnamen in camelCase werden ebenso gelesen. Fehlerbilder: 401 (Key abgelehnt bzw. Schnittstelle im Portal nicht
aktiv), 403, 404, 429 (Pause nach `Retry-After`, sonst 60 s), 5xx, Zeitüberschreitung, nicht erreichbar, keine JSON-Antwort.
Nach drei Fehlschlägen in Folge erhält die Verwaltung eine Benachrichtigung, beim nächsten Erfolg wird sie aufgehoben.

**Offen (Live-Test):** API-Key eines Standorts eintragen, *Testen*, Probealarm in Connect auslösen, *Jetzt abrufen*
und den Entwurf prüfen – insbesondere, welche RIC-Bezeichnung Connect tatsächlich liefert.

## Amtliche Warnfeeds – Abruf der echten Schnittstelle am 14.11.2026

Abruf mit dem Code von BlaulichtCMS gegen `https://warnung.bund.de/api31` (Dashboard je Kreis-ARS, Details je Meldung).

| Befund | Folge |
|---|---|
| Detailansichten von DWD- **und** MoWaS-Meldungen enthalten keine Geocodes; DWD nennt nur gekürzte Ortslisten („… und 519 weitere“) | Bisher fiel jede dieser Meldungen durch einen gesetzten Gebietsfilter – keine Benachrichtigung, kein Banner. **Behoben:** Meldungen aus dem Kreis-Dashboard tragen den Kreis-ARS als Gebiet. |
| Eine Kreiswarnung betrifft auch die eigene Gemeinde | **Behoben:** Der Filter prüft Überschneidung in beide Richtungen (Gemeinde-ARS im Filter trifft Kreis- und Landeswarnungen; Nachbarkreise weiterhin nicht, #60). |
| Bannertext übernahm die ersten drei Orte einer bundesweiten DWD-Liste | **Behoben:** Nur Orte, die zum Ortsnamen-Filter passen; sonst keine Ortsnennung. |
| Quellenvermerk | **Neu:** Jeder Bannertext endet mit „Quelle: …“ (z. B. Deutscher Wetterdienst, MoWaS (BBK)). |

Ergebnis des Abrufs: 1 aktuelle Meldung (DWD, Aufhebung einer Glättewarnung) – vorher 0 von 1 im Gebiet, jetzt mit
Gemeinde-, Kreis- und Landesfilter jeweils 1 von 1. Bundesweit waren 8 MoWaS-Meldungen aktiv, alle ohne Geocodes.

**Nutzungsbedingungen (Stand der Recherche):**

- **DWD-Warnungen:** frei weiterverwendbar nach Geodatennutzungsverordnung, **Quellenvermerk Pflicht** – auch bei
  Auszügen und geändertem Format ([DWD, Copyright](https://www.dwd.de/EN/service/copyright/copyright_node.html)).
  BlaulichtCMS setzt ihn im Bannertext und verlinkt die Originalmeldung.
- **MoWaS / Warn-App-Schnittstelle des BBK:** keine veröffentlichten Bedingungen für die Weiterverwendung gefunden;
  die Schnittstelle ist nicht offiziell dokumentiert. Vor dem Einsatz automatischer Banner schriftlich beim BBK
  bestätigen lassen – Weg für Weiterverbreiter ist das Programm
  [Warnmultiplikatoren](https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warnung-in-Deutschland/Warnmultiplikatoren/warnmultiplikatoren_node.html)
  (Warnmultiplikatoren@bbk.bund.de; NINA@bbk.bund.de ist der Helpdesk der Warn-App). Bis dahin: Banner nur als Entwurf mit normaler Freigabe (Standard), Link auf
  warnung.bund.de als maßgebliche Quelle.

