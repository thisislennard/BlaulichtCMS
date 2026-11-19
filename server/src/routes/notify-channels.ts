import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { assertRecentAuth, requireAuth } from '../auth/context.js';
import { audit, settingsDiff } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { m365ConfigProblem, m365Fingerprint, m365Send, mailReady, mailRouteLabel, resetM365TokenCache, storedM365Settings, type M365Settings } from '../lib/mail.js';
import { categoriesFor, chosenChannels, mutedBellCategories, NOTIFY_CHANNELS } from '../lib/notify-categories.js';
import { pushSubject, rotateVapidKeys, sendTestPush, vapidKeys } from '../lib/notify-channels.js';
import { revokeSecret, storeSecret } from '../lib/secrets.js';
import { getSettings, setSettings, type Settings } from '../lib/settings.js';
import { checkPushEndpoint } from '../lib/webpush.js';
import { securityAlert } from '../lib/security-alerts.js';
import { replaceSmtpPassword, smtpCandidate, smtpConfigProblem, smtpFormChanged, smtpVerified, storedSmtpSettings, type SmtpForm } from '../warnings/mail.js';
import { smtpTestMail } from './warnings.js';

/**
 * Benachrichtigungen per Push und E-Mail (#191):
 *  - „Mein Konto → Benachrichtigungen“: Kanäle je Art, Push-Abos dieses und weiterer Geräte, Testnachricht.
 *  - „Einstellungen → E-Mail & Push“ (Recht settings.mail, #256): Versandweg SMTP oder Microsoft 365 – beide mit
 *    Zugang und Testmail an dieser einen Stelle –, Kanäle global, Push-Schlüssel erneuern.
 */
export const M365_SECRET_OWNER = '00000000-0000-0000-0000-00000000a365';
const VERIFY_MAX_AGE_MS = 60 * 60_000;

const subscriptionSchema = z.object({
  endpoint: z.string().max(1024),
  keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(64) }),
});

export async function notifyChannelRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------------ Mein Konto */

  app.get('/notify/preferences', { preHandler: requireAuth() }, async (req) => {
    const a = req.auth!;
    if (!a.user) return { categories: [], channels: { push: false, mail: false }, subscriptions: [], vapidPublicKey: null };
    const s = await getSettings(true);
    const u = await one<{ email: string; preferences: any }>('SELECT email, preferences FROM users WHERE id = $1', [a.user.id]);
    const prefs = u?.preferences?.notifyChannels;
    const muted = new Set(mutedBellCategories(u?.preferences));
    const pushOn = !!s['notify.push_enabled'];
    const subs = await many<any>(
      `SELECT id, label, created_at, last_success_at, last_error, last_error_at, endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [a.user.id],
    );
    return {
      // Eine Matrix je Art (#253): Glocke (abschaltbar außer Sicherheits- und Kontomeldungen), Push, E-Mail
      categories: categoriesFor(a.permissions).map((c) => ({ id: c.id, label: c.label, description: c.description, group: c.group, channels: c.channels, chosen: chosenChannels(c, prefs), bell: !c.bell || !muted.has(c.id), bellLocked: !c.bell })),
      channels: { push: pushOn, mail: !!s['notify.mail_enabled'] && mailReady(s) },
      email: u?.email ?? '',
      // Adresse beim Push-Dienst nie ausgeben – nur ein Kennwert, an dem der Browser sein eigenes Abo wiedererkennt
      subscriptions: subs.map(({ endpoint, ...r }) => ({ ...r, endpoint_hash: sha256Hex(endpoint).slice(0, 16) })),
      vapidPublicKey: pushOn ? (await vapidKeys(true))!.publicKey : null,
    };
  });

  app.put('/notify/preferences', { preHandler: requireAuth() }, async (req) => {
    const a = req.auth!;
    if (!a.user) throw badRequest('Nur für Benutzerkonten.');
    const b = z
      .object({
        choices: z.record(z.string().max(40), z.array(z.enum(['push', 'mail'])).max(2)).default({}),
        /** Glocke je Art an/aus (#253); nicht abschaltbare oder nicht angebotene Arten werden übergangen */
        bell: z.record(z.string().max(40), z.boolean()).default({}),
      })
      .parse(req.body);
    const offered = new Map(categoriesFor(a.permissions).map((c) => [c.id, c]));
    const u = await one<{ preferences: any }>('SELECT preferences FROM users WHERE id = $1', [a.user.id]);
    const next: Record<string, string[]> = { ...(u?.preferences?.notifyChannels ?? {}) };
    for (const [id, list] of Object.entries(b.choices)) {
      const cat = offered.get(id);
      if (!cat) continue; // nicht angebotene Arten still übergehen
      next[id] = NOTIFY_CHANNELS.filter((ch) => cat.channels.includes(ch) && list.includes(ch));
    }
    const muted = new Set(mutedBellCategories(u?.preferences));
    for (const [id, on] of Object.entries(b.bell)) {
      if (!offered.get(id)?.bell) continue;
      if (on) muted.delete(id);
      else muted.add(id);
    }
    await pool.query(`UPDATE users SET preferences = preferences || jsonb_build_object('notifyChannels', $2::jsonb, 'mutedNotifications', $3::jsonb) WHERE id = $1`, [a.user.id, JSON.stringify(next), JSON.stringify([...muted])]);
    return { ok: true };
  });

  /** Push auf diesem Gerät einschalten: Abo des Browsers speichern. Ein Abo gehört genau einem Konto (wie LiFeOS #956). */
  app.post('/notify/push/subscriptions', { preHandler: requireAuth(), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = req.auth!;
    if (!a.user) throw badRequest('Nur für Benutzerkonten.');
    const s = await getSettings(true);
    if (!s['notify.push_enabled']) throw conflict('Push-Benachrichtigungen sind in den Einstellungen abgeschaltet.');
    const b = z.object({ subscription: subscriptionSchema, label: z.string().trim().max(80).default('') }).parse(req.body);
    if (!checkPushEndpoint(b.subscription.endpoint)) throw badRequest('Die Push-Adresse des Browsers gehört zu keinem bekannten Push-Dienst.');
    const keys = await vapidKeys(true);
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [a.user.id]);
    if (count!.n >= 20 && !(await one('SELECT 1 FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [b.subscription.endpoint, a.user.id]))) {
      throw conflict('Höchstens 20 Geräte je Konto – bitte ein altes Gerät entfernen.');
    }
    const row = await one<{ id: string }>(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, vapid_key) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, label = EXCLUDED.label,
         vapid_key = EXCLUDED.vapid_key, failures = 0, last_error = NULL, last_error_at = NULL
       RETURNING id`,
      [a.user.id, b.subscription.endpoint, b.subscription.keys.p256dh, b.subscription.keys.auth, b.label || 'Gerät', keys!.publicKey],
    );
    await audit(a.actor, 'notify.push_subscribed', { type: 'user', id: a.user.id, label: b.label || 'Gerät' });
    return { id: row!.id, endpoint_hash: sha256Hex(b.subscription.endpoint).slice(0, 16) };
  });

  app.delete('/notify/push/subscriptions/:id', { preHandler: requireAuth() }, async (req) => {
    const a = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING label', [id, a.user?.id ?? null]);
    if (!r.rowCount) throw notFound('Gerät nicht gefunden.');
    await audit(a.actor, 'notify.push_unsubscribed', { type: 'user', id: a.user!.id, label: r.rows[0].label });
    return { ok: true };
  });

  app.post('/notify/push/test', { preHandler: requireAuth(), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const a = req.auth!;
    if (!a.user) throw badRequest('Nur für Benutzerkonten.');
    const b = z.object({ id: z.uuid().optional() }).parse(req.body ?? {});
    const results = await sendTestPush(a.user.id, b.id);
    if (!results.length) throw badRequest('Für dieses Konto ist kein Gerät für Push eingerichtet.');
    return { results };
  });

  /* ------------------------------------------------------------------ Administration */

  const view = async (s: Settings) => ({
    transport: s['mail.transport'],
    route: mailRouteLabel(s),
    ready: mailReady(s),
    smtp: {
      host: s['smtp.host'],
      port: s['smtp.port'],
      security: s['smtp.security'],
      user: s['smtp.user'],
      from: s['smtp.from'],
      password_set: !!s['smtp.password_secret_id'],
      verified_at: s['smtp.verified']?.at ?? null,
      configured: !!(s['smtp.host'] && s['smtp.from']),
    },
    // Warnversand im Testmodus: Änderungen am SMTP-Server brauchen dann keine Testmail (Echtbetrieb: siehe PUT)
    warnings_test_mode: !!s['warnings.test_mode'],
    m365: {
      tenant_id: s['m365.tenant_id'],
      client_id: s['m365.client_id'],
      sender: s['m365.sender'],
      save_sent: s['m365.save_sent'],
      secret_set: !!s['m365.secret_id'],
      verified_at: s['m365.verified']?.at ?? null,
    },
    push_enabled: s['notify.push_enabled'],
    mail_enabled: s['notify.mail_enabled'],
    push_details: s['notify.push_details'],
    mail_details: s['notify.mail_details'],
    push: {
      key_set: !!s['push.vapid_public_key'],
      subscriptions: (await one<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions'))!.n,
      subject: pushSubject(s),
    },
  });

  app.get('/notify/settings', { preHandler: requireAuth('settings.view') }, async () => view(await getSettings(true)));

  /** Kandidat aus Formularwerten; gespeichertes Geheimnis nur für dieselbe Anwendung im selben Verzeichnis. */
  const candidate = (b: { tenantId: string; clientId: string; sender: string; clientSecret?: string; saveSent: boolean }, stored: M365Settings): M365Settings => {
    const same = b.tenantId.trim().toLowerCase() === stored.tenantId.trim().toLowerCase() && b.clientId.trim().toLowerCase() === stored.clientId.trim().toLowerCase();
    if (!b.clientSecret && !same && stored.clientSecret) throw badRequest('Verzeichnis oder Anwendung wurden geändert: Bitte das Client-Geheimnis erneut eingeben.');
    return { tenantId: b.tenantId.trim(), clientId: b.clientId.trim(), sender: b.sender.trim(), saveSent: b.saveSent, clientSecret: b.clientSecret || (same ? stored.clientSecret : '') };
  };

  const m365Body = {
    tenantId: z.string().trim().max(200).default(''),
    clientId: z.string().trim().max(60).default(''),
    sender: z.string().trim().max(200).default(''),
    clientSecret: z.string().max(500).optional(),
    saveSent: z.boolean().default(true),
  };

  const smtpBody = z.object({
    host: z.string().trim().max(200),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['starttls', 'tls', 'none']),
    user: z.string().max(200).default(''),
    from: z.string().max(200).default(''),
    password: z.string().max(500).optional(),
  });

  app.put('/notify/settings', { preHandler: requireAuth('settings.mail') }, async (req) => {
    const b = z.object({ transport: z.enum(['smtp', 'm365']), pushEnabled: z.boolean(), mailEnabled: z.boolean(), pushDetails: z.boolean().optional(), mailDetails: z.boolean().optional(), smtp: smtpBody.optional(), ...m365Body }).parse(req.body);
    const before = await getSettings(true);
    const stored = await storedM365Settings(before);
    // SMTP-Server (#256: hier statt unter Stichwörter & Regeln): optional im selben Speichervorgang
    const smtpStored = await storedSmtpSettings();
    if (b.smtp) {
      const problem = smtpConfigProblem({ security: b.smtp.security, user: b.smtp.user, password: b.smtp.password });
      if (problem) throw badRequest(problem);
    }
    const smtpNext = b.smtp ? smtpCandidate(b.smtp as SmtpForm, smtpStored) : smtpStored;
    const smtpChanged = !!b.smtp && smtpFormChanged(b.smtp as SmtpForm, smtpStored, smtpNext);
    // Microsoft 365: Speichern geht immer – auch unvollständig und ohne Testmail. Andere Anwendung ohne neues Geheimnis:
    // das gespeicherte gehört zur bisherigen und wird verworfen statt weitergegeben.
    const sameApp = b.tenantId.trim().toLowerCase() === stored.tenantId.trim().toLowerCase() && b.clientId.trim().toLowerCase() === stored.clientId.trim().toLowerCase();
    const dropSecret = !b.clientSecret && !sameApp && !!stored.clientSecret;
    const next: M365Settings = { tenantId: b.tenantId.trim(), clientId: b.clientId.trim(), sender: b.sender.trim(), saveSent: b.saveSent, clientSecret: b.clientSecret || (sameApp ? stored.clientSecret : '') };
    const fp = m365Fingerprint(next);
    const m365Changed = fp !== m365Fingerprint(stored);
    const m365Problem = m365ConfigProblem(next, true);
    const v = before['m365.verified'];
    const m365Verified = !m365Problem && !!v && v.fp === fp && Date.now() - Date.parse(v.at) <= VERIFY_MAX_AGE_MS;
    // Verwendet wird Microsoft 365 erst nach bestandener Testmail genau dieser Angaben (wie Verbindungen): Ohne sie
    // bleibt der bisherige Versandweg aktiv; ist Microsoft 365 schon aktiv, gelten geänderte Angaben sofort (Hinweis).
    let transport = b.transport;
    const notices: string[] = [];
    if (dropSecret) notices.push('Verzeichnis oder Anwendung wurden geändert: Das gespeicherte Client-Geheimnis wurde verworfen – bitte neu eingeben.');
    if (b.transport === 'm365' && before['mail.transport'] !== 'm365' && !m365Verified) {
      transport = 'smtp';
      notices.push(
        `Microsoft 365 ist gespeichert, aber noch nicht aktiv: ${m365Problem ?? 'Bitte mit genau diesen Angaben „Testmail senden“ und danach erneut speichern.'} ${smtpNext.host && smtpNext.from ? 'Bis dahin läuft der Versand weiter über SMTP.' : 'Bis dahin ist kein E-Mail-Versand eingerichtet.'}`,
      );
    } else if (b.transport === 'm365' && m365Changed && !m365Verified) {
      notices.push(m365Problem ? `Gespeichert – Achtung: ${m365Problem} Solange versendet BlaulichtCMS keine E-Mails.` : 'Gespeichert – Achtung: Microsoft 365 ist mit diesen Angaben noch nicht getestet. Bitte „Testmail senden“.');
    }
    if (b.transport === 'smtp' && (before['mail.transport'] !== 'smtp' || smtpChanged) && !(smtpNext.host && smtpNext.from)) {
      throw badRequest('Für den Versand über SMTP bitte Server und Absender eintragen – oder Microsoft 365 wählen.');
    }
    // Warnversand im Echtbetrieb: Wechsel auf SMTP bzw. geänderte SMTP-Angaben nur mit frischer Testmail genau dieser Werte
    if (b.transport === 'smtp' && (before['mail.transport'] !== 'smtp' || smtpChanged) && !before['warnings.test_mode'] && !smtpVerified(before['smtp.verified'], smtpNext)) {
      throw conflict('Der Warnversand ist im Echtbetrieb: SMTP lässt sich erst nach einer erfolgreichen Testmail mit genau diesen Angaben verwenden bzw. ändern (höchstens 60 Minuten alt). Bitte zuerst „Testmail senden“.');
    }
    const patch: Record<string, unknown> = {
      'mail.transport': transport,
      'm365.tenant_id': next.tenantId,
      'm365.client_id': next.clientId,
      'm365.sender': next.sender,
      'm365.save_sent': b.saveSent,
      'notify.push_enabled': b.pushEnabled,
      'notify.mail_enabled': b.mailEnabled,
      // Einzelheiten in Push/E-Mail (#247): fehlt der Wert (ältere Oberfläche), bleibt die Einstellung unverändert
      'notify.push_details': b.pushDetails ?? before['notify.push_details'],
      'notify.mail_details': b.mailDetails ?? before['notify.mail_details'],
    };
    if (b.smtp) Object.assign(patch, { 'smtp.host': smtpNext.host, 'smtp.port': smtpNext.port, 'smtp.security': smtpNext.security, 'smtp.user': smtpNext.user, 'smtp.from': smtpNext.from });
    const changes = settingsDiff(before as any, patch);
    const secretChange = !!b.clientSecret && b.clientSecret !== stored.clientSecret;
    const smtpPassword = !!b.smtp?.password;
    const result = { ok: true, transport, ...(notices.length ? { notice: notices.join(' ') } : {}) };
    if (!Object.keys(changes).length && !secretChange && !smtpPassword && !dropSecret) return result;
    // Wer den Weg der Mails ändert (Server, Zugang, Absender), bestätigt mit dem Passwort
    if (secretChange || dropSecret || smtpPassword || changes['mail.transport'] || changes['m365.tenant_id'] || changes['m365.client_id'] || changes['m365.sender'] || changes['smtp.host'] || changes['smtp.user'] || changes['smtp.from']) assertRecentAuth(req);
    await tx(async (db) => {
      if (dropSecret && !secretChange) {
        // Andere Anwendung ohne neues Geheimnis: das bisherige gehört zur alten App und wird nicht weiterverwendet
        const prev = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'm365.secret_id' FOR UPDATE`, [], db);
        patch['m365.secret_id'] = '';
        if (typeof prev?.value === 'string' && prev.value) await revokeSecret(prev.value, db);
      }
      if (secretChange) {
        // Neues Geheimnis: neue Version anlegen und die bisherige im selben Schritt widerrufen (#172)
        const prev = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'm365.secret_id' FOR UPDATE`, [], db);
        const sec = await storeSecret('setting', M365_SECRET_OWNER, b.clientSecret!, req.auth!.user?.id ?? null, db);
        patch['m365.secret_id'] = sec.id;
        if (typeof prev?.value === 'string' && prev.value && prev.value !== sec.id) await revokeSecret(prev.value, db);
      }
      if (smtpPassword) patch['smtp.password_secret_id'] = await replaceSmtpPassword(b.smtp!.password!, req.auth!.user?.id ?? null, db);
      await setSettings(patch as any, req.auth!.user?.id ?? null, db);
    });
    resetM365TokenCache();
    await audit(req.auth!.actor, 'notify.settings_changed', { type: 'settings', label: 'E-Mail & Push' }, { aenderungen: Object.keys(changes).length ? changes : undefined, geheimnis_geaendert: secretChange || undefined, geheimnis_verworfen: (dropSecret && !secretChange) || undefined, smtp_passwort_geaendert: smtpPassword || undefined, ...(notices.length ? { hinweis: notices.join(' ') } : {}) });
    if (changes['mail.transport'] || secretChange || smtpPassword || changes['smtp.host']) {
      await securityAlert('security_settings', {
        title: `E-Mail-Versand geändert von ${req.auth!.actor.name}`,
        body: `Versandweg: ${transport === 'm365' ? `Microsoft 365 (${next.sender})` : `SMTP (${smtpNext.host})`}${secretChange ? '; Client-Geheimnis ersetzt' : ''}${smtpPassword ? '; SMTP-Passwort ersetzt' : ''}.`,
        link: '/einstellungen/e-mail',
        kind: 'info',
      });
    }
    return result;
  });

  /** Verbindungstest Microsoft 365: Anmeldung der App und Testmail mit den Formularwerten (auch ungespeichert). */
  app.post('/notify/settings/test-mail', { preHandler: requireAuth('settings.mail'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ to: z.email(), ...m365Body }).parse(req.body);
    const stored = await storedM365Settings();
    const cand = candidate(b, stored);
    const problem = m365ConfigProblem(cand);
    if (problem) throw badRequest(problem);
    try {
      const info = await m365Send(cand, { to: b.to, subject: 'BlaulichtCMS: Testmail über Microsoft 365', text: 'Diese Testmail bestätigt, dass BlaulichtCMS E-Mails über Microsoft 365 (Microsoft Graph) versenden kann.' });
      const at = new Date().toISOString();
      await setSettings({ 'm365.verified': { fp: m365Fingerprint(cand), at } }, req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'notify.test_mail', { type: 'settings', label: 'Microsoft 365' }, { an: b.to, absender: cand.sender });
      return { ok: true, response: info.response, verified_at: at };
    } catch (e) {
      await audit(req.auth!.actor, 'notify.test_mail', { type: 'settings', label: 'Microsoft 365' }, { an: b.to, absender: cand.sender, fehler: (e as Error).message.slice(0, 200) }, 'failed').catch(() => {});
      throw new AppError(502, 'mail_failed', `Testmail fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  /** SMTP-Testmail mit den Formularwerten (auch ungespeichert); hinterlegt den Prüfwert für den Echtbetrieb (#256). */
  app.post('/notify/settings/smtp-test', { preHandler: requireAuth('settings.mail'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ to: z.email(), host: z.string().trim().max(200), port: z.number().int().min(1).max(65535), security: z.enum(['starttls', 'tls', 'none']), user: z.string().max(200).default(''), from: z.string().max(200).default(''), password: z.string().max(500).optional() }).parse(req.body);
    return smtpTestMail(req, b);
  });

  /** Neues Push-Schlüsselpaar (z. B. nach Verdacht auf Offenlegung): alle Geräte müssen Push neu einschalten. */
  app.post('/notify/settings/push-rotate', { preHandler: requireAuth('settings.mail') }, async (req) => {
    assertRecentAuth(req);
    const removed = (await one<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions'))!.n;
    await rotateVapidKeys(req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'notify.push_keys_rotated', { type: 'settings', label: 'Push-Schlüssel' }, { entfernte_geraete: removed });
    return { ok: true, removed };
  });
}
