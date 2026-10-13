import type { IceServer } from '../shared/types';
import { api, ApiError } from './api';
import { addressFamily } from './peer';
import { rtcSupport } from './rtc';
import { isLanCandidate } from '../shared/lan';

export interface ProbeConfig { admin: boolean; httpOnly?: boolean; lanOnly?: boolean; limits: { turnEnabled: boolean; wsEnabled: boolean; httpsEnabled?: boolean; r2Enabled: boolean }; turnConfigured: boolean; turnMissing: string[]; r2Configured: boolean; stunServers: IceServer[] }
export interface ProbeResult { message: string; state: 'ok' | 'pending' | 'unavailable' }
let turnProbeCache: { iceServers: IceServer[]; expiresAt: number } | undefined;
export function turnUnavailable(conf: Pick<ProbeConfig, 'limits' | 'turnConfigured' | 'turnMissing'>): string | undefined {
  if (!conf.turnConfigured) return `TURN 凭据未齐全：${conf.turnMissing.join('、')}`;
  if (!conf.limits.turnEnabled) return 'TURN 凭据已配置，服务开关关闭（turnEnabled=false）';
}
export async function probeP2P(servers: IceServer[]): Promise<ProbeResult> {
  const support = rtcSupport();
  if (!support.available) return { message: `${support.message}；无法测试 P2P / NAT`, state: 'unavailable' };
  return { message: `${await gather(servers)} · 对端直连尚未验证`, state: 'pending' };
}
export async function probeLan(): Promise<ProbeResult> {
  const support = rtcSupport();
  if (!support.available) return { message: `${support.message}；无法测试内网直传`, state: 'unavailable' };
  return { message: `${await gather([], false, true)} · 同一局域网的对端连接尚未验证`, state: 'pending' };
}
export async function probeTurn(conf: ProbeConfig): Promise<ProbeResult> {
  const unavailable = turnUnavailable(conf);
  if (unavailable) { turnProbeCache = undefined; return { message: unavailable, state: 'unavailable' }; }
  // 服务端凭据签发和客户端中继探测分开报告，避免把浏览器限制当成服务器配置错误。
  const support = rtcSupport();
  let creds = turnProbeCache;
  if (!creds || creds.expiresAt <= Date.now() + (support.available ? 10000 : 0)) {
    const requestedAt = Date.now();
    try { const result = await api<{ iceServers: IceServer[] }>('/api/probe/turn', undefined, {}); creds = turnProbeCache = { ...result, expiresAt: requestedAt + 60000 }; }
    catch (error) { if (error instanceof ApiError && error.status === 429) return { message: `TURN 检测暂缓：${error.message}（不会重复签发凭据）`, state: 'pending' }; throw error; }
  }
  if (!support.available) return { message: `TURN 服务验证成功（已签发短期凭据）；${support.message}，此页面不能测试中继链路`, state: 'unavailable' };
  return { message: await gather(creds.iceServers, true), state: 'pending' };
}
export async function gather(servers: IceServer[], relay = false, lan = false): Promise<string> {
  if (typeof globalThis.RTCPeerConnection !== 'function') throw new Error(rtcSupport().message);
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: relay ? 'relay' : 'all' });
  const candidates: RTCIceCandidate[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const complete = new Promise<void>(resolve => {
      timer = setTimeout(resolve, 8000);
      pc.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate); else { clearTimeout(timer); resolve(); } };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
    });
    pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer()); await complete;
    const usable = lan ? candidates.filter(c => isLanCandidate(c.candidate)) : candidates;
    const types = new Set(usable.map(c => c.type)), families = [...new Set(usable.map(c => addressFamily(c.address ?? c.candidate.split(' ')[4])))].join(' / ') || '未发现地址候选';
    if (lan) { if (!usable.length) throw new Error('未取得可用的内网 host 候选，请检查 WebRTC 或局域网访问设置'); return `本地候选已取得 · ${families} · 无需 STUN / TURN`; }
    if (relay) { if (!types.has('relay')) throw new Error('未取得 TURN 中继候选'); return `中继分配成功 · ${families} · 跨网传输等待对端`; }
    if (!candidates.length) throw new Error('WebRTC API 可创建连接，但未取得 ICE 候选；本次未验证 P2P / NAT');
    return `${families} · ${types.has('srflx') ? 'STUN 公网映射候选已取得' : '本地候选已取得，公网映射未验证'} · NAT 类型无法精确分类`;
  } finally { clearTimeout(timer); pc.close(); }
}
async function wsProbe() {
  await new Promise<void>((resolve, reject) => {
    const url = new URL('/api/probe/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url), timer = setTimeout(() => { socket.close(); reject(new Error('握手或回显超时')); }, 6000);
    let done = false;
    socket.onopen = () => socket.send('probe');
    socket.onmessage = event => { if (event.data === 'probe-ok') { done = true; clearTimeout(timer); socket.close(); resolve(); } };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
    socket.onclose = () => { if (!done) { clearTimeout(timer); reject(new Error('连接在回显前关闭')); } };
  });
  return '握手和小消息回显成功';
}
export function mountProbes(conf: ProbeConfig, retestDirect: () => void) {
  const expanded = document.querySelector('#network-panel')?.hasAttribute('open');
  document.querySelector('#network-panel')?.remove();
  const container = document.createElement('details'); container.id = 'network-panel'; container.className = 'card network-panel';
  if (expanded) container.setAttribute('open', '');
  container.innerHTML = `<summary><strong>传输方式检测</strong><span>点击展开查看</span></summary><div class="network-body"><div class="network-heading"><span>自动检测 · 真实直连需两端在线</span><button id="retest" class="button secondary" type="button">快速复测</button></div><dl id="probe-results"></dl><details class="rtc-diagnostics"><summary>查看 WebRTC 环境诊断</summary><p id="rtc-diagnostics"></p></details><p id="punch-status">${conf.lanOnly ? '内网模式 · 点击下载后连接同一局域网的设备' : '等待另一端在线，随后自动进行直连打洞'}</p></div>`;
  const card = document.querySelector('.upload-card, .share-card'); if (!card) return;
  let column = card.parentElement!;
  if (!column.classList.contains('file-column')) {
    const wrapper = document.createElement('div'); wrapper.className = 'file-column'; column.insertBefore(wrapper, card); wrapper.appendChild(card); column = wrapper;
  }
  column.appendChild(container);
  let busy = false;
  const run = async (manual = false) => {
    if (busy) return; busy = true; const button = container.querySelector<HTMLButtonElement>('#retest')!; button.disabled = true;
    try { const next = await api<ProbeConfig>('/api/config'); conf = { ...next, httpOnly: conf.httpOnly, lanOnly: conf.lanOnly }; } catch { /* 可继续探测本地能力与 WS，接口错误由对应检测项报告。 */ }
    const support = rtcSupport();
    container.querySelector('#rtc-diagnostics')!.textContent = `RTCPeerConnection：${support.constructorType}；安全上下文：${support.secureContext ? '是' : '否'}；RTCSessionDescription：${typeof globalThis.RTCSessionDescription}；RTCIceCandidate：${typeof globalThis.RTCIceCandidate}。${support.message}。本检测不需要摄像头或麦克风权限。`;
    if (!support.available) container.querySelector('#punch-status')!.textContent = conf.lanOnly ? '当前页面无法创建 WebRTC 连接，内网直传不可用。可返回首页创建自动传输分享。' : '当前页面无法创建 WebRTC 连接，后台打洞未运行；在线传输可继续使用 WS / HTTPS';
    const tests: [string, () => Promise<string | ProbeResult>][] = conf.lanOnly ? [['内网直传', probeLan]] : [
      ['内网直传', probeLan],
      ['P2P / NAT', () => probeP2P(conf.stunServers)],
      ['TURN', () => probeTurn(conf)],
      ['WS 中继', () => conf.httpOnly ? Promise.resolve('HTTPS 模式跳过 WS 探测') : conf.limits.wsEnabled && typeof WebSocket === 'function' ? wsProbe() : Promise.resolve('服务或浏览器未启用 WS')],
      ['HTTPS 中继', async () => { if (!conf.limits.httpsEnabled) return '服务未启用'; const result = await api<{ message: string }>('/api/probe/https', undefined, { message: 'https-probe' }); if (result.message !== 'https-probe') throw new Error('HTTP 回显不一致'); return 'HTTP 请求与回显成功 · 完整中继在实际下载时验证'; }],
    ];
    if (conf.admin && !conf.lanOnly) tests.push(['R2', async () => { if (!conf.r2Configured || !conf.limits.r2Enabled) return '服务未启用或凭据未齐全'; await api('/api/probe/r2', undefined, {}); return '私有桶可访问 · S3 上传签名和 CORS 在实际传输时验证'; }]);
    const list = container.querySelector('#probe-results')!; list.replaceChildren();
    await Promise.all(tests.map(async ([name, test]) => {
      const row = document.createElement('div'), title = document.createElement('dt'), result = document.createElement('dd'); title.textContent = name; result.textContent = '正在测试…'; row.appendChild(title); row.appendChild(result); list.appendChild(row);
      try { const outcome = await test(); result.textContent = typeof outcome === 'string' ? outcome : outcome.message; row.dataset.result = typeof outcome === 'string' ? 'ok' : outcome.state; } catch (error) { result.textContent = error instanceof Error ? error.message : String(error); row.dataset.result = 'failed'; }
    }));
    if (manual) retestDirect(); busy = false; button.disabled = false;
  };
  container.querySelector<HTMLButtonElement>('#retest')!.onclick = () => { void run(true); }; void run();
}
export function punchStatus(text: string) { const element = document.querySelector('#punch-status'); if (element) element.textContent = text; }
