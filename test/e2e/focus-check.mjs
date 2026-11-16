/**
 * Regressionstest „Textfelder verlieren beim Tippen den Fokus“ (v0.2.1).
 *
 * Besucht alle Seiten der Oberfläche, öffnet die über Schaltflächen und Menüs erreichbaren Dialoge und tippt in jedes
 * sichtbare Textfeld (input, textarea, contenteditable) Zeichen für Zeichen. Nach dem Tippen muss der Fokus noch im
 * Feld liegen und der Wert den getippten Text enthalten. Während des Tippens laufen Live-Ereignisse (parallel angelegte
 * Beiträge) und eine vollständige Neuabfrage aller Daten (offline/online), damit Formulare, die sich aus
 * Abfragedaten neu befüllen, auffallen.
 *
 * Voraussetzungen: eine FRISCHE, laufende Instanz (Ersteinrichtung noch offen; der Test legt Testdaten an) und
 * Playwright mit Chromium. Aufruf aus dem Repository-Wurzelverzeichnis, z. B.:
 *   BLAULICHTCMS_URL=http://localhost:7310 SETUP_TOKEN_FILE=/pfad/zu/data/setup-token.txt node test/e2e/focus-check.mjs
 * (statt SETUP_TOKEN_FILE auch SETUP_TOKEN=…). Ergebnis: test/e2e/out/focus-report.json, Exit-Code 1 bei Fehlern.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Api, totp, inviteUser, login, sleep } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharp = createRequire(path.join(ROOT, 'server/package.json'))('sharp');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const OUT = path.join(ROOT, 'test/e2e/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.env.FOCUS_ONLY ? new RegExp(process.env.FOCUS_ONLY) : null;

const FIELD_SEL = 'input:not([type]), input[type=text], input[type=email], input[type=url], input[type=search], input[type=password], input[type=number], input[type=tel], textarea, [contenteditable=""], [contenteditable="true"]';
// Schaltflächen, die Daten unwiderruflich ändern, abmelden oder wegnavigieren, werden nicht angeklickt
const DENY = /lösch|entfern|abmelden|sitzung|widerruf|sperr|entsperr|deaktiv|archiv|install|neustart|neu starten|^wiederherstellen|zurücksetz|trennen|veröffentlich|senden|versand|speichern|übernehmen|herunterladen|download|export|drucken|sicherung|jetzt prüfen|nach updates|aktualisieren|ausführen|wartung|aufräumen|bereinig|kopieren|abbrechen|schließen|zurückziehen|einreichen|löschfrist|alle gelesen|als gelesen|neu laden/i;

const failures = [];
const tested = [];
const seenGlobal = new Set();

const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };

function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN.trim();
  if (process.env.SETUP_TOKEN_FILE) return fs.readFileSync(process.env.SETUP_TOKEN_FILE, 'utf8').trim();
  throw new Error('SETUP_TOKEN oder SETUP_TOKEN_FILE setzen (frische Instanz nötig)');
}

async function jpeg(seed) {
  const r = (seed * 53) % 255, g = (seed * 97) % 255, b = (seed * 31) % 255;
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
}

/** Kleiner RSS-Feed für die Quellen-Seite */
function rssServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Testquelle</title><link>http://example.org</link><description>t</description>
      <item><title>Meldung eins</title><link>http://example.org/1</link><guid>1</guid><description>Text eins</description><pubDate>${new Date().toUTCString()}</pubDate></item>
      <item><title>Meldung zwei</title><link>http://example.org/2</link><guid>2</guid><description>Text zwei</description><pubDate>${new Date().toUTCString()}</pubDate></item>
    </channel></rss>`);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* ------------------------------------------ Feldprüfung ------------------------------------------ */

async function fieldInfo(h) {
  return h.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    const lbl = el.getAttribute('aria-label') || (el.labels && el.labels[0]?.innerText) || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName.toLowerCase();
    const inChrome = !!el.closest('header, nav, aside') && !el.closest('[role=dialog]');
    return {
      visible,
      enabled: !el.disabled && !el.readOnly && el.getAttribute('aria-disabled') !== 'true',
      label: String(lbl).replace(/\s+/g, ' ').trim().slice(0, 80),
      type: el.isContentEditable ? 'contenteditable' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
      inputMode: el.getAttribute('inputmode') || '',
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      len: el.isContentEditable ? el.textContent.length : el.value.length,
      inChrome,
    };
  });
}

/** Tippt in alle sichtbaren Felder im Bereich `scope` (Selektor). seen verhindert doppelte Prüfung desselben Felds. */
async function checkFields(page, where, scope, seen) {
  // Zugeklappte Bereiche (<details>) öffnen, damit auch deren Felder geprüft werden
  await page.evaluate(() => document.querySelectorAll('details:not([open])').forEach((d) => (d.open = true))).catch(() => {});
  const loc = page.locator(scope ? `${scope} :is(${FIELD_SEL})` : `:is(${FIELD_SEL}):not([role=dialog] *)`);
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const h = await loc.nth(i).elementHandle({ timeout: 1000 }).catch(() => null);
    if (!h) continue;
    const info = await fieldInfo(h).catch(() => null);
    if (!info || !info.visible || !info.enabled || !(await h.isVisible().catch(() => false))) continue;
    const key = `${info.label}|${info.type}`;
    if (info.inChrome) {
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const numeric = info.type === 'number' || info.type === 'tel' || info.inputMode === 'numeric';
    let text = numeric ? '1234567890' : 'Fokustestabcdefghij';
    if (info.maxLength) text = text.slice(0, Math.max(0, info.maxLength - info.len));
    if (text.length < 2) continue;
    try {
      await h.scrollIntoViewIfNeeded({ timeout: 1500 });
      await h.click({ timeout: 2000 });
      await page.keyboard.press(info.type === 'textarea' || info.type === 'contenteditable' ? 'Control+End' : 'End');
      const half = Math.floor(text.length / 2);
      await page.keyboard.type(text.slice(0, half), { delay: 30 });
      // Vollständige Neuabfrage aller Daten mitten im Tippen (wie nach einem Netzwechsel)
      await page.evaluate(() => {
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
      });
      await sleep(250);
      await page.keyboard.type(text.slice(half), { delay: 30 });
      await sleep(300);
      const res = await h.evaluate((el, t) => {
        const a = document.activeElement;
        const v = el.isContentEditable ? el.textContent : el.value;
        return { connected: el.isConnected, focused: a === el || el.contains(a), value: v, activeDesc: a ? `${a.tagName.toLowerCase()}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}${a.id ? `#${a.id}` : ''}` : 'null', ok: v.replace(/\s/g, '').endsWith(t.replace(/\s/g, '')) || v.replace(/\D/g, '').endsWith(t.replace(/\D/g, '') || 'x') };
      }, text);
      tested.push({ where, field: info.label, type: info.type });
      if (!res.connected || !res.focused || !res.ok) {
        const f = { where, field: info.label, type: info.type, connected: res.connected, focused: res.focused, valueOk: res.ok, value: res.value.slice(-40), active: res.activeDesc };
        failures.push(f);
        console.log(`  ✘ ${where} › ${info.label}: ${!res.connected ? 'Feld neu erzeugt' : !res.focused ? `Fokus verloren (jetzt ${res.activeDesc})` : `Wert „${res.value.slice(-30)}“`}`);
      }
      // Eingabe zurücknehmen, damit Formulare im Ausgangszustand bleiben
      if (res.connected && res.focused) for (let k = 0; k < text.length; k++) await page.keyboard.press('Backspace');
    } catch (e) {
      console.log(`  ? ${where} › ${info.label}: nicht prüfbar (${String(e.message).split('\n')[0].slice(0, 100)})`);
    }
  }
}

/* ------------------------------------------ Dialoge ------------------------------------------ */

const dialogOpen = (page) => page.locator('[role=dialog]').first().isVisible().catch(() => false);

async function closeDialogs(page, route) {
  for (let k = 0; k < 3 && (await dialogOpen(page)); k++) {
    await page.keyboard.press('Escape');
    await sleep(250);
    if (await dialogOpen(page)) {
      await page.locator('[role=dialog] [data-close]').last().click({ timeout: 1000 }).catch(() => {});
      await sleep(250);
    }
  }
  if (await dialogOpen(page)) await gotoRoute(page, route);
}

async function gotoRoute(page, route) {
  await page.goto(BC + route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(400);
}

async function buttonNames(page) {
  return page.evaluate((deny) => {
    const re = new RegExp(deny.source, deny.flags);
    const out = [];
    const btns = [...document.querySelectorAll('main button, main [role=tab], body > div:not(#root) button')].filter((b) => !b.closest('[role=dialog]'));
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height || b.disabled) continue;
      const name = (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim();
      // Reiter und Menü-Knöpfe nur umschalten bzw. öffnen – nie ausschließen
      if (re.test(name) && b.getAttribute('aria-haspopup') !== 'menu' && b.getAttribute('role') !== 'tab') continue;
      out.push({ name, menu: b.getAttribute('aria-haspopup') === 'menu', tab: b.getAttribute('role') === 'tab' });
    }
    return out;
  }, { source: DENY.source, flags: DENY.flags });
}

async function clickNth(page, name, idx, sel = 'main button, main [role=tab], body > div:not(#root) button') {
  const ok = await page.evaluate(
    ({ name, idx, sel }) => {
      const btns = [...document.querySelectorAll(sel)].filter((b) => !b.closest('[role=dialog]') && b.getBoundingClientRect().width && !b.disabled);
      const same = btns.filter((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim() === name);
      const b = same[idx];
      if (!b) return false;
      b.setAttribute('data-focus-target', '1');
      return true;
    },
    { name, idx, sel },
  );
  if (!ok) return false;
  const l = page.locator('[data-focus-target="1"]').first();
  try {
    await l.scrollIntoViewIfNeeded({ timeout: 1500 });
    await l.click({ timeout: 2500 });
  } catch {
    await page.evaluate(() => document.querySelector('[data-focus-target="1"]')?.removeAttribute('data-focus-target'));
    return false;
  }
  await page.evaluate(() => document.querySelector('[data-focus-target="1"]')?.removeAttribute('data-focus-target'));
  return true;
}

/** Nach einem Klick: Dialog prüfen bzw. neue Felder auf der Seite (Popover, eingeblendete Formulare). */
const DEBUG = process.env.FOCUS_DEBUG === '1';
async function afterClick(page, route, where, label, seen) {
  await sleep(450);
  if (DEBUG) console.log(`    · Klick „${label}“ → ${(await dialogOpen(page)) ? 'Dialog' : new URL(page.url()).pathname}`);
  if (await dialogOpen(page)) {
    const title = (await page.locator('[role=dialog] h2').last().innerText().catch(() => '')).trim();
    await checkFields(page, `${where} › Dialog „${title || label}“`, '[role=dialog]', new Set());
    await closeDialogs(page, route);
  } else {
    await checkFields(page, `${where} › nach „${label}“`, null, seen);
  }
}

const samePath = (page, route) => new URL(page.url()).pathname === new URL(BC + route).pathname;
const activeTab = (page) => page.locator('[role=tab][aria-selected=true]').first().innerText({ timeout: 500 }).then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => null);

/** Klickt alle (nicht ausgeschlossenen) Schaltflächen und Menüeinträge im aktuellen Zustand; reset() stellt ihn her. */
async function scanButtons(page, route, where, tab, reset, seen, done) {
  const dirty = async () => !samePath(page, route) || (await dialogOpen(page)) || (tab && (await activeTab(page)) !== tab);
  const list = (await buttonNames(page)).filter((b) => !b.tab);
  const count = {};
  for (const b of list) {
    const idx = (count[b.name] = (count[b.name] ?? -1) + 1);
    const key = `${b.name}#${idx}`;
    if (done.has(key)) continue;
    done.add(key);
    if (await dirty()) await reset();
    if (b.menu) {
      if (!(await clickNth(page, b.name, idx))) continue;
      await sleep(300);
      const items = (await page.locator('[role=menuitem]:not([disabled])').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      if (DEBUG) console.log(`    · Menü „${b.name}“#${idx}: ${items.join(', ') || '(leer)'}`);
      await page.keyboard.press('Escape');
      for (const it of items) {
        if (DENY.test(it)) continue;
        if (await dirty()) await reset();
        if (!(await clickNth(page, b.name, idx))) break;
        await sleep(300);
        const mi = page.locator('[role=menuitem]', { hasText: it }).first();
        if (!(await mi.isVisible().catch(() => false))) continue;
        await mi.click({ timeout: 2000 }).catch(() => {});
        await afterClick(page, route, where, `${b.name} › ${it}`, seen);
      }
      continue;
    }
    if (!(await clickNth(page, b.name, idx))) continue;
    await afterClick(page, route, where, b.name || '(Symbol)', seen);
  }
}

async function scanRoute(page, route, { buttons = true } = {}) {
  if (ONLY && !ONLY.test(route)) return;
  console.log(`▶ ${route}`);
  await gotoRoute(page, route);
  const seen = new Set();
  await checkFields(page, route, null, seen);
  if (!buttons) return;
  // Jeder Reiter der Seite ist ein eigener Ausgangszustand (Felder, Schaltflächen, Dialoge darin)
  const tabs = [...new Set((await buttonNames(page)).filter((b) => b.tab).map((b) => b.name))];
  if (DEBUG) console.log(`    · Reiter: ${tabs.join(', ') || '–'}`);
  for (const tab of [null, ...tabs]) {
    // Je Reiter eigene Merklisten: gleich benannte Schaltflächen/Felder in verschiedenen Reitern sind verschiedene
    const done = new Set();
    const tabSeen = tab ? new Set() : seen;
    const reset = async () => {
      await gotoRoute(page, route);
      if (tab) {
        await clickNth(page, tab, 0);
        await sleep(400);
      }
    };
    const where = tab ? `${route} › Reiter „${tab}“` : route;
    if (tab) {
      await reset();
      await checkFields(page, where, null, tabSeen);
    }
    await scanButtons(page, route, where, tab, reset, tabSeen, done);
  }
}

/* ------------------------------------------ Ablauf ------------------------------------------ */

let churn = null;
let rss = null;

async function freshSetup() {
  // Ersteinrichtung im Browser (Felder der Einrichtungsseite), danach per API
  const pre = await browser.newContext({ bypassCSP: true });
  const p0 = await pre.newPage();
  p0.on('dialog', (d) => d.accept().catch(() => {}));
  await scanRoute(p0, '/einrichtung', { buttons: false });
  await scanRoute(p0, '/login', { buttons: false });
  await pre.close();

  const admin = new Api();
  await admin.post('/auth/setup', { token: setupToken(), organization: 'Musterorganisation', publicUrl: BC, timezone: 'Europe/Berlin', ...ADMIN });
  const mfa = await admin.get('/auth/mfa/setup');
  await admin.post('/auth/mfa/setup', { code: totp(mfa.secret) });
  admin.reauth = { password: ADMIN.password, totpSecret: mfa.secret };
  console.log('✔ Ersteinrichtung');

  // 2) Testdaten
  const editor = await inviteUser(admin, 'redaktion@example.org', ['editor', 'media_manager'], 'Robin Redaktion', 'Redaktion-Testkennwort-2026');
  const openInvite = await admin.post('/users/invite', { email: 'offen@example.org', roles: ['viewer'], name: 'Offene Einladung' });
  const post = await admin.post('/posts', { title: 'Testbeitrag Fokus', kind: 'news' });
  const sub = await editor.post('/posts', { title: 'Eingereichter Beitrag', kind: 'news' });
  const sd = await editor.get(`/posts/${sub.id}`);
  await editor.put(`/posts/${sub.id}/revision`, { baseRevision: sd.revision.n ?? sd.revision.number ?? 1, title: 'Eingereichter Beitrag', body: 'Text zur Freigabe.' }).catch((e) => console.log('  (Fassung)', e.message));
  await editor.post(`/posts/${sub.id}/submit`, { revision: 2 }).catch((e) => console.log('  (Einreichen)', e.message));
  const col = await admin.post('/collections', { title: 'Testsammlung Fokus', purpose: 'Test', postId: post.id });
  const token = col.link.url.split('/u/')[1];
  for (let i = 1; i <= 3; i++) {
    const fd = new FormData();
    fd.append('file', new Blob([await jpeg(i)], { type: 'image/jpeg' }), `bild-${i}.jpg`);
    const r = await fetch(`${BC}/api/v1/public/upload/${token}`, { method: 'POST', body: fd, headers: { 'x-blaulichtcms-request': '1' } });
    if (!r.ok) console.log('  (Upload)', r.status, await r.text());
  }
  // Medien wie LiFeOS: Ordner (Ordnerleiste, Ordnerdialoge) und ein zweiter Link mit erweiterten Optionen
  await admin.post(`/collections/${col.collection.id}/folders`, { name: 'Einsatz' }).catch((e) => console.log('  (Ordner)', e.message));
  const optLink = await admin.post(`/collections/${col.collection.id}/links`, { label: 'Mit Optionen', fields: { name: 'optional', email: 'optional' }, consentRequired: true, consentText: 'Ich habe die Aufnahmen selbst gemacht.' }).catch((e) => (console.log('  (Link)', e.message), null));
  await admin.post('/templates', { name: 'Testvorlage', kind: 'news', title: 'Vorlagentitel', body: 'Vorlagentext' });
  rss = await rssServer();
  await admin.post('/rss/feeds', { url: `http://127.0.0.1:${rss.address().port}/feed.xml`, title: 'Testquelle' }).catch((e) => console.log('  (RSS)', e.message));
  const conn = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Test', config: {} }).catch((e) => (console.log('  (Verbindung)', e.message), null));
  const wf = await admin.post('/connections', { kind: 'warnfeed', name: 'Amtliche Warnungen Test', config: {} }).catch((e) => (console.log('  (Warnfeed)', e.message), null));
  const fsc = await admin.post('/connections', { kind: 'feuersoftware', name: 'Feuersoftware Test', config: {} }).catch((e) => (console.log('  (Feuersoftware)', e.message), null));
  // Soziale Kanäle (#188, #189): Threads (Entwurf), X über die API (Entwurf) und – getestet und aktiv – X von Hand und
  // WhatsApp-Kanal; der Testbeitrag wählt beide, damit die Kanaltexte im Beitrag erscheinen
  const thc = await admin.post('/connections', { kind: 'threads', name: 'Threads Test', config: {} }).catch((e) => (console.log('  (Threads)', e.message), null));
  const xac = await admin.post('/connections', { kind: 'x', name: 'X über API Test', config: { mode: 'api' } }).catch((e) => (console.log('  (X)', e.message), null));
  const social = [];
  for (const [kind, name] of [['x', 'X von Hand Test'], ['whatsapp', 'WhatsApp-Kanal Test']]) {
    try {
      const c = await admin.post('/connections', { kind, name, config: {} });
      await admin.post(`/connections/${c.id}/test`);
      await admin.post(`/connections/${c.id}/activate`);
      social.push(c.id);
    } catch (e) {
      console.log(`  (${name})`, e.message);
    }
  }
  if (social.length) await admin.put(`/posts/${post.id}/revision`, { baseRevision: 1, title: 'Testbeitrag Fokus', body: 'Text', socialTargets: social }).catch((e) => console.log('  (Soziale Kanäle im Beitrag)', e.message));
  // Empfangsprotokoll mit Inhalt: eine fiktive Testmeldung an den FE2-Eingang
  if (conn?.token) {
    await fetch(`${BC}/api/v1/inbound/fe2/${conn.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.token}`, 'x-blaulichtcms-test': '1', 'x-blaulichtcms-request': '1' }, body: JSON.stringify({ einsatz: { id: 'FOKUS-1', stichwort: 'F-TEST-1', ort: 'Musterstadt' }, meldung: { alarmtext: 'Fiktiver Text' } }) })
      .then(async (r) => r.ok || console.log('  (FE2-Testmeldung)', r.status, await r.text()))
      .catch((e) => console.log('  (FE2-Testmeldung)', e.message));
  }
  // Website wie die Bridge koppeln (ohne WordPress), damit Banner und Kanäle Inhalt haben
  try {
    const s = await admin.post('/sites', { name: 'Testwebsite' });
    const pr = await new Api().post('/bridge/pair', { code: s.pairingCode, site_url: 'https://wp.example.org', site_name: 'Testwebsite', wp_version: '6.8', plugin_version: '0.7.0' });
    const banner = { siteId: pr.site_id, title: 'Testbanner', text: 'Bitte Umleitung beachten.', tone: 'danger', priority: 3, endsAt: new Date(Date.now() + 86400_000).toISOString() };
    await editor.post('/banners', banner).catch(() => admin.post('/banners', banner)).catch((e) => console.log('  (Banner)', e.message));
    await admin.post('/sites', { name: 'Zweite Website' });
  } catch (e) {
    console.log('  (Website)', e.message);
  }
  await admin.post('/responsibilities', { name: 'Leitstelle (fiktiv)', area: 'Musterkreis', recipients: ['leitstelle@example.invalid'] }).catch((e) => console.log('  (Zuständigkeit)', e.message));
  const kw = await admin.post('/warning-keywords', { code: 'F-TEST-1', label: 'Testeinsatz', aliases: ['test'] }).catch((e) => (console.log('  (Stichwort)', e.message), null));
  if (kw) await admin.post(`/warning-keywords/${kw.id}/questions`, { key: 'frage_eins', text: 'Testfrage?' }).catch(() => {});
  const warn = await admin.post('/warnings', { kind: 'initial' }).catch((e) => (console.log('  (Warnung)', e.message), null));
  // Automationen: Eingang, Ausgang und ein kleiner Ablauf (Editor, Seitenleiste, Listenansicht, Dialoge)
  let automationId = null;
  try {
    const ai = await admin.post('/automation-inputs', { name: 'Fokus-Eingang', kind: 'manual', config: { fields: [{ key: 'ort', label: 'Ort', example: 'Nord' }] } });
    const ao = await admin.post('/automation-outputs', { name: 'Fokus-Hinweis', kind: 'notify', config: { roles: ['editor'], title: 'Hinweis {{ort}}' } });
    const au = await admin.post('/automations', { name: 'Fokus-Automation', description: 'Testablauf' });
    const d = await admin.get(`/automations/${au.id}`);
    await admin.put(`/automations/${au.id}`, {
      name: d.name,
      description: d.description,
      baseHash: d.draft_hash,
      graph: {
        nodes: [
          { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { inputId: ai.id } },
          { id: 'if', type: 'condition', position: { x: 320, y: 0 }, data: { combinator: 'and', rules: [{ field: 'ort', op: 'eq', value: 'Nord' }] } },
          { id: 'tpl', type: 'template', position: { x: 640, y: 0 }, data: { fields: [{ key: 'text', template: '{{ort}}' }] } },
          { id: 'out', type: 'output', position: { x: 960, y: 0 }, data: { outputId: ao.id } },
        ],
        edges: [
          { id: 'e1', source: 'in', sourceHandle: 'out', target: 'if' },
          { id: 'e2', source: 'if', sourceHandle: 'true', target: 'tpl' },
          { id: 'e3', source: 'tpl', sourceHandle: 'out', target: 'out' },
        ],
      },
    });
    automationId = au.id;
  } catch (e) {
    console.log('  (Automation)', e.message);
  }
  // Designvorlagen (#208): eine Vorlage für die Detailseite
  const designTemplate = await admin.post('/design-templates', { title: 'Fokus-Vorlage', usageNote: 'Nur intern' }).catch((e) => (console.log('  (Designvorlage)', e.message), null));
  console.log('✔ Testdaten');
  const st = {
    adminSecret: mfa.secret,
    editor: { email: 'redaktion@example.org', password: 'Redaktion-Testkennwort-2026', secret: editor.totpSecret },
    token,
    openInviteToken: openInvite.link.split('/einladung/')[1],
    postId: post.id,
    subId: sub.id,
    collectionId: col.collection.id,
    linkId: col.link.id,
    optToken: optLink?.url ? optLink.url.split('/u/')[1] : null,
    connectionId: conn ? (conn.connection ?? conn).id : null,
    warnfeedId: wf ? (wf.connection ?? wf).id : null,
    feuersoftwareId: fsc?.id ?? null,
    threadsId: thc?.id ?? null,
    xApiId: xac?.id ?? null,
    whatsappId: social[1] ?? null,
    warningId: warn?.id ?? null,
    automationId,
    designTemplateId: designTemplate?.id ?? null,
  };
  return { admin, editor, st };

}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let exitCode = 1;
try {
  const STATE = path.join(OUT, 'focus-state.json');
  let admin, editor, st;
  if (process.env.FOCUS_REUSE === '1' && fs.existsSync(STATE)) {
    // Wiederholung gegen dieselbe Instanz (zum Eingrenzen mit FOCUS_ONLY): Testdaten aus dem letzten Lauf
    st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    admin = await login(new Api(), ADMIN.email, ADMIN.password, st.adminSecret);
    admin.reauth = { password: ADMIN.password, totpSecret: st.adminSecret };
    editor = await login(new Api(), st.editor.email, st.editor.password, st.editor.secret);
    rss = await rssServer();
    console.log('✔ Anmeldung (Wiederholung)');
  } else {
    ({ admin, editor, st } = await freshSetup());
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  }
  const { token, openInviteToken } = st;
  const post = { id: st.postId };
  const sub = { id: st.subId };
  const col = { collection: { id: st.collectionId } };
  const conn = st.connectionId ? { id: st.connectionId } : null;
  const warn = st.warningId ? { id: st.warningId } : null;

  // 3) Öffentliche Seiten und Einladung
  const pub = await browser.newContext({ bypassCSP: true });
  const pp = await pub.newPage();
  pp.on('dialog', (d) => d.accept().catch(() => {}));
  await scanRoute(pp, `/u/${token}`);
  // Upload-Seite mit abgefragten Angaben und Bestätigung (Medien wie LiFeOS)
  if (st.optToken) await scanRoute(pp, `/u/${st.optToken}`);
  await scanRoute(pp, `/einladung/${openInviteToken}`, { buttons: false });
  // 2FA-Seite: Anmeldung mit Passwort, dann Code-Seite
  await gotoRoute(pp, '/login');
  try {
    await checkFields(pp, '/login', null, new Set());
    await pp.locator('#email').fill(ADMIN.email, { timeout: 5000 });
    await pp.locator('#pw').fill(ADMIN.password);
    await pp.keyboard.press('Enter');
    await pp.waitForURL(/\/2fa/, { timeout: 8000 });
    await checkFields(pp, '/2fa', null, new Set());
  } catch (e) {
    console.log(`  ? Anmeldung/2FA nicht prüfbar: ${pp.url()} – ${String(e.message).split('\n')[0]} – ${(await pp.locator('body').innerText()).slice(0, 200).replace(/\n+/g, ' | ')}`);
  }
  await pub.close();

  // 4) Angemeldete Seiten
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // Live-Ereignisse während des ganzen Laufs: alle 2 s ein Beitrag (posts → Beitragslisten, Dashboard)
  let n = 0;
  churn = setInterval(() => editor.post('/posts', { title: `Live-Ereignis ${++n}`, kind: 'news' }).catch(() => {}), 2000);

  const routes = ['/', '/beitraege', `/beitraege/${post.id}`, `/beitraege/${sub.id}`, '/vorlagen', '/freigaben', '/medien', `/medien/${col.collection.id}`, '/medien/dateien', '/medien/papierkorb', '/medien/verwaltung', '/medien/gestaltung', ...(st.linkId ? [`/medien/gestaltung?link=${st.linkId}`] : []), '/designvorlagen', ...(st.designTemplateId ? [`/designvorlagen/${st.designTemplateId}`] : []), '/quellen', '/banner', '/kanaele', '/warnungen', '/warnungen/pflege', ...(warn ? [`/warnungen/${warn.id}`] : []), '/verbindungen', ...(conn ? [`/verbindungen/${conn.id}`, `/verbindungen/${conn.id}?ansicht=empfangsprotokoll`] : []), ...(st.warnfeedId ? [`/verbindungen/${st.warnfeedId}`, `/verbindungen/${st.warnfeedId}?ansicht=empfangsprotokoll`] : []), ...(st.feuersoftwareId ? [`/verbindungen/${st.feuersoftwareId}`] : []), ...[st.threadsId, st.xApiId, st.whatsappId].filter(Boolean).map((x) => `/verbindungen/${x}`), '/amtliche-warnungen', '/workflows', '/workflows/eingaenge', '/workflows/ausgaenge', ...(st.automationId ? [`/workflows/${st.automationId}`] : []), '/benutzer', '/system', '/protokolle', '/datenschutz-anfragen', '/einstellungen', '/profil', '/hilfe', '/aktivitaeten', '/benachrichtigungen'];
  for (const r of routes) await scanRoute(page, r);

  // Löschdialoge (Löschen-Knöpfe klickt der Rundgang bewusst nicht): Warnvorgang mit Begründung, Verbindung
  async function openDialog(route, button, where, before) {
    if (ONLY && !ONLY.test(where)) return;
    await gotoRoute(page, route);
    if (before) await page.getByRole('button', { name: before }).first().click({ timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: button, exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.locator('[role=dialog]').first().waitFor({ timeout: 6000 }).catch(() => {});
    await sleep(600);
    if (await dialogOpen(page)) await checkFields(page, where, '[role=dialog]', new Set());
    else failures.push({ where, field: '(Dialog)', problem: 'Dialog nicht geöffnet' });
    await closeDialogs(page, route);
  }
  if (warn) await openDialog(`/warnungen/${warn.id}`, 'Löschen', 'Dialog „Vorgang löschen“');
  if (st.feuersoftwareId) await openDialog(`/verbindungen/${st.feuersoftwareId}`, 'Löschen', 'Dialog „Verbindung löschen“', /^\d*\s*Aktivieren$/);

  // Dialog zur erneuten Bestätigung (Reauth): API-Antwort „reauth_required“ für eine Anfrage vortäuschen
  if (!ONLY || ONLY.test('reauth')) {
    await gotoRoute(page, '/benachrichtigungen');
    let once = false;
    await page.route('**/api/v1/notifications**', (route) => {
      if (once) return route.continue();
      once = true;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'reauth_required', message: 'Bitte bestätigen.' }) });
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await page.locator('[role=dialog]').first().waitFor({ timeout: 6000 }).catch(() => {});
    if (await dialogOpen(page)) await checkFields(page, 'Dialog „Erneut bestätigen“ (Reauth)', '[role=dialog]', new Set());
    else console.log('  ? Reauth-Dialog nicht geöffnet');
    await page.unroute('**/api/v1/notifications**');
    await closeDialogs(page, '/benachrichtigungen');
  }

  // Medien wie LiFeOS: Dialoge der Sammlung gezielt öffnen (Link mit erweiterten Optionen, Ordner, Details, Schlagworte)
  if (!ONLY || ONLY.test('medien-dialoge')) {
    const route = `/medien/${col.collection.id}`;
    const dialogs = [
      ['Neuer Upload-Link (erweitert)', async () => (await page.getByRole('button', { name: 'Neuer Link' }).click(), await sleep(300), await page.getByRole('button', { name: /Erweitert/ }).click())],
      ['Neuer Ordner', async () => page.getByRole('button', { name: 'Neuer Ordner' }).click()],
      ['Details einer Datei', async () => (await page.getByRole('tab', { name: /Alle/ }).click(), await sleep(300), await page.getByRole('button', { name: /^Aktionen für .*\.jpg$/ }).first().click(), await page.getByRole('menuitem', { name: 'Details' }).click())],
      ['Schlagworte einer Datei', async () => (await page.getByRole('tab', { name: /Alle/ }).click(), await sleep(300), await page.getByRole('button', { name: /^Aktionen für .*\.jpg$/ }).first().click(), await page.getByRole('menuitem', { name: 'Schlagworte' }).click())],
      ['Upload-Link bearbeiten (erweitert)', async () => (await page.getByRole('button', { name: /^Aktionen für Mit Optionen/ }).click(), await page.getByRole('menuitem', { name: 'Bearbeiten' }).click(), await sleep(300), await page.getByRole('button', { name: /Erweitert/ }).click())],
    ];
    for (const [name, open] of dialogs) {
      await gotoRoute(page, route);
      try {
        await open();
        await page.locator('[role=dialog]').first().waitFor({ timeout: 5000 });
        await sleep(400);
        await checkFields(page, `${route} › Dialog „${name}“`, '[role=dialog]', new Set());
      } catch (e) {
        failures.push({ where: `${route} › ${name}`, field: '-', problem: `Dialog nicht geöffnet: ${String(e.message).split('\n')[0]}` });
      }
      await closeDialogs(page, route);
    }
  }

  // Dashboard anpassen: Auswahlfelder (Spaltenbreite, Vorlagenziel) und Griffe zum Verschieben behalten Fokus und Wert,
  // auch wenn Live-Ereignisse eintreffen und alle Abfragen neu geladen werden. Gespeichert wird nichts (Abbrechen).
  if (!ONLY || ONLY.test('dashboard-anpassen')) {
    const where = '/ › Dashboard anpassen';
    console.log(`▶ ${where}`);
    await gotoRoute(page, '/');
    try {
      await page.getByRole('button', { name: 'Dashboard anpassen' }).click({ timeout: 5000 });
      await page.locator('[data-dash-columns]').waitFor({ timeout: 8000 });
      await checkFields(page, where, null, new Set());
      const refetch = () =>
        page.evaluate(() => {
          window.dispatchEvent(new Event('offline'));
          window.dispatchEvent(new Event('online'));
        });
      const stillFocused = async (loc, field, type, value) => {
        await refetch();
        await sleep(2500); // mindestens ein Live-Ereignis (alle 2 s) und die Neuabfrage abwarten
        const res = await loc.evaluate((el) => ({ connected: el.isConnected, focused: document.activeElement === el, value: el.value })).catch(() => ({ connected: false, focused: false, value: '' }));
        tested.push({ where, field, type });
        const problem = !res.connected ? 'Feld neu erzeugt' : !res.focused ? 'Fokus verloren' : value !== undefined && res.value !== value ? `Auswahl zurückgesetzt („${res.value}“)` : null;
        if (problem) {
          failures.push({ where, field, type, problem });
          console.log(`  ✘ ${where} › ${field}: ${problem}`);
        }
      };
      for (const [field, loc, value] of [
        ['Breite von Spalte 1', page.getByLabel('Breite von Spalte 1'), '2'],
        ['Als Vorlage speichern für', page.locator('#dash-template-target'), '*'],
      ]) {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
        await loc.focus();
        await loc.selectOption(value);
        await stillFocused(loc, field, 'select', value);
      }
      for (const name of [/^Kennzahl „.*“ verschieben$/, /^Kachel „.*“ verschieben$/, /^Spalte 1 verschieben$/]) {
        const handle = page.getByRole('button', { name }).first();
        await handle.focus();
        await stillFocused(handle, `Griff ${name.source}`, 'griff');
      }
      // Neue Spalte: ihr Auswahlfeld erscheint und ist sofort bedienbar
      await page.getByRole('button', { name: 'Spalte hinzufügen' }).click();
      const added = page.getByLabel('Breite von Spalte 3');
      await added.focus({ timeout: 3000 });
      await added.selectOption('5');
      await stillFocused(added, 'Breite von Spalte 3 (neu)', 'select', '5');
    } catch (e) {
      failures.push({ where, field: '-', problem: `Bearbeitungsmodus nicht prüfbar: ${String(e.message).split('\n')[0]}` });
      console.log(`  ✘ ${where}: ${String(e.message).split('\n')[0]}`);
    }
    await page.getByRole('button', { name: 'Abbrechen', exact: true }).click({ timeout: 3000 }).catch(() => {});
  }

  // Rollen-Editor (Benutzer und Rollen → Rollen): Neue Rolle, Rechte bearbeiten, Kopie, Prüfschritt
  if (!ONLY || ONLY.test('rollen-dialoge')) {
    const route = '/benutzer?tab=rollen';
    const menu = async (item) => (await page.getByRole('button', { name: 'Aktionen für Rolle Redaktion' }).click(), await page.getByRole('menuitem', { name: item }).click());
    const dialogs = [
      ['Neue Rolle', async () => page.getByRole('button', { name: 'Neue Rolle' }).click()],
      ['Rolle bearbeiten', async () => menu('Rechte bearbeiten')],
      ['Rolle kopieren', async () => menu('Als Kopie anlegen')],
      ['Rolle: Änderung prüfen', async () => (await menu('Als Kopie anlegen'), await page.locator('[role=dialog]').first().waitFor({ timeout: 5000 }), await page.getByRole('button', { name: /^Weiter: Änderung prüfen/ }).click())],
    ];
    for (const [name, open] of dialogs) {
      await gotoRoute(page, route);
      try {
        await open();
        await page.locator('[role=dialog]').first().waitFor({ timeout: 5000 });
        await sleep(400);
        await checkFields(page, `${route} › Dialog „${name}“`, '[role=dialog]', new Set());
      } catch (e) {
        failures.push({ where: `${route} › ${name}`, field: '-', problem: `Dialog nicht geöffnet: ${String(e.message).split('\n')[0]}` });
      }
      await closeDialogs(page, route);
    }
  }

  // Workflows: Vorlagen-Dialog, geführte Ansicht, erweiterter Editor (Seitenleiste je Knoten, Listenansicht), Dialoge der Ein- und Ausgänge
  if (st.automationId && (!ONLY || ONLY.test('workflows'))) {
    const route = `/workflows/${st.automationId}`;
    await gotoRoute(page, '/workflows');
    try {
      await page.getByRole('button', { name: 'Neuer Workflow' }).first().click({ timeout: 5000 });
      await sleep(300);
      await checkFields(page, '/workflows › Dialog „Neuer Workflow“', '[role=dialog]', new Set());
    } catch (e) {
      failures.push({ where: '/workflows › Neuer Workflow', field: '-', problem: String(e.message).split('\n')[0] });
    }
    await closeDialogs(page, '/workflows');
    // Geführte Ansicht (Standard); der Fokus-Workflow ist verzweigt → Hinweis auf „Erweitert“
    await gotoRoute(page, route);
    await checkFields(page, `${route} › Geführt`, 'main', new Set());
    for (const label of ['Fokus-Eingang', 'trifft zu', 'Felder setzen', 'Fokus-Hinweis']) {
      await gotoRoute(page, route);
      try {
        await page.getByRole('button', { name: 'Erweitert', exact: true }).click({ timeout: 5000 });
        await sleep(300);
        await page.locator('.react-flow__node').filter({ hasText: label }).first().click({ timeout: 5000 });
        await sleep(400);
        await checkFields(page, `${route} › Seitenleiste „${label}“`, 'aside', new Set());
      } catch (e) {
        failures.push({ where: `${route} › Knoten ${label}`, field: '-', problem: `Knoten nicht wählbar: ${String(e.message).split('\n')[0]}` });
      }
    }
    await gotoRoute(page, route);
    try {
      await page.getByRole('button', { name: 'Erweitert', exact: true }).click({ timeout: 5000 });
      await page.getByRole('button', { name: 'Liste (Tastatur, Handy)' }).click({ timeout: 5000 });
      await sleep(300);
      await checkFields(page, `${route} › Listenansicht`, 'main', new Set());
      await page.getByRole('button', { name: 'Bearbeiten' }).nth(1).click({ timeout: 5000 });
      await sleep(300);
      await checkFields(page, `${route} › Listenansicht › Seitenleiste`, 'aside', new Set());
    } catch (e) {
      failures.push({ where: `${route} › Listenansicht`, field: '-', problem: String(e.message).split('\n')[0] });
    }
    for (const [r, name] of [['/workflows/eingaenge', 'Neuer Eingang'], ['/workflows/ausgaenge', 'Neuer Ausgang']]) {
      const kinds = r.endsWith('eingaenge') ? ['FE2-Alarm', 'Amtliche Warnung', 'RSS-Eintrag', 'Neue Uploads', 'Zeitplan', 'Manueller Start'] : ['Banner', 'Beitrag', 'E-Mail', 'App-Benachrichtigung', 'Warnentwurf vorbereiten'];
      for (const k of kinds) {
        await gotoRoute(page, r);
        try {
          await page.getByRole('button', { name }).click({ timeout: 5000 });
          await page.locator('[role=dialog] button', { hasText: k }).first().click({ timeout: 5000 });
          await sleep(400);
          if (k === 'Manueller Start') await page.locator('[role=dialog]').getByRole('button', { name: 'Feld hinzufügen' }).click().catch(() => {});
          await checkFields(page, `${r} › Dialog „${k}“`, '[role=dialog]', new Set());
        } catch (e) {
          failures.push({ where: `${r} › ${k}`, field: '-', problem: `Dialog nicht geöffnet: ${String(e.message).split('\n')[0]}` });
        }
        await closeDialogs(page, r);
      }
    }
  }

  // Befehlspalette (Strg+K)
  await gotoRoute(page, '/');
  await page.keyboard.press('Control+k');
  await sleep(400);
  if (await dialogOpen(page)) await checkFields(page, 'Befehlspalette', '[role=dialog]', new Set());
  else await checkFields(page, 'Befehlspalette', null, new Set());

  // Handy-Ansicht: Navigation als Schublade, einige Seiten erneut
  const mob = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mob.addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
  const mp = await mob.newPage();
  mp.on('dialog', (d) => d.accept().catch(() => {}));
  seenGlobal.clear();
  for (const r of [`/beitraege/${post.id}`, '/profil', `/medien/${col.collection.id}`, '/medien/gestaltung', ...(warn ? [`/warnungen/${warn.id}`] : []), ...(conn ? [`/verbindungen/${conn.id}?ansicht=empfangsprotokoll`] : []), ...(st.automationId ? [`/workflows/${st.automationId}`] : [])]) await scanRoute(mp, r, { buttons: false });

  const uniqueFields = new Set(tested.map((t) => `${t.where}|${t.field}`)).size;
  const where = new Set(tested.map((t) => t.where)).size;
  fs.writeFileSync(path.join(OUT, 'focus-report.json'), JSON.stringify({ finished: new Date().toISOString(), tested, failures }, null, 2));
  console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${uniqueFields} Felder in ${where} Ansichten/Dialogen geprüft, ${failures.length} Fehler – Bericht: test/e2e/out/focus-report.json`);
  exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  if (churn) clearInterval(churn);
  rss?.close();
  await browser.close();
  process.exit(exitCode);
}
