# Technischer Aufbau

Aufbau, Sicherheit, Teststand und Entwicklung von BlaulichtCMS. Installation und Betrieb beschreibt
[installation.md](installation.md).

## Aufbau

```mermaid
flowchart LR
    B["🌐 Browser / Handy<br/>(App, installierbar)"] -->|HTTPS| P["Reverse Proxy"]
    P -->|"http://blaulichtcms:7310"| API
    subgraph C["Container blaulichtcms"]
      S["Supervisor"] --> PG[("PostgreSQL 18<br/>nur Unix-Socket")]
      S --> API["API (Fastify)"]
      S --> W["Worker<br/>Medien, Jobs, Fristen"]
      API --- PG
      W --- PG
    end
    C --- V[("Volume<br/>Datenbank, Medien, Schlüssel")]
    WP["WordPress + BlaulichtCMS Bridge"] -->|"HTTPS, holt Aufträge ab"| P
    W -->|"Graph API, SMTP, Warn-Feeds"| EXT["Facebook / Instagram,<br/>Mailserver, amtliche Warnungen"]
    FE2["FE2"] -->|"HTTPS mit Schlüssel"| P
    W -->|"HTTPS-Abruf mit API-Key"| FS["Feuersoftware Connect"]
```

| Baustein | Technik |
|---|---|
| Server | TypeScript, Node.js, Fastify; Worker für Medienverarbeitung (sharp, ffmpeg, Gesichtsvorschläge mit YuNet über onnxruntime), Hintergrundaufträge und Löschfristen |
| Datenbank | PostgreSQL 18 im selben Container, nur über Unix-Socket; getrennte Rollen für Migrationen und Anwendung |
| Oberfläche | React 19, Vite, Tailwind 4, TanStack Query; installierbare Web-App (PWA), Live-Aktualisierung per Server-Sent Events |
| WordPress | Plugin „BlaulichtCMS Bridge“ (PHP) – holt Aufträge per HTTPS ab, BlaulichtCMS öffnet keinen Eingang zur Website |
| Betrieb | ein Container, ein Volume, ein Port; Supervisor startet Datenbank, Migrationen, API und Worker und schaltet bei Updates um |
| Updates | signierte Releases (Ed25519) aus GitHub, Sicherung vorab, automatischer Rückweg |

Die Architekturentscheidungen mit Begründung stehen in [architektur.md](architektur.md).

---

## Verbindungen

Alle Verbindungen sind optional und laufen unter *Kanäle → Verbindungen* nach dem Muster
**Verbinden → Testen → Vorschau → Aktivieren**.

| Verbindung | Wofür | Geprüft |
|---|---|---|
| WordPress (Bridge) | Beiträge, Banner, Einsatzübersicht, Einsatzliste mit Jahresstatistik (ab 0.9.0); Updates mit Ed25519-Signatur | echtes WordPress mit HTTPS |
| FE2 | interner Entwurf je Einsatz; Feldzuordnung je Instanz | mit nachgebildeten Meldungen |
| Feuersoftware Connect | regelmäßiger Abruf der Öffentlichen Connect Schnittstelle (60–300 s, Retry-After), Filter nach RIC und Stichwort, derselbe Entwurf wie bei FE2 (nur Ort, keine Adresse) | gegen nachgebildete Connect-Schnittstelle |
| Amtliche Warnungen | Warn-App-Schnittstelle des Bundes (Kreis-ARS) oder CAP, Banner mit Quellenvermerk | echte Schnittstelle |
| Facebook / Instagram | Veröffentlichung und Zurückziehen je Kanal mit eigenem Status (Graph API v27.0), auch als Story | gegen nachgebildete Graph API |
| Threads / X | Threads-API (OAuth, Token-Verlängerung); X über die X-API (OAuth 1.0a) oder Teilen von Hand | gegen nachgebildete Schnittstellen |
| Mastodon / Bluesky | Mastodon-API der gewählten Instanz (App-Registrierung, OAuth oder Zugangstoken); Bluesky über das AT Protocol mit App-Passwort – beides reines HTTP/JSON ohne zusätzliche Abhängigkeit | gegen nachgebildete Schnittstellen |
| WhatsApp-Kanal | Teilen von Hand (keine Schnittstelle bei WhatsApp) | – |
| E-Mail (Warnentwurf) | PDF-Versand an die zuständige Stelle, STARTTLS/TLS | Mailserver mit TLS |
| Medienimport | einmalige Übernahme von Medien und gültigen Upload-Links aus einem Altsystem (Austauschformat; Exportskript für LiFeOS) | mit fiktiven Daten |

Details und Einrichtung: [docs/integrationen.md](integrationen.md), Hilfe → *Verbindungen*.

## Workflows (intern „automations“)

Bereich *Workflows* (Liste, Eingänge, Ausgänge, Editor; bis 0.3.0 „Automationen“). Umbenannt ist nur, was man sieht:
Oberfläche unter `/workflows` (alte Adressen `/automationen/…` leiten weiter, ebenso `/hilfe/automationen` samt
Ankern), Texte, Benachrichtigungen, Audit-Anzeige und Anzeigenamen der Rechte. API-Pfade (`/api/automations…`),
Tabellen, Einstellungen (`automations.*`), Rechte-IDs (`automation.*`) und das Exportformat `blaulichtcms.automations`
bleiben gleich – eine bestehende Installation läuft ohne Migration weiter. Der Editor nutzt **React Flow** (`@xyflow/react`, MIT) für
die Fläche und **dagre** (`@dagrejs/dagre`, MIT) für „Automatisch anordnen“ – beides nur in der Oberfläche
(`web/dist`), keine neuen Laufzeit-Abhängigkeiten des Servers. Server: `server/src/automations/` (Katalog, Prüfung,
Vorlagen/Bedingungen, Engine, Ereignisse), API `server/src/routes/automations.ts`, Migration `060_automations.sql`.

| Teil | Umsetzung |
|---|---|
| Ablauf | Knoten/Kanten als JSON; Prüfung auf Kreise, Anschlüsse, Ports, Felder je Stelle, Grenzen (60 Knoten, 150 Kanten) |
| Versionen | Entwurf → Testlauf (Trockenlauf, sofort in der Anfrage) → Aktivieren als unveränderliche Momentaufnahme samt Ein-/Ausgängen |
| Auslöser | Funktionsaufrufe in FE2/Feuersoftware (`handleIncident`), Warnfeed-Abruf, RSS-Abruf, Medienprüfung; Zeitpläne im Worker-Leader |
| Ausführung | Auftrag `automation.run`, Advisory-Lock je Lauf, Schritt je Knoten, Ergebnis + Schritt in einer Transaktion, Wiederholung mit Backoff, Warten/Freigabe als Fortsetzung |
| Grenzen | `automations.max_runs_per_minute` (20), `automations.enabled`, Deaktivieren als Notbremse, `privacy.automation_run_days` (30) |
| Direktversand | je Automation, Recht `automation.publish`, Passwortbestätigung, Test, Audit, Sicherheitsmeldung (Architektur E17) |
| Vorlagen | `automations/templates.ts`: Abläufe nur aus Katalog-Bausteinen, im Katalog (`templates`) ausgeliefert; `POST /automations` mit `template` setzt den einzigen passenden Ein-/Ausgang ein, sonst bleibt ein offener Platz (`data.want`: passende Arten + Startwerte fürs Anlegen) |
| Geführte Ansicht | `web/src/pages/automations/workflowModel.ts` (reine Funktionen): Ablauf ↔ Modell „Wenn → Nur wenn → Dann“ (Eingänge, höchstens eine Bedingung ohne Untergruppen, Ausgänge, Kanten genau nach Muster); alles andere nur lesend mit Hinweis auf „Erweitert“; Checkliste vor dem Aktivieren aus `validateGraph` (`open` = offene Plätze) |
| Zusammenfassung | `automations/summary.ts`: ein Satz je Workflow, in Liste, Detail und `POST /automations/:id/validate` (`summary`) |
| Export/Import | `automations/transfer.ts`: Format `blaulichtcms.automations`, `schemaVersion` 1, App-Version; Ein-/Ausgänge nur als Bezug (Art + Name), kein `direct`; `GET /automations/export` (automation.read), `POST /automations/import/preview` und `/automations/import` (automation.manage, höchstens 1 MB und 50 Automationen, Import immer als Entwurf) |
| Mit KI erstellen (#199) | `automations/format.ts`: JSON-Schema (Draft 2020-12) aus den Zod-Schemas der Importprüfung, statisch unter `/schema/blaulichtcms-automations-1.schema.json` (`web/public/schema/`), Hilfe-Referenz und Anfrage-Vorlage – alles mit `npx tsx scripts/workflow-format.mjs` erzeugt, Unit-Test prüft die Aktualität; `automations/aicatalog.ts`: `GET /automations/catalog/export` (automation.read, Audit `automation.catalog_exported`) nur aus einer Positivliste (Art + Name, Feldnamen, Bildvorlagen-Textfelder, Kalender-Kategorien, Stichwort/Bezeichnung/Kategorie); Importfehler mit JSON-Pfad, Erwartung und Fund |

Tests: `server/test/workflow-guided.test.ts` (ohne Datenbank: Roundtrip Ablauf ↔ geführte Ansicht, nicht darstellbare Abläufe, Checkliste, Vorlagen gegen Katalog und Einstellungen, Zusammenfassung), `server/test/automation-logic.test.ts` (ohne Datenbank: Vorlagen, Bedingungen, Entprellen, Zeitplan, Prüfung,
Prüfsumme, Rechte) und `server/test/automations.test.ts` (gegen PostgreSQL: Rechte, Ein-/Ausgänge, Test und
Aktivierung, FE2/Warnfeed/RSS-Ereignisse, Zeitplan mit Mail und Freigabe, Direktversand, Warten, Entprellen, Grenze,
Notbremse, Löschfrist, Export → Import und abgelehnte Dateien, Katalog für die KI ohne Kennungen und Personendaten) und `server/test/workflow-format.test.ts` (ohne Datenbank: Schema und Hilfe aktuell, Galerie-Vorlagen und KI-Datei gegen Schema und Import, beschädigte Dateien, Fehlermeldungen, Katalog-Positivliste).

---

## Reichweite (#218)

Worker-Aufgabe alle 15 Minuten (`server/src/connections/insights.ts`, läuft nie doppelt): fällig sind veröffentlichte
Beiträge (nicht Storys, nicht von Hand geteilt, nicht entfernt) 1 h, 24 h und 7 Tage nach der Veröffentlichung
(`social_publications.insights_stage` 0–3); höchstens 25 je Kanal und 150 je Lauf. Letzter Stand in
`social_publications.insights`, Verlauf in `social_insights` (Migration 147). Zeitweise Störungen (Netz, 429, 5xx)
werden beim nächsten Lauf wiederholt, Fehler je Beitrag (gelöscht, Recht fehlt) festgehalten. Nur Summen, keine
Personen. Routen `GET /insights`, `GET /posts/:id/insights` (Recht `insights.view`), Dashboard-Kachel `insights`.

## Barrierefreiheit (#217)

- Alternativtext je Bild: `media.alt_text` (Medienverwaltung, wiederverwendbar) und `post_revisions.media_alt`
  (Teil der Fassung, nur nicht leere Einträge zählen zur Prüfsumme – ältere Fassungen behalten ihre Prüfsumme).
  Wirksam ist der Text der Fassung, sonst der aus der Medienverwaltung (`server/src/lib/accessibility.ts`).
  Übergabe: Bridge (`alt`), Facebook (`alt_text_custom`), Instagram-Bildbeiträge und Threads (`alt_text`), X
  (`POST /2/media/metadata`), Mastodon (`description`), Bluesky (`alt`). Einstellung `editorial.alt_text_required`:
  Freigabe blockiert (Fehler `alt_text_required`) oder nur Warnung.
- Lesbarkeit: `web/src/lib/readability.ts` (Flesch-Amstad, erste Wiener Sachtextformel, Silbennäherung für das
  Deutsche, Hinweise), im Browser gerechnet; Tests in `server/test/readability.test.ts`.

---

## Gesichtsvorschläge (#214)

Automatische Gesichtssuche als **Vorschlag** im vorhandenen Werkzeug zum Unkenntlichmachen (#118). Ein Mensch
übernimmt oder verwirft; die Suche ändert nie selbst `media.redactions` oder die öffentliche Fassung.

- **Ablauf:** Nach der Prüfung eines Bildes mit öffentlicher Fassung (nicht HEIC, keine Videos) plant
  `processMedia` den Auftrag `media.faces` ein (ein Versuch, `dedup_key` je Datei; Einstellung `media.face_detect`,
  Standard an). Von Hand: `POST /media/:id/faces` (Recht „Medien unkenntlich machen“), auch bei älteren Bildern und
  ausgeschalteter Automatik. Ergebnis in `media.face_proposals` (Migration 165): `{id, x, y, w, h, score, status}`,
  normiert 0..1 auf das gedrehte Bild, Status `open | accepted | rejected`; dazu `face_status`, `face_checked_at`,
  `face_model`, `face_error`. Entscheidungen kommen mit `PATCH /media/:id/privacy` (`proposals: [{id, status}]`,
  übernommene Bereiche stehen wie alle anderen in `redactions`, jetzt bis 200). Eine neue Suche ersetzt nur offene
  Vorschläge; Treffer, die zu über 50 % in einem entschiedenen Vorschlag oder einem unkenntlichen Bereich liegen,
  entfallen. Kopien übernehmen die Vorschläge, gelöscht werden sie mit der Medienzeile.
- **Freigabe:** `POST /posts/:id/decision` verlangt `privacyChecked`, wenn ein Medium der Fassung markiert ist **oder**
  offene Vorschläge hat (`privacy_check_required`); das Audit vermerkt `bilder_mit_offenen_gesichtsvorschlaegen`.
- **Rechnen:** `server/src/media/face-runner.ts` läuft als **eigener Kindprozess** des Workers (`fork`, IPC, ohne Master-Schlüssel und Datenbankzugang in der Umgebung): onnxruntime
  rechnet synchron, ein Absturz oder eine Zeitüberschreitung (120 s) trifft nur diesen Prozess. Er erbt `nice 10` des
  Workers, rechnet mit **einem** Kern (`intraOpNumThreads` 1, sharp 1 Thread), Aufträge nacheinander, ohne
  Speicher-Arena; nach 60 s ohne Auftrag beendet er sich. Arbeitsspeicher im Betrieb rund 100–200 MB.
- **Vor- und Nachbereitung wie `cv::FaceDetectorYN`:** sharp dreht nach EXIF und verkleinert auf höchstens 1 920 px
  längere Kante; Eingabe BGR, CHW, float32 0..255 ohne Normierung, rechts/unten auf ein Vielfaches von 32 aufgefüllt;
  Ausgaben `cls/obj/bbox_{8,16,32}`, Konfidenz √(cls·obj), Mitte `(Spalte, Zeile) + bbox[0..1]` × Schrittweite,
  Größe `exp(bbox[2..3])` × Schrittweite; NMS mit IoU 0,3, danach entfallen Rechtecke, die zu über 70 % in einem
  größeren liegen. Weil YuNet Gesichter von etwa 10 bis 300 px findet, rechnet es zusätzlich mit 640 und 320 px
  (dort zählen nur Treffer ab 12 % der längeren Kante – Nahaufnahmen). Jeder Vorschlag bekommt 15 % Rand je Seite
  (YuNet rahmt eng von Stirn bis Kinn). Mindestkonfidenz `media.face_threshold` (Standard 60 %, 30–95).
- **Modell:** `server/assets/models/face_detection_yunet_2026may.onnx` (229 738 Byte, SHA-256
  `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`) aus OpenCV Zoo
  (`models/face_detection_yunet`, Commit `26cc381e`, dynamische Eingabegröße), **MIT-Lizenz**; Herkunft und
  Lizenztext in `NOTICE-YuNet.txt` daneben. Es kommt mit dem Build nach `server/dist/assets/models` und damit auch mit
  App-Updates.
- **Laufzeit:** `onnxruntime-node` 1.31.1 (MIT, Microsoft), nur der CPU-Ausführungsanbieter. Das npm-Paket enthält
  Bibliotheken für alle Plattformen (~290 MB); das `Dockerfile` behält nur `bin/napi-v6/linux/<arch>`
  (`libonnxruntime.so.1` x64 47,5 MB bzw. arm64 25,3 MB, bereits ohne Symbole). Sie braucht nur glibc ≥ 2.28,
  `libstdc++.so.6` und `libgcc_s.so.1` – beides bringt das PostgreSQL-Image mit (Node.js braucht sie ebenso).
  `ONNXRUNTIME_NODE_INSTALL=skip` (Dockerfile, CI) verhindert, dass das Installationsskript unter Linux x64
  CUDA-/TensorRT-Bibliotheken von NuGet lädt. Neue native Abhängigkeit ⇒ Release mit neuem Image (`MIN_IMAGE_VERSION`).
  Fehlt die Laufzeit (altes Image), meldet die Suche „nicht verfügbar“, alles andere läuft weiter.
- **Imagegröße** (CI-Docker-Job, linux/amd64, `docker image inspect`): vorher **997 MB**, nachher **1 047 MB** (+50 MB,
  +5 %); Ebene `node_modules` 77,3 → 126 MB (davon `onnxruntime-node` 47 MB), `server/dist` +0,3 MB (Modell). Auf
  arm64 kommen rund 27 MB hinzu. Mehr lässt sich ohne eigenen Build von onnxruntime nicht sparen – die Bibliothek ist
  bereits ohne Symbole, der Großteil sind Rechenkerne für die verschiedenen CPU-Befehlssätze.
- **Warum nicht** `onnxruntime-web` (WASM; im Image rund 15–25 MB statt 48 MB, aber etwa 2–3× langsamer) oder
  OpenCV.js (`FaceDetectorYN`, langsamer, eigene Bildumwandlung): Beide würden ebenfalls synchron rechnen und bräuchten
  denselben Kindprozess. Die native Laufzeit ist die schnellste und am weitesten verbreitete; der Kindprozess fängt
  Abstürze und Zeitüberschreitungen ab.
- **Messung** (Entwicklungsrechner, ein Kern): Foto 1 280 × 1 006 px rund 40–110 ms, 4 000 × 2 144 px (16 Gesichter)
  rund 155 ms je Bild einschließlich Dekodieren und aller Maßstäbe; der erste Auftrag nach Leerlauf braucht zusätzlich
  den Prozessstart (unter 1 s). Auf 2 langsameren Server-Kernen ist mit einigen Zehntelsekunden je Foto zu rechnen.
- **Prüfen im Container:** `docker compose exec -T blaulichtcms node server/dist/cli.js face-check - < foto.jpg`
  (Zahl der Gesichter, Rechenzeit); ohne Datei ein leeres Testbild. Die CI macht das im Docker-Job mit einem
  gemeinfreien Testbild (7 Gesichter).
- **Tests:** `server/test/faces.test.ts` – Tensor, Dekodierung, NMS und Maßstäbe ohne Modell; das echte Modell auf
  gemeinfreien Fotos (`server/test/fixtures/faces`, Quellen in `QUELLEN.txt`: 3, 7 und 16 Gesichter, ein Fahrzeug ohne
  Personen), Nahaufnahme, EXIF-Drehung, kaputte Datei, Bildgrenze, Zeitüberschreitung; Ablauf mit Datenbank (Auftrag,
  Übernehmen/Verwerfen, erneute Suche, Freigabe, Kopie, Rechte).
- **Grenzen:** Erkennungsrate von YuNet auf WIDER FACE (Validierung) laut OpenCV Zoo AP 0,88 / 0,87 / 0,75
  (leicht / mittel / schwer) – es werden also Gesichter übersehen, vor allem **Seitenansichten** und von hinten,
  **verdeckte** (Helm, Atemschutz, Maske, Hand), **unscharfe** und **kleine** Gesichter (unter etwa 10 px im 1 920-px-Bild,
  also unter rund 0,5–1 % der Bildbreite), Spiegelungen. Fehltreffer sind möglich (Muster, Plakate, Figuren). Keine
  Kennzeichen (kein sauber lizenziertes Modell, siehe Folge-Issue), keine Videos, keine HEIC-Dateien. Die menschliche
  Prüfung bleibt Pflicht.

---

## Designvorlagen

Interne Vorlagen-Bibliothek (#208) unter `/designvorlagen`. Server: `server/src/routes/design-templates.ts`,
`server/src/templates/files.ts` (Formate, Inhaltsprüfung, SVG-Bereinigung), Migration `130_design_templates.sql`.

| Teil | Umsetzung |
|---|---|
| Daten | `design_templates` (Titel, Beschreibung, Nutzungshinweis, Kategorie, Schlagworte, Art, Vorschaubild, aktuelle Version, Download-Zähler), `design_template_versions`, `design_template_files`, `template_categories` |
| Ablage | private Medienablage `/data/media/templates/files/<aa>/<id>` und `…/previews/<vorlage>.webp`; ausgeliefert nur über `GET /api/v1/design-templates/files/:id` (attachment, nosniff; SVG zusätzlich mit `Content-Security-Policy: sandbox`) |
| Formate | Endung legt das Format fest, die Signatur am Dateianfang muss passen (PNG, JPEG, WebP, GIF, TIFF, SVG, PDF/AI, EPS, PSD, InDesign, Affinity, GIMP, ZIP-basierte Formate, Schriften, Text); ZIP-Formate werden nie entpackt |
| SVG | Bereinigung mit `fast-xml-parser` (vorhandene Abhängigkeit): DOCTYPE/Entitäten und Verarbeitungsanweisungen → abgelehnt; nur bekannte SVG-Elemente, keine `on*`-Attribute, `href` nur `#…` bzw. eingebettete Rasterbilder, CSS ohne `@import`/externe `url()` |
| Versionen | neue Version = leere Version mit Nummer +1; Dateien nur in der aktuellen Version änderbar, ältere bleiben abrufbar |
| Prüfung | ClamAV (falls `CLAMAV_HOST`) direkt beim Upload; nicht erreichbar → 503, Fund → 400 + Audit `design_template.malware_found` |
| Grenzen | 200 MB je Datei, 10 MB je SVG, 20 Dateien je Version, Vorschaubild höchstens 900 px (WebP) |
| Rechte | `templates.view` (lesen, herunterladen), `templates.use` (Bilder erzeugen, setzt `media.upload` voraus), `templates.manage` (pflegen); Vorgaben für mitgelieferte Rollen über `ROLE_DEFAULT_ADDITIONS` in `auth/permissions.ts` |
| Bildvorlagen (#209) | `templates/layout.ts` (zod-Schema: Format 200–4000 px, höchstens 30 Elemente Text/Bild/Logo/Fläche, alles innerhalb der Fläche), `templates/render.ts`, `templates/images.ts`, API `routes/design-images.ts`, Migration `131_image_templates.sql` (Layout, `design_template_assets`, `design_fonts`, `collections.system_key`) |
| Rendern | nur sharp/libvips (keine neue Abhängigkeit): Grundfläche + Ebenen per `composite`; Flächen als kleines SVG; Bilder mit `resize`/`extract` (Fokus, Zoom) bzw. `contain`, Eckenradius per Maske; Text über sharp `text` (Pango, Markup maskiert, `wrap: word-char`) |
| Textanpassung | binäre Suche über die Schriftgröße (Größe … Mindestgröße), bis Höhe und Zeilenzahl passen; sonst Kürzen nach Wörtern mit „…“. libvips beschneidet Textbilder auf die Tinte – die Zeilenzahl ergibt sich aus dem je Schrift und Größe gemessenen Zeilenabstand (Höhe von zwei Zeilen minus eine Zeile) |
| Schriften | `server/assets/fonts` (Barlow, Barlow Condensed, Atkinson Hyperlegible, je normal/fett, SIL OFL 1.1, Quelle github.com/google/fonts), beim Build nach `server/dist/assets/fonts` kopiert – kommen also mit jedem App-Update, keine Änderung am Image. Jede Schrift wird per `fontfile` angemeldet; zusätzlich setzt `configureFonts()` eine eigene `FONTCONFIG_FILE` (mitgelieferte und hochgeladene Schriften, Cache unter `/data/fonts`, Systemschriften nur falls vorhanden). Eigene TTF/OTF: Name und Stil aus den Tabellen `name`/`OS/2`, Lizenzangabe Pflicht, Ablage `/data/media/templates/fonts` |
| Erzeugen | volle Größe als PNG (JPEG, falls PNG in den Medien nicht erlaubt) → `finalizeUpload` (Kontingente, Audit) → `processMedia` direkt (sonst Worker) → ausgewählt, Alternativtext in `media.alt_text` (#217); Ziel: gewählte Sammlung, sonst erste Sammlung des Beitrags, sonst Systemsammlung „Bilder aus Vorlagen“ (`system_key = 'design-templates'`). Bild-Platzhalter verwenden die öffentliche Fassung (ohne Standort, mit Unkenntlichmachungen) |
| Workflows (#210) | Knotentyp `image` (Verarbeitung, `automations/catalog.ts`, Daten in `graph.ts`: `templateId`, `texts` je Textfeld-Kennung, `images` feste Medien, `altText`, `collectionId`); ohne Bildvorlage offener Platz. Ausführung `templates/workflow.ts` (`runImageStep`): Testlauf rendert nur eine Vorschau nach `/data/media/templates/run-previews` (zwei Tage, `GET /automation-runs/:id/image-preview/:node`), live `generateIntoMedia`. Liefert `bild_id`, `bild_link`, `bilder`; der Beitrags-Ausgang übernimmt `bilder` als Medien, erstes als Titelbild, Alternativtexte in `media_alt`. Export: Bildvorlage nur als `templateName`, Import ordnet nach Name zu (sonst offen). Galerie-Vorlagen `calendar-exercise-story-banner` (Kalender, #203) und `date-story-image` (manueller Start) |
| Vorschau | `POST …/layout-preview` (Editor, ungespeichertes Layout) und `POST …/fill-preview` (Ausfüllen): JPEG höchstens 900 px, Kopfzeile `x-text-truncated` mit gekürzten Feldern |

Tests: `server/test/templates.test.ts` (gegen PostgreSQL: Rechte, Kategorien, Formatprüfung, SVG-Bereinigung,
Download-Zähler, Versionen, Suche/Filter, Löschen samt Dateien, Audit; Bildvorlagen: Schriften mit Lizenz, Startlayout,
Bilder der Vorlage, Layoutprüfung, Vorschau, Erzeugen in die Medien und in die Sammlung eines Beitrags) und
`server/test/template-render.test.ts` (ohne Datenbank: Schriftdateien, Umbruch, Verkleinerung, Kürzen, Platzierung per
Pixelprüfung, Bildausschnitt).

---

## Kalender

Termine liegen in `calendar_events` (Migration 110), Kategorien in `calendar_categories`. Serien speichern eine RRULE
nach RFC 5545 (`server/src/calendar/recurrence.ts`, eigene Umsetzung ohne Fremdbibliothek: FREQ DAILY/WEEKLY/MONTHLY/
YEARLY, INTERVAL, COUNT, UNTIL, BYDAY mit Ordnungszahl, BYMONTHDAY, BYMONTH, BYSETPOS). Wiederholungen werden in
Ortszeit der Zeitzone `tz` gebildet und erst dann in UTC umgerechnet (Intl, IANA-Zeitzonen) – Sommer-/Winterzeit
verschiebt Serien nicht. Ausgelassene Termine stehen in `exdates`, geänderte Einzeltermine als eigene Zeile mit
`series_id` und `recurrence_id`. `until_at` (Ende des letzten Termins, NULL = unbegrenzt) begrenzt die Abfrage nach
Zeitraum; aufgelöst wird beim Lesen (`server/src/calendar/store.ts`, höchstens 400 Tage je Abfrage). Weitere Module
können Einträge über `registerCalendarProvider` beisteuern (geplante Beiträge und Presse-Fristen:
`server/src/calendar/providers.ts`).

iCal-Quellen (#202, Migration 111): `calendar_sources` (Adresse verschlüsselt in `secrets`, Besitzer
`calendar_source`; gespeichert wird nur der Hostname), Abruf über `lib/http.ts` (SSRF-Schutz, 3 MB, 15 s, ETag/
Last-Modified) im Worker, Abgleich je UID und RECURRENCE-ID in `server/src/calendar/sources.ts`, Empfangsprotokoll
`calendar_source_log` (höchstens 200 Einträge je Quelle). Eigener Leser für RFC 5545 (`server/src/calendar/ical.ts`:
Zeilenfaltung, Maskierung, TZID inkl. Windows-Zeitzonen, DATE/UTC/schwebende Zeiten, DURATION, EXDATE, RECURRENCE-ID,
STATUS:CANCELLED). Abo: `calendar_feeds` speichert nur die SHA-256-Prüfsumme des Links; `GET /api/v1/public/calendar/:token`
liefert einzelne Termine (UTC bzw. Datum) für 60 Tage zurück bis 365 Tage voraus.

Workflow-Eingang „Kalendereintrag“ (#203, `server/src/calendar/triggers.ts`): Der Worker (Leader) prüft alle 30 s
je Zeitversatz die Termine, deren Auslösezeitpunkt (Beginn, Ende oder Beginn minus Versatz) im Fenster der letzten
10 Minuten liegt, und startet je passendem Workflow einen Lauf. `event_key` = Termin bzw. Serie (eigene) oder
Quelle + UID (iCal) + ursprünglicher Beginn des Einzeltermins + Art + Auslösezeitpunkt – derselbe Zeitpunkt startet
nie zweimal (eindeutiger Index in `automation_runs`), ein verschobener Termin einmal zum neuen Zeitpunkt.

---

## Sicherheit

| Bereich | Umsetzung |
|---|---|
| Rechte | serverseitig bei jeder API, jeder Datei und jeder Aktion; Standard „verweigert“; Rollen kombinierbar; Vier-Augen-Prinzip für Beiträge, Banner und Warnentwürfe |
| Anmeldung | Argon2id, Zwei-Faktor (TOTP) mit Wiederherstellungscodes, erneute Bestätigung für kritische Aktionen, Sperre nach Fehlversuchen ohne Aussperren bekannter Geräte, CSRF-Schutz |
| Uploads | nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen je Link und Sammlung; erlaubte Typen je Link; optional Passwort (Argon2id, Freigabe als signiertes, pfadgebundenes Cookie, Fehlversuche gedrosselt und protokolliert); Quarantäne; Inhaltsprüfung; optional Virenscan (ClamAV); Drosselung je IP |
| Medien | privat außerhalb des Webservers; Standort- und Kameradaten werden entfernt; Unkenntlichmachen für die öffentliche Fassung; Verschieben behält die Medien-ID (Freigaben bleiben an genau diese Datei gebunden), Kopien übernehmen die Datenschutz-Entscheidungen; `metadaten.csv` im ZIP gegen Formel-Injektion abgesichert |
| Websites | Schlüssel je Website (nur Prüfsumme gespeichert), sofort widerrufbar; die Bridge ruft nur aus, nur per HTTPS |
| Datenbank | nur über Unix-Socket im Container; die Anwendung arbeitet mit einer Rolle ohne Superuser- und DDL-Rechte |
| Zugangsdaten der Schnittstellen | ausschließlich in `secrets` (AES-256-GCM, Schlüssel aus `BLAULICHTCMS_MASTER_KEY` per HKDF, Zweckbindung je Besitzer und Version, versioniert und widerrufbar); Einstellungen und Verbindungen speichern nur Verweise (`…_secret_id`, `connections.secret_id`). Abgedeckt: Verbindungen (FE2-Zugangsschlüssel nur als Prüfsumme, Feuersoftware-API-Key, Meta-Geheimnisse und -Tokens), SMTP-Passwort, Microsoft-365-Client-Geheimnis, Update-Token, privater VAPID-Schlüssel, Schlüssel der Audit-Kette, Passwort des Sicherungsziels außer Haus; Upload-Link-Tokens und TOTP-Geheimnisse ebenfalls verschlüsselt, Website- und API-Schlüssel nur als Prüfsumme. API-Antworten nennen nur, ob ein Wert gesetzt ist; Systemprotokoll maskiert Geheimnis-Felder und Bearer-Werte (`lib/mask.ts`); Adressen mit Benutzer/Passwort werden abgewiesen. Der Worker prüft beim Start Einstellungen, Verbindungskonfigurationen und Quellen auf Klartext (`lib/secret-audit.ts`) und verschiebt Funde aus Verbindungskonfigurationen in `secrets`; ein Integrationstest prüft das nach der ganzen Suite. Sicherungen enthalten die Geheimnisse nur verschlüsselt, der Master-Schlüssel gehört nicht in die Sicherung |
| Benachrichtigungen | Push nach RFC 8030/8291/8292 mit `node:crypto` (aes128gcm, VAPID ES256, geprüft gegen die Testwerte aus RFC 8291), nur an bekannte Push-Dienste; Inhalte ohne Einsatzdetails; E-Mail über SMTP oder Microsoft Graph (Client-Credentials, nur `login.microsoftonline.com`/`graph.microsoft.com`), Microsoft 365 erst nach bestandener Testmail mit genau diesen Angaben |
| Audit | Hash-Kette gegen nachträgliche Änderungen, optional an Syslog weitergeleitet; Alarmierung bei Sicherheitsereignissen; eigenes Protokoll der Sicherheitsereignisse der Upload-Seiten (gekürzter IP-Hash, gedrosselt) |
| Gestaltung der Upload-Seite | festes Bausteinschema (Server prüft Typen, Längen, genau einen Upload-Bereich), Texte nur als Text dargestellt (kein HTML), Akzentfarben nur aus einer festen Palette (Tokens, per style-Attribut im Rahmen der CSP), Bilder neu kodiert ohne Metadaten und nur über zufällige ID abrufbar; Datenschutzabschnitt nicht abschaltbar |
| Inhaltsprüfung | Typ am Dateiinhalt, Bilder vollständig dekodiert mit Pixelgrenze, Videos: Codec-Liste, Länge, Auflösung und Dekodierprüfung (Anfang Bild für Bild, danach Schlüsselbilder) – alle Grenzen einstellbar |
| Prüfbefunde | Dateien mit Befund werden gesperrt (Quarantäne, nie ausgeliefert, erneut prüfbar); „Trotzdem freigeben“ nur für Videos mit reinem Dekodierbefund und nur mit „Medien administrieren“, Begründung, Audit und Sicherheitsmeldung; Schadsoftware wird sofort gelöscht |
| Sicherungen | verschlüsselt (AES-256-GCM) mit eigenem Schlüssel, regelmäßige Probe-Wiederherstellung (Volume am Host; Datenbank in eine Wegwerf-Datenbank, `ops/drill.ts`); Kopie außer Haus per WebDAV über HTTPS (`ops/offsite.ts`, Prüfsumme nach dem Hochladen, Zertifikat optional per Fingerabdruck, SSRF-Schutz nur für den eingetragenen Host gelockert) |
| Updates | Releases mit Ed25519 signiert (privater Schlüssel nie auf dem Server), geprüft gegen den Schlüssel der laufenden Version; Sicherung vorab und automatischer Rückweg; Bridge-Updates ebenso signiert |
| Container | unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities, Grenzen für Speicher, CPU und Prozesse, Port standardmäßig nur lokal |

Ergebnis der Sicherheitsprüfung (BSI IT-Grundschutz): [docs/sicherheitspruefung.md](sicherheitspruefung.md),
Datenschutz: [docs/datenschutz.md](datenschutz.md). **Sicherheitslücken bitte nicht als öffentliches Issue
melden** – Vorgehen in [SECURITY.md](../SECURITY.md).

---

## Leistung

- Seiten werden einzeln nachgeladen, der Build ist mit Brotli vorkomprimiert. Der erste Aufruf am Handy lädt rund 180 KB, danach kommt fast alles aus dem Browser-Cache.
- Die Sichtung reagiert sofort und lädt das nächste Bild vor. Uploads laufen in Teilen, zwei parallel, und lassen sich ohne Doppelanlage wiederholen.
- Beitragsliste und Dashboard brauchen je eine Datenbankabfrage. PostgreSQL ist für SSD eingestellt.
- Lasttest (Produktions-Build, 50 gleichzeitige Verbindungen): Dashboard rund 1 000 Anfragen/s bei p99 52 ms, Startseite rund 3 750 Anfragen/s, ohne Fehler ([docs/betrieb.md](betrieb.md)).

### Leistungsprüfung (#192, 16.11.2026)

Messung mit realistischem Datenbestand (6 000 Beiträge mit 18 000 Fassungen, 300 Sammlungen mit 36 000 Medien,
150 000 Audit-Einträge, 80 000 Protokollzeilen, 60 000 Aufträge, 6 000 Empfangsprotokolle mit 30 000 Einträgen,
3 000 alte Sitzungen), Produktions-Build, API und Worker auf **2 CPU-Kerne** begrenzt (wie `cpus: 2` im Compose),
PostgreSQL 18, Windows-Entwicklungsrechner. Antwortzeiten um 16 ms sind dort die Timer-Auflösung, nicht Server-Zeit.

**Hauptbefund – „hängt“ bei vielen Anmeldungen:** Argon2id (m = 64 MiB, t = 3, p = 4) läuft asynchron, blockiert also
nicht die Ereignisschleife (Verzögerung auch bei 120 gleichzeitigen Anmeldungen ≤ 20 ms). Es belegt aber den
libuv-Threadpool (4 Threads), über den auch Dateien (Oberfläche, Vorschaubilder, Uploads) und die Brotli-Komprimierung
der API-Antworten laufen. Ergebnis: Während einer Anmeldewelle warteten Seiten und Bilder sekundenlang.

| während gleichzeitiger Anmeldungen | vorher (p95) | nachher (p95) |
|---|---|---|
| 40 Anmeldungen – Skriptdatei der Oberfläche | 1 520 ms (max. 1 964) | 33 ms (max. 50) |
| 40 Anmeldungen – Beitragsliste (JSON, komprimiert) | 1 929 ms | 34 ms |
| 120 Anmeldungen – Skriptdatei / Beitragsliste | 5 731 ms / 5 699 ms | 25 ms / 26 ms |
| Arbeitsspeicher der API (Spitze) | 447 MB | 409 MB |

Seither rechnen höchstens **2** Argon2-Prüfungen gleichzeitig (`ARGON2_SLOTS` in `server/src/auth/passwords.ts`), weitere
warten in einer Schlange (höchstens 100; darüber sofort „Anmeldung ausgelastet“, 503). Eine einzelne Anmeldung dauert
unverändert rund 90 ms. Unit-Test: Prüfungen laufen asynchron, nie mehr als `ARGON2_SLOTS` gleichzeitig, volle Schlange → 503.

**Weitere Änderungen**

| Bereich | Befund | Änderung |
|---|---|---|
| Sammlungsübersicht | vier Zähl-Unterabfragen und ein sortiertes Titelbild je Sammlung: 57 ms Datenbankzeit für 200 Sammlungen | ein Zähldurchlauf je Sammlung über `media_collection_state_idx` (Index-Only-Scan), Titelbild über `media_cover_pick_idx`, erst die Seite wählen, dann zählen (Migration 105): **5 ms**; Antwortzeit p50 45 → 17 ms |
| Reihenfolge in Sammlungen | bis zu 2 000 einzelne `UPDATE` in einer Transaktion | eine Anweisung (`unnest … WITH ORDINALITY`) |
| Worker | nach einem Auftrag bis zum nächsten 2-s-Takt gewartet: kurze Aufträge nur rund 2 je Sekunde | freie Plätze sofort neu füllen: über 130 je Sekunde (1 000 Aufträge in Sekunden statt über 8 Minuten) |
| Worker-Priorität | Medienprüfung (sharp, ffmpeg), ZIP und Sicherung konkurrieren mit der API um 2 Kerne | Worker mit `nice 10`; Kindprozesse erben das, die API bekommt bei Volllast zuerst Rechenzeit |
| Datenbankverbindungen | eine hängende Abfrage oder offene Transaktion hält eine der 10 API-Verbindungen dauerhaft | API: `statement_timeout` und `idle_in_transaction_session_timeout` je 60 s (Worker und Kommandozeile ohne Grenze); Pool API 10 + Worker 10 + 1 Ereignisverbindung bei `max_connections` 100 |
| Ereignisschleife | `statSync`/`statfsSync` bei Dateiauslieferung und Systemstatus | asynchron (`fs.promises`) |
| Live-Aktualisierung | jede Änderungsmeldung (bei Uploads mehrere je Sekunde) lud Dashboard und Sammlungen sofort in jedem Tab neu; Kopfzeile fragte das Dashboard alle 30 s ab | Neuladen höchstens einmal je Sekunde gebündelt; mit Live-Verbindung Kopfzeile nur alle 2 Minuten; verborgene Tabs schließen die Live-Verbindung nach 1 Minute (ohne HTTP/2 sonst ab 6 Tabs Stillstand) |
| Oberfläche (Bundle) | React Flow samt CSS steckte im React-Chunk, die JSX-Laufzeit im Markdown-Chunk – beides lud auf jeder Seite | Chunk-Gruppen mit Vorrang (`web/vite.config.ts`): erster Aufruf **976 → 622 KB** (Brotli **256 → 163 KB**); React Flow/dagre nur im Workflow-Editor, Markdown nur in Hilfe und Hilfetexten |
| Proxy | falsches `TRUSTED_PROXIES` ließ alle Personen eine IP teilen (Rate-Limit 10 Anmeldungen/min für alle) | Systemstatus zeigt „Reverse Proxy“ mit Adresse und Abhilfe, Warnung im Systemprotokoll |

**Geprüft, in Ordnung:** Sitzungsprüfung je Anfrage (eine Abfrage über den eindeutigen Token-Index, 0,04 ms; Rollen und
Einstellungen im Speicher zwischengespeichert), Beitragsliste (2,6 ms, auf 300 begrenzt), Audit und Systemprotokoll
(Blättern über `id`, höchstens 500), Empfangsprotokolle, Medienauslieferung (Stream, Vorschauen ein Jahr privat
cachebar), statische Dateien (Hash-Dateien `immutable`, `index.html`/`sw.js` `no-cache`, Brotli vorkomprimiert),
Komprimierung der API ab 1 KB, sharp mit begrenzten Threads und ohne Cache. Gemischte Last (20 Clients): p95 128 → 96 ms,
364 → 476 Anfragen/s.

**Grenzen:** Gemessen auf einem Entwicklungsrechner, nicht auf der Zielhardware; die Wirkung von `nice` auf die API
unter Video-Last ist nicht gemessen (Windows). Das Dashboard berechnet „bereit zur Veröffentlichung“ weiterhin über alle
nicht archivierten Beiträge (bei 4 800 Beiträgen ohne Freigaben 46 ms) – Beiträge archivieren hält es schnell.

---

## Teststand und Grenzen

**Automatisiert (bei jedem Push in der CI):** Typprüfung, rund 600 Server-Tests gegen echtes PostgreSQL (inklusive
Video-Verarbeitung mit ffmpeg), Build, PHP-Lint des Plugins, Probelauf mit Docker Compose (Rollen, Schlüsselwechsel,
Audit-Kette), Abhängigkeits-, Image- und Secret-Scan sowie Browsertests der Kernabläufe mit Playwright/Chromium
(Einrichtung mit Zwei-Faktor, Beitrag bis zur Freigabe, Workflow aus Vorlage, Rollen, Dashboard, Fokus-Check).
Wöchentlich prüft ein Workflow alle festgelegten Versionen und meldet Neuerungen in einem Issue. Dazu kommen Abnahmetests über Browser, Container und ein
Test-WordPress (`test/e2e/`, Foto-Link bis Website, fortsetzbarer Upload, Warnentwurf, fehlgeschlagenes Update mit
Rückweg, Wiederherstellung, PostgreSQL-Upgrade). Das Update aus der App ist mit dem echten Supervisor durchgespielt
(Aktivierung, Rückweg bei fehlerhafter Migration und bei Absturz der neuen Version).

**Mit echten Systemen geprüft:** WordPress 7.1 / PHP 8.5 mit HTTPS, WP-Cron, Host-Cron und Seitencache; die
Warn-App-Schnittstelle des Bundes; Mailversand mit STARTTLS/TLS; QR-Aushänge unter erschwerten Bedingungen.
Ergebnisse je Verbindung: [docs/integrationen.md](integrationen.md).

**Noch nicht geprüft bzw. vor dem Echtbetrieb zu klären:**

- Betrieb auf einem Zielhost mit echten Datenmengen (Wiederherstellung, PostgreSQL-Upgrade, Last), externer Penetrationstest
- Meta-App mit App-Prüfung (Facebook/Instagram/Threads, auch Storys), X-App mit Guthaben, Mastodon-Konto auf einer echten Instanz, Bluesky-Testkonto, FE2-Meldungen einer echten Instanz
- Push an echte Push-Dienste (FCM, Mozilla, Apple, WNS) und Versand über einen echten Microsoft-365-Mandanten: in den
  Tests gegen Stellvertreter geprüft (Verschlüsselung gegen RFC 8291, Anmeldung und `sendMail` wie dokumentiert)
- Warnentwurf: Die mitgelieferte Vorlage ist ein **nicht abgestimmtes Beispiel**, Warnstufen-Regeln gibt es ab Werk
  keine. Vorlage, Empfänger und Rückmeldeweg mit der zuständigen Stelle abstimmen, Regeln fachlich freigeben. Die
  Weiterverwendung amtlicher Warninhalte (MoWaS) vor dem Einschalten automatischer Banner mit dem BBK klären.
- Stichwortverzeichnisse (`server/src/keywords/catalogs/*.json`, #195): nur Länder mit öffentlicher amtlicher Quelle
  (Hessen: Runderlass vom 30.08.2024, Scan – abgeglichen mit der digitalen Fassung vom 01.11.2022; Bayern: ABek-Anlage
  Stand 15.03.2017, nur Kürzel der Übersicht, ABek laut gesetze-bayern.de befristet bis 16.07.2027). Neue Fassungen
  müssen von Hand nachgetragen werden; `test/keywords.test.ts` prüft Wortlaut-Stichproben und Dubletten.
- Einsatzliste in WordPress (Bridge 0.9.0, #213): Server, Aufträge und Rückmeldungen sind automatisiert getestet. Liste,
  Statistik und Detailseite liefen beim Erstellen der README-Bilder (#221) in WordPress 7.1.4 / PHP 8.5 mit Twenty
  Twenty-Five (SQLite, Abholung per `wp blaulichtcms-bridge poll`); Einstellungsseite und das eigene Theme der Website
  noch prüfen. Der CSV-Import folgt dem Exportformat der Erweiterung „Einsatzverwaltung“ (Spaltennamen aus deren
  Quelltext), nicht einer echten Exportdatei.
- Presse-Postfach, Antworten und Pressemitteilungen (#205–#207): gegen IMAP-, SMTP- und Graph-Stellvertreter getestet;
  mit dem echten Postfach (IMAP-Server bzw. Microsoft 365 mit `Mail.Read`) und echter Zustellung samt Abmeldelink in
  gängigen Mailprogrammen noch prüfen.
- Kalender (#202): iCal-Abruf mit Beispiel-ICS über einen lokalen Server getestet; echte Kalender (Outlook, Google,
  Wehr-Kalender) einlesen und das Abo in Outlook, Google und am iPhone noch prüfen.
- Reichweite (#218): gegen Mastodon- und Bluesky-Stellvertreter getestet; Statistik-Rechte und Zahlen mit echten
  Konten (Meta ggf. erst nach App-Prüfung, X nur mit eigener API) noch prüfen.
- Update-Helfer für Image-Updates aus der App (#226): Anfrage, Statusauswertung, Rate-Limit und Protokoll mit Tests
  (`server/test/host-update.test.ts`); Helfer und `install.sh --unattended` mit Docker-Stellvertreter trocken getestet
  (Erfolg, Rückweg, Abbruch vor dem Wechsel, abgelehnte Anfragen, falsche Signatur, Neustart mit neuer `install.sh`).
  Der Helfer ist noch nicht auf einem echten Host mit systemd gelaufen: systemd-Units, Path-Unit, `setpriv`, die Härtung
  und ein Image-Update aus der App mit echtem Docker-Build auf dem Zielhost noch prüfen.
- Sicherung außer Haus und Probe-Wiederherstellung (#212): gegen einen WebDAV-Stellvertreter mit echtem TLS getestet;
  mit dem echten NAS (z. B. Synology „WebDAV Server“) und die zeitgesteuerte Probe auf dem Zielhost noch prüfen.
- Freigabe aus der Push-Mitteilung (#216): Ob ein Gerät Aktionsknöpfe zeigt, entscheidet der Browser; auf echten
  Geräten (Android, iPhone, Windows, macOS) noch ansehen.
- Gesichtsvorschläge (#214): Erkennungsrate und Rechenzeit auf echten Einsatzfotos und auf der Zielhardware (2 Kerne)
  messen; geprüft ist das Modell bisher auf gemeinfreien Testfotos und einem Entwicklungsrechner.
- Datenschutz: Angaben unter *Einstellungen → Datenschutz* ausfüllen, Verarbeitungsverzeichnis und DSFA mit den
  Vorlagen in [docs/datenschutz.md](datenschutz.md) erstellen.

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
unter Windows: [docs/entwicklung.md](entwicklung.md). Beiträge sind willkommen: [CONTRIBUTING.md](../CONTRIBUTING.md).

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
