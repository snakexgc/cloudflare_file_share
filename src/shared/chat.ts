import type { FileInfo, ShareTransferMode } from './types';

export interface ChatMember { id: string; name: string; joinedAt: number }
export interface ChatAttachment { shareId: string; expiresAt: number; transferMode: ShareTransferMode; files: FileInfo[] }
export interface ChatMessage { id: string; sequence: number; nonce: string; authorId: string; authorName: string; createdAt: number; text: string; attachment?: ChatAttachment }
export interface ChatSnapshot { revision: number; members: ChatMember[]; messages: ChatMessage[]; self: ChatMember; historyHours: number }
export type ChatEvent = { type: 'snapshot'; snapshot: ChatSnapshot } | { type: 'message'; revision: number; message: ChatMessage } | { type: 'members'; revision: number; members: ChatMember[] } | { type: 'prune'; revision: number; messageIds: string[] };

/** NFKC and case-insensitive keys also prevent full-width aliases of an online name. */
export function chatName(value: unknown): { name: string; key: string } | undefined {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}<>]/u.test(value)) return;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || Array.from(name).length > 20) return;
  return { name, key: name.toLowerCase() };
}
