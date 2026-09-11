import {transaction} from './db';import {type User,requireRole} from './identity';import {invariant} from './errors';import {mutateOnce} from './jobs';
export async function reviewAction(user:User,action:string,p:any,key:string){
 requireRole(user,['ADMIN','TAX']);
 return transaction(async db=>{
  const id=String(p.receiptId||'');
  if(action==='RELEASE_RECEIPT_REVIEW'){await db.query('DELETE FROM nota_app.review_claims WHERE receipt_id=$1 AND uid=$2',[id,user.uid]);return {success:true};}
  const row=(await db.query('SELECT * FROM nota_app.receipts WHERE id=$1 FOR UPDATE',[id])).rows[0];invariant(row,'NOT_FOUND','Nota tidak ditemukan.',404);
  if(action==='CLAIM_RECEIPT_REVIEW'){
   const existing=(await db.query('SELECT c.*,p.display_name FROM nota_app.review_claims c JOIN nota_app.profiles p ON p.uid=c.uid WHERE receipt_id=$1 AND expires_at>now()',[id])).rows[0];
   if(existing&&existing.uid!==user.uid&&p.takeover!==true)return {success:false,occupied:true,message:'Nota sedang direview oleh '+existing.display_name+'.'};
   await db.query("INSERT INTO nota_app.review_claims(receipt_id,uid,expires_at) VALUES($1,$2,now()+interval '90 seconds') ON CONFLICT(receipt_id) DO UPDATE SET uid=$2,expires_at=now()+interval '90 seconds'",[id,user.uid]);return {success:true};
  }
  return mutateOnce(db,user,action,key,p,async()=>{
   invariant(Number(p.expectedVersion)===row.version,'VERSION_CONFLICT','Nota telah berubah. Muat ulang sebelum melanjutkan.',409);
   invariant(row.status==='REJECTED'&&row.data.review?.decision==='DISCARD','RECEIPT_LOCKED','Hanya nota Tidak Digunakan yang dapat dikembalikan ke review.');
   const data={...row.data,reviewHistory:[...(row.data.reviewHistory||[]).slice(-19),row.data.review],review:{},restoredAt:Date.now(),restoredBy:user.uid};
   await db.query("UPDATE nota_app.receipts SET status='PENDING',data=$2,version=version+1,updated_at=now() WHERE id=$1",[id,JSON.stringify(data)]);await db.query('INSERT INTO nota_app.audit_events(uid,action,entity_id) VALUES($1,$2,$3)',[user.uid,action,id]);return {success:true};
  });
 });
}
