/**
 * KONFIGURASI NAMA SHEET & FOLDER
 */
const SHEET_HISTORY = "Hasil OCR"; 
const SHEET_CABANG = "Master Data"; 
const FOLDER_NAME = "Nota_Analyzer_Images"; 
const SHEET_LISTRIK = "Listrik";
const FOLDER_LISTRIK = "Nota_Listrik_Images";
const PORTAL_BUILD_ID = '2026.09.05-head-row-metadata-r39';

/**
 * ==========================================
 * MODUL FIREBASE HELPER (REST API)
 * ==========================================
 */
function getFirebaseUrl_(path) {
  const props = PropertiesService.getScriptProperties();
  // Nilai hasil paste dapat membawa spasi atau newline tersembunyi.
  const dbUrl = String(props.getProperty('FIREBASE_DB_URL') || '').trim();
  mutationAssertRuntimeTarget_();
  const secret = String(props.getProperty('FIREBASE_SECRET') || '').trim();
  const bearerEnabled = fbUsesBearerAuth_();
  if (!dbUrl) throw new Error("FIREBASE_DB_URL belum disetting di Script Properties.");
  if (!bearerEnabled && !secret) throw new Error("FIREBASE_SECRET belum disetting di Script Properties.");
  
  // Bersihkan path dari double slash
  let cleanPath = String(path || '');
  if (cleanPath.startsWith('/')) cleanPath = cleanPath.substring(1);
  if (cleanPath.endsWith('/')) cleanPath = cleanPath.slice(0, -1);
  
  const base = dbUrl.endsWith('/') ? dbUrl : (dbUrl + '/');
  const formattedUrl = base + (cleanPath ? cleanPath : "") + ".json" + (bearerEnabled ? '' : ('?auth=' + encodeURIComponent(secret)));
  return formattedUrl;
}

function fbAuthMode_() {
  return String(PropertiesService.getScriptProperties().getProperty('FIREBASE_AUTH_MODE') || '').trim().toUpperCase();
}

function fbUsesBearerAuth_() {
  return ['OAUTH', 'SERVICE_ACCOUNT'].indexOf(fbAuthMode_()) !== -1;
}

function fbHeaders_(extra) {
  const headers = {};
  Object.keys(extra || {}).forEach(function(key) { headers[key] = extra[key]; });
  const mode = fbAuthMode_();
  if (mode === 'OAUTH') headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  if (mode === 'SERVICE_ACCOUNT') headers.Authorization = 'Bearer ' + fbServiceAccountAccessToken_();
  return headers;
}

function fbBase64Url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, '');
}

function fbServiceAccountAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('firebase-service-account-token-v1');
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties();
  const email = String(props.getProperty('FIREBASE_SERVICE_ACCOUNT_EMAIL') || '').trim();
  const privateKey = String(props.getProperty('FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY') || '').replace(/\\n/g, '\n').trim();
  if (!email || !privateKey) throw new Error('Service account Firebase DEV belum lengkap.');

  const now = Math.floor(Date.now() / 1000);
  const unsignedJwt = fbBase64Url_(JSON.stringify({ alg:'RS256', typ:'JWT' })) + '.' + fbBase64Url_(JSON.stringify({
    iss:email,
    scope:'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud:'https://oauth2.googleapis.com/token',
    iat:now,
    exp:now + 3600
  }));
  const assertion = unsignedJwt + '.' + Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsignedJwt, privateKey)
  ).replace(/=+$/, '');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method:'post',
    payload:{
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:assertion
    },
    muteHttpExceptions:true
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status !== 200) throw new Error('Autentikasi service account Firebase gagal (' + status + ').');
  const token = JSON.parse(text).access_token;
  if (!token) throw new Error('Access token Firebase tidak tersedia.');
  cache.put('firebase-service-account-token-v1', token, 3300);
  return token;
}

function fbAppendQuery_(url, key, value) {
  const separator = String(url).indexOf('?') === -1 ? '?' : '&';
  return String(url) + separator + encodeURIComponent(key) + '=' + encodeURIComponent(value);
}

/**
 * Retry singkat untuk kegagalan transport UrlFetch (DNS/socket/timeout) dan
 * respons sementara pada operasi baca. Write tidak diulang berdasarkan status
 * HTTP karena payload increment tidak selalu aman dikirim dua kali.
 * Detail exception tidak diteruskan karena dapat memuat URL bercredential.
 */
function firebaseFetchWithRetry_(url, options, operation) {
  const maxAttempts = 3;
  const normalizedOperation = String(operation || 'REQUEST').toUpperCase();
  const retryHttpResponse = /^(GET|QUERY|BATCH_GET|ETAG_READ)$/.test(normalizedOperation);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      if (retryHttpResponse && (code === 429 || code >= 500) && attempt < maxAttempts) {
        console.warn('Firebase read sementara gagal: operation=' + normalizedOperation + ', status=' + code + ', attempt=' + attempt);
        Utilities.sleep(attempt * 500);
        continue;
      }
      return response;
    } catch (error) {
      console.warn('Firebase transport gagal: operation=' + String(operation || 'REQUEST') + ', attempt=' + attempt);
      if (!retryHttpResponse || attempt >= maxAttempts) {
        throw new Error('Koneksi ke Firebase sementara gagal. Silakan coba lagi.');
      }
      Utilities.sleep(attempt * 400);
    }
  }
  throw new Error('Koneksi ke Firebase sementara gagal. Silakan coba lagi.');
}

function fbRead_(path) {
  const url = getFirebaseUrl_(path);
  const startedAt = Date.now();
  const options = {
    method: 'get',
    headers: fbHeaders_(),
    muteHttpExceptions: true
  };
  const response = firebaseFetchWithRetry_(url, options, 'GET');
  const code = response.getResponseCode();
  const text = response.getContentText();
  fbLogDiagnostic_('GET', path, code, text, startedAt);
  if (code !== 200) throw new Error("Firebase Read Error (" + code + "): " + text);
  return JSON.parse(text);
}

function fbWrite_(path, data) {
  const url = fbAppendQuery_(getFirebaseUrl_(path), 'print', 'silent');
  const startedAt = Date.now();
  const options = {
    method: 'put',
    contentType: 'application/json',
    headers: fbHeaders_(),
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  };
  const response = firebaseFetchWithRetry_(url, options, 'PUT');
  const code = response.getResponseCode();
  const text = response.getContentText();
  fbLogDiagnostic_('PUT', path, code, text, startedAt);
  if (code !== 200 && code !== 204) throw new Error("Firebase Write Error (" + code + "): " + text);
  return text ? JSON.parse(text) : null;
}

function fbUpdate_(path, data) {
  const needsCommit = path === '/' && (data.__expectedRecords || Object.keys(data || {}).some(function(key) {
    return data[key] && data[key]['.sv'];
  }));
  if (needsCommit) return mutationCommit_(data);
  return fbUpdateRaw_(path, data);
}

function fbUpdateRaw_(path, data) {
  const url = fbAppendQuery_(getFirebaseUrl_(path), 'print', 'silent');
  const startedAt = Date.now();
  const options = {
    method: 'patch',
    contentType: 'application/json',
    headers: fbHeaders_(),
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  };
  const response = firebaseFetchWithRetry_(url, options, 'PATCH');
  const code = response.getResponseCode();
  const text = response.getContentText();
  fbLogDiagnostic_('PATCH', path, code, text, startedAt);
  if (code !== 200 && code !== 204) throw new Error("Firebase Update Error (" + code + "): " + text);
  return text ? JSON.parse(text) : null;
}

function fbDelete_(path) {
  const url = getFirebaseUrl_(path);
  const startedAt = Date.now();
  const options = {
    method: 'delete',
    headers: fbHeaders_(),
    muteHttpExceptions: true
  };
  const response = firebaseFetchWithRetry_(url, options, 'DELETE');
  const code = response.getResponseCode();
  const text = response.getContentText();
  fbLogDiagnostic_('DELETE', path, code, text, startedAt);
  if (code !== 200) throw new Error("Firebase Delete Error (" + code + "): " + text);
  return text ? JSON.parse(text) : null;
}

/**
 * Diagnostik opt-in. Hanya metadata request yang dicatat; URL auth, payload,
 * dan isi response tidak pernah masuk log.
 */
function fbLogDiagnostic_(method, path, code, responseText, startedAt) {
  try {
    const enabled = String(PropertiesService.getScriptProperties().getProperty('PORTAL_FIREBASE_DIAGNOSTICS_ENABLED') || '').toUpperCase() === 'TRUE';
    if (!enabled) return;
    console.log(JSON.stringify({
      type:'FIREBASE_IO',
      method:String(method || ''),
      path:String(path || '/').replace(/[^A-Za-z0-9_\-\/]/g, '_').slice(0, 240),
      status:Number(code || 0),
      responseBytes:Utilities.newBlob(String(responseText || '')).getBytes().length,
      durationMs:Math.max(0, Date.now() - Number(startedAt || Date.now()))
    }));
  } catch (error) {}
}

/**
 * Membaca nilai beserta ETag Firebase. ETag dipakai sebagai compare-and-set
 * sehingga claim nota/worker tidak bergantung pada ScriptLock global.
 */
function fbReadWithEtag_(path) {
  const response = firebaseFetchWithRetry_(getFirebaseUrl_(path), {
    method: 'get',
    headers: fbHeaders_({ 'X-Firebase-ETag': 'true' }),
    muteHttpExceptions: true
  }, 'ETAG_READ');
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) throw new Error('Firebase ETag Read Error (' + code + '): ' + text);
  return {
    data: JSON.parse(text),
    etag: String(response.getHeaders().ETag || response.getHeaders().Etag || '')
  };
}

function fbPutIfMatch_(path, data, etag) {
  const response = UrlFetchApp.fetch(getFirebaseUrl_(path), {
    method: 'put',
    contentType: 'application/json',
    headers: fbHeaders_({ 'if-match': String(etag || 'null_etag') }),
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code === 412) return { success:false, conflict:true, data:text ? JSON.parse(text) : null };
  if (code !== 200) throw new Error('Firebase CAS Write Error (' + code + '): ' + text);
  return {
    success:true,
    conflict:false,
    data:text ? JSON.parse(text) : null,
    etag:String(response.getHeaders().ETag || response.getHeaders().Etag || '')
  };
}

function fbCompareAndSet_(path, mutator, maxAttempts) {
  const attempts = Math.max(1, Number(maxAttempts || 4));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = fbReadWithEtag_(path);
    const next = mutator(snapshot.data, attempt);
    if (next && next.abort) return { success:false, aborted:true, reason:next.reason || '', current:snapshot.data };
    const result = fbPutIfMatch_(path, next && Object.prototype.hasOwnProperty.call(next, 'value') ? next.value : next, snapshot.etag);
    if (result.success) return { success:true, data:result.data };
  }
  return { success:false, conflict:true };
}

function fbReadQuery_(path, params) {
  const url = fbBuildQueryUrl_(path, params);
  const startedAt = Date.now();
  const response = firebaseFetchWithRetry_(url, { method:'get', headers:fbHeaders_(), muteHttpExceptions:true }, 'QUERY');
  const code = response.getResponseCode();
  const text = response.getContentText();
  fbLogDiagnostic_('QUERY', path, code, text, startedAt);
  if (code === 429 || code >= 500) throw new Error('Layanan data sementara tidak tersedia (' + code + '). Silakan coba lagi.');
  if (code !== 200) throw new Error('Firebase Query Error (' + code + '): ' + text);
  return JSON.parse(text);
}

function fbBuildQueryUrl_(path, params) {
  let url = getFirebaseUrl_(path);
  Object.keys(params || {}).forEach(function(key) {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    url = fbAppendQuery_(url, key, JSON.stringify(value));
  });
  return url;
}

function fbReadBatch_(specs) {
  const requests = Array.isArray(specs) ? specs : [];
  if (!requests.length) return [];
  const startedAt = Date.now();
  const headers = fbHeaders_();
  const requestOptions = requests.map(function(spec) {
    return {
      url:fbBuildQueryUrl_(spec.path, spec.params || {}),
      method:'get',
      headers:headers,
      muteHttpExceptions:true
    };
  });
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requestOptions);
  } catch (error) {
    responses = requestOptions.map(function(options) {
      return firebaseFetchWithRetry_(options.url, options, 'BATCH_GET');
    });
  }
  return responses.map(function(initialResponse, index) {
    let response = initialResponse;
    let code = response.getResponseCode();
    if (code === 429 || code >= 500) {
      response = firebaseFetchWithRetry_(requestOptions[index].url, requestOptions[index], 'BATCH_GET');
      code = response.getResponseCode();
    }
    const text = response.getContentText();
    const spec = requests[index];
    fbLogDiagnostic_('BATCH_GET', spec.path, code, text, startedAt);
    if (code === 429 || code >= 500) throw new Error('Layanan data sementara tidak tersedia (' + code + '). Silakan coba lagi.');
    if (code !== 200) throw new Error('Firebase Batch Read Error (' + code + '): ' + text);
    return JSON.parse(text);
  });
}

function ocrObjectToArray_(obj) {
  if (!obj) return [];
  return [
    obj.id || "",
    obj.timestamp || 0,
    obj.tanggalNota || 0,
    obj.cabang || "",
    obj.cv || "",
    obj.supplier || "",
    obj.name || "",
    obj.qty || 0,
    obj.total || 0,
    obj.fotoUrl || "",
    obj.unit || "",
    obj.statusPosting || ""
  ];
}

function expenseObjectToArray_(obj) {
  if (!obj) return [];
  return [
    obj.id || "",
    obj.timestamp || 0,
    obj.tanggal || 0,
    obj.cabang || "",
    obj.cv || "",
    obj.nominal || 0,
    obj.fotoUrl || "",
    obj.kategori || "",
    obj.keterangan || "",
    obj.noUrut || "",
    obj.jenis || "",
    obj.jumlah || ""
  ];
}

const LEGACY_INDEX_VERSION_ = 1;
const LEGACY_INDEX_READ_FLAG_ = 'PORTAL_LEGACY_INDEX_READS_ENABLED';
const LEGACY_INDEX_SHADOW_FLAG_ = 'PORTAL_LEGACY_INDEX_SHADOW_READ_ENABLED';
const LEGACY_INDEX_MARKER_CACHE_TTL_ = 300;

function legacyIndexDataset_(dataset) {
  const normalized = String(dataset || '').toLowerCase();
  if (normalized !== 'expenses' && normalized !== 'ocr_history') throw new Error('Dataset indeks legacy tidak valid.');
  return normalized;
}

function legacyIndexSegment_(value) {
  const normalized = String(value == null ? '' : value).trim().toUpperCase() || '_NONE';
  return normalized.replace(/[.#$\[\]\/]/g, '_').slice(0, 160);
}

function legacyIndexPeriod_(dataset, item) {
  const millis = Number(dataset === 'expenses' ? item && item.tanggal : item && item.tanggalNota) || 0;
  if (!millis) return '000000';
  return Utilities.formatDate(new Date(millis), Session.getScriptTimeZone(), 'yyyyMM');
}

function legacyIndexSortKey_(dataset, item) {
  const millis = Number(dataset === 'expenses' ? item && item.tanggal : item && item.timestamp) || 0;
  return String(Math.max(0, millis)).padStart(13, '0') + '!' + legacyIndexSegment_(item && item.id || 'UNKNOWN');
}

function legacyExpenseType_(item) {
  return String(item && item.kategori || '').trim().toUpperCase() === 'UMUM' ? 'UMUM' : 'LISTRIK';
}

function legacyIndexSummary_(dataset, item) {
  return {
    id:String(item && item.id || ''),
    row:dataset === 'expenses' ? expenseObjectToArray_(item) : ocrObjectToArray_(item)
  };
}

function legacyIndexPaths_(dataset, item) {
  if (!item || !item.id) return [];
  const period = legacyIndexPeriod_(dataset, item);
  const sortKey = legacyIndexSortKey_(dataset, item);
  if (dataset === 'expenses') {
    const type = legacyExpenseType_(item);
    return ['expenseIndexV1/byPeriodType/' + period + '/' + type + '/' + sortKey];
  }
  const branch = legacyIndexSegment_(item.cabang);
  return [
    'ocrIndexV1/byPeriodBranch/' + period + '/' + branch + '/' + sortKey,
    'ocrIndexV1/byPeriodBranch/' + period + '/_ALL/' + sortKey
  ];
}

function legacyAggregatePaths_(dataset, item) {
  if (!item || !item.id) return [];
  const period = legacyIndexPeriod_(dataset, item);
  if (dataset === 'expenses') return ['legacyAggregatesV1/expenses/' + period + '/' + legacyExpenseType_(item)];
  const branch = legacyIndexSegment_(item.cabang);
  return [
    'legacyAggregatesV1/ocr_history/' + period + '/' + branch,
    'legacyAggregatesV1/ocr_history/' + period + '/_ALL'
  ];
}

function legacyIndexAmount_(dataset, item) {
  return Number(dataset === 'expenses' ? item && item.nominal : item && item.total) || 0;
}

function legacyPhotoKey_(url) {
  const value = String(url || '').trim();
  if (!value || value === '-') return '';
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}

function legacyNestedValue_(root, path) {
  return String(path || '').split('/').filter(Boolean).reduce(function(value, part) {
    return value && Object.prototype.hasOwnProperty.call(value, part) ? value[part] : null;
  }, root || null);
}

function legacyPhotoRefId_(dataset, item) {
  return legacyIndexSegment_(dataset + '_' + String(item && item.id || ''));
}

function legacyReadPhotoReferencesBatch_(photoKeys) {
  const keys = Array.isArray(photoKeys) ? photoKeys.filter(Boolean) : [];
  const snapshots = {};
  const chunkSize = 50;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const chunk = keys.slice(offset, offset + chunkSize);
    const values = fbReadBatch_(chunk.map(function(photoKey) {
      return { path:'/photoReferenceIndexV1/' + photoKey };
    }));
    chunk.forEach(function(photoKey, index) {
      snapshots[photoKey] = values[index] || {};
    });
  }
  return snapshots;
}

/**
 * Menyatukan mutasi node utama, summary index, aggregate, dan referensi foto
 * dalam satu root PATCH Firebase. Pembacaan kecil di awal hanya dipakai untuk
 * menghitung aggregate/referenceCount yang baru; tidak ada full-read data utama.
 */
function legacyApplyAtomicMutation_(primaryUpdates, mutations, options) {
  const updates = Object.assign({}, primaryUpdates || {});
  const changes = Array.isArray(mutations) ? mutations : [];
  const appendOnlyPhotoRefs = Boolean(options && options.appendOnlyPhotoRefs);
  const aggregateDeltas = {};
  const photoChanges = {};

  changes.forEach(function(change) {
    const dataset = legacyIndexDataset_(change.dataset);
    const before = change.before || null;
    const after = change.after || null;
    legacyIndexPaths_(dataset, before).forEach(function(path) { updates[path] = null; });
    legacyIndexPaths_(dataset, after).forEach(function(path) { updates[path] = legacyIndexSummary_(dataset, after); });

    legacyAggregatePaths_(dataset, before).forEach(function(path) {
      const delta = aggregateDeltas[path] || { count:0, totalAmount:0 };
      delta.count -= 1;
      delta.totalAmount -= legacyIndexAmount_(dataset, before);
      aggregateDeltas[path] = delta;
    });
    legacyAggregatePaths_(dataset, after).forEach(function(path) {
      const delta = aggregateDeltas[path] || { count:0, totalAmount:0 };
      delta.count += 1;
      delta.totalAmount += legacyIndexAmount_(dataset, after);
      aggregateDeltas[path] = delta;
    });

    [
      { item:before, present:false },
      { item:after, present:true }
    ].forEach(function(photoChange) {
      const key = legacyPhotoKey_(photoChange.item && photoChange.item.fotoUrl);
      if (!key || !photoChange.item) return;
      if (!photoChanges[key]) photoChanges[key] = { url:String(photoChange.item.fotoUrl), refs:{} };
      photoChanges[key].refs[legacyPhotoRefId_(dataset, photoChange.item)] = photoChange.present;
    });
  });

  const context = LEGACY_MUTATION_CONTEXT_;
  if (context) {
    options = Object.assign({}, options || {}, { operationId:context.id + '-data' });
    updates['legacyMutationJobs/' + context.id + '/status'] = 'COMPLETED';
    updates['legacyMutationJobs/' + context.id + '/result'] = legacyMutationResult_(context, changes);
  }
  const expected = Object.assign({}, options && options.expected || {});
  if (!appendOnlyPhotoRefs) changes.forEach(function(change) {
    const record = change.before || change.after;
    if (record) expected[legacyIndexDataset_(change.dataset) + '/' + record.id] = change.before || null;
  });
  changes.forEach(function(change) {
    if (change.dataset !== 'expenses') return;
    [change.before, change.after].forEach(function(record, index) {
      if (!record) return;
      const path = 'expenseIdentityV2/' + legacyIndexPeriod_('expenses', record) + '/' + mutationKey_(legacyExpenseIdentity_(record)) + '/' + record.id;
      updates[path] = index ? true : null;
    });
  });
  if (Object.keys(updates).length) mutationCommit_(updates, {
    operationId:options && options.operationId,
    expected:expected, aggregateDeltas:aggregateDeltas, photoChanges:photoChanges
  });
  return updates;
}

function legacyFinalizePhotoReferenceCounts_() {
  const root = fbRead_('/photoReferenceIndexV1') || {};
  const keys = Object.keys(root);
  const chunkSize = 500;
  let referenceCount = 0;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const updates = {};
    keys.slice(offset, offset + chunkSize).forEach(function(photoKey) {
      const node = root[photoKey] || {};
      const count = Object.keys(node.refs || {}).length;
      referenceCount += count;
      updates[photoKey + '/referenceCount'] = count;
      updates[photoKey + '/updatedAt'] = Date.now();
      updates[photoKey + '/version'] = LEGACY_INDEX_VERSION_;
    });
    if (Object.keys(updates).length) fbUpdate_('/photoReferenceIndexV1', updates);
  }
  return { photoCount:keys.length, referenceCount:referenceCount };
}

function legacyPhotoReferenceCount_(url) {
  const key = legacyPhotoKey_(url);
  if (!key) return 0;
  const node = fbRead_('/photoReferenceIndexV1/' + key) || {};
  return Math.max(Number(node.referenceCount || 0), Object.keys(node.refs || {}).length);
}

function legacyPhotoStillUsed_(url, knownExpenses, knownOcr) {
  if (legacyIndexReadsEnabled_() && legacyIndexMarkerUsable_('expenses') && legacyIndexMarkerUsable_('ocr_history')) {
    return legacyPhotoReferenceCount_(url) > 0;
  }
  const expenses = knownExpenses || fbRead_('/expenses') || {};
  if (Object.keys(expenses).some(function(key) { return expenses[key] && expenses[key].fotoUrl === url; })) return true;
  const ocr = knownOcr || fbRead_('/ocr_history') || {};
  return Object.keys(ocr).some(function(key) { return ocr[key] && ocr[key].fotoUrl === url; });
}

function legacyIndexMarkerUsable_(dataset) {
  const normalized = legacyIndexDataset_(dataset);
  const cacheKey = 'legacy-index-marker-' + normalized + '-v' + LEGACY_INDEX_VERSION_;
  const cached = cacheGetJson_(cacheKey);
  if (cached && typeof cached.usable === 'boolean') return cached.usable;
  const marker = fbRead_('/legacyIndexMeta/' + normalized) || {};
  const usable = Boolean(Number(marker.version) >= LEGACY_INDEX_VERSION_ && marker.validated === true);
  cachePutJson_(cacheKey, { usable:usable }, LEGACY_INDEX_MARKER_CACHE_TTL_);
  return usable;
}

function legacyInvalidateIndexMarkerCache_(dataset) {
  cacheRemoveJson_('legacy-index-marker-' + legacyIndexDataset_(dataset) + '-v' + LEGACY_INDEX_VERSION_);
}

function legacyIndexReadsEnabled_() {
  return String(PropertiesService.getScriptProperties().getProperty(LEGACY_INDEX_READ_FLAG_) || 'FALSE').toUpperCase() === 'TRUE';
}

function legacyIndexShadowEnabled_() {
  return String(PropertiesService.getScriptProperties().getProperty(LEGACY_INDEX_SHADOW_FLAG_) || 'FALSE').toUpperCase() === 'TRUE';
}

function legacyValidateIndexDataset_(dataset) {
  dataset = legacyIndexDataset_(dataset);
  const source = fbRead_('/' + dataset) || {};
  const ids = {};
  let indexedCount = 0;
  let indexedTotal = 0;
  if (dataset === 'expenses') {
    const root = fbRead_('/expenseIndexV1/byPeriodType') || {};
    Object.keys(root).forEach(function(period) {
      Object.keys(root[period] || {}).forEach(function(type) {
        Object.keys(root[period][type] || {}).forEach(function(sortKey) {
          const summary = root[period][type][sortKey] || {};
          if (!summary.id || ids[summary.id]) return;
          ids[summary.id] = true;
          indexedCount += 1;
          indexedTotal += Number(summary.row && summary.row[5] || 0);
        });
      });
    });
  } else {
    const root = fbRead_('/ocrIndexV1/byPeriodBranch') || {};
    Object.keys(root).forEach(function(period) {
      const all = root[period] && root[period]._ALL || {};
      Object.keys(all).forEach(function(sortKey) {
        const summary = all[sortKey] || {};
        if (!summary.id || ids[summary.id]) return;
        ids[summary.id] = true;
        indexedCount += 1;
        indexedTotal += Number(summary.row && summary.row[8] || 0);
      });
    });
  }
  const sourceKeys = Object.keys(source).filter(function(id) { return Boolean(source[id]); });
  const sourceTotal = sourceKeys.reduce(function(sum, id) { return sum + legacyIndexAmount_(dataset, source[id]); }, 0);
  const mismatches = sourceKeys.filter(function(id) { return !ids[id]; }).concat(Object.keys(ids).filter(function(id) { return !source[id]; })).slice(0, 25);
  return {
    valid:mismatches.length === 0 && sourceKeys.length === indexedCount && sourceTotal === indexedTotal,
    sourceCount:sourceKeys.length,
    indexedCount:indexedCount,
    sourceTotal:sourceTotal,
    indexedTotal:indexedTotal,
    mismatches:mismatches
  };
}

/**
 * Backfill indeks legacy yang aman dilanjutkan. Panggil berulang dengan cursor
 * dari response sampai done=true. reset=true hanya menghapus node indeks aditif,
 * tidak pernah menyentuh expenses/ocr_history.
 */
function portalRebuildLegacyIndexes_(session, payload) {
  mutationAssertIsolatedDev_();
  if (!session || session.role !== 'ADMIN') throw new Error('Hanya ADMIN yang dapat membangun indeks legacy.');
  payload = payload || {};
  const dataset = legacyIndexDataset_(payload.dataset || 'expenses');
  const batchSize = Math.min(250, Math.max(10, Number(payload.batchSize || 100)));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (payload.reset === true) {
      legacyApplyAtomicMutation_({
        expenseIndexV1:null,
        ocrIndexV1:null,
        legacyAggregatesV1:null,
        legacyIndexMeta:null,
        photoReferenceIndexV1:null
      }, []);
      legacyInvalidateIndexMarkerCache_('expenses');
      legacyInvalidateIndexMarkerCache_('ocr_history');
    }
    const previousMeta = fbRead_('/legacyIndexMeta/' + dataset) || {};
    // Meta server bersifat authoritative sehingga retry response yang hilang
    // tidak memproses batch lama dan menggandakan aggregate.
    const cursor = String(previousMeta.cursor || (payload.cursor != null ? payload.cursor : ''));
    const query = { orderBy:'$key', limitToFirst:batchSize + (cursor ? 2 : 1) };
    if (cursor) query.startAt = cursor;
    const sourceBatch = fbReadQuery_('/' + dataset, query) || {};
    let keys = Object.keys(sourceBatch).sort();
    if (cursor && keys[0] === cursor) keys.shift();
    const hasMore = keys.length > batchSize;
    keys = keys.slice(0, batchSize);
    const mutations = keys.map(function(id) {
      const item = Object.assign({}, sourceBatch[id] || {}, { id:String(sourceBatch[id] && sourceBatch[id].id || id) });
      return { dataset:dataset, before:null, after:item };
    });
    const nextCursor = keys.length ? keys[keys.length - 1] : cursor;
    const processed = Number(previousMeta.processed || 0) + keys.length;
    const done = !hasMore;
    const meta = {
      version:LEGACY_INDEX_VERSION_,
      dataset:dataset,
      cursor:nextCursor,
      processed:processed,
      done:done,
      validated:false,
      updatedAt:Date.now()
    };
    legacyApplyAtomicMutation_({ ['legacyIndexMeta/' + dataset]:meta }, mutations, { appendOnlyPhotoRefs:true });
    legacyInvalidateIndexMarkerCache_(dataset);
    let validation = null;
    if (done) {
      validation = legacyValidateIndexDataset_(dataset);
      const validatedMeta = Object.assign({}, meta, {
        validated:validation.valid,
        validatedAt:Date.now(),
        sourceCount:validation.sourceCount,
        indexedCount:validation.indexedCount,
        sourceTotal:validation.sourceTotal,
        indexedTotal:validation.indexedTotal,
        mismatchCount:validation.mismatches.length
      });
      fbUpdate_('/legacyIndexMeta/' + dataset, validatedMeta);
      legacyInvalidateIndexMarkerCache_(dataset);
      if (!validation.valid) throw new Error('Validasi indeks ' + dataset + ' gagal: ' + validation.mismatches.join(', '));
      const otherDataset = dataset === 'expenses' ? 'ocr_history' : 'expenses';
      const otherMeta = fbRead_('/legacyIndexMeta/' + otherDataset) || {};
      if (otherMeta.done === true && otherMeta.validated === true) {
        validation.photoReferences = legacyFinalizePhotoReferenceCounts_();
      }
    }
    const result = { success:true, dataset:dataset, processed:processed, cursor:nextCursor, done:done, validation:validation };
    portalAudit_('REBUILD_LEGACY_INDEXES', session.uid, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * FUNGSI MIGRASI SATU KALI JALAN
 * Memindahkan semua data dari Google Sheets lokal ke Firebase Realtime Database
 */
function migrateSheetsToFirebase_() {
  mutationAssertIsolatedDev_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Migrasi Hasil OCR
  const sheetHistory = ss.getSheetByName(SHEET_HISTORY);
  if (sheetHistory) {
    const data = sheetHistory.getDataRange().getValues();
    if (data.length > 1) {
      const ocrHistoryData = {};
      for (let i = 1; i < data.length; i++) {
        const row = sanitizeRow_(data[i], 12);
        const id = row[0] || ("TRX-" + new Date().getTime() + "-" + i + "-" + Math.floor(Math.random() * 1000));
        
        // Convert to Firebase object
        ocrHistoryData[id] = {
          id: id,
          timestamp: getSafeTime_(row[1]),
          tanggalNota: getSafeTime_(row[2]),
          cabang: String(row[3] || "").toUpperCase(),
          cv: String(row[4] || "").toUpperCase(),
          supplier: String(row[5] || "").toUpperCase(),
          name: String(row[6] || "").toUpperCase(),
          qty: Number(row[7]) || 0,
          total: Number(row[8]) || 0,
          fotoUrl: row[9] || "",
          unit: String(row[10] || "").toUpperCase(),
          statusPosting: String(row[11] || "")
        };
      }
      
      // Simpan batch ke Firebase
      fbWrite_("/ocr_history", ocrHistoryData);
      Logger.log("Berhasil memigrasikan " + Object.keys(ocrHistoryData).length + " data OCR History ke Firebase.");
    }
  }

  // 2. Migrasi Listrik & Umum
  const sheetListrik = ss.getSheetByName(SHEET_LISTRIK);
  if (sheetListrik) {
    const data = sheetListrik.getDataRange().getValues();
    if (data.length > 1) {
      const expensesData = {};
      for (let i = 1; i < data.length; i++) {
        const row = sanitizeRow_(data[i], 12);
        const id = row[0] || ("EXP-" + new Date().getTime() + "-" + i + "-" + Math.floor(Math.random() * 1000));
        
        expensesData[id] = {
          id: id,
          timestamp: getSafeTime_(row[1]),
          tanggal: getSafeTime_(row[2]),
          cabang: String(row[3] || "").toUpperCase(),
          cv: String(row[4] || "").toUpperCase(),
          nominal: Number(row[5]) || 0,
          fotoUrl: row[6] || "",
          kategori: row[7] || "Listrik",
          keterangan: row[8] || "-",
          noUrut: row[9] || "",
          jenis: String(row[10] || "").toUpperCase(),
          jumlah: String(row[11] || "")
        };
      }
      
      fbWrite_("/expenses", expensesData);
      Logger.log("Berhasil memigrasikan " + Object.keys(expensesData).length + " data Expenses ke Firebase.");
    }
  }
  
  return "Migrasi Selesai! Silakan cek Firebase Console Anda.";
}

/**
 * 1. FUNGSI ENTRY POINT (Untuk me-render HTML)
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('index');
  template.buildId = PORTAL_BUILD_ID;
  return template.evaluate()
    .setTitle('Database Nota GBB')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const PORTAL_LEGACY_ROUTES_ = Object.freeze({
  getBootstrapData: { fn: getBootstrapDataLegacy_, minArgs:0, maxArgs:0, maxChars:1024 },
  getHistoryPage: { fn:getHistoryPage_, minArgs:1, maxArgs:1, maxChars:200000 },
  getExpensePage: { fn:getExpensePage_, minArgs:1, maxArgs:1, maxChars:200000 },
  getExpenseSummaryByBranchMonth: { fn:getExpenseSummaryByBranchMonth_, minArgs:1, maxArgs:1, maxChars:4096 },
  deleteTransaction: { fn:deleteTransaction_, minArgs:1, maxArgs:1, maxChars:20000, mutates:true, validate:portalLegacyValidateId_ },
  duplicateToKategori: { fn:duplicateToKategori_, minArgs:2, maxArgs:2, maxChars:20000, mutates:true, validate:portalLegacyValidateDuplicate_ },
  processOCRWithGemini: { fn:processOCRWithGemini_, minArgs:1, maxArgs:1, maxChars:18000000 },
  updateTransaction: { fn:updateTransaction_, minArgs:2, maxArgs:2, maxChars:500000, mutates:true, validate:portalLegacyValidateIdAndObject_ },
  saveTransactions: { fn:saveTransactions_, minArgs:1, maxArgs:1, maxChars:35000000, mutates:true, validate:portalLegacyValidateObject_ },
  processLLM: { fn:processLLM_, minArgs:1, maxArgs:2, maxChars:2000000 },
  getLegacyPhoto: { fn:getLegacyPhoto_, minArgs:1, maxArgs:1, maxChars:10000 },
  updateListrikTransaction: { fn:updateListrikTransaction_, minArgs:2, maxArgs:2, maxChars:5000000, mutates:true, validate:portalLegacyValidateIdAndObject_ },
  saveListrikTransaction: { fn:saveListrikTransaction_, minArgs:1, maxArgs:1, maxChars:12000000, mutates:true, validate:portalLegacyValidateObject_ },
  deleteListrikTransaction: { fn:deleteListrikTransaction_, minArgs:1, maxArgs:1, maxChars:20000, mutates:true, validate:portalLegacyValidateId_ },
  bulkDeleteListrikTransaction: { fn:bulkDeleteListrikTransaction_, minArgs:1, maxArgs:1, maxChars:1000000, mutates:true, validate:portalLegacyValidateIdList_ },
  fetchExternalData: { fn:fetchExternalData_, minArgs:1, maxArgs:1, maxChars:250000, validate:portalLegacyValidateObject_ },
  submitTarikDataBatch: { fn:submitTarikDataBatch_, minArgs:1, maxArgs:1, maxChars:35000000, mutates:true, validate:portalLegacyValidateObject_ },
  resetTarikDataBatch: { fn:resetTarikDataBatch_, minArgs:1, maxArgs:1, maxChars:5000000, mutates:true, validate:portalLegacyValidateObject_ }
});

/**
 * Satu-satunya endpoint publik untuk aplikasi legacy.
 * Implementasi lama tidak lagi dapat dipanggil langsung dari browser.
 */
function portalLegacyApi(sessionToken, action, args, mutationMeta) {
  const session = portalRequireSession_(sessionToken, ['TAX', 'ADMIN']);

  const actionName = String(action || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(actionName)) {
    throw new Error('Aksi legacy tidak valid.');
  }
  const route = PORTAL_LEGACY_ROUTES_[actionName];
  if (!route) throw new Error('Aksi legacy tidak diizinkan.');
  if (!Array.isArray(args)) throw new Error('Argumen legacy harus berupa array.');
  if (args.length < route.minArgs || args.length > route.maxArgs) {
    throw new Error('Jumlah argumen legacy tidak valid.');
  }

  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch (error) {
    throw new Error('Payload legacy tidak dapat dibaca.');
  }
  if (typeof serialized !== 'string' || serialized.length > route.maxChars) {
    throw new Error('Payload legacy terlalu besar.');
  }
  if (route.validate) route.validate(args);

  const auditDetails = { action:actionName, argumentCount:args.length, payloadChars:serialized.length };
  if (route.mutates) portalAudit_('LEGACY_MUTATION_ATTEMPT', session.uid, auditDetails);
  try {
    MUTATION_SESSION_ = session;
    if (route.mutates && (!mutationMeta || !mutationMeta.clientRequestId)) throw new Error('Muat ulang aplikasi sebelum mengubah data.');
    if (/^(submitTarikDataBatch|resetTarikDataBatch)$/.test(actionName)) args[0] = Object.assign({}, args[0], { clientRequestId:mutationMeta.clientRequestId });
    const result = route.mutates && !/^(submitTarikDataBatch|resetTarikDataBatch)$/.test(actionName) ? legacyRunMutation_(session, actionName, args, mutationMeta, route.fn) : route.fn.apply(null, args);
    MUTATION_SESSION_ = null;
    if (route.mutates) portalAudit_('LEGACY_MUTATION_SUCCESS', session.uid, auditDetails);
    return result;
  } catch (error) {
    if (route.mutates) {
      portalAudit_('LEGACY_MUTATION_FAILED', session.uid, Object.assign({}, auditDetails, {
        error:String(error && error.message || error || 'Unknown error').slice(0, 300)
      }));
    }
    throw error;
  }
}

function portalLegacyValidateObject_(args) {
  if (!args[0] || Object.prototype.toString.call(args[0]) !== '[object Object]') throw new Error('Payload legacy harus berupa object.');
}

function portalLegacyValidateId_(args) {
  const id = String(args[0] || '');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('ID transaksi tidak valid.');
}

function portalLegacyValidateIdAndObject_(args) {
  portalLegacyValidateId_(args);
  if (!args[1] || Object.prototype.toString.call(args[1]) !== '[object Object]') throw new Error('Data perubahan harus berupa object.');
}

function portalLegacyValidateIdList_(args) {
  if (!Array.isArray(args[0]) || !args[0].length || args[0].length > 500) throw new Error('Daftar ID tidak valid.');
  args[0].forEach(function(id) { portalLegacyValidateId_([id]); });
}

function portalLegacyValidateDuplicate_(args) {
  portalLegacyValidateId_(args);
  if (['Umum', 'Listrik'].indexOf(String(args[1] || '')) === -1) throw new Error('Kategori tujuan tidak valid.');
}

/**
 * 2. FUNGSI HELPER: Mendapatkan Sheet atau Membuatnya
 */
function getSafeSheet_(ss, sheetName, headers = []) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    // Case-insensitive and whitespace-tolerant search
    const sheets = ss.getSheets();
    const cleanTargetName = sheetName.trim().toLowerCase();
    for (let i = 0; i < sheets.length; i++) {
      const currentName = sheets[i].getName().trim().toLowerCase();
      if (currentName === cleanTargetName) {
        sheet = sheets[i];
        break;
      }
    }
  }
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    }
  }
  return sheet;
}

/**
 * FUNGSI HELPER UNTUK SERIALISASI DATA YANG AMAN
 */
function getSafeTime_(val) {
  if (val instanceof Date) {
    const t = val.getTime();
    return isNaN(t) ? 0 : t;
  }
  if (val) {
    const t = new Date(val).getTime();
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

function sanitizeRow_(row, expectedCols) {
  const cleanRow = new Array(expectedCols).fill("");
  for (let i = 0; i < expectedCols; i++) {
    let val = row[i];
    if (val === undefined || val === null) {
      val = "";
    } else if (val instanceof Date) {
      const t = val.getTime();
      val = isNaN(t) ? 0 : t;
    } else if (typeof val === 'number') {
      if (isNaN(val) || !isFinite(val)) {
        val = 0;
      }
    } else if (typeof val === 'object') {
      try {
        val = JSON.stringify(val);
      } catch (e) {
        val = String(val);
      }
    }
    cleanRow[i] = val;
  }
  return cleanRow;
}

/**
 * 3. FUNGSI GET ALL DATA
 */
const CACHE_BOOTSTRAP_KEY = "bootstrap_data_v2";
const CACHE_BOOTSTRAP_TTL = 300;

function cacheGetJson_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const metaStr = cache.get(key);
    if (!metaStr) return null;
    
    const meta = JSON.parse(metaStr);
    if (!meta.chunked) {
      return JSON.parse(meta.data);
    }
    
    let fullStr = "";
    for (let i = 0; i < meta.count; i++) {
      const chunk = cache.get(key + "_" + i);
      if (!chunk) return null; // If any chunk is missing/expired, treat as cache miss
      fullStr += chunk;
    }
    return JSON.parse(fullStr);
  } catch (e) {
    return null;
  }
}

function cachePutJson_(key, value, ttlSeconds) {
  try {
    const cache = CacheService.getScriptCache();
    const str = JSON.stringify(value);
    const limit = 80000; // Safe limit under 100KB (approx 80KB of character strings)
    const ttl = ttlSeconds || 300;
    
    if (str.length <= limit) {
      cache.put(key, JSON.stringify({ chunked: false, data: str }), ttl);
      return;
    }
    
    const chunks = [];
    for (let i = 0; i < str.length; i += limit) {
      chunks.push(str.substring(i, i + limit));
    }
    
    // Write metadata
    cache.put(key, JSON.stringify({ chunked: true, count: chunks.length }), ttl);
    
    // Write chunks
    for (let i = 0; i < chunks.length; i++) {
      cache.put(key + "_" + i, chunks[i], ttl);
    }
  } catch (e) {
    Logger.log("Gagal menyimpan cache: " + e.message);
  }
}

function cacheRemoveJson_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const metaStr = cache.get(key);
    if (!metaStr) {
      cache.remove(key);
      return;
    }
    const meta = JSON.parse(metaStr);
    cache.remove(key);
    if (meta.chunked) {
      for (let i = 0; i < meta.count; i++) {
        cache.remove(key + "_" + i);
      }
    }
  } catch (e) {
    try {
      CacheService.getScriptCache().remove(key);
    } catch(err) {}
  }
}

function getBootstrapData_() {
  const cached = cacheGetJson_(CACHE_BOOTSTRAP_KEY);
  if (cached) return cached;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetCabang = getSafeSheet_(ss, SHEET_CABANG, ["Nama Cabang", "Nama CV"]);
  const dataCabang = sheetCabang.getDataRange().getValues();
  const branches = [];
  if (dataCabang.length > 1) {
    for (let i = 1; i < dataCabang.length; i++) {
      if (dataCabang[i][0]) {
        branches.push({ toko: dataCabang[i][0], cv: dataCabang[i][1] });
      }
    }
  }

  const jenisPengeluaran = [];
  const cabangCentralKitchen = [];
  try {
    const sheetParam = ss.getSheetByName("Parameter(Hide)");
    if (sheetParam) {
      const dataParam = sheetParam.getDataRange().getValues();
      for (let i = 1; i < dataParam.length; i++) {
        if (dataParam[i][0]) jenisPengeluaran.push(String(dataParam[i][0]).trim());
        if (dataParam[i][3]) cabangCentralKitchen.push(String(dataParam[i][3]).trim());
      }
    }
  } catch (e) {}

  const data = {
    branches: branches,
    jenisPengeluaran: jenisPengeluaran,
    cabangCentralKitchen: cabangCentralKitchen
  };
  cachePutJson_(CACHE_BOOTSTRAP_KEY, data, CACHE_BOOTSTRAP_TTL);
  return data;
}

function getBootstrapDataLegacy_() {
  try {
    const data = getBootstrapData_();
    return {
      branches: data.branches,
      jenisPengeluaran: data.jenisPengeluaran,
      cabangCentralKitchen: data.cabangCentralKitchen
    };
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      branches: [],
      jenisPengeluaran: [],
      cabangCentralKitchen: []
    };
  }
}

function getPageOptions_(options, defaultLimit) {
  const opts = options || {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const limit = Math.max(1, Math.min(5000, parseInt(opts.limit, 10) || defaultLimit || 25));
  return {
    page: page,
    cursor:opts.cursor || null,
    limit: limit,
    filters: opts.filters || {},
    sort: opts.sort || {}
  };
}

function applyDateFilter_(rowTime, filters) {
  const startTime = filters.startTime ? Number(filters.startTime) : null;
  const endTime = filters.endTime ? Number(filters.endTime) : null;
  if (startTime !== null && (!rowTime || Number(rowTime) < startTime)) return false;
  if (endTime !== null && (!rowTime || Number(rowTime) > endTime)) return false;
  return true;
}

function sortRows_(rows, sort, defaultCol, defaultAsc) {
  const col = sort && sort.col !== undefined ? Number(sort.col) : defaultCol;
  const asc = sort && sort.asc !== undefined ? !!sort.asc : !!defaultAsc;
  rows.sort((a, b) => {
    let valA = a[col];
    let valB = b[col];
    const numeric = typeof valA === "number" || typeof valB === "number" || (!isNaN(valA) && !isNaN(valB));
    if (numeric) {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
      return asc ? valA - valB : valB - valA;
    }
    valA = String(valA || "").toLowerCase();
    valB = String(valB || "").toLowerCase();
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });
}

const CACHE_OCR_KEY = "ocr_rows_v2";
const CACHE_EXP_KEY = "exp_rows_v2";
const CACHE_DATA_TTL = 240; // 4 menit (240 detik)

function invalidateDataCache_() {
  try {
    cacheRemoveJson_(CACHE_OCR_KEY);
    cacheRemoveJson_(CACHE_EXP_KEY);
  } catch (e) {
    Logger.log("Gagal menghapus cache: " + e.message);
  }
}

function readHistoryRows_() {
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  const key = CACHE_OCR_KEY + '-' + version;
  const cached = cacheGetJson_(key);
  if (cached) return cached;
  
  const fbData = fbRead_("/ocr_history");
  const rows = fbData ? Object.keys(fbData).map(key => ocrObjectToArray_(fbData[key])) : [];
  if (version !== String(fbRead_('/dataVersions/legacy') || 'v79')) throw new Error('Data berubah selama pembacaan. Muat ulang.');
  cachePutJson_(key, rows, CACHE_DATA_TTL);
  return rows;
}

function readExpenseRows_() {
  const version = String(fbRead_('/dataVersions/legacy') || 'v79');
  const key = CACHE_EXP_KEY + '-' + version;
  const cached = cacheGetJson_(key);
  if (cached) return cached;
  
  const fbData = fbRead_("/expenses");
  const rows = fbData ? Object.keys(fbData).map(key => expenseObjectToArray_(fbData[key])) : [];
  if (version !== String(fbRead_('/dataVersions/legacy') || 'v79')) throw new Error('Data berubah selama pembacaan. Muat ulang.');
  cachePutJson_(key, rows, CACHE_DATA_TTL);
  return rows;
}

function legacyFilterPeriod_(filters) {
  const start = Number(filters && filters.startTime || 0);
  const end = Number(filters && filters.endTime || 0);
  if (!start || !end) return null;
  const startPeriod = Utilities.formatDate(new Date(start), Session.getScriptTimeZone(), 'yyyyMM');
  const endPeriod = Utilities.formatDate(new Date(end), Session.getScriptTimeZone(), 'yyyyMM');
  if (startPeriod !== endPeriod) return null;
  const year = Number(startPeriod.slice(0, 4));
  const month = Number(startPeriod.slice(4, 6)) - 1;
  const monthStart = new Date(year, month, 1).getTime();
  const nextMonthStart = new Date(year, month + 1, 1).getTime();
  return {
    period:startPeriod,
    coversWholePeriod:start <= monthStart && end >= nextMonthStart - 1
  };
}

function legacyDefaultSort_(dataset, sort) {
  if (!sort || sort.col === undefined) return true;
  const expectedCol = dataset === 'expenses' ? 2 : 1;
  return Number(sort.col) === expectedCol && (sort.asc === undefined || sort.asc === false);
}

function legacyReadIndexSegment_(path, limitToLast) {
  const params = { orderBy:'$key' };
  if (limitToLast) params.limitToLast = Math.min(100, Math.max(1, Number(limitToLast)));
  const data = fbReadQuery_('/' + path, params) || {};
  return Object.keys(data).map(function(key) { return data[key] && data[key].row || []; });
}

function legacyReadAggregate_(dataset, period, segment) {
  return fbRead_('/legacyAggregatesV1/' + dataset + '/' + period + '/' + segment) || { count:0, totalAmount:0 };
}

function legacyReadIndexBundle_(dataset, period, segments, limitToLast, includeAggregates) {
  const requests = [];
  const descriptors = [];
  (segments || []).forEach(function(segment) {
    const indexPath = dataset === 'expenses'
      ? '/expenseIndexV1/byPeriodType/' + period + '/' + segment
      : '/ocrIndexV1/byPeriodBranch/' + period + '/' + segment;
    const params = { orderBy:'$key' };
    if (limitToLast) params.limitToLast = Math.min(100, Math.max(1, Number(limitToLast)));
    requests.push({ path:indexPath, params:params });
    descriptors.push({ type:'rows', segment:segment });
    if (includeAggregates) {
      requests.push({ path:'/legacyAggregatesV1/' + dataset + '/' + period + '/' + segment });
      descriptors.push({ type:'aggregate', segment:segment });
    }
  });
  const payloads = fbReadBatch_(requests);
  const result = { rows:[], total:0, totalAmount:0 };
  payloads.forEach(function(payload, index) {
    const descriptor = descriptors[index];
    if (descriptor.type === 'rows') {
      Object.keys(payload || {}).forEach(function(key) {
        result.rows.push(payload[key] && payload[key].row || []);
      });
      return;
    }
    result.total += Number(payload && payload.count || 0);
    result.totalAmount += Number(payload && payload.totalAmount || 0);
  });
  return result;
}

function legacyReadHistoryPage_(opts) { return legacyIndexPageV2_('ocr_history', opts, ''); }

function legacyReadExpensePage_(opts, type) { return legacyIndexPageV2_('expenses', opts, type); }

function legacyLogShadowParity_(dataset, legacyResult, indexedResult) {
  if (!indexedResult) return;
  const legacyIds = (legacyResult.rows || []).map(function(row) { return row[0]; }).join('|');
  const indexedIds = (indexedResult.rows || []).map(function(row) { return row[0]; }).join('|');
  console.log(JSON.stringify({
    type:'legacy-index-shadow',
    dataset:dataset,
    parity:legacyIds === indexedIds && Number(legacyResult.total) === Number(indexedResult.total) && Number(legacyResult.totalAmount) === Number(indexedResult.totalAmount),
    legacyTotal:Number(legacyResult.total || 0),
    indexedTotal:Number(indexedResult.total || 0)
  }));
}

function getHistoryPage_(options) {
  try {
    const opts = getPageOptions_(options, 25);
    if (legacyIndexReadsEnabled_() && legacyIndexMarkerUsable_('ocr_history')) {
      const indexed = legacyReadHistoryPage_(opts);
      if (indexed) return indexed;
    }
    const filters = opts.filters || {};
    const search = String(filters.search || "").trim().toLowerCase();
    const cabang = String(filters.cabang || "").trim().toLowerCase();
    let rows = readHistoryRows_().filter(r => {
      if (cabang && String(r[3] || "").trim().toLowerCase() !== cabang) return false;
      if (search && !((r[5] || "") + " " + (r[6] || "")).toLowerCase().includes(search)) return false;
      return applyDateFilter_(r[2], filters);
    });

    sortRows_(rows, opts.sort, 1, false);
    const total = rows.length;
    const totalAmount = rows.reduce((sum, r) => sum + (Number(r[8]) || 0), 0);
    const start = (opts.page - 1) * opts.limit;
    const pageRows = rows.slice(start, start + opts.limit);
    const result = {
      rows: pageRows,
      history: pageRows,
      total: total,
      totalAmount: totalAmount,
      page: opts.page,
      limit: opts.limit
    };
    if (!legacyIndexReadsEnabled_() && legacyIndexShadowEnabled_() && legacyIndexMarkerUsable_('ocr_history')) {
      try { legacyLogShadowParity_('ocr_history', result, legacyReadHistoryPage_(opts)); } catch (shadowError) { console.warn('Shadow OCR index gagal: ' + shadowError.message); }
    }
    return result;
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      rows: [],
      history: [],
      total: 0,
      totalAmount: 0,
      page: 1,
      limit: 25
    };
  }
}

function getExpensePage_(options) {
  try {
    const opts = getPageOptions_(options, 50);
    const filters = opts.filters || {};
    const type = String(opts.type || options && options.type || filters.type || "all").trim().toLowerCase();
    if (legacyIndexReadsEnabled_() && legacyIndexMarkerUsable_('expenses')) {
      const indexed = legacyReadExpensePage_(opts, type);
      if (indexed) return indexed;
    }
    const search = String(filters.search || "").trim().toLowerCase();
    let rows = readExpenseRows_().filter(r => {
      const cat = String(r[7] || "").trim().toLowerCase();
      if (type === "listrik" && cat === "umum") return false;
      if (type === "umum" && cat !== "umum") return false;
      if (search) {
        const haystack = type === "umum"
          ? ((r[3] || "") + " " + (r[8] || "") + " " + (r[10] || "") + " " + (r[11] || "")).toLowerCase()
          : ((r[3] || "") + " " + (r[4] || "")).toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return applyDateFilter_(r[2], filters);
    });

    sortRows_(rows, opts.sort, 2, false);
    const total = rows.length;
    const totalAmount = rows.reduce((sum, r) => sum + (Number(r[5]) || 0), 0);
    const start = (opts.page - 1) * opts.limit;
    const pageRows = rows.slice(start, start + opts.limit);
    const result = {
      rows: pageRows,
      history: pageRows,
      total: total,
      totalAmount: totalAmount,
      page: opts.page,
      limit: opts.limit,
      type: type
    };
    if (!legacyIndexReadsEnabled_() && legacyIndexShadowEnabled_() && legacyIndexMarkerUsable_('expenses')) {
      try { legacyLogShadowParity_('expenses', result, legacyReadExpensePage_(opts, type)); } catch (shadowError) { console.warn('Shadow expense index gagal: ' + shadowError.message); }
    }
    return result;
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      rows: [],
      history: [],
      total: 0,
      totalAmount: 0,
      page: 1,
      limit: 50
    };
  }
}

function getExpenseSummaryByBranchMonth_(year) {
  try {
    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const bootstrap = getBootstrapData_();
    const branchSet = {};
    const summary = {};
    (bootstrap.branches || []).forEach(b => {
      if (b && b.toko) {
        branchSet[String(b.toko)] = true;
        summary[String(b.toko)] = {};
      }
    });

    const rows = legacyIndexReadsEnabled_() && legacyIndexMarkerUsable_('expenses') ? legacyReadExpenseYearRows_(targetYear) : readExpenseRows_();
    rows.forEach(r => {
      const cat = String(r[7] || "").trim().toLowerCase();
      if (cat === "umum") return;
      const d = new Date(r[2]);
      if (isNaN(d.getTime()) || d.getFullYear() !== targetYear) return;
      const toko = String(r[3] || "-");
      const month = d.getMonth();
      branchSet[toko] = true;
      if (!summary[toko]) summary[toko] = {};
      if (!summary[toko][month]) summary[toko][month] = { count: 0, total: 0, records: [] };
      summary[toko][month].count++;
      summary[toko][month].total += Number(r[5]) || 0;
      summary[toko][month].records.push(r);
    });

    return {
      year: targetYear,
      branches: Object.keys(branchSet).sort(),
      summary: summary
    };
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      year: year,
      branches: [],
      summary: {}
    };
  }
}

function getAllData_() {
  try {
    const bootstrap = getBootstrapData_();
    const page = getHistoryPage_({ page: 1, limit: 50 });

    return { 
      branches: bootstrap.branches, 
      history: page.rows,
      total: page.total,
      totalAmount: page.totalAmount,
      jenisPengeluaran: bootstrap.jenisPengeluaran,
      cabangCentralKitchen: bootstrap.cabangCentralKitchen,
      debugInfo: [],
      ssInfo: {}
    };
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      branches: [],
      history: [],
      jenisPengeluaran: [],
      cabangCentralKitchen: [],
      debugInfo: [],
      ssInfo: {}
    };
  }
}

/**
 * 4. FUNGSI ANALISA GAMBAR DENGAN GEMINI
 */
function processOCRWithGemini_(base64Data) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error("API Key Gemini belum disetting di Script Properties.");

  const base64Str = Array.isArray(base64Data) ? base64Data[0] : base64Data;

  // Menggunakan Gemini 3.5 Flash untuk ocr dan efisiensi
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey;
  
  const promptText = `
    Anda adalah sistem ekstraksi data forensik finansial.
    Tugas Anda adalah mengekstrak data dari SATU gambar nota ini. Lakukan analisis internal (Chain of Thought):

    LANGKAH 1 (Pemetaan Visual):
    - Header: Cari nama Toko/Supplier.
    - Body: Fokus pada tabel/daftar barang.

    LANGKAH 2 (Batasan Ketat / Negative Constraints):
    - HANYA ekstrak baris yang memiliki Kuantitas (Qty) dan Harga.
    - ABAIKAN baris kosong atau coretan.
    - JANGAN menebak angka jika tidak terbaca. Waspadai halusinasi jumlah nol (0) pada harga!

    LANGKAH 3 (Validasi):
    - Hitung ulang: Apakah (Qty * Harga Satuan) mendekati "Jumlah/Total Harga"? Jika iya, gunakan "Total Harga" tersebut.

    LANGKAH 4 (Format Output Murni):
    Keluarkan HANYA dalam format JSON tanpa markdown:
    {
      "supplier": "Nama Toko / Supplier",
      "items": [
        {
          "name": "NAMA BARANG/ITEM",
          "qty": <angka kuantitas>,
          "unit": "SATUAN (PCS/KG/DUS)",
          "total": <angka total harga untuk item ini, HANYA ANGKA>
        }
      ]
    }
  `;

  const payload = {
    contents: [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/jpeg", data: base64Str } }] }],
    generationConfig: { temperature: 0.0, responseMimeType: "application/json" }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const resCode = response.getResponseCode();
  const resText = response.getContentText();

  if (resCode !== 200) throw new Error(`Gemini API Error: ${resText}`);

  const jsonResponse = JSON.parse(resText);
  if (!jsonResponse.candidates || jsonResponse.candidates.length === 0) {
    throw new Error("Gemini tidak mengembalikan hasil.");
  }

  const outputText = jsonResponse.candidates[0].content.parts[0].text;
  
  try {
    const cleanJson = outputText.replace(/```json/g, '').replace(/```/g, '').trim();
    const resultData = JSON.parse(cleanJson);
    return [{ success: true, data: resultData }];
  } catch (e) {
    throw new Error("Gagal memparsing JSON dari Gemini. Raw Output: " + outputText);
  }
}

/**
 * 5. FUNGSI MERAPIKAN NAMA BARANG
 */
function processLLM_(prompt, isJson) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error("API Key Gemini belum disetting.");

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey;
  const payloadObj = { contents: [{ parts: [{ text: prompt }] }] };
  if (isJson) payloadObj.generationConfig = { responseMimeType: "application/json" };

  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payloadObj), muteHttpExceptions: true });
  if(res.getResponseCode() !== 200) throw new Error(res.getContentText());

  const jsonRes = JSON.parse(res.getContentText());
  return jsonRes.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
}

function uploadImagesToDrive_(base64Array, payload) {
  const rootFolder = legacyPhotoRoot_(FOLDER_NAME);

  // Dapatkan/Buat subfolder periode berdasarkan tanggal nota
  let periodeStr = "Lain-Lain";
  try {
    let tgl = (payload && payload.tanggal) ? new Date(payload.tanggal) : new Date();
    if (isNaN(tgl.getTime())) tgl = new Date();
    const monthsIndo = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    periodeStr = monthsIndo[tgl.getMonth()] + " " + tgl.getFullYear();
  } catch(e) {}
  
  const periodeFolder = getOrCreateFolder_(rootFolder, periodeStr);

  // Dapatkan/Buat subfolder cabang
  const cabangName = (payload && payload.toko) ? String(payload.toko).trim().toUpperCase() : "TANPA CABANG";
  const cabangFolder = getOrCreateFolder_(periodeFolder, cabangName);

  let imageUrls = [];

  const cleanCabang = cabangName.replace(/[^a-zA-Z0-9]/g, '_');
  for (let i = 0; i < base64Array.length; i++) {
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Array[i]), 'image/jpeg', `Nota_${cleanCabang}_${timestamp}_${i}.jpg`);
    const file = cabangFolder.createFile(blob);
    imageUrls.push(file.getUrl());
  }
  return imageUrls;
}

function saveTransactions_(payload) {
  try {
    let uploadedUrls = [];
    if (payload.base64 && payload.base64.length > 0) uploadedUrls = uploadImagesToDrive_(payload.base64, payload);

    const updates = {};
    const indexMutations = [];
    const newRows = [];
    const now = new Date();
    let tanggalNota = payload.tanggal ? new Date(payload.tanggal) : new Date();

    payload.items.forEach(item => {
      const id = "TRX-" + mutationUuid_();
      const imgUrl = (item.base64Index !== undefined && uploadedUrls[item.base64Index]) ? uploadedUrls[item.base64Index] : "-";
      
      // Simpan format Firebase object
      const transaction = {
        id: id,
        timestamp: now.getTime(),
        tanggalNota: tanggalNota.getTime(),
        cabang: String(payload.toko).toUpperCase(),
        cv: String(payload.cv).toUpperCase(),
        supplier: String(item.toko || payload.supplier).toUpperCase(),
        name: String(item.name).toUpperCase(),
        qty: Number(item.qty) || 0,
        total: Number(item.total) || 0,
        fotoUrl: imgUrl,
        unit: String(item.unit).toUpperCase(),
        statusPosting: ""
      };
      updates['ocr_history/' + id] = transaction;
      indexMutations.push({ dataset:'ocr_history', before:null, after:transaction });

      const rowData = [
        id, now.getTime(), tanggalNota.getTime(), 
        String(payload.toko).toUpperCase(), 
        String(payload.cv).toUpperCase(), 
        String(item.toko || payload.supplier).toUpperCase(),
        String(item.name).toUpperCase(), 
        item.qty, item.total, imgUrl, 
        String(item.unit).toUpperCase(),
        "" 
      ];
      
      newRows.push(rowData);
    });

    // Write to Firebase
    if (Object.keys(updates).length > 0) {
      legacyApplyAtomicMutation_(updates, indexMutations);
      invalidateDataCache_();
    }

    return newRows;
  } finally {
    // Per-record protection is held only during the Firebase commit.
  }
}

function updateTransaction_(id, u) {
  try {
    const oldItem = fbRead_("/ocr_history/" + id);
    if (!oldItem) throw new Error('Data tidak ditemukan.');
    const data = {};
    if (u.tanggal) data.tanggalNota = getSafeTime_(u.tanggal);
    data.supplier = String(u.supplier).toUpperCase();
    data.name = String(u.name).toUpperCase();
    data.qty = Number(u.qty) || 0;
    data.total = Number(u.total) || 0;
    data.unit = String(u.unit).toUpperCase();

    const nextItem = Object.assign({}, oldItem, data, { id:id });
    legacyApplyAtomicMutation_({ ['ocr_history/' + id]:nextItem }, [
      { dataset:'ocr_history', before:oldItem, after:nextItem }
    ]);
    invalidateDataCache_();
    return true;
  } catch (e) {
    throw new Error("Gagal mengupdate transaksi di Firebase: " + e.message);
  }
}

function deleteTransaction_(id) {
  try {
    // 1. Ambil data transaksi yang akan dihapus
    const item = fbRead_("/ocr_history/" + id);
    if (!item) throw new Error("Data tidak ditemukan.");
    
    const imgUrl = item.fotoUrl;
    
    // 2. Hapus data utama dan seluruh indeks dalam satu PATCH
    legacyApplyAtomicMutation_({ ['ocr_history/' + id]:null }, [
      { dataset:'ocr_history', before:item, after:null }
    ]);
    invalidateDataCache_();
    
    // 3. Hapus file dari Drive jika tidak dipakai lagi di baris lain (History maupun Listrik)
    if (imgUrl && imgUrl !== "-" && imgUrl.includes("drive.google.com")) {
      const isUsed = legacyPhotoStillUsed_(imgUrl);

      if (!isUsed) {
         try {
            const fileId = extractDriveFileId_(imgUrl);
            if (fileId) legacySchedulePhotoReview_(imgUrl);
         } catch(e) {
            Logger.log("Gagal menghapus file dari Drive: " + e.message);
         }
      }
    }
    return true; 
  } catch (e) {
    throw new Error("Gagal menghapus transaksi di Firebase: " + e.message);
  }
}

/**
 * FITUR BARU: Auto-Format / Bulk Fix Data to Capital
 * Memproses seluruh data lama di sheet agar kapital dan merapikan satuan GAS.
 * Menggunakan teknik Batch-Update agar selesai dalam 1 detik.
 */
function formatExistingDataCapital_() {
  mutationAssertIsolatedDev_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSafeSheet_(ss, SHEET_HISTORY);
  const lastRow = sheet.getLastRow();
  
  if(lastRow <= 1) return true; // Sheet kosong

  // Ambil Kolom G (Item - Index 6) dan Kolom K (Unit - Index 10) sekaligus
  const names = sheet.getRange(2, 7, lastRow - 1, 1).getValues();
  const units = sheet.getRange(2, 11, lastRow - 1, 1).getValues();

  for(let i=0; i < names.length; i++) {
    let nameVal = String(names[i][0]).trim().toUpperCase();
    let unitVal = String(units[i][0]).trim().toUpperCase();
    
    // Aturan khusus GAS
    if(nameVal.includes("GAS")) {
      unitVal = "TABUNG";
    }

    names[i][0] = nameVal;
    units[i][0] = unitVal;
  }

  // Tulis kembali secara masal ke Spreadsheet (sangat cepat, menghindari timeout)
  sheet.getRange(2, 7, lastRow - 1, 1).setValues(names);
  sheet.getRange(2, 11, lastRow - 1, 1).setValues(units);

  return true;
}

/**
 * ==========================================
 * MODUL NOTA LISTRIK & UMUM (PENGELUARAN)
 * ==========================================
 */
function getListrikData_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let listrikHistory = [];

    try {
      const fbData = fbRead_("/expenses");
      if (fbData) {
        listrikHistory = Object.keys(fbData).map(key => expenseObjectToArray_(fbData[key]));
        
        // Sort dari yang paling baru berdasarkan tanggal (index 2)
        listrikHistory.sort((a, b) => {
          const timeA = Number(a[2]) || 0;
          const timeB = Number(b[2]) || 0;
          return timeB - timeA;
        });
      }
    } catch (fbErr) {
      Logger.log("Gagal membaca expenses dari Firebase: " + fbErr.message);
    }
    
    let debugInfo = [];
    let ssInfo = {};
    try {
      ssInfo = {
        id: ss.getId(),
        name: ss.getName(),
        url: ss.getUrl()
      };
      debugInfo = ss.getSheets().map(s => ({
        name: s.getName(),
        rows: 0,
        cols: 0
      }));
    } catch (e) {
      debugInfo = [{ error: e.message }];
    }

    return {
      history: listrikHistory,
      debugInfo: debugInfo,
      ssInfo: ssInfo
    };
  } catch (error) {
    return {
      error: error.toString() + "\nStack: " + error.stack,
      history: [],
      debugInfo: [],
      ssInfo: {}
    };
  }
}

function uploadListrikImageToDrive_(base64Data, payload) {
  const rootFolder = legacyPhotoRoot_(FOLDER_LISTRIK);

  // Dapatkan/Buat subfolder periode berdasarkan tanggal nota
  let periodeStr = "Lain-Lain";
  try {
    let tgl = (payload && payload.tanggal) ? new Date(payload.tanggal) : new Date();
    if (isNaN(tgl.getTime())) tgl = new Date();
    const monthsIndo = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    periodeStr = monthsIndo[tgl.getMonth()] + " " + tgl.getFullYear();
  } catch(e) {}
  
  const periodeFolder = getOrCreateFolder_(rootFolder, periodeStr);

  // Dapatkan/Buat subfolder cabang
  const cabangName = (payload && payload.toko) ? String(payload.toko).trim().toUpperCase() : "TANPA CABANG";
  const cabangFolder = getOrCreateFolder_(periodeFolder, cabangName);

  const cleanCabang = cabangName.replace(/[^a-zA-Z0-9]/g, '_');
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', `Nota_${cleanCabang}_${timestamp}.jpg`);
  const file = cabangFolder.createFile(blob);
  return file.getUrl();
}

function saveListrikTransaction_(payload) {
  try {
    let imgUrl = "-";
    if (payload.base64) {
      imgUrl = uploadListrikImageToDrive_(payload.base64, payload);
    }

    const now = new Date();
    const prefix = payload.kategori === "Umum" ? "UMM-" : "LST-";
    const id = prefix + mutationUuid_();
    let tanggalNota = payload.tanggal ? new Date(payload.tanggal) : now;

    // Simpan ke Firebase
    const data = {
      id: id,
      timestamp: now.getTime(),
      tanggal: tanggalNota.getTime(),
      cabang: String(payload.toko).toUpperCase(),
      cv: String(payload.cv).toUpperCase(),
      nominal: Number(payload.nominal) || 0,
      fotoUrl: imgUrl,
      kategori: payload.kategori || "Listrik",
      keterangan: payload.keterangan || "-",
      noUrut: payload.noUrut || "",
      jenis: String(payload.jenis || (payload.kategori === "Umum" ? "UMUM" : "LISTRIK")).toUpperCase(),
      jumlah: String(payload.jumlah || "-")
    };

    legacyApplyAtomicMutation_({ ['expenses/' + id]:data }, [
      { dataset:'expenses', before:null, after:data }
    ]);
    invalidateDataCache_();

    return [
      id, now.getTime(), tanggalNota.getTime(),
      String(payload.toko).toUpperCase(),
      String(payload.cv).toUpperCase(),
      payload.nominal,
      imgUrl,
      payload.kategori || "Listrik",
      payload.keterangan || "-",
      data.noUrut,
      data.jenis,
      data.jumlah
    ];
  } finally {
    // Per-record protection is held only during the Firebase commit.
  }
}

function updateListrikTransaction_(id, u) {
  try {
    const data = {};
    if (u.tanggal) data.tanggal = getSafeTime_(u.tanggal);
    data.cabang = String(u.toko).toUpperCase();
    data.cv = String(u.cv).toUpperCase();
    data.nominal = Number(u.nominal) || 0;
    data.kategori = u.kategori || "Listrik";
    data.keterangan = u.keterangan || "-";
    
    if (u.jenis) data.jenis = String(u.jenis).toUpperCase();
    if (u.jumlah) data.jumlah = String(u.jumlah);

    let imgUrl = "-";
    const oldItem = fbRead_("/expenses/" + id);
    if (oldItem) {
      imgUrl = oldItem.fotoUrl || "-";
    }

    if (u.base64) {
      imgUrl = uploadListrikImageToDrive_(u.base64, u);
      data.fotoUrl = imgUrl;
    }
    
    if (!oldItem) throw new Error('Data tidak ditemukan.');
    const nextItem = Object.assign({}, oldItem, data, { id:id });
    legacyApplyAtomicMutation_({ ['expenses/' + id]:nextItem }, [
      { dataset:'expenses', before:oldItem, after:nextItem }
    ]);
    invalidateDataCache_();
    
    return { 
      id: id, 
      tanggal: data.tanggal || getSafeTime_(u.tanggal), 
      toko: data.cabang, 
      cv: data.cv, 
      nominal: data.nominal, 
      url: imgUrl, 
      kategori: data.kategori, 
      keterangan: data.keterangan 
    };
  } catch (e) {
    throw new Error("Gagal mengupdate pengeluaran di Firebase: " + e.message);
  }
}

function deleteListrikTransaction_(id) {
  try {
    const item = fbRead_("/expenses/" + id);
    if (!item) throw new Error("Data tidak ditemukan.");
    
    const imgUrl = item.fotoUrl;
    
    legacyApplyAtomicMutation_({ ['expenses/' + id]:null }, [
      { dataset:'expenses', before:item, after:null }
    ]);
    invalidateDataCache_();
    
    // Hapus file dari Drive jika tidak dipakai lagi di baris lain
    if (imgUrl && imgUrl !== "-" && imgUrl.includes("drive.google.com")) {
      const isUsed = legacyPhotoStillUsed_(imgUrl);

      if (!isUsed) {
         try {
            const fileId = extractDriveFileId_(imgUrl);
            if (fileId) legacySchedulePhotoReview_(imgUrl);
         } catch(e) {}
      }
    }
    return true;
  } catch (e) {
    throw new Error("Gagal menghapus pengeluaran di Firebase: " + e.message);
  }
}

function bulkDeleteListrikTransaction_(ids) {
  try {
    let deletedCount = 0;
    const imgUrlsToDelete = [];
    const expData = fbRead_("/expenses") || {};
    const primaryUpdates = {};
    const indexMutations = [];
    
    for (const id of ids) {
      if (expData[id]) {
        const imgUrl = expData[id].fotoUrl;
        primaryUpdates['expenses/' + id] = null;
        indexMutations.push({ dataset:'expenses', before:expData[id], after:null });
        
        if (imgUrl && imgUrl !== "-" && imgUrl.includes("drive.google.com")) {
          imgUrlsToDelete.push(imgUrl);
        }
        delete expData[id];
        deletedCount++;
      }
    }
    if (deletedCount) legacyApplyAtomicMutation_(primaryUpdates, indexMutations);
    
    // Physical deletion is reviewed separately: another receipt can acquire a reference concurrently.
    Array.from(new Set(imgUrlsToDelete)).forEach(legacySchedulePhotoReview_);
    
    invalidateDataCache_();
    return deletedCount;
  } catch (e) {
    throw new Error("Gagal menghapus pengeluaran massal di Firebase: " + e.message);
  }
}

/**
 * /**
 * FUNGSI DUPLIKASI/POSTING DATA DARI OCR KE LISTRIK/UMUM
 */
function duplicateToKategori_(historyId, targetKategori) {
  try {
    const item = fbRead_("/ocr_history/" + historyId);
    if (!item) throw new Error("Data OCR tidak ditemukan.");
    if (item.statusPosting && item.statusPosting !== "") {
      throw new Error("Data ini sudah pernah diposting ke " + item.statusPosting);
    }

    const now = new Date();
    const prefix = targetKategori === "Umum" ? "UMM-" : "LST-";
    const newId = prefix + mutationUuid_();

    const autoKeterangan = String(item.name) + (item.qty > 1 ? ` (${item.qty} ${item.unit})` : "");
    const jenisValue = targetKategori === "Umum" ? String(item.name).toUpperCase() : "LISTRIK";
    const jumlahValue = targetKategori === "Umum" ? (item.qty + " " + String(item.unit || "PCS").toUpperCase()) : "-";

    const expenseObj = {
      id: newId,
      timestamp: now.getTime(),
      tanggal: item.tanggalNota, // Tanggal nota
      cabang: item.cabang,
      cv: item.cv,
      nominal: item.total,
      fotoUrl: item.fotoUrl,
      kategori: targetKategori,
      keterangan: targetKategori === "Umum" ? autoKeterangan : "-",
      noUrut: "",
      jenis: jenisValue,
      jumlah: jumlahValue
    };

    const nextHistory = Object.assign({}, item, { id:historyId, statusPosting:targetKategori });
    legacyApplyAtomicMutation_({
      ['expenses/' + newId]:expenseObj,
      ['ocr_history/' + historyId]:nextHistory
    }, [
      { dataset:'expenses', before:null, after:expenseObj },
      { dataset:'ocr_history', before:item, after:nextHistory }
    ]);
    invalidateDataCache_();

    return targetKategori;
  } catch (e) {
    throw new Error("Gagal memposting data: " + e.message);
  }
}

/**
 * ==========================================
 * MODUL TARIK DATA EXTERNAL
 * ==========================================
 */
function resolveLegacySpreadsheetLink_(payload) {
  payload = payload || {};
  let month = String(payload.bulan || '').replace(/\D/g, '');
  let year = String(payload.tahun || '').replace(/\D/g, '');
  const periodParts = String(payload.periode || '').split(/[-/]/);
  if ((!month || !year) && periodParts.length >= 2) {
    month = String(periodParts[0] || '').replace(/\D/g, '');
    year = String(periodParts[1] || '').replace(/\D/g, '');
  }
  const period = portalValidatePeriod_(year + String(Number(month || 0)).padStart(2, '0'));
  const requestedUrl = portalValidateSpreadsheetUrl_(payload.link || '');
  const links = fbRead_('/config/spreadsheetLinks/' + period) || {};
  const matchedBranchId = Object.keys(links).filter(function(branchId) {
    const entry = links[branchId] || {};
    try { return portalValidateSpreadsheetUrl_(entry.url || entry.spreadsheetUrl || '') === requestedUrl; }
    catch (error) { return false; }
  })[0];
  if (!matchedBranchId) throw new Error('Spreadsheet tidak terdaftar pada Master Link untuk periode yang dipilih.');
  const requestedBranch = portalUpper_(payload.branchId || payload.cabang || '');
  if (requestedBranch) {
    const branch = fbRead_('/config/branches/' + matchedBranchId) || {};
    const allowedNames = [portalUpper_(matchedBranchId), portalUpper_(branch.name || branch.nama || ''), portalUpper_((links[matchedBranchId] || {}).branchName || '')];
    if (allowedNames.indexOf(requestedBranch) === -1 && String(payload.tipe || '') !== 'Central Kitchen') {
      throw new Error('Cabang tidak cocok dengan Master Link yang dipilih.');
    }
  }
  return requestedUrl;
}

function legacyTarikPeriod_(payload) {
  const year = String(payload && payload.tahun || '').trim();
  const monthNumber = Number(payload && payload.bulan || 0);
  const month = String(monthNumber).padStart(2, '0');
  if (!/^\d{4}$/.test(year) || monthNumber < 1 || monthNumber > 12) return '';
  return year + month;
}

function legacyTarikExpenseRows_(period) {
  if (period && legacyIndexReadsEnabled_() && legacyIndexMarkerUsable_('expenses')) {
    return legacyReadIndexBundle_('expenses', period, ['UMUM'], 0, false).rows;
  }
  const fbData = fbRead_("/expenses") || {};
  return Object.keys(fbData).map(function(key) {
    return expenseObjectToArray_(fbData[key]);
  }).filter(function(row) {
    if (String(row[7] || '').trim().toUpperCase() !== 'UMUM') return false;
    const timestamp = Number(row[2]) || new Date(row[2]).getTime() || 0;
    return !period || Utilities.formatDate(new Date(timestamp), Session.getScriptTimeZone(), 'yyyyMM') === period;
  });
}

function legacyTarikPhotoMatchKey_(tanggal, cabang, nominal, keterangan, jenis, jumlah) {
  return JSON.stringify([
    String(tanggal || '').trim(),
    String(cabang || '').trim().toUpperCase(),
    Number(nominal) || 0,
    String(keterangan || '').trim(),
    String(jenis || '').trim(),
    String(jumlah || '').trim()
  ]);
}

function legacyTarikParseRowDate_(value, payload) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const numericDate = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(raw);
  if (numericDate) {
    const yearFirst = numericDate[1].length === 4;
    const year = Number(yearFirst ? numericDate[1] : numericDate[3]);
    const month = Number(numericDate[2]);
    const day = Number(yearFirst ? numericDate[3] : numericDate[1]);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day) return parsed;
  }
  if (/\d{4}/.test(raw)) {
    const parsedWithYear = new Date(raw);
    if (!isNaN(parsedWithYear.getTime())) return parsedWithYear;
  }
  const dayMatch = raw.match(/\d{1,2}/);
  const selectedMonth = Number(payload && payload.bulan || 0);
  const selectedYear = Number(payload && payload.tahun || 0);
  if (!dayMatch || selectedMonth < 1 || selectedMonth > 12 || selectedYear < 1900) return null;
  const day = Number(dayMatch[0]);
  const parsed = new Date(selectedYear, selectedMonth - 1, day);
  return parsed.getDate() === day ? parsed : null;
}

function fetchExternalData_(payload) { return tarikFetchSafe_(payload || {}); }

function getOrCreateFolder_(parent, folderName) {
  const folders = parent.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(folderName);
}

function safeNum_(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return val;
  let str = String(val).trim();
  let isPct = false;
  if (str.includes("%")) {
    isPct = true;
    str = str.replace("%", "").trim();
  }
  // If it contains comma and not dot, it's likely Indonesian decimal. Replace comma with dot.
  if (str.includes(",") && !str.includes(".")) {
    str = str.replace(",", ".");
  } else if (str.includes(",") && str.includes(".")) {
    // Contains both, e.g. 1.250,50 -> replace dot with nothing, comma with dot
    str = str.replace(/\./g, "").replace(",", ".");
  }
  let num = parseFloat(str);
  if (isNaN(num)) return 0;
  return isPct ? num / 100 : num;
}

function readCentralKitchenSummary_(sheet) {
  try {
    const summaryRows = sheet.getRange(5, 11, Math.max(1, sheet.getLastRow() - 4), 11).getValues();
    const values = Array.from({ length:4 }, function() { return []; }).concat(summaryRows.map(function(row) { return Array(10).fill('').concat(row); }));
    const branchSummaries = [];
    
    // Table starts at row 5 (index 4), columns K to U (indices 10 to 20)
    for (let i = 4; i < values.length; i += 2) {
      if (i + 1 >= values.length) break;
      
      const rowTop = values[i];
      const rowBottom = values[i + 1];
      
      const cabang = String(rowTop[10]).trim();
      if (!cabang || cabang === "NAMA CABANG" || cabang === "CONTROL PERSENTASE") {
        continue;
      }
      
      const targetData = {
        bahanBaku: safeNum_(rowTop[11]),
        telur: safeNum_(rowTop[12]),
        airGalon: safeNum_(rowTop[13]),
        gas: safeNum_(rowTop[14]),
        bahanKemas: safeNum_(rowTop[15]),
        lainLain: safeNum_(rowTop[16]),
        operasionalToko: safeNum_(rowTop[17]),
        totalPct: safeNum_(rowTop[18]),
        nominalTotal: safeNum_(rowTop[19])
      };
      
      const realData = {
        bahanBaku: safeNum_(rowBottom[11]),
        telur: safeNum_(rowBottom[12]),
        airGalon: safeNum_(rowBottom[13]),
        gas: safeNum_(rowBottom[14]),
        bahanKemas: safeNum_(rowBottom[15]),
        lainLain: safeNum_(rowBottom[16]),
        operasionalToko: safeNum_(rowBottom[17]),
        totalPct: safeNum_(rowBottom[18]),
        nominalTotal: safeNum_(rowBottom[19])
      };
      
      const selisih = safeNum_(rowTop[20]); // Column U (index 20) is merged
      
      branchSummaries.push({
        cabang: cabang.toUpperCase(),
        target: targetData,
        real: realData,
        selisih: selisih
      });
    }
    
    return branchSummaries;
  } catch (e) {
    console.error("Error reading CK summary: " + e.message);
    return null;
  }
}

function submitTarikDataBatch_(payload) { return tarikSubmitSafe_(payload || {}); }

function getMandiriSummaryHelper_(ssExternal) {
  const sheetRP = ssExternal.getSheetByName("REKAP PENGELUARAN");
  if (!sheetRP) return null;
  const lastRow = sheetRP.getLastRow();
  if (lastRow < 43) return null;
  const rpValues = lastRow >= 48 ? sheetRP.getRange(40, 1, 9, 20).getValues() : sheetRP.getRange(40, 1, 4, 20).getValues();
  if (lastRow >= 48) {
    const row42 = rpValues[2];
    const row43 = rpValues[3];
    const row48 = rpValues[8];
    
    const b48 = safeNum_(row48[1]);
    const t42 = safeNum_(row42[19]);
    const t43 = safeNum_(row43[19]);
    
    return {
      nominal: {
        totalReal: b48 * t42,
        totalTarget: b48 * t43
      },
      categories: {
        bahanBaku: { real: safeNum_(row42[3]), target: safeNum_(row43[3]) },
        telur: { real: safeNum_(row42[5]), target: safeNum_(row43[5]) },
        airGalon: { real: safeNum_(row42[7]), target: safeNum_(row43[7]) },
        gas: { real: safeNum_(row42[9]), target: safeNum_(row43[9]) },
        bahanKemas: { real: safeNum_(row42[13]), target: safeNum_(row43[13]) },
        lainLain: { real: safeNum_(row42[15]), target: safeNum_(row43[15]) },
        operasionalToko: { real: safeNum_(row42[17]), target: safeNum_(row43[17]) }
      }
    };
  } else if (lastRow >= 43) {
    const row40 = rpValues[0];
    const row42 = rpValues[2];
    const row43 = rpValues[3];
    return {
      nominal: {
        totalReal: safeNum_(row40[18]),
        totalTarget: safeNum_(row40[19])
      },
      categories: {
        bahanBaku: { real: safeNum_(row42[3]), target: safeNum_(row43[3]) },
        telur: { real: safeNum_(row42[5]), target: safeNum_(row43[5]) },
        airGalon: { real: safeNum_(row42[7]), target: safeNum_(row43[7]) },
        gas: { real: safeNum_(row42[9]), target: safeNum_(row43[9]) },
        bahanKemas: { real: safeNum_(row42[13]), target: safeNum_(row43[13]) },
        lainLain: { real: safeNum_(row42[15]), target: safeNum_(row43[15]) },
        operasionalToko: { real: safeNum_(row42[17]), target: safeNum_(row43[17]) }
      }
    };
  }
  return null;
}

function parseNominalSafe_(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return val;
  let str = String(val).trim();
  str = str.replace(/rp/gi, "").replace(/[^0-9,\-\.]/g, "").trim();
  if (str === "") return 0;
  
  if (str.includes(",") && !str.includes(".")) {
    const parts = str.split(",");
    if (parts[1].length === 3) {
      str = str.replace(/,/g, "");
    } else {
      str = str.replace(",", ".");
    }
  } else if (str.includes(".") && !str.includes(",")) {
    const parts = str.split(".");
    if (parts[1].length === 3) {
      str = str.replace(/\./g, "");
    }
  } else if (str.includes(",") && str.includes(".")) {
    if (str.indexOf(".") < str.indexOf(",")) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  }
  let num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * FUNGSI HELPER: Ekstraksi ID File Google Drive secara konsisten
 */
function extractDriveFileId_(url) {
  if (!url || url === "-" || !url.includes("drive.google.com")) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return (match && match[1]) ? match[1] : null;
}

function getLegacyPhoto_(url) {
  const fileId = extractDriveFileId_(String(url || ''));
  if (!fileId) throw new Error('ID foto tidak valid.');
  const file = DriveApp.getFileById(fileId);
  const parentId = String(PropertiesService.getScriptProperties().getProperty('FOLDER_PARENT_ID') || '');
  if (!parentId || !isDriveFileUnderFolder_(file, parentId)) throw new Error('Foto tidak berada di folder aplikasi yang diizinkan.');
  if (Number(file.getSize() || 0) > 8 * 1024 * 1024) throw new Error('Ukuran foto terlalu besar untuk ditampilkan.');
  const blob = file.getBlob();
  return {
    fileName: file.getName(),
    dataUrl: 'data:' + (blob.getContentType() || 'application/octet-stream') + ';base64,' + Utilities.base64Encode(blob.getBytes())
  };
}

function isDriveFileUnderFolder_(file, allowedParentId) {
  let frontier = [];
  const initialParents = file.getParents();
  while (initialParents.hasNext()) frontier.push(initialParents.next());
  const visited = {};
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const next = [];
    for (let index = 0; index < frontier.length; index++) {
      const folder = frontier[index];
      const id = folder.getId();
      if (id === allowedParentId) return true;
      if (visited[id]) continue;
      visited[id] = true;
      const parents = folder.getParents();
      while (parents.hasNext()) next.push(parents.next());
    }
    frontier = next;
  }
  return false;
}

/**
 * FUNGSI BACKEND: Reset Data Tarik secara Batch (Real-time)
 */
function resetTarikDataBatch_(payload) {
  if (!Array.isArray(payload.deletedItems)) throw new Error('Muat ulang sebelum reset: daftar identitas baris belum tersedia.');
  return tarikSubmitSafe_(Object.assign({}, payload, { newItems:[], editedItems:[], photoItemsExisting:[] }));
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function legacySchedulePhotoReview_(url) {
  const fileId = extractDriveFileId_(url);
  if (!fileId) return;
  try { fbWrite_('/photoCleanupReview/' + mutationKey_(fileId), { driveFileId:fileId, status:'REVIEW_REQUIRED', requestedAt:Date.now() }); }
  catch (error) { Logger.log('Peninjauan foto tertunda.'); }
}

function legacyPhotoRoot_(name) {
  const parentId = PropertiesService.getScriptProperties().getProperty('FOLDER_PARENT_ID');
  if (!parentId) throw new Error('Folder foto belum dikonfigurasi.');
  mutationAssertRuntimeTarget_();
  return getOrCreateFolder_(DriveApp.getFolderById(parentId), name);
}
