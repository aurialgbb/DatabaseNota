import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Beranda, Riwayat, dan form cabang memakai format tanggal dan Rupiah yang konsisten', async () => {
  const script = await readFile('ui/portal_js.html', 'utf8');
  const start = script.indexOf('function renderStoreHistoryRows');
  const end = script.indexOf('async function changePassword', start);
  assert.ok(start > 0 && end > start);
  const history = script.slice(start, end);
  assert.equal((history.match(/formatDisplayDate\(r\.date\)/g) || []).length, 2);
  assert.equal((history.match(/rupiah\(r\.receiptTotal\)/g) || []).length, 2);
  assert.doesNotMatch(history, /escapeHtml\(r\.date\)/);
  assert.doesNotMatch(history, />Rp\$\{money\(r\.receiptTotal\)\}/);
  assert.match(script, /PortalCore = \{[\s\S]+formatDisplayDate/);
  assert.match(script, /dateFormat: 'Y-m-d', altInput: true, altFormat: 'j M Y'/);
  assert.match(script, /data-summary-date>\$\{escapeHtml\(receipt\.date \? formatDisplayDate\(receipt\.date\)/);
});
