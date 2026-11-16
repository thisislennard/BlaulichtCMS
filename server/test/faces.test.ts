import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeYunet, detectionScales, inputTensor, iou, nms, type FaceHit } from '../src/media/face-runner.js';
import { detectFaces, expandFace, mergeProposals, openProposals, stopFaceRunner, type FaceProposal } from '../src/media/faces.js';

/**
 * Gesichtsvorschläge (#214): Vor- und Nachbereitung von YuNet ohne Modell, das echte Modell auf gemeinfreien Testbildern
 * (test/fixtures/faces, Quellen in QUELLEN.txt) und der Ablauf Upload → Suche → Übernehmen/Verwerfen → Freigabe gegen
 * eine echte PostgreSQL-Datenbank. Kein Netzwerk.
 */
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'faces');
const fixture = (name: string) => path.join(FIX, name);
const LIMIT = 40_000_000;

afterAll(() => stopFaceRunner());

describe('YuNet: Vor- und Nachbereitung', () => {
  it('wandelt RGB in BGR (CHW) und füllt auf ein Vielfaches von 32 auf', () => {
    // 2×1 Bildpunkte, RGB: (10,20,30) (40,50,60)
    const t = inputTensor(Uint8Array.from([10, 20, 30, 40, 50, 60]), 2, 1, 3);
    expect([t.pw, t.ph]).toEqual([32, 32]);
    const plane = 32 * 32;
    expect([t.data[0], t.data[plane], t.data[2 * plane]]).toEqual([30, 20, 10]);
    expect([t.data[1], t.data[plane + 1], t.data[2 * plane + 1]]).toEqual([60, 50, 40]);
    expect(t.data[2]).toBe(0);
    expect(t.data[32]).toBe(0);
    // RGBA: Alpha wird übersprungen
    const a = inputTensor(Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1, 4);
    expect([a.data[1], a.data[plane + 1], a.data[2 * plane + 1]]).toEqual([6, 5, 4]);
    expect(inputTensor(new Uint8Array(33 * 3), 33, 1, 3).pw).toBe(64);
  });

  it('übersetzt die Ausgaben je Schrittweite wie cv::FaceDetectorYN', () => {
    // 32×32 Eingabe: Schrittweite 8 → 4×4 Anker, 16 → 2×2, 32 → 1×1
    const out: Record<string, { data: Float32Array }> = {};
    for (const s of [8, 16, 32]) {
      const n = (32 / s) ** 2;
      out[`cls_${s}`] = { data: new Float32Array(n) };
      out[`obj_${s}`] = { data: new Float32Array(n) };
      out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
      out[`kps_${s}`] = { data: new Float32Array(n * 10) };
    }
    // Anker Zeile 1, Spalte 2 bei Schrittweite 8: Konfidenz √(0,81·1) = 0,9
    const i = 1 * 4 + 2;
    out.cls_8.data[i] = 0.81;
    out.obj_8.data[i] = 1.4; // wird auf 1 begrenzt
    out.bbox_8.data.set([0.5, 0.5, Math.log(2), Math.log(3)], i * 4);
    // knapp unter der Schwelle (√0,35 ≈ 0,59)
    out.cls_16.data[0] = 0.35;
    out.obj_16.data[0] = 1;
    const hits = decodeYunet(out, 32, 32, 0.6);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(0.9, 5);
    // Mitte ((2 + 0,5)·8, (1 + 0,5)·8) = (20, 12), Größe 16 × 24
    expect(hits[0].x).toBeCloseTo(12, 5);
    expect(hits[0].y).toBeCloseTo(0, 5);
    expect(hits[0].w).toBeCloseTo(16, 5);
    expect(hits[0].h).toBeCloseTo(24, 5);
    expect(decodeYunet(out, 32, 32, 0.55)).toHaveLength(2);
    // Falsche Größe der Ausgabe (anderes Modell) fällt auf
    expect(() => decodeYunet(out, 64, 32, 0.6)).toThrow(/unerwartete Größe/);
    const { cls_32: _gone, ...missing } = out;
    expect(() => decodeYunet(missing, 32, 32, 0.6)).toThrow(/fehlt/);
  });

  it('NMS behält das stärkste Rechteck und verwirft eingeschlossene Teiltreffer', () => {
    const a: FaceHit = { x: 0, y: 0, w: 10, h: 10, score: 0.9 };
    const b: FaceHit = { x: 1, y: 1, w: 10, h: 10, score: 0.8 }; // IoU ≈ 0,68
    const c: FaceHit = { x: 30, y: 30, w: 10, h: 10, score: 0.7 };
    const inner: FaceHit = { x: 50, y: 50, w: 3, h: 3, score: 0.95 }; // kleiner Treffer (Auge) …
    const big: FaceHit = { x: 45, y: 45, w: 20, h: 20, score: 0.85 }; // … in einem großen Gesicht: IoU klein, aber eingeschlossen
    expect(iou(a, b)).toBeGreaterThan(0.6);
    expect(iou(a, c)).toBe(0);
    const kept = nms([b, c, a, big, inner]);
    expect(kept).toContainEqual(a);
    expect(kept).toContainEqual(c);
    expect(kept).not.toContainEqual(b);
    expect(kept).toContainEqual(big);
    expect(kept).not.toContainEqual(inner);
  });

  it('wählt die Maßstäbe nach der Bildgröße', () => {
    expect(detectionScales(6000)).toEqual([1920, 640, 320]);
    expect(detectionScales(1024)).toEqual([1024, 640, 320]);
    expect(detectionScales(800)).toEqual([800, 320]);
    expect(detectionScales(400)).toEqual([400]);
    expect(detectionScales(3000, 2560)).toEqual([2560, 640, 320]);
  });
});

describe('Vorschläge zusammenführen', () => {
  let n = 0;
  const id = () => (++n).toString(16).padStart(8, '0');

  it('erweitert um einen Rand und bleibt im Bild', () => {
    const e = expandFace({ x: 0.95, y: -0.01, w: 0.1, h: 0.2 });
    expect(e.x + e.w).toBeLessThanOrEqual(1.0001);
    expect(e.y).toBe(0);
    const m = expandFace({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    expect(m).toEqual({ x: 0.37, y: 0.37, w: 0.26, h: 0.26 });
  });

  it('ersetzt offene Vorschläge, behält Entscheidungen und schlägt Verworfenes nicht erneut vor', () => {
    const accepted: FaceProposal = { id: 'aaaaaaaa', x: 0.1, y: 0.1, w: 0.1, h: 0.1, score: 0.9, status: 'accepted' };
    const rejected: FaceProposal = { id: 'bbbbbbbb', x: 0.5, y: 0.5, w: 0.1, h: 0.1, score: 0.7, status: 'rejected' };
    const open: FaceProposal = { id: 'cccccccc', x: 0.8, y: 0.1, w: 0.1, h: 0.1, score: 0.8, status: 'open' };
    const found: FaceHit[] = [
      { x: 0.11, y: 0.11, w: 0.08, h: 0.08, score: 0.9 }, // = übernommen
      { x: 0.51, y: 0.51, w: 0.08, h: 0.08, score: 0.7 }, // = verworfen
      { x: 0.31, y: 0.71, w: 0.08, h: 0.08, score: 0.66 }, // liegt in einem Bereich, der schon unkenntlich ist
      { x: 0.81, y: 0.11, w: 0.08, h: 0.08, score: 0.8 }, // neu (ersetzt den offenen)
    ];
    const merged = mergeProposals([accepted, rejected, open], found, [{ x: 0.3, y: 0.7, w: 0.12, h: 0.12 }], id);
    expect(merged.map((p) => p.status)).toEqual(['accepted', 'rejected', 'open']);
    expect(merged[2].id).not.toBe('cccccccc');
    expect(merged[2]).toMatchObject({ score: 0.8, status: 'open' });
    expect(openProposals(merged)).toBe(1);
    // Obergrenze
    const many = Array.from({ length: 250 }, (_, i) => ({ x: (i % 25) / 25, y: Math.floor(i / 25) / 10, w: 0.01, h: 0.01, score: 0.9 }));
    expect(mergeProposals([], many, [], id)).toHaveLength(200);
  });
});

describe('YuNet auf Testbildern (gemeinfrei)', () => {
  const t = 0.6;
  it.each([
    ['apollo11-crew.jpg', 3],
    ['mercury-seven.jpg', 7],
    ['astronaut-groups-1-2.jpg', 16],
    ['fire-engine.jpg', 0],
  ])('%s: %i Gesichter', async (file, expected) => {
    const r = await detectFaces(fixture(file), { threshold: t, limitInputPixels: LIMIT });
    expect(r.faces).toHaveLength(expected);
    for (const f of r.faces) {
      expect(f.score).toBeGreaterThanOrEqual(t);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(1);
      expect(f.y + f.h).toBeLessThanOrEqual(1);
    }
  });

  it('findet ein formatfüllendes Gesicht (grober Maßstab) und beachtet die EXIF-Drehung', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
    try {
      // Nahaufnahme: mittleres Gesicht des Apollo-Bildes auf 1600 px vergrößert (Gesicht > 300 px im feinen Maßstab)
      const close = path.join(tmp, 'nah.jpg');
      await sharp(fixture('apollo11-crew.jpg')).extract({ left: 330, top: 90, width: 180, height: 180 }).resize(1600, 1600).jpeg().toFile(close);
      const c = await detectFaces(close, { threshold: t, limitInputPixels: LIMIT });
      expect(c.faces).toHaveLength(1);
      expect(c.faces[0].w).toBeGreaterThan(0.3);
      // Hochkant gespeichert (Orientation 6 = 90° im Uhrzeigersinn anzeigen): Koordinaten gelten für das gedrehte Bild
      const rotated = path.join(tmp, 'gedreht.jpg');
      await sharp(fixture('apollo11-crew.jpg')).rotate(-90).withMetadata({ orientation: 6 }).jpeg().toFile(rotated);
      const plain = await detectFaces(fixture('apollo11-crew.jpg'), { threshold: t, limitInputPixels: LIMIT });
      const r = await detectFaces(rotated, { threshold: t, limitInputPixels: LIMIT });
      expect([r.width, r.height]).toEqual([plain.width, plain.height]);
      expect(r.faces).toHaveLength(3);
      const byX = (l: FaceHit[]) => [...l].sort((a, b) => a.x - b.x);
      for (const [a, b] of byX(plain.faces).map((f, i) => [f, byX(r.faces)[i]])) {
        expect(Math.abs(a.x - b.x)).toBeLessThan(0.02);
        expect(Math.abs(a.y - b.y)).toBeLessThan(0.02);
      }
      // Kaputte Datei: Fehler statt Absturz, der nächste Auftrag läuft wieder
      const broken = path.join(tmp, 'kaputt.jpg');
      fs.writeFileSync(broken, Buffer.concat([fs.readFileSync(fixture('fire-engine.jpg')).subarray(0, 2000)]));
      await expect(detectFaces(broken, { threshold: t, limitInputPixels: LIMIT })).rejects.toThrow();
      expect((await detectFaces(fixture('fire-engine.jpg'), { threshold: t, limitInputPixels: LIMIT })).faces).toHaveLength(0);
      // Bildgrenze (Dekompressionsbombe) greift auch hier
      await expect(detectFaces(fixture('mercury-seven.jpg'), { threshold: t, limitInputPixels: 100_000 })).rejects.toThrow(/pixel limit/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Zeitüberschreitung beendet nur den Kindprozess', async () => {
    await expect(detectFaces(fixture('astronaut-groups-1-2.jpg'), { threshold: t, limitInputPixels: LIMIT, timeoutMs: 1 })).rejects.toThrow(/Zeitüberschreitung/);
    expect((await detectFaces(fixture('apollo11-crew.jpg'), { threshold: t, limitInputPixels: LIMIT })).faces).toHaveLength(3);
  });
});

/* ------------------------------ Ablauf mit Datenbank ------------------------------ */

describe('Gesichtsvorschläge im Ablauf (Upload → Suche → Prüfung → Freigabe)', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db/pool.js');
  let settings: typeof import('../src/lib/settings.js');
  const PASSWORD = 'Langes-Passwort-2026';
  let ipCounter = 10;

  class Client {
    cookie = '';
    ip = `10.81.0.${ipCounter++}`;
    async raw(method: string, url: string, body?: unknown, extra: { payload?: Buffer; headers?: Record<string, string> } = {}) {
      const res = await app.inject({
        method: method as any,
        remoteAddress: this.ip,
        url: `/api/v1${url}`,
        payload: extra.payload ?? (body !== undefined ? JSON.stringify(body) : undefined),
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(extra.headers ?? {}),
          ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
      });
      const set = res.headers['set-cookie'];
      if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
      let json: any = null;
      try {
        json = res.json();
      } catch {
        json = res.body;
      }
      return { status: res.statusCode, json };
    }
    get = (u: string) => this.raw('GET', u);
    post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
    put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
    patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  }
  const login = async (email: string) => {
    const c = new Client();
    expect((await c.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
    return c;
  };
  let admin: Client;
  let approver: Client;
  let viewer: Client;
  let collectionId: string;

  /** Datei hochladen und prüfen lassen (wie der Worker) – liefert die Medien-ID. */
  async function upload(file: string, key: string): Promise<string> {
    const data = fs.readFileSync(fixture(file));
    const base = `/collections/${collectionId}/upload-sessions`;
    const s = await admin.post(base, { clientKey: key, name: file, size: data.length, type: 'image/jpeg' });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const done = await admin.raw('PUT', `${base}/${s.json.id}?offset=0`, undefined, { payload: data, headers: { 'content-type': 'application/octet-stream' } });
    const id = done.json.media.id as string;
    const { processMedia } = await import('../src/media/process.js');
    expect(await processMedia(id)).toBe('ready');
    return id;
  }

  beforeAll(async () => {
    db = await import('../src/db/pool.js');
    settings = await import('../src/lib/settings.js');
    const { migrate } = await import('../src/db/migrate.js');
    const { buildApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/auth/passwords.js');
    const { invalidateRoles } = await import('../src/auth/roles.js');
    const { ensureMediaDirs } = await import('../src/media/storage.js');
    const hash = await hashPassword(PASSWORD);
    await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    invalidateRoles();
    await migrate(() => {});
    ensureMediaDirs();
    app = await buildApp();
    await db.pool.query(
      `INSERT INTO users (email, name, password_hash, roles) VALUES ('admin@example.org','Alex Admin',$1,'{platform_admin}'), ('freigabe@example.org','Fritz Freigabe',$1,'{approver}'), ('lesen@example.org','Lea Lesen',$1,'{viewer}')`,
      [hash],
    );
    await settings.setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
    admin = await login('admin@example.org');
    approver = await login('freigabe@example.org');
    viewer = await login('lesen@example.org');
    collectionId = (await admin.post('/collections', { title: 'Gesichter (Test)', createLink: false })).json.collection.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.pool.end();
  });

  it('plant nach der Prüfung die Suche ein, speichert nur Vorschläge und ändert die öffentliche Fassung nicht', async () => {
    const { runFaceDetection } = await import('../src/media/faces.js');
    const id = await upload('apollo11-crew.jpg', 'faces-0001');
    const job = await db.one<any>(`SELECT kind, status, max_attempts FROM jobs WHERE dedup_key = $1`, [`media.faces:${id}`]);
    expect(job).toMatchObject({ kind: 'media.faces', status: 'queued', max_attempts: 1 });
    expect((await admin.get(`/media/${id}/details`)).json.media).toMatchObject({ face_status: 'queued', face_proposals: [] });
    const before = await db.one<any>(`SELECT public_rev, redactions FROM media WHERE id = $1`, [id]);
    const pub = fs.readFileSync((await import('../src/media/storage.js')).mediaPaths.publicFile(id, 'jpg'));
    expect(await runFaceDetection(id)).toBe('done');
    const m = (await admin.get(`/media/${id}/details`)).json.media;
    expect(m.face_status).toBe('done');
    expect(m.face_checked_at).toBeTruthy();
    expect(m.face_proposals).toHaveLength(3);
    for (const p of m.face_proposals) {
      expect(Object.keys(p).sort()).toEqual(['h', 'id', 'score', 'status', 'w', 'x', 'y']);
      expect(p.status).toBe('open');
    }
    expect(await db.one<any>(`SELECT face_model FROM media WHERE id = $1`, [id])).toMatchObject({ face_model: 'yunet-2026may' });
    // Nie automatisch angewendet
    expect(await db.one<any>(`SELECT public_rev, redactions FROM media WHERE id = $1`, [id])).toEqual(before);
    expect(fs.readFileSync((await import('../src/media/storage.js')).mediaPaths.publicFile(id, 'jpg')).equals(pub)).toBe(true);
  });

  it('Übernehmen und Verwerfen, erneute Suche behält Entscheidungen, Freigabe verlangt die Prüfung bei offenen Vorschlägen', async () => {
    const { runFaceDetection } = await import('../src/media/faces.js');
    const id = (await db.one<any>(`SELECT id FROM media WHERE client_key = 'faces-0001'`))!.id as string;
    const props: FaceProposal[] = (await admin.get(`/media/${id}/details`)).json.media.face_proposals;
    const [a, b] = props;
    // Ohne „Medien unkenntlich machen“ nicht erlaubt
    expect((await viewer.patch(`/media/${id}/privacy`, { proposals: [{ id: a.id, status: 'accepted' }] })).status).toBe(403);
    expect((await viewer.post(`/media/${id}/faces`)).status).toBe(403);
    // a übernehmen (Bereich kommt aus dem Vorschlag), b verwerfen, unbekannte ID wird ignoriert
    const r = await admin.patch(`/media/${id}/privacy`, {
      redactions: [{ x: a.x, y: a.y, w: a.w, h: a.h, mode: 'blur' }],
      proposals: [
        { id: a.id, status: 'accepted' },
        { id: b.id, status: 'rejected' },
        { id: 'deadbeef', status: 'rejected' },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.media.public_rev).toBe(1);
    expect(r.json.media.face_proposals.map((p: FaceProposal) => p.status)).toEqual(['accepted', 'rejected', 'open']);
    expect(r.json.media.redactions).toHaveLength(1);
    const au = await db.one<any>(`SELECT details FROM audit_events WHERE action = 'media.privacy' AND object_id = $1 ORDER BY at DESC LIMIT 1`, [id]);
    expect(au.details).toMatchObject({ gesichtsvorschlaege_uebernommen: 1, gesichtsvorschlaege_verworfen: 1 });
    expect((await admin.patch(`/media/${id}/privacy`, { proposals: [{ id: 'NICHT-HEX', status: 'accepted' }] })).status).toBe(400);
    // Erneut suchen: Entscheidungen bleiben, der offene Vorschlag kommt genau einmal wieder
    const again = await admin.post(`/media/${id}/faces`);
    expect(again.status).toBe(200);
    expect(again.json.media.face_status).toBe('queued');
    expect(await runFaceDetection(id)).toBe('done');
    const after: FaceProposal[] = (await admin.get(`/media/${id}/details`)).json.media.face_proposals;
    expect(after.map((p) => p.status).sort()).toEqual(['accepted', 'open', 'rejected']);
    expect(after.filter((p) => p.status !== 'open').map((p) => p.id).sort()).toEqual([a.id, b.id].sort());

    // Beitrag mit dem Bild: offener Vorschlag ⇒ Datenschutz-Prüfung Pflicht (wie bei Markierungen)
    const p = await admin.post('/posts', { title: 'Gesichtsvorschläge (fiktiv)' });
    let d = (await admin.get(`/posts/${p.json.id}`)).json;
    await admin.put(`/posts/${p.json.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Text', excerpt: '', mediaIds: [id] });
    d = (await admin.get(`/posts/${p.json.id}`)).json;
    expect(d.media[0]).toMatchObject({ face_status: 'done', faces_open: 1 });
    expect(d.media[0].sensitive_flags).toEqual([]);
    expect((await admin.post(`/posts/${p.json.id}/submit`, { revision: d.revision.number })).status).toBe(200);
    const dec = { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' };
    const no = await approver.post(`/posts/${p.json.id}/decision`, dec);
    expect(no.status).toBe(400);
    expect(no.json.error).toBe('privacy_check_required');
    expect(no.json.message).toMatch(/Gesichtsvorschlägen/);
    expect((await approver.post(`/posts/${p.json.id}/decision`, { ...dec, privacyChecked: true })).status).toBe(200);
    const ap = await db.one<any>(`SELECT details FROM audit_events WHERE action = 'post.approved' AND object_id = $1`, [p.json.id]);
    expect(ap.details).toMatchObject({ datenschutz_geprueft: true, markierte_medien: 0, bilder_mit_offenen_gesichtsvorschlaegen: 1 });
    // Entscheiden ohne neue öffentliche Fassung geht auch nach der Freigabe
    const open = after.find((x) => x.status === 'open')!;
    expect((await admin.patch(`/media/${id}/privacy`, { proposals: [{ id: open.id, status: 'rejected' }] })).status).toBe(200);
    expect(await db.one<any>(`SELECT 1 FROM media WHERE id = $1 AND jsonb_path_exists(face_proposals, '$[*] ? (@.status == "open")')`, [id])).toBeNull();
  });

  it('Einstellung aus: keine automatische Suche; Kopien übernehmen Vorschläge; Löschen entfernt sie mit der Datei', async () => {
    await settings.setSettings({ 'media.face_detect': false });
    try {
      const id = await upload('mercury-seven.jpg', 'faces-0002');
      expect(await db.one(`SELECT 1 FROM jobs WHERE dedup_key = $1`, [`media.faces:${id}`])).toBeNull();
      expect((await db.one<any>(`SELECT face_status FROM media WHERE id = $1`, [id]))!.face_status).toBeNull();
      // Von Hand geht es trotzdem
      expect((await admin.post(`/media/${id}/faces`)).status).toBe(200);
      const { runFaceDetection } = await import('../src/media/faces.js');
      expect(await runFaceDetection(id)).toBe('done');
      expect(openProposals((await db.one<any>(`SELECT face_proposals FROM media WHERE id = $1`, [id]))!.face_proposals)).toBe(7);
      // Kopie: Vorschläge und Entscheidungen kommen mit
      const copy = await admin.post('/media/copy', { ids: [id], collectionId, folderId: null });
      expect(copy.status, JSON.stringify(copy.json)).toBe(200);
      const cid = (await db.one<any>(`SELECT id FROM media WHERE duplicate_of = $1 ORDER BY created_at DESC LIMIT 1`, [id]))!.id;
      expect(openProposals((await db.one<any>(`SELECT face_proposals FROM media WHERE id = $1`, [cid]))!.face_proposals)).toBe(7);
      // Endgültig gelöscht: Zeile samt Vorschlägen weg
      const { removeMediaFiles } = await import('../src/media/storage.js');
      await db.pool.query(`DELETE FROM media WHERE id = $1`, [cid]);
      removeMediaFiles(cid);
      expect(await db.one(`SELECT 1 FROM media WHERE id = $1`, [cid])).toBeNull();
    } finally {
      await settings.setSettings({ 'media.face_detect': true });
    }
  });

  it('Suche fehlt oder scheitert: Stand am Medium, kein Absturz; nur Bilder', async () => {
    const { runFaceDetection } = await import('../src/media/faces.js');
    const { mediaPaths } = await import('../src/media/storage.js');
    const id = await upload('fire-engine.jpg', 'faces-0003');
    expect(await runFaceDetection(id)).toBe('done');
    expect((await db.one<any>(`SELECT face_proposals FROM media WHERE id = $1`, [id]))!.face_proposals).toEqual([]);
    // Original fehlt → failed mit Grund
    const orig = mediaPaths.original(id);
    fs.renameSync(orig, `${orig}.weg`);
    try {
      expect(await runFaceDetection(id)).toBe('failed');
      expect(await db.one<any>(`SELECT face_status, face_error FROM media WHERE id = $1`, [id])).toMatchObject({ face_status: 'failed', face_error: 'Original fehlt.' });
    } finally {
      fs.renameSync(`${orig}.weg`, orig);
    }
    // Kein Bild mit öffentlicher Fassung (z. B. HEIC/Video) → abgelehnt bzw. übersprungen
    await db.pool.query(`UPDATE media SET kind = 'video', face_status = 'queued' WHERE id = $1`, [id]);
    expect((await admin.post(`/media/${id}/faces`)).status).toBe(400);
    expect(await runFaceDetection(id)).toBe('skipped');
    expect((await db.one<any>(`SELECT face_status FROM media WHERE id = $1`, [id]))!.face_status).toBeNull();
    await db.pool.query(`UPDATE media SET kind = 'image' WHERE id = $1`, [id]);
  });
});
