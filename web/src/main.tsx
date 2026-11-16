import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './index.css';
// Installationsangebot des Browsers früh abfangen (kommt oft vor dem ersten Rendern)
import './lib/pwa';
import { App } from './App';
import { AuthProvider, ThemeSync } from './lib/auth';
import { ConfirmProvider, ToastProvider } from './components/ui/overlays';
import { OfflineBanner } from './components/OfflineBanner';
import { ReauthProvider } from './components/ReauthDialog';
import { ErrorBoundary, isChunkError, reloadForNewVersion } from './components/feedback/Feedback';

// Farbschema vor dem ersten Rendern setzen (kein Aufblitzen)
try {
  const saved = localStorage.getItem('bc-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* egal */
}

const queryClient = new QueryClient({
  defaultOptions: {
    // Nicht erneut versuchen bei 4xx und Zeitüberschreitung (sonst dreht die Ladeanzeige bis zu 90 s)
    queries: { refetchOnWindowFocus: true, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500) && e?.code !== 'timeout', staleTime: 10_000 },
  },
});

// Nach einem Update fehlen die Programmteile der alten Version: einmal automatisch neu laden statt Fehlermeldung.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewVersion()) e.preventDefault();
});
window.addEventListener('unhandledrejection', (e) => {
  if (isChunkError(e.reason) && reloadForNewVersion()) e.preventDefault();
});

// Service Worker für die installierbare App (nur Oberfläche, keine API-Daten)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // Klick auf eine Mitteilung bei einem Fenster, das der Service Worker nicht selbst umleiten kann (sw.js)
  navigator.serviceWorker.addEventListener('message', (e) => {
    const link = e.data?.type === 'bc-open' ? e.data.link : null;
    if (typeof link === 'string' && link.startsWith('/') && !link.startsWith('//')) window.location.assign(link);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary page>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeSync />
        <ToastProvider>
          <ConfirmProvider>
            <ReauthProvider>
              <OfflineBanner />
              <App />
            </ReauthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
