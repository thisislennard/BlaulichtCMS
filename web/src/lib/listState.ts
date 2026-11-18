import { useCallback, useMemo, useRef } from 'react';
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
  // Mehrere Änderungen kurz hintereinander (Reiter wählen, sofort tippen) bauen aufeinander auf: Die Adresse zieht erst
  // nach dem Rendern nach, `prev` des Routers wäre bis dahin der alte Stand und verschluckte die erste Änderung.
  const latest = useRef(params);
  latest.current = params;
  const pending = useRef<{ qs: string; at: number } | null>(null);
  const apply = useCallback(
    (fn: (p: URLSearchParams) => void) => {
      const p = pending.current;
      const base = p && p.qs !== latest.current.toString() && Date.now() - p.at < 1500 ? new URLSearchParams(p.qs) : new URLSearchParams(latest.current);
      fn(base);
      pending.current = { qs: base.toString(), at: Date.now() };
      setParams(base, { replace: true });
    },
    [setParams],
  );
  const set = useCallback(
    (patch: Partial<Record<keyof D, string>>) =>
      apply((next) => {
        for (const [k, v] of Object.entries(patch) as [string, string | undefined][]) {
          if (v == null || v === '' || v === defaults[k]) next.delete(k);
          else next.set(k, v);
        }
      }),
    [apply, dkey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const reset = useCallback((keep: (keyof D)[] = []) => apply((next) => keys.forEach((k) => !keep.includes(k) && next.delete(k))), [apply, keys]);
  const tabs = opts.tabKeys ?? [];
  const activeCount = keys.filter((k) => !tabs.includes(k) && values[k] !== defaults[k]).length;
  const changed = keys.some((k) => values[k] !== defaults[k]);
  return { values, set, reset, activeCount, changed };
}
