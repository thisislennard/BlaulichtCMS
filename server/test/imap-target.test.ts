import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapClient, ImapError } from '../src/press/imap.js';

/**
 * IMAP-Ziel des Presse-Postfachs (#234) – ohne Datenbank: dieselbe Sperre interner Adressen wie lib/http.ts, nur die
 * üblichen Ports und eine einheitliche Meldung für alles vor der Begrüßung (kein Abtasten des Netzes über die Meldung).
 */

const servers: net.Server[] = [];
async function server(onConnect: (s: net.Socket) => void): Promise<number> {
  const srv = net.createServer(onConnect);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as net.AddressInfo).port;
}

let closedPort = 0;
let bannerPort = 0;
let silentPort = 0;
let imapPort = 0;
const sockets: net.Socket[] = [];

beforeAll(async () => {
  // freier, danach geschlossener Port
  closedPort = await server(() => {});
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  bannerPort = await server((s) => s.end('SSH-2.0-OpenSSH_9.9\r\n'));
  silentPort = await server((s) => void sockets.push(s));
  imapPort = await server((s) => s.end('* BYE Wartung\r\n'));
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const client = (port: number, extra: Partial<ConstructorParameters<typeof ImapClient>[0]> = {}) =>
  new ImapClient({ host: '127.0.0.1', port, security: 'tls', user: 'presse', password: 'Geheim-123', timeoutMs: 400, plainForTests: true, allowPrivateHosts: ['127.0.0.1'], ...extra });

async function failure(c: ImapClient): Promise<ImapError> {
  try {
    await c.connect();
  } catch (e) {
    expect(e).toBeInstanceOf(ImapError);
    return e as ImapError;
  } finally {
    c['socket']?.destroy();
  }
  throw new Error('Verbindung hätte scheitern müssen');
}

describe('IMAP-Ziel (#234)', () => {
  it('nicht erreichbar, kein IMAP und keine Antwort ergeben dieselbe Meldung', async () => {
    const msgs = await Promise.all([closedPort, bannerPort, silentPort].map(async (p) => (await failure(client(p))).message.replace(String(p), 'PORT')));
    expect(new Set(msgs).size).toBe(1);
    expect(msgs[0]).toContain('Keine IMAP-Verbindung zu 127.0.0.1:PORT');
    // ein echter IMAP-Server darf sich verständlich äußern
    expect((await failure(client(imapPort))).message).toContain('Mailserver lehnt ab: Wartung');
  });

  it('interne Adressen nur nach Freigabe – auch über einen Namen, der intern auflöst', async () => {
    const blocked = await failure(client(993, { allowPrivateHosts: [] }));
    expect(blocked.kind).toBe('config');
    expect(blocked.message).toContain('internes Netz');
    const named = await failure(client(993, { host: 'localhost', allowPrivateHosts: [] }));
    expect(named.kind).toBe('config');
    expect(named.message).toContain('internes Netz');
  });

  it('nur die Ports 143 und 993, andere nur für freigegebene Hosts – geprüft vor jeder Namensauflösung', async () => {
    for (const port of [22, 25, 80, 5432, 2525]) {
      const e = await failure(client(port, { host: 'imap.example.org', allowPrivateHosts: [] }));
      expect(e.kind).toBe('config');
      expect(e.message).toContain(`Port ${port} ist für IMAP nicht vorgesehen`);
    }
    // freigegebener Host: anderer Port erlaubt (hier der Stellvertreter)
    expect((await failure(client(imapPort))).kind).toBe('server');
  });
});
