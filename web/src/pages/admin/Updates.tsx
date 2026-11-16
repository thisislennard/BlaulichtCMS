import { useEffect, useRef, useState } from "react";
import { HelpLink, HelpTip } from "../../components/ui/HelpTip";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, put } from "../../api/client";
import { Badge, Button, ErrorBox, FieldWrap, Input, Notice, Switch, Table, Td, Th, cx } from "../../components/ui/core";
import { useConfirm, useToast } from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { Markdown } from "../help/Markdown";
import { FieldGrid, LoadError, SectionCard } from "./shared";

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
  lastCheckAt: string | null;
  lastCheckError: string | null;
  settings: { enabled: boolean; repo: string; apiUrl: string; checkHours: number; tokenSet: boolean };
  signingKey: "ok" | "missing" | "invalid";
  state: InstallState;
  history: HistoryRow[];
}

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
  return useQuery({ queryKey: ["updates"], queryFn: () => get<UpdatesInfo>("/updates"), enabled, refetchInterval: 60_000 });
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
        Installiert ist {d.current}. {can("settings.view") && <Link to="/einstellungen#updates">Zu den Updates</Link>}
      </p>
    </Notice>
  );
}

/** Einstellungen → Updates: Quelle, Prüfung, Installation, Protokoll. */
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

  if (q.isError) return <SectionCard id="updates" title="Updates"><LoadError error={q.error} onRetry={() => q.refetch()} /></SectionCard>;
  if (!d || !form) return <SectionCard id="updates" title="Updates"><p className="m-0 text-sm text-fg-muted">Wird geladen …</p></SectionCard>;

  const dirty = form.enabled !== d.settings.enabled || form.repo !== d.settings.repo || form.apiUrl !== d.settings.apiUrl || form.checkHours !== d.settings.checkHours || !!form.token;
  const hoursInvalid = form.checkHours === "" || !Number.isInteger(form.checkHours) || form.checkHours < 1 || form.checkHours > 168;
  const repoInvalid = !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(form.repo.trim());

  const save = async (clearToken = false) => {
    setSaving(true);
    setError(null);
    try {
      const r = await put<{ tokenCleared: boolean }>("/updates/settings", {
        enabled: form.enabled,
        repo: form.repo.trim(),
        apiUrl: form.apiUrl.trim(),
        checkHours: Number(form.checkHours),
        ...(form.token.trim() ? { token: form.token.trim() } : {}),
        ...(clearToken ? { clearToken: true } : {}),
      });
      const fresh = await qc.fetchQuery({ queryKey: ["updates"], queryFn: () => get<UpdatesInfo>("/updates") });
      setForm({ ...fresh.settings, token: "" });
      toast({ tone: "success", title: "Update-Einstellungen gespeichert", text: r.tokenCleared ? "Der bisherige Token wurde entfernt." : undefined });
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
              {d.available ? <Badge tone="primary">Update verfügbar</Badge> : <Badge tone="success">aktuell</Badge>}
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
      </dl>
      {d.lastCheckError && <ErrorBox title="Letzte Prüfung fehlgeschlagen">{d.lastCheckError}</ErrorBox>}
      {error && <ErrorBox title="Aktion fehlgeschlagen">{error}</ErrorBox>}
      {d.state.phase === "failed" && d.state.error && !progress && <ErrorBox title={`Installation von Version ${d.state.version} abgebrochen`}>{d.state.error}</ErrorBox>}
      {blockers.map((b) => (
        <Notice key={b} tone="warning">{b}</Notice>
      ))}

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
          {manage && (
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
            <Button variant="primary" icon="Save" loading={saving} disabled={!dirty || hoursInvalid || repoInvalid} onClick={() => save()}>
              Speichern
            </Button>
            {d.settings.tokenSet && (
              <Button icon="Trash2" disabled={saving} onClick={() => save(true)}>
                Token entfernen
              </Button>
            )}
            <Button icon="RefreshCw" loading={checking} disabled={dirty} onClick={check}>
              Jetzt prüfen
            </Button>
            {dirty && <span className="text-sm text-fg-muted self-center">Erst speichern, dann prüfen.</span>}
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
