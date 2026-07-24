import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import bcrypt from 'bcryptjs';

test('account deactivation revokes access without deleting member data and can be restored', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-account-lifecycle-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.FILES_ROOT = path.join(root, 'files');
  process.env.ADMIN_PASSWORD = 'account-lifecycle-admin-password';
  process.env.JWT_SECRET = 'account-lifecycle-test-secret';

  const [{ db }, adminRouter, auth, sharesRouter, storage, cast] = await Promise.all([
    import('../src/lib/db.js'),
    import('../src/routes/admin.js'),
    import('../src/lib/auth.js'),
    import('../src/routes/shares.js'),
    import('../src/services/storage.js'),
    import('../src/services/cast.js'),
  ]);
  const administrator = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any;
  const created = db.prepare(`INSERT INTO users
    (username,storage_id,display_name,password_hash,role,avatar_color,ai_mode)
    VALUES (?,?,?,?,?,?,?)`).run('member', crypto.randomUUID(), 'Member', bcrypt.hashSync('member-password-long', 4),
      'user', '#123456', 'local_only');
  const memberId = Number(created.lastInsertRowid);
  const expires = new Date(Date.now() + 86400_000).toISOString();
  db.prepare(`INSERT INTO auth_sessions (id,user_id,device_name,device_type,expires_at)
    VALUES (?,?,?,?,?)`).run('member-session', memberId, 'Browser', 'web', expires);
  const shareId = `sh_${'A'.repeat(32)}`;
  await fsp.writeFile(path.join(storage.userRoot('member'), 'keep.txt'), 'preserved');
  db.prepare(`INSERT INTO shares (id,user_id,path,name,type,permission)
    VALUES (?,?,?,?,?,?)`).run(shareId, memberId, '/keep.txt', 'keep.txt', 'link', 'view');
  db.prepare(`INSERT INTO jobs (id,user_id,type,status,prompt)
    VALUES (?,?,?,?,?)`).run('job-active', memberId, 'image', 'running', 'keep data');
  db.prepare(`INSERT INTO generated_music (id,user_id,prompt,status)
    VALUES (?,?,?,?)`).run('music-active', memberId, 'keep data', 'queued');
  db.prepare(`INSERT INTO notifications (id,user_id,title)
    VALUES (?,?,?)`).run('notice-kept', memberId, 'Keep me');
  db.exec(`CREATE TABLE IF NOT EXISTS time_machine_tasks (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,finished_at TEXT
  )`);
  db.prepare('INSERT INTO time_machine_tasks (id,user_id,status,created_at) VALUES (?,?,?,?)')
    .run('tm-queued', memberId, 'queued', new Date().toISOString());
  db.prepare('INSERT INTO time_machine_tasks (id,user_id,status,created_at) VALUES (?,?,?,?)')
    .run('tm-running', memberId, 'running', new Date().toISOString());
  const castToken = cast.mintStreamToken('http://127.0.0.1:8096/video', 'video/mp4', memberId, 'movies');
  assert.ok(cast.resolveStreamToken(castToken));

  const app = express();
  app.use(express.json());
  app.use('/shares', sharesRouter.default);
  app.use((req: any, _res, next) => { req.user = auth.rowToUser(administrator); next(); });
  app.use('/admin', adminRouter.default);
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

  assert.equal((await fetch(`${origin}/shares/public/${shareId}`)).status, 200);

  const deactivated = await fetch(`${origin}/admin/users/${memberId}`, { method: 'DELETE' });
  assert.equal(deactivated.status, 200);
  assert.ok((db.prepare('SELECT disabled_at FROM users WHERE id=?').get(memberId) as any).disabled_at);
  assert.equal(auth.findUser('member'), undefined, 'deactivated credentials are no longer discoverable by login');
  assert.ok((db.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get('member-session') as any).revoked_at);
  assert.equal((db.prepare('SELECT status FROM jobs WHERE id=?').get('job-active') as any).status, 'error');
  assert.equal((db.prepare('SELECT status FROM generated_music WHERE id=?').get('music-active') as any).status, 'error');
  assert.deepEqual(db.prepare('SELECT status,error FROM time_machine_tasks WHERE user_id=? ORDER BY id').all(memberId), [
    { status: 'failed', error: 'account_deactivated' },
    { status: 'failed', error: 'account_deactivated' },
  ]);
  assert.equal(cast.resolveStreamToken(castToken), null, 'deactivation permanently revokes existing cast capabilities');
  assert.ok(db.prepare('SELECT 1 FROM shares WHERE id=?').get(shareId), 'share metadata is preserved');
  assert.equal((await fetch(`${origin}/shares/public/${shareId}`)).status, 404, 'public shares are suspended');
  assert.ok(db.prepare('SELECT 1 FROM notifications WHERE id=?').get('notice-kept'), 'member history is preserved');

  const restored = await fetch(`${origin}/admin/users/${memberId}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as any).disabledAt, null);
  assert.ok(auth.findUser('member'), 'restored credentials can be used again');
  assert.equal((await fetch(`${origin}/shares/public/${shareId}`)).status, 200, 'preserved shares resume after restoration');
  assert.ok((db.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get('member-session') as any).revoked_at,
    'old sessions stay revoked after restore');
});
