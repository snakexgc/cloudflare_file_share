import './workspace-dialogs.css';
import { chatName } from '../src/shared/chat';
import type { MessengerClient } from '../src/client/messenger';
import { MESSENGER_PLAZA_ID, type MessengerConversation, type MessengerFile, type MessengerUser } from '../src/shared/messenger';
import { avatar, conversationName, escapeHtml, fileSymbol, formatSize, glyph, groupAvatar } from './workspace-view';

type DialogActions = {
  openChat(): void;
  openDrive(): void;
  notice(message: string): void;
  attachDrive(file: MessengerFile): void;
  download(file: MessengerFile): void;
};

const presets = [['🐼', '熊猫'], ['🐱', '小猫'], ['🦊', '狐狸'], ['🐧', '企鹅'], ['🌻', '向日葵'], ['🌙', '月亮']];
const norm = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const status = (user?: MessengerUser) => user?.online ? '在线' : '离线';
const copy = (title: string, note: string) => `<span class="imd-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(note)}</small></span>`;
const empty = (message: string) => `<p class="imd-empty">${escapeHtml(message)}</p>`;
const searchField = (label: string) => `<label class="imd-search">${glyph('search', 16)}<input type="search" autofocus placeholder="${label}" aria-label="${label}"></label>`;
const buttons = (label: string) => `<div class="imd-footer"><button type="button" class="imd-button" data-im-close>取消</button><button class="imd-button imd-primary" type="submit">${label}</button></div>`;

async function loadImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}

/** Crop locally in source-image coordinates. Keyboard arrows and pointer dragging share the same bounds. */
function cropAvatar(image: HTMLImageElement, canvas: HTMLCanvasElement, zoom: HTMLInputElement) {
  let centerX = image.naturalWidth / 2, centerY = image.naturalHeight / 2;
  const width = () => Math.min(image.naturalWidth, image.naturalHeight) / Number(zoom.value);
  const context = canvas.getContext('2d')!;
  const draw = () => {
    const size = width(), half = size / 2;
    centerX = Math.max(half, Math.min(image.naturalWidth - half, centerX));
    centerY = Math.max(half, Math.min(image.naturalHeight - half, centerY));
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, centerX - half, centerY - half, size, size, 0, 0, canvas.width, canvas.height);
  };
  let dragging: { id: number; x: number; y: number } | undefined;
  canvas.onpointerdown = event => {
    canvas.setPointerCapture(event.pointerId);
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  canvas.onpointermove = event => {
    if (!dragging || dragging.id !== event.pointerId) return;
    const scale = width() / canvas.clientWidth;
    centerX += (dragging.x - event.clientX) * scale; centerY += (dragging.y - event.clientY) * scale;
    dragging.x = event.clientX; dragging.y = event.clientY; draw();
  };
  canvas.onlostpointercapture = () => { dragging = undefined; };
  canvas.onkeydown = event => {
    const amount = width() * .04;
    switch (event.key) {
      case 'ArrowLeft': centerX -= amount; break;
      case 'ArrowRight': centerX += amount; break;
      case 'ArrowUp': centerY -= amount; break;
      case 'ArrowDown': centerY += amount; break;
      default: return;
    }
    event.preventDefault(); draw();
  };
  zoom.value = '1'; zoom.oninput = draw; draw();
  return () => {
    for (const quality of [.88, .72, .5]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.split(',')[1].length <= 32_768) return data;
    }
    throw new Error('头像图片过大，请重新选择');
  };
}

export class WorkspaceDialogs {
  constructor(private client: MessengerClient, private actions: DialogActions) {}
  private updateResults?: () => void;
  private get dialog() { return document.querySelector<HTMLDialogElement>('#im-dialog')!; }
  private el<T extends HTMLElement>(selector: string) { return this.dialog.querySelector<T>(selector)!; }
  refresh() { if (this.dialog.open) this.updateResults?.(); }
  private renderList(list: HTMLElement) {
    let previous: string | undefined;
    return (html: string) => {
      if (html === previous) return;
      previous = html;
      const focus = document.activeElement;
      const before = focus instanceof HTMLElement && list.contains(focus) ? focus : null;
      const key = before instanceof HTMLInputElement ? before.value : before?.dataset.id ?? before?.dataset.file;
      list.innerHTML = html;
      if (key) {
        const escaped = CSS.escape(key);
        list.querySelector<HTMLElement>(`[value="${escaped}"],[data-id="${escaped}"],[data-file="${escaped}"]`)?.focus({ preventScroll: true });
      }
    };
  }
  private users() {
    const { users, self } = this.client.state;
    return new Map((self ? [self, ...users] : users).map(person => [person.id, person]));
  }
  private show(title: string, contents: string) {
    const dialog = this.dialog;
    this.updateResults = undefined;
    dialog.setAttribute('aria-labelledby', 'imd-title');
    dialog.innerHTML = `<div class="imd-shell"><div class="imd-head"><h2 id="imd-title">${title}</h2><button type="button" class="imd-close" data-im-close aria-label="关闭">${glyph('close', 18)}</button></div>${contents}<p class="imd-error" role="alert" hidden></p></div>`;
    dialog.querySelectorAll<HTMLButtonElement>('[data-im-close]').forEach(button => { button.onclick = () => dialog.close(); });
    dialog.onclick = event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    };
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[autofocus]')?.focus();
    return this.el<HTMLElement>('.imd-shell');
  }
  private error(shell: HTMLElement, error?: unknown) {
    if (!this.dialog.open || !shell.isConnected) return;
    const output = shell.querySelector<HTMLElement>('.imd-error')!;
    output.textContent = error instanceof Error ? error.message : error ? String(error) : '';
    output.hidden = !output.textContent;
  }
  private async submit(shell: HTMLElement, action: () => Promise<unknown>, done?: () => void) {
    if (shell.hasAttribute('aria-busy')) return;
    shell.setAttribute('aria-busy', 'true'); this.error(shell);
    const submit = shell.querySelector<HTMLButtonElement>('button[type=submit]');
    if (submit) submit.disabled = true;
    try {
      await action();
      if (shell.isConnected && this.dialog.open) { this.dialog.close(); done?.(); }
    } catch (error) { this.error(shell, error); }
    finally { shell.removeAttribute('aria-busy'); if (submit) submit.disabled = false; }
  }

  profile() {
    const self = this.client.state.self;
    if (!self) { this.actions.notice('正在连接，请稍后再试'); return; }
    const shell = this.show('个人资料', `<form class="imd-form"><div class="imd-profile">
      <div class="imd-photo">${avatar(self)}</div><div><span class="imd-field-label">头像</span><button class="imd-button imd-upload" type="button">${glyph('upload', 15)}选择图片</button><input class="imd-image-input" type="file" accept="image/jpeg,image/png,image/webp" hidden></div>
      </div><div class="imd-crop" hidden><canvas width="112" height="112" tabindex="0" aria-label="头像裁剪区域，用方向键调整取景"></canvas><div><label>缩放<input aria-label="头像缩放" type="range" min="1" max="3" step="0.05" value="1"></label><small>拖动图片或用方向键调整位置</small></div></div>
      <div class="imd-presets" role="group" aria-label="预设头像">${presets.map(([icon, name]) => `<button type="button" data-avatar="${icon}" title="${name}" aria-label="${name}" aria-pressed="${icon === self.avatar}">${icon}</button>`).join('')}</div>
      <label class="imd-field"><span class="imd-field-label">用户名</span><input name="name" autocomplete="nickname" autofocus required value="${escapeHtml(self.name)}"></label>
      ${buttons('保存')}</form>`);
    const picture = this.el<HTMLInputElement>('.imd-image-input'), crop = this.el<HTMLElement>('.imd-crop');
    const form = this.el<HTMLFormElement>('form'), name = form.elements.namedItem('name') as HTMLInputElement;
    name.oninput = () => name.setCustomValidity('');
    let chosen = self.avatar, serialize: (() => string) | undefined, imageGeneration = 0, decoding = false;
    this.el<HTMLButtonElement>('.imd-upload').onclick = () => picture.click();
    picture.onchange = async () => {
      const file = picture.files?.[0];
      if (!file) return;
      const generation = ++imageGeneration;
      decoding = true; this.error(shell);
      try {
        const image = await loadImage(file);
        if (generation !== imageGeneration || !shell.isConnected) return;
        crop.hidden = false;
        serialize = cropAvatar(image, this.el('canvas'), this.el('input[type=range]'));
        this.el<HTMLElement>('.imd-photo').innerHTML = avatar({ ...self, avatar: serialize() });
        shell.querySelectorAll('[data-avatar]').forEach(button => button.setAttribute('aria-pressed', 'false'));
      } catch (error) { this.error(shell, error); }
      finally { if (generation === imageGeneration) decoding = false; picture.value = ''; }
    };
    shell.querySelectorAll<HTMLButtonElement>('[data-avatar]').forEach(button => {
      button.onclick = () => {
        imageGeneration++; decoding = false; chosen = button.dataset.avatar!; serialize = undefined; crop.hidden = true;
        this.el<HTMLElement>('.imd-photo').innerHTML = avatar({ ...self, avatar: chosen });
        shell.querySelectorAll('[data-avatar]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); this.error(shell);
      };
    });
    form.onsubmit = event => {
      event.preventDefault();
      if (decoding) { this.error(shell, '正在读取图片，请稍候'); return; }
      const normalized = chatName(name.value)?.name;
      if (!normalized) {
        name.setCustomValidity('用户名需要 1 至 20 个字符，请移除控制字符及尖括号');
        name.reportValidity(); return;
      }
      void this.submit(shell, async () => {
        const picture = serialize ? serialize() : chosen;
        const fields = { ...(normalized !== self.name ? { name: normalized } : {}), ...(picture !== self.avatar ? { avatar: picture } : {}) };
        if (Object.keys(fields).length) await this.client.updateProfile(fields);
      },
        () => this.actions.notice('个人资料已保存'));
    };
  }

  people(conversation?: MessengerConversation) {
    const picked = new Set<string>();
    const shell = this.show(conversation ? '邀请成员' : '发起聊天', `<form class="imd-form">${searchField('搜索联系人')}<div class="imd-list"></div>${buttons(conversation ? '邀请' : '开始聊天')}</form>`);
    const list = this.el<HTMLElement>('.imd-list'), search = this.el<HTMLInputElement>('input[type=search]');
    const showMatches = this.renderList(list);
    const submit = this.el<HTMLButtonElement>('button[type=submit]');
    const update = () => {
      submit.disabled = !picked.size;
      submit.textContent = conversation ? picked.size ? `邀请（${picked.size}）` : '邀请' : picked.size > 1 ? `发起群聊（${picked.size}）` : '开始聊天';
    };
    const render = () => {
      const memberIds = this.client.state.conversations.find(item => item.id === conversation?.id)?.memberIds;
      if (conversation && !memberIds) { this.dialog.close(); return; }
      const candidates = this.client.state.users.filter(user => !memberIds?.includes(user.id));
      for (const id of picked) if (!candidates.some(user => user.id === id)) picked.delete(id);
      const matches = candidates.filter(user => norm(user.name).includes(norm(search.value)));
      showMatches(matches.map(user => `<label class="imd-row imd-person">${avatar(user, true)}${copy(user.name, status(user))}<input type="checkbox" value="${escapeHtml(user.id)}" ${picked.has(user.id) ? 'checked' : ''}></label>`).join('')
        || empty(search.value ? '没有找到联系人' : conversation ? '暂无可邀请的联系人' : '其他人打开此页面后，会出现在这里'));
      if (!shell.hasAttribute('aria-busy')) update();
    };
    list.onchange = event => {
      const input = event.target as HTMLInputElement;
      if (input.checked) picked.add(input.value); else picked.delete(input.value);
      update();
    };
    search.oninput = this.updateResults = render; render();
    this.el<HTMLFormElement>('form').onsubmit = event => {
      event.preventDefault(); if (!picked.size) return;
      const ids = [...picked];
      void this.submit(shell, () => conversation ? this.client.invite(conversation.id, ids)
        : ids.length === 1 ? this.client.openDirect(ids[0]) : this.client.createGroup(ids), this.actions.openChat);
    };
  }

  members(conversation: MessengerConversation) {
    const invite = conversation.id === MESSENGER_PLAZA_ID ? '' : `<div class="imd-footer"><button type="button" class="imd-button imd-primary imd-invite">${glyph('invite', 16)}邀请成员</button></div>`;
    this.show('会话成员', `<div class="imd-list imd-member-list"></div>${invite}`);
    const update = this.renderList(this.el('.imd-member-list'));
    const button = this.dialog.querySelector<HTMLButtonElement>('.imd-invite');
    if (button) button.onclick = () => this.people(conversation);
    this.updateResults = () => {
      const current = this.client.state.conversations.find(item => item.id === conversation.id);
      if (!current) { this.dialog.close(); return; }
      const users = this.users();
      this.el('#imd-title').textContent = `会话成员（${current.memberIds.length}）`;
      update(current.memberIds.map(id => {
        const user = users.get(id);
        return `<div class="imd-row">${avatar(user, true)}${copy(user?.name ?? '已离开的用户', id === this.client.state.self?.id ? '我' : status(user))}</div>`;
      }).join(''));
    };
    this.updateResults();
  }

  search() {
    const shell = this.show('搜索', `${searchField('搜索联系人、群聊或文件')}<div class="imd-list imd-search-results"></div>`);
    const input = this.el<HTMLInputElement>('input'), list = this.el<HTMLElement>('.imd-list');
    const showMatches = this.renderList(list);
    const result = (type: string, id: string, icon: string, title: string, note: string) =>
      `<button type="button" class="imd-row" data-type="${type}" data-id="${escapeHtml(id)}">${icon}${copy(title, note)}${type === 'file' ? glyph('download', 16) : ''}</button>`;
    const section = (title: string, rows: string[]) => rows.length ? `<h3>${title}</h3>${rows.join('')}` : '';
    const render = () => {
      const { drive, conversations, self, users } = this.client.state, people = this.users(), query = norm(input.value);
      const match = (name: string) => norm(name).includes(query);
      const contacts = users.filter(user => match(user.name));
      const groups = conversations.filter(c => c.kind === 'group' && (match(conversationName(c, people, self?.id)) || c.memberIds.some(id => match(people.get(id)?.name ?? ''))));
      const files = drive.filter(file => match(file.name));
      showMatches(section('联系人', contacts.map(user => result('user', user.id, avatar(user, true), user.name, status(user))))
        + section('群聊', groups.map(c => result('group', c.id, groupAvatar(c.memberIds.map(id => people.get(id))), conversationName(c, people, self?.id), `${c.memberIds.length} 位成员`)))
        + section('云盘文件', files.map(file => result('file', file.id, fileSymbol(file), file.name, formatSize(file.size))))
        || empty(input.value ? '没有找到匹配的结果' : '暂无可搜索的联系人、群聊或文件'));
    };
    list.onclick = event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-type]');
      if (!button) return;
      const { id, type } = button.dataset;
      if (type === 'file') {
        const file = this.client.state.drive.find(entry => entry.id === id);
        if (file) { this.dialog.close(); this.actions.openDrive(); this.actions.download(file); }
      } else {
        void this.submit(shell, () => type === 'group' ? this.client.openConversation(id!) : this.client.openDirect(id!), this.actions.openChat);
      }
    };
    input.oninput = this.updateResults = render; render();
  }

  pickDrive() {
    this.show('从云盘选择文件', `${searchField('搜索文件')}<div class="imd-list imd-search-results"></div>`);
    const input = this.el<HTMLInputElement>('input'), list = this.el<HTMLElement>('.imd-list');
    const showMatches = this.renderList(list);
    const render = () => {
      showMatches(this.client.state.drive.filter(file => norm(file.name).includes(norm(input.value))).map(file =>
        `<button type="button" class="imd-row" data-file="${escapeHtml(file.id)}">${fileSymbol(file)}${copy(file.name, formatSize(file.size))}${glyph('plus', 16)}</button>`).join('')
        || empty(input.value ? '没有找到匹配的文件' : '发送过的文件会出现在这里'));
    };
    list.onclick = event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-file]');
      const file = this.client.state.drive.find(entry => entry.id === button?.dataset.file);
      if (file) { this.dialog.close(); this.actions.attachDrive(file); }
    };
    input.oninput = this.updateResults = render; render();
  }
}
