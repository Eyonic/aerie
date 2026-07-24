import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aerie-subtitle-translation-'));
await fs.writeFile(path.join(temporary, 'source.vtt'), [
  'WEBVTT',
  '',
  '1',
  '00:00:00.000 --> 00:00:02.000',
  'Good morning',
  '',
].join('\n'));
await fs.writeFile(path.join(temporary, 'source-many.vtt'), [
  'WEBVTT',
  '',
  ...Array.from({ length: 41 }, (_, index) => [
    String(index + 1),
    `00:00:${String(index).padStart(2, '0')}.000 --> 00:00:${String(index + 1).padStart(2, '0')}.000`,
    `Line ${index + 1}`,
    '',
  ]).flat(),
].join('\n'));

const aiCalls: any[] = [];
const providerChecks: any[] = [];
let insertedSubtitle: any[] | null = null;
let selectedProvider = 'external';
let externalAllowed = true;
let accountAiEnabled = true;
let notificationWaiter: ((notification: any) => void) | null = null;
const notifications: any[] = [];
let aiReply = async (args: any[]) => {
  const batch = JSON.parse(args[1]);
  return JSON.stringify(batch.map((item: any) => ({ ...item, text: 'おはようございます' })));
};

function waitForNotification(): Promise<any> {
  const ready = notifications.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subtitle job timed out')), 2_000);
    notificationWaiter = notification => { clearTimeout(timer); notificationWaiter = null; resolve(notification); };
  });
}
const activeRow = {
  id: 31,
  username: 'subtitle-user',
  ai_mode: 'external_allowed',
  disabled_at: null,
  features: '{}',
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: {
    config: {
      subtitlesDir: temporary,
      mediaPathMap: '',
      mediaRoot: temporary,
    },
  },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    notify: (_userId: number, title: string, message: string, type: string) => {
      const notification = { title, message, type };
      if (notificationWaiter) notificationWaiter(notification);
      else notifications.push(notification);
    },
    db: {
      prepare: (sql: string) => ({
        all: () => [],
        get: (...args: any[]) => {
          if (sql.includes('COUNT(*) count')) return { count: 0 };
          if (sql.includes('FROM subtitles WHERE id=? AND item_id=?')) {
            const id = String(args[0]);
            return { id, item_id: String(args[1]), created_by: 31,
              filename: id === 'source-many' ? 'source-many.vtt' : 'source.vtt', lang: 'en', label: 'English' };
          }
          if (sql.includes('SELECT * FROM users') || sql.includes('SELECT u.* FROM jobs')) return activeRow;
          return undefined;
        },
        run: (...args: any[]) => {
          if (sql.includes('INSERT INTO subtitles')) insertedSubtitle = args;
          return { changes: 1 };
        },
      }),
    },
  },
});
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    rowToUser: (row: any) => ({ id: row.id, username: row.username, features: { movies: true } }),
  },
});
mock.module(new URL('../src/services/jellyfin.js', import.meta.url).href, {
  namedExports: { itemDetail: async () => ({ Type: 'Movie' }) },
});
mock.module(new URL('../src/services/whisper.js', import.meta.url).href, {
  namedExports: { transcribe: async () => '' },
});
mock.module(new URL('../src/services/ai.js', import.meta.url).href, {
  namedExports: {
    instruct: async (...args: any[]) => {
      aiCalls.push(args);
      return aiReply(args);
    },
  },
});
mock.module(new URL('../src/services/storage-write.js', import.meta.url).href, {
  namedExports: {
    reserveStorage: async () => ({ id: 'reservation' }),
    releaseStorage: () => undefined,
  },
});
mock.module(new URL('../src/services/policy.js', import.meta.url).href, {
  namedExports: { assertFileAllowed: () => undefined },
});
mock.module(new URL('../src/services/media-proxy.js', import.meta.url).href, {
  namedExports: { mediaBytes: async () => ({ status: 404, body: Buffer.alloc(0) }) },
});
mock.module(new URL('../src/services/content-access.js', import.meta.url).href, {
  namedExports: {
    assertContentFeature: () => undefined,
    assertJellyfinItemFeature: () => 'movies',
  },
});
mock.module(new URL('../src/services/translation-preferences.js', import.meta.url).href, {
  namedExports: {
    assertTranslationProviderAllowed: (_userId: number, provider: string) => {
      providerChecks.push(provider);
      if (!accountAiEnabled) throw Object.assign(new Error('ai_disabled'), { status: 403 });
      if (provider !== selectedProvider) throw Object.assign(new Error('translation_provider_changed'), { status: 409 });
      if (provider === 'external' && !externalAllowed) {
        throw Object.assign(new Error('external_translation_provider_unavailable'), { status: 409 });
      }
      return provider;
    },
    languageName: (language: string) => language === 'ja' ? 'Japanese' : `Language ${language}`,
  },
});

const subtitles = await import('../src/services/subtitles.js');

test('subtitle worker keeps the selected provider and dynamic target through prompting and persistence', async () => {
  aiCalls.length = 0;
  providerChecks.length = 0;
  insertedSubtitle = null;
  selectedProvider = 'external';
  externalAllowed = true;
  accountAiEnabled = true;
  aiReply = async args => {
    const batch = JSON.parse(args[1]);
    return JSON.stringify(batch.map((item: any) => ({ ...item, text: 'おはようございます' })));
  };
  const completion = waitForNotification();
  const jobId = subtitles.translateSubtitles(
    'movie-9', { type: 'custom', id: 'source-subtitle' }, 'ja', 31, 'external',
  );
  assert.match(jobId, /^job_/);
  const notification = await completion;
  assert.equal(notification.title, 'Subtitles ready');

  assert.ok(providerChecks.length >= 2, 'provider policy is checked before and during translation');
  assert.ok(providerChecks.every(provider => provider === 'external'));
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0][3].provider, 'external');
  assert.match(aiCalls[0][0], /Translate every subtitle into Japanese \(ja\)/);
  assert.doesNotMatch(aiCalls[0][0], /Translate every subtitle into English/i);
  assert.equal(insertedSubtitle?.[2], 'ja');
  assert.match(String(insertedSubtitle?.[3]), /^Japanese \(AI\)$/);

  const outputFilename = String(insertedSubtitle?.[5]);
  const output = await fs.readFile(path.join(temporary, outputFilename), 'utf8');
  assert.match(output, /おはようございます/);
});

async function expectStoppedAfterFirstBatch(revoke: () => void, expectedError: string) {
  aiCalls.length = 0;
  providerChecks.length = 0;
  insertedSubtitle = null;
  selectedProvider = 'external';
  externalAllowed = true;
  accountAiEnabled = true;
  aiReply = async args => {
    const batch = JSON.parse(args[1]);
    revoke();
    return JSON.stringify(batch.map((item: any) => ({ ...item, text: `Translated ${item.i}` })));
  };
  const completion = waitForNotification();
  subtitles.translateSubtitles(
    'movie-many', { type: 'custom', id: 'source-many' }, 'ja', 31, 'external',
  );
  const notification = await completion;
  assert.equal(notification.title, 'Subtitle job failed');
  assert.equal(notification.message, expectedError);
  assert.equal(aiCalls.length, 1, 'no second batch may reach the former external provider');
  assert.equal(insertedSubtitle, null, 'a partially translated subtitle must not be published');
  assert.ok(providerChecks.length >= 3, 'the provider is re-authorized at each batch boundary');
}

test('a saved provider change stops a multi-batch external subtitle job before its next request', async () => {
  await expectStoppedAfterFirstBatch(() => { selectedProvider = 'local'; }, 'translation_provider_changed');
});

test('admin external-AI revocation stops a multi-batch subtitle job before its next request', async () => {
  await expectStoppedAfterFirstBatch(() => { externalAllowed = false; }, 'external_translation_provider_unavailable');
});

test('account AI-feature revocation stops a multi-batch subtitle job before its next request', async () => {
  await expectStoppedAfterFirstBatch(() => { accountAiEnabled = false; }, 'ai_disabled');
});

test.after(async () => {
  mock.reset();
  await fs.rm(temporary, { recursive: true, force: true });
});
