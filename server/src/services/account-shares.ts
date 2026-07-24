// Authenticated household sharing.  This service is the only place that turns
// a recipient-controlled, share-relative path into an owner's storage path.
// Keeping that boundary narrow makes it much harder for a route to accidentally
// resolve a recipient path against the wrong account or escape the granted root.
import path from 'node:path';
import type { FileEntry, FileListing, User } from '../lib/model.js';
import { db } from '../lib/db.js';
import { findUserById, rowToUser } from '../lib/auth.js';
import { validateVirtualPath } from '../lib/validation.js';
import * as storage from './storage.js';

export type AccountSharePermission = 'viewer' | 'editor';

export interface AccountShareGrant {
  id: string;
  ownerUserId: number;
  recipientUserId: number;
  rootPath: string;
  permission: AccountSharePermission;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface AccountShareAccess {
  grant: AccountShareGrant;
  owner: User;
  actor: User;
}

export interface AccountShareSummary {
  id: string;
  name: string;
  permission: AccountSharePermission;
  isFolder: boolean | null;
  sizeBytes: number | null;
  available: boolean;
  createdAt: string;
  updatedAt: string;
  owner?: { id: number; username: string; displayName: string; avatarColor: string };
  recipient?: { id: number; username: string; displayName: string; avatarColor: string; active: boolean };
  rootPath?: string;
}

function httpError(code: string, status: number) {
  return Object.assign(new Error(code), { status });
}

export function validateAccountShareId(value: unknown): string {
  const id = String(value || '');
  if (!/^as_[A-Za-z0-9_-]{32}$/.test(id)) throw httpError('not_found', 404);
  return id;
}

export function rowToAccountShare(row: any): AccountShareGrant {
  return {
    id: String(row.id),
    ownerUserId: Number(row.owner_user_id),
    recipientUserId: Number(row.recipient_user_id),
    rootPath: validateVirtualPath(String(row.root_path)),
    permission: row.permission === 'editor' ? 'editor' : 'viewer',
    createdByUserId: Number(row.created_by_user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

function activeGrantForRecipient(actorId: number, shareId: string): AccountShareGrant | null {
  const row = db.prepare(`SELECT * FROM account_shares
    WHERE id=? AND recipient_user_id=? AND revoked_at IS NULL`).get(shareId, actorId) as any;
  return row ? rowToAccountShare(row) : null;
}

function activeUser(userId: number): User | null {
  const row = findUserById(userId);
  return row ? rowToUser(row) : null;
}

export function accountShareAccess(actor: User, shareIdValue: unknown,
  options: { editor?: boolean } = {}): AccountShareAccess {
  const shareId = validateAccountShareId(shareIdValue);
  const grant = activeGrantForRecipient(actor.id, shareId);
  // Recipient grants are not capabilities: a guessed id must reveal nothing.
  if (!grant) throw httpError('not_found', 404);
  if (options.editor && grant.permission !== 'editor') throw httpError('shared_space_read_only', 403);
  const owner = activeUser(grant.ownerUserId);
  if (!owner || owner.features?.files === false) throw httpError('shared_space_unavailable', 404);
  return { grant, owner, actor };
}

/** Validate a path relative to a grant. Absolute paths, dot segments,
 * backslashes and overlong input are rejected instead of normalized away. */
export function normalizeShareRelativePath(value: unknown, options: { allowRoot?: boolean } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (options.allowRoot === false) throw httpError('shared_path_required', 400);
    return '';
  }
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || value.includes('\\')
    || value.startsWith('/') || value.split('/').some(segment => segment === '.' || segment === '..')) {
    throw httpError('invalid_shared_path', 400);
  }
  const normalized = path.posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') {
    if (options.allowRoot === false) throw httpError('shared_path_required', 400);
    return '';
  }
  if (normalized === '..' || normalized.startsWith('../')) throw httpError('invalid_shared_path', 400);
  return normalized;
}

export function ownerPathForGrant(grant: AccountShareGrant, relativeValue: unknown,
  options: { allowRoot?: boolean } = {}): { ownerPath: string; relativePath: string } {
  const relativePath = normalizeShareRelativePath(relativeValue, options);
  const root = validateVirtualPath(grant.rootPath);
  const ownerPath = relativePath ? path.posix.join(root, relativePath) : root;
  if (ownerPath !== root && !ownerPath.startsWith(root + '/')) throw httpError('invalid_shared_path', 400);
  return { ownerPath, relativePath };
}

function person(user: User) {
  return { id: user.id, username: user.username, displayName: user.displayName, avatarColor: user.avatarColor };
}

async function targetSummary(grant: AccountShareGrant, knownOwner?: User): Promise<Pick<AccountShareSummary,
  'name' | 'isFolder' | 'sizeBytes' | 'available'>> {
  try {
    const owner = knownOwner || activeUser(grant.ownerUserId);
    if (!owner || owner.features?.files === false) throw new Error('unavailable');
    const { stat } = await storage.statRealAsync(owner.username, grant.rootPath);
    return {
      name: path.posix.basename(grant.rootPath),
      isFolder: stat.isDirectory(),
      sizeBytes: stat.isFile() ? stat.size : null,
      available: stat.isDirectory() || stat.isFile(),
    };
  } catch {
    return { name: path.posix.basename(grant.rootPath), isFolder: null, sizeBytes: null, available: false };
  }
}

export async function receivedAccountShares(actor: User): Promise<AccountShareSummary[]> {
  const rows = db.prepare(`SELECT * FROM account_shares
    WHERE recipient_user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC`).all(actor.id) as any[];
  const summaries: AccountShareSummary[] = [];
  for (let offset = 0; offset < rows.length; offset += 32) {
    const batch = await Promise.all(rows.slice(offset, offset + 32).map(async row => {
      const grant = rowToAccountShare(row);
      const owner = activeUser(grant.ownerUserId);
      if (!owner) return null;
      return {
        id: grant.id,
        permission: grant.permission,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
        owner: person(owner),
        ...(await targetSummary(grant, owner)),
      } satisfies AccountShareSummary;
    }));
    summaries.push(...batch.filter(Boolean) as AccountShareSummary[]);
  }
  return summaries;
}

export async function ownedAccountShares(owner: User): Promise<AccountShareSummary[]> {
  const rows = db.prepare(`SELECT * FROM account_shares
    WHERE owner_user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC`).all(owner.id) as any[];
  const summaries: AccountShareSummary[] = [];
  for (let offset = 0; offset < rows.length; offset += 32) {
    const batch = await Promise.all(rows.slice(offset, offset + 32).map(async row => {
      const grant = rowToAccountShare(row);
      const recipientRow = db.prepare('SELECT * FROM users WHERE id=?').get(grant.recipientUserId) as any;
      if (!recipientRow) return null;
      const recipient = rowToUser(recipientRow);
      return {
        id: grant.id,
        permission: grant.permission,
        rootPath: grant.rootPath,
        createdAt: grant.createdAt,
        updatedAt: grant.updatedAt,
        recipient: { ...person(recipient), active: !recipient.disabledAt },
        ...(await targetSummary(grant, owner)),
      } satisfies AccountShareSummary;
    }));
    summaries.push(...batch.filter(Boolean) as AccountShareSummary[]);
  }
  return summaries;
}

function shareRelative(grant: AccountShareGrant, ownerPath: string): string {
  if (ownerPath === grant.rootPath) return '';
  if (!ownerPath.startsWith(grant.rootPath + '/')) throw httpError('invalid_shared_path', 500);
  return ownerPath.slice(grant.rootPath.length + 1);
}

function sharedEntry(access: AccountShareAccess, entry: FileEntry): FileEntry {
  const relative = shareRelative(access.grant, entry.path);
  const parent = relative ? path.posix.dirname(relative) : '';
  return {
    ...entry,
    id: Buffer.from(`${access.grant.id}:${relative}`).toString('base64url'),
    path: relative,
    parent: parent === '.' ? '' : parent,
    starred: false,
    ...(entry.thumbUrl ? {
      thumbUrl: `/api/shares/account/${access.grant.id}/thumb?path=${encodeURIComponent(relative)}`,
    } : { thumbUrl: undefined }),
  };
}

export async function listSharedFolder(access: AccountShareAccess, relativeValue: unknown,
  sort?: string, dir?: 'asc' | 'desc'): Promise<FileListing> {
  const { ownerPath, relativePath } = ownerPathForGrant(access.grant, relativeValue);
  const listing = await storage.listAsync(access.owner.username, access.owner.id, ownerPath, { sort, dir });
  // storage.listAsync already lstat'ed and classified every child. Rewriting its
  // virtual paths avoids a second filesystem walk for large shared folders.
  const entries = listing.entries.map(entry => sharedEntry(access, entry));
  const parts = relativePath.split('/').filter(Boolean);
  const breadcrumbs: FileListing['breadcrumbs'] = [{ name: path.posix.basename(access.grant.rootPath), path: '' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    breadcrumbs.push({ name: part, path: accumulated });
  }
  return {
    path: relativePath,
    parent: relativePath ? (path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath)) : null,
    breadcrumbs,
    entries,
  };
}
