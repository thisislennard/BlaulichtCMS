import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../api/client';
import { Badge, Button, Card, Chip, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch, Tabs, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { KeywordsTab } from './KeywordTable';

type Tab = 'stichwoerter' | 'regeln' | 'zustaendigkeiten' | 'vorlagen' | 'versand';
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function WarningConfig() {
  const ask = useConfirm();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['warning-config'], queryFn: () => get<any>('/warning-config') });
  const [tab, setTab] = useState<Tab>('stichwoerter');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['warning-config'] });
    qc.invalidateQueries({ queryKey: ['keywords'] });
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ tone: 'success', title: ok });
      refresh();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  const myId = me?.user.id;
  const mayRules = can('warning.rules');
  const mayApprove = can('warning.approve');

  // Formulare (Stichwörter und Lagefragen: KeywordTable.tsx)
  const [rf, setRf] = useState<{ lineage: string | null; keywordId: string; name: string; conditions: string; level: number; reason: string }>({ lineage: null, keywordId: '', name: '', conditions: '', level: 3, reason: '' });
  const [resp, setResp] = useState({ name: '', area: '', recipients: '' });
  const [smtp, setSmtp] = useState<any>(null);
  const [testTo, setTestTo] = useState('');
  const [mailing, setMailing] = useState(false);
  // Formularwerte, mit denen zuletzt eine Testmail erfolgreich war (Echtbetrieb nur mit genau diesen Werten)
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
  const [tpl, setTpl] = useState<any>(null);
  // Bearbeiten: Zuständigkeit (Name, Gebiet, Empfänger); Stichwörter bearbeitet KeywordTable.tsx
  const [editResp, setEditResp] = useState<{ id: string; name: string; area: string; recipients: string; active: boolean } | null>(null);

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Konfiguration konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const c = q.data;
  const kwById = Object.fromEntries(c.keywords.map((k: any) => [k.id, k]));
  const s = smtp ?? { ...c.smtp, password: '', testMode: c.testMode.active, testRecipient: c.testMode.recipient };
  const smtpKey = (x: any) => JSON.stringify([String(x.host ?? '').trim().toLowerCase(), Number(x.port), x.security, String(x.user ?? '').trim(), String(x.from ?? '').trim(), x.password ?? '']);
  const smtpDirty = smtpKey(s) !== smtpKey({ ...c.smtp, password: '' });
  // Versandweg Microsoft 365 (#191): Nachweis ist die Testmail unter Einstellungen → Benachrichtigungen und E-Mail
  const viaM365 = c.transport?.kind === 'm365';
  const m365Fresh = viaM365 && !!c.transport.verified_at && Date.now() - Date.parse(c.transport.verified_at) <= 60 * 60_000;
  const verified = viaM365 ? m365Fresh : verifiedKey === smtpKey(s);
  // Testmodus ausschalten bzw. im Echtbetrieb Versandeinstellungen ändern: nur nach erfolgreicher Testmail mit diesen Werten
  const needsTestMail = viaM365 ? !s.testMode && c.testMode.active && !m365Fresh : !s.testMode && (c.testMode.active || smtpDirty) && !verified;

  /** Bedingungen als Zeilen „frage = antwort1 | antwort2“ */
  const parseConditions = (txt: string) =>
    Object.fromEntries(
      txt
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [k, v] = l.split('=');
          return [k.trim(), (v ?? '').split('|').map((x) => x.trim()).filter(Boolean)];
        }),
    );
  const condText = (c: Record<string, string[]>) => Object.entries(c).map(([k, v]) => `${k} = ${v.join(' | ')}`).join('\n');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Lokal gepflegt. Regeln und Lagefragen wirken erst nach fachlicher Freigabe durch eine andere Person." />
      <Notice>BlaulichtCMS wird ohne aktive Regeln ausgeliefert. Alle Beispiele sind fiktiv – Inhalte vor Nutzung mit der zuständigen Stelle abstimmen.</Notice>
      <Tabs
        label="Bereiche"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'stichwoerter', label: 'Stichwörter & Fragen', count: c.keywords.filter((k: any) => k.active).length },
          { value: 'regeln', label: 'Regeln', count: c.rules.filter((r: any) => r.status === 'approved').length },
          { value: 'zustaendigkeiten', label: 'Zuständigkeiten', count: c.responsibilities.length },
          { value: 'vorlagen', label: 'Übergabe-Vorlagen' },
          ...(can('warning.settings') ? [{ value: 'versand' as Tab, label: 'E-Mail-Versand' }] : []),
        ]}
      />

      {tab === 'stichwoerter' && <KeywordsTab c={c} act={act} refresh={refresh} />}

      {tab === 'regeln' && (
        <div className="flex flex-col gap-4">
          {mayRules && (
            <Card title={rf.lineage ? 'Neue Version einer Regel' : 'Regel anlegen'} subtitle="Wirksam erst nach fachlicher Freigabe. Bedingungen: eine Zeile je Frage, z. B. „evakuierung = ja“ oder „wind = stark | sehr stark“.">
              <div className="grid sm:grid-cols-2 gap-3">
                <FieldWrap label="Stichwort" htmlFor="r-kw">
                  <Select id="r-kw" value={rf.keywordId} onChange={(e) => setRf({ ...rf, keywordId: e.target.value })} disabled={!!rf.lineage}>
                    <option value="">– wählen –</option>
                    {c.keywords.map((k: any) => <option key={k.id} value={k.id}>{k.code} – {k.label}</option>)}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Name" htmlFor="r-name"><Input id="r-name" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} /></FieldWrap>
                <FieldWrap label="Bedingungen" htmlFor="r-cond"><Textarea id="r-cond" rows={3} mono value={rf.conditions} onChange={(e) => setRf({ ...rf, conditions: e.target.value })} /></FieldWrap>
                <div className="flex flex-col gap-3">
                  <FieldWrap label="Ergebnis" htmlFor="r-lvl">
                    <Select id="r-lvl" value={rf.level} onChange={(e) => setRf({ ...rf, level: Number(e.target.value) })}>
                      {[1, 2, 3].map((l) => <option key={l} value={l}>Warnstufe {l}</option>)}
                    </Select>
                  </FieldWrap>
                  <FieldWrap label="Fachliche Begründung" htmlFor="r-reason"><Textarea id="r-reason" rows={2} value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} /></FieldWrap>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="primary" icon="Save" disabled={!rf.keywordId || rf.name.length < 3 || rf.reason.length < 10 || !rf.conditions.trim()}
                  onClick={async () => (await act(() => post('/warning-rules', { lineage: rf.lineage, keywordId: rf.keywordId, name: rf.name, conditions: parseConditions(rf.conditions), level: rf.level, reason: rf.reason }), 'Regel als Entwurf gespeichert')) && setRf({ lineage: null, keywordId: '', name: '', conditions: '', level: 3, reason: '' })}>
                  Als Entwurf speichern
                </Button>
                {rf.lineage && <Button onClick={() => setRf({ lineage: null, keywordId: '', name: '', conditions: '', level: 3, reason: '' })}>Abbrechen</Button>}
              </div>
            </Card>
          )}
          {c.rules.length === 0 && <Notice>Noch keine Regeln. Ohne freigegebene Regel gibt es keinen Vorschlag.</Notice>}
          {c.rules.map((r: any) => (
            <Card key={r.id}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip mono>{kwById[r.keyword_id]?.code ?? '?'}</Chip>
                  <strong>{r.name}</strong>
                  <span className="text-meta text-fg-muted">Version {r.version}</span>
                  <Badge tone={r.level === 1 ? 'error' : r.level === 2 ? 'warning' : 'neutral'}>Warnstufe {r.level}</Badge>
                  <StatusBadge status={r.status} labels={{ draft: 'Entwurf – nicht wirksam', approved: 'Fachlich freigegeben', retired: 'Außer Kraft' }} />
                </div>
                <pre className="text-meta font-mono bg-raised rounded-control p-2 whitespace-pre-wrap">{condText(r.conditions)}</pre>
                <p className="text-sm">{r.reason}</p>
                <p className="text-meta text-fg-muted">Angelegt von {r.created_by_name ?? '–'}{r.approved_at ? ` · freigegeben von ${r.approved_by_name}, ${fmtDateTime(r.approved_at)}` : ''}</p>
                <div className="flex flex-wrap gap-2">
                  {r.status === 'draft' && mayApprove && r.created_by !== myId && <Button size="sm" variant="primary" icon="Check" onClick={() => act(() => post(`/warning-rules/${r.id}/approve`), 'Regel freigegeben')}>Fachlich freigeben</Button>}
                  {r.status === 'draft' && r.created_by === myId && <span className="text-meta text-fg-muted">Freigabe durch eine andere Person nötig.</span>}
                  {r.status !== 'retired' && mayRules && <Button size="sm" onClick={() => setRf({ lineage: r.lineage, keywordId: r.keyword_id, name: r.name, conditions: condText(r.conditions), level: r.level, reason: r.reason })}>Neue Version</Button>}
                  {r.status !== 'retired' && mayRules && <Button size="sm" variant="danger" onClick={async () => (await ask({ title: 'Regel außer Kraft setzen?', text: `„${r.name}“ liefert danach keine Vorschläge mehr. Laufende Vorgänge behalten ihre Entscheidung.`, confirmLabel: 'Außer Kraft setzen' })) && act(() => post(`/warning-rules/${r.id}/retire`), 'Regel außer Kraft gesetzt')}>Außer Kraft setzen</Button>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'zustaendigkeiten' && (
        <div className="flex flex-col gap-4">
          {mayRules && (
            <Card title="Zuständigkeit anlegen" subtitle="Empfänger der Übergabe-Mail. Im Testmodus geht der Versand trotzdem nur an das Testpostfach.">
              <div className="grid sm:grid-cols-3 gap-3">
                <FieldWrap label="Name" htmlFor="rs-name"><Input id="rs-name" value={resp.name} onChange={(e) => setResp({ ...resp, name: e.target.value })} /></FieldWrap>
                <FieldWrap label="Gebiet" htmlFor="rs-area"><Input id="rs-area" value={resp.area} onChange={(e) => setResp({ ...resp, area: e.target.value })} /></FieldWrap>
                <FieldWrap label="E-Mail-Adressen (Komma-getrennt)" htmlFor="rs-rcpt"><Input id="rs-rcpt" value={resp.recipients} onChange={(e) => setResp({ ...resp, recipients: e.target.value })} /></FieldWrap>
              </div>
              <div className="mt-3">
                <Button variant="primary" icon="Plus" disabled={resp.name.length < 2 || !csv(resp.recipients).length} onClick={async () => (await act(() => post('/responsibilities', { name: resp.name, area: resp.area, recipients: csv(resp.recipients) }), 'Zuständigkeit angelegt')) && setResp({ name: '', area: '', recipients: '' })}>
                  Anlegen
                </Button>
              </div>
            </Card>
          )}
          {c.responsibilities.map((r: any) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2">
                <strong>{r.name}</strong>
                {r.area && <span className="text-fg-muted">{r.area}</span>}
                {!r.active && <Badge>inaktiv</Badge>}
                <span className="flex-1" />
                {mayRules && <Button size="sm" icon="Pencil" onClick={() => setEditResp({ id: r.id, name: r.name, area: r.area ?? '', recipients: r.recipients.join(', '), active: r.active })}>Bearbeiten</Button>}
                {mayRules && <Button size="sm" onClick={() => act(() => put(`/responsibilities/${r.id}`, { name: r.name, area: r.area, recipients: r.recipients, active: !r.active }), r.active ? 'Zuständigkeit deaktiviert' : 'Zuständigkeit aktiviert')}>{r.active ? 'Deaktivieren' : 'Aktivieren'}</Button>}
              </div>
              <div className="text-sm mt-1">{r.recipients.join(', ')}</div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'vorlagen' && (
        <div className="flex flex-col gap-4">
          <Notice>Eine Änderung erzeugt eine neue Vorlagenversion. Bestehende Vorgänge behalten ihre Version und bleiben reproduzierbar.</Notice>
          {c.templates.map((t: any) => (
            <Card key={t.id} title={`${t.name} – Version ${t.version}`} subtitle={`${t.family} · ${t.status === 'active' ? 'aktiv' : 'außer Kraft'}`}
              action={t.status === 'active' && mayRules && <Button size="sm" icon="Pencil" onClick={() => setTpl({ family: t.family, name: t.name, fields: JSON.stringify(t.fields, null, 2), levelLabels: t.level_labels, pdfTitle: t.pdf_title, pdfFooter: t.pdf_footer, mailSubject: t.mail_subject, mailBody: t.mail_body, note: t.note })}>Neue Version</Button>}>
              <p className="text-sm">{t.fields.length} Felder: {t.fields.map((f: any) => f.label).join(', ')}</p>
              {t.note && <p className="text-meta text-fg-muted mt-1">{t.note}</p>}
            </Card>
          ))}
          {tpl && (
            <Card title={`Neue Version: ${tpl.name}`}>
              <div className="flex flex-col gap-3">
                <FieldWrap label="Name" htmlFor="t-name"><Input id="t-name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /></FieldWrap>
                <div className="grid sm:grid-cols-3 gap-3">
                  {[1, 2, 3].map((l) => (
                    <FieldWrap key={l} label={`Bezeichnung Stufe ${l}`} htmlFor={`t-l${l}`}><Input id={`t-l${l}`} value={tpl.levelLabels[l]} onChange={(e) => setTpl({ ...tpl, levelLabels: { ...tpl.levelLabels, [l]: e.target.value } })} /></FieldWrap>
                  ))}
                </div>
                <FieldWrap label="PDF-Titel" htmlFor="t-pt"><Input id="t-pt" value={tpl.pdfTitle} onChange={(e) => setTpl({ ...tpl, pdfTitle: e.target.value })} /></FieldWrap>
                <FieldWrap label="PDF-Fußzeile" htmlFor="t-pf"><Textarea id="t-pf" rows={2} value={tpl.pdfFooter} onChange={(e) => setTpl({ ...tpl, pdfFooter: e.target.value })} /></FieldWrap>
                <FieldWrap label="Betreff" help="Platzhalter: {art} {vorgang} {ueberschrift} {fassung} {stufe} {rueckruf} {absender}" htmlFor="t-ms"><Input id="t-ms" value={tpl.mailSubject} onChange={(e) => setTpl({ ...tpl, mailSubject: e.target.value })} /></FieldWrap>
                <FieldWrap label="Mailtext" htmlFor="t-mb"><Textarea id="t-mb" rows={6} value={tpl.mailBody} onChange={(e) => setTpl({ ...tpl, mailBody: e.target.value })} /></FieldWrap>
                <FieldWrap label="Felder (JSON)" help="key, label, type (text, textarea, datetime, checkbox, select), required, help" htmlFor="t-f"><Textarea id="t-f" rows={10} mono value={tpl.fields} onChange={(e) => setTpl({ ...tpl, fields: e.target.value })} /></FieldWrap>
                <div className="flex gap-2">
                  <Button variant="primary" icon="Save" onClick={async () => {
                    let fields;
                    try { fields = JSON.parse(tpl.fields); } catch { toast({ tone: 'error', title: 'Felder sind kein gültiges JSON' }); return; }
                    if (await act(() => post('/warning-templates', { ...tpl, fields }), 'Neue Vorlagenversion gespeichert')) setTpl(null);
                  }}>Version speichern</Button>
                  <Button onClick={() => setTpl(null)}>Abbrechen</Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'versand' && can('warning.settings') && (
        <Card title="E-Mail-Versand (SMTP)" subtitle="Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.">
          <div className="flex flex-col gap-4">
            {viaM365 && (
              <Notice icon="Mail" title="Versand über Microsoft 365">
                Alle E-Mails gehen über das Postfach {c.transport.sender} (Einstellungen → Benachrichtigungen und E-Mail); die SMTP-Angaben unten werden derzeit nicht verwendet. Den Testmodus ausschalten lässt sich nach einer Testmail über Microsoft 365 (gilt 60 Minuten){m365Fresh ? ' – liegt vor.' : '.'}
              </Notice>
            )}
            <Switch
              checked={s.testMode}
              disabled={s.testMode && c.testMode.active && !verified}
              onChange={(x) => setSmtp({ ...s, testMode: x })}
              label="Testmodus"
              description={
                s.testMode && c.testMode.active && !verified
                  ? 'Ausschalten erst nach einer erfolgreichen Testmail mit genau den Einstellungen unten („Testmail senden“). Für den Echtbetrieb außerdem vorher mit der zuständigen Stelle abstimmen.'
                  : 'Alle Warnmails gehen ausschließlich an das Testpostfach. Für den Echtbetrieb erst nach Abstimmung mit der zuständigen Stelle ausschalten.'
              }
            />
            <FieldWrap label="Testpostfach" htmlFor="s-tr" labelAction={
              <HelpTip title="Testpostfach" more="/hilfe/stichwoerter-regeln#testmail-und-testmodus">
                <p className="m-0">Ein eigenes Postfach, an das im Testmodus alle Warnmails gehen (Betreff mit [TEST]). Nicht die Adresse der zuständigen Stelle eintragen.</p>
              </HelpTip>
            }><Input id="s-tr" type="email" value={s.testRecipient} onChange={(e) => setSmtp({ ...s, testRecipient: e.target.value })} /></FieldWrap>
            <div className="grid sm:grid-cols-3 gap-3">
              <FieldWrap label="Server" htmlFor="s-host" labelAction={
                <HelpTip title="SMTP-Server" more="/hilfe/stichwoerter-regeln#werte-bekannter-anbieter">
                  <p className="m-0">Der Postausgangsserver des E-Mail-Anbieters – die Daten kommen von der eigenen IT bzw. dem Anbieter. Beispiele: Microsoft 365 <code className="font-mono">smtp.office365.com</code>, IONOS <code className="font-mono">smtp.ionos.de</code>, STRATO <code className="font-mono">smtp.strato.de</code>.</p>
                </HelpTip>
              }><Input id="s-host" value={s.host} onChange={(e) => setSmtp({ ...s, host: e.target.value })} placeholder="smtp.example.org" /></FieldWrap>
              <FieldWrap label="Port" htmlFor="s-port" labelAction={
                <HelpTip title="Port und Verschlüsselung" more="/hilfe/stichwoerter-regeln#port-und-verschluesselung">
                  <p className="m-0"><strong>587</strong> mit STARTTLS oder <strong>465</strong> mit TLS – welche Kombination der Server erwartet, steht in der Hilfe des Anbieters. Ohne Verschlüsselung ist keine Anmeldung möglich.</p>
                </HelpTip>
              }><Input id="s-port" type="number" value={s.port} onChange={(e) => setSmtp({ ...s, port: Number(e.target.value) })} /></FieldWrap>
              <FieldWrap label="Verschlüsselung" htmlFor="s-sec">
                <Select id="s-sec" value={s.security} onChange={(e) => setSmtp({ ...s, security: e.target.value })}>
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">TLS (465)</option>
                  <option value="none">keine (nur Testserver ohne Anmeldung)</option>
                </Select>
              </FieldWrap>
              <FieldWrap label="Benutzer" htmlFor="s-user" labelAction={
                <HelpTip title="Benutzer und Passwort" more="/hilfe/stichwoerter-regeln#woher-die-zugangsdaten-kommen">
                  <p className="m-0">Anmeldename des Postfachs, meist die vollständige E-Mail-Adresse. Manche Anbieter verlangen ein App-Passwort (z. B. Google) oder eine Freischaltung (Microsoft 365: „Authentifiziertes SMTP“, GMX/WEB.DE: POP3/IMAP einschalten).</p>
                </HelpTip>
              }><Input id="s-user" value={s.user} onChange={(e) => setSmtp({ ...s, user: e.target.value })} autoComplete="off" /></FieldWrap>
              <FieldWrap label={c.smtp.password_set ? 'Passwort (gespeichert – nur zum Ersetzen ausfüllen)' : 'Passwort'} htmlFor="s-pw"><Input id="s-pw" type="password" value={s.password} onChange={(e) => setSmtp({ ...s, password: e.target.value })} autoComplete="new-password" /></FieldWrap>
              <FieldWrap label="Absender" htmlFor="s-from" labelAction={
                <HelpTip title="Absender" more="/hilfe/stichwoerter-regeln#spf-dkim-und-dmarc">
                  <p className="m-0">Die Adresse, die als Absender erscheint – optional mit Namen, z. B. „Feuerwehr Musterstadt &lt;presse@example.org&gt;“. Sie muss zum Postfach gehören oder dafür freigegeben sein, sonst lehnt der Server ab oder die Mail landet im Spam (SPF/DKIM, <HelpLink href="https://www.bsi.bund.de/DE/Themen/Verbraucherinnen-und-Verbraucher/Informationen-und-Empfehlungen/Onlinekommunikation/E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit/technischer-Hintergrund-E-Mail-Sicherheit_node.html">Erklärung des BSI</HelpLink>).</p>
                </HelpTip>
              }><Input id="s-from" value={s.from} onChange={(e) => setSmtp({ ...s, from: e.target.value })} placeholder="blaulichtcms@example.org" /></FieldWrap>
            </div>
            {needsTestMail && (
              <Notice tone="warning">
                {viaM365 ? 'Der Testmodus lässt sich erst ausschalten, nachdem unter Einstellungen → Benachrichtigungen und E-Mail eine Testmail über Microsoft 365 erfolgreich versendet wurde (gilt 60 Minuten).' : <>{c.testMode.active ? 'Der Testmodus lässt sich erst ausschalten,' : 'Im Echtbetrieb lassen sich die Versandeinstellungen erst speichern,'} nachdem mit genau diesen Einstellungen eine Testmail erfolgreich versendet wurde (unten „Testmail senden“, gilt 60 Minuten).</>}
              </Notice>
            )}
            <div className="flex flex-wrap gap-2 items-end border-t border-line pt-4">
              <FieldWrap label="Testmail an" htmlFor="s-test" help="Gesendet wird mit den Werten im Formular – auch ungespeicherten. Passwort leer = gespeichertes Passwort (nur für denselben Server).">
                <Input id="s-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </FieldWrap>
              <Button
                icon="Mail"
                disabled={!testTo || !s.host || !s.from}
                loading={mailing}
                onClick={async () => {
                  setMailing(true);
                  const key = smtpKey(s);
                  const ok = await act(() => post('/warning-settings/test-mail', { to: testTo, host: s.host, port: s.port, security: s.security, user: s.user, from: s.from, password: s.password || undefined }), 'Testmail angenommen');
                  if (ok) setVerifiedKey(key);
                  setMailing(false);
                }}
              >
                Testmail senden
              </Button>
              {verified && <Badge tone="success">Testmail mit diesen Einstellungen erfolgreich</Badge>}
            </div>
            <div>
              <Button variant="primary" icon="Save" disabled={needsTestMail} onClick={async () => (await act(() => put('/warning-settings', { host: s.host, port: s.port, security: s.security, user: s.user, from: s.from, password: s.password || undefined, testMode: s.testMode, testRecipient: s.testRecipient }), 'Gespeichert')) && setSmtp(null)}>Speichern</Button>
            </div>
          </div>
        </Card>
      )}
      {editResp && (
        <Dialog
          open
          onClose={() => setEditResp(null)}
          title="Zuständigkeit bearbeiten"
          footer={
            <>
              <Button onClick={() => setEditResp(null)}>Abbrechen</Button>
              <Button
                variant="primary"
                disabled={editResp.name.trim().length < 2 || !csv(editResp.recipients).length}
                onClick={async () => (await act(() => put(`/responsibilities/${editResp.id}`, { name: editResp.name.trim(), area: editResp.area.trim(), recipients: csv(editResp.recipients), active: editResp.active }), 'Zuständigkeit gespeichert')) && setEditResp(null)}
              >
                Speichern
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FieldWrap label="Name" required htmlFor="r-name" error={editResp.name.trim().length < 2 ? 'Mindestens 2 Zeichen.' : null}>
              <Input id="r-name" value={editResp.name} maxLength={120} onChange={(e) => setEditResp({ ...editResp, name: e.target.value })} />
            </FieldWrap>
            <FieldWrap label="Gebiet" htmlFor="r-area">
              <Input id="r-area" value={editResp.area} maxLength={200} onChange={(e) => setEditResp({ ...editResp, area: e.target.value })} />
            </FieldWrap>
            <FieldWrap label="Empfänger (Komma-getrennt)" required help="Gilt für künftige Übergaben; bereits versendete Warnentwürfe bleiben unverändert." htmlFor="r-rec" error={!csv(editResp.recipients).length ? 'Mindestens eine E-Mail-Adresse.' : null}>
              <Input id="r-rec" value={editResp.recipients} onChange={(e) => setEditResp({ ...editResp, recipients: e.target.value })} />
            </FieldWrap>
          </div>
        </Dialog>
      )}
    </div>
  );
}
