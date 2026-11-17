/**
 * Sichtung (#261): Die Entscheidungsknöpfe „Überspringen“, „Zurückstellen“ und „Auswählen“ müssen ohne Scrollen
 * sichtbar sein – am Laptop (1366 × 768), am Desktop (1440 × 900) und am Handy (390 × 844), für Fotos im Quer- und
 * Hochformat und für Videos. Zusätzlich: Tastatur (→ ← ↓) und Wischen am Handy schalten weiter.
 *
 * Ablauf: Drei Bilder (quer, hoch, hoch) über einen neuen Upload-Link der Testsammlung hochladen. Im Browser wird die Antwort
 * der Sammlung so umgeschrieben, dass genau diese drei Dateien offen sind und die dritte als Video erscheint (der
 * Player zeigt dann das Hochformat-Vorschaubild als Standbild – lokal ohne ffmpeg reproduzierbar). Entscheidungen
 * werden abgefangen und nicht gespeichert; die Instanz bleibt unverändert bis auf die drei hochgeladenen Dateien.
 *
 * Voraussetzung: laufende Instanz mit den Testdaten des Fokus-Tests (`test/e2e/out/focus-state.json`, also zuerst
 * `node test/e2e/focus-check.mjs`) und Playwright mit Chromium. Aufruf aus dem Repository-Wurzelverzeichnis:
 *   BLAULICHTCMS_URL=http://localhost:7310 node test/e2e/review-layout.mjs
 * `CHROMIUM_PATH` wählt ein vorhandenes Chromium, `REVIEW_SHOTS=<Ordner>` legt Bildschirmfotos ab.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Api, login, sleep } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharp = createRequire(path.join(ROOT, 'server/package.json'))('sharp');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const STATE = path.join(ROOT, 'test/e2e/out/focus-state.json');
const SHOTS = process.env.REVIEW_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ADMIN = { email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };
const BUTTONS = ['Überspringen', 'Zurückstellen', 'Auswählen'];

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

/** Testbild mit Motiv (Fläche + Balken), damit die Vorschau nicht einfarbig ist. */
async function photo(width, height, seed) {
  const bar = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="rgb(${60 + seed * 40},120,170)"/><rect x="${width / 4}" y="${height / 3}" width="${width / 2}" height="${height / 4}" fill="#c33"/></svg>`);
  return sharp(bar).jpeg({ quality: 80 }).toBuffer();
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
const colId = st.collectionId;

// 1) Drei Dateien über einen eigenen Upload-Link (der Link der Testdaten kann im Fokus-Test pausiert worden sein)
const link = await admin.post(`/collections/${colId}/links`, { label: 'Sichtungstest' });
const uploadToken = link.url.split('/u/')[1];
const files = [
  ['sichtung-quer.jpg', 1600, 1067],
  ['sichtung-hoch.jpg', 1067, 1600],
  ['sichtung-video.jpg', 1080, 1920],
];
for (const [name, w, h] of files) {
  const fd = new FormData();
  fd.append('file', new Blob([await photo(w, h, files.findIndex((f) => f[0] === name))], { type: 'image/jpeg' }), name);
  const r = await fetch(`${BC}/api/v1/public/upload/${uploadToken}`, { method: 'POST', body: fd, headers: { 'x-blaulichtcms-request': '1' } });
  if (!r.ok) throw new Error(`Upload ${name}: ${r.status} ${await r.text()}`);
}
let items = [];
for (let i = 0; i < 60; i++) {
  const d = await admin.get(`/collections/${colId}`);
  items = files.map(([name]) => d.media.filter((m) => m.original_name === name).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]);
  if (items.every((m) => m?.status === 'ready' && m.has_preview)) break;
  await sleep(1000);
}
if (!items.every((m) => m?.status === 'ready' && m.has_preview)) throw new Error(`Dateien nicht bereit: ${items.map((m) => m?.status).join(', ')}`);
console.log('✔ Testdateien hochgeladen und geprüft');
const ids = items.map((m) => m.id);
const videoId = ids[2];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const cookies = admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC }));

/** Sammlung so umschreiben, dass genau die drei Testdateien offen sind; die dritte erscheint als Video. */
async function prepare(ctx) {
  await ctx.route(`**/api/v1/collections/${colId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.media = body.media
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((m) => ({ ...m, selection: 'pending', ...(m.id === videoId ? { kind: 'video', has_public: true, mime: 'video/mp4' } : {}) }));
    await route.fulfill({ response: res, json: body });
  });
  // Kein echtes Video: der Player zeigt das Vorschaubild (Hochformat) als Standbild
  await ctx.route(`**/api/v1/media/${videoId}/public*`, (route) => route.fulfill({ status: 404, body: '' }));
  // Entscheidungen nicht speichern
  await ctx.route('**/api/v1/media/selection', (route) => route.fulfill({ status: 200, json: { versions: {} } }));
}

/** Lage der drei Knöpfe: ganz im Fenster und im sichtbaren Teil des Dialogs (nicht weggescrollt). */
async function measure(page) {
  return page.evaluate((names) => {
    const dlg = document.querySelector('[role=dialog]');
    const d = dlg.getBoundingClientRect();
    const out = {};
    for (const n of names) {
      const b = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === n);
      if (!b) {
        out[n] = null;
        continue;
      }
      const r = b.getBoundingClientRect();
      // sichtbar, wenn nicht von einem scrollenden Vorfahren abgeschnitten
      let clipped = false;
      for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(s.overflowY)) {
          const pr = p.getBoundingClientRect();
          if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) clipped = true;
        }
      }
      out[n] = { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), clipped, inViewport: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.bottom <= d.bottom + 0.5 };
    }
    const media = dlg.querySelector('video, img');
    const m = media?.getBoundingClientRect();
    return { buttons: out, media: m ? { tag: media.tagName.toLowerCase(), width: Math.round(m.width), height: Math.round(m.height) } : null, overflowX: dlg.scrollWidth > dlg.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1, title: dlg.querySelector('h2')?.textContent ?? '' };
  }, BUTTONS);
}

async function waitMedia(page) {
  await page
    .waitForFunction(() => {
      const v = document.querySelector('[role=dialog] video');
      if (v) return v.getBoundingClientRect().height > 50;
      const i = document.querySelector('[role=dialog] img');
      return !!i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 10_000 })
    .catch(() => {});
  await sleep(150);
}

const VIEWPORTS = [
  { name: 'Laptop 1366 × 768', viewport: { width: 1366, height: 768 } },
  { name: 'Desktop 1440 × 900', viewport: { width: 1440, height: 900 } },
  { name: 'Handy 390 × 844', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
];
const LABELS = ['Querformat', 'Hochformat', 'Video (Hochformat)'];
const results = [];

try {
  for (const vp of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      if (scheme === 'dark' && vp.viewport.width !== 1366) continue;
      console.log(`\n${vp.name}${scheme === 'dark' ? ' (dunkel)' : ''}`);
      const ctx = await browser.newContext({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile, locale: 'de-DE', colorScheme: scheme });
      await ctx.addCookies(cookies);
      await prepare(ctx);
      const page = await ctx.newPage();
      await page.goto(`${BC}/medien/${colId}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /^3 sichten$/ }).click({ timeout: 10_000 });
      await page.locator('[role=dialog]').waitFor();
      for (let i = 0; i < 3; i++) {
        await page.getByRole('heading', { name: `Sichten · ${i + 1} von 3` }).waitFor({ timeout: 5000 });
        await waitMedia(page);
        const m = await measure(page);
        results.push({ viewport: vp.name, scheme, file: LABELS[i], ...m });
        const bad = BUTTONS.filter((n) => !m.buttons[n] || m.buttons[n].clipped || !m.buttons[n].inViewport);
        check(`${LABELS[i]}: Knöpfe ohne Scrollen sichtbar`, !bad.length, bad.map((n) => `${n}: ${JSON.stringify(m.buttons[n])}`).join('; '));
        check(`${LABELS[i]}: Vorschau sichtbar (${m.media?.tag} ${m.media?.width} × ${m.media?.height})`, !!m.media && m.media.height >= (vp.viewport.width < 600 ? 150 : 300), JSON.stringify(m.media));
        if (i === 2) check(`${LABELS[i]}: als Video-Player dargestellt`, m.media?.tag === 'video');
        check(`${LABELS[i]}: kein waagerechtes Überlaufen`, !m.overflowX);
        if (vp.isMobile) check(`${LABELS[i]}: Knöpfe mindestens 44 px hoch`, BUTTONS.every((n) => (m.buttons[n]?.height ?? 0) >= 44), BUTTONS.map((n) => m.buttons[n]?.height).join('/'));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sichtung-${vp.viewport.width}x${vp.viewport.height}-${scheme}-${i + 1}.png`) });
        // Weiter: am Desktop per Tastatur, am Handy abwechselnd Wischen und Knopf
        if (!vp.isMobile) {
          await page.locator('[role=dialog] h2').click();
          await page.keyboard.press(['ArrowLeft', 'ArrowDown', 'ArrowRight'][i]);
        } else if (i === 0) {
          await page.evaluate(() => {
            const el = document.querySelector('[role=dialog] .touch-pan-y');
            const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
            el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(80)], changedTouches: [t(80)] }));
            el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(300)] }));
          });
        } else {
          await page.getByRole('button', { name: BUTTONS[i === 1 ? 1 : 2], exact: true }).click();
        }
      }
      await page.getByText('Alle Dateien gesichtet.').waitFor({ timeout: 5000 });
      check(vp.isMobile ? 'Wischen und Knöpfe schalten weiter' : 'Tastatur (← ↓ →) schaltet weiter', true);
      await ctx.close();
    }
  }
} catch (e) {
  failures.push(String(e?.message ?? e).split('\n')[0]);
  console.log(`  ✘ ${e?.message ?? e}`);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'test/e2e/out/review-layout.json'), JSON.stringify(results, null, 2));
  // Testdateien wieder entfernen (Papierkorb) und den Link widerrufen, damit der Lauf wiederholbar bleibt
  for (const id of ids) await admin.req('DELETE', `/media/${id}`).catch(() => {});
  await admin.post(`/upload-links/${link.id}/revoke`).catch(() => {});
}

console.log(`\n${failures.length ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${passed} Prüfungen bestanden, ${failures.length} fehlgeschlagen – Messwerte: test/e2e/out/review-layout.json`);
process.exit(failures.length ? 1 : 0);
