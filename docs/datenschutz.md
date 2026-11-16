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
Feuersoftware Connect (Einsätze) ◀──Abruf──────────┤
Warnfeeds (amtliche Warnungen) ◀──Abruf────────────┤
                                                   └──▶ Mailserver (Warnentwurf an zuständige Stellen)
```

- **Upload:** Datei, Dateiname, optionaler Hinweis, Vorgangsnummer, IP-Adresse (Audit, nach 30 Tagen entfernt). Die
  öffentliche Fassung ist ohne Standort- und Kameradaten; Originale werden standardmäßig ebenfalls bereinigt
  (`media.strip_location`).
- **Veröffentlichung:** Nur freigegebene Fassungen und öffentliche Fassungen der Dateien (neutral benannt) verlassen
  BlaulichtCMS. Keine Originale, keine Uploader-Hinweise.
- **Gesichtsvorschläge (#214):** Ein lokales Erkennungsmodell (YuNet, im Container, ohne Netzverbindung) sucht in
  geprüften Bildern nach Gesichtern, um sie zum **Unkenntlichmachen vorzuschlagen**. Gespeichert werden je Treffer nur
  Lage und Größe (Rechteck), die Sicherheit des Modells und die Entscheidung (offen, übernommen, verworfen) –
  **keine** Gesichtsmerkmale, keine Landmarken, kein Abgleich mit anderen Bildern, keine Identifizierung. Damit
  entstehen keine biometrischen Daten zur eindeutigen Identifizierung (Art. 4 Nr. 14, Art. 9 Abs. 1 DSGVO); die
  Verarbeitung dient dem Schutz der Abgebildeten. Unkenntlich wird nur, was ein Mensch übernimmt; offene Vorschläge
  verlangen bei der Freigabe die Datenschutz-Prüfung. Abschaltbar unter *Einstellungen → Medien*
  (`media.face_detect`).
- **Warnentwurf:** Rückrufkontakt (Name, Telefon), bestätigende/freigebende Personen, Empfängeradressen, PDF.
- **Warnvorgang löschen:** von Hand vor Ablauf der Frist möglich (Rechte nach Stand, versandte Vorgänge nur durch
  die Administration mit Begründung); gelöscht werden Fassungen mit Rückrufkontakt, Freigaben, PDF und
  Versandnachweise, das Audit behält nur Vorgangsnummer, Person und Begründung. Amtliche Warnungen werden nur
  ausgeblendet (keine personenbezogenen Daten) und nach der Frist gelöscht.
- **Verbindung löschen:** Zugangsdaten (alle Versionen) werden sofort gelöscht. Eine nie verwendete Verbindung
  verschwindet ganz; eine verwendete bleibt als „gelöscht“ markiert (ohne Zugangsdaten), damit der
  Veröffentlichungsverlauf nachvollziehbar bleibt.
- **Feuersoftware Connect (Quelle, optional):** BlaulichtCMS ruft beim Anbieter Feuersoftware die Einsätze des
  eigenen Standorts ab (HTTPS, API-Key verschlüsselt gespeichert). An Feuersoftware gehen dabei nur der Schlüssel und
  die Abfrage selbst. Von der Antwort bleiben nur die Felder der Allowlist; Lagemeldungen (Freitext, ggf.
  Gesundheitsdaten nach Art. 9 DSGVO) ruft BlaulichtCMS nicht ab. Für die Nutzung von Connect selbst gilt der Vertrag
  der Organisation mit Feuersoftware.
- **Betrieb:** Konten, Sitzungen (IP, Browser), Audit, Systemprotokoll, Sicherungen.

## Datenkategorien je Bereich

| Bereich (Tabellen) | Betroffene | Daten | Löschfrist (Standard) | Einstellung |
|---|---|---|---|---|
| Uploads (`media`, `upload_sessions`) | Hochladende, abgebildete Personen | Fotos/Videos (ggf. Gesundheitsdaten, Kennzeichen, Minderjährige), Dateiname, Hinweis, Vorgangsnummer, Aufnahmezeit, Prüfsumme; von der Redaktion ergänzt: Anzeigename, Beschreibung, interne Notiz (Teil der Datenschutzsuche, beim Pseudonymisieren geleert) | abgeschlossene Sammlung **365 Tage** nach letzter Aktivität; Papierkorb (Dateien samt Datensatz) und Datensätze abgewiesener Dateien **30 Tage**; unterbrochene Uploads bis Ablauf der Sitzung | `privacy.collection_retention_days`, `privacy.deleted_media_days` |
| Gesichtsvorschläge (`media.face_proposals`, `face_status`, `face_checked_at`, `face_model`, `face_error`) | abgebildete Personen | je gefundenem Gesicht Rechteck (normierte Lage und Größe), Sicherheit des Modells, Entscheidung; Stand und Zeitpunkt der Suche, Modellkennung – keine Merkmale, keine Identität | mit der Datei (Papierkorb, Löschfristen, Datenschutzanfragen) | `media.face_detect`, `media.face_threshold` |
| Gestaltung der Upload-Seite (`design_images`, `upload_links.design`, Einstellung `media.upload_design`) | ggf. auf Bildern Abgebildete | Bilder der Gestaltung (neu kodiert, ohne EXIF/GPS), Texte | bis zur Änderung; nicht verwendete Bilder nach 1 Tag | – |
| Sicherheitsereignisse der Upload-Seiten (`public_security_events`) | Aufrufende der Upload-Seiten | Ereignis (z. B. falsches Passwort, abgelaufener Link, Rate-Limit), Link, Zeit, gekürzter HMAC der IP-Adresse (keine Klar-IP, kein Token, keine Namen) | **365 Tage** | `media.security_log_days` |
| Angaben der Hochladenden (`media.uploader`, `upload_sessions.uploader`, `consent_at`) | Hochladende | Name, E-Mail-Adresse, Aufnahmeort, Aufnahmedatum (nur, wenn der Upload-Link sie abfragt; Standard: keins davon), Zeitpunkt der Bestätigung; sichtbar nur mit „Medien sichten und auswählen“, Teil der Datenschutzsuche, Auskunft und Pseudonymisierung | **12 Monate** nach dem Upload (Dateien bleiben); je Link „Angaben der Hochladenden löschen“ | `privacy.uploader_months` |
| Upload-Links (`upload_links`, `legacy_links`) | Redaktion (Bezeichnung, Begrüßungstext) | Token (verschlüsselt; mit „Link nur einmal anzeigen“ nur als Prüfsumme), Bezeichnung, Begrüßungstext, Frist, Grenzen, abgefragte Felder, Bestätigungstext, Passwort-Hash (Argon2id, optional) | **90 Tage** nach Ablauf/Widerruf | `privacy.upload_link_days` |
| Beiträge (`posts`, `post_revisions`, `approvals`, `publications`, `social_publications`) | Redaktion, im Text genannte Personen, Abgebildete | Texte, Fassungen, Freigaben, Veröffentlichungsstatus | keine automatische Löschung (redaktionelles Archiv); von Hand bearbeiten/zurückziehen | – |
| Warnvorgänge (`warnings`, `warning_revisions`, `warning_approvals`, `warning_sends`) | Rückrufkontakte, Redaktion, Empfänger | Name, Telefon, E-Mail-Adressen, PDF, SMTP-Antworten | **365 Tage** nach dem letzten Bearbeitungsschritt | `privacy.warning_days` |
| Zuständigkeiten (`responsibilities`) | Ansprechstellen | Funktionsadressen | solange gepflegt | – |
| Einsatzmeldungen aus FE2 und Feuersoftware Connect (`fe2_events`, Spalte `source`) | ggf. Betroffene eines Einsatzes (indirekt über Ort/Zeit) | Stichwort, Einsatzart, Ort bzw. Ort mit Ortsteil, Zeit, Einheiten (Allowlist; keine Alarmtexte, kein Sachverhalt, keine Straße/Hausnummer, keine meldende Person, keine Telefonnummern, keine Lagemeldungen) | **90 Tage** | `privacy.fe2_event_days` |
| Übernommene Einsätze (`connection_seen_events`) | – | nur Prüfsumme aus Verbindung und Einsatz-ID (verhindert, dass gelöschte Einsätze erneut angelegt werden) | **30 Tage** | fest |
| Amtliche Warnungen (`official_warnings`) | – | keine personenbezogenen Daten | **90 Tage** nach Ablauf und nachdem die Quelle sie nicht mehr liefert | `privacy.official_warning_days` |
| Empfangsprotokoll der Verbindungen (`connection_receipts`, `connection_receipt_items`, `connection_receipt_raws`) | bei Einsätzen ggf. Betroffene (indirekt über Ort/Zeit) | je Abruf bzw. eingehender Meldung: Zeit, Auslöser, Ergebnis, Fehlermeldung, HTTP-Status, Dauer, Zähler; je Meldung Entscheidung mit Grund und Rohdaten. Amtliche Warnungen vollständig (öffentlich). FE2 und Feuersoftware nur **geschwärzt**: Werte bleiben nur für Stichwort, Einsatzart, Ort/Ortsteil, Zeiten, Status, RIC, Einheiten, Kennung und die Felder der FE2-Feldzuordnung (auch dort werden E-Mail-Adressen, Telefonnummern und Straßen mit Hausnummer ersetzt); Straße, Hausnummer, PLZ, Einsatznummer, Sachverhalt, Alarmtext und sonstiger Freitext erscheinen nur als „‹ausgeblendet: Text, n Zeichen›“, Koordinaten werden entfernt, alles unter meldender Person, Anrufer, Patient, Kontakt ist ausgeblendet. Keine Kopfzeilen, keine Schlüssel. Fehlversuche am FE2-Eingang ohne gültigen Schlüssel nur ohne Inhalt, höchstens einer je Minute | **7 Tage**, höchstens 500 Einträge je Verbindung; mit der Verbindung gelöscht, wenn diese endgültig gelöscht wird | `privacy.receipt_days` (1–30) |
| Workflows: Laufprotokolle (`automation_runs`, `automation_steps`, `automation_approvals`, `automation_dedup`) | bei Einsätzen ggf. Betroffene (indirekt über Ort/Zeit); Empfänger interner Mails (gekürzt) | Eingangsdaten des Laufs (nur die Felder des Eingangs: FE2/Feuersoftware ausschließlich die Allowlist, Uploads ohne Angaben der Hochladenden, amtliche Warnungen und RSS öffentlich, manueller Start: eingegebene Felder), je Schritt Ergebnis und gekürzte Daten (Texte höchstens 500 Zeichen, E-Mail-Adressen als `m…@domain`), Freigaben mit entscheidender Person und Notiz, Prüfsummen für „Einmal je Vorgang“ | abgeschlossene Läufe **30 Tage**; Entprell-Schlüssel 1 Tag nach Ablauf | `privacy.automation_run_days` |
| Presseanfragen (`press_requests`, `press_request_events`, `press_messages`, `press_attachments`) | Journalistinnen und Journalisten, die anfragen | Medium, Name, E-Mail, Telefon, Thema, Anfragetext, interne Notizen, Verlauf (Kontaktdaten dort nur als „geändert“), Zuständigkeit, Frist; Mails aus dem Presse-Postfach (Absender, Empfänger, Betreff, Text, entschärftes HTML) mit Anhängen; sichtbar nur mit „Presseanfragen ansehen“, Teil der Datenschutzsuche, Auskunft und Löschung; Workflows und Benachrichtigungen erhalten keine Kontaktdaten | **12 Monate** nach der Erledigung | `privacy.press_request_months` |
| Empfangsprotokoll des Presse-Postfachs (`press_mailbox_log`) | Absender abgerufener Mails | Zeitpunkt, Ergebnis (neue Anfrage, zugeordnet, ignoriert), Betreff, Absenderadresse | wie das Empfangsprotokoll der Verbindungen, Standard **7 Tage** | `privacy.receipt_days` |
| Presseverteiler (`press_contacts`, `press_lists`, `press_list_members`) und Versandprotokolle (`press_releases`, `press_release_recipients`) | Journalistinnen und Journalisten im Verteiler | Name, Medium, E-Mail, Telefon, Notiz, **Herkunft** und **Einwilligung/Rechtsgrundlage**, Listen, Abmeldezeitpunkt; je Pressemitteilung Empfängeradresse, Stand, Zeitpunkt; sichtbar nur mit „Presseverteiler pflegen“ bzw. „Pressemitteilungen versenden“; Abmeldelink in jeder Mail (auch RFC 8058), Teil der Datenschutzsuche, Auskunft und Löschung (Löschen entfernt die Adresse auch aus den Versandprotokollen) | bis zur Löschung; abgemeldete Kontakte bleiben als Sperrvermerk | – |
| Workflows: Definitionen (`automations`, `automation_versions`, `automation_inputs`, `automation_outputs`) | Redaktion (Änderungen) | Abläufe, Vorlagentexte, gewählte Rollen/Personen/Zuständigkeiten, wer zuletzt geändert/aktiviert hat | bis zum Löschen | – |
| Konten (`users`, `sessions`, `invitations`, `trusted_devices`) | Redaktion, Administration | Name, E-Mail, Rollen, Passwort-Hash, TOTP (verschlüsselt), letzte Anmeldung, Sitzungen mit IP und Browser, gemerkte Geräte der Zwei-Faktor-Anmeldung (Browser-Kennung, Zeitpunkte, Hash der Gerätekennung, keine IP) | Konto bis zur Löschung; Sitzungen und gemerkte Geräte 7 Tage nach Ende bzw. Ablauf; Einladungen 30 Tage nach Ablauf | `security.remember_days`, `security.mfa_remember_days` |
| Audit (`audit_events`) | alle Handelnden, Hochladende (IP) | Name, E-Mail, Aktion, Objekt, IP | **365 Tage**; IP ohne Konto **30 Tage** | `retention.audit_days`, `privacy.upload_ip_retention_days` |
| Systemprotokoll (`app_logs`) | Handelnde (selten) | technische Meldungen | **30 Tage** | `retention.log_days` |
| Benachrichtigungen | Empfänger | Text, Link | 60 Tage | – |
| Push-Geräte (`push_subscriptions`, Wahl je Art in `users.preferences`) | Konten mit eingeschaltetem Push | Adresse beim Push-Dienst des Browsers, öffentliche Geräteschlüssel, Gerätebezeichnung (Browser/Betriebssystem), Zeitpunkte und letzter Fehler der Zustellung | bis zum Entfernen durch die Person, bei erloschenem Abo (404/410) bzw. nach 10 Fehlschlägen in Folge sofort; mit dem Konto | *Mein Konto → Benachrichtigungen* |
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

Das **Empfangsprotokoll** (Verbindung → *Empfangsprotokoll*) sehen nur Personen mit dem Recht „Verbindungen
verwalten“; Liste, Meldungen und Rohdaten sind nur mit diesem Recht abrufbar. Weil Einsatzdaten dort nur geschwärzt
liegen, wird das Öffnen der Rohdaten nicht eigens auditiert, und das Protokoll ist nicht Teil der Datenschutzsuche
(es enthält keine Namen, Telefonnummern oder Adressen; Ort und Zeit eines Einsatzes stehen ohnehin in den
Einsatzmeldungen). Es dient der Einrichtung und Fehlersuche (Gebietsfilter, RIC, Stichwörter, Feldzuordnung) und
verschwindet nach der kurzen Frist von selbst.

**Workflows** (Workflows → Alle Workflows) verarbeiten nur, was ihr Eingang liefert – es gibt keine Abfrage
fremder Daten und keine freien Empfängeradressen: E-Mails gehen nur an Konten mit gewählten Rollen und an gepflegte
Zuständigkeiten (diese nur nach Freigabe oder mit ausdrücklich erlaubtem Direktversand, im Testmodus nur an das
Testpostfach), Benachrichtigungen innerhalb von BlaulichtCMS und – nach Wahl der Person – per Push oder E-Mail an das eigene Konto. Laufprotokolle sehen nur Personen mit
„Workflows ansehen“; sie sind nicht Teil der Datenschutzsuche (keine Namen oder Adressen außer gekürzten
E-Mail-Adressen; Einsatzbezug nur über die Allowlist) und verschwinden mit `privacy.automation_run_days`. Entwürfe, die
ein Workflow anlegt (Beiträge, Banner, Warnentwürfe), gehören danach zum jeweiligen Bereich und folgen dessen
Fristen.

Die Löschfristen wendet der Worker stündlich an; *Einstellungen → Datenschutz → „Was würde gelöscht?“* zeigt vorab,
was fällig ist. Jeder Lauf steht im Audit (`retention.run`).

## Empfänger

| Empfänger | Was | Rolle | Zu prüfen |
|---|---|---|---|
| Öffentlichkeit (Website) | freigegebene Beiträge, öffentliche Fassungen | – | Einwilligung/Interessenabwägung für Abgebildete |
| WordPress-Hoster *[Name]* | dasselbe | Auftragsverarbeiter | AV-Vertrag (Art. 28), Standort, Unterauftragnehmer |
| Meta Platforms Ireland / Meta Platforms Inc. (USA) | freigegebene Beiträge und Dateien für Facebook/Instagram/Threads (auch Storys) | eigener Verantwortlicher; für Seiten-Insights gemeinsame Verantwortung (Art. 26) | Seiten-Insights-Ergänzung, Drittlandübermittlung (EU-US Data Privacy Framework), Datenschutzerklärung der Seite |
| X Corp. (USA) – nur mit „Über die X-API posten“ | freigegebene Beiträge und Bilder für X | eigener Verantwortlicher | Drittlandübermittlung, Präsenz in der Datenschutzerklärung; beim Teilen von Hand überträgt die Person selbst |
| Betreiber der gewählten Mastodon-Instanz (und föderierte Instanzen) – nur mit Mastodon-Verbindung | freigegebene Beiträge, Bilder, Alternativtexte | eigener Verantwortlicher | Standort und Betreiber der Instanz, Präsenz in der Datenschutzerklärung; Löschungen setzt jede Instanz selbst um |
| Bluesky Social PBC (USA) – nur mit Bluesky-Verbindung | freigegebene Beiträge, Bilder, Alternativtexte (über das offene Protokoll öffentlich abrufbar) | eigener Verantwortlicher | Drittlandübermittlung, Präsenz in der Datenschutzerklärung |
| (Abruf, keine Übermittlung) Statistik-Schnittstellen von Meta, X, Mastodon-Instanz und Bluesky | BlaulichtCMS ruft nur Summen je eigenem Beitrag ab (Aufrufe, Interaktionen), speichert keine Personen | – | bei Meta: Seiten-Insights und gemeinsame Verantwortung (Art. 26) wie bisher; X-Abruf ist kostenpflichtig und standardmäßig aus |
| Mailserver/Provider *[Name]* | Warnmails mit PDF, Benachrichtigungen | Auftragsverarbeiter (falls extern) | AV-Vertrag |
| Push-Dienste der Browserhersteller (Google FCM, Mozilla, Apple, Microsoft WNS) | nur bei eingeschaltetem Push: Ende-zu-Ende-verschlüsselte Kurzmitteilung (Titel, kurzer Text, Link; ohne Einsatzdetails), Adresse des Geräts | Übermittlung durch den Browser des Kontos; Inhalt für den Dienst nicht lesbar (RFC 8291) | Hinweis in der Datenschutzinformation für Beschäftigte; Push ist freiwillig |
| Microsoft 365 (optional, Versandweg „Microsoft 365“) | alle ausgehenden E-Mails | Auftragsverarbeiter (bestehender Vertrag der Organisation) | AV-Vertrag/Online Services DPA, Postfach-Beschränkung für die App |
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
  Cookies abdecken. Alternativ lassen sich Datenschutzerklärung und Impressum direkt in BlaulichtCMS hinterlegen
  (*Einstellungen → Datenschutz*, öffentlich unter `/datenschutz` und `/impressum`); ohne eigene Adresse verlinken
  Upload-Seite und Aushang dann die Seite `/datenschutz`. Die eingebaute Vorlage ist nur eine Gliederung mit
  Platzhaltern und ersetzt keine rechtliche Prüfung.
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
| Zugangskontrolle (ORP.4) | Passwörter mit Argon2id, Zwei-Faktor (Pflicht für Konten mit Verwaltungsrechten und mit „Originale herunterladen“), Sperre nach Fehlversuchen ohne gezieltes Aussperren, erneute Bestätigung bei kritischen Änderungen, Sitzungsdauer begrenzt |
| Zugriffskontrolle (ORP.4, APP.3.1) | Rollen (mitgeliefert und eigene) mit feinen Rechten je Funktion, serverseitig je Aktion und Datei geprüft, Vergabe nur innerhalb der eigenen Rechte, Rollenänderungen mit altem und neuem Stand im Audit-Protokoll; Originale nur mit „Originale herunterladen“; Upload-Links befristet, pausier- und widerrufbar, neu erzeugbar, auf eine Sammlung beschränkt; einheitliche Meldung für unbekannte, abgelaufene, pausierte und widerrufene Links |
| Datenminimierung (CON.2) | Standort-/Kameradaten aus öffentlichen Fassungen und Originalen entfernt; neutrale Dateinamen nach außen; FE2-Allowlist; IP ohne Konto nach 30 Tagen entfernt; Hinweisfeld fragt nicht nach Namen; Markierung und Unkenntlichmachen sensibler Inhalte vor der Freigabe; Gesichtsvorschläge (lokal, nur Rechtecke) mit Pflicht-Prüfung bei offenen Vorschlägen |
| Speicherbegrenzung (CON.6) | Löschfristen je Datenart mit Probelauf und Audit; „Sammlung löschen“; Auskunft/Löschung je Person |
| Vertraulichkeit (CON.1) | Geheimnisse und TOTP mit AES-256-GCM, Master-Schlüssel außerhalb der Datenbank und wechselbar (`rotate-master-key`); Sicherungen verschlüsselt mit getrenntem Schlüssel; HTTPS am Proxy, HSTS |
| Integrität und Nachweis (OPS.1.1.5) | Audit als versiegelte Hash-Kette mit täglicher Prüfung, optional zentrale Weiterleitung; Freigabe gilt für genau eine Fassung (Prüfsumme) |
| Schutz vor Schadsoftware (OPS.1.1.4) | Quarantäne, Prüfung nach Inhalt, optional ClamAV vor jeder Verarbeitung |
| Härtung (SYS.1.6, APP.4.4) | Container ohne Root und Capabilities, schreibgeschütztes Dateisystem, Ressourcengrenzen, getrennte Datenbankrollen ohne Superuser, Content-Security-Policy, fixierte Basis-Images, Schwachstellenprüfung in der CI |
| Verfügbarkeit (CON.3, DER.4) | tägliche verschlüsselte Sicherungen, Prüfung der Wiederherstellung, Rückweg bei Updates |
| Erkennung (DER.1) | Sicherheitsmeldungen an die Administration und Betroffene |

Organisatorisch *[zu ergänzen]*: Rollenkonzept und Vergabe (wer erhält welche Rolle, wer darf Rollen ändern; Vorlage: Hilfe → Benutzer und Rollen → Beispiele), Schulung der Redaktion (Persönlichkeitsrechte,
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
| Neue Technologien | übliche Web-Anwendung; Gesichtsvorschläge mit einem lokalen Erkennungsmodell (nur Lage im Bild, keine Identifizierung, abschaltbar, Ergebnis nur Vorschlag) | *[bewerten]*, eher nicht zutreffend |

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
