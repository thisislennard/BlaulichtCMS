import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Card, Chip, EmptyState, ErrorBox, FieldWrap, Notice, PageHeader, SegmentedControl, Select, SkeletonRows, Table, Td, Th } from '../../components/ui/core';
import { KpiCard } from '../../components/ui/data';
import { HelpTip } from '../../components/ui/HelpTip';
import { fmtDateTime } from '../../lib/format';
import { SOCIAL_KINDS, SOCIAL_LABEL, type SocialKind } from '../../lib/social';
import { safeHref } from '../../lib/url';

/** Kennzahlen der Reichweite (#218) – nur zusammengefasste Zahlen, keine Personen. */
export const METRIC_LABEL: Record<string, string> = { views: 'Aufrufe', reach: 'Erreicht', likes: 'Gefällt mir', replies: 'Antworten', reposts: 'Reposts', quotes: 'Zitate', shares: 'Geteilt', saves: 'Gespeichert', clicks: 'Klicks' };
export const METRIC_ORDER = ['views', 'reach', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'saves', 'clicks'];
const nf = new Intl.NumberFormat('de-DE');
export const fmtNum = (v: unknown) => (typeof v === 'number' ? nf.format(v) : '–');

/** Kompakte Zeile „Aufrufe 1.234 · Gefällt mir 12 …“ (nur vorhandene Werte). */
export function MetricLine({ m }: { m: Record<string, number> | null | undefined }) {
  if (!m) return null;
  const parts = METRIC_ORDER.filter((k) => typeof m[k] === 'number');
  if (!parts.length) return <span className="text-fg-muted">Noch keine Zahlen.</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {parts.map((k) => (
        <span key={k}>
          <span className="text-fg-muted">{METRIC_LABEL[k]}</span> <span className="font-mono tabular">{fmtNum(m[k])}</span>
        </span>
      ))}
    </span>
  );
}

interface Overview {
  days: number;
  publications: number;
  measured: number;
  pending: number;
  errors: number;
  totals: Record<string, number>;
  interactions: number;
  channels: { kind: SocialKind; publications: number; measured: number; totals: Record<string, number>; interactions: number }[];
  top: { post_id: string; title: string; interactions: number; views: number | null; published_at: string; channels: { kind: SocialKind; name: string; url: string | null; insights: Record<string, number> | null }[] }[];
}

export default function Insights() {
  const [days, setDays] = useState<'7' | '30' | '90' | '365'>('30');
  const [kind, setKind] = useState('');
  const q = useQuery({ queryKey: ['insights', days, kind], queryFn: () => get<Overview>(`/insights?days=${days}${kind ? `&kind=${kind}` : ''}`) });
  const d = q.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Aufrufe und Interaktionen veröffentlichter Social-Posts – nur Summen, keine Personen." />
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl label="Zeitraum" value={days} onChange={setDays} options={[{ value: '7', label: '7 Tage' }, { value: '30', label: '30 Tage' }, { value: '90', label: '90 Tage' }, { value: '365', label: '1 Jahr' }]} />
        <FieldWrap label="Netzwerk" htmlFor="ins-kind" className="min-w-[200px]">
          <Select id="ins-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Alle Netzwerke</option>
            {SOCIAL_KINDS.filter((k) => k !== 'whatsapp').map((k) => (
              <option key={k} value={k}>
                {SOCIAL_LABEL[k]}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <HelpTip title="Woher die Zahlen kommen" more="/hilfe/verbindungen#reichweite">
          <p className="m-0">BlaulichtCMS fragt die offiziellen Statistik-Schnittstellen 1 Stunde, 24 Stunden und 7 Tage nach der Veröffentlichung ab. Gezählt werden nur Beiträge über eine Schnittstelle – keine Storys und nichts, was von Hand geteilt wurde.</p>
          <p className="m-0">Welche Zahlen ein Netzwerk liefert, ist verschieden; „–“ heißt: liefert das Netzwerk nicht oder fehlt das Recht.</p>
        </HelpTip>
      </div>
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Reichweite konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {d && d.publications === 0 && <EmptyState icon="ChartColumn" title="Keine Veröffentlichungen im Zeitraum" text="Sobald Beiträge über Facebook, Instagram, Threads, X (API), Mastodon oder Bluesky veröffentlicht sind, erscheinen hier ihre Zahlen." />}
      {d && d.publications > 0 && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Veröffentlichungen" icon="Share2" value={fmtNum(d.publications)} delta={d.pending ? `${d.pending} noch ohne Zahlen` : `${d.measured} mit Zahlen`} deltaTone="muted" />
            <KpiCard label="Aufrufe" icon="Eye" value={fmtNum(d.totals.views)} delta={typeof d.totals.reach === 'number' ? `${fmtNum(d.totals.reach)} erreicht` : undefined} deltaTone="muted" />
            <KpiCard label="Interaktionen" icon="TrendingUp" value={fmtNum(d.interactions)} delta="Gefällt mir, Antworten, Reposts, Geteilt …" deltaTone="muted" />
            <KpiCard label="Klicks" icon="MousePointerClick" value={fmtNum(d.totals.clicks)} delta="nur Facebook" deltaTone="muted" />
          </div>
          {d.errors > 0 && <Notice tone="warning">Für {d.errors === 1 ? 'eine Veröffentlichung' : `${d.errors} Veröffentlichungen`} ließen sich keine Zahlen abrufen – meist fehlt das Statistik-Recht der Verbindung. Einzelheiten stehen im Beitrag.</Notice>}
          <Card title="Je Netzwerk">
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Netzwerk</Th>
                    <Th align="right">Beiträge</Th>
                    {METRIC_ORDER.map((k) => (
                      <Th key={k} align="right">
                        {METRIC_LABEL[k]}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.channels.map((c) => (
                    <tr key={c.kind}>
                      <Td>{SOCIAL_LABEL[c.kind] ?? c.kind}</Td>
                      <Td align="right" mono>
                        {c.publications}
                      </Td>
                      {METRIC_ORDER.map((k) => (
                        <Td key={k} align="right" mono>
                          {fmtNum(c.totals[k])}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
          <Card title="Top-Beiträge" subtitle="Nach Interaktionen über alle Netzwerke eines Beitrags.">
            {d.top.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine Zahlen – der erste Abruf folgt eine Stunde nach der Veröffentlichung.</p>
            ) : (
              <ol className="m-0 p-0 list-none flex flex-col gap-4 text-sm">
                {d.top.map((t, i) => (
                  <li key={t.post_id} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono tabular text-fg-muted w-6">{i + 1}.</span>
                      <Link to={`/beitraege/${t.post_id}`} className="font-medium">
                        {t.title}
                      </Link>
                      <span className="text-meta text-fg-muted">{fmtDateTime(t.published_at)}</span>
                      <span className="ml-auto font-mono tabular">{fmtNum(t.interactions)} Interaktionen</span>
                    </div>
                    <ul className="m-0 pl-8 list-none flex flex-col gap-1">
                      {t.channels.map((c, j) => (
                        <li key={j} className="flex flex-wrap items-baseline gap-2">
                          <Chip>{SOCIAL_LABEL[c.kind] ?? c.kind}</Chip>
                          {c.url ? (
                            <a href={safeHref(c.url)} target="_blank" rel="noopener noreferrer">
                              {c.name}
                            </a>
                          ) : (
                            <span>{c.name}</span>
                          )}
                          <span className="text-meta">
                            <MetricLine m={c.insights} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
