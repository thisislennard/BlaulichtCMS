Presseanfragen von Redaktionen erfassen und bis zur Erledigung nachverfolgen – mit Zuständigkeit, Frist, Verknüpfung zu Einsatz und Beitrag und einem vollständigen Verlauf. Zu finden unter [Presse → Presseanfragen](/presse).

## Anfrage erfassen

1. [Presseanfragen](/presse) → **Anfrage erfassen** (z. B. nach einem Anruf).
2. **Thema** (Pflicht), Anfragetext, **Medium/Redaktion**, Name, E-Mail und Telefon der anfragenden Person und den **Eingangsweg** (Telefon, E-Mail, persönlich, sonstiges) eintragen.
3. Optional gleich die **zuständige Person** und eine **Frist** setzen.

Jede Anfrage bekommt eine Vorgangsnummer (`P-Jahr-Nummer`). Alle mit „Presseanfragen bearbeiten“ erhalten eine Benachrichtigung – ohne Kontaktdaten der anfragenden Person.

## Status, Zuständigkeit und Frist

| Status | Bedeutung |
|---|---|
| **Neu** | eingegangen, noch nicht bearbeitet |
| **In Bearbeitung** | jemand kümmert sich darum |
| **Beantwortet** | Antwort ist raus (wird beim Senden aus BlaulichtCMS automatisch gesetzt) |
| **Erledigt** | abgeschlossen; ab jetzt läuft die Löschfrist |

Status, **Zuständig** und **Frist** stehen in der Anfrage rechts unter *Bearbeitung*. Wer zuständig wird, bekommt eine Benachrichtigung.

**Erinnerung:** Vor Ablauf der Frist (Standard 2 Stunden vorher, *Einstellungen → Redaktion → Erinnerung vor Frist*) und bei Überschreitung kommt je eine Benachrichtigung – an die zuständige Person, ohne Zuständigkeit an alle mit „Presseanfragen bearbeiten“. Wird die Frist geändert, erinnert BlaulichtCMS erneut. Anfragen mit dem Status *Beantwortet* oder *Erledigt* lösen keine Erinnerung mehr aus. Ob die Benachrichtigung zusätzlich per Push oder E-Mail kommt, wählt jede Person unter [Benachrichtigungen einstellen](/profil) (Art „Presseanfragen“).

## Verknüpfungen, Notizen und Verlauf

- **Einsatz:** eine Einsatzmeldung aus FE2 oder Feuersoftware Connect.
- **Beitrag:** z. B. die Pressemitteilung oder der Einsatzbericht zum Thema.
- **Interne Notiz:** nur in BlaulichtCMS sichtbar, nie Teil einer Antwort.

Der **Verlauf** zeigt jede Änderung mit Person und Zeitpunkt (Status, Zuständigkeit, Frist, Verknüpfungen, Notizen, Mails). Geänderte Kontaktdaten stehen dort nur als „geändert“, nicht mit Wert.

## Übersicht und Dashboard

Die Übersicht filtert nach **Offen**, **Überfällig**, **Meine**, **Beantwortet**, **Erledigt** und **Alle** und durchsucht Nummer, Thema, Medium und Name. Fürs [Dashboard](/) gibt es die Kachel **Presseanfragen** (offene Anfragen nach Frist) und die Kennzahl **Offene Presseanfragen** (rot, sobald eine Frist überschritten ist) – über *Dashboard anpassen* einblenden.

## Workflows

Der Eingang **Neue Presseanfrage** startet einen [Workflow](/hilfe/workflows), sobald eine Anfrage erfasst wird oder über das Presse-Postfach eingeht – wahlweise nur für bestimmte Eingangswege. Er liefert nur Felder **ohne Kontaktdaten**: Vorgangsnummer, Thema, Medium, Eingangsweg, Frist, zuständige Person und den Link zur Anfrage.

## Rechte

| Recht | Erlaubt |
|---|---|
| Presseanfragen ansehen | Anfragen mit Kontaktdaten, Verlauf, Mails und Anhängen lesen |
| Presseanfragen bearbeiten | erfassen, Status, Zuständigkeit, Frist, Verknüpfungen, Notizen, löschen |

Ab Werk haben die Rolle **Redaktion** beide Rechte, die Rolle **Lesezugriff** keines (Kontaktdaten). Jede Anlage, Änderung, Notiz und Löschung steht im Audit – mit Vorgangsnummer, ohne Kontaktdaten.

## Datenschutz und Löschfrist

Erledigte Anfragen werden samt Kontaktdaten, Verlauf, Mails und Anhängen **12 Monate nach der Erledigung** gelöscht (*Einstellungen → Datenschutz → Erledigte Presseanfragen*, 0 = nie). Wird eine Anfrage wieder geöffnet, beginnt die Frist bei der nächsten Erledigung neu. Presseanfragen sind Teil der [Datenschutzanfragen](/datenschutz-anfragen) (Suche nach Name, E-Mail, Telefon, Text; Auskunft und Löschung).
