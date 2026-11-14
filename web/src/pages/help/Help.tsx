/* Hilfe: Kapitelnavigation, Volltextsuche, Inhaltsverzeichnis, Referenzkapitel aus dem Katalog. */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Keyboard, Printer } from 'lucide-react';
import { Button, EmptyState, ErrorBox, Skeleton, SkeletonRows, cx } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { useAuth } from '../../lib/auth';
import { t } from '../../i18n';
import { CHAPTERS, CONTENT, GROUPS, chapterBySlug, chapterSummary, chapterTitle, groupTitle, headingsOf, type Chapter, type Heading } from './chapters';
import { Markdown } from './Markdown';
import { ReferenceChapter, referenceDocs, referenceHeadings } from './reference';
import { markdownDocs, search, type SearchHit } from './search';

/* ------------------------------------- Bausteine -------------------------------------- */

function ChapterIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  if (name === 'Keyboard') return <Keyboard size={size} strokeWidth={1.9} className={className} aria-hidden="true" />;
  return <Icon name={name} size={size} className={className} />;
}

function hitHref(h: SearchHit) {
  return `/hilfe/${h.doc.chapter}${h.doc.anchor ? `#${h.doc.anchor}` : ''}`;
}

function useSearchDocs() {
  const catalog = useCatalog();
  return useMemo(() => [...markdownDocs(), ...(catalog.data ? referenceDocs(catalog.data) : [])], [catalog.data]);
}

function HitText({ hit }: { hit: SearchHit }) {
  const s = hit.snippet;
  return (
    <span className="text-meta text-fg-muted line-clamp-2">
      {s.before}
      {s.match && <mark className="bg-primary-soft text-fg rounded-[3px] px-0.5">{s.match}</mark>}
      {s.after}
    </span>
  );
}

/** Suchfeld mit Trefferliste (Combobox): ↑↓ wählen, Enter öffnen, Esc schließen. */
function SearchBox({ large, wide, autoFocus, onNavigate }: { large?: boolean; wide?: boolean; autoFocus?: boolean; onNavigate?: () => void }) {
  const docs = useSearchDocs();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hits = useMemo(() => search(q, docs, 50), [q, docs]);
  const shown = hits.slice(0, 8);

  useEffect(() => {
    // „/“ springt in die Hilfesuche (nur wenn gerade kein Eingabefeld aktiv ist)
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && inputRef.current?.offsetParent) {
        e.preventDefault();
        inputRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
    onNavigate?.();
    navigate(href);
  };
  const showAll = () => go(`/hilfe?suche=${encodeURIComponent(q.trim())}`);

  return (
    <div className="relative print:hidden" role="search">
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t('help.searchLabel')}
      </label>
      <div className="relative">
        <Icon name="Search" size={large ? 18 : 15} className={cx('absolute top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none', large ? 'left-3.5' : 'left-2.5')} />
        <input
          id={`${listId}-input`}
          ref={inputRef}
          type="search"
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && q.trim().length >= 2}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${listId}-opt-${active}` : undefined}
          value={q}
          placeholder={t('help.searchPlaceholder')}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, shown.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (active < shown.length && shown[active]) go(hitHref(shown[active]));
              else if (q.trim().length >= 2) showAll();
            } else if (e.key === 'Escape') {
              if (q) setQ('');
              else inputRef.current?.blur();
              setOpen(false);
            }
          }}
          className={cx(
            'w-full bg-bg border border-line rounded-control text-fg placeholder:text-fg-muted focus:outline-none focus:border-primary focus:shadow-[var(--ll-ring)]',
            large ? 'h-12 pl-11 pr-12 text-base' : 'h-ctl pl-8 pr-8 text-sm',
          )}
        />
        {!q && (
          <span className={cx('absolute top-1/2 -translate-y-1/2 pointer-events-none hidden sm:inline-flex', large ? 'right-3.5' : 'right-2')}>
            <kbd className="inline-flex items-center h-5 px-1.5 rounded-[5px] border border-line bg-raised font-mono text-[11px] text-fg-muted">/</kbd>
          </span>
        )}
      </div>
      {open && q.trim().length >= 2 && (
        <div className={cx('absolute z-30 left-0 mt-1.5 rounded-card border border-line bg-card shadow-[var(--ll-shadow-float)] overflow-hidden', wide ? 'w-[440px] max-w-[calc(100vw-32px)]' : 'right-0')}>
          <ul id={`${listId}-list`} role="listbox" aria-label={t('help.results')} className="m-0 p-1 list-none max-h-[420px] overflow-auto">
            {shown.length === 0 && <li className="px-3 py-3 text-sm text-fg-muted">{t('help.noResults', { q: q.trim() })}</li>}
            {shown.map((h, i) => (
              <li
                key={`${h.doc.chapter}-${h.doc.anchor}`}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hitHref(h))}
                className={cx('px-3 py-2 rounded-control cursor-pointer flex flex-col gap-0.5', i === active && 'bg-raised')}
              >
                <span className="text-sm font-medium text-fg">
                  {chapterTitle(h.doc.chapter)}
                  {h.doc.anchor && <span className="text-fg-muted font-normal"> › {h.doc.heading}</span>}
                </span>
                <HitText hit={h} />
              </li>
            ))}
            {hits.length > shown.length && (
              <li
                id={`${listId}-opt-${shown.length}`}
                role="option"
                aria-selected={active === shown.length}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(shown.length)}
                onClick={showAll}
                className={cx('px-3 py-2 rounded-control cursor-pointer text-sm text-fg-link', active === shown.length && 'bg-raised')}
              >
                {t('help.allResults', { n: hits.length })}
              </li>
            )}
          </ul>
          <div className="border-t border-line px-3 py-1.5 text-meta text-fg-muted">{t('help.searchKeys')}</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------- Navigation -------------------------------------- */

function ChapterNav() {
  return (
    <nav aria-label={t('help.chapterNav')} className="flex flex-col gap-4">
      {GROUPS.map((g) => (
        <div key={g.id} className="flex flex-col gap-0.5">
          <div className="text-label uppercase tracking-[0.06em] text-fg-muted font-semibold px-2.5 pb-1">{groupTitle(g.id)}</div>
          {g.chapters.map((c) => (
            <NavLink
              key={c.slug}
              to={`/hilfe/${c.slug}`}
              className={({ isActive }) =>
                cx('flex items-center gap-2.5 min-h-[32px] px-2.5 py-1 rounded-control text-sm', isActive ? 'bg-primary-soft !text-fg font-medium' : '!text-fg-muted hover:bg-raised hover:!text-fg')
              }
            >
              <ChapterIcon name={c.icon} size={15} className="shrink-0" />
              <span className="min-w-0">{chapterTitle(c.slug)}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function MobileChapterSelect({ current }: { current?: string }) {
  const navigate = useNavigate();
  const id = useId();
  return (
    <div className="lg:hidden flex flex-col gap-1.5 print:hidden">
      <label htmlFor={id} className="text-sm font-medium">
        {t('help.chapter')}
      </label>
      <select id={id} value={current ?? ''} onChange={(e) => navigate(e.target.value ? `/hilfe/${e.target.value}` : '/hilfe')} className="h-field w-full rounded-control border border-line bg-bg text-fg px-3 text-sm">
        <option value="">{t('help.startPage')}</option>
        {GROUPS.map((g) => (
          <optgroup key={g.id} label={groupTitle(g.id)}>
            {g.chapters.map((c) => (
              <option key={c.slug} value={c.slug}>
                {chapterTitle(c.slug)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const onScroll = () => {
      let cur: string | null = null;
      for (const h of headings) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top < 140) cur = h.id;
      }
      setActive(cur);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
    };
  }, [headings]);
  if (headings.length < 2) return null;
  return (
    <nav aria-label={t('help.toc')} className="flex flex-col gap-1 text-sm">
      <div className="text-label uppercase tracking-[0.06em] text-fg-muted font-semibold pb-1">{t('help.toc')}</div>
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          aria-current={active === h.id ? 'location' : undefined}
          className={cx('!no-underline border-l-2 py-0.5 leading-snug', h.level === 3 ? 'pl-5 text-meta' : 'pl-3', active === h.id ? 'border-primary !text-fg' : 'border-transparent !text-fg-muted hover:!text-fg')}
        >
          {h.text}
        </a>
      ))}
    </nav>
  );
}

/** Springt zum Anker in der Adresse, sobald der Inhalt da ist. */
function useHashScroll(ready: boolean, key: string) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready) return;
    if (!hash) {
      window.scrollTo({ top: 0 });
      document.getElementById('main')?.scrollTo?.({ top: 0 });
      return;
    }
    const id = decodeURIComponent(hash.slice(1));
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        if (el instanceof HTMLElement) {
          el.setAttribute('tabindex', '-1');
          el.focus({ preventScroll: true });
        }
      } else if (tries++ < 20) setTimeout(tick, 50);
    };
    tick();
  }, [ready, hash, key]);
}

/* --------------------------------------- Kapitel --------------------------------------- */

function PrevNext({ slug }: { slug: string }) {
  const i = CHAPTERS.findIndex((c) => c.slug === slug);
  const prev = i > 0 ? CHAPTERS[i - 1] : null;
  const next = i >= 0 && i < CHAPTERS.length - 1 ? CHAPTERS[i + 1] : null;
  const card = (c: Chapter, dir: 'prev' | 'next') => (
    <Link to={`/hilfe/${c.slug}`} className={cx('flex-1 min-w-[200px] border border-line rounded-card p-3.5 !no-underline hover:bg-raised flex flex-col gap-0.5', dir === 'next' && 'text-right')}>
      <span className="text-meta text-fg-muted">{dir === 'prev' ? `← ${t('help.prev')}` : `${t('help.next')} →`}</span>
      <span className="text-sm font-medium !text-fg">{chapterTitle(c.slug)}</span>
    </Link>
  );
  return (
    <nav aria-label={t('help.pager')} className="flex gap-3 flex-wrap mt-8 print:hidden">
      {prev ? card(prev, 'prev') : <span className="flex-1" />}
      {next ? card(next, 'next') : <span className="flex-1" />}
    </nav>
  );
}

function ChapterView({ chapter }: { chapter: Chapter }) {
  const catalog = useCatalog();
  const md = CONTENT[chapter.slug] ?? '';
  const headings = useMemo<Heading[]>(() => {
    if (chapter.reference) return catalog.data ? referenceHeadings(chapter.reference, catalog.data) : [];
    return headingsOf(md);
  }, [chapter, md, catalog.data]);
  const ready = !chapter.reference || !!catalog.data;
  useHashScroll(ready, chapter.slug);

  let body: ReactNode;
  if (chapter.reference) {
    if (catalog.isLoading) body = <SkeletonRows rows={8} />;
    else if (catalog.error || !catalog.data)
      body = (
        <ErrorBox title={t('help.catalogError')} actions={<Button size="sm" icon="RefreshCw" onClick={() => catalog.refetch()}>{t('help.retry')}</Button>}>
          {t('help.catalogErrorText')}
        </ErrorBox>
      );
    else body = <ReferenceChapter kind={chapter.reference} catalog={catalog.data} />;
  } else body = <Markdown source={md} />;

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_210px]">
      <article id="help-article" className="min-w-0 max-w-[820px]" aria-labelledby="help-title">
        <header className="flex flex-col gap-2 mb-6 pb-5 border-b border-line">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-meta text-fg-muted">
              <Link to="/hilfe" className="!text-fg-muted hover:!text-fg">
                {t('help.title')}
              </Link>
              <span aria-hidden="true">›</span>
              <span>{groupTitle(chapter.group)}</span>
            </div>
            <button type="button" onClick={() => window.print()} className="print:hidden inline-flex items-center gap-1.5 h-ctl-sm px-2.5 rounded-control border border-line text-sm text-fg-muted hover:bg-raised hover:text-fg">
              <Printer size={14} aria-hidden="true" />
              {t('help.print')}
            </button>
          </div>
          <h1 id="help-title" className="m-0 text-page font-semibold tracking-[-0.02em] flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-node bg-primary-soft text-fg-link shrink-0 print:hidden">
              <ChapterIcon name={chapter.icon} size={18} />
            </span>
            {chapterTitle(chapter.slug)}
          </h1>
          <p className="m-0 text-fg-muted text-base">{chapterSummary(chapter.slug)}</p>
        </header>
        {body}
        <PrevNext slug={chapter.slug} />
      </article>
      <aside className="hidden xl:block print:hidden">
        <div className="sticky top-20 max-h-[calc(100vh-110px)] overflow-auto pb-4">{ready ? <Toc headings={headings} /> : <Skeleton className="h-40" />}</div>
      </aside>
    </div>
  );
}

/* -------------------------------------- Startseite ------------------------------------- */

const TILES: [string, string][] = [
  ['erste-schritte', 'Sparkles'],
  ['workflows', 'Workflow'],
  ['alamos-fe2', 'Siren'],
  ['wordpress', 'Megaphone'],
  ['fehlerbehebung', 'LifeBuoy'],
  ['betrieb', 'Server'],
];

const FAQ_COUNT = 8;

function StartPage() {
  const { me } = useAuth();
  const first = me?.user.name?.split(' ')[0];
  useHashScroll(true, 'start');
  return (
    <div className="flex flex-col gap-8 max-w-[1000px]">
      <section className="rounded-card border border-line bg-card p-6 md:p-8 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-page font-semibold tracking-[-0.02em]">{first ? t('help.welcomeName', { name: first }) : t('help.welcome')}</h1>
          <p className="m-0 text-fg-muted text-base max-w-[640px]">{t('help.welcomeText')}</p>
        </div>
        <SearchBox large />
        <p className="m-0 text-meta text-fg-muted">
          {t('help.searchExamples')}{' '}
          {['HMAC', 'Banner', 'Wiederholen', '2FA', 'Sicherung'].map((w, i) => (
            <span key={w}>
              {i > 0 && ', '}
              <Link to={`/hilfe?suche=${encodeURIComponent(w)}`}>{w}</Link>
            </span>
          ))}
        </p>
      </section>

      <section aria-labelledby="help-tiles" className="flex flex-col gap-3">
        <h2 id="help-tiles" className="m-0 text-section font-semibold">
          {t('help.popular')}
        </h2>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {TILES.map(([slug, icon]) => (
            <Link key={slug} to={`/hilfe/${slug}`} className="group border border-line rounded-card bg-card p-4 flex gap-3 !no-underline hover:bg-raised hover:border-primary/50">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-node bg-primary-soft text-fg-link shrink-0">
                <ChapterIcon name={icon} size={19} />
              </span>
              <span className="flex flex-col gap-1 min-w-0">
                <span className="font-semibold !text-fg">{t(`help.tiles.${slug}.title`)}</span>
                <span className="text-sm text-fg-muted">{t(`help.tiles.${slug}.text`)}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="help-faq" className="flex flex-col gap-3">
        <h2 id="help-faq" className="m-0 text-section font-semibold">
          {t('help.faqTitle')}
        </h2>
        <div className="rounded-card border border-line bg-card divide-y divide-[var(--ll-border)]">
          {Array.from({ length: FAQ_COUNT }, (_, i) => i + 1).map((n) => (
            <details key={n} className="group px-4 py-3">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 font-medium text-sm focus-visible:outline-none focus-visible:shadow-[var(--ll-ring)] rounded-control">
                {t(`help.faq.${n}.q`)}
                <Icon name="ChevronDown" size={16} className="text-fg-muted shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="pt-2 text-sm text-fg-muted flex flex-col gap-2">
                <p className="m-0">{t(`help.faq.${n}.a`)}</p>
                <Link to={t(`help.faq.${n}.link`)} className="self-start">
                  {t('help.readMore')} →
                </Link>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section aria-labelledby="help-all" className="flex flex-col gap-3">
        <h2 id="help-all" className="m-0 text-section font-semibold">
          {t('help.allChapters')}
        </h2>
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.id} className="flex flex-col gap-1.5">
              <h3 className="m-0 text-label uppercase tracking-[0.06em] text-fg-muted font-semibold">{groupTitle(g.id)}</h3>
              <ul className="m-0 p-0 list-none flex flex-col gap-1">
                {g.chapters.map((c) => (
                  <li key={c.slug}>
                    <Link to={`/hilfe/${c.slug}`} className="text-sm">
                      {chapterTitle(c.slug)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SearchResults({ q }: { q: string }) {
  const docs = useSearchDocs();
  const hits = useMemo(() => search(q, docs, 100), [q, docs]);
  return (
    <div className="flex flex-col gap-5 max-w-[820px]">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-page font-semibold tracking-[-0.02em]">{t('help.resultsFor', { q })}</h1>
        <p className="m-0 text-fg-muted">{t('help.resultCount', { n: hits.length })}</p>
      </div>
      <SearchBox />
      {hits.length === 0 ? (
        <EmptyState icon="Search" title={t('help.noResultsTitle')} text={t('help.noResultsText')} action={<Link to="/hilfe/fehlerbehebung">{t('help.toFaq')}</Link>} />
      ) : (
        <ol className="m-0 p-0 list-none flex flex-col gap-2">
          {hits.map((h) => (
            <li key={`${h.doc.chapter}-${h.doc.anchor}`}>
              <Link to={hitHref(h)} className="block border border-line rounded-card bg-card p-3.5 !no-underline hover:bg-raised">
                <span className="block text-sm font-medium !text-fg">
                  {chapterTitle(h.doc.chapter)}
                  {h.doc.anchor && <span className="text-fg-muted font-normal"> › {h.doc.heading}</span>}
                </span>
                <HitText hit={h} />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ---------------------------------------- Seite ---------------------------------------- */

const HELP_CSS = `
.help-prose ul:not(.list-none) { list-style: disc; }
.help-prose ol { list-style: decimal; }
.help-prose li::marker { color: var(--ll-text-2); }
.help-prose h4 { font-size: 13.5px; font-weight: 600; margin: 18px 0 8px; }
@media (min-width: 640px) { .help-prose pre { padding-right: 104px; } }
.help-prose td > p:last-child { margin-bottom: 0; }
#help-article [tabindex='-1']:focus { outline: none; box-shadow: none; }
.help-prose input[type=checkbox] { margin-right: 6px; vertical-align: -1px; }
.help-prose li:has(> input[type=checkbox]) { list-style: none; margin-left: -18px; }
@media print {
  body * { visibility: hidden !important; }
  #help-article, #help-article * { visibility: visible !important; color: black !important; background: transparent !important; box-shadow: none !important; }
  #help-article { position: absolute; left: 0; top: 0; width: 100%; max-width: none; }
  #help-article pre, #help-article th, #help-article td, #help-article blockquote, #help-article section { border-color: #999 !important; }
  #help-article a { text-decoration: none !important; }
}`;

export default function Help() {
  const { chapter: slug } = useParams();
  const [params] = useSearchParams();
  const q = params.get('suche')?.trim() ?? '';
  const chapter = chapterBySlug(slug);

  let main: ReactNode;
  if (slug && !chapter) {
    main = <EmptyState icon="BookOpen" title={t('help.notFound')} text={t('help.notFoundText')} action={<Link to="/hilfe">{t('help.backToStart')}</Link>} />;
  } else if (chapter) main = <ChapterView key={chapter.slug} chapter={chapter} />;
  else if (q) main = <SearchResults q={q} />;
  else main = <StartPage />;

  return (
    <div className="grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8">
      <style>{HELP_CSS}</style>
      <aside className="hidden lg:block print:hidden">
        <div className="sticky top-20 flex flex-col gap-4">
          <div className="relative z-20">
            <SearchBox wide />
          </div>
          <div className="max-h-[calc(100vh-170px)] overflow-auto pr-1 pb-6">
            <ChapterNav />
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex flex-col gap-5">
        <MobileChapterSelect current={chapter?.slug} />
        {chapter && (
          <div className="lg:hidden">
            <SearchBox />
          </div>
        )}
        {main}
      </div>
    </div>
  );
}
