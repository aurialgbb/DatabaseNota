import {randomUUID} from 'node:crypto';
import {database,transaction,type Database} from './db';
import {invariant} from './errors';
import {type User,requireRole} from './identity';
import {createJob,mutateOnce} from './jobs';
import {writeReceipt,receiptDetail} from './receipts';
async function group(db:Database,user:User,id:string){
 invariant(/^[0-9a-f-]{36}$/i.test(id),'INVALID_UPLOAD','Batch unggahan tidak valid.');
 const row=(await db.query('SELECT * FROM nota_app.upload_groups WHERE id=$1 FOR UPDATE',[id])).rows[0];
 invariant(row&&row.uid===user.uid&&row.branch_id===user.branchId,'NOT_FOUND','Batch unggahan tidak ditemukan.',404);return row;
}
export async function storeAction(user:User,action:string,p:any,key:string){
 requireRole(user,['TOKO']);
 return transaction(async db=>{
 if(action==='START_STORE_OCR')return mutateOnce(db,user,action,key,p,async()=>{
  const count=Number(p.photoCount||1);invariant(Number.isInteger(count)&&count>=1&&count<=5,'INVALID_COUNT','Pilih 1–5 foto nota.');
  const id=randomUUID();await db.query('INSERT INTO nota_app.upload_groups(id,uid,branch_id,expected_photos) VALUES($1,$2,$3,$4)',[id,user.uid,user.branchId,count]);return {uploadId:id,photoCount:count};
 });
 if(action==='RESUBMIT_RECEIPT')return mutateOnce(db,user,action,key,p,async()=>{
  const previous=await receiptDetail(db,user,String(p.receiptId));invariant(previous.status==='NEEDS_CORRECTION','RECEIPT_LOCKED','Nota ini tidak menunggu perbaikan.',409);
  const updated=await writeReceipt(db,user,{...p.receipt,branchId:previous.branchId,expectedVersion:p.receipt?.version,photoId:previous.photoId},previous.id,'PENDING',true);return {success:true,receiptId:updated.id};
 });
 const upload=await group(db,user,String(p.uploadId||''));
 if(action==='SUBMIT_STORE_DRAFT')return mutateOnce(db,user,action,key,p,async()=>{
  if(upload.status==='SUBMITTED')return {success:true,receiptIds:upload.receipt_ids};
  invariant(Array.isArray(p.receipts)&&p.receipts.length>0&&p.receipts.length<=20,'INVALID_RECEIPTS','Isi 1–20 nota sebelum mengirim.');
  const ids=[];
  for(let i=0;i<p.receipts.length;i++){
   const receipt=p.receipts[i],photo=receipt.photoId?(await db.query("SELECT id FROM nota_app.photos WHERE id=$1 AND owner_uid=$2 AND upload_group=$3 AND state='READY'",[receipt.photoId,user.uid,upload.id])).rows[0]:null;
   invariant(!receipt.photoId||photo,'PHOTO_NOT_READY','Foto nota harus berasal dari batch unggahan ini.');
   const id='RCT-'+upload.id+'-'+i;await writeReceipt(db,user,{...receipt,photoIds:photo?[photo.id]:[]},id);ids.push(id);
  }
  await db.query("UPDATE nota_app.upload_groups SET status='SUBMITTED',receipt_ids=$2 WHERE id=$1",[upload.id,JSON.stringify(ids)]);return {success:true,receiptIds:ids};
 });
 invariant(upload.status!=='SUBMITTED','UPLOAD_SUBMITTED','Batch sudah pernah dikirim.',409);
 if(action==='PROCESS_STORE_OCR_PHOTO'){
  invariant(process.env.GEMINI_API_KEY,'OCR_NOT_CONFIGURED','Kunci Gemini belum dikonfigurasi.',503);
  const clientId=String(p.clientPhotoId||'');invariant(/^[A-Za-z0-9_-]{1,80}$/.test(clientId),'INVALID_PHOTO','Identitas foto tidak valid.');
  const previous=(await db.query('SELECT * FROM nota_app.ocr_photos WHERE upload_id=$1 AND client_photo_id=$2',[upload.id,clientId])).rows[0];
    if(previous){
   invariant(previous.photo_id===p.photoId,'PHOTO_CONFLICT','Identitas foto sudah digunakan.',409);
   const job=(await db.query('SELECT * FROM nota_app.jobs WHERE id=$1 FOR UPDATE',[previous.job_id])).rows[0];
   if(job.status==='SUCCEEDED')return job.result;
   if(['FAILED','NEEDS_REVIEW'].includes(job.status)){
    if(p.forceRetry===true&&job.request_key!==key){
     invariant(job.version<5,'RETRY_LIMIT','Batas percobaan OCR tercapai. Gunakan input manual.');
     await db.query('DELETE FROM nota_app.job_steps WHERE job_id=$1',[job.id]);
     await db.query("UPDATE nota_app.jobs SET status='QUEUED',request_key=$2,result=NULL,error_code=NULL,version=version+1,updated_at=now() WHERE id=$1",[job.id,key]);
    }else return {...job.payload,success:false,pending:false,receipts:[],warnings:[job.result?.message||'Foto belum berhasil dibaca.'],error:job.result?.message||'Foto belum berhasil dibaca.'};
   }
   return {...job.payload,pending:true,queued:job.status==='QUEUED',retryAfterMs:2000};
  }
  const count=(await db.query('SELECT count(*)::int AS n FROM nota_app.ocr_photos WHERE upload_id=$1',[upload.id])).rows[0].n;invariant(count<upload.expected_photos,'UPLOAD_FULL','Jumlah foto melebihi batch unggahan.');
  const photo=(await db.query("SELECT * FROM nota_app.photos WHERE id=$1 AND state='READY'",[p.photoId])).rows[0];invariant(photo&&photo.owner_uid===user.uid&&photo.upload_group===upload.id,'PHOTO_NOT_READY','Foto belum siap atau berasal dari batch berbeda.');
  const job=await createJob(db,user,'STORE_OCR',{photoId:photo.id,uploadId:upload.id,clientPhotoId:clientId,index:Number(p.index)||0,fileName:String(p.fileName||'Nota').slice(0,250)},key);
  await db.query('INSERT INTO nota_app.ocr_photos(upload_id,client_photo_id,photo_id,job_id) VALUES($1,$2,$3,$4)',[upload.id,clientId,photo.id,job.id]);return {...job.payload,pending:true,queued:true,retryAfterMs:2000};
 }
 const jobs=(await db.query('SELECT p.client_photo_id,j.status,j.payload,j.result FROM nota_app.ocr_photos p JOIN nota_app.jobs j ON j.id=p.job_id WHERE p.upload_id=$1 ORDER BY (j.payload->>\'index\')::int',[upload.id])).rows;
 if(action==='GET_STORE_OCR_STATUS')return {uploadId:upload.id,status:upload.status,expectedPhotos:upload.expected_photos,jobs:Object.fromEntries(jobs.map(j=>[j.client_photo_id,{status:j.status==='SUCCEEDED'?'DONE':j.status,result:j.status==='SUCCEEDED'?j.result:['FAILED','NEEDS_REVIEW'].includes(j.status)?{...j.payload,success:false,pending:false,receipts:[],warnings:[j.result?.message||'Foto belum berhasil dibaca.']}:undefined,...j.payload}]))};
 if(action==='FINALIZE_STORE_OCR'){
  invariant(!jobs.some(j=>['RUNNING','QUEUED'].includes(j.status)),'OCR_PENDING','Masih ada foto yang sedang dibaca.',409);
  await db.query("UPDATE nota_app.upload_groups SET status='READY_TO_SUBMIT' WHERE id=$1",[upload.id]);return {uploadId:upload.id,photos:jobs.map(j=>j.status==='SUCCEEDED'?j.result:{...j.payload,receipts:[],warnings:['Foto belum berhasil dibaca. Isi nota secara manual atau coba ulang.']})};
 }
 });
}


