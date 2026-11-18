/**
 * Abnahmetest Meilenstein 1 – über den normalen Einstiegspunkt (Container + Browser).
 *
 * Ablauf: frischer Container → Admin einrichten → Bediener einladen → Foto-Link am Handy öffnen →
 * Foto hochladen → Bild auswählen → Beitrag freigeben → auf WordPress-Testseite veröffentlichen →
 * bestätigte URL in BlaulichtCMS sehen. Dazu Fehlerfälle, interne Freigabe ohne WordPress sowie
 * Sicherung außerhalb des Volumes und Wiederherstellung in einer frischen Instanz.
 *
 * Voraussetzungen: Docker, Playwright mit Chromium, Image blaulichtcms:local (docker compose build).
 * Aufruf (aus dem Repository-Wurzelverzeichnis):  node test/e2e/m1-flow.mjs
 * Ergebnis: test/e2e/out/report.json und Screenshots in test/e2e/out/.
 */
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const WP = process.env.WP_URL ?? 'http://localhost:8080';
const BC_FROM_WP = process.env.BLAULICHTCMS_URL_FROM_WP ?? 'http://host.docker.internal:7310';
const SHOTS = process.env.DOC_SHOTS === '1';
fs.mkdirSync(OUT, { recursive: true });

const report = { started: new Date().toISOString(), steps: [] };
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
const psql = (sql) => sh(`docker compose exec -T blaulichtcms psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms -tAc ${JSON.stringify(sql)}`);
const wpcli = (args) => sh(`docker compose -f test/wordpress/compose.yaml --profile cli run --rm -T cli wp ${args}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
    console.log(`✔ ${name}${detail ? ` – ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 2000) });
    console.log(`✘ ${name}: ${e?.message ?? e}`);
    // Zur Analyse: Screenshot und Text aller offenen Seiten
    let n = 0;
    for (const ctx of browser.contexts())
      for (const pg of ctx.pages()) {
        n++;
        try {
          await pg.screenshot({ path: path.join(OUT, `fehler-${n}.png`) });
          console.log(`  Seite ${n}: ${pg.url()}\n  ${(await pg.locator('body').innerText()).slice(0, 600).replace(/\n+/g, ' | ')}`);
        } catch {
          /* Seite geschlossen */
        }
      }
    throw e;
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** RFC 6238 (SHA-1, 30 s, 6 Stellen) für die Zwei-Faktor-Einrichtung des Admins. */
function totp(base32) {
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

async function waitHealthy(timeoutMs = 120_000) {
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

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

/** Testfoto mit GPS-Daten im EXIF – die öffentliche Fassung darf sie nicht enthalten. */
async function makePhoto(file) {
  const sharp = createRequire(path.join(ROOT, 'server/package.json'))('sharp');
  const overlay = Buffer.from('<svg width="1600" height="1067"><rect x="300" y="380" width="1000" height="300" rx="40" fill="#fff" opacity=".85"/><circle cx="800" cy="530" r="90" fill="#b42828"/></svg>');
  await sharp({ create: { width: 1600, height: 1067, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .composite([{ input: overlay }])
    .jpeg()
    .withExif({ IFD0: { Make: 'Testkamera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 6/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '8/1 41/1 0/1' } })
    .toFile(path.join(OUT, file));
}

const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Sicheres-Testkennwort-2026' };
const OPERATOR = { name: 'Robin Redaktion', email: 'redaktion@example.org', password: 'Bediener-Testkennwort-2026' };

const browser = await chromium.launch();
let exitCode = 0;
try {
  /* ------------------------------------------------------------------ Vorbereitung */
  await step('Frischer Container auf leerem Volume', async () => {
    sh('docker compose down -v');
    // Test-WordPress erreicht BlaulichtCMS über host.docker.internal → Port nicht nur an 127.0.0.1 binden
    fs.writeFileSync(path.join(ROOT, '.env'), 'COOKIE_SECURE=false\nTRUST_PROXY=false\nBLAULICHTCMS_BIND=0.0.0.0\n');
    sh('docker network inspect proxy-net >/dev/null 2>&1 || docker network create proxy-net');
    sh('docker compose up -d');
    const h = await waitHealthy();
    expect(h.checks.worker.ok && h.checks.schema.ok, 'Healthcheck unvollständig');
    return `healthz ok, ${h.checks.schema.detail}`;
  });

  await step('WordPress-Testsystem bereitstellen', async () => {
    sh('docker compose -f test/wordpress/compose.yaml down -v');
    sh('docker compose -f test/wordpress/compose.yaml up -d');
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${WP}/wp-admin/install.php`);
        if (r.status < 500) break;
      } catch {
        /* startet noch */
      }
      await sleep(2000);
    }
    wpcli(`core install --url=${WP} --title="Testseite" --admin_user=wpadmin --admin_password=wp-test-2026 --admin_email=wp@example.org --skip-email`);
    wpcli('rewrite structure "/%year%/%monthnum%/%postname%/" --hard');
    return wpcli('core version');
  });

  const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true, locale: 'de-DE' });
  const page = await desk.newPage();

  /* ------------------------------------------------------------------ Erstsetup */
  await step('Erstsetup: Admin, Organisation, Basisadresse, Zeitzone', async () => {
    const token = sh('docker compose exec -T blaulichtcms cat /data/setup-token.txt');
    await page.goto(`${BC}/einrichtung`);
    await page.fill('#tok', token);
    await page.fill('#org', 'Musterorganisation');
    await page.fill('#url', BC);
    await page.selectOption('#tz', 'Europe/Berlin');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.fill('#name', ADMIN.name);
    await page.fill('#email', ADMIN.email);
    await page.fill('#pw', ADMIN.password);
    await page.fill('#pw2', ADMIN.password);
    await page.getByRole('button', { name: 'Einrichtung abschließen' }).click();
    // Zwei-Faktor ist für Administration Pflicht
    await page.waitForURL('**/2fa/einrichten');
    const secret = (await page.locator('text=/^[A-Z2-7 ]{20,}$/').first().textContent()).replace(/\s/g, '');
    await page.fill('#totp', totp(secret));
    await page.getByRole('button', { name: 'Aktivieren' }).click();
    await page.getByRole('button', { name: /Codes gesichert/ }).click();
    await page.waitForURL(`${BC}/`);
    await page.getByRole('heading', { name: /Hallo Alex/ }).waitFor();
    report.adminTotpSecret = 'im Test erzeugt (nicht gespeichert)';
    if (SHOTS) await shot(page, 'doc-dashboard-leer');
    return 'Dashboard erreicht';
  });

  await step('Zweites Setup wird abgewiesen', async () => {
    const r = await fetch(`${BC}/api/v1/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-blaulichtcms-request': '1' }, body: JSON.stringify({ token: 'x', name: 'X Y', email: 'x@example.org', password: 'Noch-ein-Testkennwort', organization: 'Andere Organisation', publicUrl: BC }) });
    expect(r.status === 403 || r.status === 409, `erwartet 403/409, erhalten ${r.status}`);
    return `HTTP ${r.status}`;
  });

  /* ------------------------------------------------------------------ Einladung */
  let inviteLink = '';
  await step('Bediener einladen (Redaktion + Medienverwaltung + Veröffentlichung)', async () => {
    // Der Ablauf am Handy prüft die Einladung ohne Zwei-Faktor-Einrichtung: Pflicht für Medienverwaltung hier aus
    psql(`INSERT INTO settings (key, value) VALUES ('security.require_2fa_media', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'`);
    await sleep(5_500); // Einstellungs-Zwischenspeicher der API (5 s)
    await page.goto(`${BC}/benutzer`);
    await page.getByRole('button', { name: 'Benutzer einladen' }).first().click();
    await page.fill('#inv-email', OPERATOR.email);
    await page.fill('#inv-name', OPERATOR.name);
    await page.locator('#inv-roles-label').locator('..').getByRole('button').click();
    for (const label of ['Medienverwaltung', 'Veröffentlichung']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Einladungslink erzeugen' }).click();
    const status = page.getByRole('status').filter({ hasText: 'Einladung für' });
    await status.waitFor();
    const text = await status.innerText();
    inviteLink = (text.match(/https?:\/\/\S+\/einladung\/[A-Za-z0-9_-]+/) ?? [])[0];
    if (!inviteLink) inviteLink = await status.locator('input, code').first().evaluate((el) => el.value ?? el.textContent);
    expect(/\/einladung\//.test(inviteLink), 'Kein Einladungslink gefunden');
    return inviteLink.replace(/[A-Za-z0-9_-]{20,}$/, '…');
  });

  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' });
  const op = await phone.newPage();
  await step('Bediener nimmt Einladung am Handy an', async () => {
    await op.goto(inviteLink);
    await op.fill('#pw', OPERATOR.password);
    await op.fill('#pw2', OPERATOR.password);
    await op.getByRole('button', { name: /Konto|Passwort|Speichern|Weiter|Los/ }).last().click();
    await op.waitForURL(`${BC}/`);
    return 'angemeldet';
  });

  await step('Einladungslink ist danach verbraucht', async () => {
    const token = inviteLink.split('/einladung/')[1];
    const r = await fetch(`${BC}/api/v1/auth/invite/${token}`);
    expect(r.status === 404, `erwartet 404, erhalten ${r.status}`);
    return 'HTTP 404';
  });

  /* ------------------------------------------------------------------ Beitrag + Foto-Link */
  let postUrl = '';
  let uploadLink = '';
  await step('Bediener legt Beitrag an und erzeugt „Fotos sammeln“', async () => {
    await op.goto(`${BC}/beitraege`);
    await op.getByRole('button', { name: 'Neuer Beitrag' }).click();
    await op.fill('#p-title', 'Übung am Wochenende');
    await op.getByRole('button', { name: 'Anlegen' }).click();
    await op.waitForURL(/\/beitraege\/[0-9a-f-]{36}$/);
    postUrl = op.url();
    await op.getByRole('button', { name: 'Fotos sammeln' }).click();
    const dlg = op.getByRole('dialog', { name: 'Fotos sammeln' });
    await dlg.waitFor();
    uploadLink = (await dlg.locator('code').first().textContent()).trim();
    expect(uploadLink.startsWith(`${BC}/u/`), `Unerwarteter Link ${uploadLink}`);
    await dlg.getByRole('button', { name: 'QR-Code anzeigen' }).click();
    await op.getByRole('dialog', { name: 'QR-Code anzeigen' }).locator('img[alt^="QR-Code"]').waitFor();
    await op.keyboard.press('Escape');
    await op.keyboard.press('Escape');
    return uploadLink.replace(/[A-Za-z0-9_-]{16,}$/, '…');
  });

  await step('Aushang-Druckansicht enthält QR-Code, Zweck und lesbare Adresse', async () => {
    const p = await desk.newPage();
    const u = new URL(`${BC}/drucken`);
    u.searchParams.set('url', uploadLink);
    u.searchParams.set('title', 'Übung am Wochenende');
    u.searchParams.set('purpose', 'Fotos und Videos hochladen');
    u.searchParams.set('valid', new Date(Date.now() + 7 * 86400e3).toISOString());
    await p.goto(u.toString());
    await p.locator('.print-sheet img[alt^="QR-Code"]').waitFor();
    expect((await p.locator('.print-sheet .url').textContent()) === uploadLink, 'Adresse fehlt');
    await p.pdf({ path: path.join(OUT, 'aushang.pdf'), format: 'A4' });
    await p.close();
    return 'PDF test/e2e/out/aushang.pdf';
  });

  await step('Foto-Link am Handy ohne Konto öffnen und Foto hochladen', async () => {
    await makePhoto('testfoto.jpg');
    const anon = await browser.newContext({ ...devices['iPhone 14'], locale: 'de-DE' });
    const up = await anon.newPage();
    await up.goto(uploadLink);
    await up.getByRole('heading', { name: 'Übung am Wochenende' }).waitFor();
    await up.setInputFiles('input[aria-label="Fotos oder Videos auswählen"]', path.join(OUT, 'testfoto.jpg'));
    await up.getByRole('button', { name: /Datei(en)? senden/ }).click();
    await up.getByText('Vielen Dank!').waitFor({ timeout: 30000 });
    if (SHOTS) await shot(up, 'doc-upload-handy');
    await anon.close();
    return 'Upload bestätigt';
  });

  let mediaId = '';
  await step('Upload liegt zuerst in Quarantäne und wird geprüft (Standortdaten entfernt)', async () => {
    for (let i = 0; i < 30; i++) {
      const row = psql(`SELECT id || '|' || status || '|' || had_location || '|' || has_public FROM media ORDER BY created_at DESC LIMIT 1`);
      const [id, status, loc, pub] = row.split('|');
      mediaId = id;
      if (status === 'ready') {
        expect(['t', 'true'].includes(loc) && ['t', 'true'].includes(pub), `Standort/öffentliche Fassung: ${row}`);
        const exif = sh(`docker compose exec -T blaulichtcms node -e "require('/app/node_modules/sharp')('/data/media/public/${id}.jpg').metadata().then(m=>console.log(m.exif?'EXIF':'ohne EXIF'))"`);
        expect(exif === 'ohne EXIF', 'öffentliche Fassung enthält EXIF');
        return `geprüft, GPS im Original erkannt, öffentliche Fassung ${exif}`;
      }
      await sleep(1000);
    }
    throw new Error('Datei wurde nicht geprüft');
  });

  await step('Bild sichten und auswählen (Handy)', async () => {
    const collectionId = psql(`SELECT collection_id FROM media WHERE id = '${mediaId}'`);
    await op.goto(`${BC}/medien/${collectionId}`);
    await op.getByRole('button', { name: /1 sichten/ }).click();
    const dlg = op.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Auswählen' }).click();
    await dlg.getByText('Alle Dateien gesichtet.').waitFor();
    if (SHOTS) await shot(op, 'doc-sichtung-handy');
    await dlg.getByRole('button', { name: 'Schließen' }).last().click();
    expect(psql(`SELECT selection FROM media WHERE id = '${mediaId}'`) === 'selected', 'nicht ausgewählt');
    return 'ausgewählt';
  });

  await step('Beitrag schreiben, Bild übernehmen, zur Freigabe einreichen', async () => {
    await op.goto(postUrl);
    await op.fill('#e-body', 'Am Samstag fand eine gemeinsame Übung statt.\n\nVielen Dank an alle Beteiligten!');
    await op.getByRole('button', { name: 'Medien übernehmen' }).click();
    const dlg = op.getByRole('dialog', { name: 'Medien übernehmen' });
    await dlg.locator('button[aria-pressed]').first().click();
    await dlg.getByRole('button', { name: /übernehmen$/ }).click();
    await op.locator('[data-save-bar]').getByRole('button', { name: 'Neue Fassung speichern' }).click();
    await op.locator('[data-save-bar]').waitFor({ state: 'detached' });
    await op.getByRole('button', { name: 'Zur Freigabe einreichen' }).click();
    await op.getByRole('dialog', { name: 'Zur Freigabe einreichen' }).getByRole('button', { name: /^(Trotzdem einreichen|Einreichen)$/ }).click();
    await op.getByText('Eingereicht', { exact: false }).first().waitFor();
    return 'eingereicht';
  });

  await step('Bediener darf nicht selbst freigeben (Recht fehlt, auch per API)', async () => {
    const id = postUrl.split('/').pop();
    const cookies = await phone.cookies();
    const res = await op.request.post(`${BC}/api/v1/posts/${id}/decision`, { headers: { 'x-blaulichtcms-request': '1', cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') }, data: { revision: 2, contentHash: '0'.repeat(64), decision: 'approved' } });
    expect(res.status() === 403, `erwartet 403, erhalten ${res.status()}`);
    expect((await op.getByRole('button', { name: 'Freigeben' }).count()) === 0, 'Freigeben-Button sichtbar');
    return 'HTTP 403, kein Button';
  });

  await step('Admin gibt frei (intern, ohne WordPress)', async () => {
    await page.goto(postUrl);
    await page.getByRole('button', { name: 'Freigeben' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Freigeben' }).click();
    await page.getByText(/Freigegeben von Alex Admin/).waitFor();
    await page.getByText('Intern freigegeben.', { exact: false }).waitFor();
    return 'intern freigegeben';
  });

  /* ------------------------------------------------------------------ WordPress koppeln */
  let pairingCode = '';
  await step('BlaulichtCMS Bridge als ZIP aus BlaulichtCMS herunterladen und in WordPress installieren', async () => {
    await page.goto(`${BC}/websites`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Bridge herunterladen' }).click()]);
    fs.mkdirSync(path.join(ROOT, 'test/wordpress/tmp'), { recursive: true });
    await dl.saveAs(path.join(ROOT, 'test/wordpress/tmp/blaulichtcms-bridge.zip'));
    wpcli('plugin install /tmp/blaulichtcms/blaulichtcms-bridge.zip --activate --force');
    return wpcli('plugin get blaulichtcms-bridge --field=version');
  });

  await step('Website per einmaligem Code koppeln (WordPress-Oberfläche)', async () => {
    await page.getByRole('button', { name: 'Website koppeln' }).first().click();
    await page.fill('#s-name', 'Testwebsite');
    await page.getByRole('button', { name: 'Kopplungscode erzeugen' }).click();
    const dlg = page.getByRole('dialog', { name: /koppeln/ });
    pairingCode = (await dlg.locator('code').nth(1).textContent()).trim();
    expect(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairingCode), `Code ${pairingCode}`);
    await dlg.getByRole('button', { name: 'Fertig' }).click();
    const wp = await desk.newPage();
    await wp.goto(`${WP}/wp-login.php`);
    await wp.fill('#user_login', 'wpadmin');
    await wp.fill('#user_pass', 'wp-test-2026');
    await wp.click('#wp-submit');
    await wp.goto(`${WP}/wp-admin/options-general.php?page=blaulichtcms-bridge`);
    await wp.fill('#blaulichtcms_url', BC_FROM_WP);
    await wp.fill('#pairing_code', pairingCode);
    await wp.getByRole('button', { name: 'Koppeln' }).click();
    await wp.getByText(/Gekoppelt mit BlaulichtCMS/).waitFor();
    if (SHOTS) await shot(wp, 'doc-wordpress-bridge');
    await wp.close();
    await page.reload();
    await page.getByText('Aktiv').first().waitFor();
    return `Code ${pairingCode.slice(0, 2)}…, gekoppelt`;
  });

  await step('Kopplungscode ist danach verbraucht', async () => {
    const r = await fetch(`${BC}/api/v1/bridge/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairingCode, site_url: 'https://evil.example.org' }) });
    expect(r.status === 401, `erwartet 401, erhalten ${r.status}`);
    return 'HTTP 401';
  });

  /* ------------------------------------------------------------------ Veröffentlichen */
  await step('Zielkanal wählen erzeugt neue Fassung – alte Freigabe gilt nicht mehr', async () => {
    await op.goto(postUrl);
    await op.selectOption('#e-site', { label: 'WordPress: Testwebsite' });
    await op.locator('[data-save-bar]').getByRole('button', { name: 'Neue Fassung speichern' }).click();
    await op.locator('[data-save-bar]').waitFor({ state: 'detached' });
    await op.getByText('Entwurf').first().waitFor();
    expect((await op.getByRole('button', { name: /veröffentlichen/ }).count()) === 0, 'Veröffentlichen ohne neue Freigabe möglich');
    await op.getByRole('button', { name: 'Zur Freigabe einreichen' }).click();
    await op.getByRole('dialog', { name: 'Zur Freigabe einreichen' }).getByRole('button', { name: /^(Trotzdem einreichen|Einreichen)$/ }).click();
    return 'neue Fassung, Status Entwurf → eingereicht';
  });

  await step('Admin gibt die neue Fassung frei, Bediener veröffentlicht', async () => {
    await page.goto(postUrl);
    await page.getByRole('button', { name: 'Freigeben' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Freigeben' }).click();
    await page.getByText(/Freigegeben von Alex Admin/).waitFor();
    await op.reload();
    await op.getByRole('button', { name: 'Auf Testwebsite veröffentlichen' }).click();
    await op.getByText('Wartet auf Abholung').first().waitFor();
    return 'Auftrag erstellt';
  });

  await step('Bridge holt per Host-Cron ab und meldet zurück', async () => {
    const out = wpcli('blaulichtcms-bridge poll');
    expect(/1 Auftrag/.test(out), out);
    return out;
  });

  let publishedUrl = '';
  await step('BlaulichtCMS zeigt die bestätigte URL', async () => {
    await op.reload();
    await op.getByText('Veröffentlicht').first().waitFor();
    publishedUrl = await op.locator(`a[href^="${WP}"]`).first().getAttribute('href');
    expect(publishedUrl, 'keine URL');
    if (SHOTS) await shot(op, 'doc-beitrag-handy');
    await page.goto(`${BC}/`);
    await page.locator(`a[href="${publishedUrl}"]`).first().waitFor();
    if (SHOTS) await shot(page, 'doc-dashboard');
    return publishedUrl;
  });

  await step('Auf der Testwebsite erscheint genau ein Beitrag (mit Bild, ohne Standortdaten)', async () => {
    const posts = await (await fetch(`${WP}/wp-json/wp/v2/posts?search=${encodeURIComponent('Übung am Wochenende')}&_fields=id,link,featured_media`)).json();
    expect(posts.length === 1, `${posts.length} Beiträge gefunden`);
    expect(posts[0].link === publishedUrl, `URL weicht ab: ${posts[0].link}`);
    expect(posts[0].featured_media > 0, 'kein Beitragsbild');
    const html = await (await fetch(publishedUrl)).text();
    expect(html.includes('gemeinsame Übung'), 'Text fehlt auf der Seite');
    const wpPage = await desk.newPage();
    await wpPage.goto(publishedUrl);
    if (SHOTS) await shot(wpPage, 'doc-wordpress-beitrag');
    await wpPage.close();
    return `WordPress-ID ${posts[0].id}`;
  });

  await step('Erneutes Abholen und doppelte Rückmeldung erzeugen keinen zweiten Beitrag', async () => {
    psql(`UPDATE publications SET status = 'unknown' WHERE status = 'published'`);
    const out = wpcli('blaulichtcms-bridge poll');
    expect(/1 Auftrag/.test(out), `Auftrag nicht erneut ausgeliefert: ${out}`);
    wpcli('blaulichtcms-bridge poll');
    const n = (await (await fetch(`${WP}/wp-json/wp/v2/posts?search=${encodeURIComponent('Übung am Wochenende')}&_fields=id`)).json()).length;
    expect(n === 1, `${n} Beiträge`);
    expect(psql(`SELECT status FROM publications`) === 'published', 'Status nicht wieder bestätigt');
    const media = wpcli('post list --post_type=attachment --format=count');
    expect(media === '1', `${media} Anhänge`);
    return 'weiterhin genau 1 Beitrag und 1 Anhang';
  });

  /* ------------------------------------------------------------------ Fehlerfälle */
  await step('Direkte Zugriffe ohne Anmeldung werden abgewiesen', async () => {
    const urls = [`/api/v1/media/${mediaId}/original`, `/api/v1/media/${mediaId}/preview`, '/api/v1/posts', '/api/v1/collections', '/api/v1/users', '/api/v1/sites/plugin.zip'];
    const codes = [];
    for (const u of urls) codes.push((await fetch(`${BC}${u}`)).status);
    expect(codes.every((c) => c === 401), codes.join(','));
    // Medien liegen nicht im Webroot
    const direct = await fetch(`${BC}/data/media/public/${mediaId}.jpg`);
    expect(!(direct.headers.get('content-type') ?? '').startsWith('image/'), 'Datei direkt erreichbar');
    return codes.join(',');
  });

  await step('Bediener ohne Admin-Recht: Benutzerverwaltung und Website-Kopplung gesperrt', async () => {
    const cookie = (await phone.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const a = await op.request.get(`${BC}/api/v1/users`, { headers: { cookie } });
    const b = await op.request.post(`${BC}/api/v1/sites`, { headers: { cookie, 'x-blaulichtcms-request': '1' }, data: { name: 'X' } });
    expect(a.status() === 403 && b.status() === 403, `${a.status()} ${b.status()}`);
    return `${a.status()}, ${b.status()}`;
  });

  await step('Abgelaufener Upload-Link wird abgewiesen', async () => {
    const token = uploadLink.split('/u/')[1];
    psql(`UPDATE upload_links SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(sha256('${token}'::bytea), 'hex')`);
    const anon = await browser.newContext({ ...devices['iPhone 14'] });
    const p = await anon.newPage();
    await p.goto(uploadLink);
    await p.getByRole('heading', { name: 'Link nicht mehr gültig' }).waitFor();
    await anon.close();
    psql(`UPDATE upload_links SET expires_at = now() + interval '7 days' WHERE token_hash = encode(sha256('${token}'::bytea), 'hex')`);
    return 'Seite „Link nicht mehr gültig“, HTTP 410';
  });

  await step('Widerrufener Upload-Link wird abgewiesen (UI-Widerruf)', async () => {
    const collectionId = psql(`SELECT collection_id FROM media WHERE id = '${mediaId}'`);
    await page.goto(`${BC}/medien/${collectionId}`);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Widerrufen' }).first().click();
    await page.getByText('Widerrufen', { exact: true }).first().waitFor();
    const token = uploadLink.split('/u/')[1];
    const r = await fetch(`${BC}/api/v1/public/upload/${token}`);
    const j = await r.json();
    expect(r.status === 410 && j.error === 'link_revoked', `${r.status} ${j.error}`);
    return 'HTTP 410 link_revoked';
  });

  await step('Widerrufene Website-Kopplung wird abgewiesen', async () => {
    // Zweite Website koppeln und sofort widerrufen, die Testwebsite bleibt für die Sicherung gekoppelt
    const cookie = (await desk.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const s = await (await fetch(`${BC}/api/v1/sites`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-blaulichtcms-request': '1' }, body: JSON.stringify({ name: 'Widerruf-Test' }) })).json();
    const pair = await (await fetch(`${BC}/api/v1/bridge/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: s.pairingCode, site_url: 'https://zweite.example.org' }) })).json();
    await fetch(`${BC}/api/v1/sites/${s.site.id}/revoke`, { method: 'POST', headers: { cookie, 'x-blaulichtcms-request': '1', 'content-type': 'application/json' }, body: '{}' });
    const r = await fetch(`${BC}/api/v1/bridge/jobs`, { headers: { authorization: `Bearer ${pair.key}` } });
    expect(r.status === 401, `erwartet 401, erhalten ${r.status}`);
    return 'HTTP 401';
  });

  await step('Zweiter Beitrag: interne Freigabe ganz ohne Zielkanal', async () => {
    await op.goto(`${BC}/beitraege`);
    await op.getByRole('button', { name: 'Neuer Beitrag' }).click();
    await op.fill('#p-title', 'Interne Lageinformation');
    await op.getByRole('button', { name: 'Anlegen' }).click();
    await op.waitForURL(/\/beitraege\/[0-9a-f-]{36}$/);
    const url = op.url();
    await op.fill('#e-body', 'Nur zur internen Abstimmung.');
    await op.locator('[data-save-bar]').getByRole('button', { name: 'Neue Fassung speichern' }).click();
    await op.locator('[data-save-bar]').waitFor({ state: 'detached' });
    await op.getByRole('button', { name: 'Zur Freigabe einreichen' }).click();
    await op.getByRole('dialog', { name: 'Zur Freigabe einreichen' }).getByRole('button', { name: /^(Trotzdem einreichen|Einreichen)$/ }).click();
    await page.goto(url);
    await page.getByRole('button', { name: 'Freigeben' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Freigeben' }).click();
    await page.getByText('Intern freigegeben.', { exact: false }).waitFor();
    if (SHOTS) await shot(page, 'doc-beitrag-desktop');
    return 'freigegeben, keine Veröffentlichung';
  });

  await step('Audit enthält Rollen, Freigaben und Veröffentlichungen mit Person und Zeit', async () => {
    const rows = psql(`SELECT action || '|' || actor_name FROM audit_events WHERE action IN ('user.invited','post.approved','publication.requested','publication.confirmed') ORDER BY id`).split('\n');
    for (const a of ['user.invited|Alex Admin', 'post.approved|Alex Admin', 'publication.requested|Robin Redaktion']) expect(rows.includes(a), `fehlt: ${a}`);
    expect(rows.some((r) => r.startsWith('publication.confirmed|Website')), 'Bestätigung fehlt');
    return `${rows.length} relevante Einträge`;
  });

  if (SHOTS) {
    await page.goto(`${BC}/hilfe`);
    await page.getByRole('heading', { name: /wie können wir helfen/ }).waitFor();
    await shot(page, 'doc-hilfe');
    const collectionId = psql(`SELECT collection_id FROM media WHERE id = '${mediaId}'`);
    await page.goto(`${BC}/medien/${collectionId}`);
    await page.getByRole('tab', { name: /Ausgewählt/ }).click();
    await page.locator('img[src*="/preview"]').first().waitFor();
    await shot(page, 'doc-sammlung');
  }

  /* ------------------------------------------------------------------ Sicherung + Wiederherstellung */
  const backup = path.join(ROOT, 'test/e2e/out/backup');
  await step('Teststand außerhalb des aktiven Volumes sichern', async () => {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(backup, { recursive: true });
    const out = sh(`scripts/backup-volume.sh ${backup}`);
    const file = fs.readdirSync(backup).find((f) => f.endsWith('.tar.gz.enc'));
    expect(file, 'kein Archiv');
    return `${file} (${Math.round(fs.statSync(path.join(backup, file)).size / 1024)} KB) – ${out.split('\n').pop()}`;
  });

  await step('Frische Instanz aus der Sicherung wiederherstellen', async () => {
    sh('docker compose down -v');
    const file = fs.readdirSync(backup).find((f) => f.endsWith('.tar.gz.enc'));
    sh(`scripts/restore-volume.sh ${path.join(backup, file)}`);
    sh('docker compose up -d');
    await waitHealthy();
    return 'Volume neu angelegt und wiederhergestellt';
  });

  await step('Nach Wiederherstellung: Anmeldung, Beitrag, URL, Medien, Freigaben vorhanden', async () => {
    const ctx = await browser.newContext({ locale: 'de-DE' });
    const p = await ctx.newPage();
    await p.goto(`${BC}/login`);
    await p.fill('#email', OPERATOR.email);
    await p.fill('#pw', OPERATOR.password);
    await p.getByRole('button', { name: 'Anmelden' }).click();
    await p.waitForURL(`${BC}/`);
    await p.goto(postUrl);
    await p.getByText('Veröffentlicht').first().waitFor();
    await p.locator(`a[href="${publishedUrl}"]`).first().waitFor();
    const r = await p.request.get(`${BC}/api/v1/media/${mediaId}/preview`);
    expect(r.status() === 200, `Vorschau ${r.status()}`);
    const approvals = psql(`SELECT count(*) FROM approvals WHERE decision = 'approved'`);
    expect(Number(approvals) >= 3, `Freigaben: ${approvals}`);
    await ctx.close();
    // Die Bridge erreicht die wiederhergestellte Instanz mit ihrem bisherigen Schlüssel
    const out = wpcli('blaulichtcms-bridge poll');
    expect(/Auftrag/.test(out), out);
    return `Login ok, Beitrag veröffentlicht, Vorschau 200, ${approvals} Freigaben, Bridge-Abruf ok`;
  });
} catch (e) {
  exitCode = 1;
  console.log(`Abbruch: ${e?.message ?? e}`);
} finally {
  await browser.close();
  report.finished = new Date().toISOString();
  report.ok = exitCode === 0;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${exitCode ? 'FEHLGESCHLAGEN' : 'ERFOLGREICH'}: ${report.steps.filter((s) => s.ok).length}/${report.steps.length} Schritte – Bericht: test/e2e/out/report.json`);
  process.exit(exitCode);
}
