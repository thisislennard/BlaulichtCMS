Für Systeme ohne eigene Integration gibt es den Baustein **HTTP-Anfrage**. Damit ruft LifeLink beliebige Web-Schnittstellen (REST-APIs) auf – etwa eine Fahrzeugverwaltung, einen Statusmonitor oder einen Messenger-Dienst.

## Ohne oder mit Verbindung

Der Baustein funktioniert auf zwei Arten:

| | Ohne Verbindung | Mit Verbindung **REST-API** |
|---|---|---|
| Adresse | vollständig im Baustein, z. B. `https://api.beispiel.de/v1/status` | Basis-Adresse in der Verbindung, im Baustein nur noch der Pfad, z. B. `/einsaetze` |
| Anmeldung | keine | Bearer-Token, Benutzername + Passwort oder API-Schlüssel im Header – sicher verschlüsselt in der Verbindung |
| Ziele | jede öffentliche Adresse | nur die freigegebenen Hosts |

Sobald eine Schnittstelle eine Anmeldung braucht, legt eine **Verbindung** an. Zugangsdaten gehören nie in den Workflow – die Header `Authorization` und `Cookie` lassen sich im Baustein deshalb gar nicht setzen.

## Verbindung anlegen

1. [Schnittstellen](/schnittstellen) → **REST-API** → verbinden.
2. **Basis-Adresse**, z. B. `https://api.beispiel.de/v1`.
3. **Anmeldung** wählen:
   - **Bearer-Token** – sendet `Authorization: Bearer <Token>`
   - **Benutzername + Passwort (Basic)**
   - **API-Schlüssel im Header** – Header-Name (Standard `X-API-Key`) und Schlüssel
4. Erweitert: **Erlaubte Hosts**, **Interne Ziele erlauben**, **Zeitlimit** (Standard 30 Sekunden).
5. **Verbindung testen**: LifeLink löst die Adresse auf, prüft den Netzbereich, ruft die Basis-Adresse per GET auf und prüft, dass die Anmeldung nicht abgelehnt wird (kein 401/403).

## Der Baustein „HTTP-Anfrage“

| Feld | Bedeutung |
|---|---|
| **Methode** | GET, POST, PUT, PATCH, DELETE oder HEAD |
| **Adresse oder Pfad** | mit Variablen möglich, z. B. `/fahrzeuge/{{ webhook.body.fahrzeug \| urlencode }}` |
| **URL-Parameter** | Name/Wert-Paare; werden automatisch richtig kodiert |
| **Header** | eigene Header (ohne Zugangsdaten) |
| **Inhalt** | Kein Inhalt, JSON, Formular oder Text |
| **Idempotency-Key mitsenden** | Standard an (siehe unten) |
| **Fehler bei Status ≥ 400** | Standard an. Aus: Der Baustein ist auch bei 404 oder 500 „erfolgreich“, und ihr wertet `{{ name.status }}` selbst mit einer Bedingung aus. |

Das Ergebnis enthält `status`, `body` (JSON, wenn möglich, sonst Text) und ausgewählte Antwort-Header. Jede Anfrage trägt den Header `X-Correlation-Id` des Laufs.

Beim JSON-Inhalt werden eingesetzte Variablen automatisch für JSON maskiert – siehe [Escaping](/hilfe/variablen#escaping-html-und-json). Ist das JSON nach dem Einsetzen ungültig, wird nichts gesendet.

## Erlaubte Hosts

Mit Verbindung darf der Baustein nur den Host der Basis-Adresse aufrufen. Braucht ihr weitere Hosts, tragt sie unter **Erlaubte Hosts** ein; `*.beispiel.de` erlaubt alle Unterdomänen.

Auch **Weiterleitungen** (Redirects) werden geprüft: Höchstens drei Sprünge, jeder wird erneut gegen Freigabe und Netzbereich geprüft. Zugangsdaten werden nie an einen anderen Host weitergeschickt.

## Interne Ziele und SSRF-Schutz

LifeLink läuft oft im selben Netz wie Router, Drucker, Kameras oder die FE2-Server. Damit niemand über einen Workflow Anfragen in dieses interne Netz schicken kann („SSRF“), sind solche Ziele **standardmäßig gesperrt**:

- Loopback (`127.0.0.1`, `localhost`),
- private Netze (`10.x`, `172.16–31.x`, `192.168.x`),
- link-local, Multicast, reservierte und vergleichbare Bereiche – für IPv4 und IPv6.

LifeLink löst den Namen selbst auf, prüft die Adresse und verbindet sich genau mit dieser geprüften Adresse. Ein Trick mit wechselnden DNS-Antworten („DNS-Rebinding“) funktioniert deshalb nicht.

Soll ein Ziel bewusst im internen Netz liegen, schaltet in der Verbindung unter „Erweiterte Optionen“ **Interne Ziele erlauben** ein. Das gilt dann nur für die Hosts dieser Verbindung.

> **Achtung:** Schaltet „Interne Ziele erlauben“ nur ein, wenn ihr genau wisst, welches Gerät angesprochen wird. Ohne Verbindung (Adresse direkt im Baustein) sind interne Ziele immer gesperrt.

Weitere Grenzen: nur `http` und `https`, keine Zugangsdaten in der Adresse (`https://user:pass@…`), Antworten höchstens 1 MB, Zeitlimit höchstens 300 Sekunden.

## Idempotency-Key

Bei POST und PATCH weiß LifeLink nach einem Abbruch nicht, ob das Ziel die Anfrage schon verarbeitet hat. Damit trotzdem sicher wiederholt werden kann, sendet LifeLink bei diesen Methoden einen Header **`Idempotency-Key`**. Er ist für denselben Baustein im selben Vorgang immer gleich – auch bei automatischen Wiederholungen und bei „Ab fehlerhaftem Node wiederholen“.

Viele Schnittstellen erkennen damit doppelte Anfragen und führen sie nur einmal aus. Prüft in der Dokumentation des Zielsystems, ob es diesen Header unterstützt.

| Einstellung | Verhalten |
|---|---|
| Idempotency-Key **an** (Standard) | Baustein gilt als wiederholungssicher und wird bei vorübergehenden Fehlern automatisch wiederholt. |
| Idempotency-Key **aus**, Methode POST/PATCH | Nicht wiederholungssicher: Bei unklarem Ergebnis wird **nicht** automatisch wiederholt; der Lauf geht auf „Prüfen“. |
| GET, HEAD, PUT, DELETE | gelten immer als wiederholungssicher. |

## Beispiel: Erreichbarkeit prüfen

Die Vorlage **Erreichbarkeit prüfen** zeigt das Zusammenspiel:

1. **Zeitplan** alle 15 Minuten.
2. **HTTP-Anfrage** GET auf eure Website; „Fehler bei Status ≥ 400“ aus, 2 Wiederholungen, „Bei Fehler fortsetzen“.
3. **Wenn** `{{ pruefung.status }}` kleiner als `400` – sowohl der normale als auch der Fehler-Ausgang führen hierhin.
4. Bei **Falsch**: **Teams-Nachricht** „Website antwortet nicht – Status: `{{ pruefung.status | default:"keine Antwort" }}`“.
