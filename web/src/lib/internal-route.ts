const RAW_UNSAFE = /[\\\p{Cc}]/u;
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i;
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

function hasUnsafeEncoding(value: string) {
  let decoded = value;

  // Check more than one encoding layer. This rejects values such as %252f,
  // which otherwise become an encoded path separator after one decode.
  for (let depth = 0; depth < 8; depth += 1) {
    if (ENCODED_SEPARATOR_OR_CONTROL.test(decoded)) return true;

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // Invalid encoding in the original value is ambiguous. A later decode
      // can fail legitimately when a valid %25 represented a literal percent.
      return depth === 0;
    }

    if (RAW_UNSAFE.test(next)) return true;
    if (next === decoded) return false;
    decoded = next;
  }

  // Excessive nested encoding is not useful in an application route and is
  // safer to reject than to leave for another URL decoder to reinterpret.
  return true;
}

/**
 * Turn an untrusted navigation target into a same-origin React Router path.
 *
 * Root-relative and fully qualified same-origin URLs are accepted. Ambiguous
 * network-path references, relative paths, backslashes, encoded separators,
 * control characters and malformed/excessive percent encoding are rejected
 * before URL parsing can normalize them into a different destination.
 */
export function normalizeInternalRoute(value: unknown, expectedOrigin?: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value.trim() !== value) return null;
  if (RAW_UNSAFE.test(value) || hasUnsafeEncoding(value)) return null;

  const rootRelative = value.startsWith('/') && !value.startsWith('//');
  if (!rootRelative && !ABSOLUTE_HTTP_URL.test(value)) return null;

  const origin = expectedOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  try {
    const base = new URL(origin);
    const target = new URL(value, `${base.origin}/`);
    if (target.origin !== base.origin || !['http:', 'https:'].includes(target.protocol)) return null;
    if (target.username || target.password) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
