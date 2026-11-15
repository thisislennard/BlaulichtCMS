import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit, settingsDiff } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { revokeSecret, storeSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { enqueue } from '../jobs/queue.js';
import { evaluate, activeQuestions, type Suggestion } from '../warnings/levels.js';
import { KIND_LABEL, renderWarningPdf } from '../warnings/pdf.js';
import { SMTP_VERIFY_MAX_AGE_MS, smtpConfigProblem, smtpFingerprint, smtpTransport, storedSmtpSettings, type SmtpSettings } from '../warnings/mail.js';
import { sendFileResponse } from './files.js';

/**
 * Warnentwürfe (MoWaS-Übergabe). BlaulichtCMS bereitet vor und übergibt per E-Mail an die zuständige Stelle;
 * die amtliche Auslösung erfolgt dort. Entwurf, Warnstufe, Freigabe und Versand sind getrennte Rechte.
 */
const SMTP_SECRET_OWNER = '00000000-0000-0000-0000-00000000534d';
const pdfDir = (id: string) => path.join(config.dataDir, 'warnings', id);

export function warningHash(r: { template_id: string; kind: string; data: any; responsibility_ids: string[]; keyword: any; answers: any; level_decision: any }) {
  const canonical = JSON.stringify([r.template_id, r.kind, r.data, [...r.responsibility_ids].sort(), r.keyword?.id ?? null, r.answers ?? {}, r.level_decision ? [r.level_decision.level, r.level_decision.reason ?? ''] : null]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function loadCurrent(id: string, db: Queryable = pool) {
  const w = await one<any>(
    `SELECT w.*, p.case_no AS parent_case_no, t.family, t.version AS template_version FROM warnings w LEFT JOIN warnings p ON p.id = w.parent_id JOIN warning_templates t ON t.id = w.template_id WHERE w.id = $1`,
    [id],
    db,
  );
  if (!w) throw notFound('Vorgang nicht gefunden.');
  const rev = await one<any>(`SELECT * FROM warning_revisions WHERE warning_id = $1 AND number = $2`, [id, w.current_revision], db);
  const approval = await one<any>(
    `SELECT a.*, u.name AS decided_by_name FROM warning_approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE a.revision_id = $1 ORDER BY a.decided_at DESC LIMIT 1`,
    [rev.id],
    db,
  );
  const lastSend = await one<any>(`SELECT * FROM warning_sends WHERE warning_id = $1 ORDER BY created_at DESC LIMIT 1`, [id], db);
  const { valid, state } = warningState(rev, approval, lastSend);
  return { w, rev, approval, valid, lastSend, state };
}

type StateRev = { id: string; content_hash: string; submitted_at: string | Date | null };
type StateApproval = { decision: string; content_hash: string; decided_at: string | Date } | null;
type StateSend = { revision_id: string; status: string; resolution: string | null; acknowledged_at: string | Date | null } | null;

/**
 * Zustand eines Vorgangs aus aktueller Fassung, letzter Entscheidung zu ihr und letztem Versand – gemeinsam für die
 * Einzelansicht und die Liste (dort in einer Abfrage geladen, #184).
 */
export function warningState<A extends StateApproval>(rev: StateRev, approval: A, lastSend: StateSend): { valid: A | null; state: string } {
  const valid = approval?.decision === 'approved' && approval.content_hash === rev.content_hash ? approval : null;
  let state = 'draft';
  if (rev.submitted_at) state = 'in_review';
  if (approval?.decision === 'rejected' && (!rev.submitted_at || new Date(approval.decided_at) >= new Date(rev.submitted_at))) state = 'rejected';
  if (valid) state = 'approved';
  if (valid && lastSend && lastSend.revision_id === rev.id) state = lastSend.status === 'accepted' ? (lastSend.acknowledged_at ? 'acknowledged' : 'sent') : lastSend.status === 'failed' ? (lastSend.resolution ? 'approved' : 'send_failed') : lastSend.status === 'unknown' && !lastSend.resolution ? 'send_unknown' : lastSend.resolution === 'delivered' ? (lastSend.acknowledged_at ? 'acknowledged' : 'sent') : lastSend.status === 'unknown' ? 'approved' : 'sending';
  return { valid, state };
}

/** Bestätigte Warnstufe des Vorgängers (für Aktualisierungen anzeigen). */
async function previousLevel(parentId: string | null) {
  if (!parentId) return null;
  const r = await one<any>(
    `SELECT r.level_decision, w.case_no FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision WHERE w.id = $1`,
    [parentId],
  );
  return r?.level_decision ? { ...r.level_decision, case_no: r.case_no } : null;
}

function missingRequired(template: any, data: Record<string, any>) {
  const out = (template.fields as any[]).filter((f) => f.required && (data[f.key] == null || String(data[f.key]).trim() === '')).map((f) => f.label);
  // Zeitraum muss stimmen – sonst steht ein unmöglicher Gültigkeitszeitraum in der freigegebenen PDF
  if (data.starts_at && data.valid_until && new Date(data.valid_until) <= new Date(data.starts_at)) out.push('„Gültig bis“ muss nach dem Beginn liegen');
  return out;
}

async function renderFor(id: string, revNumber: number | null, draft: boolean, approval?: any) {
  const { w } = await loadCurrent(id);
  const rev = await one<any>(`SELECT * FROM warning_revisions WHERE warning_id = $1 AND number = $2`, [id, revNumber ?? w.current_revision]);
  if (!rev) throw notFound('Fassung nicht gefunden.');
  const t = await one<any>('SELECT * FROM warning_templates WHERE id = $1', [w.template_id]);
  const s = await getSettings();
  return renderWarningPdf({
    organization: s['general.organization'] || s['general.instance_name'],
    template: t,
    warning: { case_no: w.case_no, kind: w.kind, parent_case_no: w.parent_case_no },
    revision: rev,
    approval: approval ?? null,
    draft,
    timeZone: s['general.timezone'],
  });
}

function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

async function recipientsFor(revision: any) {
  const rows = revision.responsibility_ids?.length ? await many<any>(`SELECT * FROM responsibilities WHERE id = ANY($1) AND active`, [revision.responsibility_ids]) : [];
  return { responsibilities: rows.map((r) => ({ id: r.id, name: r.name, area: r.area, recipients: r.recipients })), intended: [...new Set(rows.flatMap((r) => r.recipients as string[]))] };
}

/**
 * Empfängeränderung fürs Audit ohne die Adressen selbst (#185): Anzahl, Domains und wie viele hinzukamen bzw. wegfielen.
 * Die Adressen stehen in der Zuständigkeit bzw. im Versand mit eigener Löschfrist – das Audit bleibt deutlich länger.
 */
export function recipientAudit(before: string[], after: string[]) {
  const norm = (l: string[]) => new Set(l.map((a) => a.trim().toLowerCase()));
  const a = norm(before);
  const b = norm(after);
  return {
    empfaenger_anzahl: b.size,
    empfaenger_domains: [...new Set([...b].map((x) => x.split('@')[1] ?? ''))].filter(Boolean).sort(),
    ...(before.length ? { hinzugefuegt: [...b].filter((x) => !a.has(x)).length, entfernt: [...a].filter((x) => !b.has(x)).length } : {}),
  };
}

const revisionBody = z.object({
  baseRevision: z.number().int().min(1),
  data: z.record(z.string(), z.any()).default({}),
  responsibilityIds: z.array(z.uuid()).max(20).default([]),
  keywordId: z.uuid().nullable().default(null),
  answers: z.record(z.string(), z.string().max(100)).default({}),
});

export async function warningRoutes(app: FastifyInstance) {
  const anyWarn = requireAnyAuth('warning.draft', 'warning.level', 'warning.approve', 'warning.send', 'warning.rules');

  /* ------------------------------------------------------------ Vorgänge */

  app.get('/warnings', { preHandler: anyWarn }, async () => {
    // Eine Abfrage statt vier je Vorgang (#184): letzte Entscheidung zur aktuellen Fassung und letzter Versand per LATERAL
    const rows = await many<any>(
      `SELECT w.id, w.case_no, w.kind, w.parent_id, w.current_revision, w.created_at, w.updated_at, p.case_no AS parent_case_no, r.data->>'headline' AS headline, r.level_decision, r.keyword,
              r.id AS rev_id, r.content_hash AS rev_hash, r.submitted_at AS rev_submitted_at,
              a.decision AS a_decision, a.content_hash AS a_hash, a.decided_at AS a_decided_at,
              s.revision_id AS s_revision_id, s.status AS s_status, s.resolution AS s_resolution, s.acknowledged_at AS s_acknowledged_at
         FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision LEFT JOIN warnings p ON p.id = w.parent_id
         LEFT JOIN LATERAL (SELECT decision, content_hash, decided_at FROM warning_approvals WHERE revision_id = r.id ORDER BY decided_at DESC LIMIT 1) a ON true
         LEFT JOIN LATERAL (SELECT revision_id, status, resolution, acknowledged_at FROM warning_sends WHERE warning_id = w.id ORDER BY created_at DESC LIMIT 1) s ON true
        WHERE w.archived_at IS NULL ORDER BY w.updated_at DESC LIMIT 200`,
    );
    return rows.map(({ rev_id, rev_hash, rev_submitted_at, a_decision, a_hash, a_decided_at, s_revision_id, s_status, s_resolution, s_acknowledged_at, ...r }) => ({
      ...r,
      state: warningState(
        { id: rev_id, content_hash: rev_hash, submitted_at: rev_submitted_at },
        a_decision ? { decision: a_decision, content_hash: a_hash, decided_at: a_decided_at } : null,
        s_status ? { revision_id: s_revision_id, status: s_status, resolution: s_resolution, acknowledged_at: s_acknowledged_at } : null,
      ).state,
    }));
  });

  app.post('/warnings', { preHandler: requireAuth('warning.draft') }, async (req) => {
    const b = z.object({ kind: z.enum(['initial', 'update', 'all_clear']), parentId: z.uuid().nullable().default(null), fe2EventId: z.uuid().nullable().default(null) }).parse(req.body);
    if (b.kind !== 'initial' && !b.parentId) throw badRequest('Aktualisierung und Entwarnung brauchen einen Bezugsvorgang.');
    const userId = req.auth!.user?.id ?? null;
    const w = await tx(async (db) => {
      let parent: any = null;
      let base: any = { data: {}, responsibility_ids: [], keyword: null, answers: {} };
      let templateId: string;
      if (b.parentId) {
        parent = await one<any>(`SELECT * FROM warnings WHERE id = $1`, [b.parentId], db);
        if (!parent) throw notFound('Bezugsvorgang nicht gefunden.');
        const prev = await one<any>(`SELECT * FROM warning_revisions WHERE warning_id = $1 AND number = $2`, [parent.id, parent.current_revision], db);
        const fam = await one<any>(`SELECT family FROM warning_templates WHERE id = $1`, [parent.template_id], db);
        templateId = (await one<any>(`SELECT id FROM warning_templates WHERE family = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`, [fam.family], db))?.id ?? parent.template_id;
        // Inhalte übernehmen; die Warnstufe muss neu bestätigt werden (Entwarnung hat keine Stufe)
        base = { data: prev.data, responsibility_ids: prev.responsibility_ids, keyword: b.kind === 'all_clear' ? null : prev.keyword, answers: b.kind === 'all_clear' ? {} : prev.answers };
      } else {
        const t = await one<any>(`SELECT id FROM warning_templates WHERE status = 'active' ORDER BY created_at DESC, version DESC LIMIT 1`, [], db);
        if (!t) throw badRequest('Es ist keine aktive Vorlage vorhanden.');
        templateId = t.id;
      }
      let fe2: any = null;
      if (b.fe2EventId) {
        fe2 = await one<any>('SELECT * FROM fe2_events WHERE id = $1', [b.fe2EventId], db);
        if (!fe2) throw notFound('FE2-Einsatz nicht gefunden.');
        if (fe2.keyword && !base.keyword) {
          const kw = await one<any>(`SELECT id, code, label FROM fire_keywords WHERE active AND (lower(code) = lower($1) OR lower($1) = ANY(SELECT lower(a) FROM unnest(aliases) a))`, [fe2.keyword], db);
          if (kw) base.keyword = kw;
        }
      }
      // Jahr in der Zeitzone der Instanz (#83) – sonst trägt ein Vorgang am 1. Januar kurz nach Mitternacht das Vorjahr
      const year = new Intl.DateTimeFormat('en', { timeZone: (await getSettings())['general.timezone'], year: 'numeric' }).format(new Date());
      const seq = (await one<any>(`SELECT nextval('warning_case_seq') AS n`, [], db)).n;
      const caseNo = `W-${year}-${String(seq).padStart(4, '0')}`;
      const created = await one<any>(
        `INSERT INTO warnings (case_no, kind, parent_id, root_id, template_id, fe2_event_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [caseNo, b.kind, parent?.id ?? null, parent ? (parent.root_id ?? parent.id) : null, templateId, fe2?.id ?? null, userId],
        db,
      );
      if (b.kind === 'all_clear') base.data = { ...base.data, headline: `Entwarnung: ${base.data?.headline ?? ''}`.trim() };
      const rev = { template_id: templateId, kind: b.kind, data: base.data, responsibility_ids: base.responsibility_ids, keyword: base.keyword, answers: base.answers, level_decision: null };
      await db.query(
        `INSERT INTO warning_revisions (warning_id, number, data, responsibility_ids, keyword, answers, content_hash, created_by) VALUES ($1,1,$2,$3,$4,$5,$6,$7)`,
        [created.id, JSON.stringify(rev.data), rev.responsibility_ids, rev.keyword ? JSON.stringify(rev.keyword) : null, JSON.stringify(rev.answers), warningHash(rev), userId],
      );
      await audit(req.auth!.actor, 'warning.created', { type: 'warning', id: created.id, label: caseNo }, { art: b.kind, bezug: parent?.case_no ?? null }, 'ok', db);
      return created;
    });
    return { id: w.id, case_no: w.case_no };
  });

  app.get('/warnings/:id', { preHandler: anyWarn }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { w, rev, approval, valid, lastSend, state } = await loadCurrent(id);
    const template = await one<any>('SELECT * FROM warning_templates WHERE id = $1', [w.template_id]);
    const latestTemplate = await one<any>(`SELECT id, version FROM warning_templates WHERE family = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`, [template.family]);
    const revisions = await many<any>(`SELECT r.number, r.created_at, r.submitted_at, (r.level_decision->>'level')::int AS level, u.name AS created_by_name FROM warning_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.warning_id = $1 ORDER BY r.number DESC`, [id]);
    const approvals = await many<any>(
      `SELECT a.id, a.decision, a.note, a.decided_at, a.pdf_sha256, r.number AS revision_number, u.name AS decided_by_name FROM warning_approvals a JOIN warning_revisions r ON r.id = a.revision_id LEFT JOIN users u ON u.id = a.decided_by WHERE a.warning_id = $1 ORDER BY a.decided_at DESC`,
      [id],
    );
    const sends = await many<any>(
      `SELECT s.id, s.status, s.recipients, s.intended_recipients, s.test_mode, s.subject, s.needs_review, s.resolution, s.resolved_at, s.message_id, s.smtp_response, s.error, s.created_at, s.sent_at, s.acknowledged_at, s.ack_note, r.number AS revision_number, u.name AS created_by_name, ua.name AS acknowledged_by_name
         FROM warning_sends s JOIN warning_revisions r ON r.id = s.revision_id LEFT JOIN users u ON u.id = s.created_by LEFT JOIN users ua ON ua.id = s.acknowledged_by WHERE s.warning_id = $1 ORDER BY s.created_at DESC`,
      [id],
    );
    const followUps = await many<any>(`SELECT id, case_no, kind, created_at FROM warnings WHERE parent_id = $1 ORDER BY created_at`, [id]);
    const questions = rev.keyword?.id ? await activeQuestions(rev.keyword.id) : [];
    const s = await getSettings();
    return {
      warning: { id: w.id, case_no: w.case_no, kind: w.kind, parent_id: w.parent_id, parent_case_no: w.parent_case_no, created_at: w.created_at, current_revision: w.current_revision, fe2_event_id: w.fe2_event_id },
      state,
      template: { id: template.id, name: template.name, version: template.version, fields: template.fields, level_labels: template.level_labels, note: template.note, newer_version: latestTemplate && latestTemplate.id !== template.id ? latestTemplate.version : null },
      revision: { number: rev.number, data: rev.data, responsibility_ids: rev.responsibility_ids, keyword: rev.keyword, answers: rev.answers, suggestion: rev.suggestion, level_decision: rev.level_decision, content_hash: rev.content_hash, submitted_at: rev.submitted_at, created_at: rev.created_at },
      questions,
      previousLevel: await previousLevel(w.parent_id),
      approval: valid ? { id: valid.id, decided_by_name: valid.decided_by_name, decided_at: valid.decided_at, pdf_sha256: valid.pdf_sha256, note: valid.note } : null,
      lastDecision: approval ? { decision: approval.decision, note: approval.note, decided_by_name: approval.decided_by_name, decided_at: approval.decided_at } : null,
      revisions,
      approvals,
      sends,
      lastSend: lastSend ? { id: lastSend.id, status: lastSend.status } : null,
      followUps,
      recipients: await recipientsFor(rev),
      testMode: { active: s['warnings.test_mode'], recipient: s['warnings.test_recipient'] },
      missing: missingRequired(template, rev.data),
    };
  });

  /** Lagebewertung ohne Speichern (Vorschau im Wizard). */
  app.post('/warnings/suggest', { preHandler: anyWarn }, async (req) => {
    const b = z.object({ keywordId: z.uuid().nullable(), answers: z.record(z.string(), z.string().max(100)).default({}) }).parse(req.body);
    return evaluate(b.keywordId, b.answers);
  });

  /** Speichern: neue Fassung nur bei Änderung. Die Warnstufen-Bestätigung bleibt nur, solange Stichwort und Antworten gleich sind. */
  app.put('/warnings/:id/revision', { preHandler: requireAuth('warning.draft') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = revisionBody.parse(req.body);
    const userId = req.auth!.user?.id ?? null;
    return tx(async (db) => {
      const w = await one<any>(`SELECT * FROM warnings WHERE id = $1 FOR UPDATE`, [id], db);
      if (!w) throw notFound();
      if (w.current_revision !== b.baseRevision) throw conflict(`Der Vorgang wurde inzwischen geändert (Fassung ${w.current_revision}). Bitte neu laden.`);
      const cur = await one<any>(`SELECT * FROM warning_revisions WHERE warning_id = $1 AND number = $2`, [id, w.current_revision], db);
      let keyword = null;
      if (w.kind !== 'all_clear' && b.keywordId) {
        keyword = await one<any>(`SELECT id, code, label FROM fire_keywords WHERE id = $1`, [b.keywordId], db);
        if (!keyword) throw badRequest('Stichwort nicht gefunden.');
      }
      const answers = w.kind === 'all_clear' ? {} : b.answers;
      const sameLage = (cur.keyword?.id ?? null) === (keyword?.id ?? null) && JSON.stringify(cur.answers ?? {}) === JSON.stringify(answers);
      const levelDecision = sameLage ? cur.level_decision : null;
      const suggestion: Suggestion | null = w.kind === 'all_clear' ? null : sameLage && cur.suggestion ? cur.suggestion : await evaluate(keyword?.id ?? null, answers, db);
      const next = { template_id: w.template_id, kind: w.kind, data: b.data, responsibility_ids: b.responsibilityIds, keyword, answers, level_decision: levelDecision };
      const hash = warningHash(next);
      if (hash === cur.content_hash) return { changed: false, number: cur.number };
      const number = cur.number + 1;
      await db.query(
        `INSERT INTO warning_revisions (warning_id, number, data, responsibility_ids, keyword, answers, suggestion, level_decision, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, number, JSON.stringify(b.data), b.responsibilityIds, keyword ? JSON.stringify(keyword) : null, JSON.stringify(answers), suggestion ? JSON.stringify(suggestion) : null, levelDecision ? JSON.stringify(levelDecision) : null, hash, userId],
      );
      await db.query(`UPDATE warnings SET current_revision = $2, updated_at = now() WHERE id = $1`, [id, number]);
      await audit(req.auth!.actor, 'warning.revised', { type: 'warning', id, label: w.case_no }, { fassung: number, stufe_neu_bestaetigen: !!cur.level_decision && !levelDecision }, 'ok', db);
      return { changed: true, number, levelReset: !!cur.level_decision && !levelDecision, suggestion };
    });
  });

  /**
   * Warnstufe ausdrücklich bestätigen oder mit Begründung ändern (eigenes Recht). Erzeugt eine neue Fassung.
   * Ohne Vorschlag ist jede gewählte Stufe eine Abweichung und braucht eine Begründung.
   */
  app.post('/warnings/:id/level', { preHandler: requireAuth('warning.level') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ revision: z.number().int().min(1), level: z.number().int().min(1).max(3), reason: z.string().trim().max(500).default('') }).parse(req.body);
    const user = req.auth!.user;
    return tx(async (db) => {
      const w = await one<any>(`SELECT * FROM warnings WHERE id = $1 FOR UPDATE`, [id], db);
      if (!w) throw notFound();
      if (w.kind === 'all_clear') throw badRequest('Eine Entwarnung hat keine Warnstufe.');
      if (w.current_revision !== b.revision) throw conflict('Die Fassung hat sich geändert. Bitte die aktuelle Lage bewerten.');
      const cur = await one<any>(`SELECT * FROM warning_revisions WHERE warning_id = $1 AND number = $2`, [id, w.current_revision], db);
      const suggestion: Suggestion = cur.suggestion ?? (await evaluate(cur.keyword?.id ?? null, cur.answers ?? {}, db));
      const changed = suggestion.level !== b.level;
      if (changed && b.reason.length < 5) throw badRequest(suggestion.level ? 'Bitte begründen, warum vom Vorschlag abgewichen wird.' : 'Ohne eindeutigen Vorschlag braucht die gewählte Stufe eine fachliche Begründung.');
      const decision = { level: b.level, suggested: suggestion.level, suggestionStatus: suggestion.status, rules: suggestion.rules.map((r) => ({ id: r.id, version: r.version, name: r.name })), changed, reason: b.reason, by: user?.id ?? null, byName: user?.name ?? '', at: new Date().toISOString() };
      const next = { template_id: w.template_id, kind: w.kind, data: cur.data, responsibility_ids: cur.responsibility_ids, keyword: cur.keyword, answers: cur.answers, level_decision: decision };
      const number = cur.number + 1;
      await db.query(
        `INSERT INTO warning_revisions (warning_id, number, data, responsibility_ids, keyword, answers, suggestion, level_decision, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, number, JSON.stringify(cur.data), cur.responsibility_ids, cur.keyword ? JSON.stringify(cur.keyword) : null, JSON.stringify(cur.answers), JSON.stringify(suggestion), JSON.stringify(decision), warningHash(next), user?.id ?? null],
      );
      await db.query(`UPDATE warnings SET current_revision = $2, updated_at = now() WHERE id = $1`, [id, number]);
      await audit(req.auth!.actor, changed ? 'warning.level_changed' : 'warning.level_confirmed', { type: 'warning', id, label: w.case_no }, { stufe: b.level, vorschlag: suggestion.level, regeln: decision.rules.map((r) => `${r.name} v${r.version}`), begruendung: b.reason || null }, 'ok', db);
      return { ok: true, number, level: b.level, changed };
    });
  });

  app.post('/warnings/:id/submit', { preHandler: requireAuth('warning.draft') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { revision } = z.object({ revision: z.number().int() }).parse(req.body);
    const { w, rev, valid } = await loadCurrent(id);
    if (rev.number !== revision) throw conflict('Es gibt eine neuere Fassung.');
    if (valid) throw badRequest('Diese Fassung ist bereits freigegeben.');
    const t = await one<any>('SELECT * FROM warning_templates WHERE id = $1', [w.template_id]);
    const missing = missingRequired(t, rev.data);
    if (missing.length) throw badRequest(`Noch nicht vollständig: ${missing.join(', ')}.`);
    if (w.kind !== 'all_clear' && !rev.level_decision) throw badRequest('Die Warnstufe ist noch nicht ausdrücklich bestätigt.');
    if (!rev.responsibility_ids?.length) throw badRequest('Bitte mindestens eine Zuständigkeit (Empfänger) wählen.');
    await pool.query('UPDATE warning_revisions SET submitted_at = now(), submitted_by = $2 WHERE id = $1', [rev.id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'warning.submitted', { type: 'warning', id, label: w.case_no }, { fassung: revision });
    await notify({ kind: 'warning', title: `Warnentwurf zur Freigabe: ${w.case_no}`, body: rev.data?.headline ?? '', link: `/warnungen/${id}`, permission: 'warning.approve' });
    return { ok: true };
  });

  /** PDF-Vorschau (immer mit ENTWURF-Kennzeichnung) für eine beliebige Fassung. */
  app.get('/warnings/:id/pdf', { preHandler: anyWarn }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { revision } = z.object({ revision: z.coerce.number().int().optional() }).parse(req.query);
    const pdf = await renderFor(id, revision ?? null, true);
    reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="entwurf.pdf"').header('cache-control', 'no-store');
    return reply.send(pdf);
  });

  /** Freigabe: fixiert die erzeugte PDF-Fassung (Datei + Prüfsumme) an Vorgang, Fassung und Zeitstand. */
  app.post('/warnings/:id/decision', { preHandler: requireAuth('warning.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ revision: z.number().int(), contentHash: z.string().length(64), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default('') }).parse(req.body);
    const user = req.auth!.user;
    const s = await getSettings();
    // In einer Transaktion mit Zeilensperre auf dem Vorgang (#179): Zwei gleichzeitige Freigaben laufen nacheinander, die
    // zweite sieht die erste („Bereits freigegeben“). Die PDF-Datei wird erst nach erfolgreichem INSERT geschrieben und
    // bei einem Fehler wieder entfernt – keine verwaisten Dateien.
    let pdfFile: string | null = null;
    try {
      return await tx(async (db) => {
        await db.query('SELECT 1 FROM warnings WHERE id = $1 FOR UPDATE', [id]);
        const { w, rev, valid } = await loadCurrent(id, db);
        if (rev.number !== b.revision || rev.content_hash !== b.contentHash) throw conflict('Die Fassung hat sich geändert. Bitte die aktuelle Fassung prüfen.');
        if (valid) throw badRequest('Bereits freigegeben.');
        if (!rev.submitted_at) throw badRequest('Die Fassung ist nicht zur Freigabe eingereicht.');
        if (b.decision === 'rejected' && !b.note) throw badRequest('Bitte die Zurückweisung begründen.');
        if (b.decision === 'approved' && w.kind !== 'all_clear' && !rev.level_decision) throw badRequest('Die Warnstufe ist nicht bestätigt.');
        // Vier-Augen-Prinzip (#153, Einstellung editorial.four_eyes – gilt für Beiträge, Banner und Warnentwürfe): Wer Inhalte
        // dieses Entwurfs geschrieben oder die Fassung eingereicht hat, darf sie nicht freigeben. Die Bestätigung der Warnstufe
        // zählt nicht als Schreiben – sie gehört zur fachlichen Prüfung der freigebenden Person.
        if (b.decision === 'approved' && user?.id && s['editorial.four_eyes']) {
          const own = await one<any>(
            `SELECT 1 FROM warning_revisions r LEFT JOIN warning_revisions p ON p.warning_id = r.warning_id AND p.number = r.number - 1
              WHERE r.warning_id = $1 AND r.number <= $2 AND r.created_by = $3
                AND (p.id IS NULL OR r.data IS DISTINCT FROM p.data OR r.responsibility_ids IS DISTINCT FROM p.responsibility_ids OR r.keyword IS DISTINCT FROM p.keyword OR r.answers IS DISTINCT FROM p.answers)
              LIMIT 1`,
            [id, rev.number, user.id],
            db,
          );
          if (own || rev.submitted_by === user.id) throw forbidden('Vier-Augen-Prinzip: Wer am Entwurf geschrieben oder ihn eingereicht hat, kann ihn nicht selbst freigeben.');
        }
        let pdf: Buffer | null = null;
        let sha: string | null = null;
        let file: string | null = null;
        const decidedAt = new Date();
        if (b.decision === 'approved') {
          pdf = await renderFor(id, rev.number, false, { decided_by_name: user?.name ?? '', decided_at: decidedAt });
          sha = crypto.createHash('sha256').update(pdf).digest('hex');
          file = path.join(pdfDir(id), `${w.case_no}-F${rev.number}-${sha.slice(0, 12)}.pdf`);
        }
        const a = await one<any>(
          `INSERT INTO warning_approvals (warning_id, revision_id, content_hash, decision, note, pdf_sha256, pdf_file, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [id, rev.id, rev.content_hash, b.decision, b.note, sha, file, user?.id ?? null, decidedAt],
          db,
        );
        if (b.decision === 'rejected') await db.query('UPDATE warning_revisions SET submitted_at = NULL WHERE id = $1', [rev.id]);
        await audit(req.auth!.actor, b.decision === 'approved' ? 'warning.approved' : 'warning.rejected', { type: 'warning', id, label: w.case_no }, { fassung: rev.number, pdf_sha256: sha?.slice(0, 16) ?? null }, 'ok', db);
        if (pdf && file) {
          fs.mkdirSync(pdfDir(id), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, pdf, { mode: 0o600 });
          pdfFile = file;
        }
        return { ok: true, approvalId: a.id, pdfSha256: sha };
      });
    } catch (e) {
      if (pdfFile) fs.rmSync(pdfFile, { force: true });
      throw e;
    }
  });

  app.get('/warnings/:id/approvals/:aid/pdf', { preHandler: anyWarn }, async (req, reply) => {
    const { id, aid } = z.object({ id: z.uuid(), aid: z.uuid() }).parse(req.params);
    const a = await one<any>(`SELECT a.*, w.case_no FROM warning_approvals a JOIN warnings w ON w.id = a.warning_id WHERE a.id = $1 AND a.warning_id = $2 AND a.decision = 'approved'`, [aid, id]);
    if (!a?.pdf_file) throw notFound();
    return sendFileResponse(reply, a.pdf_file, 'application/pdf', `${a.case_no}.pdf`);
  });

  /**
   * Versand der freigegebenen PDF. Empfänger aus den Zuständigkeiten, im Testmodus nur an den Testempfänger.
   * Kein zweiter Versand, solange ein Versand läuft, angenommen wurde oder sein Ergebnis unbekannt und ungeprüft ist.
   */
  app.post('/warnings/:id/send', { preHandler: requireAuth('warning.send') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ approvalId: z.uuid(), confirmRecipients: z.array(z.string()).min(1) }).parse(req.body);
    const s = await getSettings();
    return tx(async (db) => {
      await db.query('SELECT 1 FROM warnings WHERE id = $1 FOR UPDATE', [id]);
      const { w, rev, valid } = await loadCurrent(id, db);
      if (!valid || valid.id !== b.approvalId) throw conflict('Nur die freigegebene aktuelle Fassung kann versendet werden.');
      const open = await one<any>(
        `SELECT * FROM warning_sends WHERE approval_id = $1 AND (status IN ('queued','sending','accepted') OR (status = 'unknown' AND resolution IS NULL) OR resolution = 'delivered') ORDER BY created_at DESC LIMIT 1`,
        [valid.id],
        db,
      );
      if (open) {
        if (open.status === 'unknown') throw new AppError(409, 'send_unknown', 'Das Ergebnis des letzten Versands ist unbekannt. Bitte zuerst prüfen, ob die E-Mail angekommen ist.');
        throw new AppError(409, 'already_sent', 'Diese Fassung wurde bereits versendet bzw. der Versand läuft.');
      }
      const { intended } = await recipientsFor(rev);
      if (!intended.length) throw badRequest('Für die gewählten Zuständigkeiten sind keine Empfänger hinterlegt.');
      const testMode = !!s['warnings.test_mode'];
      if (testMode && !s['warnings.test_recipient']) throw badRequest('Der Testmodus ist aktiv, aber kein Testempfänger hinterlegt.');
      const actual = testMode ? [s['warnings.test_recipient']] : intended;
      // Die angezeigten Empfänger müssen exakt bestätigt worden sein
      if (JSON.stringify([...b.confirmRecipients].sort()) !== JSON.stringify([...actual].sort())) throw conflict('Die Empfänger haben sich geändert. Bitte erneut prüfen.');
      const t = await one<any>('SELECT * FROM warning_templates WHERE id = $1', [w.template_id], db);
      const vars = {
        art: KIND_LABEL[w.kind as 'initial'],
        vorgang: w.case_no,
        fassung: String(rev.number),
        ueberschrift: rev.data?.headline ?? '',
        stufe: rev.level_decision ? (t.level_labels[String(rev.level_decision.level)] ?? String(rev.level_decision.level)) : 'keine (Entwarnung)',
        rueckruf: rev.data?.callback ?? '',
        absender: rev.data?.sender ?? s['general.sender_name'] ?? '',
      };
      const subject = `${testMode ? '[TEST] ' : ''}${fill(t.mail_subject, vars)}`.slice(0, 250);
      const body = `${testMode ? `TESTMODUS – vorgesehene Empfänger wären: ${intended.join(', ')}\n\n` : ''}${fill(t.mail_body, vars)}`;
      const send = await one<any>(
        `INSERT INTO warning_sends (warning_id, revision_id, approval_id, recipients, intended_recipients, test_mode, subject, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [id, rev.id, valid.id, actual, intended, testMode, subject, req.auth!.user?.id ?? null],
        db,
      );
      await db.query(`INSERT INTO warning_sends_body (send_id, body) VALUES ($1,$2)`, [send.id, body]);
      await enqueue('warning.send', { sendId: send.id }, { dedupKey: `warning.send:${send.id}`, maxAttempts: 1 }, db);
      // Keine Adressen im Audit (#185): Die stehen mit eigener Löschfrist (privacy.warning_days) im Versand selbst
      const zust = rev.responsibility_ids?.length ? await many<any>(`SELECT name FROM responsibilities WHERE id = ANY($1) ORDER BY name`, [rev.responsibility_ids], db) : [];
      await audit(req.auth!.actor, 'warning.send_requested', { type: 'warning', id, label: w.case_no }, { versand: send.id, empfaenger_anzahl: actual.length, zustaendigkeiten: zust.map((z) => z.name), testmodus: testMode }, 'ok', db);
      return { id: send.id, recipients: actual, testMode };
    });
  });

  /** Unbekanntes Ergebnis prüfen: angekommen oder nicht angekommen (erst dann ist ein erneuter Versand möglich). */
  app.post('/warning-sends/:id/resolve', { preHandler: requireAuth('warning.send') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ outcome: z.enum(['delivered', 'not_delivered']), note: z.string().trim().min(3).max(300) }).parse(req.body);
    const s = await one<any>(`UPDATE warning_sends SET resolution = $2, resolved_by = $3, resolved_at = now(), needs_review = false, ack_note = COALESCE(ack_note, $4) WHERE id = $1 AND status IN ('unknown','failed') AND resolution IS NULL RETURNING warning_id`, [id, b.outcome, req.auth!.user?.id ?? null, b.note]);
    if (!s) throw badRequest('Nur ungeklärte Versandvorgänge können geprüft werden.');
    await audit(req.auth!.actor, 'warning.send_resolved', { type: 'warning', id: s.warning_id }, { ergebnis: b.outcome, notiz: b.note });
    return { ok: true };
  });

  /** Fachliche Eingangsbestätigung (z. B. telefonische Rückmeldung der zuständigen Stelle) – getrennt von der SMTP-Annahme. */
  app.post('/warning-sends/:id/acknowledge', { preHandler: requireAnyAuth('warning.send', 'warning.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    const s = await one<any>(`UPDATE warning_sends SET acknowledged_at = now(), acknowledged_by = $2, ack_note = $3 WHERE id = $1 AND (status = 'accepted' OR resolution = 'delivered') AND acknowledged_at IS NULL RETURNING warning_id`, [id, req.auth!.user?.id ?? null, note]);
    if (!s) throw badRequest('Eingang kann nur für angenommene Sendungen bestätigt werden.');
    await audit(req.auth!.actor, 'warning.acknowledged', { type: 'warning', id: s.warning_id }, { notiz: note });
    return { ok: true };
  });

  /* ------------------------------------------------------------ Stichwörter (Suche im Wizard) */

  app.get('/warning-keywords', { preHandler: anyWarn }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(60).default('') }).parse(req.query);
    const like = `%${q.toLowerCase()}%`;
    return many<any>(
      `SELECT k.id, k.code, k.label, k.aliases,
              (SELECT count(*)::int FROM warning_rules r WHERE r.keyword_id = k.id AND r.status = 'approved') AS rule_count
         FROM fire_keywords k WHERE k.active AND ($1 = '%%' OR lower(k.code) LIKE $1 OR lower(k.label) LIKE $1 OR EXISTS (SELECT 1 FROM unnest(k.aliases) a WHERE lower(a) LIKE $1))
        ORDER BY k.code LIMIT 30`,
      [like],
    );
  });
  app.get('/warning-keywords/:id/questions', { preHandler: anyWarn }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return activeQuestions(id);
  });
  app.get('/fe2-events', { preHandler: anyWarn }, async () => many<any>(`SELECT id, event_key, keyword, title, received_at FROM fe2_events ORDER BY received_at DESC LIMIT 20`));

  /* ------------------------------------------------------------ Pflege (warning.rules) */

  app.get('/responsibilities', { preHandler: anyWarn }, async () => many<any>(`SELECT id, name, area, recipients FROM responsibilities WHERE active ORDER BY name`));

  app.get('/warning-config', { preHandler: requireAnyAuth('warning.rules', 'warning.approve', 'system.manage') }, async () => {
    const s = await getSettings();
    return {
      templates: await many<any>(`SELECT t.*, u.name AS created_by_name FROM warning_templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY family, version DESC`),
      responsibilities: await many<any>(`SELECT * FROM responsibilities ORDER BY active DESC, name`),
      keywords: await many<any>(`SELECT * FROM fire_keywords ORDER BY code`),
      questions: await many<any>(`SELECT q.*, u.name AS approved_by_name FROM keyword_questions q LEFT JOIN users u ON u.id = q.approved_by ORDER BY q.keyword_id, q.sort`),
      rules: await many<any>(`SELECT r.*, u.name AS approved_by_name, c.name AS created_by_name FROM warning_rules r LEFT JOIN users u ON u.id = r.approved_by LEFT JOIN users c ON c.id = r.created_by ORDER BY r.keyword_id, r.name, r.version DESC`),
      smtp: { host: s['smtp.host'], port: s['smtp.port'], security: s['smtp.security'], user: s['smtp.user'], from: s['smtp.from'], password_set: !!s['smtp.password_secret_id'], verified_at: s['smtp.verified']?.at ?? null },
      testMode: { active: s['warnings.test_mode'], recipient: s['warnings.test_recipient'] },
    };
  });

  const rules = requireAuth('warning.rules');
  app.post('/warning-keywords', { preHandler: rules }, async (req) => {
    const b = z.object({ code: z.string().trim().min(1).max(40), label: z.string().trim().min(2).max(120), aliases: z.array(z.string().trim().min(1).max(40)).max(20).default([]) }).parse(req.body);
    const k = await one<any>(`INSERT INTO fire_keywords (code, label, aliases, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING *`, [b.code, b.label, b.aliases, req.auth!.user?.id ?? null]);
    if (!k) throw conflict('Dieses Stichwort ist bereits hinterlegt.');
    await audit(req.auth!.actor, 'warning.keyword_created', { type: 'keyword', id: k.id, label: k.code });
    return k;
  });
  app.put('/warning-keywords/:id', { preHandler: rules }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ label: z.string().trim().min(2).max(120), aliases: z.array(z.string().trim().min(1).max(40)).max(20), active: z.boolean() }).parse(req.body);
    const k = await one<any>(`UPDATE fire_keywords SET label = $2, aliases = $3, active = $4 WHERE id = $1 RETURNING *`, [id, b.label, b.aliases, b.active]);
    if (!k) throw notFound();
    await audit(req.auth!.actor, 'warning.keyword_updated', { type: 'keyword', id, label: k.code });
    return k;
  });
  app.post('/warning-keywords/:id/questions', { preHandler: rules }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), text: z.string().trim().min(5).max(300), options: z.array(z.string().trim().min(1).max(40)).min(2).max(8).default(['ja', 'nein', 'unbekannt']), sort: z.number().int().default(0) }).parse(req.body);
    const q = await one<any>(`INSERT INTO keyword_questions (keyword_id, key, text, options, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (keyword_id, key) DO NOTHING RETURNING *`, [id, b.key, b.text, b.options, b.sort, req.auth!.user?.id ?? null]);
    if (!q) throw conflict('Eine Frage mit diesem Schlüssel gibt es bereits.');
    await audit(req.auth!.actor, 'warning.question_created', { type: 'keyword', id, label: b.key });
    return q;
  });
  /** Fachliche Freigabe einer Prüffrage (nicht durch die anlegende Person). */
  app.post('/keyword-questions/:id/approve', { preHandler: requireAuth('warning.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const q = await one<any>('SELECT * FROM keyword_questions WHERE id = $1', [id]);
    if (!q) throw notFound();
    if (q.created_by && q.created_by === req.auth!.user?.id) throw forbidden('Die fachliche Freigabe muss eine andere Person erteilen.');
    await pool.query(`UPDATE keyword_questions SET approved_at = now(), approved_by = $2 WHERE id = $1`, [id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'warning.question_approved', { type: 'keyword', id: q.keyword_id, label: q.key });
    return { ok: true };
  });
  app.post('/keyword-questions/:id/retire', { preHandler: rules }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await pool.query(`UPDATE keyword_questions SET retired_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Neue Regel oder neue Version einer Regel (immer als Entwurf; wirksam erst nach fachlicher Freigabe). */
  app.post('/warning-rules', { preHandler: rules }, async (req) => {
    const b = z
      .object({
        lineage: z.uuid().nullable().default(null),
        keywordId: z.uuid(),
        name: z.string().trim().min(3).max(120),
        conditions: z.record(z.string().regex(/^[a-z0-9_]{2,40}$/), z.array(z.string().trim().min(1).max(40)).min(1)).refine((c) => Object.keys(c).length > 0, 'Mindestens eine Bedingung.'),
        level: z.number().int().min(1).max(3),
        reason: z.string().trim().min(10).max(1000),
      })
      .parse(req.body);
    // Bedingungen nur auf vorhandene Lagefragen und deren Antworten – sonst greift die Regel nie
    const qs = await many<any>(`SELECT key, options FROM keyword_questions WHERE keyword_id = $1 AND retired_at IS NULL`, [b.keywordId]);
    for (const [key, answers] of Object.entries(b.conditions)) {
      const q = qs.find((x) => x.key === key);
      if (!q) throw badRequest(`Die Lagefrage „${key}“ gibt es für dieses Stichwort nicht.`);
      const bad = (answers as string[]).filter((a) => Array.isArray(q.options) && q.options.length && !q.options.includes(a));
      if (bad.length) throw badRequest(`„${bad.join(', ')}“ ist keine Antwort der Lagefrage „${key}“ (möglich: ${q.options.join(', ')}).`);
    }
    const lineage = b.lineage ?? crypto.randomUUID();
    const version = ((await one<any>(`SELECT max(version) AS v FROM warning_rules WHERE lineage = $1`, [lineage]))?.v ?? 0) + 1;
    const r = await one<any>(
      `INSERT INTO warning_rules (lineage, version, keyword_id, name, conditions, level, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [lineage, version, b.keywordId, b.name, JSON.stringify(b.conditions), b.level, b.reason, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'warning.rule_created', { type: 'rule', id: r.id, label: `${b.name} v${version}` }, { stufe: b.level });
    return r;
  });
  /** Fachliche Freigabe einer Regelversion. Ältere freigegebene Versionen derselben Regel treten außer Kraft. */
  app.post('/warning-rules/:id/approve', { preHandler: requireAuth('warning.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await tx(async (db) => {
      const r = await one<any>(`SELECT * FROM warning_rules WHERE id = $1 FOR UPDATE`, [id], db);
      if (!r) throw notFound();
      if (r.status !== 'draft') throw badRequest('Nur Entwürfe können freigegeben werden.');
      if (r.created_by && r.created_by === req.auth!.user?.id) throw forbidden('Die fachliche Freigabe muss eine andere Person erteilen.');
      await db.query(`UPDATE warning_rules SET status = 'retired' WHERE lineage = $1 AND status = 'approved'`, [r.lineage]);
      await db.query(`UPDATE warning_rules SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1`, [id, req.auth!.user?.id ?? null]);
      await audit(req.auth!.actor, 'warning.rule_approved', { type: 'rule', id, label: `${r.name} v${r.version}` }, { stufe: r.level }, 'ok', db);
    });
    return { ok: true };
  });
  app.post('/warning-rules/:id/retire', { preHandler: rules }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`UPDATE warning_rules SET status = 'retired' WHERE id = $1 RETURNING name, version`, [id]);
    if (!r) throw notFound();
    await audit(req.auth!.actor, 'warning.rule_retired', { type: 'rule', id, label: `${r.name} v${r.version}` });
    return { ok: true };
  });

  /** Neue Vorlagenversion (bestehende Entwürfe behalten ihre Version). */
  app.post('/warning-templates', { preHandler: rules }, async (req) => {
    const field = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), label: z.string().min(2).max(80), type: z.enum(['text', 'textarea', 'datetime', 'checkbox', 'select']), required: z.boolean().default(false), help: z.string().max(200).optional(), options: z.array(z.string()).optional() });
    const b = z
      .object({
        family: z.string().regex(/^[a-z0-9-]{3,40}$/),
        name: z.string().min(3).max(120),
        fields: z.array(field).min(1).max(40),
        levelLabels: z.object({ 1: z.string().min(2), 2: z.string().min(2), 3: z.string().min(2) }),
        pdfTitle: z.string().min(3).max(120),
        pdfFooter: z.string().min(3).max(500),
        mailSubject: z.string().min(3).max(200),
        mailBody: z.string().min(3).max(4000),
        note: z.string().max(500).default(''),
      })
      .parse(req.body);
    const version = ((await one<any>(`SELECT max(version) AS v FROM warning_templates WHERE family = $1`, [b.family]))?.v ?? 0) + 1;
    const t = await one<any>(
      `INSERT INTO warning_templates (family, version, name, fields, level_labels, pdf_title, pdf_footer, mail_subject, mail_body, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.family, version, b.name, JSON.stringify(b.fields), JSON.stringify(b.levelLabels), b.pdfTitle, b.pdfFooter, b.mailSubject, b.mailBody, b.note, req.auth!.user?.id ?? null],
    );
    await pool.query(`UPDATE warning_templates SET status = 'retired' WHERE family = $1 AND id <> $2`, [b.family, t.id]);
    await audit(req.auth!.actor, 'warning.template_version', { type: 'template', id: t.id, label: `${b.name} v${version}` });
    return t;
  });

  app.post('/responsibilities', { preHandler: rules }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), area: z.string().trim().max(200).default(''), recipients: z.array(z.email()).min(1).max(20) }).parse(req.body);
    const r = await one<any>(`INSERT INTO responsibilities (name, area, recipients, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [b.name, b.area, b.recipients, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'warning.responsibility_created', { type: 'responsibility', id: r.id, label: r.name }, recipientAudit([], b.recipients));
    return r;
  });
  app.put('/responsibilities/:id', { preHandler: rules }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120), area: z.string().trim().max(200), recipients: z.array(z.email()).min(1).max(20), active: z.boolean() }).parse(req.body);
    const before = await one<any>(`SELECT recipients FROM responsibilities WHERE id = $1`, [id]);
    const r = await one<any>(`UPDATE responsibilities SET name = $2, area = $3, recipients = $4, active = $5 WHERE id = $1 RETURNING *`, [id, b.name, b.area, b.recipients, b.active]);
    if (!r) throw notFound();
    await audit(req.auth!.actor, 'warning.responsibility_updated', { type: 'responsibility', id, label: r.name }, { ...recipientAudit(before?.recipients ?? [], b.recipients), aktiv: b.active });
    return r;
  });

  /**
   * Kandidat für den Versand aus Formularwerten. Das gespeicherte Passwort wird nur für denselben Server weiterverwendet –
   * sonst könnte man es durch Ändern des Servers an einen fremden Rechner schicken. Bei anderem Server mit Anmeldung muss
   * das Passwort neu eingegeben werden.
   */
  const candidate = (b: { host: string; port: number; security: string; user: string; from: string; password?: string }, stored: SmtpSettings): SmtpSettings => {
    const sameHost = b.host.trim().toLowerCase() === stored.host.trim().toLowerCase();
    if (!b.password && !sameHost && b.user.trim() && b.security !== 'none' && stored.password) throw badRequest('Der Server wurde geändert: Bitte das Passwort für den neuen Server erneut eingeben.');
    return { host: b.host.trim(), port: b.port, security: b.security, user: b.user, from: b.from.trim(), password: b.password || (sameHost ? stored.password : '') };
  };

  /** Versandeinstellungen und Testmodus (Administration). */
  app.put('/warning-settings', { preHandler: requireAuth('system.manage') }, async (req) => {
    const b = z
      .object({
        host: z.string().trim().max(200),
        port: z.number().int().min(1).max(65535),
        security: z.enum(['starttls', 'tls', 'none']),
        user: z.string().max(200).default(''),
        from: z.string().max(200),
        password: z.string().max(500).optional(),
        testMode: z.boolean(),
        testRecipient: z.union([z.email(), z.literal('')]),
      })
      .parse(req.body);
    if (!b.testMode && !b.host) throw badRequest('Für den Echtbetrieb muss ein SMTP-Server eingetragen sein.');
    const problem = smtpConfigProblem({ security: b.security, user: b.user, password: b.password });
    if (problem) throw badRequest(problem);
    const before = await getSettings(true);
    const stored = await storedSmtpSettings();
    const next = candidate(b, stored);
    // Echtbetrieb nur mit nachweislich funktionierenden Einstellungen: Testmodus ausschalten oder Versandeinstellungen im
    // Echtbetrieb ändern verlangt eine erfolgreiche Testmail mit genau diesen Werten (höchstens 60 Minuten alt).
    const smtpChanged = !!b.password || (['host', 'port', 'security', 'user', 'from'] as const).some((k) => String((stored as any)[k] ?? '').trim() !== String((next as any)[k] ?? '').trim());
    if (!b.testMode && (before['warnings.test_mode'] || smtpChanged)) {
      const v = before['smtp.verified'];
      const fresh = !!v && Date.now() - Date.parse(v.at) <= SMTP_VERIFY_MAX_AGE_MS;
      if (!fresh || v!.fp !== smtpFingerprint(next)) {
        throw conflict(
          before['warnings.test_mode']
            ? 'Der Testmodus lässt sich erst ausschalten, nachdem mit genau diesen Einstellungen eine Testmail erfolgreich versendet wurde (höchstens 60 Minuten alt). Bitte zuerst „Testmail senden“.'
            : 'Im Echtbetrieb lassen sich die Versandeinstellungen nur nach einer erfolgreichen Testmail mit genau diesen Einstellungen ändern (höchstens 60 Minuten alt). Bitte zuerst „Testmail senden“ – oder vorher den Testmodus einschalten.',
        );
      }
    }
    const patch: any = { 'smtp.host': b.host, 'smtp.port': b.port, 'smtp.security': b.security, 'smtp.user': b.user, 'smtp.from': b.from, 'warnings.test_mode': b.testMode, 'warnings.test_recipient': b.testRecipient };
    await tx(async (db) => {
      if (b.password) {
        // Neues Passwort: neue Version anlegen und die bisherige im selben Schritt widerrufen (#172); widerrufene
        // Setting-Geheimnisse löscht der Worker nach 30 Tagen endgültig.
        const prev = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'smtp.password_secret_id' FOR UPDATE`, [], db);
        const sec = await storeSecret('setting', SMTP_SECRET_OWNER, b.password, req.auth!.user?.id ?? null, db);
        patch['smtp.password_secret_id'] = sec.id;
        if (typeof prev?.value === 'string' && prev.value && prev.value !== sec.id) await revokeSecret(prev.value, db);
      }
      await setSettings(patch, req.auth!.user?.id ?? null, db);
    });
    const { 'smtp.password_secret_id': _pw, ...visible } = patch;
    const changes = settingsDiff(before as any, visible);
    await audit(req.auth!.actor, 'warning.settings_changed', { type: 'settings', label: 'Warnversand' }, { testmodus: b.testMode, server: b.host, passwort_geaendert: !!b.password, aenderungen: Object.keys(changes).length ? changes : undefined });
    return { ok: true };
  });
  /**
   * Testmail – mit den gespeicherten Einstellungen oder (empfohlen) mit den Werten aus dem Formular, noch bevor sie
   * gespeichert sind (Passwort leer = gespeichertes Passwort, nur für denselben Server). Eine erfolgreiche Testmail
   * hinterlegt den Prüfwert genau dieser Einstellungen; erst damit lässt sich der Testmodus ausschalten.
   */
  app.post('/warning-settings/test-mail', { preHandler: requireAuth('system.manage'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = z
      .object({
        to: z.email(),
        host: z.string().trim().max(200).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        security: z.enum(['starttls', 'tls', 'none']).optional(),
        user: z.string().max(200).optional(),
        from: z.string().max(200).optional(),
        password: z.string().max(500).optional(),
      })
      .parse(req.body);
    const stored = await storedSmtpSettings();
    const cand = b.host === undefined ? stored : candidate({ host: b.host, port: b.port ?? stored.port, security: b.security ?? stored.security, user: b.user ?? '', from: b.from ?? '', password: b.password }, stored);
    const problem = smtpConfigProblem({ security: cand.security, user: cand.user, password: b.password });
    if (problem) throw badRequest(problem);
    if (!cand.host || !cand.from) throw badRequest('Bitte Server und Absender eintragen.');
    try {
      const { transport, from } = await smtpTransport(cand);
      const info = await transport.sendMail({ from, to: b.to, subject: 'BlaulichtCMS: Testmail', text: 'Diese Testmail bestätigt, dass BlaulichtCMS E-Mails über den eingetragenen Server versenden kann.' });
      const at = new Date().toISOString();
      await setSettings({ 'smtp.verified': { fp: smtpFingerprint(cand), at } }, req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'warning.test_mail', { type: 'settings', label: 'Warnversand' }, { an: b.to, server: cand.host, port: cand.port, formularwerte: b.host !== undefined || undefined });
      return { ok: true, response: info.response, verified_at: at };
    } catch (e) {
      await audit(req.auth!.actor, 'warning.test_mail', { type: 'settings', label: 'Warnversand' }, { an: b.to, server: cand.host, fehler: (e as Error).message.slice(0, 200) }, 'failed').catch(() => {});
      throw new AppError(502, 'smtp_failed', `Testmail fehlgeschlagen: ${(e as Error).message}`);
    }
  });
}
