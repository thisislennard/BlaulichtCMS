import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { config } from '../config.js';
import { scanFile, ScannerUnavailable } from '../media/clamav.js';
import { moveFile, SizeLimitError, streamToTemp } from '../media/storage.js';
import { cleanFileName, detectFormat, ensureDir, FORMATS, MAX_FILE_BYTES, MAX_FILES_PER_VERSION, MAX_SVG_BYTES, sanitizeSvg, SvgRejected, templatePaths } from '../templates/files.js';
import { sendFileResponse } from './files.js';

/*
 * Designvorlagen (#208): interne Bibliothek (nur angemeldet, „Designvorlagen ansehen“). Vorlagen haben eine Kategorie,
 * Schlagworte, Nutzungshinweise, ein Vorschaubild und Versionen; jede Version kann mehrere Formate enthalten (PNG, SVG,
 * PDF, offene Dateien …). Neue Dateien kommen in die aktuelle Version, ältere Versionen bleiben unverändert abrufbar.
 * Uploads: Endung und Inhalt müssen zusammenpassen, ClamAV prüft (falls eingerichtet), SVG wird bereinigt.
 */

const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const PREVIEW_EDGE = 900;

const meta = z.object({
  title: z.string().trim().min(2, 'Bitte einen Titel mit mindestens 2 Zeichen angeben.').max(150),
  description: z.string().trim().max(2000).default(''),
  usageNote: z.string().trim().max(1000).default(''),
  categoryId: z.uuid().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const formatLabel = (key: string) => FORMATS.find((f) => f.key === key)?.label ?? key;
const actorOf = (req: FastifyRequest) => req.auth!.actor;
const userOf = (req: FastifyRequest) => req.auth!.user?.id ?? null;

async function loadTemplate(id: string) {
  const t = await one<any>(`SELECT * FROM design_templates WHERE id = $1`, [id]);
  if (!t) throw notFound('Vorlage nicht gefunden.');
  return t;
}

async function assertCategory(id: string | null) {
  if (id && !(await one(`SELECT 1 FROM template_categories WHERE id = $1`, [id]))) throw badRequest('Die Kategorie gibt es nicht (mehr).');
}

const cleanTags = (tags: string[]) => [...new Map(tags.map((t) => [t.toLowerCase(), t])).values()];

/** Schadsoftwareprüfung einer hochgeladenen Datei (wie bei den Medien, aber direkt in der Anfrage). */
async function malwareCheck(req: FastifyRequest, file: string, name: string) {
  const c = config.clamav;
  if (!c.host) return;
  let r;
  try {
    r = await scanFile(file, c);
  } catch (e) {
    if (e instanceof ScannerUnavailable) throw new AppError(503, 'scanner_unavailable', 'Die Schadsoftwareprüfung ist gerade nicht verfügbar. Bitte später erneut hochladen.');
    throw e;
  }
  if (r.status === 'infected') {
    await audit(actorOf(req), 'design_template.malware_found', { type: 'design_template', label: name }, { signatur: r.signature }, 'denied');
    throw badRequest(`Schadsoftware erkannt (${r.signature}). Die Datei wurde nicht übernommen.`);
  }
}

/** Vorschaubild aus einer Bild- oder SVG-Datei (gedreht, höchstens 900 px, WebP, ohne Metadaten). */
async function renderPreview(source: string, target: string) {
  ensureDir(target);
  const tmp = `${target}.${process.pid}.tmp`;
  await sharp(source, { limitInputPixels: MAX_PIXELS, failOn: 'error', density: 144 })
    .rotate()
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 80 })
    .toFile(tmp);
  fs.renameSync(tmp, target);
}

/**
 * Automatisches Vorschaubild aus der ersten geeigneten Datei der aktuellen Version (PNG/JPEG/WebP vor SVG, GIF, TIFF).
 * Ein eigens hochgeladenes Vorschaubild bleibt unangetastet.
 */
export async function refreshAutoPreview(templateId: string) {
  const t = await one<any>(`SELECT id, preview, current_version, kind FROM design_templates WHERE id = $1`, [templateId]);
  if (!t || t.preview === 'upload' || t.kind === 'image') return;
  const files = await many<any>(
    `SELECT f.id, f.format FROM design_template_files f JOIN design_template_versions v ON v.id = f.version_id
      WHERE f.template_id = $1 AND v.number = $2 ORDER BY f.created_at`,
    [templateId, t.current_version],
  );
  const rank = ['png', 'jpeg', 'webp', 'svg', 'gif', 'tiff'];
  const candidates = files.filter((f) => rank.includes(f.format)).sort((a, b) => rank.indexOf(a.format) - rank.indexOf(b.format));
  for (const f of candidates) {
    try {
      await renderPreview(templatePaths.file(f.id), templatePaths.preview(templateId));
      await pool.query(`UPDATE design_templates SET preview = 'auto', preview_rev = preview_rev + 1 WHERE id = $1`, [templateId]);
      return;
    } catch {
      /* nächste Datei versuchen */
    }
  }
  fs.rmSync(templatePaths.preview(templateId), { force: true });
  await pool.query(`UPDATE design_templates SET preview = 'none', preview_rev = preview_rev + 1 WHERE id = $1 AND preview <> 'none'`, [templateId]);
}

function listItem(t: any) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    usage_note: t.usage_note,
    category: t.category_id ? { id: t.category_id, name: t.category_name } : null,
    tags: t.tags ?? [],
    kind: t.kind,
    has_preview: t.preview !== 'none',
    preview_rev: t.preview_rev,
    current_version: t.current_version,
    download_count: t.download_count,
    formats: (t.formats ?? []).map((f: string) => ({ key: f, label: formatLabel(f) })),
    file_count: t.file_count ?? 0,
    updated_at: t.updated_at,
    created_at: t.created_at,
  };
}

export async function designTemplateRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- Kategorien */

  app.get('/design-template-categories', { preHandler: requireAuth('templates.view') }, async () =>
    many<any>(`SELECT c.id, c.name, c.sort_order, (SELECT count(*)::int FROM design_templates t WHERE t.category_id = c.id) AS template_count FROM template_categories c ORDER BY c.sort_order, lower(c.name)`),
  );

  app.post('/design-template-categories', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().min(0).max(1000).default(0) }).parse(req.body ?? {});
    const c = await one<any>(`INSERT INTO template_categories (name, sort_order) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id, name, sort_order`, [b.name, b.sortOrder]);
    if (!c) throw conflict('Eine Kategorie mit diesem Namen gibt es schon.');
    await audit(actorOf(req), 'design_template.category_created', { type: 'template_category', id: c.id, label: c.name });
    return c;
  });

  app.patch('/design-template-categories/:id', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(60).optional(), sortOrder: z.number().int().min(0).max(1000).optional() }).parse(req.body ?? {});
    let c;
    try {
      c = await one<any>(`UPDATE template_categories SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order) WHERE id = $1 RETURNING id, name, sort_order`, [id, b.name ?? null, b.sortOrder ?? null]);
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Eine Kategorie mit diesem Namen gibt es schon.');
      throw e;
    }
    if (!c) throw notFound('Kategorie nicht gefunden.');
    await audit(actorOf(req), 'design_template.category_updated', { type: 'template_category', id, label: c.name });
    return c;
  });

  app.delete('/design-template-categories/:id', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await one<any>(`DELETE FROM template_categories WHERE id = $1 RETURNING name`, [id]);
    if (!c) throw notFound('Kategorie nicht gefunden.');
    await audit(actorOf(req), 'design_template.category_deleted', { type: 'template_category', id, label: c.name });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Vorlagen */

  app.get('/design-templates', { preHandler: requireAuth('templates.view') }, async (req) => {
    const q = z
      .object({ q: z.string().trim().max(100).optional(), category: z.union([z.uuid(), z.literal('none')]).optional(), kind: z.enum(['files', 'image']).optional(), format: z.string().max(20).optional() })
      .parse(req.query ?? {});
    const rows = await many<any>(
      `SELECT t.*, c.name AS category_name,
              (SELECT array_agg(DISTINCT f.format) FROM design_template_files f JOIN design_template_versions v ON v.id = f.version_id WHERE f.template_id = t.id AND v.number = t.current_version) AS formats,
              (SELECT count(*)::int FROM design_template_files f JOIN design_template_versions v ON v.id = f.version_id WHERE f.template_id = t.id AND v.number = t.current_version) AS file_count
         FROM design_templates t LEFT JOIN template_categories c ON c.id = t.category_id
        WHERE ($1::text IS NULL OR t.title ILIKE $1 OR t.description ILIKE $1 OR t.usage_note ILIKE $1 OR c.name ILIKE $1
               OR EXISTS (SELECT 1 FROM unnest(t.tags) tag WHERE tag ILIKE $1))
          AND ($2::text IS NULL OR ($2 = 'none' AND t.category_id IS NULL) OR t.category_id::text = $2)
          AND ($3::text IS NULL OR t.kind = $3)
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM design_template_files f JOIN design_template_versions v ON v.id = f.version_id WHERE f.template_id = t.id AND v.number = t.current_version AND f.format = $4))
        ORDER BY lower(t.title)`,
      [q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null, q.category ?? null, q.kind ?? null, q.format ?? null],
    );
    return { templates: rows.map(listItem), formats: FORMATS.map((f) => ({ key: f.key, label: f.label, exts: f.exts })) };
  });

  app.get('/design-templates/:id', { preHandler: requireAuth('templates.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await one<any>(
      `SELECT t.*, c.name AS category_name, cu.name AS created_by_name, uu.name AS updated_by_name
         FROM design_templates t LEFT JOIN template_categories c ON c.id = t.category_id
         LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users uu ON uu.id = t.updated_by WHERE t.id = $1`,
      [id],
    );
    if (!t) throw notFound('Vorlage nicht gefunden.');
    const versions = await many<any>(`SELECT v.id, v.number, v.note, v.created_at, u.name AS created_by_name FROM design_template_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.template_id = $1 ORDER BY v.number DESC`, [id]);
    const files = await many<any>(`SELECT id, version_id, original_name, format, size_bytes, download_count, created_at FROM design_template_files WHERE template_id = $1 ORDER BY created_at`, [id]);
    return {
      ...listItem({ ...t, formats: [] }),
      created_by_name: t.created_by_name,
      updated_by_name: t.updated_by_name,
      preview_source: t.preview,
      versions: versions.map((v) => ({
        ...v,
        current: v.number === t.current_version,
        files: files.filter((f) => f.version_id === v.id).map((f) => ({ id: f.id, name: f.original_name, format: f.format, format_label: formatLabel(f.format), size_bytes: Number(f.size_bytes), download_count: f.download_count, created_at: f.created_at })),
      })),
    };
  });

  app.post('/design-templates', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const b = meta.extend({ versionNote: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    await assertCategory(b.categoryId);
    const t = await tx(async (db) => {
      const row = await one<any>(
        `INSERT INTO design_templates (title, description, usage_note, category_id, tags, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [b.title, b.description, b.usageNote, b.categoryId, cleanTags(b.tags), userOf(req)],
        db,
      );
      await db.query(`INSERT INTO design_template_versions (template_id, number, note, created_by) VALUES ($1, 1, $2, $3)`, [row!.id, b.versionNote, userOf(req)]);
      return row!;
    });
    await audit(actorOf(req), 'design_template.created', { type: 'design_template', id: t.id, label: t.title });
    return { id: t.id };
  });

  app.patch('/design-templates/:id', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = meta.partial().parse(req.body ?? {});
    if (b.categoryId !== undefined) await assertCategory(b.categoryId);
    const t = await one<any>(
      `UPDATE design_templates SET title = COALESCE($2, title), description = COALESCE($3, description), usage_note = COALESCE($4, usage_note),
              category_id = CASE WHEN $5 THEN $6::uuid ELSE category_id END, tags = COALESCE($7, tags), updated_at = now(), updated_by = $8
        WHERE id = $1 RETURNING id, title`,
      [id, b.title ?? null, b.description ?? null, b.usageNote ?? null, b.categoryId !== undefined, b.categoryId ?? null, b.tags ? cleanTags(b.tags) : null, userOf(req)],
    );
    if (!t) throw notFound('Vorlage nicht gefunden.');
    await audit(actorOf(req), 'design_template.updated', { type: 'design_template', id, label: t.title }, { felder: Object.keys(b) });
    return { ok: true };
  });

  app.delete('/design-templates/:id', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const files = await many<any>(`SELECT id FROM design_template_files WHERE template_id = $1`, [id]);
    const t = await one<any>(`DELETE FROM design_templates WHERE id = $1 RETURNING title`, [id]);
    if (!t) throw notFound('Vorlage nicht gefunden.');
    for (const f of files) fs.rmSync(templatePaths.file(f.id), { force: true });
    fs.rmSync(templatePaths.preview(id), { force: true });
    await audit(actorOf(req), 'design_template.deleted', { type: 'design_template', id, label: t.title }, { dateien: files.length });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Versionen und Dateien */

  app.post('/design-templates/:id/versions', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    const v = await tx(async (db) => {
      const t = await one<any>(`SELECT id, title, current_version FROM design_templates WHERE id = $1 FOR UPDATE`, [id], db);
      if (!t) throw notFound('Vorlage nicht gefunden.');
      const n = t.current_version + 1;
      await db.query(`INSERT INTO design_template_versions (template_id, number, note, created_by) VALUES ($1,$2,$3,$4)`, [id, n, note, userOf(req)]);
      await db.query(`UPDATE design_templates SET current_version = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, n, userOf(req)]);
      return { number: n, title: t.title };
    });
    await audit(actorOf(req), 'design_template.version_created', { type: 'design_template', id, label: v.title }, { version: v.number });
    await refreshAutoPreview(id);
    return { number: v.number };
  });

  /* Datei in die aktuelle Version hochladen */
  app.post('/design-templates/:id/files', { preHandler: requireAuth('templates.manage'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await loadTemplate(id);
    const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2 } });
    if (!part) throw badRequest('Keine Datei empfangen.');
    const name = cleanFileName(part.filename);
    let stored;
    try {
      stored = await streamToTemp(part.file, MAX_FILE_BYTES);
    } catch (e) {
      if (e instanceof SizeLimitError) throw badRequest(`Die Datei ist zu groß (höchstens ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
      throw e;
    }
    try {
      const det = detectFormat(name, stored.head);
      if (!det.format) throw badRequest(det.error!);
      await malwareCheck(req, stored.tmpPath, name);
      let { size, sha256 } = stored;
      if (det.format.key === 'svg') {
        if (size > MAX_SVG_BYTES) throw badRequest(`SVG-Dateien dürfen höchstens ${MAX_SVG_BYTES / 1024 / 1024} MB groß sein.`);
        let clean: string;
        try {
          clean = sanitizeSvg(fs.readFileSync(stored.tmpPath, 'utf8'));
        } catch (e) {
          if (e instanceof SvgRejected) throw badRequest(e.message);
          throw e;
        }
        fs.writeFileSync(stored.tmpPath, clean, { mode: 0o600 });
        size = Buffer.byteLength(clean);
        sha256 = crypto.createHash('sha256').update(clean).digest('hex');
      }
      const fileId = crypto.randomUUID();
      await tx(async (db) => {
        const v = await one<any>(`SELECT v.id FROM design_template_versions v JOIN design_templates t ON t.id = v.template_id AND t.current_version = v.number WHERE t.id = $1 FOR UPDATE OF t`, [id], db);
        if (!v) throw notFound('Vorlage nicht gefunden.');
        const n = await one<any>(`SELECT count(*)::int AS n FROM design_template_files WHERE version_id = $1`, [v.id], db);
        if (n!.n >= MAX_FILES_PER_VERSION) throw conflict(`Höchstens ${MAX_FILES_PER_VERSION} Dateien je Version.`);
        await db.query(
          `INSERT INTO design_template_files (id, template_id, version_id, original_name, format, mime, size_bytes, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [fileId, id, v.id, name, det.format!.key, det.format!.mime, size, sha256, userOf(req)],
        );
        await db.query(`UPDATE design_templates SET updated_at = now(), updated_by = $2 WHERE id = $1`, [id, userOf(req)]);
        const target = templatePaths.file(fileId);
        ensureDir(target);
        moveFile(stored!.tmpPath, target);
      });
      await audit(actorOf(req), 'design_template.file_uploaded', { type: 'design_template', id, label: t.title }, { datei: name, format: det.format.key, bytes: size, version: t.current_version });
      await refreshAutoPreview(id);
      return { id: fileId, name, format: det.format.key, format_label: det.format.label, size_bytes: size };
    } finally {
      fs.rmSync(stored.tmpPath, { force: true });
    }
  });

  /* Datei der aktuellen Version entfernen (ältere Versionen bleiben unverändert) */
  app.delete('/design-templates/files/:fileId', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { fileId } = z.object({ fileId: z.uuid() }).parse(req.params);
    const f = await one<any>(
      `SELECT f.id, f.template_id, f.original_name, t.title, v.number, t.current_version FROM design_template_files f
         JOIN design_template_versions v ON v.id = f.version_id JOIN design_templates t ON t.id = f.template_id WHERE f.id = $1`,
      [fileId],
    );
    if (!f) throw notFound('Datei nicht gefunden.');
    if (f.number !== f.current_version) throw conflict('Dateien älterer Versionen bleiben unverändert erhalten.');
    await pool.query(`DELETE FROM design_template_files WHERE id = $1`, [fileId]);
    fs.rmSync(templatePaths.file(fileId), { force: true });
    await audit(actorOf(req), 'design_template.file_deleted', { type: 'design_template', id: f.template_id, label: f.title }, { datei: f.original_name, version: f.number });
    await refreshAutoPreview(f.template_id);
    return { ok: true };
  });

  /* Download (zählt mit) */
  app.get('/design-templates/files/:fileId', { preHandler: requireAuth('templates.view'), config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { fileId } = z.object({ fileId: z.uuid() }).parse(req.params);
    const f = await one<any>(`SELECT id, template_id, original_name, mime, format FROM design_template_files WHERE id = $1`, [fileId]);
    if (!f) throw notFound('Datei nicht gefunden.');
    if (!fs.existsSync(templatePaths.file(f.id))) throw notFound('Datei nicht vorhanden.');
    await pool.query(`UPDATE design_template_files SET download_count = download_count + 1 WHERE id = $1`, [fileId]);
    await pool.query(`UPDATE design_templates SET download_count = download_count + 1 WHERE id = $1`, [f.template_id]);
    // SVG nie als aktives Dokument im Kontext der Anwendung ausführen (zusätzlich zur Bereinigung beim Hochladen)
    if (f.format === 'svg') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return sendFileResponse(reply, templatePaths.file(f.id), f.mime, f.original_name);
  });

  /* ---------------------------------------------------------------- Vorschaubild */

  app.get('/design-templates/:id/preview', { preHandler: requireAuth('templates.view') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await one<any>(`SELECT id, preview FROM design_templates WHERE id = $1`, [id]);
    if (!t || t.preview === 'none') throw notFound('Kein Vorschaubild.');
    // Die Oberfläche hängt ?v=<preview_rev> an – jede Änderung bekommt eine neue Adresse
    return sendFileResponse(reply, templatePaths.preview(id), 'image/webp', undefined, { immutable: true });
  });

  app.post('/design-templates/:id/preview', { preHandler: requireAuth('templates.manage'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await loadTemplate(id);
    const part = await req.file({ limits: { fileSize: MAX_PREVIEW_BYTES, files: 1, fields: 2 } });
    if (!part) throw badRequest('Keine Datei empfangen.');
    let stored;
    try {
      stored = await streamToTemp(part.file, MAX_PREVIEW_BYTES);
    } catch (e) {
      if (e instanceof SizeLimitError) throw badRequest('Das Bild ist zu groß (höchstens 15 MB).');
      throw e;
    }
    try {
      const det = detectFormat(cleanFileName(part.filename), stored.head);
      if (!det.format || !['png', 'jpeg', 'webp'].includes(det.format.key)) throw badRequest('Als Vorschaubild gehen JPEG-, PNG- und WebP-Bilder.');
      await malwareCheck(req, stored.tmpPath, part.filename);
      try {
        await renderPreview(stored.tmpPath, templatePaths.preview(id));
      } catch {
        throw badRequest('Die Datei ist kein gültiges Bild oder zu groß.');
      }
      await pool.query(`UPDATE design_templates SET preview = 'upload', preview_rev = preview_rev + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, userOf(req)]);
      await audit(actorOf(req), 'design_template.preview_uploaded', { type: 'design_template', id, label: t.title });
      return { ok: true };
    } finally {
      fs.rmSync(stored.tmpPath, { force: true });
    }
  });

  /* Eigenes Vorschaubild entfernen → wieder automatisch aus den Dateien */
  app.delete('/design-templates/:id/preview', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await loadTemplate(id);
    await pool.query(`UPDATE design_templates SET preview = 'none', preview_rev = preview_rev + 1 WHERE id = $1`, [id]);
    fs.rmSync(templatePaths.preview(id), { force: true });
    await refreshAutoPreview(id);
    await audit(actorOf(req), 'design_template.preview_reset', { type: 'design_template', id, label: t.title });
    return { ok: true };
  });
}
