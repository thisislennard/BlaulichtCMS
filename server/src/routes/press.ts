import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { permissionsFor } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { emitNewPressRequest, nextPressCaseNo, PRESS_CHANNEL_LABEL, PRESS_CHANNELS, PRESS_STATUS, PRESS_STATUS_LABEL, pressEvent, type PressChannel, type PressStatus } from '../press/common.js';

/*
 * Presseanfragen (#204): erfassen, Status, Zuständigkeit, Frist, Verknüpfung mit Einsatz und Beitrag, Notizen, Verlauf.
 * Antworten per Mail (#206) und der Postfach-Abruf (#205) hängen sich an dieselben Anfragen.
 */

const text = (max: number) => z.string().trim().max(max);
const optUuid = z.uuid().nullable();

const fields = {
  topic: text(300).min(2, 'Bitte ein Thema angeben.'),
  body: text(20_000),
  outlet: text(200),
  contactName: text(200),
  contactEmail: z.union([z.literal(''), z.email().max(254)]),
  contactPhone: text(60),
  channel: z.enum(PRESS_CHANNELS),
  status: z.enum(PRESS_STATUS),
  assigneeId: optUuid,
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  postId: optUuid,
  fe2EventId: optUuid,
};

const createInput = z.object({
  ...fields,
  body: fields.body.default(''),
  outlet: fields.outlet.default(''),
  contactName: fields.contactName.default(''),
  contactEmail: fields.contactEmail.default(''),
  contactPhone: fields.contactPhone.default(''),
  channel: fields.channel.default('phone'),
  status: fields.status.default('new'),
  assigneeId: optUuid.default(null),
  dueAt: fields.dueAt.default(null),
  postId: optUuid.default(null),
  fe2EventId: optUuid.default(null),
});
const updateInput = z.object(fields).partial();

const COLUMN: Record<keyof typeof fields, string> = {
  topic: 'topic',
  body: 'body',
  outlet: 'outlet',
  contactName: 'contact_name',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
  channel: 'channel',
  status: 'status',
  assigneeId: 'assignee_id',
  dueAt: 'due_at',
  postId: 'post_id',
  fe2EventId: 'fe2_event_id',
};
const FIELD_LABEL: Record<keyof typeof fields, string> = {
  topic: 'Thema',
  body: 'Anfrage',
  outlet: 'Medium/Redaktion',
  contactName: 'Name',
  contactEmail: 'E-Mail',
  contactPhone: 'Telefon',
  channel: 'Eingangsweg',
  status: 'Status',
  assigneeId: 'Zuständig',
  dueAt: 'Frist',
  postId: 'Beitrag',
  fe2EventId: 'Einsatz',
};

const LIST_SQL = `SELECT r.id, r.case_no, r.status, r.channel, r.outlet, r.contact_name, r.topic, r.due_at, r.created_at, r.updated_at, r.done_at,
       r.assignee_id, u.name AS assignee_name, (r.due_at IS NOT NULL AND r.due_at < now() AND r.status IN ('new','in_progress')) AS overdue
  FROM press_requests r LEFT JOIN users u ON u.id = r.assignee_id`;

/** Personen, die eine Anfrage übernehmen können: aktive Konten mit „Presseanfragen ansehen“. */
async function assignableUsers(): Promise<{ id: string; name: string }[]> {
  const users = await many<{ id: string; name: string; roles: string[] }>(`SELECT id, name, roles FROM users WHERE status = 'active' ORDER BY lower(name)`);
  return users.filter((u) => permissionsFor(u.roles).has('press.view')).map(({ id, name }) => ({ id, name }));
}

async function assertRefs(v: { assigneeId?: string | null; postId?: string | null; fe2EventId?: string | null }) {
  if (v.assigneeId && !(await assignableUsers()).some((u) => u.id === v.assigneeId)) throw badRequest('Die gewählte Person gibt es nicht oder sie darf Presseanfragen nicht ansehen.');
  if (v.postId && !(await one(`SELECT 1 FROM posts WHERE id = $1`, [v.postId]))) throw badRequest('Den gewählten Beitrag gibt es nicht.');
  if (v.fe2EventId && !(await one(`SELECT 1 FROM fe2_events WHERE id = $1`, [v.fe2EventId]))) throw badRequest('Den gewählten Einsatz gibt es nicht.');
}

export async function loadPressRequest(id: string) {
  const r = await one<any>(
    `SELECT r.*, u.name AS assignee_name, c.name AS created_by_name,
            (SELECT title FROM posts WHERE id = r.post_id) AS post_title,
            (SELECT COALESCE(NULLIF(title, ''), keyword, 'Einsatz') FROM fe2_events WHERE id = r.fe2_event_id) AS fe2_title,
            (SELECT received_at FROM fe2_events WHERE id = r.fe2_event_id) AS fe2_received_at,
            (r.due_at IS NOT NULL AND r.due_at < now() AND r.status IN ('new','in_progress')) AS overdue
       FROM press_requests r LEFT JOIN users u ON u.id = r.assignee_id LEFT JOIN users c ON c.id = r.created_by WHERE r.id = $1`,
    [id],
  );
  if (!r) throw notFound('Presseanfrage nicht gefunden.');
  return r;
}

const describe = (k: keyof typeof fields, v: unknown, names: Record<string, string>): string => {
  if (v == null || v === '') return '–';
  if (k === 'status') return PRESS_STATUS_LABEL[v as PressStatus] ?? String(v);
  if (k === 'channel') return PRESS_CHANNEL_LABEL[v as PressChannel] ?? String(v);
  if (k === 'assigneeId') return names[String(v)] ?? 'unbekannt';
  if (k === 'dueAt') return new Date(String(v)).toISOString();
  return String(v);
};

const actorOf = (req: FastifyRequest) => req.auth!.actor;

export async function pressRoutes(app: FastifyInstance) {
  const view = requireAuth('press.view');
  const manage = requireAuth('press.manage');

  app.get('/press/requests', { preHandler: view }, async (req) => {
    const q = z.object({ filter: z.enum(['open', 'overdue', 'mine', 'answered', 'done', 'all']).default('open'), q: z.string().trim().max(100).default('') }).parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.filter === 'open') where.push(`r.status IN ('new','in_progress')`);
    if (q.filter === 'overdue') where.push(`r.status IN ('new','in_progress') AND r.due_at < now()`);
    if (q.filter === 'answered') where.push(`r.status = 'answered'`);
    if (q.filter === 'done') where.push(`r.status = 'done'`);
    if (q.filter === 'mine') {
      params.push(req.auth!.user?.id ?? null);
      where.push(`r.assignee_id = $${params.length} AND r.status <> 'done'`);
    }
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(r.case_no ILIKE $${params.length} OR r.topic ILIKE $${params.length} OR r.outlet ILIKE $${params.length} OR r.contact_name ILIKE $${params.length})`);
    }
    const rows = await many<any>(
      `${LIST_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (r.status IN ('new','in_progress')) DESC, r.due_at ASC NULLS LAST, r.created_at DESC LIMIT 300`,
      params,
    );
    const counts = await one<any>(
      `SELECT count(*) FILTER (WHERE status IN ('new','in_progress'))::int AS open,
              count(*) FILTER (WHERE status IN ('new','in_progress') AND due_at < now())::int AS overdue,
              count(*) FILTER (WHERE assignee_id = $1 AND status <> 'done')::int AS mine,
              count(*) FILTER (WHERE status = 'answered')::int AS answered
         FROM press_requests`,
      [req.auth!.user?.id ?? null],
    );
    return { requests: rows, counts };
  });

  app.get('/press/options', { preHandler: view }, async () => ({
    users: await assignableUsers(),
    posts: await many<any>(`SELECT id, title, updated_at FROM posts WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 50`),
    events: await many<any>(`SELECT id, COALESCE(NULLIF(title, ''), keyword, 'Einsatz') AS title, keyword, received_at FROM fe2_events ORDER BY received_at DESC LIMIT 50`),
    statuses: PRESS_STATUS.map((value) => ({ value, label: PRESS_STATUS_LABEL[value] })),
    channels: PRESS_CHANNELS.map((value) => ({ value, label: PRESS_CHANNEL_LABEL[value] })),
  }));

  app.get('/press/requests/:id', { preHandler: view }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await loadPressRequest(id);
    const events = await many<any>(`SELECT id, at, actor_name, kind, text, details FROM press_request_events WHERE request_id = $1 ORDER BY at, id`, [id]);
    return { request: r, events, ...(await pressRequestExtras(id, req)) };
  });

  app.post('/press/requests', { preHandler: manage }, async (req) => {
    const v = createInput.parse(req.body);
    await assertRefs(v);
    const s = await getSettings();
    const actor = actorOf(req);
    const r = await tx(async (db) => {
      const caseNo = await nextPressCaseNo(db, s['general.timezone'] || 'Europe/Berlin');
      const row = await one<any>(
        `INSERT INTO press_requests (case_no, status, channel, outlet, contact_name, contact_email, contact_phone, topic, body, assignee_id, due_at, post_id, fe2_event_id, created_by,
                                     answered_at, done_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $2 IN ('answered','done') THEN now() END, CASE WHEN $2 = 'done' THEN now() END) RETURNING id, case_no`,
        [caseNo, v.status, v.channel, v.outlet, v.contactName, v.contactEmail, v.contactPhone, v.topic, v.body, v.assigneeId, v.dueAt, v.postId, v.fe2EventId, req.auth!.user?.id ?? null],
        db,
      );
      await pressEvent(db, row!.id, actor, 'created', `Erfasst (${PRESS_CHANNEL_LABEL[v.channel]})`);
      await audit(actor, 'press.request_created', { type: 'press_request', id: row!.id, label: caseNo }, { eingangsweg: v.channel }, 'ok', db);
      await emitNewPressRequest(row!.id, db);
      return row!;
    });
    await notify({ kind: 'info', title: `Neue Presseanfrage ${r.case_no}`, body: v.topic.slice(0, 200), link: `/presse/${r.id}`, permission: 'press.manage', category: 'press' });
    if (v.assigneeId && v.assigneeId !== req.auth!.user?.id) await notify({ kind: 'info', title: `Presseanfrage ${r.case_no} dir zugewiesen`, body: v.topic.slice(0, 200), link: `/presse/${r.id}`, userId: v.assigneeId, category: 'press' });
    return { id: r.id, case_no: r.case_no };
  });

  app.patch('/press/requests/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = updateInput.parse(req.body);
    await assertRefs(v);
    const cur = await loadPressRequest(id);
    const keys = (Object.keys(v) as (keyof typeof fields)[]).filter((k) => {
      const before = cur[COLUMN[k]];
      const after = v[k];
      if (k === 'dueAt') return (before ? new Date(before).toISOString() : null) !== (after ? new Date(after as string).toISOString() : null);
      return (before ?? null) !== (after ?? null);
    });
    if (!keys.length) return { ok: true, changed: false };
    const names = Object.fromEntries((await assignableUsers()).map((u) => [u.id, u.name]));
    if (cur.assignee_id && cur.assignee_name) names[cur.assignee_id] = cur.assignee_name;
    const actor = actorOf(req);
    await tx(async (db) => {
      const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`);
      if (keys.includes('dueAt')) sets.push('due_reminded_at = NULL', 'overdue_reminded_at = NULL');
      if (keys.includes('status')) {
        sets.push(`answered_at = CASE WHEN status <> 'answered' AND $${keys.indexOf('status') + 2} = 'answered' THEN now() ELSE answered_at END`);
        sets.push(`done_at = CASE WHEN $${keys.indexOf('status') + 2} = 'done' THEN COALESCE(done_at, now()) ELSE NULL END`);
      }
      await db.query(`UPDATE press_requests SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => v[k] ?? null)]);
      for (const k of keys) {
        // Freitext und Kontaktdaten: nur „geändert“ im Verlauf; Status, Zuständigkeit, Frist und Verknüpfungen mit Wert
        const valued = ['status', 'channel', 'assigneeId', 'dueAt'].includes(k);
        const label = FIELD_LABEL[k];
        let line = valued ? `${label}: ${describe(k, cur[COLUMN[k]], names)} → ${describe(k, v[k], names)}` : `${label} geändert`;
        if (k === 'postId') line = v.postId ? 'Mit Beitrag verknüpft' : 'Verknüpfung mit Beitrag entfernt';
        if (k === 'fe2EventId') line = v.fe2EventId ? 'Mit Einsatz verknüpft' : 'Verknüpfung mit Einsatz entfernt';
        await pressEvent(db, id, actor, k === 'status' ? 'status' : k === 'assigneeId' ? 'assignee' : k === 'dueAt' ? 'due' : k === 'postId' || k === 'fe2EventId' ? 'link' : 'edit', line, k === 'dueAt' ? { frist: v.dueAt ?? null } : k === 'status' ? { status: v.status } : {});
      }
      await audit(actor, 'press.request_updated', { type: 'press_request', id, label: cur.case_no }, { felder: keys.map((k) => FIELD_LABEL[k]), ...(v.status && keys.includes('status') ? { status: v.status } : {}) }, 'ok', db);
    });
    if (keys.includes('assigneeId') && v.assigneeId && v.assigneeId !== req.auth!.user?.id) {
      await notify({ kind: 'info', title: `Presseanfrage ${cur.case_no} dir zugewiesen`, body: String(v.topic ?? cur.topic).slice(0, 200), link: `/presse/${id}`, userId: v.assigneeId, category: 'press' });
    }
    return { ok: true, changed: true };
  });

  app.post('/press/requests/:id/notes', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { text: note } = z.object({ text: text(5000).min(1, 'Bitte einen Text eingeben.') }).parse(req.body);
    const cur = await loadPressRequest(id);
    await pressEvent(pool, id, actorOf(req), 'note', note);
    await audit(actorOf(req), 'press.note_added', { type: 'press_request', id, label: cur.case_no });
    return { ok: true };
  });

  app.delete('/press/requests/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const cur = await loadPressRequest(id);
    await tx(async (db) => {
      await db.query(`DELETE FROM press_requests WHERE id = $1`, [id]);
      await audit(actorOf(req), 'press.request_deleted', { type: 'press_request', id, label: cur.case_no }, { status: cur.status }, 'ok', db);
    });
    return { ok: true };
  });
}

/** Ergänzungen der Detailansicht aus den Teilmodulen (Mails, Anhänge, Antworten). */
async function pressRequestExtras(id: string, _req: FastifyRequest): Promise<Record<string, unknown>> {
  const messages = await many<any>(
    `SELECT m.*, u.name AS created_by_name,
            COALESCE((SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size', a.size) ORDER BY a.created_at) FROM press_attachments a WHERE a.message_id = m.id), '[]') AS attachments
       FROM press_messages m LEFT JOIN users u ON u.id = m.created_by WHERE m.request_id = $1 ORDER BY COALESCE(m.received_at, m.created_at), m.created_at`,
    [id],
  );
  return { messages: messages.map(({ external_id, source, ...m }) => m), replyApproval: !!(await getSettings())['press.reply_approval'] };
}
