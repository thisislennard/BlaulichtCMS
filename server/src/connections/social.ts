import { one, pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { StepError, toStepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { connectionSecrets, scrub, type Connection } from './common.js';
import { findExisting, mediaForRevision, publishFacebook, publishInstagram } from './meta.js';

/**
 * Ein Auftrag je Kanal und Fassung. Genau ein Versuch pro Anstoß (kein automatisches Wiederholen):
 *  - bestätigter Fehler → failed (nur dieser Kanal kann erneut angestoßen werden)
 *  - Abbruch nach dem Absenden → unknown; vor jedem neuen Versuch wird geprüft, ob der Beitrag schon existiert
 */
export async function runSocialPublication(id: string) {
  const sp = await one<any>(`SELECT * FROM social_publications WHERE id = $1`, [id]);
  if (!sp || ['published', 'canceled'].includes(sp.status)) return;
  const c = await one<Connection>(`SELECT * FROM connections WHERE id = $1`, [sp.connection_id]);
  const rev = await one<any>(`SELECT * FROM post_revisions WHERE id = $1`, [sp.revision_id]);
  if (!c || !rev) return;
  const label = `${c.name}`;
  const fail = async (status: 'failed' | 'unknown', e: StepError) => {
    const sec = await connectionSecrets(c).catch(() => ({}));
    const msg = scrub(e.message, sec as any);
    await pool.query(`UPDATE social_publications SET status = $2, error = $3, error_class = $4, updated_at = now() WHERE id = $1`, [id, status, msg, e.errorClass]);
    await notify({ kind: status === 'unknown' ? 'warning' : 'error', title: `${label}: ${status === 'unknown' ? 'Ergebnis unbekannt – bitte prüfen' : 'Veröffentlichung fehlgeschlagen'}`, body: msg.slice(0, 200), link: `/beitraege/${sp.post_id}`, permission: 'post.publish' });
    log('warn', 'social', `${label}: ${status} – ${msg}`);
  };
  if (c.status !== 'active') return fail('failed', new StepError('config', 'Der Kanal ist nicht aktiv.'));
  const sec = await connectionSecrets(c);

  // Unbekannter Ausgang oder unterbrochener Lauf: zuerst nachsehen statt doppelt zu veröffentlichen
  if (sp.status === 'unknown' || sp.status === 'publishing') {
    try {
      const found = await findExisting(c, sec, sp.marker, new Date(sp.created_at));
      if (found) {
        await pool.query(`UPDATE social_publications SET status = 'published', remote_id = $2, remote_url = $3, error = NULL, published_at = now(), updated_at = now() WHERE id = $1`, [id, found.id, found.url]);
        await audit({ id: null, name: label, type: 'system' }, 'social.published', { type: 'post', id: sp.post_id }, { kanal: label, nachtraeglich_gefunden: true });
        return;
      }
    } catch (e) {
      return fail('unknown', toStepError(e));
    }
  }

  await pool.query(`UPDATE social_publications SET status = 'publishing', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [id]);
  const media = await mediaForRevision(rev);
  try {
    const res =
      c.kind === 'facebook'
        ? await publishFacebook(c, sec, { sp, rev, media })
        : await publishInstagram(c, sec, { sp, rev, media }, async (container) => {
            await pool.query(`UPDATE social_publications SET container_id = $2 WHERE id = $1`, [id, container]);
          });
    await pool.query(`UPDATE social_publications SET status = 'published', remote_id = $2, remote_url = $3, error = NULL, error_class = NULL, published_at = now(), updated_at = now() WHERE id = $1`, [id, res.id, res.url]);
    await audit({ id: null, name: label, type: 'system' }, 'social.published', { type: 'post', id: sp.post_id, label: rev.title }, { kanal: label, url: res.url });
    await notify({ kind: 'success', title: `Veröffentlicht auf ${label}: ${rev.title}`.slice(0, 200), link: `/beitraege/${sp.post_id}`, permission: 'post.publish' });
  } catch (e) {
    const err = toStepError(e);
    // Eindeutige Ablehnung (4xx, Konfiguration, Format) → fehlgeschlagen; Netz/Zeitüberschreitung/5xx → unbekannt
    const definite = ['auth', 'permission', 'invalid_payload', 'config', 'rate_limit', 'conflict'].includes(err.errorClass);
    await fail(definite ? 'failed' : 'unknown', err);
  }
}
