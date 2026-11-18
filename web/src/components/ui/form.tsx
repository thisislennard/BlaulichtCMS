import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, cx } from './core';
import { Icon } from './Icon';
import { UnsavedChangesGuard } from './overlays';
import { fmtTime } from '../../lib/format';

/*
 * Formulare (#268): Prüfen statt sperren und eine Speichern-Leiste für lange Formulare.
 *
 * - `useFormCheck(problems)`: „Speichern“/„Anlegen“ bleibt bedienbar. Beim Klick mit fehlenden Angaben erscheinen die
 *   Meldungen am Feld (`FieldWrap error={check.error(id)}` → `aria-invalid` + Text), oben eine Zusammenfassung
 *   (`<FormProblems check={check} />`, `role="alert"`) und der Fokus springt ins erste betroffene Feld.
 * - `SaveBar`: schwebende Leiste „Ungespeicherte Änderungen · Verwerfen · Speichern“ mit Warnung beim Verlassen; ohne
 *   Änderungen nur ein leiser Status „Gespeichert 23:14“ statt eines blassen roten Knopfs.
 * - `SaveScope` + `useSaveSource`: eine Leiste für mehrere Abschnitte einer Seite (z. B. Sicherung lokal und außer Haus).
 */

/** Feld-ID → Meldung; leere Werte (false, null, '') bedeuten „in Ordnung“. */
export type FormProblemMap = Record<string, string | false | null | undefined | 0>;

export interface FormCheck {
  /** Meldung für das Feld – erst nach dem ersten Absenden sichtbar */
  error: (id: string) => string | null;
  /** Prüfen und bei Erfolg `run` ausführen; sonst Meldungen zeigen und den Fokus ins erste Feld setzen */
  submit: (run: () => unknown) => void;
  /** Meldungen wieder verbergen (z. B. beim Schließen des Dialogs) */
  reset: () => void;
  /** offene Meldungen (nach dem ersten Absenden) */
  shown: { id: string; message: string }[];
  attempt: number;
}

function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView?.({ block: 'center' });
  // Unsichtbare Dateifelder (FilePickButton) bzw. Gruppen: erstes bedienbares Element darin
  const target = el.matches('input[type=file].sr-only') ? (el.parentElement?.querySelector<HTMLElement>('button') ?? el) : el;
  target.focus({ preventScroll: true });
}

export function useFormCheck(problems: FormProblemMap): FormCheck {
  const [attempt, setAttempt] = useState(0);
  const list = Object.entries(problems)
    .filter(([, m]) => !!m)
    .map(([id, m]) => ({ id, message: String(m) }));
  const listRef = useRef(list);
  listRef.current = list;
  const submit = useCallback((run: () => unknown) => {
    const open = listRef.current;
    if (open.length) {
      setAttempt((a) => a + 1);
      requestAnimationFrame(() => focusField(open[0].id));
      return;
    }
    run();
  }, []);
  const reset = useCallback(() => setAttempt(0), []);
  return {
    error: (id) => (attempt && problems[id] ? String(problems[id]) : null),
    submit,
    reset,
    shown: attempt ? list : [],
    attempt,
  };
}

/** Zusammenfassung der fehlenden Angaben über dem Formular (wird beim Absenden angesagt). */
export function FormProblems({ check, className }: { check: FormCheck; className?: string }) {
  if (!check.shown.length) return null;
  return (
    <div key={check.attempt} role="alert" className={cx('rounded-node border border-err/60 bg-err-soft p-3 flex gap-2.5 items-start text-sm', className)}>
      <Icon name="AlertTriangle" size={16} className="mt-0.5 shrink-0 text-err" />
      <div className="flex flex-col gap-1 min-w-0">
        <strong className="font-semibold">{check.shown.length === 1 ? 'Eine Angabe fehlt noch' : `${check.shown.length} Angaben fehlen noch`}</strong>
        <ul className="m-0 pl-4 text-fg-muted">
          {check.shown.map((p) => (
            <li key={p.id}>
              <a
                href={`#${p.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  focusField(p.id);
                }}
              >
                {p.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------------- SaveBar --------------------------------------- */

export interface SaveProblem {
  /** ID des Felds, in das der Fokus springt */
  id?: string;
  message: string;
}

export interface SaveBarProps {
  dirty: boolean;
  /** Anzahl geänderter Angaben (optional) */
  count?: number;
  saving?: boolean;
  error?: string | null;
  /** Gründe, warum noch nicht gespeichert werden kann – erscheinen beim Klick auf „Speichern“ */
  problems?: SaveProblem[];
  onSave: () => void;
  onDiscard?: () => void;
  /** Zeitpunkt des letzten Speicherns in dieser Ansicht (für „Gespeichert 23:14“) */
  savedAt?: number | string | null;
  /** Text der Rückfrage beim Verlassen; `guard={false}`, wenn die Seite selbst warnt */
  guardText?: string;
  guard?: boolean;
  saveLabel?: string;
  /** weitere Knöpfe links von „Verwerfen“ */
  extra?: ReactNode;
  className?: string;
}

/**
 * Eine Speichern-Leiste für lange Formulare (#268). Schwebt am unteren Rand des Inhalts, sobald es Änderungen gibt.
 * „Speichern“ ist nie stumm gesperrt: Liegen `problems` vor, nennt die Leiste sie beim Klick (`role="alert"`) und setzt
 * den Fokus ins erste betroffene Feld.
 */
export function SaveBar({ dirty, count, saving, error, problems = [], onSave, onDiscard, savedAt, guardText, guard = true, saveLabel = 'Speichern', extra, className }: SaveBarProps) {
  const [shown, setShown] = useState(0);
  const labelId = useId();
  useEffect(() => {
    if (!problems.length) setShown(0);
  }, [problems.length]);
  const click = () => {
    if (problems.length) {
      setShown((n) => n + 1);
      const first = problems.find((p) => p.id);
      if (first?.id) requestAnimationFrame(() => focusField(first.id!));
      return;
    }
    onSave();
  };
  return (
    <>
      {guard && <UnsavedChangesGuard when={dirty} text={guardText ?? 'Es gibt ungespeicherte Änderungen. Beim Verlassen gehen sie verloren.'} />}
      {dirty ? (
        <div role="region" aria-labelledby={labelId} className={cx('sticky bottom-4 z-20 flex items-center gap-3 flex-wrap px-4 py-3 rounded-card border border-line bg-raised shadow-float', className)} data-save-bar="">
          <span className="w-2 h-2 rounded-full bg-warn shrink-0" aria-hidden="true" />
          <span id={labelId} role="status" className="text-sm font-medium flex-1 min-w-[160px]">
            Ungespeicherte Änderungen
            {count ? <span className="text-fg-muted font-normal"> · {count}</span> : null}
          </span>
          {error && (
            <span role="alert" className="text-meta text-err basis-full sm:basis-auto order-last sm:order-none">
              {error}
            </span>
          )}
          {shown > 0 && problems.length > 0 && (
            <div key={shown} role="alert" className="basis-full order-last text-meta text-err flex flex-col gap-0.5">
              <span className="font-medium">Noch nicht gespeichert – bitte prüfen:</span>
              <ul className="m-0 pl-4">
                {problems.map((p, i) => (
                  <li key={`${p.id ?? ''}${i}`}>
                    {p.id ? (
                      <a
                        href={`#${p.id}`}
                        className="text-err"
                        onClick={(e) => {
                          e.preventDefault();
                          focusField(p.id!);
                        }}
                      >
                        {p.message}
                      </a>
                    ) : (
                      p.message
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {extra}
          {onDiscard && (
            <Button variant="ghost" onClick={onDiscard} disabled={saving}>
              Verwerfen
            </Button>
          )}
          <Button variant="primary" icon="Save" loading={saving} onClick={click} aria-describedby={shown > 0 && problems.length ? undefined : labelId}>
            {saveLabel}
          </Button>
        </div>
      ) : savedAt ? (
        <p role="status" className={cx('m-0 flex items-center justify-end gap-1.5 text-meta text-fg-muted', className)}>
          <Icon name="CheckCircle2" size={14} className="text-ok" />
          Gespeichert {fmtTime(savedAt)}
        </p>
      ) : null}
    </>
  );
}

/* ------------------------------ Mehrere Abschnitte, eine Leiste ------------------------------ */

export interface SaveSource {
  dirty: boolean;
  count?: number;
  problems?: SaveProblem[];
  /** speichert; `false` = abgebrochen (z. B. Rückfrage verneint), Fehler werfen */
  save: () => Promise<boolean | void>;
  discard: () => void;
}

interface SourceState {
  dirty: boolean;
  count: number;
  problems: SaveProblem[];
}
interface ScopeCtx {
  update: (id: string, s: SourceState | null) => void;
  fns: Map<string, { save: SaveSource['save']; discard: SaveSource['discard'] }>;
}
const SaveScopeContext = createContext<ScopeCtx | null>(null);

/**
 * Eine Speichern-Leiste für alle Abschnitte darin: Jeder Abschnitt meldet sich mit `useSaveSource` an; „Speichern“
 * speichert die geänderten Abschnitte nacheinander (in der Reihenfolge der Anmeldung), „Verwerfen“ setzt alle zurück.
 */
export function SaveScope({ children, guardText, onSaved }: { children: ReactNode; guardText?: string; onSaved?: () => void }) {
  const [states, setStates] = useState<Record<string, SourceState>>({});
  const fns = useRef(new Map<string, { save: SaveSource['save']; discard: SaveSource['discard'] }>()).current;
  const order = useRef<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const update = useCallback((id: string, s: SourceState | null) => {
    setStates((old) => {
      if (!s) {
        if (!(id in old)) return old;
        const { [id]: _drop, ...rest } = old;
        return rest;
      }
      const prev = old[id];
      if (prev && prev.dirty === s.dirty && prev.count === s.count && JSON.stringify(prev.problems) === JSON.stringify(s.problems)) return old;
      if (!order.current.includes(id)) order.current.push(id);
      return { ...old, [id]: s };
    });
  }, []);
  const ctx = useMemo(() => ({ update, fns }), [update, fns]);
  const dirtyIds = order.current.filter((id) => states[id]?.dirty);
  const dirty = dirtyIds.length > 0;
  const count = dirtyIds.reduce((a, id) => a + (states[id]?.count ?? 0), 0);
  const problems = dirtyIds.flatMap((id) => states[id]?.problems ?? []);
  useEffect(() => {
    if (dirty) setError(null);
  }, [dirty]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const id of dirtyIds) {
        const f = fns.get(id);
        if (!f) continue;
        if ((await f.save()) === false) return;
      }
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    for (const id of dirtyIds) fns.get(id)?.discard();
    setError(null);
  };
  return (
    <SaveScopeContext.Provider value={ctx}>
      {children}
      <SaveBar dirty={dirty} count={count || undefined} saving={saving} error={error} problems={problems} onSave={save} onDiscard={discard} savedAt={savedAt} guardText={guardText} />
    </SaveScopeContext.Provider>
  );
}

/** Abschnitt bei der umgebenden `SaveScope` anmelden. Liefert `false`, wenn es keine gibt (dann eigene Leiste zeigen). */
export function useSaveSource(src: SaveSource): boolean {
  const ctx = useContext(SaveScopeContext);
  const id = useId();
  if (ctx) ctx.fns.set(id, { save: src.save, discard: src.discard });
  const problemsKey = JSON.stringify(src.problems ?? []);
  useEffect(() => {
    if (!ctx) return;
    ctx.update(id, { dirty: src.dirty, count: src.count ?? 0, problems: JSON.parse(problemsKey) });
  }, [ctx, id, src.dirty, src.count, problemsKey]);
  useEffect(
    () => () => {
      ctx?.update(id, null);
      ctx?.fns.delete(id);
    },
    [ctx, id],
  );
  return !!ctx;
}
