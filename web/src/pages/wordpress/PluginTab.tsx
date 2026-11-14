import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { download, get, post } from '../../api/client';
import { Button, Card, ErrorBox, KeyValue, Notice, Skeleton } from '../../components/ui/core';
import { CopyButton, useErrorToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { TestChecklist, TestResultBox, type ConnectionRow, type TestResult } from '../integrations/shared';

interface PluginInfo {
  available: boolean;
  version?: string;
  requiresWp?: string | null;
  requiresPhp?: string | null;
  fileName?: string | null;
}

export function PluginTab({ site }: { site: ConnectionRow }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const errorToast = useErrorToast();
  const catalog = useCatalog();
  const info = useQuery<PluginInfo>({ queryKey: ['wp-plugin'], queryFn: () => get('/wordpress/plugin'), staleTime: 300_000 });
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await post<TestResult>(`/connections/${site.id}/test`));
      qc.invalidateQueries({ queryKey: ['connections'] });
    } catch (e) {
      errorToast(e, t('integrations.detail.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] items-start">
      <div className="flex flex-col gap-5 min-w-0">
        <Card title={t('wordpress.plugin.downloadTitle')} subtitle={t('wordpress.plugin.downloadSub')}>
          {info.isLoading ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-11 w-64" />
            </div>
          ) : info.error ? (
            <ErrorBox title={t('wordpress.plugin.infoError')}>{(info.error as Error).message}</ErrorBox>
          ) : !info.data?.available ? (
            <Notice tone="warning" title={t('wordpress.plugin.missingTitle')}>
              {t('wordpress.plugin.missingText')}
            </Notice>
          ) : (
            <div className="flex flex-col gap-4">
              <KeyValue
                items={[
                  [t('wordpress.plugin.version'), <span className="font-mono">{info.data.version}</span>],
                  [t('wordpress.plugin.requiresWp'), info.data.requiresWp ? `${info.data.requiresWp} ${t('wordpress.plugin.orNewer')}` : '–'],
                  [t('wordpress.plugin.requiresPhp'), info.data.requiresPhp ? `${info.data.requiresPhp} ${t('wordpress.plugin.orNewer')}` : '–'],
                  [t('wordpress.plugin.file'), <span className="font-mono text-meta break-all">{info.data.fileName}</span>],
                ]}
              />
              <div>
                <Button variant="primary" icon="Download" onClick={() => download('/wordpress/plugin/download')}>
                  {t('wordpress.plugin.download')}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card title={t('wordpress.plugin.installTitle')}>
          <ol className="list-decimal m-0 pl-5 flex flex-col gap-2.5 text-sm leading-relaxed">
            <li>{t('wordpress.plugin.install1')}</li>
            <li>{t('wordpress.plugin.install2')}</li>
            <li>{t('wordpress.plugin.install3')}</li>
            <li>{t('wordpress.plugin.install4')}</li>
            <li>
              {t('wordpress.plugin.install5')}{' '}
              <Link to={`/verbindungen/${site.id}`}>{t('wordpress.plugin.install5Link', { name: site.name })}</Link>
            </li>
            <li>{t('wordpress.plugin.install6')}</li>
          </ol>
        </Card>

        <Card title={t('wordpress.plugin.displayTitle')} subtitle={t('wordpress.plugin.displaySub')}>
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium">{t('wordpress.plugin.shortcode')}</span>
              <div className="flex gap-2 items-center flex-wrap">
                <code className="font-mono text-[13px] bg-bg border border-line rounded-control px-3 h-field inline-flex items-center">[lifelink_banners]</code>
                <CopyButton value="[lifelink_banners]" label={t('integrations.common.copy')} />
              </div>
              <span className="text-meta text-fg-muted">{t('wordpress.plugin.shortcodeHelp')}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">{t('wordpress.plugin.block')}</span>
              <span className="text-fg-muted">{t('wordpress.plugin.blockHelp')}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">{t('wordpress.plugin.auto')}</span>
              <span className="text-fg-muted">{t('wordpress.plugin.autoHelp')}</span>
            </div>
            <Notice tone="primary" icon="Sparkles" title={t('wordpress.plugin.themeTitle')}>
              {t('wordpress.plugin.themeText')}
            </Notice>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-5 min-w-0">
        <Card
          title={t('wordpress.plugin.testTitle')}
          subtitle={site.name}
          action={
            can('connection.edit') && (
              <Button size="sm" icon="FlaskConical" loading={testing} onClick={runTest}>
                {t('wordpress.plugin.testNow')}
              </Button>
            )
          }
        >
          <div className="flex flex-col gap-3">
            {!test && !testing && <p className="m-0 text-sm text-fg-muted">{t('wordpress.plugin.testHint')}</p>}
            {(testing || test) && <TestChecklist pending={testing} pendingLabels={catalog.data?.connectors.find((c) => c.id === 'wordpress')?.testInfo} steps={test?.steps} />}
            {test && <TestResultBox result={test} />}
            {!can('connection.edit') && <p className="m-0 text-meta text-fg-muted">{t('wordpress.plugin.testNoPerm')}</p>}
          </div>
        </Card>
        <Card title={t('wordpress.plugin.helpTitle')}>
          <div className="flex flex-col gap-2 text-sm">
            <p className="m-0 text-fg-muted">{t('wordpress.plugin.helpText')}</p>
            <Link to="/hilfe/wordpress" className="inline-flex items-center gap-1.5">
              <Icon name="BookOpen" size={14} />
              {t('wordpress.plugin.helpLink')}
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
