/* Gemeinsame Bausteine der Administrationsseiten (auch von Profil, Aktivitäten, Benachrichtigungen genutzt). */
import { useId, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import type { Preferences } from "../../api/types";
import {
  Badge,
  Button,
  cx,
  ErrorBox,
  Switch,
  type Tone,
} from "../../components/ui/core";
import { CopyButton, useErrorToast } from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import activityDict from "../../i18n/de/activity.json";
import { t } from "../../i18n";
import { useAuth } from "../../lib/auth";

/* ------------------------------------------------------------------------------------------ */
/* Abschnittskarte im Stil der Einstellungsseite: Kopf (Titel + Beschreibung) und Inhalt.        */

export function SectionCard({
  id,
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hid = useId();
  return (
    <section
      id={id}
      aria-labelledby={hid}
      className={cx(
        "bg-card border border-line rounded-card min-w-0 scroll-mt-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap px-5 py-[18px] border-b border-line">
        <div className="min-w-0">
          <h2 id={hid} className="m-0 text-[16px] leading-6 font-semibold">
            {title}
          </h2>
          {description && (
            <p className="m-0 mt-1 text-sm text-fg-muted">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children != null && (
        <div className={cx("px-5 py-[18px]", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/** Feldraster wie im Mockup: auto-fit, min. 260 px */
export function FieldGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Status: Punkt + Text                                                                         */

const STATE_TONE: Record<string, Tone> = {
  ok: "success",
  warning: "warning",
  error: "error",
};
export function StateBadge({
  state,
  label,
}: {
  state: string;
  label?: ReactNode;
}) {
  return (
    <Badge tone={STATE_TONE[state] ?? "neutral"}>
      {label ??
        t(`admin.common.state.${state in STATE_TONE ? state : "warning"}`)}
    </Badge>
  );
}

/** Verständlicher Ladefehler mit „Erneut versuchen“ und technischen Details hinter „Details kopieren“. */
export function LoadError({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: ReactNode;
}) {
  const e = error as ApiError | Error | null;
  const tech = e
    ? `${(e as ApiError).status ?? ""} ${(e as ApiError).code ?? ""} ${e.message}`.trim()
    : "";
  return (
    <ErrorBox
      title={title ?? t("admin.common.loadError")}
      actions={
        <>
          {onRetry && (
            <Button size="sm" icon="RefreshCw" onClick={onRetry}>
              {t("admin.common.retry")}
            </Button>
          )}
          {tech && (
            <CopyButton
              size="sm"
              value={tech}
              label={t("admin.common.copyDetails")}
            />
          )}
        </>
      }
    >
      {e?.message &&
      e.message !== "Failed to fetch" &&
      !/^Fehler \d+$/.test(e.message)
        ? e.message
        : t("admin.common.loadErrorText")}
    </ErrorBox>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Persönliche Darstellung (Einstellungen + Mein Konto)                                          */

/* Vorschaufarben der Farbschemata: bewusst feste Werte (zeigen das jeweils andere Schema). */
const PREVIEW = {
  dark: { side: "#101827", main: "#0B1020", line: "#293449", card: "#151E30" },
  light: { side: "#FFFFFF", main: "#F8FAFC", line: "#E2E8F0", card: "#FFFFFF" },
  system: {
    side: "#101827",
    main: "linear-gradient(90deg,#0B1020 50%,#F8FAFC 50%)",
    line: "#94A3B8",
    card: "#64748B",
  },
} as const;

export function AppearanceFields() {
  const { me, setPreferences } = useAuth();
  const onError = useErrorToast();
  const prefs = me?.user.preferences ?? {};
  const theme = prefs.theme ?? "light";
  const set = (p: Partial<Preferences>) =>
    setPreferences(p).catch((e) => onError(e));
  const ids = ["dark", "light", "system"] as const;
  return (
    <div className="flex flex-col gap-[18px]">
      <div
        role="radiogroup"
        aria-label={t("admin.settings.scheme")}
        className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]"
        onKeyDown={(e) => {
          const i = ids.indexOf(theme);
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            set({ theme: ids[(i + 1) % 3] });
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            set({ theme: ids[(i + 2) % 3] });
          }
        }}
      >
        {ids.map((id) => {
          const on = theme === id;
          const c = PREVIEW[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => set({ theme: id })}
              className={cx(
                "flex flex-col gap-2.5 p-2.5 rounded-node text-left text-sm font-medium transition-colors duration-fast hover:bg-raised",
                on ? "border-[1.5px] border-primary" : "border border-line",
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-[70px] rounded-chip overflow-hidden border border-line"
              >
                <span className="w-[26%]" style={{ background: c.side }} />
                <span
                  className="flex-1 p-2 flex flex-col gap-[5px]"
                  style={{ background: c.main }}
                >
                  <span
                    className="h-[7px] w-1/2 rounded-[2px]"
                    style={{ background: c.line }}
                  />
                  <span
                    className="h-5 rounded-[4px]"
                    style={{ background: c.card }}
                  />
                  <span
                    className="h-[7px] w-3/4 rounded-[2px]"
                    style={{ background: c.line }}
                  />
                </span>
              </span>
              <span className="flex items-center gap-2">
                {on && (
                  <Icon
                    name="CheckCircle2"
                    size={14}
                    className="text-fg-link"
                  />
                )}
                {t(`admin.settings.themes.${id}`)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        <Switch
          checked={!!prefs.reducedMotion}
          onChange={(v) => set({ reducedMotion: v })}
          label={t("admin.settings.reducedMotion")}
          description={t("admin.settings.reducedMotionDesc")}
        />
        <Switch
          checked={!!prefs.compactTables}
          onChange={(v) => set({ compactTables: v })}
          label={t("admin.settings.compact")}
          description={t("admin.settings.compactDesc")}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Audit-Ereignisse lesbar machen                                                               */

export interface AuditEvent {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string;
  actor_type: "user" | "api_key" | "system";
  action: string;
  object_type: string | null;
  object_id: string | null;
  object_label: string | null;
  result: "ok" | "failed" | "denied";
  details: Record<string, unknown>;
  ip: string | null;
  correlation_id: string | null;
}

function dictLookup(path: string): string | null {
  const v = path
    .split(".")
    .reduce<any>((o, k) => (o == null ? undefined : o[k]), activityDict);
  return typeof v === "string" ? v : null;
}

/** „post.approved“ → „Fassung freigegeben“; unbekannte Aktionen roh. */
export function auditLabel(action: string): string {
  return dictLookup(`actions.${action}`) ?? action;
}

/** Satzteil nach dem Namen: „hat „X“ freigegeben“. */
export function auditSentence(
  ev: Pick<AuditEvent, "action" | "object_label">,
): string {
  const tpl = dictLookup(`sentences.${ev.action}`);
  if (!tpl)
    return (
      t("activity.fallback", { action: ev.action }) +
      (ev.object_label ? ` („${ev.object_label}“)` : "")
    );
  if (!ev.object_label)
    return tpl.replace(/ ?„\{o\}“/g, "").replace(/\{o\}/g, "");
  return tpl.split("{o}").join(ev.object_label);
}

/** Link zum Objekt eines Audit-Ereignisses, wo sinnvoll. */
export function auditHref(
  ev: Pick<AuditEvent, "object_type" | "object_id" | "action" | "details">,
): string | null {
  const id = ev.object_id;
  const deleted = ev.action.endsWith(".deleted");
  switch (ev.object_type) {
    case "post":
      return id ? `/beitraege/${id}` : "/beitraege";
    case "collection":
      return id ? `/medien/${id}` : "/medien";
    case "site":
      return "/kanaele";
    case "user":
      return "/benutzer";
    case "backup":
      return "/einstellungen#sicherung";
    case "settings":
      return "/einstellungen";
    default:
      return null;
  }
}

/** Bereich (für Filter in Aktivitäten) */
export function auditArea(
  ev: Pick<AuditEvent, "action" | "object_type">,
): string {
  const p = ev.action.split(".")[0];
  if (["post", "publication"].includes(p)) return "editorial";
  if (["collection", "upload_link", "media"].includes(p)) return "media";
  if (p === "site") return "channels";
  if (["user", "auth", "setup"].includes(p)) return "user";
  return "system";
}

export function actorDisplay(
  ev: Pick<AuditEvent, "actor_name" | "actor_type">,
): string {
  if (ev.actor_type === "system") return ev.actor_name || t("activity.system");
  return ev.actor_name;
}

/** Ergebnis eines Audit-Ereignisses als Badge (nur wenn nicht ok – sonst Häkchen-Text). */
export function AuditResult({ result }: { result: AuditEvent["result"] }) {
  if (result === "ok")
    return <Badge tone="success">{t("admin.logs.results.ok")}</Badge>;
  if (result === "denied")
    return <Badge tone="warning">{t("admin.logs.results.denied")}</Badge>;
  return <Badge tone="error">{t("admin.logs.results.failed")}</Badge>;
}
