import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { releaseCatalog } from '../src/services/release-catalog.js';
import {
  canonicalDesktopReleasePayload,
  loadDesktopReleaseKey,
  PINNED_DESKTOP_RELEASE_KEY,
} from '../src/services/release-signature.js';

const require = createRequire(import.meta.url);
const desktopSignature = require('../../apps/desktop/release-signature.js');

function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const source = {
    schemaVersion: 1 as const,
    algorithm: 'Ed25519' as const,
    keyId: crypto.createHash('sha256').update(der).digest('hex'),
    publicKeySpkiBase64: der.toString('base64'),
  };
  const key = loadDesktopReleaseKey(source);
  const sign = (release: any) => ({
    ...release,
    signatureAlgorithm: 'Ed25519',
    signatureKeyId: source.keyId,
    signature: crypto.sign(null, canonicalDesktopReleasePayload(release), privateKey).toString('base64url'),
  });
  return { key, sign };
}

async function writeSidecar(root: string, filename: string, release: any) {
  await fsp.writeFile(path.join(root, `${filename}.release.json`), JSON.stringify({ schemaVersion: 1, release }));
}

test('server and desktop use identical canonical release bytes and pinned public identity', async () => {
  const fixture = {
    platform: 'linux', filename: 'Aerie-1.8.0.AppImage', version: '1.8.0', build: 8,
    sha256: 'ab'.repeat(32), sizeBytes: 12345, minServerVersion: '1.8.0',
    publishedAt: '2026-07-23T18:00:00.123Z', notes: 'Signed release metadata.',
  };
  assert.deepEqual(canonicalDesktopReleasePayload(fixture), desktopSignature.canonicalReleasePayload(fixture));
  const desktopKey = JSON.parse(await fsp.readFile(
    path.resolve(import.meta.dirname, '../../apps/desktop/release-key.json'), 'utf8'));
  assert.deepEqual(PINNED_DESKTOP_RELEASE_KEY, desktopKey);
});

test('release catalog verifies Android metadata selected by an exact manifest', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-releases-'));
  try {
    const oldApk = path.join(root, 'Aerie-1.5.0.apk');
    const apk = path.join(root, 'Aerie-1.8.0.apk');
    await fsp.writeFile(oldApk, 'old');
    await fsp.writeFile(apk, 'new-release');
    const digest = crypto.createHash('sha256').update('new-release').digest('hex');
    await fsp.writeFile(path.join(root, 'aerie-releases.json'), JSON.stringify({
      schemaVersion: 1,
      releases: {
        android: {
          filename: 'Aerie-1.8.0.apk', version: '1.8.0', build: 11,
          sha256: digest, certificateSha256: 'a'.repeat(64), minServerVersion: '1.8.0',
          publishedAt: '2026-07-23T18:00:00Z', notes: 'Reliable background sync.',
        },
      },
    }));

    const android = (await releaseCatalog(root)).platforms.find(item => item.key === 'android')!;
    assert.equal(android.filename, 'Aerie-1.8.0.apk');
    assert.equal(android.sha256, digest);
    assert.equal(android.version, '1.8.0');
    assert.equal(android.build, 11);
    assert.equal(android.verified, true);
    assert.equal(android.signatureVerified, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('newest unverified file is a fallback only when no verified release exists', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-releases-'));
  try {
    const first = path.join(root, 'first.AppImage');
    const latest = path.join(root, 'latest.AppImage');
    await fsp.writeFile(first, 'first');
    await fsp.writeFile(latest, 'latest');
    await fsp.utimes(first, new Date(1_000), new Date(1_000));
    await fsp.utimes(latest, new Date(2_000), new Date(2_000));

    const linux = (await releaseCatalog(root)).platforms.find(item => item.key === 'linux')!;
    assert.equal(linux.filename, 'latest.AppImage');
    assert.equal(linux.verified, false);
    assert.equal(linux.signatureVerified, false);
    assert.match(linux.sha256 || '', /^[a-f0-9]{64}$/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('highest valid signed desktop release wins over newer touched files and a stale manifest', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-releases-'));
  try {
    const fixture = signingFixture();
    const trustedName = 'Aerie-Setup-1.8.0.exe';
    const trustedBody = Buffer.from('trusted-windows-installer');
    const trusted = fixture.sign({
      platform: 'windows', filename: trustedName, version: '1.8.0', build: 8,
      sha256: crypto.createHash('sha256').update(trustedBody).digest('hex'),
      sizeBytes: trustedBody.length, minServerVersion: '1.8.0',
      publishedAt: '2026-07-23T18:00:00Z', notes: 'Trusted update.',
    });
    await fsp.writeFile(path.join(root, trustedName), trustedBody);
    await writeSidecar(root, trustedName, trusted);

    const decoyName = 'Aerie-Setup-9.9.9.exe';
    const decoyBody = Buffer.from('unsigned-newer-decoy');
    const decoy = {
      platform: 'windows', filename: decoyName, version: '9.9.9', build: 999,
      sha256: crypto.createHash('sha256').update(decoyBody).digest('hex'),
      sizeBytes: decoyBody.length, minServerVersion: '1.8.0',
      publishedAt: '2026-07-23T20:00:00Z', notes: 'Not actually signed.',
      signatureAlgorithm: 'Ed25519', signatureKeyId: 'f'.repeat(64), signature: 'A'.repeat(86),
    };
    await fsp.writeFile(path.join(root, decoyName), decoyBody);
    await writeSidecar(root, decoyName, decoy);
    await fsp.writeFile(path.join(root, 'aerie-releases.json'), JSON.stringify({
      schemaVersion: 1, releases: { windows: decoy },
    }));

    const windows = (await releaseCatalog(root, { desktopReleaseKey: fixture.key }))
      .platforms.find(item => item.key === 'windows')!;
    assert.equal(windows.filename, trustedName);
    assert.equal(windows.version, '1.8.0');
    assert.equal(windows.build, 8);
    assert.equal(windows.verified, true);
    assert.equal(windows.signatureVerified, true);
    assert.equal(windows.signature, trusted.signature);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('hash cache invalidates a same-size artifact replacement with restored mtime', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-releases-'));
  try {
    const filename = 'Aerie-1.8.0.AppImage';
    const artifact = path.join(root, filename);
    const first = Buffer.from('first!');
    const second = Buffer.from('second');
    await fsp.writeFile(artifact, first);
    const original = await fsp.stat(artifact);
    await writeSidecar(root, filename, {
      filename, version: '1.8.0', build: 8,
      sha256: crypto.createHash('sha256').update(first).digest('hex'),
      publishedAt: '2026-07-23T18:00:00Z', notes: 'Checksum metadata.',
    });
    const before = (await releaseCatalog(root)).platforms.find(item => item.key === 'linux')!;
    assert.equal(before.verified, true);

    await fsp.writeFile(artifact, second);
    await fsp.utimes(artifact, original.atime, original.mtime);
    const after = (await releaseCatalog(root)).platforms.find(item => item.key === 'linux')!;
    assert.equal(after.verified, false);
    assert.equal(after.sha256, crypto.createHash('sha256').update(second).digest('hex'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
