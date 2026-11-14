**MQTT** ist ein schlankes Nachrichtenprotokoll für Geräte und Sensoren. In der Feuerwehr begegnet es euch z. B. bei Fahrzeugstatus-Anzeigen, Torsteuerungen, Wetterstationen oder einer Hausautomation im Gerätehaus. Ein zentraler **Broker** verteilt Nachrichten an alle, die ein **Topic** abonniert haben.

LifeLink kann Nachrichten empfangen (Trigger **MQTT-Nachricht**) und senden (Baustein **MQTT veröffentlichen**).

## Verbindung anlegen

1. [Schnittstellen](/schnittstellen) → **MQTT** → verbinden.
2. Ausfüllen:

| Feld | Hinweis |
|---|---|
| **Broker** | Servername, z. B. `broker.feuerwehr-musterstadt.de` |
| **TLS verwenden** | Standard an. Der Port wird automatisch angepasst: 8883 mit TLS, 1883 ohne. |
| **Benutzername / Passwort** | eigenes Konto nur für LifeLink anlegen |
| **Erlaubte Topics** | Pflicht. Nur diese Topics darf LifeLink abonnieren oder beschreiben. |
| **Client-ID** | erweitert, Standard automatisch |
| **Standard-QoS** | erweitert: 0 = höchstens einmal, 1 = mindestens einmal (Standard), 2 = genau einmal |

3. **Verbindung testen**: LifeLink verbindet sich mit dem Broker, prüft die Anmeldung und trennt die Verbindung wieder sauber.

### TLS

Mit TLS wird das Zertifikat des Brokers geprüft. Selbst signierte Zertifikate werden abgelehnt – nutzt ein gültiges Zertifikat (z. B. von Let's Encrypt). Ohne TLS gehen Benutzername und Passwort im Klartext über das Netz; das ist höchstens in einem abgeschotteten internen Netz vertretbar.

### Topic-Freigabeliste

Die Freigabeliste ist eine Sicherheitsgrenze: Auch wenn jemand einen Workflow falsch konfiguriert, kann LifeLink nur die hier eingetragenen Topics nutzen. Platzhalter:

| Platzhalter | Bedeutung | Beispiel |
|---|---|---|
| `+` | genau eine Ebene | `feuerwehr/status/+` passt auf `feuerwehr/status/hlf1` |
| `#` | alle Ebenen darunter (nur am Ende) | `feuerwehr/status/#` passt auf `feuerwehr/status/hlf1/funk` |

Zusätzlich solltet ihr das LifeLink-Konto **im Broker** per ACL auf dieselben Topics begrenzen.

## Nachrichten empfangen

Der Trigger **MQTT-Nachricht** startet für **jede** Nachricht auf dem Topic einen Lauf.

- **Topic**: z. B. `feuerwehr/status/+`. Es muss von der Freigabeliste der Verbindung abgedeckt sein, sonst wird nichts abonniert und im Systemstatus erscheint ein Trigger-Fehler.
- **Inhalt als JSON lesen**: Standard an. Ist der Inhalt kein JSON, bleibt er Text.
- **Maximale Nachrichtengröße**: größere Nachrichten werden ignoriert (Standard 64 KB).

Im Workflow stehen `{{ trigger.topic }}`, `{{ trigger.payload }}` (z. B. `{{ trigger.payload.status }}`) und `{{ trigger.retained }}` bereit.

> **Tipp:** Topics mit sehr vielen Nachrichten (z. B. sekündliche Messwerte) erzeugen sehr viele Läufe. Abonniert nur, was wirklich etwas auslösen soll – etwa Statuswechsel.

Das Abo hält der Worker dauerhaft offen und verbindet sich nach Unterbrechungen automatisch neu (alle 10 Sekunden).

## Nachrichten senden

Der Baustein **MQTT veröffentlichen**:

- **Topic**: fest, ohne Platzhalter und ohne Variablen. Es muss in der Freigabeliste stehen.
- **Inhalt**: Text mit Variablen, z. B. `{"einsatz":"{{ alamos.stichwort }}","zeit":"{{ alamos.alarmzeit }}"}`. Höchstens 256 KB.
- **QoS**: 0, 1 oder 2.
- **Retain**: Der Broker speichert die letzte Nachricht und liefert sie an neue Abonnenten aus – praktisch für Anzeigen, die beim Einschalten den aktuellen Stand zeigen sollen.

MQTT veröffentlichen ist **wiederholungssicher** und wird bei vorübergehenden Fehlern automatisch wiederholt.

## Fehler

| Meldung | Lösung |
|---|---|
| Topic „…“ ist in der Verbindung nicht freigegeben. | Topic in der Verbindung unter „Erlaubte Topics“ ergänzen. |
| Der Broker hat die Anmeldung abgelehnt. | Benutzername/Passwort prüfen, ACL im Broker prüfen. |
| Broker nicht erreichbar / antwortet nicht. | Servername, Port und TLS-Schalter prüfen; Firewall zwischen LifeLink und Broker. |
