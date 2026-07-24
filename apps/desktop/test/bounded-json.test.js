const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedJson } = require('../bounded-json');

test('bounded JSON accepts a small chunked response', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      controller.enqueue(new TextEncoder().encode('true}'));
      controller.close();
    },
  });
  assert.deepEqual(await readBoundedJson(new Response(body), { maxBytes: 32 }), { ok: true });
});

test('bounded JSON rejects declared and streamed oversized responses', async () => {
  await assert.rejects(
    readBoundedJson(new Response('123456', { headers: { 'Content-Length': '6' } }), { maxBytes: 5 }),
    /response_too_large/,
  );
  await assert.rejects(readBoundedJson(new Response('123456'), { maxBytes: 5 }), /response_too_large/);
});

test('bounded JSON rejects a stalled response', async () => {
  const body = new ReadableStream({ pull: () => new Promise(() => {}) });
  await assert.rejects(readBoundedJson(new Response(body), { maxBytes: 32, idleMs: 10 }), /response_idle_timeout/);
});
