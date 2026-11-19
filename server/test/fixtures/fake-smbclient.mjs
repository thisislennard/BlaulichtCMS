#!/usr/bin/env node
/**
 * Stellvertreter für smbclient in Tests (BLAULICHTCMS_SMBCLIENT_FAKE, nur unter Vitest): spielt eine SMB-Freigabe auf
 * einem lokalen Ordner – dieselben Argumente (-U, -N, -D, -c, -s, -t) und Ausgaben (ls-Zeilen, NT_STATUS-Meldungen,
 * Exit-Code des letzten Befehls) wie der echte smbclient. Die CI prüft zusätzlich gegen einen echten Samba-Server.
 *
 * Umgebung: FAKE_SMB_ROOT (Ordner mit je einem Unterordner pro Freigabe), FAKE_SMB_SERVER (erwarteter Server),
 * FAKE_SMB_USER/FAKE_SMB_PASS (erwartetes Konto; Passwort aus PASSWD), FAKE_SMB_CORRUPT=1 (get kippt ein Bit),
 * FAKE_SMB_OVERSIZE=1 (get liefert mehr), FAKE_SMB_LOG (Datei: Argumente je Aufruf, ohne Passwort).
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let service = null;
let user = null;
let dirArg = '';
let script = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-s' || a === '-t' || a === '-m') i++;
  else if (a === '-U') user = args[++i];
  else if (a === '-N') user = null;
  else if (a === '-D') dirArg = args[++i];
  else if (a === '-c') script = args[++i];
  else if (!service) service = a;
}
if (process.env.FAKE_SMB_LOG) fs.appendFileSync(process.env.FAKE_SMB_LOG, `${JSON.stringify({ args, passwd: 'PASSWD' in process.env })}\n`);

const out = (s) => process.stdout.write(`${s}\n`);
const m = /^\/\/([^/]+)\/(.+)$/.exec(service ?? '');
if (!m) {
  out('Usage: smbclient //server/share');
  process.exit(1);
}
const [, server, share] = m;
if (process.env.FAKE_SMB_SERVER && server !== process.env.FAKE_SMB_SERVER) {
  out(`do_connect: Connection to ${server} failed (Error NT_STATUS_UNSUCCESSFUL)`);
  process.exit(1);
}
if (process.env.FAKE_SMB_USER && (user !== process.env.FAKE_SMB_USER || process.env.PASSWD !== process.env.FAKE_SMB_PASS)) {
  out('session setup failed: NT_STATUS_LOGON_FAILURE');
  process.exit(1);
}
const shareRoot = path.join(process.env.FAKE_SMB_ROOT ?? '.', share);
if (!fs.existsSync(shareRoot)) {
  out('tree connect failed: NT_STATUS_BAD_NETWORK_NAME');
  process.exit(1);
}
let cwd = [];
const at = (segs) => path.join(shareRoot, ...segs);
if (dirArg) {
  const segs = dirArg.split(/[\\/]/).filter(Boolean);
  if (!fs.existsSync(at(segs)) || !fs.statSync(at(segs)).isDirectory()) {
    out(`cd \\${segs.join('\\')}\\: NT_STATUS_OBJECT_NAME_NOT_FOUND`);
    process.exit(1);
  }
  cwd = segs;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
const tokens = (cmd) => [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2]);
const rel = (name) => `\\${[...cwd, name].join('\\')}`;

let rc = 0;
for (const raw of script.split(';')) {
  const cmd = raw.trim();
  if (!cmd) continue;
  const [op, a1, a2] = tokens(cmd);
  const here = at(cwd);
  rc = 0;
  switch (op) {
    case 'pwd':
      out(`Current directory is \\\\${server}\\${share}\\${cwd.map((s) => `${s}\\`).join('')}`);
      break;
    case 'ls': {
      const mask = a1 ?? '*';
      const re = new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      const names = fs.readdirSync(here).filter((n) => re.test(n)).sort();
      if (!names.length) {
        out(`NT_STATUS_NO_SUCH_FILE listing ${rel(mask)}`);
        rc = 1;
        break;
      }
      for (const n of names) {
        const st = fs.statSync(path.join(here, n));
        out(`  ${n.padEnd(40)} ${st.isDirectory() ? 'D' : 'A'} ${String(st.isDirectory() ? 0 : st.size).padStart(10)}  ${stamp(st.mtime)}`);
      }
      out('');
      out('\t\t1048576 blocks of size 1024. 524288 blocks available');
      break;
    }
    case 'put':
      if (!fs.existsSync(a1)) {
        out(`${a1} does not exist`);
        rc = 1;
        break;
      }
      fs.copyFileSync(a1, path.join(here, a2));
      out(`putting file ${a1} as ${rel(a2)} (1000.0 kb/s)`);
      break;
    case 'get': {
      const src = path.join(here, a1);
      if (!fs.existsSync(src)) {
        out(`NT_STATUS_OBJECT_NAME_NOT_FOUND opening remote file ${rel(a1)}`);
        rc = 1;
        break;
      }
      let data = Buffer.from(fs.readFileSync(src));
      if (process.env.FAKE_SMB_CORRUPT === '1' && data.length) data[data.length - 1] ^= 1;
      if (process.env.FAKE_SMB_OVERSIZE === '1') data = Buffer.concat([data, Buffer.alloc(200_000)]);
      fs.writeFileSync(a2, data);
      out(`getting file ${rel(a1)} of size ${data.length} as ${a2} (1000.0 KiloBytes/sec)`);
      break;
    }
    case 'rename': {
      const from = path.join(here, a1);
      const to = path.join(here, a2);
      if (!fs.existsSync(from)) {
        out(`NT_STATUS_OBJECT_NAME_NOT_FOUND renaming files ${rel(a1)} -> ${rel(a2)}`);
        rc = 1;
      } else if (fs.existsSync(to)) {
        out(`NT_STATUS_OBJECT_NAME_COLLISION renaming files ${rel(a1)} -> ${rel(a2)}`);
        rc = 1;
      } else fs.renameSync(from, to);
      break;
    }
    case 'del':
    case 'rm': {
      const f = path.join(here, a1);
      if (!fs.existsSync(f)) {
        out(`NT_STATUS_NO_SUCH_FILE deleting remote file ${rel(a1)}`);
        rc = 1;
      } else fs.rmSync(f);
      break;
    }
    case 'mkdir': {
      const d = path.join(here, a1);
      if (fs.existsSync(d)) {
        out(`NT_STATUS_OBJECT_NAME_COLLISION making remote directory ${rel(a1)}`);
        rc = 1;
      } else fs.mkdirSync(d);
      break;
    }
    default:
      out(`${op}: command not found`);
      rc = 1;
  }
}
process.exit(rc);
