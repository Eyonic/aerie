// Private, account-bound photo album sharing. A share id is only an identifier:
// every read is also constrained to the authenticated recipient, the active
// owner, the album, and the photo's current membership in that album.
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { rowToUser } from '../lib/auth.js';
import type { User } from '../lib/model.js';
import * as photolib from './photolib.js';

const MAX_ACTIVE_SHARES_PER_OWNER = 5000;

export interface PhotoAlbumShareAccess {
  share: {
    id: string;
    albumId: string;
    ownerUserId: number;
    recipientUserId: number;
    createdAt: string;
  };
  album: {
    id: string;
    name: string;
    description: string;
    coverPath: string | null;
    createdAt: string;
    updatedAt: string;
  };
  owner: User;
}

function httpError(code: string, status: number) {
  return Object.assign(new Error(code), { status });
}

function person(row: any) {
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatarColor: String(row.avatar_color),
  };
}

export function validatePhotoAlbumShareId(value: unknown): string {
  const id = String(value || '');
  if (!/^pas_[A-Za-z0-9_-]{32}$/.test(id)) throw httpError('not_found', 404);
  return id;
}

function ownedAlbum(ownerUserId: number, albumIdValue: unknown): any {
  const albumId = String(albumIdValue || '');
  if (!albumId || albumId.length > 128) throw httpError('album_not_found', 404);
  const row = db.prepare('SELECT * FROM photo_albums WHERE id=? AND user_id=?').get(albumId, ownerUserId) as any;
  if (!row) throw httpError('album_not_found', 404);
  return row;
}

function albumShape(row: any) {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    coverPath: row.cover_path ? String(row.cover_path) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function sharedAlbumAccess(recipientUserId: number, shareIdValue: unknown): PhotoAlbumShareAccess {
  const shareId = validatePhotoAlbumShareId(shareIdValue);
  const shareRow = db.prepare(`SELECT * FROM photo_album_shares
    WHERE id=? AND recipient_user_id=? AND revoked_at IS NULL`).get(shareId, recipientUserId) as any;
  // A guessed or revoked id reveals no more than a nonexistent one.
  if (!shareRow) throw httpError('not_found', 404);
  const albumRow = db.prepare('SELECT * FROM photo_albums WHERE id=? AND user_id=?')
    .get(shareRow.album_id, shareRow.owner_user_id) as any;
  const ownerRow = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL')
    .get(shareRow.owner_user_id) as any;
  if (!albumRow || !ownerRow) throw httpError('shared_album_unavailable', 404);
  const owner = rowToUser(ownerRow);
  if (owner.features?.photos === false) throw httpError('shared_album_unavailable', 404);
  return {
    share: {
      id: String(shareRow.id),
      albumId: String(shareRow.album_id),
      ownerUserId: Number(shareRow.owner_user_id),
      recipientUserId: Number(shareRow.recipient_user_id),
      createdAt: String(shareRow.created_at),
    },
    album: albumShape(albumRow),
    owner,
  };
}

export function listSharedAlbums(recipientUserId: number) {
  const rows = db.prepare(`SELECT
      s.id share_id,s.created_at shared_at,
      a.*,
      (SELECT COUNT(*) FROM photo_album_items i WHERE i.album_id=a.id AND i.user_id=a.user_id) item_count,
      COALESCE(a.cover_path,(
        SELECT newest.rel_path FROM photo_album_items newest
        JOIN photo_index p ON p.user_id=newest.user_id AND p.rel_path=newest.rel_path
        WHERE newest.album_id=a.id AND newest.user_id=a.user_id
        ORDER BY p.taken_at DESC,newest.added_at DESC LIMIT 1
      )) effective_cover,
      u.id owner_id,u.username owner_username,u.display_name owner_display_name,
      u.avatar_color owner_avatar_color,u.features owner_features
    FROM photo_album_shares s
    JOIN photo_albums a ON a.id=s.album_id AND a.user_id=s.owner_user_id
    JOIN users u ON u.id=s.owner_user_id AND u.disabled_at IS NULL
    WHERE s.recipient_user_id=? AND s.revoked_at IS NULL
    ORDER BY s.created_at DESC,s.id DESC`).all(recipientUserId) as any[];
  return rows.flatMap(row => {
    let features: Record<string, unknown> = {};
    try { features = JSON.parse(String(row.owner_features || '{}')); } catch { /* unavailable settings are treated as defaults */ }
    if (features.photos === false) return [];
    return [{
      ...albumShape({ ...row, cover_path: row.effective_cover }),
      itemCount: Number(row.item_count || 0),
      shareId: String(row.share_id),
      sharedAt: String(row.shared_at),
      owner: {
        id: Number(row.owner_id),
        username: String(row.owner_username),
        displayName: String(row.owner_display_name),
        avatarColor: String(row.owner_avatar_color),
      },
      permission: 'viewer' as const,
    }];
  });
}

export function listOwnedAlbumShares(ownerUserId: number, albumIdValue: unknown) {
  const album = ownedAlbum(ownerUserId, albumIdValue);
  const rows = db.prepare(`SELECT s.*,u.id recipient_id,u.username recipient_username,
      u.display_name recipient_display_name,u.avatar_color recipient_avatar_color,u.disabled_at recipient_disabled_at
    FROM photo_album_shares s
    JOIN users u ON u.id=s.recipient_user_id
    WHERE s.album_id=? AND s.owner_user_id=? AND s.revoked_at IS NULL
    ORDER BY s.created_at DESC,s.id DESC`).all(album.id, ownerUserId) as any[];
  return rows.map(row => ({
    id: String(row.id),
    albumId: String(row.album_id),
    createdAt: String(row.created_at),
    recipient: {
      id: Number(row.recipient_id),
      username: String(row.recipient_username),
      displayName: String(row.recipient_display_name),
      avatarColor: String(row.recipient_avatar_color),
      active: !row.recipient_disabled_at,
    },
    permission: 'viewer' as const,
  }));
}

export function createAlbumShare(owner: User, albumIdValue: unknown, recipientIdValue: unknown) {
  const album = ownedAlbum(owner.id, albumIdValue);
  const recipientId = Number(recipientIdValue);
  if (!Number.isSafeInteger(recipientId) || recipientId <= 0) throw httpError('invalid_recipient', 400);
  if (recipientId === owner.id) throw httpError('cannot_share_with_self', 400);
  const recipientRow = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(recipientId) as any;
  if (!recipientRow) throw httpError('recipient_not_found', 404);
  const recipient = rowToUser(recipientRow);
  if (recipient.features?.photos === false) throw httpError('recipient_photos_disabled', 409);
  const count = Number((db.prepare(`SELECT COUNT(*) count FROM photo_album_shares
    WHERE owner_user_id=? AND revoked_at IS NULL`).get(owner.id) as any)?.count || 0);
  if (count >= MAX_ACTIVE_SHARES_PER_OWNER) throw httpError('photo_album_share_limit_reached', 409);
  const id = `pas_${crypto.randomBytes(24).toString('base64url')}`;
  try {
    db.prepare(`INSERT INTO photo_album_shares
      (id,album_id,owner_user_id,recipient_user_id,created_by_user_id)
      VALUES (?,?,?,?,?)`).run(id, album.id, owner.id, recipient.id, owner.id);
  } catch (error: any) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw httpError('album_already_shared_with_recipient', 409);
    }
    throw error;
  }
  const saved = db.prepare('SELECT created_at FROM photo_album_shares WHERE id=?').get(id) as any;
  return {
    id,
    albumId: String(album.id),
    createdAt: String(saved.created_at),
    recipient: { ...person(recipientRow), active: true },
    permission: 'viewer' as const,
  };
}

export function revokeAlbumShare(ownerUserId: number, albumIdValue: unknown, shareIdValue: unknown) {
  const album = ownedAlbum(ownerUserId, albumIdValue);
  const shareId = validatePhotoAlbumShareId(shareIdValue);
  const row = db.prepare(`SELECT * FROM photo_album_shares
    WHERE id=? AND album_id=? AND owner_user_id=? AND revoked_at IS NULL`)
    .get(shareId, album.id, ownerUserId) as any;
  if (!row) throw httpError('not_found', 404);
  db.prepare(`UPDATE photo_album_shares SET revoked_at=datetime('now')
    WHERE id=? AND album_id=? AND owner_user_id=? AND revoked_at IS NULL`)
    .run(shareId, album.id, ownerUserId);
  return {
    id: shareId,
    albumId: String(album.id),
    albumName: String(album.name),
    recipientUserId: Number(row.recipient_user_id),
  };
}

export function sharedAlbumItems(access: PhotoAlbumShareAccess) {
  const rows = db.prepare(`SELECT p.* FROM photo_album_items i
    JOIN photo_index p ON p.user_id=i.user_id AND p.rel_path=i.rel_path
    WHERE i.album_id=? AND i.user_id=?
    ORDER BY p.taken_at DESC,i.added_at DESC,p.rel_path ASC LIMIT 20000`)
    .all(access.album.id, access.owner.id) as any[];
  return rows.map(row => ({
    path: String(row.rel_path),
    takenAt: row.taken_at ? String(row.taken_at) : null,
    width: row.width ?? null,
    height: row.height ?? null,
    size: Number(row.size || 0),
    camera: row.camera ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    // Favourites are personal owner metadata, not part of a shared album.
    favorite: false,
  }));
}

export function assertSharedAlbumPhoto(access: PhotoAlbumShareAccess, pathValue: unknown): string {
  const relPath = photolib.assertPhotoPath(String(pathValue || ''));
  const item = db.prepare(`SELECT 1 FROM photo_album_items
    WHERE album_id=? AND user_id=? AND rel_path=?`).get(access.album.id, access.owner.id, relPath);
  if (!item) throw httpError('not_found', 404);
  return relPath;
}

export const photoAlbumShareTestApi = { ownedAlbum };
