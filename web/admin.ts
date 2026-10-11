import { api, ApiError } from '../src/client/api';
import type { DownloadRequest, FileInfo, ShareInfo } from '../src/shared/types';
import type { Limits } from '../src/worker/config';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const bytes = (n = 0) => n < 1024 ? `${n} B` : `${(n / 1024 ** (n < 1024 ** 2 ? 1 : n < 1024 ** 3 ? 2 : 3)).toFixed(1)} ${n < 1024 ** 2 ? 'KiB' : n < 1024 ** 3 ? 'MiB' : 'GiB'}`;
const date = (n: number) => new Date(n).toLocaleString('zh-CN');
interface AdminShare extends ShareInfo { files: (FileInfo & { r2Key?: string })[]; sessions: { id: string; role: string; lastSeen: number }[]; requests: DownloadRequest[] }
interface Overview { ledger: Record<string, number | { bytes: number; at: number } | undefined>; totals: { shares: number; active: number }; files: { files: number; bytes: number; ready: number }; online: { id: string; page: string; lastSeen: number }[]; onlineCount: number; limits: Limits; at: number }
export async function adminMain() {
  const app = document.querySelector('#app')!; let timer: ReturnType<typeof setInterval> | undefined;
  const shell = (html: string) => { app.innerHTML = `<header class="header"><a class="brand" href="/">临时传</a><span class="header-note">管理控制台</span><a class="header-link" href="/">返回分享</a></header><main class="admin-main">${html}</main>`; };
  const message = (text: string) => { const el = document.querySelector('#admin-message'); if (el) el.textContent = text; };
  async function login() {
    clearInterval(timer); shell(`<section class="card admin-login"><span class="eyebrow">ADMIN / 管理登录</span><h1>管理你的分享服务</h1><p>输入 ADMIN_TOKEN 对应的管理密码。登录后此浏览器可以使用和指定 R2 传输。</p><form id="admin-login"><label for="admin-password">管理密码</label><input id="admin-password" type="password" autocomplete="current-password" required maxlength="1024"/><button class="button primary" type="submit">登录管理台</button></form><p id="admin-message" role="alert"></p></section>`);
    document.querySelector<HTMLFormElement>('#admin-login')!.onsubmit = event => {
      event.preventDefault(); const input = document.querySelector<HTMLInputElement>('#admin-password')!, button = document.querySelector<HTMLButtonElement>('#admin-login button')!; button.disabled = true;
      void api('/api/admin/login', undefined, { password: input.value }).then(() => { input.value = ''; return dashboard(); }).catch(e => { message(e.message); button.disabled = false; });
    };
  }
  async function dashboard() {
    shell(`<section class="admin-title"><div><span class="eyebrow">ADMIN / 服务管理</span><h1>用量与文件</h1><p>登录有效期 8 小时。额度账本为应用侧统计；账单以 Cloudflare 为准。</p></div><div><button class="button secondary" id="admin-refresh">刷新统计</button><button class="button secondary" id="admin-logout">退出登录</button></div></section><p id="admin-message" role="status"></p><div id="admin-metrics" class="admin-metrics"></div><section class="card admin-section"><h2>资源预算</h2><div id="admin-budgets"></div></section><section class="card admin-section"><div class="network-heading"><h2>所有分享与文件</h2><button class="button secondary" id="shares-refresh">重新加载</button></div><p>每页 20 个分享。删除文件会取消传输、删除 R2 对象并保留迟到上传的清理记录。在线传输会按已写入偏移切换，后续下载也使用指定方式；失败后报告错误。</p><div id="admin-shares"></div><button class="button secondary" id="shares-more" hidden>加载更多分享</button></section><section class="card admin-section"><h2>在线页面</h2><p>按浏览器页面会话计数，60 秒内有心跳视为在线。</p><div id="admin-online"></div></section><section class="card admin-section"><div class="network-heading"><h2>R2 实际对象</h2><button class="button secondary" id="objects-refresh">查询私有桶</button></div><p>仅管理本项目 temporary/ 前缀。列表包含仍在清理的对象和孤立对象；每次查询计入 R2 Class A。</p><div id="admin-objects"></div><button class="button secondary" id="objects-more" hidden>更多对象</button></section>`);
    document.querySelector<HTMLButtonElement>('#admin-logout')!.onclick = () => { void api('/api/admin/logout', undefined, {}).then(login); };
    let shareCursor: string | null = '', objectCursor: string | null = '', loading = false;
    async function action(fn: () => Promise<unknown>) { try { await fn(); message('操作已完成'); } catch (error) { if (error instanceof ApiError && error.status === 403) { await login(); return; } message(error instanceof Error ? error.message : String(error)); } }
    async function stats() {
      const data = await api<Overview>('/api/admin/overview'); const l = data.ledger;
      document.querySelector('#admin-metrics')!.innerHTML = [['在线页面', data.onlineCount], ['有效分享', data.totals.active || 0], ['已登记文件', data.files.files || 0], ['R2 预留容量', bytes(Number(l.r2Bytes || 0))]].map(([name, value]) => `<div class="card"><span>${name}</span><strong>${value}</strong></div>`).join('');
      const turn = l.turnMeasured as { bytes: number; at: number } | undefined;
      const entries: [string, number, number, boolean][] = [['R2 存储预留', Number(l.r2Bytes || 0), data.limits.r2MaxBytes, true], ['R2 Class A / 月', Number(l.classA || 0), data.limits.r2ClassAMonthly, false], ['R2 Class B / 月', Number(l.classB || 0), data.limits.r2ClassBMonthly, false], ['WS 流量 / 月', Number(l.wsBytes || 0) + Number(l.wsReserved || 0), data.limits.wsMonthlyBytes, true], ['TURN 已测量 + 预留 / 月', (turn?.bytes || 0) + Number(l.turnCommitted || 0) + Number(l.turnReserved || 0), data.limits.turnMonthlyBytes, true], ['API 请求 / 日', Number(l.apiRequests || 0), data.limits.apiRequestsPerDay, false], ['DO 请求 / 日', Number(l.doRequests || 0), data.limits.doRequestsPerDay, false], ['D1 读取行 / 日', Number(l.d1RowsRead || 0), data.limits.d1RowsReadPerDay, false], ['D1 写入行 / 日', Number(l.d1RowsWritten || 0), data.limits.d1RowsWrittenPerDay, false]];
      document.querySelector('#admin-budgets')!.innerHTML = entries.map(([name, used, max, binary]) => `<div class="budget-row"><span>${name}</span><strong>${binary ? bytes(used) : used.toLocaleString()} / ${binary ? bytes(max) : max.toLocaleString()}</strong><progress max="${max}" value="${used}"></progress></div>`).join('') + `<p>TURN 测量时间：${turn ? date(turn.at) : '尚未取得账户分析数据'} · R2 活跃上传 ${Number(l.r2ActiveUploads || 0)} · 更新时间 ${date(data.at)}</p>`;
      document.querySelector('#admin-online')!.innerHTML = data.online.length ? `<div class="table-scroll"><table><thead><tr><th>会话</th><th>页面</th><th>最近在线</th></tr></thead><tbody>${data.online.map(x => `<tr><td><code>${x.id.slice(0, 12)}</code></td><td><a href="${escape(x.page)}">${escape(x.page)}</a></td><td>${date(x.lastSeen)}</td></tr>`).join('')}</tbody></table></div>` : '<p>暂无在线页面</p>';
    }
    async function shares(reset = false) {
      if (loading || (!reset && shareCursor === null)) return; loading = true;
      try {
        if (reset) { shareCursor = ''; document.querySelector('#admin-shares')!.replaceChildren(); }
        const data = await api<{ shares: AdminShare[]; cursor: string | null }>(`/api/admin/shares?cursor=${shareCursor ?? ''}`); shareCursor = data.cursor;
        for (const share of data.shares) {
          const el = document.createElement('article'); el.className = 'admin-share';
          const status = share.status !== 'active' ? share.status === 'revoked' ? '已撤销' : '已过期' : share.expiresAt <= Date.now() ? '已过期' : '有效';
          el.innerHTML = `<div class="network-heading"><a href="/s/${share.id}"><code>${share.id.slice(0, 12)}</code></a><span>${status} · ${date(share.expiresAt)} 到期 · 清理 ${share.cleanupStatus} · 在线 ${share.sessions.length} · 下载 ${share.activeRequests}</span><button class="button danger revoke-share">撤销并清理</button></div><div class="table-scroll"><table><thead><tr><th>文件</th><th>大小</th><th>云端状态</th><th>指定传输方式</th><th>管理</th></tr></thead><tbody>${share.files.map(file => `<tr data-file="${file.id}"><td>${escape(file.name)}${file.deleted ? '（已删除）' : ''}</td><td>${bytes(file.size)}</td><td>${escape(file.uploadStatus)}</td><td><select class="admin-mode" aria-label="${escape(file.name)} 的传输方式" ${file.deleted ? 'disabled' : ''}>${[['auto', '自动'], ['p2p', '强制 P2P'], ['turn', '强制 TURN'], ['ws', '强制 WS'], ['r2', '强制 R2']].map(([value, label]) => `<option value="${value}" ${value === (file.forcedMode ?? 'auto') ? 'selected' : ''}>${label}</option>`).join('')}</select></td><td><button class="button danger delete-file" ${file.deleted ? 'disabled' : ''}>删除文件</button></td></tr>`).join('')}</tbody></table></div><p>连接中的传输：${share.requests.filter(x => ['connecting', 'transferring'].includes(x.status)).map(x => `${escape(x.mode)} · ${x.fileId.slice(0, 8)}`).join('，') || '无'}</p>`;
          el.querySelector<HTMLButtonElement>('.revoke-share')!.onclick = () => { if (confirm('撤销此分享并清理所有文件？')) void action(async () => { await api(`/api/admin/shares/${share.id}`, undefined, undefined, 'DELETE'); await shares(true); await stats(); }); };
          el.querySelectorAll<HTMLTableRowElement>('tr[data-file]').forEach(row => {
            row.querySelector<HTMLButtonElement>('.delete-file')!.onclick = () => { if (confirm('删除此文件、R2 对象并取消相关传输？')) void action(async () => { await api(`/api/admin/shares/${share.id}/files/${row.dataset.file}`, undefined, undefined, 'DELETE'); await shares(true); await stats(); }); };
            (row.querySelector('.admin-mode') as unknown as HTMLSelectElement).onchange = event => { const mode = (event.target as HTMLSelectElement).value; void action(() => api(`/api/admin/shares/${share.id}/files/${row.dataset.file}/mode`, undefined, { mode })); };
          }); document.querySelector('#admin-shares')!.appendChild(el);
        }
        document.querySelector<HTMLButtonElement>('#shares-more')!.hidden = !shareCursor;
        if (!document.querySelector('#admin-shares')!.children.length) document.querySelector('#admin-shares')!.textContent = '暂无分享';
      } finally { loading = false; }
    }
    async function objects(reset = false) {
      if (!reset && objectCursor === null) return;
      if (reset) { objectCursor = ''; document.querySelector('#admin-objects')!.replaceChildren(); }
      const data = await api<{ objects: { key: string; size: number; uploaded: number }[]; cursor: string | null }>(`/api/admin/objects?cursor=${encodeURIComponent(objectCursor ?? '')}`); objectCursor = data.cursor;
      for (const object of data.objects) {
        const row = document.createElement('div'); row.className = 'object-row'; row.innerHTML = `<code>${escape(object.key)}</code><span>${bytes(object.size)} · ${date(object.uploaded)}</span><button class="button danger">删除</button>`;
        row.querySelector('button')!.onclick = () => { if (confirm('删除此 R2 对象？有关联的文件和上传也会被取消。')) void action(async () => { await api('/api/admin/objects', undefined, { key: object.key }, 'DELETE'); row.remove(); await stats(); }); }; document.querySelector('#admin-objects')!.appendChild(row);
      }
      document.querySelector<HTMLButtonElement>('#objects-more')!.hidden = !objectCursor;
      if (!document.querySelector('#admin-objects')!.children.length) document.querySelector('#admin-objects')!.textContent = '当前没有 R2 对象';
    }
    document.querySelector<HTMLButtonElement>('#admin-refresh')!.onclick = () => { void action(stats); };
    document.querySelector<HTMLButtonElement>('#shares-refresh')!.onclick = () => { void action(() => shares(true)); };
    document.querySelector<HTMLButtonElement>('#shares-more')!.onclick = () => { void action(() => shares()); };
    document.querySelector<HTMLButtonElement>('#objects-refresh')!.onclick = () => { void action(() => objects(true)); };
    document.querySelector<HTMLButtonElement>('#objects-more')!.onclick = () => { void action(() => objects()); };
    await action(async () => { await stats(); await shares(true); }); timer = setInterval(() => { void action(stats); }, 30000);
  }
  try { const state = await api<{ authenticated: boolean }>('/api/admin/session'); if (state.authenticated) await dashboard(); else await login(); }
  catch (error) { await login(); message(error instanceof Error ? error.message : String(error)); }
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
