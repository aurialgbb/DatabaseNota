import fs from 'node:fs/promises';
import path from 'node:path';
import { database } from '../lib/db';
const db = database();
await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const files = (await fs.readdir(path.join(process.cwd(), 'migrations'))).filter(f => f.endsWith('.sql')).sort();
const client = await db.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('nota-schema-migrations'))");
  for (const file of files) {
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file])).rows.length) continue;
    await client.query('BEGIN');
    try {
      await client.query(await fs.readFile(path.join(process.cwd(), 'migrations', file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT'); console.log('Applied', file);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  }
} finally { await client.query("SELECT pg_advisory_unlock(hashtext('nota-schema-migrations'))"); client.release(); await db.end(); }
