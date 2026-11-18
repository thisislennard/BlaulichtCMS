import { many, pool, type Queryable } from '../db/pool.js';
import { TEMPLATES, type TemplateDef, type TemplateRequirement } from './templates.js';

/**
 * Stand der Voraussetzungen je Workflow-Vorlage (#263): Der Dialog „Neuer Workflow“ zeigt vor dem Anlegen, was fehlt
 * (z. B. FE2-Verbindung, Website, Bildvorlage), und verlinkt die Seite zum Einrichten. Vorlagen mit fehlender
 * Voraussetzung bleiben wählbar – der Workflow lässt sich anlegen und später vervollständigen.
 */
export interface RequirementStatus {
  key: string;
  label: string;
  met: boolean;
  /** Was vorhanden ist bzw. was fehlt (kurz) */
  detail: string;
  /** Seite zum Einrichten und das Recht, das sie verlangt (die Oberfläche zeigt den Link nur mit diesem Recht) */
  fix: { path: string; label: string; permission: string };
}

const CONNECTION_LABEL: Record<string, string> = { fe2: 'FE2', feuersoftware: 'Feuersoftware Connect', warnfeed: 'Amtliche Warnungen' };

const keyOf = (r: TemplateRequirement) => (r.kind === 'connection' ? `connection:${r.connectionKinds.join('+')}` : r.kind === 'calendar_category' || r.kind === 'keyword_category' ? `${r.kind}:${r.name}` : r.kind);

const quoted = (names: string[], max = 2) => names.slice(0, max).map((n) => `„${n}“`).join(', ') + (names.length > max ? ` und ${names.length - max} weitere` : '');

interface Facts {
  connections: { kind: string; name: string; status: string }[];
  sites: { name: string; status: string }[];
  imageTemplates: { title: string }[];
  calendarCategories: { name: string }[];
  keywordCategories: { category: string; n: number }[];
}

async function loadFacts(db: Queryable): Promise<Facts> {
  const [connections, sites, imageTemplates, calendarCategories, keywordCategories] = await Promise.all([
    many<any>(`SELECT kind, name, status FROM connections WHERE deleted_at IS NULL AND kind IN ('fe2','feuersoftware','warnfeed') ORDER BY name`, [], db),
    many<any>(`SELECT name, status FROM wp_sites WHERE status <> 'revoked' ORDER BY name`, [], db),
    many<any>(`SELECT title FROM design_templates WHERE kind = 'image' AND layout IS NOT NULL ORDER BY lower(title)`, [], db),
    many<any>(`SELECT name FROM calendar_categories ORDER BY position, lower(name)`, [], db),
    many<any>(`SELECT category, count(*)::int AS n FROM fire_keywords WHERE active AND category <> '' GROUP BY category`, [], db),
  ]);
  return { connections, sites, imageTemplates, calendarCategories, keywordCategories };
}

function evaluate(r: TemplateRequirement, f: Facts): RequirementStatus {
  const key = keyOf(r);
  switch (r.kind) {
    case 'connection': {
      const label = r.connectionKinds.map((k) => CONNECTION_LABEL[k]).join(' oder ');
      const all = f.connections.filter((c) => (r.connectionKinds as string[]).includes(c.kind));
      const active = all.filter((c) => c.status === 'active');
      const fix = { path: '/verbindungen', label: r.connectionKinds.includes('warnfeed') ? 'Warnquelle einrichten' : 'Verbinden', permission: 'connection.configure' };
      if (active.length) return { key, label, met: true, detail: quoted(active.map((c) => c.name)), fix };
      return { key, label, met: false, detail: all.length ? `${quoted(all.map((c) => c.name))} eingerichtet, aber nicht aktiv` : 'noch keine Verbindung', fix };
    }
    case 'website': {
      const active = f.sites.filter((s) => s.status === 'active');
      const fix = { path: '/websites', label: 'Website koppeln', permission: 'channel.sites' };
      if (active.length) return { key, label: 'Website', met: true, detail: quoted(active.map((s) => s.name)), fix };
      return { key, label: 'Website', met: false, detail: f.sites.length ? 'Kopplung noch nicht abgeschlossen' : 'noch keine Website gekoppelt', fix };
    }
    case 'image_template': {
      const fix = { path: '/designvorlagen', label: 'Bildvorlage gestalten', permission: 'templates.manage' };
      return f.imageTemplates.length
        ? { key, label: 'Bildvorlage', met: true, detail: quoted(f.imageTemplates.map((t) => t.title)), fix }
        : { key, label: 'Bildvorlage', met: false, detail: 'noch keine befüllbare Bildvorlage', fix };
    }
    case 'calendar_category': {
      const fix = { path: '/kalender', label: 'Kategorie anlegen', permission: 'calendar.manage' };
      const label = `Kalender-Kategorie „${r.name}“`;
      const met = f.calendarCategories.some((c) => c.name.trim().toLocaleLowerCase('de') === r.name.toLocaleLowerCase('de'));
      return { key, label, met, detail: met ? 'vorhanden' : 'fehlt (Kalender → „Kategorien“)', fix };
    }
    case 'keyword_category': {
      const fix = { path: '/stichwoerter-regeln', label: 'Stichwörter einrichten', permission: 'warning.rules' };
      const label = `Stichwörter der Kategorie „${r.name}“`;
      const hit = f.keywordCategories.find((c) => c.category.trim().toLocaleLowerCase('de') === r.name.toLocaleLowerCase('de'));
      return { key, label, met: !!hit, detail: hit ? `${hit.n} ${hit.n === 1 ? 'Stichwort' : 'Stichwörter'}` : 'noch keine (Verzeichnis des Landes übernehmen oder Liste importieren)', fix };
    }
  }
}

/** Voraussetzungen aller Vorlagen mit Stand (eine Abfrage je Art, nicht je Vorlage). */
export async function templateRequirements(templates: TemplateDef[] = TEMPLATES, db: Queryable = pool): Promise<Record<string, RequirementStatus[]>> {
  const f = await loadFacts(db);
  return Object.fromEntries(templates.map((t) => [t.id, t.requires.map((r) => evaluate(r, f))]));
}
