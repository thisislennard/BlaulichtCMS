import { useId, useState } from 'react';

/**
 * Tageswerte einer Kennzahl als Säulen (Mengen je Tag) oder Linie (Bestand, z. B. Follower). Eine Reihe, daher ohne
 * Legende – der Titel benennt sie. Hover/Fokus zeigt Tag und Wert; die Tabelle darunter ist die zugängliche Fassung.
 * Farben nur über Tokens.
 */
export interface DailyPoint {
  day: string;
  value: number | null;
}

const nf = new Intl.NumberFormat('de-DE');
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });

export function DailyChart({ title, points, mode = 'bar', height = 140 }: { title: string; points: DailyPoint[]; mode?: 'bar' | 'line'; height?: number }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.map((p) => p.value).filter((v): v is number => typeof v === 'number');
  if (!vals.length) return null;
  const W = 600;
  const H = height;
  const padT = 8;
  const padB = 2;
  const min = mode === 'line' ? Math.min(...vals) : 0;
  const max = Math.max(...vals);
  const span = max - min || 1;
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span);
  const slot = W / points.length;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const xs = points.map((_, i) => slot * i + slot / 2);
  const line = points.map((p, i) => (typeof p.value === 'number' ? `${xs[i].toFixed(1)},${y(p.value).toFixed(1)}` : null)).filter(Boolean).join(' ');
  const h = hover != null ? points[hover] : null;
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-meta text-fg-muted tabular" aria-live="polite">
          {h ? `${dayLabel(h.day)}: ${typeof h.value === 'number' ? nf.format(h.value) : '–'}` : `max. ${nf.format(max)}`}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{`${title}: ${points.length} Tage, höchster Wert ${nf.format(max)}`}</title>
        <line x1="0" x2={W} y1={H - padB} y2={H - padB} stroke="var(--bc-border)" strokeWidth="1" />
        {mode === 'bar'
          ? points.map((p, i) =>
              typeof p.value === 'number' ? (
                <path
                  key={p.day}
                  d={roundedBar(xs[i] - barW / 2, y(p.value), barW, H - padB - y(p.value))}
                  fill="var(--bc-primary)"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              ) : null,
            )
          : (
            <>
              <polyline points={line} fill="none" stroke="var(--bc-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {h && typeof h.value === 'number' && (
                <>
                  <line x1={xs[hover!]} x2={xs[hover!]} y1={padT} y2={H - padB} stroke="var(--bc-border)" strokeWidth="1" />
                  <circle cx={xs[hover!]} cy={y(h.value)} r="4" fill="var(--bc-primary)" stroke="var(--bc-card)" strokeWidth="2" />
                </>
              )}
            </>
          )}
        {/* Trefferflächen über die ganze Höhe – größer als die Säulen */}
        {points.map((p, i) => (
          <rect key={`hit-${p.day}`} x={slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {/* Achsenbeschriftung als Text unter der Grafik – bleibt auch auf schmalen Bildschirmen lesbar */}
      <div className="flex justify-between text-meta text-fg-muted tabular -mt-1" aria-hidden="true">
        <span>{dayLabel(points[0].day)}</span>
        {points.length > 2 && <span>{dayLabel(points[Math.floor((points.length - 1) / 2)].day)}</span>}
        <span>{dayLabel(points[points.length - 1].day)}</span>
      </div>
      <details className="text-meta">
        <summary className="cursor-pointer text-fg-muted">Als Tabelle</summary>
        <table className="mt-1 w-full text-meta">
          <thead>
            <tr>
              <th className="text-left font-medium text-fg-muted">Tag</th>
              <th className="text-right font-medium text-fg-muted">{title}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}>
                <td>{dayLabel(p.day)}</td>
                <td className="text-right font-mono tabular">{typeof p.value === 'number' ? nf.format(p.value) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Säule mit abgerundetem oberen Ende (4 px), unten bündig an der Grundlinie. */
function roundedBar(x: number, top: number, w: number, h: number) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
}
