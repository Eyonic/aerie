import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('Aerie Drive streams native mutations through WebDAV and the Sync journal', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-drive-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.FILES_ROOT = path.join(root, 'files');
  process.env.ADMIN_PASSWORD = 'drive-integration-password';
  process.env.JWT_SECRET = 'drive-integration-jwt-secret';
  process.env.PUBLIC_URL = '';

  const [{ db }, { webdavRouter }, fabric, { adminPolicy }] = await Promise.all([
    import('../src/lib/db.js'),
    import('../src/routes/drive.js'),
    import('../src/services/sync-fabric.js'),
    import('../src/services/policy.js'),
  ]);
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any;
  assert.ok(admin);
  const password = 'aerie_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO drive_credentials (id,user_id,name,secret_hash) VALUES (?,?,?,?)').run(
    'drv_integration', admin.id, 'Test mount', crypto.createHash('sha256').update(password).digest('hex'),
  );

  const app = express();
  app.use('/dav', webdavRouter);
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
  const authorization = `Basic ${Buffer.from(`${admin.username}:${password}`).toString('base64')}`;
  const request = (url: string, init: RequestInit = {}) => fetch(origin + url, {
    ...init, headers: { Authorization: authorization, ...(init.headers || {}) }, redirect: 'manual',
  });
  const davTemps = async (directory: string): Promise<string[]> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await davTemps(full));
      else if (entry.name.startsWith('.aerie-dav-')) found.push(full);
    }
    return found;
  };
  const assertIngressClean = async () => {
    const row = db.prepare('SELECT COUNT(*) count FROM storage_reservations').get() as any;
    assert.equal(Number(row.count), 0, 'WebDAV reservation must be released');
    assert.deepEqual(await davTemps(process.env.FILES_ROOT!), [], 'WebDAV temp file must be removed');
  };
  const eventually = async (condition: () => boolean | Promise<boolean>, message: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
  };

  assert.equal((await request('/dav/Sync', { method: 'MKCOL' })).status, 201);
  assert.equal((await request('/dav/Sync/DriveTest', { method: 'MKCOL' })).status, 201);

  const malformed = await request('/dav/Sync/DriveTest/malformed.txt', {
    method: 'PUT', headers: { 'X-Aerie-Upload-Length': 'not-a-byte-count' }, body: 'x',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_upload_length');
  await assertIngressClean();

  const oversized = await request('/dav/Sync/DriveTest/oversized.txt', {
    method: 'PUT', headers: { 'X-Aerie-Upload-Length': String(adminPolicy().maxUploadBytes + 1) }, body: '',
  });
  assert.equal(oversized.status, 413);
  await assertIngressClean();

  const truncated = await request('/dav/Sync/DriveTest/truncated.txt', {
    method: 'PUT', headers: { 'X-Aerie-Upload-Length': '5' }, body: 'abc',
  });
  assert.equal(truncated.status, 400);
  assert.equal((await truncated.json()).error, 'upload_length_mismatch');
  assert.equal((await request('/dav/Sync/DriveTest/truncated.txt')).status, 404);
  await assertIngressClean();

  // Hold a PUT open after its reservation and temp file both exist, then drop
  // the socket. The pipeline error path must remove both before another upload
  // can observe leaked quota or staging bytes.
  const abortBytes = 1024 * 1024;
  const aborted = http.request(origin + '/dav/Sync/DriveTest/aborted.txt', {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Length': String(abortBytes),
      'X-Aerie-Upload-Length': String(abortBytes),
    },
  });
  aborted.on('error', () => {});
  const abortedClosed = new Promise<void>(resolve => aborted.once('close', () => resolve()));
  aborted.write(Buffer.alloc(1024, 0x61));
  await eventually(async () => {
    const row = db.prepare('SELECT COUNT(*) count FROM storage_reservations').get() as any;
    return Number(row.count) === 1 && (await davTemps(process.env.FILES_ROOT!)).length === 1;
  }, 'aborted WebDAV PUT never reached its reserved temp-file stage');
  aborted.destroy();
  await abortedClosed;
  await eventually(async () => {
    const row = db.prepare('SELECT COUNT(*) count FROM storage_reservations').get() as any;
    return Number(row.count) === 0 && (await davTemps(process.env.FILES_ROOT!)).length === 0;
  }, 'aborted WebDAV PUT leaked its reservation or temp file');
  assert.equal((await request('/dav/Sync/DriveTest/aborted.txt')).status, 404);

  const put = await request('/dav/Sync/DriveTest/hello.txt', {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'hello drive',
  });
  assert.equal(put.status, 201);
  await assertIngressClean();

  // JSON and form files must stay opaque bytes. In the full server /dav is
  // intentionally mounted before Express's JSON/urlencoded body parsers.
  const jsonBytes = '{"aerie":true,"nested":{"value":2}}';
  assert.equal((await request('/dav/Sync/DriveTest/data.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: jsonBytes,
  })).status, 201);
  const savedJson = await request('/dav/Sync/DriveTest/data.json');
  assert.equal(savedJson.status, 200);
  assert.equal(await savedJson.text(), jsonBytes);

  const first = fabric.manifest(admin.id, 'Sync/DriveTest');
  assert.deepEqual(first.entries.map(entry => entry.rel), ['data.json', 'hello.txt']);
  const helloEntry = first.entries.find(entry => entry.rel === 'hello.txt');
  assert.ok(helloEntry);
  const stableId = helloEntry.stableId;

  const range = await request('/dav/Sync/DriveTest/hello.txt', { headers: { Range: 'bytes=1-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ell');

  const propfind = await request('/dav/Sync/DriveTest', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(propfind.status, 207);
  assert.match(await propfind.text(), /hello\.txt/);

  const moved = await request('/dav/Sync/DriveTest/hello.txt', {
    method: 'MOVE', headers: { Destination: `${origin}/dav/Sync/DriveTest/renamed.txt` },
  });
  assert.equal(moved.status, 201);
  const afterMove = fabric.manifest(admin.id, 'Sync/DriveTest');
  const renamedEntry = afterMove.entries.find(entry => entry.rel === 'renamed.txt');
  assert.ok(renamedEntry);
  assert.equal(renamedEntry.stableId, stableId);

  assert.equal((await request('/dav/Sync/DriveTest/empty.txt', { method: 'PUT', body: '' })).status, 201);
  const empty = await request('/dav/Sync/DriveTest/empty.txt');
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');

  assert.equal((await request('/dav/Sync/DriveTest/renamed.txt', { method: 'DELETE' })).status, 204);
  const journal = fabric.changesAfter(admin.id, 'Sync/DriveTest', 0, 20);
  assert.deepEqual(journal.items.filter(item => item.stableId === stableId).map(item => item.kind),
    ['upsert', 'rename', 'delete']);

  db.prepare(`UPDATE users SET features='{"files":false}' WHERE id=?`).run(admin.id);
  assert.equal((await request('/dav/Sync/DriveTest/data.json')).status, 403);
});
