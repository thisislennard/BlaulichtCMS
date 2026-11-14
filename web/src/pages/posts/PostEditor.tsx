import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, patch, post, put } from '../../api/client';
import type { MediaItem, Publication, Site } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { ShareActions } from '../../components/share';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { KIND_LABEL } from './Posts';

interface PostDetail {
  post: { id: string; kind: string; created_at: string; created_by_name: string | null; archived: boolean; current_revision: number };
  state: string;
  revision: { id: string; number: number; title: string; body: string; excerpt: string; media_ids: string[]; cover_id: string | null; site_id: string | null; content_hash: string; submitted_at: string | null; created_at: string };
  media: MediaItem[];
  approval: { decided_by_name: string; decided_at: string; note: string } | null;
  lastDecision: { decision: string; note: string; decided_by_name: string; decided_at: string } | null;
  revisions: { id: string; number: number; title: string; change_note: string; created_at: string; created_by_name: string | null; decision: string | null }[];
  publications: Publication[];
  collections: { id: string; title: string; media_count: number; selected_count: number }[];
}

interface Draft {
  title: string;
  body: string;
  excerpt: string;
  mediaIds: string[];
  coverId: string | null;
  siteId: string | null;
}

function MediaPicker({ collections, chosen, onClose, onAdd }: { collections: PostDetail['collections']; chosen: string[]; onClose: () => void; onAdd: (m: MediaItem[]) => void }) {
  const all = useQuery({ queryKey: ['collections', false], queryFn: () => get<any[]>('/collections') });
  const [cid, setCid] = useState(collections[0]?.id ?? '');
  const [onlySelected, setOnlySelected] = useState(true);
  const [picked, setPicked] = useState<MediaItem[]>([]);
  const detail = useQuery({ queryKey: ['collection', cid], queryFn: () => get<any>(`/collections/${cid}`), enabled: !!cid });
  const list: MediaItem[] = (detail.data?.media ?? []).filter((m: MediaItem) => m.status === 'ready' && (!onlySelected || m.selection === 'selected') && !chosen.includes(m.id));
  const toggle = (m: MediaItem) => setPicked((p) => (p.some((x) => x.id === m.id) ? p.filter((x) => x.id !== m.id) : [...p, m]));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Medien übernehmen"
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!picked.length} onClick={() => (onAdd(picked), onClose())}>
            {picked.length} übernehmen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3 items-end">
          <FieldWrap label="Sammlung" htmlFor="mp-c" className="min-w-[240px] flex-1">
            <Select id="mp-c" value={cid} onChange={(e) => setCid(e.target.value)}>
              <option value="">– wählen –</option>
              {collections.length > 0 && (
                <optgroup label="Zu diesem Beitrag">
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Alle Sammlungen">
                {(all.data ?? []).filter((c) => !collections.some((x) => x.id === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </optgroup>
            </Select>
          </FieldWrap>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> nur ausgewählte
          </label>
        </div>
        {cid && list.length === 0 && <p className="m-0 text-sm text-fg-muted">Keine passenden Dateien. {onlySelected && 'Bitte zuerst in der Sammlung sichten und auswählen.'}</p>}
        <ul className="m-0 p-0 list-none grid gap-2 grid-cols-3 sm:grid-cols-4">
          {list.map((m) => {
            const on = picked.some((x) => x.id === m.id);
            return (
              <li key={m.id}>
                <button type="button" aria-pressed={on} onClick={() => toggle(m)} className={cx('block w-full rounded-control overflow-hidden border-2 relative', on ? 'border-primary' : 'border-transparent')}>
                  {m.has_preview ? <img src={`/api/v1/media/${m.id}/preview`} alt={m.original_name} className="w-full aspect-square object-cover" /> : <div className="aspect-square bg-raised flex items-center justify-center"><Icon name="Film" /></div>}
                  {on && <span className="absolute top-1 right-1 bg-primary-solid text-white rounded-full p-0.5"><Icon name="Check" size={14} /></span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

export default function PostEditor() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({
    queryKey: ['post', id],
    queryFn: () => get<PostDetail>(`/posts/${id}`),
    refetchInterval: (query) => (['publishing', 'unknown'].includes(query.state.data?.state ?? '') ? 5000 : false),
  });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mediaCache, setMediaCache] = useState<Record<string, MediaItem>>({});
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [collectLink, setCollectLink] = useState<{ url: string; expires_at: string } | null>(null);
  usePageMeta({ title: q.data?.revision.title, crumb: q.data?.revision.title });

  const d = q.data;
  useEffect(() => {
    if (!d) return;
    setDraft({ title: d.revision.title, body: d.revision.body, excerpt: d.revision.excerpt, mediaIds: d.revision.media_ids, coverId: d.revision.cover_id, siteId: d.revision.site_id });
    setMediaCache((c) => ({ ...c, ...Object.fromEntries(d.media.map((m) => [m.id, m])) }));
  }, [d?.revision.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!d || !draft) return false;
    const r = d.revision;
    return draft.title !== r.title || draft.body !== r.body || draft.excerpt !== r.excerpt || JSON.stringify(draft.mediaIds) !== JSON.stringify(r.media_ids) || draft.coverId !== r.cover_id || draft.siteId !== r.site_id;
  }, [d, draft]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (q.isLoading || !draft) return <SkeletonRows rows={8} />;
  if (q.error) return <ErrorBox title="Beitrag konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const r = d!.revision;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['post', id] }), qc.invalidateQueries({ queryKey: ['posts'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })]);
  const editable = can('post.edit');
  const activeSites = (sites.data ?? []).filter((s) => s.status === 'active');
  const site = (sites.data ?? []).find((s) => s.id === r.site_id);

  const save = async () => {
    setSaving(true);
    try {
      const res = await put<any>(`/posts/${id}/revision`, { baseRevision: r.number, ...draft });
      if (res.changed) toast({ tone: 'success', title: `Fassung ${res.number} gespeichert`, text: res.approvalInvalidated ? 'Die bisherige Freigabe gilt nicht für die neue Fassung.' : undefined });
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast({ tone: 'warning', title: 'Beitrag wurde inzwischen geändert', text: e.message });
      else toastError(e);
    } finally {
      setSaving(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ tone: 'success', title: ok });
    } catch (e) {
      toastError(e);
    }
    await refresh();
  };
  const move = (i: number, dir: -1 | 1) =>
    setDraft((dr) => {
      if (!dr) return dr;
      const ids = [...dr.mediaIds];
      const j = i + dir;
      if (j < 0 || j >= ids.length) return dr;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...dr, mediaIds: ids };
    });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d!.state} />
            <span>{KIND_LABEL[d!.post.kind]}</span>
            <span>· Fassung {r.number}</span>
            <span>· geändert {fmtRelative(r.created_at)}</span>
          </span>
        }
        actions={
          <>
            {can('media.manage') && (
              <Button
                icon="Camera"
                onClick={async () => {
                  try {
                    setCollectLink(await post<any>(`/posts/${id}/collect`, {}));
                    refresh();
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Fotos und Videos sammeln
              </Button>
            )}
            {editable && (
              <Button variant="primary" icon="Save" loading={saving} disabled={!dirty} onClick={save}>
                {dirty ? 'Neue Fassung speichern' : 'Gespeichert'}
              </Button>
            )}
          </>
        }
      />
      {dirty && d!.approval && <Notice tone="warning">Die Fassung {r.number} ist freigegeben. Speichern erzeugt eine neue Fassung, die erneut freigegeben werden muss.</Notice>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Card title="Text">
            <div className="flex flex-col gap-4">
              <FieldWrap label="Titel" required htmlFor="e-title">
                <Input id="e-title" value={draft.title} disabled={!editable} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} />
              </FieldWrap>
              <FieldWrap label="Text" help="Absätze durch eine Leerzeile trennen. Die Website übernimmt den Text als einfache Absätze." htmlFor="e-body">
                <Textarea id="e-body" rows={12} value={draft.body} disabled={!editable} onChange={(e) => setDraft({ ...draft, body: e.target.value })} maxLength={50000} />
              </FieldWrap>
              <FieldWrap label="Kurzfassung (optional)" htmlFor="e-excerpt">
                <Textarea id="e-excerpt" rows={2} value={draft.excerpt} disabled={!editable} onChange={(e) => setDraft({ ...draft, excerpt: e.target.value })} maxLength={1000} />
              </FieldWrap>
              <FieldWrap label="Art" htmlFor="e-kind">
                <Select id="e-kind" value={d!.post.kind} disabled={!editable} onChange={(e) => act(() => patch(`/posts/${id}`, { kind: e.target.value }))}>
                  {Object.entries(KIND_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </FieldWrap>
            </div>
          </Card>

          <Card
            title="Medien"
            subtitle="Öffentlich verwendet wird eine geprüfte Fassung ohne Standortdaten."
            action={
              editable && (
                <Button size="sm" icon="Plus" onClick={() => setPicker(true)}>
                  Medien übernehmen
                </Button>
              )
            }
          >
            {draft.mediaIds.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine Medien. Über „Fotos und Videos sammeln“ einen Upload-Link erzeugen, sichten und ausgewählte Dateien hier übernehmen.</p>
            ) : (
              <ul className="m-0 p-0 list-none grid gap-3 grid-cols-2 sm:grid-cols-3">
                {draft.mediaIds.map((mid, i) => {
                  const m = mediaCache[mid];
                  return (
                    <li key={mid} className={cx('border rounded-card overflow-hidden', draft.coverId === mid ? 'border-primary' : 'border-line')}>
                      {m?.has_preview ? <img src={`/api/v1/media/${mid}/preview`} alt={m.original_name} className="w-full aspect-[4/3] object-cover" /> : <div className="aspect-[4/3] bg-raised flex items-center justify-center"><Icon name="Film" /></div>}
                      <div className="p-2 flex items-center gap-1 flex-wrap text-sm">
                        {draft.coverId === mid ? (
                          <Badge tone="primary">Titelbild</Badge>
                        ) : (
                          editable && m?.kind === 'image' && (
                            <Button size="sm" onClick={() => setDraft({ ...draft, coverId: mid })}>
                              Als Titelbild
                            </Button>
                          )
                        )}
                        {editable && (
                          <span className="ml-auto flex gap-1">
                            <Button size="sm" iconOnly icon="ArrowUp" aria-label="Nach vorne" disabled={i === 0} onClick={() => move(i, -1)} />
                            <Button size="sm" iconOnly icon="ArrowDown" aria-label="Nach hinten" disabled={i === draft.mediaIds.length - 1} onClick={() => move(i, 1)} />
                            <Button size="sm" iconOnly icon="X" aria-label="Entfernen" onClick={() => setDraft({ ...draft, mediaIds: draft.mediaIds.filter((x) => x !== mid), coverId: draft.coverId === mid ? null : draft.coverId })} />
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Zielkanal">
            <FieldWrap label="Veröffentlichen auf" help="Ohne Zielkanal bleibt der Beitrag intern. Eine Änderung des Zielkanals verlangt eine neue Freigabe." htmlFor="e-site">
              <Select id="e-site" value={draft.siteId ?? ''} disabled={!editable} onChange={(e) => setDraft({ ...draft, siteId: e.target.value || null })}>
                <option value="">Nur intern (keine Veröffentlichung)</option>
                {activeSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    WordPress: {s.name}
                  </option>
                ))}
              </Select>
            </FieldWrap>
            {activeSites.length === 0 && <p className="m-0 mt-2 text-sm text-fg-muted">Noch keine Website gekoppelt. {can('channel.manage') && <Link to="/kanaele">Website koppeln</Link>}</p>}
          </Card>
        </div>

        <div className="flex flex-col gap-5 order-first lg:order-none">
          <Card title="Freigabe und Veröffentlichung">
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={d!.state} />
                <span className="text-fg-muted">Fassung {r.number}</span>
              </div>
              {dirty && <Notice tone="primary">Erst speichern – Freigaben beziehen sich immer auf eine gespeicherte Fassung.</Notice>}
              {d!.state === 'draft' && editable && !dirty && (
                <Button variant="primary" icon="Send" onClick={() => act(() => post(`/posts/${id}/submit`, { revision: r.number }), 'Zur Freigabe eingereicht')}>
                  Zur Freigabe einreichen
                </Button>
              )}
              {d!.state === 'rejected' && d!.lastDecision && (
                <Notice tone="error" title={`Zurückgewiesen von ${d!.lastDecision.decided_by_name}`}>
                  {d!.lastDecision.note}
                </Notice>
              )}
              {d!.state === 'rejected' && editable && !dirty && (
                <Button icon="Send" onClick={() => act(() => post(`/posts/${id}/submit`, { revision: r.number }), 'Erneut eingereicht')}>
                  Unverändert erneut einreichen
                </Button>
              )}
              {d!.state === 'in_review' && (
                <>
                  <p className="m-0 text-fg-muted">Eingereicht {fmtRelative(r.submitted_at)}.</p>
                  {can('post.approve') && !dirty && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button icon="X" onClick={() => setDecision('rejected')}>
                        Zurückweisen
                      </Button>
                      <Button variant="primary" icon="Check" onClick={() => setDecision('approved')}>
                        Freigeben
                      </Button>
                    </div>
                  )}
                </>
              )}
              {d!.approval && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-ok font-medium">
                    <Icon name="ShieldCheck" size={15} /> Freigegeben von {d!.approval.decided_by_name}
                  </div>
                  <div className="text-fg-muted">
                    {fmtDateTime(d!.approval.decided_at)} · Prüfsumme <code>{r.content_hash.slice(0, 10)}</code>
                  </div>
                  {d!.approval.note && <div>„{d!.approval.note}“</div>}
                </div>
              )}
              {d!.state === 'approved' && !r.site_id && <Notice tone="success">Intern freigegeben. Für eine Veröffentlichung einen Zielkanal wählen und erneut freigeben lassen.</Notice>}
              {d!.state === 'approved' && r.site_id && can('post.publish') && !dirty && (
                <Button variant="primary" icon="Globe" onClick={() => act(() => post(`/posts/${id}/publish`, { revision: r.number, contentHash: r.content_hash }), 'Veröffentlichung beauftragt')}>
                  Auf {site?.name ?? 'Website'} veröffentlichen
                </Button>
              )}
              {d!.approval && can('post.approve') && !['publishing', 'published'].includes(d!.state) && (
                <Button size="sm" variant="ghost" onClick={() => act(() => post(`/posts/${id}/approval/revoke`), 'Freigabe zurückgezogen')}>
                  Freigabe zurückziehen
                </Button>
              )}
            </div>
          </Card>

          <Card title="Veröffentlichungen">
            {d!.publications.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine.</p>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col gap-3 text-sm">
                {d!.publications.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={p.status} />
                      <span>{p.site_name}</span>
                      <span className="text-fg-muted">Fassung {p.revision_number}</span>
                    </div>
                    {p.remote_url && (
                      <>
                        <a href={p.remote_url} target="_blank" rel="noopener noreferrer" className="break-all">
                          {p.remote_url}
                        </a>
                        <ShareActions compact target={{ url: p.remote_url, title: r.title, purpose: 'Beitrag lesen' }} />
                      </>
                    )}
                    <div className="text-meta text-fg-muted">
                      beauftragt {fmtDateTime(p.created_at)}
                      {p.created_by_name ? ` von ${p.created_by_name}` : ''}
                      {p.fetched_at && ` · abgeholt ${fmtDateTime(p.fetched_at)}`}
                      {p.result_at && ` · Rückmeldung ${fmtDateTime(p.result_at)}`}
                    </div>
                    {p.status === 'unknown' && <div className="text-warn">Die Website hat noch kein Ergebnis gemeldet. Die Bridge prüft beim nächsten Abruf, ob der Beitrag bereits existiert.</div>}
                    {p.error && <div className="text-err">{p.error}</div>}
                    <div className="flex gap-2">
                      {p.status === 'failed' && can('post.publish') && (
                        <Button size="sm" icon="RefreshCw" onClick={() => act(() => post(`/publications/${p.id}/retry`), 'Erneut beauftragt')}>
                          Erneut versuchen
                        </Button>
                      )}
                      {p.status === 'queued' && can('post.publish') && (
                        <Button size="sm" onClick={() => act(() => post(`/publications/${p.id}/cancel`), 'Auftrag abgebrochen')}>
                          Abbrechen
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {d!.collections.length > 0 && (
            <Card title="Sammlungen">
              <ul className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
                {d!.collections.map((c) => (
                  <li key={c.id}>
                    <Link to={`/medien/${c.id}`}>{c.title}</Link>
                    <span className="text-fg-muted">
                      {' '}
                      · {c.media_count} Dateien · {c.selected_count} ausgewählt
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Fassungen">
            <ol className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
              {d!.revisions.map((v) => (
                <li key={v.id} className="flex items-start gap-2">
                  <span className="font-mono text-fg-muted w-8 shrink-0">#{v.number}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{v.title}</span>
                    <span className="text-meta text-fg-muted">
                      {fmtDateTime(v.created_at)} · {v.created_by_name ?? '–'}
                      {v.decision === 'approved' && ' · freigegeben'}
                      {v.decision === 'rejected' && ' · zurückgewiesen'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      {picker && (
        <MediaPicker
          collections={d!.collections}
          chosen={draft.mediaIds}
          onClose={() => setPicker(false)}
          onAdd={(ms) => {
            setMediaCache((c) => ({ ...c, ...Object.fromEntries(ms.map((m) => [m.id, m])) }));
            setDraft((dr) => (dr ? { ...dr, mediaIds: [...dr.mediaIds, ...ms.map((m) => m.id)], coverId: dr.coverId ?? ms.find((m) => m.kind === 'image')?.id ?? null } : dr));
          }}
        />
      )}
      {decision && <DecisionDialog decision={decision} revision={r.number} hash={r.content_hash} postId={id} onClose={() => (setDecision(null), refresh())} />}
      {collectLink && (
        <Dialog open onClose={() => setCollectLink(null)} title="Fotos und Videos sammeln" width={560}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm">Eine Sammlung zum Beitrag wurde angelegt. Teile den Link oder hänge den QR-Code aus – Hochladen geht ohne Konto.</p>
            <code className="text-sm break-all bg-raised rounded-control p-2">{collectLink.url}</code>
            <ShareActions target={{ url: collectLink.url, title: r.title, purpose: 'Fotos und Videos hochladen', validUntil: collectLink.expires_at, sensitive: 'Jede Person mit diesem Link kann bis zum Ablauf Dateien hochladen. Der Link lässt sich in der Sammlung widerrufen.' }} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function DecisionDialog({ decision, revision, hash, postId, onClose }: { decision: 'approved' | 'rejected'; revision: number; hash: string; postId: string; onClose: () => void }) {
  const toastError = useErrorToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={decision === 'approved' ? `Fassung ${revision} freigeben` : `Fassung ${revision} zurückweisen`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant={decision === 'approved' ? 'primary' : 'danger'}
            loading={busy}
            disabled={decision === 'rejected' && !note.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/posts/${postId}/decision`, { revision, contentHash: hash, decision, note: note.trim() });
                onClose();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            {decision === 'approved' ? 'Freigeben' : 'Zurückweisen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          Die Entscheidung gilt genau für Fassung {revision} (Prüfsumme <code>{hash.slice(0, 10)}</code>). Jede spätere Änderung an Text, Medien oder Zielkanal braucht eine neue Freigabe.
        </p>
        <FieldWrap label={decision === 'approved' ? 'Anmerkung (optional)' : 'Begründung'} required={decision === 'rejected'} htmlFor="dec-note">
          <Textarea id="dec-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}
