import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Echtheitsprüfung der Update-Pakete (Ed25519). Signiert wird SIGNATURE_CONTEXT + SHA-256 (hex) des ZIPs; die
 * Signaturdatei `<zip>.sig` enthält Kommentarzeilen (#) und die Signatur in Base64.
 *
 * Geprüft wird immer gegen den öffentlichen Schlüssel der LAUFENDEN Version (server/update-signing-key.pub, Base64
 * der 32 Rohbytes) – ein Paket kann sich nicht selbst beglaubigen. Der private Schlüssel liegt nur als GitHub-Secret
 * vor (Release-Workflow), nie im Repository und nie auf einem Server. Ohne hinterlegten Schlüssel: keine Updates.
 *
 * Bewusst nur mit node:* – scripts/update-signing.mjs lädt diese Datei direkt.
 */
export const SIGNATURE_CONTEXT = 'BlaulichtCMS-Update-Signatur v1\n';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export class UpdateSignatureError extends Error {}

/**
 * Datei mit dem angehefteten öffentlichen Schlüssel. Nur in Tests (NODE_ENV=test) per BLAULICHTCMS_TEST_UPDATE_PUBKEY
 * überschreibbar – im Betrieb gilt ausschließlich die Datei des laufenden Programms.
 */
export function publicKeyFile(root = CODE_ROOT): string {
  if (process.env.NODE_ENV === 'test' && process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY) return process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY;
  return path.join(root, 'server', 'update-signing-key.pub');
}

function meaningfulLine(text: string): string {
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return '';
}

export function rawPublicKeyBase64(key: crypto.KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length).toString('base64');
}

export function publicKeyFromBase64(line: string): crypto.KeyObject {
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== line) throw new UpdateSignatureError('Der hinterlegte öffentliche Signaturschlüssel ist ungültig.');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function loadPublicKey(file = publicKeyFile()): crypto.KeyObject | null {
  if (!fs.existsSync(file)) return null;
  const line = meaningfulLine(fs.readFileSync(file, 'utf8'));
  return line ? publicKeyFromBase64(line) : null;
}

export function publicKeyStatus(file = publicKeyFile()): 'ok' | 'missing' | 'invalid' {
  try {
    return loadPublicKey(file) ? 'ok' : 'missing';
  } catch {
    return 'invalid';
  }
}

export function parseSignature(data: Buffer | string | null | undefined): Buffer {
  if (data == null) throw new UpdateSignatureError('Signaturdatei (.sig) fehlt. Unsignierte Updates werden abgelehnt.');
  if (data.length > 4096) throw new UpdateSignatureError('Signaturdatei ist zu groß.');
  const line = meaningfulLine(Buffer.isBuffer(data) ? data.toString('utf8') : data);
  const sig = Buffer.from(line, 'base64');
  if (!line || sig.length !== 64) throw new UpdateSignatureError('Signaturdatei hat kein gültiges Format.');
  return sig;
}

export function signatureMessage(sha256Hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new UpdateSignatureError('Ungültige Prüfsumme.');
  return Buffer.from(SIGNATURE_CONTEXT + sha256Hex, 'utf8');
}

export function signDigest(sha256Hex: string, privateKey: crypto.KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new UpdateSignatureError('Der Signaturschlüssel ist kein Ed25519-Schlüssel.');
  return crypto.sign(null, signatureMessage(sha256Hex), privateKey).toString('base64');
}

export function signatureFileText(zipName: string, signatureBase64: string): string {
  return `# BlaulichtCMS-Update-Signatur (Ed25519) für ${zipName}\n${signatureBase64}\n`;
}

/** Prüft die Signatur über den SHA-256 des Pakets gegen den angehefteten Schlüssel. Wirft bei jedem Fehler. */
export function verifyDigestSignature(sha256Hex: string, signature: Buffer | string | null | undefined, keyFile = publicKeyFile()): void {
  const key = loadPublicKey(keyFile);
  if (!key) {
    throw new UpdateSignatureError(
      'In dieser Installation ist kein öffentlicher Signaturschlüssel hinterlegt (server/update-signing-key.pub). Updates werden nur mit gültiger Signatur installiert.',
    );
  }
  const sig = parseSignature(signature);
  if (!crypto.verify(null, signatureMessage(sha256Hex), key, sig)) {
    throw new UpdateSignatureError('Die Signatur des Update-Pakets ist ungültig – das Paket stammt nicht aus einem offiziellen Release oder wurde verändert. Installation abgebrochen.');
  }
}
