const crypto = require('node:crypto');
const { spawn: spawnChild, spawnSync: spawnSyncChild } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readBoundedJson } = require('./bounded-json');
const { normalizeOrigin, normalizeServerUrl } = require('./server-url');
const {
  loadPinnedReleaseKey,
  safeFilename,
  verifyReleaseSignature,
} = require('./release-signature');

const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_SIDECAR_BYTES = 32 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 30_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STATE_SCHEMA = 1;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/i;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const UPDATE_CACHE_FILE = /^([1-9]\d*)-[a-f0-9]{16}-.+\.(?:AppImage|exe)(?:\.part)?$/i;
const MAX_UPDATE_CACHE_ENTRIES = 512;
const MAX_FALLBACK_DIRECTORY_ENTRIES = 512;
const LINUX_ORPHAN_CLEANUP_MIN_BUILD = 10;
const ROLLBACK_APPIMAGE_FILE = /^Aerie\.rollback-(0|[1-9]\d*)-(0|[1-9]\d*)-[a-f0-9]{8}\.AppImage$/;
const FAILED_APPIMAGE_FILE = /^Aerie\.failed-(0|[1-9]\d*)-(0|[1-9]\d*)\.AppImage$/;
const INSTALL_FAILURE_APPIMAGE_FILE = /^Aerie\.AppImage\.failed-(0|[1-9]\d*)-[a-f0-9]{8}$/;
const LEGACY_DESKTOP_ENTRY_FILE = /^aerie\.previous-(0|[1-9]\d*)-[a-f0-9]{8}\.desktop$/;

function semverParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new Error('invalid_update_version');
  const withoutBuild = value.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map(part => Number(part));
  if (core.some(part => !Number.isSafeInteger(part) || part < 0)) throw new Error('invalid_update_version');
  while (core.length < 4) core.push(0);
  const prerelease = dash < 0 ? null : withoutBuild.slice(dash + 1).split('.').map(part => (
    /^\d+$/.test(part) && Number.isSafeInteger(Number(part)) ? Number(part) : part
  ));
  return { core, prerelease };
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv !== 'number') return -1;
    if (typeof av !== 'number' && typeof bv === 'number') return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function expectedPlatform(platform) {
  if (platform === 'win32') return { key: 'windows', extension: /\.exe$/i, installer: /setup/i };
  if (platform === 'linux') return { key: 'linux', extension: /\.AppImage$/i, installer: null };
  throw new Error('desktop_updates_unsupported');
}

function exactDownloadPath(filename) {
  return `/downloads/${encodeURIComponent(safeFilename(filename))}`;
}

function validateDiscoveryItem(item, platform) {
  const expected = expectedPlatform(platform);
  if (!item || typeof item !== 'object' || item.key !== expected.key || item.available !== true
      || item.verified !== true || item.signatureVerified !== true) throw new Error('verified_update_unavailable');
  const filename = safeFilename(item.filename);
  if (!expected.extension.test(filename) || (expected.installer && !expected.installer.test(filename))) {
    throw new Error('invalid_update_installer');
  }
  if (item.url !== exactDownloadPath(filename)) throw new Error('invalid_update_url');
  const sizeBytes = Number(item.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_INSTALLER_BYTES) {
    throw new Error('invalid_update_size');
  }
  return { ...item, filename, sizeBytes };
}

function releaseUrl(serverUrl, filename, suffix = '') {
  const origin = normalizeOrigin(serverUrl);
  const url = new URL(`${exactDownloadPath(filename)}${suffix}`, origin);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_update_url');
  }
  return url.toString();
}

async function fetchJsonExact(fetchImpl, url, maxBytes) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('update_metadata_unavailable');
  }
  return readBoundedJson(response, { maxBytes, idleMs: 5000 });
}

function matchingCatalogFields(catalog, release) {
  const build = catalog.build == null ? null : Number(catalog.build);
  return catalog.filename === release.filename
    && catalog.version === release.version
    && build === release.build
    && String(catalog.sha256 || '').toLowerCase() === release.sha256
    && Number(catalog.sizeBytes) === release.sizeBytes
    && catalog.minServerVersion === release.minServerVersion
    && catalog.publishedAt === release.publishedAt
    && catalog.notes === release.notes
    && catalog.signatureAlgorithm === release.signatureAlgorithm
    && String(catalog.signatureKeyId || '').toLowerCase() === release.signatureKeyId
    && catalog.signature === release.signature;
}

async function discoverSignedRelease({
  serverUrl,
  currentVersion,
  currentBuild,
  highestAcceptedBuild = currentBuild,
  platform = process.platform,
  pinnedKey,
  fetchImpl = fetch,
}) {
  const server = normalizeServerUrl(serverUrl);
  const catalogUrl = `${server}/api/apps`;
  const catalog = await fetchJsonExact(fetchImpl, catalogUrl, MAX_CATALOG_BYTES);
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.platforms)
      || catalog.platforms.length > 16) throw new Error('invalid_release_catalog');
  const key = expectedPlatform(platform).key;
  const raw = catalog.platforms.find(item => item?.key === key);
  if (!raw?.available) return null;
  const item = validateDiscoveryItem(raw, platform);
  const sidecarUrl = releaseUrl(server, item.filename, '.release.json');
  const sidecar = await fetchJsonExact(fetchImpl, sidecarUrl, MAX_SIDECAR_BYTES);
  if (!sidecar || sidecar.schemaVersion !== 1 || !sidecar.release || typeof sidecar.release !== 'object') {
    throw new Error('invalid_release_sidecar');
  }
  const release = verifyReleaseSignature(sidecar.release, pinnedKey);
  if (release.platform !== key || !matchingCatalogFields(item, release)) {
    throw new Error('release_catalog_signature_mismatch');
  }
  const expected = expectedPlatform(platform);
  if (!expected.extension.test(release.filename) || (expected.installer && !expected.installer.test(release.filename))) {
    throw new Error('invalid_update_installer');
  }
  if (release.sizeBytes > MAX_INSTALLER_BYTES) throw new Error('invalid_update_size');
  if (!Number.isSafeInteger(release.build)) throw new Error('invalid_update_build');
  // The build is the global replay boundary. A higher signed build may repair
  // the current semantic version, but it can never authorize a version downgrade.
  if (compareVersions(release.version, currentVersion) < 0
      || release.build <= currentBuild || release.build <= highestAcceptedBuild) return null;
  const health = await fetchJsonExact(fetchImpl, `${server}/api/health`, 4096);
  if (!health || (health.name !== 'Aerie' && health.name !== 'CloudBox' && health.compat !== 'CloudBox')
      || typeof health.version !== 'string' || !VERSION.test(health.version)) {
    throw new Error('invalid_update_server_health');
  }
  if (compareVersions(health.version, release.minServerVersion) < 0) {
    throw new Error('update_requires_newer_server');
  }
  return {
    ...release,
    server,
    downloadUrl: releaseUrl(server, release.filename),
    sidecarUrl,
  };
}

async function idleRead(reader, idleMs = DOWNLOAD_IDLE_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('update_download_idle_timeout')), idleMs);
    timer.unref?.();
    reader.read().then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function downloadPlan(response, offset, total) {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('compressed_update_download');
  const range = response.headers.get('content-range');
  let append = false;
  let expectedBytes = total;
  if (response.status === 206) {
    const match = CONTENT_RANGE.exec(range || '');
    if (offset <= 0 || offset >= total || !match
        || Number(match[1]) !== offset || Number(match[2]) !== total - 1 || Number(match[3]) !== total) {
      throw new Error('invalid_update_download_range');
    }
    append = true;
    expectedBytes = total - offset;
  } else if (response.status === 200) {
    if (range) throw new Error('unexpected_update_download_range');
  } else throw new Error('invalid_update_download_status');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) {
    throw new Error('invalid_update_download_length');
  }
  return { append, expectedBytes };
}

async function lstatRegular(file, expectedSize = null) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (expectedSize !== null && stat.size !== expectedSize)) {
    throw new Error('unsafe_update_file');
  }
  return stat;
}

async function hashFile(file, expectedSize = null) {
  await lstatRegular(file, expectedSize);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function equalHash(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left || '')) || !/^[a-f0-9]{64}$/.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function ensureDirectory(dir, mode = 0o700) {
  await fsp.mkdir(dir, { recursive: true, mode });
  const stat = await fsp.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_update_directory');
  if (process.platform !== 'win32') await fsp.chmod(dir, mode);
}

async function writeAll(handle, value) {
  const buffer = Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('update_download_write_failed');
    offset += bytesWritten;
  }
}

async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  try {
    const handle = await fsp.open(dir, fs.constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* best effort on filesystems that cannot fsync directories */ }
}

async function verifyStagedRelease(file, release, pinnedKey) {
  verifyReleaseSignature(release, pinnedKey);
  const digest = await hashFile(file, release.sizeBytes);
  if (!equalHash(digest, release.sha256)) throw new Error('staged_update_hash_mismatch');
  return true;
}

async function pruneUpdateCache(updatesDir, currentBuild) {
  if (!Number.isSafeInteger(currentBuild) || currentBuild < 0) return 0;
  const root = path.resolve(updatesDir);
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return 0; }
  let removed = 0;
  for (const entry of entries.slice(0, MAX_UPDATE_CACHE_ENTRIES)) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const match = UPDATE_CACHE_FILE.exec(entry.name);
    const build = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(build) || build > currentBuild) continue;
    const candidate = path.join(root, entry.name);
    if (path.dirname(candidate) !== root) continue;
    try {
      const stat = await fsp.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fsp.unlink(candidate);
      removed += 1;
    } catch { /* cache cleanup is best effort */ }
  }
  if (removed) await syncDirectory(root);
  return removed;
}

async function downloadSignedRelease({ release, pinnedKey, updatesDir, fetchImpl = fetch, onProgress = () => {} }) {
  verifyReleaseSignature(release, pinnedKey);
  if (!Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0 || release.sizeBytes > MAX_INSTALLER_BYTES) {
    throw new Error('invalid_update_size');
  }
  const downloadUrl = releaseUrl(release.server, release.filename);
  if (release.downloadUrl !== downloadUrl) throw new Error('invalid_update_url');
  await ensureDirectory(updatesDir);
  const prefix = `${release.build}-${release.sha256.slice(0, 16)}-${release.filename}`;
  const partFile = path.join(updatesDir, `${prefix}.part`);
  const finalFile = path.join(updatesDir, prefix);
  if (path.dirname(partFile) !== path.resolve(updatesDir) || path.dirname(finalFile) !== path.resolve(updatesDir)) {
    throw new Error('unsafe_update_path');
  }

  try {
    if (equalHash(await hashFile(finalFile, release.sizeBytes), release.sha256)) return finalFile;
    await fsp.unlink(finalFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { await fsp.unlink(finalFile); } catch { /* invalid cached artifact */ }
    }
  }

  let offset = 0;
  try {
    const stat = await lstatRegular(partFile);
    if (stat.size <= release.sizeBytes) offset = stat.size;
    else await fsp.unlink(partFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { await fsp.unlink(partFile); } catch { /* replace unsafe partial below */ }
    }
  }
  if (offset === release.sizeBytes) {
    const digest = await hashFile(partFile, release.sizeBytes);
    if (equalHash(digest, release.sha256)) {
      await fsp.rename(partFile, finalFile);
      await syncDirectory(updatesDir);
      return finalFile;
    }
    await fsp.unlink(partFile);
    offset = 0;
  }

  let response;
  let restarted = false;
  while (true) {
    const headers = { accept: 'application/octet-stream', 'accept-encoding': 'identity', 'cache-control': 'no-cache' };
    if (offset > 0) headers.range = `bytes=${offset}-`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('update_download_connect_timeout')), 10_000);
    timer.unref?.();
    try { response = await fetchImpl(downloadUrl, { redirect: 'error', headers, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (response.status !== 416 || offset <= 0 || restarted) break;
    await response.body?.cancel().catch(() => {});
    await fsp.unlink(partFile).catch(() => {});
    offset = 0;
    restarted = true;
  }
  if (response.redirected || (response.url && response.url !== release.downloadUrl)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('redirected_update_download');
  }
  let plan;
  try { plan = downloadPlan(response, offset, release.sizeBytes); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  if (!response.body) throw new Error('empty_update_download');
  if (!plan.append) offset = 0;

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow
    | (plan.append ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
  const output = await fsp.open(partFile, flags, 0o600);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await idleRead(reader);
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > plan.expectedBytes - received) throw new Error('update_download_too_large');
      await writeAll(output, value);
      received += value.byteLength;
      onProgress({ receivedBytes: offset + received, totalBytes: release.sizeBytes });
    }
    if (received !== plan.expectedBytes) throw new Error('incomplete_update_download');
    await output.sync();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* */ }
    await output.close();
  }
  await lstatRegular(partFile, release.sizeBytes);
  const digest = await hashFile(partFile, release.sizeBytes);
  if (!equalHash(digest, release.sha256)) {
    await fsp.unlink(partFile).catch(() => {});
    throw new Error('update_download_hash_mismatch');
  }
  await fsp.rename(partFile, finalFile);
  if (process.platform !== 'win32') await fsp.chmod(finalFile, 0o700);
  await syncDirectory(updatesDir);
  return finalFile;
}

function linuxDataHome(env = process.env, homedir = os.homedir()) {
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) return path.resolve(env.XDG_DATA_HOME);
  return path.join(homedir, '.local', 'share');
}

async function writableCurrentAppImage(env = process.env) {
  if (!env.APPIMAGE || !path.isAbsolute(env.APPIMAGE)) return null;
  try {
    const candidate = await fsp.realpath(env.APPIMAGE);
    await lstatRegular(candidate);
    await fsp.access(path.dirname(candidate), fs.constants.W_OK);
    return candidate;
  } catch { return null; }
}

const FUSE2_LIBRARY_PATHS = [
  '/lib/libfuse.so.2',
  '/lib64/libfuse.so.2',
  '/usr/lib/libfuse.so.2',
  '/usr/lib64/libfuse.so.2',
  '/lib/x86_64-linux-gnu/libfuse.so.2',
  '/usr/lib/x86_64-linux-gnu/libfuse.so.2',
  '/lib/aarch64-linux-gnu/libfuse.so.2',
  '/usr/lib/aarch64-linux-gnu/libfuse.so.2',
];

function appImageNeedsExtractAndRun(env = process.env, {
  platform = process.platform,
  hasFuseDevice,
  hasFuse2Library,
  spawnSyncImpl = spawnSyncChild,
} = {}) {
  if (platform !== 'linux') return false;
  if (env.AERIE_APPIMAGE_EXTRACT_AND_RUN === '0') return false;
  if (env.AERIE_APPIMAGE_EXTRACT_AND_RUN === '1' || env.APPIMAGE_EXTRACT_AND_RUN === '1') return true;

  let deviceAvailable = hasFuseDevice;
  if (deviceAvailable == null) {
    try {
      fs.accessSync('/dev/fuse', fs.constants.R_OK | fs.constants.W_OK);
      deviceAvailable = true;
    } catch { deviceAvailable = false; }
  }

  let libraryAvailable = hasFuse2Library;
  if (libraryAvailable == null) {
    libraryAvailable = FUSE2_LIBRARY_PATHS.some(candidate => {
      try { fs.accessSync(candidate, fs.constants.R_OK); return true; }
      catch { return false; }
    });
    if (!libraryAvailable) {
      try {
        const report = spawnSyncImpl('ldconfig', ['-p'], {
          encoding: 'utf8', timeout: 2000, windowsHide: true, maxBuffer: 1024 * 1024,
        });
        libraryAvailable = report.status === 0 && /(?:^|\s)libfuse\.so\.2(?:\s|$)/m.test(String(report.stdout || ''));
      } catch { libraryAvailable = false; }
    }
  }
  return !(deviceAvailable && libraryAvailable);
}

function safeDesktopPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('unsafe_desktop_entry_path');
  }
  return value;
}

// Exec values have two escaping layers: the desktop-entry string parser and
// then the command-line parser. The freedesktop specification consequently
// requires four backslashes for one literal backslash, two before the other
// quoted metacharacters, and %% for a literal percent/field-code prefix.
function desktopExecQuote(value) {
  let encoded = '';
  for (const character of safeDesktopPath(value)) {
    if (character === '\\') encoded += '\\'.repeat(4);
    else if (character === '"' || character === '`' || character === '$') encoded += '\\'.repeat(2) + character;
    else if (character === '%') encoded += '%%';
    else encoded += character;
  }
  return `"${encoded}"`;
}

function desktopStringValue(value) {
  return safeDesktopPath(value).replaceAll('\\', '\\'.repeat(2));
}

function desktopEntryPayload(executable, { extractAndRun = false } = {}) {
  const launch = extractAndRun
    ? `env APPIMAGE_EXTRACT_AND_RUN=1 ${desktopExecQuote(executable)} %U`
    : `${desktopExecQuote(executable)} %U`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Aerie',
    'Comment=Your private cloud',
    `TryExec=${desktopStringValue(executable)}`,
    `Exec=${launch}`,
    'Terminal=false',
    'Categories=Network;Utility;',
    'MimeType=x-scheme-handler/aerie;',
    'StartupWMClass=Aerie',
    '',
  ].join('\n');
}

async function writeDesktopEntry(dataHome, executable, { extractAndRun = false } = {}) {
  const applications = path.join(dataHome, 'applications');
  await ensureDirectory(applications, 0o700);
  const target = path.join(applications, 'aerie.desktop');
  const temporary = path.join(applications, `.aerie.desktop.new-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
  const payload = desktopEntryPayload(executable, { extractAndRun });
  await fsp.writeFile(temporary, payload, { flag: 'wx', mode: 0o600 });
  const handle = await fsp.open(temporary, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, target);
  await syncDirectory(applications);
  return target;
}

async function preserveDesktopEntry(dataHome, managedDir) {
  const source = path.join(dataHome, 'applications', 'aerie.desktop');
  try {
    const stat = await lstatRegular(source);
    if (stat.size <= 0 || stat.size > 64 * 1024) return null;
    await ensureDirectory(managedDir, 0o700);
    const backup = path.join(managedDir,
      `aerie.previous-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.desktop`);
    await fsp.copyFile(source, backup, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(backup, 0o600);
    const handle = await fsp.open(backup, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const sha256 = await hashFile(backup, stat.size);
    return { targetPath: source, backupPath: backup, sha256 };
  } catch { return null; }
}

// The AppImage runtime strips APPIMAGE when APPIMAGE_EXTRACT_AND_RUN is used on
// some Linux systems. In that case, recover the managed target only when the
// previous updater state, the launcher, the on-disk hash, and the executable
// still running as our parent all identify the exact same updater-owned file.
// A normal extracted build has no such parent identity and stays on the safer
// migration path that preserves its existing launcher.
async function verifiedManagedCurrentAppImage({
  previousInstall,
  currentVersion,
  currentBuild,
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  runningExecutablePath = platform === 'linux' && Number.isSafeInteger(process.ppid) && process.ppid > 1
    ? `/proc/${process.ppid}/exe` : null,
}) {
  try {
    if (platform !== 'linux' || !runningExecutablePath || !previousInstall
        || previousInstall.managed !== true || previousInstall.extractAndRun !== true
        || previousInstall.installedVersion !== currentVersion
        || previousInstall.installedBuild !== currentBuild
        || !/^[a-f0-9]{64}$/.test(previousInstall.installedSha256 || '')) return null;

    const dataHome = linuxDataHome(env, homedir);
    const managedDir = path.join(dataHome, 'aerie-desktop');
    const target = path.join(managedDir, 'Aerie.AppImage');
    const applications = path.join(dataHome, 'applications');
    const desktopEntry = path.join(applications, 'aerie.desktop');
    if (!canonicalAbsolutePath(dataHome) || !canonicalAbsolutePath(previousInstall.targetPath)
        || previousInstall.targetPath !== target || previousInstall.desktopEntry !== desktopEntry) return null;

    const managedStat = await fsp.lstat(managedDir);
    const applicationsStat = await fsp.lstat(applications);
    if (!managedStat.isDirectory() || managedStat.isSymbolicLink()
        || !applicationsStat.isDirectory() || applicationsStat.isSymbolicLink()
        || await fsp.realpath(managedDir) !== managedDir
        || await fsp.realpath(applications) !== applications
        || await fsp.realpath(target) !== target
        || await fsp.realpath(runningExecutablePath) !== target) return null;

    const targetStat = await verifiedCleanupFile(target, previousInstall.installedSha256);
    const runningStat = await fsp.stat(runningExecutablePath);
    if (targetStat.nlink !== 1 || !runningStat.isFile() || runningStat.nlink !== 1
        || !sameFileIdentity(targetStat, runningStat)
        || !await exactRegularFile(desktopEntry, desktopEntryPayload(target, { extractAndRun: true }))) return null;

    // Recheck both identities after hashing and launcher validation so a
    // concurrent path replacement cannot authorize the subsequent swap.
    const targetAfter = await lstatRegular(target, targetStat.size);
    const runningAfter = await fsp.stat(runningExecutablePath);
    if (targetAfter.nlink !== 1 || runningAfter.nlink !== 1
        || !sameFileIdentity(targetStat, targetAfter)
        || !sameFileIdentity(targetAfter, runningAfter)) return null;
    await fsp.access(managedDir, fs.constants.W_OK);
    return target;
  } catch { return null; }
}

async function copyVerified(source, destination, release, pinnedKey) {
  verifyReleaseSignature(release, pinnedKey);
  await verifyStagedRelease(source, release, pinnedKey);
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o700);
  const handle = await fsp.open(destination, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  const digest = await hashFile(destination, release.sizeBytes);
  if (!equalHash(digest, release.sha256)) {
    await fsp.unlink(destination).catch(() => {});
    throw new Error('update_copy_hash_mismatch');
  }
}

async function installLinuxAppImage({
  stagedFile,
  release,
  pinnedKey,
  currentVersion,
  currentBuild,
  env = process.env,
  homedir = os.homedir(),
  previousInstall = null,
  platform = process.platform,
  runningExecutablePath,
  extractAndRun = appImageNeedsExtractAndRun(env),
}) {
  await verifyStagedRelease(stagedFile, release, pinnedKey);
  const dataHome = linuxDataHome(env, homedir);
  const current = await writableCurrentAppImage(env) || await verifiedManagedCurrentAppImage({
    previousInstall,
    currentVersion,
    currentBuild,
    env,
    homedir,
    platform,
    runningExecutablePath,
  });
  const managedDir = path.join(dataHome, 'aerie-desktop');
  const managedTarget = path.join(managedDir, 'Aerie.AppImage');
  const target = current || managedTarget;
  const managed = !current || path.resolve(target) === path.resolve(managedTarget);
  const legacyDesktopEntry = current ? null : await preserveDesktopEntry(dataHome, managedDir);
  await ensureDirectory(path.dirname(target), 0o700);
  const temporary = path.join(path.dirname(target), `.Aerie.AppImage.new-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
  await copyVerified(stagedFile, temporary, release, pinnedKey);

  let backupPath = null;
  let backupSha256 = null;
  let hadTarget = false;
  try {
    await lstatRegular(target);
    hadTarget = true;
    backupSha256 = await hashFile(target);
    backupPath = path.join(path.dirname(target),
      `Aerie.rollback-${currentBuild}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.AppImage`);
    await fsp.rename(target, backupPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  try {
    await fsp.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    if (hadTarget && backupPath) await fsp.rename(backupPath, target).catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  try { await verifyStagedRelease(target, release, pinnedKey); }
  catch (error) {
    const failed = `${target}.failed-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.rename(target, failed).catch(() => {});
    if (hadTarget && backupPath) await fsp.rename(backupPath, target).catch(() => {});
    else await fsp.unlink(failed).catch(() => {});
    await syncDirectory(path.dirname(target));
    throw error;
  }
  let desktopEntry = null;
  if (managed) desktopEntry = await writeDesktopEntry(dataHome, target, { extractAndRun: Boolean(extractAndRun) });
  return {
    targetPath: target,
    backupPath,
    backupSha256,
    backupVersion: currentVersion,
    backupBuild: currentBuild,
    installedVersion: release.version,
    installedBuild: release.build,
    installedSha256: release.sha256,
    managed,
    extractAndRun: Boolean(extractAndRun),
    desktopEntry,
    legacyDesktopEntry,
  };
}

function canonicalAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
    && !/[\x00-\x1f\x7f]/.test(value) && path.resolve(value) === value;
}

function ownedRollbackBuild(file) {
  const name = path.basename(file);
  const match = ROLLBACK_APPIMAGE_FILE.exec(name) || FAILED_APPIMAGE_FILE.exec(name);
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : null;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function verifiedCleanupFile(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('unsafe_rollback_cleanup');
  const before = await lstatRegular(file);
  const digest = await hashFile(file, before.size);
  const after = await lstatRegular(file, before.size);
  if (!equalHash(digest, expectedSha256) || !sameFileIdentity(before, after)) {
    throw new Error('unsafe_rollback_cleanup');
  }
  return after;
}

async function removeVerifiedCleanupFile(file, expectedSha256) {
  try {
    const verified = await verifiedCleanupFile(file, expectedSha256);
    const beforeUnlink = await lstatRegular(file, verified.size);
    if (!sameFileIdentity(verified, beforeUnlink)) return false;
    await fsp.unlink(file);
    return true;
  } catch { return false; }
}

// The state containing the new rollback is persisted before this is called. Cleanup is
// deliberately best effort: each ambiguous candidate stays in place, while cleanup can
// never turn a successful update into a failed one.
async function pruneSupersededLinuxRollback(previousInstall, currentInstall) {
  try {
    if (!previousInstall || !currentInstall || previousInstall.managed !== true || currentInstall.managed !== true
        || !canonicalAbsolutePath(previousInstall.targetPath)
        || !canonicalAbsolutePath(currentInstall.targetPath)
        || previousInstall.targetPath !== currentInstall.targetPath) return 0;

    const target = currentInstall.targetPath;
    const managedDir = path.dirname(target);
    if (path.basename(target) !== 'Aerie.AppImage' || path.basename(managedDir) !== 'aerie-desktop') return 0;
    const managedStat = await fsp.lstat(managedDir);
    if (!managedStat.isDirectory() || managedStat.isSymbolicLink()
        || await fsp.realpath(managedDir) !== managedDir) return 0;

    if (!canonicalAbsolutePath(currentInstall.backupPath)
        || path.dirname(currentInstall.backupPath) !== managedDir
        || ownedRollbackBuild(currentInstall.backupPath) !== currentInstall.backupBuild
        || !Number.isSafeInteger(currentInstall.backupBuild) || currentInstall.backupBuild < 0
        || currentInstall.backupBuild !== previousInstall.installedBuild
        || currentInstall.backupVersion !== previousInstall.installedVersion
        || !equalHash(currentInstall.backupSha256, previousInstall.installedSha256)) return 0;

    // Never remove an older fallback unless the newly retained immediate rollback is
    // still a regular, non-symlink file containing exactly the version recorded in state.
    await verifiedCleanupFile(currentInstall.backupPath, currentInstall.backupSha256);

    let removed = 0;
    if (previousInstall.backupPath) {
      const ownedBackup = canonicalAbsolutePath(previousInstall.backupPath)
        && path.dirname(previousInstall.backupPath) === managedDir
        && previousInstall.backupPath !== target
        && previousInstall.backupPath !== currentInstall.backupPath
        && ownedRollbackBuild(previousInstall.backupPath) === previousInstall.backupBuild
        && Number.isSafeInteger(previousInstall.backupBuild) && previousInstall.backupBuild >= 0;
      if (ownedBackup
          && await removeVerifiedCleanupFile(previousInstall.backupPath, previousInstall.backupSha256)) removed += 1;
    }
    if (previousInstall.legacyDesktopEntry) {
      const legacy = previousInstall.legacyDesktopEntry;
      const expectedDesktopEntry = path.join(path.dirname(managedDir), 'applications', 'aerie.desktop');
      const ownedLegacy = canonicalAbsolutePath(legacy.targetPath) && legacy.targetPath === expectedDesktopEntry
        && currentInstall.desktopEntry === expectedDesktopEntry
        && canonicalAbsolutePath(legacy.backupPath)
        && path.dirname(legacy.backupPath) === managedDir
        && legacy.backupPath !== target && legacy.backupPath !== currentInstall.backupPath
        && legacy.backupPath !== previousInstall.backupPath
        && LEGACY_DESKTOP_ENTRY_FILE.test(path.basename(legacy.backupPath));
      if (ownedLegacy && await removeVerifiedCleanupFile(legacy.backupPath, legacy.sha256)) removed += 1;
    }
    if (removed) await syncDirectory(managedDir);
    return removed;
  } catch { return 0; }
}

async function readBoundedFallbackEntries(dir) {
  const handle = await fsp.opendir(dir);
  const entries = [];
  try {
    while (entries.length <= MAX_FALLBACK_DIRECTORY_ENTRIES) {
      const entry = await handle.read();
      if (!entry) return entries;
      entries.push(entry);
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function exactRegularFile(file, expected) {
  const expectedBytes = Buffer.from(expected);
  const before = await lstatRegular(file, expectedBytes.length);
  if (before.nlink !== 1) return false;
  const actual = await fsp.readFile(file);
  const after = await lstatRegular(file, expectedBytes.length);
  return actual.equals(expectedBytes) && after.nlink === 1 && sameFileIdentity(before, after);
}

async function removeOwnedOrphan(file) {
  try {
    const before = await lstatRegular(file);
    if (before.nlink !== 1) return false;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
    let opened;
    try { opened = await handle.stat(); } finally { await handle.close(); }
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) return false;
    const beforeUnlink = await lstatRegular(file, before.size);
    if (beforeUnlink.nlink !== 1 || !sameFileIdentity(before, beforeUnlink)) return false;
    await fsp.unlink(file);
    return true;
  } catch { return false; }
}

// A completed update can persist its new recovery state before best-effort cleanup of
// older fallbacks finishes. On the first launch of every eligible Linux build, reserve
// only updater-created filename namespaces and refuse to scan until the complete current
// recovery chain and launcher have been verified.
async function pruneLinuxUpdaterOrphans(install, currentBuild) {
  const result = { validated: false, removed: 0 };
  try {
    if (currentBuild < LINUX_ORPHAN_CLEANUP_MIN_BUILD || !install || install.managed !== true
        || install.installedBuild !== currentBuild || !canonicalAbsolutePath(install.targetPath)
        || path.basename(install.targetPath) !== 'Aerie.AppImage') return result;
    const target = install.targetPath;
    const managedDir = path.dirname(target);
    if (path.basename(managedDir) !== 'aerie-desktop') return result;
    const managedStat = await fsp.lstat(managedDir);
    if (!managedStat.isDirectory() || managedStat.isSymbolicLink()
        || await fsp.realpath(managedDir) !== managedDir) return result;

    if (!canonicalAbsolutePath(install.backupPath) || path.dirname(install.backupPath) !== managedDir
        || install.backupPath === target || !Number.isSafeInteger(install.backupBuild)
        || install.backupBuild < 0 || install.backupBuild >= currentBuild
        || ownedRollbackBuild(install.backupPath) !== install.backupBuild) return result;
    const targetStat = await verifiedCleanupFile(target, install.installedSha256);
    const backupStat = await verifiedCleanupFile(install.backupPath, install.backupSha256);
    if (targetStat.nlink !== 1 || backupStat.nlink !== 1) return result;

    const applications = path.join(path.dirname(managedDir), 'applications');
    const expectedDesktopEntry = path.join(applications, 'aerie.desktop');
    if (install.desktopEntry !== expectedDesktopEntry || typeof install.extractAndRun !== 'boolean') return result;
    const applicationsStat = await fsp.lstat(applications);
    if (!applicationsStat.isDirectory() || applicationsStat.isSymbolicLink()
        || await fsp.realpath(applications) !== applications) return result;
    if (!await exactRegularFile(expectedDesktopEntry,
      desktopEntryPayload(target, { extractAndRun: install.extractAndRun }))) return result;
    result.validated = true;

    const entries = await readBoundedFallbackEntries(managedDir);
    if (!entries) return result;
    const trackedLegacy = canonicalAbsolutePath(install.legacyDesktopEntry?.backupPath)
      ? install.legacyDesktopEntry.backupPath : null;
    for (const entry of entries) {
      const candidate = path.join(managedDir, entry.name);
      if (candidate === target || candidate === install.backupPath || candidate === trackedLegacy) continue;
      const rollbackBuild = ownedRollbackBuild(candidate);
      const obsoleteRollback = rollbackBuild !== null && rollbackBuild < install.backupBuild;
      const obsoleteInstallFailure = INSTALL_FAILURE_APPIMAGE_FILE.test(entry.name);
      const obsoleteLegacy = LEGACY_DESKTOP_ENTRY_FILE.test(entry.name);
      if (!obsoleteRollback && !obsoleteInstallFailure && !obsoleteLegacy) continue;
      if (await removeOwnedOrphan(candidate)) result.removed += 1;
    }
    if (result.removed) await syncDirectory(managedDir);
    return result;
  } catch { return result; }
}

function linuxRelaunchOptions(install, env = process.env) {
  if (!install || typeof install !== 'object' || !path.isAbsolute(install.targetPath || '')) {
    throw new Error('desktop_update_install_invalid');
  }
  if (install.extractAndRun) env.APPIMAGE_EXTRACT_AND_RUN = '1';
  else delete env.APPIMAGE_EXTRACT_AND_RUN;
  return { execPath: install.targetPath, args: [] };
}

async function rollbackLinuxAppImage(install) {
  if (!install || typeof install !== 'object' || !path.isAbsolute(install.targetPath || '')) {
    throw new Error('desktop_update_rollback_unavailable');
  }
  if (!install.backupPath && install.legacyDesktopEntry) {
    const legacy = install.legacyDesktopEntry;
    if (!path.isAbsolute(legacy.targetPath || '') || !path.isAbsolute(legacy.backupPath || '')
        || !/^[a-f0-9]{64}$/.test(legacy.sha256 || '')
        || !equalHash(await hashFile(legacy.backupPath), legacy.sha256)
        || !equalHash(await hashFile(install.targetPath), install.installedSha256)) {
      throw new Error('desktop_update_rollback_verification_failed');
    }
    const temporary = `${legacy.targetPath}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.copyFile(legacy.backupPath, temporary, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(temporary, 0o600);
    const handle = await fsp.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (!equalHash(await hashFile(temporary), legacy.sha256)) {
      await fsp.unlink(temporary).catch(() => {});
      throw new Error('desktop_update_rollback_verification_failed');
    }
    await fsp.rename(temporary, legacy.targetPath);
    await syncDirectory(path.dirname(legacy.targetPath));
    return { ...install, legacyRestored: true };
  }
  if (!path.isAbsolute(install.backupPath || '') || !/^[a-f0-9]{64}$/.test(install.backupSha256 || '')) {
    throw new Error('desktop_update_rollback_unavailable');
  }
  const currentHash = await hashFile(install.targetPath);
  const backupHash = await hashFile(install.backupPath);
  if (!equalHash(currentHash, install.installedSha256) || !equalHash(backupHash, install.backupSha256)) {
    throw new Error('desktop_update_rollback_verification_failed');
  }
  const failedPath = path.join(path.dirname(install.targetPath),
    `Aerie.failed-${install.installedBuild}-${Date.now()}.AppImage`);
  await fsp.rename(install.targetPath, failedPath);
  try { await fsp.rename(install.backupPath, install.targetPath); }
  catch (error) {
    await fsp.rename(failedPath, install.targetPath).catch(() => {});
    throw error;
  }
  await fsp.chmod(install.targetPath, 0o700);
  await syncDirectory(path.dirname(install.targetPath));
  if (!equalHash(await hashFile(install.targetPath), install.backupSha256)) {
    throw new Error('desktop_update_rollback_verification_failed');
  }
  return {
    ...install,
    backupPath: failedPath,
    backupSha256: currentHash,
    backupVersion: install.installedVersion,
    backupBuild: install.installedBuild,
    installedVersion: install.backupVersion,
    installedBuild: install.backupBuild,
    installedSha256: backupHash,
  };
}

function emptyState(currentBuild) {
  return {
    schemaVersion: STATE_SCHEMA,
    highestAcceptedBuild: currentBuild,
    lastCheckAt: 0,
    linuxInstall: null,
    linuxOrphanCleanupBuild: 0,
  };
}

async function readState(file, currentBuild) {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('invalid_updater_state');
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || parsed.schemaVersion !== STATE_SCHEMA) throw new Error('invalid_updater_state');
    return {
      schemaVersion: STATE_SCHEMA,
      highestAcceptedBuild: Math.max(currentBuild,
        Number.isSafeInteger(parsed.highestAcceptedBuild) ? parsed.highestAcceptedBuild : 0),
      lastCheckAt: Number.isSafeInteger(parsed.lastCheckAt) && parsed.lastCheckAt >= 0 ? parsed.lastCheckAt : 0,
      linuxInstall: parsed.linuxInstall && typeof parsed.linuxInstall === 'object' ? parsed.linuxInstall : null,
      linuxOrphanCleanupBuild: Number.isSafeInteger(parsed.linuxOrphanCleanupBuild)
        && parsed.linuxOrphanCleanupBuild >= 0 ? parsed.linuxOrphanCleanupBuild : 0,
    };
  } catch { return emptyState(currentBuild); }
}

async function writeState(file, state) {
  await ensureDirectory(path.dirname(file));
  const temporary = `${file}.new-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const handle = await fsp.open(temporary, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function friendlyUpdateError(error) {
  const code = String(error?.message || 'desktop_update_failed');
  const known = {
    desktop_updates_unsupported: 'Updates are available in the Windows and Linux desktop apps.',
    release_signature_invalid: 'The release signature is invalid, so Aerie refused the update.',
    release_signature_key_mismatch: 'The release was not signed by this Aerie app’s trusted release key.',
    invalid_release_public_key: 'This build does not contain a valid Aerie release key.',
    update_download_hash_mismatch: 'The downloaded installer did not match its signed checksum and was removed.',
    staged_update_hash_mismatch: 'The saved installer no longer matches its signed checksum.',
    update_requires_newer_server: 'Update the Aerie server first; this desktop release needs a newer server version.',
  };
  return known[code] || 'Aerie could not securely verify or download this update. Nothing was installed.';
}

function createDesktopUpdater({
  app,
  dialog,
  shell,
  getWindow,
  getServerUrl,
  currentBuild,
  pinnedKeyPath,
  fetchImpl = fetch,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  onProgress = () => {},
  spawnImpl = spawnChild,
  beforeInstall = async () => {},
}) {
  if (!Number.isSafeInteger(currentBuild) || currentBuild < 0) throw new Error('invalid_current_desktop_build');
  const currentVersion = app.getVersion();
  semverParts(currentVersion);
  const stateFile = path.join(app.getPath('userData'), 'desktop-updater.json');
  const updatesDir = path.join(app.getPath('userData'), 'updates');
  let state = emptyState(currentBuild);
  let pinnedKey = null;
  let busy = null;
  let periodic = null;

  const show = options => {
    const window = getWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  function getPinnedKey() {
    if (!pinnedKey) pinnedKey = loadPinnedReleaseKey(pinnedKeyPath);
    return pinnedKey;
  }

  async function persist() { await writeState(stateFile, state); }

  async function initialize() {
    state = await readState(stateFile, currentBuild);
    if (state.highestAcceptedBuild < currentBuild) state.highestAcceptedBuild = currentBuild;
    await pruneUpdateCache(updatesDir, currentBuild);
    await persist();
    if (platform === 'linux' && currentBuild >= LINUX_ORPHAN_CLEANUP_MIN_BUILD
        && state.linuxOrphanCleanupBuild < currentBuild) {
      const cleanup = await pruneLinuxUpdaterOrphans(state.linuxInstall, currentBuild);
      if (cleanup.validated) {
        const previousCleanupBuild = state.linuxOrphanCleanupBuild;
        state.linuxOrphanCleanupBuild = currentBuild;
        try { await persist(); }
        catch { state.linuxOrphanCleanupBuild = previousCleanupBuild; }
      }
    }
    return status();
  }

  function status() {
    return {
      platform,
      currentVersion,
      currentBuild,
      checking: Boolean(busy),
      canRollback: platform === 'linux'
        && Boolean(state.linuxInstall?.backupPath || state.linuxInstall?.legacyDesktopEntry),
      lastCheckAt: state.lastCheckAt || null,
    };
  }

  async function performCheck(interactive) {
    const serverUrl = getServerUrl();
    if (!serverUrl) {
      if (interactive) await show({ type: 'info', title: 'Connect Aerie first',
        message: 'Connect this app to your Aerie server before checking for updates.' });
      return { status: 'not-configured' };
    }
    try {
      const release = await discoverSignedRelease({
        serverUrl,
        currentVersion,
        currentBuild,
        highestAcceptedBuild: state.highestAcceptedBuild,
        platform,
        pinnedKey: getPinnedKey(),
        fetchImpl,
      });
      state.lastCheckAt = Date.now();
      await persist();
      if (!release) {
        if (interactive) await show({ type: 'info', title: 'Aerie is up to date',
          message: `You already have the latest trusted release (${currentVersion}, build ${currentBuild}).` });
        return { status: 'up-to-date', currentVersion, currentBuild };
      }
      const first = await show({
        type: 'question',
        title: `Aerie ${release.version} is available`,
        message: `Download the signed ${formatSize(release.sizeBytes)} update?`,
        detail: `${release.notes}\n\nAerie will verify its publisher signature and SHA-256 checksum before offering installation.`,
        buttons: ['Download update', 'Not now'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (first.response !== 0) return { status: 'available', version: release.version, build: release.build };
      const stagedFile = await downloadSignedRelease({
        release,
        pinnedKey: getPinnedKey(),
        updatesDir,
        fetchImpl,
        onProgress,
      });
      onProgress({ receivedBytes: release.sizeBytes, totalBytes: release.sizeBytes, complete: true });
      const action = platform === 'win32' ? 'Update and restart' : 'Install and restart';
      const second = await show({
        type: 'question',
        title: 'Verified update ready',
        message: `Aerie ${release.version} passed its signature and checksum checks.`,
        detail: platform === 'win32'
          ? 'After you confirm, Aerie will close, run its verified updater automatically, preserve your settings, and start the new version.'
          : 'Aerie will atomically install the verified AppImage, keep the safest available rollback, and restart.',
        buttons: [action, 'Later'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (second.response !== 0) return { status: 'downloaded', version: release.version, build: release.build };

      // Treat both the signature and the content hash as one-time capabilities:
      // check them again immediately before crossing into installer execution.
      await verifyStagedRelease(stagedFile, release, getPinnedKey());
      if (platform === 'win32') {
        const installer = spawnImpl(stagedFile, ['/S', '--updated', '--force-run'], {
          shell: false, detached: true, stdio: 'ignore', windowsHide: true,
        });
        await new Promise((resolve, reject) => {
          installer.once('error', reject);
          installer.once('spawn', resolve);
        });
        installer.unref();
        await beforeInstall().catch(() => {});
        app.quit();
        return { status: 'installer-launched', version: release.version, build: release.build };
      }
      const previousLinuxInstall = state.linuxInstall;
      state.linuxInstall = await installLinuxAppImage({
        stagedFile,
        release,
        pinnedKey: getPinnedKey(),
        currentVersion,
        currentBuild,
        env,
        homedir,
        previousInstall: previousLinuxInstall,
        platform,
      });
      await persist();
      await pruneSupersededLinuxRollback(previousLinuxInstall, state.linuxInstall);
      await beforeInstall().catch(() => {});
      app.relaunch(linuxRelaunchOptions(state.linuxInstall, env));
      app.exit(0);
      return { status: 'installed', version: release.version, build: release.build };
    } catch (error) {
      if (interactive) await show({ type: 'error', title: 'Update not installed',
        message: friendlyUpdateError(error), detail: `Safety check: ${String(error?.message || 'unknown_error')}` });
      return { status: 'error', error: String(error?.message || 'desktop_update_failed') };
    } finally {
      onProgress({ receivedBytes: 0, totalBytes: 0, complete: true });
    }
  }

  function checkAndPrompt(interactive = true) {
    if (busy) return busy;
    busy = performCheck(Boolean(interactive)).finally(() => { busy = null; });
    return busy;
  }

  async function rollbackAndPrompt() {
    if (platform !== 'linux'
        || (!state.linuxInstall?.backupPath && !state.linuxInstall?.legacyDesktopEntry)) {
      await show({ type: 'info', title: 'No rollback available',
        message: 'Aerie has not retained a previous AppImage on this computer.' });
      return { status: 'unavailable' };
    }
    try {
      const choice = await show({
        type: 'warning', title: 'Roll back Aerie?',
        message: `Return to Aerie ${state.linuxInstall.backupVersion} (build ${state.linuxInstall.backupBuild})?`,
        detail: 'Your server settings, account, and synced files are stored separately and will be preserved.',
        buttons: ['Roll back and restart', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (choice.response !== 0) return { status: 'cancelled' };
      const rolledBack = await rollbackLinuxAppImage(state.linuxInstall);
      if (rolledBack.legacyRestored) {
        state.linuxInstall = null;
        await persist();
        await show({ type: 'info', title: 'Previous launcher restored',
          message: 'Aerie will close now. Open Aerie again to use the preserved extracted installation.' });
        await beforeInstall().catch(() => {});
        app.quit();
        return { status: 'rolled-back' };
      }
      state.linuxInstall = rolledBack;
      await persist();
      app.relaunch(linuxRelaunchOptions(state.linuxInstall, env));
      app.exit(0);
      return { status: 'rolled-back' };
    } catch (error) {
      await show({ type: 'error', title: 'Rollback stopped', message: 'The retained AppImage did not pass verification, so Aerie left the current app unchanged.' });
      return { status: 'error', error: String(error?.message || 'desktop_update_rollback_failed') };
    }
  }

  function schedule() {
    const dueIn = Math.max(15_000, CHECK_INTERVAL_MS - Math.max(0, Date.now() - (state.lastCheckAt || 0)));
    const startup = setTimeout(() => checkAndPrompt(false), dueIn);
    startup.unref?.();
    periodic = setInterval(() => checkAndPrompt(false), CHECK_INTERVAL_MS);
    periodic.unref?.();
  }

  function shutdown() {
    if (periodic) clearInterval(periodic);
    periodic = null;
  }

  return { initialize, status, checkAndPrompt, rollbackAndPrompt, schedule, shutdown };
}

module.exports = {
  CHECK_INTERVAL_MS,
  appImageNeedsExtractAndRun,
  compareVersions,
  createDesktopUpdater,
  discoverSignedRelease,
  downloadPlan,
  downloadSignedRelease,
  desktopExecQuote,
  exactDownloadPath,
  installLinuxAppImage,
  linuxDataHome,
  linuxRelaunchOptions,
  pruneLinuxUpdaterOrphans,
  pruneSupersededLinuxRollback,
  pruneUpdateCache,
  readState,
  releaseUrl,
  rollbackLinuxAppImage,
  verifyStagedRelease,
  verifiedManagedCurrentAppImage,
  writeState,
  writeAll,
};
