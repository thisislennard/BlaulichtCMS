/* Markdown-Darstellung der Hilfe: Überschriften mit Anker, interne Links über den Router,
   Codeblöcke mit Kopierknopf, Hinweisboxen und Tastenkürzel (`kbd:Strg+K`). */
import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import { Kbd, cx } from '../../components/ui/core';
import { CopyButton } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import { slugify } from './chapters';

/** Reiner Text eines React-Baums (für Anker und Kopierknopf). */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function Heading({ level, children }: { level: 2 | 3 | 4; children: ReactNode }) {
  const text = textOf(children);
  const id = slugify(text);
  const Tag = (`h${level}` as 'h2' | 'h3' | 'h4');
  return (
    <Tag id={id} className="group scroll-mt-20">
      {children}
      <a href={`#${id}`} className="ml-2 !no-underline text-fg-muted opacity-0 group-hover:opacity-100 focus:opacity-100 print:hidden" aria-label={t('help.anchorLink', { title: text })}>
        #
      </a>
    </Tag>
  );
}

function MdLink({ href = '', children }: { href?: string; children?: ReactNode }) {
  if (href.startsWith('/')) return <Link to={href}>{children}</Link>;
  if (href.startsWith('#')) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="ExternalLink" size={12} className="inline ml-0.5 -mt-0.5" />
      <span className="sr-only"> {t('help.externalLink')}</span>
    </a>
  );
}

const TONES: [RegExp, string, string, string][] = [
  [/^(Achtung|Wichtig|Vorsicht)\b/, 'var(--ll-warn)', 'var(--ll-warn-soft)', 'AlertTriangle'],
  [/^(Tipp|Gut zu wissen)\b/, 'var(--ll-ok)', 'var(--ll-ok-soft)', 'Sparkles'],
  [/^(Gefahr|Niemals|Nie)\b/, 'var(--ll-err)', 'var(--ll-err-soft)', 'XCircle'],
];

function Callout({ children }: { children?: ReactNode }) {
  const text = textOf(children).trim();
  const tone = TONES.find(([re]) => re.test(text));
  return (
    <blockquote style={tone ? { borderLeftColor: tone[1], background: tone[2] } : undefined} className="relative">
      {children}
    </blockquote>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = textOf(children).replace(/\n$/, '');
  return (
    <div className="relative group/code mb-3.5">
      <pre className="!mb-0">{children}</pre>
      <div className="hidden sm:block absolute top-1.5 right-1.5 opacity-80 group-hover/code:opacity-100 focus-within:opacity-100 print:hidden">
        <CopyButton value={code} size="sm" label={t('help.copy')} />
      </div>
      <div className="sm:hidden flex justify-end mt-1.5 print:hidden">
        <CopyButton value={code} size="sm" label={t('help.copy')} />
      </div>
    </div>
  );
}

function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  const text = textOf(children);
  if (!className && text.startsWith('kbd:')) {
    const keys = text.slice(4).split('+');
    return (
      <span className="inline-flex items-center gap-1 align-middle whitespace-nowrap">
        {keys.map((k, i) => (
          <Kbd key={i}>{k.trim() || '+'}</Kbd>
        ))}
      </span>
    );
  }
  return <code className={className}>{children}</code>;
}

const components: Components = {
  h1: ({ children }) => <Heading level={2}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  blockquote: ({ children }) => <Callout>{children}</Callout>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <InlineCode className={className}>{children}</InlineCode>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-3.5">
      <table style={{ display: 'table', marginBottom: 0 }}>
        {children}
      </table>
    </div>
  ),
};

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cx('ll-prose help-prose', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
