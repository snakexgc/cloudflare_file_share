import { isMessengerAvatarImage, type MessengerConversation, type MessengerFile, type MessengerUser } from '../src/shared/messenger';

export type PageMode = 'chat' | 'drive' | 'share' | 'admin';
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const paths = {
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  add: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8m-4-4v8"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  filter: '<path d="M3 5h18M12 12h9M12 18h6"/><path fill="currentColor" stroke="none" d="m3 10 6 4-6 4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M2 19v-2a7 7 0 0 1 14 0v2m-1-14a3 3 0 0 1 0 6m3 2a5 5 0 0 1 4 5"/>',
  invite: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20v-2a7 7 0 0 1 13-3m3-5v8m-4-4h8"/>',
  link: '<path d="m10 13 4-4m-6 2-3 3a4 4 0 0 0 6 6l3-3m-2-10 2-2a4 4 0 0 1 6 6l-3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 4 1-2h4l1 2 2 1 2-.2 2 3-1 2v3l1 2-2 3-2-.2-2 1-1 2h-4l-1-2-2-1-2 .2-2-3 1-2v-3L3 8l2-3 2 .2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  chat: '<path d="M20 12a8 8 0 0 1-8 8c-1.5 0-2.7-.3-3.8-.8L4 20l.8-3.8A8 8 0 1 1 20 12Z"/><path d="M8 10h8m-8 4h5"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3z"/>',
  file: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5M8 13h8m-8 4h6"/>',
  attach: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-6 12 8-8"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0m-8-5v.3m8-.3v.3"/>',
  send: '<path d="m3 3 19 9-19 9 3-9zM6 12h15"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  upload: '<path d="M12 15V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  more: '<circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="20" cy="12" r="1" fill="currentColor"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M3 7h7m4 0h7M3 17h12m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.4"/><path d="m4 17 5-4 3 2 4-5 5 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
};
export function glyph(name: keyof typeof paths, size = 18) {
  return `<svg class="im-icon" aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
export function iconButton(action: string, label: string, name: keyof typeof paths) {
  return `<button type="button" class="im-icon-button" data-action="${action}" aria-label="${label}" title="${label}">${glyph(name)}</button>`;
}
function appMark(drive: boolean) {
  const drawing = drive
    ? '<path fill="#52c7ff" d="M2 6a2 2 0 0 1 2-2h6l2 3h7a2 2 0 0 1 2 2v10H2z"/><path fill="#3485ff" d="M2 10h20l-3 9a2 2 0 0 1-2 1H3z"/><path fill="#80ddff" d="M10 17h7l3-7h-5z"/>'
    : '<path fill="#367cff" d="M12 2.5a9 9 0 0 1 8.8 11c-1 4.4-5 7.2-9.4 7.1l-5.6 1.1.8-4A9.1 9.1 0 0 1 12 2.5Z"/><path fill="#14c3bd" d="M15.7 9.6a6 6 0 0 1 5.8 7.1l.7 3.7-3.5-.6a6.1 6.1 0 1 1-3-10.2Z"/>'
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19">${drawing}</svg>`;
}
export function avatar(user: MessengerUser | undefined, presence = false) {
  const name = user?.name || '访客';
  const color = [...(user?.id ?? '')].reduce((n, c) => n + c.charCodeAt(0), 0) % 6;
  const source = user?.avatar ?? '';
  const photo = isMessengerAvatarImage(source);
  const fallback = source && Array.from(source).length <= 5 ? source : Array.from(name).at(-1) || '访';
  return `<span class="im-avatar hue-${color}" aria-hidden="true">${photo ? `<img src="${escapeHtml(source)}" alt="">` : escapeHtml(fallback)}${presence && user?.online ? '<i class="im-online-dot"></i>' : ''}</span>`;
}
export function groupAvatar(people: (MessengerUser | undefined)[]) {
  return `<span class="im-group-avatar" aria-hidden="true">${people.slice(0, 4).map(p => avatar(p)).join('')}</span>`;
}
export function conversationName(conv: MessengerConversation, users: Map<string, MessengerUser>, selfId?: string) {
  const names = conv.memberIds.filter(id => id !== selfId).map(id => users.get(id)?.name || '已离开的用户');
  if (conv.kind === 'dm') return names[0] || '私聊';
  return names.slice(0, 4).join('、') || '群聊';
}
export function formatSize(n: number) {
  const i = Math.min(4, n > 0 ? Math.floor(Math.log(n) / Math.log(1024)) : 0);
  return `${Number((n / 1024 ** i).toFixed(i ? 1 : 0))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}
export function shortTime(t: number) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false}) : `${d.getMonth()+1}月${d.getDate()}日`;
}
export function fileSymbol(file: Pick<MessengerFile, 'name'|'mime'>) {
  const ext = (file.name.includes('.') ? file.name.split('.').at(-1)! : '').slice(0,4).toUpperCase();
  const tone = file.mime.startsWith('image/') ? 'aqua' : /^(XLSX?|CSV|TSV)$/.test(ext) ? 'green' : /^(PDF|PPTX?)$/.test(ext) ? 'coral' : /^(ZIP|RAR|7Z|GZ)$/.test(ext) ? 'gold' : 'blue';
  return `<span class="im-file-symbol ${tone}">${escapeHtml(ext || 'FILE')}</span>`;
}
export function frameContent() {
  return `<div class="im-banner" id="im-banner" hidden><span class="im-info-dot">i</span><span>开启通知功能可第一时间接收新消息提醒</span><button data-action="notifications">开启消息通知</button>${iconButton('dismiss-banner','关闭通知提示','close')}</div>
    <div class="im-shell">
      <nav class="im-rail" aria-label="工作台导航"><div class="im-account"><button class="im-me" data-action="profile" aria-label="个人资料" title="个人资料">${avatar(undefined)}</button>${iconButton('new-chat','发起聊天','add')}</div>
      <button class="im-search" data-action="search" title="搜索 (Ctrl+K)">${glyph('search',16)}<span>搜索 (Ctrl+K)</span></button>
      <div class="im-apps"><a href="/" data-page-mode="chat" title="消息">${appMark(false)}<span>消息</span></a><a href="/drive" data-page-mode="drive" title="云盘">${appMark(true)}<span>云盘</span></a></div>
      <div class="im-rail-foot"><a href="/send" data-page-mode="share" title="链接分享">${glyph('link',17)}<span>链接分享</span></a><a href="/admin" title="管理台" data-page-mode="admin">${glyph('settings',17)}<span>管理台</span></a></div></nav>
      <section class="im-inbox im-frame" aria-label="消息列表"><div class="im-list-heading"><button data-action="filter" aria-haspopup="dialog">${glyph('filter',17)}<span id="im-filter-label">消息</span></button></div><div class="im-rows" id="im-rows"></div></section>
      <section class="im-chat-panel im-frame" id="chat-page" aria-label="会话"></section>
      <section class="im-drive im-frame" id="im-drive" aria-label="云盘" hidden></section>
      <section class="im-legacy im-frame" id="im-share" aria-label="链接分享" hidden><div class="im-area-heading">${glyph('link')}链接分享</div><div class="im-legacy-scroll" id="normal-page"></div></section>
      <section class="im-legacy im-frame" id="im-admin" aria-label="管理台" hidden><div class="im-area-heading">${glyph('settings')}管理台</div><div class="im-legacy-scroll" id="admin-page"></div></section></div>
      <div id="im-connection" role="status" hidden></div><p id="page-error" class="im-page-error" role="alert" hidden></p><div id="toast" role="status" aria-live="polite"></div><dialog class="im-dialog" id="im-dialog"></dialog>`;
}
export function welcome() {
  return '<div class="im-welcome"><div><img src="/welcome.svg" width="96" height="96" alt=""><p>选择一个会话，开始聊天</p></div></div>';
}
