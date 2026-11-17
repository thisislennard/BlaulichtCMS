import { PageTabs } from '../../components/layout/PageTabs';
import { t } from '../../i18n';

/** Reiter der Seite „Workflows“ (#250): die Bausteine Auslöser und Aktionen sind Reiter statt eigener Menüpunkte. */
export function WorkflowTabs() {
  return (
    <PageTabs
      label={t('nav.automations')}
      tabs={[
        { to: '/workflows', label: t('nav.automations'), icon: 'Workflow', end: true },
        { to: '/workflows/ausloeser', label: t('nav.automationTriggers'), icon: 'Zap' },
        { to: '/workflows/aktionen', label: t('nav.automationActions'), icon: 'Send' },
      ]}
    />
  );
}
