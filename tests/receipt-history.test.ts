import test from 'node:test';
import vm from 'node:vm';
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
  await pg.exec("UPDATE nota_app.branches SET data='{\"cv\":\"CV Satu\"}' WHERE id='b1'");
  const grouped=await submissionHistory(db,tax,{month:'2026-09',view:'branches',search:'CV Satu'});
  assert.equal(grouped.total,1);
  assert.deepEqual(grouped.branchSummary?.[0],{branchId:'b1',branchName:'Cabang Satu',cv:'CV Satu',total:2,approved:1,rejected:0,returned:1});
  const empty=await submissionHistory(db,tax,{month:'2026-08',view:'branches'});
  assert.equal(empty.total,0);
  const electricity:any=await legacyRead(db,tax,'getExpenseDailyMatrix',[{month:'2026-09',type:'listrik',page:1,limit:25}]);
  assert.equal(electricity.cells.b1[3].count,1);
  assert.equal(electricity.cells.b1[3].total,125000);
  await pg.exec("INSERT INTO nota_app.branches(id,name,type) SELECT 'v'||i,'Virtual '||lpad(i::text,3,'0'),'Mandiri' FROM generate_series(1,80) i");
  const virtual:any=await legacyRead(db,tax,'getExpenseDailyMatrix',[{month:'2026-09',type:'listrik',view:'virtual',page:2,limit:25}]);
  assert.equal(virtual.branchIndex.length,81);
  assert.equal(virtual.branches.length,25);
  assert.equal(Object.keys(virtual.cells).length,25);
  assert.equal(virtual.branches[0].id,virtual.branchIndex[25].id);
  const filtered:any=await legacyRead(db,tax,'getExpenseDailyMatrix',[{month:'2026-09',type:'listrik',view:'virtual',search:'Virtual 080'}]);
  assert.equal(filtered.branchIndex.length,1);
  assert.equal(filtered.branches[0].id,'v80');
 }finally{await pg.close();}
});

test('Matriks dapat dipanggil melalui modul fitur portal',async()=>{
 const source=await readFile(new URL('../ui/portal_js.html',import.meta.url),'utf8');
 const start=source.lastIndexOf('(function(Core)');
 assert.ok(start>=0);
 const code=source.slice(start,source.lastIndexOf('</script>'));
 const context={window:{PortalCore:{},PortalFeatures:{} as Record<string,any>},document:{getElementById:()=>null}};
 vm.runInNewContext(code,context);
 assert.equal(typeof context.window.PortalFeatures.ensureExpenseMatrixUi,'function');
 context.window.PortalFeatures.ensureExpenseMatrixUi('listrik');
 context.window.PortalFeatures.ensureExpenseMatrixUi('umum');
 assert.ok(source.includes("runPortalFeature('ensureExpenseMatrixUi', 'listrik')"));
  assert.ok(source.includes("runPortalFeature('ensureExpenseMatrixUi', 'umum')"));
  assert.ok(source.includes("groupPortalNavigation();"));
  assert.ok(source.includes('Hasil ACC terkunci'));
  const legacy=await readFile(new URL('../lib/legacy.ts',import.meta.url),'utf8');
  assert.ok(legacy.includes('tidak dapat diubah atau dihapus dari daftar transaksi'));
  assert.equal(legacy.includes('diubah melalui Riwayat Pengajuan'),false);
});
