import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Badge, Button, Chip, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, Switch, Table, Td, Th } from '../../components/ui/core';
import { Dialog, OneTimeSecret, useErrorToast, useToast } from '../../components/ui/overlays';
import { ChipChoice } from '../../components/forms/SchemaForm';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import { fmtDate, fmtDateTime, fmtRelative } from '../../lib/format';
import { CodeBlock, pl } from './shared';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  roles: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_by_name: string | null;
}

interface RoleDef {
  id: string;
  label: string;
  description?: string;
}

function keyState(k: ApiKeyRow): 'active' | 'expired' | 'revoked' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export default function ApiKeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const keys = useQuery<ApiKeyRow[]>({ queryKey: ['api-keys'], queryFn: () => get('/api-keys') });
  const roles = useQuery<{ roles: RoleDef[] }>({ queryKey: ['roles'], queryFn: () => get('/roles'), staleTime: 300_000 });
  const roleLabel = (id: string) => roles.data?.roles.find((r) => r.id === id)?.label ?? id;
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<ApiKeyRow | null>(null);
  const rows = keys.data ?? [];
  const nActive = rows.filter((k) => keyState(k) === 'active').length;

  return (
    <>
      <PageHeader
        title={t('integrations.apikeys.title')}
        subtitle={keys.data ? pl(nActive, 'integrations.apikeys.subtitle') : t('integrations.apikeys.subtitleLoading')}
        actions={
          <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>
            {t('integrations.apikeys.create')}
          </Button>
        }
      />

      <Notice tone="primary" title={t('integrations.apikeys.explainTitle')}>
        {t('integrations.apikeys.explainText')}{' '}
        <Link to="/hilfe/api">{t('integrations.apikeys.helpLink')}</Link>
      </Notice>

      <section aria-label={t('integrations.apikeys.title')} className="bg-card border border-line rounded-card min-w-0">
        {keys.error ? (
          <div className="p-4">
            <ErrorBox title={t('integrations.apikeys.loadError')}>{(keys.error as Error).message}</ErrorBox>
          </div>
        ) : keys.isLoading ? (
          <SkeletonRows rows={4} className="p-4" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="KeyRound"
            title={t('integrations.apikeys.emptyTitle')}
            text={t('integrations.apikeys.emptyText')}
            action={
              <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>
                {t('integrations.apikeys.create')}
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('integrations.apikeys.colName')}</Th>
                <Th>{t('integrations.apikeys.colPrefix')}</Th>
                <Th>{t('integrations.apikeys.colRoles')}</Th>
                <Th>{t('integrations.apikeys.colCreated')}</Th>
                <Th>{t('integrations.apikeys.colUsed')}</Th>
                <Th>{t('integrations.apikeys.colExpires')}</Th>
                <Th>{t('integrations.apikeys.colStatus')}</Th>
                <Th align="right">
                  <span className="sr-only">{t('integrations.apikeys.colActions')}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => {
                const st = keyState(k);
                return (
                  <tr key={k.id} className={cx(st !== 'active' && 'opacity-60')}>
                    <Td className="font-medium min-w-[140px]">{k.name}</Td>
                    <Td mono>ll_{k.prefix}_…</Td>
                    <Td>
                      <span className="flex gap-1 flex-wrap min-w-[140px]">
                        {k.roles.map((r) => (
                          <Chip key={r}>{roleLabel(r)}</Chip>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <span className="flex flex-col whitespace-nowrap">
                        <span>{fmtDate(k.created_at)}</span>
                        {k.created_by_name && <span className="text-meta text-fg-muted">{k.created_by_name}</span>}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">{k.last_used_at ? <span title={fmtDateTime(k.last_used_at)}>{fmtRelative(k.last_used_at)}</span> : <span className="text-fg-muted">{t('integrations.connections.never')}</span>}</Td>
                    <Td className="whitespace-nowrap">{k.expires_at ? fmtDate(k.expires_at) : <span className="text-fg-muted">{t('integrations.apikeys.never')}</span>}</Td>
                    <Td>
                      {st === 'active' ? (
                        <Badge tone="success">{t('integrations.apikeys.stActive')}</Badge>
                      ) : st === 'expired' ? (
                        <Badge tone="warning">{t('integrations.apikeys.stExpired')}</Badge>
                      ) : (
                        <Badge tone="neutral" title={fmtDateTime(k.revoked_at)}>
                          {t('integrations.apikeys.stRevoked')}
                        </Badge>
                      )}
                    </Td>
                    <Td align="right">
                      {st !== 'revoked' && (
                        <Button size="sm" variant="ghost" icon="XCircle" onClick={() => setRevoke(k)} aria-label={t('integrations.apikeys.revokeAria', { name: k.name })}>
                          {t('integrations.apikeys.revoke')}
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      <CreateDialog open={creating} onClose={() => setCreating(false)} roles={roles.data?.roles ?? null} rolesError={roles.error ? (roles.error as Error).message : null} onCreated={() => qc.invalidateQueries({ queryKey: ['api-keys'] })} />

      <Dialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={t('integrations.apikeys.revokeTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoke(null)}>
              {t('integrations.common.cancel')}
            </Button>
            <Button
              variant="danger"
              icon="XCircle"
              onClick={async () => {
                const k = revoke!;
                setRevoke(null);
                try {
                  await post(`/api-keys/${k.id}/revoke`);
                  qc.invalidateQueries({ queryKey: ['api-keys'] });
                  toast({ tone: 'success', title: t('integrations.apikeys.revoked', { name: k.name }) });
                } catch (e) {
                  errorToast(e);
                }
              }}
            >
              {t('integrations.apikeys.revokeConfirm', { name: revoke?.name ?? '' })}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{t('integrations.apikeys.revokeText', { name: revoke?.name ?? '' })}</p>
      </Dialog>
    </>
  );
}

function CreateDialog({ open, onClose, roles, rolesError, onCreated }: { open: boolean; onClose: () => void; roles: RoleDef[] | null; rolesError: string | null; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [days, setDays] = useState(365);
  const [never, setNever] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const close = () => {
    setName('');
    setSel([]);
    setDays(365);
    setNever(false);
    setError(null);
    setCreated(null);
    onClose();
  };
  const options = (roles ?? []).filter((r) => r.id !== 'platform_admin').map((r) => ({ value: r.id, label: r.label }));
  const daysOk = never || (Number.isInteger(days) && days >= 1 && days <= 730);
  const valid = name.trim().length >= 2 && sel.length > 0 && daysOk;
  const example = created ? `curl -H "Authorization: Bearer ${created.key}" ${window.location.origin}/api/v1/workflows` : '';

  return (
    <Dialog
      open={open}
      onClose={close}
      width={600}
      title={created ? t('integrations.apikeys.createdTitle') : t('integrations.apikeys.createTitle')}
      footer={
        created ? (
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
              icon="KeyRound"
              loading={busy}
              disabled={!valid}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await post<{ key: string; name: string }>('/api-keys', { name: name.trim(), roles: sel, expiresDays: never ? null : days });
                  setCreated(res);
                  onCreated();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('integrations.apikeys.createConfirm')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4 text-sm">
          <p className="m-0">{t('integrations.apikeys.createdText', { name: created.name })}</p>
          <OneTimeSecret value={created.key} label={t('integrations.apikeys.keyLabel')} />
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">{t('integrations.apikeys.example')}</span>
            <CodeBlock code={example} />
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <FieldWrap label={t('integrations.apikeys.name')} required htmlFor="ak-name" help={t('integrations.apikeys.nameHelp')}>
            <Input id="ak-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
          </FieldWrap>
          <FieldWrap label={t('integrations.apikeys.roles')} required help={t('integrations.apikeys.rolesHelp')}>
            {rolesError ? (
              <ErrorBox title={t('integrations.apikeys.rolesError')}>{rolesError}</ErrorBox>
            ) : roles ? (
              <ChipChoice options={options} value={sel} onChange={setSel} label={t('integrations.apikeys.roles')} />
            ) : (
              <span className="text-meta text-fg-muted">{t('integrations.common.loading')}</span>
            )}
          </FieldWrap>
          {sel.length > 0 && roles && (
            <ul className="list-disc m-0 pl-5 text-meta text-fg-muted flex flex-col gap-0.5">
              {sel.map((id) => {
                const r = roles.find((x) => x.id === id);
                return r?.description ? (
                  <li key={id}>
                    <strong className="text-fg font-medium">{r.label}:</strong> {r.description}
                  </li>
                ) : null;
              })}
            </ul>
          )}
          <div className="flex flex-col gap-2">
            <FieldWrap label={t('integrations.apikeys.expires')} htmlFor="ak-days" error={daysOk ? null : t('integrations.apikeys.daysInvalid')}>
              <div className="flex items-center gap-2">
                <Input id="ak-days" type="number" min={1} max={730} value={Number.isNaN(days) ? '' : days} onChange={(e) => setDays(e.target.value === '' ? NaN : Number(e.target.value))} disabled={never} className="max-w-[120px] tabular" invalid={!daysOk} />
                <span className="text-sm text-fg-muted">{t('integrations.apikeys.days')}</span>
              </div>
            </FieldWrap>
            <Switch checked={never} onChange={setNever} label={t('integrations.apikeys.neverExpires')} description={t('integrations.apikeys.neverExpiresHelp')} />
          </div>
          {error && <ErrorBox title={t('integrations.apikeys.createFailed')}>{error}</ErrorBox>}
          <p className="m-0 text-meta text-fg-muted flex items-center gap-1.5">
            <Icon name="Lock" size={13} />
            {t('integrations.apikeys.storageNote')}
          </p>
        </form>
      )}
    </Dialog>
  );
}
