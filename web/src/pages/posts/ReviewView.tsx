import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { Badge, Button, ErrorBox, LinkButton, Notice, Rev, SegmentedControl, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { SOCIAL_LABEL, type SocialKind } from '../../lib/social';
import { openFaces, SENSITIVE_LABELS } from '../media/PrivacyDialog';
import { Lightbox } from '../media/gallery';
import { DecisionDialog } from './DecisionDialog';
import { KIND_LABEL } from './Posts';

interface Rev {
  number: number;
  title: string;
  body: string;
  excerpt: string;
  variants: Record<string, { title?: string; body?: string; excerpt?: string; categories?: number[] }>;
  media_ids: string[];
  cover_id: string | null;
  site_id: string | null;
  social_targets: string[];
  publish_at: string | null;
}
interface ReviewData {
  post: { id: string; kind: string; archived: boolean; current_revision: number };
  state: string;
  request: 'pending' | 'approved' | 'rejected' | 'superseded' | 'withdrawn' | 'revoked';
  revision: Rev & { id: string; content_hash: string; social_formats: Record<string, string>; change_note: string; created_at: string; created_by_name: string | null; submitted_at: string | null; submitted_by_name: string | null };
  base: (Rev & { approved: boolean }) | null;
  decision: { decision: 'approved' | 'rejected'; note: string; decided_at: string; decided_by_name: string | null; revoked: boolean } | null;
  media: MediaItem[];
  missing_media: number;
  accessibility?: { applies: boolean; required: boolean; missing: string[] };
  site: { name: string; site_url: string } | null;
  connections: { id: string; kind: string; name: string }[];
  schedule_passed: boolean;
  four_eyes_blocked: boolean;
  can_decide: boolean;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Wortweiser Vergleich (LCS) für „Änderungen zur letzten Fassung“ – ohne Bibliothek, mit Obergrenze.                 */

type Piece = { t: 'same' | 'add' | 'del'; s: string };

export function diffWords(a: string, b: string): Piece[] {
  if (a === b) return [{ t: 'same', s: a }];
  const A = a.split(/(\s+)/).filter((x) => x !== '');
  const B = b.split(/(\s+)/).filter((x) => x !== '');
  // Sehr lange Texte: nur „alt“ und „neu“ statt Wortvergleich (Speicher n·m)
  if (A.length * B.length > 4_000_000) return [{ t: 'del', s: a }, { t: 'add', s: b }];
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Piece[] = [];
  const push = (t: Piece['t'], s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <p className="m-0 whitespace-pre-wrap break-words leading-relaxed">
      {parts.map((p, i) =>
        p.t === 'same' ? (
          <span key={i}>{p.s}</span>
        ) : p.t === 'add' ? (
          <ins key={i} className="no-underline bg-ok-soft text-fg rounded-sm" title="neu">
            {p.s}
          </ins>
        ) : (
          <del key={i} className="bg-err-soft text-err rounded-sm" title="entfernt">
            {p.s}
          </del>
        ),
      )}
    </p>
  );
}

function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <p className="m-0 text-fg-muted">Kein Text.</p>;
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className="m-0 whitespace-pre-line break-words">
          {p}
        </p>
      ))}
    </>
  );
}

const textOf = (r: Rev, channel: string) => {
  const v = r.variants?.[channel] ?? {};
  return { title: v.title?.trim() ? v.title : r.title, body: v.body?.trim() ? v.body : r.body, excerpt: v.excerpt?.trim() ? v.excerpt : r.excerpt };
};

const REQUEST_TEXT: Record<Exclude<ReviewData['request'], 'pending'>, { tone: 'success' | 'error' | 'warning' | 'info'; title: string }> = {
  approved: { tone: 'success', title: 'Bereits freigegeben' },
  rejected: { tone: 'error', title: 'Bereits zurückgewiesen' },
  superseded: { tone: 'warning', title: 'Diese Anfrage ist überholt' },
  withdrawn: { tone: 'info', title: 'Nicht mehr zur Freigabe eingereicht' },
  revoked: { tone: 'warning', title: 'Freigabe wurde zurückgenommen' },
};

function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="bg-card border border-line rounded-card">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/**
 * Freigabe-Ansicht (#216): kompakt und für das Handy gedacht – Ziel der Push-Mitteilung „Freigabe erbeten“. Zeigt die
 * angefragte Fassung je Kanal, die Bilder und die Änderungen zur letzten freigegebenen Fassung. Freigeben und
 * Zurückweisen laufen über denselben Dialog und dieselben Regeln wie im Beitrag (Prüfsumme, Vier-Augen,
 * Datenschutz-Prüfung). Überholte oder bereits entschiedene Anfragen werden klar als solche gezeigt.
 */
export default function ReviewView() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const fassung = Number(params.get('fassung')) || undefined;
  const fromPush = params.get('quelle') === 'push';
  const wantsReject = params.get('aktion') === 'ablehnen';
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['post-review', id, fassung ?? null],
    queryFn: () => get<ReviewData>(`/posts/${id}/review${fassung ? `?fassung=${fassung}` : ''}`),
  });
  const d = q.data;
  // Ziel der Push-Mitteilung ohne eigenen Menüpunkt: gehört zu Übersicht → Freigaben (#250)
  usePageMeta({ title: d ? d.revision.title : 'Freigabe', navId: 'approvals' });
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [channel, setChannel] = useState<string>('grund');
  const [lightbox, setLightbox] = useState<number | null>(null);
  const autoOpened = useRef(false);

  // „Ablehnen …“ aus der Mitteilung: Begründungsdialog direkt öffnen – aber erst, wenn die Vorschau geladen ist und
  // die Anfrage noch offen ist
  useEffect(() => {
    if (d && wantsReject && !autoOpened.current) {
      autoOpened.current = true;
      if (d.can_decide) setDecision('rejected');
      const next = new URLSearchParams(params);
      next.delete('aktion');
      setParams(next, { replace: true });
    }
  }, [d, wantsReject, params, setParams]);

  if (q.isLoading) return <SkeletonRows rows={8} className="pt-2 max-w-[760px] mx-auto" />;
  if (q.isError || !d) {
    return (
      <div className="max-w-[760px] mx-auto">
        <ErrorBox title="Freigabe-Ansicht nicht verfügbar" actions={<Button onClick={() => q.refetch()}>Erneut versuchen</Button>}>
          {(q.error as Error)?.message}
        </ErrorBox>
      </div>
    );
  }

  const r = d.revision;
  const mediaById = new Map(d.media.map((m) => [m.id, m]));
  const media = r.media_ids.map((mid) => mediaById.get(mid)).filter((m): m is MediaItem => !!m);
  const flagged = media.filter((m) => m.sensitive_flags?.length);
  const channels: { value: string; label: string }[] = [{ value: 'grund', label: 'Grundtext' }];
  if (r.site_id) channels.push({ value: 'wordpress', label: 'Website' });
  for (const c of d.connections) if (!channels.some((x) => x.value === c.kind)) channels.push({ value: c.kind, label: SOCIAL_LABEL[c.kind as SocialKind] ?? c.kind });
  const active = channels.some((c) => c.value === channel) ? channel : 'grund';
  const shown = active === 'grund' ? { title: r.title, body: r.body, excerpt: r.excerpt } : textOf(r, active);
  const cover = r.cover_id ? mediaById.get(r.cover_id) : undefined;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['post-review', id] });
    qc.invalidateQueries({ queryKey: ['post', id] });
  };

  // Änderungen zur Vergleichsfassung
  const b = d.base;
  const changes: { label: string; before: string; after: string }[] = [];
  const other: string[] = [];
  if (b) {
    if (b.title !== r.title) changes.push({ label: 'Titel', before: b.title, after: r.title });
    if (b.body !== r.body) changes.push({ label: 'Text', before: b.body, after: r.body });
    if (b.excerpt !== r.excerpt) changes.push({ label: 'Kurzfassung', before: b.excerpt, after: r.excerpt });
    const keys = new Set([...Object.keys(b.variants ?? {}), ...Object.keys(r.variants ?? {})]);
    for (const k of keys) {
      const label = k === 'wordpress' ? 'Website' : (SOCIAL_LABEL[k as SocialKind] ?? k);
      for (const f of ['title', 'body', 'excerpt'] as const) {
        const before = b.variants?.[k]?.[f] ?? '';
        const after = r.variants?.[k]?.[f] ?? '';
        if (before !== after) changes.push({ label: `${label}: ${f === 'title' ? 'Titel' : f === 'body' ? 'Text' : 'Kurzfassung'}`, before, after });
      }
    }
    const added = r.media_ids.filter((x) => !b.media_ids.includes(x)).length;
    const removed = b.media_ids.filter((x) => !r.media_ids.includes(x)).length;
    if (added) other.push(`${added} Datei(en) hinzugefügt`);
    if (removed) other.push(`${removed} Datei(en) entfernt`);
    if (!added && !removed && b.media_ids.join() !== r.media_ids.join()) other.push('Reihenfolge der Dateien geändert');
    if (b.cover_id !== r.cover_id) other.push('Titelbild geändert');
    if (b.site_id !== r.site_id) other.push(r.site_id ? 'Website als Zielkanal geändert' : 'Website als Zielkanal entfernt');
    if ([...b.social_targets].sort().join() !== [...r.social_targets].sort().join()) other.push('Soziale Kanäle geändert');
    if ((b.publish_at ?? null) !== (r.publish_at ?? null)) other.push(r.publish_at ? `Termin: ${fmtDateTime(r.publish_at)}` : 'Termin entfernt');
  }

  return (
    <div className="max-w-[760px] mx-auto flex flex-col gap-4 pb-24 md:pb-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <StatusBadge status={d.state} />
          <Rev n={r.number} className="text-fg-muted" />
          <span className="text-fg-muted">{KIND_LABEL[d.post.kind] ?? d.post.kind}</span>
          {fromPush && (
            <Badge tone="primary" dot={false}>
              aus Mitteilung
            </Badge>
          )}
        </div>
        <h1 className="m-0 text-title font-semibold break-words">{r.title}</h1>
        <p className="m-0 text-sm text-fg-muted">
          {r.submitted_at ? `Eingereicht ${fmtRelative(r.submitted_at)}${r.submitted_by_name ? ` von ${r.submitted_by_name}` : ''}` : `Fassung vom ${fmtDateTime(r.created_at)}`}
          {r.change_note ? ` · „${r.change_note}“` : ''}
        </p>
      </header>

      {d.request !== 'pending' && (
        <Notice tone={REQUEST_TEXT[d.request].tone} title={REQUEST_TEXT[d.request].title}>
          {d.request === 'superseded' ? (
            <div className="flex flex-col gap-2">
              <span>Seit dieser Anfrage gibt es Fassung {d.post.current_revision}. Freigegeben werden kann nur die aktuelle Fassung.</span>
              <div>
                <Button size="sm" icon="ArrowRight" onClick={() => setParams({ fassung: String(d.post.current_revision) })}>
                  Aktuelle Fassung ansehen
                </Button>
              </div>
            </div>
          ) : d.decision && (d.request === 'approved' || d.request === 'rejected' || d.request === 'revoked') ? (
            <span>
              {d.decision.decided_by_name ?? 'Unbekannt'} · {fmtDateTime(d.decision.decided_at)}
              {d.decision.note ? ` · „${d.decision.note}“` : ''}
            </span>
          ) : (
            <span>Die Fassung wurde zurückgezogen oder geändert. Es ist nichts zu entscheiden.</span>
          )}
        </Notice>
      )}
      {d.post.archived && <Notice tone="warning">Der Beitrag ist archiviert.</Notice>}
      {d.request === 'pending' && d.four_eyes_blocked && (
        <Notice tone="warning" title="Vier-Augen-Prinzip">
          Du hast an diesem Beitrag geschrieben oder die Fassung eingereicht. Freigeben muss eine andere Person; zurückweisen kannst du sie.
        </Notice>
      )}
      {d.schedule_passed && <Notice tone="warning">Der Termin dieser Fassung ({fmtDateTime(r.publish_at)}) ist bereits verstrichen. Nach der Freigabe wird sofort veröffentlicht.</Notice>}
      {d.missing_media > 0 && <Notice tone="error">{d.missing_media} Datei(en) dieser Fassung wurden inzwischen gelöscht. Freigeben ist erst nach einer neuen Fassung möglich.</Notice>}

      <Section
        title="Vorschau"
        aside={
          <span className="text-meta text-fg-muted">
            {r.site_id ? `Website: ${d.site?.name ?? '–'}` : 'ohne Website'}
            {r.publish_at ? ` · Termin ${fmtDateTime(r.publish_at)}` : ''}
          </span>
        }
      >
        {channels.length > 1 && (
          <div className="mb-3 overflow-x-auto">
            <SegmentedControl label="Kanal" value={active} onChange={setChannel} options={channels} size="sm" />
          </div>
        )}
        <article className="flex flex-col gap-3">
          {(active === 'grund' || active === 'wordpress') && <h2 className="m-0 text-[18px] leading-snug font-semibold break-words">{shown.title}</h2>}
          {active === 'wordpress' && cover?.has_preview && <img src={`/api/v1/media/${cover.id}/preview`} alt="" className="w-full rounded-control" />}
          <div className="flex flex-col gap-3 text-base leading-relaxed">
            <Paragraphs text={shown.body} />
          </div>
          {shown.excerpt && active === 'wordpress' && <p className="m-0 text-sm text-fg-muted">Kurzfassung: {shown.excerpt}</p>}
          {active !== 'grund' && active !== 'wordpress' && r.social_formats && Object.entries(r.social_formats).some(([cid, f]) => d.connections.find((c) => c.id === cid)?.kind === active && f !== 'feed') && (
            <p className="m-0 text-meta text-fg-muted">Auch als Story</p>
          )}
        </article>
        {d.connections.length > 0 && (
          <p className="m-0 mt-3 text-meta text-fg-muted">Soziale Kanäle: {d.connections.map((c) => `${SOCIAL_LABEL[c.kind as SocialKind] ?? c.kind} (${c.name})`).join(', ')}</p>
        )}
      </Section>

      <Section title={`Bilder und Videos (${media.length})`}>
        {media.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Keine Dateien.</p>
        ) : (
          <ul className="m-0 p-0 list-none grid gap-2 grid-cols-3 sm:grid-cols-4">
            {media.map((m, i) => (
              <li key={m.id} className="relative">
                <button type="button" className="block w-full rounded-control overflow-hidden border border-line" onClick={() => setLightbox(i)} aria-label={`${m.original_name} groß ansehen`}>
                  {m.has_preview ? <img decoding="async" src={`/api/v1/media/${m.id}/preview`} alt="" className="w-full aspect-square object-cover" /> : <div className="aspect-square bg-raised flex items-center justify-center"><Icon name="Film" /></div>}
                </button>
                {m.id === r.cover_id && <span className="absolute top-1 left-1"><Badge tone="primary" dot={false}>Titelbild</Badge></span>}
                {!!m.sensitive_flags?.length && (
                  <span className="absolute bottom-1 left-1">
                    <Badge tone="warning" title={m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')}>
                      markiert
                    </Badge>
                  </span>
                )}
                {openFaces(m) > 0 && (
                  <span className="absolute top-1 right-1">
                    <Badge tone="warning" title="Ungeprüfte Vorschläge der Gesichtssuche">
                      {openFaces(m) === 1 ? '1 Gesicht offen' : `${openFaces(m)} Gesichter offen`}
                    </Badge>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {(flagged.length > 0 || media.some((m) => openFaces(m) > 0)) && <p className="m-0 mt-2 text-meta text-fg-muted">Markierte Dateien und Bilder mit offenen Gesichtsvorschlägen verlangen beim Freigeben die Datenschutz-Prüfung.</p>}
      </Section>

      <Section title={b ? `Änderungen zu Fassung ${b.number}${b.approved ? ' (zuletzt freigegeben)' : ''}` : 'Änderungen'}>
        {!b ? (
          <p className="m-0 text-sm text-fg-muted">Erste Fassung – es gibt nichts zu vergleichen.</p>
        ) : changes.length === 0 && other.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Inhaltlich keine Änderungen.</p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {changes.map((c, i) => (
              <div key={i} className="flex flex-col gap-1">
                <span className="font-medium">{c.label}</span>
                <Diff before={c.before} after={c.after} />
              </div>
            ))}
            {other.length > 0 && (
              <ul className="m-0 pl-5 flex flex-col gap-0.5">
                {other.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      <div className="flex flex-wrap gap-2 items-center">
        <LinkButton to={`/beitraege/${id}`} icon="FileText" size="sm">
          Ganzen Beitrag öffnen
        </LinkButton>
        <Link to="/freigaben" className="text-sm">
          Alle Freigaben
        </Link>
      </div>

      {d.can_decide && (
        <div className="fixed md:static bottom-0 inset-x-0 z-30 bg-card md:bg-transparent border-t md:border-0 border-line px-4 md:px-0 py-3 md:py-0 shadow-float md:shadow-none">
          <div className="max-w-[760px] mx-auto grid grid-cols-2 gap-2">
            <Button icon="X" className="h-12 md:h-ctl" onClick={() => setDecision('rejected')}>
              Ablehnen
            </Button>
            <Button variant="primary" icon="Check" className="h-12 md:h-ctl" disabled={d.four_eyes_blocked || d.missing_media > 0} onClick={() => setDecision('approved')}>
              Freigeben
            </Button>
          </div>
        </div>
      )}

      {decision && (
        <DecisionDialog decision={decision} revision={r.number} hash={r.content_hash} postId={id} flagged={flagged} faces={media} altMissing={d.accessibility?.applies ? d.accessibility.missing.length : 0} altRequired={!!d.accessibility?.required} via={fromPush ? 'push' : 'review'} onDone={refresh} onClose={() => (setDecision(null), refresh())} />
      )}
      {lightbox !== null && <Lightbox items={media} start={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
