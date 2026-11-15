import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, OneTimeSecret, useErrorToast } from '../../components/ui/overlays';
import { fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';

export const CONN_STATE: Record<string, string> = { draft: 'Eingerichtet – Test ausstehend', tested: 'Getestet – bereit zum Aktivieren', active: 'Aktiv', disabled: 'Angehalten', revoked: 'Widerrufen' };
export const KINDS = [
  { id: 'fe2', label: 'FE2 – Einsatzentwürfe', icon: 'Siren', text: 'Eingehende Einsätze als interne Beitragsentwürfe. Die Alarmierung bleibt unabhängig.' },
  { id: 'facebook', label: 'Facebook-Seite', icon: 'Share2', text: 'Freigegebene Beiträge auf einer Facebook-Seite veröffentlichen.' },
  { id: 'instagram', label: 'Instagram-Konto', icon: 'Camera', text: 'Freigegebene Beiträge mit Bild oder Video auf einem professionellen Instagram-Konto.' },
  { id: 'warnfeed', label: 'Amtliche Warnungen', icon: 'AlertTriangle', text: 'Warnungen für das eigene Gebiet anzeigen – getrennt vom eigenen Warnentwurf.' },
] as const;

export default function Connections() {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['connections'], queryFn: () => get<any[]>('/connections') });
  const [create, setCreate] = useState<{ kind: string; name: string } | null>(null);
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const submit = async () => {
    try {
      const r = await post<{ id: string; token: string | null }>('/connections', create);
      setCreate(null);
      if (r.token) setToken({ id: r.id, token: r.token });
      else nav(`/verbindungen/${r.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Verbindungen"
        subtitle="Optional: Jede Verbindung durchläuft Verbinden → Testen → Vorschau → Aktivieren. BlaulichtCMS funktioniert auch ganz ohne."
        actions={
          <Button variant="primary" icon="Plus" onClick={() => setCreate({ kind: 'fe2', name: '' })}>
            Neue Verbindung
          </Button>
        }
      />
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Verbindungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data?.length === 0 && <EmptyState icon="Plug" title="Keine Verbindungen" text="Facebook, Instagram, FE2 oder amtliche Warnungen lassen sich hier anbinden." />}
      <div className="grid gap-3 md:grid-cols-2">
        {(q.data ?? []).map((c) => (
          <Card key={c.id}>
            <button type="button" className="w-full text-left flex flex-col gap-2" onClick={() => nav(`/verbindungen/${c.id}`)}>
              <div className="flex items-center gap-2 flex-wrap">
                <Icon name={KINDS.find((k) => k.id === c.kind)?.icon ?? 'Plug'} size={16} />
                <strong>{c.name}</strong>
                <Badge dot={false}>{c.kind_label}</Badge>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={c.status === 'tested' ? 'approved' : c.status === 'disabled' ? 'ended' : c.status} labels={{ [c.status === 'tested' ? 'approved' : c.status === 'disabled' ? 'ended' : c.status]: CONN_STATE[c.status] }} />
                {c.last_event_at && <span className="text-meta text-fg-muted">zuletzt aktiv {fmtRelative(c.last_event_at)}</span>}
              </div>
              {c.account?.name || c.account?.username ? <div className="text-sm text-fg-muted">{c.account.name ?? `@${c.account.username}`}</div> : null}
              {c.last_error && <div className="text-sm text-err">{c.last_error}</div>}
            </button>
          </Card>
        ))}
      </div>

      {create && (
        <Dialog
          open
          onClose={() => setCreate(null)}
          title="Neue Verbindung"
          width={640}
          footer={
            <>
              <Button onClick={() => setCreate(null)}>Abbrechen</Button>
              <Button variant="primary" disabled={create.name.trim().length < 2} onClick={submit}>
                Weiter
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div role="radiogroup" aria-label="Art" className="grid gap-2 sm:grid-cols-2">
              {KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={create.kind === k.id} onClick={() => setCreate({ ...create, kind: k.id })} className={`text-left p-3 rounded-node border-2 ${create.kind === k.id ? 'border-primary bg-primary-soft' : 'border-line bg-card hover:bg-raised'}`}>
                  <div className="flex items-center gap-2 font-semibold">
                    <Icon name={k.icon} size={16} /> {k.label}
                  </div>
                  <div className="text-meta text-fg-muted mt-1">{k.text}</div>
                </button>
              ))}
            </div>
            <FieldWrap label="Name" htmlFor="c-name" help="Wie die Verbindung in BlaulichtCMS heißen soll.">
              <Input id="c-name" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} maxLength={100} />
            </FieldWrap>
          </div>
        </Dialog>
      )}
      {token && (
        <Dialog
          open
          onClose={() => nav(`/verbindungen/${token.id}`)}
          title="Zugangsschlüssel für FE2"
          footer={
            <Button variant="primary" onClick={() => nav(`/verbindungen/${token.id}`)}>
              Gespeichert – weiter
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            <Notice tone="warning">Der Schlüssel wird nur jetzt angezeigt. In FE2 als Header „Authorization: Bearer …“ eintragen.</Notice>
            <OneTimeSecret value={token.token} label="Zugangsschlüssel" />
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function OfficialWarnings() {
  const q = useQuery({ queryKey: ['official-warnings'], queryFn: () => get<any[]>('/official-warnings') });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<any[]>('/sites') });
  const toastError = useErrorToast();
  const nav = useNavigate();
  const [site, setSite] = useState('');
  const active = (sites.data ?? []).filter((s) => s.status === 'active');
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Amtliche Warnungen" subtitle="Aus verbundenen Warnquellen – getrennt vom eigenen Warnentwurf. Maßgeblich ist immer die Originalquelle." />
      <Notice>
        Ohne fachlich geprüfte Freigabe für automatische Banner verlinkt die Website auf die Originalquelle, z. B. <a href="https://warnung.bund.de" target="_blank" rel="noreferrer">warnung.bund.de</a>. Ein Banner-Entwurf durchläuft die normale Freigabe.
      </Notice>
      {active.length > 0 && (
        <FieldWrap label="Website für Banner-Entwürfe" htmlFor="ow-site" className="max-w-sm">
          <Select id="ow-site" value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">– wählen –</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
      )}
      {q.data?.length === 0 && <EmptyState icon="AlertTriangle" title="Keine amtlichen Warnungen" text="Keine Warnquelle verbunden oder aktuell keine Meldungen." />}
      <div className="flex flex-col gap-3">
        {(q.data ?? []).map((w) => (
          <Card key={w.id}>
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={w.cancelled ? 'success' : ['Extreme', 'Severe'].includes(w.severity) ? 'error' : 'warning'}>{w.cancelled ? 'Entwarnung' : w.msg_type === 'Update' ? 'Aktualisierung' : w.severity || 'Warnung'}</Badge>
                {!w.in_area && <Badge dot={false}>außerhalb des Gebiets</Badge>}
                {w.superseded && <Badge dot={false}>ersetzt</Badge>}
                {w.banner_id && <Badge>Banner</Badge>}
                <span className="text-meta text-fg-muted ml-auto">{w.source} · {fmtRelative(w.received_at)}</span>
              </div>
              <strong>{w.headline || w.event}</strong>
              <div className="text-fg-muted">{(w.areas ?? []).slice(0, 5).join(', ')}</div>
              <div className="flex flex-wrap gap-2 mt-1">
                {safeHref(w.web_url) && (
                  <a href={safeHref(w.web_url)} target="_blank" rel="noopener noreferrer">
                    Originalquelle
                  </a>
                )}
                {!w.cancelled && !w.superseded && w.in_area && site && (
                  <Button size="sm" icon="Megaphone" onClick={async () => {
                    try {
                      await post(`/official-warnings/${w.id}/banner-draft`, { siteId: site });
                      nav('/banner');
                    } catch (e) {
                      toastError(e);
                    }
                  }}>
                    Banner-Entwurf mit Link
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
