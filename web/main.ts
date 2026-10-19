import './style.css';
import { homeContent } from './home';
import QRCode from 'qrcode';
import { api, ApiError } from '../src/client/api';
import { ControlSession } from '../src/client/control';
import { chooseSink, hashFile } from '../src/client/sink';
import { ReceiveTask, SendTask, UploadManager, type Progress } from '../src/client/transfer';
import type { ControlEvent, DownloadRequest, FileInfo, ShareInfo, ShareTransferMode } from '../src/shared/types';
import type { PublicConfig } from '../src/client/config';
import { validHours, decodeFrame } from '../src/shared/protocol';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PeerManager } from '../src/client/peer';
import { mountProbes, punchStatus } from '../src/client/probe';
import { adminMain } from './admin';
import { rtcSupport } from '../src/client/rtc';
import { MODE_LABELS, TransferSpeed } from '../src/client/speed';
import { mountChat } from './chat';

const icons = {
  arrows: '<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4 4-4-4 4-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  link: '<path d="m9 15 6-6M7 13l-2 2a4 4 0 0 0 6 6l3-3M17 11l2-2a4 4 0 0 0-6-6l-3 3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cloud: '<path d="M7 18H5a4 4 0 0 1-.5-8 7 7 0 0 1 13-2 5 5 0 0 1 1.5 10H17M12 13v8m-3-5 3-3 3 3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  network: '<rect x="8" y="3" width="8" height="5" rx="1"/><path d="M12 8v5M5 17v-4h14v4"/><rect x="2" y="17" width="6" height="4" rx="1"/><rect x="16" y="17" width="6" height="4" rx="1"/>',
};
function icon(name: keyof typeof icons, className = '') { return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`; }
const app = document.querySelector<HTMLDivElement>('#app')!;
let config: PublicConfig;
let selected: File[] = [];
let transferMode: ShareTransferMode = 'auto';
let share: ShareInfo | undefined;
let ownerToken: string | undefined;
let control: ControlSession | undefined;
let uploads: UploadManager | undefined;
let peers: PeerManager | undefined;
let expiryTimer: ReturnType<typeof setInterval> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const sources = new Map<string, File>();
const senders = new Map<string, SendTask>();
const receivers = new Map<string, ReceiveTask>();
const pendingEvents: ControlEvent[] = [];
const pendingCredits = new Map<string, Record<string, unknown>>();
let eventQueue: Promise<void> = Promise.resolve();
let challengeToken = '';
let ended = false;
let createdPassword = '';
let transferTimer: ReturnType<typeof setInterval> | undefined;
const speedMeters = new Map<string, TransferSpeed>();
const lastModes = new Map<string, string>();
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function escape(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function size(bytes: number) { if (!bytes) return '0 B'; const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4); return `${(bytes / 1024 ** i).toLocaleString('zh-CN', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`; }
function shell(content: string) {
  app.innerHTML = `<header class="header"><a href="/" class="brand"><span class="brand-mark">${icon('arrows')}</span><span>临时传</span></a><span class="header-note">轻一点分享，少一点等待</span><nav class="header-nav" aria-label="页面导航"><a href="/">聊天室</a><a href="/send">链接分享</a><a class="header-link" href="/admin">${config?.admin ? '管理台 · 已登录' : '管理登录'}</a></nav></header><main>${content}</main><footer><span>文件来去自如，分享有始有终。</span><span>${icon('shield')} 原文件交付 · 完整性校验 · 按时失效</span></footer><div id="toast" role="status" aria-live="polite"></div>`;
}
function inactivityNote() { return `分享者连续 ${((config?.limits.ownerIdleTimeoutMs ?? 1800000) / 60000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 分钟不活跃时，分享和云端文件会提前销毁。`; }
function network() { if (config) mountProbes({ ...config, lanOnly: (share?.transferMode ?? transferMode) === 'lan', httpOnly: control?.httpOnly || share?.files.some(file => file.forcedMode === 'https') }, () => { peers?.retest(); }); }
function modes() {
  if (!share || ownerToken && !config.admin) return;
  const lanOnly = share.transferMode === 'lan';
  for (const file of share.files) {
    const parent = document.querySelector(`#file-${file.id}`)!;
    if (parent.querySelector('.mode-choice')) continue;
    const row = document.createElement('div'); row.className = 'mode-choice';
    const choices = lanOnly ? [['lan', '内网直传']] : config.admin ? [['auto', '自动选择'], ['lan', '内网直传'], ['p2p', '强制 P2P 直连'], ['turn', '强制 TURN 中继'], ['ws', '强制 WS 中继'], ['https', '强制 HTTPS 中继'], ['r2', '强制 R2 云端']] : [['auto', '自动选择'], ['lan', '内网直传']];
    row.innerHTML = `<label for="mode-${file.id}">传输方式</label><select id="mode-${file.id}" aria-label="${escape(file.name)} 的传输方式" ${lanOnly ? 'disabled' : ''}>${choices.map(([value, name]) => `<option value="${value}" ${value === (lanOnly ? 'lan' : file.forcedMode ?? 'auto') ? 'selected' : ''}>${name}</option>`).join('')}</select><small>${lanOnly ? '仅连接同一局域网的设备，不使用公网中继' : '内网直传适合同一 Wi-Fi；自动选择适合跨网络分享'}</small>`;
    parent.insertBefore(row, parent.querySelector('.transfer-info'));
    if (ownerToken) (row.querySelector('select') as unknown as HTMLSelectElement).onchange = event => { void (async () => { try { const mode = (event.target as HTMLSelectElement).value; await startControl(mode === 'https'); if (mode === 'https') control!.preferHttp([...senders.values()].some(sender => sender.task.mode === 'ws')); if (mode !== 'https') await control!.ensureWs().catch(() => {}); await api(`${control!.base}/files/${file.id}/mode`, control!.sessionToken, { mode }); if (mode === 'https') network(); toast('已设置此文件传输方式，在线下载者会切换'); } catch (failure) { error(String(failure)); } })(); };
    else (row.querySelector('select') as unknown as HTMLSelectElement).onchange = event => { const receiver = [...receivers.values()].find(x => x.task.fileId === file.id && !x.done); if (receiver) void receiver.switchTo((event.target as HTMLSelectElement).value); };
  }
}
function toast(message: string) { const element = $('#toast'); element.textContent = message; element.classList.add('visible'); setTimeout(() => element.classList.remove('visible'), 4500); }
function error(message: string) { const element = $('#error'); element.textContent = message; element.hidden = !message; }
function fileTile(file: { name: string; size: number }, extra = '') { const ext = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 5).toUpperCase() : 'FILE'; return `<span class="file-symbol">${escape(ext || 'FILE')}</span><span class="file-description"><strong title="${escape(file.name)}">${escape(file.name)}</strong><small>${size(file.size)}</small></span>${extra}`; }
function renderHome() {
  shell(homeContent(config?.limits.defaultShareHours ?? 2, inactivityNote(), icon, transferMode));
  document.querySelectorAll<HTMLInputElement>('input[name=transfer-mode]').forEach(input => { input.onchange = () => {
    transferMode = input.value as ShareTransferMode;
    $('#mode-help').textContent = transferMode === 'lan' ? '两端需在同一局域网。文件直接传输，不使用公网中继；打开页面和建立连接仍需联网。' : '优先连接双方设备；直连不可用时，自动尝试中继。';
    $('#how-transfer').textContent = transferMode === 'lan' ? '连接同一 Wi-Fi，双方保持页面打开。' : '双方保持在线，点击下载即开始。';
    network();
  }; });
  $('#file-input').onchange = () => { addFiles(Array.from($<HTMLInputElement>('#file-input').files ?? [])); $<HTMLInputElement>('#file-input').value = ''; };
  const zone = $('#dropzone'); zone.ondragover = event => { event.preventDefault(); zone.classList.add('dragging'); }; zone.ondragleave = () => zone.classList.remove('dragging');
  zone.ondrop = event => { event.preventDefault(); zone.classList.remove('dragging'); addFiles(Array.from(event.dataTransfer?.files ?? [])); };
  $('#create-form').onsubmit = event => { event.preventDefault(); void create(); };
  $('#create-form').addEventListener('invalid', event => { if ((event.target as Element).closest('.advanced-options')) document.querySelector<HTMLDetailsElement>('.advanced-options')!.open = true; }, true);
}
function addFiles(files: File[]) {
  if (!config) return;
  for (const file of files) {
    if (selected.some(x => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified)) continue;
    if (file.size > config.limits.maxFileBytes) { error(`${file.name} 超过单文件限制 ${size(config.limits.maxFileBytes)}`); continue; }
    if (selected.length >= config.limits.maxFiles || selected.reduce((n, x) => n + x.size, file.size) > config.limits.maxShareBytes) { error('文件数量或分享总大小超出当前服务限制'); break; }
    selected.push(file);
  }
  renderSelection();
}
function renderSelection() {
  $('#selected-files').innerHTML = selected.map((file, index) => `<div class="selected-file">${fileTile(file, `<button type="button" class="remove" data-index="${index}" aria-label="移除 ${escape(file.name)}">×</button>`)}</div>`).join('');
  document.querySelectorAll<HTMLButtonElement>('.remove').forEach(button => { button.onclick = () => { selected.splice(Number(button.dataset.index), 1); renderSelection(); }; });
  $<HTMLButtonElement>('#create').disabled = selected.length === 0;
}
async function create() {
  const hours = Number($<HTMLInputElement>('#hours').value);
  if (!validHours(hours)) { error('有效期必须是 1–24 小时的整数'); return; }
  if (!selected.length) { error('请先选择文件'); return; }
  if (config.challengeRequired && !challengeToken) { error('请先完成人机验证'); return; }
  error(''); const button = $<HTMLButtonElement>('#create'); button.disabled = true; button.textContent = '正在创建分享…';
  try {
    const shortCode = $<HTMLInputElement>('#short-code').value, password = $<HTMLInputElement>('#share-password').value;
    const result = await api<{ id: string; transferMode: ShareTransferMode; shortCode?: string; passwordProtected: boolean; ownerToken: string; createdAt: number; expiresAt: number; files: FileInfo[]; url: string }>('/api/shares', undefined, { expiresInHours: hours, transferMode, files: selected.map(file => ({ name: file.name, size: file.size, mime: file.type, lastModified: file.lastModified })), turnstileToken: challengeToken, ...(shortCode ? { shortCode } : {}), ...(password ? { password } : {}) });
    createdPassword = password;
    ownerToken = result.ownerToken; result.files.forEach((file, index) => sources.set(file.id, selected[index]));
    selected = [];
    share = { ...result, status: 'active', cleanupStatus: 'pending', ownerStatus: 'online', activeRequests: 0 };
    history.pushState({}, '', `${new URL(result.url).pathname}#owner=${ownerToken}`); renderShare(); await startControl();
  } catch (failure) { error(failure instanceof Error ? failure.message : '分享创建失败'); button.disabled = false; button.innerHTML = `生成分享链接 ${icon('arrows')}`; }
}
function renderShare() {
  if (!share) return;
  const owner = Boolean(ownerToken), link = `${location.origin}/s/${share.shortCode ?? share.id}`;
  shell(`<section class="share-hero"><div class="eyebrow"><span class="live-dot"></span> ${owner ? '让分享保持轻盈' : '一份文件，正在等你'}</div><h1>${owner ? '链接已备好，<span>等对方接收。</span>' : '收下文件，<span>继续你的事情。</span>'}</h1><p>${owner ? '只需分享下面的公开链接。此管理页面请自己保留。' : '每个文件独立保存，原内容、原名称，完整性全程校验。'}</p></section><div class="share-workspace"><section class="card share-card"><div class="card-heading"><div><h2>${owner ? '你的分享' : '收到的分享'}</h2><p><span id="owner-status">正在查询分享者状态…</span></p></div><span class="status-pill" id="connection">正在连接</span></div>${owner ? `<div class="link-panel"><label for="public-link">公开分享链接</label><div class="link-input"><input id="public-link" readonly value="${escape(link)}"/><button class="button primary" id="copy">${icon('copy')} 复制链接</button></div><div class="link-helper"><span>${icon('link')} 接收者打开链接后，点击下载即可。</span><button id="qr-toggle" class="text-button">显示二维码</button></div><div id="qr-panel" hidden><canvas id="qr" aria-label="公开分享链接二维码"></canvas><p>扫描接收文件</p></div></div>` : ''}<div class="files-heading"><strong>${share.files.length} 个文件</strong><span>共 ${size(share.files.reduce((n, file) => n + file.size, 0))}</span></div><div class="share-files">${share.files.map(file => `<div class="share-file" id="file-${file.id}"><div class="file-row">${fileTile(file, owner ? `<span class="file-state" id="state-${file.id}">${file.uploadStatus === 'ready' ? '云端可下载' : sources.has(file.id) ? '等待接收' : '需要重新选择'}</span>` : `<button class="button secondary download" data-file="${file.id}">${icon('download')} 下载原文件</button>`)}</div><div class="transfer-info" id="info-${file.id}"><span id="label-${file.id}">${owner ? '有人点击下载后才开始传输' : '尚未请求下载'}</span><span id="bytes-${file.id}"></span></div><progress id="progress-${file.id}" value="0" max="${file.size || 1}" hidden aria-label="${escape(file.name)} 传输进度"></progress><button class="text-button cancel" data-file="${file.id}" hidden>取消下载</button></div>`).join('')}</div><p id="error" class="error-message" role="alert" hidden></p>${owner ? `<div class="source-restore"><label class="button secondary" for="restore">${icon('file')} 重新选择源文件</label><input id="restore" type="file" multiple hidden/><small>刷新或休眠后，重新选择原文件即可恢复分享。</small></div>` : `<div class="browser-note">${icon('shield')} 大文件建议使用桌面 Chrome / Edge，直接流式保存到设备。</div>`}</section><aside class="share-aside"><div class="card expiry-card"><span class="soft-icon">${icon('clock')}</span><span class="eyebrow">链接剩余有效期</span><strong id="remaining" class="remaining">--:--:--</strong><p id="expires-date"></p><div class="divider"></div><p id="share-note">${owner ? `请保持此页面可运行、设备联网。${inactivityNote()}` : inactivityNote()}</p>${owner ? `<button id="revoke" class="button danger wide">撤销此次分享</button>` : `<a href="/send" class="button secondary wide">我也想分享文件 ${icon('arrows')}</a>`}</div><button class="text-button" id="reconnect" hidden>重新连接</button><div id="how" class="small-tip">${icon('shield')} 到期后停止新的访问授权，已保存到设备的文件仍由你保留。</div></aside></div>`);
  if (owner) {
    $('#copy').onclick = () => { void navigator.clipboard.writeText(link).then(() => toast('公开链接已复制')).catch(() => { $<HTMLInputElement>('#public-link').select(); toast('请复制已选中的公开链接'); }); };
    $('#qr-toggle').onclick = () => { const panel = $('#qr-panel'); panel.hidden = !panel.hidden; if (!panel.hidden) void QRCode.toCanvas($<HTMLCanvasElement>('#qr'), link, { width: 176, margin: 1, color: { dark: '#24385c', light: '#ffffff' } }); };
    $('#restore').onchange = () => { void restoreSources(Array.from($<HTMLInputElement>('#restore').files ?? [])); };
    $('#revoke').onclick = () => { void revoke(); };
    if (createdPassword) {
      const password = document.createElement('div'); password.className = 'share-password-summary';
      password.innerHTML = '<span>已设置提取密码</span><button class="text-button" type="button">复制链接和提取密码</button>';
      password.querySelector('button')!.onclick = () => { void navigator.clipboard.writeText(`链接：${link}\n提取密码：${createdPassword}`).then(() => toast('链接和提取密码已复制')).catch(() => error('复制失败，请手动复制链接和密码')); };
      $('#public-link').closest('.link-panel')!.appendChild(password);
    } else if (share.passwordProtected) { const note = document.createElement('p'); note.className = 'share-password-summary'; note.textContent = '此分享需要提取密码，刷新后本页不保留密码明文。'; $('#public-link').closest('.link-panel')!.appendChild(note); }
  } else {
    document.querySelectorAll<HTMLButtonElement>('.download').forEach(button => { button.onclick = () => { void download(button.dataset.file!); }; });
    document.querySelectorAll<HTMLButtonElement>('.cancel').forEach(button => { button.onclick = () => { const task = [...receivers.values()].find(x => x.task.fileId === button.dataset.file && !x.done); if (task) void task.cancel(); }; });
  }
  $('#reconnect').onclick = () => { void (control ? control.recover() : startControl()).catch(failure => error(String(failure))); };
  if (share.transferMode === 'lan') {
    const note = document.createElement('div'); note.className = 'share-transfer-note';
    note.innerHTML = `${icon('network')}<div><strong>内网直传</strong><p>两端请连接同一 Wi-Fi / 局域网。文件不经过公网中继；建立连接仍需联网。</p></div>`;
    $('.share-card').insertBefore(note, $('.share-card .card-heading').nextSibling);
  }
  clearInterval(expiryTimer); expiryTimer = setInterval(tick, 1000); tick(); updateShare(share);
  clearInterval(refreshTimer); refreshTimer = setInterval(() => { if (!ended) void refresh(); }, 12000);
  modes(); network();
  for (const file of share.files) {
    const row = document.createElement('div'); row.className = 'transfer-metrics';
    row.innerHTML = `<span>当前方式：<strong id="transport-${file.id}">等待下载</strong></span><span>传输速度：<strong id="speed-${file.id}">0 B/s</strong></span>`;
    $(`#file-${file.id}`).insertBefore(row, document.querySelector(`#progress-${file.id}`));
  }
  clearInterval(transferTimer); transferTimer = setInterval(updateTransferMetrics, 1000); updateTransferMetrics();
}
function updateTransferMetrics() {
  if (!share) return;
  for (const file of share.files) {
    const metrics: { key: string; bytes: number; mode: string }[] = [];
    if (ownerToken) {
      for (const sender of senders.values()) if (sender.task.fileId === file.id && sender.active) metrics.push({ key: sender.task.transferId, bytes: sender.transferredBytes, mode: sender.task.mode });
      const upload = uploads?.metric(file.id); if (upload) metrics.push(upload);
    } else for (const receiver of receivers.values()) if (receiver.task.fileId === file.id && !receiver.done) metrics.push({ key: receiver.task.transferId, bytes: receiver.transferredBytes, mode: receiver.task.mode });
    let speed = 0;
    for (const metric of metrics) { if (!speedMeters.has(metric.key)) speedMeters.set(metric.key, new TransferSpeed()); speed += speedMeters.get(metric.key)!.sample(metric.key, metric.bytes); }
    const modes = [...new Set(metrics.map(metric => MODE_LABELS[metric.mode] ?? metric.mode))];
    const mode = document.querySelector(`#transport-${file.id}`), rate = document.querySelector(`#speed-${file.id}`);
    if (mode) mode.textContent = modes.length ? modes.join(' + ') : lastModes.get(file.id) ?? '等待下载';
    if (rate) rate.textContent = `${size(Math.round(speed))}/s`;
  }
  const active = new Set([...senders.values()].filter(sender => sender.active).map(sender => sender.task.transferId).concat([...receivers.values()].filter(receiver => !receiver.done).map(receiver => receiver.task.transferId), share.files.map(file => uploads?.metric(file.id)?.key).filter((key): key is string => Boolean(key))));
  for (const key of speedMeters.keys()) if (!active.has(key)) speedMeters.delete(key);
}
function tick() {
  if (!share || !document.querySelector('#remaining')) return;
  const seconds = Math.max(0, Math.floor((share.expiresAt - Date.now()) / 1000));
  $('#remaining').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  $('#expires-date').textContent = `${new Date(share.expiresAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`;
  if (!seconds || share.status !== 'active') expire();
}
function expire() {
  if (ended) return; ended = true; peers?.stop(); control?.stop(); uploads?.stop(); for (const sender of senders.values()) sender.stop(); for (const receiver of receivers.values()) void receiver.fail(new Error('分享已过期或撤销'));
  sources.clear();
  senders.clear();
  $('#connection').textContent = share?.status === 'revoked' ? '已撤销' : '已过期'; $('#connection').classList.add('muted');
  $('#remaining').textContent = '已结束'; $('#share-note').textContent = share?.cleanupStatus === 'cleaned' ? '分享已结束，云端文件已删除。' : '分享已结束，文件正在清理。';
  document.querySelectorAll<HTMLButtonElement>('.download, #revoke').forEach(button => { button.disabled = true; }); clearInterval(refreshTimer);
}
function updateShare(value: ShareInfo) {
  share = value; if (!document.querySelector('#owner-status')) return;
  const ready = value.files.filter(file => file.uploadStatus === 'ready').length;
  $('#owner-status').textContent = ready && ready === value.files.length ? '云端文件已就绪 · 可在有效期内下载' : ready && value.ownerStatus !== 'online' ? '部分文件云端可下载 · 其余等待分享者恢复' : value.ownerStatus === 'online' ? value.activeRequests ? `${value.activeRequests} 个有效下载请求` : '分享者在线 · 等待接收者' : value.ownerStatus === 'file_unavailable' ? '分享者在线 · 源文件需要重新选择' : '分享者离线 · 等待恢复';
  if (!ownerToken && !control && !ended) $('#connection').textContent = '分享有效';
  for (const file of value.files) {
    const element = document.querySelector(`#state-${file.id}`);
    if (element) element.textContent = file.uploadStatus === 'ready' ? '云端可下载' : file.uploadStatus === 'paused' ? '云端上传暂停' : sources.has(file.id) ? '源文件可读' : '需要重新选择';
  }
  if (ownerToken && value.files.every(file => file.uploadStatus === 'ready')) $('#share-note').textContent = `所有文件已在云端就绪。请继续保持页面在线。${inactivityNote()}`;
  if (value.status !== 'active') expire();
}
async function refresh() {
  if (!share) return;
  try { if (control?.sessionToken && ownerToken) await control.refreshStatus(); else updateShare(await api<ShareInfo>(`/api/shares/${share.id}`)); }
  catch (failure) { if (failure instanceof ApiError && failure.status === 410) { const details = failure.details as { share?: ShareInfo }; if (details?.share) updateShare(details.share); else expire(); } }
}
const progress: Progress = (fileId, label, bytes, mode, finished) => {
  if (!document.querySelector(`#file-${fileId}`)) return;
  $(`#label-${fileId}`).textContent = label;
  if (mode) { lastModes.set(fileId, MODE_LABELS[mode] ?? mode); const method = document.querySelector(`#transport-${fileId}`); if (method) method.textContent = MODE_LABELS[mode] ?? mode; }
  $(`#bytes-${fileId}`).textContent = bytes ? size(bytes) : '';
  const bar = $<HTMLProgressElement>(`#progress-${fileId}`); bar.hidden = false; bar.value = finished && !share!.files.find(file => file.id === fileId)!.size ? 1 : bytes;
  const cancel = document.querySelector<HTMLButtonElement>(`.cancel[data-file="${fileId}"]`); if (cancel) cancel.hidden = Boolean(finished) || label.startsWith('未完成');
  if (finished || label.startsWith('未完成')) { const button = document.querySelector<HTMLButtonElement>(`.download[data-file="${fileId}"]`); if (button) { button.disabled = false; button.innerHTML = `${icon('download')} ${finished ? '再次下载' : '重试下载'}`; } }
};
async function startControl(httpOnly = share?.files.every(file => file.forcedMode === 'https') ?? false) {
  if (!share || control || ended) return;
  control = new ControlSession(share.id, ownerToken ? 'owner' : 'receiver', { webrtc: rtcSupport().available, ws: !httpOnly && typeof WebSocket === 'function', https: true, readable: [...sources.keys()] }, config.limits, ownerToken);
  if (httpOnly) control.preferHttp();
  if (share.transferMode !== 'lan') {
    peers = new PeerManager(control, config.stunServers, punchStatus);
    peers.onReady = peer => { for (const receiver of receivers.values()) if (!receiver.done && receiver.task.ownerId === peer.ownerId) void receiver.upgrade(peer.id); };
  }
  control.busy = () => [...receivers.values()].some(x => !x.done) || Boolean(share?.activeRequests);
  control.onShare = updateShare;
  control.onState = (state, message) => { if (!ended) { $('#connection').textContent = state === 'offline' ? '暂时离线' : '连接正常'; $('#connection').title = state === 'ws' ? 'WS 信令连接' : state === 'http' ? 'HTTPS 信令与在线租约' : message ?? ''; $('#reconnect').hidden = state !== 'offline'; } };
  control.onEvent = event => { eventQueue = eventQueue.then(() => handleEvent(event)).catch(failure => { if (!ended) error(failure instanceof Error ? failure.message : '传输协调失败'); }); };
  control.onBinary = buffer => {
    try { const frame = decodeFrame(buffer), receiver = [...receivers.values()].find(task => task.task.transferId === frame.transferId); receiver?.frame(buffer); }
    catch (failure) { error(`文件消息无效：${String(failure)}`); }
  };
  control.onRaw = data => {
    if (data.type === 'relay-credit') {
      const sender = [...senders.values()].find(task => task.task.transferId === data.transferId);
      if (sender) { try { sender.credit(data); } catch (failure) { error(String(failure)); } } else pendingCredits.set(String(data.transferId), data);
    } else if (data.type === 'ws-disconnected') {
      for (const receiver of receivers.values()) if (!receiver.done && receiver.task.mode === 'ws') void receiver.advance(new Error('WS 中继连接中断'));
    } else if (data.type === 'expired') expire();
    else if (data.type === 'resync' || data.type === 'http-tasks') {
      for (const task of data.requests as DownloadRequest[]) {
        if (ownerToken && terminal(task)) { void handleEvent({ seq: 0, eventId: '', type: task.status, request: task, createdAt: Date.now() }); continue; }
        const receiver = receivers.get(task.id);
        if (receiver && !receiver.done) { if (task.epoch !== receiver.task.epoch || task.mode === 'r2' || task.mode === 'https') void receiver.start(task); else if (task.status === 'connecting' && !receiver.connected) void receiver.advance(new Error('信令历史已失效，重新协商')); }
        if (ownerToken && !terminal(task) && task.ownerId === control!.sessionId && (task.mode !== 'https' || task.status !== 'requested')) void handleEvent({ seq: 0, eventId: '', type: task.mode === 'r2' ? 'upload-needed' : 'attempt', request: task, createdAt: Date.now() });
      }
    } else if (data.type === 'error') error(String(data.message));
  };
  uploads = new UploadManager(control, config.limits, fileId => sources.get(fileId), progress);
  try { await control.start(); peers?.start(); } catch (failure) { peers?.stop(); control.stop(); control = undefined; $('#reconnect').hidden = false; error(failure instanceof Error ? failure.message : '无法建立控制会话'); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ended) { void refresh(); void control?.recover().catch(() => {}); } });
}
function terminal(task: DownloadRequest) { return ['completed', 'canceled', 'failed'].includes(task.status); }
async function handleEvent(event: ControlEvent) {
  if (event.type === 'expired') { expire(); return; }
  if (await peers?.event(event)) return;
  if (event.type === 'file-deleted') { const fileId = (event.data as { fileId: string }).fileId; sources.delete(fileId); document.querySelector(`#file-${fileId}`)?.remove(); toast('文件已被管理员删除'); void refresh(); return; }
  const task = event.request;
  if (ownerToken) {
    const data = event.data as { fileId?: string } | undefined;
    if (event.type === 'upload-needed' && task) { void uploads!.start(task.fileId); return; }
    if (event.type === 'upload-pause' && data?.fileId) { uploads!.pause(data.fileId); return; }
    if (event.type === 'upload-cancel' && data?.fileId) { uploads!.cancel(data.fileId); return; }
    if (event.type === 'file-ready') { void refresh(); return; }
    if (!task) return;
    const old = senders.get(task.id);
    if (event.type === 'attempt' && task.mode !== 'r2' && !terminal(task)) {
      if (old && old.task.epoch === task.epoch) return;
      old?.stop(); const file = sources.get(task.fileId);
      if (!file) { await control!.signal(task, 'source-error', {}); return; }
      const sender = new SendTask(task, file, control!, config.limits, config.stunServers, progress, peers?.get(task.peerId)); senders.set(task.id, sender);
      const credit = pendingCredits.get(task.transferId); if (credit) { sender.credit(credit); pendingCredits.delete(task.transferId); }
      void sender.start();
    } else if (event.type === 'rtc-answer' || event.type === 'rtc-ice') { if (old && old.task.epoch === task.epoch) await old.event(event); }
    else if (['stop-attempt', 'completed', 'canceled', 'failed', 'waiting-source', 'relay-error'].includes(event.type)) { old?.stop(); senders.delete(task.id); if (event.type === 'completed') progress(task.fileId, '对方已完成保存与校验', share!.files.find(file => file.id === task.fileId)!.size, task.mode, true); else if (event.type === 'failed') progress(task.fileId, `未完成：${task.error ?? '传输失败'}`, task.offset, task.mode); }
  } else if (task) {
    const receiver = receivers.get(task.id);
    if (receiver) await receiver.event(event);
    else { pendingEvents.push(event); if (pendingEvents.length > config.limits.eventQueueSize) pendingEvents.shift(); }
  }
}
async function download(fileId: string) {
  const file = share!.files.find(x => x.id === fileId)!;
  const button = document.querySelector<HTMLButtonElement>(`.download[data-file="${fileId}"]`)!;
  if (button.disabled || ended) return; button.disabled = true; error('');
  let sink;
  try {
    // 文件选择器必须在用户点击的同一激活链内调用，先于任何网络等待。
    sink = await chooseSink(file, config.limits.memoryDownloadBytes);
    const chosen = (document.querySelector(`#mode-${fileId}`) as unknown as HTMLSelectElement | null)?.value;
    await startControl(chosen === 'https' || file.forcedMode === 'https'); if (!control) throw new Error('控制连接尚未就绪，请重新连接');
    if (chosen === 'https' || file.forcedMode === 'https') { control.preferHttp([...receivers.values()].some(receiver => !receiver.done && receiver.task.mode === 'ws' && receiver.task.fileId !== fileId)); network(); }
    else await control.ensureWs().catch(() => {});
    const request = await api<DownloadRequest>(`${control.base}/download-requests`, control.sessionToken, { fileId, ...(chosen ? { mode: chosen } : {}) });
    const receiver = new ReceiveTask(request, sink, control, config.limits, config.stunServers, progress, id => peers?.get(id)); receivers.set(request.id, receiver);
    await receiver.start();
    const waiting = pendingEvents.filter(event => event.request?.id === request.id);
    for (const event of waiting) { pendingEvents.splice(pendingEvents.indexOf(event), 1); await receiver.event(event); }
    document.querySelector<HTMLButtonElement>(`.cancel[data-file="${fileId}"]`)!.hidden = false;
  } catch (failure) { await sink?.abort().catch(() => {}); if (!(failure instanceof DOMException && failure.name === 'AbortError')) error(failure instanceof Error ? failure.message : '下载未完成'); button.disabled = false; }
}
async function restoreSources(files: File[]) {
  const used = new Set<File>();
  for (const registered of share!.files) {
    const file = files.find(candidate => !used.has(candidate) && candidate.name === registered.name && candidate.size === registered.size && candidate.lastModified === registered.lastModified);
    if (!file) continue; used.add(file);
    if (registered.sha256 && bytesToHex((await hashFile(file, config.limits.hashChunkBytes)).digest()) !== registered.sha256) { error(`${file.name} 内容与原文件不同，无法恢复此分享`); continue; }
    sources.set(registered.id, file);
  }
  if (control) { control.capabilities.readable = [...sources.keys()]; await control.heartbeat(); } else await startControl();
  updateShare(share!); toast(`已恢复 ${sources.size}/${share!.files.length} 个源文件。有效期保持不变。`);
}
async function revoke() {
  try { const result = await api<{ share: ShareInfo }>(`/api/shares/${share!.id}`, ownerToken, undefined, 'DELETE'); updateShare(result.share); toast('分享已撤销，清理已启动'); }
  catch (failure) { error(failure instanceof Error ? failure.message : '撤销失败'); }
}
async function setupChallenge() {
  if (!config.challengeRequired) return;
  if (!config.turnstileSiteKey) { error('服务端已要求人机验证，但尚未配置验证组件'); $<HTMLButtonElement>('#create').disabled = true; return; }
  const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
  script.onload = () => {
    const turnstile = (window as unknown as { turnstile: { render(element: HTMLElement, options: object): void } }).turnstile;
    turnstile.render($('#challenge'), { sitekey: config.turnstileSiteKey, action: 'create-share', callback: (value: string) => { challengeToken = value; }, 'expired-callback': () => { challengeToken = ''; } });
  };
  (document.head as unknown as HTMLHeadElement).appendChild(script);
}
async function main() {
  const presenceId = crypto.randomUUID().replaceAll('-', '');
  const presence = () => { void api('/api/presence', undefined, { id: presenceId, page: location.pathname }).catch(() => {}); };
  presence(); const presenceTimer = setInterval(presence, 30000); window.addEventListener('pagehide', () => clearInterval(presenceTimer), { once: true });
  if (location.pathname === '/admin' || location.pathname === '/admin/') { void api<PublicConfig>('/api/config').then(value => mountChat(value)).catch(() => {}); await adminMain(); return; }
  window.addEventListener('focus', () => { void (async () => { if (!config) return; try { const next = await api<PublicConfig>('/api/config'); if (next.admin !== config.admin) { config = next; const link = document.querySelector<HTMLAnchorElement>('.header-link'); if (link) link.textContent = config.admin ? '管理台 · 已登录' : '管理登录'; document.querySelectorAll('.mode-choice').forEach(x => x.remove()); modes(); network(); } } catch { /* 原有传输继续运行，后端仍验证授权。 */ } })(); });
  const match = location.pathname.match(/^\/s\/([a-z0-9_-]{3,32})$/);
  const chatHome = location.pathname === '/' || location.pathname === '/chat';
  if (chatHome) shell('<div id="chat-page"><section class="hero"><h1>正在进入聊天室…</h1><p id="error" class="error-message" role="alert" hidden></p></section></div>');
  else if (!match) renderHome(); else shell('<section class="hero"><div class="eyebrow">临时传</div><h1>正在读取分享…</h1><p id="error" class="error-message" role="alert" hidden></p></section>');
  try {
    config = await api<PublicConfig>('/api/config');
    if (chatHome) { mountChat(config, $('#chat-page')); return; }
    mountChat(config);
    if (!match) { renderHome(); $('#file-limit').textContent = `单文件最高 ${size(config.limits.maxFileBytes)} · 总计最高 ${size(config.limits.maxShareBytes)}`; network(); void setupChallenge(); return; }
    ownerToken = new URLSearchParams(location.hash.slice(1)).get('owner') ?? undefined;
    if (ownerToken && !/^[a-f0-9]{64}$/.test(ownerToken)) ownerToken = undefined;
    try { share = await api<ShareInfo>(`/api/shares/${match[1]}`, ownerToken); }
    catch (failure) {
      if (failure instanceof ApiError && failure.code === 'password_required') { renderUnlock(match[1]); return; }
      if (failure instanceof ApiError && failure.status === 410 && (failure.details as { share?: ShareInfo })?.share) share = (failure.details as { share: ShareInfo }).share; else throw failure;
    }
    renderShare(); if (!ended) await startControl();
  } catch (failure) { error(failure instanceof Error ? failure.message : '服务暂时不可用'); }
}
function renderUnlock(reference: string) {
  shell('<section class="card share-unlock"><span class="eyebrow">受密码保护的分享</span><h1>输入提取密码</h1><p>验证后即可查看文件并下载。</p><form id="unlock-form"><label for="extraction-password">提取密码</label><input id="extraction-password" type="password" minlength="4" maxlength="64" autocomplete="off" required autofocus/><button class="button primary" type="submit">查看文件</button></form><p id="error" class="error-message" role="alert" hidden></p></section>');
  $('#unlock-form').onsubmit = event => { event.preventDefault(); const button = $('#unlock-form button') as HTMLButtonElement; button.disabled = true;
    void (async () => { try { await api(`/api/shares/${reference}/unlock`, undefined, { password: $<HTMLInputElement>('#extraction-password').value }); share = await api<ShareInfo>(`/api/shares/${reference}`); renderShare(); await startControl(); } catch (failure) { error(failure instanceof Error ? failure.message : '验证失败'); button.disabled = false; } })();
  };
}
window.addEventListener('pagehide', () => { clearInterval(transferTimer); peers?.stop(); control?.stop(); uploads?.stop(); for (const sender of senders.values()) sender.stop(); });
void main();
