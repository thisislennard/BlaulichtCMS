LifeLink wird über ein neues Image am Docker-Host aktualisiert. Es gibt keinen Code-Austausch aus der Oberfläche heraus.

## Vor dem Update

1. Unter **Systemstatus** prüfen: freier Speicher, letzte Sicherung, keine wartenden Veröffentlichungen.
2. Eine vollständige Sicherung außerhalb des Volumes anlegen (siehe [Sicherung](/hilfe/sicherung)).

## Update

```
git pull
docker compose up -d --build
```

Beim Start führt LifeLink die Datenbankmigrationen aus. Der Healthcheck meldet „bereit“, sobald Datenbank, Schema und Worker laufen.

## Wenn etwas schiefgeht

Das vorige Image zusammen mit der passenden Sicherung wiederherstellen. Ein Wechsel der **PostgreSQL-Hauptversion** wird nicht automatisch durchgeführt: LifeLink startet dann nicht und nennt den Grund im Protokoll. Der Weg dafür steht in `docs/betrieb.md`.

## LifeLink Bridge

Neue Bridge-Versionen gibt es als ZIP unter [Websites](/kanaele). Zuerst auf einer Testwebsite einspielen. Die Kopplung bleibt beim Update erhalten.
