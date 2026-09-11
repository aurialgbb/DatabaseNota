import { randomUUID } from 'node:crypto';
import { type Database } from './db';
import { invariant } from './errors';
import { type User,requireRole } from './identity';
import { mutateOnce } from './jobs';
const upper=(x:any)=>String(x??'').trim().toUpperCase();
function money(x:any){const n=Number(x);invariant(Number.isFinite(n)&&n>=0&&n<=1e14,'INVALID_AMOUNT','Nominal tidak valid.');return n;}
function when(x:any){let s=String(x||'');if(typeof x==='number'){invariant(Number.isFinite(x),'INVALID_DATE','Tanggal tidak valid.');s=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x));}invariant(/^\d{4}-\d{2}-\d{2}$/.test(s),'INVALID_DATE','Tanggal wajib diisi.');const d=new Date(s+'T00:00:00+07:00');invariant(Number.isFinite(d.getTime())&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)===s,'INVALID_DATE','Tanggal tidak valid.');return {date:s,time:d.getTime()};}
export function legacyRow(row:any){const d=row.data;return row.kind==='OCR'?[row.id,d.timestamp,d.tanggalNota,d.cabang,d.cv,d.supplier,d.name,d.qty,Number(row.amount),d.fotoUrl,d.unit,d.statusPosting||'',row.version]:[row.id,d.timestamp,d.tanggal,d.cabang,d.cv,Number(row.amount),d.fotoUrl,d.kategori,d.keterangan,d.noUrut,d.jenis,d.jumlah,row.version,!!d.readOnly,d.sourceReceiptId||''];}
async function branch(db:Database,toko:any){const r=(await db.query('SELECT * FROM nota_app.branches WHERE upper(name)=$1 AND active=true',[upper(toko)])).rows;invariant(r.length===1,'BRANCH_REQUIRED','Pilih cabang aktif dari Master Link.');return r[0];}
async function photo(db:Database,user:User,id:any,branchId:string){
 if(!id)return '-';
 const row=(await db.query("SELECT * FROM nota_app.photos WHERE id=$1 AND state='READY'",[id])).rows[0];
 invariant(row&&row.owner_uid===user.uid&&(!row.branch_id||row.branch_id===branchId),'PHOTO_NOT_READY','Foto belum siap atau bukan milik akun ini.');return (process.env.APP_ORIGIN||'')+'/api/photos/'+row.id;
}
async function record(db:Database,id:string,kind?:string,expected?:number,allowReadOnly=false){const row=(await db.query('SELECT * FROM nota_app.transactions WHERE id=$1 FOR UPDATE',[id])).rows[0];invariant(!(await db.query('SELECT resource FROM nota_app.resource_leases WHERE resource=$1 AND expires_at>now()',['transaction/'+id])).rows.length,'SYNC_BUSY','Transaksi sedang disinkronkan. Selesaikan pekerjaan tersebut terlebih dahulu.',409);invariant(row&&(!kind||row.kind===kind),'NOT_FOUND','Transaksi tidak ditemukan.',404);invariant(allowReadOnly||!row.data?.readOnly,'APPROVED_RECEIPT_LOCKED','Data hasil ACC terkunci dan tidak dapat diubah atau dihapus dari daftar transaksi.',409);if(expected!==undefined)invariant(row.version===Number(expected),'VERSION_CONFLICT','Data sudah berubah. Muat ulang sebelum mengubahnya.',409);return row;}
async function insert(db:Database,kind:string,branchId:string,date:string,data:any){await db.query('INSERT INTO nota_app.transactions(id,kind,branch_id,business_date,amount,data) VALUES($1,$2,$3,$4,$5,$6)',[data.id,kind,branchId,date,kind==='OCR'?data.total:data.nominal,JSON.stringify(data)]);return legacyRow({id:data.id,kind,data,amount:kind==='OCR'?data.total:data.nominal,version:1});}
export async function legacyPage(db:Database,history:boolean,opts:any={}){
 const page=Math.max(1,Math.floor(Number(opts.page)||1)),limit=Math.min(5000,Math.max(1,Math.floor(Number(opts.limit)|| (history?25:50))));
 const filters=opts.filters||{},type=String(opts.type||filters.type||'all').toLowerCase();
 const values:any[]=[],clauses=[history?"t.kind='OCR'":"t.kind IN ('LISTRIK','UMUM')"];
 function condition(sql:string,value:any){values.push(value);clauses.push(sql.replace('?', '$'+values.length));}
 if(!history&&['listrik','umum'].includes(type))condition('t.kind=?',type.toUpperCase());
 if(filters.cabang)condition("lower(t.data->>'cabang')=lower(?)",String(filters.cabang));
 if(filters.search)condition("strpos(lower(concat_ws(' ',t.data->>'cabang',t.data->>'cv',t.data->>'supplier',t.data->>'name',t.data->>'keterangan',t.data->>'jenis',t.data->>'jumlah')),lower(?))>0",String(filters.search));
 for(const [key,op] of [['startTime','>='],['endTime','<=']])if(filters[key]){const n=Number(filters[key]);invariant(Number.isFinite(n),'INVALID_DATE','Filter tanggal tidak valid.');condition(`(t.data->>'${history?'tanggalNota':'tanggal'}')::bigint ${op} ?`,n);}
 const where=clauses.join(' AND ');
 const totals=(await db.query('SELECT count(*)::int AS total,coalesce(sum(amount),0)::text AS amount FROM nota_app.transactions t WHERE '+where,values)).rows[0];
 const cols=history?['t.id','t.created_at','t.business_date',"t.data->>'cabang'","t.data->>'cv'","t.data->>'supplier'","t.data->>'name'","(t.data->>'qty')::numeric",'t.amount',"t.data->>'fotoUrl'","t.data->>'unit'","t.data->>'statusPosting'"]:['t.id','t.created_at','t.business_date',"t.data->>'cabang'","t.data->>'cv'",'t.amount',"t.data->>'fotoUrl'","t.data->>'kategori'","t.data->>'keterangan'","t.data->>'noUrut'","t.data->>'jenis'","t.data->>'jumlah'"];
 const col=cols[Number(opts.sort?.col)]|| (history?'t.created_at':'t.business_date'),direction=opts.sort?.asc===true?'ASC':'DESC';
 const rows=(await db.query(`SELECT t.* FROM nota_app.transactions t WHERE ${where} ORDER BY ${col} ${direction},t.id ${direction} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit,(page-1)*limit])).rows.map(legacyRow);
 return {rows,history:rows,total:totals.total,totalAmount:Number(totals.amount),page,limit,type};
}
export async function legacyRead(db:Database,user:User,action:string,args:any[]){
 requireRole(user,['ADMIN','TAX']);
 if(action==='getBootstrapData'){
  const branches=(await db.query('SELECT id,name,type,data FROM nota_app.branches WHERE active=true ORDER BY name')).rows.map(b=>({id:b.id,toko:b.name,name:b.name,cv:b.data.cv||'',type:b.type}));
  return {branches,jenisPengeluaran:(await db.query('SELECT name FROM nota_app.categories ORDER BY position,name')).rows.map(r=>r.name),cabangCentralKitchen:branches.filter(b=>b.type==='Central Kitchen').map(b=>b.name)};
 }
 if(action==='getHistoryPage')return legacyPage(db,true,args[0]);
 if(action==='getExpensePage')return legacyPage(db,false,args[0]);
 if(action==='getExpenseDailyMatrix'){
  const input=args[0]||{},month=String(input.month||''),type=String(input.type||'umum').toUpperCase();
  invariant(/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'INVALID_PERIOD','Bulan transaksi tidak valid.');
  invariant(['UMUM','LISTRIK'].includes(type),'INVALID_KIND','Jenis bank nota tidak valid.');
  const page=Math.max(1,Math.floor(Number(input.page)||1)),limit=Math.min(50,Math.max(10,Math.floor(Number(input.limit)||25))),search=String(input.search||'').trim().slice(0,150);
  const branchValues:any[]=[];let branchWhere='active=true';
  if(search){branchValues.push(search);branchWhere+=" AND strpos(lower(concat_ws(' ',name,id)),lower($1))>0";}
  const totalBranches=Number((await db.query('SELECT count(*)::int AS count FROM nota_app.branches WHERE '+branchWhere,branchValues)).rows[0].count);
  const virtual=input.view==='virtual';
  const branchIndex=virtual?(await db.query('SELECT id,name,type FROM nota_app.branches WHERE '+branchWhere+' ORDER BY name,id',branchValues)).rows:[];
  const branches=virtual?branchIndex.slice((page-1)*limit,page*limit):(await db.query('SELECT id,name,type FROM nota_app.branches WHERE '+branchWhere+' ORDER BY name,id LIMIT $'+(branchValues.length+1)+' OFFSET $'+(branchValues.length+2),[...branchValues,limit,(page-1)*limit])).rows;
  const cells:Record<string,any>={};for(const branch of branches)cells[branch.id]={};
  if(branches.length){
   const rows=(await db.query("SELECT t.*,extract(day FROM t.business_date)::int AS day FROM nota_app.transactions t WHERE t.kind=$1 AND t.business_date >= $2::date AND t.business_date < ($2::date + interval '1 month') AND t.branch_id=ANY($3::text[]) ORDER BY t.business_date,t.id",[type,month+'-01',branches.map(b=>b.id)])).rows;
   for(const row of rows){const day=Number(row.day),cell=cells[row.branch_id][day]||(cells[row.branch_id][day]={count:0,total:0,records:[]});cell.count++;cell.total+=Number(row.amount);cell.records.push(legacyRow(row));}
  }
  return {month,type:type.toLowerCase(),page,limit,totalBranches,days:new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate(),branches,cells,...(virtual?{branchIndex}:{})};
 }
 if(action==='getExpenseSummaryByBranchMonth'){
  const year=Number(args[0])||new Date().getFullYear();invariant(Number.isInteger(year)&&year>=2000&&year<=2200,'INVALID_YEAR','Tahun tidak valid.');
  const branches=(await db.query('SELECT name FROM nota_app.branches WHERE active=true ORDER BY name')).rows.map(r=>upper(r.name));
  const summary:Record<string,any>={};branches.forEach(b=>summary[b]={});
  const rows=(await db.query("SELECT * FROM nota_app.transactions WHERE kind='LISTRIK' AND business_date >= $1::date AND business_date < $2::date ORDER BY business_date,id",[year+'-01-01',(year+1)+'-01-01'])).rows;
  for(const r of rows){const name=r.data.cabang,month=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',month:'numeric'}).format(new Date(r.data.tanggal)))-1;summary[name]||={};summary[name][month]||={count:0,total:0,records:[]};summary[name][month].count++;summary[name][month].total+=Number(r.amount);summary[name][month].records.push(legacyRow(r));}
  return {year,branches:Array.from(new Set([...branches,...Object.keys(summary)])).sort(),summary};
 }
}
export async function legacyMutate(db:Database,user:User,action:string,args:any[],key:string){
 requireRole(user,['ADMIN','TAX']);
 return mutateOnce(db,user,action,key,args,async()=>{
 let result:any;
 if(action==='saveTransactions'){
  const p=args[0]||{},b=await branch(db,p.toko),date=when(p.tanggal);invariant(Array.isArray(p.items)&&p.items.length>0&&p.items.length<=100,'INVALID_ITEMS','Isi 1–100 item.');
  const photos=await Promise.all((p.photoIds||[]).map((id:string)=>photo(db,user,id,b.id)));const rows=[];
  for(const item of p.items){invariant(upper(item.name),'ITEM_REQUIRED','Nama item wajib diisi.');const data={id:'TRX-'+randomUUID(),timestamp:Date.now(),tanggalNota:date.time,cabang:upper(b.name),cv:upper(p.cv),supplier:upper(item.toko||p.supplier),name:upper(item.name),qty:money(item.qty),total:money(item.total),fotoUrl:photos[item.base64Index||0]||'-',unit:upper(item.unit),statusPosting:''};rows.push(await insert(db,'OCR',b.id,date.date,data));}result=rows;
 }else if(action==='saveListrikTransaction'){
  const p=args[0]||{},b=await branch(db,p.toko),date=when(p.tanggal),kind=p.kategori==='Umum'?'UMUM':'LISTRIK';
  const data={id:(kind==='UMUM'?'UMM-':'LST-')+randomUUID(),timestamp:Date.now(),tanggal:date.time,cabang:upper(b.name),cv:upper(p.cv),nominal:money(p.nominal),fotoUrl:await photo(db,user,p.photoId,b.id),kategori:kind==='UMUM'?'Umum':'Listrik',keterangan:String(p.keterangan||'-'),noUrut:String(p.noUrut||''),jenis:upper(p.jenis||kind),jumlah:String(p.jumlah||'-')};
  result=await insert(db,kind,b.id,date.date,data);
 }else if(action==='updateTransaction'||action==='updateListrikTransaction'){
  const [id,p]=args,row=await record(db,String(id),action==='updateTransaction'?'OCR':undefined,p.expectedVersion);
  invariant(action==='updateTransaction'||['LISTRIK','UMUM'].includes(row.kind),'INVALID_KIND','Jenis transaksi tidak sesuai.');
  const date=when(p.tanggal||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(row.data.tanggalNota||row.data.tanggal)));
  let data,branchId=row.branch_id,kind=row.kind;
  if(row.kind==='OCR')data={...row.data,tanggalNota:date.time,supplier:upper(p.supplier),name:upper(p.name),qty:money(p.qty),total:money(p.total),unit:upper(p.unit)};
  else {const b=await branch(db,p.toko);branchId=b.id;kind=p.kategori==='Umum'?'UMUM':'LISTRIK';data={...row.data,tanggal:date.time,cabang:upper(b.name),cv:upper(p.cv),nominal:money(p.nominal),kategori:kind==='UMUM'?'Umum':'Listrik',keterangan:p.keterangan||'-',jenis:upper(p.jenis||row.data.jenis),jumlah:String(p.jumlah||row.data.jumlah),fotoUrl:p.photoId?await photo(db,user,p.photoId,b.id):row.data.fotoUrl};}
  await db.query('UPDATE nota_app.transactions SET kind=$2,branch_id=$3,business_date=$4,amount=$5,data=$6,version=version+1,updated_at=now() WHERE id=$1',[id,kind,branchId,date.date,kind==='OCR'?data.total:data.nominal,JSON.stringify(data)]);
  result=kind==='OCR'?true:{id,tanggal:data.tanggal,toko:data.cabang,cv:data.cv,nominal:data.nominal,url:data.fotoUrl,kategori:data.kategori,keterangan:data.keterangan};
 }else if(['deleteTransaction','deleteListrikTransaction','bulkDeleteListrikTransaction'].includes(action)){
  const ids=action==='bulkDeleteListrikTransaction'?args[0]:[args[0]];invariant(Array.isArray(ids)&&ids.length>0&&ids.length<=500,'INVALID_IDS','Pilih 1–500 transaksi.');
  const allowReadOnly=user.role==='ADMIN';
  for(const id of [...new Set(ids)].sort()){
   const row=await record(db,String(id),undefined,undefined,allowReadOnly);
   invariant(action==='deleteTransaction'?row.kind==='OCR':['LISTRIK','UMUM'].includes(row.kind),'INVALID_KIND','Jenis transaksi tidak sesuai.');
   const sourceReceiptId=row.data?.sourceReceiptId;
   if(sourceReceiptId&&user.role==='ADMIN'){
    await db.query("UPDATE nota_app.receipts SET status='PENDING',data=jsonb_set(coalesce(data,'{}'::jsonb),'{approvedAt}','null'),version=version+1,updated_at=now() WHERE id=$1",[sourceReceiptId]);
    await db.query("DELETE FROM nota_app.transactions WHERE id=$1 OR data->>'sourceReceiptId'=$2",[id,sourceReceiptId]);
   }else{
    await db.query('DELETE FROM nota_app.transactions WHERE id=$1',[id]);
   }
  }
  result=action==='bulkDeleteListrikTransaction'?{success:true,deletedCount:ids.length}:true;
 }else if(action==='duplicateToKategori'){
  const row=await record(db,String(args[0]),'OCR'),target=args[1];invariant(['Umum','Listrik'].includes(target),'INVALID_KIND','Kategori tidak valid.');invariant(!row.data.statusPosting,'ALREADY_POSTED','Data sudah pernah diposting.',409);
  const d=row.data,kind=target==='Umum'?'UMUM':'LISTRIK',data={id:(kind==='UMUM'?'UMM-':'LST-')+randomUUID(),timestamp:Date.now(),tanggal:d.tanggalNota,cabang:d.cabang,cv:d.cv,nominal:d.total,fotoUrl:d.fotoUrl,kategori:target,keterangan:kind==='UMUM'?d.name+(d.qty>1?` (${d.qty} ${d.unit})`:''):'-',noUrut:'',jenis:kind==='UMUM'?d.name:'LISTRIK',jumlah:kind==='UMUM'?`${d.qty} ${d.unit||'PCS'}`:'-'};
  await insert(db,kind,row.branch_id,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d.tanggalNota)),data);
  await db.query("UPDATE nota_app.transactions SET data=jsonb_set(data,'{statusPosting}',$2::jsonb),version=version+1,updated_at=now() WHERE id=$1",[row.id,JSON.stringify(target)]);result=target;
 }else invariant(false,'UNKNOWN_ACTION','Tindakan transaksi tidak dikenali.');
 await db.query('INSERT INTO nota_app.audit_events(uid,action,details) VALUES($1,$2,$3)',[user.uid,action,JSON.stringify({ids:args[0]?.id|| (typeof args[0]==='string'?args[0]:undefined)})]);return result;
 });
}

