/**
 * Abnahmetest Meilenstein 3 – Warnentwurf über Container und Browser (Handy).
 *
 *  1. Stichwort, Lagefragen und Testregeln anlegen; fachliche Freigabe durch eine andere Person
 *  2. Erstmeldung im Handy-Wizard: Stichwort suchen, Lage beantworten, Vorschlag sehen
 *  3. Warnstufe durch berechtigte Person bestätigen (Abweichung mit Begründung)
 *  4. Einreichen, Freigabe der PDF-Fassung, PDF enthält die bestätigte Stufe
 *  5. Versand ausschließlich an ein lokales Test-Postfach (Testmodus)
 *  6. Fehlversand und unbekanntes Ergebnis simulieren
 *  7. Entwarnung ohne Stufe
 *
 * Es wird nichts an echte Empfänger versendet: Der SMTP-Server ist ein lokaler Testserver in diesem Skript.
 * Aufruf: node test/e2e/m3-flow.mjs   (setzt das Volume zurück!)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { BC, ROOT, expect, freshInstance, inviteUser, makeReport, sh } from './lib/common.mjs';

const require = createRequire(path.join(ROOT, 'server/package.json'));
const { chromium, devices } = require('playwright');
const { SMTPServer } = require('smtp-server');
const OUT = path.join(ROOT, 'test/e2e/out/m3');
fs.mkdirSync(OUT, { recursive: true });
const { step, finish } = makeReport(path.join(OUT, 'report.json'));

const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Sicheres-Testkennwort-2026' };
const TEST_BOX = 'test-postfach@example.org';
const pdfText = (buf, name) => {
  const f = path.join(OUT, name);
  fs.writeFileSync(f, buf);
  return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
};

/* Lokales Test-Postfach */
let mode = 'accept';
const inbox = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  logger: false,
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      if (mode === 'reject') return cb(Object.assign(new Error('Abgelehnt (Test)'), { responseCode: 550 }));
      if (mode === 'hang') return;
      inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString() });
      cb();
    });
  },
});
await new Promise((r) => smtp.listen(2525, '0.0.0.0', r));

const browser = await chromium.launch();
let ok = true;
async function contextFor(api, opts = {}) {
  const ctx = await browser.newContext({ locale: 'de-DE', ...devices['Pixel 7'], ...opts });
  await ctx.addCookies(api.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
  return ctx;
}
const waitSend = async (api, id, want) => {
  for (let i = 0; i < 100; i++) {
    const d = await api.get(`/warnings/${id}`);
    if (d.sends[0] && want.includes(d.sends[0].status)) return d.sends[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Versandstatus nicht erreicht');
};

try {
  let admin, author, approver, sender, keywordId, respId;
  await step('Frische Instanz, Rollen, Test-Postfach im Testmodus', async () => {
    ({ api: admin } = await freshInstance({ admin: ADMIN }));
    author = await inviteUser(admin, 'warnentwurf@example.org', ['warning_author'], 'Jo Entwurf', 'Entwurf-Testkennwort-2026');
    approver = await inviteUser(admin, 'warnfreigabe@example.org', ['warning_approver'], 'Uli Freigabe', 'Freigabe-Testkennwort-2026');
    sender = await inviteUser(admin, 'warnversand@example.org', ['warning_sender'], 'Mika Versand', 'Versand-Testkennwort-2026');
    const gw = sh(`docker network inspect blaulichtcms_default -f '{{(index .IPAM.Config 0).Gateway}}'`);
    await admin.put('/warning-settings', { host: gw, port: 2525, security: 'none', user: '', from: 'blaulichtcms@example.org', testMode: true, testRecipient: TEST_BOX });
    respId = (await admin.post('/responsibilities', { name: 'Leitstelle (fiktiv)', area: 'Musterkreis', recipients: ['leitstelle@example.invalid'] })).id;
    return `SMTP-Testserver über ${gw}:2525`;
  });

  await step('Ausgeliefert ohne Regeln; Stichwort, Fragen, Regeln anlegen und fachlich freigeben', async () => {
    expect(sh(`docker compose exec -T blaulichtcms psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms -tAc "SELECT count(*) FROM warning_rules"`) === '0', 'Regeln ab Werk vorhanden');
    keywordId = (await admin.post('/warning-keywords', { code: 'F-WALD-2', label: 'Waldbrand mittel (Test)', aliases: ['waldbrand'] })).id;
    for (const [key, text] of [['rauch_wohngebiet', 'Zieht Rauch in ein Wohngebiet?'], ['evakuierung', 'Ist eine Evakuierung erforderlich?']]) {
      const qq = await admin.post(`/warning-keywords/${keywordId}/questions`, { key, text });
      await approver.post(`/keyword-questions/${qq.id}/approve`);
    }
    const rules = [
      ['Rauch ohne Evakuierung', { rauch_wohngebiet: ['ja'], evakuierung: ['nein'] }, 3],
      ['Evakuierung', { evakuierung: ['ja'] }, 2],
    ];
    for (const [name, conditions, level] of rules) {
      const r = await admin.post('/warning-rules', { keywordId, name, conditions, level, reason: `Testregel ${name} (fiktiv)` });
      await approver.post(`/warning-rules/${r.id}/approve`);
    }
    return '2 Fragen, 2 Regeln freigegeben';
  });

  let caseId;
  await step('Erstmeldung im Handy-Wizard: Stichwort suchen, Lage beantworten, Vorschlag', async () => {
    const ctx = await contextFor(author);
    const p = await ctx.newPage();
    await p.goto(`${BC}/warnungen`);
    await p.getByRole('button', { name: 'Neue Erstmeldung' }).click();
    await p.waitForURL(/\/warnungen\/[0-9a-f-]{36}$/);
    caseId = p.url().split('/').pop();
    await p.screenshot({ path: path.join(OUT, '01-vorgang.png') });
    await p.getByRole('button', { name: 'Weiter' }).click();
    await p.getByLabel('Stichwort suchen').fill('waldbr');
    await p.getByRole('button', { name: /F-WALD-2/ }).click();
    await p.locator('fieldset', { hasText: 'Wohngebiet' }).getByRole('button', { name: 'ja' }).click();
    await p.locator('fieldset', { hasText: 'Evakuierung' }).getByRole('button', { name: 'nein' }).click();
    await p.getByText('Vorschlag: Warnstufe 3').waitFor({ timeout: 8000 }).catch(async (e) => {
      await p.screenshot({ path: path.join(OUT, 'fehler-vorschlag.png'), fullPage: true });
      throw e;
    });
    await p.screenshot({ path: path.join(OUT, '02-stichwort-vorschlag.png'), fullPage: true });
    await p.getByRole('button', { name: 'Speichern' }).click();
    await p.getByRole('button', { name: 'Gespeichert' }).waitFor();
    await p.getByRole('button', { name: 'Weiter' }).click();
    const iso = (h) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 16);
    await p.getByLabel('Betroffenes Gebiet').fill('Musterstadt, Ortsteil Nord (fiktiv)');
    await p.getByLabel('Beginn').fill(iso(0));
    await p.getByLabel('Gültig bis').fill(iso(6));
    await p.getByText('Leitstelle (fiktiv)').click();
    await p.getByRole('button', { name: 'Weiter' }).click();
    await p.getByLabel('Überschrift').fill('Starke Rauchentwicklung (Übung)');
    await p.getByLabel('Lagebeschreibung').fill('Fiktive Lage für den Abnahmetest.');
    await p.getByLabel('Verhaltensempfehlungen').fill('Fenster und Türen geschlossen halten.');
    await p.getByLabel('Absender').fill('Musterorganisation');
    await p.getByLabel('Rückrufkontakt').fill('Testperson, 0000 000000');
    await p.screenshot({ path: path.join(OUT, '03-inhalt.png'), fullPage: true });
    await p.getByRole('button', { name: 'Weiter' }).click();
    await p.getByText('Die Warnstufe ist noch nicht bestätigt.').first().waitFor();
    const d = await author.get(`/warnings/${caseId}`);
    expect(d.revision.suggestion.level === 3, 'Vorschlag fehlt');
    expect(d.revision.level_decision === null, 'Stufe darf nicht automatisch bestätigt sein');
    const sends = await author.get(`/warnings/${caseId}`).then((x) => x.sends.length);
    expect(sends === 0 && inbox.length === 0, 'Vorschlag hat Versand ausgelöst');
    await ctx.close();
    return `${d.warning.case_no}, Fassung ${d.revision.number}, Vorschlag Stufe 3, kein Versand`;
  });

  await step('Warnstufe bestätigen: Abweichung nur mit Begründung', async () => {
    const ctx = await contextFor(approver);
    const p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/${caseId}`);
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Stichwort & Warnstufe/ }).click();
    await p.getByRole('radio', { name: /Warnstufe 2/ }).click();
    const btn = p.getByRole('button', { name: 'Abweichende Stufe bestätigen' });
    expect(await btn.isDisabled(), 'Abweichung ohne Begründung möglich');
    await p.getByLabel('Begründung der Abweichung').fill('Wind dreht Richtung Innenstadt (fiktiv).');
    await btn.click();
    await p.getByText('Bestätigt: Warnstufe 2').waitFor();
    await p.screenshot({ path: path.join(OUT, '04-stufe-bestaetigt.png'), fullPage: true });
    await ctx.close();
    const d = await approver.get(`/warnings/${caseId}`);
    expect(d.revision.level_decision.level === 2 && d.revision.level_decision.changed, 'Entscheidung nicht gespeichert');
    return 'Stufe 2 statt Vorschlag 3, begründet';
  });

  let pdfSha;
  await step('Einreichen, PDF-Fassung freigeben, PDF enthält die bestätigte Stufe', async () => {
    let ctx = await contextFor(author);
    let p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/${caseId}`);
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Prüfen & PDF/ }).click();
    await p.getByRole('button', { name: 'Zur Freigabe einreichen' }).click();
    await p.getByText('Zur Freigabe', { exact: true }).first().waitFor();
    await ctx.close();
    ctx = await contextFor(approver);
    p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/${caseId}`);
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Prüfen & PDF/ }).click();
    await p.getByRole('button', { name: 'PDF-Fassung freigeben' }).click();
    await p.getByText(/Freigegeben von Uli Freigabe/).waitFor();
    await p.screenshot({ path: path.join(OUT, '05-freigegeben.png'), fullPage: true });
    await ctx.close();
    const d = await approver.get(`/warnings/${caseId}`);
    pdfSha = d.approval.pdf_sha256;
    const r = await fetch(`${BC}/api/v1/warnings/${caseId}/approvals/${d.approval.id}/pdf`, { headers: { cookie: approver.cookie } });
    const text = pdfText(Buffer.from(await r.arrayBuffer()), 'freigabe.pdf');
    expect(text.includes('Warnstufe 2') && text.includes(d.warning.case_no) && !text.includes('ENTWURF'), 'PDF-Inhalt falsch');
    sh(`pdftoppm -png -r 60 -f 1 -l 1 ${path.join(OUT, 'freigabe.pdf')} ${path.join(OUT, '06-pdf')}`);
    return `PDF ${pdfSha.slice(0, 16)}…`;
  });

  await step('Versand im Testmodus ausschließlich an das Test-Postfach', async () => {
    const ctx = await contextFor(sender);
    const p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/${caseId}`);
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Versand/ }).click();
    await p.getByText('Testmodus aktiv').waitFor({ timeout: 8000 }).catch(async (e) => {
      await p.screenshot({ path: path.join(OUT, 'fehler-versand.png'), fullPage: true });
      throw e;
    });
    await p.getByText('Empfänger und PDF geprüft').click();
    await p.getByRole('button', { name: 'Jetzt versenden' }).click();
    const s = await waitSend(sender, caseId, ['accepted', 'failed', 'unknown']);
    expect(s.status === 'accepted', `Status ${s.status}: ${s.error}`);
    await p.reload();
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Versand/ }).click();
    await p.getByText('Vom Mailserver angenommen').first().waitFor();
    await p.screenshot({ path: path.join(OUT, '07-versendet.png'), fullPage: true });
    await ctx.close();
    expect(inbox.length === 1 && inbox[0].to.join() === TEST_BOX, 'Mail nicht (nur) im Test-Postfach');
    expect(/X-BlaulichtCMS-Pdf-Sha256:\s+/i.test(inbox[0].raw) && inbox[0].raw.replace(/\r?\n /g, ' ').includes(pdfSha), 'PDF-Prüfsumme fehlt im Mailkopf');
    expect(!inbox.some((m) => m.to.includes('leitstelle@example.invalid')), 'Mail an operativen Empfänger');
    return `1 Mail an ${TEST_BOX}, Betreff mit [TEST]`;
  });

  await step('Aktualisierung: bisherige Stufe sichtbar, Fehlversand (550) und Wiederholung', async () => {
    const u = await author.post('/warnings', { kind: 'update', parentId: caseId });
    let d = await author.get(`/warnings/${u.id}`);
    expect(d.previousLevel.level === 2 && d.revision.level_decision === null, 'Stufe übernommen statt neu zu bestätigen');
    await approver.post(`/warnings/${u.id}/level`, { revision: d.revision.number, level: 2, reason: 'Lage unverändert ernst (fiktiv).' });
    await author.post(`/warnings/${u.id}/submit`, { revision: d.revision.number + 1 });
    d = await approver.get(`/warnings/${u.id}`);
    await approver.post(`/warnings/${u.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    d = await approver.get(`/warnings/${u.id}`);
    mode = 'reject';
    await sender.post(`/warnings/${u.id}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    const f = await waitSend(sender, u.id, ['failed', 'unknown', 'accepted']);
    expect(f.status === 'failed', `erwartet failed, war ${f.status}`);
    mode = 'accept';
    await sender.post(`/warnings/${u.id}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    const a = await waitSend(sender, u.id, ['accepted', 'failed', 'unknown']);
    expect(a.status === 'accepted', 'Wiederholung nicht angenommen');
    return 'failed → erneut versendet → angenommen';
  });

  await step('Entwarnung ohne Stufe; unbekanntes Versandergebnis sperrt den Neuversand', async () => {
    const e = await author.post('/warnings', { kind: 'all_clear', parentId: caseId });
    let d = await author.get(`/warnings/${e.id}`);
    await author.post(`/warnings/${e.id}/submit`, { revision: d.revision.number });
    d = await approver.get(`/warnings/${e.id}`);
    await approver.post(`/warnings/${e.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    d = await approver.get(`/warnings/${e.id}`);
    expect(d.revision.level_decision === null, 'Entwarnung hat Stufe');
    const r = await fetch(`${BC}/api/v1/warnings/${e.id}/approvals/${d.approval.id}/pdf`, { headers: { cookie: approver.cookie } });
    const text = pdfText(Buffer.from(await r.arrayBuffer()), 'entwarnung.pdf');
    expect(text.includes('ENTWARNUNG') && !text.includes('(bestätigt)'), 'Entwarnungs-PDF falsch');
    mode = 'hang';
    await sender.post(`/warnings/${e.id}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    const unk = await waitSend(sender, e.id, ['unknown', 'failed', 'accepted']);
    mode = 'accept';
    expect(unk.status === 'unknown', `erwartet unknown, war ${unk.status}`);
    let blocked = false;
    try {
      await sender.post(`/warnings/${e.id}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    } catch (err) {
      blocked = err.status === 409;
    }
    expect(blocked, 'Neuversand trotz unbekanntem Ergebnis möglich');
    const ctx = await contextFor(sender);
    const p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/${e.id}`);
    await p.getByRole('navigation', { name: 'Schritte' }).getByRole('button', { name: /Versand/ }).click();
    await p.getByText('Versandergebnis unbekannt – bitte prüfen').waitFor();
    await p.screenshot({ path: path.join(OUT, '08-versand-unklar.png'), fullPage: true });
    await ctx.close();
    return 'Entwarnung ohne Stufe, Versand „unbekannt“ gesperrt bis zur Prüfung';
  });

  await step('Desktop: Pflege von Stichwörtern und Regeln', async () => {
    const ctx = await browser.newContext({ locale: 'de-DE', viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(admin.cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), url: BC })));
    const p = await ctx.newPage();
    await p.goto(`${BC}/warnungen/pflege`);
    await p.getByRole('tab', { name: /Regeln/ }).click();
    await p.getByText('Fachlich freigegeben').first().waitFor();
    await p.screenshot({ path: path.join(OUT, '09-regeln.png'), fullPage: true });
    await p.goto(`${BC}/warnungen`);
    await p.screenshot({ path: path.join(OUT, '10-liste.png') });
    await ctx.close();
  });
} catch {
  ok = false;
} finally {
  await browser.close();
  smtp.close();
  finish(ok);
  process.exit(ok ? 0 : 1);
}
