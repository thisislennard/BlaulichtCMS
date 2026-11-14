/**
 * Fortsetzbarer Upload in Teilen (8 MB). Bei Verbindungsabbruch wird der Stand beim Server
 * abgefragt und ab dort weitergesendet – bis zu 8 Versuche mit wachsender Wartezeit.
 * Der Client-Schlüssel sorgt dafür, dass eine Datei nie doppelt angelegt wird.
 */
export interface UploadResult {
  duplicate: boolean;
}

export class UploadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function xhr(method: string, url: string, body: Blob | string | null, contentType: string | null, onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.setRequestHeader('x-lifelink-request', '1');
    if (contentType) x.setRequestHeader('content-type', contentType);
    x.timeout = 10 * 60_000;
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* keine JSON-Antwort */
      }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(Object.assign(new UploadError(data?.message ?? `Fehler ${x.status}`, x.status), { details: data?.details }));
    };
    x.onerror = () => reject(new UploadError('Verbindung unterbrochen.', 0));
    x.ontimeout = () => reject(new UploadError('Zeitüberschreitung.', 0));
    signal?.addEventListener('abort', () => x.abort());
    x.onabort = () => reject(new UploadError('Abgebrochen.', -1));
    x.send(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Fehler, bei denen ein erneuter Versuch sinnvoll ist (Netz, Server kurz weg, Teil passt nicht). */
const retryable = (e: any) => e?.status === 0 || e?.status === 409 || e?.status >= 500 || e?.status === 429;

export async function uploadResumable(
  base: string,
  file: File,
  opts: { clientKey: string; note?: string; onProgress?: (percent: number) => void; signal?: AbortSignal },
): Promise<UploadResult> {
  const session = await xhr('POST', base, JSON.stringify({ clientKey: opts.clientKey, name: file.name, size: file.size, type: file.type, note: opts.note ?? '' }), 'application/json');
  if (session.complete) {
    opts.onProgress?.(100);
    return { duplicate: !!session.duplicate };
  }
  const chunk = session.chunkSize ?? 8 * 1024 * 1024;
  let offset: number = session.received ?? 0;
  let attempt = 0;
  for (;;) {
    if (offset >= file.size) break;
    const end = Math.min(file.size, offset + chunk);
    try {
      const r = await xhr('PUT', `${base}/${session.id}?offset=${offset}`, file.slice(offset, end), 'application/octet-stream', (loaded) => opts.onProgress?.(Math.min(99, Math.round(((offset + loaded) / file.size) * 100))), opts.signal);
      offset = r.received;
      attempt = 0;
      opts.onProgress?.(Math.min(99, Math.round((offset / file.size) * 100)));
      if (r.complete) {
        opts.onProgress?.(100);
        return { duplicate: !!r.duplicate };
      }
    } catch (e: any) {
      if (e?.status === -1 || !retryable(e) || ++attempt > 8) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      // Tatsächlichen Stand beim Server abfragen
      try {
        const st = await xhr('GET', `${base}/${session.id}`, null, null);
        if (st.complete) {
          opts.onProgress?.(100);
          return { duplicate: false };
        }
        offset = st.received;
      } catch {
        /* nächster Versuch */
      }
    }
  }
  return { duplicate: false };
}

/** Stabiler Client-Schlüssel je Datei und Seite (überlebt kein Neuladen, verhindert aber Doppelanlagen beim Wiederholen). */
export function newClientKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
