## Was sind Variablen?

Variablen setzen Daten aus vorherigen Bausteinen in Texte und Felder ein. Sie stehen in doppelten geschweiften Klammern:

```text
Einsatz {{ alamos.stichwort }} in {{ alamos.ort }}
```

wird bei einem Einsatz zu:

```text
Einsatz B3 in Hauptstraße 12, 65835 Musterstadt
```

Der Teil vor dem Punkt ist der **Variablenname** des Bausteins (steht in seinen Einstellungen), danach folgt das **Feld**. Welche Felder ein Baustein liefert, seht ihr im Reiter **Ausgabe** des Bausteins und in der [Bausteine-Referenz](/hilfe/bausteine).

## Aufbau eines Ausdrucks

```text
{{ baustein.feld | filter | filter:"Angabe" }}
```

| Teil | Beispiel | Bedeutung |
|---|---|---|
| Baustein | `alamos` | Variablenname eines vorherigen Bausteins |
| Feld | `.stichwort` | Feld in dessen Ergebnis; tiefer mit weiteren Punkten: `webhook.body.absender.name` |
| Listenelement | `[0]` | Erstes Element einer Liste; `[-1]` ist das letzte |
| Feld mit Sonderzeichen | `["content-type"]` | Feldname in Anführungszeichen, wenn er Bindestriche o. Ä. enthält |
| Filter | `\| upper` | Verändert den Wert vor dem Einsetzen; mehrere Filter nacheinander sind möglich |
| Angabe | `:"unbekannt"` | Manche Filter brauchen eine Angabe: Text in Anführungszeichen, eine Zahl oder eine andere Variable |

Gibt es ein Feld nicht, wird **nichts** eingesetzt (leerer Text) – der Lauf bricht deswegen nicht ab. Mit dem Filter `default` legt ihr einen Ersatz fest.

## Immer verfügbare Variablen

| Variable | Inhalt |
|---|---|
| `{{ trigger.… }}` | Die Daten des Triggers – egal, wie sein Variablenname lautet |
| `{{ run.id }}` | Nummer des Laufs, z. B. 1042 |
| `{{ run.workflow }}` | Name des Workflows |
| `{{ run.started_at }}` | Startzeit des Laufs (UTC) |
| `{{ run.correlation_id }}` | Kennung, über die man den Vorgang in anderen Systemen wiederfindet |
| `{{ now }}` | Aktuelle Zeit (UTC) |

Ein Baustein kann nur Variablen von Bausteinen verwenden, die **vor ihm** im Ablauf liegen. Verweist ein Ausdruck auf einen Baustein danach oder auf einen gelöschten Baustein, meldet LifeLink das beim Veröffentlichen.

## Der Variablen-Picker

Statt Ausdrücke zu tippen, klickt im Feld auf `{ }`:

1. Der Picker zeigt alle vorherigen Bausteine mit ihren Feldern.
2. Neben jedem Feld steht ein **Beispielwert aus dem letzten Lauf** – so seht ihr sofort, was ankommt.
3. Mit `kbd:↑` `kbd:↓` wählen, mit `kbd:Enter` einfügen, Suche über das Eingabefeld oben.

Gab es noch keinen Lauf, macht einen [Testlauf](/hilfe/testen) oder wartet auf ein Testereignis – danach sind Beispielwerte da.

## Filter

Die wichtigsten Filter im Feuerwehralltag:

| Ziel | Ausdruck | Ergebnis |
|---|---|---|
| Ersatzwert | `{{ alamos.ortsteil \| default:"Stadtgebiet" }}` | „Stadtgebiet“, wenn kein Ortsteil kam |
| Ersatz aus anderem Feld | `{{ alamos.ortsteil \| default:alamos.stadt }}` | Ortsteil, sonst Stadt |
| Datum deutsch | `{{ alamos.alarmzeit \| date:"dd.MM.yyyy HH:mm" }}` | 29.10.2026 17:08 |
| Nur Uhrzeit | `{{ alamos.alarmzeit \| date:"HH:mm" }} Uhr` | 17:08 Uhr |
| Liste als Text | `{{ alamos.einheiten \| join:", " }}` | HLF 1, DLK |
| Anzahl | `{{ alamos.einheiten \| length }}` | 2 |
| Kürzen | `{{ webhook.body.text \| truncate:80 }}` | höchstens 80 Zeichen, mit „…“ |
| Großschreiben | `{{ alamos.stichwort \| upper }}` | B3 |
| Ende in einer Stunde | `{{ now \| add_minutes:60 }}` | Zeitpunkt in 60 Minuten (ISO-Format) |
| HTML entfernen | `{{ mail.text \| strip_html }}` | reiner Text |

Datumsangaben werden in der **Zeitzone der Instanz** formatiert (Standard Europe/Berlin), auch wenn sie in UTC ankommen. Die vollständige Liste steht unter [Filter & Vergleiche](/hilfe/filter).

## Werte behalten ihren Typ

Besteht ein Feld **nur aus einem einzigen Ausdruck**, bleibt der Wert so, wie er ist – eine Liste bleibt eine Liste, eine Zahl eine Zahl. Das ist wichtig bei **Felder zuordnen**, in Bedingungen und bei **JSON lesen**:

```text
{{ alamos.einheiten }}            → Liste ["HLF 1", "DLK"]
Einheiten: {{ alamos.einheiten }} → Text 'Einheiten: ["HLF 1","DLK"]'
```

Steht also noch Text daneben, wird alles zu Text. Listen gebt ihr für Menschen lesbar mit `| join:", "` aus.

## Escaping: HTML und JSON

LifeLink schützt automatisch davor, dass eingesetzte Daten ein Dokument „kaputt machen“:

- **HTML-Version einer E-Mail** und **Inhalt eines WordPress-Beitrags**: Eingesetzte Werte werden HTML-maskiert. Kommt in einer Meldung `<b>` vor, steht es als Text da und wird nicht ausgeführt. Euer eigenes HTML in der Vorlage bleibt natürlich HTML.
- **JSON-Inhalt einer HTTP-Anfrage**: Eingesetzte Werte werden für JSON maskiert. Anführungszeichen oder Zeilenumbrüche in einer Meldung zerstören das JSON also nicht. Setzt Textwerte selbst in Anführungszeichen:

```json
{
  "titel": "{{ webhook.body.titel }}",
  "einsatz": "{{ alamos.einsatz_id }}",
  "anzahl_einheiten": {{ alamos.einheiten | length }}
}
```

Ist das JSON nach dem Einsetzen trotzdem ungültig, bricht der Baustein mit einer verständlichen Meldung ab, statt kaputte Daten zu verschicken.

- **Adressen (URLs)**: In URL-Parametern (eigenes Feld im Baustein HTTP-Anfrage) kodiert LifeLink automatisch. Baut ihr Werte direkt in den Pfad ein, nutzt `| urlencode`: `/suche?q={{ alamos.ort | urlencode }}`.

## Warum Empfänger keine Variablen sein dürfen

E-Mail-Empfänger, Teams-Kanäle und MQTT-Topics stehen **fest im Workflow**. Variablen sind dort nicht erlaubt – LifeLink lehnt das beim Veröffentlichen ab.

Der Grund: Eingehende Daten können manipuliert sein. Stünde der Empfänger in einer Meldung, könnte jemand über einen gefälschten Webhook E-Mails mit internen Einsatzdaten an beliebige Adressen umleiten. Mit festen Empfängern ist klar und vor dem Veröffentlichen sichtbar, wohin Daten gehen.

Braucht ihr verschiedene Empfänger je nach Fall, nutzt einen [Switch](/hilfe/bedingungen#switch) mit je einem eigenen „E-Mail senden“-Baustein pro Empfängerkreis.

## Häufige Fehler

| Meldung | Ursache | Lösung |
|---|---|---|
| Nicht geschlossener Ausdruck: „}}“ fehlt. | Klammer vergessen | `}}` ergänzen |
| Unbekannter Filter „…“ | Tippfehler im Filternamen | Name prüfen, Liste unter [Filter & Vergleiche](/hilfe/filter) |
| Erwartet: Zahl oder "Text" | Angabe fehlt oder ist unvollständig, z. B. `truncate:` | Angabe ergänzen: `truncate:80` |
| Variable „unbekannt“ verweist auf keinen vorherigen Baustein | Text ohne Anführungszeichen, z. B. `default:unbekannt` – LifeLink liest das als Variable | Text in Anführungszeichen: `default:"unbekannt"` |
| Variable „x.y“ verweist auf keinen vorherigen Baustein | Variablenname falsch oder Baustein liegt dahinter | Variablen-Picker verwenden |
