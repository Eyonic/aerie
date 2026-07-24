import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-backup-test-'));
process.env.DATA_DIR = path.join(sandbox, 'unused-default-data');
process.env.FILES_ROOT = path.join(sandbox, 'unused-default-files');
process.env.JWT_SECRET = 'backup-test-jwt';

const backup = await import('../src/services/backup.js');
type BackupCallbacks = import('../src/services/backup.js').BackupCallbacks;

function pathsFor(name: string) {
  const root = path.join(sandbox, name);
  return {
    root,
    paths: {
      dataDir: path.join(root, 'data'),
      dbPath: path.join(root, 'data', 'cloudbox.db'),
      filesRoot: path.join(root, 'files'),
      downloadsDir: path.join(root, 'downloads'),
      backupDir: path.join(root, 'data', 'backups'),
    },
  };
}

function callbacks(dbPath: string): BackupCallbacks {
  return {
    async snapshotDatabase(destination) { await fsp.copyFile(dbPath, destination); },
    async validateDatabase(databasePath) {
      const contents = await fsp.readFile(databasePath, 'utf8');
      if (!contents.startsWith('TEST-SQLITE:')) throw new Error('sqlite_integrity_check_failed:test fixture');
    },
  };
}

async function seed(name: string) {
  const fixture = pathsFor(name);
  await Promise.all([
    fsp.mkdir(path.join(fixture.paths.dataDir, 'generated'), { recursive: true }),
    fsp.mkdir(path.join(fixture.paths.dataDir, 'thumbs'), { recursive: true }),
    fsp.mkdir(path.join(fixture.paths.filesRoot, 'alice', 'Documents'), { recursive: true }),
    fsp.mkdir(fixture.paths.downloadsDir, { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(fixture.paths.dbPath, 'TEST-SQLITE:before'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'before'),
    fsp.writeFile(path.join(fixture.paths.dataDir, 'generated', 'image.webp'), 'generated-before'),
    fsp.writeFile(path.join(fixture.paths.dataDir, '.jwt-secret'), 'secret-before', { mode: 0o600 }),
    fsp.writeFile(path.join(fixture.paths.dataDir, 'thumbs', 'cache.webp'), 'cache-before'),
    fsp.writeFile(path.join(fixture.paths.downloadsDir, 'offline.bin'), 'download-before'),
  ]);
  return fixture;
}

test.after(async () => {
  await fsp.rm(sandbox, { recursive: true, force: true });
});

test('creates one truthful, portable and fully verified recovery bundle', async () => {
  const fixture = await seed('create');
  await Promise.all([
    fsp.mkdir(path.join(fixture.paths.filesRoot, '.uploads-tmp'), { recursive: true }),
    fsp.mkdir(path.join(fixture.paths.filesRoot, '.sync-uploads-tmp'), { recursive: true }),
    fsp.mkdir(path.join(fixture.paths.filesRoot, '.aerie-restore-stage-orphan'), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(fixture.paths.filesRoot, '.uploads-tmp', 'partial.bin'), 'partial'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, '.sync-uploads-tmp', 'partial.bin'), 'partial'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, '.aerie-restore-stage-orphan', 'partial.bin'), 'partial'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, 'alice', '.aerie-copy-orphan.tmp'), 'partial'),
  ]);
  const result = await backup.createBackup({
    paths: fixture.paths,
    ...callbacks(fixture.paths.dbPath),
    now: new Date('2026-07-22T01:02:03.000Z'),
  });

  assert.match(result.name, /^aerie-2026-07-22T01-02-03-000Z-[a-f0-9]{8}\.aerie-backup\.tar\.gz$/);
  assert.equal(result.manifest.format, 'aerie-recovery-bundle');
  assert.ok(result.manifest.entries.some(entry => entry.path === 'payload/database/cloudbox.db'));
  assert.ok(result.manifest.entries.some(entry => entry.path.endsWith('/alice/Documents/note.txt')));
  assert.ok(result.manifest.entries.some(entry => entry.path.endsWith('/generated/image.webp')));
  assert.ok(result.manifest.entries.some(entry => entry.path.endsWith('/.jwt-secret')));
  assert.ok(result.manifest.entries.some(entry => entry.path.endsWith('/offline.bin')));
  assert.ok(!result.manifest.entries.some(entry => entry.path.includes('/thumbs/')));
  assert.ok(!result.manifest.entries.some(entry => entry.path.includes('/backups/')));
  assert.ok(!result.manifest.entries.some(entry => entry.path.includes('/.uploads-tmp')));
  assert.ok(!result.manifest.entries.some(entry => entry.path.includes('/.sync-uploads-tmp')));
  assert.ok(!result.manifest.entries.some(entry => entry.path.includes('/.aerie-')));

  const artifact = path.join(fixture.paths.backupDir, result.name);
  const verified = await backup.verifyBackupArtifact(artifact);
  assert.equal(verified.sha256, result.sha256);
  assert.equal(verified.manifest.integrity.entryCount, verified.manifest.entries.length);

  const history = await backup.listBackupHistory(fixture.paths);
  assert.equal(history.length, 1);
  assert.equal(history[0].success, true);
  assert.equal(history[0].kind, 'recovery_bundle');
  const statuses = await backup.backupStatuses(fixture.paths);
  assert.deepEqual(statuses.map(status => status.key), ['db', 'offsite']);
  assert.equal(statuses[0].success, true);
  assert.match(statuses[0].note || '', /database|user files/i);
  assert.equal(statuses[1].success, false);
  assert.match(statuses[1].note || '', /Not configured/);
});

test('restore is checksum-validated, staged, and only applied during the restart handoff', async () => {
  const fixture = await seed('restore');
  const result = await backup.createBackup({ paths: fixture.paths, ...callbacks(fixture.paths.dbPath) });

  await Promise.all([
    fsp.writeFile(fixture.paths.dbPath, 'TEST-SQLITE:after'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'after'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, 'alice', 'new.txt'), 'remove-on-restore'),
    fsp.writeFile(path.join(fixture.paths.dataDir, 'generated', 'image.webp'), 'generated-after'),
    fsp.writeFile(path.join(fixture.paths.dataDir, 'thumbs', 'cache.webp'), 'cache-after'),
    fsp.writeFile(path.join(fixture.paths.downloadsDir, 'offline.bin'), 'download-after'),
  ]);

  const staged = await backup.stageRestore(result.name, 7, {
    paths: fixture.paths,
    validateDatabase: callbacks(fixture.paths.dbPath).validateDatabase,
  });
  assert.equal(staged.kind, 'recovery_bundle');
  assert.equal(await fsp.readFile(fixture.paths.dbPath, 'utf8'), 'TEST-SQLITE:after', 'live DB must not be overwritten');
  assert.equal(await fsp.readFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'utf8'), 'after');

  const applied = await backup.applyPendingRestore({ paths: fixture.paths, ...callbacks(fixture.paths.dbPath), retention: 20 });
  assert.equal(applied.applied, true);
  assert.equal(applied.artifact, result.name);
  assert.match(applied.safetyBackup || '', /^pre-restore-/);
  assert.equal(await fsp.readFile(fixture.paths.dbPath, 'utf8'), 'TEST-SQLITE:before');
  assert.equal(await fsp.readFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'utf8'), 'before');
  await assert.rejects(fsp.stat(path.join(fixture.paths.filesRoot, 'alice', 'new.txt')), /ENOENT/);
  assert.equal(await fsp.readFile(path.join(fixture.paths.dataDir, 'generated', 'image.webp'), 'utf8'), 'generated-before');
  assert.equal(await fsp.readFile(path.join(fixture.paths.downloadsDir, 'offline.bin'), 'utf8'), 'download-before');
  assert.equal(await fsp.readFile(path.join(fixture.paths.dataDir, 'thumbs', 'cache.webp'), 'utf8'), 'cache-after',
    'regenerable cache is deliberately outside the restore set');

  const backupDirEntries = await fsp.readdir(fixture.paths.backupDir);
  assert.ok(backupDirEntries.some(name => name.startsWith('restore-applied-')));
  assert.ok(backupDirEntries.some(name => name.startsWith('pre-restore-') && name.endsWith('.aerie-backup.tar.gz')));
  assert.equal((await backup.applyPendingRestore({ paths: fixture.paths, ...callbacks(fixture.paths.dbPath) })).applied, false);
});

test('tampering and unsafe restore names are rejected before a handoff marker is written', async () => {
  const fixture = await seed('tamper');
  const result = await backup.createBackup({ paths: fixture.paths, ...callbacks(fixture.paths.dbPath) });
  const artifact = path.join(fixture.paths.backupDir, result.name);
  const handle = await fsp.open(artifact, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 12);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, 12);
  } finally { await handle.close(); }

  await assert.rejects(() => backup.verifyBackupArtifact(artifact), /checksum|incorrect header check|invalid/i);
  await assert.rejects(() => backup.stageRestore('../cloudbox.db', 1, { paths: fixture.paths }), /invalid_backup_name/);
  await assert.rejects(() => backup.stageRestore(result.name, 1, { paths: fixture.paths }), /checksum|header|invalid/i);
  const markers = backup.backupInternals.markerPaths(backup.backupPaths(fixture.paths));
  await assert.rejects(fsp.stat(markers.pending), /ENOENT/);
});

test('a failed post-swap database check restores every live component from rollback', async () => {
  const fixture = await seed('rollback');
  const baseCallbacks = callbacks(fixture.paths.dbPath);
  const result = await backup.createBackup({ paths: fixture.paths, ...baseCallbacks });
  await Promise.all([
    fsp.writeFile(fixture.paths.dbPath, 'TEST-SQLITE:live-after'),
    fsp.writeFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'live-after'),
    fsp.writeFile(path.join(fixture.paths.dataDir, 'generated', 'image.webp'), 'generated-live-after'),
    fsp.writeFile(path.join(fixture.paths.downloadsDir, 'offline.bin'), 'download-live-after'),
  ]);
  await backup.stageRestore(result.name, 9, { paths: fixture.paths });

  await assert.rejects(() => backup.applyPendingRestore({
    paths: fixture.paths,
    snapshotDatabase: baseCallbacks.snapshotDatabase,
    validateDatabase: async databasePath => {
      await baseCallbacks.validateDatabase(databasePath);
      if (path.resolve(databasePath) === path.resolve(fixture.paths.dbPath)) throw new Error('simulated_post_swap_failure');
    },
  }), /simulated_post_swap_failure/);

  assert.equal(await fsp.readFile(fixture.paths.dbPath, 'utf8'), 'TEST-SQLITE:live-after');
  assert.equal(await fsp.readFile(path.join(fixture.paths.filesRoot, 'alice', 'Documents', 'note.txt'), 'utf8'), 'live-after');
  assert.equal(await fsp.readFile(path.join(fixture.paths.dataDir, 'generated', 'image.webp'), 'utf8'), 'generated-live-after');
  assert.equal(await fsp.readFile(path.join(fixture.paths.downloadsDir, 'offline.bin'), 'utf8'), 'download-live-after');
  const backupDirEntries = await fsp.readdir(fixture.paths.backupDir);
  assert.ok(backupDirEntries.some(name => name.startsWith('restore-failed-')));
  assert.equal(backupDirEntries.includes('restore-maintenance.json'), false);
});

test('retention keeps only the newest complete artifacts and their sidecars', async () => {
  const fixture = await seed('retention');
  for (let day = 1; day <= 4; day++) {
    await fsp.writeFile(fixture.paths.dbPath, `TEST-SQLITE:day-${day}`);
    await backup.createBackup({
      paths: fixture.paths,
      ...callbacks(fixture.paths.dbPath),
      now: new Date(`2026-07-0${day}T03:00:00.000Z`),
      retention: 2,
    });
  }
  const names = await fsp.readdir(fixture.paths.backupDir);
  const artifacts = names.filter(name => name.endsWith('.aerie-backup.tar.gz'));
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every(name => names.includes(`${name}.sha256`) && names.includes(`${name}.meta.json`)));
  assert.equal(names.some(name => name.includes('2026-07-01')), false);
  assert.equal(names.some(name => name.includes('2026-07-02')), false);
});

test('stale backup staging cleanup removes only old, inactive Aerie staging entries', async () => {
  const fixture = await seed('stale-staging-cleanup');
  await fsp.mkdir(fixture.paths.backupDir, { recursive: true });
  const nowMs = Date.now();
  const staleTime = new Date(nowMs - backup.backupInternals.STALE_STAGING_AGE_MS - 60_000);
  const freshTime = new Date(nowMs - 60 * 60 * 1000);
  const stalePartial = `.aerie-2026-07-01T01-02-03-000Z-deadbeef.aerie-backup.tar.gz.partial-${process.pid}`;
  const staleChecksum = `${stalePartial}.sha256`;
  const staleWork = '.backup-work-Ab12Cd';
  const activeWork = '.backup-work-CuRr01';
  const activePartial = `.aerie-2026-07-01T02-03-04-000Z-feedface.aerie-backup.tar.gz.partial-${process.pid}`;
  const freshPartial = '.aerie-2026-07-02T01-02-03-000Z-cafebabe.aerie-backup.tar.gz.partial-4322';
  const symlinkPartial = '.aerie-2026-07-03T01-02-03-000Z-acde1234.aerie-backup.tar.gz.partial-4323';
  const unknownDirectory = '.backup-work-not-six-characters';
  const completeArtifact = 'aerie-2026-07-04T01-02-03-000Z-acde4321.aerie-backup.tar.gz';
  const outsideTarget = path.join(fixture.root, 'outside-target');
  const direct = (name: string) => path.join(fixture.paths.backupDir, name);

  await Promise.all([
    fsp.writeFile(direct(stalePartial), 'orphaned archive bytes'),
    fsp.writeFile(direct(staleChecksum), 'orphaned checksum'),
    fsp.mkdir(direct(staleWork)),
    fsp.mkdir(direct(activeWork)),
    fsp.writeFile(direct(activePartial), 'active archive bytes'),
    fsp.writeFile(direct(freshPartial), 'in progress'),
    fsp.mkdir(direct(unknownDirectory)),
    fsp.writeFile(direct(completeArtifact), 'complete archive'),
    fsp.writeFile(direct(`${completeArtifact}.sha256`), 'complete checksum'),
    fsp.writeFile(direct(`${completeArtifact}.meta.json`), 'complete metadata'),
    fsp.writeFile(outsideTarget, 'must remain'),
  ]);
  await fsp.symlink(outsideTarget, direct(symlinkPartial));
  await Promise.all([
    fsp.utimes(direct(stalePartial), staleTime, staleTime),
    fsp.utimes(direct(staleChecksum), staleTime, staleTime),
    fsp.utimes(direct(staleWork), staleTime, staleTime),
    fsp.utimes(direct(activeWork), staleTime, staleTime),
    fsp.utimes(direct(activePartial), staleTime, staleTime),
    fsp.utimes(direct(freshPartial), freshTime, freshTime),
    fsp.utimes(direct(unknownDirectory), staleTime, staleTime),
    fsp.utimes(direct(completeArtifact), staleTime, staleTime),
    fsp.utimes(direct(`${completeArtifact}.sha256`), staleTime, staleTime),
    fsp.utimes(direct(`${completeArtifact}.meta.json`), staleTime, staleTime),
    fsp.lutimes(direct(symlinkPartial), staleTime, staleTime),
  ]);

  const removed = await backup.backupInternals.cleanupStaleBackupStaging(
    backup.backupPaths(fixture.paths),
    nowMs,
    [direct(activeWork), direct(activePartial)],
  );
  assert.deepEqual(removed.sort(), [staleChecksum, stalePartial, staleWork].sort());
  await Promise.all([
    assert.rejects(fsp.lstat(direct(stalePartial)), /ENOENT/),
    assert.rejects(fsp.lstat(direct(staleChecksum)), /ENOENT/),
    assert.rejects(fsp.lstat(direct(staleWork)), /ENOENT/),
  ]);
  for (const retained of [
    activeWork,
    activePartial,
    freshPartial,
    unknownDirectory,
    completeArtifact,
    `${completeArtifact}.sha256`,
    `${completeArtifact}.meta.json`,
    symlinkPartial,
  ]) assert.ok(await fsp.lstat(direct(retained)));
  assert.equal((await fsp.lstat(direct(symlinkPartial))).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(outsideTarget, 'utf8'), 'must remain');
});

test('creating a backup clears stale staging before it writes the new bundle', async () => {
  const fixture = await seed('stale-staging-create-hook');
  await fsp.mkdir(fixture.paths.backupDir, { recursive: true });
  const orphan = path.join(fixture.paths.backupDir, '.backup-work-Zz91Qp');
  await fsp.mkdir(orphan);
  const staleTime = new Date(Date.now() - backup.backupInternals.STALE_STAGING_AGE_MS - 60_000);
  await fsp.utimes(orphan, staleTime, staleTime);

  await backup.createBackup({ paths: fixture.paths, ...callbacks(fixture.paths.dbPath) });
  await assert.rejects(fsp.lstat(orphan), /ENOENT/);
});

test('graceful cancellation removes only active staging and preserves finalized backups', async t => {
  const fixture = await seed('graceful-cancellation');
  const finalized = await backup.createBackup({
    paths: fixture.paths,
    ...callbacks(fixture.paths.dbPath),
    now: new Date('2026-07-23T01:00:00.000Z'),
  });
  const finalizedArtifact = path.join(fixture.paths.backupDir, finalized.name);

  const slowFile = path.join(fixture.paths.filesRoot, 'slow.bin');
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  await fsp.writeFile(slowFile, Buffer.alloc(chunk.length * 16));
  const originalCreateReadStream = fs.createReadStream;
  let signalSlowReadStarted!: () => void;
  const slowReadStarted = new Promise<void>(resolve => { signalSlowReadStarted = resolve; });
  t.mock.method(fs, 'createReadStream', ((file: fs.PathLike, options?: any) => {
    if (path.resolve(String(file)) !== path.resolve(slowFile)) {
      return originalCreateReadStream(file, options);
    }
    signalSlowReadStarted();
    return Readable.from((async function* () {
      for (let index = 0; index < 16; index++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        yield chunk;
      }
    })()) as any;
  }) as any);

  const pending = backup.createBackup({
    paths: fixture.paths,
    ...callbacks(fixture.paths.dbPath),
    now: new Date('2026-07-24T01:00:00.000Z'),
  });
  await slowReadStarted;
  const during = await fsp.readdir(fixture.paths.backupDir);
  assert.ok(during.some(name => name.includes('.partial-')), 'the active archive should still be staged');
  const rejected = assert.rejects(pending, new RegExp(backup.BACKUP_INTERRUPTED_BY_SHUTDOWN));
  assert.equal(
    await backup.abortActiveBackup(new Error(backup.BACKUP_INTERRUPTED_BY_SHUTDOWN)),
    true,
  );
  await rejected;
  assert.equal(await backup.abortActiveBackup(), false, 'cancellation should be idempotent after cleanup');

  const after = await fsp.readdir(fixture.paths.backupDir);
  assert.equal(after.some(name => name.startsWith('.backup-work-') || name.includes('.partial-')), false);
  assert.deepEqual(after.filter(name => name.endsWith(backup.backupInternals.ARCHIVE_SUFFIX)), [finalized.name]);
  assert.ok(after.includes(`${finalized.name}.sha256`));
  assert.ok(after.includes(`${finalized.name}.meta.json`));
  assert.equal((await backup.verifyBackupArtifact(finalizedArtifact)).sha256, finalized.sha256);
});
