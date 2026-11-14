Die häufigsten Probleme und wie ihr sie löst. Der erste Blick geht fast immer in den [Ausführungsverlauf](/ausfuehrungen) und den [Systemstatus](/system).

## Workflow startet nicht

Prüft der Reihe nach:

1. **Ist der Workflow aktiv?** In [Workflows](/workflows) muss „Aktiv“ stehen. Ein Entwurf allein startet nie.
2. **Wartet die neueste Version auf Freigabe?** Dann läuft noch die alte Version – oder, beim ersten Mal, gar keine. Eine Person mit dem Recht „Freigeben“ muss zustimmen.
3. **Kommt das Ereignis an?**
   - Webhook/Alamos: Unter [Webhooks](/webhooks) steht der letzte Empfang und der Zähler. Steht dort nichts, kommt die Anfrage nicht bei LifeLink an (Adresse, Firewall, Proxy prüfen).
   - Der Absender bekommt eine Antwort – `401`, `404` oder `409` verraten den Grund, siehe [Antwortcodes](/hilfe/webhooks#antwortcodes).
4. **Filtert der Trigger aus?** Beim Alamos-Einsatz sortiert der Stichwort-Filter unpassende Einsätze schon beim Empfang aus (Antwort „Stichwort nicht im Filter“). Auch das Duplikatfenster kann greifen.
5. **Läuft der Worker?** Im [Systemstatus](/system) muss „Worker“ grün sein. Ohne Worker werden Läufe angenommen, aber nicht ausgeführt, und Zeitpläne starten nicht.
6. **Meldet der Trigger einen Fehler?** Im Systemstatus unter „Trigger & Zeitpläne“ – z. B. Postfach nicht erreichbar oder iCal-Export liefert keinen Kalender.

> **Tipp:** Startet der Lauf, endet aber sofort „erfolgreich“, hat meist ein **Filter** oder eine **Bedingung** den Lauf beendet. Im Ausführungsverlauf steht dann „Gefiltert – Lauf endet hier“ bzw. die folgenden Bausteine sind „Nicht ausgeführt“.

## Webhook antwortet mit 401

Die Antwort nennt den Grund:

| Meldung | Lösung |
|---|---|
| Signatur-Header fehlen | `X-LifeLink-Timestamp` und `X-LifeLink-Signature` mitsenden – oder im Trigger „Geheimer Schlüssel im Header“ wählen. |
| Zeitstempel außerhalb des erlaubten Fensters | Uhr des Absenders stellen (NTP). Zeitstempel in **Sekunden**, nicht Millisekunden. |
| Signatur ungültig | Geheimnis vollständig (mit `whsec_`)? Wird genau der signierte Body gesendet? Prüft eure Umsetzung mit dem [Prüfbeispiel](/hilfe/webhooks#hmac-signatur-genau-erklaert). |
| Diese Anfrage wurde bereits verarbeitet | Dieselbe Signatur wurde zweimal gesendet. Für jede Wiederholung neu signieren. |
| Zugriffsschlüssel fehlt oder ist falsch | Header `X-LifeLink-Token` prüfen. Nach einer Rotation: neues Geheimnis eintragen. |

## Verbindung ist rot

Eine Verbindung wird rot, wenn ihr Test fehlschlägt oder ein Lauf mit Anmelde-, Rechte- oder Konfigurationsfehler an ihr scheitert.

1. Verbindung unter [Verbindungen](/verbindungen) öffnen und die **Statusmeldung** lesen.
2. **Verbindung testen** – die Schritte zeigen, wo es hakt (Server erreichbar? Anmeldung?).
3. Typische Lösungen:
   - „Anmeldung abgelehnt“ → Zugangsdaten **ersetzen** (Passwort geändert? Clientschlüssel abgelaufen?).
   - „zeigt auf eine interne Adresse und ist gesperrt“ → Ziel liegt im internen Netz; in der Verbindung **Interne Ziele erlauben** einschalten, wenn das gewollt ist.
   - „TLS-Zertifikat des Zielsystems ist ungültig“ → Zertifikat am Zielsystem erneuern.
   - „nicht erreichbar“ → Server aus, Firewall, DNS-Name falsch.
4. Nach einem erfolgreichen Test oder Lauf wird die Verbindung wieder grün.

## Banner erscheint nicht auf der Website

1. In [WordPress](/wordpress) das Banner öffnen: Status **Aktiv**? „Geplant“ heißt, die Startzeit liegt in der Zukunft; „Entwurf“ heißt, es wartet auf Freigabe.
2. Abgleich-Status „Fehler“? Dann war die Website nicht erreichbar. LifeLink versucht es automatisch erneut; Verbindung testen.
3. **Zielseite** richtig? „Startseite“ zeigt das Banner nur dort.
4. **Ausgabe im Theme**: Unterstützt das Theme die automatische Ausgabe nicht, Block „LifeLink-Hinweise“ oder Shortcode `[lifelink_banners]` einsetzen.
5. **Cache**: Ein Seiten-Cache oder CDN liefert noch die alte Seite. Cache leeren; bei nicht unterstützten Cache-Plugins den Hook `lifelink_banners_changed` nutzen.

Mehr im Kapitel [WordPress](/hilfe/wordpress#fehlerbehebung).

## E-Mail kommt nicht an

1. Lauf öffnen: Ist „E-Mail senden“ **Erfolgreich** und steht der Empfänger unter `accepted`? Dann hat der Mailserver sie angenommen – Spam-Ordner beim Empfänger prüfen.
2. Steht der Lauf auf **Prüfen**? Dann ist unklar, ob sie raus ist – siehe unten.
3. Fehler „Der Mailserver hat die Nachricht abgelehnt“ → Absenderadresse passt oft nicht zum Konto.

Mehr im Kapitel [E-Mail](/hilfe/e-mail#e-mail-kommt-nicht-an).

## Lauf steht auf „Prüfen“

LifeLink hat eine nicht wiederholungssichere Aktion (E-Mail, Teams-Nachricht, HTTP-POST ohne Idempotency-Key) gestartet, weiß aber nicht, ob sie angekommen ist.

1. Im Zielsystem nachsehen.
2. Angekommen → nichts tun.
3. Nicht angekommen → **Ab fehlerhaftem Node wiederholen** und die Warnung bestätigen.

Siehe [Status „Prüfen“](/hilfe/ausfuehrungen#status-pruefen).

## Lauf ist fehlgeschlagen

Öffnet den Lauf und dort den Reiter **Fehler**. Die Fehlerklasse sagt, was zu tun ist – siehe [Fehlerklassen](/hilfe/ausfuehrungen#fehlerklassen-und-was-zu-tun-ist). Nach der Korrektur:

- Zugangsdaten oder Zielsystem waren schuld → **Ab fehlerhaftem Node wiederholen**.
- Der Workflow war falsch → korrigieren, veröffentlichen, dann **Erneut ausführen** (läuft mit der Version des ursprünglichen Laufs!) – oder auf das nächste Ereignis warten.

> **Achtung:** „Erneut ausführen“ verwendet die Workflow-Version des alten Laufs. Ein im Workflow behobener Fehler ist darin noch enthalten. Für echte Einzelfälle ist es oft einfacher, die Aktion von Hand nachzuholen.

## Update wurde zurückgerollt

Die neue Version ist nicht innerhalb von 2 Minuten gestartet; LifeLink läuft mit der vorigen Version weiter.

1. Auf [Updates](/updates) den Hinweis im Verlauf lesen.
2. Auf dem Server das Container-Protokoll ansehen: `docker compose logs --tail 200 lifelink`.
3. Häufige Ursachen: Server ohne Internet (neue Abhängigkeiten konnten nicht geladen werden), zu wenig Speicherplatz, Image zu alt.
4. Fehler mit Protokollauszug an den Herausgeber melden. Bis dahin läuft alles mit der vorigen Version.

Siehe [Updates](/hilfe/updates#automatisches-zurueckschalten).

## Konto gesperrt

„Konto vorübergehend gesperrt (zu viele Fehlversuche)“ – nach 5 falschen Passwörtern für 15 Minuten.

- Abwarten, dann mit dem richtigen Passwort anmelden.
- Passwort vergessen? Ein Admin erzeugt unter [Benutzer und Berechtigungen](/benutzer) einen Link zum Neusetzen; der hebt die Sperre auf.
- Kommt kein Admin mehr herein: Notfallbefehl `password-link` auf dem Server, siehe [Anmeldung](/hilfe/anmeldung#notfall-kein-admin-kommt-mehr-herein).

## „Der Entwurf wurde inzwischen von … geändert“

Jemand anderes hat gleichzeitig am selben Workflow gearbeitet. Ladet die Seite neu; eure letzte, nicht gespeicherte Änderung müsst ihr danach erneut machen. Sprecht euch ab, wer gerade am Workflow arbeitet.

## Veröffentlichen geht nicht

Die Prüfung nennt jeden Fehler einzeln und markiert den Baustein. Häufig:

| Meldung | Lösung |
|---|---|
| „… ist nicht mit dem Trigger verbunden.“ | Linie zum Baustein ziehen oder Baustein löschen/deaktivieren. |
| „…: Verbindung auswählen.“ | Im Baustein eine Verbindung wählen. |
| „Variable „…“ verweist auf keinen vorherigen Baustein.“ | Variablenname prüfen; der Baustein muss vorher im Ablauf liegen. |
| „Variablen sind bei Empfängern nicht erlaubt“ | Feste Adresse eintragen. |
| „Keine Änderungen gegenüber der aktiven Version.“ | Es gibt nichts Neues zu veröffentlichen. |
| „Der Workflow enthält eine Schleife.“ | Linie entfernen, die zurück zu einem früheren Baustein führt. |

## Hilfe holen

Kommt ihr nicht weiter, sammelt vor einer Rückfrage:

- Laufnummer (z. B. #1042) bzw. Korrelations-ID,
- im Fehler-Reiter **Details kopieren**,
- Uhrzeit und was ihr zuletzt geändert habt.

Geheimnisse sind in diesen Daten bereits maskiert.
