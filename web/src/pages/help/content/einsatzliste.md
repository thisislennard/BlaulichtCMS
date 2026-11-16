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

1. Datei wählen, Website und Optionen festlegen, **Prüfen**: Die Vorschau zeigt die ersten Zeilen, wie viele schon vorhanden sind, bei wie vielen der Ort entfällt und welche Zeilen nicht lesbar waren.
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

Eingebunden wird die Liste mit dem Shortcode `[blaulichtcms_einsatzliste]` (auch im Elementor-Widget „Shortcode“) oder dem Block **BlaulichtCMS: Einsatzliste**, die Statistik mit `[blaulichtcms_einsatzstatistik]` bzw. dem Block **BlaulichtCMS: Einsatzstatistik**. Attribute überschreiben die Vorgaben:

| Shortcode | Attribute |
|---|---|
| `[blaulichtcms_einsatzliste]` | `jahr="aktuell"`/`"alle"`/`"2025"`, `kategorie="Brand"`, `spalten="nr,datum,stichwort,meldung,ort"`, `sortierung="absteigend"`/`"aufsteigend"`, `anzahl="20"` (0 = alle), `filter="jahr,kategorie"`/`"aus"`, `darstellung="tabelle"`/`"karten"`, `gruppierung="jahr"`, `detail="ja"`/`"nein"`, `nur_besondere="ja"`, `titel="…"` |
| `[blaulichtcms_einsatzstatistik]` | `jahr="aktuell"`/`"alle"`/`"2025"`, `ansicht="summe,monate,kategorien,jahre"`, `diagramm="balken"`/`"aus"`, `auswahl="ja"`/`"nein"`, `titel="…"` |

Beispiel für eine Seite wie bisher: links `[blaulichtcms_einsatzliste nur_besondere="ja" darstellung="karten" anzahl="5" filter="aus" titel="Besondere Einsätze"]`, rechts `[blaulichtcms_einsatzliste anzahl="20" jahr="alle" filter="aus" titel="Die letzten 20 Einsätze"]`, darunter `[blaulichtcms_einsatzliste gruppierung="jahr" jahr="alle" titel="Historie"]` und `[blaulichtcms_einsatzstatistik]`.

Diagramme zeigen jeden Wert auch als Zahl; unter **Als Tabelle** stehen dieselben Zahlen als Tabelle. Kategorien erscheinen immer mit Namen, nicht nur als Farbe.
