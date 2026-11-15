#!/usr/bin/env node
/**
 * Code-Signatur der BlaulichtCMS Bridge (#107). Ablauf und Hintergrund: docs/bridge-signatur.md.
 *
 *   node scripts/bridge-signing.mjs keygen <pfad-zum-privaten-schlüssel>   Schlüsselpaar erzeugen, öffentlichen Teil im Plugin hinterlegen
 *   node scripts/bridge-signing.mjs sign   <pfad-zum-privaten-schlüssel>   wordpress-plugin/blaulichtcms-bridge/signature.json schreiben
 *   node scripts/bridge-signing.mjs verify                                Signatur prüfen (Exit-Code 1 bei Fehler; ohne hinterlegte Schlüssel: Hinweis, Exit 0)
 *
 * Statt eines Pfads kann der private Schlüssel (PEM) in der Umgebungsvariable BRIDGE_SIGNING_KEY stehen (z. B. als
 * GitHub-Actions-Secret). Der private Schlüssel gehört NIE ins Repository und NIE auf den BlaulichtCMS-Server.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS_FILE, SIGNATURE_FILE, pinnedKeys, rawPublicKey, signBridge, verifyBridgeSignature } from '../server/src/lib/bridge-signature.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// BRIDGE_PLUGIN_DIR nur für Tests mit einer Kopie des Plugins
const PLUGIN = process.env.BRIDGE_PLUGIN_DIR ? path.resolve(process.env.BRIDGE_PLUGIN_DIR) : path.join(ROOT, 'wordpress-plugin', 'blaulichtcms-bridge');
const [cmd, keyArg] = process.argv.slice(2);

const die = (msg) => {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
};

function insideRepo(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function loadPrivateKey() {
  const pem = process.env.BRIDGE_SIGNING_KEY || (keyArg ? fs.readFileSync(keyArg, 'utf8') : '');
  if (!pem) die('Privaten Schlüssel als Pfad angeben oder BRIDGE_SIGNING_KEY setzen.');
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') die('Der Schlüssel ist kein Ed25519-Schlüssel.');
  return key;
}

function writeKeys(keys) {
  const lines = keys.map((k) => `\t'${k}',`).join('\n');
  fs.writeFileSync(
    path.join(PLUGIN, KEYS_FILE),
    `<?php
/**
 * Öffentliche Schlüssel für die Signaturprüfung von Bridge-Updates (#107). Erzeugt mit
 * \`node scripts/bridge-signing.mjs keygen\`. Eine Bridge mit mindestens einem Schlüssel installiert nur Updates, die mit
 * einem dieser Schlüssel signiert sind. Die zugehörigen privaten Schlüssel liegen nicht auf dem BlaulichtCMS-Server.
 * Leere Liste = Rückfallbetrieb (nur Prüfsumme aus BlaulichtCMS), siehe docs/bridge-signatur.md.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
${lines ? `${lines}\n` : ''});
`,
  );
}

if (cmd === 'keygen') {
  if (!keyArg) die('Pfad für den privaten Schlüssel angeben (außerhalb des Repositorys, z. B. auf einem USB-Stick).');
  if (insideRepo(keyArg)) die('Der private Schlüssel darf nicht im Repository liegen.');
  if (fs.existsSync(keyArg)) die(`${keyArg} existiert bereits – nichts überschrieben.`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyArg, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const pub = rawPublicKey(privateKey);
  const keys = [...new Set([...pinnedKeys(PLUGIN), pub])];
  writeKeys(keys);
  console.log(`Privater Schlüssel: ${path.resolve(keyArg)} (sicher und offline aufbewahren, Sicherungskopie anlegen)`);
  console.log(`Öffentlicher Schlüssel: ${pub}`);
  console.log(`Hinterlegt in ${path.relative(ROOT, path.join(PLUGIN, KEYS_FILE))} (${keys.length} Schlüssel).`);
  console.log('Weiter: Version der Bridge erhöhen, dann „sign“ ausführen und alles committen.');
} else if (cmd === 'sign') {
  const key = loadPrivateKey();
  const pub = rawPublicKey(key);
  if (!pinnedKeys(PLUGIN).includes(pub)) {
    console.warn('Hinweis: Der Schlüssel ist (noch) nicht im Plugin hinterlegt. Websites prüfen mit den Schlüsseln ihrer installierten Version – das ist bei einem Schlüsselwechsel richtig.');
  }
  const sig = signBridge(PLUGIN, key);
  fs.writeFileSync(path.join(PLUGIN, SIGNATURE_FILE), `${JSON.stringify(sig, null, 2)}\n`);
  const check = verifyBridgeSignature(PLUGIN, [pub]);
  if (check.state !== 'valid') die(`Prüfung nach dem Signieren fehlgeschlagen: ${check.reason}`);
  console.log(`Signiert: Bridge ${sig.version}, ${Object.keys(sig.files).length} Dateien, Schlüssel ${pub.slice(0, 12)}…`);
} else if (cmd === 'verify') {
  const r = verifyBridgeSignature(PLUGIN);
  if (r.state === 'not_configured') {
    console.log('Keine Signaturschlüssel im Plugin hinterlegt – Rückfallbetrieb (nur Prüfsumme). Siehe docs/bridge-signatur.md.');
  } else if (r.state === 'valid') {
    console.log(`Signatur gültig (Schlüssel ${r.key.slice(0, 12)}…).`);
  } else {
    die(`Signatur der Bridge: ${r.reason} Bitte mit \`node scripts/bridge-signing.mjs sign <schlüssel>\` neu signieren.`);
  }
} else {
  console.log('Aufruf: node scripts/bridge-signing.mjs keygen|sign|verify [pfad-zum-privaten-schlüssel]');
  process.exit(cmd ? 1 : 0);
}
