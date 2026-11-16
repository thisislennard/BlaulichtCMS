import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { get, onConnectionChange, type ConnectionState } from '../api/client';
import { Button } from './ui/core';
import { Icon } from './ui/Icon';
import { FEEDBACK } from './feedback/Feedback';

type Shown = { kind: 'offline' | 'unreachable' | 'timeout' } | { kind: 'maintenance'; message: string } | null;

/**
 * Verbindungsrückmeldung (#194): offline, Server nicht erreichbar, Zeitüberschreitung und Wartung als Leiste unten.
 * Bei fehlender Verbindung wird automatisch erneut geprüft (5 s, 10 s, 20 s, dann alle 30 s) und nach der
 * Wiederverbindung der bestätigte Stand neu geladen. Freigaben und Veröffentlichungen gelten erst, wenn der Server sie
 * bestätigt hat.
 */
export function OfflineBanner() {
  const qc = useQueryClient();
  const [shown, setShown] = useState<Shown>(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? { kind: 'offline' } : null));
  const [checking, setChecking] = useState(false);
  const [next, setNext] = useState<number | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const off = onConnectionChange((s: ConnectionState) => {
      const cur = shownRef.current;
      if (s.state === 'ok') {
        // Wartung bleibt sichtbar (Lesen geht weiter), bis sie geschlossen wird oder abläuft
        if (cur && cur.kind !== 'maintenance') {
          setShown(null);
          qc.invalidateQueries();
        }
      } else if (s.state === 'maintenance') setShown({ kind: 'maintenance', message: s.message });
      else setShown({ kind: navigator.onLine === false ? 'offline' : s.kind });
    });
    const goOnline = () => check();
    const goOffline = () => setShown({ kind: 'offline' });
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      off();
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [qc]);

  const check = async () => {
    setChecking(true);
    try {
      await get('/auth/state'); // meldet bei Erfolg „verbunden“
    } catch {
      /* bleibt angezeigt */
    } finally {
      setChecking(false);
    }
  };

  // Automatisch erneut prüfen, solange keine Verbindung besteht
  const down = shown && shown.kind !== 'maintenance';
  useEffect(() => {
    if (!down) return setNext(null);
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    let tick: ReturnType<typeof setInterval>;
    const plan = () => {
      const delay = Math.min(30, 5 * 2 ** attempt++);
      const until = Date.now() + delay * 1000;
      setNext(delay);
      clearInterval(tick);
      tick = setInterval(() => setNext(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 1000);
      timer = setTimeout(async () => {
        await check();
        plan();
      }, delay * 1000);
    };
    plan();
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [down]);

  // Wartungshinweis nach zwei Minuten ausblenden (die nächste abgelehnte Änderung zeigt ihn erneut)
  useEffect(() => {
    if (shown?.kind !== 'maintenance') return;
    const t = setTimeout(() => setShown(null), 120_000);
    return () => clearTimeout(t);
  }, [shown]);

  if (!shown) return null;
  const d = FEEDBACK[shown.kind];
  const text =
    shown.kind === 'offline'
      ? 'Aktionen gelten erst nach Bestätigung durch den Server – bitte nach der Wiederverbindung erneut ausführen.'
      : shown.kind === 'maintenance'
        ? shown.message || d.text
        : d.text;
  return (
    <div role="status" aria-live="polite" data-connection={shown.kind} className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[100] bg-card text-fg border border-warn/60 rounded-card px-4 py-3 shadow-float text-sm flex items-start gap-3 w-[min(640px,92vw)]">
      <Icon name={d.icon} size={18} className="text-warn shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <strong className="font-semibold">{d.title}</strong>
        <span className="text-fg-muted">{text}</span>
        {down && next != null && <span className="text-meta text-fg-muted font-mono">{checking ? 'Prüfe Verbindung …' : `Nächster Versuch in ${next} s`}</span>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {down && (
          <Button size="sm" icon="RefreshCw" loading={checking} onClick={check}>
            Erneut versuchen
          </Button>
        )}
        {shown.kind === 'maintenance' && (
          <button type="button" aria-label="Hinweis schließen" onClick={() => setShown(null)} className="w-8 h-8 inline-flex items-center justify-center rounded-chip text-fg-muted hover:bg-raised">
            <Icon name="X" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
