LifeLink aktualisiert sich über **GitHub-Releases** – direkt aus der Oberfläche, ohne Kommandozeile. Jedes Update ist **signiert**, wird vor dem Einspielen geprüft und bei Problemen automatisch zurückgenommen.

Updates verwalten darf nur ein **Plattform-Admin** mit Benutzerkonto, unter [Updates](/updates).

## Automatische Prüfung

LifeLink schaut regelmäßig nach, ob es eine neue Version gibt – standardmäßig **alle 6 Stunden** (einstellbar von 1 bis 168 Stunden). Ist eine neue Version da, bekommen alle Admins eine Benachrichtigung, und die Seite [Updates](/updates) zeigt Versionsnummer und Änderungsnotizen.

Einstellungen auf der Update-Seite:

| Einstellung | Bedeutung |
|---|---|
| Automatisch prüfen | an/aus |
| Repository | Standard `thisislennard/LifeLink`; nur ändern, wenn ihr eine eigene Ausgabe betreibt |
| Prüfabstand | in Stunden |
| Zugriffstoken | nur nötig bei privatem Repository oder wenn das Abruflimit von GitHub greift; wird verschlüsselt gespeichert |

Mit **Jetzt prüfen** fragt ihr sofort nach.

## Update installieren

1. Änderungsnotizen lesen.
2. **Update installieren** klicken.
3. LifeLink lädt das Paket, prüft es und richtet die neue Version ein. Danach startet LifeLink automatisch mit der neuen Version neu. Die Oberfläche ist dabei ein paar Sekunden nicht erreichbar.
4. Im **Verlauf** auf der Update-Seite seht ihr, ob die neue Version erfolgreich aktiviert wurde.

Ein Downgrade auf eine ältere Version ist nicht möglich.

> **Tipp:** Installiert Updates nicht mitten in einer Großeinsatzlage. Eingehende Webhooks während des kurzen Neustarts beantwortet LifeLink nicht; FE2 bzw. der Absender sollte erneut senden.

## Was geprüft wird

Bevor etwas eingespielt wird, prüft LifeLink:

1. **SHA-256-Prüfsumme** – Ist die Datei vollständig und unverändert angekommen?
2. **Ed25519-Signatur** – Stammt das Paket wirklich vom Herausgeber? Geprüft wird mit dem Schlüssel der **bereits installierten** Version; ein Paket kann sich also nicht selbst beglaubigen. Unsignierte Pakete werden immer abgelehnt.
3. **Inhalt** – Pflichtdateien vorhanden, keine unzulässigen Pfade, keine `.env`, keine Symlinks, Größenbegrenzung.
4. **Version** – neuer als die installierte?
5. **Docker-Image** – reicht das vorhandene Image für dieses Update? (siehe unten)
6. **Rauchtest** – Die neue Version wird probeweise geladen, bevor umgeschaltet wird.

Jeder Installationsversuch – erfolgreich oder nicht – steht im Audit-Protokoll.

## Eigener Release-Ordner

Die neue Version wird in einen **eigenen Ordner** entpackt (`/data/releases/<version>`). Die laufende Version wird dabei nicht angefasst. Eure Daten, die `.env` und die Container-Konfiguration bleiben unverändert. Die letzten Versionen bleiben aufbewahrt.

Datenbank-Änderungen laufen beim Start automatisch. Sie sind so gebaut, dass die vorige Version damit weiterhin funktioniert – das macht das Zurückschalten möglich.

## Automatisches Zurückschalten

Nach dem Umschalten wartet LifeLink, bis die neue Version vollständig gestartet ist. Klappt das nicht innerhalb von **2 Minuten**, schaltet LifeLink **automatisch auf die vorige Version zurück**. Im Update-Verlauf steht dann „zurückgerollt“ mit einem Hinweis; Details stehen im Container-Protokoll:

```bash
docker compose logs --tail 200 lifelink
```

Die vorige Version läuft dann einfach weiter. Meldet den Fehler mit diesem Protokollauszug an den Herausgeber.

## Manueller Upload

Hat der Server keinen Zugang zu GitHub, könnt ihr ein Update auch hochladen:

1. Das Release auf einem anderen Rechner herunterladen. Es besteht aus drei Dateien: `lifelink-update-v<version>.zip`, `….zip.sha256` und `….zip.sig`.
2. Auf der Update-Seite **Manuell hochladen** wählen.
3. ZIP-Datei und `.sig`-Datei auswählen; den Inhalt der `.sha256`-Datei als Prüfsumme angeben.

Es gelten dieselben Prüfungen wie beim Update aus GitHub. Ohne `.sig`-Datei wird das Update abgelehnt.

## Wann ein neues Docker-Image nötig ist

Die meisten Updates tauschen nur das Programm aus. Manche brauchen aber ein neueres **Docker-Image** – etwa bei einer neuen Node.js-Hauptversion, neuen Systempaketen oder Änderungen an der `docker-compose.yml`. Dann lehnt LifeLink das Update in der Oberfläche mit einem Hinweis ab, z. B.:

> Dieses Update braucht ein neueres Docker-Image (mindestens 2.1.0, vorhanden 2.0.0).

So aktualisiert ihr das Image auf dem Server:

```bash
cd /opt/lifelink
git pull
docker compose up -d --build
```

Das neue Image enthält bereits die neueste Version. Ein neueres Image hat immer Vorrang vor älteren In-App-Updates. Daten bleiben in den Volumes erhalten.

## Wenn etwas schiefgeht

| Meldung | Bedeutung |
|---|---|
| SHA-256-Prüfsumme stimmt nicht überein | Download beschädigt oder falsche Datei. Erneut versuchen. |
| Signatur ungültig / fehlt | Paket nicht vom Herausgeber oder verändert. **Nicht** installieren. |
| Version … ist nicht neuer als die installierte Version | Ihr seid bereits aktuell. |
| Dieses Update braucht ein neueres Docker-Image | Siehe oben: `git pull` und `docker compose up -d --build`. |
| GitHub verweigert den Zugriff | Abruflimit erreicht oder Token ungültig. Später erneut prüfen oder Token hinterlegen. |
| Es läuft bereits eine Installation | Warten, bis die laufende Installation fertig ist. |
