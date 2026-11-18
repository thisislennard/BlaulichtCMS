import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api/client';
import { Badge, Button, Card, cx } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useErrorToast } from '../../components/ui/overlays';
import { navItem, navigation } from '../../config/navigation';
import { navTrail } from '../../config/navText';
import { SETTINGS_INDEX } from '../../config/settingsIndex';
import { settingsPage } from '../../config/settingsPages';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { plural } from '../../lib/format';

/** Stand der Checkliste „BlaulichtCMS startklar“ (#255) – erkannt vom Server (server/src/lib/setup-checklist.ts). */
export interface ChecklistItem {
  id: string;
  title: string;
  level: 'required' | 'recommended' | 'optional';
  done: boolean;
  detail: string;
  href: string;
  permission: string;
  hidden: boolean;
}
export interface Checklist {
  items: ChecklistItem[];
  total: number;
  done: number;
  requiredDone: boolean;
  hidden: number;
  visible: boolean;
}

const LEVEL: Record<ChecklistItem['level'], string> = { required: 'Pflicht', recommended: 'empfohlen', optional: 'optional' };

/**
 * Wo der Link hinführt, in Menübezeichnungen („Einstellungen → Datenschutz“, „Einrichtung → Websites“) – aus denselben
 * Quellen wie Menü und Suche, damit Umbenennungen mitgehen (#257).
 */
export function whereOf(href: string): string {
  const setting = SETTINGS_INDEX.find((e) => e.href === href);
  if (setting) return setting.where;
  const path = href.split(/[?#]/)[0];
  if (path.startsWith('/hilfe/')) {
    const title = t(`help.chapters.${path.slice('/hilfe/'.length)}.title`);
    return `Hilfe → ${title.startsWith('help.') ? 'Kapitel' : title}`;
  }
  if (path.startsWith('/einstellungen')) {
    const page = settingsPage(path.split('/')[2]);
    return page ? `Einstellungen → ${page.label}` : navTrail('settings');
  }
  const item = navigation.flatMap((g) => g.items).find((i) => i.path === path);
  return item && navItem(item.id) ? navTrail(item.id) : 'Öffnen';
}

/**
 * Stand der Checkliste vom Server – nur geladen, wo sie gebraucht wird (Kachel im Layout, Einstellungen). Beim Zurückkehren
 * aufs Dashboard und im Fenster-Fokus neu erkannt (z. B. nach gespeicherter Testmail oder bestandener Probe), sonst jede
 * Minute; eine neu gekoppelte Website meldet die Live-Verbindung sofort.
 */
export function useSetupChecklist(enabled = true) {
  const { can } = useAuth();
  return useQuery({ queryKey: ['setup-checklist'], queryFn: () => get<Checklist>('/setup/checklist'), enabled: enabled && can('settings.general'), staleTime: 0, refetchInterval: 60_000, refetchOnWindowFocus: true });
}

/** Aus- und Einblenden speichern; die Antwort ist der neue Stand der Checkliste (ersetzt ihn sofort). */
export function useChecklistChange() {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const change = async (body: { hide?: string[]; show?: string[] | 'all' }) => {
    setBusy(true);
    try {
      const next = await put<Checklist>('/setup/checklist', body);
      qc.setQueryData(['setup-checklist'], next);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, change };
}

/** Kachel „BlaulichtCMS startklar“ (Karte mit Titel und „n von m erledigt“). */
export function SetupTile() {
  const q = useSetupChecklist();
  return (
    <Card title="BlaulichtCMS startklar" subtitle={q.data ? `${q.data.done} von ${q.data.total} erledigt` : undefined} action={<Link to="/hilfe/dashboard#blaulichtcms-startklar" className="bc-tap-y inline-flex justify-end max-md:min-w-tap text-sm !text-fg-muted hover:!text-fg">Hilfe →</Link>}>
      {q.isError ? <p className="m-0 text-sm text-err">Die Checkliste konnte nicht geladen werden.</p> : <SetupChecklist data={q.data} />}
    </Card>
  );
}

/**
 * Inhalt der Kachel: jeder Punkt mit erkanntem Stand, Erklärung und Link an die richtige Stelle; offene Punkte lassen
 * sich einzeln ausblenden, sind alle Pflichtpunkte erledigt, auch der Rest auf einmal.
 */
export function SetupChecklist({ data }: { data: Checklist | undefined }) {
  const { busy, change } = useChecklistChange();
  if (!data) return <p className="m-0 text-sm text-fg-muted">Wird geladen …</p>;
  const shown = data.items.filter((i) => !i.hidden);
  const open = shown.filter((i) => !i.done);
  return (
    <div className="flex flex-col gap-3" data-setup-checklist="">
      {!open.length && <p className="m-0 text-sm text-fg-muted">Alles erledigt – die Kachel erscheint wieder, wenn ein Punkt offen wird.</p>}
      <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
        {shown.map((i) => (
          <li key={i.id} data-setup-item={i.id} data-done={i.done ? 'true' : 'false'} className="py-2.5 flex items-start gap-3">
            <span className={cx('mt-0.5 shrink-0', i.done ? 'text-ok' : i.level === 'required' ? 'text-primary' : 'text-fg-muted')}>
              <Icon name={i.done ? 'CircleCheck' : 'CircleDashed'} size={18} />
            </span>
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cx('font-medium', i.done && 'text-fg-muted')}>{i.title}</span>
                <span className="sr-only">{i.done ? '(erledigt)' : '(offen)'}</span>
                <Badge tone="neutral" dot={false}>
                  {LEVEL[i.level]}
                </Badge>
              </div>
              <span className="text-meta text-fg-muted">{i.detail}</span>
              {!i.done && (
                <Link to={i.href} className="bc-tap-y text-sm self-start">
                  {whereOf(i.href)} →
                </Link>
              )}
            </div>
            {!i.done && <Button iconOnly size="sm" icon="X" className="!w-tap !h-tap shrink-0" aria-label={`„${i.title}“ ausblenden`} title="Punkt ausblenden" disabled={busy} onClick={() => change({ hide: [i.id] })} />}
          </li>
        ))}
      </ul>
      {(data.hidden > 0 || (data.requiredDone && open.length > 0)) && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          {data.requiredDone && open.length > 0 && (
            <Button size="sm" icon="EyeOff" disabled={busy} onClick={() => change({ hide: open.map((i) => i.id) })}>
              Restliche Punkte ausblenden
            </Button>
          )}
          {data.hidden > 0 && (
            <Button size="sm" variant="ghost" icon="Eye" disabled={busy} onClick={() => change({ show: 'all' })}>
              {plural(data.hidden, 'ausgeblendeten Punkt', 'ausgeblendete Punkte')} wieder zeigen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
