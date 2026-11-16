import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, download, get, post, put } from '../../api/client';
import { Badge, Button, Card, EmptyState, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, Switch, Table, Tabs, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';
import { CheckList } from '../automations/shared';

export interface PressList {
  id: string;
  name: string;
  description: string;
  contacts: number;
  unsubscribed: number;
}
interface Contact {
  id: string;
  name: string;
  outlet: string;
  email: string;
  phone: string;
  note: string;
  origin: string;
  consent: string;
  unsubscribed_at: string | null;
  list_ids: string[];
}

export const usePressLists = () => useQuery({ queryKey: ['press-lists'], queryFn: () => get<PressList[]>('/press/lists') });

function ContactDialog({ contact, lists, onClose }: { contact: Contact | null; lists: PressList[]; onClose: () => void }) {
  const toastError = useErrorToast();
  const [v, setV] = useState({ name: contact?.name ?? '', outlet: contact?.outlet ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', note: contact?.note ?? '', origin: contact?.origin ?? '', consent: contact?.consent ?? '', listIds: contact?.list_ids ?? [] });
  const [resubscribe, setResubscribe] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      if (contact) await put(`/press/contacts/${contact.id}`, { ...v, resubscribe });
      else await post('/press/contacts', v);
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
          <Button variant="primary" loading={busy} disabled={!v.email.includes('@')} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {contact?.unsubscribed_at && (
          <Notice tone="warning" title={`Abgemeldet am ${fmtDate(contact.unsubscribed_at)}`}>
            Dieser Kontakt hat sich über den Abmeldelink abgemeldet und erhält keine Pressemitteilungen mehr.
          </Notice>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Name" htmlFor="ct-name">
            <Input id="ct-name" value={v.name} maxLength={200} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Medium/Redaktion" htmlFor="ct-outlet">
            <Input id="ct-outlet" value={v.outlet} maxLength={200} onChange={(e) => set({ outlet: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="E-Mail" required htmlFor="ct-mail">
            <Input id="ct-mail" type="email" value={v.email} maxLength={254} autoComplete="off" onChange={(e) => set({ email: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Telefon" htmlFor="ct-phone">
            <Input id="ct-phone" type="tel" value={v.phone} maxLength={60} autoComplete="off" onChange={(e) => set({ phone: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Herkunft" htmlFor="ct-origin" help="Woher stammt die Adresse? z. B. Visitenkarte, Anfrage per Mail, eigene Recherche.">
            <Input id="ct-origin" value={v.origin} maxLength={500} onChange={(e) => set({ origin: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Einwilligung / Rechtsgrundlage" htmlFor="ct-consent" help="z. B. „per Mail zugestimmt am 01.11.2026“ oder „öffentliche Redaktionsadresse“.">
            <Input id="ct-consent" value={v.consent} maxLength={500} onChange={(e) => set({ consent: e.target.value })} />
          </FieldWrap>
        </div>
        <FieldWrap label="Notiz" htmlFor="ct-note">
          <Textarea id="ct-note" rows={2} value={v.note} maxLength={2000} onChange={(e) => set({ note: e.target.value })} />
        </FieldWrap>
        {lists.length > 0 ? <CheckList legend="Verteilerlisten" options={lists.map((l) => ({ value: l.id, label: l.name }))} value={v.listIds} onChange={(x) => set({ listIds: x })} /> : <Notice>Noch keine Verteilerliste – unter „Verteilerlisten“ anlegen.</Notice>}
        {contact?.unsubscribed_at && <Switch checked={resubscribe} onChange={setResubscribe} label="Wieder anmelden" description="Nur mit erneuter Einwilligung – bitte oben vermerken." />}
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const file = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [origin, setOrigin] = useState('');
  const [preview, setPreview] = useState<{ neu: number; aktualisiert: number; fehler: number; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<any>('/press/contacts/import', { csv, origin, dryRun });
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
          Spalten (erste Zeile): <code>name; medium; email; telefon; notiz; herkunft; einwilligung; listen</code> – nur <code>email</code> ist Pflicht, mehrere Listen mit <code>|</code> trennen (fehlende Listen werden angelegt). Vorhandene Adressen werden ergänzt, abgemeldete Kontakte bleiben abgemeldet.
        </p>
        <FieldWrap label="Datei" htmlFor="imp-file">
          <input
            ref={file}
            id="imp-file"
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setPreview(null);
              setCsv(f ? await f.text() : '');
            }}
          />
        </FieldWrap>
        <FieldWrap label="Herkunft (für Zeilen ohne Angabe)" htmlFor="imp-origin">
          <Input id="imp-origin" value={origin} maxLength={500} onChange={(e) => setOrigin(e.target.value)} placeholder="z. B. Presseliste der Kreisverwaltung 2026" />
        </FieldWrap>
        {preview && (
          <Notice tone={preview.fehler ? 'warning' : 'success'} title={`${preview.neu} neu, ${preview.aktualisiert} vorhanden (werden ergänzt), ${preview.fehler} fehlerhaft`}>
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
  const [tab, setTab] = useState<'contacts' | 'lists'>('contacts');
  const [q, setQ] = useState('');
  const [listFilter, setListFilter] = useState('');
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
    return (contacts.data ?? []).filter((c) => (!listFilter || c.list_ids.includes(listFilter)) && (!s || `${c.name} ${c.outlet} ${c.email}`.toLowerCase().includes(s)));
  }, [contacts.data, q, listFilter]);
  const listName = (id: string) => lists.data?.find((l) => l.id === id)?.name ?? '';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Presseverteiler"
        subtitle="Kontakte von Redaktionen mit Herkunft und Einwilligung, gruppiert in Verteilerlisten für Pressemitteilungen."
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
          <div className="flex flex-wrap gap-3">
            <div className="w-full sm:w-72">
              <Input type="search" aria-label="Kontakte durchsuchen" placeholder="Name, Medium, E-Mail …" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="w-full sm:w-60">
              <Select aria-label="Nach Liste filtern" value={listFilter} onChange={(e) => setListFilter(e.target.value)}>
                <option value="">Alle Listen</option>
                {(lists.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {contacts.isLoading && <SkeletonRows rows={5} />}
          {contacts.data && !shown.length && <EmptyState icon="BookUser" title="Keine Kontakte" text="Kontakte einzeln hinzufügen oder als CSV importieren." />}
          {shown.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Kontakt</Th>
                  <Th className="hidden md:table-cell">Listen</Th>
                  <Th className="hidden lg:table-cell">Herkunft / Einwilligung</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <div className="font-medium">{c.name || c.email}</div>
                      <div className="text-meta text-fg-muted">
                        {c.outlet ? `${c.outlet} · ` : ''}
                        {c.email}
                      </div>
                      {c.unsubscribed_at && <Badge tone="warning">Abgemeldet</Badge>}
                    </Td>
                    <Td className="hidden md:table-cell text-sm">{c.list_ids.map(listName).filter(Boolean).join(', ') || '–'}</Td>
                    <Td className="hidden lg:table-cell text-meta text-fg-muted">{[c.origin, c.consent].filter(Boolean).join(' · ') || '–'}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" iconOnly icon="Pencil" aria-label={`${c.name || c.email} bearbeiten`} onClick={() => setEdit(c)} />
                        <Button
                          size="sm"
                          iconOnly
                          icon="Trash2"
                          aria-label={`${c.name || c.email} löschen`}
                          onClick={async () => {
                            if (!(await ask({ title: 'Kontakt löschen?', text: `${c.email} wird gelöscht – auch aus den Versandprotokollen.`, confirmLabel: 'Löschen' }))) return;
                            try {
                              await del(`/press/contacts/${c.id}`);
                            } catch (e) {
                              toastError(e);
                            }
                            refresh();
                          }}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
      {tab === 'lists' && (
        <Card>
          {lists.data && !lists.data.length && <EmptyState icon="List" title="Noch keine Verteilerliste" />}
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {(lists.data ?? []).map((l) => (
              <li key={l.id} className="py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-meta text-fg-muted">
                    {l.contacts} Kontakt(e){l.unsubscribed ? ` · ${l.unsubscribed} abgemeldet` : ''}
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
