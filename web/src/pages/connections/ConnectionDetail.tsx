import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { get, post, put } from '../../api/client';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Input, KeyValue, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CopyButton, OneTimeSecret, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { CONN_STATE } from './Connections';

const STEPS = [
  { id: 'verbinden', label: 'Verbinden' },
  { id: 'testen', label: 'Testen' },
  { id: 'vorschau', label: 'Vorschau' },
  { id: 'aktivieren', label: 'Aktivieren' },
] as const;
type Step = (typeof STEPS)[number]['id'];
const STEP_KIND: Record<string, string> = { login: 'Anmeldung', publish: 'Veröffentlichungstest', read: 'Lesen', receive: 'Empfang' };

export default function ConnectionDetail() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { me } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['connection', id], queryFn: () => get<any>(`/connections/${id}`) });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<any[]>('/sites') });
  const c = q.data;
  const [step, setStep] = useState<Step>('verbinden');
  const [cfg, setCfg] = useState<any>(null);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [review, setReview] = useState<{ checks: Record<string, boolean>; note: string }>({ checks: {}, note: '' });

  useEffect(() => {
    if (c && !cfg) setCfg({ name: c.name, ...c.config });
  }, [c, cfg]);
  useEffect(() => {
    const m = params.get('meldung');
    if (m) {
      toast({ tone: /fehlgeschlagen|abgebrochen|ungültig/i.test(m) ? 'error' : 'success', title: m });
      setParams({}, { replace: true });
    }
  }, [params, setParams, toast]);

  if (q.isLoading || !cfg) return <SkeletonRows rows={6} />;
  if (q.error || !c) return <ErrorBox title="Verbindung konnte nicht geladen werden">{(q.error as Error)?.message}</ErrorBox>;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['connection', id] });
    await qc.invalidateQueries({ queryKey: ['connections'] });
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast({ tone: 'success', title: ok });
      await refresh();
      return r;
    } catch (e) {
      toastError(e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const saveConfig = () => {
    const { name, ...config } = cfg;
    return act(() => put(`/connections/${id}`, { name, config }), 'Gespeichert – bitte erneut testen');
  };
  const saveSecrets = () =>
    act(async () => {
      await put(`/connections/${id}/secrets`, secret);
      setSecret({});
    }, 'Zugangsdaten verschlüsselt gespeichert');
  const revoked = c.status === 'revoked';
  const test = c.last_test;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={c.name}
        subtitle={c.kind_label}
        actions={<StatusBadge status={c.status === 'tested' ? 'approved' : c.status === 'disabled' ? 'ended' : c.status} labels={{ approved: CONN_STATE.tested, ended: CONN_STATE.disabled, [c.status]: CONN_STATE[c.status] }} />}
      />
      <nav aria-label="Schritte" className="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto">
        <ol className="flex gap-2 min-w-max">
          {STEPS.map((s, i) => {
            const done = s.id === 'verbinden' ? true : s.id === 'testen' ? !!test?.ok : s.id === 'vorschau' ? !!test?.ok : c.status === 'active';
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setStep(s.id)} aria-current={s.id === step ? 'step' : undefined} className={cx('flex items-center gap-2 h-9 px-3 rounded-full border text-sm font-medium', s.id === step ? 'bg-primary text-on-primary border-primary' : 'bg-card border-line hover:bg-raised')}>
                  <span className={cx('w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px]', s.id === step ? 'bg-white/20' : done ? 'bg-ok-soft text-ok' : 'bg-raised')}>{done && s.id !== step ? <Icon name="Check" size={12} /> : i + 1}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {revoked && <Notice tone="error">Diese Verbindung wurde widerrufen; ihre Zugangsdaten sind gelöscht.</Notice>}

      {step === 'verbinden' && !revoked && (
        <div className="flex flex-col gap-4">
          <Card title="Einstellungen">
            <div className="flex flex-col gap-4">
              <FieldWrap label="Name" htmlFor="cn"><Input id="cn" value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} /></FieldWrap>

              {c.kind === 'fe2' && (
                <>
                  <FieldWrap label="Eingangsadresse (in FE2 als HTTP-Ausgang, Methode POST, JSON)">
                    <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.inbound_url}</code><CopyButton value={c.inbound_url} size="sm" /></div>
                  </FieldWrap>
                  <p className="m-0 text-meta text-fg-muted">Authentisierung per Header <code>Authorization: Bearer &lt;Schlüssel&gt;</code>. Vor der Aktivierung legt LifeLink nichts an, sondern zeigt nur eine Vorschau. Mit Header <code>X-LifeLink-Test: 1</code> bleibt auch später jede Meldung eine reine Testmeldung.</p>
                  <div>
                    <Button size="sm" icon="KeyRound" onClick={async () => { const r: any = await act(() => post(`/connections/${id}/rotate-token`), 'Neuer Schlüssel erzeugt – der alte gilt nicht mehr'); if (r) setNewToken(r.token); }}>Neuen Zugangsschlüssel erzeugen</Button>
                  </div>
                  {newToken && <OneTimeSecret value={newToken} label="Neuer Zugangsschlüssel (nur jetzt sichtbar)" />}
                  <Switch checked={cfg.createDrafts !== false} onChange={(v) => setCfg({ ...cfg, createDrafts: v })} label="Beitragsentwürfe anlegen" description="Je Einsatz genau ein interner Entwurf. Wiederholungen werden erkannt." />
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer font-medium text-sm">Feldzuordnung (Allowlist)</summary>
                    <p className="text-meta text-fg-muted">Nur diese Felder gelangen in den Entwurf. Pfad im JSON mit Punkten, z. B. <code>einsatz.stichwort</code>. Alles andere – etwa Alarmtext oder Personendaten – wird verworfen. Standard ist eine Annahme und muss mit einer anonymisierten Testmeldung der eigenen FE2-Instanz geprüft werden.</p>
                    <div className="grid sm:grid-cols-2 gap-3 mt-2">
                      {['event_id', ...Object.keys(c.allowed_fields)].map((k) => (
                        <FieldWrap key={k} label={k === 'event_id' ? 'Einsatz-ID (Pflicht, stabil)' : c.allowed_fields[k]} htmlFor={`m-${k}`}>
                          <Input id={`m-${k}`} mono value={cfg.mapping?.[k] ?? ''} placeholder={c.default_mapping[k]} onChange={(e) => setCfg({ ...cfg, mapping: { ...(cfg.mapping ?? {}), [k]: e.target.value } })} />
                        </FieldWrap>
                      ))}
                    </div>
                  </details>
                </>
              )}

              {(c.kind === 'facebook' || c.kind === 'instagram') && (
                <>
                  <Notice tone="primary">
                    Benötigt eine eigene Meta-App mit {c.kind === 'facebook' ? 'Facebook Login und den Rechten pages_show_list, pages_manage_posts, pages_read_engagement' : 'Instagram Login und den Rechten instagram_business_basic, instagram_business_content_publish'}. Weiterleitungsadresse in der App: <code className="break-all">{c.oauth_redirect}</code>
                  </Notice>
                  <FieldWrap label="App-ID" htmlFor="appid"><Input id="appid" mono value={cfg.appId ?? ''} onChange={(e) => setCfg({ ...cfg, appId: e.target.value })} /></FieldWrap>
                  <FieldWrap label={c.secrets_set.includes('appSecret') ? 'App-Geheimnis (gespeichert – nur zum Ersetzen)' : 'App-Geheimnis'} htmlFor="appsec">
                    <Input id="appsec" type="password" autoComplete="off" value={secret.appSecret ?? ''} onChange={(e) => setSecret({ ...secret, appSecret: e.target.value })} />
                  </FieldWrap>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={!secret.appSecret} onClick={saveSecrets}>Geheimnis speichern</Button>
                    <Button variant="primary" icon="ExternalLink" disabled={!cfg.appId || !c.secrets_set.includes('appSecret')} onClick={async () => { await saveConfig(); const r: any = await act(() => post(`/connections/${id}/oauth/start`)); if (r?.url) window.location.href = r.url; }}>
                      Mit {c.kind === 'facebook' ? 'Facebook' : 'Instagram'} verbinden
                    </Button>
                  </div>
                  {c.kind === 'facebook' && c.pages.length > 0 && (
                    <FieldWrap label="Seite" htmlFor="page">
                      <Select id="page" value={c.config.pageId ?? ''} onChange={(e) => act(() => post(`/connections/${id}/page`, { pageId: e.target.value }), 'Seite gewählt – jetzt testen')}>
                        <option value="">– Seite wählen –</option>
                        {c.pages.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </FieldWrap>
                  )}
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer text-sm">Alternativ: Token manuell hinterlegen</summary>
                    <div className="flex flex-col gap-3 mt-3">
                      {c.kind === 'facebook' && <FieldWrap label="Seiten-ID" htmlFor="pid"><Input id="pid" mono value={cfg.pageId ?? ''} onChange={(e) => setCfg({ ...cfg, pageId: e.target.value })} /></FieldWrap>}
                      <FieldWrap label={c.kind === 'facebook' ? 'Seiten-Token' : 'Instagram-Token'} htmlFor="tok"><Input id="tok" type="password" autoComplete="off" value={secret[c.kind === 'facebook' ? 'pageToken' : 'token'] ?? ''} onChange={(e) => setSecret({ ...secret, [c.kind === 'facebook' ? 'pageToken' : 'token']: e.target.value })} /></FieldWrap>
                      <div><Button onClick={async () => { await saveConfig(); await saveSecrets(); }}>Speichern</Button></div>
                    </div>
                  </details>
                  {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.join(', ')}</p>}
                </>
              )}

              {c.kind === 'warnfeed' && (
                <>
                  <FieldWrap label="Quelle" htmlFor="wf-fmt">
                    <Select id="wf-fmt" value={cfg.format} onChange={(e) => setCfg({ ...cfg, format: e.target.value })}>
                      <option value="nina">Warn-App-Schnittstelle des Bundes (Regionalschlüssel)</option>
                      <option value="cap">Eigene Adresse (CAP-XML/-JSON oder Atom mit CAP)</option>
                    </Select>
                  </FieldWrap>
                  {cfg.format === 'nina' ? (
                    <FieldWrap label="Amtlicher Regionalschlüssel (ARS) des Kreises" help="12 Stellen; ausgewertet werden die ersten 5 (Kreisebene)." htmlFor="wf-ars"><Input id="wf-ars" mono value={cfg.ars ?? ''} onChange={(e) => setCfg({ ...cfg, ars: e.target.value })} /></FieldWrap>
                  ) : (
                    <FieldWrap label="Adresse" htmlFor="wf-url"><Input id="wf-url" type="url" value={cfg.url ?? ''} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} /></FieldWrap>
                  )}
                  <div className="grid sm:grid-cols-2 gap-3">
                    <FieldWrap label="Gebietsfilter: Geocode-Präfixe (Komma)" htmlFor="wf-codes"><Input id="wf-codes" mono value={(cfg.areaFilter?.codes ?? []).join(', ')} onChange={(e) => setCfg({ ...cfg, areaFilter: { ...(cfg.areaFilter ?? {}), codes: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) } })} /></FieldWrap>
                    <FieldWrap label="Gebietsfilter: Ortsnamen (Komma)" htmlFor="wf-names"><Input id="wf-names" value={(cfg.areaFilter?.names ?? []).join(', ')} onChange={(e) => setCfg({ ...cfg, areaFilter: { ...(cfg.areaFilter ?? {}), names: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) } })} /></FieldWrap>
                  </div>
                  <FieldWrap label="Abrufintervall (Minuten)" htmlFor="wf-int"><Input id="wf-int" type="number" min={2} max={120} value={cfg.intervalMinutes ?? 5} onChange={(e) => setCfg({ ...cfg, intervalMinutes: Number(e.target.value) })} className="max-w-[120px]" /></FieldWrap>
                </>
              )}
              <div><Button variant="primary" icon="Save" disabled={busy} onClick={saveConfig}>Einstellungen speichern</Button></div>
            </div>
          </Card>
          {c.private_target && (
            <Card title="Internes Ziel">
              <div className="flex flex-col gap-2 text-sm">
                <p className="m-0">Die Adresse zeigt auf <code>{c.private_target}</code>. Interne Ziele (privates Netz) sind gesperrt, bis die Plattform-Administration sie ausdrücklich freigibt.</p>
                {c.private_approved_at ? <Badge tone="success">Freigegeben {fmtDateTime(c.private_approved_at)}</Badge> : me?.user && <div><Button size="sm" icon="ShieldCheck" onClick={() => confirm(`Internes Ziel „${c.private_target}“ wirklich freigeben?`) && act(() => post(`/connections/${id}/approve-private`, { host: c.private_target }), 'Internes Ziel freigegeben')}>Internes Ziel freigeben</Button></div>}
              </div>
            </Card>
          )}
        </div>
      )}

      {step === 'testen' && (
        <Card title="Test" subtitle="Eine erfolgreiche Anmeldung allein ist kein Veröffentlichungstest.">
          <div className="flex flex-col gap-3">
            <div><Button variant="primary" icon="Play" disabled={busy || revoked} loading={busy} onClick={() => act(() => post(`/connections/${id}/test`))}>Jetzt testen</Button></div>
            {test ? (
              <>
                <p className="m-0 text-meta text-fg-muted">Letzter Test {fmtDateTime(test.at)} – {test.ok ? 'bestanden' : 'nicht bestanden'}</p>
                <ul className="m-0 p-0 list-none flex flex-col gap-2">
                  {test.steps.map((s: any) => (
                    <li key={s.name} className="flex gap-2 items-start">
                      <Icon name={s.ok ? 'CheckCircle2' : 'XCircle'} size={16} className={s.ok ? 'text-ok mt-0.5' : 'text-err mt-0.5'} />
                      <div>
                        <div className="font-medium">{s.name} {s.kind && <span className="text-meta text-fg-muted">({STEP_KIND[s.kind]})</span>}</div>
                        <div className="text-sm">{s.message}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="m-0 text-sm text-fg-muted">Noch nicht getestet.</p>
            )}
          </div>
        </Card>
      )}

      {step === 'vorschau' && (
        <div className="flex flex-col gap-4">
          <Card title="Verfügbare Funktionen" subtitle="Wie sie der letzte Test tatsächlich vorgefunden hat.">
            {Object.keys(c.capabilities ?? {}).length ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(c.capabilities).map(([k, v]) => (
                  <Badge key={k} tone={v ? 'success' : 'neutral'}>{({ text: 'Text', photos: 'Fotos', video: 'Video', image: 'Bild', carousel: 'Karussell', reels: 'Reels', text_only: 'Nur Text', drafts: 'Entwürfe', read: 'Abruf', autoBanner: 'Automatische Banner' } as any)[k] ?? k}: {v ? 'ja' : 'nein'}</Badge>
                ))}
              </div>
            ) : (
              <p className="m-0 text-sm text-fg-muted">Nach einem Test sichtbar.</p>
            )}
            {Object.keys(c.account ?? {}).length > 0 && <KeyValue className="mt-3" items={Object.entries(c.account).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [({ id: 'ID', name: 'Name', username: 'Benutzername', type: 'Kontoart', link: 'Link' } as any)[k] ?? k, String(v)])} />}
          </Card>
          {c.kind === 'fe2' && (
            <Card title="Letzte Testmeldung" subtitle="So würde der Entwurf aussehen. Verworfene Felder werden nicht gespeichert.">
              {c.preview?.receivedAt ? (
                <div className="flex flex-col gap-2 text-sm">
                  <strong>{c.preview.title}</strong>
                  <pre className="m-0 p-2 bg-raised rounded-control whitespace-pre-wrap">{c.preview.body}</pre>
                  <p className="m-0 text-meta text-fg-muted">{Object.keys(c.preview.fields).length} Feld(er) übernommen, {c.preview.ignoredKeys} verworfen · {fmtDateTime(c.preview.receivedAt)}</p>
                </div>
              ) : (
                <p className="m-0 text-sm text-fg-muted">Noch keine Testmeldung empfangen.</p>
              )}
            </Card>
          )}
          {c.kind === 'warnfeed' && c.preview?.warnings && (
            <Card title="Meldungen im eigenen Gebiet" subtitle={`${c.preview.warnings.length} von ${c.preview.total} gelesenen`}>
              <ul className="m-0 pl-4 text-sm">{c.preview.warnings.map((w: any) => <li key={w.identifier}>{w.headline} <span className="text-fg-muted">({w.areas.join(', ')})</span></li>)}</ul>
            </Card>
          )}
          {(c.kind === 'facebook' || c.kind === 'instagram') && (
            <Notice tone="primary">Die Vorschau je Beitrag (Text und Formatprüfung je Kanal) steht im Beitrag unter „Soziale Kanäle – Status“.</Notice>
          )}
        </div>
      )}

      {step === 'aktivieren' && (
        <div className="flex flex-col gap-4">
          <Card title="Betrieb">
            <div className="flex flex-col gap-3">
              {c.status === 'active' ? <Notice tone="success">Aktiv seit {fmtDateTime(c.activated_at)}.</Notice> : !test?.ok ? <Notice tone="warning">Aktivieren ist erst nach einem bestandenen Test möglich.</Notice> : null}
              <div className="flex flex-wrap gap-2">
                {c.status !== 'active' && !revoked && <Button variant="primary" icon="Power" disabled={busy || !test?.ok} onClick={() => act(() => post(`/connections/${id}/activate`), 'Aktiviert')}>Aktivieren</Button>}
                {c.status === 'active' && <Button icon="PowerOff" onClick={() => act(() => post(`/connections/${id}/disable`), 'Angehalten')}>Anhalten</Button>}
                {c.kind === 'warnfeed' && c.status === 'active' && <Button icon="RefreshCw" onClick={() => act(() => post(`/connections/${id}/refresh`), 'Abgerufen')}>Jetzt abrufen</Button>}
                {!revoked && <Button variant="danger" icon="Trash2" onClick={() => confirm('Zugangsdaten löschen und Verbindung widerrufen?') && act(() => post(`/connections/${id}/revoke`), 'Widerrufen')}>Widerrufen</Button>}
              </div>
            </div>
          </Card>
          {c.kind === 'warnfeed' && !revoked && (
            <Card title="Automatische Banner" subtitle="Erst nach dokumentierter fachlicher Prüfung aktivierbar. Bis dahin verlinkt die Website auf die Originalquelle.">
              <div className="flex flex-col gap-3 text-sm">
                {c.config.review?.approvedAt ? (
                  <Notice tone="success" title={`Fachlich geprüft von ${c.config.review.approvedByName}`}>{fmtDateTime(c.config.review.approvedAt)} – {c.config.review.note}</Notice>
                ) : (
                  <>
                    {Object.entries(c.review_checks).map(([k, label]) => (
                      <label key={k} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={!!review.checks[k]} onChange={(e) => setReview({ ...review, checks: { ...review.checks, [k]: e.target.checked } })} /> {label as string}</label>
                    ))}
                    <FieldWrap label="Dokumentation der Prüfung" htmlFor="rv-note"><Textarea id="rv-note" rows={2} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} /></FieldWrap>
                    <div><Button disabled={review.note.trim().length < 10} onClick={() => act(() => post(`/connections/${id}/review`, review), 'Prüfung dokumentiert')}>Prüfung dokumentieren</Button></div>
                  </>
                )}
                <Switch checked={!!cfg.autoBanner} disabled={!c.config.review?.approvedAt} onChange={(v) => setCfg({ ...cfg, autoBanner: v })} label="Automatische Banner für Warnungen im eigenen Gebiet" description="Aktualisierungen ersetzen, Entwarnungen beenden das Banner; Ablauf folgt der Gültigkeit." />
                {cfg.autoBanner && (
                  <FieldWrap label="Website" htmlFor="wf-site">
                    <Select id="wf-site" value={cfg.bannerSiteId ?? ''} onChange={(e) => setCfg({ ...cfg, bannerSiteId: e.target.value || null })}>
                      <option value="">– wählen –</option>
                      {(sites.data ?? []).filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  </FieldWrap>
                )}
                <div><Button onClick={saveConfig}>Speichern</Button></div>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
