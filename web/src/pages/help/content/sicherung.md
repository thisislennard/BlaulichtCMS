## Was gesichert werden muss

Ein vollständiger Stand besteht aus:

1. **Datenbank** (Benutzer, Rechte, Beiträge, Fassungen, Freigaben, Aufträge, Audit)
2. **Medien** unter `/data/media`
3. **Schlüsselmaterial** unter `/data/secrets` (bzw. `BLAULICHTCMS_MASTER_KEY`)

Ohne Master-Schlüssel sind verschlüsselte Inhalte einer Sicherung nicht lesbar.

Wie viel Platz die Medien belegen (je Sammlung, Ordner und Art, Papierkorb, gesperrte Dateien, ZIP-Downloads), steht unter **Medien → Verwaltung → Speicher**. Dateien im Papierkorb und gesperrte Dateien sind bis zum Ablauf ihrer Frist ebenfalls Teil der Volume-Sicherung.

Die Volume-Sicherungen am Docker-Host sind zusätzlich **als Ganzes verschlüsselt** – mit einem eigenen
Sicherungsschlüssel (`/etc/blaulichtcms/backup.key`), der nicht im Volume und nicht im Sicherungsziel liegt. Eine Kopie
dieses Schlüssels gehört getrennt verwahrt (Passwortmanager oder Tresor): Ohne ihn ist keine Wiederherstellung möglich.

## Sicherung ohne Unterbrechung

Unter **Einstellungen → Sicherung** erstellt BlaulichtCMS täglich eine verschlüsselte Datenbanksicherung unter `/data/backups`. Sie liegt im selben Volume – für den Ernstfall gehört eine Kopie **außerhalb** des Volumes: am einfachsten mit der **Sicherung außer Haus** (unten).

Die Sicherung läuft ab der eingestellten Uhrzeit einmal am Tag. Fällt die Stunde aus – etwa 02:00 am Tag der Umstellung auf Sommerzeit oder weil der Dienst zu der Zeit nicht lief –, holt BlaulichtCMS sie im Lauf desselben Tages nach. Ist der Datenträger voll, schlägt die Sicherung mit einer Benachrichtigung fehl, ohne Prozesse oder Datenbankverbindungen hängen zu lassen.

## Sicherung außer Haus

Unter **Einstellungen → Sicherung außer Haus** legt BlaulichtCMS jede Datenbanksicherung zusätzlich auf einem Ziel
außerhalb des Servers ab – zum Beispiel auf einem NAS im eigenen Netz. Übertragen wird per **WebDAV** über HTTPS: Das
braucht auf dem Server kein Zusatzprogramm und funktioniert mit Synology, QNAP, Nextcloud und vielen anderen Geräten.

So läuft es ab:

1. Nach jeder Sicherung (täglich und von Hand) lädt der Hintergrunddienst die Datei hoch – zunächst unter einem
   vorläufigen Namen.
2. Er liest sie vom Ziel zurück und vergleicht die Prüfsumme (SHA-256) mit der lokalen Datei. Erst wenn sie stimmt,
   erhält die Datei ihren endgültigen Namen.
3. Danach räumt er auf dem Ziel auf: Behalten wird je Tag, je Woche und je Monat die neueste Sicherung (einstellbar,
   Standard 7 Tage, 4 Wochen, 6 Monate). Andere Dateien im Ordner rührt BlaulichtCMS nie an.

Die Dateien bleiben **verschlüsselt** (mit dem Sicherungsschlüssel aus dem Master-Schlüssel) – das NAS sieht nur
unlesbare Daten. Benutzername und Passwort des Ziels werden verschlüsselt gespeichert und nie wieder angezeigt.
Schlägt eine Übertragung auch nach mehreren Versuchen fehl, erhalten alle mit „Sicherungen erstellen“ eine Benachrichtigung; der Stand
steht unter **Systemstatus** („Sicherung außer Haus“) und in der Liste der Sicherungen.

Ist die tägliche **Volume-Sicherung** am Docker-Host eingerichtet (`backup-cron.sh`), geht auch sie – mit Medien und
mit dem eigenen Sicherungsschlüssel des Hosts verschlüsselt – in den Unterordner `volume/` des Ziels, mit derselben
Aufbewahrung.

## Einrichtung am NAS (Beispiel Synology)

1. Im Paket-Zentrum **WebDAV Server** installieren und darin **HTTPS** einschalten (Standard-Port 5006); HTTP
   ausgeschaltet lassen.
2. Einen freigegebenen Ordner anlegen, z. B. `sicherung`, und darin einen Ordner `blaulichtcms`.
3. Ein **eigenes Benutzerkonto** nur für die Sicherung anlegen (z. B. `blaulichtcms`) mit Lese-/Schreibrecht nur auf
   diesen Ordner und ohne Administratorrechte. In der Synology-Firewall den Zugriff auf Port 5006 möglichst auf die
   Adresse des BlaulichtCMS-Servers beschränken.
4. Optional: Papierkorb des freigegebenen Ordners einschalten und Snapshots (Btrfs) aktivieren – so übersteht eine
   Sicherung auch ein versehentliches Löschen.
5. In BlaulichtCMS unter **Einstellungen → Sicherung außer Haus** eintragen:
   Adresse `https://<nas-adresse>:5006/sicherung/blaulichtcms/`, Benutzer und Passwort.
6. **Verbindung testen.** Hat das NAS ein selbst signiertes Zertifikat, zeigt der Test dessen Fingerabdruck. Am NAS
   unter *Systemsteuerung → Sicherheit → Zertifikat* vergleichen und erst bei Übereinstimmung **Fingerabdruck
   übernehmen** – BlaulichtCMS nimmt dann genau dieses Zertifikat an, sonst keines.
7. **Nach jeder Sicherung außer Haus ablegen** einschalten und speichern (verlangt die Bestätigung mit dem eigenen
   Passwort). Gespeichert wird nur nach bestandenem Test.

Warum nicht SMB? SMB bräuchte im Container ein zusätzliches Programm und damit ein neues Programmabbild. WebDAV über
HTTPS deckt denselben Zweck ab und ist durchgehend verschlüsselt.

## Wiederherstellung üben

Eine Sicherung ist erst dann eine, wenn sie sich zurückspielen lässt. Unter **Einstellungen → Sicherung außer Haus →
Probe-Wiederherstellung** spielt BlaulichtCMS eine Sicherung in eine **Wegwerf-Datenbank** auf demselben Server ein –
der laufende Betrieb bleibt unberührt – und prüft:

- Entschlüsseln (die Verschlüsselung erkennt jede Beschädigung oder Veränderung),
- vollständiges Einspielen ohne Fehler,
- Tabellen, Zeilen je Tabelle, Stand der Datenbank-Migrationen und vorhandene Benutzerkonten,
- die Hash-Kette des Audit-Protokolls und ob ihr Ende zum laufenden Protokoll passt.

Danach wird die Wegwerf-Datenbank gelöscht. Das Ergebnisprotokoll steht in der Liste der Proben, der letzte Stand im
**Systemstatus** („Probe-Wiederherstellung“). Nach Zeitplan läuft die Probe wöchentlich (oder monatlich) eine Stunde
nach der Sicherungszeit und nimmt die **neueste Kopie außer Haus** – genau die, auf die es im Ernstfall ankommt. Schlägt
eine Probe fehl, erhalten alle mit „Sicherungen erstellen“ eine Benachrichtigung.

Die Probe braucht vorübergehend freien Speicher etwa in Höhe der Datenbank. Medien prüft sie nicht – dafür gibt es den
wöchentlichen Wiederherstellungstest der Volume-Sicherung am Docker-Host.

## Notfall: Wiederherstellen aus der Sicherung außer Haus

**Der Server läuft, aber der Datenbestand ist beschädigt oder falsch** (z. B. versehentlich gelöscht):

1. Unter **Einstellungen → Sicherung außer Haus → Sicherungen auf dem Ziel** die gewünschte Sicherung **holen**. Sie
   wird geprüft und erscheint in der Liste der Sicherungen. (Liegt sie noch lokal, entfällt dieser Schritt.)
2. Optional: mit **Probe-Wiederherstellung** prüfen, ob sie den erwarteten Stand enthält.
3. Am Docker-Host zurückspielen – das ersetzt den gesamten Datenbestand durch den Stand der Sicherung:

```
cd /opt/apps/blaulichtcms
docker compose exec blaulichtcms node server/dist/cli.js maintenance on "Wiederherstellung"
docker compose exec blaulichtcms node server/dist/cli.js restore-db blaulichtcms-<zeitpunkt>.bcbk --ja
docker compose restart blaulichtcms
```

Schlägt das Einspielen fehl, bleibt der bisherige Stand unverändert erhalten.

**Der Server ist verloren** (neuer Host):

1. BlaulichtCMS neu installieren (`sudo bash install.sh`).
2. Am besten die **Volume-Sicherung** aus dem Ordner `volume/` des NAS auf den Host kopieren und wie unter
   „Wiederherstellen in einer frischen Instanz“ beschrieben mit `scripts/restore-volume.sh` und dem getrennt verwahrten
   Sicherungsschlüssel (`/etc/blaulichtcms/backup.key`) einspielen – das bringt Datenbank, Medien und Schlüssel zurück.
3. Gibt es nur Datenbanksicherungen: den **Master-Schlüssel** aus dem Tresor als `/data/secrets/master.key` hinterlegen
   (ohne ihn ist die Sicherung nicht lesbar), die `.bcbk`-Datei vom NAS nach `/data/backups` kopieren und wie oben mit
   `restore-db` einspielen. Medien sind darin nicht enthalten.

Danach die Prüfliste aus `docs/betrieb.md` (Abschnitt „Wiederherstellung“) abarbeiten.

## Tägliche Sicherung (empfohlen)

`install.sh` richtet auf Wunsch eine tägliche Sicherung um 02:30 ein (`/etc/cron.d/blaulichtcms`): vollständiges Volume nach `/opt/apps/blaulichtcms-sicherungen`, **14 tägliche und 8 wöchentliche Stände**, der Container hält dafür wenige Sekunden an. Das Ziel am besten auf ein NAS oder einen zweiten Datenträger legen (`BLAULICHTCMS_BACKUP_DIR`) und regelmäßig eine Kopie außer Haus bringen. Von Hand: `scripts/backup-volume.sh <zielordner>`.

## Prüfung der Sicherungen

Jede Sicherung wird nach dem Schreiben geprüft: Die Datenbanksicherung wird entschlüsselt und ihr Inhaltsverzeichnis
gelesen, die tägliche Volume-Sicherung wird vollständig entschlüsselt und gelesen. Einmal pro Woche spielt der
Docker-Host die Sicherung zusätzlich in eine Wegwerf-Instanz ohne Netzwerk ein und prüft, ob sie startet. Schlägt
etwas fehl, erhalten alle mit „Sicherungen erstellen“ eine Benachrichtigung. Vierteljährlich sollte der Betrieb die
Wiederherstellung auf einem anderen Rechner üben (`docs/betrieb.md`).

## Vollständige Sicherung außerhalb des Volumes (von Hand)

```
cd /opt/apps/blaulichtcms && scripts/backup-volume.sh <zielordner>
```

Der Container hält wenige Sekunden an; das Archiv (`blaulichtcms-<zeitpunkt>.tar.gz.enc`) ist verschlüsselt und nur für
root lesbar.

## Wiederherstellen in einer frischen Instanz

```
docker compose down
scripts/restore-volume.sh <zielordner>/blaulichtcms-<zeitpunkt>.tar.gz.enc
docker compose up -d
```

Das Skript braucht den Sicherungsschlüssel, prüft Prüfsumme und Echtheit des Archivs vollständig und spielt erst dann
in ein leeres Volume ein.

Danach anmelden und prüfen: Benutzer, Beiträge, Medien, Freigaben und offene Aufträge sind wieder da. Die ausführliche Anleitung (inkl. Prüfliste) steht in `docs/betrieb.md`.
