import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type DesktopReleaseKey,
  type DesktopReleasePlatform,
  verifyDesktopReleaseSignature,
} from './release-signature.js';

export type ReleasePlatform = 'windows' | 'linux' | 'linux-deb' | 'android';

export type PublishedRelease = {
  key: ReleasePlatform;
  label: string;
  kind: string;
  available: boolean;
  url: string | null;
  filename: string | null;
  sizeBytes: number;
  sha256: string | null;
  version: string | null;
  build: number | null;
  certificateSha256: string | null;
  minServerVersion: string | null;
  publishedAt: string | null;
  notes: string | null;
  signatureAlgorithm: string | null;
  signatureKeyId: string | null;
  signature: string | null;
  verified: boolean;
  signatureVerified: boolean;
};

type ManifestRelease = {
  platform?: unknown;
  filename?: unknown;
  version?: unknown;
  build?: unknown;
  sha256?: unknown;
  sizeBytes?: unknown;
  certificateSha256?: unknown;
  minServerVersion?: unknown;
  publishedAt?: unknown;
  notes?: unknown;
  signatureAlgorithm?: unknown;
  signatureKeyId?: unknown;
  signature?: unknown;
};

type ReleaseManifest = {
  schemaVersion?: unknown;
  releases?: Partial<Record<ReleasePlatform, ManifestRelease>>;
};

type AvailableFile = {
  name: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
};

type PlatformDefinition = {
  key: ReleasePlatform;
  label: string;
  kind: string;
  match: RegExp;
  preference?: RegExp;
};

type Candidate = PublishedRelease & {
  mtimeMs: number;
  preference: number;
  source: 'manifest' | 'sidecar' | 'file';
  trusted: boolean;
};

const MANIFEST_FILENAME = 'aerie-releases.json';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_HASH_CACHE_ENTRIES = 256;
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const PLATFORMS: PlatformDefinition[] = [
  { key: 'windows', label: 'Windows', match: /\.exe$/i, kind: 'Installer (.exe)', preference: /setup/i },
  { key: 'linux', label: 'Linux', match: /\.AppImage$/i, kind: 'AppImage' },
  { key: 'linux-deb', label: 'Linux (Debian/Ubuntu)', match: /\.deb$/i, kind: 'Package (.deb)' },
  { key: 'android', label: 'Android', match: /\.apk$/i, kind: 'APK' },
];

const hashCache = new Map<string, {
  identity: string;
  digest?: string;
  pending?: Promise<string>;
}>();

function boundedString(value: unknown, max = 240, trim = true, empty = false): string | null {
  if (typeof value !== 'string') return null;
  const clean = trim ? value.trim() : value;
  return (clean || empty) && clean.length <= max && !clean.includes('\0') && !clean.includes('\r') ? clean : null;
}

function safeFilename(value: unknown): string | null {
  const candidate = boundedString(value, 180, false);
  if (!candidate || candidate.trim() !== candidate || candidate !== path.basename(candidate)
      || candidate === '.' || candidate === '..' || /[\\/\n\x00-\x1f]/.test(candidate)) return null;
  return candidate;
}

function fileIdentity(stat: AvailableFile): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function sameIdentity(left: AvailableFile, right: AvailableFile): boolean {
  return fileIdentity(left) === fileIdentity(right);
}

async function statRegular(file: string): Promise<AvailableFile> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('release_artifact_not_regular');
  return {
    name: path.basename(file), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    ino: stat.ino, dev: stat.dev,
  };
}

async function sha256(file: string, stat: AvailableFile): Promise<string> {
  const identity = fileIdentity(stat);
  const cached = hashCache.get(file);
  if (cached?.identity === identity) {
    if (cached.digest) return cached.digest;
    if (cached.pending) return cached.pending;
  }
  const pending = new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  }).then(async digest => {
    const after = await statRegular(file);
    if (!sameIdentity(stat, after)) throw new Error('release_artifact_changed_during_hash');
    return digest;
  });
  hashCache.set(file, { identity, pending });
  try {
    const digest = await pending;
    hashCache.delete(file);
    hashCache.set(file, { identity, digest });
    while (hashCache.size > MAX_HASH_CACHE_ENTRIES) {
      const oldest = hashCache.keys().next().value;
      if (typeof oldest !== 'string') break;
      hashCache.delete(oldest);
    }
    return digest;
  } catch (error) {
    if (hashCache.get(file)?.pending === pending) hashCache.delete(file);
    throw error;
  }
}

async function readManifest(downloadsDir: string): Promise<ReleaseManifest | null> {
  const manifestPath = path.join(downloadsDir, MANIFEST_FILENAME);
  try {
    const stat = await fsp.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as ReleaseManifest;
    if (parsed?.schemaVersion !== 1 || !parsed.releases || typeof parsed.releases !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readSidecar(downloadsDir: string, filename: string): Promise<ManifestRelease | null> {
  const sidecarPath = path.join(downloadsDir, `${filename}.release.json`);
  try {
    const stat = await fsp.lstat(sidecarPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(await fsp.readFile(sidecarPath, 'utf8')) as {
      schemaVersion?: unknown;
      release?: ManifestRelease;
    };
    if (parsed?.schemaVersion !== 1 || !parsed.release || typeof parsed.release !== 'object') return null;
    return parsed.release;
  } catch {
    return null;
  }
}

async function availableFiles(downloadsDir: string): Promise<AvailableFile[]> {
  try {
    const entries = await fsp.readdir(downloadsDir, { withFileTypes: true });
    const files: AvailableFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === MANIFEST_FILENAME) continue;
      try { files.push(await statRegular(path.join(downloadsDir, entry.name))); }
      catch { /* file changed while listing */ }
    }
    return files;
  } catch {
    return [];
  }
}

function validVersion(value: unknown): string | null {
  const version = boundedString(value, 48, false);
  return version && VERSION.test(version) ? version : null;
}

function validPublishedAt(value: unknown): string | null {
  const publishedAt = boundedString(value, 48, false);
  return publishedAt && ISO_DATE.test(publishedAt) && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null;
}

function numericBuild(value: unknown): number | null {
  const build = Number(value);
  return Number.isSafeInteger(build) && build >= 0 ? build : null;
}

function syntaxSignature(declared: ManifestRelease | null) {
  const algorithm = boundedString(declared?.signatureAlgorithm, 24, false);
  const keyId = boundedString(declared?.signatureKeyId, 64, false);
  const signature = boundedString(declared?.signature, 128, false);
  return {
    signatureAlgorithm: algorithm === 'Ed25519' ? algorithm : null,
    signatureKeyId: keyId && SHA256.test(keyId) ? keyId.toLowerCase() : null,
    signature: signature && ED25519_SIGNATURE.test(signature) ? signature : null,
  };
}

async function candidateForDeclaration(
  platform: PlatformDefinition,
  file: AvailableFile,
  actualHash: string,
  declared: ManifestRelease | null,
  source: Candidate['source'],
  desktopReleaseKey?: DesktopReleaseKey,
): Promise<Candidate> {
  const declaredName = safeFilename(declared?.filename);
  // Adjacent Android sidecars from the Gradle output retain app-release.apk
  // when the published APK is renamed. The adjacent path and hash still bind
  // that unsigned metadata. Desktop signatures always bind the exact name.
  const nameMatches = declaredName === file.name
    || (platform.key === 'android' && source === 'sidecar' && Boolean(declaredName));
  const declaredHash = boundedString(declared?.sha256, 64, false)?.toLowerCase() || null;
  const verified = Boolean(declared && nameMatches && declaredHash && SHA256.test(declaredHash)
    && crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(declaredHash, 'hex')));
  const certificate = boundedString(declared?.certificateSha256, 64, false);
  const minServerVersion = validVersion(declared?.minServerVersion);
  const signatures = syntaxSignature(declared);
  let signatureVerified = false;

  if (platform.key !== 'android' && declared) {
    const signed = verifyDesktopReleaseSignature(declared, platform.key as DesktopReleasePlatform, desktopReleaseKey);
    signatureVerified = Boolean(signed && signed.filename === file.name && signed.sha256 === actualHash
      && signed.sizeBytes === file.size);
  }

  return {
    key: platform.key,
    label: platform.label,
    kind: platform.kind,
    available: true,
    url: `/downloads/${encodeURIComponent(file.name)}`,
    filename: file.name,
    sizeBytes: file.size,
    sha256: actualHash,
    version: validVersion(declared?.version),
    build: numericBuild(declared?.build),
    certificateSha256: certificate && SHA256.test(certificate) ? certificate.toLowerCase() : null,
    minServerVersion,
    publishedAt: validPublishedAt(declared?.publishedAt),
    notes: boundedString(declared?.notes, 500, false, true),
    ...signatures,
    verified,
    signatureVerified,
    trusted: platform.key === 'android'
      ? Boolean(verified && certificate && SHA256.test(certificate))
      : signatureVerified,
    source,
    mtimeMs: file.mtimeMs,
    preference: platform.preference?.test(file.name) ? 1 : 0,
  };
}

function semverParts(value: string | null): { core: number[]; prerelease: Array<number | string> | null } | null {
  if (!value || !VERSION.test(value)) return null;
  const withoutBuild = value.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map(Number);
  while (core.length < 4) core.push(0);
  const prerelease = dash < 0 ? null : withoutBuild.slice(dash + 1).split('.').map(part => (
    /^\d+$/.test(part) && Number.isSafeInteger(Number(part)) ? Number(part) : part
  ));
  return { core, prerelease };
}

function compareVersions(left: string | null, right: string | null): number {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 4; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
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

function compareCandidates(left: Candidate, right: Candidate): number {
  const build = (left.build ?? -1) - (right.build ?? -1);
  if (build) return build;
  const version = compareVersions(left.version, right.version);
  if (version) return version;
  const published = (Date.parse(left.publishedAt || '') || 0) - (Date.parse(right.publishedAt || '') || 0);
  if (published) return published;
  if (left.preference !== right.preference) return left.preference - right.preference;
  if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs;
  if (left.source !== right.source) return left.source === 'sidecar' ? 1 : -1;
  return left.filename!.localeCompare(right.filename!);
}

function strongest(candidates: Candidate[]): Candidate {
  const trusted = candidates.filter(item => item.trusted);
  const verified = candidates.filter(item => item.verified);
  return [...(trusted.length ? trusted : verified.length ? verified : candidates)].sort(compareCandidates).at(-1)!;
}

function unavailable(platform: PlatformDefinition): PublishedRelease {
  return {
    key: platform.key, label: platform.label, kind: platform.kind,
    available: false, url: null, filename: null, sizeBytes: 0, sha256: null,
    version: null, build: null, certificateSha256: null, minServerVersion: null,
    publishedAt: null, notes: null, signatureAlgorithm: null, signatureKeyId: null,
    signature: null, verified: false, signatureVerified: false,
  };
}

export async function releaseCatalog(
  downloadsDir: string,
  options: { desktopReleaseKey?: DesktopReleaseKey } = {},
): Promise<{ schemaVersion: 1; platforms: PublishedRelease[] }> {
  const [manifest, files] = await Promise.all([readManifest(downloadsDir), availableFiles(downloadsDir)]);

  const platforms = await Promise.all(PLATFORMS.map(async platform => {
    const matching = files.filter(file => platform.match.test(file.name));
    if (!matching.length) return unavailable(platform);
    const manifestRelease = manifest?.releases?.[platform.key] || null;
    const manifestName = safeFilename(manifestRelease?.filename);
    const candidates: Candidate[] = [];

    for (const file of matching) {
      try {
        const actualHash = await sha256(path.join(downloadsDir, file.name), file);
        const sidecar = await readSidecar(downloadsDir, file.name);
        if (sidecar) candidates.push(await candidateForDeclaration(
          platform, file, actualHash, sidecar, 'sidecar', options.desktopReleaseKey,
        ));
        if (manifestRelease && manifestName === file.name) candidates.push(await candidateForDeclaration(
          platform, file, actualHash, manifestRelease, 'manifest', options.desktopReleaseKey,
        ));
        if (!sidecar && !(manifestRelease && manifestName === file.name)) candidates.push(await candidateForDeclaration(
          platform, file, actualHash, null, 'file', options.desktopReleaseKey,
        ));
      } catch { /* an artifact changing mid-scan is not publishable yet */ }
    }
    if (!candidates.length) return unavailable(platform);
    const selected = strongest(candidates);
    const { trusted: _trusted, source: _source, mtimeMs: _mtimeMs, preference: _preference, ...published } = selected;
    return published;
  }));

  return { schemaVersion: 1, platforms };
}

export const releaseCatalogInternals = {
  compareCandidates,
  fileIdentity,
};
