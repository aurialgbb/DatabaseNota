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

