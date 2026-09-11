import {database,transaction} from './db';import {readModel,padded,isoDay,type Model} from './sync-model';import {type Plan,type Edit} from './sync-engine';import {stableJson,type User} from './identity';import {invariant} from './errors';import {receiptDetail,categories} from './receipts';import {portalValidateReceiptPayload_} from '../generated/receipt-domain.mjs';
const same=(a:any,b:any)=>stableJson(a)===stableJson(b);
export async function reconcileSheetPlan(jobId:string,user:User){
 const db=database(),step=(await db.query("SELECT * FROM nota_app.job_steps WHERE job_id=$1 AND step_key='sync'",[jobId])).rows[0];if(!step||step.status==='COMMITTED')return;
 const plan:Plan=structuredClone(step.result),models=new Map<string,Model>(),names=(await categories(db)).map(c=>c.name),changed=new Set<string>(),manualDestinations=new Set<Edit>();
 for(const e of plan.edits){
  const key=e.target.fileId+'|'+e.sheetId;if(!models.has(key))models.set(key,await readModel(e.target));const model=models.get(key)!,actual=padded(model.values[e.rowIndex-1],e.startColumn+e.after.length).slice(e.startColumn),tags=model.tags[e.rowIndex]||[];
  invariant(model.sheetId===e.sheetId&&!tags.some(t=>/^PORTAL_/.test(t.metadataKey)||(t.metadataKey==='NOTA_ROW_ID'&&t.metadataValue!==e.rowId)),'ROW_MOVED','Identitas baris berubah. Pemeriksaan manual diperlukan.',409);
  invariant(!padded(model.formulas[e.rowIndex-1],e.startColumn+e.after.length).slice(e.startColumn).some(v=>String(v).startsWith('=')),'FORMULA_PROTECTED','Rumus Spreadsheet tidak diubah melalui pemulihan.',409);
  if(same(actual,e.before)||same(actual,e.after))continue;
  invariant(!e.identity||same(padded(model.values[e.rowIndex-1],3).slice(1,3),e.identity),'ROW_DATE_CHANGED','Tanggal atau nomor baris berubah. Pemeriksaan diperlukan.',409);
  if(e.target.type==='Central Kitchen'&&actual.some(v=>v!==''))invariant(actual[0]===e.after[0],'CK_BRANCH_CHANGED','Cabang distribusi berubah manual. Pulihkan cabang asal lalu ubah tujuan melalui webapp.',409);
  e.before=actual.slice();e.after=actual.slice();
  if(e.owner){manualDestinations.add(e);if(e.mapping)e.mapping.snapshot.cells=actual;continue;}
  const offset=e.target.type==='Central Kitchen'?1:0,empty=actual.every(v=>v===''||v==null);
  if(!empty){invariant(String(actual[offset]||'').trim()&&names.includes(String(actual[offset+1]||''))&&Number.isFinite(Number(actual[offset+3]))&&Number(actual[offset+3])>0,'INVALID_SHEET_ROW','Isi Spreadsheet belum valid pada baris '+e.rowIndex+'.');invariant(['YA','TIDAK',''].includes(String(actual[offset+4]||'').toUpperCase()),'INVALID_ELIMINATION','Nilai eliminasi tidak valid.');}
  let mapping=e.mapping;
  if(!mapping&&e.removeMapping){const old=(await db.query('SELECT * FROM nota_app.sheet_mappings WHERE item_id=$1',[e.removeMapping])).rows[0];if(old)mapping={itemId:old.item_id,receiptId:old.receipt_id,snapshot:old.snapshot};}
  if(mapping?.receiptId)changed.add(mapping.receiptId);
  if(empty){if(mapping)e.removeMapping=mapping.itemId;e.mapping=undefined;e.removeRowId=true;}
  else {invariant(mapping,'MAPPING_CONFLICT','Pemetaan baris yang dikembalikan tidak ditemukan.',409);e.mapping=mapping;e.removeMapping=undefined;e.removeRowId=false;}
  const expenseId=mapping?.snapshot?.expenseId;if(expenseId){const expense=plan.expenses.find(x=>x.id===expenseId);invariant(expense,'MAPPING_CONFLICT','Transaksi arsip tidak termasuk pekerjaan ini.',409);
   if(empty)expense.remove=true;else {const old=(await db.query('SELECT * FROM nota_app.transactions WHERE id=$1',[expenseId])).rows[0];expense.remove=false;expense.branchId=e.target.branchId;expense.date=isoDay(model.values[e.rowIndex-1]?.[1],e.target.period);expense.data={...(expense.data||old?.data||{}),keterangan:String(actual[offset]),jenis:String(actual[offset+1]),jumlah:String(actual[offset+2]),nominal:Number(actual[offset+3]),eliminasi:String(actual[offset+4]||'TIDAK')};}
  }
 }
 const sourceModels=[...models.values()].filter(m=>m.target.type==='Central Kitchen');
 for(const model of sourceModels){
  const after=model.values.map(v=>v.slice());for(const e of plan.edits.filter(e=>e.target.fileId===model.target.fileId&&e.sheetId===model.sheetId))after[e.rowIndex-1].splice(e.startColumn,e.after.length,...e.after);
  const groups=new Map<string,Edit[]>();for(const e of plan.edits)if(e.owner&&e.mapping?.snapshot.ckSource===model.target.fileId&&e.mapping?.snapshot.ckSheet===String(model.sheetId))groups.set(e.owner,[...(groups.get(e.owner)||[]),e]);
  for(const edits of groups.values()){
   edits.sort((a,b)=>a.rowIndex-b.rowIndex);const sample=edits[0],day=sample.mapping.snapshot.day,rows=after.filter(v=>Number(isoDay(v[1],model.target.period).slice(-2))===Number(day)&&String(v[3]).toUpperCase()===sample.target.branchName&&v[4]).map(v=>[v[1],v[2],v[4],v[5],v[6],v[7],v[8]]);
   invariant(rows.length<=edits.length,'CK_CAPACITY','Baris distribusi tidak cukup untuk hasil pemulihan.',409);
   for(let i=0;i<edits.length;i++)if(!manualDestinations.has(edits[i])){const e=edits[i],dest=models.get(e.target.fileId+'|'+e.sheetId)!;e.before=padded(dest.values[e.rowIndex-1],e.startColumn+e.after.length).slice(e.startColumn);e.after=rows[i]||[day,e.after[1],'','','','',''];}
  }
 }
 for(const id of changed){
  const update=plan.receipts.find(r=>r.id===id);invariant(update,'MAPPING_CONFLICT','Nota tidak termasuk rencana pemulihan.',409);const receipt=await receiptDetail(db,user,id),items:any[]=[];
  invariant(receipt.version===update.expectedVersion,'VERSION_CONFLICT','Versi nota berubah. Pemulihan dibatalkan.',409);
  for(const item of receipt.items){const edit=plan.edits.find(e=>e.mapping?.itemId===item.id);if(!edit){if(plan.edits.some(e=>e.removeMapping===item.id))continue;items.push(item);continue;}
   const offset=edit.target.type==='Central Kitchen'?1:0,c=edit.after,match=String(c[offset+2]||'').match(/^([\d.,]+)\s*(.*)$/);items.push({...item,description:String(c[offset]),category:String(c[offset+1]),quantity:match?Number(match[1].replace(',','.')):item.quantity,unit:match?match[2]:item.unit,amount:Number(c[offset+3]),grossAmount:Number(c[offset+3])+Number(item.discountAllocated||0),distributionBranch:offset?String(c[0]):item.distributionBranch});
  }
  invariant(items.length===0||items.length===receipt.items.length,'PARTIAL_RECEIPT','Selaraskan seluruh item nota; sebagian item masih terhapus di Spreadsheet.',409);
  if(!items.length){update.status='REJECTED';continue;}
  const clean=portalValidateReceiptPayload_({...receipt,items,receiptTotal:items.reduce((n,i)=>n+i.amount,0)},names);
  const states=plan.edits.filter(e=>e.mapping?.receiptId===id).map(e=>String(e.after.at(-1)||'TIDAK').toUpperCase());invariant(states.every(s=>s===states[0]),'PARTIAL_ELIMINATION','Status eliminasi seluruh item nota harus sama.',409);
  update.status='APPROVED';update.items=clean.items;update.receiptTotal=clean.receiptTotal;update.eliminated=states[0]==='YA';update.data={...update.data,...clean,date:update.date,period:update.date.replaceAll('-','').slice(0,6),eliminated:update.eliminated};
 }
 await transaction(async tx=>{await tx.query("UPDATE nota_app.job_steps SET result=$2,updated_at=now() WHERE job_id=$1 AND step_key='sync' AND status<>'COMMITTED'",[jobId,JSON.stringify(plan)]);await tx.query("INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,'SYNC_PREFER_SPREADSHEET',$2)",[user.uid,jobId]);});
}
