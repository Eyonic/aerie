const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  appImageNeedsExtractAndRun,
  compareVersions,
  createDesktopUpdater,
  desktopExecQuote,
  discoverSignedRelease,
  downloadPlan,
  downloadSignedRelease,
  installLinuxAppImage,
  linuxRelaunchOptions,
  pruneLinuxUpdaterOrphans,
  pruneSupersededLinuxRollback,
  pruneUpdateCache,
  rollbackLinuxAppImage,
  verifiedManagedCurrentAppImage,
  writeAll,
} = require('../desktop-updater');
const {
  canonicalReleasePayload,
  loadPinnedReleaseKey,
} = require('../release-signature');

function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = crypto.createHash('sha256').update(der).digest('hex');
  const pinned = loadPinnedReleaseKey({
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId,
    publicKeySpkiBase64: der.toString('base64'),
  });
  const sign = release => ({
    ...release,
    signatureAlgorithm: 'Ed25519',
    signatureKeyId: keyId,
    signature: crypto.sign(null, canonicalReleasePayload(release), privateKey).toString('base64url'),
  });
  return { pinned, sign };
}

function releaseFor(content, overrides = {}) {
  return {
    platform: 'linux',
    filename: 'Aerie-1.8.0.AppImage',
    version: '1.8.0',
    build: 9,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    sizeBytes: content.length,
    minServerVersion: '1.7.0',
    publishedAt: '2026-07-23T20:15:30.123Z',
    notes: 'Secure in-app updates and journaled two-way sync.',
    ...overrides,
  };
}

function catalogFor(release, overrides = {}) {
  return {
    schemaVersion: 1,
    platforms: [{
      key: release.platform,
      available: true,
      verified: true,
      signatureVerified: true,
      filename: release.filename,
      url: `/downloads/${encodeURIComponent(release.filename)}`,
      version: release.version,
      build: release.build,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      minServerVersion: release.minServerVersion,
      publishedAt: release.publishedAt,
      notes: release.notes,
      signatureAlgorithm: release.signatureAlgorithm,
      signatureKeyId: release.signatureKeyId,
      signature: release.signature,
      ...overrides,
    }],
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function managedDesktopEntry(executable, extractAndRun = false) {
  const launch = extractAndRun
    ? `env APPIMAGE_EXTRACT_AND_RUN=1 ${desktopExecQuote(executable)} %U`
    : `${desktopExecQuote(executable)} %U`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Aerie',
    'Comment=Your private cloud',
    `TryExec=${executable.replaceAll('\\', '\\'.repeat(2))}`,
    `Exec=${launch}`,
    'Terminal=false',
    'Categories=Network;Utility;',
    'MimeType=x-scheme-handler/aerie;',
    'StartupWMClass=Aerie',
    '',
  ].join('\n');
}

async function linuxOrphanCleanupFixture(root, {
  extractAndRun = true,
  currentBuild = 10,
  backupBuild = 9,
} = {}) {
  const dataHome = path.join(root, 'data');
  const managedDir = path.join(dataHome, 'aerie-desktop');
  const applications = path.join(dataHome, 'applications');
  await fsp.mkdir(managedDir, { recursive: true });
  await fsp.mkdir(applications);
  const targetPath = path.join(managedDir, 'Aerie.AppImage');
  const backupPath = path.join(managedDir,
    `Aerie.rollback-${backupBuild}-1780000001000-b1c2d3e4.AppImage`);
  const obsoletePath = path.join(managedDir, 'Aerie.rollback-8-1780000000000-a1b2c3d4.AppImage');
  const legacyPath = path.join(managedDir, 'aerie.previous-1780000000000-a1b2c3d4.desktop');
  const desktopEntry = path.join(applications, 'aerie.desktop');
  const currentBytes = Buffer.from(`installed build ${currentBuild} AppImage`);
  const backupBytes = Buffer.from(`retained build ${backupBuild} AppImage`);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  await fsp.writeFile(targetPath, currentBytes, { mode: 0o700 });
  await fsp.writeFile(backupPath, backupBytes, { mode: 0o700 });
  await fsp.writeFile(obsoletePath, 'orphaned build 8 AppImage', { mode: 0o700 });
  await fsp.writeFile(legacyPath, '[Desktop Entry]\nExec=/old/extracted/AppRun\n', { mode: 0o600 });
  await fsp.writeFile(desktopEntry, managedDesktopEntry(targetPath, extractAndRun), { mode: 0o600 });
  return {
    managedDir, targetPath, backupPath, obsoletePath, legacyPath, desktopEntry,
    currentBytes, backupBytes,
    install: {
      targetPath, backupPath, backupSha256: digest(backupBytes),
      backupVersion: '1.8.1', backupBuild,
      installedVersion: '1.8.2', installedBuild: currentBuild, installedSha256: digest(currentBytes),
      managed: true, extractAndRun, desktopEntry, legacyDesktopEntry: null,
    },
  };
}

test('semantic comparison handles stable, prerelease, build metadata, and padded cores', () => {
  assert.equal(compareVersions('1.8.0', '1.7.9'), 1);
  assert.equal(compareVersions('1.8', '1.8.0.0'), 0);
  assert.equal(compareVersions('1.8.0-rc.2', '1.8.0-rc.10'), -1);
  assert.equal(compareVersions('1.8.0', '1.8.0-rc.10'), 1);
  assert.equal(compareVersions('1.8.0+linux', '1.8.0+windows'), 0);
});

test('catalog only discovers an exact path; signed sidecar authorizes the release', async () => {
  const fixture = signingFixture();
  const content = Buffer.from('new appimage bytes');
  const release = fixture.sign(releaseFor(content));
  const requested = [];
  const fetchImpl = async url => {
    requested.push(url);
    if (url === 'https://aerie.example/api/apps') return json(catalogFor(release));
    if (url === `https://aerie.example/downloads/${encodeURIComponent(release.filename)}.release.json`) {
      return json({ schemaVersion: 1, release });
    }
    if (url === 'https://aerie.example/api/health') {
      return json({ ok: true, name: 'Aerie', version: '1.7.0' });
    }
    throw new Error(`unexpected_url:${url}`);
  };
  const found = await discoverSignedRelease({
    serverUrl: 'https://aerie.example', currentVersion: '1.7.0', currentBuild: 8,
    platform: 'linux', pinnedKey: fixture.pinned, fetchImpl,
  });
  assert.equal(found.version, '1.8.0');
  assert.equal(found.build, 9);
  assert.equal(found.downloadUrl, `https://aerie.example/downloads/${encodeURIComponent(release.filename)}`);
  assert.deepEqual(requested, [
    'https://aerie.example/api/apps',
    `https://aerie.example/downloads/${encodeURIComponent(release.filename)}.release.json`,
    'https://aerie.example/api/health',
  ]);
});

test('signed minimum server version is enforced using the bounded same-server health response', async () => {
  const fixture = signingFixture();
  const release = fixture.sign(releaseFor(Buffer.from('future app'), { minServerVersion: '1.8.0' }));
  await assert.rejects(discoverSignedRelease({
    serverUrl: 'https://aerie.example', currentVersion: '1.7.0', currentBuild: 8,
    platform: 'linux', pinnedKey: fixture.pinned,
    fetchImpl: async url => {
      if (url.endsWith('/api/apps')) return json(catalogFor(release));
      if (url.endsWith('.release.json')) return json({ schemaVersion: 1, release });
      if (url.endsWith('/api/health')) return json({ name: 'Aerie', version: '1.7.9' });
      throw new Error('unexpected_url');
    },
  }), /update_requires_newer_server/);
});

test('release ordering accepts signed same-version rebuilds without allowing replays or downgrades', async () => {
  const fixture = signingFixture();
  const discover = async ({ version, build, currentBuild = 11, highestAcceptedBuild = 11 }) => {
    const content = Buffer.from(`signed ${version} build ${build}`);
    const release = fixture.sign(releaseFor(content, {
      filename: 'Aerie-1.8.2.AppImage', version, build,
    }));
    return discoverSignedRelease({
      serverUrl: 'https://aerie.example', currentVersion: '1.8.2', currentBuild,
      highestAcceptedBuild, platform: 'linux', pinnedKey: fixture.pinned,
      fetchImpl: async url => {
        if (url.endsWith('/api/apps')) return json(catalogFor(release));
        if (url.endsWith('.release.json')) return json({ schemaVersion: 1, release });
        if (url.endsWith('/api/health')) return json({ name: 'Aerie', version: '1.8.2' });
        throw new Error('unexpected_url');
      },
    });
  };

  const sameVersionUpgrade = await discover({ version: '1.8.2', build: 12 });
  assert.equal(sameVersionUpgrade.version, '1.8.2');
  assert.equal(sameVersionUpgrade.build, 12);
  assert.equal(await discover({ version: '1.8.2', build: 11 }), null);
  assert.equal(await discover({
    version: '1.8.2', build: 12, currentBuild: 11, highestAcceptedBuild: 12,
  }), null);
  assert.equal(await discover({ version: '1.8.1', build: 99 }), null);
});

test('cross-origin discovery, catalog tampering, and replayed builds fail closed', async () => {
  const fixture = signingFixture();
  const content = Buffer.from('signed release');
  const release = fixture.sign(releaseFor(content));
  const discover = catalog => discoverSignedRelease({
    serverUrl: 'http://192.168.1.11:8200', currentVersion: '1.7.0', currentBuild: 8,
    platform: 'linux', pinnedKey: fixture.pinned,
    fetchImpl: async url => url.endsWith('/api/apps')
      ? json(catalog)
      : json({ schemaVersion: 1, release }),
  });

  await assert.rejects(discover(catalogFor(release, { url: 'https://evil.example/Aerie.AppImage' })),
    /invalid_update_url/);
  await assert.rejects(discover(catalogFor(release, { notes: 'Catalog changed these notes' })),
    /release_catalog_signature_mismatch/);
  assert.equal(await discoverSignedRelease({
    serverUrl: 'http://192.168.1.11:8200', currentVersion: '1.7.0', currentBuild: 8,
    highestAcceptedBuild: 9, platform: 'linux', pinnedKey: fixture.pinned,
    fetchImpl: async url => url.endsWith('/api/apps')
      ? json(catalogFor(release))
      : json({ schemaVersion: 1, release }),
  }), null);
});

test('resumed downloads require an exact Content-Range and end-to-end signed hash', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-download-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const content = Buffer.from('0123456789'.repeat(200));
  const release = fixture.sign({
    ...releaseFor(content),
    server: 'https://aerie.example',
    downloadUrl: 'https://aerie.example/downloads/Aerie-1.8.0.AppImage',
  });
  const prefix = `${release.build}-${release.sha256.slice(0, 16)}-${release.filename}`;
  const partial = content.subarray(0, 317);
  await fsp.writeFile(path.join(root, `${prefix}.part`), partial);
  let range = null;
  const final = await downloadSignedRelease({
    release, pinnedKey: fixture.pinned, updatesDir: root,
    fetchImpl: async (_url, options) => {
      range = options.headers.range;
      return new Response(content.subarray(partial.length), {
        status: 206,
        headers: {
          'content-length': String(content.length - partial.length),
          'content-range': `bytes ${partial.length}-${content.length - 1}/${content.length}`,
        },
      });
    },
  });
  assert.equal(range, `bytes=${partial.length}-`);
  assert.deepEqual(await fsp.readFile(final), content);
  assert.equal((await fsp.stat(final)).mode & 0o777, 0o700);
});

test('update cache pruning removes only obsolete regular updater artifacts', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-prune-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const hash = 'a'.repeat(16);
  const obsolete = [
    `8-${hash}-Aerie-1.7.0.AppImage`,
    `9-${hash}-Aerie-Setup-1.8.0.exe`,
    `10-${hash}-Aerie-1.8.1.AppImage.part`,
  ];
  for (const name of obsolete) await fsp.writeFile(path.join(root, name), name);
  const future = `11-${hash}-Aerie-1.9.0.AppImage`;
  await fsp.writeFile(path.join(root, future), 'future');
  await fsp.writeFile(path.join(root, 'keep.txt'), 'unrelated');
  const directory = `7-${hash}-Aerie-1.6.0.AppImage`;
  await fsp.mkdir(path.join(root, directory));
  const symlink = `6-${hash}-Aerie-1.5.0.AppImage`;
  await fsp.symlink(path.join(root, 'keep.txt'), path.join(root, symlink));

  assert.equal(await pruneUpdateCache(root, 10), obsolete.length);
  for (const name of obsolete) await assert.rejects(fsp.lstat(path.join(root, name)), { code: 'ENOENT' });
  assert.equal((await fsp.readFile(path.join(root, future), 'utf8')), 'future');
  assert.equal((await fsp.readFile(path.join(root, 'keep.txt'), 'utf8')), 'unrelated');
  assert.equal((await fsp.lstat(path.join(root, directory))).isDirectory(), true);
  assert.equal((await fsp.lstat(path.join(root, symlink))).isSymbolicLink(), true);
});

test('HTTP 416 from a stale partial causes one clean, non-range restart', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-416-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const content = Buffer.from('replacement bytes after stale range');
  const release = fixture.sign({
    ...releaseFor(content),
    server: 'https://aerie.example',
    downloadUrl: 'https://aerie.example/downloads/Aerie-1.8.0.AppImage',
  });
  const prefix = `${release.build}-${release.sha256.slice(0, 16)}-${release.filename}`;
  await fsp.writeFile(path.join(root, `${prefix}.part`), content.subarray(0, 8));
  const ranges = [];
  const final = await downloadSignedRelease({
    release, pinnedKey: fixture.pinned, updatesDir: root,
    fetchImpl: async (_url, options) => {
      ranges.push(options.headers.range || null);
      if (ranges.length === 1) return new Response(null, { status: 416 });
      return new Response(content, { status: 200, headers: { 'content-length': String(content.length) } });
    },
  });
  assert.deepEqual(ranges, ['bytes=8-', null]);
  assert.deepEqual(await fsp.readFile(final), content);
});

test('short FileHandle writes are retried until the full chunk is durable', async () => {
  const chunks = [];
  await writeAll({
    write: async (buffer, offset, length) => {
      const count = Math.min(3, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return { bytesWritten: count };
    },
  }, Buffer.from('partial writes still complete'));
  assert.equal(Buffer.concat(chunks).toString(), 'partial writes still complete');
});

test('range validator rejects shifted, truncated, and compressed responses', () => {
  assert.deepEqual(downloadPlan(new Response('', {
    status: 206, headers: { 'content-range': 'bytes 10-99/100', 'content-length': '90' },
  }), 10, 100), { append: true, expectedBytes: 90 });
  assert.throws(() => downloadPlan(new Response('', {
    status: 206, headers: { 'content-range': 'bytes 11-99/100', 'content-length': '89' },
  }), 10, 100), /invalid_update_download_range/);
  assert.throws(() => downloadPlan(new Response('', {
    status: 200, headers: { 'content-length': '99' },
  }), 0, 100), /invalid_update_download_length/);
  assert.throws(() => downloadPlan(new Response('', {
    status: 200, headers: { 'content-length': '100', 'content-encoding': 'gzip' },
  }), 0, 100), /compressed_update_download/);
});

test('extracted Linux installs migrate to a managed AppImage, then update atomically with rollback', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-linux-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const dataHome = path.join(root, 'xdg-data');
  const firstBytes = Buffer.from('first signed AppImage');
  const firstRelease = fixture.sign(releaseFor(firstBytes));
  const firstStage = path.join(root, 'first.AppImage');
  await fsp.writeFile(firstStage, firstBytes, { mode: 0o700 });
  const first = await installLinuxAppImage({
    stagedFile: firstStage, release: firstRelease, pinnedKey: fixture.pinned,
    currentVersion: '1.7.0', currentBuild: 8,
    env: { XDG_DATA_HOME: dataHome, APPDIR: path.join(root, 'extracted') }, homedir: root,
  });
  assert.equal(first.managed, true);
  assert.equal(first.backupPath, null);
  assert.deepEqual(await fsp.readFile(first.targetPath), firstBytes);
  assert.match(await fsp.readFile(path.join(dataHome, 'applications', 'aerie.desktop'), 'utf8'),
    /Aerie\.AppImage/);

  const secondBytes = Buffer.from('second signed AppImage');
  const secondRelease = fixture.sign(releaseFor(secondBytes, {
    filename: 'Aerie-1.9.0.AppImage', version: '1.9.0', build: 10,
  }));
  const secondStage = path.join(root, 'second.AppImage');
  await fsp.writeFile(secondStage, secondBytes, { mode: 0o700 });
  const second = await installLinuxAppImage({
    stagedFile: secondStage, release: secondRelease, pinnedKey: fixture.pinned,
    currentVersion: '1.8.0', currentBuild: 9,
    env: { XDG_DATA_HOME: dataHome, APPIMAGE: first.targetPath }, homedir: root,
  });
  assert.deepEqual(await fsp.readFile(second.targetPath), secondBytes);
  assert.deepEqual(await fsp.readFile(second.backupPath), firstBytes);

  const rolledBack = await rollbackLinuxAppImage(second);
  assert.deepEqual(await fsp.readFile(rolledBack.targetPath), firstBytes);
  assert.deepEqual(await fsp.readFile(rolledBack.backupPath), secondBytes);
});

test('extract-and-run updates reuse the verified managed AppImage when APPIMAGE is stripped', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-managed-extracted-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const dataHome = path.join(root, 'data');
  const build9Bytes = Buffer.from('managed build 9 AppImage');
  const build9Stage = path.join(root, 'build-9.AppImage');
  await fsp.writeFile(build9Stage, build9Bytes, { mode: 0o700 });
  const build9 = await installLinuxAppImage({
    stagedFile: build9Stage,
    release: fixture.sign(releaseFor(build9Bytes, { version: '1.8.1', build: 9 })),
    pinnedKey: fixture.pinned,
    currentVersion: '1.8.0',
    currentBuild: 8,
    env: { XDG_DATA_HOME: dataHome },
    homedir: root,
    extractAndRun: true,
  });

  const build10Bytes = Buffer.from('managed build 10 AppImage');
  const build10Stage = path.join(root, 'build-10.AppImage');
  await fsp.writeFile(build10Stage, build10Bytes, { mode: 0o700 });
  const build10 = await installLinuxAppImage({
    stagedFile: build10Stage,
    release: fixture.sign(releaseFor(build10Bytes, { version: '1.8.2', build: 10 })),
    pinnedKey: fixture.pinned,
    currentVersion: '1.8.1',
    currentBuild: 9,
    env: { XDG_DATA_HOME: dataHome },
    homedir: root,
    previousInstall: build9,
    platform: 'linux',
    runningExecutablePath: build9.targetPath,
    extractAndRun: true,
  });

  assert.equal(build10.legacyDesktopEntry, null);
  assert.equal(build10.backupBuild, 9);
  assert.equal(build10.backupSha256, build9.installedSha256);
  assert.deepEqual(await fsp.readFile(build10.targetPath), build10Bytes);
  assert.deepEqual(await fsp.readFile(build10.backupPath), build9Bytes);
  assert.deepEqual((await fsp.readdir(path.dirname(build10.targetPath)))
    .filter(name => name.startsWith('aerie.previous-')), []);
});

test('managed AppImage recovery rejects stale state, changed launchers, and arbitrary extracted processes', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-managed-proof-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const dataHome = path.join(root, 'data');
  const currentBytes = Buffer.from('verified managed AppImage');
  const staged = path.join(root, 'current.AppImage');
  await fsp.writeFile(staged, currentBytes, { mode: 0o700 });
  const install = await installLinuxAppImage({
    stagedFile: staged,
    release: fixture.sign(releaseFor(currentBytes, { version: '1.8.1', build: 9 })),
    pinnedKey: fixture.pinned,
    currentVersion: '1.8.0',
    currentBuild: 8,
    env: { XDG_DATA_HOME: dataHome },
    homedir: root,
    extractAndRun: true,
  });
  const arbitraryExtracted = path.join(root, 'arbitrary-extracted-aerie');
  await fsp.writeFile(arbitraryExtracted, currentBytes, { mode: 0o700 });
  const resolve = (previousInstall = install, runningExecutablePath = install.targetPath) =>
    verifiedManagedCurrentAppImage({
      previousInstall,
      currentVersion: '1.8.1',
      currentBuild: 9,
      env: { XDG_DATA_HOME: dataHome },
      homedir: root,
      platform: 'linux',
      runningExecutablePath,
    });

  assert.equal(await resolve(), install.targetPath);
  assert.equal(await resolve({ ...install, installedBuild: 8 }), null);
  assert.equal(await resolve({ ...install, installedVersion: '1.8.0' }), null);
  assert.equal(await resolve({ ...install, installedSha256: '0'.repeat(64) }), null);
  assert.equal(await resolve({ ...install, targetPath: path.join(root, 'attacker.AppImage') }), null);
  assert.equal(await resolve(install, arbitraryExtracted), null);

  await fsp.appendFile(install.desktopEntry, 'X-Tampered=true\n');
  assert.equal(await resolve(), null);
});

test('superseded rollback pruning retains one verified immediate rollback with working swap semantics', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-rollback-retention-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const managedDir = path.join(root, 'data', 'aerie-desktop');
  await fsp.mkdir(managedDir, { recursive: true });
  const targetPath = path.join(managedDir, 'Aerie.AppImage');
  const obsoletePath = path.join(managedDir, 'Aerie.rollback-8-1780000000000-a1b2c3d4.AppImage');
  const immediatePath = path.join(managedDir, 'Aerie.rollback-9-1780000001000-b1c2d3e4.AppImage');
  const unrelatedPath = path.join(managedDir, 'my-manual-copy.AppImage');
  const oldBytes = Buffer.from('oldest retained version');
  const previousBytes = Buffer.from('immediately previous version');
  const currentBytes = Buffer.from('newly installed version');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  await fsp.writeFile(targetPath, currentBytes, { mode: 0o700 });
  await fsp.writeFile(obsoletePath, oldBytes, { mode: 0o700 });
  await fsp.writeFile(immediatePath, previousBytes, { mode: 0o700 });
  await fsp.writeFile(unrelatedPath, 'user-owned file');

  const previousInstall = {
    targetPath, backupPath: obsoletePath, backupSha256: digest(oldBytes),
    backupVersion: '1.7.0', backupBuild: 8,
    installedVersion: '1.8.0', installedBuild: 9, installedSha256: digest(previousBytes),
    managed: true,
  };
  const currentInstall = {
    targetPath, backupPath: immediatePath, backupSha256: digest(previousBytes),
    backupVersion: '1.8.0', backupBuild: 9,
    installedVersion: '1.9.0', installedBuild: 10, installedSha256: digest(currentBytes),
    managed: true,
  };

  assert.equal(await pruneSupersededLinuxRollback(previousInstall, currentInstall), 1);
  await assert.rejects(fsp.lstat(obsoletePath), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(immediatePath), previousBytes);
  assert.deepEqual(await fsp.readFile(targetPath), currentBytes);
  assert.equal(await fsp.readFile(unrelatedPath, 'utf8'), 'user-owned file');
  assert.deepEqual((await fsp.readdir(managedDir)).filter(name => /^Aerie\.(?:rollback|failed)-/.test(name)),
    [path.basename(immediatePath)]);

  const rolledBack = await rollbackLinuxAppImage(currentInstall);
  assert.deepEqual(await fsp.readFile(rolledBack.targetPath), previousBytes);
  assert.deepEqual(await fsp.readFile(rolledBack.backupPath), currentBytes);
  assert.equal(await fsp.readFile(unrelatedPath, 'utf8'), 'user-owned file');
});

test('rollback pruning preserves tampered, out-of-scope, symlink, and unknown candidates', async t => {
  const cases = ['tampered', 'out-of-scope', 'symlink', 'unknown'];
  for (const kind of cases) await t.test(kind, async subtest => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `aerie-updater-rollback-${kind}-`));
    subtest.after(() => fsp.rm(root, { recursive: true, force: true }));
    const managedDir = path.join(root, 'data', 'aerie-desktop');
    const outsideDir = path.join(root, 'outside');
    await fsp.mkdir(managedDir, { recursive: true });
    await fsp.mkdir(outsideDir);
    const targetPath = path.join(managedDir, 'Aerie.AppImage');
    const immediatePath = path.join(managedDir, 'Aerie.rollback-9-1780000001000-b1c2d3e4.AppImage');
    const validOwnedName = 'Aerie.rollback-8-1780000000000-a1b2c3d4.AppImage';
    const expectedBytes = Buffer.from('expected old rollback');
    const previousBytes = Buffer.from('immediately previous version');
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    await fsp.writeFile(targetPath, 'current version', { mode: 0o700 });
    await fsp.writeFile(immediatePath, previousBytes, { mode: 0o700 });

    let candidatePath = path.join(managedDir, validOwnedName);
    if (kind === 'out-of-scope') candidatePath = path.join(outsideDir, validOwnedName);
    if (kind === 'unknown') candidatePath = path.join(managedDir, 'manually-saved.AppImage');
    if (kind === 'symlink') {
      const userFile = path.join(managedDir, 'keep.bin');
      await fsp.writeFile(userFile, expectedBytes);
      await fsp.symlink(userFile, candidatePath);
    } else {
      await fsp.writeFile(candidatePath, kind === 'tampered' ? 'modified bytes' : expectedBytes);
    }

    const previousInstall = {
      targetPath, backupPath: candidatePath, backupSha256: digest(expectedBytes),
      backupVersion: '1.7.0', backupBuild: 8,
      installedVersion: '1.8.0', installedBuild: 9, installedSha256: digest(previousBytes),
      managed: true,
    };
    const currentInstall = {
      targetPath, backupPath: immediatePath, backupSha256: digest(previousBytes),
      backupVersion: '1.8.0', backupBuild: 9,
      installedVersion: '1.9.0', installedBuild: 10,
      installedSha256: digest(Buffer.from('current version')), managed: true,
    };

    assert.equal(await pruneSupersededLinuxRollback(previousInstall, currentInstall), 0);
    assert.equal((await fsp.lstat(candidatePath)).isSymbolicLink(), kind === 'symlink');
    assert.deepEqual(await fsp.readFile(immediatePath), previousBytes);
  });
});

test('real build-9 state prunes both tracked fallbacks after a managed AppImage rollback replaces them', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-legacy-retention-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dataHome = path.join(root, 'data');
  const managedDir = path.join(dataHome, 'aerie-desktop');
  const applications = path.join(dataHome, 'applications');
  await fsp.mkdir(managedDir, { recursive: true });
  await fsp.mkdir(applications);
  const targetPath = path.join(managedDir, 'Aerie.AppImage');
  const desktopEntry = path.join(applications, 'aerie.desktop');
  const obsoletePath = path.join(managedDir, 'Aerie.rollback-8-1780000000000-a1b2c3d4.AppImage');
  const legacyPath = path.join(managedDir, 'aerie.previous-1780000000000-a1b2c3d4.desktop');
  const immediatePath = path.join(managedDir, 'Aerie.rollback-9-1780000001000-b1c2d3e4.AppImage');
  const obsoleteBytes = Buffer.from('build 8 fallback');
  const previousBytes = Buffer.from('first managed AppImage');
  const legacyBytes = Buffer.from('[Desktop Entry]\nExec=/old/AppRun\n');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  await fsp.writeFile(targetPath, 'new managed AppImage', { mode: 0o700 });
  await fsp.writeFile(obsoletePath, obsoleteBytes, { mode: 0o700 });
  await fsp.writeFile(immediatePath, previousBytes, { mode: 0o700 });
  await fsp.writeFile(desktopEntry, '[Desktop Entry]\nExec=/managed/Aerie.AppImage\n');
  await fsp.writeFile(legacyPath, legacyBytes, { mode: 0o600 });
  const previousInstall = {
    targetPath, backupPath: obsoletePath, backupSha256: digest(obsoleteBytes),
    backupVersion: '1.7.0', backupBuild: 8,
    installedVersion: '1.8.0', installedBuild: 9, installedSha256: digest(previousBytes),
    managed: true,
    legacyDesktopEntry: { targetPath: desktopEntry, backupPath: legacyPath, sha256: digest(legacyBytes) },
  };
  const currentInstall = {
    targetPath, backupPath: immediatePath, backupSha256: digest(previousBytes),
    backupVersion: '1.8.0', backupBuild: 9,
    installedVersion: '1.9.0', installedBuild: 10,
    installedSha256: digest(Buffer.from('new managed AppImage')), managed: true, desktopEntry,
  };

  assert.equal(await pruneSupersededLinuxRollback(previousInstall, currentInstall), 2);
  await assert.rejects(fsp.lstat(obsoletePath), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(legacyPath), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(immediatePath), previousBytes);
  assert.match(await fsp.readFile(desktopEntry, 'utf8'), /managed\/Aerie\.AppImage/);
});

test('independent rollback cleanup preserves an invalid tracked candidate without blocking the valid one', async t => {
  for (const invalid of ['rollback', 'legacy']) await t.test(`invalid ${invalid}`, async subtest => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `aerie-updater-mixed-${invalid}-`));
    subtest.after(() => fsp.rm(root, { recursive: true, force: true }));
    const dataHome = path.join(root, 'data');
    const managedDir = path.join(dataHome, 'aerie-desktop');
    const applications = path.join(dataHome, 'applications');
    await fsp.mkdir(managedDir, { recursive: true });
    await fsp.mkdir(applications);
    const targetPath = path.join(managedDir, 'Aerie.AppImage');
    const desktopEntry = path.join(applications, 'aerie.desktop');
    const obsoletePath = path.join(managedDir, 'Aerie.rollback-8-1780000000000-a1b2c3d4.AppImage');
    const legacyPath = path.join(managedDir, 'aerie.previous-1780000000000-a1b2c3d4.desktop');
    const immediatePath = path.join(managedDir, 'Aerie.rollback-9-1780000001000-b1c2d3e4.AppImage');
    const obsoleteBytes = Buffer.from('verified build 8 fallback');
    const previousBytes = Buffer.from('verified build 9 AppImage');
    const legacyBytes = Buffer.from('[Desktop Entry]\nExec=/old/AppRun\n');
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    await fsp.writeFile(targetPath, 'new managed AppImage', { mode: 0o700 });
    await fsp.writeFile(obsoletePath, invalid === 'rollback' ? 'tampered fallback' : obsoleteBytes, { mode: 0o700 });
    await fsp.writeFile(immediatePath, previousBytes, { mode: 0o700 });
    await fsp.writeFile(desktopEntry, '[Desktop Entry]\nExec=/managed/Aerie.AppImage\n');
    if (invalid === 'legacy') {
      const legacySource = path.join(managedDir, 'user-launcher.desktop');
      await fsp.writeFile(legacySource, legacyBytes);
      await fsp.symlink(legacySource, legacyPath);
    } else {
      await fsp.writeFile(legacyPath, legacyBytes, { mode: 0o600 });
    }
    const previousInstall = {
      targetPath, backupPath: obsoletePath, backupSha256: digest(obsoleteBytes),
      backupVersion: '1.7.0', backupBuild: 8,
      installedVersion: '1.8.0', installedBuild: 9, installedSha256: digest(previousBytes),
      managed: true,
      legacyDesktopEntry: { targetPath: desktopEntry, backupPath: legacyPath, sha256: digest(legacyBytes) },
    };
    const currentInstall = {
      targetPath, backupPath: immediatePath, backupSha256: digest(previousBytes),
      backupVersion: '1.8.0', backupBuild: 9,
      installedVersion: '1.9.0', installedBuild: 10,
      installedSha256: digest(Buffer.from('new managed AppImage')), managed: true, desktopEntry,
    };

    assert.equal(await pruneSupersededLinuxRollback(previousInstall, currentInstall), 1);
    if (invalid === 'rollback') {
      assert.equal((await fsp.lstat(obsoletePath)).isFile(), true);
      await assert.rejects(fsp.lstat(legacyPath), { code: 'ENOENT' });
    } else {
      await assert.rejects(fsp.lstat(obsoletePath), { code: 'ENOENT' });
      assert.equal((await fsp.lstat(legacyPath)).isSymbolicLink(), true);
    }
    assert.deepEqual(await fsp.readFile(immediatePath), previousBytes);
  });
});

test('build 12 cleans the real post-update orphan shape once for that build', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-orphan-migration-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await linuxOrphanCleanupFixture(root, { currentBuild: 12, backupBuild: 9 });
  const userData = path.join(root, 'user-data');
  await fsp.mkdir(userData);
  await fsp.writeFile(path.join(userData, 'desktop-updater.json'), `${JSON.stringify({
    schemaVersion: 1,
    highestAcceptedBuild: 12,
    lastCheckAt: 0,
    linuxInstall: fixture.install,
    linuxOrphanCleanupBuild: 11,
  })}\n`);
  assert.equal(fixture.install.backupBuild, 9);
  assert.equal(fixture.install.legacyDesktopEntry, null);

  const userFile = path.join(fixture.managedDir, 'user-notes.txt');
  const currentBuildFile = path.join(fixture.managedDir,
    'Aerie.rollback-12-1780000002000-c1d2e3f4.AppImage');
  const futureFile = path.join(fixture.managedDir,
    'Aerie.rollback-13-1780000003000-d1e2f3a4.AppImage');
  const symlinkPath = path.join(fixture.managedDir,
    'Aerie.failed-7-1780000004000.AppImage');
  const hardlinkSource = path.join(fixture.managedDir, 'user-hardlink-source.AppImage');
  const hardlinkPath = path.join(fixture.managedDir,
    'Aerie.rollback-6-1780000005000-e1f2a3b4.AppImage');
  const directoryPath = path.join(fixture.managedDir,
    'Aerie.rollback-5-1780000006000-f1a2b3c4.AppImage');
  const outsideDir = path.join(root, 'outside');
  const outsidePath = path.join(outsideDir,
    'Aerie.rollback-4-1780000007000-a2b3c4d5.AppImage');
  await fsp.writeFile(userFile, 'keep this user file');
  await fsp.writeFile(currentBuildFile, 'keep current build');
  await fsp.writeFile(futureFile, 'keep future build');
  await fsp.symlink(userFile, symlinkPath);
  await fsp.writeFile(hardlinkSource, 'keep both hardlinks');
  await fsp.link(hardlinkSource, hardlinkPath);
  await fsp.mkdir(directoryPath);
  await fsp.mkdir(outsideDir);
  await fsp.writeFile(outsidePath, 'outside managed directory');

  const updater = createDesktopUpdater({
    app: {
      getVersion: () => '1.8.2', getPath: () => userData,
      quit: () => {}, relaunch: () => {}, exit: () => {},
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: {}, getWindow: () => null, getServerUrl: () => null,
    currentBuild: 12, pinnedKeyPath: path.join(root, 'unused-release-key.json'), platform: 'linux',
  });
  const status = await updater.initialize();
  assert.equal(status.canRollback, true);
  await assert.rejects(fsp.lstat(fixture.obsoletePath), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(fixture.legacyPath), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(fixture.targetPath), fixture.currentBytes);
  assert.deepEqual(await fsp.readFile(fixture.backupPath), fixture.backupBytes);
  assert.match(await fsp.readFile(fixture.desktopEntry, 'utf8'),
    /^Exec=env APPIMAGE_EXTRACT_AND_RUN=1 /m);
  assert.equal(await fsp.readFile(userFile, 'utf8'), 'keep this user file');
  assert.equal((await fsp.lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal((await fsp.lstat(hardlinkPath)).nlink, 2);
  assert.equal((await fsp.lstat(directoryPath)).isDirectory(), true);
  assert.equal(await fsp.readFile(currentBuildFile, 'utf8'), 'keep current build');
  assert.equal(await fsp.readFile(futureFile, 'utf8'), 'keep future build');
  assert.equal(await fsp.readFile(outsidePath, 'utf8'), 'outside managed directory');
  const savedState = JSON.parse(await fsp.readFile(path.join(userData, 'desktop-updater.json'), 'utf8'));
  assert.equal(savedState.linuxOrphanCleanupBuild, 12);

  // The per-build marker makes this a single startup cost and prevents another scan
  // when the same build initializes again.
  const laterOrphan = path.join(fixture.managedDir,
    'Aerie.rollback-7-1780000008000-b2c3d4e5.AppImage');
  await fsp.writeFile(laterOrphan, 'created after migration');
  await updater.initialize();
  assert.equal(await fsp.readFile(laterOrphan, 'utf8'), 'created after migration');
});

test('Linux orphan cleanup removes the exact post-swap failure namespace and preserves unsafe lookalikes', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-orphan-failed-install-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await linuxOrphanCleanupFixture(root);
  await fsp.unlink(fixture.obsoletePath);
  await fsp.unlink(fixture.legacyPath);
  const failedInstall = path.join(fixture.managedDir,
    'Aerie.AppImage.failed-1780000009000-a3b4c5d6');
  const symlinkFailure = path.join(fixture.managedDir,
    'Aerie.AppImage.failed-1780000010000-b3c4d5e6');
  const lookalike = path.join(fixture.managedDir,
    'Aerie.AppImage.failed-1780000011000-c3d4e5f6.AppImage');
  const userFile = path.join(fixture.managedDir, 'failed-install-user-data');
  await fsp.writeFile(failedInstall, 'invalid copied AppImage', { mode: 0o700 });
  await fsp.writeFile(userFile, 'keep symlink target');
  await fsp.symlink(userFile, symlinkFailure);
  await fsp.writeFile(lookalike, 'not an updater-owned name');

  assert.deepEqual(await pruneLinuxUpdaterOrphans(fixture.install, 10), { validated: true, removed: 1 });
  await assert.rejects(fsp.lstat(failedInstall), { code: 'ENOENT' });
  assert.equal((await fsp.lstat(symlinkFailure)).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(lookalike, 'utf8'), 'not an updater-owned name');
  assert.deepEqual(await fsp.readFile(fixture.backupPath), fixture.backupBytes);
});

test('Linux orphan cleanup declines removal when the managed directory exceeds its scan bound', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-orphan-bounded-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await linuxOrphanCleanupFixture(root, { currentBuild: 12 });
  await Promise.all(Array.from({ length: 513 }, (_, index) =>
    fsp.writeFile(path.join(fixture.managedDir, `user-file-${String(index).padStart(3, '0')}`), 'keep')));

  assert.deepEqual(await pruneLinuxUpdaterOrphans(fixture.install, 12), { validated: true, removed: 0 });
  assert.equal((await fsp.lstat(fixture.obsoletePath)).isFile(), true);
  assert.equal((await fsp.lstat(fixture.legacyPath)).isFile(), true);
  assert.deepEqual(await fsp.readFile(fixture.backupPath), fixture.backupBytes);
});

test('Linux orphan cleanup preserves everything when current recovery state is tampered', async t => {
  for (const tampered of ['target', 'backup', 'launcher']) await t.test(tampered, async subtest => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `aerie-updater-orphan-tampered-${tampered}-`));
    subtest.after(() => fsp.rm(root, { recursive: true, force: true }));
    const fixture = await linuxOrphanCleanupFixture(root, { currentBuild: 12 });
    if (tampered === 'target') await fsp.writeFile(fixture.targetPath, 'tampered current build', { mode: 0o700 });
    if (tampered === 'backup') await fsp.writeFile(fixture.backupPath, 'tampered build 9', { mode: 0o700 });
    if (tampered === 'launcher') await fsp.appendFile(fixture.desktopEntry, 'X-Tampered=true\n');

    assert.deepEqual(await pruneLinuxUpdaterOrphans(fixture.install, 12), { validated: false, removed: 0 });
    assert.equal((await fsp.lstat(fixture.obsoletePath)).isFile(), true);
    assert.equal((await fsp.lstat(fixture.legacyPath)).isFile(), true);
  });
});

test('FUSE-less Linux installs use AppImage extract-and-run across launcher and relaunch', async t => {
  assert.equal(appImageNeedsExtractAndRun({}, {
    platform: 'linux', hasFuseDevice: true, hasFuse2Library: true,
  }), false);
  assert.equal(appImageNeedsExtractAndRun({}, {
    platform: 'linux', hasFuseDevice: true, hasFuse2Library: false,
  }), true);
  assert.equal(appImageNeedsExtractAndRun({ AERIE_APPIMAGE_EXTRACT_AND_RUN: '0' }, {
    platform: 'linux', hasFuseDevice: false, hasFuse2Library: false,
  }), false);
  assert.equal(appImageNeedsExtractAndRun({ APPIMAGE_EXTRACT_AND_RUN: '1' }, {
    platform: 'linux', hasFuseDevice: true, hasFuse2Library: true,
  }), true);

  const hostilePath = '/tmp/Aerie %U " $ ` \\ path/AppImage';
  const expectedQuoted = '"/tmp/Aerie %%U '
    + '\\'.repeat(2) + '" '
    + '\\'.repeat(2) + '$ '
    + '\\'.repeat(2) + '` '
    + '\\'.repeat(4) + ' path/AppImage"';
  assert.equal(desktopExecQuote(hostilePath), expectedQuoted);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-fuseless-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const dataHome = path.join(root, 'data %U " $ ` \\ path');
  const bytes = Buffer.from('FUSE-independent signed AppImage');
  const staged = path.join(root, 'next.AppImage');
  await fsp.writeFile(staged, bytes, { mode: 0o700 });
  const release = fixture.sign(releaseFor(bytes));
  const installed = await installLinuxAppImage({
    stagedFile: staged, release, pinnedKey: fixture.pinned,
    currentVersion: '1.7.0', currentBuild: 7,
    env: { XDG_DATA_HOME: dataHome }, homedir: root, extractAndRun: true,
  });
  const launcher = await fsp.readFile(path.join(dataHome, 'applications', 'aerie.desktop'), 'utf8');
  assert.match(launcher, /Exec=env APPIMAGE_EXTRACT_AND_RUN=1 /);
  assert.match(launcher, /data %%U /);
  const execLine = launcher.split('\n').find(line => line.startsWith('Exec='));
  assert.equal((execLine.match(/(?<!%)%U(?!%)/g) || []).length, 1);
  assert.equal(installed.extractAndRun, true);

  const relaunchEnv = {};
  assert.deepEqual(linuxRelaunchOptions(installed, relaunchEnv), {
    execPath: installed.targetPath, args: [],
  });
  assert.equal(relaunchEnv.APPIMAGE_EXTRACT_AND_RUN, '1');
});

test('Linux immediately restores the previous AppImage if post-swap verification fails', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-restore-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const current = path.join(root, 'Aerie.AppImage');
  const staged = path.join(root, 'next.AppImage');
  const oldBytes = Buffer.from('known working appimage');
  const newBytes = Buffer.from('new verified appimage');
  await fsp.writeFile(current, oldBytes, { mode: 0o700 });
  await fsp.writeFile(staged, newBytes, { mode: 0o700 });
  const release = fixture.sign(releaseFor(newBytes));
  const originalRename = fsp.rename;
  t.mock.method(fsp, 'rename', async (source, destination) => {
    await originalRename(source, destination);
    if (String(source).includes('.Aerie.AppImage.new-') && destination === current) {
      await fsp.writeFile(current, Buffer.alloc(newBytes.length, 0x78), { mode: 0o700 });
    }
  });
  await assert.rejects(installLinuxAppImage({
    stagedFile: staged, release, pinnedKey: fixture.pinned,
    currentVersion: '1.7.0', currentBuild: 8,
    env: { APPIMAGE: current, XDG_DATA_HOME: path.join(root, 'data') }, homedir: root,
  }), /staged_update_hash_mismatch/);
  assert.deepEqual(await fsp.readFile(current), oldBytes);
});

test('extracted-install migration preserves and can restore the previous Arch launcher', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-legacy-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const dataHome = path.join(root, 'data');
  const applications = path.join(dataHome, 'applications');
  await fsp.mkdir(applications, { recursive: true });
  const desktopEntry = path.join(applications, 'aerie.desktop');
  const previousLauncher = '[Desktop Entry]\nName=Aerie\nExec=/old/extracted/AppRun --no-sandbox\n';
  await fsp.writeFile(desktopEntry, previousLauncher);
  const bytes = Buffer.from('managed signed appimage');
  const staged = path.join(root, 'next.AppImage');
  await fsp.writeFile(staged, bytes, { mode: 0o700 });
  const release = fixture.sign(releaseFor(bytes));
  const installed = await installLinuxAppImage({
    stagedFile: staged, release, pinnedKey: fixture.pinned,
    currentVersion: '1.7.0', currentBuild: 8,
    env: { XDG_DATA_HOME: dataHome, APPDIR: path.join(root, 'old-extracted') }, homedir: root,
  });
  assert.ok(installed.legacyDesktopEntry?.backupPath);
  assert.notEqual(await fsp.readFile(desktopEntry, 'utf8'), previousLauncher);
  const rolledBack = await rollbackLinuxAppImage(installed);
  assert.equal(rolledBack.legacyRestored, true);
  assert.equal(await fsp.readFile(desktopEntry, 'utf8'), previousLauncher);
  assert.deepEqual(await fsp.readFile(installed.targetPath), bytes);
});

test('Windows updater runs the verified NSIS update directly only after two native confirmations', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-updater-windows-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = signingFixture();
  const keyDer = fixture.pinned.publicKey.export({ type: 'spki', format: 'der' });
  const keyFile = path.join(root, 'release-key.json');
  await fsp.writeFile(keyFile, JSON.stringify({
    schemaVersion: 1, algorithm: 'Ed25519', keyId: fixture.pinned.keyId,
    publicKeySpkiBase64: keyDer.toString('base64'),
  }));
  const content = Buffer.from('signed nsis installer');
  const unsigned = releaseFor(content, {
    platform: 'windows', filename: 'Aerie-Setup-1.8.0.exe', notes: 'Safe Windows update.',
  });
  const release = fixture.sign(unsigned);
  const fetchImpl = async url => {
    if (url.endsWith('/api/apps')) return json(catalogFor(release));
    if (url.endsWith('.release.json')) return json({ schemaVersion: 1, release });
    if (url.endsWith('/api/health')) return json({ name: 'Aerie', version: '1.7.0' });
    if (url.endsWith('.exe')) return new Response(content, {
      status: 200, headers: { 'content-length': String(content.length) },
    });
    throw new Error(`unexpected_url:${url}`);
  };
  const prompts = [];
  let spawnCall = null;
  let shutdowns = 0;
  let quits = 0;
  const updater = createDesktopUpdater({
    app: {
      getVersion: () => '1.7.0', getPath: () => root,
      quit: () => { quits += 1; }, relaunch: () => {}, exit: () => {},
    },
    dialog: { showMessageBox: async options => { prompts.push(options); return { response: 0 }; } },
    shell: {}, getWindow: () => null, getServerUrl: () => 'https://aerie.example',
    currentBuild: 8, pinnedKeyPath: keyFile, fetchImpl, platform: 'win32',
    beforeInstall: async () => { shutdowns += 1; },
    spawnImpl: (file, args, options) => {
      spawnCall = { file, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  await updater.initialize();
  const result = await updater.checkAndPrompt(true);
  assert.equal(result.status, 'installer-launched');
  assert.equal(prompts.length, 2);
  assert.equal(shutdowns, 1);
  assert.equal(quits, 1);
  assert.deepEqual(spawnCall.args, ['/S', '--updated', '--force-run']);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.detached, true);
  assert.match(spawnCall.file, /Aerie-Setup-1\.8\.0\.exe$/);
});
