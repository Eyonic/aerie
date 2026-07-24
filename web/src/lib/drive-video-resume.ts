import { accountScopedStorageKey } from './account-storage';

export type DriveVideoResumeInfo = { pos: number; dur: number; at: number };
export type DriveVideoResumeMap = Record<string, DriveVideoResumeInfo>;

const NAMESPACE = 'aerie-drive-resume-v2';
const LEGACY_UNSCOPED_KEY = 'cbx.videos.resume.v1';
const MAX_SAVED_ITEMS = 500;
const MAX_MEDIA_SECONDS = 366 * 24 * 60 * 60;

function browserStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

export function driveVideoResumeKey(accountId: number, serverOrigin?: string): string {
  return accountScopedStorageKey(NAMESPACE, accountId, serverOrigin);
}

export function loadDriveVideoResume(accountId: number, storage: Storage | null = browserStorage(), serverOrigin?: string): DriveVideoResumeMap {
  if (!storage) return {};
  // The legacy key mixed every account together. It must never be parsed or
  // migrated because doing so would reveal its former owner's private paths.
  try { storage.removeItem(LEGACY_UNSCOPED_KEY); } catch { /* unavailable storage */ }
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(driveVideoResumeKey(accountId, serverOrigin)) || '{}'); }
  catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const valid: [string, DriveVideoResumeInfo][] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 4096 || !value || typeof value !== 'object') continue;
    const item = value as Partial<DriveVideoResumeInfo>;
    if (![item.pos, item.dur, item.at].every(Number.isFinite)) continue;
    if (item.pos! < 0 || item.dur! <= 0 || item.pos! > MAX_MEDIA_SECONDS || item.dur! > MAX_MEDIA_SECONDS || item.at! < 0) continue;
    valid.push([key, { pos: item.pos!, dur: item.dur!, at: item.at! }]);
  }
  valid.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(valid.slice(0, MAX_SAVED_ITEMS));
}

export function saveDriveVideoResume(accountId: number, values: DriveVideoResumeMap, storage: Storage | null = browserStorage(), serverOrigin?: string): DriveVideoResumeMap {
  const entries = Object.entries(values)
    .filter(([key, item]) => key.length > 0 && key.length <= 4096 && item && Number.isFinite(item.pos)
      && Number.isFinite(item.dur) && Number.isFinite(item.at) && item.pos >= 0 && item.dur > 0
      && item.pos <= MAX_MEDIA_SECONDS && item.dur <= MAX_MEDIA_SECONDS && item.at >= 0)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_SAVED_ITEMS);
  const bounded = Object.fromEntries(entries);
  if (storage) {
    try { storage.setItem(driveVideoResumeKey(accountId, serverOrigin), JSON.stringify(bounded)); } catch { /* quota/private mode */ }
  }
  return bounded;
}
