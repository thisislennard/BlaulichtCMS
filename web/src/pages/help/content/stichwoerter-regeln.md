Unter [Stichwörter & Regeln](/warnungen/pflege) werden die Grundlagen des Warnstufen-Assistenten **lokal** gepflegt. BlaulichtCMS wird **ohne aktive Regeln** ausgeliefert – alle Inhalte stimmt die Organisation selbst mit der zuständigen Stelle ab.

## Stichwörter und Aliase

Ein Stichwort hat ein **Kürzel** (z. B. aus der Alarm- und Ausrückeordnung), eine **Bezeichnung** und beliebige **Aliase** für die Suche und für die Zuordnung aus FE2. Nicht mehr genutzte Stichwörter werden **deaktiviert**, nicht gelöscht. Bezeichnung und Aliase lassen sich über **Bearbeiten** ändern; das Kürzel bleibt fest, weil Regeln und Vorgänge darauf verweisen.

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

## E-Mail-Versand

SMTP-Server, Absender und Zugangsdaten (verschlüsselt gespeichert). Der **Testmodus** ist ab Werk aktiv und schickt alles an das Testpostfach. Eine **Testmail** prüft die Verbindung. Verschlüsselung „keine“ ist nur für Testserver ohne Anmeldung gedacht: mit Benutzer oder Passwort lehnt BlaulichtCMS das Speichern ab, damit Zugangsdaten nie unverschlüsselt übertragen werden.
