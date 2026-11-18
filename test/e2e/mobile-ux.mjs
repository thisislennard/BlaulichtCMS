/**
 * Listen und Handy (#260, #264):
 *   1. Filter und Suche stehen in der Adresse; Zurück aus einer Detailseite stellt sie wieder her (Beiträge, Presse).
 *   2. Am Handy (390 × 844) haben alle Bedienelemente eine Trefferfläche von mindestens 40 × 40 px – auf Dashboard,
 *      Beiträgen, Sammlung, Presse, Kalender, Einsatzliste und Warnentwurf. Ausgenommen sind Links mitten im Fließtext
 *      (WCAG 2.5.8); bei Kästchen und Optionsfeldern zählt die Beschriftung mit.
 *   3. Untere Leiste am Handy: Fotos sammeln, Sichten, Freigeben und Warnentwurf mit höchstens zwei Tipps.
 *   4. Presse, Einsatzliste und Beiträge zeigen bei 390 px Karten statt Tabellen, ohne waagerechtes Scrollen.
 *
 * Voraussetzung: laufende Instanz mit den Testdaten des Fokus-Tests (`test/e2e/out/focus-state.json`, also zuerst
 * `node test/e2e/focus-check.mjs`) und Playwright mit Chromium. Aufruf aus dem Repository-Wurzelverzeichnis:
 *   BLAULICHTCMS_URL=http://localhost:7310 node test/e2e/mobile-ux.mjs
 * `CHROMIUM_PATH` wählt ein vorhandenes Chromium, `MOBILE_SHOTS=<Ordner>` legt Bildschirmfotos ab.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Api, login, sleep } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const STATE = path.join(ROOT, 'test/e2e/out/focus-state.json');
const SHOTS = process.env.MOBILE_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ADMIN = { email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };
const MIN = 40;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✘ ${name}${detail ? ` – ${detail}` : ''}`);
  }
}

if (!fs.existsSync(STATE)) throw new Error(`${STATE} fehlt – zuerst den Fokus-Test gegen dieselbe Instanz ausführen`);
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
/** Anmelden; ein Code gilt nur einmal – lief der vorige Test im selben Zeitfenster, auf das nächste warten. */
async function signIn() {
  for (let i = 0; ; i++) {
    try {
      return await login(new Api(), ADMIN.email, ADMIN.password, st.adminSecret);
    } catch (e) {
      if (i >= 2 || !/bereits verwendet/.test(e.message)) throw e;
      await sleep(30_500 - (Date.now() % 30_000));
    }
  }
}
const admin = await signIn();
const cookies = admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC }));

// Testdaten: eine Presseanfrage mit eindeutigem Thema, ein Eintrag der Einsatzliste
const stamp = Date.now().toString(36);
const postRow = await admin.post('/posts', { title: `Listentest ${stamp}`, kind: 'news' });
const press = await admin.post('/press/requests', { topic: `Rückfrage Listentest ${stamp}`, outlet: 'Testzeitung', channel: 'phone', dueAt: new Date(Date.now() - 3_600_000).toISOString() });
await admin.post('/incidents', { alarmAt: new Date().toISOString(), keyword: 'B 2', keywordLabel: 'Brand', category: 'Brand', title: `Listentest ${stamp}`, location: 'Nord' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const go = async (page, route) => {
  await page.goto(`${BC}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
  await sleep(400);
};

let exitCode = 1;
try {
  /* ------------------------------------------------ 1. Zustand in der Adresse, Zurück ------------------------------------------------ */
  console.log('▶ Filter in der Adresse (1440 px)');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    // Beiträge: Reiter „In Arbeit“ + Suche → Beitrag öffnen → Zurück
    await go(page, '/beitraege');
    await page.getByRole('button', { name: /^In Arbeit/ }).click();
    await page.getByRole('searchbox', { name: /Beiträge durchsuchen/ }).fill(`Listentest ${stamp}`);
    await page.waitForURL(/status=arbeit/);
    await page.waitForURL(/suche=Listentest/);
    await sleep(800);
    const first = page.locator(`main table a[href="/beitraege/${postRow.id}"]`);
    check('Beiträge: gefilterte Liste zeigt den Beitrag', (await first.count()) === 1);
    await first.click();
    await page.waitForURL(/\/beitraege\/[0-9a-f-]{36}/);
    await page.goBack();
    await page.waitForURL(/\/beitraege\?/);
    await sleep(500);
    check('Beiträge: Zurück stellt den Reiter wieder her', (await page.getByRole('button', { name: /^In Arbeit/ }).getAttribute('aria-pressed')) === 'true');
    check('Beiträge: Zurück stellt die Suche wieder her', (await page.getByRole('searchbox', { name: /Beiträge durchsuchen/ }).inputValue()) === `Listentest ${stamp}`);
    // Presse: Reiter „Alle“ + Suche → Anfrage öffnen → Zurück
    await go(page, '/presse');
    await page.getByRole('button', { name: /^Alle/ }).click();
    await page.getByRole('searchbox', { name: /Presseanfragen durchsuchen/ }).fill(`Listentest ${stamp}`);
    await page.waitForURL(/filter=all/);
    await sleep(800);
    await page.locator(`main a[href="/presse/${press.id}"]`).click();
    await page.waitForURL(new RegExp(`/presse/${press.id}`));
    await page.goBack();
    await page.waitForURL(/\/presse\?/);
    await sleep(500);
    check('Presse: Zurück stellt den Reiter „Alle“ wieder her', (await page.getByRole('button', { name: /^Alle/ }).getAttribute('aria-pressed')) === 'true');
    check('Presse: Zurück stellt die Suche wieder her', (await page.getByRole('searchbox', { name: /Presseanfragen durchsuchen/ }).inputValue()) === `Listentest ${stamp}`);
    check('Presse: Liste zeigt die gesuchte Anfrage', (await page.locator(`main a[href="/presse/${press.id}"]`).count()) === 1);
    // Link aus Benachrichtigung bzw. Suche öffnet die gefilterte Liste direkt
    await go(page, `/presse?filter=done`);
    check('Presse: ?filter=done wählt „Erledigt“', (await page.getByRole('button', { name: /^Erledigt/ }).getAttribute('aria-pressed')) === 'true');
    // Einsatzliste: eine Zeile je Eintrag ≤ 52 px, keine doppelte Angabe „Brand · Brand“
    await go(page, `/einsatzliste?suche=${encodeURIComponent(`Listentest ${stamp}`)}`);
    const row = page.locator(`main tbody tr`).first();
    const h = (await row.boundingBox())?.height ?? 999;
    check('Einsatzliste: Zeilenhöhe bei 1440 px ≤ 52 px', h <= 52, `${Math.round(h)} px`);
    const kw = await row.locator('td').nth(3).innerText();
    check('Einsatzliste: keine doppelte Angabe „Brand · Brand“', !/Brand · Brand/.test(kw), kw);
    await ctx.close();
  }

  /* ------------------------------------------------ 2.–4. Handy ------------------------------------------------ */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'de-DE', hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  console.log('▶ Touch-Ziele (390 px)');
  const pages = [
    ['Dashboard', '/'],
    ['Beiträge', '/beitraege'],
    ['Sammlung', `/medien/${st.collectionId}`],
    ['Presse', '/presse'],
    ['Kalender', '/kalender'],
    ['Einsatzliste', '/einsatzliste'],
    ['Warnentwurf', `/warnungen/${st.warningId}`],
  ];
  for (const [name, route] of pages) {
    await go(page, route);
    const small = await page.evaluate((min) => {
      const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [tabindex]:not([tabindex="-1"])';
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('[aria-hidden="true"], [inert]')) continue;
        if (el.disabled) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        let r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // Visuell verborgene Felder (sr-only, Dateifeld hinter einem Knopf): bedient wird über Beschriftung/Knopf
        if ((r.width <= 2 && r.height <= 2) || /inset\(50%\)/.test(st.clipPath)) continue;
        // Titel einer Karte (ResponsiveTable): der erste Link bzw. Knopf ist über die ganze Karte gestreckt
        const card = el.closest('.bc-list-card');
        if (card && el.closest('.bc-card-title') && el.closest('.bc-card-title').querySelector('a, button') === el) r = card.getBoundingClientRect();
        // Links mitten im Fließtext sind ausgenommen (WCAG 2.5.8 „inline“)
        if (st.display === 'inline' && el.tagName === 'A') {
          const parent = el.parentElement;
          const text = [...(parent?.childNodes ?? [])].filter((n) => n !== el && n.nodeType === 3 && n.textContent.trim()).length;
          if (text > 0) continue;
        }
        // Kästchen/Optionsfelder: die Beschriftung gehört zur Trefferfläche
        if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) {
          const lbl = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
          if (lbl) {
            const lr = lbl.getBoundingClientRect();
            r = { width: Math.max(r.width, lr.width), height: Math.max(r.height, lr.height) };
          }
        }
        if (r.width + 0.5 < min || r.height + 0.5 < min) {
          const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 50);
          const key = `${label}|${Math.round(r.width)}x${Math.round(r.height)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(`${el.tagName.toLowerCase()} „${label}“ ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      return out;
    }, MIN);
    check(`${name}: alle Bedienelemente ≥ ${MIN} × ${MIN} px`, small.length === 0, small.slice(0, 12).join('; '));
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${name}: kein waagerechtes Scrollen`, sw <= 390, `${sw} px`);
    await shot(page, `touch-${name}`);
  }

  console.log('▶ Karten statt Tabellen (390 px)');
  for (const [name, route, label] of [
    ['Presse', `/presse?filter=all&suche=${encodeURIComponent(`Listentest ${stamp}`)}`, 'Presseanfragen'],
    ['Einsatzliste', `/einsatzliste?suche=${encodeURIComponent(`Listentest ${stamp}`)}`, 'Einträge der Einsatzliste'],
    ['Beiträge', '/beitraege', 'Beiträge'],
  ]) {
    await go(page, route);
    const list = page.getByRole('list', { name: label });
    check(`${name}: Karten statt Tabelle`, (await list.count()) === 1 && (await page.locator('main table').count()) === 0);
    const card = list.locator('li').first();
    const box = await card.boundingBox();
    check(`${name}: Karte passt in die Breite`, !!box && box.x >= 0 && box.x + box.width <= 390, box ? `${Math.round(box.x)}+${Math.round(box.width)}` : 'keine Karte');
    if (name === 'Presse') {
      const text = await card.innerText();
      check('Presse: Karte zeigt Medium, Zuständig und Frist (überfällig)', /Testzeitung/.test(text) && /Zuständig/.test(text) && /überfällig/.test(text), text.replace(/\s+/g, ' '));
    }
    await shot(page, `cards-${name}`);
  }

  console.log('▶ Untere Leiste (390 px)');
  await go(page, '/presse');
  const bar = page.getByRole('navigation', { name: 'Schnellzugriff' });
  check('Leiste sichtbar', await bar.isVisible());
  // Freigeben: ein Tipp
  await bar.getByRole('link', { name: /Freigaben/ }).click();
  await page.waitForURL(/\/freigaben/);
  check('Freigaben mit einem Tipp', true);
  // Fotos sammeln: zwei Tipps (Aktionen → Fotos sammeln öffnet den Dialog)
  await go(page, '/kalender');
  await bar.getByRole('button', { name: 'Aktionen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Schnellaktionen' });
  check('Schnellaktionen enthalten Fotos sammeln, Sichten, Neue Erstmeldung', (await sheet.getByRole('button', { name: /Fotos sammeln/ }).count()) === 1 && (await sheet.getByRole('button', { name: /^Sichten/ }).count()) === 1 && (await sheet.getByRole('button', { name: /Neue Erstmeldung/ }).count()) === 1);
  await sheet.getByRole('button', { name: /Fotos sammeln/ }).click();
  await sleep(600);
  check('Fotos sammeln mit zwei Tipps (Dialog offen)', await page.getByRole('dialog', { name: 'Fotos sammeln' }).isVisible());
  await page.keyboard.press('Escape');
  // Sichten: zwei Tipps (Aktionen → Sammlung mit offenen Dateien bzw. „Sichten“)
  await bar.getByRole('button', { name: 'Aktionen' }).click();
  await sheet.getByRole('button', { name: /^Sichten/ }).click();
  await page.waitForURL(/\/medien\//);
  await sleep(800);
  check('Sichten mit zwei Tipps', /\/medien\/dateien\?sichtung=pending/.test(page.url()) || (await page.getByRole('dialog', { name: /Sichten|Sichtung/ }).count()) > 0, page.url());
  // Leiste respektiert Rechte: „Mehr“ öffnet die Schublade mit allen Bereichen
  await go(page, '/');
  await bar.getByRole('button', { name: 'Mehr' }).click();
  check('„Mehr“ öffnet die Navigation', await page.getByRole('dialog', { name: 'Navigation' }).isVisible());
  await page.keyboard.press('Escape');
  // Beim Tippen tritt die Leiste zurück
  await go(page, '/beitraege');
  await page.getByRole('searchbox', { name: /Beiträge durchsuchen/ }).focus();
  await sleep(200);
  check('Leiste beim Tippen ausgeblendet', !(await bar.isVisible()));
  await ctx.close();
  exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(e);
  failures.push(String(e?.message ?? e));
} finally {
  await browser.close();
  // Testdaten aufräumen
  await admin.req('DELETE', `/press/requests/${press.id}`).catch(() => {});
}
console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${passed} Prüfungen bestanden${failures.length ? `, ${failures.length} fehlgeschlagen` : ''}`);
process.exit(failures.length ? 1 : exitCode);
