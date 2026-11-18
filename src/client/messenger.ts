import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  MessengerConversation, MessengerFile, MessengerMessage, MessengerState, MessengerUser,
} from '../shared/messenger';
import { api, ApiError } from './api';

const BASE = '/api/messenger';
const IDENTITY_KEY = 'file-share.messenger.identity.v1';
type Identity = { credential: string; fingerprint: string };
type History = { messages: MessengerMessage[]; hasMore: boolean };
type ConditionalState = { unchanged: true; revision: string; refreshAt: number };
export type LocalFileMetadata = Pick<MessengerFile, 'id' | 'name' | 'size' | 'mime' | 'lastModified'> &
  Partial<Pick<MessengerFile, 'transferMode'>>;

export interface MessengerViewState {
  self: MessengerUser | null;
  users: MessengerUser[];
  conversations: MessengerConversation[];
  drive: MessengerFile[];
  transfers: MessengerState['transfers'];
  activeId: string | null;
  messages: MessengerMessage[];
  hasOlder: boolean;
  loadingHistory: boolean;
  status: 'connecting' | 'online' | 'offline';
  error: string;
}

function randomHex(bytes: number) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function newIdentity(): Identity {
  // Store the seed with the credential so browser upgrades and display changes preserve the account.
  const nav = globalThis.navigator;
  const traits = [nav?.userAgent, nav?.language, nav?.platform, nav?.hardwareConcurrency,
    globalThis.screen?.width, globalThis.screen?.height, globalThis.screen?.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone];
  return { fingerprint: bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(traits)))), credential: randomHex(32) };
}

function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<Identity>;
  return typeof identity.credential === 'string' && /^[a-f0-9]{64}$/.test(identity.credential)
    && typeof identity.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(identity.fingerprint);
}

function storedIdentity(): Identity | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(IDENTITY_KEY) ?? 'null');
    if (validIdentity(value)) return value;
  } catch { /* Storage may be disabled. */ }
}

function indexedIdentity(candidate: Identity): Promise<Identity> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDENTITY_KEY, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('account');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('account', 'readwrite');
      const store = tx.objectStore('account');
      const read = store.get('current');
      let identity = candidate;
      read.onsuccess = () => {
        if (validIdentity(read.result)) identity = read.result;
        else store.put(identity, 'current');
      };
      tx.oncomplete = () => { db.close(); resolve(identity); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function browserIdentity(): Promise<Identity> {
  let identity = storedIdentity() ?? newIdentity();
  if (typeof indexedDB !== 'undefined') {
    // A read/write transaction serializes first visits from multiple tabs, including on HTTP LAN origins.
    try { identity = await indexedIdentity(identity); } catch { /* Use localStorage when IndexedDB is restricted. */ }
  }
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch { /* The current page keeps its credential in memory. */ }
  return identity;
}

function replaceById<T extends { id: string }>(items: T[], item: T) {
  return [item, ...items.filter(entry => entry.id !== item.id)];
}
function describe(error: unknown) { return error instanceof Error ? error.message : String(error); }
const segment = encodeURIComponent;

export class MessengerClient {
  state: MessengerViewState = {
    self: null, users: [], conversations: [], drive: [], transfers: [], activeId: null,
    messages: [], hasOlder: false, loadingHistory: false, status: 'connecting', error: '',
  };
  onChange: (state: MessengerViewState) => void = () => {};
  private identity?: Identity;
  private identityPromise?: Promise<Identity>;
  private running = false;
  private generation = 0;
  private intent = 0;
  private navigation = 0;
  private stateRevision = 0;
  private historyRevision = 0;
  private stateTag?: string;
  private refreshAt = 0;
  private historyTag?: number;
  private historyHead = 0;
  private needsHistory = true;
  private olderPending?: Promise<void>;
  private connecting?: Promise<void>;
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unfinished = new Map<string, string[]>();

  get token() { return this.identity?.credential ?? ''; }

  private patch(update: Partial<MessengerViewState>) {
    this.state = { ...this.state, ...update };
    this.onChange(this.state);
  }
  private live(generation: number) { return this.running && generation === this.generation; }

  start(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.running && this.state.status === 'online') return this.state.error ? this.refresh() : Promise.resolve();
    this.running = true;
    const generation = this.generation;
    this.patch({ status: 'connecting', error: '' });
    this.connecting = (async () => {
      this.identityPromise ??= browserIdentity();
      this.identity = await this.identityPromise;
      if (!this.live(generation)) return;
      await this.identify(generation);
      if (this.live(generation)) await this.refresh();
    })().catch(error => {
      if (this.live(generation)) { this.patch({ status: 'offline', error: describe(error) }); throw error; }
    }).finally(() => {
      if (!this.live(generation)) return;
      this.connecting = undefined;
      this.schedule();
    });
    if (typeof window !== 'undefined') window.addEventListener?.('online', this.wake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.wake);
    return this.connecting;
  }

  private async identify(generation: number) {
    const { user } = await api<{ user: MessengerUser }>(`${BASE}/identity`, undefined, this.identity);
    if (this.live(generation)) this.patch({ self: user });
  }

  private wake = () => {
    if (!this.running || this.connecting || this.polling || (typeof document !== 'undefined' && document.hidden)) return;
    void this.tick();
  };
  private schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const active = this.state.activeId || this.state.transfers.some(ticket => ticket.status === 'pending');
    this.timer = setTimeout(() => { void this.tick(); }, hidden ? 30_000 : active ? 6_000 : 15_000);
  }
  private tick() {
    if (this.polling || this.connecting || !this.running) return;
    clearTimeout(this.timer);
    const generation = this.generation;
    this.polling = this.refresh(false).catch(() => {}).finally(() => {
      if (this.live(generation)) { this.polling = undefined; this.schedule(); }
    });
  }

  async refresh(force = true): Promise<void> {
    const generation = this.generation, revision = ++this.stateRevision;
    if (!this.running || !this.token) return;
    try {
      let snapshot: MessengerState | ConditionalState;
      const conditional = !force && this.stateTag && Date.now() < this.refreshAt;
      const path = conditional ? `${BASE}/state?since=${segment(this.stateTag!)}` : `${BASE}/state`;
      try {
        snapshot = await api<MessengerState | ConditionalState>(path, this.token);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401) || !this.live(generation)) throw error;
        // An expired account can rejoin using the same browser identity.
        await this.identify(generation);
        if (!this.live(generation)) return;
        snapshot = await api<MessengerState>(`${BASE}/state`, this.token);
      }
      if (!this.live(generation) || revision !== this.stateRevision) return;
      if ('unchanged' in snapshot) {
        this.stateTag = snapshot.revision; this.refreshAt = snapshot.refreshAt;
        if (this.state.status !== 'online' || this.state.error) this.patch({ status: 'online', error: '' });
        if (this.state.activeId && this.needsHistory) await this.latest(this.state.activeId);
        return;
      }
      this.stateTag = snapshot.revision;
      this.refreshAt = snapshot.refreshAt ?? 0;
      const { me, users, files, conversations, transfers } = snapshot;
      const active = this.state.activeId;
      const removed = active && !conversations.some(conversation => conversation.id === active);
      if (removed) { this.navigation++; this.olderPending = undefined; }
      this.patch({
        self: me, users, conversations, drive: files, transfers, status: 'online', error: '',
        ...(removed ? { activeId: null, messages: [], hasOlder: false, loadingHistory: false } : {}),
      });
      const room = conversations.find(conversation => conversation.id === active);
      if (active && room && this.state.activeId === active
        && (!conditional || this.needsHistory || room.revision === undefined || room.revision !== this.historyTag)) await this.latest(active);
    } catch (error) {
      if (this.live(generation) && revision === this.stateRevision) {
        this.patch({ status: 'offline', error: describe(error) }); throw error;
      }
    }
  }

  async openConversation(id: string | null): Promise<void> {
    this.intent++;
    this.navigation++;
    this.olderPending = undefined;
    this.needsHistory = true;
    const previous = this.state.activeId;
    if (previous !== id) { this.historyTag = undefined; this.historyHead = 0; }
    this.patch({ activeId: id, loadingHistory: Boolean(id),
      ...(previous !== id ? { messages: [], hasOlder: false } : {}) });
    if (id) await this.latest(id);
  }

  private async latest(id: string) {
    const navigation = this.navigation, revision = ++this.historyRevision;
    const tag = this.state.conversations.find(room => room.id === id)?.revision;
    this.needsHistory = true;
    const current = () => this.running && this.state.activeId === id && navigation === this.navigation && revision === this.historyRevision;
    try {
      const { messages, hasMore } = await api<History>(`${BASE}/conversations/${segment(id)}/messages`, this.token);
      if (!current()) return;
      const old = this.state.messages;
      const overlap = messages.length ? old.findIndex(message => message.id === messages[0].id) : -1;
      // A revision increment per inserted message lets us keep older pages for normal appends.
      // Other changes (such as deleting an attachment) can invalidate messages outside this page.
      const additions = messages.filter(message => message.sequence > this.historyHead).length;
      const revisedHistory = this.historyTag !== undefined && tag !== undefined
        && tag !== this.historyTag && tag - this.historyTag !== additions;
      const prefix = hasMore && overlap > 0 && !revisedHistory ? old.slice(0, overlap) : [];
      const knownUsers = new Set(this.state.users.map(person => person.id));
      const ownFiles = new Set(this.state.drive.map(file => file.id));
      const visible = prefix.flatMap(message => {
        if (!message.file) return [message];
        const valid = message.file.ownerId === this.state.self?.id ? ownFiles.has(message.file.id) : knownUsers.has(message.file.ownerId);
        if (valid) return [message];
        return message.text ? [{ ...message, file: undefined }] : [];
      });
      this.historyTag = tag; this.historyHead = messages.at(-1)?.sequence ?? 0; this.needsHistory = false;
      this.patch({ messages: [...visible, ...messages], hasOlder: prefix.length ? this.state.hasOlder : hasMore,
        loadingHistory: false });
    } catch (error) {
      if (current()) { this.patch({ loadingHistory: false, error: describe(error) }); throw error; }
    }
  }

  loadOlder(): Promise<void> {
    if (this.olderPending) return this.olderPending;
    const { activeId, messages, hasOlder } = this.state;
    if (!activeId || !messages.length || !hasOlder) return Promise.resolve();
    const navigation = this.navigation, first = messages[0];
    this.patch({ loadingHistory: true });
    this.olderPending = (async () => {
      try {
        const page = await api<History>(`${BASE}/conversations/${segment(activeId)}/messages?before=${first.sequence}`, this.token);
        if (this.navigation !== navigation || this.state.messages[0]?.id !== first.id) return;
        const seen = new Set(this.state.messages.map(message => message.id));
        this.patch({ messages: [...page.messages.filter(message => !seen.has(message.id)), ...this.state.messages], hasOlder: page.hasMore });
      } catch (error) {
        if (this.navigation === navigation) throw error;
      } finally {
        if (this.navigation === navigation) {
          this.olderPending = undefined; this.patch({ loadingHistory: false });
        }
      }
    })();
    return this.olderPending;
  }

  private async enter(path: string, body: object) {
    const intent = ++this.intent, generation = this.generation;
    const { conversation } = await api<{ conversation: MessengerConversation }>(path, this.token, body);
    if (this.live(generation)) {
      this.stateRevision++;
      this.patch({ conversations: replaceById(this.state.conversations, conversation) });
      if (this.intent === intent) await this.openConversation(conversation.id).catch(() => {});
    }
    return conversation;
  }
  openDirect(userId: string) { return this.enter(`${BASE}/conversations`, { userId }); }
  createGroup(userIds: string[]) { return this.enter(`${BASE}/conversations`, { userIds }); }
  invite(id: string, userIds: string[]) { return this.enter(`${BASE}/conversations/${segment(id)}/invite`, { userIds }); }

  async updateProfile(fields: Partial<Pick<MessengerUser, 'name' | 'avatar'>>) {
    const generation = this.generation;
    const { user } = await api<{ user: MessengerUser }>(`${BASE}/profile`, this.token, fields, 'PATCH');
    if (this.live(generation)) { this.stateRevision++; this.patch({ self: user }); }
    return user;
  }

  async registerFile(metadata: LocalFileMetadata) {
    const generation = this.generation;
    const { file } = await api<{ file: MessengerFile }>(`${BASE}/files`, this.token, metadata);
    if (this.live(generation)) { this.stateRevision++; this.patch({ drive: replaceById(this.state.drive, file) }); }
    return file;
  }
  async removeFile(id: string) {
    const generation = this.generation;
    await api(`${BASE}/files/${segment(id)}`, this.token, undefined, 'DELETE');
    if (this.live(generation)) {
      this.stateRevision++;
      this.patch({ drive: this.state.drive.filter(file => file.id !== id) });
      void this.refresh().catch(() => {});
    }
  }
  refreshDrive() { return this.refresh(); }

  async sendMessage(id: string, text: string, files: readonly (string | Pick<MessengerFile, 'id'>)[] = []) {
    const generation = this.generation;
    const fileIds = files.map(file => typeof file === 'string' ? file : file.id);
    if (!text.trim() && !fileIds.length) throw new Error('请输入消息或选择文件');
    const key = JSON.stringify([id, text, fileIds]);
    const nonces = this.unfinished.get(key) ?? Array.from({ length: Math.max(1, fileIds.length) }, () => randomHex(16));
    this.unfinished.set(key, nonces);
    try {
      const posted: MessengerMessage[] = [];
      for (const [index, nonce] of nonces.entries()) {
        const body = { text: index === 0 ? text : '', fileId: fileIds[index], nonce };
        const post = () => api<{ message: MessengerMessage }>(`${BASE}/conversations/${segment(id)}/messages`, this.token, body);
        let result;
        try { result = await post(); }
        catch (error) { if (error instanceof ApiError && error.status < 500) throw error; result = await post(); }
        posted.push(result.message);
        if (this.live(generation)) this.addMessage(result.message);
      }
      this.unfinished.delete(key);
      return posted;
    } finally {
      if (this.unfinished.size > 32) this.unfinished.delete(this.unfinished.keys().next().value!);
    }
  }

  private addMessage(message: MessengerMessage) {
    this.stateRevision++;
    const conversation = this.state.conversations.find(item => item.id === message.conversationId);
    const update: Partial<MessengerViewState> = {};
    if (conversation && (!conversation.lastMessage || conversation.lastMessage.sequence <= message.sequence)) {
      update.conversations = replaceById(this.state.conversations, { ...conversation, updatedAt: message.createdAt, lastMessage: message })
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (this.state.activeId === message.conversationId) {
      this.historyRevision++;
      update.messages = replaceById(this.state.messages, message).sort((a, b) => a.sequence - b.sequence);
      update.loadingHistory = false;
    }
    this.patch(update);
  }

  stop() {
    this.running = false; this.generation++; this.navigation++;
    clearTimeout(this.timer);
    this.polling = this.connecting = this.olderPending = undefined;
    if (typeof window !== 'undefined') window.removeEventListener?.('online', this.wake);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.wake);
  }
}
