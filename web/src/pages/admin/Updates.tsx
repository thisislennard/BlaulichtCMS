import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, get, patch, post } from "../../api/client";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorBox,
  FieldWrap,
  Input,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Spinner,
  Switch,
  Table,
  Td,
  Th,
  type Tone,
} from "../../components/ui/core";
import {
  CopyButton,
  Dialog,
  SecretField,
  useToast,
} from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { LoadError } from "./shared";

interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  zip: { id: number; name: string; size: number } | null;
  sha: { id: number; name: string } | null;
  sig: { id: number; name: string } | null;
}
interface UpdatesData {
  current: string;
  imageVersion: string;
  runningFrom: "image" | "update";
  supervised: boolean;
  latest: ReleaseInfo | null;
  available: boolean;
  lastCheckAt: string | null;
  lastCheckError: string | null;
  settings: {
    enabled: boolean;
    repo: string;
    checkHours: number;
    tokenSet: boolean;
  };
  signingKey: "ok" | "missing" | "invalid";
  busy: boolean;
  history: {
    id: number;
    at: string;
    from_version: string;
    to_version: string | null;
    source: string;
    status: string;
    message: string;
    actor_name: string | null;
  }[];
}
interface InstallResult {
  version: string;
  activation: "supervisor" | "manuell";
}

const STATUS_TONE: Record<string, Tone> = {
  installed: "primary",
  activated: "success",
  rolled_back: "warning",
  failed: "error",
};

export default function Updates() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["updates"],
    queryFn: () => get<UpdatesData>("/updates"),
  });
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [waitFor, setWaitFor] = useState<{
    version: string;
    from: string;
  } | null>(null);
  const [manualDone, setManualDone] = useState<string | null>(null);
  const d = q.data;

  const check = async () => {
    setChecking(true);
    try {
      const r = await post<{ available: boolean; error?: string }>(
        "/updates/check",
      );
      await qc.invalidateQueries({ queryKey: ["updates"] });
      if (!r.error)
        toast({
          tone: r.available ? "info" : "success",
          title: t("admin.updates.checked"),
          text: r.available ? t("admin.updates.available") : undefined,
        });
    } catch (e) {
      toast({
        tone: "error",
        title: t("admin.updates.checkError"),
        text: (e as Error).message,
      });
    } finally {
      setChecking(false);
    }
  };

  const afterInstall = (r: InstallResult) => {
    qc.invalidateQueries({ queryKey: ["updates"] });
    if (r.activation === "supervisor")
      setWaitFor({ version: r.version, from: d?.current ?? "" });
    else setManualDone(r.version);
  };

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await post<InstallResult>("/updates/install-latest");
      setConfirm(false);
      afterInstall(r);
    } catch (e) {
      setInstallError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  if (waitFor)
    return <WaitView version={waitFor.version} from={waitFor.from} />;

  const latest = d?.latest ?? null;
  const complete = !!(latest?.zip && latest.sha && latest.sig);
  const canInstall =
    !!d && d.available && complete && d.signingKey === "ok" && !d.busy;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("admin.updates.title")}
        subtitle={t("admin.updates.subtitle")}
        actions={
          <>
            <Button icon="RefreshCw" loading={checking} onClick={check}>
              {t("admin.updates.check")}
            </Button>
            <Button
              variant="primary"
              icon="Download"
              disabled={!canInstall}
              onClick={() => setConfirm(true)}
            >
              {d?.available && latest
                ? t("admin.updates.installTo", { v: latest.version })
                : t("admin.updates.install")}
            </Button>
          </>
        }
      />
      {q.isError && <LoadError error={q.error} onRetry={() => q.refetch()} />}
      {manualDone && (
        <Notice
          tone="success"
          title={t("admin.updates.installedManual", { v: manualDone })}
        >
          {t("admin.updates.installedManualText")}
        </Notice>
      )}
      {d?.busy && (
        <Notice tone="primary" icon="Hourglass">
          {t("admin.updates.busy")}
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        {/* Installierte Version */}
        <Card title={t("admin.updates.current")}>
          {!d ? (
            <SkeletonRows rows={3} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-kpi font-semibold tracking-[-0.02em] font-mono">
                  {d.current}
                </span>
                <span className="text-sm text-fg-muted">
                  {t(
                    d.runningFrom === "image"
                      ? "admin.updates.fromImage"
                      : "admin.updates.fromUpdate",
                  )}
                </span>
              </div>
              {d.runningFrom === "update" && (
                <span className="text-meta text-fg-muted">
                  {t("admin.updates.imageVersion", { v: d.imageVersion })}
                </span>
              )}
              {d.supervised ? (
                <Badge tone="success" className="self-start">
                  {t("admin.updates.supervised")}
                </Badge>
              ) : (
                <Notice tone="warning" title={t("admin.updates.notSupervised")}>
                  {t("admin.updates.notSupervisedText")}
                </Notice>
              )}
              <SigningKey status={d.signingKey} />
            </div>
          )}
        </Card>

        {/* Neueste Version */}
        <Card
          title={t("admin.updates.latest")}
          subtitle={
            d?.lastCheckAt
              ? t("admin.updates.lastCheck", {
                  when: fmtRelative(d.lastCheckAt),
                })
              : d
                ? t("admin.updates.notChecked")
                : undefined
          }
          action={
            d &&
            latest && (
              <Badge tone={d.available ? "primary" : "success"}>
                {d.available
                  ? t("admin.updates.available")
                  : t("admin.updates.upToDate")}
              </Badge>
            )
          }
        >
          {!d ? (
            <SkeletonRows rows={4} />
          ) : (
            <div className="flex flex-col gap-3">
              {d.lastCheckError && (
                <ErrorBox
                  title={t("admin.updates.checkError")}
                  actions={
                    <CopyButton
                      size="sm"
                      value={d.lastCheckError}
                      label={t("admin.common.copyDetails")}
                    />
                  }
                >
                  <p className="m-0">{d.lastCheckError}</p>
                  <p className="m-0 mt-1">
                    {t("admin.updates.checkErrorText")}
                  </p>
                </ErrorBox>
              )}
              {!latest ? (
                !d.lastCheckError && (
                  <EmptyState
                    icon="Inbox"
                    title={t("admin.updates.noRelease")}
                    text={t("admin.updates.noReleaseText", {
                      repo: d.settings.repo || "–",
                    })}
                    action={
                      <Button
                        icon="RefreshCw"
                        loading={checking}
                        onClick={check}
                      >
                        {t("admin.updates.check")}
                      </Button>
                    }
                  />
                )
              ) : (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-title font-semibold font-mono">
                      {latest.version}
                    </span>
                    {latest.name && latest.name !== latest.tag && (
                      <span className="text-sm">{latest.name}</span>
                    )}
                    {latest.publishedAt && (
                      <span className="text-meta text-fg-muted">
                        ·{" "}
                        {t("admin.updates.published", {
                          when: fmtDateTime(latest.publishedAt),
                        })}
                      </span>
                    )}
                  </div>
                  {d.available && !complete && (
                    <Notice tone="warning">
                      {t("admin.updates.incomplete")}
                    </Notice>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <h4 className="m-0 text-sm font-semibold">
                      {t("admin.updates.releaseNotes")}
                    </h4>
                    {latest.notes ? (
                      <pre className="m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed bg-bg border border-line rounded-node p-3">
                        {latest.notes}
                      </pre>
                    ) : (
                      <p className="m-0 text-sm text-fg-muted">
                        {t("admin.updates.noNotes")}
                      </p>
                    )}
                  </div>
                  {latest.url && (
                    <a
                      href={latest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm self-start"
                    >
                      <Icon name="ExternalLink" size={14} />
                      {t("admin.updates.onGithub")}
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ManualUpload
          disabled={!d || d.signingKey !== "ok" || d.busy}
          onDone={afterInstall}
        />
        {d ? (
          <UpdateSettings data={d} />
        ) : (
          <Skeleton className="h-[320px] rounded-card" />
        )}
      </div>

      <Card title={t("admin.updates.history")} bodyClassName="!px-0 !pb-2">
        {!d ? (
          <SkeletonRows rows={3} className="px-5" />
        ) : d.history.length === 0 ? (
          <p className="m-0 px-5 pb-3 text-sm text-fg-muted">
            {t("admin.updates.historyEmpty")}
          </p>
        ) : (
          <Table className="relative">
            <thead>
              <tr>
                <Th className="pl-5">{t("admin.updates.col.when")}</Th>
                <Th>{t("admin.updates.col.version")}</Th>
                <Th>{t("admin.updates.col.source")}</Th>
                <Th>{t("admin.updates.col.status")}</Th>
                <Th>{t("admin.updates.col.message")}</Th>
                <Th>{t("admin.updates.col.by")}</Th>
              </tr>
            </thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.id}>
                  <Td className="pl-5 text-meta whitespace-nowrap">
                    {fmtDateTime(h.at)}
                  </Td>
                  <Td mono className="whitespace-nowrap">
                    {h.from_version || "–"} → {h.to_version ?? "–"}
                  </Td>
                  <Td className="text-meta">
                    {t(`admin.updates.sources.${h.source}`)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[h.status] ?? "neutral"}>
                      {t(`admin.updates.statuses.${h.status}`)}
                    </Badge>
                  </Td>
                  <Td className="text-meta text-fg-muted max-w-[360px] break-words">
                    {h.message || "–"}
                  </Td>
                  <Td className="text-meta text-fg-muted whitespace-nowrap">
                    {h.actor_name ?? "–"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={confirm}
        onClose={() => !installing && setConfirm(false)}
        title={t("admin.updates.confirmTitle", { v: latest?.version ?? "" })}
        width={560}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={installing}
              onClick={() => setConfirm(false)}
            >
              {t("admin.common.cancel")}
            </Button>
            <Button
              variant="primary"
              icon="Download"
              loading={installing}
              onClick={install}
            >
              {t("admin.updates.confirmGo")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="m-0">{t("admin.updates.confirmIntro")}</p>
          <ol className="m-0 pl-5 flex flex-col gap-1.5 text-fg-muted">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i}>{t(`admin.updates.steps.${i}`)}</li>
            ))}
          </ol>
          <p className="m-0 text-meta text-fg-muted">
            {t("admin.updates.confirmBackup")}
          </p>
          {d && !d.supervised && (
            <Notice tone="warning">{t("admin.updates.confirmManual")}</Notice>
          )}
          {installError && (
            <ErrorBox title={t("admin.updates.installFailed")}>
              {installError}
            </ErrorBox>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function SigningKey({ status }: { status: UpdatesData["signingKey"] }) {
  const map = {
    ok: {
      tone: "success" as const,
      label: t("admin.updates.signingOk"),
      text: t("admin.updates.signingOkText"),
    },
    missing: {
      tone: "error" as const,
      label: t("admin.updates.signingMissing"),
      text: t("admin.updates.signingMissingText"),
    },
    invalid: {
      tone: "error" as const,
      label: t("admin.updates.signingInvalid"),
      text: t("admin.updates.signingInvalidText"),
    },
  }[status];
  return (
    <div className="flex flex-col gap-1.5 pt-3 border-t border-line">
      <div className="flex items-center gap-2 flex-wrap">
        <Icon name="ShieldCheck" size={15} className="text-fg-muted" />
        <span className="text-sm font-medium">
          {t("admin.updates.signing")}
        </span>
        <Badge tone={map.tone}>{map.label}</Badge>
      </div>
      <p
        className={cx(
          "m-0 text-meta",
          status === "ok" ? "text-fg-muted" : "text-err",
        )}
      >
        {map.text}
      </p>
    </div>
  );
}

function FilePick({
  id,
  label,
  accept,
  file,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  accept: string;
  file: File | null;
  onChange: (f: File | null) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <FieldWrap label={label} htmlFor={id}>
      <div className="flex items-center gap-2 min-w-0">
        <input
          ref={ref}
          id={id}
          type="file"
          accept={accept}
          className="sr-only"
          disabled={disabled}
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        />
        <Button
          icon="Upload"
          disabled={disabled}
          onClick={() => ref.current?.click()}
          aria-describedby={`${id}-name`}
        >
          {t("admin.updates.chooseFile")}
        </Button>
        <span
          id={`${id}-name`}
          className={cx(
            "text-sm truncate min-w-0",
            file ? "font-mono" : "text-fg-muted",
          )}
        >
          {file ? file.name : t("admin.updates.noFile")}
        </span>
      </div>
    </FieldWrap>
  );
}

function ManualUpload({
  disabled,
  onDone,
}: {
  disabled: boolean;
  onDone: (r: InstallResult) => void;
}) {
  const [zip, setZip] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const [sha, setSha] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shaBad =
    !!sha.trim() && !/^[a-f0-9]{64}$/i.test(sha.trim().split(/\s+/)[0]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!zip || !sig || shaBad) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      if (sha.trim()) fd.append("sha256", sha.trim().split(/\s+/)[0]);
      fd.append("zip", zip);
      fd.append("sig", sig);
      const r = await api<InstallResult>("POST", "/updates/upload", fd);
      onDone(r);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={t("admin.updates.manual")}
      subtitle={t("admin.updates.manualDesc")}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FilePick
          id="upd-zip"
          label={t("admin.updates.zip")}
          accept=".zip,application/zip"
          file={zip}
          onChange={setZip}
          disabled={disabled || busy}
        />
        <FilePick
          id="upd-sig"
          label={t("admin.updates.sig")}
          accept=".sig"
          file={sig}
          onChange={setSig}
          disabled={disabled || busy}
        />
        <FieldWrap
          label={t("admin.updates.sha")}
          htmlFor="upd-sha"
          help={t("admin.updates.shaHelp")}
          error={shaBad ? t("admin.updates.shaInvalid") : null}
        >
          <Input
            id="upd-sha"
            mono
            value={sha}
            disabled={disabled || busy}
            invalid={shaBad}
            onChange={(e) => setSha(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FieldWrap>
        {error && (
          <ErrorBox title={t("admin.updates.installFailed")}>{error}</ErrorBox>
        )}
        <div>
          <Button
            type="submit"
            icon="Upload"
            loading={busy}
            disabled={disabled || !zip || !sig || shaBad}
          >
            {t("admin.updates.upload")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UpdateSettings({ data }: { data: UpdatesData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [repo, setRepo] = useState(data.settings.repo);
  const [hours, setHours] = useState<number | "">(data.settings.checkHours);
  const [token, setToken] = useState("");
  const [tokenKey, setTokenKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoBad =
    !!repo.trim() && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
  const hoursBad = hours === "" || hours < 1 || hours > 168;
  const dirty =
    enabled !== data.settings.enabled ||
    repo.trim() !== data.settings.repo ||
    hours !== data.settings.checkHours ||
    !!token;

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await patch("/updates/settings", {
        enabled,
        repo: repo.trim(),
        checkHours: Number(hours),
        ...(token ? { token } : {}),
        ...extra,
      });
      setToken("");
      setTokenKey((k) => k + 1);
      await qc.invalidateQueries({ queryKey: ["updates"] });
      toast({
        tone: "success",
        title: extra.clearToken
          ? t("admin.updates.tokenRemoved")
          : t("admin.updates.settingsSaved"),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("admin.updates.settings")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!repoBad && !hoursBad) save();
        }}
      >
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label={t("admin.updates.auto")}
          description={t("admin.updates.autoDesc")}
        />
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
          <FieldWrap
            label={t("admin.updates.repo")}
            htmlFor="upd-repo"
            help={t("admin.updates.repoHelp")}
            error={repoBad ? t("admin.updates.repoInvalid") : null}
          >
            <Input
              id="upd-repo"
              mono
              value={repo}
              invalid={repoBad}
              placeholder="besitzer/name"
              onChange={(e) => setRepo(e.target.value)}
              spellCheck={false}
            />
          </FieldWrap>
          <FieldWrap
            label={t("admin.updates.interval")}
            htmlFor="upd-hours"
            error={hoursBad ? "1–168" : null}
          >
            <div className="relative">
              <Input
                id="upd-hours"
                type="number"
                min={1}
                max={168}
                invalid={hoursBad}
                value={hours}
                disabled={!enabled}
                onChange={(e) =>
                  setHours(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="pr-14 tabular"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-muted pointer-events-none">
                {t("admin.common.hours")}
              </span>
            </div>
          </FieldWrap>
        </div>
        <div className="flex flex-col gap-2">
          <SecretField
            key={tokenKey}
            label={t("admin.updates.token")}
            set={data.settings.tokenSet}
            value={token}
            onReplace={setToken}
            help={t("admin.updates.tokenHelp")}
          />
          {data.settings.tokenSet && (
            <Button
              variant="ghost"
              size="sm"
              icon="Trash2"
              className="self-start"
              disabled={busy}
              onClick={() => save({ clearToken: true })}
            >
              {t("admin.updates.tokenRemove")}
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="m-0 text-meta text-err">
            {error}
          </p>
        )}
        <div>
          <Button
            type="submit"
            variant={dirty ? "primary" : "secondary"}
            icon="Save"
            loading={busy}
            disabled={!dirty || repoBad || hoursBad}
          >
            {t("admin.common.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Warteansicht nach dem Installieren: pollt /auth/me bis die neue Version antwortet, dann neu laden. */
function WaitView({ version, from }: { version: string; from: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    let stop = false;
    let sawDown = false;
    const tick = async () => {
      if (stop) return;
      setElapsed(Math.round((Date.now() - started) / 1000));
      try {
        const res = await fetch("/api/v1/auth/me", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (res.ok) {
          const me = await res.json();
          // neue Version antwortet – oder der Server war weg und ist wieder da (z. B. nach Zurückschalten)
          if (
            me?.version === version ||
            (me?.version && me.version !== from) ||
            sawDown
          ) {
            window.location.reload();
            return;
          }
        } else if (res.status === 401) {
          window.location.href = "/login";
          return;
        } else sawDown = true;
      } catch {
        sawDown = true; // Server startet neu
      }
      setTimeout(tick, 2000);
    };
    const h = setTimeout(tick, 3000);
    return () => {
      stop = true;
      clearTimeout(h);
    };
  }, [version, from]);
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div
        role="status"
        aria-live="polite"
        className="max-w-[460px] text-center flex flex-col items-center gap-4 bg-card border border-line rounded-card p-8"
      >
        <Spinner size={28} className="text-fg-link" />
        <h2 className="m-0 text-title font-semibold">
          {t("admin.updates.waitTitle")}
        </h2>
        <p className="m-0 text-sm text-fg-muted">
          {t("admin.updates.waitText", { v: version })}
        </p>
        <p className="m-0 font-mono text-meta text-fg-muted tabular">
          {t("admin.updates.waitElapsed", { s: elapsed })}
        </p>
        {elapsed > 120 && (
          <Notice tone="warning">{t("admin.updates.waitLong")}</Notice>
        )}
      </div>
    </div>
  );
}
