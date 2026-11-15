Es gibt zwei Wege. Der Ablauf lautet bei beiden: **Sichern → Wechseln → Prüfen → Wiederherstellen** (nur im Fehlerfall).

- **In der Oberfläche** unter [Einstellungen → Updates](/einstellungen#updates): normale neue Versionen aus GitHub-Releases.
- **Am Docker-Host** mit dem Installationsskript: neue Basis-Images (Betriebssystem, Node.js, PostgreSQL, ffmpeg), geänderte Abhängigkeiten und Änderungen am Container selbst.

## Update in der Oberfläche

Unter [Einstellungen → Updates](/einstellungen#updates) stehen Quelle und Prüfung:

- **GitHub-Repository** im Format `besitzer/name` und **API-Adresse** (Standard `https://api.github.com`).
- **Zugriffstoken (optional):** nur für private Repositories. Ein öffentliches Repository braucht keine Anmeldung. Ein gespeicherter Token wird nie wieder angezeigt; wird die API-Adresse auf einen anderen Server geändert, muss er neu eingegeben werden.
- **Automatisch prüfen** im eingestellten Abstand (1 bis 168 Stunden) oder sofort mit **„Jetzt prüfen“**. Gibt es eine neue Version, erhält die Administration eine Benachrichtigung und der Systemstatus zeigt „Update verfügbar“. Installiert wird nie automatisch.

Änderungen an diesen Einstellungen und jede Installation verlangen eine Bestätigung mit dem Passwort und stehen im Audit-Protokoll.

**„Version X installieren“** – BlaulichtCMS

1. lädt das Release und prüft Prüfsumme und **Signatur**: Nur Pakete aus dem offiziellen Release-Ablauf werden angenommen, ältere oder gleiche Versionen nie;
2. prüft, ob das Paket zum laufenden Container passt. Braucht es ein neueres Image, erscheint der Hinweis, das Installationsskript am Host auszuführen;
3. schaltet den **Wartungsmodus** ein, wartet auf die Vorabprüfung und erstellt eine **Datenbanksicherung**;
4. startet mit der neuen Version neu (etwa eine Minute nicht erreichbar). Die Fortschrittsanzeige wartet auf den Neustart.

Startet die neue Version nicht oder schlägt eine Datenbankmigration fehl, schaltet BlaulichtCMS **automatisch zurück**: Die Datenbank wird – falls schon verändert – aus der Sicherung von eben zurückgespielt, die vorige Version läuft weiter. Ergebnis und Grund stehen im **Update-Protokoll** unter Einstellungen → Updates. Nach einer erfolgreichen Umschaltung die Seite neu laden.

Wird später am Host ein Image derselben oder einer neueren Version installiert, läuft wieder der Code des Images.

## Vorabprüfung und Wartungsmodus

Unter [Einstellungen → Sicherung](/einstellungen#sicherung) zeigt **„Update vorbereiten“** die Vorabprüfung:

- Wartungsmodus aktiv (keine neuen schreibenden Vorgänge, keine neuen Aufträge)
- keine laufenden Hintergrundaufträge, kein Versand und keine Veröffentlichung in der Schwebe
- keine ungeklärten Ergebnisse (Hinweis)
- genug freier Speicher, aktuelle Datenbanksicherung (Hinweis)
- Schema passt zum laufenden Programm

Im **Wartungsmodus** bleibt Lesen möglich. Websites erhalten keine neuen Aufträge; bereits angezeigte Banner bleiben unverändert.

## Update am Docker-Host

```
sudo bash /opt/apps/blaulichtcms/install.sh
```

Das Installationsskript holt den neuen Stand, baut das Image und ruft damit `scripts/update.sh … --rollback` auf. Das Update-Skript schaltet den Wartungsmodus ein, wartet auf „bereit“, legt eine vollständige Sicherung außerhalb des Volumes an, wechselt das Image, prüft den Start und beendet den Wartungsmodus. Mit `--rollback` kehrt es bei einem Fehler automatisch zum alten Image **mit** dem Datenstand von vor dem Update zurück. Bricht das Update vor dem Imagewechsel ab, wird der Wartungsmodus wieder beendet und der bisherige Stand läuft weiter.

Ohne neuen Programmstand **monatlich** `sudo bash /opt/apps/blaulichtcms/install.sh --rebuild` ausführen: Das Image wird mit aktuellen Basis-Images (Sicherheitsupdates von Betriebssystem, Node.js und PostgreSQL) neu gebaut und mit Sicherung und Rückweg gewechselt.

## Wenn BlaulichtCMS nicht startet

- **Migration fehlgeschlagen:** Die Migration wird vollständig zurückgerollt, die Daten bleiben unverändert. Der Webport zeigt eine Sperrseite mit dem Grund.
- **„Datenstand neuer als dieses Programm“:** Ein älteres Image wurde auf einen bereits aktualisierten Datenstand gestartet. Zurück geht es nur mit der Sicherung von vor dem Update.
- **PostgreSQL-Hauptversion abweichend:** BlaulichtCMS startet nicht und nennt den Grund. Der getestete Weg (Export, neuer Cluster, Import) steht in `docs/betrieb.md`.

## BlaulichtCMS Bridge

Neue Bridge-Versionen kommen über den normalen **WordPress-Updateweg** (Dashboard → Aktualisierungen). Unter [Websites](/kanaele) → **Bridge-Updates**:

1. Eine Testwebsite in den Kanal **„Test“** setzen – sie erhält die neue Version sofort.
2. Auf der Testwebsite aktualisieren und prüfen. WordPress prüft das Paket vor der Installation gegen die Prüfsumme aus BlaulichtCMS und – sobald eingerichtet – gegen die Code-Signatur des Betreibers; die Kopplung bleibt erhalten.
3. **Version für alle freigeben** – möglich erst, wenn die Testwebsite die neue Version meldet. Danach erhalten alle Websites das Update.

**Code-Signatur:** Neben „für alle freigegeben“ zeigt BlaulichtCMS, ob das Paket signiert ist. Ist in der Bridge ein Signaturschlüssel hinterlegt, installieren die Websites nur Updates mit gültiger Signatur – auch dann, wenn jemand den BlaulichtCMS-Server übernommen hätte. „Signatur ungültig“ bedeutet: Die Bridge wurde nach dem Signieren geändert; die Freigabe ist dann gesperrt. Einrichtung und Signieren macht der Betrieb (`docs/bridge-signatur.md`).
