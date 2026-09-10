import { randomUUID } from 'node:crypto';
import { database, transaction, type Database } from './db';
import { invariant } from './errors';
import { payloadHash, requireBranch, type User } from './identity';

export async function createJob(db: Database, user: User, kind: string, payload: any, key: string, branchId = user.branchId) {
  invariant(key && key.length <= 200, 'REQUEST_KEY_REQUIRED', 'Identitas permintaan wajib tersedia.');
  requireBranch(user, branchId);
  const hash = payloadHash(payload), id = randomUUID();
  const inserted = await db.query("INSERT INTO nota_app.jobs(id,uid,kind,branch_id,request_key,payload_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(uid,kind,request_key) DO NOTHING RETURNING *", [id,user.uid,kind,branchId || null,key,hash,JSON.stringify(payload)]);
  const job = inserted.rows[0] || (await db.query('SELECT * FROM nota_app.jobs WHERE uid=$1 AND kind=$2 AND request_key=$3', [user.uid,kind,key])).rows[0];
  invariant(job.payload_hash === hash, 'IDEMPOTENCY_CONFLICT', 'Permintaan yang sama memiliki isi berbeda.', 409);
  if (inserted.rows.length) await db.query('INSERT INTO nota_app.outbox(job_id) VALUES($1)', [id]);
  return job;
}
export async function authorizedJob(db: Database, user: User, id: string) {
  invariant(/^[0-9a-f-]{36}$/i.test(id), 'INVALID_JOB', 'Nomor pekerjaan tidak valid.');
  const job = (await db.query('SELECT * FROM nota_app.jobs WHERE id=$1', [id])).rows[0];
  invariant(job, 'NOT_FOUND', 'Pekerjaan tidak ditemukan.', 404);
  requireBranch(user, job.branch_id || '');
  invariant(user.role !== 'TOKO' || job.uid === user.uid, 'FORBIDDEN', 'Pekerjaan tidak dapat diakses.', 403);
  return job;
}
export async function mutateOnce<T>(db: Database, user: User, action: string, key: string, payload: any, fn: () => Promise<T>): Promise<T> {
  invariant(key && key.length <= 200, 'REQUEST_KEY_REQUIRED', 'Identitas permintaan wajib tersedia.');
  const hash = payloadHash(payload);
  await db.query('INSERT INTO nota_app.mutations(uid,action,request_key,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [user.uid,action,key,hash]);
  const row = (await db.query('SELECT * FROM nota_app.mutations WHERE uid=$1 AND action=$2 AND request_key=$3 FOR UPDATE', [user.uid,action,key])).rows[0];
  invariant(row.payload_hash === hash, 'IDEMPOTENCY_CONFLICT', 'Identitas permintaan telah digunakan untuk data lain.', 409);
  if (row.result !== null) return row.result;
  const result = await fn();
  await db.query('UPDATE nota_app.mutations SET result=$4 WHERE uid=$1 AND action=$2 AND request_key=$3', [user.uid,action,key,JSON.stringify(result)]);
  return result;
}
export async function retryJob(user: User, id: string) {
  return transaction(async db => {
    const job = await authorizedJob(db,user,id);
    invariant(job.status === 'FAILED', 'JOB_NOT_RETRYABLE', 'Pekerjaan ini tidak dapat diulang otomatis.', 409);
    await db.query("UPDATE nota_app.jobs SET status='QUEUED',error_code=NULL,updated_at=now() WHERE id=$1", [id]);
    await db.query('UPDATE nota_app.outbox SET dispatched_at=NULL,lease_until=NULL,next_attempt_at=now() WHERE job_id=$1',[id]);
    return { operationId:id, status:'QUEUED' };
  });
}
export async function cancelJob(user: User, id: string) {
  return transaction(async db => {
    await authorizedJob(db,user,id);
    const result = await db.query("UPDATE nota_app.jobs SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING id", [id]);
    invariant(result.rows.length, 'JOB_ALREADY_RUNNING', 'Pekerjaan sudah berjalan; periksa hasil sebelum membatalkan.', 409);
    return { success:true };
  });
}
