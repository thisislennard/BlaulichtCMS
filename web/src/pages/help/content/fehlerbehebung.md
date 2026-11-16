## Upload-Link

| Problem | Ursache und Lösung |
|---|---|
| „Link nicht mehr gültig“ | Abgelaufen oder widerrufen. In der Sammlung einen neuen Link erzeugen. |
| „Datei ist größer als …“ | Grenze je Datei. Video kürzen oder Grenze unter Einstellungen → Medien anheben. |
| Datei „gesperrt“ | Kein erlaubtes Foto/Video, beschädigt oder zu groß/lang. Der Grund steht unter „In Prüfung / gesperrt“; „Medien administrieren“ kann erneut prüfen, bei Videos mit reinem Dekodierbefund trotzdem freigeben oder endgültig löschen. |
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

## Wenn eine Seite nicht lädt

BlaulichtCMS sagt immer, warum etwas nicht geht und was zu tun ist – mit Symbol, kurzer Erklärung und „Erneut versuchen“. Keine Anfrage dreht endlos: Lesen bricht nach 30 Sekunden ab, Speichern nach 2 Minuten.

| Meldung | Bedeutung | Was tun |
|---|---|---|
| **Zeitüberschreitung** | Der Server hat nicht rechtzeitig geantwortet (langsame Verbindung, hohe Last). | Erneut versuchen. Nach einer Änderung zuerst neu laden und prüfen, ob sie schon gespeichert ist. |
| **Sitzung abgelaufen** | Abmeldung nach Inaktivität oder Ende der Höchstdauer. | Erneut anmelden – danach geht es auf derselben Seite weiter. |
| **Keine Internetverbindung** | Das Gerät ist offline. | Verbindung prüfen; nach der Rückkehr lädt BlaulichtCMS den Stand automatisch neu. |
| **Server nicht erreichbar** | BlaulichtCMS antwortet nicht – oft ein Neustart oder Update (etwa eine Minute). | Warten; es wird automatisch erneut versucht (nach 5, 10, 20, dann alle 30 Sekunden). Dauert es länger, Server und Proxy prüfen ([Container startet nicht](#container-startet-nicht)). |
| **Kein Zugriff** | Für diesen Bereich fehlt ein Recht. | Eine Person mit „Rollen verwalten“ um das Recht bitten. |
| **Seite nicht gefunden** | Die Adresse gibt es nicht (mehr) oder der Eintrag wurde gelöscht. | Link prüfen, über die Übersicht oder die Suche weiter. |
| **Wartung oder Update läuft** | Der Wartungsmodus ist an; Ansehen geht, Ändern nicht. | Ein paar Minuten warten. Beenden: [Systemstatus](/system) → Wartungsmodus. |
| **Zu viele Versuche** | Schutz vor Missbrauch, z. B. viele Anmeldeversuche in kurzer Zeit. | Die angezeigte Wartezeit abwarten (zählt herunter). |
| **Unerwarteter Fehler** | Ein Programmfehler beim Anzeigen. | Seite neu laden; tritt er wieder auf, unter „Details anzeigen“ die Angaben an die Administration geben. |
| **Neue Version verfügbar** | Nach einem Update fehlen alte Programmteile. | Seite neu laden. |

In der installierten App zeigt BlaulichtCMS auch dann die eigene Meldung „Server nicht erreichbar“, wenn statt des Servers nur der Proxy mit einer Fehlerseite (502/503/504) antwortet.

## Container startet nicht

`docker compose logs blaulichtcms` zeigt den Grund. Häufig: Volume voll, oder der Datenbestand stammt von einer anderen PostgreSQL-Hauptversion (siehe [Updates](/hilfe/updates)).
