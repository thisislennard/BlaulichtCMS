#!/usr/bin/env node
/**
 * Echtheitsprüfung eines Release-Pakets für den Host-Helfer (scripts/host-update-helper.sh, #226):
 *
 *   node host-update-verify.mjs <paket.zip> <paket.zip.sig> <update-signing-key.pub> <version> <commit>
 *
 * Prüft wie ein In-App-Update die Ed25519-Signatur über „BlaulichtCMS-Update-Signatur v1\n“ + SHA-256 des Pakets gegen
 * den angehefteten Schlüssel des installierten Stands, liest dann aus dem Paket manifest.json und verlangt, dass es
 * genau die erwartete Version und den Commit des Release-Tags nennt. So ist der Tag, den install.sh baut, an ein
 * signiertes Release gebunden. Nur node:* (läuft im bisherigen Image ohne Netz und ohne Rechte). Exit 0 = gültig.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const CONTEXT = 'BlaulichtCMS-Update-Signatur v1\n';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const meaningful = (text) => text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';

/** Liest einen Eintrag (höchstens maxBytes entpackt) über das zentrale Verzeichnis des ZIPs. */
export function readZipEntry(zip, name, maxBytes = 256 * 1024) {
  const tail = zip.subarray(Math.max(0, zip.length - 65_557));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Kein gültiges ZIP (Endsatz fehlt).');
  const count = tail.readUInt16LE(eocd + 10);
  let p = tail.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Zentrales Verzeichnis des ZIPs beschädigt.');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (entry !== name) continue;
    if (usize > maxBytes) throw new Error(`${name} ist zu groß.`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Lokaler Eintrag des ZIPs beschädigt.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error('ZIP abgeschnitten.');
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }) : null;
    if (!data) throw new Error(`Unbekannte Kompression ${method}.`);
    if (data.length !== usize) throw new Error(`Größe von ${name} stimmt nicht.`);
    return data;
  }
  return null;
}

/** Prüft Paket, Signatur und Manifest; wirft mit deutscher Meldung, liefert sonst die SHA-256-Prüfsumme. */
export function verifyReleasePackage({ zip, sig, pub, version, commit }) {
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) throw new Error('Ungültige Version.');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Ungültiger Commit.');
  const keyLine = meaningful(pub);
  const raw = Buffer.from(keyLine, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== keyLine) throw new Error('Kein gültiger öffentlicher Signaturschlüssel hinterlegt.');
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  const sigLine = meaningful(sig);
  const signature = Buffer.from(sigLine, 'base64');
  if (signature.length !== 64) throw new Error('Signaturdatei hat kein gültiges Format.');
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  if (!crypto.verify(null, Buffer.from(CONTEXT + sha256, 'utf8'), key, signature)) throw new Error('Die Signatur des Release-Pakets ist ungültig.');
  const m = readZipEntry(zip, 'manifest.json', 64 * 1024);
  if (!m) throw new Error('manifest.json fehlt im Paket.');
  let manifest;
  try {
    manifest = JSON.parse(m.toString('utf8'));
  } catch {
    throw new Error('manifest.json ist kein gültiges JSON.');
  }
  if (manifest?.name !== 'blaulichtcms') throw new Error('Das Paket ist kein BlaulichtCMS-Release.');
  if (manifest.version !== version) throw new Error(`Das signierte Paket enthält Version ${String(manifest.version).slice(0, 20)}, erwartet ${version}.`);
  if (manifest.commit !== commit) throw new Error(`Der Commit im signierten Paket (${String(manifest.commit).slice(0, 12)}) passt nicht zum Release-Tag (${commit.slice(0, 12)}).`);
  return sha256;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [zipFile, sigFile, pubFile, version, commit] = process.argv.slice(2);
  try {
    if (!commit) throw new Error('Aufruf: host-update-verify.mjs <zip> <sig> <pub> <version> <commit>');
    if (fs.statSync(zipFile).size > 300 * 1024 * 1024) throw new Error('Paket ist zu groß.');
    const sha = verifyReleasePackage({ zip: fs.readFileSync(zipFile), sig: fs.readFileSync(sigFile, 'utf8').slice(0, 4096), pub: fs.readFileSync(pubFile, 'utf8').slice(0, 4096), version, commit });
    console.log(`ok ${version} ${commit} sha256 ${sha}`);
  } catch (e) {
    console.error(`Fehler: ${e.message}`);
    process.exit(1);
  }
}
