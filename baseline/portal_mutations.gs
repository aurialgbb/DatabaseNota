/** Durable, scoped Firebase commits. Journals contain final values, never credentials or images. */
// PATCH paths are legal only at the update boundary, not as nested PUT keys.
// Preserve path maps losslessly as JSON values; ordinary journal fields stay
// addressable so status/progress/photo checkpoints and old jobs still work.
function mutationJournalEncode_(value) {
  if (value === undefined || value === null) return { __journalJsonV2:'null' };
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return { __journalJsonV2:JSON.stringify(value) };
  const keys = Object.keys(value);
  if (!keys.length || keys.some(function(key) { return !key || /[.$#\[\]\/\x00-\x1f\x7f]/.test(key) || key === '__journalMapJsonV1' || key === '__journalJsonV2'; })) {
    return { __journalJsonV2:JSON.stringify(value) };
  }
  const result = {};
  Object.keys(value).forEach(function(key) { result[key] = mutationJournalEncode_(value[key]); });
  return result;
}

function mutationJournalDecode_(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(mutationJournalDecode_); // Legacy journal compatibility.
  if (Object.keys(value).length === 1 && typeof value.__journalJsonV2 === 'string') return JSON.parse(value.__journalJsonV2);
  if (Object.keys(value).length === 1 && typeof value.__journalMapJsonV1 === 'string') return JSON.parse(value.__journalMapJsonV1);
  const result = {};
  Object.keys(value).forEach(function(key) { result[key] = mutationJournalDecode_(value[key]); });
  return result;
}

function mutationJournalPath_(path) {
  return /^\/(mutationIntents|mutationPlans|tarikJobsV2|legacyMutationJobs)(\/|$)/.test(path);
}

function mutationJournalWrite_(path, value) {
  return fbWrite_(path, mutationJournalPath_(path) ? mutationJournalEncode_(value) : value);
}

function mutationJournalRead_(path) {
  const value = fbRead_(path);
  return mutationJournalPath_(path) ? mutationJournalDecode_(value) : value;
}

function mutationJournalUpdate_(path, values) {
  if (!mutationJournalPath_(path)) return fbUpdateRaw_(path, values);
  const encoded = {};
  Object.keys(values || {}).forEach(function(key) { encoded[key] = mutationJournalEncode_(values[key]); });
  return fbUpdateRaw_(path, encoded);
}

function mutationCanonical_(value) {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(mutationCanonical_).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + mutationCanonical_(value[key]);
  }).join(',') + '}';
  return JSON.stringify(value);
}

function mutationKey_(value) { return portalHash_(String(value)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48); }

function mutationUuid_() { return Utilities.getUuid(); }

function mutationAttachExpected_(updates, path, before) {
  if (!updates.__expectedRecords) Object.defineProperty(updates, '__expectedRecords', { value:{}, enumerable:false });
  if (!Object.prototype.hasOwnProperty.call(updates.__expectedRecords, path)) updates.__expectedRecords[path] = before || null;
}

function mutationScopeAcquire_(scope, operationId, executionId, allowSameOperationTakeover) {
  const path = '/mutationScopes/' + mutationKey_(scope);
  const current = mutationJournalRead_(path);
  if (current && current.operationId !== operationId) {
    // A lost acknowledgement must never release protection before the commit is known.
    const committed = mutationJournalRead_('/mutationCommits/' + current.operationId) || mutationJournalRead_('/mutationCommits/' + current.operationId + '-data');
    if (committed) fbCompareAndSet_(path, function(value) {
      return value && value.operationId === current.operationId ? { value:null } : { abort:true };
    });
    else if (/^TARIK-/.test(String(current.operationId || ''))) {
      const cancelled = mutationJournalRead_('/tarikJobsV2/' + current.operationId + '/status') === 'CANCELLED';
      if (cancelled) fbCompareAndSet_(path, function(value) {
        return value && value.operationId === current.operationId ? { value:null } : { abort:true };
      });
    }
  }
  const acquired = fbCompareAndSet_(path, function(value) {
    if (value && (value.operationId !== operationId || (!allowSameOperationTakeover && value.executionId !== executionId && value.until > Date.now()))) {
      return { abort:true, reason:'Data sedang diproses atau perlu dilanjutkan. Operasi: ' + value.operationId };
    }
    return { value:{ operationId:operationId, executionId:executionId, until:Date.now() + 480000, scope:scope } };
  });
  if (!acquired.success) throw new Error(acquired.reason || 'Data sedang diproses pengguna lain.');
  return path;
}

function mutationScopeRelease_(path, operationId, executionId) {
  try {
    fbCompareAndSet_(path, function(value) {
      return value && value.operationId === operationId && value.executionId === executionId ? { value:null } : { abort:true };
    });
  } catch (error) { /* A committed marker permits the next writer to clean up. */ }
}

function mutationRecordScopes_(scopes, operationId, executionId, release, uncertain) {
  if (!scopes.length) return;
  const registryPath = '/mutationRecordLeasesV2';
  const keys = scopes.map(mutationKey_);
  const snapshot = release ? {} : mutationJournalRead_(registryPath) || {};
  const otherOwners = Array.from(new Set(keys.map(function(key) { return snapshot[key] && snapshot[key].operationId; }).filter(function(id) { return id && id !== operationId; })));
  const markers = otherOwners.length ? fbReadBatch_(otherOwners.map(function(id) { return { path:'/mutationCommits/' + id }; })) : [];
  const completed = {};
  otherOwners.forEach(function(id,index) { if (markers[index]) completed[id] = true; });
  const result = fbCompareAndSet_(registryPath, function(current) {
    const next = current || {};
    for (let index = 0; index < keys.length; index++) {
      const owner = next[keys[index]];
      if (release) {
        if (owner && owner.operationId === operationId && owner.executionId === executionId) {
          if (uncertain) owner.until = 0;
          else delete next[keys[index]];
        }
      } else {
        if (owner && !completed[owner.operationId] && (owner.operationId !== operationId || (owner.executionId !== executionId && owner.until > Date.now()))) return { abort:true, reason:'Data sedang diproses atau perlu dilanjutkan: ' + owner.operationId };
        next[keys[index]] = { operationId:operationId, executionId:executionId, until:Date.now() + 480000 };
      }
    }
    return { value:next };
  });
  if (!result.success && !release) throw new Error(result.reason || 'Data sedang diproses pengguna lain.');
}

function mutationCommit_(primary, specification) {
  let spec = specification || {};
  const operationId = spec.operationId || mutationUuid_();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) throw new Error('Identitas operasi tidak valid.');
  const journalPath = '/mutationPlans/' + operationId;
  const completed = mutationJournalRead_('/mutationCommits/' + operationId);
  if (completed) return { operationId:operationId, status:'COMPLETED' };
  let journal = mutationJournalRead_(journalPath);
  // The intent precedes lock acquisition, so even a lost CAS response has a recoverable owner.
  let intent = mutationJournalRead_('/mutationIntents/' + operationId);
  if (!intent && !journal) {
    intent = { operationId:operationId, uid:typeof MUTATION_SESSION_ !== 'undefined' && MUTATION_SESSION_ ? MUTATION_SESSION_.uid : '',
      primary:primary, specification:Object.assign({}, spec, { expected:spec.expected || primary.__expectedRecords || {} }), createdAt:Date.now() };
    mutationJournalWrite_('/mutationIntents/' + operationId, intent);
  }
  if (intent) { primary = intent.primary; spec = intent.specification; }
  const expected = spec.expected || primary.__expectedRecords || {};
  const deltas = spec.aggregateDeltas || {};
  const photoChanges = spec.photoChanges || {};
  const increments = {};
  Object.keys(primary).forEach(function(path) {
    const value = primary[path];
    if (value && value['.sv'] && typeof value['.sv'].increment === 'number') increments[path] = value['.sv'].increment;
  });
  const scopes = journal ? journal.scopes : Array.from(new Set(
    Object.keys(expected).concat(Object.keys(deltas), Object.keys(increments), Object.keys(photoChanges).map(function(key) {
      return 'photoReferenceIndexV1/' + key;
    }))
  )).sort();
  const executionId = mutationUuid_();
  let acquired = false;
  let mayHaveCommitted = false;
  try {
    try { mutationRecordScopes_(scopes, operationId, executionId, false, false); }
    catch (error) {
      // Release only this execution's lease; other owners are never changed.
      try { mutationRecordScopes_(scopes, operationId, executionId, true, true); } catch (ignored) {}
      throw new Error(error.message + ' Perlu dilanjutkan. Operasi Firebase: ' + operationId);
    }
    acquired = true;
    if (!journal) {
      const paths = Array.from(new Set(Object.keys(expected).concat(Object.keys(deltas), Object.keys(increments), Object.keys(photoChanges).map(function(key) {
        return 'photoReferenceIndexV1/' + key;
      }))));
      const snapshots = paths.length ? fbReadBatch_(paths.map(function(path) { return { path:'/' + path }; })) : [];
      const expectedPaths = Object.keys(expected);
      const workGuards = expectedPaths.length ? fbReadBatch_(expectedPaths.map(function(path) { return { path:'/mutationWork/' + mutationKey_(path) }; })) : [];
      const current = {};
      paths.forEach(function(path, index) { current[path] = snapshots[index] || null; });
      expectedPaths.forEach(function(path,index) {
        const work = workGuards[index];
        if (work && operationId !== work.operationId && operationId.indexOf(work.operationId + '-') !== 0) throw new Error('Data memiliki pekerjaan yang perlu dilanjutkan: ' + work.operationId);
        if (mutationCanonical_(current[path]) !== mutationCanonical_(expected[path])) throw new Error('Konflik perubahan pada ' + path + '. Muat ulang data.');
      });
      const updates = Object.assign({}, primary);
      Object.keys(increments).forEach(function(path) { updates[path] = Number(current[path] || 0) + increments[path]; });
      Object.keys(deltas).forEach(function(path) {
        const previous = current[path] || {};
        const count = Number(previous.count || 0) + deltas[path].count;
        if (count < 0) throw new Error('Ringkasan tidak sesuai pada ' + path + '. Perlu pemeriksaan data.');
        updates[path] = { count:count, totalAmount:Number(previous.totalAmount || 0) + deltas[path].totalAmount, version:1, updatedAt:Date.now() };
      });
      Object.keys(photoChanges).forEach(function(key) {
        const path = 'photoReferenceIndexV1/' + key;
        const refs = Object.assign({}, (current[path] || {}).refs || {});
        Object.keys(photoChanges[key].refs).forEach(function(id) {
          if (photoChanges[key].refs[id]) refs[id] = true;
          else delete refs[id];
        });
        updates[path] = Object.keys(refs).length ? {
          url:photoChanges[key].url, refs:refs, referenceCount:Object.keys(refs).length, version:1, updatedAt:Date.now()
        } : null;
      });
      // The exact values and marker are replayed together, including after a timeout.
      updates['mutationCommits/' + operationId] = { status:'COMPLETED', committedAt:Date.now() };
      updates['dataVersions/legacy'] = mutationUuid_();
      journal = { operationId:operationId, uid:typeof MUTATION_SESSION_ !== 'undefined' && MUTATION_SESSION_ ? MUTATION_SESSION_.uid : '', scopes:scopes, updates:updates, createdAt:Date.now() };
      mayHaveCommitted = true;
      mutationJournalWrite_(journalPath, journal);
    }
    mayHaveCommitted = true;
    try { fbUpdateRaw_('/', journal.updates); }
    catch (error) {
      if (!mutationJournalRead_('/mutationCommits/' + operationId)) throw error;
    }
    mayHaveCommitted = false;
    return { operationId:operationId, status:'COMPLETED' };
  } catch (error) {
    if (mayHaveCommitted) throw new Error('Perlu dilanjutkan. Operasi Firebase: ' + operationId);
    throw error;
  } finally {
    if (acquired) try { mutationRecordScopes_(scopes, operationId, executionId, true, mayHaveCommitted); } catch (ignored) {}
  }
}

function mutationResumeCommit_(operationId) {
  const plan = mutationJournalRead_('/mutationPlans/' + operationId);
  if (!plan) {
    const intent = mutationJournalRead_('/mutationIntents/' + operationId);
    if (!intent) throw new Error('Rencana operasi tidak ditemukan.');
    return mutationCommit_(intent.primary, Object.assign({}, intent.specification, { operationId:operationId }));
  }
  return mutationCommit_(plan.updates, { operationId:operationId });
}

function mutationJobStatus_(session, payload) {
  const id = String(payload.operationId || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('Identitas operasi tidak valid.');
  if (id.indexOf('TARIK-') === 0) throw new Error('Gunakan pemeriksaan pekerjaan Tarik Data agar spreadsheet ikut dipulihkan.');
  const journal = mutationJournalRead_('/mutationPlans/' + id) || mutationJournalRead_('/mutationIntents/' + id);
  if (!journal || (journal.uid !== session.uid && session.role !== 'ADMIN')) throw new Error('Pekerjaan tidak ditemukan atau akses tidak diizinkan.');
  return { operationId:id, status:mutationJournalRead_('/mutationCommits/' + id) ? 'COMPLETED' : 'RECOVERY_REQUIRED' };
}

function mutationJobResume_(session, payload) {
  const status = mutationJobStatus_(session, payload);
  if (status.status !== 'COMPLETED') mutationResumeCommit_(status.operationId);
  invalidateDataCache_();
  return { success:true, operationId:status.operationId, status:'COMPLETED' };
}

function mutationSpreadsheetId_(url) {
  const match = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(String(url || ''))) return String(url);
  throw new Error('Identitas spreadsheet tidak valid.');
}

function mutationAssertSpreadsheetWritable_(fileId) {
  const response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,capabilities(canEdit)&supportsAllDrives=true', {
    method:'get', headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 200) throw new Error('Akses spreadsheet tujuan tidak dapat diverifikasi. Tidak ada transaksi diubah.');
  const file = JSON.parse(response.getContentText());
  if (!file.capabilities || file.capabilities.canEdit !== true) throw new Error('Spreadsheet tujuan hanya dapat dibaca; akses edit diperlukan.');
}

function mutationAssertIsolatedDev_() {
  const props = PropertiesService.getScriptProperties();
  if (ScriptApp.getScriptId() !== '1PcXAIEOyafbEVwL_ZfwNmzLERr7cG1ge0Agi54LgvMGjTi9XV25z-MFn' ||
      String(props.getProperty('FIREBASE_DB_URL') || '').replace(/\/$/, '') !== 'https://aadatabase-10d77-dev-rtdb.asia-southeast1.firebasedatabase.app' ||
      props.getProperty('FOLDER_PARENT_ID') !== '147v-ezpEondvYNh0qbrZFN_p6EUgb9sI') throw new Error('Pemeliharaan ini hanya tersedia di DEV terisolasi. Data produksi memerlukan peninjauan dan rilis terpisah.');
}

function mutationAssertRuntimeTarget_() {
  if (typeof ScriptApp !== 'undefined' && typeof ScriptApp.getScriptId === 'function' && ScriptApp.getScriptId() === '1PcXAIEOyafbEVwL_ZfwNmzLERr7cG1ge0Agi54LgvMGjTi9XV25z-MFn') mutationAssertIsolatedDev_();
}

var LEGACY_MUTATION_CONTEXT_ = null;

function legacyMutationResult_(context, changes) {
  const records = changes.filter(function(change) { return change.after; }).map(function(change) { return change.after; });
  if (context.action === 'saveTransactions') return records.map(ocrObjectToArray_);
  if (context.action === 'saveListrikTransaction') return expenseObjectToArray_(records[0]);
  if (context.action === 'duplicateToKategori') return context.args[1];
  if (context.action === 'bulkDeleteListrikTransaction') return changes.length;
  if (context.action === 'updateListrikTransaction') {
    const record = records[0];
    return { id:record.id, tanggal:record.tanggal, toko:record.cabang, cv:record.cv, nominal:record.nominal, url:record.fotoUrl, kategori:record.kategori, keterangan:record.keterangan };
  }
  return true;
}

function legacyRunMutation_(session, action, args, meta, fn) {
  const requestId = String(meta && meta.clientRequestId || '');
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new Error('Muat ulang aplikasi sebelum menyimpan.');
  const id = 'LEGACY-' + mutationKey_(session.uid + '|' + requestId);
  const path = '/legacyMutationJobs/' + id;
  const hash = mutationKey_(mutationCanonical_({ action:action, args:args }));
  const executionId = mutationUuid_();
  const lease = mutationScopeAcquire_('request/' + id, id, executionId);
  try {
    let job = mutationJournalRead_(path);
    if (job && job.payloadHash !== hash) throw new Error('Identitas permintaan sama digunakan untuk data berbeda.');
    if (job && job.status === 'COMPLETED') return job.result;
    if (!job) {
      job = { uid:session.uid, action:action, payloadHash:hash, requestId:requestId, createdAt:Date.now(), status:'PREPARING' };
      mutationJournalWrite_(path, job);
    }
    if (mutationJournalRead_('/mutationPlans/' + id + '-data') || mutationJournalRead_('/mutationIntents/' + id + '-data')) {
      mutationResumeCommit_(id + '-data');
      invalidateDataCache_();
      return (mutationJournalRead_(path) || {}).result;
    }
    LEGACY_MUTATION_CONTEXT_ = { id:id, path:path, action:action, args:args };
    try {
      const result = fn.apply(null, args);
      // No-op mutations may have no data commit.
      if (!mutationJournalRead_('/mutationCommits/' + id + '-data')) mutationJournalUpdate_(path, { status:'COMPLETED', result:result });
      return result;
    } catch (error) {
      job = mutationJournalRead_(path);
      if (job && job.status === 'COMPLETED') return job.result;
      throw error;
    }
  } finally {
    LEGACY_MUTATION_CONTEXT_ = null;
    mutationScopeRelease_(lease, id, executionId);
  }
}
