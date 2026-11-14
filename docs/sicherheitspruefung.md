# Sicherheitsprüfung (Meilenstein 4)

Stand 14.11.2026. Geprüft wurde der Code-Stand auf Grundlage von OWASP ASVS (Auswahl) und dem
OWASP File Upload Cheat Sheet. Jeder Punkt ist mit einem Test oder einer Code-Stelle belegt.

## Ergebnis

| Bereich | Ergebnis | Nachweis |
|---|---|---|
| Sitzungen | ✅ Cookie `HttpOnly`, `SameSite=Strict`, `Secure` (hinter HTTPS), `__Host-`-Präfix; Leerlauf- und Höchstdauer | `server/src/auth/context.ts` |
| CSRF | ✅ Jede ändernde Anfrage braucht den Header `x-lifelink-request` (Sitzungen); Bridge, FE2 und Meta-Rückweg authentisieren eigenständig | Test „Erstsetup“ (Anfrage ohne Kennung → 403) |
| Rechte je Aktion | ✅ Standard „verweigern“, jedes Recht serverseitig je Route; getrennte Rechte für Entwurf/Stufe/Freigabe/Versand und Verbindungen | Tests M1–M4 (403-Fälle) |
| Vier-Augen | ✅ Regeln und Lagefragen nur durch eine andere Person freigebbar; optional für Beiträge | Tests M3 |
| Zwei-Faktor | ✅ Für Administration Pflicht (Einstellung), TOTP mit Wiederherstellungscodes | Abnahme M1 |
| Login-Missbrauch | ✅ Sperre nach Fehlversuchen, Rate-Limits auf Anmeldung, Einladung, öffentliche Uploads, FE2, Medien-URLs, OAuth | Test „sperrt nach zu vielen Fehlversuchen“ |
| Passwörter | ✅ Argon2id, Mindestlänge, keine trivialen Bestandteile | `server/src/auth/passwords.ts` |
| Upload: Typ | ✅ Typ nach Inhalt (Magic Bytes), nicht nach Endung; Bilder werden dekodiert, Videos per ffprobe geprüft | Test „weist falsche Dateitypen ab“ |
| Upload: Ablage | ✅ Private Ablage außerhalb des Webroots, Quarantäne bis zur Prüfung, Auslieferung nur über geprüfte Routen mit festem Typ, `nosniff`, `Content-Disposition` | `server/src/routes/files.ts` |
| Upload: Metadaten | ✅ Öffentliche Fassung ohne EXIF/GPS; **Befund behoben:** Videos übernahmen alle Spuren (inkl. Datenspuren wie GPS-Telemetrie) – jetzt nur Bild und Ton | Test „öffentliche Videofassung enthält nur Bild und Ton“ |
| Ressourcen | ✅ Pixel-Limit (40 MP), **Befund behoben:** Videolänge (Standard 30 min) und -auflösung (8K) begrenzt; Dateigröße, Dateien je Link und Sammlung, parallele Verarbeitung | Test „zu lange Videos werden abgewiesen“ |
| SSRF | ✅ Eigene DNS-Auflösung, private/reservierte Netze gesperrt, IP festgenagelt, Redirects geprüft; interne Ziele nur nach ausdrücklicher Freigabe durch die Plattform-Administration | Test „Warnfeed: privates Ziel nur nach Freigabe“ |
| Geheimnisse | ✅ AES-256-GCM mit Master-Schlüssel unter `/data/secrets`, versioniert, widerrufbar; nie in API-Antworten, Protokollen oder Audit; Fehlertexte werden bereinigt | Tests „Geheimnisse erscheinen nie …“, „Widerruf löscht Zugangsdaten“ |
| OAuth | ✅ **Befund behoben:** Rückweg von Meta kam ohne Sitzungs-Cookie an (SameSite=Strict). Jetzt einmaliger, befristeter `state`, an Verbindung und Person gebunden; Recht wird erneut geprüft | Test „OAuth-Rückweg funktioniert ohne Sitzungs-Cookie“ |
| FE2 | ✅ Eigener Zugangsschlüssel (nur als Prüfsumme gespeichert, rotierbar), Allowlist der Felder, keine Inhalte in Protokollen | Tests FE2 |
| Bridge-Updates | ✅ Signierte, kurzlebige Download-Links; Paket wird in WordPress gegen SHA-256 geprüft; neue Versionen zuerst im Test-Kanal | Test „Bridge-Updates“ |
| Kopfzeilen | ✅ CSP, `frame-ancestors 'none'`, HSTS (hinter HTTPS), `Referrer-Policy`, `nosniff` | `server/src/app.ts` (helmet) |
| Repository | ✅ Keine Zugangsdaten, keine produktiven Daten; Beispieldaten fiktiv; `.env` und `data/` ignoriert | Secret-Scan (siehe unten) |

## Lasttest

Abnahme M4: 90 Fotos (2400 × 1600, je ca. 2 MB) und 3 Full-HD-Videos über den öffentlichen Upload in rund 2 Minuten
inklusive Prüfung; Sicherung, Wiederherstellung und Prüfsummenabgleich der Originale ohne Fehler. Parallel-Uploads
im Browser sind auf zwei gleichzeitige Übertragungen je Gerät begrenzt.

## Offen

- Externer Penetrationstest vor dem Produktivbetrieb
- Lasttest auf der Zielhardware mit realen Fotos/Videos und mehreren gleichzeitigen Geräten
- Regelmäßige Abhängigkeitsprüfung (`npm audit`) im Betrieb festlegen
