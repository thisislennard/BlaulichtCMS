import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, FieldWrap, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';

interface Approval {
  id: string;
  kind: 'approval' | 'mail';
  title: string;
  summary: string;
  created_at: string;
  expires_at: string;
  run_id: string;
  automation_id: string;
  automation_name: string;
  can_decide: boolean;
}

/** Offene Freigaben aus Workflows („Freigabe anfordern“, E-Mail an externe Empfänger) – auf der Seite Freigaben. */
export function AutomationApprovals({ compact }: { compact?: boolean }) {
  const { canAny, can } = useAuth();
  const q = useQuery({ queryKey: ['automation-approvals'], queryFn: () => get<Approval[]>('/automation-approvals'), enabled: canAny('approval.automation', 'automation.manage'), refetchInterval: 20_000 });
  const [open, setOpen] = useState<Approval | null>(null);
  if (!q.data?.length) return null;
  return (
    <Card title={`Freigaben aus Workflows (${q.data.length})`} subtitle="Ein Lauf wartet auf eine Entscheidung. Ohne Entscheidung gilt die Anfrage nach Ablauf der Frist als abgelehnt.">
      <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
        {q.data.slice(0, compact ? 3 : 50).map((a) => (
          <li key={a.id} className="py-2.5 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[220px]">
              <div className="flex items-center gap-2 flex-wrap">
                <strong className="text-sm">{a.title}</strong>
                <Badge tone="warning">{a.kind === 'mail' ? 'E-Mail-Versand' : 'Freigabe'}</Badge>
              </div>
              <div className="text-meta text-fg-muted">
                {can('automation.read') ? <Link to={`/workflows/${a.automation_id}`}>{a.automation_name}</Link> : a.automation_name} · {fmtRelative(a.created_at)} · Frist bis {fmtDateTime(a.expires_at)}
              </div>
            </div>
            <Button size="sm" variant={a.can_decide ? 'primary' : 'secondary'} icon="ShieldCheck" onClick={() => setOpen(a)}>
              {a.can_decide ? 'Prüfen' : 'Ansehen'}
            </Button>
          </li>
        ))}
      </ul>
      {compact && q.data.length > 3 && (
        <Link to="/freigaben" className="text-sm !text-fg-muted hover:!text-fg">
          Alle {q.data.length} Freigaben →
        </Link>
      )}
      {open && <DecisionDialog a={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function DecisionDialog({ a, onClose }: { a: Approval; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    try {
      await post(`/automation-approvals/${a.id}/decision`, { decision, note });
      toast({ tone: 'success', title: decision === 'approved' ? 'Freigegeben – der Lauf geht weiter' : 'Abgelehnt' });
      qc.invalidateQueries({ queryKey: ['automation-approvals'] });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={600}
      title={a.title}
      footer={
        a.can_decide ? (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="danger" loading={busy === 'rejected'} disabled={!note.trim()} onClick={() => decide('rejected')}>
              Ablehnen
            </Button>
            <Button variant="primary" loading={busy === 'approved'} onClick={() => decide('approved')}>
              Freigeben
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-meta text-fg-muted">
          Aus dem Workflow „{a.automation_name}“ · angefordert {fmtDateTime(a.created_at)} · Lauf <span className="font-mono">{a.run_id.slice(0, 8)}</span>
        </p>
        {a.summary ? <pre className="m-0 whitespace-pre-wrap font-sans text-sm bg-raised rounded-node p-3 max-h-[320px] overflow-auto">{a.summary}</pre> : <p className="m-0 text-sm text-fg-muted">Keine weiteren Angaben.</p>}
        {!a.can_decide && <p className="m-0 text-sm text-fg-muted">Entscheiden kann eine Person mit dem Recht „Freigaben in Workflows erteilen“, die den Workflow nicht zuletzt geändert oder aktiviert hat (Vier-Augen-Prinzip, falls eingeschaltet).</p>}
        {a.can_decide && (
          <FieldWrap label="Notiz" htmlFor="ap-note" help="Beim Ablehnen Pflicht.">
            <Textarea id="ap-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </FieldWrap>
        )}
      </div>
    </Dialog>
  );
}
