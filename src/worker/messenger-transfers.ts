import { messengerAccountCutoff, type MessengerFile, type MessengerTransfer } from '../shared/messenger';
import type { ShareInfo } from '../shared/types';
import type { Env } from './config';
import { fileFields, ticketSql, ticketView, visibleRoomIds } from './messenger-view';
import { assert, budget, HttpError, id, json, readJson } from './util';

export function assetId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value);
}

export async function revokeMessengerRooms(env: Env, fileId?: string) {
  const sql = 'SELECT share_id FROM messenger_room_cleanup';
  const pending = fileId ? env.DB.prepare(sql + ' WHERE file_id = ? LIMIT 12').bind(fileId) : env.DB.prepare(sql + ' ORDER BY rowid LIMIT 12');
  const { results } = await pending.all<{ share_id: string }>();
  if (!results.length) return;
  await budget(env, '/do-used', { count: results.length });
  await Promise.all(results.map(async ({ share_id: shareId }) => {
    try {
      const room = env.ROOMS.get(env.ROOMS.idFromName(shareId));
      const response = await room.fetch(new Request('https://room/internal/admin/revoke', { method: 'DELETE' }));
      if (response.ok || response.status === 404) {
        await env.DB.prepare('DELETE FROM messenger_room_cleanup WHERE share_id = ?').bind(shareId).run();
      }
    } catch {
      // Retain the durable entry. The scheduled sweep retries a transient failure.
      console.error(JSON.stringify({ type: 'messenger-room-cleanup-retry', shareId }));
    }
  }));
}
export async function transferApi(request: Request, env: Env, user: string, ticketId?: string) {
  const db = env.DB, now = Date.now(), cutoff = messengerAccountCutoff(now);
  const lookup = (key: string) => db.prepare(ticketSql + ' AND t.id = ?4').bind(user, cutoff, now, key).first<MessengerTransfer>();
  if (!ticketId && request.method === 'POST') {
    const data = await readJson(request, 1024);
    assert(assetId(data.fileId) && (data.conversationId === undefined || assetId(data.conversationId)), 400, 'invalid_transfer', '文件或会话编号无效');
    const key = id();
    const created = await db.prepare(`INSERT INTO messenger_transfers
      (id, file_id, conversation_id, owner_id, requester_id, status, created_at, expires_at)
      SELECT ?3, f.id, ?4, f.owner_id, ?1, 'pending', ?5, ?6 FROM messenger_files f
      JOIN messenger_users u ON u.id = f.owner_id AND u.last_seen > ?2
      WHERE f.id = ?7 AND ((f.owner_id = ?1 AND ?4 IS NULL) OR
        (?4 IN (${visibleRoomIds}) AND EXISTS (SELECT 1 FROM messenger_messages m
        WHERE m.conversation_id = ?4 AND m.file_id = f.id)))`)
      .bind(user, cutoff, key, data.conversationId ?? null, now, now + 5 * 60_000, data.fileId).run();
    assert(created.meta.changes, 404, 'file_not_found', '此会话中没有这个文件');
    const row = await lookup(key);
    assert(row, 404, 'transfer_not_found', '下载请求已结束'); return json({ transfer: ticketView(row) }, 201);
  }
  if (ticketId && request.method === 'DELETE') {
    const removed = await db.prepare('DELETE FROM messenger_transfers WHERE id = ? AND requester_id = ? RETURNING file_id, share_id')
      .bind(ticketId, user).first<{ file_id: string; share_id: string | null }>();
    if (removed?.share_id) await revokeMessengerRooms(env, removed.file_id);
    return json({ ok: true });
  }
  assert(ticketId && (request.method === 'GET' || request.method === 'PATCH'), 404, 'not_found', '接口不存在');
  const row = await lookup(ticketId);
  assert(row, 404, 'transfer_not_found', '下载请求不存在或已过期');
  if (request.method === 'GET') return json({ transfer: ticketView(row) });
  assert(row.ownerId === user, 403, 'owner_required', '仅文件所有者可回应下载请求');
  assert(row.status === 'pending', 409, 'transfer_resolved', '另一个页面已处理下载请求');
  const data = await readJson(request, 2048);
  let update: D1PreparedStatement;
  if (data.status === 'failed') {
    assert(typeof data.reason === 'string' && data.reason.trim().length > 0 && data.reason.length <= 256, 400, 'invalid_reason', '请提供简短的失败原因');
    update = db.prepare("UPDATE messenger_transfers SET status = 'failed', reason = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .bind(data.reason.trim(), row.id, now);
  } else {
    assert(data.status === 'ready' && typeof data.shareId === 'string' && /^[a-f0-9]{32}$/.test(data.shareId) &&
      typeof data.shareFileId === 'string' && /^[a-f0-9]{32}$/.test(data.shareFileId) &&
      typeof data.ownerToken === 'string' && /^[a-f0-9]{64}$/.test(data.ownerToken) &&
      typeof data.password === 'string' && data.password.length >= 4 && data.password.length <= 64, 400, 'invalid_transfer', '传输分享信息无效');
    const file = await db.prepare(`SELECT ${fileFields} FROM messenger_files f WHERE f.id = ? AND f.owner_id = ?`).bind(row.fileId, user).first<MessengerFile>();
    assert(file, 404, 'file_not_found', '源文件已删除');
    await budget(env, '/do-used', { count: 1 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(data.shareId));
    const response = await room.fetch(new Request('https://room/internal/messenger-attachment', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.ownerToken}` },
      body: JSON.stringify({ password: data.password }),
    }));
    if (!response.ok) {
      const failure = await response.json<{ error: string; message: string }>();
      throw new HttpError(response.status, failure.error, failure.message);
    }
    const share = await response.json<ShareInfo>(), source = share.files[0];
    assert(share.status === 'active' && share.transferMode === file.transferMode && share.files.length === 1 &&
      source.id === data.shareFileId && source.size === file.size && source.name === file.name &&
      source.mime === file.mime && source.lastModified === file.lastModified, 409, 'source_mismatch', '分享与请求的源文件不匹配');
    update = db.prepare(`UPDATE OR IGNORE messenger_transfers SET status = 'ready', share_id = ?, share_file_id = ?,
      password = ?, expires_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`)
      .bind(share.id, source.id, data.password, share.expiresAt, row.id, Date.now());
  }
  const result = await update.run();
  assert(result.meta.changes, 409, 'transfer_resolved', '下载请求已结束或此分享已被使用');
  const completed = await lookup(row.id);
  assert(completed, 404, 'transfer_not_found', '下载请求已结束');
  return json({ transfer: ticketView(completed) });
}
