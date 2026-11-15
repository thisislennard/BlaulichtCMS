Die **BlaulichtCMS Bridge** ist ein WordPress-Plugin. Sie holt freigegebene Beiträge per HTTPS bei BlaulichtCMS ab, veröffentlicht sie und meldet WordPress-ID und Adresse zurück. WordPress braucht dafür **keinen offenen Eingang** – die Bridge ruft nur aus.

## Koppeln in vier Schritten

1. In BlaulichtCMS unter [Websites](/kanaele) **Bridge herunterladen** (ZIP).
2. In WordPress **Plugins → Installieren → Plugin hochladen**, ZIP wählen, installieren und aktivieren.
3. In BlaulichtCMS **Website koppeln**, einen Namen vergeben und den **Kopplungscode** notieren (einmalig, 30 Minuten gültig).
4. In WordPress **Einstellungen → BlaulichtCMS Bridge** die BlaulichtCMS-Adresse und den Code eintragen und **Koppeln** klicken.

Der entstehende Schlüssel gilt nur für diese eine Website. „Widerrufen“ in BlaulichtCMS sperrt ihn sofort.

## Abruf

Die Bridge holt jede Minute neue Aufträge ab (WP-Cron). Bei wenig Besucherverkehr oder aktivem Seitencache besser einen Host-Cron einrichten:

```
* * * * * wp --path=/var/www/html blaulichtcms-bridge poll
```

In WordPress zeigt **Einstellungen → BlaulichtCMS Bridge** den letzten Abruf und den letzten Fehler. „Jetzt abrufen“ startet sofort. In BlaulichtCMS warnt die Website-Karte, wenn sich die Bridge länger als 15 Minuten nicht gemeldet hat.

## Was in WordPress entsteht

- Ein Beitrag (Status „Veröffentlicht“) mit Titel, Text und Kurzfassung
- Titelbild als Beitragsbild, weitere Bilder und Videos unter dem Text
- Autor und Kategorie lassen sich in den Bridge-Einstellungen festlegen

Eine neue, freigegebene Fassung desselben BlaulichtCMS-Beitrags **aktualisiert** den bestehenden WordPress-Beitrag. Bilder und Videos, die in der neuen Fassung fehlen, löscht die Bridge aus der Mediathek, sofern kein anderer Beitrag und keine andere Seite sie verwendet.

## Zurückziehen

**Zurückziehen** im Beitrag wirkt auf **jede** Website, auf der der Beitrag noch steht – auch wenn eine frühere Fassung auf eine andere Website ging. Die Bridge setzt den WordPress-Beitrag auf „Entwurf“ und löscht die übernommenen Bilder und Videos endgültig aus der Mediathek (samt aller Bildgrößen unter `/wp-content/uploads`), sofern kein anderer Beitrag und keine andere Seite sie verwendet. So ist ein Bild nach einem Widerspruch einer abgebildeten Person auch über die Mediathek nicht mehr abrufbar. Kopien in Caches, Suchmaschinen oder bei Dritten erreicht die Bridge nicht. Facebook und Instagram sind davon getrennt – siehe [Verbindungen](/hilfe/verbindungen) („Von sozialen Kanälen entfernen“).

Wurde die Kopplung einer Website widerrufen und **dieselbe Website (gleiche Adresse) neu gekoppelt**, wirkt „Zurückziehen“ auch auf Beiträge, die noch über die alte Kopplung veröffentlicht wurden: Der Auftrag geht an die neue Kopplung, die Bridge findet den Beitrag in WordPress wieder.

## Datenschutz

Hinweise zur Orientierung, keine Rechtsberatung:

- Freigegebene Beiträge mit Bildern und Videos werden auf der Website **öffentlich**. Die Bridge überträgt nur den freigegebenen Text und die öffentlichen Fassungen der Dateien (ohne Standortdaten, neutral benannt) – keine Originale, keine Hinweise der hochladenden Personen.
- Läuft WordPress bei einem **externen Hoster**, verarbeitet dieser die Inhalte im Auftrag: dafür ist ein Vertrag zur Auftragsverarbeitung (Art. 28 DSGVO) nötig. Liegt der Hoster außerhalb der EU oder nutzt er dort Unterauftragnehmer, die Grundlage der Übermittlung prüfen.
- Plugins, Statistik, eingebundene Schriften oder Videos auf der Website sind eigene Verarbeitungen der Website und gehören in deren Datenschutzerklärung.
- Ein Widerspruch einer abgebildeten Person: Beitrag **zurückziehen** (siehe oben) bzw. die Datei aus der Fassung nehmen und neu freigeben.

## Wenn etwas schiefgeht

| Anzeige in BlaulichtCMS | Was tun |
|---|---|
| Wartet auf Abholung (lange) | Bridge-Einstellungen prüfen: letzter Abruf? WP-Cron/Host-Cron läuft? |
| Fehlgeschlagen | Fehlermeldung lesen, Ursache beheben, „Erneut versuchen“ |
| Ergebnis unbekannt | Abwarten – die Bridge prüft beim nächsten Abruf selbst und erzeugt keinen zweiten Beitrag |
| Ergebnis unbekannt nach Widerruf der Kopplung | Die Website kann nichts mehr melden. Auf der Website nachsehen und im Beitrag „Ergebnis von Hand festhalten“ (veröffentlicht oder nicht). Der Widerruf einer Freigabe ist trotzdem möglich. |
