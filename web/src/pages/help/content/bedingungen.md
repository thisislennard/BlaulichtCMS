Mit Bedingungen entscheidet ein Workflow selbst, was passieren soll: Nur Brandeinsätze auf die Website, wichtige Meldungen in Teams, alles andere nur ins Protokoll. Dafür gibt es drei Bausteine.

| Baustein | Wann verwenden? | Ausgänge |
|---|---|---|
| **Wenn / Sonst** | Zwei Wege: ja oder nein | „Wahr“ und „Falsch“ |
| **Filter** | Nur weitermachen, wenn etwas zutrifft – sonst einfach aufhören | „Passt“ |
| **Switch** | Mehrere Wege je nach Wert, z. B. nach Einsatzart | ein Ausgang je Fall plus „Sonst“ |

## Wenn / Sonst

Ihr legt eine oder mehrere **Bedingungen** fest. Jede Bedingung hat drei Teile:

1. **Linker Wert** – meist eine Variable, z. B. `{{ alamos.stichwort }}`
2. **Vergleich** – z. B. „beginnt mit“
3. **Vergleichswert** – z. B. `B`

Bei mehreren Bedingungen wählt ihr die **Verknüpfung**:

- **Alle müssen zutreffen (UND)** – z. B. Stichwort beginnt mit „B“ *und* Ortsteil ist nicht leer.
- **Mindestens eine muss zutreffen (ODER)** – z. B. Stichwort beginnt mit „B“ *oder* mit „TH“.

Trifft das Ergebnis zu, geht es am Ausgang **Wahr** weiter, sonst am Ausgang **Falsch**. Ein Ausgang ohne Linie beendet den Lauf an dieser Stelle – erfolgreich.

**Beispiel:** Meldungen mit Priorität „hoch“ nach Teams, alle anderen ins Protokoll.

| Linker Wert | Vergleich | Vergleichswert |
|---|---|---|
| `{{ webhook.body.prioritaet }}` | ist gleich | `hoch` |

## Filter

Der Filter funktioniert wie Wenn / Sonst, hat aber nur den Ausgang **Passt**. Trifft die Bedingung nicht zu, endet der Lauf hier mit dem Hinweis „Gefiltert – Lauf endet hier“. Der Lauf gilt trotzdem als erfolgreich – es ist ja nichts schiefgegangen.

**Beispiel:** Nur Brandeinsätze und technische Hilfe auf die Website:

| Linker Wert | Vergleich | Vergleichswert |
|---|---|---|
| `{{ alamos.stichwort }}` | beginnt mit | `B` |
| `{{ alamos.stichwort }}` | beginnt mit | `TH` |

Verknüpfung: **Mindestens eine muss zutreffen (ODER)**.

> **Tipp:** Beim Trigger „Alamos-Einsatz“ gibt es zusätzlich den **Stichwort-Filter** in den erweiterten Optionen. Er filtert schon beim Empfang – unpassende Einsätze erzeugen dann gar keinen Lauf und tauchen nicht im Ausführungsverlauf auf. Siehe [Alamos FE2 anbinden](/hilfe/alamos-fe2#stichwort-filter).

## Switch

Der Switch prüft **einen Wert** gegen mehrere **Fälle**. Jeder Fall bekommt einen eigenen Ausgang; passt keiner, geht es bei **Sonst** weiter.

**Beispiel:** Je nach Einsatzart unterschiedliche Banner-Farben.

- Wert: `{{ alamos.stichwort }}`
- Vergleich: **beginnt mit**

| Fall | Werte | Folgt |
|---|---|---|
| Brand | `B` | Banner rot |
| Technische Hilfe | `TH` | Banner orange |
| Gefahrgut | `ABC, CBRN` | Banner gelb |
| Sonst | – | nichts (Lauf endet) |

Regeln:

- Mehrere Werte je Fall trennt ihr mit Komma.
- Groß-/Kleinschreibung spielt keine Rolle.
- Die Fälle werden von oben nach unten geprüft; der **erste** passende gewinnt.
- Vergleich wahlweise **ist gleich**, **beginnt mit** oder **enthält**.

Im Ergebnis stehen `{{ name.value }}` (geprüfter Wert, kleingeschrieben) und `{{ name.case }}` (Name des getroffenen Falls).

## Vergleiche im Detail

| Vergleich | Beispiel | Hinweis |
|---|---|---|
| ist gleich / ist ungleich | Priorität ist gleich `hoch` | Groß-/Kleinschreibung und Leerzeichen am Rand egal |
| enthält / enthält nicht | Meldung enthält `Person` | Bei Listen: ein Eintrag ist genau der Wert, z. B. Einheiten enthält `DLK` |
| beginnt mit / endet mit | Stichwort beginnt mit `B` | |
| größer / kleiner (oder gleich) | `{{ pruefung.status }}` kleiner als `400` | Zahlen mit Komma oder Punkt; sind beide Seiten Datumswerte, wird nach Zeit verglichen |
| ist einer von / ist keiner von | Stichwort ist einer von `B2, B3, B4` | Komma-Liste, exakter Vergleich je Eintrag |
| ist leer / ist nicht leer | Ortsteil ist nicht leer | Kein Vergleichswert nötig |
| ist wahr / ist falsch | `{{ zeitplan.catch_up }}` ist wahr | „wahr“ sind: true, 1, ja, yes, wahr |

Die vollständige Liste steht unter [Filter & Vergleiche](/hilfe/filter#vergleiche).

## Lauf gezielt beenden

Mit dem Baustein **Lauf beenden** könnt ihr einen Lauf bewusst stoppen:

- **Erfolgreich beenden** – z. B. „Einsatzart nicht relevant“.
- **Als Fehler beenden** – für Plausibilitätsprüfungen, z. B. wenn ein Pflichtfeld in der Meldung fehlt. Der Lauf erscheint dann als fehlgeschlagen, und es gibt eine Benachrichtigung.

Die **Begründung** steht später im Ausführungsverlauf.
