import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const catalogCalls: Array<{ kind: string; value: any }> = [];
const entry = (name: string, size: number, mtimeMs: number) => ({
  path: `/Docs/${name}`,
  parent: '/Docs',
  name,
  extension: name.split('.').pop() || '',
  kind: 'text',
  mime: 'text/plain',
  size,
  mtimeMs,
  birthtimeMs: mtimeMs,
  isFolder: false,
});

mock.module(new URL('../src/services/file-catalog.js', import.meta.url).href, {
  namedExports: {
    ensureFileCatalog: async (user: any) => {
      catalogCalls.push({ kind: 'ensure', value: user });
      return { refreshed: false };
    },
    searchFileCatalog: (_userId: number, query: string, options: any) => {
      catalogCalls.push({ kind: 'search', value: { query, options } });
      return [entry('Project Plan.txt', 1536, Date.UTC(2026, 0, 1))];
    },
    listFileCatalog: (_userId: number, options: any) => {
      catalogCalls.push({ kind: 'list', value: options });
      return options.sort === 'largest'
        ? [entry('Archive.bin', 4096, Date.UTC(2025, 0, 1))]
        : [entry('Today.txt', 32, Date.UTC(2026, 6, 22))];
    },
    fileCatalogUsage: () => ({
      usedBytes: 128,
      fileCount: 3,
      byKind: { text: { count: 3, bytes: 128 } },
    }),
  },
});
mock.module(new URL('../src/services/storage-write.js', import.meta.url).href, {
  namedExports: { chargedUsageBytes: async () => 1536 },
});
mock.module(new URL('../src/services/storage.js', import.meta.url).href, {
  namedExports: {
    computeUsage: () => { throw new Error('legacy synchronous usage walk must not run'); },
    statReal: () => { throw new Error('not used by catalog tools'); },
  },
});
mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, { namedExports: {} });
mock.module(new URL('../src/services/audiobookshelf.js', import.meta.url).href, { namedExports: {} });
mock.module(new URL('../src/services/progress.js', import.meta.url).href, { namedExports: {} });
mock.module(new URL('../src/services/ai.js', import.meta.url).href, { namedExports: {} });
mock.module(new URL('../src/services/image-jobs.js', import.meta.url).href, {
  namedExports: { enqueueImageJob: () => 'unused' },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: { db: { prepare: () => ({ all: () => [], run: () => ({}) }) } },
});

const { execTool, toolsForUser } = await import('../src/services/aitools.js');
const context = {
  userId: 7,
  username: 'alice',
  user: { id: 7, username: 'alice', features: { files: true } } as any,
};

test('assistant file tools use bounded catalog queries and charged storage usage', async () => {
  const search = await execTool('search_files', { query: '  project  ' }, context);
  assert.deepEqual(search, {
    count: 1,
    files: [{ name: 'Project Plan.txt', path: '/Docs/Project Plan.txt', size: '1.5 KB' }],
  });

  const largest = await execTool('largest_files', { limit: 50_000 }, context);
  assert.equal(largest.files[0].name, 'Archive.bin');
  const recent = await execTool('recent_files', { limit: -4 }, context);
  assert.deepEqual(recent.files, [{
    name: 'Today.txt',
    path: '/Docs/Today.txt',
    modified: '2026-07-22T00:00:00.000Z',
  }]);

  const usage = await execTool('storage_usage', {}, context);
  assert.deepEqual(usage, { used: '1.5 KB', files: 3, byType: { text: '128.0 B' } });

  assert.deepEqual(catalogCalls.filter(call => call.kind === 'search').map(call => call.value), [
    { query: 'project', options: { limit: 25, includeFolders: false } },
  ]);
  assert.deepEqual(catalogCalls.filter(call => call.kind === 'list').map(call => call.value), [
    { includeFolders: false, sort: 'largest', limit: 50 },
    { includeFolders: false, sort: 'recent', limit: 10 },
  ]);
  assert.equal(catalogCalls.filter(call => call.kind === 'ensure').length, 4);
});

test('assistant only advertises and executes tools for enabled content categories', async () => {
  const restricted = {
    id: 7,
    username: 'alice',
    features: { files: false, photos: false, videos: false, movies: false, tv: false, music: false, audiobooks: false },
  } as any;
  const names = toolsForUser(restricted).map(tool => tool.function.name);
  assert.deepEqual(names, ['generate_image'], 'ordinary AI remains available while private content tools are removed');

  await assert.rejects(
    () => execTool('search_files', { query: 'private' }, { ...context, user: restricted }),
    (error: any) => error?.message === 'feature_disabled' && error?.feature === 'files',
  );
  await assert.rejects(
    () => execTool('list_media', { kind: 'movies' }, { ...context, user: restricted }),
    (error: any) => error?.message === 'feature_disabled' && error?.feature === 'movies',
  );
});

test.after(() => mock.reset());
