import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, download, get, post } from '../../../api/client';
import { Badge, Button, ErrorBox, FieldWrap, Notice, Select, SkeletonRows, Table, Td, Th } from '../../../components/ui/core';
import { CopyButton, useToast } from '../../../components/ui/overlays';
import { Icon } from '../../../components/ui/Icon';
import { t } from '../../../i18n';
import { useAuth } from '../../../lib/auth';
import { fmtBytes, fmtDateTime } from '../../../lib/format';
import { LoadError, SectionCard } from '../shared';
import { fieldId, FieldGrid, NumField, SettingsForm, SwitchField, useSettingsForm } from './model';
import { OffsiteBackupSection } from './OffsiteBackup';

interface Backup {
  id: string;
  file_name: string;
  size_bytes: number | null;
  status: 'running' | 'ok' | 'failed';
  started_at: string;
  finished_at: string | null;
  error: string | null;
  trigger: string;
  created_by_name: string | null;
  /** Sicherung außer Haus (#212) */
  offsite_status?: 'pending' | 'ok' | 'failed' | null;
  offsite_error?: string | null;
}

function BackupHour() {
  const { v, set, ro } = useSettingsForm();
  return (
    <FieldWrap label={t('admin.settings.backupHour')} htmlFor={fieldId('backup.hour')}>
      <Select id={fieldId('backup.hour')} disabled={ro('backup.hour') || !v['backup.enabled']} value={String(v['backup.hour'])} onChange={(e) => set('backup.hour', Number(e.target.value))}>
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, '0')}:00
          </option>
        ))}
      </Select>
    </FieldWrap>
  );
}

/**
 * Einstellungen → Sicherung (#256): tägliche Sicherung (Zeitplan, Aufbewahrung, Liste), Sicherung außer Haus und
 * Probe-Wiederherstellung – eine Speichern-Leiste für beide Formulare.
 */
export function BackupPage() {
  const { can } = useAuth();
  return (
    <>
      <SettingsForm keys={['backup.enabled', 'backup.hour', 'backup.keep']} label="Sicherung">
        <SectionCard id="lokal" title="Tägliche Sicherung" description={t('admin.settings.backupDesc')} bodyClassName="flex flex-col gap-4">
          <SwitchField k="backup.enabled" label={t('admin.settings.backupAuto')} description={t('admin.settings.backupAutoDesc')} />
          <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
            <BackupHour />
            <NumField k="backup.keep" label={t('admin.settings.backupKeep')} help={t('admin.settings.backupKeepHelp')} min={1} max={365} />
          </FieldGrid>
          <Notice tone="warning" icon="KeyRound" title={t('admin.settings.masterKey')}>
            <p className="m-0">{t('admin.settings.masterKeyText')}</p>
            <Link to="/hilfe/sicherung" className="inline-flex items-center gap-1 mt-1.5">
              <Icon name="BookOpen" size={13} />
              {t('admin.settings.restoreHelp')}
            </Link>
          </Notice>
          {can('backup.manage') ? <BackupList /> : <p className="m-0 text-sm text-fg-muted">{t('admin.settings.noManage')}</p>}
        </SectionCard>
      </SettingsForm>
      {can('backup.manage') && <OffsiteBackupSection />}
    </>
  );
}

function BackupList() {
  const mayDownload = useAuth().can("backup.download");
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["backups"],
    queryFn: () => get<Backup[]>("/backups"),
    refetchInterval: (query) =>
      (query.state.data as Backup[] | undefined)?.some(
        (b) =>
          b.status === "running" &&
          Date.now() - new Date(b.started_at).getTime() < 600_000,
      )
        ? 3000
        : false,
  });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<{
    msg: string;
    tech: string;
  } | null>(null);
  const run = async () => {
    setBusy(true);
    setLastError(null);
    try {
      const r = await post<{ fileName?: string; file_name?: string }>(
        "/backups",
      );
      toast({
        tone: "success",
        title: t("admin.settings.backupDone"),
        text: r.fileName ?? r.file_name,
      });
    } catch (e) {
      const err = e as ApiError;
      setLastError({
        msg: err.message,
        tech: `${err.status ?? ""} ${err.code ?? ""} ${err.message}`.trim(),
      });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["backups"] });
      qc.invalidateQueries({ queryKey: ["system-status"] });
    }
  };
  const rows = q.data ?? [];
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lastError) errRef.current?.focus();
  }, [lastError]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="m-0 text-sm font-semibold">
          {t("admin.settings.backupList")}
        </h3>
        <Button icon="HardDrive" loading={busy} onClick={run}>
          {t("admin.settings.backupNow")}
        </Button>
      </div>
      {lastError && (
        <div ref={errRef} tabIndex={-1} className="outline-none">
          <ErrorBox
            title={t("admin.settings.backupFailed")}
            actions={
              <CopyButton
                size="sm"
                value={lastError.tech}
                label={t("admin.common.copyDetails")}
              />
            }
          >
            <p className="m-0">
              {/^Fehler \d+$/.test(lastError.msg)
                ? t("admin.settings.backupNoAnswer")
                : lastError.msg
                    .replace(/^Sicherung fehlgeschlagen:\s*/, "")
                    .slice(0, 300)}
            </p>
            <p className="m-0 mt-1">{t("admin.settings.backupFailedWhy")}</p>
          </ErrorBox>
        </div>
      )}
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <SkeletonRows rows={2} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          {t("admin.settings.backupEmpty")}
        </p>
      ) : (
        <div className="border border-line rounded-node overflow-hidden">
          <Table className="relative">
            <thead>
              <tr>
                <Th>{t("admin.settings.backupWhen")}</Th>
                <Th>{t("admin.settings.backupFile")}</Th>
                <Th align="right">{t("admin.settings.backupSize")}</Th>
                <Th>{t("admin.users.col.status")}</Th>
                <Th>{t("admin.settings.backupBy")}</Th>
                <Th className="w-12">
                  <span className="sr-only">
                    {t("admin.settings.download")}
                  </span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.id}
                  className="hover:bg-raised transition-colors duration-fast"
                >
                  <Td className="text-meta whitespace-nowrap">
                    {fmtDateTime(b.started_at)}
                  </Td>
                  <Td mono className="max-w-[240px] truncate">
                    {b.file_name}
                  </Td>
                  <Td align="right" mono>
                    {fmtBytes(b.size_bytes)}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        b.status === "ok"
                          ? "success"
                          : b.status === "failed"
                            ? "error"
                            : "primary"
                      }
                      pulse={b.status === "running"}
                      title={b.error ?? undefined}
                    >
                      {t(`admin.settings.backupStatus.${b.status}`)}
                    </Badge>
                    {b.error && (
                      <span
                        className="block text-[11px] text-fg-muted max-w-[260px] truncate mt-0.5"
                        title={b.error}
                      >
                        {b.error}
                      </span>
                    )}
                    {b.offsite_status && (
                      <span
                        className={`block text-[11px] mt-0.5 ${b.offsite_status === "failed" ? "text-err" : "text-fg-muted"}`}
                        title={b.offsite_error ?? undefined}
                      >
                        {b.offsite_status === "ok"
                          ? "außer Haus abgelegt"
                          : b.offsite_status === "pending"
                            ? "außer Haus: wird übertragen"
                            : "außer Haus fehlgeschlagen"}
                      </span>
                    )}
                  </Td>
                  <Td className="text-meta text-fg-muted whitespace-nowrap">
                    {b.trigger === "manual"
                      ? (b.created_by_name ??
                        t("admin.settings.backupTrigger.manual"))
                      : b.trigger === "offsite"
                        ? "vom Ziel außer Haus geholt"
                        : t("admin.settings.backupTrigger.schedule")}
                  </Td>
                  <Td align="right">
                    {b.status === "ok" && mayDownload && (
                      <Button
                        size="sm"
                        iconOnly
                        icon="Download"
                        aria-label={t("admin.settings.downloadOf", {
                          name: b.file_name,
                        })}
                        onClick={() => download(`/backups/${b.id}/download`)}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
