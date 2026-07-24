import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

test('private photo album shares are recipient-bound, view-only, and immediately revocable', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-photo-album-shares-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.FILES_ROOT = path.join(root, 'files');
  process.env.ADMIN_PASSWORD = 'photo-album-share-admin-password';
  process.env.JWT_SECRET = 'photo-album-share-test-secret';

  const [{ db }, { authMiddleware }, { default: photosRouter }, storage] = await Promise.all([
    import('../src/lib/db.js'),
    import('../src/lib/auth.js'),
    import('../src/routes/photos.js'),
    import('../src/services/storage.js'),
  ]);

  const addUser = (username: string, displayName: string, features = '{}', disabledAt: string | null = null) => {
    const inserted = db.prepare(`INSERT INTO users
      (username,storage_id,display_name,password_hash,role,avatar_color,ai_mode,features,disabled_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(username, crypto.randomUUID(), displayName, 'unused-test-hash',
      'user', '#445566', 'local_only', features, disabledAt);
    return Number(inserted.lastInsertRowid);
  };
  const ownerId = addUser('album-owner', 'Album Owner');
  const recipientId = addUser('album-recipient', 'Album Recipient');
  const strangerId = addUser('album-stranger', 'Album Stranger');
  const noPhotosId = addUser('album-no-photos', 'No Photos', '{"photos":false}');
  const disabledId = addUser('album-disabled', 'Disabled', '{}', new Date().toISOString());
  const rows = new Map<number, any>([ownerId, recipientId, strangerId, noPhotosId, disabledId]
    .map(id => [id, db.prepare('SELECT * FROM users WHERE id=?').get(id)]));

  const token = (id: number) => {
    const row = rows.get(id);
    const sid = `photo-album-share-session-${id}`;
    db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,expires_at)
      VALUES (?,?,?,?,?)`).run(sid, id, 'Test browser', 'web', new Date(Date.now() + 3600_000).toISOString());
    return jwt.sign({ id, username: row.username, role: row.role, sid }, process.env.JWT_SECRET!,
      { audience: 'aerie-account', expiresIn: '1h' });
  };
  const tokens = new Map<number, string>([ownerId, recipientId, strangerId, noPhotosId]
    .map(id => [id, token(id)]));
  const auth = (id: number, json = true) => ({
    Authorization: `Bearer ${tokens.get(id)}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const ownerRoot = await storage.userRootAsync('album-owner');
  await fsp.mkdir(path.join(ownerRoot, 'Photos'), { recursive: true });
  // Valid one-pixel PNGs let the protected file endpoint serve real image data.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await fsp.writeFile(path.join(ownerRoot, 'Photos', 'shared.png'), png);
  await fsp.writeFile(path.join(ownerRoot, 'Photos', 'private.png'), png);
  db.prepare(`INSERT INTO photo_index
    (user_id,rel_path,taken_at,width,height,size,mtime,favorite) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ownerId, 'Photos/shared.png', '2026-01-02T00:00:00.000Z', 1, 1, png.length, 1, 1);
  db.prepare(`INSERT INTO photo_index
    (user_id,rel_path,taken_at,width,height,size,mtime,favorite) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ownerId, 'Photos/private.png', '2026-01-01T00:00:00.000Z', 1, 1, png.length, 1, 0);
  const albumId = `pa_${'A'.repeat(32)}`;
  db.prepare('INSERT INTO photo_albums(id,user_id,name,description,cover_path) VALUES (?,?,?,?,?)')
    .run(albumId, ownerId, 'Family trip', 'Private memories', 'Photos/shared.png');
  db.prepare('INSERT INTO photo_album_items(album_id,user_id,rel_path) VALUES (?,?,?)')
    .run(albumId, ownerId, 'Photos/shared.png');

  const app = express();
  app.use(express.json());
  app.use('/photos', authMiddleware, photosRouter);
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
  const origin = `http://127.0.0.1:${address.port}/photos/native/albums`;

  const create = await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId, permission: 'viewer' }),
  });
  const createBody = await create.text();
  assert.equal(create.status, 201, createBody);
  const share = JSON.parse(createBody) as any;
  assert.match(share.id, /^pas_[A-Za-z0-9_-]{32}$/);
  assert.equal(share.permission, 'viewer');
  assert.equal(share.recipient.displayName, 'Album Recipient');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND link=?").get(recipientId,
    `/photos?tab=albums&shared=${share.id}`),
    'recipient receives an in-app notification');

  const duplicate = await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId }),
  });
  assert.equal(duplicate.status, 409);
  const editGrant = await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId: strangerId, permission: 'editor' }),
  });
  assert.equal(editGrant.status, 400, 'photo album grants cannot be upgraded to write access');
  assert.equal((await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId: noPhotosId }),
  })).status, 409, 'accounts without Photos cannot receive a grant');
  assert.equal((await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId: disabledId }),
  })).status, 404, 'disabled accounts are not valid recipients');

  const owned = await fetch(`${origin}/${albumId}/shares`, { headers: auth(ownerId, false) });
  assert.equal(owned.status, 200);
  assert.equal(((await owned.json()) as any).items[0].recipient.id, recipientId);

  const received = await fetch(`${origin}/shared`, { headers: auth(recipientId, false) });
  assert.equal(received.status, 200);
  const receivedItems = ((await received.json()) as any).items;
  assert.equal(receivedItems.length, 1);
  assert.equal(receivedItems[0].owner.displayName, 'Album Owner');
  assert.equal(receivedItems[0].permission, 'viewer');
  assert.equal(((await (await fetch(`${origin}/shared`, { headers: auth(strangerId, false) })).json()) as any).items.length, 0);

  const itemsResponse = await fetch(`${origin}/shared/${share.id}/items`, { headers: auth(recipientId, false) });
  assert.equal(itemsResponse.status, 200);
  const sharedItems = ((await itemsResponse.json()) as any).items;
  assert.deepEqual(sharedItems.map((item: any) => item.path), ['Photos/shared.png']);
  assert.equal(sharedItems[0].favorite, false, 'owner-only favourite metadata is not disclosed');

  const file = await fetch(`${origin}/shared/${share.id}/file?path=${encodeURIComponent('Photos/shared.png')}`,
    { headers: auth(recipientId, false) });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.match(file.headers.get('cache-control') || '', /no-store/);
  const thumb = await fetch(`${origin}/shared/${share.id}/thumb?path=${encodeURIComponent('Photos/shared.png')}`,
    { headers: auth(recipientId, false) });
  assert.equal(thumb.status, 200, await thumb.text());
  assert.match(thumb.headers.get('content-type') || '', /^image\/webp/);
  assert.match(thumb.headers.get('cache-control') || '', /no-store/);
  assert.equal((await fetch(`${origin}/shared/${share.id}/file?path=${encodeURIComponent('Photos/private.png')}`,
    { headers: auth(recipientId, false) })).status, 404, 'other owner photos remain private');
  assert.equal((await fetch(`${origin}/shared/${share.id}/items`, { headers: auth(strangerId, false) })).status, 404,
    'a valid share id is not a bearer capability');

  assert.equal((await fetch(`${origin}/${albumId}/items`, {
    method: 'POST', headers: auth(recipientId), body: JSON.stringify({ paths: ['Photos/private.png'] }),
  })).status, 404, 'recipient cannot mutate the owner album');
  assert.equal((await fetch(`${origin}/${albumId}/shares/${share.id}`, {
    method: 'DELETE', headers: auth(recipientId, false),
  })).status, 404, 'recipient cannot revoke an owner grant through owner routes');

  const revoked = await fetch(`${origin}/${albumId}/shares/${share.id}`, {
    method: 'DELETE', headers: auth(ownerId, false),
  });
  assert.equal(revoked.status, 200, await revoked.text());
  assert.equal((await fetch(`${origin}/shared/${share.id}/items`, { headers: auth(recipientId, false) })).status, 404,
    'revocation is effective on the next request');
  assert.equal(((await (await fetch(`${origin}/shared`, { headers: auth(recipientId, false) })).json()) as any).items.length, 0);
  assert.ok((db.prepare('SELECT revoked_at FROM photo_album_shares WHERE id=?').get(share.id) as any).revoked_at,
    'revocation is retained for audit');

  const regrant = await fetch(`${origin}/${albumId}/shares`, {
    method: 'POST', headers: auth(ownerId), body: JSON.stringify({ recipientId }),
  });
  const regrantText = await regrant.text();
  assert.equal(regrant.status, 201, regrantText);
  const regrantBody = JSON.parse(regrantText) as any;
  assert.notEqual(regrantBody.id, share.id);

  const actions = (db.prepare('SELECT action FROM audit WHERE user_id IN (?,?)').all(ownerId, recipientId) as any[])
    .map(row => row.action);
  for (const action of ['photo_album_share_created', 'photo_album_share_viewed', 'photo_album_share_revoked']) {
    assert.ok(actions.includes(action), action);
  }
});
