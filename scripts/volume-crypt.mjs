#!/usr/bin/env node
// Verschlüsselung der Volume-Sicherungen (scripts/backup-volume.sh, restore-volume.sh, verify-backup.sh).
// Läuft mit jedem Node.js ab Version 18 ohne weitere Pakete – im BlaulichtCMS-Image (auch in älteren Images) und auf
// jedem anderen Rechner, damit sich eine Sicherung im Notfall auch ohne BlaulichtCMS entschlüsseln lässt.
//
//   node volume-crypt.mjs genkey                    neuen Sicherungsschlüssel ausgeben (32 Byte, Base64)
//   node volume-crypt.mjs encrypt <schlüsseldatei>  stdin → stdout verschlüsseln
//   node volume-crypt.mjs decrypt <schlüsseldatei>  stdin → stdout entschlüsseln (bricht bei Manipulation ab)
//   node volume-crypt.mjs verify  <schlüsseldatei>  stdin vollständig prüfen, nichts ausgeben (Exit 0 = in Ordnung)
//
// Format „BCVOL1“ (alle Zahlen Big Endian):
//   Kopf (48 Byte): "BCVOL1\0\0" | Salz (32 Byte, zufällig) | Schlüsselkennung (8 Byte)
//   Blöcke: Länge (4 Byte; oberstes Bit = letzter Block) | Chiffrat (Länge Byte) | GCM-Tag (16 Byte)
//   Dateischlüssel = HKDF-SHA256(Sicherungsschlüssel, Salz, "blaulichtcms-volume-backup/v1"), AES-256-GCM je Block,
//   Nonce = Blocknummer (8 Byte) | 0 0 0 | Schlussmarke (1 Byte), Zusatzdaten = Kopf | Länge.
//   Abgeschnittene, umsortierte oder veränderte Dateien fallen beim Entschlüsseln auf.
//   Schlüsselkennung = erste 8 Byte von HMAC-SHA256(Sicherungsschlüssel, "blaulichtcms-volume-backup/key-id").
import crypto from 'node:crypto';
import fs from 'node:fs';

const MAGIC = Buffer.from('BCVOL1\0\0', 'latin1');
const HEAD_LEN = 48;
const CHUNK = 1024 * 1024;
const FINAL = 0x80000000;

function fail(msg) {
  process.stderr.write(`volume-crypt: ${msg}\n`);
  process.exit(1);
}

function loadKey(file) {
  if (!file) fail('Schlüsseldatei fehlt.');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    fail(`Schlüsseldatei nicht lesbar: ${file} (${e.code ?? e.message})`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) fail('Die Schlüsseldatei muss 32 Byte als Base64 enthalten (node volume-crypt.mjs genkey).');
  return key;
}

const keyId = (key) => crypto.createHmac('sha256', key).update('blaulichtcms-volume-backup/key-id').digest().subarray(0, 8);
const fileKey = (key, salt) => Buffer.from(crypto.hkdfSync('sha256', key, salt, 'blaulichtcms-volume-backup/v1', 32));
function nonce(index, final) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 0);
  n[11] = final ? 1 : 0;
  return n;
}

/** Puffer aus Einzelstücken: vermeidet ständiges Umkopieren bei großen Sicherungen. */
class Queue {
  parts = [];
  length = 0;
  push(b) {
    if (b.length) {
      this.parts.push(b);
      this.length += b.length;
    }
  }
  /** die ersten n Byte (n <= length), ohne sie zu entnehmen */
  peek(n) {
    if (this.parts[0].length < n) {
      const all = Buffer.concat(this.parts);
      this.parts = [all];
    }
    return this.parts[0].subarray(0, n);
  }
  take(n) {
    const b = Buffer.from(this.peek(n));
    const first = this.parts[0];
    if (first.length === n) this.parts.shift();
    else this.parts[0] = first.subarray(n);
    this.length -= n;
    return b;
  }
}

async function write(out, buf) {
  if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
}

async function encrypt(key) {
  const salt = crypto.randomBytes(32);
  const head = Buffer.concat([MAGIC, salt, keyId(key)]);
  const k = fileKey(key, salt);
  const out = process.stdout;
  await write(out, head);
  let index = 0;
  const seal = async (plain, final) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE((plain.length | (final ? FINAL : 0)) >>> 0);
    const c = crypto.createCipheriv('aes-256-gcm', k, nonce(index++, final));
    c.setAAD(Buffer.concat([head, len]));
    const body = Buffer.concat([c.update(plain), c.final()]);
    await write(out, Buffer.concat([len, body, c.getAuthTag()]));
  };
  const q = new Queue();
  for await (const chunk of process.stdin) {
    q.push(chunk);
    while (q.length > CHUNK) await seal(q.take(CHUNK), false);
  }
  await seal(q.length ? q.take(q.length) : Buffer.alloc(0), true);
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
}

async function decrypt(key, emit) {
  const out = process.stdout;
  const q = new Queue();
  let head = null;
  let k = null;
  let index = 0;
  let done = false;
  const step = async () => {
    if (!head) {
      if (q.length < HEAD_LEN) return false;
      head = q.take(HEAD_LEN);
      if (!head.subarray(0, 8).equals(MAGIC)) fail('Keine verschlüsselte BlaulichtCMS-Volume-Sicherung (Kopf fehlt).');
      if (!head.subarray(40, 48).equals(keyId(key))) fail('Die Sicherung wurde mit einem anderen Sicherungsschlüssel verschlüsselt.');
      k = fileKey(key, head.subarray(8, 40));
    }
    if (done) {
      if (q.length) fail('Daten nach dem letzten Block – Datei verändert.');
      return false;
    }
    if (q.length < 4) return false;
    const lenBuf = q.peek(4);
    const raw = lenBuf.readUInt32BE(0);
    const final = (raw & FINAL) !== 0;
    const len = (raw & ~FINAL) >>> 0;
    if (len > CHUNK) fail('Ungültige Blocklänge – Datei beschädigt oder verändert.');
    if (q.length < 4 + len + 16) return false;
    const rec = q.take(4 + len + 16);
    const d = crypto.createDecipheriv('aes-256-gcm', k, nonce(index++, final));
    d.setAAD(Buffer.concat([head, rec.subarray(0, 4)]));
    d.setAuthTag(rec.subarray(4 + len));
    let plain;
    try {
      plain = Buffer.concat([d.update(rec.subarray(4, 4 + len)), d.final()]);
    } catch {
      fail(`Block ${index} lässt sich nicht entschlüsseln – Datei beschädigt oder verändert.`);
    }
    if (emit && plain.length) await write(out, plain);
    if (final) done = true;
    return true;
  };
  for await (const chunk of process.stdin) {
    q.push(chunk);
    while (await step());
  }
  while (await step());
  if (!head) fail('Datei zu kurz – keine verschlüsselte BlaulichtCMS-Volume-Sicherung.');
  if (!done) fail('Datei endet vor dem letzten Block – Sicherung abgeschnitten.');
  if (emit) await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
}

const [cmd, file] = process.argv.slice(2);
process.stdout.on('error', (e) => fail(`Ausgabe fehlgeschlagen: ${e.message}`));
switch (cmd) {
  case 'genkey':
    console.log(crypto.randomBytes(32).toString('base64'));
    break;
  case 'encrypt':
    await encrypt(loadKey(file));
    break;
  case 'decrypt':
    await decrypt(loadKey(file), true);
    break;
  case 'verify':
    await decrypt(loadKey(file), false);
    break;
  default:
    fail('Aufruf: volume-crypt.mjs genkey | encrypt <schlüsseldatei> | decrypt <schlüsseldatei> | verify <schlüsseldatei>');
}
