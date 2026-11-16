import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Input, KeyValue, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { CopyButton, OneTimeSecret, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { CONN_STATE } from './Connections';
import { RECEIPT_KINDS, ReceiptLog } from './ReceiptLog';
import { KeywordMeaning } from '../../components/KeywordMeaning';

const STEPS = [
  { id: 'verbinden', label: 'Verbinden' },
  { id: 'testen', label: 'Testen' },
  { id: 'vorschau', label: 'Vorschau' },
  { id: 'aktivieren', label: 'Aktivieren' },
] as const;
type Step = (typeof STEPS)[number]['id'];
const STEP_KIND: Record<string, string> = { login: 'Anmeldung', publish: 'Veröffentlichungstest', read: 'Lesen', receive: 'Empfang' };

/**
 * Wie der Server (connections/common.ts, retestRelevantConfig): Name, Abrufintervall, „Beitragsentwürfe anlegen“ und
 * die Banner-Schalter verlangen keinen neuen Test, alles andere schon.
 */
const RETEST_EXEMPT = ['name', 'intervalMinutes', 'intervalSeconds', 'createDrafts', 'autoBanner', 'bannerSiteId', 'review', 'oauthState', 'tokenExpiresAt', 'clientId', 'appInstance', 'appRedirect', 'insights'];
function relevantConfig(cfg: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(cfg ?? {}).sort()) {
    if (RETEST_EXEMPT.includes(k)) continue;
    let v = cfg[k];
    if (k === 'mapping' && v && typeof v === 'object') v = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' && x.trim() !== '').sort(([a], [b]) => a.localeCompare(b)));
    if (k === 'areaFilter' && v && typeof v === 'object') v = { codes: v.codes ?? [], names: v.names ?? [] };
    if (v === undefined || v === '' || v === null) continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}
const RETEST_TEXT = 'Die Verbindung wird dafür deaktiviert und muss neu getestet und aktiviert werden. Bis dahin werden keine Meldungen verarbeitet bzw. Beiträge veröffentlicht.';

export default function ConnectionDetail() {
  const ask = useConfirm();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['connection', id], queryFn: () => get<any>(`/connections/${id}`) });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<any[]>('/sites'), enabled: can('channel.view') });
  const c = q.data;
  // Empfangsprotokoll als eigene Ansicht neben den Schritten, direkt aufrufbar über ?ansicht=empfangsprotokoll
  const [step, setStepState] = useState<Step | 'empfang'>(() => (params.get('ansicht') === 'empfangsprotokoll' ? 'empfang' : 'verbinden'));
  const setStep = (s: Step | 'empfang') => {
    setStepState(s);
    setParams(s === 'empfang' ? { ansicht: 'empfangsprotokoll' } : {}, { replace: true });
  };
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

  if (q.error) return <ErrorBox title="Verbindung konnte nicht geladen werden">{(q.error as Error)?.message}</ErrorBox>;
  if (q.isLoading || !cfg) return <SkeletonRows rows={6} />;
  if (!c) return <ErrorBox title="Verbindung konnte nicht geladen werden">Nicht gefunden.</ErrorBox>;
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
  const retestToast = (r: any, what: string) => {
    if (!r) return;
    toast(r.retest ? { tone: r.deactivated ? 'warning' : 'success', title: `${what} – bitte erneut testen${r.deactivated || c.status !== 'draft' ? ' und aktivieren' : ''}`, text: r.deactivated ? 'Die Verbindung ist bis dahin angehalten.' : undefined } : { tone: 'success', title: what });
  };
  /** Vor Änderungen an einer aktiven Verbindung nachfragen: Sie hält an, bis neu getestet und aktiviert ist. */
  const confirmRetest = async (title: string) => c.status !== 'active' || (await ask({ title, text: RETEST_TEXT, confirmLabel: 'Speichern und deaktivieren', danger: false }));
  const saveConfig = async () => {
    const { name, ...config } = cfg;
    if (relevantConfig(cfg) !== relevantConfig(c.config) && !(await confirmRetest('Einstellungen der aktiven Verbindung ändern?'))) return null;
    const r: any = await act(() => put(`/connections/${id}`, { name, config }));
    retestToast(r, 'Gespeichert');
    return r;
  };
  const hasSecret = Object.values(secret).some((v) => typeof v === 'string' && v.trim());
  const saveSecrets = async () => {
    if (!(await confirmRetest('Zugangsdaten der aktiven Verbindung ändern?'))) return null;
    const r: any = await act(async () => {
      const res = await put(`/connections/${id}/secrets`, secret);
      setSecret({});
      return res;
    });
    retestToast(r, 'Zugangsdaten verschlüsselt gespeichert');
    return r;
  };
  const revoked = c.status === 'revoked';
  const deleted = !!c.deleted_at;
  const test = c.last_test;
  const usageText = () => {
    const u = c.usage ?? {};
    const parts = [u.publications && `${u.publications} Veröffentlichung(en) auf sozialen Kanälen`, u.targets && `${u.targets} Beitragsfassung(en) mit diesem Kanal`, u.events && `${u.events} Einsatzmeldung(en)`, u.warnings && `${u.warnings} amtliche Warnung(en)`, !u.events && u.seen && 'übernommene Einsätze'].filter(Boolean);
    return parts.join(', ');
  };
  const remove = async () => {
    const used = !!c.usage?.used;
    const ok = await ask({
      title: `Verbindung „${c.name}“ löschen?`,
      text: used ? (
        <>
          <p className="m-0">Die Verbindung wird verwendet ({usageText()}). Sie wird deshalb <strong>widerrufen</strong>, ihre Zugangsdaten werden gelöscht und sie verschwindet aus den Listen. Bezüge wie der Veröffentlichungsverlauf bleiben erhalten und zeigen „Verbindung gelöscht“.</p>
          <p className="m-0 mt-2">Das lässt sich nicht rückgängig machen.</p>
        </>
      ) : (
        <>
          <p className="m-0">Die Verbindung wurde nie verwendet und wird samt Zugangsdaten <strong>endgültig gelöscht</strong>.</p>
          <p className="m-0 mt-2">Das lässt sich nicht rückgängig machen.</p>
        </>
      ),
      confirmLabel: 'Verbindung löschen',
    });
    if (!ok) return;
    const r: any = await act(() => del(`/connections/${id}`));
    if (!r) return;
    toast({ tone: 'success', title: r.mode === 'deleted' ? 'Verbindung endgültig gelöscht' : 'Verbindung gelöscht (widerrufen und ausgeblendet)' });
    await qc.invalidateQueries({ queryKey: ['connections'] });
    nav('/verbindungen');
  };

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
                  <span className={cx('w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px]', s.id === step ? 'bg-on-primary/20' : done ? 'bg-ok-soft text-ok' : 'bg-raised')}>{done && s.id !== step ? <Icon name="Check" size={12} /> : i + 1}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
          {RECEIPT_KINDS.includes(c.kind) && can('connection.log') && (
            <li className="pl-2 ml-1 border-l border-line">
              <button type="button" onClick={() => setStep('empfang')} aria-current={step === 'empfang' ? 'page' : undefined} className={cx('flex items-center gap-2 h-9 px-3 rounded-full border text-sm font-medium', step === 'empfang' ? 'bg-primary text-on-primary border-primary' : 'bg-card border-line hover:bg-raised')}>
                <Icon name="ScrollText" size={14} />
                Empfangsprotokoll
              </button>
            </li>
          )}
        </ol>
      </nav>
      {deleted ? <Notice tone="error">Diese Verbindung wurde am {fmtDateTime(c.deleted_at)} gelöscht; ihre Zugangsdaten sind gelöscht. Sie ist nur noch zur Nachvollziehbarkeit sichtbar.</Notice> : revoked && <Notice tone="error">Diese Verbindung wurde widerrufen; ihre Zugangsdaten sind gelöscht.</Notice>}

      {step === 'verbinden' && !revoked && (
        <div className="flex flex-col gap-4">
          <Card title="Einstellungen">
            <div className="flex flex-col gap-4">
              <FieldWrap label="Name" htmlFor="cn"><Input id="cn" value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} /></FieldWrap>

              {c.kind === 'fe2' && (
                <>
                  <FieldWrap label="Eingangsadresse (in FE2 als HTTP-Ausgang, Methode POST, JSON)" labelAction={
                    <HelpTip title="Eingangsadresse und Zugangsschlüssel" more="/hilfe/verbindungen#eingangsadresse-und-zugangsschluessel">
                      <p className="m-0">Beide Werte erzeugt BlaulichtCMS – sie stehen nicht in FE2. Die Adresse hier kopieren, den Schlüssel gab es beim Anlegen der Verbindung (nur einmal sichtbar).</p>
                      <p className="m-0">FE2 muss einen <strong>POST mit JSON</strong> und der Kopfzeile <code className="font-mono">Authorization: Bearer &lt;Schlüssel&gt;</code> senden. Welcher Ausgang das in der eigenen FE2-Version kann, mit dem FE2-Betreuer bzw. dem <HelpLink href="https://alamos-support.atlassian.net/wiki/spaces/documentation/overview">Alamos-Handbuch</HelpLink> klären.</p>
                      <p className="m-0">Kann der Ausgang keine Kopfzeile setzen: unten „Schlüssel in der Adresse“ einschalten.</p>
                    </HelpTip>
                  }>
                    <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.inbound_url}</code><CopyButton value={c.inbound_url} size="sm" /></div>
                  </FieldWrap>
                  <p className="m-0 text-meta text-fg-muted">Authentisierung per Header <code>Authorization: Bearer &lt;Schlüssel&gt;</code>. Vor der Aktivierung legt BlaulichtCMS nichts an, sondern zeigt nur eine Vorschau. Mit Header <code>X-BlaulichtCMS-Test: 1</code> bleibt auch später jede Meldung eine reine Testmeldung.</p>
                  <div className="flex items-start gap-1">
                    <Switch checked={!!cfg.keyInPath} onChange={(v) => setCfg({ ...cfg, keyInPath: v })} label="Schlüssel in der Adresse" description="Für FE2-Ausgänge ohne eigene Kopfzeile: eine zweite Eingangsadresse, die einen eigenen Schlüssel enthält. Standard aus." />
                    <HelpTip title="Schlüssel in der Adresse" more="/hilfe/verbindungen#schluessel-in-der-adresse">
                      <p className="m-0">Manche FE2-Ausgänge rufen nur eine Adresse auf und können keine Kopfzeile <code className="font-mono">Authorization</code> setzen. Dann steckt der Schlüssel in der Adresse selbst.</p>
                      <p className="m-0"><strong>Abwägung:</strong> Die Adresse samt Schlüssel steht dann in der FE2-Konfiguration und kann in Protokollen von Proxys auftauchen. Zugriffsprotokolle des Proxys abschalten oder maskieren; ist die Adresse abgeflossen, einen neuen Zugangsschlüssel erzeugen – die Adresse ändert sich dabei mit.</p>
                    </HelpTip>
                  </div>
                  {c.config.keyInPath && c.inbound_url_with_key && (
                    <FieldWrap label="Eingangsadresse mit Schlüssel (ohne Kopfzeile)" help="Wie ein Passwort behandeln. Gilt nur, solange „Schlüssel in der Adresse“ eingeschaltet ist.">
                      <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.inbound_url_with_key.replace(/\/[^/]+$/, '/bcfe2p_••••••••')}</code><CopyButton value={c.inbound_url_with_key} size="sm" /></div>
                    </FieldWrap>
                  )}
                  {!!cfg.keyInPath !== !!c.config.keyInPath && <p className="m-0 text-meta text-fg-muted">Nach dem Speichern {cfg.keyInPath ? 'erscheint die Adresse mit Schlüssel hier' : 'gilt die Adresse mit Schlüssel nicht mehr'}; danach eine Testmeldung senden und neu testen.</p>}
                  <div>
                    <Button size="sm" icon="KeyRound" onClick={async () => { if (!(await confirmRetest('Neuen Zugangsschlüssel erzeugen?'))) return; const r: any = await act(() => post(`/connections/${id}/rotate-token`), 'Neuer Schlüssel erzeugt – der alte gilt nicht mehr. In FE2 eintragen, Testmeldung senden, testen und aktivieren.'); if (r) setNewToken(r.token); }}>Neuen Zugangsschlüssel erzeugen</Button>
                  </div>
                  {newToken && <OneTimeSecret value={newToken} label="Neuer Zugangsschlüssel (nur jetzt sichtbar)" />}
                  <Switch checked={cfg.createDrafts !== false} onChange={(v) => setCfg({ ...cfg, createDrafts: v })} label="Beitragsentwürfe anlegen" description="Je Einsatz genau ein interner Entwurf. Wiederholungen werden erkannt." />
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer font-medium text-sm">Feldzuordnung (Allowlist)</summary>
                    <div className="flex items-center gap-1 mt-2 text-sm font-medium">Pfade der FE2-Meldung
                      <HelpTip title="Feldzuordnung" more="/hilfe/verbindungen#feldzuordnung">
                        <p className="m-0">Je Feld der Pfad in der JSON-Meldung von FE2, mit Punkten für verschachtelte Felder – z. B. <code className="font-mono">einsatz.stichwort</code>. Welche Felder die eigene FE2-Instanz sendet, zeigt eine Testmeldung (Vorschau).</p>
                        <p className="m-0">Die <strong>Einsatz-ID</strong> ist Pflicht und muss je Einsatz gleich bleiben. Eine geänderte Zuordnung verlangt einen neuen Test.</p>
                      </HelpTip>
                    </div>
                    <p className="text-meta text-fg-muted">Nur diese Felder gelangen in den Entwurf. Pfad im JSON mit Punkten, z. B. <code>einsatz.stichwort</code>. Leere Felder: BlaulichtCMS sucht gängige Feldnamen (z. B. <code>einsatznummer</code>, <code>stichwort</code>, <code>alarmzeit</code>) selbst. Alles andere – etwa Alarmtext oder Personendaten – wird verworfen. Standard ist eine Annahme und muss mit einer anonymisierten Testmeldung der eigenen FE2-Instanz geprüft werden.</p>
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
                  <Notice>
                    Benötigt eine eigene Meta-App mit {c.kind === 'facebook' ? 'Facebook Login und den Rechten pages_show_list, pages_manage_posts, pages_read_engagement' : 'Instagram Login und den Rechten instagram_business_basic, instagram_business_content_publish'}. Schritt für Schritt: <Link to="/hilfe/verbindungen#meta-app-anlegen">Meta-App anlegen</Link>.
                  </Notice>
                  <FieldWrap label="Weiterleitungsadresse (in der Meta-App eintragen)" labelAction={
                    <HelpTip title="Weiterleitungsadresse" more="/hilfe/verbindungen#weiterleitungsadresse-eintragen">
                      <p className="m-0">Diese Adresse zeigt BlaulichtCMS; sie muss in der Meta-App <strong>exakt</strong> so eingetragen sein:</p>
                      {c.kind === 'facebook' ? (
                        <p className="m-0">Facebook Login for Business → Einstellungen → Client-OAuth-Einstellungen → <strong>Gültige OAuth-Weiterleitungs-URIs</strong> (<HelpLink href="https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/">Meta-Doku</HelpLink>).</p>
                      ) : (
                        <p className="m-0">Instagram → API setup with Instagram login → Business login settings → <strong>OAuth redirect URIs</strong> (<HelpLink href="https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login">Meta-Doku</HelpLink>).</p>
                      )}
                      <p className="m-0 text-fg-muted">Voraussetzung: BlaulichtCMS ist unter seiner öffentlichen HTTPS-Adresse erreichbar.</p>
                    </HelpTip>
                  }>
                    <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.oauth_redirect}</code><CopyButton value={c.oauth_redirect} size="sm" /></div>
                  </FieldWrap>
                  <FieldWrap label={c.kind === 'facebook' ? 'App-ID' : 'Instagram-App-ID'} htmlFor="appid" labelAction={
                    <HelpTip title={c.kind === 'facebook' ? 'App-ID finden' : 'Instagram-App-ID finden'} more="/hilfe/verbindungen#app-id-und-app-geheimnis">
                      {c.kind === 'facebook' ? (
                        <p className="m-0">Im App-Dashboard auf developers.facebook.com die App öffnen: <strong>App-Einstellungen → Allgemein</strong> zeigt App-ID und App-Geheimnis (<HelpLink href="https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/">Meta-Doku</HelpLink>).</p>
                      ) : (
                        <p className="m-0">Im App-Dashboard unter <strong>Instagram → API setup with Instagram login → Business login settings</strong> stehen Instagram-App-ID und Instagram-App-Geheimnis – nicht die Facebook-App-ID verwenden (<HelpLink href="https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login">Meta-Doku</HelpLink>).</p>
                      )}
                      <p className="m-0 text-fg-muted">Noch keine App? Anlegen unter developers.facebook.com – Anleitung in der Hilfe.</p>
                    </HelpTip>
                  }><Input id="appid" mono value={cfg.appId ?? ''} onChange={(e) => setCfg({ ...cfg, appId: e.target.value })} /></FieldWrap>
                  <FieldWrap label={c.secrets_set.includes('appSecret') ? 'App-Geheimnis (gespeichert – nur zum Ersetzen)' : 'App-Geheimnis'} htmlFor="appsec" labelAction={
                    <HelpTip title="App-Geheimnis" more="/hilfe/verbindungen#app-id-und-app-geheimnis">
                      <p className="m-0">Steht neben der App-ID ({c.kind === 'facebook' ? 'App-Einstellungen → Allgemein, „Anzeigen“' : 'Business login settings → Instagram app secret'}). BlaulichtCMS speichert es verschlüsselt und zeigt es nie wieder an.</p>
                      <p className="m-0 text-fg-muted">Ein neues Geheimnis verlangt einen neuen Test; eine aktive Verbindung hält bis dahin an.</p>
                    </HelpTip>
                  }>
                    <Input id="appsec" type="password" autoComplete="off" value={secret.appSecret ?? ''} onChange={(e) => setSecret({ ...secret, appSecret: e.target.value })} />
                  </FieldWrap>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={!secret.appSecret} onClick={saveSecrets}>Geheimnis speichern</Button>
                    <Button variant="primary" icon="ExternalLink" disabled={!cfg.appId || !c.secrets_set.includes('appSecret')} onClick={async () => { if (!(await confirmRetest(`Erneut mit ${c.kind === 'facebook' ? 'Facebook' : 'Instagram'} verbinden?`))) return; if ((await saveConfig()) === null) return; const r: any = await act(() => post(`/connections/${id}/oauth/start`)); if (r?.url) window.location.href = r.url; }}>
                      Mit {c.kind === 'facebook' ? 'Facebook' : 'Instagram'} verbinden
                    </Button>
                  </div>
                  {c.kind === 'facebook' && c.pages.length > 0 && (
                    <FieldWrap label="Seite" htmlFor="page" labelAction={
                      <HelpTip title="Seite wählen" more="/hilfe/verbindungen#facebook-seite-verbinden">
                        <p className="m-0">Die Liste zeigt die Seiten, die bei der Anmeldung freigegeben wurden. Fehlt eine Seite, erneut verbinden und sie im Meta-Dialog auswählen – das Konto muss die Seite verwalten dürfen.</p>
                      </HelpTip>
                    }>
                      <Select id="page" value={c.config.pageId ?? ''} onChange={async (e) => { const pageId = e.target.value; if (!(await confirmRetest('Andere Seite wählen?'))) return; retestToast(await act(() => post(`/connections/${id}/page`, { pageId })), 'Seite gewählt'); }}>
                        <option value="">– Seite wählen –</option>
                        {c.pages.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </FieldWrap>
                  )}
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer text-sm">Alternativ: Token manuell hinterlegen</summary>
                    <div className="flex flex-col gap-3 mt-3">
                      {c.kind === 'facebook' && <FieldWrap label="Seiten-ID" htmlFor="pid" labelAction={
                        <HelpTip title="Seiten-ID" more="/hilfe/verbindungen#token-manuell-hinterlegen">
                          <p className="m-0">Die numerische ID der Facebook-Seite, z. B. aus dem Graph-API-Explorer (<code className="font-mono">me/accounts</code>) oder in der Seite unter „Info“ bzw. „Seitentransparenz“.</p>
                        </HelpTip>
                      }><Input id="pid" mono value={cfg.pageId ?? ''} onChange={(e) => setCfg({ ...cfg, pageId: e.target.value })} /></FieldWrap>}
                      <FieldWrap label={c.kind === 'facebook' ? 'Seiten-Token' : 'Instagram-Token'} htmlFor="tok" labelAction={
                        <HelpTip title="Token manuell hinterlegen" more="/hilfe/verbindungen#token-manuell-hinterlegen">
                          <p className="m-0">Nur nötig, wenn die Anmeldung über „Verbinden“ nicht möglich ist. Der Token braucht dieselben Berechtigungen; kurzlebige Token laufen nach Stunden ab. Erzeugen lässt er sich z. B. mit dem <HelpLink href="https://developers.facebook.com/docs/graph-api/guides/explorer/">Graph-API-Explorer</HelpLink>.</p>
                        </HelpTip>
                      }><Input id="tok" type="password" autoComplete="off" value={secret[c.kind === 'facebook' ? 'pageToken' : 'token'] ?? ''} onChange={(e) => setSecret({ ...secret, [c.kind === 'facebook' ? 'pageToken' : 'token']: e.target.value })} /></FieldWrap>
                      <div><Button onClick={async () => { if ((await saveConfig()) === null) return; if (hasSecret) await saveSecrets(); }}>Speichern</Button></div>
                    </div>
                  </details>
                  {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.join(', ')}</p>}
                </>
              )}

              {c.kind === 'threads' && (
                <>
                  <Notice>
                    Benötigt eine Meta-App mit dem Anwendungsfall <strong>Access the Threads API</strong> und den Rechten threads_basic und threads_content_publish. Schritt für Schritt: <Link to="/hilfe/verbindungen#threads">Threads verbinden</Link>.
                  </Notice>
                  <FieldWrap label="Weiterleitungsadresse (in der Meta-App eintragen)" labelAction={
                    <HelpTip title="Weiterleitungsadresse für Threads" more="/hilfe/verbindungen#threads">
                      <p className="m-0">Diese Adresse muss in der Meta-App <strong>exakt</strong> so eingetragen sein: App-Dashboard → <strong>Anwendungsfälle</strong> → „Access the Threads API“ → <strong>Anpassen</strong> → <strong>Einstellungen</strong> → Weiterleitungs-URIs (Redirect Callback URLs) (<HelpLink href="https://developers.facebook.com/docs/development/create-an-app/threads-use-case">Meta-Doku</HelpLink>).</p>
                      <p className="m-0 text-fg-muted">Voraussetzung: BlaulichtCMS ist unter seiner öffentlichen HTTPS-Adresse erreichbar.</p>
                    </HelpTip>
                  }>
                    <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.oauth_redirect}</code><CopyButton value={c.oauth_redirect} size="sm" /></div>
                  </FieldWrap>
                  <FieldWrap label="Threads-App-ID" htmlFor="th-appid" labelAction={
                    <HelpTip title="Threads-App-ID finden" more="/hilfe/verbindungen#threads">
                      <p className="m-0">Eine Meta-App mit Threads-Anwendungsfall hat eine <strong>eigene Threads-App-ID</strong> und ein eigenes Threads-App-Geheimnis. Beide stehen im Anwendungsfall „Access the Threads API“ unter <strong>Einstellungen</strong> – nicht die App-ID oben im Dashboard verwenden (<HelpLink href="https://developers.facebook.com/docs/development/create-an-app/threads-use-case">Meta-Doku</HelpLink>).</p>
                    </HelpTip>
                  }><Input id="th-appid" mono value={cfg.appId ?? ''} onChange={(e) => setCfg({ ...cfg, appId: e.target.value })} /></FieldWrap>
                  <FieldWrap label={c.secrets_set.includes('appSecret') ? 'Threads-App-Geheimnis (gespeichert – nur zum Ersetzen)' : 'Threads-App-Geheimnis'} htmlFor="th-sec" labelAction={
                    <HelpTip title="Threads-App-Geheimnis" more="/hilfe/verbindungen#threads">
                      <p className="m-0">Steht neben der Threads-App-ID. BlaulichtCMS speichert es verschlüsselt und zeigt es nie wieder an. Ein neues Geheimnis verlangt einen neuen Test.</p>
                    </HelpTip>
                  }>
                    <Input id="th-sec" type="password" autoComplete="off" value={secret.appSecret ?? ''} onChange={(e) => setSecret({ ...secret, appSecret: e.target.value })} />
                  </FieldWrap>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={!secret.appSecret} onClick={saveSecrets}>Geheimnis speichern</Button>
                    <Button variant="primary" icon="ExternalLink" disabled={!cfg.appId || !c.secrets_set.includes('appSecret')} onClick={async () => { if (!(await confirmRetest('Erneut mit Threads verbinden?'))) return; if ((await saveConfig()) === null) return; const r: any = await act(() => post(`/connections/${id}/oauth/start`)); if (r?.url) window.location.href = r.url; }}>
                      Mit Threads verbinden
                    </Button>
                  </div>
                  {c.config.tokenExpiresAt && <p className="m-0 text-meta text-fg-muted">Anmeldung gültig bis {fmtDateTime(c.config.tokenExpiresAt)} – BlaulichtCMS verlängert sie rechtzeitig selbst.</p>}
                  {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.join(', ')}</p>}
                </>
              )}

              {c.kind === 'x' && (
                <>
                  <div className="flex items-start gap-1">
                    <Switch checked={cfg.mode === 'api'} onChange={(v) => setCfg({ ...cfg, mode: v ? 'api' : 'manual' })} label="Über die X-API posten" description="Aus: Teilen von Hand – BlaulichtCMS bereitet Text und Link vor, gepostet wird auf x.com. An: BlaulichtCMS postet selbst mit eigenen Zugangsdaten." />
                    <HelpTip title="Zwei Wege zu X" more="/hilfe/verbindungen#x">
                      <p className="m-0"><strong>Teilen von Hand</strong> braucht keine Zugangsdaten und kostet nichts: BlaulichtCMS kürzt den Text auf 280 Zeichen (nach den Zählregeln von X), hängt den Link an und öffnet das Beitragsfenster von x.com mit eingetragenem Text. Danach den Beitrag in BlaulichtCMS als geteilt markieren.</p>
                      <p className="m-0"><strong>Über die X-API</strong> postet BlaulichtCMS selbst. Dafür ist eine eigene App in der Developer Console von X nötig; das Posten über die X-API ist <strong>kostenpflichtig</strong> (<HelpLink href="https://docs.x.com/x-api/getting-started/pricing">Preise bei X</HelpLink>).</p>
                    </HelpTip>
                  </div>
                  {cfg.mode === 'api' ? (
                    <>
                      <Notice tone="warning" title="Kostenpflichtig">
                        Posten über die X-API kostet Geld: X rechnet nutzungsabhängig über Guthaben in der Developer Console ab; ohne Guthaben lehnt X jeden Beitrag ab. Aktuelle Bedingungen nennt X auf der <a href="https://docs.x.com/x-api/getting-started/pricing" target="_blank" rel="noopener noreferrer">Preisseite der X-API</a>.
                      </Notice>
                      <div className="grid sm:grid-cols-2 gap-3">
                        {([
                          ['apiKey', 'API Key (Consumer Key)'],
                          ['apiSecret', 'API Key Secret (Consumer Secret)'],
                          ['accessToken', 'Access Token'],
                          ['accessTokenSecret', 'Access Token Secret'],
                        ] as const).map(([k, label]) => (
                          <FieldWrap key={k} label={c.secrets_set.includes(k) ? `${label} (gespeichert)` : label} htmlFor={`x-${k}`} labelAction={
                            <HelpTip title={label} more="/hilfe/verbindungen#x">
                              <p className="m-0">In der Developer Console von X die eigene App öffnen → <strong>Keys and tokens</strong>. Dort stehen API Key und API Key Secret; Access Token und Access Token Secret für das <strong>eigene Konto</strong> lassen sich dort erzeugen (<HelpLink href="https://docs.x.com/fundamentals/developer-apps">X-Doku</HelpLink>).</p>
                              <p className="m-0">Vorher unter <strong>User authentication settings</strong> die Berechtigung <strong>Read and write</strong> setzen – nach einer Änderung Access Token und Secret neu erzeugen.</p>
                            </HelpTip>
                          }>
                            <Input id={`x-${k}`} type="password" autoComplete="off" value={secret[k] ?? ''} onChange={(e) => setSecret({ ...secret, [k]: e.target.value })} />
                          </FieldWrap>
                        ))}
                      </div>
                      <div><Button disabled={!hasSecret} onClick={async () => { if ((await saveConfig()) === null) return; await saveSecrets(); }}>Zugangsdaten speichern</Button></div>
                      {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.join(', ')}</p>}
                    </>
                  ) : (
                    <Notice>Teilen von Hand: Nach der Freigabe erscheint X im Beitrag als „Zum Teilen bereit“ – mit vorbereitetem Text, Kopierknopf und einem Knopf, der das Beitragsfenster von x.com mit eingetragenem Text öffnet. Danach den Beitrag als geteilt markieren.</Notice>
                  )}
                </>
              )}

              {c.kind === 'whatsapp' && (
                <>
                  <Notice title="Warum nur von Hand?">
                    WhatsApp bietet keine Schnittstelle, um in einen WhatsApp-Kanal zu posten – die WhatsApp Business Platform ist für Nachrichten an einzelne Personen gedacht, nicht für Kanäle. BlaulichtCMS bereitet deshalb Text (mit WhatsApp-Formatierung), Link und Bilder vor; gepostet wird in der WhatsApp-App oder in WhatsApp Web. Mehr: <Link to="/hilfe/verbindungen#whatsapp-kanal">WhatsApp-Kanal</Link>.
                  </Notice>
                  <FieldWrap label="Adresse des eigenen Kanals (optional)" htmlFor="wa-url" help="Zum schnellen Öffnen beim Teilen, z. B. https://whatsapp.com/channel/…" labelAction={
                    <HelpTip title="Kanaladresse finden" more="/hilfe/verbindungen#whatsapp-kanal">
                      <p className="m-0">In WhatsApp unter <strong>Aktuelles</strong> den eigenen Kanal öffnen → Kanalname antippen → <strong>Link kopieren</strong> (je nach App-Version „Kanal-Link“). Ohne Adresse öffnet BlaulichtCMS WhatsApp Web.</p>
                    </HelpTip>
                  }>
                    <Input id="wa-url" type="url" value={cfg.channelUrl ?? ''} onChange={(e) => setCfg({ ...cfg, channelUrl: e.target.value })} />
                  </FieldWrap>
                </>
              )}

              {c.kind === 'mastodon' && (
                <>
                  <Notice>
                    Mastodon ist kostenlos und dezentral: Jede Instanz (z. B. social.bund.de für Behörden) hat ihre eigene Adresse und eigene Regeln. BlaulichtCMS registriert sich beim Verbinden selbst als App auf der Instanz. Schritt für Schritt: <Link to="/hilfe/verbindungen#mastodon">Mastodon verbinden</Link>.
                  </Notice>
                  <FieldWrap label="Adresse der Instanz" htmlFor="md-inst" help="Nur die Adresse ohne Pfad, z. B. https://social.bund.de." labelAction={
                    <HelpTip title="Instanz-Adresse" more="/hilfe/verbindungen#mastodon">
                      <p className="m-0">Die Adresse des Servers, auf dem das Konto liegt – sie steht im Profil hinter dem Benutzernamen: <code className="font-mono">@feuerwehr@social.example</code> → <code className="font-mono">https://social.example</code>.</p>
                      <p className="m-0">Ändert sich die Instanz, ist eine neue Anmeldung und ein neuer Test nötig.</p>
                    </HelpTip>
                  }>
                    <Input id="md-inst" type="url" value={cfg.instance ?? ''} onChange={(e) => setCfg({ ...cfg, instance: e.target.value })} placeholder="https://social.bund.de" />
                  </FieldWrap>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <FieldWrap label="Sichtbarkeit der Beiträge" htmlFor="md-vis" labelAction={
                      <HelpTip title="Sichtbarkeit" more="/hilfe/verbindungen#mastodon">
                        <p className="m-0"><strong>Öffentlich</strong>: in Zeitleisten und Suche. <strong>Nicht gelistet</strong>: öffentlich lesbar, aber nicht in den öffentlichen Zeitleisten. <strong>Nur Folgende</strong>: nur für Personen, die dem Konto folgen.</p>
                      </HelpTip>
                    }>
                      <Select id="md-vis" value={cfg.visibility ?? 'public'} onChange={(e) => setCfg({ ...cfg, visibility: e.target.value })}>
                        <option value="public">Öffentlich</option>
                        <option value="unlisted">Nicht gelistet</option>
                        <option value="private">Nur Folgende</option>
                      </Select>
                    </FieldWrap>
                    <FieldWrap label="Sprache der Beiträge" htmlFor="md-lang" help="Zweistelliger Sprachcode, Standard de.">
                      <Input id="md-lang" mono maxLength={2} value={cfg.language ?? 'de'} onChange={(e) => setCfg({ ...cfg, language: e.target.value.toLowerCase() })} className="max-w-[100px]" />
                    </FieldWrap>
                  </div>
                  <FieldWrap label="Weiterleitungsadresse (trägt BlaulichtCMS selbst ein)">
                    <div className="flex gap-2 items-center"><code className="break-all text-meta">{c.oauth_redirect}</code><CopyButton value={c.oauth_redirect} size="sm" /></div>
                  </FieldWrap>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" icon="ExternalLink" disabled={!cfg.instance} onClick={async () => { if (!(await confirmRetest('Erneut mit Mastodon verbinden?'))) return; if ((await saveConfig()) === null) return; const r: any = await act(() => post(`/connections/${id}/oauth/start`)); if (r?.url) window.location.href = r.url; }}>
                      Mit Mastodon verbinden
                    </Button>
                  </div>
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer text-sm">Alternativ: Zugangstoken hinterlegen</summary>
                    <div className="flex flex-col gap-3 mt-3">
                      <FieldWrap label={c.secrets_set.includes('token') ? 'Zugangstoken (gespeichert – nur zum Ersetzen)' : 'Zugangstoken'} htmlFor="md-tok" labelAction={
                        <HelpTip title="Zugangstoken erzeugen" more="/hilfe/verbindungen#mastodon">
                          <p className="m-0">In Mastodon unter <strong>Einstellungen → Entwicklung → Neue Anwendung</strong> eine Anwendung anlegen, die Rechte <code className="font-mono">read:accounts read:statuses write:statuses write:media</code> wählen und den <strong>Zugangstoken</strong> kopieren (<HelpLink href="https://docs.joinmastodon.org/client/token/">Mastodon-Doku</HelpLink>).</p>
                          <p className="m-0">BlaulichtCMS speichert ihn verschlüsselt und zeigt ihn nie wieder an.</p>
                        </HelpTip>
                      }>
                        <Input id="md-tok" type="password" autoComplete="off" value={secret.token ?? ''} onChange={(e) => setSecret({ ...secret, token: e.target.value })} />
                      </FieldWrap>
                      <div><Button disabled={!secret.token?.trim()} onClick={async () => { if ((await saveConfig()) === null) return; await saveSecrets(); }}>Zugangstoken speichern</Button></div>
                    </div>
                  </details>
                  {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.join(', ')}</p>}
                </>
              )}

              {c.kind === 'bluesky' && (
                <>
                  <Notice>
                    Bluesky ist kostenlos. BlaulichtCMS meldet sich mit einem <strong>App-Passwort</strong> an – nie mit dem Kontopasswort. Schritt für Schritt: <Link to="/hilfe/verbindungen#bluesky">Bluesky verbinden</Link>.
                  </Notice>
                  <FieldWrap label="Handle" htmlFor="bs-id" help="z. B. feuerwehr-musterstadt.bsky.social oder die eigene Domain." labelAction={
                    <HelpTip title="Handle" more="/hilfe/verbindungen#bluesky">
                      <p className="m-0">Der Benutzername des Kontos ohne @, wie er im Profil steht – z. B. <code className="font-mono">feuerwehr-musterstadt.bsky.social</code>.</p>
                    </HelpTip>
                  }>
                    <Input id="bs-id" mono value={cfg.identifier ?? ''} onChange={(e) => setCfg({ ...cfg, identifier: e.target.value })} />
                  </FieldWrap>
                  <FieldWrap label={c.secrets_set.includes('appPassword') ? 'App-Passwort (gespeichert – nur zum Ersetzen)' : 'App-Passwort'} htmlFor="bs-pw" labelAction={
                    <HelpTip title="App-Passwort anlegen" more="/hilfe/verbindungen#bluesky">
                      <p className="m-0">In Bluesky unter <strong>Einstellungen → Datenschutz und Sicherheit → App-Passwörter</strong> ein neues App-Passwort anlegen (Name z. B. „BlaulichtCMS“, ohne Zugriff auf Direktnachrichten) und hier eintragen.</p>
                      <p className="m-0">Ein App-Passwort lässt sich jederzeit einzeln widerrufen. BlaulichtCMS speichert es verschlüsselt und zeigt es nie wieder an.</p>
                    </HelpTip>
                  }>
                    <Input id="bs-pw" type="password" autoComplete="off" value={secret.appPassword ?? ''} onChange={(e) => setSecret({ ...secret, appPassword: e.target.value })} />
                  </FieldWrap>
                  <details className="border border-line rounded-card p-3">
                    <summary className="cursor-pointer text-sm">Eigener Server (nur bei selbst betriebenem PDS)</summary>
                    <div className="flex flex-col gap-3 mt-3">
                      <FieldWrap label="Server-Adresse (PDS)" htmlFor="bs-svc" help="Leer = bsky.social. Nur ändern, wenn das Konto auf einem eigenen Server liegt.">
                        <Input id="bs-svc" type="url" value={cfg.service ?? ''} placeholder="https://bsky.social" onChange={(e) => setCfg({ ...cfg, service: e.target.value })} />
                      </FieldWrap>
                      <FieldWrap label="Sprache der Beiträge" htmlFor="bs-lang" help="Zweistelliger Sprachcode, Standard de.">
                        <Input id="bs-lang" mono maxLength={2} value={cfg.language ?? 'de'} onChange={(e) => setCfg({ ...cfg, language: e.target.value.toLowerCase() })} className="max-w-[100px]" />
                      </FieldWrap>
                    </div>
                  </details>
                  <div><Button disabled={!cfg.identifier?.trim()} onClick={async () => { if ((await saveConfig()) === null) return; if (hasSecret) await saveSecrets(); }}>Zugangsdaten speichern</Button></div>
                  {c.secrets_set.length > 0 && <p className="m-0 text-meta text-fg-muted">Gespeichert (verschlüsselt): {c.secrets_set.filter((k: string) => k === 'appPassword').map(() => 'App-Passwort').join(', ')}</p>}
                </>
              )}

              {c.kind === 'feuersoftware' && (
                <>
                  <FieldWrap label={c.secrets_set.includes('apiKey') ? 'API-Key (gespeichert – nur zum Ersetzen)' : 'API-Key'} htmlFor="fs-key" labelAction={
                    <HelpTip title="API-Key der Öffentlichen Connect Schnittstelle" more="/hilfe/verbindungen#feuersoftware-api-key">
                      <p className="m-0">Im Connect Portal den Standort wählen → <strong>Schnittstellen</strong> → <strong>„Öffentliche Connect Schnittstelle“</strong> erzeugen bzw. aktivieren und den angezeigten Schlüssel hier eintragen.</p>
                      <p className="m-0">Ein Standort-Key liefert nur die Einsätze dieses Standorts. BlaulichtCMS speichert ihn verschlüsselt, zeigt ihn nie wieder an und fragt damit nur ab – den Schlüssel trotzdem vertraulich behandeln.</p>
                    </HelpTip>
                  }>
                    <Input id="fs-key" type="password" autoComplete="off" value={secret.apiKey ?? ''} onChange={(e) => setSecret({ ...secret, apiKey: e.target.value })} />
                  </FieldWrap>
                  <div><Button disabled={!secret.apiKey?.trim()} onClick={saveSecrets}>API-Key speichern</Button></div>
                  <FieldWrap label="Abrufabstand" htmlFor="fs-int" labelAction={
                    <HelpTip title="Abrufabstand" more="/hilfe/verbindungen#feuersoftware-connect">
                      <p className="m-0">Connect meldet Einsätze nicht von sich aus – BlaulichtCMS fragt im eingestellten Abstand nach. Feuersoftware begrenzt die Zahl der Abfragen, daher mindestens 1 Minute. Übernommen werden nur Einsätze der letzten 24 Stunden.</p>
                      <p className="m-0 text-fg-muted">Bittet Feuersoftware um eine Pause (429), wartet BlaulichtCMS selbst ab. Der Abstand lässt sich ohne neuen Test ändern.</p>
                    </HelpTip>
                  }>
                    <div className="max-w-[220px]">
                      <Select id="fs-int" value={String(cfg.intervalSeconds ?? 120)} onChange={(e) => setCfg({ ...cfg, intervalSeconds: Number(e.target.value) })}>
                        {(c.intervals ?? [60, 120, 180, 300]).map((n: number) => <option key={n} value={n}>{n === 60 ? '1 Minute' : `${n / 60} Minuten`}{n === 120 ? ' (Standard)' : ''}</option>)}
                      </Select>
                    </div>
                  </FieldWrap>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <FieldWrap label="RICs (Komma)" htmlFor="fs-rics" labelAction={
                      <HelpTip title="RICs" more="/hilfe/verbindungen#feuersoftware-filter">
                        <p className="m-0">Alarmierungsadresse bzw. Name der Alarmgruppe, wie er in Connect bei der Alarmierung steht, z. B. <code className="font-mono">Musterwehr Vollalarm</code>. Mehrere durch Komma trennen.</p>
                        <p className="m-0">Nach einem Test zeigt BlaulichtCMS die RICs der aktuellen Einsätze an, wenn nicht alle passen.</p>
                      </HelpTip>
                    } help="Optional. Nur Einsätze mit passender RIC oder passendem Stichwort werden übernommen."><ListInput id="fs-rics" value={cfg.rics ?? []} onChange={(rics) => setCfg({ ...cfg, rics })} /></FieldWrap>
                    <FieldWrap label="Stichwörter (Komma)" htmlFor="fs-kw" labelAction={
                      <HelpTip title="Stichwörter" more="/hilfe/verbindungen#feuersoftware-filter">
                        <p className="m-0">Teile des Einsatzstichworts, z. B. <code className="font-mono">B3, TH</code>. Ein Einsatz passt, wenn sein Stichwort einen der Begriffe enthält.</p>
                        <p className="m-0 text-fg-muted">Ohne RICs und Stichwörter wird jeder Einsatz des Standorts übernommen.</p>
                      </HelpTip>
                    } help="Optional. Ohne Filter gilt jeder Einsatz des Standorts."><ListInput id="fs-kw" value={cfg.keywords ?? []} onChange={(keywords) => setCfg({ ...cfg, keywords })} />
                      {(cfg.keywords ?? []).length > 0 && (
                        <span className="flex flex-wrap gap-x-3 mt-1">{(cfg.keywords as string[]).map((k) => <KeywordMeaning key={k} code={k} />)}</span>
                      )}
                    </FieldWrap>
                  </div>
                  <Switch checked={cfg.createDrafts !== false} onChange={(v) => setCfg({ ...cfg, createDrafts: v })} label="Beitragsentwürfe anlegen" description="Je Einsatz genau ein interner Entwurf mit Stichwort, Einsatzart, Ort (ohne Straße und Hausnummer) und Alarmzeit." />
                  <p className="m-0 text-meta text-fg-muted">Lagemeldungen, Sachverhalt, Adresse und Angaben zur meldenden Person übernimmt BlaulichtCMS nicht.</p>
                  {(c.last_error || (c.retry_after_until && new Date(c.retry_after_until) > new Date())) && (
                    <Notice tone="warning" title={c.consecutive_failures ? `Letzter Abruf fehlgeschlagen (${c.consecutive_failures}× in Folge)` : 'Hinweis von Feuersoftware'}>
                      {c.last_error}
                      {c.retry_after_until && new Date(c.retry_after_until) > new Date() ? ` Nächster Versuch nicht vor ${fmtDateTime(c.retry_after_until)}.` : ''}
                    </Notice>
                  )}
                  {c.last_poll_at && <p className="m-0 text-meta text-fg-muted">Zuletzt abgefragt {fmtDateTime(c.last_poll_at)}.</p>}
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
                    <FieldWrap label="Amtlicher Regionalschlüssel (ARS) des Kreises" labelAction={
                      <HelpTip title="Regionalschlüssel des Kreises finden" more="/hilfe/verbindungen#regionalschluessel-und-gebietsfilter">
                        <p className="m-0">Der ARS hat 12 Stellen. Für den Kreis zählen nur die ersten 5, der Rest sind Nullen.</p>
                        <ol className="m-0 pl-4 flex flex-col gap-1">
                          <li>Eigene Gemeinde im <HelpLink href="https://www.statistikportal.de/de/gemeindeverzeichnis">Gemeindeverzeichnis-Online</HelpLink> suchen (ab drei Buchstaben).</li>
                          <li>Den 8-stelligen <strong>Amtlichen Gemeindeschlüssel (AGS)</strong> ablesen, z. B. <code className="font-mono">05315000</code>.</li>
                          <li>Die ersten 5 Stellen nehmen und 7 Nullen anhängen: <code className="font-mono">053150000000</code>.</li>
                        </ol>
                        <p className="m-0 text-fg-muted">Danach „Testen“: Unter „Meldungen im eigenen Gebiet“ erscheinen die aktuellen Warnungen.</p>
                      </HelpTip>
                    } help="12 Stellen; die Schnittstelle liefert Meldungen auf Kreisebene (erste 5 Stellen). Meldungen von dort gelten auch für jede Gemeinde im Kreis." htmlFor="wf-ars"><Input id="wf-ars" mono value={cfg.ars ?? ''} onChange={(e) => setCfg({ ...cfg, ars: e.target.value })} /></FieldWrap>
                  ) : (
                    <FieldWrap label="Adresse" htmlFor="wf-url" labelAction={
                      <HelpTip title="CAP-Adresse" more="/hilfe/verbindungen#eigene-cap-quelle">
                        <p className="m-0">Eine <code className="font-mono">https://</code>-Adresse, die ein CAP-Dokument (<HelpLink href="https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html">OASIS-Standard</HelpLink>) oder einen Atom-Feed mit eingebetteten CAP-Meldungen liefert. Die Adresse nennt der Betreiber des Warnsystems.</p>
                        <p className="m-0 text-fg-muted">Feeds, die nur auf CAP-Dateien verlinken, und ZIP-Archive (z. B. DWD Open Data) werden nicht gelesen – DWD-Warnungen kommen über die Warn-App-Schnittstelle.</p>
                      </HelpTip>
                    }><Input id="wf-url" type="url" value={cfg.url ?? ''} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} /></FieldWrap>
                  )}
                  <div className="grid sm:grid-cols-2 gap-3">
                    <FieldWrap label="Gebietsfilter: Geocode-Präfixe (Komma)" labelAction={
                      <HelpTip title="Geocode-Präfix (optional)" more="/hilfe/verbindungen#regionalschluessel-und-gebietsfilter">
                        <p className="m-0">Der vollständige 12-stellige ARS der eigenen Gemeinde. Er steht im kostenlosen <HelpLink href="https://www.statistikportal.de/de/veroeffentlichungen/anschriftenverzeichnis">Anschriftenverzeichnis</HelpLink> des Statistikportals.</p>
                        <p className="m-0">Warnungen für den ganzen Kreis oder das Land gelten trotzdem mit. Das Feld darf leer bleiben – dann reichen die Ortsnamen als Filter.</p>
                      </HelpTip>
                    } help="z. B. ARS der eigenen Gemeinde. Kreis- und Landeswarnungen gelten mit." htmlFor="wf-codes"><ListInput id="wf-codes" mono value={cfg.areaFilter?.codes ?? []} onChange={(codes) => setCfg({ ...cfg, areaFilter: { ...(cfg.areaFilter ?? {}), codes } })} /></FieldWrap>
                    <FieldWrap label="Gebietsfilter: Ortsnamen (Komma)" labelAction={
                      <HelpTip title="Ortsnamen" more="/hilfe/verbindungen#regionalschluessel-und-gebietsfilter">
                        <p className="m-0">Gemeinde und Ortsteile so, wie sie in Warnungen genannt werden, durch Komma getrennt – z. B. <code className="font-mono">Musterstadt, Nordheim, Südfeld</code>.</p>
                        <p className="m-0">Sie filtern die Meldungen und bestimmen, welche Orte im Bannertext stehen. Für den Anfang reicht dieser Filter.</p>
                      </HelpTip>
                    } help="Bestimmt auch, welche Orte im Bannertext stehen." htmlFor="wf-names"><ListInput id="wf-names" value={cfg.areaFilter?.names ?? []} onChange={(names) => setCfg({ ...cfg, areaFilter: { ...(cfg.areaFilter ?? {}), names } })} /></FieldWrap>
                  </div>
                  <FieldWrap label="Abrufintervall (Minuten)" htmlFor="wf-int"><Input id="wf-int" type="number" min={2} max={120} value={cfg.intervalMinutes ?? 5} onChange={(e) => setCfg({ ...cfg, intervalMinutes: Number(e.target.value) })} className="max-w-[120px]" /></FieldWrap>
                </>
              )}
              {['facebook', 'instagram', 'threads', 'mastodon', 'bluesky'].includes(c.kind) && (
                <div className="flex items-start gap-1">
                  <Switch checked={cfg.insights !== false} onChange={(v) => setCfg({ ...cfg, insights: v })} label="Reichweite abrufen" description="Aufrufe und Interaktionen veröffentlichter Beiträge 1 Stunde, 24 Stunden und 7 Tage nach der Veröffentlichung – nur Summen, keine Personen." />
                  <HelpTip title="Reichweite" more="/hilfe/verbindungen#reichweite">
                    <p className="m-0">{c.kind === 'facebook' ? 'Reaktionen, Kommentare und geteilte Beiträge gehen mit den vorhandenen Rechten. Aufrufe, Erreichte und Klicks brauchen zusätzlich read_insights – beim erneuten Verbinden fragt BlaulichtCMS es mit an.' : c.kind === 'instagram' ? 'Gefällt mir und Kommentare gehen mit den vorhandenen Rechten. Aufrufe, Reichweite, Geteilt und Gespeichert brauchen instagram_business_manage_insights – beim erneuten Verbinden fragt BlaulichtCMS es mit an.' : c.kind === 'threads' ? 'Braucht das Recht threads_manage_insights – beim erneuten Verbinden fragt BlaulichtCMS es mit an.' : c.kind === 'mastodon' ? 'Boosts, Favoriten und Antworten aus der Mastodon-API.' : 'Gefällt mir, Reposts, Antworten und Zitate aus der öffentlichen Bluesky-Schnittstelle.'}</p>
                    <p className="m-0 text-fg-muted">Der Schalter lässt sich ohne neuen Test ändern.</p>
                  </HelpTip>
                </div>
              )}
              {c.kind === 'x' && cfg.mode === 'api' && (
                <Switch checked={cfg.insights === true} onChange={(v) => setCfg({ ...cfg, insights: v })} label="Reichweite abrufen (kostet Guthaben)" description="Aufrufe, Gefällt mir, Antworten, Reposts, Zitate und Lesezeichen nach 1 Stunde, 24 Stunden und 7 Tagen. Jeder Abruf wird von X über das Guthaben abgerechnet. Standard aus." />
              )}
              <div className="flex flex-col gap-1.5 items-start">
                <Button variant="primary" icon="Save" disabled={busy} onClick={saveConfig}>Einstellungen speichern</Button>
                <p className="m-0 text-meta text-fg-muted">Geänderte Einstellungen oder Zugangsdaten verlangen einen neuen Test; eine aktive Verbindung hält bis dahin an. Nur der Name{c.kind === 'warnfeed' ? ' und das Abrufintervall' : c.kind === 'fe2' ? ' und „Beitragsentwürfe anlegen“' : c.kind === 'feuersoftware' ? ', der Abrufabstand und „Beitragsentwürfe anlegen“' : ['facebook', 'instagram', 'threads', 'x', 'mastodon', 'bluesky'].includes(c.kind) ? ' und „Reichweite abrufen“' : ''} lassen sich ohne neuen Test ändern.</p>
              </div>
            </div>
          </Card>
          {c.private_target && (
            <Card title="Internes Ziel">
              <div className="flex flex-col gap-2 text-sm">
                <p className="m-0">Die Adresse zeigt auf <code>{c.private_target}</code>. Interne Ziele (privates Netz) sind gesperrt, bis jemand mit dem Recht „Interne Zieladressen erlauben“ sie ausdrücklich freigibt.</p>
                {c.private_approved_at ? <Badge tone="success">Freigegeben {fmtDateTime(c.private_approved_at)}</Badge> : can('connection.private_targets') && <div><Button size="sm" icon="ShieldCheck" onClick={async () => (await ask({ title: 'Internes Ziel freigeben?', text: `BlaulichtCMS darf danach „${c.private_target}“ im eigenen Netz abrufen. Nur freigeben, wenn das Ziel bekannt und vertrauenswürdig ist.`, confirmLabel: 'Freigeben', danger: false })) && act(() => post(`/connections/${id}/approve-private`, { host: c.private_target }), 'Internes Ziel freigegeben')}>Internes Ziel freigeben</Button></div>}
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
            {RECEIPT_KINDS.includes(c.kind) && can('connection.log') && (
              <p className="m-0 text-meta text-fg-muted">
                Was genau angekommen ist – jede Meldung mit Entscheidung, Grund und Rohdaten – zeigt das{' '}
                <button type="button" className="underline hover:text-fg" onClick={() => setStep('empfang')}>Empfangsprotokoll</button>.
              </p>
            )}
          </div>
        </Card>
      )}

      {step === 'vorschau' && (
        <div className="flex flex-col gap-4">
          <Card title="Verfügbare Funktionen" subtitle="Wie sie der letzte Test tatsächlich vorgefunden hat.">
            {Object.keys(c.capabilities ?? {}).length ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(c.capabilities).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => (
                  <Badge key={k} tone={v ? 'success' : 'neutral'}>{({ text: 'Text', photos: 'Fotos', video: 'Video', image: 'Bild', carousel: 'Karussell', reels: 'Reels', stories: 'Storys', link: 'Link', manual: 'Teilen von Hand', text_only: 'Nur Text', drafts: 'Entwürfe', read: 'Abruf', autoBanner: 'Automatische Banner', alt_text: 'Alternativtext', content_warning: 'Inhaltswarnung', link_card: 'Link-Vorschaukarte', insights: 'Reichweite' } as any)[k] ?? k}: {v ? 'ja' : 'nein'}</Badge>
                ))}
              </div>
            ) : (
              <p className="m-0 text-sm text-fg-muted">Nach einem Test sichtbar.</p>
            )}
            {Object.keys(c.account ?? {}).length > 0 && <KeyValue className="mt-3" items={Object.entries(c.account).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [({ id: 'ID', name: 'Name', username: 'Benutzername', type: 'Kontoart', link: 'Link', mode: 'Betriebsart', instance: 'Instanz', version: 'Version' } as any)[k] ?? k, String(v)])} />}
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
          {c.kind === 'feuersoftware' && c.preview?.operations && (
            <Card title="Aktuelle Einsätze" subtitle={`${c.preview.matched} von ${c.preview.total} passen zu den Filtern · ohne Adresse`}>
              {c.preview.operations.length ? (
                <ul className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
                  {c.preview.operations.map((o: any, i: number) => (
                    <li key={i} className="flex gap-2 items-start">
                      <Icon name={o.matched ? 'CheckCircle2' : 'XCircle'} size={16} className={o.matched ? 'text-ok mt-0.5' : 'text-fg-muted mt-0.5'} />
                      <div>
                        <div className="font-medium">{o.title}</div>
                        {o.keyword && <KeywordMeaning code={o.keyword} className="block text-meta text-fg-muted" />}
                        <div className="text-meta text-fg-muted">{[o.start ? fmtDateTime(o.start) : null, o.ric ? `RIC ${o.ric}` : null, o.reason].filter(Boolean).join(' · ')}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-sm text-fg-muted">Zurzeit liefert Connect keinen aktuellen Einsatz.</p>
              )}
            </Card>
          )}
          {c.kind === 'warnfeed' && c.preview?.warnings && (
            <Card title="Meldungen im eigenen Gebiet" subtitle={`${c.preview.warnings.length} von ${c.preview.total} gelesenen`}>
              <ul className="m-0 pl-4 text-sm">{c.preview.warnings.map((w: any) => <li key={w.identifier}>{w.headline} <span className="text-fg-muted">({w.areas.join(', ')})</span></li>)}</ul>
            </Card>
          )}
          {['facebook', 'instagram', 'threads', 'x', 'whatsapp', 'mastodon', 'bluesky'].includes(c.kind) && (
            <Notice>Die Vorschau je Beitrag (Text und Formatprüfung je Kanal) steht im Beitrag unter „Soziale Kanäle – Status“.</Notice>
          )}
        </div>
      )}

      {step === 'aktivieren' && (
        <div className="flex flex-col gap-4">
          <Card title="Betrieb">
            <div className="flex flex-col gap-3">
              {revoked ? <Notice>Die Verbindung ist widerrufen; Zugangsdaten sind gelöscht. Für eine neue Anbindung eine neue Verbindung anlegen.</Notice> : c.status === 'active' ? <Notice tone="success">Aktiv seit {fmtDateTime(c.activated_at)}.</Notice> : !test?.ok ? <Notice tone="warning">Aktivieren ist erst nach einem bestandenen Test mit den aktuellen Einstellungen möglich.</Notice> : null}
              <div className="flex flex-wrap gap-2">
                {c.status !== 'active' && !revoked && <Button variant="primary" icon="Power" disabled={busy || !test?.ok} onClick={() => act(() => post(`/connections/${id}/activate`), 'Aktiviert')}>Aktivieren</Button>}
                {c.status === 'active' && <Button icon="PowerOff" onClick={() => act(() => post(`/connections/${id}/disable`), 'Angehalten')}>Anhalten</Button>}
                {(c.kind === 'warnfeed' || c.kind === 'feuersoftware') && c.status === 'active' && <Button icon="RefreshCw" loading={busy} onClick={() => act(() => post(`/connections/${id}/refresh`), 'Abgerufen')}>Jetzt abrufen</Button>}
                {!revoked && <Button variant="danger" icon="Ban" onClick={async () => (await ask({ title: 'Verbindung widerrufen?', text: 'Die gespeicherten Zugangsdaten werden gelöscht. Für eine neue Anbindung ist eine neue Verbindung nötig.', confirmLabel: 'Widerrufen' })) && act(() => post(`/connections/${id}/revoke`), 'Widerrufen')}>Widerrufen</Button>}
                {!deleted && can('connection.delete') && <Button variant="danger" icon="Trash2" disabled={busy} onClick={remove}>Löschen</Button>}
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
                    <FieldWrap label="Dokumentation der Prüfung" htmlFor="rv-note" labelAction={
                      <HelpTip title="Fachliche Prüfung" more="/hilfe/verbindungen#automatische-banner-und-pruefliste">
                        <p className="m-0">Festhalten, wer was geprüft hat – z. B. Gebietsfilter mit echten Meldungen, Ablauf und Entwarnung.</p>
                        <p className="m-0">Weiterverwendung von Bundeswarnungen vorher mit dem BBK klären (Programm <HelpLink href="https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warnung-in-Deutschland/Warnmultiplikatoren/warnmultiplikatoren_node.html">Warnmultiplikatoren</HelpLink>) und das Ergebnis hier vermerken.</p>
                      </HelpTip>
                    }><Textarea id="rv-note" rows={2} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} /></FieldWrap>
                    <div><Button disabled={review.note.trim().length < 10} onClick={() => act(() => post(`/connections/${id}/review`, review), 'Prüfung dokumentiert')}>Prüfung dokumentieren</Button></div>
                  </>
                )}
                {c.insecure_source && <Notice tone="warning" title="Quelle ohne HTTPS">Die Quelle wird über unverschlüsseltes HTTP abgerufen. Meldungen werden nur angezeigt; automatische Banner sind erst mit einer https-Adresse möglich.</Notice>}
                <Switch checked={!!cfg.autoBanner} disabled={!c.config.review?.approvedAt || !!c.insecure_source} onChange={(v) => setCfg({ ...cfg, autoBanner: v })} label="Automatische Banner für Warnungen im eigenen Gebiet" description="Aktualisierungen ersetzen, Entwarnungen beenden das Banner; Ablauf folgt der Gültigkeit." />
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

      {step === 'empfang' && can('connection.log') && <ReceiptLog id={id} kind={c.kind} />}
    </div>
  );
}

/** Kommagetrennte Liste: Text bleibt beim Tippen erhalten (Kommas, Leerzeichen), gespeichert wird die bereinigte Liste. */
const parseList = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
function ListInput({ id, value, onChange, mono }: { id: string; value: string[]; onChange: (v: string[]) => void; mono?: boolean }) {
  const [text, setText] = useState(value.join(', '));
  const joined = value.join('|');
  useEffect(() => {
    // Nur von außen geänderte Werte übernehmen (z. B. nach dem Laden), nicht die eigene Eingabe überschreiben
    if (parseList(text).join('|') !== joined) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <Input
      id={id}
      mono={mono}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}
