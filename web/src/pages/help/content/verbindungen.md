Verbindungen sind **optional**. BlaulichtCMS funktioniert vollständig ohne. Jede Verbindung durchläuft dieselben vier Schritte unter [Verbindungen](/verbindungen):

1. **Verbinden** – Einstellungen und Zugangsdaten. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.
2. **Testen** – zeigt jeden Prüfschritt mit Ergebnis. Eine erfolgreiche Anmeldung allein ist **kein** Veröffentlichungstest.
3. **Vorschau** – welche Funktionen das Konto tatsächlich bietet und wie Daten ankommen würden.
4. **Aktivieren** – erst nach bestandenem Test. Anhalten, Widerrufen und Löschen sind jederzeit möglich.

## Test und Aktivierung

Eine Verbindung lässt sich nur mit einem **bestandenen Test der aktuellen Einstellungen** aktivieren.

- Ändern sich Einstellungen oder Zugangsdaten, verwirft BlaulichtCMS den letzten Test und setzt die Verbindung auf **Entwurf** – auch eine aktive oder angehaltene. Vor dem Speichern an einer aktiven Verbindung fragt BlaulichtCMS nach: Sie verarbeitet bis zum neuen Test und zur erneuten Aktivierung keine Meldungen und veröffentlicht nichts.
- Dazu zählen: Quelle, Regionalschlüssel, Gebietsfilter, Feldzuordnung, App-ID, App-Geheimnis, Token, gewählte Seite, eine neue Anmeldung bei Meta, ein neuer FE2-Zugangsschlüssel sowie API-Key, RICs und Stichwörter bei Feuersoftware Connect.
- **Ohne neuen Test** änderbar sind der Name, das Abrufintervall bzw. der Abrufabstand, „Beitragsentwürfe anlegen“ und die automatischen Banner (die haben eigene Voraussetzungen, siehe [unten](#automatische-banner-und-pruefliste)).
- Eine angehaltene Verbindung mit unveränderten Einstellungen lässt sich ohne neuen Test wieder aktivieren.
- Jede Rücksetzung steht im Audit-Protokoll („Neuer Test nötig“ mit vorherigem Status und Grund).

## Widerrufen und löschen

Beides steht in der Verbindung unter Schritt **Aktivieren** und braucht das Recht „Verbindungen verwalten“. Jede Aktion steht im Audit-Protokoll.

- **Widerrufen** löscht die Zugangsdaten; die Verbindung bleibt sichtbar und lässt sich nicht wieder aktivieren.
- **Löschen** entfernt eine Verbindung, die **nie verwendet** wurde, endgültig samt Zugangsdaten.
- Wurde sie verwendet – Veröffentlichungen auf einem sozialen Kanal, Zielkanal in einer Beitragsfassung, Einsatzmeldungen aus FE2 oder Feuersoftware Connect, amtliche Warnungen –, wird sie stattdessen **widerrufen, ihre Zugangsdaten werden gelöscht** und sie verschwindet aus den Listen. Der Veröffentlichungsverlauf und andere Bezüge bleiben erhalten und zeigen „Verbindung gelöscht“. Abrufe, der FE2-Eingang und Veröffentlichungen ignorieren sie.
- Der Bestätigungsdialog nennt vorher, welcher der beiden Fälle eintritt.
- Die Administration (Recht „System verwalten“) kann unter Verbindungen mit **Gelöschte anzeigen** auch widerrufene und gelöschte Verbindungen einsehen.

## Facebook-Seite und Instagram-Konto

Facebook-Seite und Instagram-Konto sind **zwei getrennte Verbindungen** mit eigener Meta-App-Anbindung, eigenem Test und eigenem Status. BlaulichtCMS nutzt die Graph API in Version **v26.0**.

**Voraussetzungen**

- Eine **Facebook-Seite**, auf der das eigene Facebook-Konto die Seite verwalten darf, bzw. ein **professionelles Instagram-Konto** (Unternehmen oder Creator) – private Konten können nicht über die Schnittstelle veröffentlichen.
- Ein **Meta-Entwicklerkonto** unter [developers.facebook.com](https://developers.facebook.com/) mit dem Konto, das die Seite verwaltet.
- BlaulichtCMS unter einer **öffentlichen HTTPS-Adresse** (Einstellungen → Allgemein → Öffentliche Adresse). Meta leitet nach der Anmeldung dorthin zurück; Instagram lädt Bilder und Videos selbst von dort ab.

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

| Kanal | Berechtigungen | Wofür |
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
| „Angemeldet, aber keine verwaltbare Seite gefunden“ | Bei der Anmeldung keine Seite freigegeben oder das Konto verwaltet die Seite nicht. Erneut verbinden und die Seite auswählen. |
| Berechtigungen: „Es fehlen …“ | Rechte bei der Anmeldung abgewählt oder in der App nicht hinzugefügt bzw. (im Live-Modus) nicht geprüft. |
| „ist kein professionelles Konto“ | Instagram-Konto auf Unternehmen oder Creator umstellen. |
| Instagram: Container-Status ERROR | Meta konnte das Testbild nicht laden: Öffentliche Adresse prüfen (HTTPS, von außen erreichbar, kein Zugriffsschutz). |
| Später „Token abgelaufen“ | Passwort geändert, App-Rechte entzogen oder Token abgelaufen: **Mit Facebook/Instagram verbinden** erneut ausführen, testen, aktivieren. |

### Im Beitrag veröffentlichen

Im Beitrag unter **Soziale Kanäle** die Kanäle wählen (optional mit eigenem Text). Die Auswahl ist Teil der Fassung – eine Änderung braucht eine neue Freigabe. Nach der Freigabe: **Auf sozialen Kanälen veröffentlichen**.

| Status | Bedeutung |
|---|---|
| Veröffentlicht | mit Link zum Beitrag |
| Fehlgeschlagen | eindeutig abgelehnt – **nur dieser Kanal** lässt sich erneut versuchen |
| Ergebnis unbekannt | Verbindung brach ab; vor einem neuen Versuch prüft BlaulichtCMS, ob der Beitrag schon existiert |

### Von sozialen Kanälen entfernen

Muss ein Beitrag wieder weg (z. B. Widerspruch einer abgebildeten Person), im Beitrag unter **Soziale Kanäle – Status** auf **Von sozialen Kanälen entfernen** gehen und einen Grund angeben. Der Dialog zeigt danach je Kanal, was passiert ist:

| Kanal | Ablauf |
|---|---|
| Facebook | BlaulichtCMS löscht den Beitrag über die Schnittstelle. Schlägt das fehl (z. B. Verbindung widerrufen), steht ein Hinweis mit Link zum Beitrag beim Kanal. |
| Instagram | Die Schnittstelle von Instagram erlaubt **kein Löschen**. BlaulichtCMS zeigt einen Link zum Beitrag: dort in Instagram löschen und anschließend **Gelöscht – bestätigen** wählen. |

Noch nicht ausgeführte oder fehlgeschlagene Aufträge werden dabei abgebrochen. Antrag, Löschung und Bestätigung stehen im Audit-Protokoll. **Von der Website zurückziehen** wirkt nur auf WordPress – beides ist getrennt anzustoßen. Kopien, die andere bereits geteilt oder gespeichert haben, erreicht BlaulichtCMS nicht.

**Manuell exportieren** liefert den freigegebenen Text je Kanal und befristete Links zu den Dateien. Die Dateien heißen neutral nach dem Beitragstitel (z. B. `brand-in-der-altstadt-1.jpg`), nie wie die hochgeladene Datei – deren Name kann Namen oder Orte enthalten.

### Datenschutz bei Facebook und Instagram

Die folgenden Punkte sind Hinweise zur Orientierung, keine Rechtsberatung. Die Bewertung trifft die verantwortliche Stelle, am besten zusammen mit der oder dem Datenschutzbeauftragten. Grundlagen und Vorlagen: `docs/datenschutz.md` im Repository.

- **Empfänger:** Mit dem Veröffentlichen gehen Text, Bilder und Videos an **Meta Platforms** (Vertragspartner in der EU ist Meta Platforms Ireland; verarbeitet wird auch in den USA). Für Instagram ruft Meta die Dateien selbst über eine befristete Adresse bei BlaulichtCMS ab. Was auf abgebildeten Personen zu sehen ist, wird damit öffentlich und liegt auch bei Meta.
- **Drittland:** Für die Übermittlung in die USA ist die Grundlage zu prüfen, z. B. die Zertifizierung von Meta nach dem EU-US Data Privacy Framework (Liste unter dataprivacyframework.gov). Ändert sich diese Grundlage, die Nutzung neu bewerten.
- **Gemeinsame Verantwortung:** Für eine Facebook-Seite (Seiten-Insights) besteht nach der Rechtsprechung des EuGH eine gemeinsame Verantwortlichkeit mit Meta (Art. 26 DSGVO). Meta stellt dafür die *Seiten-Insights-Ergänzung bezüglich des Verantwortlichen* bereit; sie sollte geprüft und dokumentiert sein. Für Instagram-Konten gilt Entsprechendes.
- **Datenschutzerklärung:** Die Präsenz auf Facebook bzw. Instagram, die Übermittlung an Meta und die gemeinsame Verantwortung gehören in die Datenschutzerklärung der Website bzw. der Seite. Auf der Upload-Seite weist BlaulichtCMS auf die mögliche Veröffentlichung in sozialen Medien hin (*Einstellungen → Datenschutz*).
- **Löschen:** Nach einem Widerspruch den Beitrag über **Von sozialen Kanälen entfernen** zurückziehen (siehe oben): Facebook-Beiträge löscht BlaulichtCMS, Instagram-Beiträge müssen in Instagram gelöscht werden. Kopien bei Dritten (geteilte Beiträge, Screenshots) sind damit nicht erreicht.
- **BlaulichtCMS selbst** gibt an Meta nur die freigegebenen Inhalte und die neutral benannten Dateien weiter, keine Hinweise der hochladenden Personen und keine Originale.

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

Übernommen werden nur Stichwort, Einsatzart, Ort bzw. Ort mit Ortsteil, Alarmzeit und Ende. Straße, Hausnummer, Koordinaten, Sachverhalt, Einsatznummer, meldende Person, Telefonnummern und Lagemeldungen werden nie gespeichert oder protokolliert; die Vorschau zeigt keine Adresse. Gespeicherte Einsatzmeldungen fallen unter dieselbe Löschfrist wie FE2-Meldungen (*Einstellungen → Datenschutz*, Standard 90 Tage) und unter die Datenschutzsuche. Damit gelöschte Einsätze nicht erneut angelegt werden, bleibt 30 Tage lang nur eine Prüfsumme der Einsatz-ID.

## Amtliche Warnungen

Quelle: Warn-App-Schnittstelle des Bundes (Regionalschlüssel des Kreises) oder eine eigene CAP-Adresse. Gebietsfilter über Geocode-Präfixe oder Ortsnamen. Die Schnittstelle liefert Meldungen auf Kreisebene; sie gelten auch für jede Gemeinde im Kreis. Banner nennen nur Orte, die zum Ortsnamen-Filter passen, und immer die Quelle (z. B. „Quelle: Deutscher Wetterdienst“). Die Meldungen erscheinen unter [Amtliche Warnungen](/amtliche-warnungen) – getrennt vom eigenen Warnentwurf.

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

FE2 liefert Einsatzdaten (Stichwort, Ort, Zeit, Einheiten). BlaulichtCMS übernimmt nur die Felder der Allowlist, Alarmtexte und Personendaten werden verworfen. Gespeicherte Einsatzmeldungen löscht der Worker nach der Frist unter *Einstellungen → Datenschutz* (Standard 90 Tage). Amtliche Warnungen enthalten keine personenbezogenen Daten; sie werden nach Ablauf ebenfalls gelöscht.

## Interne Ziele

Adressen im privaten Netz (z. B. ein interner Server) sind gesperrt, bis die Plattform-Administration sie in der Verbindung ausdrücklich freigibt.
