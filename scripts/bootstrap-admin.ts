import fs from 'node:fs';
import { provisionAccount } from '../lib/accounts';
import { database } from '../lib/db';
try { process.loadEnvFile('.env.local'); } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const file=process.argv[2];
if(!file)throw new Error('Berikan path file JSON lokal berisi username, displayName, dan password admin.');
try {
 const input=JSON.parse(fs.readFileSync(file,'utf8'));
 await provisionAccount({...input,role:'ADMIN'},'bootstrap',true);
 console.log('Admin pertama berhasil dibuat. Password tidak ditampilkan.');
} finally {await database().end();}
