import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, download, get, post } from '../../api/client';
import type { Site } from '../../api/types';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch } from '../../components/ui/core';
import { put } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { CopyButton, Dialog, useErrorToast, useConfirm } from '../../components/ui/overlays';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { Link } from 'react-router';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';

const CRON_LABEL: Record<string, string> = {
  'wp-cron': 'WP-Cron',
  host: 'Host-Cron',
  self: 'Selbstauslösung der Bridge (WP-Cron abgeschaltet)',
  manual: 'bisher nur „Jetzt abrufen“',
  unknown: 'noch kein Abruf',
};
const DISPLAY_SHORT: Record<string, string> = { banner: 'Banner', popup: 'Popup', both: 'Banner + Popup' };
const AUTHOR_LABEL: Record<string, string> = { bridge: 'eigener Autor der Bridge', person: 'Person aus BlaulichtCMS', fixed: 'fester Benutzer' };

/** Meldung der Bridge (#186): Abrufweg, automatische Updates, Darstellung, Autor, Kategorien. */
function BridgeReportRows({ site }: { site: Site }) {
  const r = site.report;
  if (!r) return null;
  return (
    <>
      <dt className="text-fg-muted">Abrufweg</dt>
      <dd className="m-0">{CRON_LABEL[r.cron?.mode ?? 'unknown'] ?? '–'}</dd>
      <dt className="text-fg-muted">Auto-Updates</dt>
      <dd className="m-0">{r.auto_update ? 'an' : 'aus'}</dd>
      {r.display && (
        <>
          <dt className="text-fg-muted">Hinweise</dt>
          <dd className="m-0">
            Hinweis: {DISPLAY_SHORT[r.display.info ?? 'banner']} · Warnung: {DISPLAY_SHORT[r.display.warning ?? 'banner']} · Gefahr: {DISPLAY_SHORT[r.display.danger ?? 'both']}
          </dd>
        </>
      )}
      <dt className="text-fg-muted">Autor</dt>
      <dd className="m-0">{AUTHOR_LABEL[r.author_mode ?? 'bridge'] ?? '–'}</dd>
      <dt className="text-fg-muted">Kategorien</dt>
      <dd className="m-0">{r.categories?.length ?? 0} gemeldet</dd>
    </>
  );
}

interface Pairing {
  site: Site;
  pairingCode: string;
  blaulichtcmsUrl: string;
}

function PairingDialog({ pairing, onClose }: { pairing: Pairing; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Website „${pairing.site.name}“ koppeln`} width={600} footer={<Button variant="primary" onClick={onClose}>Fertig</Button>}>
      <ol className="m-0 pl-5 flex flex-col gap-3 text-sm">
        <li>
          BlaulichtCMS Bridge herunterladen und in WordPress unter <b>Plugins → Installieren → Plugin hochladen</b> installieren und aktivieren (<HelpLink href="https://wordpress.org/documentation/article/manage-plugins/#upload-via-wordpress-admin">Anleitung von WordPress</HelpLink>).
          <div className="mt-2">
            <Button size="sm" icon="Download" onClick={() => download('/sites/plugin.zip')}>
              BlaulichtCMS Bridge (ZIP)
            </Button>
          </div>
        </li>
        <li>
          In WordPress <b>Einstellungen → BlaulichtCMS Bridge</b> öffnen und eintragen:
          <div className="mt-2 grid gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg-muted w-28 inline-flex items-center gap-1">BlaulichtCMS-Adresse
                <HelpTip title="BlaulichtCMS-Adresse" more="/hilfe/wordpress#voraussetzungen">
                  <p className="m-0">Die öffentliche Adresse aus Einstellungen → Organisation. Die Website muss sie per HTTPS erreichen können; einen Eingang in WordPress braucht es nicht.</p>
                </HelpTip>
              </span>
              <code className="bg-raised rounded-control px-2 py-1">{pairing.blaulichtcmsUrl}</code>
              <CopyButton size="sm" value={pairing.blaulichtcmsUrl} />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg-muted w-28 inline-flex items-center gap-1">Kopplungscode
                <HelpTip title="Kopplungscode" more="/hilfe/wordpress#kopplungscode">
                  <p className="m-0">Einmalig und 30 Minuten gültig, nur jetzt sichtbar. Abgelaufen? Auf der Website-Karte „Neuen Kopplungscode“ wählen.</p>
                  <p className="m-0">Die Kopplung ist zugleich der Test: Danach zeigt die Karte „Aktiv“ und den letzten Abruf.</p>
                </HelpTip>
              </span>
              <code className="bg-raised rounded-control px-2 py-1 text-lg tracking-widest font-semibold">{pairing.pairingCode}</code>
              <CopyButton size="sm" value={pairing.pairingCode} />
            </div>
          </div>
        </li>
        <li>„Koppeln“ klicken. Die Website erscheint danach hier als aktiv.</li>
        <li>Fertig: Die Bridge holt Aufträge jede Minute selbst ab, ein Cronjob ist nicht nötig. In den Bridge-Einstellungen lassen sich Autor, Standardkategorie und die Darstellung der Hinweise festlegen – siehe <Link to="/hilfe/wordpress#einstellungen-der-bridge">Einstellungen der Bridge</Link>.</li>
      </ol>
      <Notice tone="warning" className="mt-4">
        Der Code ist einmalig und bis {pairing.site.pairing_expires_at ? fmtDateTime(pairing.site.pairing_expires_at) : 'in 30 Minuten'} gültig. Er wird nur jetzt angezeigt. Der daraus entstehende Schlüssel gilt nur für diese eine Website und lässt sich jederzeit widerrufen.
      </Notice>
    </Dialog>
  );
}

export default function Sites() {
  const ask = useConfirm();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const manage = can('channel.sites');
  const q = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites'), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['sites'] });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="WordPress-Websites mit der BlaulichtCMS Bridge. Die Bridge holt freigegebene Beiträge per HTTPS ab und meldet die veröffentlichte Adresse zurück."
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
        <EmptyState icon="Globe" title="Noch keine Website gekoppelt." text={manage ? 'Ohne Website funktioniert der interne Ablauf mit Freigaben trotzdem vollständig.' : 'Websites koppelt, wer das Recht „Websites koppeln und widerrufen“ hat.'} action={manage && <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>Website koppeln</Button>} />
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
                <dd className="m-0 break-all">{s.site_url ? safeHref(s.site_url) ? <a href={safeHref(s.site_url)} target="_blank" rel="noopener noreferrer">{s.site_url}</a> : s.site_url : '–'}</dd>
                <dt className="text-fg-muted">Letzter Abruf</dt>
                <dd className={`m-0 ${stale ? 'text-warn' : ''}`}>{s.last_seen_at ? fmtRelative(s.last_seen_at) : 'noch nie'}</dd>
                <dt className="text-fg-muted">Bridge</dt>
                <dd className="m-0">{s.plugin_version ?? '–'}{s.wp_version ? ` · WordPress ${s.wp_version}` : ''}</dd>
                <dt className="text-fg-muted">Aufträge</dt>
                <dd className="m-0">{s.open_jobs} offen · {s.published_count} veröffentlicht</dd>
                {s.status === 'active' && <BridgeReportRows site={s} />}
              </dl>
              {s.status === 'active' && s.report?.cron?.hint && <Notice tone="warning" className="mt-3">{s.report.cron.hint}</Notice>}
              {s.status !== 'revoked' && (
                <div className="mt-3">
                  <Switch
                    checked={!!s.send_author}
                    disabled={!manage}
                    onChange={async (v) => {
                      await put(`/sites/${s.id}/options`, { sendAuthor: v }).catch(toastError);
                      refresh();
                    }}
                    label="Autorenname übertragen"
                    description="Name der Person, die den Beitrag angelegt hat, für die Autorenangabe in WordPress. Wirkt nur, wenn in den Bridge-Einstellungen „Person aus BlaulichtCMS“ gewählt ist. Sonst steht dort der eigene Autor der Bridge."
                  />
                </div>
              )}
              {stale && <Notice tone="warning" className="mt-3">Die Website hat sich seit über 15 Minuten nicht gemeldet. In WordPress unter Einstellungen → BlaulichtCMS Bridge den Abrufweg und den letzten Fehler prüfen – <Link to="/hilfe/wordpress#abruf-und-cronjob">Abruf und Cronjob</Link>.</Notice>}
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
                      if (!(await ask({ title: "Kopplung widerrufen?", text: `Die Bridge auf „${s.name}“ kann danach keine Aufträge mehr abholen. Zum Weiterarbeiten muss die Website neu gekoppelt werden.`, confirmLabel: "Widerrufen" }))) return;
                      await post(`/sites/${s.id}/revoke`).catch(toastError);
                      refresh();
                    }}
                  >
                    Widerrufen
                  </Button>
                </div>
              )}
              {manage && s.status === 'revoked' && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  <Button
                    size="sm"
                    icon="Trash2"
                    onClick={async () => {
                      if (!(await ask({ title: 'Website entfernen?', text: `„${s.name}“ verschwindet aus dieser Liste. Beiträge, Banner und Einträge der Einsatzliste, die schon an diese Website gingen, behalten ihren Verlauf mit dem Namen der Website.`, confirmLabel: 'Entfernen' }))) return;
                      await del(`/sites/${s.id}`).catch(toastError);
                      refresh();
                    }}
                  >
                    Entfernen
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
              {name.trim().length < 2 && <span id="sp-why" className="mr-auto self-center text-meta text-fg-muted">Erst einen Namen eintragen (mindestens 2 Zeichen).</span>}
          <Button onClick={() => setAdding(false)}>Abbrechen</Button>
              <Button
                variant="primary"
                disabled={name.trim().length < 2}
            aria-describedby={name.trim().length < 2 ? 'sp-why' : undefined}
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
      {can('channel.updates') && <BridgeUpdates />}
    </div>
  );
}

/** Bridge-Updates: zuerst auf einer Testwebsite, dann für alle freigeben. */
function BridgeUpdates() {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['bridge-release'], queryFn: () => get<any>('/sites/bridge-release') });
  const [note, setNote] = useState('');
  if (!q.data) return null;
  const { bundled, releases, sites } = q.data;
  const released = releases.some((r: any) => r.version === bundled.version);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
    qc.invalidateQueries({ queryKey: ['bridge-release'] });
  };
  return (
    <Card title="Bridge-Updates" subtitle="Updates kommen über den normalen WordPress-Updateweg. Websites in der Stufe „Test“ erhalten neue Versionen zuerst.">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          Version in BlaulichtCMS: <strong>{bundled.version}</strong>
          <code className="text-meta">{bundled.sha256.slice(0, 16)}…</code>
          {released ? <Badge tone="success">für alle freigegeben</Badge> : <Badge tone="warning">nur Stufe Test</Badge>}
          {bundled.signature?.state === 'valid' && <Badge tone="success">signiert</Badge>}
          {bundled.signature?.state === 'not_configured' && <Badge tone="neutral">ohne Signatur (nur Prüfsumme)</Badge>}
          {(bundled.signature?.state === 'unsigned' || bundled.signature?.state === 'invalid') && <Badge tone="error">Signatur ungültig</Badge>}
        </div>
        {(bundled.signature?.state === 'unsigned' || bundled.signature?.state === 'invalid') && (
          <Notice tone="error">Websites mit Signaturprüfung lehnen dieses Paket ab: {bundled.signature.reason} Vor der Freigabe neu signieren.</Notice>
        )}
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {sites.map((s: any) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-[160px] font-medium">{s.name}</span>
              <span className="text-fg-muted">Bridge {s.plugin_version ?? '–'}</span>
              {s.plugin_version === bundled.version && <Badge tone="success">aktuell</Badge>}
              <Select aria-label={`Update-Stufe ${s.name}`} value={s.update_channel} onChange={(e) => act(() => put(`/sites/${s.id}/update-channel`, { channel: e.target.value }))} className="max-w-[160px]">
                <option value="stable">Stufe: Stabil</option>
                <option value="test">Stufe: Test</option>
              </Select>
            </li>
          ))}
        </ul>
        {!released && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <FieldWrap label="Prüfnotiz (Testwebsite, Theme, Ergebnis)" htmlFor="br-note" className="flex-1 min-w-[240px]" labelAction={
              <HelpTip title="Bridge-Update freigeben" more="/hilfe/updates#blaulichtcms-bridge">
                <p className="m-0">Erst eine Testwebsite in die Stufe „Test“ setzen, dort in WordPress aktualisieren und prüfen (Beitrag, Banner, Zurückziehen). Freigeben lässt sich die Version erst, wenn die Testwebsite sie meldet.</p>
              </HelpTip>
            }>
              <Input id="br-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </FieldWrap>
            {note.trim().length < 5 && <span id="br-why" className="self-center text-meta text-fg-muted">Erst eine Prüfnotiz eintragen (mindestens 5 Zeichen).</span>}
            <Button variant="primary" icon="CheckCircle2" disabled={note.trim().length < 5} aria-describedby={note.trim().length < 5 ? 'br-why' : undefined} onClick={() => act(() => post('/sites/bridge-release', { version: bundled.version, note }))}>
              Version {bundled.version} für alle freigeben
            </Button>
          </div>
        )}
        {releases.length > 0 && (
          <ul className="m-0 pl-4 text-meta text-fg-muted">
            {releases.map((r: any) => (
              <li key={r.version}>
                {r.version} freigegeben von {r.approved_by_name ?? '–'} am {fmtDateTime(r.approved_at)} (getestet auf {r.tested_on_name ?? '–'}): {r.note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
