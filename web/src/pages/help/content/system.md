Drei Seiten zeigen, was im System passiert – jede für einen anderen Zweck:

| Seite | Wo | Wofür |
|---|---|---|
| **Aktivitäten** | [Übersicht → Aktivitäten](/aktivitaeten) | Lesbar: wer hat wann was geändert, nach Tagen gruppiert, mit Link zum Objekt |
| **Protokolle** | [Verwaltung → Protokolle](/protokolle) | Technisch: Systemprotokoll der Dienste und das vollständige Audit-Protokoll mit Details |
| **Systemstatus** | [Verwaltung → Systemstatus](/system) | Zustand jetzt: Dienste, Worker, Warteschlange, Speicher, Sicherung, Websites, Audit-Integrität |

## Aktivitäten

Die Aktivitäten sind die lesbare Fassung des Audit-Protokolls (Recht „Audit-Protokoll ansehen“): Jeder Eintrag steht als Satz da – wer, dann was geschah, etwa „… hat in der Einsatzliste „Kaminbrand“ angelegt“.

- **Bereich:** Die Auswahl oben grenzt auf ein Modul ein – Beiträge & Quellen, Kalender, Medien, Einsatzliste, Banner, Designvorlagen, Presse, Warnungen, Websites & Verbindungen, Workflows, Benutzer & Anmeldung oder System. Der Filter wirkt auf das ganze Protokoll, **Ältere laden** holt also weitere Einträge desselben Bereichs. Was ein Workflow angelegt hat (z. B. einen Beitragsentwurf), steht unter **Workflows**.
- **Öffnen:** führt direkt zum betroffenen Beitrag, Termin, Eintrag der Einsatzliste, Banner, zur Presseanfrage, Pressemitteilung, Datei, Designvorlage oder Verbindung – solange es das Objekt noch gibt. Gelöschte Objekte (auch im Papierkorb) tragen den Hinweis **nicht mehr vorhanden**. Einstellungen, Rollen und ähnliche Einträge öffnen die passende Seite.
- **Routine:** Häufige Einträge wie einzelne Anmeldungen blendet die Ansicht „Alle“ aus – sie stehen unter „Benutzer & Anmeldung“ und im Audit-Protokoll.

## Protokolle

- **Systemprotokoll** (Recht „Systemprotokoll ansehen“): technische Meldungen von Server und Worker mit Stufe (Info, Warnung, Fehler), Quelle und Korrelations-ID. Die Korrelations-ID verbindet eine Fehlermeldung in der Oberfläche mit dem passenden Eintrag.
- **Audit-Protokoll** (Recht „Audit-Protokoll ansehen“): jede Änderung mit Person, Zeitpunkt, Ergebnis (erfolgreich, fehlgeschlagen, verweigert) und IP-Adresse; geänderte Einstellungen mit altem und neuem Wert unter „Details“. Filter nach Aktion, Objekt, Person und Ergebnis.

Wie lange beide aufbewahrt werden, steht unter [Einstellungen → Löschfristen](/einstellungen/loeschfristen). Das Audit-Protokoll ist verkettet und versiegelt; mehr dazu unter [Sicherheit](/hilfe/sicherheit).

## Systemstatus

Der Systemstatus aktualisiert sich alle 15 Sekunden und zeigt:

- **Dienste** mit Zustand, dazu Laufzeit, Datenbankgröße, freien Speicher, letzte Sicherung und Version.
- **Worker** und **Warteschlange**: laufende, geplante und endgültig fehlgeschlagene Aufträge. Ohne Worker werden keine Uploads verarbeitet und keine Workflows ausgeführt.
- **Websites** mit Bridge-Version und letztem Abruf.
- **Audit-Integrität**: Prüfung der Verkettung des Audit-Protokolls.
- **Wartungsmodus** (Recht „Wartungsmodus schalten“), siehe [Updates](/hilfe/updates#vorabpruefung-und-wartungsmodus).

Die Statuszeile unter der Navigation zeigt dieselbe Zusammenfassung („Dienste alle laufen“ bzw. Zahl der Hinweise) auf jeder Seite.
