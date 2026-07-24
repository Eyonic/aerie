import { describe, expect, it } from 'vitest';
import {
  aiPromptHistoryKey,
  loadAiPromptHistory,
  loadRequestDismissed,
  loadRequestMeta,
  requestDismissedStorageKey,
  requestMetaStorageKey,
  saveAiPromptHistory,
  saveRequestDismissed,
  saveRequestMeta,
  switchScopedSnapshot,
} from '../src/lib/request-local-state';

function memoryStorage(): Storage & { entries: Map<string, string>; reads: string[]; removals: string[] } {
  const entries = new Map<string, string>();
  const reads: string[] = [];
  const removals: string[] = [];
  return {
    entries,
    reads,
    removals,
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: key => { reads.push(key); return entries.get(key) ?? null; },
    key: index => Array.from(entries.keys())[index] ?? null,
    removeItem: key => { removals.push(key); entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
}

describe('private request and image-studio browser state', () => {
  it('discards unscoped legacy values without reading or migrating them', () => {
    const storage = memoryStorage();
    storage.entries.set('cb_ai_prompt_history', JSON.stringify(['private prompt']));
    storage.entries.set('cb_req_meta', JSON.stringify({ 'movie:1': { title: 'Private movie' } }));
    storage.entries.set('cb_req_dismissed', JSON.stringify([41]));

    expect(loadAiPromptHistory(7, storage, 'https://aerie.test')).toEqual([]);
    expect(loadRequestMeta(7, storage, 'https://aerie.test')).toEqual({});
    expect(loadRequestDismissed(7, storage, 'https://aerie.test')).toEqual([]);

    expect(storage.reads).not.toContain('cb_ai_prompt_history');
    expect(storage.reads).not.toContain('cb_req_meta');
    expect(storage.reads).not.toContain('cb_req_dismissed');
    expect(storage.removals).toEqual(expect.arrayContaining([
      'cb_ai_prompt_history', 'cb_req_meta', 'cb_req_dismissed',
    ]));
    expect(storage.entries.has('cb_ai_prompt_history')).toBe(false);
    expect(storage.entries.has('cb_req_meta')).toBe(false);
    expect(storage.entries.has('cb_req_dismissed')).toBe(false);
  });

  it('isolates prompts, request metadata and dismissed IDs by account and server', () => {
    const storage = memoryStorage();
    const origin = 'https://aerie.test/path';
    saveAiPromptHistory(7, ['account seven'], storage, origin);
    saveRequestMeta(7, {
      'movie:10': { title: 'Seven Movie', mediaType: 'movie', year: '2026' },
    }, storage, origin);
    saveRequestDismissed(7, [101], storage, origin);

    saveAiPromptHistory(8, ['account eight'], storage, origin);
    saveRequestMeta(8, {
      'tv:20': { title: 'Eight TV', mediaType: 'tv' },
    }, storage, origin);
    saveRequestDismissed(8, [202], storage, origin);

    expect(loadAiPromptHistory(7, storage, 'https://aerie.test')).toEqual(['account seven']);
    expect(loadRequestMeta(7, storage, 'https://aerie.test')).toEqual({
      'movie:10': { title: 'Seven Movie', mediaType: 'movie', year: '2026' },
    });
    expect(loadRequestDismissed(7, storage, 'https://aerie.test')).toEqual([101]);
    expect(loadAiPromptHistory(8, storage, 'https://aerie.test')).toEqual(['account eight']);
    expect(loadRequestDismissed(8, storage, 'https://aerie.test')).toEqual([202]);
    expect(loadAiPromptHistory(7, storage, 'https://other.test')).toEqual([]);

    expect(aiPromptHistoryKey(7, 'https://aerie.test')).not.toBe(aiPromptHistoryKey(8, 'https://aerie.test'));
    expect(requestMetaStorageKey(7, 'https://aerie.test')).not.toBe(requestMetaStorageKey(7, 'https://other.test'));
    expect(requestDismissedStorageKey(7, 'https://aerie.test')).not.toBe(requestDismissedStorageKey(8, 'https://aerie.test'));
  });

  it('switches the visible snapshot before the old account can render', () => {
    const previous = { scopeKey: 'u7', value: ['seven-private'] };
    const switched = switchScopedSnapshot(previous, 'u8', () => ['eight-private']);
    expect(switched).toEqual({ scopeKey: 'u8', value: ['eight-private'] });
    expect(switched.value).not.toContain('seven-private');

    const loggedOut = switchScopedSnapshot(switched, null, () => [] as string[]);
    expect(loggedOut).toEqual({ scopeKey: null, value: [] });
    expect(switchScopedSnapshot(loggedOut, null, () => ['must not load'])).toBe(loggedOut);
  });

  it('rejects malformed scoped data instead of exposing arbitrary persisted values', () => {
    const storage = memoryStorage();
    storage.entries.set(aiPromptHistoryKey(7, 'https://aerie.test'), JSON.stringify([
      'valid', 'valid', '', 42, 'x'.repeat(4001),
    ]));
    storage.entries.set(requestMetaStorageKey(7, 'https://aerie.test'), JSON.stringify({
      'movie:1': { title: 'Valid', mediaType: 'movie' },
      'movie:2': { title: '', mediaType: 'movie' },
      'music:3': { title: 'Wrong type', mediaType: 'music' },
    }));
    storage.entries.set(requestDismissedStorageKey(7, 'https://aerie.test'), JSON.stringify([4, 4, -1, '5']));

    expect(loadAiPromptHistory(7, storage, 'https://aerie.test')).toEqual(['valid']);
    expect(loadRequestMeta(7, storage, 'https://aerie.test')).toEqual({
      'movie:1': { title: 'Valid', mediaType: 'movie' },
    });
    expect(loadRequestDismissed(7, storage, 'https://aerie.test')).toEqual([4]);
  });
});
