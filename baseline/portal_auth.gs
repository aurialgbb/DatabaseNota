/**
 * Public endpoint: status setup awal. Tidak mengembalikan nilai key/secret.
 */
const PORTAL_DEV_RECOVERY_VERSION = '2026.08.20-2148';
const PORTAL_MAX_PROVISION_BATCH = 25;

function portalAuthFailure_(stage, error) {
  const id = Utilities.getUuid();
  const message = String(error && error.message || '');
  const status = message.match(/(?:HTTP\s*|Error\s*\()(\d{3})/i);
  // Never log the original message: provider errors can contain credentials.
  console.error(JSON.stringify({ event:'PORTAL_AUTH_FAILURE', id:id, stage:stage,
    status:status ? Number(status[1]) : null, buildId:PORTAL_BUILD_ID }));
  return 'Layanan akun belum dapat diakses. Kode pemeriksaan: ' + stage + '-' + id;
}

function getPortalSetupStatus() {
  const props = PropertiesService.getScriptProperties();
  const firebaseAuthMode = String(props.getProperty('FIREBASE_AUTH_MODE') || '').trim().toUpperCase();
  const firebaseCredentialProperties = firebaseAuthMode === 'SERVICE_ACCOUNT'
    ? ['FIREBASE_SERVICE_ACCOUNT_EMAIL', 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY']
    : (firebaseAuthMode === 'OAUTH' ? [] : ['FIREBASE_SECRET']);
  const required = ['FIREBASE_DB_URL', 'FIREBASE_WEB_API_KEY', 'FOLDER_PARENT_ID', 'GEMINI_API_KEY'].concat(firebaseCredentialProperties);
  const missing = required.filter(function(name) { return !props.getProperty(name); });
  const recoveryMode = portalDevRecoveryRequested_(props);
  let hasAdmin = false;
  let adminRecordCount = 0;
  let databaseReady = ['FIREBASE_DB_URL'].concat(firebaseCredentialProperties).every(function(name) {
    return missing.indexOf(name) === -1;
  });
  let diagnostic = '';
  if (databaseReady) {
    try {
      const profiles = fbRead_('/profiles') || {};
      adminRecordCount = Object.keys(profiles).filter(function(uid) {
        return profiles[uid] && profiles[uid].role === 'ADMIN';
      }).length;
      hasAdmin = Object.keys(profiles).some(function(uid) {
        return portalIsUsableAdminProfile_(profiles[uid], uid);
      });
    } catch (error) {
      databaseReady = false;
      diagnostic = portalAuthFailure_('SETUP', error);
    }
  }
  return {
    ready: missing.length === 0 && hasAdmin && !recoveryMode,
    missingProperties: missing,
    hasAdmin: hasAdmin && !recoveryMode,
    adminRecordCount: adminRecordCount,
    databaseReady: databaseReady,
    diagnostic: diagnostic,
    recoveryMode: recoveryMode,
    bootstrapSecretConfigured: !!props.getProperty('PORTAL_BOOTSTRAP_SECRET')
  };
}

/**
 * Endpoint bootstrap satu kali. Secret wajib disiapkan manual di Script
 * Properties sebagai PORTAL_BOOTSTRAP_SECRET dan dihapus setelah berhasil.
 */
function bootstrapPortalAdmin(payload) {
  const startedAt = portalNow_();
  payload = payload || {};
  const props = PropertiesService.getScriptProperties();
  const configuredSecret = String(props.getProperty('PORTAL_BOOTSTRAP_SECRET') || '');
  const suppliedSecret = String(payload.bootstrapSecret || payload.setupSecret || '');
  if (configuredSecret.length < 24 || !suppliedSecret || portalHash_(configuredSecret) !== portalHash_(suppliedSecret)) {
    throw new Error('Bootstrap administrator tidak diizinkan. Periksa secret setup satu kali.');
  }

  const username = portalValidateNewAuthUsername_(payload.username);
  const password = portalValidatePassword_(payload.password);
  const displayName = String(payload.displayName || 'Administrator').trim();
  if (!displayName) throw new Error('Nama administrator wajib diisi.');
  const email = portalUsernameEmail_(username);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Seluruh invariant dibaca ulang setelah lock didapat supaya dua request
    // bootstrap tidak dapat sama-sama lolos dari kondisi awal yang sama.
    const recoveryMode = portalDevRecoveryRequested_(props);
    const profiles = fbRead_('/profiles') || {};
    const alreadyHasAdmin = Object.keys(profiles).some(function(uid) {
      return portalIsUsableAdminProfile_(profiles[uid], uid);
    });
    if (alreadyHasAdmin && !recoveryMode) throw new Error('Admin pertama sudah dibuat. Silakan login.');
    portalAssertUsernameAvailable_(username, '', profiles, fbRead_('/usernameIndex') || {});

    let auth;
    try {
      auth = portalFirebaseAuthRequest_('accounts:signUp', {
        email: email,
        password: password,
        returnSecureToken: true
      });
    } catch (error) {
      // Memulihkan identitas Auth orphan hanya setelah caller membuktikan secret
      // bootstrap dan password identitas tersebut.
      if (!/EMAIL_EXISTS/i.test(error && error.message ? error.message : '')) throw error;
      auth = portalFirebaseAuthRequest_('accounts:signInWithPassword', {
        email: email,
        password: password,
        returnSecureToken: true
      });
    }

    const profile = {
      uid: auth.localId,
      username: username,
      authEmail: email,
      displayName: displayName,
      role: 'ADMIN',
      branchId: '',
      branchName: '',
      active: true,
      mustChangePassword: false,
      createdAt: portalNow_(),
      createdBy: recoveryMode ? 'RECOVERY_BOOTSTRAP' : 'INITIAL_BOOTSTRAP'
    };
    const updates = {};
    updates['profiles/' + auth.localId] = profile;
    updates['usernameIndex/' + portalUsernameKey_(username)] = auth.localId;
    fbUpdate_('/', updates);

    if (recoveryMode) props.setProperty('PORTAL_DEV_RECOVERY_DONE', PORTAL_DEV_RECOVERY_VERSION);
    props.deleteProperty('PORTAL_ADMIN_BOOTSTRAP');
    props.deleteProperty('PORTAL_BOOTSTRAP_SECRET');
    portalAudit_('BOOTSTRAP_ADMIN', auth.localId, { username: username });
    return { success: true, username: username, durationMs: portalNow_() - startedAt };
  } finally {
    lock.releaseLock();
  }
}

function portalDevRecoveryRequested_(props) {
  props = props || PropertiesService.getScriptProperties();
  const requested = String(props.getProperty('PORTAL_ADMIN_BOOTSTRAP') || '').trim().toUpperCase();
  const enabled = ['ENABLE', 'ENABLED', 'TRUE', 'YES', '1', 'RECOVERY'].indexOf(requested) !== -1;
  return enabled && props.getProperty('PORTAL_DEV_RECOVERY_DONE') !== PORTAL_DEV_RECOVERY_VERSION;
}

/**
 * Data lama dapat mempunyai label ADMIN tanpa identitas login portal.
 * Hanya profil yang lengkap dan bisa dipakai login yang mengunci bootstrap.
 */
function portalIsUsableAdminProfile_(profile, uid) {
  if (!profile || profile.role !== 'ADMIN' || profile.active === false) return false;
  if (!profile.uid || String(profile.uid) !== String(uid || '')) return false;
  try {
    return portalNormalizeUsername_(profile.username) === String(profile.username || '').trim().toLowerCase();
  } catch (error) {
    return false;
  }
}

function portalLogin(payload) {
  payload = payload || {};
  const username = portalNormalizeUsername_(payload.username);
  const password = String(payload.password || '');
  if (!password) throw new Error('Password wajib diisi.');

  let auth;
  let indexedUid = '';
  let indexedProfile = null;
  let stage = 'LOGIN_INDEX';
  try {
    // Username dapat berubah tanpa perlu mengubah email Firebase Authentication.
    // Akun legacy tanpa index tetap memakai pola username@gbbnota.app dan index
    // akan dibangun sekali setelah kredensial serta profil berhasil diverifikasi.
    indexedUid = fbRead_('/usernameIndex/' + portalUsernameKey_(username));
    stage = 'LOGIN_PROFILE';
    indexedProfile = indexedUid ? fbRead_('/profiles/' + indexedUid) : null;
    stage = 'LOGIN_AUTH';
    auth = portalFirebaseAuthRequest_('accounts:signInWithPassword', {
      email: indexedProfile && indexedProfile.authEmail ? indexedProfile.authEmail : portalUsernameEmail_(username),
      password: password,
      returnSecureToken: true
    });
  // Akun yang mempunyai usernameIndex valid sudah membawa profil yang sama.
  // Hindari satu round-trip RTDB tambahan pada jalur login normal.
  stage = 'LOGIN_PROFILE';
  const profile = indexedProfile && String(indexedUid) === String(auth.localId)
    ? indexedProfile
    : fbRead_('/profiles/' + auth.localId);
  if (!profile || profile.active === false) throw new Error('Akun tidak aktif atau belum terdaftar.');
  if (portalNormalizeUsername_(profile.username) !== username) throw new Error('Profil akun tidak sesuai.');
  stage = 'LOGIN_INDEX_WRITE';
  if (String(indexedUid || '') !== String(auth.localId)) portalEnsureUsernameIndex_(username, auth.localId);

  const sessionToken = portalRandomToken_();
  const sessionKey = portalHash_(sessionToken);
  const now = portalNow_();
  const session = {
    uid: auth.localId,
    username: profile.username,
    displayName: profile.displayName || profile.branchName || profile.username,
    role: profile.role,
    branchId: profile.branchId || '',
    branchName: profile.branchName || '',
    branchType: profile.branchType || '',
    mustChangePassword: false,
    firebaseIdToken: auth.idToken,
    firebaseRefreshToken: auth.refreshToken,
    firebaseExpiresAt: now + (Number(auth.expiresIn || 3600) * 1000),
    createdAt: now,
    expiresAt: now + PORTAL_SESSION_HOURS * 60 * 60 * 1000,
    sessionVersion: PORTAL_SESSION_VERSION
  };
  // Sesi dan audit login disimpan dalam satu PATCH atomik untuk memangkas satu
  // request jaringan tanpa mengurangi jejak audit.
  const auditId = portalFriendlyId_('LOG');
  const loginUpdates = {};
  loginUpdates['portalSessions/' + sessionKey] = session;
  loginUpdates['auditLogs/' + auditId] = {
    id:auditId,
    action:'LOGIN',
    uid:auth.localId,
    details:{ role:profile.role, branchId:profile.branchId || '' },
    createdAt:portalNow_()
  };
  stage = 'LOGIN_SESSION_WRITE';
  fbUpdate_('/', loginUpdates);
  return {
    sessionToken: sessionToken,
    user: portalPublicSession_(session)
  };
  } catch (error) {
    const message = String(error && error.message || '');
    if (stage === 'LOGIN_AUTH' && /INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD/i.test(message)) {
      throw new Error('Username atau password salah.');
    }
    if (stage === 'LOGIN_AUTH' && /USER_DISABLED/i.test(message)) throw new Error('Akun tidak aktif. Hubungi administrator.');
    if (message === 'Akun tidak aktif atau belum terdaftar.' || message === 'Profil akun tidak sesuai.') throw error;
    throw new Error(portalAuthFailure_(stage, error));
  }
}

function portalGetSession(sessionToken) {
  const session = portalRequireSession_(sessionToken, ['TOKO', 'TAX', 'ADMIN']);
  return portalPublicSession_(session);
}

function portalLogout(sessionToken) {
  if (sessionToken) {
    const key = portalHash_(sessionToken);
    let session = null;
    try {
      session = fbRead_('/portalSessions/' + key);
    } catch (error) {
      Logger.log('Gagal membaca sesi saat logout: ' + error.message);
    }
    // Delete tidak boleh dilewati hanya karena read/audit gagal. Jika revokasi
    // gagal, teruskan error agar client tidak menganggap bearer token sudah mati.
    fbDelete_('/portalSessions/' + key);
    if (session) portalAudit_('LOGOUT', session.uid, {});
  }
  return { success: true };
}

/**
 * Satu pintu untuk semua API baru. Semua action memeriksa session dan role.
 */
function portalApi(sessionToken, action, payload) {
  const routes = {
    GET_LEGACY_DISCREPANCIES: { roles:['ADMIN'], fn:legacyReadDiscrepancyBatch_ },
    BUILD_IDENTITY_INDEX_BATCH: { roles:['ADMIN'], fn:legacyBuildIdentityBatch_ },
    VALIDATE_IDENTITY_INDEX_BATCH: { roles:['ADMIN'], fn:legacyValidateIdentityBatch_ },
    RUN_IDENTITY_VALIDATION_BATCH: { roles:['ADMIN'], fn:legacyRunIdentityValidationBatch_ },
    ACTIVATE_IDENTITY_INDEX: { roles:['ADMIN'], fn:legacyActivateIdentityIndex_ },
    GET_TARIK_JOB: { roles:['TAX', 'ADMIN'], fn:tarikJobStatus_ },
    LIST_PENDING_TARIK_JOBS: { roles:['TAX', 'ADMIN'], fn:tarikListPendingJobs_ },
    CANCEL_TARIK_JOB: { roles:['TAX', 'ADMIN'], fn:tarikCancelJob_ },
    RESOLVE_TARIK_JOB_FROM_SPREADSHEET: { roles:['TAX', 'ADMIN'], fn:tarikResolveJobFromSpreadsheet_ },
    GET_MUTATION_JOB: { roles:['TOKO','TAX','ADMIN'], fn:mutationJobStatus_ },
    RESUME_MUTATION_JOB: { roles:['TOKO','TAX','ADMIN'], fn:mutationJobResume_ },
    RESUME_TARIK_JOB: { roles:['TAX', 'ADMIN'], fn:tarikJobResume_ },
    GET_CATEGORIES: { roles: ['TOKO', 'TAX', 'ADMIN'], fn: portalGetCategories_ },
    GET_STORE_DASHBOARD: { roles: ['TOKO'], fn: portalGetStoreDashboard_ },
    START_STORE_OCR: { roles: ['TOKO'], fn: portalStartStoreOcr_ },
    PROCESS_STORE_OCR_PHOTO: { roles: ['TOKO'], fn: portalProcessStoreOcrPhoto_ },
    GET_STORE_OCR_STATUS: { roles: ['TOKO'], fn: portalGetStoreOcrStatus_ },
    FINALIZE_STORE_OCR: { roles: ['TOKO'], fn: portalFinalizeStoreOcr_ },
    SUBMIT_STORE_DRAFT: { roles: ['TOKO'], fn: portalSubmitStoreDraft_ },
    RESUBMIT_RECEIPT: { roles: ['TOKO'], fn: portalResubmitReceipt_ },
    GET_STORE_HISTORY: { roles: ['TOKO'], fn: portalGetStoreHistory_ },
    GET_TAX_RECEIPTS: { roles: ['TAX', 'ADMIN'], fn: portalGetTaxReceipts_ },
    GET_RECEIPT_DETAIL: { roles: ['TOKO', 'TAX', 'ADMIN'], fn: portalGetReceiptDetail_ },
    GET_PHOTO: { roles: ['TOKO', 'TAX', 'ADMIN'], fn: portalGetPhoto_ },
    GET_PHOTO_THUMBNAIL: { roles: ['TOKO', 'TAX', 'ADMIN'], fn: portalGetPhotoThumbnail_ },
    SAVE_TAX_RECEIPT: { roles: ['TAX', 'ADMIN'], fn: portalSaveTaxReceipt_ },
    RESTORE_DISCARDED_RECEIPT: { roles: ['ADMIN'], fn: portalRestoreDiscardedReceipt_ },
    CREATE_APPROVAL_JOB: { roles: ['TAX', 'ADMIN'], fn: portalCreateApprovalJob_ },
    GET_APPROVAL_JOB: { roles: ['TAX', 'ADMIN'], fn: portalGetApprovalJob_ },
    LIST_ACTIVE_APPROVAL_JOBS: { roles: ['TAX', 'ADMIN'], fn: portalListActiveApprovalJobs_ },
    RUN_APPROVAL_JOB: { roles: ['TAX', 'ADMIN'], fn: portalRunApprovalJob_ },
    RETRY_APPROVAL_JOB_ITEMS: { roles: ['TAX', 'ADMIN'], fn: portalRetryApprovalJobItems_ },
    CANCEL_APPROVAL_JOB: { roles: ['TAX', 'ADMIN'], fn: portalCancelApprovalJob_ },
    CLAIM_RECEIPT_REVIEW: { roles: ['TAX', 'ADMIN'], fn: portalClaimReceiptReview_ },
    RELEASE_RECEIPT_REVIEW: { roles: ['TAX', 'ADMIN'], fn: portalReleaseReceiptReview_ },
    GET_APPROVAL_RECOVERY: { roles: ['TAX', 'ADMIN'], fn: portalGetApprovalRecovery_ },
    GET_OPERATIONAL_EVENTS: { roles: ['ADMIN'], fn: portalGetOperationalEvents_ },
    CREATE_PORTAL_BACKUP: { roles: ['ADMIN'], fn: portalCreateBackup_ },
    VALIDATE_PORTAL_BACKUP: { roles: ['ADMIN'], fn: portalValidateBackup_ },
    GET_MASTER_LINKS: { roles: ['TAX', 'ADMIN'], fn: portalGetMasterLinks_ },
    SAVE_MASTER_LINKS: { roles: ['TAX', 'ADMIN'], fn: portalSaveMasterLinks_ },
    UPSERT_MASTER_BRANCH: { roles: ['TAX', 'ADMIN'], fn: portalUpsertMasterBranch_ },
    DELETE_MASTER_BRANCH: { roles: ['TAX', 'ADMIN'], fn: portalDeleteMasterBranch_ },
    BULK_MANAGE_BRANCHES: { roles: ['TAX', 'ADMIN'], fn: portalBulkManageBranches_ },
    PREVIEW_BULK_MANAGE_BRANCHES: { roles: ['TAX', 'ADMIN'], fn: portalPreviewBulkManageBranches_ },
    GET_ACCOUNTS: { roles: ['ADMIN'], fn: portalGetAccounts_ },
    GET_ACCOUNT_TEMPLATE: { roles: ['ADMIN'], fn: portalGetAccountTemplate_ },
    PROVISION_ACCOUNTS: { roles: ['ADMIN'], fn: portalProvisionAccounts_ },
    SET_ACCOUNT_ACTIVE: { roles: ['ADMIN'], fn: portalSetAccountActive_ },
    RESET_ACCOUNT_PASSWORD: { roles: ['ADMIN'], fn: portalResetAccountPassword_ },
    UPDATE_ACCOUNT: { roles: ['ADMIN'], fn: portalUpdateAccount_ },
    CHANGE_PASSWORD: { roles: ['TOKO', 'TAX', 'ADMIN'], fn: portalChangePassword_ },
    MOVE_RECEIPT_DATE: { roles: ['TAX', 'ADMIN'], fn: portalMoveReceiptDate_ },
    ELIMINATE_RECEIPT: { roles: ['TAX', 'ADMIN'], fn: portalEliminateReceipt_ },
    REBUILD_RECEIPT_INDEX_V1: { roles: ['ADMIN'], fn: portalRebuildReceiptIndexV1_ },
    REBUILD_LEGACY_INDEXES: { roles: ['ADMIN'], fn: portalRebuildLegacyIndexes_ }
  };
  const normalizedAction = String(action || '').toUpperCase();
  const requestId = portalFriendlyId_('REQ');
  const startedAt = portalNow_();
  const route = routes[normalizedAction];
  let session = null;
  try {
    if (!route) throw new Error('Aksi portal tidak dikenal.');
    session = portalRequireSession_(sessionToken, route.roles);
    MUTATION_SESSION_ = session;
    const result = route.fn(session, payload || {}, sessionToken);
    MUTATION_SESSION_ = null;
    if (/^(CREATE_APPROVAL_JOB|RUN_APPROVAL_JOB|RETRY_APPROVAL_JOB_ITEMS|START_STORE_OCR|FINALIZE_STORE_OCR|SUBMIT_STORE_DRAFT|SAVE_TAX_RECEIPT|RESTORE_DISCARDED_RECEIPT|MOVE_RECEIPT_DATE|ELIMINATE_RECEIPT|PROVISION_ACCOUNTS|RESET_ACCOUNT_PASSWORD)$/.test(normalizedAction)) {
      portalOperationalLog_(requestId, normalizedAction, session.uid, 'SUCCEEDED', portalNow_() - startedAt, '');
    }
    return result;
  } catch (error) {
    portalOperationalLog_(requestId, normalizedAction, session && session.uid || '', 'FAILED', portalNow_() - startedAt, error && error.message || error);
    const message = String(error && error.message || error || 'Terjadi kesalahan.').replace(/\s*\[Kode\s+REQ-[^\]]+\]\s*$/i, '');
    throw new Error(message + ' [Kode ' + requestId + ']');
  }
}

function portalRequireSession_(sessionToken, allowedRoles) {
  if (!sessionToken) throw new Error('Sesi login tidak ditemukan. Silakan login kembali.');
  const key = portalHash_(sessionToken);
  let session = null;
  try { session = fbRead_('/portalSessions/' + key); }
  catch (error) { throw new Error('Layanan sesi sedang tidak tersedia. Silakan coba lagi.'); }
  if (!session || Number(session.sessionVersion || 0) !== PORTAL_SESSION_VERSION || Number(session.expiresAt || 0) < portalNow_()) {
    try { fbDelete_('/portalSessions/' + key); } catch (error) {}
    throw new Error('Sesi telah berakhir. Silakan login kembali.');
  }
  let profile = null;
  const profileCacheKey = 'PORTAL_PROFILE_' + session.uid;
  try {
    const cachedProfile = CacheService.getScriptCache().get(profileCacheKey);
    if (cachedProfile) profile = JSON.parse(cachedProfile);
  } catch (error) {}
  if (!profile) {
    try {
      profile = fbRead_('/profiles/' + session.uid);
      if (profile) CacheService.getScriptCache().put(profileCacheKey, JSON.stringify(profile), 30);
    } catch (error) { throw new Error('Profil akun tidak dapat dimuat karena layanan data terganggu. Coba lagi.'); }
  }
  if (!profile || profile.active === false) throw new Error('Akun sudah dinonaktifkan.');
  if (allowedRoles.indexOf(profile.role) === -1) throw new Error('Anda tidak memiliki akses ke fitur ini.');
  session.role = profile.role;
  session.branchId = profile.branchId || '';
  session.branchName = profile.branchName || '';
  session.branchType = profile.branchType || '';
  session.displayName = profile.displayName || profile.branchName || profile.username;
  // Akun yang dibuat administrator langsung dapat memakai seluruh fitur.
  // Flag lama tidak lagi dijadikan penghalang akses.
  session.mustChangePassword = false;
  return portalRefreshFirebaseTokenIfNeeded_(key, session);
}

function portalClearProfileCache_(uid) {
  if (!uid) return;
  try { CacheService.getScriptCache().remove('PORTAL_PROFILE_' + uid); } catch (error) {}
}

function portalRefreshFirebaseTokenIfNeeded_(sessionKey, session) {
  if (Number(session.firebaseExpiresAt || 0) > portalNow_() + 120000) return session;
  const apiKey = PropertiesService.getScriptProperties().getProperty('FIREBASE_WEB_API_KEY');
  const response = firebaseFetchWithRetry_('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'refresh_token',
      refresh_token: session.firebaseRefreshToken
    },
    muteHttpExceptions: true
  }, 'AUTH_REFRESH');
  let json = {};
  try { json = JSON.parse(response.getContentText() || '{}'); } catch (error) {}
  if (response.getResponseCode() !== 200) {
    const firebaseMessage = String(json && json.error && json.error.message || '');
    if (/INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT/i.test(firebaseMessage)) {
      throw new Error('Sesi Firebase tidak valid. Silakan login kembali.');
    }
    throw new Error('Layanan pembaruan sesi sedang tidak tersedia. Silakan coba lagi.');
  }
  session.firebaseIdToken = json.id_token;
  session.firebaseRefreshToken = json.refresh_token;
  session.firebaseExpiresAt = portalNow_() + Number(json.expires_in || 3600) * 1000;
  fbWrite_('/portalSessions/' + sessionKey, session);
  return session;
}

function portalPublicSession_(session) {
  return {
    uid: session.uid,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    branchId: session.branchId || '',
    branchName: session.branchName || '',
    sessionExpiresAt: Number(session.expiresAt || 0),
    mustChangePassword: false
  };
}

function portalNormalizeUsername_(username) {
  const clean = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(clean)) {
    throw new Error('Username harus 3–40 karakter dan hanya memakai huruf, angka, titik, garis bawah, atau strip.');
  }
  return clean;
}

function portalValidateNewAuthUsername_(username) {
  const clean = portalNormalizeUsername_(username);
  if (clean.charAt(0) === '.' || clean.charAt(clean.length - 1) === '.' || clean.indexOf('..') !== -1) {
    throw new Error('Username untuk akun baru tidak boleh diawali/diakhiri titik atau memakai dua titik berurutan.');
  }
  return clean;
}

function portalValidatePassword_(password) {
  const value = String(password || '');
  if (value.length < 6 || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9\s]/.test(value)) {
    throw new Error('Password minimal 6 karakter dan wajib mengandung huruf besar, huruf kecil, angka, serta simbol khusus.');
  }
  return value;
}

function portalUsernameEmail_(username) {
  return portalNormalizeUsername_(username) + '@' + PORTAL_AUTH_DOMAIN;
}

function portalUsernameKey_(username) {
  // Realtime Database tidak menerima titik pada nama key, sedangkan titik
  // valid untuk username portal.
  return portalNormalizeUsername_(username).replace(/\./g, '~dot~');
}

function portalAssertUsernameAvailable_(username, allowedUid, profiles, usernameIndex) {
  const key = portalUsernameKey_(username);
  profiles = profiles || {};
  usernameIndex = usernameIndex || {};
  const indexedUid = usernameIndex[key];
  if (indexedUid && String(indexedUid) !== String(allowedUid || '')) {
    throw new Error('Username sudah dipakai atau sedang diproses oleh akun lain.');
  }
  const conflictUid = Object.keys(profiles).filter(function(uid) {
    if (String(uid) === String(allowedUid || '')) return false;
    const profile = profiles[uid] || {};
    try { return portalNormalizeUsername_(profile.username) === username; }
    catch (error) { return false; }
  })[0];
  if (conflictUid) throw new Error('Username sudah dipakai akun lain.');
}

function portalReserveUsername_(username, reservationId) {
  const key = portalUsernameKey_(username);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = fbRead_('/usernameIndex/' + key);
    if (existing) throw new Error('Username sudah dipakai atau sedang diproses oleh akun lain.');
    fbWrite_('/usernameIndex/' + key, reservationId);
  } finally {
    lock.releaseLock();
  }
}

function portalEnsureUsernameIndex_(username, uid) {
  const key = portalUsernameKey_(username);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const profiles = fbRead_('/profiles') || {};
    const usernameIndex = fbRead_('/usernameIndex') || {};
    portalAssertUsernameAvailable_(username, uid, profiles, usernameIndex);
    if (String(usernameIndex[key] || '') !== String(uid)) fbWrite_('/usernameIndex/' + key, uid);
  } finally {
    lock.releaseLock();
  }
}

function portalReleaseUsernameReservation_(username, reservationId) {
  const key = portalUsernameKey_(username);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = fbRead_('/usernameIndex/' + key);
    if (String(existing || '') === String(reservationId || '')) fbDelete_('/usernameIndex/' + key);
  } finally {
    lock.releaseLock();
  }
}

function portalBuildSessionRevocationUpdates_(uid, exceptSessionKey) {
  const sessions = fbRead_('/portalSessions') || {};
  const updates = {};
  Object.keys(sessions).forEach(function(key) {
    const item = sessions[key] || {};
    if (String(item.uid || '') === String(uid || '') && key !== exceptSessionKey) {
      updates['portalSessions/' + key] = null;
    }
  });
  return updates;
}

function portalBestEffortDeleteAuth_(auth) {
  if (!auth || !auth.idToken) return;
  try {
    portalFirebaseAuthRequest_('accounts:delete', { idToken: auth.idToken });
  } catch (error) {
    Logger.log('Gagal membersihkan identitas Auth orphan: ' + error.message);
  }
}

function portalFirebaseAuthRequest_(endpoint, payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('FIREBASE_WEB_API_KEY');
  if (!apiKey) throw new Error('FIREBASE_WEB_API_KEY belum diisi di Script Properties.');
  const response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/' + endpoint + '?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  let json = {};
  try { json = JSON.parse(response.getContentText() || '{}'); } catch (error) {}
  if (response.getResponseCode() !== 200) {
    const message = json && json.error && json.error.message ? json.error.message : 'Firebase Authentication gagal.';
    throw new Error(message);
  }
  return json;
}

function portalRandomToken_() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + portalNow_()
  )).replace(/=+$/g, '');
}

function portalHash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value)
  )).replace(/=+$/g, '');
}

function portalAudit_(action, uid, details) {
  try {
    const id = portalFriendlyId_('LOG');
    fbWrite_('/auditLogs/' + id, {
      id: id,
      action: action,
      uid: uid || '',
      details: details || {},
      createdAt: portalNow_()
    });
  } catch (error) {
    Logger.log('Audit gagal: ' + error.message);
  }
}

function portalOperationalLog_(requestId, action, uid, status, durationMs, errorMessage) {
  try {
    const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMM');
    fbWrite_('/operationalEvents/' + month + '/' + portalApprovalSafeKey_(requestId), {
      requestId:String(requestId || ''),
      action:String(action || ''),
      uid:String(uid || ''),
      status:String(status || ''),
      durationMs:Math.max(0, Number(durationMs || 0)),
      error:String(errorMessage || '').slice(0, 500),
      createdAt:portalNow_(),
      buildId:PORTAL_BUILD_ID
    });
  } catch (logError) {
    Logger.log('Operational log gagal: ' + logError.message);
  }
}

function portalChangePassword_(session, payload, sessionToken) {
  const newPassword = portalValidatePassword_(payload.newPassword);
  const key = portalHash_(sessionToken);
  // Ambil daftar sesi sebelum token Firebase diganti, lalu commit profil,
  // current session, dan revokasi sesi lain dalam satu multipath update.
  const updates = portalBuildSessionRevocationUpdates_(session.uid, key);
  const auth = portalFirebaseAuthRequest_('accounts:update', {
    idToken: session.firebaseIdToken,
    password: newPassword,
    returnSecureToken: true
  });
  session.firebaseIdToken = auth.idToken;
  session.firebaseRefreshToken = auth.refreshToken;
  session.firebaseExpiresAt = portalNow_() + Number(auth.expiresIn || 3600) * 1000;
  session.mustChangePassword = false;
  updates['profiles/' + session.uid + '/mustChangePassword'] = false;
  updates['profiles/' + session.uid + '/passwordChangedAt'] = portalNow_();
  updates['portalSessions/' + key] = session;
  fbUpdate_('/', updates);
  portalClearProfileCache_(session.uid);
  portalAudit_('CHANGE_PASSWORD', session.uid, {});
  return { success: true };
}

function portalGeneratePassword_() {
  const raw = Utilities.getUuid().replace(/-/g, '');
  return 'Gb#' + raw.slice(0, 5) + raw.slice(-5).toUpperCase() + '9';
}

function portalGetAccountTemplate_(session) {
  const branches = portalGetInternalBranches_(false);
  if (!branches.length) throw new Error('Master Link belum memiliki cabang aktif. Tambahkan cabang sebelum mengunduh template akun.');
  const spreadsheet = SpreadsheetApp.create('Template Import Akun GBB');
  const sheet = spreadsheet.getSheets()[0];
  sheet.setName('Import Akun');
  const reference = spreadsheet.insertSheet('Referensi Cabang');
  const accountRows = branches.map(function(branch) {
    return ['TOKO', branch.name, branch.type, branch.name, '', ''];
  });
  // Baris role global disediakan eksplisit agar template tidak terkesan hanya
  // mendukung akun cabang. Server tetap memvalidasi seluruh role saat import.
  accountRows.push(['TAX', '', '', 'Tim Tax', '', '']);
  accountRows.push(['ADMIN', '', '', 'Administrator Tambahan', '', '']);
  const lastDataRow = accountRows.length + 1;
  sheet.getRange(1, 1, 1, 6).setValues([['role', 'branchName', 'branchType', 'displayName', 'username', 'password']]).setFontWeight('bold').setBackground('#7651FF').setFontColor('#FFFFFF');
  sheet.getRange(2, 1, accountRows.length, 6).setValues(accountRows).setNumberFormat('@');
  sheet.getRange(2, 2, accountRows.length, 2).setBackground('#F7F6FC').setFontColor('#555267');
  sheet.getRange(2, 1, accountRows.length, 1).setBackground('#FFF9E8');
  sheet.getRange(2, 4, accountRows.length, 3).setBackground('#FFF9E8');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 95); sheet.setColumnWidth(2, 210); sheet.setColumnWidth(3, 150); sheet.setColumnWidth(4, 185); sheet.setColumnWidth(5, 150); sheet.setColumnWidth(6, 155);
  sheet.getRange(1, 1, lastDataRow, 6).createFilter();
  sheet.getRange(lastDataRow + 2, 1, 1, 6).merge().setValue('Kolom kuning dapat diedit. Pilih role TOKO, TAX, atau ADMIN. Untuk TOKO, gunakan cabang yang tersedia; untuk TAX/ADMIN, branchName dan branchType boleh kosong. Baris tanpa username akan dilewati. Password boleh dikosongkan agar dibuat otomatis; jika diisi, minimal 6 karakter dengan huruf besar, huruf kecil, angka, dan simbol khusus.').setFontColor('#6B6A7B').setFontStyle('italic').setWrap(true);
  reference.getRange('A1:A4').setValues([['Role'], ['TOKO'], ['TAX'], ['ADMIN']]);
  reference.getRange('B1:B3').setValues([['Tipe Cabang'], ['Mandiri'], ['Central Kitchen']]);
  reference.getRange('A1:B1').setFontWeight('bold').setBackground('#F2F0FF');
  reference.hideSheet();
  const roleRule = SpreadsheetApp.newDataValidation().requireValueInRange(reference.getRange('A2:A4'), true).setAllowInvalid(false).build();
  const typeRule = SpreadsheetApp.newDataValidation().requireValueInRange(reference.getRange('B2:B3'), true).setAllowInvalid(false).build();
  sheet.getRange(2, 1, accountRows.length, 1).setDataValidation(roleRule);
  sheet.getRange(2, 3, accountRows.length, 1).setDataValidation(typeRule);
  SpreadsheetApp.flush();
  const file = DriveApp.getFileById(spreadsheet.getId());
  try {
    const exportUrl = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(spreadsheet.getId()) + '/export?format=xlsx';
    const response = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (response.getResponseCode() !== 200) throw new Error('Export Excel gagal (' + response.getResponseCode() + '). Silakan coba kembali.');
    const blob = response.getBlob().setName('template-import-akun-gbb.xlsx');
    portalAudit_('DOWNLOAD_ACCOUNT_TEMPLATE', session.uid, { branchCount:branches.length });
    return { fileName:blob.getName(), mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64:Utilities.base64Encode(blob.getBytes()), branchCount:branches.length };
  } finally {
    file.setTrashed(true);
  }
}

function portalGetAccounts_(session) {
  const profiles = fbRead_('/profiles') || {};
  return Object.keys(profiles).map(function(uid) {
    const p = profiles[uid] || {};
    return {
      uid: uid,
      username: p.username || '',
      displayName: p.displayName || '',
      role: p.role || '',
      branchId: p.branchId || '',
      branchName: p.branchName || '',
      branchType: p.branchType || '',
      active: p.active !== false,
      mustChangePassword: false
    };
  }).sort(function(a, b) { return a.username.localeCompare(b.username); });
}

function portalProvisionAccounts_(session, payload) {
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter(function(row) {
    return String(row && row.username || '').trim() !== '';
  });
  if (!rows.length) throw new Error('Data akun kosong.');
  if (rows.length > PORTAL_MAX_PROVISION_BATCH) {
    throw new Error('Maksimal ' + PORTAL_MAX_PROVISION_BATCH + ' akun per proses agar import tidak terputus di tengah.');
  }

  const branches = portalGetInternalBranches_(false);
  const branchById = {};
  const branchByName = {};
  branches.forEach(function(branch) {
    branchById[String(branch.id || '')] = branch;
    branchByName[String(branch.name || '').trim().toUpperCase()] = branch;
  });
  const prepared = [];
  const validationErrors = [];
  const seen = {};
  const validationLock = LockService.getScriptLock();
  validationLock.waitLock(30000);
  try {
    const profiles = fbRead_('/profiles') || {};
    const usernameIndex = fbRead_('/usernameIndex') || {};
    rows.forEach(function(row, index) {
      try {
        const username = portalValidateNewAuthUsername_(row.username);
        if (seen[username]) throw new Error('Username duplikat di file.');
        seen[username] = true;
        portalAssertUsernameAvailable_(username, '', profiles, usernameIndex);

        const role = portalUpper_(row.role);
        if (['TOKO', 'TAX', 'ADMIN'].indexOf(role) === -1) throw new Error('Role harus TOKO, TAX, atau ADMIN.');
        let branchId = '';
        let branchName = '';
        let branchType = '';
        if (role === 'TOKO') {
          const requestedId = portalUpper_(row.branchId || row.branchCode);
          const requestedName = String(row.branchName || row.namaCabang || '').trim();
          const configuredBranch = branchById[requestedId] || branchByName[requestedName.toUpperCase()] || null;
          if (!configuredBranch) throw new Error('Cabang tidak ditemukan di Master Link. Gunakan nama cabang yang tersedia pada template.');
          branchId = configuredBranch.id;
          branchName = configuredBranch.name;
          branchType = String(row.branchType || row.tipe || configuredBranch.type || 'Mandiri').trim();
          if (branchType !== configuredBranch.type) throw new Error('Tipe cabang harus sesuai dengan Master Link: ' + configuredBranch.type + '.');
        }
        const password = row.password ? portalValidatePassword_(row.password) : portalGeneratePassword_();
        const displayName = String(row.displayName || branchName || username).trim();
        if (!displayName) throw new Error('Nama tampilan wajib diisi.');
        prepared.push({
          row: index + 1,
          username: username,
          password: password,
          role: role,
          branchId: branchId,
          branchName: branchName,
          branchType: branchType,
          displayName: displayName,
          authEmail: portalUsernameEmail_(username)
        });
      } catch (error) {
        validationErrors.push({ row: index + 1, username: String(row.username || ''), error: error.message });
      }
    });
  } finally {
    validationLock.releaseLock();
  }
  if (validationErrors.length) {
    throw new Error('Import dibatalkan sebelum membuat akun. ' + validationErrors.map(function(item) {
      return 'Baris ' + item.row + ': ' + item.error;
    }).join(' | '));
  }

  const results = [];
  prepared.forEach(function(item) {
    const reservationId = 'RESV:' + portalNow_() + ':' + portalRandomToken_().slice(0, 12);
    let auth = null;
    let reserved = false;
    try {
      portalReserveUsername_(item.username, reservationId);
      reserved = true;
      auth = portalFirebaseAuthRequest_('accounts:signUp', {
        email: item.authEmail,
        password: item.password,
        returnSecureToken: true
      });
      const profile = {
        uid: auth.localId,
        username: item.username,
        authEmail: item.authEmail,
        displayName: item.displayName,
        role: item.role,
        branchId: item.branchId,
        branchName: item.branchName,
        branchType: item.branchType,
        active: true,
        mustChangePassword: false,
        createdAt: portalNow_(),
        createdBy: session.uid
      };
      const updates = {};
      updates['profiles/' + auth.localId] = profile;
      updates['usernameIndex/' + portalUsernameKey_(item.username)] = auth.localId;
      fbUpdate_('/', updates);
      reserved = false;
      results.push({ row: item.row, success: true, username: item.username, password: item.password });
    } catch (error) {
      if (auth) portalBestEffortDeleteAuth_(auth);
      if (reserved) {
        try { portalReleaseUsernameReservation_(item.username, reservationId); }
        catch (cleanupError) { Logger.log('Gagal melepas reservasi username: ' + cleanupError.message); }
      }
      results.push({ row: item.row, success: false, username: item.username, error: error.message });
    }
  });
  portalAudit_('PROVISION_ACCOUNTS', session.uid, {
    requested: rows.length,
    succeeded: results.filter(function(item) { return item.success; }).length
  });
  return { results: results };
}

function portalSetAccountActive_(session, payload) {
  const uid = String(payload.uid || '');
  if (!uid) throw new Error('UID akun tidak ditemukan.');
  if (uid === session.uid && payload.active === false) throw new Error('Anda tidak dapat menonaktifkan akun sendiri.');
  const profile = fbRead_('/profiles/' + uid);
  if (!profile) throw new Error('Akun tidak ditemukan.');
  const active = payload.active !== false;
  const updates = {};
  updates['profiles/' + uid + '/active'] = active;
  updates['profiles/' + uid + '/updatedAt'] = portalNow_();
  updates['profiles/' + uid + '/updatedBy'] = session.uid;
  if (!active) Object.assign(updates, portalBuildSessionRevocationUpdates_(uid, ''));
  fbUpdate_('/', updates);
  portalClearProfileCache_(uid);
  portalAudit_('SET_ACCOUNT_ACTIVE', session.uid, { targetUid: uid, active: active });
  return { success: true };
}

function portalUpdateAccount_(session, payload) {
  const uid = String(payload.uid || '');
  if (!uid) throw new Error('UID akun tidak ditemukan.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const profiles = fbRead_('/profiles') || {};
    const usernameIndex = fbRead_('/usernameIndex') || {};
    const current = profiles[uid];
    if (!current) throw new Error('Akun tidak ditemukan.');
    if (current.role === 'ADMIN' && uid !== session.uid) throw new Error('Akun ADMIN lain tidak dapat diubah dari halaman ini.');

    const username = portalNormalizeUsername_(payload.username || current.username);
    if (String(payload.newPassword || '')) throw new Error('Gunakan tombol Reset Password untuk mengganti kredensial akun.');
    if (username !== current.username) portalValidateNewAuthUsername_(username);
    const requestedRole = portalUpper_(payload.role || current.role);
    if (['TOKO', 'TAX', 'ADMIN'].indexOf(requestedRole) === -1) throw new Error('Role tidak valid.');
    if (requestedRole === 'ADMIN' && uid !== session.uid) throw new Error('Pemberian role ADMIN harus dilakukan melalui prosedur bootstrap/administrator.');
    portalAssertUsernameAvailable_(username, uid, profiles, usernameIndex);

    let branchId = '';
    let branchName = '';
    let branchType = '';
    if (requestedRole === 'TOKO') {
      const requestedBranchId = portalUpper_(payload.branchId || current.branchId);
      const requestedBranchName = String(payload.branchName || current.branchName || '').trim().toUpperCase();
      const branch = portalGetInternalBranches_(false).filter(function(item) {
        return item.id === requestedBranchId || String(item.name || '').trim().toUpperCase() === requestedBranchName;
      })[0] || null;
      if (!branch) throw new Error('Akun TOKO wajib memakai cabang aktif dari Master Link.');
      const suppliedType = String(payload.branchType || current.branchType || branch.type).trim();
      if (suppliedType !== branch.type) throw new Error('Tipe cabang harus sesuai dengan Master Link: ' + branch.type + '.');
      branchId = branch.id;
      branchName = branch.name;
      branchType = branch.type;
    }

    const displayName = String(payload.displayName || current.displayName || username).trim();
    if (!displayName) throw new Error('Nama tampilan wajib diisi.');
    const changes = {
      username: username,
      displayName: displayName,
      role: requestedRole,
      branchId: branchId,
      branchName: branchName,
      branchType: branchType,
      updatedAt: portalNow_(),
      updatedBy: session.uid
    };
    const oldUsernameKey = portalUsernameKey_(current.username);
    const newUsernameKey = portalUsernameKey_(username);
    const updates = {};

    const savedProfile = Object.assign({}, current, changes);
    updates['profiles/' + uid] = savedProfile;
    updates['usernameIndex/' + newUsernameKey] = uid;
    if (oldUsernameKey !== newUsernameKey && String(usernameIndex[oldUsernameKey] || '') === uid) {
      updates['usernameIndex/' + oldUsernameKey] = null;
    }
    fbUpdate_('/', updates);

    portalClearProfileCache_(uid);
    portalAudit_('UPDATE_ACCOUNT', session.uid, {
      targetUid: uid,
      username: username,
      role: requestedRole
    });
    return {
      success: true,
      uid: uid,
      account: {
        uid: uid,
        username: savedProfile.username || '',
        displayName: savedProfile.displayName || '',
        role: savedProfile.role || '',
        branchId: savedProfile.branchId || '',
        branchName: savedProfile.branchName || '',
        branchType: savedProfile.branchType || '',
        active: savedProfile.active !== false,
        mustChangePassword: false
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function portalResetAccountPassword_(session, payload) {
  const uid = String(payload.uid || '');
  if (!uid) throw new Error('UID akun tidak ditemukan.');
  if (uid === session.uid) throw new Error('Password akun sendiri harus diganti melalui halaman Akun & Keamanan.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let auth = null;
  let replacementUid = '';
  try {
    const profiles = fbRead_('/profiles') || {};
    const usernameIndex = fbRead_('/usernameIndex') || {};
    const current = profiles[uid];
    if (!current) throw new Error('Akun tidak ditemukan. Muat ulang daftar akun lalu coba kembali.');
    const role = portalUpper_(current.role);
    if (['TOKO', 'TAX'].indexOf(role) === -1) throw new Error('Password akun ADMIN tidak dapat direset dari daftar akun.');
    const username = portalValidateNewAuthUsername_(current.username);
    portalAssertUsernameAvailable_(username, uid, profiles, usernameIndex);
    // Administrator menetapkan password final secara langsung. Nilainya tidak
    // disimpan pada profil/audit dan tidak dikembalikan lagi ke client.
    const password = portalValidatePassword_(payload.newPassword);
    const authEmail = username + '.cred' + portalNow_() + '.' + Utilities.getUuid().replace(/-/g, '').slice(0, 6) + '@' + PORTAL_AUTH_DOMAIN;
    auth = portalFirebaseAuthRequest_('accounts:signUp', {
      email: authEmail,
      password: password,
      returnSecureToken: true
    });
    replacementUid = auth.localId;
    const timestamp = portalNow_();
    const replacement = Object.assign({}, current, {
      uid: replacementUid,
      authEmail: authEmail,
      active: current.active !== false,
      mustChangePassword: false,
      credentialReplacedAt: timestamp,
      passwordChangedAt: timestamp,
      updatedAt: timestamp,
      updatedBy: session.uid
    });
    const updates = portalBuildSessionRevocationUpdates_(uid, '');
    const ownershipUpdates = portalBuildApprovalOwnershipTransferUpdates_(uid, replacementUid);
    Object.keys(ownershipUpdates).forEach(function(path) { updates[path] = ownershipUpdates[path]; });
    updates['profiles/' + replacementUid] = replacement;
    updates['profiles/' + uid] = null;
    updates['usernameIndex/' + portalUsernameKey_(username)] = replacementUid;
    fbUpdate_('/', updates);
    auth = null;
    portalClearProfileCache_(uid);
    portalClearProfileCache_(replacementUid);
    portalAudit_('RESET_ACCOUNT_PASSWORD', session.uid, {
      targetUid: uid,
      replacementUid: replacementUid,
      username: username,
      role: role,
      active: replacement.active,
      migratedActiveJobCount: Object.keys(ownershipUpdates).filter(function(path) {
        return path.indexOf('approvalJobs/') === 0 && /\/createdBy$/.test(path);
      }).length
    });
    return {
      success:true,
      uid:replacementUid,
      username:username,
      account:{
        uid:replacementUid,
        username:replacement.username || '',
        displayName:replacement.displayName || '',
        role:replacement.role || '',
        branchId:replacement.branchId || '',
        branchName:replacement.branchName || '',
        branchType:replacement.branchType || '',
        active:replacement.active !== false,
        mustChangePassword:false
      }
    };
  } catch (error) {
    if (auth) portalBestEffortDeleteAuth_(auth);
    throw error;
  } finally {
    lock.releaseLock();
  }
}
