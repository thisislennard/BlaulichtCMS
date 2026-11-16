import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { del, get, patch, post } from '../../api/client';
import { usePageMeta } from '../../components/layout/AppShell';
import { Button, Card, cx, ErrorBox, FieldWrap, Input, KeyValue, PageHeader, Select, SkeletonRows, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { DeleteDialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../../lib/format';
import { CHANNEL_LABEL, PressStatusBadge, RequestDialog, STATUS_LABEL, usePressOptions, type PressRequest, type PressStatus } from './shared';
import { PressMessages, type PressDetailExtras } from './Messages';

interface Detail extends PressDetailExtras {
  request: PressRequest;
  events: { id: number; at: string; actor_name: string; kind: string; text: string }[];
}

const EVENT_ICON: Record<string, string> = { created: 'Plus', status: 'CheckCircle2', assignee: 'User', due: 'Clock', link: 'Link2', note: 'NotebookPen', edit: 'Pencil', mail_in: 'Mail', mail_out: 'Send', reply: 'Reply' };

/** Eine Presseanfrage (#204): Steuerung (Status, Zuständigkeit, Frist, Verknüpfungen), Kontakt, Mails und Verlauf. */
export default function PressRequestPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['press-request', id], queryFn: () => get<Detail>(`/press/requests/${id}`), refetchInterval: 30_000 });
  const opts = usePressOptions(can('press.manage'));
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const r = q.data?.request;
  usePageMeta({ title: r?.case_no });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['press-request', id] });
    qc.invalidateQueries({ queryKey: ['press-requests'] });
  };
  const change = async (body: Record<string, unknown>) => {
    try {
      await patch(`/press/requests/${id}`, body);
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  if (q.isLoading) return <SkeletonRows rows={8} />;
  if (q.error || !r) return <ErrorBox title="Presseanfrage konnte nicht geladen werden">{(q.error as Error)?.message}</ErrorBox>;
  const manage = can('press.manage');
  const dueValue = due ?? toLocalInput(r.due_at);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={r.topic}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <PressStatusBadge status={r.status} />
            <span className="font-mono">{r.case_no}</span>
            <span>
              · {CHANNEL_LABEL[r.channel] ?? r.channel} · erfasst {fmtDateTime(r.created_at)}
              {r.created_by_name ? ` von ${r.created_by_name}` : ''}
            </span>
          </span>
        }
        actions={
          manage && (
            <>
              <Button icon="Pencil" onClick={() => setEditing(true)}>
                Bearbeiten
              </Button>
              <Button variant="danger" icon="Trash2" onClick={() => setDeleting(true)}>
                Löschen
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Card title="Anfrage">
            {r.body ? <p className="m-0 whitespace-pre-wrap break-words">{r.body}</p> : <p className="m-0 text-fg-muted">Kein Anfragetext erfasst.</p>}
          </Card>
          <PressMessages request={r} detail={q.data!} onChange={refresh} />
          <Card title="Verlauf und Notizen">
            <ol className="m-0 p-0 list-none flex flex-col gap-3">
              {q.data!.events.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className={cx('mt-0.5 shrink-0 w-7 h-7 rounded-full flex items-center justify-center', e.kind === 'note' ? 'bg-primary-soft text-fg-link' : 'bg-raised text-fg-muted')}>
                    <Icon name={EVENT_ICON[e.kind] ?? 'History'} size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-meta text-fg-muted">
                      {e.actor_name} · {fmtDateTime(e.at)}
                      {e.kind === 'note' ? ' · interne Notiz' : ''}
                    </div>
                    <div className={cx('break-words', e.kind === 'note' && 'whitespace-pre-wrap')}>{e.text}</div>
                  </div>
                </li>
              ))}
            </ol>
            {manage && (
              <div className="mt-4 flex flex-col gap-2">
                <FieldWrap label="Interne Notiz" htmlFor="pr-note" help="Nur in BlaulichtCMS sichtbar, nie in Antworten.">
                  <Textarea id="pr-note" rows={3} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
                </FieldWrap>
                <div>
                  <Button
                    icon="NotebookPen"
                    disabled={!note.trim()}
                    onClick={async () => {
                      try {
                        await post(`/press/requests/${id}/notes`, { text: note });
                        setNote('');
                      } catch (e) {
                        toastError(e);
                      }
                      refresh();
                    }}
                  >
                    Notiz speichern
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-5">
          <Card title="Bearbeitung">
            {manage ? (
              <div className="flex flex-col gap-4">
                <FieldWrap label="Status" htmlFor="pr-status">
                  <Select id="pr-status" value={r.status} onChange={(e) => change({ status: e.target.value })}>
                    {(Object.keys(STATUS_LABEL) as PressStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Zuständig" htmlFor="pr-assign">
                  <Select id="pr-assign" value={r.assignee_id ?? ''} onChange={(e) => change({ assigneeId: e.target.value || null })}>
                    <option value="">– niemand –</option>
                    {r.assignee_id && !opts.data?.users.some((u) => u.id === r.assignee_id) && <option value={r.assignee_id}>{r.assignee_name ?? 'unbekannt'}</option>}
                    {(opts.data?.users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Frist" htmlFor="pr-due2" error={r.overdue ? 'Frist überschritten' : null} help="Erinnerung über die Benachrichtigungen.">
                  <div className="flex gap-2">
                    <Input id="pr-due2" type="datetime-local" value={dueValue} onChange={(e) => setDue(e.target.value)} />
                    <Button
                      disabled={due === null || dueValue === toLocalInput(r.due_at)}
                      onClick={async () => {
                        await change({ dueAt: dueValue ? fromLocalInput(dueValue) : null });
                        setDue(null);
                      }}
                    >
                      Setzen
                    </Button>
                  </div>
                </FieldWrap>
              </div>
            ) : (
              <KeyValue items={[['Status', <PressStatusBadge key="s" status={r.status} />], ['Zuständig', r.assignee_name ?? '–'], ['Frist', r.due_at ? fmtDateTime(r.due_at) : '–']]} />
            )}
          </Card>
          <Card title="Kontakt">
            <KeyValue
              items={[
                ['Medium', r.outlet || '–'],
                ['Name', r.contact_name || '–'],
                ['E-Mail', r.contact_email ? <a key="m" href={`mailto:${r.contact_email}`}>{r.contact_email}</a> : '–'],
                ['Telefon', r.contact_phone ? <a key="t" href={`tel:${r.contact_phone.replace(/[^\d+]/g, '')}`}>{r.contact_phone}</a> : '–'],
              ]}
            />
          </Card>
          <Card title="Verknüpfungen">
            {manage ? (
              <div className="flex flex-col gap-4">
                <FieldWrap label="Einsatz" htmlFor="pr-event" help="Aus FE2 oder Feuersoftware Connect.">
                  <Select id="pr-event" value={r.fe2_event_id ?? ''} onChange={(e) => change({ fe2EventId: e.target.value || null })}>
                    <option value="">– keiner –</option>
                    {r.fe2_event_id && !opts.data?.events.some((x) => x.id === r.fe2_event_id) && <option value={r.fe2_event_id}>{r.fe2_title ?? 'Einsatz'}</option>}
                    {(opts.data?.events ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title} · {fmtDateTime(x.received_at)}
                      </option>
                    ))}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Beitrag" htmlFor="pr-post" labelAction={r.post_id && can('post.view') ? <Link to={`/beitraege/${r.post_id}`} className="text-sm">Öffnen</Link> : undefined}>
                  <Select id="pr-post" value={r.post_id ?? ''} onChange={(e) => change({ postId: e.target.value || null })}>
                    <option value="">– keiner –</option>
                    {r.post_id && !opts.data?.posts.some((x) => x.id === r.post_id) && <option value={r.post_id}>{r.post_title ?? 'Beitrag'}</option>}
                    {(opts.data?.posts ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                  </Select>
                </FieldWrap>
              </div>
            ) : (
              <KeyValue items={[['Einsatz', r.fe2_title ?? '–'], ['Beitrag', r.post_id && can('post.view') ? <Link key="p" to={`/beitraege/${r.post_id}`}>{r.post_title}</Link> : (r.post_title ?? '–')]]} />
            )}
          </Card>
        </div>
      </div>
      {editing && (
        <RequestDialog
          request={r}
          onClose={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      <DeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        objectType="Presseanfrage"
        name={r.case_no}
        extra={<p className="m-0 text-sm text-fg-muted">Gelöscht werden die Anfrage samt Kontaktdaten, Verlauf, Mails und Anhängen.</p>}
        onConfirm={async () => {
          await del(`/press/requests/${id}`);
          qc.invalidateQueries({ queryKey: ['press-requests'] });
          nav('/presse');
        }}
      />
    </div>
  );
}
