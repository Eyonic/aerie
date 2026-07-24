// Strict wire format for cross-device Continuity handoffs. A handoff is
// durable untrusted input from another client, so receivers must never be
// asked to navigate off-origin or feed arbitrary objects/URLs to the player.

const MAX_ROUTE = 2048;
const MAX_URL = 4096;
const MAX_TEXT = 512;
const MAX_QUEUE = 100;
const MAX_MEDIA_SECONDS = 365 * 24 * 60 * 60;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_TEXT_GLOBAL = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ENCODED_PATH_SEPARATOR = /%(?:00|0a|0d|2f|5c)/i;
const TRACK_KINDS = new Set(['music', 'audiobook', 'podcast']);
const CAST_SOURCES = new Set(['jellyfin', 'audiobookshelf']);
const SAFE_MEDIA_PATHS = [
  /^\/api\/media\/(?:stream|image)\//,
  /^\/api\/books\/(?:file|stream|cover)\//,
  /^\/api\/files\/(?:raw|thumb)$/,
  /^\/api\/music-gen\/audio\//,
  /^\/api\/photos\/(?:native\/)?(?:thumb|file)(?:\/|$)/,
];
const SENSITIVE_QUERY = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'cb_token',
  'authorization', 'api_key', 'apikey', 'password', 'secret',
  'signature', 'sig', 'ticket', 'pairing', 'code',
]);

export class ContinuityInputError extends Error {
  constructor(message = 'invalid_handoff') { super(message); this.name = 'ContinuityInputError'; }
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : null;
}

function text(value: unknown, max = MAX_TEXT, required = false, rejectControls = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (rejectControls && UNSAFE_TEXT.test(value)) return undefined;
  const cleaned = Array.from(value.replace(UNSAFE_TEXT_GLOBAL, '').trim()).slice(0, max).join('');
  return cleaned || (required ? undefined : undefined);
}

function numberInRange(value: unknown, max = MAX_MEDIA_SECONDS): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

function scrubQuery(url: URL) {
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase().replace(/-/g, '_');
    if (SENSITIVE_QUERY.has(normalized) || normalized.endsWith('_token')) url.searchParams.delete(key);
  }
}

/** Normalize a same-app route. Protocol-relative, backslash and ambiguous
 * encoded-separator forms are rejected before URL parsing can reinterpret
 * them. Secret query parameters are removed rather than persisted in SQLite. */
export function normalizeContinuityRoute(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ROUTE
      || !/^\/(?!\/)/.test(value) || UNSAFE_TEXT.test(value) || value.split(/[?#]/, 1)[0].includes('\\')) return null;
  try {
    const url = new URL(value, 'https://aerie.invalid');
    if (url.origin !== 'https://aerie.invalid' || ENCODED_PATH_SEPARATOR.test(url.pathname)
        || /%(?![\da-f]{2})/i.test(url.pathname)) return null;
    scrubQuery(url);
    if (/(?:^|[&#])(cbho|token|access_token|authorization|ticket)=/i.test(url.hash)) url.hash = '';
    const out = url.pathname + url.search + url.hash;
    return out.length <= MAX_ROUTE ? out : null;
  } catch { return null; }
}

/** Convert relative or legacy absolute Aerie media URLs into token-free,
 * same-origin API paths. Absolute URLs are deliberately reduced to their
 * path: this keeps public/LAN-origin handoff compatibility without allowing a
 * peer to make the receiving browser contact an outside host. */
export function normalizeContinuityMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL || UNSAFE_TEXT.test(value)
      || value.split(/[?#]/, 1)[0].includes('\\') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://aerie.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || !url.pathname.startsWith('/api/') || ENCODED_PATH_SEPARATOR.test(url.pathname)
        || /%(?![\da-f]{2})/i.test(url.pathname)
        || !SAFE_MEDIA_PATHS.some(pattern => pattern.test(url.pathname))) return null;
    scrubQuery(url);
    url.hash = '';
    const out = url.pathname + url.search;
    return out.length <= MAX_URL ? out : null;
  } catch { return null; }
}

function normalizeCast(value: unknown) {
  const raw = record(value);
  if (!raw || !CAST_SOURCES.has(String(raw.source))) return undefined;
  const itemId = text(raw.itemId, MAX_TEXT, true, true);
  if (!itemId) return undefined;
  const fileId = text(raw.fileId, MAX_TEXT, false, true);
  return { source: String(raw.source), itemId, ...(fileId ? { fileId } : {}) };
}

function normalizeTrack(value: unknown) {
  const raw = record(value);
  if (!raw) return null;
  const id = text(raw.id, MAX_TEXT, true, true);
  const title = text(raw.title, MAX_TEXT, true);
  const streamUrl = normalizeContinuityMediaUrl(raw.streamUrl);
  const kind = typeof raw.kind === 'string' && TRACK_KINDS.has(raw.kind) ? raw.kind : null;
  if (!id || !title || !streamUrl || !kind) return null;
  const subtitle = text(raw.subtitle);
  const artUrl = normalizeContinuityMediaUrl(raw.artUrl);
  const durationSec = numberInRange(raw.durationSec);
  const startAt = numberInRange(raw.startAt);
  const cast = normalizeCast(raw.cast);
  return {
    id, title, streamUrl, kind,
    ...(subtitle ? { subtitle } : {}),
    ...(artUrl ? { artUrl } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(cast ? { cast } : {}),
  };
}

function normalizeAudio(value: unknown) {
  if (value == null) return undefined;
  const raw = record(value);
  if (!raw || !Array.isArray(raw.queue)) throw new ContinuityInputError();
  const sourceQueue = raw.queue.slice(0, MAX_QUEUE);
  const tracks = sourceQueue.map((track, sourceIndex) => ({ sourceIndex, track: normalizeTrack(track) }))
    .filter((entry): entry is { sourceIndex: number; track: NonNullable<ReturnType<typeof normalizeTrack>> } => !!entry.track);
  if (!tracks.length) return undefined;
  const requested = Number.isFinite(Number(raw.index)) ? Math.min(sourceQueue.length - 1, Math.max(0, Math.trunc(Number(raw.index)))) : 0;
  let index = tracks.findIndex(entry => entry.sourceIndex === requested);
  if (index < 0) index = tracks.findIndex(entry => entry.sourceIndex > requested);
  if (index < 0) index = tracks.length - 1;
  const position = numberInRange(raw.position);
  return {
    queue: tracks.map(entry => entry.track),
    index,
    ...(position !== undefined ? { position } : {}),
    playing: raw.playing === true,
  };
}

function normalizeVideo(value: unknown) {
  if (value == null) return undefined;
  const raw = record(value);
  if (!raw) throw new ContinuityInputError();
  const itemId = text(raw.itemId, MAX_TEXT, true, true);
  if (!itemId) return undefined;
  const position = numberInRange(raw.position);
  return { itemId, ...(position !== undefined ? { position } : {}), paused: raw.paused === true };
}

export function normalizeHandoffPayload(value: unknown) {
  const raw = record(value);
  if (!raw) throw new ContinuityInputError();
  const path = normalizeContinuityRoute(raw.path);
  if (!path) throw new ContinuityInputError();
  const audio = normalizeAudio(raw.audio);
  const video = normalizeVideo(raw.video);
  const title = text(raw.title);
  const kind = raw.kind === 'media' || raw.kind === 'page' ? raw.kind : (audio || video ? 'media' : 'page');
  let sentAt: string | undefined;
  if (typeof raw.sentAt === 'string' && raw.sentAt.length <= 100) {
    const timestamp = new Date(raw.sentAt);
    if (Number.isFinite(timestamp.getTime())) sentAt = timestamp.toISOString();
  }
  return {
    path,
    ...(title ? { title } : {}),
    kind,
    ...(audio ? { audio } : {}),
    ...(video ? { video } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
}
