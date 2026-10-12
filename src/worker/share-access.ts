import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { assert, constantEqual, token } from './util';
import { ID_PATTERN } from '../shared/protocol';

export const SHORT_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
export function validShortCode(value: unknown): value is string { return typeof value === 'string' && SHORT_CODE_PATTERN.test(value) && !ID_PATTERN.test(value); }
export function validSharePassword(value: unknown): value is string { return typeof value === 'string' && value.length >= 4 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value); }
export interface SharePassword { salt: string; hash: string }
async function derive(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return bytesToHex(new Uint8Array(bytes));
}
export async function createSharePassword(password: unknown): Promise<SharePassword | undefined> {
  if (password === undefined) return;
  assert(validSharePassword(password), 400, 'invalid_share_password', '提取密码须为 4–64 个字符，不接受控制字符');
  const salt = token(); return { salt, hash: await derive(password, salt) };
}
export async function verifySharePassword(password: unknown, stored: SharePassword) {
  return validSharePassword(password) && constantEqual(await derive(password, stored.salt), stored.hash);
}
export function accessCookieName(shareId: string) { return `file_share_access_${shareId}`; }
export function accessCookie(request: Request, shareId: string, secret: string, expiresAt: number) {
  return `${accessCookieName(shareId)}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
