import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { AppError } from './errors';

let pool: Pool | undefined;
export interface Database {
  query<T extends QueryResultRow = any>(sql: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new AppError('DATABASE_NOT_CONFIGURED', 'Database aplikasi baru belum dikonfigurasi.', 503);
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Math.min(10, Number(process.env.DATABASE_POOL_MAX || 2))),
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000,
      statement_timeout: 15000,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true }
    });
    attachDatabasePool(pool);
  }
  return pool;
}
export async function transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const client: PoolClient = await database().connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
