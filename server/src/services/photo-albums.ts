import crypto from 'node:crypto';
import { db } from '../lib/db.js';

const MAX_ALBUMS = 500;
const MAX_ALBUM_ITEMS = 20_000;
const MAX_BATCH = 500;

function cleanName(value: unknown): string {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 100) throw Object.assign(new Error('invalid_album_name'), { status: 400 });
  return name;
}

function cleanDescription(value: unknown): string {
  const description = String(value || '').replace(/\u0000/g, '').trim();
  if (description.length > 1000) throw Object.assign(new Error('invalid_album_description'), { status: 400 });
  return description;
}

function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH) {
    throw Object.assign(new Error('invalid_photo_selection'), { status: 400 });
  }
  const paths = [...new Set(value.map(path => String(path || '')))];
  if (paths.some(path => !path || path.length > 4096)) {
    throw Object.assign(new Error('invalid_photo_selection'), { status: 400 });
  }
  return paths;
}

function ownedAlbum(userId: number, albumId: string): any {
  const album = db.prepare('SELECT * FROM photo_albums WHERE id=? AND user_id=?').get(albumId, userId) as any;
  if (!album) throw Object.assign(new Error('album_not_found'), { status: 404 });
  return album;
}

function mapAlbum(row: any) {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    coverPath: row.cover_path || null,
    itemCount: Number(row.item_count || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPhoto(row: any) {
  return {
    path: row.rel_path,
    takenAt: row.taken_at,
    width: row.width ?? null,
    height: row.height ?? null,
    size: Number(row.size || 0),
    camera: row.camera ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    favorite: !!row.favorite,
  };
}

export function listAlbums(userId: number) {
  const rows = db.prepare(`SELECT a.*,
    COUNT(i.rel_path) item_count,
    COALESCE(a.cover_path,(
      SELECT newest.rel_path FROM photo_album_items newest
      JOIN photo_index p ON p.user_id=newest.user_id AND p.rel_path=newest.rel_path
      WHERE newest.album_id=a.id ORDER BY p.taken_at DESC,newest.added_at DESC LIMIT 1
    )) effective_cover
    FROM photo_albums a LEFT JOIN photo_album_items i ON i.album_id=a.id
    WHERE a.user_id=? GROUP BY a.id ORDER BY a.updated_at DESC,a.name COLLATE NOCASE`)
    .all(userId) as any[];
  return rows.map(row => ({ ...mapAlbum({ ...row, cover_path: row.effective_cover }), itemCount: Number(row.item_count || 0) }));
}

export function createAlbum(userId: number, input: { name?: unknown; description?: unknown }) {
  const count = (db.prepare('SELECT COUNT(*) count FROM photo_albums WHERE user_id=?').get(userId) as any).count;
  if (Number(count) >= MAX_ALBUMS) throw Object.assign(new Error('album_limit_reached'), { status: 409 });
  const id = `pa_${crypto.randomBytes(18).toString('base64url')}`;
  db.prepare('INSERT INTO photo_albums(id,user_id,name,description) VALUES(?,?,?,?)')
    .run(id, userId, cleanName(input.name), cleanDescription(input.description));
  return mapAlbum(db.prepare('SELECT *,0 item_count FROM photo_albums WHERE id=?').get(id));
}

export function updateAlbum(userId: number, albumId: string, input: {
  name?: unknown; description?: unknown; coverPath?: unknown;
}) {
  const album = ownedAlbum(userId, albumId);
  const name = input.name === undefined ? album.name : cleanName(input.name);
  const description = input.description === undefined ? album.description : cleanDescription(input.description);
  let coverPath = album.cover_path as string | null;
  if (input.coverPath !== undefined) {
    coverPath = input.coverPath === null || input.coverPath === '' ? null : String(input.coverPath);
    if (coverPath && !db.prepare(`SELECT 1 FROM photo_album_items
      WHERE album_id=? AND user_id=? AND rel_path=?`).get(albumId, userId, coverPath)) {
      throw Object.assign(new Error('album_cover_not_found'), { status: 400 });
    }
  }
  db.prepare(`UPDATE photo_albums SET name=?,description=?,cover_path=?,updated_at=datetime('now')
    WHERE id=? AND user_id=?`).run(name, description, coverPath, albumId, userId);
  const row = db.prepare(`SELECT a.*,(SELECT COUNT(*) FROM photo_album_items WHERE album_id=a.id) item_count
    FROM photo_albums a WHERE a.id=? AND a.user_id=?`).get(albumId, userId);
  return mapAlbum(row);
}

export function deleteAlbum(userId: number, albumId: string): boolean {
  return db.prepare('DELETE FROM photo_albums WHERE id=? AND user_id=?').run(albumId, userId).changes === 1;
}

export function albumItems(userId: number, albumId: string) {
  ownedAlbum(userId, albumId);
  return (db.prepare(`SELECT p.* FROM photo_album_items i
    JOIN photo_index p ON p.user_id=i.user_id AND p.rel_path=i.rel_path
    WHERE i.album_id=? AND i.user_id=?
    ORDER BY p.taken_at DESC,i.added_at DESC,p.rel_path ASC LIMIT ?`)
    .all(albumId, userId, MAX_ALBUM_ITEMS) as any[]).map(mapPhoto);
}

export function addAlbumItems(userId: number, albumId: string, rawPaths: unknown) {
  ownedAlbum(userId, albumId);
  const paths = cleanPaths(rawPaths);
  const current = Number((db.prepare('SELECT COUNT(*) count FROM photo_album_items WHERE album_id=?').get(albumId) as any).count);
  const exists = db.prepare('SELECT 1 FROM photo_index WHERE user_id=? AND rel_path=?');
  for (const relPath of paths) if (!exists.get(userId, relPath)) {
    throw Object.assign(new Error('photo_not_found'), { status: 404 });
  }
  const alreadyAdded = db.prepare('SELECT 1 FROM photo_album_items WHERE album_id=? AND rel_path=?');
  const newCount = paths.reduce((total, relPath) => total + (alreadyAdded.get(albumId, relPath) ? 0 : 1), 0);
  if (current + newCount > MAX_ALBUM_ITEMS) throw Object.assign(new Error('album_item_limit_reached'), { status: 409 });
  const insert = db.prepare(`INSERT OR IGNORE INTO photo_album_items(album_id,user_id,rel_path)
    VALUES(?,?,?)`);
  const add = db.transaction(() => {
    let added = 0;
    for (const relPath of paths) added += insert.run(albumId, userId, relPath).changes;
    db.prepare("UPDATE photo_albums SET updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(albumId, userId);
    return added;
  });
  return { added: add() };
}

export function removeAlbumItems(userId: number, albumId: string, rawPaths: unknown) {
  ownedAlbum(userId, albumId);
  const paths = cleanPaths(rawPaths);
  const remove = db.prepare('DELETE FROM photo_album_items WHERE album_id=? AND user_id=? AND rel_path=?');
  const run = db.transaction(() => {
    let removed = 0;
    for (const relPath of paths) removed += remove.run(albumId, userId, relPath).changes;
    const coverRemoved = paths.includes(String(ownedAlbum(userId, albumId).cover_path || ''));
    db.prepare(`UPDATE photo_albums SET cover_path=CASE WHEN ? THEN NULL ELSE cover_path END,
      updated_at=datetime('now') WHERE id=? AND user_id=?`)
      .run(coverRemoved ? 1 : 0, albumId, userId);
    return removed;
  });
  return { removed: run() };
}

export function setFavorite(userId: number, relPath: string, favorite: boolean) {
  const result = db.prepare('UPDATE photo_index SET favorite=? WHERE user_id=? AND rel_path=?')
    .run(favorite ? 1 : 0, userId, relPath);
  if (!result.changes) throw Object.assign(new Error('photo_not_found'), { status: 404 });
  return { path: relPath, favorite };
}

export function favorites(userId: number, limit = 1000) {
  const bounded = Math.max(1, Math.min(Number(limit) || 1000, 5000));
  return (db.prepare(`SELECT * FROM photo_index WHERE user_id=? AND favorite=1
    ORDER BY taken_at DESC,rel_path ASC LIMIT ?`).all(userId, bounded) as any[]).map(mapPhoto);
}

export const photoAlbumTestApi = { cleanName, cleanDescription, cleanPaths };
