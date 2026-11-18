import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import type { UploadLink } from '../../api/types';
import { Button, FieldWrap, Input, Select, Switch, Textarea } from '../../components/ui/core';

export type FieldMode = 'off' | 'optional' | 'required';
export const FIELD_KEYS = ['name', 'email', 'note', 'place', 'date'] as const;
export const FIELD_LABELS: Record<(typeof FIELD_KEYS)[number], string> = { name: 'Name', email: 'E-Mail-Adresse', note: 'Hinweis', place: 'Aufnahmeort', date: 'Aufnahmedatum' };

export interface LinkOpts {
  maxUploads: number;
  maxFilesPerUpload: number;
  maxFileMb: number;
  maxTotalMb: number;
  closeWhenFull: boolean;
  allowedTypes: string[] | null;
  fields: Record<string, FieldMode>;
  consentRequired: boolean;
  consentText: string;
  password: string;
  removePassword: boolean;
}

export function optsFromLink(l?: UploadLink): LinkOpts {
  return {
    maxUploads: l?.max_uploads ?? 0,
    maxFilesPerUpload: l?.max_files_per_upload ?? 0,
    maxFileMb: l ? Math.round((l.max_file_bytes ?? 0) / 1024 / 1024) : 0,
    maxTotalMb: l ? Math.round((l.max_total_bytes ?? 0) / 1024 / 1024) : 0,
    closeWhenFull: l ? !!l.close_when_full : true,
    allowedTypes: l?.allowed_types ?? null,
    fields: { name: 'off', email: 'off', note: 'optional', place: 'off', date: 'off', ...(l?.fields ?? {}) },
    consentRequired: !!l?.consent_required,
    consentText: l?.consent_text ?? '',
    password: '',
    removePassword: false,
  };
}

/** API-Felder (beim Anlegen ohne leere Werte, damit die Standardwerte des Servers gelten). */
export function optsPayload(o: LinkOpts, create: boolean) {
  return {
    maxUploads: o.maxUploads,
    maxFilesPerUpload: o.maxFilesPerUpload,
    ...(o.maxFileMb ? { maxFileMb: o.maxFileMb } : {}),
    maxTotalMb: o.maxTotalMb,
    closeWhenFull: o.closeWhenFull,
    allowedTypes: o.allowedTypes,
    fields: o.fields,
    consentRequired: o.consentRequired,
    consentText: o.consentText,
    ...(o.password ? { password: o.password } : {}),
    ...(!create && o.removePassword ? { removePassword: true } : {}),
  };
}

export function optsValid(o: LinkOpts): string | null {
  if (o.consentRequired && !o.consentText.trim()) return 'Für die Bestätigung bitte einen Text eingeben.';
  if (o.password && o.password.length < 10) return 'Das Passwort muss mindestens 10 Zeichen lang sein.';
  if (o.allowedTypes && !o.allowedTypes.length) return 'Bitte mindestens einen Dateityp erlauben.';
  return null;
}

const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

/** „Erweitert“: Grenzen, Dateitypen, abgefragte Angaben, Bestätigung und Passwort eines Upload-Links (wie LiFeOS). */
export function LinkOptionsFields({ value, onChange, idPrefix, hasPassword }: { value: LinkOpts; onChange: (v: LinkOpts) => void; idPrefix: string; hasPassword?: boolean }) {
  const [open, setOpen] = useState(false);
  const types = useQuery({ queryKey: ['media-types'], queryFn: () => get<{ key: string; label: string; kind: string; allowed: boolean }[]>('/media/types'), enabled: open, staleTime: 60_000 });
  const set = (p: Partial<LinkOpts>) => onChange({ ...value, ...p });
  const allowed = (types.data ?? []).filter((t) => t.allowed);
  const selected = value.allowedTypes ?? allowed.map((t) => t.key);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <Button size="sm" variant="ghost" icon={open ? 'ChevronDown' : 'ChevronRight'} aria-expanded={open} className="self-start" onClick={() => setOpen((o) => !o)}>
        Erweitert: Grenzen, Dateitypen, Angaben, Bestätigung, Passwort
      </Button>
      {open && (
        <div className="flex flex-col gap-4">
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
            <legend className="text-label uppercase text-fg-muted mb-1">Grenzen (0 = unbegrenzt)</legend>
            <div className="grid gap-3 grid-cols-2">
              <FieldWrap label="Uploads je Link" htmlFor={`${idPrefix}-mu`} help="Ein Upload = ein Vorgang (eine Vorgangsnummer).">
                <Input id={`${idPrefix}-mu`} type="number" min={0} max={100000} value={value.maxUploads} onChange={(e) => set({ maxUploads: num(e.target.value) })} />
              </FieldWrap>
              <FieldWrap label="Dateien je Upload" htmlFor={`${idPrefix}-mfu`}>
                <Input id={`${idPrefix}-mfu`} type="number" min={0} max={1000} value={value.maxFilesPerUpload} onChange={(e) => set({ maxFilesPerUpload: num(e.target.value) })} />
              </FieldWrap>
              <FieldWrap label="Max. Dateigröße (MB)" htmlFor={`${idPrefix}-mfm`} help="Leer/0 = Einstellung „Maximale Dateigröße“.">
                <Input id={`${idPrefix}-mfm`} type="number" min={0} max={102400} value={value.maxFileMb} onChange={(e) => set({ maxFileMb: num(e.target.value) })} />
              </FieldWrap>
              <FieldWrap label="Gesamtgröße (MB)" htmlFor={`${idPrefix}-mtm`}>
                <Input id={`${idPrefix}-mtm`} type="number" min={0} max={1048576} value={value.maxTotalMb} onChange={(e) => set({ maxTotalMb: num(e.target.value) })} />
              </FieldWrap>
            </div>
            <Switch checked={value.closeWhenFull} onChange={(v) => set({ closeWhenFull: v })} label="Link schließen, wenn eine Grenze erreicht ist" description="Dann zeigt die Upload-Seite „Dieser Link funktioniert nicht (mehr)“. Sonst bleibt sie erreichbar und weist weitere Dateien ab." />
          </fieldset>
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="text-label uppercase text-fg-muted mb-1">Erlaubte Dateitypen</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {allowed.map((t) => (
                <label key={t.key} className="inline-flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-[var(--bc-primary-solid)]"
                    checked={selected.includes(t.key)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...selected, t.key] : selected.filter((k) => k !== t.key);
                      set({ allowedTypes: next.length === allowed.length ? null : next });
                    }}
                  />
                  {t.label}
                </label>
              ))}
            </div>
            <p className="m-0 text-meta text-fg-muted">Zur Auswahl stehen die unter Einstellungen → Medien & Upload global erlaubten Typen. Geprüft wird immer der Dateiinhalt.</p>
          </fieldset>
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="text-label uppercase text-fg-muted mb-1">Abgefragte Angaben</legend>
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
              {FIELD_KEYS.map((k) => (
                <FieldWrap key={k} label={FIELD_LABELS[k]} htmlFor={`${idPrefix}-f-${k}`}>
                  <Select id={`${idPrefix}-f-${k}`} value={value.fields[k] ?? 'off'} onChange={(e) => set({ fields: { ...value.fields, [k]: e.target.value as FieldMode } })}>
                    <option value="off">nicht abfragen</option>
                    <option value="optional">freiwillig</option>
                    <option value="required">Pflicht</option>
                  </Select>
                </FieldWrap>
              ))}
            </div>
            <p className="m-0 text-meta text-fg-muted">Name, E-Mail, Ort und Datum sind personenbezogen: Die Upload-Seite nennt sie im Datenschutzhinweis, sie werden nach der Frist unter Einstellungen → Löschfristen entfernt und sind Teil der Datenschutzsuche. Nur abfragen, was wirklich gebraucht wird.</p>
          </fieldset>
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="text-label uppercase text-fg-muted mb-1">Bestätigung vor dem Upload</legend>
            <Switch checked={value.consentRequired} onChange={(v) => set({ consentRequired: v })} label="Hochladende müssen einen Text bestätigen" description="Pflicht-Kästchen auf der Upload-Seite; der Zeitpunkt wird je Datei gespeichert." />
            {value.consentRequired && (
              <FieldWrap label="Text der Bestätigung" htmlFor={`${idPrefix}-ct`} required>
                <Textarea id={`${idPrefix}-ct`} rows={3} maxLength={2000} value={value.consentText} placeholder="z. B. Ich habe die Aufnahmen selbst gemacht und bin mit der Verwendung durch die Redaktion einverstanden." onChange={(e) => set({ consentText: e.target.value })} />
              </FieldWrap>
            )}
          </fieldset>
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="text-label uppercase text-fg-muted mb-1">Passwort (optional)</legend>
            <FieldWrap label={hasPassword ? 'Neues Passwort' : 'Passwort'} htmlFor={`${idPrefix}-pw`} help={hasPassword ? 'Der Link ist geschützt. Leer lassen = Passwort bleibt; ein neues Passwort beendet alle bisherigen Freigaben.' : 'Mindestens 10 Zeichen. Wer den Link öffnet, muss es zuerst eingeben.'}>
              <Input id={`${idPrefix}-pw`} type="password" autoComplete="new-password" value={value.password} disabled={value.removePassword} onChange={(e) => set({ password: e.target.value })} />
            </FieldWrap>
            {hasPassword && <Switch checked={value.removePassword} onChange={(v) => set({ removePassword: v, password: '' })} label="Passwortschutz entfernen" />}
          </fieldset>
        </div>
      )}
    </div>
  );
}
