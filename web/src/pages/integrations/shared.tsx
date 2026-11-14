/* Gemeinsame Bausteine der Integrationsseiten (Schnittstellen, Verbindungen, WordPress). */
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import type { ConnectorInfo } from '../../api/types';
import { Badge, cx, Spinner, type Tone } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CopyButton } from '../../components/ui/overlays';
import { t } from '../../i18n';
import { fmtDate, fmtDuration, fromLocalInput, toLocalInput } from '../../lib/format';

export type ConnStatus = 'untested' | 'ok' | 'warning' | 'error' | 'disabled';

export interface ConnectionRow {
  id: string;
  connector: string;
  name: string;
  config: Record<string, any>;
  status: ConnStatus;
  status_message: string | null;
  last_test_at: string | null;
  last_test_ms: number | null;
  last_used_at: string | null;
  credentials_expire_at: string | null;
  created_at: string;
  updated_at: string;
  owner_name: string | null;
  workflow_count: number;
}

export interface SecretVersion {
  id: string;
  version: number;
  fingerprint: string | null;
  created_at: string;
  revoked_at: string | null;
  created_by_name: string | null;
  current: boolean;
}

export interface ConnectionFull extends Omit<ConnectionRow, 'workflow_count' | 'owner_name'> {
  owner_id: string | null;
  secret: { version: number | null; savedAt: string | null; fields: Record<string, { set: boolean }> } | null;
  secretVersions: SecretVersion[];
  workflows: { id: string; name: string; status: string }[];
}

export interface TestStep {
  label: string;
  ok: boolean;
  ms: number;
  message?: string;
}

export interface TestResult {
  ok: boolean;
  steps: TestStep[];
  ms: number;
}

export const CONN_TONE: Record<ConnStatus, Tone> = { ok: 'success', warning: 'warning', error: 'error', untested: 'neutral', disabled: 'neutral' };

export function ConnStatusBadge({ status, className }: { status: ConnStatus; className?: string }) {
  return (
    <Badge tone={CONN_TONE[status] ?? 'neutral'} className={className}>
      {t(`integrations.status.${status}`)}
    </Badge>
  );
}

export function useConnections(enabled = true) {
  return useQuery<ConnectionRow[]>({ queryKey: ['connections'], queryFn: () => get('/connections'), enabled });
}

/** Tage bis zum Ablauf der Zugangsdaten (negativ = abgelaufen), null = kein Ablaufdatum. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  return Math.floor((d - Date.now()) / 86_400_000);
}

export const EXPIRY_WARN_DAYS = 14;

/** Hinweis zu ablaufenden Zugangsdaten oder null. */
export function expiryNote(iso: string | null | undefined): { tone: 'warning' | 'error'; text: string } | null {
  const d = daysUntil(iso);
  if (d == null) return null;
  if (d < 0) return { tone: 'error', text: t('integrations.expiry.expired', { date: fmtDate(iso) }) };
  if (d <= EXPIRY_WARN_DAYS) return { tone: 'warning', text: d === 0 ? t('integrations.expiry.today') : t('integrations.expiry.soon', { n: d, date: fmtDate(iso) }) };
  return null;
}

/** Wizard ergibt nur Sinn, wenn es etwas einzutragen gibt. */
export function isConnectable(c: ConnectorInfo) {
  return c.fields.length > 0 || c.secretFields.length > 0;
}

/** Datum (yyyy-mm-dd) für <input type="date"> aus ISO, in der Zeitzone der Instanz. */
export function isoToDateInput(iso: string | null | undefined): string {
  return toLocalInput(iso).slice(0, 10);
}

/** <input type="date"> → ISO (Ende des Tages in der Zeitzone der Instanz). */
export function dateInputToIso(v: string): string | null {
  if (!v) return null;
  return fromLocalInput(`${v}T23:59`);
}

/** Checkliste eines Verbindungstests mit Dauer je Prüfung. */
export function TestChecklist({ steps, pending, pendingLabels }: { steps?: TestStep[] | null; pending?: boolean; pendingLabels?: string[] }) {
  const rows: (TestStep & { running?: boolean })[] = pending ? (pendingLabels?.length ? pendingLabels : [t('integrations.test.running')]).map((label) => ({ label, ok: false, ms: 0, running: true })) : (steps ?? []);
  return (
    <ul className="list-none m-0 p-0 flex flex-col" aria-busy={pending || undefined}>
      {rows.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-start gap-3 py-2.5 border-b border-line last:border-b-0">
          <span
            className={cx(
              'w-[22px] h-[22px] rounded-full inline-flex items-center justify-center shrink-0',
              s.running ? 'bg-raised text-fg-muted' : s.ok ? 'bg-ok-soft text-ok' : 'bg-err-soft text-err',
            )}
          >
            {s.running ? <Spinner size={12} /> : <Icon name={s.ok ? 'Check' : 'X'} size={13} strokeWidth={2.4} />}
          </span>
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-sm">
              {s.label}
              <span className="sr-only"> – {s.running ? t('integrations.test.runningShort') : s.ok ? t('integrations.test.passed') : t('integrations.test.failed')}</span>
            </span>
            {s.message && <span className={cx('text-meta break-words', s.ok ? 'text-fg-muted' : 'text-err')}>{s.message}</span>}
          </span>
          {!s.running && <span className="font-mono text-meta text-fg-muted tabular shrink-0">{fmtDuration(s.ms)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Ergebnisbox unter der Checkliste. */
export function TestResultBox({ result }: { result: TestResult }) {
  const failed = result.steps.find((s) => !s.ok);
  return (
    <div role="status" className={cx('rounded-node p-3 text-sm font-medium flex items-start gap-2', result.ok ? 'bg-ok-soft text-ok' : 'bg-err-soft text-err')}>
      <Icon name={result.ok ? 'CheckCircle2' : 'XCircle'} size={16} className="mt-0.5 shrink-0" />
      <span className="flex flex-col gap-0.5 min-w-0">
        <span>{result.ok ? t('integrations.test.okTitle', { ms: fmtDuration(result.ms) }) : t('integrations.test.errTitle')}</span>
        {!result.ok && failed?.message && <span className="font-normal text-fg break-words">{failed.message}</span>}
        {!result.ok && <span className="font-normal text-fg-muted">{t('integrations.test.errHint')}</span>}
      </span>
    </div>
  );
}

/** Kurzer Klartext zur Integration (Name) mit Fallback. */
export function connectorName(list: ConnectorInfo[] | undefined, id: string) {
  return list?.find((c) => c.id === id)?.name ?? id;
}

/** Codebeispiel mit Kopierknopf. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="min-w-0 rounded-node bg-bg border border-line overflow-hidden">
      <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 py-1.5 border-b border-line">
        <span className="text-meta text-fg-muted">{label ?? 'curl'}</span>
        <CopyButton value={code} size="sm" label={t('integrations.common.copy')} />
      </div>
      <pre className="m-0 p-3 font-mono text-meta leading-relaxed overflow-x-auto whitespace-pre">{code}</pre>
    </div>
  );
}

const HELP_SLUG: Record<string, string> = { alamos: 'alamos-fe2', wordpress: 'wordpress', smtp: 'e-mail', imap: 'e-mail', teams: 'teams', mqtt: 'mqtt', http: 'rest-api', webhook: 'webhooks' };
/** Hilfekapitel zu einer Integration. */
export function helpSlug(connector: string | undefined) {
  return (connector && HELP_SLUG[connector]) || 'integrationen';
}

/** Einzahl/Mehrzahl: Schlüssel `<key>One` bzw. `<key>`; {n} wird ersetzt. */
export function pl(n: number, key: string, vars: Record<string, string | number> = {}) {
  return t(n === 1 ? `${key}One` : key, { ...vars, n });
}
