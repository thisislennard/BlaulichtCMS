import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, Chip, FieldWrap, Input, Notice, Rev, Select, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { HelpTip } from '../../components/ui/HelpTip';
import { CopyButton, Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { BLUESKY_MAX, blueskyLength, mastodonLength, SOCIAL_KINDS, SOCIAL_LABEL, STORY_KINDS, threadsLength, xLength, type SocialKind } from '../../lib/social';
import { safeHref } from '../../lib/url';
import { MetricLine } from './Insights';

export interface SocialTarget {
  id: string;
  kind: SocialKind;
  name: string;
  status: string;
  manual?: boolean;
  capabilities: Record<string, any>;
}
export interface SocialDraft {
  social: string[];
  /** Format je Kanal: feed (Standard), story oder both – nur Facebook und Instagram */
  formats: Record<string, string>;
  fb: string;
  ig: string;
  th: string;
  xt: string;
  wa: string;
  /** Mastodon: eigener Text und Inhaltswarnung */
  md: string;
  mdCw: string;
  bs: string;
}

const KIND = SOCIAL_LABEL;
const SOCIAL_LABELS = { queued: 'Wartet', publishing: 'Wird veröffentlicht', published: 'Veröffentlicht', failed: 'Fehlgeschlagen', unknown: 'Ergebnis unbekannt – wird geprüft', canceled: 'Abgebrochen' };
const REMOVAL_RESULT: Record<string, string> = { removed: 'Entfernt', manual: 'Von Hand löschen', failed: 'Löschen fehlgeschlagen', canceled: 'Abgebrochen', pending: 'Noch offen' };
const kindName = (k: string) => KIND[k as SocialKind] ?? k;

/** Formate je Kanal: nur gewählte Kanäle und nur Abweichungen vom Standard „Beitrag“ (wie der Server). */
export function cleanFormats(f: Record<string, string> | null | undefined, targets: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(f ?? {})
      .filter(([k, v]) => targets.includes(k) && (v === 'story' || v === 'both'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function useSocialTargets() {
  const { can } = useAuth();
  return useQuery({ queryKey: ['social-targets'], queryFn: () => get<SocialTarget[]>('/connections').then((l) => l.filter((c) => (SOCIAL_KINDS as string[]).includes(c.kind))), enabled: can('connection.view') });
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={n > max ? 'text-warn' : 'text-fg-muted'}>{n} / {max}</span>;
}

/** Auswahl der sozialen Kanäle, Formate und eigene Texte – Teil der Fassung. */
export function SocialTargetsCard({ draft, onChange, editable }: { draft: SocialDraft; onChange: (d: SocialDraft) => void; editable: boolean }) {
  const { can } = useAuth();
  const targets = useSocialTargets();
  const list = targets.data ?? [];
  // Ohne „Verbindungen ansehen“ ist die Kanalliste nicht abrufbar – dann gibt es hier nichts zu wählen
  if (!can('connection.view') && !draft.social.length) return null;
  if (!list.length && !draft.social.length)
    return (
      <Card title="Soziale Kanäle">
        <p className="m-0 text-sm text-fg-muted">Kein sozialer Kanal verbunden. {can('connection.configure') && <Link to="/verbindungen">Verbindung einrichten</Link>}</p>
      </Card>
    );
  const chosen = (k: SocialKind) => draft.social.filter((id) => list.find((t) => t.id === id)?.kind === k);
  const fmt = (id: string) => draft.formats[id] ?? 'feed';
  // Eigener Text für Facebook/Instagram nur, wenn dort ein Beitrag (nicht nur eine Story) geplant ist – Storys haben keinen Text
  const feedOf = (k: SocialKind) => chosen(k).some((id) => fmt(id) !== 'story');
  // Höchstlänge der Mastodon-Instanz(en) laut letztem Test – bei mehreren gilt die kleinste
  const mastodonMax = Math.min(...chosen('mastodon').map((id) => Number(list.find((t) => t.id === id)?.capabilities?.max_characters) || 500), 500 * 100);
  return (
    <Card title="Soziale Kanäle" subtitle="Jeder Kanal hat eigenen Status. Eine Änderung der Auswahl oder des Formats verlangt eine neue Freigabe.">
      <div className="flex flex-col gap-3">
        {list.map((t) => {
          const on = draft.social.includes(t.id);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" disabled={!editable} checked={on} onChange={(e) => onChange({ ...draft, social: e.target.checked ? [...draft.social, t.id] : draft.social.filter((x) => x !== t.id) })} />
                <Chip>{kindName(t.kind)}</Chip>
                <span>{t.name}</span>
              </label>
              {t.manual && <span className="text-meta text-fg-muted">Teilen von Hand</span>}
              {t.status !== 'active' && <span className="text-meta text-warn">noch nicht aktiviert</span>}
              {on && STORY_KINDS.includes(t.kind) && (
                <div className="flex items-center gap-1 ml-auto">
                  <label htmlFor={`fmt-${t.id}`} className="sr-only">Format für {t.name}</label>
                  <Select id={`fmt-${t.id}`} disabled={!editable} value={fmt(t.id)} onChange={(e) => onChange({ ...draft, formats: { ...draft.formats, [t.id]: e.target.value } })} className="w-auto">
                    <option value="feed">Beitrag</option>
                    <option value="story">Story</option>
                    <option value="both">Beitrag und Story</option>
                  </Select>
                  <HelpTip title="Story" more="/hilfe/verbindungen#storys">
                    <p className="m-0">Eine Story zeigt <strong>ein</strong> Bild oder Video 24 Stunden lang – ohne Text. Verwendet wird die erste Datei des Beitrags.</p>
                    <p className="m-0">Bilder bringt BlaulichtCMS dafür auf das Hochformat 9:16 (1080 × 1920), ohne etwas abzuschneiden. Videos sollten im Hochformat sein und 3 bis 60 Sekunden dauern.</p>
                  </HelpTip>
                </div>
              )}
            </div>
          );
        })}
        {feedOf('facebook') && (
          <FieldWrap label="Eigener Text für Facebook (optional)" help="Leer = Titel und Kurzfassung bzw. Text." htmlFor="s-fb">
            <Textarea id="s-fb" rows={3} disabled={!editable} value={draft.fb} onChange={(e) => onChange({ ...draft, fb: e.target.value })} maxLength={60000} />
          </FieldWrap>
        )}
        {feedOf('instagram') && (
          <FieldWrap label="Eigene Bildunterschrift für Instagram (optional)" help="Höchstens 2.200 Zeichen. Instagram braucht mindestens ein Bild oder Video." htmlFor="s-ig">
            <Textarea id="s-ig" rows={3} disabled={!editable} value={draft.ig} onChange={(e) => onChange({ ...draft, ig: e.target.value })} maxLength={2200} />
          </FieldWrap>
        )}
        {chosen('threads').length > 0 && (
          <FieldWrap label="Eigener Text für Threads (optional)" help={<>Höchstens 500 Zeichen (Emojis zählen mehrfach), sonst wird gekürzt. Der Link zur Website wird angehängt, wenn der Beitrag dort schon veröffentlicht ist. <Counter n={threadsLength(draft.th)} max={500} /></>} htmlFor="s-th">
            <Textarea id="s-th" rows={3} disabled={!editable} value={draft.th} onChange={(e) => onChange({ ...draft, th: e.target.value })} maxLength={2000} />
          </FieldWrap>
        )}
        {chosen('x').length > 0 && (
          <FieldWrap label="Eigener Text für X (optional)" help={<>Höchstens 280 Zeichen nach den Zählregeln von X (jede Adresse zählt 23, Emojis 2) – inklusive des angehängten Links zur Website, sonst wird gekürzt. <Counter n={xLength(draft.xt)} max={280} /></>} htmlFor="s-x">
            <Textarea id="s-x" rows={3} disabled={!editable} value={draft.xt} onChange={(e) => onChange({ ...draft, xt: e.target.value })} maxLength={2000} />
          </FieldWrap>
        )}
        {chosen('mastodon').length > 0 && (
          <>
            <FieldWrap label="Eigener Text für Mastodon (optional)" help={<>Höchstens {mastodonMax} Zeichen (Grenze der Instanz, die Inhaltswarnung zählt mit; jede Adresse zählt 23), sonst wird gekürzt. Der Link zur Website wird angehängt. <Counter n={mastodonLength(draft.md) + mastodonLength(draft.mdCw)} max={mastodonMax} /></>} htmlFor="s-md">
              <Textarea id="s-md" rows={3} disabled={!editable} value={draft.md} onChange={(e) => onChange({ ...draft, md: e.target.value })} maxLength={5000} />
            </FieldWrap>
            <FieldWrap label="Inhaltswarnung für Mastodon (optional)" htmlFor="s-mdcw" help="Steht vor dem Beitrag; der Text ist erst nach einem Klick sichtbar – z. B. „Einsatz mit Verletzten“." labelAction={
              <HelpTip title="Inhaltswarnung" more="/hilfe/verbindungen#mastodon">
                <p className="m-0">Auf Mastodon ist es üblich, belastende Inhalte hinter einer kurzen Warnung zu verbergen. Leer lassen, wenn der Beitrag ohne Warnung erscheinen soll.</p>
              </HelpTip>
            }>
              <Input id="s-mdcw" disabled={!editable} value={draft.mdCw} onChange={(e) => onChange({ ...draft, mdCw: e.target.value })} maxLength={500} />
            </FieldWrap>
          </>
        )}
        {chosen('bluesky').length > 0 && (
          <FieldWrap label="Eigener Text für Bluesky (optional)" help={<>Höchstens {BLUESKY_MAX} Zeichen inklusive des angehängten Links zur Website (und höchstens 3000 Byte – Emojis und Sonderzeichen brauchen mehr als eins), sonst wird gekürzt. Ohne Bilder zeigt Bluesky den Link als Vorschaukarte. <Counter n={blueskyLength(draft.bs)} max={BLUESKY_MAX} /></>} htmlFor="s-bs">
            <Textarea id="s-bs" rows={3} disabled={!editable} value={draft.bs} onChange={(e) => onChange({ ...draft, bs: e.target.value })} maxLength={2000} />
          </FieldWrap>
        )}
        {chosen('whatsapp').length > 0 && (
          <FieldWrap label="Eigener Text für den WhatsApp-Kanal (optional)" help="WhatsApp-Formatierung möglich: *fett*, _kursiv_, ~durchgestrichen~. Leer = Titel fett, darunter Kurzfassung bzw. Text und der Link zur Website." htmlFor="s-wa">
            <Textarea id="s-wa" rows={3} disabled={!editable} value={draft.wa} onChange={(e) => onChange({ ...draft, wa: e.target.value })} maxLength={60000} />
          </FieldWrap>
        )}
      </div>
    </Card>
  );
}

/** Formatprüfung, Veröffentlichen, Status je Kanal, gezieltes Wiederholen, Teilen von Hand, manueller Export. */
export function SocialStatusCard({ postId, revision, hash, approved, targets, items, dirty, onChanged }: { postId: string; revision: number; hash: string; approved: boolean; targets: string[]; items: any[]; dirty: boolean; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const [exp, setExp] = useState<any>(null);
  const [removing, setRemoving] = useState(false);
  const [sharing, setSharing] = useState<any>(null);
  const removable = items.some((s) => (s.status === 'published' && s.removal_status !== 'removed') || ['queued', 'failed', 'ready'].includes(s.status));
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
  const manualTargets = (check.data ?? []).filter((c) => c.manual);
  return (
    <Card title="Soziale Kanäle – Status">
      <div className="flex flex-col gap-3 text-sm">
        {issues.map((c) => (
          <Notice key={c.id} tone="warning" title={`${kindName(c.kind)}: ${c.name}`}>
            <ul className="m-0 pl-4">
              {c.issues.map((i: string) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </Notice>
        ))}
        {approved && targets.length > 0 && can('publish.social') && !dirty && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon="Share2" onClick={() => act(() => post(`/posts/${postId}/social`, { revision, contentHash: hash }), 'Veröffentlichung auf sozialen Kanälen beauftragt')}>
                Auf sozialen Kanälen veröffentlichen
              </Button>
              <Button icon="Download" onClick={async () => setExp(await get(`/posts/${postId}/social-export`).catch((e) => (toastError(e), null)))}>
                Manuell exportieren
              </Button>
            </div>
            {manualTargets.length > 0 && <p className="m-0 text-meta text-fg-muted">{manualTargets.map((c) => c.name).join(', ')}: ohne Schnittstelle – nach dem Beauftragen „Zum Teilen bereit“ mit vorbereitetem Text.</p>}
          </div>
        )}
        {removable && can('publish.social_remove') && (
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
                  {s.status === 'ready' ? <Badge tone="warning">Zum Teilen bereit</Badge> : <StatusBadge status={s.status} labels={SOCIAL_LABELS} />}
                  <span>
                    {kindName(s.kind)}: {s.connection_name}
                  </span>
                  {s.format === 'story' && <Chip>Story</Chip>}
                  <Rev n={s.revision_number} className="text-fg-muted" />
                </div>
                {s.remote_url && (
                  <a href={safeHref(s.remote_url)} target="_blank" rel="noopener noreferrer" className="break-all">
                    {s.remote_url}
                  </a>
                )}
                {s.status === 'published' && !s.shared_at && s.format !== 'story' && can('insights.view') && (
                  <div className="text-meta">
                    {s.insights ? (
                      <>
                        <MetricLine m={s.insights} />
                        <span className="text-fg-muted">Stand {fmtDateTime(s.insights_at)}{s.insights_stage >= 3 ? ' (letzter Abruf)' : ''}</span>
                      </>
                    ) : s.insights_error ? (
                      <span className="text-warn">Reichweite: {s.insights_error}</span>
                    ) : (
                      <span className="text-fg-muted">Reichweite: erster Abruf eine Stunde nach der Veröffentlichung.</span>
                    )}
                  </div>
                )}
                {s.status === 'ready' && can('publish.social') && (
                  <div>
                    <Button size="sm" variant="primary" icon="Share2" onClick={() => setSharing(s)}>
                      Jetzt teilen
                    </Button>
                  </div>
                )}
                {s.shared_at && <div className="text-fg-muted">Von Hand geteilt{s.shared_by_name ? ` von ${s.shared_by_name}` : ''} am {fmtDateTime(s.shared_at)}.</div>}
                {s.error && s.status !== 'canceled' && <div className="text-err">{s.error}</div>}
                {s.removal_status === 'removed' && <div className="text-fg-muted">Entfernt {fmtDateTime(s.removed_at)}.</div>}
                {['manual', 'failed'].includes(s.removal_status) && (
                  <Notice tone="warning" title={s.removal_status === 'manual' ? 'Bitte von Hand löschen' : 'Löschen fehlgeschlagen'}>
                    <div className="flex flex-col gap-2">
                      <span>{s.removal_error}</span>
                      <div className="flex flex-wrap gap-2">
                        {s.remote_url && (
                          <a href={safeHref(s.remote_url)} target="_blank" rel="noopener noreferrer">
                            Beitrag in {kindName(s.kind)} öffnen
                          </a>
                        )}
                        {can('publish.social_remove') && (
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
                  {fmtDateTime(s.created_at)}
                  {s.status !== 'ready' && !s.shared_at ? ` · ${s.attempts} Versuch(e)` : ''}
                  {s.published_at && !s.shared_at ? ` · veröffentlicht ${fmtDateTime(s.published_at)}` : ''}
                </div>
                {['failed', 'unknown'].includes(s.status) && can('publish.social') && (
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
      {sharing && <ShareDialog item={sharing} onClose={(changed) => (setSharing(null), changed && onChanged())} />}
      {exp && (
        <Dialog open onClose={() => setExp(null)} title="Manueller Export" width={640}>
          <div className="flex flex-col gap-4 text-sm">
            <p className="m-0 text-fg-muted">Freigegebener Text je Kanal und Dateien (Links gelten {exp.expires_in_hours} Stunden).</p>
            {SOCIAL_KINDS.filter((k) => typeof exp[k] === 'string').map((k) => (
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

/** Teilen von Hand (X ohne API, WhatsApp-Kanal): Text kopieren, Netzwerk öffnen, Dateien laden, als geteilt markieren. */
function ShareDialog({ item, onClose }: { item: any; onClose: (changed: boolean) => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['social-share', item.id], queryFn: () => get<any>(`/social-publications/${item.id}/share`) });
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const mark = async () => {
    setBusy(true);
    try {
      await post(`/social-publications/${item.id}/mark-shared`, { url: url.trim() });
      toast({ tone: 'success', title: 'Als geteilt markiert' });
      onClose(true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const isX = item.kind === 'x';
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      title={`Teilen von Hand: ${item.connection_name}`}
      width={640}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Schließen</Button>
          <Button variant="primary" icon="Check" loading={busy} disabled={!d || (!!url.trim() && !/^https:\/\/\S+$/.test(url.trim()))} onClick={mark}>
            Als geteilt markieren
          </Button>
        </>
      }
    >
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <Notice tone="error">{(q.error as Error).message}</Notice>}
      {d && (
        <div className="flex flex-col gap-4 text-sm">
          <ol className="m-0 pl-5 flex flex-col gap-1">
            <li>{isX ? 'Auf „In X öffnen“ klicken – der Text steht schon im Beitragsfenster.' : 'Text kopieren und den Kanal in WhatsApp öffnen.'}</li>
            {d.files.length > 0 && <li>{isX ? 'Bilder bei Bedarf herunterladen und im Beitragsfenster anhängen.' : 'Bilder bei Bedarf herunterladen und an die Kanalmeldung anhängen.'}</li>}
            <li>Posten, danach hier „Als geteilt markieren“ – optional mit dem Link zum Beitrag.</li>
          </ol>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <strong>Text{isX ? ` (${xLength(d.text)} / 280)` : ''}</strong>
              <CopyButton value={d.text} size="sm" />
            </div>
            <pre className="m-0 p-2 bg-raised rounded-control whitespace-pre-wrap text-meta">{d.text}</pre>
          </div>
          <div>
            <a href={safeHref(d.openUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 h-9 px-3 rounded-control border border-line bg-card hover:bg-raised font-medium">
              {d.openLabel}
            </a>
          </div>
          {d.files.length > 0 && (
            <div className="flex flex-col gap-1">
              <strong>Dateien (Links gelten {d.expires_in_hours} Stunden)</strong>
              <ul className="m-0 pl-4">
                {d.files.map((f: any) => (
                  <li key={f.url}>
                    <a href={f.url} download={f.name}>
                      {f.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <FieldWrap label="Link zum geteilten Beitrag (optional)" htmlFor="share-url" help="Nur https-Adressen. Erscheint im Verlauf des Beitrags.">
            <Input id="share-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} />
          </FieldWrap>
        </div>
      )}
    </Dialog>
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
                  {kindName(r.kind)}: {r.name}
                </span>
              </div>
              <span className="text-fg-muted">{r.message}</span>
              {r.url && ['manual', 'failed'].includes(r.result) && (
                <a href={safeHref(r.url)} target="_blank" rel="noopener noreferrer" className="break-all">
                  Beitrag in {kindName(r.kind)} öffnen
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="m-0">Beiträge auf Facebook, Mastodon, Bluesky und X (über die X-API gepostet) löscht BlaulichtCMS über die Schnittstelle. Instagram, Threads, Storys und von Hand Geteiltes lassen sich so nicht löschen: Dort von Hand löschen (Link folgt, wenn bekannt) und anschließend hier bestätigen. Noch nicht ausgeführte Aufträge werden abgebrochen. Alle Schritte werden protokolliert.</p>
          <FieldWrap label="Grund" required htmlFor="sr-reason">
            <Textarea id="sr-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </FieldWrap>
        </div>
      )}
    </Dialog>
  );
}
