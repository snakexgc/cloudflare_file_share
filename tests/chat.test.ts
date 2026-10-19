import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { chatName, type ChatMessage, type ChatSnapshot } from '../src/shared/chat';
import { defaults, limits } from '../src/worker/config';
import { id } from '../src/worker/util';
import type { FileInfo } from '../src/shared/types';

interface Joined { sessionToken: string; generation: number; nameUnavailable: boolean; snapshot: ChatSnapshot }
const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(1000, 'test complete'); });
async function call(path: string, data?: unknown, token?: string, method = data === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) }), env);
}
async function join(preferredName?: string, token?: string): Promise<Joined> {
  const response = await call('/api/chat/sessions', { preferredName }, token); expect(response.status).toBe(201); return response.json();
}
async function post(member: Joined, text = 'hello', extra: Record<string, unknown> = {}) { return call('/api/chat/messages', { nonce: id(), text, ...extra }, member.sessionToken); }
async function state(member: Joined): Promise<ChatSnapshot> { const response = await call('/api/chat/state', undefined, member.sessionToken); expect(response.status).toBe(200); return (await response.json<{ snapshot: ChatSnapshot }>()).snapshot; }
async function share(password?: string) {
  return (await call('/api/shares', { files: [{ name: 'original.txt', size: 4, mime: 'text/plain', lastModified: 1 }], ...(password ? { password } : {}) })).json() as Promise<{ id: string; ownerToken: string; files: FileInfo[] }>;
}
function next(socket: WebSocket, predicate: (message: string) => boolean) {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('chat socket timeout')); }, 2500);
    const onMessage = (event: MessageEvent) => { if (typeof event.data === 'string' && predicate(event.data)) { clearTimeout(timeout); socket.removeEventListener('message', onMessage); resolve(event.data); } };
    socket.addEventListener('message', onMessage);
  });
}

describe('公共聊天室与用户名', () => {
  it('打开即加入，生成不重名临时昵称；历史和在线列表不泄露令牌', async () => {
    const a = await join(), b = await join(); expect(a.snapshot.self.name).not.toBe(b.snapshot.self.name);
    expect(b.snapshot.members).toHaveLength(2); expect(JSON.stringify(await state(a))).not.toContain('tokenHash'); expect(JSON.stringify(await state(a))).not.toContain(a.sessionToken);
    await post(a, '<img src=x onerror=alert(1)>');
    const c = await join(); expect(c.snapshot.messages[0].text).toBe('<img src=x onerror=alert(1)>'); expect(c.snapshot.members).toHaveLength(3);
  });
  it('并发改名由服务端串行抢占，NFKC / 大小写 / 空白别名不能重名', async () => {
    const a = await join(), b = await join();
    const results = await Promise.all([call('/api/chat/name', { name: 'Alice' }, a.sessionToken), call('/api/chat/name', { name: 'ＡＬＩＣＥ' }, b.sessionToken)]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const snapshot = await state(a); expect(new Set(snapshot.members.map(member => chatName(member.name)!.key)).size).toBe(2);
    const owner = snapshot.members.find(member => chatName(member.name)!.key === 'alice')!;
    const other = owner.id === a.snapshot.self.id ? b : a;
    expect((await call('/api/chat/name', { name: '  alice  ' }, other.sessionToken)).status).toBe(409);
  });
  it('保存昵称冲突仍自动进入；恢复会话保留名字，改名后旧名立即可用', async () => {
    const a = await join('可可'), b = await join('可可'); expect(a.snapshot.self.name).toBe('可可'); expect(b.nameUnavailable).toBe(true); expect(b.snapshot.self.name).not.toBe('可可');
    const resumed = await join('其他名字', a.sessionToken); expect(resumed.snapshot.self.id).toBe(a.snapshot.self.id); expect(resumed.snapshot.self.name).toBe('可可'); expect(resumed.sessionToken).toBe(a.sessionToken);
    expect((await call('/api/chat/name', { name: '小明' }, a.sessionToken)).status).toBe(200);
    expect((await call('/api/chat/name', { name: '可可' }, b.sessionToken)).status).toBe(200);
  });
  it.each(['', ' ', '<script>', 'a\nb', 'a\u200bb', '\u202eabc', 'a'.repeat(21)])('拒绝无效昵称 %j', async name => {
    const a = await join(); expect((await call('/api/chat/name', { name }, a.sessionToken)).status).toBe(400);
  });
  it('离开与租约到期释放昵称，旧令牌不能再冒用', async () => {
    const a = await join('小雨'); expect((await call('/api/chat/leave', { token: a.sessionToken })).status).toBe(200);
    const b = await join('小雨'); expect(b.nameUnavailable).toBe(false);
    expect((await post(a)).status).toBe(401);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + defaults.leaseMs + 1);
    const c = await join('小雨'); expect(c.nameUnavailable).toBe(false); expect(c.snapshot.members).toHaveLength(1); expect((await post(b)).status).toBe(401);
  });
  it('DO 重启后仍保留在线名字、消息、令牌及请求去重', async () => {
    const a = await join('重启用户'), nonce = id(); const first = await post(a, 'persisted', { nonce }); expect(first.status).toBe(201);
    const message = (await first.json<{ message: ChatMessage }>()).message;
    await abortAllDurableObjects();
    const b = await join('重启用户'); expect(b.nameUnavailable).toBe(true); expect(b.snapshot.messages[0].id).toBe(message.id);
    const duplicate = await post(a, 'persisted', { nonce }); expect(duplicate.status).toBe(200); expect((await duplicate.json<{ message: ChatMessage }>()).message.id).toBe(message.id); expect((await state(a)).messages).toHaveLength(1);
  });
  it('页面刷新先恢复会话时，旧页面迟到的离开请求不会删除新连接', async () => {
    const a = await join('刷新用户'), resumed = await join(undefined, a.sessionToken);
    expect(resumed.generation).toBe(a.generation + 1);
    expect((await call('/api/chat/leave', { token: a.sessionToken, generation: a.generation })).status).toBe(200);
    expect((await state(resumed)).self.name).toBe('刷新用户');
    await call('/api/chat/leave', { token: resumed.sessionToken, generation: resumed.generation });
    expect((await post(resumed)).status).toBe(401);
  });
  it('匿名无会话、伪造令牌和跨站请求均不能发言或改名', async () => {
    expect((await call('/api/chat/messages', { text: 'x', nonce: id() })).status).toBe(401);
    expect((await call('/api/chat/name', { name: 'x' }, 'f'.repeat(64))).status).toBe(401);
    expect((await call('/api/chat/sessions', {}, undefined, 'POST', { Origin: 'https://evil.test' })).status).toBe(403);
  });
  it('消息正文、空消息和单会话发送频率有明确限制', async () => {
    const a = await join(); expect((await post(a, '')).status).toBe(400); expect((await post(a, 'a'.repeat(defaults.chatMessageChars + 1))).status).toBe(400);
    expect((await post(a, 'x\u0000y')).status).toBe(400);
    for (let i = 0; i < defaults.chatMessagesPerMinute; i++) expect((await post(a, `message ${i}`)).status).toBe(201);
    expect((await post(a)).status).toBe(429);
  });
  it('历史条数和保留时间有界，Alarm 在无人访问时释放离线昵称', async () => {
    const a = await join('临时用户'), stub = env.CHAT.get(env.CHAT.idFromName('public'));
    await post(a, 'first');
    await runInDurableObject(stub, async (_instance, ctx) => {
      const original = (await ctx.storage.list<ChatMessage>({ prefix: 'message:' })).values().next().value!;
      const messages = Array.from({ length: defaults.chatMaxMessages + 2 }, (_, index) => ({ ...original, id: id(), sequence: index + 2, text: `seed ${index}` }));
      await ctx.storage.put(Object.fromEntries(messages.map(message => [`message:${message.id}`, message])));
      await ctx.storage.put('meta', { revision: defaults.chatMaxMessages + 4 });
    });
    await abortAllDurableObjects(); const bounded = await state(a); expect(bounded.messages).toHaveLength(defaults.chatMaxMessages); expect(bounded.messages.at(-1)!.text).toBe(`seed ${defaults.chatMaxMessages + 1}`);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 25 * 3600000);
    await runDurableObjectAlarm(env.CHAT.get(env.CHAT.idFromName('public')));
    const b = await join('临时用户'); expect(b.nameUnavailable).toBe(false); expect(b.snapshot.messages).toHaveLength(0); expect(b.snapshot.members).toHaveLength(1);
  });
  it('实时广播文字与昵称变化，使用非 URL 的 WS 令牌和自动心跳', async () => {
    const a = await join('接收者'), b = await join('发送者');
    const response = await worker.fetch(new Request('https://share.test/api/chat/ws', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `chat, token.${a.sessionToken}` } }), env);
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); sockets.push(socket);
    const initial = JSON.parse(await next(socket, value => value.startsWith('{') && JSON.parse(value).type === 'snapshot')); expect(initial.snapshot.self.id).toBe(a.snapshot.self.id);
    const received = next(socket, value => value.startsWith('{') && JSON.parse(value).type === 'message'); await post(b, '实时消息'); expect(JSON.parse(await received).message.text).toBe('实时消息');
    const renamed = next(socket, value => value.startsWith('{') && JSON.parse(value).type === 'members'); await call('/api/chat/name', { name: '新名字' }, b.sessionToken); expect(JSON.parse(await renamed).members.some((member: { name: string }) => member.name === '新名字')).toBe(true);
    const pong = next(socket, value => value === 'chat-pong'); socket.send('chat-ping'); expect(await pong).toBe('chat-pong');
  });
});

describe('聊天室文件权限与既有分享服务', () => {
  it('只能发布自己的分享，文件名称和有效期均取自服务端，不泄露源端令牌', async () => {
    const a = await join(), file = await share();
    expect((await post(a, '', { shareId: file.id, ownerToken: 'f'.repeat(64) })).status).toBe(403);
    const response = await post(a, '请下载', { shareId: file.id, ownerToken: file.ownerToken, files: [{ name: 'spoof.exe' }] }); expect(response.status).toBe(201);
    const snapshot = await state(a); expect(snapshot.messages[0].attachment!.files[0].name).toBe('original.txt'); expect(snapshot.messages[0].attachment!.shareId).toBe(file.id); expect(JSON.stringify(snapshot)).not.toContain(file.ownerToken); expect(JSON.stringify(snapshot)).not.toContain('ownerToken');
  });
  it('密码分享与已撤销分享不能发布，聊天室成员没有源端管理权限', async () => {
    const a = await join(), protectedFile = await share('secret');
    expect((await post(a, '', { shareId: protectedFile.id, ownerToken: protectedFile.ownerToken })).status).toBe(409);
    const file = await share(); await call(`/api/shares/${file.id}`, undefined, file.ownerToken, 'DELETE');
    expect((await post(a, '', { shareId: file.id, ownerToken: file.ownerToken })).status).toBe(410);
    expect((await call(`/api/shares/${protectedFile.id}`, undefined, a.sessionToken, 'DELETE')).status).toBe(403);
  });
  it('新增配置严格校验类型及容量上限', () => {
    expect(limits({ LIMITS: JSON.stringify({ chatMaxMessages: 20, chatMaxMembers: 30 }) }).chatMaxMessages).toBe(20);
    expect(() => limits({ LIMITS: JSON.stringify({ chatMaxMessages: 201 }) })).toThrow('聊天室');
    expect(() => limits({ LIMITS: JSON.stringify({ chatHistoryHours: '24' }) })).toThrow('有效整数');
  });
});
