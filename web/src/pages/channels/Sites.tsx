import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { download, get, post } from '../../api/client';
import type { Site } from '../../api/types';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CopyButton, Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';

interface Pairing {
  site: Site;
  pairingCode: string;
  lifelinkUrl: string;
}

function PairingDialog({ pairing, onClose }: { pairing: Pairing; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Website „${pairing.site.name}“ koppeln`} width={600} footer={<Button variant="primary" onClick={onClose}>Fertig</Button>}>
      <ol className="m-0 pl-5 flex flex-col gap-3 text-sm">
        <li>
          LifeLink Bridge herunterladen und in WordPress unter <b>Plugins → Installieren → Plugin hochladen</b> installieren und aktivieren.
          <div className="mt-2">
            <Button size="sm" icon="Download" onClick={() => download('/sites/plugin.zip')}>
              LifeLink Bridge (ZIP)
            </Button>
          </div>
        </li>
        <li>
          In WordPress <b>Einstellungen → LifeLink Bridge</b> öffnen und eintragen:
          <div className="mt-2 grid gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg-muted w-28">LifeLink-Adresse</span>
              <code className="bg-raised rounded-control px-2 py-1">{pairing.lifelinkUrl}</code>
              <CopyButton size="sm" value={pairing.lifelinkUrl} />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg-muted w-28">Kopplungscode</span>
              <code className="bg-raised rounded-control px-2 py-1 text-lg tracking-widest font-semibold">{pairing.pairingCode}</code>
              <CopyButton size="sm" value={pairing.pairingCode} />
            </div>
          </div>
        </li>
        <li>„Koppeln“ klicken. Die Website erscheint danach hier als aktiv.</li>
      </ol>
      <Notice tone="warning" className="mt-4">
        Der Code ist einmalig und bis {pairing.site.pairing_expires_at ? fmtDateTime(pairing.site.pairing_expires_at) : 'in 30 Minuten'} gültig. Er wird nur jetzt angezeigt. Der daraus entstehende Schlüssel gilt nur für diese eine Website und lässt sich jederzeit widerrufen.
      </Notice>
    </Dialog>
  );
}

export default function Sites() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const manage = can('channel.manage');
  const q = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites'), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['sites'] });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Websites"
        subtitle="WordPress-Websites mit der LifeLink Bridge. Die Bridge holt freigegebene Beiträge per HTTPS ab und meldet die veröffentlichte Adresse zurück."
        actions={
          manage && (
            <>
              <Button icon="Download" onClick={() => download('/sites/plugin.zip')}>
                Bridge herunterladen
              </Button>
              <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>
                Website koppeln
              </Button>
            </>
          )
        }
      />
      {q.isLoading && <SkeletonRows rows={3} />}
      {q.error && <ErrorBox title="Websites konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && (
        <EmptyState icon="Globe" title="Noch keine Website gekoppelt" text="Ohne Website funktioniert der interne Ablauf mit Freigaben trotzdem vollständig." action={manage && <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>Website koppeln</Button>} />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {(q.data ?? []).map((s) => {
          const stale = s.status === 'active' && (!s.last_seen_at || Date.now() - new Date(s.last_seen_at).getTime() > 15 * 60_000);
          return (
            <Card
              key={s.id}
              title={
                <span className="flex items-center gap-2">
                  <Icon name="Globe" size={16} /> {s.name}
                </span>
              }
              action={<StatusBadge status={s.status} labels={{ pending: 'Wartet auf Kopplung' }} />}
            >
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-fg-muted">Adresse</dt>
                <dd className="m-0 break-all">{s.site_url ? <a href={s.site_url} target="_blank" rel="noopener noreferrer">{s.site_url}</a> : '–'}</dd>
                <dt className="text-fg-muted">Letzter Abruf</dt>
                <dd className={`m-0 ${stale ? 'text-warn' : ''}`}>{s.last_seen_at ? fmtRelative(s.last_seen_at) : 'noch nie'}</dd>
                <dt className="text-fg-muted">Bridge</dt>
                <dd className="m-0">{s.plugin_version ?? '–'}{s.wp_version ? ` · WordPress ${s.wp_version}` : ''}</dd>
                <dt className="text-fg-muted">Aufträge</dt>
                <dd className="m-0">{s.open_jobs} offen · {s.published_count} veröffentlicht</dd>
              </dl>
              {stale && <Notice tone="warning" className="mt-3">Die Website hat sich seit über 15 Minuten nicht gemeldet. WP-Cron bzw. Host-Cron prüfen.</Notice>}
              {manage && s.status !== 'revoked' && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {s.status === 'pending' && (
                    <Button size="sm" icon="KeyRound" onClick={async () => setPairing(await post<Pairing>(`/sites/${s.id}/pairing-code`).catch((e) => (toastError(e), null)))}>
                      Neuen Kopplungscode
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    icon="Unlink"
                    onClick={async () => {
                      if (!confirm(`Kopplung von „${s.name}“ widerrufen? Die Bridge kann danach keine Aufträge mehr abholen.`)) return;
                      await post(`/sites/${s.id}/revoke`).catch(toastError);
                      refresh();
                    }}
                  >
                    Widerrufen
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {adding && (
        <Dialog
          open
          onClose={() => setAdding(false)}
          title="Website koppeln"
          footer={
            <>
              <Button onClick={() => setAdding(false)}>Abbrechen</Button>
              <Button
                variant="primary"
                disabled={name.trim().length < 2}
                onClick={async () => {
                  try {
                    const p = await post<Pairing>('/sites', { name: name.trim() });
                    setAdding(false);
                    setName('');
                    setPairing(p);
                    refresh();
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Kopplungscode erzeugen
              </Button>
            </>
          }
        >
          <FieldWrap label="Name der Website" help="Nur intern, z. B. „Öffentliche Website“ oder „Testseite“." htmlFor="s-name">
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </FieldWrap>
        </Dialog>
      )}
      {pairing && <PairingDialog pairing={pairing} onClose={() => (setPairing(null), refresh())} />}
    </div>
  );
}
