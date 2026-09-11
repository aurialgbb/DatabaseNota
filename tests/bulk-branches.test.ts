import test from 'node:test';import assert from 'node:assert/strict';import {planBranches} from '../lib/bulk-branches';
test('Bulk branch plan rejects duplicate names and deletion of referenced branches',()=>{
 const before=[{id:'A',name:'Depok',type:'Mandiri',data:{cv:'CV Contoh'},reference_count:1},{id:'B',name:'Bogor',type:'Mandiri',data:{cv:'CV Contoh'},reference_count:0}];
 const plan=planBranches([{id:'A',action:'DELETE'},{id:'C',name:'Depok',type:'Mandiri',data:{cv:'CV Contoh'},action:'ADD'},{id:'B',action:'UPDATE',name:'Bogor Baru'}],before,'202609');
 assert.equal(plan.errors.length,2);assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].after.name,'Bogor Baru');assert.equal(before[1].name,'Bogor');
});
test('Bulk branch plan supports adds, unchanged rows and explicit deletes',()=>{
 const plan=planBranches([{id:'A',action:'DELETE'},{id:'B',action:'UPDATE'},{name:'CK JAKARTA',type:'Central Kitchen',action:'ADD'}],[{id:'A',name:'A',type:'Mandiri',data:{cv:'CV Contoh'}},{id:'B',name:'B',type:'Mandiri',data:{cv:'CV Contoh'}}],'202609');
 assert.deepEqual(plan.errors,[]);assert.deepEqual(plan.summary,{add:1,update:0,remove:1,unchanged:1});assert.equal(plan.changes[2].id,'CK_JAKARTA');
});


test('CV mapping is explicit for Mandiri and never belongs to CK',()=>{
 const base=[{id:'A',name:'A',type:'Mandiri',data:{cv:'CV Lama',other:1}}];
 let p=planBranches([{action:'UPDATE',id:'A',cv:'CV Baru'}],base,'202609');assert.equal(p.errors.length,0);assert.equal(p.changes[0].after.data.cv,'CV Baru');assert.equal(p.changes[0].after.data.other,1);assert.deepEqual(p.changes[0].changedFields,['cv']);
 p=planBranches([{action:'UPDATE',id:'A',cv:''}],base,'202609');assert.equal(p.changes[0].after.data.cv,'CV Lama');
 p=planBranches([{action:'ADD',name:'B',type:'Mandiri'}],[],'202609');assert.match(p.errors[0].error,/Nama CV wajib/);
 p=planBranches([{action:'ADD',name:'CK',type:'Central Kitchen',cv:'CV Salah'}],[],'202609');assert.match(p.errors[0].error,/Kosongkan/);
 p=planBranches([{action:'UPDATE',id:'A',type:'Central Kitchen'}],base,'202609');assert.equal(p.changes[0].after.data.cv,'');
 p=planBranches([{action:'ADD',name:'B',type:'Mandiri',cv:'CV Sama'},{action:'ADD',name:'C',type:'Mandiri',cv:'CV Sama'},{action:'ADD',name:'CK',type:'Central Kitchen'}],[],'202609');assert.equal(p.errors.length,0);assert.equal(p.summary.add,3);
});
