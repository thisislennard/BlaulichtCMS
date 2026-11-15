import { cx, Notice } from '../../components/ui/core';
import { fmtDateTime } from '../../lib/format';
import { PrivacySection, UploadArea, type LinkInfo } from './UploadPage';

export interface DesignBlock {
  type: string;
  [k: string]: string;
}
export interface UploadDesign {
  accent: string;
  header: boolean;
  blocks: DesignBlock[];
}

const BANNER_H: Record<string, string> = { s: 'h-28 sm:h-32', m: 'h-40 sm:h-52', l: 'h-56 sm:h-72' };
const imgUrl = (id: string) => `/api/v1/public/design-images/${id}`;

/**
 * Upload-Seite mit Gestaltung (Bausteine wie in LiFeOS). Alle Texte werden als Text dargestellt (kein HTML), Bilder nur
 * aus der eigenen Ablage. Der Datenschutzabschnitt steht immer am Ende und ist nicht abschaltbar.
 * `preview`: Vorschau im Editor (keine Übertragung, Platzhaltertext für leere Felder).
 */
export function DesignedPage({ info, design, token, preview }: { info: LinkInfo; design: UploadDesign; token: string; preview?: boolean }) {
  const hasH1 = design.header || design.blocks.some((b) => b.type === 'heading' && b.size !== 'm');
  let h1Used = design.header;
  return (
    <div className="flex flex-col gap-5">
      {!hasH1 && <h1 className="sr-only">{info.collection.title}</h1>}
      {design.header && (
        <header className="flex flex-col gap-1">
          <div className="text-sm text-fg-muted">{info.organization}</div>
          <h1 className="m-0 text-page font-semibold tracking-[-0.02em]">{info.collection.title}</h1>
          {info.collection.purpose && <p className="m-0 text-fg-muted">{info.collection.purpose}</p>}
          <div className="text-sm text-fg-muted">Uploads möglich bis {fmtDateTime(info.expires_at)}</div>
        </header>
      )}
      {info.setup_hint && (
        <Notice tone="warning" title="Hinweis für die Verwaltung">
          Verantwortliche Stelle bzw. Datenschutzerklärung sind noch nicht eingetragen (Einstellungen → Datenschutz). Diesen Hinweis sehen nur angemeldete Personen mit Verwaltungsrechten.
        </Notice>
      )}
      {design.blocks.map((b, i) => {
        switch (b.type) {
          case 'banner':
            return b.image ? <img key={i} src={imgUrl(b.image)} alt={b.alt || ''} className={cx('w-full object-cover rounded-card bg-raised', BANNER_H[b.height] ?? BANNER_H.m)} /> : null;
          case 'logo':
            return b.image ? (
              <div key={i} className={cx('flex', b.align === 'left' ? 'justify-start' : 'justify-center')}>
                <img src={imgUrl(b.image)} alt={b.alt || ''} className="max-h-20 max-w-[60%] object-contain" />
              </div>
            ) : null;
          case 'heading': {
            const text = b.text || (preview ? 'Überschrift' : '');
            if (!text) return null;
            if (b.size !== 'm' && !h1Used) {
              h1Used = true;
              return (
                <h1 key={i} className="m-0 text-page font-semibold tracking-[-0.02em]">
                  {text}
                </h1>
              );
            }
            return (
              <h2 key={i} className={cx('m-0 font-semibold', b.size === 'm' ? 'text-section' : 'text-[22px]')}>
                {text}
              </h2>
            );
          }
          case 'text':
            return b.text || preview ? (
              <p key={i} className="m-0 whitespace-pre-line">
                {b.text || 'Text …'}
              </p>
            ) : null;
          case 'image':
            return b.image ? (
              <figure key={i} className="m-0 flex flex-col gap-1.5">
                <img src={imgUrl(b.image)} alt={b.alt || ''} className="w-full rounded-card bg-raised" />
                {b.caption && <figcaption className="text-meta text-fg-muted">{b.caption}</figcaption>}
              </figure>
            ) : null;
          case 'note':
            return b.text || preview ? (
              <Notice key={i} tone={b.style === 'warning' ? 'warning' : 'info'}>
                <span className="whitespace-pre-line">{b.text || 'Hinweis …'}</span>
              </Notice>
            ) : null;
          case 'divider':
            return <hr key={i} className="w-full border-0 border-t border-line m-0" />;
          case 'welcome': {
            const text = info.welcome_text || info.collection.note || (preview ? 'Hier steht der Begrüßungstext des Links bzw. der Hinweis der Sammlung.' : '');
            return text ? (
              <Notice key={i}>
                <span className="whitespace-pre-line">{text}</span>
              </Notice>
            ) : null;
          }
          case 'upload':
            return <UploadArea key={i} info={info} token={token} preview={preview} accent={design.accent} />;
          default:
            return null;
        }
      })}
      <PrivacySection info={info} />
    </div>
  );
}
