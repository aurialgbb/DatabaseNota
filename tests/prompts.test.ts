import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {createHash} from 'node:crypto';import {parse} from '@babel/parser';
import {storePrompt,legacyPrompt} from '../generated/prompts.mjs';
function expression(file:string,fn:string,variable:string){
 const text=fs.readFileSync(new URL('../baseline/'+file,import.meta.url),'utf8');
 const declaration:any=parse(text).program.body.find((n:any)=>n.type==='FunctionDeclaration'&&n.id.name===fn);
 for(const n of declaration.body.body)if(n.type==='VariableDeclaration')for(const d of n.declarations)if(d.id.name===variable)return text.slice(d.init.start,d.init.end);
 throw Error('Prompt baseline tidak ditemukan');
}
test('Prompt OCR mempertahankan aturan lama dan menambahkan aturan separator',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../baseline/manifest.json',import.meta.url),'utf8'));
 for(const file of ['portal_receipts.gs','code.gs','portal_config.gs']){
  const hash=createHash('sha256').update(fs.readFileSync(new URL('../baseline/'+file,import.meta.url))).digest('hex');assert.equal(hash,manifest.files[file]);
 }
 const categories=['TELUR','GAS','TEPUNG','LISTRIK','AIR GALON','BAHAN BAKU','BAHAN KEMAS','OPERASIONAL TOKO','LAIN-LAIN'];
 const original=vm.runInNewContext(expression('portal_receipts.gs','portalGeminiReceiptOcr_','prompt'),{categories});
 const current=storePrompt(categories);
 assert.ok(current.startsWith(original+'\n'));
 assert.match(current,/batas fisik kertas.+separator antar-nota/);
 assert.match(current,/titik biasanya pemisah ribuan dan koma biasanya desimal/);
 assert.match(current,/angka JSON tanpa Rp/);
 assert.match(current,/Tanggal keluaran tetap YYYY-MM-DD/);
 assert.equal(legacyPrompt(),vm.runInNewContext(expression('code.gs','processOCRWithGemini_','promptText')));
});
