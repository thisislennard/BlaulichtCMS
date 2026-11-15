import type pg from 'pg';

/**
 * Getrennte Datenbankrollen (#102, BSI APP.4.3).
 *
 * | Rolle            | Rechte                                                               | Wofür                                   |
 * |------------------|----------------------------------------------------------------------|-----------------------------------------|
 * | `blaulichtcms`       | Superuser (Bootstrap-Rolle von initdb)                               | nur Supervisor, Migrationsschritt, Wartung |
 * | `blaulichtcms_owner` | NOLOGIN, kein Superuser; Eigentümer aller Tabellen, Folgen, Funktionen | Migrationen laufen mit `SET ROLE`        |
 * | `blaulichtcms_app`   | LOGIN, kein Superuser; nur SELECT/INSERT/UPDATE/DELETE, kein TRUNCATE | API, Worker, Kommandozeile              |
 *
 * Die Laufzeitrolle ist nicht Eigentümerin der Tabellen: Sie kann weder Trigger abschalten (Audit nur anhängen, #112)
 * noch Tabellen ändern oder löschen, kein `COPY … TO PROGRAM`, keine Dateien lesen oder schreiben und keine Rollen
 * anlegen. `schema_migrations` darf sie nur lesen.
 *
 * `ensureRoles` läuft bei jedem Migrationsschritt (also bei jedem Start) als Superuser und ist idempotent: Es legt die
 * Rollen an, erzwingt ihre Attribute und überträgt Objekte, die nicht `blaulichtcms_owner` gehören (bestehende Installationen,
 * eingespielte Sicherungen), an die Eigentümerrolle. `grantAppRole` vergibt danach die Rechte der Laufzeitrolle neu –
 * auch für Tabellen, die eine eingespielte Sicherung ohne Rechte (`--no-privileges`) mitgebracht hat.
 */
export const OWNER_ROLE = 'blaulichtcms_owner';
export const APP_ROLE = 'blaulichtcms_app';

const ATTRS = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT';

export async function isSuperuser(db: pg.ClientBase): Promise<boolean> {
  const r = await db.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
  return !!r.rows[0]?.rolsuper;
}

async function ensureRole(db: pg.ClientBase, name: string, login: boolean) {
  const exists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount;
  if (!exists) {
    try {
      await db.query(`CREATE ROLE ${name} ${login ? 'LOGIN' : 'NOLOGIN'} ${ATTRS}`);
    } catch (e) {
      // gleichzeitig von einem anderen Prozess angelegt (z. B. zweite Testdatenbank im selben Cluster)
      if ((e as { code?: string }).code !== '42710' && (e as { code?: string }).code !== '23505') throw e;
    }
  }
  await db.query(`ALTER ROLE ${name} ${login ? 'LOGIN' : 'NOLOGIN'} ${ATTRS}`);
}

/**
 * Rollen anlegen und Eigentum übertragen. Braucht eine Superuser-Verbindung; gibt false zurück (und ändert nichts),
 * wenn die Verbindung keine Superuser-Rechte hat.
 */
export async function ensureRoles(db: pg.ClientBase): Promise<boolean> {
  if (!(await isSuperuser(db))) return false;
  await ensureRole(db, OWNER_ROLE, false);
  await ensureRole(db, APP_ROLE, true);
  // Die Laufzeitrolle darf keiner anderen Rolle angehören (sonst erbte sie deren Rechte, z. B. per SET ROLE)
  const memberships = await db.query<{ parent: string }>(
    `SELECT p.rolname AS parent FROM pg_auth_members m JOIN pg_roles p ON p.oid = m.roleid JOIN pg_roles c ON c.oid = m.member WHERE c.rolname = $1`,
    [APP_ROLE],
  );
  for (const m of memberships.rows) await db.query(`REVOKE ${quoteIdent(m.parent)} FROM ${APP_ROLE}`);

  await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await db.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(await currentDatabase(db))} TO ${APP_ROLE}`);

  // Eigentum übertragen: Tabellen, Sichten, eigenständige Folgen (an Spalten gebundene folgen ihrer Tabelle),
  // Funktionen und eigene Typen im Schema public – ohne Objekte von Erweiterungen
  const objects = await db.query<{ stmt: string }>(
    `WITH own AS (SELECT oid FROM pg_roles WHERE rolname = $1),
          ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e')
     SELECT format('ALTER %s %s OWNER TO %I',
              CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
                             WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
              c.oid::regclass, $1) AS stmt
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
        AND c.relowner <> (SELECT oid FROM own)
        AND c.oid NOT IN (SELECT objid FROM ext)
        AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')))
     UNION ALL
     SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, $1)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proowner <> (SELECT oid FROM own) AND p.oid NOT IN (SELECT objid FROM ext)
     UNION ALL
     SELECT format('ALTER TYPE %s OWNER TO %I', t.oid::regtype, $1)
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r') AND t.typowner <> (SELECT oid FROM own)
        AND t.oid NOT IN (SELECT objid FROM ext)`,
    [OWNER_ROLE],
  );
  for (const o of objects.rows) await db.query(o.stmt);
  return true;
}

/** Rechte der Laufzeitrolle (als Superuser oder als Eigentümerrolle aufrufen). */
export async function grantAppRole(db: pg.ClientBase) {
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
  // TRUNCATE umginge die Lösch-Trigger des Audits; REFERENCES/TRIGGER braucht die Anwendung nicht
  await db.query(`REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}`);
  await db.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  await db.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${APP_ROLE}`);
  // künftige Migrationen (als Eigentümerrolle) vergeben die Rechte von selbst
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`);
}

async function currentDatabase(db: pg.ClientBase): Promise<string> {
  return (await db.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
