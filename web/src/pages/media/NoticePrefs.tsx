import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '../../components/ui/core';
import { useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { SectionCard } from '../admin/shared';

type Category = 'media_new' | 'media_link' | 'media_storage';

/** „Mein Konto“: Benachrichtigungen der Medien je Person stummschalten (wie die Kategorien in LiFeOS). */
export function MediaNoticePrefs() {
  const { me, can, setPreferences } = useAuth();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  if (!me || !can('media.view')) return null;
  const muted = new Set<Category>((me.user.preferences.mutedNotifications ?? []) as Category[]);
  const items: { key: Category; label: string; description: string; show: boolean }[] = [
    { key: 'media_new', label: 'Neue Dateien', description: 'Über einen Upload-Link sind Fotos oder Videos eingegangen und geprüft (gebündelt je Sammlung).', show: can('media.review') },
    { key: 'media_link', label: 'Upload-Links', description: 'Ein Link läuft bald ab oder das Kontingent von Link oder Sammlung ist erreicht.', show: can('media.review') },
    { key: 'media_storage', label: 'Speicherplatz', description: 'Der Speicher für Medien unterschreitet die Warnschwelle.', show: can('media.admin') },
  ];
  const visible = items.filter((i) => i.show);
  if (!visible.length) return null;
  const toggle = async (key: Category, on: boolean) => {
    const next = new Set(muted);
    if (on) next.delete(key);
    else next.add(key);
    try {
      await setPreferences({ mutedNotifications: [...next] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <SectionCard title="Benachrichtigungen: Medien" description="Welche Hinweise zu Medien in der Glocke erscheinen.">
      <div className="flex flex-col gap-3">
        {visible.map((i) => (
          <Switch key={i.key} checked={!muted.has(i.key)} onChange={(v) => void toggle(i.key, v)} label={i.label} description={i.description} />
        ))}
      </div>
    </SectionCard>
  );
}
