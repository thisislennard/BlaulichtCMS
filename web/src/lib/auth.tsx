import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, get, patch, post, setUnauthorizedHandler } from '../api/client';
import type { Me, Preferences } from '../api/types';
import { setTimeZone } from './format';
import { setLanguage } from '../i18n';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  /** Sitzung konnte nicht geprüft werden (Server nicht erreichbar, Zeitüberschreitung, Wartung) – nicht „abgemeldet“. */
  error: unknown;
  retry: () => void;
  can: (perm: string) => boolean;
  canAny: (...perms: string[]) => boolean;
  isPlatformAdmin: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setPreferences: (p: Partial<Preferences>) => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
    // Öffentliche Seiten (Upload, Datenschutz, Impressum): ohne Konto – keine Sitzungsabfrage (sonst 401 in der Konsole)
    enabled: !/^\/(u\/|datenschutz$|impressum$)/.test(window.location.pathname),
  });
  const me = q.data ?? null;

  useEffect(() => {
    // Sitzung abgelaufen: alle zwischengespeicherten Daten verwerfen (geteiltes Handy, #69); die Anmeldeseite sagt
    // warum und führt danach zur selben Seite zurück (#194)
    setUnauthorizedHandler(() => {
      if (qc.getQueryData(['me'])) markSessionExpired();
      clearSession(qc);
    });
  }, [qc]);

  useEffect(() => {
    if (me?.instance) {
      setTimeZone(me.instance.timezone);
      setLanguage(me.user.preferences.language ?? 'de');
      document.title = `${me.instance.name === 'BlaulichtCMS' ? '' : me.instance.name + ' · '}BlaulichtCMS`;
    }
  }, [me]);

  const perms = useMemo(() => new Set(me?.stage === 'full' ? me.permissions : []), [me]);
  const can = useCallback((p: string) => perms.has(p), [perms]);
  const canAny = useCallback((...ps: string[]) => ps.some((p) => perms.has(p)), [perms]);

  const value: AuthValue = {
    me,
    loading: q.isLoading,
    error: q.data === undefined ? q.error : null,
    retry: () => void q.refetch(),
    can,
    canAny,
    isPlatformAdmin: !!me?.user.roles.includes('platform_admin') && me.stage === 'full',
    // Direkt laden und setzen: funktioniert auch, nachdem der Zwischenspeicher geleert wurde (Anmeldung, 2FA, Einladung)
    refresh: async () => {
      qc.setQueryData(['me'], await fetchMe());
    },
    logout: async () => {
      await post('/auth/logout').catch(() => {});
      clearSession(qc);
    },
    setPreferences: async (p) => {
      qc.setQueryData<Me | null>(['me'], (old) => (old ? { ...old, user: { ...old.user, preferences: { ...old.user.preferences, ...p } } } : old));
      await patch('/auth/preferences', p);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth außerhalb des AuthProvider');
  return v;
}

/** Setzt data-theme / reduzierte Bewegung / kompakte Tabellen am <html>. */
export function ThemeSync() {
  const { me, loading } = useAuth();
  const prefs = me?.user.preferences ?? {};
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  useEffect(() => {
    // Während die Sitzung lädt, das vor dem Rendern gesetzte Schema behalten (kein Aufblitzen).
    if (loading) return;
    // Ohne Anmeldung (Upload-Seite, Login) gilt die Geräteeinstellung – draußen nachts oft dunkel.
    const theme = me ? (prefs.theme ?? 'light') : 'system';
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.reducedMotion = prefs.reducedMotion ? 'true' : 'false';
    document.documentElement.classList.toggle('bc-compact', !!prefs.compactTables);
    try {
      if (me) localStorage.setItem('bc-theme', resolved);
    } catch {
      /* egal */
    }
  }, [loading, me, prefs.theme, prefs.reducedMotion, prefs.compactTables, systemDark]);
  return null;
}

async function fetchMe(): Promise<Me | null> {
  try {
    return await get<Me>('/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** Hinweis „Sitzung abgelaufen“ für die Anmeldeseite (einmalig, nur in diesem Tab). */
const EXPIRED_KEY = 'bc-session-expired';
export function markSessionExpired() {
  try {
    sessionStorage.setItem(EXPIRED_KEY, '1');
  } catch {
    /* egal */
  }
}
/** Steht der Hinweis „Sitzung abgelaufen“ an? Gelöscht wird er mit dem Rückweg nach der Anmeldung (takeReturnTo). */
export function takeSessionExpired(): boolean {
  try {
    return sessionStorage.getItem(EXPIRED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Rückweg nach der Anmeldung (auch über die 2FA-Schritte): nur Pfade dieser App, keine fremden Adressen. */
const RETURN_KEY = 'bc-return-to';
/** Eigener Pfad: beginnt mit genau einem „/“, ohne „//“, Backslash oder Steuerzeichen (keine offene Weiterleitung). */
const ownPath = (p: string) => /^\/(?![/\\])[^\\\s]*$/.test(p);
export function setReturnTo(path: string | undefined | null) {
  try {
    if (path && ownPath(path) && !/^\/(login|2fa|einrichtung|einladung)/.test(path)) sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* egal */
  }
}
export function takeReturnTo(): string {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    sessionStorage.removeItem(EXPIRED_KEY);
    return v && ownPath(v) ? v : '/';
  } catch {
    return '/';
  }
}

/**
 * Sitzung beenden: alle Daten der bisherigen Person verwerfen (geteiltes Handy, #69) und den Anmeldezustand auf
 * „abgemeldet“ setzen. Die Sitzungsabfrage bleibt erhalten, damit angezeigte Seiten sofort zur Anmeldung wechseln.
 */
export function clearSession(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  qc.setQueryData(['me'], null);
}
