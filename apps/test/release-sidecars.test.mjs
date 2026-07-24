import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { parseArguments, writeReleaseSidecars } from '../write-release-sidecars.mjs';

const require = createRequire(import.meta.url);
const { canonicalReleasePayload, loadPinnedReleaseKey, verifyReleaseSignature } = require('../desktop/release-signature.js');
const PUBLISHED_AT = '2026-07-23T20:15:30.123Z';

async function fixture({ desktop = true, android = true } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-release-tools-'));
  const root = path.join(base, 'apps');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(path.join(base, 'server'), { recursive: true });
  await fsp.writeFile(path.join(base, 'server/package.json'), JSON.stringify({ version: '1.8.0' }));
  if (desktop) {
    await fsp.mkdir(path.join(root, 'desktop'), { recursive: true });
    await fsp.writeFile(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '1.8.0', aerieBuild: 8 }));
  }
  if (android) {
    await fsp.mkdir(path.join(root, 'android/app'), { recursive: true });
    await fsp.writeFile(path.join(root, 'android/app/build.gradle'), 'versionCode 11\nversionName "1.8.0"\n');
  }
  return { base, root };
}

async function desktopArtifacts(base) {
  const dir = path.join(base, 'desktop-artifacts');
  await fsp.mkdir(dir);
  const names = ['Aerie-1.8.0.AppImage', 'aerie_1.8.0_amd64.deb', 'Aerie-Setup-1.8.0.exe'];
  for (const name of names) await fsp.writeFile(path.join(dir, name), `artifact:${name}`);
  return { dir, names };
}

test('CLI requires an explicit target and artifact directory', () => {
  assert.deepEqual(parseArguments(['--target', 'desktop', '--artifacts-dir', './out', '--require-signature']), {
    target: 'desktop', artifactsDir: path.resolve('./out'), requireSignature: true,
  });
  assert.throws(() => parseArguments(['--artifacts-dir', './out']), /release_target/);
  assert.throws(() => parseArguments(['--target', 'android']), /artifacts_dir_required/);
  assert.throws(() => parseArguments(['--target', 'android', '--artifacts-dir', './out', '--require-signature']),
    /desktop_only/);
});

test('desktop metadata covers only the exact current versioned artifacts', async t => {
  const { base, root } = await fixture({ android: false });
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const { dir, names } = await desktopArtifacts(base);
  const unrelatedAndroid = path.join(base, 'app-release.apk');
  await fsp.writeFile(unrelatedAndroid, 'android-must-not-be-touched');

  const releases = await writeReleaseSidecars({
    target: 'desktop', artifactsDir: dir, rootDir: root, environment: {}, publishedAt: PUBLISHED_AT,
  });
  assert.deepEqual(releases.map(item => item.filename).sort(), [...names].sort());
  assert.ok(releases.every(item => item.version === '1.8.0' && item.build === 8 && !item.signature));
  assert.equal(await fsp.readFile(unrelatedAndroid, 'utf8'), 'android-must-not-be-touched');
  for (const name of names) {
    const sidecar = JSON.parse(await fsp.readFile(path.join(dir, `${name}.release.json`), 'utf8'));
    assert.equal(sidecar.release.filename, name);
  }

  await fsp.writeFile(path.join(dir, 'Aerie-1.7.0.AppImage'), 'stale');
  await assert.rejects(writeReleaseSidecars({
    target: 'desktop', artifactsDir: dir, rootDir: root, environment: {}, publishedAt: PUBLISHED_AT,
  }), /unexpected_release_artifacts:Aerie-1\.7\.0\.AppImage/);
});

test('published desktop mode requires the pinned Ed25519 private key', async t => {
  const { base, root } = await fixture({ android: false });
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const { dir } = await desktopArtifacts(base);
  await assert.rejects(writeReleaseSidecars({
    target: 'desktop', artifactsDir: dir, rootDir: root, environment: {},
    requireSignature: true, publishedAt: PUBLISHED_AT,
  }), /release_signing_key_required/);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateFile = path.join(base, 'private.pem');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = crypto.createHash('sha256').update(publicDer).digest('hex');
  await fsp.writeFile(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await fsp.writeFile(path.join(root, 'desktop/release-key.json'), JSON.stringify({
    schemaVersion: 1, algorithm: 'Ed25519', keyId, publicKeySpkiBase64: publicDer.toString('base64'),
  }));

  const releases = await writeReleaseSidecars({
    target: 'desktop', artifactsDir: dir, rootDir: root,
    environment: { AERIE_RELEASE_SIGNING_KEY: privateFile }, requireSignature: true,
    publishedAt: PUBLISHED_AT,
  });
  const pinned = loadPinnedReleaseKey(path.join(root, 'desktop/release-key.json'));
  for (const release of releases) {
    assert.deepEqual(verifyReleaseSignature(release, pinned), release);
    assert.ok(crypto.verify(null, canonicalReleasePayload(release), publicKey,
      Buffer.from(release.signature, 'base64url')));
  }
});

test('Android metadata does not read or rewrite desktop build output', async t => {
  const { base, root } = await fixture({ desktop: false });
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'android-artifacts');
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, 'app-release.apk'), 'signed-apk');
  await fsp.writeFile(path.join(dir, 'certificate-sha256.txt'), 'ab'.repeat(32));
  const desktopSidecar = path.join(base, 'desktop.release.json');
  await fsp.writeFile(desktopSidecar, 'must remain unchanged');

  const [release] = await writeReleaseSidecars({
    target: 'android', artifactsDir: dir, rootDir: root,
    environment: { AERIE_RELEASE_SIGNING_KEY: '/must/not/be/read' }, publishedAt: PUBLISHED_AT,
  });
  assert.equal(release.platform, 'android');
  assert.equal(release.version, '1.8.0');
  assert.equal(release.build, 11);
  assert.equal(release.certificateSha256, 'ab'.repeat(32));
  assert.equal(release.signature, undefined);
  assert.equal(await fsp.readFile(desktopSidecar, 'utf8'), 'must remain unchanged');
});
