/** Bounded index traversal, with complete search across every selected period. */
function legacyReadExpenseYearRows_(year) {
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  const key = 'listrik-year-' + year + '-' + version;
  const cached = cacheGetJson_(key); if (cached) return cached;
  const specs = Array.from({length:12}, function(_,index) { return { path:'/expenseIndexV1/byPeriodType/' + year + String(index + 1).padStart(2,'0') + '/LISTRIK', params:{orderBy:'$key',limitToFirst:250} }; });
  const first = fbReadBatch_(specs);
  const rows = [];
  specs.forEach(function(spec,index) {
    let batch = first[index] || {}, cursor = '';
    while (true) {
      const keys = Object.keys(batch).sort().filter(function(key) { return !cursor || key > cursor; });
      keys.forEach(function(key) { rows.push(batch[key].row); });
      if (Object.keys(batch).length < 250 || !keys.length) break;
      cursor = keys[keys.length - 1];
      batch = fbReadQuery_(spec.path, {orderBy:'$key',limitToFirst:250,startAt:cursor}) || {};
    }
  });
  if (version !== String(fbRead_('/dataVersions/legacy') || 'v79')) throw new Error('Data berubah selama pembacaan. Muat ulang.');
  cachePutJson_(key, rows, 240);
  return rows;
}

function legacyIndexPageV2_(dataset, opts, type) {
  const filters = opts.filters || {};
  const periodInfo = legacyFilterPeriod_(filters);
  const segments = dataset === 'ocr_history' ? [filters.cabang ? legacyIndexSegment_(filters.cabang) : '_ALL'] :
    (type === 'umum' ? ['UMUM'] : type === 'listrik' ? ['LISTRIK'] : ['LISTRIK', 'UMUM']);
  const base = dataset === 'expenses' ? '/expenseIndexV1/byPeriodType/' : '/ocrIndexV1/byPeriodBranch/';
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  const shape = mutationKey_(mutationCanonical_({ dataset:dataset, filters:filters, sort:opts.sort, type:type, limit:opts.limit }));
  const standard = periodInfo && periodInfo.coversWholePeriod && !String(filters.search || '').trim() && legacyDefaultSort_(dataset, opts.sort);
  if (standard) {
    const cursorKey = 'cursor-v2-' + mutationKey_(version + shape + '|' + opts.page);
    const supplied = opts.cursor || cacheGetJson_(cursorKey);
    const cursor = supplied && supplied.version === version && supplied.shape === shape ? supplied : null;
    let lastKey = cursor ? cursor.lastKey : '';
    let skip = cursor ? 0 : (opts.page - 1) * opts.limit;
    let rows = [];
    let exhausted = false;
    while (rows.length < opts.limit && !exhausted) {
      const size = Math.min(250, skip + opts.limit - rows.length);
      const responses = fbReadBatch_(segments.map(function(segment) {
        const params = { orderBy:'$key', limitToLast:size + (lastKey ? 1 : 0) };
        if (lastKey) params.endAt = lastKey;
        return { path:base + periodInfo.period + '/' + segment, params:params };
      }));
      const candidates = [];
      responses.forEach(function(response) {
        Object.keys(response || {}).forEach(function(key) {
          if (!lastKey || key < lastKey) candidates.push({ key:key, row:response[key].row });
        });
      });
      candidates.sort(function(a,b) { return a.key < b.key ? 1 : a.key > b.key ? -1 : 0; });
      const consumed = candidates.slice(0, size);
      if (!consumed.length) break;
      lastKey = consumed[consumed.length - 1].key;
      consumed.forEach(function(item) { if (skip) skip--; else if (rows.length < opts.limit) rows.push(item.row); });
      exhausted = candidates.length < size;
    }
    const aggregates = fbReadBatch_(segments.map(function(segment) { return { path:'/legacyAggregatesV1/' + dataset + '/' + periodInfo.period + '/' + segment }; }));
    const totals = aggregates.reduce(function(sum, value) { return { total:sum.total + Number(value && value.count || 0), totalAmount:sum.totalAmount + Number(value && value.totalAmount || 0) }; }, { total:0, totalAmount:0 });
    if (version !== String(fbRead_('/dataVersions/legacy') || 'v79')) throw new Error('Data berubah selama pembacaan. Muat ulang halaman.');
    const nextCursor = rows.length ? { version:version, shape:shape, lastKey:lastKey } : null;
    if (nextCursor) cachePutJson_('cursor-v2-' + mutationKey_(version + shape + '|' + (opts.page + 1)), nextCursor, 240);
    return Object.assign({ rows:rows, history:rows, page:opts.page, limit:opts.limit, type:type, nextCursor:nextCursor, dataVersion:version }, totals);
  }
  const cacheKey = 'search-v2-' + mutationKey_(version + '|' + shape);
  let allRows = cacheGetJson_(cacheKey);
  if (!allRows) {
    const periods = periodInfo ? [periodInfo.period] : Object.keys(fbReadQuery_(base.slice(0, -1), { shallow:true }) || {}).sort();
    allRows = [];
    const search = String(filters.search || '').trim().toLowerCase();
    periods.forEach(function(period) {
      if (filters.startTime && period < Utilities.formatDate(new Date(Number(filters.startTime)), Session.getScriptTimeZone(), 'yyyyMM')) return;
      if (filters.endTime && period > Utilities.formatDate(new Date(Number(filters.endTime)), Session.getScriptTimeZone(), 'yyyyMM')) return;
      segments.forEach(function(segment) {
        let cursor = '';
        while (true) {
          const params = { orderBy:'$key', limitToFirst:2000 };
          if (cursor) params.startAt = cursor;
          const batch = fbReadQuery_(base + period + '/' + segment, params) || {};
          const keys = Object.keys(batch).sort();
          const fresh = keys.filter(function(key) { return !cursor || key > cursor; });
          fresh.forEach(function(key) {
            const row = batch[key].row;
            if (!applyDateFilter_(row[2], filters)) return;
            const text = dataset === 'ocr_history' ? ((row[5] || '') + ' ' + (row[6] || '')) :
              type === 'umum' ? [row[3], row[8], row[10], row[11]].join(' ') : [row[3], row[4]].join(' ');
            if (!search || text.toLowerCase().indexOf(search) >= 0) allRows.push(row);
          });
          if (keys.length < 2000 || !fresh.length) break;
          cursor = keys[keys.length - 1];
        }
      });
    });
    sortRows_(allRows, opts.sort, dataset === 'expenses' ? 2 : 1, false);
    if (version === String(fbRead_('/dataVersions/legacy') || 'v79')) cachePutJson_(cacheKey, allRows, 240);
    else throw new Error('Data berubah selama pencarian. Ulangi pencarian untuk hasil terkini.');
  }
  const rows = allRows.slice((opts.page - 1) * opts.limit, opts.page * opts.limit);
  return { rows:rows, history:rows, total:allRows.length, totalAmount:allRows.reduce(function(sum,row) { return sum + Number(row[dataset === 'expenses' ? 5 : 8] || 0); }, 0), page:opts.page, limit:opts.limit, type:type, nextCursor:null, dataVersion:version };
}

/** Additive, resumable maintenance. Call only in reviewed DEV/admin workflows. */
function legacyBackfillIdentityBatch_(period, cursor) {
  portalValidatePeriod_(period);
  const path = '/expenseIndexV1/byPeriodType/' + period + '/UMUM';
  const params = { orderBy:'$key', limitToFirst:250 };
  if (cursor) params.startAt = cursor;
  const batch = fbReadQuery_(path, params) || {};
  const keys = Object.keys(batch).sort().filter(function(key) { return !cursor || key > cursor; });
  const updates = {};
  const expected = {};
  const originals = fbReadBatch_(keys.map(function(key) { return { path:'/expenses/' + batch[key].id }; }));
  keys.forEach(function(key,index) {
    const record = originals[index];
    if (!record || mutationCanonical_(legacyIndexSummary_('expenses',record)) !== mutationCanonical_(batch[key])) throw new Error('Indeks lama berbeda dari arsip. Tinjau laporan selisih sebelum melanjutkan.');
    expected['expenses/' + record.id] = record;
    updates['expenseIdentityV2/' + period + '/' + mutationKey_(legacyExpenseIdentity_(record)) + '/' + record.id] = true;
  });
  const next = keys.length ? keys[keys.length - 1] : cursor || '';
  updates['expenseIdentityV2Meta/' + period] = { cursor:next, built:keys.length < (cursor ? 249 : 250), validated:false, updatedAt:Date.now() };
  mutationCommit_(updates, { operationId:'INDEX-' + mutationUuid_(), expected:expected });
  return { processed:keys.length, cursor:next, complete:updates['expenseIdentityV2Meta/' + period].built, validated:false };
}

function legacyReadDiscrepancyBatch_(session, payload) {
  const dataset = legacyIndexDataset_(payload.dataset || 'expenses');
  const period = portalValidatePeriod_(payload.period);
  const cursor = String(payload.cursor || '');
  const params = { orderBy:'$key', limitToFirst:250 };
  if (cursor) params.startAt = cursor;
  const source = fbReadQuery_('/' + dataset, params) || {};
  const allKeys = Object.keys(source).sort();
  const keys = allKeys.filter(function(key) { return !cursor || key > cursor; });
  const selected = keys.filter(function(key) { return legacyIndexPeriod_(dataset, source[key]) === period; });
  const specs = [];
  selected.forEach(function(key) { legacyIndexPaths_(dataset, source[key]).forEach(function(path) { specs.push({ path:'/' + path, id:key, expected:legacyIndexSummary_(dataset, source[key]) }); }); });
  const indexed = fbReadBatch_(specs.map(function(spec) { return { path:spec.path }; }));
  const discrepancies = [];
  specs.forEach(function(spec,index) {
    if (mutationCanonical_(indexed[index]) !== mutationCanonical_(spec.expected)) discrepancies.push({ id:spec.id, reason:indexed[index] ? 'Indeks berbeda dari arsip' : 'Indeks belum tersedia', path:spec.path });
  });
  selected.forEach(function(key) { if (source[key].id !== key) discrepancies.push({ id:key, reason:'Identitas record berbeda dari kunci arsip' }); });
  return { readOnly:true, dataset:dataset, period:period, scanned:keys.length, matched:selected.length,
    totalAmount:selected.reduce(function(sum,key) { return sum + legacyIndexAmount_(dataset, source[key]); },0),
    photoReferences:selected.filter(function(key) { return Boolean(legacyPhotoKey_(source[key].fotoUrl)); }).length,
    discrepancies:discrepancies, nextCursor:allKeys.length === 250 && keys.length ? keys[keys.length - 1] : '', complete:allKeys.length < 250 };
}

function legacyBuildIdentityBatch_(session, payload) {
  mutationAssertIsolatedDev_();
  if (session.role !== 'ADMIN') throw new Error('Hanya ADMIN yang dapat membangun indeks.');
  return legacyBackfillIdentityBatch_(portalValidatePeriod_(payload.period), String(payload.cursor || ''));
}

function legacyValidateIdentityBatch_(session, payload) {
  const period = portalValidatePeriod_(payload.period);
  const cursor = String(payload.cursor || '');
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  if (payload.dataVersion && payload.dataVersion !== version) throw new Error('Data berubah selama validasi; ulangi validasi dari awal.');
  const params = { orderBy:'$key', limitToFirst:250 };
  if (cursor) params.startAt = cursor;
  const source = fbReadQuery_('/expenseIndexV1/byPeriodType/' + period + '/UMUM', params) || {};
  const keys = Object.keys(source).sort().filter(function(key) { return !cursor || key > cursor; });
  const records = fbReadBatch_(keys.map(function(key) { return { path:'/expenses/' + source[key].id }; }));
  const specs = records.map(function(record) { return { path:record ? '/expenseIdentityV2/' + period + '/' + mutationKey_(legacyExpenseIdentity_(record)) : '/expenseIdentityV2/missing' }; });
  const identities = fbReadBatch_(specs);
  const errors = [];
  keys.forEach(function(key,index) {
    const record = records[index];
    if (!record || mutationCanonical_(legacyIndexSummary_('expenses',record)) !== mutationCanonical_(source[key]) || !identities[index] || identities[index][record.id] !== true) errors.push({ id:source[key].id, reason:'Jumlah/nominal/identitas/foto atau indeks pasangan belum cocok' });
  });
  return { readOnly:true, period:period, dataVersion:version, scanned:keys.length, count:records.filter(Boolean).length,
    totalAmount:records.reduce(function(sum,record) { return sum + Number(record && record.nominal || 0); },0),
    fingerprint:legacyIdentityFingerprint_(records.filter(Boolean)),
    errors:errors, nextCursor:Object.keys(source).length === 250 && keys.length ? keys[keys.length - 1] : '', complete:Object.keys(source).length < 250 };
}

function legacyIdentityFingerprint_(records, initial) {
  const parts = (initial || Array(8).fill(0)).slice();
  records.forEach(function(record) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, mutationCanonical_(legacyIndexSummary_('expenses', record)));
    for (let i = 0; i < 8; i++) {
      const offset = i * 4;
      const word = ((digest[offset] & 255) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
      parts[i] = (parts[i] ^ word) >>> 0;
    }
  });
  return parts;
}

/** Persisted proof prevents a client from declaring a partial validation complete. */
function legacyRunIdentityValidationBatch_(session, payload) {
  mutationAssertIsolatedDev_();
  const period = portalValidatePeriod_(payload.period);
  const id = payload.validationId || mutationUuid_();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new Error('Identitas validasi tidak valid.');
  const path = '/identityValidationV2/' + id;
  const execution = mutationUuid_();
  const lease = mutationScopeAcquire_('validation/' + id, id, execution);
  try {
    let state = fbRead_(path);
    const version = String(fbRead_('/dataVersions/legacy') || 'v79');
    if (!state) state = { id:id, period:period, dataVersion:version, uid:session.uid, phase:'SOURCE', cursor:'', source:{count:0,totalAmount:0,fingerprint:Array(8).fill(0)}, index:{count:0,totalAmount:0,fingerprint:Array(8).fill(0)}, errors:[], errorCount:0 };
    state.errors = Array.isArray(state.errors) ? state.errors : [];
    if (state.period !== period || state.uid !== session.uid) throw new Error('Validasi tidak sesuai pengguna/periode.');
    if (state.dataVersion !== version) throw new Error('Data berubah. Mulai validasi baru.');
    if (state.phase === 'COMPLETE' || state.phase === 'FAILED') return state;
    if (state.phase === 'SOURCE') {
      const params = { orderBy:'$key', limitToFirst:250 }; if (state.cursor) params.startAt = state.cursor;
      const batch = fbReadQuery_('/expenses', params) || {};
      const keys = Object.keys(batch).sort().filter(function(key) { return !state.cursor || key > state.cursor; });
      const records = keys.map(function(key) { return batch[key]; }).filter(function(record) { return legacyIndexPeriod_('expenses',record) === period && legacyExpenseType_(record) === 'UMUM'; });
      state.source.count += records.length;
      state.source.totalAmount += records.reduce(function(sum,record) { return sum + Number(record.nominal || 0); },0);
      state.source.fingerprint = legacyIdentityFingerprint_(records, state.source.fingerprint);
      state.cursor = keys.length ? keys[keys.length - 1] : state.cursor;
      if (Object.keys(batch).length < 250) { state.phase = 'INDEX'; state.cursor = ''; }
    } else {
      const result = legacyValidateIdentityBatch_(session, { period:period, cursor:state.cursor, dataVersion:version });
      state.index.count += result.count; state.index.totalAmount += result.totalAmount;
      state.index.fingerprint = state.index.fingerprint.map(function(value,index) { return (value ^ result.fingerprint[index]) >>> 0; });
      state.errorCount += result.errors.length; state.errors = state.errors.concat(result.errors).slice(0,200);
      state.cursor = result.nextCursor;
      if (result.complete) {
        if (mutationCanonical_(state.source) !== mutationCanonical_(state.index)) { state.errorCount++; state.errors.push({ reason:'Jumlah, nominal, identitas atau referensi foto arsip dan indeks tidak cocok.' }); }
        state.phase = state.errorCount ? 'FAILED' : 'COMPLETE';
      }
    }
    if (version !== String(fbRead_('/dataVersions/legacy') || 'v79')) throw new Error('Data berubah. Mulai validasi baru.');
    fbWrite_(path, state);
    return state;
  } finally { mutationScopeRelease_(lease, id, execution); }
}

function legacyActivateIdentityIndex_(session, payload) {
  mutationAssertIsolatedDev_();
  const proof = fbRead_('/identityValidationV2/' + String(payload.validationId || ''));
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  if (!proof || proof.phase !== 'COMPLETE' || proof.errorCount || proof.dataVersion !== version) throw new Error('Validasi lengkap terbaru belum lulus. Indeks belum diaktifkan.');
  const metaPath = '/expenseIdentityV2Meta/' + proof.period;
  const meta = fbRead_(metaPath);
  if (!meta || !meta.built) throw new Error('Pembangunan indeks belum selesai.');
  fbWrite_(metaPath, Object.assign({}, meta, { validated:true, validationId:proof.id, validatedAt:Date.now(), count:proof.source.count, totalAmount:proof.source.totalAmount }));
  return { success:true, period:proof.period, validated:true };
}
