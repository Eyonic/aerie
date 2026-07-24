// Shared validation for security-sensitive account and policy inputs.
// Keep these functions dependency-free so routes, migrations and tests all use
// exactly the same rules.

import path from 'node:path';

export const AI_MODES = ['local_only', 'ask_before_send', 'external_allowed', 'disabled'] as const;
export type ValidAiMode = typeof AI_MODES[number];

export function validateUsername(value: unknown): string {
  const username = String(value ?? '').trim();
  if (username.length < 3 || username.length > 64) throw new Error('username_length');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) throw new Error('username_invalid');
  if (username === '.' || username === '..' || username.startsWith('.')) throw new Error('username_invalid');
  return username;
}

export function validatePassword(value: unknown): string {
  const password = String(value ?? '');
  if (password.length < 12) throw new Error('password_too_short');
  if (password.length > 1024) throw new Error('password_too_long');
  if (/^\s+$/.test(password)) throw new Error('password_invalid');
  return password;
}

export function validateAiMode(value: unknown, fallback: ValidAiMode = 'local_only'): ValidAiMode {
  if (value === undefined || value === null || value === '') return fallback;
  const mode = String(value) as ValidAiMode;
  if (!AI_MODES.includes(mode)) throw new Error('ai_mode_invalid');
  return mode;
}

export function validateRole(value: unknown, fallback: 'admin' | 'user' = 'user'): 'admin' | 'user' {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'admin' && value !== 'user') throw new Error('role_invalid');
  return value;
}

export function validateQuota(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const quota = Number(value);
  if (!Number.isSafeInteger(quota) || quota < 0) throw new Error('storage_quota_invalid');
  return quota || null;
}

export function validateMaxUploadMb(value: unknown): number {
  const mb = Number(value);
  // 1 MiB through 1 TiB. The storage layer still enforces free space/quota.
  if (!Number.isSafeInteger(mb) || mb < 1 || mb > 1024 * 1024) throw new Error('max_upload_invalid');
  return mb;
}

export function normalizeAllowedFileTypes(value: unknown): string {
  const raw = String(value ?? '*').trim().toLowerCase();
  if (!raw || raw === '*') return '*';
  const entries = raw.split(/[\s,;]+/).filter(Boolean).map(entry => entry.replace(/^\./, ''));
  if (!entries.length || entries.length > 256) throw new Error('allowed_file_types_invalid');
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9+_-]{0,31}$/.test(entry)) throw new Error('allowed_file_types_invalid');
  }
  return [...new Set(entries)].sort().join(',');
}

export function validateEmail(value: unknown): string | null {
  const email = String(value ?? '').trim();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email_invalid');
  return email;
}

export function validateVirtualPath(value: unknown, options: { allowRoot?: boolean } = {}): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\')) {
    throw Object.assign(new Error('invalid_path'), { status: 400 });
  }
  const rooted = value.startsWith('/') ? value : '/' + value;
  if (rooted.split('/').some(part => part === '.' || part === '..')) {
    throw Object.assign(new Error('invalid_path'), { status: 400 });
  }
  const normalized = path.posix.normalize(rooted);
  if (!options.allowRoot && normalized === '/') throw Object.assign(new Error('root_not_allowed'), { status: 400 });
  return normalized;
}

export function validateFileName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > 255 || /[/\\\0]/.test(name)) {
    throw Object.assign(new Error('invalid_name'), { status: 400 });
  }
  return name;
}
