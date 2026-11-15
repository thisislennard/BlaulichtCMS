# Datenschutz: Grundlagen, Verarbeitungsverzeichnis und DSFA

Diese Seite beschreibt, welche personenbezogenen Daten BlaulichtCMS verarbeitet, und liefert **Vorlagen** für das
Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) und die Datenschutz-Folgenabschätzung (Art. 35 DSGVO).
Sie ist eine technische Zuarbeit, keine Rechtsberatung: Zweck, Rechtsgrundlage und Bewertung legt die verantwortliche
Stelle fest, am besten zusammen mit der oder dem Datenschutzbeauftragten. Felder in *[eckigen Klammern]* sind
auszufüllen.

Verwandte Dokumente: Löschfristen und Sicherungen in [betrieb.md](betrieb.md#löschung-und-sicherungen),
Protokollierung in [betrieb.md](betrieb.md#protokollierung-und-sicherheitsvorfälle), Zugriffsprotokolle des Proxys
in [reverse-proxy.md](reverse-proxy.md#zugriffsprotokolle-des-proxys-datenschutz), Hinweise zu Meta, WordPress-Hostern
und Mailservern in der Hilfe (Verbindungen, WordPress, Warnentwurf).

## Datenflüsse

```
Bürgerinnen/Bürger, Helfende ──Upload-Link/QR──▶ BlaulichtCMS (Quarantäne → Prüfung → Sichtung)
                                                   │
Redaktion (Konten) ──Beitrag, Fassung, Freigabe────┤
                                                   ├──▶ WordPress (BlaulichtCMS Bridge, ruft selbst ab) ──▶ öffentlich
                                                   ├──▶ Facebook-Seite / Instagram (Meta, auch USA) ──▶ öffentlich
FE2 (Einsatzdaten, Allowlist) ──HTTP──────────────▶│
Warnfeeds (amtliche Warnungen) ◀──Abruf────────────┤
                                                   └──▶ Mailserver (Warnentwurf an zuständige Stellen)
```

- **Upload:** Datei, Dateiname, optionaler Hinweis, Vorgangsnummer, IP-Adresse (Audit, nach 30 Tagen entfernt). Die
  öffentliche Fassung ist ohne Standort- und Kameradaten; Originale werden standardmäßig ebenfalls bereinigt
  (`media.strip_location`).
- **Veröffentlichung:** Nur freigegebene Fassungen und öffentliche Fassungen der Dateien (neutral benannt) verlassen
  BlaulichtCMS. Keine Originale, keine Uploader-Hinweise.
- **Warnentwurf:** Rückrufkontakt (Name, Telefon), bestätigende/freigebende Personen, Empfängeradressen, PDF.
- **Betrieb:** Konten, Sitzungen (IP, Browser), Audit, Systemprotokoll, Sicherungen.

## Datenkategorien je Bereich

| Bereich (Tabellen) | Betroffene | Daten | Löschfrist (Standard) | Einstellung |
|---|---|---|---|---|
| Uploads (`media`, `upload_sessions`) | Hochladende, abgebildete Personen | Fotos/Videos (ggf. Gesundheitsdaten, Kennzeichen, Minderjährige), Dateiname, Hinweis, Vorgangsnummer, Aufnahmezeit, Prüfsumme; von der Redaktion ergänzt: Anzeigename, Beschreibung, interne Notiz (Teil der Datenschutzsuche, beim Pseudonymisieren geleert) | abgeschlossene Sammlung **365 Tage** nach letzter Aktivität; gelöschte/abgewiesene Datensätze **30 Tage**; unterbrochene Uploads bis Ablauf der Sitzung | `privacy.collection_retention_days`, `privacy.deleted_media_days` |
| Upload-Links (`upload_links`, `legacy_links`) | Redaktion (Bezeichnung, Begrüßungstext) | Token (verschlüsselt; mit „Link nur einmal anzeigen“ nur als Prüfsumme), Bezeichnung, Begrüßungstext, Frist | **90 Tage** nach Ablauf/Widerruf | `privacy.upload_link_days` |
| Beiträge (`posts`, `post_revisions`, `approvals`, `publications`, `social_publications`) | Redaktion, im Text genannte Personen, Abgebildete | Texte, Fassungen, Freigaben, Veröffentlichungsstatus | keine automatische Löschung (redaktionelles Archiv); von Hand bearbeiten/zurückziehen | – |
| Warnvorgänge (`warnings`, `warning_revisions`, `warning_approvals`, `warning_sends`) | Rückrufkontakte, Redaktion, Empfänger | Name, Telefon, E-Mail-Adressen, PDF, SMTP-Antworten | **365 Tage** nach dem letzten Bearbeitungsschritt | `privacy.warning_days` |
| Zuständigkeiten (`responsibilities`) | Ansprechstellen | Funktionsadressen | solange gepflegt | – |
| FE2 (`fe2_events`) | ggf. Betroffene eines Einsatzes (indirekt über Ort/Zeit) | Stichwort, Ort, Zeit, Einheiten (Allowlist, keine Alarmtexte) | **90 Tage** | `privacy.fe2_event_days` |
| Amtliche Warnungen (`official_warnings`) | – | keine personenbezogenen Daten | **90 Tage** nach Ablauf und nachdem die Quelle sie nicht mehr liefert | `privacy.official_warning_days` |
| Konten (`users`, `sessions`, `invitations`, `trusted_devices`) | Redaktion, Administration | Name, E-Mail, Rollen, Passwort-Hash, TOTP (verschlüsselt), letzte Anmeldung, Sitzungen mit IP und Browser, gemerkte Geräte der Zwei-Faktor-Anmeldung (Browser-Kennung, Zeitpunkte, Hash der Gerätekennung, keine IP) | Konto bis zur Löschung; Sitzungen und gemerkte Geräte 7 Tage nach Ende bzw. Ablauf; Einladungen 30 Tage nach Ablauf | `security.remember_days`, `security.mfa_remember_days` |
| Audit (`audit_events`) | alle Handelnden, Hochladende (IP) | Name, E-Mail, Aktion, Objekt, IP | **365 Tage**; IP ohne Konto **30 Tage** | `retention.audit_days`, `privacy.upload_ip_retention_days` |
| Systemprotokoll (`app_logs`) | Handelnde (selten) | technische Meldungen | **30 Tage** | `retention.log_days` |
| Benachrichtigungen | Empfänger | Text, Link | 60 Tage | – |
| Sicherungen (Volume, Datenbank) | alle | Kopie aller Daten | rund **4 Monate** (siehe [Löschung und Sicherungen](betrieb.md#löschung-und-sicherungen)) | Host-Cron, *Einstellungen → Sicherung* |
| Zugriffsprotokoll des Proxys | alle Aufrufenden | IP, Adresse (ggf. Token), Browser | abschalten bzw. **7 Tage** | am Proxy |

**Cookies** (nur technisch notwendig, keine Einwilligung nötig, aber in der Datenschutzerklärung zu nennen):
Sitzungs-Cookie (`__Host-bc_session` bzw. `bc_session`, bis zum Abmelden bzw. Sitzungsende – höchstens 12 Stunden,
mit „Angemeldet bleiben“ 30 Tage nach der letzten Nutzung, einstellbar) und Geräte-Cookie `__Host-bc_device` bzw.
`bc_device` (180 Tage, signiert; nimmt ein bekanntes Gerät von der Kontosperre nach Fehlversuchen aus und bindet
gemerkte Sitzungen und gemerkte Geräte der Zwei-Faktor-Anmeldung an diesen Browser). Die
öffentliche Upload-Seite setzt kein Cookie für Hochladende. Kein Tracking, keine externen Schriften oder Skripte.

Das Audit enthält keine Empfängeradressen von Warnversänden und Zuständigkeiten, sondern nur Anzahl, Namen der
Zuständigkeiten, Domains und die Zahl hinzugefügter bzw. entfernter Adressen (#185). Die Adressen selbst stehen in der
Zuständigkeit und im Versandnachweis (`warning_sends`) und fallen dort mit `privacy.warning_days` weg. Einträge aus der
Zeit davor bleiben unverändert (das Audit ist versiegelt und unveränderlich) und entfallen mit `retention.audit_days`.

Die Löschfristen wendet der Worker stündlich an; *Einstellungen → Datenschutz → „Was würde gelöscht?“* zeigt vorab,
was fällig ist. Jeder Lauf steht im Audit (`retention.run`).

## Empfänger

| Empfänger | Was | Rolle | Zu prüfen |
|---|---|---|---|
| Öffentlichkeit (Website) | freigegebene Beiträge, öffentliche Fassungen | – | Einwilligung/Interessenabwägung für Abgebildete |
| WordPress-Hoster *[Name]* | dasselbe | Auftragsverarbeiter | AV-Vertrag (Art. 28), Standort, Unterauftragnehmer |
| Meta Platforms Ireland / Meta Platforms Inc. (USA) | freigegebene Beiträge und Dateien für Facebook/Instagram | eigener Verantwortlicher; für Seiten-Insights gemeinsame Verantwortung (Art. 26) | Seiten-Insights-Ergänzung, Drittlandübermittlung (EU-US Data Privacy Framework), Datenschutzerklärung der Seite |
| Mailserver/Provider *[Name]* | Warnmails mit PDF, Benachrichtigungen | Auftragsverarbeiter (falls extern) | AV-Vertrag |
| Zuständige Stellen (Warnempfänger) | Warnentwurf, PDF, Rückrufkontakt | eigene Verantwortliche | Übermittlungsgrundlage |
| Hosting des Docker-Hosts *[Name]* | alle Daten (verschlüsselte Sicherungen getrennt) | Auftragsverarbeiter (falls extern) | AV-Vertrag, TOMs |
| Zentrale Protokollierung (optional, `AUDIT_FORWARD`) | Audit-Einträge | intern bzw. Auftragsverarbeiter | Frist und Zugriff dort |

## Rechtsgrundlagen (Vorschlag zur Prüfung)

| Verarbeitung | mögliche Grundlage |
|---|---|
| Öffentlichkeitsarbeit/Krisenkommunikation einer öffentlichen Stelle | Art. 6 Abs. 1 lit. e DSGVO i. V. m. *[Landesrecht, z. B. Brandschutz-/Katastrophenschutzgesetz, Kommunalrecht]* |
| Hochladen durch Bürgerinnen und Bürger | freiwillig; Einwilligung (Art. 6 Abs. 1 lit. a) bzw. lit. e – *[festlegen]*; die Upload-Seite informiert nach Art. 13 (*Einstellungen → Datenschutz*) |
| Veröffentlichung von Fotos mit erkennbaren Personen | Einwilligung bzw. KUG/Art. 85 DSGVO i. V. m. *[Landespresse-/Datenschutzgesetz]*; bei Verletzten (Gesundheitsdaten, Art. 9) nur mit ausdrücklicher Einwilligung |
| Warnentwurf an zuständige Stellen | Art. 6 Abs. 1 lit. c/e i. V. m. *[Fachrecht]* |
| Konten, Audit, Sicherheit | Art. 6 Abs. 1 lit. c/e (Art. 32 DSGVO), Beschäftigtendaten nach *[Landes-/Bundesrecht]* |

## Betroffenenrechte

- **Information (Art. 13):** Abschnitt „Datenschutz“ auf der Upload-Seite, Zeile auf dem Aushang; Angaben unter
  *Einstellungen → Datenschutz*. Die Datenschutzerklärung der Website muss Upload, Veröffentlichung, Meta und
  Cookies abdecken.
- **Auskunft und Löschung (Art. 15, 17):** *Verwaltung → Datenschutzanfragen* (Recht „Datenschutzanfragen
  bearbeiten“): Suche nach Name, E-Mail, Telefon, Dateiname, Hinweistext, Vorgangsnummer oder IP über alle Bereiche,
  Export als ZIP, Löschen/Pseudonymisieren je Treffer. Hochladende erhalten nach dem Upload eine Vorgangsnummer.
- **Grenzen:** Audit-Einträge bleiben bis zur Audit-Frist unverändert (Nachweispflicht, Art. 17 Abs. 3 lit. b/e;
  die Hash-Kette verbietet Änderungen), IP-Adressen ohne Konto werden nach 30 Tagen entfernt. Gelöschte Daten bleiben
  bis zu rund 4 Monate in Sicherungen; nach einer Wiederherstellung Löschungen nachholen
  ([Löschung und Sicherungen](betrieb.md#löschung-und-sicherungen)). Veröffentlichte Inhalte über „Zurückziehen“ bzw.
  „Von sozialen Kanälen entfernen“ entfernen; Kopien bei Dritten sind nicht erreichbar.

## Technische und organisatorische Maßnahmen (Art. 32)

Umgesetzt in BlaulichtCMS (Bezug zu BSI IT-Grundschutz in Klammern, Einzelheiten in der Hilfe → Sicherheit und in
[betrieb.md](betrieb.md)):

| Ziel | Maßnahme |
|---|---|
| Zugangskontrolle (ORP.4) | Passwörter mit Argon2id, Zwei-Faktor (Pflicht für Administration und „Medien verwalten“), Sperre nach Fehlversuchen ohne gezieltes Aussperren, erneute Bestätigung bei kritischen Änderungen, Sitzungsdauer begrenzt |
| Zugriffskontrolle (ORP.4, APP.3.1) | Rollen und Rechte serverseitig je Aktion und Datei; Originale nur mit „Medien verwalten“; Upload-Links befristet, pausier- und widerrufbar, neu erzeugbar, auf eine Sammlung beschränkt; einheitliche Meldung für unbekannte, abgelaufene, pausierte und widerrufene Links |
| Datenminimierung (CON.2) | Standort-/Kameradaten aus öffentlichen Fassungen und Originalen entfernt; neutrale Dateinamen nach außen; FE2-Allowlist; IP ohne Konto nach 30 Tagen entfernt; Hinweisfeld fragt nicht nach Namen; Markierung und Unkenntlichmachen sensibler Inhalte vor der Freigabe |
| Speicherbegrenzung (CON.6) | Löschfristen je Datenart mit Probelauf und Audit; „Sammlung löschen“; Auskunft/Löschung je Person |
| Vertraulichkeit (CON.1) | Geheimnisse und TOTP mit AES-256-GCM, Master-Schlüssel außerhalb der Datenbank und wechselbar (`rotate-master-key`); Sicherungen verschlüsselt mit getrenntem Schlüssel; HTTPS am Proxy, HSTS |
| Integrität und Nachweis (OPS.1.1.5) | Audit als versiegelte Hash-Kette mit täglicher Prüfung, optional zentrale Weiterleitung; Freigabe gilt für genau eine Fassung (Prüfsumme) |
| Schutz vor Schadsoftware (OPS.1.1.4) | Quarantäne, Prüfung nach Inhalt, optional ClamAV vor jeder Verarbeitung |
| Härtung (SYS.1.6, APP.4.4) | Container ohne Root und Capabilities, schreibgeschütztes Dateisystem, Ressourcengrenzen, getrennte Datenbankrollen ohne Superuser, Content-Security-Policy, fixierte Basis-Images, Schwachstellenprüfung in der CI |
| Verfügbarkeit (CON.3, DER.4) | tägliche verschlüsselte Sicherungen, Prüfung der Wiederherstellung, Rückweg bei Updates |
| Erkennung (DER.1) | Sicherheitsmeldungen an die Administration und Betroffene |

Organisatorisch *[zu ergänzen]*: Rollenkonzept und Vergabe, Schulung der Redaktion (Persönlichkeitsrechte,
Gesundheitsdaten, Minderjährige), Prozess für Widersprüche Abgebildeter, Verantwortliche für Datenschutzanfragen,
Meldeweg bei Datenpannen (Art. 33/34, [betrieb.md](betrieb.md#protokollierung-und-sicherheitsvorfälle)).

## Vorlage: Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 1)

| Feld | Eintrag |
|---|---|
| Bezeichnung | Öffentlichkeitsarbeit und Krisenkommunikation mit BlaulichtCMS (Foto-Links, Redaktion, Veröffentlichung, Warnentwurf) |
| Verantwortlicher | *[Name, Anschrift, Kontakt]* |
| Datenschutzbeauftragte/r | *[Kontakt]* |
| Zwecke | Sammeln von Fotos/Videos zu Einsätzen und Veranstaltungen; Erstellen, Freigeben und Veröffentlichen von Beiträgen auf Website und sozialen Medien; Entwürfe für Warnungen an zuständige Stellen; Nachvollziehbarkeit und Sicherheit |
| Kategorien betroffener Personen | Hochladende; abgebildete Personen (auch Unbeteiligte, Verletzte, Minderjährige möglich); Redaktion und Administration; Rückrufkontakte; Empfänger von Warnungen; Aufrufende der Upload-Seite |
| Kategorien personenbezogener Daten | siehe [Datenkategorien je Bereich](#datenkategorien-je-bereich); ggf. besondere Kategorien (Gesundheit auf Fotos, Art. 9) |
| Empfänger | siehe [Empfänger](#empfänger) |
| Drittlandübermittlung | Meta Platforms Inc. (USA) bei Facebook/Instagram; Grundlage: *[z. B. Angemessenheitsbeschluss EU-US Data Privacy Framework]*; ggf. Hoster *[…]* |
| Löschfristen | siehe Tabelle oben; Sicherungen rund 4 Monate |
| TOMs | siehe [Technische und organisatorische Maßnahmen](#technische-und-organisatorische-maßnahmen-art-32) |
| Rechtsgrundlagen | *[aus der Tabelle „Rechtsgrundlagen“ festlegen]* |
| DSFA | *[Ergebnis der Schwellwertanalyse, Datum]* |

## DSFA: Schwellwertanalyse und Empfehlung

Eine Datenschutz-Folgenabschätzung ist nötig, wenn eine Verarbeitung voraussichtlich ein hohes Risiko hat
(Art. 35 Abs. 1). Kriterien nach den Leitlinien des Europäischen Datenschutzausschusses (WP 248) und der
DSK-Muss-Liste – zutreffend bei BlaulichtCMS:

| Kriterium | Bei BlaulichtCMS | Bewertung |
|---|---|---|
| Sensible Daten / Art. 9 | Fotos von Einsätzen können Verletzte oder Gesundheitsdaten zeigen | **zutreffend** (möglich) |
| Daten schutzbedürftiger Personen | Minderjährige, Verletzte, Personen in Notlagen auf Fotos | **zutreffend** |
| Veröffentlichung / Übermittlung an Dritte und Drittland | Website und Meta (USA) | **zutreffend** |
| Datenerhebung bei Dritten ohne deren Wissen | Abgebildete wissen oft nicht vom Upload | **zutreffend** |
| Umfangreiche Verarbeitung | abhängig vom Einsatzgebiet *[bewerten]* | offen |
| Systematische Überwachung, Profiling, automatisierte Entscheidungen | nein | nicht zutreffend |
| Neue Technologien | nein (übliche Web-Anwendung) | nicht zutreffend |

**Empfehlung:** Bei zwei oder mehr zutreffenden Kriterien ist eine DSFA in der Regel durchzuführen. Für BlaulichtCMS
treffen mehrere Kriterien zu – eine **DSFA wird empfohlen**, mindestens für die Veröffentlichung von Bürgerfotos in
sozialen Medien. Grundlage dafür sind die Abschnitte dieser Seite.

### Gliederung der DSFA (Vorlage)

1. **Beschreibung der Verarbeitung:** Datenflüsse, Datenkategorien, Empfänger, Fristen (siehe oben).
2. **Notwendigkeit und Verhältnismäßigkeit:** Zweck, Rechtsgrundlage, Datenminimierung (Standortbereinigung,
   neutrale Namen, Allowlist), Speicherbegrenzung (Löschfristen), Information (Art. 13), Betroffenenrechte.
3. **Risiken für Betroffene** *[bewerten: Eintrittswahrscheinlichkeit × Schwere]*:
   - Veröffentlichung von Verletzten oder Unbeteiligten ohne Einwilligung → Bloßstellung, Persönlichkeitsrecht
   - Standort auf Originalen → Wohnort/Bewegungsprofil der Hochladenden
   - Weiterverbreitung bei Meta und Dritten, Drittlandzugriff
   - unbefugter Zugriff auf ungesichtete Uploads oder Warnvorgänge
   - zu lange Speicherung
4. **Abhilfemaßnahmen:** Sichtung vor jeder Verwendung, Markierung sensibler Inhalte mit Prüfung vor der Freigabe,
   Unkenntlichmachen und Zuschnitt, Vier-Augen-Freigabe (`editorial.four_eyes`), Standortbereinigung, Rechte und
   Zwei-Faktor, Löschfristen, Zurückziehen von Website und sozialen Kanälen, Schulung *[…]*.
5. **Restrisiko und Ergebnis:** *[Bewertung, Freigabe durch Verantwortliche, Stellungnahme der/des DSB, Datum,
   Überprüfung z. B. jährlich oder bei wesentlichen Änderungen]*.
