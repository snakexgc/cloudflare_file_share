import './chat.css';
import { ChatClient } from '../src/client/chat';
import { ChatTransfers } from '../src/client/share-transfer';
import { chooseSink } from '../src/client/sink';
import { MODE_LABELS, TransferSpeed } from '../src/client/speed';
import type { ChatAttachment, ChatMessage, ChatSnapshot } from '../src/shared/chat';
import type { PublicConfig } from '../src/client/config';
import type { ShareTransferMode } from '../src/shared/types';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const size = (value: number) => { const units = ['B', 'KiB', 'MiB', 'GiB']; const index = value ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0; return `${(value / 1024 ** index).toLocaleString('zh-CN', { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; };
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const glyph = (path: string) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const chatIcon = glyph('<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 11h10M7 15h6"/>');
const fileIcon = glyph('<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>');
const clipIcon = glyph('<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/>');
const sendIcon = glyph('<path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2"/>');
interface Turnstile { render(element: HTMLElement, options: { sitekey: string; action: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void }): string; reset(id: string): void }

export class ChatView {
  readonly client: ChatClient;
  readonly transfers: ChatTransfers;
  private selected: File[] = [];
  private sending = false;
  private joining = false;
  private timer?: ReturnType<typeof setInterval>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private sourceMessages = new Map<string, HTMLElement>();
  private speed = new Map<string, TransferSpeed>();
  private progress = new Map<string, { label: string; bytes: number; mode?: string; finished?: boolean }>();
  private challengeToken = '';
  private widget?: string;
  private get turnstile() { return (window as unknown as { turnstile?: Turnstile }).turnstile; }
  private $ = <T extends HTMLElement = HTMLElement>(selector: string) => this.root.querySelector<T>(selector)!;
  constructor(private root: HTMLElement, private config: PublicConfig, private compact = false) {
    this.client = new ChatClient(config.limits.wsHandshakeMs); this.transfers = new ChatTransfers(config);
    root.classList.add('chat-root'); if (compact) root.classList.add('chat-compact');
    root.innerHTML = `${compact ? `<button class="chat-dock-toggle button primary" aria-expanded="false" aria-controls="chat-dock-panel">${chatIcon}<span>聊天室</span><span class="chat-dock-count">…</span></button><div id="chat-dock-panel" class="chat-dock-panel" hidden>` : '<section class="chat-intro"><div><div class="eyebrow"><span class="live-dot"></span> 打开即加入，一起聊一聊</div><h1>公共聊天室</h1><p>发条消息，或直接把文件分享给在场的人。</p></div><a href="/send" class="button secondary">创建链接分享</a></section>'}
      <div class="chat-layout card"><section class="chat-board" aria-label="公共聊天室">
        <header class="chat-board-heading"><span class="chat-heading-icon">${chatIcon}</span><div><h2>所有人都在这里</h2><span class="chat-online-count">正在加入…</span></div><span class="chat-connection" role="status">正在连接</span>${compact ? '<button class="chat-close" aria-label="收起聊天室">×</button>' : ''}</header>
        <div class="chat-notice" role="status" hidden></div><p class="chat-error" role="alert" hidden></p>
        <div class="chat-log" role="log" aria-label="聊天消息" aria-live="polite" aria-relevant="additions"><div class="chat-empty">${chatIcon}<strong>打个招呼吧</strong><span>消息和文件会出现在这里，后来加入的人也能看到最近的记录。</span></div></div>
        <form class="chat-compose"><div class="chat-selected" aria-label="已选择的文件"></div><label class="chat-input-label" for="chat-text">发送消息</label><textarea id="chat-text" rows="2" maxlength="${config.limits.chatMessageChars * 2}" placeholder="说点什么，或拖入文件…" aria-describedby="chat-compose-help"></textarea>
          <div class="chat-compose-actions"><label class="chat-attach" for="chat-files">${clipIcon}<span>选择文件</span><input id="chat-files" type="file" multiple aria-label="选择聊天文件"/></label><select class="chat-transfer-mode" aria-label="聊天文件传输方式"><option value="auto">自动传输</option><option value="lan">内网直传</option></select><span class="chat-char-count">0/${config.limits.chatMessageChars}</span><button class="button primary chat-send" type="submit" disabled>发送 ${sendIcon}</button></div>
          <div class="chat-challenge" hidden></div><p id="chat-compose-help" class="chat-compose-help">消息对所有人可见。发送文件后，请保持当前页面打开；文件默认 ${config.limits.defaultShareHours} 小时有效。</p>
        </form>
      </section><aside class="chat-sidebar"><section class="chat-profile"><form class="chat-name-form"><label for="chat-name">我的用户名</label><div class="chat-name-input"><input id="chat-name" maxlength="40" autocomplete="nickname" placeholder="正在分配昵称…" disabled/><button class="button secondary" type="submit" disabled>保存</button></div><p>1–20 个字符，在线用户不能重名。</p><p class="chat-name-error" role="alert" hidden></p></form><button class="text-button chat-reconnect" type="button" hidden>重新连接聊天室</button></section><details class="chat-people" open><summary>在线成员 <span class="chat-member-count">0</span></summary><ul class="chat-members"></ul></details><p class="chat-history-note">保留最近 ${config.limits.chatMaxMessages} 条消息，最长 ${config.limits.chatHistoryHours} 小时。文件沿用原分享的有效期。</p></aside></div>${compact ? '</div>' : ''}`;
    if (compact || matchMedia('(max-width:700px)').matches) this.$<HTMLDetailsElement>('.chat-people').open = false;
    this.$<HTMLFormElement>('.chat-compose').onsubmit = event => { event.preventDefault(); void this.send(); };
    this.$<HTMLTextAreaElement>('#chat-text').oninput = () => this.updateSend();
    this.$<HTMLTextAreaElement>('#chat-text').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!this.$<HTMLButtonElement>('.chat-send').disabled) void this.send(); } };
    this.$<HTMLInputElement>('#chat-files').onchange = event => { this.addFiles(Array.from((event.target as HTMLInputElement).files ?? [])); (event.target as HTMLInputElement).value = ''; };
    this.$<HTMLFormElement>('.chat-name-form').onsubmit = event => { event.preventDefault(); void this.rename(); };
    this.$<HTMLInputElement>('#chat-name').oninput = () => { this.$('.chat-name-error').hidden = true; };
    this.$('.chat-reconnect').onclick = () => { void this.start(); };
    this.$('.chat-board').ondragover = event => { event.preventDefault(); this.$('.chat-board').classList.add('chat-dragging'); };
    this.$('.chat-board').ondragleave = event => { if (!this.$('.chat-board').contains(event.relatedTarget as Node | null)) this.$('.chat-board').classList.remove('chat-dragging'); };
    this.$('.chat-board').ondrop = event => { event.preventDefault(); this.$('.chat-board').classList.remove('chat-dragging'); this.addFiles(Array.from(event.dataTransfer?.files ?? [])); };
    if (compact) {
      const toggle = () => { const panel = this.$('#chat-dock-panel'); panel.hidden = !panel.hidden; this.$('.chat-dock-toggle').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) this.$('.chat-log').scrollTop = this.$('.chat-log').scrollHeight; };
      this.$('.chat-dock-toggle').onclick = toggle; this.$('.chat-close').onclick = toggle;
    }
    this.client.onChange = snapshot => this.render(snapshot);
    this.client.onNotice = text => this.notice(text);
    this.client.onStatus = (state, message) => { this.$('.chat-connection').textContent = ({ connecting: '连接中', ws: '实时在线', http: '定时同步', offline: '暂时离线' })[state]; this.$('.chat-connection').dataset.state = state; this.$('.chat-connection').title = message ?? ''; this.$('.chat-reconnect').hidden = state !== 'offline'; };
    this.transfers.onProgress = (fileId, label, bytes, mode, finished) => { this.progress.set(fileId, { label, bytes, mode, finished }); this.updateFiles(); };
    this.timer = setInterval(() => this.updateFiles(), 1000);
    this.renderSelected();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void this.client.sync().catch(() => {}); });
  }
  async start() {
    if (this.joining) return; this.joining = true; this.error('');
    if (!this.timer) this.timer = setInterval(() => this.updateFiles(), 1000);
    try { await this.client.start(); }
    catch (error) { this.error(error instanceof Error ? error.message : '无法加入聊天室'); this.$('.chat-reconnect').hidden = false; }
    finally { this.joining = false; }
  }
  private error(message: string) { this.$('.chat-error').textContent = message; this.$('.chat-error').hidden = !message; }
  private notice(message: string) { clearTimeout(this.noticeTimer); this.$('.chat-notice').textContent = message; this.$('.chat-notice').hidden = false; this.noticeTimer = setTimeout(() => { this.$('.chat-notice').hidden = true; }, 7000); }
  private render(snapshot: ChatSnapshot) {
    const name = this.$<HTMLInputElement>('#chat-name'); if (document.activeElement !== name) name.value = snapshot.self.name; name.disabled = false; this.$<HTMLButtonElement>('.chat-name-form button').disabled = false;
    this.$('.chat-online-count').textContent = `${snapshot.members.length} 人在线 · 无需注册`;
    this.$('.chat-member-count').textContent = String(snapshot.members.length);
    if (this.compact) this.$('.chat-dock-count').textContent = String(snapshot.members.length);
    this.$('.chat-members').innerHTML = snapshot.members.map(member => `<li><span class="chat-avatar">${escape(Array.from(member.name)[0])}</span><span title="${escape(member.name)}">${escape(member.name)}</span>${member.id === snapshot.self.id ? '<small>你</small>' : ''}<i aria-hidden="true"></i></li>`).join('');
    const list = this.$('.chat-log'), follow = list.scrollHeight - list.scrollTop - list.clientHeight < 70, ids = new Set(snapshot.messages.map(message => message.id));
    for (const [id, element] of this.sourceMessages) if (!ids.has(id)) { element.remove(); this.sourceMessages.delete(id); }
    let ownNew = false;
    for (const message of snapshot.messages) if (!this.sourceMessages.has(message.id)) {
      const element = document.createElement('article'); element.className = `chat-message${message.authorId === snapshot.self.id ? ' chat-message-own' : ''}`; element.dataset.messageId = message.id;
      element.innerHTML = `<span class="chat-avatar">${escape(Array.from(message.authorName)[0])}</span><div class="chat-message-content"><div class="chat-message-meta"><strong>${escape(message.authorName)}</strong><time datetime="${new Date(message.createdAt).toISOString()}">${time(message.createdAt)}</time></div>${message.text ? `<p class="chat-message-text">${escape(message.text)}</p>` : ''}${this.attachment(message)}</div>`;
      list.appendChild(element); this.sourceMessages.set(message.id, element); if (message.authorId === snapshot.self.id) ownNew = true;
      element.querySelectorAll<HTMLButtonElement>('[data-chat-download]').forEach(button => { button.onclick = () => { void this.download(message, button.dataset.chatDownload!, button); }; });
      element.querySelectorAll<HTMLButtonElement>('[data-chat-cancel]').forEach(button => { button.onclick = () => { void this.transfers.cancel(button.dataset.chatCancel!); }; });
    }
    this.$('.chat-empty').hidden = snapshot.messages.length > 0;
    if (follow || ownNew) list.scrollTop = list.scrollHeight;
    this.updateSend(); this.updateFiles();
  }
  private attachment(message: ChatMessage) {
    const attachment = message.attachment; if (!attachment) return '';
    return `<div class="chat-file-list">${attachment.files.map(file => `<div class="chat-file" data-chat-file="${file.id}" data-expires="${attachment.expiresAt}" data-share="${attachment.shareId}"><div class="chat-file-main"><span class="chat-file-icon">${fileIcon}</span><div class="chat-file-name"><strong title="${escape(file.name)}">${escape(file.name)}</strong><span>${size(file.size)} · ${attachment.transferMode === 'lan' ? '内网直传' : '自动传输'}</span></div><button type="button" class="button secondary" data-chat-download="${file.id}">下载</button></div><p class="chat-file-state">点击下载原文件</p><progress class="chat-file-progress" value="0" max="${file.size || 1}" aria-label="${escape(file.name)} 下载进度" hidden></progress><div class="chat-file-bottom"><span class="chat-file-speed"></span><button type="button" class="text-button" data-chat-cancel="${file.id}" hidden>取消下载</button></div></div>`).join('')}<div class="chat-attachment-note"><span>${time(attachment.expiresAt)} 到期 · 发送者需保持在线</span><a href="/s/${attachment.shareId}" target="_blank" rel="noopener noreferrer">打开分享页 ↗</a></div></div>`;
  }
  private updateFiles() {
    this.transfers.prune();
    for (const row of this.root.querySelectorAll<HTMLElement>('[data-chat-file]')) {
      const fileId = row.dataset.chatFile!, expired = Number(row.dataset.expires) <= Date.now(), owned = this.transfers.owns(row.dataset.share!), status = this.progress.get(fileId), busy = this.transfers.busy(fileId);
      const button = row.querySelector<HTMLButtonElement>('[data-chat-download]')!;
      const unavailable = !this.transfers.available(row.dataset.share!);
      button.disabled = expired || unavailable || owned || busy; button.textContent = expired ? '已过期' : unavailable ? '已失效' : owned ? '本机文件' : busy ? '接收中' : status?.finished ? '再次下载' : status?.label.startsWith('未完成') ? '重试' : '下载';
      row.querySelector<HTMLElement>('.chat-file-state')!.textContent = expired ? '文件分享已到期' : status ? `${status.mode ? `${MODE_LABELS[status.mode] ?? status.mode} · ` : ''}${status.label}` : owned ? '等待其他成员下载，请保持页面打开' : '点击下载原文件';
      const bar = row.querySelector<HTMLProgressElement>('progress')!; bar.hidden = !status; if (status) bar.value = status.finished && bar.max === 1 ? 1 : status.bytes;
      row.querySelector<HTMLButtonElement>('[data-chat-cancel]')!.hidden = !busy;
      let speed = 0;
      for (const sample of this.transfers.samples(fileId)) { let meter = this.speed.get(sample.key); if (!meter) { meter = new TransferSpeed(); this.speed.set(sample.key, meter); } speed += meter.sample(sample.key, sample.bytes); }
      row.querySelector<HTMLElement>('.chat-file-speed')!.textContent = busy || speed ? `${size(speed)}/s` : '';
    }
  }
  addFiles(files: File[]) {
    if (this.sending) return;
    this.error('');
    for (const file of files) {
      if (this.selected.some(value => value.name === file.name && value.size === file.size && value.lastModified === file.lastModified)) continue;
      if (file.size > this.config.limits.maxFileBytes) { this.error(`${file.name} 超过单文件限制 ${size(this.config.limits.maxFileBytes)}`); continue; }
      if (this.selected.length >= this.config.limits.maxFiles || this.selected.reduce((total, value) => total + value.size, file.size) > this.config.limits.maxShareBytes) { this.error('文件数量或总大小超过分享限制'); break; }
      this.selected.push(file);
    }
    this.renderSelected();
  }
  private renderSelected() {
    this.$('.chat-selected').innerHTML = this.selected.map((file, index) => `<span title="${escape(file.name)}"><strong>${escape(file.name)}</strong><small>${size(file.size)}</small><button type="button" data-remove="${index}" aria-label="移除 ${escape(file.name)}">×</button></span>`).join('');
    this.root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => { button.onclick = () => { this.selected.splice(Number(button.dataset.remove), 1); this.renderSelected(); }; });
    this.$('.chat-transfer-mode').hidden = !this.selected.length;
    if (this.selected.length && this.config.challengeRequired) void this.challenge();
    this.$('.chat-challenge').hidden = !this.selected.length || !this.config.challengeRequired; this.updateSend();
  }
  private updateSend() {
    const count = Array.from(this.$<HTMLTextAreaElement>('#chat-text').value).length;
    this.$('.chat-char-count').textContent = `${count}/${this.config.limits.chatMessageChars}`;
    const button = this.$<HTMLButtonElement>('.chat-send'); button.disabled = this.sending || !this.client.sessionToken || !count && !this.selected.length || count > this.config.limits.chatMessageChars;
    this.$<HTMLTextAreaElement>('#chat-text').disabled = this.sending;
    this.$<HTMLInputElement>('#chat-files').disabled = this.sending;
    (this.$('.chat-transfer-mode') as unknown as HTMLSelectElement).disabled = this.sending;
    this.root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(control => { control.disabled = this.sending; });
  }
  private async rename() {
    const button = this.$<HTMLButtonElement>('.chat-name-form button'); button.disabled = true;
    try { await this.client.rename(this.$<HTMLInputElement>('#chat-name').value); this.$<HTMLInputElement>('#chat-name').value = this.client.snapshot!.self.name; this.$('.chat-name-error').hidden = true; this.notice('用户名已更新'); }
    catch (error) { this.$('.chat-name-error').textContent = error instanceof Error ? error.message : String(error); this.$('.chat-name-error').hidden = false; }
    finally { button.disabled = false; }
  }
  private async send() {
    if (this.sending || this.$<HTMLButtonElement>('.chat-send').disabled) return;
    if (this.selected.length && this.config.challengeRequired && !this.challengeToken) { this.error('发送文件前请完成人机验证'); return; }
    const input = this.$<HTMLTextAreaElement>('#chat-text'), text = input.value, files = [...this.selected]; this.sending = true; this.error(''); this.updateSend();
    let attachment: (ChatAttachment & { ownerToken: string }) | undefined;
    try {
      if (this.selected.length) {
        const mode = (this.$('.chat-transfer-mode') as unknown as HTMLSelectElement).value as ShareTransferMode;
        attachment = await this.transfers.prepare(files, mode, this.challengeToken); await this.client.publish(attachment, text);
      } else await this.client.post(text);
      input.value = ''; this.selected = []; this.renderSelected();
      if (this.widget) { this.turnstile?.reset(this.widget); this.challengeToken = ''; }
    } catch (error) { if (attachment) await this.transfers.discard(attachment).catch(() => {}); this.error(error instanceof Error ? error.message : '消息发送失败'); }
    finally { this.sending = false; this.updateSend(); }
  }
  private async download(message: ChatMessage, fileId: string, button: HTMLButtonElement) {
    const attachment = message.attachment!, file = attachment.files.find(value => value.id === fileId)!;
    if (button.disabled) return; button.disabled = true;
    try { const sink = await chooseSink(file, this.config.limits.memoryDownloadBytes); await this.transfers.download(attachment, file, sink); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error instanceof Error ? error.message : '下载未完成'); }
    finally { this.updateFiles(); }
  }
  private async challenge() {
    if (this.widget) return;
    if (!this.config.turnstileSiteKey) { this.error('服务端已要求文件验证，但尚未配置验证组件'); return; }
    try {
      if (!this.turnstile) await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-chat-turnstile]');
        if (existing) { existing.addEventListener('load', () => resolve(), { once: true }); existing.addEventListener('error', () => reject(new Error('验证组件加载失败')), { once: true }); return; }
        const script = document.createElement('script'); script.dataset.chatTurnstile = 'true'; script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.onload = () => resolve(); script.onerror = () => reject(new Error('验证组件加载失败')); (document.head as unknown as HTMLHeadElement).appendChild(script);
      });
      if (!this.widget) this.widget = this.turnstile!.render(this.$('.chat-challenge'), { sitekey: this.config.turnstileSiteKey, action: 'create-share', callback: value => { this.challengeToken = value; }, 'expired-callback': () => { this.challengeToken = ''; }, 'error-callback': () => { this.challengeToken = ''; } });
    } catch (error) { this.error(error instanceof Error ? error.message : '验证组件不可用'); }
  }
  stop() { clearInterval(this.timer); this.timer = undefined; clearTimeout(this.noticeTimer); this.client.stop(); this.transfers.stop(); }
}

export function mountChat(config: PublicConfig, host?: HTMLElement) {
  const root = host ?? document.createElement('div'); if (!host) { root.className = 'chat-dock'; (document.body as unknown as HTMLBodyElement).appendChild(root); }
  const view = new ChatView(root, config, !host); void view.start();
  window.addEventListener('pagehide', () => view.stop()); window.addEventListener('pageshow', event => { if (event.persisted) void view.start(); }); return view;
}
