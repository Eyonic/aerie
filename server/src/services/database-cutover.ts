import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const SNAPSHOT_FORMAT = 'aerie-database-cutover-snapshot';
const SNAPSHOT_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface DatabaseCutoverSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  createdAt: string;
  sha256: string;
  sizeBytes: number;
  userVersion: number;
  applicationId: number;
  tableCount: number;
}

function temporaryPath(destination: string, label: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${label}-${process.pid}-${crypto.randomUUID()}`);
}

async function regularFile(file: string, code: string): Promise<void> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
}

async function pathMustNotExist(file: string, code: string): Promise<void> {
  try {
    await fsp.lstat(file);
    throw new Error(code);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function databaseFacts(database: Database.Database): Omit<DatabaseCutoverSnapshot, 'format' | 'version' | 'createdAt' | 'sha256' | 'sizeBytes'> {
  const integrity = database.pragma('integrity_check') as Array<Record<string, unknown>>;
  const results = integrity.map(row => String(row.integrity_check ?? Object.values(row)[0] ?? ''));
  if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
    throw new Error(`cutover_snapshot_integrity_failed:${results.slice(0, 5).join(';')}`);
  }
  const foreignKeys = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeys.length) throw new Error(`cutover_snapshot_foreign_keys_failed:${foreignKeys.length}`);
  return {
    userVersion: Number(database.pragma('user_version', { simple: true }) || 0),
    applicationId: Number(database.pragma('application_id', { simple: true }) || 0),
    tableCount: Number((database.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type='table'").get() as any)?.count || 0),
  };
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicManifest(file: string, value: DatabaseCutoverSnapshot): Promise<void> {
  const temporary = temporaryPath(file, 'write');
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temporary);
    await fsp.rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function openVerifiedDatabase(file: string): { database: Database.Database; facts: ReturnType<typeof databaseFacts> } {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.pragma('busy_timeout = 30000');
    return { database, facts: databaseFacts(database) };
  } catch (error) {
    database.close();
    throw error;
  }
}

// VACUUM INTO reads a single SQLite snapshot, including committed WAL pages,
// and writes a standalone database with no sidecar dependency. Producing two
// independent normalized copies and requiring byte-identical hashes verifies
// that the stopped source did not change while the rollback point was captured.
export async function createDatabaseCutoverSnapshot(
  sourcePath: string,
  snapshotPath: string,
  manifestPath: string,
): Promise<DatabaseCutoverSnapshot> {
  if ([sourcePath, snapshotPath, manifestPath].some(value => !path.isAbsolute(value))) {
    throw new Error('cutover_snapshot_paths_must_be_absolute');
  }
  if (new Set([path.resolve(sourcePath), path.resolve(snapshotPath), path.resolve(manifestPath)]).size !== 3) {
    throw new Error('cutover_snapshot_paths_overlap');
  }
  await regularFile(sourcePath, 'cutover_source_not_regular_file');
  await fsp.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  await pathMustNotExist(snapshotPath, 'cutover_snapshot_already_exists');
  await pathMustNotExist(manifestPath, 'cutover_manifest_already_exists');

  const first = temporaryPath(snapshotPath, 'first');
  const second = temporaryPath(snapshotPath, 'verify');
  const { database: source, facts: sourceFacts } = openVerifiedDatabase(sourcePath);
  try {
    source.prepare('VACUUM INTO ?').run(first);
    source.prepare('VACUUM INTO ?').run(second);
  } finally {
    source.close();
  }

  try {
    await Promise.all([
      regularFile(first, 'cutover_snapshot_not_regular_file'),
      regularFile(second, 'cutover_snapshot_verification_not_regular_file'),
    ]);
    const [firstHash, secondHash] = await Promise.all([sha256File(first), sha256File(second)]);
    if (!crypto.timingSafeEqual(Buffer.from(firstHash, 'hex'), Buffer.from(secondHash, 'hex'))) {
      throw new Error('cutover_source_changed_during_snapshot');
    }
    const { database: snapshot, facts } = openVerifiedDatabase(first);
    snapshot.close();
    if (facts.userVersion !== sourceFacts.userVersion
      || facts.applicationId !== sourceFacts.applicationId
      || facts.tableCount !== sourceFacts.tableCount) {
      throw new Error('cutover_snapshot_state_mismatch');
    }
    const stat = await fsp.stat(first);
    const manifest: DatabaseCutoverSnapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      sha256: firstHash,
      sizeBytes: stat.size,
      ...facts,
    };
    await fsp.chmod(first, 0o600);
    await fsyncFile(first);
    await fsp.rename(first, snapshotPath);
    await fsyncDirectory(path.dirname(snapshotPath));
    await atomicManifest(manifestPath, manifest);
    return manifest;
  } finally {
    await Promise.all([
      fsp.rm(first, { force: true }).catch(() => undefined),
      fsp.rm(second, { force: true }).catch(() => undefined),
    ]);
  }
}

export async function verifyDatabaseCutoverSnapshot(
  snapshotPath: string,
  manifestPath: string,
): Promise<DatabaseCutoverSnapshot> {
  await regularFile(snapshotPath, 'cutover_snapshot_not_regular_file');
  await regularFile(manifestPath, 'cutover_manifest_not_regular_file');
  const manifestStat = await fsp.stat(manifestPath);
  if (manifestStat.size < 2 || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('cutover_manifest_size_invalid');
  const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Partial<DatabaseCutoverSnapshot>;
  if (parsed.format !== SNAPSHOT_FORMAT || parsed.version !== SNAPSHOT_VERSION
    || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))
    || typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256)
    || !Number.isSafeInteger(parsed.sizeBytes) || Number(parsed.sizeBytes) < 1
    || !Number.isSafeInteger(parsed.userVersion) || Number(parsed.userVersion) < 0
    || !Number.isSafeInteger(parsed.applicationId) || Number(parsed.applicationId) < 0
    || !Number.isSafeInteger(parsed.tableCount) || Number(parsed.tableCount) < 0) {
    throw new Error('cutover_manifest_invalid');
  }
  const manifest = parsed as DatabaseCutoverSnapshot;
  const stat = await fsp.stat(snapshotPath);
  if (stat.size !== manifest.sizeBytes) throw new Error('cutover_snapshot_size_mismatch');
  const actualHash = await sha256File(snapshotPath);
  if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(manifest.sha256, 'hex'))) {
    throw new Error('cutover_snapshot_hash_mismatch');
  }
  const { database, facts } = openVerifiedDatabase(snapshotPath);
  database.close();
  if (facts.userVersion !== manifest.userVersion
    || facts.applicationId !== manifest.applicationId
    || facts.tableCount !== manifest.tableCount) {
    throw new Error('cutover_snapshot_manifest_mismatch');
  }
  return manifest;
}

export async function restoreDatabaseCutoverSnapshot(
  snapshotPath: string,
  manifestPath: string,
  livePath: string,
): Promise<DatabaseCutoverSnapshot> {
  if (![snapshotPath, manifestPath, livePath].every(value => path.isAbsolute(value))) {
    throw new Error('cutover_restore_paths_must_be_absolute');
  }
  const manifest = await verifyDatabaseCutoverSnapshot(snapshotPath, manifestPath);
  try {
    await regularFile(livePath, 'cutover_live_database_not_regular_file');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const liveDirectory = path.dirname(livePath);
  const staged = temporaryPath(livePath, 'restore');
  const quarantined: Array<{ source: string; destination: string }> = [];
  let installed = false;
  try {
    await fsp.copyFile(snapshotPath, staged, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(staged, 0o600);
    await fsyncFile(staged);
    await verifyDatabaseCutoverSnapshot(staged, manifestPath);

    // A stopped WAL-mode process can leave sidecars behind. Quarantine them
    // before the main-file swap so SQLite can never replay v7 pages into the
    // restored v6 database. If the main rename fails, put every sidecar back.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const source = livePath + suffix;
      const destination = temporaryPath(livePath + suffix, 'quarantine');
      try {
        await fsp.rename(source, destination);
        quarantined.push({ source, destination });
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    try {
      await fsp.rename(staged, livePath);
      installed = true;
    } catch (error) {
      for (const item of quarantined.reverse()) {
        await fsp.rename(item.destination, item.source).catch(() => undefined);
      }
      throw error;
    }
    await fsyncDirectory(liveDirectory);
    await verifyDatabaseCutoverSnapshot(livePath, manifestPath);
    await Promise.all(quarantined.map(item => fsp.rm(item.destination, { force: true }).catch(() => undefined)));
    return manifest;
  } finally {
    if (!installed) {
      for (const item of quarantined.reverse()) {
        await fsp.rename(item.destination, item.source).catch(() => undefined);
      }
    }
    await fsp.rm(staged, { force: true }).catch(() => undefined);
  }
}
