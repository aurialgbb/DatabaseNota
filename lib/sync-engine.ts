import {database,transaction,type Database} from './db';
import {sheetsRequest} from './sheets';
import {readModel,padded,type Target} from './sync-model';
import {invariant} from './errors';
import {stableJson,type User} from './identity';
export type Edit={target:Target;sheetId:number;rowIndex:number;startColumn:number;before:any[];after:any[];rowId:string;oldTagId?:number;owner?:string;mapping?:any;removeMapping?:string};
export type Plan={edits:Edit[];receipts:any[];expenses:any[];resources:string[];branchName:string;period:string;createdAt:number};
const same=(a:any,b:any)=>stableJson(a)===stableJson(b);
export async function persistPlan(jobId:string,step:string,plan:Plan){
 const owner=jobId+':'+step;
 return transaction(async db=>{
  for(const receipt of [...plan.receipts].sort((a,b)=>a.id.localeCompare(b.id))){
   const current=(await db.query('SELECT version FROM nota_app.receipts WHERE id=$1 FOR UPDATE',[receipt.id])).rows[0];
   invariant(current?.version===receipt.expectedVersion,'RECEIPT_CONFLICT','Nota berubah sebelum sinkronisasi. Muat ulang dan review kembali.',409);
  }
  for(const resource of [...new Set(plan.resources)].sort()){
   const acquired=await db.query("INSERT INTO nota_app.resource_leases(resource,owner,expires_at) VALUES($1,$2,'infinity') ON CONFLICT(resource) DO UPDATE SET owner=$2,expires_at='infinity',generation=resource_leases.generation+1 WHERE resource_leases.owner=$2 OR resource_leases.expires_at<now() RETURNING resource",[resource,owner]);
   invariant(acquired.rows.length,'SYNC_BUSY','Ada pekerjaan belum selesai pada tujuan ini. Lanjutkan atau batalkan pekerjaan tersebut terlebih dahulu.',409);
  }
  await db.query("INSERT INTO nota_app.job_steps(job_id,step_key,status,result,attempts) VALUES($1,$2,'PREPARED',$3,1) ON CONFLICT(job_id,step_key) DO NOTHING",[jobId,step,JSON.stringify(plan)]);return plan;
 });
}
function cell(value:any){return {userEnteredValue:typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:String(value??'')}};}
export async function executePlan(jobId:string,step:string,user:User,build:()=>Promise<Plan>){
 const db=database();let stored=(await db.query('SELECT * FROM nota_app.job_steps WHERE job_id=$1 AND step_key=$2',[jobId,step])).rows[0];
 if(stored?.status==='COMMITTED')return stored.result;
 const plan:Plan=stored?.result||await persistPlan(jobId,step,await build()),owner=jobId+':'+step;
 const held=(await db.query("SELECT resource FROM nota_app.resource_leases WHERE owner=$1 AND expires_at>now()",[owner])).rows;
 invariant(new Set(held.map(r=>r.resource)).size===new Set(plan.resources).size,'SYNC_LOCK_LOST','Kepemilikan pekerjaan perlu diperiksa sebelum dilanjutkan.',409);
 await db.query("UPDATE nota_app.job_steps SET status='WRITING',attempts=attempts+1,updated_at=now() WHERE job_id=$1 AND step_key=$2",[jobId,step]);
 const groups=new Map<string,Edit[]>();for(const e of plan.edits){const key=e.target.fileId;groups.set(key,[...(groups.get(key)||[]),e]);}
 for(const [fileId,edits] of groups){
  const models=new Map<number,Awaited<ReturnType<typeof readModel>>>();for(const e of edits)if(!models.has(e.sheetId))models.set(e.sheetId,await readModel(e.target));
  const requests:any[]=[];
  for(const edit of edits){
   const model=models.get(edit.sheetId)!;invariant(model.sheetId===edit.sheetId,'SHEET_REPLACED','Tab spreadsheet telah diganti. Perlu pemeriksaan.',409);
   const tags=model.tags[edit.rowIndex]||[],tag=tags.find(t=>t.metadataKey==='NOTA_ROW_ID');
   const actual=padded(model.values[edit.rowIndex-1],edit.startColumn+edit.after.length).slice(edit.startColumn),after=same(actual,edit.after)&&tag?.metadataValue===edit.rowId;
   invariant(tags.filter(t=>t.metadataKey==='NOTA_ROW_ID').length<=1,'ROW_ID_CONFLICT','Identitas baris ganda. Perlu pemeriksaan.',409);
   if(after){invariant(!padded(model.formulas[edit.rowIndex-1],edit.startColumn+edit.after.length).slice(edit.startColumn).some(v=>typeof v==='string'&&v.startsWith('=')),'FORMULA_PROTECTED','Baris telah diganti rumus. Perlu pemeriksaan.',409);continue;}
   invariant(same(actual,edit.before),'SHEET_CONFLICT','Isi baris '+edit.rowIndex+' telah berubah. Tidak ditimpa otomatis.',409);
   invariant(!tags.some(t=>/^PORTAL_(R_|CK_)/.test(t.metadataKey)),'FOREIGN_RECEIPT','Baris masih dimiliki aplikasi lama. Perlu pemeriksaan.',409);
   invariant(!tag||tag.metadataValue===edit.rowId,'ROW_MOVED','Identitas baris berubah. Muat ulang sebelum melanjutkan.',409);
   const formulas=padded(model.formulas[edit.rowIndex-1],edit.startColumn+edit.after.length).slice(edit.startColumn);invariant(!formulas.some(v=>typeof v==='string'&&v.startsWith('=')),'FORMULA_PROTECTED','Baris tujuan berisi rumus dan tidak ditimpa otomatis.',409);
   requests.push({updateCells:{range:{sheetId:edit.sheetId,startRowIndex:edit.rowIndex-1,endRowIndex:edit.rowIndex,startColumnIndex:edit.startColumn,endColumnIndex:edit.startColumn+edit.after.length},rows:[{values:edit.after.map(cell)}],fields:'userEnteredValue'}});
   if(!tag)requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:'NOTA_ROW_ID',metadataValue:edit.rowId,visibility:'DOCUMENT',location:{dimensionRange:{sheetId:edit.sheetId,dimension:'ROWS',startIndex:edit.rowIndex-1,endIndex:edit.rowIndex}}}}});
   const ownerTag=tags.find(t=>t.metadataKey==='NOTA_CK_OWNER');if(edit.owner&&!ownerTag)requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:'NOTA_CK_OWNER',metadataValue:edit.owner,visibility:'DOCUMENT',location:{dimensionRange:{sheetId:edit.sheetId,dimension:'ROWS',startIndex:edit.rowIndex-1,endIndex:edit.rowIndex}}}}});
   invariant(!ownerTag||ownerTag.metadataValue===edit.owner,'DISTRIBUTION_CONFLICT','Kepemilikan distribusi CK berubah.',409);
  }
  if(requests.length)await sheetsRequest(fileId,':batchUpdate','POST',{requests});
  for(const [sheetId] of models){const sample=edits.find(e=>e.sheetId===sheetId)!;const verified=await readModel(sample.target);
   for(const e of edits.filter(e=>e.sheetId===sheetId)){const row=padded(verified.values[e.rowIndex-1],e.startColumn+e.after.length).slice(e.startColumn);invariant(same(row,e.after)&&(verified.tags[e.rowIndex]||[]).some(t=>t.metadataKey==='NOTA_ROW_ID'&&t.metadataValue===e.rowId),'WRITE_UNCONFIRMED','Hasil tulis perlu diperiksa sebelum database diperbarui.',409);}
  }
 }
 const result={success:true,operationId:jobId,status:'COMPLETED',progress:plan.edits.length,total:plan.edits.length,rows:plan.edits.map(e=>e.rowIndex)};
 await transaction(async tx=>{
  for(const r of plan.receipts){
   const before=(await tx.query('SELECT version FROM nota_app.receipts WHERE id=$1 FOR UPDATE',[r.id])).rows[0];invariant(before&&before.version===r.expectedVersion,'RECEIPT_CONFLICT','Versi nota berubah saat sinkronisasi. Lanjutkan pemeriksaan pekerjaan.',409);
   await tx.query('UPDATE nota_app.receipts SET status=$2,supplier=$3,receipt_date=$4,total=$5,eliminated=$6,data=$7,version=version+1,updated_at=now() WHERE id=$1',[r.id,r.status,r.supplier,r.date,r.receiptTotal,!!r.eliminated,JSON.stringify(r.data)]);
   if(r.items){await tx.query('DELETE FROM nota_app.receipt_items WHERE receipt_id=$1',[r.id]);for(let i=0;i<r.items.length;i++){const item=r.items[i];await tx.query('INSERT INTO nota_app.receipt_items(id,receipt_id,position,description,category,quantity,unit,amount,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[item.id,r.id,i,item.description,item.category,item.quantity,item.unit||'',item.amount,JSON.stringify(item)]);}}
   if(r.photoId){await tx.query('DELETE FROM nota_app.receipt_photos WHERE receipt_id=$1',[r.id]);await tx.query('INSERT INTO nota_app.receipt_photos(receipt_id,photo_id) VALUES($1,$2)',[r.id,r.photoId]);}
  }
  for(const e of plan.expenses){
   const row=(await tx.query('SELECT version FROM nota_app.transactions WHERE id=$1 FOR UPDATE',[e.id])).rows[0];invariant(e.expectedVersion==null?!row:row?.version===e.expectedVersion,'TRANSACTION_CONFLICT','Transaksi arsip telah berubah. Perlu pemeriksaan.',409);
   if(e.remove)await tx.query('DELETE FROM nota_app.transactions WHERE id=$1',[e.id]);else await tx.query("INSERT INTO nota_app.transactions(id,kind,branch_id,business_date,amount,data) VALUES($1,'UMUM',$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET business_date=$3,amount=$4,data=$5,version=transactions.version+1,updated_at=now()",[e.id,e.branchId,e.date,e.data.nominal,JSON.stringify(e.data)]);
  }
  for(const e of plan.edits){if(e.removeMapping)await tx.query('DELETE FROM nota_app.sheet_mappings WHERE item_id=$1',[e.removeMapping]);if(e.mapping)await tx.query('INSERT INTO nota_app.sheet_mappings(item_id,receipt_id,spreadsheet_id,sheet_id,row_index,snapshot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(item_id) DO UPDATE SET receipt_id=$2,spreadsheet_id=$3,sheet_id=$4,row_index=$5,snapshot=$6,version=sheet_mappings.version+1',[e.mapping.itemId,e.mapping.receiptId||null,e.target.fileId,e.sheetId,e.rowIndex,JSON.stringify({...e.mapping.snapshot,rowId:e.rowId,cells:e.after,date:e.mapping.snapshot?.date,owner:e.owner||''})]);}
  await tx.query("UPDATE nota_app.job_steps SET status='COMMITTED',result=$3,updated_at=now() WHERE job_id=$1 AND step_key=$2",[jobId,step,JSON.stringify({...result,plan})]);
  await tx.query('DELETE FROM nota_app.resource_leases WHERE owner=$1',[owner]);await tx.query('INSERT INTO nota_app.audit_events(uid,action,entity_id,details) VALUES($1,$2,$3,$4)',[user.uid,'SHEET_SYNC_COMMIT',jobId,JSON.stringify({step,rows:plan.edits.length})]);
 });return result;
}
export async function cancelPlan(jobId:string,step:string){
 const db=database(),record=(await db.query('SELECT * FROM nota_app.job_steps WHERE job_id=$1 AND step_key=$2',[jobId,step])).rows[0];if(!record)return;
 invariant(record.status==='PREPARED','CANNOT_CANCEL','Penulisan sudah dimulai. Lanjutkan pemulihan, bukan membatalkan.',409);
 await transaction(async tx=>{await tx.query('DELETE FROM nota_app.job_steps WHERE job_id=$1 AND step_key=$2',[jobId,step]);await tx.query('DELETE FROM nota_app.resource_leases WHERE owner=$1',[jobId+':'+step]);});
}


