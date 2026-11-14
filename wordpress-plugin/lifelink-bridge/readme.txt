=== LifeLink Bridge ===
Contributors: lifelink
Tags: lifelink, redaktion, veröffentlichung
Requires at least: 6.4
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 0.1.0
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

== Changelog ==

= 0.1.0 =
* Erste Version mit Abholprinzip: Kopplung per Einmalcode, Beiträge mit Medien, Rückmeldung von WordPress-ID und Adresse.
