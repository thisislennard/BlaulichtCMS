import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, Input, LinkButton, Notice, PageHeader, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { AutomationBadge, DirectBadge, RunBadge, useCatalog } from './shared';
import { AutomationApprovals } from './Approvals';

export interface AutomationListItem {
  id: string;
  name: string;
  description: string;
  status: string;
  active_version: number | null;
  active: { version: number; current: boolean; direct_publish: boolean } | null;
  tested: boolean;
  direct_publish: boolean;
  direct_nodes: number;
  inputs: string[];
  last_run: { status: string; at: string } | null;
  runs_24h: number;
  failed_24h: number;
  pending_approvals: number;
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>('/automations', { name, description });
      nav(`/automationen/${r.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Neue Automation"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={create}>
            Anlegen und öffnen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Name" htmlFor="a-name" required>
          <Input id="a-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Unwetter-Banner" onKeyDown={(e) => e.key === 'Enter' && name.trim().length >= 2 && create()} />
        </FieldWrap>
        <FieldWrap label="Beschreibung (optional)" htmlFor="a-desc">
          <Textarea id="a-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

export default function Automations() {
  const { can } = useAuth();
  const manage = can('automation.manage');
  const cat = useCatalog();
  const q = useQuery({ queryKey: ['automations'], queryFn: () => get<AutomationListItem[]>('/automations'), refetchInterval: 20_000 });
  const [create, setCreate] = useState(false);
  const kindLabel = (k: string) => cat.data?.inputKinds.find((x) => x.kind === k)?.label ?? k;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Automationen"
        subtitle="Abläufe aus Eingängen, Verarbeitung und Ausgängen – getestet, versioniert und jederzeit abschaltbar."
        actions={
          <>
            <LinkButton to="/automationen/eingaenge" icon="Zap">Eingänge</LinkButton>
            <LinkButton to="/automationen/ausgaenge" icon="Send">Ausgänge</LinkButton>
            {manage && (
              <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
                Neue Automation
              </Button>
            )}
          </>
        }
      />
      {cat.data && !cat.data.enabled && (
        <Notice tone="warning" title="Automationen sind global abgeschaltet">
          Ereignisse und Zeitpläne starten keine Läufe. Einschalten unter <Link to="/einstellungen#redaktion">Einstellungen → Redaktion</Link>.
        </Notice>
      )}
      {(can('approval.automation') || manage) && <AutomationApprovals compact />}
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Automationen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon="Workflow"
          title="Noch keine Automation"
          text="Zuerst Eingänge und Ausgänge einrichten, dann im Editor verbinden. Beispiele stehen in der Hilfe."
          action={<LinkButton to="/hilfe/automationen" icon="BookOpen">Hilfe: Automationen</LinkButton>}
        />
      )}
      {q.data && q.data.length > 0 && (
        <Card bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Automation</Th>
                <Th>Status</Th>
                <Th>Eingänge</Th>
                <Th>Letzter Lauf</Th>
                <Th align="right">Läufe 24 h</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id} className="hover:bg-raised">
                  <Td>
                    <Link to={`/automationen/${a.id}`} className="font-medium">
                      {a.name}
                    </Link>
                    {a.description && <div className="text-meta text-fg-muted line-clamp-1">{a.description}</div>}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <AutomationBadge status={a.status} />
                      {a.active && <span className="font-mono text-meta text-fg-muted" title={`Aktive Version ${a.active.version}`}>V{a.active.version}</span>}
                      {a.status === 'active' && a.active && !a.active.current && <Badge tone="warning">Entwurf geändert</Badge>}
                      {a.direct_publish && <DirectBadge />}
                      {a.pending_approvals > 0 && <Badge tone="warning">{a.pending_approvals} Freigabe(n) offen</Badge>}
                    </div>
                  </Td>
                  <Td className="text-sm text-fg-muted">{a.inputs.map(kindLabel).join(', ') || '–'}</Td>
                  <Td>
                    {a.last_run ? (
                      <span className="inline-flex items-center gap-2">
                        <RunBadge status={a.last_run.status} />
                        <span className="text-meta text-fg-muted">{fmtRelative(a.last_run.at)}</span>
                      </span>
                    ) : (
                      <span className="text-meta text-fg-muted">noch keiner</span>
                    )}
                  </Td>
                  <Td align="right" mono>
                    {a.runs_24h}
                    {a.failed_24h > 0 && <span className="text-err"> · {a.failed_24h} Fehler</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {create && <CreateDialog onClose={() => setCreate(false)} />}
    </div>
  );
}
