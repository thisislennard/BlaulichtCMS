import { one, pool, type Queryable } from '../db/pool.js';
import { decrypt, encrypt, fingerprint } from './crypto.js';

/**
 * Versionierte, verschlüsselte Geheimnisse. Ein Geheimnis gehört einem
 * Besitzer (Verbindung, Webhook, Einstellung). Rotation erzeugt eine neue Version; alte
 * Versionen bleiben bis zum Widerruf erhalten. Klartext verlässt den Server nie über die API.
 */
export type SecretOwner = 'connection' | 'webhook' | 'setting';

export interface StoredSecretMeta {
  id: string;
  version: number;
  fingerprint: string;
  created_at: Date;
}

const aad = (ownerType: string, ownerId: string, version: number) => `secret:${ownerType}:${ownerId}:${version}`;

export async function storeSecret(
  ownerType: SecretOwner,
  ownerId: string,
  value: Record<string, string> | string,
  createdBy: string | null,
  db: Queryable = pool,
): Promise<StoredSecretMeta> {
  const plain = typeof value === 'string' ? value : JSON.stringify(value);
  const next = await one<{ v: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM secrets WHERE owner_type = $1 AND owner_id = $2',
    [ownerType, ownerId],
    db,
  );
  const version = next!.v;
  const row = await one<StoredSecretMeta>(
    `INSERT INTO secrets (owner_type, owner_id, version, ciphertext, fingerprint, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, fingerprint, created_at`,
    [ownerType, ownerId, version, encrypt(plain, aad(ownerType, ownerId, version)), fingerprint(plain), createdBy],
    db,
  );
  return row!;
}

export async function readSecret(id: string | null | undefined, db: Queryable = pool): Promise<string | null> {
  if (!id) return null;
  const row = await one<{ owner_type: string; owner_id: string; version: number; ciphertext: string; revoked_at: Date | null }>(
    'SELECT owner_type, owner_id, version, ciphertext, revoked_at FROM secrets WHERE id = $1',
    [id],
    db,
  );
  if (!row || row.revoked_at) return null;
  return decrypt(row.ciphertext, aad(row.owner_type, row.owner_id, row.version));
}

export async function readSecretJson(id: string | null | undefined, db: Queryable = pool): Promise<Record<string, string>> {
  const raw = await readSecret(id, db);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function revokeSecret(id: string, db: Queryable = pool) {
  await db.query('UPDATE secrets SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

export async function secretMeta(id: string | null | undefined, db: Queryable = pool) {
  if (!id) return null;
  return one<{ id: string; version: number; fingerprint: string; created_at: Date; revoked_at: Date | null }>(
    'SELECT id, version, fingerprint, created_at, revoked_at FROM secrets WHERE id = $1',
    [id],
    db,
  );
}
