import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/** Stellvertreter-Server für die Tests des Presse-Postfachs (#205): ein kleiner IMAP-Server und Microsoft Graph. */

export interface FakeMail {
  uid: number;
  raw: Buffer;
  date: Date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;

export async function fakeImap(opts: { user: string; password: string; uidValidity?: number }) {
  const mails: FakeMail[] = [];
  const commands: string[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let pendingAuth: string | null = null;
    const send = (s: string | Buffer) => sock.write(s);
    send('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Stellvertreter bereit\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (pendingAuth) {
          const [, u, p] = Buffer.from(line, 'base64').toString('utf8').split('\u0000');
          send(u === opts.user && p === opts.password ? `${pendingAuth} OK angemeldet\r\n` : `${pendingAuth} NO [AUTHENTICATIONFAILED] Falsches Passwort\r\n`);
          pendingAuth = null;
          continue;
        }
        const m = /^(\S+) (.*)$/.exec(line);
        if (!m) continue;
        const [, tag, cmd] = m;
        commands.push(cmd.replace(/^AUTHENTICATE.*/, 'AUTHENTICATE'));
        const up = cmd.toUpperCase();
        if (up === 'CAPABILITY') send(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n`);
        else if (up === 'AUTHENTICATE PLAIN') {
          pendingAuth = tag;
          send('+ \r\n');
        } else if (up.startsWith('EXAMINE')) send(`* ${mails.length} EXISTS\r\n* OK [UIDVALIDITY ${opts.uidValidity ?? 7}] ok\r\n${tag} OK [READ-ONLY] EXAMINE fertig\r\n`);
        else if (up.startsWith('UID SEARCH')) {
          let uids: number[];
          const r = /UID (\d+):\*/.exec(up);
          if (r) {
            uids = mails.filter((x) => x.uid >= Number(r[1])).map((x) => x.uid);
            if (!uids.length && mails.length) uids = [mails[mails.length - 1].uid]; // n:* liefert immer die höchste UID
          } else uids = mails.map((x) => x.uid);
          send(`* SEARCH ${uids.join(' ')}\r\n${tag} OK\r\n`);
        } else if (up.startsWith('UID FETCH')) {
          const set = /^UID FETCH (\S+)/i.exec(cmd)![1].split(',').map(Number);
          for (const uid of set) {
            const idx = mails.findIndex((x) => x.uid === uid);
            if (idx < 0) continue;
            const mail = mails[idx];
            if (up.includes('BODY.PEEK[]')) {
              send(`* ${idx + 1} FETCH (UID ${uid} BODY[] {${mail.raw.length}}\r\n`);
              send(mail.raw);
              send(')\r\n');
            } else send(`* ${idx + 1} FETCH (UID ${uid} RFC822.SIZE ${mail.raw.length} INTERNALDATE "${imapDate(mail.date)}")\r\n`);
          }
          send(`${tag} OK FETCH fertig\r\n`);
        } else if (up === 'LOGOUT') {
          send(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else send(`${tag} BAD unbekannt\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let next = 1;
  return {
    port,
    mails,
    commands,
    add(raw: string | Buffer, date = new Date()) {
      mails.push({ uid: next++, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8'), date });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Microsoft Graph (Anmeldung, Nachrichtenliste, MIME-Inhalt, Versand) unter /login und /graph. */
export async function fakeGraph() {
  const messages: { id: string; received: string; raw: Buffer }[] = [];
  const sent: { path: string; contentType: string; body: string }[] = [];
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      requests.push(`${req.method} ${url.pathname}`);
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname.endsWith('/oauth2/v2.0/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
      if (req.headers.authorization !== 'Bearer tok') return json(401, { error: { code: 'InvalidAuthenticationToken' } });
      let m = /^\/graph\/users\/([^/]+)\/mailFolders\/inbox$/.exec(url.pathname);
      if (m) return json(200, { totalItemCount: messages.length, unreadItemCount: 0 });
      m = /^\/graph\/users\/([^/]+)\/mailFolders\/inbox\/messages$/.exec(url.pathname);
      if (m) {
        const since = /receivedDateTime ge (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1] ?? '';
        return json(200, { value: messages.filter((x) => x.received >= since).map((x) => ({ id: x.id, internetMessageId: `<${x.id}>`, receivedDateTime: x.received })) });
      }
      m = /^\/graph\/users\/([^/]+)\/messages\/([^/]+)\/\$value$/.exec(url.pathname);
      if (m) {
        const msg = messages.find((x) => x.id === decodeURIComponent(m![2]));
        if (!msg) return json(404, { error: { code: 'ErrorItemNotFound' } });
        res.writeHead(200, { 'content-type': 'message/rfc822' });
        return res.end(msg.raw);
      }
      m = /^\/graph\/users\/([^/]+)\/sendMail$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        sent.push({ path: url.pathname, contentType: String(req.headers['content-type']), body });
        res.writeHead(202);
        return res.end();
      }
      json(404, { error: { code: 'NotFound' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    messages,
    sent,
    requests,
    add(id: string, raw: string, received = new Date().toISOString()) {
      messages.push({ id, received, raw: Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8') });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** SMTP-Stellvertreter: sammelt Umschlag und Rohnachricht. */
export async function fakeSmtp() {
  const { SMTPServer } = await import('smtp-server');
  const received: { from: string; to: string[]; raw: string }[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    disableReverseLookup: true,
    logger: false,
    onData(stream: any, session: any, cb: any) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom?.address ?? '', to: session.envelope.rcptTo.map((r: any) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
  } as any);
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  return { port: (smtp.server.address() as AddressInfo).port, received, close: () => new Promise<void>((r) => smtp.close(() => r())) };
}
