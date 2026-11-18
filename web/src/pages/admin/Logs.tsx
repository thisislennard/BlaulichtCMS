import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { FilterEmpty, ListToolbar } from "../../components/ui/list";
import { useListState } from "../../lib/listState";
import { useInfiniteQuery } from "@tanstack/react-query";
import { get, qs } from "../../api/client";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonRows,
  Tabs,
  type Tone,
} from "../../components/ui/core";
import { JsonView } from "../../components/ui/data";
import { CopyButton } from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { AuditTable } from "./AuditTable";
import { LoadError, type AuditEvent } from "./shared";

interface LogRow {
  id: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  details: Record<string, unknown>;
  correlation_id: string | null;
}

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms);
    return () => clearTimeout(h);
  }, [v, ms]);
  return d;
}

type Tab = "system" | "audit";

export default function Logs() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canAudit = can("audit.view");
  const canSystem = can("system.logs");
  const tab: Tab =
    canAudit && (params.get("tab") === "audit" || !canSystem) ? "audit" : "system";
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle={t("admin.logs.subtitle")}
      />
      <Tabs
        label={t("admin.logs.title")}
        value={tab}
        onChange={(v) =>
          // Filter gehören zum Reiter – beim Wechsel leeren
          setParams(v === "audit" ? { tab: "audit" } : {}, { replace: true })
        }
        tabs={[
          ...(canSystem
            ? [{ value: "system" as Tab, label: t("admin.logs.tabs.system") }]
            : []),
          ...(canAudit
            ? [{ value: "audit" as Tab, label: t("admin.logs.tabs.audit") }]
            : []),
        ]}
      />
      <div role="tabpanel">
        {tab === "system" ? (
          <SystemLog />
        ) : (
          <AuditLog />
        )}
      </div>
    </div>
  );
}

const LEVEL_TONE: Record<string, Tone> = {
  error: "error",
  warn: "warning",
  info: "neutral",
  debug: "neutral",
};

function SystemLog() {
  // Stufe, Quelle und Suche in der Adresse (#260)
  const ls = useListState({ stufe: "all", quelle: "", suche: "" }, { tabKeys: ["stufe"] });
  const level = (["all", "info", "warn", "error"] as const).find((x) => x === ls.values.stufe) ?? "all";
  const source = ls.values.quelle;
  const search = ls.values.suche;
  const q = useDebounced(search.trim());
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [sources, setSources] = useState<string[]>([]);

  const logs = useInfiniteQuery({
    queryKey: ["system-logs", level, source, q],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ logs: LogRow[]; sources: string[]; nextBefore: number | null }>(
        `/system/logs${qs({ level, source, q, before: pageParam, limit: 100 })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  useEffect(() => {
    const s = logs.data?.pages[0]?.sources;
    if (s?.length) setSources((prev) => [...new Set([...prev, ...s])].sort());
  }, [logs.data]);
  const rows = logs.data?.pages.flatMap((p) => p.logs) ?? [];
  const filtered = level !== "all" || !!source || !!q;
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex flex-col gap-3">
      <ListToolbar<"all" | "info" | "warn" | "error">
        search={{ value: search, onChange: (v) => ls.set({ suche: v }), placeholder: t("admin.logs.search") }}
        tabs={{ label: t("admin.logs.level"), value: level, onChange: (v) => ls.set({ stufe: v }), options: (["all", "info", "warn", "error"] as const).map((v) => ({ value: v, label: t(`admin.logs.levels.${v}`) })) }}
        filters={[{ key: "quelle", label: t("admin.logs.source"), value: source, onChange: (v) => ls.set({ quelle: v }), allLabel: t("admin.logs.allSources"), options: sources.map((s) => ({ value: s, label: s })) }]}
        onReset={() => ls.reset(["stufe"])}
      />

      <section
        aria-label={t("admin.logs.tabs.system")}
        className="bg-card border border-line rounded-card min-w-0"
      >
        {logs.isError ? (
          <div className="p-4">
            <LoadError error={logs.error} onRetry={() => logs.refetch()} />
          </div>
        ) : logs.isLoading ? (
          <SkeletonRows rows={8} className="p-4" />
        ) : rows.length === 0 ? (
          filtered ? (
            <div className="px-4">
              <FilterEmpty onReset={() => ls.reset()} />
            </div>
          ) : (
            <EmptyState icon="ScrollText" title="Noch keine Meldungen." text="Hier erscheinen Meldungen von Server und Worker." />
          )
        ) : (
          <div className="overflow-x-auto relative">
            <table className="w-full border-collapse text-sm min-w-[720px]">
              <thead>
                <tr>
                  <th className="w-8 border-b border-line" />
                  <th className="text-left text-meta font-medium text-fg-muted py-2.5 px-3 border-b border-line">
                    {t("admin.logs.time")}
                  </th>
                  <th className="text-left text-meta font-medium text-fg-muted py-2.5 px-3 border-b border-line">
                    {t("admin.logs.level")}
                  </th>
                  <th className="text-left text-meta font-medium text-fg-muted py-2.5 px-3 border-b border-line">
                    {t("admin.logs.source")}
                  </th>
                  <th className="text-left text-meta font-medium text-fg-muted py-2.5 px-3 border-b border-line w-full">
                    {t("admin.logs.message")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open.has(r.id);
                  const hasDetails =
                    Object.keys(r.details ?? {}).length > 0 ||
                    !!r.correlation_id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={cx(
                          "align-top transition-colors duration-fast",
                          isOpen ? "bg-raised" : "hover:bg-raised",
                        )}
                      >
                        <td className="pl-2 py-2 border-b border-line">
                          {hasDetails && (
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={t("admin.logs.expand")}
                              onClick={() => toggle(r.id)}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-chip text-fg-muted hover:text-fg hover:bg-card"
                            >
                              <Icon
                                name="ChevronRight"
                                size={14}
                                className={cx(
                                  "transition-transform duration-fast",
                                  isOpen && "rotate-90",
                                )}
                              />
                            </button>
                          )}
                        </td>
                        <td className="py-2.5 px-3 border-b border-line font-mono text-meta tabular whitespace-nowrap text-fg-muted">
                          {fmtDateTime(r.at, { seconds: true })}
                        </td>
                        <td className="py-2.5 px-3 border-b border-line">
                          <Badge tone={LEVEL_TONE[r.level] ?? "neutral"}>
                            {t(`admin.logs.levels.${r.level}`)}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 border-b border-line font-mono text-meta whitespace-nowrap">
                          {r.source}
                        </td>
                        <td className="py-2.5 px-3 border-b border-line break-words">
                          {r.message}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-raised">
                          <td className="border-b border-line" />
                          <td
                            colSpan={4}
                            className="px-3 pb-3 border-b border-line"
                          >
                            <div className="flex flex-col gap-2">
                              {r.correlation_id && (
                                <div className="flex items-center gap-2 flex-wrap text-meta">
                                  <span className="text-fg-muted">
                                    {t("admin.logs.correlation")}:
                                  </span>
                                  <button
                                    type="button"
                                    className="font-mono text-fg-link hover:text-fg"
                                    onClick={() => ls.set({ suche: r.correlation_id! })}
                                    title={t("admin.logs.search")}
                                  >
                                    {r.correlation_id}
                                  </button>
                                  <CopyButton
                                    size="sm"
                                    value={r.correlation_id}
                                  />
                                </div>
                              )}
                              {Object.keys(r.details ?? {}).length > 0 ? (
                                <JsonView
                                  value={r.details}
                                  className="max-h-[320px]"
                                />
                              ) : (
                                <p className="m-0 text-meta text-fg-muted">
                                  {t("admin.logs.noDetails")}
                                </p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {logs.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            icon="ChevronDown"
            loading={logs.isFetchingNextPage}
            onClick={() => logs.fetchNextPage()}
          >
            {t("admin.common.loadMore")}
          </Button>
        </div>
      ) : (
        rows.length > 0 && (
          <p className="m-0 text-center text-meta text-fg-muted">
            {t("admin.logs.end")}
          </p>
        )
      )}
    </div>
  );
}

function AuditLog() {
  // Suche, Person und Ergebnis in der Adresse (#260)
  const ls = useListState({ suche: "", person: "", ergebnis: "all" }, { tabKeys: ["ergebnis"] });
  const search = ls.values.suche;
  const actor = ls.values.person;
  const result = (["all", "ok", "failed", "denied"] as const).find((x) => x === ls.values.ergebnis) ?? "all";
  const q = useDebounced(search.trim());
  const a = useDebounced(actor.trim());
  const audit = useInfiniteQuery({
    queryKey: ["audit", "log", q, a, result],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ events: AuditEvent[]; nextBefore: number | null }>(
        `/audit${qs({ q, actor: a, result, before: pageParam, limit: 100 })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const events = audit.data?.pages.flatMap((p) => p.events) ?? [];
  const filtered = !!q || !!a || result !== "all";
  return (
    <div className="flex flex-col gap-3">
      <ListToolbar<"all" | "ok" | "failed" | "denied">
        search={{ value: search, onChange: (v) => ls.set({ suche: v }), placeholder: t("admin.logs.searchAudit") }}
        tabs={{ label: t("admin.logs.result"), value: result, onChange: (v) => ls.set({ ergebnis: v }), options: (["all", "ok", "failed", "denied"] as const).map((v) => ({ value: v, label: t(`admin.logs.results.${v}`) })) }}
        filters={[{ key: "person", label: t("admin.logs.actorFilter"), type: "text", value: actor, onChange: (v) => ls.set({ person: v }) }]}
        onReset={() => ls.reset(["ergebnis"])}
      />
      <section
        aria-label={t("admin.logs.tabs.audit")}
        className="bg-card border border-line rounded-card min-w-0"
      >
        {audit.isError ? (
          <div className="p-4">
            <LoadError error={audit.error} onRetry={() => audit.refetch()} />
          </div>
        ) : audit.isLoading ? (
          <SkeletonRows rows={8} className="p-4" />
        ) : events.length === 0 ? (
          filtered ? (
            <div className="px-4">
              <FilterEmpty onReset={() => ls.reset()} />
            </div>
          ) : (
            <EmptyState icon="ScrollText" title="Noch keine Einträge." text="Hier erscheinen Änderungen, Anmeldungen und Freigaben." />
          )
        ) : (
          <AuditTable events={events} />
        )}
      </section>
      {audit.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            icon="ChevronDown"
            loading={audit.isFetchingNextPage}
            onClick={() => audit.fetchNextPage()}
          >
            {t("admin.common.loadMore")}
          </Button>
        </div>
      ) : (
        events.length > 0 && (
          <p className="m-0 text-center text-meta text-fg-muted">
            {t("admin.logs.end")}
          </p>
        )
      )}
    </div>
  );
}
