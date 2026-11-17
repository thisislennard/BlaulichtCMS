Unter [Quellen](/quellen) sammelt BlaulichtCMS Meldungen aus RSS- und Atom-Feeds – als Anregung für eigene Beiträge.

## Feed-Adresse finden

Ein Feed ist eine maschinenlesbare Liste der neuesten Meldungen einer Website (RSS oder Atom). Die Adresse findet man so:

1. **Feed-Symbol oder Link** auf der Website suchen (orangefarbenes Symbol, „RSS“, „Feed“, „Abonnieren“) und die Adresse des Links kopieren.
2. **WordPress-Websites** liefern ihren Feed fast immer unter `/feed/`, z. B. `https://example.org/feed/`; Kategorien unter `/category/<name>/feed/`.
3. **Im Seitenquelltext** (Rechtsklick → „Seitenquelltext anzeigen“) nach `rel="alternate"` suchen: Ein Eintrag mit `type="application/rss+xml"` oder `type="application/atom+xml"` nennt die Feed-Adresse im `href` ([Feed-Erkennung nach RSS Advisory Board](https://www.rssboard.org/rss-autodiscovery)).
4. Die Adresse im Browser öffnen: Ein Feed zeigt XML-Text, keine normale Webseite.

## Quelle hinzufügen

1. **Quelle hinzufügen** → Adresse des Feeds eintragen.
2. **Vorschau laden** zeigt Titel und die neuesten Einträge.
3. **Quelle hinzufügen** übernimmt sie. BlaulichtCMS ruft sie danach regelmäßig ab (Standard alle 30 Minuten).

Übernommen wird eine Quelle **nur nach einem erfolgreichen Abruf**: BlaulichtCMS lädt die Adresse beim Hinzufügen selbst und prüft, ob ein lesbarer RSS- oder Atom-Feed kommt. Sonst erscheint der Grund (nicht erreichbar, interne Adresse gesperrt, kein Feed) und es wird nichts eingetragen. Doppelte Einträge werden erkannt und nicht erneut angelegt.

Unzulässige Steuerzeichen in Titeln und Texten (etwa ein NUL-Zeichen) entfallen beim Einlesen. Lässt sich ein **einzelner Eintrag** nicht übernehmen, wird er übersprungen – die übrigen kommen trotzdem an, und unter **Eingetragene Quellen** steht ein gelber Hinweis mit seinem Titel (Einzelheiten im Systemprotokoll). Beim nächsten Abruf wird er erneut versucht.

## Quelle bearbeiten

Über den Stift in **Eingetragene Quellen** lassen sich Name, Adresse und Abrufintervall ändern. Eine **neue Adresse** ruft BlaulichtCMS beim Speichern ab; liefert sie keinen lesbaren Feed, bleibt die alte Adresse bestehen.

## Mit Einträgen arbeiten

| Aktion | Wirkung |
|---|---|
| Merken | Eintrag erscheint unter „Gemerkt“ für das ganze Team |
| Ausblenden | Eintrag verschwindet aus „Neu“ (wiederherstellbar) |
| Als Themenidee übernehmen | legt einen Beitragsentwurf mit Zusammenfassung und **Original-Link** an |

## Sicherheit

Feeds werden nur von öffentlichen Adressen geladen. Interne Adressen (z. B. im eigenen Netz) sind gesperrt, bis die Administration sie unter [Einstellungen → Sicherheit](/einstellungen#sicherheit) → **Interne Ziele freigeben** ausdrücklich freigibt.
