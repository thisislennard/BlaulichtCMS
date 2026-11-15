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
| Geheimnisse | Verschlüsselt mit AES-256-GCM; der Master-Schlüssel liegt nie in der Datenbank |
| Protokolle | Audit mit Person und Zeitpunkt, verkettet und versiegelt (nachträgliche Änderungen fallen bei der Prüfung im Systemstatus auf), optional an eine zentrale Protokollierung weitergeleitet, auch für verweigerte Zugriffe, falsche Website- oder FE2-Schlüssel und beendete Sitzungen (Serien gedrosselt auf einen Eintrag je 10 Minuten); geänderte Einstellungen mit altem und neuem Wert (unter „Details“ im Audit-Protokoll); IP-Adressen ohne Benutzerkonto (z. B. öffentliche Uploads) nur 30 Tage (einstellbar unter Einstellungen → Redaktion); Tokens und vertrauliche Inhalte werden nicht protokolliert |
| Sicherheitsmeldungen | Benachrichtigung (und auf Wunsch E-Mail) an die Administration bei Kontosperren, benutzten Wiederherstellungscodes, vergebenen oder entzogenen Admin-Rechten, zurückgesetzter oder abgeschalteter Zwei-Faktor-Anmeldung, geänderten Sicherheits- und Aufbewahrungseinstellungen, gehäuften Fehlversuchen, falschen Website-, FE2- oder API-Schlüsseln, neuen Website-Kopplungen, ungewöhnlich vielen Downloads, erkannter Schadsoftware in Uploads, länger nicht verfügbarer Schadsoftwareprüfung und Auffälligkeiten im Audit; die betroffene Person erfährt von Passwort- und Zwei-Faktor-Änderungen. Einstellbar unter Einstellungen → Sicherheit |
| Container | Unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities |

## Datenschutzanfragen (Auskunft und Löschung)

Unter [Datenschutzanfragen](/datenschutz-anfragen) (Recht „Datenschutzanfragen bearbeiten“, standardmäßig nur Administration) lassen sich alle Daten zu einer Person finden: Suche nach Name, E-Mail, Telefonnummer, Dateiname, Text aus dem Uploader-Hinweis, **Vorgangsnummer** oder IP-Adresse. Durchsucht werden Uploads, unterbrochene Uploads, Warnvorgänge (Rückrufkontakt, Empfänger, Rückmeldungen), Zuständigkeiten, FE2-Meldungen, Beiträge, Konten, Sitzungen und das Audit.

- **Vorgangsnummer:** Nach dem Hochladen zeigt die Upload-Seite eine Nummer wie `K7M2-Q9XD`. Sie gilt für alle Dateien dieses Besuchs; wer sie nennt, lässt sich ohne Namen zuordnen.
- **Auskunft als ZIP:** alle Treffer als `auskunft.json` und die hochgeladenen Originale. Vor der Herausgabe prüfen, ob Daten anderer Personen enthalten sind (z. B. andere Personen auf Fotos, Namen im Audit).
- **Löschen oder pseudonymisieren** je Treffer: Dateien (nicht, solange ein laufender Beitrag sie verwendet – dort zuerst aus der Fassung nehmen bzw. zurückziehen), unterbrochene Uploads, Warnvorgänge (der ganze Vorgang) und FE2-Meldungen. Pseudonymisieren ersetzt Dateiname und Hinweis, die Datei bleibt. Konten löscht die Verwaltung unter Benutzer.
- Suche, Export und jede Löschung stehen im Audit (`privacy.search`, `privacy.export`, `privacy.deleted`, `privacy.pseudonymized`), damit die Bearbeitung der Anfrage nachweisbar ist.

**Was bleibt:** Das Audit-Protokoll ist unveränderlich (verkettet) und wird erst nach der Audit-Frist gelöscht (Standard 365 Tage). Name und E-Mail einer Person stehen dort als Handelnde bzw. als Objekt auch nach der Löschung ihres Kontos, ebenso Namen in bestätigten Warnstufen gelöschter Konten bis zur Löschfrist des Warnvorgangs. Grundlage ist die Nachweispflicht (Art. 5 Abs. 2, Art. 17 Abs. 3 DSGVO). IP-Adressen ohne Konto entfernt BlaulichtCMS nach der eingestellten Frist (Standard 30 Tage). Gelöschte Daten bleiben in Sicherungen bis zu deren Ablauf (rund 4 Monate). Was auf Website oder bei Meta veröffentlicht ist, im Beitrag zurückziehen bzw. dort löschen.

Löschfristen für alle Datenarten stehen unter **Einstellungen → Datenschutz** (mit Probelauf „Was würde gelöscht?“).

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
