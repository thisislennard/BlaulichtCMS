import { Link } from "react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client";
import {
  Badge,
  Button,
  Card,
  cx,
  LinkButton,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Table,
  Td,
  Th,
  type Tone,
  EmptyLine,
  EmptyAction,
} from "../../components/ui/core";
import { KpiCard } from "../../components/ui/data";
import { Icon } from "../../components/ui/Icon";
import { useConfirm, useToast } from "../../components/ui/overlays";
import { t } from "../../i18n";
import {
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtNumber,
  fmtRelative,
} from "../../lib/format";
import { LoadError, StateBadge } from "./shared";
import { useAuth } from "../../lib/auth";
import { UpdateAvailableNotice } from "./settings/Updates";
import { useHashScroll } from "../../lib/useHashScroll";
import { plural } from '../../lib/format';

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
  maintenance?: { since: string; byName: string; reason: string } | null;
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
  proxy: "Globe",
  offsite: "UploadCloud",
  "offsite-leftovers": "Archive",
  drill: "FlaskConical",
};

export function useSystemStatus(refetchInterval: number | false = 15_000, enabled = true) {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: () => get<SystemStatusData>("/system/status"),
    refetchInterval,
    enabled,
  });
}

export function fmtUptime(sec: number) {
  return fmtDuration(sec * 1000).replace(/ \d+ s$/, "");
}

interface AuditIntegrity {
  ok: boolean;
  checked: number;
  unsealed: number;
  first: { id: string; seq: number; at: string } | null;
  last: { id: string; seq: number; at: string; hash: string } | null;
  problems: { id: string; seq: number; kind: string; text: string }[];
  verifiedAt: string;
  forward: string | null;
}

/** Hash-Kette des Audit-Protokolls prüfen (#112) – nur auf Knopfdruck, die Prüfung rechnet alle Einträge nach. */
function AuditIntegrityCard() {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ["audit-integrity"],
    queryFn: () => get<AuditIntegrity>("/system/audit-integrity"),
    enabled: false,
    retry: false,
  });
  if (!can("audit.view")) return null;
  const v = q.data;
  return (
    <Card
      title="Audit-Integrität"
      action={
        <Button size="sm" icon="ShieldCheck" loading={q.isFetching} onClick={() => q.refetch()}>
          Jetzt prüfen
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0 text-fg-muted">
          Jeder Audit-Eintrag ist mit seinem Vorgänger verkettet und versiegelt. Die Prüfung erkennt nachträglich
          geänderte oder mittendrin gelöschte Einträge. Der Worker prüft zusätzlich einmal am Tag.
        </p>
        {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}
        {v && (
          <>
            <p className={cx("m-0 flex items-center gap-2 font-medium", v.ok ? "text-ok" : "text-err")}>
              <Icon name={v.ok ? "CircleCheck" : "AlertTriangle"} size={16} />
              {v.ok
                ? `${plural(v.checked, 'Eintrag', 'Einträge')} geprüft – keine Auffälligkeiten.`
                : `${plural(v.problems.length, 'Auffälligkeit', 'Auffälligkeiten')} in ${plural(v.checked, 'Eintrag', 'Einträgen')}.`}
            </p>
            {v.problems.length > 0 && (
              <ul className="m-0 pl-5 list-disc text-err">
                {v.problems.slice(0, 10).map((p) => (
                  <li key={`${p.seq}-${p.kind}`}>
                    Eintrag {p.id}: {p.text}
                  </li>
                ))}
              </ul>
            )}
            <dl className="m-0 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-fg-muted">
              <dt>Letztes Siegel</dt>
              <dd className="m-0 font-mono text-[12px] break-all">
                {v.last ? `#${v.last.seq} · ${fmtDateTime(v.last.at)} · ${v.last.hash.slice(0, 16)}…` : "–"}
              </dd>
              <dt>Weiterleitung</dt>
              <dd className="m-0">
                {v.forward ? `aktiv (${v.forward})` : "aus – nur in der Datenbank (AUDIT_FORWARD) – "}
                {!v.forward && <Link to="/hilfe/sicherheit#audit-weiterleitung">einrichten</Link>}
              </dd>
            </dl>
          </>
        )}
      </div>
    </Card>
  );
}

/** Wartungsmodus: eigene Karte, damit das Recht system.maintenance ohne update.install genügt. */
function MaintenanceCard({ data }: { data: SystemStatusData | undefined }) {
  const { can } = useAuth();
  const ask = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!can("system.maintenance") || !data) return null;
  const m = data.maintenance ?? null;
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await post("/system/maintenance", { enabled, reason: enabled ? "Wartung" : "" });
      toast({ tone: "success", title: enabled ? "Wartungsmodus aktiv" : "Wartungsmodus beendet" });
      await qc.invalidateQueries({ queryKey: ["system-status"] });
      qc.invalidateQueries({ queryKey: ["update-preflight"] });
    } catch (e) {
      toast({ tone: "error", title: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      id="wartungsmodus"
      title="Wartungsmodus"
      action={<Badge tone={m ? "warning" : "neutral"}>{m ? "aktiv" : "Normalbetrieb"}</Badge>}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0 text-fg-muted">
          {m
            ? `Aktiv seit ${fmtDateTime(m.since)} (${m.byName}): ${m.reason}. Schreibende Vorgänge und neue Aufträge sind angehalten.`
            : "Im Wartungsmodus pausieren schreibende Vorgänge und neue Aufträge, zum Beispiel vor einem Update oder einer Wiederherstellung."}
        </p>
        <div className="flex flex-wrap gap-2">
          {m ? (
            <Button loading={busy} onClick={() => toggle(false)}>
              Wartungsmodus beenden
            </Button>
          ) : (
            <Button
              icon="Hourglass"
              loading={busy}
              onClick={async () =>
                (await ask({
                  title: "Wartungsmodus einschalten?",
                  text: "Schreibende Vorgänge und neue Aufträge pausieren, bis der Wartungsmodus wieder aus ist.",
                  confirmLabel: "Einschalten",
                })) && toggle(true)
              }
            >
              Wartungsmodus einschalten
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function SystemStatus() {
  const { can, canAny } = useAuth();
  const q = useSystemStatus();
  useHashScroll(!!q.data);
  const d = q.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
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
      <UpdateAvailableNotice />

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
              href="/einstellungen/sicherung"
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
                        "text-meta",
                        // Hinweise mit Handlungsanweisung (z. B. Proxy) vollständig zeigen
                        s.state === "ok" && "truncate",
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
            canAny("system.logs", "audit.view") && (
              <LinkButton
                to="/protokolle"
                size="sm"
                variant="ghost"
                icon="ScrollText"
              >
                {t("admin.system.showLogs")}
              </LinkButton>
            )
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

      <MaintenanceCard data={d} />

      <AuditIntegrityCard />

      <Card title={t("admin.system.workers")} bodyClassName="!px-0 !pb-2">
        {!d ? (
          <SkeletonRows rows={2} className="px-5" />
        ) : d.workers.length === 0 ? (
          <EmptyLine className="px-5 pb-3">
            {t("admin.system.noWorkers")}. {t("admin.system.noWorkersText")}
          </EmptyLine>
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
                        <Badge>{t("admin.system.leader")}</Badge>
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

      <Card title="Websites (BlaulichtCMS Bridge)" bodyClassName="!px-0 !pb-2">
        {!d ? (
          <SkeletonRows rows={3} className="px-5" />
        ) : d.sites.length === 0 ? (
          <EmptyLine className="px-5 pb-3" action={can("channel.sites") && <EmptyAction to="/websites">Website koppeln</EmptyAction>}>
            Noch keine Website gekoppelt – der interne Redaktionsablauf funktioniert auch ohne.
          </EmptyLine>
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
                    {can("channel.view") ? (
                      <Link to="/websites" className="font-medium">
                        {c.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.name}</span>
                    )}
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
