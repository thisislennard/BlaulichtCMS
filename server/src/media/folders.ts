/**
 * Reine Hilfen für Ordner innerhalb einer Sammlung (ohne Datenbank, einzeln testbar).
 * Ordner sind beliebig tief; ein Ordner gehört immer genau zu einer Sammlung.
 */
export interface FolderNode {
  id: string;
  parent_id: string | null;
  name: string;
}

export const FOLDER_MAX_DEPTH = 12;

/** Name eines Ordners prüfen: 1–80 Zeichen, keine Pfad- oder Steuerzeichen (Ordnernamen werden zu ZIP-Pfaden). */
export function cleanFolderName(raw: string): string {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Bitte einen Ordnernamen angeben.');
  if (name === '.' || name === '..') throw new Error('Dieser Ordnername ist nicht erlaubt.');
  return name.slice(0, 80);
}

/** Pfad von der obersten Ebene bis zum Ordner (Namen). Unbekannte/zyklische Verweise brechen sicher ab. */
export function folderPath(folders: FolderNode[], id: string | null): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: FolderNode[] = [];
  const seen = new Set<string>();
  for (let cur = id ? byId.get(id) : undefined; cur && !seen.has(cur.id) && out.length < 100; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** Alle Unterordner (rekursiv) eines Ordners, ohne ihn selbst. */
export function descendants(folders: FolderNode[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const f of folders) {
      if (f.parent_id === cur && !seen.has(f.id)) {
        seen.add(f.id);
        out.push(f.id);
        queue.push(f.id);
      }
    }
  }
  return out;
}

/** Würde das Verschieben von `id` unter `newParent` einen Kreis erzeugen (in sich selbst oder einen Unterordner)? */
export function wouldCycle(folders: FolderNode[], id: string, newParent: string | null): boolean {
  if (!newParent) return false;
  return newParent === id || descendants(folders, id).includes(newParent);
}

/** Tiefe eines Ordners nach dem Verschieben (oberste Ebene = 1), inklusive seiner tiefsten Unterordner. */
export function depthAfterMove(folders: FolderNode[], id: string, newParent: string | null): number {
  const parentDepth = newParent ? folderPath(folders, newParent).length : 0;
  let below = 0;
  const walk = (fid: string, d: number) => {
    below = Math.max(below, d);
    for (const f of folders) if (f.parent_id === fid) walk(f.id, d + 1);
  };
  walk(id, 1);
  return parentDepth + below;
}

/** Ordnerpfad als ZIP-Verzeichnis („Einsatz/Drohne/“), leer für die oberste Ebene. */
export function zipDir(folders: FolderNode[], id: string | null): string {
  const parts = folderPath(folders, id).map((f) => f.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '_');
  return parts.length ? `${parts.join('/')}/` : '';
}
