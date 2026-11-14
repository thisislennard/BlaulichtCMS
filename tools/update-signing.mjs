#!/usr/bin/env node
/**
 * Signatur der Update-ZIPs (wie LiFeOS) – Werkzeug für den Betreiber. Keine Abhängigkeiten.
 *
 *   node tools/update-signing.mjs keygen --out D:/geheim/lifelink-update-signing.pem [--write-public]
 *       erzeugt ein Ed25519-Schlüsselpaar. Der private Schlüssel gehört NICHT ins Repo und nicht auf
 *       die Server – nur auf den Build-Rechner (plus sichere Kopie). Mit --write-public wird der
 *       öffentliche Schlüssel in server/update-signing-key.pub eingetragen.
 *   node tools/update-signing.mjs sign <zip> [--key <pem>]
 *       schreibt <zip>.sig. Schlüsselpfad sonst aus LIFELINK_UPDATE_SIGNING_KEY. Prüft danach gegen
 *       server/update-signing-key.pub – passt der private Schlüssel nicht, bricht es ab.
 *   node tools/update-signing.mjs verify <zip> [--sig <datei>] [--pub <datei>]
 *
 * Passwortgeschützte Schlüssel: Passwort in LIFELINK_UPDATE_SIGNING_PASSPHRASE.
 * Signiert wird "LifeLink-Update-Signatur v1\n" + SHA-256 (hex) des ZIPs (siehe server/src/updates/signing.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILE = path.join(ROOT, 'server', 'update-signing-key.pub');
const CONTEXT = 'LifeLink-Update-Signatur v1\n';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const passphrase = process.env.LIFELINK_UPDATE_SIGNING_PASSPHRASE || undefined;

function fail(msg) {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function meaningful(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
}

function loadPublic(file) {
  if (!fs.existsSync(file)) return null;
  const line = meaningful(fs.readFileSync(file, 'utf8'));
  if (!line) return null;
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 32) fail(`${file} enthält keinen gültigen Schlüssel.`);
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify(zip, sigFile, pubFile) {
  const key = loadPublic(pubFile);
  if (!key) fail(`Kein öffentlicher Schlüssel in ${pubFile}.`);
  if (!fs.existsSync(sigFile)) fail(`Signaturdatei ${sigFile} fehlt.`);
  const sig = Buffer.from(meaningful(fs.readFileSync(sigFile, 'utf8')), 'base64');
  if (sig.length !== 64) fail('Signaturdatei hat kein gültiges Format.');
  const digest = sha256(zip);
  if (!crypto.verify(null, Buffer.from(CONTEXT + digest), key, sig)) fail('Signatur ungültig (passt nicht zum öffentlichen Schlüssel oder ZIP verändert).');
  return digest;
}

const [cmd, target] = process.argv.slice(2);
switch (cmd) {
  case 'keygen': {
    const out = arg('--out');
    if (!out) fail('--out <pfad> angeben.');
    const abs = path.resolve(out);
    if (fs.existsSync(abs)) fail(`${abs} existiert bereits – nicht überschrieben.`);
    if (abs.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) fail('Den privaten Schlüssel nicht im Repo-Ordner ablegen.');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) });
    fs.writeFileSync(abs, pem, { mode: 0o600, flag: 'wx' });
    const line = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
    if (process.argv.includes('--write-public')) {
      if (loadPublic(PUBLIC_FILE)) fail(`${PUBLIC_FILE} enthält bereits einen Schlüssel – bewusst von Hand ersetzen.`);
      fs.appendFileSync(PUBLIC_FILE, line + '\n');
      console.log(`Öffentlicher Schlüssel eingetragen in ${PUBLIC_FILE}`);
    }
    console.log(`Privater Schlüssel: ${abs} (sicher aufbewahren, nie ins Repo)`);
    console.log(`Öffentlicher Schlüssel: ${line}`);
    break;
  }
  case 'sign': {
    if (!target) fail('ZIP-Datei angeben.');
    const keyPath = arg('--key', process.env.LIFELINK_UPDATE_SIGNING_KEY);
    if (!keyPath || !fs.existsSync(keyPath)) fail('Kein Signaturschlüssel: --key angeben oder LIFELINK_UPDATE_SIGNING_KEY setzen.');
    let key;
    try {
      key = crypto.createPrivateKey({ key: fs.readFileSync(keyPath), passphrase });
    } catch (e) {
      fail(`Signaturschlüssel nicht lesbar (${e.message}) – Passwort in LIFELINK_UPDATE_SIGNING_PASSPHRASE?`);
    }
    if (key.asymmetricKeyType !== 'ed25519') fail('Signaturschlüssel ist kein Ed25519-Schlüssel.');
    const digest = sha256(target);
    const sig = crypto.sign(null, Buffer.from(CONTEXT + digest), key);
    const sigFile = `${target}.sig`;
    fs.writeFileSync(sigFile, `# LifeLink-Update-Signatur (Ed25519) für ${path.basename(target)}\n${sig.toString('base64')}\n`);
    try {
      verify(target, sigFile, arg('--pub', PUBLIC_FILE));
    } catch (e) {
      fs.rmSync(sigFile, { force: true });
      throw e;
    }
    console.log(`Signatur: ${sigFile}`);
    break;
  }
  case 'verify': {
    if (!target) fail('ZIP-Datei angeben.');
    const digest = verify(target, arg('--sig', `${target}.sig`), arg('--pub', PUBLIC_FILE));
    console.log(`Signatur gültig, SHA-256 ${digest}`);
    break;
  }
  default:
    console.log('Befehle: keygen --out <pem> [--write-public] | sign <zip> [--key <pem>] | verify <zip> [--sig <datei>] [--pub <datei>]');
}
