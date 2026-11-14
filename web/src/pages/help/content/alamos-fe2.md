LifeLink übernimmt aus Alamos FE2 zwei Dinge:

| Was | Wie | Trigger in LifeLink |
|---|---|---|
| **Einsätze** | FE2 schickt sie im Alarmablauf per HTTP an LifeLink („Push“). | **Alamos-Einsatz** |
| **Termine** | LifeLink liest regelmäßig den iCal-Export der FE2-Kalenderverwaltung. | **Alamos-Kalender (iCal)** |

## Einsätze empfangen

### Schritt 1: Workflow mit dem Trigger „Alamos-Einsatz“

1. Legt einen Workflow an – am einfachsten aus der Vorlage **Einsatz → Website-Banner** oder **Einsatz → Beitragsentwurf** unter [Workflow-Vorlagen](/vorlagen).
2. Klickt im Trigger **Alamos-Einsatz** auf **Adresse jetzt anlegen**. LifeLink zeigt die Adresse und den **Zugriffsschlüssel** – den Schlüssel nur dieses eine Mal. Alternativ erscheinen beide beim ersten Veröffentlichen.
3. Notiert euch beides für FE2.

### Schritt 2: HTTP-Plugin im FE2-Alarmablauf

In FE2 fügt ihr dem Alarmablauf ein Plugin hinzu, das HTTP-Anfragen senden kann – je nach FE2-Version heißt es z. B. „HTTP/JSON“ oder „Allgemeiner Webhook“. Stellt es so ein:

| Einstellung | Wert |
|---|---|
| Methode | `POST` |
| Adresse (URL) | die Adresse aus LifeLink, z. B. `https://lifelink.feuerwehr-musterstadt.de/hooks/Xy7kP2…` |
| Header | `X-LifeLink-Token` mit dem Zugriffsschlüssel (alternativ `Authorization: Bearer <Schlüssel>`) |
| Inhalt | JSON mit den Einsatzdaten |
| Content-Type | `application/json` |

Welche Felder ihr mitschickt, bestimmt ihr im Plugin. LifeLink erkennt die üblichen FE2-Feldnamen automatisch (siehe Tabelle unten). Schickt nur, was ihr wirklich braucht – für ein Website-Banner reichen Einsatznummer, Stichwort und Ortsteil.

> **Tipp:** Löst nach dem Einrichten einen **Probealarm** aus und nutzt im Editor **Auf Testereignis warten**. Dann seht ihr genau, welche Felder ankommen, ohne dass ein echter Lauf startet. Siehe [Testen](/hilfe/testen#auf-testereignis-warten).

### Schritt 3: Veröffentlichen und aktivieren

Erst wenn der Workflow aktiv ist, starten echte Läufe. Vorher antwortet LifeLink FE2 mit `409`.

## Welche Felder ankommen

FE2 sendet je nach Version und Plugin unterschiedliche Feldnamen. LifeLink vereinheitlicht sie, damit eure Workflows immer mit denselben Namen arbeiten. Liegen die Daten verschachtelt unter `data` oder `parameters`, werden sie ebenfalls gefunden.

| Feld in LifeLink | Inhalt | Wird erkannt aus |
|---|---|---|
| `einsatz_id` | Einsatznummer / externe ID | `externalId`, `einsatznummer`, `Einsatznummer`, `id`, `alarmId`, `dbId` |
| `stichwort` | Stichwort, z. B. B3 (fehlt es: „Unbekannt“) | `keyword`, `stichwort`, `Stichwort`, `einsatzart`, `Einsatzart` |
| `stichwort_text` | Meldebild / Stichworttext | `keyword_description`, `stichwortText`, `keywordDescription`, `meldebild`, `Meldebild` |
| `meldung` | Meldung / Freitext | `message`, `meldung`, `Meldung`, `bemerkung`, `Bemerkung`, `freitext`, `text` |
| `ort` | Einsatzort als ein Text | `location`, `adresse`, `einsatzort`, `Einsatzort`, `address` – sonst aus Straße, Hausnummer, PLZ und Ort zusammengesetzt |
| `strasse`, `hausnummer` | Straße und Hausnummer | `strasse`, `street`, `Strasse` / `hausnummer`, `hnr`, `house` |
| `plz`, `stadt` | Postleitzahl und Ort | `plz`, `zip`, `postalCode` / `ort`, `city`, `Ort`, `stadt` |
| `ortsteil` | Ortsteil | `ortsteil`, `district`, `Ortsteil` |
| `objekt` | Objekt | `objekt`, `building`, `Objekt` |
| `einheiten` | Liste der alarmierten Einheiten | `units`, `einheiten`, `fahrzeuge`, `Einheiten`, `Fahrzeuge`, `vehicles` – als Liste oder als Text mit Komma, Semikolon oder `\|` |
| `alarmzeit` | Alarmzeit (UTC) | `timestamp`, `alarmzeit`, `Alarmzeit`, `zeit`, `datetime`, `alarmDate` – fehlt sie: Empfangszeit |
| `koordinaten` | `lat` und `lng` | `lat`, `lng` |
| `roh` | Die unveränderten FE2-Daten | – |

Im Workflow verwendet ihr sie z. B. als `{{ alamos.stichwort }}` oder `{{ alamos.alarmzeit | date:"HH:mm" }}`.

> **Wichtig:** Adressen, Meldungstexte und Personendaten gehören nicht auf die öffentliche Website. Nutzt für Banner nur Stichwort und Ortsteil – wie die Vorlage „Einsatz → Website-Banner“.

## Stichwort-Filter

In den erweiterten Optionen des Triggers könnt ihr unter **Nur Stichworte** eine Komma-Liste angeben, z. B. `B, TH`. Dann werden nur Einsätze verarbeitet, deren Stichwort **mit einem dieser Werte beginnt** (Groß-/Kleinschreibung egal).

Der Filter wirkt **schon beim Empfang**: Andere Einsätze werden mit `202` und „Stichwort nicht im Filter“ quittiert, erzeugen aber keinen Lauf. Leer bedeutet: alle Einsätze.

Für feinere Regeln (z. B. „B, aber nicht B1“) nutzt zusätzlich einen [Filter-Baustein](/hilfe/bedingungen#filter).

## Duplikatfenster

FE2 schickt einen Einsatz manchmal mehrfach – etwa bei Nachalarmierung oder wenn mehrere Alarmabläufe dasselbe Plugin nutzen. Unter **Duplikate ignorieren (Minuten)** legt ihr fest, wie lange dieselbe Einsatznummer keinen zweiten Lauf startet. Standard: **30 Minuten**, höchstens 1440 (ein Tag). Mit 0 gilt das Fenster nur noch für eine Minute.

Kommt ohne Einsatznummer an, greift die Duplikaterkennung über den Header `Idempotency-Key`, falls FE2 ihn sendet.

> **Tipp:** Banner und Beiträge nutzen die Einsatznummer als Schlüssel. Kommt derselbe Einsatz nach Ablauf des Fensters noch einmal, wird das vorhandene Banner aktualisiert statt ein zweites angelegt.

## Kalendereinträge per Push

Kann eure FE2-Version Kalendereinträge per HTTP versenden, stellt im Trigger **Alamos-Einsatz** die **Art der Daten** auf **Kalendereintrag (Push aus FE2)**. Dann kommen die Felder `termin_id`, `titel`, `beschreibung`, `ort`, `beginn`, `ende`, `kalender` und `ersteller` an. Mit **Nur Kalender** werden nur Einträge eines bestimmten Kalenders verarbeitet.

## Termine über den iCal-Export

Der übliche Weg für Termine ist der **iCal-Export** der FE2-Kalenderverwaltung. LifeLink fragt ihn regelmäßig ab und erkennt neue, geänderte und abgesagte Termine selbst.

### Einrichten

1. In FE2: **Kalender → iCal-Export → Link kopieren**.
2. In LifeLink: [Schnittstellen](/schnittstellen) → **Alamos FE2** → verbinden. Den Link bei **iCal-Export-Adresse** einfügen. Er enthält einen Zugriffsschlüssel und wird deshalb verschlüsselt gespeichert.
3. **Verbindung testen**: LifeLink ruft den Export ab und zeigt, wie viele Termine in den nächsten 30 Tagen anstehen.
4. Workflow mit dem Trigger **Alamos-Kalender (iCal)** anlegen und die Verbindung auswählen – oder die Vorlage **Kalendertermin → E-Mail** nehmen.

Links, die mit `webcal://` beginnen, werden automatisch als `https://` abgerufen.

### Einstellungen des Kalender-Triggers

| Einstellung | Bedeutung |
|---|---|
| **Prüfen alle (Minuten)** | Standard 15, mindestens 5 |
| **Starten bei** | Neuer Termin, Geänderter Termin, Abgesagt / gelöscht, Termin beginnt bald |
| **Vorlauf (Minuten)** | Bei „Termin beginnt bald“: wie lange vorher (Standard 60) |
| **Zeitraum (Tage voraus)** | Wie weit in die Zukunft geschaut wird (Standard 60) |
| **Nur Termine mit Titel** | Nur Termine, deren Titel diesen Text enthält, z. B. „Übung“ |

Beim **ersten Abruf** merkt sich LifeLink nur den aktuellen Stand und startet nichts – sonst gäbe es für jeden bestehenden Termin eine Meldung. Ab dem zweiten Abruf werden Änderungen gemeldet.

Im Workflow stehen dann `{{ termin.aenderung }}` (neu, geaendert, geloescht oder beginnt_bald), `{{ termin.titel }}`, `{{ termin.beginn }}`, `{{ termin.ort }}` und weitere Felder bereit – siehe [Bausteine-Referenz](/hilfe/bausteine).

> **Wichtig:** FE2 erzeugt den iCal-Export nur **etwa alle 2 Stunden** neu. Eine Änderung im FE2-Kalender kann also bis zu zwei Stunden brauchen, bis LifeLink sie sieht – egal wie oft LifeLink nachschaut. Häufiger als alle 15 Minuten zu prüfen bringt deshalb nichts.

## Warum LifeLink nicht direkt in die FE2-Datenbank greift

Technisch wäre es denkbar, Einsätze und Termine direkt aus der Datenbank von FE2 zu lesen. LifeLink tut das bewusst **nicht**:

- **Undokumentiert:** Der Aufbau der FE2-Datenbank ist nicht veröffentlicht und kann sich mit jedem FE2-Update ändern. Eine Anbindung könnte jederzeit unbemerkt kaputtgehen.
- **Kein Support:** Alamos unterstützt direkte Datenbankzugriffe nicht. Bei Problemen hilft euch niemand weiter.
- **Risiko für das Alarmsystem:** FE2 ist eure Alarmierung. Zusätzliche Zugriffe auf seine Datenbank könnten im schlimmsten Fall die Alarmierung stören. Das darf eine Website-Automatisierung niemals riskieren.

Stattdessen nutzt LifeLink nur die offiziellen Wege: Push aus dem Alarmablauf und den iCal-Export. FE2 entscheidet damit selbst, welche Daten es herausgibt.
