import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get, post } from '../../api/client';
import { Button, SkeletonRows } from '../../components/ui/core';
import { FeedbackView, feedbackFor } from '../../components/feedback/Feedback';
import { Icon } from '../../components/ui/Icon';
import { LegalLinks } from '../../components/legal/LegalLinks';

/** Öffentliche Abmeldung vom Presseverteiler (#207) – Link aus jeder Pressemitteilung, ohne Anmeldung. */
export default function PressUnsubscribe() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['press-unsubscribe', token], queryFn: () => get<{ email: string; unsubscribed: boolean }>(`/public/press/unsubscribe/${encodeURIComponent(token)}`), retry: 0 });
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    document.title = 'Vom Presseverteiler abmelden';
  }, []);
  const unsubscribed = done || q.data?.unsubscribed;
  return (
    <div className="min-h-screen bg-bg text-fg">
      <main id="main" className="max-w-[560px] mx-auto px-4 md:px-8 py-12 flex flex-col gap-6">
        <h1 className="m-0 text-page font-semibold tracking-[-0.03em]">Vom Presseverteiler abmelden</h1>
        {q.isLoading && <SkeletonRows rows={3} />}
        {q.isError && <FeedbackView {...feedbackFor(q.error)} compact />}
        {q.data && (
          <div className="bg-card border border-line rounded-card p-6 flex flex-col items-start gap-3">
            {unsubscribed ? (
              <>
                <Icon name="CheckCircle2" size={24} className="text-ok" />
                <p className="m-0 font-medium">Abgemeldet.</p>
                <p className="m-0 text-sm text-fg-muted">{q.data.email} erhält keine Pressemitteilungen mehr über diesen Verteiler.</p>
              </>
            ) : (
              <>
                <p className="m-0">
                  Keine Pressemitteilungen mehr an <strong>{q.data.email}</strong> senden?
                </p>
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await post(`/public/press/unsubscribe/${encodeURIComponent(token)}`);
                      setDone(true);
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Abmelden
                </Button>
                {!!error && <FeedbackView {...feedbackFor(error)} compact />}
              </>
            )}
          </div>
        )}
        <LegalLinks />
      </main>
    </div>
  );
}
