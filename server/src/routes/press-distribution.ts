import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { assertRecentAuth, requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { csvCell } from '../lib/csv.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { EMAIL_RE } from '../press/common.js';
import { contactFromToken, parseCsv, postAsRelease, startRelease } from '../press/releases.js';

/*
 * Presseverteiler und Pressemitteilungen (#207): Kontakte (mit Herkunft/Einwilligung und Abmeldung), Verteilerlisten,
 * Import/Export als CSV, Pressemitteilungen mit Versandprotokoll und die öffentliche Abmeldung.
 */

const contactInput = z.object({
  name: z.string().trim().max(200).default(''),
  outlet: z.string().trim().max(200).default(''),
  email: z.email().max(254),
  phone: z.string().trim().max(60).default(''),
  note: z.string().trim().max(2000).default(''),
  origin: z.string().trim().max(500).default(''),
  consent: z.string().trim().max(500).default(''),
  listIds: z.array(z.uuid()).max(100).default([]),
});

async function setMemberships(db: any, contactId: string, listIds: string[]) {
  await db.query(`DELETE FROM press_list_members WHERE contact_id = $1 AND NOT (list_id = ANY($2::uuid[]))`, [contactId, listIds]);
  if (listIds.length) await db.query(`INSERT INTO press_list_members (list_id, contact_id) SELECT l, $1 FROM unnest($2::uuid[]) AS l WHERE EXISTS (SELECT 1 FROM press_lists WHERE id = l) ON CONFLICT DO NOTHING`, [contactId, listIds]);
}

const CSV_HEADER = ['name', 'medium', 'email', 'telefon', 'notiz', 'herkunft', 'einwilligung', 'listen', 'abgemeldet'];

export async function pressDistributionRoutes(app: FastifyInstance) {
  const contacts = requireAuth('press.contacts');
  const releases = requireAuth('press.release');

  /* ------------------------------------------------------------------ Kontakte */

  app.get('/press/contacts', { preHandler: contacts }, async () =>
    many<any>(
      `SELECT c.id, c.name, c.outlet, c.email, c.phone, c.note, c.origin, c.consent, c.unsubscribed_at, c.created_at, c.updated_at,
              COALESCE(array_agg(m.list_id) FILTER (WHERE m.list_id IS NOT NULL), '{}') AS list_ids
         FROM press_contacts c LEFT JOIN press_list_members m ON m.contact_id = c.id GROUP BY c.id ORDER BY lower(c.outlet), lower(c.name), lower(c.email) LIMIT 5000`,
    ),
  );

  app.post('/press/contacts', { preHandler: contacts }, async (req) => {
    const v = contactInput.parse(req.body);
    if (await one(`SELECT 1 FROM press_contacts WHERE lower(email) = lower($1)`, [v.email])) throw conflict('Diese E-Mail-Adresse steht schon im Verteiler.');
    const id = await tx(async (db) => {
      const r = await one<any>(`INSERT INTO press_contacts (name, outlet, email, phone, note, origin, consent, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [v.name, v.outlet, v.email.toLowerCase(), v.phone, v.note, v.origin, v.consent, req.auth!.user?.id ?? null], db);
      await setMemberships(db, r.id, v.listIds);
      await audit(req.auth!.actor, 'press.contact_created', { type: 'press_contact', id: r.id, label: v.outlet || 'Kontakt' }, {}, 'ok', db);
      return r.id as string;
    });
    return { id };
  });

  app.put('/press/contacts/:id', { preHandler: contacts }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = contactInput.extend({ resubscribe: z.boolean().default(false) }).parse(req.body);
    const cur = await one<any>(`SELECT * FROM press_contacts WHERE id = $1`, [id]);
    if (!cur) throw notFound('Kontakt nicht gefunden.');
    if (await one(`SELECT 1 FROM press_contacts WHERE lower(email) = lower($1) AND id <> $2`, [v.email, id])) throw conflict('Diese E-Mail-Adresse steht schon im Verteiler.');
    if (v.resubscribe && cur.unsubscribed_at && !v.consent) throw badRequest('Wieder anmelden nur mit vermerkter Einwilligung (z. B. „erneut zugestimmt per Mail am …“).');
    await tx(async (db) => {
      await db.query(`UPDATE press_contacts SET name = $2, outlet = $3, email = $4, phone = $5, note = $6, origin = $7, consent = $8, unsubscribed_at = CASE WHEN $9 THEN NULL ELSE unsubscribed_at END, updated_at = now() WHERE id = $1`, [id, v.name, v.outlet, v.email.toLowerCase(), v.phone, v.note, v.origin, v.consent, v.resubscribe]);
      await setMemberships(db, id, v.listIds);
      await audit(req.auth!.actor, v.resubscribe && cur.unsubscribed_at ? 'press.contact_resubscribed' : 'press.contact_updated', { type: 'press_contact', id, label: v.outlet || 'Kontakt' }, {}, 'ok', db);
    });
    return { ok: true };
  });

  app.delete('/press/contacts/:id', { preHandler: contacts }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`DELETE FROM press_contacts WHERE id = $1 RETURNING outlet, email`, [id]);
    if (!r) throw notFound('Kontakt nicht gefunden.');
    // Adresse auch aus den Versandprotokollen entfernen
    await pool.query(`UPDATE press_release_recipients SET email = 'gelöscht:' || left(id::text, 8), name = '' WHERE lower(email) = lower($1)`, [r.email]);
    await audit(req.auth!.actor, 'press.contact_deleted', { type: 'press_contact', id, label: r.outlet || 'Kontakt' });
    return { ok: true };
  });

  app.get('/press/contacts/export', { preHandler: contacts }, async (req, reply) => {
    const rows = await many<any>(
      `SELECT c.*, COALESCE(string_agg(l.name, '|' ORDER BY l.name), '') AS lists FROM press_contacts c
         LEFT JOIN press_list_members m ON m.contact_id = c.id LEFT JOIN press_lists l ON l.id = m.list_id GROUP BY c.id ORDER BY lower(c.email)`,
    );
    const lines = [CSV_HEADER.join(';'), ...rows.map((c) => [c.name, c.outlet, c.email, c.phone, c.note, c.origin, c.consent, c.lists, c.unsubscribed_at ? new Date(c.unsubscribed_at).toISOString() : ''].map(csvCell).join(';'))];
    await audit(req.auth!.actor, 'press.contacts_exported', { type: 'press_contact', label: 'Presseverteiler' }, { anzahl: rows.length });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="presseverteiler-${new Date().toISOString().slice(0, 10)}.csv"`).header('cache-control', 'no-store');
    return '﻿' + lines.join('\r\n') + '\r\n';
  });

  /**
   * Import (CSV mit Kopfzeile wie beim Export). Vorhandene Adressen werden ergänzt, nicht verdoppelt; abgemeldete
   * Kontakte bleiben abgemeldet. Listen werden über ihren Namen zugeordnet (mit | getrennt) und bei Bedarf angelegt.
   */
  app.post('/press/contacts/import', { preHandler: contacts, bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const b = z.object({ csv: z.string().min(1).max(4_000_000), dryRun: z.boolean().default(false), origin: z.string().trim().max(500).default('') }).parse(req.body);
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw badRequest('Die Datei enthält keine Kontakte (erste Zeile: Spaltennamen).');
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/^e-?mail$/, 'email').replace(/^(telefonnummer|phone)$/, 'telefon').replace(/^(redaktion|outlet)$/, 'medium'));
    const col = (name: string) => head.indexOf(name);
    if (col('email') < 0) throw badRequest('Spalte „email“ fehlt.');
    const problems: string[] = [];
    const items: { name: string; outlet: string; email: string; phone: string; note: string; origin: string; consent: string; lists: string[] }[] = [];
    const seen = new Set<string>();
    rows.slice(1).forEach((r, i) => {
      const get = (n: string) => (col(n) >= 0 ? String(r[col(n)] ?? '').trim() : '');
      const email = get('email').toLowerCase();
      if (!EMAIL_RE.test(email)) return void problems.push(`Zeile ${i + 2}: keine gültige E-Mail-Adresse`);
      if (seen.has(email)) return void problems.push(`Zeile ${i + 2}: ${email} doppelt`);
      seen.add(email);
      items.push({ name: get('name').slice(0, 200), outlet: get('medium').slice(0, 200), email, phone: get('telefon').slice(0, 60), note: get('notiz').slice(0, 2000), origin: (get('herkunft') || b.origin).slice(0, 500), consent: get('einwilligung').slice(0, 500), lists: get('listen').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 20) });
    });
    if (items.length > 5000) throw badRequest('Höchstens 5 000 Kontakte je Import.');
    const existing = new Set((await many<{ e: string }>(`SELECT lower(email) AS e FROM press_contacts WHERE lower(email) = ANY($1::text[])`, [items.map((x) => x.email)])).map((x) => x.e));
    const summary = { neu: items.filter((x) => !existing.has(x.email)).length, aktualisiert: items.filter((x) => existing.has(x.email)).length, fehler: problems.length };
    if (b.dryRun) return { ...summary, problems: problems.slice(0, 50) };
    await tx(async (db) => {
      for (const it of items) {
        const c = await one<any>(
          `INSERT INTO press_contacts (name, outlet, email, phone, note, origin, consent, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (lower(email)) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), press_contacts.name), outlet = COALESCE(NULLIF(EXCLUDED.outlet, ''), press_contacts.outlet),
             phone = COALESCE(NULLIF(EXCLUDED.phone, ''), press_contacts.phone), note = COALESCE(NULLIF(EXCLUDED.note, ''), press_contacts.note),
             origin = COALESCE(NULLIF(EXCLUDED.origin, ''), press_contacts.origin), consent = COALESCE(NULLIF(EXCLUDED.consent, ''), press_contacts.consent), updated_at = now()
           RETURNING id`,
          [it.name, it.outlet, it.email, it.phone, it.note, it.origin, it.consent, req.auth!.user?.id ?? null],
          db,
        );
        for (const name of it.lists) {
          const l = await one<any>(`INSERT INTO press_lists (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name = press_lists.name RETURNING id`, [name.slice(0, 120)], db);
          await db.query(`INSERT INTO press_list_members (list_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [l.id, c.id]);
        }
      }
      await audit(req.auth!.actor, 'press.contacts_imported', { type: 'press_contact', label: 'Presseverteiler' }, summary, 'ok', db);
    });
    return { ...summary, problems: problems.slice(0, 50) };
  });

  /* ------------------------------------------------------------------ Verteilerlisten */

  app.get('/press/lists', { preHandler: requireAnyAuth('press.contacts', 'press.release') }, async () =>
    many<any>(
      `SELECT l.id, l.name, l.description, count(c.id) FILTER (WHERE c.unsubscribed_at IS NULL)::int AS contacts, count(c.id) FILTER (WHERE c.unsubscribed_at IS NOT NULL)::int AS unsubscribed
         FROM press_lists l LEFT JOIN press_list_members m ON m.list_id = l.id LEFT JOIN press_contacts c ON c.id = m.contact_id GROUP BY l.id ORDER BY lower(l.name)`,
    ),
  );
  const listInput = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default('') });
  app.post('/press/lists', { preHandler: contacts }, async (req) => {
    const v = listInput.parse(req.body);
    if (await one(`SELECT 1 FROM press_lists WHERE lower(name) = lower($1)`, [v.name])) throw conflict('Eine Liste mit diesem Namen gibt es schon.');
    const r = await one<any>(`INSERT INTO press_lists (name, description) VALUES ($1,$2) RETURNING id`, [v.name, v.description]);
    await audit(req.auth!.actor, 'press.list_created', { type: 'press_list', id: r.id, label: v.name });
    return { id: r.id };
  });
  app.put('/press/lists/:id', { preHandler: contacts }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = listInput.parse(req.body);
    if (await one(`SELECT 1 FROM press_lists WHERE lower(name) = lower($1) AND id <> $2`, [v.name, id])) throw conflict('Eine Liste mit diesem Namen gibt es schon.');
    const r = await pool.query(`UPDATE press_lists SET name = $2, description = $3 WHERE id = $1`, [id, v.name, v.description]);
    if (!r.rowCount) throw notFound('Liste nicht gefunden.');
    await audit(req.auth!.actor, 'press.list_updated', { type: 'press_list', id, label: v.name });
    return { ok: true };
  });
  app.delete('/press/lists/:id', { preHandler: contacts }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`DELETE FROM press_lists WHERE id = $1 RETURNING name`, [id]);
    if (!r) throw notFound('Liste nicht gefunden.');
    await audit(req.auth!.actor, 'press.list_deleted', { type: 'press_list', id, label: r.name });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ Pressemitteilungen */

  app.get('/press/releases', { preHandler: releases }, async () =>
    many<any>(
      `SELECT r.id, r.subject, r.status, r.source, r.list_ids, r.post_id, r.created_at, r.sent_at, u.name AS sent_by_name,
              (SELECT count(*)::int FROM press_release_recipients x WHERE x.release_id = r.id) AS recipients,
              (SELECT count(*)::int FROM press_release_recipients x WHERE x.release_id = r.id AND x.status = 'sent') AS sent,
              (SELECT count(*)::int FROM press_release_recipients x WHERE x.release_id = r.id AND x.status IN ('failed','unknown')) AS failed
         FROM press_releases r LEFT JOIN users u ON u.id = r.sent_by ORDER BY r.created_at DESC LIMIT 200`,
    ),
  );

  app.get('/press/releases/:id', { preHandler: releases }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`SELECT r.*, u.name AS sent_by_name, p.title AS post_title FROM press_releases r LEFT JOIN users u ON u.id = r.sent_by LEFT JOIN posts p ON p.id = r.post_id WHERE r.id = $1`, [id]);
    if (!r) throw notFound('Pressemitteilung nicht gefunden.');
    const recipients = await many<any>(`SELECT id, email, name, status, error, sent_at FROM press_release_recipients WHERE release_id = $1 ORDER BY lower(email)`, [id]);
    return { release: r, recipients };
  });

  const releaseInput = z.object({ subject: z.string().trim().min(2).max(300), body: z.string().trim().max(50_000).default(''), listIds: z.array(z.uuid()).max(20).default([]), postId: z.uuid().nullable().default(null) });

  /** Vorlage aus einem Beitrag (Titel und Text der aktuellen Fassung). */
  app.get('/press/releases/from-post/:id', { preHandler: releases }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await postAsRelease(id);
    if (!p) throw notFound('Beitrag nicht gefunden.');
    return p;
  });

  app.post('/press/releases', { preHandler: releases }, async (req) => {
    const v = releaseInput.parse(req.body);
    const r = await one<any>(`INSERT INTO press_releases (subject, body, list_ids, post_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [v.subject, v.body, v.listIds, v.postId, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'press.release_created', { type: 'press_release', id: r.id, label: v.subject.slice(0, 120) });
    return { id: r.id };
  });

  app.put('/press/releases/:id', { preHandler: releases }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = releaseInput.parse(req.body);
    const r = await pool.query(`UPDATE press_releases SET subject = $2, body = $3, list_ids = $4, post_id = $5, updated_at = now() WHERE id = $1 AND status = 'draft'`, [id, v.subject, v.body, v.listIds, v.postId]);
    if (!r.rowCount) throw conflict('Nur Entwürfe lassen sich ändern.');
    return { ok: true };
  });

  app.delete('/press/releases/:id', { preHandler: releases }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`DELETE FROM press_releases WHERE id = $1 AND status = 'draft' RETURNING subject`, [id]);
    if (!r) throw conflict('Nur Entwürfe lassen sich löschen; das Versandprotokoll gesendeter Mitteilungen bleibt.');
    await audit(req.auth!.actor, 'press.release_deleted', { type: 'press_release', id, label: r.subject.slice(0, 120) });
    return { ok: true };
  });

  /** Versenden (bzw. noch nicht versuchte Empfänger nachholen) – mit frischer Passwortbestätigung. */
  app.post('/press/releases/:id/send', { preHandler: releases, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`SELECT status, body FROM press_releases WHERE id = $1`, [id]);
    if (!r) throw notFound('Pressemitteilung nicht gefunden.');
    if (r.status === 'sending') throw conflict('Der Versand läuft bereits.');
    if (r.status === 'draft' && !r.body.trim()) throw badRequest('Bitte einen Text eingeben.');
    assertRecentAuth(req);
    const open = await startRelease(id, req.auth!.actor, req.auth!.user?.id ?? null);
    return { ok: true, recipients: open };
  });

  /* ------------------------------------------------------------------ Öffentliche Abmeldung */

  const publicLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  // Mailprogramme senden die Ein-Klick-Abmeldung als Formular („List-Unsubscribe=One-Click“); der Inhalt zählt nicht
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
  const tokenParam = z.object({ token: z.string().max(100) });
  const mask = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1…$2');

  app.get('/public/press/unsubscribe/:token', { config: publicLimit }, async (req) => {
    const id = contactFromToken(tokenParam.parse(req.params).token);
    const c = id ? await one<any>(`SELECT email, unsubscribed_at FROM press_contacts WHERE id = $1`, [id]) : null;
    if (!c) throw notFound('Dieser Abmeldelink ist ungültig oder der Kontakt wurde bereits gelöscht.');
    return { email: mask(c.email), unsubscribed: !!c.unsubscribed_at };
  });

  /** Abmelden – auch als One-Click nach RFC 8058 (POST mit „List-Unsubscribe=One-Click“ aus dem Mailprogramm). */
  app.post('/public/press/unsubscribe/:token', { config: publicLimit }, async (req) => {
    const id = contactFromToken(tokenParam.parse(req.params).token);
    const c = id ? await one<any>(`UPDATE press_contacts SET unsubscribed_at = COALESCE(unsubscribed_at, now()), updated_at = now() WHERE id = $1 RETURNING id, outlet`, [id]) : null;
    if (!c) throw notFound('Dieser Abmeldelink ist ungültig oder der Kontakt wurde bereits gelöscht.');
    await audit({ id: null, name: 'Abmeldelink', type: 'system', ip: req.ip }, 'press.contact_unsubscribed', { type: 'press_contact', id: c.id, label: c.outlet || 'Kontakt' });
    return { ok: true };
  });
}
