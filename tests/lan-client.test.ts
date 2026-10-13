import { afterEach, expect, it, vi } from 'vitest';
import { SendTask, ReceiveTask } from '../src/client/transfer';
import { VerifiedSink, type FileWriter } from '../src/client/sink';
import type { ControlSession } from '../src/client/control';
import type { ControlEvent, DownloadRequest, FileInfo } from '../src/shared/types';
import { defaults } from '../src/worker/config';
import { id } from '../src/worker/util';

const host = 'candidate:1 1 udp 2122260223 device.local 50000 typ host';
const mapped = 'candidate:2 1 udp 2122260223 192.0.2.1 50000 typ srflx';
const relay = 'candidate:3 1 udp 2122260223 192.0.2.2 50000 typ relay';
class FakePeer {
  static peers: FakePeer[] = [];
  localDescription?: { type: RTCSdpType; sdp: string; toJSON(): RTCSessionDescriptionInit };
  remoteDescription?: RTCSessionDescriptionInit;
  onicecandidate?: (event: { candidate: { toJSON(): RTCIceCandidateInit } }) => void;
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: { channel: RTCDataChannel }) => void;
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn();
  constructor(public config: RTCConfiguration) { FakePeer.peers.push(this); }
  createDataChannel() { return { close: vi.fn(), readyState: 'connecting', bufferedAmount: 0 }; }
  async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\na=${host}\r\na=${mapped}\r\na=${relay}\r\n` }; }
  async createAnswer() { return { ...await this.createOffer(), type: 'answer' as const }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = { ...description, sdp: description.sdp!, toJSON: () => description };
    for (const candidate of [host, mapped, relay]) this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate }) } });
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
}
afterEach(() => { vi.unstubAllGlobals(); FakePeer.peers = []; });

it('双方内网 RTC 均不用 STUN/TURN，描述先于 ICE，过滤内嵌和 trickle 的公网候选', async () => {
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  const file: FileInfo = { id: id(), name: 'test.bin', size: 4, mime: '', lastModified: 1, uploadStatus: 'none' };
  const task: DownloadRequest = { id: id(), fileId: file.id, receiverId: id(), ownerId: id(), mode: 'lan', forcedMode: 'lan', status: 'connecting', epoch: 1, offset: 0, transferId: id(), createdAt: Date.now() };
  const signal = vi.fn(async () => {});
  const control = { base: '/api/shares/test', sessionToken: 'test', signal, track: vi.fn() } as unknown as ControlSession;
  const external = [{ urls: 'stun:external.test:3478' }];
  const sender = new SendTask(task, new File([new Uint8Array(4)], file.name), control, defaults, external, () => {});
  const writer: FileWriter = { write: vi.fn(async () => {}), truncate: vi.fn(async () => {}), seek: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const receiver = new ReceiveTask(task, new VerifiedSink(file, writer), control, defaults, external, () => {});
  const event = (type: string, data: unknown): ControlEvent => ({ seq: 1, eventId: id(), request: task, type, data, createdAt: Date.now() });
  try {
    await sender.start();
    const sent = signal.mock.calls as unknown as [DownloadRequest, string, { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }][];
    expect(sent.map(x => x[1])).toEqual(['rtc-offer', 'rtc-ice']); expect(sent[0][2].description!.sdp).toContain(host); expect(sent[0][2].description!.sdp).not.toContain('srflx'); expect(sent[0][2].description!.sdp).not.toContain('relay');
    await sender.event(event('rtc-ice', { candidate: { candidate: mapped } }));
    await sender.event(event('rtc-ice', { candidate: { candidate: host } }));
    await sender.event(event('rtc-answer', { description: { type: 'answer', sdp: `v=0\r\na=${host}\r\na=${relay}\r\n` } }));
    expect(FakePeer.peers[0].remoteDescription!.sdp).not.toContain('relay'); expect(FakePeer.peers[0].addIceCandidate).toHaveBeenCalledExactlyOnceWith({ candidate: host });
    signal.mockClear(); await receiver.start();
    await receiver.event(event('rtc-ice', { candidate: { candidate: relay } }));
    await receiver.event(event('rtc-ice', { candidate: { candidate: host } }));
    await receiver.event(event('rtc-offer', { description: { type: 'offer', sdp: `v=0\r\na=${host}\r\na=${mapped}\r\n` } }));
    const received = signal.mock.calls as unknown as [DownloadRequest, string, { description: RTCSessionDescriptionInit }][];
    expect(received.map(x => x[1])).toEqual(['rtc-answer', 'rtc-ice']); expect(received[0][2].description.sdp).not.toContain('srflx'); expect(received[0][2].description.sdp).not.toContain('relay');
    expect(FakePeer.peers[1].remoteDescription!.sdp).not.toContain('srflx'); expect(FakePeer.peers[1].addIceCandidate).toHaveBeenCalledExactlyOnceWith({ candidate: host });
    expect(FakePeer.peers.map(peer => peer.config.iceServers)).toEqual([[], []]);
    expect(FakePeer.peers.map(peer => peer.config.iceTransportPolicy)).toEqual(['all', 'all']);
  } finally { sender.stop(); vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true })); await receiver.cancel(); }
});
