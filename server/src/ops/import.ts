import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { one, pool, tx } from '../db/pool.js';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';
import { enqueue } from '../jobs/queue.js';
import { mediaPaths, ensureMediaDirs } from '../media/storage.js';
import { createUploadLink } from '../routes/media.js';

/**
 * Einmaliger Medienimport über ein dokumentiertes Austauschformat (docs/import.md).
 *
 * Das tatsächliche LiFeOS-Exportformat liegt noch nicht vor. Ein kleiner Umsetzer erzeugt daraus später dieses
 * Format; BlaulichtCMS prüft und übernimmt es dann unabhängig von der Quelle:
 *   1. Probelauf (Inventar): Dateien vorhanden, Größen und SHA-256 stimmen, Mengen je Sammlung – ohne zu schreiben
 *   2. Übernahme: Sammlungen, Originale (über die normale Quarantäne-Prüfung), Auswahlstatus, Fristen
 *   3. Noch gültige Altlinks: neuer BlaulichtCMS-Link mit gleicher Frist + befristete Weiterleitung vom alten Token
 * Wiederholte Läufe legen nichts doppelt an (Zuordnung über die Referenzen der Quelle).
 */
/**
 * Datum im ISO-Format (Datum oder Datum mit Uhrzeit) – ungültige Werte wie „2026-13-01“ oder „2026-02-31“ meldet
 * schon der Probelauf (#154), statt dass die Übernahme mittendrin mit einem Datenbankfehler abbricht.
 */
export function isValidIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const isoDate = z.string().max(40).refine(isValidIsoDate, { message: 'Ungültiges Datum (erwartet ISO 8601, z. B. 2026-11-14T10:00:00Z)' });

const mediaItem = z.object({
  ref: z.string().min(1).max(200),
  file: z.string().min(1).max(500),
  original_name: z.string().min(1).max(300),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  selection: z.enum(['pending', 'selected', 'skipped']).default('pending'),
  uploaded_at: isoDate.optional(),
  note: z.string().max(500).optional(),
});
const linkItem = z.object({
  ref: z.string().min(1).max(200),
  /** Klartext-Token des Altlinks (nur für die Weiterleitung; wird nur als Prüfsumme gespeichert) */
  token: z.string().min(8).max(200).optional(),
  /** Alternativ nur die SHA-256-Prüfsumme des Tokens (Hex), wenn das Altsystem den Klartext nicht kennt (LiFeOS) */
  token_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  expires_at: isoDate,
  revoked: z.boolean().default(false),
  label: z.string().max(200).default(''),
});
export const manifestSchema = z.object({
  format: z.literal('blaulichtcms-import/1'),
  source: z.string().min(1).max(50),
  exported_at: isoDate.optional(),
  collections: z
    .array(
      z.object({
        ref: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        purpose: z.string().max(200).default(''),
        note: z.string().max(2000).default(''),
        created_at: isoDate.optional(),
        media: z.array(mediaItem).max(20_000),
        links: z.array(linkItem).max(100).default([]),
      }),
    )
    .max(5_000),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface ImportReport {
  source: string;
  collections: number;
  media: number;
  bytes: number;
  /** capped: noch gültige Altlinks, deren Frist über der Höchstdauer neuer Links (90 Tage) liegt und gekürzt wird */
  links: { total: number; stillValid: number; expiredOrRevoked: number; capped: number };
  problems: string[];
  created?: { collections: number; media: number; links: number; skippedExisting: number };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Datei innerhalb des Importordners auflösen (keine Pfade nach außen). */
function resolveIn(dir: string, rel: string): string | null {
  const p = path.resolve(dir, rel);
  return p.startsWith(path.resolve(dir) + path.sep) ? p : null;
}

/** Höchstdauer neuer Upload-Links (wie createUploadLink). */
const MAX_LINK_DAYS = 90;

export async function readManifest(dir: string) {
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const parsed = manifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Manifest ungültig (${parsed.error.issues.length} Problem(e)) – keine Übernahme. ${first.join('; ')}`);
  }
  return { manifest: parsed.data, sha: sha256Hex(raw) };
}

/** Probelauf: prüft alles, schreibt nichts außer dem Protokolleintrag. */
export async function inventory(dir: string): Promise<{ report: ImportReport; manifest: Manifest; sha: string }> {
  const { manifest, sha } = await readManifest(dir);
  const problems: string[] = [];
  let media = 0;
  let bytes = 0;
  const now = Date.now();
  const links = { total: 0, stillValid: 0, expiredOrRevoked: 0, capped: 0 };
  const refs = new Set<string>();
  for (const c of manifest.collections) {
    if (refs.has(`c:${c.ref}`)) problems.push(`Sammlung „${c.ref}“ doppelt im Manifest.`);
    refs.add(`c:${c.ref}`);
    for (const m of c.media) {
      media++;
      bytes += m.size;
      if (refs.has(`m:${c.ref}:${m.ref}`)) problems.push(`Datei „${m.ref}“ in „${c.ref}“ doppelt.`);
      refs.add(`m:${c.ref}:${m.ref}`);
      const f = resolveIn(dir, m.file);
      if (!f) {
        problems.push(`„${m.file}“ liegt außerhalb des Importordners.`);
        continue;
      }
      if (!fs.existsSync(f)) {
        problems.push(`Datei fehlt: ${m.file}`);
        continue;
      }
      const size = fs.statSync(f).size;
      if (size !== m.size) problems.push(`Größe weicht ab: ${m.file} (${size} statt ${m.size} Byte)`);
      else if ((await sha256File(f)) !== m.sha256) problems.push(`Prüfsumme weicht ab: ${m.file}`);
    }
    for (const l of c.links) {
      links.total++;
      if (!l.revoked && new Date(l.expires_at).getTime() > now) {
        links.stillValid++;
        if (new Date(l.expires_at).getTime() > now + MAX_LINK_DAYS * 86400_000) links.capped++;
      } else links.expiredOrRevoked++;
    }
  }
  const report: ImportReport = { source: manifest.source, collections: manifest.collections.length, media, bytes, links, problems };
  await pool.query(`INSERT INTO import_runs (source, manifest_sha256, mode, status, report) VALUES ($1,$2,'dry_run',$3,$4)`, [manifest.source, sha, problems.length ? 'failed' : 'ok', JSON.stringify(report)]);
  return { report, manifest, sha };
}

/** Übernahme – nur nach fehlerfreiem Probelauf. */
export async function commitImport(dir: string, opts: { legacyDays?: number } = {}): Promise<ImportReport> {
  const { report, manifest, sha } = await inventory(dir);
  if (report.problems.length) throw new Error(`Probelauf mit ${report.problems.length} Problem(en) – keine Übernahme. Erstes: ${report.problems[0]}`);
  ensureMediaDirs();
  const actor = { ...SYSTEM_ACTOR, name: `Import (${manifest.source})` };
  const created = { collections: 0, media: 0, links: 0, skippedExisting: 0 };
  const run = await one<any>(`INSERT INTO import_runs (source, manifest_sha256, mode, status, report) VALUES ($1,$2,'commit','ok','{}') RETURNING id`, [manifest.source, sha]);
  for (const c of manifest.collections) {
    const marker = `[import:${manifest.source}:${c.ref}]`;
    // Marker als exakte Teilzeichenkette suchen (#177): bei LIKE wären „_“ und „%“ in der Referenz Platzhalter
    let col = await one<any>(`SELECT id FROM collections WHERE strpos(note, $1) > 0 ORDER BY created_at LIMIT 1`, [marker]);
    if (!col) {
      col = await one<any>(`INSERT INTO collections (title, purpose, note, max_files, max_bytes, created_at) VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now())) RETURNING id`, [
        c.title,
        c.purpose,
        `${c.note}\n${marker}`.trim(),
        Math.max(500, c.media.length + 100),
        Math.max(10 * 1024 ** 3, c.media.reduce((n, m) => n + m.size, 0) * 2),
        c.created_at ?? null,
      ]);
      created.collections++;
    }
    let sort = 0;
    for (const m of c.media) {
      sort++;
      const clientKey = `import:${manifest.source}:${m.ref}`.slice(0, 200);
      const row = await tx(async (db) => {
        const r = await one<any>(
          `INSERT INTO media (collection_id, client_key, original_name, declared_type, size_bytes, sha256, uploader_note, selection, sort_order, created_at)
           VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))
           ON CONFLICT (collection_id, client_key) WHERE client_key IS NOT NULL AND deleted_at IS NULL DO NOTHING RETURNING id`,
          [col.id, clientKey, m.original_name, m.size, m.sha256, m.note ?? '', m.selection, sort, m.uploaded_at ?? null],
          db,
        );
        if (!r) return null;
        // Original in die Quarantäne kopieren – die normale Prüfung (Typ, Dekodierung, Fassungen ohne Standort) läuft danach
        fs.copyFileSync(resolveIn(dir, m.file)!, mediaPaths.quarantine(r.id));
        await enqueue('media.process', { mediaId: r.id }, { dedupKey: `media.process:${r.id}` }, db);
        return r;
      });
      if (row) created.media++;
      else created.skippedExisting++;
    }
    for (const l of c.links) {
      const oldHash = l.token ? sha256Hex(l.token) : l.token_sha256;
      if (l.revoked || new Date(l.expires_at).getTime() <= Date.now() || !oldHash) continue;
      if (await one(`SELECT 1 FROM legacy_links WHERE old_token_hash = $1`, [oldHash])) continue;
      const days = Math.max(1, Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400_000));
      const nl = await createUploadLink(actor, null, col.id, { days, label: l.label || `Übernommen aus ${manifest.source}` });
      // Gleiche Frist wie der Altlink, aber nie länger als die Höchstdauer neuer Links (#154): createUploadLink begrenzt
      // auf 90 Tage, hier nur auf die genaue Uhrzeit des Altlinks kürzen
      await pool.query(`UPDATE upload_links SET expires_at = LEAST(expires_at, $2::timestamptz) WHERE id = $1`, [nl.id, l.expires_at]);
      const fwdUntil = new Date(Math.min(new Date(l.expires_at).getTime(), Date.now() + (opts.legacyDays ?? 90) * 86400_000));
      await pool.query(`INSERT INTO legacy_links (old_token_hash, link_id, expires_at, run_id) VALUES ($1,$2,$3,$4)`, [oldHash, nl.id, fwdUntil, run!.id]);
      created.links++;
    }
  }
  const final = { ...report, created };
  await pool.query(`UPDATE import_runs SET report = $2 WHERE id = $1`, [run!.id, JSON.stringify(final)]);
  await audit(actor, 'import.committed', { type: 'import', id: run!.id, label: manifest.source }, created);
  return final;
}

/** Mengenabgleich nach der Übernahme (nach der Quarantäne-Prüfung aufrufen). */
export async function verifyImport(dir: string) {
  const { manifest } = await readManifest(dir);
  const out: { collection: string; expected: number; ready: number; rejected: number; checksumMismatch: number }[] = [];
  for (const c of manifest.collections) {
    const col = await one<any>(`SELECT id FROM collections WHERE strpos(note, $1) > 0 ORDER BY created_at LIMIT 1`, [`[import:${manifest.source}:${c.ref}]`]);
    const stats = col
      ? await one<any>(
          `SELECT count(*) FILTER (WHERE status = 'ready')::int AS ready, count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                  count(*) FILTER (WHERE sha256 <> ALL($2))::int AS mismatch FROM media WHERE collection_id = $1 AND client_key LIKE 'import:%' AND deleted_at IS NULL`,
          [col.id, c.media.map((m) => m.sha256)],
        )
      : { ready: 0, rejected: 0, mismatch: 0 };
    out.push({ collection: c.title, expected: c.media.length, ready: stats.ready, rejected: stats.rejected, checksumMismatch: stats.mismatch });
  }
  return { ok: out.every((o) => o.ready + o.rejected === o.expected && o.checksumMismatch === 0), collections: out };
}
