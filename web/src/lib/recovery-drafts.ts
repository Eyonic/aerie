export type RecoveryKind = 'document' | 'spreadsheet';

export interface RecoveryDraft {
  accountId: number;
  kind: RecoveryKind;
  path: string;
  content: string;
  revision?: string;
  savedAt: string;
}

const DB_NAME = 'aerie-recovery-v1';
const STORE = 'drafts';
const queues = new Map<string, Promise<unknown>>();

function scope(accountId: number, kind: RecoveryKind, path: string) {
  return `${accountId}:${kind}:${path}`;
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
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error || new Error('recovery_storage_unavailable'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('recovery_storage_blocked'));
    };
  });
}

function beginTransaction(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode === 'readwrite') {
    try {
      // Waiting for `complete` confirms the transaction committed. Requesting
      // strict durability additionally asks supporting browsers to flush it to
      // stable storage before reporting completion.
      return db.transaction(STORE, mode, { durability: 'strict' });
    } catch {
      // Older embedded browsers do not support the options overload.
    }
  }
  return db.transaction(STORE, mode);
}

async function transaction<T>(mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, stage: (value: T) => void, fail: (reason?: unknown) => void) => void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = beginTransaction(db, mode);
      let staged: T;
      let hasStagedValue = false;
      let failure: unknown;
      const fail = (reason?: unknown) => {
        failure = reason || new Error('recovery_storage_failed');
        try { tx.abort(); }
        catch { reject(failure); }
      };
      tx.onabort = () => reject(failure || tx.error || new Error('recovery_storage_failed'));
      tx.onerror = () => { failure ||= tx.error || new Error('recovery_storage_failed'); };
      tx.oncomplete = () => hasStagedValue
        ? resolve(staged)
        : reject(new Error('recovery_storage_failed'));
      try {
        operation(tx.objectStore(STORE), value => { staged = value; hasStagedValue = true; }, fail);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function saveRecoveryDraft(draft: Omit<RecoveryDraft, 'savedAt'>): Promise<RecoveryDraft> {
  const saved = { ...draft, savedAt: new Date().toISOString() };
  const key = scope(draft.accountId, draft.kind, draft.path);
  return serialized(key, () => transaction<RecoveryDraft>('readwrite', (store, resolve, reject) => {
      const request = store.put(saved, key);
      request.onsuccess = () => resolve(saved);
      request.onerror = () => reject(request.error);
    }));
}

export async function loadRecoveryDraft(accountId: number, kind: RecoveryKind, path: string): Promise<RecoveryDraft | null> {
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<RecoveryDraft | null>('readonly', (store, resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result;
        resolve(value && value.accountId === accountId && value.kind === kind && value.path === path ? value : null);
      };
      request.onerror = () => reject(request.error);
    }));
}

export async function clearRecoveryDraft(accountId: number, kind: RecoveryKind, path: string): Promise<void> {
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }));
}

/**
 * Remove a draft only when it is still the exact content that was committed to
 * the server. The comparison and delete share one transaction, so a later edit
 * from this tab (or another tab) cannot be erased by an older save finishing.
 */
export async function clearRecoveryDraftIfContent(
  accountId: number,
  kind: RecoveryKind,
  path: string,
  expectedContent: string,
): Promise<boolean> {
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<boolean>('readwrite', (store, resolve, reject) => {
    const read = store.get(key);
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const value = read.result as RecoveryDraft | undefined;
      if (!value
        || value.accountId !== accountId
        || value.kind !== kind
        || value.path !== path
        || value.content !== expectedContent) {
        resolve(false);
        return;
      }
      const remove = store.delete(key);
      remove.onsuccess = () => resolve(true);
      remove.onerror = () => reject(remove.error);
    };
  }));
}

export function downloadRecoveryDraft(draft: RecoveryDraft, filename: string, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([draft.content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|]/g, '_') || 'recovered-draft.txt';
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
