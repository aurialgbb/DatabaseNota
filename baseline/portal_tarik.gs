/** Tarik Data: validate -> durable plan -> reserved coordinates -> absolute writes -> commit. */
var MUTATION_SESSION_ = null;

function legacyExpenseIdentity_(record) {
  const clean = function(value) { const text = String(value == null ? '' : value).trim().toUpperCase(); return text === '-' ? '' : text; };
  return mutationCanonical_([
    Utilities.formatDate(new Date(record.tanggal), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    clean(record.cabang), Number(record.nominal) || 0, clean(record.keterangan), clean(record.jenis), clean(record.jumlah)
  ]);
}

function tarikTarget_(payload) {
  const url = resolveLegacySpreadsheetLink_(payload);
  const period = legacyTarikPeriod_(payload);
  const links = mutationJournalRead_('/config/spreadsheetLinks/' + period) || {};
  const fileId = mutationSpreadsheetId_(url);
  const matches = Object.keys(links).filter(function(id) {
    try { return mutationSpreadsheetId_(links[id].url || links[id].spreadsheetUrl) === fileId; } catch (error) { return false; }
  });
  if (matches.length !== 1) throw new Error('Master Link ambigu: satu file harus memiliki tepat satu cabang pada periode ini.');
  const branchId = matches[0];
  const branch = mutationJournalRead_('/config/branches/' + branchId) || {};
  const type = branch.type || branch.branchType || links[branchId].branchType;
  if (!type) throw new Error('Jenis cabang belum terdaftar di Master Link.');
  const branchType = /central/i.test(String(type)) ? 'Central Kitchen' : 'Mandiri';
  if (branchType !== payload.tipe) throw new Error('Jenis cabang berbeda dengan Master Link. Muat ulang.');
  return { url:url, fileId:fileId, period:period, branchId:branchId, branchName:String(branch.name || branch.nama || links[branchId].branchName || branchId).toUpperCase(), type:branchType };
}

function tarikMetadata_(sheet) {
  const byRow = {};
  sheet.createDeveloperMetadataFinder().find().forEach(function(metadata) {
    const key = metadata.getKey();
    if (!/^PORTAL_(R_|ROW_ID|CK_)/.test(key)) return;
    const row = metadata.getLocation().getRow();
    if (!row) return;
    const index = row.getRow();
    if (!byRow[index]) byRow[index] = [];
    byRow[index].push({ key:key, value:metadata.getValue(), metadata:metadata });
  });
  return byRow;
}

function tarikRowVersion_(values, metadata) {
  return mutationKey_(mutationCanonical_({ values:values, metadata:(metadata || []).map(function(item) { return [item.key, item.value]; }).sort() }));
}

function tarikReadModel_(target, payload) {
  const spreadsheet = SpreadsheetApp.openById(target.fileId);
  const sheet = spreadsheet.getSheetByName('REKAP');
  if (!sheet) throw new Error('Sheet REKAP tidak ditemukan.');
  const width = target.type === 'Central Kitchen' ? 9 : 8;
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), width).getValues();
  const metadata = tarikMetadata_(sheet);
  const sidecar = mutationJournalRead_('/sheetRowsV2/' + target.fileId) || {};
  const receiptKeys = {};
  const datePrefix = target.period.slice(0, 4) + '-' + target.period.slice(4, 6);
  const receiptSummaries = fbReadQuery_('/receiptIndexV1/byBranch/' + portalReceiptIndexSegment_(target.branchId), {
    orderBy:'$key', startAt:datePrefix + '-01', endAt:datePrefix + '-31\uf8ff'
  }) || {};
  Object.keys(receiptSummaries).forEach(function(key) {
    const receipt = receiptSummaries[key];
    receiptKeys[portalReceiptMetadataKey_(receipt.id)] = receipt;
  });
  const rows = [];
  values.forEach(function(value, index) {
    const parsedDate = legacyTarikParseRowDate_(value[1], payload);
    if (!parsedDate || Utilities.formatDate(parsedDate, Session.getScriptTimeZone(), 'yyyyMM') !== target.period) return;
    const offset = target.type === 'Central Kitchen' ? 1 : 0;
    if (!value[3 + offset] && !value[4 + offset] && !value[5 + offset] && !parseNominalSafe_(value[6 + offset])) return;
    const rowIndex = index + 1;
    const tags = metadata[rowIndex] || [];
    const rowTag = tags.filter(function(tag) { return tag.key === 'PORTAL_ROW_ID'; })[0];
    const receiptTag = tags.filter(function(tag) { return tag.key.indexOf('PORTAL_R_') === 0; })[0];
    const receipt = receiptTag ? receiptKeys[receiptTag.key] : null;
    const version = tarikRowVersion_(value, tags);
    const stored = sidecar[rowIndex] || {};
    const rowId = rowTag ? rowTag.value : ('LEGACY-' + mutationKey_(target.fileId + '|' + rowIndex + '|' + version));
    rows.push({
      sheetRowIndex:rowIndex, rowId:rowId, version:version, no:String(value[2] || ''),
      tanggal:Utilities.formatDate(parsedDate, Session.getScriptTimeZone(), 'dd-MM-yyyy'),
      cabang:offset ? String(value[3] || '').toUpperCase() : target.branchName,
      keterangan:String(value[3 + offset] || ''), jenis:String(value[4 + offset] || ''), jumlah:String(value[5 + offset] || ''),
      nominal:parseNominalSafe_(value[6 + offset]), eliminasi:String(value[7 + offset] || ''),
      expenseId:stored.rowId === rowId ? (stored.expenseId || '') : '',
      receiptId:receipt ? receipt.id : '', itemId:receiptTag ? portalParseReceiptMetadataValue_(receiptTag.value).itemId : '',
      distributionSource:(tags.filter(function(tag) { return tag.key === 'PORTAL_CK_OWNER'; })[0] || {}).value || '',
      receiptPhotoId:receipt ? receipt.photoId || '' : '',
      receiptVersion:receipt ? receipt.version : null, receiptItemCount:receipt ? receipt.itemCount : 0,
      ownershipConflict:Boolean(receiptTag && !receipt), fotoUrl:''
    });
  });
  return { spreadsheet:spreadsheet, sheet:sheet, values:values, metadata:metadata, rows:rows, sidecar:sidecar, target:target };
}

function tarikExpenseMatches_(model, rows) {
  const result = {};
  const unresolved = rows.filter(function(row) { return !row.expenseId; });
  const identities = {};
  const asExpense = function(row) { return Object.assign({}, row, { tanggal:legacyTarikParseRowDate_(row.tanggal, { bulan:model.target.period.slice(4), tahun:model.target.period.slice(0,4) }).getTime() }); };
  if (unresolved.length) {
    const ready = legacyIndexReadsEnabled_() && mutationJournalRead_('/expenseIdentityV2Meta/' + model.target.period);
    if (ready && ready.validated) {
      const keys = Array.from(new Set(unresolved.map(function(row) { return mutationKey_(legacyExpenseIdentity_(asExpense(row))); })));
      const snapshots = fbReadBatch_(keys.map(function(key) { return { path:'/expenseIdentityV2/' + model.target.period + '/' + key }; }));
      keys.forEach(function(key, index) { identities[key] = Object.keys(snapshots[index] || {}); });
    } else {
      // The old summary index remains the complete fallback during additive backfill.
      legacyTarikExpenseRows_(model.target.period).forEach(function(row) {
        const item = { id:row[0], tanggal:row[2], cabang:row[3], nominal:row[5], keterangan:row[8], jenis:row[10], jumlah:row[11] };
        const key = mutationKey_(legacyExpenseIdentity_(item));
        if (!identities[key]) identities[key] = [];
        identities[key].push(item.id);
      });
    }
  }
  rows.forEach(function(row) {
    const matches = row.expenseId ? [row.expenseId] : (identities[mutationKey_(legacyExpenseIdentity_(asExpense(row)))] || []);
    if (matches.length > 1) { result[row.rowId] = { conflict:true, ids:matches }; return; }
    result[row.rowId] = { id:matches[0] || '' };
  });
  const ids = Array.from(new Set(Object.keys(result).map(function(key) { return result[key].id; }).filter(Boolean)));
  const records = fbReadBatch_(ids.map(function(id) { return { path:'/expenses/' + id }; }));
  const byId = {};
  ids.forEach(function(id, index) { byId[id] = records[index]; });
  rows.forEach(function(row) {
    const match = result[row.rowId];
    match.record = byId[match.id] || null;
    if (match.id && (!match.record || legacyExpenseIdentity_(match.record) !== legacyExpenseIdentity_(asExpense(row)))) match.conflict = true;
  });
  return result;
}

function tarikFetchSafe_(payload) {
  const startedAt = Date.now();
  const target = tarikTarget_(payload);
  const model = tarikReadModel_(target, payload);
  const matches = tarikExpenseMatches_(model, model.rows);
  const photoIds = Array.from(new Set(model.rows.map(function(row) { return row.receiptPhotoId; }).filter(Boolean)));
  const photos = fbReadBatch_(photoIds.map(function(id) { return { path:'/photos/' + id }; }));
  const photoUrls = {};
  photoIds.forEach(function(id,index) { if (photos[index] && photos[index].driveFileId) photoUrls[id] = 'https://drive.google.com/file/d/' + photos[index].driveFileId + '/view'; });
  model.rows.forEach(function(row) {
    const match = matches[row.rowId];
    row.conflicts = match.conflict || row.ownershipConflict ? ['Identitas transaksi ambigu; perlu pemeriksaan.'] : [];
    row.expenseId = match.id || '';
    row.fotoUrl = match.record ? (match.record.fotoUrl || '') : photoUrls[row.receiptPhotoId] || '';
  });
  let summary = null;
  let warning = '';
  try { summary = target.type === 'Mandiri' ? getMandiriSummaryHelper_(model.spreadsheet) : readCentralKitchenSummary_(model.sheet); }
  catch (error) { warning = 'Data berhasil dimuat; ringkasan belum diperbarui.'; }
  console.log(JSON.stringify({ type:'tarik-fetch-performance', durationMs:Date.now() - startedAt, rowCount:model.rows.length, spreadsheetReads:1 }));
  return { success:true, spreadsheetName:model.spreadsheet.getName(), data:model.rows, rekapPengeluaranData:summary, warning:warning, branchId:target.branchId, cabang:target.branchName, protocolVersion:2 };
}

function tarikRowCells_(row, type) {
  const cells = [String(row.keterangan || '').trim(), String(row.jenis || '').trim(), String(row.jumlah || '').trim(), Number(row.nominal), String(row.eliminasi || '').toUpperCase()];
  return type === 'Central Kitchen' ? [String(row.cabang || '').toUpperCase()].concat(cells) : cells;
}

function tarikClearMetadata_(sheet, rowIndex) {
  (tarikMetadata_(sheet)[rowIndex] || []).sort(function(a,b) { return Number(a.key === 'PORTAL_ROW_ID') - Number(b.key === 'PORTAL_ROW_ID'); }).forEach(function(tag) { tag.metadata.remove(); });
}

function tarikValidateItem_(item, target, categories) {
  if (!String(item.keterangan || '').trim()) throw new Error('Keterangan wajib diisi.');
  if (!String(item.jenis || '').trim() || categories.indexOf(String(item.jenis).toUpperCase()) < 0) throw new Error('Jenis pengeluaran tidak terdaftar: ' + item.jenis);
  if (!isFinite(Number(item.nominal)) || Number(item.nominal) <= 0) throw new Error('Nominal harus lebih besar dari nol.');
  const date = legacyTarikParseRowDate_(item.tanggal, { bulan:target.period.slice(4), tahun:target.period.slice(0,4) });
  if (!date || Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMM') !== target.period) throw new Error('Tanggal di luar periode yang dipilih.');
  if (item.base64) {
    const encoded = String(item.base64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Foto tidak valid. Pilih ulang foto sebelum menyimpan.');
  }
}

function tarikJournalRow_(row) {
  const next = {};
  ['rowId','sheetRowIndex','version','receiptId','itemId','tanggal','cabang','keterangan','jenis','jumlah','nominal','eliminasi','fotoUrl','removePhoto','no','clientIndex'].forEach(function(key) { if (row[key] !== undefined) next[key] = row[key]; });
  return next;
}

function tarikPrepare_(payload, target, operationId) {
  mutationAssertSpreadsheetWritable_(target.fileId);
  const model = tarikReadModel_(target, payload);
  const oldRows = {};
  model.rows.forEach(function(row) { oldRows[row.sheetRowIndex] = row; });
  const selected = {};
  const addSelection = function(item, deleted) {
    const old = oldRows[Number(item.sheetRowIndex)];
    if (!old || !item.rowId || !item.version || old.rowId !== item.rowId || old.version !== item.version) throw new Error('Konflik identitas/versi baris ' + item.sheetRowIndex + '. Muat ulang sebelum menyimpan.');
    if (old.distributionSource) throw new Error('Baris ini merupakan salinan distribusi CK. Ubah melalui Tarik Data cabang CK asal agar seluruh salinan tetap sesuai.');
    if (old.ownershipConflict) throw new Error('Kepemilikan nota pada baris ' + item.sheetRowIndex + ' belum dapat dipastikan.');
    const next = Object.assign({}, old, selected[old.rowId] ? selected[old.rowId].next : {}, item);
    if (target.type === 'Mandiri') next.cabang = target.branchName;
    selected[old.rowId] = { before:old, next:deleted ? null : next };
  };
  (payload.editedItems || []).forEach(function(item) { addSelection(item, false); });
  (payload.photoItemsExisting || []).filter(function(item) { return item.base64 || item.removePhoto; }).forEach(function(item) { addSelection(item, false); });
  (payload.deletedItems || []).forEach(function(item) { addSelection(item, true); });
  // Confirmation binds to both the receipt version and the exact set of items shown.
  Object.keys(selected).forEach(function(id) {
    const change = selected[id];
    if (!change.before.receiptId || (change.next && change.next.eliminasi === change.before.eliminasi)) return;
    const scope = model.rows.filter(function(row) { return row.receiptId === change.before.receiptId; });
    const confirmation = (payload.confirmedReceipts || []).filter(function(value) { return value.receiptId === change.before.receiptId; })[0];
    if (!confirmation || Number(confirmation.version) !== Number(change.before.receiptVersion) || mutationCanonical_(confirmation.itemIds.slice().sort()) !== mutationCanonical_(scope.map(function(row) { return row.itemId; }).sort())) throw new Error('Tampilkan dan konfirmasi seluruh item nota sebelum hapus/eliminasi.');
    scope.forEach(function(row) { selected[row.rowId] = { before:row, next:change.next ? Object.assign({}, row, selected[row.rowId] && selected[row.rowId].next || {}, { eliminasi:change.next.eliminasi }) : null }; });
  });
  const configuredCategories = getBootstrapData_().jenisPengeluaran || [];
  const categories = (configuredCategories.length ? configuredCategories : PORTAL_DEFAULT_CATEGORIES).map(function(value) { return String(value).toUpperCase(); });
  const changes = Object.keys(selected).map(function(key) { return selected[key]; });
  const nextValues = model.values.map(function(row) { return row.slice(); });
  changes.forEach(function(change) {
    if (change.next) tarikValidateItem_(change.next, target, categories);
    const cells = change.next ? tarikRowCells_(change.next, target.type) : Array(target.type === 'Central Kitchen' ? 6 : 5).fill('');
    nextValues[change.before.sheetRowIndex - 1].splice.apply(nextValues[change.before.sheetRowIndex - 1], [3, cells.length].concat(cells));
  });
  (payload.newItems || []).forEach(function(item) {
    const next = Object.assign({}, item, { rowId:mutationUuid_(), cabang:target.type === 'Mandiri' ? target.branchName : item.cabang });
    tarikValidateItem_(next, target, categories);
    const day = Number(String(next.tanggal).split('-')[0]);
    let free = -1;
    nextValues.some(function(row, index) {
      const date = legacyTarikParseRowDate_(row[1], payload);
      const offset = target.type === 'Central Kitchen' ? 1 : 0;
      const tags = model.metadata[index + 1] || [];
      const reserved = tags.some(function(tag) { return tag.key !== 'PORTAL_ROW_ID'; });
      if (index >= 4 && date && date.getDate() === day && Number(row[2]) > 0 && !row[3 + offset] && !row[4 + offset] && !row[5 + offset] && !row[6 + offset] && !reserved && !oldRows[index + 1]) { free = index; return true; }
      return false;
    });
    if (free < 0) throw new Error('Kapasitas tidak cukup: ' + target.branchName + ', ' + next.tanggal + '. Seluruh pengiriman ditolak.');
    next.sheetRowIndex = free + 1;
    next.no = nextValues[free][2];
    const cells = tarikRowCells_(next, target.type);
    nextValues[free].splice.apply(nextValues[free], [3, cells.length].concat(cells));
    changes.push({ before:null, next:next, previousValues:model.values[free], previousTags:[] });
  });
  const matches = tarikExpenseMatches_(model, changes.filter(function(change) { return change.before; }).map(function(change) { return change.before; }));
  const receipts = {};
  const edits = [];
  changes.forEach(function(change) {
    const old = change.before;
    const next = change.next;
    const match = old ? matches[old.rowId] : {};
    if (match.conflict) throw new Error('Pencocokan arsip ambigu pada baris ' + old.sheetRowIndex + '. Tidak ada data diubah.');
    if (old && old.receiptId) {
      if (!receipts[old.receiptId]) receipts[old.receiptId] = { before:mutationJournalRead_('/receipts/' + old.receiptId), changes:[] };
      if (!receipts[old.receiptId].before || receipts[old.receiptId].before.status !== 'APPROVED' || Number(receipts[old.receiptId].before.version) !== Number(old.receiptVersion)) throw new Error('Versi nota berubah. Muat ulang.');
      receipts[old.receiptId].changes.push({ before:old, next:next });
    }
    const expenseId = match.id || (next && !(old && old.receiptId) ? 'UMM-' + mutationUuid_() : '');
    const record = expenseId && next ? Object.assign({}, match.record || {}, {
      id:expenseId, timestamp:(match.record || {}).timestamp || Date.now(), tanggal:legacyTarikParseRowDate_(next.tanggal, payload).getTime(),
      cabang:next.cabang, cv:(match.record || {}).cv || '-', nominal:Number(next.nominal), fotoUrl:next.removePhoto ? '' : next.fotoUrl || (match.record || {}).fotoUrl || '',
      kategori:'Umum', keterangan:next.keterangan, jenis:next.jenis, jumlah:next.jumlah, noUrut:next.no, eliminasi:next.eliminasi || '', rowId:next.rowId
    }) : null;
    edits.push({ rowIndex:(old || next).sheetRowIndex, rowId:(old || next).rowId,
      changeKind:!next ? 'DELETED' : old ? 'UPDATED' : 'ADDED', beforeHadPhoto:Boolean(old && old.fotoUrl),
      beforeCells:(change.previousValues || model.values[old.sheetRowIndex - 1]).slice(3),
      beforeVersion:old ? old.version : tarikRowVersion_(change.previousValues, []),
      afterCells:next ? tarikRowCells_(next, target.type) : Array(target.type === 'Central Kitchen' ? 6 : 5).fill(''),
      beforeExpense:match.record || null, afterExpense:record, next:next ? tarikJournalRow_(next) : null,
      receiptId:old ? old.receiptId : '', itemId:old ? old.itemId : '',
      needsPhoto:Boolean(next && next.base64), clientIndex:next && next.clientIndex != null ? next.clientIndex : null
    });
  });
  model.plannedRowIds = Object.fromEntries(edits.map(function(edit) { return [edit.rowIndex, edit.rowId]; }));
  const distribution = target.type === 'Central Kitchen' ? tarikPlanCk_(model, nextValues, operationId) : [];
  const receiptUpdates = {};
  const receiptExpected = {};
  const receiptCounts = {};
  Object.keys(receipts).forEach(function(id) {
    const group = receipts[id];
    const next = JSON.parse(JSON.stringify(group.before));
    const photoPayloads = Array.from(new Set(group.changes.filter(function(change) { return change.next && change.next.base64; }).map(function(change) { return mutationKey_(change.next.base64); })));
    if (photoPayloads.length > 1) throw new Error('Satu nota hanya dapat memiliki satu foto pengganti.');
    if (group.changes.some(function(change) { return change.next && change.next.removePhoto; })) next.photoId = '';
    if (group.changes.some(function(change) { return !change.next; })) {
      next.status = 'REJECTED';
      next.review = { decision:'DISCARD', reason:'Dihapus melalui Tarik Data', reviewedBy:MUTATION_SESSION_.uid, reviewedAt:Date.now() };
      receiptUpdates['sheetMappings/' + id] = null;
    } else {
      group.changes.forEach(function(change) {
        const item = next.items.filter(function(item) { return item.id === change.before.itemId; })[0];
        if (!item) throw new Error('Identitas item nota tidak cocok.');
        const quantityParts = String(change.next.jumlah || '').trim().match(/^([0-9.,]+)\s*(.*)$/);
        if (!quantityParts || !(Number(quantityParts[1].replace(',', '.')) > 0)) throw new Error('Jumlah item nota harus berupa angka positif, diikuti satuan bila ada.');
        Object.assign(item, { description:change.next.keterangan, category:change.next.jenis, quantity:Number(quantityParts[1].replace(',', '.')), unit:quantityParts[2], amount:Number(change.next.nominal), grossAmount:Number(change.next.nominal) + Number(item.discountAllocated || 0), distributionBranch:target.type === 'Central Kitchen' ? change.next.cabang : item.distributionBranch });
      });
      next.receiptTotal = next.items.reduce(function(sum, item) { return sum + Number(item.amount || 0); }, 0);
      next.grossTotal = next.receiptTotal + Number(next.discountTotal || 0);
      next.eliminated = group.changes.every(function(change) { return String(change.next.eliminasi).toUpperCase() === 'YA'; });
    }
    next.version = Number(next.version || 1) + 1;
    next.updatedAt = Date.now();
    receiptUpdates['receipts/' + id] = next;
    receiptExpected['receipts/' + id] = group.before;
    portalAddReceiptIndexMutation_(receiptUpdates, group.before, next, receiptCounts);
  });
  portalApplyCountDeltas_(receiptUpdates, receiptCounts);
  return { target:target, edits:edits, distribution:distribution, receiptUpdates:receiptUpdates, receiptExpected:receiptExpected, progress:0, status:'PREPARED', operationId:operationId };
}

function tarikPlanCk_(model, nextValues, operationId) {
  const previous = mutationJournalRead_('/ckDistributionV2/' + model.target.fileId) || {};
  const groups = {};
  const linksSheet = model.spreadsheet.getSheetByName('LINK SHEET');
  if (!linksSheet) throw new Error('LINK SHEET tidak ditemukan.');
  const links = {};
  linksSheet.getRange(3, 3, Math.max(1, linksSheet.getLastRow() - 2), 3).getValues().forEach(function(row) {
    if (!row[0] || !row[2]) return;
    const branch = String(row[0]).trim().toUpperCase();
    const fileId = mutationSpreadsheetId_(row[2]);
    if (links[branch] && links[branch] !== fileId) throw new Error('LINK SHEET CK memiliki lebih dari satu tujuan untuk cabang: ' + branch);
    links[branch] = fileId;
  });
  nextValues.forEach(function(row, index) {
    const day = parseInt(row[1], 10);
    const branch = String(row[3] || '').trim().toUpperCase();
    if (!branch || !row[4] || !(day >= 1 && day <= 31)) return;
    if (!links[branch]) throw new Error('Tujuan CK tidak terdaftar: ' + branch);
    const key = mutationKey_(branch + '|' + day);
    if (!groups[key]) groups[key] = { key:key, branch:branch, day:day, fileId:links[branch], rows:[] };
    const sourceRowId = (model.plannedRowIds || {})[index + 1] || ((model.rows || []).filter(function(item) { return item.sheetRowIndex === index + 1; })[0] || {}).rowId || ('LEGACY-' + mutationKey_(model.target.fileId + '|' + (index + 1)));
    groups[key].rows.push({ sourceRow:index + 1, sourceRowId:sourceRowId, cells:[row[1], row[2], row[4], row[5], row[6], row[7], row[8]] });
  });
  Object.keys(previous).forEach(function(key) {
    if (!groups[key]) groups[key] = Object.assign({}, previous[key], { key:key, rows:[] });
  });
  const plans = [];
  Object.keys(groups).sort().forEach(function(key) {
    const group = groups[key];
    if (group.rows.length > 24) throw new Error('Kapasitas CK: ' + group.branch + ', tanggal ' + group.day + ', kebutuhan ' + group.rows.length + ', kapasitas 24. Seluruh pengiriman ditolak.');
    if (previous[key] && previous[key].fileId === group.fileId && mutationCanonical_(previous[key].rows) === mutationCanonical_(group.rows)) return;
    const moved = previous[key] && previous[key].fileId !== group.fileId;
    if (moved) plans.push(tarikCkDestinationPlan_(model.target.fileId, key, Object.assign({}, previous[key], { rows:[] }), previous[key], true));
    plans.push(tarikCkDestinationPlan_(model.target.fileId, key, group, moved ? null : previous[key], false));
  });
  return plans;
}

function tarikCkDestinationPlan_(sourceFileId, key, group, ownership, cleanupOnly) {
    mutationAssertSpreadsheetWritable_(group.fileId);
    const spreadsheet = SpreadsheetApp.openById(group.fileId);
    const sheet = spreadsheet.getSheetByName('REKAP');
    if (!sheet) throw new Error('REKAP tujuan CK tidak ditemukan: ' + group.branch);
    const start = 6 + (group.day - 1) * 30;
    const before = sheet.getRange(start, 2, 24, 7).getValues();
    const tags = tarikMetadata_(sheet);
    before.forEach(function(row, index) {
      const tagsHere = tags[start + index] || [];
      const blank = !row.slice(2, -1).some(function(value) { return value !== '' && value !== null; }) && !/^YA$/i.test(String(row[row.length - 1] || ''));
      if (blank && !tagsHere.some(function(tag) { return tag.key.indexOf('PORTAL_R_') === 0 || tag.key === 'PORTAL_ROW_ID'; })) return;
      const tag = (tags[start + index] || []).filter(function(value) { return value.key === 'PORTAL_CK_OWNER'; })[0];
      if (!ownership || !tag || tag.value !== sourceFileId + '|' + key || mutationCanonical_(row) !== mutationCanonical_((ownership.rows[index] || {}).cells)) throw new Error('Kepemilikan baris tujuan CK belum terbukti: ' + group.branch + ', tanggal ' + group.day + ', baris ' + (start + index) + '.');
    });
    const after = Array.from({ length:24 }, function(_, index) { return group.rows[index] ? group.rows[index].cells : [group.day, before[index][1], '', '', '', '', '']; });
    return { sourceFileId:sourceFileId, key:key, fileId:group.fileId, start:start, before:before, after:after, group:group, owner:sourceFileId + '|' + key, cleanupOnly:Boolean(cleanupOnly) };
}

function tarikUploadPlannedPhotos_(plan, payload, path) {
  const candidates = (payload.newItems || []).concat(payload.photoItemsExisting || [], payload.editedItems || []);
  plan.edits.forEach(function(edit, index) {
    if (!edit.needsPhoto || edit.photoUrl) return;
    const source = candidates.filter(function(item) { return item.base64 && (edit.clientIndex != null ? item.clientIndex === edit.clientIndex : item.rowId === edit.rowId); })[0];
    if (!source) throw new Error('Foto belum diunggah. Ulangi pengiriman dari isian yang sama.');
    const rootId = PropertiesService.getScriptProperties().getProperty('FOLDER_PARENT_ID');
    if (!rootId) throw new Error('Folder foto belum dikonfigurasi.');
    const folder = getOrCreateFolder_(DriveApp.getFolderById(rootId), plan.target.period);
    const name = 'Nota-' + plan.operationId + '-' + (edit.receiptId ? mutationKey_(edit.receiptId) : index) + '.jpg';
    const existing = folder.getFilesByName(name);
    const file = existing.hasNext() ? existing.next() : folder.createFile(Utilities.newBlob(Utilities.base64Decode(String(source.base64).split(',').pop()), 'image/jpeg', name));
    edit.photoUrl = file.getUrl();
    edit.photoFileId = file.getId();
    if (edit.afterExpense) edit.afterExpense.fotoUrl = edit.photoUrl;
    mutationJournalWrite_(path + '/edits', plan.edits);
  });
  const receiptPhotos = {};
  plan.edits.filter(function(edit) { return edit.receiptId && edit.photoUrl; }).forEach(function(edit) {
    if (receiptPhotos[edit.receiptId] && receiptPhotos[edit.receiptId].photoFileId !== edit.photoFileId) throw new Error('Satu nota hanya dapat memiliki satu foto pengganti dalam satu pengiriman.');
    receiptPhotos[edit.receiptId] = edit;
  });
  Object.keys(receiptPhotos).forEach(function(id) {
    const edit = receiptPhotos[id];
    const receipt = plan.receiptUpdates['receipts/' + id];
    const oldPhotoId = receipt.photoId || '';
    receipt.photoId = 'PHT-' + mutationKey_(plan.operationId + '|' + id);
    plan.receiptUpdates['photos/' + receipt.photoId] = { id:receipt.photoId, branchId:plan.target.branchId, driveFileId:edit.photoFileId, fileName:'Nota pengganti.jpg', mimeType:'image/jpeg', createdAt:plan.createdAt, createdBy:plan.uid };
    if (oldPhotoId) plan.receiptUpdates['photoReceiptRefsV2/' + oldPhotoId + '/' + id] = null;
    plan.receiptUpdates['photoReceiptRefsV2/' + receipt.photoId + '/' + id] = true;
    portalReceiptIndexPaths_(receipt).forEach(function(key) { plan.receiptUpdates[key] = portalReceiptIndexSummary_(receipt); });
  });
  if (Object.keys(receiptPhotos).length) mutationJournalWrite_(path + '/receiptUpdates', plan.receiptUpdates);
}

function tarikNormalizePlan_(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Rencana pekerjaan tidak ditemukan.');
  if (!plan.target || !plan.target.fileId || !plan.operationId) throw new Error('Rencana pekerjaan tidak lengkap: identitas tujuan tidak tersedia.');
  if (!Array.isArray(plan.edits)) throw new Error('Rencana pekerjaan tidak lengkap: daftar perubahan tidak tersedia.');
  const isCentral = /central/i.test(String(plan.target.type || ''));
  if (plan.distribution == null) {
    if (isCentral) throw new Error('Rencana Central Kitchen lama tidak menyimpan daftar distribusi. Perlu peninjauan, jangan kirim ulang.');
    plan.distribution = [];
  }
  if (!Array.isArray(plan.distribution)) throw new Error('Rencana pekerjaan rusak: daftar distribusi tidak valid.');
  if (!plan.edits.length && !plan.distribution.length) throw new Error('Rencana pekerjaan tidak memiliki perubahan yang dapat dilanjutkan.');
  if (plan.extraWrites == null) plan.extraWrites = [];
  if (!Array.isArray(plan.extraWrites)) throw new Error('Rencana pekerjaan rusak: daftar pemindahan tidak valid.');
  const hasReceipt = plan.edits.some(function(edit) { return Boolean(edit && edit.receiptId); });
  if (plan.receiptUpdates == null) {
    if (hasReceipt) throw new Error('Rencana nota lama tidak menyimpan pembaruan nota. Perlu peninjauan, jangan kirim ulang.');
    plan.receiptUpdates = {};
  }
  if (plan.receiptExpected == null) {
    if (hasReceipt) throw new Error('Rencana nota lama tidak menyimpan versi pembanding. Perlu peninjauan, jangan kirim ulang.');
    plan.receiptExpected = {};
  }
  if (typeof plan.receiptUpdates !== 'object' || Array.isArray(plan.receiptUpdates) || typeof plan.receiptExpected !== 'object' || Array.isArray(plan.receiptExpected)) throw new Error('Rencana pekerjaan rusak: data nota tidak valid.');
  plan.progress = Number(plan.progress || 0);
  plan.status = String(plan.status || 'RECOVERY_REQUIRED');
  plan.edits.forEach(function(edit, index) {
    if (!edit || !Number(edit.rowIndex) || !edit.rowId || !Array.isArray(edit.beforeCells) || !Array.isArray(edit.afterCells)) throw new Error('Rencana pekerjaan rusak pada perubahan ' + (index + 1) + '.');
    if (!Object.prototype.hasOwnProperty.call(edit, 'next')) {
      const clearsRow = edit.afterCells.every(function(value) { return value === '' || value === null; });
      if (!clearsRow) throw new Error('Rencana pekerjaan lama kehilangan isi perubahan ' + (index + 1) + '. Perlu peninjauan, jangan kirim ulang.');
      edit.next = null;
    }
  });
  return plan;
}

function tarikExecutePlan_(plan, payload, path, executionId) {
  plan = tarikNormalizePlan_(plan);
  const extraWrites = plan.extraWrites || [];
  const fileIds = Array.from(new Set([plan.target.fileId].concat(plan.distribution.map(function(group) { return group.fileId; }), extraWrites.map(function(edit) { return edit.fileId; })))).sort();
  const mutationOperationId = plan.mutationOperationId || plan.operationId;
  const leases = [];
  let started = false;
  try {
    fileIds.forEach(function(id) { leases.push(mutationScopeAcquire_('sheet/' + id, plan.operationId, executionId, Boolean(plan.allowRecoveryTakeover))); });
    if (mutationJournalRead_('/mutationCommits/' + mutationOperationId + '-data')) return tarikFinishPlan_(plan, path);
    tarikUploadPlannedPhotos_(plan, payload || {}, path);
    const sheet = SpreadsheetApp.openById(plan.target.fileId).getSheetByName('REKAP');
    // Validate every source and destination again after all leases are held, before reserving any row.
    const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), plan.target.type === 'Central Kitchen' ? 9 : 8).getValues();
    const metadata = tarikMetadata_(sheet);
    tarikVerifyExtraWrites_(extraWrites);
    plan.edits.forEach(function(edit) {
      const row = values[edit.rowIndex - 1];
      const tags = metadata[edit.rowIndex] || [];
      const owned = tags.some(function(tag) { return tag.key === 'PORTAL_ROW_ID' && tag.value === edit.rowId; });
      const before = tarikRowVersion_(row, tags) === edit.beforeVersion;
      const after = owned && mutationCanonical_(row.slice(3)) === mutationCanonical_(edit.afterCells);
      const reserved = owned && mutationCanonical_(row.slice(3)) === mutationCanonical_(edit.beforeCells);
      const deleted = !edit.next && !tags.length && mutationCanonical_(row.slice(3)) === mutationCanonical_(edit.afterCells);
      if (!before && !after && !reserved && !(plan.status !== 'PREPARED' && deleted)) throw new Error('Konflik baris ' + edit.rowIndex + '. Pekerjaan tetap tersimpan untuk ditinjau.');
    });
    plan.distribution.forEach(function(group) {
      const target = SpreadsheetApp.openById(group.fileId).getSheetByName('REKAP');
      const current = target.getRange(group.start, 2, 24, 7).getValues();
      if (mutationCanonical_(current) !== mutationCanonical_(group.before) && mutationCanonical_(current) !== mutationCanonical_(group.after)) throw new Error('Tujuan CK berubah: ' + group.group.branch + '.');
    });
    const protectedRecords = Object.assign({}, plan.receiptExpected);
    plan.edits.forEach(function(edit) { const record = edit.beforeExpense || edit.afterExpense; if (record) protectedRecords['expenses/' + record.id] = edit.beforeExpense || null; });
    const workUpdates = {};
    Object.keys(protectedRecords).forEach(function(recordPath) { workUpdates['mutationWork/' + mutationKey_(recordPath)] = { operationId:plan.operationId, uid:plan.uid }; });
    started = true;
    mutationCommit_(workUpdates, { operationId:mutationOperationId + '-guard', expected:protectedRecords });
    plan.status = 'WRITING';
    mutationJournalWrite_(path + '/status', plan.status);
    started = true;
    plan.edits.forEach(function(edit) {
      if (!(metadata[edit.rowIndex] || []).some(function(tag) { return tag.key === 'PORTAL_ROW_ID' && tag.value === edit.rowId; })) sheet.getRange(edit.rowIndex + ':' + edit.rowIndex).addDeveloperMetadata('PORTAL_ROW_ID', edit.rowId);
      if (edit.receiptId && edit.next && !(metadata[edit.rowIndex] || []).some(function(tag) { return tag.key === portalReceiptMetadataKey_(edit.receiptId); })) {
        sheet.getRange(edit.rowIndex + ':' + edit.rowIndex).addDeveloperMetadata(portalReceiptMetadataKey_(edit.receiptId), 'COMMITTED|' + encodeURIComponent(edit.receiptDate || '') + '|' + encodeURIComponent(edit.itemId));
      }
    });
    SpreadsheetApp.flush();
    tarikApplyExtraWrites_(extraWrites);
    const sorted = plan.edits.slice().sort(function(a,b) { return a.rowIndex - b.rowIndex; });
    const batches = [];
    sorted.forEach(function(edit) {
      const last = batches[batches.length - 1];
      if (last && last.start + last.rows.length === edit.rowIndex) last.rows.push(edit.afterCells);
      else batches.push({ start:edit.rowIndex, rows:[edit.afterCells] });
    });
    batches.forEach(function(batch) { sheet.getRange(batch.start, 4, batch.rows.length, batch.rows[0].length).setValues(batch.rows); });
    SpreadsheetApp.flush();
    const deletionMetadata = plan.edits.some(function(edit) { return !edit.next; }) ? tarikMetadata_(sheet) : {};
    plan.edits.filter(function(edit) { return !edit.next; }).forEach(function(edit) {
      (deletionMetadata[edit.rowIndex] || []).sort(function(a,b) { return Number(a.key === 'PORTAL_ROW_ID') - Number(b.key === 'PORTAL_ROW_ID'); }).forEach(function(tag) { tag.metadata.remove(); });
    });
    mutationJournalWrite_(path + '/progress', plan.edits.length);
    plan.distribution.forEach(function(group) {
      const target = SpreadsheetApp.openById(group.fileId).getSheetByName('REKAP');
      target.getRange(group.start, 2, 24, 7).setValues(group.after);
      const tags = tarikMetadata_(target);
      for (let index = 0; index < 24; index++) {
        (tags[group.start + index] || []).filter(function(tag) { return tag.key === 'PORTAL_CK_OWNER' || tag.key === 'PORTAL_CK_ROW_ID'; }).forEach(function(tag) { tag.metadata.remove(); });
        if (index < group.group.rows.length) {
          target.getRange((group.start + index) + ':' + (group.start + index)).addDeveloperMetadata('PORTAL_CK_OWNER', group.owner);
          target.getRange((group.start + index) + ':' + (group.start + index)).addDeveloperMetadata('PORTAL_CK_ROW_ID', group.group.rows[index].sourceRowId);
        }
      }
    });
    SpreadsheetApp.flush();
    const updates = Object.assign({}, plan.receiptUpdates);
    Object.keys(protectedRecords).forEach(function(recordPath) { updates['mutationWork/' + mutationKey_(recordPath)] = null; });
    extraWrites.forEach(function(edit) { updates['sheetRowsV2/' + edit.fileId + '/' + edit.rowIndex] = { rowId:edit.rowId, expenseId:edit.expenseId || '', receiptId:edit.receiptId, itemId:edit.itemId }; });
    const mutations = [];
    plan.edits.forEach(function(edit) {
      const record = edit.afterExpense || edit.beforeExpense;
      if (record) { updates['expenses/' + record.id] = edit.afterExpense; mutations.push({ dataset:'expenses', before:edit.beforeExpense, after:edit.afterExpense }); }
      updates['sheetRowsV2/' + plan.target.fileId + '/' + edit.rowIndex] = edit.next ? { rowId:edit.rowId, expenseId:edit.afterExpense ? edit.afterExpense.id : '', receiptId:edit.receiptId, itemId:edit.itemId } : null;
    });
    plan.distribution.filter(function(group) { return !group.cleanupOnly; }).forEach(function(group) { updates['ckDistributionV2/' + (group.sourceFileId || plan.target.fileId) + '/' + group.key] = group.group.rows.length ? group.group : null; });
    legacyApplyAtomicMutation_(updates, mutations, { operationId:mutationOperationId + '-data', expected:plan.receiptExpected });
    invalidateDataCache_();
    const result = tarikFinishPlan_(plan, path);
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { mutationJournalWrite_(path + '/status', 'RECOVERY_REQUIRED'); } catch (ignored) {}
      let progress = Number(plan.progress || 0);
      try { progress = Number(mutationJournalRead_(path + '/progress') || progress); } catch (ignored) {}
      return { success:false, status:'RECOVERY_REQUIRED', operationId:plan.operationId, requestId:plan.requestId, progress:progress, message:'Perlu dilanjutkan. ' + error.message };
    }
    throw error;
  } finally {
    if (!started) leases.forEach(function(lease) { mutationScopeRelease_(lease, plan.operationId, executionId); });
    else leases.forEach(function(lease) {
      // Preserve ownership but allow an authenticated retry immediately after this invocation exits.
      try { fbCompareAndSet_(lease, function(current) { if (!current || current.executionId !== executionId) return { abort:true }; current.until = 0; return { value:current }; }); } catch (ignored) {}
    });
  }
}

function tarikVerifyExtraWrites_(edits) {
  edits.forEach(function(edit) {
    const sheet = SpreadsheetApp.openById(edit.fileId).getSheetByName('REKAP');
    const row = sheet.getRange(edit.rowIndex, 4, 1, edit.afterCells.length).getValues()[0];
    const tags = tarikMetadata_(sheet)[edit.rowIndex] || [];
    const owned = tags.some(function(tag) { return tag.key === 'PORTAL_ROW_ID' && tag.value === edit.rowId; });
    if (!(mutationCanonical_(row) === mutationCanonical_(edit.beforeCells) && (!tags.length || owned)) && !(owned && mutationCanonical_(row) === mutationCanonical_(edit.afterCells))) throw new Error('Baris tujuan pindah tanggal berubah: ' + edit.rowIndex);
  });
}

function tarikApplyExtraWrites_(edits) {
  edits.forEach(function(edit) {
    const sheet = SpreadsheetApp.openById(edit.fileId).getSheetByName('REKAP');
    const tags = tarikMetadata_(sheet)[edit.rowIndex] || [];
    if (!tags.some(function(tag) { return tag.key === 'PORTAL_ROW_ID'; })) sheet.getRange(edit.rowIndex + ':' + edit.rowIndex).addDeveloperMetadata('PORTAL_ROW_ID', edit.rowId);
    const key = portalReceiptMetadataKey_(edit.receiptId);
    if (!tags.some(function(tag) { return tag.key === key; })) sheet.getRange(edit.rowIndex + ':' + edit.rowIndex).addDeveloperMetadata(key, 'COMMITTED|' + encodeURIComponent(edit.date) + '|' + encodeURIComponent(edit.itemId));
    sheet.getRange(edit.rowIndex, 4, 1, edit.afterCells.length).setValues([edit.afterCells]);
  });
  if (edits.length) SpreadsheetApp.flush();
}

function tarikReceiptMutation_(session, payload, action) {
  const id = String(payload.receiptId || '');
  const requestId = String(payload.clientRequestId || '');
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId) || !Number(payload.expectedVersion)) throw new Error('Muat ulang sebelum mengubah nota: identitas permintaan atau versi belum tersedia.');
  const operationId = 'TARIK-' + mutationKey_(session.uid + '|' + requestId);
  const path = '/tarikJobsV2/' + operationId;
  const payloadHash = mutationKey_(mutationCanonical_({ action:action, payload:payload }));
  let plan = mutationJournalRead_(path);
  if (plan && plan.payloadHash !== payloadHash) throw new Error('Identitas permintaan sudah dipakai untuk isi berbeda.');
  if (plan && plan.status === 'COMPLETED') return plan.result;
  const executionId = mutationUuid_();
  const claim = mutationScopeAcquire_('request/' + operationId, operationId, executionId);
  MUTATION_SESSION_ = session;
  try {
    if (!plan) {
      const receipt = mutationJournalRead_('/receipts/' + id);
      if (!receipt || receipt.status !== 'APPROVED' || Number(receipt.version) !== Number(payload.expectedVersion)) throw new Error('Nota sudah berubah. Muat ulang.');
      portalAssertReceiptNotClaimed_(id);
      const sourceLink = portalResolveSpreadsheetTarget_(receipt.branchId, receipt.period);
      const type = /central/i.test(receipt.branchType) ? 'Central Kitchen' : 'Mandiri';
      const sourcePayload = { link:sourceLink.url, tipe:type, bulan:receipt.period.slice(4), tahun:receipt.period.slice(0,4), periode:receipt.period.slice(4) + '-' + receipt.period.slice(0,4) };
      const target = tarikTarget_(sourcePayload);
      mutationAssertSpreadsheetWritable_(target.fileId);
      const model = tarikReadModel_(target, sourcePayload);
      const rows = model.rows.filter(function(row) { return row.receiptId === id; });
      if (rows.length !== receipt.items.length || rows.some(function(row) { return !receipt.items.some(function(item) { return item.id === row.itemId; }); })) throw new Error('Kepemilikan seluruh baris nota belum terbukti. Tidak ada baris diubah.');
      const scope = [{ receiptId:id, version:receipt.version, itemIds:rows.map(function(row) { return row.itemId; }) }];
      if (action === 'ELIMINATE') {
        plan = tarikPrepare_(Object.assign({}, sourcePayload, { editedItems:rows.map(function(row) { return Object.assign({}, row, { eliminasi:'YA' }); }), confirmedReceipts:scope }), target, operationId);
      } else {
        const newDate = portalIsoDate_(payload.newDate);
        if (newDate === receipt.date) return { success:true, status:'COMPLETED', idempotent:true };
        const newPeriod = portalPeriod_(newDate);
        const destinationLink = portalResolveSpreadsheetTarget_(receipt.branchId, newPeriod);
        const destinationPayload = { link:destinationLink.url, tipe:type, bulan:newPeriod.slice(4), tahun:newPeriod.slice(0,4), periode:newPeriod.slice(4) + '-' + newPeriod.slice(0,4) };
        const destinationTarget = tarikTarget_(destinationPayload);
        mutationAssertSpreadsheetWritable_(destinationTarget.fileId);
        const destination = tarikReadModel_(destinationTarget, destinationPayload);
        const nextValues = destination.values.map(function(row) { return row.slice(); });
        const matches = tarikExpenseMatches_(model, rows);
        const edits = [];
        const extraWrites = [];
        rows.forEach(function(row) {
          const match = matches[row.rowId];
          if (match.conflict) throw new Error('Identitas arsip nota ambigu.');
          const day = Number(newDate.slice(-2));
          const offset = type === 'Central Kitchen' ? 1 : 0;
          const free = nextValues.findIndex(function(value,index) {
            const date = legacyTarikParseRowDate_(value[1], destinationPayload);
            return index >= 4 && date && date.getDate() === day && Number(value[2]) > 0 && !value[3 + offset] && !value[4 + offset] && !value[5 + offset] && !value[6 + offset] && !(destination.metadata[index + 1] || []).length;
          });
          if (free < 0) throw new Error('Kapasitas tanggal tujuan tidak cukup untuk seluruh nota.');
          const cells = tarikRowCells_(row, type);
          extraWrites.push({ fileId:destinationTarget.fileId, rowIndex:free + 1, rowId:row.rowId, receiptId:id, itemId:row.itemId, date:newDate, expenseId:match.id || '', beforeCells:nextValues[free].slice(3), afterCells:cells });
          nextValues[free].splice.apply(nextValues[free], [3, cells.length].concat(cells));
          edits.push({ rowIndex:row.sheetRowIndex, rowId:row.rowId, beforeVersion:row.version, beforeCells:model.values[row.sheetRowIndex - 1].slice(3), afterCells:Array(cells.length).fill(''), next:null, receiptId:id, itemId:row.itemId,
            beforeExpense:match.record || null, afterExpense:match.record ? Object.assign({}, match.record, { tanggal:portalStrictDate_(newDate).getTime(), rowId:row.rowId }) : null, needsPhoto:false, clientIndex:null });
        });
        const sourceValues = model.values.map(function(row) { return row.slice(); });
        edits.forEach(function(edit) { sourceValues[edit.rowIndex - 1].splice.apply(sourceValues[edit.rowIndex - 1], [3, edit.afterCells.length].concat(edit.afterCells)); });
        const sameFile = target.fileId === destinationTarget.fileId;
        if (sameFile) edits.forEach(function(edit) { nextValues[edit.rowIndex - 1] = sourceValues[edit.rowIndex - 1]; });
        destination.plannedRowIds = Object.fromEntries(extraWrites.map(function(edit) { return [edit.rowIndex, edit.rowId]; }));
        if (sameFile) model.plannedRowIds = destination.plannedRowIds;
        let distribution = [];
        if (type === 'Central Kitchen') {
          distribution = sameFile ? tarikPlanCk_(model, nextValues, operationId) : tarikPlanCk_(model, sourceValues, operationId).concat(tarikPlanCk_(destination, nextValues, operationId));
        }
        const nextReceipt = Object.assign({}, receipt, { date:newDate, period:newPeriod, version:Number(receipt.version) + 1, movedBy:session.uid, movedAt:Date.now() });
        const updates = {};
        const counts = {};
        updates['receipts/' + id] = nextReceipt;
        updates['sheetMappings/' + id] = { receiptId:id, spreadsheetId:destinationTarget.fileId, spreadsheetUrl:destinationTarget.url, sheetName:'REKAP', date:newDate, rowIndexes:extraWrites.map(function(edit) { return edit.rowIndex; }), itemIds:extraWrites.map(function(edit) { return edit.itemId; }), branchType:type, state:'COMMITTED', writtenAt:Date.now() };
        portalAddReceiptIndexMutation_(updates, receipt, nextReceipt, counts);
        portalApplyCountDeltas_(updates, counts);
        const expected = {}; expected['receipts/' + id] = receipt;
        plan = { target:target, edits:edits, extraWrites:extraWrites, distribution:distribution, receiptUpdates:updates, receiptExpected:expected, progress:0, status:'PREPARED', operationId:operationId };
      }
      Object.assign(plan, { uid:session.uid, requestId:requestId, payloadHash:payloadHash, createdAt:Date.now() });
      mutationJournalWrite_(path, JSON.parse(JSON.stringify(plan)));
    }
    return tarikExecutePlan_(plan, {}, path, executionId);
  } finally { mutationScopeRelease_(claim, operationId, executionId); MUTATION_SESSION_ = null; }
}

function tarikSubmitSafe_(payload) {
  if (!MUTATION_SESSION_) throw new Error('Sesi mutasi tidak tersedia.');
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(payload.clientRequestId || ''))) throw new Error('Muat ulang aplikasi sebelum menyimpan: identitas permintaan belum tersedia.');
  const operationId = 'TARIK-' + mutationKey_(MUTATION_SESSION_.uid + '|' + payload.clientRequestId);
  const path = '/tarikJobsV2/' + operationId;
  const hash = mutationKey_(mutationCanonical_(payload));
  let plan = mutationJournalRead_(path);
  if (plan && plan.payloadHash !== hash) throw new Error('Identitas permintaan sudah digunakan untuk isi yang berbeda.');
  if (plan && plan.status === 'COMPLETED') return plan.result;
  const executionId = mutationUuid_();
  const claim = mutationScopeAcquire_('request/' + operationId, operationId, executionId);
  try {
    if (!plan) {
      const target = tarikTarget_(payload);
      plan = tarikPrepare_(payload, target, operationId);
      Object.assign(plan, { payloadHash:hash, uid:MUTATION_SESSION_.uid, requestId:payload.clientRequestId, createdAt:Date.now() });
      mutationJournalWrite_(path, JSON.parse(JSON.stringify(plan)));
    }
    return tarikExecutePlan_(plan, payload, path, executionId);
  } finally { mutationScopeRelease_(claim, operationId, executionId); }
}

function tarikPublicJob_(plan, id) {
  const edits = Array.isArray(plan.edits) ? plan.edits : [];
  let validationError = '';
  try { tarikNormalizePlan_(JSON.parse(JSON.stringify(plan))); }
  catch (error) { validationError = String(error.message || error); }
  return { operationId:id, status:plan.status || 'RECOVERY_REQUIRED', progress:Number(plan.progress || 0), total:edits.length,
    createdAt:plan.createdAt || null, branchName:plan.target && plan.target.branchName || 'Cabang belum tersedia',
    period:plan.target && plan.target.period || '', validationError:validationError,
    result:plan.result || null,
    items:edits.map(function(edit, index) {
      const row = edit.next || edit.beforeExpense || {};
      return { rowIndex:edit.rowIndex, date:row.tanggal || '', description:row.keterangan || 'Perubahan baris',
        amount:Number(row.nominal || 0), action:edit.next === null ? 'Hapus' : 'Simpan perubahan',
        status:index < Number(plan.progress || 0) ? 'Penulisan tercatat' : 'Belum terkonfirmasi' };
    }) };
}

function tarikListPendingJobs_(session, payload) {
  const cursor = String(payload.cursor || '');
  if (cursor && !/^TARIK-[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error('Cursor pekerjaan tidak valid.');
  const query = { orderBy:'$key', limitToFirst:51 };
  if (cursor) query.startAt = cursor;
  const batch = fbReadQuery_('/tarikJobsV2', query) || {};
  const keys = Object.keys(batch).sort().filter(function(key) { return key > cursor; });
  const page = keys.slice(0, 50);
  const jobs = [];
  page.forEach(function(id) {
    const plan = mutationJournalDecode_(batch[id]);
    if (!plan || (session.role !== 'ADMIN' && plan.uid !== session.uid) || plan.status === 'COMPLETED' || plan.status === 'CANCELLED') return;
    jobs.push(tarikPublicJob_(plan, id));
  });
  return { jobs:jobs, nextCursor:Object.keys(batch).length === 51 && page.length ? page[page.length - 1] : '' };
}

function tarikJobStatus_(session, payload) {
  const id = String(payload.operationId || (payload.clientRequestId ? 'TARIK-' + mutationKey_(session.uid + '|' + payload.clientRequestId) : ''));
  if (!/^TARIK-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Identitas pekerjaan tidak valid.');
  const plan = mutationJournalRead_('/tarikJobsV2/' + id);
  if (!plan || (plan.uid !== session.uid && session.role !== 'ADMIN')) throw new Error('Pekerjaan tidak ditemukan atau akses tidak diizinkan.');
  return tarikPublicJob_(plan, id);
}

function tarikCancelJob_(session, payload) {
  const id = String(payload.operationId || '');
  if (!/^TARIK-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Identitas pekerjaan tidak valid.');
  const path = '/tarikJobsV2/' + id;
  const raw = mutationJournalRead_(path);
  if (!raw || (session.role !== 'ADMIN' && raw.uid !== session.uid)) throw new Error('Pekerjaan tidak ditemukan atau akses tidak diizinkan.');
  if (raw.status === 'CANCELLED') return { success:true, operationId:id, status:'CANCELLED' };
  if (raw.status === 'COMPLETED' || mutationJournalRead_('/mutationCommits/' + id + '-data')) throw new Error('Pekerjaan sudah menyimpan data dan tidak dapat dibatalkan.');
  if (Number(raw.progress || 0) > 0) throw new Error('Sebagian baris sudah tercatat. Lanjutkan pemulihan atau minta pemeriksaan Admin.');
  if (mutationJournalRead_('/mutationCommits/' + id + '-guard')) throw new Error('Tahap perlindungan data sudah dimulai. Pekerjaan tidak aman dibatalkan otomatis.');
  const plan = tarikNormalizePlan_(JSON.parse(JSON.stringify(raw)));
  if (plan.edits.some(function(edit) { return edit.needsPhoto && edit.photoUrl; })) throw new Error('Pekerjaan sudah mengunggah foto. Pekerjaan tidak aman dibatalkan otomatis.');

  const source = SpreadsheetApp.openById(plan.target.fileId).getSheetByName('REKAP');
  if (!source) throw new Error('Sheet REKAP tidak ditemukan.');
  plan.edits.forEach(function(edit) {
    const current = source.getRange(edit.rowIndex, 4, 1, edit.beforeCells.length).getValues()[0];
    if (mutationCanonical_(current) !== mutationCanonical_(edit.beforeCells)) {
      if (mutationCanonical_(current) === mutationCanonical_(edit.afterCells)) throw new Error('Baris ' + edit.rowIndex + ' sudah berisi hasil pengiriman ini. Pilih Lanjutkan pekerjaan agar database dan statusnya diselesaikan.');
      throw new Error('Baris ' + edit.rowIndex + ' diubah setelah pekerjaan dibuat dan isinya berbeda dari rencana pengiriman. Minta Admin memeriksa baris tersebut.');
    }
  });
  (plan.extraWrites || []).forEach(function(edit) {
    const sheet = SpreadsheetApp.openById(edit.fileId).getSheetByName('REKAP');
    const current = sheet && sheet.getRange(edit.rowIndex, 4, 1, edit.beforeCells.length).getValues()[0];
    if (!current || mutationCanonical_(current) !== mutationCanonical_(edit.beforeCells)) throw new Error('Baris pemindahan sudah berubah. Pekerjaan tidak aman dibatalkan otomatis.');
  });
  plan.distribution.forEach(function(group) {
    const sheet = SpreadsheetApp.openById(group.fileId).getSheetByName('REKAP');
    const current = sheet && sheet.getRange(group.start, 2, 24, 7).getValues();
    if (!current || mutationCanonical_(current) !== mutationCanonical_(group.before)) throw new Error('Distribusi Central Kitchen sudah berubah. Pekerjaan tidak aman dibatalkan otomatis.');
  });
  mutationJournalUpdate_(path, { status:'CANCELLED', cancelledAt:Date.now(), cancelledBy:session.uid });
  portalAudit_('CANCEL_TARIK_JOB', session.uid, { operationId:id, branchName:plan.target.branchName || '', period:plan.target.period || '', total:plan.edits.length });
  return { success:true, operationId:id, status:'CANCELLED', total:plan.edits.length };
}

function tarikResolveReceiptUpdatesFromSpreadsheet_(session, plan, edits) {
  const updates = {};
  const expected = {};
  const counts = {};
  const receiptIds = Array.from(new Set(edits.map(function(edit) { return edit.receiptId; }).filter(Boolean)));
  receiptIds.forEach(function(receiptId) {
    const before = mutationJournalRead_('/receipts/' + receiptId);
    if (!before) throw new Error('Nota ' + receiptId + ' tidak ditemukan.');
    const next = JSON.parse(JSON.stringify(before));
    const receiptEdits = edits.filter(function(edit) { return edit.receiptId === receiptId; });
    if (receiptEdits.some(function(edit) { return !edit.next; })) {
      next.status = 'REJECTED';
      next.review = { decision:'DISCARD', reason:'Diselaraskan dengan Spreadsheet pada penyelesaian pengiriman tertunda', reviewedBy:session.uid, reviewedAt:Date.now() };
      updates['sheetMappings/' + receiptId] = null;
    } else {
      receiptEdits.forEach(function(edit) {
        const item = (next.items || []).filter(function(value) { return value.id === edit.itemId; })[0];
        if (!item) throw new Error('Item nota pada baris ' + edit.rowIndex + ' tidak ditemukan.');
        const quantity = String(edit.next.jumlah || '').trim().match(/^([0-9.,]+)\s*(.*)$/);
        item.description = edit.next.keterangan;
        item.category = edit.next.jenis;
        item.quantity = quantity ? Number(quantity[1].replace(',', '.')) : Number(item.quantity || 1);
        item.unit = quantity ? quantity[2] : String(edit.next.jumlah || item.unit || '');
        item.amount = Number(edit.next.nominal || 0);
        item.grossAmount = item.amount + Number(item.discountAllocated || 0);
        if (plan.target.type === 'Central Kitchen') item.distributionBranch = edit.next.cabang;
      });
      next.receiptTotal = (next.items || []).reduce(function(total, item) { return total + Number(item.amount || 0); }, 0);
      next.grossTotal = next.receiptTotal + Number(next.discountTotal || 0);
      next.eliminated = receiptEdits.every(function(edit) { return String(edit.next.eliminasi || '').toUpperCase() === 'YA'; });
    }
    next.version = Number(next.version || 1) + 1;
    next.updatedAt = Date.now();
    updates['receipts/' + receiptId] = next;
    expected['receipts/' + receiptId] = before;
    portalAddReceiptIndexMutation_(updates, before, next, counts);
  });
  portalApplyCountDeltas_(updates, counts);
  return { updates:updates, expected:expected };
}

function tarikResolveJobFromSpreadsheet_(session, payload) {
  const id = String(payload.operationId || '');
  if (!/^TARIK-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Identitas pekerjaan tidak valid.');
  const path = '/tarikJobsV2/' + id;
  const raw = mutationJournalRead_(path);
  if (!raw || (session.role !== 'ADMIN' && raw.uid !== session.uid)) throw new Error('Pekerjaan tidak ditemukan atau akses tidak diizinkan.');
  if (raw.status === 'COMPLETED') return raw.result;
  if (raw.status === 'CANCELLED') throw new Error('Pekerjaan sudah dibatalkan.');
  if (!raw.target || !raw.target.fileId || !Array.isArray(raw.edits)) throw new Error('Rencana lama tidak memiliki identitas Spreadsheet atau daftar baris.');
  if (mutationJournalRead_('/mutationCommits/' + id + '-data')) return tarikFinishPlan_(tarikNormalizePlan_(raw), path);

  const executionId = mutationUuid_();
  const claim = mutationScopeAcquire_('request/' + id, id, executionId, true);
  MUTATION_SESSION_ = session;
  try {
    const period = String(raw.target.period || '');
    const model = tarikReadModel_(raw.target, { bulan:period.slice(4, 6), tahun:period.slice(0, 4) });
    const rowsByIndex = {};
    model.rows.forEach(function(row) { rowsByIndex[row.sheetRowIndex] = row; });
    const edits = raw.edits.map(function(oldEdit) {
      const rowIndex = Number(oldEdit.rowIndex);
      const row = rowsByIndex[rowIndex] || null;
      const fullRow = model.values[rowIndex - 1] || [];
      const tags = model.metadata[rowIndex] || [];
      const cellsLength = Array.isArray(oldEdit.beforeCells) ? oldEdit.beforeCells.length : (raw.target.type === 'Central Kitchen' ? 6 : 5);
      const cells = fullRow.slice(3, 3 + cellsLength);
      const spreadsheetChanged = Array.isArray(oldEdit.beforeCells) && mutationCanonical_(cells) !== mutationCanonical_(oldEdit.beforeCells);
      const useSpreadsheet = spreadsheetChanged || !Array.isArray(oldEdit.afterCells);
      const chosenCells = useSpreadsheet ? cells : oldEdit.afterCells.slice();
      const oldRecord = oldEdit.beforeExpense || oldEdit.afterExpense || null;
      const expenseId = useSpreadsheet && row && row.expenseId || oldRecord && oldRecord.id || (row ? row.expenseId : '') || ('UMM-' + mutationKey_(id + '|spreadsheet|' + rowIndex));
      const currentRecord = mutationJournalRead_('/expenses/' + expenseId);
      let next = null;
      let afterExpense = null;
      if (!useSpreadsheet && Object.prototype.hasOwnProperty.call(oldEdit, 'next')) {
        next = oldEdit.next ? JSON.parse(JSON.stringify(oldEdit.next)) : null;
      } else if (row) {
        next = tarikJournalRow_(row);
      }
      if (next) {
        const parsedDate = legacyTarikParseRowDate_(next.tanggal, {bulan:period.slice(4, 6),tahun:period.slice(0, 4)});
        if (!parsedDate) throw new Error('Tanggal pada baris ' + rowIndex + ' tidak dapat dibaca.');
        const plannedRecord = oldEdit.afterExpense || oldRecord || {};
        afterExpense = Object.assign({}, currentRecord || oldRecord || {}, {
          id:expenseId, timestamp:(currentRecord || plannedRecord).timestamp || Date.now(), tanggal:parsedDate.getTime(),
          cabang:next.cabang || raw.target.branchName, cv:(currentRecord || plannedRecord).cv || '-', nominal:Number(next.nominal || 0),
          fotoUrl:plannedRecord.fotoUrl || (currentRecord || {}).fotoUrl || '', kategori:'Umum', keterangan:next.keterangan,
          jenis:next.jenis, jumlah:next.jumlah, noUrut:next.no, eliminasi:next.eliminasi || '', rowId:next.rowId || oldEdit.rowId
        });
      }
      return { rowIndex:rowIndex, rowId:useSpreadsheet && row ? row.rowId : oldEdit.rowId,
        changeKind:!next ? 'DELETED' : currentRecord ? 'UPDATED' : 'ADDED', beforeHadPhoto:Boolean(currentRecord && currentRecord.fotoUrl),
        beforeCells:cells, afterCells:chosenCells, beforeVersion:tarikRowVersion_(fullRow, tags), spreadsheetChanged:spreadsheetChanged,
        beforeExpense:currentRecord || null, afterExpense:afterExpense, next:next,
        receiptId:oldEdit.receiptId || '', itemId:oldEdit.itemId || '', receiptDate:oldEdit.receiptDate || '',
        photoUrl:useSpreadsheet ? '' : oldEdit.photoUrl || '', photoFileId:useSpreadsheet ? '' : oldEdit.photoFileId || '',
        needsPhoto:useSpreadsheet ? false : Boolean(oldEdit.needsPhoto && !oldEdit.photoUrl), clientIndex:useSpreadsheet ? null : oldEdit.clientIndex };
    });
    const resolvedValues = model.values.map(function(row) { return row.slice(); });
    edits.forEach(function(edit) { resolvedValues[edit.rowIndex - 1].splice.apply(resolvedValues[edit.rowIndex - 1], [3, edit.afterCells.length].concat(edit.afterCells)); });
    model.plannedRowIds = Object.fromEntries(edits.map(function(edit) { return [edit.rowIndex, edit.rowId]; }));
    const receiptPlan = tarikResolveReceiptUpdatesFromSpreadsheet_(session, raw, edits);
    const plan = { uid:raw.uid, requestId:raw.requestId || id, operationId:id, createdAt:raw.createdAt || Date.now(),
      target:raw.target, edits:edits, extraWrites:[],
      distribution:raw.target.type === 'Central Kitchen' ? tarikPlanCk_(model, resolvedValues, id) : [],
      receiptUpdates:receiptPlan.updates, receiptExpected:receiptPlan.expected,
      progress:0, status:'PREPARED', resolutionMode:'SPREADSHEET_PRIORITY', mutationOperationId:id + '-spreadsheet', allowRecoveryTakeover:true };
    mutationJournalWrite_(path, plan);
    const result = tarikExecutePlan_(plan, {}, path, executionId);
    if (result && result.success) portalAudit_('RESOLVE_TARIK_FROM_SPREADSHEET', session.uid, { operationId:id, branchName:plan.target.branchName || '', period:plan.target.period || '', total:edits.length });
    return result;
  } finally {
    mutationScopeRelease_(claim, id, executionId);
    MUTATION_SESSION_ = null;
  }
}

function tarikJobResume_(session, payload) {
  const status = tarikJobStatus_(session, payload);
  if (status.status === 'COMPLETED') return status.result;
  const path = '/tarikJobsV2/' + status.operationId;
  const plan = tarikNormalizePlan_(mutationJournalRead_(path));
  MUTATION_SESSION_ = session;
  const executionId = mutationUuid_();
  const claim = mutationScopeAcquire_('request/' + plan.operationId, plan.operationId, executionId);
  try { return tarikExecutePlan_(plan, {}, path, executionId); }
  finally { mutationScopeRelease_(claim, plan.operationId, executionId); MUTATION_SESSION_ = null; }
}

function tarikPlanResultSummary_(plan) {
  const summary = { added:0, updated:0, deleted:0, photoRows:0, uploadedFiles:0, detachedPhotoRows:0, total:plan.edits.length };
  const files = {};
  plan.edits.forEach(function(edit) {
    const kind = edit.changeKind || (!edit.next ? 'DELETED' : !edit.beforeExpense && !edit.receiptId && !(edit.beforeCells || []).slice(0,-1).some(function(value) { return value !== '' && value !== null; }) ? 'ADDED' : 'UPDATED');
    summary[kind === 'ADDED' ? 'added' : kind === 'DELETED' ? 'deleted' : 'updated']++;
    if (edit.photoUrl) { summary.photoRows++; files[edit.photoFileId || edit.photoUrl] = true; }
    const hadPhoto = edit.beforeHadPhoto || Boolean(edit.beforeExpense && edit.beforeExpense.fotoUrl);
    if (hadPhoto && (!edit.next || edit.next.removePhoto)) summary.detachedPhotoRows++;
  });
  summary.uploadedFiles = Object.keys(files).length;
  return summary;
}

function tarikFinishPlan_(plan, path) {
    const result = { success:true, status:'COMPLETED', requestId:plan.requestId, operationId:plan.operationId, progress:plan.edits.length,
      summary:tarikPlanResultSummary_(plan),
      rows:plan.edits.filter(function(edit) { return edit.next; }).map(function(edit) { return edit.rowIndex; }), itemCount:plan.edits.length,
      addedResults:plan.edits.filter(function(edit) { return edit.next && edit.clientIndex != null; }).map(function(edit) { return { clientIndex:edit.clientIndex, sheetRowIndex:edit.rowIndex, rowId:edit.rowId, no:edit.next.no }; }),
      photoResults:plan.edits.filter(function(edit) { return edit.photoUrl; }).map(function(edit) { return { clientIndex:edit.clientIndex, fotoUrl:edit.photoUrl }; }),
      syncResult:plan.distribution.length ? 'Distribusi cabang/tanggal terkait diperbarui.' : '', pullResult:'', rekapPengeluaranData:null
    };
    // Summary errors cannot change a committed transaction into a failed save.
    try {
      if (plan.target.type === 'Central Kitchen' && plan.distribution.length) tarikRefreshCkSummary_(plan);
      result.rekapPengeluaranData = plan.target.type === 'Mandiri' ? getMandiriSummaryHelper_(SpreadsheetApp.openById(plan.target.fileId)) : readCentralKitchenSummary_(SpreadsheetApp.openById(plan.target.fileId).getSheetByName('REKAP'));
    }
    catch (error) { result.warning = 'Transaksi tersimpan. Ringkasan belum diperbarui; muat ulang ringkasan.'; }
    mutationJournalUpdate_(path, { status:'COMPLETED', result:result, progress:plan.edits.length });
    return result;
}

function tarikRefreshCkSummary_(plan) {
  const sourceIds = Array.from(new Set(plan.distribution.map(function(group) { return group.sourceFileId || plan.target.fileId; })));
  sourceIds.forEach(function(sourceId) {
    const sheet = SpreadsheetApp.openById(sourceId).getSheetByName('REKAP');
    const names = sheet.getRange(5, 11, Math.max(1, sheet.getLastRow() - 4), 1).getValues();
    const targets = {};
    plan.distribution.filter(function(group) { return (group.sourceFileId || plan.target.fileId) === sourceId; }).forEach(function(group) { targets[group.group.branch] = group.fileId; });
    Object.keys(targets).forEach(function(branch) {
      const index = names.findIndex(function(row) { return String(row[0] || '').trim().toUpperCase() === branch; });
      if (index < 0) throw new Error('Posisi ringkasan cabang ' + branch + ' belum tersedia.');
      const branchSheet = SpreadsheetApp.openById(targets[branch]).getSheetByName('REKAP PENGELUARAN');
      if (!branchSheet) throw new Error('Ringkasan cabang belum tersedia.');
      const values = branchSheet.getRange(42, 2, 7, 19).getValues();
      const columns = [2,4,6,8,12,14,16,18];
      const top = columns.map(function(column) { return safeNum_(values[1][column]); });
      const bottom = columns.map(function(column) { return safeNum_(values[0][column]); });
      top.push(top[7] * safeNum_(values[6][0]));
      bottom.push(bottom[7] * safeNum_(values[6][0]));
      sheet.getRange(5 + index, 12, 2, 9).setValues([top, bottom]);
      sheet.getRange(5 + index, 21, 1, 1).setValues([[bottom[8] - top[8]]]);
    });
  });
}

function tarikApproveReceipt_(session, receiptId, expectedVersion) {
  const operationId = 'TARIK-' + mutationKey_('APPROVE|' + receiptId + '|' + expectedVersion);
  const path = '/tarikJobsV2/' + operationId;
  const executionId = mutationUuid_();
  const claim = mutationScopeAcquire_('request/' + operationId, operationId, executionId);
  MUTATION_SESSION_ = session;
  try {
    let plan = mutationJournalRead_(path);
    if (plan && plan.status === 'COMPLETED') return plan.result;
    if (!plan) {
      const receipt = mutationJournalRead_('/receipts/' + receiptId);
      if (!receipt) throw new Error('Nota tidak ditemukan.');
      const existingMapping = mutationJournalRead_('/sheetMappings/' + receiptId);
      if (receipt.status === 'APPROVED' && existingMapping) return { success:true, rows:existingMapping.rowIndexes, idempotent:true };
      if (receipt.status !== 'PENDING' || Number(receipt.version || 1) !== Number(expectedVersion)) throw new Error('Nota sudah berubah atau pemulihan versi lama perlu ditinjau.');
      const link = portalResolveSpreadsheetTarget_(receipt.branchId, receipt.period);
      const payload = { link:link.url, tipe:/central/i.test(receipt.branchType) ? 'Central Kitchen' : 'Mandiri', bulan:receipt.period.slice(4), tahun:receipt.period.slice(0,4), periode:receipt.period.slice(4) + '-' + receipt.period.slice(0,4) };
      const target = tarikTarget_(payload);
      mutationAssertSpreadsheetWritable_(target.fileId);
      const model = tarikReadModel_(target, payload);
      const occupied = {};
      Object.keys(model.metadata).forEach(function(row) { occupied[row] = true; });
      const allocation = portalPlanReceiptRows_(model.sheet, receipt, target.type, {}, {}, occupied);
      if (allocation.insertCount) throw new Error('Kapasitas baris tanggal tujuan tidak cukup untuk seluruh nota.');
      const nextValues = model.values.map(function(row) { return row.slice(); });
      const edits = allocation.allocations.map(function(item) {
        const before = model.values[item.rowIndex - 1];
        if (!before || before.slice(3, -1).some(function(value) { return value !== '' && value !== null; })) throw new Error('Slot approval tidak kosong.');
        const cells = item.values.slice(2);
        nextValues[item.rowIndex - 1].splice.apply(nextValues[item.rowIndex - 1], [3, cells.length].concat(cells));
        const rowId = mutationUuid_();
        return { rowIndex:item.rowIndex, rowId:rowId, receiptId:receiptId, itemId:item.itemId, receiptDate:receipt.date,
          beforeCells:before.slice(3), afterCells:cells, beforeVersion:tarikRowVersion_(before, model.metadata[item.rowIndex] || []), beforeExpense:null, afterExpense:null,
          next:{ rowId:rowId, no:before[2] }, needsPhoto:false, clientIndex:null };
      });
      model.plannedRowIds = Object.fromEntries(edits.map(function(edit) { return [edit.rowIndex, edit.rowId]; }));
    const distribution = target.type === 'Central Kitchen' ? tarikPlanCk_(model, nextValues, operationId) : [];
      const updates = {};
      const counts = {};
      const approved = Object.assign({}, receipt, { status:'APPROVED', version:Number(receipt.version || 1) + 1, approvedAt:Date.now(), review:{ decision:'APPROVE', reason:'', reviewedBy:session.uid, reviewedAt:Date.now() } });
      updates['receipts/' + receiptId] = approved;
      updates['sheetMappings/' + receiptId] = { receiptId:receiptId, spreadsheetId:target.fileId, spreadsheetUrl:target.url, sheetName:'REKAP', rowIndexes:edits.map(function(edit) { return edit.rowIndex; }), itemIds:edits.map(function(edit) { return edit.itemId; }), date:receipt.date, branchType:receipt.branchType, state:'COMMITTED', writtenAt:Date.now() };
      portalAddReceiptIndexMutation_(updates, receipt, approved, counts);
      portalApplyCountDeltas_(updates, counts);
      const expected = {}; expected['receipts/' + receiptId] = receipt;
      plan = { uid:session.uid, requestId:operationId, operationId:operationId, target:target, edits:edits, distribution:distribution, receiptUpdates:updates, receiptExpected:expected, status:'PREPARED', progress:0, createdAt:Date.now() };
      mutationJournalWrite_(path, plan);
    }
    const result = tarikExecutePlan_(plan, {}, path, executionId);
    if (!result.success) throw new Error(result.message);
    portalClearReceiptsCache_();
    return result;
  } finally { mutationScopeRelease_(claim, operationId, executionId); MUTATION_SESSION_ = null; }
}
