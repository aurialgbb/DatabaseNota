import { database, transaction } from './db';
import { invariant } from './errors';
import { tokenHash, type User } from './identity';
import { accountAuth } from './better-auth';
export function userFromRow(row:any):User {return {uid:row.uid,username:row.username,displayName:row.display_name,role:row.role,branchId:row.branch_id||'',branchName:row.branch_name||'',branchType:row.branch_type||'',active:row.active};}
export const profileSelect='SELECT p.*, b.name AS branch_name,b.type AS branch_type FROM nota_app.profiles p LEFT JOIN nota_app.branches b ON b.id=p.branch_id ';
export async function login(payload:any, request:Request) {
 const username=String(payload.username||'').trim().toLowerCase();
 invariant(username&&typeof payload.password==='string'&&payload.password.length<=128,'INVALID_LOGIN','Username dan password wajib diisi.');
 const db=database();
 const rate=await db.query("INSERT INTO nota_app.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END, expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING count",['login:'+tokenHash(username)]);
 invariant(rate.rows[0].count<=20,'RATE_LIMIT','Terlalu banyak percobaan login. Coba lagi nanti.',429);
 const row=(await db.query(profileSelect+' WHERE p.username=$1',[username])).rows[0];
 const response=await accountAuth().api.signInEmail({body:{email:row?.auth_email||'unknown@accounts.invalid',password:payload.password},headers:request.headers,asResponse:true});
 if(response.ok && row && !row.active)await db.query('DELETE FROM nota_app.auth_session WHERE "userId"=$1',[row.uid]);
 invariant(response.ok&&row?.active,'INVALID_CREDENTIALS','Username atau password salah.',401);
 const result=await response.json();
 invariant(result.user.id===row.uid,'INVALID_CREDENTIALS','Username atau password salah.',401);
 const stillActive=(await db.query('SELECT active FROM nota_app.profiles WHERE uid=$1',[row.uid])).rows[0]?.active;
 if(!stillActive){await db.query('DELETE FROM nota_app.auth_session WHERE "userId"=$1',[row.uid]); invariant(false,'ACCOUNT_DISABLED','Akun sudah dinonaktifkan.',401);}
 await transaction(async tx=>{
  await tx.query("INSERT INTO nota_app.audit_events(uid,action) VALUES($1,'LOGIN')",[row.uid]);
  await tx.query('DELETE FROM nota_app.auth_rate_limits WHERE key=$1',['login:'+tokenHash(username)]);
 });
 const headers=new Headers();for(const cookie of response.headers.getSetCookie())headers.append('set-cookie',cookie);
 return {headers,user:{...userFromRow(row),sessionExpiresAt:Date.now()+4*3600000,mustChangePassword:false}};
}
export async function requireSession(request:Request):Promise<User> {
 const session=await accountAuth().api.getSession({headers:request.headers});
 invariant(session,'SESSION_EXPIRED','Sesi telah berakhir. Silakan login kembali.',401);
 const row=(await database().query(profileSelect+' WHERE p.uid=$1 AND p.active=true',[session.user.id])).rows[0];
 invariant(row,'SESSION_EXPIRED','Sesi telah berakhir. Silakan login kembali.',401);
 return {...userFromRow(row),sessionExpiresAt:new Date(session.session.expiresAt).getTime()} as User;
}
export async function logout(request:Request) {
 const response=await accountAuth().api.signOut({headers:request.headers,asResponse:true});
 const headers=new Headers();for(const cookie of response.headers.getSetCookie())headers.append('set-cookie',cookie);
 return headers;
}
export async function setupStatus() {
 const missing=['DATABASE_URL','BETTER_AUTH_SECRET'].filter(key=>!process.env[key]);
 let hasAdmin=false,databaseReady=false;
 if(!missing.includes('DATABASE_URL'))try{
  hasAdmin=!!(await database().query("SELECT 1 FROM nota_app.profiles p JOIN nota_app.auth_user u ON u.id=p.uid JOIN nota_app.auth_account a ON a.\"userId\"=u.id WHERE p.role='ADMIN' AND p.active=true AND a.\"providerId\"='credential' LIMIT 1")).rows.length;
  databaseReady=true;
 }catch{}
 return {ready:!missing.length&&hasAdmin&&databaseReady,missingProperties:missing,hasAdmin,adminRecordCount:hasAdmin?1:0,databaseReady,recoveryMode:false,bootstrapSecretConfigured:false,diagnostic:databaseReady?'':'Database login belum siap.',features:{ocr:!!process.env.GEMINI_API_KEY&&process.env.OCR_WORKER_ENABLED==='true',ocrConfigured:!!process.env.GEMINI_API_KEY,sheets:false,sheetsConfigured:!!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE)}};
}

