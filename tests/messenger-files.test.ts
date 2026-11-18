import { afterEach, expect, it, vi } from 'vitest';
import { MessengerFiles } from '../src/client/messenger-files';
import { TransferConnection } from '../src/client/share-transfer';
import type { PublicConfig } from '../src/client/config';
import type { MessengerFile, MessengerTransfer } from '../src/shared/messenger';
import { defaults } from '../src/worker/config';
import { id, token } from '../src/worker/util';

const config: PublicConfig = { limits: defaults, stunServers: [], challengeRequired: false, admin: false, turnConfigured: false, turnMissing: [], r2Configured: false };
const owner = id(), recipient = id();
function ticket(fileId: string, requesterId = recipient): MessengerTransfer {
  return { id: id(), fileId, ownerId: owner, requesterId, createdAt: Date.now(), expiresAt: Date.now() + 300000, status: 'pending' };
}
const file: MessengerFile = { id: id(), ownerId: owner, name: 'test.bin', size: 7, mime: 'application/octet-stream', lastModified: 10, transferMode: 'auto', createdAt: 1 };
function setupPicker() {
  const writer = { truncate: vi.fn(), seek: vi.fn(), abort: vi.fn(), close: vi.fn() };
  const picker = vi.fn(async () => ({ createWritable: () => writer }));
  vi.stubGlobal('window', { showSaveFilePicker: picker });
  return { writer, picker };
}
afterEach(() => vi.unstubAllGlobals());

it('只在设备保存源文件；存储不可用时说明刷新限制，其他账号和其他文件的请求不触发分享', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const files = new MessengerFiles(owner, token(), config);
  const notice = files.onNotice = vi.fn();
  try {
    const meta = await files.prepare(new File(['payload'], file.name, { lastModified: 10 }), 'lan');
    expect(meta).toMatchObject({ name: file.name, size: 7, transferMode: 'lan', lastModified: 10, mime: file.mime });
    expect(Object.keys(meta).sort()).toEqual(['id','lastModified','mime','name','size','transferMode']);
    expect(notice).toHaveBeenCalledOnce();
    files.observe([{...ticket(meta.id), ownerId: id()}, ticket(id())]);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  } finally { files.stop(); }
});

it('两个成员同时请求同一文件时分别建立加密口令房间，重复快照不再次创建，也不上传内容', async () => {
  vi.stubGlobal('indexedDB', undefined);
  vi.spyOn(TransferConnection.prototype, 'start').mockResolvedValue();
  const files = new MessengerFiles(owner, token(), config);
  const rooms: { id: string; password: string }[] = [];
  const patches: string[] = [];
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const body = JSON.parse(String(options!.body));
    if (String(url) === '/api/shares') {
      const shareId = id();
      expect(body.files).toEqual([{ name: file.name, size: 7, mime: file.mime, lastModified: 10 }]);
      expect(body.password).toMatch(/^[0-9a-f]{64}$/);
      rooms.push({ id: shareId, password: body.password });
      return Response.json({ id: shareId, files: [{id: id()}], ownerToken: token(), expiresAt: Date.now() + 3600000 });
    }
    expect(options!.method).toBe('PATCH');
    expect(body.status).toBe('ready'); expect(body.shareId).toBeTruthy(); expect(body.ownerToken).toBeTruthy();
    patches.push(String(url)); return Response.json({ transfer: {} });
  });
  try {
    const meta = await files.prepare(new File(['payload'], file.name, {lastModified: 10}));
    const requests = [ticket(meta.id), ticket(meta.id, id())];
    files.observe(requests); files.observe(requests);
    await vi.waitFor(() => expect(patches.length).toBe(2));
    files.observe(requests);
    expect(rooms).toHaveLength(2);
    expect(new Set(rooms.map(room => room.password)).size).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally { files.stop(); }
});

it('拒绝下载时释放保存句柄；没有点击或没有匹配本页请求的 ready 通知不会打开文件会话', async () => {
  const { writer } = setupPicker();
  const files = new MessengerFiles(recipient, token(), config);
  const remote = { ...ticket(file.id), status: 'ready' as const, shareId: id(), shareFileId: id(), password: token() };
  files.observe([remote]); expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'forbidden', message: '文件不可访问' }, { status: 403 }));
  try {
    await expect(files.download(file, 'conversation')).rejects.toThrow('文件不可访问');
    expect(writer.abort).toHaveBeenCalledOnce(); expect(files.busy(file.id)).toBe(false);
    const pending = ticket(file.id);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ transfer: pending }));
    await files.download(file, 'conversation');
    files.observe([remote]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(files.busy(file.id)).toBe(true);
    const progress = files.onProgress = vi.fn();
    files.observe([{ ...pending, status: 'failed', reason: '文件不可读' }]);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(file.id, '未完成：文件不可读', 0));
    expect(files.busy(file.id)).toBe(false); expect(writer.abort).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(`/api/messenger/transfers/${pending.id}`, expect.objectContaining({method: 'DELETE'}));
  } finally { files.stop(); }
});

it('同一浏览器凭据获得新账号后清理旧账号房间密钥，独立账号的密钥仍保留', () => {
  const storage: Record<string, unknown> = {};
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('indexedDB', undefined);
  const credential = token(), other = id();
  new MessengerFiles(owner, credential, config).stop();
  new MessengerFiles(other, token(), config).stop();
  const key = (account: string) => 'file-share.messenger.room.' + account + '.test';
  storage[key(owner)] = storage[key(other)] = JSON.stringify({ expiresAt: Date.now() + 60000 });
  new MessengerFiles(id(), credential, config).stop();
  expect(storage[key(owner)]).toBeUndefined();
  expect(storage[key(other)]).toBeDefined();
});
