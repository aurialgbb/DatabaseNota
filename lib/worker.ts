import {database} from './db';
import {runOcr,runText} from './ocr';
import {publicError} from './errors';
export async function workOne(){
 const db=database();
 const job=(await db.query("UPDATE nota_app.jobs SET status='RUNNING',updated_at=now() WHERE id=(SELECT id FROM nota_app.jobs WHERE status='QUEUED' AND kind IN ('STORE_OCR','LEGACY_OCR','LEGACY_TEXT') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0];
 if(!job)return false;
 const heartbeat=setInterval(()=>{db.query("UPDATE nota_app.jobs SET updated_at=now() WHERE id=$1 AND status='RUNNING'",[job.id]).catch(()=>{});},30000);
 try{
  const result=job.kind==='LEGACY_TEXT'?await runText(job):await runOcr(job);
  await db.query("UPDATE nota_app.jobs SET status='SUCCEEDED',result=$2,progress=100,updated_at=now() WHERE id=$1",[job.id,JSON.stringify(result)]);
  if(job.kind==='STORE_OCR')await db.query('UPDATE nota_app.ocr_photos SET result=$2 WHERE job_id=$1',[job.id,JSON.stringify(result)]);
 }catch(error){
  const safe=publicError(error);await db.query("UPDATE nota_app.jobs SET status=$2,error_code=$3,result=$4,updated_at=now() WHERE id=$1",[job.id,safe.code==='OCR_OUTCOME_UNKNOWN'?'NEEDS_REVIEW':'FAILED',safe.code,JSON.stringify({message:safe.message})]);
 }finally{clearInterval(heartbeat);await db.query('UPDATE nota_app.outbox SET dispatched_at=now(),lease_until=NULL WHERE job_id=$1',[job.id]);}
 return true;
}
