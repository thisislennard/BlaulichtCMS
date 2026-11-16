import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get } from '../../api/client';
import { Button, SkeletonRows } from '../../components/ui/core';
import { FeedbackView, feedbackFor } from '../../components/feedback/Feedback';
import { Icon } from '../../components/ui/Icon';
import { LegalMarkdown } from '../../components/legal/LegalMarkdown';
import { LegalLinks } from '../../components/legal/LegalLinks';

/** Öffentliche Seiten /datenschutz und /impressum (#187) – ohne Anmeldung erreichbar. */
export default function LegalPage({ kind }: { kind: 'datenschutz' | 'impressum' }) {
  const title = kind === 'datenschutz' ? 'Datenschutzerklärung' : 'Impressum';
  const q = useQuery({ queryKey: ['public-legal', kind], queryFn: () => get<{ text: string; organization: string }>(`/public/legal/${kind}`), retry: 1 });
  useEffect(() => {
    document.title = `${title} · ${q.data?.organization || 'BlaulichtCMS'}`;
  }, [title, q.data?.organization]);
  return (
    <div className="min-h-screen bg-bg text-fg">
      <main id="main" className="max-w-[760px] mx-auto px-4 md:px-8 py-8 flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{q.data?.organization || 'BlaulichtCMS'}</span>
          {window.history.length > 1 && (
            <Button size="sm" icon="ArrowLeft" onClick={() => window.history.back()}>
              Zurück
            </Button>
          )}
        </div>
        <h1 className="m-0 text-page font-semibold tracking-[-0.03em]">{title}</h1>
        {q.isLoading && <SkeletonRows rows={6} />}
        {q.isError && <FeedbackView {...feedbackFor(q.error)} onRetry={() => q.refetch()} autoRetry compact />}
        {q.data && !q.data.text && (
          <div className="bg-card border border-line rounded-card p-6 flex flex-col items-start gap-2">
            <Icon name="FileText" size={22} className="text-fg-muted" />
            <p className="m-0 font-medium">Noch kein Text hinterlegt.</p>
            <p className="m-0 text-sm text-fg-muted">
              {kind === 'datenschutz' ? 'Die Datenschutzerklärung' : 'Das Impressum'} wird von der Verwaltung unter Einstellungen → Datenschutz eingetragen.
            </p>
            <Link to="/login" className="text-sm">
              Zur Anmeldung
            </Link>
          </div>
        )}
        {q.data?.text && (
          <article className="bg-card border border-line rounded-card p-5 md:p-8">
            <LegalMarkdown text={q.data.text} />
          </article>
        )}
        <LegalLinks />
      </main>
    </div>
  );
}
