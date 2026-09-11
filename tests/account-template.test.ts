import test from 'node:test';import assert from 'node:assert/strict';import ExcelJS from 'exceljs';import vm from 'node:vm';import fs from 'node:fs';import {accountWorkbook} from '../lib/account-template';import {importWorkbook} from '../lib/import-template';import {planBranches} from '../lib/bulk-branches';
const context:any={};vm.runInNewContext(fs.readFileSync('public/import-workbooks.js','utf8'),context);const parser=context.NotaImport;
const matrix=(sheet:ExcelJS.Worksheet)=>Array.from({length:sheet.rowCount},(_,i)=>Array.from({length:sheet.columnCount},(_,c)=>sheet.getCell(i+1,c+1).value??''));
test('Branch XLSX has empty import rows, separate examples, dropdowns and usable localized import',async()=>{
 const bytes=await importWorkbook('branch',[{id:'DEPOK',name:'Depok',type:'Mandiri'}]),book=new ExcelJS.Workbook();await book.xlsx.load(bytes as any);const sheet=book.getWorksheet('Import Cabang')!;
 assert.equal(sheet.getCell('A7').value,'Tindakan');assert.equal(parser.matrixRows(matrix(sheet),'branch').length,0);assert.equal(sheet.getCell('A8').dataValidation.type,'list');assert.equal(book.getWorksheet('Referensi Cabang')!.getCell('A2').value,'DEPOK');
 sheet.getRow(8).values=['Tambah','','Cabang Baru','CV Baru','Mandiri'];sheet.getRow(10).values=['Ubah','DEPOK','Depok Baru',''];const rows=parser.matrixRows(matrix(sheet),'branch');assert.equal(rows.length,2);assert.equal(rows[1]._sourceRow,10);assert.equal(rows[0].action,'ADD');const plan=planBranches(rows,[{id:'DEPOK',name:'Depok',type:'Mandiri',data:{cv:'CV Depok'}}],'202609');assert.equal(plan.errors.length,0);assert.equal(plan.changes[1].row,10);assert.equal(plan.changes[1].after.type,'Mandiri');
});
test('Account XLSX preserves blank credentials and leading zero password through localized import',async()=>{
 const bytes=await accountWorkbook([{name:'DEPOK',type:'Mandiri'}]),book=new ExcelJS.Workbook();await book.xlsx.load(bytes as any);const sheet=book.getWorksheet('Import Akun')!;assert.equal(sheet.getCell('A7').value,'Peran');assert.equal(sheet.getCell('A8').value,'TOKO');assert.equal(sheet.getCell('A9').value,'TAX');assert.equal(sheet.getCell('A10').value,'ADMIN');assert.equal(sheet.getCell('F8').numFmt,'@');assert.equal(sheet.getCell('F8').value,null);sheet.getCell('E8').value='depok';sheet.getCell('F8').value='001234';const rows=parser.matrixRows(matrix(sheet),'account');assert.equal(rows[0].username,'depok');assert.equal(rows[0].password,'001234');assert.equal(rows.length,3);
});
test('Old CSV templates retain quoted commas and support Indonesian separator',()=>{
 const rows=parser.csvRows('action,id,name,type\nADD,,"Cabang A, Selatan",Mandiri','branch');assert.equal(rows[0].name,'Cabang A, Selatan');assert.equal(parser.csvRows('action;id;name;type\nADD;;Cabang;Mandiri','branch')[0].action,'ADD');
 const account=parser.csvRows('role,branchName,branchType,displayName,username,password\nTOKO,Depok,Mandiri,Depok,depok,001234','account');assert.equal(account[0].password,'001234');assert.throws(()=>parser.csvRows('a,b\n1,2','branch'),/Header/);
});
test('Workbook parser chooses import sheet even when guide is first',()=>{
 const workbook={SheetNames:['Panduan','Import Cabang'],Sheets:{Panduan:{tag:'guide'},'Import Cabang':{tag:'input'}}};const rows=parser.workbookRows(workbook,'branch',{utils:{sheet_to_json:(sheet:any)=>{assert.equal(sheet.tag,'input');return [['action','id','name','type'],['ADD','','TEST','Mandiri']];}}});assert.equal(rows.length,1);
});
