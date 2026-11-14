import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../api/client";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  cx,
  FieldWrap,
  hashTone,
  Input,
  Notice,
  PageHeader,
  SkeletonRows,
} from "../components/ui/core";
import { Dialog, useErrorToast, useToast } from "../components/ui/overlays";
import { Icon } from "../components/ui/Icon";
import { t } from "../i18n";
import { useAuth } from "../lib/auth";
import { fmtRelative } from "../lib/format";
import { MfaSetupPage } from "./auth/AuthPages";
import { AppearanceFields, LoadError, SectionCard } from "./admin/shared";

interface Session {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export default function Profile() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("profile.title")} subtitle={t("profile.subtitle")} />
      <div className="grid gap-5 xl:grid-cols-2 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <SectionCard title={t("profile.account")}>
            <div className="flex items-start gap-4 flex-wrap">
              <Avatar
                name={me.user.name}
                size={48}
                tone={hashTone(me.user.email)}
              />
              <dl className="m-0 grid gap-x-5 gap-y-2 grid-cols-[max-content_1fr] text-sm flex-1 min-w-[220px]">
                <dt className="text-fg-muted">{t("profile.name")}</dt>
                <dd className="m-0 font-medium">{me.user.name}</dd>
                <dt className="text-fg-muted">{t("profile.email")}</dt>
                <dd className="m-0 break-all">{me.user.email}</dd>
                <dt className="text-fg-muted">{t("profile.roles")}</dt>
                <dd className="m-0 flex gap-1.5 flex-wrap">
                  {me.roleLabels.map((r) => (
                    <Chip key={r}>{r}</Chip>
                  ))}
                </dd>
              </dl>
            </div>
            <p className="m-0 mt-4 text-meta text-fg-muted">
              {t("profile.nameHint")}
            </p>
          </SectionCard>
          <PasswordCard />
          <SectionCard
            title={t("profile.look")}
            description={t("profile.lookDesc")}
          >
            <AppearanceFields />
          </SectionCard>
        </div>
        <div className="flex flex-col gap-5 min-w-0">
          <MfaCard />
          <SessionsCard />
        </div>
      </div>
    </div>
  );
}

function PasswordCard() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<{ settings: Record<string, any> }>("/settings"),
    enabled: can("system.read") || can("system.manage"),
    retry: false,
  });
  const min =
    Number(settings.data?.settings["security.password_min_length"] ?? 0) ||
    null;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = !!repeat && next !== repeat;
  const short = !!next && !!min && next.length < min;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || short) return;
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password", { current, next });
      setCurrent("");
      setNext("");
      setRepeat("");
      qc.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast({
        tone: "success",
        title: t("profile.changed"),
        text: t("profile.changedText"),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard
      title={t("profile.password")}
      description={t("profile.passwordDesc")}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {/* Benutzername für Passwort-Manager */}
        <input type="text" autoComplete="username" hidden readOnly value="" />
        <FieldWrap label={t("profile.current")} htmlFor="pw-current" required>
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FieldWrap>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <FieldWrap
            label={t("profile.next")}
            htmlFor="pw-next"
            required
            help={min ? t("profile.minLength", { n: min }) : undefined}
            error={short ? t("profile.tooShort", { n: min ?? 0 }) : null}
          >
            <Input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              required
              invalid={short}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </FieldWrap>
          <FieldWrap
            label={t("profile.repeat")}
            htmlFor="pw-repeat"
            required
            error={mismatch ? t("profile.mismatch") : null}
          >
            <Input
              id="pw-repeat"
              type="password"
              autoComplete="new-password"
              required
              invalid={mismatch}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </FieldWrap>
        </div>
        {error && (
          <p role="alert" className="m-0 text-meta text-err">
            {error}
          </p>
        )}
        <div>
          <Button
            type="submit"
            icon="KeyRound"
            loading={busy}
            disabled={!current || !next || !repeat || mismatch || short}
          >
            {t("profile.change")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function MfaCard() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const on = me.user.totp_enabled;
  const left = me.recoveryCodesLeft;

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/mfa/disable", { password: pw });
      await refresh();
      setDisableOpen(false);
      setPw("");
      toast({ tone: "warning", title: t("profile.disabled") });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title={t("profile.mfa")}
      description={t("profile.mfaDesc")}
      action={
        on ? (
          <Badge tone="success">{t("profile.mfaOn")}</Badge>
        ) : (
          <Badge tone="warning">{t("profile.mfaOff")}</Badge>
        )
      }
    >
      {setup ? (
        <div className="flex flex-col gap-3 max-w-[420px]">
          <MfaSetupPage
            embedded
            onDone={() => {
              setSetup(false);
              toast({ tone: "success", title: t("profile.enabledToast") });
            }}
          />
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => setSetup(false)}
          >
            {t("profile.setupCancel")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm flex items-center gap-2">
            <Icon
              name={me.mfaRequired ? "Lock" : "Info"}
              size={14}
              className="text-fg-muted"
            />
            <span className="text-fg-muted">
              {me.mfaRequired
                ? t("profile.mfaRequired")
                : t("profile.mfaRecommended")}
            </span>
          </p>
          {on && (
            <p
              className={cx(
                "m-0 text-sm",
                left <= 2 ? "text-warn" : "text-fg-muted",
              )}
            >
              <Icon
                name="KeyRound"
                size={14}
                className="inline -mt-0.5 mr-1.5"
              />
              {t("profile.recovery", { n: left })}
            </p>
          )}
          {on && left <= 2 && (
            <Notice tone="warning">
              {t("profile.recoveryLow", { n: left })}
            </Notice>
          )}
          <div className="flex gap-2 flex-wrap">
            {!on && (
              <Button
                variant="primary"
                icon="ShieldCheck"
                onClick={() => {
                  qc.removeQueries({ queryKey: ["mfa-setup"] });
                  setSetup(true);
                }}
              >
                {t("profile.setup")}
              </Button>
            )}
            {on && (
              <Button
                variant="danger"
                icon="ShieldCheck"
                disabled={me.mfaRequired}
                title={
                  me.mfaRequired ? t("profile.requiredNoDisable") : undefined
                }
                onClick={() => setDisableOpen(true)}
              >
                {t("profile.disable")}
              </Button>
            )}
          </div>
          {on && me.mfaRequired && (
            <p className="m-0 text-meta text-fg-muted">
              {t("profile.requiredNoDisable")}
            </p>
          )}
        </div>
      )}
      <Dialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title={t("profile.disable")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>
              {t("profile.setupCancel")}
            </Button>
            <Button
              variant="danger"
              type="submit"
              form="mfa-disable"
              loading={busy}
              disabled={!pw}
            >
              {t("profile.disableGo")}
            </Button>
          </>
        }
      >
        <form
          id="mfa-disable"
          onSubmit={disable}
          className="flex flex-col gap-3"
        >
          <FieldWrap
            label={t("profile.disableConfirm")}
            htmlFor="mfa-pw"
            error={error}
          >
            <Input
              id="mfa-pw"
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              invalid={!!error}
            />
          </FieldWrap>
        </form>
      </Dialog>
    </SectionCard>
  );
}

function deviceName(ua: string | null): { name: string; icon: string } {
  if (!ua) return { name: t("profile.unknownDevice"), icon: "MonitorCog" };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl|node|python|PowerShell/i.test(ua)
            ? ua.split(/[/ ]/)[0]
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return {
    name: os ? `${browser} · ${os}` : browser,
    icon: /Android|iPhone|iPad|Mobile/.test(ua) ? "RadioTower" : "MonitorCog",
  };
}

function SessionsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const { logout } = useAuth();
  const q = useQuery({
    queryKey: ["auth-sessions"],
    queryFn: () => get<Session[]>("/auth/sessions"),
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const end = async (s: Session) => {
    try {
      await del(`/auth/sessions/${s.id}`);
      qc.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast({ tone: "success", title: t("profile.ended") });
    } catch (e) {
      onError(e);
    }
  };
  const rows = [...(q.data ?? [])].sort(
    (a, b) => Number(b.current) - Number(a.current),
  );
  return (
    <SectionCard
      title={t("profile.sessions")}
      description={t("profile.sessionsDesc")}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon="LogOut"
          onClick={() => setConfirmAll(true)}
        >
          {t("profile.logoutAll")}
        </Button>
      }
      bodyClassName="!px-0 !py-0"
    >
      {q.isError ? (
        <div className="p-5">
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : !q.data ? (
        <SkeletonRows rows={3} className="p-5" />
      ) : (
        <ul className="list-none m-0 p-0">
          {(showAll ? rows : rows.slice(0, 6)).map((s) => {
            const dev = deviceName(s.user_agent);
            return (
              <li
                key={s.id}
                className="flex items-center gap-3 px-5 py-3 border-b border-line last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className="w-8 h-8 rounded-control bg-raised inline-flex items-center justify-center text-fg-muted shrink-0"
                >
                  <Icon name={dev.icon} size={15} />
                </span>
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                    <span
                      className="truncate"
                      title={s.user_agent ?? undefined}
                    >
                      {dev.name}
                    </span>
                    {s.current && (
                      <Badge tone="primary">{t("profile.thisDevice")}</Badge>
                    )}
                  </span>
                  <span className="text-meta text-fg-muted truncate">
                    <span className="font-mono">{s.ip ?? "–"}</span> ·{" "}
                    {t("profile.lastSeen", {
                      when: fmtRelative(s.last_seen_at),
                    })}{" "}
                    · {t("profile.since", { when: fmtRelative(s.created_at) })}
                  </span>
                </span>
                {!s.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("profile.endOf", { name: dev.name })}
                    onClick={() => end(s)}
                  >
                    {t("profile.end")}
                  </Button>
                )}
              </li>
            );
          })}
          {rows.length <= 1 && (
            <li className="px-5 py-3 text-sm text-fg-muted">
              {t("profile.noSessions")}
            </li>
          )}
          {rows.length > 6 && (
            <li className="px-5 py-2.5">
              <Button
                size="sm"
                variant="ghost"
                icon={showAll ? "ChevronLeft" : "ChevronDown"}
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll
                  ? t("profile.showLess")
                  : t("profile.showAll", { n: rows.length })}
              </Button>
            </li>
          )}
        </ul>
      )}
      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={t("profile.logoutAll")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              {t("profile.setupCancel")}
            </Button>
            <Button
              variant="danger"
              icon="LogOut"
              loading={busyAll}
              onClick={async () => {
                setBusyAll(true);
                try {
                  await post("/auth/logout-all");
                  await logout();
                } catch (e) {
                  onError(e);
                  setBusyAll(false);
                }
              }}
            >
              {t("profile.logoutAllGo")}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{t("profile.logoutAllText")}</p>
      </Dialog>
    </SectionCard>
  );
}
