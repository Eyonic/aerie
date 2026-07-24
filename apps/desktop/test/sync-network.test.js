const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { _networkForTests } = require('../sync');

const {
  readJsonResponse, transferDeadlineMs, createDownloadMonitor, createMultipartUpload,
} = _networkForTests;

test('sync JSON reader parses chunked responses within its byte cap', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"needed":'));
      controller.enqueue(new TextEncoder().encode('["a.txt"]}'));
      controller.close();
    },
  });
  const value = await readJsonResponse(new Response(body), { maxBytes: 64, idleMs: 1000 });
  assert.deepEqual(value, { needed: ['a.txt'] });
});

test('sync JSON reader rejects declared and streamed oversized responses', async () => {
  await assert.rejects(
    readJsonResponse(new Response('123456', { headers: { 'Content-Length': '6' } }), { maxBytes: 5 }),
    /response_too_large/,
  );
  await assert.rejects(
    readJsonResponse(new Response('123456'), { maxBytes: 5 }),
    /response_too_large/,
  );
});

test('sync JSON reader aborts a body that stops making progress', async () => {
  const body = new ReadableStream({ pull: () => new Promise(() => {}) });
  await assert.rejects(
    readJsonResponse(new Response(body), { maxBytes: 64, idleMs: 10 }),
    /response_idle_timeout/,
  );
});

test('download monitor enforces the expected response size', async () => {
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
      createDownloadMonitor(7, 1000),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ),
    /download_too_large/,
  );
});

test('large transfers receive a longer but finite deadline', () => {
  const small = transferDeadlineMs(1024);
  const large = transferDeadlineMs(20 * 1024 * 1024 * 1024);
  assert.ok(large > small);
  assert.ok(large <= 48 * 60 * 60 * 1000);
});

test('streaming multipart uploads can be replayed after token refresh', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aerie-sync-network-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hello.txt');
  await fs.writeFile(filename, 'hello');
  const stat = await fs.stat(filename);
  const upload = createMultipartUpload({
    full: filename, root: directory, rel: 'hello.txt', size: stat.size, mtimeMs: stat.mtimeMs,
  }, { base: 'Sync/Test', rel: 'folder/hello.txt' }, () => {});
  const collect = async () => {
    const chunks = [];
    for await (const chunk of Readable.fromWeb(upload.bodyFactory())) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const first = await collect();
  const retry = await collect();
  assert.deepEqual(retry, first);
  assert.match(first.toString('utf8'), /name="base"\r\n\r\nSync\/Test/);
  assert.match(first.toString('utf8'), /name="file"; filename="hello\.txt"/);
  assert.ok(first.includes(Buffer.from('hello')));
});
