import {database,transaction} from './db';
import {createJob,authorizedJob} from './jobs';
import {requireRole,type User} from './identity';
import {invariant,publicError} from './errors';
import {approvalPlan} from './sync-plans';
import {executePlan} from './sync-engine';

export const approvalActions=['CREATE_APPROVAL_JOB','GET_APPROVAL_JOB','LIST_ACTIVE_APPROVAL_JOBS','RUN_APPROVAL_JOB','RETRY_APPROVAL_JOB_ITEMS','CANCEL_APPROVAL_JOB'];
export function publicApproval(job:any){
 const items=job.payload.decisions.map((d:any,i:number)=>({id:String(i),...d,status:'QUEUED',...(job.result?.items?.[i]||{})}));
 for(const item of items)if(job.status==='NEEDS_REVIEW'&&item.status==='PROCESSING')item.status='RECOVERY_REQUIRED';
 const counts={total:items.length,queued:0,processing:0,succeeded:0,failed:0,cancelled:0,recoveryRequired:0};
 for(const item of items){const key=({QUEUED:'queued',PROCESSING:'processing',SUCCEEDED:'succeeded',FAILED:'failed',CANCELLED:'cancelled',RECOVERY_REQUIRED:'recoveryRequired'} as Record<string,string>)[item.status];if(key)(counts as any)[key]++;}
 return {id:job.id,status:job.status==='NEEDS_REVIEW'?'RECOVERY_REQUIRED':job.status,items,counts,createdAt:new Date(job.created_at).getTime(),updatedAt:new Date(job.updated_at).getTime()};
}
export async function approvalAction(user:User,action:string,p:any,key:string){
 requireRole(user,['ADMIN','TAX']);
 if(action==='CREATE_APPROVAL_JOB'){
  invariant(Array.isArray(p.decisions)&&p.decisions.length>0&&p.decisions.length<=100,'INVALID_DECISIONS','Pilih 1–100 nota.');
  const decisions=p.decisions.map((d:any)=>{invariant(d&&typeof d.receiptId==='string'&&d.receiptId.length<=200&&['APPROVE','DISCARD','REQUEST_CORRECTION'].includes(d.decision)&&Number.isInteger(d.expectedVersion)&&d.expectedVersion>0,'INVALID_DECISION','Keputusan atau versi nota tidak valid.');const reason=String(d.reason||'').trim();invariant(reason.length<=2000&&(d.decision!=='REQUEST_CORRECTION'||reason.length>0),'REASON_REQUIRED','Isi alasan perbaikan, maksimal 2.000 karakter.');return {receiptId:d.receiptId,decision:d.decision,reason,expectedVersion:d.expectedVersion,displayNumber:String(d.displayNumber||'').slice(0,100)};});
  invariant(new Set(decisions.map((d:any)=>d.receiptId)).size===decisions.length,'DUPLICATE_RECEIPT','Satu nota hanya boleh memiliki satu keputusan.');
  return publicApproval(await transaction(tx=>createJob(tx,user,'APPROVAL',{decisions},key)));
 }
 if(action==='LIST_ACTIVE_APPROVAL_JOBS')return (await database().query("SELECT * FROM nota_app.jobs WHERE kind='APPROVAL' AND (uid=$1 OR $2='ADMIN') AND (status IN ('QUEUED','RUNNING','NEEDS_REVIEW') OR updated_at>now()-interval '24 hours') ORDER BY created_at DESC LIMIT 50",[user.uid,user.role])).rows.map(publicApproval);
 return transaction(async tx=>{
  const job=await authorizedJob(tx,user,String(p.jobId||''));invariant(job.kind==='APPROVAL'&&(job.uid===user.uid||user.role==='ADMIN'),'FORBIDDEN','Pekerjaan ini tidak dapat diakses.',403);
  await tx.query('SELECT id FROM nota_app.jobs WHERE id=$1 FOR UPDATE',[job.id]);
  const current=(await tx.query('SELECT * FROM nota_app.jobs WHERE id=$1',[job.id])).rows[0];
  if(action==='GET_APPROVAL_JOB')return publicApproval(current);
  if(action==='RUN_APPROVAL_JOB')return {job:publicApproval(current)};
  invariant(!['RUNNING','QUEUED'].includes(current.status)||action==='CANCEL_APPROVAL_JOB'&&current.status==='QUEUED','JOB_RUNNING','Tunggu pekerjaan selesai sebelum mengubah antrean.',409);
  const items=publicApproval(current).items;
  if(action==='RETRY_APPROVAL_JOB_ITEMS'){
   invariant(Array.isArray(p.itemIds)&&p.itemIds.length>0,'ITEMS_REQUIRED','Pilih nota yang akan dilanjutkan.');
   for(const id of p.itemIds){const item=items.find((i:any)=>i.id===String(id));invariant(item&&['FAILED','RECOVERY_REQUIRED'].includes(item.status),'INVALID_RETRY','Hanya nota gagal yang dapat dilanjutkan.');item.status='QUEUED';delete item.error;delete item.message;}
   current.status='QUEUED';
  }else{
   invariant(action==='CANCEL_APPROVAL_JOB','INVALID_ACTION','Tindakan tidak dikenal.');
   const started=await tx.query("SELECT step_key FROM nota_app.job_steps WHERE job_id=$1 AND status<>'COMMITTED'",[job.id]);invariant(!started.rows.length,'RECOVERY_REQUIRED','Ada penulisan belum selesai. Lanjutkan pemulihan terlebih dahulu.',409);
   for(const item of items)if(item.status!=='SUCCEEDED')item.status='CANCELLED';current.status='CANCELLED';
  }
  current.result={items};await tx.query('UPDATE nota_app.jobs SET status=$2,result=$3,error_code=NULL,updated_at=now() WHERE id=$1',[job.id,current.status,JSON.stringify(current.result)]);return publicApproval(current);
 });
}
export async function runApproval(job:any){
 const profile=(await database().query('SELECT * FROM nota_app.profiles WHERE uid=$1',[job.uid])).rows[0];
 invariant(profile?.active&&['ADMIN','TAX'].includes(profile.role),'FORBIDDEN','Akun pemroses sudah tidak aktif atau tidak berwenang.',403);
 const user:User={uid:job.uid,username:profile.username,displayName:profile.display_name,role:profile.role,branchId:profile.branch_id||'',branchName:'',branchType:'',active:true};
 const items=publicApproval(job).items;
 for(const item of items){
  if(item.status!=='QUEUED')continue;
  item.status='PROCESSING';await database().query('UPDATE nota_app.jobs SET result=$2 WHERE id=$1',[job.id,JSON.stringify({items})]);
  try{await executePlan(job.id,'approval-'+item.id,user,()=>approvalPlan(user,item));item.status='SUCCEEDED';}
  catch(error){const safe=publicError(error),step=(await database().query('SELECT status FROM nota_app.job_steps WHERE job_id=$1 AND step_key=$2',[job.id,'approval-'+item.id])).rows[0];item.status=step&&step.status!=='COMMITTED'?'RECOVERY_REQUIRED':'FAILED';item.error=safe.message;item.message=safe.message;}
  await database().query('UPDATE nota_app.jobs SET result=$2 WHERE id=$1',[job.id,JSON.stringify({items})]);
 }
 const status=items.some((i:any)=>i.status==='RECOVERY_REQUIRED')?'NEEDS_REVIEW':items.some((i:any)=>i.status==='FAILED')?'FAILED':'SUCCEEDED';
 await database().query('UPDATE nota_app.jobs SET status=$2,result=$3,progress=100,updated_at=now() WHERE id=$1',[job.id,status,JSON.stringify({items})]);
}

