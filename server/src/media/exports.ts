import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { many, one, pool, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { mediaPaths } from './storage.js';
import { publicFileName } from './names.js';

export const exportPath = (id: string) => path.join(config.mediaDir, 'exports', `${id}.zip`);

/** Erzeugt ein ZIP im Hintergrund (gestreamt, ohne Dateien in den Speicher zu laden). Bilder/Videos werden nicht erneut komprimiert. */
export async function buildExport(id: string) {
  const ex = await one<any>(`UPDATE exports SET status = 'running' WHERE id = $1 AND status IN ('queued','running') RETURNING *`, [id]);
  if (!ex) return;
  const media = await many<any>(`SELECT * FROM media WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL ORDER BY sort_order, created_at`, [ex.media_ids]);
  fs.mkdirSync(path.dirname(exportPath(id)), { recursive: true, mode: 0o700 });
  const tmp = exportPath(id) + '.part';
  const zip = new yazl.ZipFile();
  const used = new Set<string>();
  let count = 0;
  for (const m of media) {
    let file: string;
    let name = m.original_name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    if (ex.variant === 'public') {
      if (!m.has_public) continue;
      const ext = m.kind === 'image' ? 'jpg' : m.mime === 'video/webm' ? 'webm' : 'mp4';
      file = mediaPaths.publicFile(m.id, ext);
      // Neutraler Name statt des Originalnamens (kann Namen/Ort enthalten) – nur Originale behalten ihn (#137)
      name = publicFileName(m.id, ext, { index: count + 1 });
    } else file = mediaPaths.original(m.id);
    if (!fs.existsSync(file)) continue;
    let unique = name;
    for (let i = 2; used.has(unique.toLowerCase()); i++) unique = name.replace(/(\.[^.]+)?$/, `-${i}$1`);
    used.add(unique.toLowerCase());
    zip.addFile(file, unique, { compress: false });
    count++;
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    zip.outputStream.pipe(out).on('close', () => resolve()).on('error', reject);
    zip.outputStream.on('error', reject);
  });
  fs.renameSync(tmp, exportPath(id));
  // Während des Packens Sammlung gelöscht (Kaskade) oder Datei per Datenschutzanfrage gelöscht (Status „expired“)?
  // Dann hat die Löschung ihre Dateien schon entfernt, bevor das ZIP existierte – also hier selbst entfernen (#163).
  const r = await pool.query(`UPDATE exports SET status = 'ready', file_count = $2, size_bytes = $3, finished_at = now() WHERE id = $1 AND status = 'running'`, [id, count, fs.statSync(exportPath(id)).size]);
  if (!r.rowCount) removeExportFiles(id);
}

export function removeExportFiles(id: string) {
  fs.rmSync(exportPath(id), { force: true });
  fs.rmSync(exportPath(id) + '.part', { force: true });
}

/**
 * Sammeldownloads, die eine der Dateien enthalten (würden), ungültig machen – beim endgültigen Löschen einzelner
 * Dateien (Datenschutzanfrage). Gibt die IDs zurück; die ZIP-Dateien entfernt der Aufrufer nach dem Commit mit
 * removeExportFiles. Ein laufender Auftrag erkennt den geänderten Status am Ende und verwirft sein ZIP selbst.
 */
export async function invalidateExportsFor(mediaIds: string[], db: Queryable = pool): Promise<string[]> {
  if (!mediaIds.length) return [];
  const rows = await many<{ id: string }>(
    `UPDATE exports SET status = 'expired', error = 'Enthaltene Datei wurde gelöscht.', expires_at = LEAST(expires_at, now())
      WHERE media_ids && $1::uuid[] AND status IN ('queued','running','ready') RETURNING id`,
    [mediaIds],
    db,
  );
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.query(`DELETE FROM jobs WHERE status = 'queued' AND payload->>'exportId' = ANY($1::text[])`, [ids]);
  return ids;
}

export async function cleanupExports() {
  const rows = await many<any>(`UPDATE exports SET status = 'expired' WHERE expires_at < now() AND status <> 'expired' RETURNING id`);
  for (const r of rows) removeExportFiles(r.id);
  // Verwaiste ZIP-Dateien ohne gültigen Datensatz (z. B. nach Abbruch zwischen Umbenennen und Prüfung), älter als 1 h (#163)
  const dir = path.dirname(exportPath('x'));
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.zip(\.part)?$/.test(f));
  if (!files.length) return;
  const ids = [...new Set(files.map((f) => f.slice(0, 36)))];
  const live = new Set((await many<{ id: string }>(`SELECT id FROM exports WHERE id = ANY($1::uuid[]) AND status IN ('queued','running','ready')`, [ids])).map((r) => r.id));
  for (const f of files) {
    if (live.has(f.slice(0, 36))) continue;
    const full = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 3600_000) fs.rmSync(full, { force: true });
    } catch {
      /* gleichzeitig entfernt */
    }
  }
}
