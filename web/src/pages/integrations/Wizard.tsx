import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, download, post } from '../../api/client';
import type { ConnectorInfo, Field } from '../../api/types';
import { Button, cx, ErrorBox, FieldWrap, Input, LinkButton, Monogram, Notice, Skeleton } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { isVisible, SchemaForm, useCatalog } from '../../components/forms/SchemaForm';
import { usePageMeta } from '../../components/layout/AppShell';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { dateInputToIso, helpSlug, isConnectable, TestChecklist, TestResultBox, type TestResult } from './shared';

type Step = 1 | 2 | 3 | 4;

function initialValues(fields: Field[]) {
  const v: Record<string, any> = {};
  for (const f of fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

export default function Wizard() {
  const { connector: param } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const catalog = useCatalog();
  const connectors = useMemo(() => (catalog.data?.connectors ?? []).filter(isConnectable), [catalog.data]);
  const selected = connectors.find((c) => c.id === param) ?? null;

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, any>>({});
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string; test: TestResult } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSecrets = can('credential.manage');

  // Auswahl aus der URL übernehmen; beim ersten Aufruf mit gültiger Integration direkt Schritt 2
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!catalog.data) return;
    if (selected) {
      setName((n) => n || selected.name);
      setValues(initialValues([...selected.fields, ...selected.secretFields]));
      setErrors({});
      setTest(null);
      setTestError(null);
      if (!started) setStep(2);
    } else setStep(1);
    setStarted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, catalog.data]);

  usePageMeta({ title: selected ? t('integrations.wizard.title', { name: selected.name }) : t('integrations.wizard.titleGeneric'), crumb: t('nav.interfaces') });

  const pick = (c: ConnectorInfo) => {
    setName(c.name);
    navigate(`/schnittstellen/${c.id}/verbinden`, { replace: true });
  };

  const fields = useMemo(() => (selected ? [...selected.fields, ...(canSecrets ? selected.secretFields : [])] : []), [selected, canSecrets]);

  const validate = () => {
    if (!selected) return false;
    const e: Record<string, string> = {};
    if (!name.trim()) e.__name = t('integrations.wizard.nameMissing');
    for (const f of fields) {
      if (!isVisible(f, values)) continue;
      const v = values[f.key];
      if (f.required && (v == null || v === '')) e[f.key] = t('integrations.wizard.fieldMissing', { label: f.label });
      if (f.type === 'url' && v) {
        try {
          const u = new URL(String(v));
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
          e[f.key] = t('integrations.wizard.urlInvalid');
        }
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const body = () => {
    const config: Record<string, any> = {};
    const secrets: Record<string, string> = {};
    for (const f of selected!.fields) if (values[f.key] !== undefined) config[f.key] = values[f.key];
    if (canSecrets) for (const f of selected!.secretFields) if (isVisible(f, values) && typeof values[f.key] === 'string' && values[f.key]) secrets[f.key] = values[f.key];
    return { connector: selected!.id, name: name.trim(), config, secrets, credentialsExpireAt: dateInputToIso(expires) };
  };

  const runTest = async () => {
    setStep(3);
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await post<TestResult>('/connections/test', body()));
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await post<{ id: string; name: string; test: TestResult }>('/connections', body());
      setSaved(res);
      setStep(4);
      qc.invalidateQueries({ queryKey: ['connections'] });
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (step === 1) {
      if (selected) setStep(2);
    } else if (step === 2) {
      if (validate()) runTest();
    } else if (step === 3) save();
    else if (saved) navigate(`/verbindungen/${saved.id}`);
  };
  const back = () => {
    if (step === 3) setStep(2);
    else if (step === 2) setStep(1);
  };

  const testFailed = step === 3 && !testing && (!!testError || (test && !test.ok));
  const nextLabel =
    step === 1 ? t('integrations.wizard.next') : step === 2 ? t('integrations.wizard.runTest') : step === 3 ? (testFailed ? t('integrations.wizard.saveAnyway') : t('integrations.wizard.save')) : t('integrations.wizard.done');

  const stepDefs: [string, string][] = [
    [t('integrations.wizard.step1'), selected?.name ?? t('integrations.wizard.step1Sub')],
    [t('integrations.wizard.step2'), t('integrations.wizard.step2Sub')],
    [t('integrations.wizard.step3'), t('integrations.wizard.step3Sub')],
    [t('integrations.wizard.step4'), t('integrations.wizard.step4Sub')],
  ];

  if (catalog.isLoading) {
    return (
      <div className="w-full max-w-[1180px] mx-auto flex flex-col gap-6" aria-busy="true">
        <div className="flex gap-3.5 items-center">
          <Skeleton className="w-11 h-11 rounded-node" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-80 w-full rounded-card" />
      </div>
    );
  }
  if (catalog.error) return <ErrorBox title={t('integrations.overview.loadError')}>{(catalog.error as Error).message}</ErrorBox>;

  return (
    <div className="w-full max-w-[1180px] mx-auto flex flex-col gap-6">
      <div className="flex items-center gap-3.5">
        {selected ? (
          <Monogram text={selected.monogram} color={selected.color} size={44} />
        ) : (
          <span className="w-11 h-11 rounded-node bg-primary-soft text-fg-link flex items-center justify-center shrink-0">
            <Icon name="Plug" size={20} />
          </span>
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 className="m-0 text-[22px] leading-7 font-semibold tracking-[-0.02em]">{selected ? t('integrations.wizard.title', { name: selected.name }) : t('integrations.wizard.titleGeneric')}</h2>
          <p className="m-0 text-fg-muted">{selected ? t('integrations.wizard.duration', { n: selected.setupMinutes }) : t('integrations.wizard.durationGeneric')}</p>
        </div>
      </div>

      <ol aria-label={t('integrations.wizard.progress')} className="list-none m-0 p-0 flex gap-2 flex-wrap">
        {stepDefs.map(([label, sub], i) => {
          const n = (i + 1) as Step;
          const done = n < step || (n === 4 && !!saved);
          const cur = n === step;
          const reachable = !saved && (n < step || (n === 2 && !!selected && step === 1));
          return (
            <li key={n} className="flex-[1_1_160px] flex">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && setStep(n)}
                aria-current={cur ? 'step' : undefined}
                className={cx('flex-1 flex items-center gap-2.5 px-3 py-2.5 border-t-2 bg-transparent text-left text-sm disabled:cursor-default', done || cur ? 'border-primary' : 'border-line', reachable && 'hover:bg-raised rounded-b-control')}
              >
                <span className={cx('w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0 text-meta font-semibold', done ? 'bg-primary-solid text-white' : cur ? 'bg-primary-soft text-fg-link shadow-[inset_0_0_0_1.5px_var(--ll-primary)]' : 'bg-raised text-fg-muted')}>
                  {done ? <Icon name="Check" size={13} strokeWidth={2.6} /> : n}
                </span>
                <span className="flex flex-col min-w-0">
                  <span className={cx('font-medium', !(cur || done) && 'text-fg-muted')}>
                    {label}
                    {done && <span className="sr-only"> ({t('integrations.wizard.stepDone')})</span>}
                  </span>
                  <span className="text-meta text-fg-muted truncate">{sub}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex gap-5 flex-wrap items-start">
        <section aria-label={stepDefs[step - 1][0]} className="flex-[3_1_520px] min-w-0 bg-card border border-line rounded-card flex flex-col">
          {step === 1 && (
            <div className="p-[22px] flex flex-col gap-4">
              <h3 className="m-0 text-base font-semibold">{t('integrations.wizard.pickTitle')}</h3>
              <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
                {connectors.map((c) => {
                  const on = selected?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => pick(c)}
                      className={cx('flex items-center gap-2.5 p-3 rounded-node text-left text-sm font-medium transition-colors duration-fast', on ? 'border-[1.5px] border-primary bg-primary-soft' : 'border border-line hover:bg-raised')}
                    >
                      <Monogram text={c.monogram} color={c.color} size={30} />
                      <span className="flex flex-col min-w-0">
                        <span className="break-words">{c.name}</span>
                        <span className="text-meta text-fg-muted font-normal truncate">{c.group}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {selected && <p className="m-0 text-sm text-fg-muted">{selected.description}</p>}
            </div>
          )}

          {step === 2 && selected && (
            <form
              className="p-[22px] flex flex-col gap-[18px]"
              aria-label={t('integrations.wizard.formLabel')}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                next();
              }}
            >
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-base font-semibold">{t('integrations.wizard.step2')}</h3>
                <p className="m-0 text-sm text-fg-muted">{t('integrations.wizard.step2Intro')}</p>
              </div>

              {selected.id === 'wordpress' && <WordPressSetupBox />}
              {selected.id === 'alamos' && (
                <Notice tone="primary" title={t('integrations.wizard.alamosTitle')}>
                  {t('integrations.wizard.alamosText')}
                </Notice>
              )}

              <FieldWrap label={t('integrations.wizard.name')} required htmlFor="wz-name" error={errors.__name} help={t('integrations.wizard.nameHelp')}>
                <Input id="wz-name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.__name} maxLength={100} autoComplete="off" />
              </FieldWrap>

              <SchemaForm fields={fields} values={values} onChange={setValues} catalog={catalog.data} errors={errors} />

              {!canSecrets && selected.secretFields.length > 0 && (
                <Notice tone="warning" title={t('integrations.wizard.noSecretPermTitle')}>
                  {t('integrations.wizard.noSecretPermText')}
                </Notice>
              )}

              {selected.secretFields.length > 0 && canSecrets && (
                <FieldWrap label={t('integrations.wizard.expires')} htmlFor="wz-exp" help={t('integrations.wizard.expiresHelp')}>
                  <Input id="wz-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className="max-w-[220px]" />
                </FieldWrap>
              )}
              <button type="submit" className="sr-only" tabIndex={-1}>
                {t('integrations.wizard.runTest')}
              </button>
            </form>
          )}

          {step === 3 && selected && (
            <div className="p-[22px] flex flex-col gap-3.5">
              <h3 className="m-0 text-base font-semibold">{t('integrations.wizard.step3')}</h3>
              <TestChecklist pending={testing} pendingLabels={selected.testInfo} steps={test?.steps} />
              {testError && (
                <ErrorBox title={t('integrations.wizard.testRequestFailed')}>
                  <p className="m-0">{testError}</p>
                  <p className="m-0 mt-1">{t('integrations.wizard.testRequestHint')}</p>
                </ErrorBox>
              )}
              {test && <TestResultBox result={test} />}
              {testFailed && (
                <div className="flex gap-2 flex-wrap">
                  <Button icon="RefreshCw" variant="ghost" onClick={runTest}>
                    {t('integrations.wizard.retest')}
                  </Button>
                </div>
              )}
              {saveError && <ErrorBox title={t('integrations.wizard.saveFailed')}>{saveError}</ErrorBox>}
            </div>
          )}

          {step === 4 && saved && selected && (
            <div className="px-[22px] py-8 flex flex-col items-start gap-3">
              <span className={cx('w-11 h-11 rounded-full inline-flex items-center justify-center', saved.test.ok ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
                <Icon name={saved.test.ok ? 'Check' : 'AlertTriangle'} size={22} strokeWidth={2.4} />
              </span>
              <h3 className="m-0 text-[18px] leading-6 font-semibold">{saved.test.ok ? t('integrations.wizard.doneTitle', { name: saved.name }) : t('integrations.wizard.doneTitleWarn', { name: saved.name })}</h3>
              <p className="m-0 text-fg-muted leading-normal">{saved.test.ok ? t('integrations.wizard.doneText', { name: selected.name }) : t('integrations.wizard.doneTextWarn')}</p>
              <div className="flex gap-2 flex-wrap">
                {can('workflow.edit') && (
                  <LinkButton to="/workflows?neu=1" variant="primary" icon="Workflow">
                    {t('integrations.wizard.createWorkflow', { name: selected.name })}
                  </LinkButton>
                )}
                <LinkButton to={`/verbindungen/${saved.id}`}>{t('integrations.wizard.toConnection')}</LinkButton>
                {selected.id === 'wordpress' && <LinkButton to={`/wordpress?site=${saved.id}`} variant="ghost">{t('integrations.wizard.toWordPress')}</LinkButton>}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap px-[22px] py-3.5 border-t border-line">
            {step < 4 ? (
              <Link to="/schnittstellen" className="text-sm !text-fg-muted hover:!text-fg mr-auto">
                {t('integrations.wizard.cancel')}
              </Link>
            ) : (
              <Link to="/schnittstellen" className="text-sm !text-fg-muted hover:!text-fg mr-auto">
                {t('integrations.wizard.toOverview')}
              </Link>
            )}
            {(step === 2 || step === 3) && (
              <Button onClick={back} disabled={testing || saving} icon={testFailed ? 'ArrowLeft' : undefined}>
                {testFailed ? t('integrations.wizard.backFix') : t('integrations.wizard.back')}
              </Button>
            )}
            {step < 4 && (
              <Button variant="primary" onClick={next} loading={(step === 3 && (testing || saving)) || false} disabled={(step === 1 && !selected) || (step === 3 && testing)}>
                {nextLabel}
              </Button>
            )}
          </div>
        </section>

        <aside className="flex-[1_1_280px] min-w-0 flex flex-col gap-3.5">
          <div className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-2.5">
            <h3 className="m-0 text-base font-semibold flex items-center gap-2">
              <Icon name="ShieldCheck" size={16} className="text-fg-link" />
              {t('integrations.wizard.securityTitle')}
            </h3>
            <ul className="list-disc m-0 pl-[18px] text-sm text-fg-muted leading-relaxed">
              {!(selected?.securityNotes ?? []).some((n) => /verschlüssel/i.test(n)) && <li>{t('integrations.wizard.securityDefault1')}</li>}
              <li>{t('integrations.wizard.securityDefault2')}</li>
              {(selected?.securityNotes ?? []).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-2.5">
            <h3 className="m-0 text-base font-semibold flex items-center gap-2">
              <Icon name="FlaskConical" size={16} className="text-fg-link" />
              {t('integrations.wizard.testInfoTitle')}
            </h3>
            {selected && selected.testInfo.length > 0 ? (
              <ol className="list-decimal m-0 pl-[18px] text-sm text-fg-muted leading-relaxed">
                {selected.testInfo.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-sm text-fg-muted leading-relaxed">{selected ? t('integrations.wizard.testInfoNone') : t('integrations.wizard.testInfoPick')}</p>
            )}
            <p className="m-0 text-meta text-fg-muted">{t('integrations.wizard.testInfoNote')}</p>
            {selected?.help && <p className="m-0 text-meta text-fg-muted">{selected.help}</p>}
            <Link to={`/hilfe/${helpSlug(selected?.id)}`} className="text-sm">
              {t('integrations.wizard.helpLink')}
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function WordPressSetupBox() {
  return (
    <div className="rounded-node border border-primary/40 bg-primary-soft p-4 flex flex-col gap-3">
      <strong className="text-sm font-semibold flex items-center gap-2">
        <Icon name="ListChecks" size={16} className="text-fg-link" />
        {t('integrations.wizard.wpTitle')}
      </strong>
      <ol className="list-decimal m-0 pl-5 text-sm flex flex-col gap-2">
        <li>
          <span className="flex flex-wrap items-center gap-2">
            {t('integrations.wizard.wp1')}
            <Button size="sm" icon="Download" onClick={() => download('/wordpress/plugin/download')}>
              {t('integrations.wizard.wpDownload')}
            </Button>
          </span>
        </li>
        <li>{t('integrations.wizard.wp2')}</li>
        <li>{t('integrations.wizard.wp3')}</li>
        <li>{t('integrations.wizard.wp4')}</li>
      </ol>
    </div>
  );
}
