import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError,invariant } from './errors';
let cached:{value:string;expires:number}|undefined;
async function accessToken(){
 if(cached&&cached.expires>Date.now()+60000)return cached.value;
 const raw=process.env.GOOGLE_SERVICE_ACCOUNT_JSON||(process.env.GOOGLE_SERVICE_ACCOUNT_FILE?readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE,'utf8'):'');
 invariant(raw,'SHEETS_NOT_CONFIGURED','Akses Spreadsheet belum dikonfigurasi.',503);
 let c:any;try{c=JSON.parse(raw);}catch{throw new AppError('SHEETS_NOT_CONFIGURED','Konfigurasi akun Spreadsheet tidak valid.',503);}
 invariant(c.client_email&&c.private_key,'SHEETS_NOT_CONFIGURED','Kredensial Spreadsheet belum lengkap.',503);
 const enc=(x:any)=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const body=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:c.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+300});
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:body+'.'+sign('RSA-SHA256',Buffer.from(body),c.private_key).toString('base64url')}),signal:AbortSignal.timeout(20000)});
 invariant(response.ok,'SHEETS_AUTH_FAILED','Autentikasi akun Spreadsheet belum berhasil.',502);
 const token=await response.json();cached={value:token.access_token,expires:Date.now()+Number(token.expires_in)*1000};return cached.value;
}
export async function sheetsRequest(id:string,suffix='',method='GET',body?:unknown){
 invariant(/^[A-Za-z0-9_-]{20,150}$/.test(id),'INVALID_SHEET','ID Spreadsheet tidak valid.');
 let response:Response;for(let attempt=0;;attempt++){response=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+id+suffix,{method,headers:{authorization:'Bearer '+await accessToken(),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(response.status!==429||attempt>=4)break;await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,1000*2**attempt+Math.floor(Math.random()*500)));}
 if(response.status===403)throw new AppError('SHEET_ACCESS_DENIED','Bagikan Spreadsheet ke service account sebagai Editor, lalu coba lagi.',403);
 if(response.status===404)throw new AppError('SHEET_NOT_FOUND','Spreadsheet tidak ditemukan atau belum dibagikan ke service account.',404);
 invariant(response.ok,'SHEETS_REQUEST_FAILED','Permintaan Spreadsheet belum berhasil ('+response.status+'). Periksa hasil sebelum mengulang perubahan.',502);
 return response.json();
}
export function quoteTab(title:string){return "'"+title.replaceAll("'","''")+"'";}
