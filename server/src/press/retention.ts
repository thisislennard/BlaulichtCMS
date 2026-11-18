import { many, one, pool, tx } from '../db/pool.js';
import { notify } from '../lib/notify.js';
import type { RetentionCategory } from '../lib/retention.js';
import type { Settings } from '../lib/settings.js';

/*
 * Löschfristen der Presseanfragen (#204, #243; Art. 5 Abs. 1 lit. e, Art. 17 DSGVO).
 *
 * - Erledigte Anfragen: `privacy.press_request_months` Monate nach der Erledigung.
 * - Nicht erledigte Anfragen (neu, in Bearbeitung, beantwortet – z. B. nach einer Antwort nie auf „erledigt“ gesetzt
 *   oder eine fehlgeleitete Mail aus dem Presse-Postfach, die niemand bearbeitet): `privacy.press_open_months` Monate
 *   nach der letzten Aktivität. Die Löschung wird PRESS_NOTICE_DAYS Tage vorher an „Presseanfragen bearbeiten“
 *   angekündigt und erst danach ausgeführt; jede Aktivität (Änderung, Notiz, Statuswechsel, Mail) setzt die Frist zurück.
 *
 * Gelöscht wird jeweils die ganze Anfrage samt Kontaktdaten, Verlauf, Mails und Anhängen (Kaskade).
 */

/** Vorlauf der Ankündigung vor dem Löschen nicht erledigter Anfragen. */
export const PRESS_NOTICE_DAYS = 30;

/** Letzte Aktivität einer Anfrage `r`: Anlage, Änderung (jeder Verlaufseintrag setzt updated_at), Antwort, Erledigung, Mail. */
const LAST = `GREATEST(r.created_at, r.updated_at, r.answered_at, r.done_at,
    (SELECT max(GREATEST(m.created_at, m.sent_at)) FROM press_messages m WHERE m.request_id = r.id),
    (SELECT max(e.at) FROM press_request_events e WHERE e.request_id = r.id))`;

/** Löschung seit der letzten Aktivität angekündigt (nicht erledigte Anfrage `r`). */
export const PRESS_ANNOUNCED_SQL = `(r.status <> 'done' AND r.retention_notified_at IS NOT NULL AND r.retention_notified_at >= ${LAST})`;

/** fällig: Frist ohne Aktivität abgelaufen und die Ankündigung ist mindestens PRESS_NOTICE_DAYS Tage alt ($1 Monate, $2 Tage) */
const DUE = `${PRESS_ANNOUNCED_SQL} AND ${LAST} < now() - make_interval(months => $1) AND r.retention_notified_at <= now() - make_interval(days => $2)`;
/** anzukündigen: Frist läuft in höchstens PRESS_NOTICE_DAYS Tagen ab (oder ist schon abgelaufen), seit der letzten Aktivität noch nicht angekündigt */
const TO_NOTICE = `r.status <> 'done' AND ${LAST} < now() - make_interval(months => $1) + make_interval(days => $2)
    AND (r.retention_notified_at IS NULL OR r.retention_notified_at < ${LAST})`;

const whole = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
const count = async (where: string, params: unknown[]) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM press_requests r WHERE ${where}`, params))!.n;

/** Beide Kategorien für „Was würde gelöscht?“ bzw. den stündlichen Lauf (lib/retention.ts). */
export async function pressRequestRetention(dryRun: boolean, s: Settings): Promise<RetentionCategory[]> {
  const doneMonths = whole(s['privacy.press_request_months']);
  const done: RetentionCategory = { key: 'press_requests', label: 'Erledigte Presseanfragen mit Kontaktdaten, Verlauf, Mails und Anhängen (Monate nach Erledigung)', days: doneMonths * 30, count: 0 };
  if (doneMonths > 0) {
    const where = `r.status = 'done' AND r.done_at < now() - make_interval(months => $1)`;
    if (dryRun) done.count = await count(where, [doneMonths]);
    else done.count = (await pool.query(`DELETE FROM press_requests WHERE id IN (SELECT r.id FROM press_requests r WHERE ${where} LIMIT 5000)`, [doneMonths])).rowCount ?? 0;
  }

  const openMonths = whole(s['privacy.press_open_months']);
  const open: RetentionCategory = {
    key: 'press_requests_open',
    label: `Nicht erledigte Presseanfragen (neu, in Bearbeitung, beantwortet) samt Mails und Anhängen (Monate ohne Aktivität, nach ${PRESS_NOTICE_DAYS} Tagen Ankündigung)`,
    days: openMonths * 30,
    count: 0,
  };
  if (openMonths > 0) {
    const p = [openMonths, PRESS_NOTICE_DAYS];
    if (dryRun) {
      open.count = await count(DUE, p);
      const announced = (await count(PRESS_ANNOUNCED_SQL, [])) - open.count;
      const pending = await count(TO_NOTICE, p);
      if (announced || pending) open.note = `${announced} angekündigt (Löschung frühestens ${PRESS_NOTICE_DAYS} Tage nach der Ankündigung), ${pending} beim nächsten Lauf anzukündigen`;
    } else {
      open.count = (await pool.query(`DELETE FROM press_requests WHERE id IN (SELECT r.id FROM press_requests r WHERE ${DUE} LIMIT 5000)`, p)).rowCount ?? 0;
      // Ankündigung: Zeitpunkt vermerken (ändert updated_at nicht – zählt also nicht als Aktivität) und einmal benachrichtigen
      const noticed = await many<{ id: string; case_no: string }>(`UPDATE press_requests SET retention_notified_at = now() WHERE id IN (SELECT r.id FROM press_requests r WHERE ${TO_NOTICE} ORDER BY r.case_no LIMIT 5000) RETURNING id, case_no`, p);
      if (noticed.length) {
        const nos = noticed.map((r) => r.case_no).sort();
        await notify({
          kind: 'warning',
          title: noticed.length === 1 ? `Presseanfrage ${nos[0]} wird in ${PRESS_NOTICE_DAYS} Tagen gelöscht` : `${noticed.length} Presseanfragen werden in ${PRESS_NOTICE_DAYS} Tagen gelöscht`,
          body: `Nicht erledigt und seit ${openMonths} Monaten ohne Aktivität (Löschfrist, Einstellungen → Löschfristen): ${nos.slice(0, 15).join(', ')}${nos.length > 15 ? ' …' : ''}. Eine Änderung, Notiz oder Mail setzt die Frist zurück.`,
          link: noticed.length === 1 ? `/presse/${noticed[0].id}` : '/presse?filter=expiring',
          permission: 'press.manage',
          category: 'press',
        });
      }
    }
  }
  return [done, open];
}

/**
 * Versandprotokolle der Pressemitteilungen (#244): `privacy.press_release_log_months` Monate nach dem Versand werden die
 * Empfängerzeilen (Adresse, Name, Stand, Fehlermeldung des Mailservers) gelöscht; Zahl der Empfänger, gesendet und nicht
 * erreicht bleiben an der Pressemitteilung. Laufende Versände bleiben unberührt.
 */
export async function pressReleaseLogRetention(dryRun: boolean, s: Settings): Promise<RetentionCategory> {
  const months = whole(s['privacy.press_release_log_months']);
  const cat: RetentionCategory = { key: 'press_release_logs', label: 'Versandprotokolle der Pressemitteilungen (Empfängeradressen, Stand, Fehlermeldungen – die Zähler bleiben)', days: months * 30, count: 0 };
  if (!months) return cat;
  const where = `r.status IN ('sent','partial') AND r.log_purged_at IS NULL AND COALESCE(r.sent_at, r.updated_at) < now() - make_interval(months => $1)`;
  if (dryRun) {
    const q = (await one<{ n: number; rows: number }>(`SELECT count(*)::int AS n, COALESCE(sum((SELECT count(*) FROM press_release_recipients x WHERE x.release_id = r.id)), 0)::int AS rows FROM press_releases r WHERE ${where}`, [months]))!;
    cat.count = q.n;
    cat.detail = `${q.rows} Empfängerzeile(n)`;
    return cat;
  }
  const res = await tx(async (db) => {
    const done = await many<{ id: string }>(
      `UPDATE press_releases p SET log_purged_at = now(), recipients_total = c.total, recipients_sent = c.sent, recipients_failed = c.bad
         FROM (SELECT r.id, count(x.id)::int AS total, count(x.id) FILTER (WHERE x.status = 'sent')::int AS sent, count(x.id) FILTER (WHERE x.status IN ('failed','unknown'))::int AS bad
                 FROM (SELECT r.id FROM press_releases r WHERE ${where} ORDER BY r.sent_at LIMIT 500 FOR UPDATE) r LEFT JOIN press_release_recipients x ON x.release_id = r.id GROUP BY r.id) c
        WHERE p.id = c.id RETURNING p.id`,
      [months],
      db,
    );
    const rows = done.length ? ((await db.query(`DELETE FROM press_release_recipients WHERE release_id = ANY($1::uuid[])`, [done.map((d) => d.id)])).rowCount ?? 0) : 0;
    return { n: done.length, rows };
  });
  cat.count = res.n;
  cat.detail = `${res.rows} Empfängerzeile(n)`;
  return cat;
}

/** Geplante Löschung einer Anfrage für die Detailansicht – nur, wenn sie angekündigt ist (sonst null). */
export async function pressRequestDeletion(id: string, s: Settings): Promise<{ at: string } | null> {
  const openMonths = whole(s['privacy.press_open_months']);
  if (!openMonths) return null;
  const r = await one<{ at: Date | null }>(
    `SELECT GREATEST(x.last + make_interval(months => $2), r.retention_notified_at + make_interval(days => $3)) AS at
       FROM press_requests r CROSS JOIN LATERAL (SELECT ${LAST} AS last) x WHERE r.id = $1 AND ${PRESS_ANNOUNCED_SQL}`,
    [id, openMonths, PRESS_NOTICE_DAYS],
  );
  return r?.at ? { at: new Date(r.at).toISOString() } : null;
}
