import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, get, post } from '../../api/client';
import { Button, cx, Input, Notice, Spinner, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { uploadResumable } from '../../lib/upload';
import { DesignedPage, type UploadDesign } from './DesignedPage';
import { LegalLinks } from '../../components/legal/LegalLinks';
import { FeedbackView, feedbackFor, type Feedback } from '../../components/feedback/Feedback';

type FieldMode = 'off' | 'optional' | 'required';

export interface LinkInfo {
  collection: { title: string; purpose: string; note: string };
  /** Begrüßungstext des Links (Vorrang vor dem Hinweis der Sammlung) */
  welcome_text?: string | null;
  /** Knöpfe „Foto aufnehmen“/„Video aufnehmen“ auf Touch-Geräten */
  camera_buttons?: boolean;
  /** eigener Text nach erfolgreichem Upload */
  done_text?: string | null;
  organization: string;
  expires_at: string;
  max_file_bytes: number;
  remaining_files: number;
  accept: string;
  privacy: PrivacyInfo;
  setup_hint?: boolean;
  /** abgefragte Angaben (Paket 6) */
  fields?: Record<'name' | 'email' | 'note' | 'place' | 'date', FieldMode>;
  consent_required?: boolean;
  consent_text?: string;
  max_files_per_upload?: number | null;
  remaining_uploads?: number | null;
  remaining_bytes?: number | null;
  /** erlaubte Typen als Text, z. B. „JPEG, PNG, MP4“ */
  types?: string;
  /** Monate, nach denen Angaben der Hochladenden entfernt werden (0 = keine Frist) */
  uploader_months?: number;
  /** Gestaltung der Seite (Paket 10; Platzhalter schon ersetzt) */
  design?: UploadDesign;
}

interface PrivacyInfo {
  controller: string;
  dpo_contact: string;
  policy_url: string;
  notice: string;
  ip_retention_days: number;
  /** Tage nach Abschluss der Sammlung, nach denen nicht verwendete Dateien gelöscht werden (0 = keine Frist). */
  collection_retention_days?: number;
}

const FIELD_TEXT: Record<string, string> = { name: 'Ihr Name', email: 'Ihre E-Mail-Adresse', place: 'der Aufnahmeort', date: 'das Aufnahmedatum', note: 'Ihr Hinweis' };

/** Was die Upload-Seite erfasst – abhängig von den abgefragten Angaben des Links. */
function collectedText(info: LinkInfo, optionalOnly = false): string {
  const f = info.fields ?? { name: 'off', email: 'off', note: 'optional', place: 'off', date: 'off' };
  const asked = (['name', 'email', 'place', 'date', 'note'] as const).filter((k) => f[k] !== 'off').map((k) => `${FIELD_TEXT[k]}${f[k] === 'optional' && !optionalOnly ? ' (freiwillig)' : ''}`);
  return ['die Dateien mit ihrem Dateinamen', ...asked].join(', ');
}

/** Informationspflichten nach Art. 13 DSGVO – kompakt und immer sichtbar (#96). */
export function PrivacySection({ info }: { info: LinkInfo }) {
  const p = info.privacy;
  const days = p.collection_retention_days ?? 0;
  const f = info.fields;
  const personal = !!f && (['name', 'email', 'place', 'date'] as const).some((k) => f[k] !== 'off');
  return (
    <section aria-labelledby="datenschutz" className="border border-line rounded-card p-3.5 bg-card flex flex-col gap-2 text-sm">
      <h2 id="datenschutz" className="m-0 text-base font-semibold flex items-center gap-2">
        <Icon name="ShieldCheck" size={16} className="text-fg-muted" /> Datenschutz
      </h2>
      <p className="m-0">
        Verantwortlich: {p.controller || info.organization}
        {p.dpo_contact ? <> · Datenschutzbeauftragte/r: {p.dpo_contact}</> : null}
      </p>
      <p className="m-0">
        Ihre Fotos und Videos helfen bei der Berichterstattung zu diesem Anlass. Die Redaktion sichtet jede Datei. Ausgewählte Aufnahmen können auf der Website und in sozialen Medien veröffentlicht werden (z. B. Facebook und Instagram von Meta Platforms; dabei werden Daten auch in die USA übermittelt). Aus veröffentlichten Fassungen werden Standort- und Kameradaten entfernt.
      </p>
      <p className="m-0">
        Erfasst werden {collectedText(info)} und zum Schutz vor Missbrauch Ihre IP-Adresse (wird nach {p.ip_retention_days} Tagen entfernt).
        {personal ? ` Name, E-Mail-Adresse, Aufnahmeort und -datum sieht nur die Redaktion; sie werden ${info.uploader_months ? `nach ${info.uploader_months} Monaten` : 'auf Wunsch'} gelöscht, die Dateien bleiben.` : ''}
        {days > 0 ? ` Nicht veröffentlichte Dateien werden spätestens ${days} Tage nach Abschluss der Sammlung gelöscht.` : ' Nicht mehr benötigte Dateien werden gelöscht.'}
      </p>
      <p className="m-0">Bitte nur eigene Aufnahmen hochladen und keine Verletzten oder erkennbar abgebildeten Unbeteiligten ohne deren Einverständnis.</p>
      <p className="m-0">
        Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Widerspruch sowie das Recht auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde.
        {p.policy_url ? (
          <>
            {' '}Weitere Informationen, auch zur Rechtsgrundlage:{' '}
            <a href={p.policy_url} target="_blank" rel="noopener noreferrer">Datenschutzerklärung</a>
          </>
        ) : null}
      </p>
      {p.notice && <p className="m-0 whitespace-pre-line">{p.notice}</p>}
    </section>
  );
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

/** Vorgangsnummer für Anfragen auf Auskunft oder Löschung (#141): zwei Vierergruppen ohne verwechselbare Zeichen. */
function newUploadRef(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(b, (x) => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function useTouch() {
  // Kameraknöpfe nur auf Touch-Geräten (wie LiFeOS); am Rechner öffnet „capture“ ohnehin nur die Dateiauswahl
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    if (!mq) return;
    const on = () => setTouch(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return touch;
}

/**
 * Upload-Bereich: Auswahl (Galerie groß, Kamera klein), abgefragte Angaben, Bestätigung, Liste mit Fortschritt.
 * `preview`: nur Darstellung (Vorschau der Gestaltung), ohne Übertragung.
 */
export function UploadArea({ info, token, preview, accent }: { info: LinkInfo; token: string; preview?: boolean; accent?: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState('');
  const [who, setWho] = useState({ name: '', email: '', place: '', date: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // eine Vorgangsnummer je Seitenaufruf – gilt für alle Dateien dieses Besuchs
  const [uploadRef] = useState(newUploadRef);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const touch = useTouch();
  const fields = info.fields ?? { name: 'off', email: 'off', note: 'optional', place: 'off', date: 'off' };
  const perUpload = info.max_files_per_upload ?? 0;
  // Akzentfarbe der Gestaltung: nur Werte aus der festen Palette (Tokens), gesetzt über das style-Attribut (CSP erlaubt)
  const accentStyle = accent ? { backgroundColor: `var(--bc-upload-accent-${accent})`, borderColor: `var(--bc-upload-accent-${accent})`, color: 'var(--bc-upload-accent-on)' } : undefined;

  const update = (key: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const addFiles = (files: FileList | null) => {
    if (!files || preview) return;
    const next: Item[] = [];
    for (const f of Array.from(files)) {
      if (perUpload && items.length + next.length >= perUpload) {
        setFormError(`Je Upload sind höchstens ${perUpload} Dateien erlaubt.`);
        break;
      }
      const tooBig = f.size > info.max_file_bytes;
      next.push({ key: crypto.randomUUID().replace(/-/g, ''), file: f, state: tooBig ? 'error' : 'waiting', progress: 0, error: tooBig ? `Datei ist größer als ${fmtBytes(info.max_file_bytes)}.` : undefined });
    }
    setItems((list) => [...list, ...next]);
  };

  /** Pflichtangaben und Bestätigung vor dem Senden prüfen (der Server prüft erneut). */
  const validate = (): string | null => {
    for (const k of ['name', 'email', 'place', 'date'] as const) if (fields[k] === 'required' && !who[k].trim()) return `Bitte ${k === 'name' ? 'Ihren Namen' : k === 'email' ? 'Ihre E-Mail-Adresse' : k === 'place' ? 'den Aufnahmeort' : 'das Aufnahmedatum'} angeben.`;
    if (fields.note === 'required' && !note.trim()) return 'Bitte einen Hinweis angeben.';
    if (who.email && fields.email !== 'off' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(who.email.trim())) return 'Bitte eine gültige E-Mail-Adresse angeben.';
    if (info.consent_required && !consent) return 'Bitte die Bestätigung ankreuzen.';
    return null;
  };

  const run = useCallback(
    async (only?: string) => {
      const problem = validate();
      setFormError(problem);
      if (problem) return;
      setBusy(true);
      const uploader = Object.fromEntries(Object.entries(who).filter(([k, v]) => v.trim() && fields[k as keyof typeof fields] !== 'off').map(([k, v]) => [k, v.trim()]));
      const queue = items.filter((i) => (only ? i.key === only : i.state === 'waiting' || i.state === 'error') && i.file.size <= info.max_file_bytes);
      // Zwei Übertragungen parallel: schneller bei vielen Fotos, schont aber schwache Mobilverbindungen
      const worker = async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          const cur = it;
          update(cur.key, { state: 'uploading', progress: 0, error: undefined });
          try {
            const r = await uploadResumable(`/api/v1/public/upload/${encodeURIComponent(token)}/sessions`, cur.file, {
              clientKey: cur.key,
              note: fields.note === 'off' ? '' : note.trim(),
              ref: uploadRef,
              onProgress: (p) => update(cur.key, { progress: p }),
              extra: { uploader, consent },
            });
            update(cur.key, { state: 'done', progress: 100, duplicate: r.duplicate });
          } catch (e) {
            update(cur.key, { state: 'error', error: (e as Error).message });
          }
        }
      };
      await Promise.all([worker(), worker()]);
      setBusy(false);
    },
    [items, token, note, info, uploadRef, who, consent], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const done = items.filter((i) => i.state === 'done').length;
  const failed = items.filter((i) => i.state === 'error').length;
  const waiting = items.filter((i) => i.state === 'waiting').length;
  const field = (k: 'name' | 'email' | 'place' | 'date', label: string, type: string, auto: string) =>
    fields[k] !== 'off' && (
      <label key={k} className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">
          {label} {fields[k] === 'optional' ? <span className="font-normal text-fg-muted">(freiwillig)</span> : <span className="text-err" aria-hidden="true">*</span>}
        </span>
        <Input type={type} autoComplete={auto} value={who[k]} maxLength={k === 'email' ? 200 : 120} required={fields[k] === 'required'} aria-required={fields[k] === 'required' || undefined} onChange={(e) => setWho({ ...who, [k]: e.target.value })} />
      </label>
    );

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-sm text-fg-muted">
        Ausgewählte Aufnahmen können auf der Website und in sozialen Medien veröffentlicht werden. Erfasst werden {collectedText(info, true)} und Ihre IP-Adresse (Missbrauchsschutz).{' '}
        <a href="#datenschutz">Hinweise zum Datenschutz</a>
      </p>
      <div className="flex flex-col gap-3">
        <Button variant="primary" size="md" icon="Images" className="!h-16 !text-base" style={accentStyle} onClick={() => inputRef.current?.click()}>
          Bilder oder Videos auswählen
        </Button>
        {info.camera_buttons !== false && touch && (
          <div className="grid grid-cols-2 gap-3">
            <Button size="md" icon="Camera" className="!h-12" onClick={() => cameraRef.current?.click()}>
              Foto aufnehmen
            </Button>
            <Button size="md" icon="Video" className="!h-12" onClick={() => videoRef.current?.click()}>
              Video aufnehmen
            </Button>
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept={info.accept} multiple className="sr-only" aria-label="Bilder oder Videos auswählen" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
      <input ref={videoRef} type="file" accept="video/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />

      {(fields.name !== 'off' || fields.email !== 'off' || fields.place !== 'off' || fields.date !== 'off') && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field('name', 'Name', 'text', 'name')}
          {field('email', 'E-Mail-Adresse', 'email', 'email')}
          {field('place', 'Aufnahmeort', 'text', 'off')}
          {field('date', 'Aufnahmedatum', 'date', 'off')}
        </div>
      )}
      {fields.note !== 'off' && (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Hinweis {fields.note === 'optional' ? <span className="font-normal text-fg-muted">(optional)</span> : <span className="text-err" aria-hidden="true">*</span>}</span>
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Ort oder Zeitpunkt der Aufnahme" aria-required={fields.note === 'required' || undefined} />
          <span className="text-meta text-fg-muted">Bitte keine Namen, Telefonnummern oder anderen Angaben zu anderen Personen eintragen.</span>
        </label>
      )}
      {info.consent_required && (
        <label className="flex items-start gap-2.5 text-sm cursor-pointer">
          <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[var(--bc-primary-solid)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-required="true" />
          <span className="whitespace-pre-line">
            {info.consent_text} <span className="text-err" aria-hidden="true">*</span>
          </span>
        </label>
      )}
      {formError && (
        <p className="m-0 text-sm text-err" role="alert">
          {formError}
        </p>
      )}

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
                  {it.state === 'done' && (
                    <span className="text-ok text-sm font-medium flex items-center gap-1">
                      <Icon name="CheckCircle2" size={16} /> Übertragen
                    </span>
                  )}
                  {it.state === 'uploading' && <span className="text-sm tabular-nums">{it.progress} %</span>}
                  {it.state === 'error' && (
                    <Button size="sm" icon="RefreshCw" disabled={busy || it.file.size === 0 || it.file.size > info.max_file_bytes} onClick={() => run(it.key)}>
                      Erneut senden
                    </Button>
                  )}
                  {it.state === 'waiting' && !busy && <Button size="sm" iconOnly icon="X" aria-label={`${it.file.name} entfernen`} onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} />}
                </div>
                {(it.state === 'uploading' || it.state === 'done') && (
                  <div className="h-1.5 rounded-full bg-raised overflow-hidden" role="progressbar" aria-valuenow={it.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Fortschritt ${it.file.name}`}>
                    <div className={cx('h-full', it.state === 'done' ? 'bg-ok' : 'bg-primary-solid')} style={{ width: `${it.progress}%` }} />
                  </div>
                )}
                {it.error && (
                  <div className="text-sm text-err" role="alert">
                    {it.error}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div aria-live="polite" className="text-sm text-fg-muted">
            {done} von {items.length} übertragen{failed ? ` · ${failed} fehlgeschlagen` : ''}
          </div>
          {(busy || waiting > 0 || failed > 0) && (
            <Button variant="primary" icon="Upload" className="!h-12 !text-base" style={accentStyle} disabled={busy} loading={busy} onClick={() => run()}>
              {failed && !waiting ? 'Fehlgeschlagene erneut senden' : `${waiting} ${waiting === 1 ? 'Datei' : 'Dateien'} senden`}
            </Button>
          )}
          {done > 0 && !busy && !waiting && !failed && (
            <Notice tone="success" title="Vielen Dank!">
              {info.done_text ? <span className="whitespace-pre-line">{info.done_text}</span> : 'Die Dateien sind angekommen und werden geprüft, bevor sie verwendet werden.'}
              <span className="block mt-1">
                Ihre Vorgangsnummer: <strong className="font-mono">{uploadRef}</strong> – bitte notieren. Mit ihr können Sie später Auskunft oder die Löschung Ihrer Dateien verlangen.
              </span>
            </Notice>
          )}
        </section>
      )}
      <p className="m-0 text-meta text-fg-muted">
        Erlaubt sind {info.types ? `${info.types}` : 'Fotos und Videos'} bis {fmtBytes(info.max_file_bytes)} je Datei{perUpload ? `, höchstens ${perUpload} Dateien je Upload` : ''}. Bricht die Verbindung ab, geht der Upload automatisch an derselben Stelle weiter. Hochgeladene Dateien sieht zunächst nur die Redaktion; ausgewählte Aufnahmen können veröffentlicht werden.
      </p>
    </div>
  );
}

/** Kopf der Upload-Seite ohne Gestaltung (Organisation, Titel, Zweck, Gültigkeit, Begrüßung). */
export function DefaultHeader({ info }: { info: LinkInfo }) {
  return (
    <>
      <header className="flex flex-col gap-1">
        <div className="text-sm text-fg-muted">{info.organization}</div>
        <h1 className="m-0 text-page font-semibold tracking-[-0.02em]">{info.collection.title}</h1>
        {info.collection.purpose && <p className="m-0 text-fg-muted">{info.collection.purpose}</p>}
        <div className="text-sm text-fg-muted">Uploads möglich bis {fmtDateTime(info.expires_at)}</div>
      </header>
      {(info.welcome_text || info.collection.note) && (
        <Notice>
          <span className="whitespace-pre-line">{info.welcome_text || info.collection.note}</span>
        </Notice>
      )}
    </>
  );
}

/** Passwortabfrage für geschützte Links (Freigabe gilt 12 Stunden in diesem Browser). */
function PasswordGate({ token, organization, onUnlocked }: { token: string; organization: string | null; onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4 py-8"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post(`/public/upload/${encodeURIComponent(token)}/unlock`, { password: pw });
          onUnlocked();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="Lock" size={32} className="text-fg-muted" />
      {organization && <div className="text-sm text-fg-muted">{organization}</div>}
      <h1 className="m-0 text-page font-semibold">Passwort erforderlich</h1>
      <p className="m-0 text-fg-muted">Dieser Upload-Link ist geschützt. Das Passwort steht auf dem Aushang oder kommt von der Redaktion.</p>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Passwort</span>
        <Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!error} />
      </label>
      {error && (
        <p className="m-0 text-sm text-err" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" icon="LockOpen" className="!h-12" loading={busy} disabled={!pw}>
        Weiter
      </Button>
    </form>
  );
}

export function UploadPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [locked, setLocked] = useState<null | { organization: string | null }>(null);
  const [reload, setReload] = useState(0);
  // Verbindungsprobleme (Zeitüberschreitung, offline, Server weg, Wartung, zu viele Versuche) mit „Erneut versuchen“ (#194)
  const [netError, setNetError] = useState<Feedback | null>(null);

  useEffect(() => {
    document.title = 'Fotos und Videos hochladen';
    get<LinkInfo>(`/public/upload/${encodeURIComponent(token)}`)
      .then((i) => (setLocked(null), setNetError(null), setInfo(i)))
      .catch((e: ApiError) => {
        if (e.status === 401 && e.code === 'password_required') return setLocked({ organization: e.details?.organization ?? null });
        const fb = feedbackFor(e);
        if (['timeout', 'offline', 'unreachable', 'maintenance', 'ratelimit'].includes(fb.kind)) return setNetError(fb);
        setNetError(null);
        setError({
          // Einheitlich für unbekannt, abgelaufen, pausiert und widerrufen (verrät nichts über den Link);
          // 400 = Token unvollständig (z. B. abgeschnitten beim Kopieren) – wie ein unbekannter Link behandeln
          title: [400, 404, 410].includes(e.status) ? 'Dieser Link funktioniert nicht (mehr)' : 'Fehler',
          text: e.status === 400 ? 'Der Link ist unvollständig. Bitte den Link oder QR-Code erneut öffnen oder bei der Redaktion einen aktuellen Link erfragen.' : e.message,
        });
      });
  }, [token, reload]);

  return (
    <div className="min-h-screen bg-bg text-fg">
      <main className="max-w-[560px] mx-auto px-4 py-6 flex flex-col gap-5" id="main">
        {netError && !info && <FeedbackView {...netError} onRetry={() => setReload((n) => n + 1)} autoRetry={netError.kind !== 'ratelimit'} />}
        {!info && !error && !locked && !netError && (
          <div className="flex items-center gap-2 text-fg-muted py-10 justify-center">
            <Spinner /> Lade …
          </div>
        )}
        {locked && !info && <PasswordGate token={token} organization={locked.organization} onUnlocked={() => setReload((n) => n + 1)} />}
        {error && (
          <div className="flex flex-col gap-3 py-8">
            <Icon name="Ban" size={36} className="text-err" />
            <h1 className="m-0 text-page font-semibold">{error.title}</h1>
            <p className="m-0 text-fg-muted">{error.text}</p>
          </div>
        )}
        {info && info.design && <DesignedPage info={info} design={info.design} token={token} />}
        {info && !info.design && (
          <>
            <DefaultHeader info={info} />
            {info.setup_hint && (
              <Notice tone="warning" title="Hinweis für die Verwaltung">
                Verantwortliche Stelle bzw. Datenschutzerklärung sind noch nicht eingetragen (Einstellungen → Datenschutz & Recht). Diesen Hinweis sehen nur angemeldete Personen mit Verwaltungsrechten.
              </Notice>
            )}
            <UploadArea info={info} token={token} />
            <PrivacySection info={info} />
          </>
        )}
        <LegalLinks newTab className="pt-2" />
      </main>
    </div>
  );
}
