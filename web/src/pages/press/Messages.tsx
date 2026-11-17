import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { del, get, post } from '../../api/client';
import { Badge, Button, Card, cx, FieldWrap, Input, Notice, Select, Textarea, type Tone } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import type { PressRequest } from './shared';

export interface PressMessage {
  id: string;
  direction: 'in' | 'out';
  status: string;
  from_address: string;
  from_name: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string;
  html_body: string | null;
  blocked_images: number;
  skipped_attachments: { filename: string; reason: string }[];
  received_at: string | null;
  created_at: string;
  created_by_name: string | null;
  submitted_by: string | null;
  decision_note: string;
  decided_at: string | null;
  sent_at: string | null;
  error: string | null;
  attachments: { id: string; filename: string; content_type: string; size: number }[];
}

/** Zusatzdaten der Detailansicht (Mails – #205/#206). */
export interface PressDetailExtras {
  messages?: PressMessage[];
  replyApproval?: boolean;
}

/** Platzhalter der Textbausteine (#206) – beim Einfügen in die Antwort ersetzt. */
export const SNIPPET_PLACEHOLDERS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name der anfragenden Person' },
  { key: 'medium', label: 'Medium/Redaktion' },
  { key: 'thema', label: 'Thema der Anfrage' },
  { key: 'nummer', label: 'Vorgangsnummer' },
  { key: 'frist', label: 'Frist' },
  { key: 'absender', label: 'Eigener Name' },
];

export function renderSnippet(text: string, r: PressRequest, me: string): string {
  const values: Record<string, string> = { name: r.contact_name, medium: r.outlet, thema: r.topic, nummer: r.case_no, frist: r.due_at ? fmtDateTime(r.due_at) : '', absender: me };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}

const OUT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Wartet auf Freigabe', tone: 'warning' },
  rejected: { label: 'Zurückgewiesen', tone: 'error' },
  queued: { label: 'Wird gesendet', tone: 'primary' },
  sending: { label: 'Wird gesendet', tone: 'primary' },
  sent: { label: 'Gesendet', tone: 'success' },
  failed: { label: 'Versand fehlgeschlagen', tone: 'error' },
  unknown: { label: 'Ergebnis unbekannt – prüfen', tone: 'warning' },
};

/**
 * HTML einer Mail: serverseitig entschärft und zusätzlich in einem abgeschotteten iframe ohne Skripte, ohne Zugriff auf
 * BlaulichtCMS und ohne Nachladen aus dem Internet (eigene Inhaltsrichtlinie).
 */
function HtmlView({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"></head><body style="font:14px/1.5 system-ui,sans-serif;margin:12px;color:#1b1f24;background:#fff;overflow-wrap:anywhere">${html}</body></html>`;
  return <iframe title="HTML-Ansicht der Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full h-[320px] rounded-control border border-line bg-white" />;
}

function ReplyActions({ m, onChange }: { m: PressMessage; onChange: () => void }) {
  const { can, me } = useAuth();
  const toastError = useErrorToast();
  const ask = useConfirm();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
    onChange();
  };
  const own = m.submitted_by && m.submitted_by === me?.user.id;
  return (
    <div className="flex flex-wrap gap-2">
      {m.status === 'pending' && can('press.approve') && !own && (
        <>
          <Button size="sm" variant="primary" icon="Check" onClick={() => act(() => post(`/press/replies/${m.id}/decision`, { decision: 'approved' }))}>
            Freigeben und senden
          </Button>
          <Button size="sm" icon="X" onClick={() => setRejecting(true)}>
            Zurückweisen
          </Button>
        </>
      )}
      {m.status === 'pending' && own && <span className="text-meta text-fg-muted self-center">Eine zweite Person mit „Antworten an die Presse freigeben“ muss zustimmen.</span>}
      {m.status === 'failed' && can('press.reply') && (
        <Button size="sm" icon="RefreshCw" onClick={() => act(() => post(`/press/replies/${m.id}/retry`))}>
          Erneut senden
        </Button>
      )}
      {m.status === 'unknown' && can('press.reply') && (
        <>
          <Button size="sm" icon="CheckCircle2" onClick={() => act(() => post(`/press/replies/${m.id}/resolve`, { sent: true }))}>
            Ist angekommen
          </Button>
          <Button size="sm" icon="XCircle" onClick={() => act(() => post(`/press/replies/${m.id}/resolve`, { sent: false }))}>
            Ist nicht angekommen
          </Button>
        </>
      )}
      {['pending', 'rejected', 'failed'].includes(m.status) && can('press.reply') && (
        <Button size="sm" variant="ghost" icon="Trash2" onClick={async () => (await ask({ title: 'Antwort verwerfen?', text: 'Die Antwort wird nicht gesendet und aus dem Verlauf entfernt.', confirmLabel: 'Verwerfen' })) && act(() => del(`/press/replies/${m.id}`))}>
          Verwerfen
        </Button>
      )}
      <Dialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Antwort zurückweisen"
        footer={
          <>
            <Button onClick={() => setRejecting(false)}>Abbrechen</Button>
            <Button
              variant="danger"
              disabled={!note.trim()}
              onClick={async () => {
                setRejecting(false);
                await act(() => post(`/press/replies/${m.id}/decision`, { decision: 'rejected', note }));
              }}
            >
              Zurückweisen
            </Button>
          </>
        }
      >
        <FieldWrap label="Was soll geändert werden?" required htmlFor="rej-note">
          <Textarea id="rej-note" rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </FieldWrap>
      </Dialog>
    </div>
  );
}

function MessageItem({ m, onChange }: { m: PressMessage; onChange: () => void }) {
  const [html, setHtml] = useState(false);
  const [open, setOpen] = useState(true);
  const incoming = m.direction === 'in';
  const st = OUT_STATUS[m.status];
  return (
    <li className={cx('rounded-node border border-line p-3 flex flex-col gap-2', incoming ? 'bg-card' : 'bg-raised')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Icon name={incoming ? 'Mail' : 'Reply'} size={15} className="text-fg-muted" />
        <span className="font-medium">{incoming ? m.from_name || m.from_address : `Antwort an ${m.to_addresses.join(', ')}`}</span>
        {incoming && m.from_name && <span className="text-fg-muted">&lt;{m.from_address}&gt;</span>}
        {!incoming && st && <Badge tone={st.tone}>{st.label}</Badge>}
        <span className="text-meta text-fg-muted ml-auto">
          {fmtDateTime(m.sent_at ?? m.received_at ?? m.created_at)}
          {!incoming && m.created_by_name ? ` · ${m.created_by_name}` : ''}
        </span>
      </div>
      <button type="button" className="text-left font-medium hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.subject || '(ohne Betreff)'}
      </button>
      {open && (
        <>
          {!incoming && m.cc_addresses.length > 0 && <div className="text-meta text-fg-muted">Kopie an {m.cc_addresses.join(', ')}</div>}
          {html && m.html_body ? <HtmlView html={m.html_body} /> : <p className="m-0 whitespace-pre-wrap break-words text-sm">{m.text_body || '(kein Text)'}</p>}
          {m.html_body && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" icon={html ? 'FileText' : 'Eye'} onClick={() => setHtml(!html)}>
                {html ? 'Als Text anzeigen' : 'HTML-Ansicht'}
              </Button>
              {html && m.blocked_images > 0 && <span className="text-meta text-fg-muted">{m.blocked_images} Bild(er) aus dem Internet blockiert (Zählpixel-Schutz)</span>}
            </div>
          )}
          {m.attachments.length > 0 && (
            <ul className="m-0 p-0 list-none flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <li key={a.id}>
                  <a href={`/api/v1/press/attachments/${a.id}`} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-chip border border-line text-sm" download>
                    <Icon name="Paperclip" size={14} />
                    {a.filename}
                    <span className="text-meta text-fg-muted">{fmtBytes(a.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {m.skipped_attachments.length > 0 && <Notice tone="warning">Nicht übernommen: {m.skipped_attachments.map((s) => `${s.filename} (${s.reason})`).join(', ')}</Notice>}
          {!incoming && m.status === 'rejected' && m.decision_note && <Notice tone="error">Zurückgewiesen: {m.decision_note}</Notice>}
          {!incoming && m.error && ['failed', 'unknown'].includes(m.status) && <Notice tone={m.status === 'unknown' ? 'warning' : 'error'}>{m.error}</Notice>}
          {!incoming && <ReplyActions m={m} onChange={onChange} />}
        </>
      )}
    </li>
  );
}

/** Eingangswege, auf die üblicherweise mündlich geantwortet wird (#272). */
export const ORAL_CHANNELS = ['phone', 'in_person'];

/** Mündliche Antwort festhalten (#272): Antworttext in den Verlauf und Status „beantwortet“ in einem Schritt. */
function RecordAnswer({ request, onDone, onCancel }: { request: PressRequest; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await post<{ status: string }>(`/press/requests/${request.id}/answer`, { text });
      toast({ tone: 'success', title: 'Antwort festgehalten', text: r.status === 'answered' ? 'Status: Beantwortet' : undefined });
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <FieldWrap label="Was wurde geantwortet?" required htmlFor="ra-text" help={`Kurz festhalten, was ${request.channel === 'phone' ? 'am Telefon' : 'vor Ort'} gesagt wurde. Steht im Verlauf; der Status wird „Beantwortet“.`}>
        <Textarea id="ra-text" rows={4} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} />
      </FieldWrap>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon="Check" loading={busy} disabled={!text.trim()} onClick={save}>
          Antwort festhalten
        </Button>
        <Button onClick={onCancel}>Abbrechen</Button>
      </div>
    </div>
  );
}

/**
 * Antwort-Editor (#206): Empfänger, Betreff, Textbaustein, Text – senden bzw. zur Freigabe einreichen. Die Hauptaktion
 * richtet sich nach dem Eingangsweg (#272): bei Telefon und „persönlich“ „Antwort festhalten“, sonst „Antworten“.
 */
function ReplyEditor({ request, approval, onDone }: { request: PressRequest; approval: boolean; onDone: () => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const snippets = useQuery({ queryKey: ['press-snippets'], queryFn: () => get<{ id: string; title: string; body: string }[]>('/press/snippets'), enabled: can('press.reply') });
  const [open, setOpen] = useState<false | 'mail' | 'record'>(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(request.contact_email);
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(`AW: ${request.topic}`);
  const [body, setBody] = useState('');
  const mayMail = can('press.reply');
  const mayRecord = can('press.manage') && ORAL_CHANNELS.includes(request.channel);
  if (!mayMail && !mayRecord) return null;
  if (open === 'record') return <RecordAnswer request={request} onCancel={() => setOpen(false)} onDone={() => (setOpen(false), onDone())} />;
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {mayRecord && (
          <Button icon="NotebookPen" variant="primary" onClick={() => setOpen('record')}>
            Antwort festhalten
          </Button>
        )}
        {mayMail && (
          <Button icon="Reply" variant={mayRecord ? 'secondary' : 'primary'} onClick={() => setOpen('mail')}>
            {mayRecord ? 'Per E-Mail antworten' : 'Antworten'}
          </Button>
        )}
        {mayMail && !request.contact_email && !mayRecord && <span className="ml-1 text-meta text-fg-muted">Keine E-Mail-Adresse hinterlegt – bitte Empfänger eintragen.</span>}
      </div>
    );
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const send = async () => {
    setBusy(true);
    try {
      const r = await post<{ status: string }>(`/press/requests/${request.id}/replies`, { to: list(to), cc: list(cc), subject, body });
      toast({ tone: 'success', title: r.status === 'pending' ? 'Zur Freigabe eingereicht' : 'Antwort wird gesendet' });
      setOpen(false);
      setBody('');
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <FieldWrap label="An" required htmlFor="rp-to">
          <Input id="rp-to" type="text" inputMode="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Kopie an" htmlFor="rp-cc" help="Mehrere Adressen mit Komma trennen.">
          <Input id="rp-cc" type="text" inputMode="email" value={cc} onChange={(e) => setCc(e.target.value)} />
        </FieldWrap>
      </div>
      <FieldWrap label="Betreff" required htmlFor="rp-subject" help={`Die Vorgangsnummer [${request.case_no}] wird angehängt – so landen Rückfragen bei dieser Anfrage.`}>
        <Input id="rp-subject" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
      </FieldWrap>
      {!!snippets.data?.length && (
        <FieldWrap label="Textbaustein einfügen" htmlFor="rp-snippet">
          <Select
            id="rp-snippet"
            value=""
            onChange={(e) => {
              const s = snippets.data!.find((x) => x.id === e.target.value);
              if (s) setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n` : '') + renderSnippet(s.body, request, me?.user.name ?? ''));
            }}
          >
            <option value="">– Baustein wählen –</option>
            {snippets.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </FieldWrap>
      )}
      <FieldWrap label="Text" required htmlFor="rp-body">
        <Textarea id="rp-body" rows={10} value={body} maxLength={50000} onChange={(e) => setBody(e.target.value)} />
      </FieldWrap>
      {approval && <Notice>Antworten werden vor dem Versand von einer zweiten Person freigegeben (Einstellungen → Redaktion).</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon="Send" loading={busy} disabled={!list(to).length || subject.trim().length < 2 || !body.trim()} onClick={send}>
          {approval ? 'Zur Freigabe einreichen' : 'Senden'}
        </Button>
        <Button onClick={() => setOpen(false)}>Abbrechen</Button>
      </div>
    </div>
  );
}

/** Mail-Verlauf einer Anfrage (#205) mit Antworten (#206) bzw. „Antwort festhalten“ bei mündlichen Anfragen (#272). */
export function PressMessages({ request, detail, onChange }: { request: PressRequest; detail: PressDetailExtras; onChange: () => void }) {
  const { can } = useAuth();
  const msgs = detail.messages ?? [];
  const mayRecord = can('press.manage') && ORAL_CHANNELS.includes(request.channel);
  if (!msgs.length && !can('press.reply') && !mayRecord) return null;
  return (
    <Card title="Mails und Antworten" action={msgs.length ? <Badge tone="neutral" dot={false}>{msgs.length}</Badge> : undefined}>
      <div className="flex flex-col gap-4">
        {msgs.length > 0 ? (
          <ol className="m-0 p-0 list-none flex flex-col gap-3">
            {msgs.map((m) => (
              <MessageItem key={m.id} m={m} onChange={onChange} />
            ))}
          </ol>
        ) : (
          <p className="m-0 text-sm text-fg-muted">{mayRecord ? 'Noch keine Mails zu dieser Anfrage. Mündliche Antworten stehen im Verlauf.' : 'Noch keine Mails zu dieser Anfrage.'}</p>
        )}
        <ReplyEditor request={request} approval={!!detail.replyApproval} onDone={onChange} />
      </div>
    </Card>
  );
}
