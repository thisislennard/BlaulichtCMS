Rechte werden immer **auf dem Server** geprüft – bei jeder Seite, jeder API-Anfrage und jedem Dateizugriff. Rollen lassen sich kombinieren; es gilt die Summe der Rechte. **Was eine Person nicht darf, wird ihr auch nicht angezeigt:** Menüpunkte, Reiter, Schaltflächen und Kacheln ohne Recht fehlen einfach. Wer eine Adresse ohne Recht direkt aufruft, sieht „Kein Zugriff“.

## Rollen

Mitgeliefert sind neun Rollen. Sie decken die übliche Aufgabenteilung ab:

| Rolle | Darf |
|---|---|
| Administration | Alles, inklusive Konten, Rollen, Websites, Einstellungen, Sicherungen. Hat immer alle Rechte und lässt sich nicht ändern. |
| Medienverwaltung | Sammlungen und Upload-Links pflegen, sichten, auswählen, herunterladen |
| Redaktion | Beiträge schreiben, Medien übernehmen, zur Freigabe einreichen (inkl. Medienverwaltung) |
| Freigabe | Fassungen freigeben oder zurückweisen, Aktivitäten lesen |
| Veröffentlichung | Freigegebene Fassungen an Websites übergeben, Fehler neu starten |
| Warnentwurf | Warnentwürfe erfassen (Erstmeldung, Aktualisierung, Entwarnung) und einreichen |
| Warnfreigabe | Warnstufe bestätigen, PDF-Fassungen freigeben, Lagefragen und Regeln fachlich freigeben |
| Warnversand | Freigegebene Warnentwürfe versenden, unklare Zustellungen prüfen, Eingang bestätigen |
| Lesezugriff | Beiträge, Medien und Status ansehen |

Welche Rechte eine Rolle genau hat, zeigt [Benutzer und Rollen](/benutzer?tab=rollen) → Reiter **Rollen** → Menü der Rolle → **Rechte ansehen** bzw. **Rechte bearbeiten**.

Entwurf, Bestätigung der Warnstufe, Freigabe und Versand von Warnentwürfen sind bewusst **getrennte** Rechte. Regeln und Lagefragen gibt immer eine **andere** Person fachlich frei.

## Rollen anlegen

Reichen die mitgelieferten Rollen nicht, legst du eigene an. Dafür brauchst du das Recht **„Rollen verwalten“** (mitgeliefert: nur Administration).

1. [Benutzer und Rollen](/benutzer?tab=rollen) → Reiter **Rollen** → **Neue Rolle** – oder im Menü einer vorhandenen Rolle **Als Kopie anlegen**, um von deren Rechten auszugehen.
2. Namen und Beschreibung eintragen und die Rechte ankreuzen. Die Rechte sind nach Bereichen geordnet; die Suche filtert nach Stichworten („Upload-Link“, „freigeben“). **Alle im Bereich** wählt einen ganzen Bereich.
3. **Weiter: Änderung prüfen** zeigt, was die Rolle erhält und verliert – kritische Rechte sind hervorgehoben. Erst **Speichern** bzw. **Rolle anlegen** übernimmt die Änderung.
4. Die Rolle unter **Benutzer** den gewünschten Konten zuweisen (Spalte Rollen).

Dazu gilt:

- **Stufen:** Jedes Recht trägt eine Stufe – *lesen* (nur ansehen), *ändern* oder *kritisch* (z. B. freigeben, veröffentlichen, Konten und Einstellungen).
- **Voraussetzungen:** Manche Rechte setzen andere voraus, etwa „Beiträge bearbeiten“ → „Beiträge ansehen“. Sie werden automatisch mit angekreuzt; wählst du die Voraussetzung ab, entfallen die abhängigen Rechte.
- **Sofort wirksam:** Änderungen an einer Rolle gelten für alle Konten mit dieser Rolle ab der nächsten Aktion – ohne neue Anmeldung.
- **Nur eigene Rechte:** Du kannst nur Rechte vergeben oder entziehen, die du selbst hast, und nur Rollen zuweisen, deren Rechte du vollständig hast. Konten mit mehr Rechten kannst du nicht sperren, löschen oder per Passwort-Link übernehmen.
- **Mitgelieferte Rollen** lassen sich in ihren Rechten ändern (Kennzeichen **Angepasst**) und mit **Auf Standard zurücksetzen** wiederherstellen, aber nicht umbenennen oder löschen. Unveränderte Rollen erhalten Rechte neuer Versionen automatisch, angepasste und eigene Rollen nicht – nach einem Update bitte prüfen.
- **Löschen:** Eigene Rollen lassen sich löschen. Haben noch Konten die Rolle, wählst du eine Ersatzrolle; niemand bleibt ohne Rolle zurück.
- **Bestätigung und Protokoll:** Jede Änderung an Rollen verlangt dein Passwort (siehe unten), steht mit altem und neuem Stand in den [Aktivitäten](/aktivitaeten) und wird bei kritischen Rechten zusätzlich gemeldet. Per API-Schlüssel lassen sich Rollen nicht ändern.
- **Zwei-Faktor-Pflicht:** Die Einstellungen zur Zwei-Faktor-Pflicht richten sich nach den Rechten: Die Pflicht „für Administration“ gilt für alle Konten mit Verwaltungsrechten (Konten, Rollen, Einstellungen, Sicherungen, Updates, Verbindungen, Kopplung von Websites, Datenschutzanfragen), die Pflicht „für Medienverwaltung“ für „Originale herunterladen“. Erhält eine Rolle solche Rechte, werden ihre Konten ohne zweiten Faktor abgemeldet und richten ihn bei der nächsten Anmeldung ein.

## Beispiele

| Aufgabe | Rolle anlegen mit |
|---|---|
| Fotos vor Ort sichten, ohne Originale und ohne Löschen | Medien ansehen, Medien sichten und auswählen |
| Pressefotos verpixeln und ordnen | Medien ansehen, Medien ordnen, Medien unkenntlich machen |
| Praktikum: Beiträge schreiben, aber nicht einreichen | Beiträge ansehen, Beiträge anlegen, Beiträge bearbeiten, Medien ansehen |
| Social Media: nur in sozialen Kanälen veröffentlichen | Beiträge ansehen, In sozialen Kanälen veröffentlichen, Aus sozialen Kanälen entfernen |
| Banner pflegen und schalten | Banner ansehen, Banner bearbeiten, Banner veröffentlichen, Websites ansehen |
| Konten betreuen, ohne Systemzugriff | Benutzer ansehen, Benutzer einladen, Konten sperren und entsperren, Sitzungen beenden |
| Revision: alles nachvollziehen, nichts ändern | Audit-Protokoll ansehen, Systemprotokoll ansehen, Einstellungen ansehen, Benutzer ansehen |

Rollen lassen sich kombinieren: Die Rolle „Banner“ zusätzlich zur Rolle „Redaktion“ ergibt beide Aufgaben, ohne eine dritte Rolle zu pflegen.

## Einladen

1. [Benutzer und Rollen](/benutzer) → **Einladen** (Recht „Benutzer einladen“).
2. E-Mail-Adresse und Rollen wählen. Angeboten werden die Rollen, deren Rechte du selbst vollständig hast.
3. Den persönlichen Link sicher weitergeben. Er ist einmalig, befristet und lässt sich über das Menü der Person **widerrufen**.

## Rollen ändern oder Konten sperren

Rollen eines Kontos änderst du in der Spalte **Rollen** (Recht „Rollen zuweisen“). Änderungen wirken sofort; offene Sitzungen der Person werden beendet (bei Änderungen am eigenen Konto bleibt die aktuelle Sitzung bestehen). Über das Menü der Zeile lässt sich eine Person auch **umbenennen**, auf allen Geräten abmelden, sperren oder löschen – je nachdem, welche Rechte du hast.

**Gesperrte Konten:** Nach mehreren Fehlversuchen bei Passwort oder Code wird ein Konto für unbekannte Geräte vorübergehend gesperrt (bekannte Geräte der Person sind ausgenommen). Die Liste zeigt dann **Gesperrt** mit Ende der Sperre; **Sperre aufheben** im Menü der Zeile entsperrt sofort, auch für einzelne Geräte.

**Erneute Bestätigung:** Besonders kritische Aktionen verlangen dein Passwort (und bei eingerichteter Zwei-Faktor-Anmeldung einen aktuellen Code), wenn deine letzte Bestätigung länger als 10 Minuten her ist: Rollen anlegen, ändern, zurücksetzen oder löschen, Verwaltungsrechte vergeben oder ein Konto mit Verwaltungsrechten einladen, Zwei-Faktor einer Person zurücksetzen, einen Passwort-Link für ein Konto mit Verwaltungsrechten erzeugen und Sicherheitseinstellungen ändern. Eine Bestätigung gilt danach 10 Minuten für mehrere Aktionen. Per API-Schlüssel sind diese Aktionen nicht möglich. Die betroffene Person bzw. die Administration wird benachrichtigt.

Es bleibt immer mindestens ein aktives Konto mit der Rolle Administration – eine eigene Rolle mit allen Rechten ersetzt sie nicht. Jede Rollenänderung steht mit Person und Zeitpunkt in den [Aktivitäten](/aktivitaeten).

## Rechte im Überblick

Alle Rechte, nach Bereichen. Die Tabelle entspricht dem Rollen-Editor; „Setzt voraus“ nennt die Rechte, die automatisch mit vergeben werden.

<!-- rechte:start -->

**Medien**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Medien ansehen | lesen | Sammlungen, Ordner und geprüfte Medien ansehen, durchsuchen und einzeln in der öffentlichen Fassung (ohne Standort) laden. | – |
| Medien exportieren (ZIP) | lesen | Sammeldownloads der öffentlichen Fassungen als ZIP erstellen und laden. | Medien ansehen |
| Originale herunterladen | ändern | Originaldateien mit möglichen Standortdaten einzeln oder als Sammeldownload laden; Sammeldownloads anderer Personen laden. | Medien ansehen |
| Sammlungen anlegen und bearbeiten | ändern | Sammlungen anlegen, umbenennen, beschreiben und Fristen ändern. Für „Fotos und Videos sammeln“ im Beitrag zusätzlich „Upload-Links verwalten“. | Medien ansehen |
| Dateien hochladen | ändern | Eigene Dateien direkt in eine Sammlung hochladen. | Medien ansehen |
| Upload-Links verwalten | ändern | Upload-Links erstellen, pausieren, verlängern, erneuern und widerrufen; Optionen je Link ändern. | Medien ansehen |
| Medien sichten und auswählen | ändern | Sichtungsstand setzen (ausgewählt, zurückgestellt, übersprungen); Namen der Einsendenden und Einwilligungen sehen. | Medien ansehen |
| Medien ordnen | ändern | Ordner anlegen und umbenennen, Schlagworte vergeben, Dateien beschriften, verschieben, kopieren und sortieren. | Medien ansehen |
| Medien unkenntlich machen | ändern | Bereiche in Bildern unkenntlich machen und Standortdaten je Datei entfernen. | Medien ansehen |
| Medien löschen (Papierkorb) | ändern | Dateien, Ordner und Sammlungen in den Papierkorb legen, Papierkorb ansehen und daraus wiederherstellen. | Medien ansehen |
| Upload-Seite gestalten | ändern | Gestaltung einzelner Upload-Links ändern und Bilder dafür hochladen. | Upload-Links verwalten |
| Medien administrieren | kritisch | Papierkorb endgültig leeren, gesperrte Dateien erneut prüfen oder trotzdem freigeben, Standard-Gestaltung der Upload-Seiten, Sicherheitsereignisse, Speicherübersicht und fehlgeschlagene Medienaufträge. | Medien ansehen |

**Redaktion**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Beiträge ansehen | lesen | Beiträge, Fassungen, Vorlagen und den Veröffentlichungsstand ansehen. | – |
| Beiträge anlegen | ändern | Neue Beiträge anlegen. | Beiträge ansehen |
| Beiträge bearbeiten | ändern | Fassungen schreiben und speichern, Medien übernehmen, Art des Beitrags ändern. | Beiträge ansehen |
| Beiträge einreichen | ändern | Eine Fassung zur Freigabe einreichen. | Beiträge ansehen |
| Beiträge archivieren | ändern | Beiträge archivieren und aus dem Archiv zurückholen. | Beiträge ansehen |
| Vorlagen verwalten | ändern | Textvorlagen anlegen, ändern und löschen. | Beiträge ansehen |
| Quellen ansehen | lesen | Meldungen aus den abonnierten Quellen (RSS) lesen. | – |
| Meldungen aus Quellen bearbeiten | ändern | Meldungen merken oder ausblenden und als Themenidee (Beitragsentwurf) übernehmen. | Quellen ansehen |
| Quellen verwalten | ändern | Quellen (RSS) hinzufügen, ändern, abrufen und löschen. | Quellen ansehen |

**Freigabe**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Beiträge freigeben | kritisch | Eine konkrete Fassung eines Beitrags freigeben oder zurückweisen und eine Freigabe zurücknehmen. | Beiträge ansehen |
| Banner freigeben | kritisch | Eingereichte Banner freigeben oder zurückweisen. | Banner ansehen |
| Einsatzliste freigeben | kritisch | Eingereichte Einträge der Einsatzliste freigeben oder zurückweisen (auch mehrere auf einmal). | Einsatzliste ansehen |
| Freigaben in Workflows erteilen | kritisch | Wartende Freigabeschritte laufender Workflows freigeben oder ablehnen. | – |

**Veröffentlichung**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Auf Website veröffentlichen | kritisch | Freigegebene Fassungen an eine gekoppelte Website übergeben, Aufträge abbrechen, klären und wiederholen. | Beiträge ansehen, Websites ansehen |
| Von Website zurückziehen | kritisch | Veröffentlichte Beiträge von der Website zurückziehen. | Beiträge ansehen |
| In sozialen Kanälen veröffentlichen | kritisch | Freigegebene Fassungen auf Facebook, Instagram (auch als Story), Threads, X, Mastodon und Bluesky veröffentlichen, Teilen von Hand vorbereiten und als geteilt markieren oder als Paket exportieren. | Beiträge ansehen, Verbindungen ansehen |
| Reichweite ansehen | lesen | Aufrufe und Interaktionen veröffentlichter Social-Posts sehen (nur zusammengefasste Zahlen, keine Personen): je Beitrag, Übersicht und Dashboard-Kachel. | Beiträge ansehen |
| Aus sozialen Kanälen entfernen | kritisch | Veröffentlichungen in sozialen Kanälen entfernen oder als entfernt bestätigen. | Beiträge ansehen |
| Websites ansehen | lesen | Gekoppelte Websites und ihren Zustand sehen. | – |
| Websites koppeln und widerrufen | kritisch | Websites mit der BlaulichtCMS Bridge koppeln, Kopplungscodes erzeugen, Schlüssel widerrufen, Plugin laden. | Websites ansehen |
| Bridge-Updates freigeben | kritisch | Neue Versionen der BlaulichtCMS Bridge für die Websites freigeben und den Update-Kanal je Website wählen. | Websites ansehen |

**Banner**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Banner ansehen | lesen | Banner und ihren Stand ansehen. | – |
| Banner bearbeiten | ändern | Banner anlegen, ändern und zur Freigabe einreichen; aus einer amtlichen Warnung einen Bannerentwurf anlegen. | Banner ansehen, Websites ansehen |
| Banner veröffentlichen | kritisch | Freigegebene Banner auf der Website schalten und beenden. | Banner ansehen |

**Kalender**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Kalender ansehen | lesen | Termine, Kategorien und eingelesene Kalender ansehen; geplante Beiträge erscheinen zusätzlich mit „Beiträge ansehen“. | – |
| Termine verwalten | ändern | Eigene Termine und Serien anlegen, ändern und löschen; Kategorien mit Farben verwalten. | Kalender ansehen |
| iCal-Kalender einlesen | ändern | Externe Kalender (iCal-Links) hinzufügen, testen, ändern, abrufen, schalten und löschen; Empfangsprotokoll ansehen. Die Adressen werden verschlüsselt gespeichert und nicht angezeigt. | Kalender ansehen |
| Kalender abonnieren | ändern | Einen eigenen geheimen iCal-Abo-Link (Outlook, Google, iPhone) erzeugen, erneuern, einstellen und widerrufen. Das Abo enthält nur Titel, Zeit und Kategorie, auf Wunsch die Beschreibung. | Kalender ansehen |

**Einsatzliste**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Einsatzliste ansehen | lesen | Einträge der Einsatzliste, ihren Stand auf der Website und die Einstellungen ansehen. | – |
| Einsatzliste bearbeiten | ändern | Einträge anlegen, aus Einsatzmeldungen übernehmen, bearbeiten, importieren (CSV), zur Freigabe einreichen und nicht veröffentlichte Einträge löschen. | Einsatzliste ansehen, Websites ansehen |
| Einsatzliste veröffentlichen | kritisch | Freigegebene Einträge an die Website übergeben und von der Website zurückziehen. | Einsatzliste ansehen, Websites ansehen |
| Einsatzliste einstellen | ändern | Erlaubte Ortsangaben (Datenschutz: nur Ortsteile) und die Standard-Website der Einsatzliste festlegen. | Einsatzliste ansehen |

**Warnentwürfe und amtliche Warnungen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Warnvorgänge ansehen | lesen | Warnvorgänge, Fassungen, PDF, Stichwörter und Zuständigkeiten ansehen. | – |
| Warnentwurf erstellen | ändern | Warnentwürfe erfassen, speichern und zur Freigabe einreichen. | Warnvorgänge ansehen |
| Warnvorgänge löschen | ändern | Eigene, noch nicht freigegebene Warnvorgänge löschen; zusammen mit „Warnentwurf freigeben“ auch fremde und freigegebene. | Warnvorgänge ansehen |
| Versandte Warnvorgänge löschen | kritisch | Bereits versandte Warnvorgänge mit Begründung löschen. | Warnvorgänge löschen |
| Warnstufe bestätigen | kritisch | Den Warnstufen-Vorschlag ausdrücklich bestätigen oder mit Begründung ändern. | Warnvorgänge ansehen |
| Warnentwurf freigeben | kritisch | Eine erzeugte PDF-Fassung eines Warnentwurfs freigeben; Prüffragen und Regeln fachlich freigeben. | Warnvorgänge ansehen |
| Stichwörter und Regeln pflegen | kritisch | Stichwörter (auch Stichwortverzeichnis des Landes übernehmen und eigene Liste importieren), Prüffragen, Warnstufen-Regeln, Vorlagen und Zuständigkeiten pflegen. | Warnvorgänge ansehen |
| Warnentwurf versenden | kritisch | Freigegebene Warnentwürfe per E-Mail an die zuständige Stelle senden und den Versand klären. | Warnvorgänge ansehen |
| Versand einstellen | kritisch | Mailserver, Absender und Testmodus für den Versand von Warnentwürfen einstellen und prüfen. | – |
| Amtliche Warnungen ansehen | lesen | Amtliche Warnungen aus den eingerichteten Warnfeeds sehen. | – |
| Amtliche Warnungen ausblenden | ändern | Amtliche Warnungen als erledigt ausblenden. | Amtliche Warnungen ansehen |

**Presse**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Presseanfragen ansehen | lesen | Presseanfragen mit Kontaktdaten der Anfragenden, Verlauf, Mails und Anhängen ansehen. | – |
| Presseanfragen bearbeiten | ändern | Presseanfragen von Hand erfassen, Status, Zuständigkeit und Frist ändern, mit Einsatz und Beitrag verknüpfen, interne Notizen schreiben und Anfragen löschen. | Presseanfragen ansehen |
| Presseanfragen beantworten | ändern | Antworten per E-Mail schreiben und senden (bei eingeschalteter Freigabe: zur Freigabe einreichen). | Presseanfragen ansehen |
| Antworten an die Presse freigeben | kritisch | Eingereichte Antworten auf Presseanfragen freigeben oder zurückweisen (nie die eigene). | Presseanfragen ansehen |
| Textbausteine verwalten | ändern | Textbausteine für Antworten auf Presseanfragen anlegen, ändern und löschen. | Presseanfragen ansehen |
| Presse-Postfach einrichten | kritisch | Abruf des Presse-Postfachs (IMAP oder Microsoft 365) einrichten, testen, schalten und das Empfangsprotokoll ansehen. | Presseanfragen ansehen |
| Presseverteiler pflegen | ändern | Kontakte von Redaktionen und Verteilerlisten anlegen, ändern, löschen, importieren und exportieren. | – |
| Pressemitteilungen versenden | kritisch | Pressemitteilungen entwerfen und an Verteilerlisten senden; Versandprotokoll ansehen. | Presseverteiler pflegen |

**Verbindungen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Verbindungen ansehen | lesen | Verfügbare Verbindungen mit Namen, Art und Zustand sehen (ohne Zugangsdaten und Einstellungen). | – |
| Verbindungen verwalten | kritisch | Verbindungen (FE2, Feuersoftware Connect, soziale Kanäle, amtliche Warnfeeds) einrichten, ändern, testen, aktivieren und widerrufen. | Verbindungen ansehen |
| Verbindungen löschen | kritisch | Verbindungen löschen und gelöschte Verbindungen zur Nachvollziehbarkeit einsehen. | Verbindungen verwalten |
| Interne Zieladressen erlauben | kritisch | Den Abruf von Adressen im internen Netz für eine Verbindung ausdrücklich erlauben. | Verbindungen verwalten |
| Empfangsprotokoll ansehen | lesen | Empfangsprotokoll eingehender Verbindungen (amtliche Warnungen, FE2, Feuersoftware Connect) mit Entscheidungen und Rohdaten ansehen. | Verbindungen verwalten |

**Workflows**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Workflows ansehen | lesen | Workflows, Eingänge, Ausgänge und Laufprotokolle ansehen. | – |
| Workflows verwalten | ändern | Eingänge, Ausgänge und Workflows anlegen, bearbeiten, testen, aktivieren und deaktivieren. Ausgänge legen nur Entwürfe und Benachrichtigungen an; Freigaben bleiben bei den Menschen. | Workflows ansehen |
| Workflows direkt veröffentlichen lassen | kritisch | Einem Workflow erlauben, markierte Ausgänge ohne menschliche Freigabe zu veröffentlichen bzw. zu versenden (mit Passwortbestätigung, Audit und Sicherheitsmeldung). | Workflows verwalten |

**Designvorlagen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Designvorlagen ansehen | lesen | Interne Vorlagen-Bibliothek durchsuchen, Vorlagen mit Nutzungshinweisen ansehen und ihre Dateien (auch ältere Versionen) herunterladen. | – |
| Bilder aus Vorlagen erzeugen | ändern | Befüllbare Bildvorlagen ausfüllen und das erzeugte Bild in den Medien ablegen (auch im Beitragseditor). | Designvorlagen ansehen, Dateien hochladen |
| Designvorlagen verwalten | ändern | Vorlagen und Kategorien anlegen, ändern und löschen, neue Versionen und Dateien hochladen, Bildvorlagen im Editor gestalten und eigene Schriften hochladen. | Designvorlagen ansehen |

**Benutzer und Rollen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Benutzer ansehen | lesen | Benutzerliste, Rollen und deren Rechte ansehen. | – |
| Benutzer einladen | kritisch | Konten einladen, Einladungen und Passwort-Links ausstellen und widerrufen. | Benutzer ansehen |
| Benutzer umbenennen | ändern | Anzeigenamen von Konten ändern. | Benutzer ansehen |
| Rollen zuweisen | kritisch | Rollen von Konten ändern – höchstens Rollen, deren Rechte man selbst vollständig hat. | Benutzer ansehen |
| Konten sperren und entsperren | kritisch | Konten deaktivieren und reaktivieren, Sperren nach Fehlversuchen aufheben, Zwei-Faktor-Anmeldung zurücksetzen. | Benutzer ansehen |
| Sitzungen beenden | ändern | Ein Konto auf allen Geräten abmelden und gemerkte Geräte entfernen. | Benutzer ansehen |
| Benutzer löschen | kritisch | Konten endgültig löschen. | Benutzer ansehen |
| Rollen verwalten | kritisch | Eigene Rollen anlegen, Rechte von Rollen ändern, Rollen löschen – höchstens mit Rechten, die man selbst hat. | Benutzer ansehen |

**System und Protokolle**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Systemstatus ansehen | lesen | Zustand der Dienste, Warteschlange, Speicher und Version ansehen. | – |
| Systemprotokoll ansehen | lesen | Technische Protokolle (Fehler, Warnungen) ansehen. | – |
| Audit-Protokoll ansehen | lesen | Wer hat wann was geändert; Unversehrtheit des Protokolls prüfen. | – |
| Sicherungen erstellen | kritisch | Sicherungen ansehen, erstellen und den Zeitplan einstellen. | Einstellungen ansehen |
| Sicherungen herunterladen | kritisch | Sicherungsdateien (gesamter Datenbestand) herunterladen. | Sicherungen erstellen |
| Updates ansehen | lesen | Installierte und verfügbare Version sowie den Verlauf der Updates ansehen. | – |
| Updates einstellen und installieren | kritisch | Nach Updates suchen, Update-Einstellungen ändern, Vorabprüfung ausführen und Updates installieren. | Updates ansehen |
| Wartungsmodus schalten | kritisch | Den Wartungsmodus ein- und ausschalten. | Systemstatus ansehen |
| Löschfristen sofort anwenden | kritisch | Die eingestellten Löschfristen sofort anwenden, statt auf den nächtlichen Lauf zu warten. | Einstellungen ansehen |
| Datenschutzanfragen bearbeiten | kritisch | Personenbezogene Daten über alle Bereiche suchen, als Auskunft exportieren und je Treffer löschen oder pseudonymisieren (Art. 15/17 DSGVO). | – |
| Dashboard-Vorlagen speichern | ändern | Gemeinsame Dashboards für alle oder für einzelne Rollen speichern. | – |

**Einstellungen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Einstellungen ansehen | lesen | Alle Einstellungen und die Vorschau der Löschfristen ansehen (ohne Passwörter). | – |
| Allgemeine Einstellungen ändern | ändern | Name der Instanz, Organisation, Bundesland (Stichwortverzeichnis), Adresse, Zeitzone. | Einstellungen ansehen |
| Sicherheitseinstellungen ändern | kritisch | Zwei-Faktor-Pflicht, Sitzungen, Kontosperre, Passwortlänge, Sicherheitsmeldungen, Gültigkeit von Einladungen, interne Zieladressen. | Einstellungen ansehen |
| Datenschutzeinstellungen ändern | kritisch | Löschfristen, Aufbewahrung der Protokolle, Angaben zu Verantwortlichen, Datenschutzhinweise, Datenschutzerklärung und Impressum. | Einstellungen ansehen |
| Medieneinstellungen ändern | ändern | Dateigrößen, erlaubte Dateitypen, Vorgaben für Upload-Links, Prüftiefe und Speichergrenzen. | Einstellungen ansehen |
| Redaktionseinstellungen ändern | kritisch | Vier-Augen-Prinzip und weitere Vorgaben für Redaktion und Freigabe. | Einstellungen ansehen |
| E-Mail-Versand und Push einstellen | kritisch | Weg für E-Mails wählen (SMTP oder Microsoft 365), Microsoft 365 einrichten und prüfen, Push- und E-Mail-Benachrichtigungen global schalten. | Einstellungen ansehen |
| Systemeinstellungen ändern | ändern | Parallele Aufträge, Ausführung der Workflows und weitere technische Einstellungen. | Einstellungen ansehen |

<!-- rechte:ende -->

## Nach dem Update auf 0.3.0

Bis Version 0.2 gab es rund 20 grobe Rechte (z. B. „Medien verwalten“). Sie wurden in die feinen Rechte oben aufgeteilt. Alle mitgelieferten Rollen behalten genau ihre bisherigen Möglichkeiten, bestehende Konten müssen nichts tun. Neu und nur bei der Administration: „Rollen verwalten“, „Interne Zieladressen erlauben“ und „Versandte Warnvorgänge löschen“.
