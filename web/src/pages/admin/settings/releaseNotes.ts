/**
 * Versionshinweise für das Update-Protokoll (#278): Statt der technischen Meldung („Migrationen: …“) zeigt das Protokoll
 * je Update, was die Version gebracht hat. Die Texte kommen aus `release-notes/vX.Y.Z.md` im Repository und werden beim
 * Bauen der Oberfläche als eigene, erst bei Bedarf geladene Dateien mitgeliefert – auch für ältere Updates, ohne Abruf
 * bei GitHub.
 */
const FILES = import.meta.glob('../../../../../release-notes/v*.md', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const byVersion = new Map<string, () => Promise<string>>();
for (const [p, load] of Object.entries(FILES)) {
  const m = /v(\d+\.\d+\.\d+)\.md$/.exec(p);
  if (m) byVersion.set(m[1], load);
}

export function hasReleaseNotes(version: string): boolean {
  return byVersion.has(version);
}

/** Abschnitte, die nur beim Einspielen zählen – im Rückblick weglassen. */
const SKIP = /^(so spielst du das update ein|nach dem update|vor dem update|update einspielen|von \d)/i;

/**
 * Für den Rückblick aufbereiten: Überschrift „BlaulichtCMS x.y.z“ weg, Anleitungen zum Einspielen weg, Unterüberschriften
 * eine Stufe tiefer (passen so in die Tabelle).
 */
export function summarizeReleaseNotes(md: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length <= 2 && /^BlaulichtCMS\s+\d/.test(h[2])) continue;
      skip = SKIP.test(h[2].replace(/\*\*/g, '').trim());
      if (skip) continue;
      out.push(`#### ${h[2]}`);
      continue;
    }
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function releaseNotesFor(version: string): Promise<string | null> {
  const load = byVersion.get(version);
  if (!load) return null;
  return summarizeReleaseNotes(await load());
}
