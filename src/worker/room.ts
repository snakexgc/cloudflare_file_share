import { DurableObject } from 'cloudflare:workers';
import type { ControlEvent, DownloadRequest, FileInfo, Mode, PeerLink, SessionInfo, ShareInfo, UploadAttempt } from '../shared/types';
import { validAdmin } from './admin';
import { chooseMultipartPartSize, decodeFrame, ID_PATTERN, SHA256_PATTERN, SINGLE_PUT_MAX_BYTES, urlTtl, validateFrame } from '../shared/protocol';
import { limits, type Env } from './config';
import { assert, bearer, budget, constantEqual, digest, errorResponse, HttpError, id, json, readJson, safeCapabilities, token } from './util';
import { findMultipartUploads, listParts, presign, r2Configured, validateParts } from './r2';
import { generateTurn, revokeTurn } from './turn';
import { meteredDB } from './db';
import { closeHttpsRoom, HttpsRelay } from './https-relay';

interface StoredFile extends FileInfo { r2Key?: string; modeAdminHash?: string }
interface Room {
  id: string;
  ownerTokenHash: string;
  sourceHash: string;
  createdAt: number;
  expiresAt: number;
  status: ShareInfo['status'];
  cleanupStatus: ShareInfo['cleanupStatus'];
  cleanedAt?: number;
  files: StoredFile[];
  requests: DownloadRequest[];
  uploads: UploadAttempt[];
  pendingRevocations: { usernames: string[]; expiresAt: number; reservationId?: string }[];
  nextCleanupAt?: number;
  peers?: PeerLink[];
  r2AdminHash?: string;
}
interface Relay { requestId: string; sent: number; acked: number; ready: boolean; lastAck: number; bytes: number; messages: number }
const active = (r: DownloadRequest) => !['completed', 'canceled', 'failed'].includes(r.status);

export class ShareRoom extends DurableObject<Env> {
  private room?: Room;
  private sessions = new Map<string, SessionInfo>();
  private dirty = new Set<string>();
  private relays = new Map<string, Relay>();
  private httpsRelays = new Map<string, HttpsRelay>();
  private relayTimer?: ReturnType<typeof setTimeout>;
  private retired = new Map<string, { ownerId: string; fileId: string; epoch: number; size: number; remaining: number; until: number }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, DB: meteredDB(env.DB, env) });
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get<Room>('room');
      if (this.room) closeHttpsRoom(this.room.id);
      if (this.room?.uploads.some(attempt => !Object.hasOwn(attempt, 'partSize'))) {
        // 首次升级 v1 状态时固定当时的分片大小；v1 默认是 64 MiB。
        const previousPartSize = JSON.parse(env.LIMITS ?? '{}').multipartPartBytes ?? 64 * 1024 ** 2;
        for (const attempt of this.room.uploads) {
          if (!Object.hasOwn(attempt, 'partSize')) attempt.partSize = attempt.mode === 'multipart' ? previousPartSize : this.file(attempt.fileId).size;
        }
        await ctx.storage.put('room', this.room);
      }
      const entries = await ctx.storage.list<SessionInfo>({ prefix: 'session:' });
      for (const session of entries.values()) this.sessions.set(session.id, session);
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    });
  }
  private state() { assert(this.room, 404, 'share_not_found', '分享不存在'); return this.room; }
  private file(fileId: string) { const file = this.state().files.find(x => x.id === fileId); assert(file && !file.deleted, 404, 'file_not_found', '文件不存在或已被管理员删除'); return file; }
  private socket(sessionId: string) { return this.ctx.getWebSockets(sessionId).find(x => x.readyState === WebSocket.OPEN); }
  private seenAt(session: SessionInfo) {
    let at = session.lastSeen;
    for (const socket of this.ctx.getWebSockets(session.id)) at = Math.max(at, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0);
    return at;
  }
  private online(session: SessionInfo) { return Date.now() - this.seenAt(session) < limits(this.env).leaseMs; }
  private owner(fileId?: string) {
    return [...this.sessions.values()].filter(s => s.role === 'owner' && this.online(s) && (!fileId || s.capabilities.readable.includes(fileId))).sort((a, b) => this.seenAt(b) - this.seenAt(a))[0];
  }
  private snapshot(): ShareInfo {
    const state = this.state(), owner = this.owner();
    return { id: state.id, createdAt: state.createdAt, expiresAt: state.expiresAt, status: state.status === 'active' && Date.now() >= state.expiresAt ? 'expired' : state.status,
      cleanupStatus: state.cleanupStatus, ownerStatus: !owner ? 'offline' : owner.capabilities.readable.length ? 'online' : 'file_unavailable',
      activeRequests: state.requests.filter(active).length, files: state.files.filter(x => !x.deleted).map(({ r2Key: _r2Key, modeAdminHash: _modeAdminHash, ...file }) => file) };
  }
  private ensureActive() {
    const state = this.state();
    if (state.status !== 'active' || Date.now() >= state.expiresAt) throw new HttpError(410, 'share_expired', state.status === 'revoked' ? '分享已撤销' : '分享已过期', { share: this.snapshot() });
  }
  private session(request: Request, allowExpired = false) {
    if (!allowExpired) this.ensureActive();
    const hash = digest(bearer(request));
    const session = [...this.sessions.values()].find(s => constantEqual(s.tokenHash, hash));
    assert(session, 403, 'session_forbidden', '控制会话无效，请重新连接');
    session.lastSeen = Date.now(); this.dirty.add(session.id);
    const admin = request.headers.get('X-File-Share-Admin');
    if (admin) { session.adminHash = admin; if (session.role === 'owner') this.state().r2AdminHash = admin; }
    return session;
  }
  private ownerAuth(request: Request, allowExpired = false) {
    if (!allowExpired) this.ensureActive();
    const hash = digest(bearer(request));
    if (constantEqual(this.state().ownerTokenHash, hash)) return this.owner();
    const session = this.session(request, allowExpired);
    assert(session.role === 'owner', 403, 'owner_forbidden', '此操作需要管理令牌');
    return session;
  }
  private send(sessionId: string, data: unknown) {
    const socket = this.socket(sessionId);
    if (socket) { try { socket.send(JSON.stringify(data)); } catch { socket.close(1011, 'control send failed'); } }
  }
  private publicTask(task: DownloadRequest): DownloadRequest { const { adminGrant: _grant, ...publicTask } = task; return publicTask; }
  private emit(sessionId: string | undefined, type: string, request?: DownloadRequest, data?: unknown) {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const conf = limits(this.env), now = Date.now();
    const event: ControlEvent = { seq: ++session.seq, eventId: id(), type, request: request ? structuredClone(this.publicTask(request)) : undefined, data, createdAt: now };
    session.events = session.events.filter(x => now - x.createdAt < conf.eventTtlMs);
    session.events.push(event);
    while (session.events.length > conf.eventQueueSize || new TextEncoder().encode(JSON.stringify(session.events)).byteLength > conf.eventQueueBytes) session.events.shift();
    this.dirty.add(session.id);
    // HTTPS tasks are discovered and coordinated through HTTP, even with a WS open for another file.
    if (request?.mode !== 'https') this.send(session.id, { type: 'event', event });
  }
  private both(type: string, request: DownloadRequest, data?: unknown) { this.emit(request.ownerId, type, request, data); this.emit(request.receiverId, type, request, data); }
  private scheduleRelayDeadline() {
    clearTimeout(this.relayTimer); this.relayTimer = undefined;
    if (!this.relays.size && !this.httpsRelays.size) return;
    const deadline = Math.min(this.state().expiresAt, ...[...this.relays.values(), ...this.httpsRelays.values()].map(relay => relay.lastAck + limits(this.env).ackTimeoutMs));
    // 活跃中继不能休眠，否则内存中的 credit / offset 会在大消息到达前丢失。
    this.relayTimer = setTimeout(() => {
      this.relayTimer = undefined;
      void this.ctx.blockConcurrencyWhile(async () => { await this.sweep(); await this.persist(); }).catch(error => {
        console.error(JSON.stringify({ type: 'relay-deadline', message: error instanceof Error ? error.message : 'unknown' }));
        this.scheduleRelayDeadline();
      });
    }, Math.max(1000, deadline - Date.now()));
  }
  private async persist() {
    if (this.room) await this.ctx.storage.put('room', this.room);
    const updates: Record<string, SessionInfo> = {};
    for (const key of this.dirty) { const value = this.sessions.get(key); if (value) updates[`session:${key}`] = value; }
    if (Object.keys(updates).length) await this.ctx.storage.put(updates);
    this.dirty.clear();
    await this.schedule();
    this.scheduleRelayDeadline();
  }
  private async schedule() {
    if (!this.room) return;
    const now = Date.now(), state = this.room, conf = limits(this.env);
    const times: number[] = [];
    if (state.status === 'active') times.push(state.expiresAt);
    if (state.nextCleanupAt) times.push(state.nextCleanupAt);
    for (const relay of this.relays.values()) times.push(relay.lastAck + conf.ackTimeoutMs);
    for (const relay of this.httpsRelays.values()) times.push(relay.lastAck + conf.ackTimeoutMs);
    for (const request of state.requests.filter(active)) {
      for (const key of [request.ownerId, request.receiverId]) { const session = key ? this.sessions.get(key) : undefined; if (session) times.push(this.seenAt(session) + conf.leaseMs); }
    }
    for (const upload of state.uploads) {
      if (upload.status === 'paused' && upload.pausedUntil) times.push(upload.pausedUntil);
      if (['canceled', 'failed', 'aborted'].includes(upload.status)) times.push(Math.min(upload.recheckUntil, now + 60000));
    }
    for (const revocation of state.pendingRevocations) times.push(Math.min(revocation.expiresAt, now + 60000));
    if (state.cleanupStatus === 'cleaned' && state.cleanedAt) times.push(state.cleanedAt + conf.tombstoneMs);
    const future = times.filter(time => time > now);
    if (future.length) await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...future)));
    else if (state.status === 'active' && state.requests.some(active)) await this.ctx.storage.setAlarm(Math.min(state.expiresAt, now + conf.leaseMs));
    else await this.ctx.storage.deleteAlarm();
  }
  private requestFor(requestId: string, session: SessionInfo, epoch?: unknown) {
    const task = this.state().requests.find(x => x.id === requestId);
    assert(task && (task.receiverId === session.id || task.ownerId === session.id), 403, 'request_forbidden', '不能操作其他会话的下载任务');
    if (epoch !== undefined) assert(epoch === task.epoch, 409, 'stale_epoch', '传输已切换，请同步新任务');
    return task;
  }
  private async saveFile(file: StoredFile) {
    await this.env.DB.prepare('UPDATE files SET sha256 = ?, r2_key = ?, upload_status = ? WHERE id = ? AND share_id = ?').bind(file.sha256 ?? null, file.r2Key ?? null, file.uploadStatus, file.id, this.state().id).run();
  }
  private async retireTransport(task: DownloadRequest) {
    if (task.mode === 'https') {
      const relay = this.httpsRelays.get(task.transferId);
      this.httpsRelays.delete(task.transferId); relay?.close(task.error ?? 'HTTPS 传输已停止');
      const bytes = Math.max(task.httpsBytes ?? 0, relay?.bytes ?? 0);
      if (task.reservationId) await budget(this.env, '/settle', { id: task.reservationId, bytes, activeMs: Math.max(0, Date.now() - (task.httpsStartedAt ?? Date.now())) });
      console.log(JSON.stringify({ type: 'https-relay', requestId: task.id, bytes, durationMs: Math.max(0, Date.now() - (task.httpsStartedAt ?? Date.now())), reason: task.error ?? task.status }));
      delete task.httpsStartedAt; delete task.httpsBytes; delete task.httpsChunkBytes;
      this.scheduleRelayDeadline();
    }
    if (task.mode === 'ws' && task.ownerId) {
      for (const [key, entry] of this.retired) if (entry.until <= Date.now()) this.retired.delete(key);
      this.retired.set(task.transferId, { ownerId: task.ownerId, fileId: task.fileId, epoch: task.epoch, size: this.file(task.fileId).size, remaining: limits(this.env).windowBytes, until: Date.now() + limits(this.env).leaseMs });
      if (this.retired.size > 128) this.retired.delete(this.retired.keys().next().value!);
    }
    const relay = this.relays.get(task.transferId);
    if (relay) {
      this.relays.delete(task.transferId);
      this.scheduleRelayDeadline();
      if (task.reservationId) await budget(this.env, '/settle', { id: task.reservationId, bytes: relay.bytes, messages: relay.messages });
      console.log(JSON.stringify({ type: 'ws-relay', requestId: task.id, bytes: relay.bytes, messages: relay.messages, durationMs: Date.now() - task.createdAt, reason: task.error ?? task.status }));
    } else if (task.mode === 'ws' && task.reservationId) await budget(this.env, '/settle', { id: task.reservationId });
    if (task.turnUsernames?.length) {
      const entry = { usernames: task.turnUsernames, expiresAt: task.turnExpiresAt ?? this.state().expiresAt, reservationId: task.reservationId };
      this.state().pendingRevocations.push(entry);
      // 先保存撤销清单，再进行跨服务操作，避免重启后丢失撤销线索。
      await this.ctx.storage.put('room', this.state());
      try {
        await revokeTurn(this.env, entry.usernames);
        if (entry.reservationId) await budget(this.env, '/settle', { id: entry.reservationId });
        this.state().pendingRevocations = this.state().pendingRevocations.filter(x => x !== entry);
      } catch { /* Alarm 与 cron 继续重试；预算保守保持预留。 */ }
    }
    delete task.turnUsernames; delete task.turnExpiresAt; delete task.reservationId; delete task.iceServers;
  }
  private async chooseRelayOrR2(task: DownloadRequest) {
    const conf = limits(this.env), file = this.file(task.fileId), owner = this.owner(file.id), receiver = this.sessions.get(task.receiverId);
    if (conf.wsEnabled && file.size <= conf.wsMaxFileBytes && owner && receiver && owner.capabilities.ws && receiver.capabilities.ws && this.socket(owner.id) && this.socket(receiver.id) && this.relayWindowBytes() + conf.windowBytes <= conf.roomBufferBytes) {
      const reservationId = `ws:${task.id}:${task.epoch}`;
      try {
        const messages = Math.ceil((file.size - task.offset) / conf.chunkBytes) * 2 + 16;
        await budget(this.env, '/reserve', { id: reservationId, kind: 'ws', bytes: file.size - task.offset, messages, roomId: this.state().id, expiresAt: this.state().expiresAt });
        task.mode = 'ws'; task.ownerId = owner.id; task.transferId = id(); task.reservationId = reservationId; task.status = 'connecting';
        this.relays.set(task.transferId, { requestId: task.id, sent: task.offset, acked: task.offset, ready: false, lastAck: Date.now(), bytes: 0, messages: 0 });
        this.both('attempt', task);
        return;
      } catch (error) { task.error = error instanceof Error ? error.message : 'WS 预算不足'; }
    }
    if (task.forcedMode === 'ws') { task.status = 'failed'; task.error = '指定的 WS 不可用'; this.both('failed', task); return; }
    if (await this.startHttps(task)) return;
    await this.startR2(task);
  }
  private relayWindowBytes() { return this.relays.size * limits(this.env).windowBytes + [...this.httpsRelays.values()].reduce((sum, relay) => sum + relay.bufferBytes, 0); }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    // A rejection escaping blockConcurrencyWhile resets the object, including unrelated transfers.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { value: await operation() }; } catch (error) { return { error }; }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }
  private async startHttps(task: DownloadRequest): Promise<boolean> {
    const conf = limits(this.env), file = this.file(task.fileId), owner = this.owner(file.id), receiver = this.sessions.get(task.receiverId);
    if (task.forcedMode === 'https') task.mode = 'https';
    let relay: HttpsRelay | undefined;
    if (conf.httpsEnabled && file.size <= conf.httpsMaxFileBytes && owner?.capabilities.https && receiver?.capabilities.https && this.relayWindowBytes() + Math.min(conf.httpsChunkBytes, file.size - task.offset) <= conf.roomBufferBytes) {
      const transferId = id(), reservationId = `https:${task.id}:${task.epoch}`;
      try {
        relay = new HttpsRelay(file.size, task.offset, conf.httpsChunkBytes,
          () => this.locked(async () => {
            this.ensureActive(); assert(active(task) && task.mode === 'https' && task.transferId === transferId && this.httpsRelays.get(transferId) === relay, 409, 'stale_transfer', 'HTTPS 传输已切换');
            assert(this.online(owner) && this.online(receiver), 503, 'relay_disconnected', 'HTTPS 对端会话已离线');
            task.status = 'transferring'; await this.persist();
          }),
          count => this.locked(async () => {
            if (task.transferId !== transferId || this.httpsRelays.get(transferId) !== relay) return;
            task.httpsBytes = (task.httpsBytes ?? 0) + count; await this.ctx.storage.put('room', this.state());
          }), this.state().id);
        await budget(this.env, '/reserve', { id: reservationId, kind: 'https', bytes: 0, roomId: this.state().id, expiresAt: this.state().expiresAt });
        this.ensureActive(); task.mode = 'https'; task.ownerId = owner.id; task.transferId = transferId; task.reservationId = reservationId;
        task.httpsChunkBytes = conf.httpsChunkBytes; task.httpsBytes = 0; task.httpsStartedAt = Date.now(); task.status = 'connecting'; delete task.sourceHash;
        this.httpsRelays.set(transferId, relay); this.both('attempt', task); return true;
      } catch (error) { relay?.close(); await budget(this.env, '/release', { id: reservationId }); task.error = error instanceof Error ? error.message : 'HTTPS 中继不可用'; }
    }
    if (task.forcedMode === 'https') { task.status = 'failed'; task.error ??= '指定的 HTTPS 中继不可用'; this.both('failed', task); }
    return false;
  }
  private async r2Allowed(task: DownloadRequest) {
    const hashes = [task.adminGrant, this.state().r2AdminHash, this.sessions.get(task.receiverId)?.adminHash, task.ownerId ? this.sessions.get(task.ownerId)?.adminHash : undefined, this.owner(task.fileId)?.adminHash];
    for (const hash of new Set(hashes)) if (await validAdmin(this.env, hash)) { task.adminGrant = hash; return true; }
    return false;
  }
  private async r2Demand(fileId: string) {
    for (const task of this.state().requests.filter(x => x.fileId === fileId && active(x) && x.mode === 'r2')) if (await this.r2Allowed(task)) return true;
    return false;
  }
  private setMode(file: StoredFile, mode: unknown, hash: string) {
    assert(['auto', 'p2p', 'turn', 'ws', 'https', 'r2'].includes(String(mode)), 400, 'invalid_mode', '传输方式无效');
    file.forcedMode = mode === 'auto' ? undefined : mode as Mode; file.modeAdminHash = hash;
    for (const task of this.state().requests.filter(x => x.fileId === file.id && active(x))) this.emit(task.receiverId, 'mode-change', task, { mode });
  }
  private async startR2(task: DownloadRequest) {
    const file = this.file(task.fileId);
    if (!await this.r2Allowed(task) || !limits(this.env).r2Enabled || !r2Configured(this.env)) { task.status = 'failed'; task.error = '在线传输方式均不可用，R2 需要有效管理员登录'; this.both('failed', task); return; }
    task.mode = 'r2'; task.offset = 0; task.transferId = id(); task.status = file.uploadStatus === 'ready' ? 'transferring' : 'requested';
    this.both('attempt', task);
    if (file.uploadStatus === 'ready') this.emit(task.receiverId, 'r2-ready', task);
    else this.emit(task.ownerId, 'upload-needed', task, { fileId: file.id });
  }
  private async activate(task: DownloadRequest) {
    const file = this.file(task.fileId), owner = this.owner(file.id), receiver = this.sessions.get(task.receiverId);
    if (file.forcedMode && await validAdmin(this.env, file.modeAdminHash)) { task.forcedMode ??= file.forcedMode; task.adminGrant ??= file.modeAdminHash; }
    if (task.forcedMode === 'r2') { task.ownerId = owner?.id; await this.startR2(task); return; }
    if (!task.forcedMode && !owner && file.uploadStatus === 'ready' && await this.r2Allowed(task)) { await this.startR2(task); return; }
    if (!owner || !receiver) { task.status = 'requested'; this.emit(task.receiverId, 'waiting-source', task); return; }
    task.ownerId = owner.id;
    if (task.forcedMode === 'https') { await this.startHttps(task); return; }
    if (task.forcedMode === 'ws') { await this.chooseRelayOrR2(task); return; }
    if (task.forcedMode === 'turn') { await this.startTurn(task); return; }
    if (task.forcedMode === 'p2p' && (!owner.capabilities.webrtc || !receiver.capabilities.webrtc)) { task.status = 'failed'; task.error = '指定的 P2P 不可用，浏览器未提供 WebRTC'; this.both('failed', task); return; }
    const peer = this.state().peers?.find(p => p.ownerId === owner.id && p.receiverId === receiver.id && p.ownerReady && p.receiverReady);
    if (peer) task.peerId = peer.id; else delete task.peerId;
    if (owner.capabilities.webrtc && receiver.capabilities.webrtc) { task.mode = 'p2p'; task.status = 'connecting'; this.both('attempt', task); }
    else await this.chooseRelayOrR2(task);
  }
  private async advance(task: DownloadRequest, offset: unknown, reason: string) {
    assert(active(task), 409, 'request_finished', '此下载任务已经结束');
    const file = this.file(task.fileId), previous = task.mode;
    assert(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= file.size, 400, 'invalid_offset', '恢复偏移无效');
    await this.retireTransport(task);
    task.epoch++; task.offset = offset; task.transferId = id(); task.error = reason.slice(0, 200);
    delete task.peerId;
    this.both('stop-attempt', task, { previous });
    if (task.forcedMode) { task.status = 'failed'; this.both('failed', task); await this.noDemand(file.id); return; }
    if (!this.owner(file.id) && file.uploadStatus !== 'ready') { task.status = 'requested'; this.emit(task.receiverId, 'waiting-source', task); return; }
    if (previous === 'r2') { task.status = 'failed'; this.both('failed', task); await this.noDemand(file.id); return; }
    if (previous === 'p2p' && await this.startTurn(task)) return;
    if (previous === 'p2p' || previous === 'turn') await this.chooseRelayOrR2(task);
    else if (previous === 'ws' && await this.startHttps(task)) return;
    else await this.startR2(task);
  }
  private async startTurn(task: DownloadRequest): Promise<boolean> {
    const file = this.file(task.fileId), offset = task.offset;
    if (this.owner(file.id)?.capabilities.webrtc && this.sessions.get(task.receiverId)?.capabilities.webrtc && limits(this.env).turnEnabled && file.size - offset <= limits(this.env).turnMaxFileBytes && this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN) {
      const reservationId = `turn:${task.id}:${task.epoch}`, conf = limits(this.env);
      const ttl = urlTtl(this.state().expiresAt, conf.turnCredentialSeconds);
      try {
        await budget(this.env, '/reserve', { id: reservationId, kind: 'turn', bytes: Math.ceil((file.size - offset) * 2.6) + 1048576, expiresAt: Date.now() + ttl * 1000 });
        task.reservationId = reservationId;
        await this.ctx.storage.put('room', this.state());
        task.iceServers = await generateTurn(this.env, ttl);
        task.turnUsernames = task.iceServers.map(x => x.username!); task.turnExpiresAt = Date.now() + ttl * 1000;
        task.mode = 'turn'; task.status = 'connecting'; task.ownerId = this.owner(file.id)!.id;
        this.ensureActive(); this.both('attempt', task); return true;
      } catch (error) {
        if (task.turnUsernames?.length) await this.retireTransport(task);
        else await budget(this.env, '/release', { id: reservationId });
        delete task.reservationId; task.error = error instanceof Error ? error.message : 'TURN 失败';
        this.ensureActive();
      }
    }
    if (task.forcedMode === 'turn') { task.status = 'failed'; task.error ??= '指定的 TURN 不可用'; this.both('failed', task); }
    return false;
  }
  private async noDemand(fileId: string) {
    if (this.state().requests.some(r => r.fileId === fileId && active(r))) return;
    const attempt = this.state().uploads.find(x => x.fileId === fileId && x.status === 'uploading');
    if (!attempt) return;
    if (attempt.mode === 'multipart') {
      attempt.status = 'paused'; attempt.pausedUntil = Math.min(this.state().expiresAt, Date.now() + limits(this.env).multipartPauseMs);
      this.file(fileId).uploadStatus = 'paused';
      await this.updateAttempt(attempt); await this.saveFile(this.file(fileId));
      this.emit(attempt.ownerSessionId, 'upload-pause', undefined, { fileId, attemptId: attempt.id });
    } else {
      this.emit(attempt.ownerSessionId, 'upload-cancel', undefined, { fileId, attemptId: attempt.id });
      await this.abortUpload(attempt);
    }
  }
  private async cancelTask(task: DownloadRequest, reason: string) {
    task.status = 'canceled'; task.error = reason;
    await this.retireTransport(task); this.both('canceled', task); await this.noDemand(task.fileId);
  }
  private async updateAttempt(attempt: UploadAttempt) {
    await this.env.DB.prepare('UPDATE upload_attempts SET owner_session_id = ?, upload_id = ?, status = ?, signed_until = ?, recheck_until = ?, paused_until = ? WHERE id = ?').bind(attempt.ownerSessionId, attempt.uploadId ?? null, attempt.status, attempt.signedUntil, attempt.recheckUntil, attempt.pausedUntil ?? null, attempt.id).run();
  }
  private async abortUpload(attempt: UploadAttempt) {
    if (attempt.status === 'ready') return;
    if (['canceled', 'failed', 'aborted'].includes(attempt.status)) { await this.cleanAttempt(attempt); return; }
    attempt.status = 'canceled'; attempt.pausedUntil = undefined;
    attempt.recheckUntil = Math.max(attempt.signedUntil, Math.min(Date.now(), this.state().expiresAt)) + (attempt.signedUntil ? limits(this.env).lateCleanupGraceMs : 0);
    const file = this.state().files.find(x => x.id === attempt.fileId)!;
    if (file.uploadStatus !== 'ready') file.uploadStatus = 'canceled';
    await this.updateAttempt(attempt); await this.saveFile(file);
    await this.env.DB.prepare('INSERT OR REPLACE INTO cleanup_tasks (id, share_id, target_type, target_key, upload_id, next_retry_at) VALUES (?, ?, ?, ?, ?, ?)').bind(attempt.id, this.state().id, attempt.mode, attempt.key, attempt.uploadId ?? null, Date.now()).run();
    await this.ctx.storage.put('room', this.state());
    await this.cleanAttempt(attempt);
  }
  private async cleanAttempt(attempt: UploadAttempt) {
    try {
      const uploadIds = attempt.uploadId ? [attempt.uploadId] : attempt.mode === 'multipart' ? await findMultipartUploads(this.env, attempt.key) : [];
      for (const uploadId of uploadIds) {
        try { await this.env.BUCKET.resumeMultipartUpload(attempt.key, uploadId).abort(); }
        catch (error) { if (!/NoSuchUpload|does not exist|not found|already (?:completed|aborted)/i.test(String(error))) throw error; }
      }
      await this.env.BUCKET.delete(attempt.key);
      await budget(this.env, '/r2-operation', { kind: 'B', cleanup: true });
      const head = await this.env.BUCKET.head(attempt.key);
      assert(!head, 503, 'cleanup_pending', '对象尚未删除');
      // 保留对象 key 到分享过期后，cron 持续复核取消后迟到的 PUT。
      if (Date.now() >= attempt.recheckUntil) {
        await budget(this.env, '/release', { id: attempt.reservationId });
        if (Date.now() >= this.state().expiresAt + limits(this.env).lateCleanupGraceMs) await this.env.DB.prepare('DELETE FROM cleanup_tasks WHERE id = ?').bind(attempt.id).run();
        else await this.env.DB.prepare('UPDATE cleanup_tasks SET next_retry_at = ?, last_error = NULL WHERE id = ?').bind(Date.now() + 300000, attempt.id).run();
        attempt.status = 'aborted';
      } else await this.env.DB.prepare('UPDATE cleanup_tasks SET attempts = attempts + 1, next_retry_at = ?, last_error = NULL WHERE id = ?').bind(Date.now() + 60000, attempt.id).run();
    } catch (error) {
      attempt.status = 'canceled';
      await this.env.DB.prepare('UPDATE cleanup_tasks SET attempts = attempts + 1, next_retry_at = ?, last_error = ? WHERE id = ?').bind(Date.now() + 60000, String(error).slice(0, 300), attempt.id).run();
    }
    await this.updateAttempt(attempt);
  }
  private async uploads(fileId: string, session: SessionInfo) {
    this.ensureActive();
    const file = this.file(fileId), conf = limits(this.env);
    assert(session.role === 'owner' && session.capabilities.readable.includes(fileId), 403, 'source_unavailable', '请重新选择并验证原文件');
    assert(await this.r2Demand(fileId), 403, 'r2_admin_required', 'R2 需要有效管理员登录及下载需求');
    if (file.uploadStatus === 'ready') return json({ ready: true });
    assert(conf.r2Enabled && r2Configured(this.env), 503, 'r2_not_configured', 'R2 直传尚未配置，请联系服务管理员');
    let attempt = this.state().uploads.find(x => x.fileId === fileId && ['uploading', 'paused'].includes(x.status));
    if (attempt?.mode === 'multipart' && !attempt.uploadId) { await this.abortUpload(attempt); attempt = undefined; }
    if (attempt) {
      const previousOwner = this.sessions.get(attempt.ownerSessionId);
      if (attempt.ownerSessionId !== session.id && previousOwner && this.online(previousOwner)) return json({ shared: true, attemptId: attempt.id });
      if (attempt.mode === 'put' && attempt.ownerSessionId !== session.id) { await this.abortUpload(attempt); attempt = undefined; }
      else { attempt.ownerSessionId = session.id; attempt.status = 'uploading'; attempt.pausedUntil = undefined; }
    }
    if (!attempt) {
      assert(this.state().uploads.length < 128, 429, 'upload_attempt_limit', '此分享的上传重试次数已达上限');
      const attemptId = id(), key = `temporary/${this.state().id}/${file.id}/${attemptId}`, reservationId = `r2:${attemptId}`;
      await budget(this.env, '/reserve', { id: reservationId, kind: 'r2', bytes: file.size, expiresAt: this.state().expiresAt + conf.lateCleanupGraceMs });
      attempt = { id: attemptId, fileId, ownerSessionId: session.id, mode: file.size <= SINGLE_PUT_MAX_BYTES ? 'put' : 'multipart', partSize: file.size <= SINGLE_PUT_MAX_BYTES ? file.size : chooseMultipartPartSize(file.size, conf.multipartPartBytes), key, createdAt: Date.now(), status: 'uploading', signedUntil: 0, recheckUntil: this.state().expiresAt + conf.lateCleanupGraceMs, reservationId };
      // 必须在产生 R2 对象/会话之前登记对象 key 与预算。
      try {
        await this.env.DB.prepare('INSERT INTO upload_attempts (id, file_id, share_id, owner_session_id, mode, r2_key, created_at, status, recheck_until, reservation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(attempt.id, file.id, this.state().id, session.id, attempt.mode, key, attempt.createdAt, 'uploading', attempt.recheckUntil, reservationId).run();
        this.state().uploads.push(attempt); await this.ctx.storage.put('room', this.state());
        if (attempt.mode === 'multipart') {
          await budget(this.env, '/r2-operation', { kind: 'A' });
          const upload = await this.env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: file.mime } });
          attempt.uploadId = upload.uploadId; await this.updateAttempt(attempt); await this.ctx.storage.put('room', this.state());
        }
      } catch (error) { await this.abortUpload(attempt); throw error; }
    }
    file.uploadStatus = 'uploading'; await this.saveFile(file);
    if (attempt.mode === 'put') {
      await budget(this.env, '/r2-operation', { kind: 'A' });
      const auth = await presign(this.env, attempt.key, 'PUT', this.state().expiresAt, { mime: file.mime, size: file.size });
      attempt.signedUntil = Math.max(attempt.signedUntil, auth.signedUntil); await this.updateAttempt(attempt);
      return json({ attemptId: attempt.id, mode: attempt.mode, url: auth.url, headers: auth.headers, partSize: attempt.partSize, uploadedParts: [] });
    }
    assert(attempt.uploadId, 409, 'multipart_initializing', 'Multipart 会话尚未初始化，请重试');
    const parts = await listParts(this.env, attempt.key, attempt.uploadId); validateParts(parts, file.size, attempt.partSize, false);
    await this.updateAttempt(attempt);
    return json({ attemptId: attempt.id, mode: 'multipart', partSize: attempt.partSize, uploadedParts: parts });
  }
  private uploadAttempt(fileId: string, attemptId: unknown) {
    const attempt = this.state().uploads.find(x => x.id === attemptId && x.fileId === fileId);
    assert(attempt, 404, 'upload_not_found', '上传尝试不存在'); return attempt;
  }
  private async completeUpload(fileId: string, attemptId: unknown, sha256: unknown) {
    const attempt = this.uploadAttempt(fileId, attemptId), file = this.file(fileId);
    if (this.state().status !== 'active' || Date.now() >= this.state().expiresAt) { await this.abortUpload(attempt); this.ensureActive(); }
    assert(typeof sha256 === 'string' && SHA256_PATTERN.test(sha256), 400, 'hash_required', '必须提交完整源文件 SHA-256');
    if (attempt.status === 'ready') { this.ensureActive(); assert(file.sha256 === sha256, 409, 'hash_mismatch', '源文件哈希不一致'); return json({ ready: true }); }
    this.ensureActive();
    assert(await this.r2Demand(fileId), 403, 'r2_admin_required', 'R2 管理员授权已失效');
    assert(attempt.status === 'uploading', 409, 'upload_canceled', '此上传已取消或暂停');
    assert(!file.sha256 || file.sha256 === sha256, 409, 'source_changed', '源文件内容与原分享不一致');
    if (attempt.mode === 'multipart') {
      const parts = await listParts(this.env, attempt.key, attempt.uploadId!); validateParts(parts, file.size, attempt.partSize, true);
      await budget(this.env, '/r2-operation', { kind: 'A' });
      await this.env.BUCKET.resumeMultipartUpload(attempt.key, attempt.uploadId!).complete(parts.map(x => ({ partNumber: x.partNumber, etag: x.etag })));
    }
    await budget(this.env, '/r2-operation', { kind: 'B' });
    const head = await this.env.BUCKET.head(attempt.key);
    if (!head || head.size !== file.size || Date.now() >= this.state().expiresAt || this.state().status !== 'active') {
      await this.abortUpload(attempt); this.ensureActive();
      throw new HttpError(409, 'object_size_mismatch', 'R2 完整对象不存在或实际大小不一致');
    }
    // D1 条件写入防止上传确认在原到期时间之后发布 ready。
    const result = await this.env.DB.prepare("UPDATE files SET r2_key = ?, sha256 = ?, upload_status = 'ready' WHERE id = ? AND EXISTS (SELECT 1 FROM shares WHERE id = ? AND status = 'active' AND expires_at > ?)").bind(attempt.key, sha256, file.id, this.state().id, Date.now()).run();
    if (!result.meta.changes || Date.now() >= this.state().expiresAt) { await this.abortUpload(attempt); this.ensureActive(); throw new HttpError(409, 'publication_failed', '上传发布失败，请重试'); }
    attempt.status = 'ready'; file.uploadStatus = 'ready'; file.r2Key = attempt.key; file.sha256 = sha256;
    await this.updateAttempt(attempt);
    try { await budget(this.env, '/r2-ready', { id: attempt.reservationId }); } catch { /* 保持存储预留，下一次幂等确认可以再次结算上传并发。 */ }
    for (const task of this.state().requests.filter(x => x.fileId === file.id && active(x) && x.mode === 'r2')) { task.status = 'transferring'; this.emit(task.receiverId, 'r2-ready', task); }
    this.emit(attempt.ownerSessionId, 'file-ready', undefined, { fileId });
    return json({ ready: true, sha256 });
  }
  private async signal(session: SessionInfo, data: Record<string, unknown>) {
    const eventId = data.eventId;
    assert(typeof eventId === 'string' && ID_PATTERN.test(eventId), 400, 'event_id_required', '控制消息必须有 eventId');
    if (session.seen.includes(eventId)) return;
    const task = this.requestFor(String(data.requestId), session, data.epoch);
    assert(active(task), 409, 'request_finished', '传输任务已结束');
    const payload = data.payload as Record<string, unknown> | undefined, kind = String(data.kind);
    const isOwner = session.id === task.ownerId;
    if (['rtc-offer', 'rtc-answer', 'rtc-ice'].includes(kind)) {
      assert(task.mode === 'p2p' || task.mode === 'turn', 409, 'wrong_transport', '当前模式不是 WebRTC');
      assert(kind === 'rtc-ice' || (kind === 'rtc-offer' ? isOwner : !isOwner), 403, 'signal_forbidden', '信令角色不符');
      assert(payload && JSON.stringify(payload).length <= (kind === 'rtc-ice' ? 2048 : 24576), 413, 'signal_too_large', 'WebRTC 信令超限');
      this.emit(isOwner ? task.receiverId : task.ownerId, kind, task, payload);
    } else if (kind === 'file-end') {
      assert(isOwner && typeof payload?.sha256 === 'string' && SHA256_PATTERN.test(payload.sha256) && payload.size === this.file(task.fileId).size, 403, 'end_forbidden', '源文件完成消息无效');
      const file = this.file(task.fileId);
      assert(!file.sha256 || file.sha256 === payload.sha256, 409, 'source_changed', '源文件内容发生变化');
      if (task.mode === 'ws') { const relay = this.relays.get(task.transferId); assert(relay && relay.acked === file.size, 409, 'relay_incomplete', '接收端尚未确认所有字节'); }
      if (task.mode === 'https') { const relay = this.httpsRelays.get(task.transferId); assert(relay && relay.acked === file.size, 409, 'relay_incomplete', '接收端尚未确认所有 HTTPS 字节'); }
      task.sourceHash = payload.sha256; file.sha256 = payload.sha256; await this.saveFile(file);
      this.emit(task.receiverId, 'file-end', task, payload);
    } else if (kind === 'completed') {
      assert(!isOwner && typeof payload?.sha256 === 'string' && payload.sha256 === (task.mode === 'r2' ? this.file(task.fileId).sha256 : task.sourceHash) && payload.size === this.file(task.fileId).size, 409, 'integrity_unconfirmed', '尚未确认完整文件及哈希');
      task.status = 'completed'; task.offset = this.file(task.fileId).size;
      await this.retireTransport(task); this.both('completed', task); await this.noDemand(task.fileId);
    } else if (kind === 'source-error') {
      assert(isOwner, 403, 'signal_forbidden', '只有发送端可报告源文件不可读');
      session.capabilities.readable = session.capabilities.readable.filter(x => x !== task.fileId);
      task.status = 'requested'; task.error = '源文件不可读，请分享者重新选择原文件';
      await this.retireTransport(task); this.both('waiting-source', task);
    } else if (kind === 'transport-error') {
      assert(isOwner, 403, 'signal_forbidden', '此消息仅由发送端报告');
      this.emit(task.receiverId, 'transport-error', task, { message: String(payload?.message ?? '传输连接失败').slice(0, 200) });
    } else throw new HttpError(400, 'unknown_signal', '未知控制消息类型');
    session.seen.push(eventId); if (session.seen.length > 256) session.seen.shift(); this.dirty.add(session.id);
  }
  private async relayAck(session: SessionInfo, data: Record<string, unknown>) {
    const task = this.state().requests.find(x => x.transferId === data.transferId && x.epoch === data.epoch && active(x));
    assert(task?.receiverId === session.id && task.mode === 'ws', 403, 'relay_forbidden', '没有此 WS 中继权限');
    const relay = this.relays.get(task.transferId), offset = data.offset;
    assert(relay, 409, 'relay_restarted', '中继状态已重置，请重建传输');
    assert(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= relay.acked && offset <= relay.sent, 400, 'invalid_ack', 'ACK 偏移超出已转发范围');
    assert(offset > relay.acked || !relay.ready, 409, 'duplicate_ack', '重复 ACK');
    relay.acked = offset; relay.ready = true; relay.lastAck = Date.now(); relay.messages++;
    this.scheduleRelayDeadline();
    this.send(task.ownerId!, { type: 'relay-credit', transferId: task.transferId, epoch: task.epoch, offset, window: limits(this.env).windowBytes });
  }
  private async relayData(session: SessionInfo, message: ArrayBuffer) {
    const frame = decodeFrame(message), old = this.retired.get(frame.transferId);
    if (old && old.until > Date.now()) {
      assert(old.ownerId === session.id && old.fileId === frame.fileId && old.epoch === frame.epoch && frame.payload.byteLength <= limits(this.env).chunkBytes && frame.payload.byteLength <= old.remaining && frame.offset + frame.payload.byteLength <= old.size, 403, 'relay_forbidden', '旧任务的在途数据不符合原授权');
      old.remaining -= frame.payload.byteLength; return;
    }
    const task = this.state().requests.find(x => x.transferId === frame.transferId && active(x));
    assert(task?.ownerId === session.id && task.mode === 'ws', 403, 'relay_forbidden', '未授权的二进制文件消息');
    const relay = this.relays.get(task.transferId), file = this.file(task.fileId), conf = limits(this.env);
    assert(relay?.ready, 409, 'relay_not_ready', '接收端未授予发送窗口或中继已重启');
    validateFrame(frame, { transferId: task.transferId, fileId: file.id, epoch: task.epoch, offset: relay.sent, size: file.size });
    assert(frame.payload.byteLength <= conf.chunkBytes && relay.sent + frame.payload.byteLength - relay.acked <= conf.windowBytes, 429, 'relay_window', 'WS 数据块或发送窗口超限');
    const outstanding = [...this.relays.values()].reduce((n, x) => n + x.sent - x.acked, 0);
    assert(outstanding + frame.payload.byteLength <= conf.roomBufferBytes, 429, 'relay_buffer', '房间中继缓冲已达上限');
    const socket = this.socket(task.receiverId);
    assert(socket && Date.now() - relay.lastAck < conf.ackTimeoutMs, 503, 'relay_disconnected', '接收端断连或 ACK 超时');
    socket.send(message); relay.sent += frame.payload.byteLength; relay.bytes += frame.payload.byteLength; relay.messages++; task.status = 'transferring';
    // 文件消息和每块进度只在内存处理；绝不写入 D1 / DO storage / R2。
  }
  private async httpsRequest(request: Request, requestId: string, operation: string): Promise<Response> {
    try {
      const data = operation === 'ack' ? await readJson(request, 1024) : Object.fromEntries(new URL(request.url).searchParams);
      const epoch = operation === 'ack' ? data.epoch : Number(data.epoch), offset = operation === 'ack' ? data.offset : Number(data.offset);
      assert(typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 1 && typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && (operation === 'ack' || /^\d+$/.test(String(data.epoch)) && /^\d+$/.test(String(data.offset))), 400, 'invalid_offset', 'HTTPS epoch 或偏移无效');
      const relay = await this.locked(async () => {
        const session = this.session(request), task = this.requestFor(requestId, session, epoch);
        assert(active(task) && task.mode === 'https' && data.transferId === task.transferId && data.fileId === task.fileId, 409, 'stale_transfer', 'HTTPS 任务身份不一致或已经结束');
        assert((operation === 'chunk' && request.method === 'POST' ? task.ownerId : task.receiverId) === session.id, 403, 'relay_forbidden', '没有此 HTTPS 中继权限');
        const relay = this.httpsRelays.get(task.transferId);
        assert(relay, 409, 'relay_restarted', 'HTTPS 内存缓冲已重置，请重建传输');
        if (operation === 'ack') { const response = relay.acknowledge(offset); task.offset = offset; await this.persist(); return response; }
        await this.persist(); return relay;
      });
      if (relay instanceof Response) return relay;
      return request.method === 'POST' ? await relay.upload(request, offset) : await relay.download(request, offset);
    } catch (error) { return errorResponse(error); }
  }
  async fetch(request: Request): Promise<Response> {
    const httpsRoute = new URL(request.url).pathname.match(/^\/api\/shares\/([a-f0-9]{32})\/download-requests\/([a-f0-9]{32})\/https\/(chunk|ack)$/);
    if (httpsRoute && httpsRoute[1] === this.room?.id && (httpsRoute[3] === 'chunk' && ['GET', 'POST'].includes(request.method) || httpsRoute[3] === 'ack' && request.method === 'POST')) return this.httpsRequest(request, httpsRoute[2], httpsRoute[3]);
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const path = new URL(request.url).pathname, method = request.method;
        if (path === '/internal/init') {
          assert(!this.room, 409, 'already_initialized', '分享已创建');
          this.room = await readJson<Room>(request); await this.persist(); return json({ ok: true });
        }
        if (path === '/internal/sweep') { await this.sweep(); await this.persist(); return json({ ok: true }); }
        if (path === '/internal/admin/ws-usage') return json({ transfers: [...this.relays.values()].map(relay => ({ id: this.state().requests.find(task => task.id === relay.requestId)?.reservationId, bytes: relay.bytes })) });
        if (path === '/internal/admin/https-usage') return json({ transfers: this.state().requests.filter(task => task.mode === 'https' && active(task) && task.reservationId).map(task => ({ id: task.reservationId, bytes: Math.max(task.httpsBytes ?? 0, this.httpsRelays.get(task.transferId)?.bytes ?? 0), activeMs: Math.max(0, Date.now() - (task.httpsStartedAt ?? Date.now())) })) });
        if (path === '/internal/admin/snapshot') return json({ ...this.snapshot(), files: this.state().files.map(({ modeAdminHash: _hash, ...file }) => file), sessions: [...this.sessions.values()].filter(s => this.online(s)).map(s => ({ id: s.id, role: s.role, lastSeen: this.seenAt(s), capabilities: s.capabilities })), requests: this.state().requests.map(({ adminGrant: _grant, ...task }) => task) });
        if (path === '/internal/admin/revoke' && method === 'DELETE') { this.state().status = 'revoked'; await this.cleanup(); await this.persist(); return json({ ok: true }); }
        const adminMode = path.match(/^\/internal\/admin\/files\/([a-f0-9]{32})\/mode$/);
        if (adminMode && method === 'POST') {
          const hash = request.headers.get('X-File-Share-Admin'), data = await readJson(request);
          assert(await validAdmin(this.env, hash ?? undefined), 403, 'admin_required', '需要有效管理员登录'); this.ensureActive();
          this.setMode(this.file(adminMode[1]), data.mode, hash!); await this.persist(); return json({ ok: true });
        }
        const deleteFile = path.match(/^\/internal\/admin\/files\/([a-f0-9]{32})$/);
        if (deleteFile && method === 'DELETE') {
          const file = this.state().files.find(f => f.id === deleteFile[1]); assert(file, 404, 'file_not_found', '文件不存在');
          for (const task of this.state().requests.filter(t => t.fileId === file.id && active(t))) await this.cancelTask(task, '文件已被管理员删除');
          for (const attempt of this.state().uploads.filter(a => a.fileId === file.id)) { if (attempt.status === 'ready') attempt.status = 'uploading'; await this.abortUpload(attempt); }
          if (file.r2Key) await this.env.BUCKET.delete(file.r2Key);
          file.deleted = true; file.uploadStatus = 'canceled'; delete file.r2Key;
          await this.saveFile(file); await this.env.DB.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').bind(Date.now(), file.id).run();
          for (const s of this.sessions.values()) { s.capabilities.readable = s.capabilities.readable.filter(x => x !== file.id); this.dirty.add(s.id); this.emit(s.id, 'file-deleted', undefined, { fileId: file.id }); }
          await this.persist(); return json({ ok: true, cleanupPending: this.state().uploads.some(a => a.fileId === file.id && a.status !== 'aborted') });
        }
        const base = `/api/shares/${this.state().id}`, route = path.slice(base.length);
        assert(path.startsWith(base), 404, 'not_found', '接口不存在');
        if (route === '' && method === 'GET') { this.ensureActive(); return json(this.snapshot()); }
        if (route === '' && method === 'DELETE') { this.ownerAuth(request, true); if (this.state().status === 'active') this.state().status = 'revoked'; await this.cleanup(); await this.persist(); return json({ share: this.snapshot() }); }
        if (route === '/sessions' && method === 'POST') {
          this.ensureActive(); const data = await readJson(request), role = data.role === 'owner' ? 'owner' : 'receiver';
          if (role === 'owner') assert(constantEqual(digest(bearer(request)), this.state().ownerTokenHash), 403, 'owner_forbidden', '管理令牌无效');
          await this.pruneSessions();
          assert(this.sessions.size < limits(this.env).maxSessions, 429, 'session_limit', '此分享的会话数量已达上限');
          const sessionToken = token(), session: SessionInfo = { id: id(), tokenHash: digest(sessionToken), role, lastSeen: Date.now(), lastPoll: 0, capabilities: safeCapabilities(data.capabilities, this.state().files.filter(x => !x.deleted).map(x => x.id)), seq: 0, events: [], seen: [], adminHash: request.headers.get('X-File-Share-Admin') ?? undefined };
          if (role === 'owner' && session.adminHash) this.state().r2AdminHash = session.adminHash;
          this.sessions.set(session.id, session); this.dirty.add(session.id); await this.persist();
          return json({ sessionId: session.id, sessionToken, expiresAt: this.state().expiresAt }, 201);
        }
        if (route === '/ws' && method === 'GET') {
          this.ensureActive(); assert(request.headers.get('Upgrade')?.toLowerCase() === 'websocket', 400, 'upgrade_required', '需要 WebSocket 握手');
          const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(x => x.trim()) ?? [];
          const secret = protocols.find(x => x.startsWith('token.'))?.slice(6) ?? '';
          const session = [...this.sessions.values()].find(x => constantEqual(x.tokenHash, digest(secret)));
          assert(session && secret.length === 64, 403, 'session_forbidden', 'WS 会话令牌无效');
          for (const old of this.ctx.getWebSockets(session.id)) old.close(1000, 'replaced');
          const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1], [session.id]); pair[1].serializeAttachment({ sessionId: session.id });
          session.capabilities.ws = true; session.lastSeen = Date.now(); this.dirty.add(session.id); await this.persist();
          return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'file-share' } });
        }
        if (route === '/files-status' && method === 'GET') { const session = this.session(request); return json({ share: this.snapshot(), cursor: session.seq, requests: this.state().requests.filter(r => r.receiverId === session.id || r.ownerId === session.id).map(r => this.publicTask(r)) }); }
        if (route === '/events' && method === 'GET') {
          const session = this.session(request), now = Date.now(), conf = limits(this.env);
          assert(now - session.lastPoll >= conf.pollMinMs, 429, 'poll_rate', '轮询间隔过短'); session.lastPoll = now;
          const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);
          assert(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= session.seq, 400, 'invalid_cursor', '事件游标无效');
          session.events = session.events.filter(x => now - x.createdAt < conf.eventTtlMs); this.dirty.add(session.id);
          if (cursor < (session.events[0]?.seq ?? session.seq + 1) - 1) { await this.persist(); throw new HttpError(409, 'resync_required', '控制事件已过期，请重新同步', { cursor: session.seq, share: this.snapshot(), requests: this.state().requests.filter(r => r.receiverId === session.id || r.ownerId === session.id).map(r => this.publicTask(r)) }); }
          const events = session.events.filter(x => x.seq > cursor); await this.persist(); return json({ events, cursor: session.seq });
        }
        if (route === '/heartbeat' && method === 'POST') {
          const session = this.session(request), data = await readJson(request); await this.heartbeat(session, data.capabilities); await this.persist(); return json({ share: this.snapshot() });
        }
        if (route === '/signals' && method === 'POST') { const session = this.session(request); await this.signal(session, await readJson(request, limits(this.env).controlMaxBytes)); await this.persist(); return json({ ok: true }); }
        if (route === '/peers' && method === 'POST') {
          const session = this.session(request); assert(session.capabilities.webrtc, 409, 'rtc_unavailable', '浏览器不支持 WebRTC');
          const peers = this.state().peers ??= [];
          const live = new Set([...this.sessions.values()].filter(s => this.online(s) && s.capabilities.webrtc).map(s => s.id));
          this.state().peers = peers.filter(p => live.has(p.ownerId) && live.has(p.receiverId));
          for (const other of this.sessions.values()) {
            if (!live.has(other.id) || other.role === session.role) continue;
            const owner = session.role === 'owner' ? session : other, receiver = session.role === 'receiver' ? session : other;
            if (!this.state().peers!.some(p => p.ownerId === owner.id && p.receiverId === receiver.id)) {
              const peer: PeerLink = { id: id(), ownerId: owner.id, receiverId: receiver.id, generation: 0, ownerReady: false, receiverReady: false };
              this.state().peers!.push(peer); this.emit(owner.id, 'peer-needed', undefined, peer); this.emit(receiver.id, 'peer-needed', undefined, peer);
            }
          }
          await this.persist(); return json({ peers: this.state().peers!.filter(p => p.ownerId === session.id || p.receiverId === session.id) });
        }
        if (route === '/peer-signals' && method === 'POST') {
          const session = this.session(request), data = await readJson(request, 32768);
          const peer = this.state().peers?.find(p => p.id === data.peerId); assert(peer && (peer.ownerId === session.id || peer.receiverId === session.id), 403, 'peer_forbidden', '无此直连权限');
          const owner = session.id === peer.ownerId, otherId = owner ? peer.receiverId : peer.ownerId;
          const other = this.sessions.get(otherId); assert(other && this.online(other), 409, 'peer_offline', '对端已离线');
          if (data.kind === 'offer') {
            assert(owner && data.generation === peer.generation + 1, 409, 'peer_generation', '直连协商已更新'); peer.generation++; peer.ownerReady = peer.receiverReady = false;
          } else assert(data.generation === peer.generation, 409, 'peer_generation', '直连协商已更新');
          if (data.kind === 'ready' || data.kind === 'closed') {
            if (owner) peer.ownerReady = data.kind === 'ready'; else peer.receiverReady = data.kind === 'ready';
            if (peer.ownerReady && peer.receiverReady) { this.emit(peer.ownerId, 'peer-ready', undefined, peer); this.emit(peer.receiverId, 'peer-ready', undefined, peer); }
          } else {
            assert(['offer', 'answer', 'ice'].includes(String(data.kind)) && (data.kind !== 'answer' || !owner), 403, 'peer_signal_forbidden', '信令角色不符');
            assert(data.payload && typeof data.payload === 'object' && JSON.stringify(data.payload).length <= (data.kind === 'ice' ? 2048 : 24576), 413, 'peer_signal_size', '直连信令无效或超限');
            this.emit(otherId, 'peer-signal', undefined, { peer: structuredClone(peer), kind: data.kind, payload: data.payload });
          }
          await this.persist(); return json({ ok: true });
        }
        const policy = route.match(/^\/files\/([a-f0-9]{32})\/mode$/);
        if (policy && method === 'POST') {
          const session = this.session(request), data = await readJson(request), hash = request.headers.get('X-File-Share-Admin');
          assert(await validAdmin(this.env, hash ?? undefined), 403, 'admin_required', '指定传输方式需要管理员登录');
          const file = this.file(policy[1]); this.setMode(file, data.mode, hash!);
          this.emit(session.id, 'file-mode', undefined, { fileId: file.id, mode: data.mode }); await this.persist(); return json({ ok: true });
        }
        if (route === '/download-requests' && method === 'POST') {
          const session = this.session(request), data = await readJson(request);
          assert(session.role === 'receiver', 403, 'receiver_required', '请在接收页面请求下载'); this.file(String(data.fileId));
          assert(!this.state().requests.some(r => r.fileId === data.fileId && r.receiverId === session.id && active(r)), 409, 'already_downloading', '此文件已有有效下载任务');
          assert(this.state().requests.filter(active).length < limits(this.env).maxRequests, 429, 'download_limit', '下载并发已达上限');
          this.state().requests = this.state().requests.filter(active).concat(this.state().requests.filter(x => !active(x)).slice(-32));
          const task: DownloadRequest = { id: id(), fileId: String(data.fileId), receiverId: session.id, epoch: 1, mode: 'p2p', status: 'requested', offset: 0, transferId: id(), createdAt: Date.now() };
          if (data.mode && data.mode !== 'auto') { assert(await validAdmin(this.env, request.headers.get('X-File-Share-Admin') ?? undefined), 403, 'admin_required', '指定传输方式需要管理员登录'); assert(['p2p', 'turn', 'ws', 'https', 'r2'].includes(String(data.mode)), 400, 'invalid_mode', '传输方式无效'); task.forcedMode = data.mode as Mode; task.adminGrant = session.adminHash; }
          this.state().requests.push(task); await this.activate(task); await this.persist(); return json(this.publicTask(task), 201);
        }
        const downloadRoute = route.match(/^\/download-requests\/([a-f0-9]{32})(?:\/(advance|upgrade|switch|resume))?$/);
        if (downloadRoute) {
          const session = this.session(request, method === 'DELETE'), task = this.requestFor(downloadRoute[1], session);
          assert(task.receiverId === session.id, 403, 'receiver_required', '只能取消或切换本人的下载任务');
          if (method === 'DELETE' && !downloadRoute[2]) { if (active(task)) await this.cancelTask(task, '接收者取消下载'); await this.persist(); return json({ ok: true }); }
          if (method === 'POST' && downloadRoute[2]) {
            const data = await readJson(request); this.requestFor(task.id, session, data.epoch);
            if (downloadRoute[2] === 'switch') {
              const file = this.file(task.fileId), directAdmin = request.headers.get('X-File-Share-Admin');
              assert(active(task) && ['auto', 'p2p', 'turn', 'ws', 'https', 'r2'].includes(String(data.mode)), 409, 'invalid_switch', '任务状态或传输方式无效');
              const fileAuthorized = data.mode === (file.forcedMode ?? 'auto') && await validAdmin(this.env, file.modeAdminHash);
              assert(fileAuthorized || await validAdmin(this.env, directAdmin ?? undefined), 403, 'admin_required', '切换指定方式需要管理员授权');
              assert(typeof data.offset === 'number' && Number.isSafeInteger(data.offset) && data.offset >= task.offset && data.offset <= file.size, 400, 'invalid_offset', '恢复偏移无效');
              await this.retireTransport(task); this.both('stop-attempt', task);
              task.epoch++; task.offset = data.offset; task.transferId = id(); task.mode = 'p2p'; task.forcedMode = data.mode === 'auto' ? undefined : data.mode as Mode;
              task.adminGrant = directAdmin ?? file.modeAdminHash; task.status = 'requested'; delete task.peerId; delete task.sourceHash;
              await this.activate(task); await this.noDemand(file.id);
            } else if (downloadRoute[2] === 'resume') {
              assert(active(task) && task.mode === 'https' && data.transferId === task.transferId, 409, 'invalid_resume', '只有当前 HTTPS 任务可以重建');
              assert(typeof data.offset === 'number' && Number.isSafeInteger(data.offset) && data.offset >= task.offset && data.offset <= this.file(task.fileId).size, 400, 'invalid_offset', '恢复偏移无效');
              await this.retireTransport(task); this.both('stop-attempt', task);
              task.epoch++; task.offset = data.offset; task.transferId = id(); delete task.sourceHash;
              if (!await this.startHttps(task) && task.forcedMode !== 'https') await this.startR2(task);
            } else if (downloadRoute[2] === 'upgrade') {
              assert(active(task) && !task.forcedMode && task.mode !== 'p2p', 409, 'upgrade_disabled', '指定方式或任务状态不允许自动切换');
              const peer = this.state().peers?.find(p => p.id === data.peerId && p.ownerId === task.ownerId && p.receiverId === session.id && p.ownerReady && p.receiverReady);
              assert(peer && this.owner(task.fileId)?.id === peer.ownerId, 409, 'peer_not_ready', '直连尚未就绪');
              assert(typeof data.offset === 'number' && Number.isSafeInteger(data.offset) && data.offset >= task.offset && data.offset <= this.file(task.fileId).size, 400, 'invalid_offset', '恢复偏移无效');
              await this.retireTransport(task); this.both('stop-attempt', task);
              task.epoch++; task.offset = data.offset; task.transferId = id(); task.mode = 'p2p'; task.peerId = peer.id; task.status = 'connecting'; delete task.sourceHash;
              this.both('attempt', task); await this.noDemand(task.fileId);
            } else await this.advance(task, data.offset, String(data.reason ?? '连接或传输失败'));
            await this.persist(); return json(this.publicTask(task));
          }
        }
        const fileRoute = route.match(/^\/files\/([a-f0-9]{32})\/(uploads|identity|failure|complete|abort|download|parts\/(\d+)\/sign)$/);
        if (fileRoute && method === 'POST') {
          const fileId = fileRoute[1], operation = fileRoute[2], data = await readJson(request);
          if (operation !== 'abort' && (this.state().status !== 'active' || Date.now() >= this.state().expiresAt)) {
            if (operation === 'complete') {
              this.ownerAuth(request, true);
              const expiredAttempt = this.state().uploads.find(x => x.id === data.attemptId && x.fileId === fileId);
              if (expiredAttempt) await this.abortUpload(expiredAttempt);
            }
            this.ensureActive();
          }
          if (operation !== 'abort') this.file(fileId);
          if (operation === 'download') {
            const session = this.session(request), task = this.requestFor(String(data.requestId), session, data.epoch), file = this.file(fileId);
            assert(task.receiverId === session.id && active(task) && task.fileId === fileId && file.uploadStatus === 'ready' && file.r2Key && file.sha256, 409, 'file_not_ready', '完整云端文件尚未就绪');
            assert(task.mode === 'r2' && await this.r2Allowed(task), 403, 'r2_admin_required', 'R2 管理员授权已失效');
            await budget(this.env, '/r2-operation', { kind: 'B' });
            return json({ ...await presign(this.env, file.r2Key, 'GET', this.state().expiresAt, { filename: file.name }), sha256: file.sha256, size: file.size });
          }
          const session = this.ownerAuth(request, operation === 'abort' || operation === 'complete');
          if (operation === 'failure') {
            const file = this.file(fileId), message = String(data.reason ?? '云端上传未完成').slice(0, 200);
            if (file.uploadStatus !== 'ready') {
              if (data.sourceUnavailable === true && session) { session.capabilities.readable = session.capabilities.readable.filter(x => x !== fileId); this.dirty.add(session.id); }
              for (const task of this.state().requests.filter(x => x.fileId === fileId && x.mode === 'r2' && active(x))) {
                if (data.sourceUnavailable === true) { task.status = 'requested'; task.epoch++; this.both('waiting-source', task, { message }); }
                else this.emit(task.receiverId, 'r2-error', task, { message });
              }
            }
            await this.persist(); return json({ ok: true });
          }
          if (operation === 'uploads') { assert(session, 409, 'owner_session_required', '请先建立管理会话'); const result = await this.uploads(fileId, session); await this.persist(); return result; }
          if (operation === 'identity') {
            const attempt = this.uploadAttempt(fileId, data.attemptId), file = this.file(fileId);
            assert(session && attempt.ownerSessionId === session.id && attempt.status === 'uploading', 409, 'upload_paused', '上传会话已经暂停或不属于当前管理会话');
            assert(typeof data.sha256 === 'string' && SHA256_PATTERN.test(data.sha256), 400, 'hash_required', '必须提交完整源文件 SHA-256');
            assert(!file.sha256 || file.sha256 === data.sha256, 409, 'source_changed', '恢复上传的源文件内容不一致');
            file.sha256 = data.sha256; attempt.verifiedSessionId = session.id; await this.saveFile(file); await this.persist(); return json({ ok: true });
          }
          if (operation === 'abort') {
            await this.abortUpload(this.uploadAttempt(fileId, data.attemptId));
            if (typeof data.reason === 'string') for (const task of this.state().requests.filter(x => x.fileId === fileId && x.mode === 'r2' && active(x))) this.emit(task.receiverId, 'r2-error', task, { message: data.reason.slice(0, 200) });
            await this.persist(); return json({ ok: true });
          }
          if (operation === 'complete') {
            const attempt = this.uploadAttempt(fileId, data.attemptId);
            assert(attempt.mode !== 'multipart' || (session && attempt.verifiedSessionId === session.id), 409, 'source_identity_required', 'Multipart 必须先验证当前会话的完整源文件身份');
            const result = await this.completeUpload(fileId, data.attemptId, data.sha256); await this.persist(); return result;
          }
          const attempt = this.uploadAttempt(fileId, data.attemptId), partNumber = Number(fileRoute[3]), file = this.file(fileId);
          assert(await this.r2Demand(fileId), 403, 'r2_admin_required', 'R2 管理员授权已失效');
          assert(attempt.mode === 'multipart' && attempt.uploadId && attempt.status === 'uploading' && this.state().requests.some(x => x.fileId === fileId && active(x) && x.mode === 'r2'), 409, 'upload_paused', 'Multipart 已暂停或取消');
          assert(session && file.sha256 && attempt.verifiedSessionId === session.id, 409, 'source_identity_required', '签发分片前必须验证当前会话的完整源文件 SHA-256');
          assert(Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= Math.ceil(file.size / attempt.partSize), 400, 'invalid_part', '分片编号无效');
          await budget(this.env, '/r2-operation', { kind: 'A' });
          const auth = await presign(this.env, attempt.key, 'PUT', this.state().expiresAt, { mime: file.mime, size: Math.min(attempt.partSize, file.size - (partNumber - 1) * attempt.partSize), uploadId: attempt.uploadId, partNumber });
          attempt.signedUntil = Math.max(attempt.signedUntil, auth.signedUntil); await this.updateAttempt(attempt); await this.persist(); return json(auth);
        }
        throw new HttpError(404, 'not_found', '接口不存在');
      } catch (error) { if (this.room) await this.persist(); return errorResponse(error); }
    });
  }
  private async heartbeat(session: SessionInfo, capabilities: unknown) {
    const previous = session.capabilities;
    session.lastSeen = Date.now(); session.capabilities = safeCapabilities(capabilities, this.state().files.map(x => x.id));
    if (!this.socket(session.id)) session.capabilities.ws = false;
    if (session.role === 'receiver') session.capabilities.readable = [];
    this.dirty.add(session.id);
    if (session.role === 'owner') {
      for (const task of this.state().requests.filter(x => active(x) && x.status === 'requested' && session.capabilities.readable.includes(x.fileId))) {
        if (task.mode === 'r2' && previous.readable.includes(task.fileId)) continue;
        task.epoch++; task.offset = 0; await this.activate(task);
      }
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const attachment = socket.deserializeAttachment() as { sessionId?: string } | null;
      const session = attachment?.sessionId ? this.sessions.get(attachment.sessionId) : undefined;
      try {
        this.ensureActive(); assert(session, 403, 'session_forbidden', '会话无效'); session.lastSeen = Date.now();
        if (typeof message !== 'string') { await this.relayData(session, message); return; }
        assert(new TextEncoder().encode(message).byteLength <= limits(this.env).controlMaxBytes, 413, 'control_too_large', '控制消息超限');
        const data = JSON.parse(message) as Record<string, unknown>;
        if (data.type === 'relay-ack') { await this.relayAck(session, data); return; }
        await budget(this.env, '/charge', { source: `session:${session.id}`, websocket: true });
        if (data.type === 'signal') await this.signal(session, data);
        else if (data.type === 'heartbeat') await this.heartbeat(session, data.capabilities);
        else throw new HttpError(400, 'unknown_signal', '未知 WS 控制消息');
        await this.persist();
        if (data.type === 'signal') this.send(session.id, { type: 'signal-result', eventId: data.eventId, ok: true });
        if (data.type === 'heartbeat') this.send(session.id, { type: 'heartbeat-result', share: this.snapshot() });
      } catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(400, 'invalid_message', '文件消息或控制数据无效');
        if (session) {
          this.send(session.id, { type: 'error', error: failure.code, message: failure.message });
          if (typeof message !== 'string' || (typeof message === 'string' && message.includes('relay-ack'))) {
            let transferId: string | undefined;
            try { transferId = typeof message === 'string' ? JSON.parse(message).transferId : decodeFrame(message).transferId; } catch { /* 无法识别的消息按连接级错误处理。 */ }
            for (const task of this.state().requests.filter(x => x.mode === 'ws' && active(x) && (!transferId || x.transferId === transferId) && (x.ownerId === session.id || x.receiverId === session.id))) { task.error = failure.message; await this.retireTransport(task); this.both('relay-error', task, { message: failure.message }); }
          }
        }
        if ([403, 410, 413].includes(failure.status)) socket.close(failure.status === 413 ? 1009 : 1008, failure.code);
        if (this.room) await this.persist();
      }
    });
  }
  async webSocketClose(socket: WebSocket) { await this.disconnected(socket); }
  async webSocketError(socket: WebSocket) { await this.disconnected(socket); }
  private async disconnected(socket: WebSocket) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const attachment = socket.deserializeAttachment() as { sessionId?: string } | null;
      const session = attachment?.sessionId ? this.sessions.get(attachment.sessionId) : undefined;
      if (!session || this.socket(session.id)) return;
      session.capabilities.ws = false; this.dirty.add(session.id);
      for (const task of this.state().requests.filter(x => x.mode === 'ws' && active(x) && (x.ownerId === session.id || x.receiverId === session.id))) { task.error = 'WS 中继连接中断'; await this.retireTransport(task); this.both('relay-error', task); }
      await this.persist();
    });
  }
  private async pruneSessions() {
    const conf = limits(this.env), now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - this.seenAt(session) < conf.leaseMs * 2 || this.state().requests.some(r => active(r) && (r.ownerId === session.id || r.receiverId === session.id))) continue;
      for (const socket of this.ctx.getWebSockets(session.id)) socket.close(1000, 'lease expired');
      this.sessions.delete(session.id); await this.ctx.storage.delete(`session:${session.id}`);
    }
  }
  async alarm() { await this.ctx.blockConcurrencyWhile(async () => { await budget(this.env, '/do-used', { count: 1 }); await this.sweep(); await this.persist(); }); }
  private async sweep() {
    if (!this.room) return;
    const state = this.room, now = Date.now(), conf = limits(this.env);
    if (state.status !== 'active' || now >= state.expiresAt) { if (state.status === 'active') state.status = 'expired'; await this.cleanup(); return; }
    for (const task of state.requests.filter(active)) {
      const receiver = this.sessions.get(task.receiverId), owner = task.ownerId ? this.sessions.get(task.ownerId) : undefined;
      if (!receiver || !this.online(receiver)) { await this.cancelTask(task, '接收者已离线'); continue; }
      if (task.mode === 'r2' && !await this.r2Allowed(task)) { await this.cancelTask(task, 'R2 管理员登录已失效'); continue; }
      if (task.mode === 'ws') {
        const relay = this.relays.get(task.transferId);
        if (!relay || now - relay.lastAck >= conf.ackTimeoutMs) { task.error = 'WS 中继重启或 ACK 超时'; await this.retireTransport(task); this.both('relay-error', task); }
      }
      if (task.mode === 'https') {
        const relay = this.httpsRelays.get(task.transferId);
        if (relay && now - relay.lastAck >= conf.ackTimeoutMs) { task.error = 'HTTPS 数据块或 ACK 超时'; await this.retireTransport(task); this.both('relay-error', task); }
        // A missing volatile relay is recovered explicitly by the receiver's /resume request.
      }
      if (this.file(task.fileId).uploadStatus !== 'ready' && (!owner || !this.online(owner) || !owner.capabilities.readable.includes(task.fileId))) {
        if (task.status !== 'requested') { task.status = 'requested'; task.epoch++; await this.retireTransport(task); this.both('waiting-source', task); }
      }
    }
    for (const attempt of state.uploads) {
      if (attempt.status === 'paused' && (attempt.pausedUntil ?? 0) <= now) await this.abortUpload(attempt);
      if (['canceled', 'failed', 'aborted'].includes(attempt.status)) await this.cleanAttempt(attempt);
      const owner = this.sessions.get(attempt.ownerSessionId);
      if (attempt.status === 'uploading' && (!owner || !this.online(owner))) {
        if (attempt.mode === 'put') await this.abortUpload(attempt);
        else { attempt.status = 'paused'; attempt.pausedUntil = Math.min(state.expiresAt, now + conf.multipartPauseMs); this.file(attempt.fileId).uploadStatus = 'paused'; await this.updateAttempt(attempt); await this.saveFile(this.file(attempt.fileId)); }
      }
    }
    await this.retryRevocations(); await this.pruneSessions();
  }
  private async retryRevocations() {
    const state = this.state();
    for (const entry of [...state.pendingRevocations]) {
      try { if (Date.now() < entry.expiresAt) await revokeTurn(this.env, entry.usernames); if (entry.reservationId) await budget(this.env, '/settle', { id: entry.reservationId }); state.pendingRevocations = state.pendingRevocations.filter(x => x !== entry); }
      catch { /* 下次 Alarm 继续重试。 */ }
    }
  }
  private async cleanup() {
    const state = this.state(), now = Date.now(), conf = limits(this.env);
    if (state.cleanupStatus === 'cleaned' && state.cleanedAt && now >= state.cleanedAt + conf.tombstoneMs) {
      await this.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(state.id).run();
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'expired');
      await this.ctx.storage.deleteAll(); this.room = undefined; this.sessions.clear(); return;
    }
    const starting = state.cleanupStatus === 'pending';
    state.cleanupStatus = 'cleaning'; state.nextCleanupAt = now + 60000;
    await this.env.DB.prepare('UPDATE shares SET status = ?, cleanup_status = ? WHERE id = ?').bind(state.status, 'cleaning', state.id).run();
    for (const task of state.requests.filter(active)) { task.status = 'canceled'; task.error = '分享已过期或撤销'; await this.retireTransport(task); this.both('expired', task); }
    for (const session of this.sessions.values()) { this.emit(session.id, 'expired', undefined, { share: this.snapshot() }); for (const socket of this.ctx.getWebSockets(session.id)) socket.close(1000, 'share expired'); }
    let failed = false;
    for (const attempt of state.uploads) {
      if (starting) {
        attempt.recheckUntil = Math.max(attempt.signedUntil, Math.min(now, state.expiresAt)) + conf.lateCleanupGraceMs;
        await this.env.DB.prepare('INSERT OR REPLACE INTO cleanup_tasks (id, share_id, target_type, target_key, upload_id, next_retry_at) VALUES (?, ?, ?, ?, ?, ?)').bind(attempt.id, state.id, attempt.mode, attempt.key, attempt.uploadId ?? null, now).run();
        await this.updateAttempt(attempt);
      }
      if (attempt.status !== 'aborted') await this.abortUpload(attempt);
      await this.cleanAttempt(attempt);
      if (attempt.status !== 'aborted') failed = true;
    }
    await this.retryRevocations();
    failed ||= state.pendingRevocations.length > 0;
    const holdUntil = state.uploads.length ? Math.max(...state.uploads.map(x => x.recheckUntil)) : 0;
    if (!failed && now >= holdUntil) {
      state.cleanupStatus = 'cleaned'; state.cleanedAt ??= now; state.nextCleanupAt = state.uploads.length ? now + 300000 : undefined;
      await this.env.DB.prepare("UPDATE shares SET cleanup_status = 'cleaned', cleaned_at = ? WHERE id = ?").bind(state.cleanedAt, state.id).run();
      await budget(this.env, '/release', { id: `share:${state.id}` });
      if (state.files.length) await this.env.DB.prepare('DELETE FROM files WHERE share_id = ?').bind(state.id).run();
      state.files = []; state.requests = [];
      for (const session of this.sessions.values()) { session.events = []; session.seen = []; session.capabilities = { ws: false, webrtc: false, readable: [] }; this.dirty.add(session.id); }
      // 仅保留期限、授权哈希及补偿清理所需的 key 清单；不保留文件名称和 SHA-256。
    }
  }
}
