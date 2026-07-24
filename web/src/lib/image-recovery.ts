export interface ImageRecoveryDraft {
  accountId: number;
  sourceKey: string;
  name: string;
  width: number;
  height: number;
  blob: Blob;
  savedAt: string;
}

const DB_NAME = 'aerie-image-recovery-v1';
const STORE = 'drafts';
const MAX_RECOVERY_BYTES = 48 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();

function keyFor(accountId: number, sourceKey: string) {
  return `${accountId}:${sourceKey}`;
}

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queues.set(key, next);
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('image_recovery_unavailable'));
    request.onblocked = () => reject(new Error('image_recovery_blocked'));
  });
}

async function transaction<T>(mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error?: unknown) => void) => void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      let result: T;
      let ready = false;
      let failure: unknown;
      let tx: IDBTransaction;
      try { tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch { tx = db.transaction(STORE, mode); }
      const stage = (value: T) => { result = value; ready = true; };
      const fail = (error?: unknown) => { failure = error || new Error('image_recovery_failed'); try { tx.abort(); } catch { reject(failure); } };
      tx.oncomplete = () => ready ? resolve(result) : reject(new Error('image_recovery_failed'));
      tx.onabort = () => reject(failure || tx.error || new Error('image_recovery_failed'));
      tx.onerror = () => { failure ||= tx.error; };
      try { run(tx.objectStore(STORE), stage, fail); } catch (error) { fail(error); }
    });
  } finally { db.close(); }
}

export async function saveImageRecoveryDraft(draft: Omit<ImageRecoveryDraft, 'savedAt'>): Promise<ImageRecoveryDraft> {
  if (draft.blob.size > MAX_RECOVERY_BYTES) throw new Error('image_recovery_too_large');
  const saved = { ...draft, savedAt: new Date().toISOString() };
  const key = keyFor(draft.accountId, draft.sourceKey);
  return serialized(key, () => transaction<ImageRecoveryDraft>('readwrite', (store, resolve, reject) => {
    const request = store.put(saved, key);
    request.onsuccess = () => resolve(saved);
    request.onerror = () => reject(request.error);
  }));
}

export async function loadImageRecoveryDraft(accountId: number, sourceKey: string): Promise<ImageRecoveryDraft | null> {
  const key = keyFor(accountId, sourceKey);
  return serialized(key, () => transaction<ImageRecoveryDraft | null>('readonly', (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const value = request.result as ImageRecoveryDraft | undefined;
      resolve(value?.accountId === accountId && value.sourceKey === sourceKey && value.blob instanceof Blob ? value : null);
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function clearImageRecoveryDraft(accountId: number, sourceKey: string): Promise<void> {
  const key = keyFor(accountId, sourceKey);
  return serialized(key, () => transaction<void>('readwrite', (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
}
