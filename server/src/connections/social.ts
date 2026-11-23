import { one, pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { StepError, toStepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { connectionSecrets, isReadOnly, scrub, type Connection } from './common.js';
import { findExisting, findExistingStory, mediaForRevision, publishFacebook, publishFacebookStory, publishInstagram, publishInstagramStory } from './meta.js';
import { findExistingThreads, publishThreads } from './threads.js';
import { findExistingX, publishX } from './x.js';
import { findExistingMastodon, publishMastodon } from './mastodon.js';
import { findExistingBluesky, publishBluesky } from './bluesky.js';
import { isManualChannel } from './channels.js';
import { enqueueFollowUp } from '../jobs/queue.js';
import { approvalStillValid } from '../lib/approval.js';

/**
 * Ein Auftrag je Netzwerk und Fassung. Genau ein Versuch pro Anstoß (kein automatisches Wiederholen):
 *  - bestätigter Fehler → failed (nur dieses Netzwerk kann erneut angestoßen werden)
 *  - Abbruch nach dem Absenden → unknown; vor jedem neuen Versuch wird geprüft, ob der Beitrag schon existiert
 */
export async function runSocialPublication(id: string) {
  const sp = await one<any>(`SELECT * FROM social_publications WHERE id = $1`, [id]);
  if (!sp || ['published', 'canceled'].includes(sp.status)) return;
  const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1`, [sp.connection_id]);
  const rev = await one<any>(`SELECT * FROM post_revisions WHERE id = $1`, [sp.revision_id]);
  if (!c || !rev) return;
  // Kanäle ohne Schnittstelle (Teilen von Hand) laufen nie über die Warteschlange
  if (isManualChannel(c) || sp.status === 'ready') return;
  const label = `${c.name}${sp.format === 'story' ? ' (Story)' : ''}`;
  const fail = async (status: 'failed' | 'unknown', e: StepError) => {
    const sec = await connectionSecrets(c).catch(() => ({}));
    const msg = scrub(e.message, sec as any);
    await pool.query(`UPDATE social_publications SET status = $2, error = $3, error_class = $4, updated_at = now() WHERE id = $1`, [id, status, msg, e.errorClass]);
    await notify({ kind: status === 'unknown' ? 'warning' : 'error', title: `${label}: ${status === 'unknown' ? 'Ergebnis unbekannt – bitte prüfen' : 'Veröffentlichung fehlgeschlagen'}`, body: msg.slice(0, 200), link: `/beitraege/${sp.post_id}`, permission: 'publish.social' });
    log('warn', 'social', `${label}: ${status} – ${msg}`);
  };
  if (c.status !== 'active') return fail('failed', new StepError('config', 'Die Verbindung ist nicht aktiv.'));
  if (isReadOnly(c)) return fail('failed', new StepError('config', 'Die Verbindung steht auf „Nur lesen“ – Veröffentlichen ist gesperrt.'));
  const sec = await connectionSecrets(c);

  // Unbekannter Ausgang oder unterbrochener Lauf: zuerst nachsehen statt doppelt zu veröffentlichen
  if (sp.status === 'unknown' || sp.status === 'publishing') {
    try {
      const found = await lookupExisting(c, sec, sp);
      if (found) {
        await pool.query(`UPDATE social_publications SET status = 'published', remote_id = $2, remote_url = $3, error = NULL, published_at = now(), updated_at = now() WHERE id = $1`, [id, found.id, found.url]);
        await audit({ id: null, name: label, type: 'system' }, 'social.published', { type: 'post', id: sp.post_id }, { kanal: label, nachtraeglich_gefunden: true });
        return;
      }
    } catch (e) {
      return fail('unknown', toStepError(e));
    }
  }

  // Freigabe erneut prüfen (Widerruf, neuere Fassung) – erst nach der Suche oben, damit ein bereits
  // erschienener Beitrag trotzdem als veröffentlicht erfasst wird
  const valid = await one(`SELECT 1 FROM social_publications sp WHERE sp.id = $1 AND ${approvalStillValid('sp')}`, [id]);
  if (!valid) {
    await pool.query(`UPDATE social_publications SET status = 'canceled', error = 'Freigabe nicht mehr gültig', updated_at = now() WHERE id = $1`, [id]);
    log('warn', 'social', `${label}: abgebrochen – Freigabe nicht mehr gültig`);
    return;
  }
  // Sperrfrist der freigegebenen Fassung einhalten (#53)
  if (rev.publish_at && new Date(rev.publish_at).getTime() > Date.now()) {
    await enqueueFollowUp('social.publish', { id }, new Date(rev.publish_at), `social.publish:${id}`);
    return;
  }
  // Übergang nur, wenn der Auftrag nicht inzwischen abgebrochen und die Freigabe noch gültig ist (#145) – ein Widerruf
  // zwischen der Prüfung oben und hier darf nicht zur Veröffentlichung führen
  const started = await one(
    `UPDATE social_publications sp SET status = 'publishing', attempts = attempts + 1, updated_at = now()
      WHERE sp.id = $1 AND sp.status IN ('queued','unknown','publishing') AND ${approvalStillValid('sp')} RETURNING sp.id`,
    [id],
  );
  if (!started) {
    log('warn', 'social', `${label}: nicht gestartet – Auftrag abgebrochen oder Freigabe widerrufen`);
    return;
  }
  const media = await mediaForRevision(rev);
  try {
    const onContainer = async (container: string | null) => {
      await pool.query(`UPDATE social_publications SET container_id = $2 WHERE id = $1`, [id, container]);
      sp.container_id = container;
    };
    const input = { sp, rev, media };
    const res =
      sp.format === 'story'
        ? c.kind === 'facebook'
          ? await publishFacebookStory(c, sec, input, onContainer)
          : await publishInstagramStory(c, sec, input, onContainer)
        : c.kind === 'facebook'
          ? await publishFacebook(c, sec, input)
          : c.kind === 'threads'
            ? await publishThreads(c, sec, input, onContainer)
            : c.kind === 'x'
              ? await publishX(c, sec, input)
              : c.kind === 'mastodon'
                ? await publishMastodon(c, sec, input)
                : c.kind === 'bluesky'
                  ? await publishBluesky(c, sec, input)
                  : await publishInstagram(c, sec, input, onContainer);
    await pool.query(`UPDATE social_publications SET status = 'published', remote_id = $2, remote_url = $3, error = NULL, error_class = NULL, published_at = now(), updated_at = now() WHERE id = $1`, [id, res.id, res.url]);
    await audit({ id: null, name: label, type: 'system' }, 'social.published', { type: 'post', id: sp.post_id, label: rev.title }, { kanal: label, url: res.url });
    await notify({ kind: 'success', title: `Veröffentlicht auf ${label}: ${rev.title}`.slice(0, 200), link: `/beitraege/${sp.post_id}`, permission: 'publish.social' });
  } catch (e) {
    const err = toStepError(e);
    // Eindeutige Ablehnung (4xx, Konfiguration, Format) → fehlgeschlagen; Netz/Zeitüberschreitung/5xx → unbekannt
    const definite = ['auth', 'permission', 'invalid_payload', 'config', 'rate_limit', 'conflict'].includes(err.errorClass);
    await fail(definite ? 'failed' : 'unknown', err);
  }
}

/** Wiedererkennung je Netzwerk und Format (vor jedem erneuten Versuch nach unklarem Ausgang). */
function lookupExisting(c: Connection, sec: Record<string, string>, sp: any) {
  if (sp.format === 'story') return findExistingStory(c, sec, sp);
  if (c.kind === 'threads') return findExistingThreads(c, sec, sp.marker, new Date(sp.created_at));
  if (c.kind === 'x') return findExistingX(c, sec, sp.marker, new Date(sp.created_at));
  if (c.kind === 'mastodon') return findExistingMastodon(c, sec, sp.marker, new Date(sp.created_at));
  if (c.kind === 'bluesky') return findExistingBluesky(c, sec, sp.marker, new Date(sp.created_at));
  return findExisting(c, sec, sp.marker, new Date(sp.created_at));
}
