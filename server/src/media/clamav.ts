import fs from 'node:fs';
import net from 'node:net';

/**
 * Schadsoftwareprüfung über clamd (ClamAV) per TCP, Befehl INSTREAM (#133).
 *
 * Ablauf: „zINSTREAM\0“, danach die Datei in Blöcken (4 Byte Länge, big endian, dann Daten), Ende mit einem Block der
 * Länge 0. clamd antwortet mit „stream: OK“, „stream: <Signatur> FOUND“ oder „… ERROR“ (abgeschlossen mit \0).
 *
 * Hinweis Betrieb: clamd begrenzt die Länge (StreamMaxLength, Standard 25 MB). Für Videos muss der Wert mindestens der
 * maximalen Dateigröße entsprechen – sonst meldet clamd „size limit exceeded“ und die Datei bleibt in der Quarantäne.
 */

export class ScannerUnavailable extends Error {}

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string };

export interface ScanOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Blockgröße für INSTREAM (Standard 64 KiB). */
  chunkSize?: number;
}

/** Wertet die Antwort von clamd aus. „ERROR“ (z. B. Größengrenze) gilt als nicht prüfbar. */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  if (/^(stream|\S+):\s*OK$/i.test(text)) return { status: 'clean' };
  const found = /^(?:stream|\S+):\s*(.+?)\s+FOUND$/i.exec(text);
  if (found) return { status: 'infected', signature: found[1].slice(0, 200) };
  throw new ScannerUnavailable(`ClamAV meldet: ${text.slice(0, 200) || 'keine Antwort'}`);
}

/** Prüft eine Datei. Wirft ScannerUnavailable, wenn clamd nicht erreichbar ist, nicht rechtzeitig antwortet oder einen Fehler meldet. */
export function scanFile(file: string, opts: ScanOptions): Promise<ScanResult> {
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  return new Promise<ScanResult>((resolve, reject) => {
    let settled = false;
    let reply = '';
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    const input = fs.createReadStream(file, { highWaterMark: chunkSize });
    const finish = (err: Error | null, res?: ScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(res!);
    };
    const timer = setTimeout(() => finish(new ScannerUnavailable(`ClamAV antwortet nicht innerhalb von ${Math.round(opts.timeoutMs / 1000)} s.`)), opts.timeoutMs);

    socket.on('error', (e) => finish(new ScannerUnavailable(`ClamAV nicht erreichbar (${opts.host}:${opts.port}): ${e.message}`)));
    socket.on('data', (d) => {
      reply += d.toString('utf8');
      if (reply.length > 4096) return finish(new ScannerUnavailable('ClamAV: unerwartet lange Antwort.'));
      // clamd antwortet ggf. schon vor dem Ende der Übertragung (z. B. Größengrenze überschritten)
      if (reply.includes('\0')) {
        try {
          finish(null, parseClamdReply(reply));
        } catch (e) {
          finish(e as Error);
        }
      }
    });
    socket.on('end', () => {
      if (settled) return;
      try {
        finish(null, parseClamdReply(reply));
      } catch (e) {
        finish(e as Error);
      }
    });
    input.on('error', (e) => finish(e));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      input.on('data', (chunk) => {
        const buf = chunk as Buffer;
        const len = Buffer.alloc(4);
        len.writeUInt32BE(buf.length, 0);
        socket.write(len);
        if (!socket.write(buf)) {
          input.pause();
          socket.once('drain', () => input.resume());
        }
      });
      input.on('end', () => {
        if (!settled) socket.write(Buffer.alloc(4)); // Ende der Übertragung
      });
    });
  });
}

/** Erreichbarkeit prüfen (PING → PONG), z. B. für den Systemstatus. */
export function pingClamd(opts: Pick<ScanOptions, 'host' | 'port'> & { timeoutMs?: number }): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = '';
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), opts.timeoutMs ?? 3_000);
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\0') || buf.includes('PONG')) done(buf.includes('PONG'));
    });
    socket.on('error', () => done(false));
    socket.on('end', () => done(buf.includes('PONG')));
  });
}
