import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let storedSettings: any = { translation: { provider: 'local', languages: ['nl', 'de-DE'] } };
let activeUser: any = { id: 7, ai_mode: 'external_allowed', disabled_at: null };
let externalAiEnabled = true;

const testConfig = {
  translateLang: 'nl',
  ollama: { url: 'http://ollama.test', model: 'local-model' },
  deepseek: { apiKey: 'test-key', model: 'external-model' },
};

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: testConfig },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    db: {
      prepare: (sql: string) => ({
        get: (_userId: number) => sql.includes('SELECT settings')
          ? { settings: JSON.stringify(storedSettings) }
          : activeUser,
      }),
    },
  },
});
mock.module(new URL('../src/services/policy.js', import.meta.url).href, {
  namedExports: {
    adminPolicy: () => ({ externalAiEnabled }),
  },
});

const preferences = await import('../src/services/translation-preferences.js');

function expectError(fn: () => unknown, message: string, status: number) {
  assert.throws(fn, (error: any) => error?.message === message && error?.status === status);
}

test('translation preference validation canonicalizes and deduplicates configured languages', () => {
  assert.deepEqual(preferences.validateTranslationPreferences({
    provider: 'external',
    languages: ['nl_nl', 'NL-nl', 'de', 'zh-hant'],
  }), {
    provider: 'external',
    languages: ['nl-NL', 'de', 'zh-Hant'],
  });

  expectError(() => preferences.validateTranslationPreferences(null), 'translation_preferences_invalid', 400);
  expectError(() => preferences.validateTranslationPreferences({ provider: 'automatic', languages: ['nl'] }),
    'translation_provider_invalid', 400);
  expectError(() => preferences.validateTranslationPreferences({ provider: 'local', languages: [] }),
    'translation_language_required', 400);
  expectError(() => preferences.validateTranslationPreferences({ provider: 'local', languages: ['not a tag'] }),
    'translation_language_invalid', 400);
  expectError(() => preferences.validateTranslationPreferences({
    provider: 'local', languages: Array.from({ length: 13 }, (_, i) => `qaa-${i}`),
  }), 'translation_language_limit', 400);
});

test('configured targets are canonical and fail closed outside the user language list', () => {
  storedSettings = { translation: { provider: 'local', languages: ['nl', 'de-DE'] } };
  assert.equal(preferences.configuredTranslationTarget(7, 'DE-de'), 'de-DE');
  expectError(() => preferences.configuredTranslationTarget(7, 'en'), 'translation_language_not_configured', 400);
  expectError(() => preferences.configuredTranslationTarget(7, '../../en'), 'translation_language_invalid', 400);
});

test('translation providers remain isolated behind server configuration and account policy', () => {
  activeUser = { id: 7, ai_mode: 'external_allowed', disabled_at: null };
  externalAiEnabled = true;
  testConfig.ollama.url = 'http://ollama.test';
  testConfig.deepseek.apiKey = 'test-key';
  storedSettings = { translation: { provider: 'local', languages: ['nl'] } };
  assert.equal(preferences.assertTranslationProviderAllowed(7, 'local'), 'local');
  storedSettings = { translation: { provider: 'external', languages: ['nl'] } };
  assert.equal(preferences.assertTranslationProviderAllowed(7, 'external'), 'external');

  storedSettings = { translation: { provider: 'local', languages: ['nl'] } };
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'),
    'translation_provider_changed', 409);

  testConfig.ollama.url = '';
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'local'),
    'local_translation_provider_unavailable', 409);
  testConfig.ollama.url = 'http://ollama.test';

  storedSettings = { translation: { provider: 'external', languages: ['nl'] } };
  externalAiEnabled = false;
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'),
    'external_translation_provider_unavailable', 409);
  externalAiEnabled = true;

  testConfig.deepseek.apiKey = '';
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'),
    'external_translation_provider_unavailable', 409);
  testConfig.deepseek.apiKey = 'test-key';

  activeUser.ai_mode = 'local_only';
  storedSettings = { translation: { provider: 'external', languages: ['nl'] } };
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'),
    'external_translation_provider_unavailable', 409);
  storedSettings = { translation: { provider: 'local', languages: ['nl'] } };
  assert.equal(preferences.assertTranslationProviderAllowed(7, 'local'), 'local');

  activeUser.ai_mode = 'disabled';
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'local'), 'ai_disabled', 403);
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'), 'ai_disabled', 403);

  activeUser = null;
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'local'), 'account_unavailable', 403);
});

test('disabling the account AI feature immediately revokes saved translation providers', () => {
  activeUser = {
    id: 7, ai_mode: 'external_allowed', features: JSON.stringify({ ai: false }), disabled_at: null,
  };
  externalAiEnabled = true;
  testConfig.deepseek.apiKey = 'test-key';
  storedSettings = { translation: { provider: 'external', languages: ['nl'] } };
  expectError(() => preferences.assertTranslationProviderAllowed(7, 'external'), 'ai_disabled', 403);
  assert.equal(preferences.translationCapabilities({
    aiMode: 'external_allowed', features: { ai: false },
  }).externalAllowed, false);
});

test('saved languages replace legacy defaults instead of forcing English back into the action list', () => {
  assert.deepEqual(preferences.translationPreferencesFromSettings({
    language: 'en',
    translation: { provider: 'local', languages: ['fr', 'ja'] },
  }), { provider: 'local', languages: ['fr', 'ja'] });
});

test('new preferences do not invent an English translation target', () => {
  testConfig.translateLang = '';
  assert.deepEqual(preferences.translationPreferencesFromSettings({}), {
    provider: 'local', languages: [],
  });
  assert.deepEqual(preferences.translationPreferencesFromSettings({ language: 'nl' }), {
    provider: 'local', languages: ['nl'],
  });
  testConfig.translateLang = 'nl';
});

test.after(() => mock.reset());
