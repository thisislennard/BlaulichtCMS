Unter [Einrichtung → Stichwörter & Regeln](/stichwoerter-regeln) werden die Grundlagen des Warnstufen-Assistenten **lokal** gepflegt. BlaulichtCMS wird **ohne aktive Regeln** ausgeliefert – alle Inhalte stimmt die Organisation selbst mit der zuständigen Stelle ab.

## Stichwortverzeichnis der Länder

Unter [Einstellungen → Organisation](/einstellungen/organisation) wird das **Bundesland** gewählt (Recht „Allgemeine Einstellungen ändern“). Für Länder mit öffentlichem, amtlichem Verzeichnis übernimmt BlaulichtCMS dessen Einsatzstichworte in die Stichwortliste. Das Verzeichnis ist **wortgetreu** aus der Quelle abgeschrieben; nichts wird ergänzt.

| Land | Quelle | Übernommen |
|---|---|---|
| Hessen | Gemeinsamer Runderlass des HMdI und des HMFG zur Festlegung der Einsatzstichworte für Brand-, Hilfeleistungs- und Rettungsdiensteinsätze vom 30. August 2024, gültig 1. Oktober 2024 bis 31. Dezember 2029 ([PDF](https://familie.hessen.de/sites/familie.hessen.de/files/2024-09/2024-08-30_gemeinsamer_runderlass_einsatzstichworte.pdf)) | 58 Einsatzstichworte mit Meldebild, Kategorien Brand, Hilfeleistung, Unwetter, Rettungsdienst. Abgeglichen mit der Vorgängerfassung vom 1. November 2022 ([PDF](https://innen.hessen.de/sites/innen.hessen.de/files/2022-12/EinsatzstichworteErl-Endversion-gez.pdf)), die am 30. September 2024 außer Kraft trat. |
| Bayern | Einsatzstichwörter, Anlage zu Nr. 2.1.4 der Alarmierungsbekanntmachung (ABek) des Staatsministeriums des Innern, Stand 15.03.2017 ([PDF auf gesetze-bayern.de](https://www.gesetze-bayern.de/Content/Resource?path=resources%2fBayVV_215_I_2279_BayVV215-I-2279-KF-001-Anhang-001.PDF)) | 125 Stichwörter der Übersicht (Brand, THL, ABC, RD, sonstige, Infoeinsätze), **nur die Kürzel**. Die Schlagwörter der Detailtabellen sind nicht übernommen. |

Für alle anderen Länder steht dort **„Kein öffentliches Verzeichnis hinterlegt – eigene Liste importieren“**. Dort ist entweder kein landesweites Verzeichnis öffentlich zugänglich, oder die Stichworte legen Kreise und Leitstellen selbst fest. „Eigene Liste“ arbeitet ganz ohne Landesverzeichnis.

So arbeitet die Liste:

- **Wechsel des Landes:** Die Einträge des neuen Verzeichnisses werden übernommen bzw. wieder aktiviert, die des bisherigen deaktiviert (nicht gelöscht – Regeln und Vorgänge behalten ihren Bezug).
- **Eigene Einträge haben Vorrang.** Ein eigener Eintrag mit demselben Kürzel ersetzt den Eintrag des Verzeichnisses. Wer Bezeichnung oder Kategorie eines Verzeichniseintrags ändert, macht ihn damit zum eigenen Eintrag.
- **Landesverzeichnis neu übernehmen** (Stichwörter & Regeln → Menü **Import/Export**) frischt das Verzeichnis auf, z. B. nach einem Update mit neuer Fassung. Das geschieht auch bei jedem Start. Von Hand deaktivierte Einträge bleiben dabei aus.
- **Eigene Liste importieren** (Menü **Import/Export**): CSV mit Semikolon in der Reihenfolge `code;bezeichnung;kategorie` (Kopfzeile optional) oder JSON (`[{"code": "…", "bezeichnung": "…", "kategorie": "…"}]`). Vorher zeigt BlaulichtCMS, wie viele Einträge übernommen und welche Zeilen übersprungen werden. Recht: „Stichwörter und Regeln pflegen“.
- **Export** als CSV oder JSON (Menü **Import/Export**) enthält die ganze Liste mit Herkunft (Länderkürzel oder `eigen`). Die CSV lässt sich wieder importieren. Alle importierten Zeilen werden dabei zu eigenen Einträgen, also vorher auf die gewünschten Zeilen kürzen.

Wo die Liste wirkt:

- **Einsatzmeldungen** (FE2, Feuersoftware Connect): Fehlt der Klartext zum Stichwort, ergänzt BlaulichtCMS ihn aus der Liste, z. B. im Titel des Einsatzentwurfs. In der Vorschau der Einsätze steht die Bedeutung neben dem Stichwort.
- **Workflows:** Bedingungen auf `stichwort` und `stichwort_kategorie` schlagen die Einträge der Liste vor. Das Feld `stichwort_kategorie` kommt aus der Liste.
- **Warnentwurf:** Beim Übernehmen aus einem Einsatz wird das passende Stichwort gewählt.
- **Feuersoftware-Filter:** Unter dem Stichwortfilter steht die Bedeutung der eingetragenen Stichworte.

Beim Abgleich zählen weder Groß- und Kleinschreibung noch Leerzeichen oder Bindestriche: `F2` ist dasselbe wie `F 2`. Untergliederungen wie `F2 W` oder `F2.1`, die der hessische Erlass zulässt, gehören zum Stichwort `F 2`. `H 10` gehört dagegen nicht zu `H 1`. **Unbekannte Stichworte bleiben unverändert** stehen.

## Stichwörter und Aliase

Ein Stichwort hat ein **Kürzel** (z. B. aus der Alarm- und Ausrückeordnung), eine **Bezeichnung**, eine **Kategorie** und beliebige **Aliase** für die Suche und für die Zuordnung aus FE2.

Die Stichwörter stehen als **Tabelle** mit einer Zeile je Stichwort: Kürzel, Bezeichnung (dahinter leise das Meldebild), Kategorie, Herkunft, Zahl der Lagefragen und Regeln („offen“ = noch ohne fachliche Freigabe) und Status. Direkt darüber filtern **Suchfeld** (Kürzel, Bezeichnung, Meldebild, Aliase), **Kategorie** und **Inaktive zeigen**. Der Pfeil am Zeilenanfang klappt **Lagefragen und Regeln** des Stichworts auf – dort lassen sich Fragen freigeben, außer Kraft setzen und neue anlegen. Am Handy steht jedes Stichwort als kompakte Karte mit denselben Angaben.

- **+ Stichwort** öffnet den Dialog zum Anlegen.
- Das Menü **⋯** einer Zeile bietet **Bearbeiten** (Bezeichnung, Kategorie, Aliase – das Kürzel bleibt fest, weil Regeln und Vorgänge darauf verweisen), **Lagefrage hinzufügen** und **Deaktivieren**. Nicht mehr genutzte Stichwörter werden deaktiviert, nicht gelöscht; vorher fragt BlaulichtCMS nach. **Aktivieren** (bei eingeschaltetem „Inaktive zeigen“) macht es rückgängig.
- Herkunft, Stand und Gültigkeit des Landesverzeichnisses stehen im einklappbaren Kasten **Stichwortverzeichnis** über der Tabelle.

## Lagefragen

Je Stichwort beliebig viele Fragen mit festen Antworten (Standard: *ja / nein / unbekannt*). Eine Frage erscheint im Assistenten erst nach **fachlicher Freigabe durch eine andere Person**. „unbekannt“ zählt als fehlende Angabe.

## Regeln

Eine Regel verknüpft Antworten mit einer Warnstufe, z. B.:

```
rauch_wohngebiet = ja
evakuierung = nein
```
→ Warnstufe 3, mit fachlicher Begründung.

- Mehrere Regeln je Stichwort sind möglich. Eine Zeile kann mehrere erlaubte Antworten haben: `wind = stark | sehr stark`.
- Jede Regel ist **versioniert**. Eine neue Version wird als Entwurf gespeichert; mit ihrer Freigabe tritt die alte Version außer Kraft.
- Wirksam sind nur **fachlich freigegebene** Regeln. Die Freigabe muss eine **andere Person** erteilen als die, die die Regel angelegt hat.
- Regeln auf nicht freigegebene Fragen treffen nie zu.
- Passen mehrere Regeln mit **unterschiedlichen Stufen**, gibt es keinen Vorschlag („widersprüchliche Regeln“).

## Zuständigkeiten

Empfänger der Übergabe-Mail (eine oder mehrere Adressen je Stelle). Im Wizard wird die Stelle je Vorgang gewählt. Name, Gebiet und Empfänger lassen sich über **Bearbeiten** ändern; das gilt für künftige Übergaben, bereits versendete Warnentwürfe bleiben unverändert.

## Vorlagen

Die Vorlage legt Felder, Stufenbezeichnungen, PDF-Titel und -Fußzeile sowie Betreff und Mailtext fest. Jede Änderung erzeugt eine **neue Version**; laufende Vorgänge behalten ihre Version und bleiben reproduzierbar.

## Testmail und Testmodus

Der Versandweg für alle E-Mails – SMTP-Server oder Microsoft 365, jeweils mit Zugangsdaten und Testmail – wird an einer Stelle eingerichtet: [Einstellungen → E-Mail & Push](/einstellungen/e-mail) (siehe [E-Mail und Push einrichten](/hilfe/benachrichtigungen#e-mail-und-push-einrichten)). Darüber gehen auch die Übergabe-Mails der Warnentwürfe.

Hier im Reiter **Testmodus** (Recht „Versand einstellen“) bleibt, was nur den Warnversand betrifft:

- **Testmodus** – ab Werk aktiv: Alle Warnmails gehen ausschließlich an das **Testpostfach** (Betreff mit [TEST]). Nicht die Adresse der zuständigen Stelle als Testpostfach eintragen.
- **Testmail senden** – über den eingestellten Versandweg mit den gespeicherten Angaben. Ankunft im Postfach prüfen (auch im Spam-Ordner).

**Ausschalten lässt sich der Testmodus erst nach einer erfolgreichen Testmail** über den eingestellten Versandweg mit genau den gespeicherten Angaben (höchstens 60 Minuten alt) – hier oder unter Einstellungen → E-Mail & Push. Im Echtbetrieb verlangt dort auch jede Änderung der SMTP-Angaben bzw. der Wechsel auf SMTP eine frische Testmail mit genau diesen Werten. Den Testmodus wieder einschalten geht jederzeit. Vor dem Echtbetrieb das Verfahren mit der zuständigen Stelle abstimmen.
