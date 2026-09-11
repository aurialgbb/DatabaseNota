#!/usr/bin/python3
import base64, datetime, fcntl, hashlib, json, os, pathlib, re, subprocess, sys, tempfile, uuid
import boto3
from botocore.config import Config
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
ROOT = pathlib.Path('/var/lib/nota-backup')
MAGIC = b'NOTABK1'

def run(args, **kw):
    return subprocess.run(args, check=True, timeout=600, stderr=subprocess.PIPE, **kw)

def sql(db, query):
    return run(['runuser','-u','postgres','--','psql','-X','-At','-v','ON_ERROR_STOP=1','-d',db,'-c',query], stdout=subprocess.PIPE).stdout.decode().strip()

def encrypt(src, dst, key):
    nonce = os.urandom(12)
    enc = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    enc.authenticate_additional_data(MAGIC)
    with open(src,'rb') as inp, open(dst,'wb') as out:
        out.write(MAGIC + nonce)
        while block := inp.read(1024*1024): out.write(enc.update(block))
        out.write(enc.finalize()); out.write(enc.tag)

def decrypt(src, dst, key):
    size = src.stat().st_size
    with open(src,'rb') as inp, open(dst,'wb') as out:
        if size < 35 or inp.read(7) != MAGIC: raise ValueError('INVALID_BACKUP')
        nonce = inp.read(12)
        inp.seek(-16,2); tag = inp.read(16); inp.seek(19)
        dec = Cipher(algorithms.AES(key),modes.GCM(nonce,tag)).decryptor()
        dec.authenticate_additional_data(MAGIC)
        remaining = size-35
        while remaining:
            block=inp.read(min(1024*1024,remaining))
            if not block: raise ValueError('TRUNCATED_BACKUP')
            remaining-=len(block);out.write(dec.update(block))
        out.write(dec.finalize())

def main():
    os.umask(0o077);ROOT.mkdir(mode=0o700,exist_ok=True)
    with open(ROOT/'backup.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        key=base64.b64decode(pathlib.Path('/etc/nota/backup-key').read_text().strip())
        now=datetime.datetime.now(datetime.timezone.utc)
        with tempfile.TemporaryDirectory(prefix='work-',dir=ROOT) as temp:
            work=pathlib.Path(temp);dump=work/'nota.dump'
            with open(dump,'wb') as out:
                run(['runuser','-u','postgres','--','pg_dump','-Fc','--no-owner','--no-privileges','-d','nota'],stdout=out)
            name=now.strftime('nota-%Y%m%dT%H%M%SZ-')+uuid.uuid4().hex[:8]+'.enc'
            target=ROOT/name
            encrypt(dump,target,key)
            report={'at':now.isoformat(),'file':name,'bytes':target.stat().st_size,'encrypted':True,'offsite':False}
            cfg=json.loads(pathlib.Path('/etc/nota/backup-r2.json').read_text())
            s3=boto3.client('s3',region_name='auto',endpoint_url=cfg['endpoint'],aws_access_key_id=cfg['access_key'],aws_secret_access_key=cfg['secret_key'],config=Config(connect_timeout=10,read_timeout=60,retries={'max_attempts':3}))
            object_key=cfg['prefix']+name
            with open(target,'rb') as inp: digest=hashlib.file_digest(inp,'sha256').hexdigest()
            s3.upload_file(str(target),cfg['bucket'],object_key,ExtraArgs={'ContentType':'application/octet-stream','Metadata':{'sha256':digest}})
            downloaded=work/'remote-copy.enc'
            s3.download_file(cfg['bucket'],object_key,str(downloaded))
            with open(downloaded,'rb') as inp:
                if hashlib.file_digest(inp,'sha256').hexdigest()!=digest: raise ValueError('REMOTE_CHECKSUM_MISMATCH')
            report.update({'offsite':True,'bucket':cfg['bucket'],'object_key':object_key,'remote_readback':True,'sha256':digest})
            if '--restore-test' in sys.argv:
                restored=work/'restored.dump';decrypt(downloaded,restored,key)
                with open(dump,'rb') as a,open(restored,'rb') as b:
                    if hashlib.file_digest(a,'sha256').digest()!=hashlib.file_digest(b,'sha256').digest(): raise ValueError('CHECKSUM_MISMATCH')
                expected=sql('nota',"SELECT string_agg(version,',' ORDER BY version) FROM nota_app.schema_migrations")
                db='nota_restore_'+uuid.uuid4().hex[:12]
                assert re.fullmatch(r'nota_restore_[a-f0-9]{12}',db)
                sql('postgres','CREATE DATABASE '+db)
                try:
                    with open(restored,'rb') as inp:
                        run(['runuser','-u','postgres','--','pg_restore','--exit-on-error','--no-owner','--no-privileges','-d',db],stdin=inp,stdout=subprocess.PIPE)
                    actual=sql(db,"SELECT string_agg(version,',' ORDER BY version) FROM nota_app.schema_migrations")
                    tables=sql(db,"SELECT count(*) FROM information_schema.tables WHERE table_schema='nota_app'")
                    if actual!=expected or tables!='22':raise ValueError('RESTORE_MISMATCH')
                    report['restore_test']={'ok':True,'tables':int(tables),'migrations':actual}
                finally:sql('postgres','DROP DATABASE '+db)
                (ROOT/'last-restore-test.json').write_text(json.dumps(report,indent=2))
            (ROOT/'last-success.json').write_text(json.dumps(report,indent=2))
            print(json.dumps(report))
        remote_cutoff=now-datetime.timedelta(days=30)
        pattern=re.compile(re.escape(cfg['prefix'])+r'nota-\d{8}T\d{6}Z-[a-f0-9]{8}\.enc')
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=cfg['bucket'],Prefix=cfg['prefix']):
            for obj in page.get('Contents',[]):
                if pattern.fullmatch(obj['Key']) and obj['LastModified']<remote_cutoff:
                    s3.delete_object(Bucket=cfg['bucket'],Key=obj['Key'])
        cutoff=now.timestamp()-7*86400
        for old in ROOT.glob('nota-*.enc'):
            if re.fullmatch(r'nota-\d{8}T\d{6}Z-[a-f0-9]{8}\.enc',old.name) and old.stat().st_mtime<cutoff:old.unlink()
if __name__=='__main__':
    try:main()
    except Exception as e:
        print('BACKUP_FAILED: '+type(e).__name__,file=sys.stderr);sys.exit(1)
