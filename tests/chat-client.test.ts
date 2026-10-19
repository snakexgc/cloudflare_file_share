import { afterEach, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/client/chat';
import type { ChatSnapshot } from '../src/shared/chat';
import { id } from '../src/worker/util';

afterEach(() => vi.unstubAllGlobals());
const snapshot = (revision = 1): ChatSnapshot => ({ revision, self: { id: 'self', name: '测试用户', joinedAt: 1 }, members: [{ id: 'self', name: '测试用户', joinedAt: 1 }], messages: [], historyHours: 24 });

it('HTTP 同步的旧响应不能覆盖已经收到的新版本消息', async () => {
  const client = new ChatClient(); client.sessionToken = 'a'.repeat(64); client.snapshot = snapshot(5);
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(accept => { resolve = accept; }));
  const syncing = client.sync();
  client.snapshot = { ...snapshot(6), messages: [{ id: id(), sequence: 6, nonce: id(), authorId: 'self', authorName: '测试用户', createdAt: 1, text: '刚刚收到的新消息' }] };
  resolve(Response.json({ snapshot: snapshot(5) })); await syncing;
  expect(client.snapshot.revision).toBe(6); expect(client.snapshot.messages[0].text).toBe('刚刚收到的新消息'); client.stop(false);
});

it('网络重试沿用同一消息标识，成功后同步服务端历史', async () => {
  const client = new ChatClient(); client.sessionToken = 'a'.repeat(64); client.snapshot = snapshot();
  const bodies: { nonce: string; text: string }[] = [];
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (String(url) === '/api/chat/messages') {
      const body = JSON.parse(String(options!.body)); bodies.push(body);
      if (bodies.length === 1) throw new TypeError('network interrupted');
      return Response.json({ message: { id: 'message', nonce: body.nonce, text: body.text } });
    }
    return Response.json({ snapshot: { ...snapshot(2), messages: [{ id: 'message', sequence: 2, nonce: bodies[0].nonce, authorId: 'self', authorName: '测试用户', createdAt: 1, text: 'hello' }] } });
  });
  const result = await client.post('hello'); expect(result!.id).toBe('message'); expect(bodies).toHaveLength(2); expect(bodies[0].nonce).toBe(bodies[1].nonce); expect(client.snapshot.messages).toHaveLength(1); client.stop(false);
});

it('没有 WebSocket 或浏览器存储被禁用时仍自动进入并使用 HTTP 同步', async () => {
  vi.stubGlobal('WebSocket', undefined);
  vi.stubGlobal('window', { get sessionStorage() { throw new DOMException('blocked', 'SecurityError'); }, get localStorage() { throw new DOMException('blocked', 'SecurityError'); } });
  vi.mocked(fetch).mockResolvedValue(Response.json({ sessionToken: 'b'.repeat(64), generation: 1, nameUnavailable: false, snapshot: snapshot() }));
  const client = new ChatClient(), status = vi.fn(); client.onStatus = status;
  try { await client.start(); expect(client.snapshot!.self.name).toBe('测试用户'); expect(status).toHaveBeenCalledWith('http'); }
  finally { client.stop(false); }
});

it('显式离开携带当前会话版本，避免旧页面的退出覆盖恢复后的会话', async () => {
  vi.stubGlobal('WebSocket', undefined); vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: () => {} }, localStorage: { getItem: () => null, setItem: () => {} } });
  const requests: { url: string; body: unknown }[] = [];
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options!.body)) });
    return Response.json(String(url).endsWith('/sessions') ? { sessionToken: 'c'.repeat(64), generation: 7, nameUnavailable: false, snapshot: snapshot() } : { ok: true });
  });
  const client = new ChatClient(); await client.start(); await client.leave(); expect(requests.at(-1)).toEqual({ url: '/api/chat/leave', body: { generation: 7 } });
});
