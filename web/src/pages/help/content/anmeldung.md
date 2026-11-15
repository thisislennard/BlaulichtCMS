## Erste Anmeldung über eine Einladung

Ein Admin lädt dich unter **Benutzer und Rollen** ein. Du bekommst einen persönlichen Link, zum Beispiel per Messenger oder E-Mail.

- Der Link ist **einmalig**: Nach dem Festlegen des Passworts funktioniert er nicht mehr.
- Er ist **befristet** (Standard 72 Stunden) und kann vom Admin **widerrufen** werden.
- Abgelaufen? Ein Admin erzeugt in der Benutzerliste über „Neuer Einladungslink“ einen neuen.

## Passwort

Mindestens 12 Zeichen. Ein langer Satz ist gut merkbar und sicher, z. B. `Morgens zwei Kaffee, abends drei Tee`. Abgelehnt werden Passwörter von einer im Programm enthaltenen Liste häufig verwendeter Passwörter (rund 13 000 Einträge, deutsch und englisch, ohne Abfrage im Internet) – auch mit angehängten Zahlen oder Zeichen wie `Sommer2026!` oder `Feuerwehr112` –, reine Ziffernfolgen, wiederholte Muster und Passwörter, die im Wesentlichen aus Name, E-Mail-Adresse oder Organisation bestehen.

## Zwei-Faktor-Anmeldung

Für Administratoren und Rollen mit „Medien verwalten“ (Medienverwaltung, Redaktion) ist ein zweiter Faktor Pflicht (einstellbar unter Einstellungen → Sicherheit; für Warnentwurf und Benutzerverwaltung empfohlen, dann „Zwei-Faktor für alle“). Du brauchst eine Authenticator-App (z. B. Aegis, 2FAS, Google oder Microsoft Authenticator):

1. QR-Code scannen.
2. Den 6-stelligen Code eingeben.
3. Die **Wiederherstellungscodes** sicher aufbewahren. Jeder funktioniert genau einmal, falls das Telefon verloren geht.

Wer die Zwei-Faktor-Anmeldung später in [Mein Konto](/profil) einrichtet, bestätigt das mit dem Passwort, wenn die letzte Anmeldung länger als 10 Minuten her ist. Nach dem Einrichten werden alle anderen Sitzungen abgemeldet.

Werden die Codes knapp oder sind sie verloren: [Mein Konto](/profil) → **Neue Wiederherstellungscodes** (Passwort und aktueller Code aus der App). Die bisherigen Codes werden dabei ungültig. Auch ein Wechsel des Master-Schlüssels auf dem Server macht die Codes ungültig – du bekommst dann eine Meldung und erzeugst im Profil neue.

Abschalten (nur wenn sie für deine Rolle nicht vorgeschrieben ist) verlangt Passwort **und** aktuellen Code; alle anderen Sitzungen werden danach abgemeldet. Falsche Passwörter bei solchen Bestätigungen zählen wie bei der Anmeldung zur Sperre und stehen im Audit-Protokoll.

## Gesperrt?

Nach fünf falschen Passwörtern (oder Codes) ist die Anmeldung **von unbekannten Geräten** 15 Minuten gesperrt. Geräte, an denen du dich in den letzten 180 Tagen vollständig angemeldet hast, sind davon ausgenommen und haben einen eigenen Zähler – wer dein Konto von außen mit falschen Passwörtern zu sperren versucht, sperrt dich an deinem gewohnten Gerät nicht aus. Bei jeder Sperre bekommen du und die Administration eine Benachrichtigung. Auch bei Passwortänderung, Einrichten oder Abschalten der Zwei-Faktor-Anmeldung, neuen Wiederherstellungscodes und einer Anmeldung mit Wiederherstellungscode bekommst du eine Meldung – mit eingerichtetem E-Mail-Versand auch per E-Mail. Die Anmeldeseite unterscheidet dabei nicht zwischen falschem Passwort, unbekannter Adresse und Sperre – so lässt sich von außen nicht prüfen, ob ein Konto existiert. Ein Admin kann die Sperre in der Benutzerliste aufheben (der Grund steht im Audit-Protokoll). Ein Admin kann in der Benutzerliste einen Link zum Neusetzen des Passworts erzeugen oder die Zwei-Faktor-Anmeldung zurücksetzen. Notfallbefehle für den Server stehen unter [Fehlerbehebung](/hilfe/fehlerbehebung).
