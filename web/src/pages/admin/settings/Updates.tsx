import { useEffect, useRef, useState } from "react";
import { useSaveSource, type SaveProblem } from "../../../components/ui/form";
import { HelpLink, HelpTip } from "../../../components/ui/HelpTip";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post, put } from "../../../api/client";
import { Badge, Button, ErrorBox, FieldWrap, Input, Notice, Switch, Table, Td, Th, cx } from "../../../components/ui/core";
import { CopyButton, useConfirm, useToast } from "../../../components/ui/overlays";
import { Icon } from "../../../components/ui/Icon";
import { useAuth } from "../../../lib/auth";
import { fmtDateTime, fmtRelative } from "../../../lib/format";
import { Markdown } from "../../help/Markdown";
import { FieldGrid, LoadError, SectionCard } from "../shared";
import { plural } from '../../../lib/format';

type Phase = "idle" | "download" | "verify" | "preflight" | "backup" | "extract" | "dependencies" | "selfcheck" | "activating" | "failed";
interface InstallState {
  phase: Phase;
  phaseText: string;
  version: string | null;
  from: string;
  error: string | null;
  detail: string | null;
  busy: boolean;
}
interface HistoryRow {
  id: number;
  at: string;
  from_version: string;
  to_version: string;
  status: "activated" | "rolled_back" | "failed";
  message: string;
  backup_file: string | null;
  restored: boolean;
  actor_name: string | null;
}
interface UpdatesInfo {
  current: string;
  image: { version: string; nodeMajor: number; postgresMajor: number | null; ffmpeg: boolean | null };
  runningFrom: "image" | "update";
  supervised: boolean;
  latest: { tag: string; version: string; name: string; notes: string; publishedAt: string | null; url: string; assets: { zip: unknown; sha256: unknown; sig: unknown } } | null;
  available: boolean;
  /** Das verfügbare Release braucht ein neueres Docker-Image (Hinweis aus den Versionshinweisen). */
  imageUpdate: { minImageVersion: string; imageVersion: string } | null;
  lastCheckAt: string | null;
  lastCheckError: string | null;
  settings: { enabled: boolean; repo: string; apiUrl: string; checkHours: number; tokenSet: boolean };
  signingKey: "ok" | "missing" | "invalid";
  state: InstallState;
  hostHelper: HostHelper;
  history: HistoryRow[];
}

/** Update-Helfer am Host (#226): Image-Updates aus der App anstoßen. */
type HostState = "running" | "success" | "failed" | "rolled_back" | "aborted" | "rejected";
type HostPhase = "verify" | "prepare" | "build" | "backup" | "switch" | "check" | "rollback" | "finish" | "done";
interface HostStatus {
  requestId: string | null;
  state: HostState;
  phase: HostPhase;
  step: string;
  targetVersion: string | null;
  fromVersion: string | null;
  image: string;
  backupFile: string;
  message: string;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  logTail: string;
  silent: boolean;
}
export interface HostHelper {
  installed: boolean;
  helperVersion: number | null;
  installedAt: string | null;
  request: { id: string; version: string; requestedAt: string; stale: boolean } | null;
  status: HostStatus | null;
  busy: boolean;
  nextRequestAt: string | null;
}

const HOST_STEPS: { id: HostPhase; label: string }[] = [
  { id: "verify", label: "Anfrage und signiertes Release prüfen" },
  { id: "prepare", label: "Programmcode holen" },
  { id: "build", label: "Image bauen (einige Minuten)" },
  { id: "backup", label: "Wartungsmodus und Sicherung" },
  { id: "switch", label: "Wechsel auf das neue Image" },
  { id: "check", label: "Prüfung (Healthcheck und Selbsttest)" },
  { id: "finish", label: "Abschluss" },
];

const STEPS: { id: Phase; label: string }[] = [
  { id: "download", label: "Release laden" },
  { id: "verify", label: "Prüfsumme, Signatur und Paket prüfen" },
  { id: "preflight", label: "Wartungsmodus und Vorabprüfung" },
  { id: "backup", label: "Datenbanksicherung" },
  { id: "extract", label: "Entpacken" },
  { id: "dependencies", label: "Abhängigkeiten übernehmen" },
  { id: "selfcheck", label: "Rauchtest der neuen Version" },
  { id: "activating", label: "Neustart und Umschaltung" },
];

const STATUS_TEXT: Record<HistoryRow["status"], { label: string; tone: "success" | "error" | "warning" }> = {
  activated: { label: "aktiviert", tone: "success" },
  rolled_back: { label: "zurückgerollt", tone: "warning" },
  failed: { label: "abgebrochen", tone: "error" },
};

export function useUpdatesInfo(enabled = true) {
  // Während ein Image-Update über den Helfer läuft, öfter nachfragen (Fortschritt, Neustart)
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => get<UpdatesInfo>("/updates"),
    enabled,
    refetchInterval: (q) => (q.state.data?.hostHelper?.busy ? 5_000 : 60_000),
    retry: (n) => n < 2,
  });
}

/** Hinweis „Update verfügbar“ (Systemstatus). */
export function UpdateAvailableNotice() {
  const { can } = useAuth();
  const q = useUpdatesInfo(can("update.view"));
  const d = q.data;
  if (!d?.available || !d.latest) return null;
  return (
    <Notice tone="info" icon="Download" title={`Update verfügbar: Version ${d.latest.version}`}>
      <p className="m-0">
        Installiert ist {d.current}.{d.imageUpdate && (d.hostHelper?.installed ? " Braucht ein neues Docker-Image – über den Update-Helfer in den Updates anstoßen." : " Braucht ein neues Docker-Image – Installation am Docker-Host.")} {can("settings.view") && <Link to="/einstellungen/updates">Zu den Updates</Link>}
      </p>
    </Notice>
  );
}

/** Einstellungen → Updates & Wartung: Quelle, Prüfung, Installation, Protokoll. */
export function UpdatesSection({ manage }: { manage: boolean }) {
  const q = useUpdatesInfo();
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const d = q.data;
  const [form, setForm] = useState<{ enabled: boolean; repo: string; apiUrl: string; checkHours: number | ""; token: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ version: string; from: string; historyId: number } | null>(null);

  useEffect(() => {
    if (d && !form) setForm({ ...d.settings, token: "" });
  }, [d, form]);
  // Läuft schon eine Installation (z. B. nach Neuladen der Seite)? Dann die Fortschrittsanzeige zeigen.
  useEffect(() => {
    if (d?.state.busy && !progress && d.state.version) setProgress({ version: d.state.version, from: d.state.from, historyId: d.history[0]?.id ?? 0 });
  }, [d, progress]);

  const dirty = !!(d && form) && (form.enabled !== d.settings.enabled || form.repo !== d.settings.repo || form.apiUrl !== d.settings.apiUrl || form.checkHours !== d.settings.checkHours || !!form.token);
  const hoursInvalid = !!form && (form.checkHours === "" || !Number.isInteger(form.checkHours) || form.checkHours < 1 || form.checkHours > 168);
  const repoInvalid = !!form && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(form.repo.trim());
  // Speichern über die Leiste der Seite (#256)
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const problems: SaveProblem[] = [...(repoInvalid ? [{ id: "u-repo", message: "GitHub-Repository: Format besitzer/name." }] : []), ...(hoursInvalid ? [{ id: "u-hours", message: "Prüfabstand: 1 bis 168 Stunden." }] : [])];
  useSaveSource({ dirty: manage && dirty, problems, save: () => saveRef.current(), discard: () => d && setForm({ ...d.settings, token: "" }) });

  // Mit vorhandenen Daten (z. B. Neustart während eines Image-Updates) weiter anzeigen statt nur den Fehler
  if (q.isError && !d) return <SectionCard id="updates" title="Updates"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!d || !form) return <SectionCard id="updates" title="Updates"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  /** Speichern (über die Leiste); `clearToken` nur über „Token entfernen“ – Fehler gehen dann in die Seite. */
  const persist = async (clearToken: boolean) => {
    const r = await put<{ tokenCleared: boolean }>("/updates/settings", {
      enabled: form.enabled,
      repo: form.repo.trim(),
      apiUrl: form.apiUrl.trim(),
      checkHours: Number(form.checkHours),
      ...(form.token.trim() ? { token: form.token.trim() } : {}),
      ...(clearToken ? { clearToken: true } : {}),
    });
    const fresh = await qc.fetchQuery({ queryKey: ["updates"], queryFn: () => get<UpdatesInfo>("/updates"), staleTime: 0 });
    setForm({ ...fresh.settings, token: "" });
    toast({ tone: "success", title: "Update-Einstellungen gespeichert", text: r.tokenCleared ? "Der bisherige Token wurde entfernt." : undefined });
  };
  saveRef.current = () => persist(false);
  const removeToken = async () => {
    setSaving(true);
    setError(null);
    try {
      await persist(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await post<{ ok: boolean; available: boolean; error?: string; latest: { version: string } | null }>("/updates/check");
      if (!r.ok) setError(r.error ?? "Prüfung fehlgeschlagen.");
      else toast({ tone: "success", title: r.available ? `Update verfügbar: Version ${r.latest!.version}` : r.latest ? "BlaulichtCMS ist aktuell" : "Noch kein Release veröffentlicht" });
      await q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const install = async () => {
    if (!d.latest) return;
    const ok = await ask({
      title: `Version ${d.latest.version} installieren?`,
      text: "BlaulichtCMS schaltet den Wartungsmodus ein, erstellt eine Datenbanksicherung und startet mit der neuen Version neu. Startet sie nicht, wird automatisch auf die laufende Version zurückgeschaltet. Während des Neustarts ist BlaulichtCMS etwa eine Minute nicht erreichbar.",
      confirmLabel: "Installieren",
    });
    if (!ok) return;
    setError(null);
    try {
      const r = await post<{ version: string; from: string }>("/updates/install", { version: d.latest.version });
      setProgress({ version: r.version, from: r.from, historyId: d.history[0]?.id ?? 0 });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const blockers: string[] = [];
  if (!d.supervised) blockers.push("In-App-Updates brauchen den Containerbetrieb (Supervisor). Hier bitte am Host aktualisieren.");
  if (d.signingKey !== "ok") blockers.push("In dieser Version ist kein gültiger öffentlicher Signaturschlüssel hinterlegt – Updates werden abgelehnt.");

  return (
    <SectionCard
      id="updates"
      title="Updates"
      description="Neue Versionen aus GitHub-Releases prüfen und installieren. Installiert wird nur von Hand und nur mit gültiger Signatur."
      bodyClassName="flex flex-col gap-4"
    >
      <dl className="m-0 grid gap-x-6 gap-y-2 grid-cols-[max-content_1fr] text-sm">
        <dt className="text-fg-muted">Laufende Version</dt>
        <dd className="m-0 font-mono">
          {d.current} <span className="text-fg-muted font-sans">({d.runningFrom === "update" ? `In-App-Update, Image ${d.image.version}` : "aus dem Image"})</span>
        </dd>
        <dt className="text-fg-muted">Neuestes Release</dt>
        <dd className="m-0">
          {d.latest ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono">{d.latest.version}</span>
              {d.available ? <Badge tone="warning">Update verfügbar</Badge> : <Badge tone="success">aktuell</Badge>}
              {d.latest.publishedAt && <span className="text-fg-muted">veröffentlicht {fmtDateTime(d.latest.publishedAt)}</span>}
            </span>
          ) : d.lastCheckAt && !d.lastCheckError ? (
            "noch kein Release veröffentlicht"
          ) : (
            "–"
          )}
        </dd>
        <dt className="text-fg-muted">Letzte Prüfung</dt>
        <dd className="m-0">{d.lastCheckAt ? fmtRelative(d.lastCheckAt) : "noch nie"}</dd>
        <dt className="text-fg-muted">Update-Helfer</dt>
        <dd className="m-0">
          {d.hostHelper?.installed ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone="success">eingerichtet</Badge>
              {d.hostHelper.installedAt && <span className="text-fg-muted">seit {fmtDateTime(d.hostHelper.installedAt)}</span>}
            </span>
          ) : (
            <span className="text-fg-muted">nicht eingerichtet – Image-Updates am Docker-Host</span>
          )}
        </dd>
      </dl>
      {d.lastCheckError && <ErrorBox title="Letzte Prüfung fehlgeschlagen">{d.lastCheckError}</ErrorBox>}
      {error && <ErrorBox title="Aktion fehlgeschlagen">{error}</ErrorBox>}
      {d.state.phase === "failed" && d.state.error && !progress && <ErrorBox title={`Installation von Version ${d.state.version} abgebrochen`}>{d.state.error}</ErrorBox>}
      {blockers.map((b) => (
        <Notice key={b} tone="warning">{b}</Notice>
      ))}
      <HostUpdateProgress helper={d.hostHelper} current={d.current} offline={q.isError} manage={manage} onChanged={() => q.refetch()} />

      {d.available && d.latest && (
        <div className="border border-line rounded-card p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong>Update verfügbar: Version {d.latest.version}</strong>
            {d.latest.url && (
              <a href={d.latest.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm">
                <Icon name="ExternalLink" size={13} /> Release auf GitHub
              </a>
            )}
          </div>
          {d.latest.notes ? <Markdown source={d.latest.notes} className="text-sm max-h-[320px] overflow-auto" /> : <p className="m-0 text-sm text-fg-muted">Keine Versionshinweise.</p>}
          {d.imageUpdate ? (
            <ImageUpdateSteps version={d.latest.version} need={d.imageUpdate} helper={d.hostHelper} manage={manage} onRequested={() => q.refetch()} />
          ) : manage && (
            <div>
              <Button variant="primary" icon="Download" onClick={install} disabled={blockers.length > 0 || d.state.busy}>
                Version {d.latest.version} installieren
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-sm font-semibold">Quelle und Prüfung</h3>
        <Switch checked={form.enabled} disabled={!manage} onChange={(x) => setForm({ ...form, enabled: x })} label="Automatisch auf neue Versionen prüfen" description="Fragt im eingestellten Abstand das neueste Release ab und benachrichtigt die Administration einmal je neuer Version. Installiert wird nie automatisch." />
        <FieldGrid>
          <FieldWrap label="GitHub-Repository" htmlFor="u-repo" labelAction={
            <HelpTip title="GitHub-Repository" more="/hilfe/updates#update-in-der-oberflaeche">
              <p className="m-0">Besitzer und Name aus der Adresse des Repositorys: <code className="font-mono">github.com/besitzer/name</code> → <code className="font-mono">besitzer/name</code>. Standard ist das offizielle Repository; angenommen werden nur signierte Pakete.</p>
            </HelpTip>
          } help="Format besitzer/name." error={repoInvalid ? "Format: besitzer/name" : null}>
            <Input id="u-repo" mono disabled={!manage} value={form.repo} maxLength={201} invalid={repoInvalid} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Prüfabstand" htmlFor="u-hours" help="1 bis 168 Stunden." error={hoursInvalid ? "1 bis 168 Stunden" : null}>
            <Input id="u-hours" type="number" inputMode="numeric" min={1} max={168} step={1} disabled={!manage} invalid={hoursInvalid} value={form.checkHours} onChange={(e) => setForm({ ...form, checkHours: e.target.value === "" ? "" : Number(e.target.value) })} />
          </FieldWrap>
          <FieldWrap label="API-Adresse" htmlFor="u-api" help="Standard: https://api.github.com. Bei einem anderen Server muss ein Token neu eingegeben werden.">
            <Input id="u-api" mono disabled={!manage} value={form.apiUrl} maxLength={300} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Zugriffstoken (optional)" htmlFor="u-token" labelAction={
            <HelpTip title="Zugriffstoken" more="/hilfe/updates#zugriffstoken-fuer-private-repositories">
              <p className="m-0">Nur für private Repositories. Auf GitHub einen <strong>Fine-grained Token</strong> nur für dieses Repository mit <strong>Contents: Read-only</strong> erzeugen (<HelpLink href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens">Anleitung von GitHub</HelpLink>).</p>
            </HelpTip>
          } help={d.settings.tokenSet ? "Ein Token ist gespeichert. Leer lassen, um ihn zu behalten." : "Nur für private Repositories nötig. Öffentliche Repositories brauchen keine Anmeldung."}>
            <Input id="u-token" type="password" autoComplete="off" disabled={!manage} value={form.token} maxLength={500} placeholder={d.settings.tokenSet ? "gespeichert" : ""} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </FieldWrap>
        </FieldGrid>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {d.settings.tokenSet && (
              <Button icon="Trash2" loading={saving} disabled={dirty} aria-describedby={dirty ? "u-check-why" : undefined} onClick={removeToken}>
                Token entfernen
              </Button>
            )}
            <Button icon="RefreshCw" loading={checking} disabled={dirty} aria-describedby={dirty ? "u-check-why" : undefined} onClick={check}>
              Jetzt prüfen
            </Button>
            {dirty && (
              <span id="u-check-why" className="text-sm text-fg-muted self-center">
                Erst die Änderungen speichern (Leiste unten).
              </span>
            )}
          </div>
        )}
      </div>

      <UpdateHistory rows={d.history} />

      <p className="m-0 text-sm text-fg-muted">
        Neue Basis-Images, PostgreSQL- oder Node.js-Versionen und geänderte Abhängigkeiten kommen weiterhin über das Skript am Docker-Host (sudo bash install.sh).{" "}
        <Link to="/hilfe/updates">Ablauf und Rückweg</Link>
      </p>

      {progress && (
        <UpdateProgress
          target={progress}
          onClose={() => {
            setProgress(null);
            qc.invalidateQueries();
          }}
        />
      )}
    </SectionCard>
  );
}

const INSTALL_CMD = "sudo bash /opt/apps/blaulichtcms/install.sh";

/**
 * Das Release braucht ein neueres Image: Mit eingerichtetem Update-Helfer (#226) lässt es sich hier anstoßen, sonst
 * Schritte am Docker-Host.
 */
function ImageUpdateSteps({ version, need, helper, manage, onRequested }: { version: string; need: { minImageVersion: string; imageVersion: string }; helper: HostHelper; manage: boolean; onRequested: () => void }) {
  const ask = useConfirm();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    const ok = await ask({
      title: `Image-Update auf Version ${version} anstoßen?`,
      text: "Der Update-Helfer am Docker-Host prüft das signierte Release, baut das neue Image (einige Minuten), schaltet den Wartungsmodus ein, sichert alles und wechselt. Startet die neue Version nicht sauber, geht er automatisch auf den bisherigen Stand zurück. Während Sicherung und Wechsel ist BlaulichtCMS einige Minuten nicht erreichbar.",
      confirmLabel: "Image-Update anstoßen",
    });
    if (!ok) return;
    setSending(true);
    setError(null);
    try {
      await post("/updates/host-request", { version });
      toast({ tone: "success", title: "Image-Update angestoßen", text: "Der Fortschritt erscheint oben auf dieser Seite." });
      onRequested();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const steps = (
    <ol className="m-0 mt-2 pl-5 list-decimal flex flex-col gap-1.5">
        <li>Am Docker-Host anmelden (z. B. per SSH).</li>
        <li>
          Das Installationsskript ausführen (bei einem anderen Installationsordner dessen <code className="font-mono">install.sh</code>):
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <code className="font-mono text-fg bg-card border border-line rounded-chip px-2 py-1 break-all">{INSTALL_CMD}</code>
            <CopyButton size="sm" value={INSTALL_CMD} label="Befehl kopieren" />
          </span>
        </li>
        <li>Das Skript holt Version {version}, baut das Image (einige Minuten), schaltet den Wartungsmodus ein, sichert alles und wechselt – bei einem Fehler automatisch zurück. Daten, Einstellungen und .env bleiben erhalten; beim Wechsel ist BlaulichtCMS etwa eine Minute nicht erreichbar.</li>
        <li>Danach diese Seite neu laden: Als laufende Version steht {version} „aus dem Image“.</li>
    </ol>
  );
  const wait = helper.nextRequestAt ? Math.max(1, Math.ceil((Date.parse(helper.nextRequestAt) - Date.now()) / 60_000)) : 0;
  return (
    <Notice tone="warning" title="Neues Docker-Image nötig">
      <p className="m-0">
        Version {version} braucht mindestens Image {need.minImageVersion}, der Container läuft mit Image {need.imageVersion}. Geänderte Abhängigkeiten und Änderungen am Container kommen nur mit einem neu gebauten Image an.
      </p>
      {helper.installed ? (
        <>
          <p className="m-0 mt-2">
            Der <strong className="text-fg">Update-Helfer</strong> am Docker-Host ist eingerichtet: Er prüft das signierte Release, baut das Image, sichert alles und wechselt – bei einem Fehler automatisch zurück. Daten, Einstellungen und .env bleiben erhalten.
          </p>
          {error && <ErrorBox className="mt-2" title="Anfrage nicht gestellt">{error}</ErrorBox>}
          {manage && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="primary" icon="Box" loading={sending} disabled={helper.busy || wait > 0} onClick={request}>
                Image-Update auf {version} anstoßen
              </Button>
              {helper.busy && <span className="text-sm">Es läuft bereits ein Image-Update.</span>}
              {!helper.busy && wait > 0 && <span className="text-sm">Höchstens eine Anfrage je 10 Minuten – wieder möglich in {plural(wait, 'Minute', 'Minuten')}.</span>}
            </div>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer">Alternativ von Hand am Docker-Host</summary>
            {steps}
          </details>
        </>
      ) : (
        <>
          <p className="m-0 mt-1">In der Oberfläche lässt sich dieses Update nicht installieren – bitte am Docker-Host:</p>
          {steps}
          <p className="m-0 mt-2">
            Tipp: Mit dem Update-Helfer lassen sich solche Updates künftig hier anstoßen, ohne dem Container Zugriff auf Docker zu geben. Einrichten einmalig am Host: das Installationsskript ausführen und die Frage nach dem Update-Helfer bejahen (kommt keine Frage, das Skript nach dem Update noch einmal ausführen).
          </p>
        </>
      )}
      <p className="m-0 mt-2">
        <Link to="/hilfe/updates#wenn-ein-update-ein-neues-image-braucht">Ablauf in der Hilfe</Link>
      </p>
    </Notice>
  );
}

const HOST_RESULT: Record<Exclude<HostState, "running">, { tone: "success" | "warning" | "error"; title: (v: string) => string }> = {
  success: { tone: "success", title: (v) => `Image-Update auf Version ${v} abgeschlossen` },
  rolled_back: { tone: "warning", title: (v) => `Image-Update auf Version ${v} zurückgenommen – es läuft wieder die bisherige Version` },
  aborted: { tone: "warning", title: (v) => `Image-Update auf Version ${v} abgebrochen – die bisherige Version läuft weiter` },
  rejected: { tone: "warning", title: () => "Image-Update vom Update-Helfer abgelehnt" },
  failed: { tone: "error", title: (v) => `Image-Update auf Version ${v} fehlgeschlagen – Handeln am Host nötig` },
};

/** Ausgeblendetes Ergebnis des Update-Helfers (je Gerät; das Update-Protokoll behält alles). */
const HOST_RESULT_SEEN = "bc-host-update-seen";
const hostResultKey = (st: HostStatus) => st.requestId ?? st.finishedAt ?? "";
const seenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(HOST_RESULT_SEEN);
    } catch {
      return null;
    }
  },
  set(v: string) {
    try {
      localStorage.setItem(HOST_RESULT_SEEN, v);
    } catch {
      /* privat/gesperrt */
    }
  },
};

/** Fortschritt und Ergebnis eines Image-Updates über den Update-Helfer (Statusdatei des Helfers, #226). */
function HostUpdateProgress({ helper, current, offline, manage, onChanged }: { helper: HostHelper; current: string; offline: boolean; manage: boolean; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  // Version, mit der diese Oberfläche geladen wurde: Nur wenn der Server inzwischen eine andere meldet, hilft Neuladen
  const [loadedVersion] = useState(current);
  const [seen, setSeen] = useState(seenStore.get);
  const st = helper.status;
  const req = helper.request;
  // Ergebnisse bleiben einen Tag sichtbar (danach steht es im Update-Protokoll), bis sie ausgeblendet werden
  const recent = st && st.state !== "running" && st.finishedAt && Date.now() - Date.parse(st.finishedAt) < 24 * 3600_000;
  const dismissed = st && st.state !== "running" && st.state !== "failed" && seen === hostResultKey(st);
  const showStatus = st && (st.state === "running" || (recent && !dismissed)) && !(req && st.requestId !== req.id);
  if (!req && !showStatus) return null;
  const cancel = async () => {
    setCancelling(true);
    try {
      await del("/updates/host-request");
    } finally {
      setCancelling(false);
      onChanged();
    }
  };
  const log = st?.logTail ? (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">Protokollauszug</summary>
      <pre className="m-0 mt-1 p-3 rounded-control bg-raised border border-line text-[12px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{st.logTail}</pre>
    </details>
  ) : null;

  if (req && (!st || st.requestId !== req.id)) {
    return req.stale ? (
      <Notice tone="warning" title="Der Update-Helfer hat die Anfrage nicht angenommen">
        <p className="m-0">
          Die Anfrage für Version {req.version} liegt seit {fmtRelative(req.requestedAt)} bereit. Läuft der Helfer am Host? Prüfen mit <code className="font-mono">systemctl status blaulichtcms-update.path</code>, Protokoll in <code className="font-mono">/var/log/blaulichtcms-update.log</code>.
        </p>
        {manage && (
          <div className="mt-2">
            <Button size="sm" icon="X" loading={cancelling} onClick={cancel}>
              Anfrage zurückziehen
            </Button>
          </div>
        )}
      </Notice>
    ) : (
      <Notice tone="info" icon="Hourglass" title={`Image-Update auf Version ${req.version} angefragt`}>
        <p className="m-0">Der Update-Helfer am Host übernimmt die Anfrage in wenigen Sekunden.</p>
      </Notice>
    );
  }
  if (!st) return null;
  const target = st.targetVersion ?? "?";
  if (st.state !== "running") {
    const r = HOST_RESULT[st.state];
    const hide = () => {
      seenStore.set(hostResultKey(st));
      setSeen(hostResultKey(st));
    };
    // Neuladen nur anbieten, solange diese Oberfläche noch von der alten Version stammt
    const reload = st.state === "success" && loadedVersion !== target;
    const body = (
      <>
        <p className="m-0">{st.message}</p>
        <p className="m-0 mt-1 text-meta">
          {st.finishedAt && `Beendet ${fmtDateTime(st.finishedAt)}`}
          {st.backupFile && ` · Sicherung vor dem Update: ${st.backupFile}`}
        </p>
        {st.state === "success" && current !== target && <p className="m-0 mt-1">Die neue Version startet gerade – gleich die Seite neu laden.</p>}
        {log}
      </>
    );
    return r.tone === "error" ? (
      <ErrorBox title={r.title(target)}>{body}</ErrorBox>
    ) : (
      <Notice tone={r.tone} title={r.title(target)}>
        {body}
        <div className="mt-2 flex flex-wrap gap-2">
          {reload ? (
            <Button
              size="sm"
              icon="RefreshCw"
              onClick={() => {
                hide();
                location.reload();
              }}
            >
              Seite neu laden
            </Button>
          ) : (
            <Button size="sm" icon="X" onClick={hide}>
              Ausblenden
            </Button>
          )}
        </div>
      </Notice>
    );
  }
  const idx = st.phase === "rollback" ? HOST_STEPS.length : HOST_STEPS.findIndex((s) => s.id === st.phase);
  return (
    <div className="border border-line rounded-card p-4 flex flex-col gap-3" aria-live="polite">
      <strong>Image-Update auf Version {target} läuft</strong>
      <ol className="m-0 p-0 list-none flex flex-col gap-1.5 text-sm">
        {HOST_STEPS.map((s, i) => (
          <li key={s.id} className={cx("flex items-center gap-2", i > idx && "text-fg-muted")}>
            <Icon name={i < idx ? "CheckCircle2" : i === idx ? "Hourglass" : "CircleDashed"} size={15} className={i < idx ? "text-ok" : i === idx ? "text-primary" : ""} />
            {s.label}
          </li>
        ))}
        {st.phase === "rollback" && (
          <li className="flex items-center gap-2 text-warn">
            <Icon name="Undo2" size={15} />
            Rückweg: bisheriges Image und Datenstand von vor dem Update
          </li>
        )}
      </ol>
      <p className="m-0 text-sm text-fg-muted">
        Aktueller Schritt: {st.step || "–"}
        {st.updatedAt && ` (Stand ${fmtRelative(st.updatedAt)})`}
      </p>
      {offline && <Notice tone="info">BlaulichtCMS ist während Sicherung und Wechsel kurz nicht erreichbar – die Anzeige aktualisiert sich von selbst.</Notice>}
      {st.silent && <Notice tone="warning">Der Update-Helfer meldet sich seit über 10 Minuten nicht. Am Host prüfen: <code className="font-mono">systemctl status blaulichtcms-update</code> und /var/log/blaulichtcms-update.log.</Notice>}
      {log}
    </div>
  );
}

function UpdateHistory({ rows }: { rows: HistoryRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">Update-Protokoll</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Noch keine In-App-Updates.</p>
      ) : (
        <div className="border border-line rounded-node overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Zeitpunkt</Th>
                <Th>Version</Th>
                <Th>Ergebnis</Th>
                <Th>Meldung</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="text-meta whitespace-nowrap">{fmtDateTime(r.at)}</Td>
                  <Td mono className="whitespace-nowrap">
                    {r.from_version} → {r.to_version}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TEXT[r.status].tone}>{STATUS_TEXT[r.status].label}</Badge>
                    {r.actor_name && <span className="block text-[11px] text-fg-muted mt-0.5">{r.actor_name}</span>}
                  </Td>
                  <Td className="text-sm max-w-[420px]">
                    {r.message}
                    {r.restored && <span className="block text-[11px] text-fg-muted">Datenbank aus Sicherung zurückgespielt</span>}
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

/**
 * Fortschritt und Neustart: fragt den Installationsstand ab, wartet beim Neustart auf /healthz und zeigt das Ergebnis
 * aus dem Update-Protokoll (aktiviert oder zurückgerollt mit Grund).
 */
function UpdateProgress({ target, onClose }: { target: { version: string; from: string; historyId: number }; onClose: () => void }) {
  const [state, setState] = useState<InstallState | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<HistoryRow | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      setWaited(Math.round((Date.now() - started) / 1000));
      try {
        const s = await get<{ current: string; state: InstallState }>("/updates/status");
        setState(s.state);
        if (s.state.phase === "failed") {
          setFailed(s.state.error ?? "Installation abgebrochen.");
          return;
        }
        // Neue API antwortet (aktiviert) oder alte nach dem Rückweg: Ergebnis steht im Protokoll
        if (s.state.phase === "idle" || s.current !== target.from) {
          const info = await get<UpdatesInfo>("/updates");
          const row = info.history.find((h) => h.id > target.historyId && h.to_version === target.version);
          if (row) {
            setResult(row);
            return;
          }
        }
      } catch {
        // API startet neu
        setRestarting(true);
        try {
          await fetch("/healthz", { cache: "no-store" });
        } catch {
          /* noch nicht erreichbar */
        }
      }
      setTimeout(tick, 2_000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [target]);

  const current = state?.phase ?? "download";
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim p-4" role="presentation">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="upd-title" className="w-full max-w-[560px] bg-card border border-line rounded-card shadow-float p-5 flex flex-col gap-4 outline-none">
        <h2 id="upd-title" className="m-0 text-section font-semibold">
          Update auf Version {target.version}
        </h2>
        {result ? (
          result.status === "activated" ? (
            <Notice tone="success" title={`Version ${result.to_version} ist aktiviert`}>
              <p className="m-0">{result.message}</p>
              <p className="m-0 mt-1">Bitte die Seite neu laden, damit die Oberfläche der neuen Version geladen wird.</p>
            </Notice>
          ) : (
            <Notice tone="warning" title={`Zurückgerollt – es läuft wieder ${result.from_version}`}>
              <p className="m-0">{result.message}</p>
            </Notice>
          )
        ) : failed ? (
          <ErrorBox title="Installation abgebrochen">
            <p className="m-0">{failed}</p>
            <p className="m-0 mt-1">Die laufende Version ist unverändert.</p>
          </ErrorBox>
        ) : (
          <>
            <ol className="m-0 p-0 list-none flex flex-col gap-1.5 text-sm" aria-live="polite">
              {STEPS.map((s, i) => (
                <li key={s.id} className={cx("flex items-center gap-2", i > idx && "text-fg-muted")}>
                  <Icon name={i < idx ? "CheckCircle2" : i === idx ? "Hourglass" : "CircleDashed"} size={15} className={i < idx ? "text-ok" : i === idx ? "text-primary" : ""} />
                  {s.label}
                </li>
              ))}
            </ol>
            <p className="m-0 text-sm text-fg-muted">
              {restarting ? `BlaulichtCMS startet neu … (${waited} s)` : (state?.detail ?? "Bitte dieses Fenster geöffnet lassen.")}
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          {result?.status === "activated" ? (
            <Button variant="primary" icon="RefreshCw" onClick={() => location.reload()}>
              Neu laden
            </Button>
          ) : (
            <Button onClick={onClose} disabled={!result && !failed}>
              Schließen
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Update vorbereiten: Vorabprüfung und Zustand des Wartungsmodus. Geschaltet wird der Wartungsmodus an genau einer
 * Stelle – im Systemstatus (Recht „Wartungsmodus schalten“ setzt nur „Systemzustand ansehen“ voraus, #256).
 */
function UpdatePreflight() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["update-preflight"], queryFn: () => get<any>("/system/update-preflight"), refetchInterval: 10_000 });
  const d = q.data;
  if (q.isError) return <SectionCard id="vorbereiten" title="Update vorbereiten"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!d) return null;
  const on = d.checks.find((c: any) => c.id === "maintenance")?.ok;
  return (
    <SectionCard
      id="vorbereiten"
      title="Update vorbereiten"
      description="Vorabprüfung für Updates am Docker-Host: Wartungsmodus an, laufende Vorgänge abgeschlossen, Sicherung aktuell."
      action={<Badge tone={d.ready ? "success" : on ? "warning" : "neutral"}>{d.ready ? "bereit für das Update" : on ? "wartet auf laufende Vorgänge" : "Normalbetrieb"}</Badge>}
      bodyClassName="flex flex-col gap-3"
    >
      <p className="m-0 text-meta text-fg-muted">BlaulichtCMS {d.version} · PostgreSQL {d.postgres} · {d.migrations} Migrationen</p>
      <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
        {d.checks.map((c: any) => (
          <li key={c.id} className="flex gap-2 items-start">
            <Icon name={c.ok ? "CheckCircle2" : c.blocking ? "XCircle" : "AlertTriangle"} size={15} className={c.ok ? "text-ok mt-0.5" : c.blocking ? "text-err mt-0.5" : "text-warn mt-0.5"} />
            <span>
              {c.label} <span className="text-fg-muted">– {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="Hourglass" size={14} className="text-fg-muted" />
          Wartungsmodus: <strong>{on ? "aktiv" : "aus"}</strong>
          {can("system.maintenance") && can("system.status") && (
            <>
              {" – "}
              <Link to="/system#wartungsmodus">{on ? "im Systemstatus beenden" : "im Systemstatus einschalten"}</Link>
            </>
          )}
        </span>
        <Link to="/hilfe/updates" className="inline-flex items-center gap-1">
          <Icon name="BookOpen" size={13} /> Ablauf: Sichern → Wechseln → Prüfen → Wiederherstellen
        </Link>
      </div>
    </SectionCard>
  );
}

/** Einstellungen → Updates & Wartung (#256): Updates, Vorabprüfung, Zustand des Wartungsmodus. */
export function UpdatesPage() {
  const { can } = useAuth();
  return (
    <>
      <UpdatesSection manage={can("update.install")} />
      {can("update.install") && <UpdatePreflight />}
    </>
  );
}
