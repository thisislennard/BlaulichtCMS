import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Notice } from '../components/ui/core';
import { HelpLink } from '../components/ui/HelpTip';
import { Icon } from '../components/ui/Icon';
import { LegalLinks } from '../components/legal/LegalLinks';
import { detectPlatform, usePwaInstall, type Platform } from '../lib/pwa';

/* Anleitungen je Browser – Menünamen nach den offiziellen Hilfeseiten (Google, Microsoft, Apple, Stand 11/2026) */
const STEPS: Record<'chrome' | 'edge' | 'safari' | 'firefox' | 'ios' | 'android', { title: string; text: ReactNode }> = {
  chrome: {
    title: 'Chrome (Windows, macOS, Linux)',
    text: (
      <>
        Rechts in der Adressleiste auf <strong>Installieren</strong> klicken – oder Menü <strong>⋮ → Streamen, speichern und teilen → Seite als App installieren…</strong> (
        <HelpLink href="https://support.google.com/chrome/answer/9658361?hl=de&co=GENIE.Platform%3DDesktop">Google-Hilfe</HelpLink>).
      </>
    ),
  },
  edge: {
    title: 'Edge (Windows, macOS)',
    text: (
      <>
        In der Adressleiste auf das Symbol <strong>App verfügbar</strong> klicken, dann <strong>Installieren</strong>. Die App erscheint danach im Startmenü und lässt sich an die Taskleiste anheften (
        <HelpLink href="https://learn.microsoft.com/de-de/microsoft-edge/progressive-web-apps/ux">Microsoft Learn</HelpLink>).
      </>
    ),
  },
  safari: {
    title: 'Safari (Mac, ab macOS Sonoma 14)',
    text: (
      <>
        In der Menüleiste <strong>Ablage → Zum Dock hinzufügen</strong> wählen (oder Teilen-Taste → „Zum Dock hinzufügen“), Namen bestätigen mit <strong>Hinzufügen</strong>. Mitteilungen in der App selbst erlauben (
        <HelpLink href="https://support.apple.com/de-de/104996">Apple-Support</HelpLink>).
      </>
    ),
  },
  firefox: {
    title: 'Firefox (Computer)',
    text: (
      <>
        Firefox kann Websites am Computer nicht als App installieren. Push-Benachrichtigungen funktionieren trotzdem: Sie kommen, solange Firefox läuft – auch wenn der BlaulichtCMS-Tab geschlossen ist. Für ein eigenes Fenster mit Symbol in Taskleiste bzw. Dock Chrome, Edge oder Safari verwenden.
      </>
    ),
  },
  ios: { title: 'iPhone / iPad', text: <>In Safari auf <strong>Teilen</strong> tippen und <strong>Zum Home-Bildschirm</strong> wählen. Push gibt es auf iPhone und iPad nur in der installierten App (ab iOS 16.4).</> },
  android: { title: 'Android', text: <>Im Browsermenü <strong>App installieren</strong> bzw. <strong>Zum Startbildschirm hinzufügen</strong> wählen.</> },
};

const desktopKeys = ['chrome', 'edge', 'safari', 'firefox'] as const;
const mobileKeys = ['android', 'ios'] as const;

function hereKey(p: Platform): keyof typeof STEPS | null {
  if (p === 'ios') return 'ios';
  if (p === 'android') return 'android';
  if (p === 'mac-safari') return 'safari';
  if (p === 'firefox-desktop') return 'firefox';
  if (p === 'chromium-desktop') return /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  return null;
}

function StepList({ keys, here }: { keys: readonly (keyof typeof STEPS)[]; here: keyof typeof STEPS | null }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line border border-line rounded-control bg-card">
      {keys.map((k) => (
        <li key={k} className="px-3.5 py-3 text-sm flex flex-col gap-1">
          <span className="font-semibold flex items-center gap-2">
            {STEPS[k].title}
            {k === here && <span className="text-meta font-normal text-fg-muted">· dieser Browser</span>}
          </span>
          <span className="text-fg-muted">{STEPS[k].text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * PWA-Installationslink – bewusst getrennt von persönlichen Einladungen.
 * Diese Seite installiert nur die App; Zugang gibt es erst mit Konto bzw. Einladung.
 */
export default function InstallApp() {
  const { installed, canPrompt, promptInstall } = usePwaInstall();
  useEffect(() => {
    document.title = 'BlaulichtCMS installieren';
    // Sprungmarke (#desktop aus „Mein Konto → Benachrichtigungen“) nach dem Laden anfahren
    if (window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, []);
  const platform = detectPlatform();
  const here = hereKey(platform);
  const mobile = platform === 'ios' || platform === 'android';
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-4">
      <main className="w-full max-w-[640px] flex flex-col gap-5 py-6">
        <h1 className="m-0 text-page font-semibold flex items-center gap-2">
          <Icon name={mobile ? 'Smartphone' : 'Monitor'} size={24} /> BlaulichtCMS als App
        </h1>
        <p className="m-0 text-fg-muted">
          Als App läuft BlaulichtCMS in einem eigenen Fenster mit Symbol auf dem Startbildschirm, in der Taskleiste oder im Dock, Benachrichtigungen erscheinen als Mitteilung des Geräts. Schnellzugriffe führen direkt zu „Neuer Beitrag“, „Medien sammeln“ und „Offene Freigaben“. Zum Anmelden brauchst du ein Konto oder eine persönliche Einladung.
        </p>
        {installed ? (
          <Notice tone="success">BlaulichtCMS läuft hier als installierte App.</Notice>
        ) : canPrompt ? (
          <Button variant="primary" icon="Download" className="!h-12" onClick={() => void promptInstall()}>
            App installieren
          </Button>
        ) : here ? (
          <Notice title={`So geht es hier: ${STEPS[here].title}`}>{STEPS[here].text}</Notice>
        ) : (
          <Notice title="Installieren">Im Browsermenü „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.</Notice>
        )}

        <section id="desktop" aria-labelledby="install-desktop" className="flex flex-col gap-2">
          <h2 id="install-desktop" className="m-0 text-section font-semibold flex items-center gap-2">
            <Icon name="Monitor" size={18} /> Am Computer
          </h2>
          <StepList keys={desktopKeys} here={here} />
        </section>

        <section aria-labelledby="install-mobile" className="flex flex-col gap-2">
          <h2 id="install-mobile" className="m-0 text-section font-semibold flex items-center gap-2">
            <Icon name="Smartphone" size={18} /> Am Handy oder Tablet
          </h2>
          <StepList keys={mobileKeys} here={here} />
        </section>

        <Notice icon="Bell" title="Benachrichtigungen">
          Nach der Installation die App öffnen, anmelden und unter <strong>Mein Konto → Benachrichtigungen</strong> „Push einschalten“ – je Gerät bzw. Browser einmal. Erscheinen keine Mitteilungen, die Einstellungen des Betriebssystems prüfen (Windows: Einstellungen → System → Benachrichtigungen; macOS: Systemeinstellungen → Mitteilungen).
        </Notice>
        <Link to="/login">Zur Anmeldung</Link>
        <LegalLinks className="justify-start" />
      </main>
    </div>
  );
}
