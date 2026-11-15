Mit einem Foto-Link (Upload-Link) laden Personen **ohne Konto** Fotos und Videos direkt vom Handy in eine Sammlung – zum Beispiel Einsatzkräfte, Helferinnen oder Gäste einer Veranstaltung.

## Link erzeugen

- **Im Beitrag:** „Fotos und Videos sammeln“ legt eine verknüpfte Sammlung samt Link an.
- **Eigenständig:** Unter [Medien](/medien) eine neue Sammlung anlegen. Sie lässt sich später einem Beitrag zuordnen.
- **Weitere Links:** In der Sammlung unter „Upload-Links“ beliebig viele Links erzeugen, z. B. einen für den Aushang und einen für den Messenger.

Beim Anlegen wählst du die **Gültigkeit**: 6 Stunden, 24 Stunden, 3 Tage, 7 Tage, eine eigene Dauer in Tagen oder **Bis Termin** (Datum und Uhrzeit). Die Höchstdauer steht unter Einstellungen → Medien (Standard 90 Tage). Optional bekommt jeder Link einen eigenen **Begrüßungstext**, der oben auf der Upload-Seite steht – statt des Hinweises der Sammlung.

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

**Link nur einmal anzeigen** (Einstellungen → Medien, Standard aus): Dann speichert BlaulichtCMS nur eine Prüfsumme des Links. Link und QR-Code erscheinen genau einmal direkt nach dem Anlegen bzw. „Neu erzeugen“ – bitte sofort kopieren oder den Aushang drucken. Ist die Einstellung aus, liegt der Link verschlüsselt vor und lässt sich jederzeit erneut anzeigen und drucken.

## Was der Link erlaubt – und was nicht

| Erlaubt | Nicht erlaubt |
|---|---|
| Dateien in **genau diese** Sammlung hochladen | Andere Dateien sehen oder herunterladen |
| Einen kurzen Hinweis mitschicken | Andere Sammlungen erreichen |
| | Hochladen nach Ablauf oder Widerruf |

## Datenschutz auf der Upload-Seite

Die Upload-Seite zeigt immer einen Abschnitt **Datenschutz** (Art. 13 DSGVO): verantwortliche Stelle und Kontakt der/des Datenschutzbeauftragten, Zweck, mögliche Veröffentlichung auf Website und in sozialen Medien (Meta, auch USA), was erfasst wird (Dateien mit Dateiname, freiwilliger Hinweis, IP-Adresse zum Schutz vor Missbrauch), die Speicherdauer, die Rechte der Betroffenen und den Link zur Datenschutzerklärung. Der Aushang nennt Verantwortliche und Datenschutzerklärung in einer Zeile.

Die Angaben stehen unter **Einstellungen → Datenschutz** (verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung, optional ein eigener Hinweis z. B. zur Rechtsgrundlage). Solange verantwortliche Stelle oder Datenschutzerklärung fehlen, erinnern Sammlung, Aushang und – nur für angemeldete Verwaltung – die Upload-Seite daran.

Das Hinweisfeld fragt bewusst nicht nach Namen: Wer genannt werden möchte, kann das schreiben, Angaben zu anderen Personen gehören nicht hinein.

## Löschen und Löschfristen

- **Sammlung löschen** (Sammlung → Menü): löscht die Sammlung endgültig mit allen Originalen, Vorschauen, öffentlichen Fassungen, Sammeldownloads, Upload-Links und unterbrochenen Uploads. Gedruckte QR-Codes funktionieren danach nicht mehr. Steckt eine Datei in der aktuellen Fassung eines **laufenden** (nicht archivierten) Beitrags, lehnt BlaulichtCMS ab und nennt den Beitrag: Datei dort aus der Fassung nehmen oder den Beitrag archivieren (veröffentlichte Beiträge vorher zurückziehen). Was auf der Website oder bei Meta schon veröffentlicht ist, löscht „Sammlung löschen“ nicht.
- **Automatisch** (Einstellungen → Datenschutz, 0 = nie): Abgeschlossene Sammlungen – archiviert oder ohne aktiven Link – löscht der Worker **365 Tage** nach der letzten Aktivität (Upload, Sichtung, Link angelegt, benutzt oder abgelaufen, Archivierung). Dateien in laufenden Beiträgen bleiben, bis der Beitrag archiviert ist. Wird ein archivierter Beitrag später wieder aufgenommen, dessen Dateien inzwischen gelöscht sind, zeigt der Beitrag „Dateien fehlen“: Freigeben und Veröffentlichen sind dann gesperrt, bis eine neue Fassung ohne die fehlenden Dateien gespeichert und freigegeben ist – eine Freigabe gilt nie für einen Beitrag mit stillschweigend fehlenden Bildern. Von Hand gelöschte und abgewiesene Dateien sind sofort weg; ihr Datensatz (Dateiname, Hinweis) wird nach **30 Tagen** gelöscht. Abgelaufene oder widerrufene Upload-Links verschwinden **90 Tage** danach aus der Liste.
- **Was würde gelöscht?** unter Einstellungen → Datenschutz zeigt vorab, welche Sammlungen und wie viele Einträge fällig sind. Jeder Löschlauf steht im Audit (`retention.run`, je Sammlung `collection.deleted`).
- In **Sicherungen** bleiben gelöschte Daten bis zu deren Ablauf (rund 4 Monate, siehe Hilfe → Sicherung).

## Grenzen

- Dateigröße je Datei, Anzahl Dateien je Link und Umfang je Sammlung sind begrenzt (einstellbar unter Einstellungen → Medien).
- Wird der Speicher knapp, sperrt BlaulichtCMS Uploads, bevor das System voll läuft.

## Widerrufen und Ablauf

Jeder Link hat ein Ablaufdatum. „Widerrufen“ beendet ihn sofort – **auch ein bereits gedruckter QR-Code funktioniert danach nicht mehr**. Wer einen abgelaufenen, pausierten, widerrufenen oder unbekannten Link öffnet, sieht einheitlich „Dieser Link funktioniert nicht (mehr)“ – die Seite verrät nicht, ob es den Link gibt oder warum er nicht geht.

## Am Handy hochladen

1. Link öffnen oder QR-Code scannen.
2. Der große Knopf **„Bilder oder Videos auswählen“** öffnet die Galerie. Auf Handys und Tablets gibt es darunter **„Foto aufnehmen“** und **„Video aufnehmen“** für die Kamera (abschaltbar unter Einstellungen → Medien).
3. „Senden“. Jede Datei zeigt ihren Fortschritt.
4. Schlägt eine Datei fehl (z. B. Funkloch), erscheint „Erneut senden“. Bereits übertragene Dateien bleiben erhalten und werden nicht doppelt angelegt.
5. Danach erscheint ein Dank mit der **Vorgangsnummer**. Den Text kann die Verwaltung unter Einstellungen → Medien anpassen.

## Quarantäne und Prüfung

Jede Datei landet zuerst **privat in der Quarantäne**. BlaulichtCMS prüft anhand des Inhalts, ob es wirklich ein Foto oder Video ist (JPEG, PNG, WebP, HEIC, MP4, MOV, WebM), und weist alles andere ab. Erst danach gibt es eine Vorschau. Für die Veröffentlichung entsteht eine **öffentliche Fassung ohne Standort- und Kameradaten**; das Original bleibt intern.
