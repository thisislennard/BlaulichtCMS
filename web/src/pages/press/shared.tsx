import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, patch, post } from '../../api/client';
import { Badge, Button, FieldWrap, Input, Select, Textarea, type Tone } from '../../components/ui/core';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { fromLocalInput, toLocalInput } from '../../lib/format';

/** Presseanfragen (#204): gemeinsame Typen, Beschriftungen und der Dialog zum Erfassen/Bearbeiten. */

export type PressStatus = 'new' | 'in_progress' | 'answered' | 'done';
export const STATUS_LABEL: Record<PressStatus, string> = { new: 'Neu', in_progress: 'In Bearbeitung', answered: 'Beantwortet', done: 'Erledigt' };
// „Neu“ = offen, braucht jemanden (Gelb); in Bearbeitung neutral; Rot bleibt Fehlern und Hauptaktionen (#270)
const STATUS_TONE: Record<PressStatus, Tone> = { new: 'warning', in_progress: 'neutral', answered: 'success', done: 'neutral' };
export const CHANNEL_LABEL: Record<string, string> = { phone: 'Telefon', mail: 'E-Mail', mailbox: 'Presse-Postfach', in_person: 'Persönlich', other: 'Sonstiges' };

export function PressStatusBadge({ status }: { status: PressStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export interface PressRequestRow {
  id: string;
  case_no: string;
  status: PressStatus;
  channel: string;
  outlet: string;
  contact_name: string;
  topic: string;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  assignee_id: string | null;
  assignee_name: string | null;
  overdue: boolean;
}

export interface PressRequest extends PressRequestRow {
  body: string;
  contact_email: string;
  contact_phone: string;
  post_id: string | null;
  post_title: string | null;
  fe2_event_id: string | null;
  fe2_title: string | null;
  fe2_received_at: string | null;
  created_by_name: string | null;
  answered_at: string | null;
  done_at: string | null;
}

export interface PressOptions {
  users: { id: string; name: string }[];
  posts: { id: string; title: string }[];
  events: { id: string; title: string; keyword: string | null; received_at: string }[];
}

export const usePressOptions = (enabled = true) => useQuery({ queryKey: ['press-options'], queryFn: () => get<PressOptions>('/press/options'), enabled, staleTime: 60_000 });

/** Erfassen (ohne `request`) oder Stammdaten bearbeiten. */
export function RequestDialog({ request, onClose }: { request?: PressRequest; onClose: (id?: string) => void }) {
  const toastError = useErrorToast();
  const opts = usePressOptions();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    topic: request?.topic ?? '',
    body: request?.body ?? '',
    outlet: request?.outlet ?? '',
    contactName: request?.contact_name ?? '',
    contactEmail: request?.contact_email ?? '',
    contactPhone: request?.contact_phone ?? '',
    channel: request?.channel ?? 'phone',
    assigneeId: request?.assignee_id ?? '',
    dueAt: toLocalInput(request?.due_at ?? null),
  });
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { topic: v.topic, body: v.body, outlet: v.outlet, contactName: v.contactName, contactEmail: v.contactEmail.trim(), contactPhone: v.contactPhone, channel: v.channel };
      if (!request) {
        body.assigneeId = v.assigneeId || null;
        body.dueAt = v.dueAt ? fromLocalInput(v.dueAt) : null;
        const r = await post<{ id: string }>('/press/requests', body);
        onClose(r.id);
      } else {
        await patch(`/press/requests/${request.id}`, body);
        onClose(request.id);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => onClose()}
      width={680}
      title={request ? `Anfrage ${request.case_no} bearbeiten` : 'Presseanfrage erfassen'}
      footer={
        <>
          <Button onClick={() => onClose()}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={v.topic.trim().length < 2} onClick={save}>
            {request ? 'Speichern' : 'Anfrage anlegen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Thema" required htmlFor="pr-topic">
          <Input id="pr-topic" value={v.topic} maxLength={300} onChange={(e) => set({ topic: e.target.value })} placeholder="z. B. Brand in der Lagerhalle" />
        </FieldWrap>
        <FieldWrap label="Anfrage" htmlFor="pr-body" help="Was genau wird gefragt? Bei Anrufen: Stichpunkte zum Gespräch.">
          <Textarea id="pr-body" rows={5} value={v.body} maxLength={20000} onChange={(e) => set({ body: e.target.value })} />
        </FieldWrap>
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Medium/Redaktion" htmlFor="pr-outlet">
            <Input id="pr-outlet" value={v.outlet} maxLength={200} onChange={(e) => set({ outlet: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Eingangsweg" htmlFor="pr-channel">
            <Select id="pr-channel" value={v.channel} onChange={(e) => set({ channel: e.target.value })}>
              {Object.entries(CHANNEL_LABEL).filter(([k]) => k !== 'mailbox' || v.channel === 'mailbox').map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap label="Name" htmlFor="pr-name">
            <Input id="pr-name" value={v.contactName} maxLength={200} autoComplete="off" onChange={(e) => set({ contactName: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="E-Mail" htmlFor="pr-mail" help="Für Antworten aus BlaulichtCMS.">
            <Input id="pr-mail" type="email" value={v.contactEmail} maxLength={254} autoComplete="off" onChange={(e) => set({ contactEmail: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Telefon" htmlFor="pr-phone">
            <Input id="pr-phone" type="tel" value={v.contactPhone} maxLength={60} autoComplete="off" onChange={(e) => set({ contactPhone: e.target.value })} />
          </FieldWrap>
          {!request && (
            <>
              <FieldWrap label="Zuständig" htmlFor="pr-assignee">
                <Select id="pr-assignee" value={v.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })}>
                  <option value="">– niemand –</option>
                  {(opts.data?.users ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </FieldWrap>
              <FieldWrap label="Frist" htmlFor="pr-due" help="Erinnerung über die Benachrichtigungen.">
                <Input id="pr-due" type="datetime-local" value={v.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />
              </FieldWrap>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
