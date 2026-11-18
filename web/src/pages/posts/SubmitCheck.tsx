import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Button, cx, Notice, SkeletonRows } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { plural } from '../../lib/format';

/** Prüfliste der gespeicherten Fassung (#262) – kommt vom Server (lib/post-checklist.ts), keine eigenen Regeln hier. */
export type CheckLevel = 'ok' | 'info' | 'warning' | 'blocking';
export type CheckSection = 'text' | 'medien' | 'website' | 'netzwerke';
export interface CheckItem {
  key: string;
  level: CheckLevel;
  title: string;
  details?: string[];
  section?: CheckSection;
}
export interface PostChecklist {
  revision: number;
  items: CheckItem[];
  blocking: boolean;
  warnings: number;
}

export const usePostChecklist = (postId: string, revision: number, enabled = true) =>
  useQuery({ queryKey: ['post-checklist', postId, revision], queryFn: () => get<PostChecklist>(`/posts/${postId}/checklist`), enabled });

const LEVEL: Record<CheckLevel, { icon: string; cls: string; sr: string }> = {
  blocking: { icon: 'XCircle', cls: 'text-err', sr: 'Verhindert das Einreichen: ' },
  warning: { icon: 'AlertTriangle', cls: 'text-warn', sr: 'Hinweis: ' },
  info: { icon: 'Info', cls: 'text-fg-muted', sr: 'Zur Information: ' },
  ok: { icon: 'CircleCheck', cls: 'text-ok', sr: 'Erledigt: ' },
};
const ORDER: CheckLevel[] = ['blocking', 'warning', 'info', 'ok'];

/** Eine Zeile der Prüfliste mit Symbol, Text und „Beheben →“ (springt in den passenden Abschnitt des Beitrags). */
export function CheckRow({ item, onFix }: { item: CheckItem; onFix?: (section: CheckSection) => void }) {
  const l = LEVEL[item.level];
  return (
    <li className="flex items-start gap-2 py-2 border-b border-line last:border-b-0">
      <Icon name={l.icon} size={16} className={cx('mt-0.5 shrink-0', l.cls)} />
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className={cx('text-sm', item.level !== 'ok' && 'font-medium')}>
          <span className="sr-only">{l.sr}</span>
          {item.title}
        </span>
        {item.details?.map((d) => (
          <span key={d} className="text-meta text-fg-muted">
            {d}
          </span>
        ))}
      </div>
      {item.level !== 'ok' && item.section && onFix && (
        <Button size="sm" variant="ghost" iconRight="ArrowRight" onClick={() => onFix(item.section!)}>
          Beheben
        </Button>
      )}
    </li>
  );
}

/**
 * Prüfliste vor dem Einreichen (#262): nennt fehlende Ziele, Titelbild, Alternativtexte, Datenschutz-Prüfung und die
 * Anforderungen je Netzwerk (Formate, Zeichengrenzen). Hinweise blockieren nicht; gesperrt ist nur, woran die
 * Freigabe ohnehin scheitern würde – mit sichtbarem Grund.
 */
export function SubmitDialog({ postId, revision, again, onClose, onFix, onDone }: { postId: string; revision: number; again?: boolean; onClose: () => void; onFix: (section: CheckSection) => void; onDone: () => void }) {
  const q = usePostChecklist(postId, revision);
  const toast = useToast();
  const toastError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const items = d ? [...d.items].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level)) : [];
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/posts/${postId}/submit`, { revision });
      toast({ tone: 'success', title: again ? 'Erneut eingereicht' : 'Zur Freigabe eingereicht' });
      onDone();
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
      q.refetch();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={again ? 'Erneut einreichen' : 'Zur Freigabe einreichen'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon="Send" loading={busy} disabled={!d || d.blocking} onClick={submit}>
            {d && d.warnings > 0 ? 'Trotzdem einreichen' : 'Einreichen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-fg-muted">Prüfliste für Fassung {revision} – dieselben Prüfungen wie bei Freigabe und Veröffentlichung.</p>
        {q.isLoading && <SkeletonRows rows={4} />}
        {q.error && <Notice tone="error">{(q.error as Error).message}</Notice>}
        {d && (
          <>
            {d.blocking ? (
              <Notice tone="error" title="Einreichen noch nicht möglich">
                Die rot markierten Punkte würden die Freigabe scheitern lassen. Bitte zuerst beheben und speichern.
              </Notice>
            ) : d.warnings > 0 ? (
              <Notice tone="warning" title={plural(d.warnings, 'Hinweis', 'Hinweise')}>
                Einreichen ist trotzdem möglich – die Freigabe sieht dieselben Hinweise.
              </Notice>
            ) : (
              <Notice tone="success">Alles bereit.</Notice>
            )}
            <ul className="m-0 p-0 list-none">
              {items.map((i) => (
                <CheckRow key={i.key} item={i} onFix={(s) => (onClose(), onFix(s))} />
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
