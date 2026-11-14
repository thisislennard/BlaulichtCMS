/* Gemeinsames für die WordPress-Seite: Typen, Bannerfarben wie im Plugin, Vorschau. */
import { Badge, cx, type Tone } from '../../components/ui/core';
import { t } from '../../i18n';

export type BannerView = 'entwurf' | 'geplant' | 'aktiv' | 'abgelaufen' | 'deaktiviert';
export type BannerColor = 'rot' | 'orange' | 'gelb' | 'blau' | 'gruen' | 'neutral';
export type Priority = 'niedrig' | 'normal' | 'hoch';

export interface Banner {
  id: string;
  connection_id: string;
  revision: number;
  title: string;
  text: string;
  label: string;
  color: BannerColor;
  priority: Priority;
  starts_at: string | null;
  ends_at: string | null;
  pages: string[];
  link_url: string | null;
  link_text: string | null;
  state: 'draft' | 'published' | 'deactivated';
  source: 'manual' | 'workflow';
  source_label: string;
  sync_status: 'none' | 'pending' | 'synced' | 'error';
  sync_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  view: BannerView;
  site_name?: string;
}

export interface Post {
  id: string;
  connection_id: string;
  revision: number;
  title: string;
  content: string;
  excerpt: string;
  category: string;
  tags: string[];
  wp_status: 'draft' | 'pending' | 'future';
  publish_at: string | null;
  state: 'draft' | 'sent';
  source: 'manual' | 'workflow';
  source_label: string;
  wp_post_id: number | null;
  wp_edit_url: string | null;
  wp_result_status: string | null;
  sync_status: 'none' | 'pending' | 'synced' | 'error';
  sync_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Farben und Kontrast exakt wie im WordPress-Plugin (assets/lifelink.css). */
export const BANNER_PALETTE: Record<BannerColor, { bg: string; fg: string }> = {
  rot: { bg: '#b3261e', fg: '#ffffff' },
  orange: { bg: '#f08c00', fg: '#1a1a1a' },
  gelb: { bg: '#ffd43b', fg: '#1a1a1a' },
  blau: { bg: '#1d4ed8', fg: '#ffffff' },
  gruen: { bg: '#1b7a34', fg: '#ffffff' },
  neutral: { bg: '#e9ecef', fg: '#1a1a1a' },
};
export const COLORS: BannerColor[] = ['rot', 'orange', 'gelb', 'blau', 'gruen', 'neutral'];
export const PRIORITIES: Priority[] = ['niedrig', 'normal', 'hoch'];
const PRIO_RANK: Record<Priority, number> = { hoch: 0, normal: 1, niedrig: 2 };

export const VIEW_TONE: Record<BannerView, Tone> = { aktiv: 'success', geplant: 'primary', abgelaufen: 'neutral', entwurf: 'warning', deaktiviert: 'neutral' };

export function ViewBadge({ view }: { view: BannerView }) {
  return <Badge tone={VIEW_TONE[view]} pulse={view === 'aktiv'}>{t(`wordpress.view.${view}`)}</Badge>;
}

/** Sichtbares Label (eigenes oder Standardlabel der Farbe, wie im Plugin). */
export function displayLabel(label: string, color: BannerColor) {
  return label.trim() || t(`wordpress.defaultLabel.${color}`);
}

export interface PreviewBanner {
  key: string;
  title: string;
  text: string;
  label: string;
  color: BannerColor;
  priority: Priority;
  linkUrl?: string | null;
  linkText?: string | null;
  current?: boolean;
  startsAt?: string | null;
}

export function sortStack(list: PreviewBanner[]) {
  return [...list].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || new Date(b.startsAt ?? 0).getTime() - new Date(a.startsAt ?? 0).getTime());
}

/** Neutrale Website-Attrappe mit Bannerstapel. Schrift: neutrale Serifenschrift = „Theme“. */
export function SitePreview({ banners, mobile }: { banners: PreviewBanner[]; mobile: boolean }) {
  return (
    <div className={cx('mx-auto rounded-control overflow-hidden shadow-float transition-[max-width] duration-panel', mobile ? 'max-w-[360px]' : 'max-w-full')} style={{ background: '#ffffff', color: '#1f2937', fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div role="presentation">
        {banners.length === 0 && (
          <div className="px-5 py-3 text-[13px]" style={{ background: '#f8f9fa', color: '#6b7280' }}>
            {t('wordpress.preview.noBanner')}
          </div>
        )}
        {banners.map((b) => {
          const pal = BANNER_PALETTE[b.color];
          return (
            <div key={b.key} className={cx('relative flex items-start gap-3', mobile ? 'px-4 py-3' : 'px-5 py-3.5', !b.current && 'opacity-75')} style={{ background: pal.bg, color: pal.fg, boxShadow: b.current && banners.length > 1 ? 'inset 0 0 0 2px #6366F1' : undefined }}>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className={cx('font-semibold break-words', mobile ? 'text-[14px]' : 'text-[15px]')}>
                  <span className="uppercase tracking-[0.04em] text-[12px] mr-2 px-1.5 py-px rounded-[3px]" style={{ border: `1px solid ${pal.fg}`, opacity: 0.9 }}>
                    {displayLabel(b.label, b.color)}
                  </span>
                  {b.title || t('wordpress.preview.titlePlaceholder')}
                </span>
                {b.text && <span className="text-[13px] break-words whitespace-pre-line" style={{ opacity: 0.92 }}>{b.text}</span>}
                {b.linkUrl && (
                  <span className="text-[13px] underline" style={{ color: pal.fg }}>
                    {b.linkText || t('wordpress.preview.moreLink')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className={cx('flex items-center justify-between gap-3', mobile ? 'px-4 py-3' : 'px-5 py-4')} style={{ borderBottom: '1px solid #e5e7eb' }}>
        <span className={cx('font-bold', mobile ? 'text-[15px]' : 'text-[18px]')}>{t('wordpress.preview.siteName')}</span>
        {mobile ? (
          <span aria-hidden="true" className="flex flex-col gap-[3px]">
            <span className="block w-5 h-[2px]" style={{ background: '#4b5563' }} />
            <span className="block w-5 h-[2px]" style={{ background: '#4b5563' }} />
            <span className="block w-5 h-[2px]" style={{ background: '#4b5563' }} />
          </span>
        ) : (
          <span className="flex flex-wrap justify-end gap-x-[18px] gap-y-1 text-[13px]" style={{ color: '#4b5563' }}>
            <span>{t('wordpress.preview.nav1')}</span>
            <span>{t('wordpress.preview.nav2')}</span>
            <span>{t('wordpress.preview.nav3')}</span>
            <span>{t('wordpress.preview.nav4')}</span>
          </span>
        )}
      </div>
      <div className={cx('flex gap-4', mobile ? 'p-4 flex-col' : 'p-5')}>
        <div className="flex-[2] flex flex-col gap-2">
          <div className="h-3.5 w-3/5 rounded-[3px]" style={{ background: '#e5e7eb' }} />
          <div className="h-2.5 w-[92%] rounded-[3px]" style={{ background: '#f3f4f6' }} />
          <div className="h-2.5 w-[85%] rounded-[3px]" style={{ background: '#f3f4f6' }} />
          <div className="h-2.5 w-[70%] rounded-[3px]" style={{ background: '#f3f4f6' }} />
        </div>
        <div className="flex-1 h-[70px] rounded-[6px]" style={{ background: '#f3f4f6' }} />
      </div>
    </div>
  );
}
