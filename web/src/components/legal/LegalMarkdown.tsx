import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cx } from '../ui/core';

/*
 * Markdown für Datenschutzerklärung und Impressum (#187). Sicher: HTML im Text wird verworfen (skipHtml, kein
 * rehype-raw), Adressen nur http(s), mailto, tel und Pfade – javascript: und data: fallen über defaultUrlTransform weg.
 * Externe Links öffnen in einem neuen Tab ohne Referrer.
 */

const SAFE = /^(https?:|mailto:|tel:|\/|#)/i;
const transform = (url: string) => {
  const u = defaultUrlTransform(url);
  return u && SAFE.test(u) ? u : '';
};

const components: Components = {
  a: ({ href = '', children }) =>
    /^https?:/i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : href ? (
      <a href={href}>{children}</a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

export function LegalMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('bc-prose bc-legal break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={transform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
