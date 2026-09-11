import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pemilih tanggal memakai kalender aplikasi di portal dan preview', async () => {
  const [build, preview, styles] = await Promise.all([
    readFile('scripts/build-ui.mjs', 'utf8'),
    readFile('public/brand/workspace-preview.js', 'utf8'),
    readFile('public/brand/workspace.css', 'utf8')
  ]);

  assert.match(build, /modules\.find\(module => module\.name === 'flatpickr'\)/);
  assert.match(preview, /flatpickr\(input,/);
  assert.match(preview, /portal-preview-calendar/);
  assert.doesNotMatch(preview, /input\.type = 'date'/);
  assert.match(styles, /\.flatpickr-calendar \{ width:min\(324px/);
  assert.match(styles, /\.flatpickr-day \{ display:grid/);
  assert.match(styles, /\.portal-calendar-nav:focus-visible/);
});
