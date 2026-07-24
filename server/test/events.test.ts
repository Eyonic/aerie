import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeAllStreams,
  connectionCount,
  subscribe,
} from '../src/services/events.js';

test('live notification streams are ended and released during shutdown', () => {
  let ended = 0;
  const response = {
    writableEnded: false,
    end() { this.writableEnded = true; ended += 1; },
  } as any;

  const unsubscribe = subscribe(7, response);
  assert.equal(connectionCount(), 1);
  assert.equal(closeAllStreams(), 1);
  assert.equal(ended, 1);
  assert.equal(connectionCount(), 0);

  // Cleanup callbacks can still arrive after the registry was drained.
  unsubscribe();
  assert.equal(closeAllStreams(), 0);
});
