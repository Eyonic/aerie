export type OfflineEditableKind = 'document' | 'spreadsheet';

export interface OfflineEditableCopy {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  title: string;
  content: string;
  /** Server revision that `content` was originally based on. */
  revision: string;
  serverUpdatedAt?: string;
  cachedAt: string;
  locallyUpdatedAt?: string;
  dirty: boolean;
  conflict: boolean;
}

export type OfflineSyncResult =
  | { status: 'missing' | 'clean' | 'synced'; copy: OfflineEditableCopy | null }
  | { status: 'conflict' | 'unavailable'; copy: OfflineEditableCopy; error?: unknown };

const DB_NAME = 'aerie-offline-editables-v1';
const STORE = 'copies';
const queues = new Map<string, Promise<unknown>>();

function scope(accountId: number, kind: OfflineEditableKind, path: string) {
  return `${accountId}:${kind}:${path}`;
}

function assertIdentity(accountId: number, path: string) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !path.startsWith('/')) {
    throw new Error('invalid_offline_copy');
  }
}

function validCopy(value: unknown): value is OfflineEditableCopy {
  if (!value || typeof value !== 'object') return false;
  const copy = value as Partial<OfflineEditableCopy>;
  return Number.isSafeInteger(copy.accountId) && Number(copy.accountId) > 0
    && (copy.kind === 'document' || copy.kind === 'spreadsheet')
    && typeof copy.path === 'string' && copy.path.startsWith('/')
    && typeof copy.title === 'string'
    && typeof copy.content === 'string'
    && typeof copy.revision === 'string' && copy.revision.length > 0
    && typeof copy.cachedAt === 'string'
    && typeof copy.dirty === 'boolean'
    && typeof copy.conflict === 'boolean';
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
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error || new Error('offline_storage_unavailable'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('offline_storage_blocked'));
    };
  });
}

function beginTransaction(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode === 'readwrite') {
    try { return db.transaction(STORE, mode, { durability: 'strict' }); }
    catch { /* Embedded browsers may not support transaction options. */ }
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
      let hasStaged = false;
      let failure: unknown;
      const fail = (reason?: unknown) => {
        failure = reason || new Error('offline_storage_failed');
        try { tx.abort(); } catch { reject(failure); }
      };
      tx.onabort = () => reject(failure || tx.error || new Error('offline_storage_failed'));
      tx.onerror = () => { failure ||= tx.error || new Error('offline_storage_failed'); };
      tx.oncomplete = () => hasStaged ? resolve(staged) : reject(new Error('offline_storage_failed'));
      try {
        operation(tx.objectStore(STORE), value => { staged = value; hasStaged = true; }, fail);
      } catch (error) { fail(error); }
    });
  } finally {
    db.close();
  }
}

function readThen<T>(store: IDBObjectStore, key: string, resolve: (value: T) => void,
  reject: (reason?: unknown) => void, work: (existing: OfflineEditableCopy | null) => T | IDBRequest) {
  const read = store.get(key);
  read.onerror = () => reject(read.error);
  read.onsuccess = () => {
    const existing = validCopy(read.result) ? read.result : null;
    let result: T | IDBRequest;
    try { result = work(existing); } catch (error) { reject(error); return; }
    if (typeof IDBRequest !== 'undefined' && result instanceof IDBRequest) {
      result.onsuccess = () => resolve((result as IDBRequest).result as T);
      result.onerror = () => reject(result.error);
    } else {
      resolve(result as T);
    }
  };
}

export async function getOfflineEditable(
  accountId: number, kind: OfflineEditableKind, path: string,
): Promise<OfflineEditableCopy | null> {
  assertIdentity(accountId, path);
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readonly', (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const copy = validCopy(request.result) ? request.result : null;
      resolve(copy?.accountId === accountId && copy.kind === kind && copy.path === path ? copy : null);
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function listOfflineEditables(
  accountId: number, kind: OfflineEditableKind,
): Promise<OfflineEditableCopy[]> {
  assertIdentity(accountId, '/');
  return serialized(`${accountId}:${kind}:*`, () => transaction<OfflineEditableCopy[]>('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result || [])
      .filter(validCopy)
      .filter(copy => copy.accountId === accountId && copy.kind === kind)
      .sort((a, b) => (b.locallyUpdatedAt || b.serverUpdatedAt || b.cachedAt)
        .localeCompare(a.locallyUpdatedAt || a.serverUpdatedAt || a.cachedAt)));
    request.onerror = () => reject(request.error);
  }));
}

export async function pinOfflineEditable(input: {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  title: string;
  content: string;
  revision: string;
  serverUpdatedAt?: string;
}): Promise<OfflineEditableCopy> {
  assertIdentity(input.accountId, input.path);
  if (!input.revision) throw new Error('invalid_offline_revision');
  const key = scope(input.accountId, input.kind, input.path);
  return serialized(key, () => transaction<OfflineEditableCopy>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (existing?.dirty) throw new Error('offline_copy_dirty');
      const copy: OfflineEditableCopy = {
        ...input,
        cachedAt: new Date().toISOString(),
        dirty: false,
        conflict: false,
      };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      // Resolution happens from the write callbacks above.
      return undefined as never;
    });
  }));
}

/** Refresh a clean pinned copy after an online read. Dirty work is never replaced. */
export async function refreshOfflineEditable(input: {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  title: string;
  content: string;
  revision: string;
  serverUpdatedAt?: string;
}): Promise<OfflineEditableCopy | null> {
  assertIdentity(input.accountId, input.path);
  const key = scope(input.accountId, input.kind, input.path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing || existing.dirty) return existing;
      const copy: OfflineEditableCopy = {
        ...existing, ...input, cachedAt: new Date().toISOString(), dirty: false, conflict: false,
      };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      return undefined as never;
    });
  }));
}

/** Store an edit only when this file was explicitly pinned. */
export async function markOfflineEditableDirty(input: {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  title: string;
  content: string;
  revision?: string;
}): Promise<OfflineEditableCopy | null> {
  assertIdentity(input.accountId, input.path);
  const key = scope(input.accountId, input.kind, input.path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing) return null;
      const copy: OfflineEditableCopy = {
        ...existing,
        title: input.title || existing.title,
        content: input.content,
        // The pinned copy's server revision is authoritative. Caller state can
        // be stale, especially across tabs, so edits never replace this base.
        revision: existing.revision,
        locallyUpdatedAt: new Date().toISOString(),
        dirty: true,
      };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      return undefined as never;
    });
  }));
}

/**
 * Commit a successful conditional server save without losing a newer edit
 * made in another tab while the request was in flight.
 */
export async function commitOfflineEditableSync(input: {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  expectedContent: string;
  expectedRevision: string;
  newRevision: string;
  serverUpdatedAt?: string;
}): Promise<OfflineEditableCopy | null> {
  assertIdentity(input.accountId, input.path);
  const key = scope(input.accountId, input.kind, input.path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing) return null;
      if (existing.revision !== input.expectedRevision) return existing;
      const exact = existing.content === input.expectedContent;
      const copy: OfflineEditableCopy = {
        ...existing,
        revision: input.newRevision,
        serverUpdatedAt: input.serverUpdatedAt || new Date().toISOString(),
        cachedAt: new Date().toISOString(),
        dirty: !exact,
        conflict: false,
        ...(exact ? { locallyUpdatedAt: undefined } : {}),
      };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      return undefined as never;
    });
  }));
}

export async function markOfflineEditableConflict(
  accountId: number, kind: OfflineEditableKind, path: string,
  expected?: { content: string; revision: string },
): Promise<OfflineEditableCopy | null> {
  assertIdentity(accountId, path);
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing) return null;
      // Another tab may already have committed the same edit while this
      // request was in flight. Never turn that newer clean state back into a
      // conflict based on a stale failed request.
      if (!existing.dirty
        || (expected && (existing.content !== expected.content || existing.revision !== expected.revision))) return existing;
      const copy = { ...existing, dirty: true, conflict: true };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      return undefined as never;
    });
  }));
}

/**
 * Finish an explicit conflict choice. If another tab wrote a newer local edit
 * while the choice was being saved, keep that edit dirty on top of the newly
 * accepted server revision instead of discarding it.
 */
export async function resolveOfflineEditableChoice(input: {
  accountId: number;
  kind: OfflineEditableKind;
  path: string;
  expectedLocalContent: string;
  chosenContent: string;
  newRevision: string;
  serverUpdatedAt?: string;
}): Promise<OfflineEditableCopy | null> {
  assertIdentity(input.accountId, input.path);
  const key = scope(input.accountId, input.kind, input.path);
  return serialized(key, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing) return null;
      const newerLocalEdit = existing.content !== input.expectedLocalContent;
      const copy: OfflineEditableCopy = {
        ...existing,
        content: newerLocalEdit ? existing.content : input.chosenContent,
        revision: input.newRevision,
        serverUpdatedAt: input.serverUpdatedAt || new Date().toISOString(),
        cachedAt: new Date().toISOString(),
        dirty: newerLocalEdit,
        conflict: false,
        ...(newerLocalEdit ? {} : { locallyUpdatedAt: undefined }),
      };
      const write = store.put(copy, key);
      write.onsuccess = () => resolve(copy);
      write.onerror = () => reject(write.error);
      return undefined as never;
    });
  }));
}

export async function moveOfflineEditable(
  accountId: number,
  kind: OfflineEditableKind,
  oldPath: string,
  newPath: string,
  title: string,
): Promise<OfflineEditableCopy | null> {
  assertIdentity(accountId, oldPath);
  assertIdentity(accountId, newPath);
  const oldKey = scope(accountId, kind, oldPath);
  const newKey = scope(accountId, kind, newPath);
  return serialized(`${oldKey}->${newKey}`, () => transaction<OfflineEditableCopy | null>('readwrite', (store, resolve, reject) => {
    readThen(store, oldKey, resolve, reject, existing => {
      if (!existing) return null;
      if (existing.dirty) throw new Error('offline_copy_dirty');
      const moved: OfflineEditableCopy = { ...existing, path: newPath, title };
      const write = store.put(moved, newKey);
      write.onerror = () => reject(write.error);
      write.onsuccess = () => {
        const remove = store.delete(oldKey);
        remove.onsuccess = () => resolve(moved);
        remove.onerror = () => reject(remove.error);
      };
      return undefined as never;
    });
  }));
}

export async function removeOfflineEditable(
  accountId: number, kind: OfflineEditableKind, path: string,
): Promise<boolean> {
  assertIdentity(accountId, path);
  const key = scope(accountId, kind, path);
  return serialized(key, () => transaction<boolean>('readwrite', (store, resolve, reject) => {
    readThen(store, key, resolve, reject, existing => {
      if (!existing) return false;
      if (existing.dirty) throw new Error('offline_copy_dirty');
      const remove = store.delete(key);
      remove.onsuccess = () => resolve(true);
      remove.onerror = () => reject(remove.error);
      return undefined as never;
    });
  }));
}

export async function syncOfflineEditable(
  accountId: number,
  kind: OfflineEditableKind,
  path: string,
  save: (path: string, content: string, revision: string) => Promise<{ revision: string }>,
): Promise<OfflineSyncResult> {
  const copy = await getOfflineEditable(accountId, kind, path);
  if (!copy) return { status: 'missing', copy: null };
  if (!copy.dirty) return { status: 'clean', copy };
  try {
    const result = await save(copy.path, copy.content, copy.revision);
    const committed = await commitOfflineEditableSync({
      accountId, kind, path, expectedContent: copy.content,
      expectedRevision: copy.revision, newRevision: result.revision,
    });
    return { status: 'synced', copy: committed };
  } catch (error: any) {
    if (error?.message === 'revision_conflict') {
      const current = (await markOfflineEditableConflict(accountId, kind, path, {
        content: copy.content, revision: copy.revision,
      })) || copy;
      if (current.conflict) return { status: 'conflict', copy: current, error };
      if (current.dirty) return { status: 'unavailable', copy: current, error };
      return { status: 'clean', copy: current };
    }
    return { status: 'unavailable', copy, error };
  }
}
