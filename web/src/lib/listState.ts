import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Zustand einer Liste in der Adresse (#260): Suche, Reiter und Filter stehen als Parameter in der URL
 * (`/presse?filter=done&suche=brand`). Zurück aus einer Detailseite, Lesezeichen und Links aus Benachrichtigungen oder
 * der Suche (Strg K → „Alle Treffer in …“) zeigen damit dieselbe gefilterte Liste.
 *
 * - `defaults` legt Schlüssel und Standardwerte fest; ein Wert gleich dem Standard steht nicht in der Adresse.
 * - Die Suche heißt einheitlich `suche` (wie die Links der Befehlspalette, #259).
 * - Änderungen ersetzen den Verlaufseintrag (kein „Zurück“ durch jede Tastatureingabe); andere Parameter der Seite
 *   (z. B. `?banner=<id>` für einen verlinkten Eintrag) bleiben erhalten.
 */
export type ListDefaults = Record<string, string>;

export interface ListState<D extends ListDefaults> {
  /** aktuelle Werte (aus der Adresse, sonst Standard) */
  values: D;
  /** einzelne Werte setzen; leer oder gleich dem Standard entfernt den Parameter */
  set: (patch: Partial<Record<keyof D, string>>) => void;
  /** alles auf den Standard (außer `keep`) */
  reset: (keep?: (keyof D)[]) => void;
  /** Anzahl der Werte, die vom Standard abweichen (ohne die in `tabKeys` genannten Reiter) */
  activeCount: number;
  /** weicht irgendein Wert (auch ein Reiter) vom Standard ab? */
  changed: boolean;
}

export function useListState<D extends ListDefaults>(defaults: D, opts: { tabKeys?: (keyof D)[] } = {}): ListState<D> {
  const [params, setParams] = useSearchParams();
  const dkey = JSON.stringify(defaults);
  const keys = useMemo(() => Object.keys(defaults) as (keyof D & string)[], [dkey]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = useMemo(() => {
    const out = { ...defaults };
    for (const k of keys) {
      const v = params.get(k);
      if (v != null) (out as Record<string, string>)[k] = v;
    }
    return out;
  }, [params, dkey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback(
    (patch: Partial<Record<keyof D, string>>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch) as [string, string | undefined][]) {
            if (v == null || v === '' || v === defaults[k]) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams, dkey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const reset = useCallback(
    (keep: (keyof D)[] = []) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of keys) if (!keep.includes(k)) next.delete(k);
          return next;
        },
        { replace: true },
      ),
    [setParams, keys],
  );
  const tabs = opts.tabKeys ?? [];
  const activeCount = keys.filter((k) => !tabs.includes(k) && values[k] !== defaults[k]).length;
  const changed = keys.some((k) => values[k] !== defaults[k]);
  return { values, set, reset, activeCount, changed };
}
