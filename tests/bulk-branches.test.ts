import test from 'node:test';import assert from 'node:assert/strict';import {planBranches} from '../lib/bulk-branches';
test('Bulk branch plan rejects duplicate names and deletion of referenced branches',()=>{
 const before=[{id:'A',name:'Depok',type:'Mandiri',reference_count:1},{id:'B',name:'Bogor',type:'Mandiri',reference_count:0}];
 const plan=planBranches([{id:'A',action:'DELETE'},{id:'C',name:'Depok',type:'Mandiri',action:'ADD'},{id:'B',action:'UPDATE',name:'Bogor Baru'}],before,'202609');
 assert.equal(plan.errors.length,2);assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].after.name,'Bogor Baru');assert.equal(before[1].name,'Bogor');
});
test('Bulk branch plan supports adds, unchanged rows and explicit deletes',()=>{
 const plan=planBranches([{id:'A',action:'DELETE'},{id:'B',action:'UPDATE'},{name:'CK JAKARTA',type:'Central Kitchen',action:'ADD'}],[{id:'A',name:'A',type:'Mandiri'},{id:'B',name:'B',type:'Mandiri'}],'202609');
 assert.deepEqual(plan.errors,[]);assert.deepEqual(plan.summary,{add:1,update:0,remove:1,unchanged:1});assert.equal(plan.changes[2].id,'CK_JAKARTA');
});

