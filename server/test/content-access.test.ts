import assert from 'node:assert/strict';
import test from 'node:test';

import { assertJellyfinItemFeature, jellyfinFeatureForType } from '../src/services/content-access.js';

test('Jellyfin item types map to the member feature that owns their content', () => {
  assert.equal(jellyfinFeatureForType('Movie'), 'movies');
  assert.equal(jellyfinFeatureForType('Episode'), 'tv');
  assert.equal(jellyfinFeatureForType('Series'), 'tv');
  assert.equal(jellyfinFeatureForType('Audio'), 'music');
  assert.equal(jellyfinFeatureForType('Video'), 'videos');
});

test('actual item type is denied when its owning feature is disabled', () => {
  const member = { features: { movies: false, tv: true } } as any;
  assert.throws(
    () => assertJellyfinItemFeature(member, { type: 'Movie' }),
    (error: any) => error?.message === 'feature_disabled' && error?.feature === 'movies' && error?.status === 403,
  );
  assert.equal(assertJellyfinItemFeature(member, { type: 'Episode' }), 'tv');
});
