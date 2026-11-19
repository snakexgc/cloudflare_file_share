import { afterEach, expect, it, vi } from 'vitest';
import { MessengerClient } from '../src/client/messenger';
import type { MessengerConversation, MessengerMessage, MessengerState } from '../src/shared/messenger';
import { conversationName } from '../web/workspace-view';

const me = { id: 'self', name: '我', avatar: '猫', online: true, lastSeen: 1000 };
const conversation = (id: string): MessengerConversation => ({ id, kind: 'dm', memberIds: ['self', id], createdAt: 1, updatedAt: 1 });
const state = (ids: string[]): MessengerState => ({ me, users: [], files: [], transfers: [], conversations: ids.map(conversation) });
const message = (conversationId: string, sequence: number): MessengerMessage => ({
  conversationId, id: String(sequence), sequence, senderId: me.id, text: String(sequence), createdAt: sequence,
});
const clients: MessengerClient[] = [];
const plazaId = '00000000000000000000000000000000';
const plaza = { ...conversation(plazaId), kind: 'group' as const, memberIds: ['self'] };
const client = () => { const value = new MessengerClient(); clients.push(value); return value; };
afterEach(() => { for (const value of clients.splice(0)) value.stop(); vi.unstubAllGlobals(); });

function mockApi(custom: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input).replace('/api/messenger', '');
    const result = custom(path, init as RequestInit);
    if (result) return result;
    if (path === '/identity') return Response.json({ user: me });
    if (path === '/state') return Response.json(state(['a', 'b']));
    return Response.json({ hasMore: false, messages: [] });
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const unavailable = () => Response.json({ error: 'unavailable', message: '暂时无法连接' }, { status: 503 });

it('打开页面进入广场并读取消息，切换私聊或返回列表后轮询保留选择', async () => {
  const value = client();
  let rooms = [conversation('a'), plaza];
  mockApi(path => {
    if (path.startsWith('/state')) return Response.json({ ...state([]), conversations: rooms });
    if (path === '/conversations/' + plazaId + '/messages') return Response.json({ messages: [message(plazaId, 1)], hasMore: false });
  });
  await value.start();
  expect(value.state.activeId).toBe(plazaId);
  expect(value.state.messages).toEqual([message(plazaId, 1)]);
  expect(conversationName(plaza, new Map(), me.id)).toBe('广场');
  await value.openConversation('a'); await value.refresh();
  expect(value.state.activeId).toBe('a');
  rooms = [plaza]; await value.refresh();
  expect(value.state.activeId).toBe(plazaId);
  await value.openConversation(null); await value.refresh();
  expect(value.state.activeId).toBeNull();
});

it('服务端报告会话历史已清空时立即清除旧分页，即使随后历史请求失败', async () => {
  const value = client();
  let expired = false;
  mockApi(path => {
    if (path.startsWith('/state')) return Response.json({ ...state([]), conversations: [
      { ...conversation('a'), revision: expired ? 2 : 1, lastMessage: expired ? undefined : message('a', 1) },
    ] });
    if (path === '/conversations/a/messages') return expired ? unavailable()
      : Response.json({ messages: [message('a', 1)], hasMore: false });
  });
  await value.start(); await value.openConversation('a');
  expect(value.state.messages).toHaveLength(1);
  expired = true; await value.refresh().catch(() => {});
  expect(value.state.messages).toEqual([]);
});

it('另一个标签页续建身份后，首个状态响应清除旧身份的云盘和广场历史', async () => {
  const value = client();
  let renewed = false;
  const file = { id: 'old-file', ownerId: me.id, name: '旧文件', size: 1, mime: 'text/plain', lastModified: 1, transferMode: 'auto', createdAt: 1 };
  const newUser = { ...me, id: 'renewed' };
  mockApi(path => {
    if (path.startsWith('/state')) return Response.json({
      ...state([]), me: renewed ? newUser : me, files: renewed ? [] : [file],
      conversations: [{ ...plaza, memberIds: [renewed ? newUser.id : me.id], lastMessage: renewed ? undefined : message(plazaId, 1) }],
    });
    if (path.endsWith('/messages')) return renewed ? unavailable() : Response.json({ messages: [message(plazaId, 1)], hasMore: false });
  });
  await value.start(); await value.openConversation(plazaId);
  expect(value.state.drive).toHaveLength(1);
  expect(value.state.messages).toHaveLength(1);
  const leaks: string[] = [];
  value.onChange = s => { if (s.self?.id === newUser.id && (s.drive.length || s.messages.length)) leaks.push(s.self.id); };
  renewed = true; await value.refresh().catch(() => {});
  expect(value.state.self?.id).toBe(newUser.id);
  expect(leaks).toEqual([]);
});

it('失联超过消息保留期后，重新查询前先隐藏消息内容和列表预览', async () => {
  const value = client(), clock = vi.spyOn(Date, 'now');
  const before = Date.now(), pending = deferred<Response>();
  clock.mockReturnValue(before);
  let offline = false;
  mockApi(path => {
    if (path.startsWith('/state')) return offline ? pending.promise : Response.json({
      ...state([]), conversations: [{ ...conversation('a'), lastMessage: message('a', 1) }],
    });
    if (path.endsWith('/messages')) return Response.json({ messages: [message('a', 1)], hasMore: false });
  });
  await value.start(); await value.openConversation('a');
  // The final poll may reuse a heartbeat written almost 15 seconds earlier.
  offline = true; clock.mockReturnValue(before + 10 * 60_000 + 45_000);
  const refresh = value.refresh();
  try {
    expect(value.state.messages).toEqual([]);
    expect(value.state.conversations[0].lastMessage).toBeUndefined();
  } finally { pending.resolve(unavailable()); await refresh.catch(() => {}); }
});

it('按最近一次条件轮询回传的实际在线租期判断离线历史截止时间', async () => {
  const value = client(), before = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
  let disconnected = false;
  mockApi(path => {
    if (path.startsWith('/state') && disconnected) return Promise.reject(new TypeError('offline'));
    if (path === '/state') return Response.json({ ...state(['a']), revision: 'v', refreshAt: before + 60_000, presenceLeaseMs: 60_000 });
    if (path === '/state?since=v') return Response.json({ unchanged: true, revision: 'v', refreshAt: before + 60_000, presenceLeaseMs: 60_000 });
    if (path.endsWith('/messages')) return Response.json({ messages: [message('a', 1)], hasMore: false });
  });
  await value.start(); await value.openConversation('a');
  const renewed = before + 20_000;
  clock.mockReturnValue(renewed); await value.refresh(false); disconnected = true;
  clock.mockReturnValue(renewed + 11 * 60_000 - 1); await value.refresh(false).catch(() => {});
  expect(value.state.messages).toHaveLength(1);
  clock.mockReturnValue(renewed + 11 * 60_000); await value.refresh(false).catch(() => {});
  expect(value.state.messages).toEqual([]);
});

it('长时间断网时依次隐藏普通群和云盘，重新核实时保留仍有效的会话选择', async () => {
  const value = client(), before = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
  const group = { ...conversation('g'), kind: 'group' as const };
  const file = { id: 'f', name: '文件', ownerId: me.id, size: 1, mime: 'text/plain', lastModified: 1, createdAt: 1, transferMode: 'auto' };
  let reachable = true;
  mockApi(path => {
    if (path.startsWith('/state')) return reachable
      ? Response.json({ ...state([]), conversations: [plaza, group], files: [file] })
      : Promise.reject(new TypeError('offline'));
  });
  await value.start(); await value.openConversation(group.id);
  reachable = false; clock.mockReturnValue(before + 61 * 60_000);
  await value.refresh().catch(() => {});
  expect(value.state.conversations.map(c => c.id)).toEqual([plazaId]);
  expect(value.state.drive).toHaveLength(1);
  clock.mockReturnValue(before + 721 * 60_000);
  await value.refresh().catch(() => {});
  expect(value.state.self).toBeNull();
  expect(value.state.drive).toEqual([]);
  reachable = true; await value.refresh();
  expect(value.state.activeId).toBe(group.id);
  expect(value.state.drive).toHaveLength(1);
});

it('挂起的分页和发信响应在断网历史已隐藏后返回也无法恢复旧消息', async () => {
  const value = client(), before = Date.now(), older = deferred<Response>(), send = deferred<Response>();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
  let connected = true;
  mockApi((path, init) => {
    if (path.startsWith('/state')) return connected ? Response.json(state(['a'])) : Promise.reject(new TypeError('offline'));
    if (path.endsWith('?before=2')) return older.promise;
    if (path.endsWith('/messages') && init?.method === 'POST') return send.promise;
    if (path.endsWith('/messages')) return Response.json({ messages: [message('a', 2)], hasMore: true });
  });
  await value.start(); await value.openConversation('a');
  const reads = value.loadOlder(), writes = value.sendMessage('a', '3');
  connected = false; clock.mockReturnValue(before + 11 * 60_000); await value.refresh().catch(() => {});
  older.resolve(Response.json({ messages: [message('a', 1)], hasMore: false }));
  send.resolve(Response.json({ message: message('a', 3) })); await Promise.all([reads, writes]);
  expect(value.state.messages).toEqual([]);
});

it('同一浏览器重用凭据和指纹，另一无存储浏览器仍可独立登录', async () => {
  const memory = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => memory.get(key), setItem: (key: string, value: string) => memory.set(key, value) } });
  const identities: { credential: string; fingerprint: string }[] = [];
  mockApi((path, init) => { if (path === '/identity') identities.push(JSON.parse(String(init!.body))); return undefined; });
  await client().start(); await client().start(); memory.clear(); await client().start();
  expect(identities[0]).toEqual(identities[1]);
  expect(identities[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(identities[0].credential).toMatch(/^[0-9a-f]{64}$/);
  expect(identities[2].credential).not.toBe(identities[0].credential);
});

it('旧会话的迟到历史不会显示在新会话中', async () => {
  const late = deferred<Response>(), value = client();
  mockApi(path => {
    if (path === '/conversations/a/messages') return late.promise;
    if (path === '/conversations/b/messages') return Response.json({ hasMore: false, messages: [message('b', 2)] });
  });
  await value.start(); expect(value.state.activeId).toBeNull();
  const first = value.openConversation('a'); await value.openConversation('b');
  late.resolve(Response.json({ hasMore: false, messages: [message('a', 1)] })); await first;
  expect(value.state.messages).toEqual([message('b', 2)]);
});

it('恢复消息分页时保留已经打开的早期记录，修正删除过的附件', async () => {
  const value = client();
  let latest = [message('a', 2), message('a', 3)];
  mockApi(path => {
    if (path.endsWith('?before=2')) return Response.json({ hasMore: false, messages: [message('a', 1)] });
    if (path === '/conversations/a/messages') return Response.json({ hasMore: true, messages: latest });
  });
  await value.start(); await value.openConversation('a'); await value.loadOlder();
  latest = [message('a', 2), { ...message('a', 3), text: '已更新' }, message('a', 4)];
  await value.refresh(); expect(value.state.messages).toEqual([message('a', 1), ...latest]); expect(value.state.hasOlder).toBe(false);
  latest = [message('a', 9), message('a', 10)]; await value.refresh();
  expect(value.state.messages).toEqual(latest); expect(value.state.hasOlder).toBe(true);
});

it('网络重试使用同一消息标识，迟到的状态不会覆盖发送成功的记录', async () => {
  const value = client(), pending = deferred<Response>();
  let reads = 0;
  const nonces: string[] = [];
  mockApi((path, init) => {
    if (path === '/state' && ++reads === 2) return pending.promise;
    if (path === '/conversations/a/messages' && init?.method === 'POST') {
      nonces.push(JSON.parse(String(init.body)).nonce);
      if (nonces.length === 1) return Promise.reject(new TypeError('network'));
      return Response.json({ message: message('a', 5) });
    }
  });
  await value.start(); await value.openConversation('a');
  const refresh = value.refresh(); await value.sendMessage('a', '5');
  pending.resolve(Response.json(state([]))); await refresh;
  expect(nonces).toHaveLength(2); expect(nonces[0]).toBe(nonces[1]);
  expect(value.state.activeId).toBe('a'); expect(value.state.messages).toEqual([message('a', 5)]);
});

it('安静轮询只读取状态版本，其他会话的更新不重复下载当前历史', async () => {
  const value = client();
  const refreshAt = Date.now() + 60_000;
  let tag = 'v1', roomRevision = 1, historyReads = 0;
  const paths: string[] = [];
  mockApi(path => {
    if (path.startsWith('/state')) {
      paths.push(path);
      if (path === '/state?since=' + tag) return Response.json({ unchanged: true, revision: tag, refreshAt });
      return Response.json({ ...state([]), revision: tag, refreshAt, conversations: [{ ...conversation('a'), revision: roomRevision }] });
    }
    if (path.endsWith('/messages')) {
      historyReads++;
      return Response.json({ messages: [message('a', roomRevision)], hasMore: false });
    }
  });
  await value.start(); await value.openConversation('a');
  await value.refresh(false); expect(historyReads).toBe(1);
  tag = 'v2'; await value.refresh(false); expect(historyReads).toBe(1);
  tag = 'v3'; roomRevision++; await value.refresh(false); expect(historyReads).toBe(2);
  expect(paths).toEqual(['/state', '/state?since=v1', '/state?since=v1', '/state?since=v2']);
  expect(value.state.messages).toEqual([message('a', 2)]);
});
