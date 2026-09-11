import test from 'node:test';import assert from 'node:assert/strict';
import {publicApproval} from '../lib/approval';
import {isoDay,periodOf,rowTags} from '../lib/sync-model';
test('Interrupted approval exposes recoverable items and completed outcomes',()=>{
 const job={id:'test',status:'NEEDS_REVIEW',created_at:new Date(),updated_at:new Date(),payload:{decisions:[{receiptId:'a'},{receiptId:'b'}]},result:{items:[{status:'SUCCEEDED'},{status:'PROCESSING'}]}};
 const result=publicApproval(job);assert.equal(result.status,'RECOVERY_REQUIRED');assert.equal(result.counts.succeeded,1);assert.equal(result.counts.recoveryRequired,1);assert.equal(result.items[1].status,'RECOVERY_REQUIRED');
});
test('Spreadsheet dates reject overflow and dates from another month',()=>{
 assert.equal(isoDay(31,'202602'),'');assert.equal(isoDay('11-09-2026','202609'),'2026-09-11');assert.equal(isoDay('2026-10-11','202609'),'');assert.equal(periodOf({bulan:9,tahun:2026}),'202609');
});
test('Row metadata is scoped to a single row and exact sheet',()=>{
 const tag=(sheetId:number,startIndex:number,endIndex:number)=>({metadataKey:'NOTA_ROW_ID',metadataValue:'row',location:{dimensionRange:{sheetId,dimension:'ROWS',startIndex,endIndex}}});
 const result=rowTags({developerMetadata:[tag(2,5,6),tag(1,5,6),tag(2,8,10)]},2);assert.deepEqual(Object.keys(result),['6']);assert.equal(result[6].length,1);
});
