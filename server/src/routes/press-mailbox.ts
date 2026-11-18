import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { assertRecentAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { readSecret, revokeSecret, storeSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { mailboxConfig, mailboxConfigProblem, mailboxFingerprint, mailboxState, pollPressMailbox, testMailbox, type MailboxConfig } from '../press/mailbox.js';

/*
 * Presse-Postfach (#205): Einrichtung (IMAP oder Microsoft 365), Verbindungstest, Schalten, „Jetzt abrufen“,
 * Empfangsprotokoll; Herunterladen von Anhängen eingegangener Mails.
 */

/** Besitzer des IMAP-Passworts in `secrets` (feste Kennung wie beim Microsoft-365-Geheimnis). */
const SECRET_OWNER = '00000000-0000-0000-0000-0000000a0205';
/** So lange gilt ein erfolgreicher Test als Nachweis für das Einschalten. */
const VERIFY_MAX_AGE_MS = 60 * 60_000;

const input = z.object({
  mode: z.enum(['imap', 'm365']),
  host: z.string().trim().max(200).default(''),
  port: z.number().int().min(1).max(65535).default(993),
  security: z.enum(['tls', 'starttls']).default('tls'),
  user: z.string().trim().max(200).default(''),
  folder: z.string().trim().max(200).default('INBOX'),
  mailbox: z.string().trim().max(254).default(''),
  intervalMinutes: z.number().int().min(1).max(60).default(5),
  maxAttachmentMb: z.number().int().min(1).max(25).default(10),
  /** neues Passwort; leer/fehlend = gespeichertes behalten */
  password: z.string().max(500).optional(),
});

/** Gleiches IMAP-Ziel: Server (ohne Groß-/Kleinschreibung), Port und Benutzer. */
const sameImapTarget = (a: MailboxConfig, b: MailboxConfig) => a.host.trim().toLowerCase() === b.host.trim().toLowerCase() && a.port === b.port && a.user.trim() === b.user.trim();

function publicConfig(c: MailboxConfig) {
  const { secretId, verified, ...rest } = c;
  return { ...rest, passwordSet: !!secretId, verifiedAt: verified?.at ?? null };
}

export async function pressMailboxRoutes(app: FastifyInstance) {
  const perm = requireAuth('press.mailbox');

  app.get('/press/mailbox', { preHandler: perm }, async () => {
    const c = await mailboxConfig();
    const s = await getSettings();
    const state = await mailboxState();
    return {
      config: publicConfig(c),
      state: { lastRunAt: state.lastRunAt ?? null, lastOk: state.lastOk ?? null, lastError: state.lastError ?? null, lastImported: state.lastImported ?? null },
      m365Ready: !!(s['m365.tenant_id'] && s['m365.client_id'] && s['m365.secret_id']),
      retentionDays: Number(s['privacy.receipt_days']) || 7,
    };
  });

  app.get('/press/mailbox/log', { preHandler: perm }, async () =>
    many<any>(`SELECT l.id, l.at, l.outcome, l.subject, l.from_address, l.request_id, r.case_no, l.detail FROM press_mailbox_log l LEFT JOIN press_requests r ON r.id = l.request_id ORDER BY l.id DESC LIMIT 200`),
  );

  /**
   * Angaben (und ggf. neues Passwort) zusammenführen, ohne zu speichern. Das gespeicherte Passwort gilt nur für
   * denselben Server, Port und Benutzer (wie bei SMTP und der Sicherung außer Haus, #234) – sonst könnte jemand mit
   * „Presse-Postfach einrichten“ es an einen eigenen Server schicken lassen, ohne es je zu sehen. Für ein anderes Ziel
   * muss es neu eingegeben werden; ohne IMAP-Ziel (Microsoft 365, Angaben geleert) wird es beim Speichern verworfen.
   */
  const merge = async (b: z.infer<typeof input>): Promise<{ next: MailboxConfig; password: string; dropSecret: boolean }> => {
    const cur = await mailboxConfig();
    const next: MailboxConfig = { ...cur, mode: b.mode, host: b.host, port: b.port, security: b.security, user: b.user, folder: b.folder || 'INBOX', mailbox: b.mailbox, intervalMinutes: b.intervalMinutes, maxAttachmentMb: b.maxAttachmentMb };
    if (b.password) return { next, password: b.password, dropSecret: false };
    if (!cur.secretId) return { next, password: '', dropSecret: false };
    if (sameImapTarget(cur, next)) return { next, password: (await readSecret(cur.secretId)) ?? '', dropSecret: false };
    if (next.mode === 'imap' && next.host.trim()) throw badRequest('Für einen anderen Server, Port oder Benutzer bitte das Passwort neu eingeben.');
    return { next, password: '', dropSecret: true };
  };

  app.post('/press/mailbox/test', { preHandler: perm, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = input.parse(req.body);
    const { next, password } = await merge(b);
    const problem = mailboxConfigProblem(next);
    if (problem) throw badRequest(problem);
    if (next.mode === 'imap' && !password) throw badRequest('Bitte das Passwort eintragen.');
    if (next.mode === 'm365') {
      const s = await getSettings();
      if (!(s['m365.tenant_id'] && s['m365.client_id'] && s['m365.secret_id'])) throw badRequest('Microsoft 365 ist noch nicht eingerichtet (Einstellungen → E-Mail & Push).');
    }
    try {
      const info = await testMailbox(next, password);
      // Nachweis für genau diese Angaben (das Passwort zählt mit) – Einschalten nur damit
      const cur = await mailboxConfig();
      await setSettings({ 'press.mailbox': { ...cur, verified: { fp: mailboxFingerprint(next, password), at: new Date().toISOString() } } } as any, req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'press.mailbox_tested', { type: 'settings', label: 'Presse-Postfach' }, { art: next.mode, ergebnis: 'ok' });
      return { ok: true, info };
    } catch (e) {
      await audit(req.auth!.actor, 'press.mailbox_tested', { type: 'settings', label: 'Presse-Postfach' }, { art: next.mode, ergebnis: 'fehler' }, 'failed');
      return { ok: false, error: (e as Error).message };
    }
  });

  app.put('/press/mailbox', { preHandler: perm }, async (req) => {
    const b = input.extend({ enabled: z.boolean() }).parse(req.body);
    const cur = await mailboxConfig();
    const { next, password, dropSecret } = await merge(b);
    const problem = mailboxConfigProblem(next);
    if (problem && (b.enabled || b.host || b.mailbox)) throw badRequest(problem);
    // Zugangsdaten oder Einschalten: frische Passwortbestätigung
    const changedAccess = !!b.password || JSON.stringify([cur.mode, cur.host, cur.port, cur.user, cur.mailbox, cur.security]) !== JSON.stringify([next.mode, next.host, next.port, next.user, next.mailbox, next.security]);
    if (changedAccess || (b.enabled && !cur.enabled)) assertRecentAuth(req);
    const fp = mailboxFingerprint(next, password);
    const unchanged = cur.enabled && fp === mailboxFingerprint(cur, (await readSecret(cur.secretId || null)) ?? '');
    if (b.enabled && !unchanged) {
      const v = cur.verified;
      if (!v || v.fp !== fp || Date.now() - new Date(v.at).getTime() > VERIFY_MAX_AGE_MS) throw new AppError(409, 'not_verified', 'Bitte zuerst mit genau diesen Angaben „Verbindung testen“ (erfolgreich, höchstens eine Stunde her).');
    }
    if (b.password) {
      const sec = await storeSecret('setting', SECRET_OWNER, b.password, req.auth!.user?.id ?? null);
      if (cur.secretId && cur.secretId !== sec.id) await revokeSecret(cur.secretId);
      next.secretId = sec.id;
    } else if (dropSecret) {
      // Ziel geändert ohne neues Passwort (Microsoft 365 oder Angaben geleert): das alte Passwort gehört zum alten Server
      await revokeSecret(cur.secretId);
      next.secretId = '';
    }
    next.enabled = b.enabled;
    await setSettings({ 'press.mailbox': next } as any, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'press.mailbox_saved', { type: 'settings', label: 'Presse-Postfach' }, { art: next.mode, aktiv: next.enabled, server: next.mode === 'imap' ? next.host : next.mailbox, passwort_geaendert: !!b.password, ...(dropSecret ? { passwort_verworfen: true } : {}) });
    return { ok: true, config: publicConfig(next) };
  });

  app.post('/press/mailbox/poll', { preHandler: perm, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const c = await mailboxConfig();
    if (!c.enabled) throw badRequest('Der Abruf ist ausgeschaltet.');
    const r = await pollPressMailbox({ force: true });
    await audit(req.auth!.actor, 'press.mailbox_polled', { type: 'settings', label: 'Presse-Postfach' }, { uebernommen: r.imported ?? 0, fehler: r.error ?? null });
    return r;
  });

  app.get('/press/attachments/:id', { preHandler: requireAuth('press.view') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const a = await one<any>(`SELECT filename, content_type, data FROM press_attachments WHERE id = $1`, [id]);
    if (!a) throw notFound('Anhang nicht gefunden.');
    const ascii = String(a.filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return reply
      .header('content-type', a.content_type)
      .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(a.data);
  });
}

