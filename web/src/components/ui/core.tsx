import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router';
import { Icon } from './Icon';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/* --------------------------------------- Button --------------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary-solid text-on-primary hover:bg-primary-hover border border-transparent',
  secondary: 'bg-card text-fg border border-line hover:bg-raised',
  ghost: 'bg-transparent text-fg-muted hover:bg-raised hover:text-fg border border-transparent',
  danger: 'bg-err-soft text-err border border-err/60 hover:bg-err/20',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, iconRight, loading, iconOnly, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-control font-medium text-sm whitespace-nowrap transition-colors duration-fast ease-out disabled:opacity-55',
        size === 'sm' ? 'h-ctl-sm' : 'h-ctl',
        iconOnly ? (size === 'sm' ? 'w-8 px-0' : 'w-9 px-0') : 'px-3.5',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={16} /> : null}
      {!iconOnly && children}
      {iconRight && !loading ? <Icon name={iconRight} size={16} /> : null}
    </button>
  );
});

export function LinkButton({ to, variant = 'secondary', icon, children, size = 'md', className }: { to: string; variant?: Variant; icon?: string; children: ReactNode; size?: 'sm' | 'md'; className?: string }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center gap-2 rounded-control font-medium text-sm whitespace-nowrap px-3.5 transition-colors duration-fast', size === 'sm' ? 'h-ctl-sm' : 'h-ctl', VARIANTS[variant], variant === 'primary' && '!text-on-primary', className)}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </Link>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cx('animate-spin', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------- Badge ---------------------------------------- */

export type Tone = 'success' | 'error' | 'warning' | 'neutral' | 'primary';
const TONES: Record<Tone, { bg: string; fg: string; dot: string }> = {
  success: { bg: 'bg-ok-soft', fg: 'text-ok', dot: 'bg-ok' },
  error: { bg: 'bg-err-soft', fg: 'text-err', dot: 'bg-err' },
  warning: { bg: 'bg-warn-soft', fg: 'text-warn', dot: 'bg-warn' },
  neutral: { bg: 'bg-raised', fg: 'text-fg-muted', dot: 'bg-fg-muted' },
  primary: { bg: 'bg-primary-soft', fg: 'text-fg-link', dot: 'bg-fg-link' },
};

/** Status nie nur über Farbe: Punkt + Text */
export function Badge({ tone = 'neutral', children, dot = true, pulse, className, title }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; className?: string; title?: string }) {
  const t = TONES[tone];
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-meta font-medium whitespace-nowrap', t.bg, t.fg, className)}>
      {dot && <span aria-hidden="true" className={cx('w-1.5 h-1.5 rounded-full shrink-0', t.dot, pulse && 'bc-pulse')} />}
      {children}
    </span>
  );
}

/** Status-Darstellung für Beiträge, Veröffentlichungen, Medien und Links – immer Farbe + Text. */
export const STATUS: Record<string, { tone: Tone; label: string; pulse?: boolean }> = {
  // Beitrag (bezogen auf die aktuelle Fassung)
  draft: { tone: 'neutral', label: 'Entwurf' },
  in_review: { tone: 'warning', label: 'Zur Freigabe' },
  approved: { tone: 'success', label: 'Freigegeben' },
  scheduled: { tone: 'primary', label: 'Geplant' },
  deactivated: { tone: 'neutral', label: 'Zurückgezogen' },
  live: { tone: 'success', label: 'Aktiv', pulse: true },
  ended: { tone: 'neutral', label: 'Beendet' },
  rejected: { tone: 'error', label: 'Zurückgewiesen' },
  publishing: { tone: 'primary', label: 'Wird veröffentlicht', pulse: true },
  published: { tone: 'success', label: 'Veröffentlicht' },
  failed: { tone: 'error', label: 'Fehlgeschlagen' },
  unknown: { tone: 'warning', label: 'Ergebnis unbekannt' },
  // Veröffentlichungsauftrag
  queued: { tone: 'neutral', label: 'Wartet auf Abholung', pulse: true },
  sent: { tone: 'primary', label: 'Gesendet', pulse: true },
  canceled: { tone: 'neutral', label: 'Abgebrochen' },
  // Medien
  quarantine: { tone: 'warning', label: 'Wird geprüft', pulse: true },
  ready: { tone: 'success', label: 'Geprüft' },
  selected: { tone: 'success', label: 'Ausgewählt' },
  skipped: { tone: 'neutral', label: 'Übersprungen' },
  on_hold: { tone: 'warning', label: 'Zurückgestellt' },
  blocked: { tone: 'error', label: 'Gesperrt' },
  pending: { tone: 'neutral', label: 'Offen' },
  // Links und Kanäle
  active: { tone: 'success', label: 'Aktiv' },
  paused: { tone: 'warning', label: 'Pausiert' },
  full: { tone: 'warning', label: 'Kontingent erreicht' },
  expired: { tone: 'neutral', label: 'Abgelaufen' },
  revoked: { tone: 'error', label: 'Widerrufen' },
  // Warnentwürfe und Versand
  sending: { tone: 'primary', label: 'Wird versendet', pulse: true },
  accepted: { tone: 'success', label: 'Vom Mailserver angenommen' },
  send_failed: { tone: 'error', label: 'Versand fehlgeschlagen' },
  send_unknown: { tone: 'warning', label: 'Versand unklar – prüfen' },
  acknowledged: { tone: 'success', label: 'Eingang bestätigt' },
  retired: { tone: 'neutral', label: 'Außer Kraft' },
};

export function StatusBadge({ status, className, labels }: { status: string; className?: string; labels?: Record<string, string> }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return (
    <Badge tone={s.tone} pulse={s.pulse} className={className}>
      {labels?.[status] ?? s.label}
    </Badge>
  );
}

/** Fassungsnummer als Maschinen-Wert: „F2“ in Mono, ausgeschrieben im Tooltip und für Screenreader. */
export function Rev({ n, className }: { n: number | string; className?: string }) {
  return (
    <span className={cx('font-mono', className)} title={`Fassung ${n}`}>
      <span aria-hidden="true">F{n}</span>
      <span className="sr-only">Fassung {n}</span>
    </span>
  );
}

export function Chip({ children, className, mono }: { children: ReactNode; className?: string; mono?: boolean }) {
  return <span className={cx('inline-flex items-center gap-1 h-[22px] px-2 rounded-chip bg-raised text-meta text-fg-muted whitespace-nowrap', mono && 'font-mono', className)}>{children}</span>;
}

/* ----------------------------------------- Card ---------------------------------------- */

export function Card({ title, subtitle, action, children, className, bodyClassName, id }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={title ? hid : undefined} className={cx('bg-card border border-line rounded-card min-w-0', className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 px-5 pt-[18px] pb-3 flex-wrap">
          <div className="min-w-0">
            {title && (
              <h3 id={hid} className="m-0 text-section font-semibold">
                {title}
              </h3>
            )}
            {subtitle && <p className="m-0 mt-0.5 text-meta text-fg-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={cx(title || action ? 'px-5 pb-5' : 'p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div className="flex flex-col gap-1 min-w-0">
        <h2 className="m-0 text-page font-semibold tracking-[-0.03em]">{title}</h2>
        {subtitle && <p className="m-0 text-fg-muted">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="flex gap-2 items-center flex-wrap">{actions}</div>}
    </div>
  );
}

/* --------------------------------------- Felder ---------------------------------------- */

export function FieldWrap({ label, help, error, required, children, htmlFor, className, labelAction }: { label?: ReactNode; help?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; htmlFor?: string; className?: string; labelAction?: ReactNode }) {
  return (
    <div className={cx('flex flex-col gap-1.5 min-w-0', className)}>
      {label && (
        // Schmale Bildschirme: Aktionen neben der Beschriftung rutschen in die nächste Zeile statt überzustehen
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
            {required && (
              <span className="text-err ml-0.5" aria-hidden="true">
                *
              </span>
            )}
          </label>
          {labelAction}
        </div>
      )}
      {children}
      {error ? (
        <p className="m-0 text-meta text-err" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="m-0 text-meta text-fg-muted">{help}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  'w-full bg-bg border border-line rounded-control px-3 text-base text-fg outline-none transition-[border-color,box-shadow] duration-fast focus:border-primary focus:shadow-ring aria-[invalid=true]:border-err disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }>(function Input({ className, invalid, mono, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cx(inputBase, 'h-field', mono && 'font-mono text-[13px]', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }>(function Textarea({ className, invalid, mono, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cx(inputBase, 'py-2 leading-relaxed resize-y', mono && 'font-mono text-[13px]', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <div className="relative">
      <select ref={ref} aria-invalid={invalid || undefined} className={cx(inputBase, 'h-field appearance-none pr-9', className)} {...rest}>
        {children}
      </select>
      <Icon name="ChevronDown" size={16} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted" />
    </div>
  );
});

export function Switch({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  const toggle = (
    <button
      id={sid}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex shrink-0 w-8 h-[18px] rounded-full transition-colors duration-fast', checked ? 'bg-primary-solid' : 'bg-line', disabled && 'opacity-50')}
    >
      <span aria-hidden="true" className={cx('absolute top-[2px] w-[14px] h-[14px] rounded-full bg-knob shadow transition-transform duration-fast', checked ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
      {!label && <span className="sr-only">Umschalten</span>}
    </button>
  );
  if (!label) return toggle;
  return (
    <label htmlFor={sid} className={cx('flex items-start justify-between gap-4 cursor-pointer py-1', disabled && 'cursor-not-allowed')}>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="text-meta text-fg-muted">{description}</span>}
      </span>
      {toggle}
    </label>
  );
}

export function SegmentedControl<T extends string>({ value, onChange, options, label, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="group" aria-label={label} className="inline-flex p-[3px] border border-line rounded-control bg-card max-w-full overflow-x-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('px-3 rounded-chip text-sm font-medium whitespace-nowrap transition-colors duration-fast inline-flex items-center gap-1.5', size === 'sm' ? 'h-[26px]' : 'h-[30px]', value === o.value ? 'bg-raised text-fg' : 'text-fg-muted hover:text-fg')}
        >
          {o.label}
          {o.count != null && <span className="text-meta text-fg-muted tabular">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.value === value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].value);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length].value);
          }}
          className={cx('relative h-10 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-fast', value === t.value ? 'text-fg' : 'text-fg-muted hover:text-fg')}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-meta text-fg-muted tabular">{t.count}</span>}
          {value === t.value && <span aria-hidden="true" className="absolute left-2 right-2 -bottom-px h-0.5 bg-primary rounded-full" />}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------- Tabelle ------------------------------------------ */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('relative overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className, align }: { children?: ReactNode; className?: string; align?: 'right' | 'left' }) {
  return <th className={cx('text-meta font-medium text-fg-muted py-2.5 px-3 border-b border-line whitespace-nowrap', align === 'right' ? 'text-right' : 'text-left', className)}>{children}</th>;
}
export function Td({ children, className, align, mono }: { children?: ReactNode; className?: string; align?: 'right' | 'left'; mono?: boolean }) {
  return <td className={cx('py-3 px-3 border-b border-line align-middle', align === 'right' && 'text-right', mono && 'font-mono text-meta tabular', className)}>{children}</td>;
}

/* -------------------------------- Lade-/Leerzustände ------------------------------------- */

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden="true" style={style} className={cx('bc-skeleton rounded-chip', className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-3', className)} aria-busy="true" aria-label="Wird geladen">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'Inbox', title, text, action }: { icon?: string; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-3 py-10 px-4">
      <div className="w-11 h-11 rounded-card bg-raised flex items-center justify-center text-fg-muted">
        <Icon name={icon} size={20} />
      </div>
      <div className="flex flex-col gap-1 max-w-[420px]">
        <h3 className="m-0 text-section font-semibold">{title}</h3>
        {text && <p className="m-0 text-sm text-fg-muted">{text}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorBox({ title, children, actions, className }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cx('rounded-node border border-err/70 bg-err-soft p-3.5 flex flex-col gap-2', className)}>
      <div className="flex items-start gap-2.5">
        <Icon name="XCircle" size={16} className="text-err mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1 min-w-0">
          <strong className="text-sm font-semibold">{title}</strong>
          {children && <div className="text-sm text-fg-muted break-words">{children}</div>}
        </div>
      </div>
      {actions && <div className="flex gap-2 flex-wrap pl-[26px]">{actions}</div>}
    </div>
  );
}

/** Hinweis-Kasten. „info“ ist neutral – Rot bleibt Hauptaktionen und Fehlern vorbehalten. */
export function Notice({ tone = 'info', icon, title, children, className }: { tone?: 'info' | 'warning' | 'error' | 'success'; icon?: string; title?: ReactNode; children?: ReactNode; className?: string }) {
  const styles = { info: 'border-line bg-raised', warning: 'border-warn/60 bg-warn-soft', error: 'border-err/60 bg-err-soft', success: 'border-ok/50 bg-ok-soft' }[tone];
  const ic = icon ?? { info: 'Info', warning: 'AlertTriangle', error: 'XCircle', success: 'CheckCircle2' }[tone];
  const color = { info: 'text-fg-muted', warning: 'text-warn', error: 'text-err', success: 'text-ok' }[tone];
  return (
    <div className={cx('rounded-node border p-3.5 flex gap-2.5 items-start', styles, className)}>
      <Icon name={ic} size={16} className={cx('mt-0.5 shrink-0', color)} />
      <div className="flex flex-col gap-1 min-w-0 text-sm">
        {title && <strong className="font-semibold">{title}</strong>}
        {children && <div className="text-fg-muted">{children}</div>}
      </div>
    </div>
  );
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 m-0 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="m-0 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-5 px-1.5 rounded-[5px] border border-line bg-raised font-mono text-[11px] text-fg-muted">{children}</kbd>;
}

/** Avatar mit Initialen – neutral (Grün/Gelb bleiben Status, Rot bleibt Akzent). „strong“ für das eigene Konto in der Kopfzeile. */
export function Avatar({ name, size = 30, strong }: { name: string; size?: number; strong?: boolean }) {
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span aria-hidden="true" className={cx('inline-flex items-center justify-center rounded-full font-semibold shrink-0', strong ? 'bg-fg text-card' : 'bg-raised text-fg border border-line')} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials || '?'}
    </span>
  );
}
