Die Einsatzliste zeigt die Einsätze auf der Website – als Tabelle oder Karten, mit Filter nach Jahr und Kategorie, Jahresabschnitten, Detailseite je Einsatz und einer Jahresstatistik mit Diagramm. Die Einträge entstehen in BlaulichtCMS und erscheinen erst **nach Freigabe**. Wie die Liste aussieht, stellt man in WordPress ein.

## Woher die Einträge kommen

| Weg | Wie |
|---|---|
| Einsatzmeldung | Unter [Einsatzliste](/einsatzliste) → **Vorschläge aus Einsatzmeldungen** stehen die eingegangenen Einsätze (FE2, Feuersoftware Connect) der letzten 60 Tage, die noch nicht in der Liste sind. **Übernehmen** legt einen Entwurf an: Alarmzeit, Stichwort, Klartext, Ortsteil und Einheiten aus der Meldung. |
| Workflow | Ausgang **Einsatz in Einsatzliste** (siehe [Workflows](/hilfe/workflows#ausgaenge)). Je Einsatz entsteht nur ein Eintrag, auch wenn der Workflow bei Aktualisierungen erneut läuft. Wahlweise gleich zur Freigabe eingereicht. |
| Von Hand | **Neuer Eintrag**. |
| Import | **Importieren** – siehe [unten](#vorhandene-einsaetze-importieren). |

Ein Eintrag enthält: Alarmzeit, laufende Nummer (leer = die Website zählt nach Alarmzeit im Jahr), Stichwort mit **Bedeutung** und **Kategorie** aus dem [Stichwortverzeichnis](/hilfe/stichwoerter-regeln) (leer lassen = automatisch), Einsatzmeldung, Ort, optional Fahrzeuge, weitere Kräfte, Kurzbericht, einen Link zu einem ausführlichen Bericht und Bilder (öffentliche Fassung ohne Standortdaten; das erste ist das Vorschaubild). **Besonderer Einsatz** hebt einen Eintrag hervor; auf der Website lassen sich besondere Einsätze auch einzeln auflisten. **Fehlalarm** erscheint als Kennzeichnung und in der Statistik.

## Freigabe und Veröffentlichung

1. Eintrag prüfen und **Zur Freigabe einreichen** (Menü am Ende der Zeile).
2. Eine Person mit dem Recht **Einsatzliste freigeben** gibt **genau diese Fassung** frei oder weist sie mit Begründung zurück. Mit dem [Vier-Augen-Prinzip](/hilfe/freigabe) gibt nicht frei, wer den Eintrag angelegt, geändert oder eingereicht hat.
3. **Auf Website veröffentlichen** (Recht **Einsatzliste veröffentlichen**). Die Bridge holt den Eintrag beim nächsten Abruf ab; der Stand wechselt auf **Auf der Website**, mit Link zur Detailseite.

Jede Änderung ergibt eine neue Fassung, die wieder freigegeben werden muss; die bisherige bleibt so lange auf der Website. Mehrere Einträge lassen sich auswählen und gemeinsam **einreichen**, **freigeben** und **veröffentlichen** – praktisch nach einem Import.

**Datenschutz-Prüfung bei Bildern:** Enthält ein Eintrag Bilder, die in der Sichtung markiert sind (**Personen erkennbar**, **Verletzte / Gesundheit**, **Kennzeichen / Adressen**, **Sonstiger sensibler Inhalt**) oder **offene Gesichtsvorschläge** haben, trägt er in der Liste das Kennzeichen **Datenschutz-Prüfung**. Freigeben geht dann nur einzeln über **Freigeben (mit Datenschutz-Prüfung) …** mit denselben Prüfpunkten wie bei Beiträgen (siehe [Freigabe](/hilfe/freigabe#datenschutz-pruefung-bei-markierten-medien)); die Sammelfreigabe überspringt solche Einträge. Wird ein Bild erst nach der Freigabe markiert (oder wurde der Eintrag vor dieser Prüfung freigegeben), verlangt **Auf Website veröffentlichen** die Bestätigung. Die Bestätigung steht im Audit-Protokoll.

**Zurückziehen** entfernt den Eintrag beim nächsten Abruf von der Website, samt Bildern, die sonst nirgends verwendet werden. Danach lässt er sich erneut veröffentlichen oder **löschen**. Ein Eintrag, der auf der Website steht, lässt sich erst nach dem Zurückziehen löschen.

Die Website braucht dafür die **BlaulichtCMS Bridge 0.9.0** oder neuer. Mit einer älteren Bridge warten die Aufträge, bis sie aktualisiert ist ([Updates](/hilfe/updates#blaulichtcms-bridge)).

## Datenschutz: nur grob

Die Liste ist öffentlich. Deshalb gilt:

- **Keine Adressen, keine Namen, keine Kennzeichen** – weder im Ort noch in Einsatzmeldung oder Kurzbericht.
- **Ort nur als Ortsteil oder Gemeinde.** Unter **Einstellungen** der Einsatzliste legt man die **erlaubten Ortsangaben** fest (Recht **Einsatzliste einstellen**), z. B. die Ortsteile des Einsatzgebiets. Dann wählt man den Ort nur noch aus dieser Liste; Einsatzmeldungen, Workflows und Importe werden darauf abgebildet („Gartenstraße, Musterstadt“ → „Musterstadt“), sonst entfällt der Ort. Ohne Liste weist BlaulichtCMS Ortsangaben mit Hausnummer, Postleitzahl oder Straßennamen zurück – diese Prüfung kann nicht jede Straße erkennen, die Liste ist deshalb der sichere Weg.
- Aus Einsatzmeldungen kommen ohnehin nur die Felder der Allowlist der Verbindung (siehe [Verbindungen](/hilfe/verbindungen)).
- Beim Import werden Einsatzleiter und Mannschaftsstärke nie übernommen, Berichtstexte nur auf ausdrücklichen Wunsch.

## Vorhandene Einsätze importieren

**Importieren** liest eine CSV-Datei mit Spaltennamen in der ersten Zeile (Trennzeichen Komma, Semikolon oder Tabulator, UTF-8, höchstens 5 MB). Erkannt werden u. a. Lfd./Nr., Alarmzeit bzw. Datum (und Uhrzeit), Einsatzart bzw. Stichwort, Berichtstitel bzw. Einsatzmeldung, Einsatzort, Fahrzeuge, Externe Einsatzmittel bzw. Weitere Kräfte, Berichtstext, Besonderer Einsatz und Fehlalarm.

Wer bisher die WordPress-Erweiterung **„Einsatzverwaltung“** nutzt: dort unter **Werkzeuge → Einsatzberichte exportieren** das Format **CSV** wählen und die Datei hier importieren.

1. Datei wählen, Website und Optionen festlegen, **Prüfen**: Die Vorschau zeigt die ersten Zeilen, wie viele schon vorhanden sind, bei wie vielen der Ort entfällt und welche Zeilen nicht lesbar waren – mit der Zeilennummer der Datei (Felder mit Zeilenumbrüchen zählen mit). Ungültige Datumsangaben wie „31.04.“ werden nicht weitergerechnet, sondern als nicht lesbar gemeldet.
2. **Importieren** legt die Einträge als Entwürfe an (wahlweise gleich eingereicht). Schon importierte Zeilen werden übersprungen – ein zweiter Import derselben Datei legt nichts doppelt an.
3. Einträge auswählen, freigeben und veröffentlichen.

Nach dem Wechsel die Liste der alten Erweiterung auf der Website entfernen, damit Einsätze nicht doppelt erscheinen.

## Darstellung auf der Website

In WordPress unter **Einstellungen → BlaulichtCMS Einsatzliste** – mit Vorschau (Beispieldaten, solange noch nichts übertragen wurde):

| Einstellung | Möglichkeiten |
|---|---|
| Spalten und Reihenfolge | Lfd., Datum, Einsatzart, Bedeutung, Kategorie, Einsatzmeldung, Einsatzort, Fahrzeuge, Weitere Kräfte, Bild |
| Darstellung | Tabelle oder Karten; auf schmalen Bildschirmen erscheinen Tabellenzeilen als Blöcke mit Beschriftung |
| Gliederung | eine Liste mit Filtern und Seiten oder **je Jahr ein aufklappbarer Abschnitt** (Historie) |
| Jahr, Sortierung, Einträge je Seite | neuestes Jahr oder alle; neueste oder älteste zuerst |
| Filter für Besucher | Jahr und/oder Kategorie |
| Detailseiten | an/aus, Adresse (z. B. `/einsatz/…`) |
| Farben | Akzentfarbe, Tabellenkopf; Farbe und Symbol je Kategorie. Leer = Farben des Themes |
| Statistik | Anzahl im Jahr (mit Vorjahr und Fehlalarmen), je Monat, je Kategorie, je Jahr |

## Shortcodes und Blöcke

Eingebunden werden Liste und Statistik mit Shortcodes (im Block-Editor über den Block „Shortcode“, im klassischen Editor im Text, in Elementor über das Widget „Shortcode“) oder mit den Blöcken **BlaulichtCMS: Einsatzliste** und **BlaulichtCMS: Einsatzstatistik** – dort stehen dieselben Attribute als Felder in der Seitenleiste, ein leeres Feld heißt „Vorgabe der Einstellungen“. Ab Bridge 0.9.1 erklärt das Plugin alle Shortcodes mit Beispielen zum Kopieren selbst: **Einstellungen → BlaulichtCMS Einsatzliste → Reiter Shortcodes**.

| Shortcode | Zeigt | Block |
|---|---|---|
| `[blaulichtcms_einsatzliste]` | Einsatzliste (Tabelle oder Karten, Filter, Seiten oder Jahresabschnitte) | BlaulichtCMS: Einsatzliste |
| `[blaulichtcms_einsatzstatistik]` | Jahresstatistik, ganz oder in einzelnen Teilen | BlaulichtCMS: Einsatzstatistik |
| `[blaulichtcms_banner]` | aktive Hinweise als Banner (keine Attribute), siehe [Banner](/hilfe/banner) | BlaulichtCMS: Hinweise |
| `[blaulichtcms_einsaetze anzahl="10"]` | die letzten Einsatzberichte (Beiträge), `anzahl` 1–50, Vorgabe 10 | BlaulichtCMS: Einsatzübersicht |

Fehlt ein Attribut, gilt die Vorgabe; unbekannte Werte werden ignoriert. Als „ja“ gelten `ja`, `1`, `true`, `an` und `yes`.

### Statistik in Teilen

`[blaulichtcms_einsatzstatistik]` besteht aus vier Teilen, die sich mit `ansicht` einzeln an beliebigen Stellen zeigen lassen (mehrere mit Komma; sie erscheinen immer in dieser Reihenfolge):

| `ansicht` | Zeigt |
|---|---|
| `summe` | große Zahl „Einsätze im Jahr …“ mit Vorjahr und Fehlalarmen; bei `jahr="alle"` „Einsätze insgesamt“ |
| `monate` | Einsätze je Monat – nur bei einem einzelnen Jahr |
| `kategorien` | Einsätze je Kategorie, häufigste zuerst; bei `jahr="alle"` über alle Jahre |
| `jahre` | Einsätze je Jahr im Vergleich, immer alle Jahre |

| Attribut | Werte | Vorgabe |
|---|---|---|
| `ansicht` | `summe`, `monate`, `kategorien`, `jahre`, kombinierbar | Einstellung „Ansichten“ |
| `jahr` | `aktuell` (neuestes Jahr mit Einsätzen), `alle`, Jahreszahl wie `2025` | `aktuell` |
| `diagramm` | `balken` (Diagramm, darunter „Als Tabelle“) oder `aus` (nur Tabellen) | `balken` |
| `auswahl` | `ja`/`nein` – Jahresauswahl für Besucher (ab zwei Jahren mit Einsätzen) | `ja` |
| `titel` | Überschrift | leer |

**`auswahl` wirkt nur im jeweiligen Shortcode:** Es blendet dort die Jahresauswahl ein oder aus und legt fest, ob dieser Teil einem gewählten Jahr folgt. Mit `auswahl="nein"` bleibt ein Teil bei seinem `jahr`, auch wenn auf derselben Seite anderswo ein Jahr gewählt wird. Das gewählte Jahr steht in der Adresse der Seite – alle Teile derselben Seite mit eingeschalteter Auswahl (Statistik mit `auswahl="ja"`, Liste mit Filter `jahr`) zeigen danach dieses Jahr.

### Attribute der Liste

Ohne Attribute zeigt `[blaulichtcms_einsatzliste]` die Liste wie in den Einstellungen; jedes Attribut gilt nur für diesen Shortcode.

| Attribut | Werte | Vorgabe |
|---|---|---|
| `jahr` | `aktuell`, `alle`, Jahreszahl; mit `gruppierung="jahr"` zeigt eine Jahreszahl nur diesen Abschnitt | Einstellung „Jahr“ |
| `kategorie` | Kategoriename wie in BlaulichtCMS, z. B. `Brand` | alle |
| `spalten` | `nr`, `datum`, `stichwort`, `bedeutung`, `kategorie`, `meldung`, `ort`, `fahrzeuge`, `kraefte`, `bild` – mit Komma, in dieser Reihenfolge angezeigt | Einstellung „Spalten“ |
| `sortierung` | `absteigend` (neueste zuerst) oder `aufsteigend` | Einstellung |
| `anzahl` | 0–500 Einträge je Seite, `0` = alle; ohne Wirkung bei `gruppierung="jahr"` | Einstellung (20) |
| `filter` | `jahr`, `kategorie`, `jahr,kategorie` oder `aus`; bei `gruppierung="jahr"` keine Filter | Einstellung |
| `darstellung` | `tabelle` oder `karten` | Einstellung |
| `gruppierung` | `keine` oder `jahr` (je Jahr ein aufklappbarer Abschnitt) | Einstellung |
| `detail` | `ja`/`nein` – Einsatzmeldung zur Detailseite verlinken (nur wenn Detailseiten eingeschaltet sind) | Einstellung |
| `nur_besondere` | `ja`/`nein` | `nein` |
| `titel` | Überschrift | leer |

### Beispiele

| Zweck | Shortcode |
|---|---|
| Nur die große Zahl auf der Startseite | `[blaulichtcms_einsatzstatistik ansicht="summe" auswahl="nein"]` |
| Monatsdiagramm | `[blaulichtcms_einsatzstatistik ansicht="monate" auswahl="nein"]` |
| Kategorien als Tabelle | `[blaulichtcms_einsatzstatistik ansicht="kategorien" diagramm="aus" auswahl="nein"]` |
| Alle Jahre im Vergleich | `[blaulichtcms_einsatzstatistik ansicht="jahre" auswahl="nein"]` |
| Gesamtzahl über alle Jahre | `[blaulichtcms_einsatzstatistik ansicht="summe" jahr="alle" auswahl="nein"]` |
| Liste der letzten 20 Einsätze | `[blaulichtcms_einsatzliste anzahl="20" jahr="alle" filter="aus" titel="Die letzten 20 Einsätze"]` |
| Historie nach Jahren | `[blaulichtcms_einsatzliste gruppierung="jahr" jahr="alle" titel="Historie"]` |
| Besondere Einsätze als Karten | `[blaulichtcms_einsatzliste nur_besondere="ja" darstellung="karten" anzahl="5" filter="aus" titel="Besondere Einsätze"]` |

Diagramme zeigen jeden Wert auch als Zahl; unter **Als Tabelle** stehen dieselben Zahlen als Tabelle. Kategorien erscheinen immer mit Namen, nicht nur als Farbe.
