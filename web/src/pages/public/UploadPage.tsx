import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, get } from '../../api/client';
import { Button, cx, Notice, Spinner, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { fmtBytes, fmtDateTime } from '../../lib/format';

interface LinkInfo {
  collection: { title: string; purpose: string; note: string };
  organization: string;
  expires_at: string;
  max_file_bytes: number;
  remaining_files: number;
  accept: string;
}

type ItemState = 'waiting' | 'uploading' | 'done' | 'error';
interface Item {
  key: string;
  file: File;
  state: ItemState;
  progress: number;
  error?: string;
  duplicate?: boolean;
}

/** Eine Datei per XHR senden (Fortschritt je Datei). Der Client-Schlüssel verhindert Doppelanlagen beim Wiederholen. */
function sendFile(token: string, item: Item, note: string, onProgress: (p: number) => void): Promise<{ duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('clientKey', item.key);
    if (note) fd.append('note', note);
    fd.append('file', item.file, item.file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/public/upload/${encodeURIComponent(token)}`);
    xhr.setRequestHeader('x-lifelink-request', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* keine JSON-Antwort */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ duplicate: !!data?.duplicate });
      else reject(new Error(data?.message ?? `Fehler ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Verbindung unterbrochen. Bitte erneut senden.'));
    xhr.ontimeout = () => reject(new Error('Zeitüberschreitung. Bitte erneut senden.'));
    xhr.send(fd);
  });
}

export function UploadPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Fotos und Videos hochladen';
    get<LinkInfo>(`/public/upload/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e: ApiError) =>
        setError({
          title: e.status === 410 ? 'Link nicht mehr gültig' : e.status === 404 ? 'Link ungültig' : 'Fehler',
          text: e.message,
        }),
      );
  }, [token]);

  const update = (key: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const addFiles = (files: FileList | null) => {
    if (!files || !info) return;
    const next: Item[] = [];
    for (const f of Array.from(files)) {
      const tooBig = f.size > info.max_file_bytes;
      next.push({ key: crypto.randomUUID().replace(/-/g, ''), file: f, state: tooBig ? 'error' : 'waiting', progress: 0, error: tooBig ? `Datei ist größer als ${fmtBytes(info.max_file_bytes)}.` : undefined });
    }
    setItems((list) => [...list, ...next]);
  };

  const run = useCallback(
    async (only?: string) => {
      setBusy(true);
      const queue = items.filter((i) => (only ? i.key === only : i.state === 'waiting' || i.state === 'error') && i.file.size <= (info?.max_file_bytes ?? Infinity));
      // Zwei Übertragungen parallel: schneller bei vielen Fotos, schont aber schwache Mobilverbindungen
      const worker = async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          const cur = it;
          update(cur.key, { state: 'uploading', progress: 0, error: undefined });
          try {
            const r = await sendFile(token, cur, note.trim(), (p) => update(cur.key, { progress: p }));
            update(cur.key, { state: 'done', progress: 100, duplicate: r.duplicate });
          } catch (e) {
            update(cur.key, { state: 'error', error: (e as Error).message });
          }
        }
      };
      await Promise.all([worker(), worker()]);
      setBusy(false);
    },
    [items, token, note, info],
  );

  const done = items.filter((i) => i.state === 'done').length;
  const failed = items.filter((i) => i.state === 'error').length;
  const waiting = items.filter((i) => i.state === 'waiting').length;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <main className="max-w-[560px] mx-auto px-4 py-6 flex flex-col gap-5" id="main">
        {!info && !error && (
          <div className="flex items-center gap-2 text-fg-muted py-10 justify-center">
            <Spinner /> Lade …
          </div>
        )}
        {error && (
          <div className="flex flex-col gap-3 py-8">
            <Icon name="Ban" size={36} className="text-err" />
            <h1 className="m-0 text-page font-semibold">{error.title}</h1>
            <p className="m-0 text-fg-muted">{error.text}</p>
          </div>
        )}
        {info && (
          <>
            <header className="flex flex-col gap-1">
              <div className="text-sm text-fg-muted">{info.organization}</div>
              <h1 className="m-0 text-page font-semibold tracking-[-0.02em]">{info.collection.title}</h1>
              {info.collection.purpose && <p className="m-0 text-fg-muted">{info.collection.purpose}</p>}
              <div className="text-sm text-fg-muted">Uploads möglich bis {fmtDateTime(info.expires_at)}</div>
            </header>
            {info.collection.note && <Notice tone="primary">{info.collection.note}</Notice>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button variant="primary" size="md" icon="Camera" className="!h-14 !text-base" onClick={() => cameraRef.current?.click()}>
                Foto aufnehmen
              </Button>
              <Button size="md" icon="Images" className="!h-14 !text-base" onClick={() => inputRef.current?.click()}>
                Dateien auswählen
              </Button>
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
            <input ref={inputRef} type="file" accept={info.accept} multiple className="sr-only" aria-label="Fotos oder Videos auswählen" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Hinweis (optional)</span>
              <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Name für die Bildunterschrift oder Ort der Aufnahme" />
            </label>

            {items.length > 0 && (
              <section aria-label="Ausgewählte Dateien" className="flex flex-col gap-2">
                <ul className="m-0 p-0 list-none flex flex-col gap-2">
                  {items.map((it) => (
                    <li key={it.key} className={cx('border rounded-card p-3 flex flex-col gap-2 bg-card', it.state === 'error' ? 'border-err' : 'border-line')}>
                      <div className="flex items-center gap-3">
                        <Icon name={it.file.type.startsWith('video') ? 'Film' : 'Image'} size={18} className="text-fg-muted shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{it.file.name}</div>
                          <div className="text-meta text-fg-muted">{fmtBytes(it.file.size)}</div>
                        </div>
                        {it.state === 'done' && <span className="text-ok text-sm font-medium flex items-center gap-1"><Icon name="CheckCircle2" size={16} /> Übertragen</span>}
                        {it.state === 'uploading' && <span className="text-sm tabular-nums">{it.progress} %</span>}
                        {it.state === 'error' && (
                          <Button size="sm" icon="RefreshCw" disabled={busy || it.file.size > info.max_file_bytes} onClick={() => run(it.key)}>
                            Erneut senden
                          </Button>
                        )}
                        {it.state === 'waiting' && !busy && (
                          <Button size="sm" iconOnly icon="X" aria-label={`${it.file.name} entfernen`} onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} />
                        )}
                      </div>
                      {(it.state === 'uploading' || it.state === 'done') && (
                        <div className="h-1.5 rounded-full bg-raised overflow-hidden" role="progressbar" aria-valuenow={it.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Fortschritt ${it.file.name}`}>
                          <div className={cx('h-full', it.state === 'done' ? 'bg-ok' : 'bg-primary-solid')} style={{ width: `${it.progress}%` }} />
                        </div>
                      )}
                      {it.error && <div className="text-sm text-err" role="alert">{it.error}</div>}
                    </li>
                  ))}
                </ul>
                <div aria-live="polite" className="text-sm text-fg-muted">
                  {done} von {items.length} übertragen{failed ? ` · ${failed} fehlgeschlagen` : ''}
                </div>
                {(busy || waiting > 0 || failed > 0) && (
                  <Button variant="primary" icon="Upload" className="!h-12 !text-base" disabled={busy} loading={busy} onClick={() => run()}>
                    {failed && !waiting ? 'Fehlgeschlagene erneut senden' : `${waiting} ${waiting === 1 ? 'Datei' : 'Dateien'} senden`}
                  </Button>
                )}
                {done > 0 && !busy && !waiting && !failed && (
                  <Notice tone="success" title="Vielen Dank!">
                    Die Dateien sind angekommen und werden geprüft, bevor sie verwendet werden.
                  </Notice>
                )}
              </section>
            )}
            <p className="m-0 text-meta text-fg-muted">
              Erlaubt sind Fotos und Videos bis {fmtBytes(info.max_file_bytes)} je Datei. Hochgeladene Dateien sehen nur berechtigte Personen der Redaktion. Standortdaten werden aus veröffentlichten Fassungen entfernt.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
