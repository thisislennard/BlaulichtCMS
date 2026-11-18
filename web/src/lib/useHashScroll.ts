import { useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * Sprung zu `#anker` nach dem Laden (React Router scrollt nicht selbst): Abschnitt in den Blick, ein Eingabefeld
 * bekommt zusätzlich den Fokus – so führen Treffer der Suche (Strg K, „Einstellung finden“) direkt zur Einstellung
 * (#256, #259). Wartet bis zu zwei Sekunden, bis der Anker gerendert ist (Daten werden nachgeladen).
 */
export function useHashScroll(ready = true) {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const id = decodeURIComponent(hash.slice(1));
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      const el = document.getElementById(id);
      if (!el) {
        if (++tries < 20) timer = window.setTimeout(attempt, 100);
        return;
      }
      const field = el.matches('input:not([type=hidden]), select, textarea, button, [role=switch]');
      el.scrollIntoView({ block: field ? 'center' : 'start', behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'auto' : 'smooth' });
      if (field) el.focus({ preventScroll: true });
    };
    timer = window.setTimeout(attempt, 50);
    return () => window.clearTimeout(timer);
  }, [ready, hash, pathname]);
}
