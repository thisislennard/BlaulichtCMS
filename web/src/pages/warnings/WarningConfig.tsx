import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../../api/client';
import { Badge, Button, Card, Chip, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Switch, Tabs, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { FormProblems, useFormCheck } from '../../components/ui/form';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { KeywordsTab } from './KeywordTable';

type Tab = 'stichwoerter' | 'regeln' | 'zustaendigkeiten' | 'vorlagen' | 'testmodus';
const TABS: Tab[] = ['stichwoerter', 'regeln', 'zustaendigkeiten', 'vorlagen', 'testmodus'];
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function WarningConfig() {
  const ask = useConfirm();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['warning-config'], queryFn: () => get<any>('/warning-config') });
  // Reiter mit Adresse (?tab=testmodus, z. B. aus der Suche); „versand“ war bis #256 der Reiter mit dem SMTP-Server
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') === 'versand' ? 'testmodus' : (params.get('tab') as Tab | null);
  const [tab, setTabState] = useState<Tab>(asked && TABS.includes(asked) ? asked : 'stichwoerter');
  const setTab = (t: Tab) => {
    setTabState(t);
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (t === 'stichwoerter') n.delete('tab');
      else n.set('tab', t);
      return n;
    }, { replace: true });
  };
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
  // Testmodus (#256: der Mailserver selbst steht unter Einstellungen → E-Mail & Push)
  const [testCfg, setTestCfg] = useState<{ testMode: boolean; testRecipient: string } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [mailing, setMailing] = useState(false);
  // Zeitpunkt der letzten erfolgreichen Testmail über den eingestellten Versandweg (in dieser Ansicht)
  const [testedAt, setTestedAt] = useState<number | null>(null);
  const [tpl, setTpl] = useState<any>(null);
  // Bearbeiten: Zuständigkeit (Name, Gebiet, Empfänger); Stichwörter bearbeitet KeywordTable.tsx
  const [editResp, setEditResp] = useState<{ id: string; name: string; area: string; recipients: string; active: boolean } | null>(null);

  // Prüfen statt sperren (#268): Regel und Zuständigkeit nennen fehlende Angaben am Feld
  const ruleCheck = useFormCheck({
    'r-kw': !rf.keywordId && 'Bitte ein Stichwort wählen.',
    'r-name': rf.name.trim().length < 3 && 'Bitte einen Namen angeben (mindestens 3 Zeichen).',
    'r-cond': !rf.conditions.trim() && 'Bitte mindestens eine Bedingung angeben.',
    'r-reason': rf.reason.trim().length < 10 && 'Bitte fachlich begründen (mindestens 10 Zeichen).',
  });
  const respCheck = useFormCheck({
    'rs-name': resp.name.trim().length < 2 && 'Bitte einen Namen angeben (mindestens 2 Zeichen).',
    'rs-rcpt': !csv(resp.recipients).length && 'Bitte mindestens eine E-Mail-Adresse angeben.',
  });
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Konfiguration konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const c = q.data;
  const kwById = Object.fromEntries(c.keywords.map((k: any) => [k.id, k]));
  const s = testCfg ?? { testMode: c.testMode.active, testRecipient: c.testMode.recipient };
  // Nachweis für den Echtbetrieb: frische Testmail über den eingestellten Versandweg (höchstens 60 Minuten)
  const viaM365 = c.transport?.kind === 'm365';
  const verifiedAt = viaM365 ? c.transport.verified_at : c.smtp.verified_at;
  const fresh = (!!verifiedAt && Date.now() - Date.parse(verifiedAt) <= 60 * 60_000) || (!!testedAt && Date.now() - testedAt <= 60 * 60_000);
  const routeReady = viaM365 ? !!c.transport.sender : !!(c.smtp.host && c.smtp.from);
  const needsTestMail = !s.testMode && c.testMode.active && !fresh;

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
          ...(can('warning.settings') ? [{ value: 'testmodus' as Tab, label: 'Testmodus' }] : []),
        ]}
      />

      {tab === 'stichwoerter' && <KeywordsTab c={c} act={act} refresh={refresh} />}

      {tab === 'regeln' && (
        <div className="flex flex-col gap-4">
          {mayRules && (
            <Card title={rf.lineage ? 'Neue Version einer Regel' : 'Regel anlegen'} subtitle="Wirksam erst nach fachlicher Freigabe. Bedingungen: eine Zeile je Frage, z. B. „evakuierung = ja“ oder „wind = stark | sehr stark“.">
              <FormProblems check={ruleCheck} className="mb-3" />
              <div className="grid sm:grid-cols-2 gap-3">
                <FieldWrap label="Stichwort" htmlFor="r-kw" required error={ruleCheck.error('r-kw')}>
                  <Select id="r-kw" value={rf.keywordId} onChange={(e) => setRf({ ...rf, keywordId: e.target.value })} disabled={!!rf.lineage}>
                    <option value="">– wählen –</option>
                    {c.keywords.map((k: any) => <option key={k.id} value={k.id}>{k.code} – {k.label}</option>)}
                  </Select>
                </FieldWrap>
                <FieldWrap label="Name" htmlFor="r-name" required error={ruleCheck.error('r-name')}><Input id="r-name" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} /></FieldWrap>
                <FieldWrap label="Bedingungen" htmlFor="r-cond" required error={ruleCheck.error('r-cond')}><Textarea id="r-cond" rows={3} mono value={rf.conditions} onChange={(e) => setRf({ ...rf, conditions: e.target.value })} /></FieldWrap>
                <div className="flex flex-col gap-3">
                  <FieldWrap label="Ergebnis" htmlFor="r-lvl">
                    <Select id="r-lvl" value={rf.level} onChange={(e) => setRf({ ...rf, level: Number(e.target.value) })}>
                      {[1, 2, 3].map((l) => <option key={l} value={l}>Warnstufe {l}</option>)}
                    </Select>
                  </FieldWrap>
                  <FieldWrap label="Fachliche Begründung" htmlFor="r-reason" required error={ruleCheck.error('r-reason')}><Textarea id="r-reason" rows={2} value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} /></FieldWrap>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="primary" icon="Save"
                  onClick={() => ruleCheck.submit(async () => (await act(() => post('/warning-rules', { lineage: rf.lineage, keywordId: rf.keywordId, name: rf.name, conditions: parseConditions(rf.conditions), level: rf.level, reason: rf.reason }), 'Regel als Entwurf gespeichert')) && (setRf({ lineage: null, keywordId: '', name: '', conditions: '', level: 3, reason: '' }), ruleCheck.reset()))}>
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
              <FormProblems check={respCheck} className="mb-3" />
              <div className="grid sm:grid-cols-3 gap-3">
                <FieldWrap label="Name" htmlFor="rs-name" required error={respCheck.error('rs-name')}><Input id="rs-name" value={resp.name} onChange={(e) => setResp({ ...resp, name: e.target.value })} /></FieldWrap>
                <FieldWrap label="Gebiet" htmlFor="rs-area"><Input id="rs-area" value={resp.area} onChange={(e) => setResp({ ...resp, area: e.target.value })} /></FieldWrap>
                <FieldWrap label="E-Mail-Adressen (Komma-getrennt)" htmlFor="rs-rcpt" required error={respCheck.error('rs-rcpt')}><Input id="rs-rcpt" value={resp.recipients} onChange={(e) => setResp({ ...resp, recipients: e.target.value })} /></FieldWrap>
              </div>
              <div className="mt-3">
                <Button variant="primary" icon="Plus" onClick={() => respCheck.submit(async () => (await act(() => post('/responsibilities', { name: resp.name, area: resp.area, recipients: csv(resp.recipients) }), 'Zuständigkeit angelegt')) && (setResp({ name: '', area: '', recipients: '' }), respCheck.reset()))}>
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

      {tab === 'testmodus' && can('warning.settings') && (
        <Card title="Testmodus des Warnversands" subtitle="Im Testmodus gehen alle Warnmails ausschließlich an das Testpostfach.">
          <div className="flex flex-col gap-4">
            <Notice icon="Mail" title={`Versandweg: ${viaM365 ? `Microsoft 365 (${c.transport.sender || 'nicht eingerichtet'})` : c.smtp.host ? `SMTP (${c.smtp.host})` : 'SMTP – nicht eingerichtet'}`}>
              Mailserver bzw. Microsoft 365 samt Zugangsdaten und Testmail werden an einer Stelle für alle E-Mails eingerichtet: <Link to="/einstellungen/e-mail">Einstellungen → E-Mail &amp; Push</Link>.
            </Notice>
            <Switch
              checked={s.testMode}
              onChange={(x) => setTestCfg({ ...s, testMode: x })}
              label="Testmodus"
              description="Alle Warnmails gehen ausschließlich an das Testpostfach (Betreff mit [TEST]). Für den Echtbetrieb erst nach Abstimmung mit der zuständigen Stelle und nach einer erfolgreichen Testmail ausschalten."
            />
            <FieldWrap label="Testpostfach" htmlFor="s-tr" labelAction={
              <HelpTip title="Testpostfach" more="/hilfe/stichwoerter-regeln#testmail-und-testmodus">
                <p className="m-0">Ein eigenes Postfach, an das im Testmodus alle Warnmails gehen (Betreff mit [TEST]). Nicht die Adresse der zuständigen Stelle eintragen.</p>
              </HelpTip>
            }><Input id="s-tr" type="email" value={s.testRecipient} onChange={(e) => setTestCfg({ ...s, testRecipient: e.target.value })} /></FieldWrap>
            <div className="flex flex-wrap gap-2 items-end border-t border-line pt-4">
              <FieldWrap label="Testmail an" htmlFor="s-test" help="Über den eingestellten Versandweg mit den gespeicherten Angaben. Eine erfolgreiche Testmail gilt 60 Minuten als Nachweis für den Echtbetrieb.">
                <Input id="s-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              </FieldWrap>
              <Button
                icon="Mail"
                disabled={!testTo || !routeReady}
                aria-describedby="s-test-why"
                loading={mailing}
                onClick={async () => {
                  setMailing(true);
                  const ok = await act(() => post('/warning-settings/test-mail', { to: testTo }), 'Testmail angenommen');
                  if (ok) setTestedAt(Date.now());
                  setMailing(false);
                }}
              >
                Testmail senden
              </Button>
              <span id="s-test-why" className="text-meta text-fg-muted self-center">
                {!routeReady ? 'Erst den Versandweg unter Einstellungen → E-Mail & Push einrichten.' : !testTo ? 'Empfängeradresse eintragen.' : ''}
              </span>
              {fresh && <Badge tone="success">Testmail innerhalb der letzten 60 Minuten erfolgreich</Badge>}
            </div>
            {needsTestMail && (
              <Notice tone="warning">Der Testmodus lässt sich erst ausschalten, nachdem über den eingestellten Versandweg eine Testmail erfolgreich versendet wurde (oben „Testmail senden“, gilt 60 Minuten).</Notice>
            )}
            <div>
              <Button
                variant="primary"
                icon="Save"
                onClick={async () => {
                  if (needsTestMail) return document.getElementById('s-test')?.focus();
                  if (await act(() => put('/warning-settings', { testMode: s.testMode, testRecipient: s.testRecipient }), 'Gespeichert')) setTestCfg(null);
                }}
                aria-describedby={needsTestMail ? 's-save-why' : undefined}
              >
                Speichern
              </Button>
              {needsTestMail && <span id="s-save-why" className="sr-only">Erst eine Testmail senden.</span>}
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
