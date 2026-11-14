import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { del, patch, post } from '../../api/client';
import { Button, Chip, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, SegmentedControl, Skeleton, Textarea } from '../../components/ui/core';
import { DeleteDialog, Menu, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { WpPagesField } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative, fromLocalInput, toLocalInput } from '../../lib/format';
import { BANNER_PALETTE, COLORS, PRIORITIES, SitePreview, sortStack, ViewBadge, type Banner, type BannerColor, type PreviewBanner, type Priority } from './shared';

interface Form {
  title: string;
  text: string;
  label: string;
  color: BannerColor;
  priority: Priority;
  startsAt: string; // datetime-local, leer = sofort
  endsAt: string; // leer = ohne Ende
  pages: string[];
  linkUrl: string;
  linkText: string;
}

const EMPTY: Form = { title: '', text: '', label: '', color: 'rot', priority: 'normal', startsAt: '', endsAt: '', pages: ['front'], linkUrl: '', linkText: '' };

function toForm(b: Banner): Form {
  return {
    title: b.title,
    text: b.text,
    label: b.label,
    color: b.color,
    priority: b.priority,
    startsAt: toLocalInput(b.starts_at),
    endsAt: toLocalInput(b.ends_at),
    pages: b.pages?.length ? b.pages : ['front'],
    linkUrl: b.link_url ?? '',
    linkText: b.link_text ?? '',
  };
}

function payload(f: Form) {
  return {
    title: f.title.trim(),
    text: f.text,
    label: f.label.trim(),
    color: f.color,
    priority: f.priority,
    startsAt: fromLocalInput(f.startsAt),
    endsAt: fromLocalInput(f.endsAt),
    pages: f.pages,
    linkUrl: f.linkUrl.trim() || null,
    linkText: f.linkText.trim() || null,
  };
}

function whenText(b: Banner) {
  switch (b.view) {
    case 'aktiv':
      return b.ends_at ? t('wordpress.banner.whenActiveUntil', { d: fmtDateTime(b.ends_at) }) : t('wordpress.banner.whenActiveOpen');
    case 'geplant':
      return t('wordpress.banner.whenFrom', { d: fmtDateTime(b.starts_at) });
    case 'abgelaufen':
      return t('wordpress.banner.whenUntil', { d: fmtDateTime(b.ends_at) });
    case 'deaktiviert':
      return t('wordpress.banner.whenDeactivated', { d: fmtRelative(b.updated_at) });
    default:
      return b.starts_at ? t('wordpress.banner.whenDraftFrom', { d: fmtDateTime(b.starts_at) }) : t('wordpress.banner.whenDraft');
  }
}

export function BannerTab({ siteId, banners, loading, error, selected, onSelect }: { siteId: string; banners: Banner[]; loading: boolean; error: unknown; selected: string | null; onSelect: (id: string | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const { can } = useAuth();
  const canEdit = can('wordpress.edit');
  const canPublish = can('wordpress.publish');

  const current = selected && selected !== 'new' ? (banners.find((b) => b.id === selected) ?? null) : null;
  const isNew = selected === 'new';
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [deleting, setDeleting] = useState<Banner | null>(null);

  useEffect(() => {
    setForm(current ? toForm(current) : EMPTY);
    setErrors({});
    setFormError(null);
    // Nur beim Wechsel der Auswahl bzw. neuer Revision neu laden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.revision, current?.state, isNew]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['banners'] });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(toForm(current)) : isNew;

  const activeCount = banners.filter((b) => b.view === 'aktiv').length;

  const validate = (forPublish: boolean) => {
    const e: Record<string, string> = {};
    if (!form.title.trim()) e.title = t('wordpress.banner.errTitle');
    if (form.text.length > 600) e.text = t('wordpress.banner.errText');
    if (form.label.length > 30) e.label = t('wordpress.banner.errLabel');
    if (!form.pages.length) e.pages = t('wordpress.banner.errPages');
    if (form.linkUrl.trim() && !/^https?:\/\/\S+$/i.test(form.linkUrl.trim())) e.linkUrl = t('wordpress.banner.errLink');
    const s = fromLocalInput(form.startsAt);
    const en = fromLocalInput(form.endsAt);
    if (s && en && new Date(en) <= new Date(s)) e.endsAt = t('wordpress.banner.errEndBeforeStart');
    else if (forPublish && en && new Date(en).getTime() <= Date.now()) e.endsAt = t('wordpress.banner.errEndPast');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  /** Speichert (anlegen oder ändern) und gibt das Banner zurück. */
  const persist = async (): Promise<Banner> => {
    if (isNew) return post<Banner>('/banners', { connectionId: siteId, ...payload(form) });
    if (dirty) return patch<Banner>(`/banners/${current!.id}`, payload(form));
    return current!;
  };

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setFormError(null);
    try {
      await fn();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = () =>
    validate(false) &&
    run('draft', async () => {
      const b = await persist();
      await refresh();
      onSelect(b.id);
      toast({ tone: 'success', title: t('wordpress.banner.savedDraft') });
    });

  const publish = () =>
    validate(true) &&
    run('publish', async () => {
      let b = await persist();
      if (b.state !== 'published' || b.view === 'abgelaufen') b = await post<Banner>(`/banners/${b.id}/publish`);
      await refresh();
      onSelect(b.id);
      const ok = b.sync_status !== 'error';
      toast(
        ok
          ? { tone: 'success', title: b.view === 'geplant' ? t('wordpress.banner.scheduled') : t('wordpress.banner.published'), text: t('wordpress.banner.publishedText') }
          : { tone: 'warning', title: t('wordpress.banner.publishedSyncFail'), text: b.sync_error ?? t('wordpress.banner.syncRetry') },
      );
    });

  const deactivate = async (b: Banner) => {
    try {
      await post(`/banners/${b.id}/deactivate`);
      await refresh();
      toast({
        tone: 'info',
        title: t('wordpress.banner.deactivated', { title: b.title }),
        text: t('wordpress.banner.deactivatedText'),
        action: canPublish
          ? {
              label: t('wordpress.common.undo'),
              onClick: async () => {
                try {
                  await post(`/banners/${b.id}/publish`);
                  await refresh();
                } catch (e) {
                  errorToast(e);
                }
              },
            }
          : undefined,
      });
    } catch (e) {
      errorToast(e);
    }
  };

  const duplicate = async (b: Banner) => {
    try {
      const n = await post<Banner>(`/banners/${b.id}/duplicate`);
      await refresh();
      onSelect(n.id);
      toast({ tone: 'success', title: t('wordpress.banner.duplicated'), text: t('wordpress.banner.duplicatedText') });
    } catch (e) {
      errorToast(e);
    }
  };

  const resync = async (b: Banner) => {
    try {
      const res = await post<{ ok: boolean; banner: Banner }>(`/banners/${b.id}/sync`);
      await refresh();
      toast(res.ok ? { tone: 'success', title: t('wordpress.banner.synced') } : { tone: 'error', title: t('wordpress.banner.syncFailed'), text: res.banner.sync_error ?? undefined });
    } catch (e) {
      errorToast(e);
    }
  };

  const stack: PreviewBanner[] = useMemo(() => {
    const others = banners
      .filter((b) => b.view === 'aktiv' && b.id !== current?.id)
      .map((b) => ({ key: b.id, title: b.title, text: b.text, label: b.label, color: b.color, priority: b.priority, linkUrl: b.link_url, linkText: b.link_text, startsAt: b.starts_at }));
    const mine: PreviewBanner | null = current || isNew ? { key: 'current', current: true, title: form.title, text: form.text, label: form.label, color: form.color, priority: form.priority, linkUrl: form.linkUrl, linkText: form.linkText, startsAt: fromLocalInput(form.startsAt) ?? new Date().toISOString() } : null;
    return sortStack(mine ? [...others, mine] : others);
  }, [banners, current, isNew, form]);

  const view = current?.view;
  const editable = canEdit && (!current || current.state !== 'published' || canPublish);
  const primaryLabel = !current ? t('wordpress.banner.publish') : view === 'aktiv' || view === 'geplant' ? t('wordpress.banner.publishChanges') : view === 'abgelaufen' ? t('wordpress.banner.reschedule') : t('wordpress.banner.publish');
  const canDelete = current && (view === 'entwurf' || view === 'abgelaufen' || view === 'deaktiviert');

  if (error) return <ErrorBox title={t('wordpress.banner.loadError')}>{(error as Error).message}</ErrorBox>;

  return (
    <div className="flex gap-5 flex-wrap items-start">
      <section aria-label={t('wordpress.banner.listLabel')} className="flex-[1_1_300px] xl:max-w-[380px] min-w-0 flex flex-col gap-2.5">
        {activeCount > 1 && (
          <Notice tone="primary" icon="Megaphone">
            {t('wordpress.banner.multiActive', { n: activeCount })}
          </Notice>
        )}
        {loading ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[92px] rounded-card" />)
        ) : banners.length === 0 && !isNew ? (
          <div className="bg-card border border-line rounded-card">
            <EmptyState
              icon="Megaphone"
              title={t('wordpress.banner.emptyTitle')}
              text={t('wordpress.banner.emptyText')}
              action={
                canEdit && (
                  <Button variant="primary" icon="Plus" onClick={() => onSelect('new')}>
                    {t('wordpress.banner.new')}
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-2.5">
            {isNew && (
              <li>
                <div className="w-full flex flex-col gap-2 p-3.5 rounded-card bg-card border-[1.5px] border-primary text-sm">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="w-2.5 h-7 rounded-[3px] shrink-0" style={{ background: BANNER_PALETTE[form.color].bg }} />
                    <span className="flex-1 min-w-0 font-semibold truncate">{form.title || t('wordpress.banner.newTitle')}</span>
                    <ViewBadge view="entwurf" />
                  </span>
                  <span className="text-meta text-fg-muted">{t('wordpress.banner.unsavedNew')}</span>
                </div>
              </li>
            )}
            {banners.map((b) => {
              const on = selected === b.id;
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onSelect(b.id)}
                    className={cx('w-full flex flex-col gap-2.5 p-3.5 rounded-card bg-card text-left text-sm transition-colors duration-fast', on ? 'border-[1.5px] border-primary' : 'border border-line hover:bg-raised', (b.view === 'abgelaufen' || b.view === 'deaktiviert') && !on && 'opacity-80')}
                  >
                    <span className="flex items-center gap-2.5 w-full">
                      <span aria-hidden="true" className="w-2.5 h-7 rounded-[3px] shrink-0" style={{ background: BANNER_PALETTE[b.color].bg, boxShadow: b.color === 'neutral' ? 'inset 0 0 0 1px var(--ll-border)' : undefined }} />
                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="font-semibold truncate">{b.title}</span>
                        <span className="text-meta text-fg-muted truncate">{whenText(b)}</span>
                      </span>
                      <ViewBadge view={b.view} />
                    </span>
                    <span className="flex gap-1.5 flex-wrap">
                      <Chip>{t('wordpress.banner.prioChip', { p: t(`wordpress.priority.${b.priority}`) })}</Chip>
                      <Chip>{b.pages.length === 1 ? t('wordpress.banner.pagesOne') : t('wordpress.banner.pagesN', { n: b.pages.length })}</Chip>
                      <Chip>{b.source === 'workflow' ? t('wordpress.common.fromWorkflow') : t('wordpress.common.manual')}</Chip>
                    </span>
                    {b.state !== 'draft' && b.sync_status === 'error' && (
                      <span className="text-meta text-err flex items-start gap-1.5">
                        <Icon name="XCircle" size={13} className="mt-px shrink-0" />
                        <span className="line-clamp-2">{t('wordpress.banner.syncErrorShort', { msg: b.sync_error ?? '' })}</span>
                      </span>
                    )}
                    {b.state !== 'draft' && b.sync_status === 'pending' && (
                      <span className="text-meta text-warn flex items-center gap-1.5">
                        <Icon name="Hourglass" size={13} />
                        {t('wordpress.banner.syncPending')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="m-0 mt-1 mx-0.5 text-meta text-fg-muted leading-normal">{t('wordpress.banner.listHint')}</p>
      </section>

      <section aria-label={t('wordpress.banner.editorLabel')} className="flex-[3_1_520px] min-w-0 flex flex-col gap-4">
        {!current && !isNew ? (
          <div className="bg-card border border-line rounded-card">
            <EmptyState icon="MousePointerClick" title={t('wordpress.banner.pickTitle')} text={t('wordpress.banner.pickText')} />
          </div>
        ) : (
          <>
            <div className="bg-card border border-line rounded-card overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-line">
                <span className="text-meta font-semibold">{t('wordpress.preview.title')}</span>
                <SegmentedControl<'d' | 'm'>
                  size="sm"
                  label={t('wordpress.preview.device')}
                  value={mobile ? 'm' : 'd'}
                  onChange={(v) => setMobile(v === 'm')}
                  options={[
                    { value: 'd', label: t('wordpress.preview.desktop') },
                    { value: 'm', label: t('wordpress.preview.mobile') },
                  ]}
                />
              </div>
              <div className="p-[18px] bg-raised">
                <SitePreview banners={stack} mobile={mobile} />
                <p className="m-0 mt-2.5 text-meta text-fg-muted">
                  {t('wordpress.preview.themeNote')}
                  {stack.length > 1 && ` ${t('wordpress.preview.stackNote', { n: stack.length })}`}
                </p>
              </div>
            </div>

            {current && current.state !== 'draft' && current.sync_status === 'error' && (
              <ErrorBox
                title={t('wordpress.banner.syncErrorTitle')}
                actions={
                  canPublish && (
                    <Button size="sm" icon="RefreshCw" onClick={() => resync(current)}>
                      {t('wordpress.banner.resync')}
                    </Button>
                  )
                }
              >
                <p className="m-0">{current.sync_error}</p>
                <p className="m-0 mt-1">{t('wordpress.banner.syncErrorHint')}</p>
              </ErrorBox>
            )}

            <form
              aria-label={t('wordpress.banner.formLabel')}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (canPublish) publish();
                else saveDraft();
              }}
              className="bg-card border border-line rounded-card p-5 flex flex-col gap-4"
            >
              {current && (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="flex items-center gap-2 flex-wrap text-meta text-fg-muted">
                    <ViewBadge view={current.view} />
                    {current.last_synced_at && <span>{t('wordpress.banner.lastSync', { d: fmtRelative(current.last_synced_at) })}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {(view === 'aktiv' || view === 'geplant') && canPublish && (
                      <Button size="sm" icon="MegaphoneOff" onClick={() => deactivate(current)}>
                        {t('wordpress.banner.deactivate')}
                      </Button>
                    )}
                    <Menu
                      size="sm"
                      items={[
                        canEdit && { label: t('wordpress.banner.duplicate'), icon: 'Copy', onClick: () => duplicate(current) },
                        canPublish && current.state !== 'draft' && { label: t('wordpress.banner.resync'), icon: 'RefreshCw', onClick: () => resync(current) },
                        canEdit && { label: t('wordpress.banner.delete'), icon: 'Trash2', danger: true, disabled: !canDelete, hint: canDelete ? undefined : t('wordpress.banner.deleteHint'), onClick: () => setDeleting(current) },
                      ]}
                    />
                  </span>
                </div>
              )}
              {!editable && <Notice tone="warning">{t('wordpress.banner.noPerm')}</Notice>}
              <fieldset disabled={!editable} className="m-0 p-0 border-0 flex flex-col gap-4 min-w-0">
                <FieldWrap label={t('wordpress.banner.title')} required htmlFor="bn-title" error={errors.title}>
                  <Input id="bn-title" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={120} invalid={!!errors.title} />
                </FieldWrap>
                <FieldWrap label={t('wordpress.banner.text')} htmlFor="bn-text" error={errors.text} help={t('wordpress.banner.textHelp', { n: form.text.length })}>
                  <Textarea id="bn-text" rows={3} value={form.text} onChange={(e) => set('text', e.target.value)} maxLength={600} invalid={!!errors.text} />
                </FieldWrap>
                <FieldWrap label={t('wordpress.banner.label')} htmlFor="bn-label" error={errors.label} help={t('wordpress.banner.labelHelp', { d: t(`wordpress.defaultLabel.${form.color}`) })}>
                  <Input id="bn-label" value={form.label} onChange={(e) => set('label', e.target.value)} maxLength={30} placeholder={t(`wordpress.defaultLabel.${form.color}`)} className="max-w-[320px]" />
                </FieldWrap>
                <div className="flex gap-6 flex-wrap">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium" id="bn-color-l">
                      {t('wordpress.banner.color')}
                    </span>
                    <div role="radiogroup" aria-labelledby="bn-color-l" className="flex gap-2 flex-wrap">
                      {COLORS.map((c) => {
                        const on = form.color === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={t(`wordpress.color.${c}`)}
                            title={t(`wordpress.color.${c}`)}
                            tabIndex={on ? 0 : -1}
                            onClick={() => set('color', c)}
                            onKeyDown={(e) => {
                              const i = COLORS.indexOf(form.color);
                              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                                e.preventDefault();
                                set('color', COLORS[(i + 1) % COLORS.length]);
                              }
                              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                                e.preventDefault();
                                set('color', COLORS[(i - 1 + COLORS.length) % COLORS.length]);
                              }
                            }}
                            className="w-[30px] h-[30px] rounded-control inline-flex items-center justify-center transition-shadow duration-fast"
                            style={{ background: BANNER_PALETTE[c].bg, color: BANNER_PALETTE[c].fg, boxShadow: on ? `0 0 0 2px var(--ll-card), 0 0 0 4px ${BANNER_PALETTE[c].bg === '#e9ecef' ? 'var(--ll-text-2)' : BANNER_PALETTE[c].bg}` : c === 'neutral' ? 'inset 0 0 0 1px var(--ll-border)' : undefined }}
                          >
                            {on && <Icon name="Check" size={14} strokeWidth={2.6} />}
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-meta text-fg-muted">{t(`wordpress.color.${form.color}`)}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium" id="bn-prio-l">
                      {t('wordpress.banner.priority')}
                    </span>
                    <div role="radiogroup" aria-labelledby="bn-prio-l" className="inline-flex self-start p-[3px] border border-line rounded-control bg-bg">
                      {PRIORITIES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={form.priority === p}
                          onClick={() => set('priority', p)}
                          className={cx('h-[28px] px-3 rounded-chip text-sm transition-colors duration-fast', form.priority === p ? 'bg-raised text-fg font-medium' : 'text-fg-muted hover:text-fg')}
                        >
                          {t(`wordpress.priority.${p}`)}
                        </button>
                      ))}
                    </div>
                    <span className="text-meta text-fg-muted">{form.priority === 'hoch' ? t('wordpress.banner.prioHighHelp') : t('wordpress.banner.prioHelp')}</span>
                  </div>
                </div>
                <div className="flex gap-3 flex-wrap">
                  <FieldWrap className="flex-[1_1_220px]" label={t('wordpress.banner.startsAt')} htmlFor="bn-start" help={form.startsAt ? undefined : t('wordpress.banner.startsNow')}>
                    <div className="flex gap-2">
                      <Input id="bn-start" type="datetime-local" mono value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
                      {form.startsAt && (
                        <Button variant="ghost" onClick={() => set('startsAt', '')}>
                          {t('wordpress.banner.now')}
                        </Button>
                      )}
                    </div>
                  </FieldWrap>
                  <FieldWrap className="flex-[1_1_220px]" label={t('wordpress.banner.endsAt')} htmlFor="bn-end" error={errors.endsAt} help={form.endsAt ? undefined : t('wordpress.banner.endsNever')}>
                    <div className="flex gap-2">
                      <Input id="bn-end" type="datetime-local" mono value={form.endsAt} onChange={(e) => set('endsAt', e.target.value)} invalid={!!errors.endsAt} />
                      {form.endsAt && (
                        <Button variant="ghost" onClick={() => set('endsAt', '')}>
                          {t('wordpress.banner.noEnd')}
                        </Button>
                      )}
                    </div>
                  </FieldWrap>
                </div>
                <div className="flex gap-1.5 flex-wrap -mt-1" role="group" aria-label={t('wordpress.banner.quickEnd')}>
                  <span className="text-meta text-fg-muted self-center mr-1">{t('wordpress.banner.quickEnd')}:</span>
                  {[
                    [1, t('wordpress.banner.q1h')],
                    [3, t('wordpress.banner.q3h')],
                    [24, t('wordpress.banner.q1d')],
                    [168, t('wordpress.banner.q7d')],
                  ].map(([h, l]) => (
                    <Button
                      key={String(h)}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const base = fromLocalInput(form.startsAt);
                        const from = base ? new Date(base).getTime() : Date.now();
                        set('endsAt', toLocalInput(new Date(from + (h as number) * 3_600_000)));
                      }}
                    >
                      {l}
                    </Button>
                  ))}
                </div>
                <div>
                  <WpPagesField label={t('wordpress.banner.pages')} help={t('wordpress.banner.pagesHelp')} error={errors.pages} value={form.pages} onChange={(v) => set('pages', v)} connectionId={siteId} />
                </div>
                <div className="flex gap-3 flex-wrap">
                  <FieldWrap className="flex-[2_1_260px]" label={t('wordpress.banner.link')} htmlFor="bn-link" error={errors.linkUrl} help={t('wordpress.banner.linkHelp')}>
                    <Input id="bn-link" type="url" value={form.linkUrl} onChange={(e) => set('linkUrl', e.target.value)} placeholder="https://" invalid={!!errors.linkUrl} />
                  </FieldWrap>
                  <FieldWrap className="flex-[1_1_180px]" label={t('wordpress.banner.linkText')} htmlFor="bn-linktext">
                    <Input id="bn-linktext" value={form.linkText} onChange={(e) => set('linkText', e.target.value)} maxLength={80} placeholder={t('wordpress.preview.moreLink')} disabled={!form.linkUrl.trim()} />
                  </FieldWrap>
                </div>
              </fieldset>

              {formError && <ErrorBox title={t('wordpress.banner.actionFailed')}>{formError}</ErrorBox>}

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
                {editable && (isNew || view === 'entwurf') && (
                  <Button loading={busy === 'draft'} disabled={!!busy || (!isNew && !dirty)} onClick={saveDraft}>
                    {t('wordpress.banner.saveDraft')}
                  </Button>
                )}
                {editable && (view === 'abgelaufen' || view === 'deaktiviert') && (
                  <Button loading={busy === 'draft'} disabled={!!busy || !dirty} onClick={saveDraft}>
                    {t('wordpress.banner.saveOnly')}
                  </Button>
                )}
                {canPublish && editable && (
                  <Button variant="primary" icon="Send" loading={busy === 'publish'} disabled={!!busy || ((view === 'aktiv' || view === 'geplant') && !dirty)} onClick={publish}>
                    {primaryLabel}
                  </Button>
                )}
              </div>
              {!canPublish && canEdit && <p className="m-0 text-meta text-fg-muted">{t('wordpress.banner.noPublishPerm')}</p>}
            </form>
          </>
        )}
      </section>

      <DeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        objectType={t('wordpress.banner.objectType')}
        name={deleting?.title ?? ''}
        onConfirm={async () => {
          await del(`/banners/${deleting!.id}`);
          onSelect(null);
          await refresh();
          toast({ tone: 'success', title: t('wordpress.banner.deleted') });
        }}
      />
    </div>
  );
}
