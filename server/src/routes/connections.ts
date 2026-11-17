import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth, requireSession } from '../auth/context.js';
import { permissionsFor } from '../auth/permissions.js';
import { audit, auditThrottled } from '../lib/audit.js';
import { securityAlert } from '../lib/security-alerts.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { approvalStillValid, assertMediaPresent } from '../lib/approval.js';
import { enqueue } from '../jobs/queue.js';
import { noUrlCredentials, publicBase, URL_CREDENTIALS_MSG } from '../lib/urls.js';
import { revokeSecret } from '../lib/secrets.js';
import { postState } from './posts.js';
import { publicFileFor } from './media.js';
import { sendFileResponse } from './files.js';
import { publicFileName } from '../media/names.js';
import { connectionSecrets, connectionUsage, KIND_LABEL, loadConnection, requireRetest, retestRelevantConfig, saveTest, scrub, updateConnectionSecrets, type Connection, type ConnectionKind } from '../connections/common.js';
import { FE2_ALLOWED_FIELDS, FE2_DEFAULT_MAPPING, handleFe2Event } from '../connections/fe2.js';
import { checkFormats, checkStoryFormats, connectionTestImage, deleteFacebookPost, facebookAuthorizeUrl, facebookExchange, instagramAuthorizeUrl, instagramExchange, mediaForRevision, mediaUrl, storyImage, testFacebook, testInstagram } from '../connections/meta.js';
import { formatsFor, isManualChannel, isSocialKind, limitsFor, markerFor, postLink, shareTarget, SOCIAL_KINDS, socialText, socialTextTooLong, type SocialChannel } from '../connections/channels.js';
import { checkThreadsFormats, testThreads, threadsAuthorizeUrl, threadsExchange } from '../connections/threads.js';
import { checkXFormats, deleteXPost, testX, X_SECRET_KEYS } from '../connections/x.js';
import { checkMastodonFormats, deleteMastodonPost, mastodonAuthorizeUrl, mastodonExchange, MASTODON_VISIBILITY, normalizeInstance, registerMastodonApp, testMastodon } from '../connections/mastodon.js';
import { checkBlueskyFormats, deleteBlueskyPost, normalizeService, testBluesky } from '../connections/bluesky.js';
import { notify } from '../lib/notify.js';
import { FEUERSOFTWARE_DEFAULT_INTERVAL, FEUERSOFTWARE_INTERVALS, pollFeuersoftware, testFeuersoftware } from '../connections/feuersoftware.js';
import { endBanner, insecureFeed, insecureFeedUrl, REVIEW_CHECKS, refreshWarnfeed, testWarnfeed, warningBannerText } from '../connections/warnfeed.js';
import { listReceipts, Receipt, RECEIPT_CAP, receiptItems, receiptRaw } from '../connections/receipts.js';
import { getSettings } from '../lib/settings.js';
import { kindSupportsAlt } from '../lib/accessibility.js';
import { plural } from '../lib/text.js';

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
    last_poll_at: (c as any).last_poll_at,
    retry_after_until: (c as any).retry_after_until,
    consecutive_failures: (c as any).consecutive_failures ?? 0,
    activated_at: (c as any).activated_at,
    created_at: (c as any).created_at,
    deleted_at: c.deleted_at ?? null,
    secrets_set: Object.keys(sec).filter((k) => k !== 'pages' && k !== 'pathToken'),
    insecure_source: c.kind === 'warnfeed' ? insecureFeed(c.config) : undefined,
    manual: isSocialKind(c.kind) ? isManualChannel(c) : undefined,
    pages: sec.pages ? (JSON.parse(sec.pages) as any[]).map((p) => ({ id: p.id, name: p.name })) : [],
  };
}

const configSchema: Record<ConnectionKind, z.ZodType<any>> = {
  fe2: z.object({
    mapping: z.record(z.string(), z.string().max(120)).default({}),
    createDrafts: z.boolean().default(true),
    // Schlüssel in der Adresse (für Absender ohne eigene Kopfzeile); Standard aus
    keyInPath: z.boolean().default(false),
  }),
  facebook: z.object({ appId: z.string().max(40).default(''), pageId: z.string().max(40).optional(), insights: z.boolean().optional() }),
  instagram: z.object({ appId: z.string().max(40).default(''), userId: z.string().max(40).optional(), insights: z.boolean().optional() }),
  warnfeed: z.object({
    format: z.enum(['nina', 'cap']).default('nina'),
    ars: z.string().max(12).default(''),
    url: z.union([z.literal(''), z.url({ protocol: /^https?$/, error: 'Bitte eine http(s)-Adresse angeben.' }).refine(noUrlCredentials, URL_CREDENTIALS_MSG)]).default(''),
    baseUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/, error: 'Bitte eine https-Adresse angeben.' }).max(200).refine(noUrlCredentials, URL_CREDENTIALS_MSG)]).optional(),
    areaFilter: z.object({ codes: z.array(z.string().max(12)).max(50).default([]), names: z.array(z.string().max(80)).max(50).default([]) }).default({ codes: [], names: [] }),
    intervalMinutes: z.number().int().min(2).max(120).default(5),
    autoBanner: z.boolean().default(false),
    bannerSiteId: z.uuid().nullable().default(null),
  }),
  threads: z.object({ appId: z.string().max(40).default(''), userId: z.string().max(40).optional(), insights: z.boolean().optional() }),
  // X: „Teilen von Hand“ (Standard, ohne Schnittstelle) oder „Über die X-API posten“ (eigene Zugangsdaten, kostenpflichtig)
  x: z.object({ mode: z.enum(['manual', 'api']).default('manual'), insights: z.boolean().optional() }),
  // WhatsApp-Kanal: nur Teilen von Hand; optional die Einladungsadresse des eigenen Kanals zum schnellen Öffnen
  // Mastodon (#215): frei wählbare Instanz; die App-Registrierung (clientId) legt BlaulichtCMS beim Verbinden selbst an
  mastodon: z.object({
    instance: z.union([z.literal(''), z.string().trim().max(200).refine((v) => !!normalizeInstance(v), 'Bitte die Adresse der Instanz als https-Adresse ohne Pfad angeben, z. B. https://social.bund.de.')]).default('').transform((v) => (v ? normalizeInstance(v)! : '')),
    visibility: z.enum(MASTODON_VISIBILITY).default('public'),
    language: z.string().regex(/^[a-z]{2}$/).default('de'),
    insights: z.boolean().optional(),
    clientId: z.string().max(200).optional(),
    appInstance: z.string().max(200).optional(),
    appRedirect: z.string().max(500).optional(),
  }),
  // Bluesky (#215): Handle und App-Passwort; Server (PDS) nur bei eigenem Server
  bluesky: z.object({
    identifier: z.string().trim().max(253).regex(/^@?[A-Za-z0-9._:@+-]*$/, 'Bitte das Handle angeben, z. B. feuerwehr-musterstadt.bsky.social.').default('').transform((v) => v.replace(/^@/, '')),
    service: z.union([z.literal(''), z.string().trim().max(200).refine((v) => !!normalizeService(v), 'Bitte eine https-Adresse ohne Pfad angeben oder leer lassen.')]).default(''),
    language: z.string().regex(/^[a-z]{2}$/).default('de'),
    insights: z.boolean().optional(),
  }),
  whatsapp: z.object({ channelUrl: z.union([z.literal(''), z.string().trim().regex(/^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/?$/, 'Bitte die Adresse des Kanals im Format https://whatsapp.com/channel/… angeben.')]).default('') }),
  feuersoftware: z.object({
    // 50 Abfragen je Stunde sind dokumentiert – kürzester Abstand 60 s, Standard 120 s
    intervalSeconds: z.union(FEUERSOFTWARE_INTERVALS.map((n) => z.literal(n)) as any).default(FEUERSOFTWARE_DEFAULT_INTERVAL),
    rics: z.array(z.string().trim().regex(/^[\p{L}\p{N} _.\-]{1,40}$/u, 'Eine RIC darf nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich enthalten.')).max(30).default([]),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    createDrafts: z.boolean().default(true),
  }),
};

/** Von BlaulichtCMS selbst gepflegte Angaben (App-Registrierung auf der Mastodon-Instanz) – nie aus dem Formular. */
const SERVER_MANAGED_CONFIG = ['clientId', 'appInstance', 'appRedirect'];

/** Zugangsdaten, die an ein frei wählbares Ziel gehen: Mastodon-Instanz bzw. Bluesky-Server (#234). */
const TARGET_SECRETS: Partial<Record<ConnectionKind, string[]>> = { mastodon: ['token', 'clientSecret'], bluesky: ['appPassword'] };

/**
 * Ziel, für das gespeicherte Zugangsdaten gelten: Mastodon die Instanz, Bluesky Server (PDS) und Konto. null für Arten
 * mit fest vorgegebenem Ziel (Meta, X, Feuersoftware …).
 */
function secretTarget(kind: ConnectionKind, cfg: any): string | null {
  if (kind === 'mastodon') return normalizeInstance(cfg?.instance ?? '') ?? '';
  if (kind === 'bluesky') return `${normalizeService(cfg?.service) ?? ''}|${String(cfg?.identifier ?? '').trim().replace(/^@/, '').toLowerCase()}`;
  return null;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Warnfeeds nur über HTTPS (#108): neu eingetragene oder geänderte Adressen müssen https:// sein (http:// nur für
 * localhost zum Testen). Bestehende http-Quellen laufen weiter, aber nur zur Anzeige – ohne automatische Banner.
 */
function assertSecureFeed(cfg: any, before: any | null) {
  for (const k of ['url', 'baseUrl'] as const) {
    if (cfg[k] && cfg[k] !== before?.[k] && insecureFeedUrl(cfg[k])) throw badRequest('Warnfeeds bitte über eine https-Adresse abrufen – über unverschlüsseltes HTTP ließen sich unterwegs gefälschte Warnungen einschleusen.');
  }
}

const STATUS_LABEL: Record<Connection['status'], string> = { draft: 'Entwurf', tested: 'getestet', active: 'aktiv', disabled: 'angehalten', revoked: 'widerrufen' };

/**
 * Geänderte Einstellungen oder Zugangsdaten verwerfen den letzten Test: Status „Entwurf“, auch bei aktiven und
 * angehaltenen Verbindungen. Auditiert, wenn dadurch ein Test verfällt oder eine Verbindung den Betrieb einstellt.
 */
async function invalidateTest(actor: any, c: Connection, grund: string) {
  const before = await requireRetest(c);
  if (before) await audit(actor, 'connection.retest_required', { type: 'connection', id: c.id, label: c.name }, { vorher: STATUS_LABEL[before], grund });
  return before;
}

/**
 * FE2-Eingang authentisieren: per Kopfzeile (Bearer bzw. X-BlaulichtCMS-Token) oder – nur mit der Option
 * „Schlüssel in der Adresse“ – über einen eigenen Pfad-Schlüssel. Verglichen wird in konstanter Zeit über Prüfsummen.
 * Weder Meldungen noch Audit oder Protokoll enthalten den Schlüssel.
 */
async function fe2Auth(req: FastifyRequest, c: Connection, pathToken?: string) {
  const sec = await connectionSecrets(c);
  let token: string;
  let ok: boolean;
  if (pathToken !== undefined) {
    token = pathToken;
    ok = !!c.config?.keyInPath && !!sec.pathToken && !!token && safeEqual(sha256Hex(sec.pathToken), sha256Hex(token));
  } else {
    const h = String(req.headers.authorization ?? '');
    token = /^Bearer\s+(\S+)$/.exec(h)?.[1] ?? String(req.headers['x-blaulichtcms-token'] ?? '');
    ok = !!token && !!sec.inboundTokenHash && safeEqual(sec.inboundTokenHash, sha256Hex(token));
  }
  if (!ok) {
    const via = pathToken !== undefined ? ' (Schlüssel in der Adresse)' : '';
    // Auditieren, gedrosselt je IP und Verbindung (#111)
    if (token) await securityAlert('fe2_auth', { title: `FE2-Eingang „${c.name}“: falscher Zugangsschlüssel${via}`, body: `Von ${req.ip}. Ist der Schlüssel abgeflossen, in der Verbindung einen neuen erzeugen.`, link: `/verbindungen/${c.id}`, throttleKey: `${c.id}:${req.ip}` });
    await auditThrottled(`fe2:${req.ip}:${c.id}`, 10 * 60_000, { id: null, name: 'FE2-Eingang', type: 'system', ip: req.ip }, 'fe2.auth', { type: 'connection', id: c.id, label: c.name }, { grund: token ? 'Schlüssel falsch' : 'kein Schlüssel', ...(via ? { weg: 'Adresse' } : {}) }, 'failed').catch(() => {});
    throw new AppError(401, 'unauthorized', 'Zugangsschlüssel fehlt oder ist ungültig.');
  }
}

/** Neuer Pfad-Schlüssel für „Schlüssel in der Adresse“ (verschlüsselt gespeichert, damit die Adresse kopierbar bleibt). */
const newPathToken = () => `bcfe2p_${randomToken(32)}`;

export async function connectionRoutes(app: FastifyInstance) {
  const manage = requireAuth('connection.configure');

  app.get('/connections', { preHandler: requireAuth('connection.view') }, async (req) => {
    const full = req.auth!.permissions.has('connection.configure');
    // „Gelöschte anzeigen“ nur für die Administration: widerrufene und gelöschte Verbindungen zur Nachvollziehbarkeit
    const withDeleted = full && req.auth!.permissions.has('connection.delete') && (req.query as any)?.deleted === '1';
    const rows = await many<Connection>(withDeleted ? `SELECT * FROM connections ORDER BY (deleted_at IS NOT NULL OR status = 'revoked'), kind, name` : `SELECT * FROM connections WHERE status <> 'revoked' AND deleted_at IS NULL ORDER BY kind, name`);
    if (full) return Promise.all(rows.map(view));
    // Redaktion sieht nur verfügbare soziale Netzwerke (Name, Art, Funktionen)
    return rows.filter((c) => isSocialKind(c.kind) && ['tested', 'active'].includes(c.status)).map((c) => ({ id: c.id, kind: c.kind, kind_label: KIND_LABEL[c.kind], name: c.name, status: c.status, capabilities: c.capabilities, manual: isManualChannel(c), account: { name: c.account?.name ?? c.account?.username ?? null } }));
  });

  app.get('/connections/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id, pool, { includeDeleted: true });
    if (c.deleted_at && !req.auth!.permissions.has('connection.delete')) throw notFound('Verbindung nicht gefunden.');
    const base = await publicBase(req);
    return {
      ...(await view(c)),
      usage: await connectionUsage(c.id),
      inbound_url: c.kind === 'fe2' ? `${base}/api/v1/inbound/fe2/${c.id}` : null,
      inbound_url_with_key: c.kind === 'fe2' && c.config?.keyInPath && !c.deleted_at ? await connectionSecrets(c).then((s) => (s.pathToken ? `${base}/api/v1/inbound/fe2/${c.id}/${s.pathToken}` : null)) : null,
      oauth_redirect: ['facebook', 'instagram', 'threads', 'mastodon'].includes(c.kind) ? `${base}/api/v1/connections/oauth/callback` : null,
      allowed_fields: c.kind === 'fe2' ? FE2_ALLOWED_FIELDS : null,
      default_mapping: c.kind === 'fe2' ? FE2_DEFAULT_MAPPING : null,
      review_checks: c.kind === 'warnfeed' ? REVIEW_CHECKS : null,
      intervals: c.kind === 'feuersoftware' ? FEUERSOFTWARE_INTERVALS : null,
    };
  });

  /** Schritt 1 „Verbinden“: anlegen (Entwurf). FE2 erhält einen Zugangsschlüssel, der nur jetzt angezeigt wird. */
  app.post('/connections', { preHandler: manage }, async (req) => {
    const b = z.object({ kind: z.enum(['fe2', 'facebook', 'instagram', 'warnfeed', 'feuersoftware', 'threads', 'x', 'whatsapp', 'mastodon', 'bluesky']), name: z.string().trim().min(2).max(100), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const config = configSchema[b.kind].parse(b.config);
    if (b.kind === 'warnfeed') assertSecureFeed(config, null);
    const userId = req.auth!.user?.id ?? null;
    const c = await one<Connection>(`INSERT INTO connections (kind, name, config, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [b.kind, b.name, JSON.stringify(config), userId]);
    let token: string | null = null;
    if (b.kind === 'fe2') {
      token = `bcfe2_${randomToken(32)}`;
      await updateConnectionSecrets(c!, { inboundTokenHash: sha256Hex(token) }, userId);
    }
    await audit(req.auth!.actor, 'connection.created', { type: 'connection', id: c!.id, label: b.name }, { art: b.kind });
    return { id: c!.id, token };
  });

  app.put('/connections/:id', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const b = z.object({ name: z.string().trim().min(2).max(100), config: z.record(z.string(), z.any()) }).parse(req.body);
    // Angaben, die BlaulichtCMS selbst pflegt (App-Registrierung auf der Mastodon-Instanz), kommen nie vom Formular
    const incoming = Object.fromEntries(Object.entries(b.config).filter(([k]) => !SERVER_MANAGED_CONFIG.includes(k)));
    const parsed = configSchema[c.kind].parse({ ...c.config, ...incoming });
    // Warnfeed: Änderungen an Quelle oder Gebiet machen die fachliche Prüfung hinfällig (#55) – automatische Banner aus,
    // Verbindung zurück auf Entwurf (erneut testen)
    const SOURCE_KEYS = ['url', 'ars', 'format', 'areaFilter', 'baseUrl'];
    const sourceChanged = c.kind === 'warnfeed' && SOURCE_KEYS.some((k) => JSON.stringify((parsed as any)[k] ?? null) !== JSON.stringify(c.config[k] ?? null));
    const config = sourceChanged ? { ...parsed, autoBanner: false } : { ...parsed, ...(c.config.review ? { review: c.config.review } : {}) };
    if (c.kind === 'warnfeed') assertSecureFeed(config, c.config);
    if (c.kind === 'warnfeed' && config.autoBanner && insecureFeed(config)) throw badRequest('Automatische Banner sind nur mit einer HTTPS-Quelle möglich.');
    if (c.kind === 'warnfeed' && config.autoBanner && !(config as any).review?.approvedAt) throw badRequest('Automatische Banner sind erst nach dokumentierter fachlicher Prüfung möglich.');
    if (c.kind === 'warnfeed' && config.autoBanner && !config.bannerSiteId) throw badRequest('Für automatische Banner bitte eine Website wählen.');
    // Gewählte Website muss gekoppelt sein (#168) – sonst würden die Banner-Aufträge nie abgeholt
    if (c.kind === 'warnfeed' && config.autoBanner && !(await one(`SELECT 1 FROM wp_sites WHERE id = $1 AND status = 'active'`, [config.bannerSiteId]))) {
      throw badRequest('Die gewählte Website ist nicht gekoppelt. Automatische Banner sind nur für eine gekoppelte Website möglich.');
    }
    // Jede für den Test relevante Änderung verlangt einen neuen Test – auch bei aktiven Verbindungen (die damit
    // anhalten, bis erneut getestet und aktiviert ist). Name, Intervall und Banner-Schalter zählen nicht dazu.
    const before = configSchema[c.kind].safeParse(c.config);
    const retest = retestRelevantConfig(config) !== retestRelevantConfig(before.success ? before.data : c.config);
    const target = c.kind === 'warnfeed' && config.format === 'cap' ? hostOf(config.url) : null;
    // Gespeicherte Zugangsdaten gelten nur für das Ziel, für das sie eingegeben bzw. ausgestellt wurden (#234): Wechselt
    // die Mastodon-Instanz bzw. Server oder Konto bei Bluesky, werden Token, App-Geheimnis und App-Passwort verworfen
    // und die App-Registrierung zurückgesetzt – sonst schickte „Verbindung testen“ sie an den neuen Server. Danach neu
    // verbinden bzw. neu eingeben (wie bei SMTP, Sicherung außer Haus und Update-Token).
    const oldTarget = secretTarget(c.kind, c.config);
    let discarded: string[] = [];
    if (oldTarget !== null && oldTarget !== secretTarget(c.kind, config)) {
      const sec = await connectionSecrets(c);
      discarded = (TARGET_SECRETS[c.kind] ?? []).filter((k) => sec[k]);
      if (c.kind === 'mastodon') for (const k of SERVER_MANAGED_CONFIG) delete (config as any)[k];
    }
    await tx(async (db) => {
      await db.query(
        `UPDATE connections SET name = $2, config = $3,
                private_target = $4, private_approved_at = CASE WHEN private_target IS DISTINCT FROM $4 THEN NULL ELSE private_approved_at END, updated_at = now() WHERE id = $1`,
        [id, b.name, JSON.stringify(config), target],
      );
      if (discarded.length) await updateConnectionSecrets(c, Object.fromEntries(discarded.map((k) => [k, null])), req.auth!.user?.id ?? null, db);
    });
    // „Schlüssel in der Adresse“: beim Einschalten eigenen Pfad-Schlüssel erzeugen, beim Ausschalten löschen
    if (c.kind === 'fe2' && !!config.keyInPath !== !!c.config.keyInPath) {
      await updateConnectionSecrets(c, { pathToken: config.keyInPath ? newPathToken() : null }, req.auth!.user?.id ?? null);
    }
    await audit(req.auth!.actor, 'connection.updated', { type: 'connection', id, label: b.name }, { automatische_banner: config.autoBanner ?? undefined, pruefung_verworfen: sourceChanged || undefined, neuer_test_noetig: retest || undefined, schluessel_in_adresse: c.kind === 'fe2' && !!config.keyInPath !== !!c.config.keyInPath ? (config.keyInPath ? 'an' : 'aus') : undefined, zugangsdaten_verworfen: discarded.length ? discarded : undefined });
    const was = retest ? await invalidateTest(req.auth!.actor, { ...c, name: b.name }, 'Einstellungen geändert') : null;
    return { ok: true, retest, deactivated: was === 'active', secretsDiscarded: discarded };
  });

  /** Zugangsdaten hinterlegen (z. B. App-ID/Geheimnis, manuell erzeugter Token). Werden nie wieder angezeigt. */
  app.put('/connections/:id/secrets', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    const allowed: Record<ConnectionKind, string[]> = { fe2: [], facebook: ['appSecret', 'pageToken'], instagram: ['appSecret', 'token'], warnfeed: [], feuersoftware: ['apiKey'], threads: ['appSecret', 'token'], x: [...X_SECRET_KEYS], whatsapp: [], mastodon: ['token'], bluesky: ['appPassword'] };
    const b = z.record(z.string(), z.string().max(2000).nullable()).parse(req.body);
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed[c.kind].includes(k)));
    if (!Object.keys(patch).length) throw badRequest('Keine gültigen Felder.');
    await updateConnectionSecrets(c, patch, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'connection.secret_changed', { type: 'connection', id, label: c.name }, { felder: Object.keys(patch) });
    const was = await invalidateTest(req.auth!.actor, c, 'Zugangsdaten geändert');
    return { ok: true, retest: true, deactivated: was === 'active' };
  });

  app.post('/connections/:id/rotate-token', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (c.kind !== 'fe2') throw badRequest('Nur für FE2.');
    const token = `bcfe2_${randomToken(32)}`;
    // Ein abgeflossener Schlüssel kann auch die Adresse betreffen: der Pfad-Schlüssel wird mit erneuert
    await updateConnectionSecrets(c, { inboundTokenHash: sha256Hex(token), ...(c.config.keyInPath ? { pathToken: newPathToken() } : {}) }, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'connection.token_rotated', { type: 'connection', id, label: c.name });
    // Neuer Schlüssel = neue Konfiguration in FE2: erst mit einer Testmeldung über den neuen Schlüssel wieder aktivierbar
    const was = await invalidateTest(req.auth!.actor, c, 'Zugangsschlüssel erneuert');
    return { token, retest: true, deactivated: was === 'active' };
  });

  /* ------------------------------------------------------------ OAuth (Meta) */

  app.post('/connections/:id/oauth/start', { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id);
    if (!['facebook', 'instagram', 'threads', 'mastodon'].includes(c.kind)) throw badRequest('Nur für Facebook, Instagram, Threads und Mastodon.');
    const sec = await connectionSecrets(c);
    if (c.kind === 'mastodon') {
      // App auf der Instanz registrieren – neu, wenn sich Instanz oder Weiterleitungsadresse geändert haben
      const redirect = `${await publicBase(req)}/api/v1/connections/oauth/callback`;
      if (!normalizeInstance(c.config.instance ?? '')) throw badRequest('Bitte zuerst die Adresse der Mastodon-Instanz speichern.');
      let clientId = c.config.clientId as string | undefined;
      if (!clientId || !sec.clientSecret || c.config.appInstance !== c.config.instance || c.config.appRedirect !== redirect) {
        try {
          const app = await registerMastodonApp(c, redirect, await publicBase(req));
          clientId = app.clientId;
          await updateConnectionSecrets(c, { clientSecret: app.clientSecret }, req.auth!.user?.id ?? null);
          await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ clientId, appInstance: c.config.instance, appRedirect: redirect })]);
          await audit(req.auth!.actor, 'connection.app_registered', { type: 'connection', id, label: c.name }, { instanz: c.config.instance });
        } catch (e: any) {
          throw new AppError(502, 'upstream', `App-Registrierung auf der Instanz fehlgeschlagen: ${e?.message ?? e}`);
        }
      }
      const state = randomToken(24);
      await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ oauthState: { hash: sha256Hex(state), exp: Date.now() + 10 * 60_000, by: req.auth!.user?.id } })]);
      return { url: mastodonAuthorizeUrl(c, clientId!, redirect, `${c.id}.${state}`) };
    }
    if (!c.config.appId || !sec.appSecret) throw badRequest(c.kind === 'threads' ? 'Bitte zuerst Threads-App-ID und Threads-App-Geheimnis hinterlegen.' : 'Bitte zuerst App-ID und App-Geheimnis der Meta-App hinterlegen.');
    const state = randomToken(24);
    await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ oauthState: { hash: sha256Hex(state), exp: Date.now() + 10 * 60_000, by: req.auth!.user?.id } })]);
    const redirect = `${await publicBase(req)}/api/v1/connections/oauth/callback`;
    const s = `${c.id}.${state}`;
    return { url: c.kind === 'facebook' ? facebookAuthorizeUrl(c.config.appId, redirect, s) : c.kind === 'threads' ? threadsAuthorizeUrl(c.config.appId, redirect, s) : instagramAuthorizeUrl(c.config.appId, redirect, s) };
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
    const by = u && permissionsFor(u.roles).has('connection.configure') ? u : null;
    const actor = { id: by?.id ?? null, name: by?.name ?? 'Meta-Anmeldung', type: 'user' as const, ip: req.ip };
    const back = (msg: string) => reply.redirect(`/verbindungen/${c.id}?meldung=${encodeURIComponent(msg)}`);
    // Status erst nach erfolgreichem Vergleich verbrauchen – sonst könnte jeder mit der Verbindungs-ID eine laufende
    // Anmeldung abbrechen (#82). Abgelaufene Status werden ebenfalls entfernt.
    const valid = !!st && !!by && st.exp >= Date.now() && safeEqual(st.hash, sha256Hex(state ?? ''));
    if (valid || (st && st.exp < Date.now())) await pool.query(`UPDATE connections SET config = config - 'oauthState' WHERE id = $1`, [c.id]);
    if (!valid) return back('Anmeldung abgelaufen oder ungültig – bitte erneut verbinden.');
    if (!q.code) return back(`Anmeldung abgebrochen${q.error_description ? `: ${q.error_description}` : ''}.`);
    const sec = await connectionSecrets(c);
    const redirect = `${await publicBase(req)}/api/v1/connections/oauth/callback`;
    try {
      if (c.kind === 'facebook') {
        const r = await facebookExchange(c.config.appId, sec.appSecret, redirect, q.code);
        await updateConnectionSecrets(c, { userToken: r.userToken, pages: JSON.stringify(r.pages) }, by.id);
        await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name }, { seiten: r.pages.length });
        await invalidateTest(actor, c, 'Neu angemeldet');
        return back(r.pages.length ? `Angemeldet – bitte ${r.pages.length === 1 ? 'die gefundene Seite' : `eine von ${r.pages.length} Seiten`} wählen.` : 'Angemeldet, aber keine verwaltbare Seite gefunden.');
      }
      if (c.kind === 'mastodon') {
        const token = await mastodonExchange(c, String(c.config.clientId ?? ''), sec.clientSecret ?? '', redirect, q.code);
        await updateConnectionSecrets(c, { token }, by.id);
        await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name });
        await invalidateTest(actor, c, 'Neu angemeldet');
        return back('Mit Mastodon verbunden – jetzt testen.');
      }
      if (c.kind === 'threads') {
        const r = await threadsExchange(c.config.appId, sec.appSecret, redirect, q.code);
        await updateConnectionSecrets(c, { token: r.token }, by.id);
        await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [c.id, JSON.stringify({ userId: r.userId, tokenExpiresAt: r.expiresIn ? new Date(Date.now() + r.expiresIn * 1000).toISOString() : null })]);
        await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name });
        await invalidateTest(actor, c, 'Neu angemeldet');
        return back('Mit Threads verbunden – jetzt testen.');
      }
      const r = await instagramExchange(c.config.appId, sec.appSecret, redirect, q.code);
      await updateConnectionSecrets(c, { token: r.token }, by.id);
      await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [c.id, JSON.stringify({ userId: r.userId, tokenExpiresAt: r.expiresIn ? new Date(Date.now() + r.expiresIn * 1000).toISOString() : null })]);
      await audit(actor, 'connection.oauth', { type: 'connection', id: c.id, label: c.name });
      await invalidateTest(actor, c, 'Neu angemeldet');
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
    await pool.query(`UPDATE connections SET config = config || $2, account = $3 WHERE id = $1`, [id, JSON.stringify({ pageId }), JSON.stringify({ id: page.id, name: page.name })]);
    await audit(req.auth!.actor, 'connection.page_selected', { type: 'connection', id, label: c.name }, { seite: page.name });
    const was = await invalidateTest(req.auth!.actor, c, 'Seite gewählt');
    return { ok: true, retest: true, deactivated: was === 'active' };
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
          { name: 'Testmeldung empfangen', ok: got, message: got ? `Letzte Meldung: ${plural(Object.keys(c.preview.fields ?? {}).length, 'Feld', 'Felder')} übernommen, ${c.preview.ignoredKeys ?? 0} verworfen.` : 'Noch keine Meldung eingegangen. In FE2 eine anonymisierte Testmeldung an die Adresse senden.', kind: 'receive' },
          { name: 'Einsatz-ID erkannt', ok: got, message: got ? 'Die Zuordnung liefert eine Einsatz-ID (Wiederholungen werden erkannt).' : '–', kind: 'receive' },
        ],
        capabilities: { drafts: true },
      };
    } else if (c.kind === 'facebook') {
      r = await testFacebook(c, sec);
    } else if (c.kind === 'instagram') {
      // Testbild: fest eingebautes, neutrales Bild (#95) – nie ein Upload, damit beim Test keine personenbezogenen Daten
      // an Meta gehen. Meta ruft es über die öffentliche HTTPS-Adresse von BlaulichtCMS ab.
      const base = await publicBase(req);
      const url = base.startsWith('https://') || process.env.BLAULICHTCMS_META_GRAPH_URL ? `${base}/api/v1/connection-test-image.jpg?v=${randomToken(8)}` : null;
      r = await testInstagram(c, sec, url);
      if (r.userId) await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ userId: r.userId })]);
    } else if (c.kind === 'threads') {
      r = await testThreads(c, sec);
      if (r.userId) await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [id, JSON.stringify({ userId: r.userId })]);
    } else if (c.kind === 'x') {
      r = await testX(c, sec);
    } else if (c.kind === 'mastodon') {
      r = await testMastodon(c, sec);
    } else if (c.kind === 'bluesky') {
      r = await testBluesky(c, sec);
    } else if (c.kind === 'whatsapp') {
      r = {
        steps: [{ name: 'Teilen von Hand', ok: true, message: `WhatsApp bietet keine Schnittstelle zum Veröffentlichen in Kanälen. BlaulichtCMS bereitet Text (mit WhatsApp-Formatierung), Link und Bilder vor; geteilt wird in der WhatsApp-App bzw. in WhatsApp Web und anschließend hier als geteilt markiert.${c.config.channelUrl ? ' Die Kanaladresse ist hinterlegt.' : ''}`, kind: 'publish' }],
        account: c.config.channelUrl ? { link: c.config.channelUrl } : {},
        capabilities: { manual: true, text: true, photos: true },
      };
    } else if (c.kind === 'feuersoftware') {
      r = await testFeuersoftware(c);
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
    // Nur mit einem bestandenen Test der aktuellen Einstellungen: Jede relevante Änderung setzt die Verbindung auf
    // „Entwurf“ und verwirft den Test (invalidateTest) – ein alter Test reicht nach Änderungen also nie.
    if ((c.status !== 'tested' && c.status !== 'disabled') || !c.last_test) throw conflict('Bitte zuerst mit den aktuellen Einstellungen erfolgreich testen.');
    if (!c.last_test.ok) throw conflict('Der letzte Test war nicht erfolgreich.');
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

  /**
   * Löschen: Eine nie benutzte Verbindung wird samt Geheimnissen endgültig gelöscht. Hat sie Bezüge (Veröffentlichungen,
   * Einsatzmeldungen, amtliche Warnungen, Veröffentlichungsziel in einer Fassung), wird sie widerrufen, ihre Geheimnisse werden
   * gelöscht und sie wird als gelöscht markiert: aus den Listen ausgeblendet, Bezüge zeigen „Verbindung gelöscht“.
   * Abrufe, Eingang und Veröffentlichungen ignorieren sie (Status „widerrufen“).
   */
  app.delete('/connections/:id', { preHandler: requireAuth('connection.delete') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const userId = req.auth!.user?.id ?? null;
    const r = await tx(async (db) => {
      const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], db);
      if (!c) throw notFound('Verbindung nicht gefunden.');
      const usage = await connectionUsage(id, db);
      await db.query(`UPDATE connections SET secret_id = NULL WHERE id = $1`, [id]);
      await db.query(`DELETE FROM secrets WHERE owner_type = 'connection' AND owner_id = $1`, [id]);
      if (!usage.used) {
        await db.query(`DELETE FROM connections WHERE id = $1`, [id]);
      } else {
        await db.query(`UPDATE connections SET status = 'revoked', deleted_at = now(), deleted_by = $2, config = config - 'oauthState', updated_at = now() WHERE id = $1`, [id, userId]);
      }
      const { used, ...counts } = usage;
      await audit(req.auth!.actor, 'connection.deleted', { type: 'connection', id, label: c.name }, { art: c.kind, endgueltig: !used, ...(used ? { verwendet: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) } : {}) }, 'ok', db);
      return { mode: used ? 'hidden' : 'deleted', usage };
    });
    return r;
  });

  /** Internes Ziel (privates Netz) ausdrücklich freigeben – nur Plattform-Administration. */
  app.post('/connections/:id/approve-private', { preHandler: [requireAuth('connection.private_targets'), requireSession()] }, async (req) => {
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
    if (c.kind === 'feuersoftware' && c.status === 'active') {
      const r = await pollFeuersoftware(c.id, { force: true });
      if (r.skipped) throw conflict(r.skipped);
      if (r.error) throw new AppError(502, 'upstream', r.error);
      await audit(req.auth!.actor, 'connection.polled', { type: 'connection', id, label: c.name }, { einsaetze: r.seen, passend: r.matched, neu: r.created });
      return r;
    }
    if (c.kind !== 'warnfeed' || c.status !== 'active') throw badRequest('Nur für aktive Warnfeeds und Feuersoftware-Verbindungen.');
    return refreshWarnfeed(c, { trigger: 'manual' });
  });

  /* ------------------------------------------------------------ Empfangsprotokoll */

  /**
   * Empfangsprotokoll eingehender Verbindungen (Warnfeed, FE2, Feuersoftware): Abrufe bzw. eingehende Meldungen der
   * letzten Tage, neueste zuerst, seitenweise. Nur mit „Verbindungen verwalten“. Rohdaten von FE2/Feuersoftware sind
   * geschwärzt gespeichert; das Öffnen wird deshalb nicht eigens auditiert.
   */
  const RECEIPT_KINDS: ConnectionKind[] = ['warnfeed', 'fe2', 'feuersoftware'];
  const receiptFilter = z.enum(['accepted', 'filtered', 'error']).optional().catch(undefined);
  const receiptConnection = async (req: FastifyRequest) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await loadConnection(id, pool, { includeDeleted: true });
    if (c.deleted_at && !req.auth!.permissions.has('connection.delete')) throw notFound('Verbindung nicht gefunden.');
    if (!RECEIPT_KINDS.includes(c.kind)) throw badRequest('Ein Empfangsprotokoll gibt es nur für amtliche Warnungen, FE2 und Feuersoftware Connect.');
    return c;
  };

  app.get('/connections/:id/receipts', { preHandler: requireAuth('connection.log') }, async (req) => {
    const c = await receiptConnection(req);
    const q = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), filter: receiptFilter }).parse(req.query ?? {});
    const s = await getSettings();
    return { ...(await listReceipts(c.id, { filter: q.filter ?? null, page: q.page, limit: q.limit })), retention_days: Number(s['privacy.receipt_days']) || 7, cap: RECEIPT_CAP };
  });

  app.get('/connections/:id/receipts/:receiptId/items', { preHandler: requireAuth('connection.log') }, async (req) => {
    const c = await receiptConnection(req);
    const { receiptId } = z.object({ receiptId: z.uuid() }).parse(req.params);
    const { filter } = z.object({ filter: receiptFilter }).parse(req.query ?? {});
    const items = await receiptItems(c.id, receiptId, filter ?? null);
    if (!items) throw notFound('Eintrag nicht gefunden (inzwischen gelöscht?).');
    return { items, redacted: c.kind !== 'warnfeed' };
  });

  app.get('/connections/:id/receipts/:receiptId/items/:itemId/raw', { preHandler: requireAuth('connection.log') }, async (req) => {
    const c = await receiptConnection(req);
    const { receiptId, itemId } = z.object({ receiptId: z.uuid(), itemId: z.uuid() }).parse(req.params);
    const raw = await receiptRaw(c.id, receiptId, itemId);
    if (!raw) throw notFound('Rohdaten nicht gefunden (inzwischen gelöscht?).');
    return { ...raw, redacted: c.kind !== 'warnfeed' };
  });

  /* ------------------------------------------------------------ FE2-Eingang */

  /**
   * Eingang für FE2. Authentisierung per Zugangsschlüssel (Bearer oder X-BlaulichtCMS-Token). Vor der Aktivierung wird nur die
   * Vorschau aktualisiert. Antworten verraten nichts über andere Verbindungen; Inhalte werden nie protokolliert.
   */
  await app.register(async (inbound) => {
    // Nur für den FE2-Eingang: manche HTTP-Ausgänge senden Formulardaten oder JSON als text/plain
    inbound.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    const receive = async (req: FastifyRequest, pathToken?: string) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1 AND kind = 'fe2' AND deleted_at IS NULL`, [id]);
      if (!c || c.status === 'revoked') throw new AppError(401, 'unauthorized', 'Zugangsschlüssel fehlt oder ist ungültig.');
      const test = req.headers['x-blaulichtcms-test'] === '1';
      // Empfangsprotokoll: jede Anfrage an eine bestehende Verbindung – Fehlversuche ohne gültigen Schlüssel nur ohne
      // Inhalt und höchstens einer je Minute (sonst ließe sich das Protokoll von außen füllen)
      const rec = new Receipt(c.id, test ? 'test' : 'inbound');
      let logIt = true;
      try {
        try {
          await fe2Auth(req, c, pathToken);
        } catch (e) {
          logIt = !(await one(`SELECT 1 FROM connection_receipts WHERE connection_id = $1 AND http_status = 401 AND created_at > now() - interval '1 minute'`, [c.id]));
          throw e;
        }
        if (c.status === 'disabled') throw new AppError(409, 'disabled', 'Die Verbindung ist angehalten.');
        let body: unknown = req.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            throw badRequest('Erwartet wird JSON oder ein Formular.');
          }
        }
        if (body == null || typeof body !== 'object') throw badRequest('Erwartet wird JSON oder ein Formular.');
        const r = await handleFe2Event(c, body, { test, rec });
        if (r.outcome === 'ignored') throw badRequest('Keine Einsatz-ID gefunden – Zuordnung prüfen.');
        await rec.finish({ ok: true, httpStatus: 200, received: 1 });
        return { ok: true, outcome: r.outcome, sequence: r.sequence ?? null };
      } catch (e: any) {
        if (logIt) await rec.finish({ ok: false, error: e instanceof AppError ? e.message : 'Interner Fehler beim Verarbeiten – Details im Systemprotokoll.', httpStatus: e instanceof AppError ? e.status : 500, received: rec.size });
        throw e;
      }
    };
    inbound.post('/inbound/fe2/:id', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, (req) => receive(req));
    // „Schlüssel in der Adresse“ (Option je Verbindung): für Absender, die keine eigene Kopfzeile setzen können. Der
    // Schlüssel steht dann in Adressen und ggf. Proxy-Protokollen (docs/reverse-proxy.md); BlaulichtCMS selbst
    // protokolliert nur die Routenvorlage.
    inbound.post('/inbound/fe2/:id/:token', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, (req) => receive(req, String((req.params as any).token ?? '').slice(0, 200)));
  });

  /* ------------------------------------------------------------ Zeitlich begrenzte Medien-URL (für Meta) */

  app.get('/m/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
    const row = await one<any>(`SELECT m.*, t.variant AS token_variant FROM media_tokens t JOIN media m ON m.id = t.media_id WHERE t.token_hash = $1 AND t.expires_at > now() AND m.status = 'ready' AND m.deleted_at IS NULL`, [sha256Hex(token)]);
    const f = row ? publicFileFor(row) : null;
    if (!f || !fs.existsSync(f.path)) throw notFound();
    reply.header('cache-control', 'private, max-age=300');
    // Story-Fassung eines Bildes (#188): 9:16 ohne Beschnitt, aus der öffentlichen (geschwärzten) Fassung
    if (row.token_variant === 'story' && row.kind === 'image') {
      reply.header('content-type', 'image/jpeg').header('x-content-type-options', 'nosniff');
      return reply.send(await storyImage(await fs.promises.readFile(f.path)));
    }
    return sendFileResponse(reply, f.path, f.type);
  });

  /** Neutrales Testbild für den Instagram-Verbindungstest (#95) – ohne Bezug zu Uploads, ohne Anmeldung abrufbar. */
  app.get('/connection-test-image.jpg', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=3600').header('x-content-type-options', 'nosniff');
    return reply.send(await connectionTestImage());
  });

  /* ------------------------------------------------------------ Soziale Netzwerke */

  /** Formatprüfung je gewähltem Kanal (vor Freigabe und Veröffentlichung sichtbar). */
  app.get('/posts/:id/social-check', { preHandler: requireAuth('post.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st) throw notFound();
    const media = await mediaForRevision(st.current);
    const targets = st.current.social_targets?.length ? await many<any>(`SELECT id, kind, config, CASE WHEN deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE name END AS name, status, capabilities FROM connections WHERE id = ANY($1)`, [st.current.social_targets]) : [];
    const link = await postLink(id);
    return targets.map((t) => {
      const kind = t.kind as SocialChannel;
      const text = socialText(st.current, kind, link, limitsFor(t));
      const formats = formatsFor(kind, (st.current.social_formats ?? {})[t.id]);
      const tooLong = socialTextTooLong(st.current, kind, link, limitsFor(t));
      const issues: string[] = [];
      if (formats.includes('feed')) {
        if (kind === 'facebook' || kind === 'instagram') issues.push(...checkFormats(kind, media, text));
        else if (kind === 'threads') issues.push(...checkThreadsFormats(media, tooLong));
        else if (kind === 'x') issues.push(...checkXFormats(t, media, tooLong));
        else if (kind === 'mastodon') issues.push(...checkMastodonFormats(t, media, tooLong));
        else if (kind === 'bluesky') issues.push(...checkBlueskyFormats(media, tooLong));
      }
      if (formats.includes('story')) issues.push(...checkStoryFormats(kind as 'facebook' | 'instagram', media));
      // Barrierefreiheit (#217): Bilder ohne Alternativtext bei Kanälen, die ihn übernehmen
      const noAlt = media.filter((m: any) => m.kind === 'image' && !m.alt).length;
      if (noAlt && formats.includes('feed') && kindSupportsAlt(kind, t.config)) issues.push(`${noAlt === 1 ? 'Ein Bild hat' : `${noAlt} Bilder haben`} keinen Alternativtext – Menschen mit Screenreader erfahren nicht, was zu sehen ist.`);
      return { id: t.id, kind: t.kind, name: t.name, status: t.status, text, formats, manual: isManualChannel(t), link, issues };
    });
  });

  /** Veröffentlichen auf den gewählten sozialen Netzwerken – nur mit gültiger Freigabe genau dieser Fassung. */
  app.post('/posts/:id/social', { preHandler: requireAuth('publish.social') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ revision: z.number().int(), contentHash: z.string().length(64), connectionIds: z.array(z.uuid()).optional() }).parse(req.body);
    return tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== b.revision || st.current.content_hash !== b.contentHash) throw conflict('Die Fassung hat sich geändert. Eine erneute Freigabe ist nötig.');
      if (!st.validApproval) throw new AppError(409, 'not_approved', 'Diese Fassung ist nicht freigegeben.');
      await assertMediaPresent(st.current, db);
      const targets: string[] = (st.current.social_targets ?? []).filter((t: string) => !b.connectionIds || b.connectionIds.includes(t));
      if (!targets.length) throw badRequest('Für diese Fassung ist kein soziales Netzwerk gewählt.');
      const created: any[] = [];
      const link = await postLink(id, db);
      const ready: { name: string }[] = [];
      for (const cid of targets) {
        const c = await one<any>(`SELECT * FROM connections WHERE id = $1`, [cid], db);
        if (!c || c.status !== 'active') {
          created.push({ connection_id: cid, skipped: 'Verbindung ist nicht aktiv.' });
          continue;
        }
        const manual = isManualChannel(c);
        // Ein Auftrag je Fassung, Kanal und Format (Beitrag/Story); fehlgeschlagene werden gezielt über „Wiederholen“ angestoßen
        for (const format of formatsFor(c.kind, (st.current.social_formats ?? {})[cid])) {
          const exists = await one<any>(`SELECT id, status FROM social_publications WHERE revision_id = $1 AND connection_id = $2 AND format = $3 AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1`, [st.current.id, cid, format], db);
          if (exists) {
            created.push({ id: exists.id, connection_id: cid, format, status: exists.status, duplicate: true, hint: ['failed', 'unknown'].includes(exists.status) ? 'Bitte dieses Netzwerk gezielt wiederholen.' : undefined });
            continue;
          }
          const marker = format === 'story' ? `story:${crypto.randomUUID()}` : markerFor(socialText(st.current, c.kind, link, limitsFor(c)), c.kind);
          // Ohne Schnittstelle: „zum Teilen bereit“ – eine Person teilt von Hand und markiert den Auftrag als geteilt
          const sp = await one<any>(
            `INSERT INTO social_publications (post_id, revision_id, approval_id, connection_id, marker, created_by, format, status, link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
            [id, st.current.id, st.validApproval.id, cid, marker, req.auth!.user?.id ?? null, format, manual ? 'ready' : 'queued', link],
            db,
          );
          if (manual) ready.push({ name: c.name });
          else await enqueue('social.publish', { id: sp.id }, { dedupKey: `social.publish:${sp.id}`, maxAttempts: 1 }, db);
          created.push({ id: sp.id, connection_id: cid, format, status: sp.status });
          await audit(req.auth!.actor, manual ? 'social.share_prepared' : 'social.requested', { type: 'post', id, label: st.current.title }, { kanal: c.name, fassung: b.revision, ...(format === 'story' ? { format: 'Story' } : {}) }, 'ok', db);
        }
      }
      return { items: created, ready, title: st.current.title as string };
    }).then(async (r) => {
      // Hinweis „zum Teilen bereit“ an alle, die in sozialen Netzwerken veröffentlichen dürfen
      for (const x of r.ready) await notify({ kind: 'info', title: `Zum Teilen bereit (${x.name}): ${r.title}`.slice(0, 200), body: 'Text und Dateien sind vorbereitet – bitte von Hand teilen und anschließend als geteilt markieren.', link: `/beitraege/${id}`, permission: 'publish.social' });
      return { items: r.items };
    });
  });

  /**
   * Teilen von Hand (#189): vorbereiteter Text, Adresse zum Öffnen (X-Beitragsfenster mit eingetragenem Text bzw.
   * WhatsApp) und die freigegebenen Dateien als zeitlich begrenzte Links.
   */
  app.get('/social-publications/:id/share', { preHandler: requireAuth('publish.social') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sp = await one<any>(`SELECT sp.*, c.kind, c.config, c.name FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.id = $1`, [id]);
    if (!sp) throw notFound();
    if (!['ready', 'published'].includes(sp.status) || !['x', 'whatsapp'].includes(sp.kind) || (sp.status === 'published' && !sp.shared_at)) throw badRequest('Dieser Auftrag ist nicht zum Teilen von Hand vorgesehen.');
    const rev = await one<any>(`SELECT * FROM post_revisions WHERE id = $1`, [sp.revision_id]);
    // Aktueller Link zur Website (inzwischen veröffentlicht?) – beim Teilen von Hand gibt es keine Wiedererkennung
    const link = (await postLink(sp.post_id)) ?? sp.link;
    const text = socialText(rev, sp.kind, link);
    const files: any[] = [];
    for (const m of await mediaForRevision(rev)) {
      const f = publicFileFor(m);
      if (f) files.push({ name: publicFileName(m.id, f.ext, { prefix: rev.title || 'beitrag', index: files.length + 1 }), kind: m.kind, url: await mediaUrl(m.id, 24) });
    }
    return { kind: sp.kind, name: sp.name, status: sp.status, text, ...shareTarget(sp, text), files, expires_in_hours: 24 };
  });

  /** Von Hand geteilt: Auftrag als veröffentlicht markieren (optional mit Link zum Beitrag) – auditiert. */
  app.post('/social-publications/:id/mark-shared', { preHandler: requireAuth('publish.social') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ url: z.union([z.literal(''), z.url({ protocol: /^https$/, error: 'Bitte eine https-Adresse angeben.' }).max(500)]).default('') }).parse(req.body ?? {});
    const userId = req.auth!.user?.id ?? null;
    const sp = await tx(async (db) => {
      const row = await one<any>(
        `UPDATE social_publications sp SET status = 'published', remote_url = NULLIF($2, ''), published_at = now(), shared_at = now(), shared_by = $3, error = NULL, updated_at = now()
          WHERE sp.id = $1 AND sp.status = 'ready' AND ${approvalStillValid('sp')} RETURNING sp.*`,
        [id, b.url, userId],
        db,
      );
      if (!row) throw badRequest('Nur Aufträge „zum Teilen bereit“ mit weiterhin gültiger Freigabe lassen sich als geteilt markieren.');
      const c = await one<any>(`SELECT name FROM connections WHERE id = $1`, [row.connection_id], db);
      await audit(req.auth!.actor, 'social.shared_manually', { type: 'post', id: row.post_id }, { kanal: c?.name ?? null, link: b.url || null }, 'ok', db);
      return row;
    });
    return { ok: true, id: sp.id };
  });

  /** Nur den betroffenen Kanal wiederholen. Bei unbekanntem Ergebnis prüft der Auftrag zuerst, ob es den Beitrag schon gibt. */
  app.post('/social-publications/:id/retry', { preHandler: requireAuth('publish.social') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sp = await one<any>(`UPDATE social_publications SET status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END, error = NULL, updated_at = now() WHERE id = $1 AND status IN ('failed','unknown') RETURNING *`, [id]);
    if (!sp) throw badRequest('Nur fehlgeschlagene oder ungeklärte Veröffentlichungen können wiederholt werden.');
    await enqueue('social.publish', { id }, { dedupKey: `social.publish:${id}`, maxAttempts: 1 });
    await audit(req.auth!.actor, 'social.retry', { type: 'post', id: sp.post_id }, { auftrag: id, vorher: sp.status });
    return { ok: true };
  });

  /**
   * Auf sozialen Netzwerken zurückziehen (#114). Facebook: Beitrag per Graph API löschen. Instagram: die Schnittstelle
   * erlaubt kein Löschen – Hinweis mit Link zum Beitrag, Löschen von Hand und anschließend hier bestätigen. Noch nicht
   * ausgeführte Aufträge des Beitrags werden abgebrochen. Jeder Schritt wird auditiert. Braucht keine neue Freigabe.
   */
  app.post('/posts/:id/social/remove', { preHandler: requireAuth('publish.social_remove'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const st = await postState(id);
    if (!st) throw notFound();
    const userId = req.auth!.user?.id ?? null;
    const target = { type: 'post', id, label: st.current.title };
    const canceled = await many<any>(
      `UPDATE social_publications sp SET status = 'canceled', error = 'Zurückgezogen', updated_at = now() FROM connections c
        WHERE c.id = sp.connection_id AND sp.post_id = $1 AND sp.status IN ('queued','failed','ready') RETURNING sp.id, c.kind, c.name`,
      [id],
    );
    const open = await many<any>(`SELECT sp.id, c.kind, c.name FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1 AND sp.status IN ('publishing','unknown')`, [id]);
    const live = await many<any>(
      `SELECT sp.*, c.kind, c.name FROM social_publications sp JOIN connections c ON c.id = sp.connection_id
        WHERE sp.post_id = $1 AND sp.status = 'published' AND (sp.removal_status IS NULL OR sp.removal_status = 'failed') ORDER BY sp.created_at`,
      [id],
    );
    if (!live.length && !canceled.length && !open.length) throw badRequest('Der Beitrag steht auf keinem sozialen Netzwerk (mehr).');
    const items: any[] = [];
    for (const r of canceled) {
      items.push({ id: r.id, kind: r.kind, name: r.name, result: 'canceled', message: 'Noch nicht veröffentlicht – Auftrag abgebrochen.' });
      await audit(req.auth!.actor, 'social.canceled', target, { kanal: r.name, grund: reason });
    }
    for (const r of open) items.push({ id: r.id, kind: r.kind, name: r.name, result: 'pending', message: 'Veröffentlichung läuft oder Ergebnis ungeklärt – nach der Klärung erneut zurückziehen.' });
    for (const sp of live) {
      const mark = (status: 'removed' | 'manual' | 'failed', error: string | null) =>
        pool.query(
          `UPDATE social_publications SET removal_status = $2, removal_error = $3, removal_reason = $4, removal_requested_at = now(),
                  removed_at = CASE WHEN $2 = 'removed' THEN now() ELSE NULL END, removed_by = CASE WHEN $2 = 'removed' THEN $5::uuid ELSE NULL END, updated_at = now() WHERE id = $1`,
          [sp.id, status, error, reason, userId],
        );
      const manualStep = async (msg: string) => {
        await mark('manual', msg);
        await audit(req.auth!.actor, 'social.removal_manual', target, { kanal: sp.name, grund: reason, link: sp.remote_url });
        items.push({ id: sp.id, kind: sp.kind, name: sp.name, result: 'manual', message: msg, url: sp.remote_url });
      };
      const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1`, [sp.connection_id]);
      // Über die Schnittstelle löschbar: Facebook-Beiträge und X-Beiträge (Modus X-API). Storys verschwinden nach 24 h
      // von selbst, lassen sich über die Story-Schnittstellen aber nicht löschen.
      const viaApi = sp.format !== 'story' && !sp.shared_at && (['facebook', 'mastodon', 'bluesky'].includes(sp.kind) || (sp.kind === 'x' && c?.config?.mode === 'api'));
      const network = ({ facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', x: 'X', whatsapp: 'WhatsApp', mastodon: 'Mastodon', bluesky: 'Bluesky' } as Record<string, string>)[sp.kind] ?? sp.kind;
      if (!viaApi) {
        await manualStep(
          sp.shared_at
            ? `Von Hand geteilt – bitte in ${network} von Hand löschen und hier bestätigen.`
            : sp.format === 'story'
              ? `Storys lassen sich über die Schnittstelle nicht löschen (sie verschwinden nach 24 Stunden). Bitte die Story in ${network} löschen und hier bestätigen.`
              : `${network} erlaubt kein Löschen über die Schnittstelle. Bitte den Beitrag in ${network} löschen und hier bestätigen.`,
        );
        continue;
      }
      const sec: Record<string, string> = c && c.status !== 'revoked' ? await connectionSecrets(c).catch(() => ({})) : {};
      const credKey = ({ facebook: 'pageToken', x: 'accessToken', mastodon: 'token', bluesky: 'appPassword' } as Record<string, string>)[sp.kind];
      if (!sec[credKey] || !sp.remote_id) {
        await manualStep(`Die Verbindung ist nicht mehr verfügbar – bitte in ${network} von Hand löschen und hier bestätigen.`);
        continue;
      }
      try {
        if (sp.kind === 'facebook') await deleteFacebookPost(sec, sp.remote_id);
        else if (sp.kind === 'mastodon') await deleteMastodonPost(c!, sec, sp.remote_id);
        else if (sp.kind === 'bluesky') await deleteBlueskyPost(c!, sec, sp.remote_id);
        else await deleteXPost(sec, sp.remote_id);
        await mark('removed', null);
        await audit(req.auth!.actor, 'social.removed', target, { kanal: sp.name, grund: reason, beitrag: sp.remote_id });
        items.push({ id: sp.id, kind: sp.kind, name: sp.name, result: 'removed', message: `Auf ${network} gelöscht.` });
      } catch (e: any) {
        const msg = scrub(String(e?.message ?? e), sec).slice(0, 300);
        await mark('failed', msg);
        await audit(req.auth!.actor, 'social.removed', target, { kanal: sp.name, grund: reason, fehler: msg }, 'failed');
        items.push({ id: sp.id, kind: sp.kind, name: sp.name, result: 'failed', message: `Löschen fehlgeschlagen: ${msg} Bitte erneut versuchen oder in ${network} von Hand löschen und hier bestätigen.`, url: sp.remote_url });
      }
    }
    return { items };
  });

  /** Löschen von Hand bestätigen (Instagram oder fehlgeschlagenes Löschen) – auditiert. */
  app.post('/social-publications/:id/confirm-removed', { preHandler: requireAuth('publish.social_remove') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sp = await one<any>(
      `UPDATE social_publications SET removal_status = 'removed', removal_error = NULL, removed_at = now(), removed_by = $2, updated_at = now()
        WHERE id = $1 AND status = 'published' AND removal_status IN ('manual','failed') RETURNING *`,
      [id, req.auth!.user?.id ?? null],
    );
    if (!sp) throw badRequest('Für dieses Netzwerk steht keine Löschung von Hand aus.');
    const c = await one<any>(`SELECT name FROM connections WHERE id = $1`, [sp.connection_id]);
    await audit(req.auth!.actor, 'social.removal_confirmed', { type: 'post', id: sp.post_id }, { kanal: c?.name ?? null, link: sp.remote_url });
    return { ok: true };
  });

  /** Manueller Export: Text je Netzwerk und freigegebene Medien (zeitlich begrenzte Links). */
  app.get('/posts/:id/social-export', { preHandler: requireAuth('publish.social') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st) throw notFound();
    if (!st.validApproval) throw new AppError(409, 'not_approved', 'Exportiert werden nur freigegebene Fassungen.');
    await assertMediaPresent(st.current);
    const media = await mediaForRevision(st.current);
    const files = [];
    for (const m of media) {
      const f = publicFileFor(m);
      // Neutraler Name aus dem Beitragstitel – der Originalname des Uploads kann Namen oder Orte enthalten (#137)
      if (f) files.push({ name: publicFileName(m.id, f.ext, { prefix: st.current.title || 'beitrag', index: files.length + 1 }), kind: m.kind, url: await mediaUrl(m.id, 24) });
    }
    await audit(req.auth!.actor, 'social.exported', { type: 'post', id, label: st.current.title }, { fassung: st.current.number });
    const link = await postLink(id);
    return { ...Object.fromEntries(SOCIAL_KINDS.map((k) => [k, socialText(st.current, k, link)])), files, expires_in_hours: 24 };
  });

  /* ------------------------------------------------------------ Amtliche Warnungen */

  app.get('/official-warnings', { preHandler: requireAuth('official.view') }, async () =>
    many<any>(
      `SELECT w.id, w.connection_id, w.identifier, w.msg_type, w.severity, w.event, w.headline, w.areas, w.effective_at, w.expires_at, w.web_url, w.in_area, w.cancelled, w.superseded_by IS NOT NULL AS superseded, w.banner_id, w.received_at, c.name || CASE WHEN c.deleted_at IS NOT NULL THEN ' (Verbindung gelöscht)' ELSE '' END AS source
         FROM official_warnings w JOIN connections c ON c.id = w.connection_id WHERE w.dismissed_at IS NULL ORDER BY w.received_at DESC LIMIT 100`,
    ),
  );

  /**
   * Amtliche Warnung ausblenden (statt löschen): verschwindet aus der Liste, wird von späteren Abrufen nie neu angelegt
   * (die Zeile bleibt als Merker; Abrufe legen je Kennung nur einmal an) und ein daraus entstandenes Banner wird
   * beendet. Die Löschfrist gilt unverändert. Aktualisierungen und Entwarnungen der Quelle sind eigene Meldungen und
   * erscheinen wieder.
   */
  app.post('/official-warnings/:id/dismiss', { preHandler: requireAuth('official.dismiss') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const w = await one<any>(`UPDATE official_warnings SET dismissed_at = now(), dismissed_by = $2 WHERE id = $1 AND dismissed_at IS NULL RETURNING *`, [id, req.auth!.user?.id ?? null]);
    if (!w) throw notFound('Warnung nicht gefunden oder bereits ausgeblendet.');
    if (w.banner_id) await endBanner(w.banner_id, 'Amtliche Warnung ausgeblendet');
    await audit(req.auth!.actor, 'official_warning.dismissed', { type: 'official_warning', id, label: (w.headline || w.event || w.identifier).slice(0, 200) }, { kennung: w.identifier, banner_beendet: !!w.banner_id || undefined });
    return { ok: true, bannerEnded: !!w.banner_id };
  });

  /** Ohne automatische Banner: Banner-Entwurf mit Link zur Originalquelle vorbereiten (normale Freigabe). */
  app.post('/official-warnings/:id/banner-draft', { preHandler: requireAuth('banner.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { siteId } = z.object({ siteId: z.uuid() }).parse(req.body);
    const w = await one<any>(`SELECT * FROM official_warnings WHERE id = $1`, [id]);
    if (!w) throw notFound();
    const { bannerHash } = await import('./banners.js');
    const ends = w.expires_at && new Date(w.expires_at) > new Date() ? new Date(w.expires_at) : new Date(Date.now() + 6 * 3600_000);
    const src = await one<any>(`SELECT config FROM connections WHERE id = $1`, [w.connection_id]);
    const b = { title: (w.headline || w.event || 'Amtliche Warnung').slice(0, 120), text: warningBannerText(w, src?.config?.areaFilter ?? {}), tone: ['Extreme', 'Severe'].includes(w.severity) ? 'danger' : 'warning', priority: 3, starts_at: new Date(), ends_at: ends, link_url: w.web_url && /^https:\/\//.test(w.web_url) ? w.web_url : 'https://warnung.bund.de', link_text: 'Zur amtlichen Warnung', site_id: siteId };
    const row = await one<any>(
      `INSERT INTO banners (site_id, title, text, tone, priority, starts_at, ends_at, link_url, link_text, content_hash, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
      [siteId, b.title, b.text, b.tone, b.priority, b.starts_at, b.ends_at, b.link_url, b.link_text, bannerHash(b), req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'banner.from_official_warning', { type: 'banner', id: row.id, label: b.title }, { warnung: w.identifier });
    return { id: row.id };
  });
}

export function hashPayload(v: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
