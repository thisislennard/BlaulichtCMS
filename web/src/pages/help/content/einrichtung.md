## Ersteinrichtung

Installiert wird am Docker-Host mit `sudo bash install.sh` (Ordner `/opt/apps/blaulichtcms`). Das Skript zeigt am Ende den **Einrichtungsschlüssel**; er steht auch im Container-Protokoll:

```
cd /opt/apps/blaulichtcms && docker compose logs blaulichtcms | grep Einrichtungsschlüssel
```

Dann `/einrichtung` öffnen und in zwei Schritten festlegen:

1. **Organisation**, **öffentliche Adresse** (HTTPS, hinter dem Reverse Proxy) und **Zeitzone**
2. Das erste Konto (Administration)

Die öffentliche Adresse steht in Einladungen, Upload-Links und QR-Codes. Später ändern geht unter **Einstellungen → Organisation** – bereits gedruckte QR-Codes zeigen dann aber weiter auf die alte Adresse.

## Einstellungen im Überblick

Unter [Verwaltung → Einstellungen](/einstellungen) hat jeder Bereich eine eigene Seite mit einer Speichern-Leiste („Ungespeicherte Änderungen · Verwerfen · Speichern“); wer die Seite mit offenen Änderungen verlässt, wird gefragt. **Einstellung finden** über der Übersicht (und die Suche mit Strg K) springt direkt zum Feld. Jede Seite lässt sich mit „Einstellungen ansehen“ lesen; ändern lässt sich jedes Feld nur mit dem passenden Recht.

| Bereich | Inhalt | Recht zum Ändern |
|---|---|---|
| [Organisation](/einstellungen/organisation) | Instanzname, Organisation, Absendername (mit Vorschau, wo welcher erscheint), öffentliche Adresse, Zeitzone, Bundesland ([Stichwortverzeichnis](/hilfe/stichwoerter-regeln#stichwortverzeichnis-der-laender)), Sprache | Allgemeine Einstellungen ändern |
| [Datenschutz & Recht](/einstellungen/datenschutz) | Verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung und eigener Hinweis für Upload-Seite und Aushang, eigene [Datenschutzerklärung und Impressum](/hilfe/foto-link#datenschutzerklaerung-und-impressum) | Datenschutzeinstellungen ändern |
| [Löschfristen](/einstellungen/loeschfristen) | alle Fristen inkl. System- und Audit-Protokoll und IP-Adressen, Probelauf „Was würde gelöscht?“ ([Löschfristen](/hilfe/sicherheit#loeschfristen)) | Datenschutzeinstellungen ändern (gesperrte Dateien, Sicherheitsereignisse: Medieneinstellungen ändern) |
| [Medien & Upload](/einstellungen/medien) | Dateigröße, Dateitypen, Speicher, Upload-Links, Inhaltsprüfung, Gesichtsvorschläge | Medieneinstellungen ändern |
| [Redaktion & Freigabe](/einstellungen/redaktion) | Vier-Augen-Prinzip, Alternativtext-Pflicht, Presseantworten freigeben, Erinnerung vor Frist, Gültigkeit von Einladungen | Redaktionseinstellungen ändern (Einladungen: Sicherheitseinstellungen ändern) |
| [E-Mail & Push](/einstellungen/e-mail) | Versandweg SMTP oder Microsoft 365 mit Testmail, Push und E-Mail-Benachrichtigungen ([einrichten](/hilfe/benachrichtigungen#e-mail-und-push-einrichten)) | E-Mail-Versand und Push einstellen |
| [Sicherheit](/einstellungen/sicherheit) | Zwei-Faktor-Pflicht, Sitzungsdauer, Sperre nach Fehlversuchen, Passwortlänge, Sicherheitsmeldungen, interne Ziele | Sicherheitseinstellungen ändern |
| [Sicherung](/einstellungen/sicherung) | tägliche Sicherung, Sicherung außer Haus, Probe-Wiederherstellung ([Sicherung](/hilfe/sicherung)) | Sicherungen erstellen |
| [Updates & Wartung](/einstellungen/updates) | neue Versionen, Update vorbereiten, Zustand des Wartungsmodus ([Updates](/hilfe/updates)) | Updates installieren |
| [Workflows](/einstellungen/workflows) | Workflows global ein- und ausschalten, Läufe je Minute | Systemeinstellungen ändern |
| [System](/einstellungen/system) | parallele Hintergrundaufträge, Version und Systeminformationen, Verweis auf den Systemstatus | Systemeinstellungen ändern |

Frühere Adressen der einen Einstellungsseite (z. B. `/einstellungen#datenschutz`) leiten auf die passende Unterseite weiter. Die **persönliche Darstellung** (Farbschema, Animationen, kompakte Tabellen) steht unter **Mein Konto → Darstellung**; den **Wartungsmodus** schaltet man unter [Verwaltung → Systemstatus](/system#wartungsmodus).

## Organisation

Drei Namen für verschiedene Stellen – die Seite zeigt eine Vorschau, wo welcher erscheint:

| Feld | Erscheint |
|---|---|
| Organisation | Kopfzeile und Fenstertitel, Upload-Seite, Aushang, Warnentwurf (PDF); leer = Instanzname |
| Instanzname | Push-Mitteilungen, Kalender-Abo, Authenticator-App, Betreff der Sicherheitsmeldungen |
| Absendername | Name vor der Absenderadresse von Pressemitteilungen, Presseantworten und Warnmails; leer = Organisation |

## Zeitzone

Unter **Einstellungen → Organisation → Zeitzone** (Standard Europe/Berlin) wird festgelegt, in welcher Zeitzone BlaulichtCMS Zeiten anzeigt und Eingaben versteht: Datum und Uhrzeit in Listen, Verläufen und Dialogen, Eingabefelder (z. B. Frist, Ablauf eines Upload-Links, geplante Veröffentlichung), Kalender und Serientermine, Benachrichtigungen, Vorgangsnummern, Zeitpläne von Workflows und die Uhrzeit der täglichen Sicherung. Sommer- und Winterzeit werden automatisch berücksichtigt. Gespeichert werden Zeitpunkte zeitzonenneutral – ein Wechsel stellt deshalb auch ältere Einträge um; nach dem Speichern gilt die neue Zeitzone sofort.

## HTTPS

BlaulichtCMS selbst spricht HTTP auf Port 7310. Für den Betrieb gehört ein Reverse Proxy mit HTTPS davor (z. B. Caddy, nginx, Traefik, HAProxy). Die Anleitung steht in `docs/reverse-proxy.md` im Repository.
