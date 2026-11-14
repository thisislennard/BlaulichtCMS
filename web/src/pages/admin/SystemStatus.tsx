import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../api/client";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  LinkButton,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Table,
  Td,
  Th,
  type Tone,
} from "../../components/ui/core";
import { KpiCard } from "../../components/ui/data";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import {
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtNumber,
  fmtRelative,
} from "../../lib/format";
import { LoadError, StateBadge } from "./shared";

export interface SystemStatusData {
  services: {
    id: string;
    name: string;
    state: "ok" | "warning" | "error";
    detail: string;
    ms: number | null;
  }[];
  workers: {
    worker_id: string;
    started_at: string;
    last_seen_at: string;
    version: string;
    jobs_running: number;
    info: { leader?: boolean };
  }[];
  queue: {
    ready: number;
    scheduled: number;
    running: number;
    dead: number;
    oldest_ready_sec: number;
  };
  sites: { id: string; name: string; site_url: string | null; status: string; last_seen_at: string | null; plugin_version: string | null }[];
  lastBackup: {
    file_name: string;
    status: "running" | "ok" | "failed";
    started_at: string;
    finished_at: string | null;
    size_bytes: number | null;
    error: string | null;
  } | null;
  disk: { free: number; total: number } | null;
  dbSize: number;
  version: string;
  uptimeSec: number;
  node: string;
}

const SERVICE_ICON: Record<string, string> = {
  api: "Server",
  db: "Database",
  worker: "RefreshCw",
  queue: "ListChecks",
  media: "Images",
  disk: "HardDrive",
};

export function useSystemStatus(refetchInterval: number | false = 15_000) {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: () => get<SystemStatusData>("/system/status"),
    refetchInterval,
  });
}

export function fmtUptime(sec: number) {
  return fmtDuration(sec * 1000).replace(/ \d+ s$/, "");
}

export default function SystemStatus() {
  const q = useSystemStatus();
  const d = q.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("admin.system.title")}
        subtitle={t("admin.system.subtitle")}
        actions={
          <>
            {q.dataUpdatedAt > 0 && (
              <span className="text-meta text-fg-muted" aria-live="polite">
                {t("admin.system.updated", {
                  when: fmtRelative(q.dataUpdatedAt),
                })}
              </span>
            )}
            <Button
              icon="RefreshCw"
              loading={q.isFetching}
              onClick={() => q.refetch()}
            >
              {t("admin.system.refresh")}
            </Button>
          </>
        }
      />
      {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}

      {/* Betrieb-Kacheln */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {d ? (
          <>
            <KpiCard
              label={t("admin.system.uptime")}
              icon="Clock"
              value={fmtUptime(d.uptimeSec)}
              delta={
                t("admin.system.since") +
                " " +
                fmtDateTime(Date.now() - d.uptimeSec * 1000)
              }
            />
            <KpiCard
              label={t("admin.system.dbSize")}
              icon="Database"
              value={fmtBytes(d.dbSize)}
              delta={d.services.find((s) => s.id === "db")?.detail}
            />
            <KpiCard
              label={t("admin.system.disk")}
              icon="HardDrive"
              value={d.disk ? fmtBytes(d.disk.free) : "–"}
              delta={
                d.disk
                  ? t("admin.system.diskFree", {
                      total: fmtBytes(d.disk.total),
                      pct: fmtNumber((d.disk.free / d.disk.total) * 100),
                    })
                  : undefined
              }
              deltaTone={
                d.disk && d.disk.free / d.disk.total < 0.1 ? "err" : "muted"
              }
            />
            <KpiCard
              label={t("admin.system.lastBackup")}
              icon="Archive"
              value={
                d.lastBackup
                  ? fmtRelative(d.lastBackup.started_at)
                  : t("admin.system.noBackup")
              }
              delta={
                d.lastBackup
                  ? t(`admin.settings.backupStatus.${d.lastBackup.status}`)
                  : undefined
              }
              deltaTone={
                d.lastBackup?.status === "failed"
                  ? "err"
                  : d.lastBackup?.status === "ok"
                    ? "ok"
                    : "muted"
              }
              href="/einstellungen#sicherung"
            />
            <KpiCard
              label={t("admin.system.version")}
              icon="Box"
              value={d.version}
            />
            <KpiCard
              label={t("admin.system.node")}
              icon="Server"
              value={d.node.replace(/^v/, "")}
            />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[112px] rounded-card" />
          ))
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card title={t("admin.system.services")}>
          {!d ? (
            <SkeletonRows rows={5} />
          ) : (
            <ul className="list-none m-0 p-0 flex flex-col">
              {d.services.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className="w-8 h-8 rounded-control bg-raised inline-flex items-center justify-center text-fg-muted shrink-0"
                  >
                    <Icon name={SERVICE_ICON[s.id] ?? "Server"} size={15} />
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="font-medium text-sm">{s.name}</span>
                    <span
                      className={cx(
                        "text-meta truncate",
                        s.state === "error" ? "text-err" : "text-fg-muted",
                      )}
                    >
                      {s.detail}
                    </span>
                  </span>
                  {s.ms != null && (
                    <span className="font-mono text-meta text-fg-muted tabular">
                      {fmtNumber(s.ms)} ms
                    </span>
                  )}
                  <StateBadge state={s.state} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t("admin.system.queue")}
          action={
            <LinkButton
              to="/protokolle"
              size="sm"
              variant="ghost"
              icon="ScrollText"
            >
              {t("admin.system.showLogs")}
            </LinkButton>
          }
        >
          {!d ? (
            <SkeletonRows rows={3} />
          ) : (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 m-0">
                {(
                  [
                    ["ready", d.queue.ready, false],
                    ["scheduled", d.queue.scheduled, false],
                    ["running", d.queue.running, false],
                    ["dead", d.queue.dead, d.queue.dead > 0],
                  ] as const
                ).map(([k, v, bad]) => (
                  <div
                    key={k}
                    className="bg-raised rounded-node px-3 py-2.5 flex flex-col gap-0.5 min-w-0"
                  >
                    <dt className="text-meta text-fg-muted">
                      {t(`admin.system.${k}`)}
                    </dt>
                    <dd
                      className={cx(
                        "m-0 text-title font-semibold tabular",
                        bad && "text-err",
                      )}
                    >
                      {fmtNumber(v)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="m-0 text-sm text-fg-muted flex items-center gap-2">
                <Icon name="Hourglass" size={14} />
                {d.queue.oldest_ready_sec > 0
                  ? t("admin.system.oldest", {
                      age: fmtDuration(d.queue.oldest_ready_sec * 1000),
                    })
                  : t("admin.system.oldestNone")}
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card title={t("admin.system.workers")} bodyClassName="!px-0 !pb-2">
        {!d ? (
          <SkeletonRows rows={2} className="px-5" />
        ) : d.workers.length === 0 ? (
          <EmptyState
            icon="RefreshCw"
            title={t("admin.system.noWorkers")}
            text={t("admin.system.noWorkersText")}
          />
        ) : (
          <Table className="relative">
            <thead>
              <tr>
                <Th className="pl-5">{t("admin.system.workerId")}</Th>
                <Th>{t("admin.system.version")}</Th>
                <Th>{t("admin.system.since")}</Th>
                <Th>{t("admin.system.lastSeen")}</Th>
                <Th align="right">{t("admin.system.jobs")}</Th>
                <Th>{t("admin.system.leader")}</Th>
              </tr>
            </thead>
            <tbody>
              {d.workers.map((w) => {
                const stale =
                  Date.now() - new Date(w.last_seen_at).getTime() > 45_000;
                return (
                  <tr key={w.worker_id} className={cx(stale && "opacity-60")}>
                    <Td mono className="pl-5">
                      {w.worker_id}
                    </Td>
                    <Td mono>{w.version}</Td>
                    <Td className="text-meta text-fg-muted whitespace-nowrap">
                      {fmtDateTime(w.started_at)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {stale ? (
                        <Badge
                          tone={
                            Date.now() - new Date(w.last_seen_at).getTime() >
                            600_000
                              ? "neutral"
                              : "warning"
                          }
                        >
                          {t("admin.system.stale")} ·{" "}
                          {fmtRelative(w.last_seen_at)}
                        </Badge>
                      ) : (
                        <span className="text-meta text-fg-muted">
                          {fmtRelative(w.last_seen_at)}
                        </span>
                      )}
                    </Td>
                    <Td align="right" mono>
                      {w.jobs_running}
                    </Td>
                    <Td>
                      {w.info?.leader && !stale ? (
                        <Badge tone="primary">{t("admin.system.leader")}</Badge>
                      ) : (
                        <span className="text-fg-muted">–</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Websites (LifeLink Bridge)" bodyClassName="!px-0 !pb-2">
        {!d ? (
          <SkeletonRows rows={3} className="px-5" />
        ) : d.sites.length === 0 ? (
          <EmptyState
            icon="Globe"
            title="Keine Website gekoppelt"
            text="Der interne Redaktionsablauf funktioniert auch ohne Website."
            action={
              <LinkButton to="/kanaele" icon="Plus">
                Website koppeln
              </LinkButton>
            }
          />
        ) : (
          <Table className="relative">
            <thead>
              <tr>
                <Th className="pl-5">{t("admin.users.col.name")}</Th>
                <Th>{t("admin.users.col.status")}</Th>
                <Th>Letzter Abruf</Th>
                <Th>Bridge</Th>
              </tr>
            </thead>
            <tbody>
              {d.sites.map((c) => (
                <tr key={c.id} className="hover:bg-raised transition-colors duration-fast">
                  <Td className="pl-5">
                    <Link to="/kanaele" className="font-medium">
                      {c.name}
                    </Link>
                    <span className="block text-meta text-fg-muted font-mono">{c.site_url ?? "–"}</span>
                  </Td>
                  <Td>
                    <Badge tone={c.status === "active" ? "success" : "neutral"}>{c.status === "active" ? "Aktiv" : "Wartet auf Kopplung"}</Badge>
                  </Td>
                  <Td className="text-meta text-fg-muted whitespace-nowrap">{c.last_seen_at ? fmtRelative(c.last_seen_at) : "–"}</Td>
                  <Td mono>{c.plugin_version ?? "–"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
