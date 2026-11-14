## Anmelden

1. Öffnet LifeLink im Browser und gebt E-Mail-Adresse und Passwort ein.
2. Ist die Zwei-Faktor-Anmeldung eingerichtet, fragt LifeLink danach den 6-stelligen Code aus eurer Authenticator-App ab.
3. Fertig – ihr landet auf dem Dashboard (bzw. bei der WordPress-Verwaltung, wenn ihr nur Redaktionsrechte habt).

Eine Sitzung endet automatisch nach **60 Minuten ohne Aktivität** und spätestens nach **12 Stunden**. Diese Zeiten kann ein Admin in den [Einstellungen](/einstellungen) ändern.

### Zu viele Fehlversuche

Nach **5 falschen Passwörtern** wird das Konto für **15 Minuten** gesperrt. Ihr seht dann „Konto vorübergehend gesperrt“. Wartet die Zeit ab – oder lasst euch von einem Admin einen Link zum Neusetzen des Passworts geben. Dieser hebt die Sperre ebenfalls auf.

## Zwei-Faktor-Anmeldung einrichten

Die Zwei-Faktor-Anmeldung (2FA) schützt euer Konto, auch wenn jemand das Passwort kennt. Für **Plattform-Admins** und **Integrations-Admins** ist sie Pflicht. Ein Admin kann sie in den Einstellungen auch für alle Konten vorschreiben.

So richtet ihr sie ein:

1. Installiert eine Authenticator-App auf dem Diensthandy, z. B. Microsoft Authenticator, Google Authenticator, Aegis oder 2FAS. Jede App, die „TOTP“-Codes erzeugt, funktioniert.
2. LifeLink zeigt einen QR-Code. Scannt ihn mit der App. Geht das nicht, tippt den angezeigten Schlüssel von Hand ein.
3. Gebt den 6-stelligen Code aus der App ein und bestätigt.
4. LifeLink zeigt jetzt **10 Wiederherstellungscodes**. Speichert sie sofort (siehe unten).

Ist 2FA für eure Rolle Pflicht, führt LifeLink euch beim ersten Anmelden automatisch durch diese Schritte.

> **Tipp:** Stimmt der Code nicht, ist fast immer die Uhrzeit des Handys falsch. Stellt sie auf „automatisch“ und versucht es erneut.

## Wiederherstellungscodes

Die Wiederherstellungscodes sind euer Notschlüssel, falls das Handy verloren geht oder kaputt ist.

- Jeder Code sieht so aus: `A1B2C-3D4E5` und gilt **genau einmal**.
- Gebt den Code bei der Code-Abfrage statt des 6-stelligen Codes ein – mit Bindestrich.
- Bewahrt die Codes getrennt vom Handy auf, z. B. im Passwort-Manager oder ausgedruckt im Spind.
- Unter [Mein Konto](/profil) seht ihr, wie viele Codes noch übrig sind.

## Handy verloren

1. Meldet euch mit einem **Wiederherstellungscode** an.
2. Hat das nicht geklappt oder sind alle Codes verbraucht: Bittet einen Admin mit dem Recht „Benutzer verwalten“, unter [Benutzer und Berechtigungen](/benutzer) die **2FA zurückzusetzen**.
3. Beim nächsten Anmelden richtet ihr 2FA mit dem neuen Handy neu ein und bekommt neue Wiederherstellungscodes.

Ist die 2FA für eure Rolle nicht vorgeschrieben, könnt ihr sie unter [Mein Konto](/profil) mit eurem Passwort auch selbst ausschalten.

## Passwort ändern

Unter [Mein Konto](/profil) könnt ihr euer Passwort ändern. Dabei gilt:

- mindestens **12 Zeichen** (ein Admin kann die Mindestlänge erhöhen),
- nicht nur ein einziges Zeichen wiederholt,
- keine zu bekannten Wörter wie „Passwort“, „Feuerwehr“ oder „123456“ in kurzen Passwörtern.

Nach dem Ändern werden alle **anderen** Sitzungen beendet – zum Beispiel ein vergessener Login am Wachen-PC.

> **Tipp:** Ein Satz ist ein gutes Passwort: „Unser HLF steht in Halle 2 am Tor!“

## Passwort vergessen

LifeLink verschickt keine Passwort-E-Mails von selbst. So geht es:

1. Wendet euch an einen Admin mit dem Recht „Benutzer verwalten“.
2. Der Admin öffnet [Benutzer und Berechtigungen](/benutzer), wählt euer Konto und erzeugt einen **Link zum Neusetzen des Passworts**.
3. Der Link ist **24 Stunden** gültig und funktioniert nur einmal. Der Admin schickt ihn euch auf einem sicheren Weg.
4. Über den Link setzt ihr ein neues Passwort. Alle bisherigen Sitzungen werden beendet, eine Sperre wird aufgehoben.

## Sitzungen und Abmelden

Unter [Mein Konto](/profil) seht ihr alle angemeldeten Geräte mit Zeit und IP-Adresse. Ihr könnt einzelne Sitzungen beenden oder euch **überall abmelden** – sinnvoll, wenn ihr euch an einem fremden Rechner angemeldet habt.

## Notfall: Kein Admin kommt mehr herein

Wenn sich kein Plattform-Admin mehr anmelden kann (Passwort vergessen, 2FA-Handy weg, keine Codes), hilft die Kommandozeile auf dem Server. Dafür braucht ihr Zugriff auf den Server, auf dem LifeLink läuft.

Link zum Neusetzen des Passworts erzeugen (24 Stunden gültig, hebt auch eine Sperre auf):

```bash
cd /opt/lifelink
docker compose exec lifelink node server/dist/cli.js password-link admin@feuerwehr-musterstadt.de
```

Zwei-Faktor-Anmeldung eines Kontos zurücksetzen (wird beim nächsten Login neu eingerichtet):

```bash
docker compose exec lifelink node server/dist/cli.js reset-mfa admin@feuerwehr-musterstadt.de
```

Beide Befehle werden im Audit-Protokoll als „Kommandozeile“ vermerkt. Der Link nutzt die Adresse aus `PUBLIC_URL`. Ist sie nicht gesetzt, steht `https://<lifelink-adresse>` davor – ersetzt das durch die Adresse eures Servers.

> **Wichtig:** Diese Befehle umgehen bewusst die normale Anmeldung. Gebt den Serverzugang nur an wenige, vertrauenswürdige Personen.
