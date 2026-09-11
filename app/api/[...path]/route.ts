import { login, logout, requireSession, setupStatus } from '@/lib/auth';
import { rpc } from '@/lib/rpc';
import { checkOrigin } from '@/lib/identity';
import { invariant, publicError, AppError } from '@/lib/errors';
import { database } from '@/lib/db';
import { authorizedJob } from '@/lib/jobs';
import { prepareUpload, completeUpload, photoUrl } from '@/lib/storage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reply = (result: unknown, headers?: HeadersInit) => Response.json({ok:true,result},{headers});
async function handle(request: Request, context: {params: Promise<{path:string[]}>}) {
  try {
    const path = (await context.params).path.join('/');
    if (request.method === 'GET' && path === 'setup') return reply(await setupStatus());
    if (request.method === 'POST') checkOrigin(request);
    let payload: any = {};
    if (request.method === 'POST') {
      invariant(Number(request.headers.get('content-length') || 0) <= 1024*1024,'PAYLOAD_TOO_LARGE','Unggah foto melalui penyimpanan langsung.',413);
      const text=await request.text();
      invariant(Buffer.byteLength(text)<=1024*1024,'PAYLOAD_TOO_LARGE','Permintaan terlalu besar.',413);
      try { payload=JSON.parse(text || '{}'); } catch { throw new AppError('INVALID_JSON','Format permintaan tidak valid.'); }
      invariant(payload && typeof payload==='object' && !Array.isArray(payload),'INVALID_PAYLOAD','Permintaan tidak valid.');
    }
    if (path==='auth/login' && request.method==='POST') {
      const result=await login(payload,request);
      return reply({user:result.user},result.headers);
    }
    if (path==='auth/logout' && request.method==='POST') {
      return reply({success:true},await logout(request));
    }
    const user=await requireSession(request);
    if(path==='rpc' && request.method==='POST')return reply(await rpc(user,payload,request));
    if (path==='auth/session' && request.method==='GET') return reply(user);
    if (path==='uploads' && request.method==='POST') return reply(await prepareUpload(user,payload));
    const complete=path.match(/^uploads\/([0-9a-f-]+)\/complete$/i);
    if (complete && request.method==='POST') return reply(await completeUpload(user,complete[1]));
    const photo=path.match(/^photos\/([0-9a-f-]{36})$/i);
    if(photo&&request.method==='GET')return new Response(null,{status:307,headers:{Location:await photoUrl(user,photo[1],new URL(request.url).searchParams.get('thumbnail')==='1'),'Cache-Control':'no-store'}});
    const job=path.match(/^jobs\/([0-9a-f-]+)$/i);
    if (job && request.method==='GET') {
      const row=await authorizedJob(database(),user,job[1]);
      return reply({operationId:row.id,kind:row.kind,status:row.status,progress:row.progress,result:row.result,errorCode:row.error_code});
    }
    throw new AppError('NOT_IMPLEMENTED','Fitur ini belum selesai dipindahkan ke aplikasi baru.',501);
  } catch(error) {
    const safe=publicError(error);
    return Response.json({ok:false,error:{code:safe.code,message:safe.message}},{status:safe.status});
  }
}
export {handle as GET,handle as POST};

