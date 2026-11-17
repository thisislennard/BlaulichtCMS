import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post, put } from '../../api/client';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, SegmentedControl, Select, SkeletonRows, Switch, Table, Td, Th } from '../../components/ui/core';
import { SecretField, useErrorToast, useToast } from '../../components/ui/overlays';
import { fmtDateTime, fmtRelative } from '../../lib/format';

interface MailboxResponse {
  config: { enabled: boolean; mode: 'imap' | 'm365'; host: string; port: number; security: 'tls' | 'starttls'; user: string; folder: string; mailbox: string; intervalMinutes: number; maxAttachmentMb: number; passwordSet: boolean; verifiedAt: string | null };
  state: { lastRunAt: string | null; lastOk: boolean | null; lastError: string | null; lastImported: number | null };
  m365Ready: boolean;
  retentionDays: number;
}

const OUTCOME: Record<string, { label: string; tone: 'success' | 'neutral' | 'warning' | 'error' | 'primary' }> = {
  created: { label: 'Neue Anfrage', tone: 'success' },
  assigned: { label: 'Zugeordnet', tone: 'primary' },
  duplicate: { label: 'Doppelt', tone: 'neutral' },
  auto: { label: 'Automatische Antwort', tone: 'neutral' },
  spam: { label: 'Spam', tone: 'warning' },
  bulk: { label: 'Massenmail', tone: 'neutral' },
  own: { label: 'Eigene Mail', tone: 'neutral' },
  too_large: { label: 'Zu groß', tone: 'warning' },
  invalid: { label: 'Nicht übernommen', tone: 'warning' },
  error: { label: 'Fehler', tone: 'error' },
  ok: { label: 'Wieder in Ordnung', tone: 'success' },
};

/** Presse-Postfach (#205): IMAP oder Microsoft 365, Verbindungstest, Abruf schalten, Empfangsprotokoll. */
export function MailboxSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['press-mailbox'], queryFn: () => get<MailboxResponse>('/press/mailbox') });
  const logs = useQuery({ queryKey: ['press-mailbox-log'], queryFn: () => get<any[]>('/press/mailbox/log'), refetchInterval: 30_000 });
  const [v, setV] = useState<MailboxResponse['config'] | null>(null);
  const [password, setPassword] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && !v) setV(q.data.config);
  }, [q.data, v]);
  if (q.isLoading || !v) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Einstellungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const set = (p: Partial<typeof v>) => {
    setV({ ...v, ...p });
    setTest(null);
  };
  const body = () => ({ mode: v.mode, host: v.host, port: Number(v.port), security: v.security, user: v.user, folder: v.folder, mailbox: v.mailbox, intervalMinutes: Number(v.intervalMinutes), maxAttachmentMb: Number(v.maxAttachmentMb), ...(password ? { password } : {}) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['press-mailbox'] });
    qc.invalidateQueries({ queryKey: ['press-mailbox-log'] });
  };
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const save = (enabled: boolean) =>
    run('save', async () => {
      const r = await put<{ config: MailboxResponse['config'] }>('/press/mailbox', { ...body(), enabled });
      setV(r.config);
      setPassword('');
      toast({ tone: 'success', title: enabled ? 'Abruf eingeschaltet' : 'Gespeichert' });
      refresh();
    });
  const s = q.data!.state;
  return (
    <div className="flex flex-col gap-5">
      <Card title="Postfach und Abruf" subtitle="Mails an das Presse-Postfach werden automatisch zu Presseanfragen; Antworten im selben Verlauf landen bei der bestehenden Anfrage.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={v.enabled ? (s.lastOk === false ? 'error' : 'success') : 'neutral'}>{v.enabled ? (s.lastOk === false ? 'Abruf gestört' : 'Abruf aktiv') : 'Abruf aus'}</Badge>
            {s.lastRunAt && (
              <span className="text-fg-muted">
                Letzter Abruf {fmtRelative(s.lastRunAt)}
                {s.lastOk && s.lastImported != null ? ` · ${s.lastImported} übernommen` : ''}
              </span>
            )}
          </div>
          {s.lastOk === false && s.lastError && <Notice tone="error">{s.lastError}</Notice>}
          <div>
            <SegmentedControl<'imap' | 'm365'> label="Art des Postfachs" value={v.mode} onChange={(mode) => set({ mode })} options={[{ value: 'imap', label: 'IMAP' }, { value: 'm365', label: 'Microsoft 365' }]} />
          </div>
          {v.mode === 'imap' ? (
            <div className="grid sm:grid-cols-2 gap-4">
              <FieldWrap label="IMAP-Server" required htmlFor="mb-host">
                <Input id="mb-host" value={v.host} onChange={(e) => set({ host: e.target.value })} placeholder="imap.example.org" autoComplete="off" />
              </FieldWrap>
              <div className="grid grid-cols-2 gap-4">
                <FieldWrap label="Verschlüsselung" htmlFor="mb-sec">
                  <Select id="mb-sec" value={v.security} onChange={(e) => set({ security: e.target.value as any, port: e.target.value === 'tls' ? 993 : 143 })}>
                    <option value="tls">TLS (993)</option>
                    <option value="starttls">STARTTLS (143)</option>
                  </Select>
                </FieldWrap>
                <FieldWrap label="Port" htmlFor="mb-port" help="993 oder 143; andere Ports nur nach Freigabe durch die Administration.">
                  <Input id="mb-port" type="number" min={1} max={65535} value={v.port} onChange={(e) => set({ port: Number(e.target.value) })} />
                </FieldWrap>
              </div>
              <FieldWrap label="Benutzername" required htmlFor="mb-user">
                <Input id="mb-user" value={v.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
              </FieldWrap>
              <SecretField
                id="mb-pass"
                label="Passwort"
                set={q.data!.config.passwordSet}
                value={password}
                onReplace={(x) => {
                  setPassword(x);
                  setTest(null);
                }}
                help="Wird verschlüsselt gespeichert und nie wieder angezeigt. Gilt nur für diesen Server, Port und Benutzer – bei einer Änderung neu eingeben. Bei Anbietern mit Zwei-Faktor-Anmeldung ein App-Passwort verwenden."
              />
              <FieldWrap label="Ordner" htmlFor="mb-folder" help="Meist INBOX. Der Ordner wird nur gelesen – nichts wird verschoben oder als gelesen markiert.">
                <Input id="mb-folder" value={v.folder} onChange={(e) => set({ folder: e.target.value })} />
              </FieldWrap>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {!q.data!.m365Ready && (
                <Notice tone="warning">
                  Microsoft 365 ist noch nicht eingerichtet. Zuerst unter <Link to="/einstellungen#benachrichtigungen">Einstellungen → Benachrichtigungen und E-Mail</Link> die App-Registrierung eintragen.
                </Notice>
              )}
              <FieldWrap label="Adresse des Presse-Postfachs" required htmlFor="mb-box" help="Dieselbe App-Registrierung wie der Mailversand; zusätzlich braucht sie die Anwendungsberechtigung „Mail.Read“ (Hilfe → Presseanfragen).">
                <Input id="mb-box" type="email" value={v.mailbox} onChange={(e) => set({ mailbox: e.target.value })} placeholder="presse@example.org" />
              </FieldWrap>
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-4">
            <FieldWrap label="Abruf alle" htmlFor="mb-int" help="1 bis 60 Minuten.">
              <Input id="mb-int" type="number" min={1} max={60} value={v.intervalMinutes} onChange={(e) => set({ intervalMinutes: Number(e.target.value) })} />
            </FieldWrap>
            <FieldWrap label="Anhänge höchstens (MB)" htmlFor="mb-max" help="Je Anhang, 1 bis 25 MB. Erlaubt sind Dokumente, Bilder, Audio und Video (Prüfung am Inhalt).">
              <Input id="mb-max" type="number" min={1} max={25} value={v.maxAttachmentMb} onChange={(e) => set({ maxAttachmentMb: Number(e.target.value) })} />
            </FieldWrap>
          </div>
          {test && <Notice tone={test.ok ? 'success' : 'error'}>{test.text}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button
              icon="Plug"
              loading={busy === 'test'}
              onClick={() =>
                run('test', async () => {
                  const r = await post<{ ok: boolean; info?: string; error?: string }>('/press/mailbox/test', body());
                  setTest({ ok: r.ok, text: r.ok ? r.info! : r.error! });
                })
              }
            >
              Verbindung testen
            </Button>
            <Button loading={busy === 'save'} onClick={() => save(v.enabled)}>
              Speichern
            </Button>
            {v.enabled && (
              <Button icon="RefreshCw" loading={busy === 'poll'} onClick={() => run('poll', async () => {
                const r = await post<{ imported?: number; skipped?: number; more?: boolean; error?: string }>('/press/mailbox/poll');
                const more = r.more ? 'Weitere Mails folgen in Kürze automatisch.' : undefined;
                toast(r.error ? { tone: 'error', title: 'Abruf fehlgeschlagen', text: r.error } : { tone: r.skipped ? 'warning' : 'success', title: `${r.imported ?? 0} Mail(s) übernommen${r.skipped ? `, ${r.skipped} nicht übernommen (siehe Empfangsprotokoll)` : ''}`, text: more });
                refresh();
              })}>
                Jetzt abrufen
              </Button>
            )}
          </div>
          <Switch
            checked={v.enabled}
            onChange={(x) => (x ? save(true) : save(false))}
            label="Abruf eingeschaltet"
            description="Einschalten erst nach erfolgreichem Verbindungstest mit genau diesen Angaben. Beim ersten Abruf werden nur Mails der letzten 24 Stunden übernommen."
          />
        </div>
      </Card>
      <Card title="Empfangsprotokoll" subtitle={`Jede abgerufene Mail mit Entscheidung – ${q.data!.retentionDays} Tage aufbewahrt (Einstellungen → Datenschutz → Empfangsprotokoll).`}>
        {logs.data && !logs.data.length ? (
          <EmptyState icon="Inbox" title="Noch nichts abgerufen" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Zeit</Th>
                <Th>Ergebnis</Th>
                <Th>Mail</Th>
                <Th className="hidden md:table-cell">Hinweis</Th>
              </tr>
            </thead>
            <tbody>
              {(logs.data ?? []).map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap">{fmtDateTime(l.at)}</Td>
                  <Td>
                    <Badge tone={OUTCOME[l.outcome]?.tone ?? 'neutral'}>{OUTCOME[l.outcome]?.label ?? l.outcome}</Badge>
                  </Td>
                  <Td>
                    <div className="truncate max-w-[320px]">{l.request_id ? <Link to={`/presse/${l.request_id}`}>{l.subject || l.case_no}</Link> : l.subject || '–'}</div>
                    <div className="text-meta text-fg-muted truncate max-w-[320px]">{l.from_address}</div>
                  </Td>
                  <Td className="hidden md:table-cell text-meta text-fg-muted">{String(l.detail).replace(/^graph:\S+$/, '')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
