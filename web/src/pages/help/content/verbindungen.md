Verbindungen sind **optional**. BlaulichtCMS funktioniert vollständig ohne. Jede Verbindung durchläuft dieselben vier Schritte unter [Verbindungen](/verbindungen):

1. **Verbinden** – Einstellungen und Zugangsdaten. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.
2. **Testen** – zeigt jeden Prüfschritt mit Ergebnis. Eine erfolgreiche Anmeldung allein ist **kein** Veröffentlichungstest.
3. **Vorschau** – welche Funktionen das Konto tatsächlich bietet und wie Daten ankommen würden.
4. **Aktivieren** – erst nach bestandenem Test. Anhalten und Widerrufen sind jederzeit möglich.

## Facebook-Seite und Instagram-Konto

Benötigt wird eine eigene Meta-App (Facebook Login bzw. Instagram Login). App-ID und App-Geheimnis eintragen, **Mit Facebook/Instagram verbinden**, bei Facebook die Seite wählen.

Einrichtung der Meta-App (einmalig, unter developers.facebook.com):

1. App vom Typ *Business* anlegen; Produkt **Facebook Login for Business** bzw. **Instagram API mit Instagram Login** hinzufügen.
2. Die **Weiterleitungsadresse** aus der Verbindung in BlaulichtCMS in der App eintragen (muss exakt übereinstimmen, HTTPS).
3. Rechte anfordern – Facebook: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`; Instagram: `instagram_business_basic`, `instagram_business_content_publish`.
4. Bis zur **App-Prüfung** durch Meta funktioniert die Verbindung nur mit Konten, die in der App als Tester oder Admin eingetragen sind – dafür reicht der Live-Test mit Testseite und Testkonto.
5. Instagram lädt Bilder und Videos selbst ab: BlaulichtCMS muss dafür unter seiner öffentlichen HTTPS-Adresse erreichbar sein.

- **Test Facebook:** BlaulichtCMS legt einen *unveröffentlichten* Beitrag an und löscht ihn sofort wieder.
- **Test Instagram:** BlaulichtCMS legt einen Mediencontainer mit einem fest eingebauten, neutralen Testbild (graue Fläche) an und prüft die Verarbeitung – ohne zu veröffentlichen. Fotos aus Uploads werden für den Test nie verwendet.

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

BlaulichtCMS erzeugt eine Eingangsadresse und einen Zugangsschlüssel (nur einmal sichtbar). In FE2 einen HTTP-Ausgang (POST, JSON oder Formular) mit dem Header `Authorization: Bearer <Schlüssel>` einrichten. Standardmäßig liest BlaulichtCMS die Felder unter `einsatz.` (z. B. `einsatz.id`, `einsatz.stichwort`, `einsatz.ort`); sendet FE2 andere Feldnamen, unter *Feldzuordnung* den Pfad je Feld eintragen. Erste Meldung mit der Kopfzeile `X-BlaulichtCMS-Test: 1` senden – dann entsteht nur eine Vorschau.

- Vor der Aktivierung zeigt BlaulichtCMS nur eine **Vorschau** der Testmeldung.
- Nur die Felder der **Allowlist** (Stichwort, Ort, Alarmzeit, Einheiten, Status) gelangen in den Entwurf. Alarmtexte und Personendaten werden verworfen und nie protokolliert.
- Je Einsatz-ID entsteht **genau ein** interner Entwurf. Folgemeldungen aktualisieren ihn, solange niemand ihn bearbeitet hat.
- Die Alarmierung läuft unabhängig von BlaulichtCMS.

## Amtliche Warnungen

Quelle: Warn-App-Schnittstelle des Bundes (Regionalschlüssel des Kreises) oder eine eigene CAP-Adresse. Gebietsfilter über Geocode-Präfixe oder Ortsnamen. Die Schnittstelle liefert Meldungen auf Kreisebene; sie gelten auch für jede Gemeinde im Kreis. Banner nennen nur Orte, die zum Ortsnamen-Filter passen, und immer die Quelle (z. B. „Quelle: Deutscher Wetterdienst“ – beim DWD vorgeschrieben). Die Meldungen erscheinen unter [Amtliche Warnungen](/amtliche-warnungen) – getrennt vom eigenen Warnentwurf.

- Standard: anzeigen und auf die **Originalquelle** verlinken; ein Banner-Entwurf mit Link durchläuft die normale Freigabe.
- **Automatische Banner** lassen sich erst einschalten, nachdem die fachliche Prüfung dokumentiert wurde (Herkunft, Weiterverwendung, Gebietsfilter, Gültigkeit, Aktualisierungen, Entwarnungen). Aktualisierungen ersetzen, Entwarnungen beenden das Banner.
- **Nur für eine gekoppelte Website:** Die Ziel-Website muss gekoppelt sein. Wird ihre Kopplung widerrufen (oder löst die Website sie selbst), schaltet BlaulichtCMS die automatischen Banner der betroffenen Warnfeeds ab, protokolliert das und benachrichtigt die Verwaltung. Nach einer Neu-Kopplung die neue Website in der Verbindung wählen und automatische Banner wieder einschalten.
- **Nur über HTTPS:** Quellen müssen mit `https://` beginnen; Weiterleitungen von HTTPS auf HTTP werden abgewiesen. Eine ältere Verbindung mit `http://`-Adresse zeigt Meldungen weiter an, automatische Banner schaltet BlaulichtCMS dort aber ab und weist in der Verbindung darauf hin.

### Datenschutz bei FE2 und amtlichen Warnungen

FE2 liefert Einsatzdaten (Stichwort, Ort, Zeit, Einheiten). BlaulichtCMS übernimmt nur die Felder der Allowlist, Alarmtexte und Personendaten werden verworfen. Gespeicherte Einsatzmeldungen löscht der Worker nach der Frist unter *Einstellungen → Datenschutz* (Standard 90 Tage). Amtliche Warnungen enthalten keine personenbezogenen Daten; sie werden nach Ablauf ebenfalls gelöscht.

## Interne Ziele

Adressen im privaten Netz (z. B. ein interner Server) sind gesperrt, bis die Plattform-Administration sie in der Verbindung ausdrücklich freigibt.
