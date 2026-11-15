# Einmaliger Medienimport

BlaulichtCMS übernimmt Sammlungen, Originale, Auswahlstatus, Fristen und noch gültige Upload-Links aus einem
bestehenden System (z. B. LiFeOS) **einmalig** über ein dokumentiertes Austauschformat. Danach verwaltet BlaulichtCMS
Medien und Links selbst; das alte Modul kann abgeschaltet werden.

> Für LiFeOS erzeugt `scripts/lifeos-export.py` das Austauschformat direkt aus dem Presse-Modul (siehe unten).
> Der Import produktiver Daten ist ein **eigener Auftrag** und läuft immer zuerst gegen eine Kopie oder Testdaten.

## Ablauf

1. **Export** aus dem Altsystem in einen Ordner: `manifest.json` + Dateien (LiFeOS: [Export aus LiFeOS](#export-aus-lifeos)).
2. Ordner in den Container bringen (z. B. als zusätzliches, schreibgeschütztes Volume unter `/import`).
3. **Probelauf** – prüft alles und schreibt nichts außer einem Protokolleintrag:

   ```bash
   docker compose exec blaulichtcms node server/dist/cli.js import-inventory /import
   ```

   Geprüft werden: Manifest-Schema, Dateien vorhanden und innerhalb des Ordners, Größe und **SHA-256** je Datei,
   doppelte Referenzen, Anzahl Sammlungen/Dateien/Bytes, gültige und abgelaufene Links. Exit-Code 2 bei Problemen.

4. **Übernahme** – nur nach fehlerfreiem Probelauf (wird automatisch erneut ausgeführt):

   ```bash
   docker compose exec blaulichtcms node server/dist/cli.js import-commit /import
   ```

   Originale laufen durch die **normale Quarantäne-Prüfung** (Dateityp nach Inhalt, Dekodierung, öffentliche Fassung
   ohne Standortdaten). Wiederholte Läufe legen nichts doppelt an.

5. **Mengenabgleich** nach der Prüfung:

   ```bash
   docker compose exec blaulichtcms node server/dist/cli.js import-verify /import
   ```

   Je Sammlung: erwartet, geprüft, abgewiesen, Prüfsummen-Abweichungen.

6. **Importdaten löschen** – sobald `import-verify` ohne Abweichungen durchgelaufen ist. Der Importordner enthält
   Kopien der Originale (mit möglichen Standortdaten) und `manifest.json` mit Uploader-Hinweisen und
   Token-Prüfsummen; nach der Übernahme liegen diese Daten in BlaulichtCMS und werden dort nach den Löschfristen
   behandelt. Die Kopien außerhalb von BlaulichtCMS haben keinen Zweck mehr (Art. 5 Abs. 1 lit. e DSGVO):

   ```bash
   # zusätzliches Volume/Bind-Mount für /import wieder aus der Compose-Override-Datei entfernen, dann
   docker compose up -d
   # Host-Kopie löschen (beim LiFeOS-Export auch auf dem LiFeOS-Host)
   sudo rm -rf ./blaulichtcms-import
   # falls ein benanntes Volume verwendet wurde
   docker volume rm <name-des-import-volumes>
   ```

   Der Importbericht (`import_runs`) bleibt in BlaulichtCMS als Nachweis, enthält aber keine Dateien.

### Importordner bereitstellen

Der Ordner wird nur lesend gebraucht. Die Dateien schreibt das Exportskript nur für den Eigentümer lesbar
(`umask 077`); BlaulichtCMS läuft im Container als Benutzer `1000`. Beispiel für einen Bind-Mount über eine
Override-Datei neben `compose.yaml`, die nach dem Import wieder gelöscht wird (gibt es schon eine
`compose.override.yaml`, nur den Volume-Eintrag ergänzen und danach wieder entfernen):

```bash
sudo chown -R 1000:1000 ./blaulichtcms-import
cat > compose.override.yaml <<'YAML'
services:
  blaulichtcms:
    volumes:
      - ./blaulichtcms-import:/import:ro
YAML
docker compose up -d
# … Schritte 3 bis 5 …
rm compose.override.yaml && docker compose up -d   # Schritt 6
```

## Alte Upload-Links

Für jeden noch gültigen, nicht widerrufenen Altlink legt BlaulichtCMS einen neuen Upload-Link mit **derselben Frist** an.
Der alte Token wird nur als Prüfsumme gespeichert. Unter

```
https://<blaulichtcms-adresse>/l/<alter-token>
```

leitet BlaulichtCMS befristet (höchstens 90 Tage, nie über die Frist des Links hinaus) auf den neuen Link weiter. Die
Weiterleitung vom alten System auf diese Adresse richtet der Betrieb am alten Webserver oder Reverse Proxy ein, z. B.:

```nginx
location ~ ^/upload/(?<tok>[A-Za-z0-9_-]+)$ { return 302 https://blaulichtcms.example.org/l/$tok; }
```

Alternativ gibt die Redaktion gezielt die neuen Links aus (Sammlung → Upload-Links).

## Austauschformat `blaulichtcms-import/1`

```json
{
  "format": "blaulichtcms-import/1",
  "source": "lifeos",
  "exported_at": "2026-11-14T10:00:00+01:00",
  "collections": [
    {
      "ref": "alt-sammlung-17",
      "title": "Großübung (Beispiel)",
      "purpose": "",
      "note": "",
      "created_at": "2026-10-01T12:00:00+02:00",
      "media": [
        {
          "ref": "alt-datei-981",
          "file": "files/alt-datei-981.jpg",
          "original_name": "IMG_0001.jpg",
          "size": 2345678,
          "sha256": "<64 Hex-Zeichen>",
          "selection": "selected",
          "uploaded_at": "2026-10-01T12:05:00+02:00",
          "note": ""
        }
      ],
      "links": [
        { "ref": "alt-link-3", "token": "<alter token>", "expires_at": "2026-11-30T23:59:00+01:00", "revoked": false, "label": "Helfende vor Ort" }
      ]
    }
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `ref` | stabile Kennung im Altsystem (für Wiederholbarkeit und Abgleich) |
| `file` | Pfad relativ zum Importordner (Pfade nach außen werden abgewiesen) |
| `selection` | `pending`, `selected` oder `skipped` |
| `links[].token` | Klartext-Token, nur für die Weiterleitung; wird nur als Prüfsumme gespeichert |
| `links[].token_sha256` | alternativ die SHA-256-Prüfsumme des Tokens (64 Hex-Zeichen), wenn das Altsystem den Klartext nicht kennt (LiFeOS) |

Ohne `token` und ohne `token_sha256` wird für einen Altlink kein neuer Link angelegt.

## Export aus LiFeOS

`scripts/lifeos-export.py` liest das Presse-Modul von LiFeOS und schreibt einen Importordner im Format oben. Das
Skript läuft **im LiFeOS-Container** (dort sind Datenbank und das Volume `press_media` erreichbar) und braucht nur
Python und psycopg2, das im LiFeOS-Image vorhanden ist. LiFeOS wird **nur gelesen**: lesende Transaktion mit festem
Schnappschuss, Originale werden kopiert, nicht verschoben.

```bash
# auf dem LiFeOS-Host, im Ordner der LiFeOS-Installation (Dienstname ggf. anpassen)
docker compose exec -T web python - --out /tmp/blaulichtcms-import < /pfad/zu/BlaulichtCMS/scripts/lifeos-export.py
docker compose cp web:/tmp/blaulichtcms-import ./blaulichtcms-import
docker compose exec web rm -rf /tmp/blaulichtcms-import
chmod -R go-rwx ./blaulichtcms-import
```

Die Kopie `./blaulichtcms-import` auf dem LiFeOS-Host nach der Übertragung zum BlaulichtCMS-Host bzw. spätestens nach
`import-verify` löschen (Schritt 6 im [Ablauf](#ablauf)).

Ausgabe: Kennzahlen als JSON; `export-report.json` im Ordner enthält Kennzahlen und Probleme. Exit-Code 2 heißt:
mindestens ein Problem (z. B. fehlende Originaldatei). Das betroffene Medium fehlt dann im Manifest, der Rest ist
gültig. Optionen: `--database-url` (Standard `$DATABASE_URL`), `--media-root` (Standard `$PRESS_MEDIA_ROOT` bzw.
`/app/press_media`), `--include-archived`.

| LiFeOS | BlaulichtCMS |
|---|---|
| Thema (Wurzel) und jeder Ordner mit Inhalt | je eine Sammlung „Thema / Ordner / Unterordner“; Beschreibung, Datum und „archiviert“ in der Notiz |
| Medium mit Prüfstatus „Geprüft“ (`released`), nicht im Papierkorb | Original aus `press_media/blobs`; nicht geprüfte, gesperrte, gelöschte und Medien in gelöschten Ordnern werden nicht übernommen |
| Swipe-Auswahl des Ordners: ausgewählt / abgelehnt / offen | `selected` / `skipped` / `pending`; ohne Entscheidung wird ein redaktionell abgelehntes Medium zu `skipped` |
| Hinweis der hochladenden Person | Notiz am Medium (Name und E-Mail werden **nicht** übernommen) |
| Upload-Link | Frist und Bezeichnung; `token_sha256` aus `token_hash` (LiFeOS speichert nur die Prüfsumme). Pausierte und deaktivierte Links gelten als widerrufen |
| Archivierte Themen | nur mit `--include-archived` |

Die alte Upload-Adresse in LiFeOS lautet `/medien-upload/<token>`. Weiterleitung am alten Reverse Proxy:

```nginx
location ~ ^/medien-upload/(?<tok>[A-Za-z0-9_-]+)$ { return 302 https://blaulichtcms.example.org/l/$tok; }
```

Geprüft am 14.11.2026 gegen das Schema von LiFeOS 3.56.2 (Tabellen aus den LiFeOS-Modellen erzeugt, fiktive Daten):
Export → `import-inventory` → `import-commit` (Wiederholung ohne Duplikate) → Quarantäne-Prüfung → `import-verify`
ohne Abweichungen. Die Prüfsumme des alten Tokens stimmt mit LiFeOS überein.
