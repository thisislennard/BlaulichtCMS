/* Gemeinsame Bausteine der Administrationsseiten (auch von Profil, Aktivitäten, Benachrichtigungen genutzt). */
import { useId, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { FEEDBACK, feedbackFor } from "../../components/feedback/Feedback";
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
  // Zeitüberschreitung, offline, Wartung, keine Berechtigung … mit eigenem Titel und Text (#194)
  const fb = feedbackFor(error);
  const known = fb.kind !== "error";
  const tech = e
    ? `${(e as ApiError).status ?? ""} ${(e as ApiError).code ?? ""} ${e.message}`.trim()
    : "";
  return (
    <ErrorBox
      title={title ?? (known ? FEEDBACK[fb.kind].title : t("admin.common.loadError"))}
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
      {known
        ? fb.message ?? FEEDBACK[fb.kind].text
        : e?.message &&
      e.message !== "Failed to fetch" &&
      !/^Fehler \d+$/.test(e.message)
        ? e.message
        : t("admin.common.loadErrorText")}
    </ErrorBox>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Persönliche Darstellung (Einstellungen + Mein Konto)                                          */

/* Vorschau der Farbmodi im Leitstand-Aufbau (Kopfzeile oben, Karten darunter).
   Bewusst feste Werte aus tokens.css: Jede Kachel zeigt das jeweilige Schema, unabhängig vom aktiven Modus. */
const LIGHT = { bg: "#F6F7F9", card: "#FFFFFF", line: "#DDE1E6", text: "#111418", red: "#D21F3C" };
const DARK = { bg: "#0E0F12", card: "#16181C", line: "#2C3037", text: "#EEF0F3", red: "#FF5A6E" };

function ThemeMini({ c }: { c: typeof LIGHT }) {
  return (
    <span className="flex-1 flex flex-col" style={{ background: c.bg }}>
      <span className="h-[14px] flex items-center gap-[4px] px-[6px]" style={{ background: c.card, borderBottom: `1px solid ${c.line}` }}>
        <span className="w-[6px] h-[6px] rounded-[2px]" style={{ background: c.red }} />
        <span className="h-[3px] w-[18px] rounded-[2px]" style={{ background: c.text, opacity: 0.7 }} />
        <span className="h-[3px] w-[12px] rounded-[2px]" style={{ background: c.line }} />
      </span>
      <span className="flex-1 p-[6px] flex flex-col gap-[4px]">
        <span className="h-[5px] w-1/2 rounded-[2px]" style={{ background: c.text, opacity: 0.8 }} />
        <span className="flex-1 rounded-[4px] p-[4px] flex flex-col gap-[3px]" style={{ background: c.card, border: `1px solid ${c.line}` }}>
          <span className="h-[3px] w-3/4 rounded-[2px]" style={{ background: c.line }} />
          <span className="h-[6px] w-[22px] rounded-[2px] mt-auto" style={{ background: c.red }} />
        </span>
      </span>
    </span>
  );
}

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
                {id !== "dark" && <ThemeMini c={LIGHT} />}
                {id !== "light" && <ThemeMini c={DARK} />}
              </span>
              <span className="flex items-center gap-2">
                {on && (
                  <Icon
                    name="CheckCircle2"
                    size={14}
                    className="text-primary"
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
  /** Bereich für den Filter der Aktivitäten (server/src/lib/audit-view.ts, #258) */
  area?: string;
  /** Gibt es das Objekt noch? null = Objektart ohne eigene Seite */
  object_exists?: boolean | null;
  /** Sammlung bei Dateien, Ordnern und Upload-Links */
  object_parent?: string | null;
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

/**
 * Link zum Objekt eines Audit-Ereignisses (#258): direkt auf den Eintrag, solange es ihn gibt (`object_exists` vom
 * Server); ist er gelöscht, gibt es keinen Link. Objektarten ohne eigene Seite verweisen auf ihre Übersicht.
 */
export function auditHref(
  ev: Pick<AuditEvent, "object_type" | "object_id" | "action"> &
    Partial<Pick<AuditEvent, "object_exists" | "object_parent">>,
): string | null {
  if (ev.object_exists === false) return null;
  const id = ev.object_id ? encodeURIComponent(ev.object_id) : null;
  const parent = ev.object_parent ? encodeURIComponent(ev.object_parent) : null;
  const a = ev.action;
  switch (ev.object_type) {
    case "post":
      return id ? `/beitraege/${id}` : "/beitraege";
    case "collection":
      return id ? `/medien/${id}` : "/medien";
    case "media":
      return id ? `/medien/dateien?datei=${id}` : "/medien/dateien";
    case "folder":
      return parent ? `/medien/${parent}?ordner=${id}` : "/medien";
    case "upload_link":
      return parent ? `/medien/${parent}` : "/medien";
    case "trash":
      return "/medien/papierkorb";
    case "design":
    case "design_image":
      return "/upload-seite";
    case "job":
      return "/medienverwaltung";
    case "calendar_event":
      return id ? `/kalender?termin=${id}` : "/kalender";
    case "calendar_category":
    case "calendar_source":
    case "calendar_feed":
      return "/kalender";
    case "incident":
      return id ? `/einsatzliste?eintrag=${id}` : "/einsatzliste";
    case "banner":
      return id ? `/banner?banner=${id}` : "/banner";
    case "design_template":
      return id ? `/designvorlagen/${id}` : "/designvorlagen";
    case "template_category":
    case "design_font":
      return "/designvorlagen";
    case "press_request":
      return id ? `/presse/${id}` : "/presse";
    case "press_release":
      return id ? `/presse/mitteilungen?id=${id}` : "/presse/mitteilungen";
    case "press_contact":
    case "press_list":
      return "/presse/verteiler";
    case "press_snippet":
      return "/presse/textbausteine";
    case "warning":
      return id ? `/warnungen/${id}` : "/warnungen";
    case "keyword":
    case "rule":
    case "responsibility":
      return "/stichwoerter-regeln";
    case "official_warning":
      return "/amtliche-warnungen";
    case "template":
      return a.startsWith("warning.") ? "/stichwoerter-regeln" : "/beitragsvorlagen";
    case "site":
    case "plugin":
      return "/websites";
    case "connection":
      return id ? `/verbindungen/${id}` : "/verbindungen";
    case "rss_feed":
      return "/quellen";
    case "automation":
      return id ? `/workflows/${id}` : "/workflows";
    case "automation_input":
      return "/workflows/ausloeser";
    case "automation_output":
      return "/workflows/aktionen";
    case "user":
      return a.startsWith("notify.push_") ? "/profil" : "/benutzer";
    case "role":
      return "/benutzer?tab=rollen";
    case "backup":
      return "/einstellungen#sicherung";
    case "update":
      return "/einstellungen#updates";
    case "settings":
      if (a.startsWith("warning.")) return "/stichwoerter-regeln";
      if (a.startsWith("press.mailbox")) return "/presse-postfach";
      if (a.startsWith("notify.")) return "/einstellungen#benachrichtigungen";
      if (a.startsWith("updates.")) return "/einstellungen#updates";
      if (a.startsWith("dashboard.")) return "/";
      return "/einstellungen";
    case "privacy":
    case "press_recipient":
      return "/datenschutz-anfragen";
    default:
      return null;
  }
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
