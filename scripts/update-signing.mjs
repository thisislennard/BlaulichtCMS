#!/usr/bin/env node
/**
 * Signatur der In-App-Update-Pakete (Ed25519). Hintergrund: docs/architektur.md („In-App-Updates“), Ablauf eines
 * Releases: docs/entwicklung.md („Release erstellen“).
 *
 *   node scripts/update-signing.mjs keygen <pfad-zum-privaten-schlüssel.pem> [--write-public]
 *       Schlüsselpaar erzeugen. Der private Schlüssel muss AUSSERHALB des Repositorys liegen und darf noch nicht
 *       existieren; mit --write-public wird der öffentliche Teil in server/update-signing-key.pub eingetragen.
 *   node scripts/update-signing.mjs sign <zip> [--key <pem>]
 *       <zip>.sig schreiben und sofort gegen server/update-signing-key.pub prüfen. Schlüssel aus --key (Datei) oder
 *       als PEM-Inhalt in BLAULICHTCMS_UPDATE_SIGNING_KEY.
 *   node scripts/update-signing.mjs verify <zip> [--sig <datei>] [--pub <datei>] [--sha256 <datei>]
 *
 * Der private Schlüssel gehört NIE ins Repository und NIE auf einen BlaulichtCMS-Server – nur in das GitHub-Secret
 * BLAULICHTCMS_UPDATE_SIGNING_KEY (Release-Workflow) und in eine sichere Ablage.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPublicKey, rawPublicKeyBase64, signatureFileText, signDigest, verifyDigestSignature } from '../server/src/updates/signing.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILE = path.join(ROOT, 'server', 'update-signing-key.pub');
const [cmd, target] = process.argv.slice(2);

const die = (msg) => {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
function insideRepo(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function loadPrivateKey() {
  const file = arg('--key');
  const pem = file ? fs.readFileSync(file, 'utf8') : process.env.BLAULICHTCMS_UPDATE_SIGNING_KEY || '';
  if (!pem.trim()) die('Privaten Schlüssel mit --key <datei> angeben oder BLAULICHTCMS_UPDATE_SIGNING_KEY (PEM-Inhalt) setzen.');
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (e) {
    die(`Signaturschlüssel nicht lesbar (${e.message}).`);
  }
  if (key.asymmetricKeyType !== 'ed25519') die('Der Schlüssel ist kein Ed25519-Schlüssel.');
  return key;
}

try {
  switch (cmd) {
    case 'keygen': {
      if (!target) die('Pfad für den privaten Schlüssel angeben.');
      const out = path.resolve(target);
      if (insideRepo(out)) die('Der private Schlüssel darf nicht im Repository liegen.');
      if (fs.existsSync(out)) die(`${out} existiert bereits – nichts überschrieben.`);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      const line = rawPublicKeyBase64(publicKey);
      if (process.argv.includes('--write-public')) {
        let existing = null;
        try {
          existing = loadPublicKey(PUBLIC_FILE);
        } catch {
          existing = null;
        }
        if (existing) die(`${PUBLIC_FILE} enthält bereits einen Schlüssel – bewusst von Hand ersetzen (Schlüsselwechsel: docs/architektur.md).`);
        fs.writeFileSync(
          PUBLIC_FILE,
          `# Öffentlicher Schlüssel für In-App-Updates (Ed25519, Base64 der 32 Rohbytes).\n# Updates werden nur installiert, wenn ihre Signatur zu diesem Schlüssel passt. Erzeugt mit scripts/update-signing.mjs keygen.\n${line}\n`,
        );
        console.log(`Öffentlicher Schlüssel eingetragen: ${PUBLIC_FILE}`);
      }
      console.log(`Privater Schlüssel: ${out} (sicher aufbewahren, nie ins Repository)`);
      console.log(`Öffentlicher Schlüssel: ${line}`);
      break;
    }
    case 'sign': {
      if (!target || !fs.existsSync(target)) die('ZIP-Datei angeben.');
      const key = loadPrivateKey();
      const digest = sha256(target);
      const sigFile = `${target}.sig`;
      fs.writeFileSync(sigFile, signatureFileText(path.basename(target), signDigest(digest, key)));
      try {
        verifyDigestSignature(digest, fs.readFileSync(sigFile), arg('--pub') ?? PUBLIC_FILE);
      } catch (e) {
        fs.rmSync(sigFile, { force: true });
        die(`Signatur passt nicht zum öffentlichen Schlüssel im Repository: ${e.message}`);
      }
      console.log(`Signatur geschrieben und geprüft: ${sigFile}`);
      break;
    }
    case 'verify': {
      if (!target || !fs.existsSync(target)) die('ZIP-Datei angeben.');
      const digest = sha256(target);
      const shaFile = arg('--sha256') ?? `${target}.sha256`;
      if (fs.existsSync(shaFile)) {
        const expected = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
        if (expected !== digest) die(`SHA-256 stimmt nicht mit ${path.basename(shaFile)} überein.`);
      }
      const sigFile = arg('--sig') ?? `${target}.sig`;
      if (!fs.existsSync(sigFile)) die(`Signaturdatei ${sigFile} fehlt.`);
      verifyDigestSignature(digest, fs.readFileSync(sigFile), arg('--pub') ?? PUBLIC_FILE);
      console.log(`Signatur gültig, SHA-256 ${digest}`);
      break;
    }
    default:
      console.log('Befehle: keygen <pem> [--write-public] | sign <zip> [--key <pem>] | verify <zip> [--sig <datei>] [--pub <datei>] [--sha256 <datei>]');
      process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  die(e.message);
}
