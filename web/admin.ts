import { api, ApiError } from '../src/client/api';
import { MODE_LABELS } from '../src/client/speed';
import type { DownloadRequest, FileInfo, ShareInfo } from '../src/shared/types';
import type { Limits } from '../src/worker/config';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const bytes = (n = 0) => n < 1024 ? `${n} B` : `${(n / 1024 ** (n < 1024 ** 2 ? 1 : n < 1024 ** 3 ? 2 : 3)).toFixed(1)} ${n < 1024 ** 2 ? 'KiB' : n < 1024 ** 3 ? 'MiB' : 'GiB'}`;
const decimalBytes = (n: number) => n < 1000 ** 3 ? bytes(n) : `${(n / 1000 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} GB`;
const count = (n: number) => n.toLocaleString('zh-CN');
const date = (n: number) => new Date(n).toLocaleString('zh-CN');
const modeOptions = [['auto', '自动选择'], ...Object.entries(MODE_LABELS)].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
const stateName = (value: string) => ({ requested: '等待分享者', connecting: '正在连接', transferring: '正在传输', completed: '已完成', canceled: '已取消', failed: '失败' } as Record<string, string>)[value] ?? value;
const active = (task: DownloadRequest) => !['completed', 'canceled', 'failed'].includes(task.status);
interface AdminShare extends ShareInfo { files: (FileInfo & { r2Key?: string })[]; sessions: { id: string; role: string; lastSeen: number }[]; requests: DownloadRequest[] }
interface Overview { ledger: Record<string, number | { bytes: number; at: number } | undefined>; totals: { shares: number; active: number }; files: { files: number; bytes: number; ready: number }; online: { id: string; page: string; lastSeen: number }[]; onlineCount: number; limits: Limits; at: number }
type Target = { shareId: string; fileId?: string; requestId?: string };
type BulkAction = 'revoke-shares' | 'delete-files' | 'set-mode' | 'cancel-requests';
export async function adminMain() {
  const app = document.querySelector('#app')!; let timer: ReturnType<typeof setInterval> | undefined;
  const shell = (html: string) => { app.innerHTML = `<header class="header"><a class="brand" href="/">临时传</a><span class="header-note">管理控制台</span><nav class="header-nav" aria-label="页面导航"><a href="/">聊天室</a><a class="header-link" href="/send">链接分享</a></nav></header><main class="admin-main">${html}</main>`; };
  const message = (text: string) => { const el = document.querySelector('#admin-message'); if (el) el.textContent = text; };
  async function login() {
    clearInterval(timer); shell(`<section class="card admin-login"><span class="eyebrow">ADMIN / 管理登录</span><h1>管理你的分享服务</h1><p>输入管理密码，查看用量和管理分享。</p><form id="admin-login"><label for="admin-password">管理密码</label><input id="admin-password" type="password" autocomplete="current-password" required maxlength="1024"/><button class="button primary" type="submit">登录管理台</button></form><p id="admin-message" role="alert"></p></section>`);
    document.querySelector<HTMLFormElement>('#admin-login')!.onsubmit = event => {
      event.preventDefault(); const input = document.querySelector<HTMLInputElement>('#admin-password')!, button = document.querySelector<HTMLButtonElement>('#admin-login button')!; button.disabled = true;
      void api('/api/admin/login', undefined, { password: input.value }).then(() => { input.value = ''; return dashboard(); }).catch(e => { message(e.message); button.disabled = false; });
    };
  }
  async function dashboard() {
    shell(`<section class="admin-title"><div><span class="eyebrow">ADMIN / 服务管理</span><h1>服务管理</h1><p>管理分享、文件与传输任务。登录有效期 8 小时。</p></div><button class="button secondary" id="admin-logout">退出登录</button></section><p id="admin-message" role="status"></p>
      <nav class="admin-tabs" role="tablist" aria-label="管理页面">${[['overview', '用量总览'], ['tasks', '任务管理'], ['online', '在线页面'], ['objects', 'R2 对象']].map(([id, label], i) => `<button id="tab-${id}" role="tab" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${id}">${label}</button>`).join('')}</nav>
      <section id="panel-overview" class="admin-panel" role="tabpanel" aria-labelledby="tab-overview"><div class="network-heading"><h2>服务用量</h2><button class="button secondary" id="admin-refresh">刷新统计</button></div><div id="admin-metrics" class="admin-metrics"></div><section class="card admin-section"><h2>资源预算</h2><p>额度账本为应用侧统计，实际账单以 Cloudflare 为准。</p><div id="admin-budgets"></div></section></section>
      <section id="panel-tasks" class="admin-panel" role="tabpanel" aria-labelledby="tab-tasks" hidden><section class="card admin-section"><div class="network-heading"><h2>分享与文件</h2><button class="button secondary" id="shares-refresh">重新加载</button></div><p>勾选需要操作的对象。全选只包含已加载的项目；撤销和删除会停止相关传输并清理文件。</p><div class="bulk-toolbar"><label><input type="checkbox" data-all="share"/>全选已加载分享</label><span id="selected-shares">已选 0 个分享</span><button class="button danger" id="bulk-revoke" disabled>撤销所选分享</button></div><div class="bulk-toolbar"><label><input type="checkbox" data-all="file"/>全选已加载文件</label><span id="selected-files">已选 0 个文件</span><label for="bulk-mode">所选文件传输方式</label><select id="bulk-mode">${modeOptions}</select><button class="button secondary" id="bulk-mode-apply" disabled>应用方式</button><button class="button danger" id="bulk-delete" disabled>删除所选文件</button></div><div id="bulk-results" role="status"></div><div id="admin-shares"></div><button class="button secondary" id="shares-more" hidden>加载更多分享</button></section><section class="card admin-section"><h2>传输任务</h2><div class="bulk-toolbar"><label><input type="checkbox" data-all="request"/>全选可取消任务</label><span id="selected-requests">已选 0 个任务</span><button class="button danger" id="bulk-cancel" disabled>取消所选传输</button></div><div id="admin-requests"></div></section></section>
      <section id="panel-online" class="admin-panel card admin-section" role="tabpanel" aria-labelledby="tab-online" hidden><h2>在线页面</h2><p>按浏览器页面会话计数，60 秒内有心跳视为在线。</p><div id="admin-online"></div></section>
      <section id="panel-objects" class="admin-panel card admin-section" role="tabpanel" aria-labelledby="tab-objects" hidden><div class="network-heading"><h2>R2 实际对象</h2><button class="button secondary" id="objects-refresh">查询私有桶</button></div><p>列表包含仍在清理的对象与孤立对象，每次查询计入 R2 Class A。</p><div id="admin-objects"></div><button class="button secondary" id="objects-more" hidden>更多对象</button></section>`);
    const loaded = new Map<string, AdminShare>();
    const selections = { share: new Set<string>(), file: new Set<string>(), request: new Set<string>() };
    let shareCursor: string | null = '', objectCursor: string | null = '', loading = false, working = false, currentTab = 'overview', tasksLoaded = false, objectsLoaded = false;
    const target = (kind: keyof typeof selections, key: string): Target => { const [shareId, item] = key.split('/'); return { shareId, ...(kind === 'file' ? { fileId: item } : kind === 'request' ? { requestId: item } : {}) }; };
    async function action(fn: () => Promise<unknown>) { try { await fn(); message('操作已完成'); } catch (error) { if (error instanceof ApiError && error.status === 403 && error.code === 'admin_forbidden') { await login(); return; } message(error instanceof Error ? error.message : String(error)); } }
    function selectedCounts() {
      for (const [kind, id] of [['share', 'shares'], ['file', 'files'], ['request', 'requests']] as const) {
        document.querySelector(`#selected-${id}`)!.textContent = `已选 ${selections[kind].size} 个${kind === 'share' ? '分享' : kind === 'file' ? '文件' : '任务'}`;
        const boxes = [...document.querySelectorAll<HTMLInputElement>(`input[data-select="${kind}"]:not(:disabled)`)];
        const all = document.querySelector<HTMLInputElement>(`input[data-all="${kind}"]`)!;
        all.checked = boxes.length > 0 && boxes.every(box => box.checked); all.indeterminate = boxes.some(box => box.checked) && !all.checked;
      }
      for (const [id, kind] of [['bulk-revoke', 'share'], ['bulk-delete', 'file'], ['bulk-mode-apply', 'file'], ['bulk-cancel', 'request']] as const) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = working || selections[kind].size === 0;
    }
    function bindSelection() {
      document.querySelectorAll<HTMLInputElement>('input[data-select]').forEach(box => {
        const kind = box.dataset.select as keyof typeof selections; box.checked = selections[kind].has(box.value);
        box.onchange = () => { box.checked ? selections[kind].add(box.value) : selections[kind].delete(box.value); selectedCounts(); };
      }); selectedCounts();
    }
    async function bulk(actionName: BulkAction, kind: keyof typeof selections) {
      const keys = [...selections[kind]]; if (!keys.length || working) return;
      if (actionName !== 'set-mode' && !confirm(`确认${actionName === 'revoke-shares' ? '撤销' : actionName === 'delete-files' ? '删除' : '取消'}所选的 ${keys.length} 个项目？`)) return;
      working = true; selectedCounts(); const results: { target: Target; ok: boolean; message?: string }[] = [];
      try {
        for (let i = 0; i < keys.length; i += 50) {
          const data = await api<{ results: typeof results }>('/api/admin/bulk', undefined, { action: actionName, targets: keys.slice(i, i + 50).map(key => target(kind, key)), ...(actionName === 'set-mode' ? { mode: (document.querySelector('#bulk-mode') as unknown as HTMLSelectElement).value } : {}) }); results.push(...data.results);
        }
        for (const result of results) if (result.ok) selections[kind].delete(`${result.target.shareId}${result.target.fileId ? '/' + result.target.fileId : result.target.requestId ? '/' + result.target.requestId : ''}`);
        const failed = results.filter(result => !result.ok);
        document.querySelector('#bulk-results')!.innerHTML = `<p>成功 ${results.length - failed.length} 项，失败 ${failed.length} 项。</p>${failed.length ? `<ul>${failed.map(result => `<li>${escape(result.target.shareId.slice(0, 8))}：${escape(result.message ?? '请重试')}</li>`).join('')}</ul>` : ''}`;
        await shares(true); await stats();
      } finally { working = false; selectedCounts(); }
    }
    async function stats() {
      const data = await api<Overview>('/api/admin/overview'); const l = data.ledger;
      document.querySelector('#admin-metrics')!.innerHTML = [['在线页面', data.onlineCount], ['有效分享', data.totals.active || 0], ['已登记文件', data.files.files || 0], ['R2 预留容量', bytes(Number(l.r2Bytes || 0))]].map(([name, value]) => `<div class="card"><span>${name}</span><strong>${value}</strong></div>`).join('');
      const turn = l.turnMeasured as { bytes: number; at: number } | undefined;
      const entries: [string, number, number, (n: number) => string][] = [['R2 存储预留', Number(l.r2Bytes || 0), data.limits.r2MaxBytes, bytes], ['R2 Class A / 月', Number(l.classA || 0), data.limits.r2ClassAMonthly, count], ['R2 Class B / 月', Number(l.classB || 0), data.limits.r2ClassBMonthly, count], ['TURN 已测量 + 预留 / 月', (turn?.bytes || 0) + Number(l.turnCommitted || 0) + Number(l.turnReserved || 0), data.limits.turnMonthlyBytes, decimalBytes], ['Worker API 请求 / 日', Number(l.apiRequests || 0), data.limits.apiRequestsPerDay, count], ['DO 计费请求估算 / 日', Number(l.doRequests || 0), data.limits.doRequestsPerDay, count], ['D1 读取行 / 日', Number(l.d1RowsRead || 0), data.limits.d1RowsReadPerDay, count], ['D1 写入行 / 日', Number(l.d1RowsWritten || 0), data.limits.d1RowsWrittenPerDay, count]];
      document.querySelector('#admin-budgets')!.innerHTML = `<div class="budget-row ws-usage"><span>WS 已转发流量 / 月</span><strong>${bytes(Number(l.wsBytes || 0))} · 无流量上限</strong><small>包含在传已转发 ${bytes(Number(l.wsLiveBytes || 0))}；WS 入站消息已结算 ${Number(l.wsMessages || 0).toLocaleString()} 条</small></div>` + `<div class="budget-row https-usage"><span>HTTPS 已转发流量 / 月</span><strong>${bytes(Number(l.httpsBytes || 0))}</strong><small>在传 ${bytes(Number(l.httpsLiveBytes || 0))} · 活跃任务 ${Number(l.httpsActiveTransfers || 0)} · 累计任务活跃 ${(Number(l.httpsActiveMs || 0) / 1000).toFixed(0)} 秒（并行任务相加，非账单时长）</small></div>` + entries.map(([name, used, max, format]) => `<div class="budget-row"><span>${name}</span><strong>${format(used)} / ${format(max)}</strong><progress max="${max}" value="${used}"></progress></div>`).join('') + `<p>TURN 测量时间：${turn ? date(turn.at) : '尚未取得账户分析数据'} · R2 活跃上传 ${Number(l.r2ActiveUploads || 0)} · 更新时间 ${date(data.at)}</p>`;
      document.querySelector('#admin-online')!.innerHTML = data.online.length ? `<div class="table-scroll"><table><thead><tr><th>会话</th><th>页面</th><th>最近在线</th></tr></thead><tbody>${data.online.map(x => `<tr><td><code>${x.id.slice(0, 12)}</code></td><td><a href="${escape(x.page)}">${escape(x.page)}</a></td><td>${date(x.lastSeen)}</td></tr>`).join('')}</tbody></table></div>` : '<p>暂无在线页面</p>';
    }
    function renderManagement() {
      document.querySelector('#admin-shares')!.replaceChildren(); const requests: { share: AdminShare; task: DownloadRequest }[] = [];
      for (const share of loaded.values()) {
        const el = document.createElement('article'); el.className = 'admin-share';
        const status = share.status !== 'active' ? share.status === 'revoked' ? '已撤销' : '已过期' : share.expiresAt <= Date.now() ? '已过期' : '有效';
        el.innerHTML = `<div class="network-heading"><label><input type="checkbox" data-select="share" value="${share.id}"/>选择分享</label><a href="/s/${escape(share.shortCode ?? share.id)}"><code>${escape(share.shortCode ?? share.id.slice(0, 12))}</code></a><span>${status} · ${date(share.expiresAt)} 到期${share.passwordProtected ? ' · 需要提取密码' : ''} · 在线 ${share.sessions.length}</span><button class="button danger revoke-share">撤销并清理</button></div><div class="table-scroll"><table><thead><tr><th>选择</th><th>文件</th><th>大小</th><th>云端状态</th><th>指定传输方式</th><th>操作</th></tr></thead><tbody>${share.files.map(file => `<tr data-file="${file.id}"><td><input type="checkbox" data-select="file" value="${share.id}/${file.id}" aria-label="选择 ${escape(file.name)}" ${file.deleted ? 'disabled' : ''}/></td><td>${escape(file.name)}${file.deleted ? '（已删除）' : ''}</td><td>${bytes(file.size)}</td><td>${escape(file.uploadStatus)}</td><td><select class="admin-mode" aria-label="${escape(file.name)} 的传输方式" ${file.deleted ? 'disabled' : ''}>${modeOptions.replace(`value="${file.forcedMode ?? 'auto'}"`, `value="${file.forcedMode ?? 'auto'}" selected`)}</select></td><td><button class="button danger delete-file" ${file.deleted ? 'disabled' : ''}>删除</button></td></tr>`).join('')}</tbody></table></div>`;
        el.querySelector<HTMLButtonElement>('.revoke-share')!.onclick = () => { if (confirm('撤销此分享并清理所有文件？')) void action(async () => { await api(`/api/admin/shares/${share.id}`, undefined, undefined, 'DELETE'); await shares(true); await stats(); }); };
        el.querySelectorAll<HTMLTableRowElement>('tr[data-file]').forEach(row => {
          row.querySelector<HTMLButtonElement>('.delete-file')!.onclick = () => { if (confirm('删除此文件并停止相关传输？')) void action(async () => { await api(`/api/admin/shares/${share.id}/files/${row.dataset.file}`, undefined, undefined, 'DELETE'); await shares(true); }); };
          (row.querySelector('.admin-mode') as unknown as HTMLSelectElement).onchange = (event: Event) => { void action(() => api(`/api/admin/shares/${share.id}/files/${row.dataset.file}/mode`, undefined, { mode: (event.target as HTMLSelectElement).value })); };
        }); document.querySelector('#admin-shares')!.appendChild(el);
        for (const task of share.requests) requests.push({ share, task });
      }
      document.querySelector('#admin-requests')!.innerHTML = requests.length ? `<div class="table-scroll"><table><thead><tr><th>选择</th><th>文件 / 分享</th><th>当前方式</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${requests.map(({ share, task }) => `<tr><td><input type="checkbox" data-select="request" value="${share.id}/${task.id}" aria-label="选择传输 ${task.id.slice(0, 8)}" ${active(task) ? '' : 'disabled'}/></td><td>${escape(share.files.find(file => file.id === task.fileId)?.name ?? '已删除文件')}<small>${escape(share.shortCode ?? share.id.slice(0, 12))}</small></td><td><span class="transport-badge">${MODE_LABELS[task.mode]}</span></td><td>${stateName(task.status)}${task.error ? `<small>${escape(task.error)}</small>` : ''}</td><td>${date(task.createdAt)}</td><td><button class="button danger cancel-request" data-target="${share.id}/${task.id}" ${active(task) ? '' : 'disabled'}>取消传输</button></td></tr>`).join('')}</tbody></table></div>` : '<p>暂无传输任务</p>';
      document.querySelectorAll<HTMLButtonElement>('.cancel-request').forEach(button => { button.onclick = () => { if (confirm('取消此传输任务？')) void action(async () => { await api('/api/admin/bulk', undefined, { action: 'cancel-requests', targets: [target('request', button.dataset.target!)] }); await shares(true); }); }; });
      if (!loaded.size) document.querySelector('#admin-shares')!.textContent = '暂无分享';
      for (const kind of ['share', 'file', 'request'] as const) { const available = new Set([...document.querySelectorAll<HTMLInputElement>(`input[data-select="${kind}"]:not(:disabled)`)].map(box => box.value)); for (const key of selections[kind]) if (!available.has(key)) selections[kind].delete(key); }
      bindSelection();
    }
    async function shares(reset = false) {
      if (loading || !reset && shareCursor === null) return; loading = true;
      try { if (reset) { shareCursor = ''; loaded.clear(); }
        const data = await api<{ shares: AdminShare[]; cursor: string | null }>(`/api/admin/shares?cursor=${shareCursor ?? ''}`); shareCursor = data.cursor;
        for (const share of data.shares) loaded.set(share.id, share); tasksLoaded = true; renderManagement(); document.querySelector<HTMLButtonElement>('#shares-more')!.hidden = !shareCursor;
      } finally { loading = false; }
    }
    async function objects(reset = false) {
      if (!reset && objectCursor === null) return;
      if (reset) { objectCursor = ''; document.querySelector('#admin-objects')!.replaceChildren(); }
      const data = await api<{ objects: { key: string; size: number; uploaded: number }[]; cursor: string | null }>(`/api/admin/objects?cursor=${encodeURIComponent(objectCursor ?? '')}`); objectCursor = data.cursor; objectsLoaded = true;
      for (const object of data.objects) {
        const row = document.createElement('div'); row.className = 'object-row'; row.innerHTML = `<code>${escape(object.key)}</code><span>${bytes(object.size)} · ${date(object.uploaded)}</span><button class="button danger">删除</button>`;
        row.querySelector('button')!.onclick = () => { if (confirm('删除此 R2 对象？')) void action(async () => { await api('/api/admin/objects', undefined, { key: object.key }, 'DELETE'); row.remove(); await stats(); }); }; document.querySelector('#admin-objects')!.appendChild(row);
      }
      document.querySelector<HTMLButtonElement>('#objects-more')!.hidden = !objectCursor;
      if (!document.querySelector('#admin-objects')!.children.length) document.querySelector('#admin-objects')!.textContent = '当前没有 R2 对象';
    }
    async function showTab(id: string) {
      currentTab = id;
      document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => { const selected = button.dataset.tab === id; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
      document.querySelectorAll<HTMLElement>('.admin-panel').forEach(panel => { panel.hidden = panel.id !== `panel-${id}`; });
      if (id === 'tasks' && !tasksLoaded) await shares(true); else if (id === 'objects' && !objectsLoaded) await objects(true); else if (id === 'online' || id === 'overview') await stats();
    }
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
      button.onclick = () => { void action(() => showTab(button.dataset.tab!)); };
      button.onkeydown = event => { const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')], i = tabs.indexOf(button); const next = event.key === 'ArrowRight' ? (i + 1) % tabs.length : event.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (next >= 0) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); } };
    });
    document.querySelectorAll<HTMLInputElement>('input[data-all]').forEach(all => { all.onchange = () => { const kind = all.dataset.all as keyof typeof selections; for (const box of document.querySelectorAll<HTMLInputElement>(`input[data-select="${kind}"]:not(:disabled)`)) { box.checked = all.checked; all.checked ? selections[kind].add(box.value) : selections[kind].delete(box.value); } selectedCounts(); }; });
    for (const [id, actionName, kind] of [['bulk-revoke', 'revoke-shares', 'share'], ['bulk-delete', 'delete-files', 'file'], ['bulk-mode-apply', 'set-mode', 'file'], ['bulk-cancel', 'cancel-requests', 'request']] as const) document.querySelector<HTMLButtonElement>(`#${id}`)!.onclick = () => { void action(() => bulk(actionName, kind)); };
    document.querySelector<HTMLButtonElement>('#admin-logout')!.onclick = () => { void api('/api/admin/logout', undefined, {}).then(login); };
    document.querySelector<HTMLButtonElement>('#admin-refresh')!.onclick = () => { void action(stats); };
    document.querySelector<HTMLButtonElement>('#shares-refresh')!.onclick = () => { void action(() => shares(true)); };
    document.querySelector<HTMLButtonElement>('#shares-more')!.onclick = () => { void action(() => shares()); };
    document.querySelector<HTMLButtonElement>('#objects-refresh')!.onclick = () => { void action(() => objects(true)); };
    document.querySelector<HTMLButtonElement>('#objects-more')!.onclick = () => { void action(() => objects()); };
    await action(stats); timer = setInterval(() => { if (currentTab === 'overview' || currentTab === 'online') void action(stats); }, 30000);
  }
  try { const state = await api<{ authenticated: boolean }>('/api/admin/session'); if (state.authenticated) await dashboard(); else await login(); }
  catch (error) { await login(); message(error instanceof Error ? error.message : String(error)); }
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
