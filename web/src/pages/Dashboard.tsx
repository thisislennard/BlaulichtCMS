import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../api/client';
import { Button, EmptyState, ErrorBox, Notice, PageHeader, SkeletonRows } from '../components/ui/core';
import { UnsavedChangesGuard, useErrorToast, useToast } from '../components/ui/overlays';
import { useAuth } from '../lib/auth';
import { fmtTime, getTimeZone } from '../lib/format';
import { useLive } from '../lib/live';
import { NewCollectionDialog } from './media/Collections';
import { NewPostDialog } from './posts/Posts';
import { columnStyle, fromEdit, isPanel, sameLayout, toEdit, type EditLayout, type Layout, type LayoutResponse } from './dashboard/model';
import { BadgeTile, PanelTile } from './dashboard/widgets';
import { WelcomeCard } from './dashboard/Welcome';
import { useSetupChecklist } from './dashboard/SetupChecklist';

// Bearbeitungsmodus (Drag-and-drop) erst laden, wenn „Anpassen“ gewählt wird – hält die Startseite schlank
const loadEditor = () => import('./dashboard/Editor');
const DashboardEditor = lazy(loadEditor);

/** Mitgelieferte Rollen als Rückfall; im Regelfall liefert der Server die Rollen (auch eigene) mit dem Layout. */
const BUILTIN_ROLES = [
  { id: 'platform_admin', label: 'Administration' },
  { id: 'editor', label: 'Redaktion' },
  { id: 'media_manager', label: 'Medienverwaltung' },
  { id: 'approver', label: 'Freigabe' },
  { id: 'publisher', label: 'Veröffentlichung' },
  { id: 'viewer', label: 'Lesezugriff' },
];

function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return m;
}

function greeting(name?: string) {
  // Stunde in der Zeitzone der Instanz (wie alle Zeitangaben der Oberfläche)
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: getTimeZone(), hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const g = h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  return name ? `${g}, ${name}.` : 'Übersicht';
}

/**
 * Zeile unter der Begrüßung: nur Vorgänge, die die Person selbst erledigen darf (#254) – Freigaben nur mit
 * Freigaberecht, ungesichtete Dateien nur mit Sichtungsrecht, Presse-Fristen nur für die eigenen Anfragen.
 */
function summary(d: any, can: (perm: string) => boolean) {
  const parts: string[] = [];
  const a = d.pendingApprovals?.length ?? 0;
  const u = d.media?.unreviewed ?? 0;
  const late = (d.myPress ?? []).filter((r: any) => r.overdue).length;
  const review = (d.warnings?.cases ?? []).filter((c: any) => c.state === 'in_review').length;
  if (can('approval.post') && a) parts.push(a === 1 ? 'eine Freigabe wartet auf dich' : `${a >= 20 ? 'mehr als 20' : a} Freigaben warten auf dich`);
  if (can('warning.approve') && review) parts.push(review === 1 ? 'ein Warnentwurf wartet auf Freigabe' : `${review} Warnentwürfe warten auf Freigabe`);
  if (can('media.review') && u) parts.push(u === 1 ? 'eine Datei ist ungesichtet' : `${u} Dateien sind ungesichtet`);
  if ((can('press.manage') || can('press.reply')) && late) parts.push(late === 1 ? 'bei einer deiner Presseanfragen ist die Frist überschritten' : `bei ${late} deiner Presseanfragen ist die Frist überschritten`);
  if (!parts.length) return 'Alles ruhig – nichts wartet auf dich.';
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

/** Anzeige ohne Bearbeitung: Kennzahlen oben, darunter die Spalten (am Handy die eigene Reihenfolge untereinander). */
function DashboardView({ layout, available: all, d, mobile }: { layout: Layout; available: string[]; d: any; mobile: boolean }) {
  // Checkliste „startklar“: nur solange ein Punkt offen und nicht ausgeblendet ist (#255)
  const setup = useSetupChecklist(all.includes('setup') && [...layout.columns.flatMap((c) => c.widgets), ...layout.mobile].includes('setup'));
  const available = setup.data && !setup.data.visible ? all.filter((id) => id !== 'setup') : all;
  const badges = layout.badges.filter((id) => available.includes(id));
  const columns = layout.columns.map((c) => ({ weight: c.weight, widgets: c.widgets.filter((id) => available.includes(id)) })).filter((c) => c.widgets.length);
  const mobileList = layout.mobile.filter((id) => available.includes(id) && isPanel(id));
  const empty = mobile ? !mobileList.length : !columns.length;
  return (
    <>
      {badges.length > 0 && (
        <section aria-label="Kennzahlen" className="grid grid-cols-2 sm:flex sm:flex-wrap gap-3">
          {badges.map((id) => (
            <BadgeTile key={id} id={id} d={d} className="sm:flex-1 sm:min-w-[150px]" />
          ))}
        </section>
      )}
      {mobile ? (
        <div className="flex flex-col gap-5">
          {mobileList.map((id) => (
            <div key={id} data-dash-tile={id} className="min-w-0">
              <PanelTile id={id} d={d} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          {columns.map((c, i) => (
            <div key={i} data-dash-view-column={c.weight} style={columnStyle(c.weight)} className="flex flex-col gap-5 min-w-0">
              {c.widgets.map((id) => (
                <div key={id} data-dash-tile={id} className="min-w-0">
                  <PanelTile id={id} d={d} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {empty && !badges.length && <EmptyState icon="LayoutDashboard" title="Keine Widgets" text="Über „Anpassen“ Widgets hinzufügen." />}
    </>
  );
}

export default function Dashboard() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const live = useLive();
  const isMobile = useIsMobile();
  const canTemplates = can('dashboard.templates');
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard'), refetchInterval: live === 'live' ? 120_000 : 15_000, refetchOnWindowFocus: true });
  const lq = useQuery({ queryKey: ['dashboard-layout'], queryFn: () => get<LayoutResponse>('/dashboard/layout') });
  const [newPost, setNewPost] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  // Arbeitskopie: beim Einstieg aus dem gespeicherten Stand erzeugt; „Abbrechen“ verwirft sie und zeigt wieder exakt den alten Stand
  const [draft, setDraft] = useState<EditLayout | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!draft;
  const rq = useQuery({ queryKey: ['roles'], queryFn: () => get<{ roles: { id: string; label: string }[] }>('/roles'), enabled: editing && canTemplates && can('user.view') && !lq.data?.templateRoles, staleTime: 60_000 });
  const first = me?.user.name.split(' ')[0];

  // Schnellzugriffe der installierten App: /?aktion=beitrag bzw. /?aktion=medien
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    const a = sp.get('aktion');
    if (a === 'beitrag' && can('post.create')) setNewPost(true);
    if (a === 'medien' && can('media.collections')) setNewCollection(true);
    if (a) setSp({}, { replace: true });
  }, [sp, setSp, can]);

  const available = lq.data?.widgets ?? [];
  const saved = lq.data?.layout ?? null;
  const dirty = useMemo(() => !!draft && !!saved && !sameLayout(fromEdit(draft), saved), [draft, saved]);
  const d = q.data ?? {};

  const startEdit = () => {
    if (!saved) return;
    void loadEditor();
    setDraft(toEdit(saved));
  };
  const save = async (scope: 'personal' | 'role' | 'all', role: string | undefined, layout: Layout | null) => {
    setBusy(true);
    try {
      await put('/dashboard/layout', { scope, role, layout });
      toast({ tone: 'success', title: scope === 'personal' ? (layout ? 'Dashboard gespeichert' : 'Standard wiederhergestellt') : layout ? 'Dashboard-Vorlage gespeichert' : 'Dashboard-Vorlage entfernt' });
      await qc.invalidateQueries({ queryKey: ['dashboard-layout'] });
      if (scope === 'personal') setDraft(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const saveTemplate = (target: string, layout: Layout | null) => save(target === '*' ? 'all' : 'role', target === '*' ? undefined : target, layout);

  const view = q.data && saved ? <DashboardView layout={saved} available={available} d={d} mobile={isMobile} /> : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={greeting(first)}
        subtitle={
          <span>
            {q.data ? summary(d, can) : me?.instance.organization}
            {d.confirmedAt && <span className="font-mono text-[12px] text-fg-muted"> · Stand {fmtTime(d.confirmedAt, true)}</span>}
          </span>
        }
        actions={
          !editing ? (
            <>
              {can('media.collections') && (
                <Button icon="Camera" onClick={() => setNewCollection(true)}>
                  Fotos sammeln
                </Button>
              )}
              {can('post.create') && (
                <Button variant="primary" icon="Plus" onClick={() => setNewPost(true)}>
                  Neuer Beitrag
                </Button>
              )}
              {saved && (
                <Button icon="LayoutDashboard" onClick={startEdit} aria-label="Dashboard anpassen">
                  <span className="hidden sm:inline">Anpassen</span>
                </Button>
              )}
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => setDraft(null)}>
                Abbrechen
              </Button>
              {lq.data?.source === 'personal' && (
                // Persönliche Anpassung aufheben: dann gilt die Dashboard-Vorlage der Administration bzw. die
                // mitgelieferte Standardansicht der Rolle (#254)
                <Button disabled={busy} icon="RotateCcw" onClick={() => save('personal', undefined, null)}>
                  Standard wiederherstellen
                </Button>
              )}
              <Button variant="primary" icon="Save" loading={busy} onClick={() => draft && save('personal', undefined, fromEdit(draft))}>
                Für mich speichern
              </Button>
            </>
          )
        }
      />
      {/* Einmalige Begrüßung neuer Konten (#255); die Administration hat stattdessen die Checkliste „startklar“ */}
      {!editing && me && me.user.preferences.welcomeDone !== true && !can('settings.general') && lq.data && <WelcomeCard profile={lq.data.profile} />}
      {live === 'reconnecting' && <Notice tone="warning">Verbindung unterbrochen. Angezeigt wird der zuletzt bestätigte Stand; nach der Wiederverbindung wird neu geladen.</Notice>}
      {(q.isLoading || lq.isLoading) && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Dashboard konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {lq.error && <ErrorBox title="Dashboard-Layout konnte nicht geladen werden">{(lq.error as Error).message}</ErrorBox>}
      {draft && q.data ? (
        // Bis der Bearbeitungsmodus geladen ist, bleibt die normale Ansicht stehen (kein Springen)
        <Suspense fallback={view}>
          <DashboardEditor
            draft={draft}
            onChange={(fn) => setDraft((l) => (l ? fn(l) : l))}
            available={available}
            d={d}
            templates={canTemplates ? { roles: lq.data?.templateRoles ?? rq.data?.roles ?? BUILTIN_ROLES, existing: lq.data?.templates ?? [], busy, onSave: (t) => saveTemplate(t, fromEdit(draft)), onRemove: (t) => saveTemplate(t, null) } : undefined}
          />
        </Suspense>
      ) : (
        view
      )}
      <UnsavedChangesGuard when={dirty} text="Die Änderungen am Dashboard sind noch nicht gespeichert und gehen verloren." />
      {newPost && <NewPostDialog onClose={() => setNewPost(false)} />}
      {newCollection && <NewCollectionDialog open title="Fotos sammeln" onClose={() => setNewCollection(false)} />}
    </div>
  );
}
