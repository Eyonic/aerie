import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const rootDir = path.join(config.dataDir, 'time-machine');
const manifestRoot = path.join(rootDir, 'manifests');
const objectRoot = path.join(rootDir, 'objects');
const tempRoot = path.join(rootDir, 'tmp');
const restoreRoot = path.join(config.filesRoot, '.aerie-time-machine-tmp');

export const timeMachinePaths = Object.freeze({
  rootDir,
  manifestRoot,
  objectRoot,
  tempRoot,
  restoreRoot,
});

// Database startup and migration rehearsal must prepare the same filesystem
// roots before opening SQLite. Keeping this dependency-free and synchronous
// lets a rehearsal execute the real persistence path without importing the
// HTTP server, route modules, schedulers, or background workers.
export function bootstrapPersistenceDirectories(): void {
  for (const directory of [
    config.dataDir,
    config.versionsDir,
    config.generatedDir,
    config.subtitlesDir,
    config.thumbsDir,
    config.downloadsDir,
    config.filesRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [manifestRoot, objectRoot, tempRoot, restoreRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}
