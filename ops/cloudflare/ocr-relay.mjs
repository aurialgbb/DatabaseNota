const reply=(status,message)=>Response.json({error:{message}},{status,headers:{'cache-control':'no-store'}});
export default {
 async fetch(request,env){
  if(!env.RELAY_SECRET||!env.GEMINI_API_KEY)return reply(503,'Relay belum dikonfigurasi.');
  const given=request.headers.get('authorization')||'',wanted='Bearer '+env.RELAY_SECRET;
  const digest=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  const [a,b]=await Promise.all([digest(given),digest(wanted)]);let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
  if(mismatch)return reply(401,'Unauthorized');
  const url=new URL(request.url),match=url.pathname.match(/^\/v1beta\/models\/([a-zA-Z0-9._-]+):generateContent$/);
  if(request.method!=='POST'||!match||url.search||!(env.ALLOWED_MODELS||'').split(',').includes(match[1]))return reply(404,'Not found');
  const size=Number(request.headers.get('content-length'));
  if(!Number.isInteger(size)||size<=0||size>24*1024*1024)return reply(413,'Ukuran permintaan tidak valid.');
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,'Gunakan JSON.');
  try{
   const upstream=await fetch('https://generativelanguage.googleapis.com'+url.pathname,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:request.body,redirect:'manual',signal:AbortSignal.timeout(120000)});
   if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel();return reply(502,'Redirect penyedia OCR ditolak.');}
   return new Response(upstream.body,{status:upstream.status,headers:{'content-type':'application/json','cache-control':'no-store','x-nota-relay':'1','x-nota-colo':request.cf?.colo||'unknown'}});
  }catch{return reply(502,'Gemini belum merespons.');}
 }
};
