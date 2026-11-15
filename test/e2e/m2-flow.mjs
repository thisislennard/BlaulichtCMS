/**
 * Abnahmetest Meilenstein 2 – über Container, Browser und WordPress.
 *
 *  1. Unterbrochener Upload eines größeren Videos im Browser (Teil wird abgebrochen, Upload läuft weiter)
 *  2. QR-Aushang als PDF (A4) – Ausdruck mit echten Geräten bleibt manuell (siehe Testprotokoll)
 *  3. Banner auf der Website: Veröffentlichen, Ablauf bei getrennter Verbindung, zwischengespeicherte Seite
 *  4. RSS-Import mit Vorschau, Themenidee
 *  5. Dashboard aktualisiert sich nach Wiederverbindung (Live-Status)
 *
 * Aufruf: node test/e2e/m2-flow.mjs   (setzt Volumes zurück!)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Api, BC, ROOT, WP, expect, fetchText, freshInstance, freshWordPress, installBridge, inviteUser, makeReport, psql, sh, sleep, wpcli, waitHealthy } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const OUT = path.join(ROOT, 'test/e2e/out/m2');
fs.mkdirSync(OUT, { recursive: true });
const { step, finish } = makeReport(path.join(OUT, 'report.json'));

const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Sicheres-Testkennwort-2026' };
const browser = await chromium.launch();
let ok = true;

/** Browser-Kontext mit Sitzung aus der API übernehmen. */
async function contextFor(api, opts = {}) {
  const ctx = await browser.newContext({ locale: 'de-DE', ...opts });
  await ctx.addCookies(api.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
  return ctx;
}

try {
  let admin;
  let editor;
  let siteId;
  await step('Frische Instanz, Bediener, WordPress mit Bridge', async () => {
    ({ api: admin } = await freshInstance({ admin: ADMIN }));
    editor = await inviteUser(admin, 'redaktion@example.org', ['editor', 'media_manager', 'approver', 'publisher'], 'Robin Redaktion', 'Bediener-Testkennwort-2026');
    await freshWordPress();
    siteId = await installBridge(admin);
    return wpcli('blaulichtcms-bridge status').split('\n')[1].trim();
  });

  /* ---------------------------------------------------- 1. Unterbrochener Upload */
  let uploadLink;
  await step('Großes Video (über mehrere Teile) im Browser hochladen, Verbindungsabbruch in Teil 2', async () => {
    const video = path.join(OUT, 'gross.mp4');
    if (!fs.existsSync(video)) sh(`ffmpeg -v error -y -f lavfi -i testsrc2=duration=12:size=1920x1080:rate=30 -f lavfi -i anoisesrc=duration=12 -c:v libx264 -preset ultrafast -b:v 14M -pix_fmt yuv420p -c:a aac -metadata location="+50.1000+008.6800/" -movflags use_metadata_tags ${video}`);
    const size = fs.statSync(video).size;
    expect(size > 17 * 1024 * 1024, `Testvideo zu klein (${size})`);
    const post = await editor.post('/posts', { title: 'Großübung', kind: 'event' });
    const c = await editor.post(`/posts/${post.id}/collect`, {});
    uploadLink = c.url;
    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' });
    const p = await ctx.newPage();
    let aborted = 0;
    let puts = 0;
    await p.route('**/api/v1/public/upload/*/sessions/*', async (route) => {
      if (route.request().method() === 'PUT') {
        puts++;
        // Zweiter Teil: Verbindung bricht ab (Funkloch)
        if (puts === 2 && !aborted) {
          aborted++;
          return route.abort('connectionreset');
        }
      }
      return route.continue();
    });
    await p.goto(uploadLink);
    await p.setInputFiles('input[aria-label="Fotos oder Videos auswählen"]', video);
    await p.getByRole('button', { name: /Datei(en)? senden/ }).click();
    await p.getByText('Vielen Dank!').waitFor({ timeout: 180_000 });
    await ctx.close();
    const rows = psql(`SELECT count(*) || '|' || max(size_bytes) FROM media WHERE original_name = 'gross.mp4'`).split('|');
    expect(rows[0] === '1' && Number(rows[1]) === size, `Medien: ${rows.join('|')}`);
    return `${Math.round(size / 1048576)} MB, ${puts} Teil-Anfragen, 1 Abbruch, genau 1 Datei`;
  });

  await step('Video wird geprüft: Vorschau und öffentliche Fassung ohne Standort', async () => {
    for (let i = 0; i < 90; i++) {
      const r = psql(`SELECT status || '|' || has_preview || '|' || has_public || '|' || had_location FROM media WHERE original_name = 'gross.mp4'`);
      if (r.startsWith('ready')) {
        const id = psql(`SELECT id FROM media WHERE original_name = 'gross.mp4'`);
        const tags = sh(`docker compose exec -T blaulichtcms ffprobe -v error -show_entries format_tags -of compact /data/media/public/${id}.mp4`);
        expect(!tags.includes('location'), 'Standort in öffentlicher Fassung');
        return r;
      }
      if (r.startsWith('rejected')) throw new Error(r);
      await sleep(1000);
    }
    throw new Error('nicht geprüft');
  });

  /* ---------------------------------------------------- 2. QR-Aushang */
  await step('QR-Aushang als A4-PDF für den Upload-Link', async () => {
    const ctx = await contextFor(editor);
    const p = await ctx.newPage();
    const u = new URL(`${BC}/drucken`);
    u.searchParams.set('url', uploadLink);
    u.searchParams.set('title', 'Großübung');
    u.searchParams.set('purpose', 'Fotos und Videos hochladen');
    await p.goto(u.toString());
    await p.locator('.print-sheet img[alt^="QR-Code"]').waitFor();
    await p.pdf({ path: path.join(OUT, 'aushang-m2.pdf'), format: 'A4' });
    await ctx.close();
    return 'test/e2e/out/m2/aushang-m2.pdf';
  });

  /* ---------------------------------------------------- 3. Banner */
  let bannerId;
  await step('Banner freigeben und veröffentlichen – erscheint auf der Website', async () => {
    const ends = new Date(Date.now() + 100_000).toISOString();
    const b = await editor.post('/banners', { siteId, title: 'Vollsperrung Brückenstraße', text: 'Bitte Umleitung beachten.', tone: 'danger', priority: 3, endsAt: ends });
    bannerId = b.id;
    const list = await editor.get('/banners');
    const cur = list.find((x) => x.id === bannerId);
    await admin.post(`/banners/${bannerId}/approve`, { contentHash: cur.content_hash });
    await editor.post(`/banners/${bannerId}/publish`, { contentHash: cur.content_hash });
    wpcli('blaulichtcms-bridge poll');
    const html = await fetchText(`${WP}/`);
    expect(html.includes('Vollsperrung Brückenstraße'), 'Banner fehlt auf der Startseite');
    fs.writeFileSync(path.join(OUT, 'startseite-zwischengespeichert.html'), html);
    const state = (await editor.get('/banners')).find((x) => x.id === bannerId).state;
    expect(state === 'live', state);
    return 'Banner live, Startseite zwischengespeichert';
  });

  await step('Shortcode und Einsatzübersicht auf einer WordPress-Seite', async () => {
    const id = wpcli(`post create --post_type=page --post_status=publish --post_title="Aktuelles" --post_content="[blaulichtcms_banner] [blaulichtcms_einsaetze anzahl=5]" --porcelain`);
    const link = wpcli(`post list --post_type=page --p=${id} --field=url`);
    const html = await fetchText(link);
    expect(html.includes('Vollsperrung Brückenstraße') && html.includes('bcb-incidents'), 'Shortcodes nicht gerendert');
    return link;
  });

  await step('Verbindung zu BlaulichtCMS getrennt: Banner läuft auf der Website trotzdem ab', async () => {
    sh('docker compose stop blaulichtcms');
    const ends = new Date(psql_off_ends(bannerId));
    const wait = ends.getTime() - Date.now() + 3000;
    if (wait > 0) await sleep(wait);
    const html = await fetchText(`${WP}/`);
    expect(!html.includes('Vollsperrung Brückenstraße'), 'Banner nach Ablauf noch sichtbar');
    const st = wpcli('blaulichtcms-bridge status');
    return `BlaulichtCMS gestoppt, Banner ausgeblendet · ${st.split('\n').pop().trim()}`;
  });

  await step('Zwischengespeicherte Seite (Seitencache) blendet das abgelaufene Banner im Browser aus', async () => {
    const cached = fs.readFileSync(path.join(OUT, 'startseite-zwischengespeichert.html'), 'utf8');
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.route(`${WP}/cache-kopie`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: cached }));
    await p.goto(`${WP}/cache-kopie`);
    await p.waitForLoadState('networkidle');
    const visible = await p.locator('.bcb-banner').evaluateAll((els) => els.filter((e) => !e.hidden).length);
    expect((await p.locator('.bcb-banner').count()) === 1 && visible === 0, `Banner im Cache-HTML sichtbar: ${visible}`);
    await ctx.close();
    return 'im HTML vorhanden, durch Skript ausgeblendet';
  });

  await step('BlaulichtCMS wieder verbunden: Abgleich ohne Fehler', async () => {
    sh('docker compose start blaulichtcms');
    await waitHealthy();
    wpcli('blaulichtcms-bridge poll');
    const err = wpcli('blaulichtcms-bridge status').split('\n').find((l) => l.startsWith('Letzter Fehler'));
    expect(err.includes('–'), err);
    return 'Abruf erfolgreich';
  });

  /* ---------------------------------------------------- 4. RSS */
  await step('RSS-Quelle mit Vorschau hinzufügen (Feed der WordPress-Testseite)', async () => {
    // Die Testseite ist aus dem BlaulichtCMS-Container nur über ein internes Netz erreichbar → ausdrücklich freigeben
    sh('docker network connect blaulichtcms-wp-test_default blaulichtcms');
    await admin.req('PATCH', '/settings', { 'security.allowed_private_hosts': ['wordpress'] });
    wpcli('post create --post_status=publish --post_title="Pressemitteilung Übungsdienst" --post_content="Text der Pressemitteilung."');
    const ctx = await contextFor(editor);
    const p = await ctx.newPage();
    await p.goto(`${BC}/quellen`);
    await p.getByRole('button', { name: 'Quelle hinzufügen' }).first().click();
    await p.fill('#rss-url', 'http://wordpress/feed/');
    await p.getByRole('button', { name: 'Vorschau laden' }).click();
    await p.getByText('Pressemitteilung Übungsdienst').first().waitFor();
    await p.getByRole('dialog').getByRole('button', { name: 'Quelle hinzufügen' }).click();
    await p.getByRole('link', { name: /Pressemitteilung Übungsdienst/ }).first().waitFor();
    await p.getByRole('button', { name: 'Als Themenidee übernehmen' }).first().click();
    await p.waitForURL(/\/beitraege\/[0-9a-f-]{36}$/);
    const body = await p.locator('#e-body').inputValue();
    expect(body.includes('Quelle:'), 'Quellenlink fehlt');
    await ctx.close();
    const n = psql(`SELECT count(*) FROM rss_items`);
    return `${n} Einträge importiert, Themenidee angelegt`;
  });

  await step('Erneuter Abruf legt keine Duplikate an', async () => {
    const before = psql(`SELECT count(*) FROM rss_items`);
    const feed = await editor.get('/rss/feeds');
    await editor.post(`/rss/feeds/${feed[0].id}/refresh`);
    const after = psql(`SELECT count(*) FROM rss_items`);
    expect(before === after, `${before} → ${after}`);
    return `${after} Einträge`;
  });

  /* ---------------------------------------------------- 5. Dashboard nach Wiederverbindung */
  await step('Dashboard zeigt Unterbrechung und lädt nach Wiederverbindung den bestätigten Stand', async () => {
    const ctx = await contextFor(admin, { viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${BC}/`);
    await p.getByRole('status').filter({ hasText: 'Live' }).waitFor();
    const before = Number(await p.locator('text=Offene Freigaben').first().locator('xpath=../..').locator('.text-kpi, [class*="kpi"]').first().textContent().catch(() => '0')) || 0;
    // Verbindung des Browsers trennen, währenddessen reicht die Redaktion etwas ein
    await ctx.setOffline(true);
    await p.getByText('Verbindung unterbrochen', { exact: false }).first().waitFor({ timeout: 20_000 });
    const post = await editor.post('/posts', { title: 'Eingereicht während der Unterbrechung' });
    const d = await editor.get(`/posts/${post.id}`);
    await editor.put(`/posts/${post.id}/revision`, { baseRevision: 1, title: d.revision.title, body: 'Text' });
    await editor.post(`/posts/${post.id}/submit`, { revision: 2 });
    await ctx.setOffline(false);
    await p.getByRole('link', { name: 'Eingereicht während der Unterbrechung' }).waitFor({ timeout: 30_000 });
    await p.getByRole('status').filter({ hasText: 'Live' }).waitFor();
    await p.screenshot({ path: path.join(OUT, 'dashboard-nach-wiederverbindung.png') });
    await ctx.close();
    return `vorher ${before}, danach Eintrag sichtbar, Live wieder aktiv`;
  });

  await step('Dashboard am Laptop anpassen und mobile Reihenfolge prüfen', async () => {
    const layout = { desktop: [{ id: 'rss', size: 'l' }, { id: 'approvals', size: 'm' }, { id: 'banners', size: 'm' }], mobile: ['approvals', 'rss'] };
    await editor.put('/dashboard/layout', { scope: 'personal', layout });
    const ctx = await contextFor(editor, { ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    await p.goto(`${BC}/`);
    await p.locator('section[aria-label]').first().waitFor();
    const order = await p.locator('main section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(JSON.stringify(order) === JSON.stringify(['Offene Freigaben', 'Quellen (RSS)']), order.join(','));
    await p.screenshot({ path: path.join(OUT, 'dashboard-handy.png') });
    await ctx.close();
    return order.join(' → ');
  });
} catch (e) {
  ok = false;
  console.log(`Abbruch: ${e?.message ?? e}`);
} finally {
  await browser.close();
  sh('docker network disconnect blaulichtcms-wp-test_default blaulichtcms || true');
  finish(ok);
  process.exit(ok ? 0 : 1);
}

function psql_off_ends(id) {
  // BlaulichtCMS ist gestoppt: Ablaufzeit aus der lokalen Ablage der Bridge lesen
  const raw = wpcli(`option get blaulichtcms_bridge_banners --format=json`);
  const banners = JSON.parse(raw);
  return banners[id].ends_at * 1000;
}
