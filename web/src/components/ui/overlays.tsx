import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBlocker } from 'react-router';
import { Button, cx, Input, RequiredLegend, RequiredScopeProvider, useRegisterRequired } from './core';
import { Icon } from './Icon';
import { fmtDate } from '../../lib/format';

/* ---------------------------------------- Toast ---------------------------------------- */

interface ToastItem {
  id: number;
  tone: 'success' | 'error' | 'info' | 'warning';
  title: string;
  text?: string;
  action?: { label: string; onClick: () => void };
}

const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.action ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="fixed bottom-[calc(var(--bc-bottom-bar)+16px)] right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 items-stretch sm:items-end pointer-events-none" role="status" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className="pointer-events-auto w-full sm:w-[380px] bg-raised border border-line rounded-card shadow-float p-3.5 flex gap-3 items-start">
              <Icon
                name={t.tone === 'success' ? 'CheckCircle2' : t.tone === 'error' ? 'XCircle' : t.tone === 'warning' ? 'AlertTriangle' : 'Info'}
                size={16}
                className={cx('mt-0.5 shrink-0', t.tone === 'success' ? 'text-ok' : t.tone === 'error' ? 'text-err' : t.tone === 'warning' ? 'text-warn' : 'text-fg-link')}
              />
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <strong className="text-sm font-semibold">{t.title}</strong>
                {t.text && <span className="text-meta text-fg-muted break-words">{t.text}</span>}
              </div>
              {t.action && (
                <button
                  type="button"
                  className="text-sm font-medium text-fg-link hover:text-fg shrink-0"
                  onClick={() => {
                    t.action!.onClick();
                    setItems((s) => s.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" aria-label="Schließen" className="text-fg-muted hover:text-fg shrink-0" onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))}>
                <Icon name="X" size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/** Fehler einer API-Aktion als Toast mit verständlicher Meldung */
/** Fehlertext für Meldungen: bei Prüffehlern die konkreten Gründe je Feld statt nur „Eingaben … ungültig“. */
export function errorText(e: unknown): string {
  const base = (e as Error)?.message ?? String(e);
  const details = (e as { details?: unknown })?.details;
  if (!Array.isArray(details) || !details.length) return base;
  const lines = details.slice(0, 4).map((d: any) => (d?.label ? `${d.label}: ${d.message}` : d?.message)).filter(Boolean);
  if (details.length > 4) lines.push(`… und ${details.length - 4} weitere`);
  return lines.length ? `${base} ${lines.join(' · ')}` : base;
}

export function useErrorToast() {
  const toast = useToast();
  return useCallback((e: unknown, title = 'Aktion fehlgeschlagen') => toast({ tone: 'error', title, text: errorText(e) }), [toast]);
}

/* --------------------------------------- Dialog ---------------------------------------- */

/** Zählt Pflichtfelder (`FieldWrap required`) darunter; ab einem Feld erscheint die Legende „* Pflichtfeld“ (#268). */
export function useRequiredScope() {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount((c) => c + 1);
    return () => setCount((c) => c - 1);
  }, []);
  return { count, register };
}

/** Formular außerhalb eines Dialogs mit Legende „* Pflichtfeld“, sobald es ein Pflichtfeld enthält. */
export function RequiredScope({ children, className }: { children: ReactNode; className?: string }) {
  const req = useRequiredScope();
  return (
    <RequiredScopeProvider value={req.register}>
      {children}
      {req.count > 0 && <RequiredLegend className={cx('block', className)} />}
    </RequiredScopeProvider>
  );
}

export function Dialog({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  const req = useRequiredScope();
  // onClose ist bei den Aufrufern meist eine Inline-Funktion (bei jedem Rendern neu). Steckte sie in den
  // Abhängigkeiten des Effekts, liefe dieser bei jedem Tastendruck im Formular erneut: Fokus zurück auf das vorherige
  // Element und dann auf das erste Feld – Tippen in späteren Feldern bräche ab. Deshalb nur `open` als Abhängigkeit.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Bereits fokussiertes Element im Dialog (z. B. autoFocus) nicht übergehen
    // Unsichtbare Felder mit tabindex=-1 (z. B. das Dateifeld hinter FilePickButton) überspringen
    if (!el?.contains(document.activeElement)) el?.querySelector<HTMLElement>('input:not([tabindex="-1"]), textarea, select, button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.tabIndex >= 0);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Nur zurückgeben, wenn der Fokus noch im Dialog liegt oder verloren ging (nicht aus einem anderen Feld reißen)
      const active = document.activeElement;
      if (prev?.isConnected && (!active || active === document.body || el?.contains(active))) prev.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={hid} className="bg-card border border-line rounded-card shadow-float w-full max-h-[90vh] flex flex-col" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
          <h2 id={hid} className="m-0 text-section font-semibold">
            {title}
          </h2>
          <button type="button" data-close aria-label="Schließen" onClick={onClose} className="text-fg-muted hover:text-fg w-8 h-8 max-md:w-10 max-md:h-10 inline-flex items-center justify-center rounded-chip hover:bg-raised">
            <Icon name="X" size={16} />
          </button>
        </div>
        <RequiredScopeProvider value={req.register}>
          <div className="px-5 py-4 overflow-y-auto">
            {children}
            {req.count > 0 && !footer && <RequiredLegend className="block mt-3" />}
          </div>
        </RequiredScopeProvider>
        {footer && (
          <div className="flex justify-end items-center gap-2 px-5 py-3 border-t border-line flex-wrap">
            {req.count > 0 && <RequiredLegend className="mr-auto" />}
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Endgültiges Löschen: Bestätigung durch Eintippen des Namens, Button nennt das Objekt. */
export function DeleteDialog({ open, onClose, objectType, name, confirmValue, onConfirm, extra }: { open: boolean; onClose: () => void; objectType: string; name: string; confirmValue?: string; onConfirm: (typed: string) => Promise<void>; extra?: ReactNode }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = confirmValue ?? name;
  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${objectType} löschen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="danger"
            icon="Trash2"
            loading={busy}
            disabled={typed.trim() !== expected.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(typed);
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {objectType} „{name.length > 28 ? name.slice(0, 27) + '…' : name}“ löschen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">Das lässt sich nicht rückgängig machen.</p>
        {extra}
        <label className="flex flex-col gap-1.5">
          <span>
            Zur Bestätigung <strong className="font-mono">{expected}</strong> eingeben:
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        {error && <p className="m-0 text-err text-meta">{error}</p>}
      </div>
    </Dialog>
  );
}

/* --------------------------------------- Popover --------------------------------------- */

export function Popover({ open, onClose, anchor, children, align = 'end', width = 280, className }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; align?: 'start' | 'end'; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const placeRef = useRef<(() => void) | null>(null);
  // onClose per Ref: Inline-Funktionen der Aufrufer sollen den Effekt nicht bei jedem Rendern neu starten
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - 16);
      let left = align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      // Unten zu wenig Platz: nach oben öffnen; Höhe immer auf den sichtbaren Bereich begrenzen (Inhalt scrollt)
      const below = window.innerHeight - r.bottom - 14;
      const above = r.top - 14;
      const h = ref.current?.scrollHeight ?? 0;
      if (h > below && above > below) {
        const maxHeight = Math.max(160, above);
        setPos({ top: Math.max(8, r.top - 6 - Math.min(h, maxHeight)), left, maxHeight });
      } else setPos({ top: r.bottom + 6, left, maxHeight: Math.max(160, below) });
    };
    // Erst messen, dann platzieren (Höhe ist nach dem ersten Rendern bekannt – siehe Layout-Effekt unten)
    placeRef.current = place;
    requestAnimationFrame(place);
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      placeRef.current = null;
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchor, align, width]);
  // Beim ersten Öffnen gibt es den Inhalt erst nach dem ersten Platzieren: dann sofort mit echter Höhe neu platzieren,
  // sonst öffnet ein Menü am unteren Fensterrand nach unten aus dem Bild (Zeilenmenüs langer Tabellen)
  const shown = open && pos !== null;
  useLayoutEffect(() => {
    if (shown) placeRef.current?.();
  }, [shown]);
  if (!open || !pos) return null;
  return createPortal(
    <div ref={ref} className={cx('fixed z-[80] bg-card border border-line rounded-card shadow-float overflow-y-auto', className)} style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16), maxHeight: pos.maxHeight }}>
      {children}
    </div>,
    document.body,
  );
}

/** Menüeintrag; `null`/`false` werden ausgelassen (bedingte Einträge). */
export type MenuItem = { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string } | null | false;

/** Menü mit Tastatursteuerung (↑↓ Enter Esc). `text` zeigt eine sichtbare Beschriftung statt nur des Symbols. */
export function Menu({ items, label = 'Weitere Aktionen', icon = 'MoreHorizontal', size = 'md', text }: { items: MenuItem[]; label?: string; icon?: string; size?: 'sm' | 'md'; text?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = items.filter(Boolean) as { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }[];
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (open) setActive(0);
  }, [open]);
  // Stabile Ref-Funktion: eine Inline-Funktion liefe bei jedem Rendern erneut und holte den Fokus zurück ins Menü
  const focusMenu = useCallback((el: HTMLDivElement | null) => el?.focus(), []);
  return (
    <>
      <Button ref={btn} iconOnly={!text} icon={icon} size={size} aria-label={text ? undefined : label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} variant="secondary">
        {text}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={240}>
        <div
          role="menu"
          tabIndex={-1}
          ref={focusMenu}
          className="p-1.5 outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => (a + 1) % list.length);
            if (e.key === 'ArrowUp') setActive((a) => (a - 1 + list.length) % list.length);
            if (e.key === 'Enter' && list[active] && !list[active].disabled) {
              setOpen(false);
              list[active].onClick();
            }
          }}
        >
          {list.map((it, i) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              title={it.hint}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={cx('w-full flex items-center gap-2.5 h-9 max-md:h-10 px-2.5 rounded-chip text-sm text-left disabled:opacity-50', i === active && 'bg-raised', it.danger ? 'text-err' : 'text-fg')}
            >
              {it.icon && <Icon name={it.icon} size={15} />}
              {it.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------- SecretField -------------------------------------- */

/** Geheimnisse nie im Klartext: maskiert + „Ersetzen“, kein „Anzeigen“. */
export function SecretField({ label, set, savedAt, onReplace, value, editing, help, required, id }: { label: string; set: boolean; savedAt?: string | null; onReplace?: (v: string) => void; value?: string; editing?: boolean; help?: string; required?: boolean; id?: string }) {
  const [replacing, setReplacing] = useState(!set || !!editing);
  const auto = useId();
  const fid = id ?? auto;
  useRegisterRequired(required && replacing);
  if (!replacing) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex gap-2 items-center">
          <div className="flex-1 h-field rounded-control bg-raised border border-line px-3 flex items-center gap-2 font-mono text-[13px] text-fg-muted" aria-label={`${label}: gespeichert, verborgen`}>
            <Icon name="Lock" size={14} />
            ••••••••••••
          </div>
          <Button onClick={() => setReplacing(true)}>Ersetzen</Button>
        </div>
        <p className="m-0 text-meta text-fg-muted">{savedAt ? `Gespeichert am ${fmtDate(savedAt)} · ` : ''}wird nie im Klartext angezeigt</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fid} className="text-sm font-medium">
        {label}
        {required && (
          <span className="text-err ml-0.5" aria-hidden="true" data-required-mark="">
            *
          </span>
        )}
      </label>
      <div className="flex gap-2">
        <Input id={fid} type="password" autoComplete="new-password" mono value={value ?? ''} onChange={(e) => onReplace?.(e.target.value)} placeholder={set ? 'Neuen Wert eingeben' : ''} aria-required={required || undefined} aria-describedby={`${fid}-note`} />
        {set && (
          <Button
            variant="ghost"
            onClick={() => {
              onReplace?.('');
              setReplacing(false);
            }}
          >
            Abbrechen
          </Button>
        )}
      </div>
      <p id={`${fid}-note`} className="m-0 text-meta text-fg-muted">{help ?? 'Wird verschlüsselt gespeichert und danach nie wieder angezeigt.'}</p>
    </div>
  );
}

/** Einmalige Anzeige eines neu erzeugten Geheimnisses (Webhook, API-Schlüssel). */
export function OneTimeSecret({ value, label = 'Geheimnis' }: { value: string; label?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input readOnly value={value} mono aria-label={label} onFocus={(e) => e.target.select()} />
        <CopyButton value={value} />
      </div>
      <p className="m-0 text-meta text-warn flex items-center gap-1.5">
        <Icon name="AlertTriangle" size={13} /> Jetzt kopieren – es wird nur dieses eine Mal angezeigt.
      </p>
    </div>
  );
}

export function CopyButton({ value, label = 'Kopieren', size = 'md' }: { value: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      icon={done ? 'Check' : 'Copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Kopiert' : label}
    </Button>
  );
}

/* ------------------------------------ Ungespeicherte Änderungen ------------------------------------ */

/**
 * Schutz vor Verlust ungespeicherter Änderungen: beim Schließen/Neuladen (Browserdialog) und beim Wechsel innerhalb
 * der App (eigener Dialog). Nur in Seiten unter dem Daten-Router verwenden.
 */
export function UnsavedChangesGuard({ when, text = 'Ungespeicherte Änderungen gehen verloren.' }: { when: boolean; text?: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!when) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [when]);
  if (blocker.state !== 'blocked') return null;
  return (
    <Dialog
      open
      onClose={() => blocker.reset?.()}
      title="Seite verlassen?"
      footer={
        <>
          <Button onClick={() => blocker.reset?.()}>Bleiben</Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            Verwerfen und verlassen
          </Button>
        </>
      }
    >
      <p className="m-0 text-sm">{text}</p>
    </Dialog>
  );
}

/* ------------------------------------------ Bestätigung ------------------------------------------ */

export interface ConfirmOptions {
  title: string;
  text?: ReactNode;
  confirmLabel?: string;
  /** Standard: rot (danger). false für harmlose Bestätigungen. */
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** Eigener Bestätigungsdialog im Leitstand-Design statt window.confirm (Enter bestätigt, Escape bricht ab). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), []);
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <Dialog
          open
          onClose={() => close(false)}
          title={req.title}
          width={460}
          footer={
            <>
              <Button onClick={() => close(false)}>Abbrechen</Button>
              <Button variant={req.danger === false ? 'primary' : 'danger'} autoFocus onClick={() => close(true)}>
                {req.confirmLabel ?? 'Bestätigen'}
              </Button>
            </>
          }
        >
          {req.text && <div className="m-0 text-sm text-fg-muted">{req.text}</div>}
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
