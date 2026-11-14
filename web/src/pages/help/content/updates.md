LifeLink wird über ein neues Image am Docker-Host aktualisiert. Es gibt keinen Code-Austausch aus der Oberfläche heraus. Der Ablauf lautet immer: **Sichern → Wechseln → Prüfen → Wiederherstellen** (nur im Fehlerfall).

## Update vorbereiten

Unter [Einstellungen → Sicherung](/einstellungen#sicherung) zeigt **„Update vorbereiten“** die Vorabprüfung:

- Wartungsmodus aktiv (keine neuen schreibenden Vorgänge, keine neuen Aufträge)
- keine laufenden Hintergrundaufträge, kein Versand und keine Veröffentlichung in der Schwebe
- keine ungeklärten Ergebnisse (Hinweis)
- genug freier Speicher, aktuelle Datenbanksicherung (Hinweis)
- Schema passt zum laufenden Programm

Im **Wartungsmodus** bleibt Lesen möglich. Websites erhalten keine neuen Aufträge; bereits angezeigte Banner bleiben unverändert.

## Update durchführen (Docker-Host)

```
scripts/update.sh <neues-image> /pfad/zu/sicherungen --rollback
```

Das Skript schaltet den Wartungsmodus ein, wartet auf „bereit“, legt eine vollständige Sicherung außerhalb des Volumes an, wechselt das Image, prüft den Start und beendet den Wartungsmodus. Mit `--rollback` kehrt es bei einem Fehler automatisch zum alten Image **mit** dem Datenstand von vor dem Update zurück.

## Wenn LifeLink nicht startet

- **Migration fehlgeschlagen:** Die Migration wird vollständig zurückgerollt, die Daten bleiben unverändert. Der Webport zeigt eine Sperrseite mit dem Grund.
- **„Datenstand neuer als dieses Programm“:** Ein älteres Image wurde auf einen bereits aktualisierten Datenstand gestartet. Zurück geht es nur mit der Sicherung von vor dem Update.
- **PostgreSQL-Hauptversion abweichend:** LifeLink startet nicht und nennt den Grund. Der getestete Weg (Export, neuer Cluster, Import) steht in `docs/betrieb.md`.

## LifeLink Bridge

Neue Bridge-Versionen kommen über den normalen **WordPress-Updateweg** (Dashboard → Aktualisierungen). Unter [Websites](/kanaele) → **Bridge-Updates**:

1. Eine Testwebsite in den Kanal **„Test“** setzen – sie erhält die neue Version sofort.
2. Auf der Testwebsite aktualisieren und prüfen. WordPress prüft das Paket vor der Installation gegen die Prüfsumme aus LifeLink; die Kopplung bleibt erhalten.
3. **Version für alle freigeben** – möglich erst, wenn die Testwebsite die neue Version meldet. Danach erhalten alle Websites das Update.
