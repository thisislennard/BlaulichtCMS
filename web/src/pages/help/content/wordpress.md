Mit dem **LifeLink-Plugin** für WordPress zeigt eure Website farbige, zeitlich begrenzte **Hinweis-Banner** – automatisch aus Workflows (z. B. bei einem Einsatz) oder von Hand. Außerdem kann LifeLink **Beitragsentwürfe** anlegen, die die Redaktion in WordPress fertigstellt.

WordPress bleibt dabei für Darstellung und Freigabe zuständig: Das Plugin darf nur Banner verwalten und Beiträge als Entwurf oder zur Freigabe anlegen – es kann keine Beiträge direkt veröffentlichen.

## Plugin herunterladen und installieren

1. In LifeLink: [WordPress](/wordpress) → Reiter **Plugin & Darstellung** → Plugin herunterladen (ZIP-Datei).
2. In WordPress: **Plugins → Installieren → Plugin hochladen**, die ZIP-Datei wählen, **Jetzt installieren**, dann **Aktivieren**.

Voraussetzungen: WordPress 6.4 oder neuer, PHP 8.1 oder neuer. Multisite wird unterstützt; Daten und Schlüssel gelten dann je Website.

## Schlüssel erzeugen

1. In WordPress: **Einstellungen → LifeLink** → **Schlüssel erzeugen**.
2. Das Plugin zeigt eine **Schlüssel-ID** (beginnt mit `ll_`), das **Geheimnis** und die Website-Adresse.
3. Kopiert alle drei Werte. **Das Geheimnis wird nur dieses eine Mal angezeigt.**
4. Soll LifeLink auch Beiträge anlegen, wählt auf derselben Seite einen **Autor für Beiträge** (ein WordPress-Benutzer, der Beiträge bearbeiten darf).

## In LifeLink verbinden

1. [Schnittstellen](/schnittstellen) → **WordPress** → verbinden.
2. **Website-Adresse** (z. B. `https://www.feuerwehr-musterstadt.de`), **Schlüssel-ID** und **Geheimnis** eintragen.
3. **Verbindung testen**. LifeLink prüft:
   - ob Website und Plugin erreichbar sind und die Signatur akzeptiert wird (zeigt Website-Name und Plugin-Version),
   - ob die möglichen Zielseiten abgerufen werden können.
4. Speichern. In WordPress steht auf der Einstellungsseite nach der ersten Anfrage „Verbunden“ mit der Zeit der letzten erfolgreichen Anfrage.

Jede Anfrage von LifeLink an WordPress ist mit HMAC-SHA256, Zeitstempel und Einmalwert signiert. Abgefangene Anfragen können nicht wiederverwendet werden.

## Banner aus einem Workflow

Der Baustein **WordPress-Banner** zeigt ein Banner an oder aktualisiert es.

| Feld | Bedeutung |
|---|---|
| **Banner-Schlüssel** | Kennzeichnet „dasselbe“ Banner. Gleicher Schlüssel = das vorhandene Banner wird aktualisiert statt ein zweites angelegt. Standard: `{{ trigger.einsatz_id }}`. |
| **Titel** | max. 120 Zeichen, z. B. `Einsatz: {{ alamos.stichwort }}` |
| **Text** | max. 600 Zeichen, reiner Text |
| **Kennzeichnung** | Kurzer sichtbarer Text vor dem Titel, max. 30 Zeichen, z. B. „Einsatz“. Leer = Standardtext je Farbe (Rot „Wichtig“, Orange „Achtung“, Gelb „Hinweis“, Blau „Information“, Grün „Info“, Neutral „Hinweis“). |
| **Farbe** | Rot, Orange, Gelb, Blau, Grün oder Neutral |
| **Priorität** | Niedrig, Normal oder Hoch. Hohe Priorität steht oben und wird Screenreadern sofort angesagt. |
| **Anzeigedauer** | Ab jetzt für so viele Minuten. **0** = ohne Ende (manuell beenden). |
| **Zielseiten** | Startseite, alle Seiten oder einzelne Seiten der Website |
| **Link / Linktext** | Optional, z. B. zu einer Pressemitteilung |
| **Vor Veröffentlichung freigeben lassen** | Das Banner wird nur als **Entwurf** in LifeLink angelegt. Alle mit dem Recht „Veröffentlichen“ (WordPress) bekommen eine Benachrichtigung und veröffentlichen es von Hand. |

**Beispiel:** Die Vorlage „Einsatz → Website-Banner“ zeigt bei Brandeinsätzen eine Stunde lang:

> **Einsatz** · Einsatz: B3 – Wohnungsbrand · Unsere Einsatzkräfte sind in Nordstadt im Einsatz. Bitte Rettungswege freihalten.

Mit dem Baustein **Banner beenden** (gleicher Banner-Schlüssel) nehmt ihr ein Banner vorzeitig herunter – etwa wenn ein zweiter Workflow „Einsatz beendet“ empfängt.

Beide Bausteine sind **wiederholungssicher**: Läuft ein Workflow zweimal, gibt es trotzdem nur ein Banner.

## Banner von Hand

Unter [WordPress](/wordpress) → **Banner** seht ihr alle Banner mit Farbe, Zeitraum, Status (Aktiv, Geplant, Abgelaufen, Entwurf, Deaktiviert) und Quelle (aus Workflow oder manuell). Mit **Neues Banner** legt ihr eines selbst an – mit Live-Vorschau für Desktop und Handy. Ihr könnt es als Entwurf speichern oder veröffentlichen, später ändern, duplizieren oder deaktivieren.

Rechte: Ansehen braucht „Banner & Beiträge ansehen“, Bearbeiten „Banner & Beiträge bearbeiten“, Veröffentlichen und Deaktivieren „Veröffentlichen“. Die Rolle **WordPress-Redakteur** hat alle drei.

## Beitragsentwürfe

Der Baustein **WordPress-Beitrag** legt einen Beitrag in WordPress an:

| Einstellung „In WordPress“ | Ergebnis |
|---|---|
| **Als Entwurf anlegen** (Standard) | Beitrag als Entwurf; die Redaktion ergänzt und veröffentlicht ihn. |
| **Zur Freigabe einreichen** | Beitrag mit Status „Ausstehender Review“. |
| **Geplant veröffentlichen** | Veröffentlichung nach der eingestellten Zeit – **nur**, wenn im Plugin „Geplante Veröffentlichung durch LifeLink erlauben“ eingeschaltet ist. Sonst wird daraus „Zur Freigabe einreichen“. |

- Im **Inhalt** werden Absätze automatisch erzeugt: Eine Leerzeile beginnt einen neuen Absatz. Eingesetzte Variablen werden HTML-maskiert.
- **Kategorie** wird über den Namen gesucht (z. B. „Einsätze“). Gibt es sie nicht, wird sie nur angelegt, wenn das Plugin es erlaubt.
- Der **Beitrags-Schlüssel** sorgt dafür, dass derselbe Einsatz denselben Entwurf aktualisiert. Bereits veröffentlichte Beiträge ändert LifeLink nicht mehr.
- Im Ergebnis steht `{{ beitrag.edit_url }}` – der Link zum Bearbeiten in WordPress, z. B. für eine Teams-Nachricht an die Redaktion.

Unter [WordPress](/wordpress) → **Beiträge** könnt ihr Beiträge auch in LifeLink schreiben und an WordPress senden.

## Wo erscheinen die Banner?

Das Plugin bietet vier Ausgabewege:

1. **Automatisch am Seitenanfang** (Standard) – über den Theme-Hook `wp_body_open`.
2. **Block** „LifeLink-Hinweise“ im Block-Editor.
3. **Shortcode** `[lifelink_banners]` an beliebiger Stelle.
4. **Widget** für klassische Themes.

Unterstützt euer Theme die automatische Ausgabe nicht oder wollt ihr die Position selbst bestimmen, schaltet die automatische Ausgabe im Plugin ab und setzt Block, Shortcode oder Widget ein.

> **Achtung:** Nutzt auf einer Seite nur **einen** Ausgabeweg – sonst erscheinen die Banner doppelt.

Mehrere Banner werden untereinander gezeigt: zuerst nach Priorität (hoch zuerst), dann die neuesten zuerst. Schrift und Abstände kommen vom Theme, aus LifeLink kommen nur Farbe und Inhalt.

## Ablauf und Cache

Abgelaufene Banner verschwinden zuverlässig:

- WordPress plant zum Start- und Endzeitpunkt jedes Banners ein eigenes Ereignis, zusätzlich gleicht das Plugin alle 5 Minuten ab.
- Bei jeder Änderung leert das Plugin die Caches von **LiteSpeed Cache, WP Rocket, W3 Total Cache, WP Super Cache und WP Fastest Cache**, sofern aktiv. Für andere Lösungen gibt es den Hook `lifelink_banners_changed`.
- Ein kleines Skript entfernt abgelaufene Banner auch aus zwischengespeicherten Seiten im Browser.

Abgelaufene und deaktivierte Banner löscht das Plugin nach 30 Tagen.

## Schlüssel wechseln und widerrufen

Höchstens **zwei Schlüssel** sind gleichzeitig gültig. So wechselt ihr ohne Unterbrechung:

1. In WordPress **Neuen Schlüssel erzeugen**.
2. In LifeLink in der WordPress-Verbindung die **Schlüssel-ID** ändern und das **Geheimnis ersetzen**.
3. **Verbindung testen**.
4. In WordPress den alten Schlüssel **Widerrufen**.

Widerrufen wirkt **sofort**. Ist ein Geheimnis in falsche Hände geraten, widerruft es zuerst und richtet danach einen neuen Schlüssel ein.

Geheimnis nicht kopiert? Es lässt sich nicht erneut anzeigen. Erzeugt einen neuen Schlüssel und widerruft den alten.

## Barrierefreiheit

- Jedes Banner hat eine **sichtbare Kennzeichnung** („Einsatz“, „Wichtig“ …). Die Farbe allein trägt nie die Bedeutung.
- Kontrast mindestens **4,5 : 1**.
- Neue oder entfernte Banner werden Screenreadern angesagt; Banner mit hoher Priorität sofort.
- Eingeschränkte Bewegung („Bewegung reduzieren“ im Betriebssystem) wird respektiert.

Farben lassen sich im Theme über CSS-Variablen anpassen, z. B. `--lifelink-color-rot-bg` und `--lifelink-color-rot-fg`. Achtet dabei auf den Kontrast.

## Fehlerbehebung

| Problem | Ursache und Lösung |
|---|---|
| „Das LifeLink-Plugin ist auf der Website nicht aktiv (Route nicht gefunden)“ | Plugin nicht installiert oder nicht aktiviert. In WordPress unter Plugins prüfen. |
| Anmeldung abgelehnt (401) | Schlüssel-ID oder Geheimnis falsch – oder die Uhr des Webservers weicht mehr als 5 Minuten ab. Werte neu eintragen, Serverzeit prüfen. |
| Zugriff verweigert (403) | Schlüssel wurde in WordPress widerrufen. Neuen Schlüssel erzeugen und eintragen. |
| Zu viele Anfragen (429) | Mehr als 120 Anfragen pro Minute. LifeLink wartet automatisch und versucht es erneut. |
| Test schlägt fehl, obwohl alles stimmt | Ein Sicherheits-Plugin oder eine Web-Application-Firewall blockiert `/wp-json/lifelink/v1/`. Den Bereich freigeben; die Header `X-LifeLink-Key`, `X-LifeLink-Timestamp`, `X-LifeLink-Nonce` und `X-LifeLink-Signature` müssen unverändert ankommen. |
| Banner erscheint nicht | Zielseite richtig? Zeitraum aktiv (Status „Aktiv“, nicht „Geplant“ oder „Abgelaufen“)? Entwurf noch nicht freigegeben? Unterstützt das Theme `wp_body_open` – sonst Block oder Shortcode nutzen. Liefert ein Cache die alte Seite aus? Cache leeren. |
| Banner erscheint doppelt | Mehrere Ausgabewege gleichzeitig aktiv. Nur einen verwenden. |
| Banner in LifeLink mit Status „Fehler“ beim Abgleich | Die Website war nicht erreichbar. LifeLink versucht es automatisch mehrfach erneut; ihr könnt auch von Hand erneut übertragen. |
| Beitrag landet nicht als „Geplant“ | „Geplante Veröffentlichung durch LifeLink erlauben“ ist im Plugin aus – dann wird er zur Freigabe eingereicht. |
| Beitrag wird nicht angelegt | Im Plugin ist kein **Autor für Beiträge** gewählt. |

Liegt die Website im eigenen Netz (z. B. `192.168.…`), muss in der Verbindung unter „Erweiterte Optionen“ **Interne Ziele erlauben** eingeschaltet sein. Siehe [HTTP & REST-Schnittstellen](/hilfe/rest-api#interne-ziele-und-ssrf-schutz).
