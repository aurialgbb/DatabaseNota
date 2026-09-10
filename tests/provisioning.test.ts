import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {provisionDatabase} from '../scripts/provision-database.mjs';
const password='a'.repeat(48);
async function migrations() {
  return Promise.all((await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile('migrations/'+name,'utf8')})));
}
test('Provisioning grants only runtime DML and preserves another application',async()=>{
  const pg=new PGlite();
  try {
    await pg.exec("CREATE TABLE public.other_app(marker text); INSERT INTO public.other_app VALUES('keep');");
    const db={query:(sql:string,params?:any[])=>params?pg.query(sql,params):pg.exec(sql).then(result=>result[result.length-1])};
    await provisionDatabase(db,password,await migrations());
    await pg.exec('SET ROLE nota_app_runtime');
    await pg.query("INSERT INTO nota_app.branches(id,name) VALUES('b1','Branch')");
    assert.equal((await pg.query('SELECT * FROM nota_app.branches')).rows.length,1);
    await assert.rejects(()=>pg.query('SELECT * FROM public.other_app'));
    await assert.rejects(()=>pg.query('CREATE TABLE nota_app.forbidden(id int)'));
    await assert.rejects(()=>pg.query('DELETE FROM nota_app.schema_migrations'));
    await pg.exec('RESET ROLE');
    assert.deepEqual((await pg.query('SELECT * FROM public.other_app')).rows,[{marker:'keep'}]);
  } finally { await pg.close(); }
});
test('Provisioning rolls back rather than revoke shared PUBLIC privileges',async()=>{
  const pg=new PGlite();
  try {
    await pg.exec('CREATE TABLE public.shared(id int); GRANT SELECT ON public.shared TO PUBLIC');
    const db={query:(sql:string,params?:any[])=>params?pg.query(sql,params):pg.exec(sql).then(result=>result[result.length-1])};
    const files = await migrations();
    await assert.rejects(()=>provisionDatabase(db,password,files),/PUBLIC_PRIVILEGES_PREVENT_ISOLATION/);
    assert.equal((await pg.query("SELECT 1 FROM pg_namespace WHERE nspname='nota_app'")).rows.length,0);
    assert.equal((await pg.query("SELECT 1 FROM pg_roles WHERE rolname='nota_app_runtime'")).rows.length,0);
    assert.equal((await pg.query<{allowed:boolean}>("SELECT has_table_privilege('public.shared','SELECT') AS allowed")).rows[0].allowed,true);
  } finally { await pg.close(); }
});
