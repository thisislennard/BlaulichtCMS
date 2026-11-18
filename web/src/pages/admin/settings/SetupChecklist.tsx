import { Button, LinkButton } from '../../../components/ui/core';
import { useAuth } from '../../../lib/auth';
import { plural } from '../../../lib/format';
import { useChecklistChange, useSetupChecklist } from '../../dashboard/SetupChecklist';
import { SectionCard } from '../shared';

/**
 * Checkliste „BlaulichtCMS startklar“ (#255) in den Einstellungen: Stand und ausgeblendete Punkte wieder einblenden –
 * auch dann, wenn die Kachel auf dem Dashboard verschwunden ist, weil nichts Offenes mehr sichtbar war.
 */
export function SetupChecklistSetting() {
  const { can } = useAuth();
  const allowed = can('settings.general');
  const q = useSetupChecklist(allowed);
  const { busy, change } = useChecklistChange();
  if (!allowed || !q.data) return null;
  const d = q.data;
  return (
    <SectionCard id="startklar" title="Checkliste „BlaulichtCMS startklar“" description="Steht auf dem Dashboard der Administration, solange ein Punkt offen und nicht ausgeblendet ist.">
      <div data-setup-setting="" className="flex flex-wrap items-center gap-3 text-sm">
        <p className="m-0 flex-1 min-w-[220px] text-fg-muted">
          {d.done} von {d.total} Punkten erledigt{d.hidden ? ` · ${plural(d.hidden, 'Punkt ausgeblendet', 'Punkte ausgeblendet')}` : ''}.
        </p>
        {d.hidden > 0 && (
          <Button size="sm" icon="Eye" disabled={busy} onClick={() => change({ show: 'all' })}>
            Ausgeblendete Punkte wieder zeigen
          </Button>
        )}
        <LinkButton to="/" size="sm" icon="LayoutDashboard">
          Zum Dashboard
        </LinkButton>
      </div>
    </SectionCard>
  );
}
