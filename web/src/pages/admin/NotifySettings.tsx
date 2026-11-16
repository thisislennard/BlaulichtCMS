import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../api/client';
import { Badge, Button, FieldWrap, Input, Notice, Select, Switch } from '../../components/ui/core';
import { useConfirm, useToast } from '../../components/ui/overlays';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { fmtDateTime } from '../../lib/format';
import { FieldGrid, LoadError, SectionCard } from './shared';

interface NotifySettingsView {
  transport: 'smtp' | 'm365';
  route: string;
  ready: boolean;
  smtp: { host: string; from: string; configured: boolean };
  m365: { tenant_id: string; client_id: string; sender: string; save_sent: boolean; secret_set: boolean; verified_at: string | null };
  push_enabled: boolean;
  mail_enabled: boolean;
  push: { key_set: boolean; subscriptions: number; subject: string };
}
type Form = { transport: 'smtp' | 'm365'; tenantId: string; clientId: string; sender: string; clientSecret: string; saveSent: boolean; pushEnabled: boolean; mailEnabled: boolean };

const fromView = (d: NotifySettingsView): Form => ({ transport: d.transport, tenantId: d.m365.tenant_id, clientId: d.m365.client_id, sender: d.m365.sender, clientSecret: '', saveSent: d.m365.save_sent, pushEnabled: d.push_enabled, mailEnabled: d.mail_enabled });
const m365Key = (f: Form) => JSON.stringify([f.tenantId.trim().toLowerCase(), f.clientId.trim().toLowerCase(), f.sender.trim().toLowerCase(), f.clientSecret]);

/**
 * Einstellungen → Benachrichtigungen und E-Mail (#191): Versandweg (SMTP oder Microsoft 365 über Microsoft Graph wie
 * LiFeOS), Microsoft-365-Zugang mit Verbindungstest vor der Aktivierung, Push und E-Mail global, Push-Schlüssel.
 */
export function NotifySettingsSection({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const q = useQuery({ queryKey: ['notify-settings'], queryFn: () => get<NotifySettingsView>('/notify/settings') });
  const d = q.data;
  const [form, setForm] = useState<Form | null>(null);
  const [testTo, setTestTo] = useState('');
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (d && !form) setForm(fromView(d));
  }, [d, form]);

  if (q.isError) return <SectionCard id="benachrichtigungen" title="Benachrichtigungen und E-Mail"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!d || !form) return <SectionCard id="benachrichtigungen" title="Benachrichtigungen und E-Mail"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  const ro = !manage;
  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const stored = fromView(d);
  const dirty = JSON.stringify({ ...form, clientSecret: '' }) !== JSON.stringify(stored) || !!form.clientSecret;
  const m365Changed = m365Key(form) !== m365Key(stored);
  // Microsoft 365 erst nach bestandener Testmail mit genau diesen Angaben (Server prüft dasselbe)
  const needsTest = form.transport === 'm365' && (d.transport !== 'm365' || m365Changed) && verifiedKey !== m365Key(form);
  const m365Body = { tenantId: form.tenantId.trim(), clientId: form.clientId.trim(), sender: form.sender.trim(), saveSent: form.saveSent, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) };

  const refresh = async () => {
    const fresh = await qc.fetchQuery({ queryKey: ['notify-settings'], queryFn: () => get<NotifySettingsView>('/notify/settings') });
    setForm(fromView(fresh));
    qc.invalidateQueries({ queryKey: ['notify-prefs'] });
  };
  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await put('/notify/settings', { transport: form.transport, pushEnabled: form.pushEnabled, mailEnabled: form.mailEnabled, ...m365Body });
      toast({ tone: 'success', title: 'Gespeichert' });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const testMail = async () => {
    setBusy('test');
    setError(null);
    const key = m365Key(form);
    try {
      await post('/notify/settings/test-mail', { to: testTo.trim(), ...m365Body });
      setVerifiedKey(key);
      toast({ tone: 'success', title: 'Testmail von Microsoft 365 angenommen' });
      q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const rotate = async () => {
    if (!(await ask({ title: 'Push-Schlüssel erneuern?', text: `Alle ${d.push.subscriptions} eingerichteten Geräte verlieren ihr Push-Abo und müssen Push unter „Mein Konto“ neu einschalten.`, confirmLabel: 'Erneuern' }))) return;
    setBusy('rotate');
    try {
      const r = await post<{ removed: number }>('/notify/settings/push-rotate', {});
      toast({ tone: 'success', title: 'Push-Schlüssel erneuert', text: `${r.removed} Gerät(e) entfernt.` });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      id="benachrichtigungen"
      title="Benachrichtigungen und E-Mail"
      description="Push auf Geräte und E-Mail zusätzlich zur Glocke. Jede Person wählt unter „Mein Konto“, welche Arten sie wie bekommt."
      action={<Badge tone={d.ready ? 'success' : 'warning'}>E-Mail: {d.route}</Badge>}
      bodyClassName="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1">
        <Switch checked={form.pushEnabled} disabled={ro} onChange={(v) => set({ pushEnabled: v })} label="Push-Benachrichtigungen" description={`Mitteilungen an Browser und installierte App (Web Push). ${d.push.subscriptions} Gerät(e) eingerichtet.`} />
        <Switch checked={form.mailEnabled} disabled={ro} onChange={(v) => set({ mailEnabled: v })} label="E-Mail-Benachrichtigungen" description="Benachrichtigungen per E-Mail über den gewählten Versandweg. Warnversand und Sicherheitsmeldungen sind davon unabhängig." />
      </div>

      <FieldWrap label="Versandweg für alle E-Mails" htmlFor="n-transport" help="Gilt für Warnversand, Sicherheitsmeldungen, Workflows und Benachrichtigungen." labelAction={
        <HelpTip title="SMTP oder Microsoft 365" more="/hilfe/benachrichtigungen#microsoft-365">
          <p className="m-0">Mit Microsoft 365 sendet BlaulichtCMS als Anwendung über Microsoft Graph aus einem Funktionspostfach – ohne Postfach-Passwort und ohne „Authentifiziertes SMTP“. Dafür ist eine App-Registrierung in Microsoft Entra nötig.</p>
        </HelpTip>
      }>
        <Select id="n-transport" disabled={ro} value={form.transport} onChange={(e) => set({ transport: e.target.value as Form['transport'] })}>
          <option value="smtp">SMTP{d.smtp.configured ? ` (${d.smtp.host})` : ' (nicht eingerichtet)'}</option>
          <option value="m365">Microsoft 365 (Microsoft Graph)</option>
        </Select>
      </FieldWrap>

      {form.transport === 'smtp' && (
        <Notice icon="Mail">
          Server, Zugangsdaten und Testmail für SMTP stehen unter <Link to="/warnungen/pflege">Warnentwürfe → Pflege → Versand</Link>.
        </Notice>
      )}

      {form.transport === 'm365' && (
        <div className="flex flex-col gap-4 border border-line rounded-card p-4">
          <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))]">
            <FieldWrap label="Verzeichnis-ID (Tenant-ID)" htmlFor="n-tenant" labelAction={
              <HelpTip title="Tenant-ID und Client-ID" more="/hilfe/benachrichtigungen#app-registrierung-in-microsoft-entra">
                <p className="m-0">Beide stehen in Microsoft Entra unter App-Registrierungen → die App → Übersicht („Verzeichnis-ID (Mandant)“ und „Anwendungs-ID (Client)“). Anleitung: <HelpLink href="https://learn.microsoft.com/de-de/entra/identity-platform/quickstart-register-app">App registrieren (Microsoft Learn)</HelpLink>.</p>
              </HelpTip>
            }>
              <Input id="n-tenant" disabled={ro} value={form.tenantId} onChange={(e) => set({ tenantId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" className="font-mono" />
            </FieldWrap>
            <FieldWrap label="Anwendungs-ID (Client-ID)" htmlFor="n-client">
              <Input id="n-client" disabled={ro} value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" className="font-mono" />
            </FieldWrap>
            <FieldWrap label={d.m365.secret_set ? 'Client-Geheimnis (gespeichert – nur zum Ersetzen ausfüllen)' : 'Client-Geheimnis'} htmlFor="n-secret" labelAction={
              <HelpTip title="Client-Geheimnis" more="/hilfe/benachrichtigungen#app-registrierung-in-microsoft-entra">
                <p className="m-0">Unter „Zertifikate & Geheimnisse“ ein neues Geheimnis erstellen und den <strong>Wert</strong> (nicht die Geheimnis-ID) eintragen. Es wird verschlüsselt gespeichert und nie wieder angezeigt. Ablaufdatum notieren – danach schlägt der Versand fehl.</p>
              </HelpTip>
            }>
              <Input id="n-secret" type="password" disabled={ro} value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} autoComplete="new-password" />
            </FieldWrap>
            <FieldWrap label="Absenderpostfach" htmlFor="n-sender" labelAction={
              <HelpTip title="Absenderpostfach" more="/hilfe/benachrichtigungen#zugriff-auf-ein-postfach-beschraenken">
                <p className="m-0">Ein Postfach in Exchange Online, z. B. ein freigegebenes Funktionspostfach. Mit „Mail.Send“ darf die App ohne Einschränkung aus jedem Postfach senden – deshalb den Zugriff auf dieses Postfach beschränken (<HelpLink href="https://learn.microsoft.com/de-de/exchange/permissions-exo/application-rbac">RBAC für Anwendungen</HelpLink>).</p>
              </HelpTip>
            }>
              <Input id="n-sender" type="email" disabled={ro} value={form.sender} onChange={(e) => set({ sender: e.target.value })} placeholder="presse@example.org" autoComplete="off" />
            </FieldWrap>
          </FieldGrid>
          <Switch checked={form.saveSent} disabled={ro} onChange={(v) => set({ saveSent: v })} label="In „Gesendete Elemente“ ablegen" description="Jede versendete Mail liegt zusätzlich im Ordner „Gesendete Elemente“ des Absenderpostfachs." />
          {needsTest && <Notice tone="warning">Microsoft 365 lässt sich erst speichern, nachdem mit genau diesen Angaben eine Testmail erfolgreich versendet wurde (gilt 60 Minuten).</Notice>}
          {manage && (
            <div className="flex flex-wrap gap-2 items-end border-t border-line pt-4">
              <FieldWrap label="Testmail an" htmlFor="n-test" help="Gesendet wird mit den Werten im Formular – auch ungespeicherten. Geheimnis leer = gespeichertes Geheimnis (nur für dieselbe App).">
                <Input id="n-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </FieldWrap>
              <Button icon="Mail" loading={busy === 'test'} disabled={!testTo.trim() || !form.tenantId.trim() || !form.clientId.trim() || !form.sender.trim() || (!form.clientSecret && !d.m365.secret_set)} onClick={testMail}>Testmail senden</Button>
              {verifiedKey === m365Key(form) ? <Badge tone="success">Test mit diesen Angaben erfolgreich</Badge> : d.m365.verified_at ? <span className="text-meta text-fg-muted">Letzter erfolgreicher Test {fmtDateTime(d.m365.verified_at)}</span> : null}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">Push-Schlüssel</h3>
        <p className="m-0 text-meta text-fg-muted">
          {d.push.key_set ? 'Das Schlüsselpaar (VAPID) ist erzeugt; der private Schlüssel liegt verschlüsselt auf dem Server.' : 'Das Schlüsselpaar (VAPID) wird erzeugt, sobald die erste Person Push einschaltet.'} Kontaktangabe gegenüber den Push-Diensten: <span className="font-mono">{d.push.subject}</span>
        </p>
        {manage && d.push.key_set && <div><Button size="sm" variant="ghost" icon="RefreshCw" loading={busy === 'rotate'} onClick={rotate}>Schlüssel erneuern</Button></div>}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {manage && (
        <div className="flex gap-2">
          <Button variant="primary" icon="Save" loading={busy === 'save'} disabled={!dirty || needsTest} onClick={save}>Speichern</Button>
          {dirty && <Button variant="ghost" onClick={() => { setForm(fromView(d)); setError(null); }}>Verwerfen</Button>}
        </div>
      )}
    </SectionCard>
  );
}
