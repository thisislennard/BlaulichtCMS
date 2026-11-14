import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, download, get, patch, post } from "../../api/client";
import {
  Badge,
  Button,
  cx,
  ErrorBox,
  FieldWrap,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
  Switch,
  Table,
  Td,
  Textarea,
  Th,
} from "../../components/ui/core";
import { CopyButton, useToast } from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import { useAuth } from "../../lib/auth";
import {
  fmtBytes,
  fmtDateTime,
  fmtNumber,
  fmtRelative,
} from "../../lib/format";
import { AppearanceFields, FieldGrid, LoadError, SectionCard } from "./shared";
import { fmtUptime, useSystemStatus } from "./SystemStatus";

type Values = Record<string, any>;
interface SettingsResponse {
  settings: Values;
  env: {
    publicUrl: string | null;
    cookieSecure: boolean;
    trustProxy: boolean;
    dataDir: string;
  };
}
interface Backup {
  id: string;
  file_name: string;
  size_bytes: number | null;
  status: "running" | "ok" | "failed";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  trigger: string;
  created_by_name: string | null;
}

const SECTIONS = [
  "allgemein",
  "darstellung",
  "redaktion",
  "medien",
  "betrieb",
  "sicherheit",
  "sicherung",
  "ueber",
] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function Settings() {
  const { can } = useAuth();
  const manage = can("system.manage");
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<SettingsResponse>("/settings"),
  });
  const [draft, setDraft] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recipientsText, setRecipientsText] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && !draft) setDraft({ ...q.data.settings });
  }, [q.data, draft]);

  const server = q.data?.settings;
  const changed = useMemo(
    () =>
      server && draft
        ? Object.keys(draft).filter((k) => !same(draft[k], server[k]))
        : [],
    [server, draft],
  );
  const dirty = changed.length > 0;

  // Warnung beim Verlassen mit ungespeicherten Änderungen
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);

  const set = (k: string, v: unknown) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  const invalidNumbers =
    !!draft &&
    Object.entries(draft).some(
      ([k, x]) =>
        typeof server?.[k] === "number" &&
        (x === "" || !Number.isFinite(Number(x))),
    );
  const badRecipients =
    (draft?.["notify.email_recipients"] as string[] | undefined)?.filter(
      (x) => !EMAIL_RE.test(x),
    ) ?? [];

  const save = async () => {
    if (!draft || !server) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, draft[k]]));
      await patch("/settings", body);
      const fresh = await qc.fetchQuery({
        queryKey: ["settings"],
        queryFn: () => get<SettingsResponse>("/settings"),
      });
      setDraft({ ...fresh.settings });
      setRecipientsText(null);
      qc.invalidateQueries({ queryKey: ["me"] });
      toast({ tone: "success", title: t("admin.settings.saveOk") });
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    if (server) setDraft({ ...server });
    setRecipientsText(null);
    setSaveError(null);
  };

  /* Abschnittsnavigation: aktiver Abschnitt + Anker aus der URL */
  const loc = useLocation();
  const [active, setActive] = useState<string>(SECTIONS[0]);
  const ready = !!draft;
  useEffect(() => {
    if (!ready) return;
    const id = decodeURIComponent(loc.hash.replace("#", ""));
    if (id)
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ block: "start" }),
      );
  }, [ready, loc.hash]);
  useEffect(() => {
    if (!ready) return;
    const els = SECTIONS.map((s) => document.getElementById(s)).filter(
      Boolean,
    ) as HTMLElement[];
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [ready]);

  const v = draft ?? {};
  const ro = !manage;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("admin.settings.title")}
        subtitle={t("admin.settings.subtitle")}
      />
      {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}
      <div className="flex gap-7 flex-col xl:flex-row xl:items-start">
        <nav
          aria-label={t("admin.settings.nav")}
          className="xl:sticky xl:top-4 xl:w-[220px] shrink-0 flex xl:flex-col gap-0.5 overflow-x-auto -mx-1 px-1 pb-1 xl:pb-0"
        >
          {SECTIONS.map((s) => (
            <a
              key={s}
              href={`#${s}`}
              aria-current={active === s ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(s)
                  ?.scrollIntoView({
                    behavior:
                      document.documentElement.dataset.reducedMotion === "true"
                        ? "auto"
                        : "smooth",
                    block: "start",
                  });
                history.replaceState(null, "", `#${s}`);
                setActive(s);
              }}
              className={cx(
                "flex items-center h-[34px] px-2.5 rounded-control text-sm font-medium whitespace-nowrap no-underline transition-colors duration-fast",
                active === s
                  ? "bg-primary-soft !text-fg"
                  : "!text-fg-muted hover:bg-raised hover:!text-fg",
              )}
            >
              {t(`admin.settings.sections.${s}`)}
            </a>
          ))}
        </nav>

        <div className="flex-1 min-w-0 max-w-[860px] flex flex-col gap-[18px]">
          {ro && (
            <Notice tone="primary" icon="Lock">
              {t("admin.common.readOnly")}
            </Notice>
          )}
          {!draft ? (
            !q.isError &&
            Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[220px] rounded-card" />
            ))
          ) : (
            <>
              {/* Allgemein */}
              <SectionCard
                id="allgemein"
                title={t("admin.settings.sections.allgemein")}
                description={t("admin.settings.generalDesc")}
              >
                <FieldGrid>
                  <TextField
                    k="general.instance_name"
                    label={t("admin.settings.instanceName")}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <TextField
                    k="general.organization"
                    label="Organisation"
                    help="Erscheint auf Upload-Seiten, Aushängen und in der Seitenleiste."
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <TextField
                    k="general.sender_name"
                    label="Absendername"
                    help="Für E-Mails und Veröffentlichungen."
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <TextField
                    k="general.public_url"
                    label={t("admin.settings.publicUrl")}
                    help={`Steht in Einladungen, Upload-Links und QR-Codes. Bereits gedruckte Codes zeigen weiter auf die alte Adresse.${q.data?.env.publicUrl ? ` Umgebung: ${q.data.env.publicUrl}` : ""}`}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <FieldWrap
                    label={t("admin.settings.timezone")}
                    htmlFor="s-tz"
                  >
                    <Select
                      id="s-tz"
                      disabled={ro}
                      value={v["general.timezone"]}
                      onChange={(e) => set("general.timezone", e.target.value)}
                    >
                      {timeZones(v["general.timezone"]).map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </Select>
                  </FieldWrap>
                  <FieldWrap
                    label={t("admin.settings.language")}
                    htmlFor="s-lang"
                  >
                    <Select
                      id="s-lang"
                      disabled={ro}
                      value={v["general.language"]}
                      onChange={(e) => set("general.language", e.target.value)}
                    >
                      <option value="de">
                        {t("admin.settings.languages.de")}
                      </option>
                      <option value="en">
                        {t("admin.settings.languages.en")}
                      </option>
                    </Select>
                  </FieldWrap>
                </FieldGrid>
              </SectionCard>

              {/* Darstellung (persönlich, sofort wirksam) */}
              <SectionCard
                id="darstellung"
                title={t("admin.settings.sections.darstellung")}
                description={t("admin.settings.lookDesc")}
              >
                <AppearanceFields />
              </SectionCard>

              {/* Redaktion */}
              <SectionCard
                id="redaktion"
                title="Redaktion"
                description="Freigaben, Einladungen und Aufbewahrung."
                bodyClassName="flex flex-col gap-5"
              >
                <Switch
                  checked={!!v["editorial.four_eyes"]}
                  disabled={ro}
                  onChange={(x) => set("editorial.four_eyes", x)}
                  label="Vier-Augen-Prinzip"
                  description="Wer eine Fassung geschrieben hat, darf sie nicht selbst freigeben."
                />
                <FieldGrid>
                  <NumField k="invites.valid_hours" label="Einladungen gültig" unit="Std." min={1} max={720} v={v} set={set} ro={ro} />
                  <NumField k="jobs.concurrency" label="Parallele Hintergrundaufträge" help="1 bis 32 (Medienprüfung, Exporte)." min={1} max={32} v={v} set={set} ro={ro} />
                  <NumField k="retention.log_days" label={t("admin.settings.retLogs")} unit={t("admin.common.days")} min={1} v={v} set={set} ro={ro} />
                  <NumField k="retention.audit_days" label={t("admin.settings.retAudit")} unit={t("admin.common.days")} min={30} v={v} set={set} ro={ro} />
                </FieldGrid>
              </SectionCard>

              {/* Medien */}
              <SectionCard
                id="medien"
                title="Medien und Upload-Links"
                description="Grenzen für Uploads. Neue Dateien landen immer zuerst in der Prüfung."
                bodyClassName="flex flex-col gap-5"
              >
                <FieldGrid>
                  <NumField k="media.max_file_mb" label="Maximale Dateigröße" unit="MB" min={1} max={20000} v={v} set={set} ro={ro} />
                  <NumField k="media.link_max_files" label="Dateien je Upload-Link" min={1} max={1000} v={v} set={set} ro={ro} />
                  <NumField k="media.link_default_days" label="Upload-Link gültig (Standard)" unit={t("admin.common.days")} min={1} max={90} v={v} set={set} ro={ro} />
                  <NumField k="media.collection_max_files" label="Dateien je Sammlung" min={1} max={100000} v={v} set={set} ro={ro} />
                  <NumField k="media.collection_max_gb" label="Speicher je Sammlung" unit="GB" min={1} max={10000} v={v} set={set} ro={ro} />
                  <NumField k="media.min_free_gb" label="Mindestens frei halten" help="Darunter werden Uploads gesperrt und der Healthcheck meldet einen Fehler." unit="GB" min={1} max={10000} v={v} set={set} ro={ro} />
                </FieldGrid>
                <div className="flex items-start gap-2.5 p-3 rounded-node bg-raised text-sm">
                  <Icon name="ShieldCheck" size={16} className="mt-0.5 text-fg-muted shrink-0" />
                  <span>Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale bleiben privat und sind nur mit Recht abrufbar.</span>
                </div>
              </SectionCard>

              <OpsSection />

              {/* Sicherheit */}
              <SectionCard
                id="sicherheit"
                title={t("admin.settings.sections.sicherheit")}
                description={t("admin.settings.secDesc")}
                bodyClassName="flex flex-col gap-5"
              >
                <div className="flex flex-col gap-2">
                  <Switch
                    checked={!!v["security.require_2fa_admins"]}
                    disabled={ro || !!v["security.require_2fa_all"]}
                    onChange={(x) => set("security.require_2fa_admins", x)}
                    label={t("admin.settings.req2faAdmins")}
                    description={t("admin.settings.req2faAdminsDesc")}
                  />
                  <Switch
                    checked={!!v["security.require_2fa_all"]}
                    disabled={ro}
                    onChange={(x) => set("security.require_2fa_all", x)}
                    label={t("admin.settings.req2faAll")}
                    description={t("admin.settings.req2faAllDesc")}
                  />
                </div>
                <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
                  <NumField
                    k="security.session_idle_minutes"
                    label={t("admin.settings.idle")}
                    help={t("admin.settings.idleHelp")}
                    unit={t("admin.common.minutes")}
                    min={5}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <NumField
                    k="security.session_max_hours"
                    label={t("admin.settings.maxSession")}
                    unit={t("admin.common.hours")}
                    min={1}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <NumField
                    k="security.lockout_attempts"
                    label={t("admin.settings.lockAttempts")}
                    unit={t("admin.settings.attempts")}
                    min={1}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <NumField
                    k="security.lockout_minutes"
                    label={t("admin.settings.lockMinutes")}
                    unit={t("admin.common.minutes")}
                    min={1}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                  <NumField
                    k="security.password_min_length"
                    label={t("admin.settings.pwLen")}
                    help={t("admin.settings.pwLenHelp")}
                    unit={t("admin.settings.chars")}
                    min={10}
                    max={128}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                </FieldGrid>
              </SectionCard>

              {/* Sicherung */}
              <SectionCard
                id="sicherung"
                title={t("admin.settings.sections.sicherung")}
                description={t("admin.settings.backupDesc")}
                bodyClassName="flex flex-col gap-5"
              >
                <Switch
                  checked={!!v["backup.enabled"]}
                  disabled={ro}
                  onChange={(x) => set("backup.enabled", x)}
                  label={t("admin.settings.backupAuto")}
                  description={t("admin.settings.backupAutoDesc")}
                />
                <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
                  <FieldWrap
                    label={t("admin.settings.backupHour")}
                    htmlFor="s-bhour"
                  >
                    <Select
                      id="s-bhour"
                      disabled={ro || !v["backup.enabled"]}
                      value={String(v["backup.hour"])}
                      onChange={(e) =>
                        set("backup.hour", Number(e.target.value))
                      }
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, "0")}:00
                        </option>
                      ))}
                    </Select>
                  </FieldWrap>
                  <NumField
                    k="backup.keep"
                    label={t("admin.settings.backupKeep")}
                    help={t("admin.settings.backupKeepHelp")}
                    min={1}
                    max={365}
                    v={v}
                    set={set}
                    ro={ro}
                  />
                </FieldGrid>
                <Notice
                  tone="warning"
                  icon="KeyRound"
                  title={t("admin.settings.masterKey")}
                >
                  <p className="m-0">{t("admin.settings.masterKeyText")}</p>
                  <Link
                    to="/hilfe/sicherung"
                    className="inline-flex items-center gap-1 mt-1.5"
                  >
                    <Icon name="BookOpen" size={13} />
                    {t("admin.settings.restoreHelp")}
                  </Link>
                </Notice>
                {manage ? (
                  <BackupList />
                ) : (
                  <p className="m-0 text-sm text-fg-muted">
                    {t("admin.settings.noManage")}
                  </p>
                )}
              </SectionCard>

              <AboutSection dataDir={q.data?.env.dataDir} />
            </>
          )}

          {dirty && (
            <div
              role="status"
              className="sticky bottom-4 z-20 flex items-center gap-3 flex-wrap px-4 py-3 rounded-card border border-line bg-raised shadow-float"
            >
              <span
                className="w-2 h-2 rounded-full bg-warn shrink-0"
                aria-hidden="true"
              />
              <span className="text-sm font-medium flex-1 min-w-[160px]">
                {t("admin.common.unsaved")}{" "}
                <span className="text-fg-muted font-normal">
                  · {changed.length}
                </span>
              </span>
              {saveError && (
                <span className="text-meta text-err basis-full sm:basis-auto order-last sm:order-none">
                  {saveError}
                </span>
              )}
              <Button variant="ghost" onClick={discard} disabled={saving}>
                {t("admin.common.discard")}
              </Button>
              <Button
                variant="primary"
                icon="Save"
                loading={saving}
                disabled={ro || badRecipients.length > 0 || invalidNumbers}
                onClick={save}
              >
                {t("admin.common.save")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  if (!list.length)
    list = ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "UTC"];
  return list.includes(current) || !current ? list : [current, ...list];
}

function TextField({
  k,
  label,
  help,
  v,
  set,
  ro,
}: {
  k: string;
  label: string;
  help?: string;
  v: Values;
  set: (k: string, x: unknown) => void;
  ro: boolean;
}) {
  const id = `s-${k.replace(/\W/g, "-")}`;
  return (
    <FieldWrap label={label} htmlFor={id} help={help}>
      <Input
        id={id}
        disabled={ro}
        value={v[k] ?? ""}
        maxLength={200}
        onChange={(e) => set(k, e.target.value)}
      />
    </FieldWrap>
  );
}

function NumField({
  k,
  label,
  help,
  unit,
  min,
  max,
  v,
  set,
  ro,
}: {
  k: string;
  label: string;
  help?: string;
  unit?: string;
  min?: number;
  max?: number;
  v: Values;
  set: (k: string, x: unknown) => void;
  ro: boolean;
}) {
  const id = `s-${k.replace(/\W/g, "-")}`;
  const val = v[k];
  const n = Number(val);
  const err =
    val === "" || !Number.isFinite(n)
      ? t("admin.settings.numInvalid")
      : min != null && n < min
        ? t("admin.settings.numMin", { min })
        : max != null && n > max
          ? t("admin.settings.numMax", { max })
          : null;
  return (
    <FieldWrap label={label} htmlFor={id} help={help} error={err}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          disabled={ro}
          min={min}
          max={max}
          invalid={!!err}
          value={val ?? ""}
          onChange={(e) =>
            set(k, e.target.value === "" ? "" : Number(e.target.value))
          }
          className={cx("tabular", unit && "pr-14")}
        />
        {unit && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-muted pointer-events-none">
            {unit}
          </span>
        )}
      </div>
    </FieldWrap>
  );
}

function OpsSection() {
  const q = useSystemStatus(30_000);
  const d = q.data;
  const db = d?.services.find((s) => s.id === "db");
  const worker = d?.services.find((s) => s.id === "worker");
  const queueSvc = d?.services.find((s) => s.id === "queue");
  const live = d
    ? d.workers.filter(
        (w) => Date.now() - new Date(w.last_seen_at).getTime() < 45_000,
      ).length
    : 0;
  const tiles: { k: string; v: ReactNode; sub: ReactNode; state: string }[] = d
    ? [
        {
          k: t("admin.settings.uptime"),
          v: fmtUptime(d.uptimeSec),
          sub: `v${d.version} · Node ${d.node.replace(/^v/, "")}`,
          state: "ok",
        },
        {
          k: t("admin.settings.database"),
          v: db?.detail.replace(/^PostgreSQL/, "PostgreSQL") ?? "–",
          sub: `${fmtBytes(d.dbSize)} · ${t(`admin.common.state.${db?.state ?? "warning"}`)}`,
          state: db?.state ?? "warning",
        },
        {
          k: t("admin.settings.queue"),
          v: t("admin.settings.queueVal", {
            n: fmtNumber(d.queue.ready + d.queue.scheduled + d.queue.running),
          }),
          sub: t("admin.settings.queueSub", { workers: live }),
          state:
            worker?.state === "error" ? "error" : (queueSvc?.state ?? "ok"),
        },
        {
          k: t("admin.settings.lastBackup"),
          v: d.lastBackup
            ? fmtRelative(d.lastBackup.started_at)
            : t("admin.system.noBackup"),
          sub: d.lastBackup
            ? `${t(`admin.settings.backupStatus.${d.lastBackup.status}`)}${d.lastBackup.size_bytes ? " · " + fmtBytes(d.lastBackup.size_bytes) : ""}`
            : "–",
          state: !d.lastBackup
            ? "warning"
            : d.lastBackup.status === "failed"
              ? "error"
              : d.lastBackup.status === "ok"
                ? "ok"
                : "warning",
        },
      ]
    : [];
  const dot: Record<string, string> = {
    ok: "bg-ok",
    warning: "bg-warn",
    error: "bg-err",
  };
  return (
    <SectionCard
      id="betrieb"
      title={t("admin.settings.sections.betrieb")}
      description={t("admin.settings.opsDesc")}
      action={
        <LinkButton to="/system" size="sm" variant="ghost" icon="Activity">
          {t("admin.settings.statusPage")}
        </LinkButton>
      }
    >
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))]">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[84px] rounded-node" />
          ))}
        </div>
      ) : (
        <dl className="m-0 grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))]">
          {tiles.map((x) => (
            <div
              key={String(x.k)}
              className="bg-raised rounded-node px-3.5 py-3 flex flex-col gap-1 min-w-0"
            >
              <dt className="text-meta text-fg-muted">{x.k}</dt>
              <dd className="m-0 flex items-center gap-2 font-semibold text-base min-w-0">
                <span
                  aria-hidden="true"
                  className={cx(
                    "w-2 h-2 rounded-full shrink-0",
                    dot[x.state] ?? "bg-fg-muted",
                  )}
                />
                <span className="truncate">{x.v}</span>
                <span className="sr-only">
                  ({t(`admin.common.state.${x.state}`)})
                </span>
              </dd>
              <dd className="m-0 text-meta text-fg-muted truncate">{x.sub}</dd>
            </div>
          ))}
        </dl>
      )}
    </SectionCard>
  );
}

function BackupList() {
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
                  </Td>
                  <Td className="text-meta text-fg-muted whitespace-nowrap">
                    {b.trigger === "manual"
                      ? (b.created_by_name ??
                        t("admin.settings.backupTrigger.manual"))
                      : t("admin.settings.backupTrigger.schedule")}
                  </Td>
                  <Td align="right">
                    {b.status === "ok" && (
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

function AboutSection({ dataDir }: { dataDir?: string }) {
  const { me, isPlatformAdmin } = useAuth();
  const status = useSystemStatus(false);
  return (
    <SectionCard
      id="ueber"
      title={t("admin.settings.sections.ueber")}
      description={t("admin.settings.aboutDesc")}
      bodyClassName="flex flex-col gap-4"
    >
      <dl className="m-0 grid gap-x-6 gap-y-2 grid-cols-[max-content_1fr] text-sm">
        <dt className="text-fg-muted">{t("admin.settings.version")}</dt>
        <dd className="m-0 font-mono">{me?.version ?? "–"}</dd>
        <dt className="text-fg-muted">{t("admin.settings.node")}</dt>
        <dd className="m-0 font-mono">{status.data?.node ?? "–"}</dd>
        {dataDir && (
          <>
            <dt className="text-fg-muted">{t("admin.settings.dataDir")}</dt>
            <dd className="m-0 font-mono text-meta break-all">{dataDir}</dd>
          </>
        )}
      </dl>
      <div className="flex gap-2 flex-wrap">
        <LinkButton to="/hilfe" icon="BookOpen">
          {t("admin.settings.openHelp")}
        </LinkButton>
        {isPlatformAdmin && (
          <LinkButton to="/hilfe/updates" icon="Download">
            {t("admin.settings.openUpdates")}
          </LinkButton>
        )}
      </div>
    </SectionCard>
  );
}
