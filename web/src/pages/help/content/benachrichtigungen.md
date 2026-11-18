Benachrichtigungen erscheinen immer in der **Glocke**. Zusätzlich kann jede Person wählen, welche Arten sie **per Push** auf ihre Geräte und/oder **per E-Mail** bekommt. E-Mails verschickt BlaulichtCMS über **SMTP** oder über **Microsoft 365** (wie LiFeOS).

## Push und E-Mail für das eigene Konto

Unter [Mein Konto → Benachrichtigungen](/profil#benachrichtigungen):

- **Push auf diesem Gerät** einschalten: Der Browser fragt einmal, ob BlaulichtCMS Mitteilungen anzeigen darf. Push wird **je Browser bzw. installierter App** eingeschaltet – auf Handy und Laptop also jeweils einmal.
- **Testnachricht senden** prüft, ob die Mitteilung ankommt.
- **Weitere Geräte** zeigt alle Geräte mit Push, wann zuletzt zugestellt wurde und ob ein Gerät nicht erreichbar war. Nicht mehr genutzte Geräte hier entfernen.
- **Arten:** eine Tabelle mit **Glocke**, **Push** und **E-Mail** je Art – an einer Stelle, ohne doppelte Einträge. Angeboten werden nur Arten, für die das Konto die nötigen Rechte hat – wer z. B. nichts freigeben darf, sieht „Freigabe angefordert“ nicht. Ohne Haken bei **Glocke** erscheint die Art nicht mehr in der Glocke und zählt nicht mit; **Sicherheitsmeldungen** und Meldungen zum **eigenen Konto** bleiben immer in der Glocke.

| Art | Wer sie bekommen kann | Vorgabe |
|---|---|---|
| Freigabe angefordert | Rechte zum Freigeben (Beiträge, Banner, Einsatzliste, Warnentwürfe, Antworten an die Presse, Workflows) – eine Meldung je Art, siehe [unten](#freigabe-anfragen-gebuendelt-und-erledigt) | Push |
| Eigene Fassung freigegeben oder zurückgewiesen | wer Fassungen einreicht | Push |
| Einsatz-Eingang (FE2, Feuersoftware Connect) | Beiträge bearbeiten | Push |
| Neue Entwürfe aus Workflows | Beiträge bearbeiten, Warnentwurf erstellen | – |
| Neue Dateien über Upload-Links | Medien sichten | Push |
| Upload-Links und Kontingente | Medien sichten | – |
| Speicherplatz der Medien | Medien administrieren | E-Mail |
| Amtliche Warnungen (z. B. DWD, MoWaS) | Amtliche Warnungen ansehen | Push |
| Veröffentlichungen | Auf Website/sozialen Netzwerken veröffentlichen, Banner veröffentlichen | – |
| Versand von Warnentwürfen | Warnentwurf versenden | Push und E-Mail |
| Verbindungsfehler | Verbindungen verwalten, Websites koppeln | E-Mail |
| Workflow fehlgeschlagen | Workflows verwalten | E-Mail |
| Benachrichtigungen aus Workflows | alle (die Aktion „Benachrichtigen“ wählt die Personen) | Push |
| Update verfügbar und installiert | Updates installieren | E-Mail |
| Sicherung fehlgeschlagen | Sicherungen erstellen | E-Mail |
| Sicherheitsmeldungen | Verwaltungsrechte | Push (E-Mail regeln die Sicherheitseinstellungen) |
| Eigenes Konto | alle | Push (E-Mail regeln die Sicherheitseinstellungen) |

Neue Dateien über Upload-Links werden gebündelt: höchstens eine Push-Nachricht bzw. E-Mail je Sammlung und Stunde, weitere Dateien erhöhen nur den Zähler in der Glocke.

## Freigabe-Anfragen: gebündelt und erledigt

Wird etwas zur Freigabe eingereicht, erscheint **eine Meldung je Art** – nicht eine je Vorgang:

- **Ein Vorgang:** „Freigabe erbeten: Tag der offenen Tür“, „Banner zur Freigabe: …“, „Einsatzliste: Freigabe erbeten – …“, „Warnentwurf zur Freigabe: W-2026-0002“, „Antwort zur Freigabe: P-2026-0003“. Der Link führt genau dorthin: Freigabe-Ansicht des Beitrags, Banner hervorgehoben (`/banner?banner=…`), Eintrag der Einsatzliste (`/einsatzliste?eintrag=…`), Schritt „Prüfen & PDF“ des Warnentwurfs, Antwort in der Presseanfrage, Freigabe aus einem Workflow in der [Freigaben-Liste](/hilfe/freigabe#freigaben-liste).
- **Mehrere:** dieselbe Meldung zählt hoch („Einsatzliste: 14 Einträge warten auf Freigabe“, „3 Banner warten auf Freigabe“) und ist für alle wieder ungelesen. Der Link führt auf die passend gefilterte Liste – bei der Einsatzliste auf „Zur Freigabe“ (`/einsatzliste?stand=in_review&jahr=alle`, dort lassen sich mehrere auf einmal freigeben), sonst auf die Freigaben-Liste mit dieser Art. Push und E-Mail kommen beim ersten Vorgang und erst nach zehn ruhigen Minuten wieder – ein Import oder eine Unwetternacht ergibt eine Mitteilung statt dreißig.
- **Erledigt:** Nach dem Freigeben, Zurückweisen, Ändern (neue Fassung), Zurückziehen, Löschen oder Ablauf zählt die Meldung nur noch die offenen Vorgänge. Ist keiner mehr offen, gilt sie als **erledigt**: Sie zählt bei niemandem mehr als ungelesen und erscheint ausgegraut mit Vermerk, z. B. „Erledigt – freigegeben von Sam, 23:10“. Ältere Einzelmeldungen von vor dieser Bündelung gleicht der Hintergrunddienst ebenso ab.

## Seite Benachrichtigungen

[Übersicht → Benachrichtigungen](/benachrichtigungen) zeigt die Meldungen der letzten 60 Tage. **Alle** oder **Ungelesen** und dazu die **Art**: Freigaben · Veröffentlichungen (auch Einsatz-Eingang und Entwürfe aus Workflows) · Presse · Warnungen · Medien · Workflows · Konto und System. Die Auswahl steht in der Adresse (z. B. `/benachrichtigungen?art=freigaben`). Die Zahl am App-Symbol und an der Glocke zählt nur Ungelesenes, also keine erledigten Freigabe-Anfragen.

## Inhalt von Push und E-Mail

In der Glocke steht die ganze Benachrichtigung – je nach Art z. B. **Stichwort und Ort** eines Einsatzes („Neuer Einsatzentwurf aus FE2: B3 in Musterdorf – Ortsteil“), der **Betreff** einer Mail an das Presse-Postfach oder der Text eines Workflows. **Push-Mitteilungen und E-Mails tragen standardmäßig nur die Art** und einen Link, z. B. „Neuer Einsatz-Eingang – Einzelheiten nach der Anmeldung in BlaulichtCMS“. So erscheinen keine Einsatz- oder Personendaten auf Sperrbildschirmen und in Postfächern außerhalb der Organisation.

Die Administration kann unter [Einstellungen → E-Mail & Push](/einstellungen/e-mail) getrennt einschalten:

- **Einzelheiten in Push-Mitteilungen:** Titel und Text wie in der Glocke. Der Inhalt ist auf dem Weg über den Push-Dienst des Browsers (Google, Mozilla, Apple, Microsoft) Ende-zu-Ende-verschlüsselt, erscheint aber auf dem Gerät – je nach Einstellung des Geräts auch auf dem Sperrbildschirm.
- **Einzelheiten in E-Mail-Benachrichtigungen:** Titel im Betreff, Text in der Mail. E-Mails sind nicht Ende-zu-Ende-verschlüsselt; nur einschalten, wenn die Konten **dienstliche Adressen** haben (nicht die privaten Postfächer Ehrenamtlicher).

Testnachrichten haben einen festen Text. Warnversand, Pressemitteilungen, Antworten auf Presseanfragen und die E-Mails der Sicherheitseinstellungen sind davon nicht betroffen.

### iPhone und iPad

Auf iPhone und iPad funktioniert Push nur in der **installierten App** (Safari → Teilen → „Zum Home-Bildschirm“, ab iOS 16.4). Danach die App öffnen und dort Push einschalten.

### Am Computer

Push funktioniert auch am Computer – im Browser (Chrome, Edge, Firefox, Safari am Mac) oder besser in der **installierten App** ([App installieren](/hilfe/app#am-computer)): eigenes Fenster, Mitteilungen des Betriebssystems und die Zahl ungelesener Benachrichtigungen am App-Symbol. Push in der installierten App einmal **in der App selbst** einschalten. Ein Klick auf die Mitteilung holt ein offenes BlaulichtCMS-Fenster nach vorn und öffnet dort die verlinkte Seite.

- **Im Browser** kommen Mitteilungen, solange der Browser läuft – der BlaulichtCMS-Tab muss nicht offen sein. Ist der Browser ganz geschlossen, werden sie beim nächsten Start nachgeliefert, sofern der Push-Dienst sie noch bereithält.
- **Firefox** kann BlaulichtCMS am Computer nicht als App installieren; Push im Browser funktioniert dort trotzdem.
- **Windows:** Unter **Einstellungen → System → Benachrichtigungen** müssen Benachrichtigungen insgesamt und für den Browser bzw. die App „BlaulichtCMS“ eingeschaltet sein. **Nicht stören** (auch automatisch, z. B. außerhalb der Arbeitszeit oder beim Präsentieren) hält Mitteilungen zurück; dort lässt sich BlaulichtCMS als Ausnahme mit Priorität zulassen ([Microsoft-Support](https://support.microsoft.com/de-de/help/4028678/windows-10-change-notification-settings)).
- **macOS:** Unter **Systemeinstellungen → Mitteilungen** den Browser bzw. die Web-App „BlaulichtCMS“ wählen und Mitteilungen erlauben; ein aktiver **Fokus** (z. B. „Nicht stören“) hält sie zurück ([Apple-Support](https://support.apple.com/de-de/104996)).

### Push kommt nicht an

- **Im Browser blockiert:** In den Website-Einstellungen des Browsers Mitteilungen für die BlaulichtCMS-Adresse erlauben, dann erneut einschalten.
- **Betriebssystem:** Fokus-/Nicht-stören-Modi und Energiesparfunktionen können Mitteilungen zurückhalten.
- **Gerät entfernt:** Meldet der Push-Dienst ein Abo als erloschen (z. B. Browserdaten gelöscht), entfernt BlaulichtCMS das Gerät automatisch – Push dann neu einschalten.
- Push braucht eine Adresse mit **HTTPS**.

## E-Mail und Push einrichten

Unter [Einstellungen → E-Mail & Push](/einstellungen/e-mail) (Recht „E-Mail-Versand und Push einstellen“) – eine Seite, eine Speichern-Leiste:

- **Versandweg für alle E-Mails:** [SMTP-Server](#smtp-einrichten) oder [Microsoft 365](#microsoft-365) – beide samt Zugangsdaten und **Testmail** an dieser Stelle. Er gilt für Einladungen, Benachrichtigungen, Sicherheitsmeldungen, Pressemitteilungen, Presseantworten, Workflows und den Warnversand. Den **Testmodus** des Warnversands gibt es weiter unter [Einrichtung → Stichwörter & Regeln](/stichwoerter-regeln) (Reiter *Testmodus*).
- **Push- und E-Mail-Benachrichtigungen** global ein- oder ausschalten.
- **Inhalt außerhalb von BlaulichtCMS:** ob Push-Mitteilungen bzw. E-Mails Einzelheiten tragen oder nur die Art (Standard), siehe [Inhalt von Push und E-Mail](#inhalt-von-push-und-e-mail).
- **Push-Schlüssel:** BlaulichtCMS erzeugt das Schlüsselpaar für Web Push (VAPID) selbst; der private Schlüssel liegt verschlüsselt auf dem Server. „Schlüssel erneuern“ macht alle Push-Abos ungültig – alle Geräte müssen Push neu einschalten.

Geänderter Server, Benutzer, Absender, ein neues Passwort bzw. Geheimnis und der Wechsel des Versandwegs verlangen eine Bestätigung mit dem eigenen Passwort, stehen im Audit-Protokoll und lösen eine Sicherheitsmeldung aus.

## SMTP einrichten

Server, Port, Verschlüsselung, Benutzer, Passwort und Absender des Postausgangsservers. Das Passwort wird verschlüsselt gespeichert und nie wieder angezeigt; ein leeres Feld behält das gespeicherte Passwort – aber nur für denselben Server.

**Testmail:** Felder ausfüllen (Speichern noch nicht nötig), unter **Testmail an** eine eigene Adresse eintragen und **Testmail senden** – gesendet wird mit den Werten im Formular. Ist der Warnversand im Echtbetrieb (Testmodus aus), lassen sich geänderte SMTP-Angaben bzw. der Wechsel auf SMTP erst nach einer erfolgreichen Testmail mit genau diesen Werten speichern (höchstens 60 Minuten alt).

### Woher die Zugangsdaten kommen

Die Werte stellt die eigene **IT** bzw. der **E-Mail-Anbieter** der Organisation bereit. Am besten ein eigenes Postfach nur für BlaulichtCMS anlegen lassen (z. B. `warnung@…`) und erfragen:

| Feld | Bedeutung |
|---|---|
| Server | Postausgangsserver (SMTP), z. B. `smtp.example.org` |
| Port und Verschlüsselung | meist 587 mit STARTTLS oder 465 mit TLS (siehe unten) |
| Benutzer | Anmeldename des Postfachs, meist die vollständige E-Mail-Adresse |
| Passwort | Passwort des Postfachs bzw. ein App-Passwort |
| Absender | Adresse, die als Absender erscheint, optional mit Namen (`Feuerwehr Musterstadt <presse@example.org>`) – muss zum Postfach passen bzw. für das Postfach freigegeben sein. Antworten auf Presseanfragen und Pressemitteilungen verwenden dieselbe Adresse; der Name kommt von hier, sonst aus *Einstellungen → Organisation → Absendername* |

### Port und Verschlüsselung

| Einstellung | Port | Ablauf |
|---|---|---|
| STARTTLS | 587 | Verbindung beginnt unverschlüsselt und wird vor der Anmeldung verschlüsselt. BlaulichtCMS verlangt die Verschlüsselung – ohne sie wird nicht gesendet. |
| TLS | 465 | Verbindung ist von Anfang an verschlüsselt. |
| keine | z. B. 25 | nur für Testserver ohne Anmeldung. Mit Benutzer oder Passwort lehnt BlaulichtCMS das Speichern ab, damit Zugangsdaten nie unverschlüsselt übertragen werden. |

### Werte bekannter Anbieter

Stand der Angaben: November 2026, jeweils aus der Hilfe des Anbieters. Im Zweifel gilt die Auskunft des Anbieters.

| Anbieter | Server | Port / Verschlüsselung | Hinweis |
|---|---|---|---|
| Microsoft 365 | `smtp.office365.com` | 587 / STARTTLS | „Authentifiziertes SMTP“ muss für das Postfach eingeschaltet sein; Microsoft schränkt die Anmeldung mit Passwort (Basic Auth) ab Ende 2026 ein ([Einrichtung](https://learn.microsoft.com/de-de/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365), [SMTP AUTH einschalten](https://learn.microsoft.com/de-de/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission), [Zeitplan](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835)) |
| IONOS | `smtp.ionos.de` | 587 / STARTTLS oder 465 / TLS | [IONOS-Hilfe](https://www.ionos.de/hilfe/e-mail/problemloesungen-mail-basicmail-business/die-einrichtung-des-e-mail-programms-schlaegt-fehl/) |
| STRATO | `smtp.strato.de` | 465 / TLS | Benutzer = vollständige E-Mail-Adresse ([STRATO-FAQ](https://www.strato.de/faq/mail/e-mailserver-adressen-ports-ssl-tls/)) |
| GMX | `mail.gmx.net` | 587 / STARTTLS | POP3/IMAP-Zugriff muss im Postfach eingeschaltet sein ([Serverdaten](https://hilfe.gmx.net/pop-imap/pop3/serverdaten.html), [einschalten](https://hilfe.gmx.net/pop-imap/einschalten.html)) |
| WEB.DE | `smtp.web.de` | 587 / STARTTLS | POP3/IMAP ist ab Werk aus ([Serverdaten](https://hilfe.web.de/pop-imap/imap/outlook.html), [einschalten](https://hilfe.web.de/pop-imap/einschalten.html)) |
| Google Workspace / Gmail | `smtp.gmail.com` | 587 / STARTTLS oder 465 / TLS | nur mit App-Passwort, das die Bestätigung in zwei Schritten voraussetzt ([Google-Hilfe](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app?hl=de), [App-Passwörter](https://support.google.com/accounts/answer/185833?hl=de)) |

### SPF, DKIM und DMARC

Damit Warnmails nicht im Spam landen, muss der Mailserver für die Absenderdomain berechtigt sein:

- **SPF** – im DNS der Domain steht, welche Server Mails für sie versenden dürfen.
- **DKIM** – der Mailserver signiert jede Mail; der Empfänger prüft die Signatur über einen Schlüssel im DNS.
- **DMARC** – legt fest, wie Empfänger mit Mails umgehen, die SPF/DKIM nicht bestehen.

Bei einem Postfach beim eigenen Anbieter richtet das in der Regel der Anbieter bzw. die IT ein. Eine kurze Erklärung gibt das BSI unter [Technischer Hintergrund E-Mail-Sicherheit](https://www.bsi.bund.de/DE/Themen/Verbraucherinnen-und-Verbraucher/Informationen-und-Empfehlungen/Onlinekommunikation/E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit_node.html).

### Typische Fehler (E-Mail)

| Meldung | Ursache |
|---|---|
| „Invalid login“, „Authentication failed“ (535) | Benutzer oder Passwort falsch; bei Microsoft 365 „Authentifiziertes SMTP“ aus; bei Google kein App-Passwort; bei GMX/WEB.DE Zugriff nicht eingeschaltet. |
| „Greeting never received“, Zeitüberschreitung | falscher Port oder Verschlüsselung (465 braucht TLS, 587 STARTTLS) oder Port durch eine Firewall gesperrt. |
| „Sender address rejected“ / „Send as denied“ | Absender passt nicht zum Postfach. |
| Testmail kommt nicht an, aber „angenommen“ | Spam-Ordner prüfen; SPF/DKIM der Absenderdomain mit der IT klären. |

## Microsoft 365

Mit Microsoft 365 meldet sich BlaulichtCMS **als Anwendung** bei Microsoft an und sendet über Microsoft Graph aus einem Postfach – ohne Postfach-Passwort, ohne angemeldete Person und ohne „Authentifiziertes SMTP“. Nötig sind Verzeichnis-ID (Tenant-ID), Anwendungs-ID (Client-ID), ein Client-Geheimnis und das Absenderpostfach.

**Erst testen, dann aktivieren:** Wie bei den Verbindungen lässt sich Microsoft 365 erst speichern, nachdem mit genau diesen Angaben eine **Testmail** erfolgreich versendet wurde (gilt 60 Minuten). Das Client-Geheimnis wird verschlüsselt gespeichert und nie wieder angezeigt; ein leeres Feld behält das gespeicherte Geheimnis, solange Verzeichnis und Anwendung gleich bleiben. Umschalten des Versandwegs und ein neues Geheimnis verlangen eine Bestätigung mit dem Passwort, stehen im Audit-Protokoll und lösen eine Sicherheitsmeldung aus.

Ist der Warnversand im Echtbetrieb, gilt die Testmail über Microsoft 365 als Nachweis für das Ausschalten des Testmodus; zurück auf SMTP geht es dann nur mit einer frischen SMTP-Testmail genau der eingetragenen Angaben.

### App-Registrierung in Microsoft Entra

Das erledigt die Administration von Microsoft 365 (Rolle mindestens „Anwendungsadministrator“, für die Zustimmung „Privilegierter Rollenadministrator“ oder „Globaler Administrator“):

1. Im [Microsoft Entra Admin Center](https://entra.microsoft.com) unter **App-Registrierungen → Neue Registrierung** eine App anlegen, z. B. „BlaulichtCMS Mailversand“, Kontotyp „Nur Konten in diesem Organisationsverzeichnis“, ohne Umleitungs-URI ([Anleitung von Microsoft](https://learn.microsoft.com/de-de/entra/identity-platform/quickstart-register-app)).
2. Auf der Übersichtsseite **Anwendungs-ID (Client)** und **Verzeichnis-ID (Mandant)** kopieren.
3. Unter **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel** ein Geheimnis erzeugen und den **Wert** sofort kopieren – er wird nur einmal angezeigt ([Anmeldeinformationen verwalten](https://learn.microsoft.com/de-de/entra/identity-platform/how-to-add-credentials)). Ablaufdatum im Kalender notieren: Danach schlägt der Versand fehl, bis ein neues Geheimnis eingetragen ist.
4. Unter **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Anwendungsberechtigungen** die Berechtigung **Mail.Send** wählen (nicht „Delegiert“) – siehe [user: sendMail](https://learn.microsoft.com/de-de/graph/api/user-sendmail).
5. **Administratorzustimmung für … erteilen** ([mandantenweite Zustimmung](https://learn.microsoft.com/de-de/entra/identity/enterprise-apps/grant-admin-consent)).
6. In BlaulichtCMS die Werte eintragen, Absenderpostfach angeben (z. B. ein freigegebenes Postfach „presse@…“), **Testmail senden**, dann **Microsoft 365** wählen und speichern.

Angemeldet wird mit dem OAuth-2.0-Verfahren für Anwendungen ([Client-Credentials-Flow](https://learn.microsoft.com/de-de/entra/identity-platform/v2-oauth2-client-creds-grant-flow)); BlaulichtCMS verbindet sich dafür nur mit `login.microsoftonline.com` und `graph.microsoft.com`.

### Zugriff auf ein Postfach beschränken

Die Anwendungsberechtigung **Mail.Send gilt für alle Postfächer** der Organisation. Damit die App nur aus dem gewünschten Postfach senden kann, den Zugriff in Exchange Online beschränken:

- **Empfohlen: RBAC für Anwendungen in Exchange Online.** Statt Mail.Send in Entra zu erteilen, weist die Exchange-Administration der App die Rolle „Application Mail.Send“ mit einem Bereich zu, der nur das Absenderpostfach enthält (`New-ManagementRoleAssignment … -Role "Application Mail.Send" -CustomResourceScope …`). Wichtig: Eine in Entra erteilte Mail.Send-Berechtigung gilt **zusätzlich** – sie muss dann entfernt werden ([RBAC für Anwendungen, Microsoft Learn](https://learn.microsoft.com/de-de/exchange/permissions-exo/application-rbac)).
- **Bisheriger Weg: Anwendungszugriffsrichtlinie** (`New-ApplicationAccessPolicy -AccessRight RestrictAccess` mit einer E-Mail-aktivierten Sicherheitsgruppe, die das Postfach enthält). Microsoft beschreibt auf derselben Seite, wie man von dort zu RBAC für Anwendungen wechselt.

Änderungen an diesen Rechten können bei Microsoft einige Zeit brauchen, bis sie wirken. Eine Testmail aus einem nicht freigegebenen Postfach muss danach mit „Keine Berechtigung“ scheitern.

### Fehlermeldungen

| Meldung | Ursache und Abhilfe |
|---|---|
| Client-Geheimnis ungültig | Den **Wert** des Geheimnisses eintragen (nicht die Geheimnis-ID); abgelaufene Geheimnisse ersetzen. |
| Anwendung nicht gefunden / Verzeichnis nicht gefunden | Client-ID bzw. Tenant-ID prüfen. |
| Keine Berechtigung | Mail.Send als **Anwendungs**berechtigung mit Administratorzustimmung erteilen bzw. das Postfach für die App freigeben (siehe oben). |
| Absenderpostfach nicht gefunden | Adresse prüfen; das Postfach muss in Exchange Online liegen. |
| zu groß | Microsoft Graph nimmt Nachrichten bis etwa 3 MB samt Anhang an (Warnentwurf-PDF bleibt in der Regel deutlich darunter). |

Bei vorübergehender Drosselung durch Microsoft (429/503) versucht BlaulichtCMS es zweimal erneut. Bricht die Verbindung erst nach dem Senden ab, gilt der Versand eines Warnentwurfs wie bei SMTP als „Ergebnis unbekannt“ und wird nie automatisch wiederholt.
