import crypto from 'node:crypto';
import http from 'node:http';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { httpRequest, transferAllowanceMs } from '../src/lib/http.js';
import { claimForSlots, enqueue, slotPlan } from '../src/jobs/queue.js';
import { acquirePollLock, POLL_LOCK_MS, releasePollLock } from '../src/connections/feuersoftware.js';

/*
 * Ausgehende Anfragen und Hintergrundaufträge (#240): Gesamtfrist statt nur Leerlaufgrenze, Größengrenze auch beim
 * Download in Dateien, reservierte Plätze der Warteschlange für Warnversand und Medienprüfung, Sperre des
 * Feuersoftware-Abrufs mit Frist.
 */

/** Testserver: antwortet tröpfchenweise (ein Byte je `everyMs`, insgesamt `totalMs`) oder mit einer festen Menge. */
async function startServer(handler: http.RequestListener) {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/`;
  return { url, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

const dribble =
  (everyMs: number, totalMs: number): http.RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const started = Date.now();
    const t = setInterval(() => {
      if (res.destroyed || Date.now() - started > totalMs) {
        clearInterval(t);
        if (!res.destroyed) res.end();
        return;
      }
      res.write('x');
    }, everyMs);
    res.on('close', () => clearInterval(t));
  };

describe('Ausgehende Anfragen: Gesamtfrist und Größengrenze (#240)', () => {
  it('bricht eine tröpfchenweise Antwort nach timeoutMs ab (Leerlaufgrenze allein griffe nie)', async () => {
    const s = await startServer(dribble(100, 6_000));
    try {
      const t0 = Date.now();
      const err = await httpRequest({ method: 'GET', url: s.url, timeoutMs: 1_000, allowPrivateHosts: ['127.0.0.1'] }).catch((e) => e);
      const took = Date.now() - t0;
      expect(err?.message).toMatch(/Zeitüberschreitung/);
      expect(took).toBeLessThan(3_000);
    } finally {
      await s.close();
    }
  });

  it('gilt auch beim Schreiben in eine Datei (sink)', async () => {
    const s = await startServer(dribble(100, 6_000));
    try {
      let got = 0;
      const sink = new Writable({ write: (c: Buffer, _e, cb) => ((got += c.length), cb()) });
      const t0 = Date.now();
      const err = await httpRequest({ method: 'GET', url: s.url, timeoutMs: 1_000, sink, maxResponseBytes: 1_000_000, allowPrivateHosts: ['127.0.0.1'] }).catch((e) => e);
      expect(err?.message).toMatch(/Zeitüberschreitung/);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(got).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('begrenzt Downloads in eine Datei: angekündigte und tatsächliche Größe', async () => {
    const big = crypto.randomBytes(300_000);
    const s = await startServer((req, res) => {
      if (req.url === '/angekuendigt') return res.writeHead(200, { 'content-length': String(big.length) }).end(big);
      // ohne Längenangabe (chunked)
      res.writeHead(200);
      res.write(big.subarray(0, 100_000));
      setTimeout(() => res.end(big.subarray(100_000)), 20);
    });
    try {
      for (const p of ['angekuendigt', 'chunked']) {
        let got = 0;
        const sink = new Writable({ write: (c: Buffer, _e, cb) => ((got += c.length), cb()) });
        const err = await httpRequest({ method: 'GET', url: `${s.url}${p}`, sink, maxResponseBytes: 50_000, allowPrivateHosts: ['127.0.0.1'] }).catch((e) => e);
        expect(err?.message, p).toMatch(/größer als/);
        expect(got, p).toBeLessThan(50_000 + 70_000);
        // angekündigte Länge zu groß: abgewiesen, bevor etwas geschrieben wird
        if (p === 'angekuendigt') expect(got).toBe(0);
      }
      // passt die Größe, läuft der Download durch
      let got = 0;
      const sink = new Writable({ write: (c: Buffer, _e, cb) => ((got += c.length), cb()) });
      const ok = await httpRequest({ method: 'GET', url: `${s.url}angekuendigt`, sink, maxResponseBytes: big.length, allowPrivateHosts: ['127.0.0.1'] });
      expect(ok.status).toBe(200);
      expect(got).toBe(big.length);
    } finally {
      await s.close();
    }
  });

  it('Zuschlag für große Übertragungen: rund 1 Mbit/s Mindestdurchsatz', () => {
    expect(transferAllowanceMs(0)).toBe(0);
    expect(transferAllowanceMs(100_000)).toBe(0);
    expect(transferAllowanceMs(40 * 1024 * 1024)).toBeGreaterThan(300_000);
    expect(transferAllowanceMs(NaN)).toBe(0);
  });
});

describe('Warteschlange: reservierte Plätze (#240)', () => {
  it('Aufträge mit fremden Diensten belegen nie alle Plätze', () => {
    expect(slotPlan(4, [])).toEqual({ free: 4, external: 3 });
    expect(slotPlan(4, ['social.publish', 'social.publish', 'social.publish'])).toEqual({ free: 1, external: 0 });
    expect(slotPlan(4, ['media.process', 'warning.send'])).toEqual({ free: 2, external: 2 });
    expect(slotPlan(8, [])).toEqual({ free: 8, external: 6 });
    // ein einziger Platz: nichts zu reservieren
    expect(slotPlan(1, [])).toEqual({ free: 1, external: 1 });
    expect(slotPlan(4, ['social.publish', 'automation.run', 'press.release', 'media.process'])).toEqual({ free: 0, external: 0 });
  });
});

describe('Feuersoftware: Sperre des Abrufs mit Frist (#240)', () => {
  it('ein hängender Abruf sperrt nur bis zur Frist; seine Freigabe löst keine neuere Sperre', () => {
    const id = `test-${crypto.randomUUID()}`;
    const t0 = 1_000_000;
    const first = acquirePollLock(id, t0);
    expect(first).toBeTruthy();
    expect(acquirePollLock(id, t0 + 30_000)).toBeNull();
    const second = acquirePollLock(id, t0 + POLL_LOCK_MS + 1);
    expect(second).toBeTruthy();
    // der alte (hängende) Abruf endet später: gibt die neue Sperre nicht frei
    releasePollLock(id, first!);
    expect(acquirePollLock(id, t0 + POLL_LOCK_MS + 2)).toBeNull();
    releasePollLock(id, second!);
    expect(acquirePollLock(id, t0 + POLL_LOCK_MS + 3)).toBeTruthy();
  });
});

describe('Warteschlange mit Datenbank (#240)', () => {
  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(() => {});
  });

  afterAll(async () => {
    await pool.end();
  });

  it('Warteschlange: hängen alle Plätze für fremde Dienste, läuft der Warnversand trotzdem (#240)', async () => {
    const old = new Date(Date.now() - 60_000);
    for (let i = 0; i < 6; i++) await enqueue('social.publish', { id: `s${i}` }, { runAt: old });
    await enqueue('warning.send', { sendId: 'w1' });
    // drei Social-Posts laufen (z. B. hängende Instanz) – frei ist nur noch der reservierte Platz
    const running = (await claimForSlots(4, [])).map((j) => ({ id: j.id, kind: j.kind }));
    expect(running.map((j) => j.kind).sort()).toEqual(['social.publish', 'social.publish', 'social.publish', 'warning.send']);
    await pool.query(`UPDATE jobs SET status = 'done' WHERE kind = 'warning.send'`);
    await enqueue('warning.send', { sendId: 'w2' });
    const busy = running.filter((j) => j.kind === 'social.publish');
    const next = await claimForSlots(4, busy);
    expect(next.map((j) => j.kind)).toEqual(['warning.send']);
    // ohne weitere Aufträge anderer Art bleibt der reservierte Platz frei, auch wenn Social-Posts warten
    expect(await claimForSlots(4, [...busy, ...next.map((j) => ({ id: j.id, kind: j.kind }))].slice(0, 3))).toEqual([]);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'social.publish' AND status = 'queued'`))!.n).toBe(3);
  });
});
