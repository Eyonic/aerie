#!/usr/bin/env node
// Generate metadata for exactly one native build. Desktop and Android builds
// are intentionally isolated: neither command may discover or rewrite the
// other platform's sidecars, and stale versioned installers fail the build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const moduleFile = fileURLToPath(import.meta.url);
const defaultRoot = path.dirname(moduleFile);
const SIGNATURE_ALGORITHM = 'Ed25519';
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const require = createRequire(import.meta.url);
const { canonicalReleasePayload } = require('./desktop/release-signature.js');

export function parseArguments(argv) {
  const options = { target: '', artifactsDir: '', requireSignature: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target') options.target = String(argv[++index] || '');
    else if (argument === '--artifacts-dir') options.artifactsDir = String(argv[++index] || '');
    else if (argument === '--require-signature') options.requireSignature = true;
    else throw new Error(`unknown_release_argument:${argument}`);
  }
  if (options.target !== 'desktop' && options.target !== 'android') {
    throw new Error('release_target_must_be_desktop_or_android');
  }
  if (!options.artifactsDir) throw new Error('release_artifacts_dir_required');
  options.artifactsDir = path.resolve(options.artifactsDir);
  if (options.requireSignature && options.target !== 'desktop') {
    throw new Error('release_signature_mode_is_desktop_only');
  }
  return options;
}

async function releaseSigner(rootDir, environment, required) {
  const signingPath = String(environment.AERIE_RELEASE_SIGNING_KEY || '').trim();
  if (!signingPath) {
    if (required) throw new Error('release_signing_key_required');
    return null;
  }
  const privateKey = crypto.createPrivateKey(await fsp.readFile(signingPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('release_signing_key_must_be_ed25519');
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const keyId = crypto.createHash('sha256').update(publicDer).digest('hex');
  const pinned = JSON.parse(await fsp.readFile(path.join(rootDir, 'desktop/release-key.json'), 'utf8'));
  if (pinned?.schemaVersion !== 1 || pinned?.algorithm !== SIGNATURE_ALGORITHM
    || pinned?.keyId !== keyId || pinned?.publicKeySpkiBase64 !== publicDer.toString('base64')) {
    throw new Error('release_signing_key_does_not_match_pinned_public_key');
  }
  return release => ({
    ...release,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signatureKeyId: keyId,
    signature: crypto.sign(null, canonicalReleasePayload(release), privateKey).toString('base64url'),
  });
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function androidVersion(source) {
  const name = source.match(/\bversionName\s+["']([^"']+)["']/)?.[1];
  const code = Number(source.match(/\bversionCode\s+(\d+)/)?.[1]);
  if (!name || !VERSION.test(name) || !Number.isSafeInteger(code) || code <= 0) {
    throw new Error('android_version_missing');
  }
  return { name, code };
}

function desktopArtifacts(version) {
  return [
    { platform: 'linux', filename: `Aerie-${version}.AppImage` },
    { platform: 'linux-deb', filename: `aerie_${version}_amd64.deb` },
    { platform: 'windows', filename: `Aerie-Setup-${version}.exe` },
  ];
}

function publishablePlatform(filename) {
  if (/\.apk$/i.test(filename)) return 'android';
  if (/\.AppImage$/i.test(filename)) return 'linux';
  if (/\.deb$/i.test(filename)) return 'linux-deb';
  if (/\.exe$/i.test(filename) && /setup/i.test(filename)) return 'windows';
  return null;
}

async function exactArtifacts(target, artifactsDir, versions) {
  const expected = target === 'desktop'
    ? desktopArtifacts(versions.desktop.version)
    : [{ platform: 'android', filename: 'app-release.apk' }];
  const expectedNames = new Set(expected.map(item => item.filename));
  const entries = await fsp.readdir(artifactsDir, { withFileTypes: true });
  const unexpected = entries
    .filter(entry => (entry.isFile() || entry.isSymbolicLink())
      && publishablePlatform(entry.name) && !expectedNames.has(entry.name))
    .map(entry => entry.name)
    .sort();
  if (unexpected.length) throw new Error(`unexpected_release_artifacts:${unexpected.join(',')}`);

  for (const artifact of expected) {
    artifact.file = path.join(artifactsDir, artifact.filename);
    const stat = await fsp.lstat(artifact.file).catch(error => {
      if (error?.code === 'ENOENT') throw new Error(`expected_release_artifact_missing:${artifact.filename}`);
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`invalid_release_artifact:${artifact.filename}`);
    }
    artifact.stat = stat;
  }
  return expected;
}

async function writeSidecar(file, release) {
  const payload = `${JSON.stringify({ schemaVersion: 1, release }, null, 2)}\n`;
  const target = `${file}.release.json`;
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, payload, { flag: 'wx', mode: 0o644 });
  await fsp.rename(temporary, target);
  process.stdout.write(`metadata: ${target}\n`);
}

export async function writeReleaseSidecars({
  target,
  artifactsDir,
  requireSignature = false,
  rootDir = defaultRoot,
  environment = process.env,
  publishedAt = new Date().toISOString(),
}) {
  if (target !== 'desktop' && target !== 'android') throw new Error('release_target_must_be_desktop_or_android');
  if (!path.isAbsolute(artifactsDir)) throw new Error('release_artifacts_dir_must_be_absolute');
  const server = JSON.parse(await fsp.readFile(path.join(rootDir, '../server/package.json'), 'utf8'));
  if (!VERSION.test(String(server.version))) throw new Error('server_version_missing');
  if (!Number.isFinite(Date.parse(publishedAt)) || !String(publishedAt).endsWith('Z')) {
    throw new Error('release_published_at_invalid');
  }

  let desktop = null;
  let android = null;
  let desktopBuild = null;
  if (target === 'desktop') {
    desktop = JSON.parse(await fsp.readFile(path.join(rootDir, 'desktop/package.json'), 'utf8'));
    desktopBuild = Number(desktop.aerieBuild);
    if (!VERSION.test(String(desktop.version)) || !Number.isSafeInteger(desktopBuild) || desktopBuild <= 0) {
      throw new Error('desktop_version_or_build_missing');
    }
  } else {
    const androidSource = await fsp.readFile(path.join(rootDir, 'android/app/build.gradle'), 'utf8');
    android = androidVersion(androidSource);
  }

  const signRelease = target === 'desktop' ? await releaseSigner(rootDir, environment, requireSignature) : null;
  const artifacts = await exactArtifacts(target, artifactsDir, { desktop, android });
  let certificateSha256 = null;
  if (target === 'android') {
    const certificatePath = path.join(artifactsDir, 'certificate-sha256.txt');
    const value = (await fsp.readFile(certificatePath, 'utf8').catch(() => '')).trim().replaceAll(':', '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('android_certificate_sha256_missing');
    certificateSha256 = value;
  }

  const releases = [];
  for (const artifact of artifacts) {
    const isAndroid = artifact.platform === 'android';
    const release = {
      platform: artifact.platform,
      filename: artifact.filename,
      version: isAndroid ? android.name : String(desktop.version),
      build: isAndroid ? android.code : desktopBuild,
      ...(isAndroid ? { certificateSha256 } : {}),
      sha256: await sha256(artifact.file),
      sizeBytes: artifact.stat.size,
      minServerVersion: String(server.version),
      publishedAt,
      notes: isAndroid
        ? 'Verified in-app updates, Share to Aerie, resumable sync, and more reliable Android Auto playback.'
        : 'Adaptive Direct Play video with quality, 5.1, chapters and remembered captions; cross-season episode navigation; and a controllable low-gap music queue with safe loudness normalization.',
    };
    const output = signRelease ? signRelease(release) : release;
    await writeSidecar(artifact.file, output);
    releases.push(output);
  }
  return releases;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await writeReleaseSidecars({ ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  main().catch(error => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
