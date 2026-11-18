/**
 * Dashboard anpassen: Verschieben mit Maus, Finger (Touch-Emulation) und Tastatur, Abbrechen, Speichern, Vorlagen.
 *
 * Prüft im echten Browser, dass
 *  - Kacheln sich am Griff innerhalb einer Spalte und zwischen Spalten verschieben lassen, Kennzahlen in ihrer Reihe
 *    und ganze Spalten untereinander – jeweils mit Maus, Touch und Tastatur,
 *  - Escape ein laufendes Verschieben zurücknimmt und „Abbrechen“ exakt den Stand vor dem Bearbeiten zeigt,
 *  - Spaltenbreite, „Spalte hinzufügen“, Löschen leerer Spalten, Aus-/Einblenden funktionieren,
 *  - „Für mich speichern“ alles in einem Aufruf speichert, „Standard wiederherstellen“ und Vorlagen funktionieren,
 *  - die Seite dabei nie waagerecht überläuft (Desktop, Tablet, Handy; hell und dunkel).
 *
 * Voraussetzung: laufende Instanz mit den Testdaten des Fokus-Tests (`test/e2e/out/focus-state.json`, also zuerst
 * `node test/e2e/focus-check.mjs`) und Playwright mit Chromium. Aufruf aus dem Repository-Wurzelverzeichnis:
 *   BLAULICHTCMS_URL=http://localhost:7310 node test/e2e/dashboard-dnd.mjs
 * `CHROMIUM_PATH` wählt ein vorhandenes Chromium, `DND_SHOTS=<Ordner>` legt Bildschirmfotos ab.
 * Der Test ändert nur das Dashboard-Layout des Test-Admins und stellt den Ausgangszustand wieder her.
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
const SHOTS = process.env.DND_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ADMIN = { email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Zustand des Bearbeitungsmodus aus dem DOM: Kennzahlen-Reihenfolge, Spalten (Breite + Kacheln). */
const editState = (page) =>
  page.evaluate(() => ({
    badges: [...document.querySelectorAll('[data-dash-badge]')].map((e) => e.getAttribute('data-dash-badge')),
    columns: [...document.querySelectorAll('[data-dash-column]')].map((c) => ({
      weight: Number(c.querySelector('select')?.value),
      widgets: [...c.querySelectorAll('[data-dash-widget]')].map((e) => e.getAttribute('data-dash-widget')),
    })),
  }));

/** Zustand der normalen Ansicht aus dem DOM. */
const viewState = (page) =>
  page.evaluate(() => ({
    badges: [...document.querySelectorAll('section[aria-label="Kennzahlen"] [data-dash-tile]')].map((e) => e.getAttribute('data-dash-tile')),
    columns: [...document.querySelectorAll('[data-dash-view-column]')].map((c) => ({
      weight: Number(c.getAttribute('data-dash-view-column')),
      widgets: [...c.querySelectorAll('[data-dash-tile]')].map((e) => e.getAttribute('data-dash-tile')),
    })),
  }));

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));

const handle = (page, kind, id) => page.locator(kind === 'column' ? `[data-dash-column]:nth-of-type(${id}) > div:first-child [data-dash-handle]` : `[data-dash-${kind}="${id}"] [data-dash-handle]`).first();
async function center(loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Zielpunkt in einem Element: Anteil der Breite/Höhe (0–1). */
async function pointIn(loc, fx = 0.5, fy = 0.5) {
  const b = await loc.boundingBox();
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

async function mouseDrag(page, fromLoc, target) {
  const a = await center(fromLoc);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 6, a.y + 6, { steps: 3 });
  const b = await target();
  await page.mouse.move(b.x, b.y, { steps: 14 });
  await sleep(150);
  await page.mouse.up();
  await sleep(200);
}

/** Finger-Geste über das DevTools-Protokoll (echte Touch-Ereignisse, keine Maus). */
async function touchDrag(page, cdp, fromLoc, target) {
  const a = await center(fromLoc);
  const pt = (p) => [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a) });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt({ x: a.x + 6, y: a.y + 6 }) });
  const b = await target();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }) });
    await sleep(16);
  }
  await sleep(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
}

async function keyDrag(page, fromLoc, keys, end = 'Space') {
  await fromLoc.focus();
  await page.keyboard.press('Space');
  await sleep(150);
  for (const k of keys) {
    await page.keyboard.press(k);
    await sleep(200);
  }
  await page.keyboard.press(end);
  await sleep(250);
}

async function openEditor(page) {
  await page.goto(BC + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-dash-tile]').first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Dashboard anpassen' }).click();
  await page.locator('[data-dash-columns]').waitFor({ timeout: 10000 });
  await sleep(300);
}
const widgetLoc = (page, id) => page.locator(`[data-dash-widget="${id}"]`);
const columnLoc = (page, n) => page.locator(`[data-dash-column]:nth-of-type(${n})`);
const colOf = (st, id) => st.columns.findIndex((c) => c.widgets.includes(id));

if (!fs.existsSync(STATE)) throw new Error(`${STATE} fehlt – zuerst den Fokus-Test gegen dieselbe Instanz ausführen`);
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const admin = await login(new Api(), ADMIN.email, ADMIN.password, st.adminSecret);
const cookies = admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC }));
const START = {
  badges: ['badge_approvals', 'badge_unreviewed', 'badge_ready', 'badge_banners', 'badge_uploads', 'badge_connection_errors'],
  columns: [
    { weight: 5, widgets: ['media', 'publications', 'rss'] },
    { weight: 3, widgets: ['approvals', 'uploads', 'banners', 'sites'] },
  ],
  mobile: ['approvals', 'ready', 'uploads', 'publications', 'banners'],
};
const resetLayout = async () => {
  await admin.put('/dashboard/layout', { scope: 'all', layout: null });
  await admin.put('/dashboard/layout', { scope: 'personal', layout: START });
};
await resetLayout();
const startView = { badges: START.badges, columns: START.columns };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let exitCode = 1;
try {
  /* ------------------------------------------------ Maus (Desktop) ------------------------------------------------ */
  console.log('▶ Maus (1440 × 1000)');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(BC + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-dash-tile]').first().waitFor({ timeout: 10000 });
  await sleep(500);
  check('Ansicht zeigt Kennzahlen und Spalten des gespeicherten Layouts', same(await viewState(page), startView), JSON.stringify(await viewState(page)));
  check('Ansicht läuft nicht waagerecht über', await noOverflow(page));
  await shot(page, '01-ansicht-hell');

  await openEditor(page);
  check('Bearbeitungsmodus zeigt denselben Stand', same(await editState(page), startView), JSON.stringify(await editState(page)));
  check('Bearbeitungsmodus läuft nicht waagerecht über', await noOverflow(page));
  check('Griffe haben eine Beschriftung', (await page.locator('[data-dash-handle]:not([aria-label])').count()) === 0 && (await page.getByRole('button', { name: 'Kachel „Offene Freigaben“ verschieben' }).count()) === 1);
  await shot(page, '02-bearbeiten-hell');

  // Links in der Kachel bleiben bedienbar: der Kachelkörper startet kein Ziehen
  // Kachel-Titel sind seit #267 h2 (Card)
  const body = widgetLoc(page, 'approvals').locator('h2').first();
  const bb = await center(body);
  await page.mouse.move(bb.x, bb.y);
  await page.mouse.down();
  await page.mouse.move(bb.x - 500, bb.y + 60, { steps: 10 });
  await page.mouse.up();
  check('Ziehen am Kachelkörper verschiebt nichts (nur der Griff zieht)', same(await editState(page), startView));

  await mouseDrag(page, handle(page, 'widget', 'approvals'), () => pointIn(widgetLoc(page, 'publications'), 0.5, 0.2));
  let s = await editState(page);
  check('Maus: Kachel in eine andere Spalte', colOf(s, 'approvals') === 0 && s.columns[0].widgets.indexOf('approvals') === 1, JSON.stringify(s.columns));
  await mouseDrag(page, handle(page, 'widget', 'sites'), () => pointIn(widgetLoc(page, 'uploads'), 0.5, 0.3));
  s = await editState(page);
  check('Maus: Kachel innerhalb der Spalte', same(s.columns[1].widgets, ['sites', 'uploads', 'banners']), JSON.stringify(s.columns[1]));
  await mouseDrag(page, handle(page, 'badge', 'badge_approvals'), () => pointIn(page.locator('[data-dash-badge="badge_ready"]'), 0.6, 0.5));
  s = await editState(page);
  check('Maus: Kennzahl in der Reihe', s.badges.indexOf('badge_approvals') === 2, JSON.stringify(s.badges));
  await mouseDrag(page, handle(page, 'column', 1), () => pointIn(columnLoc(page, 2), 0.7, 0.1));
  s = await editState(page);
  check('Maus: Spalte verschieben', s.columns[0].weight === 3 && s.columns[1].weight === 5 && s.columns[1].widgets.includes('media'), JSON.stringify(s.columns));

  // Spaltenbreite, Spalte hinzufügen, in leere Spalte ziehen, leere Spalte löschen
  await page.getByLabel('Breite von Spalte 1').selectOption('2');
  check('Breite wählen (Schmal)', (await editState(page)).columns[0].weight === 2);
  check('Gefüllte Spalte lässt sich nicht löschen', await page.getByRole('button', { name: 'Spalte 1 löschen' }).isDisabled());
  await page.getByRole('button', { name: 'Spalte hinzufügen' }).click();
  await page.getByRole('button', { name: 'Spalte hinzufügen' }).click();
  s = await editState(page);
  check('Spalte hinzufügen (höchstens vier)', s.columns.length === 4 && (await page.getByRole('button', { name: 'Spalte hinzufügen' }).isDisabled()));
  await mouseDrag(page, handle(page, 'widget', 'rss'), () => pointIn(page.locator('[data-dash-column]:nth-of-type(3) [data-dash-slot]'), 0.5, 0.5));
  s = await editState(page);
  check('Maus: Kachel in eine leere Spalte', same(s.columns[2].widgets, ['rss']), JSON.stringify(s.columns));
  check('Spalte mit Kachel lässt sich nicht löschen', await page.getByRole('button', { name: 'Spalte 3 löschen' }).isDisabled());
  await page.getByRole('button', { name: 'Spalte 4 löschen' }).click();
  check('Leere Spalte löschen', (await editState(page)).columns.length === 3);
  check('Vier/drei Spalten laufen nicht über', await noOverflow(page));
  await shot(page, '03-bearbeiten-drei-spalten');

  // Ausblenden und über den Katalog wieder einblenden
  await page.getByRole('button', { name: 'Kachel „Websites“ ausblenden' }).click();
  await page.getByRole('button', { name: 'Kennzahl „Aktive Banner“ ausblenden' }).click();
  s = await editState(page);
  check('Ausblenden entfernt Kachel und Kennzahl', colOf(s, 'sites') === -1 && !s.badges.includes('badge_banners'));
  await page.getByRole('button', { name: 'Kachel „Websites“ hinzufügen' }).click();
  await page.getByRole('button', { name: 'Kennzahl „Aktive Banner“ hinzufügen' }).click();
  s = await editState(page);
  check('Katalog blendet wieder ein (letzte Spalte, Ende der Reihe)', s.columns[2].widgets.includes('sites') && s.badges.at(-1) === 'badge_banners', JSON.stringify(s));

  // Abbrechen stellt exakt den Ausgangszustand her – ohne Speichern
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await page.locator('[data-dash-view-column]').first().waitFor({ timeout: 5000 });
  check('Abbrechen: Ansicht exakt wie vor dem Bearbeiten', same(await viewState(page), startView), JSON.stringify(await viewState(page)));
  const srv = (await admin.get('/dashboard/layout')).layout;
  check('Abbrechen: nichts gespeichert', same({ badges: srv.badges, columns: srv.columns, mobile: srv.mobile }, START));
  await page.getByRole('button', { name: 'Dashboard anpassen' }).click();
  await page.locator('[data-dash-columns]').waitFor();
  check('Abbrechen: erneutes Bearbeiten beginnt beim gespeicherten Stand', same(await editState(page), startView));

  /* ------------------------------------------------ Tastatur ------------------------------------------------ */
  console.log('▶ Tastatur');
  await keyDrag(page, handle(page, 'widget', 'media'), ['ArrowDown']);
  s = await editState(page);
  check('Tastatur: Kachel in der Spalte nach unten', same(s.columns[0].widgets, ['publications', 'media', 'rss']), JSON.stringify(s.columns[0]));
  check('Tastatur: Fokus bleibt nach dem Ablegen am Griff', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Kachel „Redaktionsfluss“ verschieben'));
  await keyDrag(page, handle(page, 'widget', 'publications'), ['ArrowRight']);
  s = await editState(page);
  check('Tastatur: Kachel in die andere Spalte', colOf(s, 'publications') === 1, JSON.stringify(s.columns));
  await keyDrag(page, handle(page, 'badge', 'badge_approvals'), ['ArrowRight']);
  s = await editState(page);
  check('Tastatur: Kennzahl nach rechts', s.badges.indexOf('badge_approvals') === 1, JSON.stringify(s.badges));
  await keyDrag(page, handle(page, 'column', 1), ['ArrowRight']);
  s = await editState(page);
  check('Tastatur: Spalte nach rechts', s.columns[0].weight === 3 && s.columns[1].weight === 5, JSON.stringify(s.columns));
  const beforeEsc = await editState(page);
  await keyDrag(page, handle(page, 'widget', 'uploads'), ['ArrowLeft', 'ArrowDown'], 'Escape');
  check('Tastatur: Escape nimmt das laufende Verschieben zurück', same(await editState(page), beforeEsc), JSON.stringify(await editState(page)));
  check('Escape beendet nicht den Bearbeitungsmodus', (await page.locator('[data-dash-columns]').count()) === 1);
  // Fokus sichtbar am Griff (Tastaturbedienung)
  await handle(page, 'widget', 'uploads').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await handle(page, 'widget', 'uploads').evaluate((el) => {
    const c = getComputedStyle(el);
    return el.matches(':focus-visible') && (c.outlineStyle !== 'none' || c.boxShadow !== 'none');
  });
  check('Fokus am Griff ist sichtbar', ring);
  await shot(page, '04-bearbeiten-tastatur-fokus');

  // Speichern: alles in einem Aufruf
  const puts = [];
  page.on('request', (r) => r.method() === 'PUT' && r.url().endsWith('/dashboard/layout') && puts.push(r.postDataJSON()));
  const expected = await editState(page);
  await page.getByRole('button', { name: 'Für mich speichern' }).click();
  await page.locator('[data-dash-view-column]').first().waitFor({ timeout: 8000 });
  await sleep(400);
  check('Speichern: ein einziger Aufruf mit dem ganzen Layout', puts.length === 1 && puts[0].scope === 'personal' && same(puts[0].layout.columns, expected.columns) && same(puts[0].layout.badges, expected.badges), JSON.stringify(puts));
  check('Speichern: Ansicht zeigt den neuen Stand', same(await viewState(page), expected), JSON.stringify(await viewState(page)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-dash-tile]').first().waitFor();
  await sleep(400);
  check('Speichern: Stand bleibt nach dem Neuladen', same(await viewState(page), expected));

  // Dunkel
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await shot(page, '05-ansicht-dunkel');
  await page.getByRole('button', { name: 'Dashboard anpassen' }).click();
  await page.locator('[data-dash-columns]').waitFor();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await shot(page, '06-bearbeiten-dunkel');

  // Vorlage für alle speichern und wieder entfernen (Administration)
  await page.locator('#dash-template-target').selectOption('*');
  await page.getByRole('button', { name: 'Als Dashboard-Vorlage speichern' }).click();
  await sleep(700);
  check('Vorlage für alle gespeichert', same((await admin.get('/dashboard/layout')).templates, ['*']));
  check('Bearbeitungsmodus bleibt nach dem Speichern der Vorlage offen', (await page.locator('[data-dash-columns]').count()) === 1);
  await page.getByRole('button', { name: 'Dashboard-Vorlage entfernen' }).click();
  await sleep(700);
  check('Vorlage entfernt', same((await admin.get('/dashboard/layout')).templates, []));
  // Standard wiederherstellen: persönliche Anpassung weg, es gilt die mitgelieferte Standardansicht der Rolle (#254)
  await page.getByRole('button', { name: 'Standard wiederherstellen' }).click();
  await page.locator('[data-dash-view-column]').first().waitFor({ timeout: 8000 });
  await sleep(400);
  const def = await admin.get('/dashboard/layout');
  const dv = await viewState(page);
  const defPanels = def.layout.columns.flatMap((c) => c.widgets).filter((id) => id !== 'setup');
  check(
    'Standard wiederherstellen: Standardansicht der Administration gilt wieder',
    def.source === 'default' && def.profile === 'platform_admin' && same(dv.badges, def.layout.badges) && same(dv.columns.flatMap((c) => c.widgets).filter((id) => id !== 'setup'), defPanels),
    JSON.stringify(dv),
  );
  check('Keine Fehler in der Browser-Konsole (Desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  /* ------------------------------------------------ Touch (Tablet quer) ------------------------------------------------ */
  console.log('▶ Touch (1180 × 820, Finger)');
  await resetLayout();
  const tctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await tctx.addCookies(cookies);
  const tp = await tctx.newPage();
  const terrors = [];
  tp.on('pageerror', (e) => terrors.push(String(e.message)));
  const cdp = await tctx.newCDPSession(tp);
  await openEditor(tp);
  check('Touch: Ausgangszustand', same(await editState(tp), startView), JSON.stringify(await editState(tp)));
  await touchDrag(tp, cdp, handle(tp, 'widget', 'approvals'), () => pointIn(widgetLoc(tp, 'publications'), 0.5, 0.2));
  s = await editState(tp);
  // Die genaue Stelle hängt am Tablet vom automatischen Mitscrollen ab – entscheidend ist der Spaltenwechsel
  check('Touch: Kachel in eine andere Spalte', colOf(s, 'approvals') === 0 && s.columns[1].widgets.length === 3, JSON.stringify(s.columns));
  await touchDrag(tp, cdp, handle(tp, 'widget', 'sites'), () => pointIn(widgetLoc(tp, 'uploads'), 0.5, 0.3));
  s = await editState(tp);
  check('Touch: Kachel innerhalb der Spalte', same(s.columns[1].widgets, ['sites', 'uploads', 'banners']), JSON.stringify(s.columns[1]));
  await touchDrag(tp, cdp, handle(tp, 'badge', 'badge_approvals'), () => pointIn(tp.locator('[data-dash-badge="badge_ready"]'), 0.6, 0.5));
  s = await editState(tp);
  check('Touch: Kennzahl in der Reihe', s.badges.indexOf('badge_approvals') === 2, JSON.stringify(s.badges));
  await touchDrag(tp, cdp, handle(tp, 'column', 1), () => pointIn(columnLoc(tp, 2), 0.7, 0.05));
  s = await editState(tp);
  check('Touch: Spalte verschieben', s.columns[0].weight === 3 && s.columns[1].weight === 5, JSON.stringify(s.columns));
  await shot(tp, '07-touch-tablet');
  await tp.getByRole('button', { name: 'Abbrechen', exact: true }).tap();
  await tp.locator('[data-dash-view-column]').first().waitFor({ timeout: 5000 });
  check('Touch: Abbrechen stellt den Ausgangszustand her', same(await viewState(tp), startView), JSON.stringify(await viewState(tp)));
  check('Keine Fehler in der Browser-Konsole (Touch)', terrors.length === 0, terrors.slice(0, 3).join(' | '));
  await tctx.close();

  /* ------------------------------------------------ Handy ------------------------------------------------ */
  console.log('▶ Handy (390 × 844, Finger)');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await mctx.addCookies(cookies);
  const mp = await mctx.newPage();
  const mcdp = await mctx.newCDPSession(mp);
  await mp.goto(BC + '/', { waitUntil: 'domcontentloaded' });
  await mp.locator('[data-dash-tile]').first().waitFor({ timeout: 10000 });
  await sleep(400);
  const mobileTiles = await mp.evaluate(() => [...document.querySelectorAll('[data-dash-tile]')].map((e) => e.getAttribute('data-dash-tile')).filter((id) => !id.startsWith('badge_')));
  check('Handy: eigene Reihenfolge untereinander', same(mobileTiles, START.mobile), JSON.stringify(mobileTiles));
  check('Handy: Ansicht läuft nicht über', await noOverflow(mp));
  await shot(mp, '08-handy-ansicht');
  await mp.getByRole('button', { name: 'Dashboard anpassen' }).tap();
  await mp.locator('[data-dash-columns]').waitFor({ timeout: 10000 });
  await sleep(300);
  check('Handy: Bearbeitungsmodus läuft nicht über', await noOverflow(mp));
  const stacked = await mp.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('[data-dash-column]')].map((c) => c.getBoundingClientRect());
    return b.top >= a.bottom - 1 && Math.abs(a.left - b.left) < 2;
  });
  check('Handy: Spalten stehen untereinander', stacked);
  await touchDrag(mp, mcdp, handle(mp, 'widget', 'rss'), () => pointIn(widgetLoc(mp, 'publications'), 0.5, 0.75));
  s = await editState(mp);
  check('Handy: Kachel per Finger in der Spalte verschoben', same(s.columns[0].widgets, ['media', 'rss', 'publications']), JSON.stringify(s.columns[0]));
  // Reihenfolge fürs Handy: Pfeile
  await mp.getByRole('button', { name: 'Neue Uploads auf dem Handy nach oben' }).tap();
  await mp.getByRole('button', { name: 'Aktive Banner auf dem Handy nicht zeigen' }).tap();
  await mp.getByRole('button', { name: 'Quellen (RSS) auf dem Handy zeigen' }).tap();
  await shot(mp, '09-handy-bearbeiten');
  await mp.getByRole('button', { name: 'Für mich speichern' }).tap();
  await mp.locator('[data-dash-tile]').first().waitFor({ timeout: 8000 });
  await sleep(500);
  const saved = (await admin.get('/dashboard/layout')).layout;
  check('Handy: Reihenfolge gespeichert', same(saved.mobile, ['approvals', 'uploads', 'ready', 'publications', 'rss']), JSON.stringify(saved.mobile));
  check('Handy: Spaltenänderung mitgespeichert', same(saved.columns[0].widgets, ['media', 'rss', 'publications']));
  await mctx.close();

  await admin.put('/dashboard/layout', { scope: 'personal', layout: null });
  console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${passed} Prüfungen bestanden, ${failures.length} Fehler${failures.length ? `: ${failures.join('; ')}` : ''}`);
  exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  await browser.close();
  process.exit(exitCode);
}
