import {transaction,type Database} from './db';
import {requireRole,type User} from './identity';
import {invariant} from './errors';
import {mutateOnce} from './jobs';
export function planBranches(rows:any[],stored:any[],month:string){
 invariant(Array.isArray(rows)&&rows.length>0&&rows.length<=250,'INVALID_ROWS','Unggah 1–250 baris cabang.');
 const working=new Map(stored.map(b=>[b.id,b])),seen=new Set<string>(),changes:any[]=[],errors:any[]=[];
 rows.forEach((r,index)=>{try{
  const suppliedId=String(r.id||'').trim().toUpperCase(),name=String(r.name||r.nama||'').trim(),type=String(r.type||r.tipe||'').trim(),action=String(r.action||'UPSERT').toUpperCase(),id=suppliedId||name.toUpperCase().replace(/[^A-Z0-9_]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
  invariant(['ADD','UPDATE','UPSERT','DELETE'].includes(action),'INVALID_ACTION','Action harus ADD, UPDATE, UPSERT, atau DELETE.');
  invariant(/^[A-Z0-9_]{1,100}$/.test(id)&&!seen.has(id),'INVALID_ID','ID tidak valid atau duplikat dalam file.');seen.add(id);
  const before=working.get(id)||null;
  if(action==='DELETE'){
   invariant(suppliedId&&before,'NOT_FOUND','DELETE wajib memakai ID cabang yang sudah ada.');invariant(Number(before.reference_count||0)===0,'BRANCH_IN_USE','Cabang masih dipakai akun, transaksi, atau unggahan.');
   working.delete(id);changes.push({row:index+2,id,action:'DELETE',before,after:null,changedFields:['deleted']});return;
  }
  invariant(action!=='ADD'||!before,'ALREADY_EXISTS','ID sudah ada; gunakan UPDATE.');invariant(action!=='UPDATE'||suppliedId&&before,'NOT_FOUND','UPDATE wajib memakai ID yang sudah ada.');invariant(action!=='UPSERT'||!before||suppliedId,'ID_REQUIRED','UPSERT cabang lama wajib memakai ID.');
  const after={...before,id,name:name||before?.name,type:type||before?.type,active:before?.active!==false};
  invariant(after.name&&after.name.length<=150&&['Mandiri','Central Kitchen'].includes(after.type),'INVALID_BRANCH','Nama dan tipe Mandiri/Central Kitchen wajib diisi.');
  invariant(![...working.values()].some(b=>b.id!==id&&b.name.toUpperCase()===after.name.toUpperCase()),'DUPLICATE_NAME','Nama cabang sudah dipakai ID lain.');
  const changedFields=['name','type'].filter(k=>!before||before[k]!==after[k]);changes.push({row:index+2,id,action:before?changedFields.length?'UPDATE':'NO_CHANGE':'ADD',before,after,changedFields});working.set(id,after);
 }catch(e){errors.push({row:index+2,error:e instanceof Error?e.message:'Baris tidak valid.'});}});
 return {period:month,changes,errors,summary:{add:changes.filter(c=>c.action==='ADD').length,update:changes.filter(c=>c.action==='UPDATE').length,remove:changes.filter(c=>c.action==='DELETE').length,unchanged:changes.filter(c=>c.action==='NO_CHANGE').length}};
}
async function storedBranches(db:Database){return (await db.query(`SELECT b.*,(SELECT count(*) FROM nota_app.profiles WHERE branch_id=b.id)+(SELECT count(*) FROM nota_app.receipts WHERE branch_id=b.id)+(SELECT count(*) FROM nota_app.transactions WHERE branch_id=b.id)+(SELECT count(*) FROM nota_app.photos WHERE branch_id=b.id)+(SELECT count(*) FROM nota_app.jobs WHERE branch_id=b.id)+(SELECT count(*) FROM nota_app.upload_groups WHERE branch_id=b.id) AS reference_count FROM nota_app.branches b ORDER BY id`)).rows;}
export async function bulkBranches(user:User,action:string,p:any,key:string){
 requireRole(user,['ADMIN','TAX']);const month=String(p.period||'').replace('-','');invariant(/^\d{4}(0[1-9]|1[0-2])$/.test(month),'INVALID_PERIOD','Periode tidak valid.');
 return transaction(async db=>{
  if(action==='PREVIEW_BULK_MANAGE_BRANCHES')return planBranches(p.rows,await storedBranches(db),month);
  return mutateOnce(db,user,action,key,p,async()=>{
   await db.query('LOCK TABLE nota_app.master_links IN SHARE ROW EXCLUSIVE MODE');await db.query('LOCK TABLE nota_app.branches IN SHARE ROW EXCLUSIVE MODE');
   const plan=planBranches(p.rows,await storedBranches(db),month);invariant(!plan.errors.length,'INVALID_ROWS',plan.errors.map(e=>'Baris '+e.row+': '+e.error).join(' | '));
   for(const c of plan.changes){
    if(c.action==='DELETE'){await db.query('DELETE FROM nota_app.master_links WHERE branch_id=$1',[c.id]);await db.query('DELETE FROM nota_app.branches WHERE id=$1',[c.id]);}
    else if(c.action!=='NO_CHANGE')await db.query('INSERT INTO nota_app.branches(id,name,type,active) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,type=$3',[c.id,c.after.name,c.after.type,c.after.active]);
   }
   await db.query("INSERT INTO nota_app.audit_events(uid,action,details) VALUES($1,'BULK_MANAGE_BRANCHES',$2)",[user.uid,JSON.stringify({period:month,summary:plan.summary})]);return {results:plan.changes.map(c=>({row:c.row,success:true,action:c.action,id:c.id,changedFields:c.changedFields})),summary:plan.summary};
  });
 });
}

