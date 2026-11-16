import fs from 'node:fs';
import path from 'node:path';
import { many, one } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { config } from '../config.js';
import { renderTemplate, type Data } from '../automations/logic.js';
import { layoutSchema } from './layout.js';
import { cleanValues, generateIntoMedia, previewJpeg, renderFromTemplate, resolveImages } from './images.js';

/*
 * Workflow-Baustein „Bild aus Vorlage erzeugen“ (#210). Textfelder der Bildvorlage werden mit {{platzhaltern}} des Laufs
 * befüllt; das Bild landet geprüft in den Medien. Ein Beitrags-Ausgang danach übernimmt alle Bilder des Laufs (Feld
 * `bilder`) – damit auch soziale Kanäle und Storys des Beitrags. Testläufe erzeugen nur eine Vorschau, nichts in den Medien.
 */

export const runPreviewDir = () => path.join(config.mediaDir, 'templates', 'run-previews');
export const runPreviewPath = (runId: string, nodeId: string) => path.join(runPreviewDir(), `${runId}-${nodeId.replace(/[^A-Za-z0-9_-]/g, '')}.jpg`);

export class ImageStepError extends Error {}

export interface ImageStepResult {
  produced: Data;
  info: string;
  log: Record<string, unknown>;
}

export async function runImageStep(opts: { test: boolean; runId: string; nodeId: string; automationName: string; actor: Actor; tz: string }, nodeData: any, data: Data): Promise<ImageStepResult> {
  const t = await one<any>(`SELECT id, title, kind, layout FROM design_templates WHERE id = $1`, [nodeData.templateId]);
  if (!t || t.kind !== 'image' || !t.layout) throw new ImageStepError('Die Bildvorlage gibt es nicht (mehr) oder sie ist keine befüllbare Bildvorlage.');
  const layout = layoutSchema.parse(t.layout);
  const values: Record<string, string> = {};
  for (const [k, tpl] of Object.entries((nodeData.texts ?? {}) as Record<string, string>)) values[k] = renderTemplate(tpl, data, { timeZone: opts.tz, maxLength: 2000 }).text.trim();
  const clean = cleanValues(layout, values);
  const images = Object.fromEntries(Object.entries((nodeData.images ?? {}) as Record<string, string>).map(([k, mediaId]) => [k, { mediaId }]));
  const altText = renderTemplate(nodeData.altText ?? '', data, { timeZone: opts.tz, maxLength: 1000 }).text.trim() || Object.values(clean).filter(Boolean).join(' – ').slice(0, 1000);
  const log = { vorlage: t.title, texte: clean, alternativtext: altText };
  if (opts.test) {
    // Testlauf: Vorschau rendern und neben dem Lauf ablegen (nicht in den Medien, nach zwei Tagen gelöscht)
    const r = await renderFromTemplate(t.id, layout, clean, await resolveImages(layout, images), true);
    const dir = runPreviewDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86_400_000) fs.rmSync(p, { force: true });
    }
    fs.writeFileSync(runPreviewPath(opts.runId, opts.nodeId), await previewJpeg(r.png), { mode: 0o600 });
    const cut = Object.entries(r.texts).filter(([, v]) => v.truncated).map(([k]) => k);
    return {
      produced: { bild_id: '', bild_link: '/medien', bilder: String(data.bilder ?? '') },
      info: `Testlauf: würde ein Bild aus „${t.title}“ erzeugen und in den Medien ablegen (Vorschau beim Schritt).${cut.length ? ` Gekürzte Texte: ${cut.join(', ')}.` : ''}`,
      log: { ...log, vorschau: true, gekuerzt: cut },
    };
  }
  const g = await generateIntoMedia({ templateId: t.id, values: clean, images, collectionId: nodeData.collectionId ?? null, altText, actor: opts.actor, userId: null, source: `Workflow „${opts.automationName}“` });
  const bilder = [...String(data.bilder ?? '').split(',').filter(Boolean), g.media.id].join(',');
  return {
    produced: { bild_id: g.media.id, bild_link: `/medien/${g.collection.id}`, bilder },
    info: `Bild aus „${t.title}“ erzeugt und in „${g.collection.title}“ abgelegt.`,
    log: { ...log, bild: g.media.id, sammlung: g.collection.title },
  };
}

/** Bilder des Laufs (Feld `bilder`) für einen Beitrag: nur geprüfte, nicht gelöschte Bilder, Reihenfolge bleibt. */
export async function runImages(data: Data): Promise<{ ids: string[]; alt: Record<string, string> }> {
  const ids = [...new Set(String(data.bilder ?? '').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/.test(x)))].slice(0, 20);
  if (!ids.length) return { ids: [], alt: {} };
  const rows = await many<any>(`SELECT id, alt_text FROM media WHERE id = ANY($1::uuid[]) AND status = 'ready' AND kind = 'image' AND deleted_at IS NULL`, [ids]);
  const ok = new Map(rows.map((r) => [r.id, r.alt_text ?? '']));
  return { ids: ids.filter((x) => ok.has(x)), alt: Object.fromEntries(ids.filter((x) => ok.get(x)).map((x) => [x, ok.get(x)!])) };
}
