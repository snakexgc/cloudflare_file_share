import { MESSENGER_ONLINE_MS, type MessengerConversation, type MessengerFile, type MessengerMessage, type MessengerTransfer, type MessengerUser } from '../shared/messenger';

export type UserRow = Omit<MessengerUser, 'online'>;
export const userFields = 'id, name, avatar, last_seen AS lastSeen';
export const publicUser = (user: UserRow, now: number): MessengerUser => ({
  id: user.id, name: user.name, avatar: user.avatar, lastSeen: user.lastSeen, online: user.lastSeen > now - MESSENGER_ONLINE_MS,
});
export const fileFields = 'f.id, f.name, f.size, f.mime, f.last_modified AS lastModified, f.transfer_mode AS transferMode, f.created_at AS createdAt, f.owner_id AS ownerId';

// Parameters 1 and 2 are always the authenticated user and account expiry cutoff.
const visibleRooms = `FROM messenger_conversations c JOIN messenger_members own ON own.conversation_id = c.id
  WHERE own.user_id = ?1 AND (c.kind = 'group' OR (
    EXISTS (SELECT 1 FROM messenger_users u WHERE u.id = c.dm_left AND u.last_seen > ?2) AND
    EXISTS (SELECT 1 FROM messenger_users u WHERE u.id = c.dm_right AND u.last_seen > ?2)))`;
export const visibleRoomIds = 'SELECT c.id ' + visibleRooms;

const messageFields = `m.id AS messageId, m.sequence, m.conversation_id AS conversationId, m.sender_id AS senderId,
  m.text, m.created_at AS sentAt, CASE WHEN f.id IS NOT NULL THEN json_object('id', f.id, 'ownerId', f.owner_id,
  'name', f.name, 'size', f.size, 'mime', f.mime, 'lastModified', f.last_modified, 'transferMode', f.transfer_mode,
  'createdAt', f.created_at) END AS fileJson`;
const liveFileJoin = `LEFT JOIN messenger_files f ON f.id = m.file_id AND EXISTS
  (SELECT 1 FROM messenger_users u WHERE u.id = f.owner_id AND u.last_seen > ?2)`;
interface MessageRow {
  messageId: string; sequence: number; conversationId: string; senderId: string;
  text: string; sentAt: number; fileJson: string | null;
}
interface ConversationRow extends MessageRow {
  id: string; kind: 'dm' | 'group'; createdAt: number; members: string; revision: number;
}
export function messageView(row: MessageRow): MessengerMessage {
  return { id: row.messageId, sequence: row.sequence, conversationId: row.conversationId, senderId: row.senderId,
    text: row.text, createdAt: row.sentAt, file: row.fileJson ? JSON.parse(row.fileJson) as MessengerFile : undefined };
}
export function conversationView(row: ConversationRow): MessengerConversation {
  const lastMessage = row.messageId ? messageView(row) : undefined;
  return { id: row.id, kind: row.kind, memberIds: row.members.split(','), createdAt: row.createdAt,
    updatedAt: lastMessage?.createdAt ?? row.createdAt, revision: row.revision, lastMessage };
}
export type { ConversationRow, MessageRow };

export const conversationSql = `SELECT c.id, c.kind, c.revision, c.created_at AS createdAt,
    (SELECT group_concat(mm.user_id) FROM messenger_members mm JOIN messenger_users u ON u.id = mm.user_id
     WHERE mm.conversation_id = c.id AND u.last_seen > ?2) AS members, ${messageFields}
  FROM messenger_conversations c
  LEFT JOIN messenger_messages m ON m.sequence = (SELECT latest.sequence FROM messenger_messages latest
    WHERE latest.conversation_id = c.id AND (latest.text <> '' OR EXISTS (SELECT 1 FROM messenger_files lf
      JOIN messenger_users u ON u.id = lf.owner_id WHERE lf.id = latest.file_id AND u.last_seen > ?2))
    ORDER BY latest.sequence DESC LIMIT 1)
  ${liveFileJoin} WHERE c.id IN (${visibleRoomIds})`;

export const messageSql = `SELECT ${messageFields} FROM messenger_messages m ${liveFileJoin}
  WHERE m.conversation_id = ?3 AND m.conversation_id IN (${visibleRoomIds}) AND (m.text <> '' OR f.id IS NOT NULL)`;

// Joining both users, the live file and the message also invalidates a ticket during the
// interval between its participants' logical expiry and physical cleanup by the cron.
export const ticketSql = `SELECT t.id, t.file_id AS fileId, t.conversation_id AS conversationId, t.owner_id AS ownerId,
  t.requester_id AS requesterId, t.status, t.created_at AS createdAt, t.expires_at AS expiresAt,
  t.share_id AS shareId, t.share_file_id AS shareFileId, t.password, t.reason
  FROM messenger_transfers t JOIN messenger_files f ON f.id = t.file_id AND f.owner_id = t.owner_id
  JOIN messenger_users source ON source.id = t.owner_id AND source.last_seen > ?2
  JOIN messenger_users receiver ON receiver.id = t.requester_id AND receiver.last_seen > ?2
  WHERE (t.owner_id = ?1 OR t.requester_id = ?1) AND t.expires_at > ?3
  AND (t.requester_id = t.owner_id OR (
    EXISTS (SELECT 1 FROM messenger_members mm WHERE mm.user_id = t.requester_id AND mm.conversation_id = t.conversation_id)
    AND EXISTS (SELECT 1 FROM messenger_members mm WHERE mm.user_id = t.owner_id AND mm.conversation_id = t.conversation_id)
    AND EXISTS (SELECT 1 FROM messenger_messages m WHERE m.file_id = t.file_id AND m.conversation_id = t.conversation_id)))`;
export function ticketView(row: MessengerTransfer): MessengerTransfer {
  // D1 represents absent optional columns as null. Keep public DTOs consistent with the message API.
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as MessengerTransfer;
}
