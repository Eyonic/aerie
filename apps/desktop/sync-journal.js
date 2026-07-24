'use strict';

function encodedQuery(pathname, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, String(value));
  return `${pathname}?${query.toString()}`;
}

function changesPath(base, cursor, deviceId, limit = 250) {
  return encodedQuery('/api/sync/changes', { base, cursor, limit, deviceId });
}

function manifestPath(base, deviceId) {
  return encodedQuery('/api/sync/manifest', { base, deviceId });
}

function missingManifestStableIds(snapshot, entries) {
  const authoritative = new Set((entries || []).map(entry => String(entry.stableId)));
  return Object.keys(snapshot || {}).filter(stableId => !authoritative.has(stableId)).sort();
}

function validatedChangePage(data, currentCursor) {
  if (!data || !Array.isArray(data.items)) throw new Error('invalid_sync_change_page');
  let cursor = Number(currentCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid_sync_cursor');
  for (const item of data.items) {
    const itemCursor = Number(item?.cursor);
    if (!Number.isSafeInteger(itemCursor) || itemCursor <= cursor) throw new Error('invalid_sync_change_page');
    cursor = itemCursor;
  }
  const nextCursor = Number(data.nextCursor);
  if (!Number.isSafeInteger(nextCursor) || nextCursor !== cursor) throw new Error('invalid_sync_change_page');
  if (data.hasMore && data.items.length === 0) throw new Error('invalid_sync_change_page');
  return { items: data.items, nextCursor, hasMore: !!data.hasMore };
}

/** ACK is deliberately last: a persistence failure must leave the server's
 * cursor untouched so this page or manifest can be replayed safely. */
async function persistThenAck(cursor, setCursor, persist, ack) {
  setCursor(cursor);
  persist();
  return ack(cursor);
}

module.exports = { changesPath, manifestPath, missingManifestStableIds, persistThenAck, validatedChangePage };
