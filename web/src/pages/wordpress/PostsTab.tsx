import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { del, patch, post } from '../../api/client';
import { Badge, Button, Chip, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, Skeleton, Textarea } from '../../components/ui/core';
import { DeleteDialog, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative, fromLocalInput, toLocalInput } from '../../lib/format';
import type { Post } from './shared';

type WpStatus = Post['wp_status'];
const WP_STATUSES: WpStatus[] = ['draft', 'pending', 'future'];

interface Form {
  title: string;
  content: string;
  excerpt: string;
  category: string;
  tags: string;
  wpStatus: WpStatus;
  publishAt: string;
}

const EMPTY: Form = { title: '', content: '', excerpt: '', category: '', tags: '', wpStatus: 'draft', publishAt: '' };

function toForm(p: Post): Form {
  return { title: p.title, content: p.content, excerpt: p.excerpt, category: p.category, tags: (p.tags ?? []).join(', '), wpStatus: p.wp_status, publishAt: toLocalInput(p.publish_at) };
}

function payload(f: Form) {
  return {
    title: f.title.trim(),
    content: f.content,
    excerpt: f.excerpt,
    category: f.category.trim(),
    tags: [...new Set(f.tags.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 20),
    wpStatus: f.wpStatus,
    publishAt: f.wpStatus === 'future' ? fromLocalInput(f.publishAt) : null,
  };
}

function PostStatus({ p }: { p: Post }) {
  if (p.sync_status === 'error') return <Badge tone="error">{t('wordpress.posts.stError')}</Badge>;
  if (p.state === 'sent') return <Badge tone="success">{t('wordpress.posts.stSent')}</Badge>;
  return <Badge tone="neutral">{t('wordpress.posts.stLocal')}</Badge>;
}

export function PostsTab({ siteId, posts, loading, error, selected, onSelect }: { siteId: string; posts: Post[]; loading: boolean; error: unknown; selected: string | null; onSelect: (id: string | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('wordpress.edit');
  const canPublish = can('wordpress.publish');
  const current = selected && selected !== 'new' ? (posts.find((p) => p.id === selected) ?? null) : null;
  const isNew = selected === 'new';
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status?: string; edit_url?: string } | null>(null);
  const [deleting, setDeleting] = useState<Post | null>(null);

  useEffect(() => {
    setForm(current ? toForm(current) : EMPTY);
    setErrors({});
    setFormError(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, isNew]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['posts'] });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(toForm(current)) : isNew;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.title.trim()) e.title = t('wordpress.posts.errTitle');
    if (form.wpStatus === 'future') {
      const iso = fromLocalInput(form.publishAt);
      if (!iso || new Date(iso).getTime() <= Date.now()) e.publishAt = t('wordpress.posts.errFuture');
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const persist = async (): Promise<Post> => {
    if (isNew) return post<Post>('/posts', { connectionId: siteId, ...payload(form) });
    if (dirty) return patch<Post>(`/posts/${current!.id}`, payload(form));
    return current!;
  };

  const save = async () => {
    if (!validate()) return;
    setBusy('save');
    setFormError(null);
    try {
      const p = await persist();
      await refresh();
      onSelect(p.id);
      toast({ tone: 'success', title: t('wordpress.posts.saved'), text: t('wordpress.posts.savedText') });
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!validate()) return;
    setBusy('send');
    setFormError(null);
    setResult(null);
    let id: string | null = current?.id ?? null;
    try {
      const p = await persist();
      id = p.id;
      const res = await post<{ ok: boolean; result: { status?: string; edit_url?: string } }>(`/posts/${p.id}/send`);
      setResult(res.result ?? {});
      await refresh();
      onSelect(p.id);
      toast({ tone: 'success', title: t('wordpress.posts.sent'), text: t('wordpress.posts.sentText') });
    } catch (e) {
      await refresh();
      if (id) onSelect(id);
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorBox title={t('wordpress.posts.loadError')}>{(error as Error).message}</ErrorBox>;
  const editUrl = result?.edit_url ?? current?.wp_edit_url ?? null;

  return (
    <div className="flex gap-5 flex-wrap items-start">
      <section aria-label={t('wordpress.posts.listLabel')} className="flex-[1_1_300px] xl:max-w-[380px] min-w-0 flex flex-col gap-2.5">
        {loading ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[84px] rounded-card" />)
        ) : posts.length === 0 && !isNew ? (
          <div className="bg-card border border-line rounded-card">
            <EmptyState
              icon="Newspaper"
              title={t('wordpress.posts.emptyTitle')}
              text={t('wordpress.posts.emptyText')}
              action={
                canEdit && (
                  <Button variant="primary" icon="Plus" onClick={() => onSelect('new')}>
                    {t('wordpress.posts.new')}
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-2.5">
            {isNew && (
              <li className="flex flex-col gap-1.5 p-3.5 rounded-card bg-card border-[1.5px] border-primary text-sm">
                <span className="font-semibold truncate">{form.title || t('wordpress.posts.newTitle')}</span>
                <span className="text-meta text-fg-muted">{t('wordpress.banner.unsavedNew')}</span>
              </li>
            )}
            {posts.map((p) => {
              const on = selected === p.id;
              return (
                <li key={p.id}>
                  <button type="button" aria-pressed={on} onClick={() => onSelect(p.id)} className={cx('w-full flex flex-col gap-2 p-3.5 rounded-card bg-card text-left text-sm transition-colors duration-fast', on ? 'border-[1.5px] border-primary' : 'border border-line hover:bg-raised')}>
                    <span className="flex items-start gap-2 w-full">
                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="font-semibold truncate">{p.title}</span>
                        <span className="text-meta text-fg-muted truncate">{t('wordpress.posts.updated', { d: fmtRelative(p.updated_at) })}</span>
                      </span>
                      <PostStatus p={p} />
                    </span>
                    <span className="flex gap-1.5 flex-wrap">
                      <Chip>{t(`wordpress.wpStatus.${p.wp_status}`)}</Chip>
                      {p.category && <Chip>{p.category}</Chip>}
                      <Chip>{p.source === 'workflow' ? t('wordpress.common.fromWorkflow') : t('wordpress.common.manual')}</Chip>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="m-0 mt-1 mx-0.5 text-meta text-fg-muted leading-normal">{t('wordpress.posts.listHint')}</p>
      </section>

      <section aria-label={t('wordpress.posts.editorLabel')} className="flex-[3_1_520px] min-w-0 flex flex-col gap-4">
        {!current && !isNew ? (
          <div className="bg-card border border-line rounded-card">
            <EmptyState icon="MousePointerClick" title={t('wordpress.posts.pickTitle')} text={t('wordpress.posts.pickText')} />
          </div>
        ) : (
          <form
            noValidate
            aria-label={t('wordpress.posts.formLabel')}
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="bg-card border border-line rounded-card p-5 flex flex-col gap-4"
          >
            {current && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-2 flex-wrap text-meta text-fg-muted">
                  <PostStatus p={current} />
                  {current.last_synced_at && <span>{t('wordpress.posts.lastSent', { d: fmtDateTime(current.last_synced_at) })}</span>}
                </span>
                {canEdit && (
                  <Button size="sm" variant="ghost" icon="Trash2" onClick={() => setDeleting(current)}>
                    {t('wordpress.posts.delete')}
                  </Button>
                )}
              </div>
            )}
            {current?.sync_status === 'error' && current.sync_error && !formError && (
              <ErrorBox title={t('wordpress.posts.sendErrorTitle')}>
                <p className="m-0">{current.sync_error}</p>
                <p className="m-0 mt-1">{t('wordpress.posts.sendErrorHint')}</p>
              </ErrorBox>
            )}
            {editUrl && (
              <Notice tone="success" title={result?.status ? t('wordpress.posts.resultTitleStatus', { s: result.status }) : t('wordpress.posts.resultTitle')}>
                <a href={editUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5">
                  {t('wordpress.posts.openInWp')} <Icon name="ExternalLink" size={13} />
                </a>
              </Notice>
            )}
            <fieldset disabled={!canEdit} className="m-0 p-0 border-0 flex flex-col gap-4 min-w-0">
              <FieldWrap label={t('wordpress.posts.title')} required htmlFor="ps-title" error={errors.title}>
                <Input id="ps-title" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} invalid={!!errors.title} />
              </FieldWrap>
              <FieldWrap label={t('wordpress.posts.content')} htmlFor="ps-content" help={t('wordpress.posts.contentHelp')}>
                <Textarea id="ps-content" rows={10} value={form.content} onChange={(e) => set('content', e.target.value)} />
              </FieldWrap>
              <FieldWrap label={t('wordpress.posts.excerpt')} htmlFor="ps-excerpt" help={t('wordpress.posts.excerptHelp')}>
                <Textarea id="ps-excerpt" rows={2} value={form.excerpt} onChange={(e) => set('excerpt', e.target.value)} maxLength={1000} />
              </FieldWrap>
              <div className="flex gap-3 flex-wrap">
                <FieldWrap className="flex-[1_1_200px]" label={t('wordpress.posts.category')} htmlFor="ps-cat" help={t('wordpress.posts.categoryHelp')}>
                  <Input id="ps-cat" value={form.category} onChange={(e) => set('category', e.target.value)} maxLength={100} />
                </FieldWrap>
                <FieldWrap className="flex-[2_1_260px]" label={t('wordpress.posts.tags')} htmlFor="ps-tags" help={t('wordpress.posts.tagsHelp')}>
                  <Input id="ps-tags" value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder={t('wordpress.posts.tagsPlaceholder')} />
                </FieldWrap>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium" id="ps-status-l">
                  {t('wordpress.posts.wpStatus')}
                </span>
                <div role="radiogroup" aria-labelledby="ps-status-l" className="inline-flex self-start p-[3px] border border-line rounded-control bg-bg flex-wrap">
                  {WP_STATUSES.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={form.wpStatus === s} onClick={() => set('wpStatus', s)} className={cx('h-[28px] px-3 rounded-chip text-sm transition-colors duration-fast', form.wpStatus === s ? 'bg-raised text-fg font-medium' : 'text-fg-muted hover:text-fg')}>
                      {t(`wordpress.wpStatus.${s}`)}
                    </button>
                  ))}
                </div>
                <span className="text-meta text-fg-muted">{t(`wordpress.wpStatusHelp.${form.wpStatus}`)}</span>
              </div>
              {form.wpStatus === 'future' && (
                <FieldWrap label={t('wordpress.posts.publishAt')} required htmlFor="ps-at" error={errors.publishAt} className="max-w-[300px]">
                  <Input id="ps-at" type="datetime-local" mono value={form.publishAt} onChange={(e) => set('publishAt', e.target.value)} invalid={!!errors.publishAt} />
                </FieldWrap>
              )}
            </fieldset>

            {formError && <ErrorBox title={t('wordpress.posts.actionFailed')}>{formError}</ErrorBox>}

            <div className="flex items-center gap-2 flex-wrap pt-4 border-t border-line">
              <span className="mr-auto text-meta text-fg-muted flex items-center gap-1.5 min-w-0">
                <Icon name={current?.source === 'workflow' ? 'Workflow' : 'User'} size={13} className="shrink-0" />
                <span className="truncate">{current ? current.source_label || t('wordpress.common.manual') : t('wordpress.banner.sourceNew')}</span>
              </span>
              {isNew && (
                <Button variant="ghost" onClick={() => onSelect(null)}>
                  {t('wordpress.common.cancel')}
                </Button>
              )}
              {current && dirty && (
                <Button variant="ghost" onClick={() => setForm(toForm(current))}>
                  {t('wordpress.common.discard')}
                </Button>
              )}
              {canEdit && (
                <Button type="submit" loading={busy === 'save'} disabled={!!busy || (!isNew && !dirty)}>
                  {t('wordpress.posts.save')}
                </Button>
              )}
              {canPublish && canEdit && (
                <Button variant="primary" icon="Send" loading={busy === 'send'} disabled={!!busy} onClick={send}>
                  {current?.wp_post_id ? t('wordpress.posts.update') : t('wordpress.posts.send')}
                </Button>
              )}
            </div>
            <p className="m-0 text-meta text-fg-muted">{canPublish ? t('wordpress.posts.sendNote') : t('wordpress.posts.noPublishPerm')}</p>
          </form>
        )}
      </section>

      <DeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        objectType={t('wordpress.posts.objectType')}
        name={deleting?.title ?? ''}
        extra={<p className="m-0 text-fg-muted">{t('wordpress.posts.deleteNote')}</p>}
        onConfirm={async () => {
          await del(`/posts/${deleting!.id}`);
          onSelect(null);
          await refresh();
          toast({ tone: 'success', title: t('wordpress.posts.deleted') });
        }}
      />
    </div>
  );
}
