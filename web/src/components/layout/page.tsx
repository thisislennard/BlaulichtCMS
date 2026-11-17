import { createContext, useContext, type ReactNode } from 'react';

/**
 * Seitentitel und Hilfe der aktuellen Seite (vom App-Rahmen bereitgestellt). `PageHeader` zeigt daraus die h1 und das
 * „?“ zum passenden Hilfe-Kapitel – so stimmen Menüpunkt, Seitentitel, Brotkrumen und Fenstertitel überein (#250, #267).
 * Eigene Datei, damit `components/ui/core` den Rahmen nicht importieren muss.
 */
export interface PageInfo {
  /** sichtbarer Seitentitel: `usePageMeta({ title })` oder die Menübezeichnung */
  title: string;
  /** „?“ zum Hilfe-Kapitel; `topic` überschreibt die Zuordnung aus der Navigation, `false` blendet es aus */
  renderHelp: (topic?: string | false) => ReactNode;
}

export const PageInfoCtx = createContext<PageInfo>({ title: '', renderHelp: () => null });

export function usePageInfo(): PageInfo {
  return useContext(PageInfoCtx);
}
