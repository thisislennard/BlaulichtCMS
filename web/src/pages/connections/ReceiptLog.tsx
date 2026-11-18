import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Select, SkeletonRows, type Tone, EmptyLine } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { HelpTip } from '../../components/ui/HelpTip';
import { CopyButton } from '../../components/ui/overlays';
import { fmtBytes, fmtDateTime, fmtDuration } from '../../lib/format';

/** Verbindungsarten mit Empfangsprotokoll (Server: routes/connections.ts, RECEIPT_KINDS) */
export const RECEIPT_KINDS = ['warnfeed', 'fe2', 'feuersoftware'];

type Filter = '' | 'accepted' | 'filtered' | 'error';
const FILTERS: { value: Filter; label: string }[] = [
  { value: '', label: 'Alle Einträge' },
  { value: 'accepted', label: 'Nur übernommene' },
  { value: 'filtered', label: 'Nur herausgefilterte' },
  { value: 'error', label: 'Nur Fehler' },
];

const DECISION_TONE: Record<string, Tone> = { accepted: 'success', updated: 'success', known: 'neutral', filtered: 'neutral', dismissed: 'neutral', suppressed: 'neutral', test: 'neutral', error: 'error' };
const MSG_TYPE: Record<string, string> = { Alert: 'Meldung', Update: 'Aktualisierung', Cancel: 'Entwarnung' };
const PAGE_SIZE = 20;

/**
 * Empfangsprotokoll einer eingehenden Verbindung: jeder Abruf bzw. jede eingehende Meldung mit allen gelieferten
 * Meldungen, der Entscheidung („übernommen“, „herausgefiltert“ …) samt Grund und den Rohdaten. Aktualisiert sich,
 * solange die Ansicht offen ist.
 */
export function ReceiptLog({ id, kind }: { id: string; kind: string }) {
  const [filter, setFilter] = useState<Filter>('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ['receipts', id, filter, page],
    queryFn: () => get<any>(`/connections/${id}/receipts?page=${page}&limit=${PAGE_SIZE}${filter ? `&filter=${filter}` : ''}`),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE_SIZE));
  const toggle = (rid: string) => setOpen((s) => { const n = new Set(s); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  const isWarn = kind === 'warnfeed';

  return (
    <Card
      title="Empfangsprotokoll"
      subtitle={isWarn ? 'Jeder Abruf mit allen gelieferten Meldungen – auch denen, die der Gebietsfilter aussortiert.' : kind === 'fe2' ? 'Jede eingehende Meldung von FE2 mit der Entscheidung dazu.' : 'Jeder Abruf mit allen gelieferten Einsätzen – auch denen, die der Filter aussortiert.'}
      action={
        <HelpTip title="Empfangsprotokoll" more="/hilfe/verbindungen#empfangsprotokoll">
          <p className="m-0">Zeigt, was bei BlaulichtCMS ankommt und was daraus wird: übernommen, schon bekannt oder herausgefiltert – mit Grund.</p>
          <p className="m-0">{isWarn ? 'Fehlen eigene Warnungen, steht beim Eintrag „Gebiet passt nicht“ samt Geocodes und Orten der Meldung – daraus lässt sich der Gebietsfilter einstellen.' : kind === 'fe2' ? 'Die Rohdaten zeigen die Feldnamen der Meldung – hilfreich für die Feldzuordnung. Inhalte außerhalb der Allowlist sind geschwärzt.' : '„RIC nicht in der Liste“ nennt die RIC des Einsatzes – so lässt sich die Schreibweise für den Filter übernehmen.'}</p>
        </HelpTip>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3 justify-between">
          <FieldWrap label="Anzeigen" htmlFor="rc-filter" className="w-full sm:w-64">
            <Select id="rc-filter" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setPage(1); }}>
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </FieldWrap>
          {q.data && <p className="m-0 text-meta text-fg-muted">Einträge der letzten {q.data.retention_days} Tage, höchstens {q.data.cap} je Verbindung · aktualisiert sich selbst</p>}
        </div>
        {q.error && <ErrorBox title="Empfangsprotokoll konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
        {q.isLoading && <SkeletonRows rows={4} />}
        {q.data?.items.length === 0 && <EmptyLine>{filter ? 'Für diesen Filter gibt es zurzeit keinen Eintrag.' : kind === 'fe2' ? 'Einträge entstehen, sobald FE2 eine Meldung an die Eingangsadresse sendet.' : 'Einträge entstehen bei jedem Abruf – beim Testen, mit „Jetzt abrufen“ und planmäßig, sobald die Verbindung aktiv ist.'}</EmptyLine>}
        {!!q.data?.items.length && (
          <ul className="m-0 p-0 list-none flex flex-col border border-line rounded-card divide-y divide-line">
            {q.data.items.map((r: any) => (
              <li key={r.id}>
                <button type="button" aria-expanded={open.has(r.id)} onClick={() => toggle(r.id)} className="w-full text-left flex gap-2 items-start p-3 hover:bg-raised rounded-card">
                  <Icon name={open.has(r.id) ? 'ChevronDown' : 'ChevronRight'} size={16} className="mt-0.5 shrink-0 text-fg-muted" />
                  <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm tabular">{fmtDateTime(r.created_at, { seconds: true })}</span>
                      <Badge tone={r.ok ? 'success' : 'error'}>{r.ok ? 'OK' : 'Fehler'}</Badge>
                      <Badge dot={false}>{r.trigger_label}</Badge>
                    </div>
                    <div className="text-meta text-fg-muted font-mono tabular break-words">
                      {[`${r.received} empfangen`, `${r.accepted} übernommen`, r.filtered ? `${r.filtered} herausgefiltert` : null, r.errors ? `${r.errors} Fehler` : null, r.http_status ? `HTTP ${r.http_status}` : null, r.duration_ms != null ? fmtDuration(r.duration_ms) : null].filter(Boolean).join(' · ')}
                    </div>
                    {r.error && (
                      <div className="flex gap-1.5 items-start text-sm text-err">
                        <Icon name="XCircle" size={14} className="mt-0.5 shrink-0" />
                        <span className="break-words">{r.error}</span>
                      </div>
                    )}
                    {r.summary && <div className="text-meta text-fg-muted break-words">{r.summary}</div>}
                  </div>
                </button>
                {open.has(r.id) && <ReceiptItems id={id} receiptId={r.id} filter={filter} kind={kind} />}
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="ChevronLeft" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Neuere</Button>
            <span className="text-meta text-fg-muted font-mono tabular">Seite {page} von {pages}</span>
            <Button size="sm" iconRight="ChevronRight" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Ältere</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function ReceiptItems({ id, receiptId, filter, kind }: { id: string; receiptId: string; filter: Filter; kind: string }) {
  const q = useQuery({ queryKey: ['receipt-items', id, receiptId, filter], queryFn: () => get<any>(`/connections/${id}/receipts/${receiptId}/items${filter ? `?filter=${filter}` : ''}`) });
  if (q.error) return <div className="px-3 pb-3"><ErrorBox title="Meldungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox></div>;
  if (q.isLoading) return <div className="px-3 pb-3"><SkeletonRows rows={2} /></div>;
  const items: any[] = q.data?.items ?? [];
  if (!items.length) return <p className="m-0 px-3 pb-3 pl-9 text-sm text-fg-muted">{filter ? 'Keine Meldung passt zu diesem Filter.' : 'Keine einzelnen Meldungen (z. B. Abruf fehlgeschlagen oder Anfrage abgewiesen).'}</p>;
  return (
    <ul className="m-0 px-3 pb-3 sm:pl-9 list-none flex flex-col gap-2">
      {items.map((it) => <ReceiptItem key={it.id} id={id} receiptId={receiptId} item={it} kind={kind} redacted={!!q.data?.redacted} />)}
    </ul>
  );
}

function ReceiptItem({ id, receiptId, item, kind, redacted }: { id: string; receiptId: string; item: any; kind: string; redacted: boolean }) {
  const [showRaw, setShowRaw] = useState(false);
  const raw = useQuery({ queryKey: ['receipt-raw', id, receiptId, item.id], queryFn: () => get<any>(`/connections/${id}/receipts/${receiptId}/items/${item.id}/raw`), enabled: showRaw, staleTime: Infinity });
  const i = item.info ?? {};
  const warn = kind === 'warnfeed';
  const title = warn ? i.headline || i.event || i.identifier : [i.keyword, i.keywordText, i.category && !(i.keyword ?? '').toLowerCase().includes(String(i.category).toLowerCase()) ? i.category : null].filter(Boolean).join(' · ');
  const areas = (i.areas ?? []) as string[];
  const meta = warn
    ? [i.provider, i.severity, MSG_TYPE[i.msgType] ?? i.msgType, areas.length ? `${areas.slice(0, 3).join(', ')}${(i.areasTotal ?? areas.length) > 3 ? ` … (${i.areasTotal} Gebiete)` : ''}` : null, i.onset ? `ab ${fmtDateTime(i.onset)}` : null, i.expires ? `bis ${fmtDateTime(i.expires)}` : null]
    : [i.place, i.alarmTime ? `Alarm ${/^\d{4}-\d{2}-\d{2}T/.test(i.alarmTime) ? fmtDateTime(i.alarmTime) : i.alarmTime}` : null, i.ric ? `RIC ${i.ric}` : null, i.status ? `Status ${i.status}` : null];
  const ident = warn ? i.identifier : i.eventId;
  return (
    <li className="border border-line rounded-node p-3 flex flex-col gap-1.5 bg-card min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={DECISION_TONE[item.decision] ?? 'neutral'}>{item.decision_label}</Badge>
        <strong className="text-sm break-words min-w-0">{title || 'Ohne Bezeichnung'}</strong>
      </div>
      {meta.some(Boolean) && <div className="text-meta text-fg-muted break-words">{meta.filter(Boolean).join(' · ')}</div>}
      {ident && <div className="text-meta text-fg-muted break-all">Kennung <span className="font-mono">{ident}</span></div>}
      <div className={cx('text-sm break-words', item.decision === 'error' && 'text-err')}>{item.reason}</div>
      {item.has_raw && (
        <div className="flex flex-col gap-2 items-start">
          <Button size="sm" variant="ghost" icon={showRaw ? 'EyeOff' : 'Braces'} aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Rohdaten ausblenden' : 'Rohdaten anzeigen'}
          </Button>
          {showRaw && (
            <div className="w-full min-w-0 flex flex-col gap-2">
              {raw.isLoading && <SkeletonRows rows={2} />}
              {raw.error && <ErrorBox title="Rohdaten konnten nicht geladen werden">{(raw.error as Error).message}</ErrorBox>}
              {raw.data && (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-meta text-fg-muted">
                    <span>{redacted ? 'Geschwärzt: Straße, Hausnummer, Koordinaten, Namen, Telefonnummern und Freitext sind ausgeblendet.' : 'Vollständig, wie von der Quelle geliefert.'}</span>
                    {raw.data.truncated && <Badge tone="warning">gekürzt – {fmtBytes(raw.data.bytes)} insgesamt</Badge>}
                    <CopyButton value={raw.data.body} size="sm" />
                  </div>
                  <pre className="m-0 p-3 bg-raised rounded-control font-mono text-meta overflow-auto max-h-96 whitespace-pre max-w-full">{raw.data.body}</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
