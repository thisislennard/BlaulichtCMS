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
  ]),
  G('channels', [
    ['wordpress', 'Globe'],
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

/** H2/H3 eines Markdown-Textes (ohne Codeblöcke). */
export function headingsOf(md: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const text = stripInline(m[2]);
      out.push({ level: m[1].length as 2 | 3, text, id: slugify(text) });
    }
  }
  return out;
}
