LifeLink verarbeitet sensible Daten: Zugangsdaten zu Website und Mailserver, Einsatzdaten aus der Alarmierung. Dieses Kapitel erklärt, wie sie geschützt sind und was ihr selbst beitragen könnt.

## Verschlüsselung der Zugangsdaten

Alle Geheimnisse – Passwörter, Tokens, Webhook-Geheimnisse, der iCal-Link, 2FA-Schlüssel – werden **verschlüsselt** in der Datenbank gespeichert (AES-256-GCM). Zusätzlich ist jedes Chiffrat an seinen Datensatz gebunden: Kopiert jemand es in einen anderen Datensatz, lässt es sich nicht entschlüsseln.

In der Oberfläche werden gespeicherte Geheimnisse **nie wieder angezeigt**. Ihr seht nur „Gespeichert am …“ und könnt sie **ersetzen**. Beim Ersetzen entsteht eine neue Version; ältere Versionen lassen sich bei Bedarf wieder aktivieren oder endgültig widerrufen. Exporte von Workflows enthalten nie Geheimnisse.

## Der Master-Schlüssel

Der Schlüssel für diese Verschlüsselung ist der **Master-Schlüssel** (`LIFELINK_MASTER_KEY`). Er liegt **nicht** in der Datenbank, sondern in der Server-Konfiguration (`.env`).

- Ohne ihn sind Zugangsdaten, 2FA-Einrichtungen und Sicherungen nicht lesbar.
- Wer Datenbank **und** Master-Schlüssel hat, kann alles entschlüsseln. Deshalb: **getrennt aufbewahren**, z. B. im Passwort-Manager der Wehrführung, nicht neben den Sicherungen.
- Den Master-Schlüssel **nicht ändern**: Ein neuer Schlüssel macht alle gespeicherten Geheimnisse unbrauchbar. Sie müssten dann alle neu eingegeben werden.

Wie er erzeugt wird, steht in [Installation & Betrieb](/hilfe/betrieb#installation).

## Maskierung

Wo LifeLink Daten anzeigt oder protokolliert (Ausführungsverlauf, Systemprotokoll, Audit), werden Geheimnisse durch `•••••••• maskiert` ersetzt – siehe [Ausführungen verstehen](/hilfe/ausfuehrungen#maskierung). Die Maskierung lässt sich nicht abschalten.

Webhook-Eingänge übernehmen nur ausgewählte, unkritische Header in den Workflow; `Authorization`, Cookies und Signaturen gehören nicht dazu.

## Aufbewahrungsfristen

LifeLink löscht Daten automatisch nach festen Fristen. Ein Admin stellt sie in den [Einstellungen](/einstellungen) unter „Ausführung & Protokolle“ ein.

| Daten | Standard |
|---|---|
| Daten zum Wiederholen eines Laufs (verschlüsselt) | 7 Tage |
| Daten-Vorschau der Schritte (Eingabe/Ausgabe) | 30 Tage |
| Vorschau eingehender Ereignisse | 14 Tage |
| Läufe (Status, Zeiten, Fehlermeldungen) | 90 Tage |
| Systemprotokoll | 30 Tage |
| Audit-Protokoll | 365 Tage |
| Benachrichtigungen | 60 Tage |

Kürzere Fristen bedeuten weniger gespeicherte Einsatzdaten – aber auch weniger Zeit, um Fehler nachzuvollziehen oder Läufe zu wiederholen.

> **Tipp für den Datenschutz:** Übertragt aus FE2 nur die Felder, die eure Workflows brauchen. Was nicht ankommt, muss auch nicht geschützt und gelöscht werden.

## Audit-Protokoll

Das Audit-Protokoll hält fest, **wer wann was** getan hat: Anmeldungen, Rechteänderungen, Veröffentlichungen, Freigaben, Wiederholungen, geänderte Zugangsdaten, Exporte, Sicherungen und Updates. Fehlgeschlagene und verweigerte Versuche werden ebenfalls protokolliert. Siehe [Aktivitäten](/aktivitaeten).

## Anmeldung und Sitzungen

| Schutz | Standard |
|---|---|
| Mindestlänge Passwort | 12 Zeichen |
| Sperre nach Fehlversuchen | 5 Fehlversuche → 15 Minuten gesperrt |
| Zwei-Faktor-Anmeldung | Pflicht für Plattform- und Integrations-Admins; auf Wunsch für alle |
| Sitzung ohne Aktivität | endet nach 60 Minuten |
| Sitzung höchstens | 12 Stunden |

Passwörter werden nur als sicherer Hash gespeichert. Sitzungs-Cookies sind für Skripte im Browser unzugänglich und werden nur an LifeLink selbst gesendet. Änderungen über die Oberfläche brauchen zusätzlich eine Sicherheitskennung im Header – das verhindert, dass fremde Websites Aktionen in eurem Namen auslösen.

Bei Rollenänderung, Deaktivierung oder Passwort-Neusetzen werden alle Sitzungen der Person beendet.

## Schutz nach außen

- **Webhooks**: HMAC-Signatur mit Zeitfenster und Replay-Schutz, Größenbegrenzung, Rate-Limit. Siehe [Webhooks](/hilfe/webhooks).
- **Ausgehende Anfragen**: interne Netze gesperrt (SSRF-Schutz), Host-Freigaben, Weiterleitungen werden neu geprüft. Siehe [HTTP & REST-Schnittstellen](/hilfe/rest-api#interne-ziele-und-ssrf-schutz).
- **Feste Ziele**: Empfänger, Teams-Kanäle und MQTT-Topics kommen nie aus eingehenden Daten.
- **WordPress**: signierte Anfragen, Schlüssel jederzeit widerrufbar, keine direkte Veröffentlichung von Beiträgen.
- **Updates**: nur mit gültiger Signatur. Siehe [Updates](/hilfe/updates).

## Was ihr selbst tun solltet

- LifeLink nur über **HTTPS** erreichbar machen (TLS-Proxy davor), siehe [Installation & Betrieb](/hilfe/betrieb).
- 2FA für **alle** Konten einschalten, wenn möglich.
- Rollen sparsam vergeben; ausgeschiedene Mitglieder deaktivieren.
- Master-Schlüssel und Sicherungen getrennt aufbewahren.
- Für jede Integration eigene, beschränkte Konten anlegen (eigenes Postfach, MQTT-Konto mit ACL, M365-App auf ein Postfach begrenzt).
- Keine Personendaten auf öffentliche Ziele wie die Website schicken.
