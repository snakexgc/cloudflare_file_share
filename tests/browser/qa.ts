import { api } from '../../src/client/api';
import { ControlSession } from '../../src/client/control';
import { VerifiedSink, type FileWriter } from '../../src/client/sink';
import { ReceiveTask, SendTask } from '../../src/client/transfer';
import type { ControlEvent, DownloadRequest, FileInfo, IceServer } from '../../src/shared/types';
import type { Limits } from '../../src/worker/config';
import { FRAME_HEADER_BYTES, WS_DEFAULT_PAYLOAD_BYTES, WS_MAX_MESSAGE_BYTES } from '../../src/shared/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface Handle { createWritable(): Promise<FileWriter>; getFile(): Promise<File> }
interface Directory { getFileHandle(name: string, options: { create: boolean }): Promise<Handle>; removeEntry(name: string): Promise<void> }
const output = document.querySelector<HTMLPreElement>('#result')!;
const buttons = document.querySelectorAll<HTMLButtonElement>('button');
function log(value: string) { output.textContent += `\n${value}`; }
async function run(mode: string) {
  buttons.forEach(button => { button.disabled = true; }); output.textContent = `测试：${mode}`;
  let owner: ControlSession | undefined, receiver: ControlSession | undefined, senderTask: SendTask | undefined, receiveTask: ReceiveTask | undefined;
  let shareId = '', ownerToken = '', savedName = '', directory: Directory | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined, sink: VerifiedSink | undefined;
  try {
    log(`浏览器 RTCPeerConnection 类型：${typeof RTCPeerConnection}`);
    if (mode.startsWith('rtc') && typeof RTCPeerConnection !== 'function') { log('SKIP：当前浏览器禁用了 WebRTC 构造器；不会把自动回退成功当成直连验收。'); return; }
    const config = await api<{ limits: Limits; stunServers: IceServer[] }>('/api/config');
    if (mode === 'ws-large' && config.limits.chunkBytes !== WS_DEFAULT_PAYLOAD_BYTES) throw new Error('大消息验收需要默认 WS 分片配置');
    const source = new Uint8Array(mode === 'zero' ? 0 : mode === 'ws-large' ? 2 * WS_DEFAULT_PAYLOAD_BYTES + 17 : 2 * 1024 ** 2 + 17);
    for (let i = 0; i < source.length; i++) source[i] = (i * 79 + 53) % 256;
    const file = new File([source], mode === 'zero' ? '空文件.bin' : '浏览器验收.bin', { type: 'application/octet-stream', lastModified: 123 });
    const created = await api<{ id: string; ownerToken: string; files: FileInfo[] }>('/api/shares', undefined, { expiresInHours: 1, files: [{ name: file.name, size: file.size, mime: file.type, lastModified: file.lastModified }] });
    shareId = created.id; ownerToken = created.ownerToken;
    log(`分享已创建：${created.id}；源文件 ${source.length} 字节`);
    const useRtc = mode.startsWith('rtc'), useWs = mode !== 'rtc-http';
    owner = new ControlSession(shareId, 'owner', { webrtc: useRtc, ws: useWs, readable: [created.files[0].id] }, config.limits, ownerToken);
    receiver = new ControlSession(shareId, 'receiver', { webrtc: useRtc, ws: useWs, readable: [] }, config.limits);
    const frameSizes: number[] = [], binary = owner.binary.bind(owner);
    owner.binary = buffer => { frameSizes.push(buffer.byteLength); binary(buffer); };
    owner.busy = receiver.busy = () => true;
    owner.onState = state => log(`发送端控制通道：${state}`); receiver.onState = state => log(`接收端控制通道：${state}`);
    const queue: ControlEvent[] = []; let ownerQueue = Promise.resolve(), receiverQueue = Promise.resolve();
    const credits = new Map<string, Record<string, unknown>>();
    let complete: () => void = () => {}, failed: (error: Error) => void = () => {}, serverComplete: () => void = () => {};
    const finished = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject; });
    const settled = new Promise<void>(resolve => { serverComplete = resolve; });
    const timedOut = new Promise<void>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('浏览器传输 90 秒内未完成')), 90000); }); void timedOut.catch(() => {});
    void finished.catch(() => {});
    owner.onRaw = data => { if (data.type === 'relay-credit') { if (senderTask) senderTask.credit(data); else credits.set(String(data.transferId), data); } else if (data.type === 'error') log(`发送端错误：${JSON.stringify(data)}`); };
    owner.onEvent = event => {
      if (event.request && ['attempt', 'transport-error', 'relay-error'].includes(event.type)) log(`发送端事件 ${event.type}：${event.request.mode}；${event.request.error ?? ''}`);
      ownerQueue = ownerQueue.then(async () => {
        if (!event.request) return;
        if (event.type === 'attempt' && event.request.mode !== 'r2') {
          senderTask?.stop(); senderTask = new SendTask(event.request, file, owner!, config.limits, config.stunServers, (_id, label) => { if (label.includes('失败')) log(label); });
          const credit = credits.get(event.request.transferId); if (credit) senderTask.credit(credit);
          void senderTask.start();
        } else if (event.type === 'rtc-answer' || event.type === 'rtc-ice') await senderTask?.event(event);
        else if (event.type === 'stop-attempt' || event.type === 'canceled' || event.type === 'completed') senderTask?.stop();
      }).catch(error => failed(error));
    };
    receiver.onEvent = event => {
      if (event.type === 'completed') serverComplete();
      if (event.request && ['attempt', 'transport-error', 'relay-error'].includes(event.type)) log(`接收端事件 ${event.type}：${event.request.mode}；${event.request.error ?? ''}`);
      if (!receiveTask) { queue.push(event); return; }
      receiverQueue = receiverQueue.then(() => receiveTask!.event(event)).catch(error => failed(error));
    };
    receiver.onBinary = buffer => receiveTask?.frame(buffer);
    receiver.onRaw = data => { if (data.type === 'error') log(`接收端错误：${JSON.stringify(data)}`); };
    await owner.start(); await receiver.start();
    directory = await (navigator.storage as unknown as { getDirectory(): Promise<Directory> }).getDirectory();
    savedName = `qa-${created.id}.bin`; const handle = await directory.getFileHandle(savedName, { create: true });
    sink = new VerifiedSink(created.files[0], await handle.createWritable());
    const task = await api<DownloadRequest>(`${receiver.base}/download-requests`, receiver.sessionToken, { fileId: created.files[0].id });
    log(`实际传输模式：${task.mode}`);
    receiveTask = new ReceiveTask(task, sink, receiver, config.limits, config.stunServers, (_fileId, label, bytes, actualMode, done) => {
      if (done) { log(`${actualMode}：${label}（${bytes} 字节）`); complete(); }
      else if (label.startsWith('未完成')) failed(new Error(label));
      else if (label.includes('切换') || label.includes('连接')) log(`${actualMode}：${label}`);
    });
    await receiveTask.start(); for (const event of queue) await receiveTask.event(event);
    await Promise.race([Promise.all([finished, settled]), timedOut]); clearTimeout(deadline);
    if (mode.startsWith('rtc') && receiveTask.task.mode !== 'p2p') throw new Error(`原定 WebRTC 传输回退到了 ${receiveTask.task.mode}；不能视为直连通过`);
    const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer()), expectedHash = bytesToHex(sha256(source)), actualHash = bytesToHex(sha256(actual));
    if (actual.length !== source.length || actualHash !== expectedHash) throw new Error('重新读取保存文件后哈希不匹配');
    if (mode === 'ws-large') {
      if (frameSizes.length !== 3 || frameSizes[0] !== WS_MAX_MESSAGE_BYTES - 1024 || frameSizes[1] !== WS_MAX_MESSAGE_BYTES - 1024 || frameSizes[2] !== FRAME_HEADER_BYTES + 17) throw new Error('WS 分片没有使用两条大消息和一条尾消息');
      log(`完整 WS 消息字节数：${frameSizes.join(', ')}`);
    }
    log(`保存文件字节数：${actual.length}`); log(`源 SHA-256：${expectedHash}`); log(`保存 SHA-256：${actualHash}`); log('PASS：真实传输、写入结束、原始内容与 SHA-256 全部一致');
  } catch (error) { log(`FAIL：${error instanceof Error ? error.message : String(error)}`); }
  finally {
    clearTimeout(deadline); await sink?.abort().catch(() => {});
    senderTask?.stop(); owner?.stop(); receiver?.stop();
    if (shareId && ownerToken) await api(`/api/shares/${shareId}`, ownerToken, undefined, 'DELETE').catch(() => {});
    if (savedName && directory) await directory.removeEntry(savedName).catch(() => {});
    buttons.forEach(button => { button.disabled = false; });
  }
}
buttons.forEach(button => { button.onclick = () => { void run(button.dataset.mode!); }; });
