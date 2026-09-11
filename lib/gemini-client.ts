import {invariant} from './errors';
export async function geminiFetch(model:string,payload:unknown){
 const body=JSON.stringify(payload),relay=process.env.OCR_RELAY_URL;
 if(relay){
  const base=new URL(relay);invariant(base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_RELAY','Alamat penghubung OCR tidak valid.',503);
  invariant(process.env.OCR_RELAY_SECRET,'RELAY_NOT_CONFIGURED','Rahasia penghubung OCR belum tersedia.',503);
  return fetch(new URL('/v1beta/models/'+encodeURIComponent(model)+':generateContent',base),{method:'POST',headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body)),authorization:'Bearer '+process.env.OCR_RELAY_SECRET},body,redirect:'error',signal:AbortSignal.timeout(125000)});
 }
 invariant(process.env.GEMINI_API_KEY,'OCR_NOT_CONFIGURED','Kunci Gemini belum tersedia.',503);
 return fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY!},body,signal:AbortSignal.timeout(120000)});
}
