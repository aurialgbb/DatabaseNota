/**
 * Modul nota terpadu: kategori, OCR Toko, Bank Nota, Entry Data, dan foto.
 * Semua fungsi pada file ini private dan hanya dipanggil melalui portalApi().
 */

const PORTAL_RECEIPT_INDEX_VERSION = 2;
const PORTAL_RECEIPT_INDEX_ROOT = '/receiptIndexV1';

function portalReceiptOcrMetadata_(receipt) {
  receipt = receipt || {};
  const rawConfidence = receipt.ocrConfidence != null ? receipt.ocrConfidence : receipt.confidence;
  const confidence = rawConfidence == null || rawConfidence === ''
    ? null
    : Math.max(0, Math.min(1, portalSafeNumber_(rawConfidence)));
  const rawWarnings = Array.isArray(receipt.ocrWarnings) ? receipt.ocrWarnings : (Array.isArray(receipt.warnings) ? receipt.warnings : []);
  const warnings = rawWarnings.map(function(warning) {
    return String(warning || '').trim().slice(0, 250);
  }).filter(Boolean).slice(0, 20);
  return { ocrConfidence:confidence, ocrWarnings:warnings };
}

function portalReceiptIndexSegment_(value) {
  return portalUpper_(value || '_').replace(/[.#$\[\]\/!]+/g, '_').slice(0, 160) || '_';
}

function portalReceiptSortKey_(receipt) {
  const date = portalIsoDate_(receipt && receipt.date || new Date());
  const submittedAt = String(Math.max(0, Number(receipt && receipt.submittedAt || 0))).padStart(13, '0').slice(-13);
  return date + '!' + submittedAt + '!' + portalReceiptIndexSegment_(receipt && receipt.id || 'UNKNOWN');
}

function portalReceiptIndexSummary_(receipt) {
  receipt = receipt || {};
  const ocr = portalReceiptOcrMetadata_(receipt);
  return {
    id: String(receipt.id || ''),
    displayNumber: String(receipt.displayNumber || String(receipt.id || '').slice(-6)),
    version: Number(receipt.version || 1),
    status: portalUpper_(receipt.status || ''),
    branchId: portalUpper_(receipt.branchId || ''),
    branchName: String(receipt.branchName || ''),
    branchType: String(receipt.branchType || 'Mandiri'),
    date: String(receipt.date || ''),
    supplier: String(receipt.supplier || ''),
    grossTotal: portalSafeNumber_(receipt.grossTotal == null ? receipt.receiptTotal : receipt.grossTotal),
    discountTotal: portalSafeNumber_(receipt.discountTotal || 0),
    receiptTotal: portalSafeNumber_(receipt.receiptTotal),
    itemCount: Array.isArray(receipt.items) ? receipt.items.length : Number(receipt.itemCount || 0),
    photoId: String(receipt.photoId || ''),
    submittedAt: Number(receipt.submittedAt || 0),
    ocrConfidence: ocr.ocrConfidence,
    ocrWarnings: ocr.ocrWarnings,
    review: receipt.review || {},
    eliminated: receipt.eliminated === true
  };
}

function portalReceiptIndexPaths_(receipt) {
  const sortKey = portalReceiptSortKey_(receipt);
  const status = portalReceiptIndexSegment_(receipt.status || 'UNKNOWN');
  const branchId = portalReceiptIndexSegment_(receipt.branchId || 'UNKNOWN');
  return [
    'receiptIndexV1/all/' + sortKey,
    'receiptIndexV1/byStatus/' + status + '/' + sortKey,
    'receiptIndexV1/byBranch/' + branchId + '/' + sortKey,
    'receiptIndexV1/byStatusBranch/' + status + '/' + branchId + '/' + sortKey
  ];
}

function portalReceiptCountPath_(receipt) {
  return 'receiptIndexV1/counts/byBranch/' + portalReceiptIndexSegment_(receipt.branchId || 'UNKNOWN') + '/' + portalReceiptIndexSegment_(receipt.status || 'UNKNOWN');
}

function portalAddCountDelta_(deltas, path, amount) {
  if (!path || !amount) return;
  deltas[path] = Number(deltas[path] || 0) + Number(amount);
}

function portalAddReceiptIndexMutation_(updates, previous, next, countDeltas) {
  countDeltas = countDeltas || {};
  const expectedRecord = previous || next;
  if (expectedRecord) mutationAttachExpected_(updates, 'receipts/' + expectedRecord.id, previous);
  if (previous) {
    portalReceiptIndexPaths_(previous).forEach(function(path) { updates[path] = null; });
  }
  if (next) {
    const summary = portalReceiptIndexSummary_(next);
    portalReceiptIndexPaths_(next).forEach(function(path) { updates[path] = summary; });
  }
  if (previous && previous.photoId && (!next || next.photoId !== previous.photoId)) updates['photoReceiptRefsV2/' + previous.photoId + '/' + previous.id] = null;
  if (next && next.photoId) updates['photoReceiptRefsV2/' + next.photoId + '/' + next.id] = true;
  const previousCountPath = previous ? portalReceiptCountPath_(previous) : '';
  const nextCountPath = next ? portalReceiptCountPath_(next) : '';
  if (previousCountPath !== nextCountPath) {
    portalAddCountDelta_(countDeltas, previousCountPath, -1);
    portalAddCountDelta_(countDeltas, nextCountPath, 1);
  }
  return countDeltas;
}

function portalApplyCountDeltas_(updates, countDeltas) {
  Object.keys(countDeltas || {}).forEach(function(path) {
    const delta = Number(countDeltas[path] || 0);
    if (delta) updates[path] = { '.sv': { increment:delta } };
  });
}

function portalBuildReceiptIndexRoot_(receipts) {
  const root = {
    meta: { version:PORTAL_RECEIPT_INDEX_VERSION, rebuiltAt:portalNow_(), receiptCount:0, validated:false },
    all: {}, byStatus: {}, byBranch: {}, byStatusBranch: {}, counts: { byBranch:{} }
  };
  Object.keys(receipts || {}).forEach(function(receiptId) {
    const receipt = receipts[receiptId];
    if (!receipt) return;
    if (!receipt.id) receipt.id = receiptId;
    const key = portalReceiptSortKey_(receipt);
    const status = portalReceiptIndexSegment_(receipt.status || 'UNKNOWN');
    const branchId = portalReceiptIndexSegment_(receipt.branchId || 'UNKNOWN');
    const summary = portalReceiptIndexSummary_(receipt);
    root.all[key] = summary;
    if (!root.byStatus[status]) root.byStatus[status] = {};
    if (!root.byBranch[branchId]) root.byBranch[branchId] = {};
    if (!root.byStatusBranch[status]) root.byStatusBranch[status] = {};
    if (!root.byStatusBranch[status][branchId]) root.byStatusBranch[status][branchId] = {};
    root.byStatus[status][key] = summary;
    root.byBranch[branchId][key] = summary;
    root.byStatusBranch[status][branchId][key] = summary;
    if (!root.counts.byBranch[branchId]) root.counts.byBranch[branchId] = {};
    root.counts.byBranch[branchId][status] = Number(root.counts.byBranch[branchId][status] || 0) + 1;
    root.meta.receiptCount += 1;
  });
  return root;
}

function portalReceiptIndexIdentity_(receipt) {
  receipt = receipt || {};
  return [
    String(receipt.id || ''),
    portalUpper_(receipt.status || ''),
    portalUpper_(receipt.branchId || ''),
    String(receipt.date || '')
  ].join('|');
}

function portalValidateReceiptIndexV1_() {
  const receipts = fbRead_('/receipts') || {};
  const indexed = fbRead_(PORTAL_RECEIPT_INDEX_ROOT + '/all') || {};
  const expectedById = {};
  const actualById = {};
  Object.keys(receipts).forEach(function(receiptId) {
    const receipt = receipts[receiptId];
    if (!receipt) return;
    const normalized = Object.assign({}, receipt, { id:String(receipt.id || receiptId) });
    expectedById[normalized.id] = portalReceiptIndexIdentity_(normalized);
  });
  Object.keys(indexed).forEach(function(sortKey) {
    const summary = indexed[sortKey];
    if (summary && summary.id) actualById[String(summary.id)] = portalReceiptIndexIdentity_(summary);
  });
  const mismatches = [];
  Object.keys(expectedById).forEach(function(receiptId) {
    if (actualById[receiptId] !== expectedById[receiptId] && mismatches.length < 25) mismatches.push(receiptId);
  });
  Object.keys(actualById).forEach(function(receiptId) {
    if (!expectedById[receiptId] && mismatches.length < 25) mismatches.push(receiptId);
  });
  return {
    valid:mismatches.length === 0 && Object.keys(expectedById).length === Object.keys(actualById).length,
    receiptCount:Object.keys(expectedById).length,
    indexCount:Object.keys(actualById).length,
    mismatches:mismatches
  };
}

function portalReceiptIndexMarkerUsable_(marker) {
  // Version 2 only adds optional summary fields. A validated v1 index has the
  // same query topology, so it remains safe to read and can be upgraded later
  // through the explicit ADMIN reconciliation action. Avoid rebuilding the
  // complete index synchronously merely because a reader opens Bank Nota.
  return Boolean(marker && Number(marker.version) >= 1 && marker.validated === true);
}

function portalEnsureReceiptIndexV1_(force) {
  const marker = force ? null : fbRead_(PORTAL_RECEIPT_INDEX_ROOT + '/meta');
  if (!force && portalReceiptIndexMarkerUsable_(marker)) return marker;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const current = force ? null : fbRead_(PORTAL_RECEIPT_INDEX_ROOT + '/meta');
    if (!force && portalReceiptIndexMarkerUsable_(current)) return current;
    const receipts = fbRead_('/receipts') || {};
    const root = portalBuildReceiptIndexRoot_(receipts);
    fbWrite_(PORTAL_RECEIPT_INDEX_ROOT, root);
    const validation = portalValidateReceiptIndexV1_();
    const validatedMeta = Object.assign({}, root.meta, {
      validated:validation.valid,
      validatedAt:portalNow_(),
      receiptCount:validation.receiptCount,
      indexCount:validation.indexCount,
      mismatchCount:validation.mismatches.length
    });
    fbUpdate_(PORTAL_RECEIPT_INDEX_ROOT + '/meta', validatedMeta);
    if (!validation.valid) throw new Error('Rekonsiliasi indeks nota gagal: ' + validation.mismatches.join(', '));
    return validatedMeta;
  } finally {
    lock.releaseLock();
  }
}

function portalRebuildReceiptIndexV1_(session) {
  mutationAssertIsolatedDev_();
  if (!session || session.role !== 'ADMIN') throw new Error('Hanya ADMIN yang dapat merekonsiliasi indeks.');
  const marker = portalEnsureReceiptIndexV1_(true);
  portalAudit_('REBUILD_RECEIPT_INDEX_V1', session.uid, marker);
  return { success:true, marker:marker };
}

function portalReceiptIndexPathForQuery_(status, branchId) {
  status = portalUpper_(status || 'ALL');
  branchId = portalUpper_(branchId || '');
  if (status !== 'ALL' && branchId) return PORTAL_RECEIPT_INDEX_ROOT + '/byStatusBranch/' + portalReceiptIndexSegment_(status) + '/' + portalReceiptIndexSegment_(branchId);
  if (status !== 'ALL') return PORTAL_RECEIPT_INDEX_ROOT + '/byStatus/' + portalReceiptIndexSegment_(status);
  if (branchId) return PORTAL_RECEIPT_INDEX_ROOT + '/byBranch/' + portalReceiptIndexSegment_(branchId);
  return PORTAL_RECEIPT_INDEX_ROOT + '/all';
}

function portalQueryReceiptIndex_(options) {
  options = options || {};
  portalEnsureReceiptIndexV1_(false);
  const limit = Math.min(100, Math.max(1, Number(options.limit || PORTAL_DEFAULT_PAGE_SIZE)));
  const cursor = String(options.cursor || '');
  const dateFrom = String(options.dateFrom || '');
  const dateTo = String(options.dateTo || '');
  const startKey = dateFrom ? portalIsoDate_(dateFrom) + '!' : '';
  const dateEndKey = dateTo ? portalIsoDate_(dateTo) + '!\uf8ff' : '\uf8ff';
  const endKey = cursor && cursor < dateEndKey ? cursor : dateEndKey;
  const data = fbReadQuery_(portalReceiptIndexPathForQuery_(options.status, options.branchId), {
    orderBy:'$key', startAt:startKey, endAt:endKey, limitToLast:limit + (cursor ? 2 : 1)
  }) || {};
  let keys = Object.keys(data).sort();
  if (cursor) keys = keys.filter(function(key) { return key !== cursor; });
  const hasNext = keys.length > limit;
  if (hasNext) keys = keys.slice(keys.length - limit);
  keys.reverse();
  const rows = keys.map(function(key) { return data[key]; }).filter(Boolean);
  return {
    rows:rows,
    nextCursor:hasNext && keys.length ? keys[keys.length - 1] : '',
    hasNext:hasNext,
    limit:limit
  };
}

const PORTAL_CATEGORY_CACHE_KEY = 'PORTAL_CATEGORIES_ACTIVE_V1';
const PORTAL_CATEGORY_CACHE_SECONDS = 120;

function portalGetCategories_(session) {
  if (session && session.devBypass === true) {
    return PORTAL_DEFAULT_CATEGORIES.map(function(name, index) {
      return {
        id: name.replace(/[^A-Z0-9]+/g, '_'),
        name: name,
        active: true,
        order: index + 1
      };
    });
  }
  const cache = CacheService.getScriptCache();
  const cached = cache.get(PORTAL_CATEGORY_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (error) {}
  }
  let categories = fbRead_('/config/categories') || {};
  if (!Object.keys(categories).length) {
    categories = {};
    PORTAL_DEFAULT_CATEGORIES.forEach(function(name, index) {
      const id = name.replace(/[^A-Z0-9]+/g, '_');
      categories[id] = { id: id, name: name, active: true, order: index + 1 };
    });
    fbWrite_('/config/categories', categories);
  }
  const active = Object.keys(categories).map(function(key) {
    return categories[key];
  }).filter(function(item) {
    return item && item.active !== false;
  }).sort(function(a, b) {
    return Number(a.order || 999) - Number(b.order || 999);
  });
  try { cache.put(PORTAL_CATEGORY_CACHE_KEY, JSON.stringify(active), PORTAL_CATEGORY_CACHE_SECONDS); } catch (error) {}
  return active;
}

function portalGetStoreDashboard_(session) {
  const counts = { PENDING: 0, APPROVED: 0, NEEDS_CORRECTION: 0, REJECTED: 0 };
  const storedCounts = fbRead_(PORTAL_RECEIPT_INDEX_ROOT + '/counts/byBranch/' + portalReceiptIndexSegment_(session.branchId)) || {};
  Object.keys(counts).forEach(function(status) {
    counts[status] = Math.max(0, Number(storedCounts[status] || 0));
  });
  const recent = portalQueryReceiptIndex_({ branchId:session.branchId, status:'ALL', limit:5 }).rows;
  return {
    branchName: session.branchName,
    counts: counts,
    recent: recent
  };
}

function portalStartStoreOcr_(session, payload) {
  const requestedCount = Number(payload.photoCount || 1);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > PORTAL_MAX_UPLOAD_IMAGES) throw new Error('Jumlah foto harus 1–' + PORTAL_MAX_UPLOAD_IMAGES + '.');
  const photoCount = requestedCount;
  const uploadId = portalFriendlyId_('UPL');
  fbWrite_('/uploads/' + uploadId, {
    id: uploadId,
    branchId: session.branchId,
    branchName: session.branchName,
    status: 'OCR_PROCESSING',
    expectedPhotos: photoCount,
    createdAt: portalNow_(),
    createdBy: session.uid,
    jobs: {},
    photoIds: {}
  });
  return { uploadId: uploadId, photoCount: photoCount };
}

function portalGetStoreUpload_(session, uploadId) {
  const upload = fbRead_('/uploads/' + String(uploadId || ''));
  if (!upload || upload.branchId !== session.branchId) throw new Error('Batch upload tidak ditemukan.');
  if (upload.status === 'SUBMITTED') throw new Error('Batch ini sudah pernah disubmit.');
  return upload;
}

function portalOcrJobKey_(value) {
  const key = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!key) throw new Error('ID foto tidak valid.');
  return key;
}

const PORTAL_OCR_WORKER_SLOTS = 8;
const PORTAL_OCR_SLOT_LEASE_MS = 150000;

function portalOcrQueueKey_(uploadId, clientPhotoId, createdAt) {
  return 'Q' + String(createdAt || portalNow_()).padStart(13, '0') + '_' + portalHash_(uploadId + '|' + clientPhotoId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

function portalOcrPendingResult_(job, queued) {
  return {
    pending:true,
    queued:Boolean(queued),
    retryAfterMs:1500 + Math.floor(Math.random() * 2500),
    clientPhotoId:String(job && job.clientPhotoId || ''),
    index:Number(job && job.index || 0),
    photoId:String(job && job.photoId || ''),
    fileName:String(job && job.fileName || '')
  };
}

function portalAcquireOcrWorkerSlot_(jobKey) {
  const now = portalNow_();
  const path = '/ocrWorkerSlots';
  const leaseKey = portalHash_(jobKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const result = fbCompareAndSet_(path, function(current) {
    const pool = current || {};
    Object.keys(pool).forEach(function(key) {
      if (Number((pool[key] || {}).expiresAt || 0) <= now) delete pool[key];
    });
    if (!pool[leaseKey] && Object.keys(pool).length >= PORTAL_OCR_WORKER_SLOTS) return { abort:true };
    pool[leaseKey] = { leaseKey:leaseKey, jobKey:jobKey, acquiredAt:now, expiresAt:now + PORTAL_OCR_SLOT_LEASE_MS };
    return { value:pool };
  }, 4);
  return result.success ? { leaseKey:leaseKey, path:path } : null;
}

function portalReleaseOcrWorkerSlot_(workerSlot, jobKey) {
  if (!workerSlot) return;
  try {
    fbCompareAndSet_(workerSlot.path, function(current) {
      const pool = current || {};
      if (!pool[workerSlot.leaseKey] || pool[workerSlot.leaseKey].jobKey !== jobKey) return { abort:true };
      delete pool[workerSlot.leaseKey];
      return { value:Object.keys(pool).length ? pool : null };
    }, 3);
  } catch (error) {}
}

function portalReadStoredPhotoImage_(photoId) {
  const photo = fbRead_('/photos/' + String(photoId || ''));
  if (!photo || !photo.driveFileId) throw new Error('Arsip foto OCR tidak ditemukan.');
  const blob = DriveApp.getFileById(photo.driveFileId).getBlob();
  return { base64:Utilities.base64Encode(blob.getBytes()), mimeType:photo.mimeType || blob.getContentType() || 'image/jpeg' };
}

function portalExecuteQueuedOcrJob_(session, uploadId, clientPhotoId, image) {
  const jobPath = '/uploads/' + uploadId + '/jobs/' + clientPhotoId;
  let job = fbRead_(jobPath);
  if (!job) throw new Error('Job OCR tidak ditemukan.');
  if ((job.status === 'DONE' || job.status === 'FAILED') && job.result) return job.result;
  if (job.status === 'PROCESSING' && portalNow_() - Number(job.startedAt || 0) < PORTAL_OCR_SLOT_LEASE_MS) return portalOcrPendingResult_(job, false);
  const jobKey = uploadId + '|' + clientPhotoId;
  const workerSlot = portalAcquireOcrWorkerSlot_(jobKey);
  if (!workerSlot) return portalOcrPendingResult_(job, true);
  const processStartedAt = portalNow_();
  let ocrMs = 0;
  let geminiDiagnostics = {};
  try {
    fbUpdate_(jobPath, { status:'PROCESSING', startedAt:processStartedAt, updatedAt:processStartedAt });
    const ocrImage = image && image.base64 ? image : portalReadStoredPhotoImage_(job.photoId);
    let result;
    try {
      const ocrStartedAt = portalNow_();
      const ocr = portalGeminiReceiptOcr_(ocrImage.base64, ocrImage.mimeType || 'image/jpeg');
      ocrMs = portalNow_() - ocrStartedAt;
      geminiDiagnostics = ocr.__portalDiagnostics || {};
      result = {
        success:true, pending:false, clientPhotoId:clientPhotoId, index:Number(job.index || 0),
        photoId:job.photoId, fileName:job.fileName,
        receipts:portalNormalizeOcrReceipts_(ocr.receipts || ocr.nota || [], job.photoId),
        warnings:Array.isArray(ocr.warnings) ? ocr.warnings : []
      };
    } catch (ocrError) {
      ocrMs = portalNow_() - processStartedAt;
      geminiDiagnostics = ocrError.__portalDiagnostics || {};
      result = {
        success:false, pending:false, clientPhotoId:clientPhotoId, index:Number(job.index || 0),
        photoId:job.photoId, fileName:job.fileName, receipts:[],
        warnings:['AI belum berhasil membaca foto ini. Foto lain dalam batch tetap diproses.'], error:ocrError.message
      };
    }
    result.diagnostics = {
      saveMs:Number(job.saveMs || 0), ocrMs:Math.max(0, ocrMs), totalMs:portalNow_() - Number(job.queuedAt || processStartedAt),
      modelUsed:geminiDiagnostics.modelUsed || '', attemptCount:Number(geminiDiagnostics.attemptCount || 0)
    };
    const updates = {};
    updates['uploads/' + uploadId + '/jobs/' + clientPhotoId] = Object.assign({}, job, {
      status:'DONE', startedAt:processStartedAt, finishedAt:portalNow_(), diagnostics:result.diagnostics, result:result
    });
    if (job.queueKey) updates['ocrQueue/' + job.queueKey] = null;
    fbUpdate_('/', updates);
    return result;
  } finally {
    portalReleaseOcrWorkerSlot_(workerSlot, jobKey);
  }
}

function portalProcessStoreOcrPhoto_(session, payload) {
  const uploadId = String(payload.uploadId || '');
  const clientPhotoId = portalOcrJobKey_(payload.clientPhotoId);
  const forceRetry = payload.forceRetry === true;
  const image = payload.image || {};
  const index = Math.max(0, Math.min(PORTAL_MAX_UPLOAD_IMAGES - 1, Number(payload.index || 0)));
  const upload = portalGetStoreUpload_(session, uploadId);
  const expectedPhotos = Math.max(1, Math.min(PORTAL_MAX_UPLOAD_IMAGES, Number(upload.expectedPhotos || 1)));
  if (index >= expectedPhotos) throw new Error('Jumlah foto melebihi batch upload yang dibuat.');
  let previous = upload.jobs && upload.jobs[clientPhotoId];
  const retryIncrement = forceRetry && previous && previous.result && previous.result.success !== true ? 1 : 0;
  if (previous && (previous.status === 'DONE' || previous.status === 'FAILED') && previous.result && !(forceRetry && previous.result.success !== true)) return previous.result;
  if (previous && previous.status === 'SAVING' && portalNow_() - Number(previous.startedAt || 0) < 60000) return portalOcrPendingResult_(previous, true);
  if (previous && previous.status === 'PROCESSING' && portalNow_() - Number(previous.startedAt || 0) < PORTAL_OCR_SLOT_LEASE_MS) return portalOcrPendingResult_(previous, false);

  const slotPath = '/uploads/' + uploadId + '/jobSlots/' + index;
  const slotReservation = fbCompareAndSet_(slotPath, function(current) {
    if (current && current !== clientPhotoId) return { abort:true, reason:'Posisi foto sudah digunakan oleh foto lain.' };
    return { value:clientPhotoId };
  }, 4);
  if (!slotReservation.success) throw new Error(slotReservation.reason || 'Posisi foto tidak dapat dipesan.');

  let photo = previous && previous.photoId ? { photoId:previous.photoId, fileName:previous.fileName } : null;
  try {
    if (!photo) {
      const saveStartedAt = portalNow_();
      const reserved = fbCompareAndSet_('/uploads/' + uploadId + '/jobs/' + clientPhotoId, function(current) {
        if (current && current.photoId) return { abort:true };
        if (current && current.status === 'SAVING' && portalNow_() - Number(current.startedAt || 0) < 60000) return { abort:true };
        return { value:{ status:'SAVING', index:index, clientPhotoId:clientPhotoId, startedAt:portalNow_(), retryCount:Number(current && current.retryCount || 0) } };
      }, 4);
      if (!reserved.success) {
        const concurrent = fbRead_('/uploads/' + uploadId + '/jobs/' + clientPhotoId);
        if (concurrent && concurrent.photoId) photo = { photoId:concurrent.photoId, fileName:concurrent.fileName };
        else return portalOcrPendingResult_(concurrent || { clientPhotoId:clientPhotoId, index:index }, true);
      }
      if (!photo) {
      photo = portalSavePhoto_(session, uploadId, image, index);
        previous = { saveMs:portalNow_() - saveStartedAt, retryCount:Number(previous && previous.retryCount || 0) };
      }
    }
    const queuedAt = Number(previous && previous.queuedAt || 0) || portalNow_();
    const queueKey = previous && previous.queueKey || portalOcrQueueKey_(uploadId, clientPhotoId, queuedAt);
    const queuedJob = {
      status:'QUEUED', index:index, clientPhotoId:clientPhotoId, photoId:photo.photoId, fileName:photo.fileName,
      queuedAt:queuedAt, queueKey:queueKey, saveMs:Number(previous && previous.saveMs || 0),
      retryCount:Number(previous && previous.retryCount || 0) + retryIncrement
    };
    const updates = {};
    updates['uploads/' + uploadId + '/jobs/' + clientPhotoId] = queuedJob;
    updates['uploads/' + uploadId + '/photoIds/' + clientPhotoId] = photo.photoId;
    updates['ocrQueue/' + queueKey] = { queueKey:queueKey, uploadId:uploadId, clientPhotoId:clientPhotoId, photoId:photo.photoId, createdAt:queuedAt, createdBy:session.uid, branchId:session.branchId };
    fbUpdate_('/', updates);
    return portalExecuteQueuedOcrJob_(session, uploadId, clientPhotoId, image);
  } catch (error) {
    const failed = {
      success: false, pending: false, clientPhotoId: clientPhotoId, index: index,
      photoId: photo && photo.photoId || '', fileName: photo && photo.fileName || String(image.name || ('Foto ' + (index + 1))),
      receipts: [], warnings: ['Foto gagal diproses, tetapi foto lain dalam batch tetap dilanjutkan.'], error: error.message
    };
    const failedUpdates = {};
    failedUpdates['uploads/' + uploadId + '/jobs/' + clientPhotoId] = {
      status:'FAILED', index:index, clientPhotoId:clientPhotoId, photoId:failed.photoId, fileName:failed.fileName,
      finishedAt:portalNow_(), retryCount:Number(previous && previous.retryCount || 0) + retryIncrement, result:failed
    };
    if (previous && previous.queueKey) failedUpdates['ocrQueue/' + previous.queueKey] = null;
    fbUpdate_('/', failedUpdates);
    return failed;
  }
}

function portalGetStoreOcrStatus_(session, payload) {
  const upload = portalGetStoreUpload_(session, String(payload.uploadId || ''));
  return { uploadId: upload.id, status: upload.status, expectedPhotos: Number(upload.expectedPhotos || 0), jobs: upload.jobs || {} };
}

function portalFinalizeStoreOcr_(session, payload) {
  const uploadId = String(payload.uploadId || '');
  const upload = portalGetStoreUpload_(session, uploadId);
  const jobs = upload.jobs || {};
  const results = Object.keys(jobs).map(function(key) { return jobs[key]; })
    .filter(function(job) { return job && job.result; })
    .sort(function(a, b) { return Number(a.index || 0) - Number(b.index || 0); })
    .map(function(job) { return job.result; });
  fbUpdate_('/uploads/' + uploadId, { status: 'READY_TO_SUBMIT', ocrResults: results, updatedAt: portalNow_() });
  portalAudit_('STORE_OCR', session.uid, { uploadId: uploadId, photoCount: results.length });
  return { uploadId: uploadId, photos: results };
}

function portalProcessStoreOcr_(session, payload) {
  const images = Array.isArray(payload.images) ? payload.images.slice(0, PORTAL_MAX_UPLOAD_IMAGES) : [];
  if (!images.length) throw new Error('Pilih minimal satu foto nota.');
  const uploadId = portalFriendlyId_('UPL');
  const createdAt = portalNow_();
  const upload = {
    id: uploadId,
    branchId: session.branchId,
    branchName: session.branchName,
    status: 'OCR_PROCESSING',
    createdAt: createdAt,
    createdBy: session.uid,
    photos: []
  };
  fbWrite_('/uploads/' + uploadId, upload);

  const results = [];
  images.forEach(function(image, index) {
    const photo = portalSavePhoto_(session, uploadId, image, index);
    upload.photos.push(photo.photoId);
    fbUpdate_('/uploads/' + uploadId, { photos: upload.photos });
    try {
      const ocr = portalGeminiReceiptOcr_(image.base64, image.mimeType || 'image/jpeg');
      results.push({
        photoId: photo.photoId,
        fileName: photo.fileName,
        receipts: portalNormalizeOcrReceipts_(ocr.receipts || ocr.nota || [], photo.photoId),
        warnings: Array.isArray(ocr.warnings) ? ocr.warnings : []
      });
    } catch (error) {
      results.push({
        photoId: photo.photoId,
        fileName: photo.fileName,
        receipts: [],
        warnings: ['AI belum berhasil membaca foto ini. Anda dapat mencoba lagi atau mengisi manual.'],
        error: error.message
      });
    }
  });

  fbUpdate_('/uploads/' + uploadId, {
    status: 'READY_TO_SUBMIT',
    ocrResults: results,
    updatedAt: portalNow_()
  });
  portalAudit_('STORE_OCR', session.uid, { uploadId: uploadId, photoCount: images.length });
  return { uploadId: uploadId, photos: results };
}

function portalSavePhoto_(session, uploadId, image, index) {
  const base64 = String(image.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) throw new Error('Data foto kosong.');
  let bytes;
  try { bytes = Utilities.base64Decode(base64); } catch (error) { throw new Error('Encoding foto tidak valid.'); }
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Ukuran satu foto maksimal 10 MB.');
  const props = PropertiesService.getScriptProperties();
  const parentId = props.getProperty('FOLDER_PARENT_ID');
  if (!parentId) throw new Error('FOLDER_PARENT_ID belum diisi.');
  const root = DriveApp.getFolderById(parentId);
  const periodFolder = getOrCreateFolder_(root, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM'));
  const branchFolder = getOrCreateFolder_(periodFolder, portalUpper_(session.branchName || session.branchId));
  const uploadFolder = getOrCreateFolder_(branchFolder, uploadId);
  const mimeType = String(image.mimeType || 'image/jpeg');
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mimeType) === -1) throw new Error('Format foto harus JPEG, PNG, atau WEBP.');
  const extension = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
  const safeOriginal = String(image.name || ('Foto_' + (index + 1))).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const fileName = (index + 1) + '_' + safeOriginal.replace(/\.(jpg|jpeg|png|webp)$/i, '') + '.' + extension;
  const file = uploadFolder.createFile(Utilities.newBlob(bytes, mimeType, fileName));
  let thumbnailFileId = '';
  let thumbnailSize = 0;
  const thumbnailBase64 = String(image.thumbnailBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (thumbnailBase64) {
    try {
      const thumbnailBytes = Utilities.base64Decode(thumbnailBase64);
      if (thumbnailBytes.length <= 120 * 1024) {
        const thumbnailName = 'thumb_' + fileName.replace(/\.(png|webp)$/i, '.jpg');
        const thumbnailFile = uploadFolder.createFile(Utilities.newBlob(thumbnailBytes, 'image/jpeg', thumbnailName));
        thumbnailFileId = thumbnailFile.getId();
        thumbnailSize = thumbnailBytes.length;
      }
    } catch (thumbnailError) {}
  }
  const photoId = portalFriendlyId_('PHT');
  const metadata = {
    id: photoId,
    uploadId: uploadId,
    branchId: session.branchId,
    driveFileId: file.getId(),
    fileName: fileName,
    mimeType: mimeType,
    size: bytes.length,
    thumbnailDriveFileId: thumbnailFileId,
    thumbnailMimeType: thumbnailFileId ? 'image/jpeg' : '',
    thumbnailSize: thumbnailSize,
    createdAt: portalNow_(),
    createdBy: session.uid
  };
  fbWrite_('/photos/' + photoId, metadata);
  return { photoId: photoId, fileName: fileName, hasThumbnail:Boolean(thumbnailFileId) };
}

function portalGeminiReceiptOcr_(base64, mimeType) {
  const ocrStartedAt = portalNow_();
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY belum diisi.');
  const categories = portalGetCategories_().map(function(item) { return item.name; });
  const prompt = [
    'Anda membaca foto bukti transaksi untuk pembukuan toko Indonesia.',
    'Satu foto dapat berisi lebih dari satu nota. Pisahkan setiap nota secara teliti.',
    'Pisahkan barang/jasa dari penyesuaian harga. DISKON, DISCOUNT, DISC, POTONGAN, PROMO, atau VOUCHER bukan item barang.',
    'Diskon harus masuk ke adjustments sebagai angka positif. Jangan masukkan diskon sebagai item negatif.',
    'Jika diskon jelas merujuk satu item, gunakan targetType ITEM dan isi targetHint dengan nama item. Jika diskon berlaku untuk seluruh nota, gunakan targetType RECEIPT.',
    'CASHBACK jangan dianggap diskon kecuali benar-benar mengurangi grand total yang dibayar pada nota.',
    'Pajak, service charge, dan ongkir yang menambah total tetap dipertahankan sebagai item/biaya positif.',
    'Dalam setiap nota, pertahankan setiap baris barang/jasa yang tercetak sebagai item terpisah.',
    'Pilih category hanya dari daftar: ' + categories.join(', ') + '.',
    'Jika ragu gunakan LAIN-LAIN. Jangan mengarang teks atau nominal yang tidak terbaca.',
    'Kembalikan JSON murni dengan bentuk:',
    '{"receipts":[{"supplier":"","date":"YYYY-MM-DD atau kosong","items":[{"description":"","category":"","quantity":1,"unit":"","amount":0}],"adjustments":[{"type":"DISCOUNT","description":"","amount":0,"targetType":"ITEM atau RECEIPT","targetHint":""}],"receiptTotal":0,"confidence":0,"warnings":[]}],"warnings":[]}',
    'amount item adalah total harga kotor baris item sebelum diskon, bukan harga satuan. amount adjustment selalu positif. confidence bernilai 0 sampai 1.'
  ].join('\n');

  let lastError = null;
  let actualAttempts = 0;
  let lastModel = PORTAL_GEMINI_PRIMARY;
  for (let attempt = 1; attempt <= PORTAL_GEMINI_MAX_ATTEMPTS; attempt++) {
    const model = attempt === PORTAL_GEMINI_MAX_ATTEMPTS ? PORTAL_GEMINI_FALLBACK : PORTAL_GEMINI_PRIMARY;
    actualAttempts = attempt;
    lastModel = model;
    try {
      const response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType, data: base64 } }
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 8192
          }
        }),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const text = response.getContentText();
      if (code === 429 || code >= 500) throw new Error('RETRYABLE_HTTP_' + code);
      if (code !== 200) throw new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 300));
      const json = JSON.parse(text);
      const output = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts
        ? json.candidates[0].content.parts.map(function(part) { return part.text || ''; }).join('')
        : '';
      if (!output) throw new Error('RETRYABLE_OUTPUT_EMPTY');
      let parsed;
      try { parsed = JSON.parse(output.replace(/```json/gi, '').replace(/```/g, '').trim()); }
      catch (parseError) { throw new Error('RETRYABLE_OUTPUT_JSON'); }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.receipts)) throw new Error('RETRYABLE_OUTPUT_SCHEMA');
      parsed.__portalDiagnostics = {
        modelUsed: model,
        attemptCount: attempt,
        durationMs: portalNow_() - ocrStartedAt
      };
      return parsed;
    } catch (error) {
      lastError = error;
      const retryable = /RETRYABLE_HTTP_|RETRYABLE_OUTPUT_|timed out|timeout|Service invoked too many times/i.test(error.message || '');
      if (!retryable || attempt >= PORTAL_GEMINI_MAX_ATTEMPTS) break;
      Utilities.sleep(attempt === 1 ? 2000 : 5000);
    }
  }
  const failure = new Error(lastError ? lastError.message : 'OCR gagal setelah dua percobaan.');
  failure.ocrStartedAt = ocrStartedAt;
  failure.__portalDiagnostics = {
    modelUsed: lastModel,
    attemptCount: actualAttempts,
    durationMs: portalNow_() - ocrStartedAt
  };
  throw failure;
}

function portalDiscountText_(value) {
  return portalUpper_(value || '').replace(/[^A-Z0-9]+/g, ' ').trim();
}

function portalIsDiscountLine_(item) {
  const text = portalDiscountText_(item && (item.description || item.name || item.label) || '');
  if (!text || /\bCASHBACK\b/.test(text)) return false;
  return /(^|\s)(DISKON|DISCOUNT|DISC|POTONGAN|PROMO|VOUCHER)(\s|$)/.test(text);
}

function portalNormalizeDiscountAdjustment_(adjustment) {
  adjustment = adjustment || {};
  const type = portalUpper_(adjustment.type || 'DISCOUNT');
  if (type !== 'DISCOUNT') return null;
  const amount = Math.abs(Math.round(portalSafeNumber_(adjustment.amount || adjustment.total || adjustment.value || 0)));
  if (!amount) return null;
  const targetHint = String(adjustment.targetHint || adjustment.target || adjustment.item || '').trim();
  let targetType = portalUpper_(adjustment.targetType || (targetHint ? 'ITEM' : 'RECEIPT'));
  if (targetType !== 'ITEM') targetType = 'RECEIPT';
  const targetItemIndex = adjustment.targetItemIndex == null || adjustment.targetItemIndex === '' ? null : Number(adjustment.targetItemIndex);
  return {
    type:'DISCOUNT',
    description:String(adjustment.description || adjustment.name || 'DISKON').trim() || 'DISKON',
    amount:amount,
    targetType:targetType,
    targetHint:targetHint,
    targetItemIndex:Number.isInteger(targetItemIndex) && targetItemIndex >= 0 ? targetItemIndex : null
  };
}

function portalAllocateReceiptDiscounts_(sourceItems, sourceAdjustments) {
  const items = (Array.isArray(sourceItems) ? sourceItems : []).map(function(item) {
    const explicitGross = item && item.grossAmount != null && item.grossAmount !== '' ? item.grossAmount : item && item.amount;
    const grossAmount = Math.max(0, Math.round(portalSafeNumber_(explicitGross || 0)));
    return Object.assign({}, item || {}, { grossAmount:grossAmount, discountAllocated:0, amount:grossAmount });
  });
  const adjustments = (Array.isArray(sourceAdjustments) ? sourceAdjustments : []).map(portalNormalizeDiscountAdjustment_).filter(Boolean);
  const warnings = [];
  const general = [];
  let valid = true;

  adjustments.forEach(function(adjustment) {
    let targetIndex = Number.isInteger(adjustment.targetItemIndex) ? adjustment.targetItemIndex : -1;
    if (targetIndex < 0 && adjustment.targetType === 'ITEM' && adjustment.targetHint) {
      const hint = portalDiscountText_(adjustment.targetHint);
      const matches = [];
      items.forEach(function(item, index) {
        const description = portalDiscountText_(item.description || item.name || '');
        if (description && hint && (description.indexOf(hint) !== -1 || hint.indexOf(description) !== -1)) matches.push(index);
      });
      if (matches.length === 1) targetIndex = matches[0];
    }
    if (adjustment.targetType === 'ITEM' && targetIndex >= 0 && items[targetIndex]) {
      const available = Math.max(0, items[targetIndex].grossAmount - items[targetIndex].discountAllocated);
      if (adjustment.amount > available) {
        valid = false;
        warnings.push('Diskon ' + adjustment.description + ' melebihi nominal item ' + (items[targetIndex].description || (targetIndex + 1)) + '.');
      }
      items[targetIndex].discountAllocated += Math.min(adjustment.amount, available);
      adjustment.targetItemIndex = targetIndex;
      return;
    }
    if (adjustment.targetType === 'ITEM') warnings.push('Target ' + adjustment.description + ' tidak pasti; diskon dialokasikan proporsional ke seluruh item.');
    general.push(adjustment);
  });

  const generalTotal = general.reduce(function(sum, adjustment) { return sum + adjustment.amount; }, 0);
  const bases = items.map(function(item) { return Math.max(0, item.grossAmount - item.discountAllocated); });
  const availableTotal = bases.reduce(function(sum, amount) { return sum + amount; }, 0);
  if (generalTotal > availableTotal) {
    valid = false;
    warnings.push('Total diskon melebihi subtotal nota.');
  }
  const allocatable = Math.min(generalTotal, availableTotal);
  if (allocatable > 0 && availableTotal > 0) {
    const allocations = bases.map(function(base, index) {
      const exact = allocatable * base / availableTotal;
      return { index:index, amount:Math.floor(exact), remainder:exact - Math.floor(exact) };
    });
    let distributed = allocations.reduce(function(sum, allocation) { return sum + allocation.amount; }, 0);
    allocations.slice().sort(function(a, b) { return b.remainder - a.remainder || bases[b.index] - bases[a.index] || a.index - b.index; }).forEach(function(allocation) {
      if (distributed < allocatable && allocation.amount < bases[allocation.index]) {
        allocation.amount += 1;
        distributed += 1;
      }
    });
    allocations.forEach(function(allocation) { items[allocation.index].discountAllocated += allocation.amount; });
  }

  items.forEach(function(item) {
    item.discountAllocated = Math.max(0, Math.round(item.discountAllocated));
    item.amount = Math.max(0, item.grossAmount - item.discountAllocated);
  });
  const grossTotal = items.reduce(function(sum, item) { return sum + item.grossAmount; }, 0);
  const discountTotal = items.reduce(function(sum, item) { return sum + item.discountAllocated; }, 0);
  return {
    items:items,
    adjustments:adjustments,
    grossTotal:grossTotal,
    discountTotal:discountTotal,
    receiptTotal:grossTotal - discountTotal,
    warnings:warnings,
    valid:valid && discountTotal === adjustments.reduce(function(sum, adjustment) { return sum + adjustment.amount; }, 0)
  };
}

function portalNormalizeOcrReceipts_(receipts, photoId) {
  if (!Array.isArray(receipts)) return [];
  return receipts.map(function(receipt) {
    const rawItems = Array.isArray(receipt.items) ? receipt.items : [];
    const adjustments = (Array.isArray(receipt.adjustments) ? receipt.adjustments : []).slice();
    const productItems = [];
    rawItems.forEach(function(item) {
      if (portalIsDiscountLine_(item)) {
        adjustments.push({
          type:'DISCOUNT',
          description:String(item.description || item.name || 'DISKON'),
          amount:Math.abs(portalSafeNumber_(item.amount || item.total || 0)),
          targetType:'RECEIPT',
          targetHint:''
        });
        return;
      }
      productItems.push({
        tempItemId: portalFriendlyId_('ITM'),
        description: String(item.description || item.name || '').trim(),
        category: portalUpper_(item.category || 'LAIN-LAIN'),
        quantity: portalSafeNumber_(item.quantity || item.qty || 1) || 1,
        unit: portalUpper_(item.unit || ''),
        grossAmount: Math.max(0, Math.round(portalSafeNumber_(item.grossAmount != null ? item.grossAmount : item.amount || item.total || 0)))
      });
    });
    const allocation = portalAllocateReceiptDiscounts_(productItems, adjustments);
    const printedTotal = portalSafeNumber_(receipt.receiptTotal || receipt.total || 0);
    const warnings = (Array.isArray(receipt.warnings) ? receipt.warnings : []).concat(allocation.warnings);
    if (printedTotal && Math.abs(printedTotal - allocation.receiptTotal) > 1) warnings.push('Grand total tercetak ' + printedTotal + ' belum cocok dengan hasil item dan diskon ' + allocation.receiptTotal + '. Periksa kembali sebelum mengirim.');
    return {
      tempReceiptId: portalFriendlyId_('TMP'),
      photoId: photoId,
      supplier: String(receipt.supplier || '').trim(),
      date: receipt.date && /^\d{4}-\d{2}-\d{2}$/.test(receipt.date) ? receipt.date : '',
      items: allocation.items,
      adjustments: allocation.adjustments,
      grossTotal: allocation.grossTotal,
      discountTotal: allocation.discountTotal,
      receiptTotal: allocation.receiptTotal,
      printedReceiptTotal: printedTotal,
      confidence: portalSafeNumber_(receipt.confidence || 0),
      warnings: warnings
    };
  });
}

function portalSubmitStoreDraft_(session, payload) {
  const uploadId = String(payload.uploadId || '');
  const upload = fbRead_('/uploads/' + uploadId);
  if (!upload || upload.branchId !== session.branchId) throw new Error('Draft upload tidak ditemukan.');
  if (upload.status === 'SUBMITTED') throw new Error('Draft ini sudah pernah disubmit.');
  const receipts = Array.isArray(payload.receipts) ? payload.receipts : [];
  if (!receipts.length) throw new Error('Minimal harus ada satu nota.');
  if (receipts.length > PORTAL_MAX_RECEIPTS_PER_SUBMISSION) throw new Error('Maksimal ' + PORTAL_MAX_RECEIPTS_PER_SUBMISSION + ' nota per submit.');
  // Ambil konfigurasi satu kali dan validasi semua nota sebelum ada record ditulis.
  const categoryNames = portalGetCategories_().map(function(item) { return item.name; });
  const branch = fbRead_('/config/branches/' + session.branchId);
  if (!branch || branch.active === false) throw new Error('Cabang akun tidak aktif atau belum dikonfigurasi.');
  const cleanReceipts = receipts.map(function(receipt) {
    return portalValidateReceiptPayload_(receipt, categoryNames);
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const latest = fbRead_('/uploads/' + uploadId);
    if (latest.status === 'SUBMITTED') throw new Error('Draft ini sudah pernah disubmit.');
    const updates = {};
    const countDeltas = {};
    const createdIds = receipts.map(function(receipt, index) {
      const receiptId = portalDeterministicReceiptId_(uploadId, index);
      const record = portalBuildReceiptRecord_(session, receipt, {
        receiptId: receiptId,
        uploadId: uploadId,
        source: 'AI_TOKO',
        status: 'PENDING',
        cleanReceipt: cleanReceipts[index],
        branch: branch
      });
      updates['receipts/' + receiptId] = record;
      portalAddReceiptIndexMutation_(updates, null, record, countDeltas);
      return receiptId;
    });
    updates['uploads/' + uploadId + '/status'] = 'SUBMITTED';
    updates['uploads/' + uploadId + '/receiptIds'] = createdIds;
    updates['uploads/' + uploadId + '/submittedAt'] = portalNow_();
    portalApplyCountDeltas_(updates, countDeltas);
    fbUpdate_('/', updates);
    portalClearReceiptsCache_();
    portalAudit_('STORE_SUBMIT', session.uid, { uploadId: uploadId, receiptIds: createdIds });
    return { success: true, receiptIds: createdIds };
  } finally {
    lock.releaseLock();
  }
}

function portalCreateReceiptRecord_(session, receipt, options) {
  options = options || {};
  const receiptId = String(options.receiptId || portalFriendlyId_('RCT'));
  const record = portalBuildReceiptRecord_(session, receipt, Object.assign({}, options, { receiptId:receiptId }));
  const updates = {};
  const countDeltas = {};
  updates['receipts/' + receiptId] = record;
  portalAddReceiptIndexMutation_(updates, null, record, countDeltas);
  portalApplyCountDeltas_(updates, countDeltas);
  fbUpdate_('/', updates);
  portalClearReceiptsCache_();
  return receiptId;
}

function portalDeterministicReceiptId_(uploadId, index) {
  const digest = portalHash_(String(uploadId) + '|' + Number(index || 0)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
  return 'RCT-' + digest;
}

function portalBuildReceiptRecord_(session, receipt, options) {
  options = options || {};
  const receiptId = String(options.receiptId || portalFriendlyId_('RCT'));
  const clean = options.cleanReceipt || portalValidateReceiptPayload_(receipt, options.categoryNames);
  const branch = options.branch || fbRead_('/config/branches/' + session.branchId);
  if (!branch || branch.active === false) throw new Error('Cabang akun tidak aktif atau belum dikonfigurasi.');
  const ocr = portalReceiptOcrMetadata_(receipt);
  return {
    id: receiptId,
    displayNumber: receiptId.slice(-6),
    uploadId: options.uploadId || '',
    photoId: String(receipt.photoId || ''),
    branchId: session.branchId || String(receipt.branchId || ''),
    branchName: String(branch.name || branch.nama || session.branchName || receipt.branchName || ''),
    branchType: String(branch.type || branch.tipe || session.branchType || receipt.branchType || 'Mandiri'),
    supplier: clean.supplier,
    date: clean.date,
    period: portalPeriod_(clean.date),
    items: clean.items,
    adjustments: clean.adjustments,
    grossTotal: clean.grossTotal,
    discountTotal: clean.discountTotal,
    receiptTotal: clean.receiptTotal,
    status: options.status || 'PENDING',
    source: options.source || 'AI_TOKO',
    submittedAt: portalNow_(),
    submittedBy: session.uid,
    ocrConfidence: ocr.ocrConfidence,
    ocrWarnings: ocr.ocrWarnings,
    review: {},
    eliminated: false,
    version: 1
  };
}

function portalValidateReceiptPayload_(receipt, categoryNames) {
  receipt = receipt || {};
  const date = portalIsoDate_(receipt.date || new Date());
  const rawItems = Array.isArray(receipt.items) ? receipt.items : [];
  const rawAdjustments = (Array.isArray(receipt.adjustments) ? receipt.adjustments : []).slice();
  const productItems = [];
  rawItems.forEach(function(item) {
    if (portalIsDiscountLine_(item)) {
      rawAdjustments.push({ type:'DISCOUNT', description:item.description || item.name || 'DISKON', amount:Math.abs(portalSafeNumber_(item.amount || item.total || 0)), targetType:'RECEIPT' });
    } else productItems.push(item);
  });
  if (!productItems.length) throw new Error('Setiap nota minimal memiliki satu item.');
  if (productItems.length > PORTAL_MAX_ITEMS_PER_RECEIPT) throw new Error('Maksimal ' + PORTAL_MAX_ITEMS_PER_RECEIPT + ' item per nota.');
  if (rawAdjustments.length > 20) throw new Error('Maksimal 20 baris diskon per nota.');
  const hadExplicitAdjustments = rawAdjustments.length > 0;
  const categories = Array.isArray(categoryNames) ? categoryNames : portalGetCategories_().map(function(item) { return item.name; });
  const seenItemIds = {};
  const baseItems = productItems.map(function(item) {
    const description = String(item.description || '').trim();
    const category = portalUpper_(item.category || 'LAIN-LAIN');
    const legacyDiscount = Math.max(0, Math.round(portalSafeNumber_(item.discountAllocated || 0)));
    const grossAmount = Math.round(portalSafeNumber_(item.grossAmount != null && item.grossAmount !== '' ? item.grossAmount : portalSafeNumber_(item.amount) + legacyDiscount));
    const quantity = portalSafeNumber_(item.quantity == null ? 1 : item.quantity);
    if (!description) throw new Error('Keterangan item wajib diisi.');
    if (description.length > 250) throw new Error('Keterangan item maksimal 250 karakter.');
    if (categories.indexOf(category) === -1) throw new Error('Kategori ' + category + ' tidak tersedia.');
    if (grossAmount < 0) throw new Error('Nominal item tidak boleh negatif. Gunakan bagian Diskon & Potongan untuk potongan harga.');
    if (quantity <= 0) throw new Error('Jumlah item harus lebih dari nol.');
    if (grossAmount > 1000000000000 || quantity > 1000000) throw new Error('Nilai item melebihi batas yang diizinkan.');
    const itemId = String(item.id || item.tempItemId || portalFriendlyId_('ITM'));
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(itemId) || seenItemIds[itemId]) throw new Error('ID item tidak valid atau duplikat.');
    seenItemIds[itemId] = true;
    if (!hadExplicitAdjustments && legacyDiscount) {
      rawAdjustments.push({ type:'DISCOUNT', description:'DISKON ITEM', amount:legacyDiscount, targetType:'ITEM', targetItemIndex:productItems.indexOf(item), targetHint:description });
    }
    return {
      id: itemId,
      description: description,
      category: category,
      quantity: quantity,
      unit: portalUpper_(item.unit || ''),
      grossAmount: grossAmount,
      amount: grossAmount,
      distributionBranch: String(item.distributionBranch || '')
    };
  });
  const allocation = portalAllocateReceiptDiscounts_(baseItems, rawAdjustments);
  if (!allocation.valid) throw new Error(allocation.warnings[0] || 'Diskon nota tidak valid.');
  const suppliedTotal = receipt.receiptTotal == null || receipt.receiptTotal === '' ? allocation.receiptTotal : portalSafeNumber_(receipt.receiptTotal);
  if (Math.abs(suppliedTotal - allocation.receiptTotal) > 1) throw new Error('Total nota harus sama dengan jumlah nominal bersih seluruh item setelah diskon.');
  const supplier = String(receipt.supplier || '-').trim();
  if (supplier.length > 160) throw new Error('Nama supplier maksimal 160 karakter.');
  return {
    supplier: supplier,
    date: date,
    items: allocation.items.map(function(item) {
      return {
        id:item.id,
        description:item.description,
        category:item.category,
        quantity:item.quantity,
        unit:item.unit,
        grossAmount:item.grossAmount,
        discountAllocated:item.discountAllocated,
        amount:item.amount,
        distributionBranch:item.distributionBranch
      };
    }),
    adjustments:allocation.adjustments,
    grossTotal:allocation.grossTotal,
    discountTotal:allocation.discountTotal,
    receiptTotal:suppliedTotal
  };
}

function portalGetStoreHistory_(session, payload) {
  const requestedStatus = portalUpper_(payload.status || 'ALL');
  return portalQueryReceiptIndex_({
    branchId:session.branchId,
    status:requestedStatus,
    limit:Math.min(100, Math.max(1, Number(payload.limit || 25))),
    cursor:String(payload.cursor || '')
  });
}

function portalResubmitReceipt_(session, payload) {
  const receiptId = String(payload.receiptId || '');
  const clean = portalValidateReceiptPayload_(payload.receipt || payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = fbRead_('/receipts/' + receiptId);
    if (!existing || existing.branchId !== session.branchId) throw new Error('Nota tidak ditemukan.');
    if (existing.status !== 'NEEDS_CORRECTION') throw new Error('Hanya nota yang berstatus Perlu Diperbaiki yang dapat dikirim ulang.');
    const expectedVersion = Number(payload.expectedVersion || (payload.receipt && payload.receipt.version) || 0);
    if (expectedVersion && expectedVersion !== Number(existing.version || 1)) throw new Error('Nota sudah berubah. Muat ulang sebelum mengirim ulang.');
    const next = JSON.parse(JSON.stringify(existing));
    Object.assign(next, {
      supplier: clean.supplier,
      date: clean.date,
      period: portalPeriod_(clean.date),
      items: clean.items,
      adjustments: clean.adjustments,
      grossTotal: clean.grossTotal,
      discountTotal: clean.discountTotal,
      receiptTotal: clean.receiptTotal,
      status: 'PENDING',
      resubmittedAt: portalNow_(),
      version: Number(existing.version || 1) + 1,
      review: {}
    });
    const updates = {};
    const countDeltas = {};
    updates['receipts/' + receiptId] = next;
    portalAddReceiptIndexMutation_(updates, existing, next, countDeltas);
    portalApplyCountDeltas_(updates, countDeltas);
    fbUpdate_('/', updates);
  } finally { lock.releaseLock(); }
  portalClearReceiptsCache_();
  portalAudit_('STORE_RESUBMIT', session.uid, { receiptId: receiptId });
  return { success: true };
}

function portalGetTaxReceipts_(session, payload) {
  const result = portalQueryReceiptIndex_({
    status:portalUpper_(payload.status || 'PENDING'),
    branchId:portalUpper_(payload.branchId || ''),
    dateFrom:String(payload.dateFrom || ''),
    dateTo:String(payload.dateTo || ''),
    cursor:String(payload.cursor || ''),
    limit:Math.min(100, Math.max(1, Number(payload.limit || PORTAL_DEFAULT_PAGE_SIZE)))
  });
  const branches = portalGetInternalBranches_();
  result.branches = branches;
  return result;
}

function portalGetReceiptDetail_(session, payload) {
  const receiptId = String(payload.receiptId || '');
  if (!receiptId) throw new Error('ID nota wajib diisi.');
  const receipt = fbRead_('/receipts/' + receiptId);
  if (!receipt) throw new Error('Nota tidak ditemukan.');
  if (session.role === 'TOKO' && portalUpper_(receipt.branchId) !== portalUpper_(session.branchId)) {
    throw new Error('Anda tidak memiliki akses ke nota ini.');
  }
  return portalReceiptForClient_(receipt);
}

function portalReadReceipts_() {
  const cached = cacheGetJson_('PORTAL_RECEIPTS_V2');
  if (Array.isArray(cached)) return cached;
  const data = fbRead_('/receipts') || {};
  const rows = Object.keys(data).map(function(key) { return data[key]; }).filter(Boolean).sort(function(a, b) {
    return Number(b.submittedAt || 0) - Number(a.submittedAt || 0);
  });
  // Semua jalur mutasi memanggil portalClearReceiptsCache_. TTL yang lebih panjang
  // menghindari full-scan Firebase berulang ketika pengguna berpindah halaman.
  cachePutJson_('PORTAL_RECEIPTS_V2', rows, 120);
  return rows;
}

function portalClearReceiptsCache_() {
  try { cacheRemoveJson_('PORTAL_RECEIPTS_V2'); } catch (error) {}
}

function portalReceiptForClient_(receipt) {
  const ocr = portalReceiptOcrMetadata_(receipt);
  return {
    id: receipt.id,
    displayNumber: receipt.displayNumber || String(receipt.id || '').slice(-6),
    uploadId: receipt.uploadId || '',
    photoId: receipt.photoId || '',
    branchId: receipt.branchId || '',
    branchName: receipt.branchName || '',
    branchType: receipt.branchType || 'Mandiri',
    supplier: receipt.supplier || '',
    date: receipt.date || '',
    items: Array.isArray(receipt.items) ? receipt.items : [],
    adjustments: Array.isArray(receipt.adjustments) ? receipt.adjustments : [],
    grossTotal: portalSafeNumber_(receipt.grossTotal == null ? receipt.receiptTotal : receipt.grossTotal),
    discountTotal: portalSafeNumber_(receipt.discountTotal || 0),
    receiptTotal: portalSafeNumber_(receipt.receiptTotal),
    status: receipt.status || '',
    source: receipt.source || '',
    submittedAt: receipt.submittedAt || 0,
    ocrConfidence: ocr.ocrConfidence,
    ocrWarnings: ocr.ocrWarnings,
    version: Number(receipt.version || 1),
    review: receipt.review || {},
    eliminated: receipt.eliminated === true
  };
}

function portalGetPhoto_(session, payload) {
  const photoId = String(payload.photoId || '');
  const photo = fbRead_('/photos/' + photoId);
  if (!photo) throw new Error('Foto tidak ditemukan.');
  if (session.role === 'TOKO' && photo.branchId !== session.branchId) throw new Error('Anda tidak memiliki akses ke foto ini.');
  const blob = DriveApp.getFileById(photo.driveFileId).getBlob();
  return {
    photoId: photoId,
    fileName: photo.fileName,
    dataUrl: 'data:' + (photo.mimeType || blob.getContentType()) + ';base64,' + Utilities.base64Encode(blob.getBytes())
  };
}

function portalGetPhotoThumbnail_(session, payload) {
  const photoId = String(payload.photoId || '');
  const photo = fbRead_('/photos/' + photoId);
  if (!photo) throw new Error('Foto tidak ditemukan.');
  if (session.role === 'TOKO' && photo.branchId !== session.branchId) throw new Error('Anda tidak memiliki akses ke foto ini.');
  if (!photo.thumbnailDriveFileId) return { photoId:photoId, available:false };
  const blob = DriveApp.getFileById(photo.thumbnailDriveFileId).getBlob();
  return {
    photoId:photoId,
    available:true,
    fileName:photo.fileName,
    dataUrl:'data:' + (photo.thumbnailMimeType || blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes())
  };
}

function portalSaveTaxReceipt_(session, payload) {
  const receiptId = String(payload.receiptId || '');
  portalAssertReceiptNotClaimed_(receiptId, '');
  const clean = portalValidateReceiptPayload_(payload.receipt || payload);
  let nextVersion = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = fbRead_('/receipts/' + receiptId);
    if (!existing) throw new Error('Nota tidak ditemukan.');
    if (existing.status !== 'PENDING') throw new Error('Hanya nota Pending yang dapat diedit dari Bank Nota.');
    const expectedVersion = Number(payload.expectedVersion || (payload.receipt && payload.receipt.version) || 0);
    if (expectedVersion && expectedVersion !== Number(existing.version || 1)) throw new Error('Nota sudah berubah. Muat ulang sebelum menyimpan.');
    nextVersion = Number(existing.version || 1) + 1;
    const next = JSON.parse(JSON.stringify(existing));
    Object.assign(next, {
      supplier: clean.supplier,
      date: clean.date,
      period: portalPeriod_(clean.date),
      items: clean.items,
      adjustments: clean.adjustments,
      grossTotal: clean.grossTotal,
      discountTotal: clean.discountTotal,
      receiptTotal: clean.receiptTotal,
      editedAt: portalNow_(),
      editedBy: session.uid,
      version: nextVersion
    });
    const updates = {};
    const countDeltas = {};
    updates['receipts/' + receiptId] = next;
    portalAddReceiptIndexMutation_(updates, existing, next, countDeltas);
    portalApplyCountDeltas_(updates, countDeltas);
    fbUpdate_('/', updates);
  } finally { lock.releaseLock(); }
  portalClearReceiptsCache_();
  portalAudit_('EDIT_PENDING_RECEIPT', session.uid, { receiptId: receiptId });
  return { success: true, version: nextVersion };
}

function portalApplyTaxDecisions_(session, payload) {
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  if (!decisions.length) throw new Error('Belum ada keputusan yang dipilih.');
  if (decisions.length > 100) throw new Error('Maksimal 100 keputusan per proses.');
  const results = [];
  decisions.forEach(function(decision) {
    const receiptId = String(decision.receiptId || '');
    try {
      const requestedDecision = portalUpper_(decision.decision);
      if (requestedDecision === 'APPROVE') {
        portalApproveReceipt_(session, receiptId, decision.expectedVersion);
      } else if (requestedDecision === 'DISCARD') {
        portalDiscardReceipt_(session, receiptId, decision.expectedVersion);
      } else if (['REJECT', 'REQUEST_CORRECTION'].indexOf(requestedDecision) >= 0) {
        const reason = String(decision.reason || 'Data perlu diperbaiki.').trim();
        portalRejectReceipt_(session, receiptId, reason, decision.expectedVersion);
      } else {
        throw new Error('Keputusan harus Setujui, Perlu Perbaikan, atau Tidak Digunakan.');
      }
      results.push({ receiptId: receiptId, success: true });
    } catch (error) {
      results.push({ receiptId: receiptId, success: false, error: error.message });
    }
  });
  portalClearReceiptsCache_();
  return { results: results };
}

function portalRejectReceipt_(session, receiptId, reason, expectedVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return portalRejectReceiptCore_(session, receiptId, reason, expectedVersion);
  } finally { lock.releaseLock(); }
}

function portalRejectReceiptCore_(session, receiptId, reason, expectedVersion) {
  const receipt = fbRead_('/receipts/' + receiptId);
  if (!receipt || receipt.status !== 'PENDING') throw new Error('Nota tidak lagi berstatus Pending.');
  if (Number(expectedVersion || 0) && Number(expectedVersion) !== Number(receipt.version || 1)) throw new Error('Nota sudah berubah. Muat ulang sebelum menolak.');
  const next = JSON.parse(JSON.stringify(receipt));
  Object.assign(next, {
    status: 'NEEDS_CORRECTION',
    version: Number(receipt.version || 1) + 1,
    review: { decision: 'REJECT', reason: String(reason || '').slice(0, 500), reviewedAt: portalNow_(), reviewedBy: session.uid }
  });
  const updates = {};
  const countDeltas = {};
  updates['receipts/' + receiptId] = next;
  portalAddReceiptIndexMutation_(updates, receipt, next, countDeltas);
  portalApplyCountDeltas_(updates, countDeltas);
  fbUpdate_('/', updates);
  portalAudit_('REJECT_RECEIPT', session.uid, { receiptId: receiptId, reason: String(reason || '').slice(0, 500) });
  return { success:true };
}

function portalDiscardReceipt_(session, receiptId, expectedVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return portalDiscardReceiptCore_(session, receiptId, expectedVersion);
  } finally { lock.releaseLock(); }
}

function portalDiscardReceiptCore_(session, receiptId, expectedVersion) {
  const receipt = fbRead_('/receipts/' + receiptId);
  if (!receipt) throw new Error('Nota tidak ditemukan.');
  if (receipt.status === 'REJECTED' && receipt.review && receipt.review.decision === 'DISCARD') {
    return { success:true, idempotent:true };
  }
  if (receipt.status !== 'PENDING') throw new Error('Nota tidak lagi berstatus Pending.');
  if (Number(expectedVersion || 0) && Number(expectedVersion) !== Number(receipt.version || 1)) throw new Error('Nota sudah berubah. Muat ulang sebelum menandai Tidak Digunakan.');
  const now = portalNow_();
  const next = JSON.parse(JSON.stringify(receipt));
  Object.assign(next, {
    status:'REJECTED',
    version:Number(receipt.version || 1) + 1,
    review:{ decision:'DISCARD', reason:'', reviewedAt:now, reviewedBy:session.uid }
  });
  const updates = {};
  const countDeltas = {};
  updates['receipts/' + receiptId] = next;
  portalAddReceiptIndexMutation_(updates, receipt, next, countDeltas);
  portalApplyCountDeltas_(updates, countDeltas);
  fbUpdate_('/', updates);
  portalClearReceiptsCache_();
  portalAudit_('DISCARD_RECEIPT', session.uid, { receiptId:receiptId });
  return { success:true };
}

function portalRestoreDiscardedReceipt_(session, payload) {
  const receiptId = String(payload && payload.receiptId || '');
  const expectedVersion = Number(payload && payload.expectedVersion || 0);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const receipt = fbRead_('/receipts/' + receiptId);
    if (!receipt || receipt.status !== 'REJECTED' || !receipt.review || receipt.review.decision !== 'DISCARD') throw new Error('Hanya nota Tidak Digunakan yang dapat dikembalikan ke review.');
    if (expectedVersion && expectedVersion !== Number(receipt.version || 1)) throw new Error('Nota sudah berubah. Muat ulang sebelum mengembalikan ke review.');
    const next = JSON.parse(JSON.stringify(receipt));
    const history = Array.isArray(next.reviewHistory) ? next.reviewHistory.slice(-19) : [];
    history.push(next.review);
    Object.assign(next, {
      status:'PENDING',
      version:Number(receipt.version || 1) + 1,
      review:{},
      reviewHistory:history,
      restoredAt:portalNow_(),
      restoredBy:session.uid
    });
    const updates = {};
    const countDeltas = {};
    updates['receipts/' + receiptId] = next;
    portalAddReceiptIndexMutation_(updates, receipt, next, countDeltas);
    portalApplyCountDeltas_(updates, countDeltas);
    fbUpdate_('/', updates);
  } finally { lock.releaseLock(); }
  portalClearReceiptsCache_();
  portalAudit_('RESTORE_DISCARDED_RECEIPT', session.uid, { receiptId:receiptId });
  return { success:true };
}

function portalApproveReceipt_(session, receiptId, expectedVersion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return portalApproveReceiptCore_(session, receiptId, expectedVersion);
  } finally {
    lock.releaseLock();
  }
}

function portalApproveReceiptCore_(session, receiptId, expectedVersion) { return tarikApproveReceipt_(session, receiptId, expectedVersion); }

function portalResolveSpreadsheetTarget_(branchId, period) {
  period = portalValidatePeriod_(period);
  const links = fbRead_('/config/spreadsheetLinks/' + period) || {};
  const target = links[branchId];
  const url = target && (target.url || target.spreadsheetUrl);
  if (!url) throw new Error('Link spreadsheet untuk cabang dan bulan nota belum dikonfigurasi.');
  return { url: portalValidateSpreadsheetUrl_(url) };
}

function portalAssertCapacity_(sheet, isoDate, needed, branchType) {
  if (String(branchType).toLowerCase().indexOf('central') >= 0) return;
  const day = Number(String(isoDate).slice(-2));
  const startRow = (day - 1) * 30 + 5;
  const values = sheet.getRange(startRow, 2, 27, 7).getValues();
  let empty = 0;
  for (let i = 1; i < values.length; i++) {
    if (!values[i][2] && (values[i][5] === '' || values[i][5] == null)) empty++;
  }
  if (empty < needed) throw new Error('Baris kosong pada tanggal tujuan tidak cukup untuk seluruh item nota.');
}

function portalReceiptSheetRowValues_(item, type, dateText, sequence) {
  if (type === 'Central Kitchen') {
    return [
      Number(String(dateText).split('-')[0]),
      sequence,
      String(item.distributionBranch || '').trim().toUpperCase(),
      String(item.description || '').trim(),
      String(item.category || '').trim(),
      (item.quantity || 1) + (item.unit ? ' ' + item.unit : ''),
      item.amount ? Number(item.amount) : '',
      item.eliminated ? 'YA' : 'TIDAK'
    ];
  }
  return [
    Number(String(dateText).split('-')[0]),
    sequence,
    String(item.description || '').trim(),
    String(item.category || '').trim(),
    (item.quantity || 1) + (item.unit ? ' ' + item.unit : ''),
    item.amount ? Number(item.amount) : '',
    item.eliminated ? 'YA' : 'TIDAK'
  ];
}

function portalPlanReceiptRows_(sheet, receipt, branchType, existingItemIds, reservedRowsByItemId, occupiedRowIndexes) {
  const type = String(branchType).toLowerCase().indexOf('central') >= 0 ? 'Central Kitchen' : 'Mandiri';
  const dateText = String(receipt.date).slice(-2) + '-' + String(receipt.date).slice(5, 7) + '-' + String(receipt.date).slice(0, 4);
  existingItemIds = existingItemIds || {};
  reservedRowsByItemId = reservedRowsByItemId || {};
  occupiedRowIndexes = occupiedRowIndexes || {};
  const missingItems = receipt.items.filter(function(item) {
    const itemId = String(item.id || '');
    return !(itemId && existingItemIds[itemId]);
  });
  if (!missingItems.length) return { type:type, dateText:dateText, allocations:[], insertCount:0 };

  if (type === 'Mandiri') {
    const day = Number(String(receipt.date).slice(-2));
    const startRow = (day - 1) * 30 + 5;
    const values = sheet.getRange(startRow, 2, 27, 7).getValues();
    const freeRows = [];
    let lastNo = 0;
    for (let index = 1; index < values.length; index++) {
      const currentNo = parseInt(values[index][1], 10);
      if (!isNaN(currentNo)) lastNo = Math.max(lastNo, currentNo);
      const rowIndex = startRow + index;
      if (!occupiedRowIndexes[rowIndex] && !values[index][2] && (values[index][5] === '' || values[index][5] == null)) freeRows.push(rowIndex);
    }
    const needsNewRow = missingItems.filter(function(item) {
      return !reservedRowsByItemId[String(item.id || '')];
    });
    if (freeRows.length < needsNewRow.length) throw new Error('Baris kosong pada tanggal tujuan tidak cukup untuk seluruh item nota.');
    let freeIndex = 0;
    let nextSequence = lastNo;
    return {
      type:type,
      dateText:dateText,
      insertCount:0,
      allocations:missingItems.map(function(item) {
        const itemId = String(item.id || '');
        const reservation = reservedRowsByItemId[itemId] || null;
        const rowIndex = reservation ? Number(reservation.rowIndex) : freeRows[freeIndex++];
        const valueIndex = rowIndex - startRow;
        if (reservation && (valueIndex < 1 || valueIndex >= values.length)) throw new Error('Reservasi baris nota berada di luar blok tanggal Mandiri.');
        const storedSequence = valueIndex >= 0 && valueIndex < values.length ? parseInt(values[valueIndex][1], 10) : NaN;
        const sequence = isNaN(storedSequence) ? ++nextSequence : storedSequence;
        return { item:item, itemId:itemId, rowIndex:rowIndex, reserved:Boolean(reservation), values:portalReceiptSheetRowValues_(Object.assign({}, item, { eliminated:receipt.eliminated }), type, dateText, sequence) };
      })
    };
  }

  const day = Number(String(receipt.date).slice(-2));
  const lastRow = sheet.getLastRow();
  if (lastRow < 5) throw new Error('Data sheet terlalu sedikit.');
  const allData = sheet.getRange(1, 2, lastRow, 8).getValues();
  let blockStartIndex = -1;
  let blockEndIndex = -1;
  for (let index = 0; index < allData.length; index++) {
    const cellDay = String(allData[index][0]).trim();
    const cellNo = parseInt(allData[index][1], 10);
    if (cellDay === String(day) && !isNaN(cellNo)) {
      if (blockStartIndex === -1) blockStartIndex = index;
      blockEndIndex = index;
    } else if (blockStartIndex !== -1 && cellDay !== String(day)) break;
  }
  if (blockStartIndex === -1) throw new Error('Blok untuk tanggal ' + day + ' tidak ditemukan di spreadsheet.');
  let lastFilledIndex = -1;
  for (let index = blockEndIndex; index >= blockStartIndex; index--) {
    if (allData[index][3] || (allData[index][6] !== '' && allData[index][6] != null)) { lastFilledIndex = index; break; }
  }
  const firstTargetIndex = lastFilledIndex === -1 ? blockStartIndex : lastFilledIndex + 1;
  const availableRows = [];
  for (let dataIndex = firstTargetIndex; dataIndex <= blockEndIndex; dataIndex++) {
    const rowIndex = dataIndex + 1;
    if (!occupiedRowIndexes[rowIndex]) availableRows.push(rowIndex);
  }
  const needsNewRow = missingItems.filter(function(item) {
    return !reservedRowsByItemId[String(item.id || '')];
  });
  const insertCount = Math.max(0, needsNewRow.length - availableRows.length);
  const reservationRows = Object.keys(reservedRowsByItemId).map(function(itemId) {
    return Number((reservedRowsByItemId[itemId] || {}).rowIndex || 0);
  }).filter(function(rowIndex) { return rowIndex > 0; });
  const insertAfterRow = Math.max.apply(Math, [blockEndIndex + 1].concat(reservationRows));
  for (let index = 0; index < insertCount; index++) availableRows.push(insertAfterRow + index + 1);
  let lastSequence = parseInt(allData[Math.max(blockStartIndex, Math.min(blockEndIndex, firstTargetIndex - 1))][1], 10);
  if (isNaN(lastSequence)) lastSequence = parseInt(allData[blockStartIndex][1], 10) || 1;
  for (let index = blockStartIndex; index <= blockEndIndex; index++) {
    const sequence = parseInt(allData[index][1], 10);
    if (!isNaN(sequence)) lastSequence = Math.max(lastSequence, sequence);
  }
  reservationRows.forEach(function(rowIndex) {
    const sequence = rowIndex > 0 && rowIndex <= allData.length ? parseInt(allData[rowIndex - 1][1], 10) : NaN;
    if (!isNaN(sequence)) lastSequence = Math.max(lastSequence, sequence);
  });
  let availableIndex = 0;
  let nextSequence = lastSequence;
  return {
    type:type,
    dateText:dateText,
    insertCount:insertCount,
    insertAfterRow:insertAfterRow,
    allocations:missingItems.map(function(item) {
      const itemId = String(item.id || '');
      const reservation = reservedRowsByItemId[itemId] || null;
      const rowIndex = reservation ? Number(reservation.rowIndex) : availableRows[availableIndex++];
      const existingSequence = rowIndex > 0 && rowIndex <= allData.length ? parseInt(allData[rowIndex - 1][1], 10) : NaN;
      const sequence = isNaN(existingSequence) ? ++nextSequence : existingSequence;
      return { item:item, itemId:itemId, rowIndex:rowIndex, reserved:Boolean(reservation), values:portalReceiptSheetRowValues_(Object.assign({}, item, { eliminated:receipt.eliminated }), type, dateText, sequence) };
    })
  };
}

function portalCommitReceiptRowPlan_(sheet, receipt, plan, existingItemIds) {
  existingItemIds = existingItemIds || {};
  const allocations = plan.allocations || [];
  if (plan.insertCount > 0) {
    sheet.insertRowsAfter(plan.insertAfterRow, plan.insertCount);
    const source = sheet.getRange(plan.insertAfterRow, 1, 1, sheet.getMaxColumns());
    const firstInserted = plan.insertAfterRow + 1;
    const target = sheet.getRange(firstInserted, 1, plan.insertCount, sheet.getMaxColumns());
    source.copyFormatToRange(sheet, 1, sheet.getMaxColumns(), firstInserted, firstInserted + plan.insertCount - 1);
    const validationRow = source.getDataValidations()[0] || [];
    target.setDataValidations(Array.from({ length:plan.insertCount }, function() { return validationRow.slice(); }));
  }
  const metadataKey = portalReceiptMetadataKey_(receipt.id);
  let metadataEntries = portalFindReceiptMetadataEntries_(sheet, receipt.id, receipt.date);
  const metadataByItemId = metadataEntries.reduce(function(map, entry) {
    if (!entry.itemId || (map[entry.itemId] && map[entry.itemId].state === 'COMMITTED')) return map;
    map[entry.itemId] = entry;
    return map;
  }, {});
  // Reserve every target before writing values. If this phase is interrupted,
  // retry will reuse the rows already reserved and allocate only the remainder.
  allocations.forEach(function(allocation) {
    const existing = metadataByItemId[allocation.itemId];
    if (existing) {
      if (Number(existing.rowIndex) !== Number(allocation.rowIndex)) throw new Error('Reservasi item nota menunjuk baris yang berbeda; rekonsiliasi diperlukan.');
      return;
    }
    sheet.getRange(allocation.rowIndex + ':' + allocation.rowIndex)
      .addDeveloperMetadata(metadataKey, portalReceiptMetadataValue_('RESERVED', receipt.date, allocation.itemId));
  });
  SpreadsheetApp.flush();
  const groups = [];
  allocations.slice().sort(function(a, b) { return Number(a.rowIndex) - Number(b.rowIndex); }).forEach(function(allocation) {
    const previous = groups[groups.length - 1];
    if (previous && previous.startRow + previous.rows.length === allocation.rowIndex) previous.rows.push(allocation.values);
    else groups.push({ startRow:allocation.rowIndex, rows:[allocation.values] });
  });
  groups.forEach(function(group) {
    sheet.getRange(group.startRow, 2, group.rows.length, group.rows[0].length).setValues(group.rows);
  });
  SpreadsheetApp.flush();
  metadataEntries = portalFindReceiptMetadataEntries_(sheet, receipt.id, receipt.date);
  const reservedByItemId = metadataEntries.reduce(function(map, entry) {
    if (entry.itemId) map[entry.itemId] = entry;
    return map;
  }, {});
  allocations.forEach(function(allocation) {
    const entry = reservedByItemId[allocation.itemId];
    if (!entry || Number(entry.rowIndex) !== Number(allocation.rowIndex)) throw new Error('Reservasi metadata item tidak ditemukan setelah penulisan.');
    if (entry.state !== 'COMMITTED') entry.metadata.setValue(portalReceiptMetadataValue_('COMMITTED', receipt.date, allocation.itemId));
    existingItemIds[allocation.itemId] = true;
  });
  SpreadsheetApp.flush();
  const written = portalFindReceiptRows_(sheet, receipt.id, receipt.date).filter(function(item) { return item.state === 'COMMITTED'; });
  const rowByItemId = written.reduce(function(map, item) { if (item.itemId) map[item.itemId] = item.rowIndex; return map; }, {});
  return receipt.items.map(function(item) { return rowByItemId[String(item.id || '')]; }).filter(function(rowIndex) { return Number(rowIndex) > 0; });
}

function portalWriteReceiptRows_(sheet, receipt, branchType, existingItemIds) {
  const beforeRows = portalFindReceiptRows_(sheet, receipt.id, receipt.date);
  const rowStates = portalReceiptMetadataStateMaps_(beforeRows);
  existingItemIds = Object.assign(rowStates.committedItemIds, existingItemIds || {});
  const plan = portalPlanReceiptRows_(sheet, receipt, branchType, existingItemIds, rowStates.reservedRowsByItemId, rowStates.occupiedRowIndexes);
  return portalCommitReceiptRowPlan_(sheet, receipt, plan, existingItemIds);
}

function portalReceiptMetadataValue_(state, receiptDate, itemId) {
  const safeState = state === 'RESERVED' ? 'RESERVED' : 'COMMITTED';
  return safeState + '|' + encodeURIComponent(String(receiptDate || '')) + '|' + encodeURIComponent(String(itemId || ''));
}

function portalParseReceiptMetadataValue_(value) {
  const parts = String(value || '').split('|');
  const hasState = parts[0] === 'RESERVED' || parts[0] === 'COMMITTED';
  const state = hasState ? parts[0] : 'COMMITTED';
  let receiptDate = '';
  let itemId = '';
  try {
    receiptDate = decodeURIComponent(parts[hasState ? 1 : 0] || '');
    itemId = decodeURIComponent(parts[hasState ? 2 : 1] || '');
  } catch (error) {}
  return { state:state, date:receiptDate, itemId:itemId };
}

function portalFindReceiptMetadataEntries_(sheet, receiptId, expectedDate) {
  const receiptMetadata = sheet.createDeveloperMetadataFinder()
    .withKey(portalReceiptMetadataKey_(receiptId))
    .find();
  return receiptMetadata.map(function(metadata) {
    const rowRange = metadata.getLocation().getRow();
    const parsed = portalParseReceiptMetadataValue_(metadata.getValue());
    return { metadata:metadata, rowIndex:rowRange.getRow(), itemId:parsed.itemId, date:parsed.date, state:parsed.state };
  }).filter(function(item) { return !expectedDate || !item.date || item.date === String(expectedDate); })
    .sort(function(a, b) { return a.rowIndex - b.rowIndex; });
}

function portalFindReceiptRows_(sheet, receiptId, expectedDate) {
  return portalFindReceiptMetadataEntries_(sheet, receiptId, expectedDate).map(function(item) {
    return { rowIndex:item.rowIndex, itemId:item.itemId, date:item.date, state:item.state };
  });
}

function portalReceiptMetadataStateMaps_(rows) {
  const result = { committedItemIds:{}, reservedRowsByItemId:{}, occupiedRowIndexes:{} };
  (rows || []).forEach(function(row) {
    if (Number(row.rowIndex) > 0) result.occupiedRowIndexes[Number(row.rowIndex)] = true;
    if (!row.itemId) return;
    if (row.state === 'RESERVED') {
      if (!result.committedItemIds[row.itemId]) result.reservedRowsByItemId[row.itemId] = row;
    } else {
      result.committedItemIds[row.itemId] = true;
      delete result.reservedRowsByItemId[row.itemId];
    }
  });
  return result;
}

function portalReceiptMetadataKey_(receiptId) {
  return 'PORTAL_R_' + portalHash_(String(receiptId || '')).slice(0, 40);
}

function portalGetMasterLinks_(session, payload) {
  const period = portalValidatePeriod_(payload.period || portalPeriod_(new Date()));
  // Master Link is now the source of truth. The previous Parameter(Hide) auto-sync
  // treated an entire column as Central Kitchen and could misclassify store branches.
  portalRepairLegacyCentralKitchenSync_(session);
  return {
    period: period,
    links: fbRead_('/config/spreadsheetLinks/' + period) || {},
    revision: Number(fbRead_('/config/spreadsheetLinkRevisions/' + period) || 0),
    branches: portalGetInternalBranches_(true)
  };
}

function portalRepairLegacyCentralKitchenSync_(session) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('PORTAL_LEGACY_CK_REPAIR_V2') === 'DONE') return { repaired: 0 };
  let masterNames = {};
  try {
    (getBootstrapData_().branches || []).forEach(function(branch) {
      const name = String((branch || {}).toko || (branch || {}).name || '').trim();
      if (name) masterNames[name.toUpperCase()] = true;
    });
  } catch (error) { return { repaired: 0 }; }
  if (!Object.keys(masterNames).length) return { repaired: 0 };

  const branches = fbRead_('/config/branches') || {};
  const profiles = fbRead_('/profiles') || {};
  const repairedIds = {};
  const updates = {};
  Object.keys(branches).forEach(function(id) {
    const branch = branches[id] || {};
    const name = String(branch.name || branch.nama || '').trim();
    const syncedByLegacyRule = branch.createdBy === 'CK_PARAMETER_SYNC' || branch.updatedBy === 'CK_PARAMETER_SYNC';
    if (!syncedByLegacyRule || !masterNames[name.toUpperCase()] || String(branch.type || branch.tipe || '') !== 'Central Kitchen') return;
    repairedIds[id] = true;
    updates['config/branches/' + id + '/type'] = 'Mandiri';
    updates['config/branches/' + id + '/updatedAt'] = portalNow_();
    updates['config/branches/' + id + '/updatedBy'] = 'MASTER_LINK_TYPE_REPAIR';
  });
  Object.keys(profiles).forEach(function(uid) {
    const profile = profiles[uid] || {};
    if (repairedIds[profile.branchId] && profile.role === 'TOKO') updates['profiles/' + uid + '/branchType'] = 'Mandiri';
  });
  const repaired = Object.keys(repairedIds).length;
  if (repaired) {
    fbUpdate_('/', updates);
    portalClearBranchCache_();
    portalAudit_('REPAIR_LEGACY_CK_BRANCH_TYPES', session && session.uid || 'SYSTEM', { repaired: repaired });
  }
  properties.setProperty('PORTAL_LEGACY_CK_REPAIR_V2', 'DONE');
  return { repaired: repaired };
}

function portalEnsureCentralKitchenBranches_(session) {
  let kitchens = [];
  try { kitchens = (getBootstrapData_().cabangCentralKitchen || []).map(String).map(function(name) { return name.trim(); }).filter(Boolean); } catch (error) {}
  if (!kitchens.length) return { added: 0 };
  const branches = fbRead_('/config/branches') || {};
  const existingNames = Object.keys(branches).reduce(function(map, id) {
    const branch = branches[id] || {};
    map[String(branch.name || branch.nama || id).trim().toUpperCase()] = true;
    return map;
  }, {});
  let added = 0;
  kitchens.forEach(function(name) {
    if (existingNames[name.toUpperCase()]) return;
    let id = 'CK_' + portalUpper_(name).replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!id || id === 'CK_') return;
    let suffix = 2;
    while (branches[id]) { id = id.replace(/_\d+$/, '') + '_' + suffix; suffix += 1; }
    fbUpdate_('/config/branches/' + id, { code:id, name:name, type:'Central Kitchen', active:true, createdAt:portalNow_(), createdBy:'CK_PARAMETER_SYNC', updatedAt:portalNow_(), updatedBy:session && session.uid || 'SYSTEM' });
    branches[id] = { name:name }; existingNames[name.toUpperCase()] = true; added += 1;
  });
  if (added) portalAudit_('SYNC_CENTRAL_KITCHEN_BRANCHES', session && session.uid || 'SYSTEM', { count:added });
  return { added:added };
}

function portalPreviewBulkManageBranches_(session, payload) {
  return portalBuildBulkBranchPlan_(session, payload);
}

function portalBulkManageBranches_(session, payload) {
  const plan = portalBuildBulkBranchPlan_(session, payload);
  if (plan.errors.length) throw new Error('Upload dibatalkan. ' + plan.errors.map(function(item) { return 'Baris ' + item.row + ': ' + item.error; }).join(' | '));
  const updates = {};
  const profiles = fbRead_('/profiles') || {};
  const allLinks = fbRead_('/config/spreadsheetLinks') || {};
  plan.changes.forEach(function(change) {
    if (change.action === 'DELETE') {
      updates['config/branches/' + change.id] = null;
      Object.keys(allLinks).forEach(function(period) { updates['config/spreadsheetLinks/' + period + '/' + change.id] = null; });
    } else if (change.action !== 'NO_CHANGE') {
      updates['config/branches/' + change.id] = Object.assign({}, change.after, { code:change.id, active:change.before ? change.before.active !== false : true, updatedAt:portalNow_(), updatedBy:session.uid });
      Object.keys(profiles).forEach(function(uid) {
        const profile = profiles[uid] || {};
        if (profile.branchId !== change.id) return;
        updates['profiles/' + uid + '/branchName'] = change.after.name;
        updates['profiles/' + uid + '/branchType'] = change.after.type;
      });
    }
  });
  // One Firebase multi-location PATCH makes the validated batch all-or-nothing at the data layer.
  if (Object.keys(updates).length) fbUpdate_('/', updates);
  if (Object.keys(updates).length) portalClearBranchCache_();
  Object.keys(profiles).forEach(function(uid) {
    if (plan.changes.some(function(change) { return change.action !== 'NO_CHANGE' && (profiles[uid] || {}).branchId === change.id; })) portalClearProfileCache_(uid);
  });
  portalAudit_('BULK_MANAGE_BRANCHES', session.uid, { period:plan.period, count:plan.changes.length, summary:plan.summary });
  return { results:plan.changes.map(function(change) { return { row:change.row, success:true, action:change.action, id:change.id, changedFields:change.changedFields }; }), summary:plan.summary };
}

function portalBuildBulkBranchPlan_(session, payload) {
  payload = payload || {};
  const period = portalValidatePeriod_(payload.period || portalPeriod_(new Date()));
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new Error('CSV cabang kosong.');
  if (rows.length > 250) throw new Error('Maksimal 250 baris dalam satu upload.');
  const stored = fbRead_('/config/branches') || {};
  const profiles = fbRead_('/profiles') || {};
  const receipts = fbRead_('/receipts') || {};
  const working = JSON.parse(JSON.stringify(stored));
  const nameIndex = {};
  Object.keys(working).forEach(function(id) { nameIndex[String((working[id] || {}).name || (working[id] || {}).nama || id).trim().toUpperCase()] = id; });
  const seenIds = {};
  const changes = [];
  const errors = [];
  rows.forEach(function(row, index) {
    const rowNumber = index + 2;
    try {
      const action = portalUpper_(row.action || 'UPSERT');
      const suppliedId = portalUpper_(row.id || '');
      const suppliedName = String(row.name || row.nama || '').trim();
      const suppliedType = String(row.type || row.tipe || '').trim();
      if (['ADD', 'UPDATE', 'UPSERT', 'DELETE'].indexOf(action) === -1) throw new Error('Action harus ADD, UPDATE, UPSERT, atau DELETE.');
      let id = suppliedId;
      if (!id && suppliedName) id = portalUpper_(suppliedName).replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      if (!id || !/^[A-Z0-9_]+$/.test(id)) throw new Error('ID cabang tidak valid.');
      if (seenIds[id]) throw new Error('ID cabang duplikat dalam file (juga ada pada baris ' + seenIds[id] + ').');
      seenIds[id] = rowNumber;
      const before = working[id] || null;
      if (action === 'DELETE') {
        if (!suppliedId) throw new Error('DELETE wajib memakai ID cabang.');
        if (!before) throw new Error('Cabang tidak ditemukan.');
        const linkedAccounts = Object.keys(profiles).filter(function(uid) { return (profiles[uid] || {}).branchId === id; }).length;
        const receiptCount = Object.keys(receipts).filter(function(receiptId) { return (receipts[receiptId] || {}).branchId === id; }).length;
        if (linkedAccounts || receiptCount) throw new Error('Cabang masih dipakai ' + linkedAccounts + ' akun dan ' + receiptCount + ' riwayat nota; penghapusan diblokir.');
        delete working[id]; delete nameIndex[String(before.name || before.nama || id).trim().toUpperCase()];
        changes.push({ row:rowNumber, action:'DELETE', id:id, before:before, after:null, changedFields:['deleted'] });
        return;
      }
      if (action === 'ADD' && before) throw new Error('ID cabang sudah ada; gunakan UPDATE.');
      if (action === 'UPDATE' && (!suppliedId || !before)) throw new Error('UPDATE wajib memakai ID cabang yang sudah ada.');
      if (action === 'UPSERT' && before && !suppliedId) throw new Error('UPSERT untuk cabang yang sudah ada wajib memakai ID cabang.');
      if (!before && (!suppliedName || !suppliedType)) throw new Error('Cabang baru wajib memiliki nama dan tipe.');
      if (suppliedType && ['Mandiri', 'Central Kitchen'].indexOf(suppliedType) === -1) throw new Error('Tipe hanya Mandiri atau Central Kitchen.');
      const after = Object.assign({}, before || {}, { name: suppliedName || (before && (before.name || before.nama)) || '', type: suppliedType || (before && (before.type || before.tipe)) || '' });
      const normalizedName = after.name.trim().toUpperCase();
      const existingNameId = nameIndex[normalizedName];
      if (existingNameId && existingNameId !== id) throw new Error('Nama cabang sudah dipakai oleh ID ' + existingNameId + '.');
      const changedFields = ['name', 'type'].filter(function(field) { return !before || String(before[field] || before[field === 'name' ? 'nama' : 'tipe'] || '') !== String(after[field] || ''); });
      if (before && !changedFields.length) changes.push({ row:rowNumber, action:'NO_CHANGE', id:id, before:before, after:after, changedFields:[] });
      else changes.push({ row:rowNumber, action:before ? 'UPDATE' : 'ADD', id:id, before:before, after:after, changedFields:changedFields });
      if (before) delete nameIndex[String(before.name || before.nama || id).trim().toUpperCase()];
      working[id] = after; nameIndex[normalizedName] = id;
    } catch (error) { errors.push({ row:rowNumber, error:error.message }); }
  });
  const summary = { add:changes.filter(function(item) { return item.action === 'ADD'; }).length, update:changes.filter(function(item) { return item.action === 'UPDATE'; }).length, remove:changes.filter(function(item) { return item.action === 'DELETE'; }).length, unchanged:changes.filter(function(item) { return item.action === 'NO_CHANGE'; }).length };
  return { period:period, changes:changes, errors:errors, summary:summary };
}

function portalSaveMasterLinks_(session, payload) {
  const period = portalValidatePeriod_(payload.period);
  const links = payload.links || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
  const revisionPath = '/config/spreadsheetLinkRevisions/' + period;
  const currentRevision = Number(fbRead_(revisionPath) || 0);
  if (payload.expectedRevision != null && Number(payload.expectedRevision) !== currentRevision) throw new Error('Master Link sudah diubah pengguna lain. Muat ulang sebelum menyimpan.');
  const updates = {};
  Object.keys(links).forEach(function(branchId) {
    const entry = links[branchId] || {};
    const branch = fbRead_('/config/branches/' + branchId);
    if (!branch) throw new Error('Cabang ' + branchId + ' tidak terdaftar.');
    const url = portalValidateSpreadsheetUrl_(entry.url || entry.spreadsheetUrl || '');
    updates['config/spreadsheetLinks/' + period + '/' + branchId] = url ? {
      url: url,
      branchName: branch.name || branch.nama || entry.branchName || branchId,
      updatedAt: portalNow_(),
      updatedBy: session.uid
    } : null;
  });
  updates['config/spreadsheetLinkRevisions/' + period] = currentRevision + 1;
  fbUpdate_('/', updates);
  portalAudit_('SAVE_MASTER_LINKS', session.uid, { period: period, count: Object.keys(links).length, revision:currentRevision + 1 });
  return { success: true, revision:currentRevision + 1 };
  } finally { lock.releaseLock(); }
}

function portalUpsertMasterBranch_(session, payload) {
  payload = payload || {};
  const period = portalValidatePeriod_(payload.period || portalPeriod_(new Date()));
  const name = String(payload.name || '').trim();
  const type = String(payload.type || '').trim();
  if (!name) throw new Error('Nama cabang wajib diisi.');
  if (['Mandiri', 'Central Kitchen'].indexOf(type) === -1) throw new Error('Tipe hanya Mandiri atau Central Kitchen.');
  const id = portalUpper_(payload.id || name).replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!id) throw new Error('Kode cabang tidak valid.');
  const url = portalValidateSpreadsheetUrl_(payload.url || '');
  const updates = {};
  updates['config/branches/' + id] = {
    code: id,
    name: name,
    type: type,
    active: payload.active !== false,
    updatedAt: portalNow_(),
    updatedBy: session.uid
  };
  const profiles = fbRead_('/profiles') || {};
  Object.keys(profiles).forEach(function(uid) {
    const profile = profiles[uid] || {};
    if (profile.branchId !== id) return;
    updates['profiles/' + uid + '/branchName'] = name;
    updates['profiles/' + uid + '/branchType'] = type;
  });
  if (url) {
    updates['config/spreadsheetLinks/' + period + '/' + id] = {
      url: url,
      branchName: name,
      updatedAt: portalNow_(),
      updatedBy: session.uid
    };
  } else {
    updates['config/spreadsheetLinks/' + period + '/' + id] = null;
  }
  fbUpdate_('/', updates);
  portalClearBranchCache_();
  Object.keys(profiles).forEach(function(uid) { if ((profiles[uid] || {}).branchId === id) portalClearProfileCache_(uid); });
  portalAudit_('UPSERT_MASTER_BRANCH', session.uid, { id: id, name: name, type: type, period: period });
  return { success: true, id: id };
}

function portalDeleteMasterBranch_(session, payload) {
  payload = payload || {};
  const id = portalUpper_(payload.id);
  const period = portalValidatePeriod_(payload.period || portalPeriod_(new Date()));
  if (!id) throw new Error('Cabang tidak ditemukan.');
  const branch = fbRead_('/config/branches/' + id);
  if (!branch) throw new Error('Cabang tidak ditemukan atau sudah dihapus.');
  const profiles = fbRead_('/profiles') || {};
  const receipts = fbRead_('/receipts') || {};
  const linkedAccounts = Object.keys(profiles).filter(function(uid) { return (profiles[uid] || {}).branchId === id; }).length;
  const receiptCount = Object.keys(receipts).filter(function(receiptId) { return (receipts[receiptId] || {}).branchId === id; }).length;
  if (linkedAccounts || receiptCount) throw new Error('Cabang masih dipakai ' + linkedAccounts + ' akun dan ' + receiptCount + ' riwayat nota; penghapusan diblokir.');
  const allLinks = fbRead_('/config/spreadsheetLinks') || {};
  const updates = {};
  updates['config/branches/' + id] = null;
  Object.keys(allLinks).forEach(function(linkPeriod) { updates['config/spreadsheetLinks/' + linkPeriod + '/' + id] = null; });
  fbUpdate_('/', updates);
  portalClearBranchCache_();
  portalAudit_('DELETE_MASTER_BRANCH', session.uid, { id: id, period: period });
  return { success: true };
}

function portalGetInternalBranches_(includeInactive) {
  let data = null;
  try { data = cacheGetJson_('PORTAL_INTERNAL_BRANCHES_V2'); } catch (error) {}
  if (!data) data = {};
  const hasCachedData = Object.keys(data).length > 0;
  if (!hasCachedData) {
    try {
      data = fbRead_('/config/branches') || {};
      if (Object.keys(data).length) cachePutJson_('PORTAL_INTERNAL_BRANCHES_V2', data, 90);
    } catch (error) {
      throw new Error('Konfigurasi cabang tidak dapat dimuat. Coba lagi beberapa saat.');
    }
  }
  if (!Object.keys(data).length) {
    try {
      const bootstrap = getBootstrapData_();
      if (bootstrap && Array.isArray(bootstrap.branches)) {
        return bootstrap.branches.map(function(b) {
          const tokoName = typeof b === 'string' ? b : (b.toko || b.name || '');
          const cleanId = portalUpper_(tokoName).replace(/[^A-Z0-9_]/g, '_');
          return {
            id: cleanId,
            name: tokoName,
            type: 'Mandiri',
            active: true
          };
        }).sort(function(a, b) { return a.name.localeCompare(b.name); });
      }
    } catch (e) {}
  }
  return Object.keys(data).map(function(key) {
    const branch = data[key] || {};
    return {
      id: key,
      name: branch.name || branch.nama || key,
      type: branch.type || branch.tipe || 'Mandiri',
      active: branch.active !== false && branch.aktif !== false
    };
  }).filter(function(branch) { return includeInactive || branch.active; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
}

function portalClearBranchCache_() {
  try { cacheRemoveJson_('PORTAL_INTERNAL_BRANCHES_V2'); } catch (error) {}
}

function portalMoveReceiptDate_(session, payload) { return tarikReceiptMutation_(session, payload, 'MOVE'); }

function portalEliminateReceipt_(session, payload) { return tarikReceiptMutation_(session, payload, 'ELIMINATE'); }

function portalRemoveRowMetadata_(sheet, rowIndex, receiptId) {
  const rowRange = sheet.getRange(rowIndex + ':' + rowIndex);
  const key = portalReceiptMetadataKey_(receiptId);
  rowRange.createDeveloperMetadataFinder().withKey(key).find().forEach(function(metadata) { metadata.remove(); });
}
