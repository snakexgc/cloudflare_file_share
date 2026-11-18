import { MESSENGER_AVATAR_PATH, MESSENGER_ONLINE_MS, MESSENGER_RETENTION_MS, type MessengerFile, type MessengerState, type MessengerTransfer } from '../shared/messenger';
import { chatName } from '../shared/chat';
import { limits, type Env } from './config';
import { assetId, revokeMessengerRooms, transferApi } from './messenger-transfers';
import { conversationSql, conversationView, fileFields, messageSql, messageView, publicUser, ticketSql, ticketView,
  userFields, visibleRoomIds, type ConversationRow, type MessageRow, type UserRow } from './messenger-view';
import { assert, bearer, digest, id, json, readJson } from './util';

const hexSecret = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hexId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const cutoffAt = (now: number) => now - MESSENGER_RETENTION_MS;
export async function sweepMessenger(env: Env, now: number) {
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM messenger_transfers WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM messenger_users WHERE last_seen <= ?').bind(cutoffAt(now)),
  ]);
  await revokeMessengerRooms(env);
}

async function identity(request: Request, db: D1Database, now: number) {
  const data = await readJson(request, 1024);
  assert(hexSecret(data.fingerprint) && hexSecret(data.credential), 400, 'invalid_identity', '设备身份数据无效');
  const hash = digest(data.credential);
  // Fresh incarnations cannot regain expired memberships. The fingerprint seeds the
  // visible identity but is never stored and cannot authenticate another browser.
  const userId = digest(`messenger:${data.fingerprint}:${id()}`).slice(0, 32);
  const results = await db.batch([
    db.prepare('DELETE FROM messenger_users WHERE credential_hash = ? AND last_seen <= ?').bind(hash, cutoffAt(now)),
    db.prepare(`INSERT INTO messenger_users (id, credential_hash, name, avatar, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(credential_hash) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`)
      .bind(userId, hash, `访客-${userId.slice(0, 6)}`, '👤', now),
    db.prepare(`SELECT ${userFields} FROM messenger_users WHERE credential_hash = ?`).bind(hash),
  ]);
  return json({ user: publicUser(results[2].results[0] as unknown as UserRow, now) });
}

type PollUser = UserRow & { personalRevision: number; rosterRevision: number; chatRevision: number };

async function authenticate(request: Request, db: D1Database, now: number, polling: boolean) {
  const credential = bearer(request);
  assert(credential, 401, 'identity_required', '请先连接自己的设备身份');
  const hash = digest(credential), cutoff = cutoffAt(now);
  const revisions = polling ? `, revision AS personalRevision, (SELECT revision FROM messenger_directory WHERE id = 1) AS rosterRevision,
    (SELECT COALESCE(SUM(c.revision + 1), 0) FROM messenger_members mm JOIN messenger_conversations c ON c.id = mm.conversation_id
     WHERE mm.user_id = messenger_users.id) AS chatRevision` : '';
  const result = await db.batch([
    db.prepare('UPDATE messenger_users SET last_seen = ? WHERE credential_hash = ? AND last_seen > ? AND last_seen <= ?')
      .bind(now, hash, cutoff, now - 15_000),
    db.prepare(`SELECT ${userFields} ${revisions} FROM messenger_users WHERE credential_hash = ? AND last_seen > ?`).bind(hash, cutoff),
  ]);
  const row = result[1].results[0] as unknown as PollUser | undefined;
  assert(row, 401, 'identity_expired', '设备身份已过期，请重新连接');
  return row;
}

function validAvatar(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (!value.startsWith('data:')) return Array.from(value).length <= 16 && !/[\p{Cc}\p{Cs}<>]/u.test(value);
  const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > 32768 || match[2].length % 4) return false;
  let raw: string;
  try { raw = atob(match[2]); } catch { return false; }
  if (match[1] === 'png') return raw.startsWith('\x89PNG\r\n\x1a\n');
  if (match[1] === 'jpeg') return raw.startsWith('\xff\xd8\xff');
  return raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP';
}

async function updateProfile(request: Request, db: D1Database, user: string, now: number) {
  const data = await readJson(request, 36 * 1024);
  const name = chatName(data.name)?.name;
  const unchangedPhoto = typeof data.avatar === 'string' && MESSENGER_AVATAR_PATH.test(data.avatar);
  assert((data.name === undefined || name) && (data.avatar === undefined || unchangedPhoto || validAvatar(data.avatar)) &&
    (data.name !== undefined || data.avatar !== undefined), 400, 'invalid_profile', '请输入有效的昵称或头像');
  const batch: D1PreparedStatement[] = [];
  let avatar = typeof data.avatar === 'string' && !unchangedPhoto ? data.avatar : null;
  if (avatar?.startsWith('data:')) {
    batch.push(db.prepare(`INSERT INTO messenger_avatars (user_id, image) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET image = excluded.image`).bind(user, avatar));
    avatar = `/api/messenger/avatars/${user}/${digest(avatar)}`;
  } else if (avatar !== null) {
    batch.push(db.prepare('DELETE FROM messenger_avatars WHERE user_id = ?').bind(user));
  }
  batch.push(db.prepare(`UPDATE messenger_users SET name = COALESCE(?, name), avatar = COALESCE(?, avatar)
    WHERE id = ? AND (? IS NULL OR avatar = ?) RETURNING ${userFields}`)
    .bind(name ?? null, avatar, user, unchangedPhoto ? data.avatar : null, unchangedPhoto ? data.avatar : null));
  const updated = (await db.batch(batch)).at(-1)!.results[0] as unknown as UserRow | undefined;
  assert(updated, 409, 'profile_changed', '头像已经更新，请重新编辑资料'); return json({ user: publicUser(updated, now) });
}

async function avatarResponse(db: D1Database, path: string, user: string, now: number) {
  const row = await db.prepare(`SELECT a.image FROM messenger_users u JOIN messenger_avatars a ON a.user_id = u.id
    WHERE u.id = ? AND u.avatar = ? AND u.last_seen > ?`).bind(user, path, cutoffAt(now)).first<string>('image');
  assert(row, 404, 'avatar_not_found', '头像不存在');
  const comma = row.indexOf(',');
  const raw = atob(row.slice(comma + 1));
  return new Response(Uint8Array.from(raw, ch => ch.charCodeAt(0)), { headers: {
    'Content-Type': row.slice('data:'.length, row.indexOf(';')), 'Cache-Control': 'private, max-age=86400, immutable',
    'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}

function snapshotRevision(me: PollUser, refreshAt: number) {
  return digest([me.id, me.personalRevision, me.rosterRevision, me.chatRevision, refreshAt].join(':')).slice(0, 32) + '.' + refreshAt;
}

async function snapshot(db: D1Database, me: PollUser, now: number, since: string | null) {
  const previousExpiry = Number(since?.split('.')[1]);
  if (previousExpiry > now && previousExpiry <= now + MESSENGER_ONLINE_MS && since === snapshotRevision(me, previousExpiry)) {
    return json({ unchanged: true, revision: since, refreshAt: previousExpiry });
  }
  const cutoff = cutoffAt(now);
  const rows = await db.batch([
    db.prepare(`SELECT ${userFields} FROM messenger_users WHERE id <> ? AND last_seen > ? ORDER BY last_seen DESC, id`).bind(me.id, cutoff),
    db.prepare(conversationSql + ' ORDER BY COALESCE(m.created_at, c.created_at) DESC, c.id').bind(me.id, cutoff),
    db.prepare(`SELECT ${fileFields} FROM messenger_files f WHERE f.owner_id = ? ORDER BY f.created_at DESC, f.id`).bind(me.id),
    db.prepare(ticketSql + ' ORDER BY t.created_at DESC, t.id').bind(me.id, cutoff, now),
  ]);
  const state: MessengerState = {
    me: publicUser(me, now), users: (rows[0].results as unknown as UserRow[]).map(row => publicUser(row, now)),
    conversations: (rows[1].results as unknown as ConversationRow[]).map(conversationView),
    files: rows[2].results as unknown as MessengerFile[], transfers: (rows[3].results as unknown as MessengerTransfer[]).map(ticketView),
  };
  // A lease, file owner's account or ticket can expire even when no write occurs.
  // Re-evaluate logical visibility at the first such deadline, including before cron.
  let refreshAt = now + MESSENGER_ONLINE_MS;
  for (const user of state.users) refreshAt = Math.min(refreshAt, user.lastSeen + (user.online ? MESSENGER_ONLINE_MS : MESSENGER_RETENTION_MS));
  for (const ticket of state.transfers) refreshAt = Math.min(refreshAt, ticket.expiresAt);
  state.revision = snapshotRevision(me, refreshAt); state.refreshAt = refreshAt;
  return json(state);
}

async function roomView(db: D1Database, user: string, cutoff: number, room: string) {
  const row = await db.prepare(conversationSql + ' AND c.id = ?3').bind(user, cutoff, room).first<ConversationRow>();
  assert(row, 404, 'conversation_not_found', '会话不存在'); return conversationView(row);
}
async function conversations(request: Request, db: D1Database, user: string, now: number, sourceRoom?: string) {
  const cutoff = cutoffAt(now);
  const original = sourceRoom ? await roomView(db, user, cutoff, sourceRoom) : undefined;
  const data = await readJson(request, 8192);
  const input = data.userIds ?? (data.userId ? [data.userId] : undefined);
  assert(Array.isArray(input) && input.length > 0 && input.length <= 64 && input.every(hexId), 400, 'invalid_members', '请选择 1 至 64 位用户');
  const invited = [...new Set(input as string[])].filter(uid => uid !== user);
  assert(invited.length, 400, 'invalid_members', '请选择其他用户');
  const active = await db.prepare(`SELECT count(*) AS total FROM messenger_users WHERE id IN (SELECT value FROM json_each(?))
    AND last_seen > ?`).bind(JSON.stringify(invited), cutoff).first<number>('total');
  assert(active === invited.length, 404, 'user_not_found', '所选用户已过期');
  const members = [...new Set([user, ...(original?.memberIds ?? []), ...invited])].sort();
  if (original && members.length === original.memberIds.length) return json({ conversation: original });
  const dm = members.length === 2;
  // Canonical pairs make opposite-side /conversations calls idempotent even when simultaneous.
  const key = original?.kind === 'group' ? original.id : dm ? digest(`dm:${members.join(':')}`).slice(0, 32) : id();
  const batch: D1PreparedStatement[] = [];
  if (original?.kind !== 'group') {
    batch.push(db.prepare(`INSERT INTO messenger_conversations (id, kind, dm_left, dm_right, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(key, dm ? 'dm' : 'group', dm ? members[0] : null, dm ? members[1] : null, now));
  }
  batch.push(db.prepare(`INSERT INTO messenger_members (conversation_id, user_id)
    SELECT ?, value FROM json_each(?) WHERE true ON CONFLICT(conversation_id, user_id) DO NOTHING`)
    .bind(key, JSON.stringify(original?.kind === 'group' ? invited : members)));
  await db.batch(batch);
  return json({ conversation: await roomView(db, user, cutoff, key) }, original?.kind === 'group' ? 200 : 201);
}

async function messages(request: Request, env: Env, user: string, room: string, now: number) {
  const db = env.DB, cutoff = cutoffAt(now);
  const member = await db.prepare(visibleRoomIds + ' AND c.id = ?3').bind(user, cutoff, room).first('id');
  assert(member, 404, 'conversation_not_found', '会话不存在');
  if (request.method === 'GET') {
    const cursor = new URL(request.url).searchParams.get('before');
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
    assert(Number.isSafeInteger(before) && before > 0, 400, 'invalid_cursor', '消息游标无效');
    const { results } = await db.prepare(messageSql + ' AND m.sequence < ?4 ORDER BY m.sequence DESC LIMIT 51')
      .bind(user, cutoff, room, before).all<MessageRow>();
    return json({ messages: results.slice(0, 50).reverse().map(messageView), hasMore: results.length > 50 });
  }
  const conf = limits(env), data = await readJson(request, conf.controlMaxBytes);
  const text = data.text === undefined ? '' : data.text;
  assert(typeof text === 'string' && Array.from(text).length <= conf.chatMessageChars && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) &&
    (data.fileId === undefined || assetId(data.fileId)) && (text.trim() || data.fileId) &&
    (data.nonce === undefined || assetId(data.nonce)), 400, 'invalid_message', '消息内容或文件无效');
  const nonce = data.nonce ?? id();
  await db.prepare(`INSERT INTO messenger_messages (id, conversation_id, sender_id, nonce, text, file_id, created_at)
    SELECT ?4, ?3, ?1, ?5, ?6, ?7, ?8 WHERE ?3 IN (${visibleRoomIds}) AND
    (?7 IS NULL OR EXISTS (SELECT 1 FROM messenger_files WHERE id = ?7 AND owner_id = ?1))
    ON CONFLICT(conversation_id, sender_id, nonce) DO NOTHING`)
    .bind(user, cutoff, room, id(), nonce, text.trim(), data.fileId ?? null, now).run();
  const row = await db.prepare(messageSql + ' AND m.nonce = ?4 AND m.sender_id = ?1').bind(user, cutoff, room, nonce).first<MessageRow>();
  assert(row, 404, 'file_not_found', '文件不存在或已过期');
  const message = messageView(row);
  assert(message.text === text.trim() && message.file?.id === data.fileId, 409, 'nonce_conflict', '消息编号已被其他内容使用');
  return json({ message }, 201);
}

async function createFile(request: Request, env: Env, user: string, now: number) {
  const data = await readJson(request, 4096), db = env.DB;
  assert(assetId(data.id) && typeof data.name === 'string' && data.name.trim() && new TextEncoder().encode(data.name).length <= 1024 &&
    !/[\x00-\x1f\x7f/\\]/.test(data.name) && typeof data.size === 'number' && Number.isSafeInteger(data.size) && data.size >= 0 &&
    data.size <= limits(env).maxFileBytes && typeof data.lastModified === 'number' && Number.isSafeInteger(data.lastModified) &&
    data.lastModified >= 0 && typeof data.mime === 'string' && data.mime.length <= 128 && !/[\x00-\x1f\x7f]/.test(data.mime) &&
    (data.transferMode === undefined || data.transferMode === 'auto' || data.transferMode === 'lan'), 400, 'invalid_file', '文件信息无效');
  const mode = data.transferMode ?? 'auto', mime = data.mime || 'application/octet-stream';
  const batch = await db.batch([
    db.prepare(`INSERT INTO messenger_files (id, owner_id, name, size, mime, last_modified, transfer_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(data.id, user, data.name, data.size, mime, data.lastModified, mode, now),
    db.prepare(`SELECT ${fileFields} FROM messenger_files f WHERE f.id = ? AND f.owner_id = ?`).bind(data.id, user),
  ]);
  const file = batch[1].results[0] as unknown as MessengerFile | undefined;
  assert(file && file.size === data.size && file.name === data.name && file.mime === mime && file.lastModified === data.lastModified &&
    file.transferMode === mode, 409, 'file_id_conflict', '文件编号已被使用');
  return json({ file }, 201);
}

export async function messengerApi(request: Request, env: Env) {
  const url = new URL(request.url), route = url.pathname.slice('/api/messenger/'.length);
  const method = request.method, db = env.DB, now = Date.now();
  if (route === 'identity' && method === 'POST') return identity(request, db, now);
  const photo = MESSENGER_AVATAR_PATH.exec(url.pathname);
  if (photo && method === 'GET') return avatarResponse(db, url.pathname, photo[1], now);
  const polling = route === 'state' && method === 'GET';
  const user = await authenticate(request, db, now, polling);
  if (polling) return snapshot(db, user, now, url.searchParams.get('since'));
  if (route === 'profile' && method === 'PATCH') return updateProfile(request, db, user.id, now);
  if (route === 'conversations' && method === 'POST') return conversations(request, db, user.id, now);
  const room = /^conversations\/([a-f0-9]{32})\/(invite|messages)$/.exec(route);
  if (room?.[2] === 'invite' && method === 'POST') return conversations(request, db, user.id, now, room[1]);
  if (room?.[2] === 'messages' && (method === 'GET' || method === 'POST')) return messages(request, env, user.id, room[1], now);
  if (route === 'files' && method === 'POST') return createFile(request, env, user.id, now);
  const file = /^files\/([^/]+)$/.exec(route);
  if (file && assetId(file[1]) && method === 'DELETE') {
    const result = await db.prepare('DELETE FROM messenger_files WHERE id = ? AND owner_id = ?').bind(file[1], user.id).run();
    assert(result.meta.changes, 404, 'file_not_found', '文件不存在');
    await revokeMessengerRooms(env, file[1]);
    return json({ ok: true });
  }
  const ticket = /^transfers(?:\/([a-f0-9]{32}))?$/.exec(route);
  if (ticket) return transferApi(request, env, user.id, ticket[1]);
  return json({ error: 'not_found', message: '接口不存在' }, 404);
}
