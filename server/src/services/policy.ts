// Central, server-enforced product policy. UI controls are advisory unless all
// routes and workers resolve their decisions here.
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../lib/model.js';
import type { AuthedRequest } from '../lib/auth.js';
import { db, getSetting } from '../lib/db.js';
import { normalizeAllowedFileTypes, validateMaxUploadMb } from '../lib/validation.js';

export interface AdminPolicy {
  publicSharingEnabled: boolean;
  externalAiEnabled: boolean;
  maxUploadMb: number;
  maxUploadBytes: number;
  allowedFileTypes: string;
  allowedExtensions: ReadonlySet<string> | null;
  locationIndexing: boolean;
}

function enabled(key: string, fallback: boolean): boolean {
  return getSetting(key, String(fallback)) === 'true';
}

export function adminPolicy(): AdminPolicy {
  let maxUploadMb = 20_480;
  try { maxUploadMb = validateMaxUploadMb(getSetting('max_upload_mb', '20480')); } catch { /* retain safe default */ }
  let allowedFileTypes = '*';
  try { allowedFileTypes = normalizeAllowedFileTypes(getSetting('allowed_file_types', '*')); } catch { /* retain allow-all */ }
  return {
    publicSharingEnabled: enabled('public_sharing', true),
    externalAiEnabled: enabled('external_ai', false),
    maxUploadMb,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    allowedFileTypes,
    allowedExtensions: allowedFileTypes === '*' ? null : new Set(allowedFileTypes.split(',')),
    locationIndexing: enabled('location_indexing', false),
  };
}

export function assertFileAllowed(filename: unknown, size?: number): void {
  const policy = adminPolicy();
  const name = String(filename ?? '');
  if (!name || name.includes('\0')) throw Object.assign(new Error('invalid_filename'), { status: 400 });
  if (size !== undefined && (!Number.isFinite(size) || size < 0 || size > policy.maxUploadBytes)) {
    throw Object.assign(new Error('file_too_large'), { status: 413, maxBytes: policy.maxUploadBytes });
  }
  if (policy.allowedExtensions) {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!ext || !policy.allowedExtensions.has(ext)) {
      throw Object.assign(new Error('file_type_not_allowed'), { status: 415, extension: ext || null });
    }
  }
}

export type AiProvider = 'local' | 'external';
export interface AiDecision { provider: AiProvider; external: boolean; mode: User['aiMode']; }

function explicitExternalConsent(req?: Pick<Request, 'get' | 'body'>): boolean {
  if (!req) return false;
  const header = req.get('x-aerie-external-ai-consent');
  return header === '1' || header === 'true' || req.body?.externalAiConsent === true;
}

export function aiDecision(user: User, req?: Pick<Request, 'get' | 'body'>): AiDecision {
  const mode = user.aiMode || 'local_only';
  if (mode === 'disabled') throw Object.assign(new Error('ai_disabled'), { status: 403 });
  const policy = adminPolicy();
  const consent = explicitExternalConsent(req);
  const mayUseExternal = policy.externalAiEnabled
    && (mode === 'external_allowed' || (mode === 'ask_before_send' && consent));
  return { provider: mayUseExternal ? 'external' : 'local', external: mayUseExternal, mode };
}

export function assertPublicSharingEnabled(): void {
  if (!adminPolicy().publicSharingEnabled) {
    throw Object.assign(new Error('public_sharing_disabled'), { status: 403 });
  }
}

export function shouldIndexLocation(): boolean {
  return adminPolicy().locationIndexing;
}

export function reconcilePolicyState(): void {
  if (!shouldIndexLocation()) db.prepare('UPDATE photo_index SET lat=NULL,lon=NULL WHERE lat IS NOT NULL OR lon IS NOT NULL').run();
}

export function requireAiPolicy(req: AuthedRequest, res: Response, next: NextFunction): void {
  try { aiDecision(req.user!, req); next(); }
  catch (error: any) { res.status(error?.status || 403).json({ error: error?.message || 'ai_disabled' }); }
}
