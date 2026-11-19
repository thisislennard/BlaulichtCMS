=== BlaulichtCMS Bridge ===
Contributors: blaulichtcms
Tags: blaulichtcms, redaktion, veröffentlichung
Requires at least: 6.4
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 0.9.2
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Verbindet eine WordPress-Website mit BlaulichtCMS: freigegebene Beiträge werden abgeholt, veröffentlicht und mit WordPress-ID und Adresse bestätigt.

== Beschreibung ==

BlaulichtCMS ist ein eigenständiges CMS für Öffentlichkeitsarbeit und Krisenkommunikation. Die Bridge ist die Verbindung zur Website:

* Kopplung per einmaligem Code aus BlaulichtCMS. Der entstehende Schlüssel gilt nur für diese Website und lässt sich in BlaulichtCMS widerrufen.
* Die Bridge ruft nur aus (HTTPS-Abruf jede Minute über WP-Cron; ist WP-Cron abgeschaltet, stößt die Bridge den Abruf selbst an). WordPress braucht keinen offenen Eingang für BlaulichtCMS.
* Kategorie je Beitrag und je Automation aus BlaulichtCMS; Standardkategorie in den Einstellungen.
* Autor: eigener Autor der Bridge, je Person aus BlaulichtCMS oder ein vorhandener Benutzer. Angelegte Autoren haben keine Rechte und keine Anmeldung.
* Hinweise mit Schweregraden (Hinweis, Warnung, Gefahr): Farbe und Darstellung (Banner, Popup oder beides) je Schweregrad einstellbar.
* Idempotent: Erneutes Abholen oder Bestätigen desselben Auftrags erzeugt keinen zweiten Beitrag – der Beitrag wird über die BlaulichtCMS-ID wiedergefunden und aktualisiert.
* Medien kommen als geprüfte, öffentliche Fassung ohne Standortdaten und werden in der Mediathek wiederverwendet.
* Einsatzliste mit Jahresstatistik: freigegebene Einsätze aus BlaulichtCMS als Liste (Tabelle oder Karten, Filter nach Jahr und Kategorie, Jahresabschnitte), Statistik je Jahr, Monat und Kategorie mit Diagramm, Detailseite je Einsatz. Shortcodes `[blaulichtcms_einsatzliste]` und `[blaulichtcms_einsatzstatistik]`, gleichnamige Blöcke.

== Installation ==

1. In BlaulichtCMS unter **Einrichtung → Verbindungen → Websites** die ZIP-Datei „BlaulichtCMS Bridge“ herunterladen.
2. In WordPress **Plugins → Installieren → Plugin hochladen**, Datei auswählen, installieren und aktivieren.
3. In BlaulichtCMS **Neue Verbindung → Website (WordPress)** bzw. **Website koppeln** wählen und den Kopplungscode notieren.
4. In WordPress **Einstellungen → BlaulichtCMS Bridge** die BlaulichtCMS-Adresse und den Code eintragen und **Koppeln** klicken.

Ein Host-Cron ist nicht nötig. Die Bridge ruft über WP-Cron ab; ist WP-Cron abgeschaltet (`DISABLE_WP_CRON`), stößt sie den Abruf bei jedem Seitenaufruf selbst an (höchstens einmal je Minute). Optional bei sehr wenig Besucherverkehr oder einem Seitencache, der PHP umgeht:

    * * * * * wp --path=/var/www/html blaulichtcms-bridge poll

== Einstellungen ==

Unter **Einstellungen → BlaulichtCMS Bridge**:

* **Beiträge:** Autor (eigener Autor der Bridge mit einstellbarem Anzeigenamen, Person aus BlaulichtCMS oder vorhandener Benutzer) und Standardkategorie. Wie ein Beitrag aussieht, bestimmt das Theme.
* **Einsatzliste** (eigene Seite **Einstellungen → BlaulichtCMS Einsatzliste**, mit Vorschau): Spalten und Reihenfolge, Sortierung, Einträge je Seite, Filter für Besucher, Tabelle oder Karten, Jahresabschnitte, Detailseiten samt Adresse, Akzent- und Kopfzeilenfarbe, Farbe und Symbol je Kategorie, Ansichten der Statistik. Shortcode-Attribute überschreiben die Vorgaben, z. B. `[blaulichtcms_einsatzliste jahr="2025" darstellung="karten" spalten="datum,stichwort,meldung,ort"]`.
* **Darstellung der Hinweise:** je Schweregrad Farbe und Darstellung – Banner (Seitenanfang, Shortcode `[blaulichtcms_banner]`, Block „BlaulichtCMS: Hinweise“), Popup beim Aufruf der Seite (modaler Dialog, Esc oder „Verstanden“ schließt, der Browser merkt sich geschlossene Hinweise) oder beides. Vorgabe: Hinweis und Warnung als Banner, Gefahr als Banner und Popup.

== Häufige Fragen ==

= Warum erscheint ein Beitrag nicht sofort? =

Die Bridge holt Aufträge regelmäßig ab (Standard: jede Minute). Unter **Einstellungen → BlaulichtCMS Bridge** zeigt „Letzter Abruf“, ob der Abruf läuft. „Jetzt abrufen“ startet ihn sofort.

= Kann ich BlaulichtCMS über http:// koppeln? =

Nur im Testbetrieb: `define( 'BLAULICHTCMS_BRIDGE_ALLOW_HTTP', true );` in der wp-config.php.

== Updates ==

Neue Versionen bietet die gekoppelte BlaulichtCMS-Instanz über den normalen WordPress-Updateweg an (Dashboard → Aktualisierungen bzw. `wp plugin update blaulichtcms-bridge`). In der Plugin-Liste lässt sich „Automatische Updates aktivieren“ einschalten; WordPress installiert neue Versionen dann selbst (mit derselben Prüfung von Prüfsumme und Signatur). Ist WP-Cron abgeschaltet, holt die Bridge ihr automatisches Update selbst nach. Jedes Update von BlaulichtCMS bringt die passende Bridge mit; die Bridge fragt höchstens alle sechs Stunden nach. Vor der Installation prüft die Bridge das Paket gegen die SHA-256-Prüfsumme aus BlaulichtCMS. Ist in der Bridge ein Signaturschlüssel hinterlegt (includes/signing-keys.php), installiert sie zusätzlich nur Pakete mit gültiger Ed25519-Signatur des Betreibers; der private Schlüssel liegt nicht auf dem BlaulichtCMS-Server. Die Kopplung bleibt beim Update erhalten.

== Changelog ==

= 0.9.2 =
* Plugin-Details: Das Fenster „Details ansehen“ zeigt Titelbild, Beschreibung, Installation, häufige Fragen und die Änderungen der letzten Versionen. Bei einem angebotenen Update beschreibt es die neue Version.
* Symbol der Bridge in der Plugin-Liste und unter „Aktualisierungen“.
* Updates ohne Freigabe: Jede gekoppelte Website erhält die Bridge, die im laufenden BlaulichtCMS steckt (ab BlaulichtCMS 0.8.1).

= 0.9.1 =
* Shortcode-Hilfe (#227): Neuer Reiter „Shortcodes“ unter „Einstellungen → BlaulichtCMS Einsatzliste“ mit allen Shortcodes der Bridge, allen Attributen samt erlaubten Werten, Vorgaben (mit aktuell gespeicherter Einstellung) und Wirkung, den vier Teilen der Einsatzstatistik (`ansicht="summe"`, `"monate"`, `"kategorien"`, `"jahre"`) und fertigen Beispielen mit Kopieren-Knopf. Hinweis auf die Blöcke als Alternative und zur Jahresauswahl (`auswahl`).

= 0.9.0 =
* Einsatzliste (#213): Aufträge „Einsatz veröffentlichen/zurückziehen“ aus BlaulichtCMS. Jeder Einsatz wird ein eigener Inhalt (Typ `blaulichtcms_einsatz`) mit Alarmzeit, Stichwort und Bedeutung, Kategorie, Einsatzmeldung, Ort (nur Ortsteil), Fahrzeugen, weiteren Kräften, Kurzbericht und Bildern. Zurückgezogene Einsätze werden samt nicht anderweitig verwendeter Bilder entfernt.
* Shortcodes `[blaulichtcms_einsatzliste]` (Tabelle oder Karten, Filter nach Jahr und Kategorie, Seiten, Jahresabschnitte, nur besondere Einsätze) und `[blaulichtcms_einsatzstatistik]` (Anzahl mit Vorjahr und Fehlalarmen, je Monat, je Kategorie, je Jahr; Balkendiagramm mit Tabelle als Alternative), gleichnamige Blöcke mit Einstellungen in der Seitenleiste. Auf schmalen Bildschirmen erscheinen Tabellenzeilen als Blöcke mit Beschriftung.
* Neue Einstellungsseite „BlaulichtCMS Einsatzliste“ mit Vorschau; Schrift und Grundfarben kommen vom Theme.
* Alternativtexte von Bildern (#217): Ein in BlaulichtCMS geänderter Alternativtext wird auch bei bereits übernommenen Bildern nachgezogen, solange er in WordPress nicht von Hand geändert wurde.

= 0.8.0 =
* Kategorie je Beitrag und je Automation: BlaulichtCMS überträgt die gewählten Kategorien; die Bridge meldet dafür die Kategorien der Website an BlaulichtCMS. Ohne Auswahl gilt die Standardkategorie.
* Autor: Die Bridge legt einen eigenen Autor (Anzeigename einstellbar) oder – wenn in BlaulichtCMS eingeschaltet – je verfassender Person einen Autor an. Rolle „BlaulichtCMS-Autor“ ohne Rechte, ohne E-Mail-Adresse, Anmeldung, Passwort-Zurücksetzen und Anwendungspasswörter gesperrt. Ein fest gewählter Benutzer gilt weiter.
* Hinweise auffälliger: Symbol, kräftigere Farben, „Gefahr“ vollflächig. Farbe und Darstellung (Banner, Popup oder beides) je Schweregrad einstellbar, mit Vorschau. Das Popup ist ein barrierearmer modaler Dialog und erscheint je Hinweis und Fassung nur einmal. Einzelne Hinweise können in BlaulichtCMS eine feste Darstellung haben.
* Kein Host-Cron mehr nötig: Ist WP-Cron abgeschaltet, stößt die Bridge den Abruf selbst an; Anzeige des Abrufwegs und Hinweis, wenn der Abruf ausfällt. Der Abrufweg erscheint auch in BlaulichtCMS.
* Automatische Updates: Der Schalter „Automatische Updates aktivieren“ in der Plugin-Liste funktioniert; Prüfsumme und Signatur werden wie bisher geprüft. Kopfzeile „Update URI“, damit WordPress nie ein gleichnamiges Plugin von wordpress.org anbietet.

= 0.7.0 =
* Umbenennung in BlaulichtCMS Bridge: Plugin-Ordner und Hauptdatei `blaulichtcms-bridge`, Shortcodes `[blaulichtcms_banner]` und `[blaulichtcms_einsaetze]`, Blöcke `blaulichtcms/banner` und `blaulichtcms/incidents`, WP-CLI-Befehl `wp blaulichtcms-bridge poll`, Optionen und Beitragsfelder mit Präfix `blaulichtcms`.

= 0.6.1 =
* Erste signierte Version: Der öffentliche Signaturschlüssel ist hinterlegt. Ab jetzt installiert die Bridge nur noch Updates mit gültiger Ed25519-Signatur.

= 0.6.0 =
* Zurückziehen löscht die übernommenen Bilder und Videos endgültig aus der Mediathek, ebenso Medien, die in einer neuen Fassung fehlen – sofern kein anderer Beitrag und keine andere Seite sie verwendet. BlaulichtCMS zieht den Beitrag auf allen Websites zurück, auf denen er steht.
* Kopplung lösen oder in BlaulichtCMS widerrufener Schlüssel entfernt alle Hinweis-Banner von der Website (Beenden und Entwarnung kämen sonst nicht mehr an).
* Lange Medienimporte: Die Abrufsperre wird vor und nach jeder Mediendatei erneuert und gilt erst nach 10 Minuten als verwaist; kein paralleler zweiter Import mehr. Sehr lange Aufträge werden beim nächsten Abruf fortgesetzt.
* Update: Das Paket wird über ein frisch abgerufenes Angebot geladen – kein „HTTP 403“ mehr, wenn zwischen Angebot und Klick auf „Jetzt aktualisieren“ mehr als eine Stunde liegt.
* Multisite: Update-Angebot je Website; im Netzwerk-Admin prüft eine gekoppelte Website des Netzes das Paket. Ein Paket von BlaulichtCMS wird nie mehr ohne Prüfsummenkontrolle installiert.
* Code-Signatur für Updates (Ed25519): Mit hinterlegtem Schlüssel werden nur signierte Pakete installiert – ein übernommener BlaulichtCMS-Server kann keinen fremden Code verteilen. Ohne Schlüssel wie bisher nur Prüfsumme. Status auf der Einstellungsseite.
* Abrufstatus in eigener Option: Ein laufender Abruf überschreibt gleichzeitig gespeicherte Einstellungen oder ein Entkoppeln nicht mehr.

= 0.5.1 =
* Erstmals in einem echten WordPress (7.1, PHP 8.5) geprüft: Kopplung per HTTPS, Abruf über WP-Cron und Host-Cron, Banner mit Seitencache.
* Unverschlüsselte Adressen (http://) werden auch beim Abruf abgelehnt, sobald der Testschalter fehlt – nicht nur beim Koppeln.
* Bilder erhalten Titel und Alternativtext aus dem Beitragstitel statt der Datei-Kennung.
* Banner gleicher Priorität: Gefahr vor Warnung vor Hinweis.

= 0.5.0 =
* Atomare Abrufsperre; „Jetzt abrufen“ startet nicht parallel zu einem laufenden Abruf.
* Ein fehlerhafter Auftrag bricht den Stapel nicht mehr ab; Laufzeit je Abruf begrenzt.
* Neue Beiträge werden erst nach erfolgreicher Medienübernahme veröffentlicht.
* Beiträge im Papierkorb werden erkannt (kein Duplikat); fester Autor als Rückfall unter WP-Cron.
* Objekt-Cache wird nicht mehr bei jeder Banneränderung geleert (Filter `blaulichtcms_bridge_flush_object_cache`).
* Entkoppeln und Deinstallation widerrufen den Schlüssel auch in BlaulichtCMS; vollständiges Aufräumen inkl. Multisite.

= 0.4.0 =
* Updates über den WordPress-Updateweg mit Prüfsummenkontrolle; Test-Kanal und Freigabe in BlaulichtCMS.

= 0.3.0 =
* Banner (Shortcode, Block, automatische Anzeige), Einsatzübersicht, Ablauf auch ohne Verbindung.

= 0.2.0 =
* Kanaltexte, Termine, Zurückziehen von Beiträgen.

= 0.1.0 =
* Erste Version mit Abholprinzip: Kopplung per Einmalcode, Beiträge mit Medien, Rückmeldung von WordPress-ID und Adresse.
