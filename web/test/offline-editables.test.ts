import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTransaction {
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private completionQueued = false;
  private finished = false;

  constructor(private values: Map<string, unknown>) {}

  objectStore() {
    return {
      put: (value: unknown, key: string) => this.request(() => {
        this.values.set(key, structuredClone(value));
        return key;
      }),
      get: (key: string) => this.request(() => structuredClone(this.values.get(key))),
      getAll: () => this.request(() => [...this.values.values()].map(value => structuredClone(value))),
      delete: (key: string) => this.request(() => {
        this.values.delete(key);
        return undefined;
      }),
    };
  }

  abort() {
    if (this.finished) throw new Error('transaction_finished');
    this.finished = true;
    queueMicrotask(() => this.onabort?.());
  }

  private request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending++;
    queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = operation();
        request.onsuccess?.();
      } catch (error: any) {
        request.error = error;
        this.error = error;
        request.onerror?.();
        this.onerror?.();
      } finally {
        this.pending--;
        this.queueCompletion();
      }
    });
    return request;
  }

  private queueCompletion() {
    if (this.pending || this.completionQueued || this.finished) return;
    this.completionQueued = true;
    queueMicrotask(() => {
      this.completionQueued = false;
      if (this.pending || this.finished) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }
}

class FakeIndexedDb {
  readonly values = new Map<string, unknown>();
  readonly transactionOptions: unknown[] = [];
  private opened = false;

  open() {
    const request = new FakeRequest<any>();
    const database = {
      objectStoreNames: { contains: () => this.opened },
      createObjectStore: () => { this.opened = true; },
      transaction: (_store: string, _mode: string, options?: unknown) => {
        this.transactionOptions.push(options);
        return new FakeTransaction(this.values);
      },
      close: () => {},
      onversionchange: null,
    };
    queueMicrotask(() => {
      request.result = database;
      if (!this.opened) request.onupgradeneeded?.();
      this.opened = true;
      request.onsuccess?.();
    });
    return request;
  }
}

describe('offline editable copies', () => {
  let database: FakeIndexedDb;

  beforeEach(() => {
    vi.resetModules();
    database = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', database);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('isolates pinned copies by account and kind', async () => {
    const { listOfflineEditables, pinOfflineEditable } = await import('../src/lib/offline-editables');
    await pinOfflineEditable({ accountId: 7, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'seven', revision: 'r1' });
    await pinOfflineEditable({ accountId: 8, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'eight', revision: 'r2' });
    await pinOfflineEditable({ accountId: 7, kind: 'spreadsheet', path: '/Spreadsheets/a.csv', title: 'A', content: 'x', revision: 'r3' });

    expect((await listOfflineEditables(7, 'document')).map(copy => copy.content)).toEqual(['seven']);
    expect((await listOfflineEditables(8, 'document')).map(copy => copy.content)).toEqual(['eight']);
    expect((await listOfflineEditables(7, 'spreadsheet')).map(copy => copy.content)).toEqual(['x']);
    expect(database.transactionOptions.some(options => JSON.stringify(options) === JSON.stringify({ durability: 'strict' }))).toBe(true);
  });

  it('never unpins dirty work', async () => {
    const { getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, removeOfflineEditable } = await import('../src/lib/offline-editables');
    await pinOfflineEditable({ accountId: 7, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'server', revision: 'r1' });
    await markOfflineEditableDirty({ accountId: 7, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'local', revision: 'r1' });

    await expect(removeOfflineEditable(7, 'document', '/Documents/a.cbxdoc')).rejects.toThrow('offline_copy_dirty');
    expect((await getOfflineEditable(7, 'document', '/Documents/a.cbxdoc'))?.content).toBe('local');
  });

  it('syncs against the stored base revision and marks an exact save clean', async () => {
    const { getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, syncOfflineEditable } = await import('../src/lib/offline-editables');
    await pinOfflineEditable({ accountId: 7, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'server', revision: 'r1' });
    await markOfflineEditableDirty({ accountId: 7, kind: 'document', path: '/Documents/a.cbxdoc', title: 'A', content: 'local', revision: 'wrong' });
    const save = vi.fn(async () => ({ revision: 'r2' }));

    expect((await syncOfflineEditable(7, 'document', '/Documents/a.cbxdoc', save)).status).toBe('synced');
    expect(save).toHaveBeenCalledWith('/Documents/a.cbxdoc', 'local', 'r1');
    expect(await getOfflineEditable(7, 'document', '/Documents/a.cbxdoc')).toMatchObject({ content: 'local', revision: 'r2', dirty: false, conflict: false });
  });

  it('keeps a newer cross-tab edit dirty while advancing its safe base revision', async () => {
    const { getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, syncOfflineEditable } = await import('../src/lib/offline-editables');
    const identity = { accountId: 7, kind: 'spreadsheet' as const, path: '/Spreadsheets/a.cbxsheet', title: 'A' };
    await pinOfflineEditable({ ...identity, content: 'server', revision: 'r1' });
    await markOfflineEditableDirty({ ...identity, content: 'first', revision: 'r1' });

    await syncOfflineEditable(7, 'spreadsheet', identity.path, async () => {
      await markOfflineEditableDirty({ ...identity, content: 'newer', revision: 'r1' });
      return { revision: 'r2' };
    });

    expect(await getOfflineEditable(7, 'spreadsheet', identity.path)).toMatchObject({ content: 'newer', revision: 'r2', dirty: true, conflict: false });
  });

  it('marks revision conflicts for review without changing local content', async () => {
    const { getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, syncOfflineEditable } = await import('../src/lib/offline-editables');
    const identity = { accountId: 7, kind: 'document' as const, path: '/Documents/a.cbxdoc', title: 'A' };
    await pinOfflineEditable({ ...identity, content: 'server', revision: 'r1' });
    await markOfflineEditableDirty({ ...identity, content: 'mine', revision: 'r1' });

    const outcome = await syncOfflineEditable(7, 'document', identity.path, async () => { throw new Error('revision_conflict'); });
    expect(outcome.status).toBe('conflict');
    expect(await getOfflineEditable(7, 'document', identity.path)).toMatchObject({ content: 'mine', revision: 'r1', dirty: true, conflict: true });
  });

  it('does not resurrect a stale conflict after another tab already synced the edit', async () => {
    const {
      commitOfflineEditableSync, getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, syncOfflineEditable,
    } = await import('../src/lib/offline-editables');
    const identity = { accountId: 7, kind: 'document' as const, path: '/Documents/a.cbxdoc', title: 'A' };
    await pinOfflineEditable({ ...identity, content: 'server', revision: 'r1' });
    await markOfflineEditableDirty({ ...identity, content: 'mine', revision: 'r1' });

    const outcome = await syncOfflineEditable(7, 'document', identity.path, async () => {
      await commitOfflineEditableSync({
        ...identity, expectedContent: 'mine', expectedRevision: 'r1', newRevision: 'r2',
      });
      throw new Error('revision_conflict');
    });

    expect(outcome.status).toBe('clean');
    expect(await getOfflineEditable(7, 'document', identity.path)).toMatchObject({ content: 'mine', revision: 'r2', dirty: false, conflict: false });
  });

  it('keeps a newer edit made while an explicit conflict choice is resolving', async () => {
    const {
      getOfflineEditable, markOfflineEditableDirty, pinOfflineEditable, resolveOfflineEditableChoice,
    } = await import('../src/lib/offline-editables');
    const identity = { accountId: 7, kind: 'spreadsheet' as const, path: '/Spreadsheets/a.cbxsheet', title: 'A' };
    await pinOfflineEditable({ ...identity, content: 'server-v1', revision: 'r1' });
    await markOfflineEditableDirty({ ...identity, content: 'draft-in-dialog', revision: 'r1' });
    await markOfflineEditableDirty({ ...identity, content: 'newer-tab-edit', revision: 'r1' });

    await resolveOfflineEditableChoice({
      ...identity, expectedLocalContent: 'draft-in-dialog', chosenContent: 'server-v2', newRevision: 'r2',
    });

    expect(await getOfflineEditable(7, 'spreadsheet', identity.path)).toMatchObject({
      content: 'newer-tab-edit', revision: 'r2', dirty: true, conflict: false,
    });
  });

  it('moves only clean pinned copies when a server file is renamed', async () => {
    const { getOfflineEditable, moveOfflineEditable, pinOfflineEditable } = await import('../src/lib/offline-editables');
    await pinOfflineEditable({ accountId: 7, kind: 'document', path: '/Documents/old.cbxdoc', title: 'Old', content: 'body', revision: 'r1' });

    await moveOfflineEditable(7, 'document', '/Documents/old.cbxdoc', '/Documents/new.cbxdoc', 'New');

    expect(await getOfflineEditable(7, 'document', '/Documents/old.cbxdoc')).toBeNull();
    expect(await getOfflineEditable(7, 'document', '/Documents/new.cbxdoc')).toMatchObject({ title: 'New', content: 'body', revision: 'r1', dirty: false });
  });
});
