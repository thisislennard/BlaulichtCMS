import { useEffect, useMemo, useState } from "react";
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
  SkeletonRows,
  EmptyLine,
  EmptyAction,
} from "../components/ui/core";
import { FilterEmpty, ListToolbar } from "../components/ui/list";
import { useListState } from "../lib/listState";
import { Icon } from "../components/ui/Icon";
import { t } from "../i18n";
import { fmtDate, fmtDateTime, fmtTime, getTimeZone } from "../lib/format";
import {
  actorDisplay,
  auditHref,
  auditSentence,
  LoadError,
  type AuditEvent,
} from "./admin/shared";

/**
 * Bereiche wie die Module der Navigation (#258); die Zuordnung der Aktionen und der Filter liegen beim Server
 * (server/src/lib/audit-view.ts), damit „Ältere laden“ im Bereich vollständig ist.
 */
const AREAS = [
  "all",
  "editorial",
  "calendar",
  "media",
  "incidents",
  "banners",
  "designs",
  "press",
  "warnings",
  "channels",
  "automations",
  "user",
  "system",
] as const;
type Area = (typeof AREAS)[number];
/** Routine-Anmeldungen nur im Bereich „Benutzer & Anmeldung“, sonst überdecken sie die Änderungen. */
const NOISE = new Set(["auth.login", "auth.logout", "auth.mfa"]);

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
  // Suche, Bereich und Ergebnis in der Adresse (?bereich=press&suche=… #258, #260), damit sich ein gefilterter Stand
  // verlinken lässt und Zurück ihn wiederherstellt
  const ls = useListState({ suche: "", bereich: "", ergebnis: "" });
  const area: Area = AREAS.includes(ls.values.bereich as Area) ? (ls.values.bereich as Area) : "all";
  const setArea = (a: Area) => ls.set({ bereich: a === "all" ? "" : a });
  const result = ["failed", "denied"].includes(ls.values.ergebnis) ? ls.values.ergebnis : "";
  const [term, setTerm] = useState(ls.values.suche.trim());
  useEffect(() => {
    const h = setTimeout(() => setTerm(ls.values.suche.trim()), 300);
    return () => clearTimeout(h);
  }, [ls.values.suche]);
  const q = useInfiniteQuery({
    queryKey: ["audit", "feed", area, term, result],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ events: AuditEvent[]; nextBefore: number | null }>(
        `/audit${qs({ area: area === "all" ? undefined : area, q: term || undefined, result: result || undefined, before: pageParam, limit: 100 })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const events = useMemo(
    () =>
      (q.data?.pages.flatMap((p) => p.events) ?? []).filter(
        (e) => area !== "all" || !!term || !NOISE.has(e.action),
      ),
    [q.data, area, term],
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
      <div className="flex flex-col gap-1.5">
        <ListToolbar
          search={{ value: ls.values.suche, onChange: (v) => ls.set({ suche: v }), placeholder: "Suchen in Aktivitäten", label: "Aktivitäten durchsuchen (Person, Objekt, Aktion)" }}
          filters={[
            { key: "bereich", label: t("activity.areaLabel"), value: area === "all" ? "" : area, onChange: (v) => setArea((v || "all") as Area), allLabel: t("activity.areas.all"), options: AREAS.filter((a) => a !== "all").map((a) => ({ value: a, label: t(`activity.areas.${a}`) })) },
            { key: "ergebnis", label: "Ergebnis", value: result, onChange: (v) => ls.set({ ergebnis: v }), allLabel: "Alle Ergebnisse", options: [{ value: "failed", label: t("activity.failed") }, { value: "denied", label: t("activity.denied") }] },
          ]}
          onReset={() => ls.reset()}
        />
        {area === "all" && !term && (
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
      ) : groups.length === 0 && (term || result) && !q.hasNextPage ? (
        <FilterEmpty onReset={() => ls.reset()} />
      ) : groups.length === 0 ? (
        <div className="bg-card border border-line rounded-card">
          {area === "all" && !term && !result ? (
            <EmptyState
              icon="Activity"
              title={t("activity.empty")}
              text={t("activity.emptyText")}
            />
          ) : (
            <EmptyLine
              className="p-4"
              action={
                q.hasNextPage ? (
                  <EmptyAction onClick={() => q.fetchNextPage()}>{t("activity.loadMore")}</EmptyAction>
                ) : (
                  <EmptyAction onClick={() => ls.reset()}>{t("activity.showAll")}</EmptyAction>
                )
              }
            >
              {t("activity.emptyFiltered")}.
            </EmptyLine>
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
      {!href && ev.object_exists === false && (
        <span className="shrink-0 text-meta text-fg-muted h-7 inline-flex items-center px-2">
          {t("activity.gone")}
        </span>
      )}
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
