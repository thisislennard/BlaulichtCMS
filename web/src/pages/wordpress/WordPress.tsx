import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Badge, Button, EmptyState, ErrorBox, LinkButton, PageHeader, Select, Skeleton, Tabs, type Tone } from '../../components/ui/core';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { useConnections, type ConnectionRow } from '../integrations/shared';
import { BannerTab } from './BannerTab';
import { PluginTab } from './PluginTab';
import { PostsTab } from './PostsTab';
import type { Banner, Post } from './shared';

type Tab = 'banner' | 'beitraege' | 'plugin';

function pluginStatus(c: ConnectionRow): { tone: Tone; label: string } {
  switch (c.status) {
    case 'ok':
      return { tone: 'success', label: t('wordpress.pluginStatus.ok') };
    case 'warning':
      return { tone: 'warning', label: t('wordpress.pluginStatus.warning') };
    case 'error':
      return { tone: 'error', label: t('wordpress.pluginStatus.error') };
    case 'disabled':
      return { tone: 'neutral', label: t('wordpress.pluginStatus.disabled') };
    default:
      return { tone: 'neutral', label: t('wordpress.pluginStatus.untested') };
  }
}

export default function WordPress() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const connections = useConnections();
  const sites = useMemo(() => (connections.data ?? []).filter((c) => c.connector === 'wordpress'), [connections.data]);
  const tab = (['banner', 'beitraege', 'plugin'].includes(params.get('tab') ?? '') ? params.get('tab') : 'banner') as Tab;
  const bannerParam = params.get('banner');
  const postParam = params.get('beitrag');

  const banners = useQuery<Banner[]>({ queryKey: ['banners'], queryFn: () => get('/banners'), enabled: sites.length > 0 });
  const posts = useQuery<Post[]>({ queryKey: ['posts'], queryFn: () => get('/posts'), enabled: sites.length > 0 });

  // Website: aus ?site, sonst aus dem vorgewählten Banner, sonst die erste
  const preBannerSite = bannerParam && bannerParam !== 'new' ? banners.data?.find((b) => b.id === bannerParam)?.connection_id : undefined;
  const siteId = (params.get('site') && sites.some((s) => s.id === params.get('site')) ? params.get('site') : null) ?? preBannerSite ?? sites[0]?.id ?? null;
  const site = sites.find((s) => s.id === siteId) ?? null;

  const update = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };

  // ?site immer mitführen, sobald bekannt
  useEffect(() => {
    if (siteId && params.get('site') !== siteId) update({ site: siteId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const siteBanners = useMemo(() => (banners.data ?? []).filter((b) => b.connection_id === siteId), [banners.data, siteId]);
  const sitePosts = useMemo(() => (posts.data ?? []).filter((p) => p.connection_id === siteId), [posts.data, siteId]);

  if (connections.isLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-10 w-full" />
        <div className="flex gap-5">
          <Skeleton className="h-80 w-[360px] rounded-card" />
          <Skeleton className="h-80 flex-1 rounded-card" />
        </div>
      </div>
    );
  }
  if (connections.error) return <ErrorBox title={t('wordpress.loadError')}>{(connections.error as Error).message}</ErrorBox>;

  if (!site) {
    return (
      <>
        <PageHeader title={t('wordpress.title')} subtitle={t('wordpress.subtitleEmpty')} />
        <div className="bg-card border border-line rounded-card">
          <EmptyState
            icon="Globe"
            title={t('wordpress.emptyTitle')}
            text={t('wordpress.emptyText')}
            action={
              can('connection.edit') ? (
                <LinkButton to="/schnittstellen/wordpress/verbinden" variant="primary" icon="Plug">
                  {t('wordpress.connect')}
                </LinkButton>
              ) : (
                <p className="m-0 text-meta text-fg-muted">{t('wordpress.connectNoPerm')}</p>
              )
            }
          />
        </div>
      </>
    );
  }

  const ps = pluginStatus(site);
  const activeCount = siteBanners.filter((b) => b.view === 'aktiv').length;

  return (
    <>
      <PageHeader
        title={t('wordpress.title')}
        subtitle={t('wordpress.subtitle', { n: activeCount })}
        actions={
          <>
            {sites.length > 1 ? (
              <div className="w-[240px] max-w-full">
                <Select aria-label={t('wordpress.siteLabel')} value={site.id} onChange={(e) => update({ site: e.target.value, banner: null, beitrag: null })}>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <span className="text-sm text-fg-muted">
                {t('wordpress.siteLabel')}: <strong className="text-fg font-medium">{site.name}</strong>
              </span>
            )}
          </>
        }
      />

      <div className="flex items-end justify-between gap-3 flex-wrap border-b border-line">
        <div className="-mb-px w-full md:w-auto md:flex-1 min-w-0 [&>div]:border-b-0">
          <Tabs<Tab>
            label={t('wordpress.tabsLabel')}
            value={tab}
            onChange={(v) => update({ tab: v === 'banner' ? null : v })}
            tabs={[
              { value: 'banner', label: t('wordpress.tabs.banner'), count: siteBanners.length },
              { value: 'beitraege', label: t('wordpress.tabs.posts'), count: sitePosts.length },
              { value: 'plugin', label: t('wordpress.tabs.plugin') },
            ]}
          />
        </div>
        <div className="flex items-center gap-2 pb-2 flex-wrap">
          <Badge tone={ps.tone} title={site.status_message ?? undefined}>
            {ps.label}
          </Badge>
          {tab === 'banner' && can('wordpress.edit') && (
            <Button size="sm" variant="primary" icon="Plus" onClick={() => update({ banner: 'new' })}>
              {t('wordpress.banner.new')}
            </Button>
          )}
          {tab === 'beitraege' && can('wordpress.edit') && (
            <Button size="sm" variant="primary" icon="Plus" onClick={() => update({ beitrag: 'new' })}>
              {t('wordpress.posts.new')}
            </Button>
          )}
        </div>
      </div>

      {site.status === 'error' && tab !== 'plugin' && (
        <ErrorBox
          title={t('wordpress.siteErrorTitle')}
          actions={
            <Button size="sm" icon="Settings" onClick={() => update({ tab: 'plugin' })}>
              {t('wordpress.siteErrorAction')}
            </Button>
          }
        >
          <p className="m-0">{site.status_message ?? t('integrations.cards.errorNoMessage')}</p>
          <p className="m-0 mt-1">{t('wordpress.siteErrorHint')}</p>
        </ErrorBox>
      )}

      <div role="tabpanel" aria-label={t(`wordpress.tabs.${tab === 'beitraege' ? 'posts' : tab}`)}>
        {tab === 'banner' && (
          <BannerTab
            siteId={site.id}
            banners={siteBanners}
            loading={banners.isLoading}
            error={banners.error}
            selected={bannerParam ?? siteBanners[0]?.id ?? null}
            onSelect={(id) => update({ banner: id })}
          />
        )}
        {tab === 'beitraege' && (
          <PostsTab siteId={site.id} posts={sitePosts} loading={posts.isLoading} error={posts.error} selected={postParam ?? sitePosts[0]?.id ?? null} onSelect={(id) => update({ beitrag: id })} />
        )}
        {tab === 'plugin' && <PluginTab site={site} />}
      </div>
    </>
  );
}
