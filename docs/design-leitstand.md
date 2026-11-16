# Design „Leitstand“ – Anleitung

Stand: 14.11.2026 (zweiter Durchgang) · gilt für die Oberfläche in `web/` · Entwurf: Design-Fläche „BlaulichtCMS Redesign“, Richtung B

Das Design ist **sachlich, ruhig und schnell lesbar** – auch draußen am Handy und nachts im dunklen Modus.
Signalrot ist der **einzige Akzent**: Es zeigt, was gerade wichtig ist oder worauf man drücken soll.
Alles andere bleibt neutral.

---

## 1. Grundregeln

1. **Ein Akzent.** Rot nur für Hauptaktionen, die aktive Navigation, Zähler mit Handlungsbedarf und „Du bist dran“. Nie für Dekoration.
2. **Status = Farbe + Text.** Grün (ok), Gelb (Hinweis/offen), Rot-Badge (Fehler) – immer mit Wort und Punkt, nie nur Farbe.
3. **Weich, nicht verspielt.** Abgerundete Flächen (siehe Radien), keine Verläufe, keine farbigen Seitenstreifen an Karten.
4. **Monospace für Maschinen-Werte.** IDs (`W-2026-0001`), Fassungen (`F2`), Prüfsummen, Uhrzeiten, Zähler und Abschnittslabels in IBM Plex Mono.
5. **Hell und Dunkel gleichwertig.** Jede Farbe kommt aus `tokens.css`; keine festen Hex-Werte in Komponenten.

---

## 2. Farben

Alle Werte stehen in `web/src/theme/tokens.css` und sind in Tailwind über `web/src/theme/tailwind.blaulichtcms.js` erreichbar.

| Rolle | Token | Tailwind | Hell | Dunkel |
|---|---|---|---|---|
| Akzent / Hauptaktion | `--bc-primary-solid` | `bg-primary-solid` | `#D21F3C` | `#FF5A6E` |
| Akzent Hover | `--bc-primary-hover` | `bg-primary-hover` | `#B5172F` | `#FF7584` |
| Schrift auf Akzent | `--bc-on-primary` | `text-on-primary` | `#FFFFFF` | `#0E0F12` |
| Akzent zart (Auswahl) | `--bc-primary-soft` | `bg-primary-soft` | Rot 9 % | Rot 14 % |
| Seitengrund | `--bc-bg` | `bg-bg` | `#F6F7F9` | `#0E0F12` |
| Karten, Kopfzeile | `--bc-card` | `bg-card` | `#FFFFFF` | `#16181C` |
| Erhöht (Hover, Felder) | `--bc-raised` | `bg-raised` | `#EEF0F3` | `#1F2227` |
| Linien | `--bc-border` | `border-line` | `#DDE1E6` | `#2C3037` |
| Text | `--bc-text` | `text-fg` | `#111418` | `#EEF0F3` |
| Text leise | `--bc-text-2` | `text-fg-muted` | `#4E5560` | `#A9AFB8` |
| Links | `--bc-link` | `text-fg-link` | = Text | = Text |
| Ok | `--bc-ok` | `text-ok` / `bg-ok-soft` | `#1E7443` | `#5BD48A` |
| Hinweis | `--bc-warn` | `text-warn` / `bg-warn-soft` | `#8F5200` | `#F2B84B` |
| Fehler | `--bc-err` | `text-err` / `bg-err-soft` | `#B3141F` | `#FF7A85` |
| Schalterknopf | `--bc-knob` | `bg-knob` | `#FFFFFF` | `#EEF0F3` |
| Abdunklung (Dialog, Schublade) | `--bc-scrim` | `bg-scrim` | Schwarz 48 % | Schwarz 60 % |
| Website-Banner-Vorschau | `--bc-site-*` | `bg-site-info-bg` … | fest, wie `wordpress-plugin/…/banner.css` | gleich |

**Wichtig:**

- Auf roten Flächen immer `text-on-primary` statt `text-white` verwenden. Im dunklen Modus ist die Schrift dort absichtlich dunkel – Weiß auf hellem Rot wäre zu schwach.
- Links sind in Textfarbe; beim Überfahren werden sie rot. Im Fließtext (Hilfe) sind sie unterstrichen.
- Fehler sind ebenfalls rot. Deshalb gilt: Fehler **immer** mit Symbol und Text, nie nur eingefärbt.
- `bg-primary-soft` (Rot zart) nur für **Auswahl** (gewählte Karte, Suchtreffer), nicht für aktive Navigation oder Hinweise.
- Es gibt keinen zweiten Akzent: Cyan und die alten Knotenfarben sind entfernt.

---

## 3. Schrift

| Verwendung | Schrift | Größe / Gewicht |
|---|---|---|
| Seitentitel (`PageHeader`) | IBM Plex Sans | 30 px · 600 · Laufweite −0,03 em |
| Kartentitel | IBM Plex Sans | 15 px · 600 |
| Fließtext, Bedienung | IBM Plex Sans | 14 px · 400/500 |
| Meta-Zeilen | IBM Plex Sans | 12 px · 400 · `text-fg-muted` |
| Abschnittslabel | IBM Plex Mono | 12 px · 500 · GROSS · Laufweite 0,08 em |
| IDs, Uhrzeiten, Zähler | IBM Plex Mono | 11,5–20 px · 400/500 |

Die Schriften kommen lokal über `@fontsource/ibm-plex-sans` und `@fontsource/ibm-plex-mono` (kein Google-Fonts-Abruf, datenschutzfreundlich, offline-fähig).

Abschnittslabel-Muster (z. B. im Dashboard):

```tsx
<div className="flex items-baseline justify-between pb-2.5 border-b border-fg">
  <h3 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em]">
    <span className="text-fg-muted">01 —</span> Redaktionsfluss
  </h3>
  <Link to="/beitraege" className="text-sm !text-fg-muted hover:!text-fg">Alle Beiträge →</Link>
</div>
```

---

## 4. Radien, Abstände, Schatten

| Token | Tailwind | Wert | Wofür |
|---|---|---|---|
| `--bc-r-chip` | `rounded-chip` | 6 px | Chips, Menüeinträge, Tastenkürzel |
| `--bc-r-control` | `rounded-control` | 10 px | Buttons, Eingabefelder, Suchfeld, Schalter |
| `--bc-r-node` | `rounded-node` | 12 px | kleine Kästen, Kacheln |
| `--bc-r-card` | `rounded-card` | 14 px | Karten, Board-Karten |
| – | `rounded-full` | Pille | Status-Badges, Zähler, Avatar |

- Abstände im Raster von 4 px; zwischen Karten 12–20 px, Seitenrand 32 px (Handy 16 px).
- Schatten nur für schwebende Elemente (`shadow-float`) und als Fokus-/Auswahlring (`shadow-ring`, `shadow-selected`).
- Touch-Ziele mindestens 40 px, am Handy für Hauptaktionen 56–64 px.

---

## 5. Aufbau der Oberfläche

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [BC] BlaulichtCMS / Org  Übersicht  Redaktion①  Kanäle  Warnung  Verwaltung │  Kopfzeile (56 px)
│                                          [Suchen  Strg K] [☀|☾] [🔔] (AA) │
├───────────────────────────────────────────────────────────────────────────┤
│  ▣ Beiträge   ☑ Freigaben ①   ▢ Medien   ▢ Quellen   ▢ Vorlagen           │  Unternavigation (48 px)
├───────────────────────────────────────────────────────────────────────────┤
│ BLAULICHTCMS / REDAKTION / BEITRÄGE          ● DIENSTE alle laufen  ● LIVE │  Statuszeile (Mono)
├───────────────────────────────────────────────────────────────────────────┤
│  Seitentitel                                         [Sekundär] [Primär]  │
│  …                                                                        │
```

- **Kopfzeile:** Bereiche (Navigationsgruppen aus `config/navigation.ts`) als Reiter. Der aktive Bereich hat eine 2 px rote Unterstreichung. Freigaben zählen als rotes Badge am Bereich.
- **Unternavigation:** die Seiten des aktiven Bereichs als Pillen; aktiv = `bg-raised` + rotes Symbol.
- **Statuszeile:** Brotkrumen (enthält das `<h1>` der Seite) links, Betriebszustand rechts.
- **Handy (< 768 px):** Menü-Button öffnet die Schublade mit allen Bereichen; Suche als Symbol.
- **Farbmodus:** Der Sonne/Mond-Schalter speichert `preferences.theme` im Profil – dieselbe Einstellung wie unter „Mein Konto“.

Neue Module tragen sich weiterhin nur in `config/navigation.ts` ein – Kopfzeile, Unternavigation und Schublade folgen automatisch.

---

## 6. Komponenten

| Komponente | Regel |
|---|---|
| `Button variant="primary"` | Rot gefüllt, `text-on-primary`. **Höchstens eine** Hauptaktion pro Bereich. |
| `Button` (secondary) | Kartenfarbe mit Linie. Für alles Weitere. |
| `Button variant="danger"` | Zart rot mit Rand; nur für Löschen/Widerrufen, immer mit Bestätigung. |
| `Badge` / `StatusBadge` | Pille mit Punkt + Text. Töne: success, warning, error, neutral, primary. `primary` nur für laufende Vorgänge (wird veröffentlicht, wird versendet, geplant), nicht für Kennzeichnungen wie „Dieses Gerät“. |
| `Chip mono` | Für IDs und Kürzel (`F-WALD-2`). |
| `Rev` | Fassungsnummer als `F2` in Mono, ausgeschrieben im Tooltip. In ganzen Sätzen bleibt „Fassung 2“. |
| `Notice` | Standard `info` ist neutral (`bg-raised`). Gelb/Rot/Grün nur für Warnung, Fehler, Erfolg. |
| `Avatar` | Neutral. `strong` (dunkel gefüllt) nur für das eigene Konto in der Kopfzeile. |
| Aktive Navigation | Reiter: rote 2-px-Linie. Unternavigation, Schublade, Einstellungs- und Hilfe-Navigation: `bg-raised` + fett + rotes Symbol. |
| `Card` | `rounded-card`, Linie, kein Schatten. Titel 15 px, Aktion rechts als leiser Link „… →“. |
| Board-Karte (`FlowCard`) | Wie Card, kompakt. „Du bist dran“: roter Rand + `shadow-selected` + Mono-Label + roter Button. |
| Leere Zustände | Ein Satz, leise. Keine großen Illustrationen. |

---

## 7. Dashboard: Redaktionsfluss

Das Widget „Redaktionsfluss“ (früher „Kennzahlen“, Widget-ID weiterhin `media`) zeigt den Weg eines Beitrags als Spalten:

**Eingang → Sichtung → Freigabe → Bereit → Veröffentlicht**

- Jede Spalte zeigt eine große Mono-Zahl und bis zu drei Karten, danach „+ n weitere“.
- Wer freigeben darf, sieht offene Freigaben als „Du bist dran“-Karte mit „Prüfen →“.
- Die Daten kommen aus `GET /dashboard`.
- Die Spalten des Redaktionsflusses brechen um, wenn die Dashboard-Spalte schmal ist (kein waagerechtes Scrollen).

### Aufbau und Anpassen (seit 0.2.4)

- **Kennzahlen** oben als eigene Reihe: Karte mit `rounded-node`, Beschriftung in `text-meta`, Zahl in Mono 22 px. Rot (`text-primary`) nur bei Handlungsbedarf für die Person; Fehler (`text-err`) immer mit Symbol und Text.
- Darunter bis zu vier **Spalten** mit Gewicht 2 / 3 / 5 (Schmal / Normal / Breit). Unter 300 px Spaltenbreite brechen die Spalten um; am Handy gilt die eigene Reihenfolge.
- **Bearbeitungsmodus:** Spalten auf `bg-raised` mit Linie, Kacheln und Kennzahlen mit gestricheltem Rand. Gezogen wird nur am **Griff** (`GripVertical`, 40 × 40 px, `aria-label` „… verschieben“) – mit Maus, Finger und Tastatur (`@dnd-kit`). Während des Ziehens folgt eine kleine Karte mit rotem Rand und `shadow-float` dem Zeiger; die Kachel selbst bleibt abgeblendet an ihrem Platz.
- Bedienelemente im Bearbeitungsmodus sind mindestens 40 px hoch (Touch-Ziele). „Für mich speichern“ ist die einzige rote Aktion.
- Welche Widgets es gibt und welches Recht sie brauchen, steht nur in `server/src/lib/dashboard-layout.ts`.

Die Begrüßung richtet sich nach der Tageszeit („Guten Abend, Alex.“), darunter eine Zeile, was gerade wartet.

---

## 8. Was umgesetzt ist

| Datei | Änderung |
|---|---|
| `web/src/theme/tokens.css` | Neue Farben Hell/Dunkel, Radien, Schrift, `--bc-on-primary`, `--bc-primary-hover`; dunkle Seitenleiste entfernt |
| `web/src/theme/tailwind.blaulichtcms.js` | Radien 6/10/12/14 px, IBM Plex, Farben `on-primary` und `primary.hover`, Seitentitel 30 px |
| `web/src/main.tsx`, `web/package.json` | Geist → IBM Plex Sans/Mono (`@fontsource`) |
| `web/src/components/layout/AppShell.tsx` | Navigation oben + Unternavigation + Statuszeile + Hell/Dunkel-Schalter; Schublade am Handy |
| `web/src/components/ui/core.tsx` | Hauptbutton mit `text-on-primary`, neutraler Avatar, größerer Seitentitel |
| `web/src/components/ui/Icon.tsx` | Symbole `Sun`, `Moon` |
| `web/src/pages/Dashboard.tsx` | Redaktionsfluss-Board, Begrüßung, Zusammenfassung |
| `web/src/index.css`, `web/index.html`, `web/public/favicon.svg` | Auswahl- und Linkfarben, Theme-Farbe je Modus, Favicon-Rot |

Server, API, Datenbank und WordPress-Plugin sind **nicht** verändert.

**Zweiter Durchgang (14.11.2026, alle Seiten im Browser geprüft, Hell/Dunkel, Desktop/Handy):**

| Bereich | Änderung |
|---|---|
| Tokens | `--bc-knob`, `--bc-scrim`, `--bc-site-*` neu; Cyan, Knotenfarben, React-Flow- und Raster-Reste entfernt |
| Basiskomponenten | `Notice` neutral, `Avatar` neutral, `Rev` neu, `Badge` ohne Cyan, `Monogram`/`VariableChip` entfernt, KPI-Werte in Mono |
| Navigation | Aktive Punkte überall `bg-raised` statt Rot zart; Brotkrumen am Handy nur mit Seitentitel; Detailseiten zeigen „Bereich / Seite / Titel“ |
| Seiten | Kürzel als `Chip mono`, Fassungen als `Rev`, Hinweise neutral, Darstellungs-Vorschau im Leitstand-Aufbau, Sichtung im Redaktionsfluss als „Du bist dran“ |
| Farbmodus | Kein Aufblitzen beim Laden; ohne Anmeldung (Login, Upload-Seite) gilt die Geräteeinstellung |
| Fehler | Fehlende Texte in Einstellungen und 53 unübersetzte Aktionen im Aktivitätsprotokoll ergänzt, Filter „Warnentwürfe“ |

---

## 9. Inbetriebnahme

```bash
npm install                 # holt @fontsource/ibm-plex-sans und -mono, aktualisiert package-lock.json
npm run typecheck -w web
npm run dev:web             # Oberfläche mit Hot Reload
```

`npm install` ist einmal nötig, weil sich die Schrift-Pakete geändert haben – sonst schlägt `npm ci` im Docker-Build fehl.

**Prüfliste nach dem Start** (am 14.11.2026 mit Demodaten durchlaufen, 27 Seiten per Browser-Screenshot, keine Konsolenfehler)

- [x] Kopfzeile: alle Bereiche sichtbar, die man sehen darf; Unternavigation wechselt mit dem Bereich
- [x] Handy-Breite: Menü-Button öffnet die Schublade, alle Seiten erreichbar
- [x] Hell/Dunkel-Schalter wechselt sofort und bleibt nach Neuladen erhalten
- [x] Dashboard: Redaktionsfluss zeigt echte Zahlen; „Anpassen“ funktioniert
- [x] Rote Buttons im dunklen Modus: dunkle Schrift, gut lesbar
- [x] Seiten mit eigenen festen Farben (Druckansicht, Upload-Seite) angesehen – siehe Ausnahmen

---

## 10. Weitere Seiten im gleichen Stil

Bei neuen oder überarbeiteten Seiten:

1. `PageHeader` mit Titel, einer Zeile Unterzeile und rechts maximal eine rote Hauptaktion.
2. Inhalte in `Card`s oder als Abschnitt mit Mono-Label (Muster oben).
3. IDs/Zeiten/Prüfsummen in `font-mono`.
4. Keine neuen Farben – nur Tokens. Wenn etwas fehlt: Token ergänzen (Hell **und** Dunkel), nicht im Bauteil festschreiben.
5. Fester Hex-Wert oder `text-white` in einer Komponente? → durch Token ersetzen.

## 10a. Automationen-Editor

- Fläche mit React Flow; alle Farben über `web/src/pages/automations/flow.css`, das die `--xy-*`-Variablen auf Tokens
  legt (Hell/Dunkel ohne eigene Werte). Raster: `--bc-flow-grid`.
- Knoten = kleine Karte (`rounded-node`, Linie, kein Schatten), oben Mono-Label der Kategorie **EINGANG /
  VERARBEITUNG / AUSGANG** mit Symbolfläche. Kategorie-Tokens `--bc-flow-input(-soft)` und `--bc-flow-output(-soft)`
  (gedecktes Blau bzw. Violett, Hell und Dunkel) färben **nur** die Symbolfläche – die Kategorie steht immer auch als
  Text da. Verarbeitung bleibt neutral (`bg-raised`). Kein farbiger Seitenstreifen.
- Gewählt: roter Rahmen + `shadow-selected`; Fehler: Rahmen `border-err` **und** „n Fehler“ mit Symbol; Direktversand:
  Badge „Direkt“ (Gelb, mit Text). Ports tragen Beschriftungen („trifft zu“, „freigegeben“ …), Verbindungen sind
  geschwungen mit Pfeil, Beschriftung in Mono.
- Werkzeugleiste oben links (Ansicht zurücksetzen, Einpassen, Automatisch anordnen, Auswahl fokussieren, Rückgängig,
  Wiederholen, Löschen), Zoom unten links, Übersichtskarte unten rechts. Die Listenansicht ist die gleichwertige
  Bedienung ohne Maus und am Handy.

## 11. Bewusste Ausnahmen

Diese Stellen behalten feste Farben, weil sie unabhängig vom Farbmodus gleich aussehen müssen:

| Stelle | Grund |
|---|---|
| QR-Codes (`share.tsx`, 2FA-Einrichtung) | Weißer Grund, sonst scannen viele Kameras nicht zuverlässig |
| Overlays auf Fotos/Videos (`CollectionDetail.tsx`) | Dunkle Plakette über beliebigen Bildinhalten, Video-Rahmen schwarz |
| A4-Aushang (`PrintSheet.tsx`) und Druck der Hilfe | Schwarz auf Weiß für jeden Drucker |
| Darstellungs-Vorschau (`admin/shared.tsx`) | Zeigt die Farbmodi selbst; Werte = `tokens.css` |
| Website-Banner-Vorschau | Zeigt das Aussehen auf der Website; Werte = Bridge-Stylesheet, als `--bc-site-*` hinterlegt |
