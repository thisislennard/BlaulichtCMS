/**
 * Code-Signatur der BlaulichtCMS Bridge (#107).
 *
 * Die Bridge-Pakete werden mit einem Ed25519-Schlüssel signiert, dessen privater Teil NICHT auf dem BlaulichtCMS-Server
 * liegt (offline beim Betreiber, siehe docs/bridge-signatur.md). Der öffentliche Schlüssel ist in der installierten
 * Bridge fest hinterlegt (includes/signing-keys.php). Die Bridge installiert ein Update nur, wenn signature.json mit
 * einem dieser Schlüssel gültig signiert ist und jede Datei des Pakets zur signierten Liste passt.
 *
 * Signiert wird nicht das ZIP (das BlaulichtCMS beim Start selbst baut), sondern eine Dateiliste mit SHA-256 je Datei.
 * Die Nachricht ist zeilenbasiert und in PHP identisch nachgebaut (class-signature.php):
 *
 *   BLAULICHTCMS-BRIDGE-SIGNATURE-V1\n
 *   version: 0.6.0\n
 *   <sha256> <relativer/pfad>\n   (sortiert nach Pfad, Bytevergleich)
 *
 * Bewusst ohne Abhängigkeiten außer node:* – das Signierskript (scripts/bridge-signing.mjs) lädt diese Datei direkt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SIGNATURE_FILE = 'signature.json';
export const KEYS_FILE = 'includes/signing-keys.php';
export const SIGNATURE_HEADER = 'BLAULICHTCMS-BRIDGE-SIGNATURE-V1';
/** Nicht ins Paket (gleiche Regel wie beim ZIP-Bau). */
export const EXCLUDE_RE = /(^|\/)(tests|node_modules|\.git)(\/|$)/;

export interface BridgeSignatureFile {
  format: 1;
  version: string;
  key: string;
  files: Record<string, string>;
  signature: string;
}

export type SignatureState =
  /** keine Schlüssel hinterlegt, keine Signatur: Rückfallbetrieb (nur Prüfsumme) */
  | 'not_configured'
  /** Schlüssel hinterlegt, aber keine signature.json */
  | 'unsigned'
  /** Signatur oder Dateiliste passen nicht */
  | 'invalid'
  | 'valid';

/** Alle Dateien des Plugin-Ordners (ohne signature.json) mit SHA-256, Pfade mit „/“. */
export function bridgeManifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (EXCLUDE_RE.test(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && r !== SIGNATURE_FILE) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

/** Signierte Nachricht (identisch in PHP). */
export function canonicalMessage(version: string, files: Record<string, string>): Buffer {
  const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.from(`${SIGNATURE_HEADER}\nversion: ${version}\n${names.map((n) => `${files[n]} ${n}\n`).join('')}`, 'utf8');
}

/** Version aus dem Plugin-Kopf. */
export function headerVersion(dir: string): string {
  return /^\s*\*\s*Version:\s*([0-9.]+)/m.exec(fs.readFileSync(path.join(dir, 'blaulichtcms-bridge.php'), 'utf8'))?.[1] ?? '';
}

/** Im Plugin hinterlegte öffentliche Schlüssel (Base64, 32 Byte roh). */
export function pinnedKeys(dir: string): string[] {
  const f = path.join(dir, KEYS_FILE);
  if (!fs.existsSync(f)) return [];
  // Jede Zeichenkette in einfachen Anführungszeichen mit genau 44 Base64-Zeichen ist ein Schlüssel (Kommentare in der
  // Datei enthalten keine solchen Zeichenketten).
  return [...fs.readFileSync(f, 'utf8').matchAll(/'([A-Za-z0-9+/]{43}=)'/g)].map((m) => m[1]);
}

/** Roher 32-Byte-Schlüssel (Base64) → KeyObject. */
export function publicKeyFromRaw(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('Öffentlicher Schlüssel muss 32 Byte lang sein.');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Öffentlichen Schlüssel als Base64 (32 Byte roh, wie sodium_crypto_sign_verify_detached ihn erwartet). */
export function rawPublicKey(key: crypto.KeyObject): string {
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** Signatur erzeugen (nur im Signierskript, nie auf dem Server). */
export function signBridge(dir: string, privateKey: crypto.KeyObject): BridgeSignatureFile {
  const version = headerVersion(dir);
  if (!version) throw new Error('Version im Plugin-Kopf nicht gefunden.');
  const files = bridgeManifest(dir);
  const signature = crypto.sign(null, canonicalMessage(version, files), privateKey).toString('base64');
  return { format: 1, version, key: rawPublicKey(privateKey), files, signature };
}

/**
 * Signatur des Plugin-Ordners prüfen – mit den im selben Ordner hinterlegten Schlüsseln oder mit vorgegebenen
 * (so prüft die installierte Bridge ein Update).
 */
export function verifyBridgeSignature(dir: string, keys: string[] = pinnedKeys(dir)): { state: SignatureState; reason?: string; key?: string } {
  const sigPath = path.join(dir, SIGNATURE_FILE);
  if (!fs.existsSync(sigPath)) return keys.length ? { state: 'unsigned', reason: 'signature.json fehlt.' } : { state: 'not_configured' };
  let sig: BridgeSignatureFile;
  try {
    sig = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  } catch {
    return { state: 'invalid', reason: 'signature.json ist kein gültiges JSON.' };
  }
  if (sig?.format !== 1 || typeof sig.version !== 'string' || typeof sig.key !== 'string' || typeof sig.signature !== 'string' || !sig.files || typeof sig.files !== 'object') {
    return { state: 'invalid', reason: 'signature.json hat ein unbekanntes Format.' };
  }
  if (!keys.includes(sig.key)) return { state: 'invalid', reason: 'Mit einem Schlüssel signiert, der nicht im Plugin hinterlegt ist.', key: sig.key };
  if (sig.version !== headerVersion(dir)) return { state: 'invalid', reason: `Signiert für Version ${sig.version}, das Plugin hat ${headerVersion(dir)}.`, key: sig.key };
  let ok = false;
  try {
    ok = crypto.verify(null, canonicalMessage(sig.version, sig.files), publicKeyFromRaw(sig.key), Buffer.from(sig.signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) return { state: 'invalid', reason: 'Signatur ungültig.', key: sig.key };
  const actual = bridgeManifest(dir);
  const names = new Set([...Object.keys(actual), ...Object.keys(sig.files)]);
  for (const n of names) {
    if (actual[n] !== sig.files[n]) return { state: 'invalid', reason: `Datei ${n} passt nicht zur Signatur (nach dem Signieren geändert?).`, key: sig.key };
  }
  return { state: 'valid', key: sig.key };
}
