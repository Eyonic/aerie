import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedLock } from '../src/lib/keyed-lock.js';

test('serializes one key while allowing unrelated keys to make progress', async () => {
  const lock = new KeyedLock();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const hold = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = lock.run('same', async () => { events.push('first-start'); await hold; events.push('first-end'); });
  const second = lock.run('same', async () => { events.push('second'); });
  const other = lock.run('other', async () => { events.push('other'); });
  await other;
  assert.deepEqual(events, ['first-start', 'other']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'other', 'first-end', 'second']);
  assert.equal(lock.activeKeys, 0);
});
test('releases a key after an operation fails', async () => {
  const lock = new KeyedLock();
  await assert.rejects(lock.run('upload', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await lock.run('upload', async () => 'recovered'), 'recovered');
  assert.equal(lock.activeKeys, 0);
});
