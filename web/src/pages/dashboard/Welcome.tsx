import { Link } from 'react-router';
import { Button, Card } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../../lib/auth';
import { t } from '../../i18n';

interface Step {
  text: string;
  to: string;
  /** mindestens eines der Rechte – sonst entfällt der Schritt */
  perm?: string[];
}
interface WelcomeDef {
  role: string;
  help: string;
  steps: Step[];
}

const MEDIA: Step[] = [
  { text: 'Fotos sammeln: eine Sammlung mit Upload-Link anlegen und den Link oder QR-Code teilen', to: '/medien', perm: ['media.collections'] },
  { text: 'Sichten: Datei für Datei auswählen oder überspringen', to: '/medien', perm: ['media.review'] },
];
const WARN = '/warnungen';

/** Erste Schritte je Standardansicht (#255) – dieselben Profile wie das Dashboard (server/src/lib/dashboard-layout.ts). */
const WELCOME: Record<string, WelcomeDef> = {
  editor: { role: 'Redaktion', help: 'erste-schritte', steps: [...MEDIA, { text: 'Beitrag schreiben, Medien übernehmen und zur Freigabe einreichen', to: '/beitraege', perm: ['post.create', 'post.edit'] }] },
  media_manager: { role: 'Medienverwaltung', help: 'sichtung', steps: [...MEDIA, { text: 'Ordnen: Ordner anlegen und Schlagworte vergeben', to: '/medien', perm: ['media.organize'] }] },
  approver: {
    role: 'Freigabe',
    help: 'freigabe',
    steps: [
      { text: 'Freigaben prüfen: hier steht alles, was auf deine Entscheidung wartet', to: '/freigaben', perm: ['approval.post', 'publish.website'] },
      { text: 'Fassung lesen, Medien und Hinweise zum Datenschutz ansehen', to: '/freigaben', perm: ['approval.post', 'publish.website'] },
      { text: 'Freigeben oder mit Begründung zurückweisen – die Freigabe gilt genau für diese Fassung', to: '/freigaben', perm: ['approval.post', 'publish.website'] },
    ],
  },
  publisher: {
    role: 'Veröffentlichung',
    help: 'freigabe',
    steps: [
      { text: 'Bereit zur Veröffentlichung: freigegebene Beiträge übernehmen', to: '/freigaben', perm: ['approval.post', 'publish.website'] },
      { text: 'Auf der Website veröffentlichen und die bestätigte Adresse prüfen', to: '/beitraege', perm: ['post.view'] },
      { text: 'Freigegebene Banner auf der Website schalten', to: '/banner', perm: ['banner.publish'] },
    ],
  },
  press: {
    role: 'Presse',
    help: 'presse',
    steps: [
      { text: 'Presseanfragen bearbeiten: dir zugewiesene Anfragen und ihre Fristen', to: '/presse', perm: ['press.view'] },
      { text: 'Antwort schreiben – Textbausteine helfen bei wiederkehrenden Formulierungen', to: '/presse', perm: ['press.reply'] },
      { text: 'Fristen im Blick: der Kalender zeigt alle Fristen', to: '/kalender', perm: ['calendar.view'] },
    ],
  },
  warning_author: {
    role: 'Warnentwurf',
    help: 'warnentwurf',
    steps: [
      { text: 'Warnentwurf erfassen: Erstmeldung, Aktualisierung oder Entwarnung', to: WARN },
      { text: 'Stichwort wählen und den Vorschlag zur Warnstufe prüfen', to: WARN },
      { text: 'Zur Freigabe einreichen', to: WARN },
    ],
  },
  warning_approver: {
    role: 'Warnfreigabe',
    help: 'warnentwurf',
    steps: [
      { text: 'Eingereichte Warnentwürfe öffnen', to: WARN },
      { text: 'Warnstufe bestätigen oder mit Begründung ändern', to: WARN },
      { text: 'Die PDF-Fassung freigeben', to: WARN },
    ],
  },
  warning_sender: {
    role: 'Warnversand',
    help: 'warnentwurf',
    steps: [
      { text: 'Freigegebene Warnentwürfe an die zuständige Stelle senden', to: WARN },
      { text: 'Versand und Eingangsbestätigung verfolgen', to: WARN },
      { text: 'Bei unklarem Versand nachfassen und das Ergebnis festhalten', to: WARN },
    ],
  },
  viewer: {
    role: 'Lesezugriff',
    help: 'dashboard',
    steps: [
      { text: 'Beiträge und ihren Stand ansehen', to: '/beitraege', perm: ['post.view'] },
      { text: 'Medien durchsehen', to: '/medien', perm: ['media.view'] },
      { text: 'Anstehende Termine im Kalender', to: '/kalender', perm: ['calendar.view'] },
    ],
  },
  generic: {
    role: '',
    help: 'erste-schritte',
    steps: [
      { text: 'Das Dashboard zeigt, was gerade ansteht', to: '/' },
      { text: 'Mit Strg K Seiten, Inhalte und Hilfe finden', to: '/hilfe/tastatur' },
    ],
  },
};

/**
 * Einmalige Begrüßung neu angelegter Konten (#255): drei erste Schritte der eigenen Rolle, Hilfe-Kapitel, App und Push.
 * „Verstanden“ merkt sich das im Konto (preferences.welcomeDone); Konten von vor dem Update haben den Merker schon.
 */
export function WelcomeCard({ profile }: { profile: string | undefined }) {
  const { me, canAny, setPreferences } = useAuth();
  const def = WELCOME[profile ?? ''] ?? WELCOME.generic;
  const steps = def.steps.filter((s) => !s.perm || canAny(...s.perm)).slice(0, 3);
  const chapter = t(`help.chapters.${def.help}.title`);
  const first = me?.user.name.split(' ')[0];
  return (
    <Card title={first ? `Willkommen bei BlaulichtCMS, ${first}` : 'Willkommen bei BlaulichtCMS'} subtitle={def.role ? `Erste Schritte für die Rolle ${def.role}` : 'Erste Schritte'} id="willkommen">
      <div className="flex flex-col gap-4 text-sm">
        {steps.length > 0 && (
          <ol className="m-0 p-0 list-none flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="w-6 h-6 shrink-0 rounded-full bg-raised font-mono text-[12px] font-medium inline-flex items-center justify-center" aria-hidden="true">
                  {i + 1}
                </span>
                <Link to={s.to} className="pt-0.5">
                  {s.text}
                </Link>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link to={`/hilfe/${def.help}`} className="inline-flex items-center gap-1.5">
            <Icon name="BookOpen" size={15} /> Hilfe: {chapter}
          </Link>
          <Link to="/app" className="inline-flex items-center gap-1.5">
            <Icon name="Smartphone" size={15} /> App installieren
          </Link>
          <Link to="/profil#benachrichtigungen" className="inline-flex items-center gap-1.5">
            <Icon name="Bell" size={15} /> Push einschalten
          </Link>
          <Button size="sm" icon="Check" className="sm:ml-auto" onClick={() => void setPreferences({ welcomeDone: true })}>
            Verstanden
          </Button>
        </div>
      </div>
    </Card>
  );
}
