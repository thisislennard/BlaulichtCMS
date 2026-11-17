import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaItem } from '../../api/types';
import { Button, cx, SegmentedControl, Select, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu } from '../../components/ui/overlays';
import { fmtBytes, fmtDateTime, plural } from '../../lib/format';
import { openFaces, SENSITIVE_LABELS } from './PrivacyDialog';

/** Name für die Oberfläche: Anzeigename, sonst Originalname. */
export const mediaName = (m: MediaItem) => (m.display_name || '').trim() || m.original_name;

/* ------------------------------------ Ansicht merken ------------------------------------ */

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* privat/gesperrt */
    }
  },
};

export type ViewMode = 'grid' | 'list';
export const PER_PAGE_OPTIONS = [48, 96, 192] as const;

/** Kacheln/Liste und Anzahl je Seite pro Gerät merken (wie LiFeOS). */
export function useGalleryPrefs() {
  const [view, setViewState] = useState<ViewMode>(() => (store.get('bc.media.view') === 'list' ? 'list' : 'grid'));
  const [perPage, setPerPageState] = useState<number>(() => {
    const n = Number(store.get('bc.media.perPage'));
    return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 48;
  });
  return {
    view,
    perPage,
    setView: (v: ViewMode) => (store.set('bc.media.view', v), setViewState(v)),
    setPerPage: (n: number) => (store.set('bc.media.perPage', String(n)), setPerPageState(n)),
  };
}

/* --------------------------------------- Vorschau --------------------------------------- */

export function MediaThumb({ m, className }: { m: MediaItem; className?: string }) {
  if (m.status !== 'ready') {
    const blocked = m.status === 'blocked';
    return (
      <div className={cx('bg-raised flex flex-col items-center justify-center gap-1 text-fg-muted text-sm p-2 text-center', className)}>
        <Icon name={m.status === 'rejected' ? 'Ban' : blocked ? 'ShieldX' : 'Hourglass'} size={22} />
        {m.status === 'rejected' ? 'Abgewiesen' : blocked ? 'Gesperrt' : 'Wird geprüft'}
      </div>
    );
  }
  if (!m.has_preview) {
    return (
      <div className={cx('bg-raised flex flex-col items-center justify-center gap-1 text-fg-muted text-sm', className)}>
        <Icon name={m.kind === 'video' ? 'Film' : 'ImageOff'} size={22} />
        Keine Vorschau
      </div>
    );
  }
  return (
    <div className={cx('relative bg-raised overflow-hidden', className)}>
      <img src={`/api/v1/media/${m.id}/preview`} alt={mediaName(m)} loading="lazy" decoding="async" className="w-full h-full object-cover" />
      {m.kind === 'video' && (
        <span className="absolute bottom-1.5 left-1.5 bg-black/70 text-white rounded-chip px-1.5 py-0.5 text-meta flex items-center gap-1">
          <Icon name="Film" size={12} /> Video
        </span>
      )}
      {!!m.sensitive_flags?.length && (
        <span className="absolute top-1.5 right-1.5 bg-warn-soft text-warn rounded-chip px-1.5 py-0.5 text-meta flex items-center gap-1" title={m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')}>
          <Icon name="ShieldAlert" size={12} /> {m.sensitive_flags.length > 1 ? `${m.sensitive_flags.length} Hinweise` : SENSITIVE_LABELS[m.sensitive_flags[0]]}
        </span>
      )}
    </div>
  );
}

export function MediaInfo({ m }: { m: MediaItem }) {
  const row = (k: string, v: ReactNode) => (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="m-0 min-w-0 break-words">{v}</dd>
    </>
  );
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {m.display_name ? row('Name', m.display_name) : null}
      {row('Datei', <span className="truncate block">{m.original_name}</span>)}
      {m.size_bytes != null && row('Größe', `${fmtBytes(m.size_bytes)}${m.width ? ` · ${m.width} × ${m.height}` : ''}`)}
      {row('Eingang', `${fmtDateTime(m.created_at)} · ${m.via_link ? 'Upload-Link' : (m.uploaded_by_name ?? 'intern')}`)}
      {m.description ? row('Beschreibung', <span className="whitespace-pre-line">{m.description}</span>) : null}
      {m.uploader_note ? row('Hinweis', m.uploader_note) : null}
      {m.had_location ? row('Standort', m.location_stripped ? 'beim Upload enthalten, aus Original und öffentlicher Fassung entfernt' : 'im Original enthalten, in der öffentlichen Fassung entfernt') : null}
      {m.sensitive_flags?.length ? row('Markiert', m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')) : null}
      {m.redactions?.length || m.crop || m.strip_audio
        ? row('Öffentlich', [m.redactions?.length ? `${plural(m.redactions.length, 'Bereich', 'Bereiche')} unkenntlich` : '', m.crop ? 'zugeschnitten' : '', m.strip_audio ? 'ohne Ton' : ''].filter(Boolean).join(' · '))
        : null}
      {m.had_location === null ? row('Standort', 'unbekannt – das Format wird nicht ausgewertet; das Original kann Standortdaten enthalten') : null}
      {!m.had_location && m.had_location !== null && m.location_stripped ? row('Original', 'ohne Standort-, Seriennummer- und Personenangaben gespeichert') : null}
      {m.duplicate_of ? row('Duplikat', 'gleicher Inhalt wie eine ältere Datei (siehe Details)') : null}
      {m.face_status === 'queued' ? row('Gesichter', 'Suche läuft') : openFaces(m) > 0 ? row('Gesichter', `${openFaces(m)} Vorschläge offen – unter „Datenschutz und Unkenntlichmachen“ prüfen`) : null}
    </dl>
  );
}

/* -------------------------------------- Werkzeugleiste -------------------------------------- */

export function ViewControls({ view, setView, perPage, setPerPage }: { view: ViewMode; setView: (v: ViewMode) => void; perPage: number; setPerPage: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      {/* Ansichtsschalter neutral (aktiv = bg-raised), Rot bleibt der Hauptaktion vorbehalten (#270) */}
      <SegmentedControl
        label="Ansicht"
        size="sm"
        value={view}
        onChange={setView}
        options={[
          { value: 'grid', label: <><Icon name="LayoutGrid" size={15} /><span className="sr-only">Kacheln</span></> },
          { value: 'list', label: <><Icon name="List" size={15} /><span className="sr-only">Liste</span></> },
        ]}
      />
      <label className="flex items-center gap-1.5 text-sm text-fg-muted">
        <span className="sr-only sm:not-sr-only">Je Seite</span>
        <Select aria-label="Dateien je Seite" value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} className="!h-ctl-sm !w-auto">
          {PER_PAGE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

export function Pager({ page, pages, onPage, total }: { page: number; pages: number; onPage: (p: number) => void; total: number }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Seiten" className="flex items-center justify-center gap-2 text-sm">
      <Button size="sm" icon="ChevronLeft" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Zurück
      </Button>
      <span className="font-mono text-fg-muted" aria-live="polite">
        Seite {page} von {pages} · {total} Dateien
      </span>
      <Button size="sm" iconRight="ChevronRight" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Weiter
      </Button>
    </nav>
  );
}

/** Markierungsfeld (Mehrfachauswahl) – eigenes Element, damit Klick auf die Vorschau weiter die Großansicht öffnet. */
export function MarkBox({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <label className={cx('inline-flex items-center justify-center w-8 h-8 rounded-chip cursor-pointer', className)}>
      <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

export type MenuItems = Parameters<typeof Menu>[0]['items'];

/* ------------------------------------------ Liste ------------------------------------------ */

export function MediaList({ items, marked, onMark, onOpen, menu, extraColumn }: { items: MediaItem[]; marked?: Set<string>; onMark?: (id: string, v: boolean) => void; onOpen: (i: number) => void; menu: (m: MediaItem) => MenuItems; extraColumn?: { label: string; render: (m: MediaItem) => ReactNode } }) {
  return (
    <div className="border border-line rounded-card overflow-x-auto bg-card">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-fg-muted border-b border-line">
            {onMark && <th className="w-10 px-2 py-2 font-medium"><span className="sr-only">Markieren</span></th>}
            <th className="w-14 px-2 py-2 font-medium"><span className="sr-only">Vorschau</span></th>
            <th className="px-2 py-2 font-medium">Name</th>
            {extraColumn && <th className="px-2 py-2 font-medium hidden md:table-cell">{extraColumn.label}</th>}
            <th className="px-2 py-2 font-medium hidden sm:table-cell">Größe</th>
            <th className="px-2 py-2 font-medium hidden lg:table-cell">Eingang</th>
            <th className="px-2 py-2 font-medium">Stand</th>
            <th className="w-10 px-2 py-2"><span className="sr-only">Aktionen</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((m, i) => (
            <tr key={m.id} className={cx('border-b border-line last:border-0', marked?.has(m.id) && 'bg-primary-soft')}>
              {onMark && (
                <td className="px-2 py-1.5">
                  <MarkBox checked={!!marked?.has(m.id)} onChange={(v) => onMark(m.id, v)} label={`${mediaName(m)} markieren`} />
                </td>
              )}
              <td className="px-2 py-1.5">
                <button type="button" className="block w-11 h-11 rounded-chip overflow-hidden" onClick={() => onOpen(i)} aria-label={`${mediaName(m)} groß anzeigen`}>
                  <MediaThumb m={m} className="w-11 h-11 [&_span]:hidden text-[0px]" />
                </button>
              </td>
              <td className="px-2 py-1.5 max-w-[320px]">
                <div className="truncate font-medium" title={m.original_name}>
                  {mediaName(m)}
                </div>
                {m.description && <div className="truncate text-meta text-fg-muted">{m.description}</div>}
                {m.status === 'rejected' || m.status === 'blocked' ? <div className="text-meta text-err">{m.reject_reason}</div> : null}
              </td>
              {extraColumn && <td className="px-2 py-1.5 hidden md:table-cell">{extraColumn.render(m)}</td>}
              <td className="px-2 py-1.5 hidden sm:table-cell font-mono text-meta">{m.size_bytes != null ? fmtBytes(m.size_bytes) : '–'}</td>
              <td className="px-2 py-1.5 hidden lg:table-cell font-mono text-meta">{fmtDateTime(m.created_at)}</td>
              <td className="px-2 py-1.5">{m.status === 'ready' ? <StatusBadge status={m.selection ?? 'pending'} /> : <StatusBadge status={m.status === 'blocked' ? 'blocked' : m.status} />}</td>
              <td className="px-2 py-1.5">
                <Menu size="sm" label={`Aktionen für ${mediaName(m)}`} items={menu(m)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------- Großansicht ---------------------------------------- */

/** Großansicht für alle Dateien: Pfeile, Wischen, Tastatur ←/→, Esc; Videos im Player (öffentliche Fassung). */
export function Lightbox({ items, start, onClose, onDetails }: { items: MediaItem[]; start: number; onClose: () => void; onDetails?: (m: MediaItem) => void }) {
  const [idx, setIdx] = useState(Math.min(start, items.length - 1));
  const m = items[idx];
  const go = (d: number) => setIdx((i) => Math.max(0, Math.min(items.length - 1, i + d)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement)?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'VIDEO') return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    for (const n of [items[idx + 1], items[idx - 1]]) if (n?.has_preview) new Image().src = `/api/v1/media/${n.id}/preview`;
  }, [idx, items]);
  const startX = useRef<number | null>(null);
  if (!m) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{mediaName(m)}</span>
          <span className="font-mono text-meta text-fg-muted shrink-0">
            {idx + 1}/{items.length}
          </span>
        </span>
      }
      width={1000}
      footer={
        <>
          {onDetails && (
            <Button icon="Info" onClick={() => onDetails(m)}>
              Details
            </Button>
          )}
          <Button icon="ChevronLeft" disabled={idx === 0} onClick={() => go(-1)}>
            Vorherige
          </Button>
          <Button variant="primary" iconRight="ChevronRight" disabled={idx >= items.length - 1} onClick={() => go(1)}>
            Nächste
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          className="rounded-card overflow-hidden bg-raised touch-pan-y flex items-center justify-center"
          onTouchStart={(e) => (startX.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (startX.current === null) return;
            const dx = e.changedTouches[0].clientX - startX.current;
            startX.current = null;
            if (dx < -60) go(1);
            if (dx > 60) go(-1);
          }}
        >
          {m.status === 'ready' && m.kind === 'video' && m.has_public ? (
            <video key={m.id} src={`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`} poster={m.has_preview ? `/api/v1/media/${m.id}/preview` : undefined} controls className="w-full max-h-[62vh] bg-black" />
          ) : m.status === 'ready' && m.has_preview ? (
            <img key={m.id} src={`/api/v1/media/${m.id}/preview`} alt={mediaName(m)} className="max-w-full max-h-[62vh] object-contain" />
          ) : (
            <MediaThumb m={m} className="w-full aspect-[4/3]" />
          )}
        </div>
        <MediaInfo m={m} />
        <p className="m-0 text-meta text-fg-muted">Tastatur: ← vorherige · → nächste · Esc schließen. Am Handy: wischen.</p>
      </div>
    </Dialog>
  );
}
