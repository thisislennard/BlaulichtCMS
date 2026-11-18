import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, Card, EmptyState, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, Table, Td, Textarea, Th, type Tone } from '../../components/ui/core';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';
import { useListState } from '../../lib/listState';
import { rank, searchTerms } from '../../lib/searchText';
import { fmtDateTime } from '../../lib/format';
import { CheckList } from '../automations/shared';
import { usePressLists } from './Distribution';
import { usePressOptions } from './shared';

interface ReleaseRow {
  id: string;
  subject: string;
  status: 'draft' | 'sending' | 'sent' | 'partial';
  source: string;
  list_ids: string[];
  created_at: string;
  sent_at: string | null;
  sent_by_name: string | null;
  recipients: number;
  sent: number;
  failed: number;
  log_purged_at: string | null;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Entwurf', tone: 'neutral' },
  sending: { label: 'Wird gesendet', tone: 'primary' },
  sent: { label: 'Gesendet', tone: 'success' },
  partial: { label: 'Teilweise gesendet', tone: 'warning' },
};
const RCPT: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Wartet', tone: 'neutral' },
  sending: { label: 'Wird gesendet', tone: 'primary' },
  sent: { label: 'Gesendet', tone: 'success' },
  failed: { label: 'Fehlgeschlagen', tone: 'error' },
  unknown: { label: 'Ergebnis unbekannt', tone: 'warning' },
};

function Editor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toastError = useErrorToast();
  const lists = usePressLists();
  const opts = usePressOptions();
  const existing = useQuery({ queryKey: ['press-release', id], queryFn: () => get<any>(`/press/releases/${id}`), enabled: !!id });
  const [v, setV] = useState<{ subject: string; body: string; listIds: string[]; postId: string } | null>(id ? null : { subject: '', body: '', listIds: [], postId: '' });
  if (id && existing.data && !v) setV({ subject: existing.data.release.subject, body: existing.data.release.body, listIds: existing.data.release.list_ids, postId: existing.data.release.post_id ?? '' });
  const save = async () => {
    try {
      const body = { subject: v!.subject, body: v!.body, listIds: v!.listIds, postId: v!.postId || null };
      if (id) await put(`/press/releases/${id}`, body);
      else await post('/press/releases', body);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title={id ? 'Pressemitteilung bearbeiten' : 'Neue Pressemitteilung'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!v || v.subject.trim().length < 2} onClick={save}>
            Entwurf speichern
          </Button>
        </>
      }
    >
      {!v ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="flex flex-col gap-4">
          <FieldWrap label="Aus einem Beitrag übernehmen" htmlFor="rl-post" help="Übernimmt Titel und Text der aktuellen Fassung – danach frei änderbar.">
            <Select
              id="rl-post"
              value={v.postId}
              onChange={async (e) => {
                const postId = e.target.value;
                setV({ ...v, postId });
                if (!postId) return;
                try {
                  const p = await get<{ subject: string; body: string }>(`/press/releases/from-post/${postId}`);
                  setV((x) => ({ ...x!, postId, subject: p.subject, body: p.body }));
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              <option value="">– frei schreiben –</option>
              {(opts.data?.posts ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap label="Betreff" required htmlFor="rl-subject">
            <Input id="rl-subject" value={v.subject} maxLength={300} onChange={(e) => setV({ ...v, subject: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Text" required htmlFor="rl-body" help="Reiner Text. Unter jede Mail setzt BlaulichtCMS einen persönlichen Abmeldelink.">
            <Textarea id="rl-body" rows={12} value={v.body} maxLength={50000} onChange={(e) => setV({ ...v, body: e.target.value })} />
          </FieldWrap>
          {(lists.data ?? []).length ? (
            <CheckList legend="An Verteilerlisten" options={(lists.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.contacts})` }))} value={v.listIds} onChange={(listIds) => setV({ ...v, listIds })} />
          ) : (
            <Notice tone="warning">Noch keine Verteilerliste – unter Presse → Presseverteiler anlegen.</Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Protocol({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const lists = usePressLists();
  const q = useQuery({ queryKey: ['press-release', id], queryFn: () => get<any>(`/press/releases/${id}`), refetchInterval: (query) => (query.state.data?.release?.status === 'sending' ? 3000 : false) });
  const r = q.data?.release;
  const send = async () => {
    const n = r.status === 'draft' ? r.list_ids.length : 0;
    if (!(await ask({ title: r.status === 'draft' ? 'Pressemitteilung jetzt senden?' : 'Restliche Empfänger anschreiben?', text: r.status === 'draft' ? `„${r.subject}“ geht einzeln an jeden angemeldeten Kontakt ${n === 1 ? 'der gewählten Liste' : `der ${n} gewählten Listen`}.` : 'Nur Empfänger, an die noch nicht gesendet wurde.', confirmLabel: 'Senden' }))) return;
    try {
      const res = await post<{ recipients: number }>(`/press/releases/${id}/send`);
      toast({ tone: 'success', title: `Versand an ${res.recipients} Empfänger gestartet` });
    } catch (e) {
      toastError(e);
    }
    q.refetch();
    onChange();
  };
  return (
    <Dialog open onClose={onClose} width={760} title={r?.subject ?? 'Pressemitteilung'} footer={<Button onClick={onClose}>Schließen</Button>}>
      {!r ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
            <span className="text-fg-muted">
              {r.list_ids.map((l: string) => lists.data?.find((x) => x.id === l)?.name ?? 'Liste').join(', ')}
              {r.sent_at ? ` · gesendet ${fmtDateTime(r.sent_at)}${r.sent_by_name ? ` von ${r.sent_by_name}` : ''}` : ''}
            </span>
          </div>
          <p className="m-0 whitespace-pre-wrap text-sm rounded-node border border-line p-3 max-h-60 overflow-auto">{r.body}</p>
          <div>
            <div className="text-meta text-fg-muted mb-1">Fußzeile jeder Mail</div>
            <p className="m-0 whitespace-pre-wrap text-meta text-fg-muted rounded-node border border-line p-3">{q.data.footer}</p>
          </div>
          {r.status === 'draft' && !q.data.footerComplete && (
            <Notice tone="warning" title="Verantwortliche Stelle oder Datenschutzerklärung fehlt">
              Bei Adressen aus anderen Quellen (Import, Visitenkarte, Redaktionsliste) verlangt Art. 14 DSGVO spätestens mit der ersten Mitteilung Angaben zur verantwortlichen Stelle und einen Datenschutzhinweis. Bitte unter Einstellungen → Datenschutz & Recht eintragen – die Fußzeile übernimmt sie dann.
            </Notice>
          )}
          {r.status === 'draft' && q.data.missingBasis > 0 && (
            <Notice tone="warning" title={`${q.data.missingBasis} Empfänger ohne vermerkte Rechtsgrundlage`}>
              Bitte im Presseverteiler ergänzen (Filter „Zu prüfen“). Gesendet wird trotzdem an alle angemeldeten Kontakte der Listen.
            </Notice>
          )}
          {r.log_purged_at && (
            <Notice title={`Versandprotokoll nach der Löschfrist entfernt (${fmtDateTime(r.log_purged_at)})`}>
              {r.recipients_sent ?? 0} von {r.recipients_total ?? 0} Empfängern erreicht{r.recipients_failed ? `, ${r.recipients_failed} nicht erreicht` : ''}. Adressen und Fehlermeldungen sind gelöscht (Einstellungen → Löschfristen → Versandprotokolle).
            </Notice>
          )}
          {(r.status === 'draft' || (r.status === 'partial' && !r.log_purged_at && q.data.recipients.some((x: any) => x.status === 'queued'))) && (
            <div>
              <Button variant="primary" icon="Send" onClick={send}>
                {r.status === 'draft' ? 'Jetzt senden' : 'Rest senden'}
              </Button>
            </div>
          )}
          {q.data.recipients.length > 0 && (
            <>
              <h3 className="m-0 text-sm font-semibold">Versandprotokoll</h3>
              <Table>
                <thead>
                  <tr>
                    <Th>Empfänger</Th>
                    <Th>Stand</Th>
                    <Th className="hidden md:table-cell">Hinweis</Th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.recipients.map((x: any) => (
                    <tr key={x.id}>
                      <Td>
                        {x.name ? `${x.name} · ` : ''}
                        {x.email}
                      </Td>
                      <Td>
                        <Badge tone={RCPT[x.status]?.tone ?? 'neutral'}>{RCPT[x.status]?.label ?? x.status}</Badge>
                      </Td>
                      <Td className="hidden md:table-cell text-meta text-fg-muted">{x.error ?? (x.sent_at ? fmtDateTime(x.sent_at) : '')}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Pressemitteilungen (#207): Entwürfe, Versand an Verteilerlisten (einzeln adressiert), Versandprotokoll. */
export default function Releases() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const toastError = useErrorToast();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<string | null | undefined>(undefined);
  const q = useQuery({ queryKey: ['press-releases'], queryFn: () => get<ReleaseRow[]>('/press/releases'), refetchInterval: 15_000 });
  const openId = params.get('id');
  const refresh = () => qc.invalidateQueries({ queryKey: ['press-releases'] });
  // Suche und Reiter in der Adresse (#260); das Versandprotokoll (?id=) bleibt davon unberührt
  const ls = useListState({ suche: '', status: 'alle' }, { tabKeys: ['status'] });
  const status = ls.values.status === 'alle' || STATUS[ls.values.status as keyof typeof STATUS] ? ls.values.status : 'alle';
  const terms = searchTerms(ls.values.suche);
  const found = (q.data ?? []).filter((r) => !terms.length || rank(terms, r.subject) !== null);
  const rows = found.filter((r) => status === 'alle' || r.status === status);
  const openProtocol = (id: string) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set('id', id);
    return n;
  });
  const closeProtocol = () => setParams((p) => {
    const n = new URLSearchParams(p);
    n.delete('id');
    return n;
  });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="An Verteilerlisten senden – jede Mail einzeln adressiert, nie mit offener Empfängerliste, immer mit Abmeldelink."
        actions={can('press.release') && <Button variant="primary" icon="Plus" onClick={() => setEdit(null)}>Neue Pressemitteilung</Button>}
      />
      {q.isLoading && <SkeletonRows rows={4} />}
      {!!q.data?.length && (
        <ListToolbar
          search={{ value: ls.values.suche, onChange: (v) => ls.set({ suche: v }), placeholder: 'Suchen in Pressemitteilungen', label: 'Pressemitteilungen durchsuchen (Betreff)' }}
          tabs={{ label: 'Status', value: status, onChange: (v) => ls.set({ status: v }), options: [{ value: 'alle', label: 'Alle', count: found.length }, ...Object.entries(STATUS).filter(([k]) => found.some((r) => r.status === k)).map(([value, s]) => ({ value, label: s.label, count: found.filter((r) => r.status === value).length }))] }}
          count={{ n: rows.length, one: 'Pressemitteilung', many: 'Pressemitteilungen' }}
          onReset={() => ls.reset()}
        />
      )}
      {q.data && !q.data.length && (
        <EmptyState
          icon="Newspaper"
          title="Noch keine Pressemitteilung."
          text="Frei schreiben oder aus einem Beitrag übernehmen."
          action={can('press.release') && <Button icon="Plus" onClick={() => setEdit(null)}>Neue Pressemitteilung</Button>}
        />
      )}
      {!!q.data?.length && !rows.length && <FilterEmpty onReset={() => ls.reset()} />}
      {rows.length > 0 && (
        <Card>
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <button type="button" className="font-medium text-left hover:underline max-md:min-h-10" onClick={() => openProtocol(r.id)}>
                    {r.subject}
                  </button>
                  <div className="text-meta text-fg-muted">
                    {r.sent_at ? `Gesendet ${fmtDateTime(r.sent_at)} · ${r.sent} von ${r.recipients}${r.failed ? ` · ${r.failed} nicht erreicht` : ''}` : `Angelegt ${fmtDateTime(r.created_at)}${r.source === 'workflow' ? ' · aus einem Workflow' : ''}`}
                  </div>
                </div>
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {r.status === 'draft' && (
                  <>
                    <Button size="sm" iconOnly icon="Pencil" aria-label={`${r.subject} bearbeiten`} onClick={() => setEdit(r.id)} />
                    <Button
                      size="sm"
                      iconOnly
                      icon="Trash2"
                      aria-label={`${r.subject} löschen`}
                      onClick={async () => {
                        if (!(await ask({ title: 'Entwurf löschen?', text: `„${r.subject}“ wird gelöscht.`, confirmLabel: 'Löschen' }))) return;
                        try {
                          await del(`/press/releases/${r.id}`);
                        } catch (e) {
                          toastError(e);
                        }
                        refresh();
                      }}
                    />
                  </>
                )}
                <Button size="sm" onClick={() => openProtocol(r.id)}>
                  {r.status === 'draft' ? 'Prüfen und senden' : 'Versandprotokoll'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {edit !== undefined && (
        <Editor
          id={edit}
          onClose={() => {
            setEdit(undefined);
            refresh();
            qc.invalidateQueries({ queryKey: ['press-release'] });
          }}
        />
      )}
      {openId && <Protocol id={openId} onClose={closeProtocol} onChange={refresh} />}
    </div>
  );
}
