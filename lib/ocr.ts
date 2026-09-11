import { GetObjectCommand } from '@aws-sdk/client-s3';
import { database } from './db';
import { storage } from './storage';
import { AppError, invariant } from './errors';
import { storePrompt,legacyPrompt,primary,fallback,legacyModel } from '../generated/prompts.mjs';
import { portalNormalizeOcrReceipts_ } from '../generated/receipt-domain.mjs';

export async function runOcr(job:any) {
 const db=database();
 const photo=(await db.query("SELECT * FROM nota_app.photos WHERE id=$1 AND state='READY'",[job.payload.photoId])).rows[0];
 invariant(photo,'PHOTO_NOT_READY','Foto belum siap.');
 invariant(job.uid===photo.owner_uid,'FORBIDDEN','Foto bukan milik pengirim.',403);
 const object=await storage().send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:photo.object_key}));
 const base64=Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
 invariant(process.env.GEMINI_API_KEY,'OCR_NOT_CONFIGURED','OCR belum dikonfigurasi.',503);
 const categories=(await db.query('SELECT name FROM nota_app.categories ORDER BY position,name')).rows.map((r:any)=>r.name);
 const isLegacy=job.kind==='LEGACY_OCR';
 const prompt=isLegacy?legacyPrompt():storePrompt(categories);
 let lastError:unknown;
 for(let attempt=1;attempt<=(isLegacy?3:2);attempt++){
  const model=isLegacy?legacyModel:attempt===2?fallback:primary;
  const step='gemini-'+attempt;
  const previous=(await db.query('SELECT * FROM nota_app.job_steps WHERE job_id=$1 AND step_key=$2',[job.id,step])).rows[0];
  if(previous?.status==='SUCCEEDED')return previous.result;
  if(previous?.status==='RUNNING')throw new AppError('OCR_OUTCOME_UNKNOWN','Respons OCR sebelumnya belum dapat dipastikan.',409);
  await db.query("INSERT INTO nota_app.job_steps(job_id,step_key,status,attempts) VALUES($1,$2,'RUNNING',1) ON CONFLICT(job_id,step_key) DO UPDATE SET status='RUNNING',attempts=job_steps.attempts+1,updated_at=now()",[job.id,step]);
  try{
   const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
    method:'POST',headers:{'content-type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY!},
    body:JSON.stringify({contents:[{parts:[{text:prompt},{inlineData:{mimeType:photo.mime_type,data:base64}}]}],generationConfig:isLegacy?{temperature:0.0,responseMimeType:'application/json'}:{responseMimeType:'application/json',maxOutputTokens:8192}}),signal:AbortSignal.timeout(120000)
   });
   if(response.status===429||response.status>=500)throw new AppError('RETRYABLE_HTTP','Layanan OCR sementara sibuk.',503);
   if(!response.ok){
    const failure=await response.json().catch(()=>({}));
    if(response.status===400&&/location is not supported/i.test(failure.error?.message||''))throw new AppError('OCR_REGION_UNAVAILABLE','Gemini belum menerima lokasi IP server. Hubungi admin; nota masih bisa diisi secara manual.',503);
    throw new AppError('OCR_PROVIDER_ERROR','Penyedia OCR menolak permintaan.',502);
   }
   const body=await response.json();
   const output=body.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||'').join('')||'';
   let parsed:any;
   try{parsed=JSON.parse(output.replace(/```json/gi,'').replace(/```/g,'').trim());}catch{throw new AppError('RETRYABLE_OUTPUT','Hasil OCR belum dapat dibaca.',502);}
   invariant(isLegacy?parsed&&Array.isArray(parsed.items):parsed&&Array.isArray(parsed.receipts),'RETRYABLE_OUTPUT','Format hasil OCR tidak sesuai.',502);
   const result=isLegacy?[{success:true,data:parsed}]:{success:true,pending:false,clientPhotoId:job.payload.clientPhotoId,index:job.payload.index,fileName:job.payload.fileName,photoId:photo.id,receipts:portalNormalizeOcrReceipts_(parsed.receipts,photo.id),warnings:parsed.warnings||[],modelUsed:model,attemptCount:attempt};
   await db.query("UPDATE nota_app.job_steps SET status='SUCCEEDED',result=$3,updated_at=now() WHERE job_id=$1 AND step_key=$2",[job.id,step,JSON.stringify(result)]);
   return result;
  }catch(error){
   lastError=error;
   await db.query("UPDATE nota_app.job_steps SET status='FAILED',updated_at=now() WHERE job_id=$1 AND step_key=$2",[job.id,step]);
   const retryable=error instanceof AppError&&error.code.startsWith('RETRYABLE')||error instanceof Error&&/timeout|timed out/i.test(error.message);
   if(!retryable)throw error;
   if(attempt<(isLegacy?3:2))await new Promise(resolve=>setTimeout(resolve,2000));
  }
 }
 throw lastError;
}

export async function runText(job:any){
 invariant(process.env.GEMINI_API_KEY,'OCR_NOT_CONFIGURED','Kunci Gemini belum dikonfigurasi.',503);
 const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+legacyModel+':generateContent',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY!},body:JSON.stringify({contents:[{parts:[{text:job.payload.prompt}]}],...(job.payload.isJson?{generationConfig:{responseMimeType:'application/json'}}:{})}),signal:AbortSignal.timeout(120000)});
 if(!response.ok){const failure=await response.json().catch(()=>({}));if(response.status===400&&/location is not supported/i.test(failure.error?.message||''))throw new AppError('OCR_REGION_UNAVAILABLE','Gemini belum menerima lokasi IP server. Hubungi admin; nota masih bisa diisi secara manual.',503);throw new AppError('OCR_PROVIDER_ERROR','Permintaan AI belum berhasil.',502);}const body=await response.json();const output=body.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||'').join('');invariant(output,'OCR_EMPTY','AI belum mengembalikan hasil.',502);return output.replace(/```json/gi,'').replace(/```/g,'').trim();
}
