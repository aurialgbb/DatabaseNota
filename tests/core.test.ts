import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createJob,mutateOnce,authorizedJob } from '../lib/jobs';
import { payloadHash,requireBranch,checkOrigin,type User } from '../lib/identity';
import type { Database } from '../lib/db';
import { portalValidateReceiptPayload_,portalAllocateReceiptDiscounts_ } from '../generated/receipt-domain.mjs';
const user:User={uid:'u1',username:'toko',displayName:'Toko',role:'TOKO',branchId:'b1',branchName:'Satu',branchType:'TOKO',active:true};
test('Cabang dan origin dibatasi di server',()=>{
 assert.throws(()=>requireBranch(user,'b2'));
 requireBranch(user,'b1');
 assert.throws(()=>checkOrigin(new Request('https://nota.test/api',{headers:{origin:'https://evil.test'}})));
 checkOrigin(new Request('https://nota.test/api',{headers:{origin:'https://nota.test'}}));
 assert.equal(payloadHash({a:1,b:2}),payloadHash({b:2,a:1}));
});
test('Alokasi diskon menjaga total dan menolak diskon berlebih',()=>{
 const items=[{id:'a',description:'A',category:'BAHAN',quantity:1,amount:100},{id:'b',description:'B',category:'BAHAN',quantity:1,amount:200}];
 const result=portalValidateReceiptPayload_({date:'2026-09-10',items,adjustments:[{type:'DISCOUNT',amount:10,targetType:'RECEIPT'}]},['BAHAN']);
 assert.equal(result.receiptTotal,290);
 assert.equal(result.items.reduce((sum:number,item:any)=>sum+item.discountAllocated,0),10);
 assert.equal(result.items.reduce((sum:number,item:any)=>sum+item.amount,0),290);
 assert.equal(portalAllocateReceiptDiscounts_(items,[{type:'DISCOUNT',amount:301}]).valid,false);
});
test('Migrasi PostgreSQL, idempotensi, outbox, dan isolasi pekerjaan',async()=>{
 const pg=new PGlite();
 try {
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await pg.exec("INSERT INTO branches(id,name) VALUES('b1','Satu'),('b2','Dua'); INSERT INTO profiles(uid,username,auth_email,display_name,role,branch_id) VALUES('u1','toko','test@example.invalid','Toko','TOKO','b1');");
  const db=pg as unknown as Database;
  await pg.exec('BEGIN');
  const first=await createJob(db,user,'STORE_OCR',{photoId:'p1'},'same');
  const second=await createJob(db,user,'STORE_OCR',{photoId:'p1'},'same');
  assert.equal(first.id,second.id);
  assert.equal((await pg.query('SELECT * FROM outbox')).rows.length,1);
  await assert.rejects(()=>createJob(db,user,'STORE_OCR',{photoId:'p2'},'same'),/isi berbeda/);
  await assert.rejects(()=>authorizedJob(db,{...user,uid:'other'},first.id),/diakses/);
  let calls=0;
  const run=()=>mutateOnce(db,user,'SAVE','key',{value:1},async()=>({count:++calls}));
  assert.deepEqual(await run(),await run());
  assert.equal(calls,1);
  await pg.exec('COMMIT');
  await pg.exec('BEGIN');
  await createJob(db,user,'STORE_OCR',{},'rollback');
  await pg.exec('ROLLBACK');
  assert.equal((await pg.query('SELECT * FROM jobs')).rows.length,1);
 } finally { await pg.close(); }
});
