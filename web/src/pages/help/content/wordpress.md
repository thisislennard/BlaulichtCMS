Die **LifeLink Bridge** ist ein WordPress-Plugin. Sie holt freigegebene Beiträge per HTTPS bei LifeLink ab, veröffentlicht sie und meldet WordPress-ID und Adresse zurück. WordPress braucht dafür **keinen offenen Eingang** – die Bridge ruft nur aus.

## Koppeln in vier Schritten

1. In LifeLink unter [Websites](/kanaele) **Bridge herunterladen** (ZIP).
2. In WordPress **Plugins → Installieren → Plugin hochladen**, ZIP wählen, installieren und aktivieren.
3. In LifeLink **Website koppeln**, einen Namen vergeben und den **Kopplungscode** notieren (einmalig, 30 Minuten gültig).
4. In WordPress **Einstellungen → LifeLink Bridge** die LifeLink-Adresse und den Code eintragen und **Koppeln** klicken.

Der entstehende Schlüssel gilt nur für diese eine Website. „Widerrufen“ in LifeLink sperrt ihn sofort.

## Abruf

Die Bridge holt jede Minute neue Aufträge ab (WP-Cron). Bei wenig Besucherverkehr oder aktivem Seitencache besser einen Host-Cron einrichten:

```
* * * * * wp --path=/var/www/html lifelink-bridge poll
```

In WordPress zeigt **Einstellungen → LifeLink Bridge** den letzten Abruf und den letzten Fehler. „Jetzt abrufen“ startet sofort. In LifeLink warnt die Website-Karte, wenn sich die Bridge länger als 15 Minuten nicht gemeldet hat.

## Was in WordPress entsteht

- Ein Beitrag (Status „Veröffentlicht“) mit Titel, Text und Kurzfassung
- Titelbild als Beitragsbild, weitere Bilder und Videos unter dem Text
- Autor und Kategorie lassen sich in den Bridge-Einstellungen festlegen

Eine neue, freigegebene Fassung desselben LifeLink-Beitrags **aktualisiert** den bestehenden WordPress-Beitrag.

## Wenn etwas schiefgeht

| Anzeige in LifeLink | Was tun |
|---|---|
| Wartet auf Abholung (lange) | Bridge-Einstellungen prüfen: letzter Abruf? WP-Cron/Host-Cron läuft? |
| Fehlgeschlagen | Fehlermeldung lesen, Ursache beheben, „Erneut versuchen“ |
| Ergebnis unbekannt | Abwarten – die Bridge prüft beim nächsten Abruf selbst und erzeugt keinen zweiten Beitrag |
