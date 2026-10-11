import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { defaults, limits, type Env } from '../src/worker/config';
import example from '../examples/limits.json';
import { id } from '../src/worker/util';
import worker from '../src/worker/index';

const stub = () => env.BUDGET.get(env.BUDGET.idFromName('global'));
async function call(path: string, data: object = {}) { return stub().fetch(new Request(`https://budget${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })); }
async function seed(values: Record<string, unknown>) { await call('/snapshot'); await runInDurableObject(stub(), instance => Object.assign((instance as unknown as { ledger: Record<string, unknown> }).ledger, values)); }
async function override(values: object) { return runInDurableObject(stub(), instance => { const bindings = (instance as unknown as { env: Env }).env, previous = bindings.LIMITS; bindings.LIMITS = JSON.stringify(values); return previous; }); }
async function snapshot() { return (await call('/snapshot')).json<Record<string, number>>(); }
const reserveWS = (bytes: number, messages: number, key = id()) => call('/reserve', { id: key, kind: 'ws', bytes, messages, expiresAt: Date.now() + 60000 });
it('配置按官方免费请求额度的 95%，示例与默认值一致，WS 不再有月流量或月消息阈值', () => {
  const configured = limits({ LIMITS: JSON.stringify(example) });
  for (const [key, value] of Object.entries({ apiRequestsPerDay: 95000, doRequestsPerDay: 95000, d1RowsReadPerDay: 4750000, d1RowsWrittenPerDay: 95000, r2ClassAMonthly: 950000, r2ClassBMonthly: 9500000, turnMonthlyBytes: 950000000000, turnExternalReserveBytes: 0 })) {
    expect(defaults[key as keyof typeof defaults]).toBe(value); expect(configured[key as keyof typeof defaults]).toBe(value);
  }
  for (const key of ['wsMonthlyBytes', 'wsMonthlyMessages', 'turnSafetyBytes']) { expect(defaults).not.toHaveProperty(key); expect(() => limits({ LIMITS: JSON.stringify({ [key]: 1 }) })).toThrow('未知配置项'); }
});
it('累计 WS 字节超过原 10 GiB 仍可准入；累计月消息超过原 50 万也不拒绝', async () => {
  await seed({ wsCommitted: 100 * 1024 ** 4, wsMessages: 500001 });
  const key = id(); expect((await reserveWS(100 * 1024 ** 4, 20, key)).status).toBe(200);
  expect((await call('/settle', { id: key, bytes: 100 * 1024 ** 4, messages: 20 })).status).toBe(200);
  const data = await snapshot(); expect(data.wsBytes).toBe(200 * 1024 ** 4); expect(data.wsMessages).toBe(500021);
  expect((await reserveWS(100 * 1024 ** 4, 20)).status).toBe(200);
});
it('WS 入站消息按 20:1 计入 DO 预算，WS 控制消息不消耗 Worker HTTP 请求计数', async () => {
  for (let i = 0; i < 20; i++) expect((await call('/charge', { source: 'ws', websocket: true })).status).toBe(200);
  const data = await snapshot(); expect(data.apiRequests).toBe(0); expect(data.doWsMessages).toBe(20); expect(data.doRequests - data.doHttpRequests).toBe(1);
});
it('无 WS 流量上限仍受共享 DO 请求额度限制，预留消息与已用请求合并检查', async () => {
  await seed({ doRequests: 10 }); const previous = await override({ doRequestsPerDay: 14 });
  try {
    // /reserve 本身消耗一个 DO 请求，40 条 WS 消息按两个请求预留。
    expect((await reserveWS(10 ** 12, 40)).status).toBe(200);
    expect((await reserveWS(10 ** 12, 40)).status).toBe(429);
  } finally { await runInDurableObject(stub(), instance => { (instance as unknown as { env: Env }).env.LIMITS = previous; }); }
});
it('Worker HTTP 在配置阈值处准入，下一次拒绝；拒绝的调用也保留计数', async () => {
  await seed({ requests: 94999 });
  expect((await call('/charge', { source: 'http' })).status).toBe(200);
  expect((await call('/charge', { source: 'http' })).status).toBe(429);
  expect((await snapshot()).apiRequests).toBe(95001);
});
it.each([['A', 'classA', 950000], ['B', 'classB', 9500000]] as const)('R2 %s 在 95%% 阈值处准入，清理操作仍可完成', async (kind, field, maximum) => {
  await seed({ [field]: maximum - 1 });
  expect((await call('/r2-operation', { kind })).status).toBe(200);
  expect((await call('/r2-operation', { kind })).status).toBe(429);
  expect((await call('/r2-operation', { kind, cleanup: true })).status).toBe(200);
});
it('D1 读/写达到各自阈值后拒绝新业务，已授权维护仍可执行', async () => {
  for (const [key, limit] of [['d1Read', 4750000], ['d1Written', 95000]] as const) {
    await seed({ d1Read: 0, d1Written: 0, [key]: limit - 1 }); expect((await call('/charge', { source: key })).status).toBe(200);
    await seed({ [key]: limit }); expect((await call('/charge', { source: key })).status).toBe(429);
    expect((await call('/charge', { source: key, cleanup: true })).status).toBe(200);
  }
});
it('TURN 恰好 950 GB 允许，超出一个字节拒绝，无重复安全量扣减', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: 0 } }] }] } } }));
  const key = id(); expect((await call('/reserve', { id: key, kind: 'turn', bytes: 950000000000, expiresAt: Date.now() + 60000 })).status).toBe(200);
  expect((await call('/reserve', { id: id(), kind: 'turn', bytes: 1, expiresAt: Date.now() + 60000 })).status).toBe(429);
  await call('/release', { id: key });
  expect((await call('/reserve', { id: id(), kind: 'turn', bytes: 950000000001, expiresAt: Date.now() + 60000 })).status).toBe(429);
});
it('UTC 日重置只清空每日请求；WS 月流量统计跨日保留', async () => {
  await seed({ wsCommitted: 10 ** 12, requests: 95000, doRequests: 95000, doWsMessages: 20 });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 86400000);
  const data = await snapshot(); expect(data.apiRequests).toBe(0); expect(data.doWsMessages).toBe(0); expect(data.doRequests).toBe(1); expect(data.wsBytes).toBe(10 ** 12);
});
it('后台 WS 用量读实时已转发字节，计入已结算值，不把全部预留当成实际流量', async () => {
  const response = await worker.fetch(new Request('https://share.test/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_TOKEN }) }), env);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0], roomId = id(), transferId = id();
  const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  await room.fetch(new Request('https://room/internal/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: roomId, ownerTokenHash: '', sourceHash: '', createdAt: Date.now(), expiresAt: Date.now() + 3600000, status: 'active', cleanupStatus: 'pending', files: [], requests: [], uploads: [], pendingRevocations: [] }) }));
  const taskId = id();
  await runInDurableObject(room, instance => {
    const state = instance as unknown as { room: { requests: object[] }; relays: Map<string, object> };
    state.room.requests.push({ id: taskId, reservationId: transferId }); state.relays.set(id(), { requestId: taskId, bytes: 7, sent: 7, acked: 7 });
  });
  await seed({ wsCommitted: 100 }); await call('/reserve', { id: transferId, kind: 'ws', roomId, bytes: 1000, messages: 20, expiresAt: Date.now() + 60000 });
  const overview = await worker.fetch(new Request('https://share.test/api/admin/overview', { headers: { Cookie: cookie } }), env);
  const data = await overview.json<{ ledger: { wsBytes: number; wsLiveBytes: number; wsReserved: number } }>(); expect(data.ledger.wsLiveBytes).toBe(7); expect(data.ledger.wsBytes).toBe(107); expect(data.ledger.wsReserved).toBe(1000);
  await runInDurableObject(room, instance => (instance as unknown as { relays: Map<string, object> }).relays.clear());
});
