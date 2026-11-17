import { one, pool, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { log } from './log.js';
import { mailReady } from './mail.js';
import { categoryFor } from './notify-categories.js';
import { getSettings } from './settings.js';

/**
 * In-App-Benachrichtigung an alle Benutzer mit einem Recht (oder an eine Person).
 * Titel und Text bleiben knapp, können aber Stichwort und Ort eines Einsatzes, den Betreff einer Presse-Mail oder
 * Vorlagentext eines Workflows enthalten. Nach außen (Push, E-Mail) gehen sie nur mit notify.push_details bzw.
 * notify.mail_details, sonst nur die Art und ein Link (lib/notify-channels.ts, #247).
 *
 * Push und E-Mail (#191): Jede Benachrichtigung gehört zu einer Art (`category`, sonst aus dem Recht abgeleitet,
 * lib/notify-categories.ts). Ist ein Kanal überhaupt möglich (Push-Abo vorhanden bzw. E-Mail-Versand eingerichtet),
 * plant sie einen Auftrag `notify.deliver` ein; der Worker stellt nach der Wahl jeder Person zu
 * (lib/notify-channels.ts). Fehler dabei blockieren nie die auslösende Aktion.
 */
export async function notify(n: { kind: 'error' | 'warning' | 'info' | 'success'; title: string; body?: string; link?: string; permission?: string; userId?: string; category?: string }) {
  const category = categoryFor(n.category, n.permission);
  const row = await one<{ id: number }>('INSERT INTO notifications (kind, title, body, link, permission, user_id, category) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [
    n.kind,
    n.title.slice(0, 200),
    (n.body ?? '').slice(0, 1000),
    n.link ?? null,
    n.permission ?? null,
    n.userId ?? null,
    category,
  ]);
  if (row && category) await scheduleDelivery(row.id);
}

/** Zustellung per Push/E-Mail einplanen, wenn überhaupt ein Kanal möglich ist. */
export async function scheduleDelivery(notificationId: number, db: Queryable = pool) {
  try {
    const s = await getSettings();
    const mail = s['notify.mail_enabled'] && mailReady(s);
    const push = s['notify.push_enabled'] && !!s['push.vapid_secret_id'] && !!(await one('SELECT 1 FROM push_subscriptions LIMIT 1', [], db));
    if (!mail && !push) return;
    await enqueue('notify.deliver', { id: notificationId }, { maxAttempts: 2 }, db);
  } catch (e) {
    log('warn', 'notify', `Zustellung per Push/E-Mail nicht eingeplant: ${(e as Error).message}`);
  }
}
