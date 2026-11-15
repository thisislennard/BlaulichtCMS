import type { ReactNode } from 'react';
import { cx } from './core';
import { Icon } from './Icon';

export function Sparkline({ values, color = 'var(--bc-primary)', width = 72, height = 20 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (!values.length) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function KpiCard({ label, icon, value, unit, delta, deltaTone, spark, sparkColor, href }: { label: string; icon: string; value: ReactNode; unit?: string; delta?: ReactNode; deltaTone?: 'ok' | 'err' | 'muted'; spark?: number[]; sparkColor?: string; href?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-fg-muted text-sm">
        <span>{label}</span>
        <Icon name={icon} size={16} strokeWidth={1.8} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[24px] leading-[30px] font-medium tabular">{value}</span>
        {unit && <span className="text-sm text-fg-muted">{unit}</span>}
      </div>
      <div className="flex items-center justify-between gap-2 min-h-5">
        <span className={cx('text-meta font-medium', deltaTone === 'ok' ? 'text-ok' : deltaTone === 'err' ? 'text-err' : 'text-fg-muted')}>{delta}</span>
        {spark && <Sparkline values={spark} color={sparkColor} />}
      </div>
    </>
  );
  const cls = 'bg-card border border-line rounded-card px-[18px] py-4 flex flex-col gap-2.5 min-w-0';
  return href ? (
    <a href={href} className={cx(cls, '!text-fg hover:bg-raised transition-colors')}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Formatierte JSON-Ansicht: Schlüssel leise, Werte in Textfarbe, maskierte Werte kursiv (keine Statusfarben). */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return <pre className={cx('m-0 font-mono text-meta leading-relaxed whitespace-pre-wrap break-words bg-bg border border-line rounded-node p-3 overflow-auto', className)}>{renderJson(value, 0)}</pre>;
}

function renderJson(v: unknown, depth: number): ReactNode {
  const pad = '  '.repeat(depth);
  if (v === null || v === undefined) return <span className="text-fg-muted">null</span>;
  if (typeof v === 'string') {
    if (v.includes('•••••••• maskiert')) return <span className="italic text-fg-muted">"{v}"</span>;
    return <span className="text-fg">"{v}"</span>;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return <span className="text-fg font-medium">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return (
      <>
        {'[\n'}
        {v.map((x, i) => (
          <span key={i}>
            {pad}
            {'  '}
            {renderJson(x, depth + 1)}
            {i < v.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {pad}
        {']'}
      </>
    );
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return '{}';
    return (
      <>
        {'{\n'}
        {entries.map(([k, x], i) => (
          <span key={k}>
            {pad}
            {'  '}
            <span className="text-fg-muted">"{k}"</span>: {renderJson(x, depth + 1)}
            {i < entries.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {pad}
        {'}'}
      </>
    );
  }
  return String(v);
}
