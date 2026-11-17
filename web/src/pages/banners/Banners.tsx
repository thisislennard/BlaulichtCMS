import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../api/client';
import type { BannerDisplay, Site } from '../../api/types';
import { Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Rev, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { useLinkedItem } from '../../lib/linked-item';
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
          <Button variant="primary" disabled={v.title.trim().length < 2 || !v.siteId} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <BannerPreview b={{ tone: v.tone as any, title: v.title, text: v.text, link_url: v.linkUrl || null, link_text: v.linkText || null }} />
        <FieldWrap label="Website" htmlFor="b-site">
          <Select id="b-site" value={v.siteId} onChange={(e) => setV({ ...v, siteId: e.target.value })}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Titel" required htmlFor="b-title">
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
          <FieldWrap label="Ablauf" required help="Die Website blendet das Banner danach selbst aus – auch ohne Verbindung." htmlFor="b-end">
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
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Zeitgesteuerte Hinweise auf der Website – mehrere gleichzeitig, sortiert nach Priorität."
        actions={can('banner.edit') && can('channel.view') && <Button variant="primary" icon="Plus" disabled={!activeSites.length} onClick={() => setEdit(null)}>Neues Banner</Button>}
      />
      {!activeSites.length && sites.data && <Notice>Für Banner muss zuerst eine Website gekoppelt sein (Einrichtung → Websites).</Notice>}
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
      {q.data && q.data.length === 0 && <EmptyState icon="Megaphone" title="Keine Banner" />}
      <div className="flex flex-col gap-4">
        {(q.data ?? []).map((b) => (
          <Card key={b.id} id={`banner-${b.id}`} className={cx(linked.id === b.id && 'ring-2 ring-primary')}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge status={b.state} labels={LABELS} />
                <span className="text-fg-muted">
                  {b.site_name} · Priorität {PRIO[b.priority]}
                  {effectiveDisplay(b.display ?? 'auto', b.tone, sites.data?.find((s) => s.id === b.site_id)) ? ` · ${effectiveDisplay(b.display ?? 'auto', b.tone, sites.data?.find((s) => s.id === b.site_id))}` : ''} · {fmtDateTime(b.starts_at)} – {fmtDateTime(b.ends_at)} · <Rev n={b.revision} />
                </span>
              </div>
              <BannerPreview b={b} />
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
