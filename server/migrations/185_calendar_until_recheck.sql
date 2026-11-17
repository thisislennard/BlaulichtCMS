-- Serienende neu bewerten (#231): Bis 0.6.2 hat seriesEnd() höchstens 5 000 Termine gebildet. Bei Serien mit mehr
-- Terminen (z. B. täglich bis 2099 oder COUNT=10000) stand `until_at` deshalb zu früh, und spätere Termine fielen aus
-- den Abfragen. Mehr als ein Termin je Tag ist nicht möglich, eine gekappte Serie reicht also mindestens 4 999 Tage
-- über ihren Beginn hinaus. Für genau diese Serien wird `until_at` auf NULL (unbegrenzt) gesetzt – das ist immer
-- richtig, die Serie wird dann nur bei jeder Abfrage geprüft. Eingelesene Serien bekommen beim nächsten Abgleich
-- (geänderte Datei oder „Jetzt abrufen“) wieder ihr genaues Ende, eigene beim nächsten Speichern.
UPDATE calendar_events
   SET until_at = NULL
 WHERE rrule IS NOT NULL
   AND until_at IS NOT NULL
   AND until_at - starts_at >= interval '4999 days';
