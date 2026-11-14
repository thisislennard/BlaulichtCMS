LifeLink kann E-Mails auf zwei Wegen senden und auf einem Weg empfangen:

| Integration | Wofür | Baustein |
|---|---|---|
| **E-Mail (SMTP)** | Senden über einen eigenen Mailserver oder Mailanbieter | **E-Mail senden** |
| **Microsoft 365** | Senden aus einem Microsoft-365-Postfach über Microsoft Graph | **E-Mail senden (M365)** |
| **E-Mail-Postfach (IMAP)** | Neue E-Mails in einem Postfach als Auslöser | Trigger **Neue E-Mail** |

## E-Mail über SMTP

### Verbindung anlegen

1. [Schnittstellen](/schnittstellen) → **E-Mail (SMTP)** → verbinden.
2. Ausfüllen:

| Feld | Beispiel | Hinweis |
|---|---|---|
| Server | `smtp.ionos.de` | |
| Verschlüsselung | STARTTLS (Port 587) oder TLS (Port 465) | Unverschlüsselt geht nicht. Der Port wird beim Umschalten automatisch angepasst. |
| Benutzername | `lifelink@feuerwehr-musterstadt.de` | |
| Passwort | | wird verschlüsselt gespeichert |
| Absender | `LifeLink <lifelink@feuerwehr-musterstadt.de>` | muss zum Konto passen, sonst lehnen viele Server ab |

3. **Verbindung testen**: LifeLink löst den Servernamen auf, baut die verschlüsselte Verbindung auf und prüft die Anmeldung. Es wird **keine** Test-E-Mail verschickt.

### Der Baustein „E-Mail senden“

- **Empfänger**, **CC**, **BCC**: feste Adressen, zusammen höchstens 50. Variablen sind hier nicht erlaubt – [warum](/hilfe/variablen#warum-empfaenger-keine-variablen-sein-duerfen).
- **Betreff** und **Nachricht** dürfen Variablen enthalten.
- **Format**: nur Text oder **Text + HTML**. In der HTML-Version werden eingesetzte Variablen automatisch HTML-maskiert. Die Textversion wird immer mitgeschickt.

**Beispiel** für eine Einsatzinfo an die Wehrführung:

```text
Betreff: Einsatz {{ alamos.stichwort }} – {{ alamos.stichwort_text }}

Alarmierung um {{ alamos.alarmzeit | date:"HH:mm" }} Uhr
Ort: {{ alamos.ortsteil | default:alamos.stadt }}
Einheiten: {{ alamos.einheiten | join:", " }}
```

> **Achtung:** „E-Mail senden“ ist **nicht wiederholungssicher**. Bricht die Verbindung ab, nachdem die E-Mail übergeben wurde, weiß LifeLink nicht, ob sie angekommen ist. Der Lauf bekommt dann den Status „Prüfen“. Siehe [Ausführungen verstehen](/hilfe/ausfuehrungen#status-pruefen).

Jede E-Mail trägt den Header `X-LifeLink-Run` mit der Laufnummer – praktisch, um sie im Postfach einem Lauf zuzuordnen.

## Microsoft 365

Für Microsoft 365 braucht LifeLink eine **App-Registrierung** in Microsoft Entra ID. Die Einrichtung dauert etwa 10 Minuten und braucht eine Person mit Admin-Rechten im Microsoft-365-Mandanten.

### App-Registrierung anlegen

1. Im **Microsoft Entra Admin Center**: **App-Registrierungen → Neue Registrierung**. Name z. B. „LifeLink“, nur Konten in diesem Verzeichnis.
2. Notiert die **Anwendungs-ID (Client)** und die **Verzeichnis-ID (Tenant)** von der Übersichtsseite.
3. **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Anwendungsberechtigungen → `Mail.Send`**.
4. **Administratorzustimmung erteilen**.
5. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel**. Kopiert den **Wert** sofort (er wird nur einmal angezeigt) und notiert das **Ablaufdatum**.

### Auf ein Postfach begrenzen

Die Berechtigung `Mail.Send` erlaubt ohne Einschränkung, aus **jedem** Postfach des Mandanten zu senden. Begrenzt sie deshalb mit einer **Application Access Policy** auf das eine Absender-Postfach. Beispiel mit Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline
New-DistributionGroup -Name "LifeLink-Absender" -Type Security -Members lifelink@feuerwehr-musterstadt.de
New-ApplicationAccessPolicy -AppId "<Anwendungs-ID>" -PolicyScopeGroupId "LifeLink-Absender" `
  -AccessRight RestrictAccess -Description "LifeLink darf nur aus diesem Postfach senden"
Test-ApplicationAccessPolicy -Identity lifelink@feuerwehr-musterstadt.de -AppId "<Anwendungs-ID>"
```

Je nach Mandant kann Microsoft statt Application Access Policies auch die neueren rollenbasierten Zugriffe für Anwendungen in Exchange Online vorsehen. Entscheidend ist: Die App darf nur aus dem einen Postfach senden.

### Verbindung in LifeLink

1. [Schnittstellen](/schnittstellen) → **Microsoft 365** → verbinden.
2. **Verzeichnis-ID (Tenant)**, **Anwendungs-ID (Client)**, **Absender-Postfach** und **geheimen Clientschlüssel** eintragen.
3. Tragt das **Ablaufdatum** des Clientschlüssels in der Verbindung ein. LifeLink warnt euch 14 Tage vorher mit einer Benachrichtigung.
4. **Verbindung testen**: LifeLink fordert bei Microsoft ein Zugriffstoken an.

Der Baustein **E-Mail senden (M365)** hat feste Empfänger, Betreff und Nachricht (Text). Gesendete E-Mails landen im Ordner „Gesendete Elemente“ des Absender-Postfachs.

## Neue E-Mails als Auslöser (IMAP)

Mit dem Trigger **Neue E-Mail** startet ein Lauf für jede neue E-Mail in einem Postfach – etwa für Meldungen der Leitstelle, die per E-Mail kommen.

### Verbindung

| Feld | Hinweis |
|---|---|
| Server, Port | nur verschlüsselt (TLS, Port 993) |
| Benutzername, Passwort | am besten ein eigenes Postfach nur für LifeLink |
| Ordner | Standard `INBOX` |

LifeLink **liest nur**: E-Mails werden weder gelöscht noch verschoben noch als gelesen markiert.

### Trigger-Einstellungen

- **Prüfen alle (Minuten)**: Standard 5.
- **Nur von Absender (enthält)** und **Nur mit Betreff (enthält)**: z. B. `leitstelle@` oder `Einsatzinfo`.

Beim **ersten Abruf** werden vorhandene E-Mails übersprungen – es zählen nur E-Mails, die danach eingehen. Pro Abruf werden höchstens 25 neue E-Mails verarbeitet, der Rest beim nächsten Mal.

Im Workflow stehen `from`, `from_name`, `subject`, `date` und `text` bereit, z. B. `{{ mail.subject }}`. Der Text ist der Rohinhalt der E-Mail, gekürzt auf 20.000 Zeichen; mit `| strip_html` entfernt ihr HTML-Auszeichnungen.

## E-Mail kommt nicht an?

1. Im [Ausführungsverlauf](/ausfuehrungen) den Lauf öffnen: Steht bei „E-Mail senden“ **Erfolgreich** und unter Ausgabe der Empfänger bei `accepted`, hat der Mailserver die E-Mail angenommen.
2. Dann liegt es meist am Empfang: **Spam-Ordner** prüfen, beim Empfänger nach der Absenderadresse suchen.
3. Absender passt nicht zum Konto → viele Server lehnen ab oder markieren als Spam. Absender in der Verbindung korrigieren.
4. „Der Mailserver hat die Anmeldung abgelehnt“ → Passwort in der Verbindung ersetzen. Bei Microsoft 365 und Google oft ein **App-Passwort** nötig.
5. Mailserver im eigenen Netz → in der Verbindung **Interne Ziele erlauben** einschalten.
