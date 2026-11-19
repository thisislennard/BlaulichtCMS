import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, put } from '../../../api/client';
import { Badge, Button, FieldWrap, Input, Notice, SegmentedControl, Select, Switch, Table, Td, Th } from '../../../components/ui/core';
import { useSaveSource, type SaveProblem } from '../../../components/ui/form';
import { Icon } from '../../../components/ui/Icon';
import { Dialog, SecretField, useConfirm, useToast } from '../../../components/ui/overlays';
import { HelpTip } from '../../../components/ui/HelpTip';
import { fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtNumber, fmtRelative, plural } from '../../../lib/format';
import { LoadError, SectionCard } from '../shared';
import { FieldGrid } from './model';

interface OffsiteConfig {
  enabled: boolean;
  /** SMB-Freigabe (UNC-Pfad in url) oder WebDAV (https-Adresse in url) */
  kind: 'smb' | 'webdav';
  url: string;
  domain: string;
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
  /** frühere Ziele, auf denen noch Sicherungen liegen können */
  leftovers: { url: string; since: string }[];
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

type Form = { enabled: boolean; kind: OffsiteConfig['kind']; url: string; domain: string; username: string; password: string; fingerprint: string; keepDaily: string; keepWeekly: string; keepMonthly: string; drillInterval: OffsiteConfig['drill_interval'] };
/** Ohne eingetragenes Ziel ist SMB vorgewählt (Freigabe im eigenen Netz, wie in LiFeOS). */
const fromConfig = (c: OffsiteConfig): Form => ({ enabled: c.enabled, kind: c.url ? c.kind : 'smb', url: c.url, domain: c.domain ?? '', username: c.username, password: '', fingerprint: c.tls_fingerprint, keepDaily: String(c.keep_daily), keepWeekly: String(c.keep_weekly), keepMonthly: String(c.keep_monthly), drillInterval: c.drill_interval });

/** Ganze Zahl im Bereich, sonst null (Eingabe bleibt beim Tippen unverändert, geprüft wird beim Speichern). */
const intIn = (v: string, lo: number, hi: number) => (/^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null);

/** Grenzen der Aufbewahrung wie auf dem Server (ops/offsite.ts, KEEP_LIMITS). */
const KEEP = { daily: [1, 90], weekly: [0, 52], monthly: [0, 24] } as const;
/** Dokumentierte Frist für gelöschte Daten in Sicherungen (Datenschutzhinweise: rund 4 Monate). */
const DOCUMENTED_RETENTION_DAYS = 124;
/** Längste Aufbewahrung auf dem Ziel in Tagen – wie retentionDays() auf dem Server. */
const retentionDays = (k: { daily: number; weekly: number; monthly: number }) => Math.max(k.daily, k.weekly * 7, k.monthly * 31);
const retentionLabel = (days: number) => (days < 28 ? `${days} ${days === 1 ? 'Tag' : 'Tage'}` : days < 62 ? `rund ${Math.round(days / 7)} Wochen` : `rund ${Math.round(days / 31)} Monate`);
/** Rechnername des Ziels: Server eines UNC-Pfads bzw. Host einer Adresse. */
const hostOf = (u: string) => {
  if (/^(\\\\|\/\/)/.test(u.trim())) return u.trim().replace(/^[\\/]+/, '').split(/[\\/]/)[0] || u;
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
/** Ziel wie der Server vergleichen (Adresse mit „/“ am Ende, UNC-Pfad mit „\“ und ohne Trenner am Ende). */
const sameUrl = (a: string, b: string) => {
  const norm = (s: string) => (/^(\\\\|\/\/)/.test(s.trim()) ? s.trim().replace(/\//g, '\\').replace(/\\+$/, '') : s.trim().replace(/\/*$/, '/'));
  return norm(a) === norm(b);
};

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
 * Einstellungen → Sicherung → Sicherung außer Haus (#212): Ziel als SMB-Freigabe oder per WebDAV, Verbindungstest vor dem Einschalten,
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
  /** Frage beim Ausschalten bzw. Zielwechsel: Sicherungen auf dem bisherigen Ziel löschen oder behalten (#246) */
  const [leaveAsk, setLeaveAsk] = useState<{ host: string; disabling: boolean; resolve: (v: 'keep' | 'delete' | null) => void } | null>(null);
  const c = q.data?.config;
  useEffect(() => {
    if (c && !form) setForm(fromConfig(c));
  }, [c, form]);
  // Speichern über die Leiste der Seite (#256): Ziel, Aufbewahrung und Probe zusammen mit der lokalen Sicherung
  const saveRef = useRef<() => Promise<boolean | void>>(async () => {});
  const keepProblems: SaveProblem[] = form
    ? ([
        ['os-kd', 'Tage', form.keepDaily, KEEP.daily],
        ['os-kw', 'Wochen', form.keepWeekly, KEEP.weekly],
        ['os-km', 'Monate', form.keepMonthly, KEEP.monthly],
      ] as const)
        .filter(([, , val, [lo, hi]]) => intIn(val, lo, hi) === null)
        .map(([id, label, , [lo, hi]]) => ({ id, message: `Aufbewahrung auf dem Ziel (${label}): ${lo} bis ${hi}.` }))
    : [];
  useSaveSource({
    dirty: !!(c && form) && (JSON.stringify({ ...form, password: '' }) !== JSON.stringify(fromConfig(c)) || !!form.password),
    problems: keepProblems,
    save: () => saveRef.current(),
    discard: () => {
      if (c) setForm(fromConfig(c));
      setEditingPassword(false);
      setError(null);
    },
  });

  if (q.isError) return <SectionCard id="ausser-haus" title="Sicherung außer Haus"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!c || !form) return <SectionCard id="ausser-haus" title="Sicherung außer Haus"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const smb = form.kind === 'smb';
  const target = {
    kind: form.kind,
    url: form.url.trim(),
    domain: smb ? form.domain.trim() : '',
    username: form.username.trim(),
    fingerprint: smb ? '' : form.fingerprint.trim(),
    ...(form.password ? { password: form.password } : {}),
  };
  const keepVals = { daily: intIn(form.keepDaily, ...KEEP.daily), weekly: intIn(form.keepWeekly, ...KEEP.weekly), monthly: intIn(form.keepMonthly, ...KEEP.monthly) };
  const keepInvalid = keepVals.daily === null || keepVals.weekly === null || keepVals.monthly === null;
  const keepDays = keepInvalid ? null : retentionDays(keepVals as { daily: number; weekly: number; monthly: number });
  const keepChanged = keepVals.daily !== c.keep_daily || keepVals.weekly !== c.keep_weekly || keepVals.monthly !== c.keep_monthly;
  const tooLong = keepDays !== null && keepDays > DOCUMENTED_RETENTION_DAYS;
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
    setError(null);
    // Aufbewahrung über der dokumentierten Frist nur mit Bestätigung (Speicherbegrenzung, Art. 5 Abs. 1 lit. e DSGVO)
    if (keepChanged && tooLong) {
      const ok = await ask({
        title: 'Längere Aufbewahrung bestätigen?',
        text: `Gelöschte Daten (z. B. nach einer Datenschutzanfrage entfernte Fotos) bleiben damit bis zu ${retentionLabel(keepDays!)} auf dem Ziel – länger als die in den Datenschutzhinweisen genannten rund 4 Monate. Die Frist dann im Verzeichnis der Verarbeitungstätigkeiten und in Auskünften entsprechend angeben.`,
        confirmLabel: 'Bestätigen und speichern',
        danger: false,
      });
      if (!ok) return false;
    }
    // Ausschalten oder anderes Ziel: Was passiert mit den Sicherungen auf dem bisherigen Ziel?
    const disabling = c.enabled && !form.enabled;
    let oldTarget: 'keep' | 'delete' | undefined;
    if (c.url && c.last_ok_at && (disabling || form.kind !== c.kind || !sameUrl(form.url, c.url))) {
      const choice = await new Promise<'keep' | 'delete' | null>((resolve) => setLeaveAsk({ host: hostOf(c.url), disabling, resolve }));
      setLeaveAsk(null);
      if (!choice) return false;
      oldTarget = choice;
    }
    setBusy('save');
    try {
      // Speichern geht immer; eingeschaltet wird nur ein vollständiges, erfolgreich getestetes Ziel (sonst Hinweis)
      const r = await put<{ config: OffsiteConfig; notice?: string; test?: TestResult }>('/backups/offsite', { ...target, enabled: form.enabled, keepDaily: keepVals.daily, keepWeekly: keepVals.weekly, keepMonthly: keepVals.monthly, drillInterval: form.drillInterval, ...(keepChanged && tooLong ? { acknowledgeRetention: true } : {}), ...(oldTarget ? { oldTarget } : {}) });
      if (r.notice) toast({ tone: 'warning', title: 'Sicherung außer Haus gespeichert', text: r.notice });
      else toast({ tone: 'success', title: 'Sicherung außer Haus gespeichert', text: r.config.enabled ? 'Neue Sicherungen gehen ab jetzt zusätzlich außer Haus.' : oldTarget === 'delete' ? 'Die Sicherungen auf dem bisherigen Ziel wurden gelöscht.' : undefined });
      if (r.test) setTest(r.test);
      setForm(fromConfig(r.config));
      setEditingPassword(false);
      qc.setQueryData(['backup-offsite'], (old: any) => (old ? { ...old, config: r.config } : old));
      qc.invalidateQueries({ queryKey: ['system-status'] });
    } catch (e) {
      // Fehler erscheinen in der Speichern-Leiste; das Testergebnis (Schritte) zusätzlich hier im Abschnitt
      if (e instanceof ApiError && e.code === 'offsite_test_failed' && e.details?.test) setTest(e.details.test);
      throw e;
    } finally {
      setBusy(null);
    }
  };
  saveRef.current = save;

  return (
    <SectionCard
      id="ausser-haus"
      title="Sicherung außer Haus"
      description="Jede Datenbanksicherung zusätzlich verschlüsselt auf ein Ziel außerhalb dieses Servers ablegen – eine SMB-Freigabe (Windows-Server, NAS) oder WebDAV – mit Aufbewahrung auf dem Ziel und Probe-Wiederherstellung."
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
          {q.data!.pending > 0 && <p className="m-0 text-sm text-fg-muted">{q.data!.pending === 1 ? 'Eine Übertragung läuft oder wartet.' : `${q.data!.pending} Übertragungen laufen oder warten.`}</p>}
        </div>
      )}

      <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Nach jeder Sicherung außer Haus ablegen" description="Speichern geht jederzeit, auch unvollständig. Eingeschaltet wird erst nach bestandenem Verbindungstest. Das Ziel ändern verlangt eine erneute Bestätigung mit deinem Passwort." />

      <div>
        <SegmentedControl<Form['kind']>
          label="Art des Ziels"
          value={form.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'smb', label: 'SMB-Freigabe' },
            { value: 'webdav', label: 'WebDAV' },
          ]}
        />
      </div>

      <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        {smb ? (
          <FieldWrap
            label="Pfad"
            htmlFor="os-url"
            className="col-span-full"
            help="Server, Freigabe und optional Unterordner als UNC-Pfad. Ein fehlender letzter Ordner wird beim Test angelegt."
            labelAction={
              <HelpTip title="SMB-Freigabe als Ziel" more="/hilfe/sicherung#sicherung-ausser-haus">
                <p className="m-0">Für Windows-Server, DFS-Freigaben und NAS im eigenen Netz. BlaulichtCMS verbindet sich mit smbclient (SMB 2 oder 3) über Port 445 – nichts wird eingehängt. Die Sicherungen sind bereits vor dem Hochladen verschlüsselt.</p>
              </HelpTip>
            }
          >
            <Input id="os-url" mono value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="\\server\freigabe\sicherung\blaulichtcms" maxLength={500} autoComplete="off" />
          </FieldWrap>
        ) : (
          <FieldWrap
            label="WebDAV-Adresse des Ordners"
            htmlFor="os-url"
            help="Nur https. Ein fehlender letzter Ordner wird beim Test angelegt."
            labelAction={
              <HelpTip title="WebDAV als Ziel" more="/hilfe/sicherung#sicherung-ausser-haus">
                <p className="m-0">WebDAV ist verschlüsseltes HTTPS. Synology (Paket „WebDAV Server“, HTTPS-Port 5006), QNAP, Nextcloud und viele andere NAS bieten es an – auch außerhalb des eigenen Netzes. Die Sicherungen sind bereits vor dem Hochladen verschlüsselt.</p>
              </HelpTip>
            }
          >
            <Input id="os-url" mono value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://nas.local:5006/sicherung/blaulichtcms/" maxLength={500} autoComplete="off" />
          </FieldWrap>
        )}
        {smb && (
          <FieldWrap label="Domäne (optional)" htmlFor="os-domain" help="Bei Domänenkonten, z. B. firma.local. Leer bei einem Konto direkt auf dem NAS.">
            <Input id="os-domain" value={form.domain} onChange={(e) => set({ domain: e.target.value })} maxLength={100} autoComplete="off" />
          </FieldWrap>
        )}
        <FieldWrap label={smb ? 'Benutzername' : 'Benutzer am Ziel'} htmlFor="os-user" help="Eigenes Konto nur für die Sicherung, mit Schreibrecht nur auf diesen Ordner.">
          <Input id="os-user" value={form.username} onChange={(e) => set({ username: e.target.value })} maxLength={200} autoComplete="off" />
        </FieldWrap>
        <SecretField
          id="os-pass"
          label={smb ? 'Passwort' : 'Passwort am Ziel'}
          set={c.password_set && !editingPassword}
          editing={editingPassword || !c.password_set}
          value={form.password}
          onReplace={(v) => {
            setEditingPassword(true);
            set({ password: v });
          }}
          help="Wird verschlüsselt gespeichert und nie wieder angezeigt. Für ein anderes Ziel oder einen anderen Benutzer neu eingeben."
        />
        {!smb && (
          <FieldWrap
            label="Zertifikat-Fingerabdruck (optional)"
            htmlFor="os-fp"
            help="Nur für selbst signierte Zertifikate im eigenen Netz: SHA-256 des NAS-Zertifikats. Leer = normale Prüfung."
          >
            <Input id="os-fp" mono value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value })} placeholder="AB:CD:…" maxLength={200} autoComplete="off" />
          </FieldWrap>
        )}
      </FieldGrid>

      <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
        <legend className="text-sm font-medium mb-1">Aufbewahrung auf dem Ziel</legend>
        <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))]">
          <FieldWrap label="Tage (je Tag die neueste)" htmlFor="os-kd" error={keepVals.daily === null ? `${KEEP.daily[0]} bis ${KEEP.daily[1]}` : undefined}>
            <Input id="os-kd" type="number" min={KEEP.daily[0]} max={KEEP.daily[1]} value={form.keepDaily} invalid={keepVals.daily === null} onChange={(e) => set({ keepDaily: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Wochen (je Woche die neueste)" htmlFor="os-kw" error={keepVals.weekly === null ? `${KEEP.weekly[0]} bis ${KEEP.weekly[1]}` : undefined}>
            <Input id="os-kw" type="number" min={KEEP.weekly[0]} max={KEEP.weekly[1]} value={form.keepWeekly} invalid={keepVals.weekly === null} onChange={(e) => set({ keepWeekly: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Monate (je Monat die neueste)" htmlFor="os-km" error={keepVals.monthly === null ? `${KEEP.monthly[0]} bis ${KEEP.monthly[1]}` : undefined}>
            <Input id="os-km" type="number" min={KEEP.monthly[0]} max={KEEP.monthly[1]} value={form.keepMonthly} invalid={keepVals.monthly === null} onChange={(e) => set({ keepMonthly: e.target.value })} />
          </FieldWrap>
        </FieldGrid>
        {keepDays !== null &&
          (tooLong ? (
            <Notice tone="warning" title={`Gelöschte Daten bleiben bis zu ${retentionLabel(keepDays)} auf dem Ziel`}>
              Das ist länger als die in den Datenschutzhinweisen genannten rund 4 Monate für Sicherungen. Speichern verlangt eine Bestätigung; die Frist gehört dann ins Verzeichnis der Verarbeitungstätigkeiten und in Auskünfte.
            </Notice>
          ) : (
            <p className="m-0 text-sm" role="status">
              Gelöschte Daten bleiben damit bis zu <strong>{retentionLabel(keepDays)}</strong> auf dem Ziel.
            </p>
          ))}
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
            {test.ok ? `Verbindungstest bestanden${test.files != null ? ` · ${plural(test.files, 'Sicherung', 'Sicherungen')} auf dem Ziel` : ''}` : (test.error ?? 'Verbindungstest fehlgeschlagen')}
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
      <div className="flex flex-wrap items-center gap-2">
        <Button icon="Plug" loading={busy === 'test'} disabled={!form.url.trim() || !!busy} aria-describedby={!form.url.trim() ? 'os-test-why' : undefined} onClick={runTest}>
          Verbindung testen
        </Button>
        {!form.url.trim() && (
          <span id="os-test-why" className="text-meta text-fg-muted">
            {smb ? 'Erst den Pfad der Freigabe eintragen.' : 'Erst die WebDAV-Adresse eintragen.'}
          </span>
        )}
      </div>

      {c.url && <RemoteFiles />}
      <Leftovers config={c} onChanged={(nc) => qc.setQueryData(['backup-offsite'], (old: any) => (old ? { ...old, config: nc } : old))} />
      <DrillPanel offsite={c.enabled && !!c.last_ok_file} />
      <Dialog
        open={!!leaveAsk}
        onClose={() => leaveAsk?.resolve(null)}
        title={leaveAsk?.disabling ? 'Sicherung außer Haus ausschalten' : 'Ziel wechseln'}
        width={520}
        footer={
          <>
            <Button onClick={() => leaveAsk?.resolve(null)}>Abbrechen</Button>
            <Button icon="Archive" onClick={() => leaveAsk?.resolve('keep')}>
              Behalten
            </Button>
            <Button variant="danger" icon="Trash2" onClick={() => leaveAsk?.resolve('delete')}>
              Löschen
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="m-0">
            Auf dem bisherigen Ziel <strong>{leaveAsk?.host}</strong> liegen Sicherungen von BlaulichtCMS. Danach räumt BlaulichtCMS dort nicht mehr auf – sie blieben unbegrenzt liegen, auch mit inzwischen gelöschten Daten.
          </p>
          <p className="m-0 text-fg-muted">
            <strong>Löschen</strong> entfernt jetzt alle Sicherungen von BlaulichtCMS dort (auch im Unterordner <code>volume/</code>); andere Dateien bleiben. <strong>Behalten</strong> lässt sie liegen – der Systemstatus erinnert daran, bis sie gelöscht sind.
          </p>
        </div>
      </Dialog>
    </SectionCard>
  );
}

/**
 * Frühere Ziele mit Sicherungen (#246): Hinweis mit „Löschen“ (nur für das eingetragene, ausgeschaltete Ziel – dafür
 * liegen die Zugangsdaten noch vor) bzw. „Hinweis entfernen“ (am NAS von Hand aufgeräumt).
 */
function Leftovers({ config: c, onChanged }: { config: OffsiteConfig; onChanged: (c: OffsiteConfig) => void }) {
  const toast = useToast();
  const ask = useConfirm();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const canPurge = !c.enabled && !!c.url;
  const others = c.leftovers.filter((l) => !canPurge || !sameUrl(l.url, c.url));
  const current = canPurge ? c.leftovers.find((l) => sameUrl(l.url, c.url)) : undefined;
  if (!canPurge && !others.length) return null;
  const purge = async () => {
    if (!(await ask({ title: 'Sicherungen auf dem Ziel löschen?', text: `Alle Sicherungen von BlaulichtCMS auf ${hostOf(c.url)} werden gelöscht (Datenbank- und Volume-Sicherungen). Andere Dateien im Ordner bleiben. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Löschen' }))) return;
    setBusy('purge');
    try {
      const r = await post<{ removed: number; failed: number; config: OffsiteConfig }>('/backups/offsite/purge', {});
      onChanged(r.config);
      qc.invalidateQueries({ queryKey: ['backup-offsite-files'] });
      qc.invalidateQueries({ queryKey: ['system-status'] });
      if (r.failed) toast({ tone: 'error', title: 'Nicht alles gelöscht', text: `${r.removed} gelöscht, ${r.failed} ließen sich nicht löschen (Systemprotokoll).` });
      else toast({ tone: 'success', title: r.removed ? `${plural(r.removed, 'Sicherung', 'Sicherungen')} gelöscht` : 'Keine Sicherungen auf dem Ziel' });
    } catch (e) {
      toast({ tone: 'error', title: 'Löschen fehlgeschlagen', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (url: string) => {
    if (!(await ask({ title: 'Hinweis entfernen?', text: `Nur entfernen, wenn die Sicherungen auf ${hostOf(url)} anders gelöscht wurden (z. B. am NAS von Hand) oder das Gerät nicht mehr existiert.`, confirmLabel: 'Hinweis entfernen', danger: false }))) return;
    setBusy(url);
    try {
      const r = await post<{ config: OffsiteConfig }>('/backups/offsite/leftovers/dismiss', { url });
      onChanged(r.config);
      qc.invalidateQueries({ queryKey: ['system-status'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Nicht entfernt', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {canPurge && (
        <Notice tone={current ? 'warning' : 'info'} title={current ? `Auf ${hostOf(c.url)} liegen noch Sicherungen` : 'Sicherung außer Haus ist ausgeschaltet'}>
          <div className="flex flex-col gap-2">
            <span>{current ? `Seit ${fmtDate(current.since)} räumt BlaulichtCMS dort nicht mehr auf.` : 'Liegen auf dem eingetragenen Ziel noch Sicherungen, lassen sie sich hier löschen.'}</span>
            <div>
              <Button size="sm" variant="danger" icon="Trash2" loading={busy === 'purge'} disabled={!!busy} onClick={purge}>
                Sicherungen auf dem Ziel löschen
              </Button>
            </div>
          </div>
        </Notice>
      )}
      {others.length > 0 && (
        <Notice tone="warning" title="Frühere Ziele mit Sicherungen">
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {others.map((l) => (
              <li key={l.url} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <strong>{hostOf(l.url)}</strong> <span className="text-fg-muted">– seit {fmtDate(l.since)}, dort am Gerät löschen</span>
                </span>
                <Button size="sm" loading={busy === l.url} disabled={!!busy} onClick={() => dismiss(l.url)} aria-label={`Hinweis zu ${hostOf(l.url)} entfernen`}>
                  Hinweis entfernen
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
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
                Außerdem {plural(q.data.volumes.length, 'Volume-Sicherung', 'Volume-Sicherungen')} vom Docker-Host im Unterordner <code>volume/</code> (neueste: {q.data.volumes[0].name}). Zurückspielen am Host mit <code>scripts/restore-volume.sh</code>.
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
