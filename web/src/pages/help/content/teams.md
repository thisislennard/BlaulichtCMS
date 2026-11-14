LifeLink postet Nachrichten in einen Teams-Kanal – zum Beispiel „Website antwortet nicht“ in den Kanal der IT-Gruppe oder wichtige Meldungen in den Kanal der Wehrführung. Dafür nutzt Teams die App **Workflows**, die eine geheime Webhook-Adresse für den Kanal erzeugt.

## Webhook im Kanal anlegen

1. Öffnet in Microsoft Teams den gewünschten **Kanal**.
2. Klickt beim Kanalnamen auf **⋯ → Workflows** (je nach Teams-Version auch über **Apps → Workflows**).
3. Wählt die Vorlage **„Bei Empfang einer Webhookanforderung in einem Kanal posten“**.
4. Gebt dem Workflow einen Namen, z. B. „LifeLink“, und bestätigt Team und Kanal.
5. Teams zeigt am Ende die **Webhook-Adresse**. Kopiert sie.

> **Wichtig:** Die Webhook-Adresse ist ein Geheimnis. Wer sie kennt, kann in den Kanal schreiben. Gebt sie nur in LifeLink ein.

## Verbindung in LifeLink

1. [Schnittstellen](/schnittstellen) → **Microsoft Teams** → verbinden.
2. **Kanal (Anzeige)**: nur zur Orientierung, z. B. „Wehrführung › Allgemein“.
3. **Webhook-Adresse** einfügen. Sie wird verschlüsselt gespeichert.
4. **Verbindung testen**: LifeLink prüft, ob es eine Microsoft-Adresse ist (https, Microsoft-Host). Es wird **keine** Nachricht gesendet.

Eine echte Testnachricht schickt ihr im Editor über **Node testen** mit echter Ausführung (braucht das Recht „Aktivieren & veröffentlichen“).

Pro Kanal legt ihr eine eigene Verbindung an. Der Zielkanal steht damit fest und kann nie aus eingehenden Daten kommen.

## Der Baustein „Teams-Nachricht“

Die Nachricht erscheint im Kanal als Karte (Adaptive Card):

| Feld | Bedeutung |
|---|---|
| **Titel** | fett, Pflicht, z. B. `Einsatz {{ alamos.stichwort }}` |
| **Text** | darunter, mehrzeilig |
| **Details (Tabelle)** | Name/Wert-Paare als kleine Tabelle, z. B. „Ort“ → `{{ alamos.ortsteil }}` |
| **Hervorhebung** | Normal, Wichtig (rot), Warnung (gelb), Positiv (grün) – färbt den Titel |

> **Achtung:** Teams-Nachrichten sind **nicht wiederholungssicher**. Wird ein Lauf vollständig erneut ausgeführt, erscheint die Nachricht ein zweites Mal.

## Wenn nichts im Kanal ankommt

- **Verbindung testen** schlägt fehl mit „Keine Microsoft-Webhook-Adresse“: Es wurde eine falsche Adresse kopiert. Nehmt die Adresse aus dem Workflows-Schritt „Bei Empfang einer Webhookanforderung“.
- Lauf erfolgreich, aber keine Nachricht: Prüft in Teams unter **Workflows**, ob der Teams-Workflow eingeschaltet ist und fehlerfrei läuft (Ausführungsverlauf des Teams-Workflows).
- Fehler 401/403: Der Teams-Workflow wurde gelöscht oder neu angelegt. Neue Adresse erzeugen und in der Verbindung ersetzen.
- Fehler 429: Teams begrenzt die Anzahl der Nachrichten. LifeLink wiederholt automatisch.
