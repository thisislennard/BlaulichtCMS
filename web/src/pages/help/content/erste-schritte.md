LifeLink verbindet die Systeme eurer Feuerwehr miteinander: Alamos FE2, die WordPress-Website, E-Mail, Microsoft Teams, MQTT und beliebige Web-Schnittstellen. Statt Daten von Hand zu übertragen, beschreibt ihr einmal einen **Ablauf** – LifeLink führt ihn dann jedes Mal zuverlässig aus.

Ein typisches Beispiel: Bei einem Brandeinsatz soll auf der Website für eine Stunde ein rotes Banner „Bitte Rettungswege freihalten“ erscheinen – ohne dass jemand daran denken muss.

## Die wichtigsten Begriffe

| Begriff | Bedeutung | Beispiel |
|---|---|---|
| **Workflow** | Ein gespeicherter Ablauf aus mehreren Schritten. | „Einsatz → Website-Banner“ |
| **Trigger** | Der Auslöser. Er startet den Workflow. Jeder Workflow hat genau einen. | Ein neuer Einsatz kommt aus FE2, ein Zeitplan „jeden Montag 7 Uhr“ |
| **Baustein** | Ein einzelner Schritt im Workflow (auch „Node“ genannt). | „Filter“, „E-Mail senden“, „WordPress-Banner“ |
| **Verbindung (Linie)** | Die Linie zwischen zwei Bausteinen. Sie legt die Reihenfolge fest. | Trigger → Filter → Banner |
| **Verbindung (Zugang)** | Gespeicherte Zugangsdaten zu einem System, z. B. Mailserver oder Website. Wird einmal angelegt und von vielen Workflows genutzt. | „SMTP Feuerwehr Musterstadt“ |
| **Lauf** | Eine einzelne Ausführung eines Workflows. Jeder Lauf hat eine Nummer, z. B. #1042. | Der Workflow lief um 16:08 Uhr wegen Einsatz B3 |
| **Version** | Ein unveränderlicher, veröffentlichter Stand des Workflows. Läufe verwenden immer die aktive Version, nie den Entwurf. | v3 ist aktiv, v4 wartet auf Freigabe |
| **Entwurf** | Der Stand, an dem ihr gerade arbeitet. Er wird automatisch gespeichert, wirkt aber erst nach dem Veröffentlichen. | – |

> **Gut zu wissen:** Der Entwurf und die aktive Version sind getrennt. Ihr könnt also in Ruhe an einem laufenden Workflow weiterarbeiten – die Einsätze von heute Abend laufen weiter mit der veröffentlichten Version.

## So arbeitet LifeLink

1. Ein **Trigger** bekommt ein Ereignis, zum Beispiel einen Einsatz aus FE2.
2. LifeLink speichert das Ereignis und startet einen **Lauf** im Hintergrund.
3. Die **Bausteine** werden der Reihe nach ausgeführt. Jeder Baustein kann die Ergebnisse der vorherigen verwenden – über [Variablen](/hilfe/variablen).
4. Jeder Schritt wird im [Ausführungsverlauf](/ausfuehrungen) protokolliert. Geheimnisse werden dabei immer maskiert.
5. Schlägt etwas vorübergehend fehl (Mailserver kurz weg), versucht LifeLink es automatisch erneut. Mehr dazu in [Ausführungen verstehen](/hilfe/ausfuehrungen).

## Erster Workflow in 10 Minuten

Wir bauen einen Workflow aus der Vorlage **„Webhook → E-Mail“**: Ein anderes System schickt eine Meldung an LifeLink, LifeLink leitet sie per E-Mail an einen festen Verteiler weiter. Ihr braucht dafür nur die Zugangsdaten eures Mailservers.

### Schritt 1: Mailserver verbinden (3 Minuten)

1. Öffnet [Schnittstellen](/schnittstellen) und wählt **E-Mail (SMTP)**.
2. Tragt Server, Verschlüsselung (meist STARTTLS, Port 587), Benutzername, Passwort und Absender ein – zum Beispiel `LifeLink <lifelink@feuerwehr-musterstadt.de>`.
3. Klickt auf **Verbindung testen**. LifeLink prüft, ob der Server erreichbar ist und die Anmeldung klappt.
4. Speichert die Verbindung.

Details stehen im Kapitel [E-Mail & Microsoft 365](/hilfe/e-mail).

### Schritt 2: Workflow aus der Vorlage anlegen (2 Minuten)

1. Öffnet [Workflow-Vorlagen](/vorlagen) und wählt **Webhook → E-Mail**.
2. Gebt dem Workflow einen Namen, z. B. „Meldungen an Wehrführung“. Der Editor öffnet sich.
3. Klickt auf den Baustein **E-Mail senden** und wählt rechts eure SMTP-Verbindung.
4. Tragt unter **Empfänger** eine feste Adresse ein, z. B. `wehrfuehrung@feuerwehr-musterstadt.de`.

Betreff und Text sind schon mit Variablen vorbelegt, z. B. `{{ webhook.body.betreff | default:"Neue Meldung" }}`. Das bedeutet: „Nimm das Feld *betreff* aus den empfangenen Daten – und wenn es fehlt, schreibe ‚Neue Meldung‘.“

### Schritt 3: Testen, ohne etwas zu verschicken (2 Minuten)

1. Klickt oben auf **Testen**. Standardmäßig ist der Testlauf **simuliert**: LifeLink rechnet alles durch, verschickt aber keine E-Mail.
2. Im Ergebnis seht ihr an jedem Baustein, was passiert wäre – inklusive fertigem Betreff und Text.

Mehr Möglichkeiten (echte Testdaten, einzelne Bausteine testen) stehen in [Testen](/hilfe/testen).

### Schritt 4: Veröffentlichen und aktivieren (3 Minuten)

1. Klickt auf **Veröffentlichen**. LifeLink prüft den Workflow und zeigt eine Vorschau: welcher Trigger, welche Felder verwendet werden, an wen E-Mails gehen und ob Aktionen automatisch wiederholt werden.
2. Schreibt eine kurze Änderungsnotiz, z. B. „Erste Version“, und bestätigt.
3. Der Workflow ist jetzt **aktiv** (Version v1). Beim ersten Veröffentlichen zeigt LifeLink die Adresse des Webhooks und das Geheimnis an – es sei denn, ihr habt beides vorher schon im Trigger-Baustein über „Adresse jetzt anlegen“ erzeugt. Die Adresse steht danach jederzeit unter [Webhooks](/webhooks).

> **Achtung:** Das Geheimnis eines Webhooks wird nur einmal angezeigt. Speichert es sofort im System, das die Meldungen schickt. Verpasst? Unter [Webhooks](/webhooks) mit „Geheimnis rotieren“ ein neues erzeugen. Wie der Absender die Anfragen signiert, steht im Kapitel [Webhooks](/hilfe/webhooks).

Habt ihr kein Recht zum Veröffentlichen oder ist die Vier-Augen-Freigabe eingeschaltet, wartet die Version auf eine zweite Person. Siehe [Workflows bearbeiten](/hilfe/workflows#vier-augen-freigabe).

## Weitere Vorlagen

| Vorlage | Was sie tut | Braucht |
|---|---|---|
| Einsatz → Website-Banner | Zeigt bei Einsätzen, deren Stichwort mit „B“ beginnt, eine Stunde lang ein rotes Banner. Keine Adressen, keine Personendaten. | Alamos FE2, WordPress |
| Einsatz → Beitragsentwurf | Legt zu jedem Einsatz einen Beitragsentwurf an, den die Redaktion ergänzt. | Alamos FE2, WordPress |
| Kalendertermin → E-Mail | Informiert einen Verteiler über neue, geänderte oder abgesagte Termine im FE2-Kalender. | Alamos FE2 (iCal), SMTP |
| Webhook → Teams | Nimmt signierte Meldungen an und postet wichtige davon in einen Teams-Kanal. | Teams |
| Webhook → E-Mail | Leitet eingehende Meldungen per E-Mail weiter. | SMTP |
| Erreichbarkeit prüfen | Prüft alle 15 Minuten eine Adresse und meldet Ausfälle in Teams. | Teams |

## Wie geht es weiter?

- [Workflows bearbeiten](/hilfe/workflows) – den Editor im Detail
- [Variablen & Ausdrücke](/hilfe/variablen) – Daten weiterreichen und formatieren
- [Alamos FE2 anbinden](/hilfe/alamos-fe2) – Einsätze automatisch empfangen
- [WordPress-Banner & Beiträge](/hilfe/wordpress) – die Website automatisch aktualisieren
