Presseanfragen von Redaktionen erfassen und bis zur Erledigung nachverfolgen – mit Zuständigkeit, Frist, Verknüpfung zu Einsatz und Beitrag und einem vollständigen Verlauf. Zu finden unter [Presse → Presseanfragen](/presse).

## Anfrage erfassen

1. [Presseanfragen](/presse) → **Anfrage erfassen** (z. B. nach einem Anruf).
2. **Thema** (Pflicht), Anfragetext, **Medium/Redaktion**, Name, E-Mail und Telefon der anfragenden Person und den **Eingangsweg** (Telefon, E-Mail, persönlich, sonstiges) eintragen.
3. Optional gleich die **zuständige Person** und eine **Frist** setzen.

Jede Anfrage bekommt eine Vorgangsnummer (`P-Jahr-Nummer`). Alle mit „Presseanfragen bearbeiten“ erhalten eine Benachrichtigung – ohne Kontaktdaten der anfragenden Person.

## Status, Zuständigkeit und Frist

| Status | Bedeutung |
|---|---|
| **Neu** | eingegangen, noch nicht bearbeitet |
| **In Bearbeitung** | jemand kümmert sich darum |
| **Beantwortet** | Antwort ist raus (wird beim Senden aus BlaulichtCMS automatisch gesetzt) |
| **Erledigt** | abgeschlossen; ab jetzt läuft die Löschfrist |

Status, **Zuständig** und **Frist** stehen in der Anfrage rechts unter *Bearbeitung*. Wer zuständig wird, bekommt eine Benachrichtigung.

**Erinnerung:** Vor Ablauf der Frist (Standard 2 Stunden vorher, *Einstellungen → Redaktion → Erinnerung vor Frist*) und bei Überschreitung kommt je eine Benachrichtigung – an die zuständige Person, ohne Zuständigkeit an alle mit „Presseanfragen bearbeiten“. Wird die Frist geändert, erinnert BlaulichtCMS erneut. Anfragen mit dem Status *Beantwortet* oder *Erledigt* lösen keine Erinnerung mehr aus. Ob die Benachrichtigung zusätzlich per Push oder E-Mail kommt, wählt jede Person unter [Benachrichtigungen einstellen](/profil) (Art „Presseanfragen“).

## Presse-Postfach abrufen

Mails an ein Presse-Postfach (z. B. `presse@…`) werden automatisch zu Anfragen. Einrichten unter [Presse → Postfach & Textbausteine](/presse/einstellungen) (Recht „Presse-Postfach einrichten“, ab Werk nur Administration).

1. Art wählen: **IMAP** oder **Microsoft 365**, Angaben eintragen (siehe unten).
2. **Verbindung testen** – meldet sich an und zählt die Nachrichten im Ordner, ändert nichts.
3. **Abruf eingeschaltet** – geht nur nach einem erfolgreichen Test mit genau diesen Angaben (höchstens eine Stunde her) und mit Passwortbestätigung.

Der Abruf läuft im eingestellten Abstand (Standard alle 5 Minuten), **Jetzt abrufen** startet ihn sofort. Beim ersten Abruf werden nur Mails der letzten 24 Stunden übernommen. Das Postfach wird **nur gelesen**: nichts wird verschoben, gelöscht oder als gelesen markiert – BlaulichtCMS merkt sich selbst, welche Mails schon da waren.

**Was mit einer Mail passiert:**

| Mail | Ergebnis |
|---|---|
| neue Mail | neue Anfrage (Eingangsweg „Presse-Postfach“): Betreff als Thema, Text als Anfrage, Absender als Kontakt (Antwortadresse, falls angegeben) |
| Antwort im selben Mail-Verlauf (In-Reply-To/References) oder mit der Vorgangsnummer `[P-…]` im Betreff | wird der bestehenden Anfrage zugeordnet; war sie beantwortet oder erledigt, geht sie zurück auf *In Bearbeitung*; die zuständige Person wird benachrichtigt |
| automatische Antwort (Abwesenheitsnotiz, Zustellbericht, `Auto-Submitted`), Newsletter/Massenmail, vom Mailserver als Spam markiert, eigene Mails | ignoriert (steht im Empfangsprotokoll) |
| dieselbe Mail noch einmal (gleiche Message-ID) | ignoriert |

**Anhänge** werden übernommen, wenn sie höchstens so groß sind wie eingestellt (Standard 10 MB je Anhang) und ihr **Inhalt** ein erlaubter Typ ist: PDF, Bilder (JPEG, PNG, GIF, WebP, HEIC), Office- und OpenDocument-Dateien, RTF, Text/CSV/Kalender, Audio (MP3, M4A, WAV) und Video (MP4, MOV). Alles andere (z. B. Programme, Archive) wird nicht übernommen – die Anfrage zeigt, welche Anhänge fehlen und warum. Bilder, die nur in die HTML-Mail eingebettet sind (Logos, Signaturen), entfallen.

**HTML-Mails** zeigt BlaulichtCMS zuerst als Text. **HTML-Ansicht** zeigt die entschärfte Fassung in einem abgeschotteten Bereich: ohne Skripte, ohne Formulare und ohne Bilder aus dem Internet (Zählpixel) – Links öffnen in einem neuen Fenster.

**Empfangsprotokoll:** Jede abgerufene Mail mit Ergebnis (neue Anfrage, zugeordnet, ignoriert und warum, Fehler) – aufbewahrt wie das Empfangsprotokoll der Verbindungen (*Einstellungen → Datenschutz*, Standard 7 Tage). Schlägt der Abruf fehl, kommt **eine** Benachrichtigung an alle mit „Presse-Postfach einrichten“, bis er wieder läuft.

### IMAP einrichten

| Feld | Eintrag |
|---|---|
| IMAP-Server, Port | Angaben des Mailanbieters, z. B. `imap.example.org`, Port 993 |
| Verschlüsselung | **TLS** (Port 993) oder **STARTTLS** (Port 143). Ohne Verschlüsselung geht es nicht – das Passwort würde sonst im Klartext übertragen. Das Zertifikat des Servers muss gültig sein. |
| Benutzername, Passwort | Zugang zum Presse-Postfach. Bei Zwei-Faktor-Anmeldung beim Anbieter ein **App-Passwort** verwenden. Das Passwort liegt verschlüsselt in BlaulichtCMS und wird nie wieder angezeigt. |
| Ordner | meist `INBOX` |

### Microsoft 365 einrichten

Verwendet wird **dieselbe App-Registrierung wie für den Mailversand** (siehe [Benachrichtigungen → Microsoft 365](/hilfe/benachrichtigungen)). Zusätzlich:

1. In der App-Registrierung unter **API-Berechtigungen → Microsoft Graph → Anwendungsberechtigungen** die Berechtigung **Mail.Read** hinzufügen und die **Administratorzustimmung** erteilen. BlaulichtCMS liest die Nachrichtenliste des Posteingangs und den Inhalt jeder neuen Mail ([Nachrichten auflisten](https://learn.microsoft.com/de-de/graph/api/user-list-messages), [MIME-Inhalt abrufen](https://learn.microsoft.com/de-de/graph/outlook-get-mime-message)).
2. **Zugriff auf das Presse-Postfach beschränken:** Mail.Read gilt sonst für alle Postfächer der Organisation. Wie beim Versand über **RBAC für Anwendungen** (Rolle „Application Mail.Read“ mit einem Bereich, der nur das Presse-Postfach enthält) oder eine Anwendungszugriffsrichtlinie ([RBAC für Anwendungen, Microsoft Learn](https://learn.microsoft.com/de-de/exchange/permissions-exo/application-rbac)).
3. In BlaulichtCMS **Microsoft 365** wählen und die Adresse des Presse-Postfachs eintragen.

| Meldung beim Test | Abhilfe |
|---|---|
| Keine Berechtigung | Mail.Read als **Anwendungs**berechtigung mit Administratorzustimmung erteilen bzw. das Postfach in der Beschränkung freigeben |
| Presse-Postfach nicht gefunden | Adresse prüfen; es muss ein Exchange-Online-Postfach sein |
| Microsoft 365 ist noch nicht eingerichtet | zuerst die App-Registrierung unter *Einstellungen → Benachrichtigungen und E-Mail* eintragen |

## Verknüpfungen, Notizen und Verlauf

- **Einsatz:** eine Einsatzmeldung aus FE2 oder Feuersoftware Connect.
- **Beitrag:** z. B. die Pressemitteilung oder der Einsatzbericht zum Thema.
- **Interne Notiz:** nur in BlaulichtCMS sichtbar, nie Teil einer Antwort.

Der **Verlauf** zeigt jede Änderung mit Person und Zeitpunkt (Status, Zuständigkeit, Frist, Verknüpfungen, Notizen, Mails). Geänderte Kontaktdaten stehen dort nur als „geändert“, nicht mit Wert.

## Übersicht und Dashboard

Die Übersicht filtert nach **Offen**, **Überfällig**, **Meine**, **Beantwortet**, **Erledigt** und **Alle** und durchsucht Nummer, Thema, Medium und Name. Fürs [Dashboard](/) gibt es die Kachel **Presseanfragen** (offene Anfragen nach Frist) und die Kennzahl **Offene Presseanfragen** (rot, sobald eine Frist überschritten ist) – über *Dashboard anpassen* einblenden.

## Workflows

Der Eingang **Neue Presseanfrage** startet einen [Workflow](/hilfe/workflows), sobald eine Anfrage erfasst wird oder über das Presse-Postfach eingeht – wahlweise nur für bestimmte Eingangswege. Er liefert nur Felder **ohne Kontaktdaten**: Vorgangsnummer, Thema, Medium, Eingangsweg, Frist, zuständige Person und den Link zur Anfrage.

## Rechte

| Recht | Erlaubt |
|---|---|
| Presseanfragen ansehen | Anfragen mit Kontaktdaten, Verlauf, Mails und Anhängen lesen |
| Presseanfragen bearbeiten | erfassen, Status, Zuständigkeit, Frist, Verknüpfungen, Notizen, löschen |
| Presse-Postfach einrichten | Abruf einrichten, testen, schalten, Empfangsprotokoll |

Ab Werk haben die Rolle **Redaktion** beide Rechte, die Rolle **Lesezugriff** keines (Kontaktdaten). Jede Anlage, Änderung, Notiz und Löschung steht im Audit – mit Vorgangsnummer, ohne Kontaktdaten.

## Datenschutz und Löschfrist

Erledigte Anfragen werden samt Kontaktdaten, Verlauf, Mails und Anhängen **12 Monate nach der Erledigung** gelöscht (*Einstellungen → Datenschutz → Erledigte Presseanfragen*, 0 = nie). Wird eine Anfrage wieder geöffnet, beginnt die Frist bei der nächsten Erledigung neu. Presseanfragen sind Teil der [Datenschutzanfragen](/datenschutz-anfragen) (Suche nach Name, E-Mail, Telefon, Text; Auskunft und Löschung).
