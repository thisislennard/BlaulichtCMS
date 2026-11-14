import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { Button, Notice, Spinner } from './ui/core';
import { CopyButton, Dialog } from './ui/overlays';

/** QR-Code wird in LifeLink erzeugt (keine externen Dienste) und als SVG angezeigt. */
export function QrImage({ text, size = 220, label }: { text: string; size?: number; label?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(null);
    (async () => {
      try {
        const res = await api<Response>('POST', '/qr', { text }, { raw: true });
        if (!res.ok) throw new Error('QR-Code konnte nicht erzeugt werden.');
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setSrc(url);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [text]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!src) return <div className="flex items-center justify-center" style={{ width: size, height: size }}><Spinner size={22} /></div>;
  return <img src={src} width={size} height={size} alt={label ?? `QR-Code für ${text}`} className="bg-white rounded-control" style={{ imageRendering: 'pixelated' }} />;
}

export interface ShareTarget {
  url: string;
  /** Wofür ist der Link? (erscheint auf dem Aushang) */
  purpose: string;
  title: string;
  validUntil?: string | null;
  /** Hinweis für sensible Links (Upload-Link, Einladung) */
  sensitive?: string;
  note?: string;
}

export function printHref(t: ShareTarget) {
  const p = new URLSearchParams({ url: t.url, title: t.title, purpose: t.purpose });
  if (t.validUntil) p.set('valid', t.validUntil);
  if (t.note) p.set('note', t.note);
  return `/drucken?${p.toString()}`;
}

export function QrDialog({ open, onClose, target }: { open: boolean; onClose: () => void; target: ShareTarget }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="QR-Code anzeigen"
      width={460}
      footer={
        <>
          <CopyButton value={target.url} label="Link kopieren" />
          <Button variant="primary" icon="Printer" onClick={() => window.open(printHref(target), '_blank', 'noopener')}>
            Aushang drucken
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-sm text-fg-muted">{target.purpose}</div>
        <div className="font-semibold">{target.title}</div>
        <QrImage text={target.url} size={240} />
        <code className="text-sm break-all">{target.url}</code>
        {target.validUntil && <div className="text-sm text-fg-muted">Gültig bis {fmtDateTime(target.validUntil)}</div>}
        {target.sensitive && (
          <Notice tone="warning" className="text-left w-full">
            {target.sensitive}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

/** Einheitliche Aktionen für jede teilbare URL: Link kopieren, QR-Code anzeigen, Aushang drucken. */
export function ShareActions({ target, size = 'sm', compact }: { target: ShareTarget; size?: 'sm' | 'md'; compact?: boolean }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <CopyButton value={target.url} label={compact ? 'Kopieren' : 'Link kopieren'} size={size} />
      <Button size={size} icon="QrCode" onClick={() => setQr(true)}>
        QR-Code anzeigen
      </Button>
      {!compact && (
        <Button size={size} icon="Printer" onClick={() => window.open(printHref(target), '_blank', 'noopener')}>
          Aushang drucken
        </Button>
      )}
      <QrDialog open={qr} onClose={() => setQr(false)} target={target} />
    </div>
  );
}
