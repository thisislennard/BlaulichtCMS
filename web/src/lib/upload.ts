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
    x.setRequestHeader('x-blaulichtcms-request', '1');
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
    if (signal?.aborted) return reject(new UploadError('Abgebrochen.', -1));
    signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.onabort = () => reject(new UploadError('Abgebrochen.', -1));
    x.send(body);
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadError('Abgebrochen.', -1));
    const t = setTimeout(() => (signal?.removeEventListener('abort', onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(t), reject(new UploadError('Abgebrochen.', -1)));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
/** Fehler, bei denen ein erneuter Versuch sinnvoll ist (Netz, Server kurz weg, Teil passt nicht). */
const retryable = (e: any) => e?.status === 0 || e?.status === 409 || e?.status >= 500 || e?.status === 429;
const MAX_ATTEMPTS = 8;

export async function uploadResumable(
  base: string,
  file: File,
  opts: { clientKey: string; note?: string; ref?: string; onProgress?: (percent: number) => void; signal?: AbortSignal },
): Promise<UploadResult> {
  const { signal } = opts;
  const checkAbort = () => {
    if (signal?.aborted) throw new UploadError('Abgebrochen.', -1);
  };
  // Leere Dateien (z. B. abgebrochene Kameraaufnahme) gar nicht erst senden – klare Meldung statt Prüffehler
  if (file.size === 0) throw new UploadError('Die Datei ist leer.', 400);
  // Sitzung anlegen – bei Netzfehlern wiederholen (der Client-Schlüssel verhindert Doppelanlagen)
  let session: any;
  for (let attempt = 1; ; attempt++) {
    checkAbort();
    try {
      session = await xhr('POST', base, JSON.stringify({ clientKey: opts.clientKey, name: file.name, size: file.size, type: file.type, note: opts.note ?? '', ...(opts.ref ? { ref: opts.ref } : {}) }), 'application/json', undefined, signal);
      break;
    } catch (e: any) {
      if (e?.status === -1 || !retryable(e) || attempt >= MAX_ATTEMPTS) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)), signal);
    }
  }
  if (session.complete) {
    opts.onProgress?.(100);
    return { duplicate: !!session.duplicate };
  }
  const chunk = session.chunkSize ?? 8 * 1024 * 1024;
  let offset: number = session.received ?? 0;
  let attempt = 0;
  // Erfolg gibt es nur mit „complete“ vom Server. Sind alle Bytes angekommen, aber der Abschluss noch nicht bestätigt
  // (Antwort verloren, Abschluss fehlgeschlagen), stößt ein leerer Teil am Ende den Abschluss erneut an.
  for (;;) {
    checkAbort();
    const end = Math.min(file.size, offset + chunk);
    try {
      const r = await xhr('PUT', `${base}/${session.id}?offset=${offset}`, file.slice(offset, end), 'application/octet-stream', (loaded) => opts.onProgress?.(Math.min(99, Math.round(((offset + loaded) / file.size) * 100))), signal);
      if (r.complete) {
        opts.onProgress?.(100);
        return { duplicate: !!r.duplicate };
      }
      if (r.received <= offset && end > offset) throw new UploadError('Der Server hat den Teil nicht übernommen.', 0);
      offset = r.received;
      attempt = 0;
      opts.onProgress?.(Math.min(99, Math.round((offset / file.size) * 100)));
    } catch (e: any) {
      if (e?.status === -1 || !retryable(e) || ++attempt > MAX_ATTEMPTS) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)), signal);
      // Tatsächlichen Stand beim Server abfragen
      try {
        const st = await xhr('GET', `${base}/${session.id}`, null, null, undefined, signal);
        if (st.complete) {
          opts.onProgress?.(100);
          return { duplicate: false };
        }
        offset = st.received;
      } catch (e2: any) {
        if (e2?.status === -1) throw e2;
        /* nächster Versuch */
      }
    }
  }
}

/** Stabiler Client-Schlüssel je Datei und Seite (überlebt kein Neuladen, verhindert aber Doppelanlagen beim Wiederholen). */
export function newClientKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
