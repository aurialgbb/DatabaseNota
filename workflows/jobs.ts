import { database } from '../lib/db';
import { runOcr } from '../lib/ocr';
import { AppError,publicError } from '../lib/errors';

export async function processJob(id:string) {
 'use workflow';
 await executeJob(id);
}
async function executeJob(id:string) {
 'use step';
 const db=database();
 const claim=await db.query("UPDATE nota_app.jobs SET status='RUNNING',updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING *",[id]);
 const job=claim.rows[0];
 if(!job)return;
 try{
  let result:any;
  if(['STORE_OCR','LEGACY_OCR'].includes(job.kind))result=await runOcr(job);
  else throw new AppError('FEATURE_PENDING','Jenis pekerjaan ini belum tersedia pada build pengembangan.',501);
  await db.query("UPDATE nota_app.jobs SET status='SUCCEEDED',result=$2,progress=100,updated_at=now() WHERE id=$1",[id,JSON.stringify(result)]);
  if(job.kind==='STORE_OCR')await db.query('UPDATE nota_app.ocr_photos SET result=$2 WHERE job_id=$1',[id,JSON.stringify(result)]);
 }catch(error){
  const safe=publicError(error);
  await db.query("UPDATE nota_app.jobs SET status=$2,error_code=$3,result=$4,updated_at=now() WHERE id=$1",[id,safe.code==='OCR_OUTCOME_UNKNOWN'?'NEEDS_REVIEW':'FAILED',safe.code,JSON.stringify({message:safe.message})]);
 }
}
