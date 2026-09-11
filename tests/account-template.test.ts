import test from 'node:test';import assert from 'node:assert/strict';import ExcelJS from 'exceljs';import {accountWorkbook} from '../lib/account-template';
test('Account template round-trips Excel with branch names, all roles, and blank credentials',async()=>{
 const bytes=await accountWorkbook([{name:'DEPOK',type:'Mandiri'}]),book=new ExcelJS.Workbook();await book.xlsx.load(bytes as any);
 const sheet=book.getWorksheet('Import Akun')!;assert.deepEqual((sheet.getRow(1).values as any[]).slice(1),['role','branchName','branchType','displayName','username','password']);assert.equal(sheet.getCell('A2').value,'TOKO');assert.equal(sheet.getCell('B2').value,'DEPOK');assert.equal(sheet.getCell('A3').value,'TAX');assert.equal(sheet.getCell('A4').value,'ADMIN');assert.equal(sheet.getCell('F2').value,'');assert.equal(sheet.getCell('F2').numFmt,'@');
});
