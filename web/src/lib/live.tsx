import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Live-Status: Server-Sent Events melden, welche Tabellen sich geändert haben. Betroffene Ansichten laden
 * danach den bestätigten Stand über die API. Nach einer Unterbrechung wird alles neu geladen.
 */
type LiveState = 'connecting' | 'live' | 'reconnecting' | 'off';
const Ctx = createContext<LiveState>('off');

const MAP: Record<string, string[][]> = {
  posts: [['posts'], ['post'], ['dashboard']],
  post_revisions: [['posts'], ['post'], ['dashboard']],
  approvals: [['posts'], ['post'], ['dashboard']],
  publications: [['posts'], ['post'], ['dashboard'], ['sites']],
  media: [['collection'], ['collections'], ['dashboard']],
  collections: [['collection'], ['collections'], ['dashboard']],
  banners: [['banners'], ['dashboard']],
  banner_jobs: [['banners'], ['dashboard']],
  wp_sites: [['sites'], ['dashboard']],
  notifications: [['notifications']],
  rss_items: [['rss'], ['dashboard']],
  warnings: [['warnings'], ['warning']],
  warning_revisions: [['warnings'], ['warning']],
  warning_approvals: [['warnings'], ['warning']],
  warning_sends: [['warnings'], ['warning'], ['dashboard']],
  social_publications: [['post'], ['posts']],
  connections: [['connections'], ['connection'], ['social-targets']],
  official_warnings: [['official-warnings'], ['dashboard']],
  fe2_events: [['fe2-events'], ['posts']],
  // Rollen geändert: eigene Rechte, Navigation und Rollenliste sofort neu laden
  roles: [['me'], ['roles'], ['users']],
};

export function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('off');
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let wasDown = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      setState(wasDown ? 'reconnecting' : 'connecting');
      es = new EventSource('/api/v1/events');
      es.addEventListener('hello', () => {
        setState('live');
        // Nach einer Unterbrechung den bestätigten Stand vollständig neu laden
        if (wasDown) qc.invalidateQueries();
        wasDown = false;
      });
      es.addEventListener('change', (e) => {
        try {
          const { tables } = JSON.parse((e as MessageEvent).data) as { tables: string[] };
          const keys = new Set<string>();
          for (const t of tables) for (const k of MAP[t] ?? []) keys.add(JSON.stringify(k));
          for (const k of keys) qc.invalidateQueries({ queryKey: JSON.parse(k) });
        } catch {
          /* ungültiges Ereignis */
        }
      });
      es.onerror = () => {
        wasDown = true;
        setState('reconnecting');
        es?.close();
        retry = setTimeout(open, 3000);
      };
    };
    // Netzwechsel (z. B. WLAN → Mobilfunk) sofort erkennen statt auf den Abbruch der alten Verbindung zu warten
    const onOffline = () => {
      wasDown = true;
      setState('reconnecting');
      es?.close();
      if (retry) clearTimeout(retry);
    };
    const onOnline = () => {
      if (retry) clearTimeout(retry);
      es?.close();
      open();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    open();
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      es?.close();
      if (retry) clearTimeout(retry);
      setState('off');
    };
  }, [enabled, qc]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useLive() {
  return useContext(Ctx);
}
