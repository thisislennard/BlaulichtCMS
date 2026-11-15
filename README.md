<div align="center">

# BlaulichtCMS

**Selbst gehostetes Redaktionssystem für Öffentlichkeitsarbeit und Krisenkommunikation**

Fotos per Link vom Handy sammeln · sichten · Beiträge schreiben · Fassung freigeben · auf der Website veröffentlichen – nachvollziehbar und auf dem eigenen Server

[![CI](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/ci.yml/badge.svg)](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/ci.yml)
[![Sicherheitsprüfung](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/security.yml/badge.svg)](https://github.com/thisislennard/BlaulichtCMS/actions/workflows/security.yml)
[![Lizenz: GPL-3.0](https://img.shields.io/badge/Lizenz-GPL--3.0--or--later-blue)](LICENSE)
![Version](https://img.shields.io/badge/Version-0.2.1-D21F3C)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ein_Container-2496ED?logo=docker&logoColor=white)
![WordPress](https://img.shields.io/badge/BlaulichtCMS_Bridge-0.7.0-21759B?logo=wordpress&logoColor=white)

</div>

![Dashboard von BlaulichtCMS](docs/bilder/dashboard.webp)

> [!NOTE]
> **Version 0.2.1 – noch vor dem ersten Produktivbetrieb.** Der Funktionsumfang ist vollständig und automatisiert
> getestet; was mit echten Fremdsystemen geprüft ist und was noch nicht, steht unter
> [Teststand und Grenzen](docs/technik.md#teststand-und-grenzen). Alle Screenshots stammen aus einer Testinstanz mit fiktiven Daten.

---

## Inhalt

- [Funktionen](#funktionen)
- [Einblicke](#einblicke)
- [Schnellstart](#schnellstart)
- [Dokumentation](#dokumentation)
- [Mitmachen und Lizenz](#mitmachen-und-lizenz)

---

## Funktionen

```mermaid
flowchart LR
    H["📱 Handy<br/>Upload-Link / QR-Code"] -->|ohne Konto| Q["Quarantäne<br/>Typ- und Inhaltsprüfung"]
    Q --> S["Sichtung<br/>auswählen / überspringen"]
    S --> B["Beitrag<br/>Fassung n"]
    B -->|einreichen| F{"Freigabe<br/>genau dieser Fassung"}
    F -->|freigegeben| V["Veröffentlichung"]
    V -->|Bridge holt ab| W["🌐 WordPress"]
    V --> M["Facebook / Instagram"]
    W -->|ID + URL| L["✅ bestätigte URL<br/>in BlaulichtCMS"]
```

### Fotos und Videos sammeln

- **Foto-Link:** Mit einem Klick entsteht eine Sammlung mit befristetem, jederzeit widerrufbarem Upload-Link – als Link
  zum Teilen (auch per WhatsApp oder E-Mail), als QR-Code (PNG/SVG) oder als A4-Aushang zum Drucken. Wer hochlädt,
  braucht kein Konto.
- **Links bedienen:** Gültigkeit in Stunden, Tagen oder bis zu einem Termin; pausieren, fortsetzen, verlängern, neu
  erzeugen (alter Link und QR-Code sofort ungültig), eigener Begrüßungstext je Link.
- **Upload am Handy:** großer Knopf für die Galerie, „Foto aufnehmen“ und „Video aufnehmen“ für die Kamera, mehrere
  Dateien auf einmal, Fortschritt je Datei, unterbrochene Uploads werden fortgesetzt
  (auch große Videos), Vorgangsnummer für Rückfragen, Hinweis für das Team im Feld.
- **Sicher eingesammelt:** Quarantäne, Prüfung von Dateityp und Inhalt, optional Virenscan (ClamAV), Größen- und
  Mengengrenzen je Link und Sammlung, Schutz vor Überlastung.
- **Datenschutz von Anfang an:** Datenschutzinformation auf der Upload-Seite, Standort- und Kameradaten werden
  entfernt – in der öffentlichen Fassung und auf Wunsch auch im Original.

### Sichten und aufbereiten

- **Sichtung am Handy oder Laptop:** Datei für Datei auswählen, überspringen oder zurückstellen – per Button,
  Wischgeste oder Tastatur; offene fortsetzen, alle erneut oder nur ausgewählte durchsehen; das nächste Bild ist schon
  geladen, gleichzeitiges Sichten wird erkannt.
- **Galerie:** Kacheln oder Liste mit Seiten, Großansicht zum Blättern, Details je Datei mit Anzeigename,
  Beschreibung, interner Notiz, Prüfsumme und Duplikat-Hinweis, Mehrfachauswahl mit Sammelaktionen.
- **Ordnen:** Ordner (beliebig tief) in jeder Sammlung, Zielordner je Upload-Link, Verschieben und Kopieren zwischen
  Sammlungen (Beiträge bleiben gültig), Schlagworte, Titelbild und Veranstaltungsdatum, Suche über alle Dateien.
- **Abgebildete Personen:** Markierungen für erkennbare Personen, Verletzte, Kennzeichen und sensible Inhalte;
  markierte Medien verlangen vor der Freigabe eine bewusste Datenschutz-Prüfung.
- **Unkenntlich machen:** Bereiche verpixeln, weichzeichnen oder abdecken, Bilder zuschneiden, Videos ohne Ton
  veröffentlichen – das Original bleibt unverändert.
- **Herunterladen:** einzelne Dateien oder als ZIP (ausgewählte, markierte, ein Ordner oder sammlungsübergreifend) mit
  Ordnerstruktur und optional `metadaten.csv`; Originale nur mit dem Recht „Medien verwalten“.

### Beiträge schreiben

- **Beitragsarten:** Nachricht, Einsatzbericht, Veranstaltung, Lage-Info – mit Vorlagen für wiederkehrende Texte.
- **Fassungen:** Jede Änderung an Text, Medien oder Zielkanal erzeugt eine neue Fassung; Unterschiede sind
  nachvollziehbar.
- **Texte je Kanal:** eigener Text für Website, Facebook und Instagram, Vorschau je Kanal, geplanter
  Veröffentlichungstermin.
- **Quellen:** RSS- und Atom-Feeds als Anregung für eigene Beiträge.

### Freigeben

- **Freigabe genau einer Fassung** (Prüfsumme) – ändert sich danach etwas, ist eine neue Freigabe nötig.
- **Vier-Augen-Prinzip** wählbar für Beiträge, Banner und Warnentwürfe: wer geschrieben oder eingereicht hat, gibt
  nicht selbst frei.
- **Intern freigeben** ohne Veröffentlichung, z. B. für Pressemitteilungen oder als Vorlage.

### Veröffentlichen

- **WordPress über die BlaulichtCMS Bridge:** Plugin direkt aus BlaulichtCMS, Kopplung per Einmalcode, die Website holt
  Aufträge per HTTPS ab – kein offener Eingang zur Website. WordPress-ID und URL kommen zurück; auch eine doppelte
  Abholung erzeugt nie einen zweiten Beitrag. Updates des Plugins sind signiert.
- **Banner auf der Website:** Hinweise und Gefahrenmeldungen mit Laufzeit, automatisch am Seitenanfang oder per Block
  bzw. Shortcode; abgelaufene Banner verschwinden auch aus zwischengespeicherten Seiten.
- **Einsatzübersicht** auf der Website per Shortcode bzw. Block.
- **Facebook und Instagram:** Veröffentlichung je Kanal mit eigenem Status; Facebook-Beiträge lassen sich wieder
  löschen, für Instagram gibt es einen geführten Weg.
- **Zurückziehen:** Beitrag von der Website nehmen – inklusive der übernommenen Bilder in der Mediathek.

### Warnentwurf und amtliche Warnungen

- **Warnentwurf (MoWaS-Übergabe):** Assistent in sechs Schritten für Erstmeldung, Aktualisierung und Entwarnung –
  auch am Handy.
- **Warnstufen-Assistent:** schlägt anhand lokal gepflegter, fachlich freigegebener Regeln eine Warnstufe vor oder
  sagt ehrlich „Keine eindeutige Empfehlung“; die Stufe bestätigt immer ein Mensch.
- **Freigabe und Versand:** Die Freigabe fixiert die PDF; Versand per E-Mail an die zuständige Stelle (ab Werk im
  Testmodus), Eingangsbestätigung, Umgang mit unklarer Zustellung. Die amtliche Auslösung bleibt bei der zuständigen
  Stelle.
- **Pflege:** Stichwörter mit Aliasen, Lagefragen, Regeln mit Versionen, Zuständigkeiten, Vorlagen – Regeln gibt immer
  eine andere Person frei.
- **Amtliche Warnungen:** Warn-App-Schnittstelle des Bundes (NINA, gefiltert nach Regionalschlüssel) oder CAP-Feeds,
  auf Wunsch als Banner auf der Website mit Quellenvermerk.

### Verbindungen

- **FE2:** Alarm-Meldungen erzeugen je Einsatz einen internen Beitragsentwurf (nur freigegebene Felder, keine
  Adressen).
- **Einheitlicher Ablauf** für alle Verbindungen: Verbinden → Testen → Vorschau → Aktivieren.
- **Medienimport:** einmalige Übernahme von Medien und gültigen Upload-Links aus einem Altsystem (Austauschformat,
  Exportskript für LiFeOS).

### Übersicht und Bedienung

- **Dashboard:** offene Freigaben, bestätigter Stand der Veröffentlichungen, neue Uploads, Banner, Websites; per
  Drag-and-drop anpassbar, eigene Ansicht fürs Handy, Vorlagen je Rolle.
- **Live:** neue Uploads, Freigaben und Veröffentlichungen erscheinen ohne Neuladen; Benachrichtigungen in der App
  und auf Wunsch per E-Mail.
- **App fürs Handy:** installierbar (PWA) mit Schnellzugriffen auf Neuer Beitrag, Medien sammeln und Freigaben.
- **Schnell bedienbar:** Suche und Schnellaktionen mit `Strg` + `K`, vollständig per Tastatur nutzbar, heller und
  dunkler Modus, Design „Leitstand“ für draußen und nachts.
- **Hilfe-Center:** 24 Kapitel mit Volltextsuche direkt in der App.

### Benutzer und Sicherheit

- **Rollen:** Administration, Medienverwaltung, Redaktion, Freigabe, Veröffentlichung, Warnentwurf, Warnfreigabe,
  Warnversand, Lesezugriff – kombinierbar, Rechte werden bei jeder Aktion serverseitig geprüft.
- **Anmeldung:** Einladung per Link, Zwei-Faktor-Anmeldung mit Wiederherstellungscodes, erneute Bestätigung für
  kritische Aktionen, Schutz vor gezieltem Aussperren.
- **Nachvollziehbar:** Aktivitätsprotokoll mit Hash-Kette gegen nachträgliche Änderungen, optional an Syslog;
  Alarmierung bei auffälligen Ereignissen.

### Datenschutz

- **Auskunft und Löschung je Person:** Suche über alle personenbezogenen Daten, Export als ZIP, Löschen oder
  Pseudonymisieren je Treffer.
- **Löschfristen** für Sammlungen, Upload-Links, Warnvorgänge, FE2-Meldungen und Protokolle – mit Vorschau „Was würde
  gelöscht?“.
- **Vorlagen** für Verarbeitungsverzeichnis und Datenschutz-Folgenabschätzung, Hinweise zu Empfängern wie Meta.

### Betrieb

- **Ein Container, ein Skript:** Das Installationsskript führt durch die Einrichtung und prüft am Ende die Adresse.
- **Updates aus der App:** neue Versionen unter *Einstellungen → Updates*, nur mit gültiger Signatur, mit Sicherung
  vorab und automatischem Rückweg.
- **Sicherung:** täglich, verschlüsselt, mit regelmäßiger Probe-Wiederherstellung.
- **Systemstatus:** Dienste, Speicher, Sicherungen, Audit-Integrität, Wartungsmodus und Vorabprüfung vor Updates.

---

## Einblicke

<table>
  <tr>
    <td width="33%"><b>Upload am Handy</b><br/>ohne Konto, Fortschritt je Datei<br/><br/><img src="docs/bilder/upload-handy.webp" alt="Upload-Seite am Handy"/></td>
    <td width="33%"><b>Sichtung</b><br/>Auswählen oder Überspringen<br/><br/><img src="docs/bilder/sichtung-handy.webp" alt="Sichtung am Handy"/></td>
    <td width="33%"><b>Beitrag am Handy</b><br/>Status, Freigabe, bestätigte URL<br/><br/><img src="docs/bilder/beitrag-handy.webp" alt="Beitrag am Handy"/></td>
  </tr>
  <tr>
    <td colspan="2"><b>Beitrag mit Freigabe</b><br/>Fassungen, Prüfsumme, Veröffentlichungen<br/><br/><img src="docs/bilder/beitrag.webp" alt="Beitrag mit Freigabe"/></td>
    <td><b>Sammlung</b><br/>Upload-Links mit QR-Code und Aushang<br/><br/><img src="docs/bilder/sammlung.webp" alt="Sammlung"/></td>
  </tr>
  <tr>
    <td colspan="2"><b>Auf der Website</b><br/>veröffentlicht von der BlaulichtCMS Bridge<br/><br/><img src="docs/bilder/wordpress-beitrag.webp" alt="Beitrag auf WordPress"/></td>
    <td><b>Hilfe-Center</b><br/>24 Kapitel mit Volltextsuche<br/><br/><img src="docs/bilder/hilfe.webp" alt="Hilfe-Center"/></td>
  </tr>
  <tr>
    <td><b>Warnentwurf am Handy</b><br/>Stichwort, Lagefragen, Vorschlag<br/><br/><img src="docs/bilder/warnentwurf-handy.webp" alt="Warnentwurf-Assistent am Handy"/></td>
    <td><b>Freigegebene PDF</b><br/>mit bestätigter Warnstufe und Prüfsumme<br/><br/><img src="docs/bilder/warnentwurf-pdf.webp" alt="PDF eines Warnentwurfs"/></td>
    <td><b>Regeln pflegen</b><br/>versioniert, fachlich freigegeben<br/><br/><img src="docs/bilder/warnstufen-regeln.webp" alt="Pflege der Warnstufen-Regeln"/></td>
  </tr>
</table>

---

## Schnellstart

Auf einem Linux-Server mit Docker (Docker installiert das Skript bei Bedarf mit):

```bash
curl -fsSL https://raw.githubusercontent.com/thisislennard/BlaulichtCMS/main/install.sh -o install.sh
sudo bash install.sh
```

Das Skript fragt nur die öffentliche Adresse und wo der Reverse Proxy läuft, richtet alles Weitere ein, prüft die
Adresse und zeigt am Ende den Einrichtungsschlüssel für die Ersteinrichtung im Browser. Ausführlich – Voraussetzungen,
Optionen, Updates, Sicherung, WordPress: **[Installation und Betrieb](docs/installation.md)**.

---

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/installation.md](docs/installation.md) | Installation, Updates, Sicherung, Wiederherstellung, erste Schritte, WordPress verbinden |
| [docs/technik.md](docs/technik.md) | Aufbau, Verbindungen, Sicherheit, Leistung, Teststand und Grenzen, Entwicklung, Projektstruktur |
| [docs/betrieb.md](docs/betrieb.md) | Start, Betriebswerte, Lasttest, Sicherung, Wiederherstellung, Updates, Datenbankrollen, Schlüsselwechsel, Protokollierung und Sicherheitsvorfälle, Notfall |
| [docs/reverse-proxy.md](docs/reverse-proxy.md) | HTTPS mit Nginx Proxy Manager, nginx, Caddy, Traefik, HAProxy, IIS |
| [docs/integrationen.md](docs/integrationen.md) | Stand und Einrichtung je Verbindung, Ergebnisse der Live-Tests |
| [docs/import.md](docs/import.md) | einmaliger Medienimport (Austauschformat, alte Links, Exportskript für LiFeOS) |
| [docs/bridge-api.md](docs/bridge-api.md) | Schnittstelle zwischen BlaulichtCMS und der BlaulichtCMS Bridge |
| [docs/bridge-signatur.md](docs/bridge-signatur.md) | Code-Signatur der Bridge-Updates (Ed25519) |
| [docs/design-leitstand.md](docs/design-leitstand.md) | Design „Leitstand“: Farben, Schrift, Komponenten, Ausnahmen |
| [docs/architektur.md](docs/architektur.md) | Aufbau und Architekturentscheidungen |
| [docs/sicherheitspruefung.md](docs/sicherheitspruefung.md) | Ergebnis der Sicherheitsprüfung mit Nachweisen |
| [docs/datenschutz.md](docs/datenschutz.md) | Datenschutz: Datenkategorien, Empfänger, Löschfristen, TOMs, Vorlagen für Verarbeitungsverzeichnis und DSFA |
| [docs/entwicklung.md](docs/entwicklung.md) | Entwicklungsumgebung |
| Hilfe-Center in der App (`/hilfe`) | 24 Kapitel für Redaktion und Administration |

---

## Mitmachen und Lizenz

Fehlerberichte und Verbesserungsvorschläge gern als [Issue](https://github.com/thisislennard/BlaulichtCMS/issues),
Pull Requests sind willkommen – Regeln und Entwicklungsumgebung in [CONTRIBUTING.md](CONTRIBUTING.md).
**Sicherheitslücken bitte nicht öffentlich**, sondern über *Security → Report a vulnerability* melden
([SECURITY.md](SECURITY.md)).

Lizenz: [GPL-3.0-or-later](LICENSE). Das WordPress-Plugin BlaulichtCMS Bridge steht unter GPL-2.0-or-later.
