import { Link } from 'react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Badge, Button, Card, FieldWrap, Input, Notice, Select, SkeletonRows, Table, Td, Th, type Tone, EmptyLine } from '../../components/ui/core';
import { JsonView } from '../../components/ui/data';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { fmtDateTime, fmtDuration } from '../../lib/format';
import { RunBadge, STEP_STATUS, TRIGGER_LABEL, type FieldDef } from './shared';

export interface RunDetail {
  id: string;
  automation_id: string;
  automation_name: string;
  version: number | null;
  mode: 'live' | 'test';
  trigger: string;
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  resume_at: string | null;
  created_by_name: string | null;
  payload: Record<string, unknown>;
  steps: { node_id: string; node_type: string; label: string; status: string; ports: string[]; port_labels: string[]; input: any; output: any; info: string | null; error: string | null; attempts: number; started_at: string; finished_at: string | null; duration_ms: number | null }[];
}

interface RunRow {
  id: string;
  version: number | null;
  mode: string;
  trigger: string;
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  resume_at: string | null;
  created_by_name: string | null;
  steps: number;
}

function StepBadge({ status }: { status: string }) {
  const s = STEP_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Schrittprotokoll eines Laufs (Eingangsdaten gekürzt, E-Mail-Adressen maskiert). */
export function RunView({ run }: { run: RunDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <RunBadge status={run.status} />
        {run.mode === 'test' && <Badge tone="neutral">Testlauf – nichts angelegt, nichts gesendet</Badge>}
        <span className="text-fg-muted">
          {TRIGGER_LABEL[run.trigger] ?? run.trigger} · {fmtDateTime(run.created_at)}
          {run.version ? ` · Version ${run.version}` : ''}
          {run.created_by_name ? ` · ${run.created_by_name}` : ''}
        </span>
        <span className="font-mono text-meta text-fg-muted ml-auto">{run.id.slice(0, 8)}</span>
      </div>
      {run.error && <Notice tone="error">{run.error}</Notice>}
      {run.status === 'waiting' && run.resume_at && <Notice tone="warning">Hält an bis spätestens {fmtDateTime(run.resume_at)} (Warten oder offene Freigabe).</Notice>}
      <ol className="m-0 p-0 list-none flex flex-col gap-2">
        {run.steps.map((s, i) => (
          <li key={s.node_id} className="rounded-node border border-line p-3 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-meta text-fg-muted w-5">{i + 1}</span>
              <strong className="text-sm">{s.label}</strong>
              <StepBadge status={s.status} />
              {s.port_labels.length > 0 && <span className="text-meta text-fg-muted">→ {s.port_labels.join(', ')}</span>}
              <span className="ml-auto font-mono text-meta text-fg-muted">{s.duration_ms != null ? fmtDuration(s.duration_ms) : ''}{s.attempts > 1 ? ` · ${s.attempts} Versuche` : ''}</span>
            </div>
            {s.info && <p className="m-0 text-sm text-fg-muted">{s.info}</p>}
            {s.error && <p className="m-0 text-sm text-err">{s.error}</p>}
            {run.mode === 'test' && s.output?.log?.vorschau && (
              <img src={`/api/v1/automation-runs/${run.id}/image-preview/${encodeURIComponent(s.node_id)}`} alt={`Vorschau des Bildes: ${s.output.log.alternativtext ?? s.label}`} className="max-h-72 w-auto self-start rounded-node border border-line" />
            )}
            {run.mode !== 'test' && s.output?.produced?.bild_link && (
              <Link to={s.output.produced.bild_link} className="text-sm self-start">
                Bild in den Medien öffnen
              </Link>
            )}
            {(s.input || s.output?.log || Object.keys(s.output?.produced ?? {}).length > 0) && (
              <details>
                <summary className="cursor-pointer text-meta text-fg-muted">Daten</summary>
                <div className="grid md:grid-cols-2 gap-2 pt-2">
                  {s.input && (
                    <div>
                      <div className="text-meta text-fg-muted mb-1">Eingabe des Schritts</div>
                      <JsonView value={s.input} />
                    </div>
                  )}
                  {(s.output?.log || Object.keys(s.output?.produced ?? {}).length > 0) && (
                    <div>
                      <div className="text-meta text-fg-muted mb-1">Ergebnis</div>
                      <JsonView value={{ ...(s.output?.produced ?? {}), ...(s.output?.log ? { protokoll: s.output.log } : {}) }} />
                    </div>
                  )}
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
      {run.steps.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Schritte.</p>}
    </div>
  );
}

export function RunDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['automation-run', runId], queryFn: () => get<RunDetail>(`/automation-runs/${runId}`), refetchInterval: (query) => (['queued', 'running', 'waiting'].includes(query.state.data?.status ?? '') ? 3000 : false) });
  return (
    <Dialog open onClose={onClose} width={820} title={q.data ? `Lauf von „${q.data.automation_name}“` : 'Lauf'} footer={<Button onClick={onClose}>Schließen</Button>}>
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.data && <RunView run={q.data} />}
    </Dialog>
  );
}

export function RunsCard({ automationId, onOpen }: { automationId: string; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['automation-runs', automationId], queryFn: () => get<RunRow[]>(`/automations/${automationId}/runs`), refetchInterval: 15_000 });
  return (
    <Card title="Läufe" subtitle="Live- und Testläufe der letzten Zeit. Protokolle werden nach der eingestellten Frist gelöscht." bodyClassName="p-0">
      {q.isLoading && <SkeletonRows rows={3} className="p-4" />}
      {q.data && q.data.length === 0 && <EmptyLine className="px-5 pb-5">Noch keine Läufe. Ein Testlauf zeigt Schritt für Schritt, was passieren würde.</EmptyLine>}
      {q.data && q.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Zeit</Th>
              <Th>Auslöser</Th>
              <Th>Status</Th>
              <Th align="right">Dauer</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id} className="hover:bg-raised">
                <Td mono>{fmtDateTime(r.created_at)}</Td>
                <Td className="text-sm">
                  {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                  {r.version ? <span className="font-mono text-meta text-fg-muted"> · V{r.version}</span> : null}
                </Td>
                <Td>
                  <RunBadge status={r.status} />
                  {r.error && <div className="text-meta text-err line-clamp-1 max-w-[340px]" title={r.error}>{r.error}</div>}
                </Td>
                <Td align="right" mono>
                  {r.finished_at && r.started_at ? fmtDuration(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) : '–'}
                </Td>
                <Td align="right">
                  <Button size="sm" onClick={() => onOpen(r.id)} aria-label={`Lauf vom ${fmtDateTime(r.created_at)} öffnen`}>
                    Protokoll
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Testlauf mit Beispieldaten (Felder vorausgefüllt, änderbar). Legt nichts an und sendet nichts. */
export function TestDialog({ automationId, inputs, onClose, onDone }: { automationId: string; inputs: { nodeId: string; name: string; fields: FieldDef[] }[]; onClose: () => void; onDone: (run: RunDetail) => void }) {
  const toastError = useErrorToast();
  const [nodeId, setNodeId] = useState(inputs[0]?.nodeId ?? '');
  const sel = inputs.find((i) => i.nodeId === nodeId);
  const editable = (sel?.fields ?? []).filter((f) => !['automation', 'lauf', 'jetzt', 'gestartet_von'].includes(f.key));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunDetail | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const payload = Object.fromEntries(editable.map((f) => [f.key, values[`${nodeId}:${f.key}`] ?? f.example]));
      const r = await post<RunDetail>(`/automations/${automationId}/test`, { inputNodeId: nodeId, payload });
      setResult(r);
      onDone(r);
    } catch (e) {
      toastError(e, 'Testlauf nicht möglich');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={820}
      title="Testlauf"
      footer={
        <>
          <Button onClick={onClose}>Schließen</Button>
          <Button variant="primary" icon="FlaskConical" loading={busy} disabled={!sel} onClick={run}>
            {result ? 'Erneut testen' : 'Testlauf starten'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Notice icon="FlaskConical">Der Testlauf führt den gespeicherten Entwurf mit diesen Beispieldaten aus. Aktionen beschreiben nur, was sie tun würden – es wird nichts angelegt, veröffentlicht oder gesendet. Ein erfolgreicher Test ist Voraussetzung für das Aktivieren.</Notice>
        {inputs.length > 1 && (
          <FieldWrap label="Auslöser" htmlFor="t-in">
            <Select id="t-in" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              {inputs.map((i) => (
                <option key={i.nodeId} value={i.nodeId}>
                  {i.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
        )}
        {!result && (
          <div className="grid sm:grid-cols-2 gap-3">
            {editable.map((f) => (
              <FieldWrap key={f.key} label={f.label} htmlFor={`t-${f.key}`} help={f.options ? `z. B. ${f.options.join(', ')}` : undefined}>
                <Input id={`t-${f.key}`} value={values[`${nodeId}:${f.key}`] ?? f.example} onChange={(e) => setValues({ ...values, [`${nodeId}:${f.key}`]: e.target.value })} />
              </FieldWrap>
            ))}
          </div>
        )}
        {result && <RunView run={result} />}
      </div>
    </Dialog>
  );
}

/** Manueller Start einer aktiven Automation (Auslöser „Manueller Start“). */
export function StartDialog({ automationId, inputs, onClose, onStarted }: { automationId: string; inputs: { nodeId: string; name: string; fields: { key: string; label: string; example: string }[] }[]; onClose: () => void; onStarted: (runId: string) => void }) {
  const toastError = useErrorToast();
  const [nodeId, setNodeId] = useState(inputs[0]?.nodeId ?? '');
  const sel = inputs.find((i) => i.nodeId === nodeId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await post<{ runId: string }>(`/automations/${automationId}/run`, { inputNodeId: nodeId, payload: values });
      onStarted(r.runId);
    } catch (e) {
      toastError(e, 'Nicht gestartet');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Workflow jetzt starten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon="Play" loading={busy} disabled={!sel} onClick={start}>
            Starten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">Startet die aktive Version – mit echten Aktionen (Entwürfe, Benachrichtigungen, E-Mails nach den Regeln der Aktionen).</p>
        {inputs.length > 1 && (
          <FieldWrap label="Auslöser" htmlFor="s-in">
            <Select id="s-in" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              {inputs.map((i) => (
                <option key={i.nodeId} value={i.nodeId}>
                  {i.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
        )}
        {(sel?.fields ?? []).map((f) => (
          <FieldWrap key={f.key} label={f.label} htmlFor={`s-${f.key}`}>
            <Input id={`s-${f.key}`} value={values[f.key] ?? ''} placeholder={f.example} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </FieldWrap>
        ))}
      </div>
    </Dialog>
  );
}
