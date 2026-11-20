Verbindungen sind **optional**. BlaulichtCMS funktioniert vollständig ohne. Jede Verbindung durchläuft dieselben vier Schritte unter [Verbindungen](/verbindungen):

1. **Verbinden** – Einstellungen und Zugangsdaten. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.
2. **Testen** – zeigt jeden Prüfschritt mit Ergebnis. Eine erfolgreiche Anmeldung allein ist **kein** Veröffentlichungstest.
3. **Vorschau** – welche Funktionen das Konto tatsächlich bietet und wie Daten ankommen würden.
4. **Aktivieren** – erst nach bestandenem Test. Anhalten, Widerrufen und Löschen sind jederzeit möglich.

## Eingehend und Veröffentlichen

Die Seite trennt nach Richtung – wichtig auch für den Datenschutz (was kommt an, was geht an wen hinaus, z. B. an Dienste in Drittländern):

- **Eingehend – Einsätze und Warnungen:** FE2, Feuersoftware Connect und amtliche Warnungen. BlaulichtCMS empfängt Daten und legt daraus interne Entwürfe bzw. Hinweise an.
- **Veröffentlichen – Websites und soziale Netzwerke:** Facebook, Instagram, Threads, X, Mastodon, Bluesky und WhatsApp-Kanal. Dazu stehen hier auch die gekoppelten **Websites** (WordPress) – gekoppelt werden sie über **Neue Verbindung → Website (WordPress)**, verwaltet unter [Verbindungen → Websites](/verbindungen/websites).

**Neue Verbindung:** Der Dialog zeigt dieselben zwei Abschnitte; vorausgewählt ist nichts. Der Name wird aus Art und Organisation vorgeschlagen (z. B. „Facebook-Seite Musterwehr“) und lässt sich ändern; das später verbundene Konto erscheint in der Liste unter dem Namen.

## Test und Aktivierung

Eine Verbindung lässt sich nur mit einem **bestandenen Test der aktuellen Einstellungen** aktivieren.

- Ändern sich Einstellungen oder Zugangsdaten, verwirft BlaulichtCMS den letzten Test und setzt die Verbindung auf **Entwurf** – auch eine aktive oder angehaltene. Vor dem Speichern an einer aktiven Verbindung fragt BlaulichtCMS nach: Sie verarbeitet bis zum neuen Test und zur erneuten Aktivierung keine Meldungen und veröffentlicht nichts.
- Dazu zählen: Quelle, Regionalschlüssel, Gebietsfilter, Feldzuordnung, App-ID, App-Geheimnis, Token, gewählte Seite, eine neue Anmeldung bei Meta, ein neuer FE2-Zugangsschlüssel sowie API-Key, RICs und Stichwörter bei Feuersoftware Connect.
- **Ohne neuen Test** änderbar sind der Name, das Abrufintervall bzw. der Abrufabstand, „Beitragsentwürfe anlegen“ und die automatischen Banner (die haben eigene Voraussetzungen, siehe [unten](#automatische-banner-und-pruefliste)).
- Eine angehaltene Verbindung mit unveränderten Einstellungen lässt sich ohne neuen Test wieder aktivieren.
- Jede Rücksetzung steht im Audit-Protokoll („Neuer Test nötig“ mit vorherigem Status und Grund).

## Empfangsprotokoll

Bei **amtlichen Warnungen**, **FE2** und **Feuersoftware Connect** zeigt die Verbindung neben den vier Schritten ein **Empfangsprotokoll**: Was ist bei BlaulichtCMS angekommen, und was wurde daraus? Auf der Seite [Amtliche Warnungen](/amtliche-warnungen) führt **Was ist angekommen?** direkt dorthin (Recht „Verbindungen verwalten“).

- **Ein Eintrag je Abruf bzw. eingehender Meldung**, neueste zuerst: Zeit, Auslöser (planmäßiger Abruf, „Jetzt abrufen“, eingehende Meldung, Test), Ergebnis (OK oder die Fehlermeldung), HTTP-Status, Dauer und wie viele Meldungen empfangen, übernommen und herausgefiltert wurden. Die Liste aktualisiert sich selbst, solange sie offen ist.
- **Aufklappen** zeigt jede einzelne Meldung – auch die aussortierten – mit den wichtigsten Angaben (bei Warnungen Herausgeber wie DWD, MoWaS oder Hochwasserportal, Überschrift, Stufe, Art, Gebiete, Gültigkeit, Kennung; bei Einsätzen Stichwort, Einsatzart, Ort, Alarmzeit, RIC, Kennung) und der **Entscheidung mit Grund**:

| Entscheidung | Bedeutung |
|---|---|
| übernommen | neu angelegt – Warnung angezeigt (ggf. mit Banner) bzw. Einsatz mit Beitragsentwurf |
| Aktualisierung | ersetzt eine bekannte Meldung (Aktualisierung, Entwarnung, Folgemeldung eines Einsatzes) |
| schon bekannt | kam bereits bei einem früheren Abruf, unverändert |
| herausgefiltert | aussortiert, mit Grund: „Gebiet passt nicht: …“, „RIC nicht in der Liste: …“, „Stichwort nicht in der Liste: …“, „Älter als 24 Stunden“, „Schon ersetzt“ |
| ausgeblendet | unter „Amtliche Warnungen“ ausgeblendet, wird nicht erneut angezeigt |
| gesperrt | Einsatz wurde früher übernommen und inzwischen gelöscht – wird nicht neu angelegt |
| Test | Verbindungstest bzw. Testmeldung – nichts angelegt |
| Fehler | Meldung nicht lesbar, nicht abrufbar oder Verarbeitung fehlgeschlagen – nur diese eine; die übrigen Meldungen des Abrufs werden trotzdem verarbeitet |

- **Rohdaten anzeigen** öffnet die Meldung als JSON (mit Kopieren-Knopf). Amtliche Warnungen stehen vollständig da, wie die Quelle sie liefert. Bei FE2 und Feuersoftware sind die Rohdaten **geschwärzt**: Stichwort, Einsatzart, Ort, Zeiten, Status, RIC, Einheiten und die Felder der Feldzuordnung bleiben lesbar; Straße, Hausnummer, Koordinaten, Namen, Telefonnummern, meldende Person und Freitext erscheinen nur als „‹ausgeblendet …›“.
- Der Filter **Anzeigen** beschränkt die Liste auf übernommene, herausgefilterte oder fehlerhafte Einträge.

**Filter einstellen mit dem Protokoll:**

- *Eigene Warnung fehlt:* Eintrag mit „herausgefiltert – Gebiet passt nicht“ suchen. Der Grund nennt Geocodes und Orte der Meldung und die eingestellten Werte. Den passenden Ortsnamen oder Geocode-Präfix unter **Verbinden** ergänzen (siehe [Regionalschlüssel und Gebietsfilter](#regionalschluessel-und-gebietsfilter)).
- *Zu viele Warnungen:* bei „übernommen“ steht, welcher Filter gegriffen hat (z. B. „Ortsname … in …“) – zu allgemeine Ortsnamen enger fassen.
- *Feuersoftware übernimmt den eigenen Einsatz nicht:* „RIC nicht in der Liste“ nennt die RIC, wie Connect sie liefert – genau diese Schreibweise unter **RICs** eintragen (siehe [Feuersoftware: Filter](#feuersoftware-filter)).
- *FE2 meldet „Keine Einsatz-ID gefunden“:* in den Rohdaten die Feldnamen der Meldung ablesen und die [Feldzuordnung](#feldzuordnung) anpassen. Fehlversuche mit falschem Schlüssel stehen ebenfalls im Protokoll (ohne Inhalt, höchstens einer je Minute).

Das Protokoll hält die Einträge der letzten **7 Tage** (*Einstellungen → Löschfristen*, 1–30 Tage), höchstens 500 je Verbindung; sehr große Rohdaten werden gekürzt gespeichert.

## Widerrufen und löschen

Beides steht in der Verbindung unter Schritt **Aktivieren** und braucht das Recht „Verbindungen verwalten“. Jede Aktion steht im Audit-Protokoll.

- **Widerrufen** löscht die Zugangsdaten; die Verbindung bleibt sichtbar und lässt sich nicht wieder aktivieren.
- **Löschen** entfernt eine Verbindung, die **nie verwendet** wurde, endgültig samt Zugangsdaten.
- Wurde sie verwendet – Veröffentlichungen auf einem sozialen Netzwerk, Veröffentlichungsziel in einer Beitragsfassung, Einsatzmeldungen aus FE2 oder Feuersoftware Connect, amtliche Warnungen –, wird sie stattdessen **widerrufen, ihre Zugangsdaten werden gelöscht** und sie verschwindet aus den Listen. Der Veröffentlichungsverlauf und andere Bezüge bleiben erhalten und zeigen „Verbindung gelöscht“. Abrufe, der FE2-Eingang und Veröffentlichungen ignorieren sie.
- Der Bestätigungsdialog nennt vorher, welcher der beiden Fälle eintritt.
- Wer „Verbindungen löschen“ hat, kann unter Verbindungen mit **Gelöschte anzeigen** auch widerrufene und gelöschte Verbindungen einsehen.

## Facebook-Seite und Instagram-Konto

Facebook-Seite und Instagram-Konto sind **zwei getrennte Verbindungen** mit eigener Meta-App-Anbindung, eigenem Test und eigenem Status. BlaulichtCMS nutzt die Graph API in Version **v27.0**.

**Voraussetzungen**

- Eine **Facebook-Seite**, auf der das eigene Facebook-Konto die Seite verwalten darf, bzw. ein **professionelles Instagram-Konto** (Unternehmen oder Creator) – private Konten können nicht über die Schnittstelle veröffentlichen.
- Ein **Meta-Entwicklerkonto** unter [developers.facebook.com](https://developers.facebook.com/) mit dem Konto, das die Seite verwaltet.
- BlaulichtCMS unter einer **öffentlichen HTTPS-Adresse** (Einstellungen → Organisation → Öffentliche Adresse). Meta leitet nach der Anmeldung dorthin zurück; Instagram lädt Bilder und Videos selbst von dort ab.

### Meta-App anlegen

1. Unter [App erstellen](https://developers.facebook.com/docs/development/create-an-app/) eine neue App anlegen: App-Name und Kontakt-E-Mail eintragen.
2. Als **Anwendungsfall** für Facebook „Seiten verwalten“ bzw. Facebook Login for Business, für Instagram die „Instagram API“ (API mit Instagram Login) wählen. Meta ändert die Bezeichnungen gelegentlich – maßgeblich sind die Berechtigungen unten.
3. Die App bei Bedarf einem **Business-Portfolio** der Organisation zuordnen (für die spätere Unternehmensverifizierung und App-Prüfung).

### App-ID und App-Geheimnis

- **Facebook:** App-ID und App-Geheimnis stehen im App-Dashboard unter **App-Einstellungen → Allgemein** ([Grundeinstellungen](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/)).
- **Instagram:** Die **Instagram-App-ID** und das **Instagram-App-Geheimnis** stehen unter **Instagram → API setup with Instagram login → Set up Instagram business login → Business login settings** ([Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)) – nicht die Facebook-App-ID verwenden.
- In BlaulichtCMS: App-ID eintragen, **Einstellungen speichern**, App-Geheimnis eintragen, **Geheimnis speichern**.

### Weiterleitungsadresse eintragen

BlaulichtCMS zeigt in der Verbindung die **Weiterleitungsadresse** (`https://<eigene Adresse>/api/v1/connections/oauth/callback`). Sie muss in der Meta-App **exakt** so eingetragen sein:

- **Facebook:** Facebook Login for Business → Einstellungen → Client-OAuth-Einstellungen → **Gültige OAuth-Weiterleitungs-URIs** ([Anleitung](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/)).
- **Instagram:** Instagram → API setup with Instagram login → Business login settings → **OAuth redirect URIs**.

### Berechtigungen

| Netzwerk | Berechtigungen | Wofür |
|---|---|---|
| Facebook | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` | Seiten auflisten, Beiträge anlegen und löschen, Beiträge lesen (Prüfung auf Duplikate) |
| Instagram | `instagram_business_basic`, `instagram_business_content_publish` | Konto lesen, Beiträge veröffentlichen |

Beschreibung aller Rechte: [Berechtigungsreferenz](https://developers.facebook.com/docs/permissions/).

### Facebook-Seite verbinden

1. **Mit Facebook verbinden** – Meta fragt nach Konto, Seiten und Berechtigungen. Alle angefragten Rechte bestätigen.
2. Zurück in BlaulichtCMS unter **Seite** die gewünschte Seite wählen.
3. **Testen:** BlaulichtCMS legt einen *unveröffentlichten* Beitrag an und löscht ihn sofort wieder.

### Instagram-Konto verbinden

1. Das Instagram-Konto in der Instagram-App auf ein **professionelles Konto** umstellen (Unternehmen oder Creator). Die Verknüpfung mit einer Facebook-Seite ist für die API mit Instagram Login nicht nötig.
2. **Mit Instagram verbinden** und mit dem Instagram-Konto anmelden.
3. **Testen:** BlaulichtCMS legt einen Mediencontainer mit einem fest eingebauten, neutralen Testbild (graue Fläche) an und prüft die Verarbeitung – ohne zu veröffentlichen. Fotos aus Uploads werden für den Test nie verwendet. Meta muss das Bild über die öffentliche HTTPS-Adresse abrufen können ([Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)).

### Token manuell hinterlegen

Statt der Anmeldung lässt sich unter **Alternativ: Token manuell hinterlegen** ein vorhandener **Seiten-Token** (mit Seiten-ID) bzw. **Instagram-Token** eintragen, z. B. aus dem Graph-API-Explorer. Der Token braucht dieselben Berechtigungen. Kurzlebige Token laufen nach Stunden ab – die Anmeldung über **Mit Facebook/Instagram verbinden** tauscht sie automatisch gegen langlebige. Bei einem manuellen Seiten-Token kann der Test die Berechtigungen nicht abfragen.

### Entwicklungsmodus, Live-Modus und App-Prüfung

- Im **Entwicklungsmodus** funktioniert die App nur mit Konten, die in der App eine **Rolle** haben (Administrator, Entwickler, Tester – [App-Rollen](https://developers.facebook.com/docs/development/build-and-test/app-roles/)). Für eine eigene Seite, die von diesen Personen verwaltet wird, reicht das oft.
- Im **Live-Modus** sind nur Berechtigungen nutzbar, die Meta in der **App-Prüfung** freigegeben hat ([App-Modi](https://developers.facebook.com/docs/development/build-and-test/app-modes/), [Zugriffsstufen und App-Prüfung](https://developers.facebook.com/docs/graph-api/overview/access-levels/)). Dafür verlangt Meta in der Regel eine Unternehmensverifizierung.
- Den Live-Test mit einer Testseite bzw. einem Testkonto machen, bevor die echte Seite verbunden wird.

### Typische Fehler (Meta)

| Meldung | Ursache und Abhilfe |
|---|---|
| „URL blocked“ / Weiterleitungsadresse ungültig | Weiterleitungsadresse in der App fehlt oder weicht ab (http statt https, Schrägstrich, andere Domain). |
| „Invalid Scopes: pages_manage_posts, read_insights …“ | Die Rechte sind in der Meta-App nicht hinzugefügt. Unter **Anwendungsfälle → „Alles auf deiner Seite verwalten“ → Anpassen → Berechtigungen** (bzw. bei Unternehmens-Apps **App-Prüfung → Berechtigungen und Funktionen**) `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` und `read_insights` hinzufügen; fehlt der Anwendungsfall, ihn über **Anwendungsfall hinzufügen** ergänzen. Danach erneut verbinden. |
| „Die Domain dieser URL ist nicht in den Domains der App vorhanden“ | Unter **App-Einstellungen → Allgemein → App-Domains** die Domain von BlaulichtCMS eintragen (ohne `https://`), dort ggf. **Plattform hinzufügen → Website** mit der öffentlichen Adresse als Website-URL; speichern und erneut verbinden. |
| „Angemeldet, aber keine verwaltbare Seite gefunden“ | Bei der Anmeldung keine Seite freigegeben oder das Konto verwaltet die Seite nicht. Erneut verbinden und die Seite auswählen. |
| Berechtigungen: „Es fehlen …“ | Rechte bei der Anmeldung abgewählt oder in der App nicht hinzugefügt bzw. (im Live-Modus) nicht geprüft. |
| „ist kein professionelles Konto“ | Instagram-Konto auf Unternehmen oder Creator umstellen. |
| Instagram: Container-Status ERROR | Meta konnte das Testbild nicht laden: Öffentliche Adresse prüfen (HTTPS, von außen erreichbar, kein Zugriffsschutz). |
| Später „Token abgelaufen“ | Passwort geändert, App-Rechte entzogen oder Token abgelaufen: **Mit Facebook/Instagram verbinden** erneut ausführen, testen, aktivieren. |

### Im Beitrag veröffentlichen

Im Beitrag unter **Soziale Netzwerke** die Netzwerke wählen (optional mit eigenem Text, bei Facebook und Instagram mit Format **Beitrag**, **Story** oder **Beitrag und Story**). Auswahl und Format sind Teil der Fassung – eine Änderung braucht eine neue Freigabe. Nach der Freigabe: **Auf sozialen Netzwerken veröffentlichen**. Dasselbe gilt für [Threads](#threads), [X](#x) und den [WhatsApp-Kanal](#whatsapp-kanal).

| Status | Bedeutung |
|---|---|
| Veröffentlicht | mit Link zum Beitrag (Storys haben keinen festen Link) |
| Fehlgeschlagen | eindeutig abgelehnt – **nur dieses Netzwerk** lässt sich erneut versuchen |
| Ergebnis unbekannt | Verbindung brach ab; vor einem neuen Versuch prüft BlaulichtCMS, ob der Beitrag schon existiert |
| Zum Teilen bereit | Netzwerk ohne Schnittstelle (X im Modus „Teilen von Hand“, WhatsApp-Kanal): Text und Dateien sind vorbereitet, siehe [Teilen von Hand](#teilen-von-hand) |

Längen je Netzwerk: Instagram höchstens **2 200 Zeichen**, Facebook und WhatsApp-Kanal **60 000**; Threads, X, Mastodon und Bluesky siehe dort. Ist ein Text länger, kürzt BlaulichtCMS ihn mit „…“ an einer Zeichengrenze – nie mitten in einem Emoji – und der angehängte Link zur Website bleibt immer vollständig.

### Storys

Für Facebook-Seiten und Instagram-Konten lässt sich je Netzwerk **Story** oder **Beitrag und Story** wählen. BlaulichtCMS nutzt dafür die offiziellen Schnittstellen von Meta – dieselbe Meta-App und dieselben Berechtigungen wie für Beiträge, nichts zusätzlich einzurichten ([Instagram: Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Facebook: Page Stories](https://developers.facebook.com/docs/page-stories-api/)).

- Eine Story zeigt **eine Datei** – verwendet wird die erste Datei des Beitrags. Storys haben **keinen Text**; ein eigener Text für Facebook bzw. Instagram gilt nur für den Beitrag.
- **Bilder** bringt BlaulichtCMS automatisch auf das empfohlene Hochformat **9:16 (1080 × 1920)**: nichts wird abgeschnitten, der Rand wird unscharf aus dem Bild selbst gefüllt. Grundlage ist die geprüfte öffentliche Fassung (Unkenntlichmachungen bleiben, Metadaten sind entfernt).
- **Videos** gehen unverändert hinaus: am besten im Hochformat, 3 bis 60 Sekunden, MP4. WebM wird nicht unterstützt.
- Storys verschwinden nach 24 Stunden von selbst. Über die Schnittstellen lassen sie sich **nicht löschen** – beim Entfernen zeigt BlaulichtCMS den Hinweis, die Story in Facebook bzw. Instagram zu löschen und das zu bestätigen.
- Die Formatprüfung im Beitrag (**Soziale Netzwerke – Status**) zeigt vor der Freigabe, was mit Bild oder Video passiert.

### Von sozialen Netzwerken entfernen

Muss ein Beitrag wieder weg (z. B. Widerspruch einer abgebildeten Person), im Beitrag unter **Soziale Netzwerke – Status** auf **Von sozialen Netzwerken entfernen** gehen und einen Grund angeben. Der Dialog zeigt danach je Netzwerk, was passiert ist:

| Netzwerk | Ablauf |
|---|---|
| Facebook | BlaulichtCMS löscht den Beitrag über die Schnittstelle. Schlägt das fehl (z. B. Verbindung widerrufen), steht ein Hinweis mit Link zum Beitrag beim Netzwerk. |
| Instagram | Die Schnittstelle von Instagram erlaubt **kein Löschen**. BlaulichtCMS zeigt einen Link zum Beitrag: dort in Instagram löschen und anschließend **Gelöscht – bestätigen** wählen. |
| Storys | Lassen sich über die Schnittstellen nicht löschen (sie verschwinden nach 24 Stunden): in Facebook bzw. Instagram löschen und bestätigen. |
| Threads | Von Hand in Threads löschen und bestätigen. |
| Mastodon, Bluesky | BlaulichtCMS löscht den Beitrag über die Schnittstelle. |
| X | Über die X-API Gepostetes löscht BlaulichtCMS über die Schnittstelle; von Hand Geteiltes von Hand löschen und bestätigen. |
| WhatsApp-Kanal | Von Hand im Kanal löschen und bestätigen. |

Noch nicht ausgeführte oder fehlgeschlagene Aufträge werden dabei abgebrochen. Antrag, Löschung und Bestätigung stehen im Audit-Protokoll. **Von der Website zurückziehen** wirkt nur auf WordPress – beides ist getrennt anzustoßen. Kopien, die andere bereits geteilt oder gespeichert haben, erreicht BlaulichtCMS nicht.

**Manuell exportieren** liefert den freigegebenen Text je Netzwerk und befristete Links zu den Dateien. Die Dateien heißen neutral nach dem Beitragstitel (z. B. `brand-in-der-altstadt-1.jpg`), nie wie die hochgeladene Datei – deren Name kann Namen oder Orte enthalten.

### Datenschutz bei Facebook und Instagram

Die folgenden Punkte sind Hinweise zur Orientierung, keine Rechtsberatung. Die Bewertung trifft die verantwortliche Stelle, am besten zusammen mit der oder dem Datenschutzbeauftragten. Grundlagen und Vorlagen: `docs/datenschutz.md` im Repository.

- **Empfänger:** Mit dem Veröffentlichen gehen Text, Bilder und Videos an **Meta Platforms** (Vertragspartner in der EU ist Meta Platforms Ireland; verarbeitet wird auch in den USA). Für Instagram ruft Meta die Dateien selbst über eine befristete Adresse bei BlaulichtCMS ab. Was auf abgebildeten Personen zu sehen ist, wird damit öffentlich und liegt auch bei Meta.
- **Drittland:** Für die Übermittlung in die USA ist die Grundlage zu prüfen, z. B. die Zertifizierung von Meta nach dem EU-US Data Privacy Framework (Liste unter dataprivacyframework.gov). Ändert sich diese Grundlage, die Nutzung neu bewerten.
- **Gemeinsame Verantwortung:** Für eine Facebook-Seite (Seiten-Insights) besteht nach der Rechtsprechung des EuGH eine gemeinsame Verantwortlichkeit mit Meta (Art. 26 DSGVO). Meta stellt dafür die *Seiten-Insights-Ergänzung bezüglich des Verantwortlichen* bereit; sie sollte geprüft und dokumentiert sein. Für Instagram-Konten gilt Entsprechendes.
- **Datenschutzerklärung:** Die Präsenz auf Facebook bzw. Instagram, die Übermittlung an Meta und die gemeinsame Verantwortung gehören in die Datenschutzerklärung der Website bzw. der Seite. Auf der Upload-Seite weist BlaulichtCMS auf die mögliche Veröffentlichung in sozialen Medien hin (*Einstellungen → Datenschutz & Recht*).
- **Löschen:** Nach einem Widerspruch den Beitrag über **Von sozialen Netzwerken entfernen** zurückziehen (siehe oben): Facebook-Beiträge löscht BlaulichtCMS, Instagram-Beiträge müssen in Instagram gelöscht werden. Kopien bei Dritten (geteilte Beiträge, Screenshots) sind damit nicht erreicht.
- **BlaulichtCMS selbst** gibt an Meta nur die freigegebenen Inhalte und die neutral benannten Dateien weiter, keine Hinweise der hochladenden Personen und keine Originale.

## Threads

Threads wird über die **offizielle Threads-Schnittstelle** von Meta angebunden ([Threads-API](https://developers.facebook.com/docs/threads/)). Veröffentlicht werden Text, Bilder (mehrere als Karussell), Videos und – bei Beiträgen ohne Datei – der Link zur Website als Linkvorschau. Texte haben höchstens **500 Zeichen**; Emojis zählen dabei mehrfach. Ist der Text länger, kürzt BlaulichtCMS ihn mit „…“ – ein eigener Text für Threads im Beitrag ist dann besser.

**Einrichten**

1. Unter [developers.facebook.com](https://developers.facebook.com/) eine Meta-App mit dem Anwendungsfall **Access the Threads API** anlegen (oder einer vorhandenen App hinzufügen) und dort das Recht `threads_content_publish` hinzufügen; `threads_basic` ist immer dabei ([Anwendungsfall Threads](https://developers.facebook.com/docs/development/create-an-app/threads-use-case)).
2. Im Anwendungsfall unter **Einstellungen** die **Weiterleitungsadresse** aus BlaulichtCMS eintragen (Redirect Callback URLs). Dort stehen auch **Threads-App-ID** und **Threads-App-Geheimnis** – eine Meta-App hat dafür eigene Werte; nicht die App-ID oben im Dashboard verwenden.
3. Solange die App nicht von Meta geprüft ist, das eigene Threads-Profil als **Threads-Tester** hinzufügen (App-Rollen → Personen hinzufügen) und die Einladung in Threads unter Einstellungen → Konto → Website-Berechtigungen annehmen ([Threads: Erste Schritte](https://developers.facebook.com/docs/threads/get-started)).
4. In BlaulichtCMS unter **Verbindungen → Neue Verbindung → Threads-Profil** App-ID speichern, Geheimnis speichern, **Mit Threads verbinden**.
5. **Testen:** BlaulichtCMS liest Profil und Tageskontingent und legt einen Text-Container an, ohne ihn zu veröffentlichen (er verfällt nach 24 Stunden). Danach **Aktivieren**.

Die Anmeldung gilt 60 Tage; BlaulichtCMS verlängert sie rechtzeitig selbst. Klappt das nicht (z. B. Rechte entzogen), meldet BlaulichtCMS es der Verwaltung – dann erneut verbinden und testen. Löschen über die Schnittstelle bietet BlaulichtCMS für Threads nicht an: beim Entfernen von Hand löschen und bestätigen.

## X

X lässt sich auf zwei Wegen anbinden – umschaltbar in der Verbindung mit **Über die X-API posten**:

| Betriebsart | Was passiert | Voraussetzung |
|---|---|---|
| **Teilen von Hand** (Standard) | BlaulichtCMS bereitet den Text vor (höchstens **280 Zeichen** nach den Zählregeln von X, jede Adresse zählt 23), hängt den Link zur Website an und öffnet das Beitragsfenster von x.com mit eingetragenem Text. Danach den Beitrag als geteilt markieren, siehe [Teilen von Hand](#teilen-von-hand). | keine – nur ein X-Konto |
| **Über die X-API posten** | BlaulichtCMS postet selbst: Text und bis zu 4 Bilder (Videos nicht). Beim Entfernen löscht BlaulichtCMS den Beitrag über die Schnittstelle. | eigene App in der Developer Console von X, **kostenpflichtig** |

**Kosten:** Das Posten über die X-API ist kostenpflichtig. X rechnet nutzungsabhängig über Guthaben in der Developer Console ab; ohne Guthaben lehnt X Beiträge ab ([Preise der X-API](https://docs.x.com/x-api/getting-started/pricing)). Wer nur gelegentlich postet, fährt mit **Teilen von Hand** kostenlos.

**X-API einrichten**

1. In der [Developer Console von X](https://docs.x.com/x-api/getting-started/getting-access) eine App anlegen.
2. Unter **User authentication settings** die App-Berechtigung **Read and write** setzen.
3. Unter **Keys and tokens** **API Key** und **API Key Secret** ablesen und für das eigene Konto **Access Token** und **Access Token Secret** erzeugen ([Developer Apps](https://docs.x.com/fundamentals/developer-apps)). Wurde die Berechtigung nachträglich geändert, Access Token und Secret neu erzeugen.
4. In BlaulichtCMS **Über die X-API posten** einschalten, die vier Werte eintragen und **Zugangsdaten speichern** – sie werden verschlüsselt gespeichert und nie wieder angezeigt. BlaulichtCMS meldet sich damit nach OAuth 1.0a im Benutzerkontext an.
5. **Testen:** BlaulichtCMS liest das Konto und prüft die Zugriffsstufe des Tokens (Schreibrecht). Einen Testbeitrag legt BlaulichtCMS nicht an – er wäre öffentlich sichtbar und kostet Guthaben. Danach **Aktivieren**.

## Mastodon

Mastodon ist ein kostenloses, dezentrales Netzwerk: Jede **Instanz** (Server) hat eine eigene Adresse – viele Behörden nutzen z. B. [social.bund.de](https://social.bund.de/). BlaulichtCMS nutzt die offizielle [Mastodon-API](https://docs.joinmastodon.org/methods/statuses/) der gewählten Instanz. Veröffentlicht werden Text, bis zu 4 Bilder **mit Alternativtext** oder ein Video sowie der Link zur Website. Die Höchstlänge legt die Instanz fest (meist **500 Zeichen**; jede Adresse zählt 23). Ist der Text länger, kürzt BlaulichtCMS ihn mit „…“.

**Einrichten**

1. Unter **Verbindungen → Neue Verbindung → Mastodon-Konto** die **Adresse der Instanz** eintragen (nur `https://…` ohne Pfad – sie steht im Profil hinter dem Benutzernamen: `@feuerwehr@social.example` → `https://social.example`), Sichtbarkeit wählen und speichern.
2. **Mit Mastodon verbinden:** BlaulichtCMS registriert sich selbst als App auf der Instanz (mit der angezeigten Weiterleitungsadresse) und leitet zur Anmeldung weiter. Dort mit dem Konto anmelden und **Autorisieren**. Die Rechte sind `read:accounts read:statuses write:statuses write:media`.
3. **Alternativ:** In Mastodon unter **Einstellungen → Entwicklung → Neue Anwendung** eine Anwendung mit denselben Rechten anlegen und den **Zugangstoken** in BlaulichtCMS hinterlegen ([Mastodon-Doku](https://docs.joinmastodon.org/client/token/)).
4. **Testen:** BlaulichtCMS liest Konto und Grenzen der Instanz, legt einen **geplanten** Beitrag (nur für Erwähnte, einen Tag in der Zukunft) an und löscht ihn sofort wieder und lädt ein neutrales Testbild mit Alternativtext hoch, ohne es zu veröffentlichen. Öffentlich erscheint dabei nichts. Danach **Aktivieren**.

**Instanz wechseln:** Zugangstoken und App-Registrierung gelten nur für die Instanz, für die sie ausgestellt wurden. Wird die Adresse der Instanz geändert, verwirft BlaulichtCMS beides beim Speichern – danach erneut **Mit Mastodon verbinden** (bzw. einen neuen Zugangstoken hinterlegen) und testen. So geht ein gespeicherter Token nie an eine andere Instanz.

| Einstellung | Bedeutung |
|---|---|
| Sichtbarkeit | **Öffentlich** (Zeitleisten und Suche), **Nicht gelistet** (öffentlich lesbar, nicht in öffentlichen Zeitleisten) oder **Nur Folgende**. |
| Inhaltswarnung | Je Beitrag optional im Beitrag unter **Soziale Netzwerke**: Der Beitrag erscheint hinter der Warnung (z. B. „Einsatz mit Verletzten“) und ist erst nach einem Klick lesbar. Sie zählt zur Höchstlänge. |
| Sprache | Sprachcode der Beiträge, Standard `de` – hilft Suche und Übersetzung. |

Beim **Entfernen** löscht BlaulichtCMS den Beitrag über die Schnittstelle. Ein erneuter Versuch nach unklarem Ausgang legt keinen zweiten Beitrag an: BlaulichtCMS schickt einen Wiederholungsschutz mit (Idempotency-Key) und sucht vorher im Konto nach dem Beitrag.

## Bluesky

Bluesky ist kostenlos und wird über das offene [AT Protocol](https://atproto.com/) angebunden. BlaulichtCMS meldet sich mit einem **App-Passwort** an – nie mit dem Kontopasswort. Veröffentlicht werden Text (höchstens **300 Zeichen**, gezählt werden sichtbare Zeichen; Adressen zählen voll; zusätzlich höchstens 3 000 Byte – bei vielen Emojis greift diese Grenze zuerst, der Zähler im Beitrag berücksichtigt beides), bis zu **4 Bilder mit Alternativtext** und der Link zur Website. Ohne Bilder zeigt Bluesky den Link als **Vorschaukarte** mit Titel, Kurzfassung und Titelbild des Beitrags – BlaulichtCMS ruft dafür die Website nicht ab. Videos überträgt BlaulichtCMS zu Bluesky nicht. Links und Hashtags im Text sind anklickbar.

**Einrichten**

1. In Bluesky unter **Einstellungen → Datenschutz und Sicherheit → App-Passwörter** ein neues App-Passwort anlegen (Name z. B. „BlaulichtCMS“, ohne Zugriff auf Direktnachrichten). Es lässt sich jederzeit einzeln widerrufen.
2. Unter **Verbindungen → Neue Verbindung → Bluesky-Konto** das **Handle** (z. B. `feuerwehr-musterstadt.bsky.social`) und das App-Passwort eintragen und speichern. Liegt das Konto auf einem eigenen Server (PDS), dessen Adresse unter „Eigener Server“ eintragen – sonst leer lassen.
3. **Testen:** BlaulichtCMS meldet sich an und lädt ein neutrales Testbild hoch, ohne es zu verwenden (ein Testbeitrag wäre öffentlich). Danach **Aktivieren**.

Das App-Passwort gilt nur für **dieses Handle und diesen Server**: Ändert sich eines davon, verwirft BlaulichtCMS das gespeicherte App-Passwort beim Speichern, und es muss neu eingegeben werden. So geht es nie an einen anderen Server.

Beim **Entfernen** löscht BlaulichtCMS den Beitrag über die Schnittstelle. Bluesky begrenzt die Zahl der Anmeldungen; BlaulichtCMS meldet sich deshalb nur zum Testen, Veröffentlichen, Prüfen und Löschen an.

## WhatsApp-Kanal

WhatsApp bietet **keine Schnittstelle**, um in einen WhatsApp-Kanal zu posten. Die WhatsApp Business Platform ist für Nachrichten an einzelne Personen gedacht, nicht für Kanäle. Ein WhatsApp-Kanal geht deshalb nur über **Teilen von Hand**:

- In der Verbindung optional die **Adresse des eigenen Kanals** eintragen (`https://whatsapp.com/channel/…`; in WhatsApp unter **Aktuelles** den Kanal öffnen → Kanalname antippen → **Link kopieren**). Dann öffnet BlaulichtCMS beim Teilen direkt den Kanal, sonst WhatsApp Web.
- Der vorbereitete Text nutzt die WhatsApp-Formatierung: Titel **fett** (`*Titel*`), darunter Kurzfassung bzw. Text und der Link zur Website. Ein eigener Text für den WhatsApp-Kanal im Beitrag ersetzt das.
- **Testen** prüft nur die Einstellungen (es gibt nichts anzumelden); danach **Aktivieren**.

## Reichweite

BlaulichtCMS ruft die **Aufrufe und Interaktionen** veröffentlichter Social-Posts über die offiziellen Statistik-Schnittstellen ab – **1 Stunde, 24 Stunden und 7 Tage** nach der Veröffentlichung, danach nicht mehr. Die Zahlen stehen im Beitrag unter **Soziale Netzwerke – Status**, in der Übersicht **Reichweite** (Zeitraum, Netzwerk, Top-Beiträge) und als Dashboard-Kachel „Reichweite (7 Tage)“. Sehen darf sie, wer das Recht **Reichweite ansehen** hat (Vorgabe für Redaktion, Freigabe, Veröffentlichung und Lesezugriff).

Gespeichert werden **nur zusammengefasste Zahlen** je Beitrag – nie, wer reagiert, kommentiert oder geteilt hat.

| Netzwerk | Zahlen | Voraussetzung |
|---|---|---|
| Facebook | Reaktionen, Kommentare, geteilt; mit `read_insights` auch Aufrufe, Erreichte und Klicks | `read_insights` fragt BlaulichtCMS beim (erneuten) Verbinden mit an; Seiten-Statistiken gibt es laut Meta erst ab 100 „Gefällt mir“ |
| Instagram | Gefällt mir, Kommentare; mit `instagram_business_manage_insights` auch Aufrufe, Reichweite, geteilt, gespeichert | Recht beim (erneuten) Verbinden; Meta liefert die Werte mit bis zu 48 Stunden Verzögerung |
| Threads | Aufrufe, Gefällt mir, Antworten, Reposts, Zitate, geteilt | Recht `threads_manage_insights` beim (erneuten) Verbinden |
| X | Aufrufe, Gefällt mir, Antworten, Reposts, Zitate, Lesezeichen | nur „Über die X-API posten“ und ausdrücklich eingeschaltet – **jeder Abruf kostet Guthaben** |
| Mastodon | Boosts, Favoriten, Antworten | keine weitere |
| Bluesky | Gefällt mir, Reposts, Antworten, Zitate | keine (öffentliche Schnittstelle, ohne Anmeldung) |

Ältere Verbindungen haben die Statistik-Rechte noch nicht: Dann zeigt BlaulichtCMS die Zahlen, die ohne sie lesbar sind (Facebook, Instagram) bzw. einen Hinweis im Beitrag (Threads); **erneut verbinden** und testen ergänzt das Recht. Je Verbindung lässt sich der Abruf mit **Reichweite abrufen** ausschalten (ohne neuen Test). Nicht gezählt werden Storys (verschwinden nach 24 Stunden), von Hand Geteiltes (WhatsApp-Kanal, X von Hand) und entfernte Beiträge.

**Website:** Aufrufe der WordPress-Seite zeigt BlaulichtCMS nicht. WordPress selbst zählt keine Aufrufe, und die Bridge baut bewusst keine Zählung ein – das ginge nur mit einem Statistik-Dienst bzw. -Plugin auf der Website, dessen Einsatz die Website selbst datenschutzrechtlich bewerten muss.

## Teilen von Hand

Für Netzwerke ohne Schnittstelle (WhatsApp-Kanal, X im Modus „Teilen von Hand“) gilt dieselbe Freigabe wie für alle anderen Netzwerke. Nach **Auf sozialen Netzwerken veröffentlichen** steht das Netzwerk im Beitrag als **Zum Teilen bereit**, und alle mit dem Recht „In sozialen Netzwerken veröffentlichen“ bekommen eine Benachrichtigung.

1. Im Beitrag unter **Soziale Netzwerke – Status** beim Netzwerk **Jetzt teilen** wählen.
2. Den vorbereiteten Text **kopieren** bzw. bei X **In X öffnen** (der Text steht dann schon im Beitragsfenster). Bilder lassen sich herunterladen (Links gelten 24 Stunden) und beim Posten anhängen.
3. Posten und danach **Als geteilt markieren** – optional mit dem Link zum geteilten Beitrag. Das steht mit Person und Zeit im Beitrag und im Audit-Protokoll.

Wird die Freigabe widerrufen oder der Beitrag von den sozialen Netzwerken entfernt, werden noch nicht geteilte Aufträge abgebrochen. Was schon geteilt ist, muss von Hand gelöscht und bestätigt werden.

### Datenschutz bei Threads, X, WhatsApp, Mastodon und Bluesky

Wie bei Facebook und Instagram sind das Hinweise zur Orientierung, keine Rechtsberatung.

- **Threads** gehört zu Meta; für Empfänger, Drittland und Datenschutzerklärung gilt sinngemäß, was oben unter *Datenschutz bei Facebook und Instagram* steht.
- **X** (X Corp., USA): Beim Posten über die X-API gehen Text und Bilder von BlaulichtCMS an X; beim Teilen von Hand überträgt die Person selbst. Die Rechtsgrundlage für die Übermittlung in die USA und die Präsenz auf X gehören in die Bewertung und die Datenschutzerklärung.
- **Mastodon:** Text, Bilder und Alternativtexte gehen an den Betreiber der gewählten Instanz und von dort an andere Instanzen, deren Personen dem Konto folgen (Föderation). Gelöschte Beiträge entfernt jede Instanz selbst – meist zeitnah, aber ohne Garantie. Eine Behörden-Instanz (z. B. social.bund.de) vereinfacht die Bewertung.
- **Bluesky** (Bluesky Social PBC, USA): Text, Bilder und Alternativtexte gehen an den Bluesky-Server und sind über das offene Protokoll öffentlich abrufbar. Drittlandübermittlung und Präsenz gehören in die Bewertung und die Datenschutzerklärung.
- **WhatsApp-Kanal:** BlaulichtCMS überträgt nichts an WhatsApp – geteilt wird von Hand. Der Kanal selbst ist eine Präsenz bei Meta und gehört ebenso in die Datenschutzerklärung.

## FE2 (Einsatzentwürfe)

Aus Einsatzmeldungen der Alarmierungssoftware FE2 (Alamos) entstehen interne Beitragsentwürfe. Die Alarmierung selbst läuft unabhängig von BlaulichtCMS.

### Eingangsadresse und Zugangsschlüssel

Beide Werte **erzeugt BlaulichtCMS** – sie stehen nicht in FE2:

- **Eingangsadresse:** in der Verbindung unter *Einstellungen*, z. B. `https://<eigene Adresse>/api/v1/inbound/fe2/<ID>` (Kopierknopf daneben).
- **Zugangsschlüssel** (`bcfe2_…`): wird beim Anlegen der Verbindung **nur einmal** angezeigt. Verloren? **Neuen Zugangsschlüssel erzeugen** – der alte gilt sofort nicht mehr, und die Verbindung muss neu getestet und aktiviert werden.

Erwartet wird ein **HTTP-POST** mit JSON (oder Formulardaten) und dem Schlüssel in der Kopfzeile `Authorization: Bearer <Schlüssel>` (alternativ `X-BlaulichtCMS-Token: <Schlüssel>`). Kann der Absender keine Kopfzeile setzen, hilft die Option [Schlüssel in der Adresse](#schluessel-in-der-adresse).

### Schlüssel in der Adresse

Die öffentliche FE2-Dokumentation zeigt keinen Ausgang, der eine eigene Kopfzeile wie `Authorization` setzt. Für diesen Fall gibt es je FE2-Verbindung die Option **Schlüssel in der Adresse** (Standard aus):

- Eingeschaltet erzeugt BlaulichtCMS einen **eigenen Schlüssel** (`bcfe2p_…`) und zeigt unter *Einstellungen* eine zweite Eingangsadresse `https://<eigene Adresse>/api/v1/inbound/fe2/<ID>/<Schlüssel>` mit Kopierknopf. Diese Adresse braucht keine Kopfzeile.
- Die Adresse mit Kopfzeile gilt weiter. Beide Wege nehmen höchstens 60 Meldungen je Minute an.
- **Abwägung:** Der Schlüssel steht dann in der FE2-Konfiguration und in jeder Adresszeile – also auch in Zugriffsprotokollen eines Proxys. Diese Protokolle abschalten oder Schlüssel maskieren (Anleitung für Nginx Proxy Manager, nginx und Caddy in `docs/reverse-proxy.md`, Abschnitt „Zugriffsprotokolle des Proxys“). BlaulichtCMS selbst schreibt den Schlüssel weder ins Systemprotokoll noch ins Audit.
- **Abgeflossen?** **Neuen Zugangsschlüssel erzeugen** erneuert beide Schlüssel; die alte Adresse gilt sofort nicht mehr. Ausschalten der Option löscht den Adress-Schlüssel.
- Ein- und Ausschalten verlangt einen neuen Test (Testmeldung über die neue Adresse senden).

### In FE2 einrichten

FE2 muss die Meldung als **HTTP-POST** senden können – mit eigener Kopfzeile oder, mit der Option [Schlüssel in der Adresse](#schluessel-in-der-adresse), ohne. Die öffentliche FE2-Dokumentation von Alamos ([Handbuch](https://alamos-support.atlassian.net/wiki/spaces/documentation/overview)) beschreibt einen solchen Ausgang nicht ausdrücklich: Das Plugin [„URL öffnen“](https://alamos-support.atlassian.net/wiki/spaces/documentation/pages/219480774) ruft nur eine Adresse auf, ohne eigene Kopfzeilen; „Externe Schnittstelle“ und „HTTP POST/GET“ sind dort Eingänge **in** FE2. Konkrete Menünamen geben wir deshalb nicht an.

- Mit dem FE2-Betreuer bzw. dem Alamos-Support klären, welcher Ausgang (Plugin, Skript) in der eigenen Version einen POST mit JSON und Kopfzeile senden kann.
- Kann der Ausgang einen POST mit JSON senden, aber keine Kopfzeile setzen: [Schlüssel in der Adresse](#schluessel-in-der-adresse) einschalten.
- Alternativ eine kleine Weiterleitung im eigenen Netz betreiben, die FE2-Meldungen entgegennimmt und mit Kopfzeile an die Eingangsadresse schickt.
- Nur die nötigen Felder senden. Liegt BlaulichtCMS im internen Netz, muss die Plattform-Administration interne Ziele nicht freigeben – das gilt nur für Abrufe *aus* BlaulichtCMS.

### Feldzuordnung

Standardmäßig liest BlaulichtCMS die Felder unter `einsatz.` – z. B. `einsatz.id`, `einsatz.stichwort`, `einsatz.ort`, `einsatz.alarmzeit`, `einsatz.einheiten`, `einsatz.status`. Sendet FE2 andere Feldnamen, unter **Feldzuordnung (Allowlist)** den Pfad je Feld eintragen (Punkte für verschachtelte Felder, z. B. `alarm.nummer`). Leere Felder: BlaulichtCMS sucht gängige Namen selbst.

- **Einsatz-ID** ist Pflicht und muss je Einsatz stabil bleiben – daran erkennt BlaulichtCMS Folgemeldungen.
- Nur die Felder der **Allowlist** (Stichwort, Ort, Alarmzeit, Einheiten, Status) gelangen in den Entwurf. Alarmtexte und Personendaten werden verworfen und nie protokolliert.
- Eine geänderte Zuordnung verlangt eine neue Testmeldung und einen neuen Test.

### Testmeldung senden

Die erste Meldung mit der Kopfzeile `X-BlaulichtCMS-Test: 1` senden – dann entsteht nur eine **Vorschau**, kein Entwurf. Vor der Aktivierung gilt jede Meldung als Testmeldung. Beispiel mit curl (anonymisierte Daten):

```
curl -X POST "https://<eigene Adresse>/api/v1/inbound/fe2/<ID>" \
  -H "Authorization: Bearer <Schlüssel>" \
  -H "X-BlaulichtCMS-Test: 1" \
  -H "Content-Type: application/json" \
  -d '{"einsatz":{"id":"TEST-1","stichwort":"F-1","ort":"Musterstadt","alarmzeit":"2026-01-01T10:00"}}'
```

Danach **Testen** (prüft: Schlüssel hinterlegt, Meldung empfangen, Einsatz-ID erkannt), unter **Vorschau** den Entwurf ansehen und **Aktivieren**.

- Je Einsatz-ID entsteht **genau ein** interner Entwurf. Folgemeldungen aktualisieren ihn, solange niemand ihn bearbeitet hat.

### Typische Fehler (FE2)

| Antwort | Ursache |
|---|---|
| 401 „Zugangsschlüssel fehlt oder ist ungültig“ | Kopfzeile fehlt, Tippfehler oder alter Schlüssel – bzw. bei der Adresse mit Schlüssel: Option ausgeschaltet oder Schlüssel erneuert. Falsche Schlüssel meldet BlaulichtCMS der Administration. |
| 400 „Keine Einsatz-ID gefunden“ | Feldzuordnung für die Einsatz-ID passt nicht zur Meldung. |
| 409 „Die Verbindung ist angehalten“ | Verbindung in BlaulichtCMS angehalten. |
| Meldung kommt an, aber kein Entwurf | Verbindung nicht aktiv (nur Vorschau), Kopfzeile `X-BlaulichtCMS-Test: 1` gesetzt oder „Beitragsentwürfe anlegen“ aus. |

## Feuersoftware Connect

Feuersoftware Connect ist die zweite Einsatzquelle neben FE2: Aus jedem neuen Einsatz entsteht **genau ein interner Beitragsentwurf** – dieselbe Art Entwurf wie bei FE2 (Stichwort, Einsatzart, Ort, Alarmzeit). Connect meldet Einsätze nicht von sich aus; BlaulichtCMS fragt die **Öffentliche Connect Schnittstelle** im eingestellten Abstand ab (1, 2, 3 oder 5 Minuten, Standard 2 Minuten). Die Alarmierung selbst läuft unabhängig von BlaulichtCMS.

1. Unter [Verbindungen](/verbindungen) **Neue Verbindung → Feuersoftware Connect** anlegen.
2. **API-Key** eintragen und speichern (siehe unten), bei Bedarf **RICs** und **Stichwörter** als Filter.
3. **Testen:** BlaulichtCMS ruft die aktuellen Einsätze ab und zeigt, wie viele zu den Filtern passen. Die **Vorschau** listet sie – ohne Adresse.
4. **Aktivieren:** Erst jetzt fragt der Worker regelmäßig ab und legt Entwürfe an. **Jetzt abrufen** (Schritt *Aktivieren*) fragt sofort ab.

- Übernommen werden nur Einsätze der **letzten 24 Stunden** – ältere Einsätze aus der Liste von Connect werden nie zu Entwürfen.
- Wiederholungen erkennt BlaulichtCMS an der Einsatz-ID, auch nach einem Neustart. Ein Einsatz, der in BlaulichtCMS gelöscht wurde (z. B. über eine Datenschutz-Anfrage oder die Löschfrist), wird nicht erneut angelegt.
- Endet der Einsatz in Connect, wird ein noch unbearbeiteter Entwurf aktualisiert; ein bearbeiteter Entwurf bleibt unverändert, die Redaktion erhält einen Hinweis.
- **Feuersoftware begrenzt die Zahl der Abfragen** und kann Schlüssel bei Überlast sperren. Deshalb mindestens 1 Minute Abstand und nie zwei Abfragen gleichzeitig. Antwortet Connect mit „zu viele Abfragen“ (429), wartet BlaulichtCMS die erbetene Pause ab.
- **Lagemeldungen** ruft BlaulichtCMS nicht ab: Ihr Freitext kann Angaben zu Verletzten enthalten und wird für einen redaktionellen Entwurf nicht gebraucht.

### Feuersoftware: API-Key

Der Schlüssel stammt aus dem [Connect Portal](https://connect.feuersoftware.com): Standort wählen → **Schnittstellen** → **„Öffentliche Connect Schnittstelle“** erzeugen bzw. aktivieren und den angezeigten Schlüssel in BlaulichtCMS eintragen ([Beschreibung der Schnittstelle bei Feuersoftware](https://docsv2.feuersoftware.com/connect/schnittstellen/public_api)).

- Ein Standort-Key liefert nur die Einsätze dieses Standorts.
- BlaulichtCMS speichert den Schlüssel verschlüsselt und zeigt ihn nie wieder an. Ein neuer Schlüssel verlangt einen neuen Test.
- Mit dem Schlüssel ließen sich in Connect auch Einsätze anlegen – BlaulichtCMS fragt nur ab. Den Schlüssel trotzdem vertraulich behandeln und im Portal erneuern, wenn er abgeflossen sein könnte.
- Der Server muss `connectapi.feuersoftware.com` über HTTPS erreichen (Internet, DNS, Firewall).

### Feuersoftware: Filter

Damit nur **eigene** Einsätze zu Entwürfen werden, lassen sich RICs und Stichwörter einstellen. Ein Einsatz passt, wenn **eine** RIC **oder** **ein** Stichwort passt. Ohne beides wird **jeder** Einsatz des Standorts übernommen.

- **RIC:** Alarmierungsadresse bzw. Name der Alarmgruppe, wie er in Connect bei der Alarmierung steht (oft ein Name wie „Musterwehr Vollalarm“). Passt bei gleicher Schreibweise (ohne Groß-/Kleinschreibung) oder als ganzes Wort im RIC-Feld – „123“ passt nicht auf „1234567“.
- **Stichwort:** passt, wenn das Einsatzstichwort den Begriff enthält, z. B. `B3` oder `TH`.
- Passt beim Test nicht jeder Einsatz, nennt BlaulichtCMS die RICs der aktuellen Einsätze – so lässt sich die richtige Schreibweise nach einem Probealarm ablesen.
- Geänderte Filter verlangen einen neuen Test.

### Typische Fehler (Feuersoftware)

| Meldung | Ursache und Abhilfe |
|---|---|
| „Der API-Key wird abgelehnt (401)“ | Schlüssel falsch, erneuert oder die „Öffentliche Connect Schnittstelle“ im Connect Portal nicht aktiv. Schlüssel neu eintragen. |
| „Zugriff verweigert (403)“ | Schlüssel darf diese Daten nicht lesen (anderer Standort, Schnittstelle deaktiviert oder wegen Überlast gesperrt). |
| „Adresse … nicht gefunden (404)“ | Die Schnittstelle hat sich geändert – BlaulichtCMS aktualisieren bzw. melden. |
| „Zu viele Abfragen (429)“ | Abfragelimit erreicht. BlaulichtCMS wartet die erbetene Pause ab; bei Wiederholung den Abrufabstand erhöhen. |
| „Serverfehler (5xx)“, „Zeitüberschreitung“ | Meist vorübergehend; der nächste Abruf läuft automatisch. |
| „nicht erreichbar“ | Der Server erreicht `connectapi.feuersoftware.com` nicht (Internet, DNS, Firewall, Proxy). |
| „kein JSON“ | Unerwartete Antwort, z. B. Wartungsseite. |
| Test bestanden, aber kein Entwurf | Verbindung nicht aktiv, Filter passt nicht, Einsatz älter als 24 Stunden oder „Beitragsentwürfe anlegen“ aus. |

Die letzte Störung steht in der Verbindung und in der Übersicht. Nach **drei Fehlschlägen in Folge** benachrichtigt BlaulichtCMS alle mit dem Recht „Verbindungen verwalten“; beim nächsten erfolgreichen Abruf wird die Meldung aufgehoben.

### Datenschutz bei Feuersoftware Connect

Übernommen werden nur Stichwort, Einsatzart, Ort bzw. Ort mit Ortsteil, Alarmzeit und Ende. Straße, Hausnummer, Koordinaten, Sachverhalt, Einsatznummer, meldende Person, Telefonnummern und Lagemeldungen werden nie gespeichert oder protokolliert; die Vorschau zeigt keine Adresse. Gespeicherte Einsatzmeldungen fallen unter dieselbe Löschfrist wie FE2-Meldungen (*Einstellungen → Löschfristen*, Standard 90 Tage) und unter die Datenschutzsuche. Damit gelöschte Einsätze nicht erneut angelegt werden, bleibt 30 Tage lang nur eine Prüfsumme der Einsatz-ID.

## Amtliche Warnungen

Quelle: Warn-App-Schnittstelle des Bundes (Regionalschlüssel des Kreises) oder eine eigene CAP-Adresse. Unzulässige Steuerzeichen (etwa ein NUL-Zeichen) in Kennung und Texten einer Meldung entfallen beim Einlesen; eine einzelne Meldung, die sich nicht abrufen oder speichern lässt, steht als **Fehler** im Empfangsprotokoll und hält die übrigen nicht auf. Gebietsfilter über Geocode-Präfixe oder Ortsnamen. Die Schnittstelle liefert Meldungen auf Kreisebene; sie gelten auch für jede Gemeinde im Kreis. Banner nennen nur Orte, die zum Ortsnamen-Filter passen, und immer die Quelle (z. B. „Quelle: Deutscher Wetterdienst“). Die Meldungen erscheinen unter [Amtliche Warnungen](/amtliche-warnungen) – getrennt vom eigenen Warnentwurf.

### Warnung ausblenden

Amtliche Warnungen lassen sich nicht löschen, aber **ausblenden** (Knopf an der Warnung, Recht „Beiträge bearbeiten“):

- Die Warnung verschwindet aus der Liste und wird bei späteren Abrufen **nicht wieder angelegt**, auch wenn die Quelle sie weiter liefert.
- Ein automatisches Banner, das aus ihr entstanden ist, wird beendet und von der Website entfernt.
- Aktualisierungen und Entwarnungen der Quelle sind eigene Meldungen und erscheinen weiterhin.
- Das Ausblenden steht im Audit-Protokoll. Die Löschfrist für amtliche Warnungen gilt unverändert.

### Regionalschlüssel und Gebietsfilter

- **Regionalschlüssel (ARS) des Kreises:** Eigene Gemeinde im [Gemeindeverzeichnis-Online](https://www.statistikportal.de/de/gemeindeverzeichnis) suchen und den 8-stelligen Amtlichen Gemeindeschlüssel (AGS) ablesen, z. B. `05315000`. Die ersten 5 Stellen sind der Kreis; mit 7 angehängten Nullen ergibt sich der ARS für BlaulichtCMS: `053150000000`.
- **Geocode-Präfix (optional):** der vollständige 12-stellige ARS der eigenen Gemeinde aus dem [Anschriftenverzeichnis](https://www.statistikportal.de/de/veroeffentlichungen/anschriftenverzeichnis) des Statistikportals. Kreis- und Landeswarnungen gelten trotzdem mit.
- **Ortsnamen:** Gemeinde und Ortsteile, wie sie in Warnungen genannt werden, durch Komma getrennt. Sie filtern und bestimmen die Orte im Bannertext – für den Anfang reicht dieser Filter.
- Mit **Testen** prüfen: Unter „Meldungen im eigenen Gebiet“ erscheinen die aktuellen Warnungen. Neben den Feldern erklärt ein **?**-Knopf dasselbe.

### Eigene CAP-Quelle

**CAP** (Common Alerting Protocol) ist ein [offener OASIS-Standard](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html) für Warnmeldungen im XML-Format. Eine **CAP-Adresse** ist eine `https://`-Adresse, die eine CAP-Meldung oder einen Atom-Feed mit CAP-Meldungen liefert.

- Unter **Quelle** „Eigene Adresse (CAP-XML/-JSON oder Atom mit CAP)“ wählen und die Adresse eintragen.
- BlaulichtCMS liest ein einzelnes CAP-Dokument (XML oder JSON) oder einen Atom-Feed, dessen Einträge die CAP-Meldung **enthalten**. Feeds, die je Eintrag nur auf eine CAP-Datei **verlinken**, und ZIP-Archive werden nicht gelesen.
- **Beispiel Deutscher Wetterdienst:** Der [Atom-Feed des DWD](https://www.dwd.de/DWD/warnungen/cap-feed/de/atom.xml) verlinkt je Warnung auf eine eigene CAP-Datei, die Dateien unter [opendata.dwd.de/weather/alerts/cap](https://opendata.dwd.de/weather/alerts/cap/) sind ZIP-Archive (Hintergrund: [Open-Data-Hilfe des DWD](https://www.dwd.de/DE/leistungen/opendata/hilfe.html)). Beides eignet sich nicht als CAP-Adresse. Unwetterwarnungen des DWD kommen auch über die Warn-App-Schnittstelle des Bundes – dafür einfach den Regionalschlüssel verwenden. DWD-Daten verlangen einen Quellenvermerk ([rechtliche Hinweise](https://www.dwd.de/DE/service/rechtliche_hinweise/rechtliche_hinweise_node.html)); BlaulichtCMS ergänzt „Quelle: Deutscher Wetterdienst“ im Banner.
- Typische eigene CAP-Quellen sind Warnsysteme des Landes oder Kreises, die CAP ausgeben – die Adresse nennt der Betreiber.
- Nur `https://`-Adressen; Weiterleitungen von HTTPS auf HTTP werden abgewiesen. Interne Adressen gibt die Plattform-Administration ausdrücklich frei (siehe [Interne Ziele](#interne-ziele)).
- **Testen** liest die Quelle und zeigt die Meldungen im eigenen Gebiet. Eine geänderte Adresse verlangt einen neuen Test.

### Automatische Banner und Prüfliste

- Standard: anzeigen und auf die **Originalquelle** verlinken; ein Banner-Entwurf mit Link durchläuft die normale Freigabe.
- **Automatische Banner** lassen sich erst einschalten, nachdem die fachliche Prüfung in der Verbindung (Schritt **Aktivieren**) dokumentiert wurde. Die Prüfliste:
  - [ ] Herkunft und Bezugsweg der Daten sind geklärt
  - [ ] Weiterverwendung auf der eigenen Website ist zulässig (Nutzungsbedingungen geprüft, siehe unten)
  - [ ] Gebietsfilter liefert nur das eigene Gebiet (mit echten Daten geprüft)
  - [ ] Gültigkeit/Ablauf wird übernommen, abgelaufene Warnungen verschwinden
  - [ ] Aktualisierungen ersetzen die vorherige Meldung
  - [ ] Entwarnungen beenden das Banner sofort
- Ändern sich Quelle oder Gebiet, verfällt die Prüfung und automatische Banner gehen aus.
- **Nur für eine gekoppelte Website:** Die Ziel-Website muss gekoppelt sein. Wird ihre Kopplung widerrufen (oder löst die Website sie selbst), schaltet BlaulichtCMS die automatischen Banner der betroffenen Warnfeeds ab, protokolliert das und benachrichtigt die Verwaltung. Nach einer Neu-Kopplung die neue Website in der Verbindung wählen und automatische Banner wieder einschalten.
- **Nur über HTTPS:** Eine ältere Verbindung mit `http://`-Adresse zeigt Meldungen weiter an, automatische Banner schaltet BlaulichtCMS dort aber ab und weist in der Verbindung darauf hin.

### Weiterverwendung klären

- **Warnungen des Bundes (MoWaS, BBK):** Für die Warn-App-Schnittstelle gibt es keine veröffentlichten Nutzungsbedingungen. Wer Warnungen automatisch weiterverbreiten will, klärt das vorher mit dem BBK. Der offizielle Weg für Weiterverbreiter ist das Programm [Warnmultiplikatoren](https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warnung-in-Deutschland/Warnmultiplikatoren/warnmultiplikatoren_node.html) (Vereinbarung mit dem BBK, Kontakt dort: Warnmultiplikatoren@bbk.bund.de). Die Adresse NINA@bbk.bund.de ist der Helpdesk der Warn-App, nicht die Stelle für solche Vereinbarungen.
- **DWD:** offene Daten mit Quellenvermerk (siehe oben).
- Ergebnis (z. B. schriftliche Bestätigung) in der Prüfung der Verbindung dokumentieren.

### Datenschutz bei FE2 und amtlichen Warnungen

FE2 liefert Einsatzdaten (Stichwort, Ort, Zeit, Einheiten). BlaulichtCMS übernimmt nur die Felder der Allowlist, Alarmtexte und Personendaten werden verworfen. Gespeicherte Einsatzmeldungen löscht der Worker nach der Frist unter *Einstellungen → Löschfristen* (Standard 90 Tage). Amtliche Warnungen enthalten keine personenbezogenen Daten; sie werden nach Ablauf ebenfalls gelöscht.

## Interne Ziele

Adressen im privaten Netz (z. B. ein interner Server) sind gesperrt, bis die Plattform-Administration sie in der Verbindung ausdrücklich freigibt.
