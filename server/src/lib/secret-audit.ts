import { many, pool, tx, type Queryable } from '../db/pool.js';
import { log } from './log.js';

/**
 * Prüfung „keine Zugangsdaten im Klartext“ (#190). Zugangsdaten der Schnittstellen gehören ausschließlich verschlüsselt
 * in `secrets` (lib/secrets.ts, AES-256-GCM mit Zweckbindung); Einstellungen und Konfigurationen der Verbindungen
 * verweisen nur darauf (`…_secret_id`, `connections.secret_id`).
 *
 * `findPlaintextSecrets` durchsucht Einstellungen und Verbindungskonfigurationen nach Feldern, die nach Zugangsdaten
 * aussehen und einen Wert haben. `migratePlaintextSecrets` verschiebt Funde in Verbindungskonfigurationen in die
 * verschlüsselten Geheimnisse der Verbindung (Altbestand, Import, Handeingriff) – läuft beim Start des Workers.
 */
const SECRET_KEY = /secret|token|passw(or)?d|api[-_]?key|private[-_]?key|credential|client[-_]?secret|^auth$|^p256dh$/i;
/** Verweise, Prüfsummen, Zeitpunkte und Schalter sind keine Zugangsdaten. */
const NOT_SECRET = /(_id|Id|_ids|_hash|Hash|ExpiresAt|_at|At|_set|Set|InPath|_verified|Url|_url)$/;

export const isSecretKey = (k: string) => SECRET_KEY.test(k) && !NOT_SECRET.test(k);

/** Adresse mit eingebettetem Passwort (https://benutzer:passwort@host). */
const urlWithPassword = (v: string) => /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(v.trim());

export interface PlaintextFinding {
  where: 'setting' | 'connection' | 'rss_feed';
  id: string;
  path: string;
}

function scan(value: unknown, path: string, out: string[], depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (isSecretKey(k) && ((typeof v === 'string' && v.trim() !== '') || (typeof v === 'object' && v !== null))) out.push(p);
    else if (typeof v === 'string' && urlWithPassword(v)) out.push(p);
    else scan(v, p, out, depth + 1);
  }
}

export async function findPlaintextSecrets(db: Queryable = pool): Promise<PlaintextFinding[]> {
  const out: PlaintextFinding[] = [];
  for (const r of await many<{ key: string; value: unknown }>('SELECT key, value FROM settings', [], db)) {
    const paths: string[] = [];
    const leaf = r.key.split('.').pop()!;
    if (typeof r.value === 'string' && ((isSecretKey(leaf) && r.value.trim() !== '') || urlWithPassword(r.value))) paths.push(r.key);
    else scan(r.value, r.key, paths);
    for (const p of paths) out.push({ where: 'setting', id: r.key, path: p });
  }
  for (const c of await many<{ id: string; config: unknown }>('SELECT id, config FROM connections', [], db)) {
    const paths: string[] = [];
    scan(c.config, '', paths);
    for (const p of paths) out.push({ where: 'connection', id: c.id, path: p });
  }
  for (const f of await many<{ id: string; url: string }>('SELECT id, url FROM rss_feeds', [], db)) {
    if (urlWithPassword(String(f.url ?? ''))) out.push({ where: 'rss_feed', id: f.id, path: 'url' });
  }
  return out;
}

/**
 * Funde auf oberster Ebene einer Verbindungskonfiguration in die verschlüsselten Geheimnisse der Verbindung verschieben
 * und aus der Konfiguration entfernen. Andere Funde (Einstellungen, verschachtelte Felder) werden nur gemeldet.
 */
export async function migratePlaintextSecrets(): Promise<{ moved: number; reported: PlaintextFinding[] }> {
  const findings = await findPlaintextSecrets();
  let moved = 0;
  const reported: PlaintextFinding[] = [];
  const { loadConnection, updateConnectionSecrets } = await import('../connections/common.js');
  for (const f of findings) {
    if (f.where !== 'connection' || f.path.includes('.') || !isSecretKey(f.path)) {
      reported.push(f);
      continue;
    }
    await tx(async (db) => {
      const c = await loadConnection(f.id, db, { includeDeleted: true });
      const value = (c.config ?? {})[f.path];
      if (typeof value !== 'string' || !value) return;
      await updateConnectionSecrets(c, { [f.path]: value }, null, db);
      await db.query('UPDATE connections SET config = config - $2::text, updated_at = now() WHERE id = $1', [f.id, f.path]);
      moved++;
    });
  }
  if (moved) log('warn', 'security', `${moved} Zugangsdaten aus Verbindungskonfigurationen in den verschlüsselten Speicher verschoben.`);
  for (const f of reported) log('error', 'security', `Mögliche Zugangsdaten im Klartext: ${f.where === 'setting' ? 'Einstellung' : f.where === 'rss_feed' ? 'Quelle' : 'Verbindung'} ${f.id} (Feld ${f.path}). Bitte prüfen.`);
  return { moved, reported };
}
