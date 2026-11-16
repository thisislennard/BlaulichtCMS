/* Kapitelverzeichnis der Hilfe. Inhalte liegen als Markdown unter ./content/<slug>.md,
   Titel und Kurzbeschreibungen in i18n/<sprache>/help.json (chapters.<slug>). */
import { t } from '../../i18n';

const files = import.meta.glob<string>('./content/*.md', { query: '?raw', import: 'default', eager: true });

/** Markdown-Text je Kapitel-Slug. */
export const CONTENT: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.replace(/^.*\/([\w-]+)\.md$/, '$1'), text]),
);

export interface Chapter {
  slug: string;
  group: string;
  icon: string;
}

export interface ChapterGroup {
  id: string;
  chapters: Chapter[];
}

const G = (id: string, list: [string, string][]): ChapterGroup => ({
  id,
  chapters: list.map(([slug, icon]) => ({ slug, group: id, icon })),
});

export const GROUPS: ChapterGroup[] = [
  G('basics', [
    ['erste-schritte', 'Sparkles'],
    ['anmeldung', 'Lock'],
    ['app', 'Smartphone'],
  ]),
  G('work', [
    ['foto-link', 'Camera'],
    ['sichtung', 'CheckSquare'],
    ['beitraege', 'FileText'],
    ['freigabe', 'ShieldCheck'],
    ['qr-codes', 'QrCode'],
    ['dashboard', 'LayoutDashboard'],
    ['quellen', 'Newspaper'],
  ]),
  G('warnings', [
    ['warnentwurf', 'Siren'],
    ['stichwoerter-regeln', 'ListChecks'],
  ]),
  G('channels', [
    ['wordpress', 'Globe'],
    ['verbindungen', 'Plug'],
    ['automationen', 'Workflow'],
    ['banner', 'Megaphone'],
    ['ohne-website', 'Unlink'],
  ]),
  G('admin', [
    ['benutzer-rollen', 'Users'],
    ['einrichtung', 'Settings'],
    ['sicherheit', 'Lock'],
    ['sicherung', 'HardDrive'],
    ['updates', 'Download'],
  ]),
  G('reference', [
    ['fehlerbehebung', 'LifeBuoy'],
    ['tastatur', 'Keyboard'],
    ['begriffe', 'BookOpen'],
  ]),
];

export const CHAPTERS: Chapter[] = GROUPS.flatMap((g) => g.chapters);

export function chapterBySlug(slug: string | undefined): Chapter | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function chapterTitle(slug: string): string {
  return t(`help.chapters.${slug}.title`);
}

export function chapterSummary(slug: string): string {
  return t(`help.chapters.${slug}.summary`);
}

export function groupTitle(id: string): string {
  return t(`help.groups.${id}`);
}

/* --------------------------------- Überschriften ----------------------------------- */

/** Anker-ID aus Überschriftentext („Zeitfenster ±5 min“ → „zeitfenster-5-min“). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Markdown-Inline-Auszeichnung entfernen (für Anker, Suche, Inhaltsverzeichnis). */
export function stripInline(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/__([^_]+)__/g, '$1')
    .trim();
}

export interface Heading {
  level: 2 | 3;
  text: string;
  id: string;
}

export interface SubHeading {
  level: 3 | 4;
  text: string;
  id: string;
  /** Zeile innerhalb von `Section.body` (1-basiert, wie remark sie zählt) */
  line: number;
}

export interface Section {
  /** laufende Nummer (1, 2, …) */
  number: number;
  id: string;
  /** Überschrift ohne Auszeichnung */
  text: string;
  /** Überschrift mit Markdown-Auszeichnung (für die Darstellung) */
  raw: string;
  /** Markdown zwischen dieser und der nächsten H2 */
  body: string;
  subs: SubHeading[];
}

/** Suchabschnitt: Text unter einer H2/H3 bis zur nächsten H2/H3 (H4 zählt zum Abschnitt darüber). */
export interface Chunk {
  id: string;
  heading: string;
  text: string;
}

export interface ChapterDoc {
  /** Markdown vor der ersten H2 (Einleitung) */
  intro: string;
  sections: Section[];
  /** H2/H3 in Reihenfolge (Inhaltsverzeichnis) */
  headings: Heading[];
  /** Einleitung (id = '') und je H2/H3 ein Abschnitt (Volltextsuche) */
  chunks: Chunk[];
}

const isFence = (line: string) => /^\s*(```|~~~)/.test(line);
const HEADING = /^(#{2,4})\s+(.+?)\s*#*\s*$/;

/**
 * Zerlegt ein Kapitel in Einleitung und nummerierte Abschnitte (je H2). Anker sind stabil (Umlaute → ae/oe/ue/ss) und
 * innerhalb des Kapitels eindeutig: Doppelte Überschriften erhalten -2, -3 … Dieselbe Zerlegung nutzen Darstellung,
 * Inhaltsverzeichnis und Suche, damit Suchtreffer genau auf den Abschnitt springen.
 */
export function parseChapter(md: string): ChapterDoc {
  const lines = md.split(/\r?\n/);
  const used = new Set<string>();
  const uniqueId = (text: string) => {
    const base = slugify(text) || 'abschnitt';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const marks: { index: number; level: 2 | 3 | 4; text: string; raw: string; id: string }[] = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (isFence(line)) fence = !fence;
    if (fence) return;
    const m = HEADING.exec(line);
    if (m) {
      const text = stripInline(m[2]);
      marks.push({ index, level: m[1].length as 2 | 3 | 4, text, raw: m[2], id: uniqueId(text) });
    }
  });
  const nl = '\n';
  const h2 = marks.filter((m) => m.level === 2);
  const intro = lines.slice(0, h2.length ? h2[0].index : lines.length).join(nl).trim();
  const sections: Section[] = h2.map((m, i) => {
    const start = m.index + 1;
    const end = i + 1 < h2.length ? h2[i + 1].index : lines.length;
    return {
      number: i + 1,
      id: m.id,
      text: m.text,
      raw: m.raw,
      body: lines.slice(start, end).join(nl),
      subs: marks.filter((s) => s.level > 2 && s.index > m.index && s.index < end).map((s) => ({ level: s.level as 3 | 4, text: s.text, id: s.id, line: s.index - start + 1 })),
    };
  });
  const toc = marks.filter((m) => m.level <= 3);
  const chunks: Chunk[] = [{ id: '', heading: '', text: lines.slice(0, toc.length ? toc[0].index : lines.length).join(nl) }];
  toc.forEach((m, i) => chunks.push({ id: m.id, heading: m.text, text: lines.slice(m.index + 1, i + 1 < toc.length ? toc[i + 1].index : lines.length).join(nl) }));
  return { intro, sections, headings: toc.map((m) => ({ level: m.level as 2 | 3, text: m.text, id: m.id })), chunks };
}

const parsed = new Map<string, ChapterDoc>();

/** Zerlegtes Kapitel (zwischengespeichert). */
export function chapterDoc(slug: string): ChapterDoc {
  let d = parsed.get(slug);
  if (!d) {
    d = parseChapter(CONTENT[slug] ?? '');
    parsed.set(slug, d);
  }
  return d;
}

/** H2/H3 eines Markdown-Textes (ohne Codeblöcke). */
export function headingsOf(md: string): Heading[] {
  return parseChapter(md).headings;
}
