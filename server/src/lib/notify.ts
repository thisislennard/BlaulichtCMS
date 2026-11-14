import { pool } from '../db/pool.js';

/**
 * In-App-Benachrichtigung an alle Benutzer mit einem Recht (oder an eine Person).
 * Inhalte bleiben knapp und enthalten keine Einsatzdetails.
 */
export async function notify(n: { kind: 'error' | 'warning' | 'info' | 'success'; title: string; body?: string; link?: string; permission?: string; userId?: string }) {
  await pool.query('INSERT INTO notifications (kind, title, body, link, permission, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [
    n.kind,
    n.title.slice(0, 200),
    (n.body ?? '').slice(0, 1000),
    n.link ?? null,
    n.permission ?? null,
    n.userId ?? null,
  ]);
}
