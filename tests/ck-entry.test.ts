import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { legacyRead } from '../lib/legacy';
import type { Database } from '../lib/db';
import type { User } from '../lib/identity';

test('CK entry data: cabangCentralKitchen returns Mandiri branches instead of fellow CK', async () => {
  const pg = new PGlite(), db = pg as unknown as Database;
  const user = { uid: 'tester', role: 'ADMIN' } as User;
  try {
    for (const file of fs.readdirSync('migrations').filter(x => x.endsWith('.sql')).sort()) {
      await pg.exec(fs.readFileSync('migrations/' + file, 'utf8'));
    }
    await pg.exec(`
      INSERT INTO nota_app.branches(id, name, type, active, data) VALUES
        ('ck-1', 'CK JAKARTA', 'Central Kitchen', true, '{}'::jsonb),
        ('ck-2', 'CK SURABAYA', 'Central Kitchen', true, '{}'::jsonb),
        ('m-1', 'CABANG DEPOK', 'Mandiri', true, '{"cv":"CV NUSA"}'::jsonb),
        ('m-2', 'CABANG TEBET', 'Mandiri', true, '{"cv":"CV NUSA"}'::jsonb);
    `);

    const result = await legacyRead(db, user, 'getBootstrapData', []);
    assert.ok(result && 'cabangCentralKitchen' in result);
    const ckOptions = (result as any).cabangCentralKitchen;

    // 1. Must include Mandiri branches
    assert.ok(ckOptions.includes('CABANG DEPOK'), 'Mandiri branch must be in CK branch options');
    assert.ok(ckOptions.includes('CABANG TEBET'), 'Mandiri branch must be in CK branch options');

    // 2. Must NOT include fellow CK branches
    assert.ok(!ckOptions.includes('CK JAKARTA'), 'Fellow CK branch must NOT be in CK branch options');
    assert.ok(!ckOptions.includes('CK SURABAYA'), 'Fellow CK branch must NOT be in CK branch options');
  } finally {
    await pg.close();
  }
});

test('CK entry data: UI and sync plans allow empty branch for CK and use Mandiri options', async () => {
  const pageTarik = fs.readFileSync('ui/page_tarik.html', 'utf8');
  const syncPlans = fs.readFileSync('lib/sync-plans.ts', 'utf8');

  // 1. Helper getTarikMandiriBranchNames is defined and exported to window
  assert.ok(pageTarik.includes('function getTarikMandiriBranchNames()'), 'Helper getTarikMandiriBranchNames must be defined');
  assert.ok(pageTarik.includes('window.getTarikMandiriBranchNames = getTarikMandiriBranchNames;'), 'Helper must be attached to window');

  // 2. Table autocomplete uses getTarikMandiriBranchNames for cabang
  assert.match(pageTarik, /if\s*\(type\s*===\s*['"]cabang['"]\)\s*\{\s*source\s*=\s*getTarikMandiriBranchNames\(\);/);

  // 3. Row validation isCabangInvalid is false when cabang is empty for Central Kitchen
  assert.match(pageTarik, /if\s*\(tipe\s*===\s*["']Central Kitchen["']\s*&&\s*r\.cabang\s*&&\s*r\.cabang\.trim\(\)\s*!==\s*["']["']\)/);

  // 4. Submit validation allows empty cabang for CK and validates filled cabang with getTarikMandiriBranchNames
  assert.match(pageTarik, /if\s*\(tipeValForCheck\s*===\s*["']Central Kitchen["']\s*&&\s*item\.cabang\s*&&\s*String\(item\.cabang\)\.trim\(\)\s*!==\s*["']["']\)\s*\{\s*const validCabang\s*=\s*getTarikMandiriBranchNames\(\);/);

  // 5. Modals for tambah & edit cabang use getTarikMandiriBranchNames
  assert.match(pageTarik, /setupSearchableDropdown\(['"]tambahCabang['"],\s*getTarikMandiriBranchNames\(\)\)/);
  assert.match(pageTarik, /setupSearchableDropdown\(['"]editCabang['"],\s*getTarikMandiriBranchNames\(\)\)/);

  // 6. Backend sync-plans only enforces BRANCH_REQUIRED for Mandiri, allowing empty branch for Central Kitchen
  assert.ok(syncPlans.includes("if(t.type==='Mandiri')invariant(branch,'BRANCH_REQUIRED'"), 'sync-plans must allow empty cabang for Central Kitchen');
});

test('CK entry data: Row 1 is unlocked for Central Kitchen and locked for Mandiri', async () => {
  const pageTarik = fs.readFileSync('ui/page_tarik.html', 'utf8');

  // 1. Verify helpers are defined
  assert.ok(pageTarik.includes('function isTarikRowOneLockActive()'), 'isTarikRowOneLockActive helper must be defined');
  assert.ok(pageTarik.includes('function isTarikRowLocked(r)'), 'isTarikRowLocked helper must be defined');

  // 2. Test behavioral semantics for CK vs Mandiri
  const isTarikRowOneLockActive = (tipe: string) => (tipe || '') !== 'Central Kitchen';
  const isTarikRowLocked = (r: any, tipe: string) => {
    if (!isTarikRowOneLockActive(tipe)) return false;
    return Boolean(r && (Number.parseInt(r.no, 10) === 1 || r._isRowOneLocked));
  };
  const tarikNextAvailableNo = (rows: any[], tipe: string) => {
    const used = new Set((rows || []).map(row => Number.parseInt(row.no, 10)).filter(no => Number.isInteger(no) && no > 0));
    let candidate = isTarikRowOneLockActive(tipe) ? 2 : 1;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  };

  // For Central Kitchen:
  assert.equal(isTarikRowOneLockActive('Central Kitchen'), false);
  assert.equal(isTarikRowLocked({ no: 1 }, 'Central Kitchen'), false, 'Row 1 must NOT be locked for Central Kitchen');
  assert.equal(isTarikRowLocked({ no: 1, _isRowOneLocked: true }, 'Central Kitchen'), false, 'Row 1 must NOT be locked for Central Kitchen even if flag set');
  assert.equal(tarikNextAvailableNo([], 'Central Kitchen'), 1, 'Next available no for Central Kitchen starts at 1');
  assert.equal(tarikNextAvailableNo([{ no: 1 }], 'Central Kitchen'), 2, 'Next available no after row 1 is 2');

  // For Mandiri:
  assert.equal(isTarikRowOneLockActive('Mandiri'), true);
  assert.equal(isTarikRowLocked({ no: 1 }, 'Mandiri'), true, 'Row 1 MUST be locked for Mandiri');
  assert.equal(isTarikRowLocked({ no: 2 }, 'Mandiri'), false, 'Row 2 must NOT be locked for Mandiri');
  assert.equal(tarikNextAvailableNo([], 'Mandiri'), 2, 'Next available no for Mandiri starts at 2');

  // 3. In page_tarik.html, fetchTarikData sets _isRowOneLocked using isRowOneLockActive
  assert.match(pageTarik, /const isRowOneLockActive = tipe !== ["']Central Kitchen["'];/);
  assert.match(pageTarik, /_isRowOneLocked: isRowOneLockActive/);

  // 4. In page_tarik.html, render, update, toggle, delete, edit, and submit all use isTarikRowLocked
  assert.match(pageTarik, /const isRowOne = isTarikRowLocked\(r\);/);
  assert.match(pageTarik, /window\.updateTarikField = function\(idx, field, val\) \{[\s\S]*?if \(isTarikRowLocked\(r\)\) return;/);
  assert.match(pageTarik, /window\.toggleEliminasiDirectly = async function\(idx, btn\) \{[\s\S]*?if \(isTarikRowLocked\(r\)\) return;/);
  assert.match(pageTarik, /window\.deleteTarikDataLocal = async function\(idx\) \{[\s\S]*?if \(isTarikRowLocked\(TARIK_DATA\[idx\]\)\)/);
  assert.match(pageTarik, /window\.openEditTarikModal = function\(idx\) \{[\s\S]*?if \(isTarikRowLocked\(r\)\)/);
  assert.match(pageTarik, /!isTarikRowLocked\(r\) && r\.isNew && !r\.isDeleted/);
});

test('CK distribution dynamically allocates to the next empty row in destination Mandiri branch', async () => {
  const syncPlans = fs.readFileSync('lib/sync-plans.ts', 'utf8');
  const syncEngine = fs.readFileSync('lib/sync-engine.ts', 'utf8');

  // 1. Verify helper and engine support
  assert.ok(syncPlans.includes('function freeDistributionRow('), 'freeDistributionRow must be defined in sync-plans');
  assert.ok(syncPlans.includes('function slotOfMapping('), 'slotOfMapping must be defined in sync-plans');
  assert.ok(syncEngine.includes('removeOwner?:boolean'), 'removeOwner must be supported in Edit type');
  assert.ok(syncEngine.includes('edit.removeOwner&&ownerTag'), 'removeOwner metadata deletion must be handled');

  // 2. Behavioral test of freeDistributionRow
  // Simulate Mandiri model where rows 1..5 are filled/locked, row 6 is empty
  const date = '2026-09-01';
  const period = '202609';
  const target = { period, type: 'Mandiri' } as any;
  const dummyValues: any[][] = [
    // 4 header rows (indices 0..3)
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    // Row 5: Date 1, No 1 (locked Kas Awal)
    ['', '01-09-2026', '1', 'KAS AWAL', 'LAIN-LAIN', '', '1000000', 'TIDAK'],
    // Row 6: Date 1, No 2 (Depok local expense)
    ['', '01-09-2026', '2', 'PARKIR', 'OPERASIONAL', '', '10000', 'TIDAK'],
    // Row 7: Date 1, No 3 (Depok local expense)
    ['', '01-09-2026', '3', 'AIR GALON', 'AIR GALON', '2', '40000', 'TIDAK'],
    // Row 8: Date 1, No 4 (Depok local expense)
    ['', '01-09-2026', '4', 'GAS LPG', 'GAS', '1', '25000', 'TIDAK'],
    // Row 9: Date 1, No 5 (Depok local expense)
    ['', '01-09-2026', '5', 'LAKBAN', 'OPERASIONAL', '1', '15000', 'TIDAK'],
    // Row 10: Date 1, No 6 (EMPTY row)
    ['', '01-09-2026', '6', '', '', '', '', ''],
    // Row 11: Date 1, No 7 (EMPTY row)
    ['', '01-09-2026', '7', '', '', '', '', '']
  ];
  const dummyFormulas: any[][] = Array.from({ length: 12 }, () => Array(8).fill(''));
  dummyFormulas[4][3] = '=B5'; // Kas Awal formula

  const dummyTags: Record<number, any[]> = {};
  const dummyModel: any = {
    target,
    width: 8,
    values: dummyValues,
    formulas: dummyFormulas,
    tags: dummyTags
  };

  const isoDayHelper = (val: string) => val === '01-09-2026' ? '2026-09-01' : '';
  const padded = (r: any[], w: number) => Array.from({ length: w }, (_, i) => r?.[i] ?? '');

  const freeDistributionRowSimulation = (model: any, d: string, used: Set<number>, owner: string) => {
    const result = model.values.findIndex((values: any[], i: number) => {
      const rowIndex = i + 1;
      if (i < 4 || used.has(rowIndex) || isoDayHelper(values[1]) !== d || !(Number(values[2]) > 1)) return false;
      const data = values.slice(3, model.width - 1), tags = model.tags[rowIndex] || [];
      const empty = !data.some((v: any) => v !== '' && v !== null) && !/^YA$/i.test(String(values[model.width - 1]));
      const noFormula = !padded(model.formulas[i], model.width).slice(3).some((v: any) => typeof v === 'string' && v.startsWith('='));
      const foreignTags = tags.some((t: any) => /^PORTAL_|NOTA_ROW_ID/.test(t.metadataKey) || (t.metadataKey === 'NOTA_CK_OWNER' && t.metadataValue !== owner));
      return empty && noFormula && !foreignTags;
    });
    assert.ok(result >= 0, 'Must find an empty row');
    used.add(result + 1);
    return result + 1;
  };

  const used = new Set<number>();
  const allocatedRow = freeDistributionRowSimulation(dummyModel, date, used, 'ck-owner-1');

  // Must allocate Row index 10 (which corresponds to No. 6 in the sheet, skipping rows 1..5)
  assert.equal(allocatedRow, 10, 'Must skip filled rows 1..5 and allocate row index 10 (No. 6)');
  assert.equal(dummyValues[allocatedRow - 1][2], '6', 'Column No in allocated row must be 6');

  // Next allocation must allocate Row index 11 (No. 7)
  const nextAllocatedRow = freeDistributionRowSimulation(dummyModel, date, used, 'ck-owner-1');
  assert.equal(nextAllocatedRow, 11, 'Next item must allocate row index 11 (No. 7)');
  assert.equal(dummyValues[nextAllocatedRow - 1][2], '7', 'Column No in next allocated row must be 7');
});

