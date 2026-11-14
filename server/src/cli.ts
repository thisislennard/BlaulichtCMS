import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Wartungsbefehle (im Container: `docker compose exec lifelink node server/dist/cli.js <befehl>`):
 *   gen-master-key                 neuen LIFELINK_MASTER_KEY ausgeben
 *   migrate                        Datenbankschema aktualisieren
 *   self-check                     Programmdateien und Signaturschlüssel prüfen (wird vom Update-Installer genutzt)
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
      await import('./engine/executor.js');
      await import('./engine/triggers.js');
      await import('./ops/backup.js');
      const { publicKeyStatus } = await import('./updates/signing.js');
      if (publicKeyStatus() !== 'ok') throw new Error('Öffentlicher Update-Signaturschlüssel fehlt oder ist ungültig.');
      console.log(`ok ${config.version}`);
      return;
    }
    case 'migrate': {
      const { migrate } = await import('./db/migrate.js');
      const applied = await migrate();
      console.log(applied.length ? `Angewendet: ${applied.join(', ')}` : 'Schema ist aktuell.');
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
      console.log('Befehle: gen-master-key | migrate | self-check | backup-decrypt <datei> <ziel> | password-link <email> | reset-mfa <email>');
      return;
  }
  const { pool } = await import('./db/pool.js');
  await pool.end();
}

main().catch((e) => {
  console.error(`Fehler: ${e.message}`);
  process.exit(1);
});
