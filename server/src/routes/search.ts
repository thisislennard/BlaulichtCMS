import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { getSettings } from '../lib/settings.js';

/**
 * Suche der Befehlspalette (Strg K, #259) über alle Bereiche, die das Konto lesen darf. Jede Art fragt nur mit dem
 * passenden Leserecht ab; ohne Recht gibt es aus diesem Bereich keinen Treffer. Vergleich ohne Groß-/Kleinschreibung
 * und mit vereinheitlichten Umlauten (ö = oe = o, ß = ss = s), alle Suchwörter müssen vorkommen; Treffer am
 * Wortanfang zuerst. Vorgangsnummern (P-2026-0001, W-2026-0001) führen direkt zum Vorgang.
 *
 * Einstellungen und Hilfe durchsucht die Oberfläche selbst (web/src/config/settingsIndex.ts, Hilfe-Index).
 */

/** Vereinheitlichung wie in web/src/lib/searchText.ts (server/test/search.test.ts prüft, dass beide gleich sind). */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[àáâãå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõ]/g, 'o')
    .replace(/[ùúû]/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 's')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/ss/g, 's');
}

/** Dieselbe Vereinheitlichung als SQL-Ausdruck (Reihenfolge wie foldText). */
export function foldSql(expr: string): string {
  let e = `lower(coalesce(${expr}, ''))`;
  e = `translate(${e}, 'àáâãåèéêëìíîïòóôõùúûçäöüß', 'aaaaaeeeeiiiioooouuucaous')`;
  for (const [a, b] of [['ae', 'a'], ['oe', 'o'], ['ue', 'u'], ['ss', 's']]) e = `replace(${e}, '${a}', '${b}')`;
  return e;
}

/** Suchwörter (höchstens fünf); LIKE-Sonderzeichen werden maskiert. */
export function searchTerms(q: string): string[] {
  return foldText(q)
    .split(/\s+/)
    .map((t) => t.replace(/[\\%_]/g, (c) => `\\${c}`))
    .filter(Boolean)
    .slice(0, 5);
}

export const CASE_NO = /^\s*([PW])-(\d{4})-(\d{1,6})\s*$/i;

export interface SearchHit {
  type: string;
  group: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  exact?: boolean;
}

interface Source {
  type: string;
  group: string;
  perm: string;
  /** SELECT … FROM … [WHERE …] ohne ORDER/LIMIT; Spalten id, title, subtitle, at */
  from: string;
  /** Felder, in denen gesucht wird (SQL-Ausdrücke); das erste ist der Titel für die Rangfolge */
  fields: string[];
  href: (r: any, tz: string) => string;
  /** gefilterte Liste („Alle Treffer in …“) */
  all?: (q: string) => string;
  /** zusätzliche Bedingung der Quelle */
  where?: string;
}

/** Tag eines Zeitpunkts in der Zeitzone der Instanz (TT.MM.JJJJ). */
const fmtDate = (v: Date | string, tz: string) => new Date(v).toLocaleDateString('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
const enc = encodeURIComponent;

const SOURCES: Source[] = [
  { type: 'post', group: 'Beiträge', perm: 'post.view', from: `SELECT id, title, 'Beitrag' AS subtitle, updated_at AS at FROM posts`, where: 'archived_at IS NULL', fields: ['title'], href: (r) => `/beitraege/${r.id}`, all: (q) => `/beitraege?suche=${enc(q)}` },
  {
    type: 'press',
    group: 'Presse',
    perm: 'press.view',
    from: `SELECT id, topic AS title, case_no || CASE WHEN outlet <> '' THEN ' · ' || outlet ELSE '' END AS subtitle, updated_at AS at FROM press_requests`,
    fields: ['topic', 'case_no', 'outlet'],
    href: (r) => `/presse/${r.id}`,
    all: (q) => `/presse?filter=all&suche=${enc(q)}`,
  },
  {
    type: 'incident',
    group: 'Einsatzliste',
    perm: 'incident.view',
    from: `SELECT id, coalesce(nullif(title, ''), nullif(keyword_label, ''), keyword, 'Einsatz') AS title, concat_ws(' · ', nullif(keyword, ''), nullif(location, ''), to_char(alarm_at AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY')) AS subtitle, alarm_at AS at FROM incident_entries`,
    fields: ['title', 'keyword', 'keyword_label', 'location', `number::text`],
    href: (r) => `/einsatzliste?suche=${enc(r.title)}`,
    all: (q) => `/einsatzliste?suche=${enc(q)}`,
  },
  {
    type: 'event',
    group: 'Kalender',
    perm: 'calendar.view',
    from: `SELECT id, title, location AS subtitle, starts_at AS at FROM calendar_events`,
    where: 'recurrence_id IS NULL',
    fields: ['title', 'location'],
    href: (r) => `/kalender?termin=${r.id}`,
  },
  {
    type: 'warning',
    group: 'Warnentwürfe',
    perm: 'warning.view',
    from: `SELECT w.id, coalesce(nullif(r.data->>'headline', ''), w.case_no) AS title, w.case_no AS subtitle, w.updated_at AS at FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision`,
    where: 'w.archived_at IS NULL',
    fields: [`r.data->>'headline'`, 'w.case_no', `r.keyword->>'code'`, `r.keyword->>'label'`],
    href: (r) => `/warnungen/${r.id}`,
    all: (q) => `/warnungen?suche=${enc(q)}`,
  },
  { type: 'collection', group: 'Medien', perm: 'media.view', from: `SELECT id, title, 'Sammlung' AS subtitle, created_at AS at FROM collections`, where: 'archived_at IS NULL', fields: ['title', 'purpose'], href: (r) => `/medien/${r.id}`, all: (q) => `/medien?suche=${enc(q)}` },
  { type: 'design', group: 'Designvorlagen', perm: 'templates.view', from: `SELECT id, title, CASE WHEN kind = 'image' THEN 'Bildvorlage' ELSE 'Designvorlage' END AS subtitle, updated_at AS at FROM design_templates`, fields: ['title', 'description', `array_to_string(tags, ' ')`], href: (r) => `/designvorlagen/${r.id}`, all: (q) => `/designvorlagen?suche=${enc(q)}` },
  { type: 'banner', group: 'Banner', perm: 'banner.view', from: `SELECT id, title, 'Banner' AS subtitle, updated_at AS at FROM banners`, fields: ['title', 'text'], href: (r) => `/banner?banner=${r.id}`, all: (q) => `/banner?suche=${enc(q)}` },
  { type: 'automation', group: 'Workflows', perm: 'automation.read', from: `SELECT id, name AS title, 'Workflow' AS subtitle, updated_at AS at FROM automations`, where: 'deleted_at IS NULL', fields: ['name', 'description'], href: (r) => `/workflows/${r.id}`, all: (q) => `/workflows?suche=${enc(q)}` },
  { type: 'connection', group: 'Verbindungen', perm: 'connection.configure', from: `SELECT id, name AS title, kind AS subtitle, updated_at AS at FROM connections`, where: `deleted_at IS NULL AND status <> 'revoked'`, fields: ['name', 'kind'], href: (r) => `/verbindungen/${r.id}`, all: (q) => `/verbindungen?suche=${enc(q)}` },
  { type: 'site', group: 'Websites', perm: 'channel.view', from: `SELECT id, name AS title, 'Website' AS subtitle, created_at AS at FROM wp_sites`, where: `status <> 'revoked'`, fields: ['name'], href: () => '/websites' },
  { type: 'template', group: 'Beitragsvorlagen', perm: 'post.templates', from: `SELECT id, name AS title, 'Beitragsvorlage' AS subtitle, created_at AS at FROM post_templates`, where: 'archived_at IS NULL', fields: ['name', 'title'], href: () => '/beitragsvorlagen' },
  { type: 'release', group: 'Pressemitteilungen', perm: 'press.release', from: `SELECT id, subject AS title, 'Pressemitteilung' AS subtitle, updated_at AS at FROM press_releases`, fields: ['subject'], href: (r) => `/presse/mitteilungen?id=${r.id}`, all: (q) => `/presse/mitteilungen?suche=${enc(q)}` },
  { type: 'user', group: 'Personen', perm: 'user.view', from: `SELECT id, name AS title, email AS subtitle, created_at AS at FROM users`, fields: ['name', 'email'], href: (r) => `/benutzer?suche=${enc(r.subtitle || r.title)}`, all: (q) => `/benutzer?suche=${enc(q)}` },
];

/** Höchstens so viele Treffer je Bereich; einer mehr zeigt „Alle Treffer in …“ an. */
export const PER_GROUP = 5;

async function searchSource(src: Source, terms: string[], tz: string): Promise<{ hits: SearchHit[]; more: boolean }> {
  const hay = foldSql(src.fields.map((f) => `coalesce(${f}, '')`).join(` || ' ' || `));
  const title = foldSql(src.fields[0]);
  const params: string[] = [];
  const conds = terms.map((t) => (params.push(`%${t}%`), `${hay} LIKE $${params.length}`));
  params.push(`${terms[0]}%`, `% ${terms[0]}%`);
  const n = params.length;
  const rows = await many<any>(
    `SELECT * FROM (${src.from} WHERE ${[src.where ?? 'true', ...conds].join(' AND ')}
       ORDER BY CASE WHEN ${title} LIKE $${n - 1} THEN 0 WHEN ${hay} LIKE $${n - 1} OR ${hay} LIKE $${n} THEN 1 ELSE 2 END, at DESC NULLS LAST
       LIMIT ${PER_GROUP + 1}) x`,
    params,
  );
  return {
    hits: rows.slice(0, PER_GROUP).map((r) => ({ type: src.type, group: src.group, id: String(r.id), title: r.title || '–', subtitle: src.type === 'event' && r.at ? [fmtDate(r.at, tz), r.subtitle].filter(Boolean).join(' · ') : (r.subtitle ?? ''), href: src.href(r, tz) })),
    more: rows.length > PER_GROUP,
  };
}

/** Suche für ein Konto mit diesen Rechten (auch für Tests ohne HTTP). */
export async function searchAll(perms: Set<string>, q: string): Promise<{ results: SearchHit[]; more: Record<string, string> }> {
  const terms = searchTerms(q);
  const results: SearchHit[] = [];
  const more: Record<string, string> = {};
  // Vorgangsnummer: direkt zum Vorgang (nur mit Leserecht)
  const m = CASE_NO.exec(q);
  if (m) {
    const caseNo = `${m[1].toUpperCase()}-${m[2]}-${m[3].padStart(4, '0')}`;
    if (m[1].toUpperCase() === 'P' && perms.has('press.view'))
      for (const r of await many<any>(`SELECT id, topic, case_no FROM press_requests WHERE case_no = $1`, [caseNo]))
        results.push({ type: 'press', group: 'Presse', id: r.id, title: r.topic, subtitle: r.case_no, href: `/presse/${r.id}`, exact: true });
    if (m[1].toUpperCase() === 'W' && perms.has('warning.view'))
      for (const r of await many<any>(`SELECT id, case_no FROM warnings WHERE case_no = $1`, [caseNo]))
        results.push({ type: 'warning', group: 'Warnentwürfe', id: r.id, title: r.case_no, subtitle: 'Warnentwurf', href: `/warnungen/${r.id}`, exact: true });
  }
  if (terms.length) {
    const tz = String((await getSettings())['general.timezone'] || 'Europe/Berlin');
    const found = await Promise.all(SOURCES.filter((s) => perms.has(s.perm)).map(async (s) => ({ s, r: await searchSource(s, terms, tz) })));
    for (const { s, r } of found) {
      for (const h of r.hits) if (!results.some((x) => x.type === h.type && x.id === h.id)) results.push(h);
      if (r.more && s.all) more[s.group] = s.all(q.trim());
    }
  }
  return { results, more };
}

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', { preHandler: requireAuth() }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    return searchAll(req.auth!.permissions, q);
  });
}
