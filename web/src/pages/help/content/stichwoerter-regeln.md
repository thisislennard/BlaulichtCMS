Unter [Stichwörter & Regeln](/warnungen/pflege) werden die Grundlagen des Warnstufen-Assistenten **lokal** gepflegt. BlaulichtCMS wird **ohne aktive Regeln** ausgeliefert – alle Inhalte stimmt die Organisation selbst mit der zuständigen Stelle ab.

## Stichwortverzeichnis der Länder

Unter [Einstellungen → Allgemein](/einstellungen#allgemein) wird das **Bundesland** gewählt (Recht „Allgemeine Einstellungen ändern“). Für Länder mit öffentlichem, amtlichem Verzeichnis übernimmt BlaulichtCMS dessen Einsatzstichworte in die Stichwortliste. Das Verzeichnis ist **wortgetreu** aus der Quelle abgeschrieben; nichts wird ergänzt.

| Land | Quelle | Übernommen |
|---|---|---|
| Hessen | Gemeinsamer Runderlass des HMdI und des HMFG zur Festlegung der Einsatzstichworte für Brand-, Hilfeleistungs- und Rettungsdiensteinsätze vom 30. August 2024, gültig 1. Oktober 2024 bis 31. Dezember 2029 ([PDF](https://familie.hessen.de/sites/familie.hessen.de/files/2024-09/2024-08-30_gemeinsamer_runderlass_einsatzstichworte.pdf)) | 58 Einsatzstichworte mit Meldebild, Kategorien Brand, Hilfeleistung, Unwetter, Rettungsdienst. Abgeglichen mit der Vorgängerfassung vom 1. November 2022 ([PDF](https://innen.hessen.de/sites/innen.hessen.de/files/2022-12/EinsatzstichworteErl-Endversion-gez.pdf)), die am 30. September 2024 außer Kraft trat. |
| Bayern | Einsatzstichwörter, Anlage zu Nr. 2.1.4 der Alarmierungsbekanntmachung (ABek) des Staatsministeriums des Innern, Stand 15.03.2017 ([PDF auf gesetze-bayern.de](https://www.gesetze-bayern.de/Content/Resource?path=resources%2fBayVV_215_I_2279_BayVV215-I-2279-KF-001-Anhang-001.PDF)) | 125 Stichwörter der Übersicht (Brand, THL, ABC, RD, sonstige, Infoeinsätze), **nur die Kürzel**. Die Schlagwörter der Detailtabellen sind nicht übernommen. |

Für alle anderen Länder steht dort **„Kein öffentliches Verzeichnis hinterlegt – eigene Liste importieren“**. Dort ist entweder kein landesweites Verzeichnis öffentlich zugänglich, oder die Stichworte legen Kreise und Leitstellen selbst fest. „Eigene Liste“ arbeitet ganz ohne Landesverzeichnis.

So arbeitet die Liste:

- **Wechsel des Landes:** Die Einträge des neuen Verzeichnisses werden übernommen bzw. wieder aktiviert, die des bisherigen deaktiviert (nicht gelöscht – Regeln und Vorgänge behalten ihren Bezug).
- **Eigene Einträge haben Vorrang.** Ein eigener Eintrag mit demselben Kürzel ersetzt den Eintrag des Verzeichnisses. Wer Bezeichnung oder Kategorie eines Verzeichniseintrags ändert, macht ihn damit zum eigenen Eintrag.
- **Neu übernehmen** (Stichwörter & Regeln → Stichwortverzeichnis) frischt das Verzeichnis auf, z. B. nach einem Update mit neuer Fassung. Das geschieht auch bei jedem Start. Von Hand deaktivierte Einträge bleiben dabei aus.
- **Eigene Liste importieren:** CSV mit Semikolon in der Reihenfolge `code;bezeichnung;kategorie` (Kopfzeile optional) oder JSON (`[{"code": "…", "bezeichnung": "…", "kategorie": "…"}]`). Vorher zeigt BlaulichtCMS, wie viele Einträge übernommen und welche Zeilen übersprungen werden. Recht: „Stichwörter und Regeln pflegen“.
- **Export** als CSV oder JSON enthält die ganze Liste mit Herkunft (Länderkürzel oder `eigen`). Die CSV lässt sich wieder importieren. Alle importierten Zeilen werden dabei zu eigenen Einträgen, also vorher auf die gewünschten Zeilen kürzen.

Wo die Liste wirkt:

- **Einsatzmeldungen** (FE2, Feuersoftware Connect): Fehlt der Klartext zum Stichwort, ergänzt BlaulichtCMS ihn aus der Liste, z. B. im Titel des Einsatzentwurfs. In der Vorschau der Einsätze steht die Bedeutung neben dem Stichwort.
- **Automationen:** Bedingungen auf `stichwort` und `stichwort_kategorie` schlagen die Einträge der Liste vor. Das Feld `stichwort_kategorie` kommt aus der Liste.
- **Warnentwurf:** Beim Übernehmen aus einem Einsatz wird das passende Stichwort gewählt.
- **Feuersoftware-Filter:** Unter dem Stichwortfilter steht die Bedeutung der eingetragenen Stichworte.

Beim Abgleich zählen weder Groß- und Kleinschreibung noch Leerzeichen oder Bindestriche: `F2` ist dasselbe wie `F 2`. Untergliederungen wie `F2 W` oder `F2.1`, die der hessische Erlass zulässt, gehören zum Stichwort `F 2`. `H 10` gehört dagegen nicht zu `H 1`. **Unbekannte Stichworte bleiben unverändert** stehen.

## Stichwörter und Aliase

Ein Stichwort hat ein **Kürzel** (z. B. aus der Alarm- und Ausrückeordnung), eine **Bezeichnung**, eine **Kategorie** und beliebige **Aliase** für die Suche und für die Zuordnung aus FE2. Nicht mehr genutzte Stichwörter werden **deaktiviert**, nicht gelöscht. Bezeichnung, Kategorie und Aliase lassen sich über **Bearbeiten** ändern; das Kürzel bleibt fest, weil Regeln und Vorgänge darauf verweisen. Über dem Verzeichnis filtern Suchfeld und Kategorie die Liste; Lagefragen legt **Lagefrage hinzufügen** am jeweiligen Stichwort an.

## Lagefragen

Je Stichwort beliebig viele Fragen mit festen Antworten (Standard: *ja / nein / unbekannt*). Eine Frage erscheint im Assistenten erst nach **fachlicher Freigabe durch eine andere Person**. „unbekannt“ zählt als fehlende Angabe.

## Regeln

Eine Regel verknüpft Antworten mit einer Warnstufe, z. B.:

```
rauch_wohngebiet = ja
evakuierung = nein
```
→ Warnstufe 3, mit fachlicher Begründung.

- Mehrere Regeln je Stichwort sind möglich. Eine Zeile kann mehrere erlaubte Antworten haben: `wind = stark | sehr stark`.
- Jede Regel ist **versioniert**. Eine neue Version wird als Entwurf gespeichert; mit ihrer Freigabe tritt die alte Version außer Kraft.
- Wirksam sind nur **fachlich freigegebene** Regeln. Die Freigabe muss eine **andere Person** erteilen als die, die die Regel angelegt hat.
- Regeln auf nicht freigegebene Fragen treffen nie zu.
- Passen mehrere Regeln mit **unterschiedlichen Stufen**, gibt es keinen Vorschlag („widersprüchliche Regeln“).

## Zuständigkeiten

Empfänger der Übergabe-Mail (eine oder mehrere Adressen je Stelle). Im Wizard wird die Stelle je Vorgang gewählt. Name, Gebiet und Empfänger lassen sich über **Bearbeiten** ändern; das gilt für künftige Übergaben, bereits versendete Warnentwürfe bleiben unverändert.

## Vorlagen

Die Vorlage legt Felder, Stufenbezeichnungen, PDF-Titel und -Fußzeile sowie Betreff und Mailtext fest. Jede Änderung erzeugt eine **neue Version**; laufende Vorgänge behalten ihre Version und bleiben reproduzierbar.

## E-Mail-Versand

Unter **E-Mail-Versand** (nur Administration) stehen SMTP-Server, Absender und Zugangsdaten; das Passwort wird verschlüsselt gespeichert und nie wieder angezeigt. Darüber gehen die Übergabe-Mails der Warnentwürfe und – falls eingeschaltet – Sicherheitsmeldungen.

### Woher die Zugangsdaten kommen

Die Werte stellt die eigene **IT** bzw. der **E-Mail-Anbieter** der Organisation bereit. Am besten ein eigenes Postfach nur für BlaulichtCMS anlegen lassen (z. B. `warnung@…`) und erfragen:

| Feld | Bedeutung |
|---|---|
| Server | Postausgangsserver (SMTP), z. B. `smtp.example.org` |
| Port und Verschlüsselung | meist 587 mit STARTTLS oder 465 mit TLS (siehe unten) |
| Benutzer | Anmeldename des Postfachs, meist die vollständige E-Mail-Adresse |
| Passwort | Passwort des Postfachs bzw. ein App-Passwort |
| Absender | Adresse, die als Absender erscheint – muss zum Postfach passen bzw. für das Postfach freigegeben sein |
| Testpostfach | eigenes Postfach, an das im Testmodus alles geht |

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

### Testmail und Testmodus

1. Felder ausfüllen (noch nicht speichern nötig), unter **Testmail an** eine eigene Adresse eintragen und **Testmail senden**. Gesendet wird mit den Werten im Formular; ein leeres Passwortfeld nutzt das gespeicherte Passwort – aber nur für denselben Server. Bei einem anderen Server das Passwort neu eingeben.
2. Ankunft im Postfach prüfen (auch im Spam-Ordner).
3. **Speichern.**

Der **Testmodus** ist ab Werk aktiv und schickt alle Warnmails ausschließlich an das Testpostfach. **Ausschalten lässt er sich erst nach einer erfolgreichen Testmail mit genau den Einstellungen, die gespeichert werden** (Server, Port, Verschlüsselung, Benutzer, Absender, Passwort; höchstens 60 Minuten alt). Dasselbe gilt im Echtbetrieb für jede Änderung dieser Felder. Den Testmodus wieder einschalten geht jederzeit. Vor dem Echtbetrieb das Verfahren mit der zuständigen Stelle abstimmen.

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
