import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from './ui/Icon';

/**
 * Hinweis bei fehlender Verbindung. Freigaben und Veröffentlichungen gelten erst, wenn der Server sie
 * bestätigt hat. Nach der Wiederverbindung wird der bestätigte Stand neu geladen.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const qc = useQueryClient();
  useEffect(() => {
    const on = () => {
      setOnline(true);
      qc.invalidateQueries();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [qc]);
  if (online) return null;
  return (
    <div role="status" className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[100] bg-warn text-black rounded-card px-4 py-2 shadow-float text-sm flex items-center gap-2 max-w-[92vw]">
      <Icon name="AlertTriangle" size={16} />
      Keine Verbindung. Aktionen gelten erst nach Bestätigung durch den Server – bitte nach der Wiederverbindung erneut ausführen.
    </div>
  );
}
