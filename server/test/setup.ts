import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/* Tests laufen gegen eine eigene PostgreSQL-Datenbank (TEST_DATABASE_URL), nie gegen die Dev-DB. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://lifelink:lifelink@127.0.0.1:5442/lifelink_test';
process.env.LIFELINK_MASTER_KEY ??= crypto.randomBytes(32).toString('base64');
process.env.LIFELINK_DATA_DIR = path.join(os.tmpdir(), `lifelink-test-${process.pid}`);
process.env.COOKIE_SECURE = 'false';
process.env.LIFELINK_NO_DB_LOG = '1';
process.env.LOG_QUIET = '1';
