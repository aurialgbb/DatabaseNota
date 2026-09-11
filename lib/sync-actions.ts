import {reconcileSheetPlan} from './sync-reconcile';
import {database,transaction} from './db';import {createJob,authorizedJob} from './jobs';import {requireRole,type User} from './identity';import {invariant,publicError} from './errors';import {executePlan} from './sync-engine';import {mutationPlan,receiptMutationPlan} from './sync-plans';import {targetFor} from './sync-model';
export const syncActions=['GET_TARIK_JOB','LIST_PENDING_TARIK_JOBS','CANCEL_TARIK_JOB','GET_MUTATION_JOB','RESUME_MUTATION_JOB','RESUME_TARIK_JOB','MOVE_RECEIPT_DATE','ELIMINATE_RECEIPT','RESOLVE_TARIK_JOB_FROM_SPREADSHEET'];
const publicId=(id:string)=>'TARIK-'+id;
export async function startSync(user:User,p:any,key:string,reset=false){
 requireRole(user,['ADMIN','TAX']);const target=await targetFor(p);
 if(reset)invariant(Array.isArray(p.deletedItems)&&p.deletedItems.length>0&&!(p.newItems?.length||p.editedItems?.length||p.photoItemsExisting?.length),'INVALID_RESET','Pilih baris yang akan direset.');
 const job=await transaction(tx=>createJob(tx,user,'SHEET_SYNC',{...p,branchId:target.branchId,reset},key,target.branchId));return {operationId:job.id,awaitResult:true};
}
async function view(job:any){
 const step=(await database().query("SELECT * FROM nota_app.job_steps WHERE job_id=$1 AND step_key='sync'",[job.id])).rows[0],plan=step?.status==='COMMITTED'?step.result.plan:step?.result;
 return {operationId:publicId(job.id),status:job.status==='SUCCEEDED'?'COMPLETED':['FAILED','NEEDS_REVIEW'].includes(job.status)?'RECOVERY_REQUIRED':job.status,progress:job.status==='SUCCEEDED'?(plan?.edits?.length||0):0,total:plan?.edits?.length||0,createdAt:new Date(job.created_at).getTime(),branchName:plan?.branchName||job.payload.cabang||'',period:plan?.period||'',validationError:'',result:job.result,items:(plan?.edits||[]).map((e:any)=>({rowIndex:e.rowIndex,date:e.mapping?.snapshot?.date||'',description:e.after[0]||'Perubahan baris',amount:0,action:'Simpan perubahan',status:step.status==='COMMITTED'?'Penulisan tercatat':'Belum terkonfirmasi'}))};
}
export async function syncAction(user:User,action:string,p:any,key=''){
 requireRole(user,['ADMIN','TAX']);
 if(['MOVE_RECEIPT_DATE','ELIMINATE_RECEIPT'].includes(action)){invariant(typeof p.receiptId==='string'&&Number.isInteger(p.expectedVersion),'INVALID_RECEIPT','Identitas dan versi nota diperlukan.');const job=await transaction(tx=>createJob(tx,user,'SHEET_SYNC',{...p,mode:action},key));return {operationId:job.id,awaitResult:true};}
 if(action==='LIST_PENDING_TARIK_JOBS'){const jobs=(await database().query("SELECT * FROM nota_app.jobs WHERE kind='SHEET_SYNC' AND status NOT IN ('SUCCEEDED','CANCELLED') AND (uid=$1 OR $2='ADMIN') ORDER BY created_at LIMIT 100",[user.uid,user.role])).rows;return {jobs:await Promise.all(jobs.map(view)),nextCursor:''};}
 const id=String(p.operationId||p.jobId||'').replace(/^TARIK-/,'');
 const job=await authorizedJob(database(),user,id);invariant(job.kind==='SHEET_SYNC'&&(job.uid===user.uid||user.role==='ADMIN'),'FORBIDDEN','Pekerjaan tidak dapat diakses.',403);
 if(['GET_TARIK_JOB','GET_MUTATION_JOB'].includes(action))return view(job);
 return transaction(async tx=>{
  const current=(await tx.query('SELECT * FROM nota_app.jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
  invariant(current.status!=='RUNNING','JOB_RUNNING','Pekerjaan masih berjalan. Tunggu hasilnya.',409);
  if(action==='CANCEL_TARIK_JOB'){
   invariant(current.status!=='SUCCEEDED','JOB_COMPLETED','Pekerjaan sudah selesai.',409);
   const step=(await tx.query("SELECT status FROM nota_app.job_steps WHERE job_id=$1 AND step_key='sync'",[id])).rows[0];invariant(!step||step.status==='PREPARED','CANNOT_CANCEL','Penulisan sudah dimulai. Lanjutkan pemeriksaan pekerjaan.',409);
   await tx.query("DELETE FROM nota_app.job_steps WHERE job_id=$1 AND step_key='sync'",[id]);await tx.query('DELETE FROM nota_app.resource_leases WHERE owner=$1',[id+':sync']);await tx.query("UPDATE nota_app.jobs SET status='CANCELLED',updated_at=now() WHERE id=$1",[id]);return {success:true,operationId:publicId(id),status:'CANCELLED'};
  }
  if(current.status==='SUCCEEDED')return current.result;invariant(current.status!=='CANCELLED','JOB_CANCELLED','Pekerjaan sudah dibatalkan. Buat perubahan baru.',409);
  await tx.query("UPDATE nota_app.jobs SET status='QUEUED',error_code=NULL,payload=jsonb_set(payload,'{preferSpreadsheet}',to_jsonb($2::boolean)),updated_at=now() WHERE id=$1",[id,action==='RESOLVE_TARIK_JOB_FROM_SPREADSHEET']);return {operationId:id,awaitResult:true};
 });
}
export async function runSync(job:any){
 const db=database(),profile=(await db.query('SELECT * FROM nota_app.profiles WHERE uid=$1',[job.uid])).rows[0];
 try{
  invariant(profile?.active&&['ADMIN','TAX'].includes(profile.role),'FORBIDDEN','Akun pemroses sudah tidak aktif atau tidak berwenang.',403);
  const user:User={uid:job.uid,username:profile.username,displayName:profile.display_name,role:profile.role,branchId:profile.branch_id||'',branchName:'',branchType:'',active:true};
  if(job.payload.preferSpreadsheet)await reconcileSheetPlan(job.id,user);
  const result=await executePlan(job.id,'sync',user,()=>job.payload.mode?receiptMutationPlan(user,job.payload):mutationPlan(user,job.payload));const {plan,...safe}=result as any;
  await db.query("UPDATE nota_app.jobs SET status='SUCCEEDED',result=$2,progress=100,updated_at=now() WHERE id=$1",[job.id,JSON.stringify({...safe,operationId:publicId(job.id),message:'Perubahan tersimpan.'})]);
 }catch(error){const safe=publicError(error),step=(await db.query("SELECT status FROM nota_app.job_steps WHERE job_id=$1 AND step_key='sync'",[job.id])).rows[0];await db.query("UPDATE nota_app.jobs SET status=$2,result=$3,error_code=$4,updated_at=now() WHERE id=$1",[job.id,step?'NEEDS_REVIEW':'FAILED',JSON.stringify({success:false,operationId:publicId(job.id),status:'RECOVERY_REQUIRED',message:safe.message}),safe.code]);}
}
