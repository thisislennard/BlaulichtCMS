import { one, pool, tx, type Queryable } from '../db/pool.js';

/*
 * Presseverteiler (#207, #244): Rechtsgrundlage je Kontakt, Sperrvermerk nach Abmeldung, Wiedervorlage und Löschen
 * samt Versandprotokollen. Gemeinsam genutzt von routes/press-distribution.ts und den Datenschutzanfragen.
 */

export const LEGAL_BASES = ['public', 'consent', 'other'] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];
export const LEGAL_BASIS_LABEL: Record<LegalBasis, string> = {
  public: 'Öffentliche Redaktionsadresse / Öffentlichkeitsarbeit (Art. 6 Abs. 1 lit. e DSGVO)',
  consent: 'Einwilligung (Art. 6 Abs. 1 lit. a DSGVO)',
  other: 'Andere Grundlage (im Nachweis beschrieben)',
};
/** Kurzform für Audit und Liste */
export const LEGAL_BASIS_SHORT: Record<LegalBasis, string> = { public: 'öffentliche Redaktionsadresse', consent: 'Einwilligung', other: 'andere Grundlage' };

/** CSV-Werte der Spalte „rechtsgrundlage“ → Grundlage */
export function legalBasisFromCsv(v: string): LegalBasis | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/^(public|öffentlich|oeffentlich|öffentliche redaktionsadresse|art\.? ?6 abs\.? ?1 lit\.? ?e|lit\.? ?e)$/.test(s)) return 'public';
  if (/^(consent|einwilligung|art\.? ?6 abs\.? ?1 lit\.? ?a|lit\.? ?a)$/.test(s)) return 'consent';
  if (/^(other|andere|sonstige|andere grundlage)$/.test(s)) return 'other';
  return null;
}

/** Datum aus CSV oder Formular: JJJJ-MM-TT oder TT.MM.JJJJ → JJJJ-MM-TT (nicht in der Zukunft); sonst null. */
export function parseConsentDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}` : (m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)) ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  if (d.getTime() > Date.now() + 86400_000) return null;
  return iso;
}

/** Problem mit Herkunft/Rechtsgrundlage eines Kontakts – oder null. */
export function basisProblem(v: { origin: string; legalBasis: LegalBasis | null; consentAt: string | null; consent: string }): string | null {
  if (!v.origin.trim()) return 'Bitte die Herkunft der Adresse angeben (z. B. Visitenkarte, Anfrage per Mail, Impressum der Redaktion).';
  if (!v.legalBasis) return 'Bitte die Rechtsgrundlage wählen.';
  if (v.legalBasis === 'consent' && !v.consentAt) return 'Bei einer Einwilligung bitte das Datum der Einwilligung angeben.';
  if (v.legalBasis === 'other' && !v.consent.trim()) return 'Bei einer anderen Grundlage bitte im Nachweis beschreiben, welche.';
  return null;
}

/**
 * Letzte Aktivität eines Kontakts `c` für die Wiedervorlage: Anlage, Änderung, „Geprüft“, letzte Pressemitteilung
 * an ihn (über die Kontakt-ID, auch nach einer Adressänderung).
 */
export const CONTACT_LAST_ACTIVITY = `GREATEST(c.created_at, c.updated_at, c.reviewed_at,
    (SELECT max(x.sent_at) FROM press_release_recipients x WHERE x.contact_id = c.id))`;

/**
 * Abmeldung: Sperrvermerk auf das Nötige reduzieren (#244). Es bleiben Adresse (damit sie nicht erneut aufgenommen bzw.
 * beschickt wird), Abmeldezeitpunkt und die vermerkte Rechtsgrundlage samt Datum (Nachweis für bereits Versandtes,
 * Art. 5 Abs. 2 und Art. 7 Abs. 1 DSGVO); Name, Medium, Telefon, Notiz, Herkunft, Freitext und Listen entfallen.
 */
export async function unsubscribeContact(id: string, db: Queryable = pool): Promise<{ id: string } | null> {
  const c = await one<{ id: string }>(
    `UPDATE press_contacts SET unsubscribed_at = COALESCE(unsubscribed_at, now()), name = '', outlet = '', phone = '', note = '', origin = '', consent = '', reviewed_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id],
    db,
  );
  if (c) await db.query(`DELETE FROM press_list_members WHERE contact_id = $1`, [id]);
  return c;
}

/** Pressemitteilungen an einen Kontakt (über Kontakt-ID oder Adresse) – z. B. für Datenschutzanfragen. */
export async function pressContactMailings(id: string, db: Queryable = pool): Promise<number> {
  return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM press_release_recipients x WHERE x.contact_id = $1 OR lower(x.email) = (SELECT lower(email) FROM press_contacts WHERE id = $1)`, [id], db))!.n;
}

/**
 * Kontakt löschen und seine Einträge in den Versandprotokollen pseudonymisieren – über die Kontakt-ID (auch frühere
 * Adressen nach einer Änderung) und die aktuelle Adresse (#244). Gibt Adresse und Medium des gelöschten Kontakts zurück.
 */
export async function deletePressContact(id: string): Promise<{ email: string; outlet: string } | null> {
  return tx(async (db) => {
    const c = await one<{ email: string; outlet: string }>(`SELECT email, outlet FROM press_contacts WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) return null;
    await db.query(`UPDATE press_release_recipients SET email = 'gelöscht:' || left(id::text, 8), name = '', error = CASE WHEN error IS NULL THEN NULL ELSE '(entfernt)' END WHERE email NOT LIKE 'gelöscht:%' AND (contact_id = $1 OR lower(email) = lower($2))`, [id, c.email]);
    await db.query(`DELETE FROM press_contacts WHERE id = $1`, [id]);
    return c;
  });
}
