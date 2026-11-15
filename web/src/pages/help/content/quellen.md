Unter [Quellen](/quellen) sammelt BlaulichtCMS Meldungen aus RSS- und Atom-Feeds – als Anregung für eigene Beiträge.

## Quelle hinzufügen

1. **Quelle hinzufügen** → Adresse des Feeds eintragen.
2. **Vorschau laden** zeigt Titel und die neuesten Einträge.
3. **Quelle hinzufügen** übernimmt sie. BlaulichtCMS ruft sie danach regelmäßig ab (Standard alle 30 Minuten).

Doppelte Einträge werden erkannt und nicht erneut angelegt.

## Mit Einträgen arbeiten

| Aktion | Wirkung |
|---|---|
| Merken | Eintrag erscheint unter „Gemerkt“ für das ganze Team |
| Ausblenden | Eintrag verschwindet aus „Neu“ (wiederherstellbar) |
| Als Themenidee übernehmen | legt einen Beitragsentwurf mit Zusammenfassung und **Original-Link** an |

## Sicherheit

Feeds werden nur von öffentlichen Adressen geladen. Interne Adressen (z. B. im eigenen Netz) sind gesperrt, bis die Administration sie unter `security.allowed_private_hosts` ausdrücklich freigibt.
