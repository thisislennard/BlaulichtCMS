import { PageTabs } from '../../components/layout/PageTabs';
import { useAuth } from '../../lib/auth';

/** Reiter der Seite „Reichweite“: Beiträge (aus BlaulichtCMS bzw. alle), Seitenstatistik und Social-Feed (je nach Recht). */
export function InsightsNav() {
  const { can } = useAuth();
  return (
    <PageTabs
      label="Reichweite"
      tabs={[
        { to: '/reichweite', label: 'Beiträge', icon: 'ChartColumn', end: true },
        { to: '/reichweite/seiten', label: 'Seitenstatistik', icon: 'ChartLine' },
        ...(can('insights.feed') ? [{ to: '/reichweite/feed', label: 'Social-Feed', icon: 'Rss' }] : []),
      ]}
    />
  );
}
