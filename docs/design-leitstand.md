# Design „Leitstand“ – Anleitung

Stand: 14.11.2026 (zweiter Durchgang) · gilt für die Oberfläche in `web/` · Entwurf: Design-Fläche „BlaulichtCMS Redesign“, Richtung B

Das Design ist **sachlich, ruhig und schnell lesbar** – auch draußen am Handy und nachts im dunklen Modus.
Signalrot ist der **einzige Akzent**: Es zeigt, was gerade wichtig ist oder worauf man drücken soll.
Alles andere bleibt neutral.

---

## 1. Grundregeln

1. **Ein Akzent.** Rot nur für Hauptaktionen, die aktive Navigation, Zähler mit Handlungsbedarf und „Du bist dran“. Nie für Dekoration, Auswahl, Schrittanzeigen oder Kennzeichnungen. Der Unit-Test `server/test/design-accent.test.ts` meldet rot gefüllte Umschalter und Auswahl, rote Flächen außerhalb weniger erlaubter Stellen und den Badge-Ton `primary` für alles, was kein laufender Vorgang ist.
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
- Touch-Ziele mindestens 40 px, am Handy für Hauptaktionen 48–64 px. Unter 768 px sind die Höhen `h-ctl-sm`, `h-ctl`
  und `h-field` 40 px (Variablen `--bc-h-*` in `tokens.css`); Reiter, Segmente, Symbolknöpfe, Hilfe-„?“, Menüeinträge,
  Kästchen in Medienkacheln und Dialog-Schließen wachsen dort ebenfalls auf 40 px. Achtung: Die Schrift-Basis ist 14 px,
  `h-10` ist also nur 35 px – für Touch-Ziele `h-tap`/`w-tap`/`min-h-tap` (40 px, meist als `max-md:h-tap`) verwenden.
  Textlinks in Listen und Kacheln bekommen mit `bc-tap-y` am Handy eine 40 px hohe Trefferfläche, ohne das Layout zu
  verschieben. Inline-Links im Fließtext sind ausgenommen (WCAG 2.5.8). `test/e2e/mobile-ux.mjs` misst die
  Trefferflächen bei 390 px auf Dashboard, Beiträgen, Sammlung, Presse, Kalender, Einsatzliste und Warnentwurf.

---

## 5. Aufbau der Oberfläche

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [BC] BlaulichtCMS / Org  Übersicht①  Redaktion  Presse  Warnungen  Einrichtung  Verwaltung │  Kopfzeile (56 px)
│                                             [Suchen  Strg K] [?] [☀|☾] [🔔] (AA)          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  ▣ Beiträge   ▢ Medien   ▢ Kalender   ▢ Einsatzliste   ▢ Banner   ▢ Designvorlagen …       │  Unternavigation (48 px)
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ BLAULICHTCMS / REDAKTION / BEITRÄGE                         ● DIENSTE alle laufen  ● LIVE │  Statuszeile (Mono)
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Beiträge (?)                                                     [Sekundär] [Primär]     │  Seitenkopf: h1 + Hilfe
│  …                                                                                       │
```

### Gliederung (verbindlich seit #250)

Die Bereiche folgen den Aufgaben, nicht der Technik: tägliche Arbeit zuerst, Einrichtung und Betrieb getrennt und nur
mit passenden Rechten sichtbar. Höchstens **6 Bereiche** mit je höchstens **7 Punkten**.

| Bereich | Punkte (Adresse) | Zweck |
|---|---|---|
| Übersicht | Dashboard (`/`), Freigaben (`/freigaben`), Benachrichtigungen, Reichweite, Aktivitäten | Was ansteht, was passiert ist |
| Redaktion | Beiträge, Medien (Reiter Sammlungen · Alle Dateien · Papierkorb), Kalender, Einsatzliste, Banner, Designvorlagen, Quellen | Inhalte erstellen |
| Presse | Presseanfragen (`/presse`), Pressemitteilungen, Presseverteiler, Textbausteine (`/presse/textbausteine`) | Pressearbeit |
| Warnungen | Warnentwürfe (`/warnungen`), Amtliche Warnungen | Warnen und Warnlage |
| Einrichtung | Verbindungen (mit Unterseite Websites `/verbindungen/websites`), Workflows (Reiter Workflows · Auslöser · Aktionen), Beitragsvorlagen (`/beitragsvorlagen`), Stichwörter & Regeln (`/stichwoerter-regeln`), Presse-Postfach (`/presse-postfach`), Upload-Seite (`/upload-seite`) | Einmal einrichten, selten ändern |
| Verwaltung | Benutzer und Rollen, Systemstatus, Medienverwaltung (`/medienverwaltung`), Protokolle, Datenschutzanfragen, Einstellungen | Betrieb, Rechte, Datenschutz |

- **Registry:** Neue Module tragen sich nur in `web/src/config/navigation.ts` ein (Bereich, Adresse, Recht, Symbol,
  Hilfe-Kapitel) – Kopfzeile, Unternavigation, Schublade, Befehlspalette, Brotkrumen, Fenstertitel und das „?“ folgen
  automatisch. Eine Seite gehört in den Bereich, in dem man sie für die Aufgabe sucht; Konfiguration gehört nach
  Einrichtung, Betrieb nach Verwaltung.
- **Keine dritte Menüebene:** Bausteine einer Seite sind Reiter mit eigener Adresse (`PageTabs`, z. B. Medien,
  Workflows) oder Reiter in der Seite (`Tabs`), keine eigenen Menüpunkte.
- **Einstellungen (#256):** `/einstellungen` ist die Übersicht der Bereiche (am Handy die Liste), jeder Bereich eine
  Unterseite `/einstellungen/<bereich>` mit linker Einstellungs-Navigation – Registry `config/settingsPages.ts`
  (Bezeichnung, Hilfe, Rechte), Suchbegriffe in `config/settingsIndex.ts` (Ziel Unterseite bzw. Feld `#s-<schlüssel>`).
  Jede Unterseite hat genau eine Speichern-Leiste (`SaveScope`); neue Einstellungen kommen auf die passende Unterseite,
  persönliche Einstellungen nach Mein Konto.
- **Bezeichnung = Titel:** Menübezeichnung, Seitentitel (`PageHeader` ohne `title` übernimmt sie), letzter Brotkrumen
  und Fenstertitel sind gleich. Unter- und Detailseiten setzen ihren Titel mit `usePageMeta({ title })`; Seiten ohne
  Menüpunkt ordnen sich mit `usePageMeta({ navId })` einem Bereich zu (Freigabe-Ansicht → Übersicht/Freigaben).
- **Adressen sprechen** und bleiben gültig: frühere Adressen stehen in `LEGACY_PATHS` (`navigation.ts`) und leiten samt
  Unterpfad, Suche und Anker weiter (z. B. `/kanaele` und `/websites` → `/verbindungen/websites`, `/warnungen/pflege` → `/stichwoerter-regeln`).
  `/einrichtung` bleibt die Ersteinrichtung.
- **Hinweise auf Menüpfade** („unter Einrichtung → Verbindungen“) nutzen `navTrail(id)` aus `config/navText.ts` bzw. in der
  Hilfe die tatsächlichen Bezeichnungen; `server/test/navigation.test.ts` prüft die Hilfe-Links.

### Bestandteile

- **Kopfzeile:** Bereiche als Reiter; der aktive Bereich hat eine 2 px rote Unterstreichung. Freigaben zählen als rotes
  Badge am Bereich – über alle Arten, die die Person entscheiden darf (ohne Vier-Augen-Sperre), plus Freigegebenes, das
  sie veröffentlichen darf (`GET /approvals/pending`, #251). Rechts Suche (`Strg K`), **Hilfe** (`?`, öffnet das Kapitel der aktuellen Seite), Farbmodus,
  Benachrichtigungen, Konto.
- **Unternavigation:** die Seiten des aktiven Bereichs als Pillen; aktiv = `bg-raised` + rotes Symbol.
- **Suche (`Strg K`, `CommandPalette`):** Seiten und Aktionen (aus der Navigation), Inhalte vom Server (`GET /search`,
  `server/src/routes/search.ts`: je Bereich nur mit Leserecht, höchstens fünf, „Alle Treffer in …“ über `?suche=` der
  Liste), Einstellungen (`config/settingsIndex.ts`) und Hilfe (Volltext, erst beim Suchen geladen). Neue Module mit
  Inhalten tragen sich in `SOURCES` ein, neue Einstellungen in den Index.
- **Statuszeile:** Brotkrumen als reine Navigation (`<ol>`, letzter Eintrag `aria-current="page"`) links,
  Betriebszustand rechts.
- **Seitenkopf (`PageHeader`):** die einzige `<h1>` der Seite, rechts daneben das „?“ mit Kurzbeschreibung und Link ins
  Hilfe-Kapitel (aus `help` des Menüpunkts; `PageHeader help="kapitel#anker"` für einen anderen Abschnitt). Darunter
  folgen Abschnitte mit `<h2>` (`Card`) – keine Ebene überspringen.
- **Fenstertitel:** „Seite – Bereich · Organisation“, Detailseiten „Objekt – Menüpunkt · Organisation“.
- **Handy (< 768 px):** untere Leiste `MobileTabBar` (#264) statt Menü-Knopf in der Kopfzeile; Suche, Hilfe,
  Benachrichtigungen und Konto bleiben als Symbole oben.

  ```
  ┌──────────┬──────────┬──────────┬──────────┬──────────┐
  │ Übersicht│ Beiträge │    ＋    │Freigaben③│   Mehr   │
  │    ▣     │    ▤     │ Aktionen │    ☑     │    ☰     │
  └──────────┴──────────┴──────────┴──────────┴──────────┘
  ```

  - Drei Ziele aus `MOBILE_TABS` (`config/navigation.ts`) in dieser Reihenfolge, nur mit Recht; fehlt eines, rückt das
    nächste nach (z. B. Presse statt Beiträge). Aktiv = fett + rotes Symbol; Freigaben mit rotem Zähler.
  - **＋ Aktionen** öffnet die Schnellaktionen (`QUICK_ACTIONS`, je nach Recht): Fotos sammeln (Sammlung mit Upload-Link
    und QR-Code), Sichten (Sammlungen mit offenen Dateien, ein Tipp öffnet die Sichtung über `/medien/<id>?sichten=1`),
    Neuer Beitrag, Neue Erstmeldung, Anfrage erfassen – jede Kernaufgabe mit höchstens zwei Tipps von jeder Seite aus.
  - **Mehr** öffnet die Schublade mit allen Bereichen und Seiten (Gliederung wie oben).
  - Die Leiste ist 60 px hoch (+ sicherer Bereich unten) und tritt zurück, solange ein Textfeld bearbeitet wird. Feste
    oder klebende Elemente unten (Speicherleisten, Entscheidungsleiste, Hinweise) rechnen mit `var(--bc-bottom-bar)`
    (am Desktop 0).
- **Farbmodus:** Der Sonne/Mond-Schalter speichert `preferences.theme` im Profil – dieselbe Einstellung wie unter „Mein Konto“.

---

## 6. Komponenten

| Komponente | Regel |
|---|---|
| `Button variant="primary"` | Rot gefüllt, `text-on-primary`. **Höchstens eine** Hauptaktion pro Bereich. |
| `Button` (secondary) | Kartenfarbe mit Linie. Für alles Weitere. |
| `Button variant="danger"` | Zart rot mit Rand; nur für Löschen/Widerrufen, immer mit Bestätigung. |
| `Badge` / `StatusBadge` | Pille mit Punkt + Text. Töne: success, warning, error, neutral, primary. `primary` nur für laufende Vorgänge (wird veröffentlicht, wird versendet, geplant), nicht für Kennzeichnungen wie „Dieses Gerät“. |
| `Chip mono` | Für IDs und Kürzel (`F-WALD-2`). |
| `MetaLine` / `joinMeta` | Angaben mit Trennpunkt „·“ im Seiten- und Kartenkopf (#273): `<MetaLine lead={<StatusBadge …/>}>Art<Rev n={2} />Gespeichert 14:32</MetaLine>`. Der Trennpunkt steht vor jeder Angabe und wird am Zeilenanfang abgeschnitten – am Handy beginnt keine Zeile mit „·“. Für reinen Text (`Card subtitle`) `joinMeta([a, b])`: geschütztes Leerzeichen vor „·“. Nie „ · “ als Text in `PageHeader` oder `Card subtitle` (`server/test/navigation.test.ts`). |
| `Popover` (`HelpTip`, `Menu`) | Aufklappfenster liegen über Dialogen – auch das „?“ in einem Dialog zeigt seine Erklärung vorn. Ebenen: Schublade am Handy `z-[80]` → `Dialog` `z-[90]` → `Popover` `z-[92]` → Suche `z-[95]` → Meldungen `z-[100]`. |
| Auswahl (gewählte Karte, Antwort, Datei) | `bg-primary-soft` + `border-primary` (gern mit `shadow-selected` und Haken) – nie rot gefüllt. |
| `ToggleButton` | Umschaltknopf an/aus (z. B. Hinweise zur Datei): an = Auswahl-Muster mit Haken, aus = sekundär. |
| Ansichtsschalter | `SegmentedControl` (aktiv `bg-raised`), auch für reine Symbole (Kacheln/Liste). |
| Schrittleiste (Warnentwurf, Verbindung, geführter Workflow) | Nummern neutral (`bg-raised`), aktiver Schritt `bg-raised` + fett + rot umrandete Nummer; erledigt grün mit Haken. |
| `FilePickButton` | Dateiauswahl als Knopf mit Dateiname/Vorschau und „Entfernen“ – nie das native Dateifeld zeigen; `id` für `FieldWrap htmlFor`. |
| `Rev` | Fassungsnummer als `F2` in Mono, ausgeschrieben im Tooltip. In ganzen Sätzen bleibt „Fassung 2“. Nie neben Einsatzstichwörtern (Einsatzliste): dort „Fassung 2“, weil `F1` wie das Stichwort „F 1“ gelesen wird. |
| `Notice` | Standard `info` ist neutral (`bg-raised`). Gelb/Rot/Grün nur für Warnung, Fehler, Erfolg. |
| `Avatar` | Neutral. `strong` (dunkel gefüllt) nur für das eigene Konto in der Kopfzeile. |
| Aktive Navigation | Reiter: rote 2-px-Linie. Unternavigation, Schublade, Einstellungs- und Hilfe-Navigation: `bg-raised` + fett + rotes Symbol. |
| `Card` | `rounded-card`, Linie, kein Schatten. Titel 15 px, Aktion rechts als leiser Link „… →“. |
| Board-Karte (`FlowCard`) | Wie Card, kompakt. „Du bist dran“: roter Rand + `shadow-selected` + Mono-Label + roter Button. |
| Leere Zustände | Ein Satz, leise. Keine großen Illustrationen. Regeln siehe unten (#266). |
| `ListToolbar` | Werkzeugleiste **jeder** Listenseite (#260): Suche links (`Suchen in …`), Reiter (`ListTabs`), Knopf „Filter“ (weitere Kriterien; gesetzte als Chips mit ×), „Zurücksetzen“, Trefferzahl rechts. Zustand in der Adresse über `useListState` (`lib/listState.ts`): Suche heißt immer `suche`, Reiter und Filter haben sprechende Namen (`?status=veroeffentlicht&art=news`); Werte gleich dem Standard stehen nicht in der Adresse, Änderungen ersetzen den Verlaufseintrag. So stellen Zurück, Lesezeichen und Links aus Benachrichtigungen/Suche die Liste wieder her. Am Handy werden mehr als drei Reiter zum Auswahlfeld. |
| `ResponsiveTable` | Tabelle ab 768 px, darunter Karten (#264). Spalten mit `cell` (Inhalt) und `card` (Rolle in der Karte: `title` – der erste Link darin macht die ganze Karte antippbar –, `status`, `meta`, `field`, `footer`, `hide`). Alle Kernangaben stehen in der Karte, nichts scrollt waagerecht. `from: 'lg'` blendet Nebenspalten am schmalen Laptop aus. |
| `FieldWrap required` | Rotes Sternchen (für Hilfsmittel verborgen) und über den Feldkontext `aria-required` am Feld; `error`/`help` werden per `aria-describedby` vorgelesen, `error` setzt `aria-invalid`. `htmlFor` muss auf ein `Input`/`Textarea`/`Select` zeigen (eigene Bausteine: `useFieldA11y`). Dialoge und `RequiredScope` zeigen dann die Legende „* Pflichtfeld“ (#268, `server/test/forms.test.ts`). |
| Prüfen statt sperren (`useFormCheck`, `FormProblems`) | „Speichern“/„Anlegen“ bleibt bedienbar. Beim Klick mit fehlenden Angaben: Meldung am Feld („Bitte einen Titel angeben.“), Zusammenfassung oben (`role="alert"`), Fokus ins erste Feld. Gesperrt nur während des Speicherns oder mit sichtbarem Grund daneben. |
| `SaveBar` / `SaveScope` | Eine Speichern-Leiste für lange Formulare: schwebt unten im Inhalt, sobald es Änderungen gibt („Ungespeicherte Änderungen · Verwerfen · Speichern“), warnt beim Verlassen; ohne Änderungen nur leise „Gespeichert 23:14“. Mehrere Abschnitte einer Seite melden sich mit `useSaveSource` an einer `SaveScope` an – eine Leiste, ein Speichermodell. Kein blasser roter Knopf als Zustandsanzeige. |

**Leere Zustände (#266)**

| Variante | Wo | Aussehen |
|---|---|---|
| `EmptyLine` | in Kacheln (Dashboard), Karten, Seitenleisten, Tabellen- und Abschnittsbereichen | eine Zeile `text-sm text-fg-muted`, dahinter optional die nächste Aktion als `EmptyAction` („Noch keine Website gekoppelt. Website koppeln →“) |
| `EmptyState` | nur seitenweit: die ganze Liste ist leer, erste Nutzung | Symbol, Titel als Absatz (nie als Überschrift), ein Satz; Hauptaktion, wenn die Person sie ausführen darf, sonst im Satz, wer es kann |
| `FilterEmpty` | gefilterte Liste ohne Treffer | „Kein Eintrag passt zum Filter.“ + „Filter zurücksetzen“ – überall gleich |

- Text = Zustand + ggf. Aktion: „Keine offenen Freigaben.“, „Nichts zu sichten.“; „Noch …“ nur, wenn etwas erwartet wird
  („Noch keine Website gekoppelt.“). Keine Überschriften, keine Ausrufezeichen.
- Die Aktion erscheint nur mit dem passenden Recht (`can(…)`); ohne Recht entfällt sie oder der Satz nennt, wer es kann.
- Eine leere Dashboard-Kachel schrumpft auf Kopf + eine Zeile.

---

## 7. Dashboard: Redaktionsfluss

Das Widget „Redaktionsfluss“ (früher „Kennzahlen“, Widget-ID weiterhin `media`) zeigt den Weg eines Beitrags als Spalten:

**Eingang → Sichtung → Freigabe → Bereit → Veröffentlicht**

- Jede Spalte zeigt eine große Mono-Zahl und bis zu drei Karten, danach „+ n weitere“.
- Wer freigeben darf, sieht offene Freigaben aller Arten (Beitrag, Banner, Einsatzliste, Warnentwurf, Presseantwort,
  Workflow) als „Du bist dran“-Karte mit „Prüfen →“; vom Vier-Augen-Prinzip gesperrte ohne roten Rand mit Grund.
- Die Daten kommen aus `GET /dashboard` (`approvals` = dieselbe Sammlung wie die Seite Freigaben, `server/src/approvals/pending.ts`).
- Die Spalten des Redaktionsflusses brechen um, wenn die Dashboard-Spalte schmal ist (kein waagerechtes Scrollen).

### Aufbau und Anpassen (seit 0.2.4)

- **Kennzahlen** oben als eigene Reihe: Karte mit `rounded-node`, Beschriftung in `text-meta`, Zahl in Mono 22 px. Rot (`text-primary`) nur bei Handlungsbedarf für die Person; Fehler (`text-err`) immer mit Symbol und Text.
- Darunter bis zu vier **Spalten** mit Gewicht 2 / 3 / 5 (Schmal / Normal / Breit). Unter 300 px Spaltenbreite brechen die Spalten um; am Handy gilt die eigene Reihenfolge.
- **Bearbeitungsmodus:** Spalten auf `bg-raised` mit Linie, Kacheln und Kennzahlen mit gestricheltem Rand. Gezogen wird nur am **Griff** (`GripVertical`, 40 × 40 px, `aria-label` „… verschieben“) – mit Maus, Finger und Tastatur (`@dnd-kit`). Während des Ziehens folgt eine kleine Karte mit rotem Rand und `shadow-float` dem Zeiger; die Kachel selbst bleibt abgeblendet an ihrem Platz.
- Bedienelemente im Bearbeitungsmodus sind mindestens 40 px hoch (Touch-Ziele). „Für mich speichern“ ist die einzige rote Aktion.
- Welche Widgets es gibt und welches Recht sie brauchen, steht nur in `server/src/lib/dashboard-layout.ts`.

### Standardansicht je Rolle (seit #254)

- Reihenfolge: persönliches Layout → Dashboard-Vorlage der ersten Rolle mit Vorlage → Dashboard-Vorlage für alle →
  **mitgelieferte Standardansicht** der ersten passenden Rolle (`ROLE_DEFAULT_LAYOUTS`; eigene Rollen nach ihren Rechten,
  `profileFor`, Profil `press` für Presse-Rechte ohne Redaktion). „Standard wiederherstellen“ löscht nur das persönliche Layout.
- **Jeder Sachverhalt höchstens einmal:** Redaktionsfluss *oder* Einzelkacheln (Freigaben, Bereit, Uploads,
  Veröffentlichungen); eine Kennzahl nur, wenn ihr Thema keine eigene Kachel hat. Jede Kachel nennt ihre Anzahl selbst
  (`Card`-Untertitel). `units.test.ts` prüft das für alle Standardansichten (Desktop und Handy).
- **Nicht genutzte Module** (Widget-Feld `module`: Website, Quellen, Kalender, Presse, Warnungen, Einsatzliste, Workflows,
  Verbindungen, soziale Netzwerke) fehlen in der Standardansicht, bis es dort etwas gibt; bliebe keine Kachel übrig,
  gilt die Ansicht ohne diesen Filter. Gespeicherte Layouts und Vorlagen bleiben unverändert.
- Unterüberschriften in einer Kachel sind `h3` (Kachel-Titel `h2`, Seitentitel `h1`, #267).
- **Checkliste „BlaulichtCMS startklar“** (#255, Kachel `setup`, Recht `settings.general`): Zeile = Status-Symbol
  (erledigt `CircleCheck` grün, offen `CircleDashed`, Pflicht rot) + Titel + neutrales Badge „Pflicht/empfohlen/optional“
  + eine Zeile Erklärung + Link „Bereich → Seite →“ (aus Menü bzw. Einstellungs-Index, `whereOf`) + „×“ zum Ausblenden
  (40 px). Stand kommt von `GET /setup/checklist`, nicht aus `GET /dashboard`.
- **Begrüßung neuer Konten** (#255): einmalige `Card` über den Kennzahlen mit drei nummerierten Schritten der Rolle,
  Links „Hilfe“, „App installieren“, „Push einschalten“ und „Verstanden“ (sekundär – die Hauptaktion der Seite bleibt
  „Neuer Beitrag“). Nicht für die Administration (sie hat die Checkliste).

Die Begrüßung richtet sich nach der Tageszeit („Guten Abend, Alex.“), darunter eine Zeile, was gerade wartet – nur
Vorgänge, die die Person selbst erledigen darf (Freigaberecht, Sichtungsrecht, eigene Presseanfragen).

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
- Knoten = kleine Karte (`rounded-node`, Linie, kein Schatten), oben Mono-Label der Kategorie **AUSLÖSER /
  VERARBEITUNG / AKTION** mit Symbolfläche. Kategorie-Tokens `--bc-flow-input(-soft)` und `--bc-flow-output(-soft)`
  (gedecktes Blau bzw. Violett, Hell und Dunkel) färben **nur** die Symbolfläche – die Kategorie steht immer auch als
  Text da. Verarbeitung bleibt neutral (`bg-raised`). Kein farbiger Seitenstreifen.
- Gewählt: roter Rahmen + `shadow-selected`; Fehler: Rahmen `border-err` **und** „n Fehler“ mit Symbol; Direktversand:
  Badge „Direkt“ (Gelb, mit Text). Zweige (Anschlüsse) tragen Beschriftungen („trifft zu“, „freigegeben“ …), Verbindungen sind
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

## 12. Begriffe (verbindlich)

Ein Wort hat in BlaulichtCMS genau eine Bedeutung (#257). Oberfläche, Hilfe, Benachrichtigungen, Rechte-Katalog und
Dokumentation halten sich daran; für Nutzende steht dieselbe Liste in der Hilfe unter „Begriffe“
(`web/src/pages/help/content/begriffe.md`). `server/test/navigation.test.ts` meldet die verbotenen Schreibweisen.

| Begriff | Bedeutung | Nicht verwenden |
|---|---|---|
| **Website** | über die BlaulichtCMS Bridge gekoppelte WordPress-Website; im Beitrag das Ziel „Veröffentlichen auf“ | Kanal, Zielkanal |
| **Soziale Netzwerke** | Facebook, Instagram, Threads, X, Mastodon, Bluesky, WhatsApp-Kanal (Eigenname des Dienstes) | soziale Kanäle |
| **Veröffentlichungsziele** | Website und soziale Netzwerke zusammen | Kanäle, Zielkanäle |
| **Verbindung** | Kopplung mit einem externen Dienst – eingehend (FE2, Feuersoftware Connect, amtliche Warnungen) oder zum Veröffentlichen (soziale Netzwerke); die Seite „Verbindungen“ gruppiert nach diesen Richtungen (#271). Websites haben ihre eigene Seite und stehen unter „Veröffentlichen“ mit Verweis dorthin. | Kanal |
| **Auslöser** | Workflow-Baustein, der einen Lauf startet (Alarm, Warnung, Termin, Zeitplan, Start von Hand …) | Eingang |
| **Aktion** | Workflow-Baustein, der etwas tut (Banner, Beitrag, E-Mail, Benachrichtigung …) | Ausgang |
| **Zweig** | Anschluss eines Knotens im Workflow-Editor, z. B. „trifft zu“, „freigegeben“ | Ausgang |
| **Eingang** | nur für Eingegangenes: Mail im Presse-Postfach, FE2-Eingang, Upload („Eingang“ in den Medien), „Eingang bestätigt“ beim Warnentwurf | für Workflow-Bausteine |
| **Beitragsvorlage** | Vorlage für wiederkehrende Beiträge (Einrichtung → Beitragsvorlagen) | „Vorlage“ ohne Zusatz |
| **Designvorlage** / **Bildvorlage** | Datei der internen Bibliothek (Logo, Layout, Plakat) bzw. befüllbare Designvorlage, aus der Bilder entstehen | „Vorlage“ ohne Zusatz |
| **Übergabe-Vorlage** | Vorlage für die Übergabe eines Warnentwurfs (Stichwörter & Regeln) | „Vorlage“ ohne Zusatz |
| **Workflow-Vorlage** / **Dashboard-Vorlage** | fertiger Ablauf für einen neuen Workflow bzw. Dashboard-Anordnung für alle oder eine Rolle | „Vorlage“ ohne Zusatz |
| **Textbaustein** / **Mustertext** | wiederkehrende Formulierung für Presseantworten bzw. Startpunkt für Datenschutzerklärung und KI-Anfrage | Vorlage |
| **Upload-Link** | befristeter, widerrufbarer Link zum Hochladen ohne Konto | Foto-Link |
| **Upload-Seite** | öffentliche Seite eines Upload-Links; Standard unter Einrichtung → Upload-Seite gestalten | Gestaltung |
| **Fotos sammeln** | die Aktion, die eine Sammlung samt Upload-Link anlegt (Dashboard, Beitrag, Suche) | Medien sammeln, Fotos und Videos sammeln |
| **Sammlung** | Ablage für Fotos und Videos, eigenständig oder zu einem Beitrag; unterteilt in Ordner | |
| **Fassung** | unveränderlicher Stand eines Beitrags oder Eintrags; `F2` nur über `Rev`, neben Stichwörtern ausgeschrieben („Fassung 2“) | `F1` neben einem Stichwort |
| **Stichwort** | Einsatzstichwort wie „F 1“ oder „B 2“ samt Aliasen | |
| **Einsatzmeldung** / **Einsatzentwurf** / **Einsatzliste** | Meldung aus FE2 oder Feuersoftware Connect (intern) / daraus vorgeschlagener interner Beitragsentwurf / öffentliche Liste vergangener Einsätze auf der Website | „Einsatz“ allein für eine dieser Bedeutungen |
| **Externe Kalender einlesen** / **Kalender abonnieren** | Kalender anderer Programme (iCal) lesen bzw. den eigenen Kalender als Abo-Link ausgeben | „iCal-Kalender“ als Knopf, „Abonnieren“ allein |

Weitere Regeln:

- **Mengen** mit `plural(n, 'Datei', 'Dateien')` (`web/src/lib/format.ts`, `server/src/lib/text.ts`) – keine
  Behelfsplurale wie „Datei(en)“ oder „1 Uploads“.
- **Menüpfade in Hinweisen** („unter Einrichtung → Verbindungen“) mit `navTrail(id)` bzw. in der Hilfe mit den tatsächlichen
  Menübezeichnungen (siehe §5).
- **„Kanal“** nur im Eigennamen „WhatsApp-Kanal“ und in WhatsApp-eigenen Bezeichnungen (Kanaladresse); im
  Betriebshandbuch außerdem für die Update-Quelle des Installationsskripts (`BLAULICHTCMS_UPDATE_CHANNEL`).

