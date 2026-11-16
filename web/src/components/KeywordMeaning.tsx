import { meaning, resolveKeyword, useKeywords } from '../lib/keywords';

/**
 * Bedeutung eines Einsatzstichworts aus dem Stichwortverzeichnis (#195), z. B. „F 2 – Brand“. Unbekannte Stichworte
 * zeigen nichts zusätzlich (das rohe Stichwort steht ohnehin daneben). Untergliederungen („F2 W“) werden als
 * „gehört zu F 2“ kenntlich gemacht.
 */
export function KeywordMeaning({ code, className }: { code: string | null | undefined; className?: string }) {
  const q = useKeywords();
  const hit = code ? resolveKeyword(code, q.data?.entries ?? []) : null;
  if (!hit) return null;
  const k = hit.entry;
  const text = [hit.partial ? `gehört zu ${k.code}` : k.code, meaning(k) || k.category].filter(Boolean).join(' – ');
  return (
    <span className={className ?? 'text-meta text-fg-muted'} title={k.details || undefined}>
      {text}
    </span>
  );
}
