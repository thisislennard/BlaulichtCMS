import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Live-Status: Server-Sent Events melden, welche Tabellen sich geändert haben. Betroffene Ansichten laden
 * danach den bestätigten Stand über die API. Nach einer Unterbrechung wird alles neu geladen.
 */
type LiveState = 'connecting' | 'live' | 'reconnecting' | 'off';
const Ctx = createContext<LiveState>('off');

/**
 * Leistung (#192): Änderungen höchstens einmal pro Sekunde in Neuladen umsetzen – bei vielen Uploads meldet der Server
 * mehrere Änderungen pro Sekunde, und jede Person lud sonst Dashboard und Sammlungen jedes Mal neu. Verborgene Tabs
 * schließen die Live-Verbindung nach einer Minute: Ohne HTTP/2 erlaubt der Browser nur 6 Verbindungen je Server, und
 * jeder offene Tab hielte eine davon dauerhaft – ab dem sechsten Tab hinge die Oberfläche. Beim Zurückkehren wird neu
 * verbunden und alles neu geladen.
 */
const INVALIDATE_DELAY_MS = 1000;
const HIDDEN_CLOSE_MS = 60_000;

const MAP: Record<string, string[][]> = {
  posts: [['posts'], ['post'], ['dashboard']],
  post_revisions: [['posts'], ['post'], ['dashboard']],
  approvals: [['posts'], ['post'], ['dashboard']],
  publications: [['posts'], ['post'], ['dashboard'], ['sites']],
  media: [['collection'], ['collections'], ['dashboard']],
  collections: [['collection'], ['collections'], ['dashboard']],
  banners: [['banners'], ['dashboard']],
  banner_jobs: [['banners'], ['dashboard']],
  incident_entries: [['incidents'], ['dashboard']],
  incident_jobs: [['incidents'], ['dashboard']],
  wp_sites: [['sites'], ['dashboard'], ['setup-checklist']],
  notifications: [['notifications']],
  rss_items: [['rss'], ['dashboard']],
  warnings: [['warnings'], ['warning'], ['dashboard']],
  warning_revisions: [['warnings'], ['warning'], ['dashboard']],
  warning_approvals: [['warnings'], ['warning'], ['dashboard']],
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
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingKeys = new Set<string>();
    const flush = () => {
      flushTimer = null;
      for (const k of pendingKeys) qc.invalidateQueries({ queryKey: JSON.parse(k) });
      pendingKeys.clear();
    };
    const open = () => {
      retry = null;
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
          for (const t of tables) for (const k of MAP[t] ?? []) pendingKeys.add(JSON.stringify(k));
          if (pendingKeys.size && !flushTimer) flushTimer = setTimeout(flush, INVALIDATE_DELAY_MS);
        } catch {
          /* ungültiges Ereignis */
        }
      });
      es.onerror = () => {
        if (!es) return;
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
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!hiddenTimer) {
          hiddenTimer = setTimeout(() => {
            hiddenTimer = null;
            wasDown = true;
            if (retry) clearTimeout(retry);
            retry = null;
            const old = es;
            es = null;
            old?.close();
            setState('reconnecting');
          }, HIDDEN_CLOSE_MS);
        }
        return;
      }
      if (hiddenTimer) clearTimeout(hiddenTimer);
      hiddenTimer = null;
      if (!es && !retry && navigator.onLine !== false) open();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    open();
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
      if (retry) clearTimeout(retry);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      if (flushTimer) clearTimeout(flushTimer);
      setState('off');
    };
  }, [enabled, qc]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useLive() {
  return useContext(Ctx);
}
