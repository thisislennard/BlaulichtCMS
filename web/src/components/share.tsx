import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { Button, Notice, Spinner } from './ui/core';
import { CopyButton, Dialog, Menu, useErrorToast } from './ui/overlays';

/** QR-Code wird in BlaulichtCMS erzeugt (keine externen Dienste) und als SVG angezeigt. */
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

/** QR-Code als SVG vom Server holen (lokal erzeugt, keine externen Dienste). */
async function fetchQrSvg(text: string): Promise<Blob> {
  const res = await api<Response>('POST', '/qr', { text }, { raw: true });
  if (!res.ok) throw new Error('QR-Code konnte nicht erzeugt werden.');
  return res.blob();
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** QR-Code als PNG (1024 px) – im Browser aus dem SVG gezeichnet, ohne externe Dienste. */
export async function downloadQrPng(text: string, name = 'qr-code.png') {
  const svg = await fetchQrSvg(text);
  const url = URL.createObjectURL(svg);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('QR-Code konnte nicht gezeichnet werden.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 1024, 1024);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!png) throw new Error('QR-Code konnte nicht gespeichert werden.');
    saveBlob(png, name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Teilen per WhatsApp, E-Mail oder Systemdialog sowie QR-Code als Datei (wie LiFeOS). */
export function ShareMenu({ target, size = 'sm' }: { target: ShareTarget; size?: 'sm' | 'md' }) {
  const toastError = useErrorToast();
  const text = `${target.purpose}: ${target.title}\n${target.url}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Menu
      size={size}
      icon="Share2"
      label="Teilen"
      items={[
        canShare ? { label: 'Teilen …', icon: 'Share2', onClick: () => void navigator.share({ title: target.title, text: `${target.purpose}: ${target.title}`, url: target.url }).catch(() => {}) } : null,
        { label: 'Per WhatsApp teilen', icon: 'MessageCircle', onClick: () => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener') },
        { label: 'Per E-Mail teilen', icon: 'Mail', onClick: () => (window.location.href = `mailto:?subject=${encodeURIComponent(`${target.purpose}: ${target.title}`)}&body=${encodeURIComponent(text)}`) },
        { label: 'QR-Code als PNG', icon: 'FileDown', onClick: () => void downloadQrPng(target.url).catch(toastError) },
        { label: 'QR-Code als SVG', icon: 'FileDown', onClick: () => void fetchQrSvg(target.url).then((b) => saveBlob(b, 'qr-code.svg')).catch(toastError) },
      ]}
    />
  );
}

/** Einheitliche Aktionen für jede teilbare URL: Link kopieren, QR-Code anzeigen, Aushang drucken (optional Teilen-Menü). */
export function ShareActions({ target, size = 'sm', compact, share }: { target: ShareTarget; size?: 'sm' | 'md'; compact?: boolean; share?: boolean }) {
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
      {share && <ShareMenu target={target} size={size} />}
      <QrDialog open={qr} onClose={() => setQr(false)} target={target} />
    </div>
  );
}
