import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { get, qs } from "../api/client";
import {
  Avatar,
  Badge,
  Button,
  cx,
  EmptyState,
  PageHeader,
  SegmentedControl,
  SkeletonRows,
} from "../components/ui/core";
import { Icon } from "../components/ui/Icon";
import { t } from "../i18n";
import { fmtDate, fmtDateTime, fmtTime, getTimeZone } from "../lib/format";
import {
  actorDisplay,
  auditArea,
  auditHref,
  auditSentence,
  LoadError,
  type AuditEvent,
} from "./admin/shared";

const AREAS = [
  "all",
  "editorial",
  "media",
  "channels",
  "warnings",
  "user",
  "system",
] as const;
type Area = (typeof AREAS)[number];
/** Routine-Anmeldungen nur im Bereich „Benutzer & Anmeldung“, sonst überdecken sie die Änderungen. */
const NOISE = new Set(["auth.login", "auth.logout", "auth.mfa"]);

/** Serverseitiger Suchbegriff je Bereich (ILIKE auf action/objekt/person) – Feinfilter danach im Client. */
const AREA_QUERY: Partial<Record<Area, string>> = {};

function dayKey(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayLabel(iso: string) {
  const k = dayKey(iso);
  if (k === dayKey(new Date().toISOString())) return t("activity.today");
  if (k === dayKey(new Date(Date.now() - 86_400_000).toISOString()))
    return t("activity.yesterday");
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: getTimeZone(),
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

export default function Activities() {
  const [area, setArea] = useState<Area>("all");
  const q = useInfiniteQuery({
    queryKey: ["audit", "feed", area],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ events: AuditEvent[]; nextBefore: number | null }>(
        `/audit${qs({ q: AREA_QUERY[area], before: pageParam, limit: 100 })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const events = useMemo(
    () =>
      (q.data?.pages.flatMap((p) => p.events) ?? []).filter((e) =>
        area === "all" ? !NOISE.has(e.action) : auditArea(e) === area,
      ),
    [q.data, area],
  );
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: AuditEvent[] }[] = [];
    for (const e of events) {
      const k = dayKey(e.at);
      const last = out[out.length - 1];
      if (last?.key === k) last.items.push(e);
      else out.push({ key: k, label: dayLabel(e.at), items: [e] });
    }
    return out;
  }, [events]);

  return (
    <div className="flex flex-col gap-5 max-w-[960px]">
      <PageHeader
        subtitle={t("activity.subtitle")}
      />
      <div className="flex flex-col items-start gap-1.5">
        <SegmentedControl
          label={t("activity.areaLabel")}
          value={area}
          onChange={setArea}
          options={AREAS.map((a) => ({
            value: a,
            label: t(`activity.areas.${a}`),
          }))}
        />
        {area === "all" && (
          <p className="m-0 text-meta text-fg-muted">
            {t("activity.hideLogins")}
          </p>
        )}
      </div>

      {q.isError ? (
        <LoadError
          error={q.error}
          title={t("activity.loadError")}
          onRetry={() => q.refetch()}
        />
      ) : q.isLoading ? (
        <div className="bg-card border border-line rounded-card p-4">
          <SkeletonRows rows={7} />
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-card border border-line rounded-card">
          {area === "all" ? (
            <EmptyState
              icon="Activity"
              title={t("activity.empty")}
              text={t("activity.emptyText")}
            />
          ) : (
            <EmptyState
              icon="Filter"
              title={t("activity.emptyFiltered")}
              text={
                q.hasNextPage
                  ? t("activity.emptyFilteredText")
                  : t("activity.emptyFilteredText")
              }
              action={
                q.hasNextPage ? (
                  <Button
                    loading={q.isFetchingNextPage}
                    onClick={() => q.fetchNextPage()}
                  >
                    {t("activity.loadMore")}
                  </Button>
                ) : (
                  <Button onClick={() => setArea("all")}>
                    {t("activity.showAll")}
                  </Button>
                )
              }
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section
              key={g.key}
              aria-labelledby={`day-${g.key}`}
              className="flex flex-col gap-2"
            >
              <h2
                id={`day-${g.key}`}
                className="m-0 font-mono text-label uppercase text-fg-muted px-1"
              >
                {g.label}
              </h2>
              <ol className="list-none m-0 p-0 bg-card border border-line rounded-card">
                {g.items.map((e) => (
                  <FeedItem key={e.id} ev={e} />
                ))}
              </ol>
            </section>
          ))}
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button
                icon="ChevronDown"
                loading={q.isFetchingNextPage}
                onClick={() => q.fetchNextPage()}
              >
                {t("activity.loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FeedItem({ ev }: { ev: AuditEvent }) {
  const href = auditHref(ev);
  const who = actorDisplay(ev);
  const sentence = auditSentence(ev);
  return (
    <li className="flex items-start gap-3 px-4 py-3 border-b border-line last:border-b-0">
      {ev.actor_type === "user" ? (
        <Avatar name={who} size={32} />
      ) : (
        <span
          aria-hidden="true"
          className="w-8 h-8 rounded-full bg-raised inline-flex items-center justify-center text-fg-muted shrink-0"
        >
          <Icon
            name={ev.actor_type === "api_key" ? "KeyRound" : "Server"}
            size={15}
          />
        </span>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <p className="m-0 text-sm break-words">
          <span className="font-semibold">{who}</span>
          {ev.actor_type === "api_key" && (
            <span className="text-fg-muted"> ({t("activity.apiKey")})</span>
          )}{" "}
          {sentence}
          {ev.result !== "ok" && (
            <>
              {" "}
              <Badge
                tone={ev.result === "denied" ? "warning" : "error"}
                className="align-middle"
              >
                {t(
                  ev.result === "denied"
                    ? "activity.denied"
                    : "activity.failed",
                )}
              </Badge>
            </>
          )}
        </p>
        <span className="text-meta text-fg-muted">
          <time
            dateTime={ev.at}
            title={fmtDateTime(ev.at, { seconds: true })}
            className="font-mono tabular"
          >
            {fmtTime(ev.at)}
          </time>
          {ev.ip && <span className="font-mono"> · {ev.ip}</span>}
          <span className="sr-only"> · {fmtDate(ev.at)}</span>
        </span>
      </div>
      {href && (
        <Link
          to={href}
          className={cx(
            "shrink-0 inline-flex items-center gap-1 text-meta h-7 px-2 rounded-chip hover:bg-raised",
          )}
          aria-label={`${t("activity.open")}: ${ev.object_label ?? sentence}`}
        >
          {t("activity.open")}
          <Icon name="ChevronRight" size={13} />
        </Link>
      )}
    </li>
  );
}
