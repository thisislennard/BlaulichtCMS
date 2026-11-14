import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, patch, post, setUnauthorizedHandler } from '../api/client';
import type { Me, Preferences } from '../api/types';
import { setTimeZone } from './format';
import { setLanguage } from '../i18n';

interface AuthValue {
  me: Me | null;
  loading: boolean;
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
    queryFn: async () => {
      try {
        return await get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const me = q.data ?? null;

  useEffect(() => {
    setUnauthorizedHandler(() => qc.setQueryData(['me'], null));
  }, [qc]);

  useEffect(() => {
    if (me?.instance) {
      setTimeZone(me.instance.timezone);
      setLanguage(me.user.preferences.language ?? 'de');
      document.title = `${me.instance.name === 'LifeLink' ? '' : me.instance.name + ' · '}LifeLink`;
    }
  }, [me]);

  const perms = useMemo(() => new Set(me?.stage === 'full' ? me.permissions : []), [me]);
  const can = useCallback((p: string) => perms.has(p), [perms]);
  const canAny = useCallback((...ps: string[]) => ps.some((p) => perms.has(p)), [perms]);

  const value: AuthValue = {
    me,
    loading: q.isLoading,
    can,
    canAny,
    isPlatformAdmin: !!me?.user.roles.includes('platform_admin') && me.stage === 'full',
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    logout: async () => {
      await post('/auth/logout').catch(() => {});
      qc.clear();
      qc.setQueryData(['me'], null);
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
  const { me } = useAuth();
  const prefs = me?.user.preferences ?? {};
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  useEffect(() => {
    const theme = prefs.theme ?? 'light';
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.reducedMotion = prefs.reducedMotion ? 'true' : 'false';
    document.documentElement.classList.toggle('ll-compact', !!prefs.compactTables);
    try {
      localStorage.setItem('ll-theme', resolved);
    } catch {
      /* egal */
    }
  }, [prefs.theme, prefs.reducedMotion, prefs.compactTables, systemDark]);
  return null;
}
