/**
 * Kernabläufe im echten Browser (#219) – der kleine Satz, der in der CI läuft:
 *   1. Ersteinrichtung über die Einrichtungsseite, Zwei-Faktor einrichten (Wiederherstellungscodes), Dashboard
 *   2. Abmelden und neu anmelden mit Passwort und Code aus der Authenticator-App
 *   3. Beitrag anlegen, Text speichern, zur Freigabe einreichen (Redaktion) → freigeben (Administration, Vier-Augen)
 *   4. Workflow aus einer Vorlage anlegen, offene Plätze direkt im Workflow anlegen, speichern und testen
 *
 * Voraussetzungen: eine FRISCHE, laufende Instanz (Ersteinrichtung noch offen) und Playwright mit Chromium
 * (`npm ci --prefix test/e2e`, dann `npx --prefix test/e2e playwright install chromium`). Aufruf aus dem
 * Repository-Wurzelverzeichnis:
 *   BLAULICHTCMS_URL=http://localhost:7310 SETUP_TOKEN_FILE=<Datenverzeichnis>/setup-token.txt node test/e2e/core-flows.mjs
 * (statt SETUP_TOKEN_FILE auch SETUP_TOKEN=…). Bei einem Fehler landen Bildschirmfoto und Playwright-Trace in
 * test/e2e/out/ (ansehen mit `npx --prefix test/e2e playwright show-trace test/e2e/out/core-<schritt>.zip`).
 * Ergebnis: test/e2e/out/core-report.json, Exit-Code 1 bei Fehlern.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Api, inviteUser, makeReport, sleep, totp } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BC = process.env.BLAULICHTCMS_URL ?? 'http://localhost:7310';
const OUT = path.join(ROOT, 'test/e2e/out');
fs.mkdirSync(OUT, { recursive: true });

const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Admin-Testkennwort-2026' };
const EDITOR = { name: 'Robin Redaktion', email: 'redaktion@example.org', password: 'Redaktion-Testkennwort-2026' };
const TIMEOUT = 15_000;

function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN.trim();
  if (process.env.SETUP_TOKEN_FILE) return fs.readFileSync(process.env.SETUP_TOKEN_FILE, 'utf8').trim();
  throw new Error('SETUP_TOKEN oder SETUP_TOKEN_FILE setzen (frische Instanz nötig)');
}

/** Wartet, bis ein neues TOTP-Zeitfenster beginnt (ein Code gilt nur einmal). */
async function nextTotpWindow() {
  await sleep(30_500 - (Date.now() % 30_000));
}

const cookieHeader = async (ctx) => (await ctx.cookies(BC)).map((c) => `${c.name}=${c.value}`).join('; ');
const toCookies = (header) => header.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC }));

const { step, finish } = makeReport(path.join(OUT, 'core-report.json'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const contexts = [];

/** Neuer Browserkontext mit Trace; bei einem Fehler im Schritt werden Trace und Bildschirmfoto gesichert. */
async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'de-DE', ...opts });
  await ctx.tracing.start({ screenshots: true, snapshots: true });
  ctx.setDefaultTimeout(TIMEOUT);
  contexts.push(ctx);
  return ctx;
}

async function saveEvidence(name) {
  for (const [i, ctx] of contexts.entries()) {
    const suffix = contexts.length > 1 ? `-${i + 1}` : '';
    for (const [k, p] of ctx.pages().entries()) await p.screenshot({ path: path.join(OUT, `core-${name}${suffix}-${k + 1}.png`), fullPage: true }).catch(() => {});
    await ctx.tracing.stop({ path: path.join(OUT, `core-${name}${suffix}.zip`) }).catch(() => {});
    await ctx.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
  }
}

async function run(name, fn) {
  try {
    await step(name, fn);
  } catch (e) {
    await saveEvidence(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40));
    throw e;
  }
}

let ok = false;
try {
  const actx = await newContext();
  const page = await actx.newPage();
  let secret = '';

  await run('Ersteinrichtung im Browser mit Zwei-Faktor', async () => {
    await page.goto(`${BC}/`);
    await page.waitForURL(/\/einrichtung$/);
    await page.locator('#tok').fill(setupToken());
    await page.locator('#org').fill('Musterorganisation');
    await page.locator('#url').fill(BC);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.locator('#name').fill(ADMIN.name);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#pw').fill(ADMIN.password);
    await page.locator('#pw2').fill(ADMIN.password);
    const setupResp = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/mfa/setup') && r.request().method() === 'GET');
    await page.getByRole('button', { name: 'Einrichtung abschließen' }).click();
    await page.waitForURL(/\/2fa\/einrichten$/);
    secret = (await (await setupResp).json()).secret;
    // Der Schlüssel steht auch zum Abtippen auf der Seite (falls der QR-Code nicht gescannt werden kann)
    await page.getByText(secret.replace(/(.{4})/g, '$1 ').trim()).waitFor();
    await page.locator('#totp').fill(totp(secret));
    await page.getByRole('button', { name: 'Aktivieren' }).click();
    await page.getByText('Zwei-Faktor-Anmeldung ist aktiv').waitFor();
    await page.getByRole('button', { name: 'Codes gesichert – weiter' }).click();
    await page.waitForURL(`${BC}/`);
    await page.getByRole('navigation', { name: 'Hauptnavigation' }).first().waitFor();
    return 'Dashboard erreicht';
  });

  await run('Abmelden und Anmelden mit Passwort und Code', async () => {
    await actx.clearCookies();
    await page.goto(`${BC}/login`);
    await page.locator('#email').fill(ADMIN.email);
    await page.locator('#pw').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.waitForURL(/\/2fa$/);
    await nextTotpWindow(); // der Code der Einrichtung ist verbraucht
    await page.locator('#code').fill(totp(secret));
    await page.getByRole('button', { name: 'Bestätigen' }).click();
    await page.waitForURL(`${BC}/`);
    await page.getByRole('navigation', { name: 'Hauptnavigation' }).first().waitFor();
    return 'angemeldet';
  });

  // API-Sitzung der Administration (für das Einladen der Redaktion), mit derselben Sitzung wie im Browser
  const admin = new Api();
  admin.cookie = await cookieHeader(actx);
  admin.reauth = { password: ADMIN.password, totpSecret: secret };

  let postId = '';
  await run('Beitrag anlegen, speichern und einreichen (Redaktion)', async () => {
    const editor = await inviteUser(admin, EDITOR.email, ['editor'], EDITOR.name, EDITOR.password);
    const ectx = await newContext();
    await ectx.addCookies(toCookies(editor.cookie));
    const ep = await ectx.newPage();
    await ep.goto(`${BC}/beitraege`);
    // Seitenkopf; bei leerer Liste bietet die Leermeldung denselben Knopf noch einmal an (#260) – je nach Ladezeit zwei Treffer
    await ep.getByRole('button', { name: 'Neuer Beitrag' }).first().click();
    await ep.locator('#p-title').fill('Übung am Wochenende');
    await ep.getByRole('dialog').getByRole('button', { name: 'Anlegen' }).click();
    await ep.waitForURL(/\/beitraege\/[0-9a-f-]{36}$/);
    postId = ep.url().split('/').pop();
    await ep.locator('#e-body').fill('Am Samstag üben wir gemeinsam mit den Nachbarwehren.\n\nZuschauer sind willkommen.');
    // Speichern-Leiste (#262): verschwindet nach dem Speichern, oben steht dann leise „Gespeichert …“
    await ep.locator('[data-save-bar]').getByRole('button', { name: 'Neue Fassung speichern' }).click();
    await ep.locator('[data-save-bar]').waitFor({ state: 'detached' });
    await ep.getByText(/Gespeichert \d/).first().waitFor();
    // Einreichen zeigt zuerst die Prüfliste (intern ohne Ziel: Hinweis, kein Hindernis)
    await ep.getByRole('button', { name: 'Zur Freigabe einreichen' }).click();
    const check = ep.getByRole('dialog', { name: 'Zur Freigabe einreichen' });
    await check.getByText('Kein Veröffentlichungsziel gewählt').waitFor();
    await check.getByRole('button', { name: /^(Trotzdem einreichen|Einreichen)$/ }).click();
    await ep.getByText(/^Eingereicht /).waitFor();
    // Vier-Augen: wer eingereicht hat, sieht keine Freigabe-Schaltfläche (Recht „Beiträge freigeben“ fehlt der Redaktion)
    if (await ep.getByRole('button', { name: 'Freigeben', exact: true }).count()) throw new Error('Redaktion sieht „Freigeben“');
    await ectx.close();
    contexts.splice(contexts.indexOf(ectx), 1);
    return `Beitrag ${postId.slice(0, 8)} eingereicht`;
  });

  await run('Beitrag freigeben (Administration)', async () => {
    await page.goto(`${BC}/freigaben`);
    await page.getByRole('link', { name: /Übung am Wochenende/ }).first().click();
    // Die Freigaben-Liste führt seit #251 in die Prüfansicht der Art (Beitrag: /freigabe/beitrag/<id>?fassung=n)
    await page.waitForURL(new RegExp(`/(beitraege|freigabe/beitrag)/${postId}`));
    await page.getByRole('button', { name: 'Freigeben', exact: true }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('heading', { name: /Fassung \d+ freigeben/ }).waitFor();
    await dlg.locator('#dec-note').fill('Passt so.');
    await dlg.getByRole('button', { name: 'Freigeben', exact: true }).click();
    await dlg.waitFor({ state: 'detached' });
    await page.goto(`${BC}/beitraege/${postId}`);
    await page.getByText(`Freigegeben von ${ADMIN.name}`).waitFor();
    return 'freigegeben';
  });

  await run('Workflow aus Vorlage anlegen und testen', async () => {
    // Voraussetzung (per API): eine aktive FE2-Verbindung – Testmeldung empfangen, getestet, aktiviert
    const conn = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Test', config: {} });
    const c = conn.connection ?? conn;
    const r = await fetch(`${BC}/api/v1/inbound/fe2/${c.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.token}`, 'x-blaulichtcms-test': '1', 'x-blaulichtcms-request': '1' },
      body: JSON.stringify({ einsatz: { id: 'CI-1', stichwort: 'B 2', ort: 'Musterstadt' }, meldung: { alarmtext: 'Fiktiver Testalarm' } }),
    });
    if (!r.ok) throw new Error(`FE2-Testmeldung: ${r.status} ${await r.text()}`);
    if (!(await admin.post(`/connections/${c.id}/test`)).ok) throw new Error('FE2-Verbindungstest nicht bestanden');
    await admin.post(`/connections/${c.id}/activate`);

    await page.goto(`${BC}/workflows`);
    await page.getByRole('button', { name: 'Neuer Workflow' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('label', { hasText: 'Alarm mit Stichwort-Kategorie Brand' }).click();
    if (!(await dlg.locator('#a-name').inputValue()).startsWith('Alarm mit Stichwort-Kategorie Brand')) throw new Error('Name nicht aus der Vorlage übernommen');
    await dlg.getByRole('button', { name: 'Anlegen und öffnen' }).click();
    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}$/);
    // Frische Instanz: Auslöser und Aktion fehlen noch → beide Plätze sind offen und werden direkt hier angelegt
    const main = page.getByRole('main');
    await main.getByText('Offen', { exact: true }).first().waitFor();
    for (const [i, what] of ['Auslöser', 'Aktion'].entries()) {
      await main.getByRole('button', { name: 'Neu anlegen …' }).nth(i).click();
      const d = page.getByRole('dialog');
      // Passen mehrere Arten (Alarm: FE2 oder Feuersoftware), fragt der Dialog zuerst nach der Art
      const title = d.getByRole('heading').first();
      await title.waitFor();
      if (/Art wählen/.test(await title.innerText())) await d.getByRole('button', { name: /^FE2-Alarm/ }).click();
      await d.getByRole('button', { name: 'Speichern' }).waitFor();
      const connSelect = d.getByLabel('Verbindung', { exact: true });
      if (await connSelect.count()) await connSelect.selectOption({ label: 'FE2 Test' });
      await d.getByRole('button', { name: 'Speichern' }).click();
      await d.waitFor({ state: 'hidden' });
      console.log(`  · ${what} angelegt`);
    }
    if (await main.getByText('Offen', { exact: true }).count()) throw new Error('Plätze nach dem Anlegen noch offen');
    await page.getByRole('button', { name: 'Testlauf' }).click();
    const t = page.getByRole('dialog');
    await t.getByRole('button', { name: 'Testlauf starten' }).click();
    await t.getByRole('button', { name: 'Erneut testen' }).waitFor();
    await t.getByRole('button', { name: 'Schließen' }).first().click();
    await page.getByText('Getestet', { exact: true }).first().waitFor();
    return 'getestet';
  });
  ok = true;
} catch (e) {
  console.error(e);
} finally {
  finish(ok);
  await browser.close();
  process.exit(ok ? 0 : 1);
}
