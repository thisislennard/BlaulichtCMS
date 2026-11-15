// Gemeinsame Hilfen für die Abnahmetests (Container, WordPress, API-Sitzungen).
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
export const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
export const WP = process.env.WP_URL ?? 'http://localhost:8080';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
export const psql = (sql) => sh(`docker compose exec -T blaulichtcms psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms -tAc ${JSON.stringify(sql)}`);
export const wpcli = (args) => sh(`docker compose -f test/wordpress/compose.yaml --profile cli run --rm -T cli wp ${args}`);
// Volume-Sicherungen sind verschlüsselt (#93): Testschlüssel außerhalb des Volumes für backup-/restore-volume.sh
if (!process.env.BLAULICHTCMS_BACKUP_KEY_FILE) {
  const keyFile = path.join(ROOT, 'test/e2e/out/backup.key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  }
  process.env.BLAULICHTCMS_BACKUP_KEY_FILE = keyFile;
}
export function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function totp(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/\s|=/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function waitHealthy(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BC}/healthz`);
      if (r.ok) return await r.json();
    } catch {
      /* noch nicht bereit */
    }
    await sleep(1000);
  }
  throw new Error('BlaulichtCMS wurde nicht gesund');
}

/** API-Sitzung mit Cookie (wie der Browser, inkl. CSRF-Header). */
export class Api {
  cookie = '';
  /** Zugangsdaten für die erneute Bestätigung kritischer Aktionen ({ password, totpSecret }), siehe confirm(). */
  reauth = null;
  /** Passwort (und Code) bestätigen; wartet auf das nächste TOTP-Zeitfenster, wenn der Code schon verwendet wurde. */
  async confirm() {
    for (let i = 0; i < 3; i++) {
      try {
        return await this.post('/auth/reauth', { password: this.reauth.password, ...(this.reauth.totpSecret ? { code: totp(this.reauth.totpSecret) } : {}) });
      } catch (e) {
        if (!/schon verwendet/.test(e.message) || i === 2) throw e;
        await sleep(31_000 - (Date.now() % 30_000));
      }
    }
  }
  async req(method, url, body, extraHeaders = {}, retried = false) {
    const headers = { accept: 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...extraHeaders };
    if (method !== 'GET') headers['x-blaulichtcms-request'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${BC}/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (r.status === 403 && json?.error === 'reauth_required' && this.reauth && !retried) {
      await this.confirm();
      return this.req(method, url, body, extraHeaders, true);
    }
    if (!r.ok) throw Object.assign(new Error(`${method} ${url}: ${r.status} ${json?.message ?? text}`), { status: r.status, json });
    return json;
  }
  get = (u) => this.req('GET', u);
  post = (u, b = {}) => this.req('POST', u, b);
  put = (u, b = {}) => this.req('PUT', u, b);
}

/** Frischer Container + Erstsetup per API (inkl. Zwei-Faktor) → angemeldete Admin-Sitzung. */
export async function freshInstance({ admin, organization = 'Musterorganisation' }) {
  sh('docker compose down -v');
  // Test-WordPress erreicht BlaulichtCMS über host.docker.internal → Port nicht nur an 127.0.0.1 binden
  fs.writeFileSync(path.join(ROOT, '.env'), 'COOKIE_SECURE=false\nTRUST_PROXY=false\nBLAULICHTCMS_BIND=0.0.0.0\n');
  sh('docker network inspect proxy-net >/dev/null 2>&1 || docker network create proxy-net');
  sh('docker compose up -d');
  await waitHealthy();
  const api = new Api();
  const token = sh('docker compose exec -T blaulichtcms cat /data/setup-token.txt');
  await api.post('/auth/setup', { token, organization, publicUrl: BC, timezone: 'Europe/Berlin', ...admin });
  const setup = await api.get('/auth/mfa/setup');
  await api.post('/auth/mfa/setup', { code: totp(setup.secret) });
  api.reauth = { password: admin.password, totpSecret: setup.secret };
  return { api, totpSecret: setup.secret };
}

export async function login(api, email, password, totpSecret) {
  const r = await api.post('/auth/login', { email, password });
  if (r.next === 'mfa') await api.post('/auth/mfa', { code: totp(totpSecret) });
  return api;
}

export async function inviteUser(admin, email, roles, name, password) {
  const inv = await admin.post('/users/invite', { email, roles, name });
  const token = inv.link.split('/einladung/')[1];
  const u = new Api();
  const r = await u.post(`/auth/invite/${token}`, { name, password });
  // Rollen mit Zwei-Faktor-Pflicht (Administration, „Medien verwalten“) richten 2FA direkt ein
  if (r.next === 'mfa_setup') {
    const setup = await u.get('/auth/mfa/setup');
    await u.post('/auth/mfa/setup', { code: totp(setup.secret) });
    u.totpSecret = setup.secret;
  }
  u.reauth = { password, totpSecret: u.totpSecret ?? null };
  return u;
}

export async function freshWordPress() {
  sh('docker compose -f test/wordpress/compose.yaml down -v');
  sh('docker compose -f test/wordpress/compose.yaml up -d');
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${WP}/wp-admin/install.php`);
      if (r.status < 500) break;
    } catch {
      /* startet */
    }
    await sleep(2000);
  }
  wpcli(`core install --url=${WP} --title="Testseite" --admin_user=wpadmin --admin_password=wp-test-2026 --admin_email=wp@example.org --skip-email`);
  wpcli('rewrite structure "/%year%/%monthnum%/%postname%/" --hard');
}

/** Bridge aus BlaulichtCMS laden, installieren und per CLI koppeln. */
export async function installBridge(admin, siteName = 'Testwebsite') {
  const r = await fetch(`${BC}/api/v1/sites/plugin.zip`, { headers: { cookie: admin.cookie } });
  fs.mkdirSync(path.join(ROOT, 'test/wordpress/tmp'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test/wordpress/tmp/blaulichtcms-bridge.zip'), Buffer.from(await r.arrayBuffer()));
  wpcli('plugin install /tmp/blaulichtcms/blaulichtcms-bridge.zip --activate --force');
  const s = await admin.post('/sites', { name: siteName });
  wpcli(`blaulichtcms-bridge pair http://host.docker.internal:7310 ${s.pairingCode}`);
  return s.site.id;
}

export function makeReport(file) {
  const report = { started: new Date().toISOString(), steps: [] };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
      console.log(`✔ ${name}${detail ? ` – ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    } catch (e) {
      report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 2000) });
      console.log(`✘ ${name}: ${e?.message ?? e}`);
      throw e;
    }
  };
  const finish = (ok) => {
    report.finished = new Date().toISOString();
    report.ok = ok;
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n${ok ? 'ERFOLGREICH' : 'FEHLGESCHLAGEN'}: ${report.steps.filter((s) => s.ok).length}/${report.steps.length} Schritte – Bericht: ${path.relative(ROOT, file)}`);
  };
  return { report, step, finish };
}

/** Abruf mit Wiederholung (Testumgebung: Container starten gelegentlich verzögert). */
export async function fetchText(url, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      return await r.text();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1000 * i);
    }
  }
}
