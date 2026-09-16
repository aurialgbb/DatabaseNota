import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Login Gate: form login disembunyikan sempurna saat login dan sesi aktif tanpa terblokir CSS mobile', async () => {
  const portalHtml = await readFile('public/portal.html', 'utf8');
  const workspaceCss = await readFile('public/brand/workspace.css', 'utf8');
  const identityCss = await readFile('public/brand/identity.css', 'utf8');
  const portalJs = await readFile('ui/portal_js.html', 'utf8');

  // 1. Initial markup portalGate memiliki atribut hidden dan class portal-hidden
  assert.match(portalHtml, /id="portalGate"[^>]*class="[^"]*portal-hidden[^"]*"[^>]*hidden/, 'portalGate awal harus memiliki atribut hidden dan class portal-hidden');

  // 2. CSS mobile tidak boleh memaksa display: flex pada portalGate saat tersembunyi
  assert.match(workspaceCss, /#portalGate:not\(\.portal-hidden\):not\(\[hidden\]\)/, 'workspace.css harus membatasi display:flex mobile hanya untuk gate yang tidak tersembunyi');
  assert.match(identityCss, /#portalGate:not\(\.portal-hidden\):not\(\[hidden\]\)/, 'identity.css harus membatasi display:flex mobile hanya untuk gate yang tidak tersembunyi');

  // 3. Aturan eksplisit display: none !important untuk gate yang tersembunyi atau saat pengguna terotentikasi
  assert.match(workspaceCss, /body\.portal-authenticated #portalGate[\s\S]*?display:\s*none\s*!important/, 'workspace.css harus menyembunyikan gate saat portal-authenticated');
  assert.match(identityCss, /body\.portal-authenticated #portalGate[\s\S]*?display:\s*none\s*!important/, 'identity.css harus menyembunyikan gate saat portal-authenticated');

  // 4. JS runtime memiliki helper setPortalGateVisible yang mengontrol atribut hidden dan display inline
  assert.match(portalJs, /function setPortalGateVisible\(visible\) \{/, 'portal_js.html harus memiliki helper setPortalGateVisible');
  assert.match(portalJs, /gate\.style\.setProperty\('display',\s*'none',\s*'important'\)/, 'setPortalGateVisible harus menetapkan display none !important');
});
