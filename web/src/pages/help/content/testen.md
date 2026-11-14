Testet jeden Workflow, bevor er „scharf“ geht. LifeLink bietet dafür drei Wege – vom gefahrlosen Durchrechnen bis zum echten Versand.

## Testlauf: simuliert oder echt

Über **Testen** im Editor startet ihr einen Testlauf mit dem aktuellen **Entwurf** (nicht mit der veröffentlichten Version).

| | Simuliert (Standard) | Echte Aktionen |
|---|---|---|
| Bedingungen, Text, Felder zuordnen, JSON lesen | werden echt ausgeführt | werden echt ausgeführt |
| Aktionen (E-Mail, Teams, Banner, Beitrag, MQTT, HTTP-Anfrage) | **nur simuliert** – LifeLink zeigt, was gesendet würde | werden **wirklich** ausgeführt |
| Warten | wird übersprungen | wartet wirklich |
| Wer darf? | alle mit „Workflows bearbeiten“ | nur mit „Aktivieren & veröffentlichen“ |

Bei einem simulierten Lauf seht ihr an jedem Aktionsbaustein den Status **Simuliert** und das, was verschickt worden wäre: Empfänger, fertiger Betreff und Text, Bannertitel, die vollständige HTTP-Anfrage.

> **Achtung:** Ein Testlauf mit echten Aktionen ist echt: E-Mails gehen raus, Banner erscheinen auf der Website. Er wird im Audit-Protokoll vermerkt. Nutzt dafür Test-Empfänger oder eine Testseite.

Testläufe erscheinen im [Ausführungsverlauf](/ausfuehrungen) mit dem Hinweis „Testlauf“ und lösen keine Fehler-Benachrichtigungen aus.

## Mit welchen Daten wird getestet?

LifeLink nimmt der Reihe nach:

1. ein **Testereignis**, das ihr vorher empfangen habt (siehe unten),
2. beim Trigger **Manuell starten** die dort hinterlegten **Beispieldaten**,
3. sonst die **Beispielwerte** des Triggers – z. B. ein erfundener Einsatz „B3 Wohnungsbrand, Hauptstraße 12, Musterstadt“.

## Auf Testereignis warten

Am besten testet ihr mit echten Daten aus dem echten System – etwa einem Probealarm aus FE2. Dafür gibt es **Auf Testereignis warten** bei Triggern, die Daten per Webhook empfangen (Webhook, Alamos-Einsatz):

1. Klickt im Trigger-Baustein auf **Auf Testereignis warten**. LifeLink lauscht jetzt **5 Minuten** lang an der Adresse des Triggers.
2. Löst im anderen System eine Meldung aus, z. B. einen Probealarm in FE2.
3. Die nächste Anfrage wird als **Beispielereignis** gespeichert. Sie startet **keinen** Lauf; der Absender bekommt `202` mit „Testereignis empfangen“.
4. Ab jetzt zeigt der Variablen-Picker die echten Felder mit echten Werten, und Testläufe verwenden dieses Ereignis.

Das funktioniert auch, wenn der Workflow noch nicht aktiv ist. Die Absicherung (Signatur bzw. Schlüssel) wird dabei genauso geprüft wie im Echtbetrieb. Der Stichwort-Filter des Alamos-Triggers greift beim Testempfang nicht, damit jeder Probealarm ankommt.

Das gespeicherte Beispielereignis könnt ihr jederzeit mit **Beispiel verwerfen** wieder löschen.

> **Tipp:** Das Beispielereignis kann echte Einsatzdaten enthalten. Löscht es, wenn ihr fertig seid und die Daten nicht mehr braucht.

## Einzelnen Baustein testen

Im Einstellungsbereich eines Bausteins gibt es **Node testen**. Damit probiert ihr genau diesen einen Baustein aus, ohne den ganzen Workflow zu starten:

- Als Eingangsdaten dienen die Ergebnisse des letzten Laufs bzw. die Beispielwerte.
- Standardmäßig wird **simuliert**. Eine echte Ausführung (z. B. eine echte Testnachricht in Teams) braucht das Recht „Aktivieren & veröffentlichen“ und wird im Audit-Protokoll vermerkt.
- Ihr seht sofort das Ergebnis, die Dauer und bei Fehlern eine verständliche Meldung.

Ideal, um eine Vorlage für Betreff oder Bannertext feinzuschleifen.

## Beispielwerte im Variablen-Picker

Der Variablen-Picker zeigt neben jedem Feld den Wert aus dem **letzten Lauf** dieses Workflows (Test oder echt). Nach einem Testlauf seht ihr also sofort, was in `{{ alamos.ortsteil }}` wirklich drinsteht.

## Checkliste vor dem Veröffentlichen

- [ ] Simulierter Testlauf ist grün; die Texte lesen sich gut.
- [ ] Mit einem echten Testereignis geprüft (z. B. Probealarm).
- [ ] Empfänger, Zielseiten und Topics stimmen – sie stehen auch in der Vorschau beim Veröffentlichen.
- [ ] Keine Personendaten oder genauen Adressen auf öffentlichen Zielen wie der Website.
- [ ] Was passiert, wenn ein Feld fehlt? Bei Bedarf `| default:"…"` ergänzen.
