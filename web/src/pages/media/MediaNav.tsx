import { PageTabs } from '../../components/layout/PageTabs';
import { useAuth } from '../../lib/auth';

/**
 * Reiter der Seite „Medien“: Sammlungen, alle Dateien und Papierkorb (je nach Recht). Die Gestaltung der Upload-Seite
 * steht unter Einrichtung, Speicher und gesperrte Dateien unter Verwaltung → Medienverwaltung (#250).
 */
export function MediaNav() {
  const { can } = useAuth();
  return (
    <PageTabs
      label="Medien"
      tabs={[
        { to: '/medien', label: 'Sammlungen', icon: 'Images', end: true },
        { to: '/medien/dateien', label: 'Alle Dateien', icon: 'Search' },
        ...(can('media.trash') ? [{ to: '/medien/papierkorb', label: 'Papierkorb', icon: 'Trash2' }] : []),
      ]}
    />
  );
}
