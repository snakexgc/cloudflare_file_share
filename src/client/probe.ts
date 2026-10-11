import type { IceServer } from '../shared/types';
import { api } from './api';
import { addressFamily } from './peer';

export interface ProbeConfig { admin: boolean; limits: { turnEnabled: boolean; wsEnabled: boolean; r2Enabled: boolean }; turnConfigured: boolean; r2Configured: boolean; stunServers: IceServer[] }
export async function gather(servers: IceServer[], relay = false): Promise<string> {
  if (typeof RTCPeerConnection !== 'function') throw new Error('浏览器未提供 WebRTC');
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: relay ? 'relay' : 'all' });
  const candidates: RTCIceCandidate[] = [];
  try {
    const complete = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 8000);
      pc.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate); else { clearTimeout(timer); resolve(); } };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
    });
    pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer()); await complete;
    const types = new Set(candidates.map(c => c.type)), families = [...new Set(candidates.map(c => addressFamily(c.address ?? c.candidate.split(' ')[4])))].join(' / ') || '未发现地址候选';
    if (relay) { if (!types.has('relay')) throw new Error('未取得 TURN 中继候选'); return `中继分配成功 · ${families} · 跨网传输等待对端`; }
    return `${families} · ${types.has('srflx') ? 'STUN 公网映射候选已取得' : types.has('host') ? '本地候选已取得，公网映射未验证' : '未取得 ICE 候选'} · NAT 类型无法精确分类`;
  } finally { pc.close(); }
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
  document.querySelector('#network-panel')?.remove();
  const container = document.createElement('section'); container.id = 'network-panel'; container.className = 'card network-panel';
  container.innerHTML = `<div class="network-heading"><strong>传输方式检测</strong><span>自动检测 · 真实直连需两端在线</span><button id="retest" class="button secondary" type="button">快速复测</button></div><dl id="probe-results"></dl><p id="punch-status">等待另一端在线，随后自动进行直连打洞</p>`;
  const main = document.querySelector('main')!; main.insertBefore(container, main.querySelector('.workspace, .share-workspace'));
  let busy = false;
  const run = async (manual = false) => {
    if (busy) return; busy = true; const button = container.querySelector<HTMLButtonElement>('#retest')!; button.disabled = true;
    const tests: [string, () => Promise<string>][] = [
      ['P2P / NAT', () => gather(conf.stunServers)],
      ['TURN', async () => { if (!conf.limits.turnEnabled || !conf.turnConfigured) return '服务未启用或凭据未齐全'; const creds = await api<{ iceServers: IceServer[] }>('/api/probe/turn', undefined, {}); return gather(creds.iceServers, true); }],
      ['WS 中继', () => conf.limits.wsEnabled ? wsProbe() : Promise.resolve('服务未启用')],
    ];
    if (conf.admin) tests.push(['R2', async () => { if (!conf.r2Configured || !conf.limits.r2Enabled) return '服务未启用或凭据未齐全'; await api('/api/probe/r2', undefined, {}); return '私有桶可访问 · S3 上传签名和 CORS 在实际传输时验证'; }]);
    const list = container.querySelector('#probe-results')!; list.replaceChildren();
    await Promise.all(tests.map(async ([name, test]) => {
      const row = document.createElement('div'), title = document.createElement('dt'), result = document.createElement('dd'); title.textContent = name; result.textContent = '正在测试…'; row.appendChild(title); row.appendChild(result); list.appendChild(row);
      try { result.textContent = await test(); row.dataset.result = 'ok'; } catch (error) { result.textContent = error instanceof Error ? error.message : String(error); row.dataset.result = 'failed'; }
    }));
    if (manual) retestDirect(); busy = false; button.disabled = false;
  };
  container.querySelector<HTMLButtonElement>('#retest')!.onclick = () => { void run(true); }; void run();
}
export function punchStatus(text: string) { const element = document.querySelector('#punch-status'); if (element) element.textContent = text; }
