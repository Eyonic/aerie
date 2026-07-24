export type MediaRequestType = 'movie' | 'tv';

export type ValidMediaRequest = {
  mediaType: MediaRequestType;
  mediaId: number;
  seasons?: 'all' | number[];
};

export type MediaRequestValidation =
  | { ok: true; value: ValidMediaRequest }
  | { ok: false; error: 'invalid_media_type' | 'invalid_media_id' | 'invalid_seasons' };

export type RequestAuditRow = {
  id?: number;
  ts?: string | null;
  user_id?: number | null;
  action?: 'media_requested' | 'auto_requested' | string | null;
  target?: string | null;
  meta?: string | null;
};

const LEGACY_MATCH_WINDOW_MS = 2 * 60_000;
const EXACT_TARGET = /^jellyseerr-request:([1-9]\d*)$/;
const LEGACY_TARGET = /^(movie|tv):([1-9]\d*)$/;
export const MAX_REQUEST_OWNERSHIP_ITEMS = 40;
export const MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS = MAX_REQUEST_OWNERSHIP_ITEMS * 2;
export const MAX_REQUEST_OWNERSHIP_AUDIT_ROWS = 1_000;

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function validateMediaRequestInput(body: unknown): MediaRequestValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_media_type' };
  const input = body as Record<string, unknown>;
  if (input.mediaType !== 'movie' && input.mediaType !== 'tv') return { ok: false, error: 'invalid_media_type' };
  const mediaId = positiveSafeInteger(input.mediaId);
  if (!mediaId) return { ok: false, error: 'invalid_media_id' };

  if (input.mediaType === 'movie') {
    if (input.seasons !== undefined && input.seasons !== null) return { ok: false, error: 'invalid_seasons' };
    return { ok: true, value: { mediaType: 'movie', mediaId } };
  }

  const raw = input.seasons;
  if (raw === undefined || raw === null) return { ok: true, value: { mediaType: 'tv', mediaId } };
  if (raw === 'all') return { ok: true, value: { mediaType: 'tv', mediaId, seasons: 'all' } };

  let entries: unknown[];
  if (Array.isArray(raw)) entries = raw;
  else if (typeof raw === 'string' && raw.length <= 600 && /^\d+(?:,\d+)*$/.test(raw)) {
    entries = raw.split(',').map(Number);
  }
  else return { ok: false, error: 'invalid_seasons' };
  if (!entries.length || entries.length > 100) return { ok: false, error: 'invalid_seasons' };
  const seasons = entries.map(positiveSafeInteger);
  if (seasons.some(value => value === null) || seasons.some(value => value! > 10_000)) {
    return { ok: false, error: 'invalid_seasons' };
  }
  const unique = Array.from(new Set(seasons as number[]));
  return { ok: true, value: { mediaType: 'tv', mediaId, seasons: unique } };
}

export function extractJellyseerrRequestId(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Record<string, any>;
  for (const candidate of [value.id, value.request?.id, value.data?.id]) {
    const id = positiveSafeInteger(candidate);
    if (id) return id;
  }
  return null;
}

export function mediaRequestAuditRecord(input: ValidMediaRequest, result: unknown): {
  target: string;
  meta: Record<string, unknown>;
} {
  const requestId = extractJellyseerrRequestId(result);
  return {
    target: requestId ? `jellyseerr-request:${requestId}` : `${input.mediaType}:${input.mediaId}`,
    meta: {
      ...(requestId ? { jellyseerrRequestId: requestId } : {}),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
    },
  };
}

function parseTime(value: unknown, sqliteUtc = false): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized = value.trim();
  if (sqliteUtc && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(normalized)) {
    normalized = `${normalized.replace(' ', 'T')}Z`;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

type OwnershipAudit = {
  rowId: number;
  userId: number;
  ts: number | null;
  exactId: number | null;
  legacyKey: string | null;
  mediaType: MediaRequestType | null;
  mediaId: number | null;
};

function parseAudit(row: RequestAuditRow, index: number): OwnershipAudit | null {
  const userId = positiveSafeInteger(row.user_id);
  if (!userId) return null;
  const target = typeof row.target === 'string' ? row.target : '';
  const meta = parseMeta(row.meta);
  const targetExact = target.match(EXACT_TARGET);
  const targetExactId = targetExact ? positiveSafeInteger(Number(targetExact[1])) : null;
  const metaExact = positiveSafeInteger(meta.jellyseerrRequestId);
  // A partially written or corrupted record must not claim either request.
  if (targetExactId && metaExact && targetExactId !== metaExact) return null;
  const exactId = metaExact || targetExactId;
  const targetLegacy = target.match(LEGACY_TARGET);
  const metaType = meta.mediaType === 'movie' || meta.mediaType === 'tv' ? meta.mediaType : null;
  const metaMediaId = positiveSafeInteger(meta.mediaId);
  const mediaType = metaType || (targetLegacy ? targetLegacy[1] as MediaRequestType : null);
  const mediaId = metaMediaId || (targetLegacy ? positiveSafeInteger(Number(targetLegacy[2])) : null);
  let legacyKey: string | null = null;
  if (targetLegacy) {
    const legacyMediaId = positiveSafeInteger(Number(targetLegacy[2]));
    const trustedLegacyTarget = row.action !== 'auto_requested'
      || (typeof meta.title === 'string'
        && !!meta.title.trim()
        && metaType === targetLegacy[1]
        && metaMediaId === legacyMediaId);
    if (trustedLegacyTarget) legacyKey = `${targetLegacy[1]}:${Number(targetLegacy[2])}`;
  }
  return {
    rowId: positiveSafeInteger(row.id) || index + 1,
    userId,
    ts: parseTime(row.ts, true),
    exactId,
    // Historical manual requests used movie:<tmdbId>/tv:<tmdbId>. Historical
    // auto-request targets were human titles; a new auto-request fallback is
    // trusted only when its typed metadata proves the target is an identity.
    legacyKey,
    mediaType,
    mediaId,
  };
}

// Jellyseerr currently returns at most 40 rows. Derive only the two indexed
// audit identities that can own each row and keep the SQL placeholder count
// fixed even if a broken or hostile upstream ignores its requested page size.
export function requestOwnershipAuditTargets(requests: unknown): string[] {
  if (!Array.isArray(requests)) return [];
  const targets = new Set<string>();
  for (const raw of requests.slice(0, MAX_REQUEST_OWNERSHIP_ITEMS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const identity = requestIdentity(raw as Record<string, unknown>);
    if (identity.id) targets.add(`jellyseerr-request:${identity.id}`);
    if (identity.legacyKey) targets.add(identity.legacyKey);
    if (targets.size >= MAX_REQUEST_OWNERSHIP_AUDIT_TARGETS) break;
  }
  return Array.from(targets);
}

function requestIdentity(request: Record<string, unknown>): {
  id: number | null;
  legacyKey: string | null;
  mediaType: MediaRequestType | null;
  mediaId: number | null;
  createdAt: number | null;
} {
  const mediaType = request.mediaType === 'movie' || request.mediaType === 'tv' ? request.mediaType : null;
  const mediaId = positiveSafeInteger(request.tmdbId);
  return {
    id: positiveSafeInteger(request.id),
    legacyKey: mediaType && mediaId ? `${mediaType}:${mediaId}` : null,
    mediaType,
    mediaId,
    createdAt: parseTime(request.createdAt),
  };
}

function soleOwner(candidates: OwnershipAudit[]): number | null {
  if (!candidates.length) return null;
  const owners = new Set(candidates.map(candidate => candidate.userId));
  return owners.size === 1 ? candidates[0].userId : null;
}

function ownerFor(request: Record<string, unknown>, audits: OwnershipAudit[]): number | null {
  const identity = requestIdentity(request);
  if (!identity.id) return null;
  const exact = audits.filter(audit => audit.exactId === identity.id
    && (!audit.mediaType || audit.mediaType === identity.mediaType)
    && (!audit.mediaId || audit.mediaId === identity.mediaId));
  if (exact.length) return soleOwner(exact);

  if (!identity.legacyKey || identity.createdAt === null) return null;
  const legacy = audits
    .filter(audit => audit.exactId === null && audit.legacyKey === identity.legacyKey && audit.ts !== null)
    .map(audit => ({ audit, distance: Math.abs(audit.ts! - identity.createdAt!) }))
    .filter(candidate => candidate.distance <= LEGACY_MATCH_WINDOW_MS)
    .sort((a, b) => a.distance - b.distance || b.audit.rowId - a.audit.rowId);
  if (!legacy.length) return null;
  const closestDistance = legacy[0].distance;
  const closest = legacy.filter(candidate => candidate.distance === closestDistance).map(candidate => candidate.audit);
  return soleOwner(closest);
}

export function requestsOwnedByUser(
  requests: unknown,
  auditRows: RequestAuditRow[],
  userId: number,
): Record<string, unknown>[] {
  if (!Array.isArray(requests)
    || !Array.isArray(auditRows)
    || auditRows.length > MAX_REQUEST_OWNERSHIP_AUDIT_ROWS
    || !positiveSafeInteger(userId)) return [];
  const audits = auditRows.map(parseAudit).filter((row): row is OwnershipAudit => !!row);
  const owned: Record<string, unknown>[] = [];
  for (const raw of requests.slice(0, MAX_REQUEST_OWNERSHIP_ITEMS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const request = raw as Record<string, unknown>;
    if (ownerFor(request, audits) !== userId) continue;
    const { requestedBy: _requestedBy, ...safe } = request;
    owned.push(safe);
  }
  return owned;
}
