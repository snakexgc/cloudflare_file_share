import { ChatClient } from '../../src/client/chat';
import { ChatTransfers } from '../../src/client/share-transfer';
import { VerifiedSink, type FileWriter } from '../../src/client/sink';
import { api, delay } from '../../src/client/api';
import { rtcSupport } from '../../src/client/rtc';
import type { PublicConfig } from '../../src/client/config';
import type { ChatAttachment } from '../../src/shared/chat';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface Handle { createWritable(): Promise<FileWriter>; getFile(): Promise<File> }
interface Directory { getFileHandle(name: string, options: { create: boolean }): Promise<Handle>; removeEntry(name: string): Promise<void> }
const output = document.querySelector<HTMLPreElement>('#result')!;
const buttons = document.querySelectorAll<HTMLButtonElement>('button');
function log(text: string) { output.textContent += `\n${text}`; }
async function run(mode: string) {
  buttons.forEach(button => { button.disabled = true; }); output.textContent = `模式：${mode}`;
  const suffix = crypto.randomUUID().slice(0, 6), originalWs = globalThis.WebSocket, originalRtc = globalThis.RTCPeerConnection;
  const a = new ChatClient(5000, `qa-chat-a-${suffix}`), b = new ChatClient(5000, `qa-chat-b-${suffix}`);
  let sender: ChatTransfers | undefined, receiver: ChatTransfers | undefined, attachment: (ChatAttachment & { ownerToken: string }) | undefined;
  let directory: Directory | undefined, savedName = '', timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (mode === 'http') { globalThis.WebSocket = undefined as unknown as typeof WebSocket; globalThis.RTCPeerConnection = undefined as unknown as typeof RTCPeerConnection; }
    if (mode === 'lan' && !rtcSupport().available) { log('SKIP：当前页面无法创建 WebRTC，不能验收内网文件链路'); return; }
    const config = await api<PublicConfig>('/api/config');
    await a.start(); await b.start();
    if (a.snapshot!.self.id === b.snapshot!.self.id) throw new Error('两个验收会话未隔离');
    await a.rename(`验收甲-${suffix}`); await b.rename(`验收乙-${suffix}`);
    let rejected = false; try { await b.rename(a.snapshot!.self.name); } catch { rejected = true; }
    if (!rejected) throw new Error('在线用户名重名未被拒绝'); log('两个用户自动加入；改名与在线重名拒绝通过');
    const greeting = `你好，聊天室 ${suffix}`;
    await a.post(greeting);
    if (mode === 'http') await b.sync();
    for (let attempt = 0; !b.snapshot!.messages.some(message => message.text === greeting) && attempt < 40; attempt++) await delay(100);
    if (!b.snapshot!.messages.some(message => message.text === greeting)) throw new Error('另一端没有收到消息');
    log(`${mode === 'http' ? 'HTTP 同步' : 'WS 实时同步'}文本消息通过`);
    sender = new ChatTransfers(config); receiver = new ChatTransfers(config);
    const source = new Uint8Array(2 * 1024 ** 2 + 17); for (let index = 0; index < source.length; index++) source[index] = (index * 31 + 7) % 256;
    attachment = await sender.prepare([new File([source], `聊天室验收-${suffix}.bin`, { lastModified: 1 })], mode === 'lan' ? 'lan' : 'auto');
    const posted = await a.publish(attachment, '文件验收'); if (!posted?.attachment) throw new Error('文件未发布到聊天室');
    await b.sync(); const message = b.snapshot!.messages.find(value => value.id === posted.id); if (!message?.attachment) throw new Error('另一端未同步文件消息');
    if (JSON.stringify(message).includes(attachment.ownerToken)) throw new Error('文件消息泄露源端令牌');
    directory = await (navigator.storage as unknown as { getDirectory(): Promise<Directory> }).getDirectory();
    savedName = `chat-qa-${suffix}.bin`; const handle = await directory.getFileHandle(savedName, { create: true });
    const sink = new VerifiedSink(message.attachment.files[0], await handle.createWritable());
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; }); void done.catch(() => {});
    receiver.onProgress = (_fileId, label, bytes, actualMode, finished) => {
      if (finished) {
        if (mode === 'lan' && actualMode !== 'lan' || mode === 'http' && actualMode !== 'https') { reject(new Error(`实际传输方式不符合预期：${actualMode}`)); return; }
        log(`实际传输方式：${actualMode}；已保存 ${bytes} 字节`); resolve();
      } else if (label.startsWith('未完成')) reject(new Error(label));
    };
    timer = setTimeout(() => reject(new Error('90 秒内未完成文件下载')), 90000);
    await receiver.download(message.attachment, message.attachment.files[0], sink); await done; clearTimeout(timer);
    const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer()), expectedHash = bytesToHex(sha256(source)), actualHash = bytesToHex(sha256(actual));
    if (source.length !== actual.length || expectedHash !== actualHash) throw new Error('文件内容或 SHA-256 不一致');
    log(`源 SHA-256：${expectedHash}`); log(`保存 SHA-256：${actualHash}`); log('PASS：公共聊天、用户名去重、文件发布、下载与原内容完整性均通过');
  } catch (error) { log(`FAIL：${error instanceof Error ? error.message : String(error)}`); }
  finally {
    clearTimeout(timer); receiver?.stop();
    if (attachment && sender) await sender.discard(attachment).catch(() => {}); sender?.stop();
    await a.leave().catch(() => {}); await b.leave().catch(() => {});
    if (directory && savedName) await directory.removeEntry(savedName).catch(() => {});
    globalThis.WebSocket = originalWs; globalThis.RTCPeerConnection = originalRtc;
    buttons.forEach(button => { button.disabled = false; });
  }
}
buttons.forEach(button => { button.onclick = () => { void run(button.dataset.mode!); }; });
