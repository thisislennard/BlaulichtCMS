## Ersteinrichtung

Installiert wird am Docker-Host mit `sudo bash install.sh` (Ordner `/opt/apps/blaulichtcms`). Das Skript zeigt am Ende den **Einrichtungsschlüssel**; er steht auch im Container-Protokoll:

```
cd /opt/apps/blaulichtcms && docker compose logs blaulichtcms | grep Einrichtungsschlüssel
```

Dann `/einrichtung` öffnen und in zwei Schritten festlegen:

1. **Organisation**, **öffentliche Adresse** (HTTPS, hinter dem Reverse Proxy) und **Zeitzone**
2. Das erste Konto (Administration)

Die öffentliche Adresse steht in Einladungen, Upload-Links und QR-Codes. Später ändern geht unter **Einstellungen → Allgemein** – bereits gedruckte QR-Codes zeigen dann aber weiter auf die alte Adresse.

## Einstellungen im Überblick

| Bereich | Inhalt |
|---|---|
| Allgemein | Instanzname, Organisation, Bundesland ([Stichwortverzeichnis](/hilfe/stichwoerter-regeln#stichwortverzeichnis-der-laender)), Absender, öffentliche Adresse, Zeitzone |
| Redaktion | Vier-Augen-Prinzip, Gültigkeit von Einladungen, Aufbewahrung |
| Datenschutz | Verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung und eigener Hinweis für Upload-Seite und Aushang; eigene Texte für die öffentlichen Seiten [Datenschutzerklärung und Impressum](/hilfe/foto-link#datenschutzerklaerung-und-impressum) |
| Medien | Dateigröße, Dateien je Link und Sammlung, Speicher je Sammlung, Mindestspeicher |
| Sicherheit | Zwei-Faktor-Pflicht, Sitzungsdauer, Sperre nach Fehlversuchen, Passwortlänge, interne Ziele |
| Sicherung | Tägliche Sicherung, Uhrzeit, Anzahl |

## Zeitzone

Unter **Einstellungen → Allgemein → Zeitzone** (Standard Europe/Berlin) wird festgelegt, in welcher Zeitzone BlaulichtCMS Zeiten anzeigt und Eingaben versteht: Datum und Uhrzeit in Listen, Verläufen und Dialogen, Eingabefelder (z. B. Frist, Ablauf eines Upload-Links, geplante Veröffentlichung), Kalender und Serientermine, Benachrichtigungen, Vorgangsnummern, Zeitpläne von Workflows und die Uhrzeit der täglichen Sicherung. Sommer- und Winterzeit werden automatisch berücksichtigt. Gespeichert werden Zeitpunkte zeitzonenneutral – ein Wechsel stellt deshalb auch ältere Einträge um; nach dem Speichern gilt die neue Zeitzone sofort.

## HTTPS

BlaulichtCMS selbst spricht HTTP auf Port 7310. Für den Betrieb gehört ein Reverse Proxy mit HTTPS davor (z. B. Caddy, nginx, Traefik, HAProxy). Die Anleitung steht in `docs/reverse-proxy.md` im Repository.
