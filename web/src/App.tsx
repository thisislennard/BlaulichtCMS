import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { AppShell, RequirePerm } from './components/layout/AppShell';
import { SkeletonRows } from './components/ui/core';
import { useAuth } from './lib/auth';
import { InvitePage, LoginPage, MfaSetupPage, MfaVerifyPage, SetupPage } from './pages/auth/AuthPages';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Activities = lazy(() => import('./pages/Activities'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const WorkflowList = lazy(() => import('./pages/workflows/WorkflowList'));
const Templates = lazy(() => import('./pages/workflows/Templates'));
const Editor = lazy(() => import('./pages/editor/Editor'));
const Executions = lazy(() => import('./pages/runs/Executions'));
const Integrations = lazy(() => import('./pages/integrations/Integrations'));
const Wizard = lazy(() => import('./pages/integrations/Wizard'));
const Connections = lazy(() => import('./pages/integrations/Connections'));
const ConnectionDetail = lazy(() => import('./pages/integrations/ConnectionDetail'));
const Webhooks = lazy(() => import('./pages/integrations/Webhooks'));
const ApiKeys = lazy(() => import('./pages/integrations/ApiKeys'));
const WordPress = lazy(() => import('./pages/wordpress/WordPress'));
const Users = lazy(() => import('./pages/admin/Users'));
const SystemStatus = lazy(() => import('./pages/admin/SystemStatus'));
const Logs = lazy(() => import('./pages/admin/Logs'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Updates = lazy(() => import('./pages/admin/Updates'));
const Help = lazy(() => import('./pages/help/Help'));

function Loading() {
  return <SkeletonRows rows={6} className="pt-2" />;
}

/** Nur mit vollständiger Anmeldung; sonst Login bzw. 2FA. */
function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.stage === 'mfa') return <Navigate to="/2fa" replace />;
  if (me.stage === 'mfa_setup') return <Navigate to="/2fa/einrichten" replace />;
  return <>{children}</>;
}

function Page({ perm, children }: { perm?: string[]; children: ReactNode }) {
  const inner = <Suspense fallback={<Loading />}>{children}</Suspense>;
  return perm ? <RequirePerm perm={perm}>{inner}</RequirePerm> : inner;
}

function HomeRedirect() {
  const { can } = useAuth();
  if (can('run.read')) return <Page><Dashboard /></Page>;
  if (can('wordpress.read')) return <Navigate to="/wordpress" replace />;
  return <Navigate to="/hilfe" replace />;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isPlatformAdmin } = useAuth();
  return isPlatformAdmin ? <Page>{children}</Page> : <RequirePerm perm={['__platform_admin__']}>{null}</RequirePerm>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/einrichtung', element: <SetupPage /> },
  { path: '/einladung/:token', element: <InvitePage /> },
  { path: '/2fa', element: <MfaVerifyPage /> },
  { path: '/2fa/einrichten', element: <MfaSetupPage /> },
  {
    path: '/',
    element: (
      <Protected>
        <AppShell />
      </Protected>
    ),
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'aktivitaeten', element: <Page perm={['audit.read']}><Activities /></Page> },
      { path: 'benachrichtigungen', element: <Page><Notifications /></Page> },
      { path: 'workflows', element: <Page perm={['workflow.read']}><WorkflowList /></Page> },
      { path: 'workflows/:id', element: <Page perm={['workflow.read']}><Editor /></Page> },
      { path: 'vorlagen', element: <Page perm={['workflow.read']}><Templates /></Page> },
      { path: 'ausfuehrungen', element: <Page perm={['run.read']}><Executions /></Page> },
      { path: 'ausfuehrungen/:runId', element: <Page perm={['run.read']}><Executions /></Page> },
      { path: 'schnittstellen', element: <Page perm={['connection.read']}><Integrations /></Page> },
      { path: 'schnittstellen/:connector/verbinden', element: <Page perm={['connection.edit']}><Wizard /></Page> },
      { path: 'verbindungen', element: <Page perm={['connection.read']}><Connections /></Page> },
      { path: 'verbindungen/:id', element: <Page perm={['connection.read']}><ConnectionDetail /></Page> },
      { path: 'webhooks', element: <Page perm={['connection.read']}><Webhooks /></Page> },
      { path: 'api-schluessel', element: <Page perm={['system.manage']}><ApiKeys /></Page> },
      { path: 'wordpress', element: <Page perm={['wordpress.read']}><WordPress /></Page> },
      { path: 'benutzer', element: <Page perm={['user.read']}><Users /></Page> },
      { path: 'system', element: <Page perm={['system.read']}><SystemStatus /></Page> },
      { path: 'protokolle', element: <Page perm={['system.read']}><Logs /></Page> },
      { path: 'einstellungen', element: <Page perm={['system.read', 'system.manage']}><Settings /></Page> },
      { path: 'updates', element: <AdminOnly><Updates /></AdminOnly> },
      { path: 'profil', element: <Page><Profile /></Page> },
      { path: 'hilfe', element: <Page><Help /></Page> },
      { path: 'hilfe/:chapter', element: <Page><Help /></Page> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
