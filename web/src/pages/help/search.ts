/* Volltextsuche über alle Hilfekapitel (Abschnitte je Überschrift) und die Katalog-Referenz. */
import { CHAPTERS, CONTENT, chapterDoc, chapterSummary, chapterTitle, stripInline } from './chapters';

export interface SearchDoc {
  chapter: string;
  /** Anker der Überschrift (leer = Kapitelanfang) */
  anchor: string;
  heading: string;
  text: string;
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  snippet: { before: string; match: string; after: string };
}

/** Längenerhaltende Normalisierung (Umlaute → Grundbuchstabe), damit Positionen übertragbar bleiben. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äà-å]/g, 'a')
    .replace(/[öò-ö]/g, 'o')
    .replace(/[üù-û]/g, 'u')
    .replace(/ß/g, 's')
    .replace(/[éèê]/g, 'e');
}

function plain(md: string): string {
  return md
    .split(/\r?\n/)
    .filter((l) => !/^\s*(```|~~~)/.test(l) && !/^\s*\|?\s*:?-{3,}/.test(l))
    .map((l) => stripInline(l.replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, '').replace(/\\\|/g, '¦').replace(/\|/g, ' ').replace(/¦/g, '|')))
    .join(' ')
    .replace(/kbd:/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let cached: SearchDoc[] | null = null;

/**
 * Dokumente aus den Markdown-Kapiteln: Kapitelanfang + je H2/H3 ein Abschnitt. Die Anker stammen aus derselben
 * Zerlegung wie die Darstellung (`chapterDoc`), Treffer springen also genau auf den Abschnitt.
 */
export function markdownDocs(): SearchDoc[] {
  if (cached) return cached;
  const docs: SearchDoc[] = [];
  for (const ch of CHAPTERS) {
    if (!CONTENT[ch.slug]) continue;
    for (const c of chapterDoc(ch.slug).chunks) {
      const text = plain(c.id ? c.text : `${chapterSummary(ch.slug)}\n${c.text}`);
      if (text || !c.id) docs.push({ chapter: ch.slug, anchor: c.id, heading: c.id ? c.heading : chapterTitle(ch.slug), text });
    }
  }
  cached = docs;
  return docs;
}

export function terms(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function snippetFor(text: string, ts: string[]): SearchHit['snippet'] {
  const f = fold(text);
  let pos = -1;
  let len = 0;
  for (const tm of ts) {
    const i = f.indexOf(tm);
    if (i >= 0 && (pos < 0 || i < pos)) {
      pos = i;
      len = tm.length;
    }
  }
  if (pos < 0) return { before: text.slice(0, 160), match: '', after: text.length > 160 ? '…' : '' };
  const start = Math.max(0, pos - 60);
  const end = Math.min(text.length, pos + len + 100);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, pos),
    match: text.slice(pos, pos + len),
    after: text.slice(pos + len, end) + (end < text.length ? '…' : ''),
  };
}

export function search(query: string, docs: SearchDoc[], limit = 30): SearchHit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const phrase = fold(query.trim());
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const title = fold(chapterTitle(doc.chapter));
    const head = fold(doc.heading);
    const body = fold(doc.text);
    let score = 0;
    let all = true;
    for (const tm of ts) {
      const inTitle = title.includes(tm);
      const inHead = head.includes(tm);
      const inBody = body.includes(tm);
      if (!inTitle && !inHead && !inBody) {
        all = false;
        break;
      }
      score += (inTitle ? 6 : 0) + (inHead ? 8 : 0) + (inBody ? 1 + Math.min(4, body.split(tm).length - 1) * 0.5 : 0);
    }
    if (!all) continue;
    if (ts.length > 1 && (head.includes(phrase) || body.includes(phrase))) score += 6;
    if (!doc.anchor) score += 1;
    hits.push({ doc, score, snippet: snippetFor(doc.text || doc.heading, ts) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
