import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimaler IMAP4rev1-Client (RFC 3501) für den Abruf des Presse-Postfachs (#205) – nur lesend, ohne Zusatzbibliothek.
 *
 * Umfang: TLS (Port 993) oder STARTTLS (Port 143, TLS ist Pflicht – ohne TLS keine Anmeldung), Anmeldung per
 * AUTHENTICATE PLAIN (bzw. LOGIN, falls der Server PLAIN nicht anbietet), EXAMINE (Ordner nur lesend öffnen, setzt
 * kein „gelesen“), UID SEARCH, UID FETCH mit BODY.PEEK[] und Literalen beliebiger Größe (bis zum Limit), LOGOUT.
 * Jede Antwort hat ein Zeitlimit; Fehler des Servers (NO/BAD) werden als verständliche Meldung geworfen.
 */

export interface ImapOptions {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  user: string;
  password: string;
  timeoutMs?: number;
  /** Höchstgröße einer einzelnen Antwort (Literal) in Bytes */
  maxLiteralBytes?: number;
  /** Nur in Tests: unverschlüsselt verbinden (Stellvertreter-Server). */
  plainForTests?: boolean;
}

/** Eine Antwortzeile des Servers samt eingebetteter Literale. */
export interface ImapResponse {
  text: string;
  literals: Buffer[];
}

/** Höchstlänge einer Antwortzeile (ohne Literale). */
const MAX_LINE = 64 * 1024;

/**
 * Empfangspuffer ohne quadratisches Wachstum (#239): eingehende Stücke (bei TLS etwa 16 KB) werden nur gesammelt und erst
 * beim Lesen einer Zeile bzw. eines Literals bekannter Länge genau einmal in einen passenden Puffer kopiert – statt bei
 * jedem Stück den ganzen bisherigen Puffer neu anzulegen.
 */
export class ByteQueue {
  private chunks: (Buffer | null)[] = [];
  /** erstes noch nicht gelesenes Stück */
  private first = 0;
  /** Lesestelle im ersten Stück */
  private head = 0;
  length = 0;

  push(b: Buffer) {
    if (!b.length) return;
    this.chunks.push(b);
    this.length += b.length;
  }

  clear() {
    this.chunks = [];
    this.first = 0;
    this.head = 0;
    this.length = 0;
  }

  /** Stelle des ersten CRLF (relativ zur Lesestelle), gesucht in höchstens etwa `limit` Bytes; sonst -1. */
  indexOfCrlf(limit: number): number {
    let base = 0;
    let prevCr = false;
    for (let k = this.first; k < this.chunks.length; k++) {
      const c = this.chunks[k]!;
      const start = k === this.first ? this.head : 0;
      if (prevCr && c[start] === 0x0a) return base - 1;
      for (let from = start; ; ) {
        const i = c.indexOf(0x0a, from);
        if (i < 0) break;
        if (i > start && c[i - 1] === 0x0d) return base + (i - start) - 1;
        from = i + 1;
      }
      prevCr = c[c.length - 1] === 0x0d;
      base += c.length - start;
      if (base > limit) return -1;
    }
    return -1;
  }

  /** `n` Bytes entnehmen – als ein neuer Puffer (genau eine Kopie). */
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    this.consume(n, out);
    return out;
  }

  skip(n: number) {
    this.consume(n, null);
  }

  private consume(n: number, out: Buffer | null) {
    if (n > this.length) throw new RangeError('ByteQueue: zu wenige Daten');
    let off = 0;
    while (off < n) {
      const c = this.chunks[this.first]!;
      const k = Math.min(c.length - this.head, n - off);
      if (out) c.copy(out, off, this.head, this.head + k);
      off += k;
      this.head += k;
      if (this.head >= c.length) {
        this.chunks[this.first++] = null; // gelesene Stücke freigeben
        this.head = 0;
      }
    }
    this.length -= n;
    if (this.first > 256 || this.first === this.chunks.length) {
      this.chunks = this.chunks.slice(this.first);
      this.first = 0;
    }
  }
}

export class ImapError extends Error {
  constructor(
    message: string,
    public kind: 'connect' | 'tls' | 'auth' | 'protocol' | 'timeout' | 'server',
  ) {
    super(message);
  }
}

const quote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export class ImapClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private rx = new ByteQueue();
  private waiters: (() => void)[] = [];
  private closed: Error | null = null;
  private tag = 0;
  capabilities = new Set<string>();

  constructor(private o: ImapOptions) {}

  private get timeout() {
    return this.o.timeoutMs ?? 30_000;
  }

  private attach(sock: net.Socket | tls.TLSSocket) {
    this.socket = sock;
    sock.on('data', (d: Buffer) => {
      this.rx.push(d);
      this.wake();
    });
    sock.on('error', (e) => {
      this.closed ??= e;
      this.wake();
    });
    sock.on('close', () => {
      this.closed ??= new ImapError('Der Mailserver hat die Verbindung beendet.', 'protocol');
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /**
   * Auf weitere Daten warten – höchstens bis `deadline`; mit `idleMs` endet das Warten zusätzlich, wenn so lange nichts
   * mehr ankommt (große Mails über langsame Leitungen dürfen dauern, solange Daten fließen).
   */
  private waitData(deadline: number, idleMs?: number): Promise<void> {
    if (this.closed) return Promise.reject(this.closed instanceof ImapError ? this.closed : new ImapError(`Verbindung unterbrochen: ${this.closed.message}`, 'connect'));
    const until = idleMs ? Math.min(deadline, Date.now() + idleMs) : deadline;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ImapError('Zeitüberschreitung: Der Mailserver antwortet nicht.', 'timeout')), Math.max(1, until - Date.now()));
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Eine vollständige Antwort lesen (Zeile, ggf. mit Literalen {n}). */
  private async readResponse(deadline = Date.now() + this.timeout, idleMs?: number): Promise<ImapResponse> {
    let text = '';
    const literals: Buffer[] = [];
    const max = this.o.maxLiteralBytes ?? 40 * 1024 * 1024;
    for (;;) {
      let nl = this.rx.indexOfCrlf(MAX_LINE);
      while (nl < 0) {
        if (this.rx.length > MAX_LINE) throw new ImapError('Antwortzeile des Mailservers ist zu lang.', 'protocol');
        await this.waitData(deadline, idleMs);
        nl = this.rx.indexOfCrlf(MAX_LINE);
      }
      const line = this.rx.take(nl).toString('utf8');
      this.rx.skip(2);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (!lit) return { text: text + line, literals };
      const n = Number(lit[1]);
      if (n > max) throw new ImapError(`Nachricht ist größer als erlaubt (${Math.round(n / 1024 / 1024)} MB).`, 'protocol');
      // Literal bekannter Länge: Stücke nur sammeln, am Ende einmal in einen Puffer der richtigen Größe kopieren
      while (this.rx.length < n) await this.waitData(deadline, idleMs);
      literals.push(this.rx.take(n));
      text += line.slice(0, lit.index) + `{#${literals.length - 1}}`;
    }
  }

  private write(s: string) {
    if (!this.socket || this.closed) throw new ImapError('Keine Verbindung zum Mailserver.', 'connect');
    this.socket.write(s);
  }

  /** Befehl senden und alle Antworten bis zur markierten Abschlusszeile sammeln. */
  async command(cmd: string, opts: { continuation?: () => string; timeoutMs?: number; idleMs?: number } = {}): Promise<ImapResponse[]> {
    const tag = `B${++this.tag}`;
    this.write(`${tag} ${cmd}\r\n`);
    const deadline = Date.now() + (opts.timeoutMs ?? this.timeout);
    const untagged: ImapResponse[] = [];
    for (;;) {
      const r = await this.readResponse(deadline, opts.idleMs);
      if (r.text.startsWith('+')) {
        if (!opts.continuation) throw new ImapError('Unerwartete Rückfrage des Mailservers.', 'protocol');
        this.write(`${opts.continuation()}\r\n`);
        continue;
      }
      if (r.text.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\s?(.*)$/i.exec(r.text);
        if (!m) throw new ImapError(`Unverständliche Antwort: ${r.text.slice(0, 120)}`, 'protocol');
        if (m[1].toUpperCase() !== 'OK') throw new ImapError(m[2].replace(/^\[[^\]]*\]\s*/, '').slice(0, 200) || `Befehl abgelehnt (${m[1]}).`, 'server');
        this.updateCapabilities(r.text);
        return untagged;
      }
      this.updateCapabilities(r.text);
      untagged.push(r);
    }
  }

  private updateCapabilities(text: string) {
    const m = /(?:^\* CAPABILITY |\[CAPABILITY )([^\]\r\n]*)/i.exec(text);
    if (m) this.capabilities = new Set(m[1].toUpperCase().split(/\s+/).filter(Boolean));
  }

  private connectSocket(): Promise<net.Socket | tls.TLSSocket> {
    const { host, port } = this.o;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new ImapError(`Mailserver ${host}:${port} nicht erreichbar (Zeitüberschreitung).`, 'connect'));
      }, Math.min(this.timeout, 15_000));
      const fail = (e: any) => {
        clearTimeout(timer);
        const tlsProblem = /certificate|self.signed|SSL|TLS|wrong version/i.test(String(e?.message ?? e)) || String(e?.code ?? '').startsWith('ERR_TLS') || String(e?.code ?? '').includes('CERT');
        reject(new ImapError(tlsProblem ? `TLS-Verbindung zu ${host}:${port} fehlgeschlagen: ${e.message}` : `Mailserver ${host}:${port} nicht erreichbar: ${e.message}`, tlsProblem ? 'tls' : 'connect'));
      };
      const sock: net.Socket | tls.TLSSocket =
        this.o.security === 'tls' && !this.o.plainForTests
          ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' }, () => {
              clearTimeout(timer);
              sock.off('error', fail);
              resolve(sock);
            })
          : net.connect({ host, port }, () => {
              clearTimeout(timer);
              sock.off('error', fail);
              resolve(sock);
            });
      sock.once('error', fail);
    });
  }

  private upgrade(): Promise<void> {
    const plain = this.socket as net.Socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    return new Promise((resolve, reject) => {
      const t = tls.connect({ socket: plain, servername: net.isIP(this.o.host) ? undefined : this.o.host, minVersion: 'TLSv1.2' }, () => {
        t.off('error', onErr);
        this.rx.clear();
        this.attach(t);
        resolve();
      });
      const onErr = (e: Error) => reject(new ImapError(`STARTTLS fehlgeschlagen: ${e.message}`, 'tls'));
      t.once('error', onErr);
    });
  }

  async connect(): Promise<void> {
    this.attach(await this.connectSocket());
    const greet = await this.readResponse();
    if (/^\* BYE/i.test(greet.text)) throw new ImapError(`Mailserver lehnt ab: ${greet.text.slice(6, 200)}`, 'server');
    if (!/^\* (OK|PREAUTH)/i.test(greet.text)) throw new ImapError('Der Server spricht kein IMAP (Port und Verschlüsselung prüfen).', 'protocol');
    this.updateCapabilities(greet.text);
    if (!this.capabilities.size) await this.command('CAPABILITY');
    if (this.o.security === 'starttls' && !this.o.plainForTests) {
      if (!this.capabilities.has('STARTTLS')) throw new ImapError('Der Mailserver bietet kein STARTTLS an – bitte TLS (Port 993) wählen.', 'tls');
      await this.command('STARTTLS');
      await this.upgrade();
      await this.command('CAPABILITY');
    }
    if (this.capabilities.has('LOGINDISABLED') && !this.capabilities.has('AUTH=PLAIN')) throw new ImapError('Der Mailserver erlaubt hier keine Anmeldung.', 'auth');
    try {
      if (this.capabilities.has('AUTH=PLAIN')) {
        const token = Buffer.from(`\u0000${this.o.user}\u0000${this.o.password}`, 'utf8').toString('base64');
        await this.command('AUTHENTICATE PLAIN', { continuation: () => token });
      } else {
        if (/[\r\n\u0000]/.test(this.o.user + this.o.password)) throw new ImapError('Benutzername oder Passwort enthält unzulässige Zeichen.', 'auth');
        await this.command(`LOGIN ${quote(this.o.user)} ${quote(this.o.password)}`);
      }
    } catch (e) {
      if (e instanceof ImapError && e.kind === 'server') throw new ImapError(`Anmeldung abgelehnt: ${e.message}`, 'auth');
      throw e;
    }
    await this.command('CAPABILITY').catch(() => []);
  }

  /** Ordner nur lesend öffnen. */
  async examine(folder: string): Promise<{ uidValidity: number; exists: number }> {
    const res = await this.command(`EXAMINE ${quote(folder)}`);
    let uidValidity = 0;
    let exists = 0;
    for (const r of res) {
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(r.text);
      if (v) uidValidity = Number(v[1]);
      const e = /^\* (\d+) EXISTS/i.exec(r.text);
      if (e) exists = Number(e[1]);
    }
    return { uidValidity, exists };
  }

  /** UIDs zu einem Suchausdruck (z. B. „UID 15:*“ oder „SINCE 16-Nov-2026“). */
  async search(criteria: string): Promise<number[]> {
    const res = await this.command(`UID SEARCH ${criteria}`);
    const out: number[] = [];
    for (const r of res) {
      const m = /^\* SEARCH\s*(.*)$/i.exec(r.text);
      if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(Number(n));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  /** Größe und Eingangszeit je UID. */
  async sizes(uids: number[]): Promise<Map<number, { size: number; internalDate: Date | null }>> {
    const out = new Map<number, { size: number; internalDate: Date | null }>();
    for (let i = 0; i < uids.length; i += 200) {
      const res = await this.command(`UID FETCH ${uids.slice(i, i + 200).join(',')} (UID RFC822.SIZE INTERNALDATE)`);
      for (const r of res) {
        const uid = /\bUID (\d+)/i.exec(r.text);
        const size = /\bRFC822\.SIZE (\d+)/i.exec(r.text);
        const date = /\bINTERNALDATE "([^"]+)"/i.exec(r.text);
        if (uid) out.set(Number(uid[1]), { size: Number(size?.[1] ?? 0), internalDate: date ? parseImapDate(date[1]) : null });
      }
    }
    return out;
  }

  /**
   * Komplette Nachricht lesen, ohne sie als gelesen zu markieren. Solange Daten fließen, darf das bis zu 5 Minuten dauern
   * (große Mail, langsame Leitung); kommt eine Minute lang nichts, gilt der Server als hängend (#239).
   */
  async fetchRaw(uid: number): Promise<Buffer | null> {
    const res = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`, { timeoutMs: Math.max(this.timeout, 5 * 60_000), idleMs: Math.max(this.timeout, 60_000) });
    for (const r of res) if (new RegExp(`\\bUID ${uid}\\b`).test(r.text) && r.literals.length) return r.literals[r.literals.length - 1];
    return null;
  }

  async logout() {
    try {
      if (this.socket && !this.closed) await this.command('LOGOUT', { timeoutMs: 5_000 });
    } catch {
      /* egal */
    } finally {
      this.socket?.destroy();
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** „17-Jul-1996 02:44:25 -0700“ → Date */
export function parseImapDate(s: string): Date | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  if (mon < 0) return null;
  const off = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1);
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60_000);
}

/** Datum für SEARCH SINCE: „16-Nov-2026“. */
export function imapSearchDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
