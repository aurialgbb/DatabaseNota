import {database,type Database} from './db';
import {sheetsRequest,quoteTab} from './sheets';
import {invariant} from './errors';
import {payloadHash} from './identity';
export type Target={fileId:string;branchId:string;branchName:string;type:string;period:string;sheetName:string;summarySheetName:string;linkSheetName:string};
export function periodOf(p:any){const value=String(p.period||p.periode||'').replace(/-/g,'');const period=/^\d{6}$/.test(value)&&value.startsWith('20')?value:String(p.tahun||'')+String(Number(p.bulan)||'').padStart(2,'0');invariant(/^\d{4}(0[1-9]|1[0-2])$/.test(period),'INVALID_PERIOD','Pilih bulan dan tahun yang valid.');return period;}
export function isoDay(value:any,period:string){
 const raw=String(value??'').trim();let iso='';
 if(/^\d{4}-\d{2}-\d{2}$/.test(raw))iso=raw;
 else {const m=raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);if(m)iso=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');else if(/^\d{1,2}$/.test(raw))iso=period.slice(0,4)+'-'+period.slice(4)+'-'+raw.padStart(2,'0');}
 if(!iso||iso.replaceAll('-','').slice(0,6)!==period)return '';
 const d=new Date(iso+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso?iso:'';
}
export async function targetFor(p:any,db:Database=database()):Promise<Target>{
 const period=periodOf(p),values:any[]=[period],where=['l.period=$1','b.active=true'];
 if(p.branchId){values.push(String(p.branchId));where.push('b.id=$'+values.length);}
 else if(p.cabang){values.push(String(p.cabang).trim());where.push('upper(b.name)=upper($'+values.length+')');}
 const match=String(p.link||'').match(/^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)(?:\/|$)/);if(p.link){invariant(match,'INVALID_SHEET','Tautan spreadsheet tidak valid.');values.push(match[1]);where.push('l.spreadsheet_id=$'+values.length);}
 const rows=(await db.query('SELECT l.*,b.name,b.type FROM nota_app.master_links l JOIN nota_app.branches b ON b.id=l.branch_id WHERE '+where.join(' AND '),values)).rows;
 invariant(rows.length===1,'SHEET_TARGET_REQUIRED','Master Link untuk cabang dan bulan ini belum tersedia atau ambigu.');const r=rows[0];
 const type=/central/i.test(r.type)?'Central Kitchen':'Mandiri';invariant(!p.tipe||p.tipe===type,'BRANCH_TYPE_CONFLICT','Jenis cabang berubah. Muat ulang Master Link.');
 return {fileId:r.spreadsheet_id,branchId:r.branch_id,branchName:r.name.toUpperCase(),type,period,sheetName:r.data.sheetName||'REKAP',summarySheetName:r.data.summarySheetName||'REKAP PENGELUARAN',linkSheetName:r.data.linkSheetName||'LINK SHEET'};
}
export const padded=(row:any[]|undefined,width:number)=>Array.from({length:width},(_,i)=>row?.[i]??'');
export async function valuesOf(id:string,range:string,formula=false):Promise<any[][]>{return (await sheetsRequest(id,'/values/'+encodeURIComponent(range)+'?valueRenderOption='+(formula?'FORMULA':'UNFORMATTED_VALUE'))).values||[];}
export function rowTags(meta:any,sheetId:number){const map:Record<number,any[]>={};for(const tag of [...(meta.developerMetadata||[]),...(meta.sheets||[]).flatMap((s:any)=>s.developerMetadata||[])]){const r=tag.location?.dimensionRange;if(r?.sheetId===sheetId&&r.dimension==='ROWS'&&r.endIndex===r.startIndex+1){(map[r.startIndex+1]||=[]).push(tag);}}return map;}
export async function readModel(target:Target){
 const range=quoteTab(target.sheetName)+'!A:I';
 const meta=await sheetsRequest(target.fileId,'?ranges='+encodeURIComponent(range)+'&fields='+encodeURIComponent('properties(title),sheets(properties,data(startRow,rowData(values(effectiveValue,userEnteredValue)),rowMetadata(developerMetadata)))'));
 const sheet=meta.sheets.find((s:any)=>s.properties.title===target.sheetName);invariant(sheet,'SHEET_TAB_NOT_FOUND','Tab '+target.sheetName+' tidak ditemukan.');
 const sheetId=sheet.properties.sheetId,width=target.type==='Central Kitchen'?9:8,grid=sheet.data?.[0]||{},rawRows=grid.rowData||[];
 const scalar=(v:any)=>v?.numberValue??v?.stringValue??v?.boolValue??'';
 const values:any[][]=rawRows.map((r:any)=>Array.from({length:width},(_,i)=>scalar(r.values?.[i]?.effectiveValue)));
 const formulas:any[][]=rawRows.map((r:any)=>Array.from({length:width},(_,i)=>r.values?.[i]?.userEnteredValue?.formulaValue??scalar(r.values?.[i]?.effectiveValue)));
 const tags=rowTags({developerMetadata:(grid.rowMetadata||[]).flatMap((r:any)=>r.developerMetadata||[])},sheetId);
 const mappings=(await database().query('SELECT m.*,r.version AS receipt_version,r.data AS receipt_data,(SELECT count(*)::int FROM nota_app.receipt_items i WHERE i.receipt_id=r.id) AS item_count FROM nota_app.sheet_mappings m LEFT JOIN nota_app.receipts r ON r.id=m.receipt_id WHERE m.spreadsheet_id=$1 AND m.sheet_id=$2',[target.fileId,sheetId])).rows;
 const byRowId=new Map(mappings.map(m=>[m.snapshot.rowId,m]));const rows:any[]=[];
 for(let index=0;index<values.length;index++){
  const v=padded(values[index],width),date=isoDay(v[1],target.period),offset=width===9?1:0;if(!date||(!v[3+offset]&&!v[4+offset]&&!v[5+offset]&&!v[6+offset]))continue;
  const rowTagsHere=tags[index+1]||[],tag=rowTagsHere.find(t=>t.metadataKey==='NOTA_ROW_ID'),foreign=rowTagsHere.some(t=>/^PORTAL_(R_|CK_)/.test(t.metadataKey)),owner=rowTagsHere.find(t=>t.metadataKey==='NOTA_CK_OWNER')?.metadataValue||'';
  const version=payloadHash({values:v,formulas:padded(formulas[index],width),tags:rowTagsHere.map(t=>[t.metadataKey,t.metadataValue]).sort()});
  const rowId=tag?.metadataValue||'LEGACY-'+payloadHash([target.fileId,sheetId,index+1,version]),m=byRowId.get(rowId);
  rows.push({sheetRowIndex:index+1,rowId,version,no:String(v[2]),tanggal:date.slice(8)+'-'+date.slice(5,7)+'-'+date.slice(0,4),isoDate:date,cabang:offset?String(v[3]).toUpperCase():target.branchName,keterangan:String(v[3+offset]),jenis:String(v[4+offset]),jumlah:String(v[5+offset]),nominal:Number(v[6+offset])||0,eliminasi:String(v[7+offset]),expenseId:m?.snapshot.expenseId||'',receiptId:m?.receipt_id||'',itemId:m?.receipt_id?m.item_id:'',receiptPhotoId:m?.receipt_data?.photoId||'',receiptVersion:m?.receipt_version||null,receiptItemCount:m?.item_count||0,distributionSource:owner,ownershipConflict:foreign||!!(tag&&!m&&!owner),fotoUrl:m?.snapshot.fotoUrl|| (m?.receipt_data?.photoId?(process.env.APP_ORIGIN||'')+'/api/photos/'+m.receipt_data.photoId:''),conflicts:foreign||!!(tag&&!m&&!owner)?['Identitas baris perlu diperiksa sebelum diubah.']:[]});
 }
 return {target,meta,sheetId,width,values:values.map((v:any[])=>padded(v,width)),formulas:formulas.map((v:any[])=>padded(v,width)),tags,mappings,rows};
}
export type Model=Awaited<ReturnType<typeof readModel>>;
const num=(v:any)=>typeof v==='number'?v:Number(String(v||'').replace('%','').replace(',','.'))/(String(v).includes('%')?100:1)||0;
export async function summaryFor(model:Model){
 const t=model.target,keys=['bahanBaku','telur','airGalon','gas','bahanKemas','lainLain','operasionalToko'];
 if(t.type==='Central Kitchen'){
  const values=await valuesOf(t.fileId,quoteTab(t.sheetName)+'!K5:U');const summaries=[];
  for(let i=0;i+1<values.length;i+=2){const a=values[i],b=values[i+1],name=String(a?.[0]||'').trim();if(!name||['NAMA CABANG','CONTROL PERSENTASE'].includes(name))continue;
   const convert=(r:any[])=>({...Object.fromEntries(keys.map((key,j)=>[key,num(r?.[j+1])])),totalPct:num(r?.[8]),nominalTotal:num(r?.[9])});summaries.push({cabang:name.toUpperCase(),target:convert(a),real:convert(b),selisih:num(a[10])});
  }return summaries;
 }

 const rows=await valuesOf(t.fileId,quoteTab(t.summarySheetName)+'!A40:T48'),real=rows[2]||[],target=rows[3]||[],base=num(rows[8]?.[1]);
 return {nominal:{totalReal:rows.length>=9?base*num(real[19]):num(rows[0]?.[18]),totalTarget:rows.length>=9?base*num(target[19]):num(rows[0]?.[19])},categories:Object.fromEntries(keys.map((key,i)=>[key,{real:num(real[[3,5,7,9,13,15,17][i]]),target:num(target[[3,5,7,9,13,15,17][i]])}]))};
}
export async function fetchSheet(p:any){const model=await readModel(await targetFor(p));let summary=null,warning='';try{summary=await summaryFor(model);}catch{warning='Rincian berhasil dimuat; ringkasan belum dapat diperbarui.';}return {success:true,spreadsheetName:model.meta.properties.title,data:model.rows,rekapPengeluaranData:summary,warning,branchId:model.target.branchId,cabang:model.target.branchName,protocolVersion:2};}


