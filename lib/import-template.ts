import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {database} from './db';
import {requireRole,type User} from './identity';
export async function importWorkbook(kind:'branch'|'account',branches:any[]){
 const book=new ExcelJS.Workbook();await book.xlsx.load(await fs.readFile(path.join(process.cwd(),'assets','import-templates',kind+'.xlsx')) as any);book.creator='Database Nota GBB';
 const branch=kind==='branch',sheet=book.worksheets[0],rows=branch?[]:branches.map(b=>['TOKO',b.name,b.type,b.name,'','']);if(!branch)rows.push(['TAX','','','Tim Tax','',''],['ADMIN','','','Administrator Tambahan','','']);
 for(const tab of book.worksheets){tab.views=[{showGridLines:false,state:tab===sheet?'frozen':'normal',ySplit:tab===sheet?7:0}];tab.eachRow(row=>{row.alignment={vertical:'middle'};});}
 rows.forEach((row,i)=>{sheet.getRow(i+8).values=row.map(value=>value===''?null:value);});
 const last=Math.max(257,rows.length+7),columns=branch?5:6;
 for(let r=8;r<=last;r++){const row=sheet.getRow(r);row.height=26;for(let c=1;c<=columns;c++){const cell=row.getCell(c);cell.numFmt='@';cell.font={name:'Aptos',size:11,color:{argb:'FF243247'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:r%2?'FFF1F6FD':'FFFFFFFF'}};cell.alignment={vertical:'middle'};cell.border={bottom:{style:'hair',color:{argb:'FFDAE4F0'}}};}dropdown(row.getCell(1),branch?['Tambah','Ubah','Hapus']:['TOKO','TAX','ADMIN']);dropdown(row.getCell(branch?5:3),['Mandiri','Central Kitchen']);if(!branch)row.getCell(6).dataValidation={type:'textLength',operator:'between',formulae:[6,128],allowBlank:true,showErrorMessage:true,errorStyle:'stop',error:'Password harus 6–128 karakter.'};}
 if(branch)sheet.getCell('D7').note='Mandiri: wajib Nama CV. CK: kosongkan karena hanya pooling. Ubah: kosong mempertahankan CV lama.';
 sheet.autoFilter={from:{row:7,column:1},to:{row:last,column:columns}};
 const reference=book.addWorksheet('Referensi Cabang',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});reference.addRow(branch?['ID Cabang','Nama Cabang','Nama CV','Tipe Cabang','Status']:['Nama Cabang','Tipe Cabang']);branches.forEach(b=>reference.addRow(branch?[b.id,b.name,b.type==='Central Kitchen'?'':b.data?.cv||'',b.type,b.active===false?'Nonaktif':'Aktif']:[b.name,b.type]));
 reference.columns.forEach((col,i)=>{col.width=i<2?38:24;col.numFmt='@';});reference.eachRow((row,i)=>{row.height=26;row.font={name:'Aptos',size:11,color:{argb:i===1?'FFFFFFFF':'FF243247'},bold:i===1};row.fill={type:'pattern',pattern:'solid',fgColor:{argb:i===1?'FF2563EB':i%2?'FFF1F6FD':'FFFFFFFF'}};});
 if(!branch&&branches.length){book.definedNames.add("'Referensi Cabang'!$A$2:$A$"+reference.rowCount,'DaftarCabang');for(let r=8;r<=last;r++)sheet.getCell(r,2).dataValidation={type:'list',allowBlank:true,formulae:['DaftarCabang'],showErrorMessage:true,errorStyle:'stop',error:'Pilih nama cabang dari tab Referensi Cabang.'};}
 sheet.getCell(branch?'B7':'F7').note=branch?'Tambah: ID boleh kosong. Ubah/Hapus: salin ID persis dari Referensi Cabang.':'Password minimal 6 karakter. Format Teks menjaga angka nol di depan. Simpan file yang telah diisi secara privat.';
 return Buffer.from(await book.xlsx.writeBuffer());
}
function dropdown(cell:ExcelJS.Cell,values:string[]){cell.dataValidation={type:'list',allowBlank:true,formulae:['"'+values.join(',')+'"'],showInputMessage:true,promptTitle:'Pilih dari daftar',prompt:values.join(' / '),showErrorMessage:true,errorStyle:'stop',error:'Pilih salah satu nilai yang tersedia.'};}
export async function branchTemplate(user:User){requireRole(user,['ADMIN','TAX']);const rows=(await database().query('SELECT id,name,type,active,data FROM nota_app.branches ORDER BY name')).rows;return {fileName:'template-kelola-cabang-gbb.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base64:(await importWorkbook('branch',rows)).toString('base64'),branchCount:rows.length};}
