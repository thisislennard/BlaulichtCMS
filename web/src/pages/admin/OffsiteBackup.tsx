import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, put } from '../../api/client';
import { Badge, Button, FieldWrap, Input, Notice, Select, Switch, Table, Td, Th } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { SecretField, useConfirm, useToast } from '../../components/ui/overlays';
import { HelpTip } from '../../components/ui/HelpTip';
import { fmtBytes, fmtDateTime, fmtDuration, fmtNumber, fmtRelative } from '../../lib/format';
import { FieldGrid, LoadError, SectionCard } from './shared';

interface OffsiteConfig {
  enabled: boolean;
  url: string;
  username: string;
  password_set: boolean;
  tls_fingerprint: string;
  keep_daily: number;
  keep_weekly: number;
  keep_monthly: number;
  drill_interval: 'off' | 'weekly' | 'monthly';
  tested_at: string | null;
  last_ok_at: string | null;
  last_ok_file: string | null;
  last_error: string | null;
  last_error_at: string | null;
}
interface TestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string }[];
  certificate?: { fingerprint256: string; subject: string; issuer: string; validTo: string; trusted: boolean; error: string | null } | null;
  files?: number;
  error?: string;
  hint?: string;
}
interface RemoteFile {
  name: string;
  size: number | null;
  modified: string | null;
}
interface Drill {
  id: string;
  source: 'local' | 'offsite';
  file_name: string;
  trigger: 'manual' | 'schedule';
  status: 'queued' | 'running' | 'ok' | 'failed';
  created_at: string;
  finished_at: string | null;
  error: string | null;
  created_by_name: string | null;
  result: {
    durationMs?: number;
    tables?: number;
    rows?: number;
    keyTables?: Record<string, number>;
    migration?: string | null;
    audit?: { ok: boolean; checked: number; keyAvailable: boolean; matchesLive: boolean | null };
    checks?: { step: string; ok: boolean; detail?: string }[];
  };
}

type Form = { enabled: boolean; url: string; username: string; password: string; fingerprint: string; keepDaily: string; keepWeekly: string; keepMonthly: string; drillInterval: OffsiteConfig['drill_interval'] };
const fromConfig = (c: OffsiteConfig): Form => ({ enabled: c.enabled, url: c.url, username: c.username, password: '', fingerprint: c.tls_fingerprint, keepDaily: String(c.keep_daily), keepWeekly: String(c.keep_weekly), keepMonthly: String(c.keep_monthly), drillInterval: c.drill_interval });

/** Ganze Zahl im Bereich, sonst null (Eingabe bleibt beim Tippen unverändert, geprüft wird beim Speichern). */
const intIn = (v: string, lo: number, hi: number) => (/^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null);

const DRILL_STATUS: Record<Drill['status'], { tone: 'success' | 'error' | 'primary' | 'neutral'; label: string }> = {
  queued: { tone: 'neutral', label: 'eingeplant' },
  running: { tone: 'primary', label: 'läuft' },
  ok: { tone: 'success', label: 'bestanden' },
  failed: { tone: 'error', label: 'fehlgeschlagen' },
};

function Steps({ steps }: { steps: { step: string; ok: boolean; detail?: string }[] }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          <Icon name={s.ok ? 'CheckCircle2' : 'XCircle'} size={15} className={s.ok ? 'text-ok mt-0.5 shrink-0' : 'text-err mt-0.5 shrink-0'} />
          <span>
            {s.step}
            {s.detail && <span className="text-fg-muted"> – {s.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Einstellungen → Sicherung außer Haus (#212): Ziel per WebDAV (z. B. NAS), Verbindungstest vor dem Einschalten,
 * Aufbewahrung auf dem Ziel, Sicherungen auf dem Ziel (zurückholen) und Probe-Wiederherstellung.
 */
export function OffsiteBackupSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const q = useQuery({ queryKey: ['backup-offsite'], queryFn: () => get<{ config: OffsiteConfig; pending: number }>('/backups/offsite') });
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingPassword, setEditingPassword] = useState(false);
  const c = q.data?.config;
  useEffect(() => {
    if (c && !form) setForm(fromConfig(c));
  }, [c, form]);

  if (q.isError) return <SectionCard id="sicherung-ausser-haus" title="Sicherung außer Haus"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!c || !form) return <SectionCard id="sicherung-ausser-haus" title="Sicherung außer Haus"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const dirty = JSON.stringify({ ...form, password: '' }) !== JSON.stringify(fromConfig(c)) || !!form.password;
  const target = { url: form.url.trim(), username: form.username.trim(), fingerprint: form.fingerprint.trim(), ...(form.password ? { password: form.password } : {}) };
  const keepInvalid = intIn(form.keepDaily, 1, 365) === null || intIn(form.keepWeekly, 0, 260) === null || intIn(form.keepMonthly, 0, 120) === null;
  const failedLater = c.last_error_at && (!c.last_ok_at || new Date(c.last_error_at) > new Date(c.last_ok_at));

  const runTest = async () => {
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      setTest(await post<TestResult>('/backups/offsite/test', target));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const r = await put<{ config: OffsiteConfig }>('/backups/offsite', { ...target, enabled: form.enabled, keepDaily: intIn(form.keepDaily, 1, 365), keepWeekly: intIn(form.keepWeekly, 0, 260), keepMonthly: intIn(form.keepMonthly, 0, 120), drillInterval: form.drillInterval });
      toast({ tone: 'success', title: 'Gespeichert', text: r.config.enabled ? 'Neue Sicherungen gehen ab jetzt zusätzlich außer Haus.' : undefined });
      setForm(fromConfig(r.config));
      setEditingPassword(false);
      qc.setQueryData(['backup-offsite'], (old: any) => (old ? { ...old, config: r.config } : old));
      qc.invalidateQueries({ queryKey: ['system-status'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'offsite_test_failed' && e.details?.test) setTest(e.details.test);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      id="sicherung-ausser-haus"
      title="Sicherung außer Haus"
      description="Jede Datenbanksicherung zusätzlich verschlüsselt auf ein Ziel außerhalb dieses Servers ablegen, z. B. ein NAS per WebDAV – mit Aufbewahrung auf dem Ziel und Probe-Wiederherstellung."
      action={c.enabled ? <Badge tone={failedLater ? 'error' : 'success'}>{failedLater ? 'Fehler' : 'eingeschaltet'}</Badge> : <Badge>aus</Badge>}
      bodyClassName="flex flex-col gap-5"
    >
      {c.enabled && (
        <div className="flex flex-col gap-2">
          {failedLater ? (
            <Notice tone="error" title={`Letzte Übertragung fehlgeschlagen (${fmtRelative(c.last_error_at)})`}>
              {c.last_error}
            </Notice>
          ) : c.last_ok_at ? (
            <p className="m-0 text-sm">
              <Icon name="CheckCircle2" size={15} className="text-ok inline -mt-0.5 mr-1" />
              Zuletzt erfolgreich übertragen und geprüft {fmtRelative(c.last_ok_at)} <span className="text-fg-muted">({c.last_ok_file})</span>
            </p>
          ) : (
            <p className="m-0 text-sm text-fg-muted">Noch keine Sicherung übertragen – die nächste Sicherung geht automatisch außer Haus.</p>
          )}
          {q.data!.pending > 0 && <p className="m-0 text-sm text-fg-muted">{q.data!.pending} Übertragung(en) laufen oder warten.</p>}
        </div>
      )}

      <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Nach jeder Sicherung außer Haus ablegen" description="Einschalten geht nur nach bestandenem Verbindungstest. Das Ziel ändern verlangt eine erneute Bestätigung mit deinem Passwort." />

      <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        <FieldWrap
          label="WebDAV-Adresse des Ordners"
          htmlFor="os-url"
          help="Nur https. Ein fehlender letzter Ordner wird beim Test angelegt."
          labelAction={
            <HelpTip title="Warum WebDAV und nicht SMB?" more="/hilfe/sicherung#sicherung-ausser-haus">
              <p className="m-0">WebDAV ist verschlüsseltes HTTPS und braucht auf dem Server kein Zusatzprogramm. Synology (Paket „WebDAV Server“, HTTPS-Port 5006), QNAP, Nextcloud und viele andere NAS bieten es an. Die Sicherungen sind bereits vor dem Hochladen verschlüsselt.</p>
            </HelpTip>
          }
        >
          <Input id="os-url" mono value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://nas.local:5006/sicherung/blaulichtcms/" maxLength={500} autoComplete="off" />
        </FieldWrap>
        <FieldWrap label="Benutzer am Ziel" htmlFor="os-user" help="Eigenes Konto nur für die Sicherung, mit Schreibrecht nur auf diesen Ordner.">
          <Input id="os-user" value={form.username} onChange={(e) => set({ username: e.target.value })} maxLength={200} autoComplete="off" />
        </FieldWrap>
        <SecretField
          id="os-pass"
          label="Passwort am Ziel"
          set={c.password_set && !editingPassword}
          editing={editingPassword || !c.password_set}
          value={form.password}
          onReplace={(v) => {
            setEditingPassword(true);
            set({ password: v });
          }}
          help="Wird verschlüsselt gespeichert und nie wieder angezeigt. Für ein anderes Ziel oder einen anderen Benutzer neu eingeben."
        />
        <FieldWrap
          label="Zertifikat-Fingerabdruck (optional)"
          htmlFor="os-fp"
          help="Nur für selbst signierte Zertifikate im eigenen Netz: SHA-256 des NAS-Zertifikats. Leer = normale Prüfung."
        >
          <Input id="os-fp" mono value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value })} placeholder="AB:CD:…" maxLength={200} autoComplete="off" />
        </FieldWrap>
      </FieldGrid>

      <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
        <legend className="text-sm font-medium mb-1">Aufbewahrung auf dem Ziel</legend>
        <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))]">
          <FieldWrap label="Tage (je Tag die neueste)" htmlFor="os-kd" error={intIn(form.keepDaily, 1, 365) === null ? '1 bis 365' : undefined}>
            <Input id="os-kd" type="number" min={1} max={365} value={form.keepDaily} invalid={intIn(form.keepDaily, 1, 365) === null} onChange={(e) => set({ keepDaily: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Wochen (je Woche die neueste)" htmlFor="os-kw" error={intIn(form.keepWeekly, 0, 260) === null ? '0 bis 260' : undefined}>
            <Input id="os-kw" type="number" min={0} max={260} value={form.keepWeekly} invalid={intIn(form.keepWeekly, 0, 260) === null} onChange={(e) => set({ keepWeekly: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Monate (je Monat die neueste)" htmlFor="os-km" error={intIn(form.keepMonthly, 0, 120) === null ? '0 bis 120' : undefined}>
            <Input id="os-km" type="number" min={0} max={120} value={form.keepMonthly} invalid={intIn(form.keepMonthly, 0, 120) === null} onChange={(e) => set({ keepMonthly: e.target.value })} />
          </FieldWrap>
        </FieldGrid>
        <p className="m-0 text-meta text-fg-muted">Ältere Sicherungen löscht BlaulichtCMS nach jeder Übertragung auf dem Ziel. Andere Dateien im Ordner bleiben unberührt. Gelöschte Daten leben in Sicherungen bis zum Ablauf dieser Fristen weiter (Datenschutz).</p>
      </fieldset>

      <FieldWrap label="Probe-Wiederherstellung nach Zeitplan" htmlFor="os-drill" help="Eine Stunde nach der Sicherungszeit; geprüft wird die neueste Kopie außer Haus, sonst die neueste lokale Sicherung.">
        <Select id="os-drill" value={form.drillInterval} onChange={(e) => set({ drillInterval: e.target.value as Form['drillInterval'] })}>
          <option value="weekly">wöchentlich</option>
          <option value="monthly">monatlich</option>
          <option value="off">aus (nur von Hand)</option>
        </Select>
      </FieldWrap>

      {error && <Notice tone="error">{error}</Notice>}
      {test && (
        <div className="flex flex-col gap-2 border border-line rounded-card p-4" role="status">
          <div className="flex items-center gap-2 font-medium">
            <Icon name={test.ok ? 'CheckCircle2' : 'XCircle'} size={16} className={test.ok ? 'text-ok' : 'text-err'} />
            {test.ok ? `Verbindungstest bestanden${test.files != null ? ` · ${test.files} Sicherung(en) auf dem Ziel` : ''}` : (test.error ?? 'Verbindungstest fehlgeschlagen')}
          </div>
          <Steps steps={test.steps} />
          {test.hint && <p className="m-0 text-sm text-fg-muted">{test.hint}</p>}
          {test.certificate && (!test.certificate.trusted || form.fingerprint) && (
            <div className="flex flex-col gap-1 text-sm bg-raised rounded-control p-3">
              <span className="font-medium">Zertifikat des Ziels</span>
              <span className="text-fg-muted">Ausgestellt für: {test.certificate.subject || '–'} · gültig bis {test.certificate.validTo || '–'}</span>
              <code className="break-all text-[12px]">{test.certificate.fingerprint256}</code>
              {test.certificate.fingerprint256 !== form.fingerprint && (
                <div>
                  <Button
                    size="sm"
                    icon="ShieldCheck"
                    onClick={async () => {
                      if (await ask({ title: 'Fingerabdruck übernehmen?', text: 'Nur übernehmen, wenn er mit dem Fingerabdruck übereinstimmt, den das NAS selbst anzeigt (z. B. Synology: Systemsteuerung → Sicherheit → Zertifikat). Sonst könnte ein fremdes Gerät die Sicherungen annehmen.', confirmLabel: 'Übernehmen', danger: false })) set({ fingerprint: test.certificate!.fingerprint256 });
                    }}
                  >
                    Fingerabdruck übernehmen
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button icon="Plug" loading={busy === 'test'} disabled={!form.url.trim() || !!busy} onClick={runTest}>
          Verbindung testen
        </Button>
        <Button variant="primary" icon="Save" loading={busy === 'save'} disabled={!dirty || !!busy || keepInvalid} onClick={save}>
          Speichern
        </Button>
      </div>

      {c.url && <RemoteFiles />}
      <DrillPanel offsite={c.enabled && !!c.last_ok_file} />
    </SectionCard>
  );
}

/** Sicherungen auf dem Ziel – bei Bedarf geladen; einzelne zurück auf den Server holen (Notfall). */
function RemoteFiles() {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['backup-offsite-files'], queryFn: () => get<{ files: RemoteFile[]; volumes: RemoteFile[] }>('/backups/offsite/files'), enabled: open });
  const fetchOne = async (name: string) => {
    if (!(await ask({ title: 'Sicherung auf den Server holen?', text: `${name} wird heruntergeladen, geprüft und erscheint dann oben in der Liste der Sicherungen. Von dort lässt sie sich herunterladen, als Probe einspielen oder im Notfall zurückspielen (Hilfe → Sicherung).`, confirmLabel: 'Holen', danger: false }))) return;
    setBusy(name);
    try {
      await post('/backups/offsite/fetch', { name });
      toast({ tone: 'success', title: 'Sicherung geholt und geprüft' });
      qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Holen fehlgeschlagen', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <details className="border border-line rounded-card" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Sicherungen auf dem Ziel</summary>
      <div className="px-4 pb-4 flex flex-col gap-3">
        {q.isLoading && <p className="m-0 text-sm text-fg-muted">Wird vom Ziel gelesen …</p>}
        {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}
        {q.data && (
          <>
            {q.data.files.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine Datenbanksicherung auf dem Ziel.</p>
            ) : (
              <div className="border border-line rounded-node overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Datenbanksicherung</Th>
                      <Th align="right">Größe</Th>
                      <Th className="w-28">
                        <span className="sr-only">Aktion</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.files.map((f) => (
                      <tr key={f.name}>
                        <Td mono className="max-w-[300px] truncate">{f.name}</Td>
                        <Td align="right" mono>{fmtBytes(f.size)}</Td>
                        <Td align="right">
                          <Button size="sm" icon="Download" loading={busy === f.name} disabled={!!busy} onClick={() => fetchOne(f.name)} aria-label={`${f.name} auf den Server holen`}>
                            Holen
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            {q.data.volumes.length > 0 && (
              <p className="m-0 text-sm text-fg-muted">
                Außerdem {q.data.volumes.length} Volume-Sicherung(en) vom Docker-Host im Unterordner <code>volume/</code> (neueste: {q.data.volumes[0].name}). Zurückspielen am Host mit <code>scripts/restore-volume.sh</code>.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/** Probe-Wiederherstellung: auf Knopfdruck und Protokoll der letzten Proben. */
function DrillPanel({ offsite }: { offsite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [source, setSource] = useState<'auto' | 'local' | 'offsite'>('auto');
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['backup-drills'],
    queryFn: () => get<Drill[]>('/backups/drills'),
    refetchInterval: (query) => ((query.state.data as Drill[] | undefined)?.some((d) => d.status === 'queued' || d.status === 'running') ? 3000 : false),
  });
  const start = async () => {
    setBusy(true);
    try {
      const r = await post<{ source: string; fileName: string }>('/backups/drills', source === 'auto' ? {} : { source });
      toast({ tone: 'success', title: 'Probe-Wiederherstellung gestartet', text: `${r.fileName} (${r.source === 'offsite' ? 'Kopie außer Haus' : 'lokal'})` });
      qc.invalidateQueries({ queryKey: ['backup-drills'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Nicht gestartet', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const running = q.data?.some((d) => d.status === 'queued' || d.status === 'running');
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-5">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">Probe-Wiederherstellung</h3>
        <HelpTip title="Was die Probe prüft" more="/hilfe/sicherung#wiederherstellung-ueben">
          <p className="m-0">Die Sicherung wird in eine Wegwerf-Datenbank auf diesem Server eingespielt – der laufende Betrieb bleibt unberührt. Geprüft werden Entschlüsseln, vollständiges Einspielen, Tabellen und Zeilen, Benutzerkonten und die Hash-Kette des Audit-Protokolls. Danach wird die Wegwerf-Datenbank gelöscht.</p>
        </HelpTip>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <FieldWrap label="Welche Sicherung?" htmlFor="dr-src" className="min-w-[240px]">
          <Select id="dr-src" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="auto">neueste (außer Haus, sonst lokal)</option>
            <option value="local">neueste lokale</option>
            {offsite && <option value="offsite">neueste Kopie außer Haus</option>}
          </Select>
        </FieldWrap>
        <Button icon="FlaskConical" loading={busy} disabled={busy || running} onClick={start}>
          Probe jetzt starten
        </Button>
      </div>
      {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Probe-Wiederherstellung.</p>}
      {q.data && q.data.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {q.data.slice(0, 8).map((d) => (
            <li key={d.id} className="border border-line rounded-node">
              <details>
                <summary className="cursor-pointer px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Badge tone={DRILL_STATUS[d.status].tone} pulse={d.status === 'running'}>
                    {DRILL_STATUS[d.status].label}
                  </Badge>
                  <span className="text-meta">{fmtDateTime(d.created_at)}</span>
                  <span className="text-fg-muted text-meta">
                    {d.source === 'offsite' ? 'Kopie außer Haus' : 'lokal'} · {d.trigger === 'schedule' ? 'Zeitplan' : (d.created_by_name ?? 'von Hand')}
                    {d.result.durationMs ? ` · ${fmtDuration(d.result.durationMs)}` : ''}
                  </span>
                </summary>
                <div className="px-3 pb-3 flex flex-col gap-2 text-sm">
                  <code className="text-[12px] break-all text-fg-muted">{d.file_name}</code>
                  {d.error && <Notice tone="error">{d.error}</Notice>}
                  {d.result.checks && <Steps steps={d.result.checks} />}
                  {d.result.tables != null && (
                    <p className="m-0 text-fg-muted">
                      {d.result.tables} Tabellen, {fmtNumber(d.result.rows ?? 0)} Zeilen, Stand {d.result.migration ?? '–'}
                      {d.result.keyTables ? ` · ${Object.entries(d.result.keyTables).map(([k, v]) => `${k}: ${fmtNumber(v)}`).join(', ')}` : ''}
                    </p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
