import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, cx, FieldWrap, Input, Notice, Select, Spinner, Switch, EmptyLine } from '../../components/ui/core';
import { CopyButton, Dialog, OneTimeSecret, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { FormProblems, useFormCheck } from '../../components/ui/form';
import { HelpTip } from '../../components/ui/HelpTip';
import { Icon } from '../../components/ui/Icon';
import { fmtDateTime, fmtRelative, plural } from '../../lib/format';
import type { CalendarCategory } from './model';

/**
 * iCal (#202): externe Kalender einlesen (Quellen mit Verbindungstest und Empfangsprotokoll) und den Kalender als
 * persönliches Abo anbieten.
 */

interface Source {
  id: string;
  name: string;
  host: string;
  categoryId: string | null;
  categoryName: string | null;
  intervalMin: number;
  active: boolean;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  eventCount: number;
}

interface TestResult {
  name: string | null;
  events: number;
  recurring: number;
  sample: { title: string; start: string; allDay: boolean; recurring: boolean }[];
  warnings: string[];
}

const INTERVALS = [
  { value: 15, label: 'alle 15 Minuten' },
  { value: 30, label: 'alle 30 Minuten' },
  { value: 60, label: 'stündlich' },
  { value: 180, label: 'alle 3 Stunden' },
  { value: 720, label: 'alle 12 Stunden' },
  { value: 1440, label: 'täglich' },
];

function SourceForm({ source, categories, onDone, onCancel }: { source?: Source; categories: CalendarCategory[]; onDone: () => void; onCancel: () => void }) {
  const toastError = useErrorToast();
  const [name, setName] = useState(source?.name ?? '');
  const [url, setUrl] = useState('');
  const [categoryId, setCategoryId] = useState(source?.categoryId ?? '');
  const [intervalMin, setIntervalMin] = useState(source?.intervalMin ?? 60);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testedUrl, setTestedUrl] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      const r = await post<TestResult>('/calendar/sources/test', { url: url.trim() });
      setTest(r);
      setTestedUrl(url.trim());
      if (!name.trim() && r.name) setName(r.name);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const needsTest = !source || !!url.trim();
  const tested = !needsTest || (!!test && testedUrl === url.trim());
  const save = async () => {
    setBusy('save');
    try {
      const body = { name: name.trim(), categoryId: categoryId || null, intervalMin, ...(url.trim() ? { url: url.trim() } : {}) };
      if (source) await put(`/calendar/sources/${source.id}`, body);
      else await post('/calendar/sources', body);
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const check = useFormCheck({ 'src-name': !name.trim() && 'Bitte einen Namen angeben.' });
  return (
    <div className="flex flex-col gap-3 border border-line rounded-node p-3">
      <FieldWrap
        label={source ? 'Neue Adresse (optional)' : 'Adresse des Kalenders (iCal-Link)'}
        htmlFor="src-url"
        required={!source}
        help={source ? `Gespeichert für ${source.host} – die Adresse wird verschlüsselt gespeichert und nie angezeigt. Leer lassen, um sie zu behalten.` : 'https://… oder webcal://… – wird verschlüsselt gespeichert und danach nicht mehr angezeigt (kann einen geheimen Schlüssel enthalten).'}
        labelAction={
          <HelpTip title="iCal-Link finden" more="/hilfe/kalender#kalender-einlesen">
            Outlook: Kalender freigeben → „Kalender veröffentlichen“ → ICS-Link. Google: Einstellungen des Kalenders → „Privatadresse im iCal-Format“. Der Link endet meist auf .ics.
          </HelpTip>
        }
      >
        <Input id="src-url" type="password" autoComplete="off" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/calendar.ics" />
      </FieldWrap>
      {needsTest && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button icon="Plug" loading={busy === 'test'} disabled={url.trim().length < 8} onClick={runTest}>
            Verbindung testen
          </Button>
          {tested && test && (
            <Badge tone="success">
              Lesbar: {plural(test.events, 'Termin', 'Termine')}{test.recurring ? `, davon ${plural(test.recurring, 'Serie', 'Serien')}` : ''}
            </Badge>
          )}
        </div>
      )}
      {test && tested && (
        <div className="text-sm flex flex-col gap-1">
          {test.sample.length ? (
            <>
              <span className="text-meta text-fg-muted">Nächste Termine:</span>
              <ul className="m-0 pl-5">
                {test.sample.map((s, i) => (
                  <li key={i}>
                    <span className="font-mono text-[12px] text-fg-muted">{s.allDay ? fmtDateTime(s.start).slice(0, 10) : fmtDateTime(s.start)}</span> {s.title}
                    {s.recurring && ' (Serie)'}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-fg-muted">Keine kommenden Termine gefunden.</span>
          )}
          {test.warnings.length > 0 && (
            <Notice tone="warning" title="Hinweise">
              <ul className="m-0 pl-5">
                {test.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FieldWrap label="Name" htmlFor="src-name" required error={check.error('src-name')}>
          <Input id="src-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Wehr-Kalender" />
        </FieldWrap>
        <FieldWrap label="Kategorie" htmlFor="src-cat" help="Gilt für alle Termine der Quelle.">
          <Select id="src-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Ohne Kategorie</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Abruf" htmlFor="src-int">
          <Select id="src-int" value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))}>
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </Select>
        </FieldWrap>
      </div>
      <FormProblems check={check} />
      <div className="flex justify-end flex-wrap gap-2">
        {!tested && <span id="src-why" className="mr-auto self-center text-meta text-fg-muted">Erst die Verbindung testen – gespeichert wird nur eine Adresse, die geantwortet hat.</span>}
        <Button variant="ghost" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button variant="primary" loading={busy === 'save'} disabled={!tested} aria-describedby={!tested ? 'src-why' : undefined} onClick={() => check.submit(save)}>
          {source ? 'Speichern' : 'Kalender hinzufügen'}
        </Button>
      </div>
    </div>
  );
}

function SourceLog({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['calendar', 'source-log', id], queryFn: () => get<any[]>(`/calendar/sources/${id}/log`) });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="m-0 text-meta text-fg-muted">Noch keine Abrufe.</p>;
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1 max-h-[260px] overflow-y-auto" aria-label="Empfangsprotokoll">
      {q.data.map((l) => (
        <li key={l.id} className="text-[12.5px] flex gap-2 items-start">
          <span className="font-mono text-fg-muted shrink-0">{fmtDateTime(l.at)}</span>
          {l.ok ? <Badge tone="success">ok</Badge> : <Badge tone="error">Fehler</Badge>}
          <span>
            {l.ok ? (l.not_modified ? 'unverändert' : `${plural(l.events, 'Termin', 'Termine')}: +${l.added} neu, ${l.changed} geändert, ${l.removed} entfernt`) : l.message}
            {l.trigger !== 'schedule' && <span className="text-fg-muted"> · {l.trigger === 'manual' ? 'von Hand' : 'beim Anlegen'}</span>}
            {l.ok && l.warnings?.length > 0 && <span className="text-warn"> · {plural(l.warnings.length, 'Hinweis', 'Hinweise')}: {l.warnings[0]}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SourcesDialog({ categories, onClose }: { categories: CalendarCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['calendar', 'sources'], queryFn: () => get<Source[]>('/calendar/sources') });
  const [form, setForm] = useState<'new' | string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['calendar'] });
  const fetchNow = async (s: Source) => {
    setBusy(s.id);
    try {
      const r = await post<any>(`/calendar/sources/${s.id}/refresh`);
      toast({ tone: 'success', title: `„${s.name}“ abgerufen`, text: `${plural(r.events, 'Termin', 'Termine')}: +${r.added} neu, ${r.changed} geändert, ${r.removed} entfernt` });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const toggle = async (s: Source, active: boolean) => {
    try {
      await put(`/calendar/sources/${s.id}`, { name: s.name, categoryId: s.categoryId, intervalMin: s.intervalMin, active });
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (s: Source) => {
    if (!(await confirm({ title: `„${s.name}“ entfernen?`, text: `Die ${s.eventCount} eingelesenen Termine verschwinden aus dem Kalender. Der Ursprungskalender bleibt unverändert.`, confirmLabel: 'Entfernen' }))) return;
    try {
      await del(`/calendar/sources/${s.id}`);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Externe Kalender einlesen" width={760} footer={<Button onClick={onClose}>Fertig</Button>}>
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">Externe Kalender (Outlook, Google, Wehr-Kalender) werden regelmäßig abgerufen. Eingelesene Termine sind schreibgeschützt; Änderungen und gelöschte Termine der Quelle werden beim nächsten Abruf übernommen.</p>
        {!q.data ? (
          <Spinner />
        ) : !q.data.length && form !== 'new' ? (
          <EmptyLine>Noch kein externer Kalender eingelesen.</EmptyLine>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-3">
            {q.data.map((s) => (
              <li key={s.id} className="border border-line rounded-node p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium flex items-center gap-2">
                      {s.name}
                      {s.active ? s.lastError ? <Badge tone="error">Fehler</Badge> : <Badge tone="success">aktiv</Badge> : <Badge>pausiert</Badge>}
                    </span>
                    <span className="text-meta text-fg-muted">
                      <Icon name="Lock" size={12} className="inline -mt-0.5" /> {s.host} · {plural(s.eventCount, 'Termin', 'Termine')} · {s.categoryName ?? 'ohne Kategorie'} · {INTERVALS.find((i) => i.value === s.intervalMin)?.label ?? `alle ${s.intervalMin} Min.`} · zuletzt erfolgreich {s.lastSuccessAt ? fmtRelative(s.lastSuccessAt) : '–'}
                    </span>
                    {s.lastError && <span className="text-meta text-err flex items-center gap-1"><Icon name="AlertTriangle" size={12} /> {s.lastError}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Switch checked={s.active} onChange={(v) => toggle(s, v)} label={s.active ? 'Aktiv' : 'Pausiert'} />
                    <Button size="sm" icon="RefreshCw" loading={busy === s.id} onClick={() => fetchNow(s)}>
                      Jetzt abrufen
                    </Button>
                    <Button size="sm" icon="ScrollText" aria-expanded={log === s.id} onClick={() => setLog(log === s.id ? null : s.id)}>
                      Protokoll
                    </Button>
                    <Button size="sm" icon="Pencil" iconOnly aria-label={`${s.name} bearbeiten`} onClick={() => setForm(s.id)} />
                    <Button size="sm" variant="ghost" icon="Trash2" iconOnly aria-label={`${s.name} entfernen`} onClick={() => remove(s)} />
                  </div>
                </div>
                {log === s.id && <SourceLog id={s.id} />}
                {form === s.id && (
                  <SourceForm
                    source={s}
                    categories={categories}
                    onCancel={() => setForm(null)}
                    onDone={() => {
                      setForm(null);
                      refresh();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {form === 'new' ? (
          <SourceForm
            categories={categories}
            onCancel={() => setForm(null)}
            onDone={() => {
              setForm(null);
              refresh();
            }}
          />
        ) : (
          <div>
            <Button icon="Plus" onClick={() => setForm('new')}>
              Kalender hinzufügen
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Abo */

interface Feed {
  active: boolean;
  categories: string[];
  includeDescription: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
}

export function SubscribeDialog({ categories, onClose }: { categories: CalendarCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['calendar', 'feed'], queryFn: () => get<Feed>('/calendar/feed') });
  const [url, setUrl] = useState<string | null>(null);
  const [cats, setCats] = useState<string[] | null>(null);
  const [desc, setDesc] = useState<boolean | null>(null);
  const curCats = cats ?? q.data?.categories ?? [];
  const curDesc = desc ?? q.data?.includeDescription ?? false;
  const reload = () => qc.invalidateQueries({ queryKey: ['calendar', 'feed'] });
  const create = async () => {
    if (q.data?.active && !(await confirm({ title: 'Link erneuern?', text: 'Der bisherige Link funktioniert danach nicht mehr. Abos in Outlook, Google oder auf dem iPhone müssen mit dem neuen Link neu eingerichtet werden.', confirmLabel: 'Erneuern' }))) return;
    try {
      const r = await post<{ url: string }>('/calendar/feed', { categories: curCats, includeDescription: curDesc });
      setUrl(r.url);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const saveSettings = async (c: string[], d: boolean) => {
    setCats(c);
    setDesc(d);
    if (!q.data?.active) return;
    try {
      await put('/calendar/feed', { categories: c, includeDescription: d });
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const revoke = async () => {
    if (!(await confirm({ title: 'Abo-Link widerrufen?', text: 'Abonnierte Kalender erhalten danach keine Termine mehr.', confirmLabel: 'Widerrufen' }))) return;
    try {
      await del('/calendar/feed');
      setUrl(null);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const webcal = url?.replace(/^https?:\/\//, 'webcal://');
  return (
    <Dialog open onClose={onClose} title="Kalender abonnieren" width={620} footer={<Button onClick={onClose}>Fertig</Button>}>
      {!q.data ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm text-fg-muted">
            Ein persönlicher, geheimer Link zum Abonnieren in Outlook, Google Kalender oder auf dem iPhone. Das Abo enthält nur <strong>Titel, Zeit und Kategorie</strong> der Termine (eigene und eingelesene) – keine Beiträge, keine Presseanfragen. Wer den Link kennt, sieht diese Termine; bei Verdacht den Link erneuern.
          </p>
          {url ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Dein Abo-Link</span>
              <OneTimeSecret value={url} label="Abo-Link" />
              {webcal && (
                <div className="flex gap-2 items-center flex-wrap text-meta text-fg-muted">
                  Für iPhone/Mac: <CopyButton size="sm" value={webcal} label="webcal-Link kopieren" />
                </div>
              )}
            </div>
          ) : q.data.active ? (
            <Notice icon="Lock" title="Abo-Link aktiv">
              Erstellt {fmtDateTime(q.data.createdAt)} · zuletzt abgerufen {q.data.lastUsedAt ? fmtRelative(q.data.lastUsedAt) : 'noch nie'}. Der Link wird aus Sicherheitsgründen nicht erneut angezeigt – bei Bedarf erneuern.
            </Notice>
          ) : null}
          <fieldset className="border border-line rounded-node p-3 m-0 flex flex-col gap-2">
            <legend className="px-1 text-sm font-medium">Kategorien im Abo</legend>
            <div role="group" aria-label="Kategorien im Abo" className="flex flex-wrap gap-1.5">
              {categories.map((c) => {
                const on = curCats.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => saveSettings(on ? curCats.filter((x) => x !== c.id) : [...curCats, c.id], curDesc)} className={cx('h-8 px-2.5 rounded-full border text-sm inline-flex items-center gap-1.5', on ? 'bg-raised border-fg text-fg' : 'border-line text-fg-muted hover:text-fg')}>
                    <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full" style={{ background: `var(--bc-cal-${c.color})` }} />
                    {c.name}
                  </button>
                );
              })}
            </div>
            <p className="m-0 text-meta text-fg-muted">{curCats.length ? `${plural(curCats.length, 'Kategorie', 'Kategorien')} gewählt.` : 'Keine Auswahl = alle Termine (auch ohne Kategorie).'}</p>
            <Switch checked={curDesc} onChange={(v) => saveSettings(curCats, v)} label="Beschreibung und Ort mitsenden" description="Nur einschalten, wenn die Beschreibungen nichts Vertrauliches enthalten." />
          </fieldset>
          <div className="flex gap-2 flex-wrap justify-end">
            {q.data.active && (
              <Button variant="danger" icon="Ban" onClick={revoke}>
                Link widerrufen
              </Button>
            )}
            <Button variant="primary" icon={q.data.active ? 'RefreshCw' : 'Link2'} onClick={create}>
              {q.data.active ? 'Link erneuern' : 'Abo-Link erstellen'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
