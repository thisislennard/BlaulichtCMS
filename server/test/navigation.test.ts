import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_PATHS, PAGE_HELP, activeNavId, navigation } from '../../web/src/config/navigation.js';

/*
 * Gliederung der Oberfläche (#250), Hilfe-Zugang je Seite (#265) und Menüpfade in Hinweisen (#257): reine
 * Strukturprüfungen ohne Datenbank und Browser.
 */
const WEB = path.join(__dirname, '../../web/src');
const read = (p: string) => fs.readFileSync(path.join(WEB, p), 'utf8');
const de = (file: string) => JSON.parse(read(`i18n/de/${file}.json`));
const nav = de('nav');
const help = de('help');
const label = (key: string) => nav[key.replace(/^nav\./, '')] as string;
const CONTENT = path.join(WEB, 'pages/help/content');
const chapterFiles = fs.readdirSync(CONTENT).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

/** Anker wie in der Hilfe (chapters.ts: slugify + eindeutig je Kapitel). */
function anchors(slug: string): Set<string> {
  const { parseChapter } = chaptersMod;
  return new Set(parseChapter(fs.readFileSync(path.join(CONTENT, `${slug}.md`), 'utf8')).headings.map((h: { id: string }) => h.id));
}
const chaptersMod = await import('../../web/src/pages/help/chapters.js');

/** Routen aus App.tsx (Pfade ohne führenden Schrägstrich, mit :parametern). */
const appSrc = read('App.tsx');
const routes = [...appSrc.matchAll(/path: '([^']+)'/g)].map((m) => `/${m[1].replace(/^\//, '')}`);
function isRoute(p: string): boolean {
  const clean = p.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  if (Object.keys(LEGACY_PATHS).some((l) => clean === l || clean.startsWith(`${l}/`))) return false;
  if (clean === '/presse/einstellungen') return false;
  return routes.some((r) => {
    if (r.endsWith('/*')) return false;
    const re = new RegExp(`^${r.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
    return re.test(clean);
  });
}

describe('Navigation (#250)', () => {
  it('höchstens 6 Bereiche mit je höchstens 7 Punkten, eindeutige IDs und Pfade', () => {
    expect(navigation.length).toBeLessThanOrEqual(6);
    for (const g of navigation) expect(g.items.length, g.group).toBeLessThanOrEqual(7);
    const items = navigation.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length);
  });

  it('jeder Bereich und Menüpunkt hat eine deutsche Bezeichnung, jede Adresse eine Route', () => {
    for (const g of navigation) {
      expect(typeof label(g.group), g.group).toBe('string');
      for (const it of g.items) {
        expect(typeof label(it.label), it.label).toBe('string');
        expect(isRoute(it.path), it.path).toBe(true);
      }
    }
  });

  it('frühere Adressen leiten auf bestehende Routen weiter und sind selbst kein Menüpunkt mehr', () => {
    for (const [from, to] of Object.entries(LEGACY_PATHS)) {
      expect(isRoute(to), `${from} → ${to}`).toBe(true);
      expect(navigation.flatMap((g) => g.items).some((i) => i.path === from)).toBe(false);
      expect(appSrc).toContain('LegacyRedirect');
    }
    expect(appSrc).toContain("path: 'presse/einstellungen'");
  });

  it('aktiver Menüpunkt: längster Präfix, Unterseiten gehören zu ihrem Menüpunkt', () => {
    expect(activeNavId('/')).toBe('dashboard');
    expect(activeNavId('/presse/textbausteine')).toBe('pressSnippets');
    expect(activeNavId('/presse/0a1b')).toBe('pressRequests');
    expect(activeNavId('/presse-postfach')).toBe('pressMailbox');
    expect(activeNavId('/workflows/ausloeser')).toBe('automations');
    expect(activeNavId('/medien/papierkorb')).toBe('media');
    expect(activeNavId('/hilfe/presse')).toBeNull();
  });
});

describe('Einstellungen auf Unterseiten (#256)', async () => {
  const { SETTINGS_PAGES, LEGACY_SETTINGS_ANCHORS } = await import('../../web/src/config/settingsPages.js');
  const settingsSrc = read('pages/admin/Settings.tsx');

  it('jede Unterseite hat eine Route, Inhalt, ein Hilfe-Kapitel und ein Recht zum Ändern aus dem Katalog', async () => {
    const { PERMISSION_IDS } = await import('../src/auth/permissions.js');
    expect(isRoute('/einstellungen/organisation')).toBe(true);
    expect(activeNavId('/einstellungen/e-mail')).toBe('settings');
    expect(new Set(SETTINGS_PAGES.map((p: { id: string }) => p.id)).size).toBe(SETTINGS_PAGES.length);
    for (const p of SETTINGS_PAGES) {
      // Eintrag in CONTENT (Settings.tsx): organisation: () => … bzw. 'e-mail': () => …
      expect(settingsSrc, p.id).toMatch(new RegExp(`(^|\\s)'?${p.id}'?: \\(\\) =>`, 'm'));
      const [slug, anchor] = p.help.split('#');
      expect(chapterFiles, `${p.id}: Kapitel ${slug}`).toContain(slug);
      if (anchor) expect([...anchors(slug)], `${p.id}: ${p.help}`).toContain(anchor);
      for (const perm of [...p.edit, ...(p.view ?? [])]) expect(PERMISSION_IDS, `${p.id}: ${perm}`).toContain(perm);
    }
  });

  it('frühere Anker der einen Einstellungsseite leiten auf bestehende Seiten weiter', () => {
    for (const a of ['allgemein', 'darstellung', 'redaktion', 'datenschutz', 'medien', 'betrieb', 'sicherheit', 'benachrichtigungen', 'sicherung', 'sicherung-ausser-haus', 'updates', 'ueber']) {
      const to = LEGACY_SETTINGS_ANCHORS[a];
      expect(to, a).toBeTruthy();
      expect(isRoute(to), `${a} → ${to}`).toBe(true);
    }
    expect(settingsSrc).toContain('LEGACY_SETTINGS_ANCHORS');
  });

  it('keine persönliche Einstellung mehr unter den Instanz-Einstellungen', () => {
    const dir = path.join(WEB, 'pages/admin/settings');
    const all = [settingsSrc, ...fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))].join('\n');
    expect(all).not.toContain('AppearanceFields');
  });
});

describe('Hilfe je Seite (#265)', () => {
  it('jeder Menüpunkt nennt ein vorhandenes Kapitel (und ggf. einen vorhandenen Abschnitt)', () => {
    for (const it of [...navigation.flatMap((g) => g.items), ...Object.entries(PAGE_HELP).map(([p, h]) => ({ id: p, help: h }))]) {
      const [slug, anchor] = it.help.split('#');
      expect(chapterFiles, `${it.id}: Kapitel ${slug}`).toContain(slug);
      if (anchor) expect([...anchors(slug)], `${it.id}: Abschnitt ${it.help}`).toContain(anchor);
    }
  });

  it('jedes Kapitel steht in genau einer Gruppe und hat Titel und Kurzbeschreibung', () => {
    const grouped = chaptersMod.GROUPS.flatMap((g: { chapters: { slug: string }[] }) => g.chapters.map((c) => c.slug));
    expect([...grouped].sort()).toEqual([...chapterFiles].sort());
    for (const slug of chapterFiles) {
      expect(help.chapters[slug]?.title, slug).toBeTruthy();
      expect(help.chapters[slug]?.summary, slug).toBeTruthy();
    }
    for (const g of chaptersMod.GROUPS) expect(help.groups[g.id], g.id).toBeTruthy();
  });

  it('Hilfe-Gruppen folgen der Menügliederung', () => {
    const groupLabels = chaptersMod.GROUPS.map((g: { id: string }) => help.groups[g.id]);
    for (const g of navigation) expect(groupLabels, label(g.group)).toContain(label(g.group));
  });
});

describe('Menüpfade in Hilfe und Hinweisen (#257)', () => {
  const groupByLabel = new Map(navigation.map((g) => [label(g.group), g]));

  it('Links der Hilfe auf Seiten der App zeigen auf bestehende Adressen, „Bereich → Punkt“ entspricht dem Menü', () => {
    const problems: string[] = [];
    for (const slug of chapterFiles) {
      const md = fs.readFileSync(path.join(CONTENT, `${slug}.md`), 'utf8');
      for (const m of md.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)) {
        const [, text, target] = m;
        // Hilfe-Kapitel, API und statische Dateien (Schema, Downloads) sind keine Seiten der App
        if (target.startsWith('/hilfe') || target.startsWith('/api/') || /\.[a-z]+$/.test(target.split(/[?#]/)[0])) continue;
        if (!isRoute(target)) problems.push(`${slug}: ${target} ist keine (aktuelle) Adresse`);
        const parts = text.split(' → ').map((x) => x.trim());
        const g = groupByLabel.get(parts[0]);
        if (parts.length > 1 && g) {
          const it = g.items.find((i) => label(i.label) === parts[1]);
          if (!it) problems.push(`${slug}: „${text}“ – „${parts[1]}“ steht nicht unter ${parts[0]}`);
          else if (target.split(/[?#]/)[0] !== it.path && !target.startsWith(`${it.path}/`)) problems.push(`${slug}: „${text}“ verlinkt ${target} statt ${it.path}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('Links aus Benachrichtigungen und Datenschutzauskunft des Servers zeigen auf bestehende Adressen', () => {
    const SRC = path.join(__dirname, '../src');
    const problems: string[] = [];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
    for (const f of walk(SRC)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:link|href|linkSql):\s*`?'(\/[a-z0-9\-/]*)['?#]/g)) {
        if (m[1].startsWith('/api/') || m[1].startsWith('/u/') || m[1] === '/') continue;
        if (!isRoute(m[1]) && !routes.some((r) => r.includes(':') && m[1].startsWith(r.split('/:')[0] + '/'))) problems.push(`${path.relative(SRC, f)}: ${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('Begriffe (#257): verbotene Schreibweisen in Oberfläche und Hilfe', () => {
  /** Quelltexte der Oberfläche ohne Kommentare, Hilfe-Kapitel und deutsche Übersetzungen. */
  function texts(): { file: string; lines: string[] }[] {
    const out: { file: string; lines: string[] }[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'en') walk(p);
        } else if (/\.(tsx?|md|json)$/.test(e.name)) {
          let src = fs.readFileSync(p, 'utf8');
          if (!e.name.endsWith('.md') && !e.name.endsWith('.json')) src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
          out.push({ file: path.relative(WEB, p), lines: src.split('\n') });
        }
      }
    };
    walk(WEB);
    return out;
  }
  const RULES: [RegExp, string, RegExp?][] = [
    [/\b(Kanal|Kanäle|Kanälen|Kanals|Zielkanal|Zielkanäle)\b/, '„Website“, „soziale Netzwerke“ bzw. „Veröffentlichungsziele“', /whatsapp/i],
    [/\b(Eingänge|Ausgänge|Ausgängen|Eingängen)\b/, '„Auslöser“ bzw. „Aktionen“', /FE2|HTTP/],
    [/Foto-Link/, '„Upload-Link“'],
    [/Medien sammeln|Fotos und Videos sammeln/, '„Fotos sammeln“'],
    [/Update-Kanal/, '„Update-Stufe“'],
    // Deutsches Wort mit Klammerendung („Datei(en)“, „Freigabe(n)“, „zuständige(n)“); Aufrufe wie String(e) sind ausgenommen
    [/(^|[\s>{}"'`(])(?!(String|Number|Boolean|Set|Map|Error|Date|Array|Object|Promise|JSON|Symbol)\()([A-ZÄÖÜ][a-zäöüß-]{2,}|[a-zäöüß]+ige)\((e|en|n|er|s|nen)\)(?![\w.])/, 'plural(n, …) statt Behelfsplural'],
  ];
  it('keine Behelfsplurale und keine alten Bezeichnungen', () => {
    const problems: string[] = [];
    for (const { file, lines } of texts()) {
      lines.forEach((l, i) => {
        for (const [re, instead, allow] of RULES) if (re.test(l) && !(allow && allow.test(l))) problems.push(`${file}:${i + 1}: ${l.trim().slice(0, 90)} → ${instead}`);
      });
    }
    expect(problems).toEqual([]);
  });
});
