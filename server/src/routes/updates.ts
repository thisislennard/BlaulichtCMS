import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { assertRecentAuth, requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit, settingsDiff } from '../lib/audit.js';
import { AppError, badRequest } from '../lib/errors.js';
import { revokeSecret, storeSecret } from '../lib/secrets.js';
import { securityAlert } from '../lib/security-alerts.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { compareVersions } from '../updates/core.js';
import { checkForUpdate, imageUpdateNeeded, normalizeApiUrl, REPO_RE, UpdateSourceError } from '../updates/github.js';
import { imageInfo, installState, startInstall, supervised, updateHistory } from '../updates/installer.js';
import { readPointer } from '../updates/releases.js';
import { publicKeyStatus } from '../updates/signing.js';

/** Besitzer-ID für Geheimnisse aus Einstellungen (wie beim SMTP-Passwort). */
/** Installationsversuche je Minute (Tests spielen viele Fehlerfälle nacheinander durch). */
const INSTALL_RATE = process.env.NODE_ENV === 'test' ? 100 : 5;

const SETTINGS_OWNER = '00000000-0000-0000-0000-000000000002';

/**
 * In-App-Updates (Einstellungen → Updates). Lesen: „System lesen“; Einstellungen, Prüfen und Installieren:
 * „System verwalten“, Ändern und Installieren zusätzlich mit frischer Passwortbestätigung. Der Token verlässt den
 * Server nie – die Oberfläche erfährt nur, ob einer gespeichert ist.
 */
export async function updateRoutes(app: FastifyInstance) {
  app.get('/updates', { preHandler: requireAuth('update.view') }, async () => {
    const s = await getSettings(true);
    const latest = s['updates.latest'] as any;
    const image = await imageInfo();
    const pointer = readPointer(config.dataDir);
    const available = !!latest?.version && compareVersions(latest.version, config.version) > 0;
    return {
      current: config.version,
      image: { version: image.version, nodeMajor: image.nodeMajor, postgresMajor: image.postgresMajor, ffmpeg: image.ffmpeg },
      runningFrom: pointer?.version === config.version ? 'update' : 'image',
      supervised: supervised(),
      latest: latest ?? null,
      available,
      // Braucht das verfügbare Release ein neueres Image? Dann geht es nur über install.sh am Docker-Host.
      imageUpdate: available ? imageUpdateNeeded(latest, image.version) : null,
      lastCheckAt: s['updates.last_check_at'],
      lastCheckError: s['updates.last_check_error'],
      settings: {
        enabled: s['updates.enabled'],
        repo: s['updates.repo'],
        apiUrl: s['updates.api_url'],
        checkHours: s['updates.check_hours'],
        tokenSet: !!s['updates.token_secret_id'],
      },
      signingKey: publicKeyStatus(),
      state: installState(),
      history: await updateHistory(),
    };
  });

  app.get('/updates/status', { preHandler: requireAuth('update.view') }, async () => ({ current: config.version, state: installState() }));

  app.put('/updates/settings', { preHandler: requireAuth('update.install') }, async (req) => {
    const b = z
      .object({
        enabled: z.boolean(),
        repo: z.string().trim().regex(REPO_RE, 'Format: besitzer/name'),
        apiUrl: z.string().trim().min(1).max(300),
        checkHours: z.number().int().min(1).max(168),
        token: z.string().trim().max(500).optional(),
        clearToken: z.boolean().optional(),
      })
      .parse(req.body);
    let apiUrl: string;
    try {
      apiUrl = normalizeApiUrl(b.apiUrl);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (b.token && /\s/.test(b.token)) throw badRequest('Der Token darf keine Leerzeichen enthalten.');
    const s = await getSettings(true);
    const patch: Record<string, unknown> = { 'updates.enabled': b.enabled, 'updates.repo': b.repo, 'updates.api_url': apiUrl, 'updates.check_hours': b.checkHours };
    const oldHost = (() => {
      try {
        return new URL(s['updates.api_url']).host;
      } catch {
        return '';
      }
    })();
    const hostChanged = oldHost !== new URL(apiUrl).host;
    const oldToken = s['updates.token_secret_id'];
    // Neuer API-Host: der bisherige Token geht nicht an einen anderen Server – er muss neu eingegeben werden
    const dropToken = !!oldToken && (b.clearToken || hostChanged || !!b.token);
    const changes = settingsDiff(s as any, patch);
    const tokenChange = b.token ? 'neu gesetzt' : dropToken ? (hostChanged && !b.clearToken ? 'entfernt (API-Host geändert)' : 'entfernt') : null;
    if (!Object.keys(changes).length && !tokenChange) return { ok: true, tokenSet: !!oldToken, tokenCleared: false };
    assertRecentAuth(req);
    if (b.token) {
      const meta = await storeSecret('setting', SETTINGS_OWNER, b.token, req.auth!.user?.id ?? null);
      patch['updates.token_secret_id'] = meta.id;
    } else if (dropToken) patch['updates.token_secret_id'] = '';
    if (dropToken) await revokeSecret(oldToken);
    // Andere Quelle: zwischengespeichertes Prüfergebnis gilt nicht mehr
    if (changes['updates.repo'] || changes['updates.api_url']) Object.assign(patch, { 'updates.latest': null, 'updates.last_check_at': null, 'updates.last_check_error': null, 'updates.notified_version': '' });
    await setSettings(patch as any, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'updates.settings_changed', { type: 'settings', label: 'Updates' }, { aenderungen: changes, ...(tokenChange ? { token: tokenChange } : {}) });
    await securityAlert('update_settings', {
      title: `Update-Einstellungen geändert von ${req.auth!.actor.name}`,
      body: [...Object.entries(changes).map(([k, c]) => `${k}: ${JSON.stringify(c.vorher)} → ${JSON.stringify(c.nachher)}`), ...(tokenChange ? [`Token: ${tokenChange}`] : [])].join('\n').slice(0, 900),
      link: '/einstellungen#updates',
      kind: 'info',
    });
    return { ok: true, tokenSet: !!patch['updates.token_secret_id'] || (!!oldToken && !dropToken), tokenCleared: dropToken && !b.token };
  });

  app.post('/updates/check', { preHandler: requireAuth('update.install'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const r = await checkForUpdate();
    await audit(req.auth!.actor, 'updates.checked', { type: 'update', label: r.latest?.version ?? null }, { ergebnis: r.ok ? (r.available ? 'verfügbar' : 'aktuell') : 'fehler', ...(r.error ? { fehler: r.error } : {}) }, r.ok ? 'ok' : 'failed');
    return r;
  });

  app.post('/updates/install', { preHandler: requireAuth('update.install'), config: { rateLimit: { max: INSTALL_RATE, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ version: z.string().trim().max(20).optional() }).parse(req.body ?? {});
    assertRecentAuth(req);
    try {
      const r = await startInstall(req.auth!.actor, { userId: req.auth!.user?.id ?? null, expectVersion: b.version });
      await audit(req.auth!.actor, 'update.install', { type: 'update', label: r.version }, { von: config.version, schritt: 'gestartet' });
      await securityAlert('update_install', { kind: 'info', title: `Update auf Version ${r.version} gestartet von ${req.auth!.actor.name}`, body: `Laufende Version ${config.version}. Wartungsmodus und Datenbanksicherung folgen, danach Neustart.`, link: '/einstellungen#updates' });
      return reply.status(202).send({ started: true, version: r.version, from: config.version });
    } catch (e) {
      if (e instanceof AppError) throw e;
      await audit(req.auth!.actor, 'update.install', { type: 'update' }, { von: config.version, fehler: (e as Error).message.slice(0, 500) }, 'failed');
      if (e instanceof UpdateSourceError) throw badRequest(e.message);
      throw badRequest((e as Error).message);
    }
  });
}
