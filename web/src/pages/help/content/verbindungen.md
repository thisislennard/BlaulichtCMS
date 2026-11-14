Verbindungen sind **optional**. LifeLink funktioniert vollständig ohne. Jede Verbindung durchläuft dieselben vier Schritte unter [Verbindungen](/verbindungen):

1. **Verbinden** – Einstellungen und Zugangsdaten. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.
2. **Testen** – zeigt jeden Prüfschritt mit Ergebnis. Eine erfolgreiche Anmeldung allein ist **kein** Veröffentlichungstest.
3. **Vorschau** – welche Funktionen das Konto tatsächlich bietet und wie Daten ankommen würden.
4. **Aktivieren** – erst nach bestandenem Test. Anhalten und Widerrufen sind jederzeit möglich.

## Facebook-Seite und Instagram-Konto

Benötigt wird eine eigene Meta-App (Facebook Login bzw. Instagram Login). App-ID und App-Geheimnis eintragen, **Mit Facebook/Instagram verbinden**, bei Facebook die Seite wählen.

- **Test Facebook:** LifeLink legt einen *unveröffentlichten* Beitrag an und löscht ihn sofort wieder.
- **Test Instagram:** LifeLink legt einen Mediencontainer mit einem Testbild an und prüft die Verarbeitung – ohne zu veröffentlichen.

Im Beitrag unter **Soziale Kanäle** die Kanäle wählen (optional mit eigenem Text). Die Auswahl ist Teil der Fassung – eine Änderung braucht eine neue Freigabe. Nach der Freigabe: **Auf sozialen Kanälen veröffentlichen**.

| Status | Bedeutung |
|---|---|
| Veröffentlicht | mit Link zum Beitrag |
| Fehlgeschlagen | eindeutig abgelehnt – **nur dieser Kanal** lässt sich erneut versuchen |
| Ergebnis unbekannt | Verbindung brach ab; vor einem neuen Versuch prüft LifeLink, ob der Beitrag schon existiert |

**Manuell exportieren** liefert den freigegebenen Text je Kanal und befristete Links zu den Dateien.

## FE2 (Einsatzentwürfe)

LifeLink erzeugt eine Eingangsadresse und einen Zugangsschlüssel (nur einmal sichtbar). In FE2 einen HTTP-Ausgang (POST, JSON) mit dem Header `Authorization: Bearer <Schlüssel>` einrichten.

- Vor der Aktivierung zeigt LifeLink nur eine **Vorschau** der Testmeldung.
- Nur die Felder der **Allowlist** (Stichwort, Ort, Alarmzeit, Einheiten, Status) gelangen in den Entwurf. Alarmtexte und Personendaten werden verworfen und nie protokolliert.
- Je Einsatz-ID entsteht **genau ein** interner Entwurf. Folgemeldungen aktualisieren ihn, solange niemand ihn bearbeitet hat.
- Die Alarmierung läuft unabhängig von LifeLink.

## Amtliche Warnungen

Quelle: Warn-App-Schnittstelle des Bundes (Regionalschlüssel des Kreises) oder eine eigene CAP-Adresse. Gebietsfilter über Geocode-Präfixe oder Ortsnamen. Die Meldungen erscheinen unter [Amtliche Warnungen](/amtliche-warnungen) – getrennt vom eigenen Warnentwurf.

- Standard: anzeigen und auf die **Originalquelle** verlinken; ein Banner-Entwurf mit Link durchläuft die normale Freigabe.
- **Automatische Banner** lassen sich erst einschalten, nachdem die fachliche Prüfung dokumentiert wurde (Herkunft, Weiterverwendung, Gebietsfilter, Gültigkeit, Aktualisierungen, Entwarnungen). Aktualisierungen ersetzen, Entwarnungen beenden das Banner.

## Interne Ziele

Adressen im privaten Netz (z. B. ein interner Server) sind gesperrt, bis die Plattform-Administration sie in der Verbindung ausdrücklich freigibt.
