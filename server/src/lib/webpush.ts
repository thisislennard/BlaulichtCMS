import crypto from 'node:crypto';
import { httpRequest } from './http.js';

/**
 * Web Push ohne Zusatzbibliothek (#191), nur mit node:crypto:
 *  - Verschlüsselung der Inhalte nach RFC 8291 (Web Push Encryption) mit der Inhaltskodierung „aes128gcm“ (RFC 8188),
 *  - Absenderkennung VAPID nach RFC 8292 (JWT mit ES256, P-256).
 * Unit-Tests prüfen die Verschlüsselung gegen die Testwerte aus RFC 8291, Anhang A.
 */

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** öffentlicher Schlüssel, unkomprimierter P-256-Punkt (65 Byte), Base64url – geht an den Browser */
  publicKey: string;
  /** privater Skalar d (32 Byte), Base64url – nur verschlüsselt in `secrets` */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Privaten VAPID-Schlüssel (d) samt öffentlichem Punkt als KeyObject für ES256. */
function vapidKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = fromB64u(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('Öffentlicher VAPID-Schlüssel hat ein ungültiges Format.');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/**
 * VAPID-Kopfzeile (RFC 8292): `vapid t=<JWT>, k=<öffentlicher Schlüssel>`. aud = Herkunft des Push-Dienstes,
 * exp höchstens 24 h (hier 12 h), sub = Kontakt (mailto: oder https:).
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

/**
 * Inhalt für ein Abo verschlüsseln (RFC 8291 §3.4 + RFC 8188, ein Datensatz, Satzgröße 4096).
 * `asPrivate` und `salt` nur für die Testwerte setzen – sonst werden beide für jede Nachricht neu erzeugt.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: { p256dh: string; auth: string },
  opts: { asPrivate?: Buffer; salt?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Ungültiger Geräteschlüssel (p256dh).');
  if (authSecret.length !== 16) throw new Error('Ungültiges Gerätegeheimnis (auth).');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const record = Buffer.concat([plaintext, Buffer.from([2])]); // letzter Datensatz: Trenner 0x02, keine Auffüllung
  if (record.length + 16 > 4096) throw new Error('Push-Inhalt ist zu groß.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Push-Abos dürfen nur auf bekannte Push-Dienste zeigen (wie LiFeOS #928) – sonst könnte ein manipuliertes Abo den
 * Server Anfragen an beliebige, auch interne Adressen schicken lassen (SSRF). https, Standardport, kein Benutzer.
 */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

function testHost(): string | null {
  const u = process.env.VITEST ? process.env.BLAULICHTCMS_PUSH_TEST_URL : undefined;
  return u ? new URL(u).host : null;
}

export function checkPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const t = testHost();
  if (t && u.host === t) return true;
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export type PushResult = { status: 'sent' } | { status: 'expired'; error: string } | { status: 'failed'; error: string };

/** Ohne TTL verwirft der Push-Dienst eine Meldung, wenn das Gerät gerade offline ist – 24 h wie LiFeOS. */
export const PUSH_TTL = 24 * 3600;

/** Eine Nachricht an ein Abo zustellen. 404/410 = Abo erloschen (löschen), alles andere = Fehler. */
export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: Record<string, unknown>,
  keys: VapidKeys,
  subject: string,
  urgency: 'very-low' | 'low' | 'normal' | 'high' = 'normal',
): Promise<PushResult> {
  if (!checkPushEndpoint(sub.endpoint)) return { status: 'failed', error: 'Push-Adresse gehört zu keinem bekannten Push-Dienst.' };
  try {
    const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub);
    const t = testHost();
    const res = await httpRequest({
      method: 'POST',
      url: sub.endpoint,
      headers: {
        authorization: vapidAuthorization(sub.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(PUSH_TTL),
        urgency,
      },
      body,
      timeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
      followRedirects: false,
      allowPrivateHosts: t ? [new URL(process.env.BLAULICHTCMS_PUSH_TEST_URL!).hostname] : [],
    });
    if (res.status >= 200 && res.status < 300) return { status: 'sent' };
    const text = res.text().slice(0, 200);
    if (res.status === 404 || res.status === 410) return { status: 'expired', error: `Abo beim Push-Dienst erloschen (${res.status}).` };
    return { status: 'failed', error: `Push-Dienst antwortet ${res.status}${text ? `: ${text}` : ''}` };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message.slice(0, 300) };
  }
}
