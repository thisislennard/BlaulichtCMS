Workflows lassen sich mit Hilfe einer KI (eines Sprachmodells, gleich welchen Anbieters) als Datei entwerfen und dann wie jede andere Exportdatei [importieren](/hilfe/workflows#export-und-import). Die KI bekommt nur die **Formatbeschreibung**, den **Katalog** der eigenen Installation und den **Wunsch** in eigenen Worten – keine Schnittstelle zu BlaulichtCMS, keine Zugangsdaten, keine Einsatz- oder Personendaten. Was die KI liefert, wird beim Import geprüft und startet immer als **inaktiver Entwurf**.

> **Datenschutz:** Nie Einsatzdaten (Alarmtexte, Adressen, Lagemeldungen), Personendaten (Namen, Telefonnummern, E-Mail-Adressen, Fotos) oder Zugangsdaten in eine KI eingeben – auch nicht „als Beispiel“. Für einen Workflow reichen Formatbeschreibung, Katalog und der Wunsch. Ob und welche KI genutzt werden darf, entscheidet die eigene Organisation.

## So geht es

Unter [Workflows](/workflows) → **Mit KI erstellen** (Recht *Workflows ansehen*; der Import am Ende braucht *Workflows verwalten*):

1. **JSON-Schema herunterladen** – die Formatbeschreibung der Workflow-Datei (`blaulichtcms-automations-1.schema.json`). Es ist für jede Installation gleich und auch direkt unter `/schema/blaulichtcms-automations-1.schema.json` abrufbar.
2. **Katalog exportieren** – `workflow-katalog.json` mit dem, was es in dieser Installation gibt (siehe [Was der Katalog enthält](#was-der-katalog-enthaelt)).
3. **Anfrage kopieren** – die [Vorlage](#vorlage-fuer-die-anfrage) steht im Dialog. „…“ durch den eigenen Wunsch ersetzen, z. B. „bei einem FE2-Alarm mit Stichwort-Kategorie Brand einen Beitragsentwurf anlegen und die Redaktion benachrichtigen“.
4. In der KI die beiden Dateien anhängen (oder ihren Inhalt einfügen) und die Anfrage senden.
5. **Ergebnis importieren** (oder **Importieren** in der Liste): die Antwort als Datei wählen oder **Als Text einfügen** und **Prüfen**. BlaulichtCMS prüft die Datei, zeigt eine Vorschau und schlägt je Auslöser und Aktion den gleichnamigen vorhandenen Baustein vor.
6. Den Entwurf im Editor ansehen, Fehler beheben (sie stehen am Knoten), **testen** und erst dann aktivieren.

Meldet der Import Fehler, nennt jede Meldung den Ort in der Datei (z. B. `automations[0].graph.nodes[2].data.rules[0].op`) und was erwartet wurde. **Meldungen kopieren** und der KI zur Korrektur geben – auch dabei keine Einsatz- oder Personendaten ergänzen.

## Was der Katalog enthält

Der Katalog ist eine JSON-Datei nur mit Angaben zum Bau von Workflows:

- vorhandene **Auslöser** und **Aktionen** mit Art und Name; beim manuellen Start die eigenen Felder (Feldname und Bezeichnung), bei Aktionen die Felder, die ihre Texte verwenden (`usesFields`),
- die **Felder je Auslöser** samt Systemfeldern, die Felder, die Schritte und Aktionen liefern, die **Vergleiche** für Bedingungen, Knotenarten mit Aktionen und die Grenzen,
- Namen und Textfelder der **befüllbaren Bildvorlagen**, Namen der **Kalender-Kategorien**,
- das aktive **Stichwortverzeichnis** (Stichwort, Bezeichnung, Kategorie).

Nicht enthalten sind Zugangsdaten, Kennungen und Einstellungen von Verbindungen, Auslösern und Aktionen, Einsatz- und Warndaten, Läufe, Medien, Konten, Personen und Kontakte (auch keine Empfänger von E-Mails oder Pressemitteilungen). Jeder Export steht in den [Aktivitäten](/aktivitaeten).

## Vorlage für die Anfrage

Die Vorlage ist für jede KI gleich. Im Dialog **Mit KI erstellen** lässt sie sich direkt ergänzen und kopieren.

<!-- ki-anfrage:start -->

```text
Ich möchte in BlaulichtCMS einen Workflow anlegen. Im Anhang sind zwei Dateien:
1. die Formatbeschreibung als JSON-Schema (blaulichtcms-automations-1.schema.json),
2. der Katalog meiner Installation (workflow-katalog.json) mit den vorhandenen Auslösern und Aktionen, den Feldern je Auslöser, den Vergleichen für Bedingungen, den Bildvorlagen und dem Stichwortverzeichnis.

Erstelle eine Workflow-Datei im Format „blaulichtcms.automations“ (schemaVersion 1), die genau dem Schema entspricht:
- Verwende nur Knotenarten, Felder, Vergleiche, Auslöser und Aktionen, Bildvorlagen und Stichwörter aus dem Katalog. Erfinde nichts dazu.
- Trage Auslöser und Aktionen unter „references“ mit Art („kind“) und genauem Namen aus dem Katalog ein; die Knoten verweisen darauf mit „inputRef“ (in1, in2 …) bzw. „outputRef“ (out1, out2 …).
- Schreibe Platzhalter als {{feldname}} und verwende nur Felder, die an dieser Stelle vorhanden sind. Braucht eine Aktion Felder („usesFields“ im Katalog), die der Auslöser nicht liefert, lege sie vorher mit „Felder setzen“ an.
- Verbinde die Knoten über „edges“ mit dem passenden Zweig („sourceHandle“, z. B. „true“ bei einer zutreffenden Bedingung).
- Gib nur das JSON aus, ohne Erklärungen davor oder danach.

Der Workflow soll: …
```

<!-- ki-anfrage:ende -->

## Grenzen

- Die KI kann nur **vorhandene** Auslöser und Aktionen verwenden: Texte, Empfänger und Gestaltung einer Aktion (z. B. Banner-Stil oder Beitragsvorlage) stehen in der Aktion selbst und gehören nicht in die Datei. Fehlt ein passender Ein- oder Aktion, bleibt der Platz nach dem Import offen und lässt sich im Editor wählen oder neu anlegen.
- Direktversand, Aktivieren und Freigaben bleiben bei Menschen; eine Datei kann nichts davon einschalten.
- Ob ein Feld an einer Stelle vorhanden ist, ob alle Knoten angeschlossen sind und ob die Zweige der Knoten passen, prüft der Editor nach dem Import – die Fehler stehen am Knoten.
- KI-Ergebnisse können plausibel aussehen und trotzdem falsch sein. Der Testlauf zeigt Schritt für Schritt, was passieren würde.

## Formatbeschreibung

Die Datei hat das Format `blaulichtcms.automations` (Formatversion 1) – dasselbe wie beim [Export](/hilfe/workflows#export-und-import). Das [JSON-Schema](/schema/blaulichtcms-automations-1.schema.json) beschreibt es maschinenlesbar; die folgende Übersicht ist daraus und aus dem Katalog erzeugt.

<!-- ki-format:start -->

### Aufbau der Datei

| Schlüssel | Pflicht | Inhalt |
| --- | --- | --- |
| `format` | ja | immer `"blaulichtcms.automations"` |
| `schemaVersion` | ja | `1` |
| `references` | nein | `inputs` und `outputs`: je Eintrag `ref` (`in1`, `in2` … bzw. `out1` …), `kind` (Art) und `name` (Name aus dem Katalog) |
| `automations` | ja | 1–50 Workflows: `name` (2–120 Zeichen), `description` (optional, bis 500) und `graph` mit `nodes` (bis 60) und `edges` (bis 150) |
| `appVersion`, `exportedAt` | nein | nur zur Information |

Ein **Knoten** hat `id` (1–40 Zeichen aus Buchstaben, Ziffern, `_` und `-`; eindeutig im Workflow), `type`, `data` und optional `position` (`x`, `y`). Eine **Verbindung** hat `id`, `source`, `sourceHandle` (Zweig des Quellknotens) und `target`. Andere Schlüssel sind nicht vorgesehen.

### Knotenarten

| `type` | Baustein | Angaben in `data` | Zweige (`sourceHandle`) |
| --- | --- | --- | --- |
| `input` | **Auslöser** – Auslöser aus der Liste der Auslöser. | optional: `inputRef`, `label`. inputRef: Bezug aus references.inputs (z. B. „in1“). Ohne inputRef bleibt der Auslöser offen und wird nach dem Import gewählt. | `out` (weiter) |
| `output` | **Aktion** – Aktion aus der Liste der Aktionen. | optional: `outputRef`, `label`. outputRef: Bezug aus references.outputs (z. B. „out1“). Texte, Empfänger und Gestaltung stehen in der Aktion selbst, nicht in der Datei. | `out` (danach) |
| `condition` | **Bedingung** – Prüft Felder und verzweigt nach „trifft zu“ und „trifft nicht zu“. | Pflicht: `combinator`, `rules` · optional: `label`. Regeln „Feld – Vergleich – Wert“ (field, op, value), verknüpft mit combinator „and“ oder „or“; höchstens 20 Regeln und eine Ebene Untergruppen ({ combinator, rules }). | `true` (trifft zu), `false` (trifft nicht zu) |
| `switch` | **Verzweigung** – Wählt den Weg nach dem Wert eines Feldes. | Pflicht: `field`, `cases` · optional: `label`. field: Feld, nach dessen Wert verzweigt wird; cases: 1–12 Fälle { id, value }. | `case:<id>` (je Fall, id aus cases), `default` (sonst) |
| `template` | **Felder setzen** – Legt neue Felder aus Textvorlagen mit {{platzhaltern}} an. | Pflicht: `fields` · optional: `label`. fields: 1–20 Einträge { key, template } – legt das Feld key mit dem Text aus template an (Platzhalter {{feld}} erlaubt). | `out` (weiter) |
| `delay` | **Warten** – Wartet eine feste Zeit (höchstens 24 Stunden). | Pflicht: `minutes` · optional: `label`. minutes: 1–1440. | `out` (weiter) |
| `dedup` | **Einmal je Vorgang** – Lässt je Schlüssel nur den ersten Lauf im Zeitfenster durch. | Pflicht: `fields`, `windowMinutes` · optional: `label`. fields: 1–5 Feldnamen als Schlüssel; windowMinutes: Zeitfenster 1–10080. | `out` (weiter) |
| `approval` | **Freigabe anfordern** – Hält den Lauf an, bis eine Person freigibt oder ablehnt. | Pflicht: `timeoutHours` · optional: `title`, `summary`, `label`. title und summary (mit Platzhaltern); timeoutHours: 1–72 – ohne Entscheidung gilt die Anfrage danach als abgelehnt. | `approved` (freigegeben), `rejected` (abgelehnt) |
| `merge` | **Zusammenführen** – Führt Wege wieder zusammen. | optional: `label`. Keine Einstellungen. | `out` (weiter) |
| `image` | **Bild aus Vorlage erzeugen** – Füllt eine befüllbare Bildvorlage mit Feldern und legt das Bild in den Medien ab; Beitrags-Aktionen danach übernehmen es (auch für Social und Story). | optional: `templateId`, `templateName`, `texts`, `images`, `altText`, `collectionId`, `label`. templateName: Name einer Bildvorlage aus dem Katalog; texts: Kennung des Textfelds der Vorlage → Text mit Platzhaltern; altText: Alternativtext. templateId, images und collectionId gehören zur Installation und werden in Dateien nicht verwendet. | `out` (weiter) |

### Auslöser und ihre Felder

Ein Auslöser liefert die Felder seiner Art. Zusätzlich steht in jedem Lauf zur Verfügung:

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `automation` | Name des Workflows | text | Einsatzentwurf aus FE2 |
| `lauf` | Lauf-Kennung (kurz) | text | 3f2a9c1d |
| `jetzt` | Zeitpunkt des Laufs | datetime | 2026-11-16T07:00:00.000Z |

**FE2-Alarm** (`fe2`) – Einsatzmeldung aus einer aktiven FE2-Verbindung (nur die Felder der Allowlist). Vorgänge: `neu` (Neuer Einsatz), `aktualisierung` (Aktualisierung), `beendet` (Einsatz beendet).

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `vorgang` | Vorgang | choice: `neu`, `aktualisierung`, `beendet` | neu |
| `stichwort` | Stichwort | text | B2 |
| `stichwort_text` | Stichwort (Klartext) | text | Brand Wohngebäude |
| `stichwort_kategorie` | Stichwort-Kategorie (Stichwortverzeichnis) | text | Brand |
| `einsatzart` | Einsatzart | text | Brand |
| `ort` | Gemeinde/Ort | text | Musterstadt |
| `ortsteil` | Ortsteil | text | Nord |
| `alarmzeit` | Alarmzeit | datetime | 2026-11-16T06:12:00.000Z |
| `einheiten` | Eingesetzte Einheiten | text | HLF 1, DLK |
| `status` | Status (offen/beendet) | text | offen |
| `quelle` | Quelle | text | FE2 |
| `verbindung` | Name der Verbindung | text | FE2 Leitstelle |
| `entwurf_link` | Link zum automatischen Einsatzentwurf | url | /beitraege/… |

**Feuersoftware-Einsatz** (`feuersoftware`) – Einsatz aus einer aktiven Verbindung zu Feuersoftware Connect (gleiche Felder wie FE2). Vorgänge: `neu` (Neuer Einsatz), `aktualisierung` (Aktualisierung), `beendet` (Einsatz beendet).

Felder wie bei FE2-Alarm (`fe2`).

**Amtliche Warnung** (`warnfeed`) – Neue, aktualisierte oder aufgehobene Warnung aus einer aktiven Warnfeed-Verbindung (NINA/CAP). Vorgänge: `neu` (Neue Warnung), `aktualisierung` (Aktualisierung), `entwarnung` (Entwarnung (Aufhebung)).

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `vorgang` | Vorgang | choice: `neu`, `aktualisierung`, `entwarnung` | neu |
| `ereignis` | Ereignis | text | Sturmböen |
| `ueberschrift` | Überschrift | text | Amtliche Unwetterwarnung vor Orkanböen |
| `beschreibung` | Beschreibung (gekürzt) | text | Es treten Orkanböen mit Geschwindigkeiten um 120 km/h auf. |
| `verhalten` | Verhaltenshinweise (gekürzt) | text | Gebäude nicht verlassen. |
| `stufe` | Stufe (1 gering … 4 extrem) | number | 3 |
| `schwere` | Schwere (CAP) | choice: `Minor`, `Moderate`, `Severe`, `Extreme`, `Unknown` | Severe |
| `dringlichkeit` | Dringlichkeit (CAP) | text | Immediate |
| `gebiete` | Gebiete | text | Kreis Musterland |
| `gueltig_bis` | Gültig bis | datetime | 2026-11-16T18:00:00.000Z |
| `quelle` | Herausgebende Stelle | text | Deutscher Wetterdienst |
| `link` | Link zur Originalquelle | url | https://warnung.bund.de/ |
| `im_gebiet` | Im eigenen Gebiet | choice: `ja`, `nein` | ja |

**RSS-Eintrag** (`rss`) – Neuer Eintrag einer Quelle unter Redaktion → Quellen.

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `titel` | Titel | text | Pressemitteilung der Stadt |
| `link` | Link | url | https://example.org/meldung |
| `zusammenfassung` | Zusammenfassung | text | Kurzer Anrisstext … |
| `veroeffentlicht` | Veröffentlicht | datetime | 2026-11-16T05:30:00.000Z |
| `quelle` | Name der Quelle | text | Stadt Musterstadt |

**Neue Uploads** (`upload`) – Neue geprüfte Dateien über einen Upload-Link einer Sammlung – gebündelt je Zeitfenster.

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `sammlung` | Sammlung | text | Hochwasser Nord |
| `sammlung_link` | Link zur Sammlung | url | /medien/… |
| `link_bezeichnung` | Bezeichnung des Upload-Links | text | Aushang Rathaus |
| `anzahl` | Neue Dateien im Zeitfenster | number | 3 |

**Zeitplan** (`schedule`) – Täglich zu einer Uhrzeit (wahlweise nur an bestimmten Wochentagen) oder alle N Minuten.

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `zeitpunkt` | Geplanter Zeitpunkt | datetime | 2026-11-16T06:00:00.000Z |
| `offene_beitraege` | Beiträge zur Freigabe | number | 2 |
| `offene_beitraege_liste` | Titel der Beiträge zur Freigabe | text | – Brand in Nord – Übung am Samstag |
| `offene_banner` | Banner zur Freigabe | number | 1 |
| `offene_warnentwuerfe` | Warnentwürfe zur Freigabe | number | 0 |
| `offene_automationsfreigaben` | Offene Freigaben aus Workflows | number | 0 |

**Neue Presseanfrage** (`press`) – Eine Presseanfrage wurde von Hand erfasst oder ist über das Presse-Postfach eingegangen (ohne Kontaktdaten der anfragenden Person).

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `nummer` | Vorgangsnummer | text | P-2026-0007 |
| `thema` | Thema | text | Brand in der Lagerhalle |
| `medium` | Medium/Redaktion | text | Musterstädter Zeitung |
| `eingangsweg` | Eingangsweg | choice: `Telefon`, `E-Mail`, `Presse-Postfach`, `Persönlich`, `Sonstiges` | Telefon |
| `frist` | Frist | datetime | 2026-11-16T15:00:00.000Z |
| `zustaendig` | Zuständige Person | text | Alex Beispiel |
| `anfrage_link` | Link zur Anfrage | url | /presse/… |

**Kalendereintrag** (`calendar`) – Ein Termin aus dem Kalender (eigene und eingelesene, auch Serien) beginnt, endet oder steht bevor – gefiltert nach Kategorie, Schlagwort, Quelle oder Text.

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `titel` | Titel des Termins | text | Übungsdienst Atemschutz |
| `beschreibung` | Beschreibung | text | Übung am Gerätehaus mit Rauchentwicklung. |
| `beginn` | Beginn | datetime | 2026-11-21T09:00:00.000Z |
| `ende` | Ende | datetime | 2026-11-21T12:00:00.000Z |
| `ganztaegig` | Ganztägig | choice: `ja`, `nein` | nein |
| `ort` | Ort | text | Gerätehaus Nord |
| `kategorie` | Kategorie | text | Übung |
| `schlagwoerter` | Schlagwörter | text | Atemschutz, Ausbildung |
| `quelle` | Quelle (eigene Termine oder Name des externen Kalenders) | text | Eigene Termine |
| `zeitpunkt` | Auslöser | choice: `beginn`, `ende`, `vorher` | beginn |
| `gueltig_bis` | Gültig bis (Ende des Termins) | datetime | 2026-11-21T12:00:00.000Z |
| `termin_link` | Link zum Kalender | url | /kalender |

**Manueller Start** (`manual`) – Start per Knopf im Workflow – mit eigenen Feldern, die beim Start ausgefüllt werden.

| Feld | Bedeutung | Art | Beispiel |
| --- | --- | --- | --- |
| `gestartet_von` | Gestartet von | text | Alex Beispiel |

Dazu kommen die eigenen Felder des jeweiligen Auslösers (im Katalog unter `inputs` → `fields`).

### Aktionen und Felder danach

Eine Aktion arbeitet mit ihren eigenen, in BlaulichtCMS eingerichteten Texten; im Katalog steht je Aktion, welche Felder sie verwendet (`usesFields`). Danach stehen die gelieferten Felder bereit (z. B. für eine Benachrichtigung mit Link).

| `kind` | Aktion | Liefert danach |
| --- | --- | --- |
| `banner` | **Banner** – Banner-Entwurf im eingestellten Stil (zur Freigabe eingereicht) – je Website ein Banner. | `banner_link` (Link zu den Bannern) |
| `post` | **Beitrag** – Beitragsentwurf aus einer Vorlage mit Texten je Netzwerk und vorausgewählten sozialen Netzwerken (auch als Story oder zum Teilen von Hand), optional zur Freigabe eingereicht. | `beitrag_link` (Link zum Beitrag), `beitrag_titel` (Titel des Beitrags) |
| `mail` | **E-Mail** – E-Mail über den eingerichteten Mailserver an Rollen oder hinterlegte Zuständigkeiten. | – |
| `notify` | **App-Benachrichtigung** – Benachrichtigung in BlaulichtCMS an Rollen oder einzelne Personen. | – |
| `warning_draft` | **Warnentwurf vorbereiten** – Warnentwurf mit vorausgefüllten Feldern – Warnstufe, Freigabe und Versand bleiben bei Menschen. | `warnentwurf_link` (Link zum Warnentwurf), `warnentwurf_nr` (Vorgangsnummer) |
| `incident_entry` | **Einsatz in Einsatzliste** – Eintrag für die Einsatzliste der Website vorschlagen (Stichwort, Ortsteil, Alarmzeit) – veröffentlicht wird erst nach Freigabe. Ein Einsatz entsteht nur einmal, auch bei Aktualisierungen. | `einsatzliste_link` (Link zur Einsatzliste) |
| `press_release` | **Pressemitteilung an Verteiler** – Pressemitteilung für Verteilerlisten des Presseverteilers – standardmäßig als Entwurf (Versand von Hand); sofort senden nur mit Direktversand. Jede Mail einzeln adressiert, mit Abmeldelink. | `pressemitteilung_link` (Link zur Pressemitteilung) |

**Bild aus Vorlage erzeugen** liefert `bild_id` (Kennung des erzeugten Bildes), `bild_link` (Link zum Bild in den Medien), `bilder` (Alle erzeugten Bilder dieses Laufs); eine Beitrags-Aktion danach übernimmt die Bilder. **Felder setzen** liefert die dort angelegten Felder.

### Bedingungen

Eine Regel ist `{ "field": "stichwort", "op": "starts_with", "value": "B" }`. `combinator` `"and"` verlangt alle Regeln, `"or"` mindestens eine; eine Untergruppe `{ "combinator": "or", "rules": [ … ] }` darf eine Ebene tief stehen. Vergleiche ignorieren Groß- und Kleinschreibung. Aktionen der Bedingung: `true` (trifft zu) und `false` (trifft nicht zu).

| `op` | Vergleich |
| --- | --- |
| `eq` | ist gleich |
| `neq` | ist nicht gleich |
| `contains` | enthält |
| `not_contains` | enthält nicht |
| `starts_with` | beginnt mit |
| `in` | ist eines von (Liste) – Werte mit Komma getrennt |
| `gte` | ist mindestens (Zahl) |
| `lte` | ist höchstens (Zahl) |
| `before` | liegt vor (Zeitpunkt) – für Datumsfelder; `value`: `jetzt`, `heute`, `morgen`, `jetzt + 2 h`, `jetzt - 7 Tage`, `24.12.2026 18:00` oder `2026-12-24` |
| `after` | liegt nach (Zeitpunkt) – für Datumsfelder; `value`: `jetzt`, `heute`, `morgen`, `jetzt + 2 h`, `jetzt - 7 Tage`, `24.12.2026 18:00` oder `2026-12-24` |
| `exists` | ist ausgefüllt – ohne `value` |
| `not_exists` | ist leer – ohne `value` |

### Platzhalter

In Texten steht ein Feld als `{{feldname}}` (Kleinbuchstaben, Ziffern und `_`, beginnend mit einem Buchstaben, höchstens 40 Zeichen). Es gibt keine Formeln oder Ausdrücke. Ein Platzhalter muss an seiner Stelle vorhanden sein: Felder des Auslösers, Systemfelder und Felder, die vorherige Schritte liefern. Nach einem Zusammenführen bleiben nur Felder, die auf allen eingehenden Wegen vorhanden sind. Zeitpunkte erscheinen lesbar in der Zeitzone der Installation.

### Grenzen

| Grenze | Wert |
| --- | --- |
| Workflows je Datei | 50 |
| Knoten je Workflow | 60 |
| Verbindungen je Workflow | 150 |
| Regeln je Bedingung | 20 |
| Fälle je Verzweigung | 12 |
| Warten | 1–1440 Minuten |
| Zeitfenster „Einmal je Vorgang“ | 1–10080 Minuten |
| Frist „Freigabe anfordern“ | 1–72 Stunden |
| Länge einer Textvorlage | 5000 Zeichen |
| Dateigröße | 1 MB |

### Beispiel

Die Vorlage „Alarm mit Stichwort-Kategorie Brand → Beitragsentwurf“ als Datei:

```json
{
  "format": "blaulichtcms.automations",
  "schemaVersion": 1,
  "references": {
    "inputs": [
      {
        "ref": "in1",
        "kind": "fe2",
        "name": "Alarm"
      }
    ],
    "outputs": [
      {
        "ref": "out1",
        "kind": "post",
        "name": "Beitrag „Einsatz“"
      }
    ]
  },
  "automations": [
    {
      "name": "Alarm mit Stichwort-Kategorie Brand → Beitragsentwurf",
      "description": "Nur bei Bränden (Kategorie aus dem Stichwortverzeichnis) einen Beitragsentwurf mit Stichwort und Ort anlegen.",
      "graph": {
        "nodes": [
          {
            "id": "in1",
            "type": "input",
            "position": {
              "x": 0,
              "y": 0
            },
            "data": {
              "inputRef": "in1"
            }
          },
          {
            "id": "if1",
            "type": "condition",
            "position": {
              "x": 320,
              "y": 0
            },
            "data": {
              "combinator": "and",
              "rules": [
                {
                  "field": "stichwort_kategorie",
                  "op": "eq",
                  "value": "Brand"
                }
              ]
            }
          },
          {
            "id": "out1",
            "type": "output",
            "position": {
              "x": 640,
              "y": 0
            },
            "data": {
              "outputRef": "out1"
            }
          }
        ],
        "edges": [
          {
            "id": "e_in1_if1",
            "source": "in1",
            "sourceHandle": "out",
            "target": "if1"
          },
          {
            "id": "e_if1_out1",
            "source": "if1",
            "sourceHandle": "true",
            "target": "out1"
          }
        ]
      }
    }
  ]
}
```

<!-- ki-format:ende -->
