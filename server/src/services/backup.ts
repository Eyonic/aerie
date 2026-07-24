import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import * as tar from 'tar-stream';
import { config } from '../config.js';
import type { BackupStatus } from '../lib/model.js';

const FORMAT = 'aerie-recovery-bundle';
const FORMAT_VERSION = 1;
const ARCHIVE_SUFFIX = '.aerie-backup.tar.gz';
const MANIFEST_NAME = 'manifest.json';
const DATABASE_ENTRY = 'payload/database/cloudbox.db';
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const DEFAULT_RETENTION = 14;
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STAGING_ENTRIES_SCANNED = 10_000;
const MAX_STAGING_ENTRIES_REMOVED = 256;
const BACKUP_WORK_STAGING_NAME = /^\.backup-work-[A-Za-z0-9]{6}$/;
const PARTIAL_ARTIFACT_STAGING_NAME = /^\.[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.aerie-backup\.tar\.gz\.partial-[1-9]\d*(?:\.sha256)?$/;
export const BACKUP_INTERRUPTED_BY_SHUTDOWN = 'backup_interrupted_by_shutdown';

export interface BackupPaths {
  dataDir: string;
  dbPath: string;
  filesRoot: string;
  downloadsDir: string;
  backupDir: string;
}

export interface BackupEntry {
  path: string;
  component: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  mtime: string;
  sha256?: string;
  linkTarget?: string;
}

export interface BackupComponent {
  key: 'database' | 'user_files' | 'app_data' | 'downloads' | 'runtime_config';
  name: string;
  archivePrefix: string;
  available: boolean;
  capturedBy?: string;
  entryCount: number;
  sizeBytes: number;
  note?: string;
  warnings?: string[];
}

export interface BackupManifest {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  id: string;
  createdAt: string;
  consistency: {
    database: 'sqlite-vacuum-snapshot';
    files: 'streamed-and-checksummed';
  };
  integrity: {
    algorithm: 'sha256';
    entryCount: number;
    contentBytes: number;
  };
  components: BackupComponent[];
  entries: BackupEntry[];
  exclusions: Array<{ path: string; reason: string }>;
}

export interface BackupMetadata {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  name: string;
  id: string;
  createdAt: string;
  verifiedAt: string;
  sha256: string;
  sizeBytes: number;
  artifactMtimeMs: number;
  components: BackupComponent[];
}

export interface BackupResult {
  name: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string;
  manifest: BackupManifest;
}

export interface BackupHistoryRow {
  name: string;
  sizeBytes: number;
  createdAt: string;
  success: boolean;
  kind: 'recovery_bundle' | 'legacy_database';
  verifiedAt?: string;
  sha256?: string;
  note?: string;
  components?: BackupComponent[];
}

export interface BackupCallbacks {
  snapshotDatabase(destination: string): Promise<void> | void;
  validateDatabase(databasePath: string): Promise<void> | void;
}

export interface CreateBackupOptions extends BackupCallbacks {
  paths?: Partial<BackupPaths>;
  now?: Date;
  prefix?: string;
  retention?: number;
  prune?: boolean;
}

export interface RestoreRequest {
  version: 1;
  id: string;
  artifact: string;
  kind: 'recovery_bundle' | 'legacy_database';
  sha256: string;
  manifestId?: string;
  requestedAt: string;
  requestedBy?: number;
  phase?: string;
  safetyBackup?: string;
}

export interface ApplyRestoreOptions extends BackupCallbacks {
  paths?: Partial<BackupPaths>;
  retention?: number;
}

interface MutableComponent extends BackupComponent {
  warnings: string[];
}

interface SwapState {
  target: string;
  staged: string;
  rollback: string;
  originalNames: string[];
  installedNames: string[];
}

interface ActiveBackup {
  controller: AbortController;
  promise: Promise<BackupResult>;
}

let activeBackup: ActiveBackup | null = null;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('backup_aborted');
}

/** Cooperatively stop and drain the one process-wide backup without touching completed artifacts. */
export async function abortActiveBackup(reason = new Error('backup_aborted')): Promise<boolean> {
  const running = activeBackup;
  if (!running) return false;
  if (!running.controller.signal.aborted) running.controller.abort(reason);
  await running.promise.catch(() => undefined);
  return true;
}

export function backupPaths(overrides: Partial<BackupPaths> = {}): BackupPaths {
  return {
    dataDir: overrides.dataDir || config.dataDir,
    dbPath: overrides.dbPath || config.dbPath,
    filesRoot: overrides.filesRoot || config.filesRoot,
    downloadsDir: overrides.downloadsDir || config.downloadsDir,
    backupDir: overrides.backupDir || path.join(overrides.dataDir || config.dataDir, 'backups'),
  };
}

export function backupRetention(value = process.env.BACKUP_RETENTION): number {
  const parsed = Number(value || DEFAULT_RETENTION);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_RETENTION;
  return Math.min(parsed, 365);
}

function artifactMetadataPath(artifact: string): string {
  return `${artifact}.meta.json`;
}

function artifactChecksumPath(artifact: string): string {
  return `${artifact}.sha256`;
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/.test(value)) throw new Error('invalid_backup_name');
  return value;
}

function safePrefix(value = 'aerie'): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'aerie';
}

function normalizeArchivePath(value: string): string {
  if (!value || value.includes('\0')) throw new Error('unsafe_archive_path');
  if (value.startsWith('/') || value === '..' || value.startsWith('../')) throw new Error('unsafe_archive_path');
  const withoutTrailingSlash = value.replace(/\/$/, '');
  const normalized = path.posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('unsafe_archive_path');
  if (normalized !== withoutTrailingSlash) throw new Error('noncanonical_archive_path');
  return normalized;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function validatePathTopology(paths: BackupPaths): void {
  if (!isInside(paths.dbPath, paths.dataDir)) throw new Error('backup_database_outside_data_dir');
  if (!isInside(paths.backupDir, paths.dataDir)
    || path.dirname(path.resolve(paths.backupDir)) !== path.resolve(paths.dataDir)) {
    throw new Error('backup_directory_outside_data_dir');
  }
  if (isInside(paths.filesRoot, paths.dataDir) || isInside(paths.dataDir, paths.filesRoot)) {
    throw new Error('backup_data_and_files_overlap');
  }
  if ((isInside(paths.dataDir, paths.downloadsDir) && !isInside(paths.downloadsDir, paths.dataDir))
    || (isInside(paths.filesRoot, paths.downloadsDir) && !isInside(paths.downloadsDir, paths.filesRoot))) {
    throw new Error('backup_downloads_contains_primary_storage');
  }
}

function component(
  key: BackupComponent['key'], name: string, archivePrefix: string, available = true, note?: string,
): MutableComponent {
  return { key, name, archivePrefix, available, entryCount: 0, sizeBytes: 0, note, warnings: [] };
}

async function pathExists(value: string): Promise<boolean> {
  try { await fsp.lstat(value); return true; } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function backupStagingKind(name: string): 'work' | 'partial' | null {
  if (BACKUP_WORK_STAGING_NAME.test(name)) return 'work';
  if (PARTIAL_ARTIFACT_STAGING_NAME.test(name)) return 'partial';
  return null;
}

async function cleanupStaleBackupStaging(
  paths: BackupPaths,
  nowMs = Date.now(),
  activePaths: readonly string[] = [],
): Promise<string[]> {
  validatePathTopology(paths);
  const backupDir = path.resolve(paths.backupDir);
  let backupDirStat: fs.Stats;
  try { backupDirStat = await fsp.lstat(backupDir); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!backupDirStat.isDirectory() || backupDirStat.isSymbolicLink()) {
    throw new Error('backup_directory_not_directory');
  }

  const protectedPaths = new Set(activePaths
    .map(value => path.resolve(value))
    .filter(value => path.dirname(value) === backupDir));
  const staleBeforeMs = nowMs - STALE_STAGING_AGE_MS;
  const removed: string[] = [];
  const directory = await fsp.opendir(backupDir);
  let scanned = 0;
  for await (const entry of directory) {
    if (++scanned > MAX_STAGING_ENTRIES_SCANNED || removed.length >= MAX_STAGING_ENTRIES_REMOVED) break;
    const kind = backupStagingKind(entry.name);
    if (!kind || entry.isSymbolicLink()) continue;
    const candidate = path.resolve(backupDir, entry.name);
    if (path.dirname(candidate) !== backupDir || protectedPaths.has(candidate)) continue;

    const stat = await fsp.lstat(candidate).catch(() => null);
    if (!stat || stat.isSymbolicLink() || stat.mtimeMs > staleBeforeMs) continue;
    if ((kind === 'work' && !stat.isDirectory()) || (kind === 'partial' && !stat.isFile())) continue;

    // Recheck the inode immediately before removal so a replaced entry is left alone.
    const confirmed = await fsp.lstat(candidate).catch(() => null);
    if (!confirmed || confirmed.isSymbolicLink() || confirmed.dev !== stat.dev || confirmed.ino !== stat.ino
      || (kind === 'work' && !confirmed.isDirectory()) || (kind === 'partial' && !confirmed.isFile())) continue;
    try {
      if (kind === 'work') await fsp.rm(candidate, { recursive: true, force: true });
      else await fsp.unlink(candidate);
      removed.push(entry.name);
    } catch {
      // Cleanup is opportunistic: one inaccessible orphan must not block a new backup.
    }
  }
  return removed;
}

async function atomicWrite(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporary, data, { flag: 'wx', mode });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteExclusive(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const handle = await fsp.open(temporary, 'wx', mode);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await fsp.link(temporary, file);
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new Error('restore_already_pending');
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function addSimpleEntry(pack: tar.Pack, header: tar.Headers, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortReason(signal!));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try { pack.entry(header, error => finish(error)); } catch (error) { finish(error as Error); }
  });
}

async function addFileEntry(
  pack: tar.Pack, source: string, archivePath: string, stat: fs.Stats, owner: MutableComponent,
  entries: BackupEntry[], signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const header: tar.Headers = {
    name: archivePath,
    type: 'file',
    size: stat.size,
    mode: stat.mode & 0o777,
    mtime: stat.mtime,
  };
  if (stat.size === 0) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      pack.entry(header, Buffer.alloc(0), error => error ? reject(error) : resolve());
    });
  } else {
    const entry = pack.entry(header);
    await pipeline(
      fs.createReadStream(source, { start: 0, end: stat.size - 1 }),
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      entry,
      { signal },
    );
    if (bytes !== stat.size) throw new Error(`source_changed_during_backup:${archivePath}`);
  }
  const after = await fsp.lstat(source);
  signal?.throwIfAborted();
  if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
    || after.mtimeMs !== stat.mtimeMs) {
    throw new Error(`source_changed_during_backup:${archivePath}`);
  }
  entries.push({
    path: archivePath,
    component: owner.key,
    type: 'file',
    size: stat.size,
    mode: stat.mode & 0o777,
    mtime: stat.mtime.toISOString(),
    sha256: hash.digest('hex'),
  });
  owner.entryCount++;
  owner.sizeBytes += stat.size;
}

async function addDirectoryEntry(
  pack: tar.Pack, archivePath: string, stat: fs.Stats, owner: MutableComponent, entries: BackupEntry[],
  signal?: AbortSignal,
): Promise<void> {
  await addSimpleEntry(pack, {
    name: archivePath,
    type: 'directory',
    mode: stat.mode & 0o777,
    mtime: stat.mtime,
  }, signal);
  entries.push({
    path: archivePath,
    component: owner.key,
    type: 'directory',
    size: 0,
    mode: stat.mode & 0o777,
    mtime: stat.mtime.toISOString(),
  });
  owner.entryCount++;
}

function symlinkStaysInComponent(archivePath: string, target: string, prefix: string): boolean {
  if (!target || target.includes('\0') || path.posix.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(archivePath), target));
  return resolved === prefix || resolved.startsWith(prefix + '/');
}

async function addSymlinkEntry(
  pack: tar.Pack, source: string, archivePath: string, stat: fs.Stats, owner: MutableComponent,
  entries: BackupEntry[], signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const target = await fsp.readlink(source);
  signal?.throwIfAborted();
  if (!symlinkStaysInComponent(archivePath, target, owner.archivePrefix)) {
    owner.warnings.push(`Skipped external symlink: ${archivePath}`);
    return;
  }
  await addSimpleEntry(pack, {
    name: archivePath,
    type: 'symlink',
    linkname: target,
    mode: stat.mode & 0o777,
    mtime: stat.mtime,
  }, signal);
  entries.push({
    path: archivePath,
    component: owner.key,
    type: 'symlink',
    size: 0,
    mode: stat.mode & 0o777,
    mtime: stat.mtime.toISOString(),
    linkTarget: target,
  });
  owner.entryCount++;
}

async function archiveTree(
  pack: tar.Pack,
  sourceRoot: string,
  owner: MutableComponent,
  entries: BackupEntry[],
  exclude?: (relative: string) => string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let rootStat: fs.Stats;
  try { rootStat = await fsp.lstat(sourceRoot); } catch (error: any) {
    if (error?.code === 'ENOENT') {
      owner.available = false;
      owner.note = owner.note || 'Source was not present when the backup ran.';
      return;
    }
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error(`backup_source_not_directory:${owner.key}`);

  const visit = async (source: string, relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const excluded = relative ? exclude?.(relative) : undefined;
    if (excluded) {
      owner.warnings.push(`Excluded ${relative}: ${excluded}`);
      return;
    }
    const stat = await fsp.lstat(source);
    const archivePath = relative
      ? `${owner.archivePrefix}/${relative.split(path.sep).join('/')}`
      : owner.archivePrefix;
    if (stat.isDirectory()) {
      await addDirectoryEntry(pack, archivePath, stat, owner, entries, signal);
      const children = await fsp.readdir(source);
      children.sort((a, b) => a.localeCompare(b));
      for (const child of children) await visit(path.join(source, child), relative ? path.join(relative, child) : child);
    } else if (stat.isFile()) {
      await addFileEntry(pack, source, archivePath, stat, owner, entries, signal);
    } else if (stat.isSymbolicLink()) {
      await addSymlinkEntry(pack, source, archivePath, stat, owner, entries, signal);
    } else {
      owner.warnings.push(`Skipped unsupported filesystem entry: ${archivePath}`);
    }
  };
  await visit(sourceRoot, '');
}

function appDataExclusion(paths: BackupPaths, relative: string): string | undefined {
  const top = relative.split(path.sep)[0];
  const dbName = path.basename(paths.dbPath);
  const backupRelative = path.relative(paths.dataDir, paths.backupDir);
  if (backupRelative && backupRelative !== '..' && !backupRelative.startsWith('..' + path.sep)
    && (relative === backupRelative || relative.startsWith(backupRelative + path.sep))) {
    return 'backup artifacts are never recursively archived';
  }
  if (top === 'thumbs') return 'regenerable thumbnail cache';
  if (relative === dbName || relative === `${dbName}-wal` || relative === `${dbName}-shm`) {
    return 'replaced by the WAL-safe database snapshot';
  }
  return undefined;
}

function userFilesExclusion(relative: string): string | undefined {
  const segments = relative.split(path.sep);
  const top = segments[0];
  if (top === '.uploads-tmp' || top === '.sync-uploads-tmp') return 'incomplete upload staging data';
  if (top.startsWith('.aerie-')) return 'Aerie-reserved root staging data';
  if (segments.some(segment => /^\.aerie-(?:stage|input|copy|dav|image-copy|rollback)-/.test(segment))) {
    return 'in-progress atomic filesystem operation';
  }
  return undefined;
}

async function writeRecoveryArchive(
  output: string,
  snapshot: string,
  paths: BackupPaths,
  id: string,
  createdAt: string,
  signal?: AbortSignal,
): Promise<{ manifest: BackupManifest; sha256: string }> {
  signal?.throwIfAborted();
  const pack = tar.pack();
  const archiveHash = crypto.createHash('sha256');
  const outputStream = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
  const archivePipeline = pipeline(
    pack,
    createGzip({ level: 6 }),
    new Transform({
      transform(chunk, _encoding, callback) { archiveHash.update(chunk); callback(null, chunk); },
    }),
    outputStream,
    { signal },
  );
  // Source traversal may still be awaiting an individual tar entry when the
  // destination pipeline aborts. Mark the rejection observed immediately;
  // the try/catch below still awaits and propagates the same failure.
  void archivePipeline.catch(() => undefined);

  const entries: BackupEntry[] = [];
  const database = component('database', 'SQLite database', 'payload/database');
  const userFiles = component('user_files', 'User files', 'payload/files');
  const appData = component(
    'app_data', 'Generated data and application configuration', 'payload/app-data', true,
    'Includes generated media, versions, subtitles, Time Machine data, persisted secrets and other durable /data content when present.',
  );
  const downloads = component('downloads', 'Downloads', 'payload/downloads');
  const runtimeConfig = component(
    'runtime_config', 'Runtime configuration', 'payload/app-data', true,
    'DB-backed settings and configuration files visible inside /data are captured. Host environment files are outside the container and are not available to this backup.',
  );

  try {
    signal?.throwIfAborted();
    const snapshotStat = await fsp.stat(snapshot);
    await addFileEntry(pack, snapshot, DATABASE_ENTRY, snapshotStat, database, entries, signal);
    await archiveTree(pack, paths.filesRoot, userFiles, entries, userFilesExclusion, signal);
    await archiveTree(pack, paths.dataDir, appData, entries, relative => appDataExclusion(paths, relative), signal);

    if (isInside(paths.downloadsDir, paths.dataDir)) {
      downloads.available = await pathExists(paths.downloadsDir);
      downloads.capturedBy = 'app_data';
      downloads.note = downloads.available
        ? 'Captured inside the application-data component.'
        : 'Downloads directory was not present when the backup ran.';
    } else if (isInside(paths.downloadsDir, paths.filesRoot)) {
      downloads.available = await pathExists(paths.downloadsDir);
      downloads.capturedBy = 'user_files';
      downloads.note = downloads.available
        ? 'Captured inside the user-files component.'
        : 'Downloads directory was not present when the backup ran.';
    } else {
      await archiveTree(pack, paths.downloadsDir, downloads, entries, undefined, signal);
    }

    runtimeConfig.available = entries.some(entry =>
      entry.component === 'database' || entry.path === 'payload/app-data/.jwt-secret');
    runtimeConfig.capturedBy = 'database,app_data';

    const contentBytes = entries.reduce((total, entry) => total + entry.size, 0);
    const manifest: BackupManifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      id,
      createdAt,
      consistency: { database: 'sqlite-vacuum-snapshot', files: 'streamed-and-checksummed' },
      integrity: { algorithm: 'sha256', entryCount: entries.length, contentBytes },
      components: [database, userFiles, appData, downloads, runtimeConfig].map(item => ({ ...item })),
      entries,
      exclusions: [
        { path: 'payload/app-data/backups', reason: 'prevents recursive backups' },
        { path: 'payload/app-data/thumbs', reason: 'regenerable cache' },
        { path: 'payload/files/.uploads-tmp', reason: 'incomplete browser uploads' },
        { path: 'payload/files/.sync-uploads-tmp', reason: 'incomplete sync uploads' },
        { path: 'payload/files/.aerie-*', reason: 'Aerie-reserved atomic-write and restore staging data' },
        { path: 'media', reason: 'external read-only media is not owned by Aerie' },
        { path: 'host environment', reason: 'not mounted inside the application container' },
      ],
    };
    signal?.throwIfAborted();
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('backup_manifest_too_large');
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: MANIFEST_NAME, type: 'file', size: manifestBytes.length, mode: 0o600, mtime: new Date(createdAt) },
        manifestBytes, error => error ? reject(error) : resolve());
    });
    signal?.throwIfAborted();
    pack.finalize();
    await archivePipeline;
    return { manifest, sha256: archiveHash.digest('hex') };
  } catch (error) {
    pack.destroy(error as Error);
    await archivePipeline.catch(() => undefined);
    throw error;
  }
}

function parseManifest(bytes: Buffer): BackupManifest {
  let manifest: BackupManifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('backup_manifest_invalid'); }
  if (manifest?.format !== FORMAT || manifest?.version !== FORMAT_VERSION || !Array.isArray(manifest.entries)
    || !Array.isArray(manifest.components) || manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('backup_manifest_unsupported');
  }
  if (manifest.entries.length > 5_000_000) throw new Error('backup_manifest_too_large');
  return manifest;
}

function compareObserved(manifest: BackupManifest, observed: Map<string, BackupEntry>): void {
  if (manifest.integrity.entryCount !== manifest.entries.length) throw new Error('backup_manifest_count_mismatch');
  const expectedBytes = manifest.entries.reduce((total, entry) => total + entry.size, 0);
  if (manifest.integrity.contentBytes !== expectedBytes) throw new Error('backup_manifest_size_mismatch');
  if (observed.size !== manifest.entries.length) throw new Error('backup_entry_count_mismatch');
  const expectedPaths = new Set<string>();
  for (const expected of manifest.entries) {
    const safePath = normalizeArchivePath(expected.path);
    if (expectedPaths.has(safePath)) throw new Error('backup_manifest_duplicate_path');
    expectedPaths.add(safePath);
    const actual = observed.get(safePath);
    if (!actual || actual.type !== expected.type || actual.size !== expected.size
      || (expected.type === 'file' && actual.sha256 !== expected.sha256)
      || (expected.type === 'symlink' && actual.linkTarget !== expected.linkTarget)) {
      throw new Error(`backup_entry_integrity_failed:${safePath}`);
    }
  }
  if (!expectedPaths.has(DATABASE_ENTRY)) throw new Error('backup_database_missing');
}

async function readExpectedChecksum(artifact: string): Promise<string> {
  let raw: string;
  try { raw = await fsp.readFile(artifactChecksumPath(artifact), 'utf8'); } catch { throw new Error('backup_checksum_missing'); }
  const match = raw.trim().match(/^([a-f0-9]{64})(?:\s+\*?.+)?$/i);
  if (!match) throw new Error('backup_checksum_invalid');
  return match[1].toLowerCase();
}

export async function verifyBackupArtifact(
  artifact: string,
  expectedChecksum?: string,
  signal?: AbortSignal,
): Promise<{ manifest: BackupManifest; sha256: string; sizeBytes: number }> {
  signal?.throwIfAborted();
  const stat = await fsp.lstat(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('backup_artifact_not_regular_file');
  const expectedArchiveHash = (expectedChecksum || await readExpectedChecksum(artifact)).toLowerCase();
  const archiveHash = crypto.createHash('sha256');
  const extract = tar.extract();
  const observed = new Map<string, BackupEntry>();
  let manifestBytes: Buffer | null = null;
  let extractionError: Error | null = null;

  extract.on('entry', (header, stream, next) => {
    (async () => {
      const name = normalizeArchivePath(header.name);
      if (name === MANIFEST_NAME) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const data = Buffer.from(chunk);
          size += data.length;
          if (size > MAX_MANIFEST_BYTES) throw new Error('backup_manifest_too_large');
          chunks.push(data);
        }
        manifestBytes = Buffer.concat(chunks);
        next();
        return;
      }
      if (observed.has(name)) throw new Error('backup_duplicate_entry');
      const type = header.type === 'directory' ? 'directory' : header.type === 'symlink' ? 'symlink' : 'file';
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of stream) {
        const data = Buffer.from(chunk);
        size += data.length;
        hash.update(data);
      }
      observed.set(name, {
        path: name,
        component: '',
        type,
        size,
        mode: Number(header.mode || 0) & 0o777,
        mtime: (header.mtime || new Date(0)).toISOString(),
        sha256: type === 'file' ? hash.digest('hex') : undefined,
        linkTarget: type === 'symlink' ? header.linkname : undefined,
      });
      next();
    })().catch(error => {
      extractionError = error instanceof Error ? error : new Error(String(error));
      stream.resume();
      extract.destroy(extractionError);
    });
  });

  try {
    await pipeline(
      fs.createReadStream(artifact),
      new Transform({
        transform(chunk, _encoding, callback) { archiveHash.update(chunk); callback(null, chunk); },
      }),
      createGunzip(),
      extract,
      { signal },
    );
  } catch (error) {
    throw extractionError || error;
  }
  signal?.throwIfAborted();
  if (extractionError) throw extractionError;
  const digest = archiveHash.digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedArchiveHash, 'hex'))) {
    throw new Error('backup_archive_checksum_mismatch');
  }
  if (!manifestBytes) throw new Error('backup_manifest_missing');
  const manifest = parseManifest(manifestBytes);
  compareObserved(manifest, observed);
  return { manifest, sha256: digest, sizeBytes: stat.size };
}

async function writeArtifactMetadata(
  artifact: string, result: { manifest: BackupManifest; sha256: string }, stat: fs.Stats,
): Promise<void> {
  const metadata: BackupMetadata = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: path.basename(artifact),
    id: result.manifest.id,
    createdAt: result.manifest.createdAt,
    verifiedAt: new Date().toISOString(),
    sha256: result.sha256,
    sizeBytes: stat.size,
    artifactMtimeMs: stat.mtimeMs,
    components: result.manifest.components,
  };
  await atomicWrite(artifactMetadataPath(artifact), JSON.stringify(metadata, null, 2) + '\n');
}

async function createBackupUnlocked(options: CreateBackupOptions, signal: AbortSignal): Promise<BackupResult> {
  signal.throwIfAborted();
  const paths = backupPaths(options.paths);
  validatePathTopology(paths);
  const now = options.now || new Date();
  const createdAt = now.toISOString();
  const id = crypto.randomUUID();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const name = `${safePrefix(options.prefix)}-${stamp}-${id.slice(0, 8)}${ARCHIVE_SUFFIX}`;
  await fsp.mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
  const workDir = await fsp.mkdtemp(path.join(paths.backupDir, '.backup-work-'));
  const snapshot = path.join(workDir, 'cloudbox.db');
  const temporaryArtifact = path.join(paths.backupDir, `.${name}.partial-${process.pid}`);
  const artifact = path.join(paths.backupDir, name);
  try {
    signal.throwIfAborted();
    await cleanupStaleBackupStaging(paths, Date.now(), [
      workDir,
      temporaryArtifact,
      `${temporaryArtifact}.sha256`,
    ]);
    signal.throwIfAborted();
    await options.snapshotDatabase(snapshot);
    signal.throwIfAborted();
    await options.validateDatabase(snapshot);
    signal.throwIfAborted();
    const written = await writeRecoveryArchive(temporaryArtifact, snapshot, paths, id, createdAt, signal);
    signal.throwIfAborted();
    await atomicWrite(`${temporaryArtifact}.sha256`, `${written.sha256}  ${name}\n`);
    signal.throwIfAborted();
    await verifyBackupArtifact(temporaryArtifact, written.sha256, signal);
    signal.throwIfAborted();
    // Verification is the commit barrier. Once publication begins, finish the
    // short atomic rename/metadata sequence even if shutdown arrives, so a
    // fully verified bundle is never mistaken for disposable staging data.
    await fsp.rename(`${temporaryArtifact}.sha256`, artifactChecksumPath(artifact));
    await fsp.rename(temporaryArtifact, artifact);
    const stat = await fsp.stat(artifact);
    await writeArtifactMetadata(artifact, written, stat);
    if (options.prune !== false) await pruneBackups(paths, options.retention);
    return { name, sizeBytes: stat.size, createdAt, sha256: written.sha256, manifest: written.manifest };
  } catch (error) {
    await Promise.all([
      fsp.rm(temporaryArtifact, { force: true }),
      fsp.rm(`${temporaryArtifact}.sha256`, { force: true }),
      fsp.rm(artifact, { force: true }),
      fsp.rm(artifactChecksumPath(artifact), { force: true }),
      fsp.rm(artifactMetadataPath(artifact), { force: true }),
    ]).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  if (activeBackup) throw new Error('backup_already_running');
  const controller = new AbortController();
  const promise = createBackupUnlocked(options, controller.signal);
  const run: ActiveBackup = { controller, promise };
  activeBackup = run;
  try {
    return await promise;
  } catch (error) {
    // Stream pipelines surface a generic AbortError. Preserve the explicit
    // shutdown reason so the durable scheduler can release its lease and make
    // the retry immediately due without misclassifying a real backup failure.
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    if (activeBackup === run) activeBackup = null;
  }
}

export async function pruneBackups(pathOptions: Partial<BackupPaths> = {}, retention?: number): Promise<string[]> {
  const paths = backupPaths(pathOptions);
  const keep = retention === undefined ? backupRetention() : backupRetention(String(retention));
  let names: string[];
  try { names = await fsp.readdir(paths.backupDir); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const artifacts = (await Promise.all(names
    .filter(name => name.endsWith(ARCHIVE_SUFFIX) || name.endsWith('.db'))
    .map(async name => {
      const artifact = path.join(paths.backupDir, name);
      const stat = await fsp.lstat(artifact).catch(() => null);
      return stat?.isFile() && !stat.isSymbolicLink() ? { name, mtimeMs: stat.mtimeMs } : null;
    })))
    .filter((item): item is { name: string; mtimeMs: number } => !!item)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed: string[] = [];
  for (const { name } of artifacts.slice(keep)) {
    const artifact = path.join(paths.backupDir, name);
    await Promise.all([
      fsp.rm(artifact, { force: true }),
      fsp.rm(artifactChecksumPath(artifact), { force: true }),
      fsp.rm(artifactMetadataPath(artifact), { force: true }),
    ]);
    removed.push(name);
  }
  return removed;
}

async function readMetadata(artifact: string, stat: fs.Stats): Promise<BackupMetadata | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(artifactMetadataPath(artifact), 'utf8')) as BackupMetadata;
    if (parsed.format !== FORMAT || parsed.version !== FORMAT_VERSION || parsed.name !== path.basename(artifact)
      || parsed.sizeBytes !== stat.size) return null;
    if (!/^[a-f0-9]{64}$/.test(parsed.sha256) || !Array.isArray(parsed.components)) return null;
    if (await readExpectedChecksum(artifact) !== parsed.sha256) return null;
    return parsed;
  } catch { return null; }
}

export async function listBackupHistory(pathOptions: Partial<BackupPaths> = {}): Promise<BackupHistoryRow[]> {
  const paths = backupPaths(pathOptions);
  let names: string[];
  try { names = await fsp.readdir(paths.backupDir); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows: BackupHistoryRow[] = [];
  for (const name of names) {
    if (!name.endsWith(ARCHIVE_SUFFIX) && !name.endsWith('.db')) continue;
    const artifact = path.join(paths.backupDir, name);
    let stat: fs.Stats;
    try { stat = await fsp.lstat(artifact); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (name.endsWith(ARCHIVE_SUFFIX)) {
      const metadata = await readMetadata(artifact, stat);
      rows.push({
        name,
        sizeBytes: stat.size,
        createdAt: metadata?.createdAt || stat.mtime.toISOString(),
        success: !!metadata,
        kind: 'recovery_bundle',
        verifiedAt: metadata?.verifiedAt,
        sha256: metadata?.sha256,
        components: metadata?.components,
        note: metadata ? 'Archive and entry checksums were verified when created.' : 'Integrity metadata is missing or stale.',
      });
    } else {
      rows.push({
        name,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        success: false,
        kind: 'legacy_database',
        note: 'Legacy database-only snapshot; user files and generated data are not included.',
      });
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function backupStatuses(pathOptions: Partial<BackupPaths> = {}): Promise<BackupStatus[]> {
  const history = await listBackupHistory(pathOptions);
  const latest = history.find(row => row.kind === 'recovery_bundle');
  const captured = latest?.components?.filter(item => item.available && item.key !== 'runtime_config')
    .map(item => item.name.toLowerCase()).join(', ');
  return [
    {
      key: 'db',
      name: 'Aerie recovery bundle',
      lastRun: latest?.createdAt || null,
      success: !!latest?.success,
      sizeBytes: latest?.sizeBytes,
      note: latest
        ? `${latest.success ? 'Verified' : 'Unverified'} portable archive${captured ? ` containing ${captured}` : ''}.`
        : 'No comprehensive recovery bundle exists yet — run one now.',
    },
    {
      key: 'offsite',
      name: 'Off-site copy',
      lastRun: null,
      success: false,
      nextRun: null,
      note: 'Not configured. Copy the .aerie-backup.tar.gz, .sha256 and .meta.json files to independent storage.',
    },
  ];
}

function markerPaths(paths: BackupPaths) {
  return {
    pending: path.join(paths.backupDir, 'pending-restore.json'),
    inProgress: path.join(paths.backupDir, 'restore-in-progress.json'),
    maintenance: path.join(paths.backupDir, 'restore-maintenance.json'),
  };
}

async function ensureNoRestoreInProgress(paths: BackupPaths): Promise<void> {
  const markers = markerPaths(paths);
  if (await pathExists(markers.pending)) throw new Error('restore_already_pending');
  if (await pathExists(markers.inProgress)) throw new Error('restore_already_in_progress');
  if (await pathExists(markers.maintenance)) throw new Error('restore_requires_manual_recovery');
}

export async function stageRestore(
  nameValue: string,
  requestedBy: number | undefined,
  options: { paths?: Partial<BackupPaths>; validateDatabase?: (databasePath: string) => Promise<void> | void } = {},
): Promise<RestoreRequest> {
  const paths = backupPaths(options.paths);
  validatePathTopology(paths);
  await fsp.mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
  await ensureNoRestoreInProgress(paths);
  const name = safeName(String(nameValue || ''));
  const artifact = path.join(paths.backupDir, name);
  const resolved = path.resolve(artifact);
  if (path.dirname(resolved) !== path.resolve(paths.backupDir)) throw new Error('invalid_backup_name');
  const stat = await fsp.lstat(artifact).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('backup_not_found');

  let request: RestoreRequest;
  if (name.endsWith(ARCHIVE_SUFFIX)) {
    const verified = await verifyBackupArtifact(artifact);
    request = {
      version: 1,
      id: crypto.randomUUID(),
      artifact: name,
      kind: 'recovery_bundle',
      sha256: verified.sha256,
      manifestId: verified.manifest.id,
      requestedAt: new Date().toISOString(),
      requestedBy,
    };
  } else if (name.endsWith('.db')) {
    if (!options.validateDatabase) throw new Error('legacy_restore_validation_unavailable');
    await options.validateDatabase(artifact);
    request = {
      version: 1,
      id: crypto.randomUUID(),
      artifact: name,
      kind: 'legacy_database',
      sha256: await sha256File(artifact),
      requestedAt: new Date().toISOString(),
      requestedBy,
    };
  } else {
    throw new Error('backup_not_found');
  }
  await atomicWriteExclusive(markerPaths(paths).pending, JSON.stringify(request, null, 2) + '\n');
  return request;
}

async function readRestoreRequest(file: string): Promise<RestoreRequest> {
  let request: RestoreRequest;
  try { request = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { throw new Error('restore_request_invalid'); }
  if (request?.version !== 1 || !request.id || !request.sha256 || !request.artifact
    || !['recovery_bundle', 'legacy_database'].includes(request.kind)) throw new Error('restore_request_invalid');
  safeName(request.artifact);
  if (!/^[a-f0-9]{64}$/i.test(request.sha256)) throw new Error('restore_request_invalid');
  return request;
}

function extractionDestination(
  name: string,
  roots: { database: string; files: string; appData: string; downloads: string },
): { destination: string; componentPrefix: string } | null {
  const mappings = [
    [DATABASE_ENTRY, roots.database, 'payload/database'],
    ['payload/files', roots.files, 'payload/files'],
    ['payload/app-data', roots.appData, 'payload/app-data'],
    ['payload/downloads', roots.downloads, 'payload/downloads'],
  ] as const;
  for (const [prefix, destinationRoot, componentPrefix] of mappings) {
    if (name !== prefix && !name.startsWith(prefix + '/')) continue;
    const relative = name === prefix ? '' : name.slice(prefix.length + 1);
    const destination = relative ? path.join(destinationRoot, ...relative.split('/')) : destinationRoot;
    const containment = path.relative(destinationRoot, destination);
    if (containment.startsWith('..') || path.isAbsolute(containment)) throw new Error('unsafe_restore_path');
    return { destination, componentPrefix };
  }
  return null;
}

async function assertNoSymlinkParent(root: string, destination: string): Promise<void> {
  if (path.resolve(root) === path.resolve(destination)) return;
  const relative = path.relative(root, path.dirname(destination));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_restore_path');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error('unsafe_restore_symlink_parent');
  }
}

async function extractVerifiedArchive(
  artifact: string,
  verified: { manifest: BackupManifest; sha256: string },
  roots: { database: string; files: string; appData: string; downloads: string },
): Promise<void> {
  const expected = new Map(verified.manifest.entries.map(entry => [entry.path, entry]));
  const seen = new Set<string>();
  const archiveHash = crypto.createHash('sha256');
  const extract = tar.extract();
  let extractionError: Error | null = null;
  const directoryMetadata: Array<{ destination: string; mode: number; mtime: Date }> = [];

  extract.on('entry', (header, stream, next) => {
    (async () => {
      const name = normalizeArchivePath(header.name);
      if (name === MANIFEST_NAME) { for await (const _chunk of stream) { /* discard */ } next(); return; }
      if (seen.has(name)) throw new Error('backup_duplicate_entry');
      seen.add(name);
      const spec = expected.get(name);
      if (!spec) throw new Error(`backup_unmanifested_entry:${name}`);
      const mapped = extractionDestination(name, roots);
      if (!mapped) throw new Error(`backup_unknown_component:${name}`);
      const destinationRoot = mapped.destination === roots.database ? path.dirname(roots.database)
        : name.startsWith('payload/files') ? roots.files
          : name.startsWith('payload/app-data') ? roots.appData : roots.downloads;
      await assertNoSymlinkParent(destinationRoot, mapped.destination);
      const mode = spec.mode & 0o777;
      if (spec.type === 'directory') {
        for await (const _chunk of stream) { /* directory entries have no payload */ }
        await fsp.mkdir(mapped.destination, { recursive: true, mode: 0o700 });
        directoryMetadata.push({ destination: mapped.destination, mode, mtime: new Date(spec.mtime) });
      } else if (spec.type === 'symlink') {
        for await (const _chunk of stream) { /* symlink entries have no payload */ }
        if (!spec.linkTarget || !symlinkStaysInComponent(name, spec.linkTarget, mapped.componentPrefix)) {
          throw new Error('unsafe_restore_symlink');
        }
        await fsp.mkdir(path.dirname(mapped.destination), { recursive: true, mode: 0o700 });
        await fsp.symlink(spec.linkTarget, mapped.destination);
      } else {
        await fsp.mkdir(path.dirname(mapped.destination), { recursive: true, mode: 0o700 });
        const hash = crypto.createHash('sha256');
        let size = 0;
        await pipeline(
          stream,
          new Transform({
            transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); },
          }),
          fs.createWriteStream(mapped.destination, { flags: 'wx', mode: mode || 0o600 }),
        );
        if (size !== spec.size || hash.digest('hex') !== spec.sha256) throw new Error(`backup_entry_integrity_failed:${name}`);
      }
      if (spec.type === 'file') {
        await fsp.chmod(mapped.destination, mode).catch(() => undefined);
        const mtime = new Date(spec.mtime);
        if (Number.isFinite(mtime.getTime())) await fsp.utimes(mapped.destination, mtime, mtime).catch(() => undefined);
      }
      next();
    })().catch(error => {
      extractionError = error instanceof Error ? error : new Error(String(error));
      stream.resume();
      extract.destroy(extractionError);
    });
  });

  try {
    await pipeline(
      fs.createReadStream(artifact),
      new Transform({
        transform(chunk, _encoding, callback) { archiveHash.update(chunk); callback(null, chunk); },
      }),
      createGunzip(),
      extract,
    );
  } catch (error) { throw extractionError || error; }
  if (extractionError) throw extractionError;
  if (archiveHash.digest('hex') !== verified.sha256) throw new Error('backup_archive_checksum_mismatch');
  if (seen.size !== expected.size) throw new Error('backup_entry_count_mismatch');
  directoryMetadata.sort((a, b) => b.destination.length - a.destination.length);
  for (const item of directoryMetadata) {
    await fsp.chmod(item.destination, item.mode).catch(() => undefined);
    if (Number.isFinite(item.mtime.getTime())) {
      await fsp.utimes(item.destination, item.mtime, item.mtime).catch(() => undefined);
    }
  }
}

async function beginDirectorySwap(
  target: string,
  staged: string,
  token: string,
  reservedNames: Set<string>,
): Promise<SwapState> {
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });
  await fsp.mkdir(staged, { recursive: true, mode: 0o700 });
  const rollback = path.join(target, `.aerie-restore-rollback-${token}`);
  await fsp.mkdir(rollback, { mode: 0o700 });
  const originalNames = (await fsp.readdir(target)).filter(name =>
    name !== path.basename(staged) && name !== path.basename(rollback) && !reservedNames.has(name));
  const installedNames: string[] = [];
  try {
    for (const name of originalNames) await fsp.rename(path.join(target, name), path.join(rollback, name));
    for (const name of await fsp.readdir(staged)) {
      await fsp.rename(path.join(staged, name), path.join(target, name));
      installedNames.push(name);
    }
    return { target, staged, rollback, originalNames, installedNames };
  } catch (error) {
    (error as any).swapState = { target, staged, rollback, originalNames, installedNames } satisfies SwapState;
    throw error;
  }
}

async function rollbackDirectorySwap(state: SwapState): Promise<void> {
  await fsp.mkdir(state.staged, { recursive: true, mode: 0o700 });
  for (const name of state.installedNames.slice().reverse()) {
    const current = path.join(state.target, name);
    if (await pathExists(current)) await fsp.rename(current, path.join(state.staged, name));
  }
  for (const name of state.originalNames) {
    const previous = path.join(state.rollback, name);
    if (await pathExists(previous)) await fsp.rename(previous, path.join(state.target, name));
  }
  await fsp.rm(state.rollback, { recursive: true, force: true });
}

async function finishDirectorySwap(state: SwapState): Promise<void> {
  await fsp.rm(state.rollback, { recursive: true, force: true });
  await fsp.rm(state.staged, { recursive: true, force: true });
}

async function replaceDatabase(paths: BackupPaths, stagedDb: string, workDir: string): Promise<() => Promise<void>> {
  const rollbackDb = path.join(workDir, 'live-database.rollback');
  const rollbackWal = path.join(workDir, 'live-database.wal.rollback');
  const rollbackShm = path.join(workDir, 'live-database.shm.rollback');
  try {
    if (await pathExists(paths.dbPath)) await fsp.rename(paths.dbPath, rollbackDb);
    if (await pathExists(paths.dbPath + '-wal')) await fsp.rename(paths.dbPath + '-wal', rollbackWal);
    if (await pathExists(paths.dbPath + '-shm')) await fsp.rename(paths.dbPath + '-shm', rollbackShm);
    await fsp.rename(stagedDb, paths.dbPath);
  } catch (error) {
    try {
      await fsp.rm(paths.dbPath, { force: true });
      if (await pathExists(rollbackDb)) await fsp.rename(rollbackDb, paths.dbPath);
      if (await pathExists(rollbackWal)) await fsp.rename(rollbackWal, paths.dbPath + '-wal');
      if (await pathExists(rollbackShm)) await fsp.rename(rollbackShm, paths.dbPath + '-shm');
    } catch (rollbackError) {
      (error as any).restoreRollbackFailed = rollbackError;
    }
    throw error;
  }
  return async () => {
    await fsp.rm(paths.dbPath, { force: true });
    if (await pathExists(rollbackDb)) await fsp.rename(rollbackDb, paths.dbPath);
    if (await pathExists(rollbackWal)) await fsp.rename(rollbackWal, paths.dbPath + '-wal');
    if (await pathExists(rollbackShm)) await fsp.rename(rollbackShm, paths.dbPath + '-shm');
  };
}

async function applyLegacyDatabase(
  artifact: string, request: RestoreRequest, paths: BackupPaths, validateDatabase: BackupCallbacks['validateDatabase'], workDir: string,
): Promise<() => Promise<void>> {
  if (await sha256File(artifact) !== request.sha256) throw new Error('backup_archive_checksum_mismatch');
  await validateDatabase(artifact);
  const staged = path.join(workDir, 'legacy-cloudbox.db');
  await fsp.copyFile(artifact, staged, fs.constants.COPYFILE_EXCL);
  await validateDatabase(staged);
  const rollback = await replaceDatabase(paths, staged, workDir);
  try { await validateDatabase(paths.dbPath); } catch (error) { await rollback(); throw error; }
  return rollback;
}

export async function applyPendingRestore(options: ApplyRestoreOptions): Promise<{
  applied: boolean; artifact?: string; safetyBackup?: string;
}> {
  const paths = backupPaths(options.paths);
  validatePathTopology(paths);
  const markers = markerPaths(paths);
  if (await pathExists(markers.maintenance)) throw new Error('restore_requires_manual_recovery');
  if (!(await pathExists(markers.pending))) {
    if (await pathExists(markers.inProgress)) throw new Error('restore_interrupted_requires_recovery');
    return { applied: false };
  }
  await fsp.rename(markers.pending, markers.inProgress);
  const request = await readRestoreRequest(markers.inProgress);
  const artifact = path.join(paths.backupDir, safeName(request.artifact));
  const token = request.id.replace(/[^a-f0-9]/gi, '').slice(0, 16);
  const workDir = path.join(paths.backupDir, `.restore-work-${token}`);
  const stagedDb = path.join(workDir, 'database', 'cloudbox.db');
  const stagedAppData = path.join(workDir, 'app-data');
  const stagedFiles = path.join(paths.filesRoot, `.aerie-restore-stage-${token}`);
  const downloadsExternal = !isInside(paths.downloadsDir, paths.dataDir) && !isInside(paths.downloadsDir, paths.filesRoot);
  const stagedDownloads = downloadsExternal
    ? path.join(paths.downloadsDir, `.aerie-restore-stage-${token}`)
    : path.join(workDir, 'downloads-unused');
  const swaps: SwapState[] = [];
  let dbRollback: (() => Promise<void>) | null = null;
  let safetyBackup: BackupResult | null = null;
  let workCreated = false;
  let stagedFilesCreated = false;
  let stagedDownloadsCreated = false;

  try {
    request.phase = 'validating';
    await atomicWrite(markers.inProgress, JSON.stringify(request, null, 2) + '\n');
    const verified = request.kind === 'recovery_bundle' ? await verifyBackupArtifact(artifact, request.sha256) : null;
    if (verified && verified.manifest.id !== request.manifestId) throw new Error('backup_manifest_changed');
    if (!verified && await sha256File(artifact) !== request.sha256) throw new Error('backup_archive_checksum_mismatch');

    request.phase = 'creating_safety_backup';
    await atomicWrite(markers.inProgress, JSON.stringify(request, null, 2) + '\n');
    safetyBackup = await createBackup({ ...options, paths, prefix: 'pre-restore', prune: false });
    request.safetyBackup = safetyBackup.name;
    request.phase = 'extracting';
    await atomicWrite(markers.inProgress, JSON.stringify(request, null, 2) + '\n');

    await fsp.mkdir(workDir, { mode: 0o700 });
    workCreated = true;
    await fsp.mkdir(paths.filesRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(stagedFiles, { mode: 0o700 });
    stagedFilesCreated = true;
    if (downloadsExternal) {
      await fsp.mkdir(paths.downloadsDir, { recursive: true, mode: 0o700 });
      await fsp.mkdir(stagedDownloads, { mode: 0o700 });
      stagedDownloadsCreated = true;
    }
    if (request.kind === 'legacy_database') {
      dbRollback = await applyLegacyDatabase(artifact, request, paths, options.validateDatabase, workDir);
    } else {
      const manifest = verified!.manifest;
      await extractVerifiedArchive(artifact, verified!, {
        database: stagedDb,
        files: stagedFiles,
        appData: stagedAppData,
        downloads: stagedDownloads,
      });
      await options.validateDatabase(stagedDb);
      request.phase = 'swapping';
      await atomicWrite(markers.inProgress, JSON.stringify(request, null, 2) + '\n');

      const available = new Map(manifest.components.map(item => [item.key, item.available]));
      const swapDirectory = async (target: string, staged: string, reserved: Set<string>) => {
        try { swaps.push(await beginDirectorySwap(target, staged, token, reserved)); }
        catch (error: any) {
          if (error?.swapState) swaps.push(error.swapState as SwapState);
          throw error;
        }
      };
      if (available.get('user_files')) {
        await swapDirectory(paths.filesRoot, stagedFiles, new Set());
      }
      if (downloadsExternal && available.get('downloads')) {
        await swapDirectory(paths.downloadsDir, stagedDownloads, new Set());
      }
      if (available.get('app_data')) {
        await swapDirectory(paths.dataDir, stagedAppData, new Set([
          path.basename(paths.backupDir), 'thumbs', path.basename(paths.dbPath),
          path.basename(paths.dbPath) + '-wal', path.basename(paths.dbPath) + '-shm',
        ]));
      }
      dbRollback = await replaceDatabase(paths, stagedDb, workDir);
      await options.validateDatabase(paths.dbPath);
    }

    request.phase = 'complete';
    const appliedMarker = path.join(paths.backupDir, `restore-applied-${request.id}.json`);
    await atomicWrite(markers.inProgress, JSON.stringify(request, null, 2) + '\n');
    await fsp.rename(markers.inProgress, appliedMarker);
    // The applied marker is the commit point. Cleanup must never roll a
    // successful restore back after one rollback directory was already pruned.
    const cleanup = await Promise.allSettled([
      ...swaps.map(swap => finishDirectorySwap(swap)),
      fsp.rm(workDir, { recursive: true, force: true }),
      pruneBackups(paths, options.retention),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') console.warn('[restore cleanup]', result.reason);
    }
    return { applied: true, artifact: request.artifact, safetyBackup: safetyBackup.name };
  } catch (error: any) {
    let rollbackFailed: unknown = error?.restoreRollbackFailed || null;
    if (dbRollback) await dbRollback().catch(failure => { rollbackFailed = failure; });
    for (const swap of swaps.slice().reverse()) {
      await rollbackDirectorySwap(swap).catch(failure => { rollbackFailed ||= failure; });
    }
    if (!rollbackFailed) {
      await Promise.all([
        stagedFilesCreated ? fsp.rm(stagedFiles, { recursive: true, force: true }) : Promise.resolve(),
        stagedDownloadsCreated ? fsp.rm(stagedDownloads, { recursive: true, force: true }) : Promise.resolve(),
        workCreated ? fsp.rm(workDir, { recursive: true, force: true }) : Promise.resolve(),
      ]).catch(() => undefined);
    }
    const failureRecord = {
      ...request,
      phase: rollbackFailed ? 'maintenance_required' : 'rolled_back',
      failedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
      rollbackError: rollbackFailed ? String((rollbackFailed as any)?.message || rollbackFailed).slice(0, 500) : undefined,
    };
    const failurePath = rollbackFailed
      ? markers.maintenance
      : path.join(paths.backupDir, `restore-failed-${request.id}.json`);
    await atomicWrite(failurePath, JSON.stringify(failureRecord, null, 2) + '\n').catch(() => undefined);
    await fsp.rm(markers.inProgress, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const backupInternals = {
  ARCHIVE_SUFFIX,
  DATABASE_ENTRY,
  STALE_STAGING_AGE_MS,
  cleanupStaleBackupStaging,
  markerPaths,
};
