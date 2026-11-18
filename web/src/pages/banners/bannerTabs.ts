/**
 * Reiter der Bannerliste (#260) und ihre Zuordnung – reine Funktionen, getestet in server/test/units.test.ts.
 */
export interface BannerTabRow {
  state: string;
  revision: number;
  /** Fassung, die gerade auf der Website steht (aus dem letzten erledigten Auftrag) */
  live_revision: number | null;
}

export const BANNER_TABS: Record<string, { label: string; states: string[] | null }> = {
  alle: { label: 'Alle', states: null },
  aktiv: { label: 'Aktiv und geplant', states: ['live', 'scheduled', 'publishing', 'approved'] },
  arbeit: { label: 'In Arbeit', states: ['draft', 'in_review', 'rejected', 'failed'] },
  beendet: { label: 'Beendet', states: ['ended', 'expired'] },
};

/**
 * Steht noch eine frühere Fassung auf der Website, während die neue in Arbeit ist – z. B. nach einer Aktualisierung
 * aus einem Workflow (#274) oder einer Änderung von Hand an einem veröffentlichten Banner?
 */
export function olderRevisionLive(b: BannerTabRow): boolean {
  return b.live_revision != null && b.live_revision !== b.revision && ['draft', 'in_review', 'approved'].includes(b.state);
}

/**
 * Gehört das Banner in den Reiter? Ein Banner, dessen frühere Fassung noch auf der Website steht, zählt zusätzlich unter
 * „Aktiv und geplant“ – sonst fehlte dort, was Besucher gerade sehen.
 */
export function inBannerTab(b: BannerTabRow, tab: string): boolean {
  const states = BANNER_TABS[tab]?.states;
  if (!states) return true;
  return states.includes(b.state) || (tab === 'aktiv' && olderRevisionLive(b));
}
