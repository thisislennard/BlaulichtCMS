/* Markdown-Darstellung der Hilfe: Kapitel als nummerierte Abschnittskarten mit Inhaltsleiste, Überschriften mit
   stabilem Anker und „Link kopieren“, interne Links über den Router, Codeblöcke mit Kopierknopf, Hinweisboxen und
   Tastenkürzel (`kbd:Strg+K`). */
import { createContext, isValidElement, useContext, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import { Kbd, cx } from '../../components/ui/core';
import { CopyButton } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import { slugify, type ChapterDoc, type SubHeading } from './chapters';

/** Reiner Text eines React-Baums (für Anker und Kopierknopf). */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** Kapitel, in dem gerade gerendert wird (für kopierbare Links), und Anker der Unterüberschriften je Zeile. */
const ChapterCtx = createContext<{ slug: string | null; subs: Map<number, SubHeading> }>({ slug: null, subs: new Map() });

/** Vollständige Adresse eines Abschnitts, z. B. https://…/hilfe/verbindungen#meta-app-anlegen */
export function sectionUrl(slug: string, id: string) {
  return `${window.location.origin}/hilfe/${slug}#${id}`;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Kleiner Knopf an Überschriften: kopiert den Direktlink zum Abschnitt. */
export function CopyLink({ slug, id, title }: { slug: string; id: string; title: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <button
      type="button"
      className="help-anchor-btn print:hidden"
      data-copied={done || undefined}
      aria-label={t('help.copyLink', { title })}
      title={t('help.copyLinkShort')}
      onClick={async () => {
        await copyText(sectionUrl(slug, id));
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1800);
      }}
    >
      <Icon name={done ? 'Check' : 'Link2'} size={14} />
      <span aria-live="polite" className={done ? 'text-meta' : 'sr-only'}>
        {done ? t('help.linkCopied') : ''}
      </span>
    </button>
  );
}

function Heading({ level, line, children }: { level: 2 | 3 | 4; line?: number; children: ReactNode }) {
  const { slug, subs } = useContext(ChapterCtx);
  const text = textOf(children);
  const sub = line != null ? subs.get(line) : undefined;
  const id = sub?.id ?? slugify(text);
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <Tag id={id} className="help-heading group">
      <span>{children}</span>
      {slug && level <= 3 ? (
        <CopyLink slug={slug} id={id} title={text} />
      ) : (
        <a href={`#${id}`} className="help-anchor-btn !no-underline print:hidden" aria-label={t('help.anchorLink', { title: text })}>
          #
        </a>
      )}
    </Tag>
  );
}

function MdLink({ href = '', children }: { href?: string; children?: ReactNode }) {
  // Dateien der Oberfläche (z. B. /schema/….json) direkt laden, nicht über den Router
  if (href.startsWith('/') && /.[a-z0-9]{2,8}$/i.test(href.split(/[?#]/)[0])) return <a href={href} download>{children}</a>;
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
  [/^(Achtung|Wichtig|Vorsicht)\b/, 'var(--bc-warn)', 'var(--bc-warn-soft)', 'AlertTriangle'],
  [/^(Tipp|Gut zu wissen)\b/, 'var(--bc-ok)', 'var(--bc-ok-soft)', 'Sparkles'],
  [/^(Gefahr|Niemals|Nie)\b/, 'var(--bc-err)', 'var(--bc-err-soft)', 'XCircle'],
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
  h1: ({ children, node }) => <Heading level={2} line={node?.position?.start.line}>{children}</Heading>,
  h2: ({ children, node }) => <Heading level={2} line={node?.position?.start.line}>{children}</Heading>,
  h3: ({ children, node }) => <Heading level={3} line={node?.position?.start.line}>{children}</Heading>,
  h4: ({ children, node }) => <Heading level={4} line={node?.position?.start.line}>{children}</Heading>,
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  blockquote: ({ children }) => <Callout>{children}</Callout>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <InlineCode className={className}>{children}</InlineCode>,
  // Schrittlisten zählen per CSS-Zähler; ein abweichender Start („3.“) bleibt erhalten
  ol: ({ children, start }) => <ol style={start && start > 1 ? { counterReset: `help-step ${start - 1}` } : undefined} start={start}>{children}</ol>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-3.5">
      <table style={{ display: 'table', marginBottom: 0 }}>
        {children}
      </table>
    </div>
  ),
};

/** Überschrift eines Abschnitts: nur Inline-Auszeichnung, ohne Absatz. */
const inlineComponents: Components = { ...components, p: ({ children }) => <>{children}</> };

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cx('bc-prose help-prose', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Leiste mit allen Abschnitten des Kapitels (Pillen mit Nummer). */
export function SectionToc({ doc }: { doc: ChapterDoc }) {
  if (doc.sections.length < 2) return null;
  return (
    <nav aria-label={t('help.contents')} className="print:hidden">
      <ol className="help-toc">
        {doc.sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`}>
              <span className="help-num" aria-hidden="true">
                {s.number}
              </span>
              <span>{s.text}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Ein ganzes Kapitel: Einleitung, Inhaltsleiste und je H2 eine Karte mit Nummer. H3/H4 sind Unterthemen mit eigenem
 * Anker. Die Anker stammen aus `parseChapter` – dieselben, auf die Suche und Direktlinks zeigen.
 */
export function ChapterContent({ slug, doc }: { slug: string; doc: ChapterDoc }) {
  return (
    <ChapterCtx.Provider value={{ slug, subs: new Map() }}>
      {doc.intro && <Markdown source={doc.intro} className="help-intro" />}
      <SectionToc doc={doc} />
      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} className="help-section" aria-labelledby={`${s.id}-titel`}>
          <h2 id={`${s.id}-titel`} className="help-heading group">
            <span className="help-num" aria-hidden="true">
              {s.number}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{s.number}. </span>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>
                {s.raw}
              </ReactMarkdown>
            </span>
            <CopyLink slug={slug} id={s.id} title={s.text} />
          </h2>
          <ChapterCtx.Provider value={{ slug, subs: new Map(s.subs.map((h) => [h.line, h])) }}>
            <Markdown source={s.body} />
          </ChapterCtx.Provider>
        </section>
      ))}
    </ChapterCtx.Provider>
  );
}
