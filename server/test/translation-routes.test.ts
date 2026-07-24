import assert from 'node:assert/strict';
import os from 'node:os';
import test, { mock } from 'node:test';

let storedSettings: any = { translation: { provider: 'local', languages: ['fr', 'ja'] } };
let account: any = { id: 23, ai_mode: 'external_allowed', disabled_at: null };
let externalAiEnabled = true;
const aiCalls: any[] = [];
const subtitleCalls: any[] = [];
const auditCalls: any[] = [];

const testConfig = {
  dataDir: os.tmpdir(),
  translateLang: 'nl',
  ollama: { url: 'http://ollama.test', model: 'local-model' },
  deepseek: { apiKey: 'test-key', model: 'external-model' },
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: testConfig },
});
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: { rowToUser: (row: any) => row },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    audit: (...args: any[]) => { auditCalls.push(args); },
    db: {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes('SELECT settings')) return { settings: JSON.stringify(storedSettings) };
          if (sql.includes('SELECT id,ai_mode,disabled_at')) return account;
          return account;
        },
        run: (...args: any[]) => {
          if (sql.includes('UPDATE users SET settings=')) storedSettings = JSON.parse(args[0]);
          return { changes: 1 };
        },
      }),
    },
  },
});
mock.module(new URL('../src/services/policy.js', import.meta.url).href, {
  namedExports: {
    adminPolicy: () => ({ externalAiEnabled }),
    aiDecision: (user: any) => {
      if (user?.aiMode === 'disabled') throw Object.assign(new Error('ai_disabled'), { status: 403 });
      return { provider: 'local', external: false, mode: user?.aiMode || 'local_only' };
    },
  },
});
mock.module(new URL('../src/services/ai.js', import.meta.url).href, {
  namedExports: {
    instruct: async (...args: any[]) => { aiCalls.push(args); return ' translated result '; },
    available: async () => true,
    models: async () => [],
    providerName: () => 'test provider',
    chatStream: async function* () { yield ''; },
    chatWithTools: async () => ({ content: '', toolCalls: [], rawMessage: {} }),
  },
});
mock.module(new URL('../src/services/whisper.js', import.meta.url).href, {
  namedExports: { transcribe: async () => '', available: async () => false },
});
mock.module(new URL('../src/services/aitools.js', import.meta.url).href, {
  namedExports: { execTool: async () => ({}), toolsForUser: () => [] },
});
mock.module(new URL('../src/services/subtitles.js', import.meta.url).href, {
  namedExports: {
    authorizeSubtitleItem: async () => 'movies',
    translateSubtitles: (...args: any[]) => { subtitleCalls.push(args); return 'job-translation'; },
  },
});

const [{ default: aiRouter }, { default: settingsRouter }, { default: subtitlesRouter }] = await Promise.all([
  import('../src/routes/ai.js'),
  import('../src/routes/settings.js'),
  import('../src/routes/subtitles.js'),
]);

function route(router: any, path: string, method: string) {
  const layer = router.stack.find((candidate: any) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
  return layer.route.stack.at(-1).handle;
}

async function invoke(handler: any, req: any) {
  let status = 200;
  let body: any;
  let caught: any;
  const res: any = {
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
  };
  await handler({ ip: '127.0.0.1', ...req }, res, (error: any) => { caught = error; });
  return { status, body, caught };
}

const requestUser = { id: 23, username: 'translator', aiMode: 'external_allowed' };

test('settings normalize multiple languages and reject an unavailable external provider without writing it', async () => {
  externalAiEnabled = true;
  account = { id: 23, ai_mode: 'external_allowed', disabled_at: null };
  storedSettings = { theme: 'dark', translation: { provider: 'local', languages: ['nl'] } };

  const saved = await invoke(route(settingsRouter, '/preferences', 'patch'), {
    user: requestUser,
    body: { translation: { provider: 'external', languages: ['fr_FR', 'FR-fr', 'ja'] } },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.preferences.translation, { provider: 'external', languages: ['fr-FR', 'ja'] });
  assert.deepEqual(storedSettings.translation, { provider: 'external', languages: ['fr-FR', 'ja'] });

  externalAiEnabled = false;
  const before = structuredClone(storedSettings);
  const blocked = await invoke(route(settingsRouter, '/preferences', 'patch'), {
    user: requestUser,
    body: { translation: { provider: 'external', languages: ['de'] } },
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body, { error: 'external_translation_provider_unavailable' });
  assert.deepEqual(storedSettings, before, 'a rejected provider choice must not mutate persisted preferences');
  externalAiEnabled = true;
});

test('unrelated preference patches preserve the saved translation provider and languages', async () => {
  storedSettings = {
    language: 'nl', likedSongs: ['old-song'],
    translation: { provider: 'external', languages: ['fr', 'ja'] },
  };
  const result = await invoke(route(settingsRouter, '/preferences', 'patch'), {
    user: requestUser,
    body: { likedSongs: ['new-song'] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(storedSettings.translation, { provider: 'external', languages: ['fr', 'ja'] });
  assert.deepEqual(storedSettings.likedSongs, ['new-song']);
});

test('document translation uses only the saved provider and requested configured language', async () => {
  aiCalls.length = 0;
  storedSettings = { translation: { provider: 'local', languages: ['fr', 'ja'] } };
  account = { id: 23, ai_mode: 'external_allowed', disabled_at: null };

  const local = await invoke(route(aiRouter, '/doc-action', 'post'), {
    user: requestUser,
    body: { action: 'translate', text: 'Hallo wereld', targetLanguage: 'ja', provider: 'external' },
  });
  assert.ifError(local.caught);
  assert.equal(local.body.targetLanguage, 'ja');
  assert.equal(local.body.provider, 'local');
  assert.equal(aiCalls[0][3].provider, 'local', 'a request body cannot override the saved provider');
  assert.match(aiCalls[0][0], /Japanese \(language tag: ja\)/i);
  assert.doesNotMatch(aiCalls[0][0], /translate the following text (?:to|into) English/i);

  storedSettings = { translation: { provider: 'external', languages: ['fr', 'ja'] } };
  const external = await invoke(route(aiRouter, '/doc-action', 'post'), {
    user: requestUser,
    body: { action: 'translate', text: 'Good morning', targetLanguage: 'fr', provider: 'local' },
  });
  assert.ifError(external.caught);
  assert.equal(external.body.targetLanguage, 'fr');
  assert.equal(external.body.provider, 'external');
  assert.equal(aiCalls[1][3].provider, 'external');
  assert.match(aiCalls[1][0], /French \(language tag: fr\)/i);
});

test('document and subtitle routes fail closed for languages outside the saved list', async () => {
  storedSettings = { translation: { provider: 'local', languages: ['fr', 'ja'] } };
  aiCalls.length = 0;
  subtitleCalls.length = 0;

  const document = await invoke(route(aiRouter, '/doc-action', 'post'), {
    user: requestUser,
    body: { action: 'translate', text: 'Do not send this', targetLanguage: 'en' },
  });
  assert.equal(document.caught?.message, 'translation_language_not_configured');
  assert.equal(document.caught?.status, 400);
  assert.equal(aiCalls.length, 0, 'invalid document targets must be rejected before invoking an AI provider');

  const subtitle = await invoke(route(subtitlesRouter, '/translate', 'post'), {
    user: requestUser,
    body: { itemId: 'movie-1', source: { type: 'custom', id: 'sub-1' }, lang: 'en' },
  });
  assert.equal(subtitle.caught?.message, 'translation_language_not_configured');
  assert.equal(subtitle.caught?.status, 400);
  assert.equal(subtitleCalls.length, 0, 'invalid subtitle targets must not enqueue work');
});

test('subtitle translation passes the dynamic language and saved provider into the durable job', async () => {
  subtitleCalls.length = 0;
  storedSettings = { translation: { provider: 'external', languages: ['de', 'ja'] } };
  externalAiEnabled = true;

  const result = await invoke(route(subtitlesRouter, '/translate', 'post'), {
    user: requestUser,
    body: {
      itemId: 'movie-2',
      source: { type: 'custom', id: 'sub-2' },
      lang: 'ja',
      provider: 'local',
    },
  });
  assert.ifError(result.caught);
  assert.deepEqual(result.body, { jobId: 'job-translation', targetLanguage: 'ja', provider: 'external' });
  assert.deepEqual(subtitleCalls[0], [
    'movie-2', { type: 'custom', id: 'sub-2' }, 'ja', 23, 'external',
  ]);
  assert.ok(auditCalls.some(call => call[2] === 'subtitle_translation_queued'
    && call[5]?.targetLanguage === 'ja' && call[5]?.provider === 'external'));
});

test.after(() => mock.reset());
