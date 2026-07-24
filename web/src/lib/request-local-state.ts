import { accountScopedStorageKey } from './account-storage';

export type RequestMeta = {
  title: string;
  posterUrl?: string;
  year?: string;
  mediaType: 'movie' | 'tv';
};

export type ScopedSnapshot<T> = {
  scopeKey: string | null;
  value: T;
};

const PROMPT_NAMESPACE = 'aerie.ai-prompt-history.v2';
const REQUEST_META_NAMESPACE = 'aerie.request-meta.v2';
const REQUEST_DISMISSED_NAMESPACE = 'aerie.request-dismissed.v2';

const LEGACY_PROMPT_KEY = 'cb_ai_prompt_history';
const LEGACY_REQUEST_META_KEY = 'cb_req_meta';
const LEGACY_REQUEST_DISMISSED_KEY = 'cb_req_dismissed';

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function discardLegacy(storage: Storage | null, keys: string[]) {
  if (!storage) return;
  // Deliberately remove without reading: origin-wide legacy data cannot be
  // attributed to an account safely, so it must never be displayed or copied.
  for (const key of keys) {
    try { storage.removeItem(key); } catch { /* unavailable/private storage */ }
  }
}

function readJson(storage: Storage | null, key: string, maxBytes: number): unknown {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    if (raw.length > maxBytes) {
      storage.removeItem(key);
      return undefined;
    }
    return JSON.parse(raw);
  } catch {
    try { storage.removeItem(key); } catch { /* unavailable/private storage */ }
    return undefined;
  }
}

function writeJson(storage: Storage | null, key: string, value: unknown) {
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* quota/private storage */ }
}

function validAccountId(accountId: number | null): accountId is number {
  return Number.isSafeInteger(accountId) && Number(accountId) > 0;
}

export function aiPromptHistoryKey(accountId: number, serverOrigin?: string): string {
  return accountScopedStorageKey(PROMPT_NAMESPACE, accountId, serverOrigin);
}

export function requestMetaStorageKey(accountId: number, serverOrigin?: string): string {
  return accountScopedStorageKey(REQUEST_META_NAMESPACE, accountId, serverOrigin);
}

export function requestDismissedStorageKey(accountId: number, serverOrigin?: string): string {
  return accountScopedStorageKey(REQUEST_DISMISSED_NAMESPACE, accountId, serverOrigin);
}

export function loadAiPromptHistory(
  accountId: number | null,
  storage?: Storage,
  serverOrigin?: string,
): string[] {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_PROMPT_KEY]);
  if (!validAccountId(accountId)) return [];
  const parsed = readJson(target, aiPromptHistoryKey(accountId, serverOrigin), 64 * 1024);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const prompt = entry.trim();
    if (!prompt || prompt.length > 4000 || seen.has(prompt)) continue;
    seen.add(prompt);
    result.push(prompt);
    if (result.length >= 12) break;
  }
  return result;
}

export function saveAiPromptHistory(
  accountId: number | null,
  history: string[],
  storage?: Storage,
  serverOrigin?: string,
) {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_PROMPT_KEY]);
  if (!validAccountId(accountId)) return;
  const clean = history
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter((entry, index, all) => !!entry && entry.length <= 4000 && all.indexOf(entry) === index)
    .slice(0, 12);
  writeJson(target, aiPromptHistoryKey(accountId, serverOrigin), clean);
}

function cleanRequestMeta(value: unknown): Record<string, RequestMeta> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: Record<string, RequestMeta> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(clean).length >= 1000) break;
    if (!/^(movie|tv):[1-9]\d*$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const mediaType = item.mediaType;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !title || title.length > 500) continue;
    const posterUrl = typeof item.posterUrl === 'string' && item.posterUrl.length <= 4096 ? item.posterUrl : undefined;
    const year = typeof item.year === 'string' && item.year.length <= 20 ? item.year : undefined;
    clean[key] = { title, mediaType, ...(posterUrl ? { posterUrl } : {}), ...(year ? { year } : {}) };
  }
  return clean;
}

export function loadRequestMeta(
  accountId: number | null,
  storage?: Storage,
  serverOrigin?: string,
): Record<string, RequestMeta> {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_REQUEST_META_KEY]);
  if (!validAccountId(accountId)) return {};
  return cleanRequestMeta(readJson(target, requestMetaStorageKey(accountId, serverOrigin), 1024 * 1024));
}

export function saveRequestMeta(
  accountId: number | null,
  meta: Record<string, RequestMeta>,
  storage?: Storage,
  serverOrigin?: string,
) {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_REQUEST_META_KEY]);
  if (!validAccountId(accountId)) return;
  writeJson(target, requestMetaStorageKey(accountId, serverOrigin), cleanRequestMeta(meta));
}

function cleanDismissed(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const clean: number[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < 1 || seen.has(entry)) continue;
    seen.add(entry);
    clean.push(entry);
    if (clean.length >= 1000) break;
  }
  return clean;
}

export function loadRequestDismissed(
  accountId: number | null,
  storage?: Storage,
  serverOrigin?: string,
): number[] {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_REQUEST_DISMISSED_KEY]);
  if (!validAccountId(accountId)) return [];
  return cleanDismissed(readJson(target, requestDismissedStorageKey(accountId, serverOrigin), 64 * 1024));
}

export function saveRequestDismissed(
  accountId: number | null,
  dismissed: Iterable<number>,
  storage?: Storage,
  serverOrigin?: string,
) {
  const target = browserStorage(storage);
  discardLegacy(target, [LEGACY_REQUEST_DISMISSED_KEY]);
  if (!validAccountId(accountId)) return;
  writeJson(target, requestDismissedStorageKey(accountId, serverOrigin), cleanDismissed(Array.from(dismissed)));
}

// Components use this during render when the authenticated account changes.
// The returned value belongs to the new scope immediately; callers can enqueue
// it into React state without ever rendering the previous account's value.
export function switchScopedSnapshot<T>(
  previous: ScopedSnapshot<T>,
  scopeKey: string | null,
  load: () => T,
): ScopedSnapshot<T> {
  return previous.scopeKey === scopeKey ? previous : { scopeKey, value: load() };
}
