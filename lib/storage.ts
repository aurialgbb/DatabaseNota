import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { database } from './db';
import { invariant } from './errors';
import { requireBranch, type User } from './identity';

export function storage() {
  for (const key of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET']) invariant(process.env[key], 'STORAGE_NOT_CONFIGURED', 'Penyimpanan foto belum dikonfigurasi.', 503);
  return new S3Client({ region:'auto', endpoint:'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com', credentials:{ accessKeyId:process.env.R2_ACCESS_KEY_ID!, secretAccessKey:process.env.R2_SECRET_ACCESS_KEY! } });
}
export async function prepareUpload(user: User, payload: any) {
  const bytes = Number(payload.size);
  invariant(Number.isInteger(bytes) && bytes > 0 && bytes <= 15 * 1024 * 1024, 'INVALID_SIZE', 'Ukuran foto tidak valid.');
  invariant(['image/jpeg','image/png','image/webp'].includes(payload.mimeType), 'INVALID_MEDIA', 'Format foto tidak didukung.');
  const branchId = user.role === 'TOKO' ? user.branchId : String(payload.branchId || '');
  requireBranch(user, branchId);
  const id = randomUUID(), key = (process.env.APP_ENV || 'development') + '/' + id + '/original';
  const thumb = key.replace('/original','/thumbnail');
  const client = storage();
  const uploadUrl = await getSignedUrl(client,new PutObjectCommand({ Bucket:process.env.R2_BUCKET, Key:key, ContentType:payload.mimeType }),{ expiresIn:300 });
  const thumbnailUploadUrl = await getSignedUrl(client,new PutObjectCommand({ Bucket:process.env.R2_BUCKET, Key:thumb, ContentType:'image/jpeg' }),{ expiresIn:300 });
  await database().query("INSERT INTO nota_app.photos(id,owner_uid,branch_id,object_key,thumbnail_key,mime_type,byte_size,state,upload_group) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)", [id,user.uid,branchId || null,key,thumb,payload.mimeType,bytes,payload.uploadId || null]);
  return { photoId:id, uploadUrl, thumbnailUploadUrl, expiresIn:300 };
}
export async function ownedPhoto(user: User,id: string) {
  invariant(/^[0-9a-f-]{36}$/i.test(id),'INVALID_PHOTO','Foto tidak valid.');
  const row = (await database().query('SELECT * FROM nota_app.photos WHERE id=$1',[id])).rows[0];
  invariant(row && row.state !== 'DELETED', 'NOT_FOUND','Foto tidak ditemukan.',404);
  requireBranch(user,row.branch_id || '');
  if (user.role === 'TOKO') invariant(row.owner_uid === user.uid || row.state === 'READY','FORBIDDEN','Foto tidak dapat diakses.',403);
  return row;
}
export async function completeUpload(user: User,id: string) {
  const row = await ownedPhoto(user,id);
  invariant(row.owner_uid === user.uid,'FORBIDDEN','Unggahan bukan milik akun ini.',403);
  const client=storage();
  const head = await client.send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET,Key:row.object_key}));
  invariant(Number(head.ContentLength) === Number(row.byte_size) && head.ContentType === row.mime_type,'UPLOAD_MISMATCH','Berkas unggahan belum lengkap atau tidak sesuai.');
  const result = await client.send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:row.object_key,Range:'bytes=0-15'}));
  const prefix = Buffer.from(await result.Body!.transformToByteArray());
  const valid = row.mime_type === 'image/jpeg' ? prefix[0] === 255 && prefix[1] === 216 :
    row.mime_type === 'image/png' ? prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    prefix.toString('ascii',0,4) === 'RIFF' && prefix.toString('ascii',8,12) === 'WEBP';
  invariant(valid,'INVALID_MEDIA','Isi berkas bukan gambar yang didukung.');
  await database().query("UPDATE nota_app.photos SET state='READY' WHERE id=$1 AND state='PENDING'",[id]);
  return { success:true,photoId:id };
}
export async function photoUrl(user: User,id: string,thumbnail=false) {
  const row=await ownedPhoto(user,id);
  invariant(row.state === 'READY','PHOTO_PENDING','Foto belum selesai diunggah.',409);
  let key=row.object_key;
  if (thumbnail && row.thumbnail_key) {
    try {
      const h=await storage().send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET,Key:row.thumbnail_key}));
      if (h.ContentType === 'image/jpeg' && Number(h.ContentLength) <= 200*1024) key=row.thumbnail_key;
    } catch {}
  }
  return getSignedUrl(storage(),new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:key}),{expiresIn:120});
}
