import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { many, one, pool, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { mediaPaths } from './storage.js';
import { publicFileName } from './names.js';
import { zipDir, type FolderNode } from './folders.js';

export const exportPath = (id: string) => path.join(config.mediaDir, 'exports', `${id}.zip`);

/**
 * CSV-Zelle gegen Formel-Injektion absichern (Tabellenprogramme führen „=“, „+“, „-“, „@“, Tab und Zeilenumbruch am
 * Anfang als Formel aus): solche Werte bekommen ein vorangestelltes Apostroph. Danach RFC-4180-Quoting.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return /[";\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const SEL_LABEL: Record<string, string> = { pending: 'offen', selected: 'ausgewählt', skipped: 'übersprungen', on_hold: 'zurückgestellt' };
const safeName = (x: string) => x.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '_';

/**
 * Erzeugt ein ZIP im Hintergrund (gestreamt, ohne Dateien in den Speicher zu laden). Bilder/Videos werden nicht erneut
 * komprimiert. Mit Ordnerstruktur (Pfad aus dem Ordnerbaum, bei sammlungsübergreifenden Exporten mit Sammlung davor)
 * und optional `metadaten.csv` (ohne Angaben zu Hochladenden bei der öffentlichen Fassung).
 */
export async function buildExport(id: string) {
  const ex = await one<any>(`UPDATE exports SET status = 'running' WHERE id = $1 AND status IN ('queued','running') RETURNING *`, [id]);
  if (!ex) return;
  const media = await many<any>(
    `SELECT m.*, c.title AS collection_title,
            (SELECT array_agg(t.name ORDER BY lower(t.name)) FROM media_tag_links tl JOIN media_tags t ON t.id = tl.tag_id WHERE tl.media_id = m.id) AS tags
       FROM media m JOIN collections c ON c.id = m.collection_id
      WHERE m.id = ANY($1) AND m.status = 'ready' AND m.deleted_at IS NULL ORDER BY c.title, m.sort_order, m.created_at`,
    [ex.media_ids],
  );
  const collectionIds = [...new Set(media.map((m) => m.collection_id))];
  const folders = await many<FolderNode & { collection_id: string }>(`SELECT id, parent_id, name, collection_id FROM collection_folders WHERE collection_id = ANY($1::uuid[])`, [collectionIds]);
  const crossCollection = !ex.collection_id || collectionIds.length > 1;
  const dirOf = (m: any) => (ex.with_folders ? zipDir(folders.filter((f) => f.collection_id === m.collection_id), m.folder_id) : '');
  fs.mkdirSync(path.dirname(exportPath(id)), { recursive: true, mode: 0o700 });
  const tmp = exportPath(id) + '.part';
  const zip = new yazl.ZipFile();
  const used = new Set<string>();
  const rows: string[][] = [];
  let count = 0;
  for (const m of media) {
    let file: string;
    let name = safeName(m.original_name);
    if (ex.variant === 'public') {
      if (!m.has_public) continue;
      const ext = m.kind === 'image' ? 'jpg' : m.mime === 'video/webm' ? 'webm' : 'mp4';
      file = mediaPaths.publicFile(m.id, ext);
      // Neutraler Name statt des Originalnamens (kann Namen/Ort enthalten) – nur Originale behalten ihn (#137)
      name = publicFileName(m.id, ext, { index: count + 1 });
    } else file = mediaPaths.original(m.id);
    if (!fs.existsSync(file)) continue;
    const dir = (crossCollection ? `${safeName(m.collection_title)}/` : '') + dirOf(m);
    let unique = dir + name;
    for (let i = 2; used.has(unique.toLowerCase()); i++) unique = dir + name.replace(/(\.[^.]+)?$/, `-${i}$1`);
    used.add(unique.toLowerCase());
    zip.addFile(file, unique, { compress: false });
    count++;
    if (ex.with_csv) {
      const folder = zipDir(folders.filter((f) => f.collection_id === m.collection_id), m.folder_id).replace(/\/$/, '');
      const base = [
        unique,
        m.display_name,
        m.description,
        (m.tags ?? []).join(', '),
        m.collection_title,
        folder,
        new Date(m.created_at).toISOString(),
        m.taken_at ? new Date(m.taken_at).toISOString() : '',
        m.kind,
        m.width && m.height ? `${m.width}x${m.height}` : '',
        String(m.size_bytes),
        m.sha256,
        SEL_LABEL[m.selection] ?? m.selection,
        (m.sensitive_flags ?? []).join(', '),
      ];
      // Angaben zu Hochladenden (Originalname, Hinweis, Vorgangsnummer) nur beim internen Export der Originale
      rows.push(ex.variant === 'original' ? [...base, m.original_name, m.uploader_note, m.upload_ref ?? '', m.uploader?.name ?? '', m.uploader?.email ?? '', m.uploader?.place ?? '', m.uploader?.date ?? ''] : base);
    }
  }
  if (ex.with_csv) {
    const head = ['datei', 'anzeigename', 'beschreibung', 'schlagworte', 'sammlung', 'ordner', 'eingang', 'aufnahmezeit', 'art', 'aufloesung', 'groesse_bytes', 'sha256', 'sichtung', 'markierungen'];
    if (ex.variant === 'original') head.push('originalname', 'hinweis', 'vorgangsnummer', 'name', 'email', 'aufnahmeort', 'aufnahmedatum');
    // UTF-8 mit BOM, Semikolon als Trenner (deutsche Tabellenprogramme)
    const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
    zip.addBuffer(Buffer.from(csv, 'utf8'), 'metadaten.csv');
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
