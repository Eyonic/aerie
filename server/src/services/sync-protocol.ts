import path from 'node:path';

function utf8Prefix(value: string, maxBytes: number): string {
  const chars = Array.from(value);
  while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
  return chars.join('');
}

export function deterministicConflictRel(rel: string, deviceId: string, contentHash: string): string {
  const dir = path.posix.dirname(rel);
  const rawExt = path.posix.extname(rel);
  const ext = utf8Prefix(rawExt, 24);
  const stem = utf8Prefix(path.posix.basename(rel, rawExt), 180);
  const device = String(deviceId || 'device').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'device';
  const leaf = `${stem} (Aerie conflict ${device}-${contentHash.slice(0, 8)})${ext}`;
  return dir === '.' ? leaf : path.posix.join(dir, leaf);
}

/** Parse a single RFC 7233-style byte range. Multiple/suffix ranges are rejected. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}
