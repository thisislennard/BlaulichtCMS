import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router';
import { cx, Input, Notice, PageHeader } from '../../components/ui/core';
import { SaveScope } from '../../components/ui/form';
import { Icon } from '../../components/ui/Icon';
import { usePageMeta } from '../../components/layout/AppShell';
import { useAuth } from '../../lib/auth';
import { rank, searchTerms } from '../../lib/searchText';
import { useHashScroll } from '../../lib/useHashScroll';
import { LEGACY_SETTINGS_ANCHORS, SETTINGS_PAGES, settingsPage, type SettingsPageDef } from '../../config/settingsPages';
import { SETTINGS_INDEX } from '../../config/settingsIndex';
import { useSettingsQuery } from './settings/model';
import { EditorialPage, MediaPage, OrganisationPage, SecurityPage, SystemPage, WorkflowsPage } from './settings/pages';
import { PrivacyPage, RetentionPage } from './settings/Privacy';
import { MailPage } from './settings/Mail';
import { BackupPage } from './settings/Backup';
import { UpdatesPage } from './settings/Updates';

/*
 * Verwaltung → Einstellungen (#256): Übersicht unter /einstellungen, je Bereich eine Unterseite /einstellungen/<bereich>
 * mit genau einer Speichern-Leiste (SaveScope) und Warnung beim Verlassen. Frühere Anker (/einstellungen#datenschutz …)
 * leiten auf die Unterseite weiter. Persönliche Darstellung steht unter Mein Konto.
 */

const CONTENT: Record<string, () => ReactNode> = {
  organisation: () => <OrganisationPage />,
  datenschutz: () => <PrivacyPage />,
  loeschfristen: () => <RetentionPage />,
  medien: () => <MediaPage />,
  redaktion: () => <EditorialPage />,
  'e-mail': () => <MailPage />,
  sicherheit: () => <SecurityPage />,
  sicherung: () => <BackupPage />,
  updates: () => <UpdatesPage />,
  workflows: () => <WorkflowsPage />,
  system: () => <SystemPage />,
};

function useVisiblePages() {
  const { canAny } = useAuth();
  return SETTINGS_PAGES.filter((p) => !p.view || canAny(...p.view));
}

export default function Settings() {
  const { bereich } = useParams();
  const loc = useLocation();
  const { canAny } = useAuth();
  const pages = useVisiblePages();
  const page = settingsPage(bereich);
  const visible = !!page && pages.includes(page);
  usePageMeta(visible ? { title: page.label, help: page.help } : {});
  const q = useSettingsQuery();
  useHashScroll(!!q.data);

  // Frühere Anker der einen Einstellungsseite (Lesezeichen, alte Benachrichtigungen, Hilfe-Links)
  const legacy = !bereich && loc.hash ? LEGACY_SETTINGS_ANCHORS[decodeURIComponent(loc.hash.slice(1))] : undefined;
  if (legacy) return <Navigate replace to={legacy} />;
  if (bereich && !visible) return <Navigate replace to="/einstellungen" />;

  const canChange = page ? canAny(...page.edit) : true;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle={page ? page.description : 'Gilt für die ganze BlaulichtCMS-Instanz – je Bereich eine eigene Seite.'} />
      {!page ? (
        <Overview pages={pages} />
      ) : (
        <div className="flex gap-7 flex-col xl:flex-row xl:items-start">
          <aside className="hidden xl:flex xl:sticky xl:top-4 xl:w-[230px] shrink-0 flex-col gap-3">
            <SettingsFinder compact />
            <SettingsNav pages={pages} />
          </aside>
          <div className="flex-1 min-w-0 max-w-[860px] flex flex-col gap-[18px]">
            <Link to="/einstellungen" className="xl:hidden inline-flex items-center gap-1 text-sm self-start">
              <Icon name="ArrowLeft" size={14} /> Alle Einstellungen
            </Link>
            {!canChange && <Notice icon="Lock">Nur lesen: Für diesen Bereich fehlt das Recht zum Ändern.</Notice>}
            <SaveScope key={page.id} guardText={`In „${page.label}“ gibt es ungespeicherte Änderungen. Beim Verlassen gehen sie verloren.`}>
              {CONTENT[page.id]()}
            </SaveScope>
          </div>
        </div>
      )}
    </div>
  );
}

/** Linke Navigation der Unterseiten (aktiv: bg-raised + fett + rotes Symbol, Design §6). */
function SettingsNav({ pages }: { pages: SettingsPageDef[] }) {
  return (
    <nav aria-label="Einstellungsbereiche" className="flex flex-col gap-0.5">
      {pages.map((p) => (
        <NavLink
          key={p.id}
          to={`/einstellungen/${p.id}`}
          className={({ isActive }) => cx('flex items-center gap-2 h-[34px] px-2.5 rounded-control text-sm whitespace-nowrap no-underline transition-colors duration-fast', isActive ? 'bg-raised !text-fg font-semibold' : 'font-medium !text-fg-muted hover:bg-raised hover:!text-fg')}
        >
          {({ isActive }) => (
            <>
              <Icon name={p.icon} size={15} className={isActive ? 'text-primary-solid' : 'text-fg-muted'} />
              {p.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** Einstieg: alle Bereiche mit einer Zeile Beschreibung (am Handy die Liste), darüber „Einstellung finden“. */
function Overview({ pages }: { pages: SettingsPageDef[] }) {
  const { canAny } = useAuth();
  return (
    <div className="flex flex-col gap-5 max-w-[1100px]">
      <SettingsFinder />
      <ul className="m-0 p-0 list-none grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]" aria-label="Einstellungsbereiche">
        {pages.map((p) => (
          <li key={p.id}>
            <Link to={`/einstellungen/${p.id}`} className="group h-full flex items-start gap-3 p-4 rounded-card border border-line bg-card no-underline !text-fg hover:bg-raised transition-colors duration-fast">
              <span className="w-9 h-9 rounded-node bg-raised group-hover:bg-card flex items-center justify-center shrink-0 text-fg-muted">
                <Icon name={p.icon} size={17} />
              </span>
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                  {p.label}
                  {!canAny(...p.edit) && (
                    <span className="inline-flex items-center gap-1 text-meta font-normal text-fg-muted">
                      <Icon name="Lock" size={12} /> nur lesen
                    </span>
                  )}
                </span>
                <span className="text-meta text-fg-muted">{p.description}</span>
              </span>
              <Icon name="ChevronRight" size={16} className="ml-auto mt-2 shrink-0 text-fg-muted" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-fg-muted flex items-center gap-1.5 flex-wrap">
        <Icon name="User" size={14} />
        Persönliche Darstellung (Farbschema, Animationen, kompakte Tabellen) und eigene Benachrichtigungen stehen unter <Link to="/profil#darstellung">Mein Konto</Link>.
      </p>
    </div>
  );
}

/** „Einstellung finden“ (#256): filtert Bereiche und Feldbeschriftungen aus dem Einstellungs-Index (wie Strg K). */
function SettingsFinder({ compact }: { compact?: boolean }) {
  const { canAny } = useAuth();
  const [query, setQuery] = useState('');
  const hits = useMemo(() => {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    return SETTINGS_INDEX.filter((s) => !s.perm.length || canAny(...s.perm))
      .map((s) => ({ s, r: rank(terms, s.title, `${s.keywords} ${s.where}`) }))
      .filter((x) => x.r !== null)
      .sort((a, b) => a.r! - b.r!)
      .slice(0, compact ? 6 : 10)
      .map((x) => x.s);
  }, [query, canAny, compact]);
  return (
    <div role="search" className={cx('flex flex-col gap-2', !compact && 'max-w-[520px]')}>
      <label htmlFor={compact ? 'settings-find-side' : 'settings-find'} className={compact ? 'sr-only' : 'text-sm font-medium'}>
        Einstellung finden
      </label>
      <div className="relative">
        <Icon name="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
        <Input id={compact ? 'settings-find-side' : 'settings-find'} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={compact ? 'Einstellung finden' : 'z. B. Zeitzone, SMTP, Papierkorb'} className="pl-9" autoComplete="off" aria-describedby={compact ? undefined : 'settings-find-hint'} />
      </div>
      {!compact && !query && (
        <p id="settings-find-hint" className="m-0 text-meta text-fg-muted">
          Durchsucht Bereiche und Feldbeschriftungen; ein Treffer öffnet die Unterseite direkt am Feld.
        </p>
      )}
      {query.trim() && (
        <ul className="m-0 p-0 list-none flex flex-col gap-0.5 border border-line rounded-node bg-card p-1" aria-live="polite">
          {hits.length === 0 ? (
            <li className="px-2.5 py-2 text-sm text-fg-muted">Keine Einstellung gefunden.</li>
          ) : (
            hits.map((s) => (
              <li key={`${s.href}-${s.title}`}>
                <Link to={s.href} onClick={() => setQuery('')} className="flex flex-col px-2.5 py-1.5 rounded-control no-underline !text-fg hover:bg-raised">
                  <span className="text-sm font-medium">{s.title}</span>
                  <span className="text-meta text-fg-muted">{s.where}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
