import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '../../../api/client';
import { cx, FieldWrap, Input, Switch, Textarea } from '../../../components/ui/core';
import { useSaveSource, type SaveProblem } from '../../../components/ui/form';
import { useToast } from '../../../components/ui/overlays';
import { t } from '../../../i18n';
import { useAuth } from '../../../lib/auth';
import { settingsFieldId } from '../../../config/settingsPages';

/*
 * Gemeinsames Speichermodell der Einstellungs-Unterseiten (#256): Werte aus GET /settings, Entwurf je Unterseite,
 * Speichern über PATCH /settings nur der geänderten Schlüssel dieser Seite – angemeldet an der Speichern-Leiste der Seite
 * (SaveScope). Jedes Feld ist nur mit dem Recht für genau diesen Schlüssel änderbar (Spiegel von settingPermission()).
 */

export type Values = Record<string, any>;
export interface SettingsResponse {
  settings: Values;
  env: {
    publicUrl: string | null;
    cookieSecure: boolean;
    trustedProxies: string[];
    dataDir: string;
  };
}

/** Erlaubte Bereiche (Spiegel von SETTING_RANGES im Server, Gleichstand prüft units.test.ts) – Speichern erst, wenn alle Zahlen passen. */
export const RANGES: Record<string, [number, number]> = {
  'security.session_idle_minutes': [5, 1440],
  'security.session_max_hours': [1, 720],
  'security.remember_days': [1, 180],
  'security.mfa_remember_days': [1, 90],
  'security.lockout_attempts': [3, 20],
  'security.lockout_minutes': [1, 1440],
  'security.password_min_length': [10, 128],
  'invites.valid_hours': [1, 720],
  'jobs.concurrency': [1, 32],
  'retention.log_days': [1, 3650],
  'security.alert_failed_logins': [0, 10000],
  'security.alert_downloads': [0, 100000],
  'retention.audit_days': [30, 3650],
  'privacy.upload_ip_retention_days': [1, 365],
  'privacy.collection_retention_days': [0, 3650],
  'privacy.deleted_media_days': [0, 3650],
  'privacy.fe2_event_days': [0, 3650],
  'privacy.warning_days': [0, 3650],
  'privacy.official_warning_days': [0, 3650],
  'privacy.upload_link_days': [0, 3650],
  'privacy.receipt_days': [1, 30],
  'privacy.uploader_months': [0, 120],
  'privacy.press_request_months': [0, 120],
  'privacy.press_open_months': [0, 120],
  'privacy.press_release_log_months': [0, 120],
  'privacy.press_contact_review_months': [0, 120],
  'press.reminder_hours': [0, 72],
  'privacy.automation_run_days': [1, 3650],
  'automations.max_runs_per_minute': [1, 600],
  'media.blocked_days': [0, 3650],
  'media.export_hours': [1, 336],
  'media.export_max_gb': [1, 500],
  'media.security_log_days': [0, 3650],
  'media.max_file_mb': [1, 20000],
  'media.link_max_files': [1, 1000],
  'media.link_default_days': [1, 90],
  'media.link_max_days': [1, 365],
  'media.storage_warn_gb': [0, 100000],
  'media.collection_max_files': [1, 100000],
  'media.collection_max_gb': [1, 10000],
  'media.min_free_gb': [1, 10000],
  'media.max_video_minutes': [1, 600],
  'media.max_image_mp': [1, 500],
  'media.max_video_edge': [320, 8192],
  'media.full_decode_seconds': [10, 36000],
  'media.check_timeout_s': [60, 14400],
  'media.face_threshold': [30, 95],
  'smtp.port': [1, 65535],
  'backup.hour': [0, 23],
  'backup.keep': [1, 365],
  'updates.check_hours': [1, 168],
};

/** Recht je Einstellung, abgeleitet aus dem Schlüssel – Spiegel von settingPermission() im Server. */
export function settingPermission(key: string): string {
  switch (key.split('.')[0]) {
    case 'general':
      return 'settings.general';
    case 'privacy':
    case 'retention':
    case 'legal':
      return 'settings.privacy';
    case 'media':
      return 'settings.media';
    case 'editorial':
    case 'press':
      return 'settings.editorial';
    case 'jobs':
    case 'automations':
      return 'settings.system';
    case 'backup':
      return 'backup.manage';
    case 'mail':
    case 'm365':
    case 'notify':
    case 'push':
      return 'settings.mail';
    default:
      return 'settings.security';
  }
}

export const fieldId = settingsFieldId;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Meldung für einen Zahlenwert außerhalb des erlaubten Bereichs (null = in Ordnung). */
export function numProblem(k: string, val: unknown, min?: number, max?: number): string | null {
  const n = Number(val);
  const lo = min ?? RANGES[k]?.[0];
  const hi = max ?? RANGES[k]?.[1];
  if (val === '' || val === null || val === undefined || !Number.isInteger(n)) return t('admin.settings.numInvalid');
  if (lo != null && n < lo) return t('admin.settings.numMin', { min: lo });
  if (hi != null && n > hi) return t('admin.settings.numMax', { max: hi });
  return null;
}

export function useSettingsQuery() {
  return useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsResponse>('/settings') });
}

interface Ctx {
  v: Values;
  set: (k: string, x: unknown) => void;
  ro: (k: string) => boolean;
  env?: SettingsResponse['env'];
  /** gespeicherte Werte (für Vergleiche wie „Probelauf nutzt gespeicherte Fristen“) */
  saved: Values;
  dirty: boolean;
}
const SettingsCtx = createContext<Ctx | null>(null);
export function useSettingsForm(): Ctx {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error('useSettingsForm außerhalb von SettingsForm');
  return c;
}

/**
 * Entwurf der Werte einer Unterseite. `keys`: die Schlüssel dieser Seite (nur sie zählen als Änderung und werden
 * gespeichert). Meldet sich an der Speichern-Leiste der Seite an.
 */
export function SettingsForm({ keys, children, label }: { keys: string[]; children: ReactNode; label?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useSettingsQuery();
  const server = q.data?.settings;
  const [draft, setDraft] = useState<Values | null>(null);
  useEffect(() => {
    if (server && !draft) setDraft({ ...server });
  }, [server, draft]);
  const keySet = useMemo(() => new Set(keys), [keys]);
  const changed = server && draft ? keys.filter((k) => k in draft && !same(draft[k], server[k])) : [];
  const problems: SaveProblem[] = [];
  if (draft && server) {
    for (const k of keys) {
      if (typeof server[k] === 'number') {
        const p = numProblem(k, draft[k]);
        if (p) problems.push({ id: fieldId(k), message: `${labelOf(k)}: ${p}` });
      }
    }
    if (keySet.has('general.instance_name') && !String(draft['general.instance_name'] ?? '').trim()) problems.push({ id: fieldId('general.instance_name'), message: 'Instanzname: darf nicht leer sein.' });
  }
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useSaveSource({
    dirty: changed.length > 0,
    count: changed.length,
    problems,
    save: async () => {
      const d = draftRef.current;
      if (!d || !server) return;
      const body = Object.fromEntries(changed.map((k) => [k, d[k]]));
      await patch('/settings', body);
      const fresh = await qc.fetchQuery({ queryKey: ['settings'], queryFn: () => get<SettingsResponse>('/settings'), staleTime: 0 });
      // Nur die Schlüssel dieser Seite übernehmen – Eingaben anderer Abschnitte bleiben stehen
      setDraft((cur) => ({ ...fresh.settings, ...Object.fromEntries(Object.entries(cur ?? {}).filter(([k]) => !keySet.has(k) && k in fresh.settings)) }));
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['keywords'] });
      qc.invalidateQueries({ queryKey: ['warning-config'] });
      toast({ tone: 'success', title: t('admin.settings.saveOk'), text: label });
    },
    discard: () => server && setDraft({ ...server }),
  });
  if (!draft || !server) return null;
  const ctx: Ctx = {
    v: draft,
    saved: server,
    set: (k, x) => setDraft((d) => (d ? { ...d, [k]: x } : d)),
    ro: (k) => !can(settingPermission(k)),
    env: q.data?.env,
    dirty: changed.length > 0,
  };
  return <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>;
}

/** Beschriftungen der Felder für Meldungen in der Speichern-Leiste (Feld-ID → Text), von den Feldern selbst gemeldet. */
const LABELS = new Map<string, string>();
const labelOf = (k: string) => LABELS.get(k) ?? k;

export { FieldGrid } from '../shared';

export function TextField({ k, label, help, max = 200, required }: { k: string; label: string; help?: ReactNode; max?: number; required?: boolean }) {
  const { v, set, ro } = useSettingsForm();
  LABELS.set(k, label);
  const id = fieldId(k);
  return (
    <FieldWrap label={label} htmlFor={id} help={help} required={required}>
      <Input id={id} disabled={ro(k)} value={v[k] ?? ''} maxLength={max} onChange={(e) => set(k, e.target.value)} />
    </FieldWrap>
  );
}

export function NumField({ k, label, help, unit, min, max }: { k: string; label: string; help?: ReactNode; unit?: string; min?: number; max?: number }) {
  const { v, set, ro } = useSettingsForm();
  LABELS.set(k, label);
  const id = fieldId(k);
  const val = v[k];
  const lo = min ?? RANGES[k]?.[0];
  const hi = max ?? RANGES[k]?.[1];
  const err = numProblem(k, val, min, max);
  return (
    <FieldWrap label={label} htmlFor={id} help={help} error={err}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          disabled={ro(k)}
          min={lo}
          max={hi}
          step={1}
          value={val ?? ''}
          onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))}
          className={cx('tabular', unit && 'pr-14')}
        />
        {unit && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-muted pointer-events-none">{unit}</span>}
      </div>
    </FieldWrap>
  );
}

export function SwitchField({ k, label, description, disabled }: { k: string; label: string; description?: ReactNode; disabled?: boolean }) {
  const { v, set, ro } = useSettingsForm();
  LABELS.set(k, label);
  return <Switch id={fieldId(k)} checked={!!v[k]} disabled={ro(k) || disabled} onChange={(x) => set(k, x)} label={label} description={description} />;
}

export function TextAreaField({ k, label, help, max, rows = 3 }: { k: string; label: string; help?: ReactNode; max: number; rows?: number }) {
  const { v, set, ro } = useSettingsForm();
  LABELS.set(k, label);
  const id = fieldId(k);
  return (
    <FieldWrap label={label} htmlFor={id} help={help}>
      <Textarea id={id} rows={rows} maxLength={max} disabled={ro(k)} value={v[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
    </FieldWrap>
  );
}
