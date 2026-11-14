LifeLink bereitet Warnentwürfe vor und übergibt sie als **freigegebene PDF per E-Mail** an die zuständige Stelle. Die **amtliche Auslösung** (z. B. über MoWaS) erfolgt ausschließlich dort. LifeLink selbst löst keine Warnung aus.

## Ablauf in sechs Schritten

Der Assistent ist für das Handy gebaut: Schritte oben, **Zurück / Speichern / Weiter** unten.

1. **Vorgang** – Erstmeldung, Aktualisierung oder Entwarnung. Jeder Vorgang hat eine eigene Vorgangs-ID (z. B. `W-2026-0001`).
2. **Stichwort & Warnstufe** – Feuerwehrstichwort suchen, Lagefragen beantworten, Warnstufe bestätigen (siehe unten).
3. **Gebiet & Zeitraum** – betroffenes Gebiet, Beginn, Gültigkeit und die zuständige(n) Stelle(n).
4. **Inhalt** – Überschrift, Lage, Verhaltensempfehlungen, Absender, Rückrufkontakt.
5. **Prüfen & PDF** – PDF-Vorschau (mit „ENTWURF“ gekennzeichnet), einreichen, freigeben.
6. **Versand** – Empfänger prüfen, versenden, Ergebnis und Eingangsbestätigung festhalten.

## Stichwort-Umrechner und Warnstufen-Assistent

- Das Stichwort lässt sich nach Kürzel, Bezeichnung oder Alias **suchen**, aus einem **FE2-Einsatz übernehmen** oder **weglassen**.
- Angezeigt werden nur **fachlich freigegebene Lagefragen**.
- Ein **Vorschlag** erscheint nur, wenn die Antworten **eindeutig** zu freigegebenen Regeln passen – mit Begründung und Regelversion.
- Sonst steht dort **„Keine eindeutige Empfehlung – fachlich prüfen“**: bei unbekanntem Stichwort, fehlenden Angaben, widersprüchlichen Regeln oder wenn keine Regel passt.
- **Ein fehlender Vorschlag ist nie eine Entwarnung.**
- Ein Vorschlag löst **weder Versand noch Veröffentlichung** aus.

### Warnstufe bestätigen

Die Stufe bestätigt eine Person mit dem Recht **„Warnstufe bestätigen“** ausdrücklich. Wer vom Vorschlag abweicht – oder wenn es keinen Vorschlag gibt –, muss eine **Begründung** angeben. Gespeichert werden Stichwort, Antworten, Regelversion, Vorschlag und Entscheidung.

Ändern sich Stichwort oder Lageantworten, verfällt die Bestätigung und muss **neu** erteilt werden. Reine Textänderungen behalten sie.

### Aktualisierung und Entwarnung

- Eine **Aktualisierung** übernimmt die Inhalte des Bezugsvorgangs und zeigt die **bisherige Stufe** an. Die Stufe muss erneut bestätigt werden.
- Eine **Entwarnung** ist ein eigener Vorgang **ohne Warnstufe** – sie setzt die Stufe nicht auf 3.

## Freigabe und PDF

Freigegeben wird genau **eine Fassung**. Dabei erzeugt LifeLink die endgültige PDF und speichert sie mit **Prüfsumme (SHA-256)**. Jede spätere Änderung erzeugt eine neue Fassung, die erneut freigegeben werden muss. Die PDF enthält Vorgangs-ID, Art, Fassung und Zeitstand, Vorlagenversion, Stichwort, die **bestätigte Warnstufe** und die Freigabe.

## Versand

| Status | Bedeutung |
|---|---|
| Vom Mailserver angenommen | technische Annahme – **keine** fachliche Eingangsbestätigung |
| Versand fehlgeschlagen | sicher nicht versendet – erneuter Versand möglich |
| Versand unklar – prüfen | Verbindung brach nach dem Senden ab; die Mail **kann** angekommen sein |
| Eingang bestätigt | die zuständige Stelle hat den Eingang bestätigt (z. B. telefonisch) |

Bei **unklarem Ergebnis** versendet LifeLink nie automatisch erneut. Erst nach der Prüfung („ist angekommen“ / „ist nicht angekommen“) ist ein neuer Versand möglich.

**Testmodus:** Solange er aktiv ist (Standard), gehen alle Warnmails ausschließlich an das hinterlegte **Testpostfach**; Betreff mit `[TEST]`, die vorgesehenen Empfänger stehen nur im Mailtext.

## Rechte

| Recht | Wer typischerweise |
|---|---|
| Warnentwurf erstellen | Rolle „Warnentwurf“ |
| Warnstufe bestätigen | Rolle „Warnfreigabe“ |
| Warnentwurf freigeben | Rolle „Warnfreigabe“ |
| Warnentwurf versenden | Rolle „Warnversand“ |
| Stichwörter und Regeln pflegen | Administration |
