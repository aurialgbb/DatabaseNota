import { database, transaction, type Database } from './db';
import { AppError, invariant } from './errors';
import { newToken, tokenHash, requestToken, SESSION_HOURS, type User } from './identity';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export function firebaseAdmin() {
  invariant(process.env.FIREBASE_ADMIN_CREDENTIALS, 'AUTH_NOT_CONFIGURED', 'Layanan akun belum dikonfigurasi.', 503);
  const app = getApps()[0] || initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS)) });
  return getAuth(app);
}
export async function firebasePassword(email: string, password: string) {
  invariant(process.env.FIREBASE_WEB_API_KEY, 'AUTH_NOT_CONFIGURED', 'Login belum dikonfigurasi.', 503);
  const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(process.env.FIREBASE_WEB_API_KEY), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(15000)
  });
  invariant(response.ok, 'INVALID_CREDENTIALS', 'Username atau password salah.', 401);
  return await response.json() as { localId: string };
}
export function userFromRow(row: any): User {
  return { uid: row.uid, username: row.username, displayName: row.display_name, role: row.role, branchId: row.branch_id || '', branchName: row.branch_name || '', branchType: row.branch_type || '', active: row.active };
}
const profileSelect = 'SELECT p.*, b.name AS branch_name,b.type AS branch_type FROM nota_app.profiles p LEFT JOIN nota_app.branches b ON b.id=p.branch_id ';
export async function login(payload: any, verify = firebasePassword) {
  const username = String(payload.username || '').trim().toLowerCase();
  invariant(username && typeof payload.password === 'string' && payload.password.length <= 1024, 'INVALID_LOGIN', 'Username dan password wajib diisi.');
  const db = database();
  const rate = await db.query("INSERT INTO nota_app.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END, expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING count", ['login:' + tokenHash(username)]);
  invariant(rate.rows[0].count <= 20, 'RATE_LIMIT', 'Terlalu banyak percobaan login. Coba lagi nanti.', 429);
  const { rows } = await db.query(profileSelect + ' WHERE p.username=$1', [username]);
  const row = rows[0];
  invariant(row && row.active, 'INVALID_CREDENTIALS', 'Username atau password salah.', 401);
  const identity = await verify(row.auth_email, payload.password);
  invariant(identity.localId === row.uid, 'INVALID_CREDENTIALS', 'Username atau password salah.', 401);
  const token = newToken();
  const expiresAt = Date.now() + SESSION_HOURS * 3600000;
  await transaction(async tx => {
    const active = await tx.query('SELECT active FROM nota_app.profiles WHERE uid=$1 FOR UPDATE', [row.uid]);
    invariant(active.rows[0]?.active, 'ACCOUNT_DISABLED', 'Akun sudah dinonaktifkan.', 401);
    await tx.query('INSERT INTO nota_app.sessions(token_hash,uid,expires_at) VALUES($1,$2,$3)', [tokenHash(token), row.uid, new Date(expiresAt)]);
    await tx.query("INSERT INTO nota_app.audit_events(uid,action) VALUES($1,'LOGIN')", [row.uid]);
    await tx.query('DELETE FROM nota_app.auth_rate_limits WHERE key=$1', ['login:' + tokenHash(username)]);
  });
  return { token, user: { ...userFromRow(row), sessionExpiresAt: expiresAt, mustChangePassword: false } };
}
export async function requireSession(request: Request): Promise<User> {
  const token = requestToken(request);
  invariant(token && token.length <= 256, 'SESSION_EXPIRED', 'Sesi telah berakhir. Silakan login kembali.', 401);
  const { rows } = await database().query(profileSelect + ' JOIN nota_app.sessions s ON s.uid=p.uid WHERE s.token_hash=$1 AND s.expires_at>now() AND p.active=true', [tokenHash(token)]);
  invariant(rows[0], 'SESSION_EXPIRED', 'Sesi telah berakhir. Silakan login kembali.', 401);
  return userFromRow(rows[0]);
}
export async function logout(request: Request) {
  const token = requestToken(request);
  if (token) await database().query('DELETE FROM nota_app.sessions WHERE token_hash=$1', [tokenHash(token)]);
}
export async function setupStatus() {
  const required = ['DATABASE_URL', 'FIREBASE_WEB_API_KEY', 'FIREBASE_PROJECT_ID', 'R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GEMINI_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  let hasAdmin = false, databaseReady = false;
  if (process.env.DATABASE_URL) {
    try { hasAdmin = !!(await database().query("SELECT 1 FROM nota_app.profiles WHERE role='ADMIN' AND active=true LIMIT 1")).rows.length; databaseReady = true; } catch {}
  }
  return { ready: false, missingProperties: missing, hasAdmin, adminRecordCount: hasAdmin ? 1 : 0, databaseReady, recoveryMode: false, bootstrapSecretConfigured: false, diagnostic: missing.length ? 'Lingkungan aplikasi baru belum dikonfigurasi.' : '' };
}
