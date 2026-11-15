import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { del, get, patch, post, qs } from "../../api/client";
import {
  Avatar,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  FieldWrap,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  SegmentedControl,
  SkeletonRows,
  Table,
  Tabs,
  Td,
  Th,
} from "../../components/ui/core";
import {
  CopyButton,
  DeleteDialog,
  Dialog,
  Menu,
  Popover,
  useErrorToast,
  useToast,
} from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { t } from "../../i18n";
import { useAuth } from "../../lib/auth";
import { QrDialog, ShareActions } from "../../components/share";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { AuditTable } from "./AuditTable";
import { LoadError, type AuditEvent } from "./shared";

interface UserRow {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: "active" | "invited" | "disabled";
  totp_enabled: boolean;
  last_active_at: string | null;
  last_login_at: string | null;
  created_at: string;
  invite_expires_at: string | null;
  /** Gesetzt, solange das Konto nach Fehlversuchen gesperrt ist */
  locked_until: string | null;
  failed_logins: number;
  mfa_failed: number;
}
interface ServiceAccount {
  id: string;
  name: string;
  roles: string[];
  last_used_at: string | null;
  created_at: string;
}
interface RoleDef {
  id: string;
  label: string;
  description: string;
  permissions: string[];
}
interface PermissionDef {
  id: string;
  module: string;
  label: string;
  level: "read" | "write" | "critical";
  description: string;
}
interface RolesResponse {
  roles: RoleDef[];
  modules: { id: string; label: string }[];
  permissions: PermissionDef[];
  matrix: {
    module: string;
    label: string;
    cells: {
      role: string;
      level: "full" | "edit" | "read" | "none";
      permissions: string[];
    }[];
  }[];
}

type Tab = "users" | "roles" | "activity";

export default function Users() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<Tab>("users");
  const [inviteOpen, setInviteOpen] = useState(false);
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () =>
      get<{ users: UserRow[]; serviceAccounts: ServiceAccount[] }>("/users"),
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => get<RolesResponse>("/roles"),
    staleTime: 300_000,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<{ settings: Record<string, any> }>("/settings"),
    enabled: can("system.read") || can("system.manage"),
  });
  const manage = can("user.manage");

  const s = settings.data?.settings;
  const mfaText = s
    ? s["security.require_2fa_all"]
      ? t("admin.users.mfaAll")
      : s["security.require_2fa_admins"] && s["security.require_2fa_media"]
        ? t("admin.users.mfaAdminsMedia")
        : s["security.require_2fa_admins"]
          ? t("admin.users.mfaAdmins")
          : s["security.require_2fa_media"]
            ? t("admin.users.mfaMedia")
            : t("admin.users.mfaNone")
    : null;
  const count =
    (users.data?.users.length ?? 0) + (users.data?.serviceAccounts.length ?? 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("admin.users.title")}
        subtitle={
          users.data && roles.data ? (
            [
              t(
                count === 1 ? "admin.users.summaryOne" : "admin.users.summary",
                { users: count, roles: roles.data.roles.length },
              ),
              mfaText,
            ]
              .filter(Boolean)
              .join(" · ")
          ) : (
            <span
              aria-hidden="true"
              className="bc-skeleton rounded-chip inline-block h-4 w-72 max-w-full align-middle"
            />
          )
        }
        actions={
          <>
            <AppLinkButton />
            {manage && (
              <Button
                variant="primary"
                icon="Users"
                aria-expanded={inviteOpen}
                onClick={() => setInviteOpen((o) => !o)}
              >
                {t("admin.users.invite")}
              </Button>
            )}
          </>
        }
      />
      {inviteOpen && roles.data && (
        <InviteForm
          roles={roles.data.roles}
          onClose={() => setInviteOpen(false)}
        />
      )}

      <Tabs
        label={t("admin.users.title")}
        value={tab}
        onChange={setTab}
        tabs={[
          {
            value: "users",
            label: t("admin.users.tabs.users"),
            count: users.data ? count : undefined,
          },
          {
            value: "roles",
            label: t("admin.users.tabs.roles"),
            count: roles.data?.roles.length,
          },
          { value: "activity", label: t("admin.users.tabs.activity") },
        ]}
      />

      <div role="tabpanel">
        {tab === "users" &&
          (users.isError ? (
            <LoadError error={users.error} onRetry={() => users.refetch()} />
          ) : !users.data || !roles.data ? (
            <Card>
              <SkeletonRows rows={5} />
            </Card>
          ) : (
            <UserTable
              data={users.data}
              roles={roles.data.roles}
              manage={manage}
              meId={me?.user.id ?? ""}
              onInvite={() => setInviteOpen(true)}
            />
          ))}
        {tab === "roles" &&
          (roles.isError ? (
            <LoadError error={roles.error} onRetry={() => roles.refetch()} />
          ) : !roles.data ? (
            <SkeletonRows rows={6} />
          ) : (
            <RolesTab data={roles.data} users={users.data?.users ?? []} />
          ))}
        {tab === "activity" &&
          (can("audit.read") ? (
            <UserActivity />
          ) : (
            <Notice tone="warning">{t("admin.users.noAudit")}</Notice>
          ))}
      </div>
    </div>
  );
}

/* ------------------------------------------ Einladen ------------------------------------------ */

function RoleChecks({
  roles,
  value,
  onChange,
  disabled,
}: {
  roles: RoleDef[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: (id: string) => string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {roles.map((r) => {
        const reason = disabled?.(r.id) ?? null;
        const checked = value.includes(r.id);
        const off = reason !== null;
        return (
          <label
            key={r.id}
            title={reason || r.description}
            className={cx(
              "flex items-start gap-2.5 px-2 py-1.5 rounded-chip hover:bg-raised cursor-pointer",
              off && "opacity-60 cursor-not-allowed",
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--bc-primary-solid)] w-4 h-4"
              checked={checked}
              disabled={off}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, r.id]
                    : value.filter((x) => x !== r.id),
                )
              }
            />
            <span className="flex flex-col min-w-0">
              <span className="text-sm font-medium">{r.label}</span>
              <span className="text-meta text-fg-muted">
                {reason || r.description}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function InviteForm({
  roles,
  onClose,
}: {
  roles: RoleDef[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>(
    ["editor"].filter((r) => roles.some((x) => x.id === r)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    link: string;
    expiresHours: number;
    email: string;
  } | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const rolesBtn = useRef<HTMLButtonElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!sel.length) {
      setError(t("admin.users.rolesNone"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ link: string; expiresHours: number }>(
        "/users/invite",
        { email: email.trim(), name: name.trim() || undefined, roles: sel },
      );
      setResult({ ...r, email: email.trim() });
      qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <LinkResult
        title={t("admin.users.inviteDone", { email: result.email })}
        help={t("admin.users.inviteLinkHelp", {
          until: fmtDateTime(Date.now() + result.expiresHours * 3_600_000),
        })}
        link={result.link}
        onClose={onClose}
        extra={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setResult(null);
              setEmail("");
              setName("");
            }}
          >
            {t("admin.users.inviteAnother")}
          </Button>
        }
      />
    );
  }

  const roleSummary = sel.length
    ? roles
        .filter((r) => sel.includes(r.id))
        .map((r) => r.label)
        .join(", ")
    : t("admin.users.rolesPick");
  return (
    <form
      aria-label={t("admin.users.inviteForm")}
      onSubmit={submit}
      className="flex flex-col gap-3 p-4 border border-primary rounded-card bg-card"
    >
      <div className="flex gap-2.5 items-end flex-wrap">
        <FieldWrap
          label={t("admin.users.email")}
          htmlFor="inv-email"
          required
          className="flex-[2_1_240px]"
        >
          <Input
            id="inv-email"
            type="email"
            required
            autoFocus
            placeholder="name@beispiel.de"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </FieldWrap>
        <FieldWrap
          label={`${t("admin.users.name")} (${t("admin.users.nameOptional")})`}
          htmlFor="inv-name"
          className="flex-[1_1_180px]"
        >
          <Input
            id="inv-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </FieldWrap>
        <div className="flex flex-col gap-1.5 flex-[1_1_200px] min-w-0">
          <span className="text-sm font-medium" id="inv-roles-label">
            {t("admin.users.roles")}
            <span className="text-err ml-0.5" aria-hidden="true">
              *
            </span>
          </span>
          <button
            ref={rolesBtn}
            type="button"
            aria-haspopup="true"
            aria-expanded={rolesOpen}
            aria-labelledby="inv-roles-label inv-roles-value"
            onClick={() => setRolesOpen((o) => !o)}
            className="h-field w-full flex items-center justify-between gap-2 px-3 bg-bg border border-line rounded-control text-left text-base hover:border-primary transition-colors duration-fast"
          >
            <span
              id="inv-roles-value"
              className={cx("truncate", !sel.length && "text-fg-muted")}
            >
              {roleSummary}
            </span>
            <Icon
              name="ChevronDown"
              size={16}
              className="text-fg-muted shrink-0"
            />
          </button>
          <Popover
            open={rolesOpen}
            onClose={() => setRolesOpen(false)}
            anchor={rolesBtn}
            align="start"
            width={320}
          >
            <div className="p-1.5">
              <RoleChecks roles={roles} value={sel} onChange={setSel} />
            </div>
          </Popover>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            {t("admin.users.createInvite")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("admin.common.cancel")}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="m-0 text-meta text-err">
          {error}
        </p>
      )}
    </form>
  );
}

/** PWA-Installationslink – bewusst getrennt von persönlichen Einladungen; darf ausgehängt werden. */
function AppLinkButton() {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const url = `${me?.instance.publicUrl || window.location.origin}/app`;
  return (
    <>
      <Button icon="Smartphone" onClick={() => setOpen(true)}>
        App-Link
      </Button>
      <QrDialog
        open={open}
        onClose={() => setOpen(false)}
        target={{ url, title: "BlaulichtCMS als App installieren", purpose: "App installieren", note: "Zum Anmelden ist ein eigenes Konto nötig." }}
      />
    </>
  );
}

function LinkResult({
  title,
  help,
  link,
  onClose,
  extra,
}: {
  title: string;
  help: string;
  link: string;
  onClose: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 p-4 border border-ok/50 bg-ok-soft rounded-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Icon
            name="CheckCircle2"
            size={16}
            className="text-ok mt-0.5 shrink-0"
          />
          <div className="flex flex-col gap-0.5 min-w-0">
            <strong className="text-sm font-semibold">{title}</strong>
            <span className="text-meta text-fg-muted">{help}</span>
          </div>
        </div>
        <Button
          size="sm"
          iconOnly
          icon="X"
          variant="ghost"
          aria-label={t("admin.users.close")}
          onClick={onClose}
        />
      </div>
      <div className="flex gap-2 flex-wrap sm:flex-nowrap">
        <Input
          readOnly
          value={link}
          mono
          aria-label={title}
          onFocus={(e) => e.target.select()}
        />
        <CopyButton value={link} />
      </div>
      <ShareActions
        target={{
          url: link,
          title: title,
          purpose: "Persönliche Einladung",
          sensitive: "Persönlicher Link: Wer ihn hat, kann das Konto einrichten. Nur an die eingeladene Person geben, nicht aushängen.",
        }}
      />
      {extra && <div>{extra}</div>}
    </div>
  );
}

/* ------------------------------------------ Tabelle ------------------------------------------ */

function UserTable({
  data,
  roles,
  manage,
  meId,
  onInvite,
}: {
  data: { users: UserRow[]; serviceAccounts: ServiceAccount[] };
  roles: RoleDef[];
  manage: boolean;
  meId: string;
  onInvite: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [linkInfo, setLinkInfo] = useState<{
    name: string;
    link: string;
    expiresHours: number;
    invite: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [renaming, setRenaming] = useState<UserRow | null>(null);
  const [newName, setNewName] = useState("");
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const roleLabel = (id: string) => roles.find((r) => r.id === id)?.label ?? id;
  const activeAdmins = data.users.filter(
    (u) => u.status === "active" && u.roles.includes("platform_admin"),
  ).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const setStatus = async (
    u: UserRow,
    status: "active" | "disabled",
    withUndo = true,
  ) => {
    try {
      await patch(`/users/${u.id}`, { status });
      refresh();
      toast({
        tone: status === "disabled" ? "warning" : "success",
        title: t(
          status === "disabled"
            ? "admin.users.disabled"
            : "admin.users.enabled",
          { name: u.name },
        ),
        text: status === "disabled" ? t("admin.users.disabledText") : undefined,
        action: withUndo
          ? {
              label: t("admin.users.undo"),
              onClick: () =>
                setStatus(
                  u,
                  status === "disabled" ? "active" : "disabled",
                  false,
                ),
            }
          : undefined,
      });
    } catch (e) {
      onError(e);
    }
  };

  const makeLink = async (u: UserRow) => {
    try {
      const r = await post<{ link: string; expiresHours: number }>(
        `/users/${u.id}/link`,
      );
      setLinkInfo({
        name: u.name,
        link: r.link,
        expiresHours: r.expiresHours,
        invite: u.status === "invited",
      });
      refresh();
    } catch (e) {
      onError(e);
    }
  };

  const revokeLink = async (u: UserRow) => {
    try {
      const r = await post<{ revoked: number }>(`/users/${u.id}/revoke-link`);
      refresh();
      toast({
        tone: r.revoked ? "success" : "info",
        title: r.revoked ? `Link für ${u.name} widerrufen` : "Kein offener Link vorhanden",
      });
    } catch (e) {
      onError(e);
    }
  };

  const reset2fa = async (u: UserRow) => {
    try {
      await post(`/users/${u.id}/reset-2fa`);
      refresh();
      toast({
        tone: "success",
        title: t("admin.users.reset2faDone", { name: u.name }),
        text: t("admin.users.reset2faText"),
      });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {linkInfo && (
        <LinkResult
          title={t("admin.users.linkFor", { name: linkInfo.name })}
          help={t(
            linkInfo.invite
              ? "admin.users.inviteLinkHelp"
              : "admin.users.resetLinkHelp",
            {
              until: fmtDateTime(
                Date.now() + linkInfo.expiresHours * 3_600_000,
              ),
            },
          )}
          link={linkInfo.link}
          onClose={() => setLinkInfo(null)}
        />
      )}
      <section
        aria-label={t("admin.users.tabs.users")}
        className="bg-card border border-line rounded-card min-w-0"
      >
        <Table className="relative">
          <thead>
            <tr>
              <Th className="pl-4 min-w-[240px]">
                {t("admin.users.col.name")}
              </Th>
              <Th>{t("admin.users.col.roles")}</Th>
              <Th>{t("admin.users.col.status")}</Th>
              <Th>{t("admin.users.col.last")}</Th>
              <Th>{t("admin.users.col.mfa")}</Th>
              <Th className="w-12">
                <span className="sr-only">{t("admin.common.open")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => {
              const isMe = u.id === meId;
              const expired =
                u.status === "invited" &&
                (!u.invite_expires_at ||
                  new Date(u.invite_expires_at).getTime() < Date.now());
              const last = u.last_active_at ?? u.last_login_at;
              return (
                <tr
                  key={u.id}
                  className={cx(
                    "hover:bg-raised transition-colors duration-fast",
                    u.status === "disabled" && "opacity-60",
                  )}
                >
                  <Td className="pl-4">
                    <span className="flex items-center gap-3 min-w-0">
                      <Avatar
                        name={u.name}
                        size={32}
                      />
                      <span className="flex flex-col min-w-0">
                        <span className="font-medium truncate">
                          {u.name}{" "}
                          {isMe && (
                            <span className="text-fg-muted font-normal">
                              {t("admin.users.you")}
                            </span>
                          )}
                        </span>
                        <span className="text-meta text-fg-muted truncate">
                          {u.email}
                        </span>
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <RoleButton
                      user={u}
                      roles={roles}
                      roleLabel={roleLabel}
                      manage={manage && u.status !== "disabled"}
                      isMe={isMe}
                      activeAdmins={activeAdmins}
                      onSaved={refresh}
                    />
                  </Td>
                  <Td>
                    {u.locked_until ? (
                      <span className="flex flex-col items-start gap-0.5">
                        <Badge tone="error" title={`${u.failed_logins} Passwort- und ${u.mfa_failed} Code-Fehlversuche`}>Gesperrt</Badge>
                        <span className="text-[11px] text-fg-muted whitespace-nowrap font-mono">bis {fmtDateTime(u.locked_until)}</span>
                      </span>
                    ) : u.status === "active" ? (
                      <Badge tone="success">
                        {t("admin.users.status.active")}
                      </Badge>
                    ) : u.status === "disabled" ? (
                      <Badge tone="neutral">
                        {t("admin.users.status.disabled")}
                      </Badge>
                    ) : expired ? (
                      <Badge tone="warning">
                        {t("admin.users.status.expired")}
                      </Badge>
                    ) : (
                      <span className="flex flex-col items-start gap-0.5">
                        <Badge tone="warning">
                          {t("admin.users.status.invited")}
                        </Badge>
                        <span className="text-[11px] text-fg-muted whitespace-nowrap">
                          {t("admin.users.invitedUntil", {
                            when: fmtDateTime(u.invite_expires_at),
                          })}
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td className="text-meta text-fg-muted whitespace-nowrap">
                    <span title={last ? fmtDateTime(last) : undefined}>
                      {last ? fmtRelative(last) : t("admin.users.never")}
                    </span>
                  </Td>
                  <Td
                    className={cx(
                      "text-meta whitespace-nowrap",
                      u.totp_enabled || u.status !== "active"
                        ? "text-fg-muted"
                        : "text-warn",
                    )}
                  >
                    {u.totp_enabled || u.status !== "active" ? (
                      u.totp_enabled ? (
                        t("admin.users.mfaOn")
                      ) : (
                        t("admin.users.mfaOff")
                      )
                    ) : u.totp_enabled ? (
                      t("admin.users.mfaOn")
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="AlertTriangle" size={12} />
                        {t("admin.users.mfaOff")}
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    {manage && (
                      <Menu
                        size="sm"
                        label={t("admin.users.actionsFor", { name: u.name })}
                        items={[
                          u.status !== "disabled" && {
                            label: t(
                              u.status === "invited"
                                ? "admin.users.newInviteLink"
                                : "admin.users.newPwLink",
                            ),
                            icon: "Link2",
                            onClick: () => makeLink(u),
                          },
                          !!u.invite_expires_at && {
                            label: "Offenen Link widerrufen",
                            icon: "Ban",
                            onClick: () => revokeLink(u),
                          },
                          !!u.locked_until && {
                            label: "Sperre aufheben",
                            icon: "LockOpen",
                            onClick: async () => {
                              try {
                                await post(`/users/${u.id}/unlock`);
                                toast({ tone: "success", title: `Sperre für ${u.name} aufgehoben` });
                                refresh();
                              } catch (e) {
                                onError(e);
                              }
                            },
                          },
                          u.status !== "disabled" && {
                            label: "Umbenennen",
                            icon: "Pencil",
                            onClick: () => (setRenaming(u), setNewName(u.name)),
                          },
                          // Eigene 2FA nicht hier zurücksetzen (würde abmelden) – dafür gibt es „Mein Konto“
                          u.totp_enabled && !isMe && {
                            label: t("admin.users.reset2fa"),
                            icon: "ShieldCheck",
                            onClick: () => setResetting(u),
                          },
                          u.status === "active" && {
                            label: t("admin.users.disable"),
                            icon: "PowerOff",
                            onClick: () => setStatus(u, "disabled"),
                            disabled: isMe,
                          },
                          u.status === "disabled" && {
                            label: t("admin.users.enable"),
                            icon: "Power",
                            onClick: () => setStatus(u, "active"),
                          },
                          !isMe && {
                            label: t("admin.users.delete"),
                            icon: "Trash2",
                            danger: true,
                            onClick: () => setDeleting(u),
                          },
                        ]}
                      />
                    )}
                  </Td>
                </tr>
              );
            })}
            {data.serviceAccounts.map((k) => (
              <tr
                key={k.id}
                className="hover:bg-raised transition-colors duration-fast"
              >
                <Td className="pl-4">
                  <span className="flex items-center gap-3 min-w-0">
                    <span
                      aria-hidden="true"
                      className="w-8 h-8 rounded-full bg-raised text-fg-muted inline-flex items-center justify-center shrink-0"
                    >
                      <Icon name="KeyRound" size={15} />
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="font-medium truncate">{k.name}</span>
                      <span className="text-meta text-fg-muted truncate">
                        {t("admin.users.service")}
                      </span>
                    </span>
                  </span>
                </Td>
                <Td>
                  <span className="text-meta">
                    {k.roles.map(roleLabel).join(", ") || "–"}
                  </span>
                </Td>
                <Td>
                  <Badge tone="success">{t("admin.users.status.active")}</Badge>
                </Td>
                <Td className="text-meta text-fg-muted whitespace-nowrap">
                  {k.last_used_at
                    ? fmtRelative(k.last_used_at)
                    : t("admin.users.never")}
                </Td>
                <Td className="text-meta text-fg-muted">
                  {t("admin.users.token")}
                </Td>
                <Td align="right">
                  <Link
                    to="/einstellungen"
                    aria-label={`${t("admin.users.serviceManage")}: ${k.name}`}
                    title={t("admin.users.serviceManage")}
                    className="inline-flex w-8 h-8 items-center justify-center rounded-control border border-line text-fg-muted hover:bg-raised hover:text-fg"
                  >
                    <Icon name="ExternalLink" size={14} />
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {data.users.length <= 1 && !data.serviceAccounts.length && (
          <EmptyState
            icon="Users"
            title={t("admin.users.empty")}
            text={t("admin.users.emptyText")}
            action={
              manage && (
                <Button icon="Plus" onClick={onInvite}>
                  {t("admin.users.invite")}
                </Button>
              )
            }
          />
        )}
      </section>
      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Benutzer umbenennen"
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Abbrechen</Button>
            <Button
              variant="primary"
              disabled={newName.trim().length < 2}
              onClick={async () => {
                try {
                  await patch(`/users/${renaming!.id}`, { name: newName.trim() });
                  toast({ tone: "success", title: "Name geändert" });
                  setRenaming(null);
                  refresh();
                } catch (e) {
                  onError(e);
                }
              }}
            >
              Speichern
            </Button>
          </>
        }
      >
        <FieldWrap label="Name" htmlFor="u-rename" error={newName.trim().length < 2 ? "Mindestens 2 Zeichen." : null}>
          <Input id="u-rename" value={newName} maxLength={80} autoFocus onChange={(e) => setNewName(e.target.value)} />
        </FieldWrap>
      </Dialog>
      <Dialog
        open={!!resetting}
        onClose={() => setResetting(null)}
        title="Zwei-Faktor-Anmeldung zurücksetzen?"
        footer={
          <>
            <Button onClick={() => setResetting(null)}>Abbrechen</Button>
            <Button variant="danger" onClick={async () => { const u = resetting!; setResetting(null); await reset2fa(u); }}>
              Zurücksetzen
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">{resetting?.name} wird abgemeldet und muss die Zwei-Faktor-Anmeldung bei der nächsten Anmeldung neu einrichten.</p>
      </Dialog>
      <DeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        objectType={t("admin.users.deleteType")}
        name={deleting?.name ?? ""}
        confirmValue={deleting?.email}
        extra={
          <p className="m-0 text-fg-muted">{t("admin.users.deleteExtra")}</p>
        }
        onConfirm={async (typed) => {
          const u = deleting!;
          await del(`/users/${u.id}`, { confirm: typed });
          refresh();
          toast({
            tone: "success",
            title: t("admin.users.deleted", { name: u.name }),
          });
        }}
      />
    </div>
  );
}

function RoleButton({
  user,
  roles,
  roleLabel,
  manage,
  isMe,
  activeAdmins,
  onSaved,
}: {
  user: UserRow;
  roles: RoleDef[];
  roleLabel: (id: string) => string;
  manage: boolean;
  isMe: boolean;
  activeAdmins: number;
  onSaved: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string[] | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const onError = useErrorToast();
  const current = local ?? user.roles;
  const text = current.map(roleLabel).join(", ");
  if (!manage) return <span className="text-meta">{text}</span>;

  const lockReason = (id: string): string | null => {
    if (id !== "platform_admin" || !user.roles.includes("platform_admin"))
      return null;
    if (isMe) return t("admin.users.ownAdmin");
    if (user.status === "active" && activeAdmins <= 1)
      return t("admin.users.lastAdmin");
    return null;
  };
  const change = async (next: string[]) => {
    if (!next.length) {
      onError(new Error(t("admin.users.rolesNone")));
      return;
    }
    setBusy(true);
    setLocal(next);
    try {
      await patch(`/users/${user.id}`, { roles: next });
      await onSaved();
      toast({
        tone: "success",
        title: t("admin.users.rolesSaved", { name: user.name }),
      });
    } catch (e) {
      onError(e);
    } finally {
      setLocal(null);
      setBusy(false);
    }
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${t("admin.users.rolesOf", { name: user.name })}: ${text}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 h-7 px-2 max-w-[220px] border border-line rounded-[7px] text-meta hover:bg-raised transition-colors duration-fast"
      >
        <span className="truncate">{text}</span>
        {busy ? (
          <Icon
            name="RefreshCw"
            size={12}
            className="animate-spin text-fg-muted"
          />
        ) : (
          <Icon
            name="ChevronDown"
            size={12}
            className="text-fg-muted shrink-0"
          />
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={btn}
        align="start"
        width={320}
      >
        <div className="p-1.5 flex flex-col gap-1">
          <p className="m-0 px-2 pt-1 text-meta text-fg-muted">
            {t("admin.users.rolesOf", { name: user.name })}
          </p>
          <RoleChecks
            roles={roles}
            value={current}
            onChange={change}
            disabled={(id) => (busy ? "" : lockReason(id))}
          />
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------- Rollen ------------------------------------------- */

const LEVEL_STYLE: Record<string, string> = {
  full: "bg-fg text-card",
  edit: "bg-raised text-fg border border-line",
  read: "bg-raised text-fg-muted",
  none: "text-fg-muted",
};

function RolesTab({ data, users }: { data: RolesResponse; users: UserRow[] }) {
  const permLabel = useMemo(
    () => Object.fromEntries(data.permissions.map((p) => [p.id, p])),
    [data.permissions],
  );
  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-sm text-fg-muted">{t("admin.users.rolesHint")}</p>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))]">
        {data.roles.map((r) => {
          const members = users.filter(
            (u) => u.roles.includes(r.id) && u.status !== "disabled",
          ).length;
          const critical = r.permissions.filter(
            (p) => permLabel[p]?.level === "critical",
          );
          return (
            <Card
              key={r.id}
              title={r.label}
              subtitle={
                members === 1
                  ? t("admin.users.membersOne")
                  : t("admin.users.membersCount", { n: members })
              }
            >
              <p className="m-0 text-sm text-fg-muted">{r.description}</p>
              <ul
                className="list-none m-0 mt-3 p-0 flex flex-wrap gap-1.5"
                aria-label={t("admin.users.roles")}
              >
                {r.permissions.map((p) => {
                  const def = permLabel[p];
                  const crit = def?.level === "critical";
                  return (
                    <li key={p} title={def?.description}>
                      <span
                        className={cx(
                          "inline-flex items-center gap-1 h-[22px] px-2 rounded-chip text-meta whitespace-nowrap",
                          crit
                            ? "bg-warn-soft text-warn font-medium"
                            : "bg-raised text-fg-muted",
                        )}
                      >
                        {crit && <Icon name="AlertTriangle" size={11} />}
                        {def?.label ?? p}
                        {crit && (
                          <span className="sr-only">
                            {" "}
                            ({t("admin.users.critical")})
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>

            </Card>
          );
        })}
      </div>

      <Card
        title={t("admin.users.matrix")}
        subtitle={t("admin.users.matrixHint")}
      >
        <div className="overflow-x-auto relative">
          <table className="w-full border-collapse text-sm min-w-[720px]">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="text-left text-[11px] font-semibold text-fg-muted pb-2 border-b border-line pr-2"
                >
                  {t("admin.users.module")}
                </th>
                {data.roles.map((r) => (
                  <th
                    key={r.id}
                    scope="col"
                    className="text-center text-[11px] font-semibold text-fg-muted pb-2 border-b border-line px-1"
                  >
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.matrix.map((m) => (
                <tr key={m.module}>
                  <th
                    scope="row"
                    className="text-left font-normal py-2 border-b border-line pr-2 whitespace-nowrap"
                  >
                    {m.label}
                  </th>
                  {m.cells.map((c) => {
                    const list = c.permissions
                      .map((p) => permLabel[p]?.label ?? p)
                      .join(", ");
                    const tip = list || t("admin.users.noRights");
                    return (
                      <td
                        key={c.role}
                        className="text-center py-2 border-b border-line px-1"
                      >
                        <span
                          title={tip}
                          className={cx(
                            "inline-flex items-center justify-center min-w-[64px] h-[22px] px-1.5 rounded-chip text-[11px] font-medium",
                            LEVEL_STYLE[c.level],
                          )}
                        >
                          {t(`admin.users.level.${c.level}`)}
                          <span className="sr-only">: {tip}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-3 flex-wrap mt-3 text-[11px] text-fg-muted">
          <span>{t("admin.users.legend.full")}</span>
          <span>{t("admin.users.legend.edit")}</span>
          <span>{t("admin.users.legend.read")}</span>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------- Aktivität ------------------------------------------ */

function UserActivity() {
  const [kind, setKind] = useState<"user" | "auth">("user");
  const q = useInfiniteQuery({
    queryKey: ["audit", "users-tab", kind],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<{ events: AuditEvent[]; nextBefore: number | null }>(
        `/audit${qs({ q: `${kind}.`, limit: 50, before: pageParam })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const events =
    q.data?.pages
      .flatMap((p) => p.events)
      .filter((e) => e.action.startsWith(`${kind}.`)) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="m-0 text-sm text-fg-muted">
          {t("admin.users.activityHint")}
        </p>
        <SegmentedControl
          label={t("admin.users.activityFilter")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "user", label: t("admin.users.activityKinds.user") },
            { value: "auth", label: t("admin.users.activityKinds.auth") },
          ]}
        />
      </div>
      <section className="bg-card border border-line rounded-card min-w-0">
        {q.isError ? (
          <div className="p-4">
            <LoadError error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : q.isLoading ? (
          <SkeletonRows rows={6} className="p-4" />
        ) : events.length === 0 ? (
          <EmptyState
            icon="ScrollText"
            title={t("admin.logs.empty")}
            text={t("activity.emptyFilteredText")}
          />
        ) : (
          <AuditTable events={events} />
        )}
      </section>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            icon="ChevronDown"
            loading={q.isFetchingNextPage}
            onClick={() => q.fetchNextPage()}
          >
            {t("admin.common.loadMore")}
          </Button>
        </div>
      )}
      <div>
        <LinkButton
          to="/protokolle?tab=audit"
          variant="ghost"
          size="sm"
          icon="ScrollText"
        >
          {t("admin.logs.tabs.audit")}
        </LinkButton>
      </div>
    </div>
  );
}
