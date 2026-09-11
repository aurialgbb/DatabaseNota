import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccount,validatePassword } from '../lib/accounts';
import { requireRole,type User } from '../lib/identity';
test('Validasi akun menolak role asing dan username tidak aman',()=>{
 assert.throws(()=>validateAccount({username:'abc',displayName:'A',role:'SUPERADMIN'}));
 assert.throws(()=>validateAccount({username:'<script>',displayName:'A',role:'ADMIN'}));
 assert.equal(validateAccount({username:'Cabang.A',displayName:'Cabang A',role:'TOKO',branchId:'a'}).username,'cabang.a');
 assert.throws(()=>validatePassword('short'));
 assert.throws(()=>validatePassword('x'.repeat(129)));
 assert.equal(validatePassword('long-enough-password'),'long-enough-password');
});
test('Akun cabang tidak boleh menjalankan pengelolaan admin',()=>{
 const user={role:'TOKO'} as User;
 assert.throws(()=>requireRole(user,['ADMIN']));
 assert.throws(()=>requireRole({...user,role:'TAX'},['ADMIN']));
 requireRole({...user,role:'ADMIN'},['ADMIN']);
});
