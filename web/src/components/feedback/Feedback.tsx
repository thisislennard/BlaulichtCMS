import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { Button, cx } from '../ui/core';
import { Icon } from '../ui/Icon';
import { CopyButton } from '../ui/overlays';

/*
 * Rückmeldeseiten (#194): warum etwas nicht lädt und was zu tun ist – mit Symbol, kurzer Erklärung und Aktionen.
 * Dieselben Zustände an jeder Stelle: Seite (FeedbackPage), Bereich in einer Seite (FeedbackView compact) und als
 * Text für Ladefehler (feedbackFor). Farben nur über Tokens, Fehler immer mit Symbol und Text (design-leitstand.md).
 */

export type FeedbackKind = 'timeout' | 'session' | 'offline' | 'unreachable' | 'forbidden' | 'notfound' | 'maintenance' | 'ratelimit' | 'error';

interface KindDef {
  icon: string;
  tone: 'warn' | 'err' | 'muted';
  title: string;
  text: string;
  steps: string[];
}

export const FEEDBACK: Record<FeedbackKind, KindDef> = {
  timeout: {
    icon: 'TimerOff',
    tone: 'warn',
    title: 'Zeitüberschreitung',
    text: 'Der Server hat nicht rechtzeitig geantwortet. Meist ist die Verbindung gerade langsam oder der Server stark ausgelastet.',
    steps: ['Erneut versuchen.', 'Bei einer Änderung zuerst neu laden und prüfen, ob sie schon gespeichert wurde.', 'Bleibt es dabei: Systemstatus prüfen oder die Administration informieren.'],
  },
  session: {
    icon: 'LogIn',
    tone: 'muted',
    title: 'Sitzung abgelaufen',
    text: 'Aus Sicherheitsgründen wurdest du nach längerer Inaktivität abgemeldet.',
    steps: ['Erneut anmelden – danach geht es auf derselben Seite weiter.', 'Nicht gespeicherte Eingaben bitte erneut eintragen.'],
  },
  offline: {
    icon: 'WifiOff',
    tone: 'warn',
    title: 'Keine Internetverbindung',
    text: 'Dieses Gerät ist offline. Aktionen gelten erst, wenn der Server sie bestätigt hat.',
    steps: ['WLAN oder mobile Daten prüfen.', 'Sobald die Verbindung zurück ist, wird automatisch neu geladen.'],
  },
  unreachable: {
    icon: 'ServerOff',
    tone: 'warn',
    title: 'Server nicht erreichbar',
    text: 'BlaulichtCMS antwortet gerade nicht. Häufig läuft ein Neustart oder ein Update – das dauert etwa eine Minute.',
    steps: ['Kurz warten – es wird automatisch erneut versucht.', 'Bleibt es länger so: die Administration informieren (Server, Proxy, Container).'],
  },
  forbidden: {
    icon: 'Lock',
    tone: 'muted',
    title: 'Kein Zugriff',
    text: 'Für diesen Bereich fehlt dir die Berechtigung.',
    steps: ['Eine Person mit dem Recht, Rollen zuzuweisen, um das passende Recht bitten.', 'Über die Navigation zu einem anderen Bereich wechseln.'],
  },
  notfound: {
    icon: 'FileQuestionMark',
    tone: 'muted',
    title: 'Seite nicht gefunden',
    text: 'Diese Adresse gibt es nicht (mehr) oder der Eintrag wurde gelöscht.',
    steps: ['Den Link prüfen.', 'Über die Startseite oder die Suche (Strg K) weitergehen.'],
  },
  maintenance: {
    icon: 'Wrench',
    tone: 'warn',
    title: 'Wartung oder Update läuft',
    text: 'Änderungen sind kurz nicht möglich. Ansehen funktioniert weiterhin.',
    steps: ['Ein paar Minuten warten und die Aktion dann wiederholen.', 'Den Wartungsmodus beendet die Administration im Systemstatus.'],
  },
  ratelimit: {
    icon: 'Hourglass',
    tone: 'warn',
    title: 'Zu viele Versuche',
    text: 'Zum Schutz vor Missbrauch sind kurz keine weiteren Versuche möglich.',
    steps: ['Die angegebene Zeit abwarten und dann erneut versuchen.', 'Bei der Anmeldung das Passwort sorgfältig prüfen – nach mehreren Fehlversuchen wird das Konto vorübergehend gesperrt.'],
  },
  error: {
    icon: 'Bug',
    tone: 'err',
    title: 'Unerwarteter Fehler',
    text: 'Etwas ist schiefgelaufen. Die Details helfen der Administration bei der Suche.',
    steps: ['Die Seite neu laden.', 'Tritt der Fehler wieder auf: Details kopieren und an die Administration weitergeben.'],
  },
};

export interface Feedback {
  kind: FeedbackKind;
  /** Technische Angaben (Status, Code, Meldung) für „Details“. */
  details?: string;
  /** Sekunden bis zum nächsten Versuch (429). */
  retryAfter?: number | null;
  /** Fachliche Meldung des Servers, wenn sie mehr sagt als der Standardtext. */
  message?: string;
}

/** Fehler einer Anfrage einem Zustand zuordnen. */
export function feedbackFor(error: unknown): Feedback {
  const e = error as ApiError | Error | null;
  const status = (e as ApiError)?.status;
  const code = (e as ApiError)?.code;
  const details = e ? `${status ?? ''} ${code ?? ''} ${e.message}`.trim() : undefined;
  if (code === 'timeout') return { kind: 'timeout', details };
  if (code === 'offline') return { kind: 'offline', details };
  if (code === 'unreachable' || status === 502 || status === 504) return { kind: 'unreachable', details };
  if (code === 'maintenance' || status === 503) return { kind: 'maintenance', details, message: e?.message };
  if (status === 401) return { kind: 'session', details };
  if (status === 403 && code !== 'reauth_required') return { kind: 'forbidden', details, message: e?.message };
  if (status === 404) return { kind: 'notfound', details, message: e?.message };
  if (status === 429) return { kind: 'ratelimit', details, retryAfter: (e as ApiError).details?.retryAfter ?? null };
  return { kind: 'error', details, message: status && status < 500 ? e?.message : undefined };
}

/** Sichtbarer Text eines Ladefehlers (für bestehende Fehlerkästen). */
export function feedbackText(error: unknown): { title: string; text: string } {
  const f = feedbackFor(error);
  const d = FEEDBACK[f.kind];
  return { title: d.title, text: f.message && f.kind !== 'error' ? f.message : f.message ?? d.text };
}

/** Rückwärtszähler für Wartezeiten (Sekunden). */
export function useCountdown(seconds: number | null | undefined) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const end = Date.now() + seconds * 1000;
    const t = setInterval(() => {
      const l = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(l);
      if (!l) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [seconds]);
  return left;
}

export function fmtWait(s: number) {
  return s >= 90 ? `${Math.ceil(s / 60)} Minuten` : `${s} ${s === 1 ? 'Sekunde' : 'Sekunden'}`;
}

/**
 * Rückmeldung mit Symbol, Erklärung, „Was tun?“ und Aktionen. `autoRetry` versucht es in Abständen selbst (Server
 * nicht erreichbar, offline, Wartung); `onRetry` liefert den Knopf „Erneut versuchen“.
 */
export function FeedbackView({
  kind,
  details,
  retryAfter,
  message,
  onRetry,
  autoRetry,
  actions,
  compact,
  title,
}: Feedback & { onRetry?: () => void; autoRetry?: boolean; actions?: ReactNode; compact?: boolean; title?: string }) {
  const d = FEEDBACK[kind];
  const [showDetails, setShowDetails] = useState(false);
  const wait = useCountdown(retryAfter);
  // Automatisch erneut versuchen: 5, 10, 20, 30 s …; bei „wieder online“ sofort
  const [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  useEffect(() => {
    if (!autoRetry || !onRetry) return;
    const delay = Math.min(30, 5 * 2 ** attempt);
    setNext(delay);
    const started = Date.now();
    const tick = setInterval(() => setNext(Math.max(0, delay - Math.floor((Date.now() - started) / 1000))), 1000);
    const t = setTimeout(() => {
      setAttempt((a) => a + 1);
      onRetry();
    }, delay * 1000);
    const online = () => onRetry();
    window.addEventListener('online', online);
    return () => {
      clearTimeout(t);
      clearInterval(tick);
      window.removeEventListener('online', online);
    };
    // onRetry ist meist eine Inline-Funktion – nur Versuch und Schalter steuern den Zeitplan
  }, [autoRetry, attempt]);
  const tone = { warn: 'text-warn', err: 'text-err', muted: 'text-fg-muted' }[d.tone];
  return (
    <section role={kind === 'error' ? 'alert' : 'status'} aria-live="polite" className={cx('flex flex-col items-start gap-3 text-left', compact ? 'py-6' : 'py-10 md:py-16 max-w-[560px]')} data-feedback={kind}>
      <span className={cx('w-12 h-12 rounded-node bg-raised border border-line inline-flex items-center justify-center', tone)}>
        <Icon name={d.icon} size={24} />
      </span>
      <h2 className="m-0 text-title font-semibold">{title ?? d.title}</h2>
      <p className="m-0 text-fg-muted">
        {kind === 'ratelimit' && wait > 0 ? `${d.text} Bitte noch ${fmtWait(wait)} warten.` : message && kind !== 'error' && kind !== 'maintenance' ? message : d.text}
      </p>
      {kind === 'maintenance' && message && <p className="m-0 text-sm text-fg-muted">{message}</p>}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">Was tun?</span>
        <ol className="m-0 pl-5 list-decimal text-sm flex flex-col gap-1">
          {d.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {onRetry && (
          <Button variant={actions ? 'secondary' : 'primary'} icon="RefreshCw" disabled={kind === 'ratelimit' && wait > 0} onClick={() => (setAttempt(0), onRetry())}>
            Erneut versuchen
          </Button>
        )}
        {actions}
      </div>
      {autoRetry && onRetry && next != null && <p className="m-0 text-meta text-fg-muted font-mono">Nächster Versuch automatisch in {next} s</p>}
      {details && (
        <div className="flex flex-col gap-1.5 w-full">
          <div className="flex items-center gap-3">
            <button type="button" className="text-meta text-fg-muted underline" aria-expanded={showDetails} onClick={() => setShowDetails((x) => !x)}>
              {showDetails ? 'Details ausblenden' : 'Details anzeigen'}
            </button>
            {showDetails && <CopyButton size="sm" value={details} label="Details kopieren" />}
          </div>
          {showDetails && <pre className="m-0 p-3 rounded-control bg-raised border border-line text-[12px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">{details}</pre>}
        </div>
      )}
    </section>
  );
}

/** Ganze Seite (ohne App-Rahmen): Start ohne Server, Fehler außerhalb der Navigation. */
export function FeedbackPage(props: Parameters<typeof FeedbackView>[0]) {
  return (
    <div className="min-h-screen bg-bg text-fg flex justify-center px-4">
      <main id="main" className="w-full max-w-[560px] pt-[8vh]">
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">BlaulichtCMS</span>
        <FeedbackView {...props} />
      </main>
    </div>
  );
}

/** Nach einem Update fehlen alte Programmteile: dann neu laden statt Fehlerseite. */
export function isChunkError(e: unknown) {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(String((e as Error)?.message ?? e));
}

/**
 * Einmal automatisch neu laden, wenn Programmteile der alten Version fehlen (höchstens alle 30 s, damit ein echter
 * Ausfall nicht in einer Neuladeschleife endet). Liefert true, wenn neu geladen wird.
 */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem('bc-chunk-reload') ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem('bc-chunk-reload', String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function errorDetails(error: unknown, info?: string) {
  const e = error as Error;
  return [`${e?.name ?? 'Fehler'}: ${e?.message ?? String(error)}`, `Seite: ${window.location.pathname}`, `Zeit: ${new Date().toISOString()}`, (e?.stack ?? '').split('\n').slice(0, 8).join('\n'), info ?? ''].filter(Boolean).join('\n');
}

/** Darstellung eines Absturzes (Fehlergrenze und Router). */
export function CrashView({ error, info, page }: { error: unknown; info?: string; page?: boolean }) {
  const chunk = isChunkError(error);
  useEffect(() => {
    if (chunk) reloadForNewVersion();
  }, [chunk]);
  const props = {
    kind: 'error' as const,
    title: chunk ? 'Neue Version verfügbar' : undefined,
    message: chunk ? 'BlaulichtCMS wurde aktualisiert. Bitte die Seite neu laden, um die neue Version zu verwenden.' : undefined,
    details: errorDetails(error, info),
    actions: (
      <Button variant="primary" icon="RefreshCw" onClick={() => window.location.reload()}>
        Seite neu laden
      </Button>
    ),
  };
  return page ? <FeedbackPage {...props} /> : <FeedbackView {...props} />;
}

/** React-Fehlergrenze: unerwartete Fehler beim Darstellen fangen (statt weißer Seite). */
export class ErrorBoundary extends Component<{ children: ReactNode; page?: boolean }, { error: unknown; info?: string }> {
  state: { error: unknown; info?: string } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(_error: unknown, info: ErrorInfo) {
    this.setState({ info: info.componentStack?.split('\n').slice(0, 6).join('\n') });
  }
  render() {
    if (this.state.error) return <CrashView error={this.state.error} info={this.state.info} page={this.props.page} />;
    return this.props.children;
  }
}
