import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { mock } from 'node:test';

const POLICY_MAX = 8;
const reserveCalls: number[] = [];
const releaseCalls: string[] = [];
let reservationCounter = 0;
let reservationGate: Promise<void> | undefined;
let reservationCompleted: (() => void) | undefined;

mock.module(new URL('../src/services/policy.js', import.meta.url).href, {
  namedExports: { adminPolicy: () => ({ maxUploadBytes: POLICY_MAX }) },
});
mock.module(new URL('../src/services/storage-write.js', import.meta.url).href, {
  namedExports: {
    reserveStorage: async (_user: any, bytes: number) => {
      reserveCalls.push(bytes);
      await reservationGate;
      reservationCompleted?.();
      return { id: `reservation-${++reservationCounter}`, bytes };
    },
    releaseStorage: (reservation: any) => {
      const id = typeof reservation === 'string' ? reservation : reservation?.id;
      if (id) releaseCalls.push(id);
    },
  },
});

const ingress = await import('../src/services/upload-ingress.js');

class ResponseStub extends EventEmitter {
  destroyed = false;
}

function request(headers: Record<string, string | string[] | undefined> = {}) {
  return {
    headers,
    aborted: false,
    user: { id: 1, username: 'alice', storageQuotaBytes: 100 },
  } as any;
}

async function reserve(req: any, res: ResponseStub): Promise<any> {
  let called = 0;
  let nextError: any;
  await ingress.reserveUploadIngress(req, res as any, (error?: any) => {
    called += 1;
    nextError = error;
  });
  assert.equal(called, 1, 'reservation middleware must settle exactly once');
  return nextError;
}

async function store(storage: ReturnType<typeof ingress.boundedDiskStorage>, req: any, stream: Readable) {
  return new Promise<{ error?: any; info?: any }>(resolve => {
    storage._handleFile(req, { stream }, (error?: any, info?: any) => resolve({ error, info }));
  });
}

async function remove(storage: ReturnType<typeof ingress.boundedDiskStorage>, req: any, file: any) {
  await new Promise<void>((resolve, reject) => storage._removeFile(req, file, error => error ? reject(error) : resolve()));
}

test.beforeEach(() => {
  reserveCalls.length = 0;
  releaseCalls.length = 0;
  reservationGate = undefined;
  reservationCompleted = undefined;
});

test('quota is reserved before a multipart stream reaches its temp file and success cleans up once', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-ingress-success-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const order: string[] = [];
  reservationCompleted = () => order.push('reserved');
  const req = request({ 'x-aerie-upload-length': '3' });
  const res = new ResponseStub();

  assert.equal(await reserve(req, res), undefined);
  const storage = ingress.boundedDiskStorage(directory);
  const stream = Readable.from((async function* () {
    order.push('consumed');
    yield Buffer.from('abc');
  })());
  const result = await store(storage, req, stream);
  assert.equal(result.error, undefined);
  assert.deepEqual(order, ['reserved', 'consumed']);
  assert.equal(await fsp.readFile(result.info.path, 'utf8'), 'abc');

  assert.equal(ingress.claimUploadIngress(req).bytes, 3);
  res.emit('finish');
  assert.deepEqual(releaseCalls, [], 'the response cannot release a reservation claimed by an active route');
  await remove(storage, req, result.info);
  ingress.releaseIngress(req);
  res.emit('close');
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('malformed and oversized byte declarations fail before quota reservation', async () => {
  for (const value of ['', ' ', '-1', '+1', '1.5', '1e1', '9007199254740992']) {
    const error = await reserve(request({ 'x-aerie-upload-length': value }), new ResponseStub());
    assert.equal(error?.message, 'invalid_upload_length', `unexpected result for ${JSON.stringify(value)}`);
    assert.equal(error?.status, 400);
  }
  let error = await reserve(request({ 'content-length': 'not-a-number' }), new ResponseStub());
  assert.equal(error?.message, 'invalid_content_length');
  assert.equal(error?.status, 400);

  error = await reserve(request({ 'x-aerie-upload-length': String(POLICY_MAX + 1) }), new ResponseStub());
  assert.equal(error?.message, 'file_too_large');
  assert.equal(error?.status, 413);

  error = await reserve(request({
    'content-length': String(POLICY_MAX + 12 * 1024 * 1024 + 1),
  }), new ResponseStub());
  assert.equal(error?.message, 'file_too_large');
  assert.equal(error?.status, 413);
  assert.deepEqual(reserveCalls, []);
});

test('one aggregate ceiling spans every multipart file and failed partial files are removed', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-ingress-aggregate-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const req = request({ 'x-aerie-upload-length': '5' });
  const res = new ResponseStub();
  assert.equal(await reserve(req, res), undefined);
  const storage = ingress.boundedDiskStorage(directory);

  const first = await store(storage, req, Readable.from([Buffer.from('abc')]));
  assert.equal(first.error, undefined);
  const second = await store(storage, req, Readable.from([Buffer.from('de'), Buffer.from('f')]));
  assert.equal(second.error?.message, 'file_too_large');
  assert.equal(second.error?.status, 413);
  assert.deepEqual(await fsp.readdir(directory), [path.basename(first.info.path)]);

  // This is the same cleanup callback Multer invokes for already-completed
  // files when a later file in the request fails.
  await remove(storage, req, first.info);
  res.emit('close');
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('an exact native declaration cannot silently commit a truncated multipart upload', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-ingress-short-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const req = request({ 'x-aerie-upload-length': '4' });
  const res = new ResponseStub();
  assert.equal(await reserve(req, res), undefined);
  const storage = ingress.boundedDiskStorage(directory);
  const result = await store(storage, req, Readable.from([Buffer.from('abc')]));
  assert.equal(result.error, undefined);
  assert.throws(() => ingress.claimUploadIngress(req), (error: any) => {
    assert.equal(error?.message, 'upload_length_mismatch');
    assert.equal(error?.status, 400);
    assert.equal(error?.expectedBytes, 4);
    assert.equal(error?.receivedBytes, 3);
    return true;
  });
  await remove(storage, req, result.info);
  ingress.releaseIngress(req);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('parser failure waits for pending writers and removes temp paths Multer never learned', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-ingress-parser-failure-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const req = request({ 'x-aerie-upload-length': '4' });
  const res = new ResponseStub();
  assert.equal(await reserve(req, res), undefined);
  const storage = ingress.boundedDiskStorage(directory);

  let continueStream!: () => void;
  let firstChunk!: () => void;
  const firstConsumed = new Promise<void>(resolve => { firstChunk = resolve; });
  const continueAfterParserFailure = new Promise<void>(resolve => { continueStream = resolve; });
  const stream = Readable.from((async function* () {
    yield Buffer.from('ab');
    firstChunk();
    await continueAfterParserFailure;
    yield Buffer.from('cd');
  })());
  const pendingWriter = store(storage, req, stream);
  await firstConsumed;
  await new Promise(resolve => setImmediate(resolve));

  const parserError = Object.assign(new Error('file_too_large'), { status: 413 });
  const parser = ingress.withUploadIngressCleanup(((_request: any, _response: any, next: any) => {
    next(parserError);
  }) as any);
  let downstreamCalled = false;
  const downstream = new Promise<any>(resolve => {
    parser(req, res as any, (error?: any) => {
      downstreamCalled = true;
      resolve(error);
    });
  });

  // The response boundary must stay closed while a storage callback can still
  // produce a path that Multer's earlier failure snapshot did not contain.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downstreamCalled, false);
  continueStream();

  const writerResult = await pendingWriter;
  assert.equal(writerResult.error, undefined);
  assert.equal(await downstream, parserError);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('disconnect during a temp write defers release until the partial file is removed', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-ingress-abort-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const req = request({ 'x-aerie-upload-length': '6' });
  const res = new ResponseStub();
  assert.equal(await reserve(req, res), undefined);
  const storage = ingress.boundedDiskStorage(directory);
  let continueStream!: () => void;
  let firstChunk!: () => void;
  const firstWritten = new Promise<void>(resolve => { firstChunk = resolve; });
  const continueAfterClose = new Promise<void>(resolve => { continueStream = resolve; });
  const stream = Readable.from((async function* () {
    yield Buffer.from('ab');
    firstChunk();
    await continueAfterClose;
    yield Buffer.from('cd');
  })());

  const pending = store(storage, req, stream);
  await firstWritten;
  // Let the storage engine finish its first asynchronous write before closing.
  await new Promise(resolve => setImmediate(resolve));
  res.emit('close');
  assert.deepEqual(releaseCalls, []);
  continueStream();
  const result = await pending;
  assert.equal(result.error?.message, 'upload_aborted');
  assert.equal(result.error?.status, 400);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('disconnect while reservation is pending releases the eventual hold and never starts parsing', async () => {
  let openGate!: () => void;
  reservationGate = new Promise<void>(resolve => { openGate = resolve; });
  const req = request({ 'x-aerie-upload-length': '2' });
  const res = new ResponseStub();
  let nextError: any;
  const pending = ingress.reserveUploadIngress(req, res as any, (error?: any) => { nextError = error; });
  assert.deepEqual(reserveCalls, [2]);
  res.emit('close');
  openGate();
  await pending;
  assert.equal(nextError?.message, 'upload_aborted');
  assert.equal(nextError?.status, 400);
  assert.equal(releaseCalls.length, 1);
});

test.after(() => mock.reset());
