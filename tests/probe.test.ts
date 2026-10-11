import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { gather, probeP2P, probeTurn, turnUnavailable, type ProbeConfig } from '../src/client/probe';
import { rtcSupport } from '../src/client/rtc';
import worker from '../src/worker/index';

afterEach(() => vi.unstubAllGlobals());
const config: ProbeConfig = { admin: false, limits: { turnEnabled: true, wsEnabled: true, r2Enabled: false }, turnConfigured: true, turnMissing: [], r2Configured: false, stunServers: [] };
class FakePeer {
  static candidates: { type: string; address: string }[] = [];
  static closed = 0;
  onicecandidate?: (event: { candidate: unknown }) => void;
  onicegatheringstatechange?: () => void;
  iceGatheringState = 'new';
  createDataChannel() { return {}; }
  async createOffer() { return { type: 'offer', sdp: 'test' }; }
  async setLocalDescription() { for (const candidate of FakePeer.candidates) this.onicecandidate?.({ candidate }); this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.(); }
  close() { FakePeer.closed++; }
}
it('核心 API 未暴露时报告当前页面环境，不能据此判定 NAT 或笼统宣称浏览器不支持', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  const support = rtcSupport(); expect(support.available).toBe(false); expect(support.constructorType).toBe('undefined');
  const result = await probeP2P([]); expect(result.state).toBe('unavailable'); expect(result.message).toContain('当前页面'); expect(result.message).toContain('无法测试'); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('API 名称存在而创建连接被阻止时报告实际异常', () => {
  vi.stubGlobal('RTCPeerConnection', class { constructor() { throw new DOMException('blocked by policy', 'SecurityError'); } });
  const support = rtcSupport(); expect(support.available).toBe(false); expect(support.constructorType).toBe('function'); expect(support.message).toContain('SecurityError');
});
it('TURN 开关关闭与缺少机密变量分别显示，已配置不被说成凭据缺失', () => {
  expect(turnUnavailable({ ...config, limits: { ...config.limits, turnEnabled: false } })).toContain('凭据已配置');
  expect(turnUnavailable({ ...config, turnConfigured: false, turnMissing: ['CF_ACCOUNT_ID'] })).toBe('TURN 凭据未齐全：CF_ACCOUNT_ID');
});
it('浏览器 API 不可用时仍验证 TURN 服务，凭据签发成功不等于中继传输已通过', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ iceServers: [{ urls: 'turn:turn.test:3478', username: 'short-user', credential: 'short-secret' }] }));
  const result = await probeTurn(config); expect(result.message).toContain('TURN 服务验证成功'); expect(result.message).toContain('此页面不能测试中继链路'); expect(result.state).toBe('unavailable'); expect(globalThis.fetch).toHaveBeenCalledOnce();
  await probeTurn(config); expect(globalThis.fetch).toHaveBeenCalledOnce();
});
it('TURN 检测限速显示暂缓，不显示凭据缺失或中继连接失败', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61000); vi.stubGlobal('RTCPeerConnection', undefined);
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ error: 'rate_limit', message: '请求过于频繁，请稍后重试' }, { status: 429 }));
  const result = await probeTurn(config); expect(result.state).toBe('pending'); expect(result.message).toContain('检测暂缓'); expect(result.message).not.toContain('凭据未齐全');
});
it('开关关闭时不签发 TURN 探测凭据', async () => {
  const result = await probeTurn({ ...config, limits: { ...config.limits, turnEnabled: false } }); expect(result.state).toBe('unavailable'); expect(result.message).toContain('turnEnabled=false'); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('本地或公网候选仅证明 ICE 探测，不能标记实际 P2P 直连成功', async () => {
  FakePeer.candidates = [{ type: 'srflx', address: '192.0.2.1' }, { type: 'host', address: '2001:db8::1' }]; vi.stubGlobal('RTCPeerConnection', FakePeer);
  const result = await probeP2P([]); expect(result.state).toBe('pending'); expect(result.message).toContain('IPv4 / IPv6'); expect(result.message).toContain('对端直连尚未验证');
});
it('WebRTC 无 ICE 候选不能显示探测成功，TURN 必须实际取得 relay 候选', async () => {
  FakePeer.candidates = []; vi.stubGlobal('RTCPeerConnection', FakePeer); await expect(gather([])).rejects.toThrow('未取得 ICE 候选');
  FakePeer.candidates = [{ type: 'host', address: '192.0.2.1' }]; await expect(gather([], true)).rejects.toThrow('未取得 TURN 中继候选');
  FakePeer.candidates = [{ type: 'relay', address: '192.0.2.2' }]; expect(await gather([], true)).toContain('中继分配成功');
});
it('公开配置检查四个 TURN 变量，包括统计所需 CF_ACCOUNT_ID，响应只列名称', async () => {
  const response = await worker.fetch(new Request('https://share.test/api/config'), { ...env, CF_ACCOUNT_ID: undefined });
  const data = await response.json() as { turnConfigured: boolean; turnMissing: string[] }; expect(data.turnConfigured).toBe(false); expect(data.turnMissing).toEqual(['CF_ACCOUNT_ID']); expect(JSON.stringify(data)).not.toContain('test-turn-token');
});
