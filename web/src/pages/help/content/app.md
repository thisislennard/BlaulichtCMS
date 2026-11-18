BlaulichtCMS lässt sich auf Handy, Tablet und Computer als App installieren (PWA). Die App läuft in einem eigenen Fenster mit Symbol auf dem Startbildschirm, in der Taskleiste oder im Dock, zeigt Push-Benachrichtigungen als Mitteilungen des Geräts und führt direkt zu **Neuer Beitrag**, **Fotos sammeln** und **Offene Freigaben**.

## Installieren

- Öffne `/app` auf deiner BlaulichtCMS-Adresse, z. B. `https://blaulichtcms.example.org/app`. Angemeldet geht es auch über das **Benutzermenü → App installieren** (der Eintrag fehlt, wenn BlaulichtCMS schon als App läuft).
- In Chrome und Edge öffnet „App installieren“ direkt den Installationsdialog des Browsers; in anderen Browsern zeigt die Seite die passende Anleitung.

Der Installationslink ist bewusst **getrennt** von deiner persönlichen Einladung: Er installiert nur die App. Anmelden kannst du dich erst mit eigenem Konto.

## Am Computer

| Browser | So geht es |
|---|---|
| **Chrome** (Windows, macOS, Linux) | Rechts in der Adressleiste **Installieren** – oder Menü ⋮ → **Streamen, speichern und teilen → Seite als App installieren…** ([Google-Hilfe](https://support.google.com/chrome/answer/9658361?hl=de&co=GENIE.Platform%3DDesktop)) |
| **Edge** (Windows, macOS) | In der Adressleiste das Symbol **App verfügbar** → **Installieren**. Die App steht danach im Startmenü, lässt sich an die Taskleiste anheften und auf Wunsch mit Windows starten ([Microsoft Learn](https://learn.microsoft.com/de-de/microsoft-edge/progressive-web-apps/ux)) |
| **Safari** (Mac, ab macOS Sonoma 14) | Menüleiste **Ablage → Zum Dock hinzufügen** (oder Teilen-Taste → „Zum Dock hinzufügen“), Namen mit **Hinzufügen** bestätigen ([Apple-Support](https://support.apple.com/de-de/104996)) |
| **Firefox** | Keine Installation als App am Computer. Push funktioniert trotzdem im Browser, solange Firefox läuft – der BlaulichtCMS-Tab muss dafür nicht offen sein. Für ein eigenes Fenster Chrome, Edge oder Safari verwenden. |

Nach der Installation die App öffnen, anmelden und unter [Mein Konto → Benachrichtigungen](/profil#benachrichtigungen) **Push einschalten** – die installierte App zählt als eigenes Gerät, auch wenn Push im Browser schon eingeschaltet ist (Safari am Mac: Mitteilungen in der App selbst erlauben). Ein Klick auf eine Mitteilung holt ein offenes BlaulichtCMS-Fenster nach vorn, statt ein weiteres zu öffnen. Wo das System es kann (Chrome und Edge unter Windows und macOS, Safari am Mac), zeigt das App-Symbol die Zahl der ungelesenen Benachrichtigungen.

Deinstallieren: in der App über das Menü oben rechts (Chrome/Edge: „BlaulichtCMS deinstallieren“ bzw. „App-Einstellungen“), in Safari das Symbol aus dem Dock ziehen und im Ordner „Programme“ im Benutzerordner löschen.

## Am Handy und Tablet

- **Android / Chrome / Edge:** „App installieren“ antippen bzw. im Browsermenü „Zum Startbildschirm hinzufügen“.
- **iPhone / iPad:** In Safari „Teilen“ → „Zum Home-Bildschirm“. Push gibt es auf iPhone und iPad nur in der installierten App (ab iOS 16.4).

## Untere Leiste am Handy

Auf schmalen Bildschirmen (Handy, unter 768 px Breite) steht unten eine Leiste mit fünf Feldern – im Browser wie in der installierten App:

| Feld | Inhalt |
|---|---|
| **Dashboard**, **Beiträge**, **Freigaben** | die häufigsten Seiten, nur mit passendem Recht; fehlt eines, rückt die nächste Seite nach (z. B. Presseanfragen oder Warnentwürfe). Freigaben zeigt die Zahl offener Freigaben. |
| **＋ Aktionen** | Schnellaktionen je nach Recht: **Fotos sammeln** (Sammlung mit Upload-Link und QR-Code), **Sichten** (Sammlungen mit offenen Dateien – ein Tipp öffnet die Sichtung), **Neuer Beitrag**, **Neue Erstmeldung** (Warnentwurf), **Anfrage erfassen** (Presse) |
| **Mehr** | alle Bereiche und Seiten wie im Menü am Computer |

So ist jede dieser Aufgaben von jeder Seite aus mit höchstens zwei Tipps erreichbar. Während du in ein Textfeld tippst, blendet sich die Leiste aus. Listen wie Beiträge, Presseanfragen und Einsatzliste stehen am Handy als Karten mit allen wichtigen Angaben untereinander.

## Schnellzugriffe

Ein langer Druck auf das App-Symbol zeigt die Schnellzugriffe – am Computer mit Chrome oder Edge ein Rechtsklick auf das Symbol in Taskleiste, Startmenü bzw. Dock (Safari am Mac bietet keine Schnellzugriffe):

| Schnellzugriff | Öffnet |
|---|---|
| Neuer Beitrag | Dialog „Neuer Beitrag“ |
| Fotos sammeln | Dialog „Fotos sammeln“: neue Sammlung mit Upload-Link |
| Offene Freigaben | Liste der Fassungen, die auf Freigabe oder Veröffentlichung warten |

## Ohne Verbindung

Die App zeigt einen Hinweis, wenn keine Verbindung besteht. **Freigaben und Veröffentlichungen gelten erst, wenn der Server sie bestätigt hat.** Eine Aktion, die ohne Verbindung ausgelöst wurde, muss nach der Wiederverbindung erneut ausgeführt werden. Nach der Wiederverbindung lädt BlaulichtCMS automatisch den aktuellen Stand.
