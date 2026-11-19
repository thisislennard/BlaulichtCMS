Es gibt zwei Wege. Der Ablauf lautet bei beiden: **Sichern → Wechseln → Prüfen → Wiederherstellen** (nur im Fehlerfall).

- **In der Oberfläche** unter [Einstellungen → Updates & Wartung](/einstellungen/updates): normale neue Versionen aus GitHub-Releases.
- **Am Docker-Host** mit dem Installationsskript: neue Basis-Images (Betriebssystem, Node.js, PostgreSQL, ffmpeg), geänderte Abhängigkeiten und Änderungen am Container selbst.

## Update in der Oberfläche

Unter [Einstellungen → Updates & Wartung](/einstellungen/updates) stehen Quelle und Prüfung:

- **GitHub-Repository** im Format `besitzer/name` und **API-Adresse** (Standard `https://api.github.com`).
- **Zugriffstoken (optional):** nur für private Repositories. Ein öffentliches Repository braucht keine Anmeldung. Ein gespeicherter Token wird nie wieder angezeigt; wird die API-Adresse auf einen anderen Server geändert, muss er neu eingegeben werden.
- **Automatisch prüfen** im eingestellten Abstand (1 bis 168 Stunden) oder sofort mit **„Jetzt prüfen“**. Gibt es eine neue Version, erhält die Administration eine Benachrichtigung und der Systemstatus zeigt „Update verfügbar“. Installiert wird nie automatisch.

Änderungen an diesen Einstellungen und jede Installation verlangen eine Bestätigung mit dem Passwort und stehen im Audit-Protokoll.

### Zugriffstoken für private Repositories

Ein Token ist **nur** nötig, wenn das Repository privat ist. So entsteht ein Token, der nur lesen darf:

1. Auf GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([Anleitung von GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
2. Name und Ablaufdatum festlegen (z. B. 1 Jahr, Erinnerung im Kalender eintragen).
3. Unter **Repository access** „Only select repositories“ und nur das BlaulichtCMS-Repository wählen.
4. Unter **Permissions → Repository permissions** nur **Contents: Read-only** setzen – das genügt für Releases und ihre Dateien ([benötigte Rechte](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
5. Token erzeugen, sofort kopieren und unter Einstellungen → Updates & Wartung eintragen. GitHub zeigt ihn nur einmal.

Läuft der Token ab, meldet „Jetzt prüfen“ einen Anmeldefehler – dann einen neuen erzeugen und eintragen.

### Version installieren

**„Version X installieren“** – BlaulichtCMS

1. lädt das Release und prüft Prüfsumme und **Signatur**: Nur Pakete aus dem offiziellen Release-Ablauf werden angenommen, ältere oder gleiche Versionen nie;
2. prüft, ob das Paket zum laufenden Container passt (Mindestversion des Images, Laufzeit-Abhängigkeiten). Braucht ein Release ein neueres Image, steht das schon nach der Prüfung da: Statt „Installieren“ zeigt die Karte **„Neues Docker-Image nötig“** mit den Schritten am Host (siehe [Wenn ein Update ein neues Image braucht](#wenn-ein-update-ein-neues-image-braucht));
3. schaltet den **Wartungsmodus** ein, wartet auf die Vorabprüfung und erstellt eine **Datenbanksicherung**;
4. startet mit der neuen Version neu (etwa eine Minute nicht erreichbar). Die Fortschrittsanzeige wartet auf den Neustart.

Startet die neue Version nicht oder schlägt eine Datenbankmigration fehl, schaltet BlaulichtCMS **automatisch zurück**: Die Datenbank wird – falls schon verändert – aus der Sicherung von eben zurückgespielt, die vorige Version läuft weiter. Ergebnis und Grund stehen im **Update-Protokoll** unter Einstellungen → Updates & Wartung. Nach einer erfolgreichen Umschaltung die Seite neu laden.

Wird später am Host ein Image derselben oder einer neueren Version installiert, läuft wieder der Code des Images.

## Vorabprüfung und Wartungsmodus

Unter [Einstellungen → Updates & Wartung](/einstellungen/updates#vorbereiten) zeigt **„Update vorbereiten“** die Vorabprüfung (Recht „Updates installieren“):

- Wartungsmodus aktiv (keine neuen schreibenden Vorgänge, keine neuen Aufträge)
- keine laufenden Hintergrundaufträge, kein Versand und keine Veröffentlichung in der Schwebe
- keine ungeklärten Ergebnisse (Hinweis)
- genug freier Speicher, aktuelle Datenbanksicherung (Hinweis)
- Schema passt zum laufenden Programm

Ein- und ausgeschaltet wird der Wartungsmodus an einer Stelle: unter [Verwaltung → Systemstatus](/system#wartungsmodus) (Recht „Wartungsmodus schalten“); „Update vorbereiten“ zeigt seinen Zustand und verlinkt dorthin. Im **Wartungsmodus** bleibt Lesen möglich. Websites erhalten keine neuen Aufträge; bereits angezeigte Banner bleiben unverändert.

Ein- und ausschalten lässt sich der Wartungsmodus außerdem im [Systemstatus](/system) (Karte **Wartungsmodus**) – dafür genügt das Recht „Wartungsmodus schalten“, „Updates installieren“ ist nicht nötig.

## Update am Docker-Host

```
sudo bash /opt/apps/blaulichtcms/install.sh
```

Das Installationsskript holt den neuen Stand, baut das Image, prüft es in einem Probelauf ohne Netz (Selbsttest: alle Programmdateien lesbar, Programm lädt) und ruft damit `scripts/update.sh … --rollback` auf. Besteht das Image den Selbsttest nicht, bricht es ab, bevor etwas geändert wird. Das Update-Skript schaltet den Wartungsmodus ein, wartet auf „bereit“, legt eine vollständige Sicherung außerhalb des Volumes an, wechselt das Image, prüft den Start und beendet den Wartungsmodus. Mit `--rollback` kehrt es bei einem Fehler automatisch zum alten Image **mit** dem Datenstand von vor dem Update zurück – das Datenvolume wird dabei erst ersetzt, wenn die Sicherung geprüft ist; besteht sie die Prüfung nicht, bleibt das Volume unverändert und die Ausgabe nennt den Weg von Hand. Bricht das Update vor dem Imagewechsel ab, wird der Wartungsmodus wieder beendet und der bisherige Stand läuft weiter.

### Wenn ein Update ein neues Image braucht

Manche Versionen bringen geänderte Abhängigkeiten oder Änderungen am Container mit. Die kommen nur mit einem neu gebauten Image an, deshalb lässt sich so ein Update nicht in der Oberfläche installieren. Unter [Einstellungen → Updates & Wartung](/einstellungen/updates) steht dann „Neues Docker-Image nötig“ mit der nötigen und der laufenden Image-Version. So geht es:

1. Am Docker-Host anmelden (z. B. per SSH).
2. `sudo bash /opt/apps/blaulichtcms/install.sh` ausführen (bei einem anderen Installationsordner dessen `install.sh`). `--rebuild` ist dafür nicht nötig.
3. Das Skript holt die neue Version, baut das Image (einige Minuten), schaltet den Wartungsmodus ein, sichert alles und wechselt – bei einem Fehler automatisch zurück. Daten, Einstellungen und `.env` bleiben erhalten; beim Wechsel ist BlaulichtCMS etwa eine Minute nicht erreichbar.
4. Danach die Seite neu laden: Unter Einstellungen → Updates & Wartung steht die neue Version „aus dem Image“. Folgende Versionen ohne neues Image lassen sich wieder in der Oberfläche installieren.

### Image-Update über den Update-Helfer

Ist am Docker-Host der **Update-Helfer** eingerichtet (fragt `install.sh`, Standard: einrichten), steht in der Karte „Neues Docker-Image nötig“ der Knopf **„Image-Update auf X anstoßen“** (Recht „Updates einstellen und installieren“, Bestätigung mit dem Passwort):

1. BlaulichtCMS legt nur eine **Anfrage** im Datenvolume ab (Version, Zeitpunkt, wer) – der Container bekommt dafür keinen Zugriff auf Docker.
2. Der Helfer am Host prüft die Anfrage, ermittelt selbst das neueste Release und prüft dessen **Signatur** – eine ältere oder gleiche Version installiert er nie.
3. Dann läuft der bekannte Weg: Image bauen (einige Minuten), Wartungsmodus, Sicherung, Wechsel, Prüfung, bei einem Fehler automatisch zurück. Während Sicherung und Wechsel ist BlaulichtCMS einige Minuten nicht erreichbar; die Seite zeigt die Schritte und aktualisiert sich von selbst.
4. Ergebnis (abgeschlossen, zurückgenommen, abgebrochen, abgelehnt) und ein **Protokollauszug** stehen oben auf der Seite und im Update-Protokoll; die Administration wird benachrichtigt. Der Hinweis oben verschwindet mit **„Seite neu laden“** (lädt die neue Oberfläche) bzw. **„Ausblenden“**, spätestens nach einem Tag. Ein fehlgeschlagenes Update („Handeln am Host nötig“) lässt sich nicht ausblenden.

Höchstens eine Anfrage je 10 Minuten. Nimmt der Helfer eine Anfrage nicht innerhalb von 2 Minuten an, zeigt die Seite das und bietet **„Anfrage zurückziehen“** an – dann am Host nachsehen (`systemctl status blaulichtcms-update.path`). Ohne Helfer zeigt die Karte wie bisher die Schritte am Host. Einrichten: am Host `sudo bash /opt/apps/blaulichtcms/install.sh` ausführen und die Frage nach dem Update-Helfer bejahen (kommt keine Frage, weil das Skript beim Update noch die alte Fassung ausführte, einfach noch einmal ausführen); abschalten mit `--remove-helper`. Ob der Helfer eingerichtet ist, zeigt die Übersicht oben auf der Seite in der Zeile **Update-Helfer**.

Ohne neuen Programmstand **monatlich** `sudo bash /opt/apps/blaulichtcms/install.sh --rebuild` ausführen: Das Image wird mit aktuellen Basis-Images (Sicherheitsupdates von Betriebssystem, Node.js und PostgreSQL) neu gebaut und mit Sicherung und Rückweg gewechselt.

## Wenn BlaulichtCMS nicht startet

- **Migration fehlgeschlagen:** Die Migration wird vollständig zurückgerollt, die Daten bleiben unverändert. Der Webport zeigt eine Sperrseite mit dem Grund.
- **„Datenstand neuer als dieses Programm“:** Ein älteres Image wurde auf einen bereits aktualisierten Datenstand gestartet. Zurück geht es nur mit der Sicherung von vor dem Update.
- **PostgreSQL-Hauptversion abweichend:** BlaulichtCMS startet nicht und nennt den Grund. Der getestete Weg (Export, neuer Cluster, Import) steht in `docs/betrieb.md`.

## BlaulichtCMS Bridge

Neue Bridge-Versionen kommen über den normalen **WordPress-Updateweg** (Dashboard → Aktualisierungen). Unter [Websites](/websites) → **Bridge-Updates**:

1. Eine Testwebsite in die Stufe **„Test“** setzen – sie erhält die neue Version sofort.
2. Auf der Testwebsite aktualisieren und prüfen. WordPress prüft das Paket vor der Installation gegen die Prüfsumme aus BlaulichtCMS und – sobald eingerichtet – gegen die Code-Signatur des Betreibers; die Kopplung bleibt erhalten.
3. **Version für alle freigeben** – möglich erst, wenn die Testwebsite die neue Version meldet. Danach erhalten alle Websites das Update.

**Automatische Updates:** In WordPress unter **Plugins** bei der BlaulichtCMS Bridge **Automatische Updates aktivieren** wählen. WordPress installiert dann jede für die Website freigegebene Version selbst (Websites in der Stufe „Test“ sofort, alle anderen nach der Freigabe) – mit derselben Prüfung von Prüfsumme und Signatur. Ist WP-Cron auf der Website abgeschaltet, holt die Bridge ihr automatisches Update selbst nach (höchstens alle 12 Stunden). Ob automatische Updates an sind, zeigt die Website-Karte unter [Websites](/websites) ab Bridge 0.8.0.

**Code-Signatur:** Neben „für alle freigegeben“ zeigt BlaulichtCMS, ob das Paket signiert ist. Ist in der Bridge ein Signaturschlüssel hinterlegt, installieren die Websites nur Updates mit gültiger Signatur – auch dann, wenn jemand den BlaulichtCMS-Server übernommen hätte. „Signatur ungültig“ bedeutet: Die Bridge wurde nach dem Signieren geändert; die Freigabe ist dann gesperrt. Einrichtung und Signieren macht der Betrieb (`docs/bridge-signatur.md`).
