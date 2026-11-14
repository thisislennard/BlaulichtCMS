# Einmaliger Medienimport

LifeLink übernimmt Sammlungen, Originale, Auswahlstatus, Fristen und noch gültige Upload-Links aus einem
bestehenden System (z. B. LiFeOS) **einmalig** über ein dokumentiertes Austauschformat. Danach verwaltet LifeLink
Medien und Links selbst; das alte Modul kann abgeschaltet werden.

> **Stand:** Das tatsächliche LiFeOS-Exportformat liegt noch nicht vor. Sobald es vorliegt, erzeugt ein kleiner
> Umsetzer daraus das unten beschriebene Format. Prüfung und Übernahme sind davon unabhängig fertig und getestet.
> Der Import produktiver Daten ist ein **eigener Auftrag** und läuft immer zuerst gegen eine Kopie oder Testdaten.

## Ablauf

1. **Export** aus dem Altsystem in einen Ordner: `manifest.json` + Dateien.
2. Ordner in den Container bringen (z. B. als zusätzliches, schreibgeschütztes Volume unter `/import`).
3. **Probelauf** – prüft alles und schreibt nichts außer einem Protokolleintrag:

   ```bash
   docker compose exec lifelink node server/dist/cli.js import-inventory /import
   ```

   Geprüft werden: Manifest-Schema, Dateien vorhanden und innerhalb des Ordners, Größe und **SHA-256** je Datei,
   doppelte Referenzen, Anzahl Sammlungen/Dateien/Bytes, gültige und abgelaufene Links. Exit-Code 2 bei Problemen.

4. **Übernahme** – nur nach fehlerfreiem Probelauf (wird automatisch erneut ausgeführt):

   ```bash
   docker compose exec lifelink node server/dist/cli.js import-commit /import
   ```

   Originale laufen durch die **normale Quarantäne-Prüfung** (Dateityp nach Inhalt, Dekodierung, öffentliche Fassung
   ohne Standortdaten). Wiederholte Läufe legen nichts doppelt an.

5. **Mengenabgleich** nach der Prüfung:

   ```bash
   docker compose exec lifelink node server/dist/cli.js import-verify /import
   ```

   Je Sammlung: erwartet, geprüft, abgewiesen, Prüfsummen-Abweichungen.

## Alte Upload-Links

Für jeden noch gültigen, nicht widerrufenen Altlink legt LifeLink einen neuen Upload-Link mit **derselben Frist** an.
Der alte Token wird nur als Prüfsumme gespeichert. Unter

```
https://<lifelink-adresse>/l/<alter-token>
```

leitet LifeLink befristet (höchstens 90 Tage, nie über die Frist des Links hinaus) auf den neuen Link weiter. Die
Weiterleitung vom alten System auf diese Adresse richtet der Betrieb am alten Webserver oder Reverse Proxy ein, z. B.:

```nginx
location ~ ^/upload/(?<tok>[A-Za-z0-9_-]+)$ { return 302 https://lifelink.example.org/l/$tok; }
```

Alternativ gibt die Redaktion gezielt die neuen Links aus (Sammlung → Upload-Links).

## Austauschformat `lifelink-import/1`

```json
{
  "format": "lifelink-import/1",
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
| `links[].token` | nur nötig für die Weiterleitung; ohne Token wird kein neuer Link angelegt |

## Was der LiFeOS-Umsetzer leisten muss (offen, #35)

- Sammlungen, Dateien und Links aus dem echten LiFeOS-Export lesen
- Prüfsummen berechnen (oder aus LiFeOS übernehmen, falls vorhanden)
- Auswahlstatus und Fristen auf die Felder oben abbilden
- Lizenz des LiFeOS-Codes klären, falls Code übernommen wird
