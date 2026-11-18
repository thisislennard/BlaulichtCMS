import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, Card, Chip, cx, ErrorBox, FieldWrap, Input, KeyValue, Notice, PageHeader, Rev, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { usePageMeta } from '../../components/layout/AppShell';
import { Icon } from '../../components/ui/Icon';
import { Dialog, UnsavedChangesGuard, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { resolveKeyword, useKeywords } from '../../lib/keywords';
import { fmtDateTime, fromLocalInput, toLocalInput, plural } from '../../lib/format';
import { KIND, LevelBadge, WARN_STATE } from './Warnings';

interface Field {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'datetime' | 'checkbox' | 'select';
  required?: boolean;
  help?: string;
  options?: string[];
}
interface Suggestion {
  level: number | null;
  status: string;
  reason: string;
  rules: { id: string; version: number; name: string; level: number }[];
  missing: { key: string; text: string }[];
}
interface Keyword {
  id: string;
  code: string;
  label: string;
  aliases?: string[];
  rule_count?: number;
}
interface Detail {
  warning: { id: string; case_no: string; kind: 'initial' | 'update' | 'all_clear'; parent_id: string | null; parent_case_no: string | null; fe2_event_id: string | null };
  state: string;
  template: { id: string; name: string; version: number; fields: Field[]; level_labels: Record<string, string>; note: string; newer_version: number | null };
  revision: { number: number; data: Record<string, any>; responsibility_ids: string[]; keyword: Keyword | null; answers: Record<string, string>; suggestion: Suggestion | null; level_decision: any; content_hash: string; submitted_at: string | null };
  questions: { id: string; key: string; text: string; options: string[] }[];
  previousLevel: { level: number; case_no: string } | null;
  approval: { id: string; decided_by_name: string; decided_at: string; pdf_sha256: string } | null;
  lastDecision: { decision: string; note: string; decided_by_name: string; decided_at: string } | null;
  revisions: { number: number; created_at: string; level: number | null; created_by_name: string }[];
  approvals: { id: string; decision: string; note: string; decided_at: string; revision_number: number; decided_by_name: string; pdf_sha256: string | null }[];
  sends: any[];
  followUps: { id: string; case_no: string; kind: string }[];
  recipients: { responsibilities: { id: string; name: string; recipients: string[] }[]; intended: string[] };
  testMode: { active: boolean; recipient: string };
  missing: string[];
}

const STEPS = [
  { id: 'vorgang', label: 'Vorgang', icon: 'FileText' },
  { id: 'stufe', label: 'Stichwort & Warnstufe', icon: 'Siren' },
  { id: 'gebiet', label: 'Gebiet & Zeitraum', icon: 'Globe' },
  { id: 'inhalt', label: 'Inhalt', icon: 'NotebookPen' },
  { id: 'pruefen', label: 'Prüfen & PDF', icon: 'ShieldCheck' },
  { id: 'versand', label: 'Versand', icon: 'Send' },
] as const;
type StepId = (typeof STEPS)[number]['id'];
const PLACE_KEYS = new Set(['area', 'starts_at', 'valid_until']);

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Eingabefeld je Vorlagenfeld. Zeitpunkte werden mit Zeitzone gespeichert. */
function TemplateField({ f, value, onChange, disabled }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean }) {
  const id = `wf-${f.key}`;
  return (
    <FieldWrap label={f.label} required={f.required} help={f.help} htmlFor={id}>
      {f.type === 'textarea' ? (
        <Textarea id={id} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      ) : f.type === 'datetime' ? (
        <Input id={id} type="datetime-local" value={toLocalInput(value) || ''} onChange={(e) => onChange(fromLocalInput(e.target.value))} disabled={disabled} />
      ) : f.type === 'checkbox' ? (
        <label className="flex items-center gap-2">
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} /> ja
        </label>
      ) : f.type === 'select' ? (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">– bitte wählen –</option>
          {(f.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      ) : (
        <Input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      )}
    </FieldWrap>
  );
}

function SuggestionBox({ s, labels }: { s: Suggestion | null; labels: Record<string, string> }) {
  if (!s) return null;
  if (s.level) {
    return (
      <Notice icon="Sparkles" title={`Vorschlag: ${labels[String(s.level)] ?? `Warnstufe ${s.level}`}`}>
        <p className="text-sm">{s.reason}</p>
        <p className="text-meta text-fg-muted mt-1">Nur ein Vorschlag – er muss von einer berechtigten Person ausdrücklich bestätigt oder begründet geändert werden.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" icon="AlertTriangle" title="Keine eindeutige Empfehlung – fachlich prüfen">
      <p className="text-sm">{s.reason.replace(/^Keine eindeutige Empfehlung – fachlich prüfen:\s*/, '')}</p>
      <p className="text-meta mt-1">Ein fehlender Vorschlag ist keine Entwarnung.</p>
    </Notice>
  );
}

/** Bei Wechsel auf einen anderen Vorgang (Bezug, Folgevorgang) frisch beginnen – keine Daten des vorherigen (#70). */
/** Löschen mit Vorschau: welche Vorgänge betroffen sind, wer löschen darf und ob eine Begründung nötig ist. */
function DeleteWarningDialog({ id, caseNo, onClose, onDeleted }: { id: string; caseNo: string; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const check = useQuery({ queryKey: ['warning-delete-check', id], queryFn: () => get<{ tree: { id: string; case_no: string; kind: string }[]; level: 'draft' | 'approved' | 'sent'; allowed: boolean; reasonRequired: boolean; running: boolean; hint: string }>(`/warnings/${id}/delete-check`) });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = check.data;
  const ready = !!c && c.allowed && !c.running && (!c.reasonRequired || reason.trim().length >= 5);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Vorgang ${caseNo} löschen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="danger"
            icon="Trash2"
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await del<{ deleted: number }>(`/warnings/${id}`, reason.trim() ? { reason: reason.trim() } : {});
                toast({ tone: 'success', title: r.deleted > 1 ? `${r.deleted} Vorgänge gelöscht` : 'Vorgang gelöscht' });
                onDeleted();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {c && c.tree.length > 1 ? `${c.tree.length} Vorgänge löschen` : 'Vorgang löschen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {check.isLoading && <SkeletonRows rows={2} />}
        {check.error && <p className="m-0 text-err">{(check.error as Error).message}</p>}
        {c && (
          <>
            <p className="m-0">Gelöscht werden Fassungen, Freigaben, PDF-Dateien, Versandnachweise und der Rückrufkontakt. Das Audit-Protokoll behält nur Vorgangsnummer, Person und Begründung. Das lässt sich nicht rückgängig machen.</p>
            {c.tree.length > 1 && (
              <div>
                <p className="m-0 font-medium">Mitgelöscht werden alle Aktualisierungen und Entwarnungen, die darauf aufbauen:</p>
                <ul className="m-0 mt-1 pl-5">
                  {c.tree.map((t) => (
                    <li key={t.id}>
                      <span className="font-mono">{t.case_no}</span> – {KIND[t.kind as 'initial']}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Notice tone={c.allowed ? (c.level === 'draft' ? 'info' : 'warning') : 'error'}>{c.hint}</Notice>
            {c.running && <Notice tone="warning">Ein Versand läuft gerade. Bitte das Ergebnis abwarten und dann löschen.</Notice>}
            {c.allowed && (
              <FieldWrap label={c.reasonRequired ? 'Begründung (Pflicht)' : 'Begründung (optional)'} htmlFor="wdel-reason" help="Steht im Audit-Protokoll – ohne Inhalte des Vorgangs.">
                <Textarea id="wdel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </FieldWrap>
            )}
            {error && <p className="m-0 text-err text-meta">{error}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

export default function WarningCase() {
  const { id = '' } = useParams();
  return <WarningCaseInner key={id} id={id} />;
}

function WarningCaseInner({ id }: { id: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['warning', id], queryFn: () => get<Detail>(`/warnings/${id}`) });
  const resp = useQuery({ queryKey: ['responsibilities'], queryFn: () => get<{ id: string; name: string; area: string; recipients: string[] }[]>('/responsibilities') });
  const d = q.data;
  usePageMeta({ title: d?.warning.case_no });
  const [step, setStep] = useState<StepId>('vorgang');
  const [v, setV] = useState<{ data: Record<string, any>; responsibilityIds: string[]; keyword: Keyword | null; answers: Record<string, string> } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kwSearch, setKwSearch] = useState('');
  const [level, setLevel] = useState<number | null>(null);
  const [levelReason, setLevelReason] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Server-Stand übernehmen, solange nichts ungespeichert ist
  useEffect(() => {
    if (d && !dirty) setV({ data: d.revision.data ?? {}, responsibilityIds: d.revision.responsibility_ids ?? [], keyword: d.revision.keyword, answers: d.revision.answers ?? {} });
  }, [d, dirty]);

  const allClear = d?.warning.kind === 'all_clear';
  const editable = !!d && can('warning.draft') && ['draft', 'rejected', 'in_review'].includes(d.state);
  const kwQuery = useDebounced(kwSearch);
  const keywords = useQuery({ queryKey: ['warning-keywords', kwQuery], queryFn: () => get<Keyword[]>(`/warning-keywords?q=${encodeURIComponent(kwQuery)}`), enabled: step === 'stufe' && !allClear && editable });
  const kwAll = useKeywords();
  const fe2 = useQuery({ queryKey: ['fe2-events'], queryFn: () => get<any[]>('/fe2-events'), enabled: step === 'stufe' && !allClear && editable });
  const questions = useQuery({
    queryKey: ['warning-questions', v?.keyword?.id],
    queryFn: () => get<Detail['questions']>(`/warning-keywords/${v!.keyword!.id}/questions`),
    enabled: !!v?.keyword?.id,
  });
  const lage = useDebounced(JSON.stringify([v?.keyword?.id ?? null, v?.answers ?? {}]), 250);
  const live = useQuery({
    queryKey: ['warning-suggest', lage],
    queryFn: () => post<Suggestion>('/warnings/suggest', { keywordId: JSON.parse(lage)[0], answers: JSON.parse(lage)[1] }),
    enabled: !!v && !allClear && dirty,
  });
  const suggestion: Suggestion | null = dirty ? (live.data ?? null) : (d?.revision.suggestion ?? null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['warning', id] });
    qc.invalidateQueries({ queryKey: ['warnings'] });
  };
  const change = (patch: Partial<NonNullable<typeof v>>) => {
    setV((cur) => (cur ? { ...cur, ...patch } : cur));
    setDirty(true);
  };
  const save = async (): Promise<boolean> => {
    if (!d || !v || !dirty) return true;
    setBusy(true);
    try {
      const r = await put<any>(`/warnings/${id}/revision`, { baseRevision: d.revision.number, data: v.data, responsibilityIds: v.responsibilityIds, keywordId: v.keyword?.id ?? null, answers: v.answers });
      if (r.levelReset) toast({ tone: 'warning', title: 'Warnstufe neu bestätigen', text: 'Stichwort oder Lageangaben haben sich geändert.' });
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['warning', id] });
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast({ tone: 'success', title: ok });
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const go = async (s: StepId) => {
    if (await save()) setStep(s);
  };
  const follow = async (kind: 'update' | 'all_clear') => {
    try {
      const r = await post<{ id: string }>('/warnings', { kind, parentId: id });
      nav(`/warnungen/${r.id}`);
      setStep('vorgang');
    } catch (e) {
      toastError(e);
    }
  };

  const fields = d?.template.fields ?? [];
  const placeFields = useMemo(() => fields.filter((f) => PLACE_KEYS.has(f.key)), [fields]);
  const contentFields = useMemo(() => fields.filter((f) => !PLACE_KEYS.has(f.key)), [fields]);

  if (q.error) return <ErrorBox title="Vorgang konnte nicht geladen werden">{(q.error as Error)?.message}</ErrorBox>;
  if (q.isLoading || !v) return <SkeletonRows rows={6} />;
  if (!d) return <ErrorBox title="Vorgang konnte nicht geladen werden">Nicht gefunden.</ErrorBox>;
  const labels = d.template.level_labels;
  const decision = d.revision.level_decision;
  const idx = STEPS.findIndex((s) => s.id === step);
  const stepDone: Record<StepId, boolean> = {
    vorgang: true,
    stufe: allClear || !!decision,
    gebiet: placeFields.every((f) => !f.required || (v.data[f.key] ?? '') !== '') && v.responsibilityIds.length > 0,
    inhalt: contentFields.every((f) => !f.required || (v.data[f.key] ?? '') !== ''),
    pruefen: !!d.approval,
    versand: ['sent', 'acknowledged'].includes(d.state),
  };
  const actualRecipients = d.testMode.active ? [d.testMode.recipient].filter(Boolean) : d.recipients.intended;
  const openSendBlock = d.sends.find((s) => s.status === 'unknown' && !s.resolution);

  return (
    <div className="flex flex-col gap-5 pb-24 md:pb-0">
      <UnsavedChangesGuard when={dirty} text="Der Warnentwurf hat ungespeicherte Eingaben. Beim Verlassen gehen sie verloren." />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{d.warning.case_no}</span>
            <LevelBadge level={decision?.level} kind={d.warning.kind} />
          </span>
        }
        subtitle={
          <>
            {KIND[d.warning.kind]}
            {d.warning.parent_case_no && <> zu <span className="font-mono">{d.warning.parent_case_no}</span></>} · <Rev n={d.revision.number} /> · Vorlage „{d.template.name}“ <span className="font-mono">v{d.template.version}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={d.state} labels={WARN_STATE} />
            {can('warning.delete') && (
              <Button size="sm" variant="ghost" icon="Trash2" onClick={() => setDeleting(true)}>
                Löschen
              </Button>
            )}
          </div>
        }
      />
      {deleting && <DeleteWarningDialog id={id} caseNo={d.warning.case_no} onClose={() => setDeleting(false)} onDeleted={() => { setDirty(false); qc.invalidateQueries({ queryKey: ['warnings'] }); nav('/warnungen'); }} />}

      {/* Schrittleiste: auf dem Handy horizontal scrollbar */}
      <nav aria-label="Schritte" className="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto">
        <ol className="flex gap-2 min-w-max">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(s.id)}
                aria-current={s.id === step ? 'step' : undefined}
                className={cx('flex items-center gap-2 h-9 px-3 rounded-full border text-sm whitespace-nowrap', s.id === step ? 'bg-raised border-fg/40 text-fg font-semibold' : 'bg-card border-line text-fg font-medium hover:bg-raised')}
              >
                <span className={cx('w-5 h-5 rounded-full inline-flex items-center justify-center font-mono text-[11px]', s.id === step ? 'border border-primary text-primary' : stepDone[s.id] ? 'bg-ok-soft text-ok' : 'bg-raised')}>
                  {stepDone[s.id] && s.id !== step ? <Icon name="Check" size={12} /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {d.template.newer_version && <Notice>Es gibt eine neuere Vorlagenversion (v{d.template.newer_version}). Dieser Vorgang bleibt reproduzierbar bei v{d.template.version}.</Notice>}
      {d.lastDecision?.decision === 'rejected' && d.state === 'rejected' && (
        <Notice tone="error" title={`Zurückgewiesen von ${d.lastDecision.decided_by_name}`}>
          {d.lastDecision.note}
        </Notice>
      )}

      {step === 'vorgang' && (
        <Card title="Vorgang">
          <div className="flex flex-col gap-4">
            <KeyValue
              items={[
                ['Vorgangs-ID', <span className="font-mono">{d.warning.case_no}</span>],
                ['Art', KIND[d.warning.kind]],
                ['Bezug', d.warning.parent_id ? <Link to={`/warnungen/${d.warning.parent_id}`}>{d.warning.parent_case_no}</Link> : '–'],
                ['Bisherige Warnstufe', d.previousLevel ? `${labels[String(d.previousLevel.level)] ?? d.previousLevel.level} (Vorgang ${d.previousLevel.case_no})` : '–'],
                ['Status', WARN_STATE[d.state] ?? d.state],
              ]}
            />
            {d.previousLevel && !allClear && <Notice tone="warning">Die bisherige Stufe wird nicht übernommen – sie muss für diese Aktualisierung erneut bestätigt werden.</Notice>}
            {allClear && <Notice tone="success">Entwarnung ist ein eigener Vorgang ohne Warnstufe.</Notice>}
            {d.template.note && <p className="text-meta text-fg-muted">{d.template.note}</p>}
            {d.followUps.length > 0 && (
              <div className="text-sm">
                Folgevorgänge:{' '}
                {d.followUps.map((f) => (
                  <Link key={f.id} to={`/warnungen/${f.id}`} className="mr-2 font-mono">
                    {f.case_no} ({KIND[f.kind]})
                  </Link>
                ))}
              </div>
            )}
            {can('warning.draft') && d.warning.kind !== 'all_clear' && (
              <div className="flex flex-wrap gap-2">
                <Button icon="RefreshCw" onClick={() => follow('update')}>
                  Aktualisierung anlegen
                </Button>
                <Button icon="CircleCheck" onClick={() => follow('all_clear')}>
                  Entwarnung anlegen
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 'stufe' && (
        <div className="flex flex-col gap-4">
          {allClear ? (
            <Notice tone="success" title="Keine Warnstufe">Eine Entwarnung hat keine Warnstufe und setzt die Stufe nicht auf 3.</Notice>
          ) : (
            <>
              <Card title="Feuerwehrstichwort" subtitle="Durchsuchbar nach Kürzel, Bezeichnung oder Alias. Kann aus einem Einsatz (FE2, Feuersoftware Connect) vorbelegt, manuell gewählt oder leer gelassen werden.">
                <div className="flex flex-col gap-3">
                  {v.keyword ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip mono>{v.keyword.code}</Chip>
                      <span>{v.keyword.label}</span>
                      {editable && (
                        <Button size="sm" icon="X" onClick={() => change({ keyword: null, answers: {} })}>
                          Ohne Stichwort
                        </Button>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-fg-muted">Kein Stichwort gewählt – es gibt dann keinen Vorschlag.</p>
                  )}
                  {editable && (
                    <>
                      <Input type="search" placeholder="Stichwort suchen, z. B. Kürzel oder Alias" value={kwSearch} onChange={(e) => setKwSearch(e.target.value)} aria-label="Stichwort suchen" />
                      {kwSearch && (
                        <ul className="flex flex-col border border-line rounded-node divide-y divide-line max-h-64 overflow-auto">
                          {(keywords.data ?? []).map((k) => (
                            <li key={k.id}>
                              <button type="button" className="w-full text-left px-3 py-2 hover:bg-raised flex items-center gap-2" onClick={() => (change({ keyword: k, answers: {} }), setKwSearch(''))}>
                                <strong>{k.code}</strong> <span className="flex-1">{k.label}</span>
                                <span className="text-meta text-fg-muted">{k.rule_count ? `${plural(k.rule_count, 'Regel', 'Regeln')}` : 'keine Regel'}</span>
                              </button>
                            </li>
                          ))}
                          {keywords.data?.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">Kein hinterlegtes Stichwort gefunden.</li>}
                        </ul>
                      )}
                      {(fe2.data?.length ?? 0) > 0 && (
                        <details>
                          <summary className="cursor-pointer text-sm">Aus Einsatz übernehmen (FE2, Feuersoftware Connect)</summary>
                          <ul className="mt-2 flex flex-col gap-1">
                            {fe2.data!.map((e) => (
                              <li key={e.id}>
                                <button
                                  type="button"
                                  className="text-sm underline"
                                  onClick={async () => {
                                    // Abgleich über das Stichwortverzeichnis: Schreibweise egal, „F2 W“ gehört zu „F 2“ (#195)
                                    const code = resolveKeyword(e.keyword, kwAll.data?.entries ?? [])?.entry.code ?? e.keyword ?? '';
                                    const found = await get<Keyword[]>(`/warning-keywords?q=${encodeURIComponent(code)}`);
                                    const exact = found.find((k) => k.code.toLowerCase() === String(code).toLowerCase() || k.aliases?.some((a) => a.toLowerCase() === String(code).toLowerCase()));
                                    if (exact) change({ keyword: exact, answers: {} });
                                    else toast({ tone: 'warning', title: 'Stichwort nicht hinterlegt', text: `„${e.keyword}“ ist lokal nicht gepflegt.` });
                                  }}
                                >
                                  {e.keyword} – {e.title} ({fmtDateTime(e.received_at)})
                                </button>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </div>
              </Card>

              {v.keyword && (
                <Card title="Lagefragen" subtitle="Nur fachlich freigegebene Fragen werden angezeigt.">
                  <div className="flex flex-col gap-4">
                    {(questions.data ?? []).length === 0 && <p className="text-sm text-fg-muted">Für dieses Stichwort sind keine freigegebenen Fragen hinterlegt.</p>}
                    {(questions.data ?? []).map((qq) => (
                      <fieldset key={qq.id} className="flex flex-col gap-2">
                        <legend className="font-medium mb-1">{qq.text}</legend>
                        <div className="flex flex-wrap gap-2">
                          {qq.options.map((o) => {
                            const sel = (v.answers[qq.key] ?? '') === o;
                            return (
                              <button
                                key={o}
                                type="button"
                                disabled={!editable}
                                aria-pressed={sel}
                                onClick={() => change({ answers: { ...v.answers, [qq.key]: o } })}
                                className={cx('min-w-[72px] h-11 px-4 rounded-control border font-medium inline-flex items-center justify-center gap-1.5', sel ? 'bg-primary-soft border-primary text-fg shadow-selected' : 'bg-card border-line hover:bg-raised')}
                              >
                                {sel && <Icon name="Check" size={14} />}
                                {o}
                              </button>
                            );
                          })}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                </Card>
              )}

              <SuggestionBox s={suggestion ?? { level: null, status: 'no_keyword', reason: 'Keine eindeutige Empfehlung – fachlich prüfen: kein Stichwort angegeben.', rules: [], missing: [] }} labels={labels} />

              <Card title="Warnstufe bestätigen" subtitle="Ausdrückliche Entscheidung einer berechtigten Person. Eine Abweichung vom Vorschlag braucht eine Begründung.">
                <div className="flex flex-col gap-4">
                  {decision ? (
                    <Notice tone="success" icon="ShieldCheck" title={`Bestätigt: ${labels[String(decision.level)] ?? decision.level}`}>
                      <p className="text-sm">
                        {decision.byName}, {fmtDateTime(decision.at)}
                        {decision.changed ? ` · abweichend vom Vorschlag (${decision.suggested ? `Stufe ${decision.suggested}` : 'kein Vorschlag'}): ${decision.reason}` : ' · entspricht dem Vorschlag'}
                      </p>
                      {decision.rules?.length > 0 && <p className="text-meta mt-1">Regeln: {decision.rules.map((r: any) => `${r.name} v${r.version}`).join(', ')}</p>}
                    </Notice>
                  ) : (
                    <Notice tone="warning">Noch nicht bestätigt. Ohne Bestätigung kann der Entwurf nicht eingereicht werden.</Notice>
                  )}
                  {can('warning.level') && editable && (
                    <>
                      {dirty && <p className="text-sm text-warn">Bitte zuerst speichern – bestätigt wird immer eine gespeicherte Fassung.</p>}
                      <div role="radiogroup" aria-label="Warnstufe" className="grid gap-2 sm:grid-cols-3">
                        {[1, 2, 3].map((l) => (
                          <button
                            key={l}
                            type="button"
                            role="radio"
                            aria-checked={level === l}
                            onClick={() => setLevel(l)}
                            className={cx('text-left p-3 rounded-node border-2 min-h-[64px]', level === l ? 'border-primary bg-primary-soft' : 'border-line bg-card hover:bg-raised')}
                          >
                            <div className="font-semibold">{labels[String(l)] ?? `Warnstufe ${l}`}</div>
                            {suggestion?.level === l && <div className="text-meta text-fg-link">entspricht dem Vorschlag</div>}
                          </button>
                        ))}
                      </div>
                      {level != null && level !== suggestion?.level && (
                        <FieldWrap label="Begründung der Abweichung" required htmlFor="lvl-reason" help={suggestion?.level ? 'Warum wird vom Vorschlag abgewichen?' : 'Es gibt keinen eindeutigen Vorschlag – bitte fachlich begründen.'}>
                          <Textarea id="lvl-reason" rows={2} value={levelReason} onChange={(e) => setLevelReason(e.target.value)} maxLength={500} />
                        </FieldWrap>
                      )}
                      <div>
                        <Button
                          variant="primary"
                          icon="ShieldCheck"
                          disabled={busy || dirty || level == null || (level !== suggestion?.level && levelReason.trim().length < 5)}
                          onClick={() => act(() => post(`/warnings/${id}/level`, { revision: d.revision.number, level, reason: levelReason.trim() }), 'Warnstufe bestätigt').then(() => (setLevel(null), setLevelReason('')))}
                        >
                          {level != null && level !== suggestion?.level ? 'Abweichende Stufe bestätigen' : 'Stufe bestätigen'}
                        </Button>
                      </div>
                    </>
                  )}
                  {!can('warning.level') && <p className="text-meta text-fg-muted">Die Bestätigung erfolgt durch eine Person mit dem Recht „Warnstufe bestätigen“.</p>}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {step === 'gebiet' && (
        <Card title="Gebiet, Zeitraum und Zuständigkeit">
          <div className="flex flex-col gap-4">
            {placeFields.map((f) => (
              <TemplateField key={f.key} f={f} value={v.data[f.key]} disabled={!editable} onChange={(x) => change({ data: { ...v.data, [f.key]: x } })} />
            ))}
            {v.data.starts_at && v.data.valid_until && new Date(v.data.valid_until) <= new Date(v.data.starts_at) && (
              <Notice tone="error">„Gültig bis“ liegt vor dem Beginn. Bitte den Zeitraum korrigieren – so lässt sich der Entwurf nicht einreichen.</Notice>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium mb-1">Zuständige Stellen *</legend>
              {(resp.data ?? []).length === 0 && <p className="text-sm text-fg-muted">Noch keine Zuständigkeit gepflegt (Einrichtung → Stichwörter &amp; Regeln).</p>}
              {(resp.data ?? []).map((r) => (
                <label key={r.id} className="flex items-start gap-2 p-2 rounded-control border border-line">
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={!editable}
                    checked={v.responsibilityIds.includes(r.id)}
                    onChange={(e) => change({ responsibilityIds: e.target.checked ? [...v.responsibilityIds, r.id] : v.responsibilityIds.filter((x) => x !== r.id) })}
                  />
                  <span>
                    <span className="font-medium">{r.name}</span>
                    {r.area && <span className="text-fg-muted"> · {r.area}</span>}
                    <span className="block text-meta text-fg-muted">{r.recipients.join(', ')}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </Card>
      )}

      {step === 'inhalt' && (
        <Card title="Inhalt">
          <div className="flex flex-col gap-4">
            {contentFields.map((f) => (
              <TemplateField key={f.key} f={f} value={v.data[f.key]} disabled={!editable} onChange={(x) => change({ data: { ...v.data, [f.key]: x } })} />
            ))}
          </div>
        </Card>
      )}

      {step === 'pruefen' && (
        <div className="flex flex-col gap-4">
          <Card title="Prüfen">
            <div className="flex flex-col gap-3">
              {d.missing.length > 0 && <Notice tone="warning" title="Noch nicht vollständig">{d.missing.join(', ')}</Notice>}
              {!allClear && !decision && <Notice tone="warning">Die Warnstufe ist noch nicht bestätigt.</Notice>}
              {!d.revision.responsibility_ids.length && <Notice tone="warning">Keine Zuständigkeit gewählt.</Notice>}
              <KeyValue
                items={[
                  ['Warnstufe', allClear ? 'Entwarnung (keine Stufe)' : decision ? (labels[String(decision.level)] ?? decision.level) : 'nicht bestätigt'],
                  ['Stichwort', d.revision.keyword ? `${d.revision.keyword.code} – ${d.revision.keyword.label}` : '–'],
                  ['Empfänger', d.recipients.intended.join(', ') || '–'],
                  ['Prüfsumme der Fassung', <span className="font-mono text-meta break-all">{d.revision.content_hash.slice(0, 16)}…</span>],
                ]}
              />
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex items-center gap-2 h-9 px-3 rounded-control border border-line bg-card !text-fg font-medium" href={`/api/v1/warnings/${id}/pdf`} target="_blank" rel="noreferrer">
                  <Icon name="FileText" size={15} /> PDF-Vorschau (Entwurf)
                </a>
                {d.approval && (
                  <a className="inline-flex items-center gap-2 h-9 px-3 rounded-control border border-line bg-card !text-fg font-medium" href={`/api/v1/warnings/${id}/approvals/${d.approval.id}/pdf`} target="_blank" rel="noreferrer">
                    <Icon name="ShieldCheck" size={15} className="text-ok" /> Freigegebene PDF
                  </a>
                )}
              </div>
              {d.state === 'draft' || d.state === 'rejected' ? (
                can('warning.draft') && (
                  <div>
                    <Button variant="primary" icon="Send" disabled={busy || dirty} onClick={() => act(() => post(`/warnings/${id}/submit`, { revision: d.revision.number }), 'Zur Freigabe eingereicht')}>
                      Zur Freigabe einreichen
                    </Button>
                  </div>
                )
              ) : null}
            </div>
          </Card>
          {d.state === 'in_review' && can('warning.approve') && (
            <Card title="Freigabe" subtitle="Freigegeben wird genau diese Fassung. Die PDF wird dabei erzeugt und mit Prüfsumme gespeichert.">
              <div className="flex flex-col gap-3">
                <FieldWrap label="Notiz (bei Zurückweisung Pflicht)" htmlFor="rej-note">
                  <Textarea id="rej-note" rows={2} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} maxLength={500} />
                </FieldWrap>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon="Check" disabled={busy} onClick={() => act(() => post(`/warnings/${id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved', note: rejectNote }), 'Freigegeben – PDF erzeugt')}>
                    PDF-Fassung freigeben
                  </Button>
                  <Button variant="danger" icon="X" disabled={busy || rejectNote.trim().length < 3} onClick={() => act(() => post(`/warnings/${id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'rejected', note: rejectNote }), 'Zurückgewiesen')}>
                    Zurückweisen
                  </Button>
                </div>
              </div>
            </Card>
          )}
          {d.approval && (
            <Notice tone="success" icon="ShieldCheck" title={`Freigegeben von ${d.approval.decided_by_name}`}>
              {fmtDateTime(d.approval.decided_at)} · PDF-Prüfsumme <span className="font-mono">{d.approval.pdf_sha256.slice(0, 16)}…</span>
            </Notice>
          )}
        </div>
      )}

      {step === 'versand' && (
        <div className="flex flex-col gap-4">
          {d.testMode.active && (
            <Notice tone="warning" icon="FlaskConical" title="Testmodus aktiv">
              Versand geht ausschließlich an das Testpostfach {d.testMode.recipient || '(nicht hinterlegt)'}. Vorgesehene Empfänger werden nur im Mailtext genannt.
            </Notice>
          )}
          {!d.approval ? (
            <Notice>Versendet werden kann nur eine freigegebene PDF-Fassung.</Notice>
          ) : (
            can('warning.send') &&
            !['sent', 'acknowledged', 'sending', 'send_unknown'].includes(d.state) && (
              <Card title="Versand an die zuständige Stelle">
                <div className="flex flex-col gap-3">
                  <KeyValue
                    items={[
                      ['Empfänger', <strong>{actualRecipients.join(', ') || '–'}</strong>],
                      ['Vorgesehen', d.recipients.intended.join(', ')],
                      ['Anhang', `${d.warning.case_no}.pdf (Prüfsumme ${d.approval.pdf_sha256.slice(0, 12)}…)`],
                    ]}
                  />
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} />
                    <span>Empfänger und PDF geprüft. Die Mail geht an die oben genannten Adressen.</span>
                  </label>
                  <div>
                    <Button variant="primary" icon="Send" disabled={busy || !confirmSend || !actualRecipients.length} onClick={() => act(() => post(`/warnings/${id}/send`, { approvalId: d.approval!.id, confirmRecipients: actualRecipients }), 'Versand angestoßen').then(() => setConfirmSend(false))}>
                      Jetzt versenden
                    </Button>
                  </div>
                </div>
              </Card>
            )
          )}
          {openSendBlock && can('warning.send') && (
            <Card title="Versandergebnis unbekannt – bitte prüfen">
              <div className="flex flex-col gap-3">
                <p className="text-sm">Die Verbindung brach nach dem Senden ab. Die Mail kann angekommen sein. Bitte bei der zuständigen Stelle nachfragen – erst danach ist ein erneuter Versand möglich.</p>
                <FieldWrap label="Notiz (z. B. Rückfrage bei …)" required htmlFor="res-note">
                  <Input id="res-note" value={note} onChange={(e) => setNote(e.target.value)} />
                </FieldWrap>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={note.trim().length < 3} onClick={() => act(() => post(`/warning-sends/${openSendBlock.id}/resolve`, { outcome: 'delivered', note }), 'Als angekommen vermerkt').then(() => setNote(''))}>
                    Ist angekommen
                  </Button>
                  <Button variant="danger" disabled={note.trim().length < 3} onClick={() => act(() => post(`/warning-sends/${openSendBlock.id}/resolve`, { outcome: 'not_delivered', note }), 'Als nicht angekommen vermerkt').then(() => setNote(''))}>
                    Ist nicht angekommen
                  </Button>
                </div>
              </div>
            </Card>
          )}
          <Card title="Versandverlauf">
            {d.sends.length === 0 ? (
              <p className="text-sm text-fg-muted">Noch nicht versendet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {d.sends.map((s) => (
                  <li key={s.id} className="py-3 flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={s.status} />
                      {s.test_mode && <Badge tone="warning">Test</Badge>}
                      {s.resolution && <Badge tone={s.resolution === 'delivered' ? 'success' : 'neutral'}>{s.resolution === 'delivered' ? 'geprüft: angekommen' : 'geprüft: nicht angekommen'}</Badge>}
                      {s.acknowledged_at && <Badge tone="success">Eingang bestätigt</Badge>}
                      <span className="text-meta text-fg-muted ml-auto"><Rev n={s.revision_number} /> · <span className="font-mono">{fmtDateTime(s.created_at)}</span></span>
                    </div>
                    <div className="text-sm">An: {s.recipients.join(', ')}</div>
                    {s.smtp_response && <div className="text-meta text-fg-muted font-mono break-all">{s.smtp_response}</div>}
                    {s.error && <div className="text-sm text-err">{s.error}</div>}
                    {s.ack_note && <div className="text-meta">Notiz: {s.ack_note}</div>}
                    {(s.status === 'accepted' || s.resolution === 'delivered') && !s.acknowledged_at && (can('warning.send') || can('warning.approve')) && (
                      <div className="flex flex-wrap gap-2 items-end mt-1">
                        <Input aria-label="Notiz zur Eingangsbestätigung" placeholder="z. B. telefonisch bestätigt durch …" value={note} onChange={(e) => setNote(e.target.value)} className="max-w-sm" />
                        <Button size="sm" icon="MailCheck" disabled={note.trim().length < 3} onClick={() => act(() => post(`/warning-sends/${s.id}/acknowledge`, { note }), 'Eingang bestätigt').then(() => setNote(''))}>
                          Eingang bestätigen
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Verlauf">
            <ul className="flex flex-col gap-1 text-sm">
              {d.approvals.map((a) => (
                <li key={a.id}>
                  <span className="font-mono">{fmtDateTime(a.decided_at)}</span> – <Rev n={a.revision_number} /> {a.decision === 'approved' ? 'freigegeben' : 'zurückgewiesen'} von {a.decided_by_name}
                  {a.note ? `: ${a.note}` : ''}
                </li>
              ))}
              {d.revisions.map((r) => (
                <li key={r.number} className="text-fg-muted">
                  <span className="font-mono">{fmtDateTime(r.created_at)}</span> – <Rev n={r.number} /> von {r.created_by_name ?? '–'}
                  {r.level ? ` (Stufe ${r.level})` : ''}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* Fußleiste: auf dem Handy fest unten */}
      <div className="fixed md:static bottom-[var(--bc-bottom-bar)] inset-x-0 z-30 bg-card md:bg-transparent border-t md:border-0 border-line px-4 py-3 md:p-0 flex items-center gap-2">
        <Button icon="ArrowLeft" disabled={idx === 0} onClick={() => go(STEPS[Math.max(0, idx - 1)].id)}>
          Zurück
        </Button>
        {editable && (
          <Button icon="Save" disabled={!dirty || busy} loading={busy && dirty} onClick={save}>
            {dirty ? 'Speichern' : 'Gespeichert'}
          </Button>
        )}
        <span className="flex-1" />
        {idx < STEPS.length - 1 && (
          <Button variant="primary" iconRight="ArrowRight" onClick={() => go(STEPS[idx + 1].id)}>
            Weiter
          </Button>
        )}
      </div>
    </div>
  );
}
