import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { database, transaction } from './db';
import { invariant, AppError } from './errors';
import { requireRole, type User } from './identity';
import { profileSelect, userFromRow } from './auth';
export function validateAccount(input:any) {
 const username=String(input.username||'').trim().toLowerCase();
 invariant(/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username),'INVALID_USERNAME','Username 3–50 karakter: huruf, angka, titik, garis bawah, atau tanda minus.');
 const displayName=String(input.displayName||'').trim();
 invariant(displayName.length>0&&displayName.length<=100,'INVALID_NAME','Nama wajib diisi, maksimal 100 karakter.');
 const role=String(input.role||'TOKO');invariant(['ADMIN','TAX','TOKO'].includes(role),'INVALID_ROLE','Peran tidak valid.');
 return {username,displayName,role,branchId:role==='TOKO'?String(input.branchId||''):null};
}
export function validatePassword(value:any) {invariant(typeof value==='string'&&value.length>=12&&value.length<=128,'INVALID_PASSWORD','Password harus berisi 12–128 karakter.');return value as string;}
export async function provisionAccount(input:any,actor:string,bootstrap=false) {
 const data=validateAccount(input),password=validatePassword(input.password||randomBytes(18).toString('base64url'));
 const hashed=await hashPassword(password),uid=randomUUID(),email=uid+'@accounts.invalid';
 await transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('nota-account-management'))");
  if(bootstrap)invariant(!(await tx.query("SELECT 1 FROM nota_app.profiles WHERE role='ADMIN'")).rows.length,'ADMIN_EXISTS','Admin sudah tersedia.');
  invariant(!(await tx.query('SELECT 1 FROM nota_app.profiles WHERE username=$1',[data.username])).rows.length,'USERNAME_EXISTS','Username sudah digunakan.');
  if(data.role==='TOKO')invariant((await tx.query('SELECT 1 FROM nota_app.branches WHERE id=$1 AND active=true',[data.branchId])).rows.length,'BRANCH_REQUIRED','Pilih cabang aktif terlebih dahulu.');
  await tx.query('INSERT INTO nota_app.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',[uid,data.displayName,email]);
  await tx.query('INSERT INTO nota_app.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);
  await tx.query('INSERT INTO nota_app.profiles(uid,username,auth_email,display_name,role,branch_id) VALUES($1,$2,$3,$4,$5,$6)',[uid,data.username,email,data.displayName,data.role,data.branchId]);
  await tx.query("INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,'ACCOUNT_CREATE',$2)",[actor,uid]);
 });
 return {success:true,uid,...data,password};
}
export async function accountAction(user:User,action:string,payload:any) {
 requireRole(user,['ADMIN']);
 const db=database();
 if(action==='GET_ACCOUNTS')return (await db.query(profileSelect+' ORDER BY p.username')).rows.map(userFromRow);
 if(action==='PROVISION_ACCOUNTS') {
  invariant(Array.isArray(payload.rows)&&payload.rows.length>0&&payload.rows.length<=25,'INVALID_BATCH','Maksimal 25 akun per permintaan.');
  const results=[];for(const row of payload.rows){try{results.push(await provisionAccount(row,user.uid));}catch(e){results.push({success:false,username:String(row?.username||''),error:e instanceof AppError?e.message:'Akun belum dapat dibuat.'});}}
  return {results};
 }
 const uid=String(payload.uid||'');
 const hash=action==='RESET_ACCOUNT_PASSWORD'?await hashPassword(validatePassword(payload.newPassword)):null;
 return transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('nota-account-management'))");
  const previous=(await tx.query('SELECT * FROM nota_app.profiles WHERE uid=$1 FOR UPDATE',[uid])).rows[0];invariant(previous,'NOT_FOUND','Akun tidak ditemukan.',404);
  if(action==='SET_ACCOUNT_ACTIVE'){
   invariant(typeof payload.active==='boolean','INVALID_ACTIVE','Status akun tidak valid.');
   invariant(uid!==user.uid||payload.active,'SELF_DISABLE','Akun sendiri tidak boleh dinonaktifkan.');
   if(previous.role==='ADMIN'&&previous.active&&!payload.active)invariant(Number((await tx.query("SELECT count(*) FROM nota_app.profiles WHERE role='ADMIN' AND active=true")).rows[0].count)>1,'LAST_ADMIN','Admin aktif terakhir tidak boleh dinonaktifkan.');
   await tx.query('UPDATE nota_app.profiles SET active=$2,version=version+1 WHERE uid=$1',[uid,payload.active]);
  }else if(action==='RESET_ACCOUNT_PASSWORD'){
   await tx.query('UPDATE nota_app.auth_account SET password=$2,"updatedAt"=now() WHERE "userId"=$1 AND "providerId"=\'credential\'',[uid,hash]);
  }else if(action==='UPDATE_ACCOUNT'){
   const data=validateAccount(payload);
   if(previous.role==='ADMIN'&&data.role!=='ADMIN'){
    invariant(uid!==user.uid,'SELF_DEMOTE','Peran admin sendiri tidak boleh diturunkan.');
    invariant(Number((await tx.query("SELECT count(*) FROM nota_app.profiles WHERE role='ADMIN' AND active=true")).rows[0].count)>1,'LAST_ADMIN','Admin terakhir tidak boleh diubah.');
   }
   if(data.role==='TOKO')invariant((await tx.query('SELECT 1 FROM nota_app.branches WHERE id=$1 AND active=true',[data.branchId])).rows.length,'BRANCH_REQUIRED','Pilih cabang aktif.');
   invariant(!(await tx.query('SELECT 1 FROM nota_app.profiles WHERE username=$1 AND uid<>$2',[data.username,uid])).rows.length,'USERNAME_EXISTS','Username sudah digunakan.');
   await tx.query('UPDATE nota_app.profiles SET username=$2,display_name=$3,role=$4,branch_id=$5,version=version+1 WHERE uid=$1',[uid,data.username,data.displayName,data.role,data.branchId]);
   await tx.query('UPDATE nota_app.auth_user SET name=$2,"updatedAt"=now() WHERE id=$1',[uid,data.displayName]);
  }else throw new AppError('NOT_IMPLEMENTED','Pengelolaan akun ini belum tersedia.',501);
  await tx.query('DELETE FROM nota_app.auth_session WHERE "userId"=$1',[uid]);
  await tx.query('INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,$2,$3)',[user.uid,action,uid]);
  const row=(await tx.query(profileSelect+' WHERE p.uid=$1',[uid])).rows[0];
  return {success:true,account:userFromRow(row),active:row.active};
 });
}
