import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import crypto from 'node:crypto';

test('Files, Photos, and Sync uploads reserve before parsing and leave no holds or temp files', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-upload-routes-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.FILES_ROOT = path.join(root, 'files');
  process.env.ADMIN_PASSWORD = 'upload-integration-password';
  process.env.JWT_SECRET = 'upload-integration-jwt-secret';
  process.env.PUBLIC_URL = '';

  const [{ db }, { rowToUser }, { default: filesRouter }, { default: photosRouter }, { default: syncRouter }, storage] =
    await Promise.all([
      import('../src/lib/db.js'),
      import('../src/lib/auth.js'),
      import('../src/routes/files.js'),
      import('../src/routes/photos.js'),
      import('../src/routes/sync.js'),
      import('../src/services/storage.js'),
    ]);
  const adminRow = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any;
  const admin = rowToUser(adminRow);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req: any, _res, next) => { req.user = admin; next(); });
  app.use('/files', filesRouter);
  app.use('/photos', photosRouter);
  app.use('/sync', syncRouter);
  app.use((error: any, _req: any, res: any, _next: any) =>
    res.status(error?.status || 500).json({ error: error?.message || 'server_error' }));
  const server = http.createServer(app);
  t.after(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error: any) {
    if (error?.code === 'EPERM') { t.skip('environment blocks loopback listeners'); return; }
    throw error;
  }

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const reservations = () => Number((db.prepare('SELECT COUNT(*) count FROM storage_reservations').get() as any).count);
  const tempEntries = async (name: string) => fsp.readdir(path.join(process.env.FILES_ROOT!, name)).catch(() => [] as string[]);
  const assertClean = async () => {
    assert.equal(reservations(), 0, 'all quota reservations must be released');
    assert.deepEqual(await tempEntries('.uploads-tmp'), []);
    assert.deepEqual(await tempEntries('.photo-uploads-tmp'), []);
    assert.deepEqual(await tempEntries('.sync-uploads-tmp'), []);
  };

  // Every multipart integration must run the reservation middleware before
  // Multer. A malformed declaration therefore fails without consuming a body.
  for (const endpoint of ['/files/upload', '/photos/native/upload', '/sync/upload']) {
    const response = await fetch(origin + endpoint, {
      method: 'POST', headers: { 'X-Aerie-Upload-Length': 'not-a-byte-count' },
    });
    assert.equal(response.status, 400, endpoint);
    assert.equal((await response.json()).error, 'invalid_upload_length');
    await assertClean();
  }

  const successful = new FormData();
  successful.append('path', '/');
  successful.append('files', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'hello.txt');
  const saved = await fetch(origin + '/files/upload', {
    method: 'POST', headers: { 'X-Aerie-Upload-Length': '5' }, body: successful,
  });
  assert.equal(saved.status, 200, await saved.text());
  const userRoot = await storage.userRootAsync(admin.username);
  assert.equal(await fsp.readFile(path.join(userRoot, 'hello.txt'), 'utf8'), 'hello');
  await assertClean();

  // The request-wide ceiling is aggregate, not a fresh allowance per file.
  const aggregate = new FormData();
  aggregate.append('path', '/');
  aggregate.append('files', new Blob([Buffer.from('abc')]), 'one.txt');
  aggregate.append('files', new Blob([Buffer.from('def')]), 'two.txt');
  const aggregateResponse = await fetch(origin + '/files/upload', {
    method: 'POST', headers: { 'X-Aerie-Upload-Length': '5' }, body: aggregate,
  });
  assert.equal(aggregateResponse.status, 413, await aggregateResponse.text());
  assert.equal(await fsp.access(path.join(userRoot, 'one.txt')).then(() => true, () => false), false);
  assert.equal(await fsp.access(path.join(userRoot, 'two.txt')).then(() => true, () => false), false);
  await assertClean();

  // An invalid photo exercises route-level failure after Multer has created a
  // temp file. Cleanup must complete before the error response is observable.
  const badPhoto = new FormData();
  badPhoto.append('files', new Blob([Buffer.from('bad')], { type: 'image/jpeg' }), 'bad.jpg');
  const photoResponse = await fetch(origin + '/photos/native/upload', {
    method: 'POST', headers: { 'X-Aerie-Upload-Length': '3' }, body: badPhoto,
  });
  assert.equal(photoResponse.status, 415);
  assert.equal((await photoResponse.json()).error, 'invalid_image');
  await assertClean();

  // Sync validates its metadata after the file is fully staged. Missing base
  // data proves that validation errors also remove the staged file and hold.
  const badSync = new FormData();
  badSync.append('file', new Blob([Buffer.from('sync')]), 'sync.txt');
  const syncResponse = await fetch(origin + '/sync/upload', {
    method: 'POST', headers: { 'X-Aerie-Upload-Length': '4' }, body: badSync,
  });
  assert.equal(syncResponse.status, 400, await syncResponse.text());
  await assertClean();

  // Exact native declarations are not merely upper bounds: truncated uploads
  // are rejected before commit and their temp file is removed.
  const short = new FormData();
  short.append('path', '/');
  short.append('files', new Blob([Buffer.from('abc')]), 'short.txt');
  const shortResponse = await fetch(origin + '/files/upload', {
    method: 'POST', headers: { 'X-Aerie-Upload-Length': '4' }, body: short,
  });
  assert.equal(shortResponse.status, 400, await shortResponse.text());
  assert.equal(await fsp.access(path.join(userRoot, 'short.txt')).then(() => true, () => false), false);
  await assertClean();

  const sha256 = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
  const startSyncUpload = async (input: Record<string, unknown>, bytes: Buffer) => {
    const init = await fetch(origin + '/sync/upload-resumable/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const session = await init.json() as any;
    assert.equal(init.status, 200, JSON.stringify(session));
    assert.match(session.uploadId, /^[a-f0-9-]{36}$/);
    const chunkHeaders = {
      'Content-Type': 'application/octet-stream',
      'X-Upload-Offset': '0',
      'X-Chunk-SHA256': sha256(bytes),
    };
    const patch = await fetch(`${origin}/sync/upload-resumable/${session.uploadId}`, {
      method: 'PATCH', headers: chunkHeaders, body: bytes,
    });
    const patchBody = await patch.json() as any;
    assert.equal(patch.status, 200, JSON.stringify(patchBody));
    assert.equal(patchBody.offset, bytes.length);

    // A lost PATCH response is safe: retrying the same offset never appends the
    // chunk twice and tells the client exactly where to continue.
    const duplicate = await fetch(`${origin}/sync/upload-resumable/${session.uploadId}`, {
      method: 'PATCH', headers: chunkHeaders, body: bytes,
    });
    const duplicateBody = await duplicate.json() as any;
    assert.equal(duplicate.status, 409, JSON.stringify(duplicateBody));
    assert.equal(duplicateBody.offset, bytes.length);
    return session.uploadId as string;
  };

  const firstBytes = Buffer.from('durable sync upload');
  const firstInput = {
    base: 'Sync/Test phone', rel: 'docs/report.txt', size: firstBytes.length,
    mtimeMs: 1_700_000_000_000, contentHash: sha256(firstBytes), expectedHash: 'missing', deviceId: 'android-test',
  };
  const firstId = await startSyncUpload(firstInput, firstBytes);
  const firstComplete = await fetch(`${origin}/sync/upload-resumable/${firstId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const firstResult = await firstComplete.json() as any;
  assert.equal(firstComplete.status, 200, JSON.stringify(firstResult));
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.conflict, undefined);
  const journalAfterFirst = Number((db.prepare('SELECT COUNT(*) count FROM sync_changes').get() as any).count);

  // Complete is idempotent too. A client that lost the commit response gets the
  // stored result without another version, journal row, or filesystem write.
  const firstRetry = await fetch(`${origin}/sync/upload-resumable/${firstId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const firstRetryBody = await firstRetry.json();
  assert.equal(firstRetry.status, 200, JSON.stringify(firstRetryBody));
  assert.deepEqual(firstRetryBody, firstResult);
  assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM sync_changes').get() as any).count), journalAfterFirst);
  assert.equal(await fsp.readFile(path.join(userRoot, 'Sync/Test phone/docs/report.txt'), 'utf8'), firstBytes.toString());

  const conflictBytes = Buffer.from('offline edit from Android');
  const conflictInput = {
    base: 'Sync/Test phone', rel: 'docs/report.txt', size: conflictBytes.length,
    mtimeMs: 1_700_000_100_000, contentHash: sha256(conflictBytes), expectedHash: '0'.repeat(64),
    stableId: firstResult.entry.stableId, deviceId: 'android-test',
  };
  const conflictId = await startSyncUpload(conflictInput, conflictBytes);
  const conflictComplete = await fetch(`${origin}/sync/upload-resumable/${conflictId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const conflictResult = await conflictComplete.json() as any;
  assert.equal(conflictComplete.status, 200, JSON.stringify(conflictResult));
  assert.equal(conflictResult.ok, true);
  assert.equal(conflictResult.conflict, true);
  assert.match(conflictResult.conflictRel, /^docs\/report \(Aerie conflict android-test-[a-f0-9]{8}\)\.txt$/);
  assert.equal(await fsp.readFile(path.join(userRoot, 'Sync/Test phone', conflictResult.conflictRel), 'utf8'),
    conflictBytes.toString());
  assert.equal(await fsp.readFile(path.join(userRoot, 'Sync/Test phone/docs/report.txt'), 'utf8'), firstBytes.toString());
  const journalAfterConflict = Number((db.prepare('SELECT COUNT(*) count FROM sync_changes').get() as any).count);
  const conflictRetry = await fetch(`${origin}/sync/upload-resumable/${conflictId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const conflictRetryBody = await conflictRetry.json();
  assert.equal(conflictRetry.status, 200, JSON.stringify(conflictRetryBody));
  assert.deepEqual(conflictRetryBody, conflictResult);
  assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM sync_changes').get() as any).count), journalAfterConflict);
  assert.equal(reservations(), 0, 'completed resumable sync sessions release quota holds');
});
