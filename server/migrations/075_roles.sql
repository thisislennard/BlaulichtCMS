-- Rollen in der Datenbank: mitgelieferte Rollen (is_system) und selbst angelegte Rollen mit feinen Rechten.
--
-- users.roles und api_keys.roles enthalten weiterhin die Kennungen der Rollen. Die neun bisherigen Rollen werden
-- als mitgelieferte Rollen eingetragen; permissions = NULL bedeutet „Vorgabe des Programms“ (auth/permissions.ts,
-- SYSTEM_ROLES). Damit behält jedes Konto beim Update genau seine bisherigen Möglichkeiten, und künftige Rechte
-- kommen bei unveränderten mitgelieferten Rollen von selbst an. Geänderte und eigene Rollen speichern ihre Rechte
-- ausdrücklich. „Administration“ (platform_admin) hat immer alle Rechte; ihr Eintrag ist nicht änderbar.
CREATE TABLE roles (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,39}$'),
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 60),
  description text NOT NULL DEFAULT '',
  permissions text[],
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX roles_label_uq ON roles (lower(btrim(label)));

INSERT INTO roles (id, label, description, is_system) VALUES
  ('platform_admin',   'Administration',   'Vollzugriff: Konten, Rechte, Kanäle, Systemzustand, Sicherungen. Hat immer alle Rechte und lässt sich nicht ändern.', true),
  ('media_manager',    'Medienverwaltung', 'Pflegt Sammlungen und Upload-Links, sichtet und wählt Medien aus.', true),
  ('editor',           'Redaktion',        'Erstellt Beiträge, übernimmt Medien und reicht Fassungen zur Freigabe ein.', true),
  ('approver',         'Freigabe',         'Gibt geprüfte Fassungen frei.', true),
  ('publisher',        'Veröffentlichung', 'Übergibt freigegebene Fassungen an die Zielkanäle.', true),
  ('warning_author',   'Warnentwurf',      'Erfasst Warnentwürfe (Erstmeldung, Aktualisierung, Entwarnung).', true),
  ('warning_approver', 'Warnfreigabe',     'Bestätigt Warnstufen, gibt Warnentwürfe und Regeln fachlich frei.', true),
  ('warning_sender',   'Warnversand',      'Versendet freigegebene Warnentwürfe an die zuständige Stelle.', true),
  ('viewer',           'Lesezugriff',      'Sieht Beiträge, Medien und deren Status, ändert nichts.', true);

-- Änderungen sofort an API, Worker und Oberfläche melden (Rechte gelten ab der nächsten Anfrage)
CREATE TRIGGER roles_notify AFTER INSERT OR UPDATE OR DELETE ON roles FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change();
