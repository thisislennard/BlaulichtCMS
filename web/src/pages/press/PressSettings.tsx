import { useState } from 'react';
import { PageHeader, Tabs } from '../../components/ui/core';
import { useAuth } from '../../lib/auth';
import { MailboxSettings } from './MailboxSettings';
import { SnippetSettings } from './Snippets';

type Tab = 'mailbox' | 'snippets';

/** Presse → Einstellungen: Presse-Postfach (#205) und Textbausteine (#206). */
export default function PressSettings() {
  const { can } = useAuth();
  const tabs = [...(can('press.mailbox') ? [{ value: 'mailbox' as Tab, label: 'Presse-Postfach' }] : []), ...(can('press.snippets') ? [{ value: 'snippets' as Tab, label: 'Textbausteine' }] : [])];
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'snippets');
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Presse-Einstellungen" subtitle="Abruf des Presse-Postfachs und Textbausteine für Antworten." />
      {tabs.length > 1 && <Tabs label="Bereich" value={tab} onChange={setTab} tabs={tabs} />}
      {tab === 'mailbox' && can('press.mailbox') && <MailboxSettings />}
      {tab === 'snippets' && can('press.snippets') && <SnippetSettings />}
    </div>
  );
}
