Die **BlaulichtCMS Bridge** ist ein WordPress-Plugin. Sie holt freigegebene Beiträge per HTTPS bei BlaulichtCMS ab, veröffentlicht sie und meldet WordPress-ID und Adresse zurück. WordPress braucht dafür **keinen offenen Eingang** – die Bridge ruft nur aus.

## Voraussetzungen

- WordPress ab 6.4 mit PHP ab 8.1 und ein Konto mit dem Recht, Plugins zu installieren (Administrator).
- Die Website muss BlaulichtCMS **per HTTPS erreichen** können (ausgehende Verbindung). Einen Eingang in WordPress braucht es nicht.
- In BlaulichtCMS das Recht „Kanäle verwalten“.

## Koppeln in vier Schritten

1. In BlaulichtCMS unter [Websites](/kanaele) **Bridge herunterladen** (ZIP). Das Paket nicht entpacken.
2. In WordPress **Plugins → Installieren → Plugin hochladen**, ZIP wählen, **Jetzt installieren** und **Plugin aktivieren** ([Anleitung von WordPress](https://wordpress.org/documentation/article/manage-plugins/#upload-via-wordpress-admin)).
3. In BlaulichtCMS **Website koppeln**, einen Namen vergeben und den **Kopplungscode** notieren.
4. In WordPress **Einstellungen → BlaulichtCMS Bridge** die BlaulichtCMS-Adresse und den Code eintragen und **Koppeln** klicken.

### Kopplungscode

- Der Code entsteht in BlaulichtCMS beim Koppeln, ist **einmalig** und **30 Minuten** gültig. Er wird nur im Kopplungsdialog angezeigt.
- Abgelaufen oder verloren? Auf der Website-Karte **Neuen Kopplungscode** wählen.
- Die **BlaulichtCMS-Adresse** steht im Kopplungsdialog (Kopierknopf); sie ist die öffentliche Adresse aus *Einstellungen → Allgemein*.
- Der entstehende Schlüssel gilt nur für diese eine Website. „Widerrufen“ in BlaulichtCMS sperrt ihn sofort.

### Kopplung prüfen

Die Kopplung ist selbst der Test: Nur mit gültigem Code entsteht ein Schlüssel. Danach zeigt die Website-Karte in BlaulichtCMS **Aktiv**, die Bridge-Version und den **letzten Abruf**. In WordPress zeigt **Einstellungen → BlaulichtCMS Bridge** den Kopplungsstand, den letzten Abruf und den letzten Fehler; **Jetzt abrufen** holt sofort ab. Für einen vollständigen Test einen Beitrag auf einer **Testwebsite** veröffentlichen und wieder zurückziehen.

## Abruf und Cronjob

Die Bridge holt **jede Minute** neue Aufträge ab. Dafür nutzt sie WP-Cron, den Zeitplaner von WordPress. In BlaulichtCMS warnt die Website-Karte, wenn sich die Bridge länger als 15 Minuten nicht gemeldet hat.

### Was ist ein Cronjob?

WP-Cron läuft nur, wenn jemand die Website aufruft. Bei wenig Besucherverkehr oder mit Seitencache bleiben Aufträge deshalb liegen. Ein **Cronjob** ist ein Zeitplan beim Hoster oder auf dem Server, der eine Aufgabe regelmäßig startet – z. B. jede Minute. Damit läuft der Abruf zuverlässig, unabhängig von Besuchern ([WordPress: WP-Cron an den System-Zeitplaner hängen](https://developer.wordpress.org/plugins/cron/hooking-wp-cron-into-the-system-task-scheduler/)).

### Host-Cron mit WP-CLI

Mit Shell-Zugang und [WP-CLI](https://wordpress.org/cli/) (eigener Server, viele Managed-Hoster):

```
* * * * * wp --path=/var/www/html blaulichtcms-bridge poll
```

`--path` ist der WordPress-Ordner. Der Befehl holt die Aufträge sofort ab und meldet Fehler im Cron-Protokoll. `wp blaulichtcms-bridge status` zeigt den Kopplungsstand.

### Cronjob beim Hoster

Ohne Shell bieten viele Hoster in ihrer Verwaltung Cronjobs an, die eine **Adresse aufrufen**. Dann die WP-Cron-Adresse der Website jede Minute aufrufen lassen (oder so oft der Tarif erlaubt):

```
https://example.org/wp-cron.php?doing_wp_cron
```

Anleitungen der Hoster (Stand November 2026): [ALL-INKL](https://all-inkl.com/wichtig/anleitungen/kas/tools/cronjobs/einrichtung_479.html), [STRATO](https://www.strato.de/faq/hosting/so-einfach-richten-sie-ihre-cron-jobs-ein/), [Hetzner konsoleH](https://docs.hetzner.com/de/konsoleh/account-management/configuration/cronmanager/). Bei anderen Hostern in der Hilfe nach „Cronjob“ suchen. Läuft der Cronjob zuverlässig, kann in `wp-config.php` mit `define( 'DISABLE_WP_CRON', true );` der Aufruf bei jedem Seitenbesuch abgeschaltet werden.

### Seitencache

Cache-Plugins und Hoster-Caches liefern Seiten aus dem Zwischenspeicher. Die Bridge leert bei Banneränderungen und zu Start und Ende eines Banners die Caches von WP Super Cache, W3 Total Cache, WP Rocket und LiteSpeed Cache selbst; für andere Caches gibt es die Aktion `blaulichtcms_bridge_purge_cache`. Abgelaufene Banner blendet ein kleines Skript zusätzlich im Browser aus. Ein Cache darf `wp-cron.php` nicht zwischenspeichern; neue Beiträge erscheinen sonst erst, wenn der Cache abläuft oder geleert wird.

### Bridge-Updates

Neue Bridge-Versionen kommen über den normalen WordPress-Updateweg – zuerst auf Websites im Kanal **„Test“**, dann nach Freigabe für alle. Ablauf: [Updates → BlaulichtCMS Bridge](/hilfe/updates#blaulichtcms-bridge).

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
