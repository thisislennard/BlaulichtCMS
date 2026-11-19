# Code-Signatur der BlaulichtCMS Bridge

Ab Bridge 0.6.0 (#107). Ziel: Wer den BlaulichtCMS-Server oder sein Volume übernimmt, soll **keinen** eigenen PHP-Code als
„Update“ an die gekoppelten Websites verteilen können.

## Warum die Prüfsumme allein nicht reicht

Das Update-Angebot nennt eine SHA-256-Prüfsumme, und die Bridge prüft das Paket dagegen. Angebot, Prüfsumme und Paket
kommen aber vom selben Server, und der Download-Link ist mit einem Schlüssel signiert, der aus dem Master-Schlüssel auf
dem Server abgeleitet ist. Die Prüfsumme schützt also gegen Übertragungsfehler, nicht gegen einen übernommenen Server.

## Verfahren

- **Schlüssel:** Ed25519. Der **private** Schlüssel liegt offline beim Betreiber (z. B. verschlüsselter USB-Stick oder
  Passwortmanager), **nie** im Repository und **nie** auf dem BlaulichtCMS-Server. Der **öffentliche** Schlüssel steht fest
  in der Bridge (`wordpress-plugin/blaulichtcms-bridge/includes/signing-keys.php`).
- **Signiert** wird eine Dateiliste: `wordpress-plugin/blaulichtcms-bridge/signature.json` enthält Version, SHA-256 jeder
  Datei und die Signatur. (Nicht das ZIP – das baut BlaulichtCMS beim Start selbst.)
- **Prüfung in WordPress:** Vor der Installation eines Updates prüft die **installierte** Bridge das entpackte Paket mit
  den in **ihr** hinterlegten Schlüsseln (`sodium_crypto_sign_verify_detached`; PHP-Kern ab 7.2, sonst sodium_compat
  aus WordPress): Signatur gültig, jede Datei passt, keine zusätzliche oder fehlende Datei, Version im Plugin-Kopf
  gleich der signierten und neuer als die installierte (kein Zurückspielen alter, verwundbarer Versionen). Sonst bricht
  WordPress das Update mit einer Meldung ab. Die Prüfsummenkontrolle bleibt zusätzlich bestehen.
- **Prüfung in BlaulichtCMS:** Unter *Einrichtung → Verbindungen → Websites → Bridge-Updates* zeigt BlaulichtCMS, ob das Paket im Image gültig signiert ist.
  Ein unsigniertes oder falsch signiertes Paket wird den Websites nicht angeboten. Das ist nur eine Hilfe gegen
  Versehen – maßgeblich ist die Prüfung in der Bridge.
- **Server-Test:** `server/test/units.test.ts` schlägt fehl, wenn Schlüssel hinterlegt sind, die Bridge aber nach dem
  Signieren geändert wurde. Lokal prüfen: `node scripts/bridge-signing.mjs verify`.

## Rückfallbetrieb (Auslieferungszustand)

Solange in `signing-keys.php` **kein** Schlüssel steht, prüft die Bridge nur die Prüfsumme (Verhalten wie bis 0.5.x).
Die Einstellungsseite der Bridge zeigt dann „Update-Signatur: nicht eingerichtet“, BlaulichtCMS „ohne Signatur (nur
Prüfsumme)“. Das Schlüsselpaar kann nur der Betreiber erzeugen; deshalb ist 0.6.0 ohne Schlüssel ausgeliefert.

## Einrichtung (einmalig, durch den Betreiber)

Voraussetzung: Node.js 24 und ein Klon des Repositorys.

1. Schlüsselpaar erzeugen – Ziel **außerhalb** des Repositorys:
   ```
   node scripts/bridge-signing.mjs keygen /pfad/ausserhalb/blaulichtcms-bridge-signing.pem
   ```
   Das Skript schreibt den privaten Schlüssel (PEM) und trägt den öffentlichen in `includes/signing-keys.php` ein.
   Vom privaten Schlüssel eine Sicherungskopie an einem zweiten sicheren Ort anlegen (Unix: die Datei hat Rechte 600;
   unter Windows die Zugriffsrechte selbst einschränken).
2. Bridge-Version erhöhen (Kopf und Konstante in `blaulichtcms-bridge.php`, `readme.txt` Stable tag und Changelog,
   `server/test/integration.test.ts`, `test/e2e/m4-flow.mjs` – siehe CLAUDE.md).
3. Signieren und prüfen:
   ```
   node scripts/bridge-signing.mjs sign /pfad/ausserhalb/blaulichtcms-bridge-signing.pem
   node scripts/bridge-signing.mjs verify
   ```
4. `includes/signing-keys.php`, `signature.json` und die Versionsänderung committen und wie gewohnt ausliefern
   (`install.sh`); die Websites erhalten die neue Bridge dann über den WordPress-Updateweg.

**Bei jeder späteren Änderung an der Bridge** nach dem Erhöhen der Version Schritt 3 wiederholen. Ohne neue Signatur
schlägt der Server-Test fehl, BlaulichtCMS zeigt „Signatur ungültig“ und bietet das Paket nicht an.

Statt des Pfads kann der private Schlüssel als PEM in der Umgebungsvariable `BRIDGE_SIGNING_KEY` stehen, z. B. für
eine Signatur in einer eigenen CI-Umgebung. Dann liegt der Schlüssel bei diesem CI-Anbieter – schwächer als offline,
aber weiterhin nicht auf dem BlaulichtCMS-Server.

## Schlüsselwechsel

Die installierte Bridge vertraut nur ihren eigenen Schlüsseln. Für einen Wechsel:

1. Neuen Schlüssel mit `keygen` erzeugen (er wird zusätzlich eingetragen), Version erhöhen, mit dem **alten** Schlüssel
   signieren und verteilen.
2. Ab der nächsten Version mit dem neuen Schlüssel signieren; den alten Eintrag aus `signing-keys.php` entfernen.

Ist der private Schlüssel **verloren**, lassen sich Websites mit dieser Bridge nicht mehr über den Updateweg
aktualisieren: neue Version mit neuem Schlüssel per Hand installieren (*Plugins → Installieren → Plugin hochladen* –
bewusst hochgeladene Pakete prüft die Bridge nicht). Ist er **kompromittiert**, ebenso: neue Version mit neuem
Schlüssel per Hand auf allen Websites installieren.

## Restrisiko (ehrlich)

- **Übergang:** Websites mit einer Bridge ohne Schlüssel (0.6.0 und älter) nehmen die erste Version mit Schlüssel noch
  ohne Signaturprüfung an (nur Prüfsumme). Wer genau in diesem Zeitfenster den BlaulichtCMS-Server kontrolliert, könnte
  stattdessen eigenen Code ausliefern. Abhilfe: die erste Version mit Schlüssel per Hand installieren (ZIP aus
  *Einrichtung → Verbindungen → Websites → Bridge herunterladen* nach Prüfung von `node scripts/bridge-signing.mjs verify`) oder den Übergang zügig
  nach der Einrichtung durchführen.
- **Schlüssel im Plugin-Verzeichnis:** Wer bereits Schreibzugriff auf die WordPress-Dateien hat, kann
  `signing-keys.php` ändern – er kann dann aber ohnehin beliebigen Code ausführen. Die Signatur schützt den Updateweg,
  nicht eine bereits übernommene Website.
- **Vertrauen in den Signierenden:** Die Signatur belegt nur, dass der Inhaber des privaten Schlüssels das Paket
  freigegeben hat. Sie ersetzt keine Durchsicht der Änderungen vor dem Signieren.
- **Von Hand hochgeladene ZIP-Dateien** (Plugin installieren statt Update) prüft die Bridge nicht – das ist ein
  bewusster Schritt einer Person mit Administratorrechten in WordPress.
- **Verfügbarkeit:** Ein übernommener Server kann Updates zurückhalten oder ein abgelehntes Paket anbieten (die
  Websites bleiben dann auf ihrer Version), aber keinen fremden Code installieren lassen.
