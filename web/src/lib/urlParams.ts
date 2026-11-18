import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Übernimmt `?suche=…` (Suche Strg K → „Alle Treffer in …“, #259) in das Suchfeld einer Liste – auch wenn die Liste
 * schon offen ist und nur die Adresse wechselt.
 */
export function useSucheParam(apply: (q: string) => void) {
  const [params] = useSearchParams();
  const q = params.get('suche');
  useEffect(() => {
    if (q != null) apply(q);
    // apply ist meist ein Setter oder eine Inline-Funktion – nur die Adresse steuert
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
}
