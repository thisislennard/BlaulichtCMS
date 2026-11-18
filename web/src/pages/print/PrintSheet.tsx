import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { QrImage } from '../../components/share';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import './print-sheet.css';

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
  const privacy = me?.instance.privacy;
  useEffect(() => {
    document.title = `Aushang – ${title}`;
  }, [title]);
  if (!/^https?:\/\//.test(url)) return <p className="p-8">Kein gültiger Link angegeben.</p>;
  // Fremde Adresse deutlich machen (#87): ein zugespielter Link soll nicht unbemerkt mit dem Namen der Organisation
  // auf einem Aushang landen
  const external = (() => {
    try {
      return new URL(url).origin !== window.location.origin ? new URL(url).host : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="print-sheet">
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
      {/* Informationspflichten (Art. 13 DSGVO, #96): Verweis auf Verantwortliche und Datenschutzerklärung */}
      {(privacy?.controller || privacy?.policy_url) && (
        <div className="privacy">
          Mit dem Hochladen übermitteln Sie Fotos oder Videos; ausgewählte Aufnahmen können auf der Website und in sozialen Medien veröffentlicht werden. Hinweise zum Datenschutz stehen auf der Upload-Seite
          {privacy.controller ? ` · Verantwortlich: ${privacy.controller}` : ''}
          {privacy.policy_url ? ` · Datenschutzerklärung: ${privacy.policy_url}` : ''}
        </div>
      )}
      {privacy?.incomplete && (
        <p className="no-print warn-external">
          Hinweis: Verantwortliche Stelle bzw. Datenschutzerklärung sind noch nicht eingetragen (Einstellungen → Datenschutz & Recht). Upload-Seite und Aushang brauchen diese Angaben.
        </p>
      )}
      {external && (
        <p className="no-print warn-external">
          Achtung: Dieser Aushang verweist auf eine fremde Adresse ({external}). Nur drucken, wenn die Adresse bekannt und vertrauenswürdig ist.
        </p>
      )}
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
