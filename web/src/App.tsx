import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useRouteError, type RouteObject } from 'react-router';
import { AppShell, RequirePerm } from './components/layout/AppShell';
import { LinkButton, SkeletonRows } from './components/ui/core';
import { useAuth } from './lib/auth';
import { InvitePage, LoginPage, MfaSetupPage, MfaVerifyPage, SetupPage } from './pages/auth/AuthPages';
import { UploadPage } from './pages/public/UploadPage';
import { LiveProvider } from './lib/live';
import { CrashView, FeedbackPage, FeedbackView, feedbackFor } from './components/feedback/Feedback';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Activities = lazy(() => import('./pages/Activities'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Posts = lazy(() => import('./pages/posts/Posts'));
const PostEditor = lazy(() => import('./pages/posts/PostEditor'));
const Templates = lazy(() => import('./pages/posts/Templates'));
const Banners = lazy(() => import('./pages/banners/Banners'));
const Sources = lazy(() => import('./pages/sources/Sources'));
const Collections = lazy(() => import('./pages/media/Collections'));
const CollectionDetail = lazy(() => import('./pages/media/CollectionDetail'));
const MediaSearch = lazy(() => import('./pages/media/MediaSearch'));
const Trash = lazy(() => import('./pages/media/Trash'));
const MediaAdmin = lazy(() => import('./pages/media/MediaAdmin'));
const DesignEditor = lazy(() => import('./pages/media/DesignEditor'));
const Sites = lazy(() => import('./pages/channels/Sites'));
const Users = lazy(() => import('./pages/admin/Users'));
const SystemStatus = lazy(() => import('./pages/admin/SystemStatus'));
const Logs = lazy(() => import('./pages/admin/Logs'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const PrivacyRequests = lazy(() => import('./pages/admin/PrivacyRequests'));
const Warnings = lazy(() => import('./pages/warnings/Warnings'));
const WarningCase = lazy(() => import('./pages/warnings/WarningCase'));
const WarningConfig = lazy(() => import('./pages/warnings/WarningConfig'));
const Connections = lazy(() => import('./pages/connections/Connections'));
const ConnectionDetail = lazy(() => import('./pages/connections/ConnectionDetail'));
const OfficialWarnings = lazy(() => import('./pages/connections/Connections').then((m) => ({ default: m.OfficialWarnings })));
const Automations = lazy(() => import('./pages/automations/Automations'));
const AutomationEditor = lazy(() => import('./pages/automations/Editor'));
const AutomationInputs = lazy(() => import('./pages/automations/Inputs'));
const AutomationOutputs = lazy(() => import('./pages/automations/Outputs'));
const Help = lazy(() => import('./pages/help/Help'));
const PrintSheet = lazy(() => import('./pages/print/PrintSheet'));
const InstallApp = lazy(() => import('./pages/InstallApp'));
const LegalPage = lazy(() => import('./pages/public/LegalPage'));

function Loading() {
  return <SkeletonRows rows={6} className="pt-2" />;
}

/** Sitzung nicht prüfbar (Server weg, Zeitüberschreitung, Wartung): erklären und selbst erneut versuchen (#194). */
function SessionUnavailable() {
  const { error, retry } = useAuth();
  return <FeedbackPage {...feedbackFor(error)} onRetry={retry} autoRetry />;
}

/** Fehler beim Darstellen oder Laden einer Seite (Router-Fehlergrenze), z. B. fehlende Programmteile nach Update. */
function RouteError({ page }: { page?: boolean }) {
  const error = useRouteError();
  return <CrashView error={error} page={page} />;
}

/** Unbekannte Adresse innerhalb der App. */
function NotFound() {
  return <FeedbackView kind="notfound" actions={<LinkButton to="/" variant="primary" icon="LayoutDashboard">Zur Übersicht</LinkButton>} />;
}

/** Nur mit vollständiger Anmeldung; sonst Login bzw. 2FA. */
function Protected({ children }: { children: ReactNode }) {
  const { me, loading, error } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (error) return <SessionUnavailable />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search + loc.hash }} />;
  if (me.stage === 'mfa') return <Navigate to="/2fa" replace />;
  if (me.stage === 'mfa_setup') return <Navigate to="/2fa/einrichten" replace />;
  return <>{children}</>;
}

/** Anmeldeseiten passend zum Sitzungsstand: angemeldet → App, ohne Sitzung → Anmeldung. */
function AuthStage({ need, children }: { need: 'none' | 'mfa' | 'mfa_setup'; children: ReactNode }) {
  const { me, loading, error } = useAuth();
  if (loading) return null;
  if (error) return <SessionUnavailable />;
  const stage = me?.stage ?? 'none';
  if (stage === need) return <>{children}</>;
  if (stage === 'full') return <Navigate to="/" replace />;
  if (stage === 'mfa') return <Navigate to="/2fa" replace />;
  if (stage === 'mfa_setup') return <Navigate to="/2fa/einrichten" replace />;
  return <Navigate to="/login" replace />;
}

function Page({ perm, children }: { perm?: string[]; children: ReactNode }) {
  const inner = <Suspense fallback={<Loading />}>{children}</Suspense>;
  return perm ? <RequirePerm perm={perm}>{inner}</RequirePerm> : inner;
}

/** Jede Seite bekommt eine Fehlergrenze; eigene (z. B. im App-Rahmen) gehen vor. */
const withErrors = (routes: RouteObject[]): RouteObject[] => routes.map((r) => ({ errorElement: <RouteError page />, ...r }));

const router = createBrowserRouter(withErrors([
  { path: '/login', element: <AuthStage need="none"><LoginPage /></AuthStage> },
  { path: '/einrichtung', element: <SetupPage /> },
  { path: '/einladung/:token', element: <InvitePage /> },
  { path: '/2fa', element: <AuthStage need="mfa"><MfaVerifyPage /></AuthStage> },
  { path: '/2fa/einrichten', element: <AuthStage need="mfa_setup"><MfaSetupPage /></AuthStage> },
  // Öffentliche Upload-Seite (ohne Konto)
  { path: '/u/:token', element: <UploadPage /> },
  { path: '/app', element: <Suspense fallback={null}><InstallApp /></Suspense> },
  // Datenschutzerklärung und Impressum (#187), ohne Anmeldung
  { path: '/datenschutz', element: <Suspense fallback={null}><LegalPage kind="datenschutz" /></Suspense> },
  { path: '/impressum', element: <Suspense fallback={null}><LegalPage kind="impressum" /></Suspense> },
  {
    path: '/drucken',
    element: (
      <Protected>
        <Suspense fallback={null}>
          <PrintSheet />
        </Suspense>
      </Protected>
    ),
  },
  {
    path: '/',
    errorElement: <RouteError page />,
    element: (
      <Protected>
        <LiveProvider enabled>
          <AppShell />
        </LiveProvider>
      </Protected>
    ),
    children: [
      // Fehler einer Seite bleiben im App-Rahmen (Navigation bleibt bedienbar)
      { errorElement: <RouteError />, children: [
      { index: true, element: <Page><Dashboard /></Page> },
      { path: 'aktivitaeten', element: <Page perm={['audit.view']}><Activities /></Page> },
      { path: 'benachrichtigungen', element: <Page><Notifications /></Page> },
      { path: 'beitraege', element: <Page perm={['post.view']}><Posts key="alle" /></Page> },
      { path: 'beitraege/:id', element: <Page perm={['post.view']}><PostEditor /></Page> },
      { path: 'vorlagen', element: <Page perm={['post.view']}><Templates /></Page> },
      { path: 'freigaben', element: <Page perm={['post.view']}><Posts key="freigaben" mode="approvals" /></Page> },
      { path: 'medien', element: <Page perm={['media.view']}><Collections /></Page> },
      { path: 'medien/dateien', element: <Page perm={['media.view']}><MediaSearch /></Page> },
      { path: 'medien/papierkorb', element: <Page perm={['media.trash']}><Trash /></Page> },
      { path: 'medien/verwaltung', element: <Page perm={['media.admin']}><MediaAdmin /></Page> },
      { path: 'medien/gestaltung', element: <Page perm={['media.design']}><DesignEditor /></Page> },
      { path: 'medien/:id', element: <Page perm={['media.view']}><CollectionDetail /></Page> },
      { path: 'quellen', element: <Page perm={['source.view']}><Sources /></Page> },
      { path: 'banner', element: <Page perm={['banner.view']}><Banners /></Page> },
      { path: 'kanaele', element: <Page perm={['channel.view']}><Sites /></Page> },
      { path: 'warnungen', element: <Page perm={['warning.view']}><Warnings /></Page> },
      { path: 'warnungen/pflege', element: <Page perm={['warning.rules', 'warning.approve', 'warning.settings']}><WarningConfig /></Page> },
      { path: 'warnungen/:id', element: <Page perm={['warning.view']}><WarningCase /></Page> },
      { path: 'verbindungen', element: <Page perm={['connection.configure']}><Connections /></Page> },
      { path: 'verbindungen/:id', element: <Page perm={['connection.configure']}><ConnectionDetail /></Page> },
      { path: 'automationen', element: <Page perm={['automation.read']}><Automations /></Page> },
      { path: 'automationen/eingaenge', element: <Page perm={['automation.read']}><AutomationInputs /></Page> },
      { path: 'automationen/ausgaenge', element: <Page perm={['automation.read']}><AutomationOutputs /></Page> },
      { path: 'automationen/:id', element: <Page perm={['automation.read']}><AutomationEditor /></Page> },
      { path: 'amtliche-warnungen', element: <Page perm={['official.view']}><OfficialWarnings /></Page> },
      { path: 'benutzer', element: <Page perm={['user.view']}><Users /></Page> },
      { path: 'system', element: <Page perm={['system.status']}><SystemStatus /></Page> },
      { path: 'protokolle', element: <Page perm={['system.logs', 'audit.view']}><Logs /></Page> },
      { path: 'datenschutz-anfragen', element: <Page perm={['privacy.manage']}><PrivacyRequests /></Page> },
      { path: 'einstellungen', element: <Page perm={['settings.view']}><Settings /></Page> },
      { path: 'profil', element: <Page><Profile /></Page> },
      { path: 'hilfe', element: <Page><Help /></Page> },
      { path: 'hilfe/:chapter', element: <Page><Help /></Page> },
      { path: '*', element: <NotFound /> },
      ] },
    ],
  },
]));

export function App() {
  return <RouterProvider router={router} />;
}
