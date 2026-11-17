import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { many, one, pool } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { config } from '../config.js';
import { processMedia } from '../media/process.js';
import { SENSITIVE_FLAGS, type SensitiveFlag } from '../media/privacy.js';
import { privacyFindings } from '../lib/approval.js';
import { mediaPaths } from '../media/storage.js';
import { effectiveTypes } from '../media/types.js';
import { createCollection, finalizeUpload, mediaPayload, uploadAllowance } from '../routes/media.js';
import { bundledFonts, customFontPath, DEFAULT_FONT, type FontDef } from './fonts.js';
import { layoutSchema, type Layout } from './layout.js';
import { previewJpeg, renderTemplate, type ImageInput, type RenderResult } from './render.js';
import { ensureDir, templatePaths } from './files.js';

/*
 * Befüllbare Bildvorlagen (#209): Schriften, Bilder der Vorlage, Rendern mit Medien als Bildquelle und Ablage des
 * Ergebnisses in den Medien. Gemeinsam genutzt von der API (Editor, Ausfüllen, Beitragseditor) und von Workflows (#210).
 */

export const assetPath = (id: string, mime: string) => path.join(config.mediaDir, 'templates', 'assets', `${id}.${mime === 'image/png' ? 'png' : mime === 'image/svg+xml' ? 'svg' : 'jpg'}`);

/* ------------------------------------------------------------------ Schriften */

let fontCache: { at: number; map: Map<string, FontDef> } | null = null;

export function invalidateFonts() {
  fontCache = null;
}

/** Alle verfügbaren Schriften (mitgeliefert + hochgeladen); 30 s im Speicher, Änderungen leeren den Zwischenspeicher. */
export async function loadFonts(): Promise<Map<string, FontDef>> {
  if (fontCache && Date.now() - fontCache.at < 30_000) return fontCache.map;
  const map = new Map(bundledFonts().map((f) => [f.key, f]));
  for (const r of await many<any>(`SELECT id, family, subfamily, weight, italic, format, license FROM design_fonts ORDER BY lower(family), weight`)) {
    map.set(`custom:${r.id}`, {
      key: `custom:${r.id}`,
      label: `${r.family}${r.subfamily && !/^regular$/i.test(r.subfamily) ? ` ${r.subfamily}` : ''}`,
      family: r.family,
      weight: r.weight,
      italic: r.italic,
      file: customFontPath(r.id, r.format),
      bundled: false,
      license: r.license,
    });
  }
  fontCache = { at: Date.now(), map };
  return map;
}

/* ------------------------------------------------------------------ Layout prüfen */

/** Layout prüfen: Schema, bekannte Schriften und Bilder dieser Vorlage. */
export async function cleanLayout(templateId: string, raw: unknown): Promise<Layout> {
  const r = layoutSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw badRequest(`Layout ungültig: ${i.message}${i.path.length ? ` (${i.path.join('.')})` : ''}`);
  }
  const l = r.data;
  const fonts = await loadFonts();
  for (const e of l.elements) if (e.type === 'text' && !fonts.has(e.font)) throw badRequest(`„${e.label}“: Die Schrift gibt es nicht (mehr).`);
  const ids = [l.background.assetId, ...l.elements.map((e) => (e.type === 'logo' ? e.assetId : null))].filter((x): x is string => !!x);
  if (ids.length) {
    const known = new Set((await many<any>(`SELECT id FROM design_template_assets WHERE template_id = $1 AND id = ANY($2::uuid[])`, [templateId, ids])).map((x) => x.id));
    for (const id of ids) if (!known.has(id)) throw badRequest('Ein Bild der Vorlage gibt es nicht (mehr). Bitte neu hochladen.');
  }
  return l;
}

async function assetFiles(templateId: string): Promise<Record<string, string>> {
  const rows = await many<any>(`SELECT id, mime FROM design_template_assets WHERE template_id = $1`, [templateId]);
  return Object.fromEntries(rows.map((r) => [r.id, assetPath(r.id, r.mime)]));
}

/* ------------------------------------------------------------------ Bildquellen aus den Medien */

export interface ImageChoice {
  mediaId: string;
  focusX?: number;
  focusY?: number;
  zoom?: number;
}

/** Gewählte Medien → Dateien der öffentlichen Fassung (ohne Standort, mit Unkenntlichmachungen). */
export async function resolveImages(layout: Layout, choices: Record<string, ImageChoice | null | undefined>): Promise<Record<string, ImageInput>> {
  const out: Record<string, ImageInput> = {};
  const wanted = layout.elements.filter((e) => e.type === 'image' && choices[e.id]?.mediaId);
  if (!wanted.length) return out;
  const ids = wanted.map((e) => choices[e.id]!.mediaId);
  const rows = new Map((await many<any>(`SELECT id, kind, status, has_public, deleted_at FROM media WHERE id = ANY($1::uuid[])`, [ids])).map((r) => [r.id, r]));
  for (const e of wanted) {
    const c = choices[e.id]!;
    const m = rows.get(c.mediaId);
    if (!m || m.deleted_at || m.status !== 'ready' || m.kind !== 'image' || !m.has_public) throw badRequest(`„${e.label}“: Das gewählte Bild ist nicht (mehr) verfügbar.`);
    out[e.id] = { file: mediaPaths.publicFile(m.id, 'jpg'), focusX: c.focusX, focusY: c.focusY, zoom: c.zoom };
  }
  return out;
}

/**
 * Markierungen, die ein aus `sources` erzeugtes Bild erbt (#241): Vereinigung der Markierungen, dazu „Personen
 * erkennbar“, wenn ein Quellbild offene Gesichtsvorschläge hat (in der Reihenfolge der Markierungsliste).
 */
export async function inheritedFlags(sources: string[]): Promise<{ flags: SensitiveFlag[] }> {
  const f = await privacyFindings(sources);
  const set = new Set<string>(f.flags);
  if (f.faces > 0) set.add('persons');
  return { flags: SENSITIVE_FLAGS.filter((x) => set.has(x)) };
}

/** Bild einer Vorlage rendern. */
export async function renderFromTemplate(templateId: string, layout: Layout, values: Record<string, string>, images: Record<string, ImageInput>, placeholders: boolean): Promise<RenderResult> {
  const fonts = await loadFonts();
  return renderTemplate({ layout, values, images, assets: await assetFiles(templateId), fonts, fallbackFont: fonts.get(DEFAULT_FONT)!, placeholders });
}

/** Vorschaubild der Bibliothek aus dem Layout (Vorgabetexte, Platzhalter für Bilder). */
export async function refreshImagePreview(templateId: string) {
  const t = await one<any>(`SELECT id, layout, preview FROM design_templates WHERE id = $1 AND kind = 'image'`, [templateId]);
  if (!t?.layout || t.preview === 'upload') return;
  try {
    const r = await renderFromTemplate(templateId, layoutSchema.parse(t.layout), {}, {}, true);
    const target = templatePaths.preview(templateId);
    ensureDir(target);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, await sharp(r.png).resize({ width: 900, height: 900, fit: 'inside' }).webp({ quality: 80 }).toBuffer());
    fs.renameSync(tmp, target);
    await pool.query(`UPDATE design_templates SET preview = 'auto', preview_rev = preview_rev + 1 WHERE id = $1`, [templateId]);
  } catch (e) {
    log('warn', 'templates', `Vorschaubild der Bildvorlage konnte nicht erzeugt werden: ${(e as Error).message}`, { vorlage: templateId });
  }
}

/** Werte aus der Anfrage: nur Textfelder des Layouts, gekürzt auf die erlaubte Länge. */
export function cleanValues(layout: Layout, raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of layout.elements) if (e.type === 'text' && raw && typeof raw[e.id] === 'string') out[e.id] = String(raw[e.id]).slice(0, e.maxLength);
  return out;
}

export { previewJpeg };

/* ------------------------------------------------------------------ Ablage in den Medien */

export const SYSTEM_COLLECTION = 'design-templates';

/** Sammlung „Bilder aus Vorlagen“ (wird bei Bedarf angelegt; gelöschte/archivierte wird ersetzt). */
export async function systemCollection(actor: Actor, userId: string | null) {
  const c = await one<any>(`SELECT * FROM collections WHERE system_key = $1`, [SYSTEM_COLLECTION]);
  if (c && !c.deleted_at && !c.archived_at) return c;
  if (c) await pool.query(`UPDATE collections SET system_key = NULL WHERE id = $1`, [c.id]);
  const created = await createCollection(actor, userId, { title: 'Bilder aus Vorlagen', purpose: 'Aus Designvorlagen erzeugte Bilder' });
  const r = await one<any>(`UPDATE collections SET system_key = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM collections WHERE system_key = $2) RETURNING *`, [created.id, SYSTEM_COLLECTION]);
  return r ?? (await one<any>(`SELECT * FROM collections WHERE system_key = $1`, [SYSTEM_COLLECTION]));
}

/** Zielsammlung: ausdrücklich gewählt, sonst die erste Sammlung des Beitrags, sonst „Bilder aus Vorlagen“. */
export async function targetCollection(opts: { collectionId?: string | null; postId?: string | null; actor: Actor; userId: string | null }) {
  if (opts.collectionId) {
    const c = await one<any>(`SELECT * FROM collections WHERE id = $1`, [opts.collectionId]);
    if (!c || c.deleted_at) throw notFound('Sammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Sammlung ist archiviert.');
    return c;
  }
  if (opts.postId) {
    const c = await one<any>(`SELECT * FROM collections WHERE post_id = $1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [opts.postId]);
    if (c) return c;
  }
  return systemCollection(opts.actor, opts.userId);
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'bild';

export interface GenerateInput {
  templateId: string;
  values: Record<string, unknown>;
  images: Record<string, ImageChoice | null | undefined>;
  collectionId?: string | null;
  postId?: string | null;
  altText?: string;
  actor: Actor;
  userId: string | null;
  /** Herkunft für Notiz und Audit, z. B. „Workflow …“ */
  source?: string;
}

/** Bild in voller Größe erzeugen und als geprüfte, ausgewählte Datei in die Zielsammlung legen. */
export async function generateIntoMedia(g: GenerateInput) {
  const t = await one<any>(`SELECT id, title, kind, layout FROM design_templates WHERE id = $1`, [g.templateId]);
  if (!t) throw notFound('Vorlage nicht gefunden.');
  if (t.kind !== 'image' || !t.layout) throw badRequest('Diese Vorlage ist keine befüllbare Bildvorlage.');
  const layout = layoutSchema.parse(t.layout);
  for (const e of layout.elements) if (e.type === 'image' && e.required && !g.images[e.id]?.mediaId) throw badRequest(`Bitte für „${e.label}“ ein Bild wählen.`);
  const values = cleanValues(layout, g.values);
  const images = await resolveImages(layout, g.images);
  const r = await renderFromTemplate(t.id, layout, values, images, false);
  // Datenschutz (#241): Das neue Bild zeigt die öffentliche Fassung der Quellbilder (Unkenntlichmachungen bleiben) und
  // erbt deren Markierungen. Offene Gesichtsvorschläge sind ungeprüfte Gesichter – das neue Bild gilt dann als
  // „Personen erkennbar“. So verlangt jede Freigabe mit diesem Bild dieselbe Datenschutz-Prüfung wie das Quellbild.
  const sources = [...new Set(Object.keys(images).map((k) => g.images[k]!.mediaId))];
  const inherited = await inheritedFlags(sources);
  const collection = await targetCollection({ collectionId: g.collectionId, postId: g.postId, actor: g.actor, userId: g.userId });
  // PNG, solange erlaubt (scharfe Schrift); sonst JPEG
  const types = effectiveTypes((await getSettings())['media.allowed_types'], null);
  const asPng = types.includes('png');
  const data = asPng ? r.png : await sharp(r.png).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const s = await getSettings();
  const ctx = { collection, linkId: null, userId: g.userId, maxFileBytes: s['media.max_file_mb'] * 1024 * 1024, actor: g.actor, folderId: null };
  if (data.length > (await uploadAllowance(ctx))) throw new AppError(409, 'collection_full', 'Das Bild passt nicht mehr in die Sammlung (Grenze erreicht).');
  fs.mkdirSync(mediaPaths.tmp(), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(mediaPaths.tmp(), `vorlage-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `${slug(t.title)}-${stamp}.${asPng ? 'png' : 'jpg'}`;
  const res = await finalizeUpload({
    ...ctx,
    stored: { tmpPath, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') },
    name,
    declaredType: asPng ? 'image/png' : 'image/jpeg',
    note: `Aus der Designvorlage „${t.title}“ erzeugt${g.source ? ` (${g.source})` : ''}.${inherited.flags.length ? ' Markierungen der Quellbilder übernommen.' : ''}`,
    clientKey: null,
  });
  const mediaId = res.media.id as string;
  // Vor der Verarbeitung: Das Bild ist erst danach „bereit“ und damit wählbar – nie ohne die geerbten Markierungen
  if (sources.length) await pool.query(`UPDATE media SET sensitive_flags = $2, derived_from = $3 WHERE id = $1`, [mediaId, inherited.flags, sources]);
  // Gleich prüfen und verarbeiten, damit das Bild sofort im Beitrag nutzbar ist; sonst übernimmt der Worker
  try {
    await processMedia(mediaId);
  } catch (e) {
    log('warn', 'templates', `Erzeugtes Bild wird später verarbeitet: ${(e as Error).message}`, { media: mediaId });
  }
  const alt = String(g.altText ?? '').trim().slice(0, 1000);
  const row = await one<any>(
    `UPDATE media SET selection = 'selected', selection_by = $2, selection_at = now(), display_name = $3, alt_text = CASE WHEN $4 <> '' THEN $4 ELSE alt_text END WHERE id = $1 RETURNING *`,
    [mediaId, g.userId, t.title.slice(0, 200), alt],
  );
  await audit(g.actor, 'design_template.image_generated', { type: 'design_template', id: t.id, label: t.title }, { datei: mediaId, sammlung: collection.id, ...(g.source ? { quelle: g.source } : {}), ...(sources.length ? { quellbilder: sources.length } : {}), ...(inherited.flags.length ? { markierungen_uebernommen: inherited.flags } : {}) });
  return { media: mediaPayload(row), collection: { id: collection.id, title: collection.title }, texts: r.texts };
}
