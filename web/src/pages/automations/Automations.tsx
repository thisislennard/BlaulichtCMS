import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, LinkButton, Notice, PageHeader, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { AutomationBadge, DirectBadge, RunBadge, useCatalog, type WorkflowTemplate } from './shared';
import { AutomationApprovals } from './Approvals';
import { ExportDialog, ImportDialog } from './Transfer';
import { AiAssistDialog } from './AiAssist';

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
  summary?: string;
}

function CreateDialog({ onClose, templates }: { onClose: () => void; templates: WorkflowTemplate[] }) {
  const nav = useNavigate();
  const toast = useToast();
  const toastError = useErrorToast();
  const [tpl, setTpl] = useState<string>('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const choose = (id: string) => {
    const t = templates.find((x) => x.id === id);
    // Name aus der Vorlage vorschlagen, solange noch nichts Eigenes eingetragen ist
    if (!name.trim() || templates.some((x) => x.title === name)) setName(t?.title ?? '');
    if (!description.trim() || templates.some((x) => x.description === description)) setDescription(t?.description ?? '');
    setTpl(id);
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: string; open: number }>('/automations', { name, description, ...(tpl ? { template: tpl } : {}) });
      if (r.open) toast({ tone: 'info', title: r.open === 1 ? '1 Platz noch offen' : `${r.open} Plätze noch offen`, text: 'Gelb markierte Auslöser und Aktionen wählen oder direkt neu anlegen.' });
      nav(`/workflows/${r.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  const tiles = [{ id: '', title: 'Leer beginnen', description: 'Auslöser, Bedingungen und Aktionen selbst zusammenstellen.', icon: 'Plus' }, ...templates];
  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title="Neuer Workflow"
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
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="text-sm font-medium mb-2">Vorlage</legend>
          <div className="grid sm:grid-cols-2 gap-2">
            {tiles.map((t) => (
              <label key={t.id || 'leer'} className={cx('flex gap-3 p-3 rounded-node border cursor-pointer focus-within:shadow-ring', tpl === t.id ? 'border-primary bg-primary-soft' : 'border-line bg-card hover:bg-raised')}>
                <input type="radio" name="wf-template" className="sr-only" value={t.id} checked={tpl === t.id} onChange={() => choose(t.id)} />
                <Icon name={t.icon} size={18} className="text-fg-muted mt-0.5 shrink-0" />
                <span className="flex flex-col gap-0.5">
                  <strong className="text-sm">{t.title}</strong>
                  <span className="text-meta text-fg-muted">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="m-0 text-meta text-fg-muted">Vorlagen nutzen vorhandene Auslöser und Aktionen, wenn es genau einen passenden gibt. Sonst bleibt der Platz offen und lässt sich im Workflow wählen oder neu anlegen.</p>
        </fieldset>
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
  const [transfer, setTransfer] = useState<null | 'export' | 'import' | 'ai'>(null);
  const kindLabel = (k: string) => cat.data?.inputKinds.find((x) => x.kind === k)?.label ?? k;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Workflows"
        subtitle="Wenn etwas passiert, erledigt BlaulichtCMS den nächsten Schritt – aus Vorlagen oder selbst gebaut, getestet, versioniert und jederzeit abschaltbar."
        actions={
          <>
            <LinkButton to="/workflows/eingaenge" icon="Zap">Eingänge</LinkButton>
            <LinkButton to="/workflows/ausgaenge" icon="Send">Ausgänge</LinkButton>
            {!!q.data?.length && (
              <Button icon="Download" onClick={() => setTransfer('export')}>
                Exportieren
              </Button>
            )}
            {manage && (
              <Button icon="FileUp" onClick={() => setTransfer('import')}>
                Importieren
              </Button>
            )}
            <Button icon="Sparkles" disabled={!cat.data?.ai} onClick={() => setTransfer('ai')}>
              Mit KI erstellen
            </Button>
            {manage && (
              <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
                Neuer Workflow
              </Button>
            )}
          </>
        }
      />
      {cat.data && !cat.data.enabled && (
        <Notice tone="warning" title="Workflows sind global abgeschaltet">
          Ereignisse und Zeitpläne starten keine Läufe. Einschalten unter <Link to="/einstellungen#redaktion">Einstellungen → Redaktion</Link>.
        </Notice>
      )}
      {(can('approval.automation') || manage) && <AutomationApprovals compact />}
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Workflows konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon="Workflow"
          title="Noch kein Workflow"
          text="Mit „Neuer Workflow“ eine Vorlage wählen oder leer beginnen. Fehlende Auslöser und Aktionen lassen sich direkt im Workflow anlegen."
          action={<LinkButton to="/hilfe/workflows" icon="BookOpen">Hilfe: Workflows</LinkButton>}
        />
      )}
      {q.data && q.data.length > 0 && (
        <Card bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Workflow</Th>
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
                    <Link to={`/workflows/${a.id}`} className="font-medium">
                      {a.name}
                    </Link>
                    {a.summary && <div className="text-sm line-clamp-2 max-w-[640px]">{a.summary}</div>}
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
      {create && <CreateDialog templates={cat.data?.templates ?? []} onClose={() => setCreate(false)} />}
      {transfer === 'export' && q.data && <ExportDialog items={q.data} onClose={() => setTransfer(null)} />}
      {transfer === 'import' && <ImportDialog onClose={() => setTransfer(null)} />}
      {transfer === 'ai' && cat.data?.ai && <AiAssistDialog ai={cat.data.ai} canImport={manage} onImport={() => setTransfer('import')} onClose={() => setTransfer(null)} />}
    </div>
  );
}
