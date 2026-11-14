import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../config.js';

/**
 * Echtheitsprüfung der Update-Pakete (wie LiFeOS #949): Jedes ZIP braucht eine Ed25519-Signatur
 * (`<zip>.sig`). Signiert wird SIGNATURE_CONTEXT + SHA-256 (hex) des ZIPs. Der öffentliche Schlüssel
 * liegt in server/update-signing-key.pub (Base64 der 32 Rohbytes) und kommt mit jedem Release mit;
 * der private Schlüssel nur auf dem Build-Rechner (LIFELINK_UPDATE_SIGNING_KEY).
 * Ohne hinterlegten öffentlichen Schlüssel wird jedes Update abgelehnt.
 */
export const SIGNATURE_CONTEXT = 'LifeLink-Update-Signatur v1\n';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class UpdateSignatureError extends Error {}

export function publicKeyFile(root = APP_ROOT) {
  return path.join(root, 'server', 'update-signing-key.pub');
}

function meaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return '';
}

export function loadPublicKey(file = publicKeyFile()): crypto.KeyObject | null {
  if (!fs.existsSync(file)) return null;
  const line = meaningfulLine(fs.readFileSync(file, 'utf8'));
  if (!line) return null;
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 32) throw new UpdateSignatureError('Der hinterlegte öffentliche Signaturschlüssel ist ungültig.');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
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
  const text = Buffer.isBuffer(data) ? (data.length > 4096 ? '' : data.toString('utf8').replace(/^﻿/, '')) : data;
  const line = meaningfulLine(text);
  if (!line) throw new UpdateSignatureError('Signaturdatei ist leer oder zu groß.');
  const sig = Buffer.from(line, 'base64');
  if (sig.length !== 64) throw new UpdateSignatureError('Signaturdatei hat kein gültiges Format.');
  return sig;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Prüft die Signatur; gibt den SHA-256 des ZIPs zurück. */
export function verifyUpdateSignature(zipFile: string, signature: Buffer | string | null | undefined, keyFile = publicKeyFile()): string {
  let key: crypto.KeyObject | null;
  try {
    key = loadPublicKey(keyFile);
  } catch (e) {
    throw e;
  }
  if (!key) {
    throw new UpdateSignatureError(
      'Updates werden nur mit gültiger Signatur installiert, aber in dieser Installation ist kein öffentlicher Signaturschlüssel hinterlegt (server/update-signing-key.pub).',
    );
  }
  const sig = parseSignature(signature);
  const digest = sha256File(zipFile);
  const ok = crypto.verify(null, Buffer.from(SIGNATURE_CONTEXT + digest, 'utf8'), key, sig);
  if (!ok) throw new UpdateSignatureError('Signatur des Update-Pakets ist ungültig – das Paket stammt nicht aus einem offiziellen Release oder wurde verändert. Installation abgebrochen.');
  return digest;
}
