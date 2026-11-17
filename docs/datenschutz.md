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
                                                   ├──▶ WordPress (BlaulichtCMS Bridge, ruft selbst ab): Beiträge,
                                                   │    Banner, Einsatzliste ──▶ öffentlich
                                                   ├──▶ Facebook/Instagram/Threads (Meta), X, Bluesky (USA),
                                                   │    Mastodon-Instanz ──▶ öffentlich
Journalist/innen ──Mail──▶ Presse-Postfach ◀─Abruf─┤
FE2 (Einsatzdaten, Allowlist) ──HTTP──────────────▶│
Feuersoftware Connect (Einsätze) ◀──Abruf──────────┤
Warnfeeds (amtliche Warnungen) ◀──Abruf────────────┤
iCal-Quellen (Kalender) ◀──Abruf───────────────────┤
GitHub (Update-Prüfung, Updates) ◀──Abruf──────────┤
                                                   ├──▶ Mailserver bzw. Microsoft 365: Warnentwurf, Antworten
                                                   │    und Pressemitteilungen, E-Mail-Benachrichtigungen
                                                   ├──▶ Push-Dienste der Browserhersteller (Ende-zu-Ende-
                                                   │    verschlüsselt; standardmäßig nur Art und Link)
                                                   └──▶ Sicherungsziel außer Haus (WebDAV, verschlüsselt)
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
- **Presseanfragen und Presse-Postfach (#204–#206):** Anfragen per Telefon, Mail oder über das Presse-Postfach. Das
  Postfach ruft BlaulichtCMS per IMAP beim Mailanbieter oder über Microsoft Graph (Microsoft 365) ab und speichert je
  Mail Absender, Empfänger, CC, Betreff, Text, entschärftes HTML und Anhänge – auch Daten Dritter, die in einer Mail
  genannt sind. Antworten gehen über den Versandweg (SMTP bzw. Microsoft 365) an die anfragende Person.
- **Presseverteiler und Pressemitteilungen (#207):** Kontakte von Redaktionen mit Herkunft und Rechtsgrundlage; jede
  Pressemitteilung geht einzeln adressiert mit Abmeldelink an die Kontakte der gewählten Listen, je Empfänger bleibt ein
  Versandprotokoll.
- **Einsatzliste (#213):** Einträge (Alarmzeit, Stichwort, Ort nur als Ortsteil bzw. Gemeinde, Kurzbericht, Fahrzeuge,
  Bilder) werden nach Freigabe über die Bridge auf der Website veröffentlicht. Aufträge an die Website tragen nur,
  solange sie unterwegs sind, eine Kopie des Eintrags.
- **Kalender (#200, #202):** eigene Termine (Titel, Beschreibung, Ort); iCal-Quellen ruft der Server beim Betreiber der
  Quelle ab (Server-IP; die Adresse der Quelle liegt verschlüsselt); je Konto ein persönlicher Abo-Link (gespeichert
  nur die Prüfsumme und der letzte Abruf).
- **Designvorlagen und Bilder aus Vorlagen:** hochgeladene Bilder, Schriften und Vorlagendateien; aus Vorlagen erzeugte
  Bilder erben die Datenschutz-Markierungen ihrer Quellbilder.
- **Reichweite (#218):** BlaulichtCMS ruft bei Meta, X, der Mastodon-Instanz und Bluesky nur Summen je eigenem Beitrag
  ab (Aufrufe, Interaktionen) – keine Personen.
- **Benachrichtigungen:** In der Glocke steht die ganze Benachrichtigung, je nach Art z. B. **Stichwort und
  Gemeinde/Ortsteil** eines Einsatzes, der **Betreff** einer Mail an das Presse-Postfach, der Titel eines Beitrags oder
  der Text eines Workflows (bis 1 000 Zeichen). Per Push und E-Mail (Wahl jeder Person) gehen **standardmäßig nur die
  Art der Benachrichtigung und ein Link** hinaus (#247). Mit *Einstellungen → Benachrichtigungen und E-Mail →
  „Einzelheiten in Push-Mitteilungen“* bzw. *„… in E-Mail-Benachrichtigungen“* (`notify.push_details`,
  `notify.mail_details`) tragen sie Titel und Text. Push ist auf dem Weg über den Push-Dienst Ende-zu-Ende-verschlüsselt
  (RFC 8291), erscheint aber auf dem Gerät (ggf. Sperrbildschirm); die **E-Mail ist nicht Ende-zu-Ende-verschlüsselt** und
  geht an die Kontoadresse, ggf. ein privates Postfach Ehrenamtlicher – Einzelheiten per Mail nur bei dienstlichen
  Adressen einschalten.
- **Updates:** Der Worker fragt alle `updates.check_hours` Stunden (Standard 6) bei GitHub (`api.github.com`) nach
  neuen Versionen; dabei erhält GitHub die IP-Adresse des Servers und die eingesetzte Version (im User-Agent).
  Installation, Update-Pakete und der Host-Update-Helfer laden Code von GitHub, der Bau des Images die Basis-Images aus
  den Container-Registries. Abschaltbar unter *Updates* (`updates.enabled`).
- **Sicherung außer Haus und Probe-Wiederherstellung (#212):** verschlüsselte Sicherungen der Datenbank und – je nach
  Einstellung – des Volumes mit allen Originaldateien gehen per WebDAV an ein zweites Ziel (z. B. NAS); die
  Probe-Wiederherstellung spielt eine Sicherung in eine vorübergehende Probedatenbank ein und löscht sie danach.
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
| Einsatzliste: Einträge (`incident_entries`) | ggf. Betroffene eines Einsatzes (indirekt über Ort/Zeit), Abgebildete; Redaktion | Alarmzeit, Stichwort, Kategorie, Einsatzmeldung, Ort nur als Ortsteil/Gemeinde, Kurzbericht, Fahrzeuge, weitere Kräfte, Bild-IDs, wer angelegt/eingereicht/freigegeben hat | keine automatische Löschung (öffentliches Einsatzarchiv); von Hand zurückziehen bzw. löschen | – |
| Einsatzliste: Aufträge an die Website (`incident_jobs`) | wie die Einträge | solange unterwegs eine Momentaufnahme des Eintrags; erledigte, fehlgeschlagene und abgebrochene Aufträge nur noch Kennung, Fassung, Bild-IDs, Stand, Fehlermeldung, Adresse auf der Website | Inhalte beim Abschluss des Auftrags; Aufträge **30 Tage** danach (der letzte Stand je Eintrag und Website bleibt, solange es den Eintrag gibt); mit dem Eintrag gelöscht | fest |
| Banner (`banners`, `banner_jobs`) | ggf. im Text genannte Personen; Redaktion | Titel, Text, Link, Zeitraum, Freigabe, wer angelegt/freigegeben hat; Aufträge an die Website mit Kopie des Banners | keine automatische Löschung; von Hand beenden bzw. löschen | – |
| Kalender (`calendar_events`, `calendar_categories`) | in Terminen genannte Personen; Redaktion | Titel, Beschreibung, Ort, Zeit, Wiederholung, Schlagwörter, wer angelegt/geändert hat | eigene Termine: **keine automatische Löschung** (von Hand löschen; *[Frist für vergangene Termine organisatorisch festlegen]*) | – |
| Kalender: iCal-Quellen (`calendar_sources`, `calendar_source_log`, eingelesene `calendar_events`) | in eingelesenen Terminen genannte Personen | Bezeichnung und Host der Quelle (Adresse verschlüsselt in `secrets`), eingelesene Termine wie oben; Abrufprotokoll nur mit Zählern und technischen Meldungen | eingelesene Termine, solange die Quelle sie liefert (mit der Quelle gelöscht); Abrufprotokoll höchstens 200 Einträge je Quelle | – |
| Kalender-Abo (`calendar_feeds`) | Konten | Prüfsumme des persönlichen Abo-Links, gewählte Kategorien, mit/ohne Beschreibung, Zeitpunkt des letzten Abrufs | bis zum Widerruf durch die Person; mit dem Konto | *Kalender → Abonnieren* |
| Designvorlagen (`design_templates`, `design_template_versions`, `design_template_files`, `design_template_assets`, `design_fonts`, `template_categories`) | ggf. auf Bildern Abgebildete; Redaktion | Vorlagendateien, hochgeladene Bilder und Schriften, Titel, Beschreibung, Hinweise, Versionen, Downloadzähler, wer hochgeladen/geändert hat | bis zum Löschen | – |
| Beitragsvorlagen und Textbausteine (`post_templates`, `press_snippets`) | ggf. im Text genannte Personen (z. B. Ansprechperson) | Texte der Redaktion | bis zum Löschen | – |
| Reichweite (`social_publications.insights`, `social_insights`) | – | **keine personenbezogenen Daten:** nur Summen je eigenem Beitrag (Aufrufe, Interaktionen) | mit dem Beitrag | – |
| Warnvorgänge (`warnings`, `warning_revisions`, `warning_approvals`, `warning_sends`) | Rückrufkontakte, Redaktion, Empfänger | Name, Telefon, E-Mail-Adressen, PDF, SMTP-Antworten | **365 Tage** nach dem letzten Bearbeitungsschritt | `privacy.warning_days` |
| Zuständigkeiten (`responsibilities`) | Ansprechstellen | Funktionsadressen | solange gepflegt | – |
| Einsatzmeldungen aus FE2 und Feuersoftware Connect (`fe2_events`, Spalte `source`) | ggf. Betroffene eines Einsatzes (indirekt über Ort/Zeit) | Stichwort, Einsatzart, Ort bzw. Ort mit Ortsteil, Zeit, Einheiten (Allowlist; keine Alarmtexte, kein Sachverhalt, keine Straße/Hausnummer, keine meldende Person, keine Telefonnummern, keine Lagemeldungen) | **90 Tage** | `privacy.fe2_event_days` |
| Übernommene Einsätze (`connection_seen_events`) | – | nur Prüfsumme aus Verbindung und Einsatz-ID (verhindert, dass gelöschte Einsätze erneut angelegt werden) | **30 Tage** | fest |
| Amtliche Warnungen (`official_warnings`) | – | keine personenbezogenen Daten | **90 Tage** nach Ablauf und nachdem die Quelle sie nicht mehr liefert | `privacy.official_warning_days` |
| Empfangsprotokoll der Verbindungen (`connection_receipts`, `connection_receipt_items`, `connection_receipt_raws`) | bei Einsätzen ggf. Betroffene (indirekt über Ort/Zeit) | je Abruf bzw. eingehender Meldung: Zeit, Auslöser, Ergebnis, Fehlermeldung, HTTP-Status, Dauer, Zähler; je Meldung Entscheidung mit Grund und Rohdaten. Amtliche Warnungen vollständig (öffentlich). FE2 und Feuersoftware nur **geschwärzt**: Werte bleiben nur für Stichwort, Einsatzart, Ort/Ortsteil, Zeiten, Status, RIC, Einheiten, Kennung und die Felder der FE2-Feldzuordnung (auch dort werden E-Mail-Adressen, Telefonnummern und Straßen mit Hausnummer ersetzt); Straße, Hausnummer, PLZ, Einsatznummer, Sachverhalt, Alarmtext und sonstiger Freitext erscheinen nur als „‹ausgeblendet: Text, n Zeichen›“, Koordinaten werden entfernt, alles unter meldender Person, Anrufer, Patient, Kontakt ist ausgeblendet. Keine Kopfzeilen, keine Schlüssel. Fehlversuche am FE2-Eingang ohne gültigen Schlüssel nur ohne Inhalt, höchstens einer je Minute | **7 Tage**, höchstens 500 Einträge je Verbindung; mit der Verbindung gelöscht, wenn diese endgültig gelöscht wird | `privacy.receipt_days` (1–30) |
| Workflows: Laufprotokolle (`automation_runs`, `automation_steps`, `automation_approvals`, `automation_dedup`) | bei Einsätzen ggf. Betroffene (indirekt über Ort/Zeit); Empfänger interner Mails (gekürzt) | Eingangsdaten des Laufs (nur die Felder des Eingangs: FE2/Feuersoftware ausschließlich die Allowlist, Uploads ohne Angaben der Hochladenden, amtliche Warnungen und RSS öffentlich, manueller Start: eingegebene Felder), je Schritt Ergebnis und gekürzte Daten (Texte höchstens 500 Zeichen, E-Mail-Adressen als `m…@domain`), Freigaben mit entscheidender Person und Notiz, Prüfsummen für „Einmal je Vorgang“ | abgeschlossene Läufe **30 Tage**; Entprell-Schlüssel 1 Tag nach Ablauf | `privacy.automation_run_days` |
| Presseanfragen (`press_requests`, `press_request_events`, `press_messages`, `press_attachments`) | Journalistinnen und Journalisten, die anfragen | Medium, Name, E-Mail, Telefon, Thema, Anfragetext, interne Notizen, Verlauf (Kontaktdaten dort nur als „geändert“), Zuständigkeit, Frist; Mails aus dem Presse-Postfach (Absender, Empfänger, Betreff, Text, entschärftes HTML) mit Anhängen; sichtbar nur mit „Presseanfragen ansehen“, Teil der Datenschutzsuche, Auskunft und Löschung; Workflows und Benachrichtigungen erhalten keine Kontaktdaten | erledigte **12 Monate** nach der Erledigung; nicht erledigte (neu, in Bearbeitung, beantwortet) **12 Monate** nach der letzten Aktivität (Änderung, Notiz, Status, Mail), frühestens 30 Tage nach einer Ankündigung an „Presseanfragen bearbeiten“ | `privacy.press_request_months`, `privacy.press_open_months` |
| Empfangsprotokoll des Presse-Postfachs (`press_mailbox_log`) | Absender abgerufener Mails | Zeitpunkt, Ergebnis (neue Anfrage, zugeordnet, ignoriert), Betreff, Absenderadresse | wie das Empfangsprotokoll der Verbindungen, Standard **7 Tage** | `privacy.receipt_days` |
| Presseverteiler (`press_contacts`, `press_lists`, `press_list_members`) und Versandprotokolle (`press_releases`, `press_release_recipients`) | Journalistinnen und Journalisten im Verteiler | Name, Medium, E-Mail, Telefon, Notiz, **Herkunft** und **Rechtsgrundlage** (Pflicht; öffentliche Redaktionsadresse/Art. 6 Abs. 1 lit. e, Einwilligung mit Datum, andere mit Nachweis – Grundlage und Änderungen im Audit), Listen, Abmeldezeitpunkt, „Geprüft“; je Pressemitteilung Empfängeradresse, Name, Stand, Fehlermeldung, Zeitpunkt; sichtbar nur mit „Presseverteiler pflegen“ bzw. „Pressemitteilungen versenden“; Fußzeile jeder Mail mit verantwortlicher Stelle, Datenschutzhinweis (Art. 14) und Abmeldelink (auch RFC 8058); Teil der Datenschutzsuche, Auskunft und Löschung (Löschen entfernt die Adresse auch aus den Versandprotokollen, über Kontakt-ID und Adresse) | Kontakte bis zur Löschung, **Wiedervorlage** („zu prüfen“) ohne Rechtsgrundlage bzw. nach **24 Monaten** ohne Versand/Änderung; nach Abmeldung nur **Sperrvermerk** (Adresse, Zeitpunkt, Rechtsgrundlage samt Datum); Versandprotokolle **12 Monate** nach dem Versand auf Zähler reduziert | `privacy.press_contact_review_months`, `privacy.press_release_log_months` |
| Workflows: Definitionen (`automations`, `automation_versions`, `automation_inputs`, `automation_outputs`) | Redaktion (Änderungen) | Abläufe, Vorlagentexte, gewählte Rollen/Personen/Zuständigkeiten, wer zuletzt geändert/aktiviert hat | bis zum Löschen | – |
| Konten (`users`, `sessions`, `invitations`, `trusted_devices`) | Redaktion, Administration | Name, E-Mail, Rollen, Passwort-Hash, TOTP (verschlüsselt), letzte Anmeldung, Sitzungen mit IP und Browser, gemerkte Geräte der Zwei-Faktor-Anmeldung (Browser-Kennung, Zeitpunkte, Hash der Gerätekennung, keine IP) | Konto bis zur Löschung; Sitzungen und gemerkte Geräte 7 Tage nach Ende bzw. Ablauf; Einladungen 30 Tage nach Ablauf | `security.remember_days`, `security.mfa_remember_days` |
| Audit (`audit_events`) | alle Handelnden, Hochladende (IP) | Name, E-Mail, Aktion, Objekt, IP | **365 Tage**; IP ohne Konto **30 Tage** | `retention.audit_days`, `privacy.upload_ip_retention_days` |
| Systemprotokoll (`app_logs`) | Handelnde (selten) | technische Meldungen | **30 Tage** | `retention.log_days` |
| Benachrichtigungen (`notifications`, `notification_reads`) | Konten mit dem passenden Recht; im Text genannte Personen | Titel und Text (je nach Art Stichwort und Gemeinde/Ortsteil eines Einsatzes, Betreff einer Presse-Mail, Titel eines Beitrags, Text eines Workflows), Link, Lesestatus; Kopie per Push bzw. E-Mail nach Wahl der Person – standardmäßig nur Art und Link | **60 Tage**; zugestellte Push-Mitteilungen und Mails liegen danach auf den Geräten bzw. in den Postfächern | `notify.push_details`, `notify.mail_details` |
| Update-Verlauf (`update_history`) | Administration | Versionen, Zeitpunkt, Ergebnis, handelnde Person | keine automatische Löschung | – |
| Push-Geräte (`push_subscriptions`, Wahl je Art in `users.preferences`) | Konten mit eingeschaltetem Push | Adresse beim Push-Dienst des Browsers, öffentliche Geräteschlüssel, Gerätebezeichnung (Browser/Betriebssystem), Zeitpunkte und letzter Fehler der Zustellung | bis zum Entfernen durch die Person, bei erloschenem Abo (404/410) bzw. nach 10 Fehlschlägen in Folge sofort; mit dem Konto | *Mein Konto → Benachrichtigungen* |
| Sicherung außer Haus und Probe-Wiederherstellung (`backup_offsite`, `restore_drills`, Probedatenbanken `blaulichtcms_probe_*`) | alle (Kopie) | Ziel, Benutzername (Passwort verschlüsselt), Stand der Übertragungen; Ergebnis der Proben mit Zählern; die Probedatenbank ist während der Probe eine vollständige Kopie einer Sicherung | Probedatenbank nach der Probe gelöscht (Reste nach einem Abbruch räumt der Worker auf); Aufbewahrung auf dem Ziel siehe nächste Zeile | *Einstellungen → Sicherung außer Haus* |
| Sicherungen (Volume, Datenbank), auch auf dem Ziel außer Haus | alle | Kopie aller Daten | rund **4 Monate** mit den Standardwerten (siehe [Löschung und Sicherungen](betrieb.md#löschung-und-sicherungen)); Sicherung außer Haus Standard 7 Tage/4 Wochen/3 Monate, höchstens 90 Tage/52 Wochen/24 Monate – längere Aufbewahrung als 4 Monate nur mit Bestätigung, dann hier und im VVT anpassen | Host-Cron, *Einstellungen → Sicherung*, *Einstellungen → Sicherung außer Haus* |
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
Testpostfach), Benachrichtigungen innerhalb von BlaulichtCMS und – nach Wahl der Person – per Push oder E-Mail an das eigene Konto (nach außen standardmäßig ohne den Text, siehe Benachrichtigungen oben). Laufprotokolle sehen nur Personen mit
„Workflows ansehen“; sie sind nicht Teil der Datenschutzsuche (keine Namen oder Adressen außer gekürzten
E-Mail-Adressen; Einsatzbezug nur über die Allowlist) und verschwinden mit `privacy.automation_run_days`. Entwürfe, die
ein Workflow anlegt (Beiträge, Banner, Warnentwürfe), gehören danach zum jeweiligen Bereich und folgen dessen
Fristen.

Die Löschfristen wendet der Worker stündlich an; *Einstellungen → Datenschutz → „Was würde gelöscht?“* zeigt vorab,
was fällig ist. Jeder Lauf steht im Audit (`retention.run`).

## Empfänger

| Empfänger | Was | Rolle | Zu prüfen |
|---|---|---|---|
| Öffentlichkeit (Website) | freigegebene Beiträge, öffentliche Fassungen, Banner, Einträge der Einsatzliste (Ort nur als Ortsteil/Gemeinde, Kurzbericht, Bilder); mit „Autorenname übertragen“ (je Website, `wp_sites.send_author`) zusätzlich der Name der Person, die den Beitrag angelegt hat | – | Einwilligung/Interessenabwägung für Abgebildete; Namen der Redaktion nur mit deren Wissen veröffentlichen |
| WordPress-Hoster *[Name]* | dasselbe | Auftragsverarbeiter | AV-Vertrag (Art. 28), Standort, Unterauftragnehmer |
| Meta Platforms Ireland / Meta Platforms Inc. (USA) | freigegebene Beiträge und Dateien für Facebook/Instagram/Threads (auch Storys) | eigener Verantwortlicher; für Seiten-Insights gemeinsame Verantwortung (Art. 26) | Seiten-Insights-Ergänzung, Drittlandübermittlung (EU-US Data Privacy Framework), Datenschutzerklärung der Seite |
| X Corp. (USA) – nur mit „Über die X-API posten“ | freigegebene Beiträge und Bilder für X | eigener Verantwortlicher | Drittlandübermittlung, Präsenz in der Datenschutzerklärung; beim Teilen von Hand überträgt die Person selbst |
| Betreiber der gewählten Mastodon-Instanz (und föderierte Instanzen) – nur mit Mastodon-Verbindung | freigegebene Beiträge, Bilder, Alternativtexte | eigener Verantwortlicher | Standort und Betreiber der Instanz, Präsenz in der Datenschutzerklärung; Löschungen setzt jede Instanz selbst um |
| Bluesky Social PBC (USA) – nur mit Bluesky-Verbindung | freigegebene Beiträge, Bilder, Alternativtexte (über das offene Protokoll öffentlich abrufbar) | eigener Verantwortlicher | Drittlandübermittlung, Präsenz in der Datenschutzerklärung |
| (Abruf, keine Übermittlung) Statistik-Schnittstellen von Meta, X, Mastodon-Instanz und Bluesky | BlaulichtCMS ruft nur Summen je eigenem Beitrag ab (Aufrufe, Interaktionen), speichert keine Personen | – | bei Meta: Seiten-Insights und gemeinsame Verantwortung (Art. 26) wie bisher; X-Abruf ist kostenpflichtig und standardmäßig aus |
| Mailserver/Provider *[Name]* | Warnmails mit PDF, E-Mail-Benachrichtigungen (standardmäßig ohne Einzelheiten), Antworten auf Presseanfragen, Pressemitteilungen | Auftragsverarbeiter (falls extern) | AV-Vertrag |
| Mailanbieter des Presse-Postfachs *[Name]* (IMAP) – nur mit eingerichtetem Postfach | eingehende Presse-Mails samt Anhängen (BlaulichtCMS ruft ab) | Auftragsverarbeiter (falls extern) | AV-Vertrag, Standort |
| Journalistinnen und Journalisten, Redaktionen | Antworten auf ihre Presseanfragen; Pressemitteilungen (einzeln adressiert, mit Abmeldelink) | eigene Verantwortliche | Inhalt der Antwort (keine Daten Dritter ohne Grundlage), Art. 14 bei Adressen aus fremden Quellen |
| Push-Dienste der Browserhersteller: Google (Firebase Cloud Messaging – Chrome, Android), Mozilla (Firefox), Apple (Safari, iOS), Microsoft (Edge, Windows) – nur bei eingeschaltetem Push | Ende-zu-Ende-verschlüsselte Mitteilung (RFC 8291): **standardmäßig nur die Art der Benachrichtigung und ein Link**; mit „Einzelheiten in Push-Mitteilungen“ Titel und Text wie in der Glocke (z. B. Stichwort und Gemeinde/Ortsteil eines Einsatzes, Betreff einer Presse-Mail, Text eines Workflows); dazu Adresse des Geräts beim Dienst, Zeitpunkt, Server-IP | Dienst des jeweiligen Browserherstellers; Inhalt für den Dienst nicht lesbar, Metadaten schon | Drittland (USA), Hinweis in der Datenschutzinformation für Beschäftigte und Ehrenamtliche; Push ist freiwillig |
| Microsoft 365 (optional: Versandweg „Microsoft 365“ und/oder Presse-Postfach über Microsoft 365) | alle ausgehenden E-Mails (Warnversand, Benachrichtigungen, Antworten, Pressemitteilungen); beim Presse-Postfach über Microsoft Graph auch die **eingehenden** Presse-Mails samt Anhängen | Auftragsverarbeiter (bestehender Vertrag der Organisation) | AV-Vertrag/Online Services DPA, Speicherort des Mandanten, Drittland (Unterauftragsverarbeiter), Postfach-Beschränkung für die App |
| Betreiber der iCal-Quellen *[Name]* – nur mit eingerichteter Quelle | Abruf der Termine: Server-IP, Zeitpunkt, ggf. Zugangstoken in der Adresse | eigener Verantwortlicher | Vertrauenswürdigkeit der Quelle, Inhalte der Termine |
| GitHub Inc. (USA) | Update-Prüfung alle 6 Stunden (abschaltbar): Server-IP und eingesetzte Version; Bezug von Code und Update-Paketen (Installation, In-App-Update, Host-Update-Helfer) | eigener Verantwortlicher | Drittland; keine Daten Betroffener außer der Server-IP |
| Feuersoftware (Connect) – nur mit Verbindung | nur API-Schlüssel und Abfrage (Server-IP); BlaulichtCMS ruft Einsätze ab | Vertrag der Organisation mit Feuersoftware | – |
| Zuständige Stellen (Warnempfänger) | Warnentwurf, PDF, Rückrufkontakt | eigene Verantwortliche | Übermittlungsgrundlage |
| Hosting des Docker-Hosts *[Name]* | alle Daten (verschlüsselte Sicherungen getrennt) | Auftragsverarbeiter (falls extern) | AV-Vertrag, TOMs |
| Sicherungsziel außer Haus *[NAS/zweiter Standort bzw. Dienstleister]* – nur mit *Sicherung außer Haus* bzw. Volume-Sicherung | verschlüsselte Datenbank- und Volume-Sicherungen (alle Daten, nur als Chiffrat; Schlüssel bleiben beim Verantwortlichen) | intern bzw. Auftragsverarbeiter (externer Speicher) | AV-Vertrag bei externem Speicher, Standort, Zugriff; Aufbewahrung laut Einstellung; nach Ausschalten oder Zielwechsel alte Sicherungen dort löschen (Systemstatus erinnert) |
| Zentrale Protokollierung (optional, `AUDIT_FORWARD`) | Audit-Einträge | intern bzw. Auftragsverarbeiter | Frist und Zugriff dort |

### Drittlandübermittlungen

Übermittlungen in Drittländer entstehen nur mit den jeweils eingeschalteten Funktionen. Für die USA kommt der
Angemessenheitsbeschluss zum EU-US Data Privacy Framework in Betracht
([Durchführungsbeschluss (EU) 2023/1795](https://eur-lex.europa.eu/eli/dec_impl/2023/1795/oj)) – aber nur, wenn der
Empfänger in der [Data Privacy Framework List](https://www.dataprivacyframework.gov/) zertifiziert ist. Die
Zertifizierung ändert sich; sie ist vor der Inbetriebnahme und regelmäßig zu prüfen, sonst ist eine andere Grundlage
(Art. 46 bzw. Art. 49 DSGVO) festzulegen.

| Empfänger | Land | wann | zu prüfen |
|---|---|---|---|
| Meta Platforms Inc. | USA | Facebook-, Instagram- oder Threads-Verbindung | DPF-Zertifizierung, Seiten-Insights (Art. 26) |
| X Corp. | USA | „Über die X-API posten“ bzw. Reichweite für X | Grundlage festlegen (DPF-Liste prüfen) |
| Bluesky Social PBC | USA | Bluesky-Verbindung | Grundlage festlegen (DPF-Liste prüfen); Beiträge sind über das offene Protokoll weltweit abrufbar |
| Betreiber der Mastodon-Instanz | je nach Instanz; föderierte Instanzen weltweit | Mastodon-Verbindung | Standort der gewählten Instanz (möglichst EU) |
| Microsoft (Microsoft 365) | EU-Vertragspartner; Unterauftragsverarbeiter auch in Drittländern | Versandweg oder Presse-Postfach über Microsoft 365 | Online Services DPA, Speicherort des Mandanten, DPF |
| Google, Apple, Microsoft, Mozilla (Push-Dienste) | USA | Push von mindestens einer Person eingeschaltet | Inhalt Ende-zu-Ende-verschlüsselt, standardmäßig nur Art und Link; Metadaten beim Dienst |
| GitHub Inc. | USA | Update-Prüfung (Standard an), Installation, Updates | nur Server-IP und Version; Prüfung unter *Updates* abschaltbar |
| Hoster, Mailanbieter, Sicherungsziel *[…]* | je nach Anbieter | – | Standort, AV-Vertrag |

## Rechtsgrundlagen (Vorschlag zur Prüfung)

Beispiele für Hessen sind am 17.11.2026 an amtlichen Fassungen geprüft (HDSIG: Gesetz- und Verordnungsblatt 2018 S. 82
und Ausgabe des HBDI; HBKG und Hessisches Pressegesetz: Wiedergaben der Hessischen Landesfeuerwehrschule). Fassung und
Anwendbarkeit klärt die verantwortliche Stelle mit der oder dem Datenschutzbeauftragten (**[DSB prüfen]**); für andere
Länder gelten deren Gesetze.

| Verarbeitung | mögliche Grundlage |
|---|---|
| Öffentlichkeitsarbeit/Krisenkommunikation einer öffentlichen Stelle (Website, Einsatzliste, soziale Kanäle) | Art. 6 Abs. 1 lit. e DSGVO i. V. m. *[Landesrecht, z. B. Brandschutz-/Katastrophenschutzgesetz, Kommunalrecht]*. Beispiel Hessen: § 3 Abs. 1 HDSIG (Verarbeitung durch eine öffentliche Stelle, wenn zur Erfüllung der Aufgabe in ihrer Zuständigkeit erforderlich) i. V. m. der Aufgabe aus dem Fachrecht, etwa § 3 Abs. 1 Nr. 6 HBKG (Brandschutzerziehung und Brandschutzaufklärung) **[DSB prüfen]** |
| Presseanfragen beantworten (Kontaktdaten der Anfragenden, Anfrage, Mailverlauf) | Art. 6 Abs. 1 lit. c bzw. lit. e DSGVO i. V. m. dem Auskunftsanspruch der Presse nach Landespressegesetz und dem Landesdatenschutzgesetz (Beispiel Hessen: § 3 Abs. 1 HDSIG). Beispiel Hessen: § 3 Abs. 1 Hessisches Pressegesetz (Behörden sind verpflichtet, der Presse Auskünfte zu erteilen; Verweigerung u. a., soweit Auskünfte über persönliche Angelegenheiten Einzelner verlangt werden, an deren öffentlicher Bekanntgabe kein berechtigtes Interesse besteht) **[DSB prüfen]**. In Mails genannte Dritte: nur soweit für die Beantwortung erforderlich |
| Presseverteiler und Pressemitteilungen | öffentliche Redaktionsadressen: Art. 6 Abs. 1 lit. e DSGVO i. V. m. *[Landesrecht]* (Beispiel Hessen: § 3 Abs. 1 HDSIG); persönliche Adressen: Einwilligung (Art. 6 Abs. 1 lit. a, Datum je Kontakt); Information nach Art. 14 spätestens mit der ersten Mitteilung (Fußzeile jeder Mitteilung und Datenschutzerklärung), Widerspruch/Abmeldung jederzeit (Art. 21) über den Link in jeder Mail – *[festlegen]* |
| Konten, Benachrichtigungen per Push/E-Mail, Kalender-Abo von Beschäftigten und Ehrenamtlichen | Art. 6 Abs. 1 lit. c/e DSGVO i. V. m. dem Beschäftigtendatenschutz des Landes. Beispiel Hessen: § 23 Abs. 1 HDSIG für Beschäftigte – nach dem Urteil des EuGH vom 30.03.2023 (C-34/21) ist die Anwendbarkeit strittig ([Handreichung des HBDI](https://datenschutz.hessen.de/sites/datenschutz.hessen.de/files/2023-05/handreichung_beschaeftigtendatenschutz_eugh-urteil.pdf)); Ehrenamtliche nennt die Begriffsbestimmung in § 23 Abs. 8 HDSIG nicht ausdrücklich, für Angehörige der Feuerwehr regelt § 55 Abs. 2 HBKG die Verarbeitung für Einsätze sowie Aus- und Fortbildung (mit abschließender Liste der Daten) **[DSB prüfen]**. Push und E-Mail-Benachrichtigungen wählt jede Person selbst |
| Kalender (eigene und eingelesene Termine) | Art. 6 Abs. 1 lit. e DSGVO (Organisation von Dienstbetrieb und Öffentlichkeitsarbeit) i. V. m. *[Landesrecht]*; Personen in Terminen nur soweit erforderlich |
| Hochladen durch Bürgerinnen und Bürger | freiwillig; Einwilligung (Art. 6 Abs. 1 lit. a) bzw. lit. e – *[festlegen]*; die Upload-Seite informiert nach Art. 13 (*Einstellungen → Datenschutz*) |
| Veröffentlichung von Fotos mit erkennbaren Personen | Einwilligung bzw. [§§ 22, 23 KunstUrhG](https://www.gesetze-im-internet.de/kunsturhg/) (Ausnahmen z. B. für Bildnisse aus dem Bereich der Zeitgeschichte und Bilder von Versammlungen – nicht bei entgegenstehendem berechtigtem Interesse der Abgebildeten)/Art. 85 DSGVO i. V. m. *[Landespresse-/Datenschutzgesetz]*; bei Verletzten (Gesundheitsdaten, Art. 9) nur mit ausdrücklicher Einwilligung |
| Warnentwurf an zuständige Stellen | Art. 6 Abs. 1 lit. c/e i. V. m. *[Fachrecht]* |
| Konten, Audit, Sicherheit, Update-Prüfung, Sicherungen | Art. 6 Abs. 1 lit. c/e (Art. 32 DSGVO), Beschäftigtendaten nach *[Landes-/Bundesrecht]* (siehe oben) |

Amtliche Sammlung des hessischen Landesrechts: [Bürgerservice Hessenrecht](https://www.rv.hessenrecht.hessen.de/); HDSIG
auch als [Ausgabe des HBDI](https://datenschutz.hessen.de/sites/datenschutz.hessen.de/files/2023-06/HDSIG_digital.pdf).

## Betroffenenrechte

- **Information (Art. 13):** Abschnitt „Datenschutz“ auf der Upload-Seite, Zeile auf dem Aushang; Angaben unter
  *Einstellungen → Datenschutz*. Die Datenschutzerklärung der Website muss Upload, Veröffentlichung (Website,
  Einsatzliste, soziale Kanäle wie Meta, X, Mastodon, Bluesky), Presseanfragen, Presseverteiler (Art. 13/14, Abmeldung)
  und Cookies abdecken. Beschäftigte und Ehrenamtliche gesondert informieren (Konten, Protokolle, Benachrichtigungen per
  Push über die Push-Dienste der Browserhersteller und per E-Mail, Kalender-Abo). Alternativ lassen sich Datenschutzerklärung und Impressum direkt in BlaulichtCMS hinterlegen
  (*Einstellungen → Datenschutz*, öffentlich unter `/datenschutz` und `/impressum`); ohne eigene Adresse verlinken
  Upload-Seite und Aushang dann die Seite `/datenschutz`. Die eingebaute Vorlage ist nur eine Gliederung mit
  Platzhaltern (Upload-Seite, Website und Einsatzliste, soziale Kanäle, Presseanfragen, Presseverteiler, Anmeldung,
  Empfänger und Drittländer) und ersetzt keine rechtliche Prüfung.
- **Auskunft und Löschung (Art. 15, 17):** *Verwaltung → Datenschutzanfragen* (Recht „Datenschutzanfragen
  bearbeiten“): Suche nach Name, E-Mail, Telefon, Text, Dateiname, Vorgangsnummer oder IP, Export als ZIP,
  Löschen/Pseudonymisieren je Treffer. Hochladende erhalten nach dem Upload eine Vorgangsnummer. Durchsucht werden
  Uploads (samt Sammlungen, Ordnern, Schlagwörtern, Upload-Links), Presseanfragen mit allen Mails (Absender, Empfänger,
  CC, Betreff, Text, Namen der Anhänge), das Empfangsprotokoll des Presse-Postfachs, Presseverteiler und
  Versandprotokolle (auch Adressen gelöschter oder geänderter Kontakte), Pressemitteilungen und Textbausteine,
  Warnvorgänge, Zuständigkeiten, Einsatzmeldungen, die Einsatzliste (samt Kopien in Aufträgen an die Website, die noch
  unterwegs sind), Kalender (eigene und eingelesene Termine), Beiträge (alle Fassungen), Banner, Vorlagen, Workflow-
  Definitionen, Benachrichtigungen, Konten (samt Sitzungen, Geräten, Kalender-Abo), Sicherheitsereignisse der
  Upload-Seiten (über den HMAC der gesuchten IP), Systemprotokoll, Update-Verlauf und Audit. Welche Tabelle wie
  abgedeckt ist, steht in `server/src/lib/privacy-coverage.ts`; ein Test prüft bei jeder Änderung, dass jede Tabelle
  dort eingetragen ist – neue Tabellen mit Personenbezug fallen so nicht unbemerkt aus der Suche.
- **Kopie (Art. 15 Abs. 3):** Die ZIP-Datei enthält alle Treffer (`auskunft.json`), die hochgeladenen Originale und
  je Presseanfrage Anfrage und Verlauf, jede Mail als Text und die Anhänge im Original. Vor der Herausgabe Daten Dritter
  prüfen und ggf. schwärzen (Art. 15 Abs. 4; z. B. weitere Personen auf Fotos, andere Empfänger einer Mail).
- **Bewusst nicht durchsucht:** Empfangsprotokoll der Verbindungen (Einsatzdaten nur geschwärzt, Frist
  `privacy.receipt_days`) und Laufprotokolle der Workflows (Eingangsdaten nur über die Allowlist, gekürzt, Frist
  `privacy.automation_run_days`) – Begründung in den Absätzen oben; technische Tabellen ohne Daten Betroffener
  (Warteschlange, Prüfsummen, Konfiguration, Statistik nur als Summen). Bilder und Anhänge werden nicht inhaltlich
  durchsucht, nur ihre Namen und Texte.
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
| Datenminimierung (CON.2) | Standort-/Kameradaten aus öffentlichen Fassungen und Originalen entfernt; neutrale Dateinamen nach außen; FE2-Allowlist; IP ohne Konto nach 30 Tagen entfernt; Hinweisfeld fragt nicht nach Namen; Markierung und Unkenntlichmachen sensibler Inhalte vor der Freigabe; Gesichtsvorschläge (lokal, nur Rechtecke) mit Pflicht-Prüfung bei offenen Vorschlägen – für Beiträge und Einsatzliste gleich, Bilder aus Vorlagen erben die Markierungen ihrer Quellbilder |
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
| Bezeichnung | Öffentlichkeitsarbeit und Krisenkommunikation mit BlaulichtCMS (Foto-Links, Redaktion, Veröffentlichung auf Website und sozialen Kanälen, Einsatzliste, Presseanfragen und Presseverteiler, Kalender, Warnentwurf) |
| Verantwortlicher | *[Name, Anschrift, Kontakt]* |
| Datenschutzbeauftragte/r | *[Kontakt]* |
| Zwecke | Sammeln von Fotos/Videos zu Einsätzen und Veranstaltungen; Erstellen, Freigeben und Veröffentlichen von Beiträgen, Bannern und der Einsatzliste auf Website und sozialen Medien; Beantworten von Presseanfragen und Versand von Pressemitteilungen; Planung von Terminen; Entwürfe für Warnungen an zuständige Stellen; Benachrichtigung der Mitwirkenden; Nachvollziehbarkeit, Sicherheit, Sicherung und Aktualisierung des Systems |
| Kategorien betroffener Personen | Hochladende; abgebildete Personen (auch Unbeteiligte, Verletzte, Minderjährige möglich); in Texten, Einsatzberichten und Terminen genannte Personen; Journalistinnen und Journalisten (Anfragende, Kontakte im Presseverteiler); in Mails an das Presse-Postfach genannte Dritte; Redaktion und Administration (Beschäftigte, Ehrenamtliche); Rückrufkontakte; Empfänger von Warnungen; Aufrufende der Upload-Seite |
| Kategorien personenbezogener Daten | siehe [Datenkategorien je Bereich](#datenkategorien-je-bereich); ggf. besondere Kategorien (Gesundheit auf Fotos, Art. 9) |
| Empfänger | siehe [Empfänger](#empfänger) |
| Drittlandübermittlung | je nach eingeschalteten Funktionen (siehe [Drittlandübermittlungen](#drittlandübermittlungen)): Meta Platforms Inc., X Corp., Bluesky Social PBC (USA), Betreiber der Mastodon-Instanz *[Standort]*, Microsoft (Microsoft 365), Google, Apple, Microsoft und Mozilla als Push-Dienste (USA), GitHub Inc. (USA, nur Server-IP und Version); Grundlage: *[z. B. Angemessenheitsbeschluss EU-US Data Privacy Framework für zertifizierte Empfänger, sonst Art. 46/49]*; ggf. Hoster, Mailanbieter, Sicherungsziel *[…]* |
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
| Veröffentlichung / Übermittlung an Dritte und Drittland | Website (Beiträge, Banner, Einsatzliste), soziale Kanäle (Meta, X, Bluesky – USA; Mastodon-Instanz je nach Standort), Pressemitteilungen und Antworten an Redaktionen; Drittland außerdem Microsoft 365, Push-Dienste (Inhalt verschlüsselt, standardmäßig ohne Einzelheiten) und GitHub (nur Server-IP) | **zutreffend** |
| Datenerhebung bei Dritten ohne deren Wissen | Abgebildete wissen oft nicht vom Upload; in Mails an das Presse-Postfach genannte Personen | **zutreffend** |
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
   - Weiterverbreitung bei Meta, X, Bluesky, Mastodon und Dritten, Drittlandzugriff
   - unbefugter Zugriff auf ungesichtete Uploads, Presse-Mails oder Warnvorgänge
   - Daten Dritter (ggf. Gesundheitsdaten) in unaufgefordert eingehenden Mails an das Presse-Postfach
   - Einsatz- oder Personendaten in Benachrichtigungen auf Sperrbildschirmen und in privaten Postfächern
   - zu lange Speicherung
4. **Abhilfemaßnahmen:** Sichtung vor jeder Verwendung, Markierung sensibler Inhalte mit Prüfung vor der Freigabe,
   Unkenntlichmachen und Zuschnitt, Vier-Augen-Freigabe (`editorial.four_eyes`), Standortbereinigung, Rechte und
   Zwei-Faktor, Löschfristen (auch für nicht erledigte Presseanfragen), Push und E-Mail standardmäßig ohne
   Einzelheiten, Datenschutzsuche über alle Bereiche (Abdeckung jeder Tabelle per Test geprüft), Zurückziehen von
   Website und sozialen Kanälen, Schulung *[…]*.
5. **Restrisiko und Ergebnis:** *[Bewertung, Freigabe durch Verantwortliche, Stellungnahme der/des DSB, Datum,
   Überprüfung z. B. jährlich oder bei wesentlichen Änderungen]*.
