| Bereich | Umsetzung |
|---|---|
| Rechte | Serverseitig bei jeder Aktion, jedem Objekt und jeder Datei; Standard ist „verweigert“ |
| Anmeldung | Passwörter mit Argon2id (Parameter nach RFC 9106 / BSI TR-02102-1), Zwei-Faktor (TOTP) mit Wiederherstellungscodes (80 Bit, nur als Schlüssel-Prüfsumme gespeichert; Codes aus älteren Versionen am besten im Profil erneuern), Sperre nach Fehlversuchen für unbekannte Geräte (bekannte Geräte zählen getrennt, damit niemand ein Konto gezielt aussperren kann), Benachrichtigung bei Sperre |
| Cookies | Nur technisch nötige: Sitzung und ein Geräte-Cookie (180 Tage, signiert), das ein bekanntes Gerät von der Kontosperre ausnimmt und an das gemerkte Sitzungen und gemerkte Geräte gebunden sind; kein Tracking |
| Kritische Änderungen | Admin-Rechte, Zwei-Faktor-Reset, Passwort-Links für Admins und Sicherheitseinstellungen nur nach erneuter Bestätigung mit Passwort (und Code), höchstens 10 Minuten alt |
| Sitzungen | Serverseitig, Cookies `HttpOnly` und `SameSite=Strict`, CSRF-Schutz, Leerlauf- und Höchstdauer. „Angemeldet bleiben“ (abschaltbar): keine Leerlaufabmeldung, Ablauf nach 30 Tagen ohne Nutzung, nur zusammen mit dem Geräte-Cookie desselben Browsers gültig, einzeln oder auf allen Geräten abmeldbar |
| Gemerkte Geräte | „Zwei-Faktor auf diesem Gerät merken“ (abschaltbar): nur nach einem Code aus der App, serverseitig gespeichert und an das Geräte-Cookie gebunden, höchstens 30 Tage (einstellbar bis 90). Entfernt bei Passwortänderung, Zwei-Faktor-Änderungen, „Auf allen Geräten abmelden“, Maßnahmen der Administration und Abschalten der Funktion. Kritische Aktionen verlangen immer Passwort und Code |
| Uploads | Nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen; Quarantäne; Prüfung des Inhalts statt des Dateinamens; optional Schadsoftwareprüfung mit ClamAV vor jeder Verarbeitung (Treffer werden gelöscht und gemeldet; ohne ClamAV bleibt ein dokumentiertes Restrisiko, siehe Betriebshandbuch) |
| Medien | Privat außerhalb des Webservers; Auslieferung nur mit Recht; öffentliche Fassung ohne Standort- und Kameradaten; Originale standardmäßig ohne Standort, Seriennummern und Personenangaben |
| Websites | Eigener Schlüssel je Website, nur als Prüfsumme gespeichert, sofort widerrufbar; die Bridge ruft nur aus |
| Datenbank | Nur im Container über einen Unix-Socket erreichbar, kein offener Port |
| Zugangsdaten der Schnittstellen | Alle Zugangsdaten (Verbindungen wie FE2, Feuersoftware Connect und soziale Netzwerke, SMTP-Passwort, Microsoft-365-Geheimnis, Update-Token, Push-Schlüssel) liegen nur verschlüsselt (AES-256-GCM, an ihren Datensatz gebunden) in der Datenbank; der Master-Schlüssel liegt nie in der Datenbank. Die Oberfläche zeigt nur „gespeichert“, nie den Wert; Protokolle maskieren sie; Adressen mit eingebettetem Passwort werden abgewiesen. Beim Start prüft BlaulichtCMS, dass nirgends Zugangsdaten im Klartext stehen, und verschiebt Altbestände in den verschlüsselten Speicher. Sicherungen enthalten sie nur verschlüsselt |
| Protokolle | Audit mit Person und Zeitpunkt, verkettet und versiegelt (nachträgliche Änderungen fallen bei der Prüfung im Systemstatus auf), optional an eine zentrale Protokollierung weitergeleitet, auch für verweigerte Zugriffe, falsche Website- oder FE2-Schlüssel und beendete Sitzungen (Serien gedrosselt auf einen Eintrag je 10 Minuten); geänderte Einstellungen mit altem und neuem Wert (unter „Details“ im Audit-Protokoll); IP-Adressen ohne Benutzerkonto (z. B. öffentliche Uploads) nur 30 Tage (einstellbar unter Einstellungen → Löschfristen); Tokens und vertrauliche Inhalte werden nicht protokolliert |
| Sicherheitsmeldungen | Benachrichtigung (und auf Wunsch E-Mail) an die Administration bei Kontosperren, benutzten Wiederherstellungscodes, vergebenen oder entzogenen Admin-Rechten, zurückgesetzter oder abgeschalteter Zwei-Faktor-Anmeldung, geänderten Sicherheits- und Aufbewahrungseinstellungen, gehäuften Fehlversuchen, falschen Website-, FE2- oder API-Schlüsseln, neuen Website-Kopplungen, ungewöhnlich vielen Downloads, erkannter Schadsoftware in Uploads, länger nicht verfügbarer Schadsoftwareprüfung und Auffälligkeiten im Audit; die betroffene Person erfährt von Passwort- und Zwei-Faktor-Änderungen. Einstellbar unter Einstellungen → Sicherheit |
| Container | Unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities |

## Datenschutzanfragen (Auskunft und Löschung)

Unter [Datenschutzanfragen](/datenschutz-anfragen) (Recht „Datenschutzanfragen bearbeiten“, standardmäßig nur Administration) lassen sich alle Daten zu einer Person finden: Suche nach Name, E-Mail, Telefonnummer, Dateiname, Text aus dem Uploader-Hinweis, **Vorgangsnummer** oder IP-Adresse. Durchsucht werden:

- **Uploads** und unterbrochene Uploads (Hinweis, Dateiname, Angaben der Hochladenden, Texte der Redaktion), Sammlungen, Ordner, Schlagwörter und Upload-Links (Bezeichnung, Texte)
- **Presseanfragen** mit Kontaktdaten, Thema, Anfragetext, Verlauf und **allen Mails** (Absender, Empfänger, **CC**, Betreff, Text, Namen der Anhänge), das **Empfangsprotokoll des Presse-Postfachs**, der **Presseverteiler** und die **Versandprotokolle** der Pressemitteilungen (auch Adressen gelöschter oder geänderter Kontakte), Pressemitteilungen und Textbausteine
- **Warnvorgänge** (Rückrufkontakt, Empfänger, Mailtext, Rückmeldungen), Zuständigkeiten, Einsatzmeldungen aus FE2 und Feuersoftware Connect
- **Einsatzliste** (Titel, Ort, Bericht, Fahrzeuge, Einheiten) einschließlich der Kopien in Aufträgen an die Website, die noch unterwegs sind (abgeschlossene Aufträge behalten nur Kennung und Bilder)
- **Kalender** (eigene und aus iCal-Quellen eingelesene Termine: Titel, Beschreibung, Ort, Schlagwörter)
- **Beiträge** (alle Fassungen, Notizen zur Freigabe), Banner, Vorlagen (Beiträge, Warnentwürfe, Designvorlagen), Workflows (Definitionen), Benachrichtigungen der Glocke
- **Konten** samt Sitzungen, gemerkten Geräten, Push-Geräten und Kalender-Abo, Sicherheitsereignisse der Upload-Seiten (bei Suche nach einer IP-Adresse), Systemprotokoll, Update-Verlauf und das Audit

Bewusst **nicht** durchsucht werden das Empfangsprotokoll der Verbindungen und die Laufprotokolle der Workflows: Sie enthalten Einsatzdaten nur geschwärzt bzw. über die Allowlist und gekürzt und verschwinden nach kurzer Frist von selbst. Bilder (Fotos, Designvorlagen, Anhänge) werden nicht inhaltlich durchsucht, nur ihre Namen und Texte.

- **Vorgangsnummer:** Nach dem Hochladen zeigt die Upload-Seite eine Nummer wie `K7M2-Q9XD`. Sie gilt für alle Dateien dieses Besuchs; wer sie nennt, lässt sich ohne Namen zuordnen.
- **Auskunft als ZIP:** alle Treffer als `auskunft.json`, die hochgeladenen Originale und je Presseanfrage ein Ordner `presse/<Vorgang>/` mit Anfrage und Verlauf (`anfrage.json`), jeder Mail als Text und den Anhängen im Original. Vor der Herausgabe prüfen, ob Daten anderer Personen enthalten sind (z. B. andere Personen auf Fotos, Namen im Audit, weitere Empfänger einer Mail) – Art. 15 Abs. 4 DSGVO.
- **Löschen oder pseudonymisieren** je Treffer: Dateien (nicht, solange ein laufender Beitrag sie verwendet – dort zuerst aus der Fassung nehmen bzw. zurückziehen), unterbrochene Uploads, Warnvorgänge (der ganze Vorgang), FE2-Meldungen, Presseanfragen (samt Mails und Anhängen), Einträge im Empfangsprotokoll des Presse-Postfachs, Kontakte des Presseverteilers, eigene Kalendertermine und Benachrichtigungen. **Pseudonymisieren** ersetzt bei Dateien Dateiname und Hinweis (die Datei bleibt), in Versandprotokollen Adresse und Name. Treffer mit „nur Auskunft“ (Konten, Beiträge, Einträge der Einsatzliste, Vorlagen, eingelesene Termine …) an der verlinkten Stelle bearbeiten; eingelesene Termine in ihrer Quelle.
- Suche, Export und jede Löschung stehen im Audit (`privacy.search`, `privacy.export`, `privacy.deleted`, `privacy.pseudonymized`), damit die Bearbeitung der Anfrage nachweisbar ist.

**Was bleibt:** Das Audit-Protokoll ist unveränderlich (verkettet) und wird erst nach der Audit-Frist gelöscht (Standard 365 Tage). Name und E-Mail einer Person stehen dort als Handelnde bzw. als Objekt auch nach der Löschung ihres Kontos, ebenso Namen in bestätigten Warnstufen gelöschter Konten bis zur Löschfrist des Warnvorgangs. Grundlage ist die Nachweispflicht (Art. 5 Abs. 2, Art. 17 Abs. 3 DSGVO). IP-Adressen ohne Konto entfernt BlaulichtCMS nach der eingestellten Frist (Standard 30 Tage). Gelöschte Daten bleiben in Sicherungen bis zu deren Ablauf (rund 4 Monate). Was auf Website oder bei Meta veröffentlicht ist, im Beitrag zurückziehen bzw. dort löschen.

## Löschfristen

Alle Fristen stehen an einem Ort: [Einstellungen → Löschfristen](/einstellungen/loeschfristen) (Recht „Datenschutzeinstellungen ändern“, die Fristen für gesperrte Dateien und Sicherheitsereignisse der Upload-Seiten „Medieneinstellungen ändern“) – Medien und Upload-Links, Presse, Warnungen und Verbindungen, Laufprotokolle der Workflows, System- und Audit-Protokoll sowie IP-Adressen ohne Konto. **Was würde gelöscht?** zeigt vorab, was mit den gespeicherten Fristen fällig ist; „Jetzt anwenden“ (Recht „Löschfristen sofort anwenden“) löscht sofort, sonst erledigt das der Worker stündlich. Wie lange gelöschte Daten in Sicherungen weiterleben, steht unter [Einstellungen → Sicherung](/einstellungen/sicherung).

## Schadsoftwareprüfung (ClamAV)

Uploads lassen sich vor jeder Verarbeitung mit **ClamAV** auf Schadsoftware prüfen. Das schaltet der Betrieb am Docker-Host ein – nicht in der Oberfläche:

1. In der `.env` neben `compose.yaml` eintragen:
   ```
   COMPOSE_PROFILES=clamav
   CLAMAV_HOST=clamav
   ```
2. `docker compose up -d` startet zusätzlich den Dienst `clamav` (erster Start lädt Signaturen, 1–2 Minuten, ca. 1,5–3 GB Arbeitsspeicher).
3. Damit auch große Videos geprüft werden, in `clamd.conf` `StreamMaxLength`, `MaxFileSize` und `MaxScanSize` mindestens auf die maximale Dateigröße anheben – sonst bleiben größere Dateien in der Quarantäne ([Optionen von clamd](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample), [ClamAV im Container](https://docs.clamav.net/manual/Installing/Docker.html)).

Treffer werden gelöscht und gemeldet; ist ClamAV länger nicht erreichbar, bleiben Uploads in der Quarantäne und die Administration erhält eine Meldung. Einzelheiten und Restrisiko ohne ClamAV: `docs/betrieb.md`, Abschnitt „Schadsoftwareprüfung“.

## Audit-Weiterleitung

Das Audit-Protokoll lässt sich zusätzlich an eine **zentrale Protokollierung** weiterleiten – eine Kopie außerhalb des Servers macht nachträgliche Änderungen erkennbar. Ob sie aktiv ist, zeigt **Systemstatus → Audit-Integrität → Weiterleitung**. Eingeschaltet wird sie am Docker-Host in der `.env`:

| Variable | Wirkung |
|---|---|
| `AUDIT_FORWARD=stdout` | jeder Eintrag zusätzlich als JSON-Zeile im Container-Protokoll – ein Docker-Logging-Treiber (z. B. `journald`, `syslog`, `gelf`) oder Log-Sammler übernimmt sie |
| `AUDIT_FORWARD=syslog` | direkt per Syslog; dazu `AUDIT_SYSLOG_HOST`, `AUDIT_SYSLOG_PORT` (Standard 514) und `AUDIT_SYSLOG_PROTOCOL` (`udp` oder `tcp`) |

Danach `docker compose up -d`. Weitergeleitet werden alle Einträge und nach jedem Versiegeln ein Kontrollpunkt; stimmt der letzte Kontrollpunkt im zentralen Protokoll nicht mit *Letztes Siegel* im Systemstatus überein, wurde das Audit verändert. Einzelheiten: `docs/betrieb.md`.

## Bei einem Sicherheitsvorfall

1. **Sofort die Administration informieren** – bei verlorenem Telefon, verdächtigen Meldungen, einem Upload-Link in
   falschen Händen oder einer verlorenen Sicherung.
2. Die Administration sperrt betroffene Zugänge: Konto deaktivieren oder „Auf allen Geräten abmelden“ (beendet alle
   Sitzungen und entfernt gemerkte Geräte), Zwei-Faktor zurücksetzen, Website-Kopplung, Upload-Link, API- oder
   FE2-Schlüssel widerrufen bzw. erneuern.
3. Belege sichern: Audit-Protokoll (Filter „Fehlgeschlagen“/„Verweigert“), Systemstatus → Audit-Integrität.
4. Informationssicherheit und Datenschutz einbeziehen: Sind personenbezogene Daten betroffen, muss eine meldepflichtige
   Verletzung **innerhalb von 72 Stunden** an die Aufsichtsbehörde gemeldet werden.

Einzelheiten (Meldeweg, Auswertungsintervalle, Sofortmaßnahmen) stehen in der Betriebsdokumentation
(`docs/betrieb.md`, Abschnitt „Protokollierung und Sicherheitsvorfälle“).

## Was ihr tun solltet

- BlaulichtCMS nur über HTTPS erreichbar machen.
- Zwei-Faktor-Pflicht für Administration und Medienverwaltung eingeschaltet lassen; für Rollen mit Warnentwurf am besten „Zwei-Faktor für alle“. Bei Installationen aus der Zeit vor dieser Einstellung ist die Pflicht für Medienverwaltung zunächst aus – bitte unter Einstellungen → Sicherheit einschalten.
- Upload-Links nur so lange gültig machen wie nötig und nach Gebrauch widerrufen.
- Den Master-Schlüssel und die Sicherungen getrennt aufbewahren. Bei Verdacht auf Offenlegung den Master-Schlüssel wechseln (Betriebsdokumentation, Abschnitt „Master-Schlüssel wechseln“).
