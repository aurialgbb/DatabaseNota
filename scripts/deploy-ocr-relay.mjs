import fs from 'node:fs';import {randomBytes} from 'node:crypto';import {primary,fallback,legacyModel} from '../generated/prompts.mjs';
process.loadEnvFile('.env.local');
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.R2_ACCOUNT_ID,key=process.env.GEMINI_API_KEY;
if(!token||!account||!key)throw new Error('CLOUDFLARE_API_TOKEN, R2_ACCOUNT_ID dan GEMINI_API_KEY harus tersedia di .env.local.');
if(!/^[a-f0-9]{32}$/i.test(account))throw new Error('ID akun Cloudflare tidak valid.');
const name='database-nota-ocr',statePath='local-data/ocr-relay.json',api='https://api.cloudflare.com/client/v4/accounts/'+account;
async function cf(path,method='GET',body){const response=await fetch(api+path,{method,headers:{authorization:'Bearer '+token,...(body instanceof FormData?{}:body?{'content-type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const value=await response.json();if(!response.ok||!value.success)throw new Error('Cloudflare menolak '+method+' '+path+' (HTTP '+response.status+', kode '+(value.errors||[]).map(e=>e.code).join(',')+').');return value.result;}
const existing=await cf('/workers/scripts'),hasState=fs.existsSync(statePath);
if(existing.some(w=>w.id===name)&&!hasState)throw new Error('Worker dengan nama ini sudah ada. Tidak ditimpa otomatis.');
const subdomain=await cf('/workers/subdomain');if(!subdomain?.subdomain)throw new Error('Aktifkan workers.dev di menu Workers & Pages terlebih dahulu.');
const state=hasState?JSON.parse(fs.readFileSync(statePath,'utf8')):{account,name,secret:randomBytes(32).toString('base64url')};if(state.account!==account||state.name!==name)throw new Error('Akun konfigurasi relay tidak cocok.');
state.url='https://'+name+'.'+subdomain.subdomain+'.workers.dev';fs.writeFileSync(statePath,JSON.stringify(state,null,2),{mode:0o600});
const form=new FormData();form.set('metadata',JSON.stringify({main_module:'worker.mjs',compatibility_date:'2026-09-01',bindings:[{type:'secret_text',name:'RELAY_SECRET',text:state.secret},{type:'secret_text',name:'GEMINI_API_KEY',text:key},{type:'plain_text',name:'ALLOWED_MODELS',text:[...new Set([primary,fallback,legacyModel])].join(',')}],observability:{enabled:false}}));form.set('worker.mjs',new Blob([fs.readFileSync('ops/cloudflare/ocr-relay.mjs','utf8')],{type:'application/javascript+module'}),'worker.mjs');
await cf('/workers/scripts/'+name,'PUT',form);await cf('/workers/scripts/'+name+'/subdomain','POST',{enabled:true,previews_enabled:false});console.log({deployed:true,url:state.url,applicationActivated:false});
