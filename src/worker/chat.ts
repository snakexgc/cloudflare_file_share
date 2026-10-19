import { DurableObject } from 'cloudflare:workers';
import { chatName, type ChatAttachment, type ChatEvent, type ChatMember, type ChatMessage, type ChatSnapshot } from '../shared/chat';
import type { ShareInfo } from '../shared/types';
import { ID_PATTERN } from '../shared/protocol';
import { limits, type Env } from './config';
import { assert, bearer, budget, constantEqual, digest, errorResponse, HttpError, id, json, readJson, token } from './util';

interface Member extends ChatMember {
  key: string; tokenHash: string; sourceHash: string; lastSeen: number;
  generation: number;
  rate: { count: number; resetAt: number }; receipts: { nonce: string; messageId: string }[];
}
interface Meta { revision: number }

/** One public room serializes name claims and persists bounded history, never file bytes. */
export class ChatRoom extends DurableObject<Env> {
  private members = new Map<string, Member>();
  private messages: ChatMessage[] = [];
  private meta: Meta = { revision: 0 };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.meta = await ctx.storage.get<Meta>('meta') ?? { revision: 0 };
      for (const member of (await ctx.storage.list<Member>({ prefix: 'member:' })).values()) { member.generation ??= 1; this.members.set(member.id, member); }
      this.messages = [...(await ctx.storage.list<ChatMessage>({ prefix: 'message:' })).values()].sort((a, b) => a.sequence - b.sequence);
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('chat-ping', 'chat-pong'));
    });
  }
  private publicMember(member: Member): ChatMember { return { id: member.id, name: member.name, joinedAt: member.joinedAt }; }
  private publicMembers() { return [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)).map(member => this.publicMember(member)); }
  private snapshot(member: Member): ChatSnapshot { return { revision: this.meta.revision, self: this.publicMember(member), members: this.publicMembers(), messages: this.messages, historyHours: limits(this.env).chatHistoryHours }; }
  private seenAt(member: Member) {
    let latest = member.lastSeen;
    for (const socket of this.ctx.getWebSockets(member.id)) if (socket.readyState === 1) latest = Math.max(latest, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0);
    return latest;
  }
  private async persist(member: Member) { await this.ctx.storage.put(`member:${member.id}`, member); }
  private async emit(event: Exclude<ChatEvent, { type: 'snapshot' }>) {
    await this.ctx.storage.put('meta', this.meta);
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) { try { if (socket.readyState === 1) socket.send(payload); } catch { socket.close(1011, 'chat send failed'); } }
  }
  private async membersChanged() { await this.emit({ type: 'members', revision: ++this.meta.revision, members: this.publicMembers() }); }
  private async remove(member: Member) {
    this.members.delete(member.id); await this.ctx.storage.delete(`member:${member.id}`);
    for (const socket of this.ctx.getWebSockets(member.id)) { try { socket.close(1000, 'chat session ended'); } catch { /* Already closed. */ } }
  }
  private async prune() {
    const conf = limits(this.env), now = Date.now(); let changed = false;
    for (const member of this.members.values()) if (this.seenAt(member) + conf.leaseMs <= now) { await this.remove(member); changed = true; }
    if (changed) await this.membersChanged();
    const keep = this.messages.filter(message => message.createdAt + conf.chatHistoryHours * 3600000 > now).slice(-conf.chatMaxMessages);
    const ids = new Set(keep.map(message => message.id)), removed = this.messages.filter(message => !ids.has(message.id));
    if (removed.length) {
      this.messages = keep;
      for (let start = 0; start < removed.length; start += 64) await this.ctx.storage.delete(removed.slice(start, start + 64).map(message => `message:${message.id}`));
      await this.emit({ type: 'prune', revision: ++this.meta.revision, messageIds: removed.map(message => message.id) });
    }
  }
  private async schedule() {
    const conf = limits(this.env), now = Date.now();
    const deadlines = [...this.members.values()].map(member => this.seenAt(member) + conf.leaseMs);
    if (this.messages.length) deadlines.push(this.messages[0].createdAt + conf.chatHistoryHours * 3600000);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  private find(secret: string) { const hash = digest(secret); return [...this.members.values()].find(member => constantEqual(member.tokenHash, hash)); }
  private authenticate(request: Request): Member {
    const secret = bearer(request); const member = secret ? this.find(secret) : undefined;
    assert(member, 401, 'chat_session_expired', '聊天室会话已过期，请重新连接'); return member;
  }
  private rate(member: Member) {
    const now = Date.now();
    if (member.rate.resetAt <= now) member.rate = { count: 0, resetAt: now + 60000 };
    assert(member.rate.count < limits(this.env).chatMessagesPerMinute, 429, 'chat_rate_limit', '消息发送过快，请稍后再试'); member.rate.count++;
  }
  private async attachment(data: Record<string, unknown>): Promise<ChatAttachment> {
    assert(typeof data.shareId === 'string' && ID_PATTERN.test(data.shareId) && typeof data.ownerToken === 'string' && /^[a-f0-9]{64}$/.test(data.ownerToken), 400, 'invalid_chat_attachment', '文件分享信息无效');
    await budget(this.env, '/do-used', { count: 1 });
    const response = await this.env.ROOMS.get(this.env.ROOMS.idFromName(data.shareId)).fetch(new Request('https://room/internal/chat-attachment', { method: 'POST', headers: { Authorization: `Bearer ${data.ownerToken}` } }));
    if (!response.ok) { const failure = await response.json<{ error: string; message: string }>(); throw new HttpError(response.status, failure.error, failure.message); }
    const share = await response.json<ShareInfo>();
    assert(share.status === 'active' && share.files.length > 0, 410, 'chat_file_expired', '文件分享已结束');
    return { shareId: share.id, expiresAt: share.expiresAt, transferMode: share.transferMode ?? 'auto', files: share.files };
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.prune();
        const url = new URL(request.url), route = url.pathname.slice('/api/chat'.length), method = request.method;
        if (route === '/sessions' && method === 'POST') {
          const data = await readJson(request, 2048), previous = bearer(request); let member = previous ? this.find(previous) : undefined;
          let secret = previous, nameUnavailable = false;
          if (!member) {
            const conf = limits(this.env), sourceHash = request.headers.get('X-File-Share-Source') ?? 'local';
            assert(this.members.size < conf.chatMaxMembers, 429, 'chat_full', '聊天室在线人数已达上限');
            assert([...this.members.values()].filter(value => value.sourceHash === sourceHash).length < conf.maxSessions, 429, 'chat_source_limit', '当前网络打开的聊天室页面过多');
            const preferred = chatName(data.preferredName);
            let name = preferred;
            if (name && [...this.members.values()].some(value => value.key === name!.key)) { nameUnavailable = true; name = undefined; }
            while (!name) { const generated = chatName(`访客-${id().slice(0, 6)}`)!; if (![...this.members.values()].some(value => value.key === generated.key)) name = generated; }
            secret = token(); member = { id: id(), ...name, generation: 1, joinedAt: Date.now(), lastSeen: Date.now(), sourceHash, tokenHash: digest(secret), rate: { count: 0, resetAt: Date.now() + 60000 }, receipts: [] };
            this.members.set(member.id, member); await this.persist(member); await this.membersChanged();
          } else { member.lastSeen = Date.now(); member.generation++; await this.persist(member); }
          await this.schedule(); return json({ sessionToken: secret, generation: member.generation, nameUnavailable, snapshot: this.snapshot(member) }, 201);
        }
        if (route === '/leave' && method === 'POST') {
          const data = await readJson(request, 1024), secret = bearer(request) || data.token;
          assert(typeof secret === 'string' && /^[a-f0-9]{64}$/.test(secret), 401, 'chat_session_expired', '聊天室会话无效');
          const member = this.find(secret);
          assert(data.generation === undefined || typeof data.generation === 'number' && Number.isSafeInteger(data.generation) && data.generation >= 1, 400, 'invalid_chat_generation', '会话版本无效');
          if (member && (data.generation === undefined || data.generation === member.generation)) { await this.remove(member); await this.membersChanged(); }
          await this.schedule(); return json({ ok: true });
        }
        if (route === '/ws' && method === 'GET') {
          assert(request.headers.get('Upgrade')?.toLowerCase() === 'websocket', 400, 'upgrade_required', '需要 WebSocket 握手');
          const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(part => part.trim()) ?? [];
          assert(protocols.includes('chat'), 401, 'chat_session_expired', '聊天室连接协议无效');
          const secret = protocols.find(part => /^token\.[a-f0-9]{64}$/.test(part))?.slice(6), member = secret ? this.find(secret) : undefined;
          assert(member, 401, 'chat_session_expired', '聊天室会话已过期');
          assert(this.ctx.getWebSockets(member.id).length < 4, 429, 'chat_socket_limit', '此会话的连接数量过多');
          member.lastSeen = Date.now(); await this.persist(member);
          const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1], [member.id]); pair[1].serializeAttachment({ memberId: member.id });
          pair[1].send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot(member) } satisfies ChatEvent));
          await this.schedule(); return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'chat' } });
        }
        const member = this.authenticate(request); member.lastSeen = Date.now();
        if (route === '/state' && method === 'GET' || route === '/heartbeat' && method === 'POST') {
          const since = method === 'GET' ? Number(url.searchParams.get('since') ?? -1) : (await readJson(request, 1024)).revision;
          await this.persist(member); await this.schedule();
          return json({ revision: this.meta.revision, snapshot: since === this.meta.revision ? null : this.snapshot(member), self: this.publicMember(member) });
        }
        if (route === '/name' && method === 'POST') {
          const data = await readJson(request, 1024), name = chatName(data.name);
          assert(name, 400, 'invalid_chat_name', '用户名须为 1–20 个可见字符，不能包含控制字符或尖括号');
          assert(![...this.members.values()].some(value => value.id !== member.id && value.key === name.key), 409, 'chat_name_taken', '这个用户名已有人在线使用，请换一个');
          this.rate(member); Object.assign(member, name); await this.persist(member); await this.membersChanged(); await this.schedule();
          return json({ self: this.publicMember(member) });
        }
        if (route === '/messages' && method === 'POST') {
          const data = await readJson(request, limits(this.env).controlMaxBytes);
          assert(typeof data.nonce === 'string' && ID_PATTERN.test(data.nonce), 400, 'chat_nonce_required', '消息须包含有效请求标识');
          const receipt = member.receipts.find(value => value.nonce === data.nonce);
          if (receipt) return json({ message: this.messages.find(value => value.id === receipt.messageId) ?? null, duplicate: true });
          assert(data.text === undefined || typeof data.text === 'string', 400, 'invalid_chat_message', '消息内容必须为文本');
          const text = (typeof data.text === 'string' ? data.text : '').replace(/\r\n?/g, '\n').trim();
          assert(Array.from(text).length <= limits(this.env).chatMessageChars && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), 400, 'invalid_chat_message', '消息过长或包含无效字符');
          assert(text || data.shareId, 400, 'empty_chat_message', '请输入消息或选择文件');
          this.rate(member);
          const attachment = data.shareId === undefined ? undefined : await this.attachment(data);
          const message: ChatMessage = { id: id(), sequence: this.meta.revision + 1, nonce: data.nonce, authorId: member.id, authorName: member.name, createdAt: Date.now(), text, ...(attachment ? { attachment } : {}) };
          this.messages.push(message); member.receipts.push({ nonce: data.nonce, messageId: message.id }); member.receipts = member.receipts.slice(-32);
          await this.ctx.storage.put({ [`message:${message.id}`]: message, [`member:${member.id}`]: member });
          await this.emit({ type: 'message', revision: ++this.meta.revision, message }); await this.prune(); await this.schedule(); return json({ message }, 201);
        }
        throw new HttpError(404, 'not_found', '聊天室接口不存在');
      } catch (error) { return errorResponse(error); }
    });
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    // Ordinary chat writes use authenticated HTTP so retries have the same nonce.
    if (message === 'chat-ping') { socket.send('chat-pong'); return; }
    socket.close(typeof message === 'string' ? 1008 : 1003, 'use chat HTTP API');
  }
  async webSocketClose(_socket: WebSocket) { await this.ctx.blockConcurrencyWhile(async () => { await this.prune(); await this.schedule(); }); }
  async webSocketError(socket: WebSocket) { await this.webSocketClose(socket); }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => { await budget(this.env, '/do-used', { count: 1 }).catch(() => {}); await this.prune(); await this.schedule(); });
  }
}
