/**
 * Rechte-Registry: Jedes Modul registriert seine Rechte, die
 * Berechtigungsmatrix in der Oberfläche wird daraus erzeugt. Standard ist verweigern.
 */
export interface PermissionDef {
  id: string;
  module: string;
  label: string;
  /** read = nur lesen; write = ändern; critical = besonders kritisch (separat auditiert) */
  level: 'read' | 'write' | 'critical';
  description: string;
}

export interface ModuleDef {
  id: string;
  label: string;
}

export const MODULES: ModuleDef[] = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'runs', label: 'Ausführungen' },
  { id: 'connections', label: 'Schnittstellen' },
  { id: 'credentials', label: 'Zugangsdaten' },
  { id: 'wordpress', label: 'WordPress-Inhalte' },
  { id: 'users', label: 'Benutzer' },
  { id: 'system', label: 'System & Protokolle' },
];

export const PERMISSIONS: PermissionDef[] = [
  { id: 'workflow.read', module: 'workflows', label: 'Workflows ansehen', level: 'read', description: 'Workflows, Versionen und Vorlagen ansehen.' },
  { id: 'workflow.edit', module: 'workflows', label: 'Workflows bearbeiten', level: 'write', description: 'Entwürfe anlegen, bearbeiten, testen, Freigabe beantragen.' },
  { id: 'workflow.publish', module: 'workflows', label: 'Aktivieren & veröffentlichen', level: 'critical', description: 'Versionen veröffentlichen, Workflows aktivieren, deaktivieren und zurückrollen.' },
  { id: 'workflow.approve', module: 'workflows', label: 'Freigeben', level: 'critical', description: 'Bei Vier-Augen-Freigabe die Version einer anderen Person freigeben.' },
  { id: 'run.read', module: 'runs', label: 'Ausführungen ansehen', level: 'read', description: 'Ausführungsverlauf, Schritte und maskierte Daten ansehen.' },
  { id: 'run.replay', module: 'runs', label: 'Erneut ausführen', level: 'critical', description: 'Läufe manuell wiederholen oder abbrechen (mögliche Doppelwirkung).' },
  { id: 'connection.read', module: 'connections', label: 'Schnittstellen ansehen', level: 'read', description: 'Verbindungen, Status und Webhooks ansehen.' },
  { id: 'connection.edit', module: 'connections', label: 'Schnittstellen verwalten', level: 'write', description: 'Verbindungen anlegen, konfigurieren, testen und löschen.' },
  { id: 'credential.manage', module: 'credentials', label: 'Zugangsdaten verwalten', level: 'critical', description: 'Zugangsdaten hinterlegen, ersetzen, Webhook-Geheimnisse rotieren und widerrufen.' },
  { id: 'wordpress.read', module: 'wordpress', label: 'Banner & Beiträge ansehen', level: 'read', description: 'Banner und Beiträge ansehen.' },
  { id: 'wordpress.edit', module: 'wordpress', label: 'Banner & Beiträge bearbeiten', level: 'write', description: 'Entwürfe anlegen und bearbeiten.' },
  { id: 'wordpress.publish', module: 'wordpress', label: 'Veröffentlichen', level: 'critical', description: 'Banner veröffentlichen/deaktivieren und Beiträge an WordPress senden.' },
  { id: 'user.read', module: 'users', label: 'Benutzer ansehen', level: 'read', description: 'Benutzerliste und Rollen ansehen.' },
  { id: 'user.manage', module: 'users', label: 'Benutzer verwalten', level: 'critical', description: 'Einladen, Rollen ändern, deaktivieren, 2FA zurücksetzen.' },
  { id: 'audit.read', module: 'system', label: 'Audit-Protokoll ansehen', level: 'read', description: 'Wer hat wann was geändert.' },
  { id: 'system.read', module: 'system', label: 'Systemstatus ansehen', level: 'read', description: 'Systemstatus und Protokolle ansehen.' },
  { id: 'system.manage', module: 'system', label: 'System verwalten', level: 'critical', description: 'Einstellungen, Sicherungen und API-Schlüssel verwalten.' },
];

export interface RoleDef {
  id: string;
  label: string;
  description: string;
  permissions: string[];
}

const ALL = PERMISSIONS.map((p) => p.id);

export const ROLES: RoleDef[] = [
  {
    id: 'platform_admin',
    label: 'Plattform-Admin',
    description: 'Vollzugriff inklusive Benutzer, System, Sicherungen und Updates.',
    permissions: ALL,
  },
  {
    id: 'integration_admin',
    label: 'Integrations-Admin',
    description: 'Verwaltet Schnittstellen, Zugangsdaten und Webhooks.',
    permissions: ['connection.read', 'connection.edit', 'credential.manage', 'workflow.read', 'run.read', 'wordpress.read', 'system.read', 'audit.read'],
  },
  {
    id: 'workflow_editor',
    label: 'Workflow-Editor',
    description: 'Entwirft und testet Workflows, beantragt Freigaben.',
    permissions: ['workflow.read', 'workflow.edit', 'run.read', 'connection.read', 'wordpress.read'],
  },
  {
    id: 'approver',
    label: 'Freigebender',
    description: 'Gibt Workflow-Versionen frei, aktiviert sie und darf Läufe wiederholen.',
    permissions: ['workflow.read', 'workflow.approve', 'workflow.publish', 'run.read', 'run.replay', 'connection.read', 'audit.read'],
  },
  {
    id: 'operator',
    label: 'Betriebsleser',
    description: 'Sieht Status, Läufe und Protokolle, ändert nichts.',
    permissions: ['workflow.read', 'run.read', 'connection.read', 'wordpress.read', 'system.read'],
  },
  {
    id: 'wp_editor',
    label: 'WordPress-Redakteur',
    description: 'Betreut Banner und Beiträge auf der Website.',
    permissions: ['wordpress.read', 'wordpress.edit', 'wordpress.publish'],
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);

export function permissionsFor(roles: string[]): Set<string> {
  const set = new Set<string>();
  for (const r of roles) for (const p of ROLES.find((x) => x.id === r)?.permissions ?? []) set.add(p);
  return set;
}

export function isAdminRoleSet(roles: string[]): boolean {
  return roles.includes('platform_admin') || roles.includes('integration_admin');
}

/** Matrix-Zelle je Modul und Rolle: full | edit | read | none */
export function matrix() {
  return MODULES.map((m) => {
    const perms = PERMISSIONS.filter((p) => p.module === m.id);
    return {
      module: m.id,
      label: m.label,
      cells: ROLES.map((r) => {
        const has = perms.filter((p) => r.permissions.includes(p.id));
        const level = has.length === 0 ? 'none' : has.length === perms.length ? 'full' : has.some((p) => p.level !== 'read') ? 'edit' : 'read';
        return { role: r.id, level, permissions: has.map((p) => p.id) };
      }),
    };
  });
}
