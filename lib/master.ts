import {transaction,type Database} from './db';import {invariant} from './errors';import {requireRole,type User} from './identity';import {mutateOnce} from './jobs';
export const masterActions=['GET_MASTER_LINKS','SAVE_MASTER_LINKS','UPSERT_MASTER_BRANCH','DELETE_MASTER_BRANCH'];
function period(value:any){const p=String(value||'').replace('-','');invariant(/^\d{4}(0[1-9]|1[0-2])$/.test(p),'INVALID_PERIOD','Periode tidak valid.');return p;}
function sheet(value:any){const raw=String(value||'').trim(),m=raw.match(/^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,150})(?:\/|$)/);invariant(!raw||m,'INVALID_SHEET','Gunakan URL Google Spreadsheet.');return m?.[1]||'';}
async function revision(db:Database,p:string){return Number((await db.query("SELECT coalesce(max(id),0)::text AS revision FROM nota_app.audit_events WHERE action IN ('SAVE_MASTER_LINKS','UPSERT_MASTER_BRANCH','DELETE_MASTER_BRANCH','BULK_MANAGE_BRANCHES') AND details->>'period'=$1",[p])).rows[0].revision);}
export async function masterAction(user:User,action:string,p:any,key:string){
 requireRole(user,['ADMIN','TAX']);const month=period(p.period);
 return transaction(async db=>{
 if(action==='GET_MASTER_LINKS'){
  const branches=(await db.query('SELECT id,name,type,active FROM nota_app.branches ORDER BY name')).rows;
  const links=Object.fromEntries((await db.query('SELECT branch_id,spreadsheet_id FROM nota_app.master_links WHERE period=$1',[month])).rows.map(r=>[r.branch_id,{url:'https://docs.google.com/spreadsheets/d/'+r.spreadsheet_id+'/edit',spreadsheetId:r.spreadsheet_id}]));return {period:month,branches,links,revision:await revision(db,month)};
 }
 return mutateOnce(db,user,action,key,p,async()=>{
  await db.query('LOCK TABLE nota_app.master_links IN SHARE ROW EXCLUSIVE MODE');
  let result:any={success:true};
  if(action==='SAVE_MASTER_LINKS'){
   invariant(p.expectedRevision==null||Number(p.expectedRevision)===await revision(db,month),'VERSION_CONFLICT','Master Link sudah berubah. Muat ulang sebelum menyimpan.',409);
   invariant(p.links&&typeof p.links==='object'&&!Array.isArray(p.links)&&Object.keys(p.links).length<=1000,'INVALID_LINKS','Daftar tautan tidak valid.');
   for(const [id,entry] of Object.entries(p.links) as [string,any][]){
    invariant((await db.query('SELECT id FROM nota_app.branches WHERE id=$1',[id])).rows.length,'BRANCH_NOT_FOUND','Cabang tidak ditemukan.');
    const target=sheet(entry.url||entry.spreadsheetUrl);if(target)await db.query('INSERT INTO nota_app.master_links(branch_id,period,spreadsheet_id) VALUES($1,$2,$3) ON CONFLICT(branch_id,period) DO UPDATE SET spreadsheet_id=$3',[id,month,target]);else await db.query('DELETE FROM nota_app.master_links WHERE branch_id=$1 AND period=$2',[id,month]);
   }
  }else if(action==='UPSERT_MASTER_BRANCH'){
   const name=String(p.name||'').trim(),type=String(p.type||'Mandiri'),id=String(p.id||name.toUpperCase().replace(/[^A-Z0-9_]/g,'_').replace(/_+/g,'_')).trim();
   invariant(name.length>0&&name.length<=150&&id.length>0&&id.length<=100,'INVALID_BRANCH','Nama atau kode cabang tidak valid.');invariant(['Mandiri','Central Kitchen'].includes(type),'INVALID_TYPE','Pilih tipe cabang yang tersedia.');
   const duplicates=(await db.query('SELECT id FROM nota_app.branches WHERE lower(name)=lower($1) AND id<>$2',[name,id])).rows;invariant(!duplicates.length,'DUPLICATE_BRANCH','Nama cabang sudah terdaftar.');
   const target=sheet(p.url);await db.query('INSERT INTO nota_app.branches(id,name,type,active) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,type=$3,active=$4',[id,name,type,p.active!==false]);
   if(target)await db.query('INSERT INTO nota_app.master_links(branch_id,period,spreadsheet_id) VALUES($1,$2,$3) ON CONFLICT(branch_id,period) DO UPDATE SET spreadsheet_id=$3',[id,month,target]);else await db.query('DELETE FROM nota_app.master_links WHERE branch_id=$1 AND period=$2',[id,month]);result.id=id;
  }else if(action==='DELETE_MASTER_BRANCH'){
   const id=String(p.id||'');invariant((await db.query('SELECT id FROM nota_app.branches WHERE id=$1 FOR UPDATE',[id])).rows.length,'NOT_FOUND','Cabang tidak ditemukan.',404);
   const counts=(await db.query('SELECT (SELECT count(*) FROM nota_app.profiles WHERE branch_id=$1)+(SELECT count(*) FROM nota_app.receipts WHERE branch_id=$1)+(SELECT count(*) FROM nota_app.transactions WHERE branch_id=$1)+(SELECT count(*) FROM nota_app.photos WHERE branch_id=$1)+(SELECT count(*) FROM nota_app.jobs WHERE branch_id=$1)+(SELECT count(*) FROM nota_app.upload_groups WHERE branch_id=$1) AS count',[id])).rows[0];invariant(Number(counts.count)===0,'BRANCH_IN_USE','Cabang masih dipakai akun, nota, atau unggahan. Penghapusan dibatalkan.',409);
   await db.query('DELETE FROM nota_app.master_links WHERE branch_id=$1',[id]);await db.query('DELETE FROM nota_app.branches WHERE id=$1',[id]);
  }
  const audit=(await db.query('INSERT INTO nota_app.audit_events(uid,action,details) VALUES($1,$2,$3) RETURNING id',[user.uid,action,JSON.stringify({period:month,branchId:result.id||p.id||''})])).rows[0];return {...result,revision:Number(audit.id)};
 });
 });
}

