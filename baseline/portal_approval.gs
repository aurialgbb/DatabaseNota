/**
 * Durable approval queue. Firebase CAS protects receipt claims, worker slots,
 * and spreadsheet leases without serializing unrelated branches globally.
 */
const PORTAL_APPROVAL_MAX_JOB_ITEMS = 25;
const PORTAL_APPROVAL_MAX_RUN_ITEMS = 10;
const PORTAL_APPROVAL_RUN_BUDGET_MS = 210000;
const PORTAL_APPROVAL_LEASE_MS = 5 * 60 * 1000;
const PORTAL_APPROVAL_WORKER_SLOTS = 6;
const PORTAL_APPROVAL_ACTIVE_INDEX_VERSION = 1;

function portalApprovalSafeKey_(value) {
  return portalHash_(String(value || '')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 42);
}

function portalApprovalJobId_(session, clientRequestId) {
  return 'JOB-' + portalApprovalSafeKey_(session.uid + '|' + clientRequestId).slice(0, 20).toUpperCase();
}

function portalApprovalClaimPath_(receiptId) {
  return '/approvalClaims/' + portalApprovalSafeKey_(receiptId);
}

function portalAssertReceiptNotClaimed_(receiptId, allowedJobId) {
  const claim = fbRead_(portalApprovalClaimPath_(receiptId));
  if (!claim) return;
  if (allowedJobId && claim.jobId === allowedJobId) return;
  if (Number(claim.expiresAt || 0) <= portalNow_()) return;
  throw new Error('Nota sedang diproses oleh antrean approval ' + String(claim.jobId || '') + '.');
}

function portalAcquireApprovalClaim_(job, item) {
  const now = portalNow_();
  const path = portalApprovalClaimPath_(item.receiptId);
  const result = fbCompareAndSet_(path, function(current) {
    if (current && Number(current.expiresAt || 0) > now && current.jobId !== job.id) {
      return { abort:true, reason:'Nota sedang diproses job lain.' };
    }
    return { value:{
      receiptId:item.receiptId,
      jobId:job.id,
      itemId:item.id,
      uid:job.createdBy,
      displayName:job.createdByName || '',
      expectedVersion:item.expectedVersion,
      claimedAt:now,
      expiresAt:now + PORTAL_APPROVAL_LEASE_MS
    }};
  }, 5);
  if (!result.success) throw new Error(result.reason || 'Nota sedang diproses pengguna lain.');
}

function portalRenewApprovalClaim_(jobId, item) {
  const now = portalNow_();
  const result = fbCompareAndSet_(portalApprovalClaimPath_(item.receiptId), function(current) {
    if (!current || current.jobId !== jobId) return { abort:true, reason:'Claim approval tidak lagi dimiliki job ini.' };
    current.expiresAt = now + PORTAL_APPROVAL_LEASE_MS;
    current.heartbeatAt = now;
    return { value:current };
  }, 3);
  if (!result.success) throw new Error(result.reason || 'Claim approval berubah.');
}

function portalReleaseApprovalClaim_(jobId, receiptId) {
  try {
    fbCompareAndSet_(portalApprovalClaimPath_(receiptId), function(current) {
      if (!current || current.jobId !== jobId) return { abort:true };
      return { value:null };
    }, 3);
  } catch (error) {}
}

function portalApprovalLeaseKey_(spreadsheetUrl) {
  return portalApprovalSafeKey_(mutationSpreadsheetId_(spreadsheetUrl));
}

function portalAcquireSpreadsheetLease_(jobId, itemId, spreadsheetUrl) {
  const operationId = 'APPROVAL-' + mutationKey_(jobId + '|' + itemId);
  const executionId = mutationUuid_();
  try {
    const path = mutationScopeAcquire_('sheet/' + mutationSpreadsheetId_(spreadsheetUrl), operationId, executionId);
    return { path:path, operationId:operationId, executionId:executionId };
  } catch (error) { return null; }
}

function portalReleaseSpreadsheetLease_(lease, jobId, itemId) {
  if (lease) mutationScopeRelease_(lease.path, lease.operationId, lease.executionId);
}

function portalAcquireWorkerSlot_(jobId) {
  const now = portalNow_();
  for (let slot = 0; slot < PORTAL_APPROVAL_WORKER_SLOTS; slot++) {
    const path = '/approvalWorkerSlots/' + slot;
    const result = fbCompareAndSet_(path, function(current) {
      if (current && Number(current.expiresAt || 0) > now && current.jobId !== jobId) return { abort:true };
      return { value:{ slot:slot, jobId:jobId, acquiredAt:now, expiresAt:now + PORTAL_APPROVAL_LEASE_MS } };
    }, 2);
    if (result.success) return { slot:slot, path:path };
  }
  return null;
}

function portalReleaseWorkerSlot_(workerSlot, jobId) {
  if (!workerSlot) return;
  try {
    fbCompareAndSet_(workerSlot.path, function(current) {
      if (!current || current.jobId !== jobId) return { abort:true };
      return { value:null };
    }, 3);
  } catch (error) {}
}

function portalApprovalPublicJob_(job) {
  if (!job) return null;
  const itemsObject = job.items || {};
  const liveCounts = portalApprovalCounts_(itemsObject);
  const liveStatus = portalUpper_(job.status) === 'CANCELLED' ? 'CANCELLED' : portalApprovalStatus_(liveCounts);
  const items = Object.keys(itemsObject).sort().map(function(key) {
    const item = itemsObject[key] || {};
    return {
      id:item.id || key,
      receiptId:item.receiptId || '',
      displayNumber:item.displayNumber || '',
      decision:item.decision || '',
      status:item.status || 'QUEUED',
      error:item.error || '',
      attempts:Number(item.attempts || 0),
      startedAt:Number(item.startedAt || 0),
      completedAt:Number(item.completedAt || 0)
    };
  });
  return {
    id:job.id,
    status:liveStatus,
    createdAt:Number(job.createdAt || 0),
    updatedAt:Number(job.updatedAt || 0),
    completedAt:Number(job.completedAt || 0),
    counts:liveCounts,
    items:items
  };
}

function portalApprovalJobIsActive_(job) {
  return job && ['QUEUED', 'PROCESSING', 'PARTIAL', 'RECOVERY_REQUIRED'].indexOf(portalUpper_(job.status || '')) >= 0;
}

function portalSyncApprovalActiveIndex_(job) {
  if (!job || !job.id || !job.createdBy) return;
  const updates = {};
  const summary = portalApprovalPublicJob_(job);
  summary.createdBy = job.createdBy;
  updates['approvalActiveMeta/version'] = PORTAL_APPROVAL_ACTIVE_INDEX_VERSION;
  updates['approvalActiveAll/' + job.id] = portalApprovalJobIsActive_(job) ? summary : null;
  updates['approvalActiveByUser/' + portalApprovalSafeKey_(job.createdBy) + '/' + job.id] = portalApprovalJobIsActive_(job) ? summary : null;
  fbUpdate_('/', updates);
}

function portalEnsureApprovalActiveIndex_() {
  const version = Number(fbRead_('/approvalActiveMeta/version') || 0);
  if (version === PORTAL_APPROVAL_ACTIVE_INDEX_VERSION) return;
  const jobs = fbRead_('/approvalJobs') || {};
  Object.keys(jobs).forEach(function(jobId) {
    const job = jobs[jobId];
    if (portalApprovalJobIsActive_(job)) portalSyncApprovalActiveIndex_(job);
  });
  fbWrite_('/approvalActiveMeta/version', PORTAL_APPROVAL_ACTIVE_INDEX_VERSION);
}

/**
 * Memindahkan ownership job yang masih aktif ketika Firebase credential akun
 * diganti. Job historis tetap menunjuk UID lama agar audit trail tidak berubah.
 */
function portalBuildApprovalOwnershipTransferUpdates_(oldUid, newUid) {
  const updates = {};
  if (!oldUid || !newUid || oldUid === newUid) return updates;
  portalEnsureApprovalActiveIndex_();
  const oldKey = portalApprovalSafeKey_(oldUid);
  const newKey = portalApprovalSafeKey_(newUid);
  const active = fbRead_('/approvalActiveByUser/' + oldKey) || {};
  Object.keys(active).forEach(function(jobId) {
    const job = fbRead_('/approvalJobs/' + jobId);
    if (!portalApprovalJobIsActive_(job) || job.createdBy !== oldUid) return;
    const migrated = Object.assign({}, job, { createdBy:newUid });
    const summary = portalApprovalPublicJob_(migrated);
    summary.createdBy = newUid;
    updates['approvalJobs/' + jobId + '/createdBy'] = newUid;
    updates['approvalActiveByUser/' + oldKey + '/' + jobId] = null;
    updates['approvalActiveByUser/' + newKey + '/' + jobId] = summary;
    updates['approvalActiveAll/' + jobId] = summary;
  });
  return updates;
}

function portalApprovalCounts_(items) {
  const counts = { total:0, queued:0, processing:0, succeeded:0, failed:0, recoveryRequired:0, cancelled:0 };
  Object.keys(items || {}).forEach(function(key) {
    counts.total++;
    const status = portalUpper_((items[key] || {}).status || 'QUEUED');
    if (status === 'QUEUED') counts.queued++;
    else if (status === 'PROCESSING') counts.processing++;
    else if (status === 'SUCCEEDED') counts.succeeded++;
    else if (status === 'RECOVERY_REQUIRED') counts.recoveryRequired++;
    else if (status === 'CANCELLED') counts.cancelled++;
    else counts.failed++;
  });
  return counts;
}

function portalApprovalStatus_(counts) {
  if (counts.processing > 0) return 'PROCESSING';
  if (counts.queued > 0) return counts.succeeded || counts.failed || counts.recoveryRequired ? 'PARTIAL' : 'QUEUED';
  if (counts.recoveryRequired > 0) return 'RECOVERY_REQUIRED';
  if (counts.failed > 0) return counts.succeeded > 0 ? 'PARTIAL' : 'FAILED';
  if (counts.cancelled === counts.total) return 'CANCELLED';
  return 'SUCCEEDED';
}

function portalEnforceApprovalRateLimit_(session) {
  const windowKey = 'APPROVAL_RATE_' + portalApprovalSafeKey_(session.uid) + '_' + Math.floor(portalNow_() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get(windowKey) || 0);
    if (count >= 5) throw new Error('Terlalu banyak job approval dibuat dalam satu menit. Tunggu sebentar lalu coba lagi.');
    cache.put(windowKey, String(count + 1), 90);
  } finally { lock.releaseLock(); }
}

function portalCreateApprovalJob_(session, payload) {
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  if (!decisions.length) throw new Error('Belum ada keputusan yang dipilih.');
  if (decisions.length > PORTAL_APPROVAL_MAX_JOB_ITEMS) throw new Error('Maksimal 25 nota per job approval.');
  const requestId = String(payload.clientRequestId || '').trim();
  if (!requestId || requestId.length > 100) throw new Error('Request ID approval tidak valid.');
  const jobId = portalApprovalJobId_(session, requestId);
  const existing = fbRead_('/approvalJobs/' + jobId);
  if (existing) {
    if (existing.createdBy !== session.uid || existing.payloadHash !== mutationKey_(mutationCanonical_(decisions))) throw new Error('Request ID sudah digunakan untuk keputusan berbeda.');
    return portalApprovalPublicJob_(existing);
  }
  portalEnforceApprovalRateLimit_(session);
  const seen = {};
  const items = {};
  decisions.forEach(function(decision, index) {
    const receiptId = String(decision.receiptId || '').trim();
    const requestedAction = portalUpper_(decision.decision);
    const action = requestedAction === 'REJECT' ? 'REQUEST_CORRECTION' : requestedAction;
    if (!receiptId || seen[receiptId]) throw new Error('Daftar keputusan memuat nota kosong atau duplikat.');
    if (['APPROVE', 'REQUEST_CORRECTION', 'DISCARD'].indexOf(action) === -1) throw new Error('Keputusan harus Setujui, Perlu Perbaikan, atau Tidak Digunakan.');
    const reason = String(decision.reason || '').trim();
    if (action === 'REQUEST_CORRECTION' && !reason) throw new Error('Keterangan perbaikan wajib diisi.');
    seen[receiptId] = true;
    const itemId = 'I' + String(index + 1).padStart(3, '0');
    items[itemId] = {
      id:itemId,
      receiptId:receiptId,
      displayNumber:String(decision.displayNumber || ''),
      decision:action,
      reason:action === 'DISCARD' ? '' : reason.slice(0, 500),
      expectedVersion:Number(decision.expectedVersion || 0),
      status:'QUEUED',
      attempts:0,
      createdAt:portalNow_()
    };
  });
  const now = portalNow_();
  const job = {
    id:jobId,
    clientRequestId:requestId,
    payloadHash:mutationKey_(mutationCanonical_(decisions)),
    createdBy:session.uid,
    createdByName:session.displayName || session.username || '',
    createdByRole:session.role || 'TAX',
    status:'QUEUED',
    createdAt:now,
    updatedAt:now,
    items:items,
    counts:portalApprovalCounts_(items)
  };
  const created = fbCompareAndSet_('/approvalJobs/' + jobId, function(current) {
    if (current) return { abort:true, reason:'Job sudah dibuat.' };
    return { value:job };
  }, 3);
  if (!created.success) {
    const concurrent = fbRead_('/approvalJobs/' + jobId);
    if (concurrent && concurrent.createdBy === session.uid && concurrent.payloadHash === mutationKey_(mutationCanonical_(decisions))) return portalApprovalPublicJob_(concurrent);
    throw new Error('Job approval tidak dapat dibuat. Coba lagi.');
  }
  Object.keys(items).forEach(function(itemId) {
    try {
      const receipt = fbRead_('/receipts/' + items[itemId].receiptId);
      if (!receipt || receipt.status !== 'PENDING') throw new Error('Nota tidak lagi Pending.');
      if (items[itemId].expectedVersion && items[itemId].expectedVersion !== Number(receipt.version || 1)) throw new Error('Nota sudah berubah; muat ulang.');
      portalAcquireApprovalClaim_(job, items[itemId]);
    } catch (error) {
      items[itemId].status = 'FAILED';
      items[itemId].error = String(error.message || error).slice(0, 500);
      items[itemId].completedAt = portalNow_();
    }
  });
  job.items = items;
  job.counts = portalApprovalCounts_(items);
  job.status = portalApprovalStatus_(job.counts);
  job.updatedAt = portalNow_();
  fbWrite_('/approvalJobs/' + jobId, job);
  portalSyncApprovalActiveIndex_(job);
  portalAudit_('CREATE_APPROVAL_JOB', session.uid, { jobId:jobId, total:job.counts.total });
  return portalApprovalPublicJob_(job);
}

function portalGetApprovalJob_(session, payload) {
  const job = fbRead_('/approvalJobs/' + String(payload.jobId || ''));
  if (!job) throw new Error('Job approval tidak ditemukan.');
  if (session.role !== 'ADMIN' && job.createdBy !== session.uid) throw new Error('Anda tidak memiliki akses ke job ini.');
  return portalApprovalPublicJob_(job);
}

function portalListActiveApprovalJobs_(session) {
  portalEnsureApprovalActiveIndex_();
  const path = session.role === 'ADMIN' ? '/approvalActiveAll' : '/approvalActiveByUser/' + portalApprovalSafeKey_(session.uid);
  const jobs = fbRead_(path) || {};
  return Object.keys(jobs).map(function(key) { return jobs[key]; }).filter(function(job) {
    return portalApprovalJobIsActive_(job) && (session.role === 'ADMIN' || job.createdBy === session.uid);
  }).sort(function(a, b) { return Number(b.createdAt || 0) - Number(a.createdAt || 0); }).slice(0, 20).map(function(job) {
    const result = JSON.parse(JSON.stringify(job));
    delete result.createdBy;
    return result;
  });
}

function portalClaimApprovalItem_(jobId, itemId) {
  const path = '/approvalJobs/' + jobId + '/items/' + itemId;
  const now = portalNow_();
  const result = fbCompareAndSet_(path, function(item) {
    if (!item || portalUpper_(item.status) !== 'QUEUED') return { abort:true };
    item.status = 'PROCESSING';
    item.startedAt = now;
    item.attempts = Number(item.attempts || 0) + 1;
    item.error = '';
    return { value:item };
  }, 4);
  return result.success ? fbRead_(path) : null;
}

function portalCompleteApprovalItem_(jobId, item, status, error) {
  const path = '/approvalJobs/' + jobId + '/items/' + item.id;
  fbCompareAndSet_(path, function(current) {
    if (!current) return { abort:true };
    current.status = status;
    current.error = String(error || '').slice(0, 500);
    current.completedAt = portalNow_();
    return { value:current };
  }, 4);
}

function portalRefreshApprovalJob_(jobId) {
  const path = '/approvalJobs/' + jobId;
  fbCompareAndSet_(path, function(job) {
    if (!job) return { abort:true };
    job.counts = portalApprovalCounts_(job.items || {});
    job.status = portalApprovalStatus_(job.counts);
    job.updatedAt = portalNow_();
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].indexOf(job.status) >= 0) job.completedAt = job.updatedAt;
    return { value:job };
  }, 5);
  const refreshed = fbRead_(path);
  portalSyncApprovalActiveIndex_(refreshed);
  return refreshed;
}

function portalResetStaleApprovalItems_(job) {
  const now = portalNow_();
  let changed = false;
  Object.keys(job.items || {}).forEach(function(itemId) {
    const item = job.items[itemId];
    if (item.status !== 'PROCESSING' || now - Number(item.startedAt || 0) <= PORTAL_APPROVAL_LEASE_MS) return;
    const receipt = fbRead_('/receipts/' + item.receiptId);
    if (receipt && ['PENDING', 'APPROVING'].indexOf(receipt.status) >= 0) {
      item.status = 'QUEUED';
      item.error = 'Worker sebelumnya berhenti; proses dilanjutkan secara idempoten.';
      item.startedAt = null;
      try { portalAcquireApprovalClaim_(job, item); } catch (error) {
        item.status = 'FAILED';
        item.error = String(error.message || error).slice(0, 500);
        item.completedAt = now;
      }
    } else if (receipt && item.decision === 'DISCARD' && receipt.status === 'REJECTED' && receipt.review && receipt.review.decision === 'DISCARD') {
      item.status = 'SUCCEEDED';
      item.error = '';
      item.completedAt = now;
    } else if (receipt && receipt.status === 'APPROVAL_RECOVERY_REQUIRED') {
      item.status = 'RECOVERY_REQUIRED';
      item.error = receipt.approvalError || 'Nota memerlukan rekonsiliasi approval.';
      item.completedAt = now;
    } else {
      item.status = 'FAILED';
      item.error = 'Status nota berubah ketika worker terputus.';
      item.completedAt = now;
    }
    changed = true;
  });
  if (changed) {
    job.counts = portalApprovalCounts_(job.items);
    job.status = portalApprovalStatus_(job.counts);
    job.updatedAt = now;
    fbWrite_('/approvalJobs/' + job.id, job);
    portalSyncApprovalActiveIndex_(job);
  }
  return job;
}

function portalProcessApprovalItem_(session, job, item) {
  let sheetLease = null;
  try {
    portalRenewApprovalClaim_(job.id, item);
    const receipt = fbRead_('/receipts/' + item.receiptId);
    if (!receipt) throw new Error('Nota tidak ditemukan.');
    const discardAlreadyApplied = item.decision === 'DISCARD' && receipt.status === 'REJECTED' && receipt.review && receipt.review.decision === 'DISCARD';
    if (item.decision === 'APPROVE' && receipt.status === 'APPROVED') { portalCompleteApprovalItem_(job.id, item, 'SUCCEEDED', ''); portalReleaseApprovalClaim_(job.id, item.receiptId); return { success:true }; }
    if (!discardAlreadyApplied && item.expectedVersion && Number(receipt.version || 1) !== Number(item.expectedVersion)) throw new Error('Nota sudah berubah; review ulang diperlukan.');
    if (item.decision === 'APPROVE') {
      portalApproveReceiptCore_(session, item.receiptId, item.expectedVersion);
    } else if (item.decision === 'DISCARD') {
      portalDiscardReceiptCore_(session, item.receiptId, item.expectedVersion);
    } else {
      portalRejectReceiptCore_(session, item.receiptId, item.reason, item.expectedVersion);
    }
    portalCompleteApprovalItem_(job.id, item, 'SUCCEEDED', '');
    portalReleaseApprovalClaim_(job.id, item.receiptId);
    return { success:true };
  } catch (error) {
    let status = /Perlu dilanjutkan/.test(String(error.message || error)) ? 'RECOVERY_REQUIRED' : 'FAILED';
    try {
      const latest = fbRead_('/receipts/' + item.receiptId);
      if (latest && ['APPROVING', 'APPROVAL_RECOVERY_REQUIRED'].indexOf(latest.status) >= 0) status = 'RECOVERY_REQUIRED';
    } catch (ignored) {}
    portalCompleteApprovalItem_(job.id, item, status, error.message || error);
    portalReleaseApprovalClaim_(job.id, item.receiptId);
    return { success:false, error:String(error.message || error) };
  } finally {
    portalReleaseSpreadsheetLease_(sheetLease, job.id, item.id);
  }
}

function portalRunApprovalJob_(session, payload) {
  const jobId = String(payload.jobId || '');
  const job = fbRead_('/approvalJobs/' + jobId);
  if (!job) throw new Error('Job approval tidak ditemukan.');
  if (session.role !== 'ADMIN' && job.createdBy !== session.uid) throw new Error('Anda tidak memiliki akses ke job ini.');
  return portalRunApprovalJobCore_(session, jobId);
}

function portalRunApprovalJobCore_(session, jobId) {
  let job = fbRead_('/approvalJobs/' + jobId);
  if (!job) throw new Error('Job approval tidak ditemukan.');
  const workerSlot = portalAcquireWorkerSlot_(jobId);
  if (!workerSlot) return { busy:true, job:portalApprovalPublicJob_(job) };
  const startedAt = portalNow_();
  let processed = 0;
  try {
    job = portalResetStaleApprovalItems_(job);
    fbUpdate_('/approvalJobs/' + jobId, { status:'PROCESSING', updatedAt:portalNow_(), lastWorkerBy:session.uid });
    const itemIds = Object.keys(job.items || {}).sort();
    for (let index = 0; index < itemIds.length; index++) {
      if (processed >= PORTAL_APPROVAL_MAX_RUN_ITEMS || portalNow_() - startedAt >= PORTAL_APPROVAL_RUN_BUDGET_MS) break;
      const item = portalClaimApprovalItem_(jobId, itemIds[index]);
      if (!item) continue;
      const outcome = portalProcessApprovalItem_(session, job, item);
      if (outcome.deferred) {
        fbUpdate_('/approvalJobs/' + jobId + '/items/' + item.id, { status:'QUEUED', startedAt:null, error:'' });
        continue;
      }
      processed++;
    }
    job = portalRefreshApprovalJob_(jobId);
    portalClearReceiptsCache_();
    return { busy:false, processed:processed, job:portalApprovalPublicJob_(job) };
  } finally {
    portalReleaseWorkerSlot_(workerSlot, jobId);
  }
}

function portalBackgroundWorkersEnabled_() {
  return portalUpper_(PropertiesService.getScriptProperties().getProperty('PORTAL_BACKGROUND_WORKERS_ENABLED') || '') === 'TRUE';
}

function portalDrainApprovalBackground_(startedAt) {
  portalEnsureApprovalActiveIndex_();
  const active = fbRead_('/approvalActiveAll') || {};
  const candidates = Object.keys(active).map(function(jobId) { return active[jobId]; }).filter(function(job) {
    return job && ['QUEUED', 'PROCESSING', 'PARTIAL'].indexOf(portalUpper_(job.status || '')) >= 0;
  }).sort(function(a, b) { return Number(a.createdAt || 0) - Number(b.createdAt || 0); });
  if (!candidates.length || portalNow_() - startedAt >= 180000) return 0;
  const job = fbRead_('/approvalJobs/' + candidates[0].id);
  if (!job) return 0;
  const actor = { uid:job.createdBy, role:job.createdByRole || 'TAX', displayName:job.createdByName || '', username:job.createdByName || '' };
  const result = portalRunApprovalJobCore_(actor, job.id);
  return Number(result && result.processed || 0);
}

function portalMaybeFinalizeQueuedUpload_(uploadId) {
  const upload = fbRead_('/uploads/' + uploadId);
  if (!upload || upload.status === 'SUBMITTED') return;
  const jobs = upload.jobs || {};
  const rows = Object.keys(jobs).map(function(key) { return jobs[key]; });
  const expected = Number(upload.expectedPhotos || 0);
  if (!expected || rows.length < expected || rows.some(function(job) { return !job || !job.result || ['DONE', 'FAILED'].indexOf(job.status) === -1; })) return;
  const results = rows.sort(function(a, b) { return Number(a.index || 0) - Number(b.index || 0); }).map(function(job) { return job.result; });
  fbUpdate_('/uploads/' + uploadId, { status:'READY_TO_SUBMIT', ocrResults:results, updatedAt:portalNow_() });
}

function portalDrainOcrBackground_(startedAt, maxItems) {
  const queued = fbRead_('/ocrQueue') || {};
  const entries = Object.keys(queued).map(function(key) { return queued[key]; }).filter(Boolean).sort(function(a, b) {
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
  let processed = 0;
  for (let index = 0; index < entries.length; index++) {
    if (processed >= Number(maxItems || 4) || portalNow_() - startedAt >= 210000) break;
    const entry = entries[index];
    const upload = fbRead_('/uploads/' + entry.uploadId);
    const job = upload && upload.jobs && upload.jobs[entry.clientPhotoId];
    if (!upload || !job || (job.result && ['DONE', 'FAILED'].indexOf(job.status) >= 0)) {
      fbWrite_('/ocrQueue/' + entry.queueKey, null);
      continue;
    }
    const actor = { uid:upload.createdBy, role:'TOKO', branchId:upload.branchId, branchName:upload.branchName || upload.branchId };
    try {
      const result = portalExecuteQueuedOcrJob_(actor, entry.uploadId, entry.clientPhotoId, null);
      if (result && !result.pending) {
        processed++;
        portalMaybeFinalizeQueuedUpload_(entry.uploadId);
      }
    } catch (error) {
      const failed = { success:false, pending:false, clientPhotoId:entry.clientPhotoId, index:Number(job.index || 0), photoId:job.photoId || '', fileName:job.fileName || '', receipts:[], warnings:['Background OCR gagal memproses foto.'], error:String(error.message || error) };
      const updates = {};
      updates['uploads/' + entry.uploadId + '/jobs/' + entry.clientPhotoId] = Object.assign({}, job, { status:'FAILED', finishedAt:portalNow_(), result:failed });
      updates['ocrQueue/' + entry.queueKey] = null;
      fbUpdate_('/', updates);
      processed++;
    }
  }
  return processed;
}

/** Trigger fallback; tidak aktif sampai Script Property diaktifkan secara eksplisit. */
function portalBackgroundWorker_() {
  if (!portalBackgroundWorkersEnabled_()) return { enabled:false };
  const startedAt = portalNow_();
  const approvals = portalDrainApprovalBackground_(startedAt);
  const ocr = portalDrainOcrBackground_(startedAt, 4);
  return { enabled:true, approvals:approvals, ocr:ocr, durationMs:portalNow_() - startedAt };
}

function portalInstallDevBackgroundWorker_() {
  if (!portalBackgroundWorkersEnabled_()) throw new Error('Aktifkan PORTAL_BACKGROUND_WORKERS_ENABLED=TRUE terlebih dahulu.');
  const existing = ScriptApp.getProjectTriggers().filter(function(trigger) { return trigger.getHandlerFunction() === 'portalBackgroundWorker_'; });
  if (!existing.length) ScriptApp.newTrigger('portalBackgroundWorker_').timeBased().everyMinutes(1).create();
  return { installed:true, triggerCount:Math.max(1, existing.length) };
}

function portalDisableDevBackgroundWorker_() {
  PropertiesService.getScriptProperties().setProperty('PORTAL_BACKGROUND_WORKERS_ENABLED', 'FALSE');
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'portalBackgroundWorker_') { ScriptApp.deleteTrigger(trigger); removed++; }
  });
  return { disabled:true, removed:removed };
}

function portalRetryApprovalJobItems_(session, payload) {
  const jobId = String(payload.jobId || '');
  const job = fbRead_('/approvalJobs/' + jobId);
  if (!job) throw new Error('Job approval tidak ditemukan.');
  if (session.role !== 'ADMIN' && job.createdBy !== session.uid) throw new Error('Anda tidak memiliki akses ke job ini.');
  const settledCounts = portalApprovalCounts_(job.items || {});
  if (Number(settledCounts.queued || 0) > 0 || Number(settledCounts.processing || 0) > 0) {
    throw new Error('Tunggu proses approval yang masih berjalan sebelum mencoba kembali.');
  }
  const requested = Array.isArray(payload.itemIds) ? payload.itemIds : [];
  const wanted = {};
  requested.forEach(function(id) { wanted[String(id)] = true; });
  Object.keys(job.items || {}).forEach(function(itemId) {
    const item = job.items[itemId];
    if (requested.length && !wanted[itemId]) return;
    if (['FAILED', 'RECOVERY_REQUIRED'].indexOf(item.status) === -1) return;
    const receipt = fbRead_('/receipts/' + item.receiptId);
    const retryable = receipt && (
      receipt.status === 'PENDING' ||
      (item.decision === 'APPROVE' && receipt.status === 'APPROVAL_RECOVERY_REQUIRED')
    );
    if (!retryable) return;
    item.expectedVersion = Number(receipt.version || 1);
    item.status = 'QUEUED';
    item.error = '';
    item.completedAt = null;
    portalAcquireApprovalClaim_(job, item);
  });
  job.counts = portalApprovalCounts_(job.items);
  job.status = portalApprovalStatus_(job.counts);
  job.updatedAt = portalNow_();
  fbWrite_('/approvalJobs/' + jobId, job);
  portalSyncApprovalActiveIndex_(job);
  return portalApprovalPublicJob_(job);
}

function portalCancelApprovalJob_(session, payload) {
  const jobId = String(payload.jobId || '');
  const job = fbRead_('/approvalJobs/' + jobId);
  if (!job) throw new Error('Job approval tidak ditemukan.');
  if (session.role !== 'ADMIN' && job.createdBy !== session.uid) throw new Error('Anda tidak memiliki akses ke job ini.');
  Object.keys(job.items || {}).forEach(function(itemId) {
    const item = job.items[itemId];
    if (item.status !== 'QUEUED') return;
    item.status = 'CANCELLED';
    item.completedAt = portalNow_();
    portalReleaseApprovalClaim_(jobId, item.receiptId);
  });
  job.counts = portalApprovalCounts_(job.items);
  job.status = portalApprovalStatus_(job.counts);
  job.updatedAt = portalNow_();
  fbWrite_('/approvalJobs/' + jobId, job);
  portalSyncApprovalActiveIndex_(job);
  return portalApprovalPublicJob_(job);
}

/** Soft claim untuk mengurangi dua reviewer mengedit nota yang sama. */
function portalClaimReceiptReview_(session, payload) {
  const receiptId = String(payload.receiptId || '');
  const takeover = payload.takeover === true;
  if (!receiptId) throw new Error('ID nota wajib diisi.');
  const path = '/receiptReviewClaims/' + portalApprovalSafeKey_(receiptId);
  const now = portalNow_();
  const result = fbCompareAndSet_(path, function(current) {
    if (current && Number(current.expiresAt || 0) > now && current.uid !== session.uid && !takeover) {
      return { abort:true, reason:'Nota sedang direview oleh ' + String(current.displayName || 'pengguna lain') + '.' };
    }
    return { value:{ receiptId:receiptId, uid:session.uid, displayName:session.displayName || session.username || '', claimedAt:now, expiresAt:now + 90000 } };
  }, 4);
  if (!result.success) return { success:false, occupied:true, message:result.reason, claim:result.current || null };
  return { success:true, claim:result.data };
}

function portalReleaseReceiptReview_(session, payload) {
  const receiptId = String(payload.receiptId || '');
  if (!receiptId) return { success:true };
  fbCompareAndSet_('/receiptReviewClaims/' + portalApprovalSafeKey_(receiptId), function(current) {
    if (!current || current.uid !== session.uid) return { abort:true };
    return { value:null };
  }, 3);
  return { success:true };
}

function portalGetApprovalRecovery_(session, payload) {
  return portalQueryReceiptIndex_({
    status:'APPROVAL_RECOVERY_REQUIRED',
    branchId:'', dateFrom:'', dateTo:'',
    cursor:String(payload.cursor || ''),
    limit:Math.min(50, Math.max(1, Number(payload.limit || 25)))
  });
}

function portalGetOperationalEvents_(session, payload) {
  const month = /^\d{6}$/.test(String(payload.month || '')) ? String(payload.month) : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMM');
  const events = fbRead_('/operationalEvents/' + month) || {};
  return Object.keys(events).map(function(key) { return events[key]; }).filter(Boolean).sort(function(a, b) {
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  }).slice(0, Math.min(200, Math.max(1, Number(payload.limit || 100))));
}

/** Fondasi backup manual; tidak memasang trigger dan tidak membaca sesi/token. */
function portalCreateBackup_(session) {
  const folderId = String(PropertiesService.getScriptProperties().getProperty('PORTAL_BACKUP_FOLDER_ID') || '');
  if (!folderId) throw new Error('PORTAL_BACKUP_FOLDER_ID belum dikonfigurasi.');
  const now = new Date();
  const snapshot = {
    schemaVersion:1, buildId:PORTAL_BUILD_ID, createdAt:now.getTime(), createdBy:session.uid,
    config:fbRead_('/config') || {},
    profiles:fbRead_('/profiles') || {},
    receipts:fbRead_('/receipts') || {},
    receiptIndexV1:fbRead_('/receiptIndexV1') || {},
    receiptCountsV1:fbRead_('/receiptCountsV1') || {},
    sheetMappings:fbRead_('/sheetMappings') || {},
    photos:fbRead_('/photos') || {}
  };
  const json = JSON.stringify(snapshot);
  const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json)).replace(/=+$/g, '');
  const name = 'database-nota-backup-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.json';
  const file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(json, 'application/json', name));
  portalAudit_('CREATE_PORTAL_BACKUP', session.uid, { fileId:file.getId(), checksum:digest, bytes:json.length });
  return { success:true, fileId:file.getId(), fileName:name, checksum:digest, bytes:json.length };
}

function portalValidateBackup_(session, payload) {
  const fileId = String(payload.fileId || '');
  if (!fileId) throw new Error('File backup wajib dipilih.');
  const text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
  const snapshot = JSON.parse(text);
  if (Number(snapshot.schemaVersion || 0) !== 1 || !snapshot.receipts || !snapshot.receiptIndexV1) throw new Error('Struktur backup tidak valid.');
  const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)).replace(/=+$/g, '');
  return {
    valid:true, checksum:digest, createdAt:Number(snapshot.createdAt || 0), buildId:String(snapshot.buildId || ''),
    receiptCount:Object.keys(snapshot.receipts || {}).length,
    profileCount:Object.keys(snapshot.profiles || {}).length
  };
}
