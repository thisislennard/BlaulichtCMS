import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import type { PostListItem } from '../../api/types';
import { Button, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, Rev, SegmentedControl, Select, SkeletonRows, StatusBadge, Table, Td, Th } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';

export const KIND_LABEL: Record<string, string> = { news: 'Nachricht', incident: 'Einsatzbericht', event: 'Veranstaltung', situation: 'Lage-Info' };

export function NewPostDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('news');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const tpls = useQuery({ queryKey: ['templates'], queryFn: () => get<any[]>('/templates') });
  const create = async () => {
    setBusy(true);
    try {
      const p = await post<any>('/posts', { title: title.trim(), kind, templateId: templateId || null });
      nav(`/beitraege/${p.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Neuer Beitrag"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon="Plus" loading={busy} disabled={title.trim().length < 2} onClick={create}>
            Anlegen
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), title.trim().length >= 2 && create())}>
        <FieldWrap label="Arbeitstitel" required htmlFor="p-title">
          <Input id="p-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="z. B. Übung am Wochenende" />
        </FieldWrap>
        {(tpls.data?.length ?? 0) > 0 && (
          <FieldWrap label="Vorlage (optional)" htmlFor="p-tpl">
            <Select
              id="p-tpl"
              value={templateId}
              onChange={(e) => {
                // Art und (wenn noch leer) Titel aus der Vorlage übernehmen – die Anzeige entspricht dem, was angelegt wird
                const t = tpls.data!.find((x) => x.id === e.target.value);
                setTemplateId(e.target.value);
                if (t) {
                  setKind(t.kind);
                  if (!title.trim() && t.title) setTitle(t.title);
                }
              }}
            >
              <option value="">– ohne Vorlage –</option>
              {tpls.data!.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
        )}
        <FieldWrap label="Art" help={templateId ? 'Aus der Vorlage übernommen.' : undefined} htmlFor="p-kind">
          <Select id="p-kind" value={kind} disabled={!!templateId} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </FieldWrap>
      </form>
    </Dialog>
  );
}

type F = 'all' | 'open' | 'review' | 'published';

export default function Posts({ mode }: { mode?: 'approvals' }) {
  const { can } = useAuth();
  const [filter, setFilter] = useState<F>(mode === 'approvals' ? 'review' : 'all');
  const [create, setCreate] = useState(false);
  const q = useQuery({ queryKey: ['posts'], queryFn: () => get<PostListItem[]>('/posts'), refetchInterval: 20_000 });
  const rows = (q.data ?? []).filter((p) =>
    filter === 'all' ? true : filter === 'open' ? ['draft', 'rejected'].includes(p.state) : filter === 'review' ? ['in_review', 'approved', 'scheduled', 'failed', 'unknown'].includes(p.state) : ['published', 'publishing', 'deactivated'].includes(p.state),
  );
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={mode === 'approvals' ? 'Freigaben' : 'Beiträge'}
        subtitle={mode === 'approvals' ? 'Fassungen, die auf Freigabe oder Veröffentlichung warten.' : 'Jede Änderung erzeugt eine neue Fassung. Freigaben gelten genau für eine Fassung.'}
        actions={
          can('post.edit') && (
            <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
              Neuer Beitrag
            </Button>
          )
        }
      />
      <SegmentedControl
        label="Filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Alle' },
          { value: 'open', label: 'In Arbeit' },
          { value: 'review', label: 'Freigabe & Veröffentlichung' },
          { value: 'published', label: 'Veröffentlicht' },
        ]}
      />
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Beiträge konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && rows.length === 0 && <EmptyState icon="FileText" title="Keine Beiträge" text={filter === 'all' ? 'Lege den ersten Beitrag an.' : 'In dieser Ansicht gibt es gerade nichts.'} />}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Titel</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Zielkanal</Th>
              <Th className="hidden md:table-cell">Geändert</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link to={`/beitraege/${p.id}`} className="font-medium">
                    {p.title}
                  </Link>
                  <div className="text-meta text-fg-muted">
                    {KIND_LABEL[p.kind]} · <Rev n={p.current_revision} />
                    {p.collection_count > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1">
                        <Icon name="Images" size={12} /> {p.collection_count}
                      </span>
                    )}
                  </div>
                </Td>
                <Td>
                  <StatusBadge status={p.state} />
                  {p.published_url && (
                    <a href={safeHref(p.published_url)} target="_blank" rel="noopener noreferrer" className="block text-meta mt-1 truncate max-w-[260px]">
                      {p.published_url}
                    </a>
                  )}
                </Td>
                <Td className="hidden md:table-cell">{p.site_name ?? <span className="text-fg-muted">nur intern</span>}</Td>
                <Td className="hidden md:table-cell">
                  <span className="font-mono text-meta">{fmtRelative(p.updated_at)}</span>
                  {p.updated_by_name && <div className="text-meta text-fg-muted">{p.updated_by_name}</div>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {create && <NewPostDialog onClose={() => setCreate(false)} />}
    </div>
  );
}
