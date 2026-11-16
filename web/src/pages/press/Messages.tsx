import { useState } from 'react';
import { Badge, Button, Card, cx, Notice } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
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
  attachments: { id: string; filename: string; content_type: string; size: number }[];
}

/** Zusatzdaten der Detailansicht (Mails – #205/#206). */
export interface PressDetailExtras {
  messages?: PressMessage[];
}

/**
 * HTML einer Mail: serverseitig entschärft und zusätzlich in einem abgeschotteten iframe ohne Skripte, ohne Zugriff auf
 * BlaulichtCMS und ohne Nachladen aus dem Internet (eigene Inhaltsrichtlinie).
 */
function HtmlView({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"></head><body style="font:14px/1.5 system-ui,sans-serif;margin:12px;color:#1b1f24;background:#fff;overflow-wrap:anywhere">${html}</body></html>`;
  return <iframe title="HTML-Ansicht der Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full h-[320px] rounded-control border border-line bg-white" />;
}

function MessageItem({ m }: { m: PressMessage }) {
  const [html, setHtml] = useState(false);
  const [open, setOpen] = useState(true);
  const incoming = m.direction === 'in';
  return (
    <li className={cx('rounded-node border border-line p-3 flex flex-col gap-2', incoming ? 'bg-card' : 'bg-raised')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Icon name={incoming ? 'Mail' : 'Send'} size={15} className="text-fg-muted" />
        <span className="font-medium">{incoming ? m.from_name || m.from_address : `An ${m.to_addresses.join(', ')}`}</span>
        {incoming && m.from_name && <span className="text-fg-muted">&lt;{m.from_address}&gt;</span>}
        <span className="text-meta text-fg-muted ml-auto">{fmtDateTime(m.received_at ?? m.created_at)}</span>
      </div>
      <button type="button" className="text-left font-medium hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.subject || '(ohne Betreff)'}
      </button>
      {open && (
        <>
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
          {m.skipped_attachments.length > 0 && (
            <Notice tone="warning">
              Nicht übernommen: {m.skipped_attachments.map((s) => `${s.filename} (${s.reason})`).join(', ')}
            </Notice>
          )}
        </>
      )}
    </li>
  );
}

/** Mail-Verlauf einer Anfrage (#205); Antworten (#206) erscheinen im selben Verlauf. */
export function PressMessages({ request, detail, onChange, extra }: { request: PressRequest; detail: PressDetailExtras; onChange: () => void; extra?: React.ReactNode }) {
  const msgs = detail.messages ?? [];
  if (!msgs.length && !extra) return null;
  void request;
  void onChange;
  return (
    <Card title="Mails" action={msgs.length ? <Badge tone="neutral" dot={false}>{msgs.length}</Badge> : undefined}>
      <div className="flex flex-col gap-3">
        {msgs.length > 0 && (
          <ol className="m-0 p-0 list-none flex flex-col gap-3">
            {msgs.map((m) => (
              <MessageItem key={m.id} m={m} />
            ))}
          </ol>
        )}
        {extra}
      </div>
    </Card>
  );
}
