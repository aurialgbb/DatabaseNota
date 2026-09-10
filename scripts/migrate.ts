import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
// Admin credentials are only used by this local migration command, never by the app.
const envFile = path.join(process.cwd(), '.env.local');
try { process.loadEnvFile(envFile); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Isi DATABASE_ADMIN_URL atau DATABASE_URL sebelum menjalankan migrasi.');
const db = new Pool({connectionString, max:1, connectionTimeoutMillis:5000,
  ssl:process.env.DATABASE_SSL === 'false' ? false : {rejectUnauthorized:true}});
const files = (await fs.readdir(path.join(process.cwd(), 'migrations'))).filter(f => f.endsWith('.sql')).sort();
const client = await db.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('nota_app-schema-migrations'))");
  await client.query('CREATE SCHEMA IF NOT EXISTS nota_app');
  await client.query('CREATE TABLE IF NOT EXISTS nota_app.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied: string[] = [];
  for (const file of files) {
    if ((await client.query('SELECT 1 FROM nota_app.schema_migrations WHERE version=$1', [file])).rows.length) continue;
      await client.query(await fs.readFile(path.join(process.cwd(), 'migrations', file), 'utf8'));
      await client.query('INSERT INTO nota_app.schema_migrations(version) VALUES($1)', [file]);
      applied.push(file);
  }
  await client.query('COMMIT');
  console.log('Schema nota_app siap. Migrasi diterapkan:', applied.length ? applied.join(', ') : 'sudah terbaru');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await db.end(); }
