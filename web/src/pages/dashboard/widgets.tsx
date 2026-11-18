import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Card, cx, EmptyAction, EmptyLine, Rev, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative, fmtTime, getTimeZone, plural } from '../../lib/format';
import { safeHref } from '../../lib/url';
import { BADGE_TITLES, PANEL_TITLES } from './model';
import { SetupTile } from './SetupChecklist';

function List({ children }: { children: ReactNode }) {
  return <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">{children}</ul>;
}

/** Leise Zwischenüberschrift in einer Kachel (Kachel-Titel ist h2, #267). */
function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 mt-1 font-mono text-[11.5px] font-medium uppercase tracking-[0.06em] text-fg-muted">{children}</h3>;
}

const dayFmt = () => new Intl.DateTimeFormat('de-DE', { timeZone: getTimeZone(), weekday: 'short', day: '2-digit', month: '2-digit' });

/** „heute 14:00“, „Mi., 19.11. 14:00“, ganztägig ohne Uhrzeit. */
function when(e: { start: string; allDay: boolean; today?: boolean }) {
  const day = e.today ? 'heute' : dayFmt().format(new Date(e.start));
  return e.allDay ? `${day} · ganztägig` : `${day} ${fmtTime(e.start)}`;
}

const CAL_ICON: Record<string, string> = { event: 'CalendarDays', press: 'MessageSquareQuote', post: 'FileText' };
const WARN_KIND: Record<string, string> = { initial: 'Erstmeldung', update: 'Aktualisierung', all_clear: 'Entwarnung' };

/** Inhalt eines Widgets – rein darstellend, Daten kommen vom bestätigten Stand des Servers. */
export function WidgetBody({ id, d }: { id: string; d: any }) {
  // Leere Kacheln: eine leise Zeile statt eines großen Leerblocks, Aktion nur mit Recht (#266, Design §6)
  const { can } = useAuth();
  switch (id) {
    case 'media':
      return <FlowBoard d={d} />;
    case 'approvals':
      return !d.pendingApprovals?.length ? (
        <EmptyLine>Keine offenen Freigaben.</EmptyLine>
      ) : (
        <List>
          {d.pendingApprovals.map((p: any) => (
            <li key={p.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/beitraege/${p.id}`} className="font-medium truncate block">
                  {p.title}
                </Link>
                <div className="text-meta text-fg-muted">
                  <Rev n={p.number} /> · eingereicht {fmtRelative(p.submitted_at)}
                  {p.submitted_by_name ? ` von ${p.submitted_by_name}` : ''}
                </div>
              </div>
              <StatusBadge status="in_review" />
            </li>
          ))}
        </List>
      );
    case 'ready':
      return !d.readyToPublish?.length ? (
        <EmptyLine>Nichts wartet auf die Veröffentlichung.</EmptyLine>
      ) : (
        <List>
          {d.readyToPublish.map((p: any) => (
            <li key={p.id} className="py-2.5 flex items-center gap-2">
              <Link to={`/beitraege/${p.id}`} className="font-medium flex-1 truncate">
                {p.title}
              </Link>
              <span className="text-meta text-fg-muted">{p.site_id ? 'mit Website' : 'intern'}</span>
            </li>
          ))}
        </List>
      );
    case 'publications':
      return !d.publications?.length ? (
        <EmptyLine>Noch keine Veröffentlichung.</EmptyLine>
      ) : (
        <List>
          {d.publications.map((p: any) => (
            <li key={p.id} className="py-2.5 flex flex-col gap-1">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={p.status} labels={p.action === 'unpublish' ? { published: 'Zurückgezogen' } : undefined} />
                <Link to={`/beitraege/${p.post_id}`} className="font-medium">
                  {p.title}
                </Link>
                <span className="text-meta text-fg-muted">
                  {p.site_name} · <Rev n={p.revision_number} />
                </span>
              </div>
              {p.remote_url && p.action !== 'unpublish' && (
                <a href={safeHref(p.remote_url)} target="_blank" rel="noopener noreferrer" className="text-sm break-all">
                  {p.remote_url}
                </a>
              )}
              {p.error && <div className="text-sm text-err">{p.error}</div>}
              <div className="text-meta text-fg-muted">{p.result_at ? `bestätigt ${fmtDateTime(p.result_at)}` : `beauftragt ${fmtRelative(p.created_at)}`}</div>
            </li>
          ))}
        </List>
      );
    case 'uploads':
      return !d.recentCollections?.length ? (
        <EmptyLine>Keine neuen Uploads in den letzten 7 Tagen.</EmptyLine>
      ) : (
        <List>
          {d.recentCollections.map((c: any) => (
            <li key={c.id} className="py-2.5 flex items-center gap-3">
              <Icon name="Images" size={16} className="text-fg-muted" />
              <Link to={`/medien/${c.id}`} className="font-medium flex-1 truncate">
                {c.title}
              </Link>
              <span className="text-meta text-fg-muted">
                {plural(c.uploads, 'Datei', 'Dateien')} · {fmtRelative(c.last_upload)}
              </span>
            </li>
          ))}
        </List>
      );
    case 'sites':
      return !d.sites?.length ? (
        <EmptyLine action={can('channel.sites') ? <EmptyAction to="/websites">Website koppeln</EmptyAction> : undefined}>Noch keine Website gekoppelt – der interne Ablauf funktioniert auch ohne.</EmptyLine>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
          {d.sites.map((s: any) => (
            <li key={s.id} className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={s.status} labels={{ pending: 'Wartet auf Kopplung' }} />
              <span className="font-medium">{s.name}</span>
              <span className="text-fg-muted">{s.last_seen_at ? `zuletzt ${fmtRelative(s.last_seen_at)}` : 'noch nicht gemeldet'}</span>
            </li>
          ))}
        </ul>
      );
    case 'banners':
      return !d.banners?.length ? (
        <EmptyLine>Kein Banner aktiv.</EmptyLine>
      ) : (
        <List>
          {d.banners.map((b: any) => (
            <li key={b.id} className="py-2.5 flex items-center gap-2">
              <span className={cx('w-2 h-2 rounded-full shrink-0', b.tone === 'danger' ? 'bg-err' : b.tone === 'warning' ? 'bg-warn' : 'bg-fg-muted')} aria-hidden="true" />
              <Link to="/banner" className="font-medium flex-1 truncate">
                {b.title}
              </Link>
              <span className="text-meta text-fg-muted">bis {fmtTime(b.ends_at)}</span>
            </li>
          ))}
        </List>
      );
    case 'press':
      return !d.press?.open?.length ? (
        <EmptyLine>Keine offene Presseanfrage.</EmptyLine>
      ) : (
        <List>
          {d.press.open.map((r: any) => (
            <li key={r.id} className="py-2.5 flex flex-col">
              <Link to={`/presse/${r.id}`} className="font-medium truncate">
                {r.topic}
              </Link>
              <span className={cx('text-meta', r.overdue ? 'text-err' : 'text-fg-muted')}>
                {r.case_no}
                {r.outlet ? ` · ${r.outlet}` : ''}
                {r.due_at ? ` · ${r.overdue ? 'Frist überschritten' : 'Frist'} ${fmtDateTime(r.due_at)}` : ''}
                {r.assignee_name ? ` · ${r.assignee_name}` : ' · niemand zuständig'}
              </span>
            </li>
          ))}
        </List>
      );
    case 'insights':
      return !d.insights?.publications ? (
        <EmptyLine>Keine Social-Posts in den letzten 7 Tagen.</EmptyLine>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Beiträge', d.insights.publications],
              ['Aufrufe', d.insights.totals?.views],
              ['Interaktionen', d.insights.interactions],
            ].map(([label, v]) => (
              <div key={label as string} className="flex flex-col">
                <span className="text-meta text-fg-muted">{label}</span>
                <span className="font-mono tabular text-title">{typeof v === 'number' ? new Intl.NumberFormat('de-DE').format(v) : '–'}</span>
              </div>
            ))}
          </div>
          {d.insights.top?.length > 0 && (
            <List>
              {d.insights.top.map((t: any) => (
                <li key={t.post_id} className="py-2 flex items-baseline gap-2">
                  <Link to={`/beitraege/${t.post_id}`} className="font-medium flex-1 truncate">
                    {t.title}
                  </Link>
                  <span className="text-meta text-fg-muted font-mono tabular">{new Intl.NumberFormat('de-DE').format(t.interactions)} Interaktionen</span>
                </li>
              ))}
            </List>
          )}
        </div>
      );
    case 'my_drafts':
      return !d.myDrafts?.length ? (
        <EmptyLine>Keine offenen Entwürfe.</EmptyLine>
      ) : (
        <List>
          {d.myDrafts.map((p: any) => (
            <li key={p.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/beitraege/${p.id}`} className="font-medium truncate block">
                  {p.title}
                </Link>
                <div className="text-meta text-fg-muted">
                  <Rev n={p.number} /> · geändert {fmtRelative(p.updated_at)}
                </div>
              </div>
              <StatusBadge status={p.state} />
            </li>
          ))}
        </List>
      );
    case 'calendar_upcoming':
      return !d.calendar?.upcoming?.length ? (
        <EmptyLine>Keine Termine in den nächsten 7 Tagen.</EmptyLine>
      ) : (
        <List>
          {d.calendar.upcoming.map((e: any) => (
            <li key={e.key} className="py-2.5 flex items-start gap-3">
              <Icon name={CAL_ICON[e.kind] ?? 'CalendarDays'} size={16} className={cx('mt-0.5 shrink-0', e.overdue ? 'text-err' : 'text-fg-muted')} />
              <div className="min-w-0 flex-1">
                {e.link ? (
                  <Link to={e.link} className="font-medium truncate block">
                    {e.title}
                  </Link>
                ) : (
                  <span className="font-medium truncate block">{e.title}</span>
                )}
                <span className={cx('text-meta', e.overdue ? 'text-err' : 'text-fg-muted')}>
                  {e.overdue ? `Frist überschritten · ${fmtDateTime(e.start)}` : when(e)}
                  {e.location ? ` · ${e.location}` : ''}
                </span>
              </div>
            </li>
          ))}
        </List>
      );
    case 'my_press':
      return (
        <div className="flex flex-col gap-2">
          {!d.myPress?.length ? (
            <EmptyLine>Dir ist keine offene Presseanfrage zugewiesen.</EmptyLine>
          ) : (
            <List>
              {d.myPress.map((r: any) => (
                <li key={r.id} className="py-2.5 flex flex-col">
                  <Link to={`/presse/${r.id}`} className="font-medium truncate">
                    {r.topic}
                  </Link>
                  <span className={cx('text-meta flex items-center gap-1.5 flex-wrap', r.overdue ? 'text-err' : 'text-fg-muted')}>
                    {r.overdue && <Icon name="AlertTriangle" size={13} />}
                    <span className="font-mono">{r.case_no}</span>
                    {r.outlet ? ` · ${r.outlet}` : ''}
                    {r.due_at ? ` · ${r.overdue ? 'Frist überschritten' : 'Frist'} ${fmtDateTime(r.due_at)}` : ' · ohne Frist'}
                  </span>
                </li>
              ))}
            </List>
          )}
          {d.pressUnassigned > 0 && (
            <Link to="/presse" className="text-sm !text-fg-muted hover:!text-fg">
              {plural(d.pressUnassigned, 'offene Anfrage', 'offene Anfragen')} ohne Zuständigkeit →
            </Link>
          )}
        </div>
      );
    case 'warnings': {
      const w = d.warnings ?? {};
      const cases: any[] = w.cases ?? [];
      const official: any[] = w.official ?? [];
      if (!cases.length && !official.length)
        return <EmptyLine>{w.cases && w.official ? 'Kein offener Warnentwurf, keine gültige amtliche Warnung.' : w.cases ? 'Kein offener Warnentwurf.' : 'Keine gültige amtliche Warnung.'}</EmptyLine>;
      return (
        <div className="flex flex-col gap-2">
          {w.cases && (
            <>
              <SubHeading>Warnentwürfe</SubHeading>
              {cases.length ? (
                <List>
                  {cases.map((c) => (
                    <li key={c.id} className="py-2.5 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <Link to={`/warnungen/${c.id}`} className="font-medium truncate block">
                          {c.headline || WARN_KIND[c.kind] || c.case_no}
                        </Link>
                        <span className="text-meta text-fg-muted">
                          <span className="font-mono">{c.case_no}</span> · {WARN_KIND[c.kind] ?? c.kind} · Fassung {c.number}
                        </span>
                      </div>
                      <StatusBadge status={c.state} />
                    </li>
                  ))}
                </List>
              ) : (
                <p className="m-0 text-meta text-fg-muted">Kein offener Warnentwurf.</p>
              )}
            </>
          )}
          {w.official && (
            <>
              <SubHeading>Amtliche Warnungen</SubHeading>
              {official.length ? (
                <List>
                  {official.map((o) => (
                    <li key={o.id} className="py-2.5 flex flex-col">
                      <Link to="/amtliche-warnungen" className="font-medium truncate">
                        {o.headline || o.event}
                      </Link>
                      <span className="text-meta text-fg-muted">
                        {[o.event && o.headline ? o.event : '', o.in_area ? 'im eigenen Gebiet' : '', o.expires_at ? `bis ${fmtDateTime(o.expires_at)}` : `seit ${fmtRelative(o.received_at)}`].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  ))}
                </List>
              ) : (
                <p className="m-0 text-meta text-fg-muted">Keine gültige amtliche Warnung.</p>
              )}
            </>
          )}
        </div>
      );
    }
    case 'incidents':
      return !d.incidents?.items?.length ? (
        <EmptyLine>Nichts zur Freigabe, nichts freigegeben und offen, kein Übertragungsfehler.</EmptyLine>
      ) : (
        <List>
          {d.incidents.items.map((e: any) => (
            <li key={e.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/einsatzliste?eintrag=${e.id}`} className="font-medium truncate block">
                  {e.title}
                </Link>
                <span className={cx('text-meta truncate block', e.error ? 'text-err' : 'text-fg-muted')}>
                  {[e.keyword, fmtDateTime(e.alarm_at), e.error ? String(e.error).slice(0, 120) : ''].filter(Boolean).join(' · ')}
                </span>
              </div>
              <StatusBadge status={e.state} labels={{ approved: 'Freigegeben, nicht veröffentlicht' }} />
            </li>
          ))}
        </List>
      );
    case 'automations':
      return (
        <div className="flex flex-col gap-2">
          {d.automations && !d.automations.enabled && <p className="m-0 text-meta text-err flex items-center gap-1.5"><Icon name="AlertTriangle" size={13} /> Workflows sind unter Einstellungen ausgeschaltet – es starten keine Läufe.</p>}
          {!d.automations?.failed?.length ? (
            <EmptyLine>Keine fehlgeschlagenen Läufe in den letzten 7 Tagen.</EmptyLine>
          ) : (
            <List>
              {d.automations.failed.map((a: any) => (
                <li key={a.id} className="py-2.5 flex flex-col">
                  <Link to={`/workflows/${a.id}`} className="font-medium truncate">
                    {a.name}
                  </Link>
                  <span className="text-meta text-err flex items-center gap-1.5 min-w-0">
                    <Icon name="XCircle" size={13} className="shrink-0" />
                    <span className="truncate">
                      {plural(a.failures, 'Fehler', 'Fehler')} · zuletzt {fmtRelative(a.last_failed_at)}
                      {a.last_error ? ` · ${String(a.last_error).slice(0, 120)}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </List>
          )}
        </div>
      );
    case 'rss':
      return !d.rss?.length ? (
        <EmptyLine action={can('source.manage') ? <EmptyAction to="/quellen">Quelle hinzufügen</EmptyAction> : undefined}>Keine Meldungen aus Quellen.</EmptyLine>
      ) : (
        <List>
          {d.rss.map((i: any) => (
            <li key={i.id} className="py-2 flex flex-col">
              <a href={safeHref(i.link)} target="_blank" rel="noopener noreferrer" className="font-medium">
                {i.starred_at && <Icon name="Sparkles" size={12} className="inline mr-1 text-warn" />}
                {i.title}
              </a>
              <span className="text-meta text-fg-muted">
                {i.feed_title} · {i.published_at ? fmtRelative(i.published_at) : ''}
              </span>
            </li>
          ))}
        </List>
      );
  }
}


/* ------------------------------ Redaktionsfluss (Leitstand) ------------------------------ */

function FlowColumn({ title, count, hot, children }: { title: string; count: number; hot?: boolean; children?: ReactNode }) {
  return (
    <div className="flex-1 min-w-[150px] flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-0.5 pb-1">
        <span className="text-sm font-semibold">{title}</span>
        <span className={cx('font-mono text-[20px] font-medium tabular', hot && count > 0 ? 'text-primary' : 'text-fg-muted')}>{count}</span>
      </div>
      {children}
    </div>
  );
}

function FlowCard({ to, title, meta, sub, hot, cta, children }: { to: string; title: string; meta?: ReactNode; sub?: ReactNode; hot?: boolean; cta?: string; children?: ReactNode }) {
  return (
    <Link to={to} className={cx('flex flex-col gap-1.5 p-3.5 rounded-card bg-card border !text-fg transition-shadow duration-fast', hot ? 'border-primary shadow-selected' : 'border-line hover:shadow-ring')}>
      {hot && <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-primary">DU BIST DRAN</span>}
      <span className="text-sm font-semibold leading-snug">{title}</span>
      {meta && <span className="font-mono text-[11.5px] text-fg-muted">{meta}</span>}
      {sub && <span className="text-meta text-fg-muted">{sub}</span>}
      {children}
      {cta && <span className={cx('mt-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-control text-sm font-semibold', hot ? 'bg-primary-solid text-on-primary' : 'bg-card border border-line text-fg')}>{cta} →</span>}
    </Link>
  );
}

function More({ to, n }: { to: string; n: number }) {
  if (n <= 0) return null;
  return (
    <Link to={to} className="px-3 py-2 text-center text-meta !text-fg-muted hover:!text-fg border border-dashed border-line rounded-card">
      + {n} weitere
    </Link>
  );
}

/** Der Weg eines Beitrags als Spalten: Eingang → Sichtung → Freigabe → Bereit → Veröffentlicht. */
function FlowBoard({ d }: { d: any }) {
  const { can } = useAuth();
  const MAX = 3;
  const approvals: any[] = d.pendingApprovals ?? [];
  const ready: any[] = d.readyToPublish ?? [];
  const pubs: any[] = d.publications ?? [];
  const cols = d.recentCollections ?? [];
  return (
    <section aria-label="Redaktionsfluss" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3 pb-2.5 border-b border-fg">
        <h2 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em]">
          <span className="text-fg-muted">01 —</span> Redaktionsfluss
        </h2>
        <Link to="/beitraege" className="text-sm !text-fg-muted hover:!text-fg">
          Alle Beiträge →
        </Link>
      </div>
      <div className="flex flex-wrap gap-3">
        {d.media && (
          <FlowColumn title="Eingang" count={d.media.last_24h}>
            {cols.slice(0, 2).map((c: any) => (
              <FlowCard key={c.id} to={`/medien/${c.id}`} title={c.title} meta={plural(c.uploads, 'Upload', 'Uploads')} sub={c.last_upload ? fmtRelative(c.last_upload) : undefined} />
            ))}
            {!cols.length && <p className="m-0 px-0.5 text-meta text-fg-muted">Keine neuen Uploads in 24 Std.</p>}
          </FlowColumn>
        )}
        {d.media && (
          <FlowColumn title="Sichtung" count={d.media.unreviewed} hot={can('media.review')}>
            {d.media.unreviewed > 0 ? (
              <FlowCard to="/medien" title={`${plural(d.media.unreviewed, 'Datei', 'Dateien')} offen`} meta={d.media.quarantine ? `${d.media.quarantine} in Prüfung` : 'geprüft, ohne Standort'} hot={can('media.review')} cta={can('media.review') ? 'Sichten' : undefined} />
            ) : (
              <p className="m-0 px-0.5 text-meta text-fg-muted">Alles gesichtet.</p>
            )}
          </FlowColumn>
        )}
        {d.pendingApprovals && (
          <FlowColumn title="Freigabe" count={approvals.length} hot>
            {approvals.slice(0, MAX).map((p: any) => (
              <FlowCard
                key={p.id}
                to={`/beitraege/${p.id}`}
                title={p.title}
                meta={`F${p.number} · eingereicht ${fmtTime(p.submitted_at)}`}
                sub={p.submitted_by_name ? `von ${p.submitted_by_name}` : undefined}
                hot={can('approval.post')}
                cta={can('approval.post') ? 'Prüfen' : undefined}
              />
            ))}
            <More to="/freigaben" n={approvals.length - MAX} />
            {!approvals.length && <p className="m-0 px-0.5 text-meta text-fg-muted">Nichts offen.</p>}
          </FlowColumn>
        )}
        {d.readyToPublish && (
          <FlowColumn title="Bereit" count={ready.length}>
            {ready.slice(0, MAX).map((p: any) => (
              <FlowCard key={p.id} to={`/beitraege/${p.id}`} title={p.title} meta="freigegeben" sub={p.site_id ? 'mit Website' : 'intern'} />
            ))}
            <More to="/freigaben" n={ready.length - MAX} />
            {!ready.length && <p className="m-0 px-0.5 text-meta text-fg-muted">Nichts wartet.</p>}
          </FlowColumn>
        )}
        {d.publications && (
          <FlowColumn title="Veröffentlicht" count={pubs.length}>
            {pubs.slice(0, 2).map((p: any) => (
              <FlowCard key={p.id} to={`/beitraege/${p.post_id}`} title={p.title} meta={`F${p.revision_number} · ${p.result_at ? fmtTime(p.result_at) : fmtRelative(p.created_at)}`} sub={p.site_name}>
                {p.status === 'published' && p.remote_url ? (
                  <span className="flex items-center gap-1.5 text-meta text-ok">
                    <Icon name="Check" size={13} strokeWidth={2.2} /> URL bestätigt
                  </span>
                ) : (
                  <StatusBadge status={p.status} className="self-start" />
                )}
              </FlowCard>
            ))}
            <More to="/websites" n={pubs.length - 2} />
            {!pubs.length && <p className="m-0 px-0.5 text-meta text-fg-muted">Noch nichts veröffentlicht.</p>}
          </FlowColumn>
        )}
      </div>
    </section>
  );
}

const LINKS: Record<string, [string, string]> = {
  approvals: ['/freigaben', 'Alle'],
  sites: ['/websites', 'Verwalten'],
  banners: ['/banner', 'Alle'],
  rss: ['/quellen', 'Alle'],
  uploads: ['/medien', 'Alle'],
  press: ['/presse', 'Alle'],
  insights: ['/reichweite', 'Übersicht'],
  my_drafts: ['/beitraege', 'Alle Beiträge'],
  calendar_upcoming: ['/kalender', 'Kalender'],
  my_press: ['/presse', 'Alle'],
  warnings: ['/warnungen', 'Alle'],
  incidents: ['/einsatzliste', 'Alle'],
  automations: ['/workflows', 'Alle'],
};

/**
 * Anzahl unter dem Kachel-Titel: Jede Kachel nennt ihre Menge selbst – deshalb braucht die Standardansicht keine
 * Kennzahl zum selben Sachverhalt (#254).
 */
function subtitleOf(id: string, d: any): string | undefined {
  const capped = (list: any[] | undefined, cap: number) => (list ? (list.length >= cap ? `${cap}+` : String(list.length)) : null);
  switch (id) {
    case 'approvals': {
      const n = capped(d.pendingApprovals, 20);
      return n && n !== '0' ? `${n} ${n === '1' ? 'wartet' : 'warten'} auf Freigabe` : undefined;
    }
    case 'ready': {
      const n = capped(d.readyToPublish, 20);
      return n && n !== '0' ? `${n} freigegeben, noch nicht veröffentlicht` : undefined;
    }
    case 'my_drafts':
      return d.myDrafts?.length ? `${plural(d.myDrafts[0].total, 'Entwurf', 'Entwürfe')} von dir` : undefined;
    case 'calendar_upcoming':
      return d.calendar ? `${d.calendar.today} heute · ${plural(d.calendar.total, 'Eintrag', 'Einträge')} in 7 Tagen` : undefined;
    case 'my_press': {
      const total = d.myPress?.[0]?.total ?? 0;
      const overdue = (d.myPress ?? []).filter((r: any) => r.overdue).length;
      return total ? `${total} offen${overdue ? ` · ${overdue} überfällig` : ''}` : undefined;
    }
    case 'warnings': {
      const w = d.warnings ?? {};
      const parts = [w.casesTotal ? plural(w.casesTotal, 'offener Warnentwurf', 'offene Warnentwürfe') : '', w.officialTotal ? plural(w.officialTotal, 'amtliche Warnung', 'amtliche Warnungen') : ''].filter(Boolean);
      return parts.join(' · ') || undefined;
    }
    case 'incidents': {
      const c = d.incidents?.counts;
      if (!c) return undefined;
      return [c.failed ? `${c.failed} mit Fehler` : '', c.in_review ? `${c.in_review} zur Freigabe` : '', c.approved ? `${c.approved} freigegeben` : ''].filter(Boolean).join(' · ') || undefined;
    }
    case 'automations': {
      const n = (d.automations?.failed ?? []).reduce((a: number, x: any) => a + x.failures, 0);
      return n ? `${plural(n, 'fehlgeschlagener Lauf', 'fehlgeschlagene Läufe')} in 7 Tagen` : undefined;
    }
    case 'banners':
      return d.banners?.length ? plural(d.banners.length, 'Banner aktiv', 'Banner aktiv') : undefined;
  }
  return undefined;
}

/** Eine Kachel in einer Spalte. Der Redaktionsfluss bringt seine eigene Überschrift mit, alles andere ist eine Karte. */
export function PanelTile({ id, d }: { id: string; d: any }) {
  // Checkliste „startklar“ lädt ihren Stand selbst (GET /setup/checklist, nur wenn die Kachel im Layout steht)
  if (id === 'setup') return <SetupTile />;
  if (id === 'media') {
    return (
      <div className="min-w-0">
        <WidgetBody id={id} d={d} />
      </div>
    );
  }
  const link = LINKS[id];
  return (
    <Card title={PANEL_TITLES[id]} subtitle={subtitleOf(id, d)} action={link ? <Link to={link[0]} className="text-sm !text-fg-muted hover:!text-fg">{link[1]} →</Link> : undefined}>
      <WidgetBody id={id} d={d} />
    </Card>
  );
}

/* ------------------------------ Kennzahlen (obere Reihe) ------------------------------ */

interface BadgeInfo {
  value: number | null;
  /** „20+“, wenn die Liste des Servers gekappt ist */
  text: string;
  to: string;
  /** Zähler mit Handlungsbedarf für diese Person (Akzent) */
  hot: boolean;
  /** Fehlerzustand: immer mit Symbol und Text */
  error: boolean;
  hint: string;
}

/**
 * Kennzahl „Dienste“: dieselbe Abfrage wie die Statuszeile (GET /system/status, gemeinsamer Zwischenspeicher) – kein
 * zweiter Systemstatus bei jedem Dashboard-Abruf.
 */
function useServices(enabled: boolean) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['system-status-mini'], queryFn: () => get<any>('/system/status'), enabled: enabled && can('system.status'), refetchInterval: 30_000 });
  if (!q.data) return null;
  const bad = (q.data.services ?? []).filter((x: any) => x.state !== 'ok');
  return { problems: bad.length as number, error: bad.some((x: any) => x.state === 'error'), names: bad.map((x: any) => x.name as string) };
}

export function useBadgeInfo(d: any, services?: ReturnType<typeof useServices>): (id: string) => BadgeInfo {
  const { can } = useAuth();
  return (id) => {
    const capped = (list: any[] | undefined, cap: number): [number | null, string] => (list ? [list.length, list.length >= cap ? `${cap}+` : String(list.length)] : [null, '–']);
    const plain = (n: number | undefined | null): [number | null, string] => (typeof n === 'number' ? [n, String(n)] : [null, '–']);
    let v: [number | null, string] = [null, '–'];
    let to = '/';
    let hot = false;
    let error = false;
    let hint = '';
    switch (id) {
      case 'badge_approvals':
        v = capped(d.pendingApprovals, 20);
        to = '/freigaben';
        hot = can('approval.post') && (v[0] ?? 0) > 0;
        hint = 'warten auf Freigabe';
        break;
      case 'badge_unreviewed':
        v = plain(d.media?.unreviewed);
        to = '/medien';
        hot = can('media.review') && (v[0] ?? 0) > 0;
        hint = 'geprüft, noch nicht gesichtet';
        break;
      case 'badge_ready':
        v = capped(d.readyToPublish, 20);
        to = '/freigaben';
        hint = 'freigegeben';
        break;
      case 'badge_banners':
        v = capped(d.banners, 10);
        to = '/banner';
        hint = 'auf Websites sichtbar';
        break;
      case 'badge_uploads':
        v = plain(d.media?.last_24h);
        to = '/medien';
        hint = 'neue Dateien';
        break;
      case 'badge_press':
        v = plain(d.press?.counts?.open);
        to = '/presse';
        error = (d.press?.counts?.overdue ?? 0) > 0;
        hot = (d.press?.counts?.mine ?? 0) > 0;
        hint = error ? `${d.press.counts.overdue} mit überschrittener Frist` : hot ? `${d.press.counts.mine} davon dir zugewiesen` : 'neu oder in Bearbeitung';
        break;
      case 'badge_connection_errors':
        v = plain(d.connectionErrors);
        to = '/verbindungen';
        error = (v[0] ?? 0) > 0;
        hint = error ? 'Verbindung prüfen' : 'alle Verbindungen laufen';
        break;
      case 'badge_calendar_today':
        v = plain(d.calendar?.today);
        to = '/kalender';
        hint = 'Termine und Fristen';
        break;
      case 'badge_services': {
        const sv = services;
        v = sv ? [sv.problems, sv.problems ? String(sv.problems) : 'OK'] : [null, '–'];
        to = '/system';
        error = !!sv?.error;
        hot = !!sv?.problems && !sv.error;
        hint = sv?.problems ? sv.names.join(', ') : 'alle laufen';
        break;
      }
    }
    return { value: v[0], text: v[1], to, hot, error, hint };
  };
}

/** Kompakte Kennzahl: Beschriftung, große Mono-Zahl, eine leise Zeile. Die ganze Fläche führt zur passenden Seite. */
export function BadgeTile({ id, d, className }: { id: string; d: any; className?: string }) {
  const services = useServices(id === 'badge_services');
  const info = useBadgeInfo(d, services)(id);
  return (
    <Link to={info.to} data-dash-tile={id} className={cx('flex flex-col gap-0.5 min-w-0 px-4 py-3 rounded-node bg-card border border-line !text-fg transition-shadow duration-fast hover:shadow-ring', className)}>
      <span className="text-meta text-fg-muted truncate">{BADGE_TITLES[id]}</span>
      <span className={cx('font-mono text-[22px] leading-7 font-medium tabular flex items-center gap-1.5', info.error ? 'text-err' : info.hot ? 'text-primary' : 'text-fg')}>
        {info.error && <Icon name="AlertTriangle" size={16} />}
        {info.text}
      </span>
      <span className={cx('text-meta truncate', info.error ? 'text-err' : 'text-fg-muted')}>{info.hint}</span>
    </Link>
  );
}
