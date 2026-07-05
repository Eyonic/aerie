// Native app downloads catalog. Reports which installers are available.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const r = Router();

// Maps a platform to the file it expects in the downloads dir (by extension/pattern).
const PLATFORMS: { key: string; label: string; match: RegExp; kind: string }[] = [
  { key: 'windows', label: 'Windows', match: /\.exe$/i, kind: 'Installer (.exe)' },
  { key: 'linux', label: 'Linux', match: /\.AppImage$/i, kind: 'AppImage' },
  { key: 'linux-deb', label: 'Linux (Debian/Ubuntu)', match: /\.deb$/i, kind: 'Package (.deb)' },
  { key: 'android', label: 'Android', match: /\.apk$/i, kind: 'APK' },
];

r.get('/', (_req, res) => {
  let files: string[] = [];
  try { files = fs.readdirSync(config.downloadsDir); } catch { /* dir may not exist yet */ }
  const out = PLATFORMS.map(p => {
    const file = files.find(f => p.match.test(f));
    let sizeBytes = 0;
    if (file) { try { sizeBytes = fs.statSync(path.join(config.downloadsDir, file)).size; } catch { /* */ } }
    return {
      key: p.key, label: p.label, kind: p.kind,
      available: !!file,
      url: file ? `/downloads/${encodeURIComponent(file)}` : null,
      filename: file || null,
      sizeBytes,
    };
  });
  res.json({ platforms: out });
});

export default r;
