import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { many, one, pool } from '../db/pool.js';
import { config } from '../config.js';
import { mediaPaths } from './storage.js';

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
      name = `${name.replace(/\.[^.]+$/, '')}.${ext}`;
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
  await pool.query(`UPDATE exports SET status = 'ready', file_count = $2, size_bytes = $3, finished_at = now() WHERE id = $1`, [id, count, fs.statSync(exportPath(id)).size]);
}

export async function cleanupExports() {
  const rows = await many<any>(`UPDATE exports SET status = 'expired' WHERE expires_at < now() AND status <> 'expired' RETURNING id`);
  for (const r of rows) {
    fs.rmSync(exportPath(r.id), { force: true });
    fs.rmSync(exportPath(r.id) + '.part', { force: true });
  }
}
