import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  OutboundHttpError,
  outboundBytes,
  outboundJson,
  outboundText,
  outboundVoid,
  validateOutboundUrl,
} from '../src/services/outbound-http.js';

const timers = new Set<NodeJS.Timeout>();
function later(operation: () => void, milliseconds: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    operation();
  }, milliseconds);
  timers.add(timer);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  switch (url.pathname) {
    case '/json':
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
      break;
    case '/invalid-json':
      response.end('{not json');
      break;
    case '/text':
      response.end('hello from LAN');
      break;
    case '/binary':
      response.end(Buffer.from([0, 1, 2, 255]));
      break;
    case '/empty':
      response.statusCode = 204;
      response.end();
      break;
    case '/status':
      response.statusCode = 409;
      response.statusMessage = 'Conflict';
      response.end('already exists: sensitive upstream detail');
      break;
    case '/redirect':
      response.statusCode = 302;
      response.setHeader('Location', '/json');
      response.end();
      break;
    case '/large-declared':
      response.setHeader('Content-Length', '1024');
      response.end(Buffer.alloc(1024, 1));
      break;
    case '/large-stream':
      response.write(Buffer.alloc(80, 2));
      response.write(Buffer.alloc(80, 3));
      response.end(Buffer.alloc(80, 4));
      break;
    case '/slow-body':
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('headers have arrived');
      later(() => response.end(' but body was slow'), 100);
      break;
    case '/slow-headers':
      later(() => response.end('late response'), 100);
      break;
    default:
      response.statusCode = 404;
      response.end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address() as AddressInfo;
const origin = `http://127.0.0.1:${address.port}`;

function isCode(code: string, upstreamStatus?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof OutboundHttpError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (upstreamStatus !== undefined) assert.equal(error.upstreamStatus, upstreamStatus);
    return true;
  };
}

test('URL validation permits private HTTP(S) hosts but rejects ambiguity and credentials', () => {
  for (const value of [
    'http://127.0.0.1:8096/System/Info',
    'http://10.0.0.8:8989/api/v3',
    'http://localhost:8686/',
    'https://[::1]:5055/',
    'https://jellyfin.internal.local/',
  ]) {
    assert.equal(validateOutboundUrl(value).protocol.startsWith('http'), true, value);
  }
  assert.equal(validateOutboundUrl('http://localhost/path#not-sent').hash, '');

  const invalid: Array<[string, string]> = [
    ['/relative', 'invalid_url'],
    ['http:localhost/path', 'invalid_url'],
    [' ftp://localhost/file ', 'invalid_url'],
    ['ftp://localhost/file', 'unsupported_protocol'],
    ['file:///etc/passwd', 'unsupported_protocol'],
    ['http://user:password@localhost/', 'embedded_credentials'],
    ['http://@localhost/', 'embedded_credentials'],
    ['http://localhost\\outside/', 'invalid_url'],
    ['http://localhost/line\nbreak', 'invalid_url'],
  ];
  for (const [value, code] of invalid) assert.throws(() => validateOutboundUrl(value), isCode(code), value);
});

test('JSON, text, bytes, and no-content helpers return bounded typed bodies', async () => {
  const json = await outboundJson<{ ok: boolean; items: number[] }>(`${origin}/json`);
  assert.deepEqual(json.body, { ok: true, items: [1, 2, 3] });
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type') || '', /application\/json/);

  assert.equal((await outboundText(`${origin}/text`)).body, 'hello from LAN');
  assert.deepEqual((await outboundBytes(`${origin}/binary`)).body, Buffer.from([0, 1, 2, 255]));
  const empty = await outboundVoid(`${origin}/empty`, { method: 'POST' });
  assert.equal(empty.status, 204);
  assert.equal(empty.body, undefined);
});

test('status errors stay short while requireOk:false preserves idempotency handling', async () => {
  const secretUrl = `${origin}/status?api_key=must-not-appear`;
  await assert.rejects(() => outboundText(secretUrl), error => {
    assert.ok(isCode('upstream_status', 409)(error));
    assert.equal(String((error as Error).stack).includes('api_key'), false);
    assert.equal(String((error as Error).stack).includes('sensitive upstream detail'), false);
    return true;
  });

  const response = await outboundText(secretUrl, { requireOk: false, maxBytes: 1024 });
  assert.equal(response.status, 409);
  assert.equal(response.body, 'already exists: sensitive upstream detail');
  assert.equal(response.url.includes('api_key'), false);
  const discarded = await outboundVoid(secretUrl, { method: 'POST', requireOk: false });
  assert.equal(discarded.status, 409);
  assert.equal(discarded.body, undefined);
});

test('declared and streamed bodies cannot exceed the caller cap', async () => {
  await assert.rejects(() => outboundBytes(`${origin}/large-declared`, { maxBytes: 64 }),
    isCode('response_too_large'));
  await assert.rejects(() => outboundBytes(`${origin}/large-stream`, { maxBytes: 100 }),
    isCode('response_too_large'));
  await assert.rejects(() => outboundBytes(`${origin}/binary`, { maxBytes: 256 * 1024 * 1024 + 1 }),
    isCode('invalid_options'));
});

test('redirects are rejected and malformed JSON has a typed error', async () => {
  await assert.rejects(() => outboundJson(`${origin}/redirect`), isCode('redirect_rejected'));
  await assert.rejects(() => outboundJson(`${origin}/invalid-json`), isCode('invalid_json'));
});

test('the timeout remains active while reading the body', async () => {
  await assert.rejects(() => outboundText(`${origin}/slow-body`, { timeoutMs: 25 }), isCode('timeout'));
});

test('a caller AbortSignal composes with, and is distinct from, the timeout', async () => {
  const controller = new AbortController();
  const pending = outboundText(`${origin}/slow-headers`, { timeoutMs: 1_000, signal: controller.signal });
  later(() => controller.abort(new Error('private caller reason')), 15);
  await assert.rejects(() => pending, error => {
    assert.ok(isCode('aborted')(error));
    assert.equal(String((error as Error).stack).includes('private caller reason'), false);
    return true;
  });
});

test.after(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
