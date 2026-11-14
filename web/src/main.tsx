import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';
import { App } from './App';
import { AuthProvider, ThemeSync } from './lib/auth';
import { ToastProvider } from './components/ui/overlays';
import { OfflineBanner } from './components/OfflineBanner';

// Farbschema vor dem ersten Rendern setzen (kein Aufblitzen)
try {
  const saved = localStorage.getItem('ll-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* egal */
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500), staleTime: 10_000 },
  },
});

// Service Worker für die installierbare App (nur Oberfläche, keine API-Daten)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeSync />
        <ToastProvider>
          <OfflineBanner />
          <App />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
