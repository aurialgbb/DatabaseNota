import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Tarik Data: Baris No. 1 dikunci per tanggal dan status fetch dipindah ke header spreadsheet', async () => {
  const runtimeHtml = await readFile('ui/runtime_page_tarik.html', 'utf8');
  const pageTarik = await readFile('ui/page_tarik.html', 'utf8');
  const portalHtml = await readFile('public/portal.html', 'utf8');

  // 1. Status fetch tidak lagi berada di tombol Tarik Data
  const submitBlock = runtimeHtml.match(/<div class="legacy-pull-v3-submit">[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(!submitBlock.includes('tarikFetchStatus'), 'tarikFetchStatus tidak boleh berada di tombol submit');

  // 2. Status fetch diletakkan di samping nama spreadsheet
  assert.ok(runtimeHtml.includes('id="tarikSpreadsheetInfo"'));
  const spreadsheetInfoBlock = runtimeHtml.match(/<div class="flex flex-wrap items-center gap-3 hidden" id="tarikSpreadsheetInfo">[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(spreadsheetInfoBlock.includes('id="tarikFetchStatus"'), 'tarikFetchStatus harus berdampingan dengan nama spreadsheet');
  assert.ok(portalHtml.includes('tarikFetchStatusText'));

  // 3. Baris 1 dikunci untuk Mandiri (candidate >= 2) dan tidak dikunci untuk Central Kitchen (candidate >= 1)
  assert.match(pageTarik, /function isTarikRowOneLockActive\(\) \{[\s\S]*?Central Kitchen/);
  assert.match(pageTarik, /function isTarikRowLocked\(r\) \{[\s\S]*?Central Kitchen[\s\S]*?Number\.parseInt\(r\.no, 10\) === 1/);
  assert.match(pageTarik, /function tarikNextAvailableNo\(rows\) \{[\s\S]*?let candidate = isTarikRowOneLockActive\(\) \? 2 : 1;/);
  assert.match(pageTarik, /_isRowOneLocked/);
  assert.match(pageTarik, /const isRowOne = isTarikRowLocked\(r\);/);
  assert.match(pageTarik, /placeholderKeterangan = isRowOne \? '\(Khusus diisi dari spreadsheet\)' : '\.\.\.';/);

  // 4. Proteksi hapus, edit, dan eliminasi untuk baris 1 berbasis isTarikRowLocked
  assert.match(pageTarik, /if \(isTarikRowLocked\(TARIK_DATA\[idx\]\)\)/);
  assert.match(pageTarik, /window\.toggleEliminasiDirectly = async function\(idx, btn\) \{[\s\S]*?if \(isTarikRowLocked\(r\)\) return;/);

  // 5. Submit data tidak boleh mengirim baris 1 yang terkunci sebagai data baru/editan
  assert.match(pageTarik, /!isTarikRowLocked\(r\) && r\.isNew && !r\.isDeleted/);
});
