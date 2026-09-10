import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export async function provisionDatabase(db, password, migrations) {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(password)) throw new Error('INVALID_GENERATED_PASSWORD');
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='60s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('nota_app-schema-migrations'))");
    if ((await db.query("SELECT 1 FROM pg_roles WHERE rolname='nota_app_runtime'")).rows.length) throw new Error('RUNTIME_ROLE_ALREADY_EXISTS');
    // An existing schema must already be a complete migration-managed installation.
    if ((await db.query("SELECT 1 FROM pg_namespace WHERE nspname='nota_app'")).rows.length) {
      if (!(await db.query("SELECT to_regclass('nota_app.schema_migrations') IS NOT NULL AS known")).rows[0].known) throw new Error('UNRECOGNIZED_EXISTING_SCHEMA');
      const versions = (await db.query('SELECT version FROM nota_app.schema_migrations')).rows.map(row => row.version);
      if (!versions.length || versions.some(version => !migrations.some(m => m.name === version))) throw new Error('UNRECOGNIZED_EXISTING_SCHEMA');
    }
    await db.query('CREATE SCHEMA IF NOT EXISTS nota_app');
    await db.query('CREATE TABLE IF NOT EXISTS nota_app.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations) {
      if ((await db.query('SELECT 1 FROM nota_app.schema_migrations WHERE version=$1',[migration.name])).rows.length) continue;
      await db.query(migration.sql);
      await db.query('INSERT INTO nota_app.schema_migrations(version) VALUES($1)',[migration.name]);
    }
    await db.query(`CREATE ROLE nota_app_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${password}'`);
    await db.query('REVOKE ALL ON SCHEMA nota_app FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA nota_app TO nota_app_runtime');
    await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA nota_app TO nota_app_runtime');
    await db.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA nota_app TO nota_app_runtime');
    await db.query('REVOKE INSERT,UPDATE,DELETE ON nota_app.schema_migrations FROM nota_app_runtime');
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA nota_app GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO nota_app_runtime');
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA nota_app GRANT USAGE,SELECT ON SEQUENCES TO nota_app_runtime');
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    if (!(await db.query("SELECT has_database_privilege('nota_app_runtime',current_database(),'CONNECT') AS allowed")).rows[0].allowed) await db.query('GRANT CONNECT ON DATABASE "'+database.replaceAll('"','""')+'" TO nota_app_runtime');
    const publicAccess = await db.query(`SELECT 1 FROM pg_namespace n
      WHERE n.nspname NOT IN ('nota_app','information_schema') AND left(n.nspname,3)<>'pg_'
      AND has_schema_privilege('nota_app_runtime',n.oid,'CREATE')
      UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('nota_app','information_schema') AND left(n.nspname,3)<>'pg_'
      AND c.relkind IN ('r','p','v','m','f')
      AND has_schema_privilege('nota_app_runtime',n.oid,'USAGE')
      AND has_table_privilege('nota_app_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('nota_app','information_schema') AND left(n.nspname,3)<>'pg_'
      AND c.relkind='S' AND has_schema_privilege('nota_app_runtime',n.oid,'USAGE')
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('nota_app_runtime',c.oid,'USAGE,SELECT,UPDATE') ELSE false END
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('nota_app','information_schema') AND left(n.nspname,3)<>'pg_'
      AND p.prosecdef AND has_schema_privilege('nota_app_runtime',n.oid,'USAGE')
      AND has_function_privilege('nota_app_runtime',p.oid,'EXECUTE') LIMIT 1`);
    if (publicAccess.rows.length || (await db.query("SELECT has_database_privilege('nota_app_runtime',current_database(),'CREATE') AS allowed")).rows[0].allowed) throw new Error('PUBLIC_PRIVILEGES_PREVENT_ISOLATION');
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

async function main() {
  const envFile=path.resolve('.env.local');
  const original=await fs.readFile(envFile,'utf8');
  const env=parseEnv(original);
  if (!env.DATABASE_ADMIN_URL) throw new Error('ADMIN_CONNECTION_REQUIRED');
  if (env.DATABASE_URL?.trim()) throw new Error('RUNTIME_ALREADY_CONFIGURED');
  const password=randomBytes(36).toString('base64url');
  const runtime=new URL(env.DATABASE_ADMIN_URL);
  runtime.username='nota_app_runtime'; runtime.password=password;
  const setValue=(text,key,value)=>new RegExp('^'+key+'\\s*=.*$','m').test(text)?text.replace(new RegExp('^'+key+'\\s*=.*$','m'),key+'='+value):text+'\n'+key+'='+value+'\n';
  let updated=setValue(original,'DATABASE_URL',runtime.toString());
  if (!env.CRON_SECRET?.trim()) updated=setValue(updated,'CRON_SECRET',randomBytes(32).toString('base64url'));
  const db=new pg.Client({connectionString:env.DATABASE_ADMIN_URL,connectionTimeoutMillis:8000,ssl:env.DATABASE_SSL==='false'?false:{rejectUnauthorized:true}});
  try {
    await db.connect();
    const migrations=await Promise.all((await fs.readdir('migrations')).filter(f=>f.endsWith('.sql')).sort().map(async name=>({name,sql:await fs.readFile(path.join('migrations',name),'utf8')})));
    // Keep recovery credentials locally before committing any remote changes.
    await fs.mkdir('local-data',{recursive:true});
    const pending=path.resolve('local-data/provisioned.env');
    await fs.writeFile(pending,updated,{mode:0o600,flag:'wx'});
    await provisionDatabase(db,password,migrations);
    if (await fs.readFile(envFile,'utf8') !== original) throw new Error('ENV_CHANGED_USE_LOCAL_RECOVERY_FILE');
    await fs.rename(pending,envFile);
    const testDb=new pg.Client({connectionString:runtime.toString(),connectionTimeoutMillis:8000,ssl:env.DATABASE_SSL==='false'?false:{rejectUnauthorized:true}});
    try { await testDb.connect(); await testDb.query('SELECT count(*) FROM nota_app.profiles'); }
    finally { await testDb.end(); }
    console.log('Schema nota_app, user terbatas, dan DATABASE_URL siap. Koneksi runtime terverifikasi.');
  } finally { await db.end().catch(()=>{}); }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{
    const known=['ADMIN_CONNECTION_REQUIRED','RUNTIME_ALREADY_CONFIGURED','RUNTIME_ROLE_ALREADY_EXISTS','UNRECOGNIZED_EXISTING_SCHEMA','PUBLIC_PRIVILEGES_PREVENT_ISOLATION','ENV_CHANGED_USE_LOCAL_RECOVERY_FILE'];
    console.error('Setup belum selesai:',known.includes(error.message)?error.message:/does not support SSL/i.test(error.message)?'ENDPOINT_NO_TLS':error.code||'CONNECTION_OR_SETUP_FAILED');
    process.exitCode=1;
  });
}
