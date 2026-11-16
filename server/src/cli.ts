import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { APP_ROOT, config } from './config.js';
import { resolveActiveRoot } from './updates/releases.js';

/**
 * Wartungsbefehle (im Container: `docker compose exec blaulichtcms node server/dist/cli.js <befehl>`):
 *   gen-master-key                 neuen BLAULICHTCMS_MASTER_KEY ausgeben
 *   migrate                        Datenbankschema aktualisieren (mit Startprüfung; als Superuser bzw.
 *                                  DATABASE_ADMIN_URL, richtet die Datenbankrollen ein)
 *   preflight [--json]             Update-Vorabprüfung (Exit 0 = bereit)
 *   import-inventory <ordner>      Probelauf eines Medienimports (schreibt nichts)
 *   import-commit <ordner>         Import übernehmen (nur nach fehlerfreiem Probelauf)
 *   import-verify <ordner>         Mengen- und Prüfsummenabgleich nach der Übernahme
 *   maintenance on|off [grund]     Wartungsmodus vor/nach einem Update
 *   self-check [--release]         Programmdateien laden und Datenbankverbindung prüfen (--release: nur
 *                                  Programmdateien, ohne Datenbank – Rauchtest eines In-App-Updates)
 *   update-restore <datei>         Datenbanksicherung zurückspielen (nur für den Supervisor beim Rückweg eines
 *                                  In-App-Updates; als Superuser bzw. DATABASE_ADMIN_URL)
 *   restore-db <datei> --ja        Datenbanksicherung aus /data/backups zurückspielen (Notfall, #212; ersetzt den
 *                                  ganzen Datenbestand, danach Container neu starten – docs/betrieb.md)
 *   backup-decrypt <datei> <ziel>  verschlüsselte Sicherung in eine pg_restore-Datei umwandeln
 *   offsite-volume <name> <größe> <sha256>  Volume-Sicherung (Standardeingabe) zum Ziel außer Haus übertragen (#212,
 *                                  ruft scripts/backup-cron.sh auf; Exit 3 = kein Ziel eingeschaltet)
 *   backup-report ok|fehler <text> Ergebnis der Volume-Sicherung am Host melden (Systemprotokoll, bei Fehler
 *                                  Benachrichtigung an „System verwalten“) – ruft scripts/backup-cron.sh auf
 *   password-link <email>          Link zum Neusetzen des Passworts erzeugen (24 h gültig)
 *   reset-mfa <email>              Zwei-Faktor-Anmeldung eines Kontos zurücksetzen
 *   audit-verify                   Hash-Kette des Audit-Protokolls prüfen (Exit 1 bei Auffälligkeiten)
 *   rotate-master-key --ja         Master-Schlüssel wechseln und alles neu verschlüsseln (nur im Wartungsmodus,
 *                                  docs/betrieb.md „Master-Schlüssel wechseln“)
 */
/**
 * Läuft ein In-App-Update (Release unter /data/releases), gehört jeder Wartungsbefehl zu dessen Code – sonst
 * kennte die Kommandozeile des Images z. B. die neuen Migrationen nicht. Von Hand aufgerufen (`docker compose exec`,
 * ohne BLAULICHTCMS_ROLE) wird deshalb an die Kommandozeile des aktiven Releases weitergereicht.
 */
function delegateToActiveRelease() {
  if (process.env.BLAULICHTCMS_ROLE || process.env.BLAULICHTCMS_CLI_DELEGATED) return;
  let active;
  try {
    active = resolveActiveRoot(APP_ROOT, config.dataDir);
  } catch {
    return;
  }
  if (active.source !== 'update' || path.resolve(active.root) === path.resolve(APP_ROOT)) return;
  const r = spawnSync(process.execPath, [path.join(active.root, 'server', 'dist', 'cli.js'), ...process.argv.slice(2)], {
    cwd: active.root,
    stdio: 'inherit',
    env: { ...process.env, BLAULICHTCMS_CLI_DELEGATED: '1' },
  });
  process.exit(r.status ?? 1);
}
delegateToActiveRelease();

// Eigener Verbindungsname: zählt nicht als laufende API, wenn rotate-master-key auf das Ende von API/Worker wartet
process.env.BLAULICHTCMS_ROLE ??= 'cli';
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'gen-master-key':
      console.log(crypto.randomBytes(32).toString('base64'));
      return;
    case 'self-check': {
      if (args[0] === '--release') {
        // Rauchtest eines entpackten Releases: lädt alle Module (auch native wie sharp und argon2), ohne Datenbank
        const fs = await import('node:fs');
        await import('./app.js');
        await Promise.all([import('./warnings/mail.js'), import('./connections/social.js'), import('./media/exports.js'), import('./lib/retention.js'), import('./ops/backup.js'), import('./ops/restore.js')]);
        const sharp = (await import('sharp')).default;
        await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
        const { hash } = await import('@node-rs/argon2');
        await hash('rauchtest');
        for (const f of [config.webDist + '/index.html', config.migrationsDir, config.pluginDir + '/blaulichtcms-bridge.php']) {
          if (!fs.existsSync(f)) throw new Error(`Datei fehlt: ${f}`);
        }
        const { publicKeyStatus } = await import('./updates/signing.js');
        if (publicKeyStatus() !== 'ok') throw new Error('Öffentlicher Update-Schlüssel fehlt oder ist ungültig.');
        // Sofort beenden: geladene Module können Zeitgeber halten
        process.stdout.write(`ok ${config.version}
`, () => process.exit(0));
        return;
      }
      await import('./app.js');
      await import('./ops/backup.js');
      const { healthStatus } = await import('./routes/health.js');
      const h = await healthStatus();
      for (const [k, v] of Object.entries(h.checks)) console.log(`${v.ok ? 'ok  ' : 'FEHL'} ${k}: ${v.detail}`);
      console.log(h.ok ? `ok ${config.version}` : 'Nicht bereit.');
      break;
    }
    case 'audit-verify': {
      // Hash-Kette des Audits prüfen (#112); Exit-Code 1 bei Auffälligkeiten
      const { sealAudit, verifyAudit } = await import('./lib/audit-chain.js');
      const { getSettings } = await import('./lib/settings.js');
      await sealAudit();
      const v = await verifyAudit((await getSettings())['retention.audit_days']);
      console.log(`${v.checked} Einträge geprüft (Kette ${v.first?.seq ?? '-'}–${v.last?.seq ?? '-'}), ${v.unsealed} noch nicht versiegelt.`);
      if (v.last) console.log(`Letztes Siegel: #${v.last.seq} ${v.last.at} ${v.last.hash}`);
      for (const p of v.problems) console.log(`FEHL Eintrag ${p.id} (Kette ${p.seq}): ${p.text}`);
      console.log(v.ok ? 'ok' : 'Audit-Kette beschädigt.');
      if (!v.ok) process.exitCode = 1;
      break;
    }
    case 'migrate': {
      const { migrate } = await import('./db/migrate.js');
      // Verbindung als Superuser bzw. DATABASE_ADMIN_URL: Rollen einrichten, Migrationen als Eigentümerrolle (#102)
      const applied = await migrate(console.log, undefined, { admin: true });
      console.log(applied.length ? `Angewendet: ${applied.join(', ')}` : 'Schema ist aktuell.');
      break;
    }
    case 'preflight': {
      const { updatePreflight } = await import('./ops/update.js');
      const r = await updatePreflight();
      if (args[0] === '--json') console.log(JSON.stringify(r));
      else {
        for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : c.blocking ? 'FEHL' : 'HINW'} ${c.label}: ${c.detail}`);
        console.log(r.ready ? `BEREIT für das Update (BlaulichtCMS ${r.version}, PostgreSQL ${r.postgres}).` : 'NICHT BEREIT.');
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
    case 'restore-db': {
      // Notfall-Wiederherstellung (#212): wie der Rückweg eines Updates, aber bewusst von Hand ausgelöst
      if (args.length !== 2 || args[1] !== '--ja') throw new Error('Aufruf: restore-db <datei.bcbk> --ja   (ersetzt den gesamten Datenbestand durch den Stand der Sicherung)');
      const pathMod = await import('node:path');
      const { backupDir } = await import('./ops/backup.js');
      const file = pathMod.isAbsolute(args[0]) ? args[0] : pathMod.join(backupDir(), args[0]);
      const { restoreBackupForRollback } = await import('./ops/restore.js');
      await restoreBackupForRollback(file, console.log);
      console.log('Sicherung zurückgespielt. Jetzt den Container neu starten (docker compose restart blaulichtcms) – dabei werden Eigentum und Rechte der Datenbankrollen neu gesetzt.');
      return;
    }
    case 'update-restore': {
      if (args.length !== 1) throw new Error('Aufruf: update-restore <datei.bcbk>');
      const { restoreBackupForRollback } = await import('./ops/restore.js');
      await restoreBackupForRollback(args[0], console.log);
      console.log('Sicherung zurückgespielt.');
      return;
    }
    case 'backup-decrypt': {
      if (args.length !== 2) throw new Error('Aufruf: backup-decrypt <datei.bcbk> <ziel.dump>');
      const { decryptBackup } = await import('./ops/backup.js');
      await decryptBackup(args[0], args[1]);
      console.log(`Entschlüsselt nach ${args[1]}. Wiederherstellen (als Superuser, im Container: -h /tmp/blaulichtcms-pg -U blaulichtcms -d blaulichtcms) mit: pg_restore --clean --if-exists --no-owner --no-privileges -d <verbindung> ${args[1]} – danach den Container neu starten (Eigentum und Rechte der Datenbankrollen werden dabei neu gesetzt).`);
      return;
    }
    case 'offsite-volume': {
      const [name, size, sha] = args;
      if (!name || !size || !sha) throw new Error('Aufruf: offsite-volume <name> <größe> <sha256> < datei');
      const { uploadVolumeStream } = await import('./ops/offsite.js');
      const r = await uploadVolumeStream(name, Number(size), sha, process.stdin);
      if (!r) {
        console.log('Keine Sicherung außer Haus eingeschaltet (Einstellungen → Sicherung außer Haus).');
        process.exitCode = 3;
        break;
      }
      console.log(`Außer Haus übertragen und geprüft${r.removed ? ` (${r.removed} ältere Volume-Sicherungen auf dem Ziel entfernt)` : ''}.`);
      break;
    }
    case 'backup-report': {
      const status = args[0];
      if (status !== 'ok' && status !== 'fehler') throw new Error('Aufruf: backup-report ok|fehler <text>');
      const text = args.slice(1).join(' ').trim().slice(0, 900) || (status === 'ok' ? 'Volume-Sicherung erstellt und geprüft.' : 'Volume-Sicherung fehlgeschlagen.');
      const { pool } = await import('./db/pool.js');
      await pool.query('INSERT INTO app_logs (level, source, message, details, correlation_id) VALUES ($1,$2,$3,$4,$5)', [
        status === 'ok' ? 'info' : 'error',
        'backup',
        `Volume-Sicherung (Host): ${text}`,
        '{}',
        null,
      ]);
      if (status === 'fehler') {
        const { notify } = await import('./lib/notify.js');
        await notify({ kind: 'error', title: 'Volume-Sicherung fehlgeschlagen', body: text, link: '/einstellungen#sicherung', permission: 'backup.manage' });
      }
      console.log('Gemeldet.');
      break;
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
      console.log(`${config.publicUrl || 'https://<blaulichtcms-adresse>'}/einladung/${token}`);
      break;
    }
    case 'reset-mfa': {
      const { one } = await import('./db/pool.js');
      const { audit, SYSTEM_ACTOR } = await import('./lib/audit.js');
      const user = await one<any>(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE lower(email) = lower($1) RETURNING id, email`, [args[0] ?? '']);
      if (!user) throw new Error('Konto nicht gefunden.');
      await audit({ ...SYSTEM_ACTOR, name: 'Kommandozeile' }, 'user.mfa_reset', { type: 'user', id: user.id, label: user.email });
      const { notifyAffectedUser, securityAlert } = await import('./lib/security-alerts.js');
      await securityAlert('mfa_reset', { title: `Zwei-Faktor zurückgesetzt: ${user.email}`, body: 'Über die Kommandozeile im Container.', link: '/benutzer', permission: 'user.lock', kind: 'info' });
      await notifyAffectedUser(user.id, 'Deine Zwei-Faktor-Anmeldung wurde zurückgesetzt', 'Über die Kommandozeile des Servers. Warst du das nicht, bitte sofort die Administration informieren.');
      console.log(`Zwei-Faktor-Anmeldung für ${user.email} zurückgesetzt. Beim nächsten Login wird sie neu eingerichtet.`);
      break;
    }
    case 'rotate-master-key': {
      if (args[0] !== '--ja') {
        console.log(
          [
            'Wechselt den Master-Schlüssel: alle Zugangsdaten, Zwei-Faktor-Geheimnisse, Upload-Link-Token und die',
            'Datenbanksicherungen im Volume werden mit einem neuen Schlüssel neu verschlüsselt (eine Transaktion).',
            'Voraussetzung: Wartungsmodus aktiv. API und Worker werden dafür kurz angehalten.',
            'Achtung: Wiederherstellungscodes, die seit der Umstellung auf HMAC erzeugt wurden, werden ungültig –',
            'die betroffenen Personen werden benachrichtigt und müssen im Profil neue Codes erzeugen.',
            'Ausführen mit: node server/dist/cli.js rotate-master-key --ja',
          ].join('\n'),
        );
        process.exitCode = 2;
        break;
      }
      const { rotateMasterKey } = await import('./ops/rotate-key.js');
      const { audit, SYSTEM_ACTOR } = await import('./lib/audit.js');
      const { notifyAffectedUser, securityAlert } = await import('./lib/security-alerts.js');
      const r = await rotateMasterKey((m) => console.log(m));
      const failed = r.backups.filter((b) => !b.ok);
      await audit({ ...SYSTEM_ACTOR, name: 'Kommandozeile' }, 'system.master_key_rotated', { type: 'system', label: 'Master-Schlüssel' }, {
        geheimnisse: r.secrets, zweiFaktor: r.totp, uploadLinks: r.links, wiederherstellungscodesEntfernt: r.recoveryUsers.length, sicherungen: r.backups.length - failed.length, sicherungenFehler: failed.length, quelle: r.keySource,
      });
      for (const u of r.recoveryUsers) {
        await notifyAffectedUser(u.id, 'Bitte neue Wiederherstellungscodes erzeugen', 'Der Master-Schlüssel des Servers wurde gewechselt. Deine bisherigen Wiederherstellungscodes gelten dadurch nicht mehr. Bitte im Profil unter „Zwei-Faktor-Anmeldung“ neue Codes erzeugen und sicher aufbewahren.');
      }
      await securityAlert('master_key_rotated', {
        title: 'Master-Schlüssel gewechselt',
        body: `Über die Kommandozeile. ${r.secrets} Geheimnisse, ${r.totp} Zwei-Faktor-Geheimnisse und ${r.links} Upload-Links neu verschlüsselt. ${r.recoveryUsers.length} Konten müssen neue Wiederherstellungscodes erzeugen.`,
        kind: 'info',
        link: '/protokolle',
      });
      console.log(`Neu verschlüsselt: ${r.secrets} Geheimnisse, ${r.totp} Zwei-Faktor-Geheimnisse, ${r.links} Upload-Links, ${r.backups.length - failed.length} Datenbanksicherungen.`);
      for (const b of failed) console.log(`HINW Sicherung ${b.file} nicht neu verschlüsselt (${b.error}) – sie braucht weiterhin den alten Schlüssel.`);
      if (r.recoveryUsers.length) {
        console.log(`WARNUNG: Wiederherstellungscodes von ${r.recoveryUsers.length} Konten sind ungültig und wurden entfernt (benachrichtigt): ${r.recoveryUsers.map((u) => u.email).join(', ')}`);
      }
      if (r.oldKeyBackup) console.log(`Alter Schlüssel gesichert: ${r.oldKeyBackup} (0600). Nach erfolgreicher Prüfung in den Tresor übernehmen und aus dem Volume löschen.`);
      if (r.keySource === 'env') {
        console.log(`Der Schlüssel kommt aus BLAULICHTCMS_MASTER_KEY. API und Worker bleiben angehalten, bis der neue Wert eingetragen ist:\n  BLAULICHTCMS_MASTER_KEY=${r.newKeyBase64}\nIn .env eintragen, dann: docker compose up -d (Container neu erstellen). Den alten Wert bis zur Prüfung aufbewahren.`);
      } else {
        console.log(r.resumed ? 'API und Worker starten mit dem neuen Schlüssel.' : 'Jetzt API und Worker (bzw. den Container) neu starten.');
        console.log('Danach prüfen (Anmeldung mit Zwei-Faktor, Verbindungen testen) und den Wartungsmodus beenden: node server/dist/cli.js maintenance off');
      }
      break;
    }
    default:
      console.log('Befehle: gen-master-key | migrate | self-check [--release] | update-restore <datei> | preflight [--json] | maintenance on|off [grund] | restore-db <datei> --ja | backup-decrypt <datei> <ziel> | offsite-volume <name> <größe> <sha256> | backup-report ok|fehler <text> | password-link <email> | reset-mfa <email> | audit-verify | rotate-master-key --ja');
      return;
  }
  const { pool } = await import('./db/pool.js');
  await pool.end();
}

main().catch((e) => {
  console.error(`Fehler: ${e.message}`);
  process.exit(1);
});
