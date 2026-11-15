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
