=== LifeLink ===
Contributors: lifelink
Tags: banner, hinweis, feuerwehr, warnung, rest-api
Requires at least: 6.4
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Zeitgesteuerte Hinweis-Banner und Beitragsentwürfe aus LifeLink – über eine signierte, versionierte REST-Schnittstelle.

== Beschreibung ==

Das Plugin ist die Brücke zwischen LifeLink und Ihrer WordPress-Website. WordPress bleibt für Darstellung und redaktionelle Freigabe zuständig; LifeLink liefert Auslöser und freigegebene Inhalte.

* Farbige, zeitgesteuerte Banner (rot, orange, gelb, blau, grün, neutral) mit Klartext-Label, Priorität, Start-/Endzeit, Zielseiten und optionalem Link.
* Mehrere gleichzeitige Banner, sortiert nach Priorität und Startzeit.
* Ausgabe automatisch am Seitenanfang, per Shortcode `[lifelink_banners]`, als Block „LifeLink-Hinweise“ oder als klassisches Widget.
* Abgelaufene Banner verschwinden zuverlässig: WP-Cron zum Start-/Endzeitpunkt, 5-Minuten-Abgleich, Leeren gängiger Seiten-Caches und ein kleines Skript, das abgelaufene Banner auch aus zwischengespeichertem HTML entfernt.
* Beiträge aus LifeLink werden als Entwurf oder „Ausstehender Review“ angelegt. Veröffentlicht wird in WordPress (geplante Veröffentlichung nur, wenn Sie es erlauben).
* Barrierefrei: sichtbares Textlabel (Farbe allein vermittelt keine Dringlichkeit), Kontrast mindestens 4,5 : 1, Screenreader-Ankündigungen, Fokus-Stile, reduzierte Bewegung.
* Sicherheit: jede Anfrage ist mit HMAC-SHA256 signiert, mit Zeitstempel (±300 s), Einmal-Nonce und Rate-Limit (120 Anfragen pro Minute und Schlüssel). Schlüssel lassen sich rotieren und sofort widerrufen. Alle Zugriffe werden protokolliert – ohne Geheimnisse.
* Multisite-fähig: Daten und Schlüssel je Website.

== Installation ==

1. Laden Sie die ZIP-Datei des Plugins aus LifeLink herunter.
2. In WordPress: **Plugins → Installieren → Plugin hochladen**, die ZIP-Datei auswählen, **Jetzt installieren** und anschließend **Aktivieren**.
3. Öffnen Sie **Einstellungen → LifeLink** und klicken Sie auf **Schlüssel erzeugen**.
4. Kopieren Sie Schlüssel-ID, Geheimnis und Website-URL. Das Geheimnis wird nur dieses eine Mal angezeigt.
5. Tragen Sie die Werte in LifeLink im Einrichtungsassistenten („WordPress verbinden“) ein.
6. Wählen Sie unter **Einstellungen → LifeLink** einen **Autor für Beiträge**, falls LifeLink Beiträge anlegen soll.

Sobald LifeLink die erste Anfrage gesendet hat, zeigt die Einstellungsseite „Verbunden“ und die Zeit der letzten erfolgreichen Anfrage.

== Häufige Fragen ==

= Wo erscheinen die Banner? =

Standardmäßig automatisch am Seitenanfang (Theme-Hook `wp_body_open`). Unterstützt Ihr Theme diesen Hook nicht oder möchten Sie die Position selbst bestimmen, schalten Sie die automatische Ausgabe ab und verwenden Sie den Block „LifeLink-Hinweise“, den Shortcode `[lifelink_banners]` oder das Widget. Verwenden Sie nicht mehrere Ausgabewege gleichzeitig auf derselben Seite, sonst erscheinen die Banner doppelt.

= Wie wechsle ich den Schlüssel? =

„Neuen Schlüssel erzeugen“, den neuen Schlüssel in LifeLink eintragen und danach den alten „Widerrufen“. Höchstens zwei Schlüssel sind gleichzeitig gültig. Widerrufen wirkt sofort.

= Ich habe das Geheimnis nicht kopiert. =

Es kann nicht erneut angezeigt werden. Erzeugen Sie einen neuen Schlüssel und widerrufen Sie den alten.

= Kann LifeLink Beiträge direkt veröffentlichen? =

Nein. Beiträge werden als Entwurf oder zur Freigabe angelegt. Nur wenn Sie „Geplante Veröffentlichung durch LifeLink erlauben“ einschalten, können Beiträge zu einem künftigen Zeitpunkt geplant werden. Bereits veröffentlichte Beiträge ändert LifeLink nicht mehr.

= Welche Caching-Plugins werden geleert? =

LiteSpeed Cache, WP Rocket, W3 Total Cache, WP Super Cache und WP Fastest Cache, sofern aktiv. Für andere Lösungen gibt es den Hook `lifelink_banners_changed`.

= Ein Sicherheits-Plugin blockiert die REST-API. =

LifeLink nutzt die Routen unter `/wp-json/lifelink/v1/`. Geben Sie diesen Bereich in Ihrem Sicherheits-Plugin bzw. Ihrer Web-Application-Firewall frei. Die Header `X-LifeLink-Key`, `X-LifeLink-Timestamp`, `X-LifeLink-Nonce` und `X-LifeLink-Signature` müssen unverändert ankommen.

= Kann ich die Farben anpassen? =

Ja, über die CSS-Variablen `--lifelink-color-<farbe>-bg` und `--lifelink-color-<farbe>-fg` (z. B. `--lifelink-color-rot-bg`). Achten Sie dabei auf einen Kontrast von mindestens 4,5 : 1.

= Was passiert bei der Deinstallation? =

Beim Löschen des Plugins werden Banner-Tabelle, Einstellungen, Schlüssel, Protokoll, Transients und geplante Ereignisse entfernt – bei Multisite für alle Websites. Von LifeLink angelegte Beiträge bleiben erhalten.

== Changelog ==

= 1.0.0 =
* Erste Version: signierte REST-Schnittstelle v1, Banner, Beiträge, Shortcode, Block, Widget, Admin-Seite, Audit-Verlauf, Multisite.
