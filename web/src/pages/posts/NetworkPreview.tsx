import { useState, type ReactNode } from 'react';
import type { MediaItem } from '../../api/types';
import { Button, Card, Chip, cx, Tabs } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { channelLength, channelMax, contentWarning, limitsFor, SOCIAL_KINDS, SOCIAL_LABEL, socialText, socialTextTooLong, STORY_KINDS, type RevText, type SocialKind } from '../../lib/social';
import type { SocialTarget } from './SocialPanel';

/**
 * Vorschau je Veröffentlichungsziel (#262): Website und jedes gewählte soziale Netzwerk mit dem Text, der tatsächlich
 * gesendet wird – eigener Text oder Titel und Kurzfassung bzw. Text, gekürzt nach denselben Regeln wie beim Senden
 * (server/src/lib/social-text.ts, gemeinsam mit dem Server). Storys zeigen die erste Datei im Hochformat.
 */

/** Feld „Eigener Text …“ je Netzwerk (SocialTargetsCard) */
const OWN_FIELD: Record<SocialKind, string> = { facebook: 's-fb', instagram: 's-ig', threads: 's-th', x: 's-x', whatsapp: 's-wa', mastodon: 's-md', bluesky: 's-bs' };
/** Netzwerke, die den Link zur Website anhängen, sobald der Beitrag dort veröffentlicht ist */
const LINKED: SocialKind[] = ['threads', 'x', 'whatsapp', 'mastodon', 'bluesky'];

export interface PreviewInput {
  title: string;
  body: string;
  excerpt: string;
  /** Website gewählt? Mit eigenem Titel/Text/Kurzfassung für die Website */
  site: { name: string; title: string; body: string; excerpt: string } | null;
  coverId: string | null;
  media: MediaItem[];
  variants: RevText['variants'];
  targets: { target: SocialTarget; format: string }[];
  /** Adresse auf der Website, falls schon veröffentlicht (wie beim Senden) */
  link: string | null;
}

function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <p className="m-0 text-fg-muted">Noch kein Text.</p>;
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className="m-0 whitespace-pre-line break-words">
          {p}
        </p>
      ))}
    </>
  );
}

/** WhatsApp-Formatierung *fett* in der Vorschau */
function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*)/g);
  return <>{parts.map((p, i) => (/^\*[^*\n]+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong> : <span key={i}>{p}</span>))}</>;
}

function Thumbs({ media, max, square }: { media: MediaItem[]; max: number; square?: boolean }) {
  const shown = media.slice(0, max);
  if (!shown.length) return null;
  return (
    <div className={cx('grid gap-1 rounded-control overflow-hidden', shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {shown.map((m) =>
        m.has_preview ? (
          <img key={m.id} decoding="async" src={`/api/v1/media/${m.id}/preview`} alt={m.alt_text || ''} className={cx('w-full object-cover', square ? 'aspect-square' : shown.length === 1 ? 'max-h-[320px]' : 'aspect-[4/3]')} />
        ) : (
          <div key={m.id} className="aspect-[4/3] bg-raised flex items-center justify-center">
            <Icon name="Film" />
          </div>
        ),
      )}
    </div>
  );
}

function Frame({ name, kind, children, foot }: { name: string; kind: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="max-w-[520px] border border-line rounded-card bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="w-7 h-7 rounded-full bg-raised border border-line inline-flex items-center justify-center text-fg-muted" aria-hidden="true">
          <Icon name="User" size={14} />
        </span>
        <span className="text-sm font-medium truncate">{name}</span>
        <Chip className="ml-auto">{kind}</Chip>
      </div>
      <div className="px-3 py-3 flex flex-col gap-3">{children}</div>
      {foot && <div className="px-3 py-2 border-t border-line text-meta text-fg-muted flex flex-wrap gap-x-3 gap-y-1">{foot}</div>}
    </div>
  );
}

export function NetworkPreview({ input, onEditOwn }: { input: PreviewInput; onEditOwn: (fieldId: string) => void }) {
  const rev: RevText = { title: input.title, body: input.body, excerpt: input.excerpt, variants: input.variants };
  // Reiter in fester Reihenfolge der Netzwerke (unabhängig von der Reihenfolge der Auswahl)
  const feeds = input.targets.filter((t) => t.format !== 'story').sort((a, b) => SOCIAL_KINDS.indexOf(a.target.kind) - SOCIAL_KINDS.indexOf(b.target.kind) || a.target.name.localeCompare(b.target.name, 'de'));
  const stories = input.targets.filter((t) => STORY_KINDS.includes(t.target.kind) && (t.format === 'story' || t.format === 'both'));
  const kindCount = (k: string) => feeds.filter((t) => t.target.kind === k).length;
  const tabs: { value: string; label: string }[] = [{ value: 'site', label: input.site ? 'Website' : 'Interne Ansicht' }];
  for (const t of feeds) tabs.push({ value: t.target.id, label: kindCount(t.target.kind) > 1 ? `${SOCIAL_LABEL[t.target.kind]} (${t.target.name})` : SOCIAL_LABEL[t.target.kind] });
  if (stories.length) tabs.push({ value: 'story', label: 'Story' });
  const [tab, setTab] = useState('site');
  const active = tabs.some((t) => t.value === tab) ? tab : 'site';
  const images = input.media.filter((m) => m.kind === 'image' || m.kind === 'video');
  const cover = input.media.find((m) => m.id === input.coverId);

  let content: ReactNode;
  if (active === 'site') {
    const s = input.site;
    content = (
      <article className="flex flex-col gap-3 max-w-[680px]">
        <h3 className="m-0 text-title font-semibold break-words">{(s && s.title) || input.title}</h3>
        {cover?.has_preview && <img src={`/api/v1/media/${cover.id}/preview`} alt={cover.alt_text || ''} className="w-full rounded-control" />}
        <div className="flex flex-col gap-3 text-base leading-relaxed">
          <Paragraphs text={(s && s.body) || input.body} />
        </div>
        {s && (s.excerpt || input.excerpt) && <p className="m-0 text-sm text-fg-muted">Kurzfassung: {s.excerpt || input.excerpt}</p>}
      </article>
    );
  } else if (active === 'story') {
    const first = images[0];
    content = (
      <div className="flex flex-col gap-2">
        <div className="w-[180px] aspect-[9/16] rounded-card border border-line bg-raised overflow-hidden flex items-center justify-center">
          {first?.has_preview ? <img src={`/api/v1/media/${first.id}/preview`} alt={first.alt_text || ''} className="w-full h-full object-contain" /> : <span className="text-meta text-fg-muted px-3 text-center">Kein Bild oder Video</span>}
        </div>
        <p className="m-0 text-meta text-fg-muted">
          {stories.map((t) => `${SOCIAL_LABEL[t.target.kind]}-Story (${t.target.name})`).join(', ')}: die erste Datei des Beitrags im Hochformat 9:16, ohne Text, 24 Stunden sichtbar.
        </p>
      </div>
    );
  } else {
    const t = feeds.find((x) => x.target.id === active)!;
    const kind = t.target.kind;
    const limits = limitsFor(t.target);
    const text = socialText(rev, kind, input.link, limits);
    const cut = socialTextTooLong(rev, kind, input.link, limits);
    const max = channelMax(kind, limits);
    const own = !!(input.variants?.[kind]?.body ?? '').trim();
    const cw = kind === 'mastodon' ? contentWarning(rev) : '';
    const media = kind === 'whatsapp' || (kind === 'x' && t.target.manual) ? [] : images;
    content = (
      <div className="flex flex-col gap-3">
        <Frame
          name={t.target.name}
          kind={SOCIAL_LABEL[kind]}
          foot={
            <>
              <span className={cx('font-mono', cut && 'text-warn')}>
                {channelLength(kind, text)} / {max.toLocaleString('de-DE')} Zeichen
              </span>
              <span>{own ? 'eigener Text' : kind === 'whatsapp' ? 'Titel fett, darunter Kurzfassung bzw. Text' : 'Titel und Kurzfassung bzw. Text'}</span>
              {t.target.manual && <span>Teilen von Hand</span>}
              {t.format === 'both' && <span>auch als Story</span>}
            </>
          }
        >
          {cw && (
            <div className="text-sm border border-line rounded-control px-2 py-1.5 bg-raised">
              <span className="font-medium">Inhaltswarnung:</span> {cw}
            </div>
          )}
          {kind === 'instagram' && <Thumbs media={media} max={1} square />}
          <p className="m-0 text-sm whitespace-pre-wrap break-words leading-relaxed">{kind === 'whatsapp' ? <WhatsAppText text={text} /> : text}</p>
          {kind !== 'instagram' && <Thumbs media={media} max={kind === 'facebook' ? 4 : 4} />}
          {kind === 'instagram' && !media.length && <div className="aspect-square max-w-[240px] rounded-control border border-dashed border-line flex items-center justify-center text-meta text-fg-muted">Kein Bild oder Video</div>}
        </Frame>
        {cut && (
          <p className="m-0 text-meta text-warn flex items-start gap-1.5">
            <Icon name="AlertTriangle" size={14} className="mt-0.5 shrink-0" />
            Beim Senden auf {max.toLocaleString('de-DE')} Zeichen gekürzt (Ende „…“). Ein eigener, kürzerer Text ist besser.
          </p>
        )}
        {LINKED.includes(kind) && !input.link && input.site && <p className="m-0 text-meta text-fg-muted">Ist der Beitrag beim Senden schon auf der Website veröffentlicht, wird der Link dorthin angehängt (zählt mit).</p>}
        <div>
          <Button size="sm" variant="ghost" icon="Pencil" onClick={() => onEditOwn(OWN_FIELD[kind])}>
            {own ? `Eigenen Text für ${SOCIAL_LABEL[kind]} bearbeiten` : `Eigenen Text für ${SOCIAL_LABEL[kind]} schreiben`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card id="vorschau" title="Vorschau" subtitle={active === 'site' ? (input.site ? `So erscheint der Beitrag auf „${input.site.name}“ (Darstellung abhängig vom Theme).` : 'Ohne Website bleibt der Beitrag intern.') : 'Text und Bilder, wie sie gesendet werden – gekürzt nach den Regeln des Netzwerks.'}>
      <div className="flex flex-col gap-4">
        {tabs.length > 1 && <Tabs label="Vorschau für" value={active} onChange={setTab} tabs={tabs} />}
        <div role={tabs.length > 1 ? 'tabpanel' : undefined} aria-label={tabs.find((t) => t.value === active)?.label}>
          {content}
        </div>
      </div>
    </Card>
  );
}
