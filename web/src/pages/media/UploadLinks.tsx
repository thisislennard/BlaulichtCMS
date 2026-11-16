import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { post, patch } from '../../api/client';
import type { UploadLink } from '../../api/types';
import { ShareActions } from '../../components/share';
import { Badge, Button, Card, FieldWrap, Input, Notice, Select, StatusBadge, Textarea } from '../../components/ui/core';
import { Dialog, Menu, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, fmtRelative } from '../../lib/format';
import { FolderOptions, folderPath, type Folder } from './organize';
import { LinkOptionsFields, optsFromLink, optsPayload, optsValid, type LinkOpts } from './LinkOptions';

/** Zielordner eines Links (nur wenn die Sammlung Ordner hat). */
function FolderField({ folders, value, onChange, id }: { folders: Folder[]; value: string; onChange: (v: string) => void; id: string }) {
  if (!folders.length) return null;
  return (
    <FieldWrap label="Zielordner" htmlFor={id} help="Dateien über diesen Link landen direkt in diesem Ordner.">
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Oberste Ebene</option>
        <FolderOptions folders={folders} />
      </Select>
    </FieldWrap>
  );
}

/* ------------------------------------- Gültigkeit ------------------------------------- */

export type ValidityMode = '6' | '24' | '72' | '168' | 'days' | 'date';
export interface Validity {
  mode: ValidityMode;
  days: number;
  /** Wert eines datetime-local-Felds (Ortszeit des Geräts) */
  date: string;
}

export const DEFAULT_VALIDITY: Validity = { mode: '168', days: 14, date: '' };

/** Gültigkeit als API-Felder: feste Dauer in Stunden/Tagen oder Termin (ISO). */
export function validityPayload(v: Validity): { hours?: number; days?: number; expiresAt?: string } {
  if (v.mode === 'date') return v.date ? { expiresAt: new Date(v.date).toISOString() } : {};
  if (v.mode === 'days') return { days: Math.max(1, Math.round(v.days || 1)) };
  return { hours: Number(v.mode) };
}

/** Lokaler Zeitpunkt für <input type="datetime-local"> */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Auswahl wie in LiFeOS: 6 h, 24 h, 3 Tage, 7 Tage, eigene Dauer in Tagen oder „Bis Termin“. */
export function ValidityPicker({ value, onChange, idPrefix }: { value: Validity; onChange: (v: Validity) => void; idPrefix: string }) {
  return (
    <div className="flex flex-col gap-3">
      <FieldWrap label="Gültig" htmlFor={`${idPrefix}-validity`}>
        <Select id={`${idPrefix}-validity`} value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as ValidityMode, date: value.date || toLocalInput(new Date(Date.now() + 2 * 86400_000)) })}>
          <option value="6">6 Stunden</option>
          <option value="24">24 Stunden</option>
          <option value="72">3 Tage</option>
          <option value="168">7 Tage</option>
          <option value="days">Eigene Dauer (Tage)</option>
          <option value="date">Bis Termin</option>
        </Select>
      </FieldWrap>
      {value.mode === 'days' && (
        <FieldWrap label="Tage" htmlFor={`${idPrefix}-days`}>
          <Input id={`${idPrefix}-days`} type="number" min={1} max={365} value={value.days} onChange={(e) => onChange({ ...value, days: Number(e.target.value) })} className="max-w-[120px]" />
        </FieldWrap>
      )}
      {value.mode === 'date' && (
        <FieldWrap label="Bis (Datum und Uhrzeit)" htmlFor={`${idPrefix}-date`} help="Mindestens 5 Minuten in der Zukunft, höchstens bis zur eingestellten Höchstdauer.">
          <Input id={`${idPrefix}-date`} type="datetime-local" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} className="max-w-[260px]" />
        </FieldWrap>
      )}
    </div>
  );
}

/* --------------------------------------- Dialoge --------------------------------------- */

/** Neuer Link: Bezeichnung, Gültigkeit, Begrüßungstext. */
export function NewLinkDialog({ collectionId, folders = [], onClose, onCreated }: { collectionId: string; folders?: Folder[]; onClose: () => void; onCreated: (l: UploadLink) => void }) {
  const toastError = useErrorToast();
  const [validity, setValidity] = useState<Validity>(DEFAULT_VALIDITY);
  const [folderId, setFolderId] = useState('');
  const [opts, setOpts] = useState<LinkOpts>(optsFromLink());
  const [label, setLabel] = useState('');
  const [welcome, setWelcome] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Neuer Upload-Link"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={(validity.mode === 'date' && !validity.date) || !!optsValid(opts)}
            title={optsValid(opts) ?? undefined}
            onClick={async () => {
              setBusy(true);
              try {
                const l = await post<UploadLink>(`/collections/${collectionId}/links`, { label: label.trim(), welcomeText: welcome.trim(), folderId: folderId || null, ...validityPayload(validity), ...optsPayload(opts, true) });
                onCreated(l);
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Link erstellen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Bezeichnung" help="Nur intern sichtbar, z. B. „Aushang Gerätehaus“." htmlFor="l-label">
          <Input id="l-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </FieldWrap>
        <ValidityPicker value={validity} onChange={setValidity} idPrefix="l" />
        <FolderField folders={folders} value={folderId} onChange={setFolderId} id="l-folder" />
        <FieldWrap label="Begrüßungstext (optional)" help="Erscheint oben auf der Upload-Seite dieses Links – statt des Hinweises der Sammlung." htmlFor="l-welcome">
          <Textarea id="l-welcome" rows={3} maxLength={2000} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
        </FieldWrap>
        <LinkOptionsFields value={opts} onChange={setOpts} idPrefix="l" />
        {optsValid(opts) && <p className="m-0 text-sm text-err" role="alert">{optsValid(opts)}</p>}
      </div>
    </Dialog>
  );
}

/** Bezeichnung und Begrüßungstext eines bestehenden Links ändern. */
function EditLinkDialog({ link, folders, onClose, onSaved }: { link: UploadLink; folders: Folder[]; onClose: () => void; onSaved: () => void }) {
  const toastError = useErrorToast();
  const [label, setLabel] = useState(link.label);
  const [folderId, setFolderId] = useState(link.folder_id ?? '');
  const [opts, setOpts] = useState<LinkOpts>(optsFromLink(link));
  const [welcome, setWelcome] = useState(link.welcome_text ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload-Link bearbeiten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await patch(`/upload-links/${link.id}`, { label: label.trim(), welcomeText: welcome.trim(), ...(folders.length ? { folderId: folderId || null } : {}), ...optsPayload(opts, false) });
                onSaved();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Bezeichnung" help="Nur intern sichtbar." htmlFor="le-label">
          <Input id="le-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </FieldWrap>
        <FieldWrap label="Begrüßungstext" help="Erscheint oben auf der Upload-Seite dieses Links. Leer = Hinweis der Sammlung." htmlFor="le-welcome">
          <Textarea id="le-welcome" rows={4} maxLength={2000} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
        </FieldWrap>
        <FolderField folders={folders} value={folderId} onChange={setFolderId} id="le-folder" />
        <LinkOptionsFields value={opts} onChange={setOpts} idPrefix="le" hasPassword={link.has_password} />
        {optsValid(opts) && <p className="m-0 text-sm text-err" role="alert">{optsValid(opts)}</p>}
      </div>
    </Dialog>
  );
}

/** „Bis Termin“: Ablauf auf Datum und Uhrzeit setzen – auch früher als bisher. */
function DeadlineDialog({ link, onClose, onSaved }: { link: UploadLink; onClose: () => void; onSaved: () => void }) {
  const toastError = useErrorToast();
  const [date, setDate] = useState(toLocalInput(new Date(Math.max(Date.now() + 3600_000, new Date(link.expires_at).getTime()))));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Ablauf festlegen"
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!date}
            onClick={async () => {
              setBusy(true);
              try {
                await patch(`/upload-links/${link.id}`, { expiresAt: new Date(date).toISOString() });
                onSaved();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Übernehmen
          </Button>
        </>
      }
    >
      <FieldWrap label="Gültig bis" htmlFor="ld-date" help={`Bisher: ${fmtDateTime(link.expires_at)}. Ein früherer Termin beendet Uploads entsprechend eher.`}>
        <Input id="ld-date" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className="max-w-[260px]" />
      </FieldWrap>
    </Dialog>
  );
}

/** Link nur einmal sichtbar (Einstellung): direkt nach Anlegen bzw. Neu erzeugen anzeigen. */
export function OnceLinkDialog({ link, title, purpose, onClose }: { link: UploadLink; title: string; purpose: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Link jetzt sichern" width={520} footer={<Button variant="primary" onClick={onClose}>Erledigt</Button>}>
      <div className="flex flex-col gap-3">
        <Notice tone="warning" title="Nur jetzt sichtbar">
          Dieser Link wird aus Sicherheitsgründen nur einmal angezeigt. Bitte jetzt kopieren, als QR-Code speichern oder den Aushang drucken. Später hilft nur „Neu erzeugen“.
        </Notice>
        <code className="text-sm break-all">{link.url}</code>
        {link.url && <ShareActions share target={{ url: link.url, title, purpose, validUntil: link.expires_at }} />}
      </div>
    </Dialog>
  );
}

/** Kurzfassung der erweiterten Optionen für die Link-Liste. */
function linkOptionSummary(l: UploadLink): string {
  const parts: string[] = [];
  if (l.has_password) parts.push('mit Passwort');
  if (l.max_uploads) parts.push(`${l.uploads ?? 0} von ${l.max_uploads} Uploads`);
  if (l.max_files_per_upload) parts.push(`je Upload höchstens ${l.max_files_per_upload} Dateien`);
  if (l.max_total_bytes) parts.push(`höchstens ${fmtBytes(l.max_total_bytes)} gesamt`);
  if (l.allowed_types) parts.push(`nur ${l.allowed_types.join(', ').toUpperCase()}`);
  const asked = Object.entries(l.fields ?? {}).filter(([k, v]) => v !== 'off' && k !== 'note').map(([k, v]) => `${({ name: 'Name', email: 'E-Mail', place: 'Ort', date: 'Datum' } as Record<string, string>)[k]}${v === 'required' ? ' (Pflicht)' : ''}`);
  if (asked.length) parts.push(`fragt ${asked.join(', ')}`);
  if (l.consent_required) parts.push('mit Bestätigung');
  return parts.join(' · ');
}

/* ------------------------------------ Link-Übersicht ------------------------------------ */

export function UploadLinksCard({ collection, links, folders = [], onChanged }: { collection: { id: string; title: string; purpose: string; archived_at: string | null }; links: UploadLink[]; folders?: Folder[]; onChanged: () => void }) {
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UploadLink | null>(null);
  const [deadline, setDeadline] = useState<UploadLink | null>(null);
  const [once, setOnce] = useState<UploadLink | null>(null);
  const c = collection;
  const purpose = c.purpose || 'Fotos und Videos hochladen';
  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast({ tone: 'success', title: success });
    } catch (e) {
      toastError(e);
    }
    onChanged();
  };
  const activeLinks = links.filter((l) => l.state === 'active');
  return (
    <Card
      title="Upload-Links"
      subtitle="Personen ohne Konto laden über den Link oder QR-Code in genau diese Sammlung hoch."
      action={
        <Button size="sm" icon="Plus" onClick={() => setCreating(true)} disabled={!!c.archived_at}>
          Neuer Link
        </Button>
      }
    >
      {me?.instance.privacy?.incomplete && (
        <Notice tone="warning" className="mb-2" title="Datenschutzangaben fehlen">
          Die Upload-Seite nennt noch keine verantwortliche Stelle bzw. keine Datenschutzerklärung (Art. 13 DSGVO). Bitte unter {can('settings.view') ? <Link to="/einstellungen#datenschutz">Einstellungen → Datenschutz</Link> : 'Einstellungen → Datenschutz'} eintragen.
        </Notice>
      )}
      {links.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch kein Upload-Link.</p>}
      {c.archived_at && links.some((l) => l.state === 'active') && <Notice className="mb-2">Die Sammlung ist archiviert – über ihre Links kann niemand hochladen. Nach „Wiederherstellen“ gelten aktive Links wieder.</Notice>}
      <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
        {links.map((l) => {
          const changeable = l.state !== 'revoked';
          return (
            <li key={l.id} className="py-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {c.archived_at && l.state === 'active' ? <Badge tone="neutral">Sammlung archiviert</Badge> : <StatusBadge status={l.state} />}
                <span className="font-medium">{l.label || 'Upload-Link'}</span>
                <span className="text-sm text-fg-muted">
                  {l.state === 'revoked' ? `widerrufen ${fmtRelative(l.revoked_at)}` : l.state === 'expired' ? `abgelaufen ${fmtRelative(l.expires_at)}` : `gültig bis ${fmtDateTime(l.expires_at)}`} · {l.upload_count} von {l.max_files} Dateien
                  {l.bytes ? ` · ${fmtBytes(l.bytes)}` : ''}
                </span>
                <span className="flex-1" />
                {changeable && (
                  <Menu
                    size="sm"
                    label={`Aktionen für ${l.label || 'Upload-Link'}`}
                    items={[
                      { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEditing(l) },
                      can('media.design') ? { label: 'Gestaltung der Seite', icon: 'Palette', onClick: () => navigate(`/medien/gestaltung?link=${l.id}`) } : null,
                      l.state === 'paused'
                        ? { label: 'Fortsetzen', icon: 'Play', onClick: () => act(() => post(`/upload-links/${l.id}/resume`), 'Link fortgesetzt') }
                        : l.state === 'active'
                          ? { label: 'Pausieren', icon: 'Pause', onClick: () => act(() => post(`/upload-links/${l.id}/pause`), 'Link pausiert') }
                          : null,
                      { label: 'Um 24 Stunden verlängern', icon: 'Clock', onClick: () => act(() => post(`/upload-links/${l.id}/extend`, { hours: 24 }), 'Link verlängert') },
                      { label: 'Um 7 Tage verlängern', icon: 'Clock', onClick: () => act(() => post(`/upload-links/${l.id}/extend`, { hours: 168 }), 'Link verlängert') },
                      { label: 'Bis Termin …', icon: 'CalendarClock', onClick: () => setDeadline(l) },
                      {
                        label: 'Angaben der Hochladenden löschen',
                        icon: 'EyeOff',
                        onClick: async () => {
                          if (!(await ask({ title: 'Angaben der Hochladenden löschen?', text: 'Name, E-Mail, Aufnahmeort, Aufnahmedatum und Hinweise aller Uploads über diesen Link werden entfernt. Die Dateien bleiben.', confirmLabel: 'Angaben löschen' }))) return;
                          await act(() => post(`/upload-links/${l.id}/clear-uploader`), 'Angaben gelöscht');
                        },
                      },
                      {
                        label: 'Neu erzeugen',
                        icon: 'RefreshCw',
                        onClick: async () => {
                          if (!(await ask({ title: 'Link neu erzeugen?', text: 'Es entsteht ein neuer Link mit denselben Einstellungen. Der bisherige Link, sein QR-Code und gedruckte Aushänge funktionieren danach nicht mehr.', confirmLabel: 'Neu erzeugen' }))) return;
                          try {
                            const nl = await post<UploadLink>(`/upload-links/${l.id}/regenerate`);
                            toast({ tone: 'success', title: 'Neuer Link erzeugt', text: 'Der bisherige Link ist ungültig.' });
                            if (nl.shown_once) setOnce(nl);
                          } catch (e) {
                            toastError(e);
                          }
                          onChanged();
                        },
                      },
                      {
                        label: 'Widerrufen',
                        icon: 'Ban',
                        danger: true,
                        onClick: async () => {
                          if (!(await ask({ title: 'Upload-Link widerrufen?', text: 'Auch gedruckte QR-Codes und Aushänge funktionieren danach nicht mehr. Ein widerrufener Link lässt sich nicht wieder aktivieren.', confirmLabel: 'Widerrufen' }))) return;
                          await act(() => post(`/upload-links/${l.id}/revoke`));
                        },
                      },
                    ]}
                  />
                )}
              </div>
              {l.welcome_text && <p className="m-0 text-sm text-fg-muted line-clamp-2">Begrüßung: {l.welcome_text}</p>}
              {linkOptionSummary(l) && <p className="m-0 text-sm text-fg-muted">{linkOptionSummary(l)}</p>}
              {l.folder_id && folders.some((f) => f.id === l.folder_id) && (
                <p className="m-0 text-sm text-fg-muted">Zielordner: {folderPath(folders, l.folder_id).map((f) => f.name).join(' › ')}</p>
              )}
              <div className="text-meta text-fg-muted">
                angelegt {fmtRelative(l.created_at)}
                {l.created_by_name ? ` von ${l.created_by_name}` : ''}
                {l.last_used_at ? ` · zuletzt genutzt ${fmtRelative(l.last_used_at)}` : ''}
                {l.regenerated_at ? ` · neu erzeugt ${fmtRelative(l.regenerated_at)}` : ''}
              </div>
              {(l.state === 'active' || l.state === 'paused' || l.state === 'full') && l.url && !c.archived_at && (
                <ShareActions
                  share
                  target={{
                    url: l.url,
                    title: c.title,
                    purpose,
                    validUntil: l.expires_at,
                    sensitive: 'Jede Person mit diesem Link oder QR-Code kann bis zum Ablauf Dateien in diese Sammlung hochladen. Beim Widerruf oder „Neu erzeugen“ verliert auch ein gedruckter Code seine Wirkung.',
                  }}
                />
              )}
              {(l.state === 'active' || l.state === 'paused') && l.url_hidden && <p className="m-0 text-sm text-fg-muted">Der Link wurde nur einmal angezeigt. Für einen neuen Link und QR-Code: Menü → „Neu erzeugen“.</p>}
            </li>
          );
        })}
      </ul>
      {activeLinks.length === 0 && links.length > 0 && <p className="m-0 mt-2 text-sm text-fg-muted">Kein aktiver Link – Uploads von außen sind gesperrt.</p>}
      {creating && (
        <NewLinkDialog
          collectionId={c.id}
          folders={folders}
          onClose={() => setCreating(false)}
          onCreated={(l) => {
            setCreating(false);
            if (l.shown_once) setOnce(l);
            onChanged();
          }}
        />
      )}
      {editing && <EditLinkDialog link={editing} folders={folders} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), onChanged())} />}
      {deadline && <DeadlineDialog link={deadline} onClose={() => setDeadline(null)} onSaved={() => (setDeadline(null), onChanged())} />}
      {once && <OnceLinkDialog link={once} title={c.title} purpose={purpose} onClose={() => setOnce(null)} />}
    </Card>
  );
}

