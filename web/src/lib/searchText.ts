/**
 * Textvergleich der Suche (Strg K, #259): ohne Groß-/Kleinschreibung, Umlaute vereinheitlicht (ö = oe = o,
 * ß = ss = s). Gleiche Regeln wie der Server (server/src/routes/search.ts, foldText) – server/test/search.test.ts
 * prüft, dass beide dasselbe liefern.
 */
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

export function searchTerms(q: string): string[] {
  return foldText(q).split(/\s+/).filter(Boolean).slice(0, 5);
}

/**
 * Rangzahl eines Texts für die Suchwörter (kleiner = besser) oder null, wenn nicht alle vorkommen: 0 = Titel beginnt
 * mit dem ersten Wort, 1 = ein Wort beginnt damit, 2 = irgendwo enthalten; `extra` (Schlagworte) zählt wie der Text.
 */
export function rank(terms: string[], title: string, extra = ''): number | null {
  if (!terms.length) return null;
  const t = foldText(title);
  const hay = `${t} ${foldText(extra)}`;
  if (!terms.every((x) => hay.includes(x))) return null;
  if (t.startsWith(terms[0])) return 0;
  if (hay.startsWith(terms[0]) || hay.includes(` ${terms[0]}`) || hay.includes(`-${terms[0]}`)) return 1;
  return 2;
}
