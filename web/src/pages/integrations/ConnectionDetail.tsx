import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../../api/client';
import { Badge, Button, Card, ErrorBox, FieldWrap, Input, KeyValue, LinkButton, Monogram, Notice, Skeleton, Table, Td, Th } from '../../components/ui/core';
import { DeleteDialog, Dialog, Menu, SecretField, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { isVisible, SchemaForm, useCatalog } from '../../components/forms/SchemaForm';
import { usePageMeta } from '../../components/layout/AppShell';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtDuration, fmtRelative } from '../../lib/format';
import { ConnStatusBadge, dateInputToIso, expiryNote, isoToDateInput, pl, TestChecklist, TestResultBox, type ConnectionFull, type SecretVersion, type TestResult } from './shared';

export default function ConnectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { can } = useAuth();
  const catalog = useCatalog();
  const q = useQuery<ConnectionFull>({ queryKey: ['connection', id], queryFn: () => get(`/connections/${id}`), enabled: !!id });
  const conn = q.data;
  const c = catalog.data?.connectors.find((x) => x.id === conn?.connector);
  usePageMeta({ title: conn?.name ?? t('integrations.detail.loadingTitle'), crumb: t('nav.connections') });

  const canEdit = can('connection.edit');
  const canCred = can('credential.manage');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['connection', id] });
    qc.invalidateQueries({ queryKey: ['connections'] });
  };

  /* ---------------------------- Test ---------------------------- */
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await post<TestResult>(`/connections/${id}/test`));
      refresh();
    } catch (e) {
      errorToast(e, t('integrations.detail.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  /* ------------------------ Konfiguration ----------------------- */
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, any>>({});
  const [expires, setExpires] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reset = () => {
    if (!conn) return;
    setName(conn.name);
    setValues({ ...(conn.config ?? {}) });
    setExpires(isoToDateInput(conn.credentials_expire_at));
    setSaveError(null);
  };
  useEffect(reset, [conn]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!conn && (name !== conn.name || JSON.stringify(values) !== JSON.stringify(conn.config ?? {}) || expires !== isoToDateInput(conn.credentials_expire_at));
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await patch(`/connections/${id}`, { name: name.trim(), config: values, credentialsExpireAt: dateInputToIso(expires) });
      toast({ tone: 'success', title: t('integrations.detail.saved'), text: t('integrations.detail.savedText') });
      refresh();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------ Zugangsdaten ------------------------ */
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretKey, setSecretKey] = useState(0);
  const [savingSecrets, setSavingSecrets] = useState(false);
  const secretsDirty = Object.values(secretValues).some(Boolean);
  const saveSecrets = async () => {
    setSavingSecrets(true);
    try {
      const values = Object.fromEntries(Object.entries(secretValues).filter(([, v]) => v));
      const res = await put<{ version: number }>(`/connections/${id}/secrets`, { values });
      toast({ tone: 'success', title: t('integrations.detail.secretsSaved', { v: res.version }), text: t('integrations.detail.secretsSavedText') });
      setSecretValues({});
      setSecretKey((k) => k + 1);
      refresh();
    } catch (e) {
      errorToast(e, t('integrations.detail.secretsFailed'));
    } finally {
      setSavingSecrets(false);
    }
  };
  const [revokeTarget, setRevokeTarget] = useState<SecretVersion | null>(null);
  const activate = async (v: SecretVersion) => {
    try {
      await post(`/connections/${id}/secrets/${v.id}/activate`);
      toast({ tone: 'success', title: t('integrations.detail.versionActivated', { v: v.version }), text: t('integrations.detail.versionActivatedText') });
      refresh();
    } catch (e) {
      errorToast(e);
    }
  };

  /* ------------------ Aktivieren / Löschen ---------------------- */
  const setEnabled = async (enabled: boolean, undo = true) => {
    try {
      await post(`/connections/${id}/status`, { enabled });
      refresh();
      toast({
        tone: enabled ? 'success' : 'info',
        title: enabled ? t('integrations.detail.enabled') : t('integrations.detail.disabled'),
        text: enabled ? t('integrations.detail.enabledText') : t('integrations.detail.disabledText'),
        action: undo ? { label: t('integrations.common.undo'), onClick: () => setEnabled(!enabled, false) } : undefined,
      });
    } catch (e) {
      errorToast(e);
    }
  };
  const [deleting, setDeleting] = useState(false);

  const usedActive = useMemo(() => (conn?.workflows ?? []).filter((w) => w.status === 'active'), [conn]);

  if (q.isLoading || catalog.isLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <div className="flex items-center gap-3">
          <Skeleton className="w-11 h-11 rounded-node" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      </div>
    );
  }
  if (q.error || !conn) {
    return (
      <ErrorBox title={t('integrations.detail.loadError')} actions={<LinkButton to="/verbindungen" size="sm">{t('integrations.detail.backToList')}</LinkButton>}>
        {(q.error as Error)?.message ?? t('integrations.detail.notFound')}
      </ErrorBox>
    );
  }

  const exp = expiryNote(conn.credentials_expire_at);
  const disabled = conn.status === 'disabled';

  return (
    <>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3.5 min-w-0">
          <Monogram text={c?.monogram ?? conn.connector.slice(0, 2).toUpperCase()} color={c?.color ?? '#475569'} size={44} />
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="m-0 text-page font-semibold tracking-[-0.02em] break-words">{conn.name}</h2>
            <p className="m-0 text-fg-muted flex items-center gap-2 flex-wrap">
              <span>{c?.name ?? conn.connector}</span>
              <span aria-hidden="true">·</span>
              <ConnStatusBadge status={conn.status} />
            </p>
          </div>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {conn.connector === 'wordpress' && can('wordpress.read') && (
            <LinkButton to={`/wordpress?site=${conn.id}`} icon="Megaphone">
              {t('integrations.detail.toWordPress')}
            </LinkButton>
          )}
          {canEdit && (
            <Button variant="primary" icon="FlaskConical" loading={testing} onClick={runTest}>
              {t('integrations.detail.testNow')}
            </Button>
          )}
          {canEdit && (
            <Menu
              items={[
                disabled ? { label: t('integrations.detail.enable'), icon: 'Power', onClick: () => setEnabled(true) } : { label: t('integrations.detail.disable'), icon: 'PowerOff', onClick: () => setEnabled(false) },
                canCred && { label: t('integrations.detail.delete'), icon: 'Trash2', danger: true, onClick: () => setDeleting(true) },
              ]}
            />
          )}
        </div>
      </div>

      {disabled && (
        <Notice tone="warning" title={t('integrations.detail.disabledNoticeTitle')}>
          <span className="flex flex-wrap items-center gap-2">
            {t('integrations.detail.disabledNoticeText')}
            {canEdit && (
              <Button size="sm" icon="Power" onClick={() => setEnabled(true)}>
                {t('integrations.detail.enable')}
              </Button>
            )}
          </span>
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="flex flex-col gap-5 min-w-0">
          {/* Status + Test */}
          <Card title={t('integrations.detail.statusTitle')} subtitle={conn.last_test_at ? t('integrations.detail.lastTest', { when: fmtRelative(conn.last_test_at), ms: fmtDuration(conn.last_test_ms) }) : t('integrations.detail.neverTested')}>
            <div className="flex flex-col gap-3">
              {conn.status === 'error' || conn.status === 'warning' ? (
                <Notice tone={conn.status === 'error' ? 'error' : 'warning'} title={conn.status === 'error' ? t('integrations.detail.errorTitle') : t('integrations.detail.warningTitle')}>
                  {conn.status_message ?? t('integrations.cards.errorNoMessage')}
                </Notice>
              ) : conn.status === 'ok' ? (
                <Notice tone="success" title={t('integrations.detail.okTitle')}>
                  {t('integrations.detail.okText')}
                </Notice>
              ) : conn.status === 'untested' ? (
                <Notice tone="primary" title={t('integrations.detail.untestedTitle')}>
                  {t('integrations.detail.untestedText')}
                </Notice>
              ) : null}
              {exp && (
                <Notice tone={exp.tone} title={t('integrations.detail.expiryTitle')}>
                  {exp.text}
                </Notice>
              )}
              {(testing || test) && (
                <div className="flex flex-col gap-3">
                  <TestChecklist pending={testing} pendingLabels={c?.testInfo} steps={test?.steps} />
                  {test && <TestResultBox result={test} />}
                </div>
              )}
            </div>
          </Card>

          {/* Konfiguration */}
          <Card title={t('integrations.detail.configTitle')} subtitle={t('integrations.detail.configSub')}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty) save();
              }}
            >
              <FieldWrap label={t('integrations.wizard.name')} required htmlFor="cd-name">
                <Input id="cd-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={100} />
              </FieldWrap>
              {c && c.fields.length > 0 && <SchemaForm fields={c.fields} values={values} onChange={setValues} catalog={catalog.data} disabled={!canEdit} />}
              <FieldWrap label={t('integrations.wizard.expires')} htmlFor="cd-exp" help={t('integrations.wizard.expiresHelp')}>
                <Input id="cd-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={!canEdit} className="max-w-[220px]" />
              </FieldWrap>
              {saveError && <ErrorBox title={t('integrations.detail.saveFailed')}>{saveError}</ErrorBox>}
              <p className="m-0 text-meta text-fg-muted">{t('integrations.detail.configHint')}</p>
            </form>
          </Card>

          {/* Zugangsdaten */}
          {c && c.secretFields.length > 0 && (
            <Card title={t('integrations.detail.secretsTitle')} subtitle={conn.secret?.version ? t('integrations.detail.secretsSub', { v: conn.secret.version, date: fmtDateTime(conn.secret.savedAt) }) : t('integrations.detail.secretsNone')}>
              <div className="flex flex-col gap-4">
                {canCred && canEdit ? (
                  <div key={secretKey} className="flex flex-col gap-4">
                    {c.secretFields.filter((f) => isVisible(f, values)).map((f) => (
                      <SecretField
                        key={f.key}
                        label={f.label}
                        help={f.help}
                        set={!!conn.secret?.fields[f.key]?.set}
                        savedAt={conn.secret?.savedAt}
                        value={secretValues[f.key] ?? ''}
                        onReplace={(v) => setSecretValues((s) => ({ ...s, [f.key]: v }))}
                      />
                    ))}
                    {secretsDirty && (
                      <div className="flex gap-2 flex-wrap items-center">
                        <Button variant="primary" icon="Save" loading={savingSecrets} onClick={saveSecrets}>
                          {t('integrations.detail.secretsSave')}
                        </Button>
                        <span className="text-meta text-fg-muted">{t('integrations.detail.secretsSaveHint')}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {c.secretFields.filter((f) => isVisible(f, values)).map((f) => (
                      <div key={f.key} className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">{f.label}</span>
                        <div className="h-field rounded-control bg-raised border border-line px-3 flex items-center gap-2 font-mono text-[13px] text-fg-muted">
                          <Icon name="Lock" size={14} />
                          {conn.secret?.fields[f.key]?.set ? '••••••••••••' : t('integrations.detail.secretNotSet')}
                        </div>
                      </div>
                    ))}
                    <p className="m-0 text-meta text-fg-muted">{t('integrations.detail.secretsNoPerm')}</p>
                  </>
                )}

                {conn.secretVersions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h4 className="m-0 text-sm font-semibold">{t('integrations.detail.versionsTitle')}</h4>
                    <Table className="border border-line rounded-node">
                      <thead>
                        <tr>
                          <Th>{t('integrations.detail.colVersion')}</Th>
                          <Th>{t('integrations.detail.colFingerprint')}</Th>
                          <Th>{t('integrations.detail.colCreated')}</Th>
                          <Th>{t('integrations.detail.colState')}</Th>
                          {canCred && canEdit && <Th align="right">{t('integrations.detail.colActions')}</Th>}
                        </tr>
                      </thead>
                      <tbody>
                        {conn.secretVersions.map((v) => (
                          <tr key={v.id}>
                            <Td mono>v{v.version}</Td>
                            <Td mono>{v.fingerprint ?? '–'}</Td>
                            <Td>
                              <span className="flex flex-col whitespace-nowrap">
                                <span>{fmtDateTime(v.created_at)}</span>
                                <span className="text-meta text-fg-muted">{v.created_by_name ?? t('integrations.common.system')}</span>
                              </span>
                            </Td>
                            <Td>
                              {v.current ? (
                                <Badge tone="success">{t('integrations.detail.vActive')}</Badge>
                              ) : v.revoked_at ? (
                                <Badge tone="neutral" title={fmtDateTime(v.revoked_at)}>
                                  {t('integrations.detail.vRevoked')}
                                </Badge>
                              ) : (
                                <Badge tone="primary">{t('integrations.detail.vOld')}</Badge>
                              )}
                            </Td>
                            {canCred && canEdit && (
                              <Td align="right">
                                {!v.current && !v.revoked_at && (
                                  <span className="inline-flex gap-1.5">
                                    <Button size="sm" icon="RotateCcw" onClick={() => activate(v)}>
                                      {t('integrations.detail.vActivate')}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(v)}>
                                      {t('integrations.detail.vRevoke')}
                                    </Button>
                                  </span>
                                )}
                              </Td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-5 min-w-0">
          <Card title={t('integrations.detail.usedTitle')} subtitle={pl(conn.workflows.length, 'integrations.cards.wf')}>
            {conn.workflows.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">{t('integrations.detail.usedNone')}</p>
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col">
                {conn.workflows.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-2 py-2 border-b border-line last:border-b-0">
                    <Link to={`/workflows/${w.id}`} className="text-sm truncate">
                      {w.name}
                    </Link>
                    <Badge tone={w.status === 'active' ? 'success' : 'neutral'}>{w.status === 'active' ? t('integrations.common.wfActive') : t('integrations.common.wfInactive')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('integrations.detail.infoTitle')}>
            <KeyValue
              items={[
                [t('integrations.detail.kvIntegration'), c?.name ?? conn.connector],
                [t('integrations.detail.kvCreated'), fmtDateTime(conn.created_at)],
                [t('integrations.detail.kvUpdated'), fmtDateTime(conn.updated_at)],
                [t('integrations.detail.kvLastUsed'), conn.last_used_at ? fmtRelative(conn.last_used_at) : t('integrations.connections.never')],
                [t('integrations.detail.kvExpires'), conn.credentials_expire_at ? fmtDate(conn.credentials_expire_at) : t('integrations.detail.noExpiry')],
                [t('integrations.detail.kvId'), <span className="font-mono text-meta break-all">{conn.id}</span>],
              ]}
            />
          </Card>
          {c?.help && (
            <Notice tone="primary" title={t('integrations.detail.helpTitle')}>
              {c.help}
            </Notice>
          )}
        </div>
      </div>

      {dirty && canEdit && (
        <div className="sticky bottom-4 z-30 flex items-center justify-between gap-3 flex-wrap bg-raised border border-line rounded-card shadow-float px-4 py-3" role="region" aria-label={t('integrations.detail.unsaved')}>
          <span className="text-sm font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-warn" aria-hidden="true" />
            {t('integrations.detail.unsaved')}
          </span>
          <span className="flex gap-2">
            <Button variant="ghost" onClick={reset}>
              {t('integrations.detail.discard')}
            </Button>
            <Button variant="primary" icon="Save" loading={saving} onClick={save} disabled={!name.trim()}>
              {t('integrations.detail.save')}
            </Button>
          </span>
        </div>
      )}

      <Dialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title={t('integrations.detail.revokeTitle', { v: revokeTarget?.version ?? '' })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
              {t('integrations.common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const v = revokeTarget!;
                setRevokeTarget(null);
                try {
                  await post(`/connections/${id}/secrets/${v.id}/revoke`);
                  toast({ tone: 'success', title: t('integrations.detail.revoked', { v: v.version }) });
                  refresh();
                } catch (e) {
                  errorToast(e);
                }
              }}
            >
              {t('integrations.detail.revokeConfirm', { v: revokeTarget?.version ?? '' })}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{t('integrations.detail.revokeText')}</p>
      </Dialog>

      <DeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        objectType={t('integrations.detail.objectType')}
        name={conn.name}
        extra={
          usedActive.length > 0 ? (
            <Notice tone="warning" title={t('integrations.detail.deleteUsedTitle')}>
              {t('integrations.detail.deleteUsedText', { list: usedActive.map((w) => w.name).join(', ') })}
            </Notice>
          ) : conn.workflows.length > 0 ? (
            <p className="m-0 text-fg-muted">{t('integrations.detail.deleteInactiveText', { n: conn.workflows.length })}</p>
          ) : null
        }
        onConfirm={async (typed) => {
          await del(`/connections/${id}`, { confirm: typed });
          qc.invalidateQueries({ queryKey: ['connections'] });
          toast({ tone: 'success', title: t('integrations.detail.deleted', { name: conn.name }) });
          navigate('/verbindungen');
        }}
      />
    </>
  );
}
