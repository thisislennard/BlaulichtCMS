# Sicherheitsrichtlinie

## Sicherheitslücken melden

Bitte **keine öffentlichen Issues** für Sicherheitslücken anlegen. Stattdessen die private Meldung von GitHub nutzen:
im Repository *Security → Report a vulnerability*. Die Meldung sehen nur die Betreuer des Projekts.

Hilfreich sind:

- betroffene Version bzw. Commit und Komponente (Server, Oberfläche, BlaulichtCMS Bridge, Installations- und
  Sicherungsskripte)
- Schritte zum Nachstellen oder ein Proof of Concept
- erwartete Auswirkung (z. B. Zugriff ohne Recht, Datenabfluss, Codeausführung)

Bitte keine echten personenbezogenen Daten mitschicken und keine Tests gegen Installationen Dritter durchführen.

## Ablauf

1. Eingangsbestätigung in der Regel innerhalb weniger Werktage.
2. Bewertung und Rückmeldung, ob und wie die Lücke behoben wird.
3. Behebung in einem neuen Release; kritische Lücken werden vorrangig behandelt (Zielwert: 7 Tage).
4. Veröffentlichung eines Sicherheitshinweises nach dem Release, auf Wunsch mit Nennung der meldenden Person.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für den jeweils neuesten Release-Tag (`v*`) und den Branch `main`. Das
WordPress-Plugin BlaulichtCMS Bridge wird über BlaulichtCMS aktualisiert; Updates sind mit Ed25519 signiert
([docs/bridge-signatur.md](docs/bridge-signatur.md)).

## Hinweise für den Betrieb

- Updates einspielen: normale Releases unter Einstellungen → Updates (Ed25519-signiert, geprüft gegen den Schlüssel
  der laufenden Version, mit Sicherung und automatischem Rückweg; Abwägung in
  [docs/architektur.md](docs/architektur.md), E9), Image und Basis-Images mit
  `sudo bash /opt/apps/blaulichtcms/install.sh`, Basis-Images monatlich mit `--rebuild` erneuern.
- Der private Signaturschlüssel für In-App-Updates liegt nur im Repository-Secret `BLAULICHTCMS_UPDATE_SIGNING_KEY` und
  in einer sicheren Ablage, nie im Repository oder auf einem Server.
- Sicherheitsrelevante Einstellungen, Protokollierung und Vorgehen bei Sicherheitsvorfällen:
  [docs/betrieb.md](docs/betrieb.md), Ergebnis der Sicherheitsprüfung: [docs/sicherheitspruefung.md](docs/sicherheitspruefung.md).
