import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Site } from '../../api/types';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, Input, LinkButton, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch } from '../../components/ui/core';
import { useAuth } from '../../lib/auth';
import { Icon } from '../../components/ui/Icon';
import { Dialog, OneTimeSecret, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { FormProblems, useFormCheck } from '../../components/ui/form';
import { fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';
import { useListState } from '../../lib/listState';
import { rank, searchTerms } from '../../lib/searchText';

export const CONN_STATE: Record<string, string> = { draft: 'Eingerichtet – Test ausstehend', tested: 'Getestet – bereit zum Aktivieren', active: 'Aktiv', disabled: 'Angehalten', revoked: 'Widerrufen' };
/**
 * Arten von Verbindungen, nach Richtung (#271): eingehend (Einsätze und Warnungen kommen an) oder zum Veröffentlichen
 * (Beiträge gehen hinaus). `name` ist der Vorschlag für den Namen („Facebook-Seite Musterwehr“).
 */
export const KINDS = [
  { id: 'fe2', dir: 'in', label: 'FE2 – Einsatzentwürfe', name: 'FE2', icon: 'Siren', text: 'Eingehende Einsätze als interne Beitragsentwürfe. Die Alarmierung bleibt unabhängig.' },
  { id: 'feuersoftware', dir: 'in', label: 'Feuersoftware Connect', name: 'Feuersoftware Connect', icon: 'RadioTower', text: 'Einsätze aus Feuersoftware Connect regelmäßig abrufen und als interne Beitragsentwürfe anlegen – wie bei FE2.' },
  { id: 'warnfeed', dir: 'in', label: 'Amtliche Warnungen', name: 'Amtliche Warnungen', icon: 'AlertTriangle', text: 'Warnungen für das eigene Gebiet anzeigen – getrennt vom eigenen Warnentwurf.' },
  { id: 'facebook', dir: 'out', label: 'Facebook-Seite', name: 'Facebook-Seite', icon: 'Share2', text: 'Freigegebene Beiträge und Storys auf einer Facebook-Seite veröffentlichen.' },
  { id: 'instagram', dir: 'out', label: 'Instagram-Konto', name: 'Instagram', icon: 'Camera', text: 'Freigegebene Beiträge und Storys mit Bild oder Video auf einem professionellen Instagram-Konto.' },
  { id: 'threads', dir: 'out', label: 'Threads-Profil', name: 'Threads', icon: 'AtSign', text: 'Freigegebene Beiträge mit Text, Bild oder Link über die offizielle Threads-Schnittstelle.' },
  { id: 'x', dir: 'out', label: 'X-Konto', name: 'X', icon: 'MessagesSquare', text: 'Teilen von Hand mit vorbereitetem Text oder – mit eigenem, kostenpflichtigem API-Zugang – direkt posten.' },
  { id: 'mastodon', dir: 'out', label: 'Mastodon-Konto', name: 'Mastodon', icon: 'AtSign', text: 'Freigegebene Beiträge mit Text, Bildern samt Alternativtext und Link auf einer frei wählbaren Mastodon-Instanz (z. B. social.bund.de).' },
  { id: 'bluesky', dir: 'out', label: 'Bluesky-Konto', name: 'Bluesky', icon: 'Cloud', text: 'Freigegebene Beiträge mit Text, bis zu 4 Bildern samt Alternativtext und Link-Vorschaukarte – mit App-Passwort.' },
  { id: 'whatsapp', dir: 'out', label: 'WhatsApp-Kanal', name: 'WhatsApp-Kanal', icon: 'MessageCircle', text: 'Teilen von Hand: Text, Link und Bilder vorbereitet, geteilt wird in WhatsApp.' },
] as const;
/** Website (WordPress) im Dialog „Neue Verbindung“: führt zum Koppeln unter Verbindungen → Websites. */
const WEBSITE_KIND = { id: 'website', dir: 'out', label: 'Website (WordPress)', name: 'Website', icon: 'Globe', text: 'Freigegebene Beiträge, Banner und Einsatzliste auf eurer WordPress-Website – über das Plugin BlaulichtCMS Bridge.' } as const;
const DIRS = [
  { id: 'in', title: 'Eingehend', subtitle: 'Einsätze und Warnungen, die BlaulichtCMS empfängt' },
  { id: 'out', title: 'Veröffentlichen', subtitle: 'Websites und soziale Netzwerke, an die BlaulichtCMS freigegebene Beiträge sendet' },
] as const;
const dirOf = (kind: string) => KINDS.find((k) => k.id === kind)?.dir ?? 'out';
const SITE_STATE: Record<Site['status'], { status: string; label: string }> = { active: { status: 'active', label: 'Gekoppelt' }, pending: { status: 'pending', label: 'Kopplung offen' }, revoked: { status: 'revoked', label: 'Getrennt' } };

export default function Connections() {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const { can, me } = useAuth();
  const configure = can('connection.configure');
  const pairSites = can('channel.sites');
  // Meldung der OAuth-Rückleitung, wenn Meta ohne state zurückleitet (Verbindung unbekannt)
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const m = params.get('meldung');
    if (!m) return;
    toast({ tone: 'error', title: m });
    setParams((p) => { const n = new URLSearchParams(p); n.delete('meldung'); return n; }, { replace: true });
  }, [params, setParams, toast]);
  // Suche, Art, Status und „Gelöschte anzeigen“ in der Adresse (#260)
  const ls = useListState({ suche: '', art: '', status: '', geloeschte: '' });
  const showDeleted = ls.values.geloeschte === '1' && can('connection.delete');
  const setShowDeleted = (v: boolean) => ls.set({ geloeschte: v ? '1' : '' });
  const q = useQuery({ queryKey: ['connections', showDeleted], queryFn: () => get<any[]>(`/connections${showDeleted ? '?deleted=1' : ''}`), enabled: can('connection.view') });
  const terms = searchTerms(ls.values.suche);
  const all = q.data ?? [];
  const rows = all.filter((c) => (!terms.length || rank(terms, c.name, `${c.kind_label} ${c.account?.name ?? ''} ${c.account?.username ?? ''}`) !== null) && (!ls.values.art || c.kind === ls.values.art) && (!ls.values.status || c.status === ls.values.status));
  const kinds = [...new Map(all.map((c) => [c.kind, c.kind_label] as [string, string])).entries()];
  // Websites sind Veröffentlichungsziele mit eigener Unterseite (Verbindungen → Websites)
  const sitesQ = useQuery({ queryKey: ['sites'], queryFn: () => get<Site[]>('/sites'), enabled: can('channel.view') });
  const sites = (sitesQ.data ?? []).filter((s) => s.status !== 'revoked' && (!terms.length || rank(terms, s.name, 'Website WordPress') !== null) && !ls.values.art && !ls.values.status);
  // Nichts vorausgewählt; Name aus Art und Organisation vorgeschlagen, solange nichts Eigenes eingetragen ist
  const [create, setCreate] = useState<{ kind: string; name: string; touched: boolean } | null>(null);
  const org = me?.instance.organization || me?.instance.name || '';
  const suggest = (kind: string) => {
    if (kind === 'website') return (org ? `Website ${org}` : 'Website').slice(0, 80);
    const k = KINDS.find((x) => x.id === kind);
    return k ? `${k.name}${org ? ` ${org}` : ''}`.slice(0, 100) : '';
  };
  const check = useFormCheck({
    'c-kind': !!create && !create.kind && 'Bitte eine Art wählen.',
    'c-name': !!create && create.name.trim().length < 2 && 'Bitte einen Namen angeben (mindestens 2 Zeichen).',
  });
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const submit = async () => {
    if (create!.kind === 'website') return nav('/verbindungen/websites', { state: { koppeln: create!.name.trim().slice(0, 80) } });
    try {
      const r = await post<{ id: string; token: string | null }>('/connections', { kind: create!.kind, name: create!.name.trim() });
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
        subtitle="Optional: Jede Verbindung durchläuft Verbinden → Testen → Vorschau → Aktivieren. BlaulichtCMS funktioniert auch ganz ohne."
        actions={
          (configure || pairSites) && (
            <Button variant="primary" icon="Plus" onClick={() => (check.reset(), setCreate({ kind: '', name: '', touched: false }))}>
              Neue Verbindung
            </Button>
          )
        }
      />
      {(all.length > 0 || showDeleted) && (
        <ListToolbar
          search={{ value: ls.values.suche, onChange: (v) => ls.set({ suche: v }), placeholder: 'Suchen in Verbindungen', label: 'Verbindungen durchsuchen (Name, Art, Konto)' }}
          filters={[
            { key: 'art', label: 'Art', value: ls.values.art, onChange: (v) => ls.set({ art: v }), allLabel: 'Alle Arten', options: kinds.map(([value, label]) => ({ value, label })) },
            { key: 'status', label: 'Status', value: ls.values.status, onChange: (v) => ls.set({ status: v }), options: Object.entries(CONN_STATE).map(([value, label]) => ({ value, label: String(label) })) },
          ]}
          count={{ n: rows.length, one: 'Verbindung', many: 'Verbindungen' }}
          onReset={() => ls.reset(['geloeschte'])}
        />
      )}
      {configure && can('connection.delete') && <Switch checked={showDeleted} onChange={setShowDeleted} label="Gelöschte anzeigen" description="Auch widerrufene und gelöschte Verbindungen – zur Nachvollziehbarkeit, ohne Zugangsdaten." />}
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Verbindungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {(q.data?.length ?? 0) === 0 && !q.isLoading && !sitesQ.isLoading && !sites.length && !terms.length && (
        <EmptyState
          icon="Plug"
          title="Noch keine Verbindung."
          text={configure || pairSites ? 'Eure WordPress-Website, Facebook, Instagram, Threads, X, WhatsApp-Kanal, FE2, Feuersoftware Connect oder amtliche Warnungen lassen sich hier anbinden.' : 'Verbindungen richtet ein, wer Verbindungen verwalten darf.'}
          action={(configure || pairSites) && <Button icon="Plus" onClick={() => (check.reset(), setCreate({ kind: '', name: '', touched: false }))}>Neue Verbindung</Button>}
        />
      )}
      {all.length > 0 && !rows.length && <FilterEmpty onReset={() => ls.reset(['geloeschte'])} />}
      {DIRS.map((dir) => {
        const list = rows.filter((c) => dirOf(c.kind) === dir.id);
        const withSites = dir.id === 'out' && can('channel.view');
        if (!list.length && !(withSites && sites.length)) return null;
        return (
          <section key={dir.id} aria-labelledby={`dir-${dir.id}`} className="flex flex-col gap-3">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h2 id={`dir-${dir.id}`} className="m-0 text-section font-semibold">
                  {dir.title}
                </h2>
                <p className="m-0 text-meta text-fg-muted">{dir.subtitle}</p>
              </div>
              {withSites && <LinkButton to="/verbindungen/websites" size="sm" variant="ghost" icon="Globe">Websites verwalten</LinkButton>}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {withSites &&
                sites.map((s) => (
                  <Card key={`site-${s.id}`}>
                    <Link to="/verbindungen/websites" className="w-full flex flex-col gap-2 no-underline !text-fg">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Icon name="Globe" size={16} />
                        <strong>{s.name}</strong>
                        <Badge dot={false}>Website (WordPress)</Badge>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge status={SITE_STATE[s.status].status} labels={{ [SITE_STATE[s.status].status]: SITE_STATE[s.status].label }} />
                        {s.last_seen_at && <span className="text-meta text-fg-muted">zuletzt gemeldet {fmtRelative(s.last_seen_at)}</span>}
                      </div>
                      <span className="text-sm text-fg-muted inline-flex items-center gap-1">
                        Kopplung, Bridge und Updates <Icon name="ArrowRight" size={13} />
                      </span>
                    </Link>
                  </Card>
                ))}
        {list.map((c) => {
          const body = (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Icon name={KINDS.find((k) => k.id === c.kind)?.icon ?? 'Plug'} size={16} />
                <strong>{c.name}</strong>
                <Badge dot={false}>{c.kind_label}</Badge>
                {c.deleted_at && <Badge tone="error">Gelöscht {fmtRelative(c.deleted_at)}</Badge>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={c.status === 'tested' ? 'approved' : c.status === 'disabled' ? 'ended' : c.status} labels={{ [c.status === 'tested' ? 'approved' : c.status === 'disabled' ? 'ended' : c.status]: CONN_STATE[c.status] }} />
                {c.last_event_at && <span className="text-meta text-fg-muted">zuletzt aktiv {fmtRelative(c.last_event_at)}</span>}
              </div>
              {c.account?.name || c.account?.username ? <div className="text-sm text-fg-muted">{c.account.name ?? `@${c.account.username}`}</div> : null}
              {c.last_error && <div className="text-sm text-err">{c.last_error}</div>}
            </>
          );
          // Die Detailseite setzt „Verbindungen verwalten“ voraus – ohne das Recht bleibt die Karte reine Anzeige
          return (
            <Card key={c.id}>
              {configure ? (
                <button type="button" className="w-full text-left flex flex-col gap-2" onClick={() => nav(`/verbindungen/${c.id}`)}>
                  {body}
                </button>
              ) : (
                <div className="flex flex-col gap-2">{body}</div>
              )}
            </Card>
          );
        })}
            </div>
          </section>
        );
      })}

      {create && (
        <Dialog
          open
          onClose={() => setCreate(null)}
          title="Neue Verbindung"
          width={640}
          footer={
            <>
              <Button onClick={() => setCreate(null)}>Abbrechen</Button>
              <Button variant="primary" onClick={() => check.submit(submit)}>
                Weiter
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FormProblems check={check} />
            <div id="c-kind" tabIndex={-1} className="flex flex-col gap-4 outline-none" aria-invalid={!!check.error('c-kind') || undefined}>
              {check.error('c-kind') && (
                <p className="m-0 text-meta text-err" role="alert">
                  {check.error('c-kind')}
                </p>
              )}
              {DIRS.filter((dir) => configure || (dir.id === 'out' && pairSites)).map((dir) => (
                <div key={dir.id} className="flex flex-col gap-2">
                  <div>
                    <h3 id={`new-${dir.id}`} className="m-0 text-sm font-semibold">
                      {dir.title}
                    </h3>
                    <p className="m-0 text-meta text-fg-muted">{dir.subtitle}</p>
                  </div>
                  <div role="radiogroup" aria-labelledby={`new-${dir.id}`} aria-required="true" className="grid gap-2 sm:grid-cols-2">
                    {[...(dir.id === 'out' && pairSites ? [WEBSITE_KIND] : []), ...(configure ? KINDS.filter((k) => k.dir === dir.id) : [])].map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        role="radio"
                        aria-checked={create.kind === k.id}
                        onClick={() => setCreate({ ...create, kind: k.id, name: create.touched && create.name.trim() ? create.name : suggest(k.id) })}
                        className={`text-left p-3 rounded-node border ${create.kind === k.id ? 'border-primary bg-primary-soft shadow-selected' : 'border-line bg-card hover:bg-raised'}`}
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          <Icon name={k.icon} size={16} /> {k.label}
                          {create.kind === k.id && <Icon name="Check" size={15} className="ml-auto" />}
                        </div>
                        <div className="text-meta text-fg-muted mt-1">{k.text}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <FieldWrap label="Name" htmlFor="c-name" required error={check.error('c-name')} help="Vorschlag aus Art und Organisation – frei änderbar. Das verbundene Konto erscheint später in der Liste darunter.">
              <Input id="c-name" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value, touched: true })} maxLength={100} />
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
  const { can } = useAuth();
  const mayBanner = can('banner.edit') && can('channel.view');
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<any[]>('/sites'), enabled: mayBanner });
  const toastError = useErrorToast();
  const toast = useToast();
  const ask = useConfirm();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [site, setSite] = useState('');
  const active = (sites.data ?? []).filter((s) => s.status === 'active');
  // „Was ist angekommen?“ – Empfangsprotokoll der Warnfeeds (nur mit „Empfangsprotokoll ansehen“)
  const feedsQ = useQuery({ queryKey: ['connections', false], queryFn: () => get<any[]>('/connections'), enabled: can('connection.configure') && can('connection.log') });
  const feeds = (feedsQ.data ?? []).filter((c) => c.kind === 'warnfeed');
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Aus verbundenen Warnquellen – getrennt vom eigenen Warnentwurf. Maßgeblich ist immer die Originalquelle."
        actions={
          feeds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {feeds.map((f) => (
                <LinkButton key={f.id} to={`/verbindungen/${f.id}?ansicht=empfangsprotokoll`} icon="ScrollText">
                  {feeds.length > 1 ? `Was ist angekommen? (${f.name})` : 'Was ist angekommen?'}
                </LinkButton>
              ))}
            </div>
          ) : undefined
        }
      />
      <Notice>
        Ohne fachlich geprüfte Freigabe für automatische Banner verlinkt die Website auf die Originalquelle, z. B. <a href="https://warnung.bund.de" target="_blank" rel="noreferrer">warnung.bund.de</a>. Ein Banner-Entwurf durchläuft die normale Freigabe.
      </Notice>
      {mayBanner && active.length > 0 && (
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
      {q.data?.length === 0 && (
        <EmptyState
          icon="AlertTriangle"
          title="Keine amtlichen Warnungen."
          text={feeds.length || !can('connection.configure') ? 'Aktuell liegen keine Meldungen der verbundenen Warnquellen vor.' : 'Noch keine Warnquelle verbunden.'}
          action={!feeds.length && can('connection.configure') && <LinkButton to="/verbindungen" icon="Plug">Warnquelle verbinden</LinkButton>}
        />
      )}
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
                {mayBanner && !w.cancelled && !w.superseded && w.in_area && site && (
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
                {can('official.dismiss') && (
                  <Button size="sm" variant="ghost" icon="EyeOff" onClick={async () => {
                    const ok = await ask({
                      title: 'Amtliche Warnung ausblenden?',
                      text: `„${w.headline || w.event}“ verschwindet aus dieser Liste und wird bei späteren Abrufen nicht wieder angelegt.${w.banner_id ? ' Das daraus entstandene Banner wird beendet.' : ''} Aktualisierungen und Entwarnungen der Quelle erscheinen weiterhin. Maßgeblich bleibt die Originalquelle.`,
                      confirmLabel: 'Ausblenden',
                    });
                    if (!ok) return;
                    try {
                      const r = await post<{ bannerEnded: boolean }>(`/official-warnings/${w.id}/dismiss`);
                      toast({ tone: 'success', title: r.bannerEnded ? 'Ausgeblendet, Banner beendet' : 'Ausgeblendet' });
                      await qc.invalidateQueries({ queryKey: ['official-warnings'] });
                    } catch (e) {
                      toastError(e);
                    }
                  }}>
                    Ausblenden
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
