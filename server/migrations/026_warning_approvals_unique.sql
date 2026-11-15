-- Höchstens eine Freigabe je Warnentwurf-Fassung (#179), wie approvals_active_uq bei Beiträgen. Die Freigabe-Route
-- sperrt den Vorgang zusätzlich (Transaktion mit FOR UPDATE). Gibt es aus der Zeit davor bereits doppelte Freigaben
-- derselben Fassung (gleichzeitiges Klicken), bleibt der Bestand unverändert – Freigaben werden nie gelöscht – und der
-- Index wird nicht angelegt; das steht als Warnung im Protokoll der Migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM warning_approvals WHERE decision = 'approved' GROUP BY revision_id HAVING count(*) > 1) THEN
    RAISE WARNING 'warning_approvals: doppelte Freigaben derselben Fassung vorhanden – Index warning_approvals_active_uq nicht angelegt';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS warning_approvals_active_uq ON warning_approvals (revision_id) WHERE decision = 'approved';
  END IF;
END $$;
