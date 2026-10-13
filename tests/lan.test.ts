import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { isLanCandidate, lanDescription } from '../src/shared/lan';
import type { DownloadRequest, FileInfo, ShareInfo } from '../src/shared/types';
import { id } from '../src/worker/util';

const candidate = (address: string, type = 'host') => `candidate:1 1 udp 2122260223 ${address} 50000 typ ${type}`;
async function call(path: string, body?: unknown, token?: string, cookie?: string) {
  return worker.fetch(new Request(`https://share.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
interface Created { id: string; ownerToken: string; files: FileInfo[]; transferMode: string }
async function setup(transferMode = 'lan', webrtc = true) {
  const response = await call('/api/shares', { transferMode, files: [{ name: 'lan.bin', size: 128, mime: '', lastModified: 1 }] }); expect(response.status).toBe(201);
  const share = await response.json() as Created;
  const owner = await (await call(`/api/shares/${share.id}/sessions`, { role: 'owner', capabilities: { webrtc, ws: false, https: true, readable: [share.files[0].id] } }, share.ownerToken)).json() as { sessionToken: string };
  const receiver = await (await call(`/api/shares/${share.id}/sessions`, { role: 'receiver', capabilities: { webrtc, ws: false, https: true, readable: [] } })).json() as { sessionToken: string };
  return { share, owner, receiver, base: `/api/shares/${share.id}` };
}

describe('LAN 候选限制', () => {
  it.each(['192.168.1.2', '10.0.0.8', '172.16.1.2', '172.31.255.254', '169.254.1.2', '127.0.0.1', 'fc00::1', 'fd12:3456::1', 'fe80::1234', '::1', 'device-123.local'])('接受本地 host 地址 %s', address => {
    expect(isLanCandidate(candidate(address))).toBe(true);
  });
  it.each(['192.0.2.1', '8.8.8.8', '172.15.1.2', '172.32.1.2', '2001:db8::1', '192.168.999.1', 'device.example.com'])('拒绝公网或无效 host 地址 %s', address => {
    expect(isLanCandidate(candidate(address))).toBe(false);
  });
  it.each(['srflx', 'relay', 'prflx'])('即使私网地址也不接受 %s 候选', type => {
    expect(isLanCandidate(candidate('10.0.0.1', type))).toBe(false);
  });
  it('过滤 SDP 内嵌候选，保留协商内容与 mDNS', () => {
    const filtered = lanDescription({ type: 'offer', sdp: ['v=0', 'a=ice-ufrag:abc', `a=${candidate('device.local')}`, `a=${candidate('192.0.2.1', 'srflx')}`, `a=${candidate('2001:db8::1')}`].join('\r\n') });
    expect(filtered.type).toBe('offer'); expect(filtered.sdp).toContain('ice-ufrag:abc'); expect(filtered.sdp).toContain('device.local'); expect(filtered.sdp).not.toContain('192.0.2.1'); expect(filtered.sdp).not.toContain('2001:db8::1');
  });
});

describe('内网传输的房间策略', () => {
  it('匿名用户可创建内网分享，DO 重启后保留模式且不会创建公网预热通道', async () => {
    const { share, owner, receiver, base } = await setup(); expect(share.transferMode).toBe('lan');
    await abortAllDurableObjects();
    const snapshot = await (await call(base)).json() as ShareInfo; expect(snapshot.transferMode).toBe('lan');
    expect(await (await call(`${base}/peers`, {}, owner.sessionToken)).json()).toEqual({ peers: [] });
    const task = await (await call(`${base}/download-requests`, { fileId: share.files[0].id }, receiver.sessionToken)).json() as DownloadRequest;
    expect(task.mode).toBe('lan'); expect(task.forcedMode).toBe('lan'); expect(task.status).toBe('connecting'); expect(task.peerId).toBeUndefined(); expect(task.iceServers).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it('内网失败明确结束，无 TURN 签发、云端上传或任何中继回退', async () => {
    const { share, receiver, base } = await setup();
    const task = await (await call(`${base}/download-requests`, { fileId: share.files[0].id }, receiver.sessionToken)).json() as DownloadRequest;
    const failed = await (await call(`${base}/download-requests/${task.id}/advance`, { epoch: task.epoch, offset: 64, reason: '连接超时' }, receiver.sessionToken)).json() as DownloadRequest;
    expect(failed.status).toBe('failed'); expect(failed.mode).toBe('lan'); expect(failed.offset).toBe(64); expect(failed.error).toContain('不会使用公网中继'); expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(0);
  });
  it('缺少 WebRTC 时直接报告内网模式不可用，不降级到 HTTPS', async () => {
    const { share, receiver, base } = await setup('lan', false);
    const task = await (await call(`${base}/download-requests`, { fileId: share.files[0].id }, receiver.sessionToken)).json() as DownloadRequest;
    expect(task.status).toBe('failed'); expect(task.mode).toBe('lan'); expect(task.error).toContain('WebRTC'); expect(fetch).not.toHaveBeenCalled();
  });
  it('普通自动分享允许匿名接收者选择内网和切回自动，不能获得 R2 权限', async () => {
    const { share, receiver, base } = await setup('auto');
    const task = await (await call(`${base}/download-requests`, { fileId: share.files[0].id, mode: 'lan' }, receiver.sessionToken)).json() as DownloadRequest;
    expect(task.mode).toBe('lan');
    expect((await call(`${base}/download-requests/${task.id}/switch`, { epoch: 1, offset: 64, mode: 'r2' }, receiver.sessionToken)).status).toBe(403);
    const automatic = await (await call(`${base}/download-requests/${task.id}/switch`, { epoch: 1, offset: 64, mode: 'auto' }, receiver.sessionToken)).json() as DownloadRequest;
    expect(automatic.mode).toBe('p2p'); expect(automatic.epoch).toBe(2); expect(automatic.offset).toBe(64); expect(automatic.forcedMode).toBeUndefined();
    const local = await (await call(`${base}/download-requests/${task.id}/switch`, { epoch: 2, offset: 64, mode: 'lan' }, receiver.sessionToken)).json() as DownloadRequest;
    expect(local.mode).toBe('lan'); expect(local.epoch).toBe(3); expect(local.peerId).toBeUndefined();
    expect((await call(`${base}/download-requests/${task.id}/upgrade`, { epoch: 3, offset: 64, peerId: id() }, receiver.sessionToken)).status).toBe(409);
  });
  it('服务端过滤内网 SDP，接受本地 ICE 并拒绝公网及 relay 候选', async () => {
    const { share, owner, receiver, base } = await setup();
    const task = await (await call(`${base}/download-requests`, { fileId: share.files[0].id }, receiver.sessionToken)).json() as DownloadRequest;
    const signal = (kind: string, payload: unknown) => call(`${base}/signals`, { eventId: id(), requestId: task.id, epoch: task.epoch, kind, payload }, owner.sessionToken);
    expect((await signal('rtc-offer', { description: { type: 'offer', sdp: `v=0\r\na=${candidate('10.0.0.1')}\r\na=${candidate('192.0.2.1', 'srflx')}\r\n` } })).status).toBe(200);
    expect((await signal('rtc-ice', { candidate: { candidate: candidate('device.local') } })).status).toBe(200);
    expect((await signal('rtc-ice', { candidate: { candidate: candidate('192.0.2.1', 'relay') } })).status).toBe(400);
    expect((await signal('rtc-ice', { candidate: { candidate: candidate('192.0.2.1') } })).status).toBe(400);
    const events = await (await call(`${base}/events?cursor=0`, undefined, receiver.sessionToken)).json() as { events: { type: string; data: { description?: { sdp: string } } }[] };
    const offer = events.events.find(event => event.type === 'rtc-offer')!;
    expect(offer.data.description!.sdp).toContain('10.0.0.1'); expect(offer.data.description!.sdp).not.toContain('srflx');
  });
  it('内网分享不允许请求其他方式，且管理员也不能把内网分享改成中继', async () => {
    const { share, receiver, base } = await setup();
    expect((await call(`${base}/download-requests`, { fileId: share.files[0].id, mode: 'https' }, receiver.sessionToken)).status).toBe(409);
    const cookie = (await call('/api/admin/login', { password: env.ADMIN_TOKEN })).headers.get('Set-Cookie')!.split(';')[0];
    expect((await call(`/api/admin/shares/${share.id}/files/${share.files[0].id}/mode`, { mode: 'https' }, undefined, cookie)).status).toBe(409);
    expect((await call(`/api/admin/shares/${share.id}/files/${share.files[0].id}/mode`, { mode: 'lan' }, undefined, cookie)).status).toBe(200);
  });
  it.each(['p2p', 'r2', '', 1])('创建分享拒绝不支持的传输策略 %s', async transferMode => {
    expect((await call('/api/shares', { transferMode, files: [{ name: 'a', size: 0, mime: '', lastModified: 0 }] })).status).toBe(400);
  });
});
