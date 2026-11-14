import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Wartungsbefehle (im Container: `docker compose exec lifelink node server/dist/cli.js <befehl>`):
 *   gen-master-key                 neuen LIFELINK_MASTER_KEY ausgeben
 *   migrate                        Datenbankschema aktualisieren (mit Startprüfung)
 *   preflight [--json]             Update-Vorabprüfung (Exit 0 = bereit)
 *   import-inventory <ordner>      Probelauf eines Medienimports (schreibt nichts)
 *   import-commit <ordner>         Import übernehmen (nur nach fehlerfreiem Probelauf)
 *   import-verify <ordner>         Mengen- und Prüfsummenabgleich nach der Übernahme
 *   maintenance on|off [grund]     Wartungsmodus vor/nach einem Update
 *   self-check                     Programmdateien laden und Datenbankverbindung prüfen
 *   backup-decrypt <datei> <ziel>  verschlüsselte Sicherung in eine pg_restore-Datei umwandeln
 *   password-link <email>          Link zum Neusetzen des Passworts erzeugen (24 h gültig)
 *   reset-mfa <email>              Zwei-Faktor-Anmeldung eines Kontos zurücksetzen
 */
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'gen-master-key':
      console.log(crypto.randomBytes(32).toString('base64'));
      return;
    case 'self-check': {
      await import('./app.js');
      await import('./ops/backup.js');
      const { healthStatus } = await import('./routes/health.js');
      const h = await healthStatus();
      for (const [k, v] of Object.entries(h.checks)) console.log(`${v.ok ? 'ok  ' : 'FEHL'} ${k}: ${v.detail}`);
      console.log(h.ok ? `ok ${config.version}` : 'Nicht bereit.');
      break;
    }
    case 'migrate': {
      const { migrate } = await import('./db/migrate.js');
      const applied = await migrate();
      console.log(applied.length ? `Angewendet: ${applied.join(', ')}` : 'Schema ist aktuell.');
      break;
    }
    case 'preflight': {
      const { updatePreflight } = await import('./ops/update.js');
      const r = await updatePreflight();
      if (args[0] === '--json') console.log(JSON.stringify(r));
      else {
        for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : c.blocking ? 'FEHL' : 'HINW'} ${c.label}: ${c.detail}`);
        console.log(r.ready ? `BEREIT für das Update (LifeLink ${r.version}, PostgreSQL ${r.postgres}).` : 'NICHT BEREIT.');
      }
      process.exitCode = r.ready ? 0 : 2;
      break;
    }
    case 'maintenance': {
      const on = args[0] === 'on';
      if (!['on', 'off'].includes(args[0] ?? '')) throw new Error('Aufruf: maintenance on|off [grund]');
      const { setMaintenance } = await import('./ops/update.js');
      const { audit, SYSTEM_ACTOR } = await import('./lib/audit.js');
      await setMaintenance(on, 'Kommandozeile', args.slice(1).join(' ') || 'Update wird vorbereitet', null);
      await audit({ ...SYSTEM_ACTOR, name: 'Kommandozeile' }, on ? 'system.maintenance_on' : 'system.maintenance_off', { type: 'system', label: 'Wartungsmodus' });
      console.log(on ? 'Wartungsmodus aktiv: keine neuen schreibenden Vorgänge, keine neuen Aufträge.' : 'Wartungsmodus beendet.');
      break;
    }
    case 'import-inventory':
    case 'import-commit':
    case 'import-verify': {
      if (!args[0]) throw new Error(`Aufruf: ${cmd} <importordner mit manifest.json>`);
      const imp = await import('./ops/import.js');
      const r = cmd === 'import-inventory' ? (await imp.inventory(args[0])).report : cmd === 'import-commit' ? await imp.commitImport(args[0]) : await imp.verifyImport(args[0]);
      console.log(JSON.stringify(r, null, 2));
      if ((r as any).problems?.length || (r as any).ok === false) process.exitCode = 2;
      break;
    }
    case 'backup-decrypt': {
      if (args.length !== 2) throw new Error('Aufruf: backup-decrypt <datei.llbk> <ziel.dump>');
      const { decryptBackup } = await import('./ops/backup.js');
      decryptBackup(args[0], args[1]);
      console.log(`Entschlüsselt nach ${args[1]}. Wiederherstellen mit: pg_restore --clean --if-exists --no-owner -d <DATABASE_URL> ${args[1]}`);
      return;
    }
    case 'password-link': {
      const { one, pool } = await import('./db/pool.js');
      const { randomToken, sha256Hex } = await import('./lib/crypto.js');
      const { audit, SYSTEM_ACTOR } = await import('./lib/audit.js');
      const user = await one<any>('SELECT id, email FROM users WHERE lower(email) = lower($1)', [args[0] ?? '']);
      if (!user) throw new Error('Konto nicht gefunden.');
      const token = randomToken(24);
      await pool.query(`INSERT INTO invitations (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '24 hours')`, [user.id, sha256Hex(token)]);
      await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
      await audit({ ...SYSTEM_ACTOR, name: 'Kommandozeile' }, 'user.password_reset_link', { type: 'user', id: user.id, label: user.email });
      console.log(`${config.publicUrl || 'https://<lifelink-adresse>'}/einladung/${token}`);
      break;
    }
    case 'reset-mfa': {
      const { one } = await import('./db/pool.js');
      const { audit, SYSTEM_ACTOR } = await import('./lib/audit.js');
      const user = await one<any>(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE lower(email) = lower($1) RETURNING id, email`, [args[0] ?? '']);
      if (!user) throw new Error('Konto nicht gefunden.');
      await audit({ ...SYSTEM_ACTOR, name: 'Kommandozeile' }, 'user.mfa_reset', { type: 'user', id: user.id, label: user.email });
      console.log(`Zwei-Faktor-Anmeldung für ${user.email} zurückgesetzt. Beim nächsten Login wird sie neu eingerichtet.`);
      break;
    }
    default:
      console.log('Befehle: gen-master-key | migrate | self-check | preflight [--json] | maintenance on|off [grund] | backup-decrypt <datei> <ziel> | password-link <email> | reset-mfa <email>');
      return;
  }
  const { pool } = await import('./db/pool.js');
  await pool.end();
}

main().catch((e) => {
  console.error(`Fehler: ${e.message}`);
  process.exit(1);
});
