import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { invariant,AppError } from './errors';
import { requireBranch, type User } from './identity';
import { portalValidateReceiptPayload_ } from '../generated/receipt-domain.mjs';
export async function categories(db: Database) {
 return (await db.query('SELECT name,position FROM nota_app.categories ORDER BY position,name')).rows.map((r:any)=>({id:r.name.replace(/[^A-Z0-9]+/g,'_'),name:r.name,order:r.position,active:true}));
}
export async function receiptDetail(db:Database,user:User,id:string) {
 const row=(await db.query('SELECT r.*,r.receipt_date::text AS receipt_date,b.name AS branch_name,b.type AS branch_type FROM nota_app.receipts r JOIN nota_app.branches b ON b.id=r.branch_id WHERE r.id=$1',[id])).rows[0];
 invariant(row,'NOT_FOUND','Nota tidak ditemukan.',404); requireBranch(user,row.branch_id);
 const items=(await db.query('SELECT * FROM nota_app.receipt_items WHERE receipt_id=$1 ORDER BY position',[id])).rows.map((i:any)=>({...i.data,id:i.id,description:i.description,category:i.category,quantity:Number(i.quantity),unit:i.unit,amount:Number(i.amount)}));
 return {...row.data,id:row.id,displayNumber:row.data.displayNumber||row.id.slice(-6),branchId:row.branch_id,branchName:row.branch_name,branchType:row.branch_type,supplier:row.supplier,date:row.receipt_date ? new Date(row.receipt_date).toISOString().slice(0,10):'',items,receiptTotal:Number(row.total),status:row.status,version:row.version,eliminated:row.eliminated};
}
export async function listReceipts(db:Database,user:User,payload:any) {
 const limit=Math.min(100,Math.max(1,Math.floor(Number(payload.limit)||40)));
 const branchId=user.role==='TOKO'?user.branchId:String(payload.branchId||'');
 const values:any[]=[], clauses=['true'];
 if(branchId){ values.push(branchId); clauses.push('r.branch_id=$'+values.length); }
 if(payload.status && payload.status!=='ALL'){ values.push(payload.status); clauses.push('r.status=$'+values.length); }
 if(payload.dateFrom){values.push(payload.dateFrom);clauses.push('r.receipt_date >= $'+values.length+'::date');}
 if(payload.dateTo){values.push(payload.dateTo);clauses.push('r.receipt_date <= $'+values.length+'::date');}
 if(payload.cursor){
   let cursor;try{cursor=JSON.parse(Buffer.from(payload.cursor,'base64url').toString());}catch{invariant(false,'INVALID_CURSOR','Posisi halaman tidak valid.');}
   invariant(Array.isArray(cursor)&&cursor.length===2,'INVALID_CURSOR','Posisi halaman tidak valid.');
   values.push(cursor[0],cursor[1]);clauses.push("(coalesce(r.receipt_date,date '0001-01-01'),r.id)<($"+(values.length-1)+"::date,$"+values.length+")");
 }
 values.push(limit+1);
 const rows=(await db.query('SELECT r.*,r.receipt_date::text AS receipt_date,b.name AS branch_name,b.type AS branch_type,(SELECT count(*)::int FROM nota_app.receipt_items i WHERE i.receipt_id=r.id) AS item_count FROM nota_app.receipts r JOIN nota_app.branches b ON b.id=r.branch_id WHERE '+clauses.join(' AND ')+" ORDER BY coalesce(r.receipt_date,date '0001-01-01') DESC,r.id DESC LIMIT $"+values.length,values)).rows;
 const hasNext=rows.length>limit, visible=rows.slice(0,limit);
 const date=(r:any)=>r.receipt_date?new Date(r.receipt_date).toISOString().slice(0,10):'0001-01-01';
 return {rows:visible.map((r:any)=>({...r.data,id:r.id,displayNumber:r.data.displayNumber||r.id.slice(-6),branchId:r.branch_id,branchName:r.branch_name,branchType:r.branch_type,supplier:r.supplier,date:date(r),receiptTotal:Number(r.total),status:r.status,version:r.version,itemCount:r.item_count,eliminated:r.eliminated,submittedAt:new Date(r.created_at).getTime()})),hasNext,nextCursor:hasNext?Buffer.from(JSON.stringify([date(visible.at(-1)),visible.at(-1).id])).toString('base64url'):'',limit};
}
export async function writeReceipt(db:Database,user:User,input:any,id:string,status='PENDING',existing=false) {
 const names=(await categories(db)).map((c:any)=>c.name);
 let clean:any;try{clean=portalValidateReceiptPayload_(input,names);}catch(e){throw new AppError('INVALID_RECEIPT',e instanceof Error?e.message:'Isi nota tidak valid.');}
 const branchId=user.role==='TOKO'?user.branchId:String(input.branchId||'');
 requireBranch(user,branchId);
 invariant(branchId,'BRANCH_REQUIRED','Cabang wajib dipilih.');
 const photoIds=Array.from(new Set([input.photoId,...(input.photoIds||[])].filter(Boolean))) as string[];
 for(const photoId of photoIds){
  const photo=(await db.query("SELECT * FROM nota_app.photos WHERE id=$1 AND state='READY'",[photoId])).rows[0];
  invariant(photo && (user.role!=='TOKO'||(photo.branch_id===user.branchId && photo.owner_uid===user.uid)),'PHOTO_NOT_READY','Foto belum siap atau tidak dapat diakses.');
 }
 if(existing){
  const previous=(await db.query('SELECT * FROM nota_app.receipts WHERE id=$1 FOR UPDATE',[id])).rows[0];
  invariant(!(await db.query('SELECT resource FROM nota_app.resource_leases WHERE resource=$1 AND expires_at>now()',['receipt/'+id])).rows.length,'SYNC_BUSY','Nota sedang disinkronkan. Selesaikan pekerjaan tersebut terlebih dahulu.',409);
  invariant(previous,'NOT_FOUND','Nota tidak ditemukan.',404);requireBranch(user,previous.branch_id);
  invariant(previous.version===Number(input.expectedVersion),'VERSION_CONFLICT','Nota berubah. Muat ulang sebelum menyimpan.',409);
  invariant(['PENDING','NEEDS_CORRECTION','DRAFT'].includes(previous.status),'RECEIPT_LOCKED','Nota ini tidak dapat diedit dari formulir ini.',409);
  invariant(branchId===previous.branch_id,'BRANCH_CONFLICT','Cabang nota tidak boleh diubah.');
  await db.query('UPDATE nota_app.receipts SET supplier=$2,receipt_date=$3,total=$4,data=$5,status=$6,version=version+1,updated_at=now() WHERE id=$1',[id,clean.supplier,clean.date,clean.receiptTotal,JSON.stringify({...clean,photoId:photoIds[0]||'',photoIds}),status]);
  await db.query('DELETE FROM nota_app.receipt_items WHERE receipt_id=$1',[id]);
  await db.query('DELETE FROM nota_app.receipt_photos WHERE receipt_id=$1',[id]);
 }else{
  await db.query('INSERT INTO nota_app.receipts(id,branch_id,owner_uid,supplier,receipt_date,total,data,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,branchId,user.uid,clean.supplier,clean.date,clean.receiptTotal,JSON.stringify({...clean,photoId:photoIds[0]||'',photoIds}),status]);
 }
 for(let index=0;index<clean.items.length;index++){
  const item=clean.items[index];
  await db.query('INSERT INTO nota_app.receipt_items(id,receipt_id,position,description,category,quantity,unit,amount,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[item.id||randomUUID(),id,index,item.description,item.category,item.quantity,item.unit||'',item.amount,JSON.stringify(item)]);
 }
 for(const photoId of photoIds) await db.query('INSERT INTO nota_app.receipt_photos(receipt_id,photo_id) VALUES($1,$2)',[id,photoId]);
 await db.query('INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,$2,$3)',[user.uid,existing?'RECEIPT_UPDATE':'RECEIPT_CREATE',id]);
 return receiptDetail(db,user,id);
}


