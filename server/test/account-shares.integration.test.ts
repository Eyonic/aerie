import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

test('Household Shared Spaces enforce inherited roles, owner storage, versions, and revocation', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-account-shares-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.FILES_ROOT = path.join(root, 'files');
  process.env.ADMIN_PASSWORD = 'household-shares-admin-password';
  process.env.JWT_SECRET = 'household-shares-test-secret';
  process.env.PUBLIC_SHARING_ENABLED = 'true';

  const [{ db }, { rowToUser }, { default: sharesRouter }, storage, writes] = await Promise.all([
    import('../src/lib/db.js'),
    import('../src/lib/auth.js'),
    import('../src/routes/shares.js'),
    import('../src/services/storage.js'),
    import('../src/services/storage-write.js'),
  ]);

  const addUser = (username: string, displayName: string) => {
    const inserted = db.prepare(`INSERT INTO users
      (username,storage_id,display_name,password_hash,role,avatar_color,ai_mode,features)
      VALUES (?,?,?,?,?,?,?,?)`).run(username, crypto.randomUUID(), displayName, 'unused-test-hash',
      'user', '#445566', 'local_only', '{}');
    return Number(inserted.lastInsertRowid);
  };
  const ownerId = addUser('share-owner', 'Owner');
  const viewerId = addUser('share-viewer', 'Viewer');
  const editorId = addUser('share-editor', 'Editor');
  const strangerId = addUser('share-stranger', 'Stranger');
  const rows = new Map<number, any>([ownerId, viewerId, editorId, strangerId]
    .map(id => [id, db.prepare('SELECT * FROM users WHERE id=?').get(id)]));

  const token = (id: number) => {
    const row = rows.get(id);
    const sid = `account-share-session-${id}`;
    db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,expires_at)
      VALUES (?,?,?,?,?)`).run(sid, id, 'Test browser', 'web', new Date(Date.now() + 3600_000).toISOString());
    return jwt.sign({ id, username: row.username, role: row.role, sid }, process.env.JWT_SECRET!,
      { audience: 'aerie-account', expiresIn: '1h' });
  };
  const tokens = new Map<number, string>([ownerId, viewerId, editorId, strangerId].map(id => [id, token(id)]));
  const auth = (id: number, json = true) => ({
    Authorization: `Bearer ${tokens.get(id)}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const owner = rowToUser(rows.get(ownerId));
  const ownerRoot = await storage.userRootAsync(owner.username);
  await fsp.mkdir(path.join(ownerRoot, 'Household', 'Projects'), { recursive: true });
  await fsp.writeFile(path.join(ownerRoot, 'Household', 'note.txt'), 'before');
  await fsp.writeFile(path.join(ownerRoot, 'secret.txt'), 'not shared');

  const publicId = `sh_${'P'.repeat(32)}`;
  db.prepare(`INSERT INTO shares (id,user_id,path,name,type,permission)
    VALUES (?,?,?,?,?,?)`).run(publicId, ownerId, '/Household/note.txt', 'note.txt', 'link', 'view');

  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/shares', sharesRouter);
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
  const origin = `http://127.0.0.1:${address.port}/shares`;

  const createGrant = async (recipientId: number, permission: 'viewer' | 'editor') => {
    const response = await fetch(`${origin}/account`, {
      method: 'POST', headers: auth(ownerId),
      body: JSON.stringify({ path: '/Household', recipientId, permission }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body) as any;
  };

  const viewerGrant = await createGrant(viewerId, 'viewer');
  assert.match(viewerGrant.id, /^as_[A-Za-z0-9_-]{32}$/);
  assert.equal((await fetch(`${origin}/public/${publicId}`)).status, 200,
    'private grant creation must not alter public-link availability');

  const duplicate = await fetch(`${origin}/account`, {
    method: 'POST', headers: auth(ownerId),
    body: JSON.stringify({ path: '/Household', recipientId: viewerId, permission: 'editor' }),
  });
  assert.equal(duplicate.status, 409);

  const receivedResponse = await fetch(`${origin}/account/received`, { headers: auth(viewerId, false) });
  assert.equal(receivedResponse.status, 200);
  const received = await receivedResponse.json() as any[];
  assert.equal(received[0].owner.displayName, 'Owner');
  assert.equal(received[0].permission, 'viewer');
  assert.equal(received[0].rootPath, undefined, 'recipient summaries do not disclose the owner path');

  const viewerListingResponse = await fetch(`${origin}/account/${viewerGrant.id}/list`, { headers: auth(viewerId, false) });
  const viewerListingBody = await viewerListingResponse.text();
  assert.equal(viewerListingResponse.status, 200, viewerListingBody);
  const viewerListing = JSON.parse(viewerListingBody) as any;
  assert.deepEqual(viewerListing.entries.map((entry: any) => entry.path), ['Projects', 'note.txt']);
  assert.equal(viewerListing.breadcrumbs[0].name, 'Household');
  const canonicalListing = await fetch(`${origin}/account/${viewerGrant.id}/list?path=Projects%2F`,
    { headers: auth(viewerId, false) });
  assert.equal(canonicalListing.status, 200);
  assert.equal((await canonicalListing.json() as any).path, 'Projects', 'shared paths are returned canonically');

  const viewerRaw = await fetch(`${origin}/account/${viewerGrant.id}/raw?path=note.txt`, { headers: auth(viewerId, false) });
  assert.equal(viewerRaw.status, 200);
  assert.equal(await viewerRaw.text(), 'before');
  for (const escaped of ['../secret.txt', '/secret.txt', 'Projects/../../secret.txt']) {
    const response = await fetch(`${origin}/account/${viewerGrant.id}/raw?path=${encodeURIComponent(escaped)}`,
      { headers: auth(viewerId, false) });
    assert.equal(response.status, 400, escaped);
  }
  assert.equal((await fetch(`${origin}/account/${viewerGrant.id}/list`, { headers: auth(strangerId, false) })).status, 404,
    'a valid grant id is not a bearer capability');
  assert.equal((await fetch(`${origin}/account/${viewerGrant.id}/content`, {
    method: 'POST', headers: auth(viewerId), body: JSON.stringify({ path: 'note.txt', content: 'denied' }),
  })).status, 403, 'viewers cannot mutate descendants');

  const leavingGrant = await createGrant(strangerId, 'viewer');
  const left = await fetch(`${origin}/account/${leavingGrant.id}/leave`, {
    method: 'DELETE', headers: auth(strangerId, false),
  });
  assert.equal(left.status, 200, await left.text());
  assert.equal((await fetch(`${origin}/account/${leavingGrant.id}/list`, {
    headers: auth(strangerId, false),
  })).status, 404, 'leaving a share revokes recipient access immediately');
  assert.ok((db.prepare('SELECT revoked_at FROM account_shares WHERE id=?').get(leavingGrant.id) as any).revoked_at,
    'recipient-initiated revocation is retained for audit');

  const editorGrant = await createGrant(editorId, 'editor');
  const contentResponse = await fetch(`${origin}/account/${editorGrant.id}/content?path=note.txt`,
    { headers: auth(editorId, false) });
  assert.equal(contentResponse.status, 200);
  const content = await contentResponse.json() as any;
  const save = await fetch(`${origin}/account/${editorGrant.id}/content`, {
    method: 'POST', headers: auth(editorId),
    body: JSON.stringify({ path: 'note.txt', content: 'edited together', revision: content.revision }),
  });
  assert.equal(save.status, 200, await save.text());
  assert.equal(await fsp.readFile(path.join(ownerRoot, 'Household', 'note.txt'), 'utf8'), 'edited together');

  const versionsResponse = await fetch(`${origin}/account/${editorGrant.id}/versions?path=note.txt`,
    { headers: auth(editorId, false) });
  assert.equal(versionsResponse.status, 200);
  const versions = await versionsResponse.json() as any[];
  assert.equal(versions[0].author, 'Editor', 'shared edits are versioned under the actor, not the storage owner');
  const restore = await fetch(`${origin}/account/${editorGrant.id}/versions/restore`, {
    method: 'POST', headers: auth(editorId),
    body: JSON.stringify({ path: 'note.txt', versionId: versions[0].id }),
  });
  assert.equal(restore.status, 200, await restore.text());
  assert.equal(await fsp.readFile(path.join(ownerRoot, 'Household', 'note.txt'), 'utf8'), 'before');

  assert.equal((await fetch(`${origin}/account/${editorGrant.id}/mkdir`, {
    method: 'POST', headers: auth(editorId), body: JSON.stringify({ path: '', name: 'Drafts' }),
  })).status, 201);
  assert.equal((await fetch(`${origin}/account/${editorGrant.id}/create`, {
    method: 'POST', headers: auth(editorId),
    body: JSON.stringify({ path: 'Drafts', name: 'todo.txt', content: 'shared todo' }),
  })).status, 201);
  const renamed = await fetch(`${origin}/account/${editorGrant.id}/rename`, {
    method: 'POST', headers: auth(editorId),
    body: JSON.stringify({ path: 'Drafts/todo.txt', newName: 'done.txt' }),
  });
  assert.equal(renamed.status, 200, await renamed.text());
  assert.equal(await fsp.readFile(path.join(ownerRoot, 'Household', 'Drafts', 'done.txt'), 'utf8'), 'shared todo');

  const upload = new FormData();
  upload.append('path', 'Drafts');
  upload.append('files', new Blob([Buffer.from('from browser')]), 'upload.txt');
  const uploaded = await fetch(`${origin}/account/${editorGrant.id}/upload`, {
    method: 'POST', headers: {
      ...auth(editorId, false), 'X-Aerie-Upload-Length': String(Buffer.byteLength('from browser')),
    }, body: upload,
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  assert.equal(await fsp.readFile(path.join(ownerRoot, 'Household', 'Drafts', 'upload.txt'), 'utf8'), 'from browser');

  const deleted = await fetch(`${origin}/account/${editorGrant.id}/delete`, {
    method: 'POST', headers: auth(editorId), body: JSON.stringify({ paths: ['Drafts/done.txt'] }),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal(await fsp.access(path.join(ownerRoot, 'Household', 'Drafts', 'done.txt')).then(() => true, () => false), false);
  assert.ok(db.prepare("SELECT 1 FROM trash WHERE user_id=? AND original_path='/Household/Drafts/done.txt'").get(ownerId),
    'recipient deletions use the owner trash and remain recoverable');
  assert.equal((await fetch(`${origin}/account/${editorGrant.id}/delete`, {
    method: 'POST', headers: auth(editorId), body: JSON.stringify({ paths: [''] }),
  })).status, 400, 'the granted root itself is protected from recipient deletion');

  await writes.movePathAtomic({ user: owner, from: '/Household', to: '/Family' });
  const rekeyed = db.prepare('SELECT root_path FROM account_shares WHERE id=?').get(editorGrant.id) as any;
  assert.equal(rekeyed.root_path, '/Family');
  assert.equal((await fetch(`${origin}/account/${editorGrant.id}/list`, { headers: auth(editorId, false) })).status, 200,
    'an owner rename preserves inherited recipient access');
  assert.equal((db.prepare('SELECT path FROM shares WHERE id=?').get(publicId) as any).path, '/Family/note.txt',
    'the existing public-link metadata still follows owner renames independently');
  assert.equal((await fetch(`${origin}/public/${publicId}`)).status, 200);

  const downgraded = await fetch(`${origin}/account/${editorGrant.id}`, {
    method: 'PATCH', headers: auth(ownerId), body: JSON.stringify({ permission: 'viewer' }),
  });
  assert.equal(downgraded.status, 200);
  assert.equal((await fetch(`${origin}/account/${editorGrant.id}/mkdir`, {
    method: 'POST', headers: auth(editorId), body: JSON.stringify({ path: '', name: 'Denied' }),
  })).status, 403, 'permission changes are enforced on the next request');

  const revoked = await fetch(`${origin}/account/${viewerGrant.id}`, { method: 'DELETE', headers: auth(ownerId, false) });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${origin}/account/${viewerGrant.id}/list`, { headers: auth(viewerId, false) })).status, 404);
  assert.ok((db.prepare('SELECT revoked_at FROM account_shares WHERE id=?').get(viewerGrant.id) as any).revoked_at,
    'revocation is retained for audit instead of erasing the grant');
  assert.equal((await fetch(`${origin}/public/${publicId}`)).status, 200,
    'account revocation cannot revoke or expose public capability state');

  const actions = (db.prepare(`SELECT action FROM audit WHERE user_id IN (?,?)`).all(ownerId, editorId) as any[])
    .map(row => row.action);
  for (const action of ['account_share_created', 'shared_file_saved', 'shared_item_renamed',
    'shared_item_deleted', 'shared_upload', 'account_share_revoked']) assert.ok(actions.includes(action), action);
  assert.ok((db.prepare("SELECT 1 FROM audit WHERE user_id=? AND action='account_share_left'")
    .get(strangerId)), 'leaving a share is auditable');
});
