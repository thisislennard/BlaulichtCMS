import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Verweis auf einen einzelnen Eintrag einer Liste (#252, #258): Benachrichtigungen und Aktivitäten verlinken z. B.
 * `/banner?banner=<id>` oder `/einsatzliste?eintrag=<id>`. Liefert die ID aus dem Parameter und holt das Element
 * `#<prefix>-<id>` einmal in den sichtbaren Bereich, sobald die Liste geladen ist (`ready`). Hervorheben übernimmt die
 * Seite selbst (z. B. Rahmen in der Primärfarbe), damit es zum jeweiligen Layout passt.
 */
export function useLinkedItem(param: string, ready: boolean, prefix: string = param): { id: string | null; clear: () => void } {
  const [params, setParams] = useSearchParams();
  const id = params.get(param);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !ready || done.current === id) return;
    const el = document.getElementById(`${prefix}-${id}`);
    if (!el) return;
    done.current = id;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [id, ready, prefix]);
  const clear = () => {
    const next = new URLSearchParams(params);
    next.delete(param);
    setParams(next, { replace: true });
  };
  return { id, clear };
}
