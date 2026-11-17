import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, patch, post, put } from '../../api/client';
import type { MediaItem, Publication, Site } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { ShareActions } from '../../components/share';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Input, Notice, PageHeader, Rev, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, UnsavedChangesGuard, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative, fromLocalInput, toLocalInput } from '../../lib/format';
import { KIND_LABEL } from './Posts';
import { cleanFormats, SocialStatusCard, SocialTargetsCard } from './SocialPanel';
import { safeHref } from '../../lib/url';
import { openFaces, PrivacyDialog, SENSITIVE_LABELS } from '../media/PrivacyDialog';
import { ImageFillDialog } from '../designs/ImageFill';
import { DecisionDialog } from './DecisionDialog';
import { WpCategoryPicker } from '../channels/WpCategories';
import { HelpTip } from '../../components/ui/HelpTip';
import { ReadabilityPanel } from './Readability';

interface PostDetail {
  post: { id: string; kind: string; created_at: string; created_by_name: string | null; archived: boolean; current_revision: number };
  state: string;
  revision: { id: string; number: number; title: string; body: string; excerpt: string; media_ids: string[]; cover_id: string | null; site_id: string | null; variants: any; social_targets: string[]; social_formats?: Record<string, string>; media_alt?: Record<string, string>; publish_at: string | null; content_hash: string; submitted_at: string | null; created_at: string };
  media: MediaItem[];
  /** inzwischen gelöschte Dateien der Fassung (#167) */
  missing_media?: number;
  /** Barrierefreiheit (#217): Bilder ohne Alternativtext */
  accessibility?: { applies: boolean; missing: string[]; required: boolean };
  approval: { decided_by_name: string; decided_at: string; note: string } | null;
  lastDecision: { decision: string; note: string; decided_by_name: string; decided_at: string } | null;
  revisions: { id: string; number: number; title: string; change_note: string; created_at: string; created_by_name: string | null; decision: string | null }[];
  publications: Publication[];
  collections: { id: string; title: string; media_count: number; selected_count: number }[];
  social: any[];
}

interface Draft {
  title: string;
  body: string;
  excerpt: string;
  mediaIds: string[];
  coverId: string | null;
  siteId: string | null;
  wp: { title: string; body: string; excerpt: string; categories: number[] };
  publishAt: string; // datetime-local, leer = sofort
  social: string[];
  formats: Record<string, string>;
  fb: string;
  ig: string;
  th: string;
  xt: string;
  wa: string;
  md: string;
  mdCw: string;
  bs: string;
  /** Alternativtext je Bild (#217); fehlt ein Eintrag, gilt der Text aus der Medienverwaltung */
  mediaAlt: Record<string, string>;
}

/** Alternativtexte zum Vergleichen und Speichern: nur Dateien der Fassung, getrimmt, ohne leere. */
const cleanAlt = (a: Record<string, string> | undefined, ids: string[]) => Object.fromEntries([...ids].sort().map((id) => [id, (a?.[id] ?? '').replace(/\s+/g, ' ').trim()]).filter(([, v]) => v));

const emptyWp = { title: '', body: '', excerpt: '', categories: [] as number[] };
/** Kategorien geordnet – gleiche Auswahl in anderer Reihenfolge ist keine Änderung (#186). */
const sortCats = (c: unknown) => (Array.isArray(c) ? [...new Set(c.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : []);
const wpOf = (v: any) => ({ title: v?.wordpress?.title ?? '', body: v?.wordpress?.body ?? '', excerpt: v?.wordpress?.excerpt ?? '', categories: sortCats(v?.wordpress?.categories) });
/** Website-Fassung zählt nur mit Zielkanal – sonst ist sie unsichtbar und darf keine neue Fassung auslösen. */
const NO_WP = { title: '', body: '', excerpt: '', categories: [] as number[] };

/** Einfache Absätze wie auf der Website (Leerzeile = neuer Absatz). */
function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <p className="m-0 text-fg-muted">Noch kein Text.</p>;
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className="m-0 whitespace-pre-line">
          {p}
        </p>
      ))}
    </>
  );
}

export function MediaPicker({ collections, chosen, onClose, onAdd }: { collections: PostDetail['collections']; chosen: string[]; onClose: () => void; onAdd: (m: MediaItem[]) => void }) {
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
                <button type="button" aria-pressed={on} onClick={() => toggle(m)} className={cx('block w-full rounded-control overflow-hidden border-2 relative', on ? 'border-primary bg-primary-soft shadow-selected' : 'border-transparent')}>
                  {m.has_preview ? <img decoding="async" src={`/api/v1/media/${m.id}/preview`} alt={m.original_name} className="w-full aspect-square object-cover" /> : <div className="aspect-square bg-raised flex items-center justify-center"><Icon name="Film" /></div>}
                  {on && <span className="absolute top-1 right-1 bg-card text-fg border border-primary rounded-full p-0.5"><Icon name="Check" size={14} /></span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

/** Bei Wechsel auf einen anderen Beitrag frisch beginnen (kein Zustand des vorherigen). */
export default function PostEditor() {
  const { id = '' } = useParams();
  return <PostEditorInner key={id} id={id} />;
}

function PostEditorInner({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({
    queryKey: ['post', id],
    queryFn: () => get<PostDetail>(`/posts/${id}`),
    refetchInterval: (query) => (['publishing', 'unknown'].includes(query.state.data?.state ?? '') ? 5000 : false),
  });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites'), enabled: can('channel.view') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mediaCache, setMediaCache] = useState<Record<string, MediaItem>>({});
  const [fromTemplate, setFromTemplate] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [collectLink, setCollectLink] = useState<{ url: string; expires_at: string } | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const [resolving, setResolving] = useState<Publication | null>(null);
  // Gesichtsvorschläge direkt aus dem Beitrag prüfen (#214): volle Mediendaten für den Datenschutz-Dialog
  const [privacyMedia, setPrivacyMedia] = useState<MediaItem | null>(null);
  usePageMeta({ title: q.data?.revision.title });

  const d = q.data;
  type Rev = NonNullable<typeof d>['revision'];
  const fromRev = (r: Rev): Draft => ({ title: r.title, body: r.body, excerpt: r.excerpt, mediaIds: r.media_ids, coverId: r.cover_id, siteId: r.site_id, wp: wpOf(r.variants), publishAt: toLocalInput(r.publish_at), social: r.social_targets ?? [], formats: r.social_formats ?? {}, fb: r.variants?.facebook?.body ?? '', ig: r.variants?.instagram?.body ?? '', th: r.variants?.threads?.body ?? '', xt: r.variants?.x?.body ?? '', wa: r.variants?.whatsapp?.body ?? '', md: r.variants?.mastodon?.body ?? '', mdCw: r.variants?.mastodon?.cw ?? '', bs: r.variants?.bluesky?.body ?? '', mediaAlt: r.media_alt ?? {} });
  const differs = (dr: Draft, r: Rev) =>
    dr.title !== r.title ||
    dr.body !== r.body ||
    dr.excerpt !== r.excerpt ||
    JSON.stringify(dr.mediaIds) !== JSON.stringify(r.media_ids) ||
    dr.coverId !== r.cover_id ||
    dr.siteId !== r.site_id ||
    JSON.stringify(dr.siteId ? { ...dr.wp, categories: sortCats(dr.wp.categories) } : NO_WP) !== JSON.stringify(r.site_id ? wpOf(r.variants) : NO_WP) ||
    dr.publishAt !== toLocalInput(r.publish_at) ||
    JSON.stringify([...dr.social].sort()) !== JSON.stringify([...(r.social_targets ?? [])].sort()) ||
    JSON.stringify(cleanFormats(dr.formats, dr.social)) !== JSON.stringify(cleanFormats(r.social_formats, r.social_targets ?? [])) ||
    dr.fb !== (r.variants?.facebook?.body ?? '') ||
    dr.ig !== (r.variants?.instagram?.body ?? '') ||
    dr.th !== (r.variants?.threads?.body ?? '') ||
    dr.xt !== (r.variants?.x?.body ?? '') ||
    dr.wa !== (r.variants?.whatsapp?.body ?? '') ||
    dr.md !== (r.variants?.mastodon?.body ?? '') ||
    dr.mdCw !== (r.variants?.mastodon?.cw ?? '') ||
    dr.bs !== (r.variants?.bluesky?.body ?? '') ||
    JSON.stringify(cleanAlt(dr.mediaAlt, dr.mediaIds)) !== JSON.stringify(cleanAlt(r.media_alt, r.media_ids));
  // Fassung, auf der der Entwurf beruht. Speichert jemand anderes eine neue Fassung, werden ungespeicherte
  // Änderungen nicht überschrieben (#59) – stattdessen Hinweis; Speichern führt dann zum 409-Konflikt.
  const [base, setBase] = useState<Rev | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!d) return;
    setMediaCache((c) => ({ ...c, ...Object.fromEntries(d.media.map((m) => [m.id, m])) }));
    if (draft && base && base.id !== d.revision.id && differs(draft, base) && differs(draft, d.revision)) {
      setStale(true);
      return;
    }
    setDraft(fromRev(d.revision));
    setBase(d.revision);
    setStale(false);
  }, [d?.revision.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !!draft && !!base && differs(draft, base), [draft, base]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <ErrorBox title="Beitrag konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  if (q.isLoading || !draft) return <SkeletonRows rows={8} />;
  const r = d!.revision;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['post', id] }), qc.invalidateQueries({ queryKey: ['posts'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })]);
  const editable = can('post.edit');
  const openPrivacy = async (mid: string) => {
    try {
      setPrivacyMedia((await get<{ media: MediaItem }>(`/media/${mid}/details`)).media);
    } catch (e) {
      toastError(e);
    }
  };
  const activeSites = (sites.data ?? []).filter((s) => s.status === 'active');
  const site = (sites.data ?? []).find((s) => s.id === r.site_id);

  const save = async () => {
    setSaving(true);
    try {
      const { wp, publishAt, social, formats, fb, ig, th, xt, wa, md, mdCw, bs, mediaAlt, ...rest } = draft;
      const res = await put<any>(`/posts/${id}/revision`, {
        baseRevision: (base ?? r).number,
        ...rest,
        variants: { ...(rest.siteId ? { wordpress: wp } : {}), ...(fb.trim() ? { facebook: { body: fb } } : {}), ...(ig.trim() ? { instagram: { body: ig } } : {}), ...(th.trim() ? { threads: { body: th } } : {}), ...(xt.trim() ? { x: { body: xt } } : {}), ...(wa.trim() ? { whatsapp: { body: wa } } : {}), ...(md.trim() || mdCw.trim() ? { mastodon: { ...(md.trim() ? { body: md } : {}), ...(mdCw.trim() ? { cw: mdCw } : {}) } } : {}), ...(bs.trim() ? { bluesky: { body: bs } } : {}) },
        socialTargets: social,
        socialFormats: cleanFormats(formats, social),
        // Alternativtext je Bild: eigener Text, sonst der aus der Medienverwaltung – beides wird Teil der Fassung
        mediaAlt: cleanAlt(Object.fromEntries(rest.mediaIds.filter((x) => mediaCache[x]?.kind === 'image').map((x) => [x, mediaAlt[x] ?? mediaCache[x]?.alt_text ?? ''])), rest.mediaIds),
        publishAt: publishAt ? fromLocalInput(publishAt) : null,
      });
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
    <div className={cx('flex flex-col gap-5', editable && dirty && 'pb-24 md:pb-0')}>
      <UnsavedChangesGuard when={dirty} text="Der Beitrag hat ungespeicherte Änderungen. Beim Verlassen gehen sie verloren." />
      <PageHeader
        title={r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d!.state} />
            <span>{KIND_LABEL[d!.post.kind]}</span>
            <span>· <Rev n={r.number} /></span>
            <span>· geändert {fmtRelative(r.created_at)}</span>
          </span>
        }
        actions={
          <>
            {can('media.collections') && (
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
      {stale && (
        <Notice tone="warning">
          Inzwischen wurde eine neuere Fassung ({r.number}) gespeichert. Die ungespeicherten Änderungen beruhen auf Fassung {base?.number}; Speichern wird deshalb abgelehnt.{' '}
          <Button size="sm" onClick={() => (setDraft(fromRev(r)), setBase(r), setStale(false))}>
            Neue Fassung laden (eigene Änderungen verwerfen)
          </Button>
        </Notice>
      )}
      {!!d!.missing_media && (
        <Notice tone="error" title="Dateien fehlen">
          {d!.missing_media === 1 ? 'Eine Datei' : `${d!.missing_media} Dateien`} dieser Fassung {d!.missing_media === 1 ? 'wurde' : 'wurden'} inzwischen gelöscht (z. B. durch eine Löschfrist oder eine Datenschutzanfrage). Freigeben und Veröffentlichen sind gesperrt. Bitte die fehlenden Dateien aus der Fassung nehmen oder ersetzen, speichern und erneut freigeben lassen.{' '}
          {editable && draft && (
            <Button
              size="sm"
              onClick={() => {
                const present = new Set(d!.media.filter((m: any) => !m.deleted_at).map((m) => m.id));
                setDraft({ ...draft, mediaIds: draft.mediaIds.filter((x) => present.has(x)), coverId: draft.coverId && present.has(draft.coverId) ? draft.coverId : null });
              }}
            >
              Fehlende Dateien entfernen
            </Button>
          )}
        </Notice>
      )}
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
              <ReadabilityPanel text={draft.body} />
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
              editable &&
              (can('media.view') || can('templates.use')) && (
                <div className="flex flex-wrap gap-2">
                  {can('templates.use') && (
                    <Button size="sm" icon="ImageUp" onClick={() => setFromTemplate(true)}>
                      Bild aus Vorlage
                    </Button>
                  )}
                  {can('media.view') && (
                    <Button size="sm" icon="Plus" onClick={() => setPicker(true)}>
                      Medien übernehmen
                    </Button>
                  )}
                </div>
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
                    <li
                      key={mid}
                      draggable={editable}
                      onDragStart={() => setDragIdx(i)}
                      onDragOver={(e) => dragIdx !== null && dragIdx !== i && e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragIdx === null || dragIdx === i) return;
                        const ids = [...draft.mediaIds];
                        const [moved] = ids.splice(dragIdx, 1);
                        ids.splice(i, 0, moved);
                        setDraft({ ...draft, mediaIds: ids });
                        setDragIdx(null);
                      }}
                      onDragEnd={() => setDragIdx(null)}
                      className={cx('border rounded-card overflow-hidden', draft.coverId === mid ? 'border-primary' : 'border-line', dragIdx === i && 'opacity-50', editable && 'cursor-grab')}
                    >
                      {m?.has_preview ? <img decoding="async" src={`/api/v1/media/${mid}/preview`} alt={m.original_name} className="w-full aspect-[4/3] object-cover" /> : <div className="aspect-[4/3] bg-raised flex items-center justify-center"><Icon name="Film" /></div>}
                      {m?.kind === 'image' && (
                        <div className="px-2 pt-2">
                          <FieldWrap label="Alternativtext" required={!!d!.accessibility?.required && !!d!.accessibility?.applies} htmlFor={`alt-${mid}`} labelAction={i === 0 ? (
                            <HelpTip title="Alternativtext" more="/hilfe/beitraege#alternativtext">
                              <p className="m-0">Beschreibt das Bild für Menschen, die es nicht sehen – Screenreader lesen ihn vor. Website, Facebook, Instagram, Threads, X (über die API), Mastodon und Bluesky übernehmen ihn.</p>
                              <p className="m-0">Kurz und sachlich: was zu sehen ist und warum es wichtig ist. Nicht „Bild von …“, keine Namen von Personen.</p>
                            </HelpTip>
                          ) : undefined}>
                            <Textarea id={`alt-${mid}`} rows={2} maxLength={1000} disabled={!editable} value={draft.mediaAlt[mid] ?? m.alt_text ?? ''} placeholder="Was ist zu sehen?" onChange={(e) => setDraft({ ...draft, mediaAlt: { ...draft.mediaAlt, [mid]: e.target.value } })} className={cx(!(draft.mediaAlt[mid] ?? m.alt_text ?? '').trim() && 'border-warn')} />
                          </FieldWrap>
                        </div>
                      )}
                      <div className="p-2 flex items-center gap-1 flex-wrap text-sm">
                        {!!m?.sensitive_flags?.length && (
                          <Badge tone="warning" title={m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')}>
                            Markiert
                          </Badge>
                        )}
                        {openFaces(m) > 0 &&
                          (can('media.redact') ? (
                            <Button size="sm" icon="ScanFace" onClick={() => void openPrivacy(mid)}>
                              {openFaces(m) === 1 ? 'Gesicht prüfen' : `${openFaces(m)} Gesichter prüfen`}
                            </Button>
                          ) : (
                            <Badge tone="warning">{openFaces(m) === 1 ? '1 Gesichtsvorschlag offen' : `${openFaces(m)} Gesichtsvorschläge offen`}</Badge>
                          ))}
                        {draft.coverId === mid ? (
                          <Badge>Titelbild</Badge>
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
                            <Button size="sm" iconOnly icon="X" aria-label="Entfernen" onClick={() => {
                              // Titelbild entfernt: nächstes Bild der Liste wird Titelbild (statt gar keins)
                              const rest = draft.mediaIds.filter((x) => x !== mid);
                              setDraft({ ...draft, mediaIds: rest, coverId: draft.coverId === mid ? (rest.find((x) => mediaCache[x]?.kind === 'image') ?? null) : draft.coverId });
                            }} />
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
              <Select id="e-site" value={draft.siteId ?? ''} disabled={!editable} onChange={(e) => setDraft({ ...draft, siteId: e.target.value || null, wp: { ...draft.wp, categories: [] } })}>
                <option value="">Nur intern (keine Veröffentlichung)</option>
                {/* Ohne „Websites ansehen“ fehlt die Liste – den gespeicherten Zielkanal trotzdem zeigen */}
                {!can('channel.view') && draft.siteId && <option value={draft.siteId}>WordPress</option>}
                {activeSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    WordPress: {s.name}
                  </option>
                ))}
              </Select>
            </FieldWrap>
            {sites.data && activeSites.length === 0 && <p className="m-0 mt-2 text-sm text-fg-muted">Noch keine Website gekoppelt. {can('channel.sites') && <Link to="/websites">Website koppeln</Link>}</p>}
            {draft.siteId && (
              <div className="flex flex-col gap-4 mt-4">
                <FieldWrap label="Termin (optional)" help="Leer = sofort nach dem Veröffentlichen. Der Termin ist Teil der freigegebenen Fassung." htmlFor="e-at">
                  <Input id="e-at" type="datetime-local" value={draft.publishAt} disabled={!editable} onChange={(e) => setDraft({ ...draft, publishAt: e.target.value })} className="max-w-[260px]" />
                </FieldWrap>
                <WpCategoryPicker categories={(sites.data ?? []).find((s) => s.id === draft.siteId)?.report?.categories} value={draft.wp.categories} disabled={!editable} onChange={(categories) => setDraft({ ...draft, wp: { ...draft.wp, categories } })} help="Ohne Auswahl gilt die Standardkategorie der Website. Die Kategorie ist Teil der freigegebenen Fassung." />
                <details className="border border-line rounded-card p-3" open={!!(draft.wp.title || draft.wp.body || draft.wp.excerpt)}>
                  <summary className="cursor-pointer font-medium text-sm">Eigener Text für die Website (optional)</summary>
                  <div className="flex flex-col gap-3 mt-3">
                    <p className="m-0 text-meta text-fg-muted">Leere Felder übernehmen den Grundtext.</p>
                    <FieldWrap label="Titel auf der Website" htmlFor="wp-title">
                      <Input id="wp-title" value={draft.wp.title} disabled={!editable} placeholder={draft.title} onChange={(e) => setDraft({ ...draft, wp: { ...draft.wp, title: e.target.value } })} maxLength={200} />
                    </FieldWrap>
                    <FieldWrap label="Text auf der Website" htmlFor="wp-body">
                      <Textarea id="wp-body" rows={6} value={draft.wp.body} disabled={!editable} onChange={(e) => setDraft({ ...draft, wp: { ...draft.wp, body: e.target.value } })} maxLength={50000} />
                    </FieldWrap>
                    <FieldWrap label="Kurzfassung auf der Website" htmlFor="wp-excerpt">
                      <Textarea id="wp-excerpt" rows={2} value={draft.wp.excerpt} disabled={!editable} onChange={(e) => setDraft({ ...draft, wp: { ...draft.wp, excerpt: e.target.value } })} maxLength={1000} />
                    </FieldWrap>
                  </div>
                </details>
              </div>
            )}
          </Card>

          <SocialTargetsCard draft={{ social: draft.social, formats: draft.formats, fb: draft.fb, ig: draft.ig, th: draft.th, xt: draft.xt, wa: draft.wa, md: draft.md, mdCw: draft.mdCw, bs: draft.bs }} editable={editable} onChange={(x) => setDraft({ ...draft, ...x })} />

          <Card title="Vorschau" subtitle={draft.siteId ? 'So erscheint der Beitrag auf der Website (Darstellung abhängig vom Theme).' : 'Interne Ansicht'}>
            <article className="flex flex-col gap-3 max-w-[680px]">
              <h2 className="m-0 text-title font-semibold">{(draft.siteId && draft.wp.title) || draft.title}</h2>
              {draft.coverId && mediaCache[draft.coverId]?.has_preview && <img src={`/api/v1/media/${draft.coverId}/preview`} alt="" className="w-full rounded-control" />}
              <div className="flex flex-col gap-3 text-base leading-relaxed">
                <Paragraphs text={(draft.siteId && draft.wp.body) || draft.body} />
              </div>
            </article>
          </Card>
        </div>

        <div className="flex flex-col gap-5 order-first lg:order-none">
          <Card title="Freigabe und Veröffentlichung">
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={d!.state} />
                <Rev n={r.number} className="text-fg-muted" />
              </div>
              {dirty && <Notice>Erst speichern – Freigaben beziehen sich immer auf eine gespeicherte Fassung.</Notice>}
              {d!.state === 'draft' && can('post.submit') && !dirty && (
                <Button variant="primary" icon="Send" onClick={() => act(() => post(`/posts/${id}/submit`, { revision: r.number }), 'Zur Freigabe eingereicht')}>
                  Zur Freigabe einreichen
                </Button>
              )}
              {d!.state === 'rejected' && d!.lastDecision && (
                <Notice tone="error" title={`Zurückgewiesen von ${d!.lastDecision.decided_by_name}`}>
                  {d!.lastDecision.note}
                </Notice>
              )}
              {d!.state === 'rejected' && can('post.submit') && !dirty && (
                <Button icon="Send" onClick={() => act(() => post(`/posts/${id}/submit`, { revision: r.number }), 'Erneut eingereicht')}>
                  Unverändert erneut einreichen
                </Button>
              )}
              {d!.state === 'in_review' && (
                <>
                  <p className="m-0 text-fg-muted">Eingereicht {fmtRelative(r.submitted_at)}.</p>
                  {can('approval.post') && !dirty && (
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
              {d!.state === 'approved' && !r.site_id && !(r.social_targets ?? []).length && <Notice tone="success">Intern freigegeben. Für eine Veröffentlichung einen Zielkanal wählen und erneut freigeben lassen.</Notice>}
              {d!.state === 'approved' && r.site_id && can('publish.website') && !dirty && (
                <Button variant="primary" icon="Globe" onClick={() => act(() => post(`/posts/${id}/publish`, { revision: r.number, contentHash: r.content_hash }), 'Veröffentlichung beauftragt')}>
                  Auf {site?.name ?? 'Website'} veröffentlichen
                </Button>
              )}
              {d!.state === 'scheduled' && d!.publications[0] && <Notice>Geplant für {fmtDateTime(d!.publications[0].run_at)}. Vorher holt die Website den Auftrag nicht ab.</Notice>}
              {d!.state === 'deactivated' && <Notice tone="warning">Von der Website zurückgezogen. Für eine erneute Veröffentlichung eine neue Fassung freigeben lassen.</Notice>}
              {['published', 'failed', 'unknown'].includes(d!.state) && can('publish.unpublish') && d!.publications.some((p) => p.action === 'publish' && p.status === 'published') && (
                <Button size="sm" icon="Ban" onClick={() => setUnpublishing(true)}>
                  Von der Website zurückziehen
                </Button>
              )}
              {d!.approval && can('approval.post') && !['publishing', 'published', 'scheduled'].includes(d!.state) && (
                <Button size="sm" variant="ghost" onClick={() => act(() => post(`/posts/${id}/approval/revoke`), 'Freigabe zurückgezogen')}>
                  Freigabe zurückziehen
                </Button>
              )}
            </div>
          </Card>

          <SocialStatusCard postId={id} revision={r.number} hash={r.content_hash} approved={!!d!.approval} targets={r.social_targets ?? []} items={d!.social ?? []} dirty={dirty} onChanged={refresh} />

          <Card title="Veröffentlichungen">
            {d!.publications.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine.</p>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col gap-3 text-sm">
                {d!.publications.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={p.status} labels={p.action === 'unpublish' ? { published: 'Zurückgezogen', queued: 'Rückzug wartet', sent: 'Rückzug gesendet' } : p.status === 'queued' && new Date(p.run_at) > new Date() ? { queued: 'Geplant' } : undefined} />
                      <span>{p.site_name}</span>
                      <Rev n={p.revision_number} className="text-fg-muted" />
                    </div>
                    {p.remote_url && (
                      <>
                        <a href={safeHref(p.remote_url)} target="_blank" rel="noopener noreferrer" className="break-all">
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
                    {p.status === 'unknown' && p.site_active !== false && <div className="text-warn">Die Website hat noch kein Ergebnis gemeldet. Die Bridge prüft beim nächsten Abruf, ob der Beitrag bereits existiert.</div>}
                    {p.error && <div className="text-err">{p.error}</div>}
                    <div className="flex gap-2">
                      {p.status === 'failed' && can('publish.website') && (
                        <Button size="sm" icon="RefreshCw" onClick={() => act(() => post(`/publications/${p.id}/retry`), 'Erneut beauftragt')}>
                          Erneut versuchen
                        </Button>
                      )}
                      {p.status === 'queued' && can('publish.website') && (
                        <Button size="sm" onClick={() => act(() => post(`/publications/${p.id}/cancel`), 'Auftrag abgebrochen')}>
                          Abbrechen
                        </Button>
                      )}
                      {['sent', 'unknown'].includes(p.status) && p.site_active === false && can('publish.website') && (
                        <Button size="sm" icon="CircleCheck" onClick={() => setResolving(p)}>
                          Ergebnis von Hand festhalten
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
                    {can('media.view') ? <Link to={`/medien/${c.id}`}>{c.title}</Link> : c.title}
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
                  <Rev n={v.number} className="text-fg-muted w-8 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate">{v.title}</span>
                    <span className="text-meta text-fg-muted">
                      {fmtDateTime(v.created_at)} · {v.created_by_name ?? '–'}
                      {/* Aktuelle Fassung erneut eingereicht: Status statt der alten Entscheidung zeigen */}
                      {v.number === r.number && d!.state === 'in_review' ? ' · zur Freigabe' : v.decision === 'approved' ? ' · freigegeben' : v.decision === 'rejected' ? ' · zurückgewiesen' : ''}
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
      {fromTemplate && (
        <ImageFillDialog
          postId={id}
          onClose={() => setFromTemplate(false)}
          onDone={(m) => {
            setMediaCache((c) => ({ ...c, [m.id]: m }));
            setDraft((dr) => (dr ? { ...dr, mediaIds: [...dr.mediaIds, m.id], coverId: dr.coverId ?? m.id } : dr));
            qc.invalidateQueries({ queryKey: ['post', id] });
          }}
        />
      )}
      {unpublishing && <UnpublishDialog postId={id} onClose={() => (setUnpublishing(false), refresh())} />}
      {resolving && <ResolveDialog publication={resolving} onClose={() => (setResolving(null), refresh())} />}
      {/* Handy: Speichern immer erreichbar, sobald es Änderungen gibt (der Kopf-Button liegt weit oben) */}
      {editable && dirty && (
        <div className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-card border-t border-line px-4 py-3 shadow-float">
          <Button variant="primary" icon="Save" className="w-full h-12" loading={saving} onClick={save}>
            Neue Fassung speichern
          </Button>
        </div>
      )}
      {decision && (
        <DecisionDialog
          decision={decision}
          revision={r.number}
          hash={r.content_hash}
          postId={id}
          flagged={r.media_ids.map((mid) => mediaCache[mid]).filter((m): m is MediaItem => !!m?.sensitive_flags?.length)}
          faces={r.media_ids.map((mid) => mediaCache[mid]).filter((m): m is MediaItem => !!m)}
          altMissing={d!.accessibility?.applies ? (d!.accessibility.missing ?? []).length : 0}
          altRequired={!!d!.accessibility?.required}
          onClose={() => (setDecision(null), refresh())}
        />
      )}
      {privacyMedia && (
        <PrivacyDialog
          m={privacyMedia}
          onClose={() => setPrivacyMedia(null)}
          // Zähler aus dem Beitrag verwerfen: offen ist, was in der gespeicherten Liste noch offen ist
          onSaved={(x) => setMediaCache((c) => ({ ...c, [x.id]: { ...c[x.id], ...x, faces_open: undefined } }))}
        />
      )}
      {collectLink && (
        <Dialog open onClose={() => setCollectLink(null)} title="Fotos und Videos sammeln" width={560}>
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm">Eine Sammlung zum Beitrag wurde angelegt. Teile den Link oder hänge den QR-Code aus – Hochladen geht ohne Konto.</p>
            <code className="text-sm break-all bg-raised rounded-control p-2">{collectLink.url}</code>
            <ShareActions share target={{ url: collectLink.url, title: r.title, purpose: 'Fotos und Videos hochladen', validUntil: collectLink.expires_at, sensitive: 'Jede Person mit diesem Link kann bis zum Ablauf Dateien hochladen. Der Link lässt sich in der Sammlung widerrufen.' }} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function UnpublishDialog({ postId, onClose }: { postId: string; onClose: () => void }) {
  const toastError = useErrorToast();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Von der Website zurückziehen"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" disabled={reason.trim().length < 3} onClick={async () => (await post(`/posts/${postId}/unpublish`, { reason: reason.trim() }).catch(toastError), onClose())}>
            Zurückziehen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">Jede Website, auf der der Beitrag steht, setzt ihn beim nächsten Abruf auf „Entwurf“ und löscht die übernommenen Bilder und Videos aus der Mediathek, sofern kein anderer Beitrag sie verwendet. Der Beitrag bleibt in BlaulichtCMS erhalten.</p>
        <p className="m-0 text-fg-muted">Facebook und Instagram sind davon nicht betroffen – dort über „Von sozialen Kanälen entfernen“ in der Karte „Soziale Kanäle – Status“.</p>
        <FieldWrap label="Grund" required htmlFor="un-reason">
          <Textarea id="un-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

/** Auftrag einer widerrufenen Website von Hand abschließen (#162): Die Website kann kein Ergebnis mehr melden. */
function ResolveDialog({ publication: p, onClose }: { publication: Publication; onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [outcome, setOutcome] = useState<'done' | 'not_done' | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const un = p.action === 'unpublish';
  return (
    <Dialog
      open
      onClose={onClose}
      title="Ergebnis von Hand festhalten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={busy || !outcome || note.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/publications/${p.id}/resolve`, { outcome, note: note.trim() });
                toast({ tone: 'success', title: 'Ergebnis festgehalten' });
                onClose();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Festhalten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          Die Kopplung von „{p.site_name}“ wurde widerrufen, nachdem die Website den Auftrag abgeholt hatte. Sie kann das Ergebnis nicht mehr melden. Bitte auf der Website nachsehen, ob der Beitrag {un ? 'zurückgezogen wurde' : 'dort steht'}, und das Ergebnis festhalten.
        </p>
        <FieldWrap label="Ergebnis auf der Website" required htmlFor="res-outcome">
          <Select id="res-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as 'done' | 'not_done' | '')}>
            <option value="">Bitte wählen</option>
            <option value="done">{un ? 'Zurückgezogen (steht nicht mehr öffentlich)' : 'Veröffentlicht (steht auf der Website)'}</option>
            <option value="not_done">{un ? 'Nicht zurückgezogen' : 'Nicht veröffentlicht'}</option>
          </Select>
        </FieldWrap>
        <FieldWrap label="Wie geprüft?" required htmlFor="res-note">
          <Textarea id="res-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </FieldWrap>
        <p className="m-0 text-fg-muted">Das Ergebnis wird im Protokoll festgehalten. Ein veröffentlichter Beitrag lässt sich über eine neu gekoppelte Website derselben Adresse zurückziehen.</p>
      </div>
    </Dialog>
  );
}
