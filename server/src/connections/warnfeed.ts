import { XMLParser } from 'fast-xml-parser';
import { many, one, pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { httpRequest } from '../lib/http.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { bannerHash, enqueueBannerJob } from '../routes/banners.js';
import { allowedPrivateHosts, type Connection, type TestStep } from './common.js';

/**
 * Amtliche Warnungen als eigene Verbindung – strikt getrennt vom eigenen Warnentwurf (MoWaS-Übergabe).
 *
 * Formate:
 *  - `nina`: Dashboard der Warn-App-Schnittstelle je Amtlichem Regionalschlüssel (ARS), Details als CAP-JSON
 *  - `cap`:  Adresse, die ein CAP-Dokument (XML oder JSON) oder einen Atom-Feed mit CAP-Einträgen liefert
 *
 * Standard ist „nur anzeigen und auf die Originalquelle verlinken“. Automatische Banner lassen sich erst aktivieren,
 * nachdem eine Person die fachliche Prüfung (Herkunft, Weiterverwendung, Gebietsfilter, Gültigkeit, Aktualisierungen,
 * Entwarnungen) dokumentiert hat.
 */
export const DEFAULT_NINA_BASE = 'https://warnung.bund.de/api31';
export const ORIGINAL_SOURCE = 'https://warnung.bund.de';

export const REVIEW_CHECKS = {
  origin: 'Herkunft und Bezugsweg der Daten sind geklärt',
  reuse: 'Weiterverwendung auf der eigenen Website ist zulässig (Nutzungsbedingungen geprüft)',
  area: 'Gebietsfilter liefert nur das eigene Gebiet (mit echten Daten geprüft)',
  validity: 'Gültigkeit/Ablauf wird übernommen, abgelaufene Warnungen verschwinden',
  updates: 'Aktualisierungen ersetzen die vorherige Meldung',
  cancel: 'Entwarnungen (Cancel) beenden das Banner sofort',
} as const;

export interface CapWarning {
  identifier: string;
  sender: string;
  sent: string | null;
  msgType: string;
  references: string[];
  severity: string;
  urgency: string;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  areas: string[];
  geocodes: string[];
  effective: string | null;
  expires: string | null;
  web: string | null;
}

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: any) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

/** CAP 1.2 (als geparstes XML- oder JSON-Objekt) in eine flache Struktur bringen; deutsche Info bevorzugt. */
export function normalizeCap(alert: any): CapWarning | null {
  if (!alert?.identifier) return null;
  const infos = arr(alert.info);
  const info = infos.find((i: any) => /^de/i.test(str(i.language))) ?? infos[0] ?? {};
  const areas = arr(info.area);
  // references: "sender,identifier,sent sender,identifier,sent"
  const refs = str(alert.references)
    .split(/\s+/)
    .filter(Boolean)
    .map((r) => r.split(',')[1] ?? r);
  return {
    identifier: str(alert.identifier),
    sender: str(alert.sender),
    sent: str(alert.sent) || null,
    msgType: str(alert.msgType) || 'Alert',
    references: refs,
    severity: str(info.severity),
    urgency: str(info.urgency),
    event: str(info.event),
    headline: str(info.headline).slice(0, 300),
    description: str(info.description).replace(/<[^>]+>/g, ' ').slice(0, 4000),
    instruction: str(info.instruction).replace(/<[^>]+>/g, ' ').slice(0, 4000),
    areas: areas.map((a: any) => str(a.areaDesc)).filter(Boolean).slice(0, 50),
    geocodes: areas.flatMap((a: any) => arr(a.geocode).map((g: any) => str(g.value))).filter(Boolean).slice(0, 200),
    effective: str(info.effective) || str(info.onset) || null,
    expires: str(info.expires) || null,
    web: str(info.web) || null,
  };
}

const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true, parseTagValue: false });

export function parseCapDocument(body: string): any[] {
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    return arr(Array.isArray(j) ? j : j.alert ?? j);
  }
  const doc = xml.parse(t);
  if (doc.alert) return [doc.alert];
  if (doc.feed) return arr(doc.feed.entry).flatMap((e: any) => (e.content?.alert ? [e.content.alert] : e.alert ? [e.alert] : []));
  return [];
}

/** Gebietsfilter: Geocode-Präfixe (ARS/Warncell) oder Ortsnamen. Ohne Filter gilt alles als „im Gebiet“. */
export function inArea(w: CapWarning, filter: { codes?: string[]; names?: string[] }): boolean {
  const codes = (filter.codes ?? []).map((c) => c.replace(/0+$/, '')).filter(Boolean);
  const names = (filter.names ?? []).map((n) => n.toLowerCase()).filter(Boolean);
  if (!codes.length && !names.length) return true;
  if (codes.some((c) => w.geocodes.some((g) => g.startsWith(c)))) return true;
  return names.some((n) => w.areas.some((a) => a.toLowerCase().includes(n)));
}

async function get(c: Connection, url: string) {
  const res = await httpRequest({ method: 'GET', url, headers: { accept: 'application/json, application/xml;q=0.9' }, timeoutMs: 20_000, maxResponseBytes: 5 * 1024 * 1024, allowPrivateHosts: allowedPrivateHosts(c) });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
  return res.text();
}

/** Alle Warnungen der Quelle abrufen (ohne zu speichern). */
export async function fetchWarnings(c: Connection): Promise<CapWarning[]> {
  if (c.config.format === 'nina') {
    const base = (c.config.baseUrl || DEFAULT_NINA_BASE).replace(/\/$/, '');
    const ars = String(c.config.ars ?? '').replace(/\D/g, '').padEnd(12, '0').slice(0, 5).padEnd(12, '0');
    const list = JSON.parse(await get(c, `${base}/dashboard/${ars}.json`));
    const out: CapWarning[] = [];
    for (const item of arr(list).slice(0, 50)) {
      const id = item?.payload?.id ?? item?.id;
      if (!id) continue;
      const detail = JSON.parse(await get(c, `${base}/warnings/${encodeURIComponent(id)}.json`));
      const w = normalizeCap(detail);
      if (w) out.push(w);
    }
    return out;
  }
  return parseCapDocument(await get(c, c.config.url)).map(normalizeCap).filter(Boolean) as CapWarning[];
}

export async function testWarnfeed(c: Connection) {
  const steps: TestStep[] = [];
  let preview: any = null;
  try {
    const all = await fetchWarnings(c);
    steps.push({ name: 'Quelle abrufen', ok: true, message: `${all.length} Meldung(en) gelesen.`, kind: 'read' });
    const filter = c.config.areaFilter ?? {};
    const mine = all.filter((w) => inArea(w, filter));
    steps.push({ name: 'Gebietsfilter', ok: true, message: `${mine.length} von ${all.length} im eigenen Gebiet${!filter.codes?.length && !filter.names?.length ? ' (kein Filter gesetzt – alle gelten als im Gebiet)' : ''}.`, kind: 'read' });
    preview = { warnings: mine.slice(0, 10).map((w) => ({ identifier: w.identifier, msgType: w.msgType, severity: w.severity, headline: w.headline, areas: w.areas.slice(0, 5), expires: w.expires })), total: all.length };
  } catch (e: any) {
    steps.push({ name: 'Quelle abrufen', ok: false, message: String(e?.message ?? e).slice(0, 300), kind: 'read' });
  }
  return { steps, preview, capabilities: { read: steps[0]?.ok ?? false, autoBanner: !!c.config.review?.approvedAt } };
}

const TONE: Record<string, 'info' | 'warning' | 'danger'> = { Extreme: 'danger', Severe: 'danger', Moderate: 'warning', Minor: 'info' };

/** Abruf, Speichern, Aktualisierungen und Entwarnungen verarbeiten; optional Banner (nur nach fachlicher Prüfung). */
export async function refreshWarnfeed(c: Connection) {
  const all = await fetchWarnings(c);
  const filter = c.config.areaFilter ?? {};
  let added = 0;
  for (const w of all) {
    const area = inArea(w, filter);
    const row = await one<any>(
      `INSERT INTO official_warnings (connection_id, identifier, sender, sent_at, msg_type, references_ids, severity, urgency, event, headline, description, instruction, areas, geocodes, effective_at, expires_at, web_url, in_area, cancelled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (connection_id, identifier) DO NOTHING RETURNING *`,
      [c.id, w.identifier, w.sender, w.sent, w.msgType, w.references, w.severity, w.urgency, w.event, w.headline, w.description, w.instruction, w.areas, w.geocodes, w.effective, w.expires, w.web, area, w.msgType === 'Cancel'],
    );
    if (!row) continue;
    added++;
    // Aktualisierung oder Entwarnung ersetzt die referenzierten Meldungen
    if (w.references.length) {
      const prev = await many<any>(`UPDATE official_warnings SET superseded_by = $3 WHERE connection_id = $1 AND identifier = ANY($2) AND superseded_by IS NULL RETURNING *`, [c.id, w.references, row.id]);
      for (const p of prev) if (p.banner_id) await endBanner(p.banner_id, w.msgType === 'Cancel' ? 'Entwarnung' : 'Aktualisierung');
    }
    if (area && w.msgType !== 'Cancel') {
      await notify({ kind: 'warning', title: `Amtliche Warnung: ${w.headline || w.event}`.slice(0, 200), body: w.areas.slice(0, 3).join(', '), link: '/verbindungen', permission: 'post.read' });
      if (autoBannerAllowed(c)) await createBanner(c, row);
    }
  }
  // Abgelaufene Warnungen: zugehörige Banner laufen auf der Website selbst ab (ends_at = expires)
  await pool.query(`UPDATE connections SET last_event_at = now(), last_error = NULL WHERE id = $1`, [c.id]);
  return { total: all.length, added };
}

export function autoBannerAllowed(c: Connection) {
  return c.status === 'active' && !!c.config.autoBanner && !!c.config.review?.approvedAt && !!c.config.bannerSiteId;
}

async function createBanner(c: Connection, w: any) {
  const ends = w.expires_at ? new Date(w.expires_at) : new Date(Date.now() + 6 * 3600_000);
  if (ends <= new Date()) return;
  const b = {
    title: (w.headline || w.event || 'Amtliche Warnung').slice(0, 120),
    text: `${w.areas.slice(0, 3).join(', ')} – Details und Verhaltenshinweise bei der Originalquelle.`.slice(0, 500),
    tone: TONE[w.severity] ?? 'warning',
    priority: 3,
    starts_at: new Date(),
    ends_at: ends,
    link_url: w.web_url && /^https:\/\//.test(w.web_url) ? w.web_url : ORIGINAL_SOURCE,
    link_text: 'Zur amtlichen Warnung',
    site_id: c.config.bannerSiteId,
  };
  await tx(async (db) => {
    const hash = bannerHash(b);
    // Automatisch freigegeben auf Grundlage der dokumentierten fachlichen Prüfung (im Audit nachvollziehbar)
    const row = await one<any>(
      `INSERT INTO banners (site_id, title, text, tone, priority, starts_at, ends_at, link_url, link_text, content_hash, approved_hash, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, now()) RETURNING *`,
      [b.site_id, b.title, b.text, b.tone, b.priority, b.starts_at, b.ends_at, b.link_url, b.link_text, hash],
      db,
    );
    await enqueueBannerJob(db, row, 'upsert', null);
    await db.query(`UPDATE official_warnings SET banner_id = $2 WHERE id = $1`, [w.id, row.id]);
    await audit({ id: null, name: `Warnfeed „${c.name}“`, type: 'system' }, 'banner.auto_published', { type: 'banner', id: row.id, label: b.title }, { warnung: w.identifier, geprueft_von: c.config.review?.approvedByName ?? null }, 'ok', db);
  });
  log('info', 'warnfeed', `Automatisches Banner für ${w.identifier}`);
}

async function endBanner(bannerId: string, why: string) {
  await tx(async (db) => {
    const b = await one<any>(`UPDATE banners SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *`, [bannerId], db);
    if (!b) return;
    const published = await one(`SELECT 1 FROM banner_jobs WHERE banner_id = $1 AND action = 'upsert' AND status IN ('sent','done')`, [bannerId], db);
    if (published) await enqueueBannerJob(db, b, 'delete', null);
    else await db.query(`UPDATE banner_jobs SET status = 'canceled' WHERE banner_id = $1 AND status = 'queued'`, [bannerId]);
    await audit({ id: null, name: 'Warnfeed', type: 'system' }, 'banner.auto_ended', { type: 'banner', id: bannerId, label: b.title }, { grund: why }, 'ok', db);
  });
}

/** Fälliger Abruf aller aktiven Warnfeeds (Worker). */
export async function refreshDueWarnfeeds() {
  const rows = await many<any>(
    `SELECT * FROM connections WHERE kind = 'warnfeed' AND status = 'active'
       AND (last_event_at IS NULL OR last_event_at < now() - make_interval(mins => GREATEST(2, COALESCE((config->>'intervalMinutes')::int, 5))))`,
  );
  for (const c of rows) {
    try {
      await refreshWarnfeed(c);
    } catch (e: any) {
      await pool.query(`UPDATE connections SET last_event_at = now(), last_error = $2 WHERE id = $1`, [c.id, String(e?.message ?? e).slice(0, 300)]);
      log('warn', 'warnfeed', `Abruf „${c.name}“ fehlgeschlagen: ${e?.message ?? e}`);
    }
  }
}
