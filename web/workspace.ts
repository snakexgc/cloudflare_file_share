import { MessengerClient } from '../src/client/messenger';
import { MessengerFiles } from '../src/client/messenger-files';
import type { PublicConfig } from '../src/client/config';
import type { MessengerConversation, MessengerFile, MessengerUser } from '../src/shared/messenger';
import type { ShareTransferMode } from '../src/shared/types';
import { avatar, conversationName, escapeHtml as esc, fileSymbol, formatSize, glyph, groupAvatar, iconButton, shortTime, welcome, type PageMode } from './workspace-view';
import { WorkspaceDialogs } from './workspace-dialogs';

type Attachment = { local?: File; file?: MessengerFile; metadata?: Awaited<ReturnType<MessengerFiles['prepare']>> };
type Draft = { text: string; files: Attachment[]; mode: ShareTransferMode; busy: boolean };
type InboxEntry = { person?: MessengerUser; chat?: MessengerConversation; title: string; preview: string; time: number; online: boolean };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function readPreference(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function savePreference(key: string, value: string) { try { localStorage.setItem(key,value); } catch { /* Optional UI preference. */ } }

export class Workspace {
  private client = new MessengerClient();
  private files?: MessengerFiles;
  private config?: PublicConfig;
  private userId?: string;
  private dialogs: WorkspaceDialogs;
  private filter: 'all' | 'online' | 'groups' = 'all';
  private activeChat?: string;
  private tab: 'messages' | 'files' = 'messages';
  private drafts = new Map<string, Draft>();
  private progress = new Map<string, string>();
  private driveSearch = '';
  private ascending = false;
  private current: PageMode = 'chat';
  private markup = new WeakMap<Element, string>();
  private notificationHeads = new Map<string, number>();
  private observedInitialState = false;
  private menu?: HTMLElement;
  private toastTimer?: ReturnType<typeof setTimeout>;

  constructor(private root: HTMLElement, private navigate: (page: PageMode) => void) {
    this.dialogs = new WorkspaceDialogs(this.client, {
      openChat: () => { this.navigate('chat'); this.focusChat(); },
      openDrive: () => this.navigate('drive'), notice: text => this.notice(text),
      attachDrive: file => { const draft = this.draft(); if (draft && !draft.busy && !draft.files.some(f => f.file?.id === file.id)) { draft.files.push({file}); this.renderDraft(); } },
      download: file => { void this.run(() => this.download(file)); },
    });
    this.renderDriveShell();
    this.client.onChange = () => this.render();
    this.root.addEventListener('click', this.click);
    document.addEventListener('keydown', this.shortcut);
    document.addEventListener('pointerdown', event => {
      if (this.menu && !(event.target as Element).closest('.im-popover,[data-menu-open]')) this.closeMenu();
    });
    this.updateBanner();
    this.render();
  }
  async start(config: PublicConfig) {
    this.config = config;
    await this.client.start();
  }
  stop() { this.files?.stop(); this.files = undefined; this.userId = undefined; this.client.stop(); }
  show(page: PageMode) {
    this.current = page;
    this.closeMenu();
    this.root.dataset.view = page;
    this.root.querySelector<HTMLElement>('.im-inbox')!.hidden = page !== 'chat';
    for (const [key,id] of Object.entries({chat:'chat-page', drive:'im-drive', share:'im-share', admin:'im-admin'})) el(id).hidden = page !== key;
    this.root.querySelectorAll<HTMLElement>('[data-page-mode]').forEach(a => {
      if (a.dataset.pageMode === page) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    });
    document.title = `${{chat:'消息',drive:'云盘',share:'链接分享',admin:'管理台'}[page]} · 临时传`;
    this.render();
  }
  private draw(node: HTMLElement, html: string) {
    if (this.markup.get(node) === html) return false;
    this.markup.set(node, html); node.innerHTML = html; return true;
  }
  private people() {
    const {self,users} = this.client.state;
    const map = new Map(users.map(person => [person.id, person]));
    if (self) map.set(self.id,self);
    return map;
  }
  private draft() {
    const id = this.client.state.activeId;
    if (!id) return;
    let draft = this.drafts.get(id);
    if (!draft) { draft = {text:'', files:[], mode:'auto',busy:false}; this.drafts.set(id,draft); }
    return draft;
  }
  private async run(work: () => Promise<unknown>) {
    try { await work(); } catch (error) { this.notice(error instanceof Error ? error.message : String(error)); }
  }
  private notice(message: string) {
    const toast = el('toast'); toast.textContent = message; toast.classList.add('visible');
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => toast.classList.remove('visible'), 4400);
  }
  private updateBanner() {
    el('im-banner').hidden = !('Notification' in window) || Notification.permission !== 'default' || readPreference('im.banner.dismissed') === '1';
  }
  private notices() {
    const {self,conversations,status} = this.client.state;
    if (status !== 'online') return;
    const people = this.people();
    for (const c of conversations) {
      const m = c.lastMessage;
      if (!m || (this.notificationHeads.get(c.id) ?? -1) >= m.sequence) continue;
      if (this.observedInitialState && document.hidden && m.senderId !== self?.id && 'Notification' in window && Notification.permission === 'granted') {
        try { const n = new Notification(conversationName(c,people,self?.id), {body:m.file ? '发来一个文件' : '发来一条新消息',tag:c.id}); n.onclick = () => { window.focus(); this.navigate('chat'); void this.run(() => this.client.openConversation(c.id)); this.focusChat(); n.close(); }; } catch { /* Some mobile browsers require a service worker for native notifications. */ }
      }
      this.notificationHeads.set(c.id,m.sequence);
    }
    this.observedInitialState = true;
  }
  private render() {
    const s = this.client.state;
    if (s.self && this.config && this.userId !== s.self.id) {
      this.files?.stop(); this.drafts.clear(); this.progress.clear(); this.notificationHeads.clear(); this.observedInitialState = false; this.userId = s.self.id;
      this.files = new MessengerFiles(s.self.id,this.client.token,this.config);
      this.files.onNotice = text => this.notice(text);
      this.files.onProgress = (id,label,bytes,mode,finished) => {
        this.progress.set(id,[label,bytes ? formatSize(bytes) : '',mode?.toUpperCase()].filter(Boolean).join(' · '));
        this.renderFileStatus(id,finished);
      };
    }
    this.files?.observe(s.transfers);
    this.draw(this.root.querySelector('.im-me')!, avatar(s.self ?? undefined));
    this.draw(el('im-connection'), s.error ? `${esc(s.error)} <button data-action="retry">重新连接</button>` : '');
    el('im-connection').hidden = !s.error;
    if (this.current === 'chat') { this.renderInbox(); this.renderChat(); }
    if (this.current === 'drive') this.renderDrive();
    this.dialogs.refresh();
    this.notices();
  }
  private inboxEntries(): InboxEntry[] {
    const s = this.client.state, people = this.people(), entries: InboxEntry[] = [];
    const direct = new Map<string,MessengerConversation>();
    for (const chat of s.conversations) {
      if (chat.kind === 'dm') {
        const peer = chat.memberIds.find(id => id !== s.self?.id);
        if (peer) direct.set(peer,chat);
      } else entries.push({chat,title:conversationName(chat,people,s.self?.id),preview:this.preview(chat) || `${chat.memberIds.length} 位成员`,time:chat.updatedAt,online:false});
    }
    for (const person of people.values()) {
      if (person.id === s.self?.id) continue;
      const chat = direct.get(person.id);
      entries.push({person,chat,title:person.name,preview:this.preview(chat) || (person.online ? '在线' : '离线 · '+shortTime(person.lastSeen)),time:chat?.lastMessage?.createdAt ?? 0,online:person.online});
    }
    return entries.filter(e => this.filter === 'all' || (this.filter === 'online' ? e.online : e.chat?.kind === 'group'))
      .sort((a,b) => b.time-a.time || Number(b.online)-Number(a.online) || a.title.localeCompare(b.title,'zh-CN'));
  }
  private preview(c?: MessengerConversation) { const m = c?.lastMessage; return m?.file ? `[文件] ${m.file.name}` : m?.text ?? ''; }
  private renderInbox() {
    const s = this.client.state, people = this.people(), entries = this.inboxEntries();
    el('im-filter-label').textContent = {all:'消息',online:'在线用户',groups:'群聊'}[this.filter];
    this.draw(el('im-rows'), entries.length ? entries.map(({person,chat,title,preview,time}) => {
      const active = chat?.id && chat.id === s.activeId;
      return `<button class="im-row${active?' selected':''}" ${active?'aria-current="true"':''} ${chat ? `data-chat="${esc(chat.id)}"` : `data-person="${esc(person!.id)}"`}>
        ${person ? avatar(person,true) : groupAvatar(chat!.memberIds.map(id => people.get(id)))}<span class="im-row-data"><span class="im-row-top"><span class="im-row-name">${esc(title)}</span>${time?`<time>${shortTime(time)}</time>`:''}</span><span class="im-row-preview">${esc(preview)}</span></span></button>`;
    }).join('') : `<div class="im-list-empty">${glyph(this.filter === 'groups' ? 'group' : 'chat',26)}<p>${s.status === 'connecting' ? '正在连接…' : this.filter === 'groups' ? '暂无群聊' : this.filter === 'online' ? '暂无其他在线用户' : '暂无其他用户'}</p>${s.status === 'online' && this.filter !== 'groups' ? '<button data-action="copy-address">复制邀请链接</button>' : ''}</div>`);
  }
  private focusChat() { this.root.classList.add('im-mobile-chat'); }
  private renderChat() {
    const s = this.client.state, c = s.conversations.find(c => c.id === s.activeId);
    if (!c) { this.activeChat = undefined; this.root.classList.remove('im-mobile-chat'); this.draw(el('chat-page'), welcome()); return; }
    const people = this.people(), title = conversationName(c,people,s.self?.id);
    if (this.activeChat !== c.id) {
      this.tab = 'messages'; this.activeChat = c.id;
      this.draw(el('chat-page'), `<div class="im-chat-head" id="im-chat-head"></div><div id="im-history" class="im-history" aria-label="聊天记录"></div>
        <div class="im-compose-wrap"><div class="im-compose" id="im-compose"><div id="im-staged"></div><textarea id="im-text" aria-label="消息内容" rows="2"></textarea>
        <div class="im-tools"><div class="im-tools-left">${iconButton('emoji','表情','smile')}${iconButton('attach','添加本地文件','attach')}${iconButton('from-drive','从云盘选择文件','folder')}${iconButton('mode','文件传输方式','sliders')}<span id="im-mode-label"></span></div><button class="im-send" data-action="send" title="发送 (Enter)" aria-label="发送消息">${glyph('send',17)}</button></div></div></div><input id="im-file-input" type="file" multiple hidden>`);
      const input = el<HTMLTextAreaElement>('im-text');
      input.value = this.draft()!.text;
      input.oninput = () => { const d = this.draft(); if (d) { d.text = input.value; this.renderDraft(); } };
      input.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void this.run(() => this.send()); }
      };
      el<HTMLInputElement>('im-file-input').onchange = event => { const input = event.target as HTMLInputElement; this.stage(input.files); input.value=''; };
      const panel = el('chat-page');
      panel.ondragover = e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); panel.classList.add('im-drag'); } };
      panel.ondragleave = e => { if (!panel.contains(e.relatedTarget as Node)) panel.classList.remove('im-drag'); };
      panel.ondrop = e => { e.preventDefault(); panel.classList.remove('im-drag'); this.stage(e.dataTransfer?.files); };
    }
    const peer = people.get(c.memberIds.find(id => id !== s.self?.id) || '');
    this.draw(el('im-chat-head'), `<div class="im-head-inner"><button data-action="back" class="im-back im-icon-button" aria-label="返回消息列表">${glyph('back')}</button>
      ${c.kind === 'group' ? groupAvatar(c.memberIds.map(id => people.get(id))) : avatar(peer)}
      <div class="im-head-text"><div class="im-title-line"><strong>${esc(title)}</strong><span>${c.kind === 'group' ? c.memberIds.length+' 位成员' : peer?.online ? '在线' : '离线'}</span></div>
      <div class="im-tabs"><button data-action="messages-tab" aria-pressed="${this.tab === 'messages'}">${glyph('chat',13)}消息</button><button data-action="files-tab" aria-pressed="${this.tab === 'files'}">${glyph('folder',13)}文件</button></div></div>
      <div class="im-head-tools">${iconButton('invite','添加成员','invite')}${iconButton('members','会话成员','more')}</div></div>`);
    el<HTMLTextAreaElement>('im-text').placeholder = `发送给 ${title}`;
    el('im-compose').parentElement!.hidden = this.tab !== 'messages';
    this.renderHistory(); this.renderDraft();
  }
  private fileCard(f: MessengerFile) {
    const status = this.progress.get(f.id);
    const owner = this.people().get(f.ownerId);
    return `<button class="im-file-card" data-download="${esc(f.id)}" title="下载 ${esc(f.name)}">${fileSymbol(f)}<span><strong>${esc(f.name)}</strong><small>${formatSize(f.size)} · ${owner && !owner.online ? '发送者离线' : f.transferMode === 'lan' ? '内网直传' : '按需传输'}</small><small class="im-file-progress" data-progress="${esc(f.id)}" ${status?'':'hidden'}>${esc(status || '')}</small></span>${glyph('download',16)}</button>
      <button class="im-cancel-download" data-cancel-file="${esc(f.id)}" ${this.files?.busy(f.id)?'':'hidden'}>取消下载</button>`;
  }
  private renderHistory() {
    const s = this.client.state, box = el('im-history'), people = this.people();
    const sticky = box.scrollHeight-box.clientHeight-box.scrollTop < 55;
    const anchor = Array.from(box.querySelectorAll<HTMLElement>('[data-message]')).find(row => row.offsetTop + row.offsetHeight >= box.scrollTop);
    const delta = anchor ? anchor.offsetTop-box.scrollTop : 0;
    let previous = -Infinity;
    const html = s.messages.filter(m => this.tab === 'messages' || m.file).map(m => {
      const person = people.get(m.senderId), mine = m.senderId === s.self?.id;
      const divider = m.createdAt - previous > 5*60000; previous = m.createdAt;
      return `${divider?`<div class="im-date">${shortTime(m.createdAt)}</div>`:''}<article class="im-message${mine?' mine':''}" data-message="${esc(m.id)}">${avatar(person)}<div class="im-message-content"><span class="im-author">${esc(person?.name ?? '已离开的用户')}</span>
        ${m.text && this.tab === 'messages' ? `<div class="im-bubble">${esc(m.text)}</div>` : ''}${m.file ? this.fileCard(m.file) : ''}</div></article>`;
    }).join('');
    const older = s.hasOlder ? `<button class="im-older" data-action="older" ${s.loadingHistory?'disabled':''}>加载更早的消息</button>` : '';
    if (this.draw(box,older + (html || `<p class="im-history-empty">${s.loadingHistory ? '正在读取…' : this.tab === 'files' ? '此会话暂无文件' : '暂无聊天记录'}</p>`))) {
      const target = anchor && Array.from(box.querySelectorAll<HTMLElement>('[data-message]')).find(row => row.dataset.message === anchor.dataset.message);
      if (target && (!sticky || box.querySelector('[data-message]')?.getAttribute('data-message') !== anchor.dataset.message && delta >= 0)) box.scrollTop = target.offsetTop-delta;
      else if (sticky) box.scrollTop = box.scrollHeight;
    }
  }
  private stage(files?: FileList | null) {
    const draft = this.draft(); if (!draft || draft.busy || !files) return;
    for (const file of Array.from(files)) {
      if (this.config && file.size > this.config.limits.maxFileBytes) { this.notice('文件超过单文件大小限制'); continue; }
      draft.files.push({local:file});
    }
    this.tab = 'messages'; this.renderChat(); el<HTMLTextAreaElement>('im-text').focus();
  }
  private renderDraft() {
    const d = this.draft(); if (!d || !el('im-compose')) return;
    this.draw(el('im-staged'), d.files.map((a,i) => `<span class="im-chip">${glyph('file',15)}<span>${esc(a.file?.name || a.local?.name || '')}</span><button data-remove="${i}" aria-label="移除附件" ${d.busy?'disabled':''}>${glyph('close',12)}</button></span>`).join(''));
    this.root.querySelector<HTMLButtonElement>('.im-send')!.disabled = d.busy || (!d.text.trim() && !d.files.length) || this.client.state.status !== 'online';
    el<HTMLTextAreaElement>('im-text').disabled = d.busy;
    el('im-mode-label').textContent = d.busy ? '发送中…' : d.mode === 'lan' ? '内网直传' : '';
  }
  private async send() {
    const d = this.draft(), id = this.client.state.activeId, files = this.files;
    if (!files || !id || !d || d.busy || this.client.state.status !== 'online' || (!d.text.trim() && !d.files.length)) return;
    d.busy = true; this.renderDraft();
    try {
      for (const a of d.files) {
        if (a.file || !a.local) continue;
        a.metadata ??= await files.prepare(a.local,d.mode);
        a.file = await this.client.registerFile(a.metadata);
      }
      await this.client.sendMessage(id,d.text.trim(),d.files.map(a=>a.file!.id));
      d.text = ''; d.files = [];
      if (this.client.state.activeId === id) { el<HTMLTextAreaElement>('im-text').value = ''; el('im-history').scrollTop = el('im-history').scrollHeight; }
    } finally {
      d.busy = false;
      if (this.client.state.activeId === id) { this.renderDraft(); if (this.current === 'chat') el<HTMLTextAreaElement>('im-text').focus(); }
    }
  }
  private renderDriveShell() {
    el('im-drive').innerHTML = `<aside class="im-drive-nav"><h2>${glyph('folder',21)}云盘</h2><button class="im-drive-active" data-action="all-files">${glyph('folder',17)}我的文件</button><a href="/send" data-page-mode="share">${glyph('link',17)}链接分享</a></aside>
      <div class="im-drive-main"><div class="im-drive-top"><h1>我的文件</h1><label class="im-drive-search">${glyph('search',16)}<input id="im-drive-q" aria-label="搜索我的文件" placeholder="搜索文件"></label></div>
      <p class="im-drive-note">${glyph('info',16)}聊天中发送的文件会出现在这里。对方下载时，请保持发送设备在线。</p>
      <div class="im-file-list"><div class="im-table-head"><span>文件名</span><span>大小</span><button data-action="sort">发送时间 ${glyph('down',13)}</button><span></span></div><div id="im-drive-rows"></div></div></div>`;
    el<HTMLInputElement>('im-drive-q').oninput = e => { this.driveSearch = (e.target as HTMLInputElement).value; this.renderDrive(); };
  }
  private renderDrive() {
    const files = this.client.state.drive.filter(f => f.name.toLocaleLowerCase().includes(this.driveSearch.trim().toLocaleLowerCase()))
      .sort((a,b) => this.ascending ? a.createdAt-b.createdAt : b.createdAt-a.createdAt);
    this.draw(el('im-drive-rows'), files.length ? files.map(f => `<div class="im-table-row"><span>${fileSymbol(f)}<span class="im-table-name">${esc(f.name)}<small data-progress="${esc(f.id)}">${esc(this.progress.get(f.id) || '')}</small></span></span>
      <span>${formatSize(f.size)}</span><span>${shortTime(f.createdAt)}</span><button class="im-icon-button" data-download="${esc(f.id)}" aria-label="下载 ${esc(f.name)}" title="下载">${glyph('download',17)}</button></div>`).join('') :
      `<div class="im-drive-empty"><span class="im-empty-folder">${glyph(this.driveSearch?'search':'folder',43)}</span><strong>${this.driveSearch?'未找到文件':'暂无文件'}</strong><p>${this.driveSearch?'试试其他文件名':'在聊天中发送第一个文件，即可在这里查看。'}</p></div>`);
    this.root.querySelector('[data-action="sort"]')!.classList.toggle('ascending',this.ascending);
  }
  private renderFileStatus(id: string, finished = false) {
    for (const n of Array.from(this.root.querySelectorAll<HTMLElement>('[data-progress]'))) if (n.dataset.progress === id) { n.textContent=this.progress.get(id) ?? ''; n.hidden=false; }
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-cancel-file]'))) if (button.dataset.cancelFile === id) button.hidden = finished || !this.files?.busy(id);
  }
  private async download(file: MessengerFile) {
    if (!this.files) throw new Error('正在连接文件服务');
    const owner = this.people().get(file.ownerId);
    if (owner && !owner.online) throw new Error('发送者已离线，请在对方上线后下载。');
    await this.files.download(file, file.ownerId === this.userId ? undefined : this.client.state.activeId ?? undefined);
  }
  private closeMenu() { this.menu?.remove(); this.menu=undefined; this.root.querySelector('[data-menu-open]')?.removeAttribute('data-menu-open'); }
  private popover(button: HTMLElement, options: [string,string][], selected?: string, emoji = false) {
    const wasOpen = button.hasAttribute('data-menu-open');
    this.closeMenu(); if (wasOpen) return;
    const menu = document.createElement('div'); menu.className = 'im-popover' + (emoji?' im-emoji-menu':''); menu.setAttribute('role','group');
    menu.innerHTML = options.map(([action,label]) => `<button data-action="${action}" class="${selected===action?'chosen':''}">${esc(label)}${selected===action?glyph('check',14):''}</button>`).join('');
    button.setAttribute('data-menu-open',''); button.parentElement!.appendChild(menu); this.menu = menu;
    menu.querySelector('button')?.focus();
  }
  private shortcut = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.dialogs.search(); }
    if (e.key === 'Escape' && this.menu) { const button = this.root.querySelector<HTMLElement>('[data-menu-open]'); this.closeMenu(); button?.focus(); }
  };
  private click = (event: MouseEvent) => {
    const b = (event.target as Element).closest<HTMLElement>('button'); if (!b || b.closest('dialog')) return;
    const action = b.dataset.action;
    const s = this.client.state, c = s.conversations.find(c=>c.id === s.activeId);
    if (b.dataset.cancelFile && this.files) { void this.run(() => this.files!.cancel(b.dataset.cancelFile!)); return; }
    if (b.dataset.chat || b.dataset.person) {
      void this.run(async () => {
        const chatId = b.dataset.chat;
        if (chatId) { this.focusChat(); await this.client.openConversation(chatId); }
        else {
          const chat = await this.client.openDirect(b.dataset.person!);
          if (this.current === 'chat' && this.client.state.activeId === chat.id) this.focusChat();
        }
      }); return;
    }
    if (b.dataset.download) {
      const f = s.drive.find(f=>f.id === b.dataset.download) ?? s.messages.find(m=>m.file?.id === b.dataset.download)?.file;
      if (f) void this.run(()=>this.download(f)); return;
    }
    const d = this.draft();
    if (b.dataset.remove !== undefined && d && !d.busy) { d.files.splice(Number(b.dataset.remove),1); this.renderDraft(); return; }
    if (!action) return;
    if (action.startsWith('filter-')) { this.filter = action.slice(7) as typeof this.filter; this.closeMenu(); this.renderInbox(); return; }
    if (action.startsWith('set-mode-') && d) { d.mode = action.endsWith('lan')?'lan':'auto'; this.closeMenu(); this.renderDraft(); return; }
    if (action.startsWith('insert-') && d) { const input = el<HTMLTextAreaElement>('im-text'); this.closeMenu(); input.setRangeText(action.slice(7),input.selectionStart,input.selectionEnd,'end'); d.text=input.value; input.focus(); this.renderDraft(); return; }
    switch (action) {
      case 'filter': this.popover(b,[['filter-all','全部消息'],['filter-online','在线用户'],['filter-groups','群聊']], 'filter-'+this.filter); break;
      case 'search': this.dialogs.search(); break;
      case 'new-chat': this.dialogs.people(); break;
      case 'profile': if (s.self) this.dialogs.profile(); else this.notice('正在连接个人资料'); break;
      case 'invite': if (c) this.dialogs.people(c); break;
      case 'members': if (c) this.dialogs.members(c); break;
      case 'back': this.root.classList.remove('im-mobile-chat'); void this.client.openConversation(null); break;
      case 'messages-tab': case 'files-tab': this.tab = action==='files-tab'?'files':'messages'; this.renderChat(); break;
      case 'send': void this.run(()=>this.send()); break;
      case 'attach': if (!d?.busy) el('im-file-input').click(); break;
      case 'from-drive': if (!d?.busy) this.dialogs.pickDrive(); break;
      case 'mode': if (!d?.busy) this.popover(b,[['set-mode-auto','自动传输'],['set-mode-lan','仅内网直传']], 'set-mode-'+d?.mode); break;
      case 'emoji': if (!d?.busy) this.popover(b,['😊','👍','❤️','🎉','👏','🚀','✅','🙏','👋','😂','✨','🤝'].map(e=>['insert-'+e,e]),undefined,true); break;
      case 'older': void this.run(()=>this.client.loadOlder()); break;
      case 'all-files': this.driveSearch=''; el<HTMLInputElement>('im-drive-q').value=''; this.renderDrive(); break;
      case 'sort': this.ascending=!this.ascending; this.renderDrive(); break;
      case 'dismiss-banner': savePreference('im.banner.dismissed','1'); this.updateBanner(); break;
      case 'notifications': void this.run(async()=>{ const permission=await Notification.requestPermission(); this.updateBanner(); this.notice(permission==='granted'?'消息通知已开启':'可在浏览器的网站设置中开启消息通知'); }); break;
      case 'copy-address': void this.run(async()=>{ await navigator.clipboard.writeText(new URL('/', location.origin).href); this.notice('邀请链接已复制'); }); break;
      case 'retry': void this.run(()=>this.client.start()); break;
    }
  };
}
