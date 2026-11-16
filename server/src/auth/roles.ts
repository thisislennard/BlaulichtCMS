import { many, pool, type Queryable } from '../db/pool.js';
import { log } from '../lib/log.js';
import { ADMIN_ROLE, PERMISSION_IDS, SYSTEM_ROLES, setActiveRoles, withRequirements, type ActiveRole } from './permissions.js';

/**
 * Rollen aus der Datenbank (Tabelle `roles`) in den Arbeitsspeicher laden. Die Rechteprüfung (permissionsFor) liest
 * nur diesen Stand. Aktualität:
 *
 * - Der Prozess, der eine Rolle ändert, lädt sofort neu (reloadRoles nach dem Speichern).
 * - Andere Prozesse (Worker, weitere API-Prozesse) erfahren die Änderung über NOTIFY `blaulichtcms_events`
 *   (Tabellenname `roles`, siehe routes/events.ts) und spätestens nach ROLE_TTL_MS beim nächsten Zugriff.
 *
 * Sitzungen speichern keine Rechte: Jede Anfrage rechnet sie aus Rollen des Kontos und dem aktuellen Rollenstand neu
 * aus – eine Änderung gilt damit ab der nächsten Anfrage der betroffenen Personen.
 */
export const ROLE_TTL_MS = 3_000;

interface RoleRow {
  id: string;
  label: string;
  description: string;
  permissions: string[] | null;
  is_system: boolean;
}

let loadedAt = 0;
let loading: Promise<void> | null = null;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function toActive(r: RoleRow): ActiveRole {
  const def = SYSTEM_ROLES.find((s) => s.id === r.id);
  if (r.id === ADMIN_ROLE) return { id: r.id, label: def!.label, description: def!.description, permissions: [...PERMISSION_IDS], system: true, customized: false };
  // Mitgelieferte Rolle ohne eigene Rechte: Vorgabe des Programms (auch für Rechte künftiger Versionen)
  if (def && r.is_system) {
    const permissions = r.permissions ? withRequirements(r.permissions) : def.permissions;
    return { id: r.id, label: def.label, description: def.description, permissions, system: true, customized: !!r.permissions && !sameSet(permissions, def.permissions) };
  }
  return { id: r.id, label: r.label, description: r.description, permissions: withRequirements(r.permissions ?? []), system: false, customized: false };
}

/** Rollenstand neu aus der Datenbank laden (nach Änderungen sofort aufrufen). */
export async function reloadRoles(db: Queryable = pool): Promise<void> {
  const rows = await many<RoleRow>('SELECT id, label, description, permissions, is_system FROM roles ORDER BY is_system DESC, lower(label)', [], db);
  const known = new Set(rows.map((r) => r.id));
  // Fehlende mitgelieferte Rollen (z. B. neu in einer späteren Version) gelten mit ihrer Vorgabe
  const missing = SYSTEM_ROLES.filter((s) => !known.has(s.id)).map((s) => ({ ...s, system: true, customized: false }));
  const order = new Map(SYSTEM_ROLES.map((s, i) => [s.id, i]));
  const all = [...rows.map(toActive), ...missing].sort((a, b) => (order.get(a.id) ?? 1000) - (order.get(b.id) ?? 1000) || a.label.localeCompare(b.label, 'de'));
  setActiveRoles(all);
  loadedAt = Date.now();
}

/** Vor Rechteprüfungen aufrufen: lädt höchstens alle ROLE_TTL_MS neu. Fehler lassen den letzten Stand bestehen. */
export async function ensureRolesFresh(maxAgeMs = ROLE_TTL_MS): Promise<void> {
  if (Date.now() - loadedAt < maxAgeMs) return;
  if (!loading) {
    loading = reloadRoles()
      .catch((e) => {
        // Tabelle noch nicht vorhanden (vor der Migration) oder Datenbank kurz weg: Vorgaben bzw. letzter Stand gelten
        loadedAt = Date.now() - maxAgeMs + 1_000;
        log('warn', 'auth', `Rollen konnten nicht geladen werden: ${(e as Error).message}`);
      })
      .finally(() => (loading = null));
  }
  return loading;
}

/** Stand als veraltet markieren (Meldung eines anderen Prozesses): die nächste Prüfung lädt neu. */
export function invalidateRoles() {
  loadedAt = 0;
}
