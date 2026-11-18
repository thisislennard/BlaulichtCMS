import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api/client";
import {
  Button,
  cx,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonRows,
} from "../components/ui/core";
import { FilterEmpty } from "../components/ui/list";
import { useErrorToast, useToast } from "../components/ui/overlays";
import { Icon } from "../components/ui/Icon";
import { t } from "../i18n";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { resolvedText } from "./approvals/model";
import { useListState } from "../lib/listState";
import { LoadError } from "./admin/shared";

interface Notification {
  id: number;
  created_at: string;
  /** gebündelte Meldungen (Medien, Freigaben) werden aktualisiert */
  updated_at: string | null;
  kind: "error" | "warning" | "info" | "success";
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  /** Filtergruppe (#253): approvals, publishing, press, warnings, media, workflows, system */
  group: string;
  count: number;
  /** Erledigte Freigabe-Anfrage (#253): zählt nicht als ungelesen, ausgegraut mit Vermerk */
  resolved_at: string | null;
  resolved_note: string | null;
}

interface NotificationList {
  notifications: Notification[];
  unread: number;
  groups: { id: string; label: string }[];
}

const KIND: Record<Notification["kind"], { icon: string; tile: string }> = {
  error: { icon: "XCircle", tile: "bg-err-soft text-err" },
  warning: { icon: "AlertTriangle", tile: "bg-warn-soft text-warn" },
  info: { icon: "Info", tile: "bg-raised text-fg-muted" },
  success: { icon: "CheckCircle2", tile: "bg-ok-soft text-ok" },
};

export default function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const onError = useErrorToast();
  // gleicher Schlüssel wie die Glocke in der Kopfzeile → Zähler bleibt synchron
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => get<NotificationList>("/notifications"),
    refetchInterval: 30_000,
  });
  // Filter in der Adresse (#253, wie alle Listen #260): ?anzeigen=ungelesen&art=freigaben
  const state = useListState({ anzeigen: "alle", art: "" });
  const filter = state.values.anzeigen === "ungelesen" ? "unread" : "all";
  const setFilter = (v: "unread" | "all") =>
    state.set({ anzeigen: v === "unread" ? "ungelesen" : "alle" });
  const list = q.data?.notifications ?? [];
  const groups = q.data?.groups ?? [];
  const art = groups.some((g) => g.id === state.values.art)
    ? state.values.art
    : "";
  const ofGroup = art ? list.filter((n) => n.group === art) : list;
  const shown = filter === "unread" ? ofGroup.filter((n) => !n.read) : ofGroup;
  const unread = q.data?.unread ?? 0;
  // Anzahl je Gruppe für die Auswahl; Gruppen ohne Meldung erscheinen nicht
  const perGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n.group, (m.get(n.group) ?? 0) + 1);
    return m;
  }, [list]);

  const markLocal = (ids: number[] | "all") =>
    qc.setQueryData<NotificationList>(
      ["notifications"],
      (old) => {
        if (!old) return old;
        const notifications = old.notifications.map((n) =>
          ids === "all" || ids.includes(n.id) ? { ...n, read: true } : n,
        );
        return {
          ...old,
          notifications,
          unread: notifications.filter((n) => !n.read).length,
        };
      },
    );

  const markRead = async (ids: number[]) => {
    markLocal(ids);
    try {
      await post("/notifications/read", { ids });
    } catch (e) {
      onError(e);
    } finally {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    }
  };
  const markAll = async () => {
    markLocal("all");
    try {
      await post("/notifications/read", { all: true });
      toast({
        tone: "success",
        title: t("activity.notifications.markAllDone"),
      });
    } catch (e) {
      onError(e);
    } finally {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    }
  };
  const open = (n: Notification) => {
    if (!n.read) markRead([n.id]);
    if (n.link) {
      if (/^https?:\/\//.test(n.link))
        window.open(n.link, "_blank", "noopener");
      else navigate(n.link);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-[900px]">
      <PageHeader
        subtitle={t("activity.notifications.subtitle")}
        actions={
          <Button icon="Check" disabled={!unread} onClick={markAll}>
            {t("activity.notifications.markAll")}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={t("activity.notifications.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            {
              value: "all",
              label: t("activity.notifications.all"),
              count: ofGroup.length,
            },
            {
              value: "unread",
              label: t("activity.notifications.unread"),
              count: ofGroup.filter((n) => !n.read).length,
            },
          ]}
        />
        {groups.length > 0 && (
          <div className="flex items-center gap-2 min-w-0">
            <label
              htmlFor="notif-art"
              className="text-sm font-medium text-fg-muted shrink-0"
            >
              {t("activity.notifications.group")}
            </label>
            <Select
              id="notif-art"
              value={art}
              onChange={(e) => state.set({ art: e.target.value })}
              className="w-auto"
            >
              <option value="">
                {t("activity.notifications.allGroups")} ({list.length})
              </option>
              {groups
                .filter((g) => perGroup.has(g.id) || g.id === art)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label} ({perGroup.get(g.id) ?? 0})
                  </option>
                ))}
            </Select>
          </div>
        )}
      </div>
      <section
        aria-label={t("activity.notifications.title")}
        className="bg-card border border-line rounded-card min-w-0"
      >
        {q.isError ? (
          <div className="p-4">
            <LoadError
              error={q.error}
              title={t("activity.notifications.loadError")}
              onRetry={() => q.refetch()}
            />
          </div>
        ) : !q.data ? (
          <SkeletonRows rows={5} className="p-4" />
        ) : shown.length === 0 && art ? (
          <div className="px-4">
            <FilterEmpty
              text={t("activity.notifications.emptyGroup")}
              onReset={() => state.reset()}
            />
          </div>
        ) : shown.length === 0 ? (
          filter === "unread" && list.length ? (
            <EmptyState
              icon="CheckCircle2"
              title={t("activity.notifications.emptyUnread")}
              text={t("activity.notifications.emptyUnreadText")}
              action={
                <Button onClick={() => setFilter("all")}>
                  {t("activity.notifications.showAll")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon="Bell"
              title={t("activity.notifications.empty")}
              text={t("activity.notifications.emptyText")}
            />
          )
        ) : (
          <ul className="list-none m-0 p-0">
            {shown.map((n) => {
              const k = KIND[n.kind] ?? KIND.info;
              return (
                <li
                  key={n.id}
                  className="border-b border-line last:border-b-0 flex items-stretch"
                >
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={cx(
                      "flex-1 min-w-0 flex items-start gap-3 px-4 py-3.5 text-left transition-colors duration-fast hover:bg-raised",
                      !n.read && "bg-raised/60",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        "w-8 h-8 rounded-control inline-flex items-center justify-center shrink-0",
                        k.tile,
                      )}
                    >
                      <Icon name={k.icon} size={15} />
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={cx(
                            "text-sm truncate",
                            n.read
                              ? "font-medium text-fg-muted"
                              : "font-semibold",
                          )}
                        >
                          {n.title}
                        </span>
                        <span className="sr-only">
                          · {t(`activity.notifications.kinds.${n.kind}`)}
                          {!n.read &&
                            ` · ${t("activity.notifications.unreadLabel")}`}
                        </span>
                      </span>
                      {n.body && (
                        <span className="text-sm text-fg-muted break-words line-clamp-2">
                          {n.body}
                        </span>
                      )}
                      {n.resolved_at && (
                        <span className="text-meta text-fg-muted inline-flex items-center gap-1">
                          <Icon
                            name="CheckCircle2"
                            size={13}
                            className="shrink-0"
                          />
                          {resolvedText(n)}
                        </span>
                      )}
                      <span
                        className="text-meta text-fg-muted"
                        title={fmtDateTime(n.updated_at ?? n.created_at)}
                      >
                        {t(`activity.notifications.kinds.${n.kind}`)} ·{" "}
                        {fmtRelative(n.updated_at ?? n.created_at)}
                      </span>
                    </span>
                    {!n.read && (
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full bg-primary mt-2 shrink-0"
                      />
                    )}
                    {n.link && (
                      <Icon
                        name="ChevronRight"
                        size={16}
                        className="text-fg-muted mt-2 shrink-0"
                      />
                    )}
                  </button>
                  {!n.read && (
                    <button
                      type="button"
                      aria-label={`${t("activity.notifications.markRead")}: ${n.title}`}
                      title={t("activity.notifications.markRead")}
                      onClick={() => markRead([n.id])}
                      className="w-11 shrink-0 inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-raised border-l border-line"
                    >
                      <Icon name="Check" size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
