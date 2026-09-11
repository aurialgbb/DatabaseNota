import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
const root=path.resolve(import.meta.dirname,'..'), base=path.join(root,'baseline'), out=path.join(root,'generated');
fs.mkdirSync(out,{recursive:true});
const read=name=>fs.readFileSync(path.join(base,name),'utf8');
const source=read('portal_receipts.gs'), config=read('portal_config.gs'), legacy=read('code.gs');
const trees=[source,config].map(text=>({text,ast:parse(text,{sourceType:'script'})}));
const functions=new Map();
for(const {text,ast} of trees) for(const n of ast.program.body) if(n.type==='FunctionDeclaration') functions.set(n.id.name,text.slice(n.start,n.end));
const names=['portalValidateReceiptPayload_','portalNormalizeOcrReceipts_','portalAllocateReceiptDiscounts_','portalIsDiscountLine_','portalDiscountText_','portalNormalizeDiscountAdjustment_','portalSafeNumber_','portalUpper_','portalIsoDate_','portalStrictDate_'];
const shim=`import {randomUUID} from 'node:crypto';
const PORTAL_MAX_ITEMS_PER_RECEIPT=100;
const Session={getScriptTimeZone(){return 'Asia/Jakarta';}};
const Utilities={formatDate(date,zone,pattern){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}};
function portalFriendlyId_(prefix){return prefix+'-'+randomUUID().replaceAll('-','').slice(0,16).toUpperCase();}
function portalGetCategories_(){throw new Error('Kategori wajib diberikan eksplisit.');}
`;
fs.writeFileSync(path.join(out,'receipt-domain.mjs'),shim+names.map(name=>functions.get(name)).join('\n')+'\nexport { '+names.join(', ')+' };\n');
function initializer(text,fnName,varName){
 const fn=parse(text).program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===fnName);
 for(const n of fn.body.body) if(n.type==='VariableDeclaration') for(const d of n.declarations) if(d.id.name===varName) return text.slice(d.init.start,d.init.end);
 throw new Error('Prompt tidak ditemukan: '+fnName);
}
fs.writeFileSync(path.join(out,'prompts.mjs'),
 'export function storePrompt(categories) { const base='+initializer(source,'portalGeminiReceiptOcr_','prompt')+'; return base+"\\n"+[\n'+
 "  'Gunakan batas fisik kertas, header supplier, nomor transaksi, subtotal, dan grand total sebagai separator antar-nota. Jangan gabungkan item dari nota yang berbeda.',\n"+
 "  'Baca separator angka sesuai konteks nota Indonesia: titik biasanya pemisah ribuan dan koma biasanya desimal. Cocokkan dengan qty, harga satuan, subtotal, dan grand total sebelum menentukan nilai.',\n"+
 "  'Semua quantity, amount, receiptTotal, dan adjustment.amount wajib berupa angka JSON tanpa Rp, spasi, titik ribuan, atau koma desimal. Gunakan titik hanya sebagai desimal JSON bila memang ada pecahan.',\n"+
 "  'Tanggal keluaran tetap YYYY-MM-DD. Jangan menukar posisi hari dan bulan; jika tanggal tidak terbaca pasti, kosongkan dan tambahkan warning.'\n"+
 " ].join('\\n'); }\n"+
 'export function legacyPrompt() { return '+initializer(legacy,'processOCRWithGemini_','promptText')+'; }\n'+
 "export const primary='gemini-3.5-flash-lite', fallback='gemini-3.7-flash', legacyModel='gemini-3.5-flash';\n");
const auth=read('portal_auth.gs');
const portal=[...auth.matchAll(/^\s+([A-Z][A-Z0-9_]+): \{ roles:\s*\[([^\]]*)\], fn:\s*(\w+)/gm)].map(m=>({action:m[1],roles:m[2].match(/\w+/g),source:m[3]}));
const part=legacy.slice(legacy.indexOf('const PORTAL_LEGACY_ROUTES_'),legacy.indexOf('function portalLegacyApi'));
const routes=[...part.matchAll(/^\s+(\w+):\s*\{ fn:\s*(\w+)/gm)].map(m=>({action:m[1],source:m[2],roles:['TAX','ADMIN']}));
fs.writeFileSync(path.join(out,'routes.json'),JSON.stringify({portal,legacy:routes},null,2));
console.log('Domain dan prompt baseline disiapkan:',portal.length+routes.length,'action.');
