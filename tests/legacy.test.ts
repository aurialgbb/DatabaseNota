import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {legacyRead,legacyMutate} from '../lib/legacy';import type {Database} from '../lib/db';import type {User} from '../lib/identity';
test('Menu listrik, umum, history: CRUD, paginasi, filter dan idempotensi',async()=>{
 const pg=new PGlite(),db=pg as unknown as Database;const user={uid:'tester',role:'ADMIN'} as User;
 try{
 for(const file of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())await pg.exec(fs.readFileSync('migrations/'+file,'utf8'));
 await pg.exec("INSERT INTO nota_app.branches(id,name) VALUES('a','CABANG A'); INSERT INTO nota_app.profiles(uid,username,auth_email,display_name,role) VALUES('tester','tester','tester@invalid.test','Tester','ADMIN');");
 const mutate=async(action:string,args:any[],key:string)=>{await pg.exec('BEGIN');try{const result=await legacyMutate(db,user,action,args,key);await pg.exec('COMMIT');return result;}catch(e){await pg.exec('ROLLBACK');throw e;}};
 const args=[{toko:'CABANG A',tanggal:new Date('2026-09-11T00:00:00+07:00').getTime(),nominal:150000,kategori:'Listrik'}];
 const one=await mutate('saveListrikTransaction',args,'1');assert.deepEqual(await mutate('saveListrikTransaction',args,'1'),one);
 await mutate('saveListrikTransaction',[{...args[0],kategori:'Umum',nominal:10000}],'2');
 let page=await legacyRead(db,user,'getExpensePage',[{type:'listrik',limit:1}]);assert.ok(page && 'total' in page);assert.equal(page.total,1);assert.equal(page.totalAmount,150000);
 await mutate('updateListrikTransaction',[one[0],{...args[0],nominal:200000,expectedVersion:1}],'3');
 await assert.rejects(()=>mutate('updateListrikTransaction',[one[0],{...args[0],expectedVersion:1}],'4'));
 const summary=await legacyRead(db,user,'getExpenseSummaryByBranchMonth',[2026]);assert.ok(summary && 'summary' in summary && summary.summary);assert.equal(summary.summary['CABANG A'][8].total,200000);
 const hist=await mutate('saveTransactions',[{toko:'CABANG A',tanggal:'2026-09-11',items:[{name:'TELUR',qty:2,total:5000,unit:'PCS'}]}],'5');
 await mutate('duplicateToKategori',[hist[0][0],'Umum'],'6');await assert.rejects(()=>mutate('duplicateToKategori',[hist[0][0],'Umum'],'7'));
 const history=await legacyRead(db,user,'getHistoryPage',[{filters:{search:'TELUR'}}]);assert.ok(history && 'rows' in history);assert.equal(history.total,1);assert.equal(history.rows[0][11],'Umum');
 await mutate('deleteTransaction',[hist[0][0]],'8');await mutate('deleteListrikTransaction',[one[0]],'9');
 const empty=await legacyRead(db,user,'getHistoryPage',[{}]);assert.ok(empty && 'total' in empty);assert.equal(empty.total,0);
 const second=await legacyRead(db,user,'getExpensePage',[{type:'umum',page:2,limit:1}]);assert.ok(second && 'rows' in second);assert.equal(second.rows.length,1);
 await assert.rejects(()=>legacyRead(db,{...user,role:'TOKO'},'getExpensePage',[{}]));
 }finally{await pg.close();}
});

test('Admin dapat menghapus transaksi hasil ACC (APR-*) dan mengembalikan status receipt ke PENDING, sedangkan non-admin diblokir', async () => {
 const pg = new PGlite(), db = pg as unknown as Database;
 const adminUser = { uid: 'admin-1', role: 'ADMIN' } as User;
 const taxUser = { uid: 'tax-1', role: 'TAX' } as User;
 try {
  for (const file of fs.readdirSync('migrations').filter(x => x.endsWith('.sql')).sort()) {
   await pg.exec(fs.readFileSync('migrations/' + file, 'utf8'));
  }
  await pg.exec("INSERT INTO nota_app.branches(id,name,type,active) VALUES('b1','CABANG B','PT',true);");
  await pg.exec("INSERT INTO nota_app.profiles(uid,username,auth_email,display_name,role) VALUES('admin-1','admin','admin@test.com','Admin','ADMIN'),('tax-1','tax','tax@test.com','Tax','TAX');");
  await pg.exec(`
   INSERT INTO nota_app.receipts(id,branch_id,owner_uid,supplier,receipt_date,status,total,data)
   VALUES('rcpt-1','b1','admin-1','TOKO A','2026-09-11','APPROVED',100000,'{"approvedAt":1789145738561}'::jsonb);
   INSERT INTO nota_app.receipt_items(id,receipt_id,position,description,category,quantity,unit,amount)
   VALUES('item-1','rcpt-1',1,'Item 1','Umum',1,'PCS',50000),('item-2','rcpt-1',2,'Item 2','Umum',1,'PCS',50000);
   INSERT INTO nota_app.transactions(id,kind,branch_id,business_date,amount,data)
   VALUES('APR-item-1','UMUM','b1','2026-09-11',50000,'{"readOnly":true,"sourceReceiptId":"rcpt-1","kategori":"Umum"}'::jsonb),
         ('APR-item-2','UMUM','b1','2026-09-11',50000,'{"readOnly":true,"sourceReceiptId":"rcpt-1","kategori":"Umum"}'::jsonb);
  `);

  const mutate = async (user: User, action: string, args: any[], key: string) => {
   await pg.exec('BEGIN');
   try {
    const result = await legacyMutate(db, user, action, args, key);
    await pg.exec('COMMIT');
    return result;
   } catch (e) {
    await pg.exec('ROLLBACK');
    throw e;
   }
  };

  await assert.rejects(
   () => mutate(taxUser, 'deleteListrikTransaction', ['APR-item-1'], 'tax-del-1'),
   (err: any) => err.code === 'APPROVED_RECEIPT_LOCKED'
  );

  await assert.rejects(
   () => mutate(taxUser, 'bulkDeleteListrikTransaction', [['APR-item-1', 'APR-item-2']], 'tax-del-bulk'),
   (err: any) => err.code === 'APPROVED_RECEIPT_LOCKED'
  );

  const delResult = await mutate(adminUser, 'deleteListrikTransaction', ['APR-item-1'], 'admin-del-1');
  assert.equal(delResult, true);

  const remainingTx = (await pg.query("SELECT count(*)::int as c FROM nota_app.transactions WHERE id IN ('APR-item-1', 'APR-item-2')")).rows[0] as any;
  assert.equal(remainingTx.c, 0);

  const receipt = (await pg.query("SELECT status, (data->>'approvedAt') as approved_at, version FROM nota_app.receipts WHERE id='rcpt-1'")).rows[0] as any;
  assert.equal(receipt.status, 'PENDING');
  assert.equal(receipt.approved_at, null);
  assert.ok(Number(receipt.version) >= 2);
 } finally {
  await pg.close();
 }
});

test('Admin dapat melakukan bulk delete transaksi hasil ACC bersamaan tanpa error Transaksi tidak ditemukan', async () => {
 const pg = new PGlite(), db = pg as unknown as Database;
 const adminUser = { uid: 'admin-1', role: 'ADMIN' } as User;
 try {
  for (const file of fs.readdirSync('migrations').filter(x => x.endsWith('.sql')).sort()) {
   await pg.exec(fs.readFileSync('migrations/' + file, 'utf8'));
  }
  await pg.exec("INSERT INTO nota_app.branches(id,name,type,active) VALUES('b1','CABANG B','PT',true);");
  await pg.exec("INSERT INTO nota_app.profiles(uid,username,auth_email,display_name,role) VALUES('admin-1','admin','admin@test.com','Admin','ADMIN');");
  await pg.exec(`
   INSERT INTO nota_app.receipts(id,branch_id,owner_uid,supplier,receipt_date,status,total,data)
   VALUES('rcpt-bulk','b1','admin-1','TOKO B','2026-09-11','APPROVED',150000,'{"approvedAt":1789145738561}'::jsonb);
   INSERT INTO nota_app.receipt_items(id,receipt_id,position,description,category,quantity,unit,amount)
   VALUES('item-b1','rcpt-bulk',1,'Item B1','Umum',1,'PCS',50000),
         ('item-b2','rcpt-bulk',2,'Item B2','Umum',1,'PCS',50000),
         ('item-b3','rcpt-bulk',3,'Item B3','Umum',1,'PCS',50000);
   INSERT INTO nota_app.transactions(id,kind,branch_id,business_date,amount,data)
   VALUES('APR-item-b1','UMUM','b1','2026-09-11',50000,'{"readOnly":true,"sourceReceiptId":"rcpt-bulk","kategori":"Umum"}'::jsonb),
         ('APR-item-b2','UMUM','b1','2026-09-11',50000,'{"readOnly":true,"sourceReceiptId":"rcpt-bulk","kategori":"Umum"}'::jsonb),
         ('APR-item-b3','UMUM','b1','2026-09-11',50000,'{"readOnly":true,"sourceReceiptId":"rcpt-bulk","kategori":"Umum"}'::jsonb);
  `);

  const mutate = async (user: User, action: string, args: any[], key: string) => {
   await pg.exec('BEGIN');
   try {
    const result = await legacyMutate(db, user, action, args, key);
    await pg.exec('COMMIT');
    return result;
   } catch (e) {
    await pg.exec('ROLLBACK');
    throw e;
   }
  };

  const res = await mutate(adminUser, 'bulkDeleteListrikTransaction', [['APR-item-b1', 'APR-item-b2', 'APR-item-b3']], 'admin-bulk-del');
  assert.equal(res.success, true);

  const count = (await pg.query("SELECT count(*)::int as c FROM nota_app.transactions WHERE id LIKE 'APR-item-b%'")).rows[0] as any;
  assert.equal(count.c, 0);

  const receipt = (await pg.query("SELECT status, (data->>'approvedAt') as approved_at FROM nota_app.receipts WHERE id='rcpt-bulk'")).rows[0] as any;
  assert.equal(receipt.status, 'PENDING');
  assert.equal(receipt.approved_at, null);
 } finally {
  await pg.close();
 }
});



