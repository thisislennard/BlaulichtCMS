## Erste Anmeldung über eine Einladung

Ein Admin lädt dich unter **Benutzer und Rollen** ein. Du bekommst einen persönlichen Link, zum Beispiel per Messenger oder E-Mail.

- Der Link ist **einmalig**: Nach dem Festlegen des Passworts funktioniert er nicht mehr.
- Er ist **befristet** (Standard 72 Stunden) und kann vom Admin **widerrufen** werden.
- Abgelaufen? Ein Admin erzeugt in der Benutzerliste über „Neuer Einladungslink“ einen neuen.

## Passwort

Mindestens 12 Zeichen. Ein langer Satz ist gut merkbar und sicher, z. B. `Morgens zwei Kaffee, abends drei Tee`. Abgelehnt werden Passwörter von einer im Programm enthaltenen Liste häufig verwendeter Passwörter (rund 13 000 Einträge, deutsch und englisch, ohne Abfrage im Internet) – auch mit angehängten Zahlen oder Zeichen wie `Sommer2026!` oder `Feuerwehr112` –, reine Ziffernfolgen, wiederholte Muster und Passwörter, die im Wesentlichen aus Name, E-Mail-Adresse oder Organisation bestehen.

## Angemeldet bleiben

Auf der Anmeldeseite gibt es das Feld **Angemeldet bleiben**. In der installierten App (Startbildschirm bzw. Dock) ist es vorbelegt, im normalen Browser-Tab nicht.

- Ohne Haken endet die Sitzung nach 60 Minuten ohne Nutzung, spätestens nach 12 Stunden (einstellbar).
- Mit Haken gibt es keine Abmeldung bei Leerlauf. Die Sitzung endet erst, wenn das Gerät **30 Tage nicht genutzt** wurde. Jede Nutzung verlängert sie wieder.
- Die Sitzung gilt nur in diesem Browser. Ein kopiertes Sitzungs-Cookie nützt auf einem anderen Gerät nichts, die Sitzung wird dann sofort beendet.
- Kritische Aktionen (z. B. Admin-Rechte vergeben, Sicherheitseinstellungen) verlangen weiterhin Passwort und Code.
- Auf gemeinsam genutzten Rechnern den Haken nicht setzen.

Unter [Mein Konto](/profil) → **Angemeldete Geräte** siehst du alle Sitzungen mit Gerät, letzter Nutzung und dem Hinweis „Angemeldet bleiben“. Jede Sitzung lässt sich einzeln abmelden.

## Zwei-Faktor-Anmeldung

Für Konten mit Verwaltungsrechten (mitgeliefert: Administration) und für Rollen mit „Originale herunterladen“ (mitgeliefert: Medienverwaltung, Redaktion) ist ein zweiter Faktor Pflicht (einstellbar unter Einstellungen → Sicherheit; für Warnentwurf und Benutzerverwaltung empfohlen, dann „Zwei-Faktor für alle“). Du brauchst eine Authenticator-App (z. B. Aegis, 2FAS, Google oder Microsoft Authenticator):

1. QR-Code scannen.
2. Den 6-stelligen Code eingeben.
3. Die **Wiederherstellungscodes** sicher aufbewahren. Jeder funktioniert genau einmal, falls das Telefon verloren geht.

Wer die Zwei-Faktor-Anmeldung später in [Mein Konto](/profil) einrichtet, bestätigt das mit dem Passwort, wenn die letzte Anmeldung länger als 10 Minuten her ist. Nach dem Einrichten werden alle anderen Sitzungen abgemeldet.

Die Pflicht gilt **sofort, auch für bereits angemeldete Konten**: Wird sie eingeschaltet oder ausgeweitet (oder bekommt eine Rolle Rechte, für die sie gilt), enden alle Sitzungen von Konten ohne zweiten Faktor – auch mit „Angemeldet bleiben“ gemerkte. Bei der nächsten Anmeldung wird der zweite Faktor eingerichtet. Wer die Pflicht selbst gerade eingeschaltet hat und noch keinen zweiten Faktor hat, kommt direkt zur Einrichtung.

### Gerät für die Zwei-Faktor-Anmeldung merken

Bei der Code-Abfrage gibt es das Feld **Auf diesem Gerät 30 Tage nicht nach dem Code fragen**. Mit Haken genügt auf diesem Gerät 30 Tage lang das Passwort, auf allen anderen Geräten bleibt der Code nötig.

- Ein Gerät wird nur mit einem Code aus der Authenticator-App gemerkt, nicht mit einem Wiederherstellungscode.
- Für kritische Aktionen bleiben Passwort **und** Code nötig.
- Gemerkte Geräte stehen unter [Mein Konto](/profil) → **Gemerkte Geräte (Zwei-Faktor)** und lassen sich dort entfernen.
- Alle gemerkten Geräte werden automatisch entfernt bei: Passwortänderung, Einrichten, Abschalten oder Zurücksetzen der Zwei-Faktor-Anmeldung, **Auf allen Geräten abmelden**, Deaktivieren des Kontos oder einem Passwort-Link durch einen Admin und einem Wechsel des Master-Schlüssels. Nach 30 Tagen fragt die Anmeldung von selbst wieder nach dem Code.
- Beim Merken bekommst du eine Benachrichtigung. Hast du das nicht selbst getan: Gerät entfernen, Passwort ändern, Administration informieren.

Werden die Codes knapp oder sind sie verloren: [Mein Konto](/profil) → **Neue Wiederherstellungscodes** (Passwort und aktueller Code aus der App). Die bisherigen Codes werden dabei ungültig. Auch ein Wechsel des Master-Schlüssels auf dem Server macht die Codes ungültig – du bekommst dann eine Meldung und erzeugst im Profil neue.

Abschalten (nur wenn sie für deine Rolle nicht vorgeschrieben ist) verlangt Passwort **und** aktuellen Code; alle anderen Sitzungen werden danach abgemeldet. Falsche Passwörter bei solchen Bestätigungen zählen wie bei der Anmeldung zur Sperre und stehen im Audit-Protokoll.

## Gesperrt?

Nach fünf falschen Passwörtern (oder Codes) ist die Anmeldung **von unbekannten Geräten** 15 Minuten gesperrt. Geräte, an denen du dich in den letzten 180 Tagen vollständig angemeldet hast, sind davon ausgenommen und haben einen eigenen Zähler – wer dein Konto von außen mit falschen Passwörtern zu sperren versucht, sperrt dich an deinem gewohnten Gerät nicht aus. Bei jeder Sperre bekommen du und die Administration eine Benachrichtigung. Auch bei Passwortänderung, Einrichten oder Abschalten der Zwei-Faktor-Anmeldung, neuen Wiederherstellungscodes und einer Anmeldung mit Wiederherstellungscode bekommst du eine Meldung – mit eingerichtetem E-Mail-Versand auch per E-Mail. Die Anmeldeseite unterscheidet dabei nicht zwischen falschem Passwort, unbekannter Adresse und Sperre – so lässt sich von außen nicht prüfen, ob ein Konto existiert. Ein Admin kann die Sperre in der Benutzerliste aufheben (der Grund steht im Audit-Protokoll). Ein Admin kann in der Benutzerliste einen Link zum Neusetzen des Passworts erzeugen, die Zwei-Faktor-Anmeldung zurücksetzen oder eine Person **auf allen Geräten abmelden** (beendet alle Sitzungen und entfernt gemerkte Geräte, z. B. bei verlorenem Telefon). Notfallbefehle für den Server stehen unter [Fehlerbehebung](/hilfe/fehlerbehebung).
