import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

/**
 * AEAD (AES-256-GCM) für gespeicherte Geheimnisse. Der Schlüssel kommt aus BLAULICHTCMS_MASTER_KEY
 * (Umgebung/Secret Store), nie aus der Datenbank. Format: v1.<iv>.<tag>.<ciphertext> (Base64url).
 * Die Zweckbindung (aad) verhindert, dass ein Chiffrat in einen anderen Datensatz kopiert wird.
 */
let cachedKey: Buffer | null = null;

export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = parseMasterKey(config.masterKey);
  return cachedKey;
}

/** Master-Schlüssel aus Base64 (32 Byte) – auch für einen alten Schlüssel aus einer Sicherungsdatei. */
export function parseMasterKey(raw: string): Buffer {
  if (!raw.trim()) throw new Error('BLAULICHTCMS_MASTER_KEY ist nicht gesetzt.');
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new Error('BLAULICHTCMS_MASTER_KEY muss 32 Byte (Base64) lang sein.');
  return key;
}

export function deriveKey(purpose: string, key: Buffer = masterKey()): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `blaulichtcms:${purpose}`, 32));
}

/**
 * Zweckbindungen (AAD) der mit dem Master-Schlüssel verschlüsselten Felder – an einer Stelle, damit der
 * Schlüsselwechsel (ops/rotate-key.ts) genau dieselben Werte verwendet.
 */
export const aad = {
  secret: (ownerType: string, ownerId: string, version: number) => `secret:${ownerType}:${ownerId}:${version}`,
  totp: (userId: string) => `totp:${userId}`,
  uploadLink: (linkId: string) => `upload-link:${linkId}`,
};

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
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // GCM-Prüfung fehlgeschlagen: falscher Schlüssel (z. B. Datenstand von vor einem Schlüsselwechsel) oder verändert
    throw new Error('Entschlüsselung fehlgeschlagen: falscher Master-Schlüssel oder veränderte Daten.');
  }
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 einer Datei, gestreamt (#248: Sicherungen können mehrere GB groß sein – nie ganz in den Speicher laden). */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
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
export function fingerprint(value: string, key: Buffer = masterKey()): string {
  return crypto.createHmac('sha256', deriveKey('fingerprint', key)).update(value).digest('hex').slice(0, 8);
}
