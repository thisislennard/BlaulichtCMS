import { many, one, type Queryable, pool } from '../db/pool.js';

/**
 * Warnstufen-Assistent (#41). Ein Vorschlag entsteht nur, wenn die Angaben EINDEUTIG zu fachlich freigegebenen
 * Regeln passen. Sonst: „Keine eindeutige Empfehlung – fachlich prüfen“. Ein fehlender Vorschlag ist nie eine Entwarnung.
 */
export interface Suggestion {
  level: 1 | 2 | 3 | null;
  status: 'suggested' | 'no_keyword' | 'unknown_keyword' | 'no_rules' | 'incomplete' | 'conflict' | 'no_match';
  reason: string;
  rules: { id: string; version: number; name: string; level: number; reason: string }[];
  missing: { key: string; text: string }[];
  evaluatedAt: string;
}

export const NO_RECOMMENDATION = 'Keine eindeutige Empfehlung – fachlich prüfen';
const UNKNOWN_ANSWERS = new Set(['', 'unbekannt']);

export async function activeQuestions(keywordId: string, db: Queryable = pool) {
  return many<any>(`SELECT id, key, text, options, sort FROM keyword_questions WHERE keyword_id = $1 AND approved_at IS NOT NULL AND retired_at IS NULL ORDER BY sort, text`, [keywordId], db);
}

export async function evaluate(keywordId: string | null, answers: Record<string, string>, db: Queryable = pool): Promise<Suggestion> {
  const base = { rules: [], missing: [], evaluatedAt: new Date().toISOString() };
  if (!keywordId) return { ...base, level: null, status: 'no_keyword', reason: `${NO_RECOMMENDATION}: kein Stichwort angegeben.` };
  const kw = await one<any>(`SELECT * FROM fire_keywords WHERE id = $1 AND active`, [keywordId], db);
  if (!kw) return { ...base, level: null, status: 'unknown_keyword', reason: `${NO_RECOMMENDATION}: Stichwort ist nicht (mehr) hinterlegt.` };
  const rules = await many<any>(`SELECT * FROM warning_rules WHERE keyword_id = $1 AND status = 'approved' ORDER BY name, version DESC`, [keywordId], db);
  if (!rules.length) return { ...base, level: null, status: 'no_rules', reason: `${NO_RECOMMENDATION}: Für „${kw.code}“ ist keine fachlich freigegebene Regel hinterlegt.` };
  const questions = new Map((await activeQuestions(keywordId, db)).map((q) => [q.key, q]));

  const matched: any[] = [];
  const incomplete: { rule: any; missing: string[] }[] = [];
  for (const r of rules) {
    const conds = Object.entries(r.conditions as Record<string, string[]>);
    let fails = false;
    const missing: string[] = [];
    for (const [key, allowed] of conds) {
      const a = (answers[key] ?? '').trim().toLowerCase();
      // Eine Regel auf eine nicht (mehr) freigegebene Frage kann nie zutreffen
      if (!questions.has(key)) {
        fails = true;
        break;
      }
      if (UNKNOWN_ANSWERS.has(a)) missing.push(key);
      else if (!allowed.map((x) => x.toLowerCase()).includes(a)) {
        fails = true;
        break;
      }
    }
    if (fails) continue;
    if (missing.length) incomplete.push({ rule: r, missing });
    else matched.push(r);
  }

  const view = (r: any) => ({ id: r.id, version: r.version, name: r.name, level: r.level, reason: r.reason });
  const missingQs = (keys: string[]) => [...new Set(keys)].map((k) => ({ key: k, text: questions.get(k)?.text ?? k }));
  const levels = [...new Set(matched.map((r) => r.level))];
  if (levels.length > 1) {
    return { ...base, level: null, status: 'conflict', rules: matched.map(view), reason: `${NO_RECOMMENDATION}: Widersprüchliche Regeln (${matched.map((r) => `„${r.name}“ v${r.version} → Stufe ${r.level}`).join(', ')}).` };
  }
  // Könnte eine noch unvollständig beantwortete Regel zu einer anderen Stufe führen, ist der Vorschlag nicht eindeutig
  const otherIncomplete = incomplete.filter((i) => !levels.length || i.rule.level !== levels[0]);
  if (otherIncomplete.length) {
    const miss = missingQs(otherIncomplete.flatMap((i) => i.missing));
    return { ...base, level: null, status: 'incomplete', missing: miss, rules: matched.map(view), reason: `${NO_RECOMMENDATION}: Angaben fehlen (${miss.map((m) => m.text).join('; ')}).` };
  }
  if (!matched.length) return { ...base, level: null, status: 'no_match', reason: `${NO_RECOMMENDATION}: Keine freigegebene Regel passt zur angegebenen Lage.` };
  const lvl = levels[0] as 1 | 2 | 3;
  return {
    ...base,
    level: lvl,
    status: 'suggested',
    rules: matched.map(view),
    reason: matched.map((r) => `${r.reason} (Regel „${r.name}“, Version ${r.version})`).join(' · '),
  };
}
