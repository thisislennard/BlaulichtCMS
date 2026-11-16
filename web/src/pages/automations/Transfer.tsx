import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, download, post } from '../../api/client';
import { Button, ErrorBox, FieldWrap, Notice, Select, Textarea } from '../../components/ui/core';
import { CopyButton, Dialog, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import type { AutomationListItem } from './Automations';

/* Export und Import von Workflows (#196). Die Datei enthält nur Abläufe und für Ein-/Ausgänge Art und Name –
   keine Kennungen, keine Zugangsdaten. Importierte Workflows starten immer als Entwurf. */

/** Gleiche Grenze wie der Server (automations/transfer.ts). */
const MAX_BYTES = 1024 * 1024;

export function ExportDialog({ items, onClose }: { items: AutomationListItem[]; onClose: () => void }) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(items.map((a) => a.id)));
  const all = sel.size === items.length;
  const toggle = (id: string, on: boolean) => setSel((s) => {
    const n = new Set(s);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  });
  const tooMany = sel.size > 50;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Workflows exportieren"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            icon="Download"
            disabled={!sel.size || tooMany}
            onClick={() => {
              download(`/automations/export?ids=${[...sel].join(',')}`);
              onClose();
            }}
          >
            {sel.size === 1 ? '1 Workflow exportieren' : `${sel.size} Workflows exportieren`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-fg-muted">
          Die JSON-Datei enthält die Abläufe. Ein- und Ausgänge stehen darin nur mit Art und Name – ohne Einstellungen, Kennungen oder Zugangsdaten. Beim Import werden sie vorhandenen Ein- und Ausgängen zugeordnet.
        </p>
        <label className="flex items-center gap-2.5 text-sm font-medium cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={all} onChange={(e) => setSel(e.target.checked ? new Set(items.map((a) => a.id)) : new Set())} />
          Alle auswählen
        </label>
        <ul className="m-0 p-0 list-none flex flex-col gap-0.5 max-h-[45vh] overflow-y-auto border border-line rounded-node p-1.5">
          {items.map((a) => (
            <li key={a.id}>
              <label className="flex items-start gap-2.5 px-2 py-1.5 rounded-chip hover:bg-raised cursor-pointer text-sm">
                <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--bc-primary-solid)]" checked={sel.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} />
                <span className="min-w-0">
                  <span className="font-medium">{a.name}</span>
                  {a.description && <span className="block text-meta text-fg-muted line-clamp-1">{a.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {tooMany && <Notice tone="warning">Höchstens 50 Workflows je Datei – bitte weniger auswählen.</Notice>}
      </div>
    </Dialog>
  );
}

interface RefRow {
  ref: string;
  kind: string;
  kindLabel: string;
  name: string;
  candidates: { id: string; name: string }[];
  suggested: string | null;
}
interface Preview {
  schemaVersion: number;
  appVersion: string | null;
  exportedAt: string | null;
  automations: { name: string; finalName: string; description: string; nodes: number; edges: number; steps: { type: string; label: string; count: number }[] }[];
  inputs: RefRow[];
  outputs: RefRow[];
}

/** Prüfmeldung: Ort in der Datei als JSON-Pfad (z. B. automations[0].graph.nodes[1].data.op) und Text. */
interface Problem {
  path: string;
  message: string;
}
interface FileProblem {
  title: string;
  lines: Problem[];
  hint?: string;
}

function fileError(e: unknown): FileProblem {
  if (e instanceof ApiError) {
    const problems = (e.details?.problems ?? []) as Problem[];
    return { title: e.message, lines: problems.map((p) => ({ path: String(p.path ?? ''), message: String(p.message ?? '') })) };
  }
  return { title: (e as Error)?.message ?? String(e), lines: [] };
}

/**
 * JSON aus Datei oder eingefügtem Text lesen. Ein umschließender Markdown-Codeblock, wie ihn KI-Antworten oft haben,
 * wird entfernt; bei Syntaxfehlern nennt die Meldung Zeile und Spalte.
 */
function parseJsonText(raw: string): { ok: true; value: unknown } | { ok: false; problem: FileProblem } {
  const text = raw.trim().replace(/^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/, '$1');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const pos = /position (\d+)/.exec(String((e as Error)?.message ?? ''));
    let where = '';
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      where = `Fehler in Zeile ${before.split('\n').length}, Spalte ${before.length - before.lastIndexOf('\n')}.`;
    }
    return { ok: false, problem: { title: 'Kein gültiges JSON.', lines: where ? [{ path: '', message: where }] : [], hint: 'Nur das JSON übernehmen – bei einer KI-Antwort ohne Erklärungen davor oder danach.' } };
  }
}

/** Meldungen als Text, z. B. zum Weitergeben an die KI, die die Datei erstellt hat. */
const problemText = (p: FileProblem) => [p.title, ...p.lines.map((l) => `- ${l.path ? `${l.path}: ` : ''}${l.message}`)].join('\n');

function MappingRows({ title, rows, value, onChange, kind }: { title: string; rows: RefRow[]; value: Record<string, string>; onChange: (ref: string, id: string) => void; kind: 'Eingang' | 'Ausgang' }) {
  const base = useId();
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{title}</h3>
      {rows.map((r) => (
        <FieldWrap
          key={r.ref}
          htmlFor={`${base}-${r.ref}`}
          label={
            <>
              {r.name} <span className="text-fg-muted font-normal">· {r.kindLabel}</span>
            </>
          }
          help={!r.candidates.length ? `Kein vorhandener ${kind} dieser Art – bleibt offen und kann später im Editor gewählt werden.` : r.suggested && value[r.ref] === r.suggested ? 'Gleichnamig vorhanden – vorgeschlagen.' : undefined}
        >
          <Select id={`${base}-${r.ref}`} value={value[r.ref] ?? ''} onChange={(e) => onChange(r.ref, e.target.value)} disabled={!r.candidates.length}>
            <option value="">Nicht zuordnen (später im Editor wählen)</option>
            {r.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
      ))}
    </div>
  );
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<FileProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const textId = useId();

  const tooBig = (bytes: number): FileProblem => ({ title: `Die Datei ist zu groß (${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB, höchstens 1 MB).`, lines: [] });

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    if (f.size > MAX_BYTES) {
      setPreview(null);
      return setError(tooBig(f.size));
    }
    await check(await f.text());
  };

  const check = async (raw: string) => {
    setError(null);
    setPreview(null);
    const bytes = new Blob([raw]).size;
    if (bytes > MAX_BYTES) return setError(tooBig(bytes));
    const r = parseJsonText(raw);
    if (!r.ok) return setError(r.problem);
    const parsed = r.value;
    setBusy(true);
    try {
      const p = await post<Preview>('/automations/import/preview', { file: parsed });
      setFile(parsed);
      setPreview(p);
      setInputs(Object.fromEntries(p.inputs.map((r) => [r.ref, r.suggested ?? ''])));
      setOutputs(Object.fromEntries(p.outputs.map((r) => [r.ref, r.suggested ?? ''])));
    } catch (e) {
      setError(fileError(e));
    } finally {
      setBusy(false);
    }
  };

  const open = preview ? [...preview.inputs.filter((r) => !inputs[r.ref]), ...preview.outputs.filter((r) => !outputs[r.ref])].length : 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v || null]));
      const r = await post<{ created: { id: string; name: string; open: number }[] }>('/automations/import', { file, mapping: { inputs: clean(inputs), outputs: clean(outputs) } });
      await qc.invalidateQueries({ queryKey: ['automations'] });
      toast({ tone: 'success', title: r.created.length === 1 ? 'Workflow importiert' : `${r.created.length} Workflows importiert`, text: 'Als Entwurf angelegt – vor dem Aktivieren prüfen und testen.' });
      if (r.created.length === 1) nav(`/workflows/${r.created[0].id}`);
      else onClose();
    } catch (e) {
      setError(fileError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title="Workflows importieren"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          {preview && (
            <Button variant="primary" icon="Upload" loading={busy} onClick={run}>
              {preview.automations.length === 1 ? 'Als Entwurf importieren' : `${preview.automations.length} als Entwürfe importieren`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Exportdatei wählen" onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
        <div className="flex items-center gap-3 flex-wrap">
          <Button icon="FileUp" loading={busy && !preview && !pasting} onClick={() => (setPasting(false), fileRef.current?.click())}>
            {fileName && !pasting ? 'Andere Datei wählen' : 'Datei wählen'}
          </Button>
          {!pasting && (
            <Button icon="Braces" onClick={() => (setPasting(true), setFileName(''))}>
              Als Text einfügen
            </Button>
          )}
          {!pasting && <span className="text-sm text-fg-muted break-all">{fileName || 'JSON-Datei aus „Exportieren“ oder von einer KI, höchstens 1 MB'}</span>}
        </div>
        {pasting && (
          <div className="flex flex-col gap-2">
            <FieldWrap label="Workflow-Datei als Text" htmlFor={textId} help="Den JSON-Text einfügen, z. B. die Antwort einer KI – ohne Erklärungen davor oder danach.">
              <Textarea
                id={textId}
                mono
                rows={8}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  // Geänderter Text: alte Vorschau gilt nicht mehr
                  if (preview) setPreview(null);
                }}
                placeholder='{ "format": "blaulichtcms.automations", … }'
                spellCheck={false}
              />
            </FieldWrap>
            <div>
              <Button icon="CheckCircle2" loading={busy && !preview} disabled={!text.trim()} onClick={() => check(text)}>
                Prüfen
              </Button>
            </div>
          </div>
        )}
        {error && (
          <ErrorBox title={error.title} actions={error.lines.length > 0 ? <CopyButton value={problemText(error)} size="sm" label="Meldungen kopieren" /> : undefined}>
            {error.lines.length > 0 && (
              <ul className="m-0 pl-4 flex flex-col gap-1">
                {error.lines.map((l, i) => (
                  <li key={i}>
                    {l.message}
                    {l.path && <span className="block font-mono text-meta break-all">{l.path}</span>}
                  </li>
                ))}
              </ul>
            )}
            {error.hint && <p className="m-0 mt-1">{error.hint}</p>}
          </ErrorBox>
        )}
        {preview && (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">Wird angelegt</h3>
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {preview.automations.map((a, i) => (
                  <li key={i} className="border border-line rounded-node p-3 flex items-start gap-2.5">
                    <Icon name="Workflow" size={16} className="text-fg-muted mt-0.5 shrink-0" />
                    <div className="min-w-0 flex flex-col gap-0.5">
                      <span className="font-medium text-sm">{a.finalName}</span>
                      {a.finalName !== a.name && <span className="text-meta text-fg-muted">Name „{a.name}“ ist schon vergeben.</span>}
                      <span className="text-meta text-fg-muted">{a.steps.length ? `${a.steps.map((s) => `${s.count}× ${s.label}`).join(' · ')} · ${a.edges} ${a.edges === 1 ? 'Verbindung' : 'Verbindungen'}` : 'Leerer Ablauf'}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {preview.appVersion && <p className="m-0 text-meta text-fg-muted">Exportiert mit BlaulichtCMS <span className="font-mono">{preview.appVersion}</span>.</p>}
            </div>
            <MappingRows title="Eingänge zuordnen" kind="Eingang" rows={preview.inputs} value={inputs} onChange={(ref, id) => setInputs((m) => ({ ...m, [ref]: id }))} />
            <MappingRows title="Ausgänge zuordnen" kind="Ausgang" rows={preview.outputs} value={outputs} onChange={(ref, id) => setOutputs((m) => ({ ...m, [ref]: id }))} />
            <Notice title="Importierte Workflows starten als Entwurf">
              Sie sind nicht aktiv, nicht getestet und haben keinen Direktversand. {open > 0 ? `${open} Bezug/Bezüge bleiben offen und müssen im Editor gewählt werden. ` : ''}Vor dem Aktivieren im Editor prüfen und testen.
            </Notice>
          </>
        )}
      </div>
    </Dialog>
  );
}
