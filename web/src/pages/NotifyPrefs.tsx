import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../api/client';
import { Badge, Button, Notice, SkeletonRows } from '../components/ui/core';
import { useErrorToast, useToast } from '../components/ui/overlays';
import { HelpTip } from '../components/ui/HelpTip';
import { Icon } from '../components/ui/Icon';
import { fmtRelative, plural } from '../lib/format';
import { usePwaInstall } from '../lib/pwa';
import { Link } from 'react-router';
import { LoadError, SectionCard } from './admin/shared';

type Channel = 'push' | 'mail';
interface Prefs {
  /** je Art: Glocke (bell, außer bellLocked abschaltbar), Push und E-Mail (#253: eine Matrix statt zweier Abschnitte) */
  categories: { id: string; label: string; description: string; group: string; channels: Channel[]; chosen: Channel[]; bell: boolean; bellLocked: boolean }[];
  channels: { push: boolean; mail: boolean };
  email: string;
  subscriptions: { id: string; label: string; created_at: string; last_success_at: string | null; last_error: string | null; last_error_at: string | null; endpoint_hash: string }[];
  vapidPublicKey: string | null;
}

const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function sha16(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

const COLUMN = { bell: 'Glocke', push: 'Push', mail: 'E-Mail' } as const;

/** Ein Feld der Matrix: Kontrollkästchen mit 40 px großer Fläche (Touch-Ziel) und vollständiger Beschriftung für Hilfsmittel. */
function MatrixBox({ label, checked, disabled, title, onChange }: { label: string; checked: boolean; disabled?: boolean; title?: string; onChange: (on: boolean) => void }) {
  return (
    <label className={'inline-flex w-10 h-10 items-center justify-center rounded-control ' + (disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-raised')} title={title}>
      <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * „Mein Konto → Benachrichtigungen“ (#191, #253): eine Matrix je Art mit Glocke, Push und E-Mail; Push auf diesem Gerät,
 * weitere Geräte, Testnachricht. Die Glocke ersetzt den früheren Abschnitt „Benachrichtigungen: Medien“.
 */
export function NotifyPrefsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['notify-prefs'], queryFn: () => get<Prefs>('/notify/preferences') });
  const [busy, setBusy] = useState<string | null>(null);
  const [thisHash, setThisHash] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(pushSupported() ? Notification.permission : 'unsupported');
  const refresh = () => qc.invalidateQueries({ queryKey: ['notify-prefs'] });
  const { installed } = usePwaInstall();

  // Abo dieses Browsers erkennen (Kennwert der Adresse, die Adresse selbst gibt der Server nie aus)
  useEffect(() => {
    if (!pushSupported()) return;
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setThisHash(sub ? await sha16(sub.endpoint) : null);
    }).catch(() => {});
  }, [q.data]);

  if (q.isLoading) return <SectionCard id="benachrichtigungen" title="Benachrichtigungen"><SkeletonRows rows={4} /></SectionCard>;
  if (q.error || !q.data) return <SectionCard id="benachrichtigungen" title="Benachrichtigungen"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  const d = q.data;
  const thisDevice = d.subscriptions.find((s) => s.endpoint_hash === thisHash);

  const choose = async (id: string, list: Channel[]) => {
    // Sofort anzeigen (auch bei schnellem Umschalten nacheinander), danach mit dem Server abgleichen
    qc.setQueryData<Prefs>(['notify-prefs'], (old) => (old ? { ...old, categories: old.categories.map((c) => (c.id === id ? { ...c, chosen: list } : c)) } : old));
    try {
      await put('/notify/preferences', { choices: { [id]: list } });
      refresh();
    } catch (e) {
      onError(e);
    }
  };
  const bell = async (id: string, on: boolean) => {
    qc.setQueryData<Prefs>(['notify-prefs'], (old) => (old ? { ...old, categories: old.categories.map((c) => (c.id === id ? { ...c, bell: on } : c)) } : old));
    try {
      await put('/notify/preferences', { bell: { [id]: on } });
      refresh();
      // Glocke und Zähler sofort ohne die abgeschaltete Art
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      onError(e);
    }
  };

  const enablePush = async () => {
    if (!d.vapidPublicKey) return;
    setBusy('enable');
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') throw new Error('Benachrichtigungen sind für diese Seite im Browser blockiert. Bitte in den Website-Einstellungen des Browsers erlauben.');
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // Abo mit einem anderen (älteren) Schlüssel ersetzen
      const key = keyBytes(d.vapidPublicKey);
      const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (sub && (!current || current.length !== key.length || current.some((b, i) => b !== key[i]))) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await post('/notify/push/subscriptions', { subscription: sub.toJSON(), label: browserLabel() });
      toast({ tone: 'success', title: 'Push auf diesem Gerät eingeschaltet' });
      refresh();
    } catch (e) {
      onError(e, 'Push konnte nicht eingeschaltet werden');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, isThis: boolean) => {
    setBusy(id);
    try {
      await del(`/notify/push/subscriptions/${id}`);
      if (isThis) {
        const reg = await navigator.serviceWorker.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
      }
      toast({ tone: 'success', title: 'Gerät entfernt' });
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      const r = await post<{ results: { label: string; status: string; error?: string }[] }>('/notify/push/test', {});
      const failed = r.results.filter((x) => x.status !== 'sent');
      if (failed.length) toast({ tone: 'error', title: 'Nicht alle Geräte erreicht', text: failed.map((f) => `${f.label}: ${f.error ?? f.status}`).join(' · ') });
      else toast({ tone: 'success', title: `Testnachricht an ${plural(r.results.length, 'Gerät', 'Geräte')} gesendet` });
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      id="benachrichtigungen"
      title="Benachrichtigungen"
      description="Je Art: in der Glocke, per Push auf die eigenen Geräte und per E-Mail. Angeboten werden nur Arten, für die das Konto Rechte hat."
      action={
        <HelpTip title="Push und E-Mail" more="/hilfe/benachrichtigungen">
          <p className="m-0">Push erscheint auch bei geschlossener App als Mitteilung des Geräts – je Browser bzw. installierter App einmal einschalten. E-Mails gehen an {d.email || 'die Adresse des Kontos'}.</p>
        </HelpTip>
      }
      bodyClassName="flex flex-col gap-5"
    >
      {/* Dieses Gerät */}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">Push auf diesem Gerät</h3>
        {!d.channels.push ? (
          <Notice icon="PowerOff">Push-Benachrichtigungen sind von der Administration abgeschaltet.</Notice>
        ) : permission === 'unsupported' ? (
          <Notice icon="Smartphone">Dieser Browser unterstützt keine Push-Benachrichtigungen. Auf iPhone und iPad funktionieren sie nur in der installierten App (Teilen → „Zum Home-Bildschirm“, ab iOS 16.4).</Notice>
        ) : thisDevice ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="success">Eingeschaltet</Badge>
            <Button size="sm" icon="Send" loading={busy === 'test'} onClick={test}>Testnachricht senden</Button>
            <Button size="sm" variant="ghost" icon="PowerOff" loading={busy === thisDevice.id} onClick={() => remove(thisDevice.id, true)}>Ausschalten</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon="Bell" loading={busy === 'enable'} onClick={enablePush}>Push einschalten</Button>
            {permission === 'denied' && <span className="text-meta text-err">Im Browser blockiert – bitte in den Website-Einstellungen erlauben.</span>}
          </div>
        )}
        {!installed && (
          <p className="m-0 text-meta text-fg-muted flex items-center gap-1.5">
            <Icon name="Monitor" size={14} className="shrink-0" />
            <span>
              Benachrichtigungen auch am Desktop: <Link to="/app#desktop">App installieren</Link> – eigenes Fenster, Mitteilungen des Betriebssystems und Zähler am App-Symbol.
            </span>
          </p>
        )}
      </div>

      {/* Weitere Geräte */}
      {d.subscriptions.filter((s) => s.endpoint_hash !== thisHash).length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Weitere Geräte</h3>
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line border border-line rounded-control">
            {d.subscriptions
              .filter((s) => s.endpoint_hash !== thisHash)
              .map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Icon name="Smartphone" size={16} className="text-fg-muted shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-meta text-fg-muted">
                      {s.last_error && (!s.last_success_at || (s.last_error_at && s.last_error_at > s.last_success_at)) ? `Zuletzt nicht erreicht: ${s.last_error}` : s.last_success_at ? `Zuletzt zugestellt ${fmtRelative(s.last_success_at)}` : `Eingerichtet ${fmtRelative(s.created_at)}`}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" icon="Trash2" loading={busy === s.id} onClick={() => remove(s.id, false)}>Entfernen</Button>
                </li>
              ))}
          </ul>
          {!thisDevice && <div><Button size="sm" icon="Send" loading={busy === 'test'} onClick={test}>Testnachricht an alle Geräte</Button></div>}
        </div>
      )}

      {/* Arten: eine Matrix (#253) */}
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-semibold">Arten</h3>
        {!d.channels.mail && <p className="m-0 text-meta text-fg-muted">E-Mail ist nicht verfügbar (Versand nicht eingerichtet oder abgeschaltet).</p>}
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Benachrichtigungen je Art: Glocke, Push und E-Mail</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left text-meta font-medium text-fg-muted py-2 pr-2 border-b border-line">
                Art
              </th>
              {(['bell', 'push', 'mail'] as const).map((k) => (
                <th key={k} scope="col" className="w-12 sm:w-16 text-center text-meta font-medium text-fg-muted py-2 border-b border-line">
                  {COLUMN[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.categories.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-b-0 align-top">
                <th scope="row" className="text-left font-normal py-2.5 pr-2">
                  <span className="block text-sm font-medium">{c.label}</span>
                  <span className="block text-meta text-fg-muted">{c.description}</span>
                </th>
                <td className="text-center py-1">
                  <MatrixBox label={`Glocke: ${c.label}`} checked={c.bell} disabled={c.bellLocked} title={c.bellLocked ? 'Immer in der Glocke' : undefined} onChange={(on) => void bell(c.id, on)} />
                </td>
                {(['push', 'mail'] as const).map((ch) => (
                  <td key={ch} className="text-center py-1">
                    {c.channels.includes(ch) ? (
                      <MatrixBox label={`${COLUMN[ch]}: ${c.label}`} checked={c.chosen.includes(ch)} disabled={!d.channels[ch]} onChange={(on) => void choose(c.id, on ? [...c.chosen, ch] : c.chosen.filter((x) => x !== ch))} />
                    ) : (
                      <span className="inline-flex w-10 h-10 items-center justify-center text-fg-muted" title={ch === 'mail' ? 'E-Mail regeln die Sicherheitseinstellungen' : undefined}>
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">{COLUMN[ch]} nicht wählbar</span>
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="m-0 text-meta text-fg-muted">Sicherheitsmeldungen und Meldungen zum eigenen Konto erscheinen immer in der Glocke.</p>
      </div>
    </SectionCard>
  );
}
