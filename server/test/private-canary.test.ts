import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Database from 'better-sqlite3';

import { parsePrivateCanary } from '../src/runtime-mode.js';

const execute = promisify(execFile);

test('private canary flag is explicit and fail-closed', () => {
  assert.equal(parsePrivateCanary(undefined), false);
  assert.equal(parsePrivateCanary('0'), false);
  assert.equal(parsePrivateCanary('1'), true);
  assert.throws(() => parsePrivateCanary('true'), /invalid_aerie_private_canary/);
});

test('private canary runs canonical DB startup without renaming legacy user files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-private-canary-'));
  const dataDir = path.join(root, 'data');
  const filesRoot = path.join(root, 'files');
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    FILES_ROOT: filesRoot,
    DOWNLOADS_DIR: path.join(root, 'downloads'),
    ADMIN_PASSWORD: 'private-canary-test-password',
    JWT_SECRET: 'private-canary-test-secret',
  };
  const boot = (extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    'const { db } = await import("./src/lib/db.ts"); db.close();',
  ], { cwd: path.resolve('.'), env: { ...env, ...extra }, timeout: 30_000 });
  try {
    await boot();
    const database = new Database(path.join(dataDir, 'cloudbox.db'));
    database.prepare(`INSERT INTO users
      (username,storage_id,display_name,password_hash,role,avatar_color,ai_mode)
      VALUES (?,?,?,?,?,?,?)`).run('legacy-user', null, 'Legacy User', 'unused', 'user', '#123456', 'local_only');
    database.close();
    const legacyRoot = path.join(filesRoot, 'legacy-user');
    await fsp.mkdir(legacyRoot, { recursive: true });
    await fsp.writeFile(path.join(legacyRoot, 'keep.txt'), 'preserve me');

    await boot({ AERIE_PRIVATE_CANARY: '1' });
    const after = new Database(path.join(dataDir, 'cloudbox.db'), { readonly: true });
    try {
      assert.equal((after.prepare("SELECT storage_id FROM users WHERE username='legacy-user'").get() as any).storage_id, null);
      assert.equal(after.pragma('user_version', { simple: true }), 7);
    } finally { after.close(); }
    assert.equal(await fsp.readFile(path.join(legacyRoot, 'keep.txt'), 'utf8'), 'preserve me');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
