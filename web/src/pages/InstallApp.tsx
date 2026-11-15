import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, Notice } from '../components/ui/core';
import { Icon } from '../components/ui/Icon';

/**
 * PWA-Installationslink – bewusst getrennt von persönlichen Einladungen.
 * Diese Seite installiert nur die App; Zugang gibt es erst mit Konto bzw. Einladung.
 */
export default function InstallApp() {
  const [prompt, setPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    document.title = 'BlaulichtCMS installieren';
    const h = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', h);
    window.addEventListener('appinstalled', () => setInstalled(true));
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-4">
      <main className="w-full max-w-[460px] flex flex-col gap-5">
        <h1 className="m-0 text-page font-semibold flex items-center gap-2">
          <Icon name="Smartphone" size={24} /> BlaulichtCMS als App
        </h1>
        <p className="m-0 text-fg-muted">Mit der App geht es direkt zu „Neuer Beitrag“, „Medien sammeln“ und „Offene Freigaben“. Zum Anmelden brauchst du ein Konto oder eine persönliche Einladung.</p>
        {installed ? (
          <Notice tone="success">BlaulichtCMS ist auf diesem Gerät installiert.</Notice>
        ) : prompt ? (
          <Button variant="primary" icon="Download" className="!h-12" onClick={async () => (prompt.prompt(), await prompt.userChoice, setPrompt(null))}>
            App installieren
          </Button>
        ) : ios ? (
          <Notice title="iPhone / iPad">
            In Safari auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.
          </Notice>
        ) : (
          <Notice title="Android / Desktop">
            Im Browsermenü „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.
          </Notice>
        )}
        <Link to="/login">Zur Anmeldung</Link>
      </main>
    </div>
  );
}
