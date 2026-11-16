import { useSyncExternalStore } from 'react';

/**
 * Installation als App (PWA, #197). Chromium-Browser (Chrome, Edge) melden mit `beforeinstallprompt`, dass sich
 * BlaulichtCMS installieren lässt – das Ereignis kommt oft vor dem ersten Rendern und wird deshalb schon beim Laden
 * dieses Moduls (aus main.tsx) abgefangen und aufgehoben. Safari, Firefox und iOS kennen das Ereignis nicht; dort
 * zeigt die Oberfläche die passende Anleitung.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installedFlag = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const standalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
    (navigator as any).standalone === true);

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedFlag = true;
    emit();
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', emit);
}

export type Platform = 'ios' | 'android' | 'mac-safari' | 'firefox-desktop' | 'chromium-desktop' | 'other';

/** Grobe Plattform für die passende Anleitung (nur Anzeige, keine Sicherheitsentscheidung). */
export function detectPlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): Platform {
  // iPadOS meldet sich als Mac – erkennbar an Touch
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'firefox-desktop';
  if (/Edg\/|Chrome\/|Chromium\//.test(ua)) return 'chromium-desktop';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua)) return 'mac-safari';
  return 'other';
}

interface State {
  installed: boolean;
  canPrompt: boolean;
}
let snapshot: State = { installed: false, canPrompt: false };
const read = (): State => {
  const next = { installed: installedFlag || standalone(), canPrompt: !!deferred };
  if (next.installed !== snapshot.installed || next.canPrompt !== snapshot.canPrompt) snapshot = next;
  return snapshot;
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Zustand der Installation: installiert (eigenes Fenster) bzw. Installationsdialog des Browsers verfügbar. */
export function usePwaInstall() {
  const s = useSyncExternalStore(subscribe, read, read);
  return {
    ...s,
    /** Öffnet den Installationsdialog des Browsers (nur nach Klick); `true`, wenn installiert wurde. */
    async promptInstall(): Promise<boolean> {
      const ev = deferred;
      if (!ev) return false;
      deferred = null; // ein Ereignis lässt sich nur einmal verwenden
      emit();
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      return outcome === 'accepted';
    },
  };
}
