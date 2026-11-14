In LifeLink bekommt jede Person nur die Rechte, die sie für ihre Aufgabe braucht. Rechte werden über **Rollen** vergeben; eine Person kann mehrere Rollen haben, die Rechte addieren sich. Alles, was nicht ausdrücklich erlaubt ist, ist verboten.

## Die Rollen

| Rolle | Für wen? | Darf |
|---|---|---|
| **Plattform-Admin** | IT-Verantwortliche der Wehr (1–2 Personen) | Alles – inklusive Benutzer, Einstellungen, Sicherungen, API-Schlüssel und Updates |
| **Integrations-Admin** | Betreut die Anbindungen | Verbindungen anlegen und testen, Zugangsdaten und Webhook-Geheimnisse verwalten; Workflows, Läufe, System und Audit ansehen |
| **Workflow-Editor** | Baut Workflows | Workflows entwerfen, testen (simuliert) und zur Freigabe einreichen; Läufe und Verbindungen ansehen |
| **Freigebender** | z. B. Wehrführung | Versionen freigeben und aktivieren, zurückrollen, Läufe wiederholen und abbrechen |
| **Betriebsleser** | Wer nur schauen soll | Status, Workflows, Läufe, Verbindungen und Protokolle ansehen – nichts ändern |
| **WordPress-Redakteur** | Öffentlichkeitsarbeit | Banner und Beiträge anlegen, bearbeiten und veröffentlichen – sonst nichts |

**Beispiel für eine kleine Wehr:** Die IT-Beauftragte ist Plattform-Admin, zwei Kameraden sind Workflow-Editor, der Wehrführer ist Freigebender, die Pressesprecherin WordPress-Redakteurin.

## Die Rechte im Einzelnen

| Bereich | Recht | Bedeutung | Kritisch |
|---|---|---|---|
| Workflows | Workflows ansehen | Workflows, Versionen und Vorlagen ansehen | |
| | Workflows bearbeiten | Entwürfe anlegen, bearbeiten, testen, Freigabe beantragen | |
| | Aktivieren & veröffentlichen | Versionen veröffentlichen, aktivieren, deaktivieren, zurückrollen; echte Testläufe | ✓ |
| | Freigeben | Bei Vier-Augen-Freigabe die Version einer anderen Person freigeben | ✓ |
| Ausführungen | Ausführungen ansehen | Verlauf, Schritte und maskierte Daten ansehen | |
| | Erneut ausführen | Läufe wiederholen oder abbrechen (mögliche Doppelwirkung) | ✓ |
| Schnittstellen | Schnittstellen ansehen | Verbindungen, Status und Webhooks ansehen | |
| | Schnittstellen verwalten | Verbindungen anlegen, konfigurieren, testen und löschen | |
| Zugangsdaten | Zugangsdaten verwalten | Zugangsdaten hinterlegen, ersetzen, Webhook-Geheimnisse rotieren und widerrufen | ✓ |
| WordPress | Banner & Beiträge ansehen | | |
| | Banner & Beiträge bearbeiten | Entwürfe anlegen und bearbeiten | |
| | Veröffentlichen | Banner veröffentlichen/deaktivieren, Beiträge an WordPress senden | ✓ |
| Benutzer | Benutzer ansehen | Benutzerliste und Rollen | |
| | Benutzer verwalten | Einladen, Rollen ändern, deaktivieren, 2FA zurücksetzen | ✓ |
| System | Audit-Protokoll ansehen | Wer hat wann was geändert | |
| | Systemstatus ansehen | Systemstatus und Protokolle | |
| | System verwalten | Einstellungen, Sicherungen und API-Schlüssel | ✓ |

**Kritische Rechte** haben Folgen nach außen oder für die Sicherheit. Vergebt sie sparsam. Wer welche Rolle hat, seht ihr unter [Benutzer und Berechtigungen](/benutzer) auch als **Berechtigungsmatrix**.

Updates installieren darf ausschließlich ein **Plattform-Admin mit Benutzerkonto**, weil dabei neuer Programmcode eingespielt wird.

## Jemanden einladen

1. [Benutzer und Berechtigungen](/benutzer) → **Benutzer einladen**.
2. E-Mail-Adresse und Rolle(n) eintragen.
3. LifeLink erzeugt einen **Einladungslink**, der **72 Stunden** gültig ist. LifeLink verschickt ihn nicht selbst – kopiert ihn und schickt ihn der Person, z. B. per E-Mail oder Messenger.
4. Die Person öffnet den Link, gibt ihren Namen ein und wählt ein Passwort. Ist 2FA für ihre Rolle Pflicht, richtet sie sie direkt danach ein.

Bis dahin steht das Konto auf **Eingeladen**. Ist der Link abgelaufen, erzeugt ihr einen neuen.

## Konten verwalten

| Aktion | Was passiert |
|---|---|
| **Rollen ändern** | Gilt sofort; die Person wird überall abgemeldet und meldet sich neu an. |
| **Deaktivieren** | Anmelden nicht mehr möglich, alle Sitzungen enden. Das Konto bleibt erhalten und kann wieder aktiviert werden. Richtig z. B. bei Austritt aus der Wehr. |
| **Link zum Passwort-Neusetzen** | 24 Stunden gültig, siehe [Anmeldung](/hilfe/anmeldung#passwort-vergessen). |
| **2FA zurücksetzen** | Bei verlorenem Handy. Die Person richtet 2FA beim nächsten Login neu ein. |
| **Löschen** | Endgültig. Zur Bestätigung die E-Mail-Adresse eintippen. Das eigene Konto kann man nicht löschen. |

LifeLink sorgt dafür, dass immer **mindestens ein aktiver Plattform-Admin** übrig bleibt. Den letzten kann man weder herabstufen noch deaktivieren noch löschen.

## Konten für Systeme

Programme und Skripte bekommen kein Benutzerkonto, sondern einen **API-Schlüssel** mit eigenen Rollen und Ablaufdatum. Siehe [LifeLink-API](/hilfe/api).

## Aktivitätsprotokoll

Jede wichtige Änderung landet im **Audit-Protokoll**: Anmeldungen (auch fehlgeschlagene), Rollenänderungen, Veröffentlichungen, Freigaben, Wiederholungen, geänderte Zugangsdaten, Sicherungen und Updates – jeweils mit Person, Zeit und IP-Adresse. Geheimnisse stehen nie darin. Einsehen kann es, wer „Audit-Protokoll ansehen“ hat, unter [Aktivitäten](/aktivitaeten).
