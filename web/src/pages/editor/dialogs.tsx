import { useEffect, useRef, useState } from 'react';
import { get, post } from '../../api/client';
import type { Issue } from '../../api/types';
import { Badge, Button, Chip, cx, Notice, Skeleton, Switch, Textarea, type Tone } from '../../components/ui/core';
import { CopyButton, Dialog, OneTimeSecret, Popover, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { fmtDateTime } from '../../lib/format';
import { T } from './lib';
import { useAuth } from '../../lib/auth';
import type { WorkflowDetail } from './ConfigPanel';

export interface WebhookInfo {
  url: string;
  path: string;
  secret: string | null;
}

interface ValidateResult {
  valid: boolean;
  issues: Issue[];
  preview: {
    trigger: { name: string; type: string } | null;
    fieldsUsed: string[];
    actions: { nodeId: string; name: string; type: string; connection: string | null; targets: string[]; idempotent: boolean; retry: string }[];
    connectionsUsed: string[];
  };
  diff: { added: string[]; removed: string[]; changed: string[]; edgesChanged: boolean; identical: boolean };
  activeVersion: number | null;
  nextScheduledRun: string | null;
}

/* ------------------------------- Veröffentlichen-Dialog ------------------------------- */

export function PublishDialog({
  open,
  onClose,
  workflow,
  canPublish,
  nodeName,
  flush,
  onJump,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  workflow: WorkflowDetail;
  canPublish: boolean;
  nodeName: (id: string) => string | null;
  flush: () => Promise<boolean>;
  onJump: (nodeId: string) => void;
  onDone: (res: { needsApproval: boolean; version: { number: number }; webhook?: WebhookInfo | null }) => void;
}) {
  const [data, setData] = useState<ValidateResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; issues?: Issue[] } | null>(null);
  const needsApproval = workflow.fourEyes || !canPublish;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setData(null);
    setLoadError(null);
    setSubmitError(null);
    setNote('');
    setActivate(workflow.status === 'active' || !workflow.active_version_id || workflow.status !== 'inactive');
    (async () => {
      try {
        await flush();
        const r = await post<ValidateResult>(`/workflows/${workflow.id}/validate`);
        if (alive) setData(r);
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflow.id]);

  const submit = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await post(`/workflows/${workflow.id}/publish`, { changeNote: note, activate });
      onDone(r);
      onClose();
    } catch (e: any) {
      setSubmitError({ message: e.message, issues: Array.isArray(e.details) ? e.details : undefined });
    } finally {
      setBusy(false);
    }
  };

  const issues = submitError?.issues ?? data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const identical = !!data?.diff.identical && data.activeVersion != null;
  const disabled = !data || !data.valid || identical || errors.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={640}
      title={needsApproval ? T('publish.titleApproval') : T('publish.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {T('common.cancel')}
          </Button>
          <Button variant="primary" icon={needsApproval ? 'Send' : 'Upload'} loading={busy} disabled={disabled} onClick={submit}>
            {needsApproval ? T('publish.requestApproval') : T('publish.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {loadError && <Notice tone="error" title={T('publish.loadFailed')}>{loadError}</Notice>}
        {!data && !loadError && (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label={T('common.loading')}>
            <Skeleton className="h-16" />
            <Skeleton className="h-28" />
            <Skeleton className="h-20" />
          </div>
        )}
        {submitError && !submitError.issues && <Notice tone="error" title={T('publish.failed')}>{submitError.message}</Notice>}
        {data && (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-semibold flex items-center gap-2">
                {errors.length ? <Icon name="XCircle" size={15} className="text-err" /> : <Icon name="CheckCircle2" size={15} className="text-ok" />}
                {errors.length ? T(errors.length === 1 ? 'publish.problemsOne' : 'publish.problems', { n: errors.length }) : T('publish.noProblems')}
              </h3>
              {[...errors, ...warnings].length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-col gap-1">
                  {[...errors, ...warnings].map((i, k) => (
                    <li key={k}>
                      <button
                        type="button"
                        disabled={!i.nodeId}
                        onClick={() => i.nodeId && onJump(i.nodeId)}
                        className="w-full flex items-start gap-2 px-2.5 py-2 rounded-control border border-line text-left text-sm hover:bg-raised disabled:hover:bg-transparent disabled:cursor-default"
                      >
                        <span aria-hidden="true" className={cx('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', i.severity === 'error' ? 'bg-err' : 'bg-warn')} />
                        <span className="flex-1 min-w-0">
                          <span className="sr-only">{i.severity === 'error' ? T('publish.error') : T('publish.warning')}: </span>
                          {i.message}
                          {i.nodeId && nodeName(i.nodeId) && <span className="block text-meta text-fg-muted">{T('publish.jump', { name: nodeName(i.nodeId)! })}</span>}
                        </span>
                        {i.nodeId && <Icon name="ArrowRight" size={14} className="mt-0.5 text-fg-muted" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2.5">
              <h3 className="m-0 text-sm font-semibold">{T('publish.preview')}</h3>
              <dl className="m-0 grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
                <dt className="text-fg-muted">{T('publish.trigger')}</dt>
                <dd className="m-0">{data.preview.trigger ? `${data.preview.trigger.name} · ${data.preview.trigger.type}` : '–'}</dd>
                {data.nextScheduledRun && (
                  <>
                    <dt className="text-fg-muted">{T('publish.nextRun')}</dt>
                    <dd className="m-0">{fmtDateTime(data.nextScheduledRun)}</dd>
                  </>
                )}
                <dt className="text-fg-muted">{T('publish.fields')}</dt>
                <dd className="m-0 flex gap-1 flex-wrap">{data.preview.fieldsUsed.length ? data.preview.fieldsUsed.map((f) => <Chip key={f} mono>{f}</Chip>) : '–'}</dd>
                <dt className="text-fg-muted">{T('publish.connections')}</dt>
                <dd className="m-0">{data.preview.connectionsUsed.join(', ') || '–'}</dd>
              </dl>
              {data.preview.actions.length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-col gap-2">
                  {data.preview.actions.map((a) => (
                    <li key={a.nodeId} className="p-3 rounded-node border border-line flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <strong className="text-sm font-semibold">{a.name}</strong>
                        <span className="text-meta text-fg-muted">
                          {a.type}
                          {a.connection ? ` · ${a.connection}` : ''}
                        </span>
                        <Badge tone={a.idempotent ? 'success' : 'warning'} className="ml-auto">
                          {a.idempotent ? T('publish.idempotent') : T('publish.notIdempotent')}
                        </Badge>
                      </div>
                      {a.targets.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap text-meta">
                          <span className="text-fg-muted">{T('publish.targets')}:</span>
                          {a.targets.map((t) => (
                            <Chip key={t} mono>
                              {t}
                            </Chip>
                          ))}
                        </div>
                      )}
                      <span className="text-meta text-fg-muted">{a.retry}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-semibold">{data.activeVersion != null ? T('publish.diffTitle', { n: data.activeVersion }) : T('publish.diffFirst')}</h3>
              {data.activeVersion == null ? (
                <p className="m-0 text-sm text-fg-muted">{T('publish.firstVersion')}</p>
              ) : identical ? (
                <Notice tone="primary">{T('publish.identical')}</Notice>
              ) : (
                <DiffList diff={data.diff} />
              )}
            </section>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{T('publish.note')}</span>
              <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={T('publish.notePlaceholder')} />
            </label>
            {!needsApproval && <Switch checked={activate} onChange={setActivate} label={T('publish.activate')} description={T('publish.activateHelp')} />}
            {needsApproval && <Notice tone="primary" icon="ShieldCheck">{workflow.fourEyes ? T('publish.fourEyes') : T('publish.noRight')}</Notice>}
          </>
        )}
      </div>
    </Dialog>
  );
}

export function DiffList({ diff }: { diff: ValidateResult['diff'] }) {
  const rows: [string, string[], string][] = [
    [T('diff.added'), diff.added, 'text-ok'],
    [T('diff.changed'), diff.changed, 'text-warn'],
    [T('diff.removed'), diff.removed, 'text-err'],
  ];
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
      {rows
        .filter(([, l]) => l.length)
        .map(([label, l, tone]) => (
          <li key={label}>
            <span className={cx('font-medium', tone)}>{label}:</span> {l.join(', ')}
          </li>
        ))}
      {diff.edgesChanged && <li className="text-fg-muted">{T('diff.edges')}</li>}
      {diff.identical && <li className="text-fg-muted">{T('diff.none')}</li>}
    </ul>
  );
}

/* ------------------------------------ Versionen ---------------------------------------- */

const VERSION_STATE: Record<string, { tone: Tone; label: string }> = {
  published: { tone: 'success', label: 'versions.published' },
  superseded: { tone: 'neutral', label: 'versions.superseded' },
  pending_approval: { tone: 'warning', label: 'versions.pending' },
  rejected: { tone: 'error', label: 'versions.rejected' },
};

export function VersionsButton({
  workflow,
  canApprove,
  canPublish,
  myName,
  onChanged,
}: {
  workflow: WorkflowDetail;
  canApprove: boolean;
  canPublish: boolean;
  myName: string;
  onChanged: (res?: { webhook?: WebhookInfo | null; rolledBack?: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pending = workflow.versions.filter((v) => v.state === 'pending_approval').length;
  return (
    <>
      <Button ref={btn} size="sm" icon="History" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {T('toolbar.versions')}
        {pending > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-warn-soft text-warn text-[11px] font-semibold tabular" aria-label={T('versions.pendingCount', { n: pending })}>
            {pending}
          </span>
        )}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={400}>
        <div role="dialog" aria-label={T('versions.title')} className="flex flex-col max-h-[70vh]">
          <div className="px-4 pt-3 pb-2 border-b border-line">
            <h2 className="m-0 text-sm font-semibold">{T('versions.title')}</h2>
          </div>
          <div className="overflow-y-auto p-2 flex flex-col gap-1">
            {!workflow.versions.length && <p className="m-0 px-2 py-4 text-sm text-fg-muted text-center">{T('versions.empty')}</p>}
            {workflow.versions.map((v) => {
              const st = VERSION_STATE[v.state] ?? { tone: 'neutral' as Tone, label: v.state };
              return (
                <div key={v.id} className="flex flex-col gap-1 px-2.5 py-2 rounded-control hover:bg-raised">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">v{v.number}</span>
                    {v.active ? <Badge tone="primary">{T('versions.active')}</Badge> : <Badge tone={st.tone}>{T(st.label)}</Badge>}
                    <span className="ml-auto text-meta text-fg-muted">{fmtDateTime(v.approved_at ?? v.requested_at)}</span>
                  </div>
                  {v.change_note && <p className="m-0 text-meta whitespace-pre-line">{v.change_note}</p>}
                  <span className="text-meta text-fg-muted">
                    {v.requested_by_name ?? '–'}
                    {v.approved_by_name && v.state !== 'pending_approval' ? ` · ${T('versions.approvedBy', { name: v.approved_by_name })}` : ''}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="Eye"
                      onClick={() => {
                        setOpen(false);
                        setView(v.id);
                      }}
                    >
                      {v.state === 'pending_approval' && canApprove ? T('versions.review') : T('versions.view')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Popover>
      <VersionDialog workflow={workflow} versionId={view} onClose={() => setView(null)} canApprove={canApprove} canPublish={canPublish} myName={myName} onChanged={onChanged} />
    </>
  );
}

function VersionDialog({ workflow, versionId, onClose, canApprove, canPublish, myName, onChanged }: { workflow: WorkflowDetail; versionId: string | null; onClose: () => void; canApprove: boolean; canPublish: boolean; myName: string; onChanged: (res?: { webhook?: WebhookInfo | null; rolledBack?: boolean }) => void }) {
  const { me } = useAuth();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const errorToast = useErrorToast();
  const meta = workflow.versions.find((v) => v.id === versionId);
  useEffect(() => {
    if (!versionId) return;
    setData(null);
    setErr(null);
    setComment('');
    get(`/workflows/${workflow.id}/versions/${versionId}`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [versionId, workflow.id]);
  if (!versionId || !meta) return null;
  // Eigene Änderung (Vier-Augen): über die Benutzer-ID, Name nur als Rückfall
  const own = meta.requested_by ? meta.requested_by === me?.user.id : !!meta.requested_by_name && meta.requested_by_name === myName;
  const pending = meta.state === 'pending_approval';
  const canRollback = canPublish && !meta.active && ['published', 'superseded'].includes(meta.state);

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      const r = await post(`/workflows/${workflow.id}/versions/${versionId}/decision`, { approve, comment, activate: true });
      toast({ tone: approve ? 'success' : 'info', title: approve ? T('versions.approvedToast', { n: meta.number }) : T('versions.rejectedToast', { n: meta.number }) });
      onChanged({ webhook: r?.webhook });
      onClose();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };
  const rollback = async () => {
    setBusy('rollback');
    try {
      const r = await post(`/workflows/${workflow.id}/rollback`, { versionId });
      toast({ tone: 'success', title: T('versions.rolledBack', { n: meta.number }), text: T('versions.rolledBackText') });
      onChanged({ webhook: r?.webhook, rolledBack: true });
      onClose();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={T('versions.dialogTitle', { n: meta.number })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {T('common.close')}
          </Button>
          {pending && canApprove && !own && (
            <>
              <Button variant="danger" loading={busy === 'reject'} onClick={() => decide(false)}>
                {T('versions.reject')}
              </Button>
              <Button variant="primary" icon="Check" loading={busy === 'approve'} onClick={() => decide(true)}>
                {T('versions.approve')}
              </Button>
            </>
          )}
          {canRollback && (
            <Button variant="primary" icon="RotateCcw" loading={busy === 'rollback'} onClick={rollback}>
              {T('versions.rollback')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          {meta.active ? <Badge tone="primary">{T('versions.active')}</Badge> : <Badge tone={(VERSION_STATE[meta.state] ?? { tone: 'neutral' }).tone}>{T((VERSION_STATE[meta.state] ?? { label: meta.state }).label)}</Badge>}
          <span className="text-fg-muted">
            {meta.requested_by_name ?? '–'} · {fmtDateTime(meta.requested_at)}
          </span>
        </div>
        {meta.change_note && <p className="m-0 whitespace-pre-line">{meta.change_note}</p>}
        {err && <Notice tone="error">{err}</Notice>}
        {!data && !err && <Skeleton className="h-24" />}
        {data && (
          <>
            {data.diffToActive && (
              <section className="flex flex-col gap-1.5">
                <h3 className="m-0 text-sm font-semibold">{T('versions.diffActive')}</h3>
                <DiffList diff={data.diffToActive} />
              </section>
            )}
            <section className="flex flex-col gap-1.5">
              <h3 className="m-0 text-sm font-semibold">{T('versions.diffDraft')}</h3>
              <DiffList diff={data.diffToDraft} />
            </section>
            <section className="flex flex-col gap-1.5">
              <h3 className="m-0 text-sm font-semibold">{T('versions.nodes', { n: data.graph?.nodes?.length ?? 0 })}</h3>
              <div className="flex gap-1 flex-wrap">
                {(data.graph?.nodes ?? []).map((n: any) => (
                  <Chip key={n.id}>{n.name}</Chip>
                ))}
              </div>
            </section>
          </>
        )}
        {pending && canApprove && !own && (
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">{T('versions.comment')}</span>
            <Textarea rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        )}
        {pending && own && <Notice tone="primary" icon="ShieldCheck">{T('versions.ownChange')}</Notice>}
        {pending && !canApprove && <Notice tone="primary">{T('versions.noApproveRight')}</Notice>}
        {canRollback && <p className="m-0 text-meta text-fg-muted">{T('versions.rollbackHint')}</p>}
      </div>
    </Dialog>
  );
}

/* ---------------------------- Echte Aktionen bestätigen ------------------------------ */

export function RealTestDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={T('test.realTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {T('common.cancel')}
          </Button>
          <Button
            variant="danger"
            icon="Play"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {T('test.realConfirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <Notice tone="warning" title={T('test.realWarnTitle')}>
          {T('test.realWarn')}
        </Notice>
        <p className="m-0 text-fg-muted">{T('test.realHint')}</p>
      </div>
    </Dialog>
  );
}

/* ------------------------- Neues Webhook-Geheimnis (einmalig) ------------------------- */

export function WebhookSecretDialog({ info, onClose }: { info: WebhookInfo | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!info?.secret}
      onClose={onClose}
      title={T('webhook.newTitle')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {T('webhook.newDone')}
        </Button>
      }
    >
      {info?.secret && (
        <div className="flex flex-col gap-4 text-sm">
          <p className="m-0 text-fg-muted">{T('webhook.newText')}</p>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">{T('webhook.address')}</span>
            <div className="flex gap-2">
              <input readOnly value={info.url} aria-label={T('webhook.address')} className="flex-1 min-w-0 h-field px-3 rounded-control border border-line bg-bg font-mono text-[13px]" onFocus={(e) => e.target.select()} />
              <CopyButton value={info.url} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">{T('webhook.secret')}</span>
            <OneTimeSecret value={info.secret} label={T('webhook.secret')} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
