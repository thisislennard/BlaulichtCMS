Rechte werden immer **auf dem Server** geprüft – bei jeder Seite, jeder API-Anfrage und jedem Dateizugriff. Rollen lassen sich kombinieren.

## Rollen

| Rolle | Darf |
|---|---|
| Administration | Alles, inklusive Konten, Rechte, Websites, Einstellungen, Sicherungen |
| Medienverwaltung | Sammlungen und Upload-Links pflegen, sichten, auswählen, herunterladen |
| Redaktion | Beiträge schreiben, Medien übernehmen, zur Freigabe einreichen (inkl. Medienverwaltung) |
| Freigabe | Fassungen freigeben oder zurückweisen, Aktivitäten lesen |
| Veröffentlichung | Freigegebene Fassungen an Websites übergeben, Fehler neu starten |
| Warnentwurf | Warnentwürfe erfassen (Erstmeldung, Aktualisierung, Entwarnung) und einreichen |
| Warnfreigabe | Warnstufe bestätigen, PDF-Fassungen freigeben, Lagefragen und Regeln fachlich freigeben |
| Warnversand | Freigegebene Warnentwürfe versenden, unklare Zustellungen prüfen, Eingang bestätigen |
| Lesezugriff | Beiträge, Medien und Status ansehen |

Das Recht **„Datenschutzanfragen bearbeiten“** (Suche über alle personenbezogenen Daten, Auskunft, Löschung je Treffer) hat standardmäßig nur die Administration – siehe [Sicherheit](/hilfe/sicherheit).

Bei Medien gibt es drei Stufen: **„Medien sichten“** (ansehen, öffentliche Fassungen laden), **„Medien verwalten“** (Sammlungen, Ordner, Upload-Links, Sichtung, Verschieben, Papierkorb, Originale) und **„Medien administrieren“**. Das dritte Recht hat standardmäßig nur die Administration: Papierkorb endgültig leeren, gesperrte Dateien erneut prüfen oder trotzdem freigeben, Sicherheitsereignisse der Upload-Seiten, Speicherübersicht und fehlgeschlagene Medienaufträge.

Entwurf, Bestätigung der Warnstufe, Freigabe und Versand von Warnentwürfen sind bewusst **getrennte** Rechte. Stichwörter, Regeln, Vorlagen und Zuständigkeiten pflegt die Administration (Recht „Stichwörter und Regeln pflegen“); Regeln und Lagefragen gibt immer eine **andere** Person fachlich frei.

## Einladen

1. [Benutzer und Rollen](/benutzer) → **Einladen**.
2. E-Mail-Adresse und Rollen wählen.
3. Den persönlichen Link sicher weitergeben. Er ist einmalig, befristet und lässt sich über das Menü der Person **widerrufen**.

## Rollen ändern oder Konten sperren

Änderungen wirken sofort; offene Sitzungen der Person werden beendet (bei Änderungen am eigenen Konto bleibt die aktuelle Sitzung bestehen). Über das Menü der Zeile lässt sich eine Person auch **umbenennen**.

**Gesperrte Konten:** Nach mehreren Fehlversuchen bei Passwort oder Code wird ein Konto für unbekannte Geräte vorübergehend gesperrt (bekannte Geräte der Person sind ausgenommen). Die Liste zeigt dann **Gesperrt** mit Ende der Sperre; **Sperre aufheben** im Menü der Zeile entsperrt sofort, auch für einzelne Geräte.

**Erneute Bestätigung:** Besonders kritische Aktionen verlangen dein Passwort (und bei eingerichteter Zwei-Faktor-Anmeldung einen aktuellen Code), wenn deine letzte Bestätigung länger als 10 Minuten her ist: Administrationsrechte vergeben oder ein Konto mit Administration einladen, Zwei-Faktor einer Person zurücksetzen, einen Passwort-Link für ein Konto mit Administration erzeugen und Sicherheitseinstellungen ändern. Eine Bestätigung gilt danach 10 Minuten für mehrere Aktionen. Per API-Schlüssel sind diese Aktionen nicht möglich. Die betroffene Person bzw. die Administration wird benachrichtigt.

 Es bleibt immer mindestens ein aktives Konto mit Administration. Jede Rollenänderung steht mit Person und Zeitpunkt in den [Aktivitäten](/aktivitaeten).

## Rechte im Überblick

<!-- rechte:start -->

**Medien**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Medien ansehen | lesen | Sammlungen, Ordner und geprüfte Medien ansehen, durchsuchen und einzeln in der öffentlichen Fassung (ohne Standort) laden. | – |
| Medien exportieren (ZIP) | lesen | Sammeldownloads der öffentlichen Fassungen als ZIP erstellen und laden. | Medien ansehen |
| Originale herunterladen | ändern | Originaldateien mit möglichen Standortdaten einzeln oder als Sammeldownload laden; Sammeldownloads anderer Personen laden. | Medien ansehen |
| Sammlungen anlegen und bearbeiten | ändern | Sammlungen anlegen, umbenennen, beschreiben und Fristen ändern; aus einem Beitrag eine Sammlung anlegen. | Medien ansehen |
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
| Freigaben in Automationen erteilen | kritisch | Wartende Freigabeschritte laufender Automationen freigeben oder ablehnen. | – |

**Veröffentlichung**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Auf Website veröffentlichen | kritisch | Freigegebene Fassungen an eine gekoppelte Website übergeben, Aufträge abbrechen, klären und wiederholen. | Beiträge ansehen, Websites ansehen |
| Von Website zurückziehen | kritisch | Veröffentlichte Beiträge von der Website zurückziehen. | Beiträge ansehen |
| In sozialen Kanälen veröffentlichen | kritisch | Freigegebene Fassungen auf Facebook und Instagram veröffentlichen oder als Paket exportieren. | Beiträge ansehen, Verbindungen ansehen |
| Aus sozialen Kanälen entfernen | kritisch | Veröffentlichungen in sozialen Kanälen entfernen oder als entfernt bestätigen. | Beiträge ansehen |
| Websites ansehen | lesen | Gekoppelte Websites und ihren Zustand sehen. | – |
| Websites koppeln und widerrufen | kritisch | Websites mit der BlaulichtCMS Bridge koppeln, Kopplungscodes erzeugen, Schlüssel widerrufen, Plugin laden. | Websites ansehen |
| Bridge-Updates freigeben | kritisch | Neue Versionen der BlaulichtCMS Bridge für die Websites freigeben und den Update-Kanal je Website wählen. | Websites ansehen |

**Banner**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Banner ansehen | lesen | Banner und ihren Stand ansehen. | – |
| Banner bearbeiten | ändern | Banner anlegen, ändern und zur Freigabe einreichen; aus einer amtlichen Warnung einen Bannerentwurf anlegen. | Banner ansehen |
| Banner veröffentlichen | kritisch | Freigegebene Banner auf der Website schalten und beenden. | Banner ansehen |

**Warnentwürfe und amtliche Warnungen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Warnvorgänge ansehen | lesen | Warnvorgänge, Fassungen, PDF, Stichwörter und Zuständigkeiten ansehen. | – |
| Warnentwurf erstellen | ändern | Warnentwürfe erfassen, speichern und zur Freigabe einreichen. | Warnvorgänge ansehen |
| Warnvorgänge löschen | ändern | Eigene, noch nicht freigegebene Warnvorgänge löschen; zusammen mit „Warnentwurf freigeben“ auch fremde und freigegebene. | Warnvorgänge ansehen |
| Versandte Warnvorgänge löschen | kritisch | Bereits versandte Warnvorgänge mit Begründung löschen. | Warnvorgänge löschen |
| Warnstufe bestätigen | kritisch | Den Warnstufen-Vorschlag ausdrücklich bestätigen oder mit Begründung ändern. | Warnvorgänge ansehen |
| Warnentwurf freigeben | kritisch | Eine erzeugte PDF-Fassung eines Warnentwurfs freigeben; Prüffragen und Regeln fachlich freigeben. | Warnvorgänge ansehen |
| Stichwörter und Regeln pflegen | kritisch | Stichwörter, Prüffragen, Warnstufen-Regeln, Vorlagen und Zuständigkeiten pflegen. | Warnvorgänge ansehen |
| Warnentwurf versenden | kritisch | Freigegebene Warnentwürfe per E-Mail an die zuständige Stelle senden und den Versand klären. | Warnvorgänge ansehen |
| Versand einstellen | kritisch | Mailserver, Absender und Testmodus für den Versand von Warnentwürfen einstellen und prüfen. | – |
| Amtliche Warnungen ansehen | lesen | Amtliche Warnungen aus den eingerichteten Warnfeeds sehen. | – |
| Amtliche Warnungen ausblenden | ändern | Amtliche Warnungen als erledigt ausblenden. | Amtliche Warnungen ansehen |

**Verbindungen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Verbindungen ansehen | lesen | Verfügbare Verbindungen mit Namen, Art und Zustand sehen (ohne Zugangsdaten und Einstellungen). | – |
| Verbindungen verwalten | kritisch | Verbindungen (FE2, Feuersoftware Connect, Facebook, Instagram, amtliche Warnfeeds) einrichten, ändern, testen, aktivieren und widerrufen. | Verbindungen ansehen |
| Verbindungen löschen | kritisch | Verbindungen löschen und gelöschte Verbindungen zur Nachvollziehbarkeit einsehen. | Verbindungen verwalten |
| Interne Zieladressen erlauben | kritisch | Den Abruf von Adressen im internen Netz für eine Verbindung ausdrücklich erlauben. | Verbindungen verwalten |
| Empfangsprotokoll ansehen | lesen | Empfangsprotokoll eingehender Verbindungen (amtliche Warnungen, FE2, Feuersoftware Connect) mit Entscheidungen und Rohdaten ansehen. | Verbindungen verwalten |

**Automationen**

| Recht | Stufe | Erlaubt | Setzt voraus |
| --- | --- | --- | --- |
| Automationen ansehen | lesen | Automationen, Eingänge, Ausgänge und Laufprotokolle ansehen. | – |
| Automationen verwalten | ändern | Eingänge, Ausgänge und Abläufe anlegen, bearbeiten, testen, aktivieren und deaktivieren. Ausgänge legen nur Entwürfe und Benachrichtigungen an; Freigaben bleiben bei den Menschen. | Automationen ansehen |
| Automationen direkt veröffentlichen lassen | kritisch | Einer Automation erlauben, markierte Ausgänge ohne menschliche Freigabe zu veröffentlichen bzw. zu versenden (mit Passwortbestätigung, Audit und Sicherheitsmeldung). | Automationen verwalten |

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
| Allgemeine Einstellungen ändern | ändern | Name der Instanz, Organisation, Adresse, Zeitzone. | Einstellungen ansehen |
| Sicherheitseinstellungen ändern | kritisch | Zwei-Faktor-Pflicht, Sitzungen, Kontosperre, Passwortlänge, Sicherheitsmeldungen, Gültigkeit von Einladungen, interne Zieladressen. | Einstellungen ansehen |
| Datenschutzeinstellungen ändern | kritisch | Löschfristen, Aufbewahrung der Protokolle, Angaben zu Verantwortlichen und Datenschutzhinweise. | Einstellungen ansehen |
| Medieneinstellungen ändern | ändern | Dateigrößen, erlaubte Dateitypen, Vorgaben für Upload-Links, Prüftiefe und Speichergrenzen. | Einstellungen ansehen |
| Redaktionseinstellungen ändern | kritisch | Vier-Augen-Prinzip und weitere Vorgaben für Redaktion und Freigabe. | Einstellungen ansehen |
| Systemeinstellungen ändern | ändern | Parallele Aufträge und weitere technische Einstellungen. | Einstellungen ansehen |

<!-- rechte:ende -->
