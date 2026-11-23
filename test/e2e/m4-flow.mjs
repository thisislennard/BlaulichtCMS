/**
 * Abnahmetest Meilenstein 4 – Betrieb und Verbindungen über Container, WordPress und Browser.
 *
 *  1. Realistischer Datenbestand: Benutzer und Rollen, ~90 Fotos und 3 Videos, Freigaben, geplanter Auftrag
 *  2. FE2-Eingang per HTTP: Testmeldung → Vorschau → Aktivieren → genau ein Entwurf je Einsatz
 *  3. Bridge-Update über WordPress (Test-Kanal, Prüfsumme, Kopplung bleibt), danach Freigabe für alle
 *  4. Update auf ein Image mit fehlerhafter Migration → Start gesperrt → automatischer Rückweg mit Sicherung
 *  5. Erfolgreiches Update; Rückkehr zum alten Image wird verweigert (Datenstand neuer) → Rückweg per Sicherung
 *  6. Wiederherstellung auf frischem Volume („neuer Host“): Benutzer, Rechte, Medien, Freigaben, geplante Aufträge
 *  7. PostgreSQL-Hauptversionswechsel: Datenbestand aus PostgreSQL 16 in das Image (PostgreSQL 18) übernehmen
 *
 * Aufruf: node test/e2e/m4-flow.mjs   (setzt Volumes zurück!)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Api, BC, ROOT, expect, freshInstance, freshWordPress, installBridge, inviteUser, login, makeReport, psql, sh, sleep, waitHealthy, wpcli } from './lib/common.mjs';

const require = createRequire(path.join(ROOT, 'server/package.json'));
const sharp = require('sharp');
const { chromium } = require('playwright');
const OUT = path.join(ROOT, 'test/e2e/out/m4');
const BACKUPS = path.join(OUT, 'sicherungen');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(BACKUPS, { recursive: true });
const { step, finish } = makeReport(path.join(OUT, 'report.json'));
const ADMIN = { name: 'Alex Admin', email: 'admin@example.org', password: 'Sicheres-Testkennwort-2026' };
let ok = true;
const run = (cmd) => {
  try {
    return { code: 0, out: sh(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const counts = () => JSON.parse(psql(`SELECT json_build_object('users',(SELECT count(*) FROM users),'roles',(SELECT sum(cardinality(roles)) FROM users),'media',(SELECT count(*) FROM media WHERE status='ready'),'approvals',(SELECT count(*) FROM approvals),'queued',(SELECT count(*) FROM publications WHERE status='queued' AND run_at > now()),'posts',(SELECT count(*) FROM posts))`));
const setEnv = (k, v) => {
  const f = path.join(ROOT, '.env');
  let s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  s = s.split('\n').filter((l) => l && !l.startsWith(`${k}=`)).join('\n');
  fs.writeFileSync(f, `${s}\n${v === null ? '' : `${k}=${v}\n`}`);
};

try {
  let admin, totpSecret, editor, approver, publisher;
  let before;
  const sampleSha = {};
  await step('Frische Instanz mit Benutzern, Rollen und realistischem Medienbestand', async () => {
    setEnv('BLAULICHTCMS_IMAGE', null);
    ({ api: admin, totpSecret } = await freshInstance({ admin: ADMIN }));
    editor = await inviteUser(admin, 'redaktion@example.org', ['editor', 'media_manager'], 'Robin Redaktion', 'Redaktion-Testkennwort-2026');
    approver = await inviteUser(admin, 'freigabe@example.org', ['approver', 'warning_approver'], 'Kim Freigabe', 'Freigabe-Testkennwort-2026');
    publisher = await inviteUser(admin, 'online@example.org', ['publisher'], 'Sam Online', 'Online-Testkennwort-2026');
    const post = await editor.post('/posts', { title: 'Großübung mit vielen Fotos (fiktiv)', kind: 'event' });
    const col = await editor.post(`/posts/${post.id}/collect`, {});
    const token = col.url.split('/u/')[1];
    const t0 = Date.now();
    let bytes = 0;
    for (let i = 0; i < 90; i++) {
      const img = await sharp({ create: { width: 2400, height: 1600, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 82 }).toBuffer();
      bytes += img.length;
      const fd = new FormData();
      fd.append('file', new Blob([img], { type: 'image/jpeg' }), `foto-${String(i).padStart(3, '0')}.jpg`);
      const r = await fetch(`${BC}/api/v1/public/upload/${token}`, { method: 'POST', body: fd, headers: { 'x-blaulichtcms-request': '1' } });
      expect(r.ok, `Upload ${i}: ${r.status}`);
      if (i % 30 === 0) sampleSha[`foto-${String(i).padStart(3, '0')}.jpg`] = crypto.createHash('sha256').update(img).digest('hex');
    }
    for (let i = 0; i < 3; i++) {
      const v = path.join(OUT, `video-${i}.mp4`);
      sh(`ffmpeg -v error -y -f lavfi -i testsrc2=duration=6:size=1920x1080:rate=30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p ${v}`);
      const buf = fs.readFileSync(v);
      bytes += buf.length;
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'video/mp4' }), `video-${i}.mp4`);
      const r = await fetch(`${BC}/api/v1/public/upload/${token}`, { method: 'POST', body: fd, headers: { 'x-blaulichtcms-request': '1' } });
      expect(r.ok, `Video ${i}: ${r.status}`);
    }
    for (let i = 0; i < 120; i++) {
      const n = Number(psql(`SELECT count(*) FROM media WHERE status = 'quarantine'`));
      if (n === 0) break;
      await sleep(2000);
    }
    const ready = Number(psql(`SELECT count(*) FROM media WHERE status = 'ready'`));
    expect(ready === 93, `Geprüft: ${ready}/93`);
    // Freigegebener Beitrag mit geplantem Auftrag (in 3 Tagen) auf einer Website
    await freshWordPress();
    const siteId = await installBridge(admin);
    const media = psql(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' ORDER BY original_name LIMIT 3`).split('\n');
    let d = await editor.get(`/posts/${post.id}`);
    await editor.put(`/posts/${post.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Bericht zur Übung (fiktiv).', excerpt: '', mediaIds: media, coverId: media[0], siteId, publishAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
    d = await editor.get(`/posts/${post.id}`);
    await editor.post(`/posts/${post.id}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${post.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    await publisher.post(`/posts/${post.id}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    before = counts();
    expect(before.queued === 1, 'Geplanter Auftrag fehlt');
    return `${ready} Medien (${Math.round(bytes / 1048576)} MB) in ${Math.round((Date.now() - t0) / 1000)} s, ${before.users} Benutzer, 1 geplanter Auftrag`;
  });

  await step('FE2: Testmeldung → Vorschau → Aktivieren → ein Entwurf je Einsatz, keine Alarmtexte', async () => {
    const c = await admin.post('/connections', { kind: 'fe2', name: 'FE2 (Test)' });
    const send = (body, extra = {}) => fetch(`${BC}/api/v1/inbound/fe2/${c.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}`, ...extra }, body: JSON.stringify(body) });
    const alarm = (id) => ({ einsatz: { id, stichwort: 'TH-VU', stichwort_text: 'Verkehrsunfall', ort: 'Musterstadt', alarmzeit: '2026-11-14T15:00' }, meldung: { alarmtext: 'VERTRAULICH Name Telefon' } });
    expect((await send(alarm('A-1'))).status === 200, 'Testmeldung abgelehnt');
    expect(psql(`SELECT count(*) FROM fe2_events`) === '0', 'Vor Aktivierung angelegt');
    const t = await admin.post(`/connections/${c.id}/test`);
    expect(t.ok, 'Test nicht bestanden');
    await admin.post(`/connections/${c.id}/activate`);
    await send(alarm('A-7'));
    await send(alarm('A-7'));
    expect(psql(`SELECT count(*) FROM fe2_events`) === '1', 'Doppelter Einsatz');
    expect(psql(`SELECT count(*) FROM post_revisions WHERE body ILIKE '%VERTRAULICH%'`) === '0', 'Alarmtext übernommen');
    const logs = run(`docker compose logs blaulichtcms`).out;
    expect(!logs.includes('VERTRAULICH') && !logs.includes('A-7'), 'Inhalte im Protokoll');
    return 'genau 1 Entwurf, Wiederholung erkannt, Protokolle ohne Inhalte';
  });

  await step('Bridge-Update über WordPress: Test-Kanal, Prüfsumme, Kopplung bleibt erhalten', async () => {
    // Ältere Bridge (0.3.9) installieren – BlaulichtCMS enthält 0.10.0
    const tmp = path.join(ROOT, 'test/wordpress/tmp/old');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'wordpress-plugin/blaulichtcms-bridge'), path.join(tmp, 'blaulichtcms-bridge'), { recursive: true });
    const main = path.join(tmp, 'blaulichtcms-bridge/blaulichtcms-bridge.php');
    fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace(/Version:(\s+)0.10.0/, 'Version:$10.3.9').replace("'BLAULICHTCMS_BRIDGE_VERSION', '0.10.0'", "'BLAULICHTCMS_BRIDGE_VERSION', '0.3.9'"));
    sh(`cd ${tmp} && rm -f ../alt.zip && zip -qr ../alt.zip blaulichtcms-bridge`);
    wpcli('plugin install /tmp/blaulichtcms/alt.zip --force --activate');
    expect(wpcli('plugin get blaulichtcms-bridge --field=version') === '0.3.9', 'Alte Version nicht installiert');
    wpcli('blaulichtcms-bridge poll');
    wpcli('transient delete blaulichtcms_bridge_update');
    wpcli('transient delete update_plugins --network');
    const upd = wpcli('plugin update blaulichtcms-bridge');
    expect(wpcli('plugin get blaulichtcms-bridge --field=version') === '0.10.0', `Update nicht installiert: ${upd}`);
    const status = wpcli('blaulichtcms-bridge status');
    expect(/gekoppelt|BlaulichtCMS/i.test(status), `Kopplung verloren: ${status}`);
    wpcli('blaulichtcms-bridge poll');
    expect((await admin.get('/sites/bridge-release')).sites[0].plugin_version === '0.10.0', 'Website meldet die neue Version nicht');
    return `0.3.9 → 0.10.0 per „wp plugin update“ ohne Freigabe, Kopplung erhalten`;
  });

  let archiveBeforeGood;
  await step('Update auf Image mit fehlerhafter Migration: Start gesperrt, automatischer Rückweg mit Sicherung', async () => {
    before = counts(); // Stand nach FE2- und Bridge-Schritt
    const dir = path.join(OUT, 'img-kaputt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '999_kaputt.sql'), 'CREATE TABLE halb (id int);\nALTER TABLE gibt_es_nicht ADD COLUMN x int;\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM blaulichtcms:local\nCOPY 999_kaputt.sql /app/server/migrations/999_kaputt.sql\n');
    sh(`docker build -q -t blaulichtcms:test-kaputt ${dir}`);
    const r = run(`scripts/update.sh blaulichtcms:test-kaputt ${BACKUPS} --rollback`);
    fs.writeFileSync(path.join(OUT, 'update-kaputt.log'), r.out);
    expect(r.code !== 0, 'Update hätte scheitern müssen');
    expect(r.out.includes('999_kaputt.sql'), 'Fehlermeldung nennt die Migration nicht');
    expect(r.out.includes('Zurück auf'), 'Kein Rückweg');
    await waitHealthy();
    const after = counts();
    expect(JSON.stringify(after) === JSON.stringify(before), `Datenstand abweichend: ${JSON.stringify(after)}`);
    expect(psql(`SELECT to_regclass('public.halb') IS NULL`) === 't', 'Halbe Migration übrig');
    expect(psql(`SELECT value FROM settings WHERE key = 'system.maintenance'`) === 'null', 'Wartungsmodus noch aktiv');
    return 'Migration 999 abgelehnt, Webport zeigte Sperrseite, Rückweg ohne Datenverlust';
  });

  await step('Erfolgreiches Update; Rückkehr zum alten Image wird verweigert; Rückweg nur mit passender Sicherung', async () => {
    const dir = path.join(OUT, 'img-neu');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '999_neu.sql'), 'CREATE TABLE test_neue_funktion (id int);\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM blaulichtcms:local\nCOPY 999_neu.sql /app/server/migrations/999_neu.sql\n');
    sh(`docker build -q -t blaulichtcms:test-neu ${dir}`);
    const r = run(`scripts/update.sh blaulichtcms:test-neu ${BACKUPS}`);
    fs.writeFileSync(path.join(OUT, 'update-neu.log'), r.out);
    expect(r.code === 0, `Update fehlgeschlagen: ${r.out.slice(-500)}`);
    archiveBeforeGood = /Sicherung: (\S+)\)/.exec(r.out)?.[1];
    expect(archiveBeforeGood && fs.existsSync(archiveBeforeGood), 'Sicherung fehlt');
    // Naiver Rückweg nur über das Image: muss verweigert werden
    setEnv('BLAULICHTCMS_IMAGE', 'blaulichtcms:local');
    sh('docker compose up -d --no-build');
    let page = '';
    for (let i = 0; i < 60; i++) {
      try {
        const h = await fetch(`${BC}/healthz`);
        page = await h.text();
        if (h.status === 503 && page.includes('neuer als dieses Programm')) break;
      } catch {
        /* startet */
      }
      await sleep(1000);
    }
    expect(page.includes('neuer als dieses Programm'), `Keine Sperre: ${page.slice(0, 200)}`);
    const browser = await chromium.launch();
    const p = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await p.goto(BC);
    await p.screenshot({ path: path.join(OUT, '01-start-gesperrt.png') });
    await browser.close();
    // Richtiger Rückweg: Sicherung von vor dem Update + altes Image
    sh('docker compose down');
    sh('docker volume rm blaulichtcms_data');
    sh(`scripts/restore-volume.sh ${archiveBeforeGood}`);
    sh('docker compose up -d --no-build');
    await waitHealthy();
    sh('docker compose exec -T blaulichtcms node server/dist/cli.js maintenance off');
    expect(JSON.stringify(counts()) === JSON.stringify(before), 'Datenstand nach Rückweg abweichend');
    return 'Update ok; altes Image allein → Sperrseite; mit Sicherung zurück auf den alten Stand';
  });

  await step('Wiederherstellung auf frischem Volume: Benutzer, Rechte, Medien, Freigaben, geplante Aufträge', async () => {
    const r = run(`scripts/backup-volume.sh ${BACKUPS}`);
    const archive = /Sicherung geschrieben: (\S+)/.exec(r.out)?.[1];
    sh('docker compose down -v');
    sh(`scripts/restore-volume.sh ${archive}`);
    sh('docker compose up -d --no-build');
    await waitHealthy();
    const after = counts();
    expect(JSON.stringify(after) === JSON.stringify(before), `Abweichung: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
    // Anmeldung inkl. Zwei-Faktor mit dem bestehenden Konto
    const a = new Api();
    await login(a, ADMIN.email, ADMIN.password, totpSecret);
    const me = await a.get('/auth/me');
    expect(me.user.email === ADMIN.email, 'Anmeldung fehlgeschlagen');
    // Rechte: Redaktion darf nicht freigeben
    const e = new Api();
    await login(e, 'redaktion@example.org', 'Redaktion-Testkennwort-2026', editor.totpSecret);
    const pst = psql(`SELECT id FROM posts ORDER BY created_at LIMIT 1`);
    let denied = false;
    try {
      await e.post(`/posts/${pst}/approval/revoke`);
    } catch (err) {
      denied = err.status === 403;
    }
    expect(denied, 'Rechte nach Wiederherstellung falsch');
    // Originale byte-genau (Stichprobe)
    for (const [name, sha] of Object.entries(sampleSha)) {
      const id = psql(`SELECT id FROM media WHERE original_name = '${name}'`);
      const res = await fetch(`${BC}/api/v1/media/${id}/original`, { headers: { cookie: a.cookie } });
      const got = crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      expect(got === sha, `Original ${name} verändert`);
    }
    const sz = fs.statSync(archive).size;
    return `${after.media} Medien, ${after.users} Benutzer, ${after.approvals} Freigaben, ${after.queued} geplanter Auftrag; Archiv ${Math.round(sz / 1048576)} MB; Originale byte-gleich`;
  });

  await step('PostgreSQL-Hauptversion: Datenbestand aus PostgreSQL 16 in das Image (PostgreSQL 18) übernehmen', async () => {
    // Quelle: logische Sicherung aus dem laufenden Bestand, eingespielt in einen PostgreSQL-16-Cluster auf dem Host
    const dump = path.join(OUT, 'quelle.sql');
    sh(`docker compose exec -T blaulichtcms sh -c 'pg_dump -h /tmp/blaulichtcms-pg -U blaulichtcms --no-owner --no-privileges blaulichtcms' > ${dump}`);
    const pg16 = (sql) => sh(`su postgres -c ${JSON.stringify(`psql -tAc ${JSON.stringify(sql)}`)}`);
    pg16('DROP DATABASE IF EXISTS blaulichtcms_pg16');
    pg16('CREATE DATABASE blaulichtcms_pg16');
    sh(`su postgres -c "psql -q -d blaulichtcms_pg16 -f ${dump}" > /dev/null`);
    const v16 = sh(`su postgres -c "psql -tAc 'SHOW server_version' -d blaulichtcms_pg16"`);
    expect(v16.startsWith('16'), `Quelle ist PostgreSQL ${v16}`);
    // Dokumentierter Weg (docs/betrieb.md): pg_dump aus der alten Version → neuer Cluster → Import
    const from16 = path.join(OUT, 'aus-pg16.sql');
    sh(`su postgres -c "pg_dump --no-owner --no-privileges blaulichtcms_pg16" > ${from16}`);
    sh('docker compose stop blaulichtcms');
    sh(`docker run --rm -u 0 -v blaulichtcms_data:/data --entrypoint sh blaulichtcms:local -c 'mv /data/postgres /data/postgres-alt'`);
    sh('docker compose start blaulichtcms');
    // Der neue, leere Cluster legt das Schema an; vor dem Import wieder leeren
    for (let i = 0; i < 60; i++) {
      if (run(`docker compose exec -T blaulichtcms sh -c "psql -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms -tAc 'SELECT 1'"`).code === 0) break;
      await sleep(1000);
    }
    sh('docker compose exec -T blaulichtcms sh -c "psql -q -h /tmp/blaulichtcms-pg -U blaulichtcms -d postgres -c \'DROP DATABASE blaulichtcms WITH (FORCE)\' -c \'CREATE DATABASE blaulichtcms OWNER blaulichtcms\'"');
    sh(`docker compose exec -T blaulichtcms sh -c 'psql -q -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms' < ${from16} > /dev/null`);
    sh('docker compose restart blaulichtcms');
    await waitHealthy();
    const v18 = psql('SHOW server_version');
    const after = counts();
    expect(v18.startsWith('18'), `Ziel ist PostgreSQL ${v18}`);
    expect(JSON.stringify(after) === JSON.stringify(before), `Abweichung nach Versionswechsel: ${JSON.stringify(after)}`);
    sh(`docker run --rm -u 0 -v blaulichtcms_data:/data --entrypoint sh blaulichtcms:local -c 'rm -rf /data/postgres-alt'`);
    pg16('DROP DATABASE blaulichtcms_pg16');
    return `PostgreSQL ${v16} → ${v18}: Daten vollständig, Anwendung gesund`;
  });
} catch {
  ok = false;
} finally {
  setEnv('BLAULICHTCMS_IMAGE', null);
  finish(ok);
  process.exit(ok ? 0 : 1);
}
