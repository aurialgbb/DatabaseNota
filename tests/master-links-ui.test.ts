import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Master Link memakai pencarian langsung dan URL dapat diedit tanpa mode edit cabang', async () => {
  const [markup, script, styles] = await Promise.all([
    readFile('ui/tax_portal.html', 'utf8'),
    readFile('ui/portal_js.html', 'utf8'),
    readFile('public/brand/workspace.css', 'utf8'),
  ]);

  assert.match(markup, /<input id="taxLinkBranchFilter" type="search"/);
  assert.doesNotMatch(markup, /<select id="taxLinkBranchFilter"/);
  assert.match(script, /on\('taxLinkBranchFilter', 'input'/);
  assert.match(script, /\[branch\.name,branch\.id,branch\.type\][^;]+\.includes\(filter\)/);
  assert.match(script, /input\.addEventListener\('input', \(\) => markMasterUrlDirty/);
  assert.match(script, /input\.addEventListener\('blur', \(\) => saveMasterUrlInline/);
  assert.match(script, /title="Edit nama dan tipe" aria-label="Edit nama dan tipe"/);
  assert.doesNotMatch(script, /refreshPortalCombo\(filter\)/);
  assert.match(styles, /\.portal-link-cell:focus-within/);
  assert.match(styles, /\.portal-link-cell \.portal-inline-input:focus-visible \{ border:0 !important; outline:0 !important;/);
});
