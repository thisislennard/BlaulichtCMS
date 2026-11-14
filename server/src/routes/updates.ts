import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many } from '../db/pool.js';
import { requirePlatformAdmin } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { storeSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { checkForUpdate, downloadRelease, fetchLatestRelease, updateConfig } from '../updates/github.js';
import { installUpdate, updateBusy } from '../updates/installer.js';
import { compareVersions, readPointer } from '../updates/releases.js';
import { publicKeyStatus } from '../updates/signing.js';

const SETTINGS_OWNER = '00000000-0000-0000-0000-000000000001';

export async function updateRoutes(app: FastifyInstance) {
  app.get('/updates', { preHandler: requirePlatformAdmin() }, async () => {
    const s = await getSettings(true);
    const latest = s['updates.latest'] as any;
    let repo = '';
    try {
      repo = (await updateConfig()).repo;
    } catch {
      repo = s['updates.repo'];
    }
    return {
      current: config.version,
      imageVersion: process.env.LIFELINK_IMAGE_VERSION ?? config.version,
      runningFrom: readPointer(config.dataDir)?.version === config.version ? 'update' : 'image',
      supervised: typeof process.send === 'function',
      latest,
      available: !!latest?.version && compareVersions(latest.version, config.version) > 0,
      lastCheckAt: s['updates.last_check_at'],
      lastCheckError: s['updates.last_check_error'],
      settings: { enabled: s['updates.enabled'], repo, checkHours: s['updates.check_hours'], tokenSet: !!s['updates.token_secret_id'] },
      signingKey: publicKeyStatus(),
      busy: updateBusy(),
      history: await many<any>(`SELECT h.*, u.name AS actor_name FROM update_history h LEFT JOIN users u ON u.id = h.actor_id ORDER BY h.id DESC LIMIT 30`),
    };
  });

  app.patch('/updates/settings', { preHandler: requirePlatformAdmin() }, async (req) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        repo: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'Format: besitzer/name').optional(),
        checkHours: z.number().int().min(1).max(168).optional(),
        token: z.string().max(300).optional(),
        clearToken: z.boolean().optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch['updates.enabled'] = body.enabled;
    if (body.repo !== undefined) patch['updates.repo'] = body.repo;
    if (body.checkHours !== undefined) patch['updates.check_hours'] = body.checkHours;
    if (body.clearToken) patch['updates.token_secret_id'] = '';
    if (body.token) {
      const meta = await storeSecret('setting', SETTINGS_OWNER, body.token.trim(), req.auth!.user?.id ?? null);
      patch['updates.token_secret_id'] = meta.id;
    }
    await setSettings(patch as any, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'updates.settings_changed', { type: 'settings' }, { felder: Object.keys(patch).map((k) => (k === 'updates.token_secret_id' ? 'token' : k)) });
    return { ok: true };
  });

  app.post('/updates/check', { preHandler: requirePlatformAdmin() }, async () => checkForUpdate());

  app.post('/updates/install-latest', { preHandler: requirePlatformAdmin() }, async (req) => {
    const info = await fetchLatestRelease();
    if (!info) throw badRequest('Im Repository gibt es noch kein Release.');
    if (compareVersions(info.version, config.version) <= 0) throw badRequest('Es ist bereits die neueste Version installiert.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-update-'));
    try {
      const dl = await downloadRelease(info, dir);
      const res = await installUpdate(dl.zipFile, { sha256Expected: dl.sha, signature: dl.sig, source: 'github', actorId: req.auth!.user?.id ?? null });
      await audit(req.auth!.actor, 'update.install', { type: 'update', label: res.version }, { quelle: 'github', sha256: res.sha256, signatur: 'ok', release: info.tag });
      return res;
    } catch (e) {
      await audit(req.auth!.actor, 'update.install', { type: 'update', label: info.version }, { quelle: 'github', fehler: (e as Error).message.slice(0, 500) }, 'failed');
      throw badRequest((e as Error).message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  app.post('/updates/upload', { preHandler: requirePlatformAdmin() }, async (req) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-upload-'));
    let zipFile: string | null = null;
    let signature: Buffer | null = null;
    let sha: string | null = null;
    let fileName = '';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'zip') {
            if (!/\.zip$/i.test(part.filename)) throw badRequest('Bitte die ZIP-Datei des Updates wählen.');
            fileName = part.filename;
            zipFile = path.join(dir, 'update.zip');
            await fs.promises.writeFile(zipFile, await part.toBuffer());
          } else if (part.fieldname === 'sig') {
            signature = await part.toBuffer();
          } else await part.toBuffer();
        } else if (part.fieldname === 'sha256') {
          sha = String(part.value ?? '').trim() || null;
        }
      }
      if (!zipFile) throw badRequest('ZIP-Datei fehlt.');
      if (!signature) throw badRequest('Signaturdatei (.sig) fehlt. Unsignierte Updates werden abgelehnt.');
      const res = await installUpdate(zipFile, { sha256Expected: sha, signature, source: 'upload', actorId: req.auth!.user?.id ?? null });
      await audit(req.auth!.actor, 'update.install', { type: 'update', label: res.version }, { quelle: 'upload', datei: fileName, sha256: res.sha256, signatur: 'ok' });
      return res;
    } catch (e) {
      await audit(req.auth!.actor, 'update.install', { type: 'update', label: fileName || 'upload' }, { quelle: 'upload', fehler: (e as Error).message.slice(0, 500) }, 'failed');
      throw badRequest((e as Error).message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
