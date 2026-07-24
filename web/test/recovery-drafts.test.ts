import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onupgradeneeded: ((event?: unknown) => void) | null = null;
  onblocked: ((event?: unknown) => void) | null = null;
}

class FakeTransaction {
  onabort: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  oncomplete: ((event?: unknown) => void) | null = null;
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
  readonly transactionOptions: Array<unknown> = [];
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

describe('durable recovery drafts', () => {
  let database: FakeIndexedDb;

  beforeEach(() => {
    vi.resetModules();
    database = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', database);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps drafts isolated by account and requests strict write durability', async () => {
    const { loadRecoveryDraft, saveRecoveryDraft } = await import('../src/lib/recovery-drafts');
    await saveRecoveryDraft({ accountId: 7, kind: 'document', path: '/same', content: 'seven' });
    await saveRecoveryDraft({ accountId: 8, kind: 'document', path: '/same', content: 'eight' });

    expect((await loadRecoveryDraft(7, 'document', '/same'))?.content).toBe('seven');
    expect((await loadRecoveryDraft(8, 'document', '/same'))?.content).toBe('eight');
    expect(database.transactionOptions.filter(Boolean)).toEqual([
      { durability: 'strict' },
      { durability: 'strict' },
    ]);
  });

  it('does not let an older server save clear a newer cross-tab draft', async () => {
    const {
      clearRecoveryDraftIfContent, loadRecoveryDraft, saveRecoveryDraft,
    } = await import('../src/lib/recovery-drafts');
    await saveRecoveryDraft({ accountId: 7, kind: 'spreadsheet', path: '/sheet', content: 'old' });
    await saveRecoveryDraft({ accountId: 7, kind: 'spreadsheet', path: '/sheet', content: 'new' });

    expect(await clearRecoveryDraftIfContent(7, 'spreadsheet', '/sheet', 'old')).toBe(false);
    expect((await loadRecoveryDraft(7, 'spreadsheet', '/sheet'))?.content).toBe('new');
    expect(await clearRecoveryDraftIfContent(7, 'spreadsheet', '/sheet', 'new')).toBe(true);
    expect(await loadRecoveryDraft(7, 'spreadsheet', '/sheet')).toBeNull();
  });

  it('stores flattened image recovery blobs per account and can clear them', async () => {
    const { clearImageRecoveryDraft, loadImageRecoveryDraft, saveImageRecoveryDraft } = await import('../src/lib/image-recovery');
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    await saveImageRecoveryDraft({ accountId: 7, sourceKey: '/Photos/same.png', name: 'seven', width: 20, height: 10, blob });
    await saveImageRecoveryDraft({ accountId: 8, sourceKey: '/Photos/same.png', name: 'eight', width: 20, height: 10, blob });

    expect((await loadImageRecoveryDraft(7, '/Photos/same.png'))?.name).toBe('seven');
    expect((await loadImageRecoveryDraft(8, '/Photos/same.png'))?.name).toBe('eight');
    await clearImageRecoveryDraft(7, '/Photos/same.png');
    expect(await loadImageRecoveryDraft(7, '/Photos/same.png')).toBeNull();
    expect((await loadImageRecoveryDraft(8, '/Photos/same.png'))?.blob.type).toBe('image/png');
  });
});
