# Integrationen – Prüfstand

Stand: Meilenstein 3. Einstufung je Verbindung: **lokal** (Testdienst/fiktive Daten), **Anbieter** (echtes Testkonto
beim Anbieter), **produktionsnah** (reale Zielumgebung, ohne echte Veröffentlichung an die Öffentlichkeit).

| Verbindung | Umgesetzt | Lokal geprüft | Mit Anbieter | Produktionsnah | Konkret fehlender Live-Test |
|---|---|---|---|---|---|
| **WordPress (LifeLink Bridge)** | M1: Beiträge mit Medien, Kopplung, Abruf, Rückmeldung | ✅ WordPress 6.9 (Docker, Theme Twenty Twenty-Five), PHP 8.3, Host-Cron per WP-CLI, Kopplung über WP-Oberfläche, Idempotenz | – | ❌ | Bridge auf der echten Testwebsite installieren, mit der produktiven LifeLink-Adresse über HTTPS koppeln, Abruf per WP-Cron **und** Host-Cron prüfen, Theme-Darstellung und Seitencache prüfen |
| **SMTP (Warnentwurf)** | ✅ M3: PDF-Anhang, Testmodus, Status angenommen/fehlgeschlagen/unbekannt | ✅ lokaler Test-Mailserver (smtp-server): Annahme, 550-Ablehnung, Abbruch nach DATA | – | ❌ | Versand über den echten Mailserver der Organisation an ein abgestimmtes **Test**postfach der zuständigen Stelle; TLS/Anmeldung, SPF/DKIM, Spam-Einstufung, Rückmeldeweg für die Eingangsbestätigung (#30) |
| **Facebook / Instagram** | ❌ M4 | – | – | – | OAuth, Formate, Veröffentlichung mit Testkonto (#32) |
| **FE2** | ❌ M4 | – | – | – | anonymisierte Testmeldung aus der echten FE2-Instanz (#33) |
| **Amtliche Warnfeeds** | ❌ M4 | – | – | – | Bezugsweg, Gebietsfilter, Entwarnungen (#34) |
| **RSS / Atom** | ✅ M2 | ✅ WordPress-Feed als Quelle | – | ❌ | echte Feeds der Organisation |
| **LiFeOS-Import** | ❌ M4 | – | – | – | Quellcode und Datenformat liegen nicht vor (#35) |

## WordPress – was lokal geprüft wurde

- Installation der Bridge aus der ZIP, die LifeLink unter *Websites* ausliefert (`wp plugin install`).
- Kopplung über die Einstellungsseite in WordPress mit einmaligem Code; Code danach verbraucht (401).
- Abholung per Host-Cron (`wp lifelink-bridge poll`), Veröffentlichung mit Titelbild, Rückmeldung von ID und Permalink.
- LifeLink zeigt die bestätigte URL im Beitrag und im Dashboard.
- Erneute Auslieferung (Status „Ergebnis unbekannt“) und doppelte Rückmeldung: weiterhin genau **ein** Beitrag und **ein** Anhang.
- Öffentliche Medienfassung ohne EXIF; Medien nur für Aufträge der eigenen Website abrufbar.
- Widerrufene Kopplung: 401 bei der nächsten Anfrage.
- Wiederhergestellte LifeLink-Instanz: Bridge arbeitet mit ihrem bisherigen Schlüssel weiter.

Nicht geprüft: WP-Cron im Echtbetrieb (nur Host-Cron), Multisite, Caching-Plugins, HTTPS-Kopplung mit echtem Zertifikat,
große Videodateien über die Bridge.
