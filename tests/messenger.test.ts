import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { MESSENGER_RETENTION_MS, type MessengerConversation, type MessengerFile, type MessengerMessage, type MessengerState, type MessengerTransfer, type MessengerUser } from '../src/shared/messenger';
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
const addFile = async (credential: string) => (await value<{ file: MessengerFile }>(api('files', credential, { ...meta, id: id() }))).file;
const send = async (credential: string, room: string, body: object) => (await value<{ message: MessengerMessage }>(api(`conversations/${room}/messages`, credential, body))).message;

describe('匿名通信录、私聊与网盘', () => {
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
    const prepare = async (files: typeof meta[], password?: string) => value<{id:string; ownerToken:string; files:{id:string}[]}>(request('shares', undefined, { files, password }));
    const password = token(), ready = (share: Awaited<ReturnType<typeof prepare>>) => ({status:'ready', shareId: share.id, ownerToken: share.ownerToken, shareFileId: share.files[0].id, password});
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
  it('在线状态到期后保留资料，24 小时到期立即隐藏私聊及文件并阻止凭据复活', async () => {
    const a = await identity(), b = await identity(), c = await identity(), dm = await conf(a.credential, b.id);
    const group = await conf(b.credential, a.id, c.id), file = await addFile(a.credential);
    await send(a.credential, group.id, { fileId: file.id });
    const seen = (ms: number) => env.DB.prepare('UPDATE messenger_users SET last_seen = ? WHERE id = ?').bind(Date.now() - ms, a.id).run();
    await seen(65_000);
    expect((await state(b.credential)).users.find(u => u.id === a.id)?.online).toBe(false);
    await seen(MESSENGER_RETENTION_MS + 10);
    const snapshot = await state(b.credential);
    expect(snapshot.users.some(u => u.id === a.id)).toBe(false);
    expect(snapshot.conversations.some(r => r.id === dm.id)).toBe(false);
    expect(await history(b.credential, group.id)).toEqual([]);
    expect((await api('state', a.credential)).status).toBe(401);
    expect((await api('transfers', b.credential, {fileId:file.id,conversationId:group.id})).status).toBe(404);
    expect((await identity(a.credential)).id).not.toBe(a.id);
    expect((await state(a.credential)).files).toEqual([]);
    expect(await env.DB.prepare('SELECT count(*) n FROM messenger_files').first('n')).toBe(0);
    await env.DB.prepare('UPDATE messenger_users SET last_seen = 0').run();
    await sweepMessenger(env, Date.now());
    expect(await env.DB.prepare('SELECT count(*) n FROM messenger_conversations').first('n')).toBe(0);
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
    expect((await state(b.credential)).conversations[0].lastMessage?.text).toBe('53');
  });
  it('静默轮询只返回变更标记，私聊活动不影响非成员，头像独立缓存', async () => {
    const a = await identity(), b = await identity(), c = await identity(), dm = await conf(a.credential, b.id);
    const aState = await state(a.credential), cState = await state(c.credential);
    const since = (revision: string) => 'state?since=' + revision;
    expect(await value(api(since(aState.revision!), a.credential))).toEqual({
      unchanged: true, revision: aState.revision, refreshAt: aState.refreshAt,
    });
    await send(b.credential, dm.id, { text: '仅成员重新加载' });
    expect((await value<MessengerState>(api(since(aState.revision!), a.credential))).conversations[0].lastMessage?.text).toBe('仅成员重新加载');
    expect(await value(api(since(cState.revision!), c.credential))).toMatchObject({ unchanged:true });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sFoYAAAAASUVORK5CYII=';
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
});
