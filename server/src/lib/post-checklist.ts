import { many, one, pool, type Queryable } from '../db/pool.js';
import { altCheck } from './accessibility.js';
import { missingMediaCount, privacyFindings } from './approval.js';
import { plural } from './text.js';
import { socialChecks } from '../connections/social-check.js';
import { SOCIAL_LABEL } from './social-text.js';

/**
 * Prüfliste vor dem Einreichen (#262). Fasst die Prüfungen zusammen, die Freigabe und Veröffentlichen ohnehin machen –
 * keine eigenen Regeln: Text (Einreichen), gelöschte Dateien (`assertMediaPresent`), Alternativtexte (`altCheck`),
 * Datenschutz-Prüfung (`privacyFindings`), Formate und Zeichengrenzen je Netzwerk (`socialChecks`, dieselben Regeln wie
 * beim Senden) und der Zustand der Ziele. „Blockiert“ ist nur, woran die Freigabe ohnehin scheitern würde; alles andere
 * sind Hinweise, die man bewusst übergehen kann.
 */

export type CheckLevel = 'ok' | 'info' | 'warning' | 'blocking';
/** Abschnitt im Beitrag, in dem sich ein Punkt beheben lässt (Anker im Editor). */
export type CheckSection = 'text' | 'medien' | 'website' | 'netzwerke';

export interface CheckItem {
  key: string;
  level: CheckLevel;
  title: string;
  details?: string[];
  section?: CheckSection;
}

export interface PostChecklist {
  items: CheckItem[];
  /** Mindestens ein Punkt verhindert das Einreichen (die Freigabe würde scheitern). */
  blocking: boolean;
  /** Anzahl der Hinweise (Stufe „warning“) */
  warnings: number;
}

interface RevisionLike {
  body: string;
  media_ids?: string[] | null;
  cover_id?: string | null;
  site_id?: string | null;
  social_targets?: string[] | null;
  social_formats?: Record<string, string> | null;
  media_alt?: Record<string, string> | null;
  publish_at?: string | Date | null;
  [k: string]: unknown;
}

export async function postChecklist(postId: string, rev: RevisionLike, db: Queryable = pool): Promise<PostChecklist> {
  const items: CheckItem[] = [];
  const mediaIds = rev.media_ids ?? [];

  // Text: ohne Text lässt sich nicht einreichen (POST /posts/:id/submit)
  items.push(rev.body.trim() ? { key: 'text', level: 'ok', title: 'Text vorhanden' } : { key: 'text', level: 'blocking', title: 'Noch kein Text', details: ['Bitte zuerst einen Text schreiben.'], section: 'text' });

  // Gelöschte Dateien (#167): Freigeben ist gesperrt
  const missing = await missingMediaCount(rev, db);
  if (missing) items.push({ key: 'media_missing', level: 'blocking', title: `${plural(missing, 'Datei', 'Dateien')} der Fassung inzwischen gelöscht`, details: ['Bitte die fehlenden Dateien aus der Fassung nehmen oder ersetzen und speichern.'], section: 'medien' });

  // Ziele
  const site = rev.site_id ? await one<{ name: string; status: string }>(`SELECT name, status FROM wp_sites WHERE id = $1`, [rev.site_id], db) : null;
  const social = await socialChecks(postId, rev);
  const targetNames = [...(site ? [`Website „${site.name}“`] : []), ...social.map((c) => `${SOCIAL_LABEL[c.kind] ?? c.kind} „${c.name}“`)];
  if (!targetNames.length) items.push({ key: 'targets', level: 'warning', title: 'Kein Veröffentlichungsziel gewählt', details: ['Der Beitrag bleibt nach der Freigabe intern. Für eine Veröffentlichung eine Website oder ein soziales Netzwerk wählen.'], section: 'website' });
  else items.push({ key: 'targets', level: 'ok', title: `Veröffentlichungsziele: ${targetNames.join(', ')}` });
  if (site && site.status !== 'active') items.push({ key: 'site_inactive', level: 'warning', title: `Website „${site.name}“ ist nicht aktiv`, details: ['Veröffentlichen geht erst, wenn die Website wieder gekoppelt ist.'], section: 'website' });
  if (site && rev.publish_at && new Date(rev.publish_at) < new Date()) items.push({ key: 'schedule', level: 'warning', title: 'Termin liegt in der Vergangenheit', details: ['Nach der Freigabe wird sofort veröffentlicht.'], section: 'website' });

  // Titelbild für die Website
  if (site) {
    const media = mediaIds.length ? await many<{ id: string; kind: string }>(`SELECT id, kind FROM media WHERE id = ANY($1) AND deleted_at IS NULL`, [mediaIds], db) : [];
    if (rev.cover_id) items.push({ key: 'cover', level: 'ok', title: 'Titelbild gesetzt' });
    else items.push({ key: 'cover', level: 'warning', title: 'Kein Titelbild', details: [media.some((m) => m.kind === 'image') ? 'Unter „Medien“ ein Bild „Als Titelbild“ wählen – sonst erscheint der Beitrag auf der Website ohne Bild.' : 'Der Beitrag erscheint auf der Website ohne Bild.'], section: 'medien' });
  }

  // Alternativtexte (#217): Pflicht laut Einstellung → die Freigabe scheitert, sonst Hinweis
  const alt = await altCheck(rev, db);
  if (alt.applies && alt.missing.length) {
    items.push({
      key: 'alt',
      level: alt.required ? 'blocking' : 'warning',
      title: `${alt.missing.length === 1 ? 'Ein Bild' : `${alt.missing.length} Bilder`} ohne Alternativtext`,
      details: [alt.required ? 'Alternativtexte sind laut Einstellung Pflicht – ohne sie scheitert die Freigabe.' : 'Menschen mit Screenreader erfahren sonst nicht, was zu sehen ist.'],
      section: 'medien',
    });
  } else if (alt.applies) items.push({ key: 'alt', level: 'ok', title: 'Alle Bilder haben einen Alternativtext' });

  // Datenschutz-Prüfung (#118, #214): verlangt die Freigabe; offene Gesichtsvorschläge lassen sich vorher klären
  const privacy = await privacyFindings(mediaIds, db);
  if (privacy.faces) items.push({ key: 'privacy', level: 'warning', title: `${privacy.faces === 1 ? 'Ein Bild' : `${privacy.faces} Bilder`} mit offenen Gesichtsvorschlägen`, details: ['Bitte unter „Medien“ prüfen. Die Freigabe verlangt sonst eine ausdrücklich bestätigte Datenschutz-Prüfung.'], section: 'medien' });
  else if (privacy.flagged) items.push({ key: 'privacy', level: 'info', title: `${plural(privacy.flagged, 'markierte Datei', 'markierte Dateien')}`, details: ['Die Freigabe verlangt eine ausdrücklich bestätigte Datenschutz-Prüfung.'], section: 'medien' });

  // Soziale Netzwerke: Zustand der Verbindung, Formate und Zeichengrenzen (dieselben Regeln wie beim Senden)
  for (const c of social) {
    const label = `${SOCIAL_LABEL[c.kind] ?? c.kind} „${c.name}“`;
    const details = [...(c.deleted ? ['Die Verbindung wurde gelöscht – dieses Netzwerk wird übersprungen.'] : c.status !== 'active' ? ['Die Verbindung ist nicht aktiv – dieses Netzwerk wird beim Veröffentlichen übersprungen.'] : []), ...c.formatIssues];
    items.push(details.length ? { key: `social:${c.id}`, level: 'warning', title: label, details, section: 'netzwerke' } : { key: `social:${c.id}`, level: 'ok', title: `${label}: Formate und Länge passen` });
  }

  return { items, blocking: items.some((i) => i.level === 'blocking'), warnings: items.filter((i) => i.level === 'warning').length };
}
