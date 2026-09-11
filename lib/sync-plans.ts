import {randomUUID} from 'node:crypto';
import {database} from './db';
import {readModel,targetFor,isoDay,padded,valuesOf,type Model,type Target} from './sync-model';
import {quoteTab} from './sheets';
import {invariant,AppError} from './errors';
import {payloadHash,stableJson,type User} from './identity';
import {receiptDetail,categories} from './receipts';
import {type Plan,type Edit} from './sync-engine';
import {portalValidateReceiptPayload_} from '../generated/receipt-domain.mjs';
const same=(a:any,b:any)=>stableJson(a)===stableJson(b);
function blankPlan(t:Target):Plan{return {edits:[],receipts:[],expenses:[],resources:['sheet/'+t.fileId],branchName:t.branchName,period:t.period,createdAt:Date.now()};}
function rowId(model:Model,index:number){return (model.tags[index]||[]).find(t=>t.metadataKey==='NOTA_ROW_ID')?.metadataValue||randomUUID();}
function makeEdit(model:Model,index:number,after:any[],mapping:any,startColumn=3):Edit{
 const id=rowId(model,index);return {target:model.target,sheetId:model.sheetId,rowIndex:index,startColumn,before:padded(model.values[index-1],startColumn+after.length).slice(startColumn),after,rowId:id,mapping:mapping?{...mapping,snapshot:{...mapping.snapshot,rowId:id}}:undefined};
}
function freeRow(model:Model,date:string,used:Set<number>){
 const result=model.values.findIndex((values,i)=>{
  if(i<4||used.has(i+1)||isoDay(values[1],model.target.period)!==date||!(Number(values[2])>0))return false;
  const data=values.slice(3,model.width-1),tags=model.tags[i+1]||[];
  return !data.some(v=>v!==''&&v!==null)&&!/^YA$/i.test(String(values[model.width-1]))&&!padded(model.formulas[i],model.width).slice(3).some(v=>String(v).startsWith('='))&&!tags.some(t=>/^PORTAL_|NOTA_CK_OWNER|NOTA_ROW_ID/.test(t.metadataKey));
 });invariant(result>=0,'SHEET_FULL','Baris kosong pada tanggal '+date+' tidak cukup. Belum ada data ditulis.',409);used.add(result+1);return result+1;
}
function normalizedItem(item:any,t:Target,names:string[]){
 const date=isoDay(item.tanggal,t.period);invariant(date,'INVALID_DATE','Tanggal di luar periode yang dipilih.');const amount=Number(item.nominal),name=String(item.keterangan||'').trim(),category=String(item.jenis||'').trim().toUpperCase(),branch=t.type==='Mandiri'?t.branchName:String(item.cabang||'').trim().toUpperCase();
 invariant(name&&name.length<=250&&names.includes(category),'INVALID_ITEM','Keterangan atau jenis pengeluaran belum valid.');invariant(Number.isFinite(amount)&&amount>0&&amount<=1e12,'INVALID_AMOUNT','Nominal harus lebih besar dari nol.');
 const eliminated=String(item.eliminasi||'TIDAK').toUpperCase();invariant(['YA','TIDAK',''].includes(eliminated),'INVALID_ELIMINATION','Pilihan eliminasi tidak valid.');return {...item,tanggal:date.slice(8)+'-'+date.slice(5,7)+'-'+date.slice(0,4),isoDate:date,cabang:branch,keterangan:name,jenis:category,jumlah:String(item.jumlah||''),nominal:amount,eliminasi:eliminated};
}
function cellsOf(row:any,t:Target){const cells=[row.keterangan,row.jenis,row.jumlah,row.nominal,row.eliminasi];return t.type==='Central Kitchen'?[row.cabang,...cells]:cells;}
async function photoFor(user:User,id:any){if(!id)return '';const p=(await database().query("SELECT * FROM nota_app.photos WHERE id=$1 AND state='READY' AND owner_uid=$2",[id,user.uid])).rows[0];invariant(p,'PHOTO_NOT_READY','Foto belum siap atau bukan milik akun ini.');return (process.env.APP_ORIGIN||'')+'/api/photos/'+p.id;}
async function addDistribution(plan:Plan,model:Model){
 if(model.target.type!=='Central Kitchen')return;
 const after=model.values.map(v=>v.slice());for(const e of plan.edits.filter(e=>e.target.fileId===model.target.fileId&&e.sheetId===model.sheetId))after[e.rowIndex-1].splice(e.startColumn,e.after.length,...e.after);
 const links=await valuesOf(model.target.fileId,quoteTab(model.target.linkSheetName)+'!C3:E'),linkMap=new Map<string,string>();
 for(const link of links){if(!link[0]||!link[2])continue;const name=String(link[0]).trim().toUpperCase(),url=String(link[2]);invariant(!linkMap.has(name)||linkMap.get(name)===url,'CK_LINK_CONFLICT','LINK SHEET memiliki tujuan ganda untuk '+name);linkMap.set(name,url);}
 const previous=(await database().query("SELECT * FROM nota_app.sheet_mappings WHERE snapshot->>'ckSource'=$1 AND snapshot->>'ckSheet'=$2",[model.target.fileId,String(model.sheetId)])).rows;
 const groups=new Map<string,{target:Target;day:number;rows:any[][];owner:string}>();
 for(let i=0;i<after.length;i++){
  const v=after[i],date=isoDay(v[1],model.target.period),name=String(v[3]||'').trim().toUpperCase();if(!date||!name||!v[4])continue;
  invariant(linkMap.has(name),'CK_LINK_MISSING','Tujuan distribusi CK belum tersedia untuk '+name);const dest=await targetFor({period:model.target.period,cabang:name,link:linkMap.get(name)});invariant(dest.type==='Mandiri','CK_TARGET_TYPE','Tujuan distribusi harus cabang Mandiri.');
  const day=Number(date.slice(8)),owner=[model.target.fileId,model.sheetId,dest.branchId,dest.fileId,dest.sheetName,day].join('|');if(!groups.has(owner))groups.set(owner,{target:dest,day,rows:[],owner});groups.get(owner)!.rows.push([v[1],v[2],v[4],v[5],v[6],v[7],v[8]]);
 }
 for(const m of previous){const s=m.snapshot;if(s.owner&&!groups.has(s.owner))groups.set(s.owner,{target:s.target,day:s.day,rows:[],owner:s.owner});}
 const cache=new Map<string,Model>();
 for(const g of groups.values()){
  invariant(g.rows.length<=24,'CK_CAPACITY','Distribusi CK melebihi 24 baris pada '+g.target.branchName+', tanggal '+g.day+'.');const key=g.target.fileId+'|'+g.target.sheetName;if(!cache.has(key))cache.set(key,await readModel(g.target));const dest=cache.get(key)!;plan.resources.push('sheet/'+g.target.fileId);
  for(let i=0;i<24;i++){
   const index=6+(g.day-1)*30+i,before=padded(dest.values[index-1],8).slice(1),tags=dest.tags[index]||[],ownerTag=tags.find(t=>t.metadataKey==='NOTA_CK_OWNER');
   const old=previous.find(m=>m.snapshot.owner===g.owner&&m.row_index===index&&m.spreadsheet_id===g.target.fileId&&Number(m.sheet_id)===dest.sheetId),empty=!before.slice(2,6).some(v=>v!==''&&v!==null)&&String(before[6]).toUpperCase()!=='YA';
   invariant((empty&&!ownerTag&&!tags.some(t=>/^PORTAL_/.test(t.metadataKey)))||(ownerTag?.metadataValue===g.owner&&old&&same(old.snapshot.cells,before)),'CK_OWNERSHIP_CONFLICT','Baris distribusi '+g.target.branchName+' tanggal '+g.day+' sudah berisi data yang bukan milik pekerjaan ini.',409);
   const after=g.rows[i]||[g.day,before[1]||i+1,'','','','',''];const itemId='CK-'+payloadHash([g.owner,i]);const edit=makeEdit(dest,index,after,{itemId,snapshot:{ckSource:model.target.fileId,ckSheet:String(model.sheetId),target:g.target,day:g.day,date:isoDay(g.day,g.target.period),owner:g.owner}},1);edit.owner=g.owner;plan.edits.push(edit);
  }
 }
}
export async function approvalPlan(user:User,decision:any):Promise<Plan>{
 const receipt=await receiptDetail(database(),user,String(decision.receiptId));invariant(receipt.status==='PENDING'&&receipt.version===Number(decision.expectedVersion),'VERSION_CONFLICT','Nota sudah berubah atau tidak lagi Pending.',409);
 const action=String(decision.decision).toUpperCase(),t=action==='APPROVE'?await targetFor({branchId:receipt.branchId,period:receipt.date.replaceAll('-','').slice(0,6)}):{fileId:'',branchName:receipt.branchName,period:receipt.date.replaceAll('-','').slice(0,6)} as Target;
 const plan=blankPlan(t);plan.resources=action==='APPROVE'?plan.resources:[];plan.resources.push('receipt/'+receipt.id);
 const status=action==='APPROVE'?'APPROVED':action==='DISCARD'?'REJECTED':'NEEDS_CORRECTION';
 plan.receipts.push({id:receipt.id,expectedVersion:receipt.version,status,supplier:receipt.supplier,date:receipt.date,receiptTotal:receipt.receiptTotal,eliminated:receipt.eliminated,data:{...receipt,review:{decision:action,reason:String(decision.reason||''),reviewedAt:Date.now(),reviewedBy:user.uid},approvedAt:action==='APPROVE'?Date.now():undefined}});
 if(action==='APPROVE'){
  const model=await readModel(t),used=new Set<number>();for(const item of receipt.items){const index=freeRow(model,receipt.date,used),after=[item.description,item.category,String(item.quantity)+(item.unit?' '+item.unit:''),Number(item.amount),receipt.eliminated?'YA':'TIDAK'];
   const edit=makeEdit(model,index,t.type==='Central Kitchen'?[String(item.distributionBranch||'').toUpperCase(),...after]:after,{itemId:item.id,receiptId:receipt.id,snapshot:{date:receipt.date,fotoUrl:receipt.photoId?(process.env.APP_ORIGIN||'')+'/api/photos/'+receipt.photoId:''}});plan.edits.push(edit);
  }await addDistribution(plan,model);
 }return plan;
}
export async function mutationPlan(user:User,p:any):Promise<Plan>{
 const t=await targetFor(p),model=await readModel(t),plan=blankPlan(t),names=(await categories(database())).map(c=>c.name),selected=new Map<string,{old:any;next:any}>();
 for(const [items,remove] of [[p.editedItems||[],false],[p.photoItemsExisting||[],false],[p.deletedItems||[],true]] as [any[],boolean][]){invariant(Array.isArray(items)&&items.length<=500,'INVALID_ITEMS','Maksimal 500 perubahan per pekerjaan.');for(const item of items){
  const old=model.rows.find(r=>r.sheetRowIndex===Number(item.sheetRowIndex));invariant(old&&old.rowId===item.rowId&&old.version===item.version,'SHEET_CONFLICT','Identitas atau versi baris berubah. Muat ulang data.',409);invariant(!old.ownershipConflict&&!old.distributionSource,'ROW_PROTECTED','Ubah salinan distribusi melalui CK asal atau selesaikan konflik kepemilikan.',409);
  const base=selected.get(old.rowId)?.next||old;const next=remove?null:{...base,...Object.fromEntries(['keterangan','jenis','jumlah','nominal','eliminasi','cabang','photoId','removePhoto'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]]))};selected.set(old.rowId,{old,next});
 }}
 for(const change of [...selected.values()])if(change.old.receiptId&&(!change.next||change.next.eliminasi!==change.old.eliminasi)){
  const scope=model.rows.filter(r=>r.receiptId===change.old.receiptId),confirmation=(p.confirmedReceipts||[]).find((r:any)=>r.receiptId===change.old.receiptId);invariant(confirmation&&Number(confirmation.version)===change.old.receiptVersion&&same([...(confirmation.itemIds||[])].sort(),scope.map(r=>r.itemId).sort()),'RECEIPT_CONFIRMATION_REQUIRED','Konfirmasikan seluruh item nota sebelum hapus atau eliminasi.');
  for(const old of scope)selected.set(old.rowId,{old,next:change.next?{...(selected.get(old.rowId)?.next||old),eliminasi:change.next.eliminasi}:null});
 }
 const changes=[...selected.values()] as {old:any;next:any;index?:number}[],used=new Set(model.rows.map(r=>r.sheetRowIndex));
 invariant(Array.isArray(p.newItems||[])&&(p.newItems||[]).length<=100,'INVALID_ITEMS','Maksimal 100 baris baru.');
 for(const item of p.newItems||[]){const next=normalizedItem(item,t,names);changes.push({old:null,next,index:freeRow(model,next.isoDate,used)});}
 invariant(changes.length>0,'NO_CHANGES','Belum ada perubahan yang dikirim.');const receiptChanges=new Map<string,any[]>();
 for(const change of changes){
  const old=change.old,next=change.next?normalizedItem(change.next,t,names):null,index=old?.sheetRowIndex||change.index!;
  let fotoUrl=next?.removePhoto?'':old?.fotoUrl||'';if(next?.photoId)fotoUrl=await photoFor(user,next.photoId);
  const mapping=model.mappings.find(m=>m.snapshot.rowId===old?.rowId),itemId=old?.itemId||mapping?.item_id||'ROW-'+randomUUID();
  const edit=makeEdit(model,index,next?cellsOf(next,t):Array(model.width-3).fill(''),next?{itemId,receiptId:old?.receiptId||null,snapshot:{date:next.isoDate,fotoUrl}}:undefined);
  if(!next&&mapping)edit.removeMapping=mapping.item_id;
  if(old?.receiptId){plan.resources.push('receipt/'+old.receiptId);if(!receiptChanges.has(old.receiptId))receiptChanges.set(old.receiptId,[]);receiptChanges.get(old.receiptId)!.push({old,next,fotoUrl});}
  else {
   const id=old?.expenseId||'UMM-'+randomUUID(),before=old?.expenseId?(await database().query('SELECT * FROM nota_app.transactions WHERE id=$1',[id])).rows[0]:null;
   if(next){const data={...(before?.data||{}),id,timestamp:before?.data?.timestamp||Date.now(),tanggal:new Date(next.isoDate+'T00:00:00+07:00').getTime(),cabang:next.cabang,cv:before?.data?.cv||'-',nominal:next.nominal,fotoUrl,kategori:'Umum',keterangan:next.keterangan,jenis:next.jenis,jumlah:next.jumlah,noUrut:String(model.values[index-1]?.[2]||''),eliminasi:next.eliminasi,rowId:edit.rowId};plan.expenses.push({id,expectedVersion:before?.version??null,branchId:t.branchId,date:next.isoDate,data});edit.mapping.snapshot.expenseId=id;}
   else if(before)plan.expenses.push({id,expectedVersion:before.version,remove:true});
   if(before)plan.resources.push('transaction/'+id);
  }
  plan.edits.push(edit);
 }
 for(const [id,changes] of receiptChanges){
  const receipt=await receiptDetail(database(),user,id);invariant(receipt.status==='APPROVED'&&receipt.version===changes[0].old.receiptVersion,'RECEIPT_CONFLICT','Nota berubah saat data dimuat.',409);
  const deleted=changes.every(c=>!c.next),items=receipt.items.map((item:any)=>{const c=changes.find(c=>c.old.itemId===item.id);if(!c?.next)return item;const match=c.next.jumlah.match(/^([\d.,]+)\s*(.*)$/);return {...item,description:c.next.keterangan,category:c.next.jenis,quantity:match?Number(match[1].replace(',','.')):item.quantity,unit:match?match[2]:item.unit,amount:c.next.nominal,grossAmount:c.next.nominal+Number(item.discountAllocated||0),distributionBranch:c.next.cabang};});
  let clean:any;try{clean=portalValidateReceiptPayload_({...receipt,items},names);}catch(e){throw new AppError('INVALID_RECEIPT',e instanceof Error?e.message:'Nota tidak valid.');}
  const photoIds=[...new Set(changes.map(c=>c.next?.photoId).filter(Boolean))];invariant(photoIds.length<=1,'PHOTO_CONFLICT','Gunakan satu foto pengganti untuk seluruh nota.');const photoId=photoIds[0]||receipt.photoId,eliminated=changes.some(c=>c.next?.eliminasi==='YA')||(changes.every(c=>c.next?.eliminasi!=='TIDAK')&&receipt.eliminated);
  plan.receipts.push({id,expectedVersion:receipt.version,status:deleted?'REJECTED':'APPROVED',supplier:receipt.supplier,date:receipt.date,receiptTotal:clean.receiptTotal,eliminated,data:{...receipt,...clean,photoId,eliminated,review:deleted?{decision:'DISCARD',reviewedAt:Date.now(),reviewedBy:user.uid}:receipt.review},items:clean.items,photoId:photoIds[0]});
 }
 await addDistribution(plan,model);return plan;
}

