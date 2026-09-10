import { start } from 'workflow/api';
import { processJob } from '../workflows/jobs';
import { database } from './db';

export async function dispatchJobs() {
 const db=database();
 const {rows}=await db.query("UPDATE outbox SET lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE job_id IN (SELECT o.job_id FROM outbox o JOIN jobs j ON j.id=o.job_id WHERE o.dispatched_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now()) AND o.next_attempt_at<=now() AND j.status='QUEUED' ORDER BY j.created_at LIMIT 8 FOR UPDATE OF o SKIP LOCKED) RETURNING job_id");
 for(const row of rows){
  try{
   const run=await start(processJob,[row.job_id]);
   await db.query('UPDATE jobs SET workflow_run_id=$2 WHERE id=$1',[row.job_id,run.runId]);
   await db.query('UPDATE outbox SET dispatched_at=now(),lease_until=NULL WHERE job_id=$1',[row.job_id]);
  }catch{
   await db.query("UPDATE outbox SET lease_until=NULL,next_attempt_at=now()+interval '1 minute' WHERE job_id=$1",[row.job_id]);
  }
 }
 await db.query("UPDATE jobs SET status='NEEDS_REVIEW',error_code='STALE_EXECUTION',updated_at=now() WHERE status='RUNNING' AND updated_at<now()-interval '15 minutes'");
 return {dispatched:rows.length};
}
