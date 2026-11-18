Mit einem Upload-Link laden Personen **ohne Konto** Fotos und Videos direkt vom Handy in eine Sammlung – zum Beispiel Einsatzkräfte, Helferinnen oder Gäste einer Veranstaltung.

## Link erzeugen

- **Im Beitrag:** „Fotos sammeln“ legt eine verknüpfte Sammlung samt Upload-Link an.
- **Eigenständig:** Unter [Medien](/medien) eine neue Sammlung anlegen. Sie lässt sich später einem Beitrag zuordnen.
- **Weitere Links:** In der Sammlung unter „Upload-Links“ beliebig viele Links erzeugen, z. B. einen für den Aushang und einen für den Messenger.

Beim Anlegen wählst du die **Gültigkeit**: 6 Stunden, 24 Stunden, 3 Tage, 7 Tage, eine eigene Dauer in Tagen oder **Bis Termin** (Datum und Uhrzeit). Die Höchstdauer steht unter Einstellungen → Medien & Upload (Standard 90 Tage). Optional bekommt jeder Link einen eigenen **Begrüßungstext**, der oben auf der Upload-Seite steht – statt des Hinweises der Sammlung.

Zu jedem Link gibt es **Link kopieren**, **QR-Code anzeigen**, **Aushang drucken** und **Teilen** (WhatsApp, E-Mail, Teilen-Dialog des Geräts, QR-Code als PNG oder SVG). Siehe [QR-Codes und Aushänge](/hilfe/qr-codes).

## Link bedienen

Das Menü (⋯) neben jedem Link bietet:

- **Bearbeiten:** Bezeichnung und Begrüßungstext ändern.
- **Pausieren / Fortsetzen:** Pausiert kann niemand hochladen; gedruckte QR-Codes bleiben gültig und funktionieren nach „Fortsetzen“ wieder. Ein abgelaufener Link muss vor dem Fortsetzen verlängert werden.
- **Um 24 Stunden / um 7 Tage verlängern:** gerechnet ab dem bisherigen Ablauf (bei abgelaufenem Link ab jetzt), höchstens bis zur Höchstdauer.
- **Bis Termin …:** Ablauf auf Datum und Uhrzeit setzen – auch früher als bisher.
- **Neu erzeugen:** neuer Link und QR-Code mit denselben Einstellungen. Der bisherige Link, sein QR-Code und gedruckte Aushänge funktionieren sofort nicht mehr – praktisch, wenn ein Link in falsche Hände geraten ist.
- **Widerrufen:** beendet den Link endgültig.

Die Liste zeigt je Link Status (Aktiv, Pausiert, Abgelaufen, Widerrufen), Ablauf, Anzahl und Umfang der Dateien, wer ihn angelegt hat und wann er zuletzt genutzt wurde.

**Link nur einmal anzeigen** (Einstellungen → Medien & Upload, Standard aus): Dann speichert BlaulichtCMS nur eine Prüfsumme des Links. Link und QR-Code erscheinen genau einmal direkt nach dem Anlegen bzw. „Neu erzeugen“ – bitte sofort kopieren oder den Aushang drucken. Ist die Einstellung aus, liegt der Link verschlüsselt vor und lässt sich jederzeit erneut anzeigen und drucken.

## Was der Link erlaubt – und was nicht

| Erlaubt | Nicht erlaubt |
|---|---|
| Dateien in **genau diese** Sammlung hochladen | Andere Dateien sehen oder herunterladen |
| Einen kurzen Hinweis mitschicken | Andere Sammlungen erreichen |
| | Hochladen nach Ablauf oder Widerruf |

## Datenschutz auf der Upload-Seite

Die Upload-Seite zeigt immer einen Abschnitt **Datenschutz** (Art. 13 DSGVO): verantwortliche Stelle und Kontakt der/des Datenschutzbeauftragten, Zweck, mögliche Veröffentlichung auf Website und in sozialen Medien (Meta, auch USA), was erfasst wird (Dateien mit Dateiname, freiwilliger Hinweis, IP-Adresse zum Schutz vor Missbrauch), die Speicherdauer, die Rechte der Betroffenen und den Link zur Datenschutzerklärung. Der Aushang nennt Verantwortliche und Datenschutzerklärung in einer Zeile.

Die Angaben stehen unter **Einstellungen → Datenschutz & Recht** (verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung, optional ein eigener Hinweis z. B. zur Rechtsgrundlage). Solange verantwortliche Stelle oder Datenschutzerklärung fehlen, erinnern Sammlung, Aushang und – nur für angemeldete Verwaltung – die Upload-Seite daran.

Standardmäßig fragt die Upload-Seite nur einen freiwilligen Hinweis ab und bewusst keinen Namen. Fragt ein Link Name, E-Mail-Adresse, Aufnahmeort oder -datum ab (siehe „Erweiterte Optionen“), nennt der Datenschutzabschnitt diese Angaben automatisch samt Löschfrist (Einstellungen → Löschfristen → „Angaben der Hochladenden“, Standard 12 Monate; die Dateien bleiben).

## Datenschutzerklärung und Impressum

Unter **Einstellungen → Datenschutz & Recht** lassen sich eine eigene **Datenschutzerklärung** und ein **Impressum** als Text hinterlegen (Markdown: `# Überschrift`, `**fett**`, `- Liste`, `[Link](https://…)`; HTML wird nicht übernommen). **Vorschau** zeigt die Darstellung, **Vorlage einfügen** setzt eine neutrale Gliederung mit Platzhaltern in eckigen Klammern ein – sie ist ausdrücklich als Vorlage markiert, ersetzt keine rechtliche Prüfung und muss vollständig angepasst werden. Solange der Vorlagenhinweis im Text steht, erinnert die Einstellungsseite daran.

Die Texte sind ohne Anmeldung unter `/datenschutz` und `/impressum` erreichbar und unten auf der Anmeldeseite, der Upload-Seite, der App-Installationsseite und in der App verlinkt. Ist ein Feld leer, zeigt die Seite „Noch kein Text hinterlegt“ und die Links sind ausgeblendet. Ist keine eigene Adresse für die Datenschutzerklärung eingetragen, verlinken Upload-Seite und Aushang die eigene Seite `/datenschutz`. Ändern darf, wer das Recht **Datenschutzeinstellungen ändern** hat.

## Erweiterte Optionen je Link

Beim Anlegen und unter **Bearbeiten** öffnet „Erweitert“ weitere Einstellungen (wie in LiFeOS):

- **Grenzen** (0 = unbegrenzt): Uploads je Link (ein Upload = ein Vorgang mit eigener Vorgangsnummer), Dateien je Upload, maximale Dateigröße, Gesamtgröße. **Link schließen, wenn eine Grenze erreicht ist** (Standard bei neuen Links): Die Upload-Seite zeigt dann „Dieser Link funktioniert nicht (mehr)“, die Liste „Kontingent erreicht“. Ohne diese Option bleibt die Seite erreichbar und weist weitere Dateien mit Hinweis ab. Die Dateien je Link und das Kontingent der Sammlung gelten immer zusätzlich.
- **Erlaubte Dateitypen:** Auswahl aus den global erlaubten Typen (Einstellungen → Medien & Upload). Andere Dateien weist die Prüfung mit Grund ab.
- **Abgefragte Angaben:** Name, E-Mail-Adresse, Hinweis, Aufnahmeort, Aufnahmedatum – je **nicht abfragen**, **freiwillig** oder **Pflicht**. Die Angaben sieht nur, wer „Medien sichten und auswählen“ hat (Details der Datei). Nur abfragen, was wirklich gebraucht wird.
- **Bestätigung vor dem Upload:** Pflicht-Kästchen mit eigenem Text (z. B. „Ich habe die Aufnahmen selbst gemacht …“); der Zeitpunkt wird je Datei gespeichert.
- **Passwort** (mindestens 10 Zeichen): Wer den Link öffnet, gibt es zuerst ein; die Freigabe gilt 12 Stunden in diesem Browser. Ein neues Passwort beendet alle bisherigen Freigaben. Fehlversuche werden protokolliert und gebremst.

Das Menü eines Links bietet außerdem **Angaben der Hochladenden löschen**: Name, E-Mail, Ort, Datum und Hinweise aller Uploads über diesen Link werden entfernt, die Dateien bleiben.

## Löschen und Löschfristen

- **Papierkorb:** „In den Papierkorb“ (Datei, Ordner samt Inhalt oder ganze Sammlung) löscht nicht sofort. Unter [Medien → Papierkorb](/medien/papierkorb) lässt sich alles bis zum Ablauf der Frist (Standard **30 Tage**, Einstellungen → Löschfristen → „Papierkorb leeren nach“) wiederherstellen – Ordner kommen samt Inhalt zurück. Upload-Links einer Sammlung im Papierkorb funktionieren nicht, nach dem Wiederherstellen wieder. **Endgültig löschen** und **Papierkorb leeren** darf nur, wer „Medien administrieren“ hat; nach Ablauf der Frist erledigt das der Hintergrunddienst.
- **Endgültig gelöscht** (aus dem Papierkorb oder nach Ablauf der Frist) wird die Sammlung mit allen Originalen, Vorschauen, öffentlichen Fassungen, Sammeldownloads, Upload-Links und unterbrochenen Uploads. Gedruckte QR-Codes funktionieren danach nicht mehr. Steckt eine Datei in der aktuellen Fassung eines **laufenden** (nicht archivierten) Beitrags, lehnt BlaulichtCMS ab und nennt den Beitrag: Datei dort aus der Fassung nehmen oder den Beitrag archivieren (veröffentlichte Beiträge vorher zurückziehen). Was auf der Website oder bei Meta schon veröffentlicht ist, löscht „Sammlung löschen“ nicht.
- **Automatisch** (Einstellungen → Löschfristen, 0 = nie): Abgeschlossene Sammlungen – archiviert oder ohne aktiven Link – löscht der Worker **365 Tage** nach der letzten Aktivität (Upload, Sichtung, Link angelegt, benutzt oder abgelaufen, Archivierung). Dateien in laufenden Beiträgen bleiben, bis der Beitrag archiviert ist. Wird ein archivierter Beitrag später wieder aufgenommen, dessen Dateien inzwischen gelöscht sind, zeigt der Beitrag „Dateien fehlen“: Freigeben und Veröffentlichen sind dann gesperrt, bis eine neue Fassung ohne die fehlenden Dateien gespeichert und freigegeben ist – eine Freigabe gilt nie für einen Beitrag mit stillschweigend fehlenden Bildern. Von Hand gelöschte Dateien liegen bis zum Ablauf der Papierkorb-Frist (**30 Tage**) im Papierkorb und werden dann samt Datensatz entfernt; bei abgewiesenen Dateien ist die Datei sofort weg und der Datensatz (Dateiname, Hinweis) folgt nach derselben Frist. Abgelaufene oder widerrufene Upload-Links verschwinden **90 Tage** danach aus der Liste.
- **Was würde gelöscht?** unter Einstellungen → Löschfristen zeigt vorab, welche Sammlungen und wie viele Einträge fällig sind. Jeder Löschlauf steht im Audit (`retention.run`, je Sammlung `collection.deleted`).
- In **Sicherungen** bleiben gelöschte Daten bis zu deren Ablauf (rund 4 Monate, siehe Hilfe → Sicherung).

## Upload-Seite gestalten

Unter [Einrichtung → Upload-Seite](/upload-seite) lässt sich die Upload-Seite wie in LiFeOS aus **Bausteinen** zusammenstellen: Titelbild, Logo, Überschrift, Text, Bild mit Bildunterschrift, Hinweisbox, Trennlinie, Begrüßungstext des Links und der Upload-Bereich (Pflicht, genau einmal; höchstens 30 Bausteine). Dazu eine **Akzentfarbe** aus einer festen Auswahl mit gutem Kontrast und der Schalter für den Kopfbereich (Organisation, Titel, Zweck, Gültigkeit). Die **Vorschau** zeigt die Seite wahlweise als Handy oder Rechner.

- In Texten stehen **{thema}** für den Titel der Sammlung und **{datum}** für ihr Veranstaltungsdatum.
- Texte bleiben reiner Text – HTML, Formatierungen oder Skripte werden nicht ausgeführt, sondern als Text gezeigt.
- Bilder (JPEG, PNG, WebP bis 15 MB) werden beim Hochladen neu kodiert, höchstens 2400 Pixel groß und ohne Standort- und Kameradaten gespeichert. Nicht mehr verwendete Bilder entfernt der Hintergrunddienst nach einem Tag.
- Der **Datenschutzabschnitt** steht immer am Ende und lässt sich nicht entfernen.
- Die Standardgestaltung gilt für alle Links ohne eigene und ändert, wer „Medien administrieren“ hat. Für einzelne Links: Menü des Links → **Upload-Seite gestalten** („Medien verwalten“); „Standard verwenden“ verwirft die eigene Gestaltung.

## Benachrichtigungen

Die Glocke meldet zu Medien:

- **Neue Dateien:** Sind über einen Upload-Link Dateien eingegangen und geprüft, bekommt die Person, die den Link angelegt hat, einen Hinweis (sonst alle mit „Medien sichten und auswählen“). Weitere Dateien derselben Sammlung innerhalb einer Stunde zählen im selben Eintrag hoch („3 neue Dateien in …“), statt die Glocke zu fluten.
- **Upload-Links:** Ein Link läuft bald ab (höchstens 24 Stunden vorher, bei kurzen Links nach drei Vierteln der Gültigkeit; nach dem Verlängern erneut) oder das Kontingent von Link bzw. Sammlung ist erreicht.
- **Speicherplatz:** Unterschreitet der freie Speicher die Warnschwelle (Einstellungen → Medien & Upload, Standard 10 GB), erfahren es alle mit „Medien administrieren“ – höchstens alle 12 Stunden.

Unter [Mein Konto → Benachrichtigungen](/profil#benachrichtigungen) lässt sich jede Art für sich in der Glocke, für Push und für E-Mail abschalten; die Verwaltung kann sie unter Einstellungen → Medien & Upload ganz abschalten.

## Grenzen

- Dateigröße je Datei, Anzahl Dateien je Link und Umfang je Sammlung sind begrenzt (einstellbar unter Einstellungen → Medien & Upload).
- Wird der Speicher knapp, sperrt BlaulichtCMS Uploads, bevor das System voll läuft. Vorher warnt die Glocke (Speicherwarnung).
- **Speicherübersicht:** [Verwaltung → Medienverwaltung](/medienverwaltung) (nur „Medien administrieren“) zeigt freien Platz, Verbrauch je Art (Fotos, Videos), je Sammlung und je Ordner sowie den Platz von Papierkorb, gesperrten Dateien und ZIP-Downloads.
- **ZIP-Downloads** liegen standardmäßig 24 Stunden bereit und sind höchstens 20 GB groß (Einstellungen → Medien & Upload).

## Widerrufen und Ablauf

Jeder Link hat ein Ablaufdatum. „Widerrufen“ beendet ihn sofort – **auch ein bereits gedruckter QR-Code funktioniert danach nicht mehr**. Wer einen abgelaufenen, pausierten, widerrufenen oder unbekannten Link öffnet, sieht einheitlich „Dieser Link funktioniert nicht (mehr)“ – die Seite verrät nicht, ob es den Link gibt oder warum er nicht geht.

## Am Handy hochladen

1. Link öffnen oder QR-Code scannen.
2. Der große Knopf **„Bilder oder Videos auswählen“** öffnet die Galerie. Auf Handys und Tablets gibt es darunter **„Foto aufnehmen“** und **„Video aufnehmen“** für die Kamera (abschaltbar unter Einstellungen → Medien & Upload).
3. „Senden“. Jede Datei zeigt ihren Fortschritt.
4. Schlägt eine Datei fehl (z. B. Funkloch), erscheint „Erneut senden“. Bereits übertragene Dateien bleiben erhalten und werden nicht doppelt angelegt.
5. Danach erscheint ein Dank mit der **Vorgangsnummer**. Den Text kann die Verwaltung unter Einstellungen → Medien & Upload anpassen.

## Quarantäne und Prüfung

Jede Datei landet zuerst **privat in der Quarantäne**. BlaulichtCMS prüft anhand des Inhalts, ob es wirklich ein erlaubtes Foto oder Video ist (Einstellungen → Medien & Upload bzw. je Link: JPEG, PNG, WebP, HEIC, AVIF, GIF, MP4, MOV, WebM, 3GP), und sperrt alles andere. Bilder werden vollständig dekodiert (Grenze in Megapixel einstellbar), animierte Bilder nur mit Einstellung zugelassen. Videos werden wie in LiFeOS dekodiert: bis zu einer einstellbaren Länge (Standard 60 Sekunden) Bild für Bild, längere am Anfang Bild für Bild und danach alle Schlüsselbilder; dazu Codecs, Länge und Auflösung. Erst danach gibt es eine Vorschau. Für die Veröffentlichung entsteht eine **öffentliche Fassung ohne Standort- und Kameradaten**; das Original bleibt intern.

## Gesperrte Dateien

Fällt eine Datei bei der Prüfung auf (falscher Typ, beschädigt, zu lang, zu groß, nicht dekodierbar), wird sie **gesperrt** statt sofort gelöscht: Sie bleibt in der Quarantäne, wird nie ausgeliefert und steht mit Grund im Reiter **In Prüfung / gesperrt** der Sammlung sowie unter [Verwaltung → Medienverwaltung](/medienverwaltung). Wer „Medien administrieren“ hat, kann

- **Erneut prüfen** (einzeln oder **Alle erneut prüfen**, z. B. nach einer geänderten Einstellung),
- bei Videos, die **nur** an der Dekodierprüfung gescheitert sind, **Trotzdem freigeben** – mit Begründung; Dateityp, Aufbau, Länge und Auflösung werden weiter geprüft, die Freigabe steht im Audit und erzeugt eine Sicherheitsmeldung,
- **Endgültig löschen**.

Nach der Frist „Gesperrte Dateien löschen nach“ (Einstellungen → Löschfristen, Standard 30 Tage) löscht BlaulichtCMS sie automatisch. Findet die Schadsoftwareprüfung (ClamAV) etwas, wird die Datei dagegen **sofort gelöscht** und lässt sich nie freigeben.

## Sicherheitsereignisse

Unter **Verwaltung → Medienverwaltung** stehen die Sicherheitsereignisse der Upload-Seiten: Aufrufe abgelaufener, pausierter oder widerrufener Links, falsche Passwörter, zu viele Anfragen, erreichte Kontingente, voller Speicher, gesperrte Dateien und Freigaben trotz Befund. Gespeichert werden nur Link, Ereignis, Zeit und ein gekürzter, nicht umkehrbarer Hash der IP-Adresse – keine Klar-IP, kein Token, keine Namen. Gleiche Ereignisse zählen höchstens einmal in 10 Minuten. Aufbewahrung: Einstellungen → Löschfristen (Standard 365 Tage). Dort stehen auch **fehlgeschlagene Medienaufträge** (Prüfung, Bereinigung, öffentliche Fassung, ZIP) mit „Erneut versuchen“.
