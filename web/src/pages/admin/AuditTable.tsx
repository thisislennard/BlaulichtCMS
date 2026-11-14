import { Link } from "react-router";
import { Avatar, cx, hashTone, Table, Td, Th } from "../../components/ui/core";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import {
  actorDisplay,
  auditHref,
  auditLabel,
  AuditResult,
  type AuditEvent,
} from "./shared";

/** Tabelle von Audit-Ereignissen: Zeit, Person, Aktion (übersetzt), Objekt, Ergebnis, IP. Zeigt nie Details-Inhalte mit Geheimnissen. */
export function AuditTable({
  events,
  showIp = true,
}: {
  events: AuditEvent[];
  showIp?: boolean;
}) {
  return (
    <Table className="relative -mx-px">
      <thead>
        <tr>
          <Th>{t("admin.logs.time")}</Th>
          <Th>{t("admin.logs.actor")}</Th>
          <Th>{t("admin.logs.action")}</Th>
          <Th>{t("admin.logs.object")}</Th>
          <Th>{t("admin.logs.result")}</Th>
          {showIp && <Th>{t("admin.logs.ip")}</Th>}
        </tr>
      </thead>
      <tbody>
        {events.map((ev) => {
          const href = auditHref(ev);
          const label = auditLabel(ev.action);
          return (
            <tr
              key={ev.id}
              className="hover:bg-raised transition-colors duration-fast"
            >
              <Td mono className="whitespace-nowrap">
                <span title={fmtDateTime(ev.at, { seconds: true })}>
                  {fmtDateTime(ev.at, { seconds: true })}
                </span>
                <span className="block text-fg-muted font-sans text-[11px]">
                  {fmtRelative(ev.at)}
                </span>
              </Td>
              <Td>
                <span className="flex items-center gap-2 min-w-0">
                  {ev.actor_type === "user" ? (
                    <Avatar
                      name={ev.actor_name}
                      size={24}
                      tone={hashTone(ev.actor_name)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="w-6 h-6 rounded-full bg-raised inline-flex items-center justify-center text-fg-muted shrink-0"
                    >
                      <Icon
                        name={
                          ev.actor_type === "api_key" ? "KeyRound" : "Server"
                        }
                        size={13}
                      />
                    </span>
                  )}
                  <span className="truncate max-w-[180px]">
                    {actorDisplay(ev)}
                  </span>
                  {ev.actor_type === "api_key" && (
                    <span className="text-meta text-fg-muted">
                      · {t("activity.apiKey")}
                    </span>
                  )}
                </span>
              </Td>
              <Td>
                <span className="font-medium">{label}</span>
                {label !== ev.action && (
                  <span className="block font-mono text-[11px] text-fg-muted">
                    {ev.action}
                  </span>
                )}
              </Td>
              <Td className="max-w-[260px]">
                {ev.object_label ? (
                  href ? (
                    <Link
                      to={href}
                      className="truncate inline-block max-w-full align-bottom"
                    >
                      {ev.object_label}
                    </Link>
                  ) : (
                    <span className="truncate inline-block max-w-full align-bottom">
                      {ev.object_label}
                    </span>
                  )
                ) : (
                  <span className="text-fg-muted">–</span>
                )}
              </Td>
              <Td>
                <AuditResult result={ev.result} />
              </Td>
              {showIp && (
                <Td
                  mono
                  className={cx("whitespace-nowrap", !ev.ip && "text-fg-muted")}
                >
                  {ev.ip ?? "–"}
                </Td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
