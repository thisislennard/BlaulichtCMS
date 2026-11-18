import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, LinkButton, Notice, PageHeader, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, Menu, useErrorToast, useToast, type MenuItem } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../../lib/auth';
import { fmtRelative, plural } from '../../lib/format';
import { AutomationBadge, DirectBadge, RunBadge, useCatalog, type TemplateRequirement, type WorkflowTemplate } from './shared';
import { descriptionAddsInfo } from './workflowModel';
import { activeNavId } from '../../config/navigation';
import { navTrail } from '../../config/navText';
import { AutomationApprovals } from './Approvals';
import { ExportDialog, ImportDialog } from './Transfer';
import { AiAssistDialog } from './AiAssist';
import { WorkflowTabs } from './WorkflowTabs';

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

/** Voraussetzungen einer Workflow-Vorlage mit Stand und Weg zum Einrichten (#263). */
function Requirements({ list }: { list: TemplateRequirement[] }) {
  const { can } = useAuth();
  if (!list.length) return <p className="m-0 text-meta text-fg-muted">Benötigt nichts weiter.</p>;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted">Benötigt</span>
      <ul className="m-0 p-0 list-none flex flex-col gap-1 text-meta">
        {list.map((r) => {
          const nav = activeNavId(r.fix.path);
          return (
            <li key={r.key} className="flex items-start gap-1.5">
              <Icon name={r.met ? 'CircleCheck' : 'AlertTriangle'} size={14} className={cx('mt-0.5 shrink-0', r.met ? 'text-ok' : 'text-warn')} />
              <span className="min-w-0">
                <span className="sr-only">{r.met ? 'Erfüllt: ' : 'Fehlt: '}</span>
                <span className="font-medium">{r.label}</span> <span className="text-fg-muted">· {r.detail}</span>
                {!r.met &&
                  (can(r.fix.permission) ? (
                    <>
                      {' '}
                      <Link to={r.fix.path} className="font-medium whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {r.fix.label} →
                      </Link>
                    </>
                  ) : (
                    nav && <span className="text-fg-muted"> – einrichten lassen unter {navTrail(nav)}</span>
                  ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ready = (t: WorkflowTemplate) => (t.requirements ?? []).every((r) => r.met);

function CreateDialog({ onClose, templates }: { onClose: () => void; templates: WorkflowTemplate[] }) {
  const nav = useNavigate();
  const toast = useToast();
  const toastError = useErrorToast();
  // Nichts vorausgewählt (#263): erst eine Vorlage oder „Leer beginnen“ wählen
  const [tpl, setTpl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const choose = (id: string) => {
    const t = templates.find((x) => x.id === id);
    // Name und Beschreibung aus der Vorlage vorschlagen, solange noch nichts Eigenes eingetragen ist
    if (!name.trim() || templates.some((x) => x.title === name)) setName(t?.title ?? '');
    if (!description.trim() || templates.some((x) => x.description === description)) setDescription(t?.description ?? '');
    setTpl(id);
  };
  const create = async () => {
    if (tpl === null) return;
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
  // Passende Vorlagen (alle Voraussetzungen erfüllt) zuerst, dann die übrigen, „Leer beginnen“ zuletzt
  const groups = [
    { id: 'ready', label: 'Sofort einsatzbereit', items: templates.filter(ready) },
    { id: 'todo', label: 'Noch etwas einzurichten', items: templates.filter((t) => !ready(t)) },
  ].filter((g) => g.items.length);
  const chosen = templates.find((t) => t.id === tpl);
  const missing = (chosen?.requirements ?? []).filter((r) => !r.met);
  const tile = (t: { id: string; title: string; description: string; icon: string }, extra?: ReactNode) => (
    <div key={t.id || 'leer'} onClick={() => choose(t.id)} className={cx('flex flex-col gap-2 p-3 rounded-node border cursor-pointer focus-within:shadow-ring', tpl === t.id ? 'border-primary bg-primary-soft shadow-selected' : 'border-line bg-card hover:bg-raised')}>
      <label className="flex gap-3 cursor-pointer">
        <input type="radio" name="wf-template" className="sr-only" value={t.id} checked={tpl === t.id} onChange={() => choose(t.id)} />
        <Icon name={t.icon} size={18} className="text-fg-muted mt-0.5 shrink-0" />
        <span className="flex flex-col gap-0.5 min-w-0">
          <strong className="text-sm">{t.title}</strong>
          <span className="text-meta text-fg-muted">{t.description}</span>
        </span>
        {tpl === t.id && <Icon name="Check" size={16} className="ml-auto shrink-0 text-fg" />}
      </label>
      {extra}
    </div>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      width={760}
      title="Neuer Workflow"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={tpl === null || name.trim().length < 2} onClick={create}>
            Anlegen und öffnen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
          <legend className="text-sm font-medium mb-2">Workflow-Vorlage wählen</legend>
          {groups.map((g) => (
            <div key={g.id} className="flex flex-col gap-2">
              <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{g.label}</span>
              <div className="grid sm:grid-cols-2 gap-2">{g.items.map((t) => tile(t, <Requirements list={t.requirements ?? []} />))}</div>
            </div>
          ))}
          <div className="grid sm:grid-cols-2 gap-2">{tile({ id: '', title: 'Leer beginnen', description: 'Auslöser, Bedingungen und Aktionen selbst zusammenstellen.', icon: 'Plus' })}</div>
          <p className="m-0 text-meta text-fg-muted">Workflow-Vorlagen nutzen vorhandene Auslöser und Aktionen, wenn es genau einen passenden Baustein gibt. Sonst bleibt der Platz offen und lässt sich im Workflow wählen oder neu anlegen.</p>
        </fieldset>
        {missing.length > 0 && (
          <Notice tone="warning" title="Voraussetzung fehlt">
            {missing.map((r) => r.label).join(', ')}: Der Workflow wird als Entwurf angelegt. Testen und aktivieren lässt er sich, sobald {missing.length === 1 ? 'sie eingerichtet ist' : 'alles eingerichtet ist'}.
          </Notice>
        )}
        <FieldWrap label="Name" htmlFor="a-name" required>
          <Input id="a-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Unwetter-Banner" onKeyDown={(e) => e.key === 'Enter' && tpl !== null && name.trim().length >= 2 && create()} />
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
  // Importieren und „Mit KI erstellen“ nur mit dem Recht, Workflows anzulegen (#263); Exportieren auch lesend
  const menu: MenuItem[] = [
    manage && { label: 'Importieren', icon: 'FileUp', onClick: () => setTransfer('import') },
    !!q.data?.length && { label: 'Exportieren', icon: 'Download', onClick: () => setTransfer('export') },
    manage && { label: 'Mit KI erstellen', icon: 'Sparkles', disabled: !cat.data?.ai, onClick: () => setTransfer('ai') },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Wenn etwas passiert, erledigt BlaulichtCMS den nächsten Schritt – aus Workflow-Vorlagen oder selbst gebaut, getestet, versioniert und jederzeit abschaltbar."
        actions={
          // Höchstens zwei sichtbare Knöpfe (#263): „Neuer Workflow“ und ein Menü für Import, Export und KI
          (manage || menu.some(Boolean)) && (
            <>
              {menu.some(Boolean) && <Menu items={menu} label="Weitere Aktionen für Workflows" />}
              {manage && (
                <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
                  Neuer Workflow
                </Button>
              )}
            </>
          )
        }
      />
      <WorkflowTabs />
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
          text="Mit „Neuer Workflow“ eine Workflow-Vorlage wählen oder leer beginnen. Fehlende Auslöser und Aktionen lassen sich direkt im Workflow anlegen."
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
                <Th>Auslöser</Th>
                <Th>Letzter Lauf</Th>
                <Th align="right">Läufe 24 h</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id} className="hover:bg-raised">
                  <Td>
                    <Link to={`/workflows/${a.id}`} className="font-medium" title={a.description || undefined}>
                      {a.name}
                    </Link>
                    {/* Eine Zeile Zusammenfassung; die Beschreibung nur, wenn sie etwas anderes sagt (#263) */}
                    {a.summary && <div className="text-sm line-clamp-1 max-w-[640px]" title={a.summary}>{a.summary}</div>}
                    {descriptionAddsInfo(a.summary, a.description) && <div className="text-meta text-fg-muted line-clamp-1 max-w-[640px]" title={a.description}>{a.description}</div>}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <AutomationBadge status={a.status} />
                      {a.active && <span className="font-mono text-meta text-fg-muted" title={`Aktive Version ${a.active.version}`}>V{a.active.version}</span>}
                      {a.status === 'active' && a.active && !a.active.current && <Badge tone="warning">Entwurf geändert</Badge>}
                      {a.direct_publish && <DirectBadge />}
                      {a.pending_approvals > 0 && <Badge tone="warning">{plural(a.pending_approvals, 'Freigabe', 'Freigaben')} offen</Badge>}
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
      {transfer === 'ai' && manage && cat.data?.ai && <AiAssistDialog ai={cat.data.ai} canImport={manage} onImport={() => setTransfer('import')} onClose={() => setTransfer(null)} />}
    </div>
  );
}
