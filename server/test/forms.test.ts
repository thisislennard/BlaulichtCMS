import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Formulare (#268): Pflichtfelder sind auch für Hilfsmittel als Pflicht erkennbar. `FieldWrap required` reicht
 * `aria-required` über den Feldkontext an `Input`, `Textarea` und `Select` weiter (web/src/components/ui/core.tsx) –
 * das klappt nur, wenn `htmlFor` auf ein solches Feld zeigt. Reine Quelltextprüfung ohne Browser; die Laufzeitprüfung
 * aller Dialoge macht test/e2e/focus-check.mjs (Sternchen ⇒ aria-required am Feld).
 */
const WEB = path.join(__dirname, '../../web/src');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

/** Öffnendes JSX-Tag ab `start` (Position von „<“) bis zum passenden „>“ – Klammern und Zeichenketten beachtet. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Wert eines Attributs als Quelltext (`"x"`, `{id}`, `{`${p}-x`}`) oder null. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=`).exec(tag);
  if (!m) return null;
  const at = m.index + m[0].length;
  const ch = tag[at];
  if (ch === '"' || ch === "'") return tag.slice(at, tag.indexOf(ch, at + 1) + 1);
  if (ch === '{') {
    let depth = 0;
    for (let i = at; i < tag.length; i++) {
      if (tag[i] === '{') depth++;
      else if (tag[i] === '}' && --depth === 0) return tag.slice(at, i + 1);
    }
  }
  return null;
}
const hasFlag = (tag: string, name: string) => new RegExp(`\\s${name}(\\s|=|/?>)`).test(tag) && !new RegExp(`\\s${name}=\\{false\\}`).test(tag);

/** Bausteine, die den Feldkontext lesen (useFieldA11y) bzw. aria-required selbst setzen. */
const AWARE = new Set(['Input', 'Textarea', 'Select', 'SecretField']);

describe('Pflichtfelder (#268)', () => {
  it('jedes FieldWrap mit required beschriftet ein Feld, das aria-required bekommt', () => {
    const problems: string[] = [];
    let n = 0;
    for (const file of walk(WEB)) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(WEB, file).replace(/\\/g, '/');
      if (rel === 'components/ui/core.tsx') continue;
      for (const m of src.matchAll(/<FieldWrap\b/g)) {
        const tag = openingTag(src, m.index!);
        if (!hasFlag(tag, 'required')) continue;
        n++;
        const line = src.slice(0, m.index).split('\n').length;
        const target = attr(tag, 'htmlFor');
        if (!target) {
          problems.push(`${rel}:${line}: Pflichtfeld ohne htmlFor`);
          continue;
        }
        // Feld mit derselben id im selben Quelltext
        const re = new RegExp(`<([A-Za-z][\\w.]*)\\b[^<]*?\\sid=${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
        const hit = [...src.matchAll(re)].map((x) => x[1]);
        if (!hit.length) problems.push(`${rel}:${line}: kein Feld mit id=${target}`);
        else if (!hit.some((t) => AWARE.has(t) || /^(input|textarea|select)$/.test(t))) problems.push(`${rel}:${line}: id=${target} gehört zu <${hit[0]}> – Baustein muss useFieldA11y nutzen`);
      }
    }
    expect(n).toBeGreaterThan(40);
    expect(problems).toEqual([]);
  });

  it('native Felder mit Sternchen setzen aria-required selbst', () => {
    const problems: string[] = [];
    for (const file of walk(WEB)) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(WEB, file).replace(/\\/g, '/');
      // Sternchen außerhalb von FieldWrap/SecretField: muss aria-hidden sein und ein Feld mit aria-required haben
      for (const m of src.matchAll(/<span className="text-err[^"]*"( aria-hidden="true")?[^>]*>\s*\*\s*<\/span>/g)) {
        if (rel === 'components/ui/core.tsx' || rel === 'components/ui/overlays.tsx') continue;
        const line = src.slice(0, m.index).split('\n').length;
        if (!m[1]) problems.push(`${rel}:${line}: Sternchen ohne aria-hidden`);
        // Feld mit aria-required oder – bei Auswahlknöpfen, für die aria-required nicht gilt – „(Pflichtfeld)“ als Text
        const near = src.slice(m.index, m.index! + 400);
        if (!src.includes('aria-required') && !/sr-only">\s*\(Pflichtfeld\)/.test(near)) problems.push(`${rel}:${line}: Sternchen ohne aria-required bzw. „(Pflichtfeld)“ für Hilfsmittel`);
      }
    }
    expect(problems).toEqual([]);
  });
});
