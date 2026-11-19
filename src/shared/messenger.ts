import type { ShareTransferMode } from './types';

export const MESSENGER_PLAZA_ID = '00000000000000000000000000000000';
export const MESSENGER_ONLINE_MS = 60_000;
export const MESSENGER_HEARTBEAT_WRITE_INTERVAL_MS = 15_000;
// Retention starts when the last heartbeat's online lease ends.
export const MESSENGER_MESSAGE_RETENTION_MS = 10 * 60_000;
export const MESSENGER_GROUP_RETENTION_MS = 60 * 60_000;
export const MESSENGER_RETENTION_MS = 12 * 60 * 60_000;
export const messengerAccountCutoff = (now: number) => now - MESSENGER_ONLINE_MS - MESSENGER_RETENTION_MS;
export const MESSENGER_AVATAR_PATH = /^\/api\/messenger\/avatars\/([a-f0-9]{32})\/([a-f0-9]{64})$/;
export function isMessengerAvatarImage(value: string) {
  return MESSENGER_AVATAR_PATH.test(value) || /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value);
}

export interface MessengerUser {
  id: string;
  name: string;
  avatar: string;
  online: boolean;
  lastSeen: number;
}

export interface MessengerFile {
  id: string;
  ownerId: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
  transferMode: ShareTransferMode;
  createdAt: number;
}

export interface MessengerMessage {
  id: string;
  sequence: number;
  conversationId: string;
  senderId: string;
  text: string;
  file?: MessengerFile;
  createdAt: number;
}

export interface MessengerConversation {
  id: string;
  kind: 'dm' | 'group';
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
  revision?: number;
  lastMessage?: MessengerMessage;
}

export interface MessengerTransfer {
  id: string;
  fileId: string;
  conversationId?: string;
  ownerId: string;
  requesterId: string;
  status: 'pending' | 'ready' | 'failed';
  createdAt: number;
  expiresAt: number;
  shareId?: string;
  shareFileId?: string;
  password?: string;
  reason?: string;
}

export interface MessengerState {
  revision?: string;
  refreshAt?: number;
  presenceLeaseMs?: number;
  me: MessengerUser;
  users: MessengerUser[];
  conversations: MessengerConversation[];
  files: MessengerFile[];
  transfers: MessengerTransfer[];
}
