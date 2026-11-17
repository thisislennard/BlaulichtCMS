import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, post } from '../../api/client';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Notice, PageHeader, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

export const KIND: Record<string, string> = { initial: 'Erstmeldung', update: 'Aktualisierung', all_clear: 'Entwarnung' };
export const WARN_STATE: Record<string, string> = {
  draft: 'Entwurf',
  in_review: 'Zur Freigabe',
  rejected: 'Zurückgewiesen',
  approved: 'Freigegeben – bereit zum Versand',
  sending: 'Wird versendet',
  sent: 'Versendet (angenommen)',
  send_failed: 'Versand fehlgeschlagen',
  send_unknown: 'Versand unklar – prüfen',
  acknowledged: 'Eingang bestätigt',
};

interface Row {
  id: string;
  case_no: string;
  kind: string;
  parent_case_no: string | null;
  headline: string | null;
  level_decision: { level: number } | null;
  keyword: { code: string } | null;
  state: string;
  updated_at: string;
}

export function LevelBadge({ level, kind }: { level?: number | null; kind: string }) {
  if (kind === 'all_clear') return <Badge tone="success">Entwarnung</Badge>;
  if (!level) return <Badge tone="warning">Stufe offen</Badge>;
  return <Badge tone={level === 1 ? 'error' : level === 2 ? 'warning' : 'neutral'}>Warnstufe {level}</Badge>;
}

export default function Warnings() {
  const { can, canAny } = useAuth();
  const nav = useNavigate();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['warnings'], queryFn: () => get<Row[]>('/warnings') });
  const create = async () => {
    try {
      const r = await post<{ id: string }>('/warnings', { kind: 'initial' });
      nav(`/warnungen/${r.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Vorbereitung und Übergabe an die zuständige Stelle. Die amtliche Auslösung erfolgt dort."
        actions={
          <>
            {canAny('warning.rules', 'warning.approve', 'warning.settings') ? <LinkButton to="/stichwoerter-regeln" icon="Settings">Stichwörter &amp; Regeln</LinkButton> : null}
            {can('warning.draft') && (
              <Button variant="primary" icon="Plus" onClick={create}>
                Neue Erstmeldung
              </Button>
            )}
          </>
        }
      />
      <Notice tone="warning" icon="Siren" title="Kein Auslösesystem">
        BlaulichtCMS löst keine amtliche Warnung aus. Ein Warnstufen-Vorschlag ist nur eine Hilfe: Er muss ausdrücklich bestätigt werden und löst weder Versand noch Veröffentlichung aus.
      </Notice>
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Warnentwürfe konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data?.length === 0 && <EmptyState icon="Siren" title="Noch keine Warnentwürfe" text={can('warning.draft') ? 'Eine Erstmeldung anlegen; Aktualisierung und Entwarnung entstehen aus einem bestehenden Vorgang.' : undefined} />}
      <div className="flex flex-col gap-3">
        {(q.data ?? []).map((w) => (
          <Card key={w.id}>
            <button type="button" className="w-full text-left flex flex-col gap-2" onClick={() => nav(`/warnungen/${w.id}`)}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono">{w.case_no}</strong>
                <span className="text-fg-muted text-sm">{KIND[w.kind]}{w.parent_case_no ? ` zu ${w.parent_case_no}` : ''}</span>
                <LevelBadge level={w.level_decision?.level} kind={w.kind} />
                <StatusBadge status={w.state} labels={WARN_STATE} />
                <span className="ml-auto text-meta text-fg-muted">{fmtRelative(w.updated_at)}</span>
              </div>
              <div className="font-medium">{w.headline || <span className="text-fg-muted">Ohne Überschrift</span>}</div>
              {w.keyword && <div className="text-meta text-fg-muted">Stichwort {w.keyword.code}</div>}
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}
