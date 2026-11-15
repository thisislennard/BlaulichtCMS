/**
 * Rechte-Registry. Jedes Recht gehört zu einem Bereich; die Berechtigungsmatrix in der
 * Oberfläche wird daraus erzeugt. Grundsatz: Standard ist verweigern. Rollen sind kombinierbar.
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
  { id: 'media', label: 'Medien' },
  { id: 'editorial', label: 'Redaktion' },
  { id: 'approval', label: 'Freigabe' },
  { id: 'publishing', label: 'Veröffentlichung' },
  { id: 'warnings', label: 'Warnentwürfe' },
  { id: 'connections', label: 'Verbindungen' },
  { id: 'users', label: 'Benutzer' },
  { id: 'system', label: 'System & Protokolle' },
];

export const PERMISSIONS: PermissionDef[] = [
  { id: 'media.read', module: 'media', label: 'Medien sichten', level: 'read', description: 'Sammlungen und geprüfte Medien ansehen und herunterladen.' },
  { id: 'media.manage', module: 'media', label: 'Medien verwalten', level: 'write', description: 'Sammlungen anlegen, Upload-Links erstellen und widerrufen, Medien auswählen, sortieren und löschen.' },
  { id: 'post.read', module: 'editorial', label: 'Beiträge ansehen', level: 'read', description: 'Beiträge, Fassungen und Veröffentlichungsstatus ansehen.' },
  { id: 'post.edit', module: 'editorial', label: 'Beiträge bearbeiten', level: 'write', description: 'Beiträge anlegen, bearbeiten, Medien übernehmen und zur Freigabe einreichen.' },
  { id: 'post.approve', module: 'approval', label: 'Fassungen freigeben', level: 'critical', description: 'Eine konkrete Fassung eines Beitrags freigeben oder zurückweisen.' },
  { id: 'post.publish', module: 'publishing', label: 'Veröffentlichen', level: 'critical', description: 'Freigegebene Fassungen an einen Zielkanal (z. B. WordPress) übergeben.' },
  { id: 'channel.manage', module: 'publishing', label: 'Kanäle verwalten', level: 'critical', description: 'Websites mit der BlaulichtCMS Bridge koppeln, Schlüssel widerrufen.' },
  { id: 'warning.draft', module: 'warnings', label: 'Warnentwurf erstellen', level: 'write', description: 'Warnentwürfe erfassen, speichern und zur Freigabe einreichen.' },
  { id: 'warning.level', module: 'warnings', label: 'Warnstufe bestätigen', level: 'critical', description: 'Den Warnstufen-Vorschlag ausdrücklich bestätigen oder mit Begründung ändern.' },
  { id: 'warning.approve', module: 'warnings', label: 'Warnentwurf freigeben', level: 'critical', description: 'Eine erzeugte PDF-Fassung eines Warnentwurfs freigeben.' },
  { id: 'warning.rules', module: 'warnings', label: 'Stichwörter und Regeln pflegen', level: 'critical', description: 'Stichwörter, Prüffragen, Warnstufen-Regeln, Vorlagen und Zuständigkeiten pflegen.' },
  { id: 'warning.send', module: 'warnings', label: 'Warnentwurf versenden', level: 'critical', description: 'Freigegebene Warnentwürfe per E-Mail an die zuständige Stelle senden.' },
  { id: 'connection.manage', module: 'connections', label: 'Verbindungen verwalten', level: 'critical', description: 'Optionale Verbindungen (FE2, Facebook, Instagram, amtliche Warnfeeds) einrichten, testen, aktivieren und widerrufen.' },
  { id: 'user.read', module: 'users', label: 'Benutzer ansehen', level: 'read', description: 'Benutzerliste und Rollen ansehen.' },
  { id: 'user.manage', module: 'users', label: 'Benutzer verwalten', level: 'critical', description: 'Einladen, Rollen ändern, deaktivieren, Zwei-Faktor zurücksetzen.' },
  { id: 'audit.read', module: 'system', label: 'Audit-Protokoll ansehen', level: 'read', description: 'Wer hat wann was geändert.' },
  { id: 'system.read', module: 'system', label: 'Systemstatus ansehen', level: 'read', description: 'Systemstatus und Protokolle ansehen.' },
  { id: 'system.manage', module: 'system', label: 'System verwalten', level: 'critical', description: 'Einstellungen, Sicherungen und API-Schlüssel verwalten.' },
  { id: 'privacy.manage', module: 'system', label: 'Datenschutzanfragen bearbeiten', level: 'critical', description: 'Personenbezogene Daten über alle Bereiche suchen, als Auskunft exportieren und je Treffer löschen oder pseudonymisieren (Art. 15/17 DSGVO).' },
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
    label: 'Administration',
    description: 'Vollzugriff: Konten, Rechte, Kanäle, Systemzustand, Sicherungen.',
    permissions: ALL,
  },
  {
    id: 'media_manager',
    label: 'Medienverwaltung',
    description: 'Pflegt Sammlungen und Upload-Links, sichtet und wählt Medien aus.',
    permissions: ['media.read', 'media.manage', 'post.read'],
  },
  {
    id: 'editor',
    label: 'Redaktion',
    description: 'Erstellt Beiträge, übernimmt Medien und reicht Fassungen zur Freigabe ein.',
    permissions: ['media.read', 'media.manage', 'post.read', 'post.edit'],
  },
  {
    id: 'approver',
    label: 'Freigabe',
    description: 'Gibt geprüfte Fassungen frei.',
    permissions: ['media.read', 'post.read', 'post.approve', 'audit.read'],
  },
  {
    id: 'publisher',
    label: 'Veröffentlichung',
    description: 'Übergibt freigegebene Fassungen an die Zielkanäle.',
    permissions: ['media.read', 'post.read', 'post.publish'],
  },
  {
    id: 'warning_author',
    label: 'Warnentwurf',
    description: 'Erfasst Warnentwürfe (Erstmeldung, Aktualisierung, Entwarnung).',
    permissions: ['warning.draft'],
  },
  {
    id: 'warning_approver',
    label: 'Warnfreigabe',
    description: 'Bestätigt Warnstufen, gibt Warnentwürfe und Regeln fachlich frei.',
    permissions: ['warning.draft', 'warning.level', 'warning.approve'],
  },
  {
    id: 'warning_sender',
    label: 'Warnversand',
    description: 'Versendet freigegebene Warnentwürfe an die zuständige Stelle.',
    permissions: ['warning.send'],
  },
  {
    id: 'viewer',
    label: 'Lesezugriff',
    // Ohne system.read: Systemprotokolle (Stacktraces, Pfade) und Einstellungen (Mailserver) sind Sache der Administration
    description: 'Sieht Beiträge, Medien und deren Status, ändert nichts.',
    permissions: ['media.read', 'post.read'],
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);

export function permissionsFor(roles: string[]): Set<string> {
  const set = new Set<string>();
  for (const r of roles) for (const p of ROLES.find((x) => x.id === r)?.permissions ?? []) set.add(p);
  return set;
}

export function isAdminRoleSet(roles: string[]): boolean {
  return roles.includes('platform_admin');
}

/** Matrix-Zelle je Bereich und Rolle: full | edit | read | none */
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
