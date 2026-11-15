## Was gesichert werden muss

Ein vollständiger Stand besteht aus:

1. **Datenbank** (Benutzer, Rechte, Beiträge, Fassungen, Freigaben, Aufträge, Audit)
2. **Medien** unter `/data/media`
3. **Schlüsselmaterial** unter `/data/secrets` (bzw. `BLAULICHTCMS_MASTER_KEY`)

Ohne Master-Schlüssel sind verschlüsselte Inhalte einer Sicherung nicht lesbar.

Die Volume-Sicherungen am Docker-Host sind zusätzlich **als Ganzes verschlüsselt** – mit einem eigenen
Sicherungsschlüssel (`/etc/blaulichtcms/backup.key`), der nicht im Volume und nicht im Sicherungsziel liegt. Eine Kopie
dieses Schlüssels gehört getrennt verwahrt (Passwortmanager oder Tresor): Ohne ihn ist keine Wiederherstellung möglich.

## Sicherung ohne Unterbrechung

Unter **Einstellungen → Sicherung** erstellt BlaulichtCMS täglich eine verschlüsselte Datenbanksicherung unter `/data/backups`. Sie liegt im selben Volume – für den Ernstfall gehört eine Kopie **außerhalb** des Volumes.

## Tägliche Sicherung (empfohlen)

`install.sh` richtet auf Wunsch eine tägliche Sicherung um 02:30 ein (`/etc/cron.d/blaulichtcms`): vollständiges Volume nach `/opt/apps/blaulichtcms-sicherungen`, **14 tägliche und 8 wöchentliche Stände**, der Container hält dafür wenige Sekunden an. Das Ziel am besten auf ein NAS oder einen zweiten Datenträger legen (`BLAULICHTCMS_BACKUP_DIR`) und regelmäßig eine Kopie außer Haus bringen. Von Hand: `scripts/backup-volume.sh <zielordner>`.

## Prüfung der Sicherungen

Jede Sicherung wird nach dem Schreiben geprüft: Die Datenbanksicherung wird entschlüsselt und ihr Inhaltsverzeichnis
gelesen, die tägliche Volume-Sicherung wird vollständig entschlüsselt und gelesen. Einmal pro Woche spielt der
Docker-Host die Sicherung zusätzlich in eine Wegwerf-Instanz ohne Netzwerk ein und prüft, ob sie startet. Schlägt
etwas fehl, erhalten alle mit „System verwalten“ eine Benachrichtigung. Vierteljährlich sollte der Betrieb die
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
