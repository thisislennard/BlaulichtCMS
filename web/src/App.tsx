import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { AppShell, RequirePerm } from './components/layout/AppShell';
import { SkeletonRows } from './components/ui/core';
import { useAuth } from './lib/auth';
import { InvitePage, LoginPage, MfaSetupPage, MfaVerifyPage, SetupPage } from './pages/auth/AuthPages';
import { UploadPage } from './pages/public/UploadPage';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Activities = lazy(() => import('./pages/Activities'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Posts = lazy(() => import('./pages/posts/Posts'));
const PostEditor = lazy(() => import('./pages/posts/PostEditor'));
const Templates = lazy(() => import('./pages/posts/Templates'));
const Banners = lazy(() => import('./pages/banners/Banners'));
const Collections = lazy(() => import('./pages/media/Collections'));
const CollectionDetail = lazy(() => import('./pages/media/CollectionDetail'));
const Sites = lazy(() => import('./pages/channels/Sites'));
const Users = lazy(() => import('./pages/admin/Users'));
const SystemStatus = lazy(() => import('./pages/admin/SystemStatus'));
const Logs = lazy(() => import('./pages/admin/Logs'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Help = lazy(() => import('./pages/help/Help'));
const PrintSheet = lazy(() => import('./pages/print/PrintSheet'));
const InstallApp = lazy(() => import('./pages/InstallApp'));

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

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/einrichtung', element: <SetupPage /> },
  { path: '/einladung/:token', element: <InvitePage /> },
  { path: '/2fa', element: <MfaVerifyPage /> },
  { path: '/2fa/einrichten', element: <MfaSetupPage /> },
  // Öffentliche Upload-Seite (ohne Konto)
  { path: '/u/:token', element: <UploadPage /> },
  { path: '/app', element: <Suspense fallback={null}><InstallApp /></Suspense> },
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
    element: (
      <Protected>
        <AppShell />
      </Protected>
    ),
    children: [
      { index: true, element: <Page><Dashboard /></Page> },
      { path: 'aktivitaeten', element: <Page perm={['audit.read']}><Activities /></Page> },
      { path: 'benachrichtigungen', element: <Page><Notifications /></Page> },
      { path: 'beitraege', element: <Page perm={['post.read']}><Posts /></Page> },
      { path: 'beitraege/:id', element: <Page perm={['post.read']}><PostEditor /></Page> },
      { path: 'vorlagen', element: <Page perm={['post.read']}><Templates /></Page> },
      { path: 'freigaben', element: <Page perm={['post.read']}><Posts mode="approvals" /></Page> },
      { path: 'medien', element: <Page perm={['media.read']}><Collections /></Page> },
      { path: 'medien/:id', element: <Page perm={['media.read']}><CollectionDetail /></Page> },
      { path: 'banner', element: <Page perm={['post.read']}><Banners /></Page> },
      { path: 'kanaele', element: <Page perm={['post.read', 'channel.manage']}><Sites /></Page> },
      { path: 'benutzer', element: <Page perm={['user.read']}><Users /></Page> },
      { path: 'system', element: <Page perm={['system.read']}><SystemStatus /></Page> },
      { path: 'protokolle', element: <Page perm={['system.read']}><Logs /></Page> },
      { path: 'einstellungen', element: <Page perm={['system.read', 'system.manage']}><Settings /></Page> },
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
