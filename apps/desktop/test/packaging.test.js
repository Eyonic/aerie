const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const { loadPinnedReleaseKey } = require('../release-signature');

test('desktop package includes every local runtime module', () => {
  const root = path.resolve(__dirname, '..');
  const included = new Set(packageJson.build.files);
  const entrypoints = ['main.js', 'preload.js', 'sync.js', 'mesh.js', 'secure-credentials.js'];
  const required = new Set(entrypoints);
  const localRequire = /require\(['"](\.\/[^'"]+)['"]\)/g;
  const queue = [...entrypoints];
  while (queue.length) {
    const filename = queue.shift();
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of source.matchAll(localRequire)) {
      const dependency = match[1].replace(/^\.\//, '') + (path.extname(match[1]) ? '' : '.js');
      if (!required.has(dependency)) { required.add(dependency); queue.push(dependency); }
    }
  }
  for (const filename of required) {
    assert.ok(included.has(filename), `${filename} must be present in build.files`);
    assert.ok(fs.existsSync(path.join(root, filename)), `${filename} must exist`);
  }
});

test('packaged Electron runtime disables production code-injection escape hatches', () => {
  const fuses = packageJson.build.electronFuses;
  assert.ok(fuses, 'electronFuses must be configured');
  assert.equal(fuses.runAsNode, false);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
  assert.equal(fuses.grantFileProtocolExtraPrivileges, false);
});

test('Linux launchers use the same desktop identity as the running window', () => {
  assert.equal(packageJson.desktopName, 'aerie-desktop.desktop');
  assert.equal(packageJson.build.linux.syncDesktopName, true);
});

test('desktop update identity and release runtime are packaged fail-closed', () => {
  assert.ok(Number.isSafeInteger(packageJson.aerieBuild) && packageJson.aerieBuild > 0);
  for (const filename of ['desktop-updater.js', 'release-signature.js', 'release-key.json']) {
    assert.ok(packageJson.build.files.includes(filename), `${filename} must be packaged`);
  }
  const key = loadPinnedReleaseKey(path.resolve(__dirname, '../release-key.json'));
  assert.equal(key.publicKey.asymmetricKeyType, 'ed25519');
  assert.deepEqual(packageJson.build.win.target, ['nsis']);
});

test('desktop updater IPC exposes no renderer-selected URL, path, hash, or command', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  assert.match(preload, /check: \(\) => ipcRenderer\.invoke\('desktopUpdater:check'\)/);
  assert.match(preload, /rollback: \(\) => ipcRenderer\.invoke\('desktopUpdater:rollback'\)/);
  assert.match(main, /ipcMain\.handle\('desktopUpdater:check', \(e\) => \{\s*nativeOrigin\(e\)/);
  assert.match(main, /ipcMain\.handle\('desktopUpdater:rollback', \(e\) => \{\s*nativeOrigin\(e\)/);
});

test('renderer boot cannot erase a paired device credential before session restore', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  assert.match(preload, /restore \? 'restore' : 'set'/);
  assert.match(main, /intent === 'restore'/);
  assert.match(main, /loadAccessToken\(origin\)/);
  assert.match(main, /Connect to this Aerie server\?/);
  assert.match(main, /defaultId: 1/);
});

test('hardened first-run configuration avoids privileged file protocol loading', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const config = fs.readFileSync(path.resolve(__dirname, '../config.html'), 'utf8');
  assert.match(main, /data:text\/html;charset=utf-8;base64/);
  assert.match(main, /crypto\.randomBytes\(16\)/);
  assert.doesNotMatch(main, /loadFile\(path\.join\(__dirname, 'config\.html'\)\)/);
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /default-src 'none'/);
});
