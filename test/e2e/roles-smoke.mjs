/**
 * Kurztest „Was man nicht darf, sieht man nicht“ (0.3.0).
 *
 * Legt eine eigene Rolle mit wenigen Rechten an (Medien ansehen und sichten, Beiträge ansehen), meldet ein Konto mit
 * dieser Rolle im Browser an und prüft:
 *   - die Navigation zeigt genau die erlaubten Punkte, Gruppen ohne Punkt fehlen,
 *   - auf den erreichbaren Seiten fehlen die Schaltflächen für nicht erlaubte Aktionen,
 *   - gesperrte Seiten zeigen „Kein Zugriff“,
 *   - die Oberfläche löst beim Rundgang keine einzige abgelehnte Anfrage (403) aus,
 *   - nach dem Erweitern der Rolle erscheinen die neuen Punkte ohne neue Anmeldung.
 *
 * Voraussetzung: laufende Instanz mit den Testdaten des Fokus-Tests (test/e2e/out/focus-state.json), z. B. direkt
 * nach `node test/e2e/focus-check.mjs`. Aufruf: BLAULICHTCMS_URL=http://localhost:7310 node test/e2e/roles-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Api, inviteUser, login, sleep } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/e2e/out/focus-state.json'), 'utf8'));
const ADMIN = { email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };

const failures = [];
let checks = 0;
const check = (cond, msg) => {
  checks++;
  if (!cond) failures.push(msg);
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
};

const admin = await login(new Api(), ADMIN.email, ADMIN.password, st.adminSecret);
admin.reauth = { password: ADMIN.password, totpSecret: st.adminSecret };
const stamp = Date.now().toString(36);
const role = await admin.post('/roles', { label: `Bildsichtung ${stamp}`, description: 'Kurztest', permissions: ['media.review', 'post.view'] });
const user = await inviteUser(admin, `sichtung-${stamp}@example.org`, [role.id], 'Sina Sichtung', 'Sichtung-Testkennwort-2026');
check(JSON.stringify(role.permissions) === JSON.stringify(['media.view', 'media.review', 'post.view']), 'Rolle angelegt, Voraussetzung „Medien ansehen“ automatisch enthalten');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let exitCode = 1;
try {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(user.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
  const page = await ctx.newPage();
  const denied = [];
  page.on('response', (r) => {
    if (r.status() === 403 && r.url().includes('/api/v1/')) denied.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  const go = async (route) => {
    await page.goto(`${BC}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
    await sleep(500);
  };
  const clean = (xs) => [...new Set(xs.map((s) => s.replace(/\s*\d+$/, '').trim()).filter(Boolean))];
  /** Gruppen der Hauptnavigation (obere Zeile) */
  const navGroups = async () => clean(await page.locator('nav[aria-label="Hauptnavigation"]:visible a').allInnerTexts());
  /** Alle Menüpunkte: je Gruppe die zweite Zeile einsammeln */
  const navLabels = async () => {
    const hrefs = await page.locator('nav[aria-label="Hauptnavigation"]:visible a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const out = [];
    for (const h of hrefs) {
      await go(h);
      out.push(...(await page.locator('nav:visible:not([aria-label="Brotkrumen"]) a').allInnerTexts()));
    }
    return clean(out);
  };
  const hasButton = async (name) => (await page.getByRole('button', { name }).count()) > 0;

  await go('/');
  const groups = await navGroups();
  const nav = await navLabels();
  console.log(`  Gruppen: ${groups.join(' | ')}
  Navigation: ${nav.join(' | ')}`);
  check(JSON.stringify(groups) === JSON.stringify(['Übersicht', 'Redaktion']), 'Nur die Gruppen „Übersicht“ und „Redaktion“ – Gruppen ohne erlaubten Punkt entfallen');
  await go('/');
  for (const want of ['Beiträge', 'Medien']) check(nav.includes(want), `Navigation zeigt „${want}“`);
  for (const not of ['Freigaben', 'Quellen', 'Beitragsvorlagen', 'Banner', 'Websites', 'Verbindungen', 'Warnentwürfe', 'Amtliche Warnungen', 'Benutzer und Rollen', 'Systemstatus', 'Protokolle', 'Einstellungen', 'Datenschutzanfragen', 'Aktivitäten', 'Upload-Seite', 'Medienverwaltung'])
    check(!nav.some((n) => n === not || n.startsWith(not)), `Navigation zeigt „${not}“ nicht`);
  const body = await page.locator('body').innerText();
  check(!(await hasButton(/^Neuer Beitrag/)) && !(await hasButton(/^Fotos sammeln/)), 'Dashboard ohne „Neuer Beitrag“ und „Fotos sammeln“');
  check(!/Kein Zugriff/.test(body), 'Dashboard ist erreichbar');

  await go('/beitraege');
  check(!(await hasButton(/^Neuer Beitrag/)), 'Beiträge: keine Schaltfläche „Neuer Beitrag“');
  await go(`/beitraege/${st.postId}`);
  for (const b of [/^Speichern/, /Zur Freigabe einreichen/, /^Freigeben/, /^Veröffentlichen/, /Fotos sammeln/])
    check(!(await hasButton(b)), `Beitrag: keine Schaltfläche ${b}`);

  await go('/medien');
  check(!(await hasButton(/^Neue Sammlung/)), 'Medien: keine Schaltfläche „Neue Sammlung“');
  check((await page.getByRole('link', { name: /Papierkorb|Upload-Seite|Medienverwaltung/ }).count()) === 0, 'Medien: kein Reiter Papierkorb, keine Upload-Seite und Medienverwaltung');
  await go(`/medien/${st.collectionId}`);
  for (const b of [/^Neuer Link/, /^Hochladen/, /^Neuer Ordner/, /ZIP/]) check(!(await hasButton(b)), `Sammlung: keine Schaltfläche ${b}`);
  check(await hasButton(/sichten$/i), 'Sammlung: „Sichten“ ist da (erlaubt)');

  for (const route of ['/benutzer', '/einstellungen', '/medien/papierkorb', '/verbindungen/websites', '/banner', '/verbindungen', '/warnungen', '/protokolle', '/system', '/quellen', '/aktivitaeten', '/datenschutz-anfragen', '/upload-seite', '/medienverwaltung', '/stichwoerter-regeln', '/presse-postfach']) {
    await go(route);
    check(/Kein Zugriff/.test(await page.locator('main, body').first().innerText()), `${route}: „Kein Zugriff“`);
  }
  await go('/hilfe');
  check(!/Kein Zugriff/.test(await page.locator('body').innerText()), 'Hilfe bleibt erreichbar');
  // Befehlspalette: keine verbotenen Aktionen
  await go('/');
  await page.keyboard.press('Control+k');
  await sleep(400);
  // Nur die Trefferliste – die Fußzeile beschreibt den Umfang der Suche („… Einstellungen und Hilfe“)
  const palette = await page.locator('#cmd-list').innerText().catch(() => '');
  check(!/Neuer Beitrag|Fotos sammeln|Website koppeln|Einstellungen|Benutzer/.test(palette), 'Befehlspalette ohne verbotene Aktionen und Seiten');
  await page.keyboard.press('Escape');

  check(denied.length === 0, `Rundgang ohne abgelehnte Anfragen (403)${denied.length ? `: ${[...new Set(denied)].join(', ')}` : ''}`);

  // Rolle erweitern: wirkt ohne neue Anmeldung
  await admin.put(`/roles/${role.id}`, { permissions: ['media.review', 'post.view', 'post.create', 'banner.view'] });
  await go('/');
  await page.goto(`${BC}/beitraege`, { waitUntil: 'networkidle' }).catch(() => {});
  await sleep(500);
  const sub2 = clean(await page.locator('nav:visible:not([aria-label="Brotkrumen"]) a').allInnerTexts());
  check(sub2.includes('Banner'), 'Nach dem Erweitern der Rolle erscheint „Banner“ unter Redaktion ohne neue Anmeldung');
  await go('/banner');
  check(!/Kein Zugriff/.test(await page.locator('body').innerText()), 'Nach dem Erweitern: Banner-Seite ist erreichbar');
  await go('/beitraege');
  check(await hasButton(/^Neuer Beitrag/), 'Nach dem Erweitern: „Neuer Beitrag“ ist da');
  await page.screenshot({ path: path.join(ROOT, 'test/e2e/out/roles-smoke.png') });
  exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  // Aufräumen: Konto und Rolle wieder entfernen
  try {
    const u = (await admin.get('/users')).users.find((x) => x.email === `sichtung-${stamp}@example.org`);
    if (u) await admin.req('DELETE', `/users/${u.id}`, { confirm: u.email });
    await admin.req('DELETE', `/roles/${role.id}`, {});
  } catch (e) {
    console.log(`  (Aufräumen) ${e.message}`);
  }
  await browser.close();
  console.log(`\n${failures.length || exitCode ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${checks} Prüfungen, ${failures.length} Fehler`);
  for (const f of failures) console.log(`  ✘ ${f}`);
  process.exit(exitCode);
}
