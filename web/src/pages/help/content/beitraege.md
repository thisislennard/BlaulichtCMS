## Arten

| Art | Wofür |
|---|---|
| Nachricht | Allgemeine Meldungen |
| Einsatzbericht | Berichte nach einem Einsatz |
| Veranstaltung | Termine, Rückblicke |
| Lage-Info | Informationen während einer laufenden Lage |

## Fassungen

Jedes Speichern mit geändertem Inhalt erzeugt eine neue, unveränderliche **Fassung** (Fassung 1, 2, 3 …). Eine Fassung umfasst Titel, Text, Kurzfassung, Medien in ihrer Reihenfolge, das Titelbild und den Zielkanal. Speichern ohne Änderung erzeugt keine neue Fassung.

Bearbeiten zwei Personen gleichzeitig, gewinnt nicht einfach die letzte: BlaulichtCMS meldet „Der Beitrag wurde inzwischen geändert“ und bittet um Neuladen.

## Text

Absätze durch eine Leerzeile trennen. Die Website übernimmt den Text als einfache Absätze. Formatierungen werden bewusst nicht übertragen.

## Medien

- **Medien übernehmen** öffnet die Auswahl aus den Sammlungen (zuerst die des Beitrags).
- Mit den Pfeilen die Reihenfolge ändern, mit „Als Titelbild“ das Beitragsbild festlegen.
- Veröffentlicht wird immer die geprüfte Fassung ohne Standortdaten.

## Zielkanal

„Nur intern“ oder eine gekoppelte Website. Auch eine Änderung des Zielkanals erzeugt eine neue Fassung und braucht eine neue Freigabe.

Weiter mit [Freigabe und Veröffentlichung](/hilfe/freigabe).

## Alternativtext

Jedes Bild braucht einen **Alternativtext**: eine kurze Beschreibung für Menschen, die das Bild nicht sehen – Screenreader lesen ihn vor, und er erscheint, wenn ein Bild nicht lädt. BlaulichtCMS übergibt ihn an die Website (WordPress), Facebook, Instagram (Bildbeiträge), Threads, X (über die X-API), Mastodon und Bluesky. Storys, der WhatsApp-Kanal und X beim Teilen von Hand haben kein Feld dafür.

- Im Beitrag unter **Medien** steht unter jedem Bild das Feld **Alternativtext**. Der Text ist **Teil der Fassung** – eine Änderung braucht eine neue Freigabe.
- In der **Medienverwaltung** (Details einer Datei) lässt sich ein Alternativtext hinterlegen; der Beitrag schlägt ihn vor. Steht dort noch keiner, übernimmt die Medienverwaltung beim Speichern den Text aus dem Beitrag – so lässt er sich wiederverwenden.
- Fehlt ein Alternativtext, warnt die **Freigabe**. Unter **Einstellungen → Redaktion → Alternativtext ist Pflicht** lässt sich die Freigabe dann ganz sperren. Die Formatprüfung der sozialen Kanäle nennt fehlende Texte ebenfalls.

**So gelingt ein guter Alternativtext**

- Kurz und sachlich sagen, **was zu sehen ist und warum es wichtig ist**: „Löschfahrzeug vor dem Gerätehaus, zwei Einsatzkräfte rollen Schläuche aus“.
- Nicht mit „Bild von …“ oder „Foto:“ beginnen – dass es ein Bild ist, sagt der Screenreader selbst.
- Keine Namen von Personen, keine Kennzeichen, keine Adressen. Der Alternativtext ist öffentlich wie das Bild.
- Text im Bild (z. B. ein Plakat) gehört in den Alternativtext oder in den Beitrag.
- Hilfreich ist der Entscheidungsbaum der W3C-Initiative für Barrierefreiheit ([WAI: alt Decision Tree](https://www.w3.org/WAI/tutorials/images/decision-tree/), englisch).

## Lesbarkeit

Unter dem Text zeigt **Lesbarkeit** zwei Kennzahlen und konkrete Hinweise. Gerechnet wird im Browser, ohne KI; alles sind **Hinweise, keine Pflicht**.

| Kennzahl | Bedeutung |
|---|---|
| **Flesch** (deutsche Fassung nach Amstad) | 0 bis 100, höher ist leichter. Ab etwa 60 lesen die meisten Erwachsenen den Text ohne Mühe; unter 30 ist er sehr schwer. |
| **Wiener Sachtextformel** | Ungefähre Schulstufe von 4 (sehr leicht) bis 15 (sehr schwer). Für Bürgerinformationen sind Werte um 8 bis 10 ein guter Richtwert. |

Silben schätzt BlaulichtCMS mit einer einfachen Regel für das Deutsche; bei Fremdwörtern und Abkürzungen weicht sie ab. Die Hinweise nennen lange Sätze (mehr als 20 Wörter), sehr lange Wörter, Abkürzungen und Fachbegriffe, wenig Gliederung, Linktexte wie „hier“, viele Emojis, Hashtags ohne Großbuchstaben (`#FeuerwehrMusterstadt` statt `#feuerwehrmusterstadt` – sonst liest der Screenreader ein einziges Wort) und Wörter in Großbuchstaben.

**Tipps für Einfache und Leichte Sprache**

- **Eine Aussage je Satz.** Das Wichtigste zuerst: Was ist passiert, was sollen die Menschen tun?
- **Aktiv statt Passiv:** „Die Feuerwehr sperrt die Straße“ statt „Die Straße wurde gesperrt“.
- **Bekannte Wörter** statt Fachsprache; lange Wörter mit Bindestrich trennen („Rauch-Melder“ in Leichter Sprache).
- **Abkürzungen ausschreiben** oder erklären; Zahlen als Ziffern, Uhrzeiten eindeutig („um 14 Uhr“).
- **Kurze Absätze** mit Leerzeile – die Website übernimmt den Text als Absätze.
- Bei Warnungen: konkrete Handlungsanweisung („Fenster und Türen schließen“).
- **Leichte Sprache** ist eine eigene Form mit festen Regeln und Prüfung durch Menschen mit Lernschwierigkeiten – Regeln und Prüfgruppen vermittelt z. B. das [Netzwerk Leichte Sprache](https://www.leichte-sprache.org/). **Einfache Sprache** ist weniger streng und für die meisten Beiträge der richtige Maßstab. Weitere Informationen zur Barrierefreiheit von Bundesstellen: [Bundesfachstelle Barrierefreiheit](https://www.bundesfachstelle-barrierefreiheit.de/DE/Home/home_node.html).
