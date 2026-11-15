import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit, auditThrottled, type Actor } from '../lib/audit.js';
import { securityAlert } from '../lib/security-alerts.js';
import { deriveKey, hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { publicBase } from '../lib/urls.js';
import { getSettings } from '../lib/settings.js';
import { publicFileFor } from './media.js';
import { textFor } from './posts.js';
import { sendFileResponse } from './files.js';
import { approvalStillValid } from '../lib/approval.js';
import { EXCLUDE_RE, verifyBridgeSignature, type SignatureState } from '../lib/bridge-signature.js';

export const BRIDGE_API_VERSION = 1;

let pkgCache: {
  mtime: number;
  zip: Buffer;
  version: string;
  sha256: string;
  requires: string;
  requiresPhp: string;
  tested: string;
  /** Code-Signatur (#107). Der Server prüft sie nur zur Anzeige und vor der Freigabe – maßgeblich ist die Prüfung in der Bridge. */
  signature: { state: SignatureState; reason: string | null; key: string | null };
} | null = null;
/** Bridge-Paket aus dem Image (zwischengespeichert, Prüfsumme über die ZIP-Datei). */
export function bridgePackage() {
  const dir = config.pluginDir;
  const main = path.join(dir, 'blaulichtcms-bridge.php');
  if (!fs.existsSync(main)) throw notFound('Das Plugin ist in diesem Image nicht enthalten.');
  const mtime = fs.statSync(main).mtimeMs;
  if (pkgCache && pkgCache.mtime === mtime) return pkgCache;
  const zip = new AdmZip();
  zip.addLocalFolder(dir, 'blaulichtcms-bridge', (name) => !EXCLUDE_RE.test(name.replace(/\\/g, '/')));
  // Feste Zeitstempel: gleiche Dateien ergeben dieselbe Prüfsumme, auch nach einem neuen Image-Build
  for (const e of zip.getEntries()) e.header.time = new Date(Date.UTC(2026, 0, 1));
  const header = fs.readFileSync(main, 'utf8');
  const readme = fs.existsSync(path.join(dir, 'readme.txt')) ? fs.readFileSync(path.join(dir, 'readme.txt'), 'utf8') : '';
  const buf = zip.toBuffer();
  pkgCache = {
    mtime,
    zip: buf,
    version: /Version:\s*([0-9.]+)/.exec(header)?.[1] ?? '0',
    sha256: sha256Hex(buf),
    requires: /Requires at least:\s*([0-9.]+)/.exec(header)?.[1] ?? '',
    requiresPhp: /Requires PHP:\s*([0-9.]+)/.exec(header)?.[1] ?? '',
    tested: /Tested up to:\s*([0-9.]+)/i.exec(readme)?.[1] ?? '',
    signature: (() => {
      const v = verifyBridgeSignature(dir);
      return { state: v.state, reason: v.reason ?? null, key: v.key ?? null };
    })(),
  };
  return pkgCache;
}
/** Abholintervall, das die Bridge verwenden soll (Sekunden). */
const POLL_SECONDS = 60;
/** Ein abgeholter Auftrag ohne Rückmeldung wird nach dieser Zeit erneut ausgeliefert. */
const REDELIVER_AFTER_SEC = 120;
/** Nach so vielen Abholungen ohne Bestätigung gilt ein Auftrag als fehlgeschlagen (#67). */
const MAX_BRIDGE_ATTEMPTS = 10;
const PAIRING_MINUTES = 30;

/** Kopplungscode: 8 Zeichen ohne verwechselbare Zeichen, angezeigt als XXXX-XXXX. */
function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

function sitePayload(s: any) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    site_url: s.site_url,
    wp_version: s.wp_version,
    plugin_version: s.plugin_version,
    paired_at: s.paired_at,
    last_seen_at: s.last_seen_at,
    pairing_expires_at: s.status === 'pending' ? s.pairing_expires_at : null,
    revoked_at: s.revoked_at,
    created_at: s.created_at,
    open_jobs: s.open_jobs ?? 0,
    published_count: s.published_count ?? 0,
  };
}

interface BridgeSite {
  id: string;
  name: string;
}

/**
 * Fehlgeschlagene Bridge-Anmeldung auditieren (#111) – gedrosselt je IP, Website und Grund auf einen Eintrag in
 * 10 Minuten (eine falsch eingerichtete Bridge fragt jede Minute). Bei bekannter Website auch Name und Kennung.
 */
async function bridgeAuthFailed(req: FastifyRequest, reason: string, site: { id: string; name: string } | null) {
  // Melden nur bei Schlüsseln im Bridge-Format (falsch/unbekannt) – nicht bei Abrufen ohne Schlüssel (Scanner) oder
  // einer widerrufenen Website, die weiter fragt (#101)
  if (reason === 'Schlüssel falsch' || reason === 'Schlüssel unbekannt') {
    await securityAlert('bridge_auth', { title: `Bridge-Anmeldung mit ungültigem Schlüssel${site ? ` für „${site.name}“` : ''}`, body: `Von ${req.ip}: ${reason}. Ist der Schlüssel abgeflossen, die Kopplung widerrufen und neu koppeln.`, link: '/kanaele', throttleKey: `${site?.id ?? '-'}:${req.ip}` });
  }
  await auditThrottled(`bridge:${req.ip}:${site?.id ?? '-'}:${reason}`, 10 * 60_000, { id: null, name: 'WordPress-Bridge', type: 'system', ip: req.ip }, 'bridge.auth', { type: 'site', id: site?.id ?? null, label: site?.name ?? null }, { grund: reason, route: req.routeOptions?.url ?? null }, 'failed').catch(() => {});
}

async function bridgeAuth(req: FastifyRequest): Promise<BridgeSite> {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (bcb_([A-Za-z0-9]{12})_[A-Za-z0-9_-]{20,})$/.exec(h.trim());
  if (!m) {
    await bridgeAuthFailed(req, h ? 'Schlüssel im falschen Format' : 'kein Schlüssel', null);
    throw new AppError(401, 'bridge_unauthorized', 'Bridge-Schlüssel fehlt oder ist ungültig.');
  }
  const site = await one<any>(`SELECT id, name, status, key_hash FROM wp_sites WHERE key_prefix = $1`, [m[2]]);
  if (!site || !site.key_hash || !safeEqual(site.key_hash, sha256Hex(m[1]))) {
    await bridgeAuthFailed(req, site ? 'Schlüssel falsch' : 'Schlüssel unbekannt', site ? { id: site.id, name: site.name } : null);
    throw new AppError(401, 'bridge_unauthorized', 'Bridge-Schlüssel ist ungültig.');
  }
  if (site.status !== 'active') {
    await bridgeAuthFailed(req, 'Kopplung widerrufen', { id: site.id, name: site.name });
    throw new AppError(403, 'bridge_revoked', 'Die Kopplung dieser Website wurde widerrufen.');
  }
  const pv = String(req.headers['x-blaulichtcms-bridge-version'] ?? '').slice(0, 20) || null;
  await pool.query(`UPDATE wp_sites SET last_seen_at = now(), plugin_version = COALESCE($2, plugin_version) WHERE id = $1`, [site.id, pv]);
  return { id: site.id, name: site.name };
}

/**
 * Kopplung beenden – gemeinsam für „Widerrufen“ in BlaulichtCMS und „Kopplung lösen“ in WordPress (#146): Schlüssel und
 * Kopplungscode ungültig, revoked_at setzen, noch nicht abgeholte Veröffentlichungen und Banner-Aufträge abbrechen.
 * Bereits abgeholte Aufträge ('sent'/'unknown') kann die Website nie mehr melden (#162): Sie werden „Ergebnis unbekannt“
 * mit klarem Hinweis und lassen sich im Beitrag von Hand abschließen (POST /publications/:id/resolve). Sie blockieren
 * den Widerruf einer Freigabe nicht. Abgeholte Banner-Aufträge gelten als fehlgeschlagen – die Bridge entfernt beim
 * Widerruf ohnehin alle lokal gespeicherten Banner.
 */
async function revokeSite(db: Queryable, id: string, revokedBy: string | null, reason: string) {
  const s = await one<any>(
    `UPDATE wp_sites SET status = 'revoked', revoked_at = now(), revoked_by = $2, key_hash = NULL, pairing_code_hash = NULL WHERE id = $1 AND status <> 'revoked' RETURNING *`,
    [id, revokedBy],
    db,
  );
  if (!s) return null;
  // Offene Aufträge sperren (#166): Eine gleichzeitige Abholung (queued → sent) läuft so ganz vorher – dann erfasst der
  // Widerruf die Aufträge unten als abgeholt – oder danach; dann sieht sie die Website als widerrufen (SKIP LOCKED bzw.
  // Statusprüfung in der Vergabe-Anweisung)
  await db.query(`SELECT id FROM publications WHERE site_id = $1 AND status IN ('queued','sent','unknown') FOR UPDATE`, [id]);
  await db.query(`SELECT id FROM banner_jobs WHERE site_id = $1 AND status IN ('queued','sent') FOR UPDATE`, [id]);
  await db.query(`UPDATE publications SET status = 'canceled', result_at = now(), error = $2 WHERE site_id = $1 AND status = 'queued'`, [id, reason]);
  await db.query(`UPDATE banner_jobs SET status = 'canceled', result_at = now(), error = $2 WHERE site_id = $1 AND status = 'queued'`, [id, reason]);
  await db.query(
    `UPDATE publications SET status = 'unknown', error = $2 WHERE site_id = $1 AND status IN ('sent','unknown')`,
    [id, `${reason} – die Website kann das Ergebnis nicht mehr melden. Bitte auf der Website prüfen und hier von Hand abschließen.`],
  );
  await db.query(`UPDATE banner_jobs SET status = 'failed', result_at = now(), error = $2 WHERE site_id = $1 AND status = 'sent'`, [id, `${reason} – Ergebnis offen`]);
  // Warnfeeds mit automatischen Bannern für diese Website abschalten (#168) – sonst entstünden Banner, die nie abgeholt werden
  const feeds = await many<any>(
    `UPDATE connections SET config = config || '{"autoBanner": false}'::jsonb, updated_at = now()
      WHERE kind = 'warnfeed' AND config->>'bannerSiteId' = $1::text AND (config->>'autoBanner')::boolean IS TRUE RETURNING id, name`,
    [id],
    db,
  );
  for (const f of feeds) {
    await audit({ id: null, name: `Warnfeed „${f.name}“`, type: 'system' }, 'connection.auto_banner_disabled', { type: 'connection', id: f.id, label: f.name }, { grund: `Kopplung der Website „${s.name}“ beendet` }, 'ok', db);
  }
  return { ...s, disabledFeeds: feeds as { id: string; name: string }[] };
}

/** Verwaltung informieren, dass automatische Banner wegen eines Website-Widerrufs abgeschaltet wurden (#168). */
async function notifyFeedsDisabled(siteName: string, feeds: { id: string; name: string }[]) {
  for (const f of feeds) {
    await notify({ kind: 'warning', title: `Warnfeed „${f.name}“: automatische Banner abgeschaltet`, body: `Die Kopplung der Website „${siteName}“ wurde beendet. Bitte eine gekoppelte Website wählen und automatische Banner wieder einschalten.`, link: `/verbindungen/${f.id}`, permission: 'connection.manage' });
  }
}

const bridgeActor = (site: BridgeSite, req: FastifyRequest): Actor => ({ id: null, name: `Website „${site.name}“ (Bridge)`, type: 'system', ip: req.ip });

/** Text → einfache Absätze. Die Bridge escaped zusätzlich und erzeugt daraus HTML. */
/**
 * Schlüssel eines Mediums für die Bridge. Die Bridge übernimmt jede Datei einmal je Schlüssel in die Mediathek und
 * verwendet sie danach wieder. Wurde die öffentliche Fassung neu erzeugt (unkenntlich gemacht, zugeschnitten, ohne
 * Ton, #118), ändert sich der Schlüssel: die Bridge lädt die neue Fassung und entfernt die alte aus der Mediathek.
 */
export const bridgeMediaKey = (m: { id: string; public_rev?: number | null }) => (m.public_rev ? `${m.id}.${m.public_rev}` : m.id);

function jobPayload(p: any, media: any[], base: string) {
  const text = textFor(p, 'wordpress');
  const cover = media.find((m) => m.id === p.cover_id);
  return {
    id: p.id,
    type: 'post.upsert',
    blaulichtcms_post_id: p.post_id,
    kind: p.kind,
    revision: p.number,
    content_hash: p.content_hash,
    post: {
      title: text.title,
      body: text.body,
      excerpt: text.excerpt,
      status: 'publish',
      cover_media_id: cover ? bridgeMediaKey(cover) : p.cover_id,
    },
    media: media.map((m, i) => ({
      id: bridgeMediaKey(m),
      kind: m.kind,
      // Barrierefreiheit: Alternativtext und Titel in der Mediathek statt Datei-UUID. Bewusst nicht die Notiz
      // der hochladenden Person – die kann Namen enthalten und ist nur für die Redaktion bestimmt.
      alt: media.length > 1 ? `${text.title} – Bild ${i + 1}` : text.title,
      mime: publicFileFor(m)?.type ?? m.mime,
      filename: `${m.id}.${publicFileFor(m)?.ext ?? 'bin'}`,
      // Pfad relativ zur BlaulichtCMS-Adresse, die die Bridge selbst verwendet (robust hinter Proxys und in Testnetzen)
      path: `/api/v1/bridge/media/${m.id}`,
      url: `${base}/api/v1/bridge/media/${m.id}`,
      width: m.width,
      height: m.height,
    })),
  };
}

export async function bridgeRoutes(app: FastifyInstance) {
  /* ----------------------------- Verwaltung in BlaulichtCMS ----------------------------- */

  app.get('/sites', { preHandler: requireAuth('post.read') }, async () => {
    const rows = await many<any>(
      `SELECT s.*,
              (SELECT count(*)::int FROM publications p WHERE p.site_id = s.id AND p.status IN ('queued','sent','unknown')) AS open_jobs,
              (SELECT count(*)::int FROM publications p WHERE p.site_id = s.id AND p.status = 'published') AS published_count
         FROM wp_sites s ORDER BY s.status = 'revoked', s.name`,
    );
    return rows.map(sitePayload);
  });

  app.post('/sites', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const body = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    const code = pairingCode();
    const s = await one<any>(
      `INSERT INTO wp_sites (name, pairing_code_hash, pairing_expires_at, created_by) VALUES ($1,$2, now() + make_interval(mins => $3), $4) RETURNING *`,
      [body.name, sha256Hex(normCode(code)), PAIRING_MINUTES, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'site.created', { type: 'site', id: s.id, label: s.name });
    return { site: sitePayload(s), pairingCode: code, blaulichtcmsUrl: await publicBase(req) };
  });

  app.post('/sites/:id/pairing-code', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const code = pairingCode();
    const s = await one<any>(
      `UPDATE wp_sites SET pairing_code_hash = $2, pairing_expires_at = now() + make_interval(mins => $3) WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, sha256Hex(normCode(code)), PAIRING_MINUTES],
    );
    if (!s) throw badRequest('Ein neuer Kopplungscode ist nur für noch nicht gekoppelte Websites möglich.');
    await audit(req.auth!.actor, 'site.pairing_code', { type: 'site', id, label: s.name });
    return { site: sitePayload(s), pairingCode: code, blaulichtcmsUrl: await publicBase(req) };
  });

  app.post('/sites/:id/revoke', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const s = await tx(async (db) => {
      const s = await revokeSite(db, id, req.auth!.user?.id ?? null, 'Kopplung widerrufen');
      if (!s) throw notFound('Website nicht gefunden oder bereits widerrufen.');
      await audit(req.auth!.actor, 'site.revoked', { type: 'site', id, label: s.name }, {}, 'ok', db);
      return s;
    });
    await notifyFeedsDisabled(s.name, s.disabledFeeds);
    return sitePayload(s);
  });

  /** BlaulichtCMS Bridge als installierbare ZIP-Datei (WordPress → Plugins → Installieren → Plugin hochladen). */
  app.get('/sites/plugin.zip', { preHandler: requireAuth('channel.manage') }, async (req, reply) => {
    const pkg = bridgePackage();
    await audit(req.auth!.actor, 'site.plugin_downloaded', { type: 'plugin', label: `BlaulichtCMS Bridge ${pkg.version}` });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="blaulichtcms-bridge-${pkg.version}.zip"`);
    return reply.send(pkg.zip);
  });

  /* ------------------------------ Bridge-Updates ------------------------------ */

  /** Stand: Version im Image, Freigaben, Testwebsites. */
  app.get('/sites/bridge-release', { preHandler: requireAuth('channel.manage') }, async () => {
    const pkg = bridgePackage();
    return {
      bundled: { version: pkg.version, sha256: pkg.sha256, signature: pkg.signature },
      releases: await many<any>(`SELECT r.*, u.name AS approved_by_name, s.name AS tested_on_name FROM bridge_releases r LEFT JOIN users u ON u.id = r.approved_by LEFT JOIN wp_sites s ON s.id = r.tested_on ORDER BY r.approved_at DESC`),
      sites: await many<any>(`SELECT id, name, status, update_channel, plugin_version, last_seen_at FROM wp_sites WHERE status = 'active' ORDER BY name`),
    };
  });

  app.put('/sites/:id/update-channel', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { channel } = z.object({ channel: z.enum(['test', 'stable']) }).parse(req.body);
    const s = await one<any>(`UPDATE wp_sites SET update_channel = $2 WHERE id = $1 RETURNING name`, [id, channel]);
    if (!s) throw notFound();
    await audit(req.auth!.actor, 'site.update_channel', { type: 'site', id, label: s.name }, { kanal: channel });
    return { ok: true };
  });

  /**
   * Version für alle Websites freigeben. Voraussetzung: eine Testwebsite meldet diese Version bereits
   * (Paket und Kompatibilität zuerst auf einer Testwebsite geprüft).
   */
  app.post('/sites/bridge-release', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const b = z.object({ version: z.string().max(20), note: z.string().trim().min(5).max(500) }).parse(req.body);
    const pkg = bridgePackage();
    if (b.version !== pkg.version) throw badRequest(`Freigegeben werden kann nur die Version im Image (${pkg.version}).`);
    // Websites mit hinterlegtem Signaturschlüssel würden ein unsigniertes oder falsch signiertes Paket ablehnen (#107)
    if (pkg.signature.state === 'unsigned' || pkg.signature.state === 'invalid') {
      throw new AppError(409, 'bridge_unsigned', `Die Bridge ${pkg.version} ist nicht gültig signiert (${pkg.signature.reason ?? 'unbekannt'}). Bitte vor der Freigabe neu signieren (docs/bridge-signatur.md).`);
    }
    const tested = await one<any>(`SELECT id, name FROM wp_sites WHERE status = 'active' AND update_channel = 'test' AND plugin_version = $1 AND last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC LIMIT 1`, [pkg.version]);
    if (!tested) throw new AppError(409, 'not_tested', `Noch keine Testwebsite meldet Version ${pkg.version}. Bitte zuerst auf einer Testwebsite aktualisieren und prüfen.`);
    await pool.query(`INSERT INTO bridge_releases (version, sha256, tested_on, approved_by, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (version) DO NOTHING`, [pkg.version, pkg.sha256, tested.id, req.auth!.user?.id ?? null, b.note]);
    await audit(req.auth!.actor, 'bridge.released', { type: 'plugin', label: `BlaulichtCMS Bridge ${pkg.version}` }, { getestet_auf: tested.name, sha256: pkg.sha256.slice(0, 16), signatur: pkg.signature.state });
    return { ok: true };
  });

  /* ------------------------------ Bridge-Schnittstelle ------------------------------ */

  const bridgeLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /** Kopplung per einmaligem Code. Antwort enthält den Schlüssel genau einmal. */
  app.post('/bridge/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        code: z.string().trim().min(8).max(20),
        site_url: z.url({ protocol: /^https?$/ }).max(300),
        site_name: z.string().max(200).default(''),
        wp_version: z.string().max(20).default(''),
        plugin_version: z.string().max(20).default(''),
      })
      .parse(req.body);
    const site = await one<any>(`SELECT * FROM wp_sites WHERE pairing_code_hash = $1 AND status = 'pending'`, [sha256Hex(normCode(body.code))]);
    if (!site) {
      await audit({ id: null, name: 'Bridge (unbekannt)', type: 'system', ip: req.ip }, 'site.pair', { type: 'site', label: body.site_url }, {}, 'denied');
      throw new AppError(401, 'pairing_invalid', 'Der Kopplungscode ist ungültig.');
    }
    if (new Date(site.pairing_expires_at).getTime() < Date.now()) throw new AppError(410, 'pairing_expired', 'Der Kopplungscode ist abgelaufen. Bitte in BlaulichtCMS einen neuen erzeugen.');
    const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12).padEnd(12, 'x');
    const key = `bcb_${prefix}_${randomToken(32)}`;
    const updated = await one<any>(
      `UPDATE wp_sites SET status = 'active', key_prefix = $2, key_hash = $3, pairing_code_hash = NULL, pairing_expires_at = NULL,
              site_url = $4, wp_version = $5, plugin_version = $6, paired_at = now(), last_seen_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [site.id, prefix, sha256Hex(key), body.site_url.replace(/\/+$/, ''), body.wp_version || null, body.plugin_version || null],
    );
    if (!updated) throw new AppError(409, 'pairing_used', 'Der Kopplungscode wurde bereits verwendet.');
    await audit({ id: null, name: `Website „${site.name}“ (Bridge)`, type: 'system', ip: req.ip }, 'site.paired', { type: 'site', id: site.id, label: site.name }, { url: body.site_url });
    await notify({ kind: 'success', title: `Website „${site.name}“ gekoppelt`, body: body.site_url, link: '/kanaele', permission: 'channel.manage' });
    await securityAlert('site_paired', { title: `Neue Website gekoppelt: „${site.name}“`, body: `${body.site_url} von ${req.ip}. Die Website kann ab sofort freigegebene Beiträge abholen.`, link: '/kanaele', kind: 'info' });
    return { key, site_id: site.id, site_name: site.name, api_version: BRIDGE_API_VERSION, poll_interval: POLL_SECONDS, blaulichtcms_url: await publicBase(req) };
  });

  app.get('/bridge/status', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    return { ok: true, site_id: site.id, site_name: site.name, api_version: BRIDGE_API_VERSION, poll_interval: POLL_SECONDS };
  });

  /** Update-Angebot für die Bridge (WordPress-Update-Hook). Testwebsites sofort, andere nach Freigabe. */
  app.get('/bridge/update', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    const pkg = bridgePackage();
    const row = await one<any>(`SELECT update_channel FROM wp_sites WHERE id = $1`, [site.id]);
    const released = await one<any>(`SELECT 1 FROM bridge_releases WHERE version = $1 AND sha256 = $2`, [pkg.version, pkg.sha256]);
    if (row?.update_channel !== 'test' && !released) return { available: false, channel: row?.update_channel ?? 'stable' };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = hmacHex(deriveKey('bridge-package'), `${site.id}.${pkg.version}.${exp}`);
    const base = await publicBase(req);
    const pathQs = `/api/v1/bridge/update/package?s=${site.id}&v=${pkg.version}&e=${exp}&sig=${sig}`;
    return {
      available: true,
      channel: row?.update_channel,
      version: pkg.version,
      sha256: pkg.sha256,
      signed: pkg.signature.state === 'valid',
      // Die Bridge setzt ihre gekoppelte BlaulichtCMS-Adresse davor (kann von der öffentlichen Adresse abweichen)
      package_path: pathQs,
      package: `${base}${pathQs}`,
      requires: pkg.requires,
      requires_php: pkg.requiresPhp,
      tested: pkg.tested,
    };
  });

  /** Paket-Download mit kurzlebiger Signatur (WordPress lädt Pakete ohne eigene Header). */
  app.get('/bridge/update/package', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = z.object({ s: z.uuid(), v: z.string().max(20), e: z.coerce.number().int(), sig: z.string().length(64) }).parse(req.query);
    const pkg = bridgePackage();
    if (q.e < Date.now() / 1000 || q.v !== pkg.version || !safeEqual(q.sig, hmacHex(deriveKey('bridge-package'), `${q.s}.${q.v}.${q.e}`))) throw new AppError(403, 'forbidden', 'Download-Link ungültig oder abgelaufen.');
    const site = await one<any>(`SELECT status FROM wp_sites WHERE id = $1`, [q.s]);
    if (site?.status !== 'active') throw new AppError(403, 'forbidden', 'Die Kopplung ist nicht aktiv.');
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="blaulichtcms-bridge-${pkg.version}.zip"`);
    return reply.send(pkg.zip);
  });

  /** Offene Aufträge abholen. Mehrfaches Abholen ist erlaubt – die Bridge arbeitet idempotent. */
  app.get('/bridge/jobs', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    // Wartungsmodus: keine neuen Aufträge ausgeben (Rückmeldungen bereits abgeholter Aufträge bleiben möglich)
    // Bewusst ohne banner_ids: die Bridge lässt bestehende Banner dann unverändert
    if ((await getSettings())['system.maintenance']) return { jobs: [], maintenance: true, poll_interval: POLL_SECONDS };
    // Aufträge, die die Bridge wiederholt abgeholt, aber nie bestätigt hat (z. B. Absturz in WordPress), nicht endlos
    // ausliefern – sonst blockieren sie die nachfolgenden (#67). Fehlgeschlagen = gezielt wiederholbar.
    const stuck = await many<any>(
      `UPDATE publications SET status = 'failed', error = 'Die Website hat den Auftrag mehrfach abgeholt, aber nie bestätigt. Bitte Protokoll der Bridge prüfen.', result_at = now()
        WHERE site_id = $1 AND status = 'sent' AND attempts >= $2 RETURNING id, post_id`,
      [site.id, MAX_BRIDGE_ATTEMPTS],
    );
    for (const p of stuck) await notify({ kind: 'error', title: 'Veröffentlichung hängt: Website bestätigt nicht', link: `/beitraege/${p.post_id}`, permission: 'post.publish' });
    await pool.query(`UPDATE banner_jobs SET status = 'failed' WHERE site_id = $1 AND status = 'sent' AND attempts >= $2`, [site.id, MAX_BRIDGE_ATTEMPTS]);
    // Noch nicht abgeholte Veröffentlichungen ohne gültige Freigabe (widerrufen, neuere Fassung) abbrechen statt ausliefern
    await pool.query(
      `UPDATE publications pb SET status = 'canceled', error = 'Freigabe nicht mehr gültig', result_at = now()
        WHERE site_id = $1 AND status = 'queued' AND action = 'publish' AND NOT ${approvalStillValid('pb')}`,
      [site.id],
    );
    const rows = await many<any>(
      `UPDATE publications pb SET status = CASE WHEN pb.status = 'queued' THEN 'sent' ELSE pb.status END,
              fetched_at = now(), attempts = pb.attempts + 1
        WHERE pb.id IN (
          SELECT id FROM publications q
           WHERE q.site_id = $1 AND q.run_at <= now() AND (q.status IN ('queued','unknown') OR (q.status = 'sent' AND (q.fetched_at IS NULL OR q.fetched_at < now() - make_interval(secs => $2))))
             -- Freigabe beim Ausgeben erneut prüfen (#145): Ein Widerruf zwischen dem Abbrechen oben und dieser Anweisung
             -- darf nicht mehr ausgeliefert werden. Ein laufender Widerruf sperrt die Zeilen (SKIP LOCKED überspringt sie).
             AND (q.action <> 'publish' OR q.status <> 'queued' OR ${approvalStillValid('q')})
             -- Kopplung in derselben Anweisung prüfen (#166): Ein Widerruf nach bridgeAuth() darf nichts mehr ausgeben
             AND EXISTS (SELECT 1 FROM wp_sites s WHERE s.id = q.site_id AND s.status = 'active')
           ORDER BY q.created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING pb.id`,
      [site.id, REDELIVER_AFTER_SEC],
    );
    const bannerRows = await many<any>(
      `UPDATE banner_jobs SET status = 'sent', fetched_at = now(), attempts = attempts + 1
        WHERE id IN (SELECT id FROM banner_jobs j WHERE j.site_id = $1 AND (j.status = 'queued' OR (j.status = 'sent' AND j.fetched_at < now() - make_interval(secs => $2)))
                       AND EXISTS (SELECT 1 FROM wp_sites s WHERE s.id = j.site_id AND s.status = 'active')
                     ORDER BY j.created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id, action, payload`,
      [site.id, REDELIVER_AFTER_SEC],
    );
    const jobs: any[] = bannerRows.map((b) => ({ id: b.id, type: b.action === 'upsert' ? 'banner.upsert' : 'banner.delete', banner: b.payload }));
    // Vollständige Liste aktiver Banner: Die Bridge gleicht damit ihren lokalen Stand ab (auch nach Datenverlust in WordPress)
    const active = await many<any>(
      `SELECT b.* FROM banners b WHERE b.site_id = $1 AND b.ended_at IS NULL AND b.ends_at > now()
          AND EXISTS (SELECT 1 FROM banner_jobs j WHERE j.banner_id = b.id AND j.action = 'upsert' AND j.status IN ('sent','done'))`,
      [site.id],
    );
    if (!rows.length) return { jobs, banner_ids: active.map((b) => b.id), poll_interval: POLL_SECONDS };
    const base = await publicBase(req);
    for (const r of rows) {
      const p = await one<any>(
        `SELECT pb.id, pb.post_id, pb.action, (SELECT kind FROM posts WHERE id = pb.post_id) AS kind, rv.number, rv.title, rv.body, rv.excerpt, rv.variants, rv.media_ids, rv.cover_id, rv.content_hash
           FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id WHERE pb.id = $1`,
        [r.id],
      );
      if (p.action === 'unpublish') {
        // media_ids: Medien der zurückgezogenen Fassung – die Bridge löscht sie aus der Mediathek, sofern kein anderer
        // Beitrag sie verwendet (#98)
        jobs.push({ id: p.id, type: 'post.unpublish', blaulichtcms_post_id: p.post_id, revision: p.number, media_ids: p.media_ids ?? [] });
        continue;
      }
      const media = p.media_ids.length ? await many<any>(`SELECT * FROM media WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL`, [p.media_ids]) : [];
      const ordered = p.media_ids.map((id: string) => media.find((m: any) => m.id === id)).filter((m: any) => m && publicFileFor(m));
      jobs.push(jobPayload(p, ordered, base));
    }
    await audit(bridgeActor(site, req), 'publication.fetched', { type: 'site', id: site.id, label: site.name }, { auftraege: rows.map((r) => r.id) });
    return { jobs, banner_ids: active.map((b) => b.id), poll_interval: POLL_SECONDS };
  });

  /** Ergebnis melden. Wiederholte Meldungen desselben Ergebnisses ändern nichts. */
  /** Die Bridge löst die Kopplung selbst (Entkoppeln/Deinstallation in WordPress): Schlüssel sofort ungültig (#90). */
  app.post('/bridge/unpair', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    const s = await tx(async (db) => {
      const s = await revokeSite(db, site.id, null, 'Kopplung durch die Website gelöst');
      await audit(bridgeActor(site, req), 'site.unpaired_by_bridge', { type: 'site', id: site.id, label: site.name }, {}, 'ok', db);
      return s;
    });
    if (s) await notifyFeedsDisabled(site.name, s.disabledFeeds);
    await notify({ kind: 'warning', title: `Website „${site.name}“ hat die Kopplung gelöst`, link: '/einstellungen', permission: 'system.manage' });
    return { ok: true };
  });

  app.post('/bridge/jobs/:id/result', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['published', 'failed']),
        remote_id: z.union([z.string(), z.number()]).transform(String).optional(),
        url: z.url({ protocol: /^https?$/ }).max(500).optional(),
        remote_status: z.string().max(40).optional(),
        error: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const pub = await one<any>(`SELECT pb.*, rv.title FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id WHERE pb.id = $1 AND pb.site_id = $2`, [id, site.id]);
    if (!pub) {
      // Banner-Auftrag?
      const bj = await one<any>(`SELECT j.*, b.title FROM banner_jobs j JOIN banners b ON b.id = j.banner_id WHERE j.id = $1 AND j.site_id = $2`, [id, site.id]);
      if (!bj) throw notFound('Auftrag nicht gefunden.');
      if (bj.status === 'done') return { ok: true, status: 'published', duplicate: true };
      const ok = body.status === 'published';
      await pool.query(`UPDATE banner_jobs SET status = $2, error = $3, result_at = now() WHERE id = $1`, [id, ok ? 'done' : 'failed', ok ? null : (body.error ?? 'Unbekannter Fehler').slice(0, 1000)]);
      await audit(bridgeActor(site, req), ok ? 'banner.synced' : 'banner.sync_failed', { type: 'banner', id: bj.banner_id, label: bj.title }, { auftrag: id, aktion: bj.action }, ok ? 'ok' : 'failed');
      if (!ok) await notify({ kind: 'error', title: `Banner nicht übertragen: ${bj.title}`.slice(0, 200), body: body.error ?? '', link: '/banner', permission: 'post.publish' });
      return { ok: true, status: body.status };
    }
    if (pub.status === 'published') {
      return { ok: true, status: 'published', duplicate: true };
    }
    if (pub.status === 'canceled') throw new AppError(409, 'job_canceled', 'Der Auftrag wurde in BlaulichtCMS abgebrochen.');
    if (body.status === 'published' && pub.action === 'unpublish') {
      await pool.query(`UPDATE publications SET status = 'published', remote_id = $2, remote_status = $3, error = NULL, result_at = now() WHERE id = $1`, [id, body.remote_id ?? null, body.remote_status ?? 'draft']);
      await audit(bridgeActor(site, req), 'publication.unpublished', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id });
      await notify({ kind: 'info', title: `Zurückgezogen: ${pub.title}`.slice(0, 200), body: site.name, link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    } else if (body.status === 'published') {
      if (!body.remote_id || !body.url) throw badRequest('Für eine erfolgreiche Veröffentlichung sind WordPress-ID und URL nötig.');
      await pool.query(
        `UPDATE publications SET status = 'published', remote_id = $2, remote_url = $3, remote_status = $4, error = NULL, result_at = now() WHERE id = $1`,
        [id, body.remote_id, body.url, body.remote_status ?? 'publish'],
      );
      await audit(bridgeActor(site, req), 'publication.confirmed', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id, url: body.url, wordpress_id: body.remote_id });
      // Freigabe inzwischen widerrufen (#145)? Der Beitrag steht trotzdem auf der Website – das wird festgehalten und
      // sofort ein Rückzug beauftragt, statt ihn stillschweigend stehen zu lassen.
      const revoked = await one<any>(`SELECT revoked_at FROM approvals WHERE id = $1 AND revoked_at IS NOT NULL`, [pub.approval_id]);
      if (revoked) {
        const un = await tx(async (db) => {
          await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [pub.post_id]);
          const open = await one(`SELECT 1 FROM publications WHERE post_id = $1 AND site_id = $2 AND action = 'unpublish' AND status IN ('queued','sent','unknown')`, [pub.post_id, site.id], db);
          if (open) return null;
          const u = await one<any>(
            `INSERT INTO publications (post_id, revision_id, approval_id, site_id, created_by, action, error) VALUES ($1,$2,$3,$4,NULL,'unpublish',NULL) RETURNING id`,
            [pub.post_id, pub.revision_id, pub.approval_id, site.id],
            db,
          );
          await audit(bridgeActor(site, req), 'publication.unpublish_requested', { type: 'post', id: pub.post_id, label: pub.title }, { grund: 'Freigabe wurde widerrufen, während die Website den Auftrag abholte', auftrag: u.id, website_id: site.id }, 'ok', db);
          return u;
        });
        await notify({ kind: 'warning', title: `Trotz Widerruf veröffentlicht – Rückzug beauftragt: ${pub.title}`.slice(0, 200), body: site.name, link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
        return { ok: true, status: body.status, unpublish: un?.id ?? null };
      }
      await notify({ kind: 'success', title: `Veröffentlicht: ${pub.title}`.slice(0, 200), body: body.url, link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    } else {
      await pool.query(`UPDATE publications SET status = 'failed', error = $2, result_at = now() WHERE id = $1`, [id, (body.error ?? 'Unbekannter Fehler').slice(0, 1000)]);
      await audit(bridgeActor(site, req), 'publication.failed', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id }, 'failed');
      await notify({ kind: 'error', title: `Veröffentlichung fehlgeschlagen: ${pub.title}`.slice(0, 200), body: body.error ?? '', link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    }
    return { ok: true, status: body.status };
  });

  /** Öffentliche Medienfassung für einen Auftrag dieser Website (ohne Standortdaten). */
  app.get('/bridge/media/:id', bridgeLimit, async (req, reply) => {
    const site = await bridgeAuth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const allowed = await one(
      `SELECT 1 FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id
        WHERE pb.site_id = $1 AND pb.status IN ('sent','unknown','queued','published') AND rv.media_ids @> ARRAY[$2::uuid] LIMIT 1`,
      [site.id, id],
    );
    if (!allowed) throw notFound('Datei gehört zu keinem Auftrag dieser Website.');
    const m = await one<any>(`SELECT * FROM media WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL`, [id]);
    const pf = m ? publicFileFor(m) : null;
    if (!pf) throw notFound('Keine öffentliche Fassung vorhanden.');
    return sendFileResponse(reply, pf.path, pf.type, `${id}.${pf.ext}`);
  });
}
