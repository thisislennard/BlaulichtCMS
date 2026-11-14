import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { masterKey } from './lib/crypto.js';
import { log } from './lib/log.js';
import { buildApp } from './app.js';
import { ensureSetupToken } from './routes/auth.js';
import { ensureMediaDirs } from './media/storage.js';

process.env.LIFELINK_ROLE ??= 'api';

// Sicherheitsnetz: unbehandelte Ablehnungen protokollieren statt den Prozess zu beenden
process.on('unhandledRejection', (e) => log('error', 'api', `Unbehandelter Fehler: ${(e as Error)?.message ?? String(e)}`, { stack: String((e as Error)?.stack ?? '').slice(0, 2000) }));

async function main() {
  masterKey(); // bricht ohne gültigen Schlüssel sofort ab
  await migrate((m) => log('info', 'migrate', m));
  await ensureSetupToken();
  ensureMediaDirs();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  log('info', 'api', `LifeLink ${config.version} hört auf ${config.host}:${config.port}`);
  process.send?.({ type: 'ready', role: 'api', version: config.version });

  const stop = async () => {
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('[api] Start fehlgeschlagen:', err?.message ?? err);
  process.exit(1);
});
