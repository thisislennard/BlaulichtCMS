import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, Chip, FieldWrap, Notice, Rev, StatusBadge, Textarea } from '../../components/ui/core';
import { CopyButton, Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { safeHref } from '../../lib/url';

export interface SocialTarget {
  id: string;
  kind: 'facebook' | 'instagram';
  name: string;
  status: string;
  capabilities: Record<string, boolean>;
}
export interface SocialDraft {
  social: string[];
  fb: string;
  ig: string;
}

const KIND = { facebook: 'Facebook', instagram: 'Instagram' } as const;
const SOCIAL_LABELS = { queued: 'Wartet', publishing: 'Wird veröffentlicht', published: 'Veröffentlicht', failed: 'Fehlgeschlagen', unknown: 'Ergebnis unbekannt – wird geprüft', canceled: 'Abgebrochen' };
const REMOVAL_RESULT: Record<string, string> = { removed: 'Entfernt', manual: 'Von Hand löschen', failed: 'Löschen fehlgeschlagen', canceled: 'Abgebrochen', pending: 'Noch offen' };

export function useSocialTargets() {
  return useQuery({ queryKey: ['social-targets'], queryFn: () => get<SocialTarget[]>('/connections').then((l) => l.filter((c) => ['facebook', 'instagram'].includes(c.kind))) });
}

/** Auswahl der sozialen Kanäle und eigene Texte – Teil der Fassung. */
export function SocialTargetsCard({ draft, onChange, editable }: { draft: SocialDraft; onChange: (d: SocialDraft) => void; editable: boolean }) {
  const { can } = useAuth();
  const targets = useSocialTargets();
  const list = targets.data ?? [];
  if (!list.length && !draft.social.length)
    return (
      <Card title="Soziale Kanäle">
        <p className="m-0 text-sm text-fg-muted">Keine Facebook-Seite oder kein Instagram-Konto verbunden. {can('connection.manage') && <Link to="/verbindungen">Verbindung einrichten</Link>}</p>
      </Card>
    );
  const hasFb = draft.social.some((id) => list.find((t) => t.id === id)?.kind === 'facebook');
  const hasIg = draft.social.some((id) => list.find((t) => t.id === id)?.kind === 'instagram');
  return (
    <Card title="Soziale Kanäle" subtitle="Jeder Kanal hat eigenen Status. Eine Änderung der Auswahl verlangt eine neue Freigabe.">
      <div className="flex flex-col gap-3">
        {list.map((t) => (
          <label key={t.id} className="flex items-center gap-2">
            <input type="checkbox" disabled={!editable} checked={draft.social.includes(t.id)} onChange={(e) => onChange({ ...draft, social: e.target.checked ? [...draft.social, t.id] : draft.social.filter((x) => x !== t.id) })} />
            <Chip>{KIND[t.kind]}</Chip>
            <span>{t.name}</span>
            {t.status !== 'active' && <span className="text-meta text-warn">noch nicht aktiviert</span>}
          </label>
        ))}
        {hasFb && (
          <FieldWrap label="Eigener Text für Facebook (optional)" help="Leer = Titel und Kurzfassung bzw. Text." htmlFor="s-fb">
            <Textarea id="s-fb" rows={3} disabled={!editable} value={draft.fb} onChange={(e) => onChange({ ...draft, fb: e.target.value })} maxLength={60000} />
          </FieldWrap>
        )}
        {hasIg && (
          <FieldWrap label="Eigene Bildunterschrift für Instagram (optional)" help="Höchstens 2.200 Zeichen. Instagram braucht mindestens ein Bild oder Video." htmlFor="s-ig">
            <Textarea id="s-ig" rows={3} disabled={!editable} value={draft.ig} onChange={(e) => onChange({ ...draft, ig: e.target.value })} maxLength={2200} />
          </FieldWrap>
        )}
      </div>
    </Card>
  );
}

/** Formatprüfung, Veröffentlichen, Status je Kanal, gezieltes Wiederholen, manueller Export. */
export function SocialStatusCard({ postId, revision, hash, approved, targets, items, dirty, onChanged }: { postId: string; revision: number; hash: string; approved: boolean; targets: string[]; items: any[]; dirty: boolean; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const [exp, setExp] = useState<any>(null);
  const [removing, setRemoving] = useState(false);
  const removable = items.some((s) => (s.status === 'published' && s.removal_status !== 'removed') || ['queued', 'failed'].includes(s.status));
  const check = useQuery({ queryKey: ['social-check', postId, revision], queryFn: () => get<any[]>(`/posts/${postId}/social-check`), enabled: targets.length > 0 });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  if (!targets.length && !items.length) return null;
  const issues = (check.data ?? []).filter((c) => c.issues.length);
  return (
    <Card title="Soziale Kanäle – Status">
      <div className="flex flex-col gap-3 text-sm">
        {issues.map((c) => (
          <Notice key={c.id} tone="warning" title={`${KIND[c.kind as 'facebook']}: ${c.name}`}>
            <ul className="m-0 pl-4">
              {c.issues.map((i: string) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </Notice>
        ))}
        {approved && targets.length > 0 && can('post.publish') && !dirty && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon="Share2" onClick={() => act(() => post(`/posts/${postId}/social`, { revision, contentHash: hash }), 'Veröffentlichung auf sozialen Kanälen beauftragt')}>
              Auf sozialen Kanälen veröffentlichen
            </Button>
            <Button icon="Download" onClick={async () => setExp(await get(`/posts/${postId}/social-export`).catch((e) => (toastError(e), null)))}>
              Manuell exportieren
            </Button>
          </div>
        )}
        {removable && can('post.publish') && (
          <div>
            <Button size="sm" icon="Ban" onClick={() => setRemoving(true)}>
              Von sozialen Kanälen entfernen
            </Button>
          </div>
        )}
        {items.length === 0 ? (
          <p className="m-0 text-fg-muted">Noch nicht veröffentlicht.</p>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-3">
            {items.map((s) => (
              <li key={s.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={s.status} labels={SOCIAL_LABELS} />
                  <span>
                    {KIND[s.kind as 'facebook']}: {s.connection_name}
                  </span>
                  <Rev n={s.revision_number} className="text-fg-muted" />
                </div>
                {s.remote_url && (
                  <a href={safeHref(s.remote_url)} target="_blank" rel="noopener noreferrer" className="break-all">
                    {s.remote_url}
                  </a>
                )}
                {s.error && s.status !== 'canceled' && <div className="text-err">{s.error}</div>}
                {s.removal_status === 'removed' && <div className="text-fg-muted">Entfernt {fmtDateTime(s.removed_at)}.</div>}
                {['manual', 'failed'].includes(s.removal_status) && (
                  <Notice tone="warning" title={s.removal_status === 'manual' ? 'Bitte von Hand löschen' : 'Löschen fehlgeschlagen'}>
                    <div className="flex flex-col gap-2">
                      <span>{s.removal_error}</span>
                      <div className="flex flex-wrap gap-2">
                        {s.remote_url && (
                          <a href={safeHref(s.remote_url)} target="_blank" rel="noopener noreferrer">
                            Beitrag in {KIND[s.kind as 'facebook']} öffnen
                          </a>
                        )}
                        {can('post.publish') && (
                          <Button size="sm" icon="Check" onClick={() => act(() => post(`/social-publications/${s.id}/confirm-removed`), 'Löschung bestätigt')}>
                            Gelöscht – bestätigen
                          </Button>
                        )}
                      </div>
                    </div>
                  </Notice>
                )}
                {s.status === 'unknown' && <div className="text-warn">Vor einem neuen Versuch prüft BlaulichtCMS, ob der Beitrag bereits existiert.</div>}
                <div className="text-meta text-fg-muted">
                  {fmtDateTime(s.created_at)} · {s.attempts} Versuch(e){s.published_at ? ` · veröffentlicht ${fmtDateTime(s.published_at)}` : ''}
                </div>
                {['failed', 'unknown'].includes(s.status) && can('post.publish') && (
                  <div>
                    <Button size="sm" icon="RefreshCw" onClick={() => act(() => post(`/social-publications/${s.id}/retry`), 'Nur dieser Kanal wird erneut versucht')}>
                      {s.status === 'unknown' ? 'Prüfen und ggf. erneut versuchen' : 'Nur diesen Kanal erneut versuchen'}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {removing && <RemoveDialog postId={postId} onClose={() => (setRemoving(false), onChanged())} />}
      {exp && (
        <Dialog open onClose={() => setExp(null)} title="Manueller Export" width={640}>
          <div className="flex flex-col gap-4 text-sm">
            <p className="m-0 text-fg-muted">Freigegebener Text je Kanal und Dateien (Links gelten {exp.expires_in_hours} Stunden).</p>
            {(['facebook', 'instagram'] as const).map((k) => (
              <div key={k} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <strong>{KIND[k]}</strong>
                  <CopyButton value={exp[k]} size="sm" />
                </div>
                <pre className="m-0 p-2 bg-raised rounded-control whitespace-pre-wrap text-meta">{exp[k]}</pre>
              </div>
            ))}
            <ul className="m-0 pl-4">
              {exp.files.map((f: any) => (
                <li key={f.url}>
                  <a href={f.url} download={f.name}>
                    {f.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** Zurückziehen auf sozialen Kanälen (#114): zeigt je Kanal, was passiert ist. */
function RemoveDialog({ postId, onClose }: { postId: string; onClose: () => void }) {
  const toastError = useErrorToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any[] | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult((await post<{ items: any[] }>(`/posts/${postId}/social/remove`, { reason: reason.trim() })).items);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Von sozialen Kanälen entfernen"
      width={560}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={run}>
              Entfernen
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ul className="m-0 p-0 list-none flex flex-col gap-3 text-sm">
          {result.map((r) => (
            <li key={r.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone={r.result === 'removed' || r.result === 'canceled' ? 'success' : 'warning'}>{REMOVAL_RESULT[r.result] ?? r.result}</Badge>
                <span>
                  {KIND[r.kind as 'facebook']}: {r.name}
                </span>
              </div>
              <span className="text-fg-muted">{r.message}</span>
              {r.url && ['manual', 'failed'].includes(r.result) && (
                <a href={safeHref(r.url)} target="_blank" rel="noopener noreferrer" className="break-all">
                  Beitrag in {KIND[r.kind as 'facebook']} öffnen
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="m-0">Facebook-Beiträge löscht BlaulichtCMS über die Schnittstelle. Instagram erlaubt das nicht: Dort den Beitrag von Hand löschen (Link folgt) und anschließend hier bestätigen. Noch nicht ausgeführte Aufträge werden abgebrochen. Alle Schritte werden protokolliert.</p>
          <FieldWrap label="Grund" required htmlFor="sr-reason">
            <Textarea id="sr-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </FieldWrap>
        </div>
      )}
    </Dialog>
  );
}
