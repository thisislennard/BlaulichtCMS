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
import { CopyButton, UnsavedChangesGuard, useToast, useConfirm } from "../../components/ui/overlays";
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
import { UpdatesSection } from "./Updates";

type Values = Record<string, any>;
interface SettingsResponse {
  settings: Values;
  env: {
    publicUrl: string | null;
    cookieSecure: boolean;
    trustedProxies: string[];
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
  "datenschutz",
  "medien",
  "betrieb",
  "sicherheit",
  "sicherung",
  "updates",
  "ueber",
] as const;
/** Erlaubte Bereiche (Spiegel von SETTING_RANGES im Server, Gleichstand prüft units.test.ts) – Speichern erst, wenn alle Zahlen passen. */
const RANGES: Record<string, [number, number]> = {
  'security.session_idle_minutes': [5, 1440],
  'security.session_max_hours': [1, 720],
  'security.remember_days': [1, 180],
  'security.mfa_remember_days': [1, 90],
  'security.lockout_attempts': [3, 20],
  'security.lockout_minutes': [1, 1440],
  'security.password_min_length': [10, 128],
  'invites.valid_hours': [1, 720],
  'jobs.concurrency': [1, 32],
  'retention.log_days': [1, 3650],
  'security.alert_failed_logins': [0, 10000],
  'security.alert_downloads': [0, 100000],
  'retention.audit_days': [30, 3650],
  'privacy.upload_ip_retention_days': [1, 365],
  'privacy.collection_retention_days': [0, 3650],
  'privacy.deleted_media_days': [0, 3650],
  'privacy.fe2_event_days': [0, 3650],
  'privacy.warning_days': [0, 3650],
  'privacy.official_warning_days': [0, 3650],
  'privacy.upload_link_days': [0, 3650],
  'privacy.uploader_months': [0, 120],
  'media.blocked_days': [0, 3650],
  'media.security_log_days': [0, 3650],
  'media.max_file_mb': [1, 20000],
  'media.link_max_files': [1, 1000],
  'media.link_default_days': [1, 90],
  'media.link_max_days': [1, 365],
  'media.storage_warn_gb': [0, 100000],
  'media.collection_max_files': [1, 100000],
  'media.collection_max_gb': [1, 10000],
  'media.min_free_gb': [1, 10000],
  'media.max_video_minutes': [1, 600],
  'smtp.port': [1, 65535],
  'backup.hour': [0, 23],
  'backup.keep': [1, 365],
  'updates.check_hours': [1, 168],
};

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

  const set = (k: string, v: unknown) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  const invalidNumbers =
    !!draft &&
    Object.entries(draft).some(
      ([k, x]) =>
        typeof server?.[k] === "number" &&
        (x === "" ||
          !Number.isInteger(Number(x)) ||
          (RANGES[k] && (Number(x) < RANGES[k][0] || Number(x) > RANGES[k][1]))),
    );
  const emptyName = !!draft && typeof draft["general.instance_name"] === "string" && !String(draft["general.instance_name"]).trim();

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
      <UnsavedChangesGuard when={dirty} text="Es gibt ungespeicherte Einstellungen. Beim Verlassen gehen sie verloren." />
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
                  ? "bg-raised !text-fg font-semibold"
                  : "!text-fg-muted hover:bg-raised hover:!text-fg",
              )}
            >
              {t(`admin.settings.sections.${s}`)}
            </a>
          ))}
        </nav>

        <div className="flex-1 min-w-0 max-w-[860px] flex flex-col gap-[18px]">
          {ro && (
            <Notice icon="Lock">
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
                title={t("admin.settings.sections.redaktion")}
                description="Freigaben, Einladungen und Aufbewahrung."
                bodyClassName="flex flex-col gap-5"
              >
                <Switch
                  checked={!!v["editorial.four_eyes"]}
                  disabled={ro}
                  onChange={(x) => set("editorial.four_eyes", x)}
                  label="Vier-Augen-Prinzip"
                  description="Wer am Inhalt geschrieben oder die Fassung eingereicht hat, darf sie nicht selbst freigeben. Gilt für Beiträge, Banner und Warnentwürfe."
                />
                <FieldGrid>
                  <NumField k="invites.valid_hours" label="Einladungen gültig" unit="Std." min={1} max={720} v={v} set={set} ro={ro} />
                  <NumField k="jobs.concurrency" label="Parallele Hintergrundaufträge" help="1 bis 32 (Medienprüfung, Exporte)." min={1} max={32} v={v} set={set} ro={ro} />
                  <NumField k="retention.log_days" label={t("admin.settings.retLogs")} unit={t("admin.common.days")} min={1} v={v} set={set} ro={ro} />
                  <NumField k="retention.audit_days" label={t("admin.settings.retAudit")} unit={t("admin.common.days")} min={30} v={v} set={set} ro={ro} />
                  <NumField k="privacy.upload_ip_retention_days" label="IP-Adressen ohne Konto" help="Öffentliche Uploads und Anmeldeversuche unbekannter Konten: IP danach im Audit entfernt (1 bis 365 Tage)." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                </FieldGrid>
              </SectionCard>

              {/* Datenschutz (#96 Informationspflichten) */}
              <SectionCard
                id="datenschutz"
                title={t("admin.settings.sections.datenschutz")}
                description="Angaben nach Art. 13 DSGVO für Upload-Seite und Aushang sowie Löschfristen."
                bodyClassName="flex flex-col gap-5"
              >
                {(!String(v["privacy.controller"] ?? "").trim() || !String(v["privacy.policy_url"] ?? "").trim()) && (
                  <Notice tone="warning" title="Pflichtangaben fehlen">
                    Ohne verantwortliche Stelle und Datenschutzerklärung zeigt die Upload-Seite nur den allgemeinen Hinweis; angemeldete Verwaltung sieht dort eine Erinnerung.
                  </Notice>
                )}
                <FieldGrid>
                  <TextField k="privacy.controller" label="Verantwortliche Stelle" help="Name und Anschrift, z. B. „Gemeinde Musterstadt, Hauptstraße 1, 12345 Musterstadt“." max={400} v={v} set={set} ro={ro} />
                  <TextField k="privacy.dpo_contact" label="Datenschutzbeauftragte/r (Kontakt)" help="E-Mail-Adresse oder Anschrift; leer lassen, wenn keine Benennung besteht." max={300} v={v} set={set} ro={ro} />
                  <TextField k="privacy.policy_url" label="Datenschutzerklärung (Adresse)" help="Vollständige Adresse mit https://. Wird auf Upload-Seite und Aushang verlinkt." max={500} v={v} set={set} ro={ro} />
                </FieldGrid>
                <FieldGrid>
                  <NumField k="privacy.collection_retention_days" label="Abgeschlossene Sammlungen löschen nach" help="Archivierte Sammlungen bzw. Sammlungen ohne aktiven Link, gerechnet ab der letzten Aktivität. Dateien in laufenden Beiträgen bleiben. 0 = nie." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                  <NumField k="privacy.deleted_media_days" label="Papierkorb leeren nach" help="Gelöschte Dateien, Ordner und Sammlungen bleiben so lange im Papierkorb wiederherstellbar; danach werden Dateien und Datensätze endgültig entfernt. Gilt auch für Datensätze abgewiesener Dateien. 0 = nie automatisch." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                  <NumField k="privacy.upload_link_days" label="Abgelaufene Upload-Links" help="Abgelaufene oder widerrufene Links (Token, Bezeichnung) und Weiterleitungen aus dem Import. 0 = nie." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                  <NumField k="media.blocked_days" label="Gesperrte Dateien löschen nach" help="Dateien mit Prüfbefund liegen so lange in der Quarantäne (erneut prüfen oder trotzdem freigeben möglich), danach werden sie samt Datensatz gelöscht. 0 = nie." unit={t("admin.common.days")} min={0} max={3650} v={v} set={set} ro={ro} />
                  <NumField k="media.security_log_days" label="Sicherheitsereignisse der Upload-Seiten" help="Gekürzter IP-Hash, Link, Ereignis. 0 = unbegrenzt." unit={t("admin.common.days")} min={0} max={3650} v={v} set={set} ro={ro} />
                  <NumField k="privacy.uploader_months" label="Angaben der Hochladenden" help="Name, E-Mail-Adresse, Aufnahmeort und -datum (je Upload-Link abfragbar) danach entfernen; die Dateien bleiben. 0 = nie." unit="Monate" min={0} max={120} v={v} set={set} ro={ro} />
                  <NumField k="privacy.warning_days" label="Warnvorgänge" help="Nach dem letzten Bearbeitungsschritt des Vorgangs samt Aktualisierungen: Fassungen mit Rückrufkontakt, PDF, Versandnachweise. 0 = nie." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                  <NumField k="privacy.fe2_event_days" label="Einsatzmeldungen (FE2, Feuersoftware Connect)" help="Stichwort, Einsatzart, Ort, Zeit, Einheiten. Beiträge und Warnvorgänge daraus bleiben. 0 = nie." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                  <NumField k="privacy.official_warning_days" label="Amtliche Warnungen" help="Gerechnet ab dem Ablauf der Warnung, frühestens ab dem letzten Abruf, in dem die Quelle sie noch geliefert hat. 0 = nie." unit={t("admin.common.days")} v={v} set={set} ro={ro} />
                </FieldGrid>
                <RetentionPreview manage={manage} dirty={dirty} />
                <FieldWrap label="Eigener Hinweis (optional)" htmlFor="s-privacy-upload_notice" help="Erscheint zusätzlich im Abschnitt „Datenschutz“ der Upload-Seite, z. B. Rechtsgrundlage oder Ansprechperson. Höchstens 2000 Zeichen.">
                  <Textarea id="s-privacy-upload_notice" rows={4} maxLength={2000} disabled={ro} value={v["privacy.upload_notice"] ?? ""} onChange={(e) => set("privacy.upload_notice", e.target.value)} />
                </FieldWrap>
                <p className="m-0 text-sm text-fg-muted">
                  Die Upload-Seite nennt immer: Zweck, mögliche Veröffentlichung auf Website und in sozialen Medien (Meta, auch USA), was erfasst wird (Dateien, Hinweis, Dateiname, IP-Adresse zur Missbrauchsabwehr), die Speicherdauer und die Rechte der Betroffenen. Hinweise und Vorlagen: Hilfe → Sicherheit bzw. <code>docs/datenschutz.md</code>.
                </p>
              </SectionCard>

              {/* Medien */}
              <SectionCard
                id="medien"
                title={t("admin.settings.sections.medien")}
                description="Grenzen für Uploads. Neue Dateien landen immer zuerst in der Prüfung."
                bodyClassName="flex flex-col gap-5"
              >
                <FieldGrid>
                  <NumField k="media.max_file_mb" label="Maximale Dateigröße" unit="MB" min={1} max={20000} v={v} set={set} ro={ro} />
                  <NumField k="media.link_max_files" label="Dateien je Upload-Link" min={1} max={1000} v={v} set={set} ro={ro} />
                  <NumField k="media.link_default_days" label="Upload-Link gültig (Standard)" unit={t("admin.common.days")} min={1} max={90} v={v} set={set} ro={ro} />
                  <NumField k="media.link_max_days" label="Upload-Link höchstens gültig" help="Gilt auch für „Verlängern“ und „Bis Termin“." unit={t("admin.common.days")} min={1} max={365} v={v} set={set} ro={ro} />
                  <NumField k="media.collection_max_files" label="Dateien je Sammlung" min={1} max={100000} v={v} set={set} ro={ro} />
                  <NumField k="media.collection_max_gb" label="Speicher je Sammlung" unit="GB" min={1} max={10000} v={v} set={set} ro={ro} />
                  <NumField k="media.min_free_gb" label="Mindestens frei halten" help="Darunter werden Uploads gesperrt und der Healthcheck meldet einen Fehler." unit="GB" min={1} max={10000} v={v} set={set} ro={ro} />
                  <NumField k="media.storage_warn_gb" label="Speicherwarnung unter" help="Benachrichtigung an „Medien administrieren“ (höchstens alle 12 Stunden). 0 = aus." unit="GB" min={0} max={100000} v={v} set={set} ro={ro} />
                </FieldGrid>
                <Switch
                  checked={!!v["media.strip_location"]}
                  disabled={ro}
                  onChange={(x) => set("media.strip_location", x)}
                  label="Standortdaten auch aus Originalen entfernen"
                  description="Nach der Prüfung werden GPS-Angaben, Seriennummern, Personen- und XMP/IPTC-Angaben verlustfrei aus dem Original entfernt (Bilddaten bleiben unverändert, Videos werden ohne Metadaten und Datenspuren umverpackt). Ältere Originale bereinigt der Hintergrunddienst nach und nach. Entfernte Angaben lassen sich nicht wiederherstellen."
                />
                <AllowedTypesField value={v["media.allowed_types"]} ro={ro} onChange={(x) => set("media.allowed_types", x)} />
                <Switch
                  checked={!!v["media.notices"]}
                  disabled={ro}
                  onChange={(x) => set("media.notices", x)}
                  label="Benachrichtigungen zu Medien"
                  description="Neue Dateien über Upload-Links (gebündelt je Sammlung), Link läuft bald ab, Kontingent erreicht, Speicher knapp. Jede Person kann einzelne Arten unter „Mein Konto“ abschalten."
                />
                <Switch
                  checked={!!v["media.camera_buttons"]}
                  disabled={ro}
                  onChange={(x) => set("media.camera_buttons", x)}
                  label="Knöpfe „Foto aufnehmen“ und „Video aufnehmen“ auf dem Handy anzeigen"
                  description="Auf Touch-Geräten öffnen sie direkt die Kamera. Der große Knopf „Bilder oder Videos auswählen“ (Galerie) ist immer da."
                />
                <Switch
                  checked={!!v["media.link_show_once"]}
                  disabled={ro}
                  onChange={(x) => set("media.link_show_once", x)}
                  label="Upload-Links nur einmal anzeigen"
                  description="Neue Links und QR-Codes erscheinen nur direkt nach dem Anlegen bzw. „Neu erzeugen“; gespeichert wird nur eine Prüfsumme. Aus: Link, QR-Code und Aushang lassen sich jederzeit erneut abrufen (verschlüsselt gespeichert). Gilt für neu angelegte und neu erzeugte Links."
                />
                <FieldWrap label="Text nach erfolgreichem Upload (optional)" htmlFor="s-media-done_text" help="Leer = „Die Dateien sind angekommen und werden geprüft, bevor sie verwendet werden.“ Die Vorgangsnummer erscheint immer darunter.">
                  <Textarea id="s-media-done_text" rows={2} maxLength={1000} disabled={ro} value={v["media.done_text"] ?? ""} onChange={(e) => set("media.done_text", e.target.value)} />
                </FieldWrap>
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
                    checked={!!v["security.require_2fa_media"]}
                    disabled={ro || !!v["security.require_2fa_all"]}
                    onChange={(x) => set("security.require_2fa_media", x)}
                    label={t("admin.settings.req2faMedia")}
                    description={t("admin.settings.req2faMediaDesc")}
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
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-sm font-semibold">Angemeldet bleiben und gemerkte Geräte</h3>
                  <p className="m-0 text-sm text-fg-muted">
                    Gilt für alle Rollen. Gemerkte Sitzungen und Geräte sind an das Geräte-Cookie des Browsers gebunden;
                    kritische Aktionen verlangen weiterhin Passwort und Code. Abschalten beendet bestehende gemerkte
                    Sitzungen bzw. entfernt alle gemerkten Geräte sofort.
                  </p>
                  <Switch
                    checked={!!v["security.remember_enabled"]}
                    disabled={ro}
                    onChange={(x) => set("security.remember_enabled", x)}
                    label="„Angemeldet bleiben“ erlauben"
                    description="Ankreuzfeld auf der Anmeldeseite (in der installierten App vorbelegt). Keine Abmeldung bei Leerlauf; die Sitzung endet erst nach der unten eingestellten Zeit ohne Nutzung."
                  />
                  <Switch
                    checked={!!v["security.mfa_remember_enabled"]}
                    disabled={ro}
                    onChange={(x) => set("security.mfa_remember_enabled", x)}
                    label="Zwei-Faktor auf einem Gerät merken erlauben"
                    description="Nach einem Code aus der Authenticator-App fragt die Anmeldung auf diesem Gerät eine Zeit lang nur das Passwort ab. Wiederherstellungscodes merken kein Gerät."
                  />
                </div>
                <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
                  <NumField
                    k="security.remember_days"
                    label="Angemeldet bleiben: Ablauf ohne Nutzung"
                    help="1 bis 180 Tage seit der letzten Nutzung."
                    unit={t("admin.common.days")}
                    v={v}
                    set={set}
                    ro={ro || !v["security.remember_enabled"]}
                  />
                  <NumField
                    k="security.mfa_remember_days"
                    label="Gerät für Zwei-Faktor merken"
                    help="1 bis 90 Tage ab der Code-Eingabe."
                    unit={t("admin.common.days")}
                    v={v}
                    set={set}
                    ro={ro || !v["security.mfa_remember_enabled"]}
                  />
                </FieldGrid>
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-sm font-semibold">Sicherheitsmeldungen</h3>
                  <p className="m-0 text-sm text-fg-muted">
                    Bei Kontosperren, benutzten Wiederherstellungscodes, vergebenen oder entzogenen Admin-Rechten,
                    zurückgesetzter oder abgeschalteter Zwei-Faktor-Anmeldung, geänderten Sicherheitseinstellungen,
                    falschen Website-, FE2- oder API-Schlüsseln, neuen Website-Kopplungen und auffälligen Mengen.
                  </p>
                  <Switch
                    checked={!!v["security.alert_inapp"]}
                    disabled={ro}
                    onChange={(x) => set("security.alert_inapp", x)}
                    label="Benachrichtigung an die Administration"
                    description="In BlaulichtCMS an alle mit „System verwalten“ (Konten- und Rechteereignisse an „Benutzer verwalten“)."
                  />
                  <Switch
                    checked={!!v["security.alert_mail_admins"]}
                    disabled={ro}
                    onChange={(x) => set("security.alert_mail_admins", x)}
                    label="Zusätzlich per E-Mail an die Administration"
                    description="Nur wenn der E-Mail-Versand eingerichtet ist."
                  />
                  <Switch
                    checked={!!v["security.alert_mail_user"]}
                    disabled={ro}
                    onChange={(x) => set("security.alert_mail_user", x)}
                    label="Betroffene Person per E-Mail informieren"
                    description="Bei Passwortänderung, Zwei-Faktor-Änderungen, Wiederherstellungscode und Sperre (in BlaulichtCMS immer). Nur mit eingerichtetem E-Mail-Versand."
                  />
                </div>
                <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
                  <NumField k="security.alert_failed_logins" label="Meldung ab Fehlversuchen" help="Über alle Konten in 15 Minuten; 0 = aus." unit="in 15 Min." v={v} set={set} ro={ro} />
                  <NumField k="security.alert_downloads" label="Meldung ab Downloads" help="Originale oder Exportdateien einer Person pro Stunde; 0 = aus." unit="pro Std." v={v} set={set} ro={ro} />
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
                {manage && <UpdatePreflight />}
                {manage ? (
                  <BackupList />
                ) : (
                  <p className="m-0 text-sm text-fg-muted">
                    {t("admin.settings.noManage")}
                  </p>
                )}
              </SectionCard>

              <UpdatesSection manage={manage} />

              <AboutSection dataDir={q.data?.env.dataDir} trustedProxies={q.data?.env.trustedProxies} />
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
                disabled={ro || invalidNumbers || emptyName}
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

const TYPE_OPTIONS: [string, string][] = [
  ["jpeg", "JPEG"],
  ["png", "PNG"],
  ["webp", "WebP"],
  ["heic", "HEIC/HEIF"],
  ["avif", "AVIF"],
  ["gif", "GIF"],
  ["mp4", "MP4"],
  ["mov", "MOV"],
  ["webm", "WebM"],
  ["3gp", "3GP"],
];

/** Global erlaubte Dateitypen (je Upload-Link weiter einschränkbar). */
function AllowedTypesField({ value, onChange, ro }: { value: unknown; onChange: (v: string[]) => void; ro: boolean }) {
  const list = Array.isArray(value) ? (value as string[]) : [];
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
      <legend className="text-sm font-medium mb-1">Erlaubte Dateitypen</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {TYPE_OPTIONS.map(([k, label]) => (
          <label key={k} className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--bc-primary-solid)]"
              disabled={ro || (list.length === 1 && list.includes(k))}
              checked={list.includes(k)}
              onChange={(e) => onChange(e.target.checked ? [...list, k] : list.filter((x) => x !== k))}
            />
            {label}
          </label>
        ))}
      </div>
      <p className="m-0 text-meta text-fg-muted">Geprüft wird der Dateiinhalt. Je Upload-Link lässt sich die Auswahl weiter einschränken.</p>
    </fieldset>
  );
}

function TextField({
  k,
  label,
  help,
  max = 200,
  v,
  set,
  ro,
}: {
  k: string;
  label: string;
  help?: string;
  max?: number;
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
        maxLength={max}
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
  const lo = min ?? RANGES[k]?.[0];
  const hi = max ?? RANGES[k]?.[1];
  const err =
    val === "" || !Number.isInteger(n)
      ? t("admin.settings.numInvalid")
      : lo != null && n < lo
        ? t("admin.settings.numMin", { min: lo })
        : hi != null && n > hi
          ? t("admin.settings.numMax", { max: hi })
          : null;
  return (
    <FieldWrap label={label} htmlFor={id} help={help} error={err}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          disabled={ro}
          min={lo}
          max={hi}
          step={1}
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

interface RetentionReport {
  dry_run: boolean;
  categories: { key: string; label: string; days: number; count: number; detail?: string }[];
  collections: { id: string; title: string; last_activity: string; archived: boolean; media: number; kept: number; used_in: string[] }[];
}

/** Probelauf der Löschfristen (#97): „Was würde gelöscht?“ und sofort anwenden. */
function RetentionPreview({ manage, dirty }: { manage: boolean; dirty: boolean }) {
  const ask = useConfirm();
  const toast = useToast();
  const [report, setReport] = useState<RetentionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await get<RetentionReport>("/system/retention"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!(await ask({ title: "Löschfristen jetzt anwenden?", text: "Alles, was der Probelauf zeigt, wird endgültig gelöscht. Der Worker macht das sonst stündlich von selbst.", confirmLabel: "Jetzt löschen" }))) return;
    setBusy(true);
    try {
      const r = await post<RetentionReport>("/system/retention/run");
      const n = r.categories.reduce((a, c) => a + c.count, 0);
      toast({ tone: "success", title: "Löschfristen angewendet", text: `${fmtNumber(n)} Einträge gelöscht.` });
      setReport(await get<RetentionReport>("/system/retention"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const total = report?.categories.reduce((a, c) => a + c.count, 0) ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" icon="Search" loading={busy && !report} onClick={load} disabled={busy}>
          Was würde gelöscht?
        </Button>
        {report && manage && total > 0 && (
          <Button size="sm" variant="danger" icon="Trash2" onClick={run} disabled={busy || dirty}>
            Jetzt anwenden
          </Button>
        )}
        {dirty && report && <span className="text-sm text-fg-muted">Geänderte Fristen erst speichern – der Probelauf nutzt die gespeicherten Werte.</span>}
      </div>
      {error && <ErrorBox title="Probelauf fehlgeschlagen">{error}</ErrorBox>}
      {report && (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Daten</Th>
                <Th align="right">Frist</Th>
                <Th align="right">Würde gelöscht</Th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.key}>
                  <Td>{c.label}</Td>
                  <Td align="right">{c.days ? `${fmtNumber(c.days)} Tage` : "nie"}</Td>
                  <Td align="right">
                    {fmtNumber(c.count)}
                    {c.detail && c.count ? <span className="text-fg-muted"> ({c.detail})</span> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {report.collections.length > 0 && (
            <ul className="m-0 pl-5 text-sm flex flex-col gap-1">
              {report.collections.map((c) => (
                <li key={c.id}>
                  <Link to={`/medien/${c.id}`}>{c.title}</Link> – letzte Aktivität {fmtDateTime(c.last_activity)}, {fmtNumber(c.media)} Datei(en)
                  {c.kept > 0 && <span className="text-fg-muted">; {fmtNumber(c.kept)} bleiben (verwendet in {c.used_in.map((x) => `„${x}“`).join(", ")})</span>}
                </li>
              ))}
            </ul>
          )}
          {total === 0 && <p className="m-0 text-sm text-fg-muted">Derzeit ist nichts fällig.</p>}
        </>
      )}
    </div>
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

/** Update vorbereiten: Vorabprüfung und Wartungsmodus. Der Imagewechsel selbst passiert am Docker-Host. */
function UpdatePreflight() {
  const ask = useConfirm();
  const q = useQuery({ queryKey: ["update-preflight"], queryFn: () => get<any>("/system/update-preflight"), refetchInterval: 10_000 });
  const toast = useToast();
  const d = q.data;
  const toggle = async (enabled: boolean) => {
    try {
      await post("/system/maintenance", { enabled, reason: enabled ? "Update wird vorbereitet" : "" });
      toast({ tone: "success", title: enabled ? "Wartungsmodus aktiv" : "Wartungsmodus beendet" });
      q.refetch();
    } catch (e) {
      toast({ tone: "error", title: (e as Error).message });
    }
  };
  if (!d) return null;
  const on = d.checks.find((c: any) => c.id === "maintenance")?.ok;
  return (
    <div className="border border-line rounded-card p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Update vorbereiten</strong>
        <Badge tone={d.ready ? "success" : on ? "warning" : "neutral"}>{d.ready ? "bereit für das Update" : on ? "wartet auf laufende Vorgänge" : "Normalbetrieb"}</Badge>
        <span className="text-meta text-fg-muted">BlaulichtCMS {d.version} · PostgreSQL {d.postgres} · {d.migrations} Migrationen</span>
      </div>
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
      <div className="flex flex-wrap gap-2">
        {on ? (
          <Button onClick={() => toggle(false)}>Wartungsmodus beenden</Button>
        ) : (
          <Button icon="Hourglass" onClick={async () => (await ask({ title: "Wartungsmodus einschalten?", text: "Schreibende Vorgänge und neue Aufträge pausieren, bis der Wartungsmodus wieder aus ist.", confirmLabel: "Einschalten" })) && toggle(true)}>
            Wartungsmodus einschalten
          </Button>
        )}
        <Link to="/hilfe/updates" className="inline-flex items-center gap-1 text-sm">
          <Icon name="BookOpen" size={13} /> Ablauf: Sichern → Wechseln → Prüfen → Wiederherstellen
        </Link>
      </div>
    </div>
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

function AboutSection({ dataDir, trustedProxies }: { dataDir?: string; trustedProxies?: string[] }) {
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
        {trustedProxies && (
          <>
            <dt className="text-fg-muted">{t("admin.settings.trustedProxies")}</dt>
            <dd className="m-0 font-mono text-meta break-all">{trustedProxies.length ? trustedProxies.join(", ") : t("admin.settings.trustedProxiesNone")}</dd>
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
