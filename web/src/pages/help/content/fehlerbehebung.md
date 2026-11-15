## Upload-Link

| Problem | Ursache und Lösung |
|---|---|
| „Link nicht mehr gültig“ | Abgelaufen oder widerrufen. In der Sammlung einen neuen Link erzeugen. |
| „Datei ist größer als …“ | Grenze je Datei. Video kürzen oder Grenze unter Einstellungen → Medien anheben. |
| Datei „abgewiesen“ | Kein erlaubtes Foto/Video oder beschädigt. Der Grund steht unter „In Prüfung / abgewiesen“. |
| „Wird geprüft“ bleibt stehen | Worker läuft nicht. Systemstatus prüfen, ggf. Container neu starten. |
| Uploads gesperrt, „Speicher fast voll“ | Freien Speicher schaffen oder Mindestspeicher anpassen. |

## Veröffentlichung

| Problem | Ursache und Lösung |
|---|---|
| Kein „Veröffentlichen“-Button | Fassung nicht freigegeben, kein Zielkanal gewählt oder Recht „Veröffentlichen“ fehlt. |
| „Wartet auf Abholung“ bleibt | Bridge holt nicht ab: in WordPress „Letzter Abruf“ prüfen, WP-Cron bzw. Host-Cron einrichten. |
| „Fehlgeschlagen“ | Fehlermeldung lesen (z. B. Medien-Upload in WordPress verboten), beheben, „Erneut versuchen“. |
| „Ergebnis unbekannt“ | Die Bridge hat abgeholt, aber nicht bestätigt. Beim nächsten Abruf wird automatisch abgeglichen. |

## Anmeldung (Notfallbefehle am Server)

```
# Link zum Neusetzen des Passworts (24 h gültig)
docker compose exec blaulichtcms node server/dist/cli.js password-link admin@example.org
# Zwei-Faktor-Anmeldung zurücksetzen
docker compose exec blaulichtcms node server/dist/cli.js reset-mfa admin@example.org
# Installation prüfen
docker compose exec blaulichtcms node server/dist/cli.js self-check
```

## Container startet nicht

`docker compose logs blaulichtcms` zeigt den Grund. Häufig: Volume voll, oder der Datenbestand stammt von einer anderen PostgreSQL-Hauptversion (siehe [Updates](/hilfe/updates)).
