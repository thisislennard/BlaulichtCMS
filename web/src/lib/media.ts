import { useSyncExternalStore } from 'react';

/** Handy-Breite wie Tailwinds `md` (unter 768 px): untere Leiste, Listen als Karten (#264). */
export const PHONE_QUERY = '(max-width: 767.98px)';

/** Trifft die Medienabfrage gerade zu? Folgt Änderungen (Drehen, Fenstergröße) ohne eigenen Zustand. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);
