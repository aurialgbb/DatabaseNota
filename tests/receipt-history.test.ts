import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {submissionHistory} from '../lib/receipts';
import {legacyRead} from '../lib/legacy';
import type {Database} from '../lib/db';
import type {User} from '../lib/identity';

const tax:User={uid:'tax-1',username:'tax',displayName:'Tax',role:'TAX',branchId:'',branchName:'',branchType:'',active:true};

test('Riwayat pengajuan merangkum status dan matriks memakai tanggal transaksi',async()=>{
 const pg=new PGlite();
 try{
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await pg.exec(`
   INSERT INTO nota_app.branches(id,name,type) VALUES('b1','Cabang Satu','Mandiri');
   INSERT INTO nota_app.profiles(uid,username,auth_email,display_name,role) VALUES('tax-1','tax','tax@example.invalid','Tax','TAX');
   INSERT INTO nota_app.receipts(id,branch_id,owner_uid,supplier,receipt_date,status,total,data,created_at)
   VALUES
    ('r-approved','b1','tax-1','PLN','2026-09-03','APPROVED',125000,'{"displayNumber":"001"}', '2026-09-05T01:00:00Z'),
    ('r-returned','b1','tax-1','Pasar','2026-08-31','NEEDS_CORRECTION',50000,'{"displayNumber":"002","review":{"decision":"REQUEST_CORRECTION","reason":"Foto kurang jelas"}}', '2026-09-06T01:00:00Z'),
    ('r-draft','b1','tax-1','Draft','2026-09-07','DRAFT',1,'{}', '2026-09-07T01:00:00Z');
   INSERT INTO nota_app.receipt_items(id,receipt_id,position,description,category,quantity,amount)
   VALUES('i1','r-approved',0,'Token listrik','LISTRIK',1,125000),('i2','r-returned',0,'Belanja','LAIN-LAIN',1,50000);
  `);
  await pg.exec(await readFile(new URL('../migrations/005_approved_receipt_bank.sql',import.meta.url),'utf8'));
  const db=pg as unknown as Database;
  const history=await submissionHistory(db,tax,{month:'2026-09',status:'ALL',page:1,limit:25});
  assert.equal(history.summary.ALL,2);
  assert.equal(history.summary.APPROVED,1);
  assert.equal(history.summary.NEEDS_CORRECTION,1);
  assert.equal(history.rows.some(row=>row.id==='r-draft'),false);
  const electricity:any=await legacyRead(db,tax,'getExpenseDailyMatrix',[{month:'2026-09',type:'listrik',page:1,limit:25}]);
  assert.equal(electricity.cells.b1[3].count,1);
  assert.equal(electricity.cells.b1[3].total,125000);
 }finally{await pg.close();}
});
