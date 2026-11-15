# Sicherheitsprüfung (Meilenstein 4)

Stand 14.11.2026. Geprüft wurde der Code-Stand auf Grundlage von OWASP ASVS (Auswahl) und dem
OWASP File Upload Cheat Sheet. Jeder Punkt ist mit einem Test oder einer Code-Stelle belegt.

## Ergebnis

| Bereich | Ergebnis | Nachweis |
|---|---|---|
| Sitzungen | ✅ Cookie `HttpOnly`, `SameSite=Strict`, `Secure` (hinter HTTPS), `__Host-`-Präfix; Leerlauf- und Höchstdauer; Token nur als SHA-256 gespeichert und beim Übergang Zwischenstufe → volle Sitzung neu ausgestellt. „Angemeldet bleiben“ und gemerkte Geräte siehe Abwägung unten | `server/src/auth/context.ts`, `server/src/auth/devices.ts`, Test „Angemeldet bleiben und gemerkte Geräte …“ |
| CSRF | ✅ Jede ändernde Anfrage braucht den Header `x-blaulichtcms-request` (Sitzungen); Bridge, FE2 und Meta-Rückweg authentisieren eigenständig | Test „Erstsetup“ (Anfrage ohne Kennung → 403) |
| Rechte je Aktion | ✅ Standard „verweigern“, jedes Recht serverseitig je Route; getrennte Rechte für Entwurf/Stufe/Freigabe/Versand und Verbindungen | Tests M1–M4 (403-Fälle) |
| Vier-Augen | ✅ Regeln und Lagefragen nur durch eine andere Person freigebbar; optional (`editorial.four_eyes`) für Beiträge, Banner und Warnentwürfe – jeweils weder durch Schreibende noch durch die einreichende Person (#153, #169) | Tests M3 |
| Zwei-Faktor | ✅ Für Administration Pflicht (Einstellung), TOTP mit Wiederherstellungscodes (80 Bit, gespeichert als HMAC mit abgeleitetem Schlüssel und Konto als Salz; frühere 40-Bit-Codes gelten bis zum Verbrauch bzw. zur Erneuerung) | Abnahme M1 |
| Login-Missbrauch | ✅ Sperre nach Fehlversuchen, Rate-Limits auf Anmeldung, Einladung, öffentliche Uploads, FE2, Medien-URLs, OAuth | Test „sperrt nach zu vielen Fehlversuchen“ |
| Passwörter | ✅ Argon2id nach RFC 9106 (m = 64 MiB, t = 3, p = 4; ältere Hashes werden bei der Anmeldung erneuert), Mindestlänge, Sperrliste häufiger Passwörter (SecLists, deutsch/englisch, auch mit angehängten Zahlen/Zeichen und Leetspeak; ohne Netzabruf), keine eigenen Namen/Adressen | `server/src/auth/passwords.ts` |
| Upload: Typ | ✅ Typ nach Inhalt (Magic Bytes), nicht nach Endung; Bilder werden dekodiert, Videos per ffprobe geprüft | Test „weist falsche Dateitypen ab“ |
| Upload: Ablage | ✅ Private Ablage außerhalb des Webroots, Quarantäne bis zur Prüfung, Auslieferung nur über geprüfte Routen mit festem Typ, `nosniff`, `Content-Disposition` | `server/src/routes/files.ts` |
| Upload: Metadaten | ✅ Öffentliche Fassung ohne EXIF/GPS; **Befund behoben:** Videos übernahmen alle Spuren (inkl. Datenspuren wie GPS-Telemetrie) – jetzt nur Bild und Ton | Test „öffentliche Videofassung enthält nur Bild und Ton“ |
| Ressourcen | ✅ Pixel-Limit (40 MP), **Befund behoben:** Videolänge (Standard 30 min) und -auflösung (8K, jede Videospur geprüft; Vorschau und öffentliche Fassung nur aus der ersten Videospur und der ersten Tonspur, #150) begrenzt; Dateigröße, Dateien je Link und Sammlung, parallele Verarbeitung | Test „zu lange Videos werden abgewiesen“ |
| SSRF | ✅ Eigene DNS-Auflösung, private/reservierte Netze gesperrt, IP festgenagelt, Redirects geprüft; interne Ziele nur nach ausdrücklicher Freigabe durch die Plattform-Administration | Test „Warnfeed: privates Ziel nur nach Freigabe“ |
| Geheimnisse | ✅ AES-256-GCM mit Master-Schlüssel unter `/data/secrets`, versioniert, widerrufbar; nie in API-Antworten, Protokollen oder Audit; Fehlertexte werden bereinigt | Tests „Geheimnisse erscheinen nie …“, „Widerruf löscht Zugangsdaten“ |
| OAuth | ✅ **Befund behoben:** Rückweg von Meta kam ohne Sitzungs-Cookie an (SameSite=Strict). Jetzt einmaliger, befristeter `state`, an Verbindung und Person gebunden; Recht wird erneut geprüft | Test „OAuth-Rückweg funktioniert ohne Sitzungs-Cookie“ |
| FE2 | ✅ Eigener Zugangsschlüssel (nur als Prüfsumme gespeichert, rotierbar), Allowlist der Felder, keine Inhalte in Protokollen | Tests FE2 |
| Bridge-Updates | ✅ Signierte, kurzlebige Download-Links; Paket wird in WordPress gegen SHA-256 geprüft; neue Versionen zuerst im Test-Kanal. Code-Signatur (Ed25519, privater Schlüssel offline, öffentlicher fest in der Bridge) ab 0.6.0 – wirksam, sobald der Betreiber den Schlüssel erzeugt hat; Restrisiko in `docs/bridge-signatur.md` | Test „Bridge-Updates“, Unit-Test „Code-Signatur der Bridge“ |
| Kopfzeilen | ✅ CSP ohne `'unsafe-inline'` für Skripte und Stylesheets, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Permissions-Policy` (Kamera, Mikrofon, Standort, Zahlung, USB u. a. aus), HSTS (hinter HTTPS, über `HSTS_*` einstellbar), `Referrer-Policy: no-referrer`, `nosniff`, COOP/CORP `same-origin` | `server/src/app.ts` (helmet), Test „Sicherheits-Kopfzeilen“ |
| Audit | ✅ Hash-Kette mit HMAC (Schlüssel durch den Master-Schlüssel geschützt), Trigger gegen Ändern/Löschen, tägliche Prüfung mit Benachrichtigung, optionale Weiterleitung an stdout/Syslog; verweigerte Zugriffe und falsche Schlüssel gedrosselt auditiert | Tests „Audit: Hash-Kette …“, „Audit-Lücken …“ |
| Repository | ✅ Keine Zugangsdaten, keine produktiven Daten; Beispieldaten fiktiv; `.env` und `data/` ignoriert | Secret-Scan (Trivy) bei jedem Push, Workflow „Sicherheitsprüfung“ |
| Lieferkette | ✅ Basis-Images per Digest, GitHub Actions per Commit-SHA fixiert; Dependabot für npm, Docker und Actions; `npm audit` (Laufzeit ab „hoch“, alles ab „kritisch“) und Trivy-Imagescan (kritische behebbare Lücken brechen ab) bei jedem Push und wöchentlich; Updates nur über Release-Tags (optional signiert) | `.github/workflows/security.yml`, `.github/dependabot.yml`, `docs/betrieb.md` |

### Angemeldet bleiben und gemerkte Geräte: Abwägung

Die installierte App soll im Einsatz ohne tägliche Neuanmeldung bereitstehen. Dafür gibt es zwei abschaltbare
Erleichterungen (Einstellungen → Sicherheit, Standard an, für alle Rollen):

- **Angemeldet bleiben:** keine Leerlaufabmeldung, Ablauf nach `security.remember_days` (Standard 30, höchstens 180)
  Tagen ohne Nutzung, gleitend erneuert; Cookie-Laufzeit gleich der Restlaufzeit.
- **Zwei-Faktor auf diesem Gerät merken:** nach einem Code aus der App fragt die Anmeldung auf diesem Gerät
  `security.mfa_remember_days` (Standard 30, höchstens 90) Tage lang nur das Passwort.

**Risiko:** Ein langlebiges Sitzungs-Cookie oder ein gemerktes Gerät verlängert das Zeitfenster, in dem ein
entwendetes Gerät oder Cookie nutzbar ist; ein gemerktes Gerät reduziert die Anmeldung dort auf einen Faktor.

**Gegenmaßnahmen:**

- *Gerätebindung:* Beides gilt nur zusammen mit dem signierten, `HttpOnly`-Geräte-Cookie desselben Browsers
  (HMAC mit einem aus dem Master-Schlüssel abgeleiteten Schlüssel, Vergleich in konstanter Zeit). Ein kopiertes
  Sitzungs-Cookie allein wird abgewiesen und beendet die Sitzung. Gespeichert werden nur Hashes von Token und
  Gerätekennung; ein Merker im Browser allein genügt nie.
- *Step-up:* Kritische Aktionen (Admin-Rechte, Zwei-Faktor-Reset, Passwort-Links für Admins, Sicherheitseinstellungen,
  Updates, Zwei-Faktor einrichten) verlangen unverändert Passwort und Code, höchstens 10 Minuten alt – eine lange
  Sitzung oder ein gemerktes Gerät genügt dafür nie.
- *Nur App-Codes:* Ein Wiederherstellungscode (Hinweis auf verlorenes Telefon) merkt kein Gerät.
- *Widerruf:* Passwortänderung, Zwei-Faktor einrichten/abschalten/zurücksetzen, „Auf allen Geräten abmelden“ (selbst
  oder durch die Benutzerverwaltung), Deaktivieren, Passwort-Link, Master-Schlüsselwechsel, Ablauf. Jede Sitzung und
  jedes gemerkte Gerät ist im Profil sichtbar und einzeln beendbar.
- *Schalter der Administration:* Abschalten wirkt sofort (bestehende gemerkte Sitzungen bzw. Geräte werden beendet,
  zusätzlich prüft jede Anfrage die Einstellung); verkürzte Fristen greifen beim nächsten Aufruf.
- *Nachvollziehbarkeit:* Audit-Einträge für Merken, Entfernen und Beenden, Anmeldungen ohne Code gekennzeichnet;
  die Person wird beim Merken eines Geräts benachrichtigt.
- *Keine Kontoaufzählung:* Die Anmeldeantwort bleibt für unbekannte Konten, falsche Passwörter und Sperren gleich;
  ein gemerktes Gerät ändert daran nichts, die Kontosperre je Gerät gilt weiter.

**Restrisiko:** Wer ein entsperrtes Gerät mit gemerkter Sitzung in die Hand bekommt, kann bis zur Abmeldung
nicht-kritische Aktionen ausführen. Für Geräte, die mehrere Personen nutzen, die Haken nicht setzen bzw. die
Funktionen abschalten oder die Fristen verkürzen; bei Verlust sofort „Auf allen Geräten abmelden“.

### Content-Security-Policy: Abwägung bei Styles

Stylesheets kommen nur als Dateien vom eigenen Server (`style-src 'self'`, `style-src-elem 'self'`); `<style>`-Elemente
gibt es in der Oberfläche nicht mehr. Erlaubt bleiben nur `style`-Attribute (`style-src-attr 'unsafe-inline'`): React
setzt darüber berechnete Werte wie Fortschrittsbreiten oder Positionen, und kleine Server-Seiten (abgelaufener Link)
nutzen sie. Ein `style`-Attribut kann keine Selektoren enthalten – die bekannte Datenausleitung per CSS
(Attributselektoren mit Hintergrundbild) ist damit nicht möglich, und Bilder dürfen ohnehin nur von `'self'`, `data:`
und `blob:` geladen werden. Nonces oder Hashes für jedes Attribut wären bei React nicht praktikabel. Browser ohne
`style-src-attr` (sehr alte Versionen) fallen auf `style-src 'self'` zurück und zeigen dann nur die Inline-Werte nicht.

## Lasttest

Abnahme M4: 90 Fotos (2400 × 1600, je ca. 2 MB) und 3 Full-HD-Videos über den öffentlichen Upload in rund 2 Minuten
inklusive Prüfung; Sicherung, Wiederherstellung und Prüfsummenabgleich der Originale ohne Fehler. Parallel-Uploads
im Browser sind auf zwei gleichzeitige Übertragungen je Gerät begrenzt.

## Offen

- Externer Penetrationstest vor dem Produktivbetrieb
- Lasttest auf der Zielhardware mit realen Fotos/Videos und mehreren gleichzeitigen Geräten
