import { afterEach, expect, it, vi } from 'vitest';
import { MessengerClient } from '../src/client/messenger';
import type { MessengerConversation, MessengerMessage, MessengerState } from '../src/shared/messenger';

const me = { id: 'self', name: '我', avatar: '猫', online: true, lastSeen: 1000 };
const conversation = (id: string): MessengerConversation => ({ id, kind: 'dm', memberIds: ['self', id], createdAt: 1, updatedAt: 1 });
const state = (ids: string[]): MessengerState => ({ me, users: [], files: [], transfers: [], conversations: ids.map(conversation) });
const message = (conversationId: string, sequence: number): MessengerMessage => ({
  conversationId, id: String(sequence), sequence, senderId: me.id, text: String(sequence), createdAt: sequence,
});
const clients: MessengerClient[] = [];
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
