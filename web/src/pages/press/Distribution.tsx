import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, download, get, post, put } from '../../api/client';
import { Badge, Button, Card, EmptyLine, EmptyState, FieldWrap, FilePickButton, Input, Notice, PageHeader, Select, SkeletonRows, Switch, Tabs, Textarea } from '../../components/ui/core';
import { FilterEmpty, ListToolbar, ResponsiveTable } from '../../components/ui/list';
import { useListState } from '../../lib/listState';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDate, plural } from '../../lib/format';
import { CheckList } from '../automations/shared';

export interface PressList {
  id: string;
  name: string;
  description: string;
  contacts: number;
  unsubscribed: number;
}
type LegalBasis = 'public' | 'consent' | 'other';
interface Contact {
  id: string;
  name: string;
  outlet: string;
  email: string;
  phone: string;
  note: string;
  origin: string;
  consent: string;
  legal_basis: LegalBasis | null;
  consent_at: string | null;
  unsubscribed_at: string | null;
  last_activity: string;
  /** Wiedervorlage: Grundlage fehlt bzw. lange ohne Versand/Änderung */
  review: 'basis' | 'inactive' | null;
  list_ids: string[];
}

/** Rechtsgrundlagen (#244) – die Festlegung trifft die verantwortliche Stelle. */
const BASIS_OPTIONS: { value: LegalBasis; label: string; short: string }[] = [
  { value: 'public', label: 'Öffentliche Redaktionsadresse / Öffentlichkeitsarbeit (Art. 6 Abs. 1 lit. e DSGVO)', short: 'öffentliche Redaktionsadresse' },
  { value: 'consent', label: 'Einwilligung (Art. 6 Abs. 1 lit. a DSGVO)', short: 'Einwilligung' },
  { value: 'other', label: 'Andere Grundlage (im Nachweis beschreiben)', short: 'andere Grundlage' },
];
const basisShort = (b: LegalBasis | null) => BASIS_OPTIONS.find((o) => o.value === b)?.short ?? '';
const today = () => new Date().toISOString().slice(0, 10);

export const usePressLists = () => useQuery({ queryKey: ['press-lists'], queryFn: () => get<PressList[]>('/press/lists') });

/** Felder für Herkunft und Rechtsgrundlage (Kontakt und Import). */
function BasisFields({ v, set, disabled, idPrefix, defaults }: { v: { origin: string; legalBasis: LegalBasis | ''; consentAt: string; consent?: string }; set: (p: Partial<{ origin: string; legalBasis: LegalBasis | ''; consentAt: string; consent: string }>) => void; disabled?: boolean; idPrefix: string; defaults?: boolean }) {
  return (
    <>
      <FieldWrap label={defaults ? 'Herkunft (für Zeilen ohne Angabe)' : 'Herkunft'} required={!defaults} htmlFor={`${idPrefix}-origin`} help="Woher stammt die Adresse? z. B. Visitenkarte, Anfrage per Mail, Impressum der Redaktion.">
        <Input id={`${idPrefix}-origin`} value={v.origin} maxLength={500} disabled={disabled} onChange={(e) => set({ origin: e.target.value })} placeholder={defaults ? 'z. B. Presseliste der Kreisverwaltung 2026' : undefined} />
      </FieldWrap>
      <FieldWrap label={defaults ? 'Rechtsgrundlage (für Zeilen ohne Angabe)' : 'Rechtsgrundlage'} required={!defaults} htmlFor={`${idPrefix}-basis`} help="Die Festlegung trifft die verantwortliche Stelle (Hilfe → Presse → Presseverteiler).">
        <Select id={`${idPrefix}-basis`} value={v.legalBasis} disabled={disabled} onChange={(e) => set({ legalBasis: e.target.value as LegalBasis | '' })}>
          <option value="">– bitte wählen –</option>
          {BASIS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FieldWrap>
      {v.legalBasis === 'consent' && (
        <FieldWrap label={defaults ? 'Einwilligung am (für Zeilen ohne Datum)' : 'Einwilligung am'} required={!defaults} htmlFor={`${idPrefix}-consent-at`}>
          <Input id={`${idPrefix}-consent-at`} type="date" value={v.consentAt} max={today()} disabled={disabled} onChange={(e) => set({ consentAt: e.target.value })} />
        </FieldWrap>
      )}
    </>
  );
}

function ContactDialog({ contact, lists, onClose }: { contact: Contact | null; lists: PressList[]; onClose: () => void }) {
  const toastError = useErrorToast();
  const [v, setV] = useState({ name: contact?.name ?? '', outlet: contact?.outlet ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', note: contact?.note ?? '', origin: contact?.origin ?? '', consent: contact?.consent ?? '', legalBasis: (contact?.legal_basis ?? '') as LegalBasis | '', consentAt: contact?.consent_at ?? '', listIds: contact?.list_ids ?? [] });
  const [resubscribe, setResubscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  // abgemeldet: Sperrvermerk – nur mit „Wieder anmelden“ (neue Einwilligung) änderbar
  const locked = !!contact?.unsubscribed_at && !resubscribe;
  const valid = v.email.includes('@') && !!v.origin.trim() && !!v.legalBasis && (v.legalBasis !== 'consent' || !!v.consentAt) && (v.legalBasis !== 'other' || !!v.consent.trim());
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...v, legalBasis: v.legalBasis || null, consentAt: v.legalBasis === 'consent' ? v.consentAt || null : null };
      if (contact) await put(`/press/contacts/${contact.id}`, { ...body, resubscribe });
      else await post('/press/contacts', body);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={680}
      title={contact ? 'Kontakt bearbeiten' : 'Kontakt hinzufügen'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!valid || locked} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {contact?.unsubscribed_at && (
          <Notice tone="warning" title={`Abgemeldet am ${fmtDate(contact.unsubscribed_at)}`}>
            Dieser Kontakt hat sich über den Abmeldelink abgemeldet und erhält keine Pressemitteilungen mehr. Gespeichert bleibt nur der Sperrvermerk (Adresse, Zeitpunkt, Rechtsgrundlage), damit die Adresse nicht erneut aufgenommen wird.
          </Notice>
        )}
        {contact?.unsubscribed_at && <Switch checked={resubscribe} onChange={setResubscribe} label="Wieder anmelden" description="Nur mit einer neuen Einwilligung, erteilt nach der Abmeldung: Rechtsgrundlage „Einwilligung“ mit Datum." />}
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Name" htmlFor="ct-name">
            <Input id="ct-name" value={v.name} maxLength={200} autoComplete="off" disabled={locked} onChange={(e) => set({ name: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Medium/Redaktion" htmlFor="ct-outlet">
            <Input id="ct-outlet" value={v.outlet} maxLength={200} disabled={locked} onChange={(e) => set({ outlet: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="E-Mail" required htmlFor="ct-mail">
            <Input id="ct-mail" type="email" value={v.email} maxLength={254} autoComplete="off" disabled={locked} onChange={(e) => set({ email: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Telefon" htmlFor="ct-phone">
            <Input id="ct-phone" type="tel" value={v.phone} maxLength={60} autoComplete="off" disabled={locked} onChange={(e) => set({ phone: e.target.value })} />
          </FieldWrap>
          <BasisFields v={v} set={set} disabled={locked} idPrefix="ct" />
          <FieldWrap label="Nachweis / Bemerkung" required={v.legalBasis === 'other'} htmlFor="ct-consent" help="z. B. „Zustimmung per Mail vom 01.11.2026, abgelegt im Postfach“ oder bei anderer Grundlage, welche.">
            <Input id="ct-consent" value={v.consent} maxLength={500} disabled={locked} onChange={(e) => set({ consent: e.target.value })} />
          </FieldWrap>
        </div>
        <FieldWrap label="Notiz" htmlFor="ct-note">
          <Textarea id="ct-note" rows={2} value={v.note} maxLength={2000} disabled={locked} onChange={(e) => set({ note: e.target.value })} />
        </FieldWrap>
        {!locked && (lists.length > 0 ? <CheckList legend="Verteilerlisten" options={lists.map((l) => ({ value: l.id, label: l.name }))} value={v.listIds} onChange={(x) => set({ listIds: x })} /> : <Notice>Noch keine Verteilerliste – unter „Verteilerlisten“ anlegen.</Notice>)}
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [d, setD] = useState<{ origin: string; legalBasis: LegalBasis | ''; consentAt: string }>({ origin: '', legalBasis: '', consentAt: '' });
  const [preview, setPreview] = useState<{ neu: number; aktualisiert: number; abgemeldet: number; fehler: number; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<any>('/press/contacts/import', { csv, origin: d.origin, legalBasis: d.legalBasis || null, consentAt: d.legalBasis === 'consent' ? d.consentAt || null : null, dryRun });
      if (dryRun) setPreview(r);
      else {
        toast({ tone: 'success', title: `${r.neu} neu, ${r.aktualisiert} ergänzt` });
        onClose();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title="Kontakte importieren (CSV)"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          {preview ? (
            <Button variant="primary" loading={busy} disabled={!preview.neu && !preview.aktualisiert} onClick={() => run(false)}>
              Importieren
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!csv} onClick={() => run(true)}>
              Prüfen
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">
          Spalten (erste Zeile): <code>name; medium; email; telefon; notiz; herkunft; rechtsgrundlage; einwilligung_am; einwilligung; listen</code> – Pflicht sind <code>email</code> sowie Herkunft und Rechtsgrundlage (<code>oeffentlich</code>, <code>einwilligung</code> mit Datum, <code>andere</code> mit Nachweis in <code>einwilligung</code>) je Zeile oder als Vorgabe unten. Mehrere Listen mit <code>|</code> trennen (fehlende Listen werden angelegt). Vorhandene Adressen werden ergänzt, abgemeldete Kontakte bleiben unverändert abgemeldet.
        </p>
        <FieldWrap label="Datei" htmlFor="imp-file">
          <FilePickButton
            id="imp-file"
            name="Datei"
            accept=".csv,text/csv"
            label="CSV-Datei wählen …"
            fileName={fileName || null}
            onPick={async ([f]) => {
              setPreview(null);
              setFileName(f.name);
              setCsv(await f.text());
            }}
          />
        </FieldWrap>
        <BasisFields
          v={d}
          set={(p) => {
            setPreview(null);
            setD((x) => ({ ...x, ...p }));
          }}
          idPrefix="imp"
          defaults
        />
        {preview && (
          <Notice tone={preview.fehler ? 'warning' : 'success'} title={`${preview.neu} neu, ${preview.aktualisiert} vorhanden (werden ergänzt)${preview.abgemeldet ? `, ${preview.abgemeldet} abgemeldet (bleiben unverändert)` : ''}, ${preview.fehler} fehlerhaft`}>
            {preview.problems.length > 0 && (
              <ul className="m-0 pl-4">
                {preview.problems.slice(0, 10).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

function ListDialog({ list, onClose }: { list: PressList | null; onClose: () => void }) {
  const toastError = useErrorToast();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const save = async () => {
    try {
      if (list) await put(`/press/lists/${list.id}`, { name, description });
      else await post('/press/lists', { name, description });
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={list ? 'Liste bearbeiten' : 'Neue Verteilerliste'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={name.trim().length < 2} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Name" required htmlFor="ls-name">
          <Input id="ls-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="z. B. Lokalpresse, Rundfunk" />
        </FieldWrap>
        <FieldWrap label="Beschreibung" htmlFor="ls-desc">
          <Input id="ls-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

/** Presseverteiler (#207): Kontakte von Redaktionen und Verteilerlisten, Import/Export. */
export default function Distribution() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const toastError = useErrorToast();
  const { can } = useAuth();
  // Reiter, Suche und Liste in der Adresse (#260)
  const ls = useListState({ bereich: 'kontakte', suche: '', liste: '' }, { tabKeys: ['bereich'] });
  const tab: 'contacts' | 'lists' = ls.values.bereich === 'listen' ? 'lists' : 'contacts';
  const setTab = (t: 'contacts' | 'lists') => ls.set({ bereich: t === 'lists' ? 'listen' : 'kontakte' });
  const q = ls.values.suche;
  const listFilter = ls.values.liste;
  const setListFilter = (v: string) => ls.set({ liste: v });
  const toast = useToast();
  const [edit, setEdit] = useState<Contact | null | undefined>(undefined);
  const [editList, setEditList] = useState<PressList | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const contacts = useQuery({ queryKey: ['press-contacts'], queryFn: () => get<Contact[]>('/press/contacts') });
  const lists = usePressLists();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['press-contacts'] });
    qc.invalidateQueries({ queryKey: ['press-lists'] });
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (contacts.data ?? []).filter((c) => (!listFilter || (listFilter === 'review' ? !!c.review : c.list_ids.includes(listFilter))) && (!s || `${c.name} ${c.outlet} ${c.email}`.toLowerCase().includes(s)));
  }, [contacts.data, q, listFilter]);
  const listName = (id: string) => lists.data?.find((l) => l.id === id)?.name ?? '';
  const toReview = (contacts.data ?? []).filter((c) => c.review).length;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Kontakte von Redaktionen mit Herkunft und Rechtsgrundlage, gruppiert in Verteilerlisten für Pressemitteilungen."
        actions={
          <>
            <Button icon="FileDown" onClick={() => download('/press/contacts/export')}>
              Export (CSV)
            </Button>
            <Button icon="FileUp" onClick={() => setImporting(true)}>
              Import
            </Button>
            <Button variant="primary" icon="Plus" onClick={() => (tab === 'contacts' ? setEdit(null) : setEditList(null))}>
              {tab === 'contacts' ? 'Kontakt hinzufügen' : 'Neue Liste'}
            </Button>
          </>
        }
      />
      <Tabs label="Bereich" value={tab} onChange={setTab} tabs={[{ value: 'contacts', label: 'Kontakte', count: contacts.data?.length }, { value: 'lists', label: 'Verteilerlisten', count: lists.data?.length }]} />
      {tab === 'contacts' && (
        <>
          <ListToolbar
            search={{ value: q, onChange: (v) => ls.set({ suche: v }), placeholder: 'Suchen in Kontakten', label: 'Kontakte durchsuchen (Name, Medium, E-Mail)' }}
            filters={[{ key: 'liste', label: 'Liste', value: listFilter, onChange: setListFilter, allLabel: 'Alle Listen', options: [{ value: 'review', label: `Zu prüfen (${toReview})` }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))] }]}
            count={contacts.data ? { n: shown.length, one: 'Kontakt', many: 'Kontakte' } : undefined}
            onReset={() => ls.reset(['bereich'])}
          />
          {toReview > 0 && listFilter !== 'review' && (
            <Notice tone="warning" title={`${plural(toReview, 'Kontakt', 'Kontakte')} zu prüfen`}>
              Ohne vermerkte Rechtsgrundlage oder lange ohne Pressemitteilung und Änderung (Einstellungen → Datenschutz → Wiedervorlage). Prüfen, ob die Adresse noch stimmt und gebraucht wird – dann ergänzen bzw. „Geprüft“, sonst löschen. Automatisch gelöscht wird nichts.{' '}
              <Button size="sm" variant="ghost" onClick={() => setListFilter('review')}>
                Anzeigen
              </Button>
            </Notice>
          )}
          {contacts.isLoading && <SkeletonRows rows={5} />}
          {contacts.data && !shown.length &&
            (q.trim() || listFilter ? (
              <FilterEmpty onReset={() => ls.reset(['bereich'])} />
            ) : (
              <EmptyState icon="BookUser" title="Noch keine Kontakte." text="Kontakte einzeln hinzufügen oder als CSV importieren." action={<Button icon="Plus" onClick={() => setEdit(null)}>Kontakt hinzufügen</Button>} />
            ))}
          {shown.length > 0 && (
            <ResponsiveTable
              label="Kontakte"
              rows={shown}
              rowKey={(c) => c.id}
              columns={[
                {
                  key: 'contact',
                  header: 'Kontakt',
                  card: 'title',
                  cell: (c) => (
                    <>
                      <div className="font-medium">{c.name || c.email}</div>
                      <div className="text-meta text-fg-muted">
                        {c.outlet ? `${c.outlet} · ` : ''}
                        {c.email}
                      </div>
                      {c.unsubscribed_at && <Badge tone="warning">Abgemeldet</Badge>}
                      {c.review === 'basis' && <Badge tone="warning" title="Herkunft und Rechtsgrundlage ergänzen">Grundlage fehlt</Badge>}
                      {c.review === 'inactive' && <Badge tone="neutral" title={`Letzte Pressemitteilung, Änderung oder Prüfung: ${fmtDate(c.last_activity)}`}>Zu prüfen</Badge>}
                    </>
                  ),
                },
                { key: 'lists', header: 'Listen', className: 'text-sm', cell: (c) => c.list_ids.map(listName).filter(Boolean).join(', ') || '–' },
                { key: 'basis', header: 'Herkunft / Grundlage', from: 'lg', className: 'text-meta text-fg-muted', cell: (c) => [c.origin, basisShort(c.legal_basis) + (c.consent_at ? ` vom ${fmtDate(c.consent_at)}` : ''), c.consent].filter(Boolean).join(' · ') || '–' },
                {
                  key: 'actions',
                  header: <span className="sr-only">Aktionen</span>,
                  align: 'right',
                  card: 'footer',
                  cell: (c) => (
                    <>
                      <div className="flex justify-end gap-1">
                        {c.review === 'inactive' && (
                          <Button
                            size="sm"
                            iconOnly
                            icon="CheckCircle2"
                            aria-label={`${c.name || c.email} geprüft`}
                            onClick={async () => {
                              try {
                                await post(`/press/contacts/${c.id}/reviewed`);
                                toast({ tone: 'success', title: 'Als geprüft vermerkt' });
                              } catch (e) {
                                toastError(e);
                              }
                              refresh();
                            }}
                          />
                        )}
                        <Button size="sm" iconOnly icon="Pencil" aria-label={`${c.name || c.email} bearbeiten`} onClick={() => setEdit(c)} />
                        <Button
                          size="sm"
                          iconOnly
                          icon="Trash2"
                          aria-label={`${c.name || c.email} löschen`}
                          onClick={async () => {
                            if (!(await ask({ title: 'Kontakt löschen?', text: `${c.email} wird gelöscht – auch aus den Versandprotokollen (auch unter früheren Adressen dieses Kontakts).${c.unsubscribed_at ? ' Ohne Sperrvermerk könnte die Adresse später erneut aufgenommen werden.' : ''}`, confirmLabel: 'Löschen' }))) return;
                            try {
                              await del(`/press/contacts/${c.id}`);
                            } catch (e) {
                              toastError(e);
                            }
                            refresh();
                          }}
                        />
                      </div>
                    </>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      {tab === 'lists' && (
        <Card>
          {lists.data && !lists.data.length && <EmptyLine>Noch keine Verteilerliste. Mit „Neue Liste“ Kontakte für Pressemitteilungen gruppieren.</EmptyLine>}
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {(lists.data ?? []).map((l) => (
              <li key={l.id} className="py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-meta text-fg-muted">
                    {plural(l.contacts, 'Kontakt', 'Kontakte')}{l.unsubscribed ? ` · ${l.unsubscribed} abgemeldet` : ''}
                    {l.description ? ` · ${l.description}` : ''}
                  </div>
                </div>
                <Button size="sm" iconOnly icon="Pencil" aria-label={`${l.name} bearbeiten`} onClick={() => setEditList(l)} />
                <Button
                  size="sm"
                  iconOnly
                  icon="Trash2"
                  aria-label={`${l.name} löschen`}
                  onClick={async () => {
                    if (!(await ask({ title: 'Liste löschen?', text: `„${l.name}“ wird gelöscht; die Kontakte bleiben.`, confirmLabel: 'Löschen' }))) return;
                    try {
                      await del(`/press/lists/${l.id}`);
                    } catch (e) {
                      toastError(e);
                    }
                    refresh();
                  }}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {can('press.release') && <p className="m-0 text-meta text-fg-muted">Pressemitteilungen an diese Listen unter Presse → Pressemitteilungen.</p>}
      {edit !== undefined && (
        <ContactDialog
          contact={edit}
          lists={lists.data ?? []}
          onClose={() => {
            setEdit(undefined);
            refresh();
          }}
        />
      )}
      {editList !== undefined && (
        <ListDialog
          list={editList}
          onClose={() => {
            setEditList(undefined);
            refresh();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
