import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, Switch } from '../../components/ui/core';
import { CopyButton, OneTimeSecret, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { HelpTip } from '../../components/ui/HelpTip';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';
import { InsightsNav } from './InsightsNav';

/**
 * Social-Feed: freigegebene Beiträge der Facebook-Seite bzw. des Instagram-Kontos als RSS (geheime Adresse) und als
 * Website-Widget über die Bridge (Shortcode [blaulichtcms_social]). Bilder kommen aus BlaulichtCMS bzw. von der
 * Website selbst – Besucher laden nichts von Meta.
 */
interface Feed {
  enabled: boolean;
  connection_ids: string[];
  max_items: number;
  rss: { active: boolean; created_at: string | null; used_at: string | null };
  connections: { id: string; kind: 'facebook' | 'instagram'; name: string; active: boolean; sync: boolean }[];
  posts: { id: string; connection_id: string; kind: string; posted_at: string; message: string; permalink: string | null; image_file: string | null; hidden: boolean; publication_id: string | null }[];
  visible: string[];
}
const NET: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram' };

export default function SocialFeed() {
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['social-feed'], queryFn: () => get<Feed>('/social-feed') });
  const [draft, setDraft] = useState<{ enabled: boolean; connection_ids: string[]; max_items: number } | null>(null);
  const [rssUrl, setRssUrl] = useState<string | null>(null);
  const d = q.data;
  const cur = draft ?? (d ? { enabled: d.enabled, connection_ids: d.connection_ids, max_items: d.max_items } : null);
  const reload = () => qc.invalidateQueries({ queryKey: ['social-feed'] });

  const save = async () => {
    if (!cur) return;
    try {
      await put('/social-feed', cur);
      setDraft(null);
      reload();
      toast({ tone: 'success', title: 'Gespeichert' });
    } catch (e) {
      toastError(e);
    }
  };
  const toggleHidden = async (id: string, hidden: boolean) => {
    try {
      await put(`/social-feed/posts/${id}`, { hidden });
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const createRss = async () => {
    if (d?.rss.active && !(await confirm({ title: 'RSS-Adresse erneuern?', text: 'Die bisherige Adresse funktioniert danach nicht mehr. Wer den Feed abonniert hat, braucht die neue Adresse.', confirmLabel: 'Erneuern' }))) return;
    try {
      const r = await post<{ url: string }>('/social-feed/rss');
      setRssUrl(r.url);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const revokeRss = async () => {
    if (!(await confirm({ title: 'RSS-Adresse widerrufen?', text: 'Abonnenten erhalten danach keine Beiträge mehr. Das Website-Widget ist davon nicht betroffen.', confirmLabel: 'Widerrufen' }))) return;
    try {
      await del('/social-feed/rss');
      setRssUrl(null);
      reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Beiträge der Facebook-Seite und des Instagram-Kontos für die Website und als RSS-Feed." />
      <InsightsNav />
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Social-Feed konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {d && cur && d.connections.length === 0 && <EmptyState icon="Rss" title="Keine Facebook-Seite und kein Instagram-Konto verbunden" text="Der Social-Feed zeigt Beiträge aus den Verbindungen zu Facebook und Instagram." action={<Link to="/verbindungen">Zu den Verbindungen</Link>} />}
      {d && cur && d.connections.length > 0 && (
        <>
          <Card title="Freigabe" subtitle="Was im Feed erscheint, ist öffentlich: auf der Website und für alle mit der RSS-Adresse.">
            <div className="flex flex-col gap-4">
              <Switch checked={cur.enabled} onChange={(v) => setDraft({ ...cur, enabled: v })} label="Social-Feed freigeben" description="Aus: Website-Widget und RSS-Feed bleiben leer." />
              <fieldset className="border border-line rounded-node p-3 m-0 flex flex-col gap-2">
                <legend className="px-1 text-sm font-medium">Quellen</legend>
                {d.connections.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={cur.connection_ids.includes(c.id)} onChange={(e) => setDraft({ ...cur, connection_ids: e.target.checked ? [...cur.connection_ids, c.id] : cur.connection_ids.filter((x) => x !== c.id) })} />
                    <span>
                      {NET[c.kind]}: {c.name}
                    </span>
                    {!c.active && <Badge tone="neutral">nicht aktiv</Badge>}
                    {c.active && !c.sync && <Badge tone="warning">Abgleich aus</Badge>}
                  </label>
                ))}
              </fieldset>
              <FieldWrap label="Anzahl Beiträge" htmlFor="sf-max" help="Die neuesten Beiträge, höchstens 50.">
                <Input id="sf-max" type="number" min={1} max={50} value={cur.max_items} onChange={(e) => setDraft({ ...cur, max_items: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} className="max-w-[120px]" />
              </FieldWrap>
              <div>
                <Button variant="primary" icon="Save" disabled={!draft} onClick={save}>
                  Speichern
                </Button>
              </div>
            </div>
          </Card>

          <Card title="Auf der Website" subtitle="Über die BlaulichtCMS Bridge (ab Version 0.10.0) – die Bilder liegen danach auf der Website selbst.">
            <div className="flex flex-col gap-2 text-sm">
              <p className="m-0">Shortcode in eine Seite oder einen Beitrag einfügen (oder den Block „BlaulichtCMS Social-Feed“):</p>
              <div className="flex gap-2 items-center flex-wrap">
                <code className="px-2 py-1 bg-raised rounded-chip">[blaulichtcms_social]</code>
                <CopyButton size="sm" value="[blaulichtcms_social]" label="Kopieren" />
              </div>
              <p className="m-0 text-fg-muted">
                Optionen: <code>anzahl="6"</code>, <code>darstellung="kacheln|liste"</code>, <code>netzwerk="facebook|instagram"</code>, <code>text="ja|nein"</code>. Alle Einzelheiten in WordPress unter Einstellungen → BlaulichtCMS Einsatzliste → Shortcodes.
              </p>
            </div>
          </Card>

          <Card
            title="RSS-Feed"
            subtitle="Geheime Adresse zum Abonnieren, z. B. für einen Feedreader oder ein Info-Display."
            action={
              <HelpTip title="RSS-Adresse" more="/hilfe/verbindungen#social-feed">
                <p className="m-0">Wer die Adresse kennt, sieht die freigegebenen Beiträge – mehr nicht. Bei Verdacht erneuern.</p>
              </HelpTip>
            }
          >
            <div className="flex flex-col gap-3">
              {rssUrl ? (
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">RSS-Adresse</span>
                  <OneTimeSecret value={rssUrl} label="RSS-Adresse" />
                </div>
              ) : d.rss.active ? (
                <Notice icon="Lock" title="RSS-Adresse aktiv">
                  Erstellt {fmtDateTime(d.rss.created_at)} · zuletzt abgerufen {d.rss.used_at ? fmtRelative(d.rss.used_at) : 'noch nie'}. Die Adresse wird aus Sicherheitsgründen nicht erneut angezeigt – bei Bedarf erneuern.
                </Notice>
              ) : null}
              <div className="flex gap-2 flex-wrap">
                <Button variant="primary" icon={d.rss.active ? 'RefreshCw' : 'Link2'} onClick={createRss}>
                  {d.rss.active ? 'Adresse erneuern' : 'RSS-Adresse erstellen'}
                </Button>
                {d.rss.active && (
                  <Button variant="danger" icon="Ban" onClick={revokeRss}>
                    Widerrufen
                  </Button>
                )}
              </div>
            </div>
          </Card>

          <Card title="Beiträge" subtitle="Die neuesten Beiträge der Quellen. Ausgeblendete erscheinen weder auf der Website noch im RSS-Feed.">
            {d.posts.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Noch keine Beiträge abgeglichen. Der Abgleich läuft stündlich; sofort über Reichweite → Seitenstatistik → „Jetzt abgleichen“.</p>
            ) : (
              <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
                {d.posts.map((p) => {
                  const inFeed = d.visible.includes(p.id);
                  return (
                    <li key={p.id} className={cx('flex gap-3 items-start py-3', p.hidden && 'opacity-60')}>
                      {p.image_file ? <img src={`/api/v1/social-images/${p.image_file}`} alt="" loading="lazy" className="w-16 h-16 object-cover rounded-node shrink-0 border border-line" /> : <div className="w-16 h-16 shrink-0 rounded-node border border-line bg-raised" aria-hidden="true" />}
                      <div className="flex flex-col gap-1 min-w-0 flex-1">
                        <span className="line-clamp-3 break-words text-sm">{p.message || <span className="text-fg-muted">(ohne Text)</span>}</span>
                        <span className="flex flex-wrap gap-x-3 items-center text-meta text-fg-muted">
                          <span>{NET[p.kind] ?? p.kind}</span>
                          <span>{fmtDateTime(p.posted_at)}</span>
                          {p.publication_id && <span>aus BlaulichtCMS</span>}
                          {p.permalink && (
                            <a href={safeHref(p.permalink)} target="_blank" rel="noopener noreferrer">
                              Original öffnen
                            </a>
                          )}
                          {p.hidden ? <Badge tone="neutral">ausgeblendet</Badge> : inFeed ? <Badge tone="success">im Feed</Badge> : null}
                        </span>
                      </div>
                      <Button size="sm" icon={p.hidden ? 'Eye' : 'EyeOff'} onClick={() => toggleHidden(p.id, !p.hidden)}>
                        {p.hidden ? 'Einblenden' : 'Ausblenden'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
