import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../api/client';
import type { BannerDisplay, Site } from '../../api/types';
import { Link } from 'react-router';
import { Button, Card, cx, EmptyAction, EmptyLine, EmptyState, ErrorBox, FieldWrap, Input, MetaLine, Notice, PageHeader, Rev, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';
import { BANNER_TABS, inBannerTab, olderRevisionLive } from './bannerTabs';
import { Dialog, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { FormProblems, useFormCheck } from '../../components/ui/form';
import { useAuth } from '../../lib/auth';
import { useLinkedItem } from '../../lib/linked-item';
import { useListState } from '../../lib/listState';
import { rank, searchTerms } from '../../lib/searchText';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../../lib/format';

interface Banner {
  id: string;
  revision: number;
  title: string;
  text: string;
  tone: 'info' | 'warning' | 'danger';
  priority: number;
  starts_at: string;
  ends_at: string;
  link_url: string | null;
  link_text: string | null;
  display: BannerDisplay;
  site_id: string;
  site_name: string;
  content_hash: string;
  submitted_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  state: string;
  synced_at: string | null;
  error: string | null;
  /** Herkunft aus einem Workflow und „Banner folgt dem Vorgang“ (#274) */
  automation_id: string | null;
  automation_name: string | null;
  follows: boolean;
  source_kind: 'warnung' | 'einsatz' | null;
  ended_at: string | null;
  ended_reason: 'entwarnung' | 'einsatz_beendet' | null;
  /** von Hand beendet („Jetzt beenden“, Warnung ausgeblendet) – sonst null (#276) */
  ended_by_name: string | null;
  /** Fassung, die gerade auf der Website steht (wenn eine neuere noch nicht veröffentlicht ist) */
  live_revision: number | null;
}

const FOLLOWS: Record<string, string> = { warnung: 'folgt der Warnung', einsatz: 'folgt dem Einsatz' };
const ENDED_REASON: Record<string, string> = { entwarnung: 'Entwarnung', einsatz_beendet: 'Einsatz beendet' };

/**
 * Herkunft und Ende eines Banners (#274, #276): „Aus Workflow „X“ · folgt der Warnung“, „Beendet: Entwarnung, …“
 * oder „Beendet von Hand (Name), …“.
 */
function BannerOrigin({ b }: { b: Banner }) {
  const { can } = useAuth();
  const byHand = !!b.ended_at && !b.ended_reason && !!b.ended_by_name;
  if (!b.automation_name && !b.ended_reason && !byHand) return null;
  const name = b.automation_name && (b.automation_id && can('automation.read') ? <Link to={`/workflows/${b.automation_id}`}>{b.automation_name}</Link> : b.automation_name);
  const at = b.ended_at ? `, ${fmtDateTime(b.ended_at)}` : '';
  return (
    <MetaLine className="text-meta text-fg-muted">
      {name && <span>Aus Workflow „{name}“</span>}
      {b.follows && b.source_kind && !b.ended_at && <span>{FOLLOWS[b.source_kind]}</span>}
      {b.ended_reason && (
        <span>
          Beendet: {ENDED_REASON[b.ended_reason]}
          {at}
        </span>
      )}
      {byHand && (
        <span>
          Beendet von Hand ({b.ended_by_name}){at}
        </span>
      )}
    </MetaLine>
  );
}

/** Zeitraum im Kartenkopf: geplant – bei beendeten Bannern bis zum tatsächlichen Ende (#276). */
function bannerPeriod(b: Banner): string {
  if (!b.ended_at) return `${fmtDateTime(b.starts_at)} – ${fmtDateTime(b.ends_at)}`;
  if (new Date(b.ended_at) < new Date(b.starts_at)) return `geplant ab ${fmtDateTime(b.starts_at)} – vorher beendet ${fmtDateTime(b.ended_at)}`;
  return `${fmtDateTime(b.starts_at)} – beendet ${fmtDateTime(b.ended_at)}`;
}

const TONE: Record<string, { label: string; cls: string }> = {
  info: { label: 'Hinweis', cls: 'bg-site-info-bg text-site-info-fg border-site-info-line' },
  warning: { label: 'Warnung', cls: 'bg-site-warning-bg text-site-warning-fg border-site-warning-line' },
  danger: { label: 'Gefahr', cls: 'bg-site-danger-bg text-site-danger-fg border-site-danger-line' },
};
const PRIO = { 1: 'niedrig', 2: 'normal', 3: 'hoch' } as Record<number, string>;
/** Darstellung auf der Website (#186). „auto“ folgt der Einstellung der Website je Schweregrad. */
export const DISPLAY_OPTIONS: { value: BannerDisplay; label: string }[] = [
  { value: 'auto', label: 'Nach Schweregrad (Einstellung der Website)' },
  { value: 'banner', label: 'Nur Banner' },
  { value: 'popup', label: 'Nur Popup beim Aufruf der Seite' },
  { value: 'both', label: 'Banner und Popup' },
];
const DISPLAY_LABEL: Record<string, string> = { banner: 'Banner', popup: 'Popup', both: 'Banner und Popup' };
/** Tatsächliche Darstellung auf einer Website: feste Wahl oder die von der Bridge gemeldete Einstellung je Schweregrad. */
function effectiveDisplay(display: BannerDisplay, tone: string, site: Site | undefined): string | null {
  if (display !== 'auto') return DISPLAY_LABEL[display];
  const d = site?.report?.display?.[tone as 'info' | 'warning' | 'danger'];
  return d ? `${DISPLAY_LABEL[d]} (Einstellung der Website)` : null;
}
const LABELS = { live: 'Aktiv auf der Website', expired: 'Abgelaufen', ended: 'Beendet', publishing: 'Wird übertragen', scheduled: 'Geplant' };

/** Vorschau in denselben Farben wie auf der Website (Bridge-Stylesheet). */
export function BannerPreview({ b }: { b: Pick<Banner, 'tone' | 'title' | 'text' | 'link_url' | 'link_text'> }) {
  const t = TONE[b.tone];
  return (
    <div className={cx('flex gap-3 items-start px-4 py-3 border-l-[6px] rounded-control', t.cls)}>
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] border-[1.5px] border-current rounded-[3px] px-1.5 py-0.5 mt-0.5 whitespace-nowrap">{t.label}</span>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        <strong>{b.title || 'Titel'}</strong>
        {b.text && <span>{b.text}</span>}
        {b.link_url && <span className="underline font-semibold">{b.link_text || 'Mehr erfahren'}</span>}
      </div>
    </div>
  );
}

function BannerDialog({ banner, sites, onClose }: { banner: Banner | null; sites: Site[]; onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
  const [v, setV] = useState({
    siteId: banner?.site_id ?? sites[0]?.id ?? '',
    title: banner?.title ?? '',
    text: banner?.text ?? '',
    tone: banner?.tone ?? 'info',
    priority: banner?.priority ?? 2,
    startsAt: toLocalInput(banner?.starts_at ?? new Date().toISOString()),
    endsAt: toLocalInput(banner?.ends_at ?? inTwoHours),
    linkUrl: banner?.link_url ?? '',
    linkText: banner?.link_text ?? '',
    display: (banner?.display ?? 'auto') as BannerDisplay,
  });
  // Prüfen statt sperren (#268)
  const check = useFormCheck({
    'b-site': !v.siteId && 'Bitte eine Website wählen.',
    'b-title': v.title.trim().length < 2 && 'Bitte einen Titel angeben (mindestens 2 Zeichen).',
    'b-end': (!v.endsAt ? 'Bitte den Ablauf angeben – danach blendet die Website das Banner aus.' : v.startsAt && v.endsAt <= v.startsAt ? 'Der Ablauf liegt vor dem Start.' : null),
  });
  const save = async () => {
    const body = { ...v, startsAt: fromLocalInput(v.startsAt), endsAt: fromLocalInput(v.endsAt), linkUrl: v.linkUrl.trim() || null, linkText: v.linkText.trim() || null };
    try {
      if (banner) {
        const r = await put<any>(`/banners/${banner.id}`, body);
        if (r.changed && banner.approved_by_name) toast({ tone: 'warning', title: 'Neue Fassung gespeichert', text: 'Die bisherige Freigabe gilt nicht mehr.' });
      } else await post('/banners', body);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title={banner ? 'Banner bearbeiten' : 'Neues Banner'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => check.submit(save)}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormProblems check={check} />
        {banner?.follows && banner.source_kind && (
          <Notice>
            Dieses Banner {FOLLOWS[banner.source_kind]}. Wer den Inhalt hier ändert, übernimmt ihn: Spätere Aktualisierungen überschreiben die Änderung nicht. {banner.source_kind === 'warnung' ? 'Die Entwarnung' : 'Das Einsatzende'} beendet das Banner weiterhin.
          </Notice>
        )}
        <BannerPreview b={{ tone: v.tone as any, title: v.title, text: v.text, link_url: v.linkUrl || null, link_text: v.linkText || null }} />
        <FieldWrap label="Website" htmlFor="b-site" required error={check.error('b-site')}>
          <Select id="b-site" value={v.siteId} onChange={(e) => setV({ ...v, siteId: e.target.value })}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Titel" required htmlFor="b-title" error={check.error('b-title')}>
          <Input id="b-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={120} />
        </FieldWrap>
        <FieldWrap label="Text" htmlFor="b-text">
          <Textarea id="b-text" rows={2} value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} maxLength={500} />
        </FieldWrap>
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Schweregrad" help="Farbe und Darstellung je Schweregrad legt die Website fest (Bridge-Einstellungen)." htmlFor="b-tone">
            <Select id="b-tone" value={v.tone} onChange={(e) => setV({ ...v, tone: e.target.value as any })}>
              <option value="info">Hinweis</option>
              <option value="warning">Warnung</option>
              <option value="danger">Gefahr</option>
            </Select>
          </FieldWrap>
          <FieldWrap label="Priorität" help="Bei mehreren Bannern steht die höchste Priorität oben." htmlFor="b-prio">
            <Select id="b-prio" value={v.priority} onChange={(e) => setV({ ...v, priority: Number(e.target.value) })}>
              <option value={3}>hoch</option>
              <option value={2}>normal</option>
              <option value={1}>niedrig</option>
            </Select>
          </FieldWrap>
          <FieldWrap label="Darstellung" htmlFor="b-display" help={effectiveDisplay(v.display, v.tone, sites.find((s) => s.id === v.siteId)) ? `Auf dieser Website: ${effectiveDisplay(v.display, v.tone, sites.find((s) => s.id === v.siteId))}` : 'Popup = Dialog beim Aufruf der Seite; jede Person schließt ihn einmal.'}>
            <Select id="b-display" value={v.display} onChange={(e) => setV({ ...v, display: e.target.value as BannerDisplay })}>
              {DISPLAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap label="Start" htmlFor="b-start">
            <Input id="b-start" type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Ablauf" required help="Die Website blendet das Banner danach selbst aus – auch ohne Verbindung." htmlFor="b-end" error={check.error('b-end')}>
            <Input id="b-end" type="datetime-local" value={v.endsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Link (optional)" htmlFor="b-link">
            <Input id="b-link" type="url" value={v.linkUrl} onChange={(e) => setV({ ...v, linkUrl: e.target.value })} placeholder="https://" />
          </FieldWrap>
          <FieldWrap label="Linktext" htmlFor="b-linktext">
            <Input id="b-linktext" value={v.linkText} onChange={(e) => setV({ ...v, linkText: e.target.value })} maxLength={60} placeholder="Mehr erfahren" />
          </FieldWrap>
        </div>
      </div>
    </Dialog>
  );
}

export default function Banners() {
  const ask = useConfirm();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['banners'], queryFn: () => get<Banner[]>('/banners'), refetchInterval: 20_000 });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites'), enabled: can('channel.view') });
  const [edit, setEdit] = useState<Banner | null | undefined>(undefined);
  const refresh = () => qc.invalidateQueries({ queryKey: ['banners'] });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const activeSites = (sites.data ?? []).filter((s) => s.status === 'active');
  // Aus Benachrichtigung oder Aktivitäten: /banner?banner=<id> hebt dieses Banner hervor (#252)
  const linked = useLinkedItem('banner', !!q.data);
  const linkedMissing = !!linked.id && !!q.data && !q.data.some((b) => b.id === linked.id);
  // Suche und Reiter in der Adresse (#260)
  const ls = useListState({ suche: '', status: 'alle' }, { tabKeys: ['status'] });
  const tab = BANNER_TABS[ls.values.status] ? ls.values.status : 'alle';
  const terms = searchTerms(ls.values.suche);
  const found = (q.data ?? []).filter((b) => !terms.length || rank(terms, b.title, `${b.text} ${b.site_name}`) !== null);
  const rows = found.filter((b) => inBannerTab(b, tab) || b.id === linked.id);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Zeitgesteuerte Hinweise auf der Website – mehrere gleichzeitig, sortiert nach Priorität."
        actions={can('banner.edit') && can('channel.view') && <Button variant="primary" icon="Plus" disabled={!activeSites.length} aria-describedby={!activeSites.length ? 'banner-no-site' : undefined} onClick={() => setEdit(null)}>Neues Banner</Button>}
      />
      {!activeSites.length && sites.data && <Notice><span id="banner-no-site">Für Banner muss zuerst eine Website gekoppelt sein (Einrichtung → Websites).</span></Notice>}
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Banner konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {linkedMissing && (
        <Notice tone="warning" title="Banner nicht gefunden">
          <div className="flex flex-col items-start gap-2">
            Das verlinkte Banner gibt es nicht mehr oder es wurde vor mehr als 30 Tagen beendet.
            <Button size="sm" onClick={linked.clear}>
              Hinweis schließen
            </Button>
          </div>
        </Notice>
      )}
      {!!q.data?.length && (
        <ListToolbar
          search={{ value: ls.values.suche, onChange: (s) => ls.set({ suche: s }), placeholder: 'Suchen in Bannern', label: 'Banner durchsuchen (Titel, Text, Website)' }}
          tabs={{ label: 'Status', value: tab, onChange: (s) => ls.set({ status: s }), options: Object.entries(BANNER_TABS).map(([value, t]) => ({ value, label: t.label, count: found.filter((b) => inBannerTab(b, value)).length })) }}
          count={{ n: rows.length, one: 'Banner', many: 'Banner' }}
          onReset={() => ls.reset(['status'])}
        />
      )}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon="Megaphone"
          title="Noch keine Banner."
          text={!can('banner.edit') ? 'Banner legt die Redaktion an.' : activeSites.length ? 'Ein Banner erscheint zeitgesteuert als Hinweis auf der Website.' : 'Für Banner muss zuerst eine Website gekoppelt sein.'}
          action={can('banner.edit') && can('channel.view') && (activeSites.length ? <Button icon="Plus" onClick={() => setEdit(null)}>Neues Banner</Button> : can('channel.sites') && <EmptyAction to={'/verbindungen/websites'}>Website koppeln</EmptyAction>)}
        />
      )}
      {!!q.data?.length && !rows.length &&
        (terms.length ? (
          <FilterEmpty onReset={() => ls.reset(['status'])} />
        ) : (
          <EmptyLine action={<EmptyAction onClick={() => ls.set({ status: 'alle' })}>Alle Banner zeigen</EmptyAction>}>Kein Banner in „{BANNER_TABS[tab].label}“.</EmptyLine>
        ))}
      <div className="flex flex-col gap-4">
        {rows.map((b) => (
          <Card key={b.id} id={`banner-${b.id}`} className={cx(linked.id === b.id && 'ring-2 ring-primary')}>
            <div className="flex flex-col gap-3">
              <MetaLine className="text-sm text-fg-muted" lead={<StatusBadge status={b.state} labels={LABELS} />}>
                <span>{b.site_name}</span>
                <span>Priorität {PRIO[b.priority]}</span>
                {effectiveDisplay(b.display ?? 'auto', b.tone, sites.data?.find((s) => s.id === b.site_id))}
                <span>{bannerPeriod(b)}</span>
                <Rev n={b.revision} />
              </MetaLine>
              <BannerOrigin b={b} />
              <BannerPreview b={b} />
              {olderRevisionLive(b) && (
                <div className="text-meta text-fg-muted">
                  Auf der Website steht noch Fassung {b.live_revision} – bis die neue Fassung freigegeben und veröffentlicht ist.
                </div>
              )}
              {b.approved_by_name && <div className="text-meta text-fg-muted">Freigegeben von {b.approved_by_name}, {fmtDateTime(b.approved_at)}</div>}
              {b.error && <div className="text-sm text-err">{b.error}</div>}
              <div className="flex flex-wrap gap-2">
                {!['ended', 'expired'].includes(b.state) && can('banner.edit') && (
                  <Button size="sm" icon="Pencil" onClick={() => setEdit(b)}>
                    Bearbeiten
                  </Button>
                )}
                {b.state === 'draft' && can('banner.edit') && (
                  <Button size="sm" icon="Send" onClick={() => act(() => post(`/banners/${b.id}/submit`))}>
                    Zur Freigabe einreichen
                  </Button>
                )}
                {b.state === 'in_review' && can('approval.banner') && (
                  <Button size="sm" icon="Check" onClick={() => act(() => post(`/banners/${b.id}/approve`, { contentHash: b.content_hash }))}>
                    Freigeben
                  </Button>
                )}
                {['approved', 'failed'].includes(b.state) && can('banner.publish') && (
                  <Button size="sm" variant="primary" icon="Globe" onClick={() => act(() => post(`/banners/${b.id}/publish`, { contentHash: b.content_hash }))}>
                    Auf Website veröffentlichen
                  </Button>
                )}
                {!['ended', 'expired'].includes(b.state) && can('banner.publish') && (
                  <Button size="sm" variant="danger" icon="CircleStop" onClick={async () => (await ask({ title: "Banner jetzt beenden?", text: `„${b.title}“ verschwindet beim nächsten Abruf der Bridge von der Website.`, confirmLabel: "Beenden" })) && act(() => post(`/banners/${b.id}/end`))}>
                    Jetzt beenden
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {edit !== undefined && <BannerDialog banner={edit} sites={activeSites} onClose={() => (setEdit(undefined), refresh())} />}
    </div>
  );
}
