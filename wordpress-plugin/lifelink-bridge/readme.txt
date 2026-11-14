=== LifeLink Bridge ===
Contributors: lifelink
Tags: lifelink, redaktion, veröffentlichung
Requires at least: 6.4
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 0.4.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Verbindet eine WordPress-Website mit LifeLink: freigegebene Beiträge werden abgeholt, veröffentlicht und mit WordPress-ID und Adresse bestätigt.

== Beschreibung ==

LifeLink ist ein eigenständiges CMS für Öffentlichkeitsarbeit und Krisenkommunikation. Die Bridge ist die Verbindung zur Website:

* Kopplung per einmaligem Code aus LifeLink. Der entstehende Schlüssel gilt nur für diese Website und lässt sich in LifeLink widerrufen.
* Die Bridge ruft nur aus (HTTPS-Abruf jede Minute über WP-Cron oder Host-Cron). WordPress braucht keinen offenen Eingang für LifeLink.
* Idempotent: Erneutes Abholen oder Bestätigen desselben Auftrags erzeugt keinen zweiten Beitrag – der Beitrag wird über die LifeLink-ID wiedergefunden und aktualisiert.
* Medien kommen als geprüfte, öffentliche Fassung ohne Standortdaten und werden in der Mediathek wiederverwendet.

== Installation ==

1. In LifeLink unter **Kanäle → Websites** die ZIP-Datei „LifeLink Bridge“ herunterladen.
2. In WordPress **Plugins → Installieren → Plugin hochladen**, Datei auswählen, installieren und aktivieren.
3. In LifeLink **Website koppeln** wählen und den Kopplungscode notieren.
4. In WordPress **Einstellungen → LifeLink Bridge** die LifeLink-Adresse und den Code eintragen und **Koppeln** klicken.

Host-Cron (empfohlen bei wenig Besucherverkehr oder aktivem Seitencache):

    * * * * * wp --path=/var/www/html lifelink-bridge poll

== Häufige Fragen ==

= Warum erscheint ein Beitrag nicht sofort? =

Die Bridge holt Aufträge regelmäßig ab (Standard: jede Minute). Unter **Einstellungen → LifeLink Bridge** zeigt „Letzter Abruf“, ob der Abruf läuft. „Jetzt abrufen“ startet ihn sofort.

= Kann ich LifeLink über http:// koppeln? =

Nur im Testbetrieb: `define( 'LIFELINK_BRIDGE_ALLOW_HTTP', true );` in der wp-config.php.

== Updates ==

Neue Versionen bietet die gekoppelte LifeLink-Instanz über den normalen WordPress-Updateweg an (Dashboard → Aktualisierungen bzw. `wp plugin update lifelink-bridge`). Websites im Update-Kanal „Test“ erhalten eine neue Version zuerst; alle anderen erst, nachdem sie in LifeLink freigegeben wurde. Vor der Installation prüft die Bridge das Paket gegen die SHA-256-Prüfsumme aus LifeLink. Die Kopplung bleibt beim Update erhalten.

== Changelog ==

= 0.4.0 =
* Updates über den WordPress-Updateweg mit Prüfsummenkontrolle; Test-Kanal und Freigabe in LifeLink.

= 0.3.0 =
* Banner (Shortcode, Block, automatische Anzeige), Einsatzübersicht, Ablauf auch ohne Verbindung.

= 0.2.0 =
* Kanaltexte, Termine, Zurückziehen von Beiträgen.

= 0.1.0 =
* Erste Version mit Abholprinzip: Kopplung per Einmalcode, Beiträge mit Medien, Rückmeldung von WordPress-ID und Adresse.
