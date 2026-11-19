import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import type { MessengerConversation, MessengerFile, MessengerMessage, MessengerState, MessengerTransfer, MessengerUser } from '../src/shared/messenger';
import { digest, id, token } from '../src/worker/util';
import { sweepMessenger } from '../src/worker/messenger';

async function request(path: string, credential?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers = new Headers();
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(`https://share.test/api/${path}`, { method, headers, body: JSON.stringify(body) }), env);
}
const api = (path: string, auth?: string, body?: unknown, method?: string) => request(`messenger/${path}`, auth, body, method);
async function value<T>(response: Promise<Response>): Promise<T> {
  const result = await response;
  const data = await result.json<T>();
  expect(result.ok, JSON.stringify(data)).toBe(true);
  return data;
}
async function identity(credential = token()) {
  const { user } = await value<{ user: MessengerUser }>(api('identity', undefined, { credential, fingerprint: digest('same-browser-signals') }));
  return { ...user, credential };
}
const conf = async (credential: string, ...userIds: string[]) => (await value<{ conversation: MessengerConversation }>(api('conversations', credential, { userIds }))).conversation;
const join = async (credential: string, room: string, ...userIds: string[]) => (await value<{ conversation: MessengerConversation }>(api(`conversations/${room}/invite`, credential, { userIds }))).conversation;
const history = async (credential: string, room: string) => (await value<{ messages: MessengerMessage[] }>(api(`conversations/${room}/messages`, credential))).messages;
const state = (credential: string) => value<MessengerState>(api('state', credential));
const meta = { name: '原文件.txt', size: 3, mime: 'text/plain', lastModified: 123 };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sFoYAAAAASUVORK5CYII=';
const prepare = (files: typeof meta[], password?: string) => value<{id:string; ownerToken:string; files:{id:string}[]}>(
  request('shares', undefined, { files, password }),
);
const readyTicket = (share: Awaited<ReturnType<typeof prepare>>, password: string) => ({
  status: 'ready', shareId: share.id, ownerToken: share.ownerToken, shareFileId: share.files[0].id, password,
});
const addFile = async (credential: string) => (await value<{ file: MessengerFile }>(api('files', credential, { ...meta, id: id() }))).file;
const send = async (credential: string, room: string, body: object) => (await value<{ message: MessengerMessage }>(api(`conversations/${room}/messages`, credential, body))).message;
const plaza = '00000000000000000000000000000000';
const minute = 60_000;
function clock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  return (elapsed: number) => vi.setSystemTime(start + elapsed);
}

describe('匿名通信录、私聊与网盘', () => {
  it('升级时把已有用户加入广场，新身份自动加入同一个广场并可读写公共消息', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 5));
    const oldId = id(), credential = token();
    await env.DB.prepare('INSERT INTO messenger_users(id, credential_hash, name, avatar, last_seen) VALUES (?, ?, ?, ?, ?)')
      .bind(oldId, digest(credential), '旧访客', '🐱', Date.now()).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const migratedMembership = await env.DB.prepare('SELECT user_id FROM messenger_members WHERE conversation_id = ?')
      .bind(plaza).all();
    expect(migratedMembership.results).toEqual([{ user_id: oldId }]);
    const guest = await identity();
    const rooms = (await state(guest.credential)).conversations;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: plaza, kind: 'group' });
    expect(rooms[0].memberIds.sort()).toEqual([guest.id, oldId].sort());
    const message = await send(credential, plaza, { text: '广场见' });
    expect(await history(guest.credential, plaza)).toEqual([message]);
    expect((await identity(credential)).id).toBe(oldId);
    expect((await state(credential)).conversations).toHaveLength(1);
  });
  it('升级前已经全员离线两小时的会话沿用原来的离线时间', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 5));
    const credentials = [token(), token(), token()];
    const users = [id(), id(), id()].sort();
    const lastSeen = Date.now() - 120 * minute, dm = id(), group = id();
    const member = env.DB.prepare('INSERT INTO messenger_members(conversation_id, user_id) VALUES (?, ?)');
    const message = env.DB.prepare('INSERT INTO messenger_messages(id, conversation_id, sender_id, nonce, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    await env.DB.batch([
      ...users.map((user, i) => env.DB.prepare('INSERT INTO messenger_users(id, credential_hash, name, avatar, last_seen) VALUES (?, ?, ?, ?, ?)')
        .bind(user, digest(credentials[i]), '旧访客', '🐱', lastSeen)),
      env.DB.prepare("INSERT INTO messenger_conversations(id, kind, dm_left, dm_right, created_at) VALUES (?, 'dm', ?, ?, ?)").bind(dm, users[0], users[1], lastSeen),
      env.DB.prepare("INSERT INTO messenger_conversations(id, kind, created_at) VALUES (?, 'group', ?)").bind(group, lastSeen),
      ...users.slice(0, 2).map(user => member.bind(dm, user)), ...users.map(user => member.bind(group, user)),
      ...[dm, group].map(room => message.bind(id(), room, users[0], id(), '先前的消息', lastSeen)),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const rooms = (await state(credentials[0])).conversations;
    expect(rooms.map(room => room.id).sort()).toEqual([dm, plaza].sort());
    expect(await history(credentials[0], dm)).toEqual([]);
  });
  it('最后一位成员在到期前重连会保住群聊，同期无人返回的私聊清空历史、预览和下载权限', async () => {
    const at = clock();
    const a = await identity(), b = await identity(), c = await identity();
    const dm = await conf(a.credential, b.id), group = await conf(a.credential, b.id, c.id);
    const file = await addFile(a.credential);
    await send(a.credential, dm.id, { text: '私聊附件', fileId: file.id });
    const kept = await send(a.credential, group.id, { text: '群聊消息' });
    const revision = (await state(a.credential)).revision!;
    at(11 * minute - 1);
    expect(await history(c.credential, group.id)).toEqual([kept]);
    at(11 * minute);
    const [snapshot, messages] = await Promise.all([
      value<MessengerState>(api('state?since=' + revision, a.credential)), history(b.credential, dm.id),
    ]);
    expect(messages).toEqual([]);
    expect(snapshot.conversations.find(room => room.id === dm.id)).toBeDefined();
    expect(snapshot.conversations.find(room => room.id === dm.id)?.lastMessage).toBeUndefined();
    expect(snapshot.conversations.find(room => room.id === group.id)?.lastMessage).toEqual(kept);
    expect(snapshot.files).toEqual([file]);
    expect((await api('transfers', b.credential, { fileId: file.id, conversationId: dm.id })).status).toBe(404);
    at(22 * minute);
    expect(await history(c.credential, group.id)).toEqual([]);
  });
  it('全员离线满 10 分钟后首位新访客进入广场时看不到旧消息', async () => {
    const at = clock(), a = await identity();
    await send(a.credential, plaza, { text: '旧广场消息' });
    at(11 * minute);
    const b = await identity();
    expect(await history(b.credential, plaza)).toEqual([]);
    expect((await state(a.credential)).conversations.find(room => room.id === plaza)?.lastMessage).toBeUndefined();
    const fresh = await send(b.credential, plaza, { text: '新广场消息' });
    expect(await history(a.credential, plaza)).toEqual([fresh]);
  });
  it('聊天清空后重新发送同一个云盘文件不会恢复旧下载请求，清理会撤销旧分享', async () => {
    const at = clock();
    const a = await identity(), b = await identity(), dm = await conf(a.credential, b.id);
    const file = await addFile(a.credential);
    await send(a.credential, dm.id, { fileId: file.id });
    const { transfer } = await value<{ transfer: MessengerTransfer }>(api('transfers', b.credential, { fileId: file.id, conversationId: dm.id }));
    const password = token(), share = await prepare([meta], password);
    const ticket = `transfers/${transfer.id}`;
    await value(api(ticket, a.credential, readyTicket(share, password), 'PATCH'));
    at(11 * minute);
    await send(a.credential, dm.id, { fileId: file.id });
    expect((await api(ticket, b.credential)).status).toBe(404);
    expect((await state(a.credential)).files).toEqual([file]);
    const replacement = await value<{ transfer: MessengerTransfer }>(api('transfers', b.credential, { fileId: file.id, conversationId: dm.id }));
    expect(replacement.transfer.id).not.toBe(transfer.id);
    await sweepMessenger(env, Date.now());
    expect((await request(`shares/${share.id}`, share.ownerToken)).status).toBe(410);
  });
  it('全员离线满一小时后，续租和邀请都不能恢复旧群，私聊和广场仍可用', async () => {
    const at = clock();
    const a = await identity(), b = await identity(), c = await identity(), d = await identity();
    const group = await conf(a.credential, b.id, c.id), dm = await conf(a.credential, b.id);
    at(61 * minute - 1);
    await sweepMessenger(env, Date.now());
    expect(await env.DB.prepare('SELECT id FROM messenger_conversations WHERE id = ?').bind(group.id).first('id')).toBe(group.id);
    at(61 * minute);
    expect((await api(`conversations/${group.id}/invite`, a.credential, { userIds: [d.id] })).status).toBe(404);
    expect((await api(`conversations/${group.id}/messages`, b.credential, { text: '已过期' })).status).toBe(404);
    const rooms = (await state(c.credential)).conversations;
    expect(rooms.map(room => room.id)).toEqual([plaza]);
    expect(await history(a.credential, dm.id)).toEqual([]);
  });
  it('无人再次访问时，定时清理按三个截止时间删除消息、群和云盘，并保留广场', async () => {
    const at = clock();
    const a = await identity(), b = await identity(), c = await identity();
    const group = await conf(a.credential, b.id, c.id), file = await addFile(a.credential);
    await send(a.credential, group.id, { fileId: file.id });
    const sweepAt = async (elapsed: number) => { at(elapsed); await sweepMessenger(env, Date.now()); };
    const stored = (table: string, key: string) => env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(key).first('id');
    await sweepAt(11 * minute - 1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM messenger_messages').first('n')).toBe(1);
    await sweepAt(11 * minute);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM messenger_messages').first('n')).toBe(0);
    expect(await stored('messenger_conversations', group.id)).toBe(group.id);
    await sweepAt(61 * minute);
    expect(await stored('messenger_conversations', group.id)).toBeNull();
    await sweepAt(721 * minute - 1);
    expect(await stored('messenger_users', a.id)).toBe(a.id);
    expect(await stored('messenger_files', file.id)).toBe(file.id);
    await sweepAt(721 * minute);
    await sweepMessenger(env, Date.now());
    expect(await stored('messenger_users', a.id)).toBeNull();
    expect(await stored('messenger_files', file.id)).toBeNull();
    expect(await stored('messenger_conversations', plaza)).toBe(plaza);
    const newcomer = await identity();
    expect(await history(newcomer.credential, plaza)).toEqual([]);
  });
  it('指纹相同的浏览器仍具备独立身份，私密凭据恢复资料，目录隐藏凭据', async () => {
    const a = await identity(), b = await identity();
    expect(a.id).not.toBe(b.id);
    await value(api('profile', a.credential, { name: '河马', avatar: '🦛' }, 'PATCH'));
    expect(await identity(a.credential)).toMatchObject({ id: a.id, name: '河马', avatar: '🦛' });
    const result = await state(b.credential);
    expect(result.users).toEqual([expect.objectContaining({ id: a.id, online: true })]);
    expect(JSON.stringify(result)).not.toContain(a.credential);
    expect((await api('state', digest('same-browser-signals'))).status).toBe(401);
    expect((await api('profile', a.credential, { avatar: 'data:image/webp;base64,dGVzdA==' }, 'PATCH')).status).toBe(400);
    expect((await api('profile', a.credential, { avatar: 'data:image/svg+xml;base64,PHN2Zy8+' }, 'PATCH')).status).toBe(400);
  });
  it('复用双方的私聊，非成员无法读取，邀请时新建群且不复制私聊记录', async () => {
    const a = await identity(), b = await identity(), c = await identity(), d = await identity();
    const [dm, reverse] = await Promise.all([conf(a.credential, b.id), conf(b.credential, a.id)]);
    expect(reverse.id).toBe(dm.id);
    const payload = { nonce: id(), text: '仅两人可见' };
    const message = await send(a.credential, dm.id, payload);
    expect((await send(a.credential, dm.id, payload)).id).toBe(message.id);
    expect((await api(`conversations/${dm.id}/messages`, c.credential)).status).toBe(404);
    expect((await api(`conversations/${dm.id}/invite`, c.credential, { userIds: [d.id] })).status).toBe(404);
    expect((await api(`conversations/${dm.id}/messages`, c.credential, { text: '未授权' })).status).toBe(404);
    const group = await join(a.credential, dm.id, c.id);
    expect(group.kind).toBe('group'); expect(group.id).not.toBe(dm.id);
    expect(await history(c.credential, group.id)).toEqual([]);
    expect(await history(b.credential, dm.id)).toHaveLength(1);
    const expanded = await join(c.credential, group.id, d.id);
    expect(expanded.id).toBe(group.id); expect(expanded.memberIds).toHaveLength(4);
    expect((await conf(a.credential, b.id, c.id)).kind).toBe('group');
  });
  it('文件发布只存元数据，只有成员可请求自己会话中的文件，只有所有者可关联受保护且匹配的分享', async () => {
    const a = await identity(), b = await identity(), c = await identity(), dm = await conf(a.credential, b.id);
    const asset = await addFile(a.credential);
    const ticket = { fileId: asset.id, conversationId: dm.id };
    expect((await api('transfers', b.credential, ticket)).status).toBe(404);
    expect((await api(`conversations/${dm.id}/messages`, b.credential, {fileId: asset.id})).status).toBe(404);
    await send(a.credential, dm.id, { text: '请查收', fileId: asset.id });
    expect((await state(a.credential)).files).toEqual([asset]); expect((await state(b.credential)).files).toEqual([]);
    expect((await api('transfers', c.credential, ticket)).status).toBe(404);
    expect((await api('transfers', b.credential, {fileId: asset.id})).status).toBe(404);
    expect(await env.DB.prepare('SELECT count(*) n FROM shares').first('n')).toBe(0);
    const { transfer } = await value<{transfer: MessengerTransfer}>(api('transfers', b.credential, ticket));
    const path = `transfers/${transfer.id}`;
    expect((await api(path, c.credential)).status).toBe(404);
    await value(api(path, c.credential, undefined, 'DELETE'));
    expect((await api(path, b.credential)).status).toBe(200);
    const { transfer: canceled } = await value<{transfer: MessengerTransfer}>(api('transfers', b.credential, ticket));
    await value(api(`transfers/${canceled.id}`, b.credential, undefined, 'DELETE'));
    await value(api(`transfers/${canceled.id}`, b.credential, undefined, 'DELETE'));
    expect((await api(`transfers/${canceled.id}`, a.credential)).status).toBe(404);
    expect((await api(path, b.credential, {status:'failed',reason:'x'}, 'PATCH')).status).toBe(403);
    const password = token(), ready = (share: Awaited<ReturnType<typeof prepare>>) => readyTicket(share, password);
    expect((await api(path, a.credential, ready(await prepare([meta])), 'PATCH')).ok).toBe(false);
    expect((await api(path, a.credential, ready(await prepare([{...meta, size: 4}], password)), 'PATCH')).ok).toBe(false);
    const share = await prepare([meta], password);
    expect((await api(path, a.credential, {...ready(share), ownerToken: token()}, 'PATCH')).status).toBe(403);
    await value(api(path, a.credential, ready(share), 'PATCH'));
    expect((await state(b.credential)).transfers[0]).toMatchObject({ status:'ready', password, shareId: share.id });
    expect(JSON.stringify(await state(b.credential))).not.toContain(share.ownerToken);
    expect((await api(path, a.credential, {status:'failed',reason:'late'}, 'PATCH')).status).toBe(409);
    expect((await request(`shares/${share.id}/sessions`, undefined, {role:'receiver',password:'wrong'})).status).toBe(403);
    const session = await request(`shares/${share.id}/sessions`, undefined, {role:'receiver',password});
    expect(session.status).toBe(201); expect(session.headers.has('Set-Cookie')).toBe(false);
    const {sessionToken} = await session.json<{sessionToken:string}>();
    expect((await request(`shares/${share.id}`, sessionToken)).status).toBe(200);
    const nextRoom = await prepare([meta], password);
    const { transfer: finished } = await value<{transfer: MessengerTransfer}>(api('transfers', b.credential, ticket));
    const finishedPath = `transfers/${finished.id}`;
    await value(api(finishedPath, a.credential, ready(nextRoom), 'PATCH'));
    await value(api(finishedPath, b.credential, undefined, 'DELETE'));
    expect((await request(`shares/${nextRoom.id}`, nextRoom.ownerToken)).status).toBe(410);
    expect((await api(finishedPath, a.credential)).status).toBe(404);
    expect((await api(`files/${asset.id}`, b.credential, undefined, 'DELETE')).status).toBe(404);
    await value(api(`files/${asset.id}`, a.credential, undefined, 'DELETE'));
    expect((await history(b.credential, dm.id))[0].file).toBeUndefined();
    expect((await api(path, b.credential)).status).toBe(404);
    expect((await request(`shares/${share.id}`, sessionToken)).status).toBe(410);
  });
  it('离线满 12 小时立即隐藏账号、私聊和文件，同一凭据重新连接后得到空云盘', async () => {
    const a = await identity(), b = await identity(), c = await identity(), dm = await conf(a.credential, b.id);
    const group = await conf(b.credential, a.id, c.id), file = await addFile(a.credential);
    await send(a.credential, group.id, { fileId: file.id });
    const seen = (ms: number) => env.DB.prepare('UPDATE messenger_users SET last_seen = ? WHERE id = ?').bind(Date.now() - ms, a.id).run();
    await seen(65_000);
    expect((await state(b.credential)).users.find(u => u.id === a.id)?.online).toBe(false);
    await seen((12 * 60 + 1) * minute);
    const snapshot = await state(b.credential);
    expect(snapshot.users.some(u => u.id === a.id)).toBe(false);
    expect(snapshot.conversations.some(r => r.id === dm.id)).toBe(false);
    expect(await history(b.credential, group.id)).toEqual([]);
    expect((await api('state', a.credential)).status).toBe(401);
    expect((await api('transfers', b.credential, {fileId:file.id,conversationId:group.id})).status).toBe(404);
    expect((await identity(a.credential)).id).not.toBe(a.id);
    expect((await state(a.credential)).files).toEqual([]);
    expect(await env.DB.prepare('SELECT count(*) n FROM messenger_files').first('n')).toBe(0);
    await sweepMessenger(env, Date.now() + (12 * 60 + 1) * minute);
    expect((await env.DB.prepare('SELECT id FROM messenger_conversations').all()).results).toEqual([{ id: plaza }]);
    expect(await env.DB.prepare('SELECT count(*) n FROM messenger_members').first('n')).toBe(0);
  });
  it('向上翻页使用单调消息序号，不遗漏或重复相同时间的消息', async () => {
    const a = await identity(), b = await identity(), dm = await conf(a.credential, b.id);
    const insert = env.DB.prepare(`INSERT INTO messenger_messages(id, conversation_id, sender_id, nonce, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    await env.DB.batch(Array.from({length: 54}, (_, index) => insert.bind(id(), dm.id, a.id, id(), String(index), now)));
    const path = `conversations/${dm.id}/messages`;
    const latest = await value<{messages: MessengerMessage[]; hasMore: boolean}>(api(path, b.credential));
    expect(latest.hasMore).toBe(true); expect(latest.messages.map(m => Number(m.text))).toEqual(Array.from({length:50}, (_, n) => n+4));
    const older = await value<{messages: MessengerMessage[]; hasMore: boolean}>(api(path + '?before=' + latest.messages[0].sequence, b.credential));
    expect(older.hasMore).toBe(false); expect(older.messages.map(m => m.text)).toEqual(['0','1','2','3']);
    expect((await state(b.credential)).conversations.find(room => room.id === dm.id)?.lastMessage?.text).toBe('53');
  });
  it('连续轮询报告实际心跳租约的剩余时长', async () => {
    const at = clock(), a = await identity();
    const snapshot = await state(a.credential);
    expect(snapshot).toMatchObject({ presenceLeaseMs: 60_000 });
    at(12_000);
    expect(await value(api('state?since=' + snapshot.revision, a.credential)))
      .toMatchObject({ unchanged: true, presenceLeaseMs: 48_000 });
    at(15_000);
    expect(await state(a.credential)).toMatchObject({ presenceLeaseMs: 60_000 });
  });
  it('静默轮询只返回变更标记，私聊活动不影响非成员，头像独立缓存', async () => {
    const a = await identity(), b = await identity(), c = await identity(), dm = await conf(a.credential, b.id);
    const aState = await state(a.credential), cState = await state(c.credential);
    const since = (revision: string) => 'state?since=' + revision;
    expect(await value(api(since(aState.revision!), a.credential))).toEqual({
      unchanged: true, revision: aState.revision, refreshAt: aState.refreshAt, presenceLeaseMs: expect.any(Number),
    });
    await send(b.credential, dm.id, { text: '仅成员重新加载' });
    expect((await value<MessengerState>(api(since(aState.revision!), a.credential))).conversations.find(room => room.id === dm.id)?.lastMessage?.text).toBe('仅成员重新加载');
    expect(await value(api(since(cState.revision!), c.credential))).toMatchObject({ unchanged:true });
    const { user } = await value<{ user: MessengerUser }>(api('profile', a.credential, {avatar:png}, 'PATCH'));
    expect(user.avatar).toMatch(/^\/api\/messenger\/avatars\/[a-f0-9]+\/[a-f0-9]+$/);
    const directory = await value<MessengerState>(api(since(cState.revision!), c.credential));
    expect(directory.users.find(u => u.id === a.id)?.avatar).toBe(user.avatar);
    expect(JSON.stringify(directory)).not.toContain('base64');
    const imagePath = user.avatar.slice('/api/'.length);
    const image = await request(imagePath);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('Cache-Control')).toContain('immutable');
    expect((await image.arrayBuffer()).byteLength).toBe(atob(png.split(',')[1]).length);
    expect((await api('profile', b.credential, {avatar:user.avatar}, 'PATCH')).status).toBe(409);
    await value(api('profile', a.credential, {name:'新昵称',avatar:user.avatar}, 'PATCH'));
    await value(api('profile', a.credential, {avatar:'🍎'}, 'PATCH'));
    expect((await request(imagePath)).status).toBe(404);
  });
  it('头像缓存最多保留到账号销毁前的整秒，过期当天无需等待清理即可返回 404', async () => {
    const at = clock(), owner = await identity();
    const { user } = await value<{ user: MessengerUser }>(api('profile', owner.credential, { avatar: png }, 'PATCH'));
    const path = user.avatar.slice('/api/'.length);
    const deadline = 721 * minute;
    at(deadline - 1_999);
    const nearExpiry = await request(path);
    expect(nearExpiry.status).toBe(200);
    expect(nearExpiry.headers.get('Cache-Control')?.split(/,\s*/)).toEqual(expect.arrayContaining(['private', 'immutable', 'max-age=1']));
    at(deadline - 1);
    expect((await request(path)).headers.get('Cache-Control')?.split(/,\s*/)).toContain('max-age=0');
    at(deadline);
    expect((await request(path)).status).toBe(404);
  });
});
