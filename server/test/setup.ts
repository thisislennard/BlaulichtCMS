import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/* Tests laufen gegen eine eigene PostgreSQL-Datenbank (TEST_DATABASE_URL), nie gegen die Dev-DB. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5442/blaulichtcms_test';
process.env.BLAULICHTCMS_MASTER_KEY ??= crypto.randomBytes(32).toString('base64');
process.env.BLAULICHTCMS_DATA_DIR = path.join(os.tmpdir(), `blaulichtcms-test-${process.pid}`);
process.env.COOKIE_SECURE = 'false';
// Getrennte Datenbankrollen wie im Container (#102): Migrationen als blaulichtcms_owner, Rechte für blaulichtcms_app
process.env.BLAULICHTCMS_DB_ROLES ??= 'true';
process.env.BLAULICHTCMS_NO_DB_LOG = '1';
process.env.LOG_QUIET = '1';
