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

export async function api<T = any>(method: Method, path: string, body?: unknown, opts: { raw?: boolean; signal?: AbortSignal; retried?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (method !== 'GET') headers['x-blaulichtcms-request'] = '1';
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    if (res.status === 403 && data?.error === 'reauth_required' && onReauth && !opts.retried && !(body instanceof FormData)) {
      if (await onReauth()) return api<T>(method, path, body, { ...opts, retried: true });
    }
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Fehler ${res.status}`, data?.details);
  }
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
