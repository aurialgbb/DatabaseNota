import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Master Link memakai pencarian langsung dan URL hanya dapat diubah dalam mode edit', async () => {
  const [markup, script, styles] = await Promise.all([
    readFile('ui/tax_portal.html', 'utf8'),
    readFile('ui/portal_js.html', 'utf8'),
    readFile('public/brand/workspace.css', 'utf8'),
  ]);

  assert.match(markup, /<input id="taxLinkBranchFilter" type="search"/);
  assert.doesNotMatch(markup, /<select id="taxLinkBranchFilter"/);
  assert.match(script, /on\('taxLinkBranchFilter', 'input'/);
  assert.match(script, /\[branch\.name,branch\.id,branch\.type\][^;]+\.includes\(filter\)/);
  assert.match(script, /readonly aria-readonly="true"/);
  assert.match(script, /\[data-master-url\]:not\(\[readonly\]\)/);
  assert.doesNotMatch(script, /input\.addEventListener\('blur', \(\) => saveMasterUrlInline/);
  assert.match(script, /aria-label="Edit cabang"/);
  assert.match(script, /> Simpan<\/button>/);
  assert.match(script, /> Batal<\/button>/);
  assert.doesNotMatch(script, /refreshPortalCombo\(filter\)/);
  assert.match(styles, /\.portal-link-cell:focus-within/);
  assert.match(styles, /\.portal-link-cell \.portal-inline-input:focus-visible \{ border:0 !important; outline:0 !important;/);
  assert.match(styles, /@media \(max-width:480px\)[\s\S]+\.portal-master-search-field \{ min-height:44px; \}/);
  assert.match(styles, /\.portal-master-card \.portal-icon-button \{ width:40px; height:40px; \}/);
  assert.match(styles, /max-width:760px[\s\S]+\.portal-input,.portal-select,.portal-inline-input\) \{ font-size:16px; \}/);
});
