import { createHash, randomBytes } from 'node:crypto';
import { invariant } from './errors';
export type Role = 'TOKO' | 'TAX' | 'ADMIN';
export type User = { uid: string; username: string; displayName: string; role: Role; branchId: string; branchName: string; branchType: string; active: boolean };
export const SESSION_HOURS = 4;
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function newToken() { return randomBytes(32).toString('base64url'); }
export function stableJson(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function payloadHash(value: unknown) { return tokenHash(stableJson(value)); }
export function requireRole(user: User, allowed: Role[]) { invariant(allowed.includes(user.role), 'FORBIDDEN', 'Akun tidak diizinkan menjalankan tindakan ini.', 403); }
export function requireBranch(user: User, branchId: string) {
  invariant(user.role !== 'TOKO' || (!!branchId && user.branchId === branchId), 'FORBIDDEN', 'Data cabang ini tidak dapat diakses.', 403);
}
export function checkOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  invariant(request.headers.get('origin') === expected, 'INVALID_ORIGIN', 'Asal permintaan tidak diizinkan.', 403);
}
export function cookieName() { return process.env.NODE_ENV === 'production' ? '__Host-nota_session' : 'nota_dev_session'; }
export function sessionCookie(token: string, clear = false) {
  return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_HOURS * 3600}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function requestToken(request: Request) {
  return (request.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName() + '='))?.slice(cookieName().length + 1) || '';
}
