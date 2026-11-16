/** Fetch-Hülle für die BlaulichtCMS-API. Ändernde Anfragen tragen den CSRF-Header. */
export class ApiError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/**
 * Kritische Aktionen verlangen eine frische Passwortbestätigung (Antwort 403 „reauth_required“). Der Handler fragt
 * Passwort/Code ab (Dialog) und liefert true, wenn bestätigt wurde – dann wird die Anfrage einmal wiederholt.
 */
let onReauth: (() => Promise<boolean>) | null = null;
export function setReauthHandler(fn: (() => Promise<boolean>) | null) {
  onReauth = fn;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Verbindungszustand (#194): Netzfehler, Zeitüberschreitungen, nicht erreichbarer Server (Proxy 502/503/504) und der
 * Wartungsmodus werden gemeldet; jede erfolgreiche Antwort meldet „verbunden“. Die Statusleiste (ConnectionStatus)
 * zeigt daraus eine verständliche Rückmeldung mit automatischem erneuten Versuch.
 */
export type ConnectionState = { state: 'ok' } | { state: 'down'; kind: 'offline' | 'unreachable' | 'timeout' } | { state: 'maintenance'; message: string };
const listeners = new Set<(s: ConnectionState) => void>();
export function onConnectionChange(fn: (s: ConnectionState) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function report(s: ConnectionState) {
  for (const l of listeners) l(s);
}

/** Zeitlimits: Lesen 30 s, Ändern 120 s (Sicherungen, Testläufe), Dateiuploads ohne Limit. */
export const TIMEOUT_READ_MS = 30_000;
export const TIMEOUT_WRITE_MS = 120_000;

export interface ApiOptions {
  raw?: boolean;
  signal?: AbortSignal;
  retried?: boolean;
  /** Eigenes Zeitlimit in ms (0 = keins). */
  timeout?: number;
}

/** Fehler ohne Antwort des Servers in verständliche ApiErrors übersetzen (Status 0). */
function networkError(e: unknown, timedOut: boolean): ApiError {
  if (timedOut) return new ApiError(0, 'timeout', 'Zeitüberschreitung: Der Server hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new ApiError(0, 'offline', 'Keine Internetverbindung. Bitte die Verbindung prüfen.');
  return new ApiError(0, 'unreachable', 'Server nicht erreichbar. Bitte kurz warten und erneut versuchen.', { cause: (e as Error)?.message });
}

export async function api<T = any>(method: Method, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (method !== 'GET') headers['x-blaulichtcms-request'] = '1';
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  // Zeitlimit per AbortController (statt endlos drehender Ladeanzeige); ein eigenes Abbruchsignal bleibt wirksam
  const limit = opts.timeout ?? (body instanceof FormData ? 0 : method === 'GET' ? TIMEOUT_READ_MS : TIMEOUT_WRITE_MS);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = limit ? setTimeout(() => ((timedOut = true), ctrl.abort()), limit) : undefined;
  const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let res!: Response;
  let text = '';
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: ctrl.signal });
    if (!opts.raw) text = await res.text();
  } catch (e) {
    // Abbruch durch den Aufrufer (z. B. Seitenwechsel) unverändert weitergeben
    if (opts.signal?.aborted && !timedOut) throw e;
    const err = networkError(e, timedOut);
    report({ state: 'down', kind: err.code as 'offline' | 'unreachable' | 'timeout' });
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
  if (opts.raw) return res as unknown as T;
  let data: any = null;
  let json = true;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keine JSON-Antwort: meist eine Fehlerseite des Proxys – nie als Meldung anzeigen
    json = false;
  }
  if (!res.ok) {
    if (res.status === 403 && data?.error === 'reauth_required' && onReauth && !opts.retried && !(body instanceof FormData)) {
      if (await onReauth()) return api<T>(method, path, body, { ...opts, retried: true });
    }
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/')) onUnauthorized();
    if (res.status === 503 && data?.error === 'maintenance') report({ state: 'maintenance', message: data.message });
    else if ([502, 503, 504].includes(res.status) && !json) {
      report({ state: 'down', kind: 'unreachable' });
      throw new ApiError(res.status, 'unreachable', 'Server nicht erreichbar (Neustart oder Update?). Bitte kurz warten und erneut versuchen.');
    } else report({ state: 'ok' });
    let details = data?.details;
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after')) || Number(details?.retryAfter) || null;
      details = { ...(details ?? {}), retryAfter: ra };
    }
    throw new ApiError(res.status, data?.error ?? (res.status === 429 ? 'rate_limited' : 'error'), data?.message ?? `Fehler ${res.status}`, details);
  }
  report({ state: 'ok' });
  return data as T;
}

export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>('GET', p, undefined, { signal });
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = any>(p: string, b?: unknown) => api<T>('DELETE', p, b ?? {});

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Dateidownload über einen versteckten Link (Cookie-Auth gilt auch hier). */
export function download(path: string) {
  const a = document.createElement('a');
  a.href = `/api/v1${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
