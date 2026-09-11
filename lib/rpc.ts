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
 invariant(body.operation==='PORTAL_API','FEATURE_PENDING','Menu ini belum tersambung ke backend baru.',501);
 if(accountActions.includes(action))return accountAction(user,action,payload);
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
 if(action==='GET_MASTER_LINKS'){
  requireRole(user,['ADMIN','TAX']);const period=String(payload.period||'').replace('-','');invariant(/^\d{4}(0[1-9]|1[0-2])$/.test(period),'INVALID_PERIOD','Periode tidak valid.');
  const branches=(await db.query('SELECT id,name,type,active FROM nota_app.branches ORDER BY name')).rows;
  const links=Object.fromEntries((await db.query('SELECT branch_id,spreadsheet_id FROM nota_app.master_links WHERE period=$1',[period])).rows.map(r=>[r.branch_id,{url:'https://docs.google.com/spreadsheets/d/'+r.spreadsheet_id+'/edit',spreadsheetId:r.spreadsheet_id}]));
  return {period,branches,links,revision:0};
 }
 if(action==='UPSERT_MASTER_BRANCH'){
  requireRole(user,['ADMIN','TAX']);const id=String(payload.id||randomUUID()),name=String(payload.name||'').trim(),type=String(payload.type||'Mandiri');
  invariant(name.length>0&&name.length<=150&&id.length<=100,'INVALID_BRANCH','Nama cabang wajib diisi.');
  const period=String(payload.period||'').replace('-','');invariant(/^\d{4}(0[1-9]|1[0-2])$/.test(period),'INVALID_PERIOD','Periode tidak valid.');
  const raw=String(payload.url||'').trim();const match=raw.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  invariant(!raw||match,'INVALID_SHEET','Gunakan URL Google Spreadsheet.');
  await transaction(async tx=>{
   await tx.query('INSERT INTO nota_app.branches(id,name,type) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,type=$3',[id,name,type]);
   if(match)await tx.query('INSERT INTO nota_app.master_links(branch_id,period,spreadsheet_id) VALUES($1,$2,$3) ON CONFLICT(branch_id,period) DO UPDATE SET spreadsheet_id=$3',[id,period,match[1]]);
   else await tx.query('DELETE FROM nota_app.master_links WHERE branch_id=$1 AND period=$2',[id,period]);
   await tx.query("INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,'MASTER_BRANCH_UPDATE',$2)",[user.uid,id]);
  });return {success:true,id};
 }
 if(/OCR/.test(action))throw new AppError('OCR_NOT_CONFIGURED','OCR belum diaktifkan. Login dan pengaturan akun tetap dapat digunakan.',503);
 throw new AppError('FEATURE_PENDING','Fitur ini masih dalam proses penyambungan ke backend baru. Data belum diubah.',501);
}
