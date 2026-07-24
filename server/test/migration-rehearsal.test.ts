import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Database from 'better-sqlite3';

const execute = promisify(execFile);

test('migration rehearsal runs canonical v7 schema and directory bootstrap without the HTTP server', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-rehearsal-'));
  const sourceDir = path.join(root, 'source');
  const stageDir = path.join(root, 'stage');
  const source = path.join(sourceDir, 'cloudbox.db');
  try {
    await fsp.mkdir(sourceDir, { recursive: true });
    const old = new Database(source);
    old.pragma('user_version = 6');
    old.close();

    const result = await execute(process.execPath, ['--import', 'tsx', 'src/migration-rehearsal.ts'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        AERIE_MIGRATION_SOURCE: source,
        AERIE_MIGRATION_STAGE: stageDir,
        ADMIN_PASSWORD: 'migration-rehearsal-test-password',
        JWT_SECRET: 'migration-rehearsal-test-secret',
      },
      timeout: 30_000,
    });
    const output = result.stdout.trim().split('\n').at(-1) || '{}';
    assert.deepEqual(JSON.parse(output), { ok: true, userVersion: 7, bootstrapDirectories: 11 });
    assert.doesNotMatch(result.stdout + result.stderr, /listening|scheduler started/i);

    for (const directory of [
      'versions', 'generated', 'subtitles', 'thumbs', 'downloads', 'files',
      'time-machine/manifests', 'time-machine/objects', 'time-machine/tmp',
      'files/.aerie-time-machine-tmp',
    ]) {
      assert.equal((await fsp.lstat(path.join(stageDir, directory))).isDirectory(), true, directory);
    }
    const migrated = new Database(path.join(stageDir, 'cloudbox.db'), { readonly: true });
    try {
      assert.equal(migrated.pragma('user_version', { simple: true }), 7);
      for (const table of ['trusted_devices', 'device_presence', 'time_machine_snapshots']) {
        assert.ok(migrated.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table), table);
      }
    } finally { migrated.close(); }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
