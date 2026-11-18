import type { ShareTransferMode } from '../shared/types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface LocalSource {
  ownerId: string;
  id: string;
  name: string;
  mime: string;
  lastModified: number;
  transferMode: ShareTransferMode;
  blob: Blob;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('file-share-messenger', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('sources')) request.result.createObjectStore('sources', { keyPath: ['ownerId', 'id'] });
      request.result.createObjectStore('accounts');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}

class RetiredAccount extends Error {}
async function accessSource<T>(account: string, ownerId: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(['accounts', 'sources'], mode);
    const owner = transaction.objectStore('accounts').get(account);
    let request: IDBRequest<T>;
    owner.onsuccess = () => {
      if (owner.result !== ownerId) { transaction.abort(); reject(new RetiredAccount('设备账号已更新，请重新打开通讯录')); return; }
      request = operation(transaction.objectStore('sources'));
    };
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('浏览器文件存储操作已中断'));
  });
}

export class MessengerSources {
  private temporary = new Map<string, LocalSource>();
  private account: string;
  private ready: Promise<void>;
  constructor(private ownerId: string, credential: string) {
    this.account = bytesToHex(sha256(new TextEncoder().encode(credential)));
    const key = 'file-share.messenger.source-owner.' + this.account;
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(key);
      if (previous && previous !== ownerId) this.removeGrants(previous);
      localStorage.setItem(key, ownerId);
    } catch { /* IndexedDB can identify the previous account independently. */ }
    this.ready = this.bind(previous).catch(() => {});
  }

  private removeGrants(previous: string) {
    try {
      const prefix = 'file-share.messenger.room.' + previous + '.';
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    } catch { /* No local grant storage is available. */ }
  }

  /** A renewed account shares its browser credential with the expired incarnation only. */
  private async bind(fallback: string | null) {
    const db = await openDatabase();
    const retired = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(['accounts', 'sources'], 'readwrite');
      const accounts = tx.objectStore('accounts'), lookup = accounts.get(this.account);
      let previous: string | undefined;
      lookup.onsuccess = () => {
        previous = lookup.result ?? fallback;
        if (previous && previous !== this.ownerId) {
          tx.objectStore('sources').delete(IDBKeyRange.bound([previous, ''], [previous, '\uffff']));
        }
        accounts.put(this.ownerId, this.account);
      };
      tx.oncomplete = () => resolve(previous);
      tx.onabort = () => reject(tx.error);
    });
    if (retired && retired !== this.ownerId) this.removeGrants(retired);
  }

  async save(source: LocalSource) {
    await this.ready;
    try { await accessSource(this.account, this.ownerId, 'readwrite', store => store.put(source)); return true; }
    catch (error) {
      if (error instanceof RetiredAccount) throw error;
      this.temporary.set(source.id, source); return false;
    }
  }

  async get(fileId: string): Promise<LocalSource | undefined> {
    await this.ready;
    return this.temporary.get(fileId) ?? await accessSource(this.account, this.ownerId, 'readonly', store => store.get([this.ownerId, fileId])).catch(() => undefined);
  }

  async remove(fileId: string) {
    const temporary = this.temporary.delete(fileId);
    await this.ready;
    try { await accessSource(this.account, this.ownerId, 'readwrite', store => store.delete([this.ownerId, fileId])); }
    catch (error) { if (!temporary && typeof indexedDB !== 'undefined') throw error; }
  }

  close() { this.temporary.clear(); }
}
