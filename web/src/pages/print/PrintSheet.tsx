import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { QrImage } from '../../components/share';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

/**
 * A4-Aushang für einen Link: Zweck, Titel, scanbarer Code, lesbare Adresse, Gültigkeit.
 * Ruhige Randzone und hoher Kontrast; Rechte, Ablauf und Widerruf gelten auch für den Ausdruck.
 */
export default function PrintSheet() {
  const [sp] = useSearchParams();
  const { me } = useAuth();
  const url = sp.get('url') ?? '';
  const title = sp.get('title') ?? '';
  const purpose = sp.get('purpose') ?? '';
  const valid = sp.get('valid');
  const note = sp.get('note');
  const org = me?.instance.organization || me?.instance.name || '';
  useEffect(() => {
    document.title = `Aushang – ${title}`;
  }, [title]);
  if (!/^https?:\/\//.test(url)) return <p className="p-8">Kein gültiger Link angegeben.</p>;
  return (
    <div className="print-sheet">
      <style>{`
        @page { size: A4 portrait; margin: 14mm; }
        body { background: #fff !important; }
        .print-sheet { color: #000; background: #fff; font-family: inherit; max-width: 182mm; margin: 0 auto; padding: 8mm 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 7mm; min-height: 260mm; }
        .print-sheet h1 { font-size: 30pt; line-height: 1.15; margin: 0; font-weight: 700; color: #000; }
        .print-sheet .purpose { font-size: 15pt; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; color: #000; }
        .print-sheet .scan { font-size: 16pt; color: #000; }
        .print-sheet .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5pt; word-break: break-all; color: #000; border: 1.5pt solid #000; border-radius: 3mm; padding: 3mm 5mm; }
        .print-sheet .meta { font-size: 12pt; color: #000; }
        .print-sheet .org { margin-top: auto; font-size: 11pt; color: #000; border-top: 1pt solid #000; padding-top: 3mm; width: 100%; }
        .print-sheet .qr { padding: 6mm; background: #fff; }
        .print-sheet .qr img { width: 105mm !important; height: 105mm !important; }
        .no-print { margin-top: 6mm; }
        @media print { .no-print { display: none !important; } }
      `}</style>
      {purpose && <div className="purpose">{purpose}</div>}
      <h1>{title}</h1>
      <div className="scan">Code mit der Handykamera scannen</div>
      <div className="qr">
        <QrImage text={url} size={400} label={`QR-Code: ${url}`} />
      </div>
      <div className="url">{url}</div>
      {valid && <div className="meta">Gültig bis {fmtDateTime(valid)}</div>}
      {note && <div className="meta">{note}</div>}
      <div className="org">{org}</div>
      <div className="no-print flex gap-3">
        <button type="button" onClick={() => window.print()} className="px-4 py-2 rounded-control border border-black bg-white text-black font-semibold">
          Drucken
        </button>
        <button type="button" onClick={() => window.close()} className="px-4 py-2 rounded-control border border-black bg-white text-black">
          Schließen
        </button>
      </div>
    </div>
  );
}
