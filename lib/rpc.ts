import {reviewAction} from './review';
import {masterAction,masterActions} from './master';
import {storeAction} from './store-actions';
import {createJob,mutateOnce} from './jobs';
import {ownedPhoto,photoUrl} from './storage';
import {writeReceipt} from './receipts';import { legacyRead,legacyMutate } from './legacy';
import { database, transaction } from './db';
import { requireRole, type User } from './identity';
import { accountAction,validatePassword } from './accounts';
import { accountAuth } from './better-auth';
import { categories,listReceipts,receiptDetail } from './receipts';
import { invariant,AppError } from './errors';
import { randomUUID } from 'node:crypto';
const accountActions=['GET_ACCOUNTS','PROVISION_ACCOUNTS','SET_ACCOUNT_ACTIVE','RESET_ACCOUNT_PASSWORD','UPDATE_ACCOUNT'];
export async function rpc(user:User,body:any,request:Request) {
 const action=String(body.action||''),payload=body.payload||{},db=database();
 if(body.operation==='LEGACY_API'){
  invariant(Array.isArray(payload),'INVALID_PAYLOAD','Parameter menu tidak valid.');
  const read=await legacyRead(db,user,action,payload);if(read!==undefined)return read;
  if(action==='getLegacyPhoto'){
   const value=String(payload[0]||'');const local=value.startsWith((process.env.APP_ORIGIN||'')+'/api/photos/')?value.slice((process.env.APP_ORIGIN||'').length):value;const match=local.match(/^\/api\/photos\/([0-9a-f-]{36})$/i);invariant(match,'INVALID_PHOTO','Foto tidak berasal dari aplikasi ini.');
   await ownedPhoto(user,match[1]);return {fileName:'Nota',dataUrl:(process.env.APP_ORIGIN||'')+'/api/photos/'+match[1]};
  }
  if(action==='processOCRWithGemini'||action==='processLLM'){
   invariant(process.env.GEMINI_API_KEY,'OCR_NOT_CONFIGURED','Kunci Gemini belum dikonfigurasi.',503);
   const kind=action==='processLLM'?'LEGACY_TEXT':'LEGACY_OCR';let data:any;
   if(kind==='LEGACY_OCR'){const photo=await ownedPhoto(user,String(payload[0]?.photoId||''));invariant(photo.owner_uid===user.uid&&photo.state==='READY','PHOTO_NOT_READY','Foto belum siap.');data={photoId:photo.id};}
   else {invariant(typeof payload[0]==='string'&&payload[0].length>0&&payload[0].length<50000,'INVALID_PROMPT','Teks permintaan AI tidak valid.');data={prompt:payload[0],isJson:!!payload[1]};}
   const job=await transaction(tx=>createJob(tx,user,kind,data,request.headers.get('idempotency-key')||''));return {operationId:job.id,awaitResult:true};
  }
  if(['saveTransactions','updateTransaction','deleteTransaction','duplicateToKategori','saveListrikTransaction','updateListrikTransaction','deleteListrikTransaction','bulkDeleteListrikTransaction'].includes(action))return transaction(tx=>legacyMutate(tx,user,action,payload,request.headers.get('idempotency-key')||''));
 }
 invariant(body.operation==='PORTAL_API','FEATURE_PENDING','Menu ini belum tersambung ke backend baru.',501);
 if(accountActions.includes(action))return accountAction(user,action,payload);
 if(['CLAIM_RECEIPT_REVIEW','RELEASE_RECEIPT_REVIEW','RESTORE_DISCARDED_RECEIPT'].includes(action))return reviewAction(user,action,payload,request.headers.get('idempotency-key')||'');
 if(['START_STORE_OCR','PROCESS_STORE_OCR_PHOTO','GET_STORE_OCR_STATUS','FINALIZE_STORE_OCR','SUBMIT_STORE_DRAFT','RESUBMIT_RECEIPT'].includes(action))return storeAction(user,action,payload,request.headers.get('idempotency-key')||'');
 if(action==='GET_PHOTO'||action==='GET_PHOTO_THUMBNAIL'){
  const photo=await ownedPhoto(user,String(payload.photoId||''));return {fileName:'Nota',dataUrl:(process.env.APP_ORIGIN||'')+'/api/photos/'+photo.id+(action==='GET_PHOTO_THUMBNAIL'?'?thumbnail=1':'')};
 }
 if(action==='SAVE_TAX_RECEIPT'){
  requireRole(user,['ADMIN','TAX']);return transaction(tx=>mutateOnce(tx,user,action,request.headers.get('idempotency-key')||'',payload,async()=>{
   const previous=await receiptDetail(tx,user,String(payload.receiptId||''));
   const updated=await writeReceipt(tx,user,{...payload.receipt,branchId:previous.branchId,photoId:previous.photoId,photoIds:previous.photoIds,expectedVersion:payload.expectedVersion||payload.receipt?.version},previous.id,'PENDING',true);
   return {success:true,version:updated.version};
  }));
 }
 if(action==='CHANGE_PASSWORD'){
  validatePassword(payload.newPassword);
  invariant(typeof payload.currentPassword==='string','CURRENT_PASSWORD_REQUIRED','Masukkan password saat ini.');
  try{await accountAuth().api.changePassword({headers:request.headers,body:{currentPassword:payload.currentPassword,newPassword:payload.newPassword,revokeOtherSessions:true}});}catch{throw new AppError('PASSWORD_CHANGE_FAILED','Password saat ini salah atau perubahan belum berhasil.');}
  return {success:true};
 }
 if(action==='GET_CATEGORIES')return categories(db);
 if(action==='GET_TAX_RECEIPTS'){requireRole(user,['ADMIN','TAX']);return listReceipts(db,user,payload);}
 if(action==='GET_STORE_HISTORY'){requireRole(user,['TOKO']);return listReceipts(db,user,payload);}
 if(action==='GET_RECEIPT_DETAIL')return receiptDetail(db,user,String(payload.receiptId||''));
 if(action==='GET_STORE_DASHBOARD'){
  requireRole(user,['TOKO']);const counts:Record<string,number>={PENDING:0,APPROVED:0,NEEDS_CORRECTION:0,REJECTED:0};
  for(const r of (await db.query('SELECT status,count(*)::int AS count FROM nota_app.receipts WHERE branch_id=$1 GROUP BY status',[user.branchId])).rows)counts[r.status]=r.count;
  return {branchName:user.branchName,counts,recent:(await listReceipts(db,user,{limit:5})).rows};
 }
 if(action==='LIST_ACTIVE_APPROVAL_JOBS'){requireRole(user,['ADMIN','TAX']);return (await db.query("SELECT id,status,progress FROM nota_app.jobs WHERE kind='APPROVAL' AND status IN ('QUEUED','RUNNING')")).rows;}
 if(masterActions.includes(action))return masterAction(user,action,payload,request.headers.get('idempotency-key')||'');
 if(/OCR/.test(action))throw new AppError('OCR_NOT_CONFIGURED','OCR belum diaktifkan. Login dan pengaturan akun tetap dapat digunakan.',503);
 throw new AppError('FEATURE_PENDING','Fitur ini masih dalam proses penyambungan ke backend baru. Data belum diubah.',501);
}




