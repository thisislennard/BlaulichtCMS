import { useDeferredValue, useMemo } from 'react';
import { Badge } from '../../components/ui/core';
import { HelpTip } from '../../components/ui/HelpTip';
import { Icon } from '../../components/ui/Icon';
import { fleschLabel, hints, scores } from '../../lib/readability';

/**
 * Lesbarkeitshinweis im Editor (#217): Flesch-Amstad, Wiener Sachtextformel und konkrete Hinweise. Nur Hinweise –
 * keine KI, keine Pflicht; gerechnet wird im Browser.
 */
export function ReadabilityPanel({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  const s = useMemo(() => scores(deferred), [deferred]);
  const list = useMemo(() => hints(deferred), [deferred]);
  if (!deferred.trim() || !s) return null;
  const tone = s.flesch >= 60 ? 'success' : s.flesch >= 30 ? 'warning' : 'error';
  return (
    <details className="border border-line rounded-card p-3 text-sm">
      <summary className="cursor-pointer font-medium flex flex-wrap items-center gap-2">
        <Icon name="Accessibility" size={15} />
        <span>Lesbarkeit</span>
        <Badge tone={tone}>{`Flesch ${s.flesch} – ${fleschLabel(s.flesch)}`}</Badge>
        {list.length > 0 && <span className="text-fg-muted font-normal">{list.length === 1 ? '1 Hinweis' : `${list.length} Hinweise`}</span>}
      </summary>
      <div className="flex flex-col gap-3 mt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-muted">
          <span>{s.words} Wörter</span>
          <span>{s.sentences} Sätze</span>
          <span>{String(s.wordsPerSentence).replace('.', ',')} Wörter je Satz</span>
          <span>Wiener Sachtextformel {String(s.wiener).replace('.', ',')} (≈ Schulstufe)</span>
          <HelpTip title="Lesbarkeitsindex" more="/hilfe/beitraege#lesbarkeit">
            <p className="m-0"><strong>Flesch (deutsche Fassung nach Amstad):</strong> 0 bis 100, höher ist leichter. Ab etwa 60 gilt ein Text als gut lesbar für die meisten Erwachsenen.</p>
            <p className="m-0"><strong>Wiener Sachtextformel:</strong> ungefähre Schulstufe, 4 = sehr leicht, 15 = sehr schwer. Für Bürgerinformationen sind Werte um 8 bis 10 ein guter Richtwert.</p>
            <p className="m-0 text-fg-muted">Silben werden geschätzt – die Werte sind Anhaltspunkte, keine Note.</p>
          </HelpTip>
        </div>
        {list.length === 0 ? (
          <p className="m-0 text-fg-muted">Keine Auffälligkeiten.</p>
        ) : (
          <ul className="m-0 pl-4 flex flex-col gap-2">
            {list.map((h) => (
              <li key={h.kind}>
                {h.text}
                {!!h.examples?.length && <span className="block text-meta text-fg-muted">{h.examples.map((e) => `„${e}“`).join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
