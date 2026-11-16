import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { CATALOGS, catalogInfo, NO_CATALOG_TEXT, OWN_LIST, STATES, stateName } from '../keywords/catalog.js';
import { activeKeywords, exportKeywords, importOwnList, parseKeywordList, syncCatalog } from '../keywords/store.js';

/**
 * Stichwortverzeichnis (#195): aktive Liste zum Nachschlagen (Warnentwurf, Automationen, Einsatzmeldungen),
 * Übernahme des Landesverzeichnisses, Import und Export der eigenen Liste. Das Land selbst ist eine allgemeine
 * Einstellung (`general.state`, routes/system.ts).
 */
export async function keywordRoutes(app: FastifyInstance) {
  app.get('/keywords', { preHandler: requireAnyAuth('warning.view', 'automation.read', 'connection.view') }, async () => {
    const state = String((await getSettings())['general.state'] ?? '');
    const entries = await activeKeywords();
    return {
      state,
      stateName: stateName(state),
      states: STATES.map((s) => ({ id: s.id, name: s.name, catalog: !!CATALOGS[s.id], hinweis: s.hinweis ?? null })),
      catalog: catalogInfo(state),
      noCatalogText: state && state !== OWN_LIST && !CATALOGS[state] ? NO_CATALOG_TEXT : null,
      entries: entries.map((k) => ({ code: k.code, label: k.label, category: k.category, details: k.details, source: k.source, aliases: k.aliases })),
    };
  });

  app.post('/keywords/sync', { preHandler: requireAuth('warning.rules') }, async (req) => {
    const state = String((await getSettings())['general.state'] ?? '');
    if (!CATALOGS[state]) throw badRequest('Für das eingestellte Land ist kein Verzeichnis hinterlegt.');
    const r = await syncCatalog(state, { activate: false });
    await audit(req.auth!.actor, 'keywords.catalog_synced', { type: 'keyword', label: stateName(state) }, { version: CATALOGS[state].version, neu: r.added, geaendert: r.updated, deaktiviert: r.deactivated, eigene: r.ownKept });
    return r;
  });

  app.post('/keywords/import', { preHandler: requireAuth('warning.rules'), bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const b = z.object({ text: z.string().max(2_000_000), dryRun: z.boolean().default(false) }).parse(req.body);
    const { rows, errors } = parseKeywordList(b.text);
    if (!rows.length) throw badRequest(errors[0] ?? 'Die Datei enthält keine Einträge.');
    if (b.dryRun) return { rows: rows.length, errors };
    const r = await importOwnList(rows, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'keywords.imported', { type: 'keyword', label: `${rows.length} Einträge` }, { neu: r.added, geaendert: r.updated, unveraendert: r.unchanged, fehler: errors.length });
    return { ...r, errors };
  });

  app.get('/keywords/export', { preHandler: requireAuth('warning.view') }, async (req, reply) => {
    const { format } = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    const body = await exportKeywords(format);
    reply
      .header('content-type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="stichwoerter.${format}"`)
      .header('cache-control', 'no-store');
    return body;
  });
}
