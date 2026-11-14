# LifeLink – Roadmap

LifeLink ist ein eigenständiges, quelloffenes CMS für Öffentlichkeitsarbeit und
Krisenkommunikation. Das zugehörige WordPress-Plugin heißt **LifeLink Bridge**.

Diese Roadmap ist die verbindliche Arbeitsgrundlage. Fachliche Grundlage ist das
technische Umsetzungskonzept „LifeLink V2“ (Stand 14.11.2026). Es bleibt außerhalb
des Repositorys, weil es organisationsspezifische Angaben enthält. **Bei Abweichungen
gelten die Entscheidungen in dieser Roadmap.**

Jeder Punkt hat ein GitHub-Issue. Epics fassen die Teilaufgaben eines Meilensteins
als Sub-Issues zusammen.

| Meilenstein | Epic | Sub-Issues | Stand (14.11.2026) |
|---|---|---|---|
| M0 – Bestandsaufnahme und Architektur | #1 | – | ✅ bis auf LiFeOS (Quellcode liegt nicht vor) |
| M1 – Vom Foto-Link bis zur WordPress-Testseite | #2 | #7 – #15 | ✅ abgenommen (lokal, 34/34) – produktionsnaher WordPress-Test offen |
| M2 – Medien, QR-Druck, Redaktion und Dashboard | #3 | #16 – #25 | ⏳ teilweise vorbereitet (QR/Aushang, Sichtung, PWA-Grundgerüst) |
| M3 – MoWaS-Warnentwurf per Handy, PDF und Mail | #4 | #26 – #30, #41 | ✅ lokal abgenommen (Abstimmung mit zuständiger Stelle offen) |
| M4 – Optionale Verbindungen, Import und Betrieb | #5 | #31 – #40 | ⏳ Sicherung/Wiederherstellung und Doku begonnen |
| Abschluss | #6 | – | – |

Stand im Detail: [docs/testprotokoll.md](docs/testprotokoll.md) · Entscheidungen: [docs/architektur.md](docs/architektur.md) ·
Integrationen: [docs/integrationen.md](docs/integrationen.md)

---

## 1. Verbindliche Architektur

- **Benennung:** überall „LifeLink“; das WordPress-Plugin heißt „LifeLink Bridge“.
- **Öffentliches Repository:** neutrale Produkttexte, fiktive Beispiele. Organisationsname,
  Absender, Zuständigkeiten und Kanäle werden pro Installation eingerichtet.
- **Auslieferung:** ein Docker-Image, ein Container, ein Webport, ein persistentes Volume `/data`.
- **Im Container:** Webanwendung (CMS, API), Bediener-PWA, Worker und PostgreSQL. Ein
  Prozessmanager regelt Startreihenfolge, Healthcheck und geordneten Stopp. PostgreSQL ist
  nur containerintern erreichbar.
- **Daten:** PostgreSQL hält Benutzer, Rechte, Medienmetadaten, Inhalte, Revisionen,
  Freigaben, Aufträge und Auditdaten. Originale und Vorschauen liegen unter `/data` im
  Dateisystem, außerhalb des Webroots.
- **Aufträge:** dauerhaft in PostgreSQL, mit Sperren, Auftrags-ID und Wiederanlaufregeln.
  Zeitpläne werden in UTC gespeichert und in der konfigurierten Zeitzone angezeigt.
- **HTTPS** endet am vorhandenen Reverse Proxy.
- **Unabhängigkeit:** Der interne Redaktionsablauf funktioniert vollständig ohne LiFeOS und
  ohne externe Dienste. WordPress, Meta, FE2, SMTP und amtliche Warnfeeds sind optionale
  Verbindungen.
- **LiFeOS** dient als Vorlage für Anmeldung, Sitzungen, Rollen, serverseitige
  Rechteprüfung, Audit und die Bedienung von Updates, außerdem als Quelle für einen
  einmaligen Medienimport. Code wird nur bei geklärter Lizenz übernommen; benötigte Logik
  läuft eigenständig in LifeLink.
- **Abläufe:** feste redaktionelle Abläufe mit Freigabe und Zeitplanung je Inhaltstyp.
  Der allgemeine Automatisierungs- und Workflow-Editor entfällt.
- **Oberfläche:** schlicht, mobil, per Tastatur bedienbar. Drag-and-drop gibt es nur beim
  Dashboard und beim Sortieren von Medien. Das endgültige Design folgt separat.

## 2. Arbeitsweise

1. Bestand prüfen (Code, Datenmodell, Tests, Updateweg, FE2-/WordPress-Anbindungen,
   LiFeOS-Quellcode samt Lizenz), bevor gebaut wird.
2. Vorhandene Komponenten weiterverwenden, wenn sie die Anforderungen erfüllen. Bestehende
   Nutzerdaten und lokale Änderungen erhalten. Migrationen nur mit Kopien oder Testdaten
   prüfen. Änderungen an produktiven Daten brauchen einen eigenen Auftrag.
3. Jeden Meilenstein über den normalen Einstiegspunkt testen, mit Erfolgs- und relevanten
   Fehlerfällen. Eine vorhandene Oberfläche oder ein erfolgreicher Build allein gilt **nicht**
   als Abnahme.
4. Fehlen externe Zugänge, werden lokale Testdienste und fiktive Daten verwendet. **Keine
   echten Veröffentlichungen und keine Warnmails an operative Empfänger.** Pro Integration
   wird festgehalten, was lokal geprüft wurde und welcher Live-Test noch fehlt.
5. Startbefehle, Testbefehle, Ergebnisse und offene Punkte werden laufend in `docs/`
   dokumentiert, damit die Arbeit nach einer Unterbrechung fortgesetzt werden kann.

---

## M0 – Bestandsaufnahme, Plan und Architektur (#1)

Ausgangslage prüfen, Plan und Abnahmekriterien festhalten, Architekturentscheidungen in
`docs/adr/` dokumentieren.

## M1 – Vom Foto-Link bis zur WordPress-Testseite (#2)

**Ablauf:** frischer Container → Admin einrichten → Bediener einladen → Foto-Link am
Handy öffnen → Foto hochladen → Bild auswählen → Beitrag freigeben → auf einer
WordPress-Testseite veröffentlichen → bestätigte URL in LifeLink sehen.

| # | Arbeitspaket |
|---|---|
| #7 | Container-Betrieb: `compose.yaml`, Prozessmanager, Healthcheck, `/data`, dauerhafte Aufträge |
| #8 | Erstsetup-Assistent (Admin, Organisation, Basisadresse, Zeitzone), HTTPS hinter Reverse Proxy |
| #9 | Anmeldung, Sitzungen, CSRF, Login-Limits, einmalige befristete Einladungen, PWA-Installationslink |
| #10 | Rollen und serverseitige Rechte (Medien, Redaktion, Freigabe, Veröffentlichung, Admin; Warnrechte vorbereitet), Audit |
| #11 | Sammlungen, öffentliche Upload-Links mit Ablauf, Widerruf, Limits und Quarantäne |
| #12 | Sichtung, Beitrag, Revisionen, revisionsgebundene Freigabe |
| #13 | LifeLink Bridge: ZIP-Download, Kopplung per Einmalcode, idempotenter Auftragsabruf |
| #14 | Erstes Dashboard: offene Freigaben, bestätigter WordPress-Stand |
| #15 | Abnahme: E2E-Test, Sicherung und Restore in frischer Instanz |

Bridge-API (Entwurf): `POST /api/v1/bridge/pair`, `GET /api/v1/bridge/jobs`,
`POST /api/v1/bridge/jobs/{id}/result`.

**Abnahme**
- Kompletter Ablauf auf leerem Volume.
- Ohne WordPress lässt sich ein Beitrag intern freigeben.
- Direkte Zugriffe ohne Rechte sowie abgelaufene und widerrufene Links werden abgewiesen.
- Auf der gekoppelten Testwebsite erscheint genau ein Beitrag; LifeLink zeigt seine bestätigte URL.
- Der Teststand wird außerhalb des aktiven Volumes gesichert und in einer frischen Instanz
  wiederhergestellt.
- Fehlt Docker oder ein Testsystem: reproduzierbaren Testweg liefern, den Test als offen kennzeichnen.

## M2 – Medien, QR-Druck, Redaktion und Dashboard (#3)

| # | Arbeitspaket |
|---|---|
| #16 | Fortsetzbarer Mehrfachupload mit Fortschritt je Datei, ohne Duplikate |
| #17 | Mobile Wischansicht, Hintergrund-Vorschauen und ZIP-Export, Entfernen von Standortmetadaten |
| #18 | „QR-Code anzeigen“ für jede teilbare URL, lokal erzeugt, A4-Druckansicht |
| #19 | PWA-Schnellzugriffe; ausstehende Aktionen bei fehlender Verbindung anzeigen |
| #20 | Inhaltstypen, Vorlagen, Fassungen und Status je Zielkanal, Korrektur und Deaktivierung |
| #21 | WordPress: Einsatzübersichten, mehrere zeitgesteuerte Banner, Blöcke und Shortcodes, Seitencache |
| #22 | Konfigurierbares Dashboard (Drag-and-drop, Größe, Person/Team, mobile Reihenfolge) |
| #23 | Live-Status per SSE (freigegeben, gesendet, veröffentlicht, fehlgeschlagen, unbekannt) |
| #24 | RSS/Atom-Quellen mit Deduplizierung, Themenideen, SSRF-Schutz |
| #25 | Abnahme M2 |

**Abnahme:** unterbrochene Uploads, gedruckte QR-Codes (Android und iOS), Banner mit Cache
und getrennter Verbindung, RSS-Import, Dashboard-Aktualisierung nach Wiederverbindung.

## M3 – MoWaS-Warnentwurf per Handy, PDF und Mail (#4)

| # | Arbeitspaket |
|---|---|
| #26 | Mobiler Wizard: Erstmeldung, Aktualisierung, Entwarnung; speichern und fortsetzen |
| #27 | Versionierte Feldsätze und PDF-Vorlagen, serverseitiges PDF, Entwurfskennzeichnung |
| #28 | Getrennte Rechte für Entwurf, Freigabe und Versand; Empfänger aus Zuständigkeiten; SMTP mit Nachweis |
| #29 | Testmodus mit festem Empfänger, Versandfehler, unbekannter Zustellstatus |
| #30 | Abnahme M3 und Abstimmung mit der zuständigen Stelle |
| #41 | Stichwort-Umrechner und Warnstufen-Assistent: lokale, versionierte und freigegebene Regeln, Lagefragen, begründeter Vorschlag, ausdrückliche Bestätigung |

LifeLink bereitet den Warnentwurf vor und übergibt ihn an die zuständige Stelle. Die
amtliche Auslösung erfolgt über deren vorgesehenen Warnweg.

**Abnahme:** Erstmeldung, Aktualisierung und Entwarnung am Handy erfassen. PDFs visuell
prüfen und nur an ein Testpostfach senden. Versandfehler und unbekannten Status simulieren.
Nach einer Vorlagenänderung müssen vorhandene Entwürfe unverändert reproduzierbar bleiben.

## M4 – Optionale Verbindungen, Import und Betrieb (#5)

| # | Arbeitspaket |
|---|---|
| #31 | Verbindungsrahmen: Verbinden → Testen → Vorschau → Aktivieren, geschützte Geheimnisse |
| #32 | Facebook-Seiten und Instagram-Konten (OAuth, Formate, Wiederholung je Kanal, manueller Export) |
| #33 | FE2-Eingang `POST /api/v1/inbound/fe2/{connectionId}`, Deduplizierung, Feld-Allowlist |
| #34 | Amtliche Warnfeeds, getrennt vom Warnentwurf; zunächst Verweis auf die Originalquelle |
| #35 | Einmaliger LiFeOS-Medienimport mit Mengen- und Prüfsummenabgleich, Altlinks |
| #36 | Sicherheitsprüfung und Härtung, MFA, SSRF, Lasttest |
| #37 | Sicherung, Updates, Wiederherstellung, Wechsel der PostgreSQL-Hauptversion |
| #38 | Bridge-Updates über den WordPress-Updateweg |
| #39 | GitHub-Auslieferung: README, Beispielkonfiguration, Demo, Anleitungen, Lizenz |
| #40 | Abnahme M4 und Testmatrix je Verbindung |

**Abnahme:** Restore auf frischem Host mit realistischen Foto- und Videomengen (Benutzer,
Rechte, Medien, Freigaben, geplante Aufträge). Wiederherstellung nach fehlgeschlagener
Migration. Für jede Verbindung dokumentieren, ob lokal, mit dem Anbieter oder
produktionsnah getestet wurde.

## Abschluss (#6)

Lauffähiger Stand, Startbefehl, getestete Abläufe, erfüllte Abnahmekriterien, offene
externe Prüfungen, dokumentierte Architekturentscheidungen und konkret benannte Lücken.

---

## Vor dem produktiven Einsatz festzulegen

- Speicher- und Aufbewahrungsgrenzen, Backup-Ziel, Wiederanlaufzeit
- Zuständige Stelle, Feldsatz, PDF-Vorlage, Freigaberegeln und Empfänger für Warnentwürfe
- WordPress-Testwebsite
- Meta-App, Testkonten und Berechtigungen
- FE2-Ausgang (anonymisierte Testmeldung)
- Produktdesign und mobile Ansichten (separate Spezifikation)
