-- Manipulationsschutz für das Audit-Protokoll (#112).
--
-- 1. Hash-Kette: Der Worker „versiegelt“ neue Einträge regelmäßig in Reihenfolge (chain_seq). Jeder Eintrag speichert
--    den Hash des Vorgängers (prev_hash) und einen HMAC über Vorgänger-Hash und eigenen Inhalt (hash); der Schlüssel
--    wird aus dem Master-Schlüssel abgeleitet und liegt nie in der Datenbank. Wer einen Eintrag ändert oder aus der
--    Mitte löscht, bricht die Kette – sichtbar bei der Prüfung (Systemstatus bzw. `cli.js audit-verify`).
--    Die IP-Adresse gehört bewusst nicht zum gesicherten Inhalt: sie wird nach Frist entfernt (#115).
-- 2. Nur anhängen: Trigger verbieten das Ändern und Löschen von Einträgen. Erlaubt bleiben nur das Versiegeln (einmalig
--    hash/prev_hash/chain_seq setzen), das Entfernen der IP nach Frist und das Löschen nach Ablauf der Aufbewahrung
--    (mindestens 30 Tage alt). Ein Datenbank-Superuser kann Trigger abschalten – dagegen hilft die Weiterleitung an
--    eine zentrale Protokollierung (AUDIT_FORWARD, docs/betrieb.md).

ALTER TABLE audit_events ADD COLUMN chain_seq bigint, ADD COLUMN prev_hash text, ADD COLUMN hash text;
CREATE UNIQUE INDEX audit_chain_seq_idx ON audit_events (chain_seq) WHERE chain_seq IS NOT NULL;
CREATE INDEX audit_unsealed_idx ON audit_events (id) WHERE chain_seq IS NULL;

-- Kanonischer Inhalt eines Eintrags (ohne IP) – identisch für Versiegeln und Prüfen
CREATE FUNCTION audit_canonical(e audit_events) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT json_build_array(e.id, (extract(epoch FROM e.at) * 1000000)::bigint, e.actor_id, e.actor_name, e.actor_type, e.action,
                          e.object_type, e.object_id, e.object_label, e.result, e.details, e.correlation_id)::text
$$;

CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.at < now() - interval '30 days' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Audit-Einträge sind unveränderlich (Löschen erst nach Ablauf der Aufbewahrung)';
  END IF;
  -- Versiegeln: nur die Kettenfelder, nur einmal
  IF OLD.chain_seq IS NULL AND NEW.chain_seq IS NOT NULL
     AND (to_jsonb(NEW) - 'chain_seq' - 'prev_hash' - 'hash') = (to_jsonb(OLD) - 'chain_seq' - 'prev_hash' - 'hash') THEN
    RETURN NEW;
  END IF;
  -- IP nach Frist entfernen (#115)
  IF NEW.ip = 'entfernt' AND (to_jsonb(NEW) - 'ip') = (to_jsonb(OLD) - 'ip') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Audit-Einträge sind unveränderlich';
END $$;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_append_only();
