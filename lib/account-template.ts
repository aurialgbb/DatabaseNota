import ExcelJS from 'exceljs';
import {database} from './db';
import {requireRole,type User} from './identity';
import {invariant} from './errors';
export async function accountWorkbook(branches:{name:string;type:string}[]){
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Import Akun'),reference=book.addWorksheet('Referensi Cabang');
 sheet.columns=[{header:'role',width:14},{header:'branchName',width:32},{header:'branchType',width:22},{header:'displayName',width:32},{header:'username',width:24},{header:'password',width:24}];
 for(const b of branches)sheet.addRow(['TOKO',b.name,b.type,b.name,'','']);sheet.addRow(['TAX','','','Tim Tax','','']);sheet.addRow(['ADMIN','','','Administrator Tambahan','','']);
 reference.addRow(['Nama Cabang','Tipe Cabang']);for(const b of branches)reference.addRow([b.name,b.type]);reference.getColumn(1).width=32;reference.getColumn(2).width=22;
 sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:'A1',to:'F'+sheet.rowCount};
 for(const tab of [sheet,reference]){tab.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};tab.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2459C4'}};tab.getRow(1).height=26;}
 sheet.eachRow((row,index)=>{if(index===1)return;row.eachCell({includeEmpty:true},c=>{c.numFmt='@';});row.getCell(1).dataValidation={type:'list',allowBlank:false,formulae:['"TOKO,TAX,ADMIN"'],showErrorMessage:true,error:'Pilih TOKO, TAX, atau ADMIN.'};row.getCell(3).dataValidation={type:'list',allowBlank:true,formulae:['"Mandiri,Central Kitchen"'],showErrorMessage:true,error:'Pilih tipe cabang yang tersedia.'};});
 sheet.getCell('E1').note='Isi username unik. Jangan isi email atau password akun lain.';sheet.getCell('F1').note='Isi password baru, minimal 6 karakter. File yang sudah diisi berisi kredensial; simpan secara privat.';
 return Buffer.from(await book.xlsx.writeBuffer());
}
export async function accountTemplate(user:User){
 requireRole(user,['ADMIN','TAX']);const branches=(await database().query('SELECT name,type FROM nota_app.branches WHERE active=true ORDER BY name')).rows;
 invariant(branches.length,'BRANCH_REQUIRED','Tambahkan cabang aktif di Master Link terlebih dahulu.');
 return {fileName:'template-import-akun-gbb.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',branchCount:branches.length,base64:(await accountWorkbook(branches as any)).toString('base64')};
}
