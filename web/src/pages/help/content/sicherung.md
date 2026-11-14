LifeLink sichert seine Datenbank automatisch und verschlüsselt. In der Sicherung steckt alles: Workflows mit Versionen, Verbindungen (mit verschlüsselten Zugangsdaten), Benutzer, Banner, Einstellungen, Läufe und das Audit-Protokoll.

## Automatische Sicherungen

Einstellbar unter [Einstellungen](/einstellungen) → **Sicherung** (Recht „System verwalten“):

| Einstellung | Standard |
|---|---|
| Automatische Sicherung | an |
| Uhrzeit (Zeitzone der Instanz) | 3 Uhr nachts |
| Anzahl aufbewahrter Sicherungen | 14 |

Ältere Sicherungen werden automatisch gelöscht. Schlägt eine Sicherung fehl, bekommen alle mit „System verwalten“ eine Benachrichtigung. Die letzte Sicherung seht ihr auch im [Systemstatus](/system).

Mit **Jetzt sichern** erstellt ihr jederzeit eine Sicherung von Hand – zum Beispiel vor größeren Änderungen.

## Wie die Sicherung aufgebaut ist

- Eine Datei je Sicherung, z. B. `lifelink-2026-10-29-03-00.llbk`, im Daten-Volume unter `/data/backups`.
- Inhalt: ein vollständiger PostgreSQL-Abzug, **verschlüsselt** mit einem Schlüssel, der aus dem **Master-Schlüssel** abgeleitet ist.
- Ohne den Master-Schlüssel ist die Datei wertlos – für Angreifer und leider auch für euch.

## Sicherungen herunterladen

Liegt die Sicherung nur auf demselben Server, hilft sie bei einem Festplattenschaden nicht. Ladet Sicherungen deshalb regelmäßig herunter (Einstellungen → Sicherung → Herunterladen) und legt sie an einem zweiten Ort ab, z. B. auf dem NAS der Wehr. Jeder Download wird im Audit-Protokoll vermerkt.

> **Wichtig:** Bewahrt den **Master-Schlüssel getrennt** von den Sicherungen auf – etwa im Passwort-Manager. Liegen beide zusammen, kann jeder mit Zugriff auf diesen Ort alles entschlüsseln. Fehlt der Master-Schlüssel, ist keine Wiederherstellung möglich.

## Wiederherstellung Schritt für Schritt

Ihr braucht: Zugriff auf den Server (Kommandozeile im LifeLink-Ordner, z. B. `/opt/lifelink`), die `.llbk`-Datei und **denselben Master-Schlüssel** in der `.env`, der beim Erstellen der Sicherung galt.

**1. Sicherung in den Container kopieren und entschlüsseln**

```bash
cd /opt/lifelink
docker compose cp ./lifelink-2026-10-29-03-00.llbk lifelink:/data/restore.llbk
docker compose exec lifelink node server/dist/cli.js backup-decrypt /data/restore.llbk /data/restore.dump
```

Stimmt der Master-Schlüssel nicht, bricht `backup-decrypt` mit einem Fehler ab.

**2. Entschlüsselte Datei herausholen und im Container aufräumen**

```bash
docker compose cp lifelink:/data/restore.dump ./restore.dump
docker compose exec lifelink rm /data/restore.llbk /data/restore.dump
```

**3. LifeLink anhalten und die Datenbank zurückspielen**

```bash
docker compose stop lifelink
docker compose exec -T lifelink-db pg_restore --clean --if-exists --no-owner -U lifelink -d lifelink < ./restore.dump
```

`--clean --if-exists` ersetzt den aktuellen Datenbankinhalt vollständig durch den Stand der Sicherung.

**4. LifeLink wieder starten und aufräumen**

```bash
docker compose start lifelink
rm ./restore.dump
```

> **Achtung:** `restore.dump` ist **unverschlüsselt** und enthält Einsatzdaten. Löscht die Datei sofort nach der Wiederherstellung.

**5. Prüfen**

- Anmelden, [Systemstatus](/system) prüfen: Datenbank und Worker grün?
- Workflows und Verbindungen da? Verbindungen einmal **testen**.
- Alles, was nach dem Zeitpunkt der Sicherung geändert wurde, fehlt – zum Beispiel neue Workflows oder Banner.

## Auf einen neuen Server umziehen

1. Auf dem neuen Server LifeLink installieren (siehe [Installation & Betrieb](/hilfe/betrieb#installation)) – aber mit dem **alten Master-Schlüssel** in der `.env`, keinen neuen erzeugen.
2. Die Sicherung wie oben wiederherstellen.
3. `PUBLIC_URL` anpassen, falls sich die Adresse ändert. Achtung: Dann ändern sich auch die Webhook-Adressen, und die Absender (z. B. FE2) müssen umgestellt werden.

## Üben

Eine Sicherung ist erst dann etwas wert, wenn die Wiederherstellung klappt. Übt sie regelmäßig – am besten auf einem Testsystem, etwa einmal im Jahr oder nach größeren Updates.
