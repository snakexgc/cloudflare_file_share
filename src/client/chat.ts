import type { ChatAttachment, ChatEvent, ChatMessage, ChatSnapshot } from '../shared/chat';
import { api, ApiError, makeId } from './api';

const SESSION_KEY = 'file-share.chat.session';
const NAME_KEY = 'file-share.chat.name';
function stored(storage: 'sessionStorage' | 'localStorage', key: string) { try { return window[storage].getItem(key) ?? ''; } catch { return ''; } }
function save(storage: 'sessionStorage' | 'localStorage', key: string, value: string) { try { window[storage].setItem(key, value); } catch { /* Joining still works when storage is disabled. */ } }

export class ChatClient {
  snapshot?: ChatSnapshot;
  sessionToken = '';
  onChange = (_snapshot: ChatSnapshot) => {};
  onStatus = (_state: 'connecting' | 'ws' | 'http' | 'offline', _message?: string) => {};
  onNotice = (_message: string) => {};
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private joining?: Promise<void>;
  private connecting?: Promise<void>;
  private syncing?: Promise<void>;
  private stopped = false;
  private ticking = false;
  private nextConnect = 0;
  private lastPong = 0;
  private generation = 0;
  constructor(private handshakeMs = 5000, private storageKey = SESSION_KEY) {}
  private update(snapshot: ChatSnapshot) { this.snapshot = snapshot; this.onChange(snapshot); }
  async start() {
    if (this.joining) return this.joining;
    this.stopped = false;
    this.joining = this.join().finally(() => { this.joining = undefined; });
    return this.joining;
  }
  private async join() {
    this.onStatus('connecting');
    const secret = this.sessionToken || stored('sessionStorage', this.storageKey);
    const result = await api<{ sessionToken: string; generation: number; nameUnavailable: boolean; snapshot: ChatSnapshot }>('/api/chat/sessions', /^[a-f0-9]{64}$/.test(secret) ? secret : undefined, { preferredName: stored('sessionStorage', `${this.storageKey}.name`) || stored('localStorage', NAME_KEY) });
    if (this.stopped) return;
    this.sessionToken = result.sessionToken; this.generation = result.generation;
    save('sessionStorage', this.storageKey, result.sessionToken); save('sessionStorage', `${this.storageKey}.name`, result.snapshot.self.name); this.update(result.snapshot);
    if (result.nameUnavailable) this.onNotice('保存的用户名已有人在线使用，已为你分配临时昵称。');
    try { await this.connect(); } catch { this.onStatus('http', '实时连接不可用，正在定时同步'); }
    clearInterval(this.timer); this.timer = setInterval(() => { void this.tick(); }, 10000);
  }
  private async connect() {
    if (this.stopped || this.socket?.readyState === 1) return;
    if (typeof WebSocket !== 'function') { this.onStatus('http'); return; }
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const url = new URL('/api/chat/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, ['chat', `token.${this.sessionToken}`]); this.socket = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('聊天室连接超时')); }, this.handshakeMs);
      socket.onopen = () => { clearTimeout(timeout); this.lastPong = Date.now(); this.onStatus('ws'); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('聊天室连接失败')); };
      socket.onclose = () => { clearTimeout(timeout); reject(new Error('聊天室已断开')); if (this.socket === socket) this.socket = undefined; this.nextConnect = Date.now() + 15000; if (!this.stopped) { this.onStatus('http', '连接恢复中，消息仍会同步'); void this.sync().catch(() => {}); } };
      socket.onmessage = event => {
        if (this.stopped || this.socket !== socket) return;
        if (event.data === 'chat-pong') { this.lastPong = Date.now(); return; }
        try { this.event(JSON.parse(String(event.data)) as ChatEvent); } catch { void this.sync().catch(() => {}); }
      };
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private event(event: ChatEvent) {
    if (event.type === 'snapshot') { if (!this.snapshot || event.snapshot.revision >= this.snapshot.revision) this.update(event.snapshot); return; }
    const state = this.snapshot;
    if (!state || event.revision > state.revision + 1) { void this.sync().catch(() => {}); return; }
    if (event.revision <= state.revision) return;
    if (event.type === 'message') this.update({ ...state, revision: event.revision, messages: [...state.messages.filter(message => message.id !== event.message.id), event.message] });
    else if (event.type === 'members') this.update({ ...state, revision: event.revision, members: event.members, self: event.members.find(member => member.id === state.self.id) ?? state.self });
    else if (event.type === 'prune') this.update({ ...state, revision: event.revision, messages: state.messages.filter(message => !event.messageIds.includes(message.id)) });
  }
  async sync() {
    if (this.stopped || !this.sessionToken) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const result = await api<{ snapshot: ChatSnapshot | null }>(`/api/chat/state?since=${this.snapshot?.revision ?? -1}`, this.sessionToken);
        if (result.snapshot && !this.stopped && (!this.snapshot || result.snapshot.revision >= this.snapshot.revision)) this.update(result.snapshot);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) { this.sessionToken = ''; await this.start(); }
        else { this.onStatus('offline', error instanceof Error ? error.message : '连接暂不可用'); throw error; }
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async tick() {
    if (this.stopped || this.ticking) return; this.ticking = true;
    try {
      if (this.socket?.readyState === 1) { if (Date.now() - this.lastPong > 45000) this.socket.close(); else this.socket.send('chat-ping'); }
      else { await this.sync(); this.onStatus('http'); if (Date.now() >= this.nextConnect) await this.connect(); }
    } catch { /* The next tick retries; existing messages stay visible. */ }
    finally { this.ticking = false; }
  }
  async rename(name: string) {
    const result = await api<{ self: ChatSnapshot['self'] }>('/api/chat/name', this.sessionToken, { name });
    save('localStorage', NAME_KEY, result.self.name); save('sessionStorage', `${this.storageKey}.name`, result.self.name); await this.sync();
  }
  async post(text: string, attachment?: { shareId: string; ownerToken: string }): Promise<ChatMessage | null> {
    const nonce = makeId(), body = { nonce, text, ...attachment };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await api<{ message: ChatMessage | null }>('/api/chat/messages', this.sessionToken, body);
        await this.sync(); return result.message;
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) throw error;
        if (attempt < 1) continue;
        await this.sync(); const found = this.snapshot?.messages.find(message => message.nonce === nonce && message.authorId === this.snapshot?.self.id);
        if (found) return found; throw error;
      }
    }
  }
  async publish(attachment: ChatAttachment & { ownerToken: string }, text = '') { return this.post(text, { shareId: attachment.shareId, ownerToken: attachment.ownerToken }); }
  async leave() {
    const secret = this.sessionToken; this.stop(false);
    if (secret) await api('/api/chat/leave', secret, { generation: this.generation });
  }
  stop(notify = true) {
    this.stopped = true; clearInterval(this.timer);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = undefined; }
    if (notify && this.sessionToken) {
      const body = JSON.stringify({ token: this.sessionToken, generation: this.generation });
      try { if (navigator.sendBeacon('/api/chat/leave', new Blob([body], { type: 'application/json' }))) return; } catch { /* Use keepalive below. */ }
      void fetch('/api/chat/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  }
}
