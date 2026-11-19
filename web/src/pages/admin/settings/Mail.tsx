import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../../api/client';
import { Badge, Button, FieldWrap, Input, Notice, Select, Switch } from '../../../components/ui/core';
import { useSaveSource, type SaveProblem } from '../../../components/ui/form';
import { useConfirm, useToast } from '../../../components/ui/overlays';
import { HelpLink, HelpTip } from '../../../components/ui/HelpTip';
import { useAuth } from '../../../lib/auth';
import { fmtDateTime, plural } from '../../../lib/format';
import { LoadError, SectionCard } from '../shared';
import { FieldGrid } from './model';

interface MailView {
  transport: 'smtp' | 'm365';
  route: string;
  ready: boolean;
  smtp: { host: string; port: number; security: string; user: string; from: string; password_set: boolean; verified_at: string | null; configured: boolean };
  m365: { tenant_id: string; client_id: string; sender: string; save_sent: boolean; secret_set: boolean; verified_at: string | null };
  push_enabled: boolean;
  mail_enabled: boolean;
  push_details: boolean;
  mail_details: boolean;
  warnings_test_mode: boolean;
  push: { key_set: boolean; subscriptions: number; subject: string };
}
type Form = {
  transport: 'smtp' | 'm365';
  host: string;
  port: number | '';
  security: string;
  user: string;
  password: string;
  from: string;
  tenantId: string;
  clientId: string;
  sender: string;
  clientSecret: string;
  saveSent: boolean;
  pushEnabled: boolean;
  mailEnabled: boolean;
  pushDetails: boolean;
  mailDetails: boolean;
};

const fromView = (d: MailView): Form => ({
  transport: d.transport,
  host: d.smtp.host ?? '',
  port: d.smtp.port,
  security: d.smtp.security,
  user: d.smtp.user ?? '',
  password: '',
  from: d.smtp.from ?? '',
  tenantId: d.m365.tenant_id,
  clientId: d.m365.client_id,
  sender: d.m365.sender,
  clientSecret: '',
  saveSent: d.m365.save_sent,
  pushEnabled: d.push_enabled,
  mailEnabled: d.mail_enabled,
  pushDetails: d.push_details,
  mailDetails: d.mail_details,
});
const m365Key = (f: Form) => JSON.stringify([f.tenantId.trim().toLowerCase(), f.clientId.trim().toLowerCase(), f.sender.trim().toLowerCase(), f.clientSecret]);
const smtpKey = (f: Form) => JSON.stringify([f.host.trim().toLowerCase(), Number(f.port), f.security, f.user.trim(), f.from.trim(), f.password]);

/**
 * Einstellungen → E-Mail & Push (#191, #256): Versandweg SMTP oder Microsoft 365 – beide mit Zugang und Testmail an
 * dieser einen Stelle (vorher lag SMTP unter Stichwörter & Regeln) –, Push und E-Mail global, Push-Schlüssel. Speichern
 * über die Leiste der Seite (PUT /notify/settings, SMTP im selben Aufruf).
 */
export function MailPage() {
  const { can } = useAuth();
  const manage = can('settings.mail');
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const q = useQuery({ queryKey: ['notify-settings'], queryFn: () => get<MailView>('/notify/settings') });
  const d = q.data;
  const [form, setForm] = useState<Form | null>(null);
  const [testTo, setTestTo] = useState('');
  const [verified, setVerified] = useState<{ smtp: string | null; m365: string | null }>({ smtp: null, m365: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  useEffect(() => {
    if (d && !form) setForm(fromView(d));
  }, [d, form]);

  const stored = d ? fromView(d) : null;
  const f = form ?? stored;
  const dirty = !!(f && stored) && (JSON.stringify({ ...f, clientSecret: '', password: '' }) !== JSON.stringify(stored) || !!f.clientSecret || !!f.password);
  const smtpChanged = !!(f && stored) && smtpKey(f) !== smtpKey(stored);
  const m365Changed = !!(f && stored) && m365Key(f) !== m365Key(stored);
  // Microsoft 365 wird erst nach bestandener Testmail mit genau diesen Angaben verwendet (Server prüft dasselbe) –
  // gespeichert werden die Angaben trotzdem

  const needsM365Test = !!(f && d) && f.transport === 'm365' && (d.transport !== 'm365' || m365Changed) && verified.m365 !== m365Key(f);
  // SMTP: im Echtbetrieb des Warnversands nur mit frischer Testmail dieser Angaben (Wechsel oder Änderung)
  const needsSmtpTest = !!(f && d) && f.transport === 'smtp' && !d.warnings_test_mode && (d.transport !== 'smtp' || smtpChanged) && verified.smtp !== smtpKey(f);
  const problems: SaveProblem[] = [];
  if (f) {
    if (f.transport === 'smtp' && (smtpChanged || d?.transport !== 'smtp')) {
      if (!f.host.trim()) problems.push({ id: 'n-host', message: 'Bitte den SMTP-Server eintragen.' });
      if (!f.from.trim()) problems.push({ id: 'n-from', message: 'Bitte die Absenderadresse eintragen.' });
      if (f.port === '' || !Number.isInteger(Number(f.port)) || Number(f.port) < 1 || Number(f.port) > 65535) problems.push({ id: 'n-port', message: 'Port: 1 bis 65535.' });
    }
    // Microsoft 365: Speichern geht immer, auch unvollständig und ohne Testmail – verwendet wird es erst nach bestandener
    // Testmail (der Server meldet das als Hinweis). SMTP im Echtbetrieb des Warnversands weiter nur mit Testmail.
    if (needsSmtpTest) problems.push({ id: 'n-test', message: 'Erst eine Testmail mit genau diesen Angaben senden (gilt 60 Minuten).' });
  }
  const formRef = useRef(f);
  formRef.current = f;

  useSaveSource({
    dirty: manage && dirty,
    problems,
    save: async () => {
      const x = formRef.current!;
      const r = await put<{ ok: boolean; notice?: string }>('/notify/settings', {
        transport: x.transport,
        pushEnabled: x.pushEnabled,
        mailEnabled: x.mailEnabled,
        pushDetails: x.pushDetails,
        mailDetails: x.mailDetails,
        tenantId: x.tenantId.trim(),
        clientId: x.clientId.trim(),
        sender: x.sender.trim(),
        saveSent: x.saveSent,
        ...(x.clientSecret ? { clientSecret: x.clientSecret } : {}),
        ...(smtpChanged ? { smtp: { host: x.host.trim(), port: Number(x.port), security: x.security, user: x.user.trim(), from: x.from.trim(), ...(x.password ? { password: x.password } : {}) } } : {}),
      });
      toast(r.notice ? { tone: 'warning', title: 'E-Mail & Push gespeichert', text: r.notice } : { tone: 'success', title: 'E-Mail & Push gespeichert' });
      await refresh();
    },
    discard: () => {
      if (d) setForm(fromView(d));
      setTestError(null);
    },
  });

  const refresh = async () => {
    // staleTime 0: sonst liefert der Cache den Stand von vor dem Speichern und das Formular springt zurück
    const fresh = await qc.fetchQuery({ queryKey: ['notify-settings'], queryFn: () => get<MailView>('/notify/settings'), staleTime: 0 });
    setForm(fromView(fresh));
    qc.invalidateQueries({ queryKey: ['notify-prefs'] });
    qc.invalidateQueries({ queryKey: ['warning-config'] });
  };

  if (q.isError) return <SectionCard title="Versandweg für alle E-Mails"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!d || !f) return <SectionCard title="Versandweg für alle E-Mails"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  const ro = !manage;
  const set = (p: Partial<Form>) => setForm({ ...f, ...p });
  const testMail = async () => {
    setBusy('test');
    setTestError(null);
    try {
      if (f.transport === 'm365') {
        const key = m365Key(f);
        await post('/notify/settings/test-mail', { to: testTo.trim(), tenantId: f.tenantId.trim(), clientId: f.clientId.trim(), sender: f.sender.trim(), saveSent: f.saveSent, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) });
        setVerified((v) => ({ ...v, m365: key }));
        toast({ tone: 'success', title: 'Testmail von Microsoft 365 angenommen' });
      } else {
        const key = smtpKey(f);
        await post('/notify/settings/smtp-test', { to: testTo.trim(), host: f.host.trim(), port: Number(f.port), security: f.security, user: f.user.trim(), from: f.from.trim(), ...(f.password ? { password: f.password } : {}) });
        setVerified((v) => ({ ...v, smtp: key }));
        toast({ tone: 'success', title: 'Testmail vom Mailserver angenommen' });
      }
      q.refetch();
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const rotate = async () => {
    if (!(await ask({ title: 'Push-Schlüssel erneuern?', text: `Alle ${d.push.subscriptions} eingerichteten Geräte verlieren ihr Push-Abo und müssen Push unter „Mein Konto“ neu einschalten.`, confirmLabel: 'Erneuern' }))) return;
    setBusy('rotate');
    try {
      const r = await post<{ removed: number }>('/notify/settings/push-rotate', {});
      toast({ tone: 'success', title: 'Push-Schlüssel erneuert', text: `${plural(r.removed, 'Gerät', 'Geräte')} entfernt.` });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: 'Nicht erneuert', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const smtpReady = !!f.host.trim() && !!f.from.trim();
  const m365Ready = !!f.tenantId.trim() && !!f.clientId.trim() && !!f.sender.trim() && (!!f.clientSecret || d.m365.secret_set);
  const isVerified = f.transport === 'm365' ? verified.m365 === m365Key(f) : verified.smtp === smtpKey(f);
  const lastOk = f.transport === 'm365' ? d.m365.verified_at : d.smtp.verified_at;

  return (
    <>
      <SectionCard
        id="versandweg"
        title="Versandweg für alle E-Mails"
        description="Gilt für Einladungen, Benachrichtigungen, Sicherheitsmeldungen, Pressemitteilungen, Presseantworten, Workflows und den Warnversand."
        action={<Badge tone={d.ready ? 'success' : 'warning'}>Derzeit: {d.route}</Badge>}
        bodyClassName="flex flex-col gap-5"
      >
        <FieldWrap
          label="Versandweg"
          htmlFor="n-transport"
          labelAction={
            <HelpTip title="SMTP oder Microsoft 365" more="/hilfe/benachrichtigungen#microsoft-365">
              <p className="m-0">SMTP: der Postausgangsserver des E-Mail-Anbieters. Microsoft 365: BlaulichtCMS sendet als Anwendung über Microsoft Graph aus einem Funktionspostfach – ohne Postfach-Passwort und ohne „Authentifiziertes SMTP“; dafür ist eine App-Registrierung in Microsoft Entra nötig.</p>
            </HelpTip>
          }
        >
          <Select id="n-transport" disabled={ro} value={f.transport} onChange={(e) => set({ transport: e.target.value as Form['transport'] })}>
            <option value="smtp">SMTP-Server</option>
            <option value="m365">Microsoft 365 (Microsoft Graph)</option>
          </Select>
        </FieldWrap>

        {f.transport === 'smtp' ? (
          <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
            <FieldWrap
              label="Server"
              htmlFor="n-host"
              required
              labelAction={
                <HelpTip title="SMTP-Server" more="/hilfe/benachrichtigungen#smtp-einrichten">
                  <p className="m-0">Der Postausgangsserver des E-Mail-Anbieters – die Daten kommen von der eigenen IT bzw. dem Anbieter. Beispiele: IONOS <code className="font-mono">smtp.ionos.de</code>, STRATO <code className="font-mono">smtp.strato.de</code>.</p>
                </HelpTip>
              }
            >
              <Input id="n-host" disabled={ro} value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.org" autoComplete="off" />
            </FieldWrap>
            <FieldWrap
              label="Port"
              htmlFor="n-port"
              labelAction={
                <HelpTip title="Port und Verschlüsselung" more="/hilfe/benachrichtigungen#port-und-verschluesselung">
                  <p className="m-0"><strong>587</strong> mit STARTTLS oder <strong>465</strong> mit TLS – welche Kombination der Server erwartet, steht in der Hilfe des Anbieters. Ohne Verschlüsselung ist keine Anmeldung möglich.</p>
                </HelpTip>
              }
            >
              <Input id="n-port" type="number" inputMode="numeric" min={1} max={65535} disabled={ro} value={f.port} onChange={(e) => set({ port: e.target.value === '' ? '' : Number(e.target.value) })} />
            </FieldWrap>
            <FieldWrap label="Verschlüsselung" htmlFor="n-sec">
              <Select id="n-sec" disabled={ro} value={f.security} onChange={(e) => set({ security: e.target.value })}>
                <option value="starttls">STARTTLS (587)</option>
                <option value="tls">TLS (465)</option>
                <option value="none">keine (nur Testserver ohne Anmeldung)</option>
              </Select>
            </FieldWrap>
            <FieldWrap
              label="Benutzer"
              htmlFor="n-user"
              labelAction={
                <HelpTip title="Benutzer und Passwort" more="/hilfe/benachrichtigungen#woher-die-zugangsdaten-kommen">
                  <p className="m-0">Anmeldename des Postfachs, meist die vollständige E-Mail-Adresse. Manche Anbieter verlangen ein App-Passwort (z. B. Google) oder eine Freischaltung (GMX/WEB.DE: POP3/IMAP einschalten).</p>
                </HelpTip>
              }
            >
              <Input id="n-user" disabled={ro} value={f.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
            </FieldWrap>
            <FieldWrap label={d.smtp.password_set ? 'Passwort (gespeichert – nur zum Ersetzen ausfüllen)' : 'Passwort'} htmlFor="n-pw" help="Wird verschlüsselt gespeichert und nie wieder angezeigt.">
              <Input id="n-pw" type="password" disabled={ro} value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
            </FieldWrap>
            <FieldWrap
              label="Absender"
              htmlFor="n-from"
              required
              labelAction={
                <HelpTip title="Absender" more="/hilfe/benachrichtigungen#spf-dkim-und-dmarc">
                  <p className="m-0">
                    Die Adresse, die als Absender erscheint – optional mit Namen, z. B. „Feuerwehr Musterstadt &lt;presse@example.org&gt;“. Sie muss zum Postfach gehören oder dafür freigegeben sein, sonst lehnt der Server ab oder die Mail landet im Spam (SPF/DKIM,{' '}
                    <HelpLink href="https://www.bsi.bund.de/DE/Themen/Verbraucherinnen-und-Verbraucher/Informationen-und-Empfehlungen/Onlinekommunikation/E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit_node.html">Erklärung des BSI</HelpLink>).
                  </p>
                </HelpTip>
              }
            >
              <Input id="n-from" disabled={ro} value={f.from} onChange={(e) => set({ from: e.target.value })} placeholder="blaulichtcms@example.org" autoComplete="off" />
            </FieldWrap>
          </FieldGrid>
        ) : (
          <div className="flex flex-col gap-4">
            <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))]">
              <FieldWrap
                label="Verzeichnis-ID (Tenant-ID)"
                htmlFor="n-tenant"
                required
                labelAction={
                  <HelpTip title="Tenant-ID und Client-ID" more="/hilfe/benachrichtigungen#app-registrierung-in-microsoft-entra">
                    <p className="m-0">
                      Beide stehen in Microsoft Entra unter App-Registrierungen → die App → Übersicht („Verzeichnis-ID (Mandant)“ und „Anwendungs-ID (Client)“). Anleitung: <HelpLink href="https://learn.microsoft.com/de-de/entra/identity-platform/quickstart-register-app">App registrieren (Microsoft Learn)</HelpLink>.
                    </p>
                  </HelpTip>
                }
              >
                <Input id="n-tenant" disabled={ro} value={f.tenantId} onChange={(e) => set({ tenantId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" className="font-mono" />
              </FieldWrap>
              <FieldWrap label="Anwendungs-ID (Client-ID)" htmlFor="n-client" required>
                <Input id="n-client" disabled={ro} value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" className="font-mono" />
              </FieldWrap>
              <FieldWrap
                label={d.m365.secret_set ? 'Client-Geheimnis (gespeichert – nur zum Ersetzen ausfüllen)' : 'Client-Geheimnis'}
                htmlFor="n-secret"
                required={!d.m365.secret_set}
                labelAction={
                  <HelpTip title="Client-Geheimnis" more="/hilfe/benachrichtigungen#app-registrierung-in-microsoft-entra">
                    <p className="m-0">Unter „Zertifikate & Geheimnisse“ ein neues Geheimnis erstellen und den <strong>Wert</strong> (nicht die Geheimnis-ID) eintragen. Es wird verschlüsselt gespeichert und nie wieder angezeigt. Ablaufdatum notieren – danach schlägt der Versand fehl.</p>
                  </HelpTip>
                }
              >
                <Input id="n-secret" type="password" disabled={ro} value={f.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} autoComplete="new-password" />
              </FieldWrap>
              <FieldWrap
                label="Absenderpostfach"
                htmlFor="n-sender"
                required
                labelAction={
                  <HelpTip title="Absenderpostfach" more="/hilfe/benachrichtigungen#zugriff-auf-ein-postfach-beschraenken">
                    <p className="m-0">
                      Ein Postfach in Exchange Online, z. B. ein freigegebenes Funktionspostfach. Mit „Mail.Send“ darf die App ohne Einschränkung aus jedem Postfach senden – deshalb den Zugriff auf dieses Postfach beschränken (<HelpLink href="https://learn.microsoft.com/de-de/exchange/permissions-exo/application-rbac">RBAC für Anwendungen</HelpLink>).
                    </p>
                  </HelpTip>
                }
              >
                <Input id="n-sender" type="email" disabled={ro} value={f.sender} onChange={(e) => set({ sender: e.target.value })} placeholder="presse@example.org" autoComplete="off" />
              </FieldWrap>
            </FieldGrid>
            <Switch checked={f.saveSent} disabled={ro} onChange={(v) => set({ saveSent: v })} label="In „Gesendete Elemente“ ablegen" description="Jede versendete Mail liegt zusätzlich im Ordner „Gesendete Elemente“ des Absenderpostfachs." />
          </div>
        )}

        {(needsM365Test || needsSmtpTest) && (
          <Notice tone="warning">
            {needsM365Test
              ? 'Speichern geht jederzeit, auch unvollständig. Verwendet wird Microsoft 365 aber erst, nachdem mit genau diesen Angaben eine Testmail erfolgreich versendet wurde (gilt 60 Minuten) – danach erneut speichern.'
              : 'Der Warnversand ist im Echtbetrieb: Geänderte SMTP-Angaben lassen sich erst speichern, nachdem mit genau diesen Angaben eine Testmail erfolgreich versendet wurde (gilt 60 Minuten).'}
          </Notice>
        )}
        {manage && (
          <div className="flex flex-wrap gap-2 items-end border-t border-line pt-4">
            <FieldWrap label="Testmail an" htmlFor="n-test" help="Gesendet wird mit den Werten im Formular – auch ungespeicherten. Passwort bzw. Geheimnis leer = gespeicherter Wert (nur für denselben Server bzw. dieselbe App)." error={testError}>
              <Input id="n-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} autoComplete="email" />
            </FieldWrap>
            <Button icon="Mail" loading={busy === 'test'} disabled={!testTo.trim() || !(f.transport === 'm365' ? m365Ready : smtpReady)} aria-describedby="n-test-why" onClick={testMail}>
              Testmail senden
            </Button>
            <span id="n-test-why" className="text-meta text-fg-muted self-center">
              {!testTo.trim()
                ? 'Empfängeradresse eintragen.'
                : !(f.transport === 'm365' ? m365Ready : smtpReady)
                  ? f.transport === 'm365'
                    ? 'Verzeichnis-ID, Anwendungs-ID, Geheimnis und Absenderpostfach eintragen.'
                    : 'Server und Absender eintragen.'
                  : isVerified
                    ? ''
                    : lastOk
                      ? `Letzter erfolgreicher Test ${fmtDateTime(lastOk)}`
                      : ''}
            </span>
            {isVerified && <Badge tone="success">Test mit diesen Angaben erfolgreich</Badge>}
          </div>
        )}
      </SectionCard>

      <SectionCard id="benachrichtigungen" title="Push und E-Mail-Benachrichtigungen" description="Zusätzlich zur Glocke. Jede Person wählt unter „Mein Konto“, welche Arten sie wie bekommt." bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Switch checked={f.pushEnabled} disabled={ro} onChange={(v) => set({ pushEnabled: v })} label="Push-Benachrichtigungen" description={`Mitteilungen an Browser und installierte App (Web Push). ${plural(d.push.subscriptions, 'Gerät', 'Geräte')} eingerichtet.`} />
          <Switch checked={f.mailEnabled} disabled={ro} onChange={(v) => set({ mailEnabled: v })} label="E-Mail-Benachrichtigungen" description="Benachrichtigungen per E-Mail über den gewählten Versandweg. Warnversand und Sicherheitsmeldungen sind davon unabhängig." />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <h3 className="m-0 text-sm font-semibold">Inhalt außerhalb von BlaulichtCMS</h3>
            <HelpTip title="Einzelheiten in Push und E-Mail" more="/hilfe/benachrichtigungen#inhalt-von-push-und-e-mail">
              <p className="m-0">Ausgeschaltet tragen Push-Mitteilungen und E-Mails nur die Art der Benachrichtigung (z. B. „Neue Einsatzmeldung“) und einen Link. Eingeschaltet enthalten sie Titel und Text wie die Glocke – z. B. Stichwort und Ort eines Einsatzes oder den Betreff einer Presse-Mail. Push-Mitteilungen erscheinen auf dem Sperrbildschirm; E-Mails sind nicht Ende-zu-Ende-verschlüsselt und gehen ggf. an private Postfächer.</p>
            </HelpTip>
          </div>
          <Switch checked={f.pushDetails} disabled={ro} onChange={(v) => set({ pushDetails: v })} label="Einzelheiten in Push-Mitteilungen" description="Titel und Text der Benachrichtigung statt nur der Art. Erscheint ggf. auf dem Sperrbildschirm." />
          <Switch checked={f.mailDetails} disabled={ro} onChange={(v) => set({ mailDetails: v })} label="Einzelheiten in E-Mail-Benachrichtigungen" description="Titel und Text der Benachrichtigung im Betreff und in der Mail. Nur einschalten, wenn die Konten dienstliche Adressen haben." />
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="m-0 text-sm font-semibold">Push-Schlüssel</h3>
          <p className="m-0 text-meta text-fg-muted">
            {d.push.key_set ? 'Das Schlüsselpaar (VAPID) ist erzeugt; der private Schlüssel liegt verschlüsselt auf dem Server.' : 'Das Schlüsselpaar (VAPID) wird erzeugt, sobald die erste Person Push einschaltet.'} Kontaktangabe gegenüber den Push-Diensten: <span className="font-mono">{d.push.subject}</span>
          </p>
          {manage && d.push.key_set && (
            <div>
              <Button size="sm" variant="ghost" icon="RefreshCw" loading={busy === 'rotate'} onClick={rotate}>
                Schlüssel erneuern
              </Button>
            </div>
          )}
        </div>
      </SectionCard>
    </>
  );
}
