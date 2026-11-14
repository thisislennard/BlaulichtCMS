import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client';
import { Button, Card, Chip, cx, EmptyState, ErrorBox, Kbd, LinkButton, PageHeader, SegmentedControl, Skeleton, StatusBadge } from '../components/ui/core';
import { CopyButton } from '../components/ui/overlays';
import { KpiCard } from '../components/ui/data';
import { Icon } from '../components/ui/Icon';
import { useCatalog } from '../components/forms/SchemaForm';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { fmtDuration, fmtNumber, fmtPercent, fmtRelative, fmtTime, getTimeZone } from '../lib/format';
import { fmtWhen, isTypingTarget, triggerInfo, useNow } from './runs/runShared';

type Range = '24h' | '7d' | '30d';

interface DashboardData {
  range: Range;
  kpis: {
    activeWorkflows: { value: number; total: number };
    successful: { value: number; previous: number; spark: number[] };
    failed: { value: number; previous: number; spark: number[] };
    connected: { value: number; total: number; problems: number };
    events24h: { value: number; spark: number[] };
    running: number;
  };
  series: { t: string; ok: number; err: number }[];
  totalRuns: number;
  services: { id: string; name: string; state: string; detail: string; ms: number | null }[];
  connections: { id: string; name: string; connector: string; status: string; status_message: string | null; last_test_ms: number | null }[];
  recent: { id: number; workflow_id: string; workflow_name: string; trigger_kind: string; trigger_label: string; status: string; created_at: string; duration_ms: number | null; mode: string }[];
  failures: { id: number; workflow_name: string; summary: string; created_at: string; error_code: string | null }[];
  approvals: { id: string; number: number; workflow_id: string; name: string; requested_at: string; requested_by: string | null }[];
  expiring: { id: string; name: string; credentials_expire_at: string }[];
  bannerEnds: { id: string; title: string; ends_at: string; color: string }[];
}

function hourInTz(): number {
  // formatToParts statt format: „de-DE“ liefert sonst „06 Uhr“ (→ NaN → immer „Guten Abend“)
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: getTimeZone(), hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
}

function greeting(name: string) {
  const h = hourInTz();
  const key = h < 11 ? 'morning' : h < 18 ? 'day' : 'evening';
  return t(`dashboard.greeting.${key}`, { name });
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return t('dashboard.justNow');
  if (s < 60) return t('dashboard.secondsAgo', { n: s });
  return fmtRelative(ts);
}

function signed(n: number, digits = 0) {
  if (n === 0) return fmtNumber(0, digits);
  return (n > 0 ? '+' : '−') + fmtNumber(Math.abs(n), digits);
}

export default function Dashboard() {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem('ll.dashboard.range');
      return v === '7d' || v === '30d' ? v : '24h';
    } catch {
      return '24h';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ll.dashboard.range', range);
    } catch {
      /* egal */
    }
  }, [range]);
  const q = useQuery<DashboardData>({ queryKey: ['dashboard', range], queryFn: () => get(`/dashboard?range=${range}`), refetchInterval: 30_000, placeholderData: (p) => p });
  const catalog = useCatalog().data;
  const now = useNow(1000);
  const d = q.data;

  const quick = useMemo(
    () =>
      [
        can('workflow.edit') && { key: 'N', label: t('dashboard.quick.new'), desc: t('dashboard.quick.newDesc'), icon: 'Plus', to: '/workflows?neu=1' },
        can('connection.edit') && { key: 'I', label: t('dashboard.quick.integration'), desc: t('dashboard.quick.integrationDesc'), icon: 'Plug', to: '/schnittstellen' },
        can('workflow.read') && { key: 'T', label: t('dashboard.quick.test'), desc: t('dashboard.quick.testDesc'), icon: 'FlaskConical', to: '/workflows' },
        can('run.read') && { key: 'L', label: t('dashboard.quick.runs'), desc: t('dashboard.quick.runsDesc'), icon: 'History', to: '/ausfuehrungen' },
      ].filter(Boolean) as { key: string; label: string; desc: string; icon: string; to: string }[],
    [can],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const hit = quick.find((x) => x.key === e.key.toUpperCase());
      if (hit) {
        e.preventDefault();
        navigate(hit.to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quick, navigate]);

  const firstName = (me?.user.name ?? '').split(/\s+/)[0] || me?.user.email.split('@')[0] || '';
  const prevLabel = t(`dashboard.range.prev${range}`);

  return (
    <>
      <PageHeader
        title={greeting(firstName)}
        subtitle={
          d ? (
            d.kpis.activeWorkflows.value === 1 ? (
              t('dashboard.subtitleOne', { ago: ago(q.dataUpdatedAt, now) })
            ) : (
              t('dashboard.subtitle', { n: fmtNumber(d.kpis.activeWorkflows.value), ago: ago(q.dataUpdatedAt, now) })
            )
          ) : undefined
        }
        actions={
          <>
            <SegmentedControl<Range>
              label={t('dashboard.range.label')}
              value={range}
              onChange={setRange}
              options={(['24h', '7d', '30d'] as Range[]).map((r) => ({ value: r, label: t(`dashboard.range.${r}`) }))}
            />
            {can('workflow.edit') && (
              <LinkButton to="/workflows?neu=1" variant="primary" icon="Plus">
                {t('dashboard.newWorkflow')}
              </LinkButton>
            )}
          </>
        }
      >
        {!d && <Skeleton className="h-4 w-64 mt-1" />}
      </PageHeader>

      {q.isError && !d && (
        <ErrorBox
          title={t('dashboard.error.title')}
          actions={
            <>
              <Button size="sm" icon="RefreshCw" onClick={() => q.refetch()}>
                {t('dashboard.error.retry')}
              </Button>
              <CopyButton size="sm" value={String((q.error as Error)?.message ?? q.error)} label={t('dashboard.error.details')} />
            </>
          }
        >
          {t('dashboard.error.text')}
        </ErrorBox>
      )}

      {/* KPI-Karten */}
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {d ? <Kpis d={d} prevLabel={prevLabel} /> : Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[118px] !rounded-card" />)}
      </div>

      {d && <Attention d={d} />}

      {/* Zeile 2: Diagramm | Systemstatus */}
      <div className="flex flex-wrap gap-5 items-stretch">
        <Card
          className="flex-[2_1_560px]"
          title={t('dashboard.chart.title')}
          subtitle={d ? (d.totalRuns === 1 ? t('dashboard.chart.subtitleOne', { range: t(`dashboard.range.long${range}`) }) : t('dashboard.chart.subtitle', { range: t(`dashboard.range.long${range}`), n: fmtNumber(d.totalRuns) })) : ' '}
          action={
            <div className="flex gap-4 text-meta text-fg-muted" aria-hidden="true">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-[3px] bg-primary" />
                {t('dashboard.chart.success')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-[3px] bg-[var(--ll-error)]" />
                {t('dashboard.chart.failed')}
              </span>
            </div>
          }
        >
          {d ? <ActivityChart series={d.series} range={range} /> : <Skeleton className="h-[246px]" />}
        </Card>
        <SystemCard d={d} canSystem={can('system.read')} />
      </div>

      {/* Zeile 3: Letzte Ausführungen | Schnellaktionen */}
      <div className="flex flex-wrap gap-5 items-stretch">
        <Card className="flex-[2_1_560px]" title={t('dashboard.recent.title')} action={<Link to="/ausfuehrungen" className="text-sm">{t('dashboard.recent.all')}</Link>} bodyClassName="!px-0 pb-2">
          <RecentRuns d={d} catalog={catalog} />
        </Card>
        {quick.length > 0 && (
          <Card className="flex-[1_1_300px]" title={t('dashboard.quick.title')} bodyClassName="!px-3 pb-3 flex flex-col gap-1">
            {quick.map((x) => (
              <Link key={x.key} to={x.to} aria-keyshortcuts={x.key} className="flex items-center gap-3 px-2 py-2.5 rounded-control !text-fg hover:bg-raised transition-colors duration-fast">
                <span className="w-8 h-8 rounded-control bg-primary-soft text-fg-link inline-flex items-center justify-center shrink-0">
                  <Icon name={x.icon} size={16} />
                </span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-medium">{x.label}</span>
                  <span className="text-meta text-fg-muted">{x.desc}</span>
                </span>
                <span title={t('dashboard.quick.hint', { key: x.key })}>
                  <Kbd>{x.key}</Kbd>
                </span>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------ KPIs ------------------------------------------ */

function Kpis({ d, prevLabel }: { d: DashboardData; prevLabel: string }) {
  const k = d.kpis;
  // Erfolgreiche: Prozent ggü. Vorzeitraum, neutral gefärbt (mehr Läufe sind weder gut noch schlecht)
  const okDelta = (() => {
    const { value, previous } = k.successful;
    if (value === previous) return t('dashboard.kpi.unchanged', { prev: prevLabel });
    if (!previous) return `${signed(value)} ${prevLabel}`;
    return `${signed(((value - previous) / previous) * 100, 1)} % ${prevLabel}`;
  })();
  // Fehlgeschlagen: absolute Differenz; farbig nur bei spürbarer Änderung
  const errDiff = k.failed.value - k.failed.previous;
  const errTone: 'ok' | 'err' | 'muted' = Math.abs(errDiff) >= 2 && Math.abs(errDiff) >= k.failed.previous * 0.2 ? (errDiff > 0 ? 'err' : 'ok') : 'muted';
  const finished = k.successful.value + k.failed.value;
  const evSpark = k.events24h.spark;
  const peakIdx = evSpark.reduce((best, v, i) => (v > evSpark[best] ? i : best), 0);
  const peakHour = new Date(Date.now() - (evSpark.length - 1 - peakIdx) * 3_600_000);
  peakHour.setMinutes(0, 0, 0);
  return (
    <>
      <KpiCard
        label={t('dashboard.kpi.active')}
        icon="Workflow"
        value={fmtNumber(k.activeWorkflows.value)}
        unit={t('dashboard.kpi.of', { n: fmtNumber(k.activeWorkflows.total) })}
        delta={k.running ? (k.running === 1 ? t('dashboard.kpi.runningOne') : t('dashboard.kpi.running', { n: fmtNumber(k.running) })) : t('dashboard.kpi.noneRunning')}
        deltaTone="muted"
      />
      <KpiCard label={t('dashboard.kpi.successful')} icon="CheckCircle2" value={fmtNumber(k.successful.value)} delta={okDelta} deltaTone="muted" spark={k.successful.spark} sparkColor="var(--ll-ok)" />
      <KpiCard
        label={t('dashboard.kpi.failed')}
        icon="XCircle"
        value={fmtNumber(k.failed.value)}
        unit={finished ? fmtPercent((k.failed.value / finished) * 100) : undefined}
        delta={errDiff === 0 ? t('dashboard.kpi.unchanged', { prev: prevLabel }) : `${signed(errDiff)} ${prevLabel}`}
        deltaTone={errTone}
        spark={k.failed.spark}
        sparkColor="var(--ll-err)"
      />
      <KpiCard
        label={t('dashboard.kpi.connected')}
        icon="Plug"
        value={fmtNumber(k.connected.value)}
        unit={t('dashboard.kpi.of', { n: fmtNumber(k.connected.total) })}
        delta={!k.connected.total ? t('dashboard.kpi.noConnections') : k.connected.problems ? t('dashboard.kpi.problems', { n: fmtNumber(k.connected.problems) }) : t('dashboard.kpi.allOk')}
        deltaTone={k.connected.problems ? 'err' : 'muted'}
      />
      <KpiCard
        label={t('dashboard.kpi.events')}
        icon="Activity"
        value={fmtNumber(k.events24h.value)}
        delta={k.events24h.value ? t('dashboard.kpi.peak', { time: fmtTime(peakHour) }) : t('dashboard.kpi.noEvents')}
        deltaTone="muted"
        spark={evSpark}
        sparkColor="var(--ll-cyan)"
      />
    </>
  );
}

/* --------------------------------------- Hinweiskarten ------------------------------------- */

function AttentionItem({ to, title, meta, dot, extra }: { to: string; title: ReactNode; meta: ReactNode; dot?: ReactNode; extra?: ReactNode }) {
  return (
    <li>
      <Link to={to} className="flex items-start gap-2.5 px-2 py-2 rounded-control !text-fg hover:bg-raised transition-colors duration-fast">
        {dot}
        <span className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium truncate">{title}</span>
          <span className="text-meta text-fg-muted break-words">{meta}</span>
        </span>
        {extra}
      </Link>
    </li>
  );
}

function Attention({ d }: { d: DashboardData }) {
  const cards: ReactNode[] = [];
  if (d.failures.length)
    cards.push(
      <Card key="f" className="flex-[1_1_320px]" title={<span className="inline-flex items-center gap-2"><Icon name="XCircle" size={16} className="text-err" />{t('dashboard.attention.failures')}</span>} action={<Link to="/ausfuehrungen" className="text-sm">{t('dashboard.attention.failuresAll')}</Link>} bodyClassName="!px-3 pb-3">
        <ul className="m-0 p-0 list-none flex flex-col">
          {d.failures.map((f) => (
            <AttentionItem
              key={f.id}
              to={`/ausfuehrungen/${f.id}`}
              title={f.workflow_name}
              meta={
                <>
                  <span className="font-mono">#{f.id}</span> · {fmtWhen(f.created_at)} · {f.summary}
                </>
              }
              extra={<span className="text-meta text-fg-link shrink-0 self-center">{t('dashboard.attention.diagnose')} →</span>}
            />
          ))}
        </ul>
      </Card>,
    );
  if (d.approvals.length)
    cards.push(
      <Card key="a" className="flex-[1_1_300px]" title={<span className="inline-flex items-center gap-2"><Icon name="ShieldCheck" size={16} className="text-warn" />{t('dashboard.attention.approvals')}</span>} bodyClassName="!px-3 pb-3">
        <ul className="m-0 p-0 list-none flex flex-col">
          {d.approvals.map((a) => (
            <AttentionItem
              key={a.id}
              to={`/workflows/${a.workflow_id}`}
              title={a.name}
              meta={a.requested_by ? t('dashboard.attention.approvalBy', { n: a.number, name: a.requested_by, when: fmtRelative(a.requested_at) }) : t('dashboard.attention.approvalByUnknown', { n: a.number, when: fmtRelative(a.requested_at) })}
            />
          ))}
        </ul>
      </Card>,
    );
  if (d.expiring.length)
    cards.push(
      <Card key="e" className="flex-[1_1_300px]" title={<span className="inline-flex items-center gap-2"><Icon name="KeyRound" size={16} className="text-warn" />{t('dashboard.attention.expiring')}</span>} bodyClassName="!px-3 pb-3">
        <ul className="m-0 p-0 list-none flex flex-col">
          {d.expiring.map((c) => {
            const past = new Date(c.credentials_expire_at).getTime() < Date.now();
            return (
              <AttentionItem
                key={c.id}
                to={`/verbindungen/${c.id}`}
                title={c.name}
                meta={<span className={past ? 'text-err' : 'text-warn'}>{past ? t('dashboard.attention.expired', { when: fmtRelative(c.credentials_expire_at) }) : t('dashboard.attention.expiresAt', { when: fmtRelative(c.credentials_expire_at) })}</span>}
              />
            );
          })}
        </ul>
      </Card>,
    );
  if (d.bannerEnds.length)
    cards.push(
      <Card key="b" className="flex-[1_1_300px]" title={<span className="inline-flex items-center gap-2"><Icon name="Megaphone" size={16} className="text-fg-link" />{t('dashboard.attention.banners')}</span>} action={<Link to="/wordpress" className="text-sm">{t('dashboard.attention.manage')}</Link>} bodyClassName="!px-3 pb-3">
        <ul className="m-0 p-0 list-none flex flex-col">
          {d.bannerEnds.map((b) => (
            <AttentionItem
              key={b.id}
              to="/wordpress"
              title={b.title}
              meta={t('dashboard.attention.bannerEnds', { when: fmtRelative(b.ends_at) })}
              dot={<span aria-hidden="true" className="w-1 self-stretch rounded-full shrink-0" style={{ background: b.color }} />}
            />
          ))}
        </ul>
      </Card>,
    );
  if (!cards.length) return null;
  return <div className="flex flex-wrap gap-5 items-stretch">{cards}</div>;
}

/* ------------------------------------ Aktivitätsdiagramm ----------------------------------- */

/** Schrittweite der Hilfslinien (1·2·5 × 10^n), sodass 4 Schritte den Höchstwert abdecken. */
function niceStep(v: number) {
  const raw = Math.max(1, v / 4);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function bucketLabel(iso: string, range: Range, long = false) {
  const d = new Date(iso);
  if (range === '24h') {
    if (!long) return fmtTime(d);
    return `${fmtTime(d)}–${fmtTime(new Date(d.getTime() + 3_600_000))}`;
  }
  const opts: Intl.DateTimeFormatOptions = { timeZone: getTimeZone(), day: '2-digit', month: '2-digit', ...(range === '7d' || long ? { weekday: 'short' } : {}) };
  return new Intl.DateTimeFormat('de-DE', opts).format(d);
}

function ActivityChart({ series, range }: { series: DashboardData['series']; range: Range }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 216;
  const padL = 34;
  const padB = 22;
  const padT = 6;
  const plotW = w - padL;
  const plotH = H - padB - padT;
  const step = niceStep(Math.max(0, ...series.map((s) => s.ok + s.err)));
  const max = step * 4;
  const n = series.length || 1;
  const band = plotW / n;
  const barW = Math.max(2, Math.min(28, band * 0.64));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const totalOk = series.reduce((a, s) => a + s.ok, 0);
  const totalErr = series.reduce((a, s) => a + s.err, 0);
  const rangeLong = t(`dashboard.range.long${range}`);
  const h = hover != null ? series[hover] : null;

  return (
    <div className="flex flex-col gap-2">
      <div ref={wrap} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg width={w} height={H} role="img" aria-label={t('dashboard.chart.aria', { unit: range === '24h' ? t('dashboard.chart.unitHour') : t('dashboard.chart.unitDay'), range: rangeLong, ok: fmtNumber(totalOk), err: fmtNumber(totalErr) })} className="block">
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={w} y1={y(v)} y2={y(v)} stroke="var(--ll-border)" strokeDasharray={i === 0 ? undefined : '3 4'} />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="font-mono" fontSize="11" fill="var(--ll-text-2)">
                {fmtNumber(v)}
              </text>
            </g>
          ))}
          {series.map((s, i) => {
            const cx0 = padL + band * i + (band - barW) / 2;
            const okH = (s.ok / max) * plotH;
            const errH = (s.err / max) * plotH;
            const base = padT + plotH;
            const dim = hover != null && hover !== i;
            return (
              <g key={s.t} onMouseEnter={() => setHover(i)} opacity={dim ? 0.55 : 1}>
                <title>{t('dashboard.chart.bar', { time: bucketLabel(s.t, range, true), ok: fmtNumber(s.ok), err: fmtNumber(s.err) })}</title>
                <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />
                {s.ok > 0 && <rect x={cx0} y={base - okH} width={barW} height={okH} rx={Math.min(3, barW / 3)} fill="var(--ll-primary)" />}
                {s.err > 0 && <rect x={cx0} y={base - okH - errH - (s.ok > 0 ? 1 : 0)} width={barW} height={errH} rx={Math.min(3, barW / 3)} fill="var(--ll-error)" />}
              </g>
            );
          })}
          {series.map((s, i) => {
            const isLast = i === n - 1;
            if (!isLast && (n - 1 - i) % labelEvery !== 0) return null;
            if (!isLast && n - 1 - i < labelEvery * 0.6) return null;
            return (
              <text key={s.t} x={padL + band * i + band / 2} y={H - 6} textAnchor={isLast ? 'end' : 'middle'} dx={isLast ? band / 2 : 0} className="font-mono" fontSize="11" fill="var(--ll-text-2)">
                {isLast && range === '24h' ? t('dashboard.chart.now') : bucketLabel(s.t, range)}
              </text>
            );
          })}
        </svg>
        {h && hover != null && (
          <div
            aria-hidden="true"
            className="absolute pointer-events-none bg-raised border border-line rounded-control shadow-float px-2.5 py-2 text-meta flex flex-col gap-0.5 whitespace-nowrap z-10"
            style={{ left: Math.min(Math.max(padL + band * hover + band / 2 - 80, 0), w - 170), top: 0 }}
          >
            <span className="font-mono text-fg-muted">{bucketLabel(h.t, range, true)}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-[2px] bg-primary" />
              {fmtNumber(h.ok)} {t('dashboard.chart.success')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-[2px] bg-[var(--ll-error)]" />
              {fmtNumber(h.err)} {t('dashboard.chart.failed')}
            </span>
          </div>
        )}
      </div>
      {totalOk + totalErr === 0 && <p className="m-0 text-meta text-fg-muted">{t('dashboard.chart.empty')}</p>}
      <table className="sr-only">
        <caption>{t('dashboard.chart.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.chart.colTime')}</th>
            <th scope="col">{t('dashboard.chart.success')}</th>
            <th scope="col">{t('dashboard.chart.failed')}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.t}>
              <th scope="row">{bucketLabel(s.t, range, true)}</th>
              <td>{s.ok}</td>
              <td>{s.err}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------- Systemstatus -------------------------------------- */

const STATE_DOT: Record<string, string> = { ok: 'bg-ok', warning: 'bg-warn', error: 'bg-err', untested: 'bg-fg-muted' };
const STATE_TEXT: Record<string, string> = { ok: 'text-fg-muted', warning: 'text-warn', error: 'text-err', untested: 'text-fg-muted' };

function SystemRow({ name, state, sub, ms, to }: { name: string; state: string; sub: string; ms: number | null; to?: string }) {
  const label = t(`dashboard.status.${STATE_DOT[state] ? state : 'untested'}`);
  const inner = (
    <>
      <span aria-hidden="true" className={cx('w-2 h-2 rounded-full shrink-0', STATE_DOT[state] ?? 'bg-fg-muted')} />
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{name}</span>
        <span className={cx('text-meta truncate', STATE_TEXT[state] ?? 'text-fg-muted')} title={sub}>
          {state === 'ok' ? sub || label : sub ? `${label} · ${sub}` : label}
        </span>
      </span>
      <span className="font-mono text-meta text-fg-muted tabular shrink-0">{ms != null ? `${fmtNumber(ms)} ms` : '—'}</span>
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} className="flex items-center gap-3 px-2 py-2 rounded-control !text-fg hover:bg-raised transition-colors duration-fast">
          {inner}
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-2 py-2">{inner}</div>
      )}
    </li>
  );
}

function SystemCard({ d, canSystem }: { d?: DashboardData; canSystem: boolean }) {
  return (
    <Card className="flex-[1_1_300px]" title={t('dashboard.status.title')} action={<Link to={canSystem ? '/system' : '/verbindungen'} className="text-sm">{t('dashboard.status.all')}</Link>} bodyClassName="!px-3 pb-3">
      {!d ? (
        <div className="flex flex-col gap-2 px-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <h4 className="m-0 px-2 text-label uppercase text-fg-muted">{t('dashboard.status.services')}</h4>
          <ul className="m-0 p-0 list-none">
            {d.services.map((s) => (
              <SystemRow key={s.id} name={s.name} state={s.state} sub={s.detail} ms={s.ms} />
            ))}
          </ul>
          <h4 className="m-0 px-2 pt-1 text-label uppercase text-fg-muted">{t('dashboard.status.connections')}</h4>
          {d.connections.length ? (
            <ul className="m-0 p-0 list-none">
              {d.connections.map((c) => (
                <SystemRow key={c.id} name={c.name} state={c.status} sub={c.status === 'ok' ? '' : c.status_message ?? ''} ms={c.last_test_ms} to={`/verbindungen/${c.id}`} />
              ))}
            </ul>
          ) : (
            <p className="m-0 px-2 text-meta text-fg-muted">{t('dashboard.status.noConnections')}</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------ Letzte Ausführungen ---------------------------------- */

function RecentRuns({ d, catalog }: { d?: DashboardData; catalog: ReturnType<typeof useCatalog>['data'] }) {
  if (!d)
    return (
      <div className="flex flex-col gap-2 px-5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  if (!d.recent.length) return <EmptyState icon="History" title={t('dashboard.recent.emptyTitle')} text={t('dashboard.recent.emptyText')} action={<LinkButton to="/workflows" size="sm">{t('dashboard.recent.emptyAction')}</LinkButton>} />;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[620px]">
        <thead>
          <tr>
            {[t('dashboard.recent.workflow'), t('dashboard.recent.trigger'), t('dashboard.recent.start'), t('dashboard.recent.duration'), t('dashboard.recent.result')].map((h, i) => (
              <th key={h} scope="col" className={cx('text-meta font-medium text-fg-muted py-2 px-3 border-b border-line text-left whitespace-nowrap', i === 0 && 'pl-5')}>
                {h}
              </th>
            ))}
            <th scope="col" className="border-b border-line pr-5">
              <span className="sr-only">{t('dashboard.recent.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {d.recent.map((r) => {
            const tr = triggerInfo(catalog, r.trigger_kind);
            return (
              <tr key={r.id} className="hover:bg-raised transition-colors duration-fast">
                <td className="py-2.5 px-3 pl-5 border-b border-line">
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate max-w-[280px]">{r.workflow_name}</span>
                    <span className="font-mono text-meta text-fg-muted inline-flex items-center gap-1.5">
                      #{r.id}
                      {r.mode === 'test' && <Chip className="!h-[18px] !px-1.5 !text-[11px]">{t('dashboard.recent.test')}</Chip>}
                    </span>
                  </div>
                </td>
                <td className="py-2.5 px-3 border-b border-line">
                  <span className="inline-flex items-center gap-1.5 text-fg-muted min-w-0">
                    <Icon name={tr.icon} size={14} className="shrink-0" />
                    <span className="truncate max-w-[200px]">{r.trigger_label || tr.title}</span>
                  </span>
                </td>
                <td className="py-2.5 px-3 border-b border-line font-mono text-meta tabular whitespace-nowrap">{fmtWhen(r.created_at, true)}</td>
                <td className="py-2.5 px-3 border-b border-line font-mono text-meta tabular whitespace-nowrap">{fmtDuration(r.duration_ms)}</td>
                <td className="py-2.5 px-3 border-b border-line">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-2.5 px-3 pr-5 border-b border-line text-right">
                  <Link to={`/ausfuehrungen/${r.id}`} aria-label={t('dashboard.recent.detailsFor', { id: r.id })} className="inline-flex items-center gap-1 text-sm whitespace-nowrap">
                    {t('dashboard.recent.details')} <Icon name="ChevronRight" size={14} />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
