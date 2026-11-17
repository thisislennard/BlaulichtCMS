/**
 * Arten von Benachrichtigungen (#191, wie die Kategorien in LiFeOS #922): Jede Benachrichtigung der Glocke gehört zu
 * einer Art. Je Art wählt jede Person, ob sie zusätzlich per Push (auf ihre Geräte) und/oder per E-Mail kommt.
 * Angeboten werden nur Arten, für die die Person mindestens eines der Rechte hat (`permissions`, leer = alle).
 * Bewusst ohne Importe: wird von lib/notify.ts, den Routen und Tests gemeinsam genutzt.
 */
export type NotifyChannel = 'push' | 'mail';
export const NOTIFY_CHANNELS: NotifyChannel[] = ['push', 'mail'];

export interface NotifyCategory {
  id: string;
  label: string;
  description: string;
  /** mindestens eines dieser Rechte (leer = jede angemeldete Person) */
  permissions: string[];
  /** angebotene Kanäle (Sicherheitsmeldungen per E-Mail regeln die Sicherheitseinstellungen) */
  channels: NotifyChannel[];
  /** Vorgabe, solange die Person nichts gewählt hat */
  defaults: NotifyChannel[];
  /** Dringlichkeit für den Push-Dienst */
  urgency: 'normal' | 'high';
  /**
   * Knapper Titel ohne Einzelheiten (#247): Push und E-Mail tragen standardmäßig nur diesen Titel und einen Link –
   * Stichwort, Ort, Betreff einer Presse-Mail oder Vorlagentexte bleiben in BlaulichtCMS (notify.push_details,
   * notify.mail_details).
   */
  short: string;
}

const C = (id: string, label: string, description: string, permissions: string[], defaults: NotifyChannel[], opts: { channels?: NotifyChannel[]; urgency?: 'normal' | 'high'; short?: string } = {}): NotifyCategory => ({
  id,
  label,
  description,
  permissions,
  channels: opts.channels ?? ['push', 'mail'],
  defaults,
  urgency: opts.urgency ?? 'normal',
  short: opts.short ?? label,
});

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  C('approval', 'Freigabe angefordert', 'Ein Beitrag, Banner, Eintrag der Einsatzliste, Warnentwurf oder Schritt eines Workflows wartet auf Freigabe.', ['approval.post', 'approval.banner', 'approval.incident', 'approval.automation', 'warning.approve', 'press.approve'], ['push'], { urgency: 'high', short: 'Freigabe angefordert' }),
  C('decision', 'Eigene Fassung freigegeben oder zurückgewiesen', 'Eine selbst eingereichte Fassung wurde freigegeben oder zurückgewiesen.', ['post.submit'], ['push'], { short: 'Entscheidung über eine eigene Fassung' }),
  C('incident', 'Einsatz-Eingang (FE2, Feuersoftware Connect)', 'Aus einer Einsatzmeldung wurde ein Beitragsentwurf angelegt oder aktualisiert.', ['post.edit'], ['push'], { urgency: 'high', short: 'Neuer Einsatz-Eingang' }),
  C('drafts', 'Neue Entwürfe aus Workflows', 'Ein Workflow hat einen Beitrags-, Einsatzlisten- oder Warnentwurf vorbereitet.', ['post.edit', 'incident.edit', 'warning.draft'], [], { short: 'Neuer Entwurf aus einem Workflow' }),
  C('press', 'Presseanfragen', 'Neue Presseanfrage, eine Anfrage wurde dir zugewiesen, eine Frist läuft bald ab oder ist überschritten, eine Antwort konnte nicht gesendet werden.', ['press.view'], ['push'], { urgency: 'high', short: 'Neues zu Presseanfragen' }),
  C('media_new', 'Neue Dateien über Upload-Links', 'Über einen Upload-Link sind Fotos oder Videos eingegangen und geprüft (gebündelt je Sammlung, höchstens eine Meldung je Stunde).', ['media.review'], ['push'], { short: 'Neue Dateien über Upload-Links' }),
  C('media_link', 'Upload-Links und Kontingente', 'Ein Upload-Link läuft bald ab oder ein Kontingent ist erreicht.', ['media.review'], [], { short: 'Hinweis zu Upload-Links' }),
  C('media_storage', 'Speicherplatz der Medien', 'Der Speicher für Medien unterschreitet die Warnschwelle.', ['media.admin'], ['mail'], { short: 'Speicherplatz der Medien' }),
  C('official', 'Amtliche Warnungen (z. B. DWD, MoWaS)', 'Eine neue amtliche Warnung für das eingestellte Gebiet ist eingegangen.', ['official.view'], ['push'], { urgency: 'high', short: 'Neue amtliche Warnung' }),
  C('publish', 'Veröffentlichungen', 'Ergebnis einer Veröffentlichung auf Website oder sozialen Netzwerken, Banner oder Einsatzliste nicht übertragen, Rückzug.', ['publish.website', 'publish.social', 'banner.publish', 'incident.publish'], [], { short: 'Meldung zu einer Veröffentlichung' }),
  C('warning_send', 'Versand von Warnentwürfen', 'Der Versand eines Warnentwurfs ist fehlgeschlagen oder sein Ergebnis ist unklar.', ['warning.send'], ['push', 'mail'], { urgency: 'high', short: 'Versand eines Warnentwurfs prüfen' }),
  C('connection', 'Verbindungsfehler', 'Eine Verbindung (z. B. Feuersoftware Connect, Warnfeed, Website) ist gestört oder wurde getrennt.', ['connection.configure', 'channel.sites'], ['mail'], { short: 'Verbindung gestört' }),
  C('automation', 'Workflow fehlgeschlagen', 'Ein Lauf eines Workflows ist fehlgeschlagen oder wurde gebremst.', ['automation.manage'], ['mail'], { short: 'Workflow fehlgeschlagen' }),
  C('automation_message', 'Benachrichtigungen aus Workflows', 'Ein Workflow benachrichtigt das Konto ausdrücklich (Aktion „Benachrichtigen“).', [], ['push'], { short: 'Benachrichtigung aus einem Workflow' }),
  C('update', 'Update verfügbar und installiert', 'Eine neue Version von BlaulichtCMS steht bereit bzw. ein Update wurde abgeschlossen.', ['update.install'], ['mail'], { short: 'Meldung zu Updates' }),
  C('system', 'Sicherung fehlgeschlagen', 'Eine Datenbank- oder Volume-Sicherung, die Übertragung außer Haus oder eine Probe-Wiederherstellung ist fehlgeschlagen.', ['backup.manage'], ['mail'], { short: 'Sicherung fehlgeschlagen' }),
  C('security', 'Sicherheitsmeldungen', 'Sicherheitsrelevante Ereignisse für die Administration. Die E-Mail dazu regeln die Sicherheitseinstellungen.', ['settings.security', 'user.assign_roles', 'channel.sites', 'connection.configure', 'media.admin', 'update.install', 'automation.publish', 'audit.view'], ['push'], { channels: ['push'], short: 'Sicherheitsmeldung' }),
  C('account', 'Eigenes Konto', 'Änderungen am eigenen Konto (Passwort, Zwei-Faktor, Sperre). Die E-Mail dazu regeln die Sicherheitseinstellungen.', [], ['push'], { channels: ['push'], short: 'Änderung am eigenen Konto' }),
];

const BY_ID = new Map(NOTIFY_CATEGORIES.map((c) => [c.id, c]));
export const notifyCategory = (id: string | null | undefined) => (id ? BY_ID.get(id) : undefined);

/** Art aus dem Recht der Benachrichtigung ableiten, wenn der Aufrufer keine angibt. */
const BY_PERMISSION: Record<string, string> = {
  'approval.post': 'approval',
  'approval.banner': 'approval',
  'approval.automation': 'approval',
  'approval.incident': 'approval',
  'incident.publish': 'publish',
  'incident.edit': 'drafts',
  'warning.approve': 'approval',
  'post.edit': 'drafts',
  'warning.draft': 'drafts',
  'publish.website': 'publish',
  'publish.social': 'publish',
  'banner.publish': 'publish',
  'channel.sites': 'connection',
  'connection.configure': 'connection',
  'automation.manage': 'automation',
  'official.view': 'official',
  'warning.send': 'warning_send',
  'backup.manage': 'system',
  'update.install': 'update',
  'press.view': 'press',
  'press.manage': 'press',
  'press.reply': 'press',
  'press.approve': 'approval',
  'press.release': 'press',
};

export function categoryFor(category: string | null | undefined, permission: string | null | undefined): string | null {
  if (category && BY_ID.has(category)) return category;
  return (permission && BY_PERMISSION[permission]) || null;
}

/** Arten, die eine Person mit diesen Rechten angeboten bekommt. */
export function categoriesFor(perms: Set<string>): NotifyCategory[] {
  return NOTIFY_CATEGORIES.filter((c) => !c.permissions.length || c.permissions.some((p) => perms.has(p)));
}

/** Gewählte Kanäle je Art (gespeicherte Wahl, sonst Vorgabe), beschränkt auf die angebotenen Kanäle. */
export function chosenChannels(cat: NotifyCategory, prefs: unknown): NotifyChannel[] {
  const stored = prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>)[cat.id] : undefined;
  const list = Array.isArray(stored) ? (stored as unknown[]).map(String) : cat.defaults;
  return cat.channels.filter((ch) => list.includes(ch));
}
