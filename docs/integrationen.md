# Integrationen – Prüfstand

Stand: Meilenstein 4 (Abschluss der Umsetzung). Einstufung je Verbindung: **lokal** (Testdienst/fiktive Daten),
**Anbieter** (echtes Testkonto beim Anbieter), **produktionsnah** (reale Zielumgebung, ohne echte Veröffentlichung
an die Öffentlichkeit). Alle Verbindungen sind optional und durchlaufen **Verbinden → Testen → Vorschau → Aktivieren**.

| Verbindung | Umgesetzt | Lokaler Test | Test mit Anbieter | Produktionsnah | Konkret fehlender Live-Test |
|---|---|---|---|---|---|
| **WordPress (LifeLink Bridge)** | ✅ Beiträge mit Medien, Banner, Einsatzübersicht, Zurückziehen, Updates über WordPress | ✅ WordPress 6.9 (Docker), PHP 8.3, Host-Cron, Idempotenz, Update 0.3.9 → 0.4.0 mit Prüfsumme und erhaltener Kopplung | – (kein Anbieter) | ❌ | Bridge auf der echten Testwebsite, HTTPS-Kopplung mit der produktiven Adresse, WP-Cron **und** Host-Cron, Theme und Seitencache |
| **Facebook-Seite** | ✅ OAuth, Seitenwahl, Text/Fotos/Video, Status je Kanal, gezieltes Wiederholen, Prüfung bei unbekanntem Ergebnis, manueller Export | ✅ Graph-API-Ersatz: unveröffentlichter Testbeitrag + Löschen, Ablehnung (400), Serverfehler nach Anlage (500 → „unbekannt“ → gefunden, kein Duplikat), OAuth-Rückweg ohne Cookie | ❌ | ❌ | Meta-App mit Facebook Login, App-Prüfung der Rechte `pages_manage_posts` u. a., Testseite; Veröffentlichung eines nicht öffentlichen Testbeitrags |
| **Instagram-Konto** | ✅ Instagram Login, Container, Statusprüfung, Karussell, Reels, Kontingent | ✅ Graph-API-Ersatz: Container ohne Veröffentlichung im Test, Veröffentlichung mit Permalink, keine Doppelveröffentlichung | ❌ | ❌ | professionelles Testkonto, App-Prüfung für `instagram_business_content_publish`, öffentlich erreichbare HTTPS-Adresse für den Medienabruf |
| **FE2** | ✅ Eingang mit Zugangsschlüssel, Allowlist, ein Entwurf je Einsatz, Folgeereignisse | ✅ HTTP-Testmeldungen gegen den Container: Vorschau vor Aktivierung, Wiederholung erkannt, Alarmtext verworfen, keine Inhalte in Protokollen | ❌ | ❌ | anonymisierte Testmeldung aus der echten FE2-Instanz (HTTP-Ausgang, tatsächliches JSON-Format, Feldzuordnung) |
| **SMTP (Warnentwurf)** | ✅ PDF-Anhang, Testmodus, Status angenommen/fehlgeschlagen/unbekannt | ✅ lokaler Test-Mailserver: Annahme, 550-Ablehnung, Abbruch nach DATA | ❌ | ❌ | Versand über den Mailserver der Organisation an ein abgestimmtes Testpostfach der zuständigen Stelle (TLS, SPF/DKIM) |
| **RSS / Atom** | ✅ Vorschau, Deduplizierung, ETag, Themenideen | ✅ WordPress-Feed als Quelle | – | ❌ | echte Feeds der Organisation |
| **Amtliche Warnfeeds** | ✅ Warn-App-Schnittstelle (Regionalschlüssel) und CAP-Adressen, Gebietsfilter, Aktualisierung, Entwarnung, automatische Banner nur nach dokumentierter Prüfung | ✅ CAP-Testquelle: privates Ziel erst nach Freigabe, Gebietsfilter, Update ersetzt, Cancel beendet Banner | ❌ | ❌ | Abruf der echten Warn-App-Schnittstelle für den eigenen Regionalschlüssel; Nutzungsbedingungen der Weiterverwendung prüfen |
| **LiFeOS-Import** | ✅ Importrahmen (Austauschformat, Probelauf, Prüfsummen, Mengenabgleich, Altlink-Weiterleitung) | ✅ fiktive Testdaten | – | ❌ | **LiFeOS-Exportformat liegt nicht vor** – Umsetzer erstellen, Import gegen eine Kopie (#35) |

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
