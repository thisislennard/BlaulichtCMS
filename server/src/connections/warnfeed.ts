import { XMLParser } from 'fast-xml-parser';
import { many, one, pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { httpRequest } from '../lib/http.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { bannerHash, enqueueBannerJob } from '../routes/banners.js';
import { allowedPrivateHosts, type Connection, type TestStep } from './common.js';
import { emitOfficialWarning } from '../automations/events.js';
import { Receipt, type ReceiptDecision, type ReceiptTrigger } from './receipts.js';

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

/**
 * Unverschlüsselte Quelle (#108)? http:// ist nur zum lokalen Testen auf derselben Maschine (localhost/Loopback) ohne
 * Netzpfad unbedenklich. Sonst könnte jeder im Netzweg gefälschte „amtliche Warnungen“ einschleusen.
 */
export function insecureFeedUrl(u: string | null | undefined): boolean {
  if (!u) return false;
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return false;
    const h = url.hostname.replace(/^\[|\]$/g, '');
    return !(h === 'localhost' || /^127\./.test(h) || h === '::1');
  } catch {
    return true;
  }
}

/** Liefert die Quelle der Verbindung Daten über unverschlüsseltes HTTP? */
export function insecureFeed(cfg: { format?: string; url?: string; baseUrl?: string } | null | undefined): boolean {
  if (!cfg) return false;
  return cfg.format === 'cap' ? insecureFeedUrl(cfg.url) : insecureFeedUrl(cfg.baseUrl || DEFAULT_NINA_BASE);
}
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
    // Nur http(s)-Links übernehmen (#158) – info.web stammt aus der Fremdquelle und wird als Link angezeigt
    web: /^https?:\/\//i.test(str(info.web)) ? str(info.web).slice(0, 1000) : null,
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

/**
 * ARS (12 Stellen: Land 2, Regierungsbezirk 1, Kreis 2, Gemeindeverband 4, Gemeinde 3) nur entlang der Ebenen kürzen
 * (#60). Freies Abschneiden von Nullen machte aus 053700000000 „0537“ und traf damit auch 05374…/05378….
 * Andere Kennungen (z. B. Warncell-IDs) bleiben unverändert.
 */
export function arsPrefix(code: string): string {
  let c = code.trim();
  if (!/^\d{12}$/.test(c)) return c;
  for (const [len, keep] of [[12, 9], [9, 5], [5, 3], [3, 2]] as const) {
    if (c.length === len && /^0+$/.test(c.slice(keep))) c = c.slice(0, keep);
  }
  return c;
}

/**
 * Gebietsfilter: Geocode-Präfixe (ARS/Warncell) oder Ortsnamen. Ohne Filter gilt alles als „im Gebiet“.
 * Gebiete überschneiden sich in beide Richtungen: Eine Warnung für eine Gemeinde liegt im eigenen Kreis, und eine
 * Warnung für den ganzen Kreis oder das Land betrifft auch die eigene Gemeinde (letzteres nur für 12-stellige ARS).
 * Liefert die Begründung mit (Empfangsprotokoll, Test).
 */
export function areaMatch(w: Pick<CapWarning, 'geocodes' | 'areas'>, filter: { codes?: string[]; names?: string[] }): { ok: boolean; reason: string } {
  const codes = (filter.codes ?? []).map(arsPrefix).filter(Boolean);
  const names = (filter.names ?? []).map((n) => n.toLowerCase()).filter(Boolean);
  if (!codes.length && !names.length) return { ok: true, reason: 'Kein Gebietsfilter gesetzt – alle Meldungen gelten als im Gebiet.' };
  for (const c of codes) {
    const g = w.geocodes.find((x) => x.startsWith(c));
    if (g) return { ok: true, reason: `Gebiet passt: Geocode ${g} beginnt mit ${c}.` };
  }
  const wide = w.geocodes.filter((g) => /^\d{12}$/.test(g)).map((g) => [g, arsPrefix(g)] as const);
  for (const c of codes) {
    if (!/^\d+$/.test(c)) continue;
    const hit = wide.find(([, p]) => c.startsWith(p));
    if (hit) return { ok: true, reason: `Gebiet passt: Die Meldung gilt für das größere Gebiet ${hit[0]}, das ${c} enthält.` };
  }
  for (const orig of filter.names ?? []) {
    const n = orig.toLowerCase();
    const a = n ? w.areas.find((x) => x.toLowerCase().includes(n)) : undefined;
    if (a) return { ok: true, reason: `Gebiet passt: Ortsname „${orig}“ in „${a.slice(0, 80)}“.` };
  }
  const list = (xs: string[], max: number) => (xs.length ? `${xs.slice(0, max).join(', ')}${xs.length > max ? ` … (${xs.length} insgesamt)` : ''}` : '(keine)');
  const parts = [codes.length ? `Geocodes der Meldung ${list(w.geocodes, 5)} – eingestellt ${(filter.codes ?? []).join(', ')}` : null, names.length ? `Orte der Meldung ${list(w.areas, 3)} – eingestellt ${(filter.names ?? []).join(', ')}` : null];
  return { ok: false, reason: `Gebiet passt nicht: ${parts.filter(Boolean).join('; ')}.` };
}

export function inArea(w: Pick<CapWarning, 'geocodes' | 'areas'>, filter: { codes?: string[]; names?: string[] }): boolean {
  return areaMatch(w, filter).ok;
}

/** Angaben einer Warnung für das Empfangsprotokoll (öffentliche Daten). */
export function warningInfo(w: CapWarning): Record<string, unknown> {
  return {
    provider: warningSource(w),
    sender: w.sender,
    identifier: w.identifier,
    headline: w.headline || w.event,
    event: w.event,
    severity: w.severity,
    urgency: w.urgency,
    msgType: w.msgType,
    areas: w.areas.slice(0, 20),
    areasTotal: w.areas.length,
    geocodes: w.geocodes.slice(0, 20),
    geocodesTotal: w.geocodes.length,
    sent: w.sent,
    onset: w.effective,
    expires: w.expires,
    references: w.references.slice(0, 10),
  };
}

async function get(c: Connection, url: string, rec?: Receipt) {
  const res = await httpRequest({ method: 'GET', url, headers: { accept: 'application/json, application/xml;q=0.9' }, timeoutMs: 20_000, maxResponseBytes: 5 * 1024 * 1024, allowPrivateHosts: allowedPrivateHosts(c) });
  if (rec) rec.httpStatus = res.status;
  if (res.status >= 400) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
  return res.text();
}

/** Eine gelieferte Meldung: gelesen (w) oder nicht lesbar (problem), immer mit den Rohdaten, wie sie kamen. */
export interface FetchedWarning {
  w: CapWarning | null;
  raw: unknown;
  problem?: string;
}

/** Alle Meldungen der Quelle samt Rohdaten abrufen (ohne zu speichern). */
export async function fetchWarningsRaw(c: Connection, rec?: Receipt): Promise<FetchedWarning[]> {
  if (c.config.format === 'nina') {
    const base = (c.config.baseUrl || DEFAULT_NINA_BASE).replace(/\/$/, '');
    const ars = String(c.config.ars ?? '').replace(/\D/g, '').padEnd(12, '0').slice(0, 5).padEnd(12, '0');
    const list = JSON.parse(await get(c, `${base}/dashboard/${ars}.json`, rec));
    const out: FetchedWarning[] = [];
    for (const item of arr(list).slice(0, 50)) {
      const id = item?.payload?.id ?? item?.id;
      if (!id) {
        out.push({ w: null, raw: item, problem: 'Eintrag im Dashboard ohne Kennung – nicht abrufbar.' });
        continue;
      }
      const detail = JSON.parse(await get(c, `${base}/warnings/${encodeURIComponent(id)}.json`, rec));
      const w = normalizeCap(detail);
      if (!w) {
        out.push({ w: null, raw: detail, problem: 'Meldung ohne Kennung (identifier) – nicht lesbar.' });
        continue;
      }
      // Das Dashboard ist bereits nach Kreis gefiltert. DWD-Meldungen enthalten in der Detailansicht oft keine Geocodes
      // und nur gekürzte Ortslisten („… und 519 weitere“) – ohne diesen Kreisbezug fiele jede Unwetterwarnung durch den
      // Gebietsfilter.
      if (!w.geocodes.includes(ars)) w.geocodes = [...w.geocodes, ars];
      out.push({ w, raw: detail });
    }
    return out;
  }
  return parseCapDocument(await get(c, c.config.url, rec)).map((raw) => {
    const w = normalizeCap(raw);
    return w ? { w, raw } : { w: null, raw, problem: 'Meldung ohne Kennung (identifier) – nicht lesbar.' };
  });
}

/** Alle Warnungen der Quelle abrufen (ohne zu speichern). */
export async function fetchWarnings(c: Connection): Promise<CapWarning[]> {
  return (await fetchWarningsRaw(c)).flatMap((f) => (f.w ? [f.w] : []));
}

export async function testWarnfeed(c: Connection) {
  const steps: TestStep[] = [];
  let preview: any = null;
  const rec = new Receipt(c.id, 'test');
  try {
    const fetched = await fetchWarningsRaw(c, rec);
    const all = fetched.flatMap((f) => (f.w ? [f.w] : []));
    steps.push({ name: 'Quelle abrufen', ok: true, message: `${all.length} Meldung(en) gelesen.${insecureFeed(c.config) ? ' Achtung: unverschlüsselt (http) – Meldungen werden nur angezeigt, automatische Banner sind nicht möglich.' : ''}`, kind: 'read' });
    const filter = c.config.areaFilter ?? {};
    const mine = all.filter((w) => inArea(w, filter));
    steps.push({ name: 'Gebietsfilter', ok: true, message: `${mine.length} von ${all.length} im eigenen Gebiet${!filter.codes?.length && !filter.names?.length ? ' (kein Filter gesetzt – alle gelten als im Gebiet)' : ''}.`, kind: 'read' });
    preview = { warnings: mine.slice(0, 10).map((w) => ({ identifier: w.identifier, msgType: w.msgType, severity: w.severity, headline: w.headline, areas: w.areas.slice(0, 5), expires: w.expires })), total: all.length };
    for (const f of fetched) {
      if (!f.w) {
        rec.add({ decision: 'error', reason: `Fehler beim Verarbeiten: ${f.problem}`, info: {}, raw: f.raw });
        continue;
      }
      const m = areaMatch(f.w, filter);
      rec.add({ decision: m.ok ? 'test' : 'filtered', reason: m.ok ? `Test – nichts gespeichert. ${m.reason}` : m.reason, info: warningInfo(f.w), raw: f.raw });
    }
    await rec.finish({ ok: true, received: fetched.length, summary: 'Verbindungstest – nichts gespeichert.' });
  } catch (e: any) {
    steps.push({ name: 'Quelle abrufen', ok: false, message: String(e?.message ?? e).slice(0, 300), kind: 'read' });
    await rec.finish({ ok: false, error: String(e?.message ?? e).slice(0, 300), received: rec.size });
  }
  return { steps, preview, capabilities: { read: steps[0]?.ok ?? false, autoBanner: !!c.config.review?.approvedAt && !insecureFeed(c.config) } };
}

const TONE: Record<string, 'info' | 'warning' | 'danger'> = { Extreme: 'danger', Severe: 'danger', Moderate: 'warning', Minor: 'info' };

/**
 * Abruf, Speichern, Aktualisierungen und Entwarnungen verarbeiten; optional Banner (nur nach fachlicher Prüfung).
 * Jeder Abruf steht im Empfangsprotokoll – mit jeder gelieferten Meldung und der Entscheidung dazu.
 */
export async function refreshWarnfeed(c: Connection, opts: { trigger?: ReceiptTrigger } = {}) {
  const rec = new Receipt(c.id, opts.trigger ?? 'scheduled');
  try {
    const r = await processWarnfeed(c, rec);
    await rec.finish({ ok: true, received: r.total + r.unreadable, summary: r.errors ? `${r.errors} Meldung(en) konnten nicht verarbeitet werden – Details im Systemprotokoll.` : null });
    return { total: r.total, added: r.added };
  } catch (e: any) {
    await rec.finish({ ok: false, error: String(e?.message ?? e).slice(0, 300), received: rec.size });
    throw e;
  }
}

async function processWarnfeed(c: Connection, rec: Receipt) {
  await disableInsecureAutoBanner(c);
  await disableAutoBannerWithoutSite(c);
  const fetched = await fetchWarningsRaw(c, rec);
  const filter = c.config.areaFilter ?? {};
  let added = 0;
  let errors = 0;
  for (const f of fetched) if (!f.w) rec.add({ decision: 'error', reason: `Fehler beim Verarbeiten: ${f.problem}`, info: {}, raw: f.raw });
  const entries = fetched.filter((f): f is FetchedWarning & { w: CapWarning } => !!f.w);
  const all = entries.map((f) => f.w);
  // Noch gelieferte Warnungen als gesehen markieren (#180): die Löschfrist greift erst, wenn die Quelle sie nicht mehr liefert
  const known = new Map<string, { dismissed: boolean }>();
  if (all.length) {
    const rows = await many<any>(`UPDATE official_warnings SET last_seen_at = now() WHERE connection_id = $1 AND identifier = ANY($2) RETURNING identifier, dismissed_at`, [c.id, all.map((w) => w.identifier)]);
    for (const r of rows) known.set(r.identifier, { dismissed: !!r.dismissed_at });
  }
  // Älteste zuerst, damit Aktualisierungen und Entwarnungen nach ihrem Original verarbeitet werden (#63)
  entries.sort((a, b) => new Date(a.w.sent ?? 0).getTime() - new Date(b.w.sent ?? 0).getTime());
  for (const { w, raw } of entries) {
    const area = areaMatch(w, filter);
    const note = (decision: ReceiptDecision, reason: string) => rec.add({ decision, reason, info: { ...warningInfo(w), inArea: area.ok }, raw });
    try {
      const row = await one<any>(
        `INSERT INTO official_warnings (connection_id, identifier, sender, sent_at, msg_type, references_ids, severity, urgency, event, headline, description, instruction, areas, geocodes, effective_at, expires_at, web_url, in_area, cancelled, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
         ON CONFLICT (connection_id, identifier) DO NOTHING RETURNING *`,
        [c.id, w.identifier, w.sender, w.sent, w.msgType, w.references, w.severity, w.urgency, w.event, w.headline, w.description, w.instruction, w.areas, w.geocodes, w.effective, w.expires, w.web, area.ok, w.msgType === 'Cancel'],
      );
      if (!row) {
        if (known.get(w.identifier)?.dismissed) note('dismissed', 'Ausgeblendet: Die Meldung wurde unter „Amtliche Warnungen“ ausgeblendet und wird nicht erneut angezeigt.');
        else note('known', `Schon bekannt (unverändert) – bei einem früheren Abruf gespeichert. ${area.reason}`);
        continue;
      }
      added++;
      // Aktualisierung oder Entwarnung ersetzt die referenzierten Meldungen
      let replaced = 0;
      if (w.references.length) {
        const prev = await many<any>(`UPDATE official_warnings SET superseded_by = $3 WHERE connection_id = $1 AND identifier = ANY($2) AND superseded_by IS NULL RETURNING *`, [c.id, w.references, row.id]);
        replaced = prev.length;
        for (const p of prev) if (p.banner_id) await endBanner(p.banner_id, w.msgType === 'Cancel' ? 'Entwarnung' : 'Aktualisierung');
      }
      // Kam eine Aktualisierung/Entwarnung schon früher an, ist diese Meldung bereits ersetzt – kein Banner (#63)
      const later = await one<any>(`SELECT id FROM official_warnings WHERE connection_id = $1 AND $2 = ANY(references_ids) AND id <> $3 ORDER BY sent_at DESC NULLS LAST LIMIT 1`, [c.id, w.identifier, row.id]);
      if (later) {
        await pool.query(`UPDATE official_warnings SET superseded_by = $2 WHERE id = $1 AND superseded_by IS NULL`, [row.id, later.id]);
        note('filtered', 'Schon ersetzt: Eine spätere Aktualisierung bzw. Entwarnung dieser Meldung ist bereits da – gespeichert, aber keine Benachrichtigung und kein Banner.');
        continue;
      }
      await emitOfficialWarning(c, row, area.ok, warningSource(w));
      const banner = area.ok && w.msgType !== 'Cancel' && autoBannerAllowed(c);
      if (area.ok && w.msgType !== 'Cancel') {
        await notify({ kind: 'warning', title: `Amtliche Warnung: ${w.headline || w.event}`.slice(0, 200), body: w.areas.slice(0, 3).join(', '), link: '/verbindungen', permission: 'official.view' });
        if (banner) await createBanner(c, row);
      }
      const effect = banner ? 'angezeigt, Benachrichtigung und automatisches Banner' : 'angezeigt und Benachrichtigung';
      if (!area.ok) note('filtered', `${area.reason} Gespeichert als „außerhalb des Gebiets“ – keine Benachrichtigung, kein Banner.`);
      else if (w.msgType === 'Cancel') note('updated', `Entwarnung${replaced ? `: beendet ${replaced} bekannte Meldung(en)` : ' zu einer unbekannten Meldung'} – angezeigt. ${area.reason}`);
      else if (replaced) note('updated', `Aktualisierung einer bekannten Meldung (ersetzt ${replaced}) – ${effect}. ${area.reason}`);
      else note('accepted', `Neu übernommen – ${effect}${w.references.length ? ' (bezieht sich auf eine unbekannte frühere Meldung)' : ''}. ${area.reason}`);
    } catch (e: any) {
      errors++;
      log('warn', 'warnfeed', `Meldung ${w.identifier} nicht verarbeitet: ${e?.message ?? e}`);
      note('error', `Fehler beim Verarbeiten: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  // Abgelaufene Warnungen: zugehörige Banner laufen auf der Website selbst ab (ends_at = expires)
  await pool.query(`UPDATE connections SET last_event_at = now(), last_error = NULL WHERE id = $1`, [c.id]);
  return { total: all.length, added, errors, unreadable: fetched.length - entries.length };
}

export function autoBannerAllowed(c: Connection) {
  return c.status === 'active' && !!c.config.autoBanner && !!c.config.review?.approvedAt && !!c.config.bannerSiteId && !insecureFeed(c.config);
}

/**
 * Bestand aus der Zeit vor #108: automatische Banner bei unverschlüsselter Quelle abschalten, auditieren und die
 * Verwaltung informieren. Die Warnungen werden weiter angezeigt (nur mit Link zur Originalquelle).
 */
async function disableInsecureAutoBanner(c: Connection) {
  if (!c.config.autoBanner || !insecureFeed(c.config)) return;
  await pool.query(`UPDATE connections SET config = config || '{"autoBanner": false}'::jsonb WHERE id = $1`, [c.id]);
  c.config = { ...c.config, autoBanner: false };
  await audit({ id: null, name: `Warnfeed „${c.name}“`, type: 'system' }, 'connection.auto_banner_disabled', { type: 'connection', id: c.id, label: c.name }, { grund: 'Quelle ohne HTTPS' });
  await notify({ kind: 'warning', title: `Warnfeed „${c.name}“: automatische Banner abgeschaltet`, body: 'Die Quelle wird über unverschlüsseltes HTTP abgerufen. Bitte eine HTTPS-Adresse eintragen.', link: `/verbindungen/${c.id}`, permission: 'connection.configure' });
}

/**
 * Automatische Banner nur für eine gekoppelte Website (#168): bannerSiteId steht ohne Fremdschlüssel im jsonb. Ist die
 * Website widerrufen, gelöscht oder nicht gekoppelt, würden Banner-Aufträge nie abgeholt – automatische Banner aus,
 * Audit und Hinweis an die Verwaltung (wie bei unverschlüsselter Quelle).
 */
async function disableAutoBannerWithoutSite(c: Connection) {
  if (!c.config.autoBanner || !c.config.bannerSiteId) return;
  const site = await one<any>(`SELECT name, status FROM wp_sites WHERE id = $1`, [c.config.bannerSiteId]);
  if (site?.status === 'active') return;
  await pool.query(`UPDATE connections SET config = config || '{"autoBanner": false}'::jsonb WHERE id = $1`, [c.id]);
  c.config = { ...c.config, autoBanner: false };
  const why = site ? `Website „${site.name}“ ist ${site.status === 'revoked' ? 'widerrufen' : 'nicht gekoppelt'}` : 'Website nicht gefunden';
  await audit({ id: null, name: `Warnfeed „${c.name}“`, type: 'system' }, 'connection.auto_banner_disabled', { type: 'connection', id: c.id, label: c.name }, { grund: why });
  await notify({ kind: 'warning', title: `Warnfeed „${c.name}“: automatische Banner abgeschaltet`, body: `${why}. Bitte eine gekoppelte Website wählen und automatische Banner wieder einschalten.`, link: `/verbindungen/${c.id}`, permission: 'connection.configure' });
}

/** Herausgebende Stelle für den Quellenvermerk (der DWD verlangt ihn nach GeoNutzV, auch bei Auszügen). */
export function warningSource(w: { sender?: string | null; identifier?: string | null }): string {
  const s = `${w.sender ?? ''} ${w.identifier ?? ''}`.toLowerCase();
  if (s.includes('dwd')) return 'Deutscher Wetterdienst';
  if (/\bmow|mowas/.test(s)) return 'MoWaS (BBK)';
  if (/\blhp|hochwasser/.test(s)) return 'Länderübergreifendes Hochwasserportal';
  if (/\bpol/.test(s)) return 'Polizei';
  if (/\bkat/.test(s)) return 'KATWARN';
  if (/\bbiw/.test(s)) return 'BIWAPP';
  return 'amtliche Warnmeldung';
}

/**
 * Bannertext zu einer amtlichen Warnung: nur Orte aus dem eigenen Gebiet (Sammelmeldungen des DWD nennen bundesweit
 * Hunderte Gemeinden – deren erste drei sagen auf der eigenen Website nichts) und immer mit Quellenvermerk.
 */
export function warningBannerText(w: { areas?: string[]; sender?: string | null; identifier?: string | null }, filter: { names?: string[] } = {}): string {
  const areas = w.areas ?? [];
  const names = (filter.names ?? []).map((n) => n.toLowerCase()).filter(Boolean);
  const mine = names.length ? areas.filter((a) => names.some((n) => a.toLowerCase().includes(n))) : areas.length <= 3 ? areas : [];
  const where = mine.slice(0, 3).join(', ');
  return `${where ? `${where} – ` : ''}Details und Verhaltenshinweise bei der Originalquelle. Quelle: ${warningSource(w)}.`.slice(0, 500);
}

async function createBanner(c: Connection, w: any) {
  const ends = w.expires_at ? new Date(w.expires_at) : new Date(Date.now() + 6 * 3600_000);
  if (ends <= new Date()) return;
  const b = {
    title: (w.headline || w.event || 'Amtliche Warnung').slice(0, 120),
    text: warningBannerText(w, c.config.areaFilter ?? {}),
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

export async function endBanner(bannerId: string, why: string) {
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
    `SELECT * FROM connections WHERE kind = 'warnfeed' AND status = 'active' AND deleted_at IS NULL
       AND (last_event_at IS NULL OR last_event_at < now() - make_interval(mins => GREATEST(2, COALESCE((config->>'intervalMinutes')::int, 5))))`,
  );
  for (const c of rows) {
    try {
      await refreshWarnfeed(c, { trigger: 'scheduled' });
    } catch (e: any) {
      await pool.query(`UPDATE connections SET last_event_at = now(), last_error = $2 WHERE id = $1`, [c.id, String(e?.message ?? e).slice(0, 300)]);
      log('warn', 'warnfeed', `Abruf „${c.name}“ fehlgeschlagen: ${e?.message ?? e}`);
    }
  }
}
