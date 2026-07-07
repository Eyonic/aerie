import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../lib/db.js';
import type { User } from '../lib/model.js';
import { config } from '../config.js';
import * as storage from './storage.js';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.avif', '.bmp', '.tiff']);
const running = new Map<number, Promise<number>>();
const lastScan = new Map<number, string>();

export interface NativePhoto {
  path: string;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  size: number;
  camera: string | null;
  lat: number | null;
  lon: number | null;
}

function isImageName(name: string): boolean {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

export function assertPhotoPath(relPath: string): string {
  const raw = String(relPath || '');
  if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.split('/').some(p => p === '..' || p === '.')) {
    throw Object.assign(new Error('bad_path'), { status: 400 });
  }
  const clean = path.posix.normalize(raw);
  if (!clean.startsWith('Photos/') || clean === 'Photos' || !isImageName(clean)) {
    throw Object.assign(new Error('bad_path'), { status: 400 });
  }
  return clean;
}

export function resolvePhoto(username: string, relPath: string): string {
  return storage.resolve(username, assertPhotoPath(relPath));
}

function rowToItem(row: any): NativePhoto {
  return {
    path: row.rel_path,
    takenAt: row.taken_at,
    width: row.width ?? null,
    height: row.height ?? null,
    size: row.size || 0,
    camera: row.camera ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
  };
}

function fallbackTakenAt(st: fs.Stats): string {
  return st.mtime.toISOString();
}

function readU16(b: Buffer, off: number, le: boolean) { return le ? b.readUInt16LE(off) : b.readUInt16BE(off); }
function readU32(b: Buffer, off: number, le: boolean) { return le ? b.readUInt32LE(off) : b.readUInt32BE(off); }

function exifValueOffset(b: Buffer, tiff: number, entry: number, le: boolean, bytes: number): number | null {
  const value = entry + 8;
  if (bytes <= 4) return value;
  const off = readU32(b, value, le);
  const abs = tiff + off;
  return abs >= 0 && abs + bytes <= b.length ? abs : null;
}

function readAscii(b: Buffer, tiff: number, entry: number, le: boolean): string | null {
  if (entry < 0 || entry + 12 > b.length) return null;
  const type = readU16(b, entry + 2, le);
  const count = readU32(b, entry + 4, le);
  if (type !== 2 || count < 1 || count > 4096) return null;
  const off = exifValueOffset(b, tiff, entry, le, count);
  if (off == null) return null;
  return b.subarray(off, off + count).toString('ascii').replace(/\0+$/, '').trim() || null;
}

function readRational(b: Buffer, off: number, le: boolean): number | null {
  if (off + 8 > b.length) return null;
  const n = readU32(b, off, le), d = readU32(b, off + 4, le);
  return d ? n / d : null;
}

function readGpsCoord(b: Buffer, tiff: number, entry: number, le: boolean): number | null {
  const type = readU16(b, entry + 2, le);
  const count = readU32(b, entry + 4, le);
  if (type !== 5 || count < 3) return null;
  const off = exifValueOffset(b, tiff, entry, le, count * 8);
  if (off == null) return null;
  const d = readRational(b, off, le), m = readRational(b, off + 8, le), s = readRational(b, off + 16, le);
  return d == null || m == null || s == null ? null : d + (m / 60) + (s / 3600);
}

function parseExifDate(v: string | null): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function findIfd(b: Buffer, tiff: number, ifd: number, le: boolean, wanted: number): number | null {
  if (ifd < 0 || ifd + 2 > b.length) return null;
  const n = readU16(b, ifd, le);
  for (let i = 0; i < n; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) break;
    if (readU16(b, entry, le) === wanted) return entry;
  }
  return null;
}

function parseExif(exif?: Buffer): { takenAt?: string; camera?: string; lat?: number; lon?: number } {
  if (!exif || exif.length < 14) return {};
  const tiff = exif.subarray(0, 6).toString('ascii') === 'Exif\0\0' ? 6 : 0;
  const endian = exif.subarray(tiff, tiff + 2).toString('ascii');
  const le = endian === 'II';
  if (!le && endian !== 'MM') return {};
  if (readU16(exif, tiff + 2, le) !== 42) return {};
  const ifd0 = tiff + readU32(exif, tiff + 4, le);
  const make = readAscii(exif, tiff, findIfd(exif, tiff, ifd0, le, 0x010f) ?? -1, le);
  const model = readAscii(exif, tiff, findIfd(exif, tiff, ifd0, le, 0x0110) ?? -1, le);
  const exifPtr = findIfd(exif, tiff, ifd0, le, 0x8769);
  const gpsPtr = findIfd(exif, tiff, ifd0, le, 0x8825);
  let takenAt: string | null = null, lat: number | null = null, lon: number | null = null;
  if (exifPtr) {
    const sub = tiff + readU32(exif, exifPtr + 8, le);
    takenAt = parseExifDate(readAscii(exif, tiff, findIfd(exif, tiff, sub, le, 0x9003) ?? -1, le));
  }
  if (gpsPtr) {
    const gps = tiff + readU32(exif, gpsPtr + 8, le);
    const latRef = readAscii(exif, tiff, findIfd(exif, tiff, gps, le, 1) ?? -1, le);
    const latEntry = findIfd(exif, tiff, gps, le, 2);
    const lonRef = readAscii(exif, tiff, findIfd(exif, tiff, gps, le, 3) ?? -1, le);
    const lonEntry = findIfd(exif, tiff, gps, le, 4);
    lat = latEntry ? readGpsCoord(exif, tiff, latEntry, le) : null;
    lon = lonEntry ? readGpsCoord(exif, tiff, lonEntry, le) : null;
    if (lat != null && latRef === 'S') lat = -lat;
    if (lon != null && lonRef === 'W') lon = -lon;
  }
  const camera = [make, model].filter(Boolean).join(' ') || undefined;
  return { takenAt: takenAt || undefined, camera, lat: lat ?? undefined, lon: lon ?? undefined };
}

export async function indexFile(user: User, relPath: string): Promise<NativePhoto | null> {
  const clean = assertPhotoPath(relPath);
  const real = resolvePhoto(user.username, clean);
  const st = await fsp.stat(real);
  if (!st.isFile()) return null;
  let width: number | null = null, height: number | null = null, camera: string | null = null;
  let lat: number | null = null, lon: number | null = null, takenAt: string | null = fallbackTakenAt(st);
  try {
    const meta = await sharp(real, { failOn: 'none' }).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    const exif = parseExif(meta.exif);
    takenAt = exif.takenAt || takenAt;
    camera = exif.camera || null;
    lat = exif.lat ?? null;
    lon = exif.lon ?? null;
  } catch { /* unsupported image: keep filesystem metadata */ }
  db.prepare(`INSERT INTO photo_index
    (user_id,rel_path,taken_at,width,height,size,camera,lat,lon,mtime)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,rel_path) DO UPDATE SET
      taken_at=excluded.taken_at,width=excluded.width,height=excluded.height,size=excluded.size,
      camera=excluded.camera,lat=excluded.lat,lon=excluded.lon,mtime=excluded.mtime`)
    .run(user.id, clean, takenAt, width, height, st.size, camera, lat, lon, Math.floor(st.mtimeMs));
  return rowToItem({ rel_path: clean, taken_at: takenAt, width, height, size: st.size, camera, lat, lon });
}

async function walkPhotos(dir: string, root: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkPhotos(full, root, out);
    else if (e.isFile() && isImageName(e.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

async function runScan(user: User): Promise<number> {
  const root = storage.userRoot(user.username);
  const photosRoot = path.join(root, 'Photos');
  const found: string[] = [];
  await walkPhotos(photosRoot, root, found);
  const live = new Set(found);
  for (const rel of found) {
    try {
      const st = await fsp.stat(path.join(root, rel));
      const old = db.prepare('SELECT size,mtime FROM photo_index WHERE user_id=? AND rel_path=?').get(user.id, rel) as any;
      if (!old || old.size !== st.size || old.mtime !== Math.floor(st.mtimeMs)) await indexFile(user, rel);
    } catch { /* per-file failure must not abort scans */ }
  }
  const rows = db.prepare('SELECT rel_path FROM photo_index WHERE user_id=?').all(user.id) as any[];
  const del = db.prepare('DELETE FROM photo_index WHERE user_id=? AND rel_path=?');
  for (const row of rows) if (!live.has(row.rel_path)) del.run(user.id, row.rel_path);
  const count = countPhotos(user.id);
  lastScan.set(user.id, new Date().toISOString());
  return count;
}

export function scan(user: User): Promise<number> {
  const existing = running.get(user.id);
  if (existing) return existing;
  const p = runScan(user).finally(() => running.delete(user.id));
  running.set(user.id, p);
  return p;
}

export function countPhotos(userId: number): number {
  return (db.prepare('SELECT COUNT(*) c FROM photo_index WHERE user_id=?').get(userId) as any).c || 0;
}

export function status(userId: number) {
  return { enabled: true, count: countPhotos(userId), lastScan: lastScan.get(userId) || null };
}

export function timeline(user: User, opts: { cursor?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 500));
  let cursor: { takenAt: string; path: string } | null = null;
  if (opts.cursor) {
    try { cursor = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')); } catch { cursor = null; }
  }
  const rows = cursor
    ? db.prepare(`SELECT * FROM photo_index WHERE user_id=? AND (taken_at < ? OR (taken_at = ? AND rel_path > ?))
        ORDER BY taken_at DESC, rel_path ASC LIMIT ?`).all(user.id, cursor.takenAt, cursor.takenAt, cursor.path, limit + 1) as any[]
    : db.prepare('SELECT * FROM photo_index WHERE user_id=? ORDER BY taken_at DESC, rel_path ASC LIMIT ?').all(user.id, limit + 1) as any[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(rowToItem),
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ takenAt: last.taken_at, path: last.rel_path })).toString('base64url')
      : null,
  };
}

export function months(userId: number) {
  return db.prepare(`SELECT substr(taken_at,1,7) month, COUNT(*) count
    FROM photo_index WHERE user_id=? AND taken_at IS NOT NULL GROUP BY month ORDER BY month DESC`).all(userId);
}

// Geotagged photos for the Places map (newest first). Capped so a huge library
// stays responsive on the client; the map clusters them anyway.
export function geo(userId: number) {
  return db.prepare(`SELECT rel_path path, lat, lon, taken_at takenAt
    FROM photo_index WHERE user_id=? AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY taken_at DESC, rel_path ASC LIMIT 5000`).all(userId);
}

export async function thumb(user: User, relPath: string): Promise<string> {
  const clean = assertPhotoPath(relPath);
  const src = resolvePhoto(user.username, clean);
  const st = await fsp.stat(src);
  const dir = path.join(config.thumbsDir, 'photos', String(user.id));
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, crypto.createHash('sha1').update(clean).digest('hex') + '.webp');
  try {
    const cached = await fsp.stat(dest);
    if (cached.mtimeMs >= st.mtimeMs) return dest;
  } catch { /* cache miss */ }
  try {
    await sharp(src, { failOn: 'none' }).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 70 }).toFile(dest);
    return dest;
  } catch {
    throw Object.assign(new Error('unsupported_media'), { status: 415 });
  }
}
