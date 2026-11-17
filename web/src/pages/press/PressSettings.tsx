import { PageHeader } from '../../components/ui/core';
import { MailboxSettings } from './MailboxSettings';
import { SnippetSettings } from './Snippets';

/**
 * Presse-Seiten zum Einrichten (#250): das Presse-Postfach (#205) liegt unter Einrichtung, die Textbausteine (#206)
 * gehören zur täglichen Pressearbeit und stehen unter Presse. Frühere Adresse /presse/einstellungen leitet weiter.
 */
export function PressMailboxPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Abruf, Zeitplan und Empfangsprotokoll des Postfachs, aus dem Presseanfragen entstehen." />
      <MailboxSettings />
    </div>
  );
}

export function PressSnippetsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Formulierungen für Antworten auf Presseanfragen." />
      <SnippetSettings />
    </div>
  );
}
