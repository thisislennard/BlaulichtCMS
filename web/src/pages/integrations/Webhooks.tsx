import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, LinkButton, Notice, PageHeader, SegmentedControl, SkeletonRows, Table, Td, Th } from '../../components/ui/core';
import { CopyButton, Dialog, OneTimeSecret, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNumber, fmtRelative } from '../../lib/format';
import { CodeBlock, pl } from './shared';

interface WebhookRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_status: string;
  node_id: string;
  auth_mode: 'hmac' | 'token';
  status: 'active' | 'revoked';
  created_at: string;
  last_received_at: string | null;
  received_count: number | string;
  previous_valid_until: string | null;
  secret_created_at: string | null;
  fingerprint: string | null;
  url: string;
  path: string;
}

export default function Webhooks() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const q = useQuery<WebhookRow[]>({ queryKey: ['webhooks'], queryFn: () => get('/webhooks') });
  const canManage = can('credential.manage');
  const [rotate, setRotate] = useState<WebhookRow | null>(null);
  const rows = q.data ?? [];
  const nActive = rows.filter((r) => r.status === 'active').length;

  const setActive = async (w: WebhookRow, active: boolean, undo = true) => {
    try {
      await post(`/webhooks/${w.id}/status`, { active });
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      toast({
        tone: active ? 'success' : 'info',
        title: active ? t('integrations.webhooks.reactivated') : t('integrations.webhooks.revoked'),
        text: active ? t('integrations.webhooks.reactivatedText', { name: w.workflow_name }) : t('integrations.webhooks.revokedText', { name: w.workflow_name }),
        action: undo ? { label: t('integrations.common.undo'), onClick: () => setActive(w, !active, false) } : undefined,
      });
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <>
      <PageHeader
        title={t('integrations.webhooks.title')}
        subtitle={q.data ? t('integrations.webhooks.subtitle', { e: pl(rows.length, 'integrations.webhooks.endpoints'), a: nActive }) : t('integrations.webhooks.subtitleLoading')}
        actions={
          <LinkButton to="/hilfe/webhooks" icon="BookOpen">
            {t('integrations.webhooks.help')}
          </LinkButton>
        }
      />

      <section aria-label={t('integrations.webhooks.title')} className="bg-card border border-line rounded-card min-w-0">
        {q.error ? (
          <div className="p-4">
            <ErrorBox title={t('integrations.webhooks.loadError')}>{(q.error as Error).message}</ErrorBox>
          </div>
        ) : q.isLoading ? (
          <SkeletonRows rows={4} className="p-4" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="Webhook"
            title={t('integrations.webhooks.emptyTitle')}
            text={t('integrations.webhooks.emptyText')}
            action={can('workflow.read') && <LinkButton to="/workflows" icon="Workflow">{t('integrations.webhooks.toWorkflows')}</LinkButton>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('integrations.webhooks.colWorkflow')}</Th>
                <Th>{t('integrations.webhooks.colUrl')}</Th>
                <Th>{t('integrations.webhooks.colAuth')}</Th>
                <Th>{t('integrations.webhooks.colStatus')}</Th>
                <Th>{t('integrations.webhooks.colLast')}</Th>
                <Th>{t('integrations.webhooks.colSecret')}</Th>
                {canManage && <Th align="right">{t('integrations.webhooks.colActions')}</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const grace = w.previous_valid_until && new Date(w.previous_valid_until).getTime() > Date.now() ? w.previous_valid_until : null;
                return (
                  <tr key={w.id} className={cx('align-top', w.status === 'revoked' && 'opacity-70')}>
                    <Td>
                      <div className="flex flex-col gap-0.5 min-w-[160px]">
                        <Link to={`/workflows/${w.workflow_id}`} className="font-medium">
                          {w.workflow_name}
                        </Link>
                        <span className="text-meta text-fg-muted">{w.workflow_status === 'active' ? t('integrations.common.wfActive') : t('integrations.common.wfInactive')}</span>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2 min-w-[240px] max-w-[340px]">
                        <code className="font-mono text-meta bg-raised rounded-chip px-2 py-1 break-all flex-1">{w.url}</code>
                        <CopyButton value={w.url} size="sm" label={t('integrations.common.copy')} />
                      </div>
                    </Td>
                    <Td>
                      <Badge tone="primary" dot={false}>
                        <Icon name={w.auth_mode === 'hmac' ? 'ShieldCheck' : 'KeyRound'} size={12} />
                        {w.auth_mode === 'hmac' ? t('integrations.webhooks.authHmac') : t('integrations.webhooks.authToken')}
                      </Badge>
                    </Td>
                    <Td>{w.status === 'active' ? <Badge tone="success">{t('integrations.webhooks.active')}</Badge> : <Badge tone="error">{t('integrations.webhooks.revokedBadge')}</Badge>}</Td>
                    <Td>
                      <span className="flex flex-col whitespace-nowrap">
                        <span>{w.last_received_at ? fmtRelative(w.last_received_at) : t('integrations.webhooks.neverReceived')}</span>
                        <span className="text-meta text-fg-muted tabular">{Number(w.received_count) === 1 ? t('integrations.webhooks.countOne') : t('integrations.webhooks.count', { n: fmtNumber(Number(w.received_count)) })}</span>
                      </span>
                    </Td>
                    <Td>
                      <span className="flex flex-col gap-0.5 min-w-[150px]">
                        <span className="whitespace-nowrap">{w.secret_created_at ? fmtDateTime(w.secret_created_at) : '–'}</span>
                        {w.fingerprint && <span className="font-mono text-meta text-fg-muted">{w.fingerprint}</span>}
                        {grace && <span className="text-meta text-warn">{t('integrations.webhooks.grace', { when: fmtDateTime(grace) })}</span>}
                      </span>
                    </Td>
                    {canManage && (
                      <Td align="right">
                        <span className="inline-flex gap-1.5 justify-end flex-wrap">
                          <Button size="sm" icon="RefreshCw" onClick={() => setRotate(w)}>
                            {t('integrations.webhooks.rotate')}
                          </Button>
                          {w.status === 'active' ? (
                            <Button size="sm" variant="ghost" icon="PowerOff" onClick={() => setActive(w, false)}>
                              {t('integrations.webhooks.revoke')}
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" icon="Power" onClick={() => setActive(w, true)}>
                              {t('integrations.webhooks.reactivate')}
                            </Button>
                          )}
                        </span>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      <Explainer hmacUrl={rows.find((r) => r.auth_mode === 'hmac')?.url} tokenUrl={rows.find((r) => r.auth_mode === 'token')?.url} />

      <RotateDialog
        target={rotate}
        onClose={() => setRotate(null)}
        onDone={() => qc.invalidateQueries({ queryKey: ['webhooks'] })}
      />
    </>
  );
}

function RotateDialog({ target, onClose, onDone }: { target: WebhookRow | null; onClose: () => void; onDone: () => void }) {
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setSecret(null);
    setError(null);
    setHours(24);
    onClose();
  };
  const valid = Number.isInteger(hours) && hours >= 0 && hours <= 168;
  return (
    <Dialog
      open={!!target}
      onClose={close}
      title={secret ? t('integrations.webhooks.newSecretTitle') : t('integrations.webhooks.rotateTitle')}
      footer={
        secret ? (
          <Button variant="primary" onClick={close}>
            {t('integrations.webhooks.copiedDone')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t('integrations.common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon="RefreshCw"
              loading={busy}
              disabled={!valid}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await post<{ secret: string }>(`/webhooks/${target!.id}/rotate`, { graceHours: hours });
                  setSecret(res.secret);
                  onDone();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('integrations.webhooks.rotateConfirm')}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="m-0">{t('integrations.webhooks.newSecretText', { name: target?.workflow_name ?? '' })}</p>
          <OneTimeSecret value={secret} label={t('integrations.webhooks.newSecretLabel')} />
          {hours > 0 ? <p className="m-0 text-fg-muted">{t('integrations.webhooks.graceInfo', { h: hours })}</p> : <p className="m-0 text-warn">{t('integrations.webhooks.graceNone')}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <p className="m-0">{t('integrations.webhooks.rotateText', { name: target?.workflow_name ?? '' })}</p>
          <FieldWrap label={t('integrations.webhooks.graceLabel')} htmlFor="wh-grace" help={t('integrations.webhooks.graceHelp')} error={valid ? null : t('integrations.webhooks.graceInvalid')}>
            <div className="flex items-center gap-2 flex-wrap">
              <Input id="wh-grace" type="number" min={0} max={168} value={Number.isNaN(hours) ? '' : hours} onChange={(e) => setHours(e.target.value === '' ? NaN : Number(e.target.value))} className="max-w-[110px] tabular" invalid={!valid} />
              <span className="text-fg-muted">{t('integrations.webhooks.hours')}</span>
              <SegmentedControl<string>
                size="sm"
                label={t('integrations.webhooks.graceQuick')}
                value={String(hours)}
                onChange={(v) => setHours(Number(v))}
                options={[
                  { value: '0', label: t('integrations.webhooks.graceImmediate') },
                  { value: '24', label: '24 h' },
                  { value: '72', label: '72 h' },
                  { value: '168', label: '7 Tage' },
                ]}
              />
            </div>
          </FieldWrap>
          {target?.auth_mode === 'token' && <Notice tone="primary">{t('integrations.webhooks.rotateTokenNote')}</Notice>}
          {error && <ErrorBox title={t('integrations.webhooks.rotateFailed')}>{error}</ErrorBox>}
        </div>
      )}
    </Dialog>
  );
}

function Explainer({ hmacUrl, tokenUrl }: { hmacUrl?: string; tokenUrl?: string }) {
  const fallback = `${window.location.origin}/hooks/<token>`;
  const url = hmacUrl ?? fallback;
  const turl = tokenUrl ?? fallback;
  const hmac = [
    `GEHEIMNIS='whsec_…'`,
    `BODY='{"stichwort":"B3","adresse":"Hauptstraße 1"}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$GEHEIMNIS" -hex | sed 's/^.* //')`,
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-LifeLink-Timestamp: $TS" \\`,
    `  -H "X-LifeLink-Signature: v1=$SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n');
  const token = [`curl -X POST '${turl}' \\`, `  -H 'Content-Type: application/json' \\`, `  -H 'X-LifeLink-Token: whsec_…' \\`, `  -d '{"stichwort":"B3"}'`].join('\n');
  return (
    <Card title={t('integrations.webhooks.explainTitle')} subtitle={t('integrations.webhooks.explainSub')}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2 min-w-0">
          <h4 className="m-0 text-sm font-semibold flex items-center gap-2">
            <Icon name="ShieldCheck" size={15} className="text-fg-link" />
            {t('integrations.webhooks.authHmac')}
          </h4>
          <p className="m-0 text-sm text-fg-muted">
            {t('integrations.webhooks.explainHmac1')} <code className="font-mono text-meta text-fg">X-LifeLink-Timestamp</code> {t('integrations.webhooks.explainHmac2')}{' '}
            <code className="font-mono text-meta text-fg">X-LifeLink-Signature: v1=&lt;hex hmac_sha256(geheimnis, timestamp + "." + body)&gt;</code>. {t('integrations.webhooks.explainHmac3')}
          </p>
          <CodeBlock code={hmac} />
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <h4 className="m-0 text-sm font-semibold flex items-center gap-2">
            <Icon name="KeyRound" size={15} className="text-fg-link" />
            {t('integrations.webhooks.authToken')}
          </h4>
          <p className="m-0 text-sm text-fg-muted">
            {t('integrations.webhooks.explainToken1')} <code className="font-mono text-meta text-fg">X-LifeLink-Token</code> {t('integrations.webhooks.explainToken2')}
          </p>
          <CodeBlock code={token} />
          <p className="m-0 text-meta text-fg-muted">
            {t('integrations.webhooks.explainMore')}{' '}
            <Link to="/hilfe/webhooks">{t('integrations.webhooks.help')}</Link>
          </p>
        </div>
      </div>
    </Card>
  );
}
