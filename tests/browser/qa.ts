import { api, delay } from '../../src/client/api';
import { ControlSession } from '../../src/client/control';
import { VerifiedSink, type FileWriter } from '../../src/client/sink';
import { ReceiveTask, SendTask } from '../../src/client/transfer';
import type { ControlEvent, DownloadRequest, FileInfo, IceServer } from '../../src/shared/types';
import type { Limits } from '../../src/worker/config';
import { FRAME_HEADER_BYTES, WS_DEFAULT_PAYLOAD_BYTES, WS_MAX_MESSAGE_BYTES } from '../../src/shared/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { rtcSupport } from '../../src/client/rtc';
import { MODE_LABELS, TransferSpeed } from '../../src/client/speed';

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
  const useHttps = mode.startsWith('https'), mixed = mode === 'https-mixed';
  const useLan = mode.startsWith('lan'), useRtc = useLan || mode.startsWith('rtc');
  const nativeWs = globalThis.WebSocket, nativeRtc = globalThis.RTCPeerConnection;
  const senders = new Map<string, SendTask>();
  let discovery: ReturnType<typeof setInterval> | undefined, extraControl: ControlSession | undefined, extraTask: ReceiveTask | undefined, extraName = '';
  let overlap = false;
  let speedTimer: ReturnType<typeof setInterval> | undefined, peakSpeed = 0;
  let lanVerification: Promise<void> | undefined;
  try {
    if (useHttps && !mixed) { globalThis.WebSocket = undefined as unknown as typeof WebSocket; globalThis.RTCPeerConnection = undefined as unknown as typeof RTCPeerConnection; log('已禁用 WebSocket 和 RTCPeerConnection 构造器'); }
    const support = rtcSupport(); log(`当前页面 RTCPeerConnection 类型：${support.constructorType}；可创建数据连接：${support.available}`);
    if (useRtc && !support.available) { log(`SKIP：${support.message}；本次无法验收${useLan ? '内网' : ''}直连。`); return; }
    const config = await api<{ limits: Limits; stunServers: IceServer[] }>('/api/config');
    if (mode === 'ws-large' && config.limits.chunkBytes !== WS_DEFAULT_PAYLOAD_BYTES) throw new Error('大消息验收需要默认 WS 分片配置');
    const source = new Uint8Array(mode === 'zero' || mode === 'https-zero' ? 0 : useHttps ? 2 * config.limits.httpsChunkBytes + 17 : mode === 'ws-large' ? 2 * WS_DEFAULT_PAYLOAD_BYTES + 17 : 2 * 1024 ** 2 + 17);
    for (let i = 0; i < source.length; i++) source[i] = (i * 79 + 53) % 256;
    const file = new File([source], mode === 'zero' ? '空文件.bin' : '浏览器验收.bin', { type: 'application/octet-stream', lastModified: 123 });
    const created = await api<{ id: string; ownerToken: string; files: FileInfo[] }>('/api/shares', undefined, { expiresInHours: 1, transferMode: useLan ? 'lan' : 'auto', files: [{ name: file.name, size: file.size, mime: file.type, lastModified: file.lastModified }] });
    shareId = created.id; ownerToken = created.ownerToken;
    log(`分享已创建：${created.id}；源文件 ${source.length} 字节`);
    const useWs = !useHttps && mode !== 'rtc-http' && mode !== 'lan-http';
    owner = new ControlSession(shareId, 'owner', { webrtc: useRtc, ws: useWs || mixed, https: useHttps, readable: [created.files[0].id] }, config.limits, ownerToken);
    receiver = new ControlSession(shareId, 'receiver', { webrtc: useRtc, ws: useWs, https: useHttps, readable: [] }, config.limits);
    if (useHttps && !mixed) { owner.preferHttp(); receiver.preferHttp(); }
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
    owner.onRaw = data => {
      if (data.type === 'relay-credit') { const sender = [...senders.values()].find(item => item.task.transferId === data.transferId); if (sender) sender.credit(data); else credits.set(String(data.transferId), data); }
      else if (data.type === 'http-tasks' || data.type === 'resync') { for (const task of data.requests as DownloadRequest[]) if (['connecting', 'transferring'].includes(task.status) && task.mode !== 'r2') owner!.onEvent({ seq: 0, eventId: '', type: 'attempt', request: task, createdAt: Date.now() }); }
      else if (data.type === 'error') log(`发送端错误：${JSON.stringify(data)}`);
    };
    owner.onEvent = event => {
      if (event.request && ['attempt', 'transport-error', 'relay-error'].includes(event.type)) log(`发送端事件 ${event.type}：${event.request.mode}；${event.request.error ?? ''}`);
      ownerQueue = ownerQueue.then(async () => {
        if (!event.request) return;
        if (event.type === 'attempt' && event.request.mode !== 'r2') {
          const old = senders.get(event.request.id); if (old?.task.epoch === event.request.epoch) return; old?.stop();
          senderTask = new SendTask(event.request, file, owner!, config.limits, config.stunServers, (_id, label) => { if (label.includes('失败')) log(label); }); senders.set(event.request.id, senderTask);
          const credit = credits.get(event.request.transferId); if (credit) senderTask.credit(credit);
          void senderTask.start();
        } else if (event.type === 'rtc-answer' || event.type === 'rtc-ice') await senders.get(event.request.id)?.event(event);
        else if (event.type === 'stop-attempt' || event.type === 'canceled' || event.type === 'completed') senders.get(event.request.id)?.stop();
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
    if (mixed) discovery = setInterval(() => { void owner!.refreshStatus().catch(failed); }, 1200);
    directory = await (navigator.storage as unknown as { getDirectory(): Promise<Directory> }).getDirectory();
    savedName = `qa-${created.id}.bin`; const handle = await directory.getFileHandle(savedName, { create: true });
    const nativeWriter = await handle.createWritable();
    const verifyLan = async () => {
      const pc = (senderTask as unknown as { pc: RTCPeerConnection }).pc;
      if (pc.getConfiguration().iceServers?.length) throw new Error('内网模式配置了外部 ICE 服务器');
      const stats = await pc.getStats(); let hostPair = false;
      stats.forEach(item => { if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) { const local = stats.get(item.localCandidateId), remote = stats.get(item.remoteCandidateId); log(`内网候选对：${local?.candidateType} → ${remote?.candidateType}`); hostPair = local?.candidateType === 'host' && remote?.candidateType === 'host'; } });
      if (!hostPair) throw new Error('未验证双方使用 host 候选，不能认定为内网直传');
      log('内网连接：ICE 服务器为空，双方选中 host 候选；本次为同机双会话测试');
    };
    const measuredWriter: FileWriter = mode === 'https-speed' || useLan ? { write: async bytes => { if (useLan) await (lanVerification ??= verifyLan()); else await delay(2000); await nativeWriter.write(bytes); }, truncate: size => nativeWriter.truncate(size), seek: position => nativeWriter.seek(position), close: () => nativeWriter.close(), abort: () => nativeWriter.abort() } : nativeWriter;
    sink = new VerifiedSink(created.files[0], measuredWriter);
    const task = await api<DownloadRequest>(`${receiver.base}/download-requests`, receiver.sessionToken, { fileId: created.files[0].id });
    log(`实际传输模式：${task.mode}`);
    receiveTask = new ReceiveTask(task, sink, receiver, config.limits, config.stunServers, (_fileId, label, bytes, actualMode, done) => {
      if (done) { log(`${actualMode}：${label}（${bytes} 字节）`); complete(); }
      else if (label.startsWith('未完成')) failed(new Error(label));
      else if (label.includes('切换') || label.includes('连接')) log(`${actualMode}：${label}`);
    });
    await receiveTask.start(); for (const event of queue) await receiveTask.event(event);
    if (mode === 'https-speed') {
      const uploadSpeed = new TransferSpeed(), downloadSpeed = new TransferSpeed();
      const status = document.createElement('p'); status.id = 'speed-status'; output.parentElement!.insertBefore(status, output);
      speedTimer = setInterval(() => {
        const sent = senderTask ? uploadSpeed.sample(senderTask.task.transferId, senderTask.transferredBytes) : 0;
        const received = downloadSpeed.sample(receiveTask!.task.transferId, receiveTask!.transferredBytes);
        peakSpeed = Math.max(peakSpeed, sent, received);
        status.textContent = `当前方式：${MODE_LABELS[receiveTask!.task.mode]} · 上传 ${(sent / 1024 ** 2).toFixed(2)} MiB/s · 下载 ${(received / 1024 ** 2).toFixed(2)} MiB/s`;
      }, 250);
    }
    const extraFinished: Promise<void>[] = [];
    if (mixed) {
      extraControl = new ControlSession(shareId, 'receiver', { ws: true, webrtc: false, https: false, readable: [] }, config.limits); extraControl.busy = () => true;
      const pending: ControlEvent[] = []; let serial = Promise.resolve(), localDone!: () => void, serverDone!: () => void;
      extraFinished.push(new Promise<void>(resolve => { localDone = resolve; }), new Promise<void>(resolve => { serverDone = resolve; }));
      extraControl.onBinary = data => extraTask?.frame(data);
      extraControl.onEvent = event => { if (event.type === 'completed') serverDone(); if (!extraTask) pending.push(event); else serial = serial.then(() => extraTask!.event(event)).catch(failed); };
      await extraControl.start(); extraName = `qa-ws-${created.id}.bin`; const extraHandle = await directory.getFileHandle(extraName, { create: true }), writer = await extraHandle.createWritable();
      const slow: FileWriter = { write: async bytes => { await delay(3500); await writer.write(bytes); }, truncate: size => writer.truncate(size), seek: offset => writer.seek(offset), close: () => writer.close(), abort: () => writer.abort() };
      const wsTask = await api<DownloadRequest>(`${extraControl.base}/download-requests`, extraControl.sessionToken, { fileId: created.files[0].id });
      if (wsTask.mode !== 'ws') throw new Error(`混合测试的第二任务必须为 WS，实际 ${wsTask.mode}`);
      extraTask = new ReceiveTask(wsTask, new VerifiedSink(created.files[0], slow), extraControl, config.limits, config.stunServers, (_id, label, _bytes, actualMode, done) => { if (done) { if (actualMode !== 'ws') failed(new Error('WS 任务被 HTTPS 中断')); localDone(); } else if (label.startsWith('未完成')) failed(new Error(label)); });
      await extraTask.start(); for (const event of pending) await extraTask.event(event);
      const status = await api<{ requests: DownloadRequest[] }>(`${owner.base}/files-status`, owner.sessionToken);
      overlap = status.requests.some(item => item.mode === 'ws' && !['completed', 'canceled', 'failed'].includes(item.status)) && status.requests.some(item => item.mode === 'https' && !['completed', 'canceled', 'failed'].includes(item.status));
      log(`HTTPS 与 WS 活跃任务同时存在：${overlap}`);
    }
    await Promise.race([Promise.all([finished, settled, ...extraFinished]), timedOut]); clearTimeout(deadline);
    if (useRtc && receiveTask.task.mode !== (useLan ? 'lan' : 'p2p')) throw new Error(`原定 WebRTC 传输变成了 ${receiveTask.task.mode}；不能视为直连通过`);
    if (useLan) { if (!lanVerification) throw new Error('内网数据未写入'); await lanVerification; }
    if (useHttps && receiveTask.task.mode !== 'https') throw new Error(`HTTPS 测试使用了 ${receiveTask.task.mode}`);
    if (mode === 'https-speed') { if (peakSpeed <= 0) throw new Error('真实传输未取得非零速度样本'); log(`传输速度样本峰值：${(peakSpeed / 1024 ** 2).toFixed(2)} MiB/s（本地网络，非公网性能测量）`); }
    const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer()), expectedHash = bytesToHex(sha256(source)), actualHash = bytesToHex(sha256(actual));
    if (actual.length !== source.length || actualHash !== expectedHash) throw new Error('重新读取保存文件后哈希不匹配');
    if (mode === 'ws-large') {
      if (frameSizes.length !== 3 || frameSizes[0] !== WS_MAX_MESSAGE_BYTES - 1024 || frameSizes[1] !== WS_MAX_MESSAGE_BYTES - 1024 || frameSizes[2] !== FRAME_HEADER_BYTES + 17) throw new Error('WS 分片没有使用两条大消息和一条尾消息');
      log(`完整 WS 消息字节数：${frameSizes.join(', ')}`);
    }
    if (mixed) { const extraHandle = await directory.getFileHandle(extraName, { create: false }), bytes = new Uint8Array(await (await extraHandle.getFile()).arrayBuffer()); if (!overlap || bytes.length !== source.length || bytesToHex(sha256(bytes)) !== expectedHash) throw new Error('并行 WS 文件校验失败'); log('并行 WS 文件的字节数与 SHA-256 校验通过'); }
    log(`保存文件字节数：${actual.length}`); log(`源 SHA-256：${expectedHash}`); log(`保存 SHA-256：${actualHash}`); log('PASS：真实传输、写入结束、原始内容与 SHA-256 全部一致');
  } catch (error) { log(`FAIL：${error instanceof Error ? error.message : String(error)}`); }
  finally {
    clearTimeout(deadline); await sink?.abort().catch(() => {});
    clearInterval(speedTimer);
    clearInterval(discovery); for (const sender of senders.values()) sender.stop(); await receiveTask?.cancel().catch(() => {}); await extraTask?.cancel().catch(() => {}); extraControl?.stop(); owner?.stop(); receiver?.stop();
    if (shareId && ownerToken) await api(`/api/shares/${shareId}`, ownerToken, undefined, 'DELETE').catch(() => {});
    if (savedName && directory) await directory.removeEntry(savedName).catch(() => {});
    if (extraName && directory) await directory.removeEntry(extraName).catch(() => {});
    globalThis.WebSocket = nativeWs; globalThis.RTCPeerConnection = nativeRtc;
    buttons.forEach(button => { button.disabled = false; });
  }
}
buttons.forEach(button => { button.onclick = () => { void run(button.dataset.mode!); }; });
