import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { download, post } from '../../api/client';
import { Badge, Notice, SkeletonRows } from '../../components/ui/core';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { Icon } from '../../components/ui/Icon';
import { useErrorToast, useToast, useConfirm, type MenuItem } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { useKeywords } from '../../lib/keywords';

/**
 * Stichwortverzeichnis des Landes (#195): Herkunft der aktiven Liste, erneut übernehmen, eigene Liste importieren
 * (CSV/JSON: code;bezeichnung;kategorie) und die ganze Liste exportieren. Das Land wird in den Einstellungen gewählt.
 *
 * Seit #269 kompakt: die Herkunft als einklappbarer Kasten über der Stichwort-Tabelle, Import und Export als Einträge
 * im Menü „Import/Export“ der Tabelle (`useKeywordCatalogActions`).
 */

/** Aktionen für das Menü „Import/Export“ samt verstecktem Dateifeld für den Import. */
export function useKeywordCatalogActions(onChanged: () => void): { items: MenuItem[]; input: React.ReactNode; busy: boolean } {
  const q = useKeywords();
  const { can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const ask = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const mayRules = can('warning.rules');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await q.refetch();
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return toast({ tone: 'warning', title: 'Datei zu groß', text: 'Höchstens 2 MB.' });
    const text = await file.text();
    await run(async () => {
      const check = await post<{ rows: number; errors: string[] }>('/keywords/import', { text, dryRun: true });
      const ok = await ask({
        title: `${check.rows} Einträge übernehmen?`,
        text: `Gleiche Kürzel werden zu eigenen Einträgen und überschreiben das Landesverzeichnis; neue Kürzel kommen dazu.${check.errors.length ? ` ${check.errors.length} Zeile(n) werden übersprungen: ${check.errors.slice(0, 3).join(' ')}${check.errors.length > 3 ? ' …' : ''}` : ''}`,
        confirmLabel: 'Übernehmen',
      });
      if (!ok) return;
      const r = await post<{ added: number; updated: number; unchanged: number }>('/keywords/import', { text });
      toast({ tone: 'success', title: 'Eigene Liste übernommen', text: `${r.added} neu, ${r.updated} geändert, ${r.unchanged} unverändert.` });
    });
  };

  const items: MenuItem[] = [
    mayRules && !!q.data?.catalog && {
      label: 'Landesverzeichnis neu übernehmen',
      icon: 'RefreshCw',
      disabled: busy,
      onClick: () =>
        run(async () => {
          const r = await post<{ added: number; updated: number; deactivated: number }>('/keywords/sync');
          toast({ tone: 'success', title: 'Verzeichnis übernommen', text: `${r.added} neu, ${r.updated} aktualisiert, ${r.deactivated} deaktiviert.` });
        }),
    },
    mayRules && { label: 'Eigene Liste importieren …', icon: 'Upload', disabled: busy, onClick: () => fileRef.current?.click() },
    { label: 'Als CSV exportieren', icon: 'Download', onClick: () => download('/keywords/export?format=csv') },
    { label: 'Als JSON exportieren', icon: 'Download', onClick: () => download('/keywords/export?format=json') },
  ];
  const input = mayRules ? (
    <input
      ref={fileRef}
      type="file"
      accept=".csv,.json,.txt,text/csv,application/json"
      className="sr-only"
      aria-label="Eigene Stichwortliste auswählen (CSV oder JSON)"
      tabIndex={-1}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void importFile(f);
      }}
    />
  ) : null;
  return { items, input, busy };
}

/** Herkunft des Verzeichnisses (Erlass, Stand, Gültigkeit) – eingeklappt, solange nichts zu tun ist. */
export function KeywordCatalogInfo() {
  const q = useKeywords();
  const { can } = useAuth();
  if (q.isLoading) return <SkeletonRows rows={1} />;
  if (!q.data) return null;
  const d = q.data;
  const c = d.catalog;
  const stateHint = d.states.find((s) => s.id === d.state)?.hinweis;
  const own = d.entries.filter((e) => e.source === 'eigen').length;
  // Ohne Land oder ohne Verzeichnis gibt es etwas zu tun – dann aufgeklappt
  const attention = !d.state || !!d.noCatalogText;
  return (
    <details open={attention} className="group rounded-node border border-line bg-card">
      <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden text-sm">
        <Icon name="ChevronRight" size={15} className="text-fg-muted transition-transform group-open:rotate-90" />
        <span className="font-medium">Stichwortverzeichnis</span>
        <span className="text-fg-muted">
          {d.state ? d.stateName : 'kein Bundesland gewählt'}
          {c ? ` · Stand ${c.stand} · ${c.anzahl} Stichwörter` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Badge>{d.entries.length} aktiv</Badge>
          {own > 0 && <Badge>{own} eigene</Badge>}
        </span>
      </summary>
      <div className="flex flex-col gap-3 text-sm px-4 pb-4 pt-1 border-t border-line">
        {!d.state && (
          <Notice>
            Noch kein Bundesland gewählt.{' '}
            {can('settings.general') ? <Link to="/einstellungen#allgemein">In den Einstellungen wählen</Link> : 'Die Administration wählt es unter Einstellungen → Allgemein.'}
          </Notice>
        )}
        {c && (
          <div className="flex flex-col gap-1 pt-2">
            <p className="m-0 flex items-center gap-2 flex-wrap">
              <HelpLink href={c.quelle}>{c.titel}</HelpLink>
              <HelpTip title="Stichwortverzeichnis" more="/hilfe/stichwoerter-regeln#stichwortverzeichnis-der-laender">
                <p className="m-0">Das Bundesland wird unter Einstellungen → Allgemein gewählt. Mitgelieferte Verzeichnisse sind wortgetreu aus der amtlichen Quelle übernommen.</p>
                <p className="m-0 text-fg-muted">Eigene Einträge haben Vorrang vor dem Landesverzeichnis.</p>
              </HelpTip>
            </p>
            <p className="m-0 text-meta text-fg-muted">
              Stand {c.stand} · gültig {c.gueltig} · {c.anzahl} Stichwörter
            </p>
            <p className="m-0 text-meta text-fg-muted">{c.hinweis}</p>
          </div>
        )}
        {d.noCatalogText && (
          <Notice tone="warning" title={d.noCatalogText}>
            {stateHint ? <span className="block">{stateHint}</span> : null}
            Eine CSV-Datei mit den Spalten <code>code;bezeichnung;kategorie</code> (oder JSON) über „Import/Export → Eigene Liste importieren“ einlesen.
          </Notice>
        )}
        <p className="m-0 text-meta text-fg-muted">Unbekannte Stichworte aus Einsatzmeldungen bleiben unverändert stehen.</p>
      </div>
    </details>
  );
}
