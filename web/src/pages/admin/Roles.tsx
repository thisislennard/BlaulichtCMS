/* Rollen und Rechte (Verwaltung → Benutzer und Rollen → Rollen): Rollen ansehen, anlegen, kopieren, ändern,
   zurücksetzen und löschen. Der Server prüft jede Änderung (Recht „Rollen verwalten“, Passwortbestätigung, keine
   Rechte vergeben oder entziehen, die man selbst nicht hat); die Oberfläche zeigt nur, was möglich ist. */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, post, put } from "../../api/client";
import { Badge, Button, Card, cx, EmptyState, FieldWrap, Input, Notice, Select, Textarea } from "../../components/ui/core";
import { Dialog, Menu, errorText, useToast } from "../../components/ui/overlays";
import { Icon } from "../../components/ui/Icon";
import { useAuth } from "../../lib/auth";

export interface RoleDef {
  id: string;
  label: string;
  description: string;
  permissions: string[];
  system: boolean;
  customized: boolean;
  locked: boolean;
  users: number;
  defaultPermissions: string[] | null;
  assignable: boolean;
  editable: boolean;
  deletable: boolean;
}
export interface PermissionDef {
  id: string;
  module: string;
  label: string;
  level: "read" | "write" | "critical";
  description: string;
  requires?: string[];
  admin?: boolean;
}
export interface RolesResponse {
  roles: RoleDef[];
  modules: { id: string; label: string }[];
  permissions: PermissionDef[];
  grantable: string[];
}

const LEVEL: Record<PermissionDef["level"], { label: string; tone: "neutral" | "primary" | "warning" }> = {
  read: { label: "lesen", tone: "neutral" },
  write: { label: "ändern", tone: "neutral" },
  critical: { label: "kritisch", tone: "warning" },
};

function LevelBadge({ level }: { level: PermissionDef["level"] }) {
  return (
    <Badge tone={LEVEL[level].tone} dot={false} className="shrink-0">
      {LEVEL[level].label}
    </Badge>
  );
}

/** Rechte samt Voraussetzungen und umgekehrt: was von einem Recht abhängt. */
function useCatalogue(permissions: PermissionDef[]) {
  return useMemo(() => {
    const byId = new Map(permissions.map((p) => [p.id, p]));
    const closure = (id: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const r of byId.get(id)?.requires ?? []) closure(r, seen);
      return seen;
    };
    const needs = new Map(permissions.map((p) => [p.id, closure(p.id)]));
    /** Rechte, die `id` voraussetzen (direkt oder über Zwischenschritte) */
    const dependents = (id: string) => permissions.filter((p) => p.id !== id && needs.get(p.id)!.has(id)).map((p) => p.id);
    const label = (id: string) => byId.get(id)?.label ?? id;
    const order = (ids: Iterable<string>) => {
      const set = new Set(ids);
      return permissions.filter((p) => set.has(p.id)).map((p) => p.id);
    };
    return { byId, needs, dependents, label, order };
  }, [permissions]);
}

type EditorState = { mode: "create" | "edit" | "view"; role?: RoleDef; copyOf?: RoleDef };

export function RolesTab({ data }: { data: RolesResponse }) {
  const { can } = useAuth();
  const manage = can("role.manage");
  const qc = useQueryClient();
  const toast = useToast();
  const cat = useCatalogue(data.permissions);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<RoleDef | null>(null);
  const [resetting, setResetting] = useState<RoleDef | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["roles"] }), qc.invalidateQueries({ queryKey: ["users"] }), qc.invalidateQueries({ queryKey: ["me"] })]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="m-0 text-sm text-fg-muted max-w-[72ch]">
          Eine Rolle bündelt Rechte. Konten können mehrere Rollen haben; es gilt die Summe. Was eine Person nicht darf, wird ihr auch nicht angezeigt. Änderungen an einer Rolle wirken
          sofort für alle Konten mit dieser Rolle.
        </p>
        {manage && (
          <Button variant="primary" icon="Plus" onClick={() => setEditor({ mode: "create" })}>
            Neue Rolle
          </Button>
        )}
      </div>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]">
        {data.roles.map((r) => {
          const critical = r.permissions.filter((p) => cat.byId.get(p)?.level === "critical").length;
          const perModule = data.modules
            .map((m) => {
              const all = data.permissions.filter((p) => p.module === m.id);
              const has = all.filter((p) => r.permissions.includes(p.id)).length;
              return { ...m, has, total: all.length };
            })
            .filter((m) => m.has > 0);
          const items = [
            { label: r.editable ? "Rechte bearbeiten" : "Rechte ansehen", icon: r.editable ? "Pencil" : "Eye", onClick: () => setEditor({ mode: r.editable ? "edit" : "view", role: r }) },
            manage && !r.locked && { label: "Als Kopie anlegen", icon: "Copy", onClick: () => setEditor({ mode: "create", copyOf: r }) },
            r.editable && r.system && r.customized && { label: "Auf Standard zurücksetzen", icon: "RotateCcw", onClick: () => setResetting(r) },
            r.deletable && { label: "Löschen", icon: "Trash2", danger: true, onClick: () => setDeleting(r) },
          ];
          return (
            <Card
              key={r.id}
              title={r.label}
              subtitle={r.users === 1 ? "1 Konto" : `${r.users} Konten`}
              action={<Menu size="sm" label={`Aktionen für Rolle ${r.label}`} items={items as any} />}
            >
              <div className="flex gap-1.5 flex-wrap mb-2">
                {r.locked ? <Badge tone="neutral" dot={false}>Fest: immer alle Rechte</Badge> : r.system ? <Badge tone="neutral" dot={false}>Mitgeliefert</Badge> : <Badge tone="neutral" dot={false}>Eigene Rolle</Badge>}
                {r.customized && <Badge tone="warning" dot={false}>Angepasst</Badge>}
              </div>
              <p className="m-0 text-sm text-fg-muted">{r.description || "Ohne Beschreibung."}</p>
              <p className="m-0 mt-3 text-meta">
                {r.permissions.length} von {data.permissions.length} Rechten
                {critical > 0 && (
                  <span className="text-warn">
                    {" "}
                    · <Icon name="AlertTriangle" size={11} className="inline -mt-0.5" /> {critical} kritisch
                  </span>
                )}
              </p>
              {perModule.length > 0 ? (
                <ul className="list-none m-0 mt-2 p-0 flex flex-wrap gap-1.5" aria-label={`Bereiche der Rolle ${r.label}`}>
                  {perModule.map((m) => (
                    <li key={m.id} className="inline-flex items-center h-[22px] px-2 rounded-chip text-meta whitespace-nowrap bg-raised text-fg-muted">
                      {m.label} {m.has}/{m.total}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mt-2 text-meta text-fg-muted">Noch keine Rechte – nur Anmeldung und eigenes Konto.</p>
              )}
            </Card>
          );
        })}
      </div>

      {editor && (
        <RoleEditor
          key={`${editor.mode}:${editor.role?.id ?? editor.copyOf?.id ?? "neu"}`}
          state={editor}
          data={data}
          onClose={() => setEditor(null)}
          onSaved={async (msg) => {
            setEditor(null);
            await refresh();
            toast({ tone: "success", title: msg });
          }}
        />
      )}
      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          roles={data.roles}
          onClose={() => setDeleting(null)}
          onDone={async () => {
            const name = deleting.label;
            setDeleting(null);
            await refresh();
            toast({ tone: "success", title: `Rolle „${name}“ gelöscht` });
          }}
        />
      )}
      {resetting && (
        <ResetRoleDialog
          role={resetting}
          label={cat.label}
          order={cat.order}
          onClose={() => setResetting(null)}
          onDone={async () => {
            const name = resetting.label;
            setResetting(null);
            await refresh();
            toast({ tone: "success", title: `Rolle „${name}“ auf Standard zurückgesetzt` });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------- Editor ------------------------------------------- */

function RoleEditor({ state, data, onClose, onSaved }: { state: EditorState; data: RolesResponse; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const cat = useCatalogue(data.permissions);
  const source = state.role ?? state.copyOf;
  const readOnly = state.mode === "view";
  const create = state.mode === "create";
  const fixedName = !!state.role?.system;
  const [label, setLabel] = useState(state.copyOf ? `Kopie von ${state.copyOf.label}` : (state.role?.label ?? ""));
  const [description, setDescription] = useState(source?.description ?? "");
  const before = useMemo(() => (state.role ? state.role.permissions : []), [state.role]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(source?.permissions ?? []));
  const [term, setTerm] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grantable = useMemo(() => new Set(data.grantable), [data.grantable]);

  /** Ändern darf man nur Rechte, die man selbst hat – weder vergeben noch entziehen. */
  const mayToggle = (id: string) => !readOnly && grantable.has(id);
  const toggle = (id: string, on: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) {
        // Voraussetzungen kommen automatisch dazu
        for (const r of cat.needs.get(id) ?? []) if (r === id || grantable.has(r) || next.has(r)) next.add(r);
      } else {
        next.delete(id);
        // Was dieses Recht voraussetzt, entfällt mit
        for (const d of cat.dependents(id)) next.delete(d);
      }
      return next;
    });
  };
  const setModule = (moduleId: string, on: boolean) => {
    const ids = data.permissions.filter((p) => p.module === moduleId && mayToggle(p.id)).map((p) => p.id);
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) for (const r of cat.needs.get(id) ?? []) if (r === id || grantable.has(r) || next.has(r)) next.add(r);
        if (!on) {
          next.delete(id);
          for (const d of cat.dependents(id)) if (grantable.has(d)) next.delete(d);
        }
      }
      return next;
    });
  };

  const after = cat.order(selected);
  const added = after.filter((p) => !before.includes(p));
  const removed = cat.order(before.filter((p) => !selected.has(p)));
  const renamed = !create && !fixedName && (label.trim() !== state.role!.label || description.trim() !== state.role!.description);
  const dirty = create ? true : added.length > 0 || removed.length > 0 || renamed;
  const critical = (ids: string[]) => ids.filter((p) => cat.byId.get(p)?.level === "critical");
  const q = term.trim().toLowerCase();
  const visible = (p: PermissionDef) => !q || p.label.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.id.includes(q);
  const nameOk = fixedName || label.trim().length >= 2;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (create) {
        await post("/roles", { label: label.trim(), description: description.trim(), permissions: after, ...(state.copyOf ? { copyOf: state.copyOf.id } : {}) });
        await onSaved(`Rolle „${label.trim()}“ angelegt`);
      } else {
        const r = await put<{ signedOut?: number }>(`/roles/${state.role!.id}`, { ...(fixedName ? {} : { label: label.trim(), description: description.trim() }), permissions: after });
        await onSaved(r?.signedOut ? `Rolle gespeichert – ${r.signedOut} Konto/Konten müssen die Zwei-Faktor-Anmeldung einrichten und wurden abgemeldet` : `Rolle „${fixedName ? state.role!.label : label.trim()}“ gespeichert`);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const title = readOnly ? `Rechte der Rolle „${state.role!.label}“` : create ? (state.copyOf ? `Rolle kopieren: ${state.copyOf.label}` : "Neue Rolle") : `Rolle „${state.role!.label}“ bearbeiten`;

  if (review) {
    const users = state.role?.users ?? 0;
    const critAdded = critical(added);
    return (
      <Dialog
        open
        onClose={onClose}
        title="Änderung prüfen"
        width={640}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(false)} disabled={busy}>
              Zurück
            </Button>
            <Button variant="primary" onClick={save} loading={busy}>
              {create ? "Rolle anlegen" : "Speichern"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm">
            {create ? (
              <>
                Die Rolle <strong>„{label.trim()}“</strong> wird mit {after.length} Rechten angelegt. Sie wirkt erst, wenn sie Konten zugewiesen wird.
              </>
            ) : (
              <>
                Die Änderung an <strong>„{fixedName ? state.role!.label : label.trim()}“</strong> wirkt sofort für {users === 1 ? "1 Konto" : `${users} Konten`} – ohne neue Anmeldung.
              </>
            )}
          </p>
          <DiffList title={create ? "Diese Rolle erhält" : "Diese Rolle erhält neu"} ids={added} cat={cat} tone="add" empty={create ? "Keine Rechte – nur Anmeldung und eigenes Konto." : "Keine neuen Rechte."} />
          {!create && <DiffList title="Diese Rolle verliert" ids={removed} cat={cat} tone="remove" empty="Es entfallen keine Rechte." />}
          {critAdded.length > 0 && (
            <Notice tone="warning" title="Kritische Rechte werden vergeben">
              {critAdded.map(cat.label).join(", ")}. Solche Rechte nur an Personen geben, die sie für ihre Aufgabe brauchen. Die Änderung wird im Audit-Protokoll festgehalten und gemeldet.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={860}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Schließen</Button>
        ) : (
          <>
            <span className="mr-auto text-meta text-fg-muted" aria-live="polite">
              {after.length} Rechte gewählt{critical(after).length ? `, davon ${critical(after).length} kritisch` : ""}
            </span>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={!dirty || !nameOk} onClick={() => setReview(true)}>
              Weiter: Änderung prüfen
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {!readOnly && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldWrap label="Name" htmlFor="role-label" required help={fixedName ? "Name und Beschreibung mitgelieferter Rollen sind fest. Für eine eigene Bezeichnung die Rolle kopieren." : undefined}>
              <Input id="role-label" value={label} maxLength={60} disabled={fixedName} onChange={(e) => setLabel(e.target.value)} />
            </FieldWrap>
            <FieldWrap label="Beschreibung" htmlFor="role-description">
              <Textarea id="role-description" rows={2} value={description} maxLength={300} disabled={fixedName} onChange={(e) => setDescription(e.target.value)} />
            </FieldWrap>
          </div>
        )}
        {state.role?.locked && <Notice tone="info">Die Rolle „Administration“ hat immer alle Rechte – auch künftige – und lässt sich nicht ändern.</Notice>}
        <FieldWrap label="Rechte durchsuchen" htmlFor="role-search">
          <Input id="role-search" type="search" value={term} placeholder="z. B. Upload-Link, freigeben, Sicherung" onChange={(e) => setTerm(e.target.value)} />
        </FieldWrap>
        {data.modules.map((m) => {
          const all = data.permissions.filter((p) => p.module === m.id);
          const shown = all.filter(visible);
          if (!shown.length) return null;
          const count = all.filter((p) => selected.has(p.id)).length;
          const togglable = all.filter((p) => mayToggle(p.id));
          const allOn = togglable.length > 0 && togglable.every((p) => selected.has(p.id));
          return (
            <section key={m.id} aria-labelledby={`role-mod-${m.id}`} className="border border-line rounded-card">
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-raised rounded-t-card">
                <h3 id={`role-mod-${m.id}`} className="m-0 text-sm font-semibold">
                  {m.label} <span className="font-normal text-fg-muted">· {count} von {all.length}</span>
                </h3>
                {togglable.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setModule(m.id, !allOn)} aria-label={`${allOn ? "Keine" : "Alle"} Rechte im Bereich ${m.label}`}>
                    {allOn ? "Keine im Bereich" : "Alle im Bereich"}
                  </Button>
                )}
              </div>
              <ul className="list-none m-0 p-1.5 flex flex-col gap-0.5">
                {shown.map((p) => {
                  const checked = selected.has(p.id);
                  const can = mayToggle(p.id);
                  const neededBy = checked ? cat.dependents(p.id).filter((d) => selected.has(d)) : [];
                  const requires = (p.requires ?? []).map(cat.label);
                  return (
                    <li key={p.id}>
                      <label className={cx("flex items-start gap-2.5 px-2 py-1.5 rounded-chip", can ? "hover:bg-raised cursor-pointer" : "cursor-default", !can && !readOnly && "opacity-70")}>
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-[var(--bc-primary-solid)] w-4 h-4 shrink-0"
                          checked={checked}
                          disabled={!can}
                          onChange={(e) => toggle(p.id, e.target.checked)}
                        />
                        <span className="flex flex-col min-w-0 grow">
                          <span className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{p.label}</span>
                            <LevelBadge level={p.level} />
                          </span>
                          <span className="text-meta text-fg-muted">{p.description}</span>
                          {requires.length > 0 && <span className="text-meta text-fg-muted">Setzt voraus: {requires.join(", ")}</span>}
                          {neededBy.length > 0 && !readOnly && <span className="text-meta text-fg-muted">Abwählen entfernt auch: {neededBy.map(cat.label).join(", ")}</span>}
                          {!readOnly && !grantable.has(p.id) && <span className="text-meta text-warn">Dieses Recht hast du selbst nicht – du kannst es weder vergeben noch entziehen.</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {q && !data.permissions.some(visible) && <EmptyState icon="Search" title="Kein Recht gefunden" text="Bitte einen anderen Suchbegriff versuchen." />}
      </div>
    </Dialog>
  );
}

function DiffList({ title, ids, cat, tone, empty }: { title: string; ids: string[]; cat: ReturnType<typeof useCatalogue>; tone: "add" | "remove"; empty: string }) {
  return (
    <div>
      <h3 className="m-0 mb-1.5 text-sm font-semibold">
        {title} {ids.length > 0 && <span className="font-normal text-fg-muted">({ids.length})</span>}
      </h3>
      {ids.length === 0 ? (
        <p className="m-0 text-meta text-fg-muted">{empty}</p>
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {ids.map((id) => {
            const p = cat.byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 text-sm">
                <Icon name={tone === "add" ? "Plus" : "Minus"} size={13} className="text-fg-muted shrink-0" />
                <span>{p?.label ?? id}</span>
                {p && <LevelBadge level={p.level} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------- Löschen, Zurücksetzen ------------------------------------- */

function DeleteRoleDialog({ role, roles, onClose, onDone }: { role: RoleDef; roles: RoleDef[]; onClose: () => void; onDone: () => Promise<void> }) {
  const options = roles.filter((r) => r.id !== role.id && r.assignable);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsTarget = role.users > 0;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await del(`/roles/${role.id}`, needsTarget ? { reassignTo: target } : {});
      await onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rolle „${role.label}“ löschen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="danger" icon="Trash2" onClick={run} loading={busy} disabled={needsTarget && !target}>
            Rolle löschen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {needsTarget ? (
          <>
            <p className="m-0 text-sm">
              {role.users === 1 ? "1 Konto hat" : `${role.users} Konten haben`} diese Rolle. Damit niemand ohne Rolle bleibt, erhalten sie stattdessen eine Ersatzrolle.
            </p>
            <FieldWrap label="Ersatzrolle" htmlFor="role-reassign" required help="Zur Auswahl stehen Rollen, deren Rechte du selbst vollständig hast.">
              <Select id="role-reassign" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Bitte wählen …</option>
                {options.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </FieldWrap>
          </>
        ) : (
          <p className="m-0 text-sm">Kein Konto hat diese Rolle. Sie wird endgültig entfernt; ein gemeinsames Dashboard der Rolle entfällt ebenfalls.</p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}

function ResetRoleDialog({ role, label, order, onClose, onDone }: { role: RoleDef; label: (id: string) => string; order: (ids: Iterable<string>) => string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const def = role.defaultPermissions ?? [];
  const added = order(def.filter((p) => !role.permissions.includes(p)));
  const removed = order(role.permissions.filter((p) => !def.includes(p)));
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/roles/${role.id}/reset`);
      await onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rolle „${role.label}“ auf Standard zurücksetzen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="primary" icon="RotateCcw" onClick={run} loading={busy}>
            Zurücksetzen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">Die Rolle erhält wieder die mitgelieferten Rechte und folgt künftig den Vorgaben neuer Versionen. Das wirkt sofort für {role.users === 1 ? "1 Konto" : `${role.users} Konten`}.</p>
        {added.length > 0 && (
          <p className="m-0">
            <strong>Kommt wieder dazu:</strong> {added.map(label).join(", ")}
          </p>
        )}
        {removed.length > 0 && (
          <p className="m-0">
            <strong>Entfällt:</strong> {removed.map(label).join(", ")}
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
