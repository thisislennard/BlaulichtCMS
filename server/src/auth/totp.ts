import crypto from 'node:crypto';
import { deriveKey, sha256Hex } from '../lib/crypto.js';

/**
 * TOTP nach RFC 6238 (SHA-1, 6 Stellen, 30 s) – kompatibel mit allen Authenticator-Apps.
 * Eigene, kleine Implementierung statt Abhängigkeit; geprüft gegen die RFC-Testvektoren.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** Prüft einen Code mit ±1 Zeitfenster. Gibt den benutzten Zähler zurück (gegen Wiederverwendung). */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const counter = Math.floor(now / 1000 / 30);
  for (const d of [0, -1, 1]) {
    const expected = totpAt(secret, counter + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return counter + d;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Wiederherstellungscodes (#130): 80 Bit Zufall, Base32 in vier Viererblöcken (XXXX-XXXX-XXXX-XXXX).
 * Gespeichert wird nur HMAC-SHA256 mit einem aus dem Master-Schlüssel abgeleiteten Schlüssel und der Konto-ID als
 * Salz – ein Datenbankabfluss allein erlaubt kein Durchprobieren. Achtung: Ein neuer Master-Schlüssel macht diese
 * Codes ungültig (HMAC lässt sich nicht umschlüsseln): `cli.js rotate-master-key` entfernt sie und benachrichtigt die
 * Betroffenen (ops/rotate-key.ts); danach neue Codes im Profil erzeugen.
 */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => base32Encode(crypto.randomBytes(10)).match(/.{4}/g)!.join('-'));
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

export function recoveryCodeHash(userId: string, code: string): string {
  return 'h1:' + crypto.createHmac('sha256', deriveKey('recovery-code')).update(`${userId}:${normalizeRecovery(code)}`).digest('hex');
}

/**
 * Mögliche gespeicherte Formen einer Eingabe: aktuelle (HMAC) und – damit bereits ausgegebene Codes bis zum
 * Verbrauch oder zur Erneuerung gültig bleiben – die frühere Form (ungesalzenes SHA-256 der Eingabe mit Bindestrich).
 */
export function recoveryCodeCandidates(userId: string, input: string): string[] {
  const legacy = input.toUpperCase().replace(/\s/g, '');
  return [recoveryCodeHash(userId, input), sha256Hex(legacy)];
}
