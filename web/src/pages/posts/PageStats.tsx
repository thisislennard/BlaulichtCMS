import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Badge, Button, Card, EmptyState, ErrorBox, Notice, PageHeader, SegmentedControl, SkeletonRows } from '../../components/ui/core';
import { KpiCard } from '../../components/ui/data';
import { DailyChart } from '../../components/ui/DailyChart';
import { HelpTip } from '../../components/ui/HelpTip';
import { useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';
import { InsightsNav } from './InsightsNav';
import { fmtNum, MetricLine } from './Insights';

/** Seitenstatistik: Kennzahlen je Tag und Top-Beiträge der Facebook-Seiten und Instagram-Konten (Seitenabgleich). */
interface Conn {
  id: string;
  kind: 'facebook' | 'instagram';
  name: string;
  active: boolean;
  enabled: boolean;
  sync: { posts_at: string | null; stats_day: string | null; ok: boolean; message: string | null; at: string } | null;
  current: Record<string, number>;
  current_day: string | null;
  follower_change: number | null;
  series: { day: string; metrics: Record<string, number> }[];
  totals: Record<string, number>;
  posts: number;
  from_blaulichtcms: number;
  interactions: number;
  top: { id: string; posted_at: string; message: string; permalink: string | null; image: string | null; post_id: string | null; metrics: Record<string, number> | null; interactions: number }[];
}

const NET = { facebook: 'Facebook', instagram: 'Instagram' } as const;
const DAILY: { key: string; label: string }[] = [
  { key: 'views', label: 'Aufrufe je Tag' },
  { key: 'reach', label: 'Erreichte Personen je Tag' },
  { key: 'interactions', label: 'Interaktionen je Tag' },
  { key: 'new_followers', label: 'Neue Follower je Tag' },
  { key: 'page_views', label: 'Seitenbesuche je Tag' },
  { key: 'engaged', label: 'Interagierende Konten je Tag' },
];

/** Alle Tage des Zeitraums (fehlende Tage als Lücke), damit die Achse gleichmäßig bleibt. */
function fillDays(series: Conn['series'], days: number, key: string) {
  const map = new Map(series.map((s) => [s.day, s.metrics?.[key]]));
  const out = [];
  const today = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    const v = map.get(d);
    out.push({ day: d, value: typeof v === 'number' ? v : null });
  }
  return out;
}

export default function PageStats() {
  const [days, setDays] = useState<'30' | '90' | '365'>('30');
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['insights', 'pages', days], queryFn: () => get<{ days: number; connections: Conn[] }>(`/insights/pages?days=${days}`) });
  const sync = async () => {
    try {
      await post('/insights/pages/sync');
      toast({ tone: 'success', title: 'Abgleich gestartet', text: 'Die Zahlen erscheinen nach und nach – die Seite aktualisiert sich in einer Minute.' });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['insights'] }), 60_000);
    } catch (e) {
      toastError(e);
    }
  };
  const list = q.data?.connections ?? [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Follower, Aufrufe und Reichweite der Facebook-Seiten und Instagram-Konten – alle Beiträge, auch direkt auf der Plattform erstellte."
        actions={can('insights.feed') ? <Button icon="RefreshCw" onClick={sync}>Jetzt abgleichen</Button> : undefined}
      />
      <InsightsNav />
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl label="Zeitraum" value={days} onChange={setDays} options={[{ value: '30', label: '30 Tage' }, { value: '90', label: '90 Tage' }, { value: '365', label: '1 Jahr' }]} />
        <HelpTip title="Woher die Zahlen kommen" more="/hilfe/verbindungen#seitenstatistik">
          <p className="m-0">BlaulichtCMS gleicht die Seiten stündlich ab und holt einmal am Tag die Tageswerte. Follower werden täglich festgehalten – der Verlauf beginnt mit dem ersten Abgleich.</p>
          <p className="m-0">Meta liefert Seiten-Kennzahlen nur mit dem Statistik-Recht und teils erst ab 100 Followern; Instagram mit bis zu 48 Stunden Verzögerung.</p>
        </HelpTip>
      </div>
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Seitenstatistik konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && list.length === 0 && <EmptyState icon="ChartLine" title="Keine Facebook-Seite und kein Instagram-Konto verbunden" text="Die Seitenstatistik nutzt die Verbindungen zu Facebook und Instagram." action={<Link to="/verbindungen">Zu den Verbindungen</Link>} />}
      {list.map((c) => (
        <Card
          key={c.id}
          title={`${NET[c.kind]}: ${c.name}`}
          subtitle={c.sync ? `Letzter Abgleich ${fmtRelative(c.sync.at)}` : 'Noch nicht abgeglichen'}
          action={!c.active ? <Badge tone="neutral">nicht aktiv</Badge> : !c.enabled ? <Badge tone="neutral">Abgleich aus</Badge> : c.sync && !c.sync.ok ? <Badge tone="error">Abgleich gestört</Badge> : undefined}
        >
          <div className="flex flex-col gap-4">
            {!c.active && <Notice tone="info">Die Verbindung ist nicht aktiv – abgeglichen wird erst nach Test und Aktivierung.</Notice>}
            {c.active && !c.enabled && <Notice tone="info">Der Abgleich ist in der <Link to={`/verbindungen/${c.id}`}>Verbindung</Link> ausgeschaltet.</Notice>}
            {c.sync && !c.sync.ok && <Notice tone="warning" title="Letzter Abgleich fehlgeschlagen">{c.sync.message}</Notice>}
            {c.sync?.ok && c.sync.message && <p className="m-0 text-meta text-fg-muted">{c.sync.message} – meist fehlt das Statistik-Recht oder die Seite ist zu klein.</p>}
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <KpiCard label="Follower" icon="Users" value={fmtNum(c.current.followers)} delta={c.follower_change != null ? `${c.follower_change >= 0 ? '+' : ''}${fmtNum(c.follower_change)} im Zeitraum` : c.current.fans != null ? `${fmtNum(c.current.fans)} „Gefällt mir“` : undefined} deltaTone={c.follower_change != null && c.follower_change > 0 ? 'ok' : 'muted'} />
              <KpiCard label="Aufrufe" icon="Eye" value={fmtNum(c.totals.views)} delta={typeof c.totals.reach === 'number' ? `${fmtNum(c.totals.reach)} erreicht (Tagessumme)` : undefined} deltaTone="muted" />
              <KpiCard label="Beiträge" icon="Share2" value={fmtNum(c.posts)} delta={`${fmtNum(c.from_blaulichtcms)} aus BlaulichtCMS`} deltaTone="muted" />
              <KpiCard label="Interaktionen" icon="TrendingUp" value={fmtNum(c.interactions)} delta="an Beiträgen im Zeitraum" deltaTone="muted" />
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <DailyChart title="Follower" mode="line" points={fillDays(c.series, Number(days), 'followers')} />
              {DAILY.map((m) => (
                <DailyChart key={m.key} title={m.label} points={fillDays(c.series, Number(days), m.key)} />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-medium">Top-Beiträge im Zeitraum</h3>
              {c.top.length === 0 ? (
                <p className="m-0 text-sm text-fg-muted">Noch keine Beiträge im Zeitraum.</p>
              ) : (
                <ol className="m-0 p-0 list-none flex flex-col gap-3 text-sm">
                  {c.top.map((t, i) => (
                    <li key={t.id} className="flex gap-3 items-start">
                      <span className="font-mono tabular text-fg-muted w-6 shrink-0">{i + 1}.</span>
                      {t.image ? <img src={`/api/v1/social-images/${t.image}`} alt="" loading="lazy" className="w-14 h-14 object-cover rounded-node shrink-0 border border-line" /> : null}
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="line-clamp-2 break-words">{t.message || <span className="text-fg-muted">(ohne Text)</span>}</span>
                        <span className="flex flex-wrap gap-x-3 text-meta text-fg-muted">
                          <span>{fmtDateTime(t.posted_at)}</span>
                          {t.post_id && <Link to={`/beitraege/${t.post_id}`}>aus BlaulichtCMS</Link>}
                          {t.permalink && (
                            <a href={safeHref(t.permalink)} target="_blank" rel="noopener noreferrer">
                              bei {NET[c.kind]} öffnen
                            </a>
                          )}
                        </span>
                        <span className="text-meta">
                          <MetricLine m={t.metrics} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
