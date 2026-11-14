import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * AEAD (AES-256-GCM) für gespeicherte Geheimnisse. Der Schlüssel kommt aus LIFELINK_MASTER_KEY
 * (Umgebung/Secret Store), nie aus der Datenbank. Format: v1.<iv>.<tag>.<ciphertext> (Base64url).
 * Die Zweckbindung (aad) verhindert, dass ein Chiffrat in einen anderen Datensatz kopiert wird.
 */
let cachedKey: Buffer | null = null;

export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = config.masterKey.trim();
  if (!raw) throw new Error('LIFELINK_MASTER_KEY ist nicht gesetzt.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('LIFELINK_MASTER_KEY muss 32 Byte (Base64) lang sein.');
  cachedKey = key;
  return key;
}

export function deriveKey(purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), Buffer.alloc(0), `lifelink:${purpose}`, 32));
}

export function encrypt(plain: string | Buffer, aad: string, key: Buffer = masterKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(blob: string, aad: string, key: Buffer = masterKey()): string {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unbekanntes Chiffrat-Format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hmacHex(secret: string | Buffer, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Kurzer, nicht umkehrbarer Fingerabdruck zum Wiedererkennen eines Geheimnisses in der UI. */
export function fingerprint(value: string): string {
  return crypto.createHmac('sha256', deriveKey('fingerprint')).update(value).digest('hex').slice(0, 8);
}
