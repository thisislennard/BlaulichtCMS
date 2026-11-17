import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../src/lib/crypto.js';
import { dailyRunDue, encryptToFile } from '../src/ops/backup.js';

/*
 * Datenbanksicherung (#248): Schreibfehler (voller Datenträger) beenden pg_dump, Prüfsummen gestreamt, Zeitplan auch
 * in der Lücke der Sommerzeit-Umstellung. Ohne Datenbank.
 */

describe('Sicherung: Schreibfehler, Prüfsummen, Zeitplan (#248)', () => {
  it('voller Datenträger (ENOSPC): Kindprozess wird beendet statt blockiert hängen zu bleiben', async () => {
    // Kindprozess schreibt endlos (wie pg_dump bei einer großen Datenbank)
    const child = spawn(process.execPath, ['-e', "const b=Buffer.alloc(65536,1);(function w(){while(process.stdout.write(b));process.stdout.once('drain',w)})()"], { stdio: ['ignore', 'pipe', 'pipe'] });
    let written = 0;
    const full = new Writable({
      write(c: Buffer, _e, cb) {
        written += c.length;
        if (written > 1024 * 1024) return cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
        setImmediate(cb);
      },
    });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    await expect(encryptToFile(child, path.join(os.tmpdir(), 'nie-geschrieben.part'), crypto.randomBytes(32), full)).rejects.toThrow(/ENOSPC/);
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8_000))]);
    if (!gone) child.kill('SIGKILL');
    expect(gone).toBe(true);
  });

  it('Prüfsumme beim Schreiben entspricht der Datei; sha256File liest gestreamt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sha-'));
    try {
      const file = path.join(dir, 'x.bcbk');
      const child = spawn(process.execPath, ['-e', "process.stdout.write(Buffer.alloc(3*1024*1024+17,7))"], { stdio: ['ignore', 'pipe', 'pipe'] });
      const r = await encryptToFile(child, file, crypto.randomBytes(32));
      const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      expect(r.sha256).toBe(expected);
      expect(r.bytes).toBe(fs.statSync(file).size);
      expect(await sha256File(file)).toBe(expected);
      expect(fs.readFileSync(file).subarray(0, 5).toString()).toBe('BCBK1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Zeitplan: Sicherung um 02:00 läuft auch am Tag der Umstellung auf Sommerzeit – genau einmal', () => {
    const tz = 'Europe/Berlin';
    const runsOn = (dayStartUtc: number, hour: number, last: Date | null) => {
      const runs: string[] = [];
      for (let t = dayStartUtc; t < dayStartUtc + 24 * 3600_000; t += 10 * 60_000) {
        if (dailyRunDue(new Date(t), tz, hour, last)) {
          last = new Date(t);
          runs.push(last.toISOString());
        }
      }
      return runs;
    };
    const runsOnWindow = (dayStartUtc: number, hour: number, windowHours: number) => {
      const runs: string[] = [];
      let tried = '';
      for (let t = dayStartUtc; t < dayStartUtc + 24 * 3600_000; t += 10 * 60_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (tried !== day && dailyRunDue(new Date(t), tz, hour, null, windowHours)) {
          tried = day;
          runs.push(new Date(t).toISOString());
        }
      }
      return runs;
    };
    // 28.03.2027: 02:00 MEZ → 03:00 MESZ, die Stunde 2 gibt es nicht (Mitternacht Ortszeit = 23:00 UTC am Vortag)
    const gap = runsOn(Date.UTC(2027, 2, 27, 23), 2, new Date(Date.UTC(2027, 2, 27, 1)));
    expect(gap).toEqual(['2027-03-28T01:00:00.000Z']); // 03:00 MESZ
    // gewöhnlicher Tag: einmal um 02:00
    expect(runsOn(Date.UTC(2027, 3, 4, 22), 2, new Date(Date.UTC(2027, 3, 4, 0)))).toEqual(['2027-04-05T00:00:00.000Z']);
    // 31.10.2027: 03:00 MESZ → 02:00 MEZ, die Stunde 2 gibt es zweimal – trotzdem nur eine Sicherung
    expect(runsOn(Date.UTC(2027, 9, 30, 22), 2, new Date(Date.UTC(2027, 9, 30, 0)))).toHaveLength(1);
    // Worker lief zur Sicherungszeit nicht: Nachholen am selben Tag, nicht vor der eingestellten Stunde
    expect(dailyRunDue(new Date(Date.UTC(2027, 3, 5, 10)), tz, 3, new Date(Date.UTC(2027, 3, 4, 1)))).toBe(true);
    expect(dailyRunDue(new Date(Date.UTC(2027, 3, 5, 0)), tz, 3, new Date(Date.UTC(2027, 3, 4, 1)))).toBe(false);
    // Probe-Wiederherstellung: nur bis drei Stunden nach ihrer Stunde (kein Nachholen am Nachmittag, z. B. gleich nach
    // der Installation), in der Sommerzeit-Lücke aber trotzdem am selben Tag
    expect(dailyRunDue(new Date(Date.UTC(2027, 3, 5, 12)), tz, 4, null, 3)).toBe(false);
    expect(dailyRunDue(new Date(Date.UTC(2027, 3, 5, 3)), tz, 4, null, 3)).toBe(true); // 05:00 MESZ
    expect(runsOnWindow(Date.UTC(2027, 2, 27, 23), 2, 3)).toEqual(['2027-03-28T01:00:00.000Z']);
  });
});
