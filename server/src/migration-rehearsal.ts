// Rehearse the exact startup schema path against a WAL-consistent copy of the
// live database. deploy/run.sh executes this inside the candidate image before
// it stops the current container, so a bad migration never reaches cutover.
import Database from 'better-sqlite3';
import fsp from 'node:fs/promises';
import path from 'node:path';

function requiredAbsolute(name: string): string {
  const value = String(process.env[name] || '');
  if (!value || !path.isAbsolute(value)) throw new Error(`${name.toLowerCase()}_must_be_absolute`);
  return path.resolve(value);
}

const sourcePath = requiredAbsolute('AERIE_MIGRATION_SOURCE');
const stageDir = requiredAbsolute('AERIE_MIGRATION_STAGE');
if (stageDir === '/' || sourcePath === stageDir || sourcePath.startsWith(stageDir + path.sep)) {
  throw new Error('unsafe_migration_rehearsal_paths');
}

const sourceStat = await fsp.lstat(sourcePath);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('migration_source_not_regular_file');
await fsp.mkdir(stageDir, { recursive: true, mode: 0o700 });
const targetPath = path.join(stageDir, 'cloudbox.db');

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  await source.backup(targetPath);
} finally {
  source.close();
}

// Config resolves boot paths at import time, so set the isolated rehearsal
// roots before importing the real database module. Nothing can touch live data.
process.env.DATA_DIR = stageDir;
process.env.FILES_ROOT = path.join(stageDir, 'files');
process.env.DOWNLOADS_DIR = path.join(stageDir, 'downloads');
process.env.JWT_SECRET ||= 'migration-rehearsal-only-not-a-runtime-secret';

const { db } = await import('./lib/db.js');
try {
  const { timeMachinePaths } = await import('./lib/persistence-bootstrap.js');
  const requiredDirectories = [
    stageDir,
    path.join(stageDir, 'versions'),
    path.join(stageDir, 'generated'),
    path.join(stageDir, 'subtitles'),
    path.join(stageDir, 'thumbs'),
    path.join(stageDir, 'downloads'),
    path.join(stageDir, 'files'),
    timeMachinePaths.manifestRoot,
    timeMachinePaths.objectRoot,
    timeMachinePaths.tempRoot,
    timeMachinePaths.restoreRoot,
  ];
  for (const directory of requiredDirectories) {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('migration_rehearsal_bootstrap_failed');
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
  if (!integrity.length || integrity.some(row => row.integrity_check !== 'ok')) {
    throw new Error('migration_rehearsal_integrity_failed');
  }
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeys.length) throw new Error('migration_rehearsal_foreign_keys_failed');
  const userVersion = Number(db.pragma('user_version', { simple: true }) || 0);
  process.stdout.write(`${JSON.stringify({ ok: true, userVersion, bootstrapDirectories: requiredDirectories.length })}\n`);
} finally {
  db.close();
}
