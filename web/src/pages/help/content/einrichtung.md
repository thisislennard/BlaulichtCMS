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
| Allgemein | Instanzname, Organisation, Absender, öffentliche Adresse, Zeitzone |
| Redaktion | Vier-Augen-Prinzip, Gültigkeit von Einladungen, Aufbewahrung |
| Datenschutz | Verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung und eigener Hinweis für Upload-Seite und Aushang |
| Medien | Dateigröße, Dateien je Link und Sammlung, Speicher je Sammlung, Mindestspeicher |
| Sicherheit | Zwei-Faktor-Pflicht, Sitzungsdauer, Sperre nach Fehlversuchen, Passwortlänge |
| Sicherung | Tägliche Sicherung, Uhrzeit, Anzahl |

## HTTPS

BlaulichtCMS selbst spricht HTTP auf Port 7310. Für den Betrieb gehört ein Reverse Proxy mit HTTPS davor (z. B. Caddy, nginx, Traefik, HAProxy). Die Anleitung steht in `docs/reverse-proxy.md` im Repository.
