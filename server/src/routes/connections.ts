import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAnyAuth, requireAuth, requirePlatformAdmin } from '../auth/context.js';
import { permissionsFor } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { publicBase } from '../lib/urls.js';
import { revokeSecret } from '../lib/secrets.js';
import { postState } from './posts.js';
import { publicFileFor } from './media.js';
import { sendFileResponse } from './files.js';
import { connectionSecrets, KIND_LABEL, loadConnection, saveTest, scrub, updateConnectionSecrets, type Connection, type ConnectionKind } from '../connections/common.js';
import { FE2_ALLOWED_FIELDS, FE2_DEFAULT_MAPPING, handleFe2Event } from '../connections/fe2.js';
import { checkFormats, facebookAuthorizeUrl, facebookExchange, instagramAuthorizeUrl, instagramExchange, markerFor, mediaForRevision, mediaUrl, socialText, testFacebook, testInstagram } from '../connections/meta.js';
import { REVIEW_CHECKS, refreshWarnfeed, testWarnfeed } from '../connections/warnfeed.js';

/** Öffentliche Sicht auf eine Verbindung – nie mit Geheimnissen. */
async function view(c: Connection) {
  const sec = await connectionSecrets(c);
  const { oauthState, ...config } = c.config ?? {};
  return {
    id: c.id,
    kind: c.kind,
    kind_label: KIND_LABEL[c.kind],
    name: c.name,
    status: c.status,
    config,
    account: c.account,
    capabilities: c.capabilities,
    last_test: c.last_test,
    preview: c.preview,
    private_target: c.private_target,
    private_approved_at: c.private_approved_at,
    last_event_at: (c as any).last_event_at,
    last_error: (c as any).last_error,
    activated_at: (c as any).activated_at,
    created_at: (c as any).created_at,
    secrets_set: Object.keys(sec).filter((k) => k !== 'pages'),
    pages: sec.pages ? (JSON.parse(sec.pages) as any[]).map((p) => ({ id: p.id, name: p.name })) : [],
  };
}

const configSchema: Record<ConnectionKind, z.ZodType<any>> = {
  fe2: z.object({
    mapping: z.record(z.string(), z.string().max(120)).default({}),
    createDrafts: z.boolean().default(true),
  }),
  facebook: z.object({ appId: z.string().max(40).default(''), pageId: z.string().max(40).optional() }),
  instagram: z.object({ appId: z.string().max(40).default(''), userId: z.string().max(40).optional() }),
  warnfeed: z.object({
    format: z.enum(['nina', 'cap']).default('nina'),
    ars: z.string().max(12).default(''),
    url: z.string().max(500).default(''),
    baseUrl: z.string().max(200).optional(),
    areaFilter: z.object({ codes: z.array(z.string().max(12)).max(50).default([]), names: z.array(z.string().max(80)).max(50).default([]) }).default({ codes: [], names: [] }),
    intervalMinutes: z.number().int().min(2).max(120).default(5),
    autoBanner: z.boolean().default(false),
    bannerSiteId: z.uuid().nullable().default(null),
  }),
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function fe2Auth(req: FastifyRequest, c: Connection) {
  const h = String(req.headers.authorization ?? '');
  const token = /^Bearer\s+(\S+)$/.exec(h)?.[1] ?? String(req.headers['x-lifelink-token'] ?? '');
  const sec = await connectionSecrets(c);
  if (!token || !sec.inboundTokenHash || !safeEqual(sec.inboundTokenHash, sha256Hex(token))) throw new AppError(401, 'unauthorized', 'Zugangsschlüssel fehlt oder ist ungültig.');
}

export async function connectionRoutes(app: FastifyInstance) {
  const manage = requireAuth('connection.manage');

  app.get('/connections', { preHandler: requireAnyAuth('connection.manage', 'post.edit', 'post.publish') }, async (req) => {
    const rows = await many<Connection>(`SELECT * FROM connections WHERE status <> 'revoked' ORDER BY kind, name`);
    const full = req.auth!.permissions.has('connection.manage');
    if (full) return Promise.all(rows.map(view));
    // Redaktion sieht nur verfügbare soziale Kanäle (Name, Art, Funktionen)
    return rows.filter((c) => ['facebook', 'instagram'].includes(c.kind) && ['tested', 'active'].includes(c.status)).map((c) => ({ id: c.id, kind: c.kind, kind_label: KIND_LABEL[c.kind], name: c.name, status: c.status, capabilities: c.capabilities, account: { name: c.account?.name ?? c.account?.username ?? null } }));
  });

  app.get('/connections/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const base = await publicBase(req);
    return {
      ...(await view(c)),
      inbound_url: c.kind === 'fe2' ? `${base}/api/v1/inbound/fe2/${c.id}` : null,
      oauth_redirect: ['facebook', 'instagram'].includes(c.kind) ? `${base}/api/v1/connections/oauth/callback` : null,
      allowed_fields: c.kind === 'fe2' ? FE2_ALLOWED_FIELDS : null,
      default_mapping: c.kind === 'fe2' ? FE2_DEFAULT_MAPPING : null,
      review_checks: c.kind === 'warnfeed' ? REVIEW_CHECKS : null,
    };
  });

  /** Schritt 1 „Verbinden“: anlegen (Entwurf). FE2 erhält einen Zugangsschlüssel, der nur jetzt angezeigt wird. */
  app.post('/connections', { preHandler: manage }, async (req) => {
    const b = z.object({ kind: z.enum(['fe2', 'facebook', 'instagram', 'warnfeed']), name: z.string().trim().min(2).max(100), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const config = configSchema[b.kind].parse(b.config);
    const userId = req.auth!.user?.id ?? null;
    const c = await one<Connection>(`INSERT INTO connections (kind, name, config, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [b.kind, b.name, JSON.stringify(config), userId]);
    let token: string | null = null;
    if (b.kind === 'fe2') {
      token = `llfe2_${randomToken(32)}`;
      await updateConnectionSecrets(c!, { inboundTokenHash: sha256Hex(token) }, userId);
    }
    await audit(req.auth!.actor, 'connection.created', { type: 'connection', id: c!.id, label: b.name }, { art: b.kind });
    return { id: c!.id, token };
  });

  app.put('/connections/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const b = z.object({ name: z.string().trim().min(2).max(100), config: z.record(z.string(), z.any()) }).parse(req.body);
    const config = { ...configSchema[c.kind].parse({ ...c.config, ...b.config }), ...(c.config.review ? { review: c.config.review } : {}) };
    if (c.kind === 'warnfeed' && config.autoBanner && !c.config.review?.approvedAt) throw badRequest('Automatische Banner sind erst nach dokumentierter fachlicher Prüfung möglich.');
    if (c.kind === 'warnfeed' && config.autoBanner && !config.bannerSiteId) throw badRequest('Für automatische Banner bitte eine Website wählen.');
    // Geänderte Einstellungen müssen erneut getestet werden (aktive Verbindungen bleiben aktiv)
    const target = c.kind === 'warnfeed' && config.format === 'cap' ? hostOf(config.url) : null;
    await pool.query(
      `UPDATE connections SET name = $2, config = $3, status = CASE WHEN status = 'tested' THEN 'draft' ELSE status END,
              private_target = $4, private_approved_at = CASE WHEN private_target IS DISTINCT FROM $4 THEN NULL ELSE private_approved_at END, updated_at = now() WHERE id = $1`,
      [id, b.name, JSON.stringify(config), target],
    );
    await audit(req.auth!.actor, 'connection.updated', { type: 'connection', id, label: b.name }, { automatische_banner: config.autoBanner ?? undefined });
    return { ok: true };
  });

  /** Zugangsdaten hinterlegen (z. B. App-ID/Geheimnis, manuell erzeugter Token). Werden nie wieder angezeigt. */
  app.put('/connections/:id/secrets', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const allowed: Record<ConnectionKind, string[]> = { fe2: [], facebook: ['appSecret', 'pageToken'], instagram: ['appSecret', 'token'], warnfeed: [] };
    const b = z.record(z.string(), z.string().max(2000).nullable()).parse(req.body);
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed[c.kind].includes(k)));
    if (!Object.keys(patch).length) throw badRequest('Keine gültigen Felder.');
    await updateConnectionSecrets(c, patch, req.auth!.user?.id ?? null);
    await pool.query(`UPDATE connections SET status = CASE WHEN status = 'tested' THEN 'draft' ELSE status END WHERE id = $1`, [id]);
    await audit(req.auth!.actor, 'connection.secret_changed', { type: 'connection', id, label: c.name }, { felder: Object.keys(patch) });
    return { ok: true };
  });

  app.post('/connections/:id/rotate-token', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (c.kind !== 'fe2') throw badRequest('Nur für FE2.');
    const token = `llfe2_${randomToken(32)}`;
    await updateConnectionSecrets(c, { inboundTokenHash: sha256Hex(token) }, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'connection.token_rotated', { type: 'connection', id, label: c.name });
    return { token };
  });

  /* ------------------------------------------------------------ OAuth (Meta) */

  app.post('/connections/:id/oauth/start', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (!['facebook', 'instagram'].includes(c.kind)) throw badRequest('Nur für Facebook und Instagram.');
    const sec = await connectionSecrets(c);
    if (!c.config.appId || !sec.appSecret) throw badRequest('Bitte zuerst App-ID und App-Geheimnis der Meta-App hinterlegen.');
    const state = randomToken(24);
    await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ oauthState: { hash: sha256Hex(state), exp: Date.now() + 10 * 60_000, by: req.auth!.user?.id } })]);
    const redirect = `${await publicBase(req)}/api/v1/connections/oauth/callback`;
    const s = `${c.id}.${state}`;
    return { url: c.kind === 'facebook' ? facebookAuthorizeUrl(c.config.appId, redirect, s) : instagramAuthorizeUrl(c.config.appId, redirect, s) };
  });

  /**
   * Rückkehr von Meta. Das Sitzungs-Cookie ist SameSite=Strict und wird bei der seitenübergreifenden Rückleitung nicht
   * mitgeschickt – authentisiert wird deshalb über den einmaligen, befristeten state (an Verbindung und Person gebunden).
   * Tokens landen verschlüsselt auf dem Server.
   */
  app.get('/connections/oauth/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = z.object({ state: z.string().max(200), code: z.string().max(2000).optional(), error_description: z.string().max(500).optional() }).parse(req.query);
    const [id, state] = q.state.split('.');
    const c = await loadConnection(z.uuid().parse(id));
    const st = c.config.oauthState;
    const u = st?.by ? await one<any>(`SELECT id, name, roles FROM users WHERE id = $1 AND status = 'active'`, [st.by]) : null;
    // Die Person, die die Anmeldung gestartet hat, muss das Recht weiterhin haben
    const by = u && permissionsFor(u.roles).has('connection.manage') ? u : null;
    const actor = { id: by?.id ?? null, name: by?.name ?? 'Meta-Anmeldung', type: 'user' as const, ip: req.ip };
    await pool.query(`UPDATE connections SET config = config - 'oauthState' WHERE id = $1`, [c.id]);
    const back = (msg: string) => reply.redirect(`/verbindungen/${c.id}?meldung=${encodeURIComponent(msg)}`);
    if (!st || !by || st.exp < Date.now() || !safeEqual(st.hash, sha256Hex(state ?? ''))) return back('Anmeldung abgelaufen oder ungültig – bitte erneut verbinden.');
    if (!q.code) return back(`Anmeldung abgebrochen${q.error_description ? `: ${q.error_description}` : ''}.`);
    const sec = await connectionSecrets(c);
    const redirect = `${await publicBase(req)}/api/v1/connections/oauth/callback`;
    try {
      if (c.kind === 'facebook') {
        const r = await facebookExchange(c.config.appId, sec.appSecret, redirect, q.code);
        await updateConnectionSecrets(c, { userToken: r.userToken, pages: JSON.stringify(r.pages) }, by.id);
        await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name }, { seiten: r.pages.length });
        return back(r.pages.length ? `Angemeldet – bitte eine von ${r.pages.length} Seite(n) wählen.` : 'Angemeldet, aber keine verwaltbare Seite gefunden.');
      }
      const r = await instagramExchange(c.config.appId, sec.appSecret, redirect, q.code);
      await updateConnectionSecrets(c, { token: r.token }, by.id);
      await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [c.id, JSON.stringify({ userId: r.userId, tokenExpiresAt: r.expiresIn ? new Date(Date.now() + r.expiresIn * 1000).toISOString() : null })]);
      await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name });
      return back('Mit Instagram verbunden – jetzt testen.');
    } catch (e: any) {
      return back(`Anmeldung fehlgeschlagen: ${scrub(e?.message ?? String(e), sec)}`);
    }
  });

  app.post('/connections/:id/page', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { pageId } = z.object({ pageId: z.string().max(40) }).parse(req.body);
    const c = await loadConnection(id);
    const sec = await connectionSecrets(c);
    const page = (JSON.parse(sec.pages ?? '[]') as any[]).find((p) => p.id === pageId);
    if (!page) throw notFound('Seite nicht gefunden.');
    await updateConnectionSecrets(c, { pageToken: page.access_token }, req.auth!.user?.id ?? null);
    await pool.query(`UPDATE connections SET config = config || $2, account = $3, status = CASE WHEN status = 'tested' THEN 'draft' ELSE status END WHERE id = $1`, [id, JSON.stringify({ pageId }), JSON.stringify({ id: page.id, name: page.name })]);
    await audit(req.auth!.actor, 'connection.page_selected', { type: 'connection', id, label: c.name }, { seite: page.name });
    return { ok: true };
  });

  /* ------------------------------------------------------------ Testen, Vorschau, Aktivieren */

  app.post('/connections/:id/test', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const sec = await connectionSecrets(c);
    let r: any;
    if (c.kind === 'fe2') {
      const got = !!c.preview?.receivedAt;
      r = {
        steps: [
          { name: 'Zugangsschlüssel', ok: !!sec.inboundTokenHash, message: sec.inboundTokenHash ? 'Hinterlegt.' : 'Fehlt – bitte neu erzeugen.', kind: 'login' },
          { name: 'Testmeldung empfangen', ok: got, message: got ? `Letzte Meldung: ${Object.keys(c.preview.fields ?? {}).length} Feld(er) übernommen, ${c.preview.ignoredKeys ?? 0} verworfen.` : 'Noch keine Meldung eingegangen. In FE2 eine anonymisierte Testmeldung an die Adresse senden.', kind: 'receive' },
          { name: 'Einsatz-ID erkannt', ok: got, message: got ? 'Die Zuordnung liefert eine Einsatz-ID (Wiederholungen werden erkannt).' : '–', kind: 'receive' },
        ],
        capabilities: { drafts: true },
      };
    } else if (c.kind === 'facebook') {
      r = await testFacebook(c, sec);
    } else if (c.kind === 'instagram') {
      // Testbild: kleines JPEG unter zeitlich begrenzter Adresse, wenn ein freigegebenes Bild vorhanden ist
      const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`);
      const base = await publicBase(req);
      const url = img && base.startsWith('https://') ? await mediaUrl(img.id, 1) : process.env.LIFELINK_META_GRAPH_URL && img ? await mediaUrl(img.id, 1) : null;
      r = await testInstagram(c, sec, url);
      if (r.userId) await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ userId: r.userId })]);
    } else {
      r = await testWarnfeed(c);
    }
    const result = await saveTest(c, r.steps, { account: r.account, capabilities: r.capabilities, preview: r.preview });
    await audit(req.auth!.actor, 'connection.tested', { type: 'connection', id, label: c.name }, { ergebnis: result.ok ? 'bestanden' : 'nicht bestanden' }, result.ok ? 'ok' : 'failed');
    return result;
  });

  app.post('/connections/:id/activate', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (c.status === 'active') return { ok: true };
    if (c.status !== 'tested' && c.status !== 'disabled') throw conflict('Bitte zuerst erfolgreich testen.');
    if (!c.last_test?.ok) throw conflict('Der letzte Test war nicht erfolgreich.');
    if (c.private_target && !c.private_approved_at) throw conflict(`Das Ziel „${c.private_target}“ ist ein internes Ziel und braucht eine ausdrückliche administrative Freigabe.`);
    await pool.query(`UPDATE connections SET status = 'active', activated_at = now(), activated_by = $2 WHERE id = $1`, [id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'connection.activated', { type: 'connection', id, label: c.name }, { art: c.kind });
    return { ok: true };
  });

  app.post('/connections/:id/disable', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    await pool.query(`UPDATE connections SET status = 'disabled' WHERE id = $1 AND status <> 'revoked'`, [id]);
    await audit(req.auth!.actor, 'connection.disabled', { type: 'connection', id, label: c.name });
    return { ok: true };
  });

  /** Widerrufen: Zugangsdaten löschen, Verbindung bleibt zur Nachvollziehbarkeit erhalten. */
  app.post('/connections/:id/revoke', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (c.secret_id) await revokeSecret(c.secret_id);
    await pool.query(`UPDATE connections SET status = 'revoked', secret_id = NULL WHERE id = $1`, [id]);
    await audit(req.auth!.actor, 'connection.revoked', { type: 'connection', id, label: c.name });
    return { ok: true };
  });

  /** Internes Ziel (privates Netz) ausdrücklich freigeben – nur Plattform-Administration. */
  app.post('/connections/:id/approve-private', { preHandler: [manage, requirePlatformAdmin()] }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { host } = z.object({ host: z.string().max(200) }).parse(req.body);
    const c = await loadConnection(id);
    if (!c.private_target || c.private_target !== host) throw badRequest('Das Ziel stimmt nicht mit der Verbindung überein.');
    await pool.query(`UPDATE connections SET private_approved_at = now(), private_approved_by = $2 WHERE id = $1`, [id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'connection.private_target_approved', { type: 'connection', id, label: c.name }, { ziel: host });
    return { ok: true };
  });

  /** Fachliche Prüfung eines Warnfeeds dokumentieren (Voraussetzung für automatische Banner). */
  app.post('/connections/:id/review', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ checks: z.record(z.string(), z.boolean()), note: z.string().trim().min(10).max(1000) }).parse(req.body);
    const c = await loadConnection(id);
    if (c.kind !== 'warnfeed') throw badRequest('Nur für Warnfeeds.');
    const missing = Object.keys(REVIEW_CHECKS).filter((k) => !b.checks[k]);
    if (missing.length) throw badRequest(`Noch nicht bestätigt: ${missing.map((k) => (REVIEW_CHECKS as any)[k]).join('; ')}`);
    const review = { approvedAt: new Date().toISOString(), approvedBy: req.auth!.user?.id ?? null, approvedByName: req.auth!.user?.name ?? '', note: b.note, checks: b.checks };
    await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ review })]);
    await audit(req.auth!.actor, 'connection.reviewed', { type: 'connection', id, label: c.name }, { notiz: b.note });
    return { ok: true };
  });

  app.post('/connections/:id/refresh', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (c.kind !== 'warnfeed' || c.status !== 'active') throw badRequest('Nur für aktive Warnfeeds.');
    return refreshWarnfeed(c);
  });

  /* ------------------------------------------------------------ FE2-Eingang */

  /**
   * Eingang für FE2. Authentisierung per Zugangsschlüssel (Bearer oder X-LifeLink-Token). Vor der Aktivierung wird nur die
   * Vorschau aktualisiert. Antworten verraten nichts über andere Verbindungen; Inhalte werden nie protokolliert.
   */
  app.post('/inbound/fe2/:id', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1 AND kind = 'fe2'`, [id]);
    if (!c || c.status === 'revoked') throw new AppError(401, 'unauthorized', 'Zugangsschlüssel fehlt oder ist ungültig.');
    await fe2Auth(req, c);
    if (c.status === 'disabled') throw new AppError(409, 'disabled', 'Die Verbindung ist angehalten.');
    if (req.body == null || typeof req.body !== 'object') throw badRequest('Erwartet wird JSON.');
    const r = await handleFe2Event(c, req.body, { test: req.headers['x-lifelink-test'] === '1' });
    if (r.outcome === 'ignored') throw badRequest('Keine Einsatz-ID gefunden – Zuordnung prüfen.');
    return { ok: true, outcome: r.outcome, sequence: r.sequence ?? null };
  });

  /* ------------------------------------------------------------ Zeitlich begrenzte Medien-URL (für Meta) */

  app.get('/m/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
    const row = await one<any>(`SELECT m.* FROM media_tokens t JOIN media m ON m.id = t.media_id WHERE t.token_hash = $1 AND t.expires_at > now() AND m.status = 'ready' AND m.deleted_at IS NULL`, [sha256Hex(token)]);
    const f = row ? publicFileFor(row) : null;
    if (!f || !fs.existsSync(f.path)) throw notFound();
    reply.header('cache-control', 'private, max-age=300');
    return sendFileResponse(reply, f.path, f.type);
  });

  /* ------------------------------------------------------------ Soziale Kanäle */

  /** Formatprüfung je gewähltem Kanal (vor Freigabe und Veröffentlichung sichtbar). */
  app.get('/posts/:id/social-check', { preHandler: requireAuth('post.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st) throw notFound();
    const media = await mediaForRevision(st.current);
    const targets = st.current.social_targets?.length ? await many<any>(`SELECT id, kind, name, status, capabilities FROM connections WHERE id = ANY($1)`, [st.current.social_targets]) : [];
    return targets.map((t) => {
      const text = socialText(st.current, t.kind);
      return { id: t.id, kind: t.kind, name: t.name, status: t.status, text, issues: checkFormats(t.kind, media, text) };
    });
  });

  /** Veröffentlichen auf den gewählten sozialen Kanälen – nur mit gültiger Freigabe genau dieser Fassung. */
  app.post('/posts/:id/social', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ revision: z.number().int(), contentHash: z.string().length(64), connectionIds: z.array(z.uuid()).optional() }).parse(req.body);
    return tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== b.revision || st.current.content_hash !== b.contentHash) throw conflict('Die Fassung hat sich geändert. Eine erneute Freigabe ist nötig.');
      if (!st.validApproval) throw new AppError(409, 'not_approved', 'Diese Fassung ist nicht freigegeben.');
      const targets: string[] = (st.current.social_targets ?? []).filter((t: string) => !b.connectionIds || b.connectionIds.includes(t));
      if (!targets.length) throw badRequest('Für diese Fassung ist kein sozialer Kanal gewählt.');
      const created: any[] = [];
      for (const cid of targets) {
        const c = await one<any>(`SELECT * FROM connections WHERE id = $1`, [cid], db);
        if (!c || c.status !== 'active') {
          created.push({ connection_id: cid, skipped: 'Kanal ist nicht aktiv.' });
          continue;
        }
        // Ein Auftrag je Fassung und Kanal; fehlgeschlagene werden gezielt über „Wiederholen“ angestoßen
        const exists = await one<any>(`SELECT id, status FROM social_publications WHERE revision_id = $1 AND connection_id = $2 AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1`, [st.current.id, cid], db);
        if (exists) {
          created.push({ id: exists.id, connection_id: cid, status: exists.status, duplicate: true, hint: ['failed', 'unknown'].includes(exists.status) ? 'Bitte diesen Kanal gezielt wiederholen.' : undefined });
          continue;
        }
        const marker = markerFor(socialText(st.current, c.kind));
        const sp = await one<any>(
          `INSERT INTO social_publications (post_id, revision_id, approval_id, connection_id, marker, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
          [id, st.current.id, st.validApproval.id, cid, marker, req.auth!.user?.id ?? null],
          db,
        );
        await enqueue('social.publish', { id: sp.id }, { dedupKey: `social.publish:${sp.id}`, maxAttempts: 1 }, db);
        created.push({ id: sp.id, connection_id: cid, status: sp.status });
        await audit(req.auth!.actor, 'social.requested', { type: 'post', id, label: st.current.title }, { kanal: c.name, fassung: b.revision }, 'ok', db);
      }
      return { items: created };
    });
  });

  /** Nur den betroffenen Kanal wiederholen. Bei unbekanntem Ergebnis prüft der Auftrag zuerst, ob es den Beitrag schon gibt. */
  app.post('/social-publications/:id/retry', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sp = await one<any>(`UPDATE social_publications SET status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END, error = NULL, updated_at = now() WHERE id = $1 AND status IN ('failed','unknown') RETURNING *`, [id]);
    if (!sp) throw badRequest('Nur fehlgeschlagene oder ungeklärte Veröffentlichungen können wiederholt werden.');
    await enqueue('social.publish', { id }, { dedupKey: `social.publish:${id}`, maxAttempts: 1 });
    await audit(req.auth!.actor, 'social.retry', { type: 'post', id: sp.post_id }, { auftrag: id, vorher: sp.status });
    return { ok: true };
  });

  /** Manueller Export: Text je Kanal und freigegebene Medien (zeitlich begrenzte Links). */
  app.get('/posts/:id/social-export', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st) throw notFound();
    if (!st.validApproval) throw new AppError(409, 'not_approved', 'Exportiert werden nur freigegebene Fassungen.');
    const media = await mediaForRevision(st.current);
    const files = [];
    for (const m of media) {
      const f = publicFileFor(m);
      if (f) files.push({ name: `${m.original_name.replace(/\.[^.]+$/, '')}.${f.ext}`, kind: m.kind, url: await mediaUrl(m.id, 24) });
    }
    await audit(req.auth!.actor, 'social.exported', { type: 'post', id, label: st.current.title }, { fassung: st.current.number });
    return { facebook: socialText(st.current, 'facebook'), instagram: socialText(st.current, 'instagram'), files, expires_in_hours: 24 };
  });

  /* ------------------------------------------------------------ Amtliche Warnungen */

  app.get('/official-warnings', { preHandler: requireAuth('post.read') }, async () =>
    many<any>(
      `SELECT w.id, w.identifier, w.msg_type, w.severity, w.event, w.headline, w.areas, w.effective_at, w.expires_at, w.web_url, w.in_area, w.cancelled, w.superseded_by IS NOT NULL AS superseded, w.banner_id, w.received_at, c.name AS source
         FROM official_warnings w JOIN connections c ON c.id = w.connection_id ORDER BY w.received_at DESC LIMIT 100`,
    ),
  );

  /** Ohne automatische Banner: Banner-Entwurf mit Link zur Originalquelle vorbereiten (normale Freigabe). */
  app.post('/official-warnings/:id/banner-draft', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { siteId } = z.object({ siteId: z.uuid() }).parse(req.body);
    const w = await one<any>(`SELECT * FROM official_warnings WHERE id = $1`, [id]);
    if (!w) throw notFound();
    const { bannerHash } = await import('./banners.js');
    const ends = w.expires_at && new Date(w.expires_at) > new Date() ? new Date(w.expires_at) : new Date(Date.now() + 6 * 3600_000);
    const b = { title: (w.headline || w.event || 'Amtliche Warnung').slice(0, 120), text: `${(w.areas ?? []).slice(0, 3).join(', ')} – Details bei der Originalquelle.`.slice(0, 500), tone: ['Extreme', 'Severe'].includes(w.severity) ? 'danger' : 'warning', priority: 3, starts_at: new Date(), ends_at: ends, link_url: w.web_url && /^https:\/\//.test(w.web_url) ? w.web_url : 'https://warnung.bund.de', link_text: 'Zur amtlichen Warnung', site_id: siteId };
    const row = await one<any>(
      `INSERT INTO banners (site_id, title, text, tone, priority, starts_at, ends_at, link_url, link_text, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [siteId, b.title, b.text, b.tone, b.priority, b.starts_at, b.ends_at, b.link_url, b.link_text, bannerHash(b), req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'banner.from_official_warning', { type: 'banner', id: row.id, label: b.title }, { warnung: w.identifier });
    return { id: row.id };
  });
}

export function hashPayload(v: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
