import { many, one, pool, tx } from '../db/pool.js';
import { permissionsFor } from '../auth/permissions.js';
import { ensureRolesFresh } from '../auth/roles.js';
import { log } from './log.js';
import { mailReady } from './mail.js';
import { categoryFor, chosenChannels, notifyCategory, type NotifyCategory } from './notify-categories.js';
import { readSecret, revokeSecret, storeSecret } from './secrets.js';
import { getSettings, setSettings, type Settings } from './settings.js';
import { generateVapidKeys, sendPush, type VapidKeys } from './webpush.js';

/**
 * Zustellung der Benachrichtigungen per Push und E-Mail (#191, wie die Versandschicht von LiFeOS #922):
 * Der Worker führt `notify.deliver` aus, ermittelt die Empfänger wie die Glocke (Recht bzw. Person), wählt je Person
 * die Kanäle (eigene Wahl unter „Mein Konto“, sonst Vorgabe der Art; globale Schalter) und stellt zu. Fehler einzelner
 * Geräte oder Postfächer werden protokolliert und nie wiederholt (keine doppelten Meldungen); erloschene Push-Abos
 * (404/410) werden gelöscht.
 */

export const VAPID_SECRET_OWNER = '00000000-0000-0000-0000-00000000a91d';
const VAPID_LOCK = 74_210_191;

/** VAPID-Schlüssel lesen; fehlen sie, unter Sperre einmalig erzeugen (privater Schlüssel verschlüsselt in `secrets`). */
export async function vapidKeys(create = true): Promise<VapidKeys | null> {
  const s = await getSettings(true);
  if (s['push.vapid_public_key'] && s['push.vapid_secret_id']) {
    const priv = await readSecret(s['push.vapid_secret_id']);
    if (priv) return { publicKey: s['push.vapid_public_key'], privateKey: priv };
  }
  if (!create) return null;
  return tx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [VAPID_LOCK]);
    const cur = await many<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key IN ('push.vapid_public_key', 'push.vapid_secret_id')`, [], db);
    const pub = cur.find((r) => r.key === 'push.vapid_public_key')?.value;
    const sid = cur.find((r) => r.key === 'push.vapid_secret_id')?.value;
    if (typeof pub === 'string' && pub && typeof sid === 'string' && sid) {
      const priv = await readSecret(sid, db);
      if (priv) return { publicKey: pub, privateKey: priv };
    }
    const keys = generateVapidKeys();
    const sec = await storeSecret('setting', VAPID_SECRET_OWNER, keys.privateKey, null, db);
    if (typeof sid === 'string' && sid) await revokeSecret(sid, db);
    await setSettings({ 'push.vapid_public_key': keys.publicKey, 'push.vapid_secret_id': sec.id } as Partial<Settings>, null, db);
    log('info', 'notify', 'Schlüsselpaar für Push-Benachrichtigungen (VAPID) erzeugt.');
    return keys;
  });
}

/** Neues Schlüsselpaar: alle bisherigen Abos werden ungültig und gelöscht (Geräte müssen Push neu einschalten). */
export async function rotateVapidKeys(userId: string | null): Promise<string> {
  return tx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [VAPID_LOCK]);
    const old = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'push.vapid_secret_id'`, [], db);
    const keys = generateVapidKeys();
    const sec = await storeSecret('setting', VAPID_SECRET_OWNER, keys.privateKey, userId, db);
    if (typeof old?.value === 'string' && old.value) await revokeSecret(old.value, db);
    await setSettings({ 'push.vapid_public_key': keys.publicKey, 'push.vapid_secret_id': sec.id } as Partial<Settings>, userId, db);
    await db.query('DELETE FROM push_subscriptions');
    return keys.publicKey;
  });
}

/** Kontaktangabe für VAPID (RFC 8292 „sub“): öffentliche Adresse, sonst Absenderadresse. */
export function pushSubject(s: Settings): string {
  const url = String(s['general.public_url'] ?? '');
  if (/^https:\/\//i.test(url)) return url.replace(/\/+$/, '');
  const from = String((s['mail.transport'] === 'm365' ? s['m365.sender'] : s['smtp.from']) ?? '').match(/[^\s<>"]+@[^\s<>"]+/)?.[0];
  return from ? `mailto:${from}` : 'mailto:blaulichtcms@example.org';
}

interface Recipient {
  id: string;
  email: string;
  name: string;
  preferences: any;
  roles: string[];
}

const absolute = (s: Settings, link: string | null) => {
  if (!link) return '';
  const base = String(s['general.public_url'] ?? '').replace(/\/+$/, '');
  return base ? `${base}${link}` : link;
};

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string; vapid_key: string };

/** Ein Abo beliefern und den Stand am Abo vermerken. */
async function pushTo(sub: SubRow, payload: Record<string, unknown>, keys: VapidKeys, subject: string, urgency: 'normal' | 'high') {
  if (sub.vapid_key && sub.vapid_key !== keys.publicKey) {
    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
    return { status: 'expired' as const, error: 'Abo gehört zu einem früheren Schlüssel.' };
  }
  const r = await sendPush(sub, payload, keys, subject, urgency);
  if (r.status === 'sent') await pool.query('UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1', [sub.id]);
  else if (r.status === 'expired') await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
  // Nach 10 Fehlschlägen in Folge ist das Abo praktisch tot – entfernen statt endlos zu versuchen
  else await pool.query(`WITH u AS (UPDATE push_subscriptions SET last_error = $2, last_error_at = now(), failures = failures + 1 WHERE id = $1 RETURNING id, failures) DELETE FROM push_subscriptions p USING u WHERE p.id = u.id AND u.failures >= 10`, [sub.id, r.error.slice(0, 300)]);
  return r;
}

export function pushPayload(n: { title: string; body?: string; link?: string | null; kind?: string }, category: string, s: Settings) {
  return {
    title: n.title.slice(0, 200),
    body: String(n.body ?? '').slice(0, 500),
    link: n.link && n.link.startsWith('/') ? n.link : '/benachrichtigungen',
    tag: `blaulichtcms-${category}`,
    kind: n.kind ?? 'info',
    app: String(s['general.instance_name'] || 'BlaulichtCMS'),
  };
}

/** Auftrag `notify.deliver`: eine Benachrichtigung an alle passenden Personen per Push und E-Mail zustellen. */
export async function deliverNotification(id: number) {
  const n = await one<{ id: number; kind: string; title: string; body: string; link: string | null; permission: string | null; user_id: string | null; category: string | null }>(
    'SELECT id, kind, title, body, link, permission, user_id, category FROM notifications WHERE id = $1',
    [id],
  );
  if (!n) return;
  const cat = notifyCategory(categoryFor(n.category, n.permission));
  if (!cat) return;
  const s = await getSettings(true);
  const pushOn = !!s['notify.push_enabled'];
  const mailOn = !!s['notify.mail_enabled'] && mailReady(s);
  if (!pushOn && !mailOn) return;
  await ensureRolesFresh();
  const users = n.user_id
    ? await many<Recipient>(`SELECT id, email, name, preferences, roles FROM users WHERE id = $1 AND status = 'active'`, [n.user_id])
    : await many<Recipient>(`SELECT id, email, name, preferences, roles FROM users WHERE status = 'active'`);
  const recipients = users.filter((u) => {
    if (n.user_id) return true;
    const perms = permissionsFor(u.roles ?? []);
    if (n.permission && !perms.has(n.permission)) return false;
    return !cat.permissions.length || cat.permissions.some((p) => perms.has(p));
  });
  const pushUsers: Recipient[] = [];
  const mailUsers: Recipient[] = [];
  for (const u of recipients) {
    const ch = chosenChannels(cat, u.preferences?.notifyChannels);
    if (pushOn && ch.includes('push')) pushUsers.push(u);
    if (mailOn && ch.includes('mail') && u.email) mailUsers.push(u);
  }
  if (pushUsers.length) await deliverPush(n, cat, pushUsers, s);
  if (mailUsers.length) await deliverMail(n, cat, mailUsers, s);
}

async function deliverPush(n: { title: string; body: string; link: string | null; kind: string }, cat: NotifyCategory, users: Recipient[], s: Settings) {
  const subs = await many<SubRow>('SELECT id, endpoint, p256dh, auth, vapid_key FROM push_subscriptions WHERE user_id = ANY($1::uuid[])', [users.map((u) => u.id)]);
  if (!subs.length) return;
  const keys = await vapidKeys(false);
  if (!keys) return;
  const payload = pushPayload(n, cat.id, s);
  const subject = pushSubject(s);
  let failed = 0;
  for (const sub of subs) {
    const r = await pushTo(sub, payload, keys, subject, cat.urgency);
    if (r.status === 'failed') failed++;
  }
  if (failed) log('warn', 'notify', `Push „${cat.label}“: ${failed} von ${subs.length} Gerät(en) nicht erreicht.`);
}

async function deliverMail(n: { title: string; body: string; link: string | null }, cat: NotifyCategory, users: Recipient[], s: Settings) {
  const { smtpTransport } = await import('../warnings/mail.js');
  const { transport, from } = await smtpTransport();
  const instance = String(s['general.instance_name'] || 'BlaulichtCMS');
  const link = absolute(s, n.link);
  const prefs = absolute(s, '/profil#benachrichtigungen');
  let failed = 0;
  try {
    // Einzeln senden: Empfänger sehen einander nicht
    for (const u of users) {
      try {
        await transport.sendMail({
          from,
          to: u.email,
          subject: `[${instance}] ${n.title}`.slice(0, 250),
          text: [n.body, link ? `Öffnen: ${link}` : '', '—', `Benachrichtigung „${cat.label}“ von ${instance}.`, `Einstellen unter Mein Konto → Benachrichtigungen${prefs.startsWith('http') ? `: ${prefs}` : ''}.`].filter(Boolean).join('\n\n'),
        });
      } catch (e) {
        failed++;
        log('warn', 'notify', `E-Mail-Benachrichtigung „${cat.label}“ nicht zugestellt: ${(e as Error).message.slice(0, 300)}`);
      }
    }
  } finally {
    transport.close();
  }
  if (failed && failed === users.length && users.length > 1) log('error', 'notify', `E-Mail-Benachrichtigungen „${cat.label}“: keine der ${users.length} Mails zugestellt.`);
}

/** Testnachricht an die Geräte einer Person (ein Gerät oder alle). Gibt je Gerät das Ergebnis zurück. */
export async function sendTestPush(userId: string, subscriptionId?: string) {
  const s = await getSettings(true);
  const keys = await vapidKeys(false);
  if (!keys) return [];
  const subs = await many<SubRow & { label: string }>(
    `SELECT id, endpoint, p256dh, auth, vapid_key, label FROM push_subscriptions WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)`,
    [userId, subscriptionId ?? null],
  );
  const payload = pushPayload({ title: 'Testnachricht', body: 'Push-Benachrichtigungen von BlaulichtCMS funktionieren auf diesem Gerät.', link: '/profil#benachrichtigungen', kind: 'success' }, 'test', s);
  const out: { id: string; label: string; status: string; error?: string }[] = [];
  for (const sub of subs) {
    const r = await pushTo(sub, payload, keys, pushSubject(s), 'normal');
    out.push({ id: sub.id, label: sub.label, status: r.status, ...('error' in r ? { error: r.error } : {}) });
  }
  return out;
}
