import type pg from 'pg';
import { one, pool, tx, type Queryable } from '../db/pool.js';
import { readSecretJson, revokeSecret, storeSecret } from '../lib/secrets.js';
import { notFound } from '../lib/errors.js';

/**
 * Gemeinsamer Rahmen der optionalen Verbindungen: Verbinden → Testen → Vorschau → Aktivieren.
 * Geheimnisse liegen verschlüsselt in `secrets` (Schlüssel unter /data); die API gibt sie nie zurück.
 */
export type ConnectionKind = 'fe2' | 'facebook' | 'instagram' | 'warnfeed' | 'feuersoftware';

export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  status: 'draft' | 'tested' | 'active' | 'disabled' | 'revoked';
  config: Record<string, any>;
  secret_id: string | null;
  account: Record<string, any>;
  capabilities: Record<string, any>;
  last_test: TestResult | null;
  preview: any;
  private_target: string | null;
  private_approved_at: string | null;
}

export interface TestStep {
  name: string;
  ok: boolean;
  message: string;
  /** Hinweis, dass dieser Schritt nur eine Anmeldung prüft (kein Veröffentlichungstest). */
  kind?: 'login' | 'publish' | 'read' | 'receive';
}
export interface TestResult {
  at: string;
  ok: boolean;
  steps: TestStep[];
  /** Konto, Rechte und Funktionen, wie sie der Test tatsächlich vorgefunden hat */
  account?: Record<string, any>;
  capabilities?: Record<string, any>;
}

export const KIND_LABEL: Record<ConnectionKind, string> = {
  fe2: 'FE2 (Einsatzentwürfe)',
  facebook: 'Facebook-Seite',
  instagram: 'Instagram-Konto',
  warnfeed: 'Amtliche Warnungen',
  feuersoftware: 'Feuersoftware Connect (Einsatzentwürfe)',
};

export async function loadConnection(id: string, db: Queryable = pool): Promise<Connection> {
  const c = await one<Connection>('SELECT * FROM connections WHERE id = $1', [id], db);
  if (!c) throw notFound('Verbindung nicht gefunden.');
  return c;
}

export async function connectionSecrets(c: Connection, db: Queryable = pool): Promise<Record<string, string>> {
  return c.secret_id ? readSecretJson(c.secret_id, db) : {};
}

/**
 * Geheimnisse ergänzen bzw. ersetzen (neue Version); die alte Version wird widerrufen. Alles in einer Transaktion
 * unter Zeilensperre der Verbindung (#182): ein Abbruch dazwischen lässt den alten Stand gültig, und zwei
 * gleichzeitige Änderungen bauen aufeinander auf statt sich zu überschreiben.
 */
export async function updateConnectionSecrets(c: Connection, patch: Record<string, string | null>, userId: string | null, db?: pg.PoolClient): Promise<Record<string, string>> {
  if (!db) return tx((client) => updateConnectionSecrets(c, patch, userId, client));
  const locked = await one<{ secret_id: string | null }>('SELECT secret_id FROM connections WHERE id = $1 FOR UPDATE', [c.id], db);
  if (!locked) throw notFound('Verbindung nicht gefunden.');
  const cur = locked.secret_id ? await readSecretJson(locked.secret_id, db) : {};
  const next: Record<string, string> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete next[k];
    else next[k] = v;
  }
  const meta = await storeSecret('connection', c.id, next, userId, db);
  if (locked.secret_id) await revokeSecret(locked.secret_id, db);
  await db.query('UPDATE connections SET secret_id = $2, updated_at = now() WHERE id = $1', [c.id, meta.id]);
  c.secret_id = meta.id;
  return next;
}

/**
 * Einstellungen, die der Verbindungstest nicht prüft und deren Änderung deshalb keinen neuen Test verlangt: der Name
 * (eigene Spalte), Abrufintervall, „Beitragsentwürfe anlegen“ sowie automatische Banner und deren Website (die haben
 * eigene Voraussetzungen: dokumentierte fachliche Prüfung, gekoppelte Website, HTTPS-Quelle). Alles andere – Quelle,
 * Gebiet, Feldzuordnung, App-ID, Seite, Konto – und jede Änderung der Zugangsdaten verlangt einen neuen Test.
 */
export const RETEST_EXEMPT_KEYS = ['intervalMinutes', 'intervalSeconds', 'createDrafts', 'autoBanner', 'bannerSiteId', 'review', 'oauthState', 'tokenExpiresAt'] as const;

/** Vergleichsform einer Konfiguration für die Frage „neuer Test nötig?“ (leere Zuordnungen = Standard). */
export function retestRelevantConfig(cfg: Record<string, any> | null | undefined): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(cfg ?? {}).sort()) {
    if ((RETEST_EXEMPT_KEYS as readonly string[]).includes(k)) continue;
    let v = (cfg as any)[k];
    if (k === 'mapping' && v && typeof v === 'object') v = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' && x.trim() !== '').sort(([a], [b]) => a.localeCompare(b)));
    if (k === 'areaFilter' && v && typeof v === 'object') v = { codes: v.codes ?? [], names: v.names ?? [] };
    if (v === undefined || v === '' || v === null) continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * Verlangt einen neuen Test (#Schnittstellen nur nach Test): Status „Entwurf“, letzter Test verworfen – auch bei
 * aktiven und angehaltenen Verbindungen, damit nie mit ungetesteten Einstellungen oder Zugangsdaten weitergearbeitet
 * oder mit einem alten Test wieder aktiviert wird. Bei FE2 gilt auch die letzte Testmeldung nicht mehr (sie kam mit
 * der alten Zuordnung bzw. dem alten Schlüssel). Gibt den vorherigen Status zurück, wenn sich etwas geändert hat.
 */
export async function requireRetest(c: Connection, db: Queryable = pool): Promise<Connection['status'] | null> {
  const r = await one<{ before: Connection['status']; had_test: boolean }>(
    `UPDATE connections n SET status = 'draft', last_test = NULL, preview = CASE WHEN n.kind IN ('fe2','feuersoftware') THEN NULL ELSE n.preview END, updated_at = now()
       FROM connections o WHERE n.id = o.id AND n.id = $1 AND o.status <> 'revoked'
     RETURNING o.status AS before, (o.last_test IS NOT NULL) AS had_test`,
    [c.id],
    db,
  );
  if (!r || (r.before === 'draft' && !r.had_test)) return null;
  return r.before;
}

/** Private Ziele (LAN, interne Hosts) nur nach ausdrücklicher administrativer Freigabe. */
export function allowedPrivateHosts(c: Connection): string[] {
  return c.private_target && c.private_approved_at ? [c.private_target] : [];
}

/** Ergebnis eines Tests zusammenfassen und speichern. Bestanden → Status „tested“ (aktive bleiben aktiv). */
export async function saveTest(c: Connection, steps: TestStep[], extra: { account?: any; capabilities?: any; preview?: any } = {}): Promise<TestResult> {
  const result: TestResult = { at: new Date().toISOString(), ok: steps.length > 0 && steps.every((s) => s.ok), steps, account: extra.account, capabilities: extra.capabilities };
  await pool.query(
    `UPDATE connections SET last_test = $2, account = COALESCE($3, account), capabilities = COALESCE($4, capabilities), preview = COALESCE($5, preview),
            status = CASE WHEN status IN ('draft','tested') THEN (CASE WHEN $6 THEN 'tested' ELSE 'draft' END) ELSE status END,
            last_error = CASE WHEN $6 THEN NULL ELSE $7 END, updated_at = now()
      WHERE id = $1`,
    [c.id, JSON.stringify(result), extra.account ? JSON.stringify(extra.account) : null, extra.capabilities ? JSON.stringify(extra.capabilities) : null, extra.preview !== undefined ? JSON.stringify(extra.preview) : null, result.ok, steps.find((s) => !s.ok)?.message ?? null],
  );
  return result;
}

/** Fehlertext ohne Tokens (Zugangsdaten nie in Meldungen oder Protokolle). */
export function scrub(msg: string, secrets: Record<string, string> = {}): string {
  let out = String(msg ?? '');
  for (const v of Object.values(secrets)) if (v && v.length >= 6) out = out.split(v).join('***');
  return out.replace(/(access_token|client_secret|token)=([^&\s"]+)/gi, '$1=***').slice(0, 500);
}
