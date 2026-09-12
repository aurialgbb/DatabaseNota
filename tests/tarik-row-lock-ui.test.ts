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

  // 3. Baris 1 dikunci dan nomor baris baru selalu >= 2
  assert.match(pageTarik, /function tarikNextAvailableNo\(rows\) \{[\s\S]*?let candidate = 2;/);
  assert.match(pageTarik, /_isRowOneLocked/);
  assert.match(pageTarik, /const isRowOne = Number\.parseInt\(r\.no, 10\) === 1 \|\| Boolean\(r\._isRowOneLocked\);/);
  assert.match(pageTarik, /placeholderKeterangan = isRowOne \? '\(Khusus diisi dari spreadsheet\)' : '\.\.\.';/);

  // 4. Proteksi hapus, edit, dan eliminasi untuk baris 1
  assert.match(pageTarik, /Number\.parseInt\(TARIK_DATA\[idx\]\.no, 10\) === 1 \|\| TARIK_DATA\[idx\]\._isRowOneLocked/);
  assert.match(pageTarik, /window\.toggleEliminasiDirectly = async function\(idx, btn\) \{[\s\S]*?if \(Number\.parseInt\(r\.no, 10\) === 1 \|\| r\._isRowOneLocked\) return;/);

  // 5. Submit data tidak boleh mengirim baris 1 sebagai data baru/editan
  assert.match(pageTarik, /!r\._isRowOneLocked && r\.isNew && !r\.isDeleted/);
});
