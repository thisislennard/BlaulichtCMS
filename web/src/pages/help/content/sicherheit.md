| Bereich | Umsetzung |
|---|---|
| Rechte | Serverseitig bei jeder Aktion, jedem Objekt und jeder Datei; Standard ist „verweigert“ |
| Anmeldung | Passwörter mit Argon2id, Zwei-Faktor (TOTP) mit Wiederherstellungscodes, Sperre nach Fehlversuchen |
| Sitzungen | Serverseitig, Cookies `HttpOnly` und `SameSite=Strict`, CSRF-Schutz, Leerlauf- und Höchstdauer |
| Uploads | Nur über befristete, widerrufbare Links in genau eine Sammlung; Größen- und Mengengrenzen; Quarantäne; Prüfung des Inhalts statt des Dateinamens |
| Medien | Privat außerhalb des Webservers; Auslieferung nur mit Recht; öffentliche Fassung ohne Standort- und Kameradaten |
| Websites | Eigener Schlüssel je Website, nur als Prüfsumme gespeichert, sofort widerrufbar; die Bridge ruft nur aus |
| Datenbank | Nur im Container über einen Unix-Socket erreichbar, kein offener Port |
| Geheimnisse | Verschlüsselt mit AES-256-GCM; der Master-Schlüssel liegt nie in der Datenbank |
| Protokolle | Audit mit Person und Zeitpunkt; Tokens und vertrauliche Inhalte werden nicht protokolliert |
| Container | Unprivilegierter Benutzer, schreibgeschütztes Dateisystem, keine Capabilities |

## Was ihr tun solltet

- LifeLink nur über HTTPS erreichbar machen.
- Zwei-Faktor-Pflicht für Administration eingeschaltet lassen.
- Upload-Links nur so lange gültig machen wie nötig und nach Gebrauch widerrufen.
- Den Master-Schlüssel und die Sicherungen getrennt aufbewahren.
